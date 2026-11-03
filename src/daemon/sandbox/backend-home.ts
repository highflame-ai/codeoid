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
 *     ({@link PrivateHome.syncLogins}): that one file only, only when it
 *     parses as that backend's credential, only when the real one is still
 *     what was copied (nobody refreshed it meanwhile), atomically. Its other
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
   * what its content must be to be written back: a private copy inside,
   * the real file updated from it when the backend's process ends.
   */
  refreshable?: Readonly<Record<string, (text: string) => boolean>>;
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

export const CLAUDE_HOME_LAYOUT: BackendHomeLayout = {
  login: [".credentials.json"],
  refreshable: { ".credentials.json": claudeCredentials },
  shared: ["projects"],
  code: ["plugins", "skills", "agents", "commands", "hooks", "output-styles"],
  always: [".claude.json"],
};

export const CODEX_HOME_LAYOUT: BackendHomeLayout = {
  login: ["auth.json"],
  refreshable: { "auth.json": codexCredentials },
  shared: ["sessions", "archived_sessions"],
  code: ["skills", "prompts", "plugins"],
};

export const PI_HOME_LAYOUT: BackendHomeLayout = {
  login: ["auth.json"],
  refreshable: { "auth.json": piCredentials },
  shared: ["sessions"],
  code: ["extensions", "skills", "prompts", "themes", "tools", "agents", "bin"],
};

export const GEMINI_CLI_HOME_LAYOUT: BackendHomeLayout = {
  login: ["oauth_creds.json", "google_accounts.json", "gemini-credentials.json", ".env"],
  refreshable: { "oauth_creds.json": oauthCredentials },
  shared: ["tmp", "history"],
  code: ["extensions", "commands", "skills", "agents", "policies"],
};

export const QWEN_HOME_LAYOUT: BackendHomeLayout = {
  login: ["oauth_creds.json", ".env"],
  refreshable: { "oauth_creds.json": oauthCredentials },
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
   * comment); the names written. Run when the backend's process has ended
   * ({@link withLoginsSynced}); safe to run again.
   */
  syncLogins(): string[];
}

/** A refreshable login copied in: where it came from and what it held then. */
interface CopiedLogin {
  name: string;
  real: string;
  copy: string;
  held: string;
  valid: (text: string) => boolean;
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

function syncLogins(copied: CopiedLogin[]): string[] {
  const written: string[] = [];
  for (const c of copied) {
    // A regular file only (a link the backend left there leads anywhere).
    const now = readSmallFile(c.copy);
    if (now === null || now === c.held || !c.valid(now)) continue;
    // The real one must still be what was copied: a refresh someone else saved meanwhile isn't overwritten.
    if (readSmallFile(c.real) !== c.held) continue;
    const part = join(dirname(c.real), `.${basename(c.real)}.codeoid-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      writeFileSync(part, now, { mode: 0o600, flag: "wx" });
      renameSync(part, c.real);
    } catch {
      rmSync(part, { force: true });
      continue;
    }
    c.held = now;
    written.push(c.name);
  }
  return written;
}

/**
 * `handle`, whose close first writes the backend's refreshed logins back
 * ({@link PrivateHome.syncLogins}): each backend closes its handle when its
 * process has ended, or its query is replaced.
 */
export function withLoginsSynced(handle: SandboxHandle, home: Pick<PrivateHome, "syncLogins">): SandboxHandle {
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
          home.syncLogins();
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
          copied.push({ name, real, copy: join(target, name), held, valid: refresh });
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
