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

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  // Shown to the owner as is: nothing invisible, nothing that reorders the line (a zero-width space makes "ma\u200bin").
  if (/[\p{Cf}\p{Zl}\p{Zp}\p{Cc}\p{Co}\p{Cn}]/u.test(name)) return false;
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
  /**
   * What the repository's own config says that decides a push (scope, key, value; sorted). With `common`,
   * `remote`, `url` and {@link userSettings}, what an owner's trust is given to and checked against.
   */
  repoSettings: string[];
  /** The same from your global and system config (no include lines). */
  userSettings: string[];
  /** Your config's connection and credential entries where the push was planned, in order ({@link CARRIED}). */
  userEntries: Array<[string, string]>;
  /** A linked worktree's own git dir, else null (its refs are checked for links too). */
  own: string | null;
  /** The remote's URL as configured, when a rewrite of yours makes {@link url} differ; else null. */
  configuredUrl: string | null;
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
  /** Stops the remote lookup (a drain, a destroy). */
  signal?: AbortSignal;
  /** How long the remote's default-branch lookup may take (ms). */
  lookupTimeoutMs?: number;
  /** Ask the remote for its default branch (refused as a target). Off only in tests without a network. */
  remoteDefault?: (url: string, cwd: string, timeoutMs: number, ssh: string | null, signal?: AbortSignal) => Promise<string | null>;
  /**
   * Runs a read-only git query (`symbolic-ref`, `rev-parse`) in the repository: the session's runs it inside its
   * sandbox, so a ref or object the agent linked into a path the sandbox hides resolves to nothing. Absent (tests):
   * the host's git.
   */
  refGit?: RefGit;
  /** Tests only: a local bare repository as the remote (a `file://` URL), which a real push never takes. */
  _testFileRemote?: boolean;
}

/**
 * A read-only git query in a repository: its stdout, or null when git said no (exit 1: no such ref, a detached
 * HEAD). Throws when it couldn't be run at all (the sandbox, a missing git, a timeout): that is said as itself.
 */
export type RefGit = (repo: string, args: string[]) => Promise<string | null>;

const hostRefGit: RefGit = (repo, args) => safeGit(args, repo, { timeoutMs: 20_000 }).catch(() => null);

/** {@link RefGit}, a failure to run said as one. */
async function askRef(refGit: RefGit, repo: string, args: string[]): Promise<{ out: string | null } | { refused: string }> {
  try {
    return { out: await refGit(repo, args) };
  } catch (err) {
    return { refused: `the session's sandbox couldn't run git to read the branch (${err instanceof Error ? err.message : String(err)})` };
  }
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
const REPO_REFUSED = /^(?:https?\.(?!(?:[\s\S]+\.)?(?:postbuffer|version|lowspeedlimit|lowspeedtime|maxrequests)$)[\s\S]*|remote\.[\s\S]+\.(?:receivepack|vcs|proxy)|url\.[\s\S]+\.(?:insteadof|pushinsteadof)|core\.sshcommand|ssh\.variant|protocol\.[\s\S]*|credential\.[\s\S]*)$/i;

/**
 * Where an entry may come from to decide a push: your global and system config's own files (an include they
 * name, only from outside what the session's commands may write), codeoid's overrides, and the repository's
 * own config files while the sandbox holds them read-only — never, there, a key in {@link REPO_REFUSED}.
 */
/** How the owner clears a refusal for a place a session could once write, once they've checked it. */
function forgetHint(root: string): string {
  return ` (once you've checked it, and no session works there now: \`codeoid sandbox forget-writable ${root}\`)`;
}

/** Keys whose value git runs as a program on the host. */
const RUNS_PROGRAM = /^(?:core\.sshcommand|credential\.(?:[\s\S]+\.)?helper)$/i;

function originProblem(e: OriginEntry, own: readonly string[], repo: string, agentWritable: readonly string[], home?: string): string | null {
  if (e.scope === "command") return null;
  if (!e.origin.startsWith("file:")) return `\`${e.key}\` comes from ${e.origin || "an unknown place"}`;
  const raw = e.origin.slice("file:".length);
  const file = physicalPath(isAbsolute(raw) ? raw : resolve(repo, raw));
  if (USER_SCOPES.has(e.scope)) {
    // Your config's own files, and what they include from outside what the session's commands may write.
    const root = agentWritable.find((w) => within(w, file));
    if (root) return `\`${e.key}\` comes from ${raw}, a file a sandboxed session's agent can (or could) write${forgetHint(root)}`;
    // What git runs as a program comes only from your own ~/.gitconfig (or XDG's) or the system's, never an include.
    if (e.scope === "global" && RUNS_PROGRAM.test(e.key)) {
      const h = home ?? homedir();
      const own = [join(h, ".gitconfig"), join(process.env.XDG_CONFIG_HOME || join(h, ".config"), "git", "config")].map((f) => physicalPath(f));
      if (!own.includes(file)) {
        const bad = hostPathProblem(file, agentWritable, h, { homeAllowed: true });
        if (bad) return `\`${e.key}\` comes from ${raw}, a file your config includes that codeoid can't trust to say what git runs (${bad}): set it in ~/.gitconfig itself, or use a Host alias in ~/.ssh/config`;
      }
    }
    return null;
  }
  if (!own.includes(file)) {
    return `\`${e.key}\` comes from ${raw}, a file this session's agent could write (only your own config, and the repository's .git/config, decide a push)`;
  }
  if (REPO_REFUSED.test(e.key)) return `the repository's own config sets \`${e.key}\`, which codeoid never uses for a push it makes (set it in your global config instead)`;
  return null;
}

/**
 * An include (`include.path`, `includeIf.<cond>.path`) is judged by what it names, whatever is there now: never in
 * the repository's own config (its target is relative to the repository the agent writes), and from your config
 * only when it names nothing the session's commands may write — git reads the file again when it pushes.
 */
function includeProblem(e: OriginEntry, repo: string, agentWritable: readonly string[], home?: string): string | null {
  if (!/^include\.path$|^includeif\.[\s\S]+\.path$/i.test(e.key)) return null;
  if (!USER_SCOPES.has(e.scope)) return `the repository's own config includes another file (\`${e.key}\`), which codeoid doesn't follow for a push`;
  if (e.scope === "command") return null;
  const raw = e.origin.startsWith("file:") ? e.origin.slice("file:".length) : "";
  const from = raw ? (isAbsolute(raw) ? raw : resolve(repo, raw)) : repo;
  const h = home ?? process.env.HOME ?? "";
  const named = e.value.startsWith("~/") ? join(h, e.value.slice(2)) : isAbsolute(e.value) ? e.value : resolve(dirname(from), e.value);
  const targets = [resolve(named), physicalPathOr(named)];
  const root = agentWritable.find((w) => targets.some((t) => within(w, t)));
  if (root) {
    return `your git config includes ${e.value}, a file a sandboxed session's agent can (or could) write (\`${e.key}\`): codeoid doesn't push with it${forgetHint(root)}`;
  }
  return null;
}

/** `ssh://…`, `git@host:path` (scp-like) or `https://…`: the protocols the push may use. */
export function pushUrlProblem(url: string): string | null {
  if (/[\x00-\x20\x7f]/.test(url)) return "it holds spaces or control characters";
  // Shown to the owner as is: nothing invisible or reordering in it.
  if (/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u0085\u00a0]/u.test(url)) return "it holds invisible or reordering characters";
  if (url.startsWith("-")) return "it starts with -";
  const scheme = /^(https|ssh):\/\/([^/]*)/i.exec(url);
  if (scheme) {
    // The authority as git and curl read it (user info to the last @, then host[:port]) must be what a URL parser
    // reads, which is what the card shows: `https://github.com\@elsewhere/` is github.com to one, elsewhere to the other.
    const authority = scheme[2] ?? "";
    if (/[\\?#%]/.test(authority) || (authority.match(/@/g)?.length ?? 0) > 1) return "its host part has characters git and the card would read differently";
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const host = hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : (hostPort.split(":")[0] ?? "");
    let parsed: string;
    try {
      parsed = new URL(url).hostname;
    } catch {
      return "it isn't a URL";
    }
    if (!host || host.toLowerCase() !== parsed.toLowerCase()) return "its host isn't what the card would show";
    return null;
  }
  // scp-like: [user@]host:path, no scheme, the host before the first colon has no slash.
  if (/^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/.test(url)) return null;
  return "only ssh and https remotes are pushed to";
}

/** A recorded setting (`scope\tkey\tvalue`) as shown to the owner: `key = value`, a secret-looking value hidden. */
export function shownSetting(entry: string): string {
  const [, key = "", ...rest] = entry.split("\t");
  const value = rest.join("\t");
  if (/extraheader|cookie|password|token|secret|auth|helper|pushoption/i.test(key)) return redactCredentials(`${key} = (hidden)`);
  // A command line may carry a password (`sshpass -p …`): its program only.
  if (/^core\.sshcommand$/i.test(key)) {
    const [program = "", ...args] = value.trim().split(/\s+/);
    return redactCredentials(`${key} = ${program}${args.length > 0 ? " (arguments hidden)" : ""}`);
  }
  return redactCredentials(`${key} = ${value}`);
}

/**
 * Text that may name a config key or value (a refusal, a shown setting), with no credential in it: a URL's user
 * info (to its last `@`, a password may hold one), `user:pass@host` without a scheme, and a URL's query. Everything
 * the agent, the transcript, the audit or a card reads goes through it.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1…@")
    .replace(/(^|[\s=,(`'"])[^\s/@`'"=,()]*:[^\s/]*@/g, "$1…@")
    .replace(/(\/\/[^\s`'"]*?)\?[^\s`'"]*/g, "$1?…");
}

/** A name as the owner's line shows it: an invisible or reordering character written as its code. */
export function shownName(name: string): string {
  return name.replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
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
/** Where a push from a repository goes, and what decides it: every part checked (see {@link planPush}). */
export interface PushTarget {
  repo: string;
  common: string;
  /** A linked worktree's own git dir (its HEAD and refs), else null. */
  own: string | null;
  remote: string;
  /** Where git will push: the remote's push URL after every rewrite (`git remote get-url --push`). */
  url: string;
  /** As the remote's config writes it, when a rewrite of yours changes it; else null. */
  configuredUrl: string | null;
  sshCommand: string | null;
  repoSettings: string[];
  /** What your global and system config say that decides a push (no include lines): part of a trust too. */
  userSettings: string[];
  /** Your config's connection and credential entries where the push was planned, in order ({@link CARRIED}). */
  userEntries: Array<[string, string]>;
}

/**
 * The remote a push from `repoDir` goes to, and the settings that decide it, checked: the repository's own
 * config only from its own files (never an include, never a key in REPO_REFUSED), yours only from files the
 * session can't write (an include judged by what it names), ssh or https only, no borrowed objects.
 */
export async function readPushTarget(
  repoDir: string,
  remote: string,
  opts: Pick<PlanOptions, "heldReadOnly" | "agentWritable" | "home" | "_testFileRemote"> & { requireHeld: boolean },
): Promise<PushTarget | { refused: string }> {
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
  // Another repository's objects reachable through alternates would go out with the push (links: below).
  for (const f of ["alternates", "http-alternates"]) {
    if (existsSync(join(common, "objects", "info", f))) return refuse(`the repository borrows objects from elsewhere (objects/info/${f})`);
  }
  const own = [physicalPath(join(common, "config")), ...(layout.own ? [physicalPath(join(layout.own, "config.worktree"))] : [physicalPath(join(common, "config.worktree"))])];
  // The repository's config can't change between this look and git's own read of it while the sandbox holds it
  // read-only: the session's repository (its git dir as the spec holds it), not one made or reached otherwise.
  if (opts.requireHeld) {
    const held = (opts.heldReadOnly ?? []).map((p) => physicalPath(p));
    if (!held.some((h) => within(h, own[0] as string))) {
      return refuse("this repository's git settings aren't held read-only by this session's sandbox (a repository made during the session, or one outside its workspace): push it yourself");
    }
  }
  const entries = (await config(repo, DECIDING_GIT)).filter((e) => DECIDING.test(e.key));
  const writable = physicalAll(opts.agentWritable ?? []);
  for (const e of entries) {
    const problem = originProblem(e, own, repo, writable, opts.home) ?? includeProblem(e, repo, writable, opts.home);
    if (problem) return refuse(problem);
    // A remote section named as a URL applies to a push to that URL: it would redirect it, whatever it says.
    const section = /^remote\.([\s\S]+)\.[^.]+$/.exec(e.key)?.[1];
    if (section !== undefined && section !== remote && /[:/]/.test(section)) {
      return refuse(`config has a remote section named as a URL (\`${e.key}\`), which git applies to pushes to that URL: push it yourself`);
    }
  }
  // Your own ssh command (a key per host, an agent's wrapper) — only from your config: the repository's is refused.
  const sshCommand = entries.filter((e) => e.key === "core.sshcommand" && (e.scope === "global" || e.scope === "system")).at(-1)?.value ?? null;
  // The subsection (the remote's name) is case-sensitive; git prints the section and the variable lowercased.
  const ofRemote = (name: string) => entries.filter((e) => e.key === `remote.${remote}.${name}`);
  const pushUrls = ofRemote("pushurl");
  const urls = ofRemote("url");
  const chosen = pushUrls.length > 0 ? pushUrls : urls;
  if (chosen.length === 0) return refuse(`there is no remote named ${remote}`);
  if (chosen.length > 1) return refuse(`remote ${remote} has ${chosen.length} push URLs: push it yourself`);
  const configured = (chosen[0] as OriginEntry).value;
  const url = await effectivePushUrl(repo, remote).catch(() => null);
  if (!url) return refuse(`git couldn't say where remote ${remote} pushes`);
  for (const u of new Set([configured, url])) {
    const bad = opts._testFileRemote && u.startsWith("file://") ? null : pushUrlProblem(u);
    if (bad) return refuse(`remote ${remote}'s URL can't be pushed to: ${bad}`);
  }
  const settings = (scopes: (s: string) => boolean) =>
    entries
      .filter((e) => scopes(e.scope) && !/^include\.path$|^includeif\.[\s\S]+\.path$/i.test(e.key))
      .map((e) => `${e.scope}\t${e.key}\t${e.value}`)
      .sort();
  return {
    repo,
    common,
    own: layout.own ? physicalPath(layout.own) : null,
    remote,
    url,
    configuredUrl: url === configured ? null : configured,
    sshCommand,
    repoSettings: settings((sc) => !USER_SCOPES.has(sc)),
    userSettings: settings((sc) => sc === "global" || sc === "system"),
    userEntries: entries.filter((e) => (e.scope === "global" || e.scope === "system") && CARRIED.test(e.key)).map((e) => [e.key, e.value] as [string, string]),
  };
}

/**
 * Your config entries that the push takes as they were where it was planned (the session's repository), in order:
 * how it authenticates and connects. An `includeIf "gitdir:…"` or `onbranch:` include applies there, not in the
 * daemon's staging repository, so what it set is handed to the push itself. Where it goes (remote.*, url.*) is
 * pinned already; the ssh command is passed as itself; push.* is the push's own.
 */
const CARRIED = /^(?:https?\.[\s\S]*|credential\.[\s\S]*|ssh\.variant|protocol\.[\s\S]*)$/i;

/** The plan for a push from `repo`, or why it is refused. */
export async function planPush(repoDir: string, input: PushInput, opts: PlanOptions): Promise<PushPlan | { refused: string }> {
  const refuse = (refused: string) => ({ refused });
  const remote = input.remote ?? "origin";
  const target = await readPushTarget(repoDir, remote, { ...opts, requireHeld: true });
  if ("refused" in target) return target;
  const { repo, common, own, url, configuredUrl, sshCommand, repoSettings, userSettings } = target;

  // The branch: named, or the one checked out.
  const refGit = opts.refGit ?? hostRefGit;
  let branch = input.branch;
  if (!branch) {
    // The full name (`--short` would say `heads/x` beside a tag x).
    const head = await askRef(refGit, repo, ["symbolic-ref", "-q", "HEAD"]);
    if ("refused" in head) return head;
    const full = head.out?.trim() ?? "";
    if (!full.startsWith("refs/heads/")) return refuse("no branch is checked out (a detached HEAD): name the branch to push");
    branch = full.slice("refs/heads/".length);
  }
  if (!isPushableBranchName(branch)) return refuse(`${JSON.stringify(branch)} isn't a branch name`);
  if (opts.protectedBranches.some((p) => branchMatches(p, branch as string))) {
    return refuse(`${branch} is a protected branch (sandbox.push.protectedBranches): push your work to a branch of its own, and open a pull request`);
  }
  const asked = await askRef(refGit, repo, ["rev-parse", "--verify", "-q", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  if ("refused" in asked) return asked;
  const sha = asked.out?.trim() ?? "";
  if (!sha) return refuse(`there is no local branch ${branch}: commit to it first`);
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return refuse(`${branch} doesn't name a commit`);

  let defaultUnknown = false;
  if (opts.remoteDefault) {
    const head = await opts.remoteDefault(url, repo, opts.lookupTimeoutMs ?? 30_000, sshCommand, opts.signal).catch(() => null);
    if (head === null) defaultUnknown = true;
    else if (head.toLowerCase() === branch.toLowerCase()) {
      return refuse(`${branch} is the remote's default branch: push your work to a branch of its own, and open a pull request`);
    }
  }
  return { repo, common, own, sshCommand, defaultUnknown, branch, sha, remote, url, configuredUrl, shownUrl: shownUrl(url), repoSettings, userSettings, userEntries: target.userEntries };
}

/** What an owner's trust in a repository's remote records (the store's `push_trust`). */
export interface PushTrust {
  common: string;
  remote: string;
  url: string;
  repoSettings: string[];
  userSettings: string[];
}

/**
 * Whether a push target is what its owner trusted: the same repository (its git dir), remote, URL, and
 * repository settings that decide a push. Anything else — another URL, a rewrite, a setting added — isn't.
 */
export function trustMatches(trust: PushTrust | null | undefined, target: Pick<PushTarget, "common" | "remote" | "url" | "repoSettings" | "userSettings">): boolean {
  if (!trust) return false;
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return trust.common === target.common && trust.remote === target.remote && trust.url === target.url && same(trust.repoSettings, target.repoSettings) && same(trust.userSettings, target.userSettings);
}

/** Where git pushes for `remote`: its push URL after every rewrite, as git itself resolves it. */
export async function effectivePushUrl(repo: string, remote: string): Promise<string | null> {
  const out = (await safeGit(["remote", "get-url", "--push", "--end-of-options", remote], repo, { timeoutMs: 20_000 })).trim();
  const lines = out.split("\n").filter(Boolean);
  return lines.length === 1 ? (lines[0] as string) : null;
}

/** Files the git store is walked past before it is called too big to check. */
const STORE_WALK_LIMIT = 300_000;

/**
 * Any link in the git store the push reads: git runs on the host, where a link the agent made (it can make a link
 * to a path it can't see) would be followed into a repository the sandbox hides, and its history pushed. Checked
 * at the plan and again right before git starts: refs (and a worktree's own), objects (every fan-out dir and file,
 * packs), packed-refs, HEAD, shallow. Alternates (borrowed objects) too.
 */
export function gitStoreProblem(common: string, own: string | null): string | null {
  for (const f of ["alternates", "http-alternates"]) {
    if (existsSync(join(common, "objects", "info", f))) return `the repository borrows objects from elsewhere (objects/info/${f})`;
  }
  let seen = 0;
  const walk = (dir: string, label: string): string | null => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(dir);
    } catch {
      return null; // not there
    }
    if (st.isSymbolicLink()) return `the repository's ${label} is a link`;
    if (!st.isDirectory()) return null;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return `the repository's ${label} couldn't be read`;
    }
    for (const n of names) {
      if (++seen > STORE_WALK_LIMIT) return "the repository has too many loose files to check (run `git gc`, then ask again)";
      const p = join(dir, n);
      let e: ReturnType<typeof lstatSync>;
      try {
        e = lstatSync(p);
      } catch {
        continue;
      }
      if (e.isSymbolicLink()) return `the repository's ${label}/${n} is a link`;
      if (e.isDirectory()) {
        const deeper = walk(p, `${label}/${n}`);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  for (const [base, names] of [[common, ["refs", "objects"]], ...(own ? [[own, ["refs"]] as const] : [])] as const) {
    for (const n of names) {
      const problem = walk(join(base, n), n);
      if (problem) return problem;
    }
  }
  for (const base of own ? [common, own] : [common]) {
    for (const f of ["packed-refs", "HEAD", "shallow", "commondir", "gitdir"]) {
      try {
        if (lstatSync(join(base, f)).isSymbolicLink()) return `the repository's ${f} is a link`;
      } catch {
        /* not there */
      }
    }
  }
  return null;
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
  ["core.logAllRefUpdates", "false"],
];

/** The remote's default branch (`ls-remote --symref <url> HEAD`), or null. */
export async function remoteDefaultBranch(url: string, cwd: string, timeoutMs = 30_000, ssh: string | null = null, signal?: AbortSignal): Promise<string | null> {
  const r = await runGit(["ls-remote", "--symref", "--end-of-options", url, "HEAD"], cwd, timeoutMs, { sshCommand: ssh, signal });
  if (r.code !== 0) return null;
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout);
  return m ? (m[1] as string) : null;
}

export interface PushResult {
  ok: boolean;
  /** Not pushed because codeoid refused it (not a failure of git or the remote). */
  refused?: boolean;
  /** What happened, one line. */
  summary: string;
  /** git's output, redacted and capped. */
  output: string;
}

/**
 * Writes a bundle of `ref` (and the history it needs) from `repo` into `dest`, a file of the daemon's own. The
 * session's: `git bundle create` inside its sandbox, its stdout streamed to `dest` ({@link bundleFromChild}), so a
 * link the agent made into a path the sandbox hides leads nowhere, and the file is never one the agent can reach.
 * Resolves with why it couldn't, or null.
 */
export type BundleMaker = (repo: string, ref: string, dest: string) => Promise<string | null>;

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Where the daemon stages the push: a private dir of its own, which no session can see. */
  stagingRoot: string;
  makeBundle: BundleMaker;
  /**
   * Ask the remote for its default branch first (refused as a target): `refuse-unknown` refuses when it can't be
   * read (autonomous mode), `allow-unknown` goes on and says so (the owner approved it); absent: not asked.
   */
  checkDefault?: "refuse-unknown" | "allow-unknown";
  /**
   * Everything any session's sandboxed commands may write. The push runs on the host with your credentials: its
   * PATH keeps none of these, and an ssh command or credential helper in one is refused.
   */
  hostWritable?: readonly string[];
  /** Tests only: a local bare repository as the remote. */
  _testFileRemote?: boolean;
}

/**
 * The keys whose entries (in order) differ between `planned` (your config where the push was planned, the session's
 * repository) and `here` (where codeoid pushes from): what a conditional include makes apply in one and not the other.
 */
export function differingKeys(planned: ReadonlyArray<[string, string]>, here: ReadonlyArray<[string, string]>): string[] {
  const keys = new Set([...planned, ...here].map(([k]) => k));
  const of = (list: ReadonlyArray<[string, string]>, k: string) => JSON.stringify(list.filter(([x]) => x === k).map(([, v]) => v));
  return [...keys].filter((k) => of(planned, k) !== of(here, k)).sort();
}

/**
 * The daemon's PATH for the push, which runs on the host with your credentials: git's own dir, then the absolute
 * entries {@link hostPathProblem} doesn't refuse. A dir under your home is out (a session's workspace may be, or
 * may have been: a program an agent left there outlives its session), and so is one others may write.
 */
export function safePathFor(writable: readonly string[], path = process.env.PATH ?? "", home = homedir()): string {
  const out: string[] = [];
  for (const d of [dirname(GIT_BIN), dirname(physicalPathOr(GIT_BIN))]) if (!out.includes(d) && !hostPathProblem(d, writable, home)) out.push(d);
  for (const e of path.split(":")) {
    if (!e || !isAbsolute(e) || out.includes(e)) continue;
    if (hostPathProblem(e, writable, home)) continue;
    out.push(e);
  }
  return out.join(":");
}

/**
 * Each path as given and where it really is, once (a long history is judged in one pass). One that no longer
 * resolves (gone, a file now, unreadable) stands as itself: nothing that resolves can be in it.
 */
function physicalAll(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    out.add(p);
    out.add(physicalPathOr(p));
  }
  return [...out];
}

function physicalPathOr(p: string): string {
  try {
    return physicalPath(p);
  } catch {
    return p;
  }
}

/** The id a user namespace shows for an owner it doesn't map (root's files, inside a container or bwrap). */
const OVERFLOW_UID = 65534;

/**
 * Your user-private group (Linux: named as you, nobody else in it), if you have one. macOS's staff and a shared
 * `users` group are every local user's: never.
 */
function privateGroup(): number[] {
  if (process.platform === "darwin" || typeof process.getgid !== "function") return [];
  const gid = process.getgid();
  try {
    // Your name by your uid (passwd), not the environment's.
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
    const me =
      readFileSync("/etc/passwd", "utf8")
        .split("\n")
        .find((l) => l.split(":")[2] === uid)
        ?.split(":")[0] ?? userInfo().username;
    const line = readFileSync("/etc/group", "utf8")
      .split("\n")
      .find((l) => l.split(":")[2] === String(gid));
    const [name, , , members = ""] = line?.split(":") ?? [];
    return name === me && members.split(",").every((m) => !m || m === me) ? [gid] : [];
  } catch {
    return [];
  }
}

/** Whether the daemon runs in a user namespace that doesn't map root (where root's files show as the overflow id). */
function inUserNamespace(): boolean {
  try {
    const map = readFileSync("/proc/self/uid_map", "utf8").trim().split("\n");
    return !map.some((l) => /^\s*0\s+0\s+/.test(l));
  } catch {
    return false;
  }
}

/** Why a program the push may run, or a dir it may come from, isn't trusted on the host; else null. */
export function hostPathProblem(at: string, writable: readonly string[], home = homedir(), o: { homeAllowed?: boolean } = {}): string | null {
  let real: string;
  try {
    real = physicalPath(at);
  } catch {
    return `${at} can't be resolved`;
  }
  if (programProblem(at, writable) || programProblem(real, writable)) return `${at} is in a directory a session's commands may write`;
  if (!o.homeAllowed && home && (within(home, real) || within(home, at))) return `${at} is under your home, where a session's commands may write (or have written)`;
  // Neither it nor a dir above it (as named, and where it really is) owned by anyone but you or root, writable by
  // everyone, or writable by a group you aren't in.
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  // Group-write only by your own primary group (Linuxbrew's), or macOS's admin group (Homebrew's): never a group
  // every local user is in (staff, users, everyone).
  const groups = new Set<number>(privateGroup());
  if (process.platform === "darwin") groups.add(80);
  const overflow = inUserNamespace() ? OVERFLOW_UID : -2;
  for (const start of new Set([real, at])) {
    for (let d = start; ; d = dirname(d)) {
      try {
        const st = lstatSync(d);
        // Root's, yours, or the kernel's overflow id (root's files seen from a user namespace): no other user's.
        if (uid >= 0 && st.uid !== 0 && st.uid !== uid && st.uid !== overflow) return `${d} belongs to another user`;
        // A link's own mode means nothing (always 0777): whether it can be replaced is its dir's, checked next.
        if (st.isSymbolicLink()) {
          if (dirname(d) === d) break;
          continue;
        }
        const sticky = st.isDirectory() && (st.mode & 0o1000) !== 0 && d !== start;
        if ((st.mode & 0o002) !== 0 && !sticky) return `${d} is writable by everyone`;
        if ((st.mode & 0o020) !== 0 && !sticky && !groups.has(st.gid)) return `${d} is writable by a group you aren't in`;
      } catch {
        /* a part that isn't there: nothing runs from it */
      }
      if (dirname(d) === d) break;
    }
  }
  return null;
}

/**
 * Why a command line the push would run (`ssh -i …`, `!helper get`, `/path/to/helper`) can't: every path it names
 * (a word with a `/`, `~` expanded) is judged by {@link hostPathProblem}. Bare names resolve on {@link safePathFor}.
 */
export function commandProblem(command: string, writable: readonly string[], home = homedir()): string | null {
  const words = command
    .replace(/^\s*!/, "")
    .split(/[\s;|&()<>`"'=]+/)
    .filter(Boolean);
  const sshDir = join(home, ".ssh");
  for (const [i, raw] of words.entries()) {
    if (!raw.includes("/") && !raw.startsWith("~")) continue;
    const word = raw.startsWith("~/") || raw === "~" ? join(home, raw.slice(1)) : raw;
    if (!isAbsolute(word)) return `${raw} is a relative path`;
    // Any path word may be a program (`sh <script>`, `env <prog>`, a `!f() { … }` body, `ProxyCommand=<prog>`):
    // nowhere a session could leave one, your home included. Only a file handed in a known data position (a key,
    // a store file, a socket, ~/.ssh's own) may be under your home, yours alone, never where a session writes.
    const data = isDataPosition(words, i) || within(sshDir, word);
    const bad = hostPathProblem(word, writable, home, { homeAllowed: data });
    if (bad) return bad;
  }
  return null;
}

/**
 * Whether `words[i]` is a file the command's program only reads: ssh's `-i` and its file options (`-o IdentityFile=`
 * and the like), git's store and cache helpers' `--file` / `--socket`. Judged by the program it follows, and the
 * flag exactly (`env -i <prog>`, `ssh -I <lib>` aren't data).
 */
function isDataPosition(words: readonly string[], i: number): boolean {
  const program = (words[0] ?? "").split("/").at(-1) ?? "";
  const prev = words[i - 1] ?? "";
  if (program === "ssh") return prev === "-i" || SSH_FILE_OPTIONS.has(prev.toLowerCase());
  if (/^(?:git-credential-)?store$/.test(program)) return prev === "--file";
  if (/^(?:git-credential-)?cache$/.test(program)) return prev === "--socket";
  return false;
}

/** ssh options (`-o Name=value`, any case as ssh takes them) whose value is a file ssh reads, never runs. */
const SSH_FILE_OPTIONS = new Set(["identityfile", "userknownhostsfile", "globalknownhostsfile", "controlpath", "certificatefile", "identityagent"]);

function programProblem(program: string, writable: readonly string[]): boolean {
  const real = physicalPathOr(program);
  return physicalAll(writable).some((w) => within(w, program) || within(w, real));
}

/** A staging dir older than this is a push a stopped daemon left behind (a push takes minutes at most). */
const STALE_STAGE_MS = 6 * 60 * 60 * 1000;

/**
 * Why `root` can't stage a push: it must be a real directory (no link), the daemon's own, that nobody else can
 * read or write. Made (0700) when missing.
 */
export function stagingRootProblem(root: string): string | null {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) return `the staging dir ${root} isn't a directory`;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `the staging dir ${root} isn't the daemon's own`;
    if ((st.mode & 0o077) !== 0) return `the staging dir ${root} is open to others (chmod 700 it)`;
    return null;
  } catch (err) {
    return `the staging dir ${root} couldn't be made (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** Remove the staging dirs a stopped daemon left behind (never a running push's). */
function sweepStaging(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith("push-")) continue;
      const at = join(root, name);
      try {
        const st = lstatSync(at);
        if (Date.now() - st.mtimeMs > STALE_STAGE_MS) rmSync(at, { recursive: true, force: true });
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* nothing to sweep */
  }
}

/**
 * What `file`'s header says, if it is a plain git bundle (v2, or v3 with at most an `@object-format`): its object
 * format. Else why not. The whole header is read (to the blank line that ends it), every line of it checked.
 */
export function readBundleHeader(file: string): { format: "sha1" | "sha256" } | { problem: string } {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return { problem: "it isn't there" };
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString("latin1");
    const v3 = head.startsWith("# v3 git bundle\n");
    if (!v3 && !head.startsWith("# v2 git bundle\n")) return { problem: "no bundle header" };
    const endAt = head.indexOf("\n\n");
    // A bundle of one branch has a header of a few lines: one that doesn't end in what was read is refused.
    if (endAt < 0) return { problem: "its header doesn't end" };
    let format: "sha1" | "sha256" = "sha1";
    let caps = 0;
    for (const line of head.slice(0, endAt).split("\n").slice(1)) {
      if (line.startsWith("@")) {
        // git takes a capability anywhere in a v3 header: each is checked wherever it is.
        const m = /^@object-format=(sha1|sha256)$/.exec(line);
        if (!v3 || !m || ++caps > 1) return { problem: `capability ${JSON.stringify(line.slice(0, 40))}` };
        format = m[1] as "sha1" | "sha256";
      } else if (!/^-?[0-9a-f]{40,64}( .*)?$/.test(line)) {
        return { problem: "a header line that isn't a ref or a prerequisite" };
      }
    }
    return { format };
  } finally {
    closeSync(fd);
  }
}

/** Why `file` isn't a plain git bundle, or null ({@link readBundleHeader}). */
export function bundleHeaderProblem(file: string): string | null {
  const h = readBundleHeader(file);
  return "problem" in h ? h.problem : null;
}

/**
 * Why `gitBin` can't be the git run inside a session's sandbox: it must be an absolute path outside everything that
 * session's commands may write (lexically and physically), so no agent's program stands in for it.
 */
export function gitBinProblem(gitBin: string, writable: readonly string[], home = homedir()): string | null {
  if (!isAbsolute(gitBin)) return "codeoid found no git on this machine";
  const bad = hostPathProblem(gitBin, writable, home);
  return bad ? `the git codeoid runs (${gitBin}) can't be trusted for a push: ${bad}` : null;
}

/** The largest bundle taken into the daemon's staging repository. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Stream `child`'s stdout (a `git bundle create … -`) into `dest`, created new (never through a link), stopping it at
 * `maxBytes`, `timeoutMs` or `signal`. Resolves with why it failed, or null once it exited 0.
 */
export function bundleFromChild(child: ChildProcessWithoutNullStreams, dest: string, o: { maxBytes?: number; timeoutMs: number; signal?: AbortSignal }): Promise<string | null> {
  const max = o.maxBytes ?? MAX_BUNDLE_BYTES;
  return new Promise((done) => {
    let fd: number | null = null;
    let size = 0;
    let why: string | null = null;
    let stderr = "";
    const stop = (reason: string) => {
      why ??= reason;
      child.kill("SIGKILL");
    };
    try {
      fd = openSync(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (err) {
      stop(`the staging file couldn't be made (${err instanceof Error ? err.message : String(err)})`);
    }
    const timer = setTimeout(() => stop(`it took longer than ${Math.round(o.timeoutMs / 1000)}s`), o.timeoutMs);
    const onAbort = () => stop("the session is closing");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    child.stdout.on("data", (c: Buffer) => {
      if (why || fd === null) return;
      size += c.length;
      if (size > max) return stop("the branch's history is too big to push this way");
      try {
        writeSync(fd, c);
      } catch (err) {
        stop(`the staging file couldn't be written (${err instanceof Error ? err.message : String(err)})`);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 4096) stderr += c;
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
    let settled = false;
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (fd !== null) closeSync(fd);
      if (!why && code !== 0) why = stderr.trim().split("\n").slice(-1)[0]?.slice(0, 300) || `git bundle exited ${code ?? sig}`;
      done(why);
    };
    child.once("error", (err) => {
      why ??= err.message;
      finish(null, null);
    });
    child.once("close", finish);
  });
}

/**
 * Run the push the plan names. The host's git never reads the agent's repository for it: the branch is bundled
 * inside the session's sandbox (`makeBundle`) into a file of the daemon's own, fetched into a bare repository of the
 * daemon's own, its tip checked against the plan's commit, and the push made from there to the plan's URL. So no
 * link, alternates file, reflog or FIFO the agent puts in its repository — now or while the push runs — is
 * followed by a git that sees what the sandbox hides, and nothing is written back into the agent's repository.
 */
export async function runPush(plan: PushPlan, o: RunOptions): Promise<PushResult & { defaultUnknown?: boolean }> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1_000, deadline - Date.now());
  if (o.signal?.aborted) return { ok: false, summary: "not pushed: the session is closing", output: "" };
  const writable = o.hostWritable ?? [];
  const path = o.hostWritable ? safePathFor(writable) : undefined;
  const programs = [plan.sshCommand, process.env.GIT_SSH_COMMAND, process.env.GIT_SSH, ...plan.userEntries.filter(([k]) => /^credential\.([\s\S]+\.)?helper$/i.test(k)).map(([, v]) => v)];
  for (const c of o.hostWritable ? programs : []) {
    const bad = c ? commandProblem(c, writable) : null;
    if (bad) return { ok: false, refused: true, summary: `refused: the push would run ${bad}`, output: "" };
  }
  const rootProblem = stagingRootProblem(o.stagingRoot);
  if (rootProblem) return { ok: false, summary: `not pushed: ${rootProblem}`, output: "" };
  sweepStaging(o.stagingRoot);
  const stage = mkdtempSync(join(o.stagingRoot, "push-"));
  try {
    // 1. The bundle, made where the agent's links lead nowhere.
    const bundle = join(stage, "push.bundle");
    const made = await o.makeBundle(plan.repo, `refs/heads/${plan.branch}`, bundle).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (made) return { ok: false, refused: true, summary: `refused: the branch couldn't be bundled in the session's sandbox (${made})`, output: "" };
    if (o.signal?.aborted) return { ok: false, summary: "not pushed: the session is closing", output: "" };
    // 2. A repository of the daemon's own, holding just that branch.
    const repo = join(stage, "repo.git");
    const local = async (args: string[]) => {
      const r = await runGit(args, stage, left(), { sshCommand: null, signal: o.signal, path });
      if (r.code !== 0) throw new Error(shownOutput(r.stderr).split("\n")[0] || `git ${args[0]} failed`);
      return r.stdout;
    };
    try {
      // A bundle, by its header, and nothing else: a fetch would take any other file as a path to a repository (a
      // gitfile naming one the sandbox hides), so it is unbundled, which reads only a bundle.
      const header = readBundleHeader(bundle);
      if ("problem" in header) return { ok: false, refused: true, summary: `refused: what the session's sandbox made isn't a plain git bundle (${header.problem})`, output: "" };
      if ((header.format === "sha256") !== (plan.sha.length === 64)) return { ok: false, summary: "refused: the bundle's object format isn't the repository's", output: "" };
      await local(["-c", "init.templateDir=", "init", "-q", "--bare", `--object-format=${header.format}`, repo]);
      const listed = await local(["--git-dir", repo, "bundle", "unbundle", bundle, `refs/heads/${plan.branch}`]);
      const tip = /^([0-9a-f]{40,64}) refs\/heads\/(\S+)$/m.exec(listed);
      if (!tip?.[1] || tip[2] !== plan.branch) return { ok: false, refused: true, summary: `refused: the bundle the session's sandbox made doesn't hold ${plan.branch}`, output: "" };
      await local(["--git-dir", repo, "update-ref", `refs/heads/${plan.branch}`, tip[1]]);
      await local(["--git-dir", repo, "symbolic-ref", "HEAD", `refs/heads/${plan.branch}`]);
      // The checked commit, or one the agent made on top of it since (only the checked one is pushed, from here).
      const holds =
        tip[1] === plan.sha ||
        (await runGit(["--git-dir", repo, "merge-base", "--is-ancestor", plan.sha, tip[1]], stage, left(), { sshCommand: null, signal: o.signal })).code === 0;
      // No commit id in it: the agent reads this.
      if (!holds) return { ok: false, refused: true, summary: `refused: ${plan.branch} in the session's sandbox doesn't have the commit that was checked (it moved): ask again`, output: "" };
      await local(["--git-dir", repo, "config", "remote.target.url", plan.url]);
      // Where git will push from here, after your rewrites: the plan's URL, or nothing is pushed.
      const there = (await local(["--git-dir", repo, "remote", "get-url", "--push", "target"])).trim();
      if (there !== plan.url) return { ok: false, refused: true, summary: `refused: your git config rewrites ${shownUrl(plan.url)} again (to ${shownUrl(there)})`, output: "" };
      // What your config set where the push was planned and doesn't set here (an includeIf), handed to the push.
      // How the push authenticates and connects must be what was checked and trusted: your config as it applies in
      // the session's repository. A conditional include (gitdir:, onbranch:, hasconfig:) that applies there and not
      // here, or here and not there, refuses the push rather than send other credentials or settings.
      const here = (await config(repo, DECIDING_GIT)).filter((e) => (e.scope === "global" || e.scope === "system") && CARRIED.test(e.key));
      const differ = differingKeys(
        plan.userEntries,
        here.map((e) => [e.key, e.value] as [string, string]),
      );
      if (differ.length > 0) {
        return {
          ok: false,
          refused: true,
          summary: `refused: your git config's ${differ.slice(0, 5).join(", ")}${differ.length > 5 ? ", …" : ""} apply differently in this repository than where codeoid pushes from (a conditional include, includeIf): set them unconditionally, or for the remote's URL (credential.<url>.*, http.<url>.*)`,
          output: "",
        };
      }
    } catch (err) {
      return { ok: false, refused: true, summary: `refused: the branch couldn't be staged for the push (${err instanceof Error ? err.message : String(err)})`, output: "" };
    }
    // 3. The remote's default branch, asked from here (never from the agent's repository and its legacy remotes files).
    let defaultUnknown = false;
    if (o.checkDefault) {
      const r = await runGit(["--git-dir", repo, "ls-remote", "--symref", "target", "HEAD"], stage, Math.min(30_000, left()), {
        sshCommand: plan.sshCommand,
        signal: o.signal,
        path,
        ...(o._testFileRemote ? { protocol: "file" as const } : {}),
      });
      const head = r.code === 0 ? /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout)?.[1] : undefined;
      // Asked, and the remote says it has no default branch yet (an empty repository: its first branch pushed becomes it).
      const empty = r.code === 0 && !r.stdout.trim();
      if (head && head.toLowerCase() === plan.branch.toLowerCase()) {
        return { ok: false, refused: true, summary: `refused: ${plan.branch} is the remote's default branch: push your work to a branch of its own, and open a pull request`, output: "" };
      }
      if (!head) {
        if (o.checkDefault === "refuse-unknown") {
          return {
            ok: false,
            refused: true,
            summary: empty
              ? `refused: ${plan.shownUrl} has no default branch yet (an empty repository), and the first branch pushed there may become it: ask the owner to push its first branch; after that, agents can push theirs`
              : `refused: codeoid couldn't ask ${plan.shownUrl} which branch is its default, so it can't be sure ${plan.branch} isn't it: try again, or ask the owner to push`,
            output: "",
          };
        }
        defaultUnknown = true;
      }
    }
    if (o.signal?.aborted) return { ok: false, summary: "not pushed: the session is closing", output: "" };
    // 4. The push, from the daemon's repository.
    const r = await runGit(
      ["--git-dir", repo, "push", "--porcelain", "--no-verify", "--no-signed", "--no-follow-tags", "--no-recurse-submodules", "--end-of-options", "target", `${plan.sha}:refs/heads/${plan.branch}`],
      stage,
      left(),
      { sshCommand: plan.sshCommand, signal: o.signal, path, ...(o._testFileRemote ? { protocol: "file" as const } : {}) },
    );
    const output = shownOutput(`${r.stdout}\n${r.stderr}`);
    const unknownNote = defaultUnknown ? " (the remote didn't say which branch is its default)" : "";
    if (r.aborted) return { ok: false, summary: "stopped: the session closed while it was pushing (the remote may or may not have it)", output };
    if (r.timedOut) return { ok: false, summary: `the push timed out after ${Math.round(timeoutMs / 1000)}s (the remote may or may not have it)`, output };
    // Porcelain: a tab-separated line per ref, flag first: ` ` fast-forward, `*` new, `=` up to date, `!` rejected.
    const line = r.stdout.split("\n").find((l) => l.includes(`:refs/heads/${plan.branch}\t`) || l.endsWith(`:refs/heads/${plan.branch}`));
    const flag = line?.[0];
    if (r.code === 0 && flag === "=") return { ok: true, summary: `${plan.branch} is already up to date on ${plan.remote}${unknownNote}`, output, defaultUnknown };
    if (r.code === 0) {
      return { ok: true, summary: `pushed ${plan.branch} (${plan.sha.slice(0, 12)}) to ${plan.remote}${flag === "*" ? ", a new branch there" : ""}${unknownNote}`, output, defaultUnknown };
    }
    if (flag === "!") {
      // `!<TAB>from:to<TAB>[rejected] (non-fast-forward)`.
      const why = line?.split("\t").slice(2).join(" ").trim() || "rejected";
      return {
        ok: false,
        summary: /non-fast-forward|fetch first|stale info/.test(why)
          ? `the remote's ${plan.branch} has commits yours doesn't (${why}): a force push isn't done for agents. Your commands can't fetch either (no network to the git host, no credentials): ask the owner to fetch it (or merge the remote's branch for you), or push to a new branch of your own`
          : `the remote refused it (${why})`,
        output,
      };
    }
    return { ok: false, summary: `git push failed (exit ${r.code ?? "killed"})`, output };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}


/** @deprecated name kept for tests: {@link gitStoreProblem} without a worktree. */
export function objectsProblem(common: string): string | null {
  return gitStoreProblem(common, null);
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
  o: { sshCommand: string | null; signal?: AbortSignal; protocol?: "file"; path?: string },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  const env = await safeGitEnv(cwd, { network: true, overrides: PUSH_OVERRIDES });
  if (o.path !== undefined) env.PATH = o.path;
  // A push never prompts: no askpass program (one from the daemon's environment may be in what a session writes).
  for (const k of ["GIT_ASKPASS", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "DISPLAY"]) delete env[k];
  if (o.signal?.aborted) return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
  // A local bundle into the daemon's own repository (and tests' local remotes): that protocol alone.
  if (o.protocol) env.GIT_ALLOW_PROTOCOL = o.protocol;
  // How ssh runs: your environment's GIT_SSH_COMMAND / GIT_SSH first (as git itself ranks them), then your own
  // core.sshCommand (planPush took it from your global or system config only), else ssh that never waits for a
  // person (a host-key or passphrase prompt) and gives up on a dead host. The time limit bounds any of them.
  if (!env.GIT_SSH_COMMAND) {
    // git's own order: GIT_SSH_COMMAND, then core.sshCommand, then GIT_SSH; always set here, so codeoid's base
    // override (core.sshCommand=ssh) never decides. Else ssh by its full path on that PATH, never waiting.
    const ssh = o.path !== undefined && typeof Bun !== "undefined" ? (Bun.which("ssh", { PATH: o.path }) ?? "ssh") : "ssh";
    if (o.sshCommand) env.GIT_SSH_COMMAND = o.sshCommand;
    else if (env.GIT_SSH) env.GIT_SSH_COMMAND = `'${env.GIT_SSH.replace(/'/g, "'\\''")}'`;
    else env.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes -o ConnectTimeout=20`;
  }
  delete env.GIT_SSH;
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
