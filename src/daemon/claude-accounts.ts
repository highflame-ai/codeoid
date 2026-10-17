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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
 * Explicit credential / backend-selection variables the Claude CLI reads. Kept
 * for the isolated login and as documentation; stripping an account's
 * environment does NOT rely on this list alone (see `stripClaudeCredentials`).
 */
export const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_API_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

/**
 * `ANTHROPIC_*` variables that are NOT about who you are or where requests go
 * — model selection and tuning — and so survive an account being applied.
 * Everything else in that namespace is removed.
 */
const ANTHROPIC_KEEP = new Set([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_LOG",
]);

/**
 * Is `name` a variable through which the Claude CLI can pick up a credential
 * or a different backend? An ALLOWLIST for the `ANTHROPIC_*` namespace plus
 * the CLI's own credential/provider families, rather than a denylist to chase
 * — the CLI keeps adding providers (Bedrock, Vertex, Foundry, Anthropic on
 * AWS / Google Cloud, Mantle, gateway, identity federation, token file
 * descriptors) and any one left behind lets the CLI's precedence pick a
 * credential nobody chose for this session.
 *
 * Not coverable from here: an `apiKeyHelper` (or `env`) in a Claude settings
 * file — that is configuration of the shared config dir / the workdir, not
 * process environment.
 */
export function isClaudeCredentialVar(name: string): boolean {
  if (name.startsWith("ANTHROPIC_")) return !ANTHROPIC_KEEP.has(name);
  if ((CLAUDE_CREDENTIAL_ENV as readonly string[]).includes(name)) return true;
  return (
    name.startsWith("CLAUDE_CODE_USE_") ||
    /^CLAUDE_CODE_SKIP_[A-Z_]+_AUTH$/.test(name) ||
    name.endsWith("_FILE_DESCRIPTOR") ||
    name.startsWith("CLAUDE_CODE_OAUTH_") ||
    name.startsWith("CLAUDE_CODE_GATEWAY_") ||
    // The daemon's mTLS identity must not be presented to an account's gateway.
    name.startsWith("CLAUDE_CODE_CLIENT_") ||
    name === "CLAUDE_CONFIG_DIR_CREDENTIALS"
  );
}

/** `env` without any Claude credential or backend-selection variable. Pure. */
export function stripClaudeCredentials(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!isClaudeCredentialVar(k)) out[k] = v;
  return out;
}

/**
 * Is the daemon itself running behind the Highflame gateway (a Forge
 * sandbox)? Its launch environment then routes every Claude call through the
 * gateway (`x-highflame-apikey`), and Shield guardrails + audit live there. A
 * named account replaces the credential AND the base URL, so it would route
 * around the gateway entirely: named accounts are refused there.
 */
/** A stored account's name — not "follow the default" (null/absent) and not the built-in `default`. */
export function isNamedClaudeAccount(choice: string | null | undefined): choice is string {
  return typeof choice === "string" && choice !== "" && choice !== CLAUDE_DEFAULT_ACCOUNT;
}

export function isGatewayLaunch(env: Record<string, string | undefined>): boolean {
  return /^\s*x-highflame-apikey\s*:/im.test(env.ANTHROPIC_CUSTOM_HEADERS ?? "");
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
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
  if (!["subscription", "gateway", "api-key"].includes(input.kind)) {
    throw new ClaudeAccountError(`unknown account kind ${JSON.stringify(input.kind)}`);
  }
  // Any control character (CR/LF, NUL, …): a NUL makes the spawn throw with
  // the whole token in the error text; a line break would inject headers.
  if (!input.token || CONTROL_CHARS.test(input.token)) {
    throw new ClaudeAccountError("the token must be a single non-empty line with no control characters");
  }
  if (input.kind === "gateway") {
    if (!input.baseUrl) throw new ClaudeAccountError("a gateway account needs its base URL");
    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      throw new ClaudeAccountError("the gateway base URL isn't a valid URL");
    }
    // The URL is shown to anyone who can list accounts: no credentials in it.
    if (url.username || url.password || url.search || url.hash) {
      throw new ClaudeAccountError("the gateway base URL must not carry credentials, a query string or a fragment — put a key in the token or a header");
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
    if (CONTROL_CHARS.test(v)) throw new ClaudeAccountError(`header ${k} has a line break or control character in its value`);
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
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is passed through, not forced: the CLI
  // then keeps its credential out of what its Bash tool, hooks and stdio MCP
  // servers inherit, but on Linux it also requires bubblewrap and sandboxes
  // every shell command — too large a change to impose per account. Opt in
  // daemon-wide in ~/.codeoid/.env (docs/CONFIGURATION.md).
  const out = stripClaudeCredentials(env);
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
    default:
      // Never "strip everything and set nothing": the CLI would fall back to
      // the stored login, a credential nobody chose for this session.
      throw new ClaudeAccountError(`account "${account.name}" has an unknown kind`);
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
    let parsed: Partial<StoreFile>;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<StoreFile>;
    } catch (err) {
      // Fail closed — the default may name an account we can no longer read —
      // but say exactly what to fix.
      // Not the parser's message: it can quote a slice of the file — a token.
      throw new ClaudeAccountError(`${this.#path} is not valid JSON — fix or remove it`);
    }
    // Validate each entry as if it were being added: a hand-edited entry with
    // an unknown kind or a bad token must not be applied.
    const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : []).filter((a): a is StoredClaudeAccount => {
      try {
        validateAccountInput(a as StoredClaudeAccount);
        return true;
      } catch (err) {
        console.error(`[codeoid] ignoring invalid Claude account in ${this.#path}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    });
    this.#data = {
      version: 1,
      accounts,
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
   * default. Returns `null` for the built-in account (the daemon's own
   * environment).
   * A choice naming an account that no longer exists THROWS — falling back to
   * another account would run the session on a credential nobody picked.
   */
  resolve(sessionChoice: string | null): ResolvedClaudeAccount | null {
    // `null` follows the daemon default; a literal "default" PINS the built-in
    // account (the daemon's own environment) whatever the default is.
    const name = sessionChoice ?? this.getDefault();
    if (name === CLAUDE_DEFAULT_ACCOUNT) return null;
    if (isGatewayLaunch(process.env)) {
      throw new ClaudeAccountError(
        `Claude accounts are disabled behind the Highflame gateway — "${name}" would route around it. This session runs on the gateway's credential.`,
      );
    }
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

/**
 * Does a project's Claude settings file redirect credentials? The CLI loads
 * project settings (`<workdir>/.claude/settings.json`, `settings.local.json`,
 * and those of each parent up to the home directory) and applies their `env`
 * over the environment it was started with, and runs their `apiKeyHelper`. A
 * cloned repo could therefore point `ANTHROPIC_BASE_URL` at its own host and
 * receive a named account's token with every request. A named account refuses
 * to run in such a workdir; the message names the file.
 *
 * Returns the offending file and key, or null.
 */
export function projectCredentialOverride(workdir: string): { file: string; key: string } | null {
  const home = resolve(homedir());
  for (let dir = resolve(workdir); ; dir = dirname(dir)) {
    if (dir === home) break; // ~/.claude/settings.json is the user's own settings, not a project's
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = join(dir, ".claude", name);
      if (!existsSync(file)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // Unreadable here means unreadable for the CLI too — nothing applied.
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const settings = parsed as { env?: unknown; apiKeyHelper?: unknown; awsAuthRefresh?: unknown; awsCredentialExport?: unknown };
      for (const key of ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"] as const) {
        if (settings[key] !== undefined) return { file, key };
      }
      if (settings.env && typeof settings.env === "object") {
        for (const key of Object.keys(settings.env)) if (isClaudeCredentialVar(key)) return { file, key: `env.${key}` };
      }
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

