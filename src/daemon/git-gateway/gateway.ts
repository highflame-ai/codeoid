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
import { advertisedNames, cacheDirty, cacheHas, cacheRef, configEnv, dropCheckRefs, fetchCheckRefs, isAncestor, objectsNotSent, pruneCache, pushUpstream, reachedFromRefs, refreshCache, remoteRefs, type RemoteState, sweepCheckRefs, type Upstream } from "./upstream.js";
import { UploadFilter } from "./upload-filter.js";

export type GitService = "git-upload-pack" | "git-receive-pack";

/** What the host says a session may reach at a URL. */
export interface GatewayGrant {
  upstream: Upstream;
  /** The system ssh's path, for an ssh remote. */
  ssh: string | null;
  protectedBranches: readonly string[];
  /** Branches agents made on this remote through the gateway (the owner's): the only existing ones they may move. */
  agentBranches: ReadonlyMap<string, string>;
  /** Whose cache it is (one per owner and URL). */
  cacheKey: string;
  /** The connection's own URL, when the request named another spelling of it: what is reached, shown and recorded. */
  url?: string;
}

export interface GatewayPush {
  url: string;
  updates: readonly RefUpdate[];
  defaultBranch: string | null;
}

/** The daemon's side: who may reach what, and what a session says about a push. */
export interface GatewayHost {
  /** May `sessionId` use `service` at `url`? Resolves with the grant, or why not (what the agent reads). */
  /** `signal`: the agent's git went (a card raised for it is withdrawn). */
  grant(sessionId: string, service: GitService, url: string, signal?: AbortSignal): Promise<GatewayGrant | { refused: string }>;
  /** The session's word on a checked push (its role, its mode, the owner's answer); `signal`: the agent's git is gone. */
  approve(sessionId: string, push: GatewayPush, signal: AbortSignal): Promise<{ ok: true } | { refused: string }>;
  /** The remote's branches as a refresh found them (a branch agents made, gone from it, is no longer theirs). */
  /** The remote's branches as of a refresh that started at `since` (records made after it aren't judged by it). */
  remoteHeads?(sessionId: string, url: string, heads: ReadonlySet<string>, since: number): void;
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
  /** Whether the connection was removed since the grant (its cache's generation moved on). */
  disconnected: () => boolean;
  /** Called when the push's hook starts (receive-pack has the whole pack): the serve reads the socket again. */
  onHook?: () => void;
  /** Lifts the request's own limit: from the hook on, the push's limits (the upstream push's, the window's) govern. */
  stopLimit?: () => void;
  /** Ends this push's ref-update window (called when its receive-pack exits, or the push is refused). */
  releaseRefUpdate?: () => void;
  /** Its receive-pack has exited. */
  served?: boolean;
  /** The hook said "ok" (receive-pack will update the cache's refs, inside the window). */
  verdictOk?: boolean;
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
  /** Per cache: what stops its first clone (the gateway closing, the connection removed); and its generation. */
  readonly #cloneStops = new Map<string, AbortController>();
  /** Aborted when the gateway stops: an upstream push in flight ends with it (said, and recorded as unknown). */
  readonly #closing = new AbortController();
  /** Per cache: requests being served on it now; and whether it waits to be pruned (the remote deleted something). */
  readonly #serving = new Map<string, Map<symbol, { kind: "fetch" | "push"; stop: () => void }>>();
  /** The check namespaces of pushes running their last check now (their refs and marks aren't stale). */
  readonly #checking = new Set<string>();
  /** Over-cap connections waiting for their refusal (bounded). */
  #refusing = 0;
  /** Pushes (by ticket) whose commands came in full: one whose check never ran is recorded as such. */
  readonly #commandsSeen = new Set<string>();
  /** Remotes that timed out: requests in the next minute are told so at once instead of each waiting it out. */
  readonly #down = new Map<string, { until: number; error: string }>();
  readonly #generations = new Map<string, number>();
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
    // A first clone a stopped daemon left half made: none runs now.
    sweepTempClones(join(this.#base, "cache"));
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
      // This session's over-cap connections waiting for their refusal: a few per session, so one session's flood
      // doesn't take the answer away from another's.
      let refusing = 0;
      const server = this.#listen(socket, (c) => {
        // A few git connections at once per session (each may hold some memory): more is a command flooding it.
        if (live.size >= 8) {
          c.on("error", () => c.destroy());
          // Answered once its header came (closed before it, the launcher would only see a broken pipe); a flood of
          // them isn't held: past a few waiting, the rest are closed at once.
          if (refusing >= 8 || this.#refusing >= 64) {
            c.destroy();
            return;
          }
          this.#refusing++;
          refusing++;
          let said = false;
          const say = () => {
            if (said) return;
            said = true;
            this.#refusing--;
            refusing--;
            c.end("error too many git connections at once from this session: let one finish\n");
          };
          c.once("data", say);
          c.once("close", say);
          setTimeout(say, 2_000).unref?.();
          return;
        }
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
    for (const s of this.#cloneStops.values()) s.abort();
    // An upstream push in flight is stopped, and given a moment to say so to the agent's git and be recorded (the
    // store closes after this), before the connections go.
    this.#closing.abort();
    const until = Date.now() + 5_000;
    const pushing = () => [...this.#serving.values()].some((m) => [...m.values()].some((e) => e.kind === "push"));
    while (pushing() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
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
    const requested = header.url;
    if ((service !== "git-upload-pack" && service !== "git-receive-pack") || typeof requested !== "string" || requested.length > 2048) return fail("not a git request");
    let url: string = requested;
    const protocol = typeof header.protocol === "string" && /^version=[0-9]$/.test(header.protocol) ? header.protocol : "";
    // The agent's git gone (its connection closed), the session closed or the gateway stopping: nothing more is done
    // (from the grant on: a card raised for it is withdrawn).
    const gone = new AbortController();
    sessionGone.add(gone);
    this.#gone.add(gone);
    c.once("close", () => gone.abort());
    c.once("end", () => gone.abort());
    const grant = await this.#host.grant(sessionId, service, url, gone.signal).catch((err: unknown) => ({ refused: err instanceof Error ? err.message : String(err) }));
    if ("refused" in grant) {
      sessionGone.delete(gone);
      this.#gone.delete(gone);
      this.#host.report(sessionId, { kind: service === "git-receive-pack" ? "push" : "fetch", url, ok: false, detail: grant.refused });
      return fail(grant.refused);
    }
    // A spelling of a connected URL is the connection's own from here on (reached, shown, recorded).
    url = grant.url ?? url;
    const cache = this.cachePath(grant.cacheKey);
    const upstream: Upstream = { ...grant.upstream, runDir: join(this.#base, "run") };
    if (gone.signal.aborted) {
      sessionGone.delete(gone);
      this.#gone.delete(gone);
      return;
    }
    const served: { leave?: () => void } = {};
    try {
      // The lock is the refresh's alone: serving (and an owner's card) doesn't hold up other sessions' requests.
      const since = Date.now();
      const generation = this.#generations.get(grant.cacheKey) ?? 0;
      const disconnected = () => (this.#generations.get(grant.cacheKey) ?? 0) !== generation;
      const fresh = await this.#locked(grant.cacheKey, async (): Promise<RemoteState | { error: string }> => {
       try {
        // Its agent gone while it waited (no clone started for nobody), or the connection removed meanwhile.
        if (gone.signal.aborted) return { error: "the agent's git was gone" };
        const down = this.#down.get(grant.cacheKey);
        if (down && down.until > Date.now()) return { error: `${down.error} (codeoid tries it again in ${Math.ceil((down.until - Date.now()) / 1000)}s)` };
        if (disconnected()) return { error: `${shownGitUrl(url)} was disconnected` };
        sweepQuarantines(cache);
        let stop = this.#cloneStops.get(grant.cacheKey);
        if (!stop || stop.signal.aborted) {
          stop = new AbortController();
          this.#cloneStops.set(grant.cacheKey, stop);
        }
        // Not while a push's receive-pack updates the cache's refs (see #enterRefUpdate).
        const r = await this.#refreshing(grant.cacheKey, () => refreshCache(cache, upstream, grant.ssh, this.#upstreamTimeoutMs, gone.signal, stop.signal));
        if ("error" in r && /timed out/.test(r.error)) this.#down.set(grant.cacheKey, { until: Date.now() + 60_000, error: r.error });
        else if (!("error" in r)) this.#down.delete(grant.cacheKey);
        // The remote deleted or rewrote something (judged from every ref the cache has had, however that refresh
        // ended): the cache drops it before anything more is served from it, once what is served on it is done
        // (fetches are stopped; none starts meanwhile: they wait on this lock).
        // Check refs of pushes no longer running (a daemon stopped mid-check): removed; what they reached is then judged.
        await sweepCheckRefs(cache, this.#checking);
        if (await cacheDirty(cache, this.#checking)) {
          if (!(await this.#drained(grant.cacheKey)) || !(await pruneCache(cache, this.#checking))) return { error: "codeoid is clearing what the remote deleted from its copy: try again in a few minutes" };
        }
        if ("error" in r) return r;
        served.leave = this.#enter(grant.cacheKey, service === "git-upload-pack" ? "fetch" : "push", () => {
          // Stopped for a prune: said and recorded (the agent's git just sees its connection end).
          this.#host.report(sessionId, { kind: service === "git-upload-pack" ? "fetch" : "push", url, ok: false, detail: "stopped: codeoid was clearing what the remote deleted from its copy (try again)" });
          gone.abort();
          c.destroy();
        });
        return r;
       } catch (err) {
        // Anything that throws is an answer, never a git left waiting for one.
        return { error: `codeoid's copy of the remote couldn't be brought up to date (${hidePaths(err instanceof Error ? err.message : String(err))})` };
       }
      });
      if (gone.signal.aborted) return;
      if (disconnected()) return fail(`${shownGitUrl(url)} was disconnected`);
      if (!("error" in fresh) && fresh.defaultKnown) this.#host.remoteHeads?.(sessionId, url, fresh.heads, since);
      if ("error" in fresh) {
        this.#host.report(sessionId, { kind: service === "git-receive-pack" ? "push" : "fetch", url, ok: false, detail: fresh.error });
        return fail(fresh.error);
      }
      const ticket = randomBytes(24).toString("hex");
      if (service === "git-receive-pack") this.#tickets.set(ticket, { sessionId, grant: { ...grant, upstream }, url, cache, remote: fresh, gone, disconnected, stopLimit: () => clearTimeout(limit) });
      try {
        if (c.destroyed) return;
        c.write("ok\n");
        const code = await this.#serve(service, cache, c, rest, ticket, protocol, (why) => this.#host.report(sessionId, { kind: "fetch", url, ok: false, detail: why }));
        if (service === "git-upload-pack" && code === 0) this.#host.report(sessionId, { kind: "fetch", url, ok: true, detail: `fetched from ${shownGitUrl(url)}` });
        // A push whose commands came but whose check never ran: git refused it first (its pack, a connection cut), and
        // that is recorded as well, so a failed push always leaves a trace.
        if (service === "git-receive-pack" && this.#tickets.has(ticket) && this.#commandsSeen.has(ticket)) {
          this.#host.report(sessionId, { kind: "push", url, ok: false, detail: "the push ended before codeoid checked it (git didn't take its pack, or the connection was cut): nothing was pushed" });
        }
      } finally {
        this.#tickets.delete(ticket);
        this.#commandsSeen.delete(ticket);
      }
    } finally {
      sessionGone.delete(gone);
      this.#gone.delete(gone);
      served.leave?.();
    }
  }

  /** git's own server on the cache, its stdio the client's, until it exits. */
  #serve(service: GitService, cache: string, c: Socket, rest: Buffer, ticket: string, _protocol: string, onRefused?: (why: string) => void): Promise<number | null> {
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
      // The client's pack is kept whole in the quarantine (never unpacked loose, which skips objects the cache already
      // holds): what the push brought is what objectsNotSent sees.
      ["receive.unpackLimit", "1"],
      ["transfer.unpackLimit", "1"],
      ["uploadpack.allowAnySHA1InWant", "false"],
      // No partial clones: their lazy fetches want objects by id, which this server never serves; a client asking for
      // a filter is told so and clones whole.
      ["uploadpack.allowFilter", "false"],
      // A sparse filter names a blob to read as patterns: never one the client picks.
      ["uploadpackfilter.sparse:oid.allow", "false"],
      // A push's check refs are codeoid's own: never shown, fetched or pushed to.
      ["uploadpack.hideRefs", "refs/codeoid-check"],
      ["receive.hideRefs", "refs/codeoid-check"],
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
      const commands = service === "git-receive-pack" ? new CommandReader(() => this.#commandsSeen.add(ticket)) : null;
      // A fetch's lines are read on the way too: nothing in them names an object no ref reaches (upload-filter.ts).
      const filter =
        service === "git-upload-pack"
          ? new UploadFilter(
              (ids) => reachedFromRefs(cache, ids),
              () => advertisedNames(cache),
              (b) => write(b),
              (why) => {
                ended = true;
                // Said to the agent's git (`remote error: …`) and recorded; then the request ends.
                const msg = Buffer.from(`ERR codeoid: ${why}`, "utf8");
                if (!c.destroyed) c.write(Buffer.concat([Buffer.from((msg.length + 4).toString(16).padStart(4, "0")), msg]));
                onRefused?.(why);
                c.end();
                setTimeout(() => c.destroy(), 1_000).unref?.();
              },
            )
          : null;
      const endInput = () => (filter ? filter.end(() => endStdin()) : endStdin());
      // What git hasn't read yet isn't read from the agent's socket (a push waiting on its card reads nothing more):
      // the daemon holds no more than a pipe's worth.
      // What git hasn't read yet isn't read from the agent's socket (backpressure: the daemon holds a pipe's worth).
      // receive-pack stops reading only once the whole pack is in and its hook runs, and a client sends nothing
      // after its pack: from then on the socket is read again (so an agent's git that goes is seen while the owner is
      // asked), and anything but the end of its input ends the request.
      let paused = false;
      let hookPhase = false;
      const write = (b: Buffer) => {
        lastWrite = Date.now();
        if (p.stdin.write(b) || paused) return;
        paused = true;
        c.pause();
        p.stdin.once("drain", () => {
          paused = false;
          c.resume();
        });
      };
      // git's stdin is ended a moment after the client's input ended and its last write went out: on Bun 1.3 an end
      // right after a write can drop that write's last bytes (a large push's pack cut short: "early EOF"), and a
      // client whose own pack failed half way must still be answered (git waits for the rest until its input ends).
      let lastWrite = Date.now();
      const endStdin = () => {
        const tryEnd = () => {
          if (p.exitCode !== null || p.stdin.destroyed) return;
          if (paused || p.stdin.writableLength > 0 || Date.now() - lastWrite < 1_000) {
            setTimeout(tryEnd, 200).unref?.();
            return;
          }
          p.stdin.end();
        };
        setTimeout(tryEnd, 200).unref?.();
      };
      const t = this.#tickets.get(ticket);
      if (t) {
        t.onHook = () => {
          hookPhase = true;
          c.resume();
        };
      }
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
            endInput();
            return;
          }
          if (hookPhase) {
            // After its pack, a client sends nothing but the end of its input.
            ended = true;
            c.destroy();
            return;
          }
          if (buf.length < 4 + n) return;
          const chunk = buf.subarray(4, 4 + n);
          if (commands && !commands.ok(chunk)) {
            ended = true;
            c.destroy();
            return;
          }
          // A copy: a socket's read buffer may be reused once this returns, and a write git hasn't taken yet is queued.
          if (filter) filter.push(Buffer.from(chunk));
          else write(Buffer.from(chunk));
          buf = buf.subarray(4 + n);
        }
      };
      c.on("data", take);
      take(Buffer.alloc(0));
      c.on("end", () => {
        if (!ended) endInput();
      });
      p.stdout.pipe(c, { end: false });
      const finish = (code: number | null) => {
        if (t) t.served = true;
        t?.releaseRefUpdate?.();
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

  /** Per cache: pushes in their ref-update window, and whether a refresh is fetching into its refs. */
  readonly #refUpdates = new Map<string, number>();
  readonly #fetching = new Set<string>();

  /** Run a refresh's fetch once no push is updating the cache's refs; none starts until it's done. */
  async #refreshing<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while ((this.#refUpdates.get(key) ?? 0) > 0) await new Promise((r) => setTimeout(r, 20));
    this.#fetching.add(key);
    try {
      return await fn();
    } finally {
      this.#fetching.delete(key);
    }
  }

  /** Enter a push's ref-update window once no refresh is fetching; the returned function leaves it (once). */
  async #enterRefUpdate(key: string): Promise<() => void> {
    while (this.#fetching.has(key)) await new Promise((r) => setTimeout(r, 20));
    this.#refUpdates.set(key, (this.#refUpdates.get(key) ?? 0) + 1);
    let left = false;
    // Bounded: a receive-pack that never exits doesn't hold refreshes off for ever. Longer than everything the window
    // covers (the last check's ls-remote, fetch and walk, the upstream push, receive-pack's ref update).
    const timer = setTimeout(() => leave(), 15 * 60_000);
    timer.unref?.();
    const leave = () => {
      if (left) return;
      left = true;
      clearTimeout(timer);
      const n = (this.#refUpdates.get(key) ?? 1) - 1;
      if (n > 0) this.#refUpdates.set(key, n);
      else this.#refUpdates.delete(key);
    };
    return leave;
  }

  /** Note what is served on a cache (a fetch, a push and its upstream push) until the returned function is called. */
  #enter(key: string, kind: "fetch" | "push", stop: () => void = () => {}): () => void {
    let m = this.#serving.get(key);
    if (!m) {
      m = new Map();
      this.#serving.set(key, m);
    }
    const id = Symbol(kind);
    const mine = m;
    mine.set(id, { kind, stop });
    return () => {
      mine.delete(id);
      if (mine.size === 0 && this.#serving.get(key) === mine) this.#serving.delete(key);
    };
  }

  /** Stop the fetches served on a cache and wait (bounded) for its pushes to end: true when nothing is served on it. */
  async #drained(key: string, ms = 3 * 60_000): Promise<boolean> {
    for (const e of this.#serving.get(key)?.values() ?? []) if (e.kind === "fetch") e.stop();
    const until = Date.now() + ms;
    while ((this.#serving.get(key)?.size ?? 0) > 0) {
      if (Date.now() > until || this.#closed) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  /** Remove a connection's cache (it was disconnected): nothing the remote had is kept, nor reused by a reconnect. */
  // paths: the daemon's own cache repository for that connection, removed under its lock
  forget(cacheKey: string): Promise<void> {
    // Requests granted before this see their generation gone; a first clone running for it is stopped; the removal
    // waits its turn on the lock without holding up the caller (a disconnect answers at once).
    this.#generations.set(cacheKey, (this.#generations.get(cacheKey) ?? 0) + 1);
    this.#cloneStops.get(cacheKey)?.abort();
    this.#cloneStops.delete(cacheKey);
    return this.#locked(cacheKey, async () => {
      rmSync(this.cachePath(cacheKey), { recursive: true, force: true });
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
    t.onHook?.();
    // An approved push isn't cut off by the request's limit while it goes upstream (the agent would read a failure
    // for a push the remote took); the upstream push and the window are bounded on their own.
    t.stopLimit?.();
    // Served on its cache until the upstream push is done (the agent's git there or not): no prune runs under it.
    const leave = this.#enter(t.grant.cacheKey, "push");
    try {
      await this.#decide(t, req, say, verdict);
    } catch (err) {
      // Anything that throws is a refusal said to the agent's git and recorded, never a hook left waiting.
      const why = `the push couldn't be checked (${hidePaths(err instanceof Error ? err.message : String(err))})`;
      say(`codeoid refused the push: ${why}`);
      this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: false, detail: why });
      verdict(false);
    } finally {
      leave();
      // Refused (or thrown): nothing will update the cache's refs, so the window closes now; an "ok" keeps it to the
      // serve's end (closed then, or now if that already came).
      if (!t.verdictOk || t.served) t.releaseRefUpdate?.();
    }
  }

  async #decide(t: Ticket, req: { ticket?: unknown; updates?: unknown; objects?: { dir?: unknown; alternates?: unknown } }, say: (line: string) => void, verdict: (ok: boolean) => void): Promise<void> {
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
    // Every object the new tips need past what the remote's refs reach came with the push: never one the cache kept
    // after the remote deleted it.
    const unsent = await objectsNotSent(t.cache, objects, updates.map((u) => u.new));
    if (unsent) return refuse(unsent);
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
    // The owner disconnected the remote while the card was up: nothing is pushed with what they took back.
    if (t.disconnected()) return refuse(`${shownGitUrl(t.url)} was disconnected`);
    // From here until this push's receive-pack exits, no refresh fetches into the cache's refs: one could move the
    // pushed branch's ref after the upstream push and before receive-pack's own update, which would then fail (and the
    // agent would read "rejected" for a push the remote took). Released on every way out (#onHook, the serve's end).
    t.releaseRefUpdate = await this.#enterRefUpdate(t.grant.cacheKey);
    if (t.served) t.releaseRefUpdate();
    // The remote may have deleted something since the refresh (a connection held open, a card answered late): judged
    // again against what it says it has now, so nothing it no longer has goes back to it.
    const now = await remoteRefs(t.grant.upstream, t.grant.ssh);
    if ("error" in now) return refuse(now.error);
    // What the remote has that the cache doesn't (a branch moved on meanwhile) is fetched first, apart, so the check
    // judges against all of it.
    const ns = randomBytes(8).toString("hex");
    let late: string | null;
    this.#checking.add(ns);
    try {
      let known = await cacheHas(t.cache, now.map((r) => r.oid));
      if ("error" in known) return refuse(known.error);
      const have = new Set(known);
      const missing = now.filter((r) => !have.has(r.oid)).map((r) => r.name);
      if (missing.length > 0) {
        const fetched = await fetchCheckRefs(t.cache, t.grant.upstream, t.grant.ssh, ns, missing);
        if (fetched) return refuse(fetched);
        known = await cacheHas(t.cache, now.map((r) => r.oid));
        if ("error" in known) return refuse(known.error);
        // Still some the cache doesn't have (the remote moved on again, other pushes landing): judged against what it
        // knows. A ref it doesn't know can only make more reachable, so nothing the remote deleted gets through this way.
      }
      late = await objectsNotSent(t.cache, objects, updates.map((u) => u.new), known);
    } finally {
      await dropCheckRefs(t.cache, ns);
      this.#checking.delete(ns);
    }
    if (late) return refuse(late);
    if (t.disconnected()) return refuse(`${shownGitUrl(t.url)} was disconnected`);
    // Approved and started: it finishes (bounded by its own limit), the agent's git there or not, so what the remote
    // took is what is recorded; only the gateway stopping ends it.
    // The agent's git gone (killed, its session destroyed) while the last check ran: nothing is pushed for it.
    if (t.gone.signal.aborted) {
      this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: false, detail: "the agent's git was gone before the push started, so nothing was pushed", updates });
      return verdict(false);
    }
    const pushed = await pushUpstream(t.cache, t.grant.upstream, t.grant.ssh, updates, objects, this.#upstreamTimeoutMs, this.#closing.signal);
    if (!pushed.ok && this.#closing.signal.aborted) {
      const why = "the daemon stopped while the push ran: the remote may or may not have taken it (fetch to see)";
      this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: false, detail: why, updates });
      say(why);
      return verdict(false);
    }
    if (!pushed.ok) {
      say(pushed.error);
      this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: false, detail: pushed.error, updates });
      return verdict(false);
    }
    say(`codeoid pushed ${updates.map((u) => u.ref.replace(/^refs\/heads\//, "")).join(", ")} to ${shownGitUrl(t.url)}`);
    this.#host.report(t.sessionId, { kind: "push", url: t.url, ok: true, detail: `pushed to ${shownGitUrl(t.url)}`, updates });
    // receive-pack updates the cache's refs right after this "ok", inside the window (held until it exits).
    t.verdictOk = true;
    verdict(true);
  }
}

/** A message with the daemon's own paths (its cache, its gateway dir) taken out: what an agent may read. */
function hidePaths(s: string): string {
  return s.replace(/\/[^\s'"]*\/git-gateway\/[^\s'"]*/g, "<codeoid's cache>");
}

/** Remove the temp dirs of first clones that never finished (a daemon stopped mid-clone). */
// paths: the daemon's own cache dir: its `*.tmp-*` entries, removed
function sweepTempClones(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (/\.git\.tmp-[0-9a-f]+$/.test(n)) rmSync(join(dir, n), { recursive: true, force: true });
}

/** Reads receive-pack's command pkt-lines as they stream by (to the first flush), and says whether they may go on. */
export class CommandReader {
  #buf: Buffer = Buffer.alloc(0);
  #done = false;
  #commands = 0;
  /** `onCommands`: the command list ended (at its flush) with at least one command. */
  constructor(private readonly onCommands: () => void = () => {}) {}
  ok(chunk: Buffer): boolean {
    if (this.#done) return true;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    while (this.#buf.length >= 4) {
      const n = Number.parseInt(this.#buf.subarray(0, 4).toString("latin1"), 16);
      if (Number.isNaN(n)) return false;
      if (n === 0) {
        this.#done = true;
        this.#buf = Buffer.alloc(0);
        if (this.#commands > 0) this.onCommands();
        return true;
      }
      if (n < 4 || n > 65520) return false;
      if (this.#buf.length < n) return true;
      // One trailing line feed is pkt-line's own; any other control character in the ref is refused.
      const raw = this.#buf.subarray(4, n);
      const line = raw.toString("latin1").replace(/\n$/, "");
      this.#buf = this.#buf.subarray(n);
      if (line.startsWith("shallow ")) continue;
      // A signed push or anything but `old new ref[\0caps]`: not taken.
      const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([^\0]*)(\0.*)?$/s.exec(line);
      // The ref exactly as the hook will read it: no control character or space, valid UTF-8 (else the hook, the
      // card and the remote would see another name than git keeps).
      if (!m?.[3] || /[\x00-\x20\x7f]/.test(m[3])) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(m[3], "latin1"));
      } catch {
        return false;
      }
      this.#commands++;
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
