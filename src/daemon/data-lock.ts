/**
 * One daemon per data directory.
 *
 * Two `codeoid start`s on the same data (another port, a second terminal, a
 * service and a shell) would each open the SQLite store, run boot recovery
 * over the other's sessions and runs, append to the same transcripts and
 * checkpoints, and share opencode's database and credentials dir — where a
 * start clears the key files of a daemon it takes for gone. The port check
 * (EADDRINUSE) only catches a second daemon on the same port.
 *
 * So `codeoid start` takes, before anything is opened or cleaned up, an
 * exclusive lock on each distinct directory the daemon owns
 * ({@link daemonOwnedDirs}): a `codeoid-daemon.lock` file in it, created
 * atomically (a hard link of a fully written temp file: it exists whole or
 * not at all), recording the holder's pid, host, boot, pid namespace and
 * process start time. Only the daemon takes it: CLI commands that talk to a
 * daemon, tests, previews and settings reads never do.
 *
 * A lock held by a process that is gone is taken over, saying so: on the same
 * host, boot and pid namespace, its pid no longer runs, or now runs a process
 * that started at another time (a reused pid; the start time is the one
 * process-tree.ts reads). Any other lock refuses the start, naming the holder
 * and how to clear a stale one: a live daemon's, and one from another host,
 * boot or pid namespace, whose liveness can't be checked from here. Nothing of
 * another daemon's is deleted or overwritten while deciding; a stale lock is
 * removed only under a takeover guard (another file created atomically),
 * after reading it again, so two starts racing for one stale lock can't both
 * win, nor remove the winner's.
 *
 * Released on every shutdown path: the ShutdownManager's cleanup, and a
 * synchronous `exit` handler for a `process.exit` that skips it. A daemon
 * killed outright (SIGKILL, power loss) leaves its lock, which the next start
 * takes over.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { procStartTime } from "./process-tree.js";

/** The lock file's name in each directory. */
export const DAEMON_LOCK_FILE = "codeoid-daemon.lock";
/** Held only while a stale lock is replaced. */
const TAKEOVER_SUFFIX = ".takeover";
/** How long a start waits for another's takeover of the same lock to finish. */
const TAKEOVER_WAIT_MS = 2_000;

/** What a lock file records about the daemon holding it. */
export interface LockHolder {
  pid: number;
  hostname: string;
  /** /proc/sys/kernel/random/boot_id (Linux), else absent. */
  boot?: string;
  /** /proc/self/ns/pid (Linux), else absent. */
  pidNamespace?: string;
  /** The process's start time (process-tree.ts: Linux clock ticks since boot, macOS `lstart`); absent when unreadable. */
  start?: string;
  /** When it took the lock (ISO). */
  since: string;
  /** Tells this holder from an earlier one with the same pid (release removes only its own). */
  nonce: string;
  /** The port it was started on, to name it in a refusal. */
  port?: number;
}

/** Another daemon holds one of the directories, or its lock can't be judged: the start is refused. */
export class DataDirLockError extends Error {
  override name = "DataDirLockError";
}

/** The directories a daemon started with `config` owns, each once (by its real path where it exists). */
export function daemonOwnedDirs(config: Pick<CodeoidConfig, "dbPath" | "transcriptDir" | "providers" | "memory">): string[] {
  const dirs = [dirname(config.dbPath), config.transcriptDir];
  const oc = config.providers?.opencode;
  if (oc?.dbPath) dirs.push(dirname(oc.dbPath));
  if (oc?.dataDir) dirs.push(oc.dataDir);
  if (config.memory?.enabled && config.memory.dbPath) dirs.push(dirname(config.memory.dbPath));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    const key = realOrResolved(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function readOr(read: () => string): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A process's start time, as process-tree.ts reads it (Linux `/proc/<pid>/stat`, macOS `ps -o lstart`). */
export function processStartTime(pid: number): string | undefined {
  if (process.platform === "linux") return procStartTime(pid);
  if (process.platform === "win32") return undefined;
  return readOr(() => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3_000 }).trim().replace(/\s+/g, " ")) || undefined;
}

/** This process, as a lock records it. */
export function selfHolder(port?: number): LockHolder {
  const boot = readOr(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  const pidNamespace = readOr(() => readlinkSync("/proc/self/ns/pid"));
  const start = processStartTime(process.pid);
  return {
    pid: process.pid,
    hostname: hostname(),
    ...(boot ? { boot } : {}),
    ...(pidNamespace ? { pidNamespace } : {}),
    ...(start ? { start } : {}),
    since: new Date().toISOString(),
    nonce: randomBytes(8).toString("hex"),
    ...(port !== undefined ? { port } : {}),
  };
}

/** How this host sees a process: what decides whether a lock is stale. */
export interface ProcessView {
  hostname: string;
  boot?: string;
  pidNamespace?: string;
  /** Whether `pid` runs (another user's counts). */
  alive(pid: number): boolean;
  startTime(pid: number): string | undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function hostView(): ProcessView {
  const self = selfHolder();
  return {
    hostname: self.hostname,
    ...(self.boot ? { boot: self.boot } : {}),
    ...(self.pidNamespace ? { pidNamespace: self.pidNamespace } : {}),
    alive: processAlive,
    startTime: processStartTime,
  };
}

/**
 * Whether the daemon a lock names is gone: `{ gone: true, why }` when it is
 * provably gone, `{ gone: false, why }` when it runs or can't be checked from
 * here (another host, boot or pid namespace; a start time that can't be read).
 */
export function judgeHolder(h: LockHolder, view: ProcessView): { gone: boolean; why: string } {
  if (h.hostname !== view.hostname) return { gone: false, why: `it was taken on another host (${h.hostname}), whose processes can't be checked from here` };
  if (h.boot && view.boot && h.boot !== view.boot) return { gone: true, why: "the machine has restarted since" };
  if (h.pidNamespace && view.pidNamespace && h.pidNamespace !== view.pidNamespace) {
    return { gone: false, why: "it was taken in another pid namespace (a container), whose processes can't be checked from here" };
  }
  if (!view.alive(h.pid)) return { gone: true, why: `its process ${h.pid} no longer runs` };
  const now = view.startTime(h.pid);
  if (h.start && now && h.start !== now) return { gone: true, why: `its pid ${h.pid} now belongs to another process` };
  if (!h.start || !now) return { gone: false, why: `process ${h.pid} runs, and its start time can't be compared` };
  return { gone: false, why: `process ${h.pid} still runs` };
}

function parseHolder(text: string): LockHolder | null {
  try {
    const v = JSON.parse(text) as Partial<LockHolder>;
    if (typeof v.pid !== "number" || typeof v.hostname !== "string" || typeof v.nonce !== "string") return null;
    return v as LockHolder;
  } catch {
    return null;
  }
}

function describeHolder(h: LockHolder): string {
  return `pid ${h.pid} on ${h.hostname}${h.port !== undefined ? `, port ${h.port}` : ""}, since ${h.since}`;
}

/** Create `path` holding `content`, atomically: whole or not at all. False when it exists. */
function createExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode: 0o644, flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // gone already
    }
  }
}

function readLock(path: string): { holder: LockHolder | null; ino: number } | null {
  try {
    const ino = lstatSync(path).ino;
    return { holder: parseHolder(readFileSync(path, "utf8")), ino };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The locks one daemon holds. `release` is idempotent and never throws. */
export interface DaemonLocks {
  readonly paths: readonly string[];
  readonly holder: LockHolder;
  release(): void;
}

export interface AcquireOptions {
  port?: number;
  /** How this host sees processes (tests). */
  view?: ProcessView;
  /** Where takeovers are said (default: the daemon's log). */
  log?: (line: string) => void;
}

/**
 * Lock each of `dirs` (created if missing) for this daemon, or throw a
 * {@link DataDirLockError} naming who holds one. All or nothing: a refusal
 * releases what was taken.
 */
export function acquireDaemonLocks(dirs: readonly string[], opts: AcquireOptions = {}): DaemonLocks {
  const view = opts.view ?? hostView();
  const log = opts.log ?? ((line: string) => console.log(line));
  const holder = selfHolder(opts.port);
  const content = `${JSON.stringify(holder, null, 2)}\n`;
  const taken: string[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    for (const path of taken) {
      // Only our own: a lock replaced since (a takeover after we were judged gone) is the new holder's.
      try {
        if (parseHolder(readFileSync(path, "utf8"))?.nonce === holder.nonce) unlinkSync(path);
      } catch {
        // gone already, or unreadable: nothing of ours to remove
      }
    }
  };
  try {
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, DAEMON_LOCK_FILE);
      lockOne(path, content, holder, view, log);
      taken.push(path);
    }
  } catch (err) {
    release();
    throw err;
  }
  // A `process.exit` (a failed start, the shutdown grace's forced exit) skips the cleanup registry.
  process.on("exit", release);
  return { paths: taken, holder, release };
}

function lockOne(path: string, content: string, self: LockHolder, view: ProcessView, log: (line: string) => void): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(path, content)) return;
    const found = readLock(path);
    if (!found) continue; // released meanwhile: try again
    const { holder } = found;
    if (!holder) {
      throw new DataDirLockError(
        `${path} exists but can't be read as a codeoid daemon lock, so codeoid can't tell whether another daemon uses this data. If no other codeoid daemon runs on it, remove that file and start again.`,
      );
    }
    if (holder.nonce === self.nonce) return;
    const verdict = judgeHolder(holder, view);
    if (!verdict.gone) {
      throw new DataDirLockError(
        `another codeoid daemon (${describeHolder(holder)}) uses ${dirname(path)}: ${verdict.why}. Stop it first (or start this one with its own data: CODEOID_DB_PATH, CODEOID_TRANSCRIPT_DIR). If that daemon is gone, remove ${path} and start again.`,
      );
    }
    takeOver(path, found.ino, holder, content, verdict.why, view, log);
    return;
  }
  throw new DataDirLockError(`couldn't take ${path}: another start kept taking and releasing it. Start again.`);
}

/** Replace a stale lock with ours, under the takeover guard. */
function takeOver(path: string, ino: number, stale: LockHolder, content: string, why: string, view: ProcessView, log: (line: string) => void): void {
  const guard = `${path}${TAKEOVER_SUFFIX}`;
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  while (!createExclusive(guard, content)) {
    if (Date.now() > deadline) {
      const g = readLock(guard)?.holder;
      throw new DataDirLockError(
        `another codeoid start${g ? ` (${describeHolder(g)})` : ""} is taking over the stale lock ${path}. If no codeoid daemon is starting, remove ${guard} and start again.`,
      );
    }
    Bun.sleepSync(50);
  }
  try {
    // Read again under the guard: only the lock judged gone is removed.
    const again = readLock(path);
    if (again && (again.ino !== ino || again.holder?.nonce !== stale.nonce)) {
      const h = again.holder;
      if (!h || !judgeHolder(h, view).gone) {
        throw new DataDirLockError(`another codeoid daemon${h ? ` (${describeHolder(h)})` : ""} took ${path} first. Stop it first, or start this one with its own data.`);
      }
    }
    if (again) unlinkSync(path);
    if (!createExclusive(path, content)) throw new DataDirLockError(`another codeoid daemon took ${path} first. Stop it first, or start this one with its own data.`);
    log(`[codeoid] took over the lock ${path} of a daemon that is gone (${describeHolder(stale)}): ${why}`);
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // gone already
    }
  }
}
