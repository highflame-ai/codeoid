/**
 * Paths no agent tool call may touch unasked: the daemon's own credential
 * files, the agent CLIs' stored logins, and a process's environment / memory.
 *
 * WHY. `Read`, `Grep` and `Glob` run unprompted in guarded and autonomous mode
 * (tool-safety.ts), with no path limit. The credentials live in files owned by
 * the same user the agent runs as — codeoid's `.env`, `config.json` (the
 * ZeroID key), `claude-accounts.json` (every stored Claude subscription,
 * gateway and API-key token), `endpoints.json` (OpenAI-compatible endpoint
 * keys), `codeoid.db` (MCP OAuth tokens), the local-mode
 * token, each CLI's own login (`~/.claude/.credentials.json`, …), and what a
 * backend keeps where codeoid put it (opencode's credential files and its
 * database, {@link registerSecretPaths}) — so a
 * prompt-injected "read ~/.codeoid/claude-accounts.json" would hand them over
 * without anyone seeing a prompt. `/proc/<pid>/environ` is the same leak one
 * hop removed: the backend's process carries its credential in its
 * environment, and a file tool runs INSIDE that process.
 *
 * `~/.claude.json` is asked about, in every mode, rather than refused: it holds
 * MCP servers' literal tokens, and it is where the user's approvals of a
 * project's MCP servers live (#395) — an unprompted write could approve a
 * repo's servers for every backend, or add a global server for every
 * session. But editing it is a thing a user may want an agent to do.
 *
 * WHAT. A call that names one of those files directly is refused, in every
 * mode — there is no legitimate reason for an agent to read them; the owner
 * manages them through codeoid or the CLI itself. A search rooted ABOVE one
 * (a `Grep` over the home directory) is not refused — it is usually innocent —
 * but never runs unprompted: the owner sees it and decides.
 *
 * Shell commands are judged too (#431): the risk check (risk/shell-risk.ts)
 * parses a command line and runs every path it recognises through this verdict
 * (a best effort: a path spelled in a way it doesn't follow isn't checked).
 *
 * LIMITS. A command a backend runs without asking codeoid isn't seen: Codex's
 * `untrusted` policy and qwen run commands they consider read-only without
 * asking, and Codex in autonomous mode asks about nothing (#442). And code the workdir itself
 * runs (a project's Claude hooks, MCP servers) runs with the daemon user's
 * full rights; nothing here contains it. See docs/CONFIGURATION.md.
 *
 * Backend-neutral: the path is read from whichever input key the backend's
 * file tools use.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { defaultCodexHome, defaultGeminiCliRoot, piAgentDirOf } from "./account-apply.js";

export type SecretPathVerdict = { action: "deny" | "ask"; path: string } | null;

/** Input keys backends use for a file or search root. */
const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "absolute_path",
  "notebook_path",
  "dir_path",
  "directory",
  "source",
  "destination",
] as const;
/** Input keys holding a list of paths (`directories`: opencode's external-directory card; `files`: every target of its patch). */
const PATH_LIST_KEYS = ["paths", "file_paths", "absolute_paths", "include", "directories", "files"] as const;

/** Tools whose `pattern` is a path glob (not a regex) and whose absent root means the workdir. */
const GLOB_TOOLS = new Set(["Glob", "glob"]);
/** Search tools: an absent root means the workdir. */
const SEARCH_TOOLS = new Set(["Glob", "glob", "Grep", "grep", "grep_search", "search_file_content", "LS", "list_directory"]);

/** Files in codeoid's config dir that hold credentials. */
function isSecretConfigFile(name: string): boolean {
  return (
    name === "claude-accounts.json" ||
    name.startsWith("claude-accounts.json.") || // atomicWrite temp files
    name === "accounts.json" || // every backend's accounts (accounts.ts)
    name.startsWith("accounts.json.") ||
    name === "endpoints.json" || // OpenAI-compatible endpoint keys
    name.startsWith("endpoints.json.") ||
    name === "config.json" ||
    name.startsWith("config.json.") ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name.startsWith("local-token") ||
    name === "codeoid.db" ||
    name.startsWith("codeoid.db-") // -wal / -shm hold recent rows in plain text
  );
}

/** The agent CLIs' own stored logins. */
function cliCredentialFiles(): string[] {
  const home = homedir();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return [
    join(claudeDir, ".credentials.json"),
    join(home, ".codex", "auth.json"),
    join(defaultCodexHome(), "auth.json"),
    join(process.env.QWEN_HOME || join(home, ".qwen"), "oauth_creds.json"),
    join(defaultGeminiCliRoot(), ".gemini", "oauth_creds.json"),
    join(defaultGeminiCliRoot(), ".gemini", "google_accounts.json"),
    join(defaultGeminiCliRoot(), ".gemini", "gemini-credentials.json"),
    join(piAgentDirOf(process.env), "auth.json"), // ~ read as pi reads it
  ];
}

/** Credential locations a backend registered (`registerSecretPaths`): dirs whose contents are secret, files (and their SQLite sidecars). */
const REGISTERED_DIRS = new Map<string, number>();
const REGISTERED_FILES = new Map<string, number>();

function bump(map: Map<string, number>, key: string, by: 1 | -1): void {
  const n = (map.get(key) ?? 0) + by;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

/**
 * Add credential locations codeoid chose for a backend: every file under one
 * of `dirs`, and each of `files` (with its `-wal` / `-shm` / `-journal`), is
 * refused like codeoid's own; a search rooted above one asks. opencode's
 * credential dir and database are registered with the registry
 * (registry.ts). Returns the undo (tests).
 */
export function registerSecretPaths(paths: { dirs?: readonly string[]; files?: readonly string[] }): () => void {
  const dirs = (paths.dirs ?? []).map((d) => resolve(d));
  const files = (paths.files ?? []).map((f) => resolve(f));
  for (const d of dirs) bump(REGISTERED_DIRS, d, 1);
  for (const f of files) bump(REGISTERED_FILES, f, 1);
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    for (const d of dirs) bump(REGISTERED_DIRS, d, -1);
    for (const f of files) bump(REGISTERED_FILES, f, -1);
  };
}

const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];

/**
 * `/proc/<pid>/environ`, `/proc/self/mem`, `/proc/<pid>/task/<tid>/fd/3`, …:
 * any such component below /proc, so a path through a process's `root` or
 * `cwd` link (`/proc/self/root/proc/1/environ`) is one too.
 */
const PROC_SECRET = /^\/proc\/(?:[^/]+\/)+?(?:environ|mem|fd|fdinfo|map_files)(?:\/|$)/;
/** `/proc/<pid>/root`, a process's view of `/`: what follows it is that path from the root. */
const PROC_ROOT_LINK = /^\/proc\/[^/]+(?:\/task\/[^/]+)?\/root(?=\/|$)/;

/** A path that hands over a process's environment, memory or open files, as written. */
export function isProcSecretPath(path: string): boolean {
  return PROC_SECRET.test(path);
}

/** A path and what it names through each `/proc/<pid>/root` link at its start (`/proc/1/root/home/u/x` is `/home/u/x`). */
function throughProcRoots(path: string): string[] {
  const out = [path];
  for (let p = path; PROC_ROOT_LINK.test(p) && out.length < 16; ) {
    p = p.replace(PROC_ROOT_LINK, "") || "/";
    out.push(p);
  }
  return out;
}
/** `/proc`, `/proc/<pid>`, `/proc/<pid>/task[/<tid>]` — roots a search would recurse into the above from. */
const PROC_ROOT = /^\/proc(?:\/(?:\d+|self|thread-self)(?:\/task(?:\/\d+)?)?)?$/;
/** A named-account login's staging home (auth/backend-login.ts), current and #392's prefix. */
const LOGIN_DIR = /(?:^|\/)codeoid-(?:claude-)?login-[^/]*(?:\/|$)/;

/** Case-insensitive filesystems (macOS default): `~/.CODEOID/Config.json` opens the same file. */
const FOLD = process.platform === "darwin" || process.platform === "win32";
const norm = (p: string) => (FOLD ? p.toLowerCase() : p);

function expand(p: string, workdir: string): string {
  const home = p === "~" || p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;
  // The tool opens it from the workdir: that is its `/proc/self/cwd` too.
  const abs = isAbsolute(home) ? home : `${resolve(workdir)}/${home}`;
  return kernelPath(abs, resolve(workdir)) ?? resolve(abs);
}

/** A process's own cwd link (`self`, `thread-self`, a task's, or this process's own pid's): the cwd of whoever opens the path. */
const SELF_CWD = new RegExp(`^/proc/(?:self|thread-self|${process.pid})(?:/task/[^/]+)?/cwd(?=/|$)`);

/**
 * `p` (absolute) as the kernel resolves it for a process whose cwd is
 * `cwd`: `..` is the parent of what the path so far really is, a symlink
 * followed first, never a lexical collapse — the round-15 path rule
 * (opencode's `realTarget`). So `/dev/fd/../../1/environ` is
 * `/proc/1/environ`, and `/proc/self/cwd/../x` is `x` beside `cwd`. The
 * lexical answer when both readings name the same file (a path through a
 * symlinked `/tmp` stays as written); null when it goes up out of the
 * process's own cwd link and `cwd` isn't known.
 */
export function kernelPath(p: string, cwd: string | null): string | null {
  const lexical = normalize(p);
  if (!p.split("/").includes("..")) return lexical;
  let at = "/";
  for (const name of p.split("/")) {
    if (name === "" || name === ".") continue;
    if (name !== "..") {
      at = join(at, name);
      continue;
    }
    const self = SELF_CWD.exec(at);
    if (self) {
      if (cwd === null) return null;
      at = cwd + at.slice(self[0].length);
    }
    at = dirname(real(at));
  }
  return at === lexical || real(at) === real(lexical) ? lexical : at;
}

/** The real path when it exists — a symlink in the workdir must not launder a secret. */
function real(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : realpathSync(dirname(p)) + sep + basename(p);
  } catch {
    return p;
  }
}

function within(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function candidatePaths(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of PATH_KEYS) if (typeof obj[k] === "string" && obj[k]) out.push(obj[k] as string);
  for (const k of PATH_LIST_KEYS) {
    const v = obj[k];
    if (Array.isArray(v)) for (const p of v) if (typeof p === "string" && p) out.push(p);
  }
  // A glob's pattern can be absolute (`/home/u/.codeoid/*.json`): judge its
  // literal prefix, up to the first wildcard. Only for glob tools — Grep's
  // `pattern` is a regex, and searching code for "/proc/self/environ" is fine.
  if (GLOB_TOOLS.has(toolName) && typeof obj.pattern === "string" && (isAbsolute(obj.pattern) || obj.pattern.startsWith("~"))) {
    const literal = obj.pattern.split(/[*?[{]/, 1)[0] ?? "";
    if (literal) out.push(literal.endsWith("/") ? literal.slice(0, -1) || "/" : literal);
  }
  // A search with no root searches the workdir.
  if (out.length === 0 && SEARCH_TOOLS.has(toolName)) out.push(".");
  return out;
}

/** The directories credential files live in: codeoid's config dir and each agent CLI's login dir. */
export function secretDirsOf(configDir: string): string[] {
  return [resolve(configDir), ...cliCredentialFiles().map((f) => dirname(f))];
}

/**
 * The verdict for one tool call: `deny` when it names a secret file, `ask`
 * when it searches a directory that contains one, null otherwise.
 */
export function secretPathVerdict(
  toolName: string,
  input: unknown,
  opts: { workdir: string; configDir: string; /** false: a listing, which reads no file: a process's environment, memory or open files aren't refused (a credential file still is). */ procReads?: boolean },
): SecretPathVerdict {
  const configDir = real(resolve(opts.configDir));
  const secretFiles = [
    ...cliCredentialFiles().map((f) => real(f)),
  ];
  const registeredDirs = [...REGISTERED_DIRS.keys()].map((d) => real(d));
  const registeredFiles = [...REGISTERED_FILES.keys()].map((f) => real(f));
  const secretDirs = [configDir, ...secretFiles.map((f) => dirname(f)), ...registeredDirs, ...registeredFiles.map((f) => dirname(f))];
  // Found as the MCP reader finds it (workdir-servers.ts): HOME first.
  const claudeJson = real(join(process.env.HOME ?? homedir(), ".claude.json"));
  let verdict: SecretPathVerdict = null;
  for (const raw of candidatePaths(toolName, input)) {
    const literal = expand(raw, opts.workdir);
    // Both forms: `/proc/self/fd/3` resolves to whatever the fd points at.
    // And through a process's root link: `/proc/4242/root/home/u/.codeoid/config.json`.
    const forms = [...new Set([literal, real(literal)].flatMap(throughProcRoots).flatMap((f) => [f, real(f)]))];
    if (opts.procReads !== false && forms.some((f) => PROC_SECRET.test(f))) return { action: "deny", path: raw };
    for (const p of forms) {
      const v = verdictOf(p, raw);
      if (v?.action === "deny") return v;
      verdict ??= v;
    }
  }
  return verdict;

  function verdictOf(p: string, raw: string): SecretPathVerdict {
    let verdict: SecretPathVerdict = null;
    if (norm(dirname(p)) === norm(configDir) && isSecretConfigFile(norm(basename(p)))) return { action: "deny", path: raw };
    if (secretFiles.some((f) => norm(f) === norm(p))) return { action: "deny", path: raw };
    if (registeredDirs.some((d) => within(p, d))) return { action: "deny", path: raw };
    if (registeredFiles.some((f) => SQLITE_SIDECARS.some((s) => norm(`${f}${s}`) === norm(p)))) return { action: "deny", path: raw };
    if (LOGIN_DIR.test(p)) return { action: "deny", path: raw };
    // An account's home (accounts.ts): its own files are its credential. The
    // shared entries are symlinks, which `real` has already resolved to the
    // vendor's default home — so anything still under here is account-owned.
    if (norm(p).startsWith(`${norm(join(configDir, "accounts"))}/`)) return { action: "deny", path: raw };
    if (norm(p) === norm(claudeJson)) verdict = { action: "ask", path: raw };
    // A root that CONTAINS one of them (the dir itself, home, /) reaches it
    // by recursion; so does `/proc` itself.
    if (secretDirs.some((d) => within(d, p)) || PROC_ROOT.test(p)) verdict ??= { action: "ask", path: raw };
    return verdict;
  }
}
