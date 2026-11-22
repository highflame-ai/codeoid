/**
 * Whether a program the git gateway runs on the host (git, ssh, codeoid's runtime) can be trusted
 * (docs/git-gateway-design.md §5): by where it is, who owns it and who may write it, never only by name.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { physicalPath, within } from "../physical-path.js";

/**
 * Each path as given and where it really is, once (a long history is judged in one pass). One that no longer
 * resolves (gone, a file now, unreadable) stands as itself: nothing that resolves can be in it.
 */
function physicalAll(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    out.add(p);
    out.add(physicalPathOr(p));
  }
  return [...out];
}

function physicalPathOr(p: string): string {
  try {
    return physicalPath(p);
  } catch {
    return p;
  }
}

/** The id a user namespace shows for an owner it doesn't map (root's files, inside a container or bwrap). */
const OVERFLOW_UID = 65534;

/**
 * Your user-private group (Linux: named as you, nobody else in it), if you have one. macOS's staff and a shared
 * `users` group are every local user's: never.
 */
// paths: the system's account files, read
function privateGroup(): number[] {
  if (process.platform === "darwin" || typeof process.getgid !== "function") return [];
  const gid = process.getgid();
  try {
    // Your name by your uid (passwd), not the environment's.
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
    const me =
      readFileSync("/etc/passwd", "utf8")
        .split("\n")
        .find((l) => l.split(":")[2] === uid)
        ?.split(":")[0] ?? userInfo().username;
    const line = readFileSync("/etc/group", "utf8")
      .split("\n")
      .find((l) => l.split(":")[2] === String(gid));
    const [name, , , members = ""] = line?.split(":") ?? [];
    return name === me && members.split(",").every((m) => !m || m === me) ? [gid] : [];
  } catch {
    return [];
  }
}

/** Whether the daemon runs in a user namespace that doesn't map root (where root's files show as the overflow id). */
// paths: the kernel's view of this process, read
function inUserNamespace(): boolean {
  try {
    const map = readFileSync("/proc/self/uid_map", "utf8").trim().split("\n");
    return !map.some((l) => /^\s*0\s+0\s+/.test(l));
  } catch {
    return false;
  }
}

/** Why a program the push may run, or a dir it may come from, isn't trusted on the host; else null. */
// paths: a look (lstat) up the path, judged; nothing followed or written
export function hostPathProblem(at: string, writable: readonly string[], home = homedir(), o: { homeAllowed?: boolean } = {}): string | null {
  let real: string;
  try {
    real = physicalPath(at);
  } catch {
    return `${at} can't be resolved`;
  }
  if (programProblem(at, writable) || programProblem(real, writable)) return `${at} is in a directory a session's commands may write`;
  if (!o.homeAllowed && home && (within(home, real) || within(home, at))) return `${at} is under your home, where a session's commands may write (or have written)`;
  // Neither it nor a dir above it (as named, and where it really is) owned by anyone but you or root, writable by
  // everyone, or writable by a group you aren't in.
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  // Group-write only by your own primary group (Linuxbrew's), or macOS's admin group (Homebrew's): never a group
  // every local user is in (staff, users, everyone).
  const groups = new Set<number>(privateGroup());
  if (process.platform === "darwin") groups.add(80);
  const overflow = inUserNamespace() ? OVERFLOW_UID : -2;
  for (const start of new Set([real, at])) {
    for (let d = start; ; d = dirname(d)) {
      try {
        const st = lstatSync(d);
        // Root's, yours, or the kernel's overflow id (root's files seen from a user namespace): no other user's.
        if (uid >= 0 && st.uid !== 0 && st.uid !== uid && st.uid !== overflow) return `${d} belongs to another user`;
        // A link's own mode means nothing (always 0777): whether it can be replaced is its dir's, checked next.
        if (st.isSymbolicLink()) {
          if (dirname(d) === d) break;
          continue;
        }
        const sticky = st.isDirectory() && (st.mode & 0o1000) !== 0 && d !== start;
        if ((st.mode & 0o002) !== 0 && !sticky) return `${d} is writable by everyone`;
        if ((st.mode & 0o020) !== 0 && !sticky && !groups.has(st.gid)) return `${d} is writable by a group you aren't in`;
      } catch {
        /* a part that isn't there: nothing runs from it */
      }
      if (dirname(d) === d) break;
    }
  }
  return null;
}

function programProblem(program: string, writable: readonly string[]): boolean {
  const real = physicalPathOr(program);
  return physicalAll(writable).some((w) => within(w, program) || within(w, real));
}

/** Why `program` (an absolute path) can't be run by the gateway on the host, or null. */
export function programTrustProblem(program: string, writable: readonly string[], home = homedir()): string | null {
  if (!isAbsolute(program)) return `${program} isn't an absolute path`;
  const bad = hostPathProblem(program, writable, home);
  return bad ? `${program} can't be trusted to run with your credentials: ${bad}` : null;
}
