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
 * The machine is told by its machine id (Linux `/etc/machine-id`, macOS
 * `IOPlatformUUID`) where both sides have one, else by hostname. A lock held
 * by a process that is gone is taken over, saying so: on the same machine,
 * the machine restarted since (another boot id), or, in the same pid
 * namespace, its pid no longer runs or now runs a process that started at
 * another time (a reused pid; the start time is the one process-tree.ts
 * reads, macOS's `ps` run under a fixed `TZ` and locale so it reads the same
 * from any shell). The holder refreshes its lock's mtime every minute
 * (`HEARTBEAT_MS`): a lock from another pid namespace on this machine and
 * boot (a container restarted after a crash, whose old pids can't be seen) is
 * taken over once it hasn't been refreshed for `HEARTBEAT_STALE_MS`. Any
 * other lock refuses the start, naming the holder and how to clear a stale
 * one: a live daemon's, one from another machine, a fresh one from another
 * pid namespace. Nothing of another daemon's is deleted or overwritten while
 * deciding; a stale lock is moved aside only under a takeover guard (another
 * file created atomically), after reading it again, and what was moved is
 * checked to be the stale one, so two starts racing for one stale lock can't
 * both win, nor remove the winner's. A guard left by a start that died
 * mid-takeover is judged as a lock is and cleared the same way.
 *
 * A lock is read without following a link or blocking on a FIFO, and only
 * as a small regular file. Directories the lock creates are made 0700.
 *
 * Released on every shutdown path: the ShutdownManager's cleanup, a
 * synchronous `exit` handler for a `process.exit` that skips it, and a
 * signal before the daemon's own handlers are installed. A daemon killed
 * outright (SIGKILL, power loss) leaves its lock, which the next start takes
 * over.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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
/** How often a holder refreshes its lock's mtime. */
export const HEARTBEAT_MS = 60_000;
/** A lock from another pid namespace on this machine not refreshed for this long is a dead container's. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** A lock file is a few hundred bytes; anything bigger isn't one. */
const MAX_LOCK_BYTES = 4096;
/** A temp file of a start that died before linking it, swept when this old. */
const STALE_TEMP_MS = 60 * 60_000;

/** What a lock file records about the daemon holding it. */
export interface LockHolder {
  pid: number;
  hostname: string;
  /** The machine's id (Linux /etc/machine-id, macOS IOPlatformUUID), else absent. */
  machine?: string;
  /** /proc/sys/kernel/random/boot_id (Linux), else absent. */
  boot?: string;
  /** /proc/self/ns/pid (Linux), else absent. */
  pidNamespace?: string;
  /** The process's start time (process-tree.ts: Linux clock ticks since boot, else `ps -o lstart` in UTC and the C locale); absent when unreadable. */
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

/** `ps`'s environment: a fixed time zone and locale, so `lstart` reads the same whoever runs it. */
export const PS_ENV = { PATH: "/bin:/usr/bin:/usr/sbin:/sbin", TZ: "UTC", LC_ALL: "C" };

/**
 * A process's start time, as process-tree.ts reads it (Linux `/proc/<pid>/stat`),
 * else `ps -o lstart` under {@link PS_ENV}: local time in the caller's zone and
 * locale would make a live holder's start differ from the one it recorded.
 */
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "linux") return procStartTime(pid);
  if (platform === "win32") return undefined;
  return readOr(() => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3_000, env: PS_ENV }).trim().replace(/\s+/g, " ")) || undefined;
}

/** The machine's id: Linux's (systemd / dbus), macOS's hardware UUID; undefined elsewhere or when unreadable. */
export function machineId(): string | undefined {
  if (process.platform === "darwin") {
    const out = readOr(() => execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 3_000, env: PS_ENV }));
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out ?? "")?.[1];
  }
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const id = readOr(() => readFileSync(f, "utf8").trim());
    if (id && /^[0-9a-f]{32}$/i.test(id)) return id;
  }
  return undefined;
}

/** This process, as a lock records it. */
export function selfHolder(port?: number): LockHolder {
  const boot = readOr(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  const pidNamespace = readOr(() => readlinkSync("/proc/self/ns/pid"));
  const start = processStartTime(process.pid);
  const machine = machineId();
  return {
    pid: process.pid,
    hostname: hostname(),
    ...(machine ? { machine } : {}),
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
  machine?: string;
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
    ...(self.machine ? { machine: self.machine } : {}),
    ...(self.boot ? { boot: self.boot } : {}),
    ...(self.pidNamespace ? { pidNamespace: self.pidNamespace } : {}),
    alive: processAlive,
    startTime: processStartTime,
  };
}

/**
 * Whether the daemon a lock names is gone: `{ gone: true, why }` when it is
 * provably gone, `{ gone: false, why }` when it runs or can't be checked from
 * here (another machine; another pid namespace whose lock is still being
 * refreshed; a start time that can't be read). `ageMs`: how long since the
 * lock was last refreshed (its mtime), when known.
 */
export function judgeHolder(h: LockHolder, view: ProcessView, ageMs?: number): { gone: boolean; why: string } {
  // The machine id where both have one (a hostname changes and repeats); else the hostname.
  const sameMachine = h.machine && view.machine ? h.machine === view.machine : h.hostname === view.hostname;
  if (!sameMachine) return { gone: false, why: `it was taken on another machine (${h.hostname}), whose processes can't be checked from here` };
  if (h.boot && view.boot && h.boot !== view.boot) return { gone: true, why: "the machine has restarted since" };
  if (h.pidNamespace && view.pidNamespace && h.pidNamespace !== view.pidNamespace) {
    if (ageMs !== undefined && ageMs > HEARTBEAT_STALE_MS) {
      return { gone: true, why: `it was taken in another pid namespace (a container) and hasn't been refreshed for ${Math.round(ageMs / 60_000)} minutes` };
    }
    return {
      gone: false,
      why: `it was taken in another pid namespace (a container), whose processes can't be checked from here; if that daemon is gone, its lock is taken over once it hasn't been refreshed for ${HEARTBEAT_STALE_MS / 60_000} minutes`,
    };
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
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      writeSync(fd, content);
      // On disk before it's named: a power loss can't leave an empty lock.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never made
    }
    throw new DataDirLockError(`couldn't write a lock in ${dirname(path)}: ${(err as Error).message}`);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // A filesystem without hard links: create it in place (a reader that sees it half written refuses, failing closed).
    if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") return createInPlace(path, content);
    throw new DataDirLockError(`couldn't create ${path}: ${(err as Error).message}`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // gone already
    }
  }
}

function createInPlace(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new DataDirLockError(`couldn't create ${path}: ${(err as Error).message}`);
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * A lock file's text, read without following a link or blocking on a FIFO,
 * only from a regular file of at most `MAX_LOCK_BYTES`; with its inode and
 * mtime. Null when there's none; throws `DataDirLockError` for anything else
 * at the path.
 */
function readLockFile(path: string): { text: string; ino: number; mtimeMs: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new DataDirLockError(`${path} is a symbolic link, not a codeoid daemon lock. Remove it and start again.`);
    throw new DataDirLockError(`couldn't read ${path}: ${(err as Error).message}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new DataDirLockError(`${path} isn't a regular file, so it isn't a codeoid daemon lock. Remove it and start again.`);
    if (st.size > MAX_LOCK_BYTES) throw new DataDirLockError(`${path} is too big to be a codeoid daemon lock. Remove it and start again.`);
    const buf = Buffer.alloc(MAX_LOCK_BYTES);
    const n = readSync(fd, buf, 0, MAX_LOCK_BYTES, 0);
    return { text: buf.subarray(0, n).toString("utf8"), ino: st.ino, mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function readLock(path: string): { holder: LockHolder | null; ino: number; mtimeMs: number } | null {
  const f = readLockFile(path);
  return f && { holder: parseHolder(f.text), ino: f.ino, mtimeMs: f.mtimeMs };
}

/**
 * Move the file at `path` aside and remove it, only if it is still the one
 * read (`ino`, `nonce`); one replaced meanwhile is put back. False then.
 */
function removeIfStill(path: string, ino: number, nonce: string | undefined): boolean {
  const aside = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.gone`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  let moved: { holder: LockHolder | null; ino: number } | null = null;
  try {
    moved = readLock(aside);
  } catch {
    // not a lock: not the one read
  }
  if (moved && moved.ino === ino && moved.holder?.nonce === nonce) {
    unlinkSync(aside);
    return true;
  }
  // Someone else's, made since: back where it was (unless another took the name meanwhile).
  try {
    linkSync(aside, path);
  } catch {
    // the name is taken again: whoever took it holds it
  }
  try {
    unlinkSync(aside);
  } catch {
    // gone already
  }
  return false;
}

/** Remove temp files (`<lock>.<pid>.<hex>.tmp` / `.gone`) a start that died left behind, once old. */
function sweepTemps(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const own = new RegExp(`^${DAEMON_LOCK_FILE.replace(/\./g, "\\.")}(?:${TAKEOVER_SUFFIX.replace(/\./g, "\\.")})?\\.\\d+\\.[0-9a-f]{12}\\.(?:tmp|gone)$`);
  for (const name of names) {
    if (!own.test(name)) continue;
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > STALE_TEMP_MS) unlinkSync(p);
    } catch {
      // gone, or not ours to judge
    }
  }
}

/** The locks one daemon holds. `release` is idempotent and never throws. */
export interface DaemonLocks {
  readonly paths: readonly string[];
  readonly holder: LockHolder;
  release(): void;
  /** The daemon's own signal handlers are installed: the lock's interim ones step aside. */
  signalsHandled(): void;
}

export interface AcquireOptions {
  port?: number;
  /** How this host sees processes (tests). */
  view?: ProcessView;
  /** Where takeovers are said (default: the daemon's log). */
  log?: (line: string) => void;
  /** Refresh the locks' mtime every `HEARTBEAT_MS` (default true; tests turn it off). */
  heartbeat?: boolean;
}

/** Whether the lock at `path` is still this holder's. */
function stillOurs(path: string, nonce: string): boolean {
  try {
    return readLock(path)?.holder?.nonce === nonce;
  } catch {
    return false;
  }
}

/** Refresh the lock's mtime, if it's still ours: what tells a dead container's lock from a live one. */
export function refreshLock(path: string, nonce: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_LOCK_BYTES) return false;
    const buf = Buffer.alloc(MAX_LOCK_BYTES);
    const n = readSync(fd, buf, 0, MAX_LOCK_BYTES, 0);
    if (parseHolder(buf.subarray(0, n).toString("utf8"))?.nonce !== nonce) return false;
    const now = new Date();
    futimesSync(fd, now, now);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Lock each of `dirs` (created 0700 if missing) for this daemon, or throw a
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
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Until the daemon's own handlers are in, a signal releases the locks and exits as it would have.
  const onSignal = (signal: (typeof SIGNALS)[number]) => {
    release();
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
  };
  const signalsHandled = () => {
    for (const sig of SIGNALS) process.off(sig, onSignal);
  };
  const release = () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    process.off("exit", release);
    signalsHandled();
    for (const path of taken) {
      // Only our own: a lock replaced since (a takeover after we were judged gone) is the new holder's.
      try {
        const found = readLock(path);
        if (found?.holder?.nonce === holder.nonce) removeIfStill(path, found.ino, holder.nonce);
      } catch {
        // gone already, or unreadable: nothing of ours to remove
      }
    }
  };
  try {
    for (const dir of dirs) {
      // Never loosens an existing directory; one made here is the owner's alone.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      sweepTemps(dir);
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
  for (const sig of SIGNALS) process.on(sig, onSignal);
  if (opts.heartbeat !== false) {
    heartbeat = setInterval(() => {
      for (const path of taken) {
        if (!refreshLock(path, holder.nonce) && !stillOurs(path, holder.nonce)) log(`[codeoid] the lock ${path} is no longer this daemon's: another start took it over`);
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }
  return { paths: taken, holder, release, signalsHandled };
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
    const verdict = judgeHolder(holder, view, Date.now() - found.mtimeMs);
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

/** Take the takeover guard; a guard left by a start that is gone is cleared, as a stale lock is. */
function takeGuard(guard: string, path: string, content: string, view: ProcessView, log: (line: string) => void): void {
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  let cleared = false;
  while (!createExclusive(guard, content)) {
    if (Date.now() > deadline) {
      const g = readLock(guard);
      const verdict = g?.holder ? judgeHolder(g.holder, view, Date.now() - g.mtimeMs) : null;
      if (!cleared && g?.holder && verdict?.gone) {
        // A start that died mid-takeover: its guard goes, only if it's still that one.
        cleared = true;
        if (removeIfStill(guard, g.ino, g.holder.nonce)) log(`[codeoid] removed the takeover guard ${guard} of a start that is gone (${describeHolder(g.holder)}): ${verdict.why}`);
        continue;
      }
      throw new DataDirLockError(
        `another codeoid start${g?.holder ? ` (${describeHolder(g.holder)})` : ""} is taking over the stale lock ${path}. If no codeoid daemon is starting, remove ${guard} and start again.`,
      );
    }
    Bun.sleepSync(50);
  }
}

/** Replace a stale lock with ours, under the takeover guard. */
function takeOver(path: string, ino: number, stale: LockHolder, content: string, why: string, view: ProcessView, log: (line: string) => void): void {
  const guard = `${path}${TAKEOVER_SUFFIX}`;
  takeGuard(guard, path, content, view, log);
  const own = parseHolder(content);
  try {
    // Read again under the guard: only the lock judged gone is removed.
    const again = readLock(path);
    if (again && (again.ino !== ino || again.holder?.nonce !== stale.nonce)) {
      const h = again.holder;
      if (!h || !judgeHolder(h, view, Date.now() - again.mtimeMs).gone) {
        throw new DataDirLockError(`another codeoid daemon${h ? ` (${describeHolder(h)})` : ""} took ${path} first. Stop it first, or start this one with its own data.`);
      }
    }
    if (again && !removeIfStill(path, again.ino, again.holder?.nonce)) {
      throw new DataDirLockError(`another codeoid daemon took ${path} first. Stop it first, or start this one with its own data.`);
    }
    if (!createExclusive(path, content)) throw new DataDirLockError(`another codeoid daemon took ${path} first. Stop it first, or start this one with its own data.`);
    log(`[codeoid] took over the lock ${path} of a daemon that is gone (${describeHolder(stale)}): ${why}`);
  } finally {
    // Ours only: a guard cleared as stale meanwhile (we were judged gone) is another start's.
    const g = (() => {
      try {
        return readLock(guard);
      } catch {
        return null;
      }
    })();
    if (g && own && g.holder?.nonce === own.nonce) removeIfStill(guard, g.ino, own.nonce);
  }
}
