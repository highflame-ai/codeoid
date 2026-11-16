/**
 * The git gateway (docs/git-gateway-design.md): a sandboxed agent's own `git fetch` and `git push` reach the remote
 * with the owner's credentials, which never enter the sandbox.
 *
 * - Each session has its own unix socket, bound into its sandbox alone, so a connection on it is that session's.
 * - On a connection the gateway asks its host whether the session may reach that URL. It refreshes its private cache
 *   of the remote (a bare mirror, under one lock per remote), then serves git's own `upload-pack` or `receive-pack`
 *   on the cache, hardened, with none of the owner's git config.
 * - A push reaches the cache's pre-receive hook, which hands the updates to the gateway. The gateway checks each one
 *   (policy.ts: branches only, no delete, no protected or default branch, fast-forward), asks its host (the session:
 *   role, mode, the owner's card), then pushes the checked commits to the remote, atomically. The agent's push
 *   succeeds only when the remote took them.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { GIT_BIN } from "../git-env.js";
import { within } from "../physical-path.js";
import { type PushPolicy, type RefUpdate, refUpdateProblem } from "./policy.js";
import { type GatewayScripts, writeGatewayScripts } from "./scripts.js";
import { redactCredentials, shownGitUrl } from "./text.js";
import { cacheRef, configEnv, isAncestor, pushUpstream, type RemoteState, refreshCache, type Upstream } from "./upstream.js";

export type GitService = "git-upload-pack" | "git-receive-pack";

/** What the host says a session may reach at a URL. */
export interface GatewayGrant {
  upstream: Upstream;
  /** The system ssh's path, for an ssh remote. */
  ssh: string | null;
  protectedBranches: readonly string[];
  /** Branches agents made on this remote through the gateway (the owner's): the only existing ones they may move. */
  agentBranches: ReadonlySet<string>;
  /** Whose cache it is (one per owner and URL). */
  cacheKey: string;
}

export interface GatewayPush {
  url: string;
  updates: readonly RefUpdate[];
  defaultBranch: string | null;
}

/** The daemon's side: who may reach what, and what a session says about a push. */
export interface GatewayHost {
  /** May `sessionId` use `service` at `url`? Resolves with the grant, or why not (what the agent reads). */
  grant(sessionId: string, service: GitService, url: string): Promise<GatewayGrant | { refused: string }>;
  /** The session's word on a checked push (its role, its mode, the owner's answer); `signal`: the agent's git is gone. */
  approve(sessionId: string, push: GatewayPush, signal: AbortSignal): Promise<{ ok: true } | { refused: string }>;
  /** The remote's branches as a refresh found them (a branch agents made, gone from it, is no longer theirs). */
  remoteHeads?(sessionId: string, url: string, heads: ReadonlySet<string>): void;
  /** What happened, for the session's audit and transcript. */
  report(sessionId: string, event: { kind: "fetch" | "push"; url: string; ok: boolean; detail: string; updates?: readonly RefUpdate[] }): void;
}

export interface GatewayOptions {
  /** The daemon's own dir for the gateway (`<configDir>/git-gateway`), 0700. */
  base: string;
  host: GatewayHost;
  /** codeoid's runtime (Bun), which runs the launchers. */
  runtime?: string;
  /** Limits (ms): the whole request; the remote's refresh and push. */
  requestTimeoutMs?: number;
  upstreamTimeoutMs?: number;
}

interface Ticket {
  sessionId: string;
  grant: GatewayGrant;
  url: string;
  cache: string;
  remote: RemoteState;
  /** Aborted when the agent's git goes (its connection closes), the session closes or the gateway stops. */
  gone: AbortController;
}

const MAX_HEADER = 64 * 1024;

export class GitGateway {
  readonly #base: string;
  readonly #host: GatewayHost;
  readonly #scripts: GatewayScripts;
  readonly #runtime: string;
  readonly #requestTimeoutMs: number;
  readonly #upstreamTimeoutMs: number;
  readonly #sessions = new Map<string, { server: Server; socket: string; live: Set<Socket>; gone: Set<AbortController> }>();
  readonly #tickets = new Map<string, Ticket>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #control: Server;
  readonly #controlPath: string;
  readonly #live = new Set<Socket>();
  readonly #gone = new Set<AbortController>();
  #closed = false;

  constructor(o: GatewayOptions) {
    this.#base = resolve(o.base);
    this.#host = o.host;
    this.#runtime = o.runtime ?? process.execPath;
    this.#requestTimeoutMs = o.requestTimeoutMs ?? 10 * 60_000;
    this.#upstreamTimeoutMs = o.upstreamTimeoutMs ?? 3 * 60_000;
    // paths: the daemon's own gateway dir, made 0700 and owned by the daemon (checked: not a link)
    mkdirSync(this.#base, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.#base);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`the git gateway's dir ${this.#base} isn't a directory`);
    chmodSync(this.#base, 0o700);
    this.#scripts = writeGatewayScripts(this.#base, this.#runtime);
    for (const d of ["sock", "cache", "control", "run"]) mkdirSync(join(this.#base, d), { recursive: true, mode: 0o700 });
    // A run's credential file a stopped daemon left (it is removed after every run otherwise).
    for (const f of readdirSync(join(this.#base, "run"))) if (f.endsWith(".cred")) rmSync(join(this.#base, "run", f), { force: true });
    this.#controlPath = join(this.#base, "control", "hook.sock");
    this.#control = this.#listen(this.#controlPath, (c) => this.#onHook(c));
  }

  /** The gateway's own dir (a sandbox denies its sockets by rule where it can: Seatbelt). */
  get root(): string {
    return this.#base;
  }

  /** What a session's sandbox is given: its socket, the launcher, and codeoid's runtime the launcher runs. */
  forSession(sessionId: string): { socket: string; ext: string; binDir: string; runtime: string } {
    let s = this.#sessions.get(sessionId);
    if (!s) {
      const dir = join(this.#base, "sock", createHash("sha256").update(sessionId).digest("hex").slice(0, 24));
      // paths: the daemon's own socket dir for the session, made fresh
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { mode: 0o700 });
      const socket = join(dir, "git.sock");
      const live = new Set<Socket>();
      const gone = new Set<AbortController>();
      const server = this.#listen(socket, (c) => {
        live.add(c);
        c.once("close", () => live.delete(c));
        void this.#onClient(sessionId, c, gone);
      });
      s = { server, socket, live, gone };
      this.#sessions.set(sessionId, s);
    }
    return { socket: s.socket, ext: this.#scripts.ext, binDir: this.#scripts.binDir, runtime: this.#runtime };
  }

  /** Stop serving a session (destroyed): its socket goes, a request in flight ends (a pending push isn't made). */
  closeSession(sessionId: string): void {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    this.#sessions.delete(sessionId);
    for (const g of s.gone) g.abort();
    for (const c of s.live) c.destroy();
    s.server.close();
    // paths: the daemon's own socket dir for the session
    rmSync(join(s.socket, ".."), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const g of this.#gone) g.abort();
    for (const id of [...this.#sessions.keys()]) this.closeSession(id);
    this.#control.close();
    for (const c of this.#live) c.destroy();
  }

  /** The cache for a grant (tests). */
  cachePath(cacheKey: string): string {
    return join(this.#base, "cache", `${createHash("sha256").update(cacheKey).digest("hex").slice(0, 32)}.git`);
  }

  #listen(path: string, onConn: (c: Socket) => void): Server {
    // paths: the daemon's own socket, replaced (a stale one from a stopped daemon)
    if (existsSync(path)) unlinkSync(path);
    // No half-open: the client frames the end of git's input (scripts.ts), so its end of the connection means it's gone.
    const server = createServer((c) => {
      // A peer gone mid-write (the agent's git killed) is an error to drop, never one to throw.
      c.on("error", () => c.destroy());
      this.#live.add(c);
      c.once("close", () => this.#live.delete(c));
      onConn(c);
    });
    server.listen(path);
    // Only the daemon's user may connect (the sandbox runs as it; nobody else on the machine).
    server.once("listening", () => {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* gone */
      }
    });
    return server;
  }

  /** Run `fn` holding the lock of `key` (one request per remote cache at a time). */
  async #locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => mine);
    this.#locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === chained) this.#locks.delete(key);
    }
  }

  async #onClient(sessionId: string, c: Socket, sessionGone: Set<AbortController>): Promise<void> {
    const fail = (why: string) => {
      if (!c.destroyed) c.end(`error ${redactCredentials(why).replace(/\n/g, " ")}\n`);
    };
    const limit = setTimeout(() => c.destroy(), this.#requestTimeoutMs);
    c.once("close", () => clearTimeout(limit));
    let header: { service?: unknown; url?: unknown; protocol?: unknown };
    let rest: Buffer;
    try {
      ({ header, rest } = await readHeader(c));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const service = header.service;
    const url = header.url;
    if ((service !== "git-upload-pack" && service !== "git-receive-pack") || typeof url !== "string" || url.length > 2048) return fail("not a git request");
    const protocol = typeof header.protocol === "string" && /^version=[0-9]$/.test(header.protocol) ? header.protocol : "";
    const grant = await this.#host.grant(sessionId, service, url).catch((err: unknown) => ({ refused: err instanceof Error ? err.message : String(err) }));
    if ("refused" in grant) {
      this.#host.report(sessionId, { kind: service === "git-receive-pack" ? "push" : "fetch", url, ok: false, detail: grant.refused });
      return fail(grant.refused);
    }
    const cache = this.cachePath(grant.cacheKey);
    const upstream: Upstream = { ...grant.upstream, runDir: join(this.#base, "run") };
    // The agent's git gone (its connection closed), the session closed or the gateway stopping: nothing more is done.
    const gone = new AbortController();
    sessionGone.add(gone);
    this.#gone.add(gone);
    c.once("close", () => gone.abort());
    c.once("end", () => gone.abort());
    try {
      // The lock is the refresh's alone: serving (and an owner's card) doesn't hold up other sessions' requests.
      const fresh = await this.#locked(grant.cacheKey, async () => {
        sweepQuarantines(cache);
        return refreshCache(cache, upstream, grant.ssh, this.#upstreamTimeoutMs, gone.signal);
      });
      if (gone.signal.aborted) return;
      if (!("error" in fresh) && fresh.defaultKnown) this.#host.remoteHeads?.(sessionId, url, fresh.heads);
      if ("error" in fresh) {
        this.#host.report(sessionId, { kind: service === "git-receive-pack" ? "push" : "fetch", url, ok: false, detail: fresh.error });
        return fail(fresh.error);
      }
      const ticket = randomBytes(24).toString("hex");
      if (service === "git-receive-pack") this.#tickets.set(ticket, { sessionId, grant: { ...grant, upstream }, url, cache, remote: fresh, gone });
      try {
        if (c.destroyed) return;
        c.write("ok\n");
        const code = await this.#serve(service, cache, c, rest, ticket, protocol);
        if (service === "git-upload-pack" && code === 0) this.#host.report(sessionId, { kind: "fetch", url, ok: true, detail: `fetched from ${shownGitUrl(url)}` });
      } finally {
        this.#tickets.delete(ticket);
      }
    } finally {
      sessionGone.delete(gone);
      this.#gone.delete(gone);
    }
  }

  /** git's own server on the cache, its stdio the client's, until it exits. */
  #serve(service: GitService, cache: string, c: Socket, rest: Buffer, ticket: string, _protocol: string): Promise<number | null> {
    const config: Array<readonly [string, string]> = [
      ["core.hooksPath", service === "git-receive-pack" ? this.#scripts.hooksDir : "/dev/null"],
      ["core.fsmonitor", "false"],
      ["transfer.fsckObjects", "true"],
      ["receive.fsckObjects", "true"],
      ["receive.denyDeletes", "true"],
      ["receive.denyNonFastForwards", "true"],
      ["receive.advertisePushOptions", "false"],
      ["receive.advertiseAtomic", "true"],
      ["receive.autogc", "false"],
      ["uploadpack.allowAnySHA1InWant", "false"],
      ["uploadpack.allowFilter", "true"],
      ["core.logAllRefUpdates", "false"],
    ];
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      LANG: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: dirname(cache),
      ...configEnv(config),
      // No protocol v2 for upload-pack: v2's fetch takes any object the cache holds (allowAnySHA1InWant is v0's).
      ...(service === "git-receive-pack" ? { CODEOID_GW_HOOK: this.#controlPath, CODEOID_GW_TICKET: ticket } : {}),
    };
    return new Promise((done) => {
      // paths: git's own server, run on the daemon's cache repository
      // Its own process group: the hook and anything it started go with it.
      const p = spawn(GIT_BIN, [service.slice("git-".length), cache], { cwd: cache, env, stdio: ["pipe", "pipe", "ignore"], detached: true });
      p.stdin.on("error", () => {});
      // What the client's git writes comes in frames (scripts.ts EXT_JS): a 0 length ends git's input.
      let buf = rest;
      let ended = false;
      // A push's commands (pkt-lines, to the first flush) are read on the way: a ref name with a control character
      // (a line feed would make two lines of the hook's input of one command) ends the request before git sees it.
      const commands = service === "git-receive-pack" ? new CommandReader() : null;
      const take = (d: Buffer) => {
        if (ended) return;
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        while (buf.length >= 4) {
          const n = buf.readUInt32BE(0);
          if (n > 16 * 1024 * 1024) {
            ended = true;
            c.destroy();
            return;
          }
          if (n === 0) {
            ended = true;
            p.stdin.end();
            return;
          }
          if (buf.length < 4 + n) return;
          const chunk = buf.subarray(4, 4 + n);
          if (commands && !commands.ok(chunk)) {
            ended = true;
            c.destroy();
            return;
          }
          p.stdin.write(chunk);
          buf = buf.subarray(4 + n);
        }
      };
      c.on("data", take);
      take(Buffer.alloc(0));
      c.on("end", () => {
        if (!ended) p.stdin.end();
      });
      p.stdout.pipe(c, { end: false });
      const finish = (code: number | null) => {
        c.end();
        done(code);
      };
      p.on("close", (code) => finish(code));
      p.on("error", () => finish(null));
      c.on("close", () => {
        if (p.exitCode !== null || !p.pid) return;
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      });
    });
  }

  /** The cache's pre-receive hook asks: the updates, checked, the session's word, then the remote. */
  async #onHook(c: Socket): Promise<void> {
    const say = (line: string) => {
      if (!c.destroyed) c.write(`msg ${redactCredentials(line).replace(/\n/g, " ")}\n`);
    };
    const verdict = (ok: boolean): void => {
      if (!c.destroyed) c.end(ok ? "ok\n" : "no\n");
    };
    let req: { ticket?: unknown; updates?: unknown; objects?: { dir?: unknown; alternates?: unknown } };
    try {
      ({ header: req } = await readHeader(c));
    } catch {
      return verdict(false);
    }
    const t = typeof req.ticket === "string" ? this.#tickets.get(req.ticket) : undefined;
    if (!t) return verdict(false);
    // Single use.
    this.#tickets.delete(req.ticket as string);
    const claimed = Array.isArray(req.updates) ? (req.updates as RefUpdate[]).filter((u) => u && typeof u.old === "string" && typeof u.new === "string" && typeof u.ref === "string") : [];
    // Each update's `old` is what the remote had when the gateway refreshed (the cache: receive-pack hasn't touched it
    // yet), never the client's claim: a push claiming a branch is new when it isn't is refused.
    const updates: RefUpdate[] = [];
    for (const u of claimed) updates.push({ ...u, old: await cacheRef(t.cache, u.ref, u.new) });
    const refuse = (why: string) => {
      say(`codeoid refused the push: ${why}`);
      this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: false, detail: why, updates });
      verdict(false);
    };
    if (updates.length === 0) return refuse("nothing to update");
    for (const [i, u] of updates.entries()) {
      if (claimed[i]?.old !== u.old) return refuse(`${u.ref}: what your git said the remote has isn't what it has (fetch, then push again)`);
      // A delete sends no objects: said as itself.
      if (/^0+$/.test(u.new)) return refuse(`${u.ref.replace(/^refs\/heads\//, "")}: deleting a branch isn't done for agents`);
    }
    const dir = typeof req.objects?.dir === "string" ? req.objects.dir : "";
    const alternates = typeof req.objects?.alternates === "string" ? req.objects.alternates : "";
    // The pushed objects wait in git's quarantine inside the cache; nowhere else is read.
    const objectsRoot = join(t.cache, "objects");
    if (!dir || !within(objectsRoot, resolve(dir)) || alternates.split(":").some((a) => a && !within(t.cache, resolve(a)))) return refuse("the push's objects aren't where git keeps them");
    const objects = { dir, alternates };
    const policy: PushPolicy = {
      protectedBranches: t.grant.protectedBranches,
      defaultBranch: t.remote.defaultBranch,
      // An empty remote has no default yet (its first branch may become it): known, and none.
      defaultKnown: t.remote.defaultKnown,
      symrefs: t.remote.symrefs,
      agentBranches: t.grant.agentBranches,
    };
    if (t.remote.empty) return refuse("the remote has no branch yet (an empty repository), and the first one pushed may become its default: ask the owner to push its first branch");
    for (const u of updates) {
      const problem = await refUpdateProblem(u, policy, (old, next) => isAncestor(t.cache, old, next, objects));
      if (problem) return refuse(problem);
    }
    if (t.gone.signal.aborted) return verdict(false);
    const word = await this.#host
      .approve(t.sessionId, { url: t.url, updates, defaultBranch: t.remote.defaultBranch }, t.gone.signal)
      .catch((err: unknown) => ({ refused: err instanceof Error ? err.message : String(err) }));
    if ("refused" in word) return refuse(word.refused);
    // The agent's git gave up (a tool's time limit, an interrupt) while the owner was asked: nothing is pushed.
    if (t.gone.signal.aborted) {
      this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: false, detail: "the agent's git was gone before the push started, so nothing was pushed", updates });
      return verdict(false);
    }
    // Approved and started: it finishes (bounded by its own limit), the agent's git there or not, so what the remote
    // took is what is recorded.
    const pushed = await pushUpstream(t.cache, t.grant.upstream, t.grant.ssh, updates, objects, this.#upstreamTimeoutMs);
    if (!pushed.ok) {
      say(pushed.error);
      this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: false, detail: pushed.error, updates });
      return verdict(false);
    }
    say(`codeoid pushed ${updates.map((u) => u.ref.replace(/^refs\/heads\//, "")).join(", ")} to ${shownGitUrl(t.url)}`);
    this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: true, detail: `pushed to ${shownGitUrl(t.url)}`, updates });
    verdict(true);
  }
}

/** Reads receive-pack's command pkt-lines as they stream by (to the first flush), and says whether they may go on. */
export class CommandReader {
  #buf: Buffer = Buffer.alloc(0);
  #done = false;
  ok(chunk: Buffer): boolean {
    if (this.#done) return true;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    while (this.#buf.length >= 4) {
      const n = Number.parseInt(this.#buf.subarray(0, 4).toString("latin1"), 16);
      if (Number.isNaN(n)) return false;
      if (n === 0) {
        this.#done = true;
        this.#buf = Buffer.alloc(0);
        return true;
      }
      if (n < 4 || n > 65520) return false;
      if (this.#buf.length < n) return true;
      // One trailing line feed is pkt-line's own; any other control character in the ref is refused.
      const line = this.#buf.subarray(4, n).toString("latin1").replace(/\n$/, "");
      this.#buf = this.#buf.subarray(n);
      if (line.startsWith("shallow ")) continue;
      // A signed push or anything but `old new ref[\0caps]`: not taken.
      const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([^\0]*)(\0.*)?$/s.exec(line);
      if (!m?.[3] || /[\x00-\x1f\x7f]/.test(m[3])) return false;
    }
    return true;
  }
}

/** Remove quarantines (`objects/tmp_objdir-incoming-*`) a killed receive-pack left, an hour old or more. */
// paths: the daemon's own cache repository: its stale quarantine dirs, removed
function sweepQuarantines(cache: string): void {
  const objects = join(cache, "objects");
  try {
    for (const name of readdirSync(objects)) {
      if (!name.startsWith("tmp_objdir-incoming-")) continue;
      const at = join(objects, name);
      if (Date.now() - lstatSync(at).mtimeMs > 60 * 60_000) rmSync(at, { recursive: true, force: true });
    }
  } catch {
    /* no cache yet */
  }
}

/** The first line on `c` as JSON, and what came after it. */
function readHeader(c: Socket): Promise<{ header: Record<string, never> & Record<string, unknown>; rest: Buffer }> {
  return new Promise((ok, no) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) {
        if (buf.length > MAX_HEADER) {
          cleanup();
          no(new Error("request too long"));
        }
        return;
      }
      cleanup();
      try {
        const header = JSON.parse(buf.subarray(0, i).toString("utf8"));
        if (!header || typeof header !== "object") throw new Error("not an object");
        ok({ header, rest: buf.subarray(i + 1) });
      } catch {
        no(new Error("not a git gateway request"));
      }
    };
    const onEnd = () => {
      cleanup();
      no(new Error("the request ended early"));
    };
    const cleanup = () => {
      c.off("data", onData);
      c.off("end", onEnd);
    };
    c.on("data", onData);
    c.on("end", onEnd);
  });
}
