/**
 * Every directory a sandbox binds by name, pinned (#448 round 13,
 * docs/sandbox.md "Pinned directories"): the workspace (a monorepo's
 * repository top), the working directory, every added directory, every
 * project root, the session's worktree folders.
 *
 * Each is kept by its real path, taken once (when the session is created,
 * the directory granted, the root first resolved), with its identity
 * (`dev:ino`, {@link pinRecord}). Every spec build, every launch of a
 * program inside (`LocalSandboxHandle.wrap`, and again in the launched argv
 * itself: {@link pinGuardArgv}, so a launcher script written once checks at
 * each run) and every tool call at the gate first checks that the path is
 * still that directory, reached through no symbolic link
 * ({@link pinProblem}). One that isn't is never followed: the build, the
 * launch or the call is refused with what changed, and the session says it.
 * A bind by name would otherwise lay what a link put there leads to (the
 * home) writable inside the sandbox.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** One pinned directory of a spec (SandboxSpec.pins). */
export interface PathPin {
  /** Its real path: what is bound. */
  path: string;
  /** What it is, for what is said: "the workspace", "added directory", "project root", … */
  what: string;
  /** `dev:ino` it had when the spec was built; absent: only that it is a directory reached through no link (one codeoid makes and removes). */
  id?: string;
  /** It may be missing (then nothing is bound there): the working directory, a worktree folder. */
  mayBeMissing?: boolean;
}

/** Raised when a pinned directory isn't what it was: the build or the launch is refused. */
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

/**
 * Why `p` (`what`, for the words) isn't the directory pinned there, or null:
 * a symbolic link in its path, gone (unless `mayBeMissing`), not a
 * directory, or another directory than `stored` (`dev:ino@boot`) or `id`
 * (`dev:ino`, this boot) names.
 */
export function pinProblem(p: string, what: string, opts: { stored?: string; id?: string; mayBeMissing?: boolean } = {}): string | null {
  const at = resolve(p);
  const link = linkIn(at);
  if (link) return `${what} ${at} is reached through a symbolic link now (${link})`;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(at);
  } catch {
    return opts.mayBeMissing ? null : `${what} ${at} is gone`;
  }
  if (!st.isDirectory()) return `${what} ${at} isn't a directory now`;
  try {
    if (realpathSync(at) !== at) return `${what} ${at} isn't at its real path now`;
  } catch {
    return `${what} ${at} can't be resolved now`;
  }
  const now = `${st.dev}:${st.ino}`;
  if (opts.stored && !sameDir(opts.stored, now)) return `${what} ${at} isn't the directory it was (another one is there now)`;
  if (opts.id && opts.id !== now) return `${what} ${at} isn't the directory it was (another one is there now)`;
  return null;
}

/** The first of `pins` that isn't what it was, in words, or null. */
export function pinsProblem(pins: readonly PathPin[] | undefined): string | null {
  for (const pin of pins ?? []) {
    const problem = pinProblem(pin.path, pin.what, { ...(pin.id ? { id: pin.id } : {}), ...(pin.mayBeMissing ? { mayBeMissing: true } : {}) });
    if (problem) return problem;
  }
  return null;
}

/** The sentence a refused build, launch or call carries. */
export function pinRefusal(problem: string): string {
  return `${problem}: the sandbox binds it by name, so it isn't followed — this session's commands don't run until it is the directory it was (put it back), or it is removed from the session`;
}

/** The first word of a guarded argv's own: what {@link pinGuardArgv} adds before the program. */
export const PIN_GUARD_NAME = "codeoid-pins";

/**
 * sh, run as `sh -c <this> codeoid-pins <n> (<path> <id> <missing>)×n <argv…>`:
 * each path must be a directory whose physical path is itself (no link on
 * the way: `cd -P`), of `dev:ino` `<id>` unless that is `-` (`stat` prints
 * it: the absolute program found when the script is made; without one only
 * the rest is checked), present unless `<missing>` is 1; then the program
 * runs (exec), else it exits 126 saying which.
 */
export function pinGuardScript(stat: readonly string[] | null): string {
  const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
  return [
    "n=$1; shift",
    'while [ "$n" -gt 0 ]; do',
    '  p=$1; id=$2; m=$3; shift 3; n=$((n - 1))',
    '  if [ ! -e "$p" ] && [ ! -L "$p" ]; then',
    '    [ "$m" = 1 ] && continue',
    '    printf "codeoid sandbox: %s is gone: not run\\n" "$p" >&2; exit 126',
    "  fi",
    '  r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || r=',
    '  if [ "$r" != "$p" ]; then printf "codeoid sandbox: %s is not the directory it was (a symbolic link is in its path, or it is not a directory): not run\\n" "$p" >&2; exit 126; fi',
    ...(stat
      ? [`  if [ "$id" != - ] && [ "$(${stat.map(quote).join(" ")} -- "$p" 2>/dev/null)" != "$id" ]; then printf "codeoid sandbox: %s is not the directory it was (another one is there now): not run\\n" "$p" >&2; exit 126; fi`]
      : []),
    "done",
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
  return ["/bin/sh", "-c", pinGuardScript(statProgram()), PIN_GUARD_NAME, String(pins.length), ...pins.flatMap((p) => [p.path, p.id ?? "-", p.mayBeMissing ? "1" : "0"]), ...argv];
}

/** The program a guarded argv runs (what follows the guard's own words), for a caller that names it (the git shim). */
export function unguardedArgv(argv: readonly string[]): string[] {
  if (argv[0] !== "/bin/sh" || argv[3] !== PIN_GUARD_NAME) return [...argv];
  const n = Number(argv[4]);
  return argv.slice(5 + n * 3);
}
