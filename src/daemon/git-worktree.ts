/**
 * Git worktree isolation for `session.fork`.
 *
 * A fork must not share the parent's working directory — two agents editing
 * the same files collide. When the parent's workdir is a git repo, a fork gets
 * its OWN git worktree on its OWN branch, seeded with the parent's CURRENT
 * working state (uncommitted tracked changes included), while the parent's
 * checkout is left byte-for-byte untouched.
 *
 * The "carry current state without disturbing the parent" trick:
 *
 *   1. `git stash create` in the parent → a commit object of the dirty tracked
 *      state (empty when clean). It mutates nothing: no index, no working tree,
 *      no stash list — the parent session keeps working uninterrupted.
 *   2. `git worktree add -b <branch> <dir> <snapshot|HEAD>` → a fresh worktree
 *      + branch at that state.
 *   3. If we based on a snapshot, `git reset --mixed <parent-HEAD>` in the new
 *      worktree moves the branch tip back to HEAD and re-materializes the
 *      carried changes as UNCOMMITTED edits — so the fork opens exactly where
 *      the parent was.
 *
 * Untracked/ignored files are NOT carried (git stash create only snapshots
 * tracked content); the repository's setup recipe (workspace-setup.ts) copies
 * the ignored files it names and shares its dependency dirs. Everything here runs the local
 * `git` binary via execFile (the daemon is co-located with the repo); there is
 * no remote-host tunnel.
 *
 * Ownership: only worktrees codeoid CREATED are ever removed (see
 * SessionInfo.worktree.createdByCodeoid). A worktree the user pointed a fork
 * at (bind mode) is theirs and is never touched.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, type Stats, unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { GIT_BIN, gitEnv, hardenedGit } from "./git-env.js";

const execFileP = promisify(execFile);

/**
 * Run git in `cwd`. Generous buffer for large `worktree list` output. Hooks
 * and fsmonitor are off: the daemon runs these on the user's behalf, and a
 * repo the agent can write to must not get code run by them (a
 * `post-checkout` hook would fire on every fork).
 */
async function git(args: string[], cwd: string): Promise<string> {
  return plainGit(args, cwd);
}

async function plainGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP(GIT_BIN, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    // An agent's config can make git run a command (a filter on checkout);
    // it gets an agent's environment, never the daemon's.
    env: gitEnv({}, { network: true }),
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** True when `workdir` is inside a git working tree. */
export async function isGitRepo(workdir: string): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], workdir)).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Validate a branch name against the subset of `git check-ref-format` rules
 * that matter for a single branch ref. Throws {@link WorktreeError} on a bad
 * name so a caller-supplied branch can't inject git args or a broken ref.
 */
export class WorktreeError extends Error {}

export function validateBranchName(name: string): void {
  const bad =
    !name ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name === "@" ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name);
  if (bad) throw new WorktreeError(`invalid branch name: ${JSON.stringify(name)}`);
}

/** Ref-safe, single-segment slug from an arbitrary label. */
function slug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  return s.length > 0 ? s : "session";
}

/**
 * Absolute path of the repo's MAIN working tree. `git worktree list
 * --porcelain`'s first record is always the main checkout, regardless of which
 * linked worktree we ask from — so new worktrees anchor beside the main repo
 * (`<repo>-worktrees/<name>`), never nested inside another worktree.
 */
export async function mainWorktreeRoot(workdir: string, opts: { hardened?: boolean } = {}): Promise<string> {
  const out = opts.hardened ? await hardenedGit(["worktree", "list", "--porcelain"], workdir) : await git(["worktree", "list", "--porcelain"], workdir);
  const line = out.split("\n").find((l) => l.startsWith("worktree "));
  if (!line) throw new WorktreeError("could not resolve the repo's main worktree");
  return line.slice("worktree ".length).trim();
}

export interface ForkWorktree {
  /** Absolute path of the created worktree ROOT — used for git ops (removal). */
  path: string;
  /**
   * The fork's ACTIVE working directory: the worktree root joined with the
   * parent's subdirectory within its own checkout. When the parent session
   * worked in a repo subdir (e.g. `packages/api`), the fork opens in the
   * equivalent subdir of the new worktree, not its root — so relative paths,
   * tooling, and scripts keep working. Equals `path` when the parent was at
   * the checkout root.
   */
  workdir: string;
  /** Branch checked out in the worktree (e.g. "codeoid/fix-login-a1b2c3"). */
  branch: string;
  /**
   * Whether `workdir` is the parent's subdirectory equivalent (always true
   * at the checkout root). False when the subdir doesn't exist in the new
   * checkout and the fork fell back to the worktree root — paths relative to
   * the parent's workdir then don't line up with the fork's.
   */
  subdirMapped: boolean;
  /**
   * With `deferCarry`: the parent's uncommitted tracked state, not yet in the
   * worktree (which is a clean checkout of `head`). Apply it with
   * {@link applyCarriedState} once setup has run.
   */
  carry?: CarriedState;
}

/** A parent's uncommitted tracked state (`git stash create`) and the HEAD it sits on. */
export interface CarriedState {
  snapshot: string;
  head: string;
}

/**
 * Resolve a caller-supplied base ref to a commit, fetching once if it isn't
 * locally resolvable. Rejects a ref that looks like a git flag. Returns the ref
 * (validated to resolve) to hand to `worktree add`.
 */
async function resolveBaseRef(mainRoot: string, ref: string, opts: { fetch?: boolean } = {}): Promise<string> {
  if (!ref || ref.startsWith("-")) throw new WorktreeError(`invalid base ref: ${JSON.stringify(ref)}`);
  const resolves = async (): Promise<boolean> => {
    try {
      await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], mainRoot);
      return true;
    } catch {
      return false;
    }
  };
  if (await resolves()) return ref;
  if (opts.fetch === false) throw new WorktreeError(`base commit not found: ${JSON.stringify(ref)}`);
  await git(["fetch"], mainRoot).catch(() => {}); // best-effort: base may be remote-only
  if (await resolves()) return ref;
  throw new WorktreeError(`base ref not found: ${JSON.stringify(ref)}`);
}

/**
 * Create an isolated worktree for a fork. By default it carries the parent's
 * current tracked working state (parent untouched); with `baseBranch` it's a
 * CLEAN checkout of that ref instead. `workdir` is the PARENT's workdir (any
 * worktree of the repo). Throws {@link WorktreeError} on any git failure so the
 * caller can fall back to a shared workdir.
 */
export async function createForkWorktree(opts: {
  workdir: string;
  /** Human label (session name) → branch/dir slug. */
  label: string;
  /** Short unique suffix (e.g. first 8 of the fork's id). */
  shortId: string;
  /** Branch clean from this ref instead of carrying the parent's state. */
  baseBranch?: string;
  /**
   * Branch clean from this exact commit (a checkpoint's recorded HEAD, #356)
   * instead of carrying the parent's state. Internal: never user input.
   */
  baseCommit?: string;
  /**
   * Create the parent's subdirectory in the new checkout when it's missing
   * (an untracked directory isn't carried), so the fork still opens in it.
   */
  ensureSubdir?: boolean;
  /**
   * Check out the parent's HEAD clean and hand the uncommitted state back as
   * `carry` instead of applying it — so a setup command runs against
   * committed content only, never the parent's (agent-written) edits.
   */
  deferCarry?: boolean;
  /**
   * git runs as `hardenedGit` does — no filter driver, no network — for a
   * repository whose config an earlier agent may have written to run one
   * (a loop's). The repository must not depend on filters.
   */
  hardened?: boolean;
  /** Told the worktree's path before it is made (a loop claims it first). */
  onPath?: (worktreePath: string) => void;
}): Promise<ForkWorktree> {
  const mainRoot = await mainWorktreeRoot(opts.workdir, { hardened: opts.hardened === true });
  const git = opts.hardened ? (args: string[], cwd: string) => hardenedGit(args, cwd) : plainGit;

  const name = `${slug(opts.label)}-${opts.shortId}`;
  const branch = `codeoid/${name}`;
  validateBranchName(branch);
  const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-worktrees`, name);

  // Choose the base commit for the new worktree:
  //  - baseBranch given → CLEAN checkout of that ref (no parent state carried).
  //  - otherwise → snapshot the parent's dirty tracked state (mutates nothing);
  //    empty when clean → base on HEAD.
  let base: string;
  let parentHead: string | null = null;
  let carriedSnapshot = false;
  let deferred: CarriedState | undefined;
  if (opts.baseCommit) {
    if (!/^[0-9a-f]{40,64}$/.test(opts.baseCommit)) throw new WorktreeError("invalid base commit");
    // Local when it was recorded: a miss means it's gone (gc'd), not remote.
    base = await resolveBaseRef(mainRoot, opts.baseCommit, { fetch: false });
  } else if (opts.baseBranch) {
    base = await resolveBaseRef(mainRoot, opts.baseBranch);
  } else {
    try {
      parentHead = (await git(["rev-parse", "HEAD"], opts.workdir)).trim();
    } catch (err) {
      // Hardened git refuses some repositories outright; say why.
      if (err instanceof Error && err.message.includes("refusing to run git")) throw new WorktreeError(err.message);
      throw new WorktreeError("repository has no commits yet (unborn HEAD)");
    }
    const snapshot = (await git(["stash", "create"], opts.workdir)).trim();
    if (snapshot && opts.deferCarry) {
      base = parentHead;
      deferred = { snapshot, head: parentHead };
    } else {
      base = snapshot || parentHead;
      carriedSnapshot = snapshot.length > 0;
    }
  }

  opts.onPath?.(worktreePath);
  try {
    // --end-of-options: treat `base` as a rev, never a flag, so a value
    // starting with '-' can't inject a git option.
    await git(["worktree", "add", "-b", branch, worktreePath, "--end-of-options", base], mainRoot);
  } catch (err) {
    throw new WorktreeError(
      `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Carried-state mode: move the branch tip back to HEAD so the carried changes
  // show as UNCOMMITTED edits (not a snapshot commit).
  if (carriedSnapshot && parentHead) {
    try {
      await git(["reset", "--mixed", parentHead], worktreePath);
    } catch (err) {
      // The worktree exists but the reset failed — roll it back so we don't
      // leave a fork sitting on a snapshot commit.
      await removeForkWorktree({ workdir: mainRoot, worktreePath, branch, deleteBranch: true }).catch(
        () => {},
      );
      throw new WorktreeError(
        `git reset after worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Preserve the parent's subdirectory within its checkout: if the session was
  // working in `<repo>/packages/api`, the fork should open in
  // `<worktree>/packages/api`, not the worktree root. Relative to the PARENT's
  // OWN worktree top (handles a parent that is itself a linked worktree). The
  // existence check matters for baseBranch: the base may not have that subdir.
  // Every component must be a real directory INSIDE the checkout: the commit
  // checked out may be one the agent chose (#356's recorded HEAD), and a
  // tracked symlink in the path would point the fork — and the file roll into
  // it — outside its worktree.
  let workdir = worktreePath;
  let subdirMapped = true;
  try {
    const parentTop = (await git(["rev-parse", "--show-toplevel"], opts.workdir)).trim();
    const rel = path.relative(parentTop, opts.workdir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      const mapped = mapSubdir(worktreePath, rel, opts.ensureSubdir === true);
      if (mapped) workdir = mapped;
      else subdirMapped = false;
    }
  } catch {
    // Fall back to the worktree root — never fail the fork over a subdir hint.
    subdirMapped = false;
  }

  return { path: worktreePath, workdir, branch, subdirMapped, ...(deferred ? { carry: deferred } : {}) };
}

/**
 * Apply a deferred {@link CarriedState} to a worktree: its tracked files
 * become the snapshot's (edits and deletions included) as UNCOMMITTED
 * changes — the index stays at HEAD, exactly as the immediate path's
 * `reset --mixed` leaves it. Untracked and ignored files (what a setup recipe
 * put there) are left alone. Throws {@link WorktreeError}.
 */
export async function applyCarriedState(worktreePath: string, carry: CarriedState, opts: { hardened?: boolean } = {}): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/.test(carry.snapshot)) throw new WorktreeError("invalid carried snapshot");
  const git = opts.hardened ? (args: string[], cwd: string) => hardenedGit(args, cwd) : plainGit;
  try {
    await git(["restore", `--source=${carry.snapshot}`, "--worktree", "--", "."], worktreePath);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // Never leave a half-carried tree: put the tracked files back to HEAD
    // and take out the files the carry added.
    let added: string[] = [];
    try {
      added = (await git(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", carry.head, carry.snapshot], worktreePath)).split("\0").filter(Boolean);
    } catch {
      // the snapshot is unreadable, so the restore wrote nothing of it
    }
    try {
      await git(["restore", "--source=HEAD", "--worktree", "--", "."], worktreePath);
      removeSetupArtifacts(worktreePath, { copied: added });
    } catch (rollbackErr) {
      throw new WorktreeError(
        `couldn't carry the uncommitted changes (${why}), and putting the worktree back to its last commit failed too, so they may be partially applied: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }`,
      );
    }
    throw new WorktreeError(`couldn't carry the uncommitted changes (${why}); the worktree was put back to its last commit`);
  }
}

/**
 * `<root>/<rel>` when every component is a real directory (created when
 * missing and `create`), else null — a symlink or file anywhere on the way
 * refuses, and the result is checked to resolve inside `root`.
 */
function mapSubdir(root: string, rel: string, create: boolean): string | null {
  let at = root;
  for (const part of rel.split(path.sep)) {
    if (!part || part === "." || part === "..") return null;
    at = path.join(at, part);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(at);
    } catch {
      st = undefined;
    }
    if (!st) {
      if (!create) return null;
      mkdirSync(at); // non-recursive: the parent was just verified
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  }
  const realRoot = realpathSync(root);
  const real = realpathSync(at);
  return real === realRoot || real.startsWith(realRoot + path.sep) ? at : null;
}

/**
 * Remove a worktree codeoid created. Best-effort and idempotent: never throws.
 * `deleteBranch` defaults to FALSE — keeping the branch means a fork's work is
 * recoverable even after its session is destroyed.
 */
export async function removeForkWorktree(opts: {
  /** Any workdir of the repo (used to locate the main worktree for git). */
  workdir: string;
  worktreePath: string;
  branch?: string;
  deleteBranch?: boolean;
  /**
   * What the workspace setup recipe put in the worktree (worktree-relative,
   * see workspace-setup.ts). Taken out BEFORE the WIP snapshot: a copied
   * secret must never land in a commit (even if the agent un-ignored it), and
   * a shared directory's symlink is the primary checkout's, not the fork's work.
   */
  setup?: { copied?: readonly string[]; shared?: readonly string[] };
  /** Commit what's left in the worktree to the kept branch first (default
   *  true). A loop's worktree turns it off: its branch holds only what the
   *  run delivered, never what a worker left behind. */
  snapshot?: boolean;
  /** git runs as `hardenedGit` (a loop's worktree; see createForkWorktree). */
  hardened?: boolean;
}): Promise<void> {
  const mainRoot = await mainWorktreeRoot(opts.workdir, { hardened: opts.hardened === true }).catch(() => opts.workdir);
  const admin = opts.hardened ? (args: string[], cwd: string) => hardenedGit(args, cwd) : git;

  if (opts.setup) removeSetupArtifacts(opts.worktreePath, opts.setup);

  // Preserve uncommitted work on the KEPT branch before the forced removal —
  // otherwise `worktree remove --force` silently discards it, and "the branch
  // is kept so work survives" would only be true for already-committed work.
  // Skipped when we're deleting the branch anyway (orphan cleanup). Best-effort
  // and hermetic: a pinned identity means it works with no user git config;
  // `add -A` also sweeps in untracked files. On any failure we just proceed to
  // remove (no worse than before).
  if (!opts.deleteBranch && opts.snapshot !== false && existsSync(opts.worktreePath)) {
    try {
      const dirty = (await git(["status", "--porcelain"], opts.worktreePath)).trim();
      if (dirty) {
        await git(["add", "-A"], opts.worktreePath);
        await git(
          [
            "-c",
            "user.email=codeoid@localhost",
            "-c",
            "user.name=codeoid",
            "commit",
            "--no-verify",
            // codeoid's own commit: never waits on a signing key it may not reach.
            "--no-gpg-sign",
            "-m",
            "codeoid: WIP snapshot saved on session destroy",
          ],
          opts.worktreePath,
        );
      }
    } catch (err) {
      // Work that couldn't be saved is never thrown away: the worktree stays.
      // Unknown counts as dirty: work is never discarded on a guess.
      const still = await git(["status", "--porcelain"], opts.worktreePath).catch(() => "?");
      if (still.trim()) {
        console.error(
          `[codeoid/worktree] kept ${opts.worktreePath}: its uncommitted work couldn't be saved to ${opts.branch ?? "its branch"} (${err instanceof Error ? err.message : String(err)})`,
        );
        return;
      }
    }
  }

  await admin(["worktree", "remove", "--force", opts.worktreePath], mainRoot).catch(() => {});
  // Prune any dangling administrative entry even if the dir was already gone.
  await admin(["worktree", "prune"], mainRoot).catch(() => {});
  if (opts.deleteBranch && opts.branch) {
    await admin(["branch", "-D", opts.branch], mainRoot).catch(() => {});
  }
}

/**
 * Take the setup recipe's files back out of a worktree: copied files (plain
 * files only) and shared-directory symlinks (only while still symlinks — a
 * directory the agent put there instead is its work). Best-effort, never
 * throws, and never follows a symlink: a path whose parent is one is left
 * alone, so this can only ever unlink an entry inside `root`.
 */
function removeSetupArtifacts(root: string, setup: { copied?: readonly string[]; shared?: readonly string[] }): void {
  const entry = (rel: string): string | null => {
    const parts = rel.split("/");
    if (!rel || path.isAbsolute(rel) || parts.some((p) => !p || p === "." || p === "..")) return null;
    let at = root;
    for (const part of parts.slice(0, -1)) {
      at = path.join(at, part);
      try {
        const st = lstatSync(at);
        if (st.isSymbolicLink() || !st.isDirectory()) return null;
      } catch {
        return null;
      }
    }
    return path.join(root, rel);
  };
  const unlinkIf = (rel: string, ok: (st: Stats) => boolean) => {
    const at = entry(rel);
    if (!at) return;
    try {
      if (ok(lstatSync(at))) unlinkSync(at);
    } catch {
      // already gone
    }
  };
  for (const rel of setup.shared ?? []) unlinkIf(rel, (st) => st.isSymbolicLink());
  for (const rel of setup.copied ?? []) unlinkIf(rel, (st) => st.isFile() || st.isSymbolicLink());
}

/** Current branch of a workdir (for bind mode), or null when detached/non-repo. */
export async function currentBranch(workdir: string): Promise<string | null> {
  try {
    const b = (await git(["rev-parse", "--abbrev-ref", "HEAD"], workdir)).trim();
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}
