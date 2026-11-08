/**
 * Working across repositories (#448 follow-up, docs/sandbox.md "Working
 * across repositories"): what a session may read besides its workspace, and
 * what it may write.
 *
 *   - project roots (`sandbox.projectRoots`, a session's own at create):
 *     readable whole, read-only. The default, {@link PROJECT_ROOT_PARENT}, is
 *     the parent of the session's repository (`~/Workspace` for a session in
 *     `~/Workspace/codeoid`), so its commands read the other repositories
 *     there, and see what other sessions did in their checkouts. What the
 *     sandbox hides anywhere stays hidden in them (credential stores,
 *     codeoid's own dirs, the agents' logins, container sockets), and so do
 *     the secret files at a project's top ({@link projectRootSecrets});
 *   - added directories (`SessionSandboxSetting.addedDirs`): writable, each
 *     as a workspace is (its git structure and project settings held, its
 *     own worktree folder). Added by the owner, or asked for by the agent
 *     (`request_directory`, request-directory.ts).
 *
 * Neither may be a place whose contents run outside the sandbox, the home or
 * `/` ({@link sandboxDirProblem}); an added one, nothing the sandbox hides
 * ({@link addedDirProblem}).
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitLayoutOf } from "./policy.js";
import { type DirContext, normalizeSandboxDir, PROJECT_ROOT_PARENT, sandboxDirProblem } from "./dir-rules.js";
import { mainCheckoutOf } from "./worktrees.js";

export { type DirContext, normalizeSandboxDir, PROJECT_ROOT_PARENT, sandboxDirProblem };

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

export interface AddedDirContext extends DirContext {
  /** What every sandbox hides (policy.ts `hiddenPathsFor`): an added dir is never in one. */
  hidden?: readonly string[];
  /** The daemon's `PATH`: a dir on it (or holding an entry of it) runs outside the sandbox. */
  path?: string;
}

/**
 * Why `dir` can't be added to a session's writable directories, or null:
 * {@link sandboxDirProblem}, then it must be a directory of the daemon's
 * user (not a link: where it leads is what is added), outside everything
 * the sandbox hides, and hold no dir of the daemon's `PATH` (a program
 * written there runs outside any sandbox at the user's next command).
 */
export function addedDirProblem(dir: string, ctx: AddedDirContext = {}): string | null {
  const basic = sandboxDirProblem(dir, ctx);
  if (basic) return basic;
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  const abs = normalizeSandboxDir(dir, home) as string;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(realOr(abs));
  } catch {
    return `${dir} doesn't exist`;
  }
  if (!st.isDirectory()) return `${dir} isn't a directory`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${dir} isn't yours (another user owns it)`;
  const real = realOr(abs);
  for (const h of ctx.hidden ?? []) {
    const hr = realOr(h);
    // In one: what is hidden isn't the session's to write. Holding one is fine: it stays hidden inside.
    if (within(abs, h) || within(real, hr)) return `${dir} is in what the sandbox hides (${h})`;
  }
  for (const entry of (ctx.path ?? process.env.PATH ?? "").split(":")) {
    if (!entry || !isAbsolute(entry)) continue;
    if (within(resolve(entry), abs) || within(realOr(entry), real)) return `${dir} holds ${entry}, which is on your PATH: a program written there would run outside the sandbox`;
  }
  return null;
}

/**
 * The default project root for a session working in `workspace`: the
 * parent of its repository's main checkout (a linked worktree's too, so a
 * fork in `<repo>-worktrees/` reads `<repo>`'s siblings), or the parent of
 * the workspace when it isn't in a repository.
 */
export function defaultProjectRoot(workspace: string, home: string = process.env.HOME ?? homedir()): string {
  const ws = resolve(workspace);
  const layout = gitLayoutOf(ws, home);
  const top = layout ? (mainCheckoutOf(layout) ?? dirname(layout.dotgit)) : ws;
  return dirname(resolve(top));
}

export interface ResolvedRoots {
  /** Absolute, existing dirs, deduplicated (by where they really are). */
  roots: string[];
  /** What wasn't used, and why (the sandbox's limits say it). */
  notes: string[];
}

/**
 * `entries` (the session's own, else `sandbox.projectRoots`) for a session
 * working in `workspace`: {@link PROJECT_ROOT_PARENT} as
 * {@link defaultProjectRoot}, a default that would be the home (a
 * repository directly in it) or another refused place falling back to no
 * root, said; anything else refused by {@link sandboxDirProblem} or not
 * there, said and not used.
 */
export function resolveProjectRoots(entries: readonly string[], workspace: string, ctx: DirContext = {}): ResolvedRoots {
  const home = resolve(ctx.home ?? process.env.HOME ?? homedir());
  const out: ResolvedRoots = { roots: [], notes: [] };
  const seen = new Set<string>();
  for (const entry of entries) {
    const isDefault = entry === PROJECT_ROOT_PARENT;
    const at = isDefault ? defaultProjectRoot(workspace, home) : normalizeSandboxDir(entry, home);
    const problem = at === null ? `${entry} isn't an absolute path` : sandboxDirProblem(at, { ...ctx, home });
    if (problem || at === null) {
      out.notes.push(
        isDefault
          ? `no project root: the default, the repository's parent (${at}), ${problem?.replace(/^\S+ is /, "is ") ?? "can't be one"} — set sandbox.projectRoots (or the session's own) to read other repositories`
          : `project root ${entry}: ${problem}: not used`,
      );
      continue;
    }
    let dir = false;
    try {
      dir = lstatSync(realOr(at)).isDirectory();
    } catch {
      /* not there */
    }
    if (!dir) {
      if (!isDefault) out.notes.push(`project root ${entry} (${at}) isn't a directory here: not used`);
      continue;
    }
    const real = realOr(at);
    if (seen.has(real)) continue;
    seen.add(real);
    out.roots.push(at);
  }
  return out;
}

/** Secret files at a project's top: dotenv files (not their examples), direnv's, a project's registry tokens. */
const PROJECT_SECRET_FILE = /^(?:\.env(?:\.(?!(?:example|sample|template|dist|defaults?|schema)$)[^/]+)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i;

/**
 * The secret files at the top of each project under the `roots` (the root
 * itself and each dir directly in it: `~/Workspace/b/.env`), hidden like
 * the credential stores are, but in `writable` (the session's own
 * workspace and added dirs: its own project's `.env` is its to use).
 * Found when the spec is built: one made later isn't hidden. Bounded.
 */
export function projectRootSecrets(roots: readonly string[], writable: readonly string[], limit = 2000): string[] {
  const out: string[] = [];
  const mine = writable.flatMap((w) => [resolve(w), realOr(w)]);
  const owned = (p: string) => mine.some((w) => within(p, w) || within(realOr(p), w));
  let budget = limit;
  const scan = (dir: string): void => {
    if (owned(dir)) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) if (PROJECT_SECRET_FILE.test(n)) out.push(join(dir, n));
  };
  for (const root of roots) {
    scan(root);
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (--budget < 0) return out;
      if (e.isDirectory()) scan(join(root, e.name));
    }
  }
  return out;
}

/** Whether `p` is in one of `dirs` (as written or where it really is). */
export function inAnyDir(p: string, dirs: readonly string[]): boolean {
  const abs = resolve(p);
  const real = realOr(abs);
  return dirs.some((d) => within(abs, resolve(d)) || within(real, realOr(d)));
}
