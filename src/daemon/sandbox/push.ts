/**
 * `push`: how an agent in a sandboxed session gets a branch to its remote
 * (docs/sandbox.md, "Pushing a branch"). A sandboxed command can't push: it
 * has no direct network (Claude's sandbox lets only HTTP(S) out through its
 * proxy, and resolves no DNS; codeoid's own sandboxes may have none at all)
 * and no credentials (the SSH agent, keys, credential helpers and keychains
 * are hidden). The tool only asks; the session decides (Session#push), and
 * the daemon runs `git push` on the host, with your own network and
 * credentials, which the agent never sees.
 *
 * What may be pushed, whoever asks:
 *   - the session's own repository (its workspace, or the codeoid worktree
 *     it works in), whose git config the sandbox holds read-only;
 *   - one local branch, by name, to the branch of the same name on one of the
 *     repository's remotes, as the commit it is now (resolved once, pushed by
 *     id); never a force, a delete, tags, other refs or push options;
 *   - never to the remote's default branch, nor to a protected one
 *     (`sandbox.push.protectedBranches`, main and master by default).
 * Where the push goes, and how git connects, comes only from config the
 * agent couldn't have written: your global and system config, and the
 * repository's own `.git/config` (read-only to sandboxed commands; a
 * host-side file tool's write to it is held). Anything there from another
 * file (an include) or any other repository-local place is refused. git runs
 * hardened (git-env.ts): no hooks (so no pre-push, nor git-lfs's), no
 * drivers or credential helpers the agent named, https and ssh only.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { GIT_BIN, safeGit, safeGitEnv } from "../git-env.js";
import { validateBranchName } from "../git-worktree.js";
import { redactMcpUrl } from "../mcp/redact.js";
import { physicalPath, within } from "../physical-path.js";
import { gitLayoutOf } from "./policy.js";

export const PUSH_TOOL = "push";

export const PUSH_DESCRIPTION = [
  "Push a branch of this session's repository to its remote. Your sandboxed commands can't (no network to the git host, no credentials); codeoid runs the push for you with the owner's, which you never see.",
  "Pushes one branch, as it is committed now, to the same branch on the remote: `branch` (default: the one checked out) and `remote` (default: origin). No force, no delete, no tags; never the remote's default branch or a protected one (main, master).",
  "Guarded and interactive mode: the owner is asked. Autonomous mode: it runs. Commit first; uncommitted changes aren't pushed. Open the pull request afterwards (gh, or your Bitbucket/GitLab tools).",
].join(" ");

export const PUSH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    branch: { type: "string", description: "The local branch to push (default: the one checked out)." },
    remote: { type: "string", description: "The remote's name (default: origin)." },
    reason: { type: "string", description: "Why: the owner reads it when asked." },
  },
  additionalProperties: false,
};

export interface PushInput {
  branch?: string;
  remote?: string;
  reason?: string;
}

/** Decides a push for `sessionId`; resolves with the text the agent reads. Never rejects. */
export type PushHandler = (sessionId: string, input: PushInput) => Promise<string>;

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A branch name git takes, that also reads as nothing but a name in a refspec (no leading `+`, which means force). */
function isPushableBranchName(name: string): boolean {
  if (name.startsWith("+")) return false;
  try {
    validateBranchName(name);
    return true;
  } catch {
    return false;
  }
}

/** The tool's input, checked; a string is the refusal the agent reads. */
export function cleanPushInput(raw: Record<string, unknown>): PushInput | string {
  const out: PushInput = {};
  for (const k of ["branch", "remote", "reason"] as const) {
    const v = raw[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return `Refused: \`${k}\` must be a string.`;
    out[k] = k === "reason" ? v.trim().slice(0, 1000) : v.trim();
  }
  if (out.branch !== undefined && !isPushableBranchName(out.branch)) return `Refused: ${JSON.stringify(out.branch)} isn't a branch name.`;
  if (out.remote !== undefined && !REMOTE_NAME.test(out.remote)) return `Refused: ${JSON.stringify(out.remote)} isn't a remote's name.`;
  return out;
}

/** What will be pushed, every part checked. */
export interface PushPlan {
  repo: string;
  /** The repository's git dir (its objects: alternates are checked again right before the push). */
  common: string;
  /** Your own `core.sshCommand` (global or system), used as is; else ssh in batch mode. */
  sshCommand: string | null;
  /** The remote's default branch couldn't be read (an error, a timeout, no HEAD symref): it isn't known this isn't it. */
  defaultUnknown: boolean;
  branch: string;
  /** The commit pushed, resolved once. */
  sha: string;
  remote: string;
  /** Where to, as git will be given it. */
  url: string;
  /** The same, safe to show (no credentials, query or fragment). */
  shownUrl: string;
}

export interface PlanOptions {
  protectedBranches: readonly string[];
  home?: string;
  /**
   * The repository's config files the session's sandbox holds read-only (its spec's read-only paths, which
   * hold the repository's git dir when the spec was built). A push is refused unless the repository's own
   * config is among them: a repository the agent made (or a config it could write) decides nothing.
   */
  heldReadOnly?: readonly string[];
  /** What the session's sandboxed commands may write: a file there (an include of your config's) decides nothing. */
  agentWritable?: readonly string[];
  /**
   * When the session began (ms since the epoch): the repository's config files must be older (their ctime, which
   * nothing can set back), so a repository made during the session, or config rewritten in it, decides nothing.
   */
  notChangedSince?: number;
  /** How long the remote's default-branch lookup may take (ms). */
  lookupTimeoutMs?: number;
  /** Ask the remote for its default branch (refused as a target). Off only in tests without a network. */
  remoteDefault?: (url: string, cwd: string, timeoutMs: number) => Promise<string | null>;
  /** Tests only: a local bare repository as the remote (a `file://` URL), which a real push never takes. */
  _testFileRemote?: boolean;
}

/** One config entry with where it came from (`git config --show-scope --show-origin --null`). */
interface OriginEntry {
  scope: string;
  origin: string;
  key: string;
  value: string;
}

function parseOrigin(out: string): OriginEntry[] {
  const parts = out.split("\0");
  const entries: OriginEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const kv = parts[i + 2] as string;
    const nl = kv.indexOf("\n");
    entries.push({ scope: parts[i] as string, origin: parts[i + 1] as string, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? "" : kv.slice(nl + 1) });
  }
  return entries;
}

/**
 * The config that decides where a push goes and how git connects or
 * authenticates: the remote's URLs and push settings, URL rewrites, every
 * `http.*` (proxy, TLS, extra headers, cookies), credentials, ssh, push
 * defaults, and includes.
 */
const DECIDING = /^(?:remote\.[\s\S]+\.(?:url|pushurl|receivepack|push|proxy|vcs|mirror)|url\.[\s\S]+\.(?:insteadof|pushinsteadof)|https?\.[\s\S]*|credential\.[\s\S]*|core\.sshcommand|ssh\.variant|push\.[\s\S]*|include\.path|includeif\.[\s\S]+\.path|protocol\.[\s\S]*)$/i;

/** The same, broadly, as git's own (POSIX) pattern for `--get-regexp`; {@link DECIDING} picks the keys exactly. */
const DECIDING_GIT = "^(remote\\.|url\\.|https?\\.|credential\\.|core\\.sshcommand$|ssh\\.variant$|push\\.|include\\.path$|includeif\\.|protocol\\.)";

/**
 * Scopes the agent can't write: your global and system config, and `command`
 * — the overrides codeoid itself sets on the git it runs (git-env.ts), the
 * only source of that scope here (the agent's environment never reaches it).
 */
const USER_SCOPES = new Set(["global", "system", "command"]);

/**
 * Repository-scope settings refused even from the repository's own config: what turns a push into a credential
 * leak or a command on the remote host (a proxy, TLS off, extra headers, the remote's receive-pack program, a
 * remote helper, ssh's command or variant, protocol allowances). Rare per repository; set them globally.
 */
const REPO_REFUSED = /^(?:https?\.(?!(?:[\s\S]+\.)?(?:postbuffer|version|lowspeedlimit|lowspeedtime|maxrequests)$)[\s\S]*|remote\.[\s\S]+\.(?:receivepack|vcs|proxy)|core\.sshcommand|ssh\.variant|protocol\.[\s\S]*|credential\.[\s\S]*)$/i;

/**
 * Where an entry may come from to decide a push: your global and system config's own files (an include they
 * name, only from outside what the session's commands may write), codeoid's overrides, and the repository's
 * own config files while the sandbox holds them read-only — never, there, a key in {@link REPO_REFUSED}.
 */
function originProblem(e: OriginEntry, own: readonly string[], repo: string, agentWritable: readonly string[]): string | null {
  if (e.scope === "command") return null;
  if (!e.origin.startsWith("file:")) return `\`${e.key}\` comes from ${e.origin || "an unknown place"}`;
  const raw = e.origin.slice("file:".length);
  const file = physicalPath(isAbsolute(raw) ? raw : resolve(repo, raw));
  if (USER_SCOPES.has(e.scope)) {
    // Your config's own files, and what they include from outside what the session's commands may write.
    return agentWritable.some((w) => within(w, file)) ? `\`${e.key}\` comes from ${raw}, a file this session's agent can write` : null;
  }
  if (!own.includes(file)) {
    return `\`${e.key}\` comes from ${raw}, a file this session's agent could write (only your own config, and the repository's .git/config, decide a push)`;
  }
  if (REPO_REFUSED.test(e.key)) return `the repository's own config sets \`${e.key}\`, which codeoid never uses for a push it makes (set it in your global config instead)`;
  return null;
}

/** `ssh://…`, `git@host:path` (scp-like) or `https://…`: the protocols the push may use. */
export function pushUrlProblem(url: string): string | null {
  if (/[\x00-\x20\x7f]/.test(url)) return "it holds spaces or control characters";
  if (url.startsWith("-")) return "it starts with -";
  if (/^https:\/\//i.test(url) || /^ssh:\/\//i.test(url)) return null;
  // scp-like: [user@]host:path, no scheme, the host before the first colon has no slash.
  if (/^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/.test(url)) return null;
  return "only ssh and https remotes are pushed to";
}

/** A remote's URL, safe to show. scp-like ones have no credentials to hide but a user name, which stays. */
export function shownUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? redactMcpUrl(url) : url;
}

async function config(repo: string, pattern: string): Promise<OriginEntry[]> {
  try {
    return parseOrigin(await safeGit(["config", "--show-scope", "--show-origin", "--null", "--get-regexp", pattern], repo, { timeoutMs: 20_000 }));
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return [];
    throw err;
  }
}

/** The plan for a push from `repo`, or why it is refused. */
export async function planPush(repoDir: string, input: PushInput, opts: PlanOptions): Promise<PushPlan | { refused: string }> {
  const refuse = (refused: string) => ({ refused });
  const layout = gitLayoutOf(repoDir, opts.home);
  if (!layout) return refuse("this session's workspace isn't a git repository");
  if (layout.kind === "unknown" || !layout.common) return refuse("this repository's .git isn't one codeoid can check (a separate git dir it doesn't name back)");
  let repo: string;
  try {
    repo = (await safeGit(["rev-parse", "--show-toplevel"], repoDir, { timeoutMs: 20_000 })).trim();
  } catch {
    return refuse("this session's workspace isn't a git repository");
  }
  const common = physicalPath(layout.common);
  // Another repository's objects reachable through alternates would go out with the push.
  for (const f of ["alternates", "http-alternates"]) {
    if (existsSync(join(common, "objects", "info", f))) return refuse(`the repository borrows objects from elsewhere (objects/info/${f})`);
  }
  const own = [physicalPath(join(common, "config")), ...(layout.own ? [physicalPath(join(layout.own, "config.worktree"))] : [physicalPath(join(common, "config.worktree"))])];
  // The trust anchor: the repository's config is the user's only while the sandbox holds it read-only, which it
  // does for the repository the workspace was when its spec was built. One made since (`git init`) isn't held.
  const held = (opts.heldReadOnly ?? []).map((p) => physicalPath(p));
  if (!held.some((h) => within(h, own[0] as string))) {
    return refuse("this repository's git settings aren't held read-only by this session's sandbox (a repository made during the session, or one outside its workspace): push it yourself");
  }
  if (opts.notChangedSince !== undefined) {
    for (const f of own) {
      let st: { ctimeMs: number; size: number };
      try {
        st = statSync(f);
      } catch {
        continue; // a config.worktree that isn't there
      }
      // An empty one decides nothing (codeoid makes config.worktree empty when it holds the git dir).
      if (st.size > 0 && st.ctimeMs >= opts.notChangedSince) {
        return refuse(`this repository's git settings (${f}) were made or changed after this session began: codeoid only pushes from a repository whose settings predate the session — push it yourself`);
      }
    }
  }

  // The branch: named, or the one checked out.
  let branch = input.branch;
  if (!branch) {
    try {
      branch = (await safeGit(["symbolic-ref", "--short", "-q", "HEAD"], repo, { timeoutMs: 20_000 })).trim();
    } catch {
      return refuse("no branch is checked out (a detached HEAD): name the branch to push");
    }
  }
  if (!isPushableBranchName(branch)) return refuse(`${JSON.stringify(branch)} isn't a branch name`);
  if (opts.protectedBranches.some((p) => branchMatches(p, branch as string))) {
    return refuse(`${branch} is a protected branch (sandbox.push.protectedBranches): push your work to a branch of its own, and open a pull request`);
  }
  let sha: string;
  try {
    sha = (await safeGit(["rev-parse", "--verify", "-q", "--end-of-options", `refs/heads/${branch}^{commit}`], repo, { timeoutMs: 20_000 })).trim();
  } catch {
    return refuse(`there is no local branch ${branch}: commit to it first`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return refuse(`${branch} doesn't name a commit`);

  // Where to, and every setting that decides how: only from your config or the repository's own.
  const remote = input.remote ?? "origin";
  const entries = (await config(repo, DECIDING_GIT)).filter((e) => DECIDING.test(e.key));
  const writable = (opts.agentWritable ?? []).map((p) => physicalPath(p));
  for (const e of entries) {
    const problem = originProblem(e, own, repo, writable);
    if (problem) return refuse(problem);
  }
  // Your own ssh command (a key per host, an agent's wrapper) — only from your config: the repository's is refused.
  const ssh = entries.filter((e) => e.key === "core.sshcommand" && (e.scope === "global" || e.scope === "system")).at(-1)?.value ?? null;
  // The subsection (the remote's name) is case-sensitive; git prints the section and the variable lowercased.
  const ofRemote = (name: string) => entries.filter((e) => e.key === `remote.${remote}.${name}`);
  const pushUrls = ofRemote("pushurl");
  const urls = ofRemote("url");
  const chosen = pushUrls.length > 0 ? pushUrls : urls;
  if (chosen.length === 0) return refuse(`there is no remote named ${remote}`);
  if (chosen.length > 1) return refuse(`remote ${remote} has ${chosen.length} push URLs: push it yourself`);
  const url = (chosen[0] as OriginEntry).value;
  const bad = opts._testFileRemote && url.startsWith("file://") ? null : pushUrlProblem(url);
  if (bad) return refuse(`remote ${remote}'s URL can't be pushed to: ${bad}`);

  let defaultUnknown = false;
  if (opts.remoteDefault) {
    const head = await opts.remoteDefault(url, repo, opts.lookupTimeoutMs ?? 30_000).catch(() => null);
    if (head === null) defaultUnknown = true;
    else if (head.toLowerCase() === branch.toLowerCase()) {
      return refuse(`${branch} is the remote's default branch: push your work to a branch of its own, and open a pull request`);
    }
  }
  return { repo, common, sshCommand: ssh, defaultUnknown, branch, sha, remote, url, shownUrl: shownUrl(url) };
}

/** `main`, or a pattern with one trailing `*` (`release/*`); case-insensitive, as hosts on case-folding ref storage are. */
export function branchMatches(pattern: string, branch: string): boolean {
  const p = pattern.toLowerCase();
  const b = branch.toLowerCase();
  return p.endsWith("*") ? b.startsWith(p.slice(0, -1)) : p === b;
}

/** What every push adds to the hardened environment's overrides: nothing but the one ref, unsigned, no submodules. */
const PUSH_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["push.gpgSign", "false"],
  ["push.followTags", "false"],
  ["push.recurseSubmodules", "no"],
  ["push.pushOption", ""],
  ["push.default", "nothing"],
  ["push.autoSetupRemote", "false"],
];

/** The remote's default branch (`ls-remote --symref <url> HEAD`), or null. */
export async function remoteDefaultBranch(url: string, cwd: string, timeoutMs = 30_000): Promise<string | null> {
  const r = await runGit(["ls-remote", "--symref", "--end-of-options", url, "HEAD"], cwd, timeoutMs, { sshCommand: null });
  if (r.code !== 0) return null;
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout);
  return m ? (m[1] as string) : null;
}

export interface PushResult {
  ok: boolean;
  /** What happened, one line. */
  summary: string;
  /** git's output, redacted and capped. */
  output: string;
}

/** Run the push the plan names, on the host. */
export async function runPush(plan: PushPlan, timeoutMs = 120_000, _testFileRemote = false, signal?: AbortSignal): Promise<PushResult> {
  // Checked again right before git starts: objects/info is writable to the agent.
  for (const f of ["alternates", "http-alternates"]) {
    if (existsSync(join(plan.common, "objects", "info", f))) return { ok: false, summary: `refused: the repository borrows objects from elsewhere (objects/info/${f})`, output: "" };
  }
  if (signal?.aborted) return { ok: false, summary: "not pushed: the session is closing", output: "" };
  const r = await runGit(
    ["push", "--porcelain", "--no-verify", "--no-signed", "--no-follow-tags", "--no-recurse-submodules", "--end-of-options", plan.url, `${plan.sha}:refs/heads/${plan.branch}`],
    plan.repo,
    timeoutMs,
    { testFile: _testFileRemote, sshCommand: plan.sshCommand, signal },
  );
  const output = shownOutput(`${r.stdout}\n${r.stderr}`);
  if (r.aborted) return { ok: false, summary: "stopped: the session closed while it was pushing (the remote may or may not have it)", output };
  if (r.timedOut) return { ok: false, summary: `the push timed out after ${Math.round(timeoutMs / 1000)}s (the remote may or may not have it)`, output };
  // Porcelain: a tab-separated line per ref, flag first: ` ` fast-forward, `*` new, `=` up to date, `!` rejected.
  const line = r.stdout.split("\n").find((l) => l.includes(`:refs/heads/${plan.branch}\t`) || l.endsWith(`:refs/heads/${plan.branch}`));
  const flag = line?.[0];
  if (r.code === 0 && flag === "=") return { ok: true, summary: `${plan.branch} is already up to date on ${plan.remote}`, output };
  if (r.code === 0) return { ok: true, summary: `pushed ${plan.branch} (${plan.sha.slice(0, 12)}) to ${plan.remote}${flag === "*" ? ", a new branch there" : ""}`, output };
  if (flag === "!") {
    // `!<TAB>from:to<TAB>[rejected] (non-fast-forward)`.
    const why = line?.split("\t").slice(2).join(" ").trim() || "rejected";
    return {
      ok: false,
      summary: /non-fast-forward|fetch first|stale info/.test(why)
        ? `the remote's ${plan.branch} has commits yours doesn't (${why}): fetch and rebase or merge, then push again — a force push isn't done for agents`
        : `the remote refused it (${why})`,
      output,
    };
  }
  return { ok: false, summary: `git push failed (exit ${r.code ?? "killed"})`, output };
}

/** Remote output can name URLs with tokens in them, and control sequences: shown redacted, plain, capped. */
function shownOutput(text: string): string {
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const redacted = plain.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, (u) => redactMcpUrl(u));
  const trimmed = redacted.trim();
  return trimmed.length > 3000 ? `${trimmed.slice(0, 3000)}\n…` : trimmed;
}

/** git with the hardened, networked environment; the whole process group is killed on timeout (ssh too). */
async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  o: { testFile?: boolean; sshCommand: string | null; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  const env = await safeGitEnv(cwd, { network: true, overrides: PUSH_OVERRIDES });
  if (o.testFile) env.GIT_ALLOW_PROTOCOL = "file";
  // How ssh runs: your environment's GIT_SSH_COMMAND / GIT_SSH first (as git itself ranks them), then your own
  // core.sshCommand (planPush took it from your global or system config only), else ssh that never waits for a
  // person (a host-key or passphrase prompt) and gives up on a dead host. The time limit bounds any of them.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = o.sshCommand ?? "ssh -o BatchMode=yes -o ConnectTimeout=20";
  return new Promise((done) => {
    const child = spawn(GIT_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    const cap = (s: string, d: Buffer) => (s.length > 256 * 1024 ? s : s + d.toString("utf8"));
    child.stdout?.on("data", (d: Buffer) => {
      stdout = cap(stdout, d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = cap(stderr, d);
    });
    let timedOut = false;
    let aborted = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: { code: number | null; stdout: string; stderr: string }) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      done({ ...r, timedOut, aborted });
    };
    child.on("error", (err) => finish({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}
