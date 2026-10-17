/**
 * Paths no agent tool call may touch unasked: the daemon's own credential files
 * and a process's environment / memory.
 *
 * WHY. `Read`, `Grep` and `Glob` run unprompted in guarded and autonomous mode
 * (tool-safety.ts), with no path limit. The daemon's credentials live in files
 * owned by the same user the agent runs as — `.env`, `config.json` (the ZeroID
 * key), `claude-accounts.json` (every stored Claude subscription, gateway and
 * API-key token), the local-mode token — so a prompt-injected "read
 * ~/.codeoid/claude-accounts.json" would hand all of them over without anyone
 * seeing a prompt. `/proc/<pid>/environ` is the same leak one hop removed: the
 * backend's own process carries its credential in its environment, and a file
 * tool runs INSIDE that process (subprocess env scrubbing never covers it).
 *
 * WHAT. A call that names one of those files directly is refused, in every
 * mode — there is no legitimate reason for an agent to read them, and the
 * owner manages them through codeoid itself. A search rooted ABOVE one (a
 * `Grep` over the home directory) is not refused — it is usually innocent —
 * but never runs unprompted: the owner sees it and decides.
 *
 * Backend-neutral: the path is read from whichever input key the backend's
 * file tools use. Shell commands are out of reach here (a command line can't
 * be parsed reliably); in guarded mode they prompt anyway.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type SecretPathVerdict = { action: "deny" | "ask"; path: string } | null;

/** Input keys backends use for a file or search root. */
const PATH_KEYS = ["file_path", "filePath", "path", "absolute_path", "notebook_path", "dir_path", "directory"] as const;
/** Input keys holding a list of paths. */
const PATH_LIST_KEYS = ["paths", "file_paths", "absolute_paths"] as const;

/** Files in the config dir that hold credentials. */
function isSecretConfigFile(name: string): boolean {
  return (
    name === "claude-accounts.json" ||
    name.startsWith("claude-accounts.json.") || // atomicWrite temp files
    name === "config.json" ||
    name.startsWith("config.json.") ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name.startsWith("local-token")
  );
}

/** `/proc/<pid>/environ`, `/proc/self/mem`, `/proc/<pid>/task/<tid>/fd/3`, … */
const PROC_SECRET = /^\/proc\/[^/]+(?:\/task\/[^/]+)?\/(?:environ|mem|fd|fdinfo|map_files)(?:\/|$)/;

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
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function candidatePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of PATH_KEYS) if (typeof obj[k] === "string" && obj[k]) out.push(obj[k] as string);
  for (const k of PATH_LIST_KEYS) {
    const v = obj[k];
    if (Array.isArray(v)) for (const p of v) if (typeof p === "string" && p) out.push(p);
  }
  // A Glob pattern can be absolute (`/home/u/.codeoid/*.json`): judge its
  // literal prefix, up to the first wildcard.
  if (typeof obj.pattern === "string" && (isAbsolute(obj.pattern) || obj.pattern.startsWith("~"))) {
    const literal = obj.pattern.split(/[*?[{]/, 1)[0] ?? "";
    if (literal) out.push(literal.endsWith("/") ? literal.slice(0, -1) || "/" : literal);
  }
  return out;
}

/**
 * The verdict for one tool call's input: `deny` when it names a secret file,
 * `ask` when it searches a directory that contains one, null otherwise.
 */
export function secretPathVerdict(input: unknown, opts: { workdir: string; configDir: string }): SecretPathVerdict {
  const configDir = real(resolve(opts.configDir));
  let verdict: SecretPathVerdict = null;
  for (const raw of candidatePaths(input)) {
    const literal = expand(raw, opts.workdir);
    const p = real(literal);
    // Both forms: `/proc/self/fd/3` resolves to whatever the fd points at.
    if (PROC_SECRET.test(literal) || PROC_SECRET.test(p)) return { action: "deny", path: raw };
    if (dirname(p) === configDir && isSecretConfigFile(basename(p))) return { action: "deny", path: raw };
    // A root that CONTAINS the config dir (the dir itself, home, /) reaches
    // the files above by recursion; so does `/proc` itself.
    if (within(configDir, p) || /^\/proc(?:\/(?:\d+|self|thread-self)(?:\/task(?:\/\d+)?)?)?$/.test(p)) {
      verdict ??= { action: "ask", path: raw };
    }
  }
  return verdict;
}
