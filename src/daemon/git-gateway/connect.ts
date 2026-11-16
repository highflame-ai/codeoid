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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { physicalPath, within } from "../physical-path.js";

import { GIT_BIN } from "../git-env.js";
import { hostPathProblem } from "./hostpath.js";
import { type SshSnapshot, snapshotProblem, sshConfigText, sshHostOf, sshSnapshot } from "./ssh-snapshot.js";
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
const SAFE_HELPER = /^(?:osxkeychain|libsecret|gnome-keyring|wincred|manager|manager-core|cache(?: --timeout[= ]?\d+)?|store(?: --file[= ]?\S+)?)$/;

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
    // credential.helper, or credential.<url>.helper whose URL is this one's origin (or a prefix of it).
    if (key !== "credential.helper" && !(sub && (`${u.protocol}//${u.host}${u.pathname}`.startsWith(sub) || sub === u.host))) continue;
    out.push(value);
  }
  return out;
}

/**
 * The owner's own credential for an https URL, as their `git push` would find it, but with only the well-known
 * helpers their config names (SAFE_HELPER): `git credential fill` from `/`, its config a file codeoid writes with
 * those helpers alone, so nothing their config (or a file it includes) names otherwise is run.
 */
// paths: git credential fill from /, with a config codeoid writes (0600, in its own run dir), run for the owner at their request
export function fillGitCredential(url: string, o: { runDir: string; writable: readonly string[] }, timeoutMs = 60_000): Promise<HttpsCredential | { error: string }> {
  const u = new URL(url);
  const helpers = ownerHelpers(url);
  const usable: string[] = [];
  for (const h of helpers) {
    if (h === "") {
      usable.length = 0;
      continue;
    }
    if (!SAFE_HELPER.test(h.trim())) return Promise.resolve({ error: `your credential helper ${JSON.stringify(h.slice(0, 60))} isn't one codeoid runs for agents (only git's and the platforms' own): connect with --token` });
    const file = /^store(?: --file[= ]?(\S+))?$/.exec(h.trim())?.[1];
    if (file) {
      const bad = hostPathProblem(file.startsWith("~/") ? join(process.env.HOME || homedir(), file.slice(2)) : file, o.writable, undefined, { homeAllowed: true });
      if (bad) return Promise.resolve({ error: `your credential store file can't be used: ${bad}` });
    }
    usable.push(h.trim());
  }
  if (usable.length === 0) return Promise.resolve({ error: `your git has no credential helper codeoid can use for ${u.host}: sign in with git once (a keychain, libsecret, the credential manager, store or cache), or connect with --token` });
  mkdirSync(o.runDir, { recursive: true, mode: 0o700 });
  const cfg = join(o.runDir, `${createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 16)}.gitconfig`);
  writeFileSync(cfg, `[credential]\n${usable.map((h) => `\thelper = ${h}\n`).join("")}`, { mode: 0o600 });
  return new Promise((done) => {
    const env = { ...ownerHelperEnv(), GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" };
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
    const host = sshHostOf(url);
    if (!host) return { error: `${url} names no host codeoid can reach by ssh` };
    const home = o.home ?? (process.env.HOME || homedir());
    snapshot = sshSnapshot(host, home);
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
export function ownerRewrite(url: string): string {
  try {
    const r = spawnSync(GIT_BIN, ["-C", "/", "ls-remote", "--get-url", "--", url], { cwd: "/", env: ownerHelperEnv(), encoding: "utf8", timeout: 5_000 });
    const out = r.status === 0 ? r.stdout.trim() : "";
    return out && !/\s/.test(out) ? out : url;
  } catch {
    return url;
  }
}

/**
 * The URL the owner's git pushes `url` to: their `url.*.pushInsteadOf` (longest match), else their fetch rewrite
 * (git applies insteadOf to a push URL no pushInsteadOf matches). Read from `/`, nothing run.
 */
// paths: git config read from /, which runs nothing
export function ownerPushRewrite(url: string): string {
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
  const key = `${home}\0${xdg}`;
  if (ownerFiles && ownerFiles.key === key && Date.now() - ownerFiles.at < 5_000) return ownerFiles.files;
  const out = new Set<string>();
  const add = (p: string) => {
    out.add(p);
    out.add(physicalPathOr(p));
  };
  for (const f of [join(home, ".gitconfig"), join(xdg, "git", "config"), join(home, ".ssh"), join(home, ".ssh", "config")]) add(f);
  try {
    const r = spawnSync(GIT_BIN, ["-C", "/", "config", "--global", "--list", "--show-origin", "--includes", "--null"], { cwd: "/", env: ownerHelperEnv(), encoding: "utf8", timeout: 5_000 });
    for (const part of (r.status === 0 ? r.stdout : "").split("\0")) if (part.startsWith("file:")) add(part.slice("file:".length));
  } catch {
    /* none read */
  }
  const sshDir = join(home, ".ssh");
  const seen = new Set<string>();
  const readSsh = (file: string, depth: number) => {
    if (depth > 4 || seen.has(file)) return;
    seen.add(file);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const m = /^\s*Include\s+(.+)$/i.exec(line);
      if (!m?.[1]) continue;
      for (const raw of m[1].trim().split(/\s+/)) {
        const named = raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : join(sshDir, raw);
        const matches = /[*?[]/.test(named) ? globIn(named) : [named];
        // A pattern's dir, and each match: an agent's new file there would match too.
        if (/[*?[]/.test(named)) add(dirname(named));
        for (const f of matches) {
          add(f);
          readSsh(f, depth + 1);
        }
      }
    }
  };
  readSsh(join(sshDir, "config"), 0);
  ownerFiles = { at: Date.now(), key, files: [...out] };
  return ownerFiles.files;
}

/** The files a pattern (wildcards in its last component) matches in its dir. */
function globIn(pattern: string): string[] {
  const dir = dirname(pattern);
  const re = new RegExp(`^${basename(pattern).replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  try {
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
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
