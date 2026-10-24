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

import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWrite, getConfigDir } from "../config.js";
import type { EffortLevel } from "../protocol/types.js";
import { AccountError, overlayKey, type ResolvedAccount } from "./accounts.js";

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
  /**
   * Directories created in the SOURCE before linking — where the vendor keeps
   * its conversations. Were the account to run first, the vendor would create
   * them in the account home, private to it, and a switched session could
   * never resume across accounts.
   */
  shared?: readonly string[];
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
  for (const dir of spec.shared ?? []) mkdirSync(join(source, dir), { recursive: true, mode: 0o700 });
  let entries: string[] = [];
  try {
    entries = readdirSync(source);
  } catch {
    // No default home yet: the account starts from nothing but its own files.
  }
  for (const name of entries) {
    if (own.has(name) || name in copies || isLockEntry(source, name)) continue;
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
      unlinkLink(link);
    }
    try {
      symlinkSync(want, link);
    } catch (err) {
      // Another session building the same home got there first (#417): fine if it's the same link.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || readlinkSync(link) !== want) throw err;
    }
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
    if (own.has(name) || name in copies || isLockEntry(source, name) || !entries.includes(name)) unlinkLink(link);
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

/**
 * Variables through which Codex can pick up an identity other than the
 * account's auth.json (CODEX_ACCESS_TOKEN, CODEX_AUTH, OPENAI_API_KEY,
 * OPENAI_IDENTITY_TOKEN_FILE, OPENAI_FEDERATION_RULE_ID, a base URL, another
 * home…). An allowlist, like Claude's: every CODEX_* and OPENAI_* goes but a
 * few that select nothing about who you are.
 */
const CODEX_KEEP = new Set(["CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_RS_LOG", "OPENAI_LOG"]);
export function isCodexCredentialVar(name: string): boolean {
  return (name.startsWith("CODEX_") || name.startsWith("OPENAI_")) && !CODEX_KEEP.has(name);
}

/** The vendor's default Codex home. */
export function defaultCodexHome(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

const CODEX_OWN = ["auth.json"];
/** Marker of which credential an API-key account's auth.json was written from (its fingerprint). */
const GENERATION_MARKER = ".codeoid-account-generation";

/**
 * Write an API-key account's `auth.json` with Codex's own command
 * (`codex login --with-api-key`), once per generation of the key — the
 * vendor's format, never ours.
 */
/** Logins in flight per account home — two sessions on one account start one `codex login`. */
const codexLogins = new Map<string, Promise<void>>();

export function ensureCodexApiKeyLogin(
  account: ResolvedAccount,
  run: { command: string; argsPrefix: string[]; env: Record<string, string> },
): Promise<void> {
  const key = `${account.home}\0${account.fingerprint}`;
  let running = codexLogins.get(key);
  if (!running) {
    running = codexApiKeyLogin(account, run).finally(() => codexLogins.delete(key));
    codexLogins.set(key, running);
  }
  return running;
}

async function codexApiKeyLogin(
  account: ResolvedAccount,
  run: { command: string; argsPrefix: string[]; env: Record<string, string> },
): Promise<void> {
  const marker = join(account.home, GENERATION_MARKER);
  // The fingerprint, not the generation: a hand-edited key changes it too.
  const written = account.fingerprint;
  try {
    if (readFileSync(marker, "utf8") === written && existsSync(join(account.home, "auth.json"))) return;
  } catch {
    // Not written yet.
  }
  // Asynchronously: the daemon serves every other session meanwhile.
  const status = await new Promise<number | string>((resolveExit) => {
    const child = spawn(run.command, [...run.argsPrefix, "login", "--with-api-key"], {
      env: { ...run.env, CODEX_HOME: account.home },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolveExit("spawn failed");
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit(code ?? signal ?? "?");
    });
    child.stdin?.end(account.account.token ?? "");
  });
  if (status !== 0 || !existsSync(join(account.home, "auth.json"))) {
    // Never the output: the command echoes a masked key, and an error may not mask it.
    throw new AccountError(`couldn't sign the codex account "${account.name}" in with its API key (codex login exited ${status})`);
  }
  writeFileSync(marker, written, { mode: 0o600 });
}

/**
 * The Codex child's environment for `account` (null = the daemon's own):
 * its own home, and none of the daemon's OpenAI/Codex keys — the account's
 * auth.json is the credential, and a daemon key must neither override it nor
 * reach the agent's tools.
 */
export async function applyCodexAccount(
  account: ResolvedAccount | null,
  env: Record<string, string>,
  run: { command: string; argsPrefix: string[] },
): Promise<Record<string, string>> {
  if (!account) return env;
  ensureOverlayHome({ source: defaultCodexHome(), target: account.home, own: CODEX_OWN, shared: ["sessions"] });
  const out = without(env, isCodexCredentialVar);
  if (account.kind === "api-key") await ensureCodexApiKeyLogin(account, { ...run, env: out });
  else requireFile(account.home, "auth.json", "ChatGPT sign-in", account);
  out.CODEX_HOME = account.home;
  return out;
}

// ── Gemini CLI ────────────────────────────────────────────────────────────────

/** The directory the Gemini CLI puts `.gemini` in (`GEMINI_CLI_HOME`, else HOME). */
export function defaultGeminiCliRoot(env: Record<string, string | undefined> = process.env): string {
  return env.GEMINI_CLI_HOME || env.HOME || homedir();
}

/** The Gemini CLI's own Google login files — never linked into an API-key account's home. */
const GEMINI_CLI_OWN = ["oauth_creds.json", "google_accounts.json", "gemini-credentials.json"];

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

/**
 * Make `account`'s Gemini CLI home (`<home>/.gemini`, an overlay) — selecting
 * API-key auth, so a default home that selects Google login can't override
 * the account's key, and without the daemon's own Google login files.
 */
export function ensureGeminiCliHome(account: Pick<ResolvedAccount, "home">): void {
  mkdirSync(account.home, { recursive: true, mode: 0o700 });
  ensureOverlayHome({
    source: join(defaultGeminiCliRoot(), ".gemini"),
    target: join(account.home, ".gemini"),
    own: GEMINI_CLI_OWN,
    copies: { "settings.json": (src) => geminiAccountSettings(src, "gemini-api-key") },
    shared: ["tmp"],
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

/**
 * The Gemini CLI's thinking effort (#417), which it takes only from its
 * settings: a home that overlays the one it would use (an account's, or the
 * default) — everything linked, logins and chats included — whose
 * settings.json redefines the two aliases its chat models think through.
 * One home per base and effort, kept under codeoid's account homes.
 */
export function applyGeminiCliEffort(
  effort: EffortLevel | undefined,
  env: Record<string, string>,
  homesRoot: string = join(getConfigDir(), "accounts"),
): Record<string, string> {
  if (!effort) return env;
  const base = env.GEMINI_CLI_HOME || defaultGeminiCliRoot();
  const key = `${overlayKey(base)}-${effort}`;
  const home = join(homesRoot, "gemini-cli-effort", key);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  ensureOverlayHome({
    source: join(base, ".gemini"),
    target: join(home, ".gemini"),
    own: [],
    copies: { "settings.json": (src) => geminiEffortSettings(src, effort) },
    shared: ["tmp"],
  });
  return { ...env, GEMINI_CLI_HOME: home };
}

/**
 * settings.json with the Gemini CLI's chat aliases set to a thinking effort:
 * `chat-base-2.5` takes a token budget, `chat-base-3` a level. Each
 * is redefined as the CLI ships it (extending `chat-base`) but for that value.
 */
export function geminiEffortSettings(source: string | undefined, effort: EffortLevel): string {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = source ? JSON.parse(source) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // An unreadable default is unreadable for the CLI too; start clean.
  }
  // The overlay can't know which model runs, so it uses values every model
  // of the family takes: 2.5 budgets from 512 (Flash-Lite's floor; Pro can't
  // turn thinking off) to 24576 (Flash's ceiling); 3.x only Low and High
  // (all Pro takes).
  const budgets: Record<EffortLevel, number> = { off: 512, minimal: 512, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 24576 };
  const level = effort === "off" || effort === "minimal" || effort === "low" ? "LOW" : "HIGH";
  const configs = (settings.modelConfigs && typeof settings.modelConfigs === "object" ? settings.modelConfigs : {}) as Record<string, unknown>;
  const aliases = (configs.customAliases && typeof configs.customAliases === "object" ? configs.customAliases : {}) as Record<string, unknown>;
  const thinking = (thinkingConfig: Record<string, unknown>) => ({
    extends: "chat-base",
    modelConfig: { generateContentConfig: { thinkingConfig } },
  });
  return `${JSON.stringify(
    {
      ...settings,
      modelConfigs: {
        ...configs,
        customAliases: {
          ...aliases,
          "chat-base-2.5": thinking({ thinkingBudget: budgets[effort] }),
          "chat-base-3": thinking({ thinkingLevel: level }),
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function applyGeminiCliAccount(account: ResolvedAccount | null, env: Record<string, string>): Record<string, string> {
  if (!account) return env;
  ensureGeminiCliHome(account);
  const out = without(env, isGeminiCredentialVar);
  out.GEMINI_API_KEY = account.account.token ?? "";
  out.GEMINI_CLI_HOME = account.home;
  return out;
}

// ── pi ────────────────────────────────────────────────────────────────────────

export function defaultPiAgentDir(env: Record<string, string | undefined> = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
}

/** pi's agent dir, as pi reads PI_CODING_AGENT_DIR (a leading ~ is home). */
function piAgentDirOf(env: Record<string, string | undefined>): string {
  const dir = env.PI_CODING_AGENT_DIR || defaultPiAgentDir(env);
  return dir === "~" || dir.startsWith("~/") ? join(env.HOME || homedir(), dir.slice(1)) : dir;
}

/**
 * A lock another process holds right now — proper-lockfile's `<file>.lock`
 * directory (pi, the Gemini CLI) — never linked into an overlay. A lock FILE
 * (codex's .sqlite-maintenance.lock) is a permanent shared lock: linked as before.
 */
function isLockEntry(dir: string, name: string): boolean {
  if (!name.endsWith(".lock")) return false;
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return true; // gone between the listing and now: a lock just released
  }
}

/** Remove a link that another session building the same overlay may have removed first. */
function unlinkLink(link: string): void {
  try {
    unlinkSync(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * pi's agent dir for a codeoid session (#417): an overlay of the one it would
 * use (an account's, or the default) — everything linked, so its logins and
 * sessions are the user's — except settings.json, a fresh copy at each start.
 * pi saves a thinking-level change (and a model change) as the user's global
 * default in that file; the copy keeps them out of the user's own pi. (Sessions
 * on the same base share the copy — codeoid sends each its level every turn.)
 * pi's OAuth refresh locks the real auth.json; only a sign-in or sign-out
 * locks by this overlay's path (docs/thinking-effort.md).
 */
export function applyPiSettingsOverlay(
  env: Record<string, string>,
  homesRoot: string = join(getConfigDir(), "accounts"),
): Record<string, string> {
  const base = piAgentDirOf(env);
  // pi creates its auth.json when it's missing — then it must be the user's,
  // not a file of the overlay's own that a later `pi /login` never reaches.
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const auth = join(base, "auth.json");
  if (!existsSync(auth)) {
    try {
      writeFileSync(auth, "{}", { mode: 0o600, flag: "wx" }); // never through a planted link
    } catch (err) {
      // There after all (made meanwhile, or a dangling link): pi's to deal with, as without codeoid.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const home = join(homesRoot, "pi-session", overlayKey(base));
  // An overlay built before that took an empty one of its own: link the user's instead.
  try {
    const own = join(home, "auth.json");
    if (!lstatSync(own).isSymbolicLink() && readFileSync(own, "utf8").trim() === "{}") unlinkSync(own);
  } catch {
    // None yet.
  }
  ensureOverlayHome({
    source: base,
    target: home,
    own: [],
    copies: { "settings.json": (src) => src ?? "{}\n" },
    shared: ["sessions"],
  });
  return { ...env, PI_CODING_AGENT_DIR: home };
}

/**
 * The thinking level pi starts a session at, as the user set it (#417): their
 * settings' default, else pi's own, Medium. A project's .pi/settings.json
 * isn't read: pi honours it only for a project the user trusts, and a repo
 * mustn't choose the level (and the cost) by committing one.
 */
export function piDefaultThinkingLevel(env: Record<string, string | undefined>): string {
  try {
    const level = (JSON.parse(readFileSync(join(piAgentDirOf(env), "settings.json"), "utf8")) as { defaultThinkingLevel?: unknown }).defaultThinkingLevel;
    if (typeof level === "string" && level) return level;
  } catch {
    // None, or unreadable: pi's own default.
  }
  return "medium";
}

/**
 * pi's child for `account`: only the account's keys, in an agent dir without
 * pi's stored logins (`auth.json`) — otherwise pi would prefer a stored login
 * over the account's key.
 */
export function applyPiAccount(account: ResolvedAccount | null, env: Record<string, string>): Record<string, string> {
  if (!account) return env;
  ensureOverlayHome({ source: piAgentDirOf(process.env), target: account.home, own: ["auth.json"], shared: ["sessions"] });
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

/**
 * dotenv's own line grammar (dotenv `parse`, which the Gemini CLI and qwen-code
 * vendor): `KEY=value` AND `KEY: value`, an optional `export`, quoted values
 * that span lines. A narrower reading would miss keys the CLI applies.
 */
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** The keys a `.env` file sets, read as dotenv reads them. */
export function envFileKeys(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const m of text.replace(/\r\n?/g, "\n").matchAll(DOTENV_LINE)) if (m[1]) keys.push(m[1]);
  return keys;
}

/**
 * Remove `//` and `/* *\/` comments outside strings — what the CLIs do
 * (strip-json-comments) before parsing their settings.json.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out;
}

/**
 * A project settings.json as the CLI would read it. A file codeoid can't
 * parse is treated as one that redirects (fail closed): the CLI's parser
 * may well accept what this one doesn't.
 */
function readProjectSettings(file: string): Record<string, unknown> | "unreadable" {
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(file, "utf8")).replace(/,(\s*[}\]])/g, "$1"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return "unreadable";
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
      const parsed = readProjectSettings(settings);
      if (parsed === "unreadable") return { file: settings, key: "(unparseable — codeoid can't tell what it sets)" };
      if ((parsed.security as { auth?: unknown } | undefined)?.auth !== undefined) return { file: settings, key: "security.auth" };
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

// ── Qwen ──────────────────────────────────────────────────────────────────────

/** The vendor's default Qwen home (`QWEN_HOME`, else ~/.qwen). */
export function defaultQwenHome(env: Record<string, string | undefined> = process.env): string {
  return env.QWEN_HOME || join(env.HOME || homedir(), ".qwen");
}

/**
 * Settings keys through which qwen-code picks a provider, base URL or key
 * ahead of the environment codeoid gives it: a `modelProviders` entry for the
 * session's model wins over OPENAI_BASE_URL / OPENAI_API_KEY.
 */
const QWEN_REDIRECTING_SETTINGS = ["modelProviders", "providerProtocol"] as const;

/** The default settings.json without anything that could take an account's key elsewhere. */
/**
 * A Qwen account's environment additions over the allowlist: its key, and
 * every other key, org or project the daemon has set to empty — the SDK merges
 * over process.env, and an empty value reads as unset (with no .env in the
 * account home to fill it back in).
 */
export function qwenAccountEnv(account: ResolvedAccount, base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(base)) {
    if (/_API_KEY$|_API_TOKEN$|^OPENAI_|^DASHSCOPE_|^BAILIAN_/.test(k) || (k.startsWith("QWEN_") && k !== "QWEN_HOME")) out[k] = "";
  }
  out.OPENAI_API_KEY = account.account.token ?? "";
  out.QWEN_HOME = ensureQwenHome(account);
  return out;
}

export function qwenAccountSettings(source: string | undefined): string {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = source ? JSON.parse(source) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = { ...(parsed as Record<string, unknown>) };
  } catch {
    // Unreadable for the CLI too; start clean.
  }
  for (const k of QWEN_REDIRECTING_SETTINGS) delete settings[k];
  const security = settings.security && typeof settings.security === "object" ? { ...(settings.security as Record<string, unknown>) } : undefined;
  if (security) {
    delete security.auth;
    settings.security = security;
  }
  const model = settings.model && typeof settings.model === "object" ? { ...(settings.model as Record<string, unknown>) } : undefined;
  if (model) {
    delete model.baseUrl;
    settings.model = model;
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * An account's Qwen home (`QWEN_HOME`): an overlay of the default one whose
 * settings.json can't redirect the account's key — so the user's own
 * provider entries, which would win over the account's endpoint, don't apply
 * — and without the daemon's own OAuth login. Session files stay shared.
 */
export function ensureQwenHome(account: Pick<ResolvedAccount, "home">): string {
  ensureOverlayHome({
    source: defaultQwenHome(),
    target: account.home,
    // Its .env too: qwen-code fills unset variables from it, which would
    // bring the daemon's own DASHSCOPE / OPENAI keys back.
    own: ["oauth_creds.json", "oauth_creds.lock", ".env"],
    copies: { "settings.json": qwenAccountSettings },
    shared: ["projects"],
  });
  return account.home;
}

/**
 * Does a project file in `workdir` (or a parent below HOME) redirect a Qwen
 * account's key? qwen-code loads `.qwen/settings.json` from the workspace
 * (folder trust is off by default) and `.qwen/.env` / `.env` upward; a cloned
 * repo's `modelProviders` entry would send the key — and the conversation —
 * to the repo's server. Returns the file and key, or null.
 */
export function qwenProjectOverride(workdir: string): { file: string; key: string } | null {
  const home = resolve(homedir());
  const isQwenVar = (k: string) => /^(OPENAI|DASHSCOPE|QWEN|BAILIAN)_/.test(k) || REDIRECTING_ENV.has(k);
  for (let dir = resolve(workdir); ; dir = dirname(dir)) {
    if (dir === home) break;
    for (const file of [join(dir, ".qwen", ".env"), join(dir, ".env")]) {
      for (const key of envFileKeys(file)) if (isQwenVar(key)) return { file, key };
    }
    const settings = join(dir, ".qwen", "settings.json");
    if (existsSync(settings)) {
      const raw = readProjectSettings(settings);
      if (raw === "unreadable") return { file: settings, key: "(unparseable — codeoid can't tell what it sets)" };
      const parsed = raw as Record<string, unknown> & { security?: { auth?: unknown }; model?: { baseUrl?: unknown }; env?: unknown };
      for (const k of QWEN_REDIRECTING_SETTINGS) if (parsed[k] !== undefined) return { file: settings, key: k };
      // A proxy sees the key in full on an http base URL.
      if (parsed.proxy !== undefined) return { file: settings, key: "proxy" };
      if (parsed.security?.auth !== undefined) return { file: settings, key: "security.auth" };
      if (parsed.model?.baseUrl !== undefined) return { file: settings, key: "model.baseUrl" };
      if (parsed.env && typeof parsed.env === "object") {
        for (const k of Object.keys(parsed.env)) if (isQwenVar(k)) return { file: settings, key: `env.${k}` };
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
