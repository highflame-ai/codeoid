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
 * A lock is taken over only when its holder is provably gone, saying so:
 * on this machine (hostname, machine id — Linux `/etc/machine-id`, macOS
 * `IOPlatformUUID` — and boot id all the same where either side has one: a
 * machine id alone is shared by cloned VMs and images), in this pid
 * namespace, its pid no longer runs or now runs a process that started at
 * another time (a reused pid; the start time is the one process-tree.ts
 * reads, macOS's `ps` run under a fixed `TZ` and locale so it reads the same
 * from any shell). Any other lock refuses the start, naming the holder, the
 * directory and the settings that put this daemon's data there, and the
 * lock file to remove if its daemon is gone: a live daemon's, one from
 * another machine or an earlier boot (which can't be told apart), one from
 * another pid namespace (a container). Nothing of another daemon's is
 * deleted or overwritten while deciding; a stale lock is moved aside only
 * under a takeover guard (another file created atomically), after reading
 * it again, and what was moved is checked to be the stale one (put back
 * when it isn't, in place on a filesystem without hard links), so two
 * starts racing for one stale lock can't both win, nor remove the winner's.
 * A guard left by a start that died mid-takeover is judged as a lock is and
 * cleared the same way.
 *
 * The holder checks every minute (`LOCK_CHECK_MS`) that its locks are still
 * its own; one removed or replaced stops the daemon (`onLost`, the
 * daemon's shutdown), so two daemons never keep writing the same data.
 *
 * A lock is read without following a link or blocking on a FIFO, and only
 * as a small regular file. Directories the lock creates are made 0700.
 *
 * Released on every shutdown path: the ShutdownManager's cleanup, a
 * synchronous `exit` handler for a `process.exit` that skips it, and a
 * signal before the daemon's own handlers are installed. A daemon killed
 * outright leaves its lock, which the next start takes over while the
 * machine hasn't restarted; after a restart (power loss), or in a new
 * container, the start names the lock file to remove.
 * Every failure to create a data directory or write a lock is a
 * `DataDirLockError` with a named reason.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
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
/** How often a holder checks that its locks are still its own. */
export const LOCK_CHECK_MS = 60_000;
/** A lock that can't be read this many checks in a row counts as lost. */
const UNREADABLE_CHECKS = 3;
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

/** A directory a daemon owns, and what of its data the settings put there (to name in a refusal). */
export interface OwnedDir {
  dir: string;
  /** Each: what lives there, and the setting that places it. */
  uses: string[];
}

/** The directories a daemon started with `config` owns, each once (by its real path where it exists). */
export function daemonOwnedDirs(config: Pick<CodeoidConfig, "dbPath" | "transcriptDir" | "providers" | "memory">): OwnedDir[] {
  const dirs: Array<[string, string]> = [
    [dirname(config.dbPath), "the database (dbPath, CODEOID_DB_PATH)"],
    [config.transcriptDir, "transcripts (transcriptDir, CODEOID_TRANSCRIPT_DIR)"],
  ];
  const oc = config.providers?.opencode;
  if (oc?.dbPath) dirs.push([dirname(oc.dbPath), "opencode's database (providers.opencode.dbPath)"]);
  if (oc?.dataDir) dirs.push([oc.dataDir, "opencode's data (providers.opencode.dataDir)"]);
  if (config.memory?.enabled && config.memory.dbPath) dirs.push([dirname(config.memory.dbPath), "memory's database (memory.dbPath, CODEOID_MEMORY_DB_PATH)"]);
  const byKey = new Map<string, OwnedDir>();
  for (const [dir, use] of dirs) {
    const key = realOrResolved(dir);
    const had = byKey.get(key);
    if (had) had.uses.push(use);
    else byKey.set(key, { dir, uses: [use] });
  }
  return [...byKey.values()];
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
 * Whether the daemon a lock names is gone: `{ gone: true, why }` only when it
 * provably is — on this machine and boot, in this pid namespace, its pid no
 * longer runs or is another process's — else `{ gone: false, why }`.
 *
 * This machine and boot means the hostname, the machine id and the boot id
 * all match, each where either side has one: a machine id alone is shared by
 * VMs cloned from one template and images built with one baked in, and an
 * earlier boot of this machine can't be told from such a twin, so neither is
 * ever taken over.
 */
export function judgeHolder(h: LockHolder, view: ProcessView): { gone: boolean; why: string } {
  const differs = (a: string | undefined, b: string | undefined) => a !== b;
  if (h.hostname !== view.hostname || differs(h.machine, view.machine)) {
    return { gone: false, why: `it was taken on another machine (${h.hostname}), whose processes can't be checked from here` };
  }
  if (differs(h.boot, view.boot)) {
    return { gone: false, why: "it was taken before this machine last started, or on another machine with the same name and id; codeoid can't tell which" };
  }
  if (differs(h.pidNamespace, view.pidNamespace)) {
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
function readLockFile(path: string): { text: string; ino: number } | null {
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
    return { text: buf.subarray(0, n).toString("utf8"), ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

function readLock(path: string): { holder: LockHolder | null; ino: number } | null {
  const f = readLockFile(path);
  return f && { holder: parseHolder(f.text), ino: f.ino };
}

/** Link errors of a filesystem without hard links. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Move the file at `path` aside and remove it, only if it is still the one
 * read (`ino`, `nonce`); one replaced meanwhile is put back — linked back, or
 * on a filesystem without hard links written back in place, exclusively —
 * and false is returned. Another's file is never deleted: one that can't be
 * put back stays aside, and the refusal names it. `link`: tests.
 */
export function removeIfStill(path: string, ino: number, nonce: string | undefined, link: (from: string, to: string) => void = linkSync): boolean {
  const aside = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.gone`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new DataDirLockError(`couldn't move ${path} aside to replace it: ${(err as Error).message}`);
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
    link(aside, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code !== "EEXIST" && !(NO_HARD_LINKS.has(code) && putBackInPlace(aside, path))) {
      throw new DataDirLockError(`couldn't put back ${path}, another start's lock, after reading it: it is at ${aside}. Move it back to ${path} and start again.`);
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // gone already
  }
  return false;
}

/** Write the lock at `aside` back at `path` in place, only if the name is free; true when it's back or the name is taken again. */
function putBackInPlace(aside: string, path: string): boolean {
  try {
    const text = readLockFile(aside)?.text;
    if (text === undefined) return false;
    createInPlace(path, text); // false: the name is taken again, whoever took it holds it
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove temp files (`<lock>.<pid>.<hex>.tmp` / `.gone`) a start that died
 * left behind, once old. A `.gone` file that still holds the lock of a holder
 * not judged gone stays: it is another start's lock that couldn't be put
 * back, which the refusal names (a rename keeps its old mtime).
 */
function sweepTemps(dir: string, view: ProcessView): void {
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
      if (!st.isFile() || Date.now() - st.mtimeMs <= STALE_TEMP_MS) continue;
      if (name.endsWith(".gone")) {
        const holder = readLock(p)?.holder;
        if (holder && !judgeHolder(holder, view).gone) continue;
      }
      unlinkSync(p);
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
  /**
   * What to do when a lock is found no longer this daemon's (removed, or
   * replaced by another start): the daemon shuts down. Until set, the
   * process exits.
   */
  onLost(fn: (path: string) => void): void;
}

export interface AcquireOptions {
  port?: number;
  /** How this host sees processes (tests). */
  view?: ProcessView;
  /** Where takeovers are said (default: the daemon's log). */
  log?: (line: string) => void;
  /** Check every `checkMs` (default `LOCK_CHECK_MS`) that the locks are still this daemon's; false: never (tests). */
  watch?: boolean;
  checkMs?: number;
}

/** Whether the lock at `path` is this holder's: `ours`, `lost` (gone, or another's), or `unreadable` now. */
function lockState(path: string, nonce: string): "ours" | "lost" | "unreadable" {
  try {
    return readLock(path)?.holder?.nonce === nonce ? "ours" : "lost";
  } catch {
    return "unreadable";
  }
}

/** Create `dir` (0700) if missing, or say in a `DataDirLockError` why it can't be. */
function makeDataDir(dir: string): void {
  try {
    // Never loosens an existing directory; one made here is the owner's alone.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code === "EACCES" || code === "EPERM"
        ? "permission denied"
        : code === "ENOTDIR" || code === "EEXIST"
          ? "a part of that path is a file, not a directory"
          : code === "EROFS"
            ? "it is on a read-only filesystem"
            : code === "ENOENT"
              ? "a part of that path can't be created"
              : (err as Error).message;
    throw new DataDirLockError(`couldn't create the data directory ${dir}: ${why}. Point the setting that names it at a directory this user can create.`);
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Lock each of `dirs` (created 0700 if missing) for this daemon, or throw a
 * {@link DataDirLockError} naming who holds one. All or nothing: a refusal
 * releases what was taken.
 */
export function acquireDaemonLocks(dirs: ReadonlyArray<string | OwnedDir>, opts: AcquireOptions = {}): DaemonLocks {
  const view = opts.view ?? hostView();
  const log = opts.log ?? ((line: string) => console.log(line));
  const holder = selfHolder(opts.port);
  const content = `${JSON.stringify(holder, null, 2)}\n`;
  const taken: string[] = [];
  let released = false;
  let watch: ReturnType<typeof setInterval> | undefined;
  let lost: (path: string) => void = () => process.exit(1);
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
    if (watch) clearInterval(watch);
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
    for (const d of dirs) {
      const { dir, uses } = typeof d === "string" ? { dir: d, uses: [] } : d;
      try {
        makeDataDir(dir);
        sweepTemps(dir, view);
        const path = join(dir, DAEMON_LOCK_FILE);
        lockOne(path, content, holder, view, log, uses);
        taken.push(path);
      } catch (err) {
        if (err instanceof DataDirLockError) throw err;
        throw new DataDirLockError(`couldn't lock the data directory ${dir}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    release();
    throw err;
  }
  // A `process.exit` (a failed start, the shutdown grace's forced exit) skips the cleanup registry.
  process.on("exit", release);
  for (const sig of SIGNALS) process.on(sig, onSignal);
  if (opts.watch !== false) {
    // A lock removed or taken over under a running daemon: it stops, rather than share the data.
    const unreadable = new Map<string, number>();
    watch = setInterval(() => {
      for (const path of taken) {
        const state = lockState(path, holder.nonce);
        const misses = state === "unreadable" ? (unreadable.get(path) ?? 0) + 1 : 0;
        unreadable.set(path, misses);
        if (state === "ours" || (state === "unreadable" && misses < UNREADABLE_CHECKS)) continue;
        clearInterval(watch);
        log(
          `[codeoid] the lock ${path} is no longer this daemon's (${state === "lost" ? "removed, or taken over by another start" : "it can't be read"}): stopping, so two daemons never share its data`,
        );
        lost(path);
        return;
      }
    }, opts.checkMs ?? LOCK_CHECK_MS);
    watch.unref?.();
  }
  return {
    paths: taken,
    holder,
    release,
    signalsHandled,
    onLost: (fn) => {
      lost = fn;
    },
  };
}

/** What a refusal suggests to run a second daemon beside the one holding `dir`. */
function separateAdvice(dir: string, uses: readonly string[]): string {
  const here = uses.length > 0 ? ` It holds ${uses.join(", ")}; set each of those to a path outside ${dir}, or` : " Set the paths that put this daemon's data there elsewhere, or";
  return `To run a second daemon beside it, give it data of its own.${here} start it with XDG_CONFIG_HOME set to another directory (its config, database, transcripts, memory and opencode's data all move there).`;
}

function lockOne(path: string, content: string, self: LockHolder, view: ProcessView, log: (line: string) => void, uses: readonly string[] = []): void {
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
        `another codeoid daemon (${describeHolder(holder)}) uses ${dirname(path)}: ${verdict.why}. Stop it first. ${separateAdvice(dirname(path), uses)} If that daemon is gone, remove ${path} and start again.`,
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
      const verdict = g?.holder ? judgeHolder(g.holder, view) : null;
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
      if (!h || !judgeHolder(h, view).gone) {
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
