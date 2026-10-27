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
 * token, and each CLI's own login (`~/.claude/.credentials.json`, …) — so a
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
 * parses a command line and runs every path it names through this verdict.
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
/** Input keys holding a list of paths. */
const PATH_LIST_KEYS = ["paths", "file_paths", "absolute_paths", "include"] as const;

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

/** `/proc/<pid>/environ`, `/proc/self/mem`, `/proc/<pid>/task/<tid>/fd/3`, … */
const PROC_SECRET = /^\/proc\/[^/]+(?:\/task\/[^/]+)?\/(?:environ|mem|fd|fdinfo|map_files)(?:\/|$)/;
/** `/proc`, `/proc/<pid>`, `/proc/<pid>/task[/<tid>]` — roots a search would recurse into the above from. */
const PROC_ROOT = /^\/proc(?:\/(?:\d+|self|thread-self)(?:\/task(?:\/\d+)?)?)?$/;
/** A named-account login's staging home (auth/backend-login.ts), current and #392's prefix. */
const LOGIN_DIR = /(?:^|\/)codeoid-(?:claude-)?login-[^/]*(?:\/|$)/;

/** Case-insensitive filesystems (macOS default): `~/.CODEOID/Config.json` opens the same file. */
const FOLD = process.platform === "darwin" || process.platform === "win32";
const norm = (p: string) => (FOLD ? p.toLowerCase() : p);

function expand(p: string, workdir: string): string {
  const home = p === "~" || p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;
  return isAbsolute(home) ? resolve(home) : resolve(workdir, home);
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

/**
 * The verdict for one tool call: `deny` when it names a secret file, `ask`
 * when it searches a directory that contains one, null otherwise.
 */
export function secretPathVerdict(
  toolName: string,
  input: unknown,
  opts: { workdir: string; configDir: string },
): SecretPathVerdict {
  const configDir = real(resolve(opts.configDir));
  const secretFiles = [
    ...cliCredentialFiles().map((f) => real(f)),
  ];
  const secretDirs = [configDir, ...secretFiles.map((f) => dirname(f))];
  // Found as the MCP reader finds it (workdir-servers.ts): HOME first.
  const claudeJson = real(join(process.env.HOME ?? homedir(), ".claude.json"));
  let verdict: SecretPathVerdict = null;
  for (const raw of candidatePaths(toolName, input)) {
    const literal = expand(raw, opts.workdir);
    const p = real(literal);
    // Both forms: `/proc/self/fd/3` resolves to whatever the fd points at.
    if (PROC_SECRET.test(literal) || PROC_SECRET.test(p)) return { action: "deny", path: raw };
    if (norm(dirname(p)) === norm(configDir) && isSecretConfigFile(norm(basename(p)))) return { action: "deny", path: raw };
    if (secretFiles.some((f) => norm(f) === norm(p))) return { action: "deny", path: raw };
    if (LOGIN_DIR.test(p)) return { action: "deny", path: raw };
    // An account's home (accounts.ts): its own files are its credential. The
    // shared entries are symlinks, which `real` has already resolved to the
    // vendor's default home — so anything still under here is account-owned.
    if (norm(p).startsWith(`${norm(join(configDir, "accounts"))}/`)) return { action: "deny", path: raw };
    if (norm(p) === norm(claudeJson)) verdict = { action: "ask", path: raw };
    // A root that CONTAINS one of them (the dir itself, home, /) reaches it
    // by recursion; so does `/proc` itself.
    if (secretDirs.some((d) => within(d, p)) || PROC_ROOT.test(p)) verdict ??= { action: "ask", path: raw };
  }
  return verdict;
}
