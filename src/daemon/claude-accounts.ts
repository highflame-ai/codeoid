/**
 * Claude accounts — several Claude credentials on one daemon, a daemon
 * default, and a per-session choice (protocol: claude-accounts.ts).
 *
 * An account is ONLY the credential a session's Claude subprocess starts
 * with. It changes nothing else: one Claude config directory, so transcripts,
 * settings, MCP servers and skills are shared, and a session switched to
 * another account resumes the same Claude session.
 *
 * Stored in `<configDir>/claude-accounts.json`, 0600, written atomically.
 * Tokens never leave this module except into a subprocess environment.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, getConfigDir } from "../config.js";
import {
  CLAUDE_DEFAULT_ACCOUNT,
  type ClaudeAccountInfo,
  type ClaudeAccountKind,
} from "../protocol/types.js";

export interface StoredClaudeAccount {
  name: string;
  kind: ClaudeAccountKind;
  token: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  defaultAccount?: string;
  accounts: StoredClaudeAccount[];
}

/** A session's account, resolved for one query: what to apply, and whether it changed. */
export interface ResolvedClaudeAccount {
  name: string;
  /** Changes whenever the credential does (a re-login, a new token) — never logged. */
  fingerprint: string;
  apply(env: Record<string, string>): Record<string, string>;
}

/**
 * Every variable through which the Claude CLI can pick up a credential or an
 * alternative backend. Applying an account REMOVES all of them first and then
 * sets only its own: adding a token while, say, an `ANTHROPIC_API_KEY` from the
 * daemon's environment is still present would let the CLI's own precedence
 * pick the other credential, and the session would silently run (and bill) on
 * the wrong account.
 *
 * Not coverable from here: an `apiKeyHelper` in the user's Claude settings
 * file. That is configuration of the shared config dir, not environment.
 */
export const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
] as const;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** RFC 7230 token characters — a header name can't carry a separator or a newline. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

export class ClaudeAccountError extends Error {}

export function validateAccountName(name: string): void {
  if (name === CLAUDE_DEFAULT_ACCOUNT) {
    throw new ClaudeAccountError(`"${CLAUDE_DEFAULT_ACCOUNT}" is the built-in account (the daemon's own environment) and can't be redefined`);
  }
  if (!NAME_RE.test(name)) {
    throw new ClaudeAccountError("account names are 1-40 characters: lowercase letters, digits and '-', starting with a letter or digit");
  }
}

/** Validate the parts of an account a caller supplied. Throws ClaudeAccountError. */
export function validateAccountInput(input: {
  name: string;
  kind: ClaudeAccountKind;
  token: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}): void {
  validateAccountName(input.name);
  if (!input.token || /[\r\n]/.test(input.token)) {
    throw new ClaudeAccountError("the token must be a single non-empty line");
  }
  if (input.kind === "gateway") {
    if (!input.baseUrl) throw new ClaudeAccountError("a gateway account needs its base URL");
    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      throw new ClaudeAccountError("the gateway base URL isn't a valid URL");
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      // The token rides every request; plain http would send it in the clear.
      throw new ClaudeAccountError("the gateway base URL must be https (http only for localhost)");
    }
  } else {
    if (input.baseUrl) throw new ClaudeAccountError(`a ${input.kind} account has no base URL`);
    if (input.headers && Object.keys(input.headers).length > 0) {
      throw new ClaudeAccountError(`a ${input.kind} account has no extra headers`);
    }
  }
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!HEADER_NAME_RE.test(k)) throw new ClaudeAccountError(`invalid header name: ${JSON.stringify(k)}`);
    // A CR/LF in a value would inject further headers into every request.
    if (/[\r\n]/.test(v)) throw new ClaudeAccountError(`header ${k} has a line break in its value`);
  }
}

/** The client-safe view of an account: no token, no header values. */
export function toAccountInfo(a: StoredClaudeAccount): ClaudeAccountInfo {
  return {
    name: a.name,
    kind: a.kind,
    ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
    ...(a.headers && Object.keys(a.headers).length > 0 ? { headerNames: Object.keys(a.headers).sort() } : {}),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/**
 * The subprocess environment for `account`: every competing credential
 * variable removed, then this account's set. Pure.
 */
export function applyAccountEnv(env: Record<string, string>, account: StoredClaudeAccount): Record<string, string> {
  const out: Record<string, string> = { ...env };
  for (const k of CLAUDE_CREDENTIAL_ENV) delete out[k];
  switch (account.kind) {
    case "subscription":
      out.CLAUDE_CODE_OAUTH_TOKEN = account.token;
      break;
    case "api-key":
      out.ANTHROPIC_API_KEY = account.token;
      break;
    case "gateway": {
      out.ANTHROPIC_BASE_URL = account.baseUrl ?? "";
      out.ANTHROPIC_AUTH_TOKEN = account.token;
      const headers = Object.entries(account.headers ?? {});
      if (headers.length > 0) out.ANTHROPIC_CUSTOM_HEADERS = headers.map(([k, v]) => `${k}: ${v}`).join("\n");
      break;
    }
  }
  return out;
}

function fingerprintOf(a: StoredClaudeAccount): string {
  return createHash("sha256")
    .update(JSON.stringify([a.name, a.kind, a.token, a.baseUrl ?? "", Object.entries(a.headers ?? {}).sort()]))
    .digest("hex")
    .slice(0, 16);
}

export class ClaudeAccountStore {
  readonly #path: string;
  #data: StoreFile | null = null;

  constructor(path: string = join(getConfigDir(), "claude-accounts.json")) {
    this.#path = path;
  }

  #load(): StoreFile {
    if (this.#data) return this.#data;
    if (!existsSync(this.#path)) {
      this.#data = { version: 1, accounts: [] };
      return this.#data;
    }
    const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<StoreFile>;
    this.#data = {
      version: 1,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      ...(typeof parsed.defaultAccount === "string" ? { defaultAccount: parsed.defaultAccount } : {}),
    };
    return this.#data;
  }

  #save(data: StoreFile): void {
    atomicWrite(this.#path, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    this.#data = data;
  }

  list(): ClaudeAccountInfo[] {
    return this.#load().accounts.map(toAccountInfo).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): StoredClaudeAccount | undefined {
    return this.#load().accounts.find((a) => a.name === name);
  }

  has(name: string): boolean {
    return name === CLAUDE_DEFAULT_ACCOUNT || this.get(name) !== undefined;
  }

  /** The daemon default's name — `default` when none is set. */
  getDefault(): string {
    return this.#load().defaultAccount ?? CLAUDE_DEFAULT_ACCOUNT;
  }

  upsert(input: { name: string; kind: ClaudeAccountKind; token: string; baseUrl?: string; headers?: Record<string, string> }): StoredClaudeAccount {
    validateAccountInput(input);
    const data = this.#load();
    const now = new Date().toISOString();
    const prev = data.accounts.find((a) => a.name === input.name);
    const next: StoredClaudeAccount = {
      name: input.name,
      kind: input.kind,
      token: input.token,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: { ...input.headers } } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.#save({ ...data, accounts: [...data.accounts.filter((a) => a.name !== input.name), next] });
    return next;
  }

  /** Remove an account. Clears the default if it was the default. Returns whether it existed. */
  remove(name: string): boolean {
    const data = this.#load();
    if (!data.accounts.some((a) => a.name === name)) return false;
    const { defaultAccount, ...rest } = data;
    this.#save({
      ...rest,
      accounts: data.accounts.filter((a) => a.name !== name),
      ...(defaultAccount && defaultAccount !== name ? { defaultAccount } : {}),
    });
    return true;
  }

  setDefault(name: string): void {
    if (!this.has(name)) throw new ClaudeAccountError(`no Claude account named ${JSON.stringify(name)}`);
    const { defaultAccount: _old, ...rest } = this.#load();
    this.#save(name === CLAUDE_DEFAULT_ACCOUNT ? rest : { ...rest, defaultAccount: name });
  }

  /**
   * Resolve the account a session runs on: its own choice, else the daemon
   * default. `null` = the built-in account (the daemon's own environment).
   * A choice naming an account that no longer exists THROWS — falling back to
   * another account would run the session on a credential nobody picked.
   */
  resolve(sessionChoice: string | null): ResolvedClaudeAccount | null {
    const name = sessionChoice ?? this.getDefault();
    if (name === CLAUDE_DEFAULT_ACCOUNT) return null;
    const account = this.get(name);
    if (!account) {
      throw new ClaudeAccountError(
        `Claude account "${name}" no longer exists — choose another for this session (codeoid account use <session> <account>)`,
      );
    }
    return {
      name: account.name,
      fingerprint: fingerprintOf(account),
      apply: (env) => applyAccountEnv(env, account),
    };
  }
}
