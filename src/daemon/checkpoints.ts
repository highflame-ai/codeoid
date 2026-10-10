/**
 * Per-turn workspace checkpoints (#354).
 *
 * At the start of every turn the session records a snapshot of its git working
 * tree — tracked files plus untracked, non-ignored ones — as a commit object
 * reachable only from a hidden ref:
 *
 *     refs/codeoid/checkpoints/<sessionId>/<turnId>
 *
 * It is the file-side half of "go back a turn" / "fork from here": rewinding a
 * conversation to turn 5 is only coherent if the files can go back to turn 5
 * too. It is backend-agnostic by construction — it never asks the agent
 * backend what it changed, it looks at the files.
 *
 * Side-effect free for the user's checkout:
 *   - the snapshot is staged into a THROWAWAY index (GIT_INDEX_FILE), seeded
 *     from the real index so `git add -A` only re-hashes files whose stat
 *     changed; the real index, HEAD, branches, stash and working tree are
 *     never touched, and nothing appears in `git log` / `git status`;
 *   - `.gitignore` is honoured (git add -A);
 *   - the commit is built with `commit-tree` (no hooks run) under a fixed
 *     codeoid identity, so an unset `user.email` can't fail it.
 *
 * Bounded: a workdir with too many / too large untracked files is skipped
 * (with a reason) rather than bloating the object store, and every git call is
 * time-boxed. A failure never fails the turn — the caller logs and carries on.
 *
 * Refs live in the repository's COMMON dir, so they are shared by every
 * worktree of the repo; the per-session namespace keeps sessions apart.
 */

import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Ref namespace under which every checkpoint lives. */
export const CHECKPOINT_REF_ROOT = "refs/codeoid/checkpoints";

export interface CheckpointLimits {
  /** Newest checkpoints kept per session; older ones are pruned. */
  maxPerSession: number;
  /** Skip the snapshot when untracked, non-ignored files exceed this many bytes. */
  maxUntrackedBytes: number;
  /** Skip the snapshot when there are more untracked, non-ignored files than this. */
  maxUntrackedFiles: number;
  /** Per-git-call timeout. */
  timeoutMs: number;
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxPerSession: 200,
  maxUntrackedBytes: 100 * 1024 * 1024,
  maxUntrackedFiles: 20_000,
  timeoutMs: 15_000,
};

export type CheckpointResult =
  | { ok: true; sha: string; ref: string }
  | { ok: false; reason: string };

/** A codeoid identity for the snapshot commit, independent of the user's git config. */
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "codeoid",
  GIT_AUTHOR_EMAIL: "checkpoints@codeoid.local",
  GIT_COMMITTER_NAME: "codeoid",
  GIT_COMMITTER_EMAIL: "checkpoints@codeoid.local",
};

/** Ids are uuids today; refuse anything that could escape the ref namespace. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function checkpointRef(sessionId: string, turnId: string): string {
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(turnId)) {
    throw new Error(`invalid checkpoint id: ${sessionId}/${turnId}`);
  }
  return `${CHECKPOINT_REF_ROOT}/${sessionId}/${turnId}`;
}

async function git(
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
  input?: string,
): Promise<string> {
  const child = execFileP("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout } = await child;
  return stdout;
}

/** The repository top level for `workdir`, or null when it isn't a git work tree. */
export async function gitTopLevel(workdir: string, timeoutMs = DEFAULT_CHECKPOINT_LIMITS.timeoutMs): Promise<string | null> {
  try {
    const out = (await git(["rev-parse", "--show-toplevel"], workdir, timeoutMs)).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Snapshot `workdir`'s repository into `refs/codeoid/checkpoints/<session>/<turn>`.
 * Never throws: failures come back as `{ ok: false, reason }`.
 */
export async function createCheckpoint(opts: {
  workdir: string;
  sessionId: string;
  turnId: string;
  limits?: Partial<CheckpointLimits>;
}): Promise<CheckpointResult> {
  const limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...opts.limits };
  let ref: string;
  try {
    ref = checkpointRef(opts.sessionId, opts.turnId);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const top = await gitTopLevel(opts.workdir, limits.timeoutMs);
  if (!top) return { ok: false, reason: "not a git repository" };

  // Bound the snapshot before doing any hashing: untracked, non-ignored files
  // are what `add -A` would copy into the object store.
  try {
    const listed = await git(["ls-files", "--others", "--exclude-standard", "-z"], top, limits.timeoutMs);
    const files = listed.split("\0").filter(Boolean);
    if (files.length > limits.maxUntrackedFiles) {
      return { ok: false, reason: `too many untracked files (${files.length} > ${limits.maxUntrackedFiles})` };
    }
    let bytes = 0;
    for (const f of files) {
      try {
        const s = await stat(path.join(top, f));
        if (s.isFile()) bytes += s.size;
      } catch {
        // Vanished between listing and stat — git add will skip it too.
      }
      if (bytes > limits.maxUntrackedBytes) {
        return { ok: false, reason: `untracked files exceed ${Math.round(limits.maxUntrackedBytes / 1024 / 1024)} MB` };
      }
    }
  } catch (err) {
    return { ok: false, reason: `could not list untracked files: ${err instanceof Error ? err.message : String(err)}` };
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "codeoid-ckpt-"));
  const indexFile = path.join(scratch, "index");
  try {
    // Seed from the real index so `add -A` reuses its stat cache (a re-hash of
    // only what changed). A missing index (fresh repo) just means a cold add.
    try {
      const realIndex = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"], top, limits.timeoutMs)).trim();
      await copyFile(realIndex, indexFile);
    } catch {
      // cold index
    }
    const env = { ...IDENTITY_ENV, GIT_INDEX_FILE: indexFile };
    await git(["add", "-A", "--", "."], top, limits.timeoutMs, env);
    const tree = (await git(["write-tree"], top, limits.timeoutMs, env)).trim();

    let head: string | null = null;
    try {
      head = (await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], top, limits.timeoutMs)).trim() || null;
    } catch {
      head = null; // unborn branch
    }

    const message = `codeoid checkpoint\n\nsession: ${opts.sessionId}\nturn: ${opts.turnId}\n`;
    const commitArgs = ["commit-tree", tree, ...(head ? ["-p", head] : []), "-F", "-"];
    const sha = (await git(commitArgs, top, limits.timeoutMs, env, message)).trim();
    await git(["update-ref", ref, sha], top, limits.timeoutMs);
    await pruneCheckpoints(top, opts.sessionId, limits.maxPerSession, limits.timeoutMs).catch(() => {});
    return { ok: true, sha, ref };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Every checkpoint of a session, oldest first: `turnId → sha`. */
export async function listCheckpoints(
  workdir: string,
  sessionId: string,
  timeoutMs = DEFAULT_CHECKPOINT_LIMITS.timeoutMs,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!SAFE_ID.test(sessionId)) return out;
  try {
    const prefix = `${CHECKPOINT_REF_ROOT}/${sessionId}/`;
    const raw = await git(
      ["for-each-ref", "--sort=creatordate", "--format=%(refname) %(objectname)", prefix],
      workdir,
      timeoutMs,
    );
    for (const line of raw.split("\n")) {
      const [refname, sha] = line.trim().split(" ");
      if (!refname || !sha || !refname.startsWith(prefix)) continue;
      out.set(refname.slice(prefix.length), sha);
    }
  } catch {
    // not a repo / git missing → no checkpoints
  }
  return out;
}

/** Drop all but the newest `keep` checkpoints of a session. */
async function pruneCheckpoints(top: string, sessionId: string, keep: number, timeoutMs: number): Promise<void> {
  const all = await listCheckpoints(top, sessionId, timeoutMs);
  const excess = all.size - Math.max(1, keep);
  if (excess <= 0) return;
  const doomed = [...all.keys()].slice(0, excess);
  const stdin = doomed.map((t) => `delete ${CHECKPOINT_REF_ROOT}/${sessionId}/${t}\n`).join("");
  await git(["update-ref", "--stdin"], top, timeoutMs, undefined, stdin);
}

/** Delete every checkpoint of a session (session destroy). Never throws. */
export async function deleteCheckpoints(
  workdir: string,
  sessionId: string,
  timeoutMs = DEFAULT_CHECKPOINT_LIMITS.timeoutMs,
): Promise<void> {
  try {
    const all = await listCheckpoints(workdir, sessionId, timeoutMs);
    if (all.size === 0) return;
    const stdin = [...all.keys()].map((t) => `delete ${CHECKPOINT_REF_ROOT}/${sessionId}/${t}\n`).join("");
    await git(["update-ref", "--stdin"], workdir, timeoutMs, undefined, stdin);
  } catch {
    // best-effort
  }
}
