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
 *     <data dir>/checkpoints/<sessionId>.git     (GIT_WORK_TREE = the workdir)
 *       refs/turns/<turnId>  → snapshot commit
 *       turns.log            → daemon-owned order (oldest first)
 *
 * Why not the user's own repository:
 *   - Nothing lands in the user's repo: no refs to push by accident, no
 *     objects that outlive the session, nothing in `git log --all`. Destroy
 *     is `rm -rf` of the shadow directory.
 *   - No repo-controlled code runs. Git reads config only from the shadow
 *     repo (system and global config are switched off), so the user repo's
 *     `core.fsmonitor`, hooks, `core.hooksPath` and filter drivers are never
 *     consulted — a `.gitattributes` naming a filter has no driver to run.
 *     An agent that edits `.git/config` gains nothing here.
 *   - It works in non-git directories too.
 *   - The child gets a minimal environment, never the daemon's (which holds
 *     credentials — see providers/env.ts).
 *
 * Dedup: when the workdir is inside a git repository, the shadow repo lists
 * that repository's object store as an ALTERNATE, so unchanged tracked files
 * are never copied — only content the user's repo doesn't have is stored.
 * The work tree's own `.gitignore` files are honoured; common secret files
 * (`.env`, private keys, credential dot-files) and dependency directories
 * are excluded by default.
 *
 * Bounded: new (untracked) content per snapshot is capped by size and file
 * count, the shadow repo by total size, the number of snapshots per session
 * by count (oldest pruned), every git call by a timeout, and at most one
 * snapshot runs per session at a time. A failure never fails the turn.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CheckpointLimits {
  /** Newest checkpoints kept per session; older ones are pruned. */
  maxPerSession: number;
  /** Skip a snapshot when files new to it (not in the user's repo) exceed this many bytes. */
  maxUntrackedBytes: number;
  /** Skip a snapshot when there are more new files than this. */
  maxUntrackedFiles: number;
  /** Stop snapshotting once the session's shadow repository is larger than this. */
  maxRepoBytes: number;
  /** Per-git-call timeout. */
  timeoutMs: number;
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxPerSession: 200,
  maxUntrackedBytes: 100 * 1024 * 1024,
  maxUntrackedFiles: 20_000,
  maxRepoBytes: 1024 * 1024 * 1024,
  timeoutMs: 30_000,
};

export type CheckpointResult = { ok: true; sha: string; late: boolean } | { ok: false; reason: string };

/** A recorded checkpoint. `late`: the turn had already started while the files were being read. */
export interface CheckpointRecord {
  sha: string;
  late: boolean;
}

/**
 * Never snapshotted: secrets that must not be copied into a second store,
 * and dependency/build directories that are large, regenerable, and would
 * otherwise blow the caps on a non-git directory.
 */
export const DEFAULT_CHECKPOINT_EXCLUDES = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".aws/",
  ".ssh/",
  ".gnupg/",
  "node_modules/",
  ".venv/",
  "__pycache__/",
];

/** Ids are uuids today; refuse anything that could escape a path or ref namespace. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
 * The user's repository facts for `workdir`, read with the user's own repo
 * but NO config execution: only `rev-parse`, which runs no hooks, filters or
 * fsmonitor. Null when `workdir` is not inside a git work tree.
 */
async function userRepo(
  workdir: string,
  timeoutMs: number,
): Promise<{ top: string; objects: string; index: string; head: string | null; prefix: string } | null> {
  const env = gitEnv({});
  try {
    const out = await run(
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-path", "index", "--show-prefix"],
      { cwd: workdir, env, timeoutMs },
    );
    const [top, common, index, prefix = ""] = out.split("\n");
    if (!top || !common || !index) return null;
    let head: string | null = null;
    try {
      head = (await run(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: workdir, env, timeoutMs })).trim() || null;
    } catch {
      head = null; // unborn branch
    }
    return { top, objects: path.join(common, "objects"), index, head, prefix: prefix.trim() };
  } catch {
    return null;
  }
}

/** Create the shadow repository on first use. */
async function ensureShadow(shadow: string, workdir: string, timeoutMs: number): Promise<{ fresh: boolean }> {
  if (existsSync(path.join(shadow, "HEAD"))) return { fresh: false };
  await mkdir(path.dirname(shadow), { recursive: true, mode: 0o700 });
  await run(["init", "-q", "--bare", shadow], { cwd: path.dirname(shadow), env: gitEnv({}), timeoutMs });
  const env = gitEnv({ GIT_DIR: shadow });
  for (const [k, v] of [
    ["core.bare", "false"],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.autocrlf", "false"],
    ["core.symlinks", "true"],
    ["gc.auto", "0"],
    ["advice.addEmbeddedRepo", "false"],
  ] as const) {
    await run(["config", k, v], { cwd: shadow, env, timeoutMs });
  }
  await mkdir(path.join(shadow, "info"), { recursive: true });
  await writeFile(path.join(shadow, "info", "exclude"), `${DEFAULT_CHECKPOINT_EXCLUDES.join("\n")}\n`, { mode: 0o600 });
  // Dedup against the user's repository, when there is one.
  const repo = await userRepo(workdir, timeoutMs);
  if (repo) {
    await mkdir(path.join(shadow, "objects", "info"), { recursive: true });
    await writeFile(path.join(shadow, "objects", "info", "alternates"), `${repo.objects}\n`, { mode: 0o600 });
  }
  return { fresh: true };
}

/**
 * Seed a fresh shadow index from the user's repo, so the first snapshot only
 * re-hashes what changed and the caps measure genuinely new content.
 */
async function seedIndex(shadow: string, workdir: string, timeoutMs: number): Promise<void> {
  const repo = await userRepo(workdir, timeoutMs);
  if (!repo) return;
  const env = gitEnv({ GIT_DIR: shadow, GIT_WORK_TREE: workdir });
  try {
    if (!repo.prefix) {
      // Same root: the user's index is valid as-is, stat cache included.
      await copyFile(repo.index, path.join(shadow, "index"));
    } else if (repo.head) {
      // Session rooted in a subdirectory: start from HEAD's subtree.
      await run(["read-tree", `${repo.head}:${repo.prefix}`], { cwd: workdir, env, timeoutMs });
    }
  } catch {
    // Cold start: the first add hashes everything; still correct.
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
   * Asked once the files have been read: has the turn already started? A
   * snapshot that finished after the agent began may include its first edits
   * — recorded as `late` so a restore can say so.
   */
  isLate?: () => boolean;
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
    const { fresh } = await ensureShadow(shadow, opts.workdir, t);
    if (fresh) await seedIndex(shadow, opts.workdir, t);
    if ((await shadowSizeBytes(shadow, t)) > limits.maxRepoBytes) {
      return { ok: false, reason: `checkpoint storage for this session exceeds ${Math.round(limits.maxRepoBytes / 1024 / 1024)} MB` };
    }
    const env = gitEnv({ GIT_DIR: shadow, GIT_WORK_TREE: opts.workdir });

    // Bound the new content before hashing anything.
    const listed = await run(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: opts.workdir, env, timeoutMs: t });
    const files = listed.split("\0").filter(Boolean);
    if (files.length > limits.maxUntrackedFiles) {
      return { ok: false, reason: `too many untracked files (${files.length} > ${limits.maxUntrackedFiles})` };
    }
    let bytes = 0;
    for (const f of files) {
      try {
        const s = await stat(path.join(opts.workdir, f));
        if (s.isFile()) bytes += s.size;
      } catch {
        // vanished between listing and stat
      }
      if (bytes > limits.maxUntrackedBytes) {
        return { ok: false, reason: `untracked files exceed ${Math.round(limits.maxUntrackedBytes / 1024 / 1024)} MB` };
      }
    }

    await run(["add", "-A", "--", "."], { cwd: opts.workdir, env, timeoutMs: t });
    const late = opts.isLate?.() === true;
    const tree = (await run(["write-tree"], { cwd: opts.workdir, env, timeoutMs: t })).trim();
    const message = `codeoid checkpoint\n\nsession: ${opts.sessionId}\nturn: ${opts.turnId}\n`;
    const sha = (await run(["commit-tree", tree, "-F", "-"], { cwd: opts.workdir, env, timeoutMs: t, input: message })).trim();
    const shadowEnv = gitEnv({ GIT_DIR: shadow });
    await run(["update-ref", `refs/turns/${opts.turnId}`, sha], { cwd: shadow, env: shadowEnv, timeoutMs: t });
    await appendFile(path.join(shadow, "turns.log"), orderLine({ turnId: opts.turnId, sha, late }), { mode: 0o600 });
    await prune(shadow, limits.maxPerSession, t).catch(() => {});
    return { ok: true, sha, late };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    inFlight.delete(shadow);
  }
}

/** Drop all but the newest `keep` checkpoints, and the objects only they held. */
async function prune(shadow: string, keep: number, timeoutMs: number): Promise<void> {
  const order = await readOrder(shadow);
  const excess = order.length - Math.max(1, keep);
  if (excess <= 0) return;
  const doomed = order.slice(0, excess);
  const kept = order.slice(excess);
  const env = gitEnv({ GIT_DIR: shadow });
  const stdin = doomed.map((d) => `delete refs/turns/${d.turnId}\n`).join("");
  await run(["update-ref", "--stdin"], { cwd: shadow, env, timeoutMs, input: stdin });
  await writeFile(path.join(shadow, "turns.log"), kept.map(orderLine).join(""), { mode: 0o600 });
  await run(["prune", "--expire=now"], { cwd: shadow, env, timeoutMs });
}

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
 * fetched (the source repo may be deleted later); unchanged content the
 * fork's own repository already has is not duplicated.
 */
export async function copyCheckpoints(opts: {
  root: string;
  fromSessionId: string;
  toSessionId: string;
  toWorkdir: string;
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
  await ensureShadow(to, opts.toWorkdir, t);
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

/** Delete a session's checkpoints (session destroy). Never throws. */
export async function deleteCheckpoints(root: string, sessionId: string): Promise<void> {
  try {
    await rm(shadowRepoPath(root, sessionId), { recursive: true, force: true });
  } catch {
    // best-effort
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
