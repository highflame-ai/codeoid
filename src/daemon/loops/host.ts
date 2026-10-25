/**
 * The loop controller's window onto the daemon (LoopHost): worktrees, the
 * dispatcher, worker sessions, snapshots, evidence, and delivery.
 *
 * Built from a narrow set of daemon capabilities so SessionManager only
 * supplies them; everything loop-specific about using them lives here.
 */

import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { AuthContext } from "../../protocol/types.js";
import type { Dispatcher } from "../dispatch.js";
import { redactOutput } from "../evidence/redact.js";
import type { EvidenceService } from "../evidence/service.js";
import { execFile } from "node:child_process";
import { GIT_BIN, gitEnv, hardenedGit as git } from "../git-env.js";
import { killMarked, procStartTime, ticksNow } from "../process-tree.js";
import { applyCarriedState, createForkWorktree, removeForkWorktree } from "../git-worktree.js";
import type { Session } from "../session.js";
import { brokenShares, loadSetupRecipe, parseSetupRecipe, prepareWorktree, SETUP_RECIPE_PATH, type WorktreeSetupPolicy } from "../workspace-setup.js";
import { assertNoLinkedParent, commitTree, copyDir, fingerprint, listTree, removeTree, removeTreeAsync, type NameFolding, ObjectReader, resolveUnder, restoreTree, type Stamps, writeTree } from "./materialize.js";
import type { CandidateCheckout, LoopHost, PreparedWorkspace, WorkerInfo } from "./service.js";
import { githubFetch, parseGithubRemote } from "./triggers/github.js";
import { type LoopRunRow, LoopWorkspaceUnsupportedError } from "./types.js";


/**
 * Paths a new or changed file must not have to enter a candidate. A heuristic,
 * not a guarantee: environment files (examples and templates excepted), keys,
 * and the usual credential files.
 */
const SECRET_PATH = new RegExp(
  [
    String.raw`(^|/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$`,
    String.raw`\.(pem|key|p12|pfx|jks|keystore|tfvars)$`,
    String.raw`(^|/)(credentials|service-account|secrets?)[^/]*\.(json|ya?ml|toml|ini|txt)$`,
    String.raw`(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$`,
    String.raw`(^|/)\.(netrc|pgpass|npmrc|pypirc|git-credentials)$`,
    String.raw`(^|/)\.aws/credentials$`,
    String.raw`(^|/)\.docker/config\.json$`,
    String.raw`(^|/)kubeconfig[^/]*$`,
  ].join("|"),
  "i",
);

/** Write a file that must be new (nothing in its place is followed). */
function writeExclusive(path: string, data: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Wait (up to 2.5s) until a file made now in `dir` has a change time past `ctimeNs`. */
async function clockPast(dir: string, ctimeNs: bigint): Promise<void> {
  const until = Date.now() + 2_500;
  while (Date.now() < until) {
    const probe = join(dir, `.tick-${randomUUID()}`);
    writeExclusive(probe, Buffer.alloc(0));
    let now: bigint;
    try {
      now = lstatSync(probe, { bigint: true }).ctimeNs;
    } finally {
      rmSync(probe, { force: true });
    }
    if (now > ctimeNs) return;
    await new Promise<void>((res) => setTimeout(res, 5));
  }
}

/** Every config key matching `pattern`, in every scope, with its value; null when git can't tell. */
function configEntries(cwd: string, pattern: string): Promise<Array<[string, string]> | null> {
  return new Promise((res) => {
    execFile(GIT_BIN, ["config", "--null", "--get-regexp", pattern], { cwd, env: gitEnv({ LANG: "C" }), timeout: 30_000 }, (err, stdout) => {
      // Exit 1: nothing matches.
      if (err) return res((err as { code?: unknown }).code === 1 ? [] : null);
      res(
        stdout
          .split("\0")
          .filter(Boolean)
          .map((kv): [string, string] => (kv.includes("\n") ? [kv.slice(0, kv.indexOf("\n")), kv.slice(kv.indexOf("\n") + 1)] : [kv, ""])),
      );
    });
  });
}

/** The values of every config key matching `pattern`, in every scope; `["?"]` when git can't tell, so a caller refuses. */
async function configValues(cwd: string, pattern: string): Promise<string[]> {
  const entries = await configEntries(cwd, pattern);
  return entries ? entries.map(([, v]) => v) : ["?"];
}

/**
 * What a fetch of github.com/`ghRepo` may say it already has: the newest tips
 * of the remote-tracking branches of remotes whose every URL is that
 * repository on github.com and that no `url.*.insteadOf` rewrites (so what
 * they hold came from there), read offline. A remote that points elsewhere —
 * or a ref under `refs/remotes/` no such remote owns — is not a have.
 */
export async function fetchHaves(repo: string, ghRepo: string, max = 32): Promise<string[]> {
  const [urls, rewrites] = await Promise.all([configEntries(repo, "^remote\\..+\\.url$"), configEntries(repo, "^url\\..+\\.insteadof$")]);
  if (!urls || !rewrites) return [];
  const byRemote = new Map<string, string[]>();
  for (const [key, url] of urls) {
    // `remote.<name>.url`: the name keeps its case, and may hold dots.
    const name = key.slice("remote.".length, -".url".length);
    byRemote.set(name, [...(byRemote.get(name) ?? []), url]);
  }
  const want = ghRepo.toLowerCase();
  const names = [...byRemote].flatMap(([name, list]) => {
    // A name that would be a pattern, or not a plain path segment run, owns no refs here.
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split("/").some((part) => part === "" || part === "." || part === "..")) return [];
    // `refs/remotes/a/` would list the refs of a remote named `a/b` too.
    if ([...byRemote.keys()].some((other) => other.startsWith(`${name}/`))) return [];
    const ours = list.every((url) => parseGithubRemote(url)?.toLowerCase() === want && !rewrites.some(([, prefix]) => prefix !== "" && url.startsWith(prefix)));
    return ours ? [name] : [];
  });
  // No pattern lists every ref: none to list is no haves.
  if (names.length === 0) return [];
  const out = await git(["for-each-ref", "--sort=-committerdate", `--count=${max}`, "--format=%(objectname)", ...names.map((n) => `refs/remotes/${n}/`)], repo);
  return [...new Set(out.split("\n").filter((l) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(l)))];
}

/**
 * The run's worktree as git sees it, pinned to the directories recorded when it
 * was made. The worker can rewrite the worktree's `.git` file, its `commondir`
 * and its `core.worktree`; the environment outranks all three, so snapshots and
 * delivery act on this worktree of this repository whatever they say.
 */
function pinnedGit(run: LoopRunRow): { root: string; env: Record<string, string> } {
  if (!run.worktreeRoot || !run.gitDir || !run.commonDir) throw new Error("the run has no workspace");
  return { root: run.worktreeRoot, env: { GIT_DIR: run.gitDir, GIT_COMMON_DIR: run.commonDir, GIT_WORK_TREE: run.worktreeRoot } };
}

/** git reading raw objects from the run's repository: nothing of the
 *  daemon's environment, and nothing that consults replace refs. */
function readerEnv(run: LoopRunRow): Record<string, string> {
  if (!run.commonDir) throw new Error("the run has no workspace");
  return gitEnv({ LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_DIR: run.commonDir });
}

/** A directory the daemon owns: a real directory (not a link to one), this user's, private. */
function ownDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
    throw new Error(`${dir} is not a directory this daemon owns`);
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is open to other users`);
  return dir;
}

/** How a process is told apart from a later one with the same pid (a
 *  container restarted, a pid reused): its start time from /proc on Linux,
 *  else this process's wall-clock start. */
function startOf(pid: number): string | null {
  return process.platform === "linux" ? (procStartTime(pid) ?? null) : null;
}
const MY_START = startOf(process.pid) ?? String(Math.round(Date.now() - performance.now()));

/** How the filesystem under `dir` compares names, probed. */
function nameFolding(dir: string): NameFolding {
  const probe = (a: string, b: string): boolean => {
    const at = join(dir, a);
    try {
      writeFileSync(at, "");
      return existsSync(join(dir, b));
    } catch {
      return false;
    } finally {
      rmSync(at, { force: true });
    }
  };
  return { case: probe(".codeoid-Fold", ".codeoid-fold"), unicode: probe(".codeoid-\u00e9", ".codeoid-e\u0301") };
}

/** A process id still running (a daemon whose scratch checkouts are live). */
function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A fixed identity for commits that exist only to be checked out. */
const SCRATCH_IDENTITY = {
  GIT_AUTHOR_NAME: "codeoid",
  GIT_AUTHOR_EMAIL: "codeoid@localhost",
  GIT_COMMITTER_NAME: "codeoid",
  GIT_COMMITTER_EMAIL: "codeoid@localhost",
};

/**
 * Make `sha` available in `repo`, fetching `from.fetchRef` from GitHub when it
 * isn't. This is the only git the daemon runs with the network on, and it never
 * runs in your repository: your repository's config, which an agent can write,
 * could otherwise decide where the fetch goes and what it presents (a url
 * rewrite, a proxy, TLS settings, another credential helper). The fetch goes
 * into a repository the daemon makes for it under its own directory — no config
 * but the fetch's own (githubFetch: https only, gh as the only credential
 * helper, no global or system config) — which borrows your repository's objects
 * so only what is missing is downloaded: its haves are your repository's
 * remote-tracking tips, resolved offline and named in its own refs (nothing is
 * run in your repository to list them). What it fetched is checked as it
 * comes in, then streamed into your repository by hardened git, offline, and
 * checked again (`index-pack --strict`); an object's id is its content, so
 * nothing added can pose as anything else. Why the fetch failed is in the
 * error, redacted. A shallow or partial clone is refused before anything is
 * fetched (LoopWorkspaceUnsupportedError): its objects aren't whole, so it
 * can't stand behind the fetch's haves or take what comes.
 */
async function ensureCommit(
  repo: string,
  sha: string,
  from: { repo?: string; fetchRef?: string },
  scratchDir: string,
  remote?: (repo: string) => string,
): Promise<void> {
  const has = (): Promise<boolean> =>
    git(["cat-file", "-e", `${sha}^{commit}`], repo).then(
      () => true,
      () => false,
    );
  if (await has()) return;
  let why = "";
  if (from.fetchRef && from.repo) {
    // The ref names a branch or a pull request head and the repository is a
    // validated `owner/name` (both checked in the contract).
    const fetch = githubFetch(from.repo, from.fetchRef, remote?.(from.repo));
    const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo)).trim();
    await refuseIncompleteClone(repo, commonDir);
    let dir: string | null = null;
    try {
      // From the daemon's own directory, discovering nothing above it.
      dir = mkdtempSync(join(scratchDir, "fetch-"));
      const own = { GIT_DIR: dir, GIT_CONFIG_GLOBAL: "/dev/null" };
      await git(["init", "-q", "--bare", "--template=", `--object-format=${sha.length === 64 ? "sha256" : "sha1"}`, dir], scratchDir, {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CEILING_DIRECTORIES: dirname(scratchDir),
      });
      writeExclusive(join(dir, "objects", "info", "alternates"), Buffer.from(`${join(commonDir, "objects")}\n`));
      // What the fetch may say it has: the remote-tracking tips of your
      // remotes of this repository on github.com (what came from there
      // already), read offline by hardened git and named in the fetch
      // repository's own refs. Without them it would download the head's
      // whole history.
      for (const [i, tip] of (await fetchHaves(repo, from.repo)).entries()) {
        await git(["update-ref", "--no-deref", `refs/haves/${i}`, `${tip}^{commit}`], dir, own).catch(() => {});
      }
      // git has no client-side cap on what a fetch downloads (`receive.maxInputSize`
      // is the server's): the timeout bounds the download, and the size is
      // checked once it has finished.
      await git(fetch.args, dir, { ...fetch.env, GIT_DIR: dir }, { network: fetch.protocol, timeoutMs: FETCH_TIMEOUT_MS });
      const packs = join(dir, "objects", "pack");
      for (const name of readdirSync(packs).filter((n) => n.endsWith(".pack"))) {
        const at = join(packs, name);
        const size = statSync(at).size;
        if (size > FETCHED_PACK_MAX) {
          throw new LoopWorkspaceUnsupportedError(`the fetched pack is ${Math.ceil(size / 1024 ** 2)} MiB; a loop takes a head whose missing objects fit in ${FETCHED_PACK_MAX / 1024 ** 3} GiB`);
        }
        // Streamed from the file, never read into memory whole.
        await git(["index-pack", "--stdin", "--strict"], repo, {}, { input: createReadStream(at), timeoutMs: 600_000 });
      }
    } catch (err) {
      if (err instanceof LoopWorkspaceUnsupportedError) throw err;
      const e = err as { stderr?: unknown; message?: string };
      const text = typeof e.stderr === "string" && e.stderr.trim() ? e.stderr : (e.message ?? "");
      why = redactOutput(text).trim().split("\n").slice(-3).join(" ").slice(0, 500);
    } finally {
      if (dir) await removeTreeAsync(dir).catch(() => {});
    }
    if (await has()) return;
  }
  throw new Error(
    `commit ${sha.slice(0, 12)} is not in the repository and could not be fetched${from.repo && from.fetchRef ? ` from github.com/${from.repo} (${from.fetchRef})` : ""}${why ? `: ${why}` : ""}`,
  );
}

/** The largest pack a watch's fetch may bring in, checked once it has downloaded. */
const FETCHED_PACK_MAX = 2 * 1024 ** 3;
/** How long a watch's fetch may download for: what bounds it while it does. */
const FETCH_TIMEOUT_MS = 300_000;

/**
 * A shallow or partial clone is missing objects by design: a fetch can't
 * build on it, and what it took in wouldn't be whole. Said plainly, and not
 * retried (nothing changes until the clone does).
 */
async function refuseIncompleteClone(repo: string, commonDir: string): Promise<void> {
  if (existsSync(join(commonDir, "shallow"))) {
    throw new LoopWorkspaceUnsupportedError("this repository is a shallow clone: a shallow or partial clone can't fetch a pull request head for a loop yet (`git fetch --unshallow`, or clone it whole)");
  }
  const set = (values: string[]): boolean => values.some((v) => v !== "?" && v.trim() !== "" && v.trim().toLowerCase() !== "false");
  if (set(await configValues(repo, "^extensions\\.partialclone$")) || set(await configValues(repo, "^remote\\..*\\.promisor$"))) {
    throw new LoopWorkspaceUnsupportedError("this repository is a partial clone: a shallow or partial clone can't fetch a pull request head for a loop yet (clone it whole)");
  }
}

export interface LoopHostDeps {
  normalizeWorkdir(path: string): string | null;
  hasProvider(id: string): boolean;
  dispatcher: Dispatcher;
  /** The task's current claim generation, which hold/unhold must present. */
  taskGeneration(taskId: string): number | null;
  evidence: EvidenceService;
  worktreeSetupPolicy(): WorktreeSetupPolicy | undefined;
  /** The daemon's own directory for candidate checkouts and the setup files
   *  captured for them (made 0700). */
  scratchRoot: string;
  /** Where a watched repository is fetched from (default: github.com over
   *  https). Test-only override: no network in tests. */
  githubRemote?: (repo: string) => string;
  /** Create, register, and return a worker session for the run. */
  createWorkerSession(run: LoopRunRow): Promise<string>;
  /** The run ended: stop the worker acting autonomously. */
  releaseWorkerSession(sessionId: string): void;
  session(id: string): Session | undefined;
  /** The owner, acting through the loop: how its prompts are attributed. */
  senderFor(run: LoopRunRow): AuthContext;
  systemAuth(run: LoopRunRow): AuthContext;
  audit(subject: string, action: string, sessionId: string | undefined, detail: string): void;
  notifyOwner(run: LoopRunRow, kind: "waiting" | "finished" | "cancelled"): void;
}

export function buildLoopHost(d: LoopHostDeps): LoopHost {
  // Candidate checkouts live under the daemon's own directory, one per daemon
  // process (pid and start time); a stopped process's are swept, a running
  // one's left alone. Only real directories named as ours are ever removed.
  // Set up on first use, so a directory that can't be trusted fails a run,
  // not the daemon.
  let dirs: { mine: string; inputs: string } | null = null;
  const scratch = (): { mine: string; inputs: string } => {
    if (dirs) return dirs;
    const root = ownDir(d.scratchRoot);
    const checks = ownDir(join(root, "checks"));
    const inputs = ownDir(join(root, "inputs"));
    try {
      for (const name of readdirSync(checks)) {
        const m = /^(\d+)-(\d+)$/.exec(name);
        if (!m) continue;
        const pid = Number(m[1]);
        // Live only while that very process runs: same pid, same start (where
        // the start can't be read, any live process with that pid).
        const live = pid === process.pid ? m[2] === MY_START : alive(pid) && (startOf(pid) ?? m[2]) === m[2];
        if (live) continue;
        const at = join(checks, name);
        if (lstatSync(at).isDirectory()) removeTree(at);
      }
    } catch {
      // best effort
    }
    dirs = { mine: ownDir(join(checks, `${process.pid}-${MY_START}`)), inputs };
    return dirs;
  };
  /** Where a run's captured setup files live: what the recipe copied in before
   *  the worker could touch anything. */
  const inputsOf = (run: LoopRunRow): string => join(scratch().inputs, run.id.replace(/[^A-Za-z0-9_-]/g, ""));
  return {
    normalizeWorkdir: (p) => d.normalizeWorkdir(p),
    hasProvider: (id) => d.hasProvider(id),

    prepareWorkspace: async (run, signal, reserve): Promise<PreparedWorkspace> => {
      const repo = run.contract.workdir;
      const inRepo = await git(["rev-parse", "--is-inside-work-tree"], repo).then(
        (o) => o.trim() === "true",
        (err: unknown) => {
          // Hardened git refusing the repository says why.
          if (err instanceof Error && err.message.includes("refusing to run git")) throw err;
          return false;
        },
      );
      if (!inRepo) throw new Error(`a loop needs a git repository: ${repo}`);
      // Clean checkout first: the setup recipe's command sees committed content
      // only, then the user's uncommitted state is carried — the run repairs
      // what the user has, in its own worktree, without touching theirs.
      // A triggered run repairs the branch its event happened on: a clean
      // checkout of that branch's head commit, nothing of your checkout
      // carried. The commit may only be on GitHub (a pull request).
      const base = run.contract.baseRef;
      if (base) await ensureCommit(repo, base.sha, base, scratch().mine, d.githubRemote);
      // Claimed before it exists: no session may open there while setup runs.
      const wt = await createForkWorktree({
        workdir: repo,
        label: `loop-${run.id.slice(5, 13)}`,
        shortId: randomUUID().slice(0, 8),
        ...(base ? { baseCommit: base.sha } : { deferCarry: true }),
        hardened: true,
        onPath: (p) => {
          // Its parent made now, so the real path (through any symlinked
          // `-worktrees` directory) is what's claimed.
          mkdirSync(dirname(p), { recursive: true });
          reserve(join(realpathSync(dirname(p)), basename(p)));
        },
      });
      const discard = (): Promise<void> =>
        removeForkWorktree({ workdir: repo, worktreePath: wt.path, branch: wt.branch, deleteBranch: true, hardened: true }).catch(() => {});
      try {
        const setupNotes: string[] = [];
        // Recorded before anything else runs in the worktree.
        const [gitDir, commonDir] = (
          await git(["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"], wt.path)
        )
          .trim()
          .split("\n");
        if (!gitDir || !commonDir) throw new Error("could not resolve the worktree's git directories");
        // No shared links: a loop's worker must not be able to change what the
        // checks run outside the tree they judge (and the user's checkout).
        const setupSince = ticksNow();
        const setupMark = randomUUID();
        // Your copied files (an .env) land next to a commit off your history
        // only when a watch vouched for it (pushed, or every commit signed, by someone you trust).
        const setup = await prepareWorktree({
          worktreePath: wt.path,
          policy: d.worktreeSetupPolicy(),
          ownerSub: run.ownerSub,
          share: false,
          signal,
          extraEnv: { CODEOID_LOOP_CHECK: setupMark },
          ...(base && base.trusted !== true ? { copyNeedsReviewedBase: true } : {}),
        });
        // What setup left running in the worktree is stopped before the worker
        // starts: it would otherwise write there as if it were the worker.
        killMarked("CODEOID_LOOP_CHECK", setupMark, realpathSync(wt.path), setupSince);
        // A pull request's head is usually not on your checkout's history, so
        // a trusted setup command refuses to run there (it would run code
        // nobody reviewed); the run's history says why its checks may lack deps.
        if (setup.commandSkipped) setupNotes.push(`the repository's setup command did not run: ${setup.commandSkipped}`);
        if (setup.error) throw new Error(`the repository's setup recipe failed: ${setup.error}`);
        // What the recipe copied (often a .env from your checkout), captured
        // now: a candidate's checks get these bytes, not whatever the source
        // files hold by then.
        const captured = ownDir(inputsOf(run));
        for (const rel of setup.copied) {
          const to = join(captured, rel);
          mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
          copyFileSync(join(wt.path, rel), to);
        }
        // What setup changed among tracked files (a lockfile an install
        // rewrote, generated code) is put back: the run's base is what was
        // committed, and only the worker's changes are its work.
        const big = { maxBuffer: 1024 * 1024 * 1024, timeoutMs: 300_000 };
        const touched = (await git(["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=dirty", "HEAD", "--"], wt.path, {}, big))
          .split("\0")
          .filter(Boolean);
        if (touched.length > 0) {
          // Through stdin: any number of paths, each literal.
          await git(["checkout", "--no-overlay", "--pathspec-from-file=-", "--pathspec-file-nul", "HEAD"], wt.path, {}, {
            ...big,
            input: `${touched.map((p) => `:(top,literal)${p}`).join("\0")}\0`,
          });
          setupNotes.push(`the setup recipe changed ${touched.length} tracked file(s) (${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ", …" : ""}); they were put back`);
        }
        // Files setup made that git would add (not ignored) are setup's, not
        // the worker's work: kept out of the candidate like its copies.
        // A wholly untracked directory is one entry (`venv/`), not its files.
        const madeBySetup = (await git(["ls-files", "--others", "--exclude-standard", "--directory", "-z"], wt.path, {}, big))
          .split("\0")
          .filter(Boolean);
        if (madeBySetup.length > 0) {
          setupNotes.push(`the setup recipe made ${madeBySetup.length} file(s) git would add (${madeBySetup.slice(0, 5).join(", ")}${madeBySetup.length > 5 ? ", …" : ""}); they stay out of the candidate`);
        }
        if (wt.carry) await applyCarriedState(wt.path, wt.carry, { hardened: true });
        // The daemon runs git with every filter off, so a file stored through
        // one (Git LFS) would be judged and delivered as its working content.
        // Your global and info attributes count, as they do for git, and so
        // do attributes your uncommitted changes add (checked after the carry).
        // Tracked files, and files your uncommitted changes add (the index
        // stays at HEAD after the carry, so ls-files alone wouldn't list them).
        const carried = wt.carry
          ? await git(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", wt.carry.head, wt.carry.snapshot], wt.path, {}, big)
          : "";
        const files = (await git(["ls-files", "-z"], wt.path, {}, big)) + carried;
        if (files) {
          const attrs = (await git(["check-attr", "--stdin", "-z", "filter"], wt.path, {}, { ...big, input: files })).split("\0");
          const drivers = new Map<string, string>();
          for (let i = 0; i + 2 < attrs.length; i += 3) {
            const value = attrs[i + 2]!;
            if (value && value !== "unspecified" && value !== "unset" && value !== "set" && !drivers.has(value)) drivers.set(value, attrs[i]!);
          }
          // A filter changes content only when its driver is configured — in
          // any scope git reads, system included. Read without the hardened
          // overrides, which name every driver themselves; reading config runs
          // nothing.
          for (const [driver, path] of drivers) {
            const configured = await configValues(wt.path, `^filter\\.${driver.replace(/[^A-Za-z0-9_-]/g, ".")}\\.(clean|smudge|process)$`);
            if (configured.some((v) => v.trim() !== "")) {
              throw new Error(`${path} is stored through the git filter "${driver}"; loops don't support filtered files (Git LFS, git-crypt, …) yet`);
            }
          }
        }
        const broken = brokenShares(wt.path, setup.shared);
        const baseRevision = (await git(["rev-parse", "HEAD"], wt.path)).trim();
        return {
          // Real paths: what sessions' workdirs are compared against.
          worktreePath: realpathSync(wt.workdir),
          worktreeRoot: realpathSync(wt.path),
          gitDir,
          commonDir,
          branch: wt.branch,
          baseRevision,
          setupPaths: [...setup.copied, ...setup.shared.filter((p) => !broken.includes(p)), ...madeBySetup],
          notes: setupNotes,
        };
      } catch (err) {
        await discard();
        throw err;
      }
    },

    enqueueAttempt: (run, attempt, prompt) =>
      d.dispatcher.enqueue({
        accountId: run.accountId,
        projectId: run.projectId,
        kind: "attempt",
        shape: "ship",
        workdir: run.worktreePath ?? run.contract.workdir,
        prompt,
        runId: run.id,
        attemptId: attempt.id,
        ...(run.contract.worker.provider ? { provider: run.contract.worker.provider } : {}),
        ...(run.contract.worker.model ? { model: run.contract.worker.model } : {}),
        createdBy: run.ownerSub,
      }),
    cancelAttemptTask: (taskId, reason) => {
      d.dispatcher.cancel(taskId, reason);
    },
    holdAttemptTask: (taskId) => {
      const gen = d.taskGeneration(taskId);
      if (gen !== null) d.dispatcher.hold(taskId, gen, "the worker is waiting on an approval");
    },
    unholdAttemptTask: (taskId) => {
      const gen = d.taskGeneration(taskId);
      if (gen !== null) void d.dispatcher.unhold(taskId, gen);
    },

    createWorker: (run) => d.createWorkerSession(run),
    releaseWorker: (id) => d.releaseWorkerSession(id),
    workerAlive: (id) => d.session(id) !== undefined,
    // Only an idle worker: a prompt sent to one still mid-turn (after a lease
    // was lost) would join the old turn.
    workerReusable: (id) => {
      const s = d.session(id);
      return s?.hasLoopTools === true && s.toInfo().status === "idle";
    },
    sendToWorker: async (id, text, run) => {
      const s = d.session(id);
      if (!s) throw new Error("the run's worker session no longer exists");
      await s.send(text, d.senderFor(run));
    },
    armWorker: (id, toolBudget) => {
      d.session(id)?.setMode("autonomous", toolBudget);
    },
    workerInfo: (id): WorkerInfo | null => {
      const s = d.session(id);
      if (!s) return null;
      const info = s.toInfo();
      return { status: info.status as WorkerInfo["status"], costUsd: info.usage?.totalCostUsd ?? 0 };
    },
    quiesceWorker: async (id) => {
      // Before a candidate is taken, nothing the worker started may still be
      // running: a background process could change the tree while it's checked.
      const s = d.session(id);
      if (s) await s.terminateBackend({ sub: "system:loops", scopes: [], delegationDepth: 0, accountId: s.accountId, projectId: s.projectId }, "loop attempt ended — stopping the worker's processes before verification");
    },
    interruptWorker: async (id) => {
      const s = d.session(id);
      if (s) await s.interrupt({ sub: "system:loops", scopes: [], delegationDepth: 0, accountId: s.accountId, projectId: s.projectId });
    },

    // The candidate is the exact tree that would be committed: the run's base
    // with the worktree's files laid over it as `git add -A` sees them (setup's
    // files excluded), written through a private index, so neither the
    // worker's staging nor its commits can add or hide anything. The same tree
    // id is what delivery commits, so what was verified is what lands.
    snapshot: async (run) => {
      if (!run.baseRevision) return { ok: false, reason: "the run has no workspace" };
      const index = join(tmpdir(), `codeoid-loop-index-${run.id}-${randomUUID()}`);
      try {
        const { root, env: pin } = pinnedGit(run);
        const env = { ...pin, GIT_INDEX_FILE: index };
        await git(["read-tree", run.baseRevision], root, env);
        // Pathspecs on stdin: setup can leave any number of paths.
        await git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], root, env, {
          maxBuffer: 1024 * 1024 * 1024,
          timeoutMs: 600_000,
          input: `${[":/", ...run.setupPaths.map((p) => `:(exclude,top,literal)${p}`)].join("\0")}\0`,
        });
        // A file that looks like a secret — added, edited, or renamed into
        // place — never enters a candidate: it keeps its content at the base,
        // or stays out if it had none.
        const changed = (
          await git(["diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", run.baseRevision], root, env)
        )
          .split("\0")
          .filter((p) => p && SECRET_PATH.test(p));
        if (changed.length > 0) {
          await git(["reset", "-q", run.baseRevision, "--", ...changed.map((p) => `:(top,literal)${p}`)], root, env);
        }
        const tree = (await git(["write-tree"], root, env)).trim();
        return { ok: true, tree, withheld: changed };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        rmSync(index, { force: true });
      }
    },

    // Checks run in a fresh checkout of the candidate, never in the worker's
    // worktree: what they see is the tree that would be delivered and nothing
    // else — no ignored or untracked file, no withheld secret. The daemon
    // writes it itself from verified objects (materialize.ts), so neither the
    // repository's config nor its object store has a say. The setup recipe
    // runs on the run's base, committed content only, as when the worktree
    // was made; the candidate is laid over what it made. The checkout is a
    // repository of its own whose objects come from the user's, so a check
    // that asks git about it sees the candidate as committed.
    checkoutCandidate: async (run, tree, signal): Promise<CandidateCheckout> => {
      if (!run.baseRevision || !run.worktreeRoot || !run.worktreePath || !run.commonDir) return { ok: false, reason: "the run has no workspace" };
      let dir: string;
      try {
        dir = mkdtempSync(join(scratch().mine, `${run.id.slice(5, 13)}-`));
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const master = `${dir}.master`;
      const release = async (): Promise<void> => {
        await removeTreeAsync(dir);
        await removeTreeAsync(master);
      };
      const reader = new ObjectReader(readerEnv(run), scratch().mine);
      const folding = nameFolding(dir);
      const stop = (): void => reader.close();
      signal.addEventListener("abort", stop, { once: true });
      try {
        const base = await listTree(reader, await commitTree(reader, run.baseRevision), folding);
        const candidate = await listTree(reader, tree, folding);
        const stamps: Stamps = new Map();
        await writeTree(reader, dir, base, null, signal, stamps);
        const realDir = realpathSync(dir);
        const scratchReal = realpathSync(d.scratchRoot);
        const inside = (p: string | null): boolean => p !== null && (p === realDir || p.startsWith(`${realDir}/`));
        // Where the base's own links lead: one that already led out of the
        // repository (yours, committed) may keep doing so, unchanged.
        const baseLeads = new Map<string, string | null>();
        for (const [rel, e] of base) if (e.mode === "120000") baseLeads.set(rel, resolveUnder(realDir, rel));
        // A repository of its own, made by the daemon — and made again, whole,
        // before every check: no template, no global config, the repository's
        // object format, no reflog; its objects are the user's, its HEAD the
        // commit given, its index that commit's tree.
        const own = { GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir, GIT_CONFIG_GLOBAL: "/dev/null" };
        const commonDir = run.commonDir;
        const makeRepo = async (head: string): Promise<void> => {
          const at = join(dir, ".git");
          let st: ReturnType<typeof lstatSync> | undefined;
          try {
            st = lstatSync(at);
          } catch {
            st = undefined;
          }
          // Removed whole: a link in its place is removed, never followed.
          if (st) rmSync(at, { recursive: true, force: true });
          // From the daemon's own directory, discovering nothing above it.
          await git(["init", "-q", "--template=", `--object-format=${head.length === 64 ? "sha256" : "sha1"}`, dir], scratch().mine, {
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CEILING_DIRECTORIES: dirname(scratch().mine),
          });
          const objects = join(at, "objects");
          if (readdirSync(objects).sort().join(",") !== "info,pack") throw new Error("the check directory's repository isn't as git init makes it");
          writeExclusive(join(objects, "info", "alternates"), Buffer.from(`${join(commonDir, "objects")}\n`));
          await git(["config", "core.logAllRefUpdates", "false"], dir, own);
          // Copies keep mtimes and sizes but not inodes or ctimes: compare what survives a copy.
          await git(["config", "core.checkStat", "minimal"], dir, own);
          await git(["config", "core.trustctime", "false"], dir, own);
          await git(["update-ref", "--no-deref", "HEAD", head], dir, own);
          await git(["read-tree", head], dir, own);
        };
        await makeRepo(run.baseRevision);
        // The recipe is the one at the run's base, read from verified bytes; its
        // command runs only if that is the recipe you trusted (commandGate).
        // Its copies are the files captured when the run began.
        const found = await loadSetupRecipe(run.contract.workdir);
        let recipe = found;
        const atBase = base.get(SETUP_RECIPE_PATH);
        if (found && !("error" in found)) {
          if (atBase && atBase.oid === found.recipeHash) {
            const text = (await reader.read(atBase.oid)).data.toString("utf8");
            recipe = { ...found, recipe: { ...parseSetupRecipe(text), copy: [] } };
          } else {
            recipe = { ...found, recipe: { ...found.recipe, command: undefined, copy: [] } };
          }
        }
        const captured = inputsOf(run);
        for (const rel of run.setupPaths) {
          const from = join(captured, rel);
          try {
            if (!lstatSync(from).isFile()) continue;
          } catch {
            continue;
          }
          assertNoLinkedParent(dir, rel);
          const to = join(dir, rel);
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
        }
        const setupSince = ticksNow();
        const setupMark = randomUUID();
        const setup = await prepareWorktree({
          extraEnv: { CODEOID_LOOP_CHECK: setupMark },
          worktreePath: dir,
          recipe,
          policy: d.worktreeSetupPolicy(),
          ownerSub: run.ownerSub,
          share: false,
          baseCommit: run.baseRevision,
          signal,
        });
        // Whatever setup left running in the check directory (a dev server, a
        // watcher) is stopped — the daemon's own readers work from elsewhere: it would otherwise outlive the seal and write
        // into the checks' copies at this same path.
        killMarked("CODEOID_LOOP_CHECK", setupMark, realpathSync(dir), setupSince);
        if (setup.error) throw new Error(`the setup recipe failed: ${setup.error}`);
        await writeTree(reader, dir, candidate, base, signal, stamps);
        // What setup changed among the candidate's files goes back to the
        // candidate (every file compared: setup ran within the daemon's own
        // writes' clock tick, so no stamp is trusted).
        const fresh = (): ObjectReader => new ObjectReader(readerEnv(run), scratch().mine);
        await restoreTree(fresh, dir, candidate, new Map(), signal);
        // No link may lead a check out of the candidate, alone or chained with
        // others — followed as the kernel follows them, on the files as written.
        // Asked again after every restore: what lies outside the candidate's
        // files may have changed.
        const checkLinks = (): void => {
          for (const [rel, e] of candidate) {
            if (e.mode !== "120000") continue;
            const leads = resolveUnder(realDir, rel);
            if (inside(leads)) continue;
            // Never into the daemon's own directories (another run's checkout or
            // captured files), however the link got there.
            if (leads !== null && (leads === scratchReal || leads.startsWith(`${scratchReal}/`))) {
              throw new Error(`the symlink ${rel} leads outside the repository (into the daemon's own directory, where a committed link climbing above the repository ends up when checked)`);
            }
            const was = base.get(rel);
            const unchanged = was !== undefined && was.mode === e.mode && was.oid === e.oid;
            // A committed link that already led out, or round in a loop, unchanged and leading the same way.
            if (unchanged && baseLeads.has(rel) && baseLeads.get(rel) === leads) continue;
            throw new Error(`the candidate's symlink ${rel} leads outside the repository`);
          }
        };
        checkLinks();
        // In the user's object store (the check directory's own is reset before
        // each check): a commit nothing refers to, collected in time.
        const commit = (
          await git(["commit-tree", "--no-gpg-sign", tree, "-p", run.baseRevision, "-m", `codeoid loop ${run.id}: candidate under check`], dir, {
            GIT_DIR: run.commonDir,
            GIT_CONFIG_GLOBAL: "/dev/null",
            ...SCRATCH_IDENTITY,
          })
        ).trim();
        await makeRepo(commit);
        // Stat info, so plumbing (`git diff-index --quiet HEAD`) sees it clean.
        await git(["update-index", "-q", "--refresh"], dir, own, { timeoutMs: 600_000 }).catch(() => {});
        // Where the checks run must be a directory of the checkout, not a link out of it.
        const rel = relative(run.worktreeRoot, run.worktreePath);
        const cwdIn = (root: string): string => {
          const top = realpathSync(root);
          const at = realpathSync(join(root, rel));
          if (at !== top && !at.startsWith(`${top}/`)) throw new Error("the run's directory in the candidate leads outside it");
          return at;
        };
        cwdIn(dir);
        // The prepared directory becomes the master no check ever runs in, its
        // exact state sealed. Each check gets a fresh copy of it at the
        // prepared directory's own path — so absolute paths setup wrote (a
        // venv's scripts, an editable install) lead into the check's own copy
        // — after the seal is confirmed: anything that touched the master
        // (a check writing outside its directory) fails the run.
        // A private copy (its own inodes): what setup linked from a shared
        // cache (uv, pnpm, bun hard-link installs) can't be touched through
        // that cache by anything else on the machine.
        // Its size first: a tree past the caps isn't copied at all.
        const sized = await fingerprint(dir, signal);
        if (sized.bytes > 8 * 1024 ** 3) throw new Error("the prepared check directory is larger than 8 GiB");
        if (sized.entries > 1_000_000) throw new Error("the prepared check directory holds more than 1,000,000 entries");
        await copyDir(dir, master, signal);
        await removeTreeAsync(dir);
        const sealed = await fingerprint(master, signal);
        if (sealed.bytes > 8 * 1024 ** 3 || sealed.entries > 1_000_000) throw new Error("the prepared check directory grew past its limits while it was copied");
        // On a filesystem with coarse times, a change within the same tick as
        // the newest one sealed would leave the seal as it was: the first
        // check starts once the clock has moved past it.
        await clockPast(scratch().mine, sealed.newestCtimeNs);
        const forCheck = async (sig?: AbortSignal): Promise<{ dir: string; skipped: string[] }> => {
          if ((await fingerprint(master, sig, sealed.entries)).digest !== sealed.digest) {
            throw new Error("something changed the prepared check directory between checks");
          }
          await removeTreeAsync(dir);
          const skipped = await copyDir(master, dir, sig);
          const ownCopy = { GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir, GIT_CONFIG_GLOBAL: "/dev/null" };
          await git(["update-index", "-q", "--refresh"], dir, ownCopy, { timeoutMs: 600_000 }).catch(() => {});
          return { dir: cwdIn(dir), skipped };
        };
        return { ok: true, release, forCheck };
      } catch (err) {
        await release();
        return { ok: false, reason: signal.aborted ? "stopped" : err instanceof Error ? err.message : String(err) };
      } finally {
        signal.removeEventListener("abort", stop);
        reader.close();
      }
    },
    // A check's processes carry a marker; when it ends, any still running —
    // a background server, one that escaped its process group — are killed
    // before the next check's copy is made at the same path.
    runCheck: async (run, spec, tree, dir, signal) => {
      const marker = randomUUID();
      const since = ticksNow();
      const mine = realpathSync(scratch().mine);
      const top = relative(mine, realpathSync(dir)).split("/")[0];
      const root = top && !top.startsWith("..") ? join(mine, top) : dir;
      try {
        return await d.evidence.run({ ...spec, env: { ...(spec.env ?? {}), CODEOID_LOOP_CHECK: marker } }, dir, {
          tenant: { accountId: run.accountId, projectId: run.projectId },
          ownerKind: "loop",
          ownerId: run.id,
          candidateDigest: tree,
          signal,
        });
      } finally {
        killMarked("CODEOID_LOOP_CHECK", marker, root, since);
      }
    },

    // Delivery is one commit on the run's base holding the verified tree —
    // never whatever the worktree or its index holds by then, and none of the
    // worker's own commits: what the branch adds to its base is what passed.
    commitCandidate: async (run, message, tree) => {
      if (!run.branch || !run.baseRevision) throw new Error("the run has no workspace");
      const { root, env } = pinnedGit(run);
      const ref = `refs/heads/${run.branch}`;
      const tip = (await git(["rev-parse", "--verify", `${ref}^{commit}`], root, env)).trim();
      // The objects delivered are the ones that were checked: each still
      // hashes to its id.
      const reader = new ObjectReader(readerEnv(run), root);
      try {
        await listTree(reader, tree).then(async (files) => {
          for (const f of files.values()) if (f.mode !== "160000") await reader.read(f.oid);
        });
      } finally {
        reader.close();
      }
      // The user's own git identity, as for any branch they'll merge.
      const commit = (await git(["commit-tree", "--no-gpg-sign", tree, "-p", run.baseRevision, "-m", message], root, env)).trim();
      await git(["update-ref", "-m", `codeoid loop ${run.id}`, ref, commit, tip], root, env);
      // The worktree's files already are the tree (or its worker's later
      // edits); bring its index along.
      await git(["read-tree", commit], root, env);
      return commit;
    },

    keepInputs: (runIds) => {
      // Captured setup files outlive only the runs still in progress.
      try {
        for (const name of readdirSync(scratch().inputs)) {
          if (!runIds.has(name) && lstatSync(join(scratch().inputs, name)).isDirectory()) rmSync(join(scratch().inputs, name), { recursive: true, force: true });
        }
      } catch {
        // best effort
      }
    },

    forgetRun: (run) => {
      try {
        rmSync(inputsOf(run), { recursive: true, force: true });
      } catch {
        // best effort
      }
    },

    discardWorkspace: async (run) => {
      if (!run.worktreeRoot) return;
      await removeForkWorktree({
        workdir: run.contract.workdir,
        worktreePath: run.worktreeRoot,
        ...(run.branch ? { branch: run.branch } : {}),
        deleteBranch: true,
        hardened: true,
      });
    },

    notifyOwner: (run, kind) => d.notifyOwner(run, kind),
    audit: (run, action, detail) => d.audit(run.ownerSub, action, run.workerSessionId ?? undefined, `${run.id}: ${detail}`),
  };
}
