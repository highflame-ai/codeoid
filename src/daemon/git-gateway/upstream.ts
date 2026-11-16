/**
 * The git gateway's side facing the remote (docs/git-gateway-design.md §3.4): every git it runs there uses none of
 * the owner's git config (no global or system config: no helper, `includeIf`, rewrite, hook or driver), only what
 * codeoid sets, and the owner's credential for that remote: ssh (the system ssh, with the owner's own key, agent and
 * `~/.ssh/config`) or https (a credential captured once, at connect, handed to git by a credential helper of codeoid's
 * that reads it from a 0600 file in the gateway's private dir for that run only: never in an env or on a command line,
 * which other processes of the user's may read).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GIT_BIN } from "../git-env.js";
import { programTrustProblem } from "./hostpath.js";
import { redactCredentials, shownOutput } from "./text.js";

export type UpstreamKind = "ssh" | "https";

/** A credential for an https remote (`git credential fill`'s, or a dedicated token as its password). */
export interface HttpsCredential {
  username: string;
  password: string;
  /** The owner's CA bundle for this remote (`http.sslCAInfo` at connect), when they set one. */
  caInfo?: string;
}

export interface Upstream {
  url: string;
  kind: UpstreamKind;
  /** For https: the credential sent to this remote's origin only. */
  credential?: HttpsCredential;
  /** The gateway's private dir for a run's credential file (never in a sandbox). */
  runDir?: string;
  /** Tests only: a local bare repository as the remote (`file://`), which a real one never is. */
  testFile?: boolean;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** ssh or https, from the URL's form; null for anything else. */
export function upstreamKind(url: string): UpstreamKind | null {
  if (/^https:\/\//i.test(url)) return "https";
  if (/^ssh:\/\//i.test(url) || /^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(url)) return "ssh";
  return null;
}

/** The system's ssh, judged where it is (never one a session could have put on a PATH). */
export function systemSsh(writable: readonly string[]): { path: string } | { problem: string } {
  for (const p of ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"]) {
    if (!existsSync(p)) continue;
    const bad = programTrustProblem(p, writable);
    return bad ? { problem: bad } : { path: p };
  }
  return { problem: "no ssh found in the system's directories (/usr/bin, /bin, /usr/local/bin)" };
}

/** `[key, value]` config entries as git's `GIT_CONFIG_COUNT` env (command scope, never on argv). */
export function configEnv(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** What every gateway git is: no config of the owner's, no prompt, no program but what is named here. */
const CLEAN_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.askPass", ""],
  ["credential.helper", ""],
  ["http.followRedirects", "false"],
  ["protocol.version", "2"],
  ["push.default", "nothing"],
  ["push.followTags", "false"],
  ["push.gpgSign", "false"],
  ["push.recurseSubmodules", "no"],
  ["submodule.recurse", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["transfer.fsckObjects", "true"],
  ["core.logAllRefUpdates", "false"],
  ["gc.auto", "0"],
  ["init.templateDir", ""],
];

const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Run `fn` with the environment of a git toward `up`: nothing of the daemon's environment but what ssh needs to find
 * the owner's key (HOME, the agent socket); never an askpass or a GIT_SSH of the environment's. An https credential is
 * written to a file of its own for this run, which only codeoid's helper reads, and removed after.
 */
// paths: the gateway's private run dir (made 0700): a credential file of this run's, written 0600, removed after
export async function withUpstreamEnv<T>(up: Upstream, ssh: string | null, fn: (env: Record<string, string>) => Promise<T>, extra: ReadonlyArray<readonly [string, string]> = []): Promise<T> {
  const entries: Array<readonly [string, string]> = [...CLEAN_CONFIG, ...extra];
  if (up.kind === "ssh" && ssh) entries.push(["core.sshCommand", `${ssh} -o BatchMode=yes -o ConnectTimeout=20`]);
  let credFile: string | null = null;
  if (up.kind === "https" && up.credential) {
    if (!up.runDir) throw new Error("no private dir for the credential");
    mkdirSync(up.runDir, { recursive: true, mode: 0o700 });
    credFile = join(up.runDir, `${randomBytes(12).toString("hex")}.cred`);
    writeFileSync(credFile, `username=${up.credential.username}\npassword=${up.credential.password}\n`, { mode: 0o600 });
    // Asked by git only for this remote's origin (a URL-scoped helper; redirects aren't followed at all).
    const origin = new URL(up.url).origin;
    entries.push([`credential.${origin}.helper`, `!f() { test "$1" = get && cat ${sh(credFile)}; }; f`]);
    if (up.credential.caInfo) entries.push([`http.${origin}/.sslCAInfo`, up.credential.caInfo]);
  }
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: homedir(),
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: up.testFile ? "file" : up.kind === "ssh" ? "ssh" : "https",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...configEnv(entries),
  };
  if (process.env.SSH_AUTH_SOCK && up.kind === "ssh") env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  for (const k of ["XDG_RUNTIME_DIR", "USER", "LOGNAME"]) if (process.env[k]) env[k] = process.env[k] as string;
  try {
    return await fn(env);
  } finally {
    if (credFile) rmSync(credFile, { force: true });
  }
}

/** git, its whole process group killed at the limit or the signal; output capped. */
// paths: git run in the daemon's own gateway dirs (a cache repository), with the gateway's env only
export function runGit(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((done) => {
    if (signal?.aborted) return done({ code: null, stdout: "", stderr: "stopped", timedOut: false });
    const child = spawn(GIT_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    const cap = (s: string, d: Buffer) => (s.length > 1024 * 1024 ? s : s + d.toString("utf8"));
    child.stdout.on("data", (d: Buffer) => {
      stdout = cap(stdout, d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = cap(stderr, d);
    });
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      done({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: err.message, timedOut });
    });
  });
}

/** git's error, its telling lines (not its access-rights boilerplate), redacted: what the agent and the owner read. */
export function gitError(r: GitResult, what: string): string {
  if (r.timedOut) return `${what} timed out`;
  const lines = shownOutput(r.stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Please make sure you have the correct access rights|^and the repository exists\.?$/.test(l));
  const telling = lines.filter((l) => /^(fatal|error|ssh|remote|Permission|Could not|Host key|kex_|Connection)/i.test(l));
  const shown = (telling.length > 0 ? telling : lines).slice(0, 3).join(" — ");
  return redactCredentials(shown ? `${what}: ${shown}` : `${what} failed (exit ${r.code ?? "killed"})`);
}

/** What a refresh learned of the remote. */
export interface RemoteState {
  /** Its default branch (its `HEAD`), or null when it has none yet (an empty repository). */
  defaultBranch: string | null;
  /** Whether the remote said what its default branch is (false: the lookup failed). */
  defaultKnown: boolean;
  /** Its branches that are symbolic refs (a push to one would move what it points at). */
  symrefs: ReadonlySet<string>;
  /** Whether it has any branch at all. */
  empty: boolean;
}

/**
 * Bring the daemon's cache of `up` (a bare repository) to what the remote has: its branches and tags, pruned. Made
 * by a bare clone the first time (which takes the remote's object format). Says what it learned of the remote.
 */
export async function refreshCache(cache: string, up: Upstream, ssh: string | null, timeoutMs: number, signal?: AbortSignal): Promise<RemoteState | { error: string }> {
  return withUpstreamEnv(up, ssh, async (env) => {
    if (!existsSync(cache)) {
      const r = await runGit(["clone", "--bare", "--quiet", "--no-tags", "--", up.url, cache], homedir(), env, timeoutMs, signal);
      if (r.code !== 0) return { error: gitError(r, "the remote couldn't be fetched") };
    }
    const f = await runGit(["fetch", "--quiet", "--prune", "--prune-tags", "--no-write-fetch-head", "--", up.url, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], cache, env, timeoutMs, signal);
    if (f.code !== 0) return { error: gitError(f, "the remote couldn't be fetched") };
    // Every branch with its symref target, and HEAD (protocol v2's ls-refs symrefs).
    const h = await runGit(["ls-remote", "--symref", "--", up.url, "HEAD", "refs/heads/*"], cache, env, Math.min(timeoutMs, 60_000), signal);
    const symrefs = new Set<string>();
    let defaultBranch: string | null = null;
    let heads = 0;
    if (h.code === 0) {
      for (const line of h.stdout.split("\n")) {
        const sym = /^ref: (refs\/heads\/\S+)\t(\S+)$/.exec(line);
        if (sym?.[1] && sym[2] === "HEAD") defaultBranch = sym[1].slice("refs/heads/".length);
        else if (sym?.[2]?.startsWith("refs/heads/")) symrefs.add(sym[2]);
        else if (/^[0-9a-f]{40,64}\trefs\/heads\//.test(line)) heads++;
      }
    }
    if (defaultBranch) await runGit(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], cache, env, 10_000, signal);
    return { defaultBranch, defaultKnown: h.code === 0, symrefs, empty: h.code === 0 && heads === 0 };
  });
}

/**
 * Push the checked updates to the remote, from the cache with the pushed objects in its quarantine (`objects`: the
 * quarantine and the cache's own objects). Atomic: all or none. Resolves with what to tell the agent.
 */
export async function pushUpstream(
  cache: string,
  up: Upstream,
  ssh: string | null,
  updates: ReadonlyArray<{ new: string; ref: string }>,
  objects: { dir: string; alternates: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: true; output: string } | { ok: false; error: string; output: string }> {
  return withUpstreamEnv(up, ssh, async (base) => {
    const env = { ...base, GIT_OBJECT_DIRECTORY: objects.dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.alternates };
    const specs = updates.map((u) => `${u.new}:${u.ref}`);
    const r = await runGit(["push", "--atomic", "--porcelain", "--no-verify", "--no-signed", "--no-follow-tags", "--no-recurse-submodules", "--", up.url, ...specs], cache, env, timeoutMs, signal);
    const output = redactCredentials(shownOutput(`${r.stdout}\n${r.stderr}`));
    if (r.code === 0) return { ok: true, output };
    const rejected = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("!"))
      .map((l) => l.split("\t").slice(2).join(" ").trim())
      .filter(Boolean);
    return { ok: false, error: rejected.length > 0 ? `the remote refused it (${redactCredentials(rejected.join("; "))})` : gitError(r, "the push to the remote failed"), output };
  });
}

/** Whether `old` is an ancestor of `next` in the cache, with the pushed objects in reach. */
export async function isAncestor(cache: string, old: string, next: string, objects: { dir: string; alternates: string }): Promise<boolean> {
  const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OBJECT_DIRECTORY: objects.dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.alternates };
  const r = await runGit(["merge-base", "--is-ancestor", old, next], cache, env, 30_000);
  return r.code === 0;
}

/** Probe `up` with `git ls-remote` (the connect check). */
export function lsRemote(up: Upstream, ssh: string | null): Promise<GitResult> {
  return withUpstreamEnv(up, ssh, (env) => runGit(["ls-remote", "--heads", "--", up.url], "/", env, 60_000));
}
