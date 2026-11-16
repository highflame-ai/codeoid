/**
 * Connecting a remote for the git gateway (docs/git-gateway-design.md §3.5): the owner's word that agents in their
 * sandboxed sessions may fetch and push there with the owner's existing credential, proved to work first.
 *
 * - ssh: the system ssh with the owner's key, agent and `~/.ssh/config`; nothing is stored.
 * - https: the owner's credential read once, now, with `git credential fill` (their own helpers, at their request),
 *   or a dedicated token they hand in; kept in a 0600 file of the daemon's, sent to that remote's origin only.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GIT_BIN } from "../git-env.js";
import { remoteUrlProblem } from "./text.js";
import { gitError, type HttpsCredential, runGit, systemSsh, type Upstream, type UpstreamKind, upstreamEnv, upstreamKind } from "./upstream.js";

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

/** The owner's own credential for an https URL, as `git push` would find it (their helpers, run once, now). */
// paths: git credential fill, run by the daemon for the owner, at their request (never an agent's)
export function fillGitCredential(url: string, timeoutMs = 60_000): Promise<HttpsCredential | { error: string }> {
  const u = new URL(url);
  return new Promise((done) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>;
    const p = spawn(GIT_BIN, ["credential", "fill"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      const field = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1];
      const username = field("username");
      const password = field("password");
      if (code === 0 && username && password) done({ username, password });
      else done({ error: `your git has no credential for ${u.host} (git credential fill found none): sign in with git once, or connect with a token` });
    });
    p.on("error", (err) => done({ error: err.message }));
    p.stdin.end(`protocol=${u.protocol.replace(/:$/, "")}\nhost=${u.host}\n\n`);
  });
}

export interface ConnectOptions {
  /** A dedicated token (`user:token` or a token), instead of the owner's own credential. */
  token?: string;
  /** What sandboxed sessions may write: the system ssh mustn't be there. */
  writable: readonly string[];
  /** Tests only: a local bare repository as the remote. */
  testFile?: boolean;
  /** Tests only: the owner's credential, instead of `git credential fill`. */
  fill?: (url: string) => Promise<HttpsCredential | { error: string }>;
}

/**
 * Prove the owner's credential reaches `url` (`git ls-remote` through the gateway's own env) and say how it will be
 * used. Resolves with what to record (and an https credential to keep), or why not.
 */
export async function probeConnection(
  url: string,
  o: ConnectOptions,
): Promise<{ kind: UpstreamKind; auth: ConnectionAuth; credential?: HttpsCredential; upstream: Upstream; ssh: string | null } | { error: string }> {
  const bad = o.testFile && url.startsWith("file://") ? null : remoteUrlProblem(url);
  if (bad) return { error: `${url} can't be connected: ${bad}` };
  const kind = o.testFile && url.startsWith("file://") ? "ssh" : upstreamKind(url);
  if (!kind) return { error: `${url} can't be connected: only ssh and https remotes are` };
  let ssh: string | null = null;
  let credential: HttpsCredential | undefined;
  let auth: ConnectionAuth = "ssh";
  if (kind === "ssh" && !o.testFile) {
    const s = systemSsh(o.writable);
    if ("problem" in s) return { error: s.problem };
    ssh = s.path;
    if (o.token) return { error: "a token is for an https remote; an ssh remote uses your ssh key" };
  }
  if (kind === "https") {
    const c = o.token ? tokenCredential(url, o.token) : await (o.fill ?? fillGitCredential)(url);
    if ("error" in c) return c;
    credential = c;
    auth = o.token ? "token" : "git-credential";
  }
  const upstream: Upstream = { url, kind, ...(credential ? { credential } : {}), ...(o.testFile ? { testFile: true } : {}) };
  const r = await runGit(["ls-remote", "--heads", "--", url], "/", upstreamEnv(upstream, ssh), 60_000);
  if (r.code !== 0) return { error: gitError(r, `your ${kind === "ssh" ? "ssh key" : "credential"} didn't reach ${url}`) };
  return { kind, auth, ...(credential ? { credential } : {}), upstream, ssh };
}
