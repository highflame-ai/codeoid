/**
 * Workspace setup recipe for the worktrees codeoid creates (design §12.7).
 *
 * A fresh worktree carries tracked files only: no `.env`, no installed
 * dependencies, and (by design, see git-worktree.ts) no `post-checkout` hook.
 * A repository says how to make one usable in `.codeoid/setup.yaml`:
 *
 * ```yaml
 * copy: [.env, "config/*.local.json"]   # ignored files, copied from the primary checkout
 * share: [node_modules]                  # directories, symlinked to the primary checkout
 * command: bun install --frozen-lockfile # run in the new worktree, only when trusted
 * timeoutSec: 600
 * resources: { ports: 2, env: [DATABASE_URL] }   # declared only; leased in a later slice
 * ```
 *
 * Trust, in order of how much each step could do:
 *
 *   - The recipe is read from the PRIMARY checkout's committed `HEAD` (`git
 *     ls-tree` + `cat-file` on the source repo), never from the new
 *     worktree's files or a candidate branch — a branch cannot rewrite how
 *     its own worktree is prepared. Reading and parsing execute nothing.
 *   - `copy` / `share` sources resolve inside the primary checkout (realpath
 *     containment, never `.git`); destinations are created inside the new
 *     worktree without following a symlink. A copied file must be ignored by
 *     git there, so it can never be committed; nothing existing is overwritten.
 *   - `command` runs only under `worktree.setup.runCommands: "trusted-repos"`
 *     for a repository the operator listed — the pack-trust model (an
 *     untrusted command gate fails closed; declaring is not executing). It
 *     gets a built environment, never the daemon's own (GHSA-38vh).
 *
 * Everything is validated before anything is written; a failure while
 * writing rolls back what this run created. A setup failure is an
 * infrastructure error: it is reported, never thrown, and never removes the
 * worktree or touches the primary checkout.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, realpathSync, rmdirSync, type Stats, statSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { mainWorktreeRoot } from "./git-worktree.js";
import { buildSubprocessEnv } from "./providers/env.js";

const execFileP = promisify(execFile);

/** Where the recipe lives, relative to the repository root. */
export const SETUP_RECIPE_PATH = ".codeoid/setup.yaml";
/** Default wall-clock for the setup command (dependency installs can be slow). */
export const DEFAULT_SETUP_TIMEOUT_SEC = 600;

const LIMITS = {
  RECIPE_BYTES: 64 * 1024,
  COPY_FILES: 500,
  COPY_BYTES: 256 * 1024 * 1024,
  OUTPUT_TAIL: 8 * 1024,
} as const;

// ── Recipe schema ────────────────────────────────────────────────────────────

/** `./a/b/` → `a/b`. */
function normalizeRel(p: string): string {
  let s = p.trim();
  while (s.startsWith("./")) s = s.slice(2);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** Why `p` can't name a path inside the repository, or null when it can. */
function relPathProblem(p: string, glob: boolean): string | null {
  if (p.includes("\0")) return "contains a NUL byte";
  if (p.includes("\\")) return "uses a backslash (use / separators)";
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return "is absolute (paths are relative to the repository root)";
  if (p.startsWith("~")) return "starts with ~ (paths are relative to the repository root)";
  const segs = p.split("/");
  if (segs.includes("..")) return "has a .. segment (paths must stay inside the repository)";
  if (segs.includes(".git")) return "is inside .git";
  if (segs.every((s) => s === "" || s === ".")) return "names the repository root";
  if (!glob && GLOB_CHARS.test(p)) return "is a glob (share takes plain directory paths)";
  return null;
}

const relPath = (glob: boolean) =>
  z
    .string()
    .min(1)
    .max(1024)
    .transform(normalizeRel)
    .superRefine((p, ctx) => {
      const why = relPathProblem(p, glob);
      if (why) ctx.addIssue({ code: "custom", message: `${JSON.stringify(p)} ${why}` });
    });

export const SetupRecipeSchema = z
  .object({
    /** Ignored files to copy from the primary checkout; globs allowed. */
    copy: z.array(relPath(true)).max(256).default([]),
    /** Directories to symlink from the primary checkout (e.g. node_modules). */
    share: z.array(relPath(false)).max(64).default([]),
    /** Shell command run in the new worktree's root — only for a trusted repository. */
    command: z.string().trim().min(1).max(16_384).optional(),
    /** Wall-clock limit for `command`, in seconds. */
    timeoutSec: z.number().int().min(1).max(7_200).optional(),
    /** Resources each worktree needs. Declared and validated only — leasing them is a later slice. */
    resources: z
      .object({
        ports: z.number().int().min(0).max(64).optional(),
        env: z
          .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an UPPER_SNAKE environment variable name"))
          .max(64)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SetupRecipe = z.infer<typeof SetupRecipeSchema>;

export class SetupRecipeError extends Error {
  override name = "SetupRecipeError";
}

/** Parse + validate a recipe's YAML text. Throws {@link SetupRecipeError} with every problem named. */
export function parseSetupRecipe(text: string): SetupRecipe {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    throw new SetupRecipeError(`${SETUP_RECIPE_PATH} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || raw === undefined) raw = {};
  const parsed = SetupRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
    throw new SetupRecipeError(`${SETUP_RECIPE_PATH} is invalid — ${problems.join("; ")}`);
  }
  return parsed.data;
}

// ── git ──────────────────────────────────────────────────────────────────────

/** git with hooks and fsmonitor off (as git-worktree.ts); `okCodes` are exits that aren't errors. */
async function git(args: string[], cwd: string, opts: { okCodes?: number[]; input?: string } = {}): Promise<{ code: number; stdout: string }> {
  const argv = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
  if (opts.input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn("git", argv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const c = code ?? 1;
        if (c === 0 || opts.okCodes?.includes(c)) resolve({ code: c, stdout });
        else reject(new Error(`git ${args[0]} exited ${c}: ${stderr.trim()}`));
      });
      child.stdin.end(opts.input);
    });
  }
  try {
    const { stdout } = await execFileP("git", argv, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number" && opts.okCodes?.includes(code)) {
      return { code, stdout: String((err as { stdout?: unknown }).stdout ?? "") };
    }
    throw err;
  }
}

/** Of `rels`, the ones git ignores in `worktree` (a tracked path is never ignored). */
async function ignoredIn(worktree: string, rels: readonly string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set();
  const { stdout } = await git(["check-ignore", "-z", "--stdin"], worktree, { okCodes: [1], input: `${rels.join("\0")}\0` });
  return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * The recipe at the primary checkout's committed `HEAD`, or null when there
 * is none (no file, or no commit yet). The working tree is never read: the
 * recipe that prepares a worktree is the one the user committed, not one an
 * agent left uncommitted or put on a branch. Throws {@link SetupRecipeError}
 * when the file is there but unusable.
 */
export async function readSetupRecipe(repoDir: string): Promise<{ recipe: SetupRecipe; rev: string; root: string } | null> {
  const root = await mainWorktreeRoot(repoDir);
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root, { okCodes: [1, 128] });
  const rev = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(rev)) return null;
  const listed = (await git(["ls-tree", "-l", "-z", rev, "--", SETUP_RECIPE_PATH], root)).stdout.split("\0").find(Boolean);
  if (!listed) return null;
  // `<mode> <type> <object> <size>\t<path>`
  const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t/.exec(listed);
  if (!m || m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) {
    throw new SetupRecipeError(`${SETUP_RECIPE_PATH} at ${rev.slice(0, 10)} must be a regular file`);
  }
  if (Number(m[4]) > LIMITS.RECIPE_BYTES) {
    throw new SetupRecipeError(`${SETUP_RECIPE_PATH} is larger than ${LIMITS.RECIPE_BYTES / 1024} KiB`);
  }
  const text = (await git(["cat-file", "blob", m[3] as string], root)).stdout;
  return { recipe: parseSetupRecipe(text), rev, root };
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** `config.worktree.setup`: whether a recipe's `command` may run. */
export interface WorktreeSetupPolicy {
  /** `never` (default): never run a recipe command. `trusted-repos`: only for a repository in `trustedRepos`. */
  runCommands: "never" | "trusted-repos";
  /** Primary checkouts whose recipe commands may run (`~` allowed; compared by real path). */
  trustedRepos: readonly string[];
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Null when `root`'s recipe command may run, else why not. */
export function commandRefusal(policy: WorktreeSetupPolicy | undefined, root: string): string | null {
  if (!policy || policy.runCommands !== "trusted-repos") {
    return "recipe commands are off (set worktree.setup.runCommands to trusted-repos and list this repository in worktree.setup.trustedRepos)";
  }
  const real = realOrNull(root);
  const trusted = !!real && policy.trustedRepos.some((r) => realOrNull(path.resolve(expandHome(r))) === real);
  return trusted ? null : `this repository isn't in worktree.setup.trustedRepos (${root})`;
}

// ── Prepare ──────────────────────────────────────────────────────────────────

export interface WorktreeSetupCommandResult {
  command: string;
  /** Exit code; null when it couldn't start or was killed. */
  exitCode: number | null;
  timedOut: boolean;
  /** The last few KiB of combined stdout + stderr. */
  outputTail: string;
  durationMs: number;
}

export interface WorktreeSetupResult {
  /** A recipe was found and its copy/share steps were put in place. */
  applied: boolean;
  /** The commit the recipe was read from. */
  recipeRev?: string;
  /** Worktree-relative files copied in — secrets, so excluded from evidence and checkpoints. */
  copied: string[];
  /** Worktree-relative symlinks to the primary checkout's directories. */
  shared: string[];
  /** Recipe entries left out, and why (nothing to copy, already present, not ignored, outside the repo…). */
  skipped: { path: string; reason: string }[];
  warnings: string[];
  /** The recipe's declared resources (not allocated yet). */
  resources?: NonNullable<SetupRecipe["resources"]>;
  command?: WorktreeSetupCommandResult;
  /** Why the recipe's command didn't run. */
  commandSkipped?: string;
  /** Set when setup failed — an infrastructure error, never the agent's. */
  error?: string;
}

/**
 * Thrown where a caller can't continue without a prepared worktree (an
 * unattended routine run). `infrastructure` marks it as a setup problem —
 * never counted as the agent's failure.
 */
export class WorktreeSetupFailure extends Error {
  override name = "WorktreeSetupFailure";
  readonly infrastructure = true;
  constructor(readonly result: WorktreeSetupResult) {
    const tail = result.command?.outputTail.trim();
    super(`${result.error ?? "worktree setup failed"}${tail ? `\n${tail.slice(-1_000)}` : ""}`);
  }
}

interface Planned {
  rel: string;
  src: string;
}

const isInside = (child: string, root: string) => child === root || child.startsWith(root + path.sep);

/**
 * Walk `rel`'s parent directories under `root`, creating missing ones
 * (recorded in `made`), refusing a symlink or non-directory on the way, and
 * confirm the result resolves inside `root`.
 */
function ensureParents(root: string, rel: string, made: string[]): void {
  const parts = rel.split("/").slice(0, -1);
  let at = root;
  for (const part of parts) {
    at = path.join(at, part);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(at);
    } catch {
      st = undefined;
    }
    if (!st) {
      mkdirSync(at);
      made.push(at);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path.relative(root, at)} in the new worktree is not a plain directory`);
  }
  if (!isInside(realpathSync(at), realpathSync(root))) throw new Error(`${rel} would land outside the new worktree`);
}

/** Why `rel` can't be created in `root` (a parent is a symlink or a file), or null. Creates nothing. */
function parentProblem(root: string, rel: string): string | null {
  let at = root;
  for (const part of rel.split("/").slice(0, -1)) {
    at = path.join(at, part);
    let st: Stats;
    try {
      st = lstatSync(at);
    } catch {
      return null; // missing from here down: created as plain directories
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return `has ${path.relative(root, at)} in its path, which isn't a plain directory in the new worktree`;
  }
  return null;
}

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Candidate repo-relative files for one `copy` entry, matched in the primary checkout. */
function matchCopy(pattern: string, root: string): string[] {
  if (!GLOB_CHARS.test(pattern)) return exists(path.join(root, pattern)) ? [pattern] : [];
  const out: string[] = [];
  for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root, dot: true, onlyFiles: true, followSymlinks: false })) {
    const posix = rel.split(path.sep).join("/");
    if (!posix.split("/").includes(".git")) out.push(posix);
    if (out.length > LIMITS.COPY_FILES) break;
  }
  return out.sort();
}

/**
 * Apply the repository's setup recipe to a worktree codeoid just created:
 * copy the ignored files it names, symlink its shared directories, and (when
 * the policy trusts the repository) run its command. `worktreePath` is the
 * worktree ROOT. Never throws; failures come back in `error`.
 */
export async function prepareWorktree(opts: {
  worktreePath: string;
  policy?: WorktreeSetupPolicy;
  /** Abort a running command (session destroyed, daemon stopping). */
  signal?: AbortSignal;
}): Promise<WorktreeSetupResult> {
  const result: WorktreeSetupResult = { applied: false, copied: [], shared: [], skipped: [], warnings: [] };
  const fail = (err: unknown): WorktreeSetupResult => {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  };

  let found: Awaited<ReturnType<typeof readSetupRecipe>>;
  try {
    found = await readSetupRecipe(opts.worktreePath);
  } catch (err) {
    return fail(err);
  }
  if (!found) return result;
  const { recipe, rev, root } = found;
  result.recipeRev = rev;
  if (recipe.resources) result.resources = recipe.resources;

  const realRoot = realOrNull(root);
  const worktree = realOrNull(opts.worktreePath);
  if (!realRoot || !worktree) return fail(new Error("the primary checkout or the new worktree is not reachable"));
  if (worktree === realRoot) return fail(new Error("refusing to apply a setup recipe to the primary checkout itself"));
  const gitDir = path.join(realRoot, ".git");

  // ── Plan: resolve and check everything before writing anything. ──
  const skip = (p: string, reason: string) => result.skipped.push({ path: p, reason });
  /** The real source of a repo-relative path, when it stays in the primary checkout. */
  const source = (rel: string): string | null => {
    const real = realOrNull(path.join(root, rel));
    if (!real) return null;
    return isInside(real, realRoot) && real !== realRoot && !isInside(real, gitDir) ? real : null;
  };

  const copies: Planned[] = [];
  let copyBytes = 0;
  try {
    const seen = new Set<string>();
    for (const pattern of recipe.copy) {
      const matched = matchCopy(pattern, root);
      if (matched.length === 0) skip(pattern, "nothing matches it in the primary checkout");
      for (const rel of matched) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const src = source(rel);
        if (!src) {
          skip(rel, "resolves outside the primary checkout (a symlink escape) or is missing");
          continue;
        }
        const st = statSync(src);
        if (!st.isFile()) {
          skip(rel, "is not a file (use share for directories)");
          continue;
        }
        const blocked = parentProblem(worktree, rel);
        if (blocked) {
          skip(rel, blocked);
          continue;
        }
        if (exists(path.join(worktree, rel))) {
          skip(rel, "already exists in the new worktree (not overwritten)");
          continue;
        }
        copyBytes += st.size;
        copies.push({ rel, src });
      }
    }
    if (copies.length > LIMITS.COPY_FILES) throw new SetupRecipeError(`copy matches more than ${LIMITS.COPY_FILES} files`);
    if (copyBytes > LIMITS.COPY_BYTES) throw new SetupRecipeError(`copy matches more than ${LIMITS.COPY_BYTES / 1024 / 1024} MiB`);
    // A copied file must be ignored where it lands, so it can never be
    // committed (the destroy-time WIP snapshot runs `git add -A`).
    const ignored = await ignoredIn(worktree, copies.map((c) => c.rel));
    for (const c of copies.splice(0)) {
      if (ignored.has(c.rel)) copies.push(c);
      else skip(c.rel, "is not ignored by git in the new worktree (copying it would let it be committed)");
    }
  } catch (err) {
    return fail(err);
  }

  const shares: Planned[] = [];
  for (const rel of recipe.share) {
    if (!exists(path.join(root, rel))) {
      skip(rel, "doesn't exist in the primary checkout");
      continue;
    }
    const src = source(rel);
    if (!src) {
      skip(rel, "resolves outside the primary checkout (a symlink escape)");
      continue;
    }
    if (!statSync(src).isDirectory()) {
      skip(rel, "is not a directory (use copy for files)");
      continue;
    }
    const blocked = parentProblem(worktree, rel);
    if (blocked) {
      skip(rel, blocked);
      continue;
    }
    if (exists(path.join(worktree, rel))) {
      skip(rel, "already exists in the new worktree (not replaced)");
      continue;
    }
    shares.push({ rel, src });
  }

  // ── Apply, rolling back on any failure. ──
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  try {
    for (const c of copies) {
      ensureParents(worktree, c.rel, createdDirs);
      const dest = path.join(worktree, c.rel);
      // EXCL: never overwrite, and never write through a symlink planted at dest.
      copyFileSync(c.src, dest, constants.COPYFILE_EXCL);
      createdFiles.push(dest);
      chmodSync(dest, statSync(c.src).mode & 0o777);
      result.copied.push(c.rel);
    }
    for (const s of shares) {
      ensureParents(worktree, s.rel, createdDirs);
      const dest = path.join(worktree, s.rel);
      symlinkSync(s.src, dest, "dir");
      createdFiles.push(dest);
      result.shared.push(s.rel);
    }
  } catch (err) {
    for (const f of createdFiles.reverse()) {
      try {
        unlinkSync(f);
      } catch {}
    }
    for (const d of createdDirs.reverse()) {
      try {
        rmdirSync(d);
      } catch {}
    }
    result.copied = [];
    result.shared = [];
    return fail(new Error(`setup couldn't put the recipe's files in place (nothing was left behind): ${err instanceof Error ? err.message : String(err)}`));
  }
  result.applied = true;

  if (result.shared.length > 0) {
    try {
      const ignored = await ignoredIn(worktree, result.shared);
      for (const rel of result.shared) {
        if (!ignored.has(rel)) {
          result.warnings.push(
            `the shared link ${rel} isn't ignored by git (a "${rel}/" pattern matches directories, not a symlink — use "${rel}"), so git status shows it`,
          );
        }
      }
    } catch {
      // advisory only
    }
  }

  if (recipe.command) {
    const refusal = commandRefusal(opts.policy, root);
    if (refusal) {
      result.commandSkipped = refusal;
    } else {
      const timeoutSec = recipe.timeoutSec ?? DEFAULT_SETUP_TIMEOUT_SEC;
      result.command = await runSetupCommand(recipe.command, {
        cwd: worktree,
        timeoutMs: timeoutSec * 1000,
        env: { CODEOID_PRIMARY_CHECKOUT: realRoot, CODEOID_WORKTREE: worktree },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (result.command.timedOut) result.error = `the setup command timed out after ${timeoutSec}s`;
      else if (result.command.exitCode !== 0) {
        result.error = result.command.exitCode === null ? "the setup command didn't run to completion" : `the setup command exited ${result.command.exitCode}`;
      }
    }
  }
  return result;
}

/**
 * Run the setup command in its own process group (killed whole at the
 * timeout or on abort — a package manager's children otherwise hold the
 * pipes open), with a built environment: the shared safe basics, never the
 * daemon's secrets. `CODEOID_AGENT_ENV_ALLOW` passes more, as everywhere.
 */
async function runSetupCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; env: Record<string, string>; signal?: AbortSignal },
): Promise<WorktreeSetupCommandResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    const push = (b: Buffer) => {
      tail = Buffer.concat([tail, b]);
      if (tail.length > LIMITS.OUTPUT_TAIL * 2) tail = tail.subarray(tail.length - LIMITS.OUTPUT_TAIL);
    };
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd: opts.cwd,
        env: { ...buildSubprocessEnv({ prefixes: ["XDG_"] }), ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      resolve({ command, exitCode: null, timedOut: false, outputTail: err instanceof Error ? err.message : String(err), durationMs: 0 });
      return;
    }
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    let timedOut = false;
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const text = tail.toString("utf8");
      resolve({
        command,
        exitCode,
        timedOut,
        outputTail: text.length > LIMITS.OUTPUT_TAIL ? text.slice(-LIMITS.OUTPUT_TAIL) : text,
        durationMs: Date.now() - t0,
      });
    };
    const onAbort = () => {
      if (settled) return;
      killGroup();
      done(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      done(null);
    }, opts.timeoutMs);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      push(Buffer.from(e.message));
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/**
 * One line (plus the output tail on a command failure) for the session's
 * notice, or null when there was no recipe and nothing to say.
 */
export function describeSetupResult(r: WorktreeSetupResult): string | null {
  if (!r.applied && !r.error) return null;
  const parts: string[] = [];
  if (r.copied.length) parts.push(`copied ${r.copied.join(", ")}`);
  if (r.shared.length) parts.push(`shared ${r.shared.join(", ")}`);
  if (r.command && !r.error) parts.push(`ran \`${r.command.command}\` in ${(r.command.durationMs / 1000).toFixed(1)}s`);
  const skipped = r.skipped.map((s) => `${s.path} ${s.reason}`);
  const notes = [...skipped, ...r.warnings, ...(r.commandSkipped ? [`the setup command didn't run: ${r.commandSkipped}`] : [])];
  const rev = r.recipeRev ? ` (recipe from ${r.recipeRev.slice(0, 10)})` : "";
  if (r.error) {
    const tail = r.command?.outputTail.trim() ? `\n${r.command.outputTail.trim().slice(-600)}` : "";
    return `✗ Worktree setup failed${rev}: ${r.error}. This is a setup problem, not the agent's — the worktree is kept as it is.${
      parts.length ? ` Done before it failed: ${parts.join("; ")}.` : ""
    }${notes.length ? ` Notes: ${notes.join("; ")}.` : ""}${tail}`;
  }
  return `✓ Worktree prepared${rev}${parts.length ? `: ${parts.join("; ")}` : ""}.${notes.length ? ` Notes: ${notes.join("; ")}.` : ""}`;
}
