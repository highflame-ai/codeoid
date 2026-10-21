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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AccountError, AccountStore } from "./accounts.js";
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
  /** `bedrock` only: settings from BEDROCK_SETTINGS (region, model mappings, telemetry). */
  env?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  generation?: number;
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
    name === "AWS_BEARER_TOKEN_BEDROCK" ||
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
  env?: Record<string, string>;
}): void {
  validateAccountName(input.name);
  if (!["subscription", "gateway", "api-key", "bedrock"].includes(input.kind)) {
    throw new ClaudeAccountError(`unknown account kind ${JSON.stringify(input.kind)}`);
  }
  // Any control character (CR/LF, NUL, …): a NUL makes the spawn throw with
  // the whole token in the error text; a line break would inject headers.
  if (!input.token || CONTROL_CHARS.test(input.token)) {
    throw new ClaudeAccountError("the token must be a single non-empty line with no control characters");
  }
  if (input.kind === "gateway" && !input.baseUrl) throw new ClaudeAccountError("a gateway account needs its base URL");
  if (input.baseUrl !== undefined) {
    // A Bedrock endpoint is optional: without one the CLI goes to AWS.
    if (input.kind !== "gateway" && input.kind !== "bedrock") throw new ClaudeAccountError(`a ${input.kind} account has no base URL`);
    const what = input.kind === "gateway" ? "gateway base URL" : "Bedrock endpoint";
    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      throw new ClaudeAccountError(`the ${what} isn't a valid URL`);
    }
    // The URL is shown to anyone who can list accounts: no credentials in it.
    if (url.username || url.password || url.search || url.hash) {
      throw new ClaudeAccountError(`the ${what} must not carry credentials, a query string or a fragment — put a key in the token${input.kind === "gateway" ? " or a header" : ""}`);
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      // The token rides every request; plain http would send it in the clear.
      throw new ClaudeAccountError(`the ${what} must be https (http only for localhost)`);
    }
  }
  if (input.kind !== "gateway" && input.headers && Object.keys(input.headers).length > 0) {
    throw new ClaudeAccountError(`a ${input.kind} account has no extra headers`);
  }
  // Which settings a Bedrock account takes is checked by the store.
  if (input.kind !== "bedrock" && input.env !== undefined) {
    throw new ClaudeAccountError(`a ${input.kind} account takes no settings`);
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
    case "bedrock":
      // The bearer token wins over any AWS keys or profile in the daemon's
      // environment (checked against the CLI), so those stay for the agent's
      // own tools. The account's settings go on top of what the daemon has.
      for (const [k, v] of Object.entries(account.env ?? {})) out[k] = v;
      out.CLAUDE_CODE_USE_BEDROCK = "1";
      out.AWS_BEARER_TOKEN_BEDROCK = account.token;
      if (account.baseUrl) out.ANTHROPIC_BEDROCK_BASE_URL = account.baseUrl;
      break;
    default:
      // Never "strip everything and set nothing": the CLI would fall back to
      // the stored login, a credential nobody chose for this session.
      throw new ClaudeAccountError(`account "${account.name}" has an unknown kind`);
  }
  return out;
}


/**
 * The `claude` backend's accounts, in the shape #392's callers use. Backed by
 * the store for every backend (accounts.ts); `claude-accounts.json` is only
 * read once, to import it.
 */
export class ClaudeAccountStore {
  readonly store: AccountStore;

  /** `path`: a legacy `claude-accounts.json` to import from (tests); its sibling `accounts.json` is the store. */
  constructor(storeOrLegacyPath?: AccountStore | string) {
    this.store =
      storeOrLegacyPath instanceof AccountStore
        ? storeOrLegacyPath
        : storeOrLegacyPath
          ? new AccountStore({
              path: join(dirname(storeOrLegacyPath), "accounts.json"),
              homesRoot: join(dirname(storeOrLegacyPath), "accounts"),
              legacyClaudePath: storeOrLegacyPath,
            })
          : new AccountStore();
  }

  list(): ClaudeAccountInfo[] {
    return this.store.list("claude").map(({ backend: _b, envNames: _e, ...a }) => a as ClaudeAccountInfo);
  }

  get(name: string): StoredClaudeAccount | undefined {
    const a = this.store.get("claude", name);
    return a ? (a as StoredClaudeAccount) : undefined;
  }

  has(name: string): boolean {
    return this.store.has("claude", name);
  }

  /** The daemon default's name — `default` when none is set. */
  getDefault(): string {
    return this.store.getDefault("claude");
  }

  /** Add or replace (the #392 contract: `claude.accounts.set` always replaces). */
  upsert(input: {
    name: string;
    kind: ClaudeAccountKind;
    token: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }): StoredClaudeAccount {
    try {
      validateAccountInput(input);
      this.store.upsert({ backend: "claude", ...input, replace: true });
    } catch (err) {
      throw err instanceof AccountError ? new ClaudeAccountError(err.message) : err;
    }
    return this.get(input.name)!;
  }

  /** Remove an account. Refused for the default account (set another first). Returns whether it existed. */
  remove(name: string): boolean {
    return this.store.remove("claude", name);
  }

  setDefault(name: string): void {
    if (!this.has(name)) throw new ClaudeAccountError(`no Claude account named ${JSON.stringify(name)}`);
    this.store.setDefault("claude", name);
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
    let name: string;
    try {
      // Through the store first: it fails closed when Claude's accounts can't
      // be read (an unreadable legacy file), even for a session following a
      // default that would otherwise read as the built-in one.
      if (sessionChoice !== CLAUDE_DEFAULT_ACCOUNT) this.store.resolve("claude", sessionChoice);
      name = sessionChoice ?? this.getDefault();
    } catch (err) {
      // An unreadable accounts file: say that, not "no longer exists".
      throw new ClaudeAccountError(err instanceof Error ? err.message : String(err));
    }
    if (name === CLAUDE_DEFAULT_ACCOUNT) return null;
    if (isGatewayLaunch(process.env)) {
      throw new ClaudeAccountError(
        `Claude accounts are disabled behind the Highflame gateway — "${name}" would route around it. This session runs on the gateway's credential.`,
      );
    }
    let resolved: ReturnType<AccountStore["resolve"]>;
    try {
      resolved = this.store.resolve("claude", name);
    } catch (err) {
      if (this.store.get("claude", name) === undefined && !(err instanceof Error && /not valid JSON/.test(err.message))) {
        throw new ClaudeAccountError(
          `Claude account "${name}" no longer exists — choose another for this session (codeoid account use <session> <account>)`,
        );
      }
      throw new ClaudeAccountError(err instanceof Error ? err.message : String(err));
    }
    const account = resolved!.account as StoredClaudeAccount;
    return {
      name: account.name,
      fingerprint: resolved!.fingerprint,
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
 * Deliberately NOT refused: a project's `hooks`, `statusLine`, MCP servers and
 * `permissions.allow`. Those are code the repo runs as the daemon user, which
 * can read any stored credential — the default account's included — so no
 * per-account check contains them, and refusing them would lock named
 * accounts out of most real repositories. Only open workdirs you trust
 * (docs/CONFIGURATION.md).
 *
 * Returns the offending file and key, or null.
 */
/**
 * Env keys that re-route or expose requests without running any code: a
 * credential/base-URL variable, a proxy (with a CA bundle it can read the
 * bearer token in flight), TLS trust, Node preloads, and turning off the
 * CLI's subprocess scrub.
 */
const REDIRECTING_ENV = new Set([
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_OPTIONS",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "AWS_CA_BUNDLE",
]);
function redirectsCredential(key: string): boolean {
  return (
    isClaudeCredentialVar(key) ||
    REDIRECTING_ENV.has(key) ||
    // Where a Bedrock account's token goes, and where its telemetry (and
    // the telemetry headers' key) goes.
    key.startsWith("AWS_ENDPOINT_URL") ||
    key.startsWith("OTEL_EXPORTER_OTLP_")
  );
}

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
        for (const key of Object.keys(settings.env)) if (redirectsCredential(key)) return { file, key: `env.${key}` };
      }
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

