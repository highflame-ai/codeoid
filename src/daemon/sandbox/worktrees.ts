/**
 * Worktrees an agent makes inside the sandbox (#448 follow-up, reworked in
 * round 10 to a folder per session).
 *
 * Agents branch in a worktree of their own (`git worktree add <path> -b
 * <branch>`), never in a checkout others share. Inside the sandbox that
 * needs two things the repository's structure otherwise holds read-only:
 * git making a new admin dir under `<common>/worktrees/`, and the checkout
 * landing outside the workspace. So:
 *
 *   - `<common>/worktrees/` is writable, bound at its own path (it can't be
 *     renamed away and rebuilt), and every admin dir in it when the spec is
 *     built that isn't the session's own is held read-only whole;
 *   - each of the repository's **worktree locations** (the sibling
 *     `<repo>-worktrees/`, codeoid's own convention, git-worktree.ts;
 *     `<root>/<repo>/` for each `sandbox.worktreeRoots` entry:
 *     {@link worktreeLocationDirs}) holds one **folder per session**
 *     ({@link sessionFolderName}), and only the session's own folder is
 *     writable to it ({@link worktreeFoldersOf}). Everything else in a
 *     location stays read-only: the user's worktrees, other sessions'
 *     folders, codeoid's own fork, loop and `--worktree` checkouts, and
 *     anything anyone makes there later (the writable set is the folder,
 *     fixed by name). Nothing is made inside the user's checkout (#448 round
 *     11): a `.worktrees/` already there is no location, and is held
 *     read-only whole for a session working in that checkout (other
 *     sessions' worktrees may be in it).
 *
 * Which admin dirs are the session's own, and whether the others are as git
 * made them, is worktree-entries.ts's: what the agent made in its folder is
 * its own output, like the workspace.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { makeAt } from "./pinned.js";
import type { GitLayout } from "./policy.js";

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

// paths: a repository's layout, found once at a spec build (a link from the main checkout's parent down is refused: `linked`); what it gives is pinned by the spec, and made only through makeAt
function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// paths: a look (is it a link: then refused), no write
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A dir of the daemon user's own, not a link. */
// paths: a look, no write
function ownDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== "function" || st.uid === process.getuid());
  } catch {
    return false;
  }
}

/** Checkouts codeoid itself made (a fork's, a loop's): never a session's own, wherever they are. */
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

/** The short id in a session's folder name: the session id's first 8 letters and digits. */
export function sessionShortId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase() || "session";
}

/**
 * A session's worktree folder name: its name, made filesystem-safe, and a
 * short id (`fix-login-3f9a2c1d`), so it reads as the session's and never
 * collides with another's. Never `.`, `..`, empty or holding a `/`.
 */
export function sessionFolderName(name: string, sessionId: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40)
      .replace(/[-.]+$/g, "") || "session";
  return `${slug}-${sessionShortId(sessionId)}`;
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

/** The repository's worktree location by default, beside its main checkout: codeoid's sibling dir (never anything inside the checkout). */
export function defaultWorktreeLocations(main: string): string[] {
  return [join(dirname(main), `${basename(main)}-worktrees`)];
}

/** Dirs no worktree root may be in, or be: the system's. */
const SYSTEM_DIRS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/proc", "/run", "/sbin", "/sys", "/usr", "/var/run", "/Applications", "/Library", "/System", "/private/etc", "/private/var/run"];

/**
 * Why a `sandbox.worktreeRoots` entry can't be one, or null (#448 round 10).
 * A root is shared by every repository (each gets `<root>/<repo>/`, each
 * session a folder there), so it must be a place of yours where nothing
 * found is run outside the sandbox: never `/`, the home or a dir holding it,
 * anything in a hidden dir of the home (`~/.config`, `~/.local`, `~/.ssh`,
 * shell and systemd user dirs, the backends' homes, codeoid's own: what
 * tools load programs and settings from), `~/Library` (LaunchAgents), a dir
 * holding codeoid's config dir or inside it, or a system dir. A relative
 * one (the main checkout's) never climbs more than one level (`../wt`), and
 * is never the checkout itself or its parent (which hold the repository).
 */
export function worktreeRootProblem(root: string, ctx: { home?: string; configDir?: string; platform?: NodeJS.Platform } = {}): string | null {
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  // macOS's filesystem ignores case (`/Users/ME/.config` is `~/.config`), and its realpath doesn't always fix it.
  const fold = (p: string) => ((ctx.platform ?? process.platform) === "darwin" ? p.toLowerCase() : p);
  const p = root === "~" ? home : root.startsWith("~/") ? join(home, root.slice(2)) : root;
  if (!p.trim()) return "an empty path";
  if (!isAbsolute(p)) {
    const n = normalize(p).replace(/\/+$/, "");
    if (n === "." || n === "" || n === "..") return `${root} is the repository or the dir holding it`;
    if (n.startsWith(`..${sep}..`)) return `${root} climbs more than one level above the repository (it could reach your home)`;
    return null;
  }
  const abs = resolve(p);
  const real = realOr(abs);
  const homes = [...new Set([home, realOr(home)].map(fold))];
  for (const at of new Set([abs, real].map(fold))) {
    if (at === "/") return `${root} is /`;
    if (homes.some((h) => within(h, at))) return `${root} is your home or holds it`;
    for (const h of homes) {
      if (!within(at, h) || at === h) continue;
      const first = at.slice(h.length + 1).split("/")[0] ?? "";
      if (first.startsWith(".")) return `${root} is in a hidden dir of your home (~/${first}), where tools load programs and settings from outside the sandbox`;
      if (first === fold("Library")) return `${root} is in ~/Library (LaunchAgents and app settings run outside the sandbox)`;
    }
    if (ctx.configDir) {
      const cfg = fold(resolve(ctx.configDir));
      if (within(at, cfg) || within(cfg, at)) return `${root} is codeoid's config dir, in it or holds it`;
    }
    const sys = SYSTEM_DIRS.find((d) => within(at, fold(d)));
    if (sys) return `${root} is a system dir (${sys})`;
  }
  return null;
}

/** One place worktrees of the repository go, and what made it one. */
export interface WorktreeLocation {
  /** Absolute: `<repo>-worktrees`, `<main>/.worktrees`, or `<root>/<repo>`. */
  dir: string;
  /** For a configured root: the root as written, and where it is. */
  root?: { written: string; at: string };
}

/**
 * The repository's worktree locations, with no side effect: the defaults
 * ({@link defaultWorktreeLocations}; a submodule gets only the configured
 * ones, its sibling being inside its superproject) and `<root>/<repo>` for
 * each of `roots` (`~` expands, a relative one is the main checkout's),
 * scoped by repository so a root shared by several holds each one's apart.
 * A root {@link worktreeRootProblem} refuses is in `problems`, not here, as
 * written and again once resolved, links and all (#448 round 11: `../.config`
 * of a repository in the home is `~/.config`); so is one inside the main
 * checkout (nothing is made in the user's checkout, and its project settings
 * dirs are there).
 */
export function worktreeLocationDirs(layout: GitLayout, opts: { roots?: readonly string[]; home?: string; configDir?: string; platform?: NodeJS.Platform } = {}): { locations: WorktreeLocation[]; problems: string[] } {
  const main = mainCheckoutOf(layout);
  const locations: WorktreeLocation[] = [];
  const problems: string[] = [];
  if (!main || !layout.common) return { locations, problems };
  const home = resolve(opts.home ?? process.env.HOME ?? homedir());
  if (layout.kind !== "submodule") for (const d of defaultWorktreeLocations(main)) locations.push({ dir: d });
  const ctx = { home, ...(opts.configDir ? { configDir: opts.configDir } : {}), ...(opts.platform ? { platform: opts.platform } : {}) };
  for (const r of opts.roots ?? []) {
    const p = r === "~" ? home : r.startsWith("~/") ? join(home, r.slice(2)) : r;
    const at = resolve(isAbsolute(p) ? p : join(main, p));
    // As written (a relative one may climb one level only), then where it really is.
    const written = worktreeRootProblem(r, ctx);
    const resolved = written ? null : worktreeRootProblem(at, ctx);
    const problem = written ?? (resolved ? `${r} → ${resolved}` : null);
    if (problem) {
      problems.push(`sandbox.worktreeRoots: ${problem}: not used`);
      continue;
    }
    if (within(at, resolve(main)) || within(realOr(at), realOr(main))) {
      problems.push(`sandbox.worktreeRoots: ${r} is inside the repository's checkout (${resolve(main)}), where nothing is made: not used`);
      continue;
    }
    locations.push({ dir: join(at, basename(main)), root: { written: r, at } });
  }
  return { locations, problems };
}

/**
 * What the sandbox's limits say of `sandbox.worktreeRoots` for this
 * repository, with no side effect: a root refused, or one that isn't there
 * and isn't beside the repository (never made: create it to use it).
 */
export function worktreeRootNotes(layout: GitLayout, opts: { roots?: readonly string[]; home?: string; configDir?: string } = {}): string[] {
  const main = mainCheckoutOf(layout);
  if (!main || !opts.roots?.length) return [];
  const { locations, problems } = worktreeLocationDirs(layout, opts);
  const beside = (at: string) => within(at, dirname(resolve(main))) && !within(at, resolve(main));
  for (const l of locations) {
    if (l.root && !ownDir(l.root.at) && !beside(l.root.at)) problems.push(`sandbox.worktreeRoots: ${l.root.written} (${l.root.at}) isn't a dir of yours — create it to use it: not used`);
  }
  return problems;
}

/** What a session's sandbox makes of the repository's worktree locations. */
export interface WorktreeFolders {
  /** The session's own folder in each location: writable, made where missing. */
  folders: string[];
  /**
   * The locations those folders are in: shown read-only (a sandbox that
   * hides the home shows them again), so a worktree added anywhere else in
   * one fails, as it does where they aren't hidden, rather than land in a
   * throwaway dir (Claude's own sandbox makes a hidden home a scratch dir).
   */
  locations: string[];
  /** Locations inside the workspace: held read-only whole (other sessions' folders are there). */
  held: string[];
  /** Why a location gives no folder (a root refused or missing): the sandbox's limits say so. */
  problems: string[];
}

/**
 * The session's folder `<location>/<folder>` in each worktree location
 * ({@link worktreeLocationDirs}), made where missing (a mount needs
 * something to mount): the defaults themselves where their parent is
 * there, a configured root's `<repo>` dir in it, but a configured root only
 * when it is beside the repository (in its main checkout's parent): one
 * elsewhere that isn't there is said, never made. Never a location of `/`,
 * the home or a dir holding it, one holding the main checkout or the
 * repository's git dir or inside it, one another user owns, and never one
 * that is (or is reached through) a link below the main checkout's parent
 * (a command could have planted it). A location inside the workspace isn't
 * given a folder: it is held read-only whole. Nothing is made inside the
 * main checkout: a `.worktrees/` already there is held read-only whole for a
 * session working in it (#448 round 11), never made.
 */
export function worktreeFoldersOf(
  layout: GitLayout,
  folderName: string,
  opts: { roots?: readonly string[]; home?: string; workspace?: string; configDir?: string; make?: boolean } = {},
): WorktreeFolders {
  const out: WorktreeFolders = { folders: [], locations: [], held: [], problems: [] };
  const main = mainCheckoutOf(layout);
  if (!main || !layout.common) return out;
  if (!folderName || folderName.includes("/") || folderName === "." || folderName === "..") return out;
  const make = opts.make !== false;
  const home = resolve(opts.home ?? process.env.HOME ?? homedir());
  const common = realOr(layout.common);
  const mainLit = resolve(main);
  const mainReal = realOr(main);
  const ws = opts.workspace ? resolve(opts.workspace) : null;
  const { locations, problems } = worktreeLocationDirs(layout, { home, ...(opts.roots ? { roots: opts.roots } : {}), ...(opts.configDir ? { configDir: opts.configDir } : {}) });
  out.problems.push(...problems);
  // Never through a link: one a session's command made where it could write (`.worktrees` in the main checkout)
  // would hand the next session a writable dir anywhere. From the main checkout's parent down for what is below
  // it, else from the location's parent.
  const linked = (at: string, base: string): boolean => {
    for (let p = at; p !== base && within(p, base); p = dirname(p)) if (isLink(p)) return true;
    return false;
  };
  const mk = (p: string): void => {
    if (!make) return;
    try {
      // Never through a link (pinned.ts: its parent pinned for the make, checked again after; #448 round 14).
      makeAt(p, "dir", "making a worktree folder");
    } catch {
      /* there already, or can't be made: then only an existing one is used */
    }
  };
  for (const loc of locations) {
    const at = resolve(loc.dir);
    const base = within(at, dirname(mainLit)) ? dirname(mainLit) : loc.root ? dirname(loc.root.at) : dirname(at);
    if (linked(at, base)) {
      if (loc.root) out.problems.push(`sandbox.worktreeRoots: ${loc.root.written} is reached through a link: not used`);
      continue;
    }
    if (loc.root && !ownDir(loc.root.at)) {
      // Beside the repository it is made; elsewhere it must be there already (never made where you didn't say).
      if (within(loc.root.at, dirname(mainLit)) && !within(loc.root.at, mainLit)) mk(loc.root.at);
      if (!ownDir(loc.root.at)) {
        out.problems.push(`sandbox.worktreeRoots: ${loc.root.written} (${loc.root.at}) isn't a dir of yours — create it to use it: not used`);
        continue;
      }
    }
    mk(at);
    if (linked(at, base) || !ownDir(at)) continue;
    const real = realOr(at);
    if (real === "/" || within(home, real) || within(realOr(home), real)) continue;
    if (within(mainReal, real) || within(common, real) || within(real, common)) continue;
    // Inside the workspace: other sessions' folders are there, so all of it is held (and no folder of this one's).
    if (ws && (within(at, ws) || within(real, realOr(ws)))) {
      if (!out.held.includes(real)) out.held.push(real);
      continue;
    }
    const folder = join(real, folderName);
    mk(folder);
    if (!ownDir(folder) || isLink(folder)) continue;
    // A folder holding the workspace: writable already.
    if (ws && within(ws, folder)) continue;
    if (!out.folders.includes(folder)) out.folders.push(folder);
    if (!out.locations.includes(real)) out.locations.push(real);
  }
  // Worktrees a user (or an earlier codeoid) put in the checkout's `.worktrees/`: not a location, but not the agent's to change.
  const dot = join(mainLit, ".worktrees");
  if (ws && within(dot, ws) && ownDir(dot) && !linked(dot, dirname(mainLit)) && !out.held.includes(realOr(dot))) out.held.push(realOr(dot));
  return out;
}

/**
 * The name of a session's folder: one already in a location ending in its
 * short id (made under an earlier name: a rename keeps its folder), else
 * {@link sessionFolderName}. Only a dir of the daemon user's own, never a
 * link, counts.
 */
export function existingFolderName(locations: readonly WorktreeLocation[], sessionId: string): string | null {
  const suffix = `-${sessionShortId(sessionId)}`;
  for (const loc of locations) {
    let names: string[] = [];
    // paths: a look (which folder names a location holds), no write
    try {
      names = readdirSync(loc.dir).filter((n) => n.endsWith(suffix) && n.length > suffix.length);
    } catch {
      continue;
    }
    for (const n of names.sort()) if (ownDir(join(loc.dir, n))) return n;
  }
  return null;
}

/**
 * The session's note to its agent on where git worktrees go (its system
 * prompt, every backend: Session's prompt append), since a `git worktree
 * add` anywhere else fails with the OS's bare "Read-only file system".
 */
export function worktreeFolderNote(folders: readonly string[]): string {
  const where = folders.map((f) => `${f}/`).join(" or ");
  return `# Git worktrees in this sandbox\nCreate git worktrees under ${where} (e.g. \`git worktree add ${folders[0]}/<name> -b <branch>\`): that is this session's own worktree folder. Other worktree locations, other sessions' folders and the repository's existing worktrees are read-only in this sandbox, so \`git worktree add\` elsewhere fails with "Read-only file system".`;
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
  // paths: a look at the repository's worktree admin dirs, no write
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
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
 * Whether `admin` is checked out in one of the session's folders
 * (`folders`), and not codeoid's own, as its `gitdir` says: the verdict of a
 * spec built without a session's record of its own entries (a check's, the
 * git shim's: no folder there). A session's sandbox decides by its record
 * (worktree-entries.ts), never by this file alone, which a command can write.
 */
export function isOwnWorktree(admin: WorktreeAdmin, folders: readonly string[]): boolean {
  if (!admin.dotgit || folders.length === 0) return false;
  const checkout = dirname(admin.dotgit);
  if (madeByCodeoid(checkout)) return false;
  const real = realOr(checkout);
  return folders.some((f) => (within(real, realOr(f)) || within(resolve(checkout), f)) && resolve(checkout) !== resolve(f));
}
