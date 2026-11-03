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
 *   - login files: linked to the real ones, shown read-only (a token it
 *     refreshes can't be saved from inside; the host's is read at the next
 *     start);
 *   - conversations (its sessions dir): linked to the real one, writable, so
 *     a session resumes across restarts and with the sandbox on or off. Data
 *     only: nothing in it is run;
 *   - code it loads (plugins, extensions, skills, commands): linked, shown
 *     read-only;
 *   - every other file up to {@link COPY_LIMIT}: copied (settings, model
 *     lists); what its commands change there is gone at the next start;
 *   - every other directory: made empty (caches, logs, state it rebuilds).
 *
 * The real home itself stays hidden (policy.ts hides the whole home).
 */

import { chmodSync, copyFileSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** How a backend's home is laid out (what of it is login, conversations, code). */
export interface BackendHomeLayout {
  /** Entries holding its login: shown read-only. */
  login: readonly string[];
  /** Directories holding its conversations: the real ones, writable (made in the real home when missing). */
  shared: readonly string[];
  /** Directories of code it loads: shown read-only. */
  code: readonly string[];
  /** Files copied whatever their size (Claude's `.claude.json`, which it can't start well without). */
  always?: readonly string[];
}

/** Larger files aren't copied (databases, logs): the backend starts without them. */
export const COPY_LIMIT = 1024 * 1024;

export const CLAUDE_HOME_LAYOUT: BackendHomeLayout = {
  login: [".credentials.json"],
  shared: ["projects"],
  code: ["plugins", "skills", "agents", "commands", "hooks", "output-styles"],
  always: [".claude.json"],
};

export const CODEX_HOME_LAYOUT: BackendHomeLayout = {
  login: ["auth.json"],
  shared: ["sessions", "archived_sessions"],
  code: ["skills", "prompts", "plugins"],
};

export const PI_HOME_LAYOUT: BackendHomeLayout = {
  login: ["auth.json"],
  shared: ["sessions"],
  code: ["extensions", "skills", "prompts", "themes", "tools", "agents", "bin"],
};

export const GEMINI_CLI_HOME_LAYOUT: BackendHomeLayout = {
  login: ["oauth_creds.json", "google_accounts.json", "gemini-credentials.json", ".env"],
  shared: ["tmp", "history"],
  code: ["extensions", "commands", "skills", "agents", "policies"],
};

export const QWEN_HOME_LAYOUT: BackendHomeLayout = {
  login: ["oauth_creds.json", ".env"],
  shared: ["projects", "tmp"],
  code: ["extensions", "commands", "skills", "agents"],
};

/** What a private home gives the backend's sandbox. */
export interface PrivateHome {
  /** The private home: point the backend at it. */
  home: string;
  /** Writable for the backend: the private home and the real conversations dirs it links to. */
  writable: string[];
  /** Read-only for the backend: its login and its code, where the links lead. */
  readable: string[];
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
 * `extraFiles`: files from elsewhere copied in under a name (Claude's
 * `~/.claude.json`, which the CLI reads from its config dir when one is set).
 */
export function preparePrivateHome(source: string, target: string, layout: BackendHomeLayout, extraFiles: Record<string, string> = {}): PrivateHome {
  const out: PrivateHome = { home: target, writable: [target], readable: [] };
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
    const real = join(source, name);
    // Where the backend would have put them without the sandbox: made there, so they outlive this home.
    try {
      mkdirSync(real, { recursive: true, mode: 0o700 });
    } catch {
      continue;
    }
    const at = realOr(real);
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
