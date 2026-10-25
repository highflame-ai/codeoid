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
 * command: bun install --ignore-scripts  # run in the new worktree, only when trusted
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
 *     git there, so it can never be committed; nothing existing is
 *     overwritten, and a file with other hard links is never copied.
 *   - `share` is a deliberate isolation break: a WRITABLE link into the
 *     primary checkout, so a worker can change what every other worktree and
 *     the user see there. Use it for regenerable dependency directories only;
 *     config and tooling directories (`.claude`, `.codeoid`, `.vscode`,
 *     `.idea`, `.husky`, `.git*`) are refused.
 *   - `command` runs only under `worktree.setup.runCommands: "trusted-repos"`
 *     and only while the recipe's git blob is the one the owner trusted with
 *     `codeoid worktree trust` (direnv-allow style: a changed recipe runs
 *     nothing until it is trusted again; an entry holds only for the owner
 *     who recorded it), and only when the worktree's base commit carries that
 *     recipe and is on the primary checkout's history ({@link commandGate}) —
 *     never another branch, a pull request, or an agent's own commit. An
 *     agent working in the primary checkout itself can still commit there.
 *     It runs on the CLEAN checkout of the
 *     worktree's base commit, before any uncommitted state a fork carries is
 *     applied, with a built environment, never the daemon's own (GHSA-38vh).
 *     Trust therefore covers the repository's committed content at setup
 *     time — including every script the command invokes (package.json
 *     lifecycle scripts, a Makefile, a script in the repo). Prefer commands
 *     that run no repository scripts, e.g. `bun install --ignore-scripts`.
 *
 * Everything is validated before anything is written; a failure while
 * writing rolls back what this run created. A setup failure is an
 * infrastructure error: it is reported, never thrown, and never removes the
 * worktree or touches the primary checkout. Not available on Windows.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { GIT_BIN, gitEnv } from "./git-env.js";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  type Stats,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { mainWorktreeRoot } from "./git-worktree.js";
import { redactSecretText } from "./mcp/redact.js";
import { buildSubprocessEnv } from "./providers/env.js";

const execFileP = promisify(execFile);

/** Where the recipe lives, relative to the repository root. */
export const SETUP_RECIPE_PATH = ".codeoid/setup.yaml";
/** Default wall-clock for the setup command (dependency installs can be slow). */
export const DEFAULT_SETUP_TIMEOUT_SEC = 600;
/** Recipes are POSIX-only: symlinked shares, process groups, `/bin/sh`. */
export const WORKTREE_SETUP_SUPPORTED = process.platform !== "win32";

const LIMITS = {
  RECIPE_BYTES: 64 * 1024,
  COPY_FILES: 500,
  COPY_BYTES: 256 * 1024 * 1024,
  OUTPUT_TAIL: 8 * 1024,
  /** After the shell exits, how long its output pipes may still drain. */
  DRAIN_MS: 500,
} as const;

/**
 * Directories `share` refuses: a writable link to one would let a worker
 * change the primary checkout's agent config, editor settings or git hooks.
 */
const UNSHAREABLE = new Set([".claude", ".codeoid", ".vscode", ".idea", ".husky"]);

// ── Recipe schema ────────────────────────────────────────────────────────────

/** `./a/b/` → `a/b`. */
function normalizeRel(p: string): string {
  let s = p.trim();
  while (s.startsWith("./")) s = s.slice(2);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** `.git` in any case: case-insensitive filesystems treat `.GIT` as the same directory. */
const isGitSegment = (s: string) => s.toLowerCase() === ".git";

/** Why `p` can't name a path inside the repository, or null when it can. */
function relPathProblem(p: string, kind: "copy" | "share"): string | null {
  if (p.includes("\0")) return "contains a NUL byte";
  if (p.includes("\\")) return "uses a backslash (use / separators)";
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return "is absolute (paths are relative to the repository root)";
  if (p.startsWith("~")) return "starts with ~ (paths are relative to the repository root)";
  const segs = p.split("/");
  if (segs.includes("..")) return "has a .. segment (paths must stay inside the repository)";
  if (segs.some(isGitSegment)) return "is inside .git";
  if (segs.every((s) => s === "" || s === ".")) return "names the repository root";
  if (kind === "share") {
    if (GLOB_CHARS.test(p)) return "is a glob (share takes plain directory paths)";
    const tooling = segs.find((s) => UNSHAREABLE.has(s.toLowerCase()) || s.toLowerCase().startsWith(".git"));
    if (tooling) return `is a config or tooling directory (${tooling}) — sharing it would let a worker change the primary checkout's`;
  }
  return null;
}

const relPath = (kind: "copy" | "share") =>
  z
    .string()
    .min(1)
    .max(1024)
    .transform(normalizeRel)
    .superRefine((p, ctx) => {
      const why = relPathProblem(p, kind);
      if (why) ctx.addIssue({ code: "custom", message: `${JSON.stringify(p)} ${why}` });
    });

export const SetupRecipeSchema = z
  .object({
    /** Ignored files to copy from the primary checkout; globs allowed. */
    copy: z.array(relPath("copy")).max(256).default([]),
    /** Directories to symlink, writable, from the primary checkout (e.g. node_modules). */
    share: z.array(relPath("share")).max(64).default([]),
    /** Shell command run in the new worktree's root — only for a trusted recipe. */
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

/** git with hooks and fsmonitor off and git-env.ts's environment (no network, no replace refs); `okCodes` are exits that aren't errors. */
async function git(args: string[], cwd: string, opts: { okCodes?: number[]; input?: string } = {}): Promise<{ code: number; stdout: string }> {
  const argv = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
  if (opts.input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn(GIT_BIN, argv, { cwd, env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] });
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
    // No network: a lazy fetch would run whatever remote config an agent wrote
    // (this runs during a loop's verification, after its worker is stopped).
    const { stdout } = await execFileP(GIT_BIN, argv, { cwd, env: gitEnv(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
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

/** A recipe as committed: the parsed content, where it came from, and its git blob id (what trust pins). */
export interface FoundRecipe {
  recipe: SetupRecipe;
  /** The commit it was read from (the primary checkout's HEAD). */
  rev: string;
  /** The primary checkout. */
  root: string;
  /** The recipe file's git blob id — the content `codeoid worktree trust` pins. */
  recipeHash: string;
}

/** {@link readSetupRecipe}'s outcome without a throw: a recipe, none, or why it's unusable. */
export type RecipeRead = FoundRecipe | null | { error: string };

/**
 * The recipe at the primary checkout's committed `HEAD`, or null when there
 * is none (no file, or no commit yet). The working tree is never read: the
 * recipe that prepares a worktree is the one the user committed, not one an
 * agent left uncommitted or put on a branch. Throws {@link SetupRecipeError}
 * when the file is there but unusable.
 */
export async function readSetupRecipe(repoDir: string): Promise<FoundRecipe | null> {
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
  const blob = m[3] as string;
  // Trust is pinned to this id: the text run must be the text it names, not
  // whatever a rewritten object in the store holds. Hashed as raw bytes.
  const { stdout: bytes } = await execFileP(GIT_BIN, ["-c", "core.hooksPath=/dev/null", "cat-file", "blob", blob], {
    cwd: root,
    env: gitEnv(),
    encoding: "buffer",
    timeout: 60_000,
    maxBuffer: LIMITS.RECIPE_BYTES + 1024,
  });
  const hash = createHash(blob.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (hash !== blob) throw new SetupRecipeError(`${SETUP_RECIPE_PATH} at ${rev.slice(0, 10)} doesn't match its object id — the repository's object store was altered`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SetupRecipeError(`${SETUP_RECIPE_PATH} at ${rev.slice(0, 10)} isn't UTF-8`);
  }
  return { recipe: parseSetupRecipe(text), rev, root, recipeHash: blob };
}

/** {@link readSetupRecipe} that never throws. */
export async function loadSetupRecipe(repoDir: string): Promise<RecipeRead> {
  try {
    return await readSetupRecipe(repoDir);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** A repository whose recipe command the owner trusted, pinned to the recipe's content. */
export interface TrustedRecipe {
  /** The primary checkout (absolute). */
  path: string;
  /** The recipe's git blob id when it was trusted. */
  recipeHash: string;
  /**
   * Who trusted it. Honoured only for worktrees whose session owner is the
   * same subject (a shared daemon); an entry without it (hand-written in
   * config.json) holds for every owner.
   */
  trustedBy?: string;
}

/** `config.worktree.setup`: whether a recipe's `command` may run. */
export interface WorktreeSetupPolicy {
  /** `never` (default): never run a recipe command. `trusted-repos`: only a recipe in `trustedRepos`. */
  runCommands: "never" | "trusted-repos";
  /**
   * Trusted recipes. A bare path (the first shape of this setting) trusts no
   * command: there is no content to pin, so it waits for `codeoid worktree trust`.
   */
  trustedRepos: readonly (string | TrustedRecipe)[];
}

export interface CommandRefusal {
  /**
   * off: commands disabled; untrusted: never trusted (by this owner);
   * changed: the recipe changed since; base-not-on-primary: the worktree's
   * base commit isn't reviewed content (see {@link commandGate});
   * unsupported: platform.
   */
  code: "off" | "untrusted" | "changed" | "base-not-on-primary" | "unsupported";
  reason: string;
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

const TRUST_HINT = "run `codeoid worktree trust` in the repository to review its command and trust it";

/** Null when `root`'s recipe (blob `recipeHash`) may run its command, else why not. */
export function commandRefusal(policy: WorktreeSetupPolicy | undefined, root: string, recipeHash: string, ownerSub?: string): CommandRefusal | null {
  if (!WORKTREE_SETUP_SUPPORTED) return { code: "unsupported", reason: "setup commands aren't supported on Windows" };
  if (!policy || policy.runCommands !== "trusted-repos") {
    return { code: "off", reason: "recipe commands are off (set worktree.setup.runCommands to trusted-repos, then trust the recipe with `codeoid worktree trust`)" };
  }
  const real = realOrNull(root);
  const mine = real ? policy.trustedRepos.filter((e) => path.isAbsolute(typeof e === "string" ? e : e.path) && realOrNull(typeof e === "string" ? e : e.path) === real) : [];
  const pinned = mine.filter((e): e is TrustedRecipe => typeof e !== "string" && (e.trustedBy === undefined || e.trustedBy === ownerSub));
  if (pinned.some((e) => e.recipeHash === recipeHash)) return null;
  if (pinned.length > 0) return { code: "changed", reason: `the setup command changed since you trusted it — ${TRUST_HINT}` };
  if (mine.length > 0) return { code: "untrusted", reason: `this repository is trusted by path only, which runs no command — ${TRUST_HINT}` };
  return { code: "untrusted", reason: `this repository's recipe isn't trusted — ${TRUST_HINT}` };
}

/**
 * The whole decision on whether a worktree's setup command may run — the
 * trust in {@link commandRefusal}, then the worktree's ACTUAL base commit
 * (its HEAD, still clean at setup time): it must carry the very recipe
 * that was trusted, and be on the primary checkout's history. A branch, a
 * fetched pull request, an agent's commit on a `codeoid/*` branch or the WIP
 * commit codeoid saves on destroy is content nobody reviewed, and the
 * command would run its scripts. Null when it may run.
 */
export async function commandGate(
  read: FoundRecipe,
  policy: WorktreeSetupPolicy | undefined,
  worktreePath: string,
  ownerSub?: string,
  /** The commit the worktree's content builds on, when its HEAD isn't it. */
  baseCommit?: string,
): Promise<CommandRefusal | null> {
  const refusal = commandRefusal(policy, read.root, read.recipeHash, ownerSub);
  if (refusal) return refusal;
  const off: CommandRefusal = {
    code: "base-not-on-primary",
    reason:
      "this worktree starts from a commit that isn't on your checkout's branch (another branch, a pull request, or an agent's commit), so the trusted command would run code you haven't reviewed",
  };
  try {
    const base = baseCommit ?? (await git(["rev-parse", "--verify", "HEAD^{commit}"], worktreePath)).stdout.trim();
    const blob = await git(["rev-parse", "--verify", "--quiet", `${base}:${SETUP_RECIPE_PATH}`], read.root, { okCodes: [1, 128] });
    if (blob.code !== 0 || blob.stdout.trim() !== read.recipeHash) return off;
    const onPrimary = await git(["merge-base", "--is-ancestor", base, read.rev], read.root, { okCodes: [1] });
    return onPrimary.code === 0 ? null : off;
  } catch {
    return off;
  }
}

/** Whether preparing `worktreePath` from `read` would run a command (it then needs the clean checkout). */
export async function willRunCommand(read: RecipeRead, policy: WorktreeSetupPolicy | undefined, worktreePath: string, ownerSub?: string): Promise<boolean> {
  if (!read || "error" in read || !read.recipe.command) return false;
  return (await commandGate(read, policy, worktreePath, ownerSub)) === null;
}

// ── Prepare ──────────────────────────────────────────────────────────────────

export interface WorktreeSetupCommandResult {
  command: string;
  /** Exit code; null when it couldn't start or was killed. */
  exitCode: number | null;
  timedOut: boolean;
  /** The last few KiB of combined stdout + stderr, with token-like strings redacted. */
  outputTail: string;
  durationMs: number;
}

export interface WorktreeSetupResult {
  /** A recipe was found and its copy/share steps were put in place. */
  applied: boolean;
  /** The commit the recipe was read from. */
  recipeRev?: string;
  /** The recipe's git blob id. */
  recipeHash?: string;
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
  commandSkippedCode?: CommandRefusal["code"];
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
  st?: Stats;
}

const isInside = (child: string, root: string) => child === root || child.startsWith(root + path.sep);
/** {@link isInside}, case-insensitively — for `.git`, which a case-insensitive filesystem also answers to as `.GIT`. */
const isInsideCi = (child: string, root: string) => isInside(child.toLowerCase(), root.toLowerCase());

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
    if (!posix.split("/").some(isGitSegment)) out.push(posix);
    if (out.length > LIMITS.COPY_FILES) break;
  }
  return out.sort();
}

/**
 * Copy `src` to a new `dest` through file descriptors: the source opened
 * without following a symlink and re-checked to be the very file planned (a
 * single-link regular file), the destination created exclusively, never
 * through a symlink. `dest` goes into `created` as soon as it exists, so a
 * failure part-way still rolls it back.
 */
function copyNoFollow(src: string, dest: string, planned: Stats, created: string[]): void {
  const from = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(from);
    if (!st.isFile() || st.nlink !== 1 || st.ino !== planned.ino || st.dev !== planned.dev) {
      throw new Error(`${src} changed while setup was copying it`);
    }
    const mode = st.mode & 0o777;
    const to = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    created.push(dest);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let pos = 0; ; ) {
        const n = readSync(from, buf, 0, buf.length, pos);
        if (n === 0) break;
        for (let off = 0; off < n; ) off += writeSync(to, buf, off, n - off);
        pos += n;
      }
      fchmodSync(to, mode);
    } finally {
      closeSync(to);
    }
  } finally {
    closeSync(from);
  }
}

/**
 * Apply the repository's setup recipe to a worktree codeoid just created:
 * copy the ignored files it names, symlink its shared directories, and (when
 * the owner trusted this exact recipe) run its command. `worktreePath` is the
 * worktree ROOT, still a clean checkout of its base commit when a command
 * will run (see git-worktree.ts `deferCarry`). `recipe`, when given, is the
 * read a caller already decided on — so what it planned for is what runs.
 * Never throws; failures come back in `error`.
 */
export async function prepareWorktree(opts: {
  worktreePath: string;
  policy?: WorktreeSetupPolicy;
  /** Abort a running command (session destroyed, routine cancelled, daemon stopping). */
  signal?: AbortSignal;
  recipe?: RecipeRead;
  /** The session owner's subject — trust entries recorded by someone else don't apply. */
  ownerSub?: string;
  /** Apply the recipe's `share` links (default true). A loop turns them off:
   *  a shared directory is a writable link into the primary checkout, so its
   *  worker could change what the checks run without it showing in the diff. */
  share?: boolean;
  /**
   * The commit the worktree's content builds on, when its HEAD is not that
   * commit: a loop checks a candidate in a scratch checkout of a commit made
   * for it. The command's gate asks of this commit what it asks of a HEAD.
   */
  baseCommit?: string;
  /** More environment for the command (a loop's marker, so what it leaves running is found). */
  extraEnv?: Record<string, string>;
}): Promise<WorktreeSetupResult> {
  const result: WorktreeSetupResult = { applied: false, copied: [], shared: [], skipped: [], warnings: [] };
  const fail = (err: unknown): WorktreeSetupResult => {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  };
  if (!WORKTREE_SETUP_SUPPORTED) return result;

  const found = opts.recipe !== undefined ? opts.recipe : await loadSetupRecipe(opts.worktreePath);
  if (!found) return result;
  if ("error" in found) return fail(found.error);
  const { recipe, rev, root, recipeHash } = found;
  result.recipeRev = rev;
  result.recipeHash = recipeHash;
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
    return isInside(real, realRoot) && real !== realRoot && !isInsideCi(real, gitDir) ? real : null;
  };

  const copies: Planned[] = [];
  const shares: Planned[] = [];
  try {
    let copyBytes = 0;
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
        const st = lstatSync(src);
        if (!st.isFile()) {
          skip(rel, "is not a file (use share for directories)");
          continue;
        }
        if (st.nlink > 1) {
          skip(rel, "has other hard links (the same file may live outside the primary checkout)");
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
        copies.push({ rel, src, st });
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

    for (const rel of recipe.share) {
      if (opts.share === false) {
        skip(rel, "not shared into a loop's worktree (its worker could change it outside the diff); install it with the setup command instead");
        continue;
      }
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
  } catch (err) {
    return fail(err);
  }

  // ── Apply, rolling back on any failure. ──
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  try {
    for (const c of copies) {
      ensureParents(worktree, c.rel, createdDirs);
      copyNoFollow(c.src, path.join(worktree, c.rel), c.st as Stats, createdFiles);
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
    const refusal = await commandGate(found, opts.policy, worktree, opts.ownerSub, opts.baseCommit);
    if (refusal) {
      result.commandSkipped = refusal.reason;
      result.commandSkippedCode = refusal.code;
    } else {
      const timeoutSec = recipe.timeoutSec ?? DEFAULT_SETUP_TIMEOUT_SEC;
      result.command = await runSetupCommand(recipe.command, {
        cwd: worktree,
        timeoutMs: timeoutSec * 1000,
        env: { ...(opts.extraEnv ?? {}), CODEOID_PRIMARY_CHECKOUT: realRoot, CODEOID_WORKTREE: worktree },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (result.command.timedOut) result.error = `the setup command timed out after ${timeoutSec}s`;
      else if (opts.signal?.aborted) result.error = "the setup command was stopped";
      else if (result.command.exitCode !== 0) {
        result.error = result.command.exitCode === null ? "the setup command didn't run to completion" : `the setup command exited ${result.command.exitCode}`;
      }
    }
  }
  return result;
}

/**
 * Run the setup command in its own process group, with a built environment:
 * the shared safe basics, never the daemon's secrets
 * (`CODEOID_AGENT_ENV_ALLOW` passes more, as everywhere). The WHOLE group is
 * killed when the shell exits as well as at the timeout or an abort, so a
 * daemonized descendant can't outlive setup and keep running in the
 * worktree. Settles on the shell's exit, then lets the pipes drain briefly.
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
    // Listeners go on before anything can be emitted.
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    let timedOut = false;
    let settled = false;
    let exited: number | null | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      try {
        // Negative pid: the process group the detached shell leads.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      opts.signal?.removeEventListener("abort", onAbort);
      const text = redactSecretText(tail.toString("utf8"));
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
    child.on("exit", (code) => {
      exited = code;
      killGroup();
      drain = setTimeout(() => done(exited ?? null), LIMITS.DRAIN_MS);
    });
    child.on("close", (code) => done(exited !== undefined ? exited : code));
  });
}

/**
 * Shared entries that are no longer the recipe's symlinks — what carrying a
 * fork's uncommitted state can do when it holds tracked files at that path
 * (git replaces the link with a directory). Empty when all are intact.
 */
export function brokenShares(worktreePath: string, shared: readonly string[]): string[] {
  return shared.filter((rel) => {
    try {
      return !lstatSync(path.join(worktreePath, rel)).isSymbolicLink();
    } catch {
      return true;
    }
  });
}

/** The session event a result is surfaced as. */
export function setupEvent(r: WorktreeSetupResult): "worktree.setup.failed" | "worktree.setup.untrusted" | "worktree.setup.done" {
  if (r.error) return "worktree.setup.failed";
  if (r.commandSkippedCode === "changed" || r.commandSkippedCode === "untrusted" || r.commandSkippedCode === "base-not-on-primary") {
    return "worktree.setup.untrusted";
  }
  return "worktree.setup.done";
}

/**
 * One line (plus the output tail on a command failure) for the session's
 * notice, or null when there was no recipe and nothing to say.
 */
export function describeSetupResult(r: WorktreeSetupResult): string | null {
  if (!r.applied && !r.error) return null;
  const parts: string[] = [];
  if (r.copied.length) parts.push(`copied ${r.copied.join(", ")}`);
  if (r.shared.length) parts.push(`shared ${r.shared.join(", ")} (writable links into the primary checkout)`);
  if (r.command && !r.error) parts.push(`ran \`${r.command.command}\` in ${(r.command.durationMs / 1000).toFixed(1)}s`);
  const skipped = r.skipped.map((s) => `${s.path} ${s.reason}`);
  const untrusted = setupEvent(r) === "worktree.setup.untrusted";
  const notes = [...skipped, ...r.warnings, ...(r.commandSkipped && !untrusted ? [`the setup command didn't run: ${r.commandSkipped}`] : [])];
  const rev = r.recipeRev ? ` (recipe from ${r.recipeRev.slice(0, 10)})` : "";
  if (r.error) {
    const tail = r.command?.outputTail.trim() ? `\n${r.command.outputTail.trim().slice(-600)}` : "";
    return `✗ Worktree setup failed${rev}: ${r.error}. This is a setup problem, not the agent's — the worktree is kept as it is.${
      parts.length ? ` Done before it failed: ${parts.join("; ")}.` : ""
    }${notes.length ? ` Notes: ${notes.join("; ")}.` : ""}${tail}`;
  }
  const head = untrusted ? `⚠️ Worktree prepared without its setup command${rev}: ${r.commandSkipped}.` : `✓ Worktree prepared${rev}.`;
  return `${head}${parts.length ? ` ${parts.join("; ")}.` : ""}${notes.length ? ` Notes: ${notes.join("; ")}.` : ""}`;
}
