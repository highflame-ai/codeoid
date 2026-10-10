/**
 * Per-turn workspace checkpoints (#354).
 *
 * At the start of every turn the session snapshots its working directory —
 * the files as they were before the agent touched them — so "go back to
 * before this message" and "fork from here" can put the files back too. It
 * is backend-agnostic by construction: it never asks the agent backend what
 * it changed, it looks at the files.
 *
 * Storage: a SHADOW git repository per session, owned by the daemon:
 *
 *     <transcript dir>/checkpoints/<sessionId>.git   (GIT_WORK_TREE = workdir)
 *       refs/turns/<turnId>  → snapshot commit
 *       turns.log            → daemon-owned order (oldest first)
 *
 * Why a shadow repository, and a SELF-CONTAINED one:
 *   - Nothing lands in the user's repo: no refs to push by accident, no
 *     objects that outlive the session, nothing in `git log --all`. Destroy
 *     is `rm -rf` of the shadow directory.
 *   - No repo-controlled code runs. Git reads config only from the shadow
 *     repo (system and global config are switched off), so the user repo's
 *     `core.fsmonitor`, hooks and filter drivers are never consulted — a
 *     `.gitattributes` naming a filter has no driver to run.
 *   - Nothing from the user's `.git` is trusted: no copied index (an agent
 *     could plant skip-worktree entries naming any blob), no alternates (a
 *     rewrite + gc in the user repo would corrupt snapshots; a redirected
 *     object store could smuggle foreign content in). A snapshot holds
 *     exactly the bytes in the work tree, stored in the shadow repo itself,
 *     so a restore can never fail because of something outside it.
 *   - It works in non-git directories too, identically.
 *   - The child gets a minimal environment, never the daemon's (which holds
 *     credentials — see providers/env.ts).
 *
 * The cost of self-containment is one compressed copy of the work tree on a
 * session's first snapshot; later snapshots store only what changed (git
 * dedups by content, and the shadow index's stat cache skips unchanged
 * files). Bounded: the first snapshot by total size and file count, later
 * ones by new-file size and count, the repository by a storage budget
 * (oldest snapshots pruned first), the number of snapshots per session, every
 * git call by a timeout, and one snapshot per session at a time. Secrets and
 * dependency directories are excluded with pathspec magic, which a
 * `.gitignore` negation can't override. A failure never fails the turn.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CheckpointLimits {
  /** Newest checkpoints kept per session; older ones are pruned. */
  maxPerSession: number;
  /** Later snapshots: skip when files new since the last one exceed this many bytes. */
  maxUntrackedBytes: number;
  /** Later snapshots: skip when there are more new files than this. */
  maxUntrackedFiles: number;
  /** First snapshot: skip when the work tree (minus exclusions) exceeds this many bytes. */
  maxFirstSnapshotBytes: number;
  /** First snapshot: skip when the work tree has more files than this. */
  maxFirstSnapshotFiles: number;
  /** Storage budget for one session's checkpoints; the oldest are pruned to stay under it. */
  maxRepoBytes: number;
  /** Per-git-call timeout. */
  timeoutMs: number;
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxPerSession: 200,
  maxUntrackedBytes: 100 * 1024 * 1024,
  maxUntrackedFiles: 20_000,
  maxFirstSnapshotBytes: 1024 * 1024 * 1024,
  maxFirstSnapshotFiles: 100_000,
  maxRepoBytes: 2 * 1024 * 1024 * 1024,
  timeoutMs: 30_000,
};

export type CheckpointResult = { ok: true; sha: string; late: boolean } | { ok: false; reason: string };

/** A recorded checkpoint. `late`: the turn had already started while the files were being read. */
export interface CheckpointRecord {
  sha: string;
  late: boolean;
}

/**
 * Never snapshotted, as `:(exclude,glob)` pathspecs (they win over any
 * `.gitignore` negation and cover tracked files too): secrets that must not
 * be copied into a second store, and large regenerable dependency dirs.
 */
export const DEFAULT_CHECKPOINT_EXCLUDES = [
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/.netrc",
  "**/.npmrc",
  "**/.pypirc",
  "**/.git-credentials",
  "**/credentials.json",
  "**/*.tfvars",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.kube/**",
  "**/.docker/config.json",
  "**/node_modules/**",
  "**/.venv/**",
  "**/__pycache__/**",
];

/** Ids are uuids today; refuse anything that could escape a path or ref namespace. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The checkpoint id of the files a turn ENDED with (#355). */
export function endSnapshotId(turnId: string): string {
  return `${turnId}-end`;
}

/** Where a session's shadow repository lives. */
export function shadowRepoPath(root: string, sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return path.join(root, `${sessionId}.git`);
}

/**
 * A minimal environment for git: no inherited GIT_* (a GIT_DIR or
 * GIT_INDEX_FILE in the daemon's env would redirect every snapshot), no
 * credentials, no system/global config.
 */
function gitEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "codeoid",
    GIT_AUTHOR_EMAIL: "checkpoints@codeoid.local",
    GIT_COMMITTER_NAME: "codeoid",
    GIT_COMMITTER_EMAIL: "checkpoints@codeoid.local",
    ...extra,
  };
}

/** Belt and braces on top of the shadow repo's own config. */
const SAFE_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

async function run(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; input?: string },
): Promise<string> {
  const child = execFileP("git", [...SAFE_FLAGS, ...args], {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: opts.env,
  });
  if (opts.input !== undefined) child.child.stdin?.end(opts.input);
  const { stdout } = await child;
  return stdout;
}

/**
 * Create the shadow repository on first use — atomically: built in a temp
 * directory and renamed into place, so a crash can't leave a repo that looks
 * ready but lacks its configuration.
 */
async function ensureShadow(shadow: string, timeoutMs: number): Promise<void> {
  if (existsSync(path.join(shadow, "HEAD"))) return;
  const parent = path.dirname(shadow);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = `${shadow}.init-${process.pid}-${Date.now()}`;
  try {
    await run(["init", "-q", "--bare", tmp], { cwd: parent, env: gitEnv({}), timeoutMs });
    const env = gitEnv({ GIT_DIR: tmp });
    for (const [k, v] of [
      ["core.bare", "false"],
      ["core.hooksPath", "/dev/null"],
      ["core.fsmonitor", "false"],
      ["core.autocrlf", "false"],
      ["core.symlinks", "true"],
      ["core.splitIndex", "false"],
      ["gc.auto", "0"],
      ["advice.addEmbeddedRepo", "false"],
    ] as const) {
      await run(["config", k, v], { cwd: tmp, env, timeoutMs });
    }
    try {
      await rename(tmp, shadow);
    } catch (err) {
      // Lost a race with a concurrent creator: theirs is as good as ours.
      if (!existsSync(path.join(shadow, "HEAD"))) throw err;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function shadowSizeBytes(shadow: string, timeoutMs: number): Promise<number> {
  const out = await run(["count-objects", "-v"], { cwd: shadow, env: gitEnv({ GIT_DIR: shadow }), timeoutMs });
  let kib = 0;
  for (const line of out.split("\n")) {
    const [k, v] = line.split(":").map((s) => s.trim());
    if ((k === "size" || k === "size-pack") && v) kib += Number(v) || 0;
  }
  return kib * 1024;
}

/** Pathspecs for a snapshot: everything, minus the exclusions. */
function pathspecs(extraExcludes: readonly string[]): string[] {
  return ["--", ".", ...[...DEFAULT_CHECKPOINT_EXCLUDES, ...extraExcludes].map((p) => `:(exclude,glob)${p}`)];
}

type OrderEntry = { turnId: string; sha: string; late: boolean };

const orderLine = (e: OrderEntry): string => `${e.turnId} ${e.sha}${e.late ? " late" : ""}\n`;

async function readOrder(shadow: string): Promise<OrderEntry[]> {
  try {
    const raw = await readFile(path.join(shadow, "turns.log"), "utf8");
    const out: OrderEntry[] = [];
    for (const line of raw.split("\n")) {
      const [turnId, sha, flag] = line.trim().split(" ");
      if (turnId && sha && SAFE_ID.test(turnId) && /^[0-9a-f]{40,64}$/.test(sha)) {
        out.push({ turnId, sha, late: flag === "late" });
      }
    }
    return out;
  } catch {
    return [];
  }
}


/**
 * `git add -A` over the snapshot pathspecs. A nested repository with no
 * commit checked out makes git refuse the whole add; exclude each one it
 * names and retry. (Nested repositories are recorded as a pointer to their
 * checked-out commit, never their files — git's model for embedded repos.)
 */
async function addAll(workdir: string, env: Record<string, string>, timeoutMs: number, extra: string[]): Promise<void> {
  const excludes = [...extra];
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await run(["add", "-A", ...pathspecs(excludes)], { cwd: workdir, env, timeoutMs });
      return;
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "");
      const m = /'([^']+)' does not have a commit checked out/.exec(stderr);
      if (!m?.[1]) throw err;
      excludes.push(m[1].replace(/\/$/, ""), `${m[1].replace(/\/$/, "")}/**`);
    }
  }
  throw new Error("too many nested repositories without a commit");
}

/** One snapshot at a time per shadow repo (they share an index). */
const inFlight = new Set<string>();

/**
 * Snapshot `workdir` into the session's shadow repo as `refs/turns/<turnId>`.
 * Never throws: failures come back as `{ ok: false, reason }`.
 */
export async function createCheckpoint(opts: {
  root: string;
  workdir: string;
  sessionId: string;
  turnId: string;
  limits?: Partial<CheckpointLimits>;
  /**
   * Absolute directories inside the workdir that must never be snapshotted
   * (the daemon's own data directory, should a workdir contain it).
   */
  excludeDirs?: readonly string[];
  /**
   * Asked once the files have been read: has the turn already started? A
   * snapshot that finished after the agent began may include its first edits
   * — recorded as `late` so a restore can say so.
   */
  isLate?: () => boolean;
  /** Record nothing if this turn id already has a checkpoint (never overwrite it). */
  onlyIfMissing?: boolean;
}): Promise<CheckpointResult> {
  const limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...opts.limits };
  if (!SAFE_ID.test(opts.turnId)) return { ok: false, reason: `invalid turn id: ${opts.turnId}` };
  let shadow: string;
  try {
    shadow = shadowRepoPath(opts.root, opts.sessionId);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (inFlight.has(shadow)) return { ok: false, reason: "the previous snapshot is still running" };
  inFlight.add(shadow);
  try {
    const t = limits.timeoutMs;
    await ensureShadow(shadow, t);
    if (opts.onlyIfMissing) {
      const existing = (await readOrder(shadow)).find((e) => e.turnId === opts.turnId);
      if (existing) return { ok: true, sha: existing.sha, late: existing.late };
    }
    // Over the storage budget: drop the older snapshots, oldest first, until
    // it fits — down to none, so a session whose tree alone nears the budget
    // still always has its latest snapshot rather than none ever again.
    for (let keep = Math.floor((await readOrder(shadow)).length / 2); (await shadowSizeBytes(shadow, t)) > limits.maxRepoBytes; keep = Math.floor(keep / 2)) {
      await prune(shadow, keep, t, { reclaimNow: true }).catch(() => {});
      if (keep === 0) break;
    }
    const staged = await stageWorkTree(shadow, opts.workdir, limits, opts.excludeDirs);
    if (!staged.ok) return staged;
    const late = opts.isLate?.() === true;
    const { env, first } = staged;
    const tree = (await run(["write-tree"], { cwd: opts.workdir, env, timeoutMs: t })).trim();
    const message = `codeoid checkpoint\n\nsession: ${opts.sessionId}\nturn: ${opts.turnId}\n`;
    const sha = (await run(["commit-tree", tree, "-F", "-"], { cwd: opts.workdir, env, timeoutMs: t, input: message })).trim();
    const shadowEnv = gitEnv({ GIT_DIR: shadow });
    await run(["update-ref", `refs/turns/${opts.turnId}`, sha], { cwd: shadow, env: shadowEnv, timeoutMs: t });
    await appendFile(path.join(shadow, "turns.log"), orderLine({ turnId: opts.turnId, sha, late }), { mode: 0o600 });
    await prune(shadow, limits.maxPerSession, t).catch(() => {});
    // A first snapshot of a big tree leaves one loose object per file; pack
    // them so the store stays compact and cheap to copy for forks.
    if (first) await run(["repack", "-a", "-d", "-q"], { cwd: shadow, env: shadowEnv, timeoutMs: t * 4 }).catch(() => {});
    return { ok: true, sha, late };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(shadow);
  }
}

/**
 * Stage the work tree into the shadow index — bounded by the limits — so
 * `write-tree` yields its snapshot. Caller holds the shadow's in-flight slot.
 */
async function stageWorkTree(
  shadow: string,
  workdir: string,
  limits: CheckpointLimits,
  excludeDirs: readonly string[] | undefined,
): Promise<{ ok: true; env: Record<string, string>; first: boolean } | { ok: false; reason: string }> {
  const t = limits.timeoutMs;
  {
    // A lock left by a snapshot killed mid-write (crash, forced shutdown).
    // Ours are serialized by `inFlight`, so any lock here now is stale.
    await rm(path.join(shadow, "index.lock"), { force: true });
    const env = gitEnv({ GIT_DIR: shadow, GIT_WORK_TREE: workdir });
    const extra = (excludeDirs ?? [])
      .map((d) => path.relative(workdir, d))
      .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      .map((rel) => `${rel.split(path.sep).join("/")}/**`);
    const spec = pathspecs(extra);

    // Bound the content to hash before hashing anything. With no shadow index
    // yet (first snapshot, or a fork's copied history) every file is new.
    const first = !existsSync(path.join(shadow, "index"));
    const maxFiles = first ? limits.maxFirstSnapshotFiles : limits.maxUntrackedFiles;
    const maxBytes = first ? limits.maxFirstSnapshotBytes : limits.maxUntrackedBytes;
    const listed = await run(["ls-files", "--others", "--exclude-standard", "-z", ...spec], { cwd: workdir, env, timeoutMs: t });
    const files = listed.split("\0").filter(Boolean);
    if (files.length > maxFiles) {
      return { ok: false, reason: `too many ${first ? "files" : "untracked files"} (${files.length} > ${maxFiles})` };
    }
    let bytes = 0;
    for (const f of files) {
      try {
        const s = await stat(path.join(workdir, f));
        if (s.isFile()) bytes += s.size;
      } catch {
        // vanished between listing and stat
      }
      if (bytes > maxBytes) {
        return { ok: false, reason: `${first ? "files" : "untracked files"} exceed ${Math.round(maxBytes / 1024 / 1024)} MB` };
      }
    }

    await addAll(workdir, env, t, extra);
    return { ok: true, env, first };
  }
}

/**
 * The work tree's current content as a tree id in the session's shadow repo
 * (same scope and exclusions as a snapshot), without recording a checkpoint
 * — what "go back a turn" compares a snapshot against.
 */
export async function currentTree(opts: {
  root: string;
  workdir: string;
  sessionId: string;
  excludeDirs?: readonly string[];
  limits?: Partial<CheckpointLimits>;
}): Promise<{ ok: true; tree: string } | { ok: false; reason: string }> {
  const limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...opts.limits };
  const shadow = shadowRepoPath(opts.root, opts.sessionId);
  if (inFlight.has(shadow)) return { ok: false, reason: "a snapshot is still running" };
  inFlight.add(shadow);
  try {
    await ensureShadow(shadow, limits.timeoutMs);
    const staged = await stageWorkTree(shadow, opts.workdir, limits, opts.excludeDirs);
    if (!staged.ok) return staged;
    const tree = (await run(["write-tree"], { cwd: opts.workdir, env: staged.env, timeoutMs: limits.timeoutMs })).trim();
    return { ok: true, tree };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(shadow);
  }
}

/** One path's change between two snapshots. */
export interface TreeChange {
  /** A = only in `to`; D = only in `from`; M = content or mode differs; T = type differs. */
  status: "A" | "D" | "M" | "T";
  path: string;
}

/** What differs between two trees/commits of a session's shadow repo. */
export async function diffTrees(root: string, sessionId: string, from: string, to: string): Promise<TreeChange[]> {
  const out = await shadowGit(root, sessionId, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
  const parts = out.split("\0").filter((p) => p.length > 0);
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]![0] as TreeChange["status"];
    if (status === "A" || status === "D" || status === "M" || status === "T") changes.push({ status, path: parts[i + 1]! });
  }
  return changes;
}

/**
 * Put the work tree back from tree `from` (its current content, from
 * {@link currentTree}) to snapshot `to`, in one git operation: a two-tree
 * `read-tree -m -u` over a throwaway index. Git writes back changed and
 * deleted files and removes created ones with its own safeguards: it never
 * writes or unlinks through a symlinked parent, it refuses (changing
 * nothing) if any file differs from `from` — something changed since the
 * preview — and it never overwrites an untracked file. Ignored and excluded
 * files were never in either tree, so they are never touched.
 *
 * `keep` lists paths that must stay as they are in `from` (protected
 * directories, a deleted file whose path is now taken by an ignored one):
 * the target is `to` with those entries taken from `from`.
 */
export async function restoreTree(opts: {
  root: string;
  workdir: string;
  sessionId: string;
  from: string;
  to: string;
  keep?: readonly string[];
}): Promise<void> {
  const shadow = shadowRepoPath(opts.root, opts.sessionId);
  if (inFlight.has(shadow)) throw new Error("a snapshot is still running — try again");
  inFlight.add(shadow);
  const tmpIndex = path.join(shadow, `index.restore-${process.pid}-${Date.now()}`);
  const t = DEFAULT_CHECKPOINT_LIMITS.timeoutMs * 2;
  try {
    const env = gitEnv({ GIT_DIR: shadow, GIT_WORK_TREE: opts.workdir, GIT_INDEX_FILE: tmpIndex });
    let target = opts.to;
    if (opts.keep && opts.keep.length > 0) target = await treeKeeping(shadow, opts.to, opts.from, opts.keep, t);
    // Start from the shadow index — {@link currentTree} just staged `from`
    // into it, so its stat cache spares a full re-hash on a big tree — then
    // make it exactly `from` (a one-tree merge keeps the cached stats).
    try {
      await copyFile(path.join(shadow, "index"), tmpIndex);
      await run(["read-tree", "-m", opts.from], { cwd: opts.workdir, env, timeoutMs: t });
    } catch {
      await rm(tmpIndex, { force: true }).catch(() => {});
      await run(["read-tree", opts.from], { cwd: opts.workdir, env, timeoutMs: t });
    }
    // Stat-refresh so read-tree can verify the work tree still matches `from`.
    await run(["update-index", "--refresh"], { cwd: opts.workdir, env, timeoutMs: t }).catch(() => {});
    try {
      await run(["read-tree", "-m", "-u", opts.from, target], { cwd: opts.workdir, env, timeoutMs: t });
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
      if (/not uptodate|would be overwritten/.test(stderr)) {
        throw new RestoreConflictError(`files changed since the preview, nothing was restored (${stderr.split("\n")[0]})`);
      }
      throw err;
    }
  } finally {
    inFlight.delete(shadow);
    await rm(tmpIndex, { force: true }).catch(() => {});
    await rm(`${tmpIndex}.lock`, { force: true }).catch(() => {});
  }
}

/** The files changed under the restore between preview and apply. Nothing was written. */
export class RestoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreConflictError";
  }
}

/** Tree `to`, with each path in `keep` as it is in `from` (or absent when `from` lacks it). */
async function treeKeeping(shadow: string, to: string, from: string, keep: readonly string[], timeoutMs: number): Promise<string> {
  const tmp = path.join(shadow, `index.keep-${process.pid}-${Date.now()}`);
  const env = gitEnv({ GIT_DIR: shadow, GIT_INDEX_FILE: tmp, GIT_LITERAL_PATHSPECS: "1" });
  try {
    await run(["read-tree", to], { cwd: shadow, env, timeoutMs });
    const listed = await run(["ls-tree", "-r", "-z", "--full-tree", from, "--", ...keep], { cwd: shadow, env, timeoutMs });
    const present = new Map<string, string>(); // path → "mode sha"
    for (const entry of listed.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [mode, , sha] = entry.slice(0, tab).split(" ");
      present.set(entry.slice(tab + 1), `${mode} ${sha}`);
    }
    const lines = keep.map((p) => (present.has(p) ? `${present.get(p)}\t${p}` : `0 ${"0".repeat(40)}\t${p}`)).join("\0");
    await run(["update-index", "-z", "--index-info"], { cwd: shadow, env, timeoutMs, input: `${lines}\0` });
    return (await run(["write-tree"], { cwd: shadow, env, timeoutMs })).trim();
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Drop all but the newest `keep` checkpoints, and the objects only they held. */
async function prune(shadow: string, keep: number, timeoutMs: number, opts: { reclaimNow?: boolean } = {}): Promise<void> {
  const order = await readOrder(shadow);
  const excess = order.length - Math.max(0, keep);
  if (excess <= 0) return;
  const doomed = order.slice(0, excess);
  const kept = order.slice(excess);
  const env = gitEnv({ GIT_DIR: shadow });
  const stdin = doomed.map((d) => `delete refs/turns/${d.turnId}\n`).join("");
  await run(["update-ref", "--stdin"], { cwd: shadow, env, timeoutMs, input: stdin });
  await writeOrder(shadow, kept);
  // Reclaim the space only the dropped snapshots held — loose and packed —
  // in batches: it walks every remaining snapshot, too costly per turn.
  const pendingReclaim = (unreclaimed.get(shadow) ?? 0) + doomed.length;
  if (opts.reclaimNow || pendingReclaim >= RECLAIM_EVERY) {
    unreclaimed.delete(shadow);
    await run(["repack", "-a", "-d", "-q"], { cwd: shadow, env, timeoutMs: timeoutMs * 4 });
    await run(["prune", "--expire=now"], { cwd: shadow, env, timeoutMs });
  } else {
    unreclaimed.set(shadow, pendingReclaim);
  }
}

/** Dropped snapshots whose space hasn't been reclaimed yet, per shadow repo. */
const unreclaimed = new Map<string, number>();
const RECLAIM_EVERY = 20;

/**
 * Every checkpoint of a session, oldest first: `turnId → sha`. Trusts only
 * entries whose ref still points at the commit the daemon recorded.
 */
export async function listCheckpoints(
  root: string,
  sessionId: string,
  timeoutMs = DEFAULT_CHECKPOINT_LIMITS.timeoutMs,
): Promise<Map<string, CheckpointRecord>> {
  const out = new Map<string, CheckpointRecord>();
  let shadow: string;
  try {
    shadow = shadowRepoPath(root, sessionId);
  } catch {
    return out;
  }
  if (!existsSync(path.join(shadow, "HEAD"))) return out;
  const order = await readOrder(shadow);
  if (order.length === 0) return out;
  try {
    const raw = await run(["for-each-ref", "--format=%(refname) %(objectname)", "refs/turns/"], {
      cwd: shadow,
      env: gitEnv({ GIT_DIR: shadow }),
      timeoutMs,
    });
    const refs = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const [refname, sha] = line.trim().split(" ");
      if (refname?.startsWith("refs/turns/") && sha) refs.set(refname.slice("refs/turns/".length), sha);
    }
    for (const { turnId, sha, late } of order) if (refs.get(turnId) === sha) out.set(turnId, { sha, late });
  } catch {
    // unreadable shadow repo → no checkpoints
  }
  return out;
}

/**
 * Give a new session (a fork) copies of another session's checkpoints, so its
 * inherited turns keep their snapshots — and keep them after the source
 * session is destroyed. `turnIds` limits the copy; default all. Objects are
 * fetched, so the copy is self-contained and survives the source repo.
 */
export async function copyCheckpoints(opts: {
  root: string;
  fromSessionId: string;
  toSessionId: string;
  turnIds?: readonly string[];
  timeoutMs?: number;
}): Promise<number> {
  const t = opts.timeoutMs ?? DEFAULT_CHECKPOINT_LIMITS.timeoutMs;
  const source = await listCheckpoints(opts.root, opts.fromSessionId, t);
  const wanted = opts.turnIds ? new Set(opts.turnIds) : undefined;
  const picked = [...source].filter(([turnId]) => !wanted || wanted.has(turnId));
  if (picked.length === 0) return 0;
  const from = shadowRepoPath(opts.root, opts.fromSessionId);
  const to = shadowRepoPath(opts.root, opts.toSessionId);
  await ensureShadow(to, t);
  const env = gitEnv({ GIT_DIR: to });
  const refspecs = picked.map(([turnId]) => `+refs/turns/${turnId}:refs/turns/${turnId}`);
  await run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", from, ...refspecs], { cwd: to, env, timeoutMs: t });
  const existing = await readOrder(to);
  const have = new Set(existing.map((e) => e.turnId));
  const lines = picked
    .filter(([turnId]) => !have.has(turnId))
    .map(([turnId, rec]) => orderLine({ turnId, sha: rec.sha, late: rec.late }))
    .join("");
  if (lines) await appendFile(path.join(to, "turns.log"), lines, { mode: 0o600 });
  return picked.length;
}

/**
 * Remove shadow repositories that belong to no known session — left behind
 * by a crash between destroy's steps, or by state lost outside the daemon.
 */
export async function sweepCheckpoints(root: string, knownSessionIds: ReadonlySet<string>): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".git")) continue;
    const id = name.slice(0, -".git".length);
    if (!SAFE_ID.test(id) || knownSessionIds.has(id)) continue;
    await rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

/** Delete one checkpoint (a snapshot for a turn that never started). */
export async function deleteCheckpoint(root: string, sessionId: string, turnId: string): Promise<void> {
  if (!SAFE_ID.test(turnId)) return;
  const shadow = shadowRepoPath(root, sessionId);
  if (!existsSync(path.join(shadow, "HEAD"))) return;
  const env = gitEnv({ GIT_DIR: shadow });
  await run(["update-ref", "-d", `refs/turns/${turnId}`], { cwd: shadow, env, timeoutMs: DEFAULT_CHECKPOINT_LIMITS.timeoutMs }).catch(() => {});
  const order = await readOrder(shadow);
  await writeOrder(shadow, order.filter((e) => e.turnId !== turnId));
}

/** Rewrite turns.log atomically — a torn rewrite would hide every snapshot. */
async function writeOrder(shadow: string, entries: readonly OrderEntry[]): Promise<void> {
  const file = path.join(shadow, "turns.log");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, entries.map(orderLine).join(""), { mode: 0o600 });
  await rename(tmp, file);
}

/** Delete a session's checkpoints (session destroy). Never throws. */
export async function deleteCheckpoints(root: string, sessionId: string): Promise<void> {
  try {
    await rm(shadowRepoPath(root, sessionId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** {@link shadowGit} with literal pathspecs (a file named `*` is that file). */
export function shadowGitLiteral(root: string, sessionId: string, args: string[]): Promise<string> {
  const shadow = shadowRepoPath(root, sessionId);
  return run(args, {
    cwd: shadow,
    env: gitEnv({ GIT_DIR: shadow, GIT_LITERAL_PATHSPECS: "1" }),
    timeoutMs: DEFAULT_CHECKPOINT_LIMITS.timeoutMs,
  });
}

/**
 * Which of `paths` are ignored under the `.gitignore` files of snapshot
 * `sha` (#355) — files it couldn't have held because they were ignored then,
 * so their absence from it says nothing about whether they were created
 * since. The snapshot's ignore files are materialized in a scratch directory
 * and asked with `check-ignore --no-index`; nothing in the workdir is read.
 */
export async function ignoredUnderTree(root: string, sessionId: string, sha: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const shadow = shadowRepoPath(root, sessionId);
  const scratch = await mkdtemp(path.join(tmpdir(), "codeoid-ign-"));
  const t = DEFAULT_CHECKPOINT_LIMITS.timeoutMs;
  try {
    const listed = await run(["ls-tree", "-r", "-z", "--name-only", sha], {
      cwd: shadow,
      env: gitEnv({ GIT_DIR: shadow }),
      timeoutMs: t,
    });
    const ignoreFiles = listed.split("\0").filter((p) => p === ".gitignore" || p.endsWith("/.gitignore"));
    // One process for every ignore file: `cat-file --batch` answers
    // "<oid> blob <size>\n<content>\n" per request line.
    if (ignoreFiles.length > 0) {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const child = execFile(
          "git",
          [...SAFE_FLAGS, "cat-file", "--batch"],
          { cwd: shadow, env: gitEnv({ GIT_DIR: shadow }), timeout: t, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
          (err, stdout) => (err ? reject(err) : resolve(stdout as Buffer)),
        );
        child.stdin?.end(`${ignoreFiles.map((rel) => `${sha}:${rel}`).join("\n")}\n`);
      });
      let at = 0;
      for (const rel of ignoreFiles) {
        const nl = raw.indexOf(0x0a, at);
        const header = raw.subarray(at, nl).toString("utf8").split(" ");
        const size = Number(header[2]);
        if (header[1] !== "blob" || !Number.isFinite(size)) break;
        const body = raw.subarray(nl + 1, nl + 1 + size);
        at = nl + 1 + size + 1;
        const dest = path.join(scratch, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, body);
      }
    }
    await run(["init", "-q", scratch], { cwd: scratch, env: gitEnv({}), timeoutMs: t });
    let out = "";
    try {
      out = await run(["check-ignore", "--no-index", "-z", "--stdin"], {
        cwd: scratch,
        env: gitEnv({ GIT_DIR: path.join(scratch, ".git"), GIT_WORK_TREE: scratch }),
        timeoutMs: t,
        input: `${paths.join("\0")}\0`,
      });
    } catch (err) {
      // exit 1 = none ignored
      out = String((err as { stdout?: unknown }).stdout ?? "");
    }
    return out.split("\0").filter(Boolean);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run git against a session's shadow repository (for the features that read
 * or restore checkpoints). Same hardened environment as snapshots.
 */
export async function shadowGit(
  root: string,
  sessionId: string,
  args: string[],
  opts: { workdir?: string; timeoutMs?: number; input?: string } = {},
): Promise<string> {
  const shadow = shadowRepoPath(root, sessionId);
  return run(args, {
    cwd: opts.workdir ?? shadow,
    env: gitEnv({ GIT_DIR: shadow, ...(opts.workdir ? { GIT_WORK_TREE: opts.workdir } : {}) }),
    timeoutMs: opts.timeoutMs ?? DEFAULT_CHECKPOINT_LIMITS.timeoutMs,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
}
