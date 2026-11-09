/**
 * The one way codeoid uses a path of a session's (#448 rounds 13 and 14,
 * docs/sandbox.md "Pinned paths").
 *
 * A session's paths are where an agent's commands can write: the workspace
 * (a monorepo's repository top), the working directory, every added
 * directory, every project root (another session's workspace), the
 * session's worktree folders, its repository's git dirs, the paths held
 * read-only inside them, the directories held in place. Any component of
 * one can be moved aside and replaced by a link between two uses of it, by
 * this session's commands or another's. Resolving it again then (a
 * `realpath`, a bind by name, a `mkdir`, a git run with it as its work
 * tree) follows the link: the home bound writable, the daemon's private
 * dir shown, a rewind writing into the home.
 *
 * So each is pinned once, with what it is: its real path and, for a
 * directory, its identity (`dev:ino`, {@link pinRecord}), taken when the
 * session is created, the directory granted, the root first resolved, the
 * spec built. Every use checks first that the path is still that, reached
 * through no symbolic link ({@link pinProblem}), and one that isn't is never
 * followed: the use is refused with what changed, and the session says it.
 *
 *   - a sandbox: every spec build, every launch of a program inside
 *     (`LocalSandboxHandle.wrap`, and again in the launched argv itself:
 *     {@link pinGuardArgv}, so a launcher script written once checks at each
 *     run), Claude's own sandbox settings, every tool call at the gate;
 *   - the daemon's own work in a session's directory ({@link PinnedDir}):
 *     checkpoints, going back a turn, a fork's files, the placeholders it
 *     makes, the worktree folders it makes and removes. Checked before and
 *     again after ({@link inPinnedDir}): git and the file system take paths,
 *     so what is checked and what is used can't be one open directory; a
 *     directory is created without following a link, a file opened with
 *     `O_NOFOLLOW | O_EXCL` ({@link makeInPinned}).
 */

import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** One path of a spec bound by name (SandboxSpec.pins). */
export interface PathPin {
  /** Its real path: what is bound. */
  path: string;
  /** What it is, for what is said: "the workspace", "added directory", "project root", … */
  what: string;
  /** `dev:ino` it had when the spec was built; absent: only that it is reached through no link (one codeoid makes and removes, or a file). */
  id?: string;
  /** It may be missing (then nothing is bound there): a worktree folder, a held path not made. */
  mayBeMissing?: boolean;
  /** Not a directory (a held file: a repository's `config`, a project's `.mcp.json`): no link on its way nor itself; which file isn't compared (an ordinary write replaces one). */
  file?: boolean;
}

/** Raised when a pinned path isn't what it was: the build, the launch or the daemon's own use is refused. */
export class SandboxPinError extends Error {
  override name = "SandboxPinError";
}

let bootId: string | null = null;
/** This boot's id (Linux), else "": device numbers are reassigned at boot, so across one only the inode is compared. */
export function currentBoot(): string {
  if (bootId === null) {
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      bootId = "";
    }
  }
  return bootId;
}

/** The first component of `p` (absolute) that is a symbolic link, or null (none, or a missing one first). */
function linkIn(p: string): string | null {
  let at = "";
  for (const part of resolve(p).split("/").filter(Boolean)) {
    at += `/${part}`;
    try {
      if (lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return null;
    }
  }
  return null;
}

/** `dev:ino` of the directory at `p`, reached through no link and at its real path, or null. */
export function dirIdentity(p: string): string | null {
  const at = resolve(p);
  if (linkIn(at) !== null) return null;
  try {
    const st = lstatSync(at);
    if (!st.isDirectory() || realpathSync(at) !== at) return null;
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** What is kept for `p` when it is pinned: `dev:ino@boot`, or null when it isn't a directory at its real path. */
export function pinRecord(p: string): string | null {
  const id = dirIdentity(p);
  return id === null ? null : `${id}@${currentBoot()}`;
}

/** Whether `current` (`dev:ino`, now) is the directory `stored` (`dev:ino@boot`) names: the same inode, and device within one boot. */
export function sameDir(stored: string, current: string): boolean {
  const [id = "", boot = ""] = stored.split("@");
  const [dev, ino] = id.split(":");
  const [nowDev, nowIno] = current.split(":");
  if (!ino || ino !== nowIno) return false;
  const now = currentBoot();
  return !boot || !now || boot !== now || dev === nowDev;
}

/** Why `p` isn't what was pinned there, without naming it ("is gone", …), or null. */
function changeOf(p: string, opts: { stored?: string; id?: string; mayBeMissing?: boolean; file?: boolean }): string | null {
  const at = resolve(p);
  const link = linkIn(at);
  if (link) return `is reached through a symbolic link now (${link})`;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(at);
  } catch {
    return opts.mayBeMissing ? null : "is gone";
  }
  if (opts.file) {
    // A held file: only that it is where it was, at its real path (its directory's checked above, component by component).
    try {
      return realpathSync(dirname(at)) === dirname(at) ? null : "isn't at its real path now";
    } catch {
      return "can't be resolved now";
    }
  }
  if (!st.isDirectory()) return "isn't a directory now";
  try {
    if (realpathSync(at) !== at) return "isn't at its real path now";
  } catch {
    return "can't be resolved now";
  }
  const now = `${st.dev}:${st.ino}`;
  if (opts.stored && !sameDir(opts.stored, now)) return "isn't the directory it was (another one is there now)";
  if (opts.id && opts.id !== now) return "isn't the directory it was (another one is there now)";
  return null;
}

/**
 * Why `p` (`what`, for the words) isn't the directory pinned there, or null:
 * a symbolic link in its path, gone (unless `mayBeMissing`), not a
 * directory, or another directory than `stored` (`dev:ino@boot`) or `id`
 * (`dev:ino`, this boot) names. `file`: a held file, only checked for links.
 */
export function pinProblem(p: string, what: string, opts: { stored?: string; id?: string; mayBeMissing?: boolean; file?: boolean } = {}): string | null {
  const change = changeOf(p, opts);
  return change === null ? null : `${what} ${resolve(p)} ${change}`;
}

/** The first of `pins` that isn't what it was, in words, or null. */
export function pinsProblem(pins: readonly PathPin[] | undefined): string | null {
  for (const pin of pins ?? []) {
    const problem = pinProblem(pin.path, pin.what, {
      ...(pin.id ? { id: pin.id } : {}),
      ...(pin.mayBeMissing ? { mayBeMissing: true } : {}),
      ...(pin.file ? { file: true } : {}),
    });
    if (problem) return problem;
  }
  return null;
}

/** The sentence a refused build, launch or call carries. */
export function pinRefusal(problem: string): string {
  return `${problem}: the sandbox binds it by name, so it isn't followed — this session's commands don't run until it is the directory it was (put it back), or it is removed from the session`;
}

/**
 * What a spec binds at `path`, pinned as it is now (`what`, for the words):
 * a directory by its identity, a file (or a directory `mayBeMissing` and not
 * there) only against links. At the spec build, after the paths were found.
 */
export function pinOf(path: string, what: string, opts: { mayBeMissing?: boolean; noId?: boolean } = {}): PathPin {
  const at = resolve(path);
  let isDir: boolean | null = null;
  try {
    isDir = lstatSync(at).isDirectory();
  } catch {
    /* missing */
  }
  const id = isDir && !opts.noId ? dirIdentity(at) : null;
  return {
    path: at,
    what,
    ...(id ? { id } : {}),
    ...(opts.mayBeMissing || isDir === null ? { mayBeMissing: true } : {}),
    ...(isDir === false ? { file: true } : {}),
  };
}

/**
 * How a provider names a spec's path when it binds it: a pinned one as it
 * was pinned (the handle checked it is still that, and the launched argv
 * checks again), never resolved again; anything else (a hidden path: a link
 * there hides more; the home's allowlist, shown by where a link leads) by
 * its real path, `real` (tests replace it).
 */
export function boundPath(pins: readonly PathPin[] | undefined, real: (p: string) => string = realOrSelf): (p: string) => string {
  const pinned = new Set((pins ?? []).map((p) => p.path));
  return (p) => (pinned.has(resolve(p)) ? resolve(p) : real(p));
}

/**
 * The real path when it exists, else the path: found once, for a path the
 * caller vouches for (one a spec build checked, a git dir its layout did,
 * codeoid's own), before it is pinned. Never to use a pinned path again.
 */
export function realPathOnce(p: string): string {
  return realOrSelf(p);
}

/** The real path when it exists, else the path. */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// --- The daemon's own use of a session's directory -------------------------------------------------------------

/** A directory of a session's as the daemon uses it on the host: its real path and what it was when pinned. */
export interface PinnedDir {
  /** Its real path. */
  readonly path: string;
  /** What it is, for what is said: "the working directory", … */
  readonly what: string;
  /** `dev:ino@boot` ({@link pinRecord}). */
  readonly record: string;
}

/** A use of a pinned directory refused: it isn't what it was. Said on the session and audited by the caller. */
export class PinnedPathError extends SandboxPinError {
  override name = "PinnedPathError";
  readonly path: string;
  readonly op: string;
  readonly reason: string;
  constructor(path: string, op: string, reason: string) {
    super(`${path} changed under the session: it ${reason}; ${op} refused (never followed)`);
    this.path = path;
    this.op = op;
    this.reason = reason;
  }
}

/**
 * `path` pinned (`what`, for the words): checked against `stored` when there
 * is a record, else pinned as it is now. Throws {@link PinnedPathError} when
 * it isn't a directory at its real path reached through no link, or isn't
 * the one `stored` names.
 */
export function pinDir(path: string, what: string, stored?: string | null, op = `using ${what}`): PinnedDir {
  const at = resolve(path);
  if (!isAbsolute(path)) throw new PinnedPathError(at, op, "isn't an absolute path");
  const change = changeOf(at, stored ? { stored } : {});
  if (change) throw new PinnedPathError(at, op, change);
  const record = stored ?? pinRecord(at);
  if (!record) throw new PinnedPathError(at, op, "can't be resolved now");
  return { path: at, what, record };
}

/** Why `dir` isn't what was pinned there (in words, without its path), or null. */
export function pinnedDirChange(dir: PinnedDir): string | null {
  return changeOf(dir.path, { stored: dir.record });
}

/** Throws {@link PinnedPathError} (for `op`) when `dir` isn't what was pinned. */
export function checkPinned(dir: PinnedDir, op: string): void {
  const change = pinnedDirChange(dir);
  if (change) throw new PinnedPathError(dir.path, op, change);
}

/**
 * Run `act` on `dir`'s path (`op`, for what is said): checked before, and
 * again after, so a rename racing the act is said, never taken as done. A
 * git or a walk given the path resolves it once, at its start: run it with
 * the path as its cwd, so what it does stays in the directory that was
 * checked even when the path is changed meanwhile.
 */
export async function inPinnedDir<T>(dir: PinnedDir, op: string, act: (path: string) => Promise<T>): Promise<T> {
  checkPinned(dir, op);
  const out = await act(dir.path);
  checkPinned(dir, op);
  return out;
}

/** {@link inPinnedDir}, synchronously. */
export function inPinnedDirSync<T>(dir: PinnedDir, op: string, act: (path: string) => T): T {
  checkPinned(dir, op);
  const out = act(dir.path);
  checkPinned(dir, op);
  return out;
}

/** Whether `p` is a symbolic link (false when missing). */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The relative path's parts, refusing what would leave the directory. */
function partsOf(dir: PinnedDir, rel: string, op: string): string[] {
  const parts = rel.split("/").filter((p) => p.length > 0 && p !== ".");
  if (isAbsolute(rel) || parts.some((p) => p === "..")) throw new PinnedPathError(dir.path, op, `was asked for ${JSON.stringify(rel)}, which isn't inside it`);
  return parts;
}

/**
 * `rel` inside `dir`, as a path, once `dir` is checked and no existing part
 * of `rel` is a link: for a read, a look, or a git run that never follows a
 * link of its own work tree (git never writes through a symlinked parent).
 */
export function pinnedPath(dir: PinnedDir, rel: string, op: string): string {
  checkPinned(dir, op);
  let at = dir.path;
  for (const part of partsOf(dir, rel, op)) {
    at = join(at, part);
    if (isLink(at)) throw new PinnedPathError(dir.path, op, `holds a symbolic link on the way to ${rel} (${at})`);
  }
  return at;
}

/**
 * Make `rel` inside `dir` when it is missing (`"dir"`, or a file with
 * `content`), never through a link: each directory on the way made (0755)
 * or found a directory, not a link; the file opened `O_CREAT | O_EXCL |
 * O_NOFOLLOW`. `dir` checked before and after. Whether it was made (false:
 * there already). Throws {@link PinnedPathError} when `dir` or the way
 * changed; other failures (a read-only repository) are the caller's.
 */
export function makeInPinned(dir: PinnedDir, rel: string, make: "dir" | { content: string; mode?: number }, op: string): boolean {
  return inPinnedDirSync(dir, op, (base) => {
    const parts = partsOf(dir, rel, op);
    const leaf = parts.pop();
    if (leaf === undefined) return false;
    let at = base;
    for (const part of parts) {
      at = join(at, part);
      try {
        mkdirSync(at, { mode: 0o755 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const st = lstatSync(at);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new PinnedPathError(dir.path, op, `holds ${st.isSymbolicLink() ? "a symbolic link" : "a file"} on the way to ${rel} (${at})`);
    }
    const target = join(at, leaf);
    if (make === "dir") {
      try {
        mkdirSync(target, { mode: 0o755 });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    }
    let fd: number;
    try {
      fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, make.mode ?? 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      writeSync(fd, make.content);
    } finally {
      closeSync(fd);
    }
    return true;
  });
}

/**
 * Write `content` as the file `rel` inside `dir`, whole and never through a
 * link: made beside it ({@link makeInPinned}: `O_EXCL | O_NOFOLLOW`) and
 * renamed over it (a rename replaces a link put there, never follows it),
 * `dir` checked before and after.
 */
export function replaceInPinned(dir: PinnedDir, rel: string, content: string, op: string, mode = 0o644): void {
  const part = `${rel}.codeoid-${process.pid}-${Date.now()}.part`;
  if (!makeInPinned(dir, part, { content, mode }, op)) throw new PinnedPathError(dir.path, op, `already holds ${part}`);
  inPinnedDirSync(dir, op, (base) => {
    const from = pinnedPath(dir, part, op);
    try {
      renameSync(from, join(base, ...partsOf(dir, rel, op)));
    } catch (err) {
      try {
        unlinkSync(from);
      } catch {
        /* gone already */
      }
      throw err;
    }
  });
}

/**
 * Make `p` when it is missing (`"dir"`, or a file with `content`) in its
 * directory as it is now: that directory found by its real path once
 * (one the caller vouched for: a workspace the build just checked, a git
 * dir its layout did, a worktree location never reached through a link)
 * and pinned for the make ({@link makeInPinned}). Whether it was made.
 */
export function makeAt(p: string, make: "dir" | { content: string; mode?: number }, op: string): boolean {
  const at = resolve(p);
  const name = at.slice(at.lastIndexOf("/") + 1);
  if (!name) return false;
  return makeInPinned(pinDir(realOrSelf(dirname(at)), "a directory codeoid makes in", null, op), name, make, op);
}

/**
 * Remove the directory `p` when it is empty, never through a link (no
 * component of `p` may be one: codeoid's own dirs are kept by their real
 * paths). Whether it was removed.
 */
export function removeEmptyDir(p: string): boolean {
  const at = resolve(p);
  if (at === "/" || linkIn(at) !== null) return false;
  try {
    if (!lstatSync(at).isDirectory()) return false;
    rmdirSync(at);
    return true;
  } catch {
    return false;
  }
}

// --- The launch guard ------------------------------------------------------------------------------------------

/** The first word of a guarded argv's own: what {@link pinGuardArgv} adds before the program. */
export const PIN_GUARD_NAME = "codeoid-pins";

/**
 * sh, run as `sh -c <this> codeoid-pins <n> (<path> <id> <mode>)×n <argv…>`:
 * no path may be a link, nor have one on its way (its directory's physical
 * path, `cd -P`, is itself); a path whose `<mode>` is `m` or `fm` may be
 * missing; each with an `<id>` (not `-`) must have that `dev:ino` (`stat`
 * prints them, all at once: the absolute program found when the script is
 * made; without one only the rest is checked). Then the program runs (exec),
 * else it exits 126 saying which.
 */
export function pinGuardScript(stat: readonly string[] | null): string {
  const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
  const statCmd = stat ? stat.map(quote).join(" ") : "";
  return [
    "n=$1; shift",
    "refs=; want=; i=0",
    'while [ "$i" -lt "$n" ]; do',
    // Positional parameters by number: only digits reach eval.
    "  b=$((i * 3 + 1)); i=$((i + 1))",
    '  eval "p=\\${$b} id=\\${$((b + 1))} m=\\${$((b + 2))}"',
    '  if [ ! -e "$p" ] && [ ! -L "$p" ]; then',
    '    case $m in *m) continue ;; esac',
    '    printf "codeoid sandbox: %s is gone: not run\\n" "$p" >&2; exit 126',
    "  fi",
    '  d=${p%/*}; [ -n "$d" ] || d=/',
    '  r=$(cd -P -- "$d" 2>/dev/null && pwd -P) || r=',
    '  if [ -L "$p" ] || [ "$r" != "$d" ]; then printf "codeoid sandbox: %s is not the directory it was (a symbolic link is in its path, or it is not a directory): not run\\n" "$p" >&2; exit 126; fi',
    '  case $m in f*) ;; *) if [ ! -d "$p" ]; then printf "codeoid sandbox: %s is not the directory it was (a symbolic link is in its path, or it is not a directory): not run\\n" "$p" >&2; exit 126; fi ;; esac',
    `  if [ "$id" != - ]; then refs="$refs \\"\\\${$b}\\""; want="$want$id "; fi`,
    "done",
    ...(stat
      ? [
          'if [ -n "$refs" ]; then',
          `  got=$(eval "${statCmd.replace(/"/g, '\\"')} -- $refs" 2>/dev/null | tr "\\n" " ") || got=`,
          '  if [ "$got" != "$want" ]; then printf "codeoid sandbox: a directory the sandbox binds is not the directory it was (another one is there now): not run\\n" >&2; exit 126; fi',
          "fi",
        ]
      : []),
    "shift $((n * 3))",
    'exec "$@"',
  ].join("\n");
}

let statArgv: string[] | null | undefined;
/** How `dev:ino` is printed here: the system's `stat` with its format, or null (none found). */
function statProgram(): string[] | null {
  if (statArgv === undefined) {
    const bin = Bun.which("stat", { PATH: "/usr/bin:/bin" });
    statArgv = bin ? [bin, ...(process.platform === "darwin" ? ["-f", "%d:%i"] : ["-c", "%d:%i"])] : null;
  }
  return statArgv;
}

/**
 * `argv` run only once every pin still holds, checked by the shell right
 * before the program starts (a launcher written once checks at each run):
 * `/bin/sh -c` {@link pinGuardScript}. Unchanged without pins.
 */
export function pinGuardArgv(pins: readonly PathPin[] | undefined, argv: readonly string[]): string[] {
  if (!pins || pins.length === 0) return [...argv];
  const mode = (p: PathPin) => `${p.file ? "f" : "d"}${p.mayBeMissing ? "m" : ""}`;
  return ["/bin/sh", "-c", pinGuardScript(statProgram()), PIN_GUARD_NAME, String(pins.length), ...pins.flatMap((p) => [p.path, p.id ?? "-", mode(p)]), ...argv];
}

/** The program a guarded argv runs (what follows the guard's own words), for a caller that names it (the git shim). */
export function unguardedArgv(argv: readonly string[]): string[] {
  if (argv[0] !== "/bin/sh" || argv[3] !== PIN_GUARD_NAME) return [...argv];
  const n = Number(argv[4]);
  return argv.slice(5 + n * 3);
}
