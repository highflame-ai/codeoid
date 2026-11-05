/**
 * A backend's own home inside the sandbox (#448), when its whole process runs
 * there (`process` confinement: pi, the Gemini CLI, Qwen, Claude and Codex
 * under Docker or Seatbelt; Codex's app-server under bubblewrap).
 *
 * Its commands run as it does, so whatever it can write they can. Its real
 * home holds what later runs outside any sandbox — settings with hooks, MCP
 * servers, extensions, `config.toml` — read by the user's own CLI and by the
 * same backend in a session whose sandbox is off. So the backend never gets
 * that home writable. It gets a private one, made afresh at each start
 * (SandboxRuntime.privateHome), pointed at by the variable it reads its home
 * from:
 *
 *   - its login: the credential file it refreshes ({@link BackendHomeLayout.refreshable})
 *     a private copy (0600), so a refresh is saved however the CLI writes it,
 *     and written back to the real file when the backend's process ends
 *     ({@link PrivateHome.syncLogins}): that one file only, and of it only
 *     the token fields a refresh writes, into the real file's own content
 *     ({@link refreshedLogin}: a copy changed anywhere else — an entry added,
 *     an api key, a URL — is refused and said so), only when the real one is
 *     still what was copied (nobody refreshed it meanwhile), atomically. Its other
 *     login files (an `.env`, an account list) linked, read-only;
 *   - conversations (its sessions dir; the Gemini CLI's `tmp/` and its
 *     checkpoint git repository `history/`): the session's own, never the
 *     real ones — linked to a dir of the session's that outlives this home
 *     (SandboxRuntime.stateDir: a session resumes across restarts), removed
 *     with the session. The real dirs hold every project's transcripts, and
 *     what later runs load from them (Claude's project memory, the Gemini
 *     CLI's checkpoint repository, whose git config and hooks run), so no
 *     sandboxed session reads another's or writes what an unsandboxed run
 *     loads;
 *   - code it loads (plugins, extensions, skills, commands): linked, shown
 *     read-only;
 *   - every other file up to {@link COPY_LIMIT}: copied (settings, model
 *     lists); what its commands change there is gone at the next start;
 *   - every other directory: made empty (caches, logs, state it rebuilds).
 *
 * The real home itself stays hidden (policy.ts hides the whole home).
 */

import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SandboxHandle } from "./types.js";

/** How a backend's home is laid out (what of it is login, conversations, code). */
export interface BackendHomeLayout {
  /** Entries holding its login: shown read-only. */
  login: readonly string[];
  /** Directories holding its conversations: the session's own (made empty, or linked to its state dir), writable. */
  shared: readonly string[];
  /** Directories of code it loads: shown read-only. */
  code: readonly string[];
  /** Files copied whatever their size (Claude's `.claude.json`, which it can't start well without). */
  always?: readonly string[];
  /**
   * Login files the backend refreshes in place (an OAuth token), each with
   * what a refresh may change in it ({@link LoginRefresh}): a private copy
   * inside, the real file updated from it when the backend's process ends.
   */
  refreshable?: Readonly<Record<string, LoginRefresh>>;
}

/**
 * What a refresh of one login file may change. The copy's commands could
 * write anything there, and the real file is read later by the backend run
 * outside any sandbox (the user's own CLI, a session with its sandbox off),
 * some of whose fields it runs or follows (pi runs an api key starting with
 * `!` as a command; a Qwen `resource_url` or an MCP server's `serverUrl` is
 * where its token is sent). So only the token fields of entries the real
 * file already had are taken from the copy, each a plain token value; every
 * other field must be as it was.
 */
export interface LoginRefresh {
  /** Its format (a credential of that backend at all). */
  valid: (text: string) => boolean;
  /** Where a refresh writes: dotted paths, `*` any key of an object. */
  tokens: readonly string[];
  /** A `*` at the top matches only entries whose `type` is this (pi: `oauth`, never an `api_key` entry). */
  entryType?: string;
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Claude Code's `.credentials.json`: `{ claudeAiOauth: { accessToken, refreshToken, … } }`. */
export function claudeCredentials(text: string): boolean {
  const o = jsonObject(text)?.claudeAiOauth;
  return obj(o) && str(o.accessToken) && str(o.refreshToken);
}

/** Codex's `auth.json`: its ChatGPT tokens (`tokens.access_token`, `refresh_token`) or an API key. */
export function codexCredentials(text: string): boolean {
  const o = jsonObject(text);
  if (!o) return false;
  const t = o.tokens;
  return (obj(t) && str(t.access_token) && str(t.refresh_token)) || str(o.OPENAI_API_KEY);
}

/** pi's `auth.json`: one entry per provider, each an object with its `type`. */
export function piCredentials(text: string): boolean {
  const o = jsonObject(text);
  if (!o) return false;
  const entries = Object.values(o);
  return entries.length > 0 && entries.every((e) => obj(e) && str(e.type));
}

/** A Google- or Qwen-style OAuth file (`oauth_creds.json`): `access_token` and `refresh_token`. */
export function oauthCredentials(text: string): boolean {
  const o = jsonObject(text);
  return !!o && str(o.access_token) && str(o.refresh_token);
}

/** Larger files aren't copied (databases, logs): the backend starts without them. */
export const COPY_LIMIT = 1024 * 1024;

/** A value a token refresh writes: an opaque token, a time, a scope list. Never a command, path or URL. */
function tokenValue(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return /^[A-Za-z0-9._~+/=:-]{1,16384}$/.test(v) && !v.includes("://");
  if (Array.isArray(v)) return v.length <= 64 && v.every((s) => typeof s === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(s));
  return false;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!obj(a) || !obj(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/** The first place `b` differs from `a`, said (for the refusal). */
function firstDifference(a: unknown, b: unknown, at: string[] = []): string {
  if (obj(a) && obj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const path = [...at, k].join(".");
      if (!Object.hasOwn(a, k)) return `${path} was added`;
      if (!Object.hasOwn(b, k)) return `${path} was removed`;
      if (!same(a[k], b[k])) return firstDifference(a[k], b[k], [...at, k]);
    }
  }
  return `${at.join(".") || "the file"} changed`;
}

/** The concrete paths `pattern` names among `held`'s and `now`'s keys, where `held` has the object holding it. */
function tokenPaths(pattern: readonly string[], held: unknown, now: unknown, entryType: string | undefined, at: string[] = []): string[][] {
  if (pattern.length === 0) return [at];
  if (!obj(held)) return [];
  const [head, ...rest] = pattern as [string, ...string[]];
  if (rest.length === 0) {
    const keys = head === "*" ? new Set([...Object.keys(held), ...(obj(now) ? Object.keys(now) : [])]) : [head];
    return [...keys].map((k) => [...at, k]);
  }
  const keys = head === "*" ? Object.keys(held) : Object.hasOwn(held, head) ? [head] : [];
  return keys.flatMap((k) => {
    if (head === "*" && at.length === 0 && entryType !== undefined && (!obj(held[k]) || held[k].type !== entryType)) return [];
    return tokenPaths(rest, held[k], obj(now) ? now[k] : undefined, entryType, [...at, k]);
  });
}

function getAt(o: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let cur: unknown = o;
  for (const k of path) {
    if (!obj(cur) || !Object.hasOwn(cur, k)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

/**
 * The real login file's new text after a refresh saved to the copy: `held`
 * (what the real one held when copied) with only `rule`'s token fields taken
 * from `now`, in `held`'s own layout. Refused (and why) when the copy isn't
 * that backend's credential, or differs from `held` anywhere else: an entry
 * added, removed or of another type, any other field changed, or a token
 * field holding what isn't a plain token value.
 */
export function refreshedLogin(held: string, now: string, rule: LoginRefresh): { text: string } | { refused: string } {
  const h = jsonObject(held);
  const n = jsonObject(now);
  if (!h || !n || !rule.valid(now)) return { refused: "it is no longer that backend's credential file" };
  const out = structuredClone(h);
  for (const pattern of rule.tokens) {
    for (const path of tokenPaths(pattern.split("."), h, n, rule.entryType)) {
      const was = getAt(h, path);
      const is = getAt(n, path);
      if (!is.found) continue;
      if (was.found && same(was.value, is.value)) continue;
      if (!tokenValue(is.value)) return { refused: `${path.join(".")} isn't a token value` };
      const parent = getAt(out, path.slice(0, -1));
      if (!parent.found || !obj(parent.value)) continue;
      parent.value[path[path.length - 1] as string] = is.value;
    }
  }
  if (!same(out, n)) return { refused: `${firstDifference(out, n)}, which a token refresh never does` };
  const indent = /^\{\r?\n([ \t]+)"/.exec(held)?.[1] ?? "";
  return { text: `${JSON.stringify(out, null, indent || undefined)}${held.endsWith("\n") ? "\n" : ""}` };
}

export const CLAUDE_HOME_LAYOUT: BackendHomeLayout = {
  login: [".credentials.json"],
  refreshable: {
    ".credentials.json": {
      valid: claudeCredentials,
      tokens: [
        "claudeAiOauth.accessToken",
        "claudeAiOauth.refreshToken",
        "claudeAiOauth.expiresAt",
        "claudeAiOauth.scopes",
        "claudeAiOauth.subscriptionType",
        "claudeAiOauth.rateLimitTier",
        "mcpOAuth.*.accessToken",
        "mcpOAuth.*.refreshToken",
        "mcpOAuth.*.expiresAt",
      ],
    },
  },
  shared: ["projects"],
  code: ["plugins", "skills", "agents", "commands", "hooks", "output-styles"],
  always: [".claude.json"],
};

export const CODEX_HOME_LAYOUT: BackendHomeLayout = {
  login: ["auth.json"],
  refreshable: { "auth.json": { valid: codexCredentials, tokens: ["tokens.id_token", "tokens.access_token", "tokens.refresh_token", "last_refresh"] } },
  shared: ["sessions", "archived_sessions"],
  code: ["skills", "prompts", "plugins"],
};

export const PI_HOME_LAYOUT: BackendHomeLayout = {
  login: ["auth.json"],
  refreshable: { "auth.json": { valid: piCredentials, tokens: ["*.access", "*.refresh", "*.expires"], entryType: "oauth" } },
  shared: ["sessions"],
  code: ["extensions", "skills", "prompts", "themes", "tools", "agents", "bin"],
};

export const GEMINI_CLI_HOME_LAYOUT: BackendHomeLayout = {
  login: ["oauth_creds.json", "google_accounts.json", "gemini-credentials.json", ".env"],
  refreshable: { "oauth_creds.json": { valid: oauthCredentials, tokens: ["access_token", "refresh_token", "id_token", "expiry_date", "scope", "token_type"] } },
  shared: ["tmp", "history"],
  code: ["extensions", "commands", "skills", "agents", "policies"],
};

export const QWEN_HOME_LAYOUT: BackendHomeLayout = {
  login: ["oauth_creds.json", ".env"],
  refreshable: { "oauth_creds.json": { valid: oauthCredentials, tokens: ["access_token", "refresh_token", "id_token", "expiry_date", "token_type"] } },
  shared: ["projects", "tmp"],
  code: ["extensions", "commands", "skills", "agents"],
};

/** What a private home gives the backend's sandbox. */
export interface PrivateHome {
  /** The private home: point the backend at it. */
  home: string;
  /** Writable for the backend: the private home and the session's conversations dirs it links to. */
  writable: string[];
  /** Read-only for the backend: its login and its code, where the links lead. */
  readable: string[];
  /**
   * Write each refreshed login back to its real file (see the module's
   * comment): the names written, and those refused with why (the real
   * login is kept). Run when the backend's process has ended
   * ({@link withLoginsSynced}); safe to run again.
   */
  syncLogins(): LoginSync;
}

/** What a write-back did. */
export interface LoginSync {
  written: string[];
  /** A copy changed beyond a token refresh ({@link refreshedLogin}): not written back. */
  refused: Array<{ name: string; reason: string }>;
}

/** A refreshable login copied in: where it came from and what it held then. */
interface CopiedLogin {
  name: string;
  real: string;
  copy: string;
  /** What the real file holds (as copied, or as last written back). */
  held: string;
  /** The copy as last judged: unchanged since, nothing to do. */
  judged: string;
  rule: LoginRefresh;
}

/** Larger isn't a login. */
const LOGIN_LIMIT = 256 * 1024;

function readSmallFile(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > LOGIN_LIMIT) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function syncLogins(copied: CopiedLogin[]): LoginSync {
  const out: LoginSync = { written: [], refused: [] };
  for (const c of copied) {
    // A regular file only (a link the backend left there leads anywhere).
    const now = readSmallFile(c.copy);
    if (now === null || now === c.judged) continue;
    const merged = refreshedLogin(c.held, now, c.rule);
    if ("refused" in merged) {
      out.refused.push({ name: c.name, reason: merged.refused });
      continue;
    }
    c.judged = now;
    if (merged.text === c.held) continue;
    // The real one must still be what was copied: a refresh someone else saved meanwhile isn't overwritten.
    if (readSmallFile(c.real) !== c.held) continue;
    const part = join(dirname(c.real), `.${basename(c.real)}.codeoid-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      writeFileSync(part, merged.text, { mode: 0o600, flag: "wx" });
      renameSync(part, c.real);
    } catch {
      rmSync(part, { force: true });
      continue;
    }
    c.held = merged.text;
    out.written.push(c.name);
  }
  return out;
}

/**
 * `handle`, whose close first writes the backend's refreshed logins back
 * ({@link PrivateHome.syncLogins}): each backend closes its handle when its
 * process has ended, or its query is replaced. `warn`: told of a login not
 * written back because its copy changed beyond a refresh (a session's
 * warning line).
 */
export function withLoginsSynced(handle: SandboxHandle, home: Pick<PrivateHome, "syncLogins">, warn?: (text: string) => void): SandboxHandle {
  let synced = false;
  return {
    get providerId() {
      return handle.providerId;
    },
    get spec() {
      return handle.spec;
    },
    spawn: (command, args, opts) => handle.spawn(command, args, opts),
    exec: (argv, opts) => handle.exec(argv, opts),
    ...(handle.wrap ? { wrap: handle.wrap.bind(handle) } : {}),
    close: async () => {
      if (!synced) {
        synced = true;
        try {
          for (const r of home.syncLogins().refused) {
            const text = `The backend's login (${r.name}) was not saved back from its sandbox: ${r.reason}. Your own login is unchanged; sign in again if this session's refreshed token is needed.`;
            console.warn(`[codeoid/sandbox] ${text}`);
            warn?.(text);
          }
        } catch {
          /* the login stays as it was: the next start reads the real one */
        }
      }
      await handle.close();
    },
  };
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Fill `target` (fresh and empty: SandboxRuntime.privateHome) from `source`
 * (the home the backend would use: the vendor's, an account's or an effort
 * overlay's, whose entries may be links into the vendor's) per `layout`.
 * `state`: the session's own dir its conversations live in across starts
 * (SandboxRuntime.stateDir); without one they are empty and go with this
 * home. `extraFiles`: files from elsewhere copied in under a name (Claude's
 * `~/.claude.json`, which the CLI reads from its config dir when one is set).
 */
export function preparePrivateHome(
  source: string,
  target: string,
  layout: BackendHomeLayout,
  opts: { state?: string; extraFiles?: Record<string, string> } = {},
): PrivateHome {
  const extraFiles = opts.extraFiles ?? {};
  const copied: CopiedLogin[] = [];
  const out: PrivateHome = { home: target, writable: [target], readable: [], syncLogins: () => syncLogins(copied) };
  const link = (name: string, to: string) => {
    try {
      symlinkSync(to, join(target, name));
    } catch {
      /* one of the same name already (a layout listing it twice) */
    }
  };
  const login = new Set(layout.login);
  const shared = new Set(layout.shared);
  const code = new Set(layout.code);
  for (const name of shared) {
    if (!opts.state) {
      // Nowhere to keep them: empty, and gone with this home.
      copyEntryDir(join(target, name));
      continue;
    }
    const own = join(opts.state, name);
    try {
      mkdirSync(own, { recursive: true, mode: 0o700 });
    } catch {
      continue;
    }
    const at = realOr(own);
    link(name, at);
    out.writable.push(at);
  }
  let names: string[] = [];
  try {
    names = readdirSync(source);
  } catch {
    // No home yet: the backend starts from nothing but what is shared.
  }
  for (const name of names) {
    if (shared.has(name)) continue;
    const from = join(source, name);
    const refresh = layout.refreshable?.[name];
    if (refresh) {
      // A private copy it may save a refresh to; written back when its process ends.
      const real = realOr(from);
      const held = readSmallFile(real);
      if (held !== null) {
        try {
          writeFileSync(join(target, name), held, { mode: 0o600, flag: "wx" });
          copied.push({ name, real, copy: join(target, name), held, judged: held, rule: refresh });
          continue;
        } catch {
          /* not copied: linked read-only below */
        }
      }
    }
    if (login.has(name) || code.has(name)) {
      const at = realOr(from);
      link(name, at);
      out.readable.push(at);
      continue;
    }
    copyEntry(from, join(target, name), { anySize: layout.always?.includes(name) === true });
  }
  for (const [name, from] of Object.entries(extraFiles)) copyEntry(from, join(target, name), { fileOnly: true, anySize: true });
  return out;
}

function copyEntryDir(to: string): void {
  try {
    mkdirSync(to, { mode: 0o700 });
  } catch {
    /* there already */
  }
}

/** A small file copied (0600), a directory made empty, anything else left out. */
function copyEntry(from: string, to: string, o: { fileOnly?: boolean; anySize?: boolean } = {}): void {
  let st: ReturnType<typeof statSync>;
  try {
    // Through a link: an overlay's entries are links to the vendor's.
    st = statSync(from);
  } catch {
    return;
  }
  try {
    if (st.isFile()) {
      if (st.size > COPY_LIMIT && !o.anySize) return;
      copyFileSync(from, to);
      // A copy is the backend's own: private.
      chmodSync(to, 0o600);
    } else if (st.isDirectory() && !o.fileOnly) {
      mkdirSync(to, { mode: 0o700 });
    }
  } catch {
    /* unreadable: the backend starts without it */
  }
}
