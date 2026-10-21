/**
 * Applying an account to a backend's process or client
 * (docs/backend-accounts-design.md).
 *
 * HTTP backends take a key per turn. Process backends — Codex, the Gemini CLI,
 * pi — keep their login in a directory, so an account of theirs runs in its
 * own HOME: an OVERLAY of the vendor's default home in which every entry is a
 * symlink to the real one (config, MCP settings, skills, session files, state
 * databases) except the vendor's credential files, which are the account's
 * own. Sharing everything but the credential is what lets a session switched
 * to another account resume the same conversation natively.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../config.js";
import { AccountError, type ResolvedAccount } from "./accounts.js";

// ── Overlay homes ─────────────────────────────────────────────────────────────

export interface OverlaySpec {
  /** The vendor's default home (what an account shares). */
  source: string;
  /** The account's home. */
  target: string;
  /** Entries that belong to the account (its credential), never linked. */
  own: readonly string[];
  /** Entries written as a transformed copy of the source's (or from nothing). */
  copies?: Record<string, (source: string | undefined) => string>;
}

/**
 * Make `target` an overlay of `source`: link every entry of the source that
 * isn't the account's own, re-point a link that drifted, drop links whose
 * source is gone, and leave the account's own files alone. Idempotent and
 * cheap — run before every spawn so entries the vendor adds later appear.
 */
export function ensureOverlayHome(spec: OverlaySpec): void {
  mkdirSync(spec.target, { recursive: true, mode: 0o700 });
  chmodSync(spec.target, 0o700);
  const own = new Set(spec.own);
  const copies = spec.copies ?? {};
  const source = resolve(spec.source);
  let entries: string[] = [];
  try {
    entries = readdirSync(source);
  } catch {
    // No default home yet: the account starts from nothing but its own files.
  }
  for (const name of entries) {
    if (own.has(name) || name in copies) continue;
    const link = join(spec.target, name);
    const want = join(source, name);
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(link);
    } catch {
      // Absent — linked below.
    }
    if (stat && !stat.isSymbolicLink()) continue; // the account's own copy
    if (stat?.isSymbolicLink()) {
      if (readlinkSync(link) === want) continue;
      unlinkSync(link);
    }
    symlinkSync(want, link);
  }
  // Links into the source whose entry is gone, and links to anything we
  // now treat as the account's own (a vendor renamed its credential file).
  for (const name of readdirSync(spec.target)) {
    const link = join(spec.target, name);
    let isLink = false;
    try {
      isLink = lstatSync(link).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isLink) continue;
    if (own.has(name) || name in copies || !entries.includes(name)) unlinkSync(link);
  }
  for (const [name, transform] of Object.entries(copies)) {
    const from = join(source, name);
    let content: string | undefined;
    try {
      content = readFileSync(from, "utf8");
    } catch {
      content = undefined;
    }
    atomicWrite(join(spec.target, name), transform(content), 0o600);
  }
}

/** Remove from `env` every name `drop` matches. Pure. */
function without(env: Record<string, string>, drop: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!drop(k)) out[k] = v;
  return out;
}

function requireFile(home: string, file: string, what: string, account: ResolvedAccount): void {
  if (!existsSync(join(home, file))) {
    throw new AccountError(`the ${account.backend} account "${account.name}" has no ${what} — sign it in again`);
  }
}

// ── Codex ─────────────────────────────────────────────────────────────────────

/** The vendor's default Codex home. */
export function defaultCodexHome(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

const CODEX_OWN = ["auth.json"];
/** Marker of which generation of an API-key account's auth.json was written. */
const GENERATION_MARKER = ".codeoid-account-generation";

/**
 * Write an API-key account's `auth.json` with Codex's own command
 * (`codex login --with-api-key`), once per generation of the key — the
 * vendor's format, never ours.
 */
export function ensureCodexApiKeyLogin(
  account: ResolvedAccount,
  run: { command: string; argsPrefix: string[]; env: Record<string, string> },
): void {
  const marker = join(account.home, GENERATION_MARKER);
  const generation = String(account.account.generation);
  try {
    if (readFileSync(marker, "utf8") === generation && existsSync(join(account.home, "auth.json"))) return;
  } catch {
    // Not written yet.
  }
  const r = spawnSync(run.command, [...run.argsPrefix, "login", "--with-api-key"], {
    input: account.account.token ?? "",
    env: { ...run.env, CODEX_HOME: account.home },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0 || !existsSync(join(account.home, "auth.json"))) {
    // Never the output: the command echoes a masked key, and an error may not mask it.
    throw new AccountError(`couldn't sign the codex account "${account.name}" in with its API key (codex login exited ${r.status ?? r.signal ?? "?"})`);
  }
  writeFileSync(marker, generation, { mode: 0o600 });
}

/**
 * The Codex child's environment for `account` (null = the daemon's own):
 * its own home, and none of the daemon's OpenAI/Codex keys — the account's
 * auth.json is the credential, and a daemon key must neither override it nor
 * reach the agent's tools.
 */
export function applyCodexAccount(
  account: ResolvedAccount | null,
  env: Record<string, string>,
  run: { command: string; argsPrefix: string[] },
): Record<string, string> {
  if (!account) return env;
  ensureOverlayHome({ source: defaultCodexHome(), target: account.home, own: CODEX_OWN });
  const out = without(env, (k) => k === "OPENAI_API_KEY" || k === "CODEX_API_KEY" || k === "OPENAI_BASE_URL" || k === "CODEX_HOME");
  if (account.kind === "api-key") ensureCodexApiKeyLogin(account, { ...run, env: out });
  else requireFile(account.home, "auth.json", "ChatGPT sign-in", account);
  out.CODEX_HOME = account.home;
  return out;
}

// ── Gemini CLI ────────────────────────────────────────────────────────────────

/** The directory the Gemini CLI puts `.gemini` in (`GEMINI_CLI_HOME`, else HOME). */
export function defaultGeminiCliRoot(env: Record<string, string | undefined> = process.env): string {
  return env.GEMINI_CLI_HOME || env.HOME || homedir();
}

const GEMINI_CLI_OWN = ["oauth_creds.json", "google_accounts.json"];

/** The auth type the account's settings.json selects. */
export function geminiAuthType(kind: ResolvedAccount["kind"]): string {
  return kind === "google-login" ? "oauth-personal" : "gemini-api-key";
}

/** settings.json for an account: the default one, with its auth type set to the account's kind. */
export function geminiAccountSettings(source: string | undefined, authType: string): string {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = source ? JSON.parse(source) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // An unreadable default is unreadable for the CLI too; start clean.
  }
  const security = (settings.security && typeof settings.security === "object" ? settings.security : {}) as Record<string, unknown>;
  const auth = (security.auth && typeof security.auth === "object" ? security.auth : {}) as Record<string, unknown>;
  return `${JSON.stringify({ ...settings, security: { ...security, auth: { ...auth, selectedType: authType } } }, null, 2)}\n`;
}

/** Make `account`'s Gemini CLI home (`<home>/.gemini`, an overlay). */
export function ensureGeminiCliHome(account: Pick<ResolvedAccount, "home" | "kind">): void {
  mkdirSync(account.home, { recursive: true, mode: 0o700 });
  ensureOverlayHome({
    source: join(defaultGeminiCliRoot(), ".gemini"),
    target: join(account.home, ".gemini"),
    own: GEMINI_CLI_OWN,
    copies: { "settings.json": (src) => geminiAccountSettings(src, geminiAuthType(account.kind)) },
  });
}

/** Variables through which the Gemini CLI picks up a credential or another backend. */
export function isGeminiCredentialVar(name: string): boolean {
  return (
    name === "GEMINI_API_KEY" ||
    name === "GOOGLE_API_KEY" ||
    name === "GOOGLE_APPLICATION_CREDENTIALS" ||
    name === "GEMINI_CLI_HOME" ||
    name.startsWith("GOOGLE_CLOUD_") ||
    name.startsWith("GOOGLE_GENAI_") ||
    name === "CODE_ASSIST_ENDPOINT"
  );
}

export function applyGeminiCliAccount(account: ResolvedAccount | null, env: Record<string, string>): Record<string, string> {
  if (!account) return env;
  ensureGeminiCliHome(account);
  const out = without(env, isGeminiCredentialVar);
  if (account.kind === "api-key") out.GEMINI_API_KEY = account.account.token ?? "";
  else requireFile(join(account.home, ".gemini"), "oauth_creds.json", "Google sign-in", account);
  out.GEMINI_CLI_HOME = account.home;
  return out;
}

// ── pi ────────────────────────────────────────────────────────────────────────

export function defaultPiAgentDir(env: Record<string, string | undefined> = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
}

/**
 * pi's child for `account`: only the account's keys, in an agent dir without
 * pi's stored logins (`auth.json`) — otherwise pi would prefer a stored login
 * over the account's key.
 */
export function applyPiAccount(account: ResolvedAccount | null, env: Record<string, string>): Record<string, string> {
  if (!account) return env;
  ensureOverlayHome({ source: defaultPiAgentDir(), target: account.home, own: ["auth.json"] });
  const out = without(
    env,
    (k) => k.endsWith("_API_KEY") || k.endsWith("_API_TOKEN") || k === "PI_CODING_AGENT_DIR" || /^(ANTHROPIC|OPENAI|GOOGLE|GEMINI)_/.test(k),
  );
  for (const [k, v] of Object.entries(account.account.env ?? {})) out[k] = v;
  out.PI_CODING_AGENT_DIR = account.home;
  return out;
}

// ── Project overrides ─────────────────────────────────────────────────────────

/** Keys that redirect requests or expose them, beyond a backend's own credential variables. */
const REDIRECTING_ENV = new Set([
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_OPTIONS",
]);

function envFileKeys(file: string): string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined);
  } catch {
    return [];
  }
}

/**
 * Does a project file in `workdir` (or a parent below HOME) redirect a Gemini
 * CLI account's credential? The CLI loads `.gemini/.env`, then `.env`, from
 * the workdir upward, and `.gemini/settings.json`; a cloned repo could point
 * `GOOGLE_GEMINI_BASE_URL` or a proxy at its own host. Returns the file and
 * key, or null.
 */
export function geminiProjectOverride(workdir: string): { file: string; key: string } | null {
  const home = resolve(homedir());
  for (let dir = resolve(workdir); ; dir = dirname(dir)) {
    if (dir === home) break;
    for (const file of [join(dir, ".gemini", ".env"), join(dir, ".env")]) {
      for (const key of envFileKeys(file)) {
        if (isGeminiCredentialVar(key) || key.startsWith("GOOGLE_GEMINI_") || REDIRECTING_ENV.has(key)) return { file, key };
      }
    }
    const settings = join(dir, ".gemini", "settings.json");
    if (existsSync(settings)) {
      try {
        const parsed = JSON.parse(readFileSync(settings, "utf8")) as { security?: { auth?: unknown } };
        if (parsed?.security?.auth !== undefined) return { file: settings, key: "security.auth" };
      } catch {
        // Unreadable for the CLI too.
      }
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

/** Remove an account home (account removed). */
export function removeAccountHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}
