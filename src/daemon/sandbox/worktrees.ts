/**
 * Worktrees an agent makes inside the sandbox (#448 follow-up).
 *
 * Agents branch in a worktree of their own (`git worktree add <path> -b
 * <branch>`), never in a checkout others share. Inside the sandbox that
 * needs two things the repository's structure otherwise holds read-only:
 * git making a new admin dir under `<common>/worktrees/`, and the checkout
 * landing outside the workspace. So:
 *
 *   - `<common>/worktrees/` is writable, bound at its own path (it can't be
 *     renamed away and rebuilt);
 *   - the repository's **worktree locations** are writable: the sibling
 *     `<repo>-worktrees/` (codeoid's own convention, git-worktree.ts), the
 *     repository's `.worktrees/`, and `sandbox.worktreeRoots`
 *     ({@link worktreeLocationsOf});
 *   - every worktree that isn't the session's own is held read-only whole:
 *     its admin dir (so it can't be rewritten, renamed, removed or pruned),
 *     its checkout's `.git` file, and its whole checkout when that is in a
 *     worktree location (so `git worktree remove --force` deletes nothing of
 *     it). The session's own are those that appeared since the session's
 *     sandbox first looked ({@link worktreeAdminsOf}, its baseline), checked
 *     out where a command of it could have put one, and not made by codeoid
 *     itself ({@link noteCodeoidWorktree}: a fork's, a loop's).
 *
 * A worktree the agent made is its own output, like the workspace.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { GitLayout } from "./policy.js";

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Checkouts codeoid itself made (a fork's, a loop's): never a session's own, whenever they appeared. */
const codeoidMade = new Set<string>();

/** Record a worktree checkout codeoid makes, before git makes it (git-worktree.ts). */
export function noteCodeoidWorktree(checkout: string): void {
  codeoidMade.add(resolve(checkout));
  codeoidMade.add(realOr(resolve(checkout)));
}

/** Whether codeoid made the worktree checked out at `checkout` (in this daemon's life). */
export function madeByCodeoid(checkout: string): boolean {
  return codeoidMade.has(resolve(checkout)) || codeoidMade.has(realOr(resolve(checkout)));
}

/**
 * The repository's main checkout, as `git worktree list` names it first
 * (git-worktree.ts `mainWorktreeRoot`): the dir holding a `.git` dir, a
 * bare repository itself, a submodule's checkout. Null for a layout codeoid
 * can't verify.
 */
export function mainCheckoutOf(layout: GitLayout): string | null {
  if (!layout.common) return null;
  if (layout.kind === "worktree") return basename(layout.common) === ".git" ? dirname(layout.common) : layout.common;
  return dirname(layout.dotgit);
}

/** The repository's worktree locations by default, relative to its main checkout: codeoid's sibling dir and `.worktrees/`. */
export function defaultWorktreeLocations(main: string): string[] {
  return [join(dirname(main), `${basename(main)}-worktrees`), join(main, ".worktrees")];
}

/**
 * Where a command may check a new worktree of the repository out: the
 * defaults ({@link defaultWorktreeLocations}) and `roots`
 * (`sandbox.worktreeRoots`: `~` expands, a relative one is the main
 * checkout's), absolute and real. Never `/`, the home or a dir holding it,
 * one holding the main checkout or the repository's git dir, or one inside
 * the git dir, none inside `workspace` (writable already), and none that is
 * a link or is reached through one below the main checkout's parent, or
 * isn't the daemon user's own. Made where
 * missing (the defaults only where their parent is there): a mount needs
 * something to mount.
 */
export function worktreeLocationsOf(layout: GitLayout, opts: { roots?: readonly string[]; home?: string; workspace?: string } = {}): string[] {
  const main = mainCheckoutOf(layout);
  if (!main || !layout.common) return [];
  const home = resolve(opts.home ?? process.env.HOME ?? homedir());
  const common = realOr(layout.common);
  const mainReal = realOr(main);
  const out: string[] = [];
  const ws = opts.workspace ? resolve(opts.workspace) : null;
  const mainLit = resolve(main);
  // Never through a link: one a session's command made where it could write (`.worktrees` in the main checkout,
  // a dir in a location) would hand the next session a writable dir anywhere. From the main checkout's parent
  // down for what is below it, else the location itself.
  const linked = (at: string): boolean => {
    const base = within(at, dirname(mainLit)) ? dirname(mainLit) : dirname(at);
    for (let p = at; p !== base && within(p, base); p = dirname(p)) if (isLink(p)) return true;
    return false;
  };
  const add = (p: string, recursive: boolean) => {
    const at = resolve(p);
    // Inside the workspace it is writable already: nothing to mount, so nothing is made there.
    if (ws && within(at, ws)) return;
    if (linked(at)) return;
    try {
      mkdirSync(at, { recursive, mode: 0o755 });
    } catch {
      /* there already, or can't be made: then only an existing one is used */
    }
    try {
      const st = lstatSync(at);
      // Ours: in a shared dir (a repository right under /tmp) another user could have made it first.
      if (linked(at) || !st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) return;
    } catch {
      return;
    }
    const real = realOr(at);
    if (real === "/" || within(home, real) || within(realOr(home), real)) return;
    if (within(mainReal, real) || within(common, real) || within(real, common)) return;
    if (!out.includes(real)) out.push(real);
  };
  // A submodule's sibling would be made inside its superproject's working tree: only the configured roots there.
  if (layout.kind !== "submodule") for (const d of defaultWorktreeLocations(main)) add(d, false);
  for (const r of opts.roots ?? []) {
    const p = r === "~" ? home : r.startsWith("~/") ? join(home, r.slice(2)) : r;
    add(isAbsolute(p) ? p : join(main, p), true);
  }
  return out;
}

/** One linked worktree of a repository: its admin dir and where its `.git` file is (as its `gitdir` names it). */
export interface WorktreeAdmin {
  /** `<common>/worktrees/<name>`. */
  dir: string;
  /** The checkout's `.git` file, absolute; null when its `gitdir` can't be read. */
  dotgit: string | null;
}

/** The linked worktrees in `<common>/worktrees/` (bounded). */
export function worktreeAdminsOf(common: string, limit = 500): WorktreeAdmin[] {
  const dir = join(common, "worktrees");
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .slice(0, limit);
  } catch {
    return [];
  }
  return names.map((n) => {
    const at = join(dir, n);
    let dotgit: string | null = null;
    try {
      const named = readFileSync(join(at, "gitdir"), "utf8").trim();
      dotgit = named ? resolve(at, named) : null;
    } catch {
      /* no gitdir: a half-made or broken worktree */
    }
    return { dir: at, dotgit };
  });
}

/**
 * Whether `admin` is a worktree the session made itself: not there when
 * its sandbox first looked (`baseline`, admin dirs by path), checked out
 * where a command could put one (the workspace, a worktree location), and
 * not codeoid's own. Without a baseline nothing is.
 */
export function isOwnWorktree(admin: WorktreeAdmin, baseline: ReadonlySet<string> | undefined, writable: readonly string[]): boolean {
  if (!baseline || baseline.has(admin.dir) || !admin.dotgit) return false;
  const checkout = dirname(admin.dotgit);
  if (madeByCodeoid(checkout)) return false;
  const real = realOr(checkout);
  return writable.some((w) => within(real, realOr(w)) || within(resolve(checkout), w));
}
