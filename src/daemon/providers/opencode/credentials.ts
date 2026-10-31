/**
 * codeoid's model credentials for its private opencode server.
 *
 * The server's environment carries no credential (policy.ts,
 * `buildOpencodeEnv`): opencode runs some shell lines without asking (only
 * assignments, `cd`, `export`), and a subagent whose shell environment
 * codeoid hasn't set yet runs with the server's, so a key there could be
 * printed into a result the model reads. Instead each key codeoid has is
 * written to a file only codeoid's user can read (0600, in this daemon's
 * 0700 dir of `codeoid-credentials/` beside opencode's database), and the
 * injected config names the file with opencode's substitution
 * (`"apiKey": "{file:/…/anthropic.key}"`). opencode 2.2.5 expands `{file:}`
 * in `OPENCODE_CONFIG_CONTENT` (it reads the file, trims it, and
 * JSON-escapes it into the config text) each time it loads a location, so
 * the files must stay while the server runs: each daemon has its own dir,
 * and nothing removes a running daemon's.
 *
 * What maps where:
 *   - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` (or
 *     `GEMINI_API_KEY`) → opencode's built-in `anthropic`, `openai`, `google`.
 *     A key goes where codeoid's own backends send it: with
 *     `ANTHROPIC_BASE_URL` (the Claude CLI's), `OPENAI_BASE_URL` (the OpenAI
 *     SDK's) or, for `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL` (the Gemini
 *     CLI's) naming a gateway, the provider's `baseURL` is that gateway, never
 *     the vendor's public API; one that isn't an http(s) URL, or that carries
 *     a credential, a query string or a fragment, withholds the key (so does
 *     such a Qwen endpoint): the config is in the server's environment.
 *   - codeoid's Qwen backend on a key → an OpenAI-compatible provider `qwen`
 *     with the models codeoid knows for it. On the Qwen backend's default
 *     account, the account's key and endpoint; else, when Qwen is set up for
 *     a key (`providers.qwen` names a base URL, a model or auth `openai`, or
 *     its catalog is cached), `OPENAI_API_KEY` for that endpoint, which the
 *     `openai` provider then doesn't also get.
 *   - codeoid's OpenAI-compatible endpoints (`oai:<name>`) with a model →
 *     `oai-<name>`, its key and header values as files too.
 *
 * Every string codeoid puts in the config beside the references is checked
 * for a substitution of its own (`{file:` / `{env:`): a model id set through
 * the settings API must not make opencode read a file into a request.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CodeoidConfig, resolveQwenBaseUrl } from "../../../config.js";
import { resolveQwenAuthType } from "../qwen/index.js";
import { hasSubstitution } from "./policy.js";
import { OPENCODE_CREDENTIALS_PROCESS_DIR, OPENCODE_PID_NAMESPACE } from "./resolve.js";

/** opencode's package for an OpenAI-compatible chat-completions provider (2.2). */
export const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";

/** What codeoid knows of its own configured backends, read when the server starts. */
export interface OpencodeCredentialInputs {
  /** The daemon's environment (keys from `~/.codeoid/.env` are loaded into it). */
  env: Record<string, string | undefined>;
  /** `providers.qwen` of codeoid's config. */
  qwen?: { enabled?: boolean; authType?: "openai" | "qwen-oauth"; baseUrl?: string; model?: string };
  /**
   * The Qwen backend's default account, when it has one (its key and
   * endpoint replace `OPENAI_API_KEY` there, as in the Qwen backend), or why
   * it can't be used.
   */
  qwenAccount?: { token?: string; baseUrl?: string } | { unusable: string } | null;
  /** Models codeoid knows for its Qwen backend (its cached catalog), beside `qwen.model`. */
  qwenModels?: ReadonlyArray<{ id: string; name?: string; contextWindow?: number }>;
  /** codeoid's OpenAI-compatible endpoints. */
  endpoints?: ReadonlyArray<OpencodeEndpointInput>;
  /** Where a qwen.ai sign-in lives (`resolveQwenAuthType`); tests point it elsewhere. */
  qwenOauthCredsPath?: string;
}

export interface OpencodeEndpointInput {
  name: string;
  displayName?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: ReadonlyArray<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>;
  defaultModel?: string;
  contextWindow?: number;
}

/** The providers to inject (with `{file:}` references) and the files they reference. */
export interface OpencodeCredentialPlan {
  /** opencode `providers` entries, by provider id. */
  providers: Record<string, Record<string, unknown>>;
  /** File name (in the credentials dir) → secret. */
  secrets: Map<string, string>;
  /** Why something codeoid has wasn't handed to opencode (logged). */
  skipped: string[];
}

/** The credentials directory can't be named in a `{file:}` reference safely. */
export class OpencodeCredentialError extends Error {
  override name = "OpencodeCredentialError";
}

/**
 * `{file:<path>}` for a file in `dir`. opencode finds references with
 * `/\{file:[^}]+\}/` in the config's JSON text, so the path can't hold `}`,
 * and anything JSON escapes (`"`, `\`, control characters) would be read
 * back escaped: refused, so a key is never silently missing.
 */
export function fileReference(dir: string, name: string): string {
  const path = join(dir, name);
  if (/[}"\\\u0000-\u001f]/.test(path) || !path.startsWith("/")) {
    throw new OpencodeCredentialError(`codeoid can't hand opencode its credentials from ${JSON.stringify(dir)}: the path must be absolute, without \`}\`, \`"\` or \`\\\``);
  }
  return `{file:${path}}`;
}

function parsedUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * Does `url` carry a credential of its own (a user or password, a query
 * string, a fragment)? Such a URL isn't handed to opencode: the config it
 * would ride is in the server's environment, which holds no credential
 * (codeoid's endpoint and account stores refuse such URLs outright).
 */
function carriesCredential(url: URL): boolean {
  return Boolean(url.username || url.password || url.search || url.hash);
}

/** Is `url` OpenAI's own API (where an `OPENAI_API_KEY` is OpenAI's)? */
function isOpenAiHost(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * The gateway variable each built-in's key is used with elsewhere in codeoid,
 * the vendor's own host, and what opencode's `baseURL` adds to the variable's
 * root (2.2.5 posts to `<baseURL>/messages`, `<baseURL>/responses`,
 * `<baseURL>/models/…`; the variables name the root the vendors' SDKs add
 * `/v1`, nothing, `/v1beta` to).
 */
const GATEWAYS = {
  anthropic: { variable: "ANTHROPIC_BASE_URL", host: "api.anthropic.com", path: "/v1" },
  openai: { variable: "OPENAI_BASE_URL", host: "api.openai.com", path: "" },
  google: { variable: "GOOGLE_GEMINI_BASE_URL", host: "generativelanguage.googleapis.com", path: "/v1beta" },
} as const;

/** Where a built-in's key goes: `{}` for the vendor's API, `{ baseURL }` for a gateway, `{ problem }` to withhold the key. */
function gatewayFor(id: keyof typeof GATEWAYS, env: Record<string, string | undefined>): { baseURL?: string; problem?: string } {
  const { variable, host, path } = GATEWAYS[id];
  const raw = nonEmpty(env[variable]);
  if (!raw) return {};
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: `${id}: ${variable} isn't a URL, so codeoid can't tell where its key goes` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: `${id}: ${variable} isn't an http(s) URL` };
  if (carriesCredential(url)) return { problem: `${id}: ${variable} carries a credential, a query string or a fragment, which opencode's config would put in its server's environment` };
  if (url.hostname === host) return {};
  return { baseURL: `${raw.replace(/\/+$/, "")}${path}` };
}

/**
 * Plan which of codeoid's credentials reach which opencode provider.
 * `dir` is the credentials directory the references name.
 */
export function planOpencodeCredentials(inputs: OpencodeCredentialInputs, dir: string): OpencodeCredentialPlan {
  const { env } = inputs;
  const providers: Record<string, Record<string, unknown>> = {};
  const secrets = new Map<string, string>();
  const skipped: string[] = [];
  /** `entry` gets the references; every value in `checked` (what codeoid put in it) is checked first. */
  const add = (id: string, checked: unknown, files: Record<string, string>, entry: (ref: (file: string) => string) => Record<string, unknown>) => {
    if (hasSubstitution(checked)) {
      skipped.push(`${id}: a value in its settings holds an opencode substitution ({file:…} / {env:…}), which opencode would expand`);
      return;
    }
    providers[id] = entry((file) => fileReference(dir, file));
    for (const [file, value] of Object.entries(files)) secrets.set(file, value);
  };

  // codeoid's Qwen backend on a key: an OpenAI-compatible key for Qwen's endpoint.
  const qwen = inputs.qwen;
  const qwenEnabled = qwen !== undefined && qwen.enabled !== false;
  const account = qwenEnabled ? (inputs.qwenAccount ?? null) : null;
  const openaiKey = nonEmpty(env.OPENAI_API_KEY);
  /** Qwen's endpoint and key, when there is one to hand over. */
  let qwenKey: { baseUrl: string | undefined; key: string | undefined } | null = null;
  /** `OPENAI_API_KEY` is Qwen's (built-in account, Qwen set up for a key), not OpenAI's. */
  let envKeyIsQwens = false;
  if (account && "unusable" in account) {
    skipped.push(`qwen: the Qwen backend's default account can't be used (${account.unusable})`);
  } else if (account) {
    // As the Qwen backend does: an account replaces the configured auth and endpoint.
    qwenKey = { baseUrl: resolveQwenBaseUrl(nonEmpty(account.baseUrl)), key: nonEmpty(account.token) };
  } else if (qwenEnabled) {
    const baseUrl = resolveQwenBaseUrl(nonEmpty(qwen.baseUrl)) ?? nonEmpty(env.OPENAI_BASE_URL);
    // `providers.qwen` is always there (zod default): OPENAI_BASE_URL alone is codeoid's `openai` backend's gateway too.
    const setUp = Boolean(nonEmpty(qwen.baseUrl) || nonEmpty(qwen.model) || qwen.authType === "openai" || (inputs.qwenModels?.length ?? 0) > 0);
    envKeyIsQwens =
      setUp && resolveQwenAuthType(qwen.authType, inputs.qwenOauthCredsPath) === "openai" && baseUrl !== undefined && !isOpenAiHost(baseUrl);
    if (envKeyIsQwens) qwenKey = { baseUrl, key: openaiKey };
  }
  const qwenUrl = qwenKey?.baseUrl === undefined ? undefined : parsedUrl(qwenKey.baseUrl);
  if (qwenKey?.key && qwenKey.baseUrl === undefined) {
    skipped.push("qwen: the Qwen backend's account names no endpoint");
  } else if (qwenKey?.key && (!qwenUrl || (qwenUrl.protocol !== "https:" && qwenUrl.protocol !== "http:"))) {
    skipped.push("qwen: the Qwen backend's endpoint isn't an http(s) URL");
  } else if (qwenKey?.key && qwenUrl && carriesCredential(qwenUrl)) {
    skipped.push("qwen: the Qwen backend's endpoint carries a credential, a query string or a fragment, which opencode's config would put in its server's environment");
  } else if (qwenKey?.key && qwenKey.baseUrl !== undefined && isOpenAiHost(qwenKey.baseUrl)) {
    skipped.push("qwen: the Qwen backend's account names OpenAI's own API as its endpoint");
  } else if (qwenKey?.key && qwenKey.baseUrl !== undefined) {
    const { baseUrl: qwenBaseUrl, key } = qwenKey;
    const models: Record<string, Record<string, unknown>> = {};
    const known = [...(qwen?.model ? [{ id: qwen.model }] : []), ...(inputs.qwenModels ?? [])];
    for (const m of known) {
      if (!m.id || models[m.id]) continue;
      models[m.id] = {
        name: ("name" in m && m.name) || m.id,
        capabilities: { tools: true },
        ...("contextWindow" in m && m.contextWindow ? { limit: { context: m.contextWindow } } : {}),
      };
    }
    if (Object.keys(models).length === 0) {
      skipped.push("qwen: codeoid knows no Qwen model (set providers.qwen.model)");
    } else {
      add("qwen", [qwenBaseUrl, models], { "qwen.key": key }, (ref) => ({
        name: "Qwen (codeoid)",
        package: OPENAI_COMPATIBLE_PACKAGE,
        settings: { baseURL: qwenBaseUrl, apiKey: ref("qwen.key") },
        models,
      }));
    }
  }

  const googleKey = nonEmpty(env.GOOGLE_API_KEY);
  const builtin: Array<[keyof typeof GATEWAYS, string | undefined, { baseURL?: string; problem?: string }]> = [
    ["anthropic", nonEmpty(env.ANTHROPIC_API_KEY), gatewayFor("anthropic", env)],
    // Claimed by Qwen: the same variable is an OpenAI-compatible key for Qwen's endpoint, not OpenAI's.
    ["openai", envKeyIsQwens ? undefined : openaiKey, gatewayFor("openai", env)],
    // GOOGLE_API_KEY is the Gemini backend's, sent to Google; GEMINI_API_KEY the Gemini CLI's, sent to GOOGLE_GEMINI_BASE_URL.
    ["google", googleKey ?? nonEmpty(env.GEMINI_API_KEY), googleKey ? {} : gatewayFor("google", env)],
  ];
  for (const [id, key, gateway] of builtin) {
    if (!key) continue;
    if (gateway.problem) {
      skipped.push(gateway.problem);
      continue;
    }
    const baseURL = gateway.baseURL;
    add(id, [baseURL], { [`${id}.key`]: key }, (ref) => ({ settings: { apiKey: ref(`${id}.key`), ...(baseURL ? { baseURL } : {}) } }));
  }

  for (const e of inputs.endpoints ?? []) {
    const id = `oai-${e.name}`;
    const declared = e.models.length > 0 ? e.models : e.defaultModel ? [{ id: e.defaultModel }] : [];
    if (declared.length === 0) {
      skipped.push(`${id}: the endpoint names no model (configure its models)`);
      continue;
    }
    const models: Record<string, Record<string, unknown>> = {};
    for (const m of declared) {
      const context = ("contextWindow" in m ? m.contextWindow : undefined) ?? e.contextWindow;
      const output = "maxTokens" in m ? m.maxTokens : undefined;
      models[m.id] = {
        name: ("name" in m && m.name) || m.id,
        capabilities: { tools: true },
        ...(context || output ? { limit: { ...(context ? { context } : {}), ...(output ? { output } : {}) } } : {}),
      };
    }
    const headerNames = Object.keys(e.headers ?? {});
    const files: Record<string, string> = {};
    if (e.apiKey) files[`${id}.key`] = e.apiKey;
    headerNames.forEach((h, i) => {
      files[`${id}.header-${i}`] = e.headers![h]!;
    });
    const name = e.displayName || e.name;
    add(id, [name, e.baseUrl, models, headerNames], files, (ref) => ({
      name,
      package: OPENAI_COMPATIBLE_PACKAGE,
      settings: { baseURL: e.baseUrl, ...(e.apiKey ? { apiKey: ref(`${id}.key`) } : {}) },
      ...(headerNames.length > 0 ? { headers: Object.fromEntries(headerNames.map((h, i) => [h, ref(`${id}.header-${i}`)])) } : {}),
      models,
    }));
  }
  return { providers, secrets, skipped };
}

/**
 * The names codeoid writes in a credentials dir (`planOpencodeCredentials`;
 * endpoint names are `[a-z0-9-]`), and their temp files: the only entries it
 * ever removes there. Anything else is left alone, and never recursed into.
 */
const CREDENTIAL_FILE = /^(?:(?:anthropic|openai|google|qwen)\.key|oai-[a-z0-9][a-z0-9-]*\.(?:key|header-\d+))$/;
const CREDENTIAL_TEMP = /^\.(.+)\.\d+\.tmp$/;

function isCredentialFile(name: string): boolean {
  return CREDENTIAL_FILE.test(CREDENTIAL_TEMP.exec(name)?.[1] ?? name);
}

/**
 * A daemon process's dir in a credentials root
 * (`OPENCODE_CREDENTIALS_PROCESS_DIR`: namespace, pid, nonce); one without a
 * namespace is from a build before it (`<pid>-<nonce>`), its pid unknowable.
 */
const PROCESS_DIR = /^(?:([0-9a-f]{12})-)?(\d+)-[0-9a-f]{12}$/;

/** How often a daemon marks its dirs as in use (their mtime), while they exist. */
export const OPENCODE_CREDENTIALS_HEARTBEAT_MS = 10 * 60 * 1000;
/**
 * A dir from another pid namespace (`OPENCODE_PID_NAMESPACE`) whose daemon's
 * pid can't be checked here is gone once it went this long unmarked: far
 * past the heartbeat, and any clock skew between hosts sharing a home.
 */
export const OPENCODE_CREDENTIALS_STALE_MS = 24 * 60 * 60 * 1000;

/** This daemon's dirs that hold files, marked by the heartbeat. */
const IN_USE = new Set<string>();
let heartbeat: ReturnType<typeof setInterval> | null = null;

/** Mark each of this daemon's dirs as in use, now; a dir gone since is forgotten. */
export function markOpencodeCredentialsInUse(now = Date.now()): void {
  for (const dir of IN_USE) {
    try {
      utimesSync(dir, now / 1000, now / 1000);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") IN_USE.delete(dir);
      else console.error(`[opencode-server] couldn't mark codeoid's opencode credentials in ${dir} as in use: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (IN_USE.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function markInUse(dir: string): void {
  IN_USE.add(dir);
  heartbeat ??= setInterval(() => markOpencodeCredentialsInUse(), OPENCODE_CREDENTIALS_HEARTBEAT_MS);
  heartbeat.unref?.();
}

/**
 * Is `dir` a real directory (not a symlink to one)? Files in it are
 * removed, so a link would point that at another tree. `false` when it
 * doesn't exist.
 */
function ownDir(dir: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new OpencodeCredentialError(`codeoid's opencode credentials dir ${JSON.stringify(dir)} is a symlink or not a directory: refusing to use it`);
  }
  return true;
}

/** Remove codeoid's credential files in `dir` but those in `keep`; nothing else, never a directory. */
function removeCredentialFiles(dir: string, keep?: ReadonlyMap<string, string>): void {
  for (const name of readdirSync(dir)) {
    if (keep?.has(name) || !isCredentialFile(name)) continue;
    const path = join(dir, name);
    try {
      if (lstatSync(path).isDirectory()) continue;
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Write the plan's files into `dir`, this daemon's dir in its credentials
 * root (both created 0700; each file 0600, written whole then renamed in),
 * and remove any credential file there the plan no longer has, so a key
 * removed from codeoid is gone from opencode's reach too.
 */
export function writeOpencodeCredentials(dir: string, secrets: ReadonlyMap<string, string>): void {
  for (const name of secrets.keys()) {
    if (!CREDENTIAL_FILE.test(name)) throw new OpencodeCredentialError(`codeoid doesn't write a credential file named ${JSON.stringify(name)}`);
  }
  const root = dirname(dir);
  if (!ownDir(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  if (!ownDir(dir)) mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [name, value] of secrets) {
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, value, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(dir, name));
  }
  removeCredentialFiles(dir, secrets);
  markInUse(dir);
}

/**
 * Remove codeoid's credential files in each of `dirs` (a daemon's dir in a
 * credentials root), and the dir once empty, when no server reads them:
 * when this daemon's server stops, dies or is refused, and a dead daemon's
 * at the start (`clearStaleOpencodeCredentials`). Each start writes them
 * again. Never throws: a dir it can't clear is logged.
 */
export function clearOpencodeCredentials(dirs: readonly string[]): void {
  for (const dir of dirs) {
    IN_USE.delete(dir);
    try {
      if (!ownDir(dir)) continue;
      removeCredentialFiles(dir);
      try {
        rmdirSync(dir);
      } catch {
        // Something that isn't codeoid's is in it: left, with the dir.
      }
    } catch (err) {
      console.error(`[opencode-server] couldn't clear codeoid's opencode credentials in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Does a process `pid` run (one of another user's counts)? */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * At the daemon's start, in each credentials root (`opencodeSecretLocations`:
 * whether or not opencode is enabled or found, and at a location a moved
 * dbPath left): clear the dirs of daemons that are gone. In this pid
 * namespace that's one whose process doesn't run, or that had this
 * process's pid before it. A pid from another namespace (a container, another
 * host sharing the home) can't be checked here, so its dir is gone only once
 * unmarked for `OPENCODE_CREDENTIALS_STALE_MS`. Another running daemon's dir
 * is left: its server may load a new location, and read its files again, at
 * any time. Never throws.
 */
export function clearStaleOpencodeCredentials(
  roots: readonly string[],
  opts: { self?: string; alive?: (pid: number) => boolean; now?: number } = {},
): void {
  const self = opts.self ?? OPENCODE_CREDENTIALS_PROCESS_DIR;
  const [, selfNamespace = OPENCODE_PID_NAMESPACE, selfPid] = PROCESS_DIR.exec(self) ?? [];
  const alive = opts.alive ?? processAlive;
  const now = opts.now ?? Date.now();
  for (const root of roots) {
    let names: string[];
    try {
      if (!ownDir(root)) continue;
      names = readdirSync(root);
    } catch (err) {
      console.error(`[opencode-server] couldn't clear codeoid's opencode credentials in ${root}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const name of names) {
      const m = PROCESS_DIR.exec(name);
      if (!m || name === self) continue;
      const [, namespace, pid] = m;
      const dir = join(root, name);
      const gone = namespace === selfNamespace ? pid === selfPid || !alive(Number(pid)) : unmarkedSince(dir) < now - OPENCODE_CREDENTIALS_STALE_MS;
      if (gone) clearOpencodeCredentials([dir]);
    }
  }
}

/** When `dir` was last marked in use (its mtime); +Infinity when it can't be read, so it isn't cleared. */
function unmarkedSince(dir: string): number {
  try {
    return lstatSync(dir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * What the server reads at each start, from codeoid's config, environment,
 * the Qwen backend's default account and cached model catalog, and the
 * endpoint store.
 */
export function opencodeCredentialInputs(
  config: CodeoidConfig | undefined,
  env: Record<string, string | undefined>,
  sources: {
    qwenCatalog?: () => ReadonlyArray<{ value: string; displayName?: string; contextWindow?: number }> | null;
    /** The Qwen backend's default account (`AccountStore.resolve("qwen", null)`); throws when it can't be used. */
    qwenAccount?: () => { account: { token?: string; baseUrl?: string } } | null;
    endpoints?: () => ReadonlyArray<OpencodeEndpointInput>;
  } = {},
): OpencodeCredentialInputs {
  let qwenModels: OpencodeCredentialInputs["qwenModels"] = [];
  let qwenAccount: OpencodeCredentialInputs["qwenAccount"] = null;
  try {
    const resolved = sources.qwenAccount?.() ?? null;
    if (resolved) qwenAccount = { token: resolved.account.token, baseUrl: resolved.account.baseUrl };
  } catch (err) {
    // Never the daemon's key instead: the account is what Qwen runs on.
    qwenAccount = { unusable: err instanceof Error ? err.message : String(err) };
  }
  let endpoints: ReadonlyArray<OpencodeEndpointInput> = [];
  try {
    qwenModels = (sources.qwenCatalog?.() ?? [])
      .filter((m) => m.value && m.value !== "default")
      .map((m) => ({ id: m.value, ...(m.displayName ? { name: m.displayName } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }));
  } catch {
    // An unreadable catalog: only the configured model.
  }
  try {
    endpoints = sources.endpoints?.() ?? [];
  } catch (err) {
    console.error(`[opencode-server] codeoid's endpoints couldn't be read for opencode: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { env, qwen: config?.providers?.qwen, qwenAccount, qwenModels, endpoints };
}
