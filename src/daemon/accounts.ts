/**
 * Accounts for every backend — named credentials per backend, a default per
 * backend, resolved per session per turn (protocol: accounts.ts; design:
 * docs/backend-accounts-design.md).
 *
 * Stored in `<configDir>/accounts.json`, 0600, written atomically, re-read
 * when it changes on disk. A login-kind account (a ChatGPT sign-in)
 * keeps its credential as the vendor's own files in the account's home,
 * `<configDir>/accounts/<backend>/<name>/` (0700); see account-homes.ts.
 *
 * Secrets never leave this module except into a request or a subprocess
 * environment; clients get `toAccountInfo`.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, getConfigDir } from "../config.js";
import {
  type AccountInfo,
  type AccountKind,
  accountKindsFor,
  type BackendAccountsInfo,
  DEFAULT_ACCOUNT,
  PI_KEY_VARIABLES,
} from "../protocol/types.js";

export interface StoredAccount {
  name: string;
  kind: AccountKind;
  token?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /**
   * Endpoint accounts: the origin (scheme, host, port) the credential was
   * entered for. It is only ever sent there — if the endpoint later moves to
   * another server, the account refuses to run until re-entered.
   */
  origin?: string;
  /** Bumped on every change of the credential — what tells a running session to restart on it. */
  generation: number;
  createdAt: string;
  updatedAt: string;
}

interface BackendEntry {
  defaultAccount?: string;
  accounts: StoredAccount[];
}

interface StoreFile {
  version: 2;
  backends: Record<string, BackendEntry>;
}

/** What `accounts.set` (and a finished sign-in) carries, minus transport fields. */
export interface AccountInput {
  backend: string;
  name: string;
  kind: AccountKind;
  token?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Endpoint accounts: the origin the endpoint has now (set by the daemon, never the caller). */
  origin?: string;
  /** Replace an existing account of that name; refused otherwise. */
  replace?: boolean;
}

/** A session's account for one backend, resolved for one turn. */
export interface ResolvedAccount {
  backend: string;
  name: string;
  kind: AccountKind;
  /** Changes when the credential does (not on the vendor's own token refresh). Never logged. */
  fingerprint: string;
  /** Daemon-internal: the stored credential. */
  account: StoredAccount;
  /** The account's home dir (process backends; may not exist yet). */
  home: string;
}

/** How long a removed account's home is kept aside before it is deleted. */
const TRASH_TTL_MS = 24 * 60 * 60_000;

export class AccountError extends Error {
  override name = "AccountError";
}

// ── Validation ────────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** RFC 7230 token characters — a header name can't carry a separator or a newline. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
/** Headers the HTTP client owns; setting them would break or smuggle the request. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "accept-encoding"]);
/** Kinds whose credential is the vendor's files in the account home, written by a sign-in. */
export const LOGIN_KINDS: ReadonlySet<AccountKind> = new Set(["chatgpt-login"]);

export function validateAccountName(name: string): void {
  if (name === DEFAULT_ACCOUNT) {
    throw new AccountError(`"${DEFAULT_ACCOUNT}" is the built-in account (the daemon's own environment) and can't be redefined`);
  }
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new AccountError("account names are 1-40 characters: lowercase letters, digits and '-', starting with a letter or digit");
  }
}

/** A backend that takes accounts at all, and that `kind` is one of its kinds. */
export function validateBackendKind(backend: string, kind: AccountKind): void {
  const kinds = accountKindsFor(backend);
  if (kinds.length === 0) throw new AccountError(`the ${backend} backend has no accounts`);
  if (!kinds.some((k) => k.kind === kind)) {
    throw new AccountError(`a ${backend} account is one of: ${kinds.map((k) => k.kind).join(", ")} — not ${JSON.stringify(kind)}`);
  }
}

function validateHeaders(headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(k)) throw new AccountError(`invalid header name: ${JSON.stringify(k)}`);
    if (RESERVED_HEADERS.has(k.toLowerCase())) throw new AccountError(`header ${k} is set by codeoid and can't be overridden`);
    // A CR/LF in a value would inject further headers into every request.
    if (typeof v !== "string" || CONTROL_CHARS.test(v)) throw new AccountError(`header ${k} has a line break or control character in its value`);
    if (!v) throw new AccountError(`header ${k} has no value`);
  }
}

/** A URL a token rides: https, or http to the local machine only; no credentials in it (it is shown). */
function validateSecretUrl(raw: string, what: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AccountError(`the ${what} isn't a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AccountError(`the ${what} must not carry credentials, a query string or a fragment — put a key in the token or a header`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AccountError(`the ${what} must be https (http only for localhost)`);
  }
}

/**
 * Validate a complete account for `backend` — on save, and on load (a hand
 * edit must not be applied unchecked). Throws AccountError.
 */
export function validateAccount(backend: string, a: Omit<StoredAccount, "generation" | "createdAt" | "updatedAt">): void {
  validateAccountName(a.name);
  validateBackendKind(backend, a.kind);
  const info = accountKindsFor(backend).find((k) => k.kind === a.kind)!;
  if (a.token !== undefined && (typeof a.token !== "string" || !a.token || CONTROL_CHARS.test(a.token))) {
    // Any control character: a NUL makes a spawn throw with the token in the
    // error text; a line break would inject a header.
    throw new AccountError("the token must be a single non-empty line with no control characters");
  }
  if (LOGIN_KINDS.has(a.kind)) {
    if (a.token !== undefined || a.baseUrl || a.headers || a.env) {
      throw new AccountError(`a ${a.kind} account holds no typed-in credential — sign in to create it`);
    }
    return;
  }
  if (info.token?.required && a.token === undefined) throw new AccountError(`a ${backend} ${a.kind} account needs its ${info.token.label.toLowerCase()}`);
  if (!info.token && a.token !== undefined) throw new AccountError(`a ${backend} ${a.kind} account takes no token`);

  if (a.baseUrl !== undefined) {
    if (!info.baseUrl) throw new AccountError(`a ${backend} ${a.kind} account has no base URL`);
    const preset = info.baseUrl.presets?.some((p) => p.value === a.baseUrl);
    if (!preset) validateSecretUrl(a.baseUrl, "base URL");
  } else if (info.baseUrl?.required) {
    throw new AccountError(`a ${backend} ${a.kind} account needs its ${info.baseUrl.label.toLowerCase()}`);
  }

  if (a.headers !== undefined) {
    if (!info.headers) throw new AccountError(`a ${backend} ${a.kind} account has no extra headers`);
    validateHeaders(a.headers);
  }

  if (a.env !== undefined) {
    if (!info.env) throw new AccountError(`a ${backend} ${a.kind} account sets no key variables`);
    const allowed = new Set(info.env.names);
    const names = Object.keys(a.env);
    if (names.length === 0 && info.env.required !== false) throw new AccountError("set at least one key");
    for (const [k, v] of Object.entries(a.env)) {
      if (!allowed.has(k)) throw new AccountError(`${k} is not a key this backend reads — one of ${info.env.names.join(", ")}`);
      if (typeof v !== "string" || !v || CONTROL_CHARS.test(v)) throw new AccountError(`${k} must be a single non-empty line`);
    }
  } else if (info.env && info.env.required !== false) {
    throw new AccountError("set at least one key");
  }

  // A Bedrock account's telemetry headers usually carry a key of their own:
  // they go to the telemetry endpoint, so it gets the base URL's rules.
  if (backend === "claude" && a.kind === "bedrock" && a.env?.OTEL_EXPORTER_OTLP_HEADERS && a.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    validateSecretUrl(a.env.OTEL_EXPORTER_OTLP_ENDPOINT, "telemetry endpoint");
  }

  if (backend.startsWith("oai:")) {
    if (a.token === undefined && Object.keys(a.headers ?? {}).length === 0) {
      throw new AccountError("an endpoint account needs a key or at least one header");
    }
    if (a.token !== undefined && Object.keys(a.headers ?? {}).some((h) => h.toLowerCase() === "authorization")) {
      throw new AccountError("set either an API key or an Authorization header, not both");
    }
    if (!a.origin) throw new AccountError("an endpoint account must record the server it was entered for");
  }
}

/** The client-safe view: no token, key or header value. */
export function toAccountInfo(backend: string, a: StoredAccount): AccountInfo {
  return {
    backend,
    name: a.name,
    kind: a.kind,
    ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
    ...(a.headers && Object.keys(a.headers).length > 0 ? { headerNames: Object.keys(a.headers).sort() } : {}),
    ...(a.env && Object.keys(a.env).length > 0 ? { envNames: Object.keys(a.env).sort() } : {}),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function fingerprintOf(backend: string, a: StoredAccount): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        backend,
        a.name,
        a.kind,
        a.generation,
        a.token ?? "",
        a.baseUrl ?? "",
        Object.entries(a.headers ?? {}).sort(),
        Object.entries(a.env ?? {}).sort(),
        a.origin ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** `<configDir>/accounts/<backend>/<name>` — a home for an account of a process backend. */
export function accountHomePath(root: string, backend: string, name: string): string {
  // Backend ids that reach here are plain (`codex`, `gemini-cli`, `pi`); an
  // endpoint id's colon is mapped anyway so no id can name a path outside.
  return join(root, backend.replace(/[^a-z0-9-]/g, "_"), name);
}

// ── Store ─────────────────────────────────────────────────────────────────────

export type AccountsListener = (backend: string) => void;

export class AccountStore {
  readonly #path: string;
  readonly #homesRoot: string;
  /** `claude-accounts.json`, imported as the `claude` backend when this store is new. */
  readonly #legacyClaudePath: string | null;
  /** Written when the legacy file has been imported — it is never imported again. */
  readonly #importMarker: string;
  #data: StoreFile | null = null;
  #mtimeMs: number | null = null;
  /** Backends in the last successful read; null before the first. */
  #seenBackends: Set<string> | null = null;
  /**
   * The legacy claude-accounts.json couldn't be read at import: Claude
   * accounts and its default are unknown, so Claude fails closed — and only
   * Claude, never every backend.
   */
  #legacyUnreadable = false;
  readonly #listeners = new Set<AccountsListener>();

  constructor(opts: { path?: string; homesRoot?: string; legacyClaudePath?: string | null } = {}) {
    const dir = getConfigDir();
    this.#path = opts.path ?? join(dir, "accounts.json");
    this.#homesRoot = opts.homesRoot ?? join(dir, "accounts");
    this.#legacyClaudePath = opts.legacyClaudePath === undefined ? join(dir, "claude-accounts.json") : opts.legacyClaudePath;
    this.#importMarker = `${this.#path}.claude-imported`;
    this.#sweepTrash();
  }

  /** Called after every change, with the backend it touched. */
  onChange(listener: AccountsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #fileMtime(): number {
    try {
      return statSync(this.#path).mtimeMs;
    } catch {
      return -1;
    }
  }

  #load(): StoreFile {
    const mtime = this.#fileMtime();
    if (this.#data && mtime === this.#mtimeMs) return this.#data;
    // The backends known before this read — kept across a failed parse, so a
    // file that was broken and is now fixed still tells the sessions.
    const before = this.#seenBackends;
    this.#data = mtime === -1 ? this.#imported() : this.#read();
    // Re-stat: an import has just written the file.
    this.#mtimeMs = this.#fileMtime();
    const now = new Set(Object.keys(this.#data.backends));
    this.#seenBackends = now;
    // Every backend that was or is in the file: one deleted by hand (or the
    // whole file) has sessions to tell as much as one that was edited.
    if (before !== null) for (const backend of new Set([...before, ...now])) this.#notify(backend);
    return this.#data;
  }

  #read(): StoreFile {
    let parsed: { backends?: unknown };
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8")) as { backends?: unknown };
    } catch {
      // Fail closed (a default may name an account we can no longer read), and
      // not the parser's message: it can quote a slice of the file — a token.
      this.#data = null;
      throw new AccountError(`${this.#path} is not valid JSON — fix it (removing it signs every session out of its named account)`);
    }
    const backends: Record<string, BackendEntry> = {};
    const raw = parsed.backends && typeof parsed.backends === "object" ? (parsed.backends as Record<string, Partial<BackendEntry>>) : {};
    for (const [backend, entry] of Object.entries(raw)) {
      const accounts: StoredAccount[] = [];
      for (const a of Array.isArray(entry?.accounts) ? entry.accounts : []) {
        try {
          if (accounts.some((x) => x.name === (a as StoredAccount).name)) throw new AccountError(`"${(a as StoredAccount).name}" is listed twice`);
          validateAccount(backend, a as StoredAccount);
          accounts.push({ ...(a as StoredAccount), generation: Number((a as StoredAccount).generation) || 1 });
        } catch (err) {
          console.error(`[codeoid] ignoring invalid ${backend} account in ${this.#path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      backends[backend] = {
        accounts,
        ...(typeof entry?.defaultAccount === "string" ? { defaultAccount: entry.defaultAccount } : {}),
      };
    }
    return { version: 2, backends };
  }

  /**
   * A new store: the Claude accounts of `claude-accounts.json` (#392) become
   * the `claude` backend's. The old file is left as it was, so a daemon rolled
   * back still finds its accounts; this one never writes it again.
   */
  #imported(): StoreFile {
    const data: StoreFile = { version: 2, backends: {} };
    if (!this.#legacyClaudePath || !existsSync(this.#legacyClaudePath)) return data;
    // Once only: a store that existed and was deleted ("fix or remove it")
    // must not bring back accounts removed since the import.
    if (existsSync(this.#importMarker)) return data;
    let parsed: { defaultAccount?: unknown; accounts?: unknown };
    try {
      parsed = JSON.parse(readFileSync(this.#legacyClaudePath, "utf8")) as typeof parsed;
    } catch {
      // Nothing written and no marker: once the file is fixed, the next start imports it.
      if (!this.#legacyUnreadable) console.error(`[codeoid] ${this.#legacyClaudePath} is not valid JSON — Claude accounts are unavailable until it's fixed`);
      this.#legacyUnreadable = true;
      return data;
    }
    this.#legacyUnreadable = false;
    const accounts: StoredAccount[] = [];
    for (const a of Array.isArray(parsed.accounts) ? parsed.accounts : []) {
      try {
        const stored = { ...(a as StoredAccount), generation: 1 };
        validateAccount("claude", stored);
        accounts.push(stored);
      } catch (err) {
        console.error(`[codeoid] not importing invalid Claude account from ${this.#legacyClaudePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (accounts.length > 0 || typeof parsed.defaultAccount === "string") {
      data.backends.claude = {
        accounts,
        ...(typeof parsed.defaultAccount === "string" ? { defaultAccount: parsed.defaultAccount } : {}),
      };
    }
    // Persist now, and mark it done, so the import happens once.
    this.#write(data);
    atomicWrite(this.#importMarker, `${new Date().toISOString()}\n`, 0o600);
    return data;
  }

  #write(data: StoreFile): void {
    atomicWrite(this.#path, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    this.#data = data;
    this.#seenBackends = new Set([...(this.#seenBackends ?? []), ...Object.keys(data.backends)]);
    this.#mtimeMs = this.#fileMtime();
  }

  #save(data: StoreFile, backend: string): void {
    this.#write(data);
    this.#notify(backend);
  }

  #notify(backend: string): void {
    for (const l of this.#listeners) {
      try {
        l(backend);
      } catch (err) {
        console.error(`[codeoid] account change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  #entry(backend: string): BackendEntry {
    return this.#load().backends[backend] ?? { accounts: [] };
  }

  /** The home an account of a process backend runs in (may not exist yet). */
  homeOf(backend: string, name: string): string {
    return accountHomePath(this.#homesRoot, backend, name);
  }

  /** Root of every account home — for the secret-path guard. */
  get homesRoot(): string {
    return this.#homesRoot;
  }

  list(backend: string): AccountInfo[] {
    return this.#entry(backend).accounts.map((a) => toAccountInfo(backend, a)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every backend with accounts or a default set. */
  backendsWithData(): string[] {
    return Object.keys(this.#load().backends);
  }

  /** Daemon-internal: the stored credential. */
  get(backend: string, name: string): StoredAccount | undefined {
    return this.#entry(backend).accounts.find((a) => a.name === name);
  }

  has(backend: string, name: string): boolean {
    return name === DEFAULT_ACCOUNT || this.get(backend, name) !== undefined;
  }

  /** `backend`'s daemon default — `default` when none is set. */
  getDefault(backend: string): string {
    return this.#entry(backend).defaultAccount ?? DEFAULT_ACCOUNT;
  }

  summary(backend: string, displayName: string): BackendAccountsInfo {
    return { backend, displayName, defaultAccount: this.getDefault(backend), accounts: this.list(backend), kinds: accountKindsFor(backend) };
  }

  /**
   * Add an account, or replace it with `replace`. A replaced credential gets
   * a new generation, so sessions on it restart on it at their next turn.
   */
  upsert(input: AccountInput): AccountInfo {
    const data = this.#load();
    const entry = data.backends[input.backend] ?? { accounts: [] };
    const prev = entry.accounts.find((a) => a.name === input.name);
    if (prev && !input.replace) {
      throw new AccountError(`a ${input.backend} account named "${input.name}" already exists — replace it explicitly, or pick another name`);
    }
    const now = new Date().toISOString();
    const next: StoredAccount = {
      name: input.name,
      kind: input.kind,
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: { ...input.headers } } : {}),
      ...(input.env && Object.keys(input.env).length > 0 ? { env: { ...input.env } } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      generation: (prev?.generation ?? 0) + 1,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    validateAccount(input.backend, next);
    const accounts = [...entry.accounts.filter((a) => a.name !== input.name), next];
    this.#save({ ...data, backends: { ...data.backends, [input.backend]: { ...entry, accounts } } }, input.backend);
    return toAccountInfo(input.backend, next);
  }

  /**
   * Remove an account and its home. The backend's default can't be removed:
   * its followers would quietly fall back to the daemon's own credential —
   * set another default first.
   */
  remove(backend: string, name: string): boolean {
    const data = this.#load();
    const entry = data.backends[backend];
    if (!entry?.accounts.some((a) => a.name === name)) return false;
    if (entry.defaultAccount === name) {
      throw new AccountError(`"${name}" is the ${backend} default — set another default (or "default") first, so the sessions following it don't move to another credential`);
    }
    const { defaultAccount, ...rest } = entry;
    this.#save(
      {
        ...data,
        backends: {
          ...data.backends,
          [backend]: {
            ...rest,
            accounts: entry.accounts.filter((a) => a.name !== name),
            ...(defaultAccount && defaultAccount !== name ? { defaultAccount } : {}),
          },
        },
      },
      backend,
    );
    this.#discardHome(backend, name);
    return true;
  }

  /**
   * Move an account's home aside instead of deleting it: a busy session's
   * process may still be running in it (its token refresh, its session file).
   * Swept once old enough that no turn can still be using it.
   */
  #discardHome(backend: string, name: string): void {
    const home = this.homeOf(backend, name);
    if (!existsSync(home)) return;
    const trash = join(this.#homesRoot, ".trash");
    try {
      mkdirSync(trash, { recursive: true, mode: 0o700 });
      renameSync(home, join(trash, `${Date.now()}-${randomBytes(4).toString("hex")}`));
    } catch {
      rmSync(home, { recursive: true, force: true });
    }
  }

  /** Remove trashed homes older than a day. */
  #sweepTrash(): void {
    const trash = join(this.#homesRoot, ".trash");
    let names: string[];
    try {
      names = readdirSync(trash);
    } catch {
      return;
    }
    const cutoff = Date.now() - TRASH_TTL_MS;
    for (const n of names) {
      const at = Number(n.split("-")[0]);
      if (Number.isFinite(at) && at < cutoff) rmSync(join(trash, n), { recursive: true, force: true });
    }
  }

  /** Remove every account of `backend` (an endpoint was removed). */
  removeBackend(backend: string): void {
    const data = this.#load();
    if (!data.backends[backend]) return;
    const { [backend]: gone, ...backends } = data.backends;
    this.#save({ ...data, backends }, backend);
    for (const a of gone?.accounts ?? []) this.#discardHome(backend, a.name);
  }

  setDefault(backend: string, name: string): void {
    if (!this.has(backend, name)) throw new AccountError(`no ${backend} account named ${JSON.stringify(name)}`);
    const data = this.#load();
    const { defaultAccount: _old, ...entry } = data.backends[backend] ?? { accounts: [] };
    const next = name === DEFAULT_ACCOUNT ? entry : { ...entry, defaultAccount: name };
    this.#save({ ...data, backends: { ...data.backends, [backend]: next } }, backend);
  }

  /**
   * The account a session runs on for `backend`: its choice, else the
   * backend default. `null` = the built-in account (the daemon's own
   * environment). A choice naming an account that no longer exists THROWS —
   * falling back would run the session on a credential nobody picked.
   */
  resolve(backend: string, choice: string | null): ResolvedAccount | null {
    this.#load();
    if (backend === "claude" && this.#legacyUnreadable && choice !== DEFAULT_ACCOUNT) {
      throw new AccountError(`${this.#legacyClaudePath} is not valid JSON — fix it; Claude accounts are unavailable until then`);
    }
    const name = choice ?? this.getDefault(backend);
    if (name === DEFAULT_ACCOUNT) return null;
    const account = this.get(backend, name);
    if (!account) {
      throw new AccountError(
        `the ${backend} account "${name}" no longer exists — choose another for this session (codeoid account use <session> <account> --backend ${backend})`,
      );
    }
    return { backend, name, kind: account.kind, fingerprint: fingerprintOf(backend, account), account, home: this.homeOf(backend, name) };
  }
}

/** Key variables pi reads, for the env allowlist of a pi child. */
export const PI_ACCOUNT_VARIABLES: readonly string[] = PI_KEY_VARIABLES;
