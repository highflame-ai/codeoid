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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  /** The gateway's private dir for a run's credential and ssh config files (never in a sandbox). */
  runDir?: string;
  /** For ssh: the ssh config codeoid writes from the connection's snapshot (ssh-snapshot.ts); absent: an empty one. */
  sshConfig?: string;
  /** Tests only: a local bare repository as the remote (`file://`), which a real one never is. */
  testFile?: boolean;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Its output went past the cap: what was read is only part of it. */
  truncated?: boolean;
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
  // What a fetch brings is always kept as a pack (never loose): an interrupted one shows as a new pack.
  ["fetch.unpackLimit", "1"],
  // A transfer slower than 1 KB/s for a minute ends (a stalled remote holds its cache's lock).
  ["http.lowSpeedLimit", "1000"],
  ["http.lowSpeedTime", "60"],
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
  let credFile: string | null = null;
  let sshFile: string | null = null;
  if (up.kind === "ssh" && ssh) {
    // Never the owner's ssh config, nor the system's: only what codeoid writes (the connection's snapshot, as data).
    if (!up.runDir) throw new Error("no private dir for the ssh config");
    mkdirSync(up.runDir, { recursive: true, mode: 0o700 });
    sshFile = join(up.runDir, `${randomBytes(12).toString("hex")}.ssh_config`);
    // ssh hands a jump host's ssh `-F <path>` through /bin/sh unquoted: a path it can't split wrong, or no jump.
    if (/^\s*ProxyJump /m.test(up.sshConfig ?? "") && !/^[A-Za-z0-9._/-]+$/.test(`${sshFile}${ssh}`)) throw new Error(`a jump host can't be used from ${up.runDir} (ssh would split its path): move codeoid's config dir to a plain path`);
    writeFileSync(sshFile, up.sshConfig ?? "Host *\n  BatchMode yes\n  ConnectTimeout 20\n", { mode: 0o600 });
    // A remote that stops answering is given up on (a first clone holds its remote's lock meanwhile).
    entries.push(["core.sshCommand", `${ssh} -F ${sh(sshFile)} -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4`]);
  }
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
    if (sshFile) rmSync(sshFile, { force: true });
  }
}

/** git, its whole process group killed at the limit or the signal; output capped. */
// paths: git run in the daemon's own gateway dirs (a cache repository), with the gateway's env only
export function runGit(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal, maxOutput = 1024 * 1024): Promise<GitResult> {
  return new Promise((done) => {
    if (signal?.aborted) return done({ code: null, stdout: "", stderr: "stopped", timedOut: false });
    const child = spawn(GIT_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const cap = (s: string, d: Buffer) => {
      if (s.length > maxOutput) {
        truncated = true;
        return s;
      }
      return s + d.toString("utf8");
    };
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
      done({ code, stdout, stderr, timedOut, ...(truncated ? { truncated } : {}) });
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
  // The gateway's own paths (its cache) aren't the agent's to read about.
  const lines = shownOutput(r.stderr.replace(/\/[^\s'"]*\/git-gateway\/[^\s'"]*/g, "<codeoid's cache>"))
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
  /** Its branches (names after `refs/heads/`), when it said. */
  heads: ReadonlySet<string>;
}

/**
 * Bring the daemon's cache of `up` (a bare repository) to what the remote has: its branches and tags, pruned. Made
 * by a bare clone the first time (which takes the remote's object format). Says what it learned of the remote.
 */
// paths: the daemon's own cache repository, (re)made by a clone into a temp dir renamed into place
export async function refreshCache(cache: string, up: Upstream, ssh: string | null, timeoutMs: number, signal?: AbortSignal, cloneSignal?: AbortSignal): Promise<RemoteState | { error: string }> {
  return withUpstreamEnv(up, ssh, async (base) => {
    // Every cache git on that git dir exactly: never one git finds by walking up (a dotfiles repository above).
    const env = cacheEnv(base, cache);
    sweepLocks(cache);
    if (!(await isRepo(cache, env))) {
      rmSync(cache, { recursive: true, force: true });
      const tmp = `${cache}.tmp-${randomBytes(6).toString("hex")}`;
      // The first clone of a large repository can outlast an agent's git (a tool's time limit): it isn't cut short when
      // that git goes, and has a limit of its own, so a later request finds the cache made.
      const r = await runGit(["clone", "--bare", "--quiet", "--no-tags", "--", up.url, tmp], dirname(cache), { ...base, GIT_CEILING_DIRECTORIES: dirname(cache) }, Math.max(timeoutMs, FIRST_CLONE_MS), cloneSignal);
      if (r.code !== 0) {
        rmSync(tmp, { recursive: true, force: true });
        return { error: gitError(r, "the remote couldn't be fetched") };
      }
      renameSync(tmp, cache);
      // A fresh clone holds only what its refs reach: what it has seen starts here.
      await rememberRefs(cache, true);
    }
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1_000, deadline - Date.now());
    // Every ref the cache has had is remembered (on disk) before the fetch can drop one, however this refresh ends
    // (a fetch that prunes and then fails, an agent gone mid-way, a restart): `cacheDirty` judges from that record.
    if (!(await rememberRefs(cache, false))) return { error: "codeoid couldn't read its copy of the remote" };
    // Unsettled until what it fetched is recorded: a fetch cut short (killed, a crash) that stored objects under no
    // ref leaves the mark, and the cache is pruned.
    const mark = `refresh-${randomBytes(6).toString("hex")}`;
    markUnsettled(cache, mark);
    const fetchArgs = ["fetch", "--quiet", "--prune", "--prune-tags", "--no-write-fetch-head", "--", up.url, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
    let f = await runGit(fetchArgs, cache, env, left(), signal);
    // A ref lock another git held a moment (a stale one a killed git left is swept): tried once more.
    if (f.code !== 0 && /cannot lock ref|unable to (?:update|lock)|Unable to create '.*\.lock'/i.test(f.stderr)) {
      sweepLocks(cache);
      f = await runGit(fetchArgs, cache, env, left(), signal);
    }
    if (f.code !== 0) return { error: gitError(f, "the remote couldn't be fetched") };
    if (await rememberRefs(cache, false)) settle(cache, mark);
    // Every branch with its symref target, and HEAD (protocol v2's ls-refs symrefs).
    const h = await runGit(["ls-remote", "--symref", "--", up.url, "HEAD", "refs/heads/*"], cache, env, Math.min(left(), 60_000), signal, 256 * 1024 * 1024);
    const symrefs = new Set<string>();
    let defaultBranch: string | null = null;
    let heads = 0;
    const names = new Set<string>();
    if (h.code === 0) {
      for (const line of h.stdout.split("\n")) {
        const sym = /^ref: (refs\/heads\/\S+)\t(\S+)$/.exec(line);
        if (sym?.[1] && sym[2] === "HEAD") defaultBranch = sym[1].slice("refs/heads/".length);
        else if (sym?.[2]?.startsWith("refs/heads/")) symrefs.add(sym[2]);
        else {
          const head = /^[0-9a-f]{40,64}\trefs\/heads\/(\S+)$/.exec(line);
          if (head?.[1]) {
            heads++;
            names.add(head[1]);
          }
        }
      }
    }
    if (defaultBranch) await runGit(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], cache, env, 10_000, signal);
    // Branches, but no HEAD said (an unborn one: renamed or deleted): which branch would become the default isn't known.
    // A list cut short says too little (its branches, symrefs): nothing is known of it.
    const defaultKnown = h.code === 0 && !h.truncated && (defaultBranch !== null || heads === 0);
    return { defaultBranch, defaultKnown, symrefs, empty: h.code === 0 && heads === 0, heads: names };
  });
}

/**
 * Drop from the cache every object no ref reaches (what the remote deleted): a full repack and a prune. Run only with
 * no request served on it (the gateway waits for them), under its lock. True when done.
 */
// paths: the daemon's own cache repository, repacked and pruned
export async function pruneCache(cache: string, activeMarks: ReadonlySet<string> = new Set()): Promise<boolean> {
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" }, cache);
  // A pack a killed fetch left kept (`.keep`) would be kept whole by the repack: nothing runs on the cache now.
  const packs = join(cache, "objects", "pack");
  try {
    for (const n of readdirSync(packs)) if (n.endsWith(".keep")) rmSync(join(packs, n), { force: true });
  } catch {
    /* no packs */
  }
  const repack = await runGit(["-c", "pack.writeBitmapHashCache=true", "repack", "-a", "-d", "-q", "-b"], cache, env, 60 * 60_000);
  if (repack.code !== 0) return false;
  const prune = await runGit(["prune", "--expire=now"], cache, env, 30 * 60_000);
  if (prune.code !== 0) return false;
  // Nothing that names a pruned object stays (a commit graph, a multi-pack index).
  for (const f of ["objects/info/commit-graph", "objects/info/commit-graphs", "objects/pack/multi-pack-index"]) rmSync(join(cache, f), { recursive: true, force: true });
  for (const n of readdirSync(cache)) if (n.startsWith("codeoid-unsettled-") && !activeMarks.has(n.slice("codeoid-unsettled-".length))) rmSync(join(cache, n), { force: true });
  return rememberRefs(cache, true);
}

/** Where a cache records every ref id it has had since it was last pruned (`cacheDirty` judges from it). */
function seenFile(cache: string): string {
  return join(cache, "codeoid-refs-seen");
}

/** The ids every ref of the cache names now (branches, tags, a push's check refs), or null. */
async function refOids(cache: string): Promise<Set<string> | null> {
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, cache);
  const r = await runGit(["for-each-ref", "--format=%(objectname)"], cache, env, 60_000, undefined, 256 * 1024 * 1024);
  return r.code === 0 && !r.truncated ? new Set(r.stdout.split("\n").filter(Boolean)) : null;
}

/** Add the refs' ids now to what the cache has seen (`fresh`: start over from them). False: they couldn't be read. */
// paths: the daemon's own cache repository: its record of refs seen, written (0600)
export async function rememberRefs(cache: string, fresh: boolean, forget: readonly string[] = []): Promise<boolean> {
  return serialized(cache, async () => {
    const now = await refOids(cache);
    if (!now) return false;
    const seen = fresh ? new Set<string>() : readSeen(cache);
    if (seen === null) return false;
    for (const o of forget) if (!now.has(o)) seen.delete(o);
    for (const o of now) seen.add(o);
    return writeSeen(cache, seen);
  });
}

const seenWrites = new Map<string, Promise<unknown>>();

/** One record update at a time per cache (a check fetch's ids are never lost to a concurrent rewrite). */
function serialized<T>(cache: string, fn: () => Promise<T>): Promise<T> {
  const prev = seenWrites.get(cache) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  seenWrites.set(
    cache,
    next.catch(() => {}),
  );
  return next;
}

/** Write the record whole or not at all. */
// paths: the daemon's own cache repository: its record of refs seen, written (0600) by rename
function writeSeen(cache: string, seen: ReadonlySet<string>): boolean {
  // A crash or a full disk mid-write leaves the old record.
  const tmp = `${seenFile(cache)}.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, `${[...seen].join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, seenFile(cache));
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
  return true;
}

/** The cache's pack files now. */
function packsOf(cache: string): string[] {
  try {
    return readdirSync(join(cache, "objects", "pack")).filter((n) => n.endsWith(".pack")).sort();
  } catch {
    return [];
  }
}

/** How many loose objects the cache holds (a dumb-HTTP fetch stores what it brings loose). */
function looseCount(cache: string): number {
  let n = 0;
  try {
    for (const d of readdirSync(join(cache, "objects"))) if (/^[0-9a-f]{2}$/.test(d)) n += readdirSync(join(cache, "objects", d)).length;
  } catch {
    /* none */
  }
  return n;
}

/** Mark an operation that stores objects as under way (`id`), with the packs and the loose count before it. */
// paths: the daemon's own cache repository: a mark file, written (0600)
export function markUnsettled(cache: string, id: string): void {
  writeFileSync(join(cache, `codeoid-unsettled-${id}`), `loose:${looseCount(cache)}\n${packsOf(cache).join("\n")}\n`, { mode: 0o600 });
}

/** The operation `id` recorded what it stored. */
// paths: the daemon's own cache repository: a mark file, removed
export function settle(cache: string, id: string): void {
  rmSync(join(cache, `codeoid-unsettled-${id}`), { force: true });
}

/**
 * Whether an operation that stored objects ended before recording them (a mark left that isn't `active`'s) with a pack
 * it brought still there: those objects may be under no ref, and no record names them. One that brought nothing is
 * settled here.
 */
// paths: the daemon's own cache repository: its mark files, read and removed
function unsettledLeft(cache: string, active: ReadonlySet<string>): boolean {
  let names: string[] = [];
  try {
    names = readdirSync(cache).filter((n) => n.startsWith("codeoid-unsettled-"));
  } catch {
    return false;
  }
  const packs = packsOf(cache);
  const loose = looseCount(cache);
  let left = false;
  for (const n of names) {
    const id = n.slice("codeoid-unsettled-".length);
    if (active.has(id)) continue;
    let before: Set<string>;
    let looseBefore = Number.POSITIVE_INFINITY;
    try {
      const lines = readFileSync(join(cache, n), "utf8").split("\n").filter(Boolean);
      looseBefore = Number(/^loose:(\d+)$/.exec(lines[0] ?? "")?.[1] ?? Number.NaN);
      before = new Set(lines.slice(1));
    } catch {
      left = true;
      continue;
    }
    if (packs.some((p) => !before.has(p)) || !(loose <= looseBefore)) left = true;
    else rmSync(join(cache, n), { force: true });
  }
  return left;
}

/** The ids of the cache's branches and tags (what upload-pack advertises), and their names. */
async function advertised(cache: string): Promise<{ oids: string[]; names: Set<string> } | null> {
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, cache);
  const r = await runGit(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/tags/"], cache, env, 60_000, undefined, 256 * 1024 * 1024);
  if (r.code !== 0 || r.truncated) return null;
  const oids = new Set<string>();
  const names = new Set<string>();
  for (const l of r.stdout.split("\n")) {
    const sp = l.indexOf(" ");
    if (sp <= 0) continue;
    oids.add(l.slice(0, sp));
    names.add(l.slice(sp + 1));
  }
  return { oids: [...oids], names };
}

/** The cache's branch and tag names (a `deepen-not` must name one). */
export async function advertisedNames(cache: string): Promise<Set<string>> {
  return (await advertised(cache))?.names ?? new Set();
}

/** Which of `ids` the cache's branches and tags reach (an error: none). */
// paths: git cat-file and rev-list on the daemon's cache, read only
export async function reachedFromRefs(cache: string, ids: readonly string[]): Promise<Set<string>> {
  const present = await cacheHas(cache, [...new Set(ids)]);
  if ("error" in present || present.length === 0) return new Set();
  const refs = await advertised(cache);
  if (!refs) return new Set();
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" }, cache);
  const r = await gitLines(["rev-list", "--objects", "--no-object-names", "--stdin"], cache, env, [...present, ...refs.oids.map((o) => `^${o}`)], 60_000);
  if ("error" in r) return new Set();
  const unreached = new Set(r.lines);
  return new Set(present.filter((id) => !unreached.has(id)));
}

/** Remove the check refs of pushes no longer running (a daemon stopped mid-check left them). */
// paths: the daemon's own cache repository: stale refs in its private check namespace, removed
export async function sweepCheckRefs(cache: string, active: ReadonlySet<string>): Promise<void> {
  if (!existsSync(cache)) return;
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, cache);
  const r = await runGit(["for-each-ref", "--format=%(refname)", "refs/codeoid-check/"], cache, env, 30_000, undefined, 64 * 1024 * 1024);
  if (r.code !== 0) return;
  const stale = r.stdout.split("\n").filter((n) => n && !active.has(n.split("/")[2] ?? ""));
  if (stale.length > 0) await gitLines(["update-ref", "--stdin"], cache, env, stale.map((n) => `delete ${n}`), 30_000);
}

/** What the cache has seen, or null when the record is missing (a cache older than it: judged dirty once). */
function readSeen(cache: string): Set<string> | null {
  try {
    return new Set(readFileSync(seenFile(cache), "utf8").split("\n").filter((l) => /^[0-9a-f]{40,64}$/.test(l)));
  } catch {
    return existsSync(cache) ? null : new Set();
  }
}

/**
 * Whether the cache holds objects no ref reaches now that a ref it had reached (the remote deleted a branch or
 * rewrote one): it must be pruned before anything more is served from it. Unknown (a record missing, an error): true.
 */
export async function cacheDirty(cache: string, active: ReadonlySet<string> = new Set()): Promise<boolean> {
  if (!existsSync(cache)) return false;
  if (unsettledLeft(cache, active)) return true;
  const seen = readSeen(cache);
  const now = await refOids(cache);
  if (!seen || !now) return true;
  const dropped = [...seen].filter((o) => !now.has(o));
  if (dropped.length === 0) return false;
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" }, cache);
  // An id it no longer has at all (gone already) reaches nothing: only those still there are walked.
  const present = await cacheHas(cache, dropped);
  if ("error" in present) return true;
  if (present.length === 0) {
    await rememberRefs(cache, false, dropped);
    return false;
  }
  const r = await gitLines(["rev-list", "--objects", "--no-object-names", "--stdin"], cache, env, [...present, ...[...now].map((o) => `^${o}`)], 120_000, () => true);
  if ("error" in r) return true;
  if (r.stopped) return true;
  // The dropped refs reach nothing the others don't (a merged branch deleted): nothing to prune; those ids are let go.
  await rememberRefs(cache, false, dropped);
  return false;
}

/**
 * Fetch the remote's refs `names` (as it has them now) into the cache under `refs/codeoid-check/<ns>/` (a push's
 * last check judges against them; removed after). Remembered as seen. Why not, or null.
 */
// paths: the daemon's own cache repository: refs under its private check namespace, written
export async function fetchCheckRefs(cache: string, up: Upstream, ssh: string | null, ns: string, names: readonly string[]): Promise<string | null> {
  if (names.length === 0) return null;
  return withUpstreamEnv(up, ssh, async (base) => {
    const env = cacheEnv(base, cache);
    const specs = names.map((n) => `+${n}:refs/codeoid-check/${ns}/${n.replace(/^refs\//, "")}`);
    markUnsettled(cache, ns);
    const r = await runGit(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", up.url, ...specs], cache, env, 120_000);
    if (r.code !== 0) return gitError(r, "the remote couldn't be fetched again before the push");
    if (!(await rememberRefs(cache, false))) return "codeoid couldn't read its copy of the remote";
    settle(cache, ns);
    return null;
  });
}

/** Remove a push's check refs. */
// paths: the daemon's own cache repository: its private check refs, removed
export async function dropCheckRefs(cache: string, ns: string): Promise<void> {
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, cache);
  const r = await runGit(["for-each-ref", "--format=delete %(refname)", `refs/codeoid-check/${ns}/`], cache, env, 30_000);
  if (r.code !== 0 || !r.stdout.trim()) return;
  await gitLines(["update-ref", "--stdin"], cache, env, r.stdout.split("\n").filter(Boolean), 30_000);
}

/** The remote's branches and tags as it says them now (`ls-remote`): each id and name, or why not. */
export async function remoteRefs(up: Upstream, ssh: string | null): Promise<Array<{ oid: string; name: string }> | { error: string }> {
  return withUpstreamEnv(up, ssh, async (env) => {
    const r = await runGit(["ls-remote", "--refs", "--", up.url, "refs/heads/*", "refs/tags/*"], "/", env, 60_000, undefined, 256 * 1024 * 1024);
    if (r.code !== 0 || r.truncated) return { error: gitError(r, "the remote couldn't be asked what it has") };
    const out: Array<{ oid: string; name: string }> = [];
    for (const l of r.stdout.split("\n")) {
      const m = /^([0-9a-f]{40,64})\t(refs\/(?:heads|tags)\/[^\s]+)$/.exec(l);
      if (m?.[1] && m[2]) out.push({ oid: m[1], name: m[2] });
    }
    return out;
  });
}

/** Which of `ids` the cache holds (its own store), for a rev-list that names them. */
export async function cacheHas(cache: string, ids: readonly string[]): Promise<string[] | { error: string }> {
  if (ids.length === 0) return [];
  const env = { ...cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, cache), GIT_OBJECT_DIRECTORY: join(cache, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };
  const r = await gitLines(["cat-file", "--batch-check=%(objectname) %(objecttype)"], cache, env, ids, 60_000);
  if ("error" in r) return r;
  return r.lines.filter((l) => !l.endsWith(" missing")).map((l) => l.split(" ")[0] ?? "");
}

/** The first clone's own limit (it isn't tied to any one agent's git). */
const FIRST_CLONE_MS = 60 * 60_000;

/**
 * Why a push can't take its objects as they are: an object its new tips need past what the remote's refs (the cache's,
 * just refreshed) reach at their edges, that the cache's own store already holds and that no ref reaches. The cache
 * keeps objects the remote has since deleted; a push naming one, or a thin pack whose delta base is one (git's
 * `--fix-thin` copies the base from the cache into the push), would publish it again and hand it to the agent.
 * Objects the push brought that the cache doesn't hold are new, and fine; one the cache holds that a ref reaches
 * (a revert's older blob, a thin pack's base, what a bitmap client left out) is the remote's, and fine. Null: it can go.
 */
// paths: git rev-list and cat-file on the daemon's cache and the push's quarantine, read only
export async function objectsNotSent(cache: string, objects: { dir: string; alternates: string }, tips: readonly string[], refs?: readonly string[]): Promise<string | null> {
  const base = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" };
  const withPush = { ...cacheEnv(base, cache), GIT_OBJECT_DIRECTORY: objects.dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.alternates };
  // The cache's own store alone (never the quarantine, which is apart from it).
  const kept = { ...cacheEnv(base, cache), GIT_OBJECT_DIRECTORY: join(cache, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };
  const deadline = Date.now() + 120_000;
  const left = () => Math.max(1_000, deadline - Date.now());
  // Against the cache's refs, or (just before the upstream push) the remote's own refs as it says them now.
  const candidates = refs
    ? await gitLines(["rev-list", "--objects", "--no-object-names", "--stdin"], cache, withPush, [...tips, ...refs.map((r) => `^${r}`)], left())
    : await gitLines(["rev-list", "--objects", "--no-object-names", ...tips, "--not", "--all"], cache, withPush, null, left());
  if ("error" in candidates) return candidates.error;
  // And everything in the push itself: a thin pack's delta bases are copied in from the cache (`--fix-thin`), and an
  // object built on a deleted one would carry its content out.
  const sent = await gitLines(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], cache, { ...cacheEnv(base, cache), GIT_OBJECT_DIRECTORY: objects.dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" }, null, left());
  if ("error" in sent) return sent.error;
  const all = [...new Set([...candidates.lines, ...sent.lines])];
  if (all.length === 0) return null;
  // What the push brought that its new tips don't use and the cache didn't hold: kept in the shared cache, used by
  // nothing, it isn't codeoid's to keep (it would turn another session's push of that content into a refusal).
  const used = new Set(candidates.lines);
  const check = await gitLines(["cat-file", "--batch-check=%(objectname) %(objecttype)"], cache, kept, all, left());
  if ("error" in check) return check.error;
  const suspects = new Set(check.lines.filter((l) => !l.endsWith(" missing")).map((l) => l.split(" ")[0] ?? ""));
  const unused = sent.lines.find((id) => !used.has(id) && !suspects.has(id));
  if (unused) return "the push carries an object its branches don't use: push only what the branches hold";
  if (suspects.size === 0) return null;
  // Each must be reached by one of the remote's refs.
  const reached = await gitLines(refs ? ["rev-list", "--objects", "--no-object-names", "--stdin"] : ["rev-list", "--objects", "--no-object-names", "--use-bitmap-index", "--all"], cache, kept, refs ? [...refs] : null, left(), (id) => {
    suspects.delete(id);
    return suspects.size === 0;
  });
  if ("error" in reached && suspects.size > 0) return reached.error;
  const first = [...suspects][0];
  return first
    ? "the push holds something that isn't on the remote's branches or tags and that the remote deleted: codeoid doesn't publish it again (if it is your own earlier work, the owner can disconnect the remote and connect it again)"
    : null;
}

/**
 * A git's output lines (its input `input`'s lines, if any), or why not; `each` may end it early (true: enough). Its
 * process group is killed at the limit or the end.
 */
function gitLines(args: string[], cwd: string, env: Record<string, string>, input: readonly string[] | null, timeoutMs: number, each?: (line: string) => boolean): Promise<{ lines: string[]; stopped?: boolean } | { error: string }> {
  return new Promise((done) => {
    const p = spawn(GIT_BIN, args, { cwd, env, stdio: [input ? "pipe" : "ignore", "pipe", "ignore"], detached: true });
    const lines: string[] = [];
    let buf = "";
    let settled = false;
    const finish = (r: { lines: string[]; stopped?: boolean } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      done(r);
    };
    const timer = setTimeout(() => finish({ error: "the push's objects couldn't be checked in time" }), timeoutMs);
    const take = (l: string) => {
      if (!l) return;
      if (each) {
        if (each(l)) finish({ lines: [], stopped: true });
      } else if (lines.push(l) > 5_000_000) finish({ error: "the push needs more objects than codeoid checks" });
    };
    p.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.lastIndexOf("\n");
      if (nl < 0) return;
      for (const l of buf.slice(0, nl).split("\n")) take(l);
      buf = buf.slice(nl + 1);
    });
    p.on("close", (code) => {
      take(buf.trim());
      if (settled) return;
      finish(code === 0 ? { lines } : { error: "the push's objects couldn't be checked" });
    });
    p.on("error", () => finish({ error: "the push's objects couldn't be checked" }));
    if (input && p.stdin) {
      p.stdin.on("error", () => {});
      p.stdin.end(input.length > 0 ? `${input.join("\n")}\n` : "");
    }
  });
}

/** Remove ref locks (`*.lock` under refs/, `packed-refs.lock`) a killed git left, a few minutes old or more. */
// paths: the daemon's own cache repository: its stale lock files, removed
function sweepLocks(cache: string): void {
  const stale = (p: string) => {
    try {
      if (Date.now() - lstatSync(p).mtimeMs > 5 * 60_000) rmSync(p, { force: true });
    } catch {
      /* gone */
    }
  };
  stale(join(cache, "packed-refs.lock"));
  stale(join(cache, "HEAD.lock"));
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (n.endsWith(".lock")) stale(p);
      else {
        try {
          if (lstatSync(p).isDirectory()) walk(p, depth + 1);
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(join(cache, "refs"), 0);
}

/** A git env bound to the cache repository `cache` exactly (`GIT_DIR`), git's discovery stopped at its dir. */
export function cacheEnv(env: Record<string, string>, cache: string): Record<string, string> {
  return { ...env, GIT_DIR: cache, GIT_CEILING_DIRECTORIES: dirname(cache) };
}

/** Whether `cache` is a bare repository git takes (a clone cut short leaves a dir that isn't). */
async function isRepo(cache: string, env: Record<string, string>): Promise<boolean> {
  if (!existsSync(cache)) return false;
  const r = await runGit(["rev-parse", "--is-bare-repository"], cache, env, 10_000);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** What the cache (just refreshed) has for `ref`: its id, or the zero id of `like`'s length when it has none. */
export async function cacheRef(cache: string, ref: string, like: string): Promise<string> {
  const env = cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, cache);
  // That ref exactly (no DWIM: a tag named `refs/heads/x` isn't the branch x).
  const r = await runGit(["show-ref", "--verify", "--hash", "--", ref], cache, env, 10_000);
  const oid = r.code === 0 ? r.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(oid) ? oid : "0".repeat(like.length === 64 ? 64 : 40);
}

/**
 * Push the checked updates to the remote, from the cache with the pushed objects in its quarantine (`objects`: the
 * quarantine and the cache's own objects). Atomic: all or none. Resolves with what to tell the agent.
 */
export async function pushUpstream(
  cache: string,
  up: Upstream,
  ssh: string | null,
  updates: ReadonlyArray<{ old: string; new: string; ref: string }>,
  objects: { dir: string; alternates: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: true; output: string } | { ok: false; error: string; output: string }> {
  return withUpstreamEnv(up, ssh, async (base) => {
    const env = { ...cacheEnv(base, cache), GIT_OBJECT_DIRECTORY: objects.dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.alternates };
    // Built from names the policy judged (validBranchRef: nothing a refspec reads as a split or a pattern).
    for (const u of updates) if (!/^refs\/heads\/[^:]+$/.test(u.ref) || !/^[0-9a-f]{40,64}$/.test(u.new)) return { ok: false as const, error: "codeoid refused it: not a branch update", output: "" };
    const specs = updates.map((u) => `${u.new}:${u.ref}`);
    // The remote moves only from exactly what was checked: each branch where the gateway saw it (none, for a new one).
    const leases = updates.map((u) => `--force-with-lease=${u.ref}:${/^0+$/.test(u.old) ? "" : u.old}`);
    // Atomic only when it means something (a remote that doesn't offer it refuses an atomic push outright).
    const r = await runGit(["push", ...(specs.length > 1 ? ["--atomic"] : []), "--porcelain", "--no-verify", "--no-signed", "--no-follow-tags", "--no-recurse-submodules", ...leases, "--", up.url, ...specs], cache, env, timeoutMs, signal);
    const output = redactCredentials(shownOutput(`${r.stdout}\n${r.stderr}`));
    if (r.code === 0) {
      // Every ref the remote reports updated is one that was judged (a belt to the refspecs' braces).
      const judged = new Set(updates.map((u) => u.ref));
      const moved = r.stdout.split("\n").filter((l) => /^[ *+=-]\t/.test(l)).map((l) => l.split("\t")[1]?.split(":")[1] ?? "");
      if (moved.some((ref) => !judged.has(ref))) return { ok: false, error: "the remote reported a ref codeoid didn't check", output };
      return { ok: true, output };
    }
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
  const env = {
    ...cacheEnv({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" }, cache),
    GIT_OBJECT_DIRECTORY: objects.dir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.alternates,
  };
  const r = await runGit(["merge-base", "--is-ancestor", old, next], cache, env, 30_000);
  return r.code === 0;
}

/** Probe `up` with `git ls-remote` (the connect check). */
export function lsRemote(up: Upstream, ssh: string | null): Promise<GitResult> {
  return withUpstreamEnv(up, ssh, (env) => runGit(["ls-remote", "--heads", "--", up.url], "/", env, 60_000));
}
