/**
 * Connecting a remote for the git gateway (docs/git-gateway-design.md §3.5): the owner's word that agents in their
 * sandboxed sessions may fetch and push there with the owner's existing credential, proved to work first.
 *
 * - ssh: the system ssh with the owner's key, agent and `~/.ssh/config`; nothing is stored.
 * - https: the owner's credential read once, now, with `git credential fill` (their own helpers, at their request),
 *   or a dedicated token they hand in; kept in a 0600 file of the daemon's, sent to that remote's origin only.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { physicalPath, within } from "../physical-path.js";

import { GIT_BIN } from "../git-env.js";
import { hostPathProblem } from "./hostpath.js";
import { resolveSshSnapshot, type SshSnapshot, snapshotProblem, sshConfigSources, sshConfigText } from "./ssh-snapshot.js";
import { remoteUrlProblem } from "./text.js";
import { gitError, type HttpsCredential, lsRemote, runGit, systemSsh, type Upstream, type UpstreamKind, upstreamKind } from "./upstream.js";

function physicalPathOr(p: string): string {
  try {
    return physicalPath(p);
  } catch {
    return p;
  }
}

/** How a connection authenticates. */
export type ConnectionAuth = "ssh" | "git-credential" | "token";

export interface GitConnection {
  owner: string;
  url: string;
  kind: UpstreamKind;
  auth: ConnectionAuth;
  connectedBy: string;
  connectedAt: number;
}

/** A connection's id: one per owner and URL. */
export function connectionId(owner: string, url: string): string {
  return createHash("sha256").update(`${owner}\0${url}`).digest("hex");
}

/** The https credentials of connections, in a 0600 file of the daemon's (as accounts.json is). */
export class GitCredentials {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }
  // paths: the daemon's own credentials file (0600), read
  #read(): Record<string, HttpsCredential> {
    try {
      return existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, HttpsCredential>) : {};
    } catch {
      return {};
    }
  }
  // paths: the daemon's own credentials file, written 0600 and replaced atomically
  #write(all: Record<string, HttpsCredential>): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const part = `${this.#file}.${process.pid}.part`;
    writeFileSync(part, `${JSON.stringify(all)}\n`, { mode: 0o600 });
    renameSync(part, this.#file);
  }
  get(id: string): HttpsCredential | undefined {
    return this.#read()[id];
  }
  set(id: string, cred: HttpsCredential): void {
    this.#write({ ...this.#read(), [id]: cred });
  }
  remove(id: string): void {
    const all = this.#read();
    if (!(id in all)) return;
    delete all[id];
    this.#write(all);
  }
}

/** A dedicated token as a credential: `user:token`, or a token with the forge's usual name for it. */
export function tokenCredential(url: string, token: string): HttpsCredential {
  const t = token.trim();
  const i = t.indexOf(":");
  if (i > 0) return { username: t.slice(0, i), password: t.slice(i + 1) };
  const host = new URL(url).hostname.toLowerCase();
  const username = host === "bitbucket.org" ? "x-token-auth" : host === "github.com" ? "x-access-token" : host.includes("gitlab") ? "oauth2" : "git";
  return { username, password: t };
}

/**
 * The environment `git credential fill` runs in: the owner's own, for their helpers (keychains, a desktop's secret
 * service), but nothing that points git at a repository or adds config: no `GIT_*` of the daemon's.
 */
function ownerHelperEnv(): Record<string, string> {
  const keep = /^(HOME|PATH|USER|LOGNAME|LANG|LC_[A-Z]+|TMPDIR|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|SSH_AUTH_SOCK|GNUPGHOME|PASSWORD_STORE_DIR)$/;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: "/" };
}

/**
 * The credential helpers codeoid lets `git credential fill` run: the well-known ones git ships or the platforms
 * provide, by name (each a `git-credential-<name>` program in the system's dirs). Never a shell (`!…`), a path, or
 * a helper of some other name: those are refused (connect with a token instead).
 */
const NAMED_HELPER = /^(?:osxkeychain|libsecret|gnome-keyring|wincred|manager|manager-core)$/;

/**
 * The helper line codeoid writes for one of the owner's (git runs a helper through the shell, so the owner's own
 * text is never passed on): a name on the list, `cache [--timeout N]`, or `store [--file <path>]` with a plain
 * absolute path, which codeoid quotes. Else why not.
 */
export function safeHelper(raw: string, home: string): { line: string; file?: string } | { error: string } {
  const h = raw.trim();
  if (NAMED_HELPER.test(h)) return { line: h };
  const cache = /^cache(?: --timeout(?:=| +)(\d{1,9}))?$/.exec(h);
  if (cache) return { line: cache[1] ? `cache --timeout ${cache[1]}` : "cache" };
  const store = /^store(?: --file(?:=| +)(.+))?$/.exec(h);
  if (store) {
    if (!store[1]) return { line: "store" };
    const named = store[1].startsWith("~/") ? join(home, store[1].slice(2)) : store[1];
    if (!/^\/[A-Za-z0-9._/@+-]+$/.test(named)) return { error: `your credential store file ${JSON.stringify(store[1].slice(0, 60))} isn't a plain absolute path` };
    return { line: `store --file '${named}'`, file: named };
  }
  return { error: `your credential helper ${JSON.stringify(h.slice(0, 60))} isn't one codeoid runs for agents (only git's and the platforms' own)` };
}

/**
 * Whether a `credential.<pattern>.*` key applies to `u`, as git's urlmatch decides: the same scheme, host (a `*`
 * matches one label) and port, no user in the pattern but the URL's, and a path that is the URL's or a parent of it
 * at a `/`. A pattern that isn't a URL applies to nothing (fail closed: no credential, rather than another's).
 */
export function credentialUrlMatches(pattern: string, u: URL): boolean {
  let p: URL;
  try {
    p = new URL(pattern);
  } catch {
    return false;
  }
  if (p.protocol !== u.protocol || p.port !== u.port || p.password) return false;
  if (p.username && p.username !== u.username) return false;
  const pl = p.hostname.toLowerCase().split(".");
  const ul = u.hostname.toLowerCase().split(".");
  if (pl.length !== ul.length || pl.some((l, i) => l !== "*" && l !== ul[i])) return false;
  const pp = p.pathname.replace(/\/+$/, "");
  return pp === "" || u.pathname === pp || u.pathname.startsWith(`${pp}/`);
}

/** The owner's credential helpers for `url` (their global and system config, from `/`), in git's order. */
// paths: git config read from /, which runs nothing
function ownerHelpers(url: string): string[] {
  const u = new URL(url);
  const r = spawnSync(GIT_BIN, ["-C", "/", "config", "--null", "--get-regexp", "^credential\\.(.*\\.)?helper$"], { cwd: "/", env: ownerHelperEnv(), encoding: "utf8", timeout: 5_000 });
  const out: string[] = [];
  for (const entry of (r.status === 0 ? r.stdout : "").split("\0")) {
    const nl = entry.indexOf("\n");
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? "" : entry.slice(nl + 1);
    if (!key) continue;
    const sub = key.slice("credential.".length, -".helper".length).replace(/\.$/, "");
    // credential.helper, or credential.<url>.helper whose URL matches this one as git's urlmatch does.
    if (key !== "credential.helper" && !credentialUrlMatches(sub, u)) continue;
    out.push(value);
  }
  return out;
}

/**
 * The owner's own credential for an https URL, as their `git push` would find it, but with only the well-known
 * helpers their config names (safeHelper): `git credential fill` from `/`, its config a file codeoid writes with
 * those helpers alone, so nothing their config (or a file it includes) names otherwise is run.
 */
// paths: git credential fill from /, with a config codeoid writes (0600, in its own run dir), run for the owner at their request
export function fillGitCredential(url: string, o: { runDir: string; writable: readonly string[] }, timeoutMs = 60_000): Promise<HttpsCredential | { error: string }> {
  const u = new URL(url);
  // git reads the owner's config files (and their includes) for this: never one that isn't a plain file.
  if (!ownerConfigPlain()) return Promise.resolve({ error: "your git config, or a file it includes, isn't a plain file (a FIFO?), so codeoid doesn't read it: connect with --token" });
  const helpers = ownerHelpers(url);
  const usable: string[] = [];
  for (const h of helpers) {
    if (h === "") {
      usable.length = 0;
      continue;
    }
    const safe = safeHelper(h, process.env.HOME || homedir());
    if ("error" in safe) return Promise.resolve({ error: `${safe.error}: connect with --token` });
    if (safe.file) {
      const bad = hostPathProblem(safe.file, o.writable, undefined, { homeAllowed: true });
      if (bad) return Promise.resolve({ error: `your credential store file can't be used: ${bad}` });
    }
    if (safe.line.startsWith("cache")) {
      // git-credential-cache's socket: ~/.git-credential-cache, else $XDG_CACHE_HOME/git/credential. A session that
      // may write either could answer in its place.
      const home = process.env.HOME || homedir();
      for (const d of [join(home, ".git-credential-cache"), join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "git", "credential")]) {
        const bad = hostPathProblem(d, o.writable, undefined, { homeAllowed: true });
        if (bad) return Promise.resolve({ error: `your credential cache can't be used: ${bad}` });
      }
    }
    usable.push(safe.line);
  }
  if (usable.length === 0) return Promise.resolve({ error: `your git has no credential helper codeoid can use for ${u.host}: sign in with git once (a keychain, libsecret, the credential manager, store or cache), or connect with --token` });
  mkdirSync(o.runDir, { recursive: true, mode: 0o700 });
  const cfg = join(o.runDir, `${createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 16)}.gitconfig`);
  writeFileSync(cfg, `[credential]\n${usable.map((h) => `\thelper = ${h}\n`).join("")}`, { mode: 0o600 });
  return new Promise((done) => {
    // git finds a helper by name in its exec path, then PATH: only PATH dirs no session may write.
    const base = ownerHelperEnv();
    const path = (base.PATH ?? "/usr/bin:/bin")
      .split(":")
      .filter((d) => isAbsolute(d) && !hostPathProblem(d, o.writable, undefined, { homeAllowed: true }))
      .join(":");
    const env = { ...base, PATH: path || "/usr/bin:/bin", GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" };
    const p = spawn(GIT_BIN, ["-C", "/", "--no-pager", "credential", "fill"], { cwd: "/", env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const finish = (r: HttpsCredential | { error: string }) => {
      clearTimeout(timer);
      rmSync(cfg, { force: true });
      done(r);
    };
    p.on("close", (code) => {
      const field = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1];
      const username = field("username");
      const password = field("password");
      if (code === 0 && username && password) finish({ username, password });
      else finish({ error: `your git has no credential for ${u.host} (git credential fill found none): sign in with git once, or connect with --token` });
    });
    p.on("error", (err) => finish({ error: err.message }));
    p.stdin.end(`protocol=${u.protocol.replace(/:$/, "")}\nhost=${u.host}\n\n`);
  });
}

/** The owner's CA bundle for `url` (`http.sslCAInfo` by URL, or GIT_SSL_CAINFO), judged where it is: never a session's. */
// paths: git config read for the owner, from / (no repository)
async function ownerCaInfo(url: string, writable: readonly string[]): Promise<string | { error: string } | undefined> {
  const r = await runGit(["-C", "/", "config", "--get-urlmatch", "http.sslcainfo", url], "/", ownerHelperEnv(), 10_000);
  const v = process.env.GIT_SSL_CAINFO || (r.code === 0 ? r.stdout.trim() : "");
  if (!v) return undefined;
  const bad = hostPathProblem(v, writable, undefined, { homeAllowed: true });
  return bad ? { error: `your CA bundle ${v} can't be used: ${bad}` } : v;
}

/** The home OpenSSH uses (`getpwuid`'s, never `$HOME`): where its config, keys and known hosts are. */
export function sshHome(): string {
  // Tests only (bun test): a fake home, as OpenSSH can't be given one.
  if (process.env.NODE_ENV === "test" && process.env.CODEOID_TEST_SSH_HOME) return process.env.CODEOID_TEST_SSH_HOME;
  try {
    return userInfo().homedir || homedir();
  } catch {
    return homedir();
  }
}

export interface ConnectOptions {
  /** A dedicated token (`user:token` or a token), instead of the owner's own credential. */
  token?: string;
  /** What sandboxed sessions may write: the system ssh mustn't be there. */
  writable: readonly string[];
  /** The gateway's private dir for a run's credential file. */
  runDir: string;
  /** Tests only: a local bare repository as the remote. */
  testFile?: boolean;
  /** Tests only: the owner's credential, instead of `git credential fill`. */
  fill?: (url: string) => Promise<HttpsCredential | { error: string }>;
  /** Tests only: the owner's home (ssh's config). */
  home?: string;
  /** The ssh settings the owner was shown (the connect card): what is stored, so what was shown is what runs. */
  sshSnapshot?: SshSnapshot;
}

/**
 * Prove the owner's credential reaches `url` (`git ls-remote` through the gateway's own env) and say how it will be
 * used. Resolves with what to record (and an https credential to keep), or why not.
 */
export async function probeConnection(
  url: string,
  o: ConnectOptions,
): Promise<{ kind: UpstreamKind; auth: ConnectionAuth; credential?: HttpsCredential; sshSnapshot?: SshSnapshot; upstream: Upstream; ssh: string | null } | { error: string }> {
  const bad = o.testFile && url.startsWith("file://") ? null : remoteUrlProblem(url);
  if (bad) return { error: `${url} can't be connected: ${bad}` };
  const kind = o.testFile && url.startsWith("file://") ? "ssh" : upstreamKind(url);
  if (!kind) return { error: `${url} can't be connected: only ssh and https remotes are` };
  let ssh: string | null = null;
  let credential: HttpsCredential | undefined;
  let snapshot: SshSnapshot | undefined;
  let auth: ConnectionAuth = "ssh";
  if (kind === "ssh" && !o.testFile) {
    const s = systemSsh(o.writable);
    if ("problem" in s) return { error: s.problem };
    ssh = s.path;
    if (o.token) return { error: "a token is for an https remote; an ssh remote uses your ssh key" };
    // The owner's ssh setup for this host, as data (ssh-snapshot.ts): what every run uses, never their config itself.
    // OpenSSH's home is the passwd one (it ignores $HOME): what its keys and known hosts are read from.
    const home = o.home ?? sshHome();
    const snap = o.sshSnapshot ?? (await resolveSshSnapshot(url, { ssh, home, writable: o.writable }));
    if ("error" in snap) return snap;
    snapshot = snap;
    const bad = snapshotProblem(snapshot, o.writable, home);
    if (bad) return { error: bad };
  }
  if (kind === "https") {
    const c = o.token ? tokenCredential(url, o.token) : await (o.fill ?? ((u: string) => fillGitCredential(u, { runDir: o.runDir, writable: o.writable })))(url);
    if ("error" in c) return c;
    const caInfo = await ownerCaInfo(url, o.writable);
    if (caInfo && typeof caInfo === "object") return caInfo;
    credential = { ...c, ...(caInfo ? { caInfo } : {}) };
    auth = o.token ? "token" : "git-credential";
  }
  const upstream: Upstream = { url, kind, runDir: o.runDir, ...(credential ? { credential } : {}), ...(snapshot ? { sshConfig: sshConfigText(snapshot) } : {}), ...(o.testFile ? { testFile: true } : {}) };
  const r = await lsRemote(upstream, ssh);
  if (r.code !== 0) return { error: gitError(r, `your ${kind === "ssh" ? "ssh key" : "credential"} didn't reach ${url}`) };
  return { kind, auth, ...(credential ? { credential } : {}), ...(snapshot ? { sshSnapshot: snapshot } : {}), upstream, ssh };
}

/**
 * The URL the owner's git really uses for `url` (their global and system `url.*.insteadOf`, from `/`: no repository's
 * config, nothing run), or `url` itself. Sync: a spec is built so.
 */
// paths: git ls-remote --get-url from /, which only reads config
export function ownerRewrite(url: string, dir?: string): string {
  if (dir) {
    const inRepo = rewriteIn(dir, url, false);
    if (inRepo !== null) return inRepo;
  }
  if (!ownerConfigPlain()) return url;
  try {
    const r = spawnSync(GIT_BIN, ["-C", "/", "ls-remote", "--get-url", "--", url], { cwd: "/", env: ownerHelperEnv(), encoding: "utf8", timeout: 5_000 });
    const out = r.status === 0 ? r.stdout.trim() : "";
    return out && !/\s/.test(out) ? out : url;
  } catch {
    return url;
  }
}

/** The url.* rules git reads in a repository (its includes, conditional ones, its own config), as of a read. */
interface RewriteRules {
  insteadOf: Array<readonly [string, string]>;
  pushInsteadOf: Array<readonly [string, string]>;
}
const repoRules = new Map<string, { at: number; rules: RewriteRules | null }>();
const reading = new Map<string, Promise<void>>();
const hungRepos = new Map<string, number>();

/**
 * Read (again, when older than half a minute) the url.* rules git applies in the repository at `dir`: `git config
 * --get-regexp` run there, asynchronously (the repository is the agent's to write: a FIFO or a slow file in it holds
 * up only this read, never the daemon), bounded at 5 s; one that didn't answer isn't read again for 10 minutes.
 */
// paths: git config read in the session's repository (url.* rules), nothing run
export function warmRewrites(dir: string | undefined, fresh = false): Promise<void> {
  if (!dir) return Promise.resolve();
  const have = repoRules.get(dir);
  if (!fresh && have && Date.now() - have.at < 30_000) return Promise.resolve();
  const hung = hungRepos.get(dir);
  if (hung && hung > Date.now()) return Promise.resolve();
  const running = reading.get(dir);
  if (running) return running;
  const done = new Promise<void>((resolveRead) => {
    const child = spawn(GIT_BIN, ["-C", dir, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "config", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], { cwd: dir, env: { ...ownerHelperEnv(), GIT_CEILING_DIRECTORIES: dirname(dir) }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      hungRepos.set(dir, Date.now() + 10 * 60_000);
      child.kill("SIGKILL");
    }, 5_000);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      reading.delete(dir);
      // 1: no rule at all, which is an answer.
      if (code !== 0 && code !== 1) repoRules.set(dir, { at: Date.now(), rules: null });
      else {
        const rules: RewriteRules = { insteadOf: [], pushInsteadOf: [] };
        for (const entry of out.split("\0")) {
          const nl = entry.indexOf("\n");
          if (nl < 0) continue;
          const key = entry.slice(0, nl);
          const prefix = entry.slice(nl + 1);
          const m = /^url\.(.*)\.(insteadof|pushinsteadof)$/i.exec(key);
          if (!m?.[1] || !prefix) continue;
          (m[2]?.toLowerCase() === "pushinsteadof" ? rules.pushInsteadOf : rules.insteadOf).push([m[1], prefix]);
        }
        repoRules.set(dir, { at: Date.now(), rules });
      }
      resolveRead();
    };
    child.on("close", finish);
    child.on("error", () => finish(null));
  });
  reading.set(dir, done);
  return done;
}

/** A rule set's rewrite of `url`: the longest matching prefix, as git picks. */
function longest(rules: ReadonlyArray<readonly [string, string]>, url: string): string | null {
  let best: readonly [string, string] | null = null;
  for (const r of rules) if (url.startsWith(r[1]) && (!best || r[1].length > best[1].length)) best = r;
  return best ? best[0] + url.slice(best[1].length) : null;
}

/**
 * Where the owner's git, working in the repository at `dir`, fetches (or pushes) `url`, by the rules git reads there
 * (as `warmRewrites` last read them: a conditional include or the repository's own rule counts). Nothing is run here
 * (a stale read is refreshed in the background). Null: not read (yet): the rules read from / are used.
 */
function rewriteIn(dir: string, url: string, push: boolean): string | null {
  const have = repoRules.get(dir);
  if (!have || Date.now() - have.at >= 30_000) void warmRewrites(dir);
  if (!have?.rules) return null;
  const fetchUrl = longest(have.rules.insteadOf, url) ?? url;
  if (!push) return fetchUrl;
  // A pushInsteadOf, the longest; else the fetch rewrite (git applies insteadOf to a push no pushInsteadOf matches).
  return longest(have.rules.pushInsteadOf, url) ?? fetchUrl;
}

/**
 * The URL the owner's git pushes `url` to: their `url.*.pushInsteadOf` (longest match), else their fetch rewrite
 * (git applies insteadOf to a push URL no pushInsteadOf matches). Read from `/`, nothing run.
 */
// paths: git config read from /, which runs nothing
export function ownerPushRewrite(url: string, dir?: string): string {
  if (dir) {
    const inRepo = rewriteIn(dir, url, true);
    if (inRepo !== null) return inRepo;
  }
  if (!ownerConfigPlain()) return url;
  try {
    const r = spawnSync(GIT_BIN, ["-C", "/", "config", "--null", "--get-regexp", "^url\\..*\\.pushinsteadof$"], { cwd: "/", env: ownerHelperEnv(), encoding: "utf8", timeout: 5_000 });
    let best: { base: string; prefix: string } | null = null;
    for (const entry of (r.status === 0 ? r.stdout : "").split("\0")) {
      const nl = entry.indexOf("\n");
      if (nl < 0) continue;
      const key = entry.slice(0, nl);
      const prefix = entry.slice(nl + 1);
      const base = key.slice("url.".length, -".pushinsteadof".length);
      if (prefix && url.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { base, prefix };
    }
    return best ? best.base + url.slice(best.prefix.length) : ownerRewrite(url);
  } catch {
    return url;
  }
}

/** A user's home by name, as git's `~user/` (getpwnam); the owner's own when it is them, else `/etc/passwd`'s, else beside theirs. */
// paths: the system's account file, read
function userHome(user: string, home: string): string {
  if (user === userInfo().username) return userInfo().homedir || home;
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.split(":")[0] === user);
    const dir = line?.split(":")[5];
    if (dir) return dir;
  } catch {
    /* none */
  }
  return join(dirname(home), user);
}

/** Whether `p` is a plain file (stat, following a link): never a FIFO or device a git run would wait on. */
// paths: a look (stat), nothing read
function plainFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether every one of the owner's git config files that exists (and each it includes) is a plain file: git run
 * from / reads them all, and one that is a FIFO (an agent can plant one where an include points, in a workspace)
 * would hold that run, and the daemon with it. Not plain: the rules read from / aren't used.
 */
// paths: a look (stat) at the owner's config files, nothing read
export function ownerConfigPlain(): boolean {
  for (const f of ownerConfigFiles()) {
    try {
      const st = statSync(f);
      if (!st.isFile() && !st.isDirectory()) return false;
    } catch {
      /* missing: nothing to wait on */
    }
  }
  return true;
}

let ownerFiles: { at: number; key: string; files: string[] } | null = null;

/**
 * Every file the owner's git and ssh configs are read from, each as named and where it really is (a dotfiles link):
 * `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, every file their includes name (git's own `--show-origin
 * --includes`, from `/`: nothing run), `~/.ssh` and `~/.ssh/config`, and every file its `Include` lines name (a
 * pattern's matches in its dir). Cached for a few seconds (a spec is built from it).
 */
// paths: the owner's config files, read (git config from /, ssh's config and its includes), nothing run
export function ownerConfigFiles(): string[] {
  const home = process.env.HOME || homedir();
  const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const key = `${home}\0${xdg}\0${sshHome()}`;
  if (ownerFiles && ownerFiles.key === key && Date.now() - ownerFiles.at < 5_000) return ownerFiles.files;
  const out = new Set<string>();
  const add = (p: string) => {
    out.add(p);
    out.add(physicalPathOr(p));
  };
  for (const f of [join(home, ".gitconfig"), join(xdg, "git", "config")]) add(f);
  // ssh's: from the home OpenSSH uses, every file and pattern dir codeoid's own snapshot parser reads (the same reading).
  for (const f of sshConfigSources(sshHome())) add(f);
  // (Not git's own `--includes` listing: it would open an include target that is a FIFO, and wait. The walk below
  // reads each file alone, only when it is a plain file.)
  // Every include git could read, active from / or not (includeIf), there yet or not: each file's own include keys.
  const seenGit = new Set<string>();
  const includes = (file: string, depth: number) => {
    if (depth > 10 || seenGit.has(file)) return;
    seenGit.add(file);
    if (!plainFile(file)) return;
    // That file alone: git reads the global config (and its includes) at start even with --file, so none here.
    const r = spawnSync(GIT_BIN, ["-C", "/", "config", "--file", file, "--no-includes", "--null", "--get-regexp", "^include(if\\..*)?\\.path$"], { cwd: "/", env: { ...ownerHelperEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 5_000 });
    for (const entry of (r.status === 0 ? r.stdout : "").split("\0")) {
      const nl = entry.indexOf("\n");
      const v = nl < 0 ? "" : entry.slice(nl + 1);
      if (!v) continue;
      // git expands ~ and ~user/ (interpolate_path); never normalized lexically (a `..` after a link is the kernel's).
      const user = /^~([^/]+)\//.exec(v)?.[1];
      const target = v === "~" || v.startsWith("~/") ? `${home}${v.slice(1)}` : user ? `${userHome(user, home)}${v.slice(user.length + 1)}` : isAbsolute(v) ? v : `${dirname(file)}/${v}`;
      add(target);
      includes(target, depth + 1);
    }
  };
  for (const f of [join(home, ".gitconfig"), join(xdg, "git", "config")]) if (existsSync(f)) includes(f, 0);
  ownerFiles = { at: Date.now(), key, files: [...out] };
  return ownerFiles.files;
}

/**
 * Why the owner's own git config can't be used for the gateway now (a credential helper, a CA, a rewrite read from
 * it, ssh's config): one of the files it is read from (resolved: a dotfiles link; an include) is in what a sandboxed
 * session may write, so what it says may be an agent's. Null: none is.
 */
export function ownerConfigProblem(writable: readonly string[]): string | null {
  const roots = [...new Set(writable.flatMap((w) => [w, physicalPathOr(w)]))];
  const hit = ownerConfigFiles().find((f) => roots.some((w) => within(w, f)));
  return hit ? `${hit} (your git or ssh config, or a file it includes) is in what a sandboxed session may write, so codeoid doesn't use your git or ssh config for agents while it is` : null;
}
