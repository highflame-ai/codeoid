/**
 * OpencodeServer — the one private `opencode serve` a codeoid daemon runs.
 *
 * Started lazily, by the first opencode session's first turn; shared by every
 * opencode session after that; started again on next use if it dies; stopped
 * with the daemon (`stopOpencodeServers`, and opencode's own stdin lease: the
 * server exits when the pipe codeoid holds closes, so it can't outlive a
 * daemon that was killed).
 *
 * Launch: `opencode serve --stdio --port 0 --hostname 127.0.0.1`, which prints
 * one JSON line `{"url": ...}` when it listens. A fresh random password per
 * start (`OPENCODE_PASSWORD`, HTTP Basic). The database is codeoid's
 * (`OPENCODE_DB`), never the user's, and codeoid's policy rides in
 * `OPENCODE_CONFIG_CONTENT` (policy.ts).
 *
 * Before a server is handed out it must: report a supported version
 * (`GET /api/info`), accept the password, and pass the agent check
 * (policy.ts, layer 3) — restarting once with overrides if needed.
 *
 * The live feed (`GET /api/event`) is read here once for all sessions and
 * fanned out; each provider filters for its own sessions. The durable
 * per-session logs are read by the providers themselves.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OpencodeClient, OpencodeHttpError, type OcEvent, type OcRule } from "./client.js";
import { agentOverrides, buildOpencodeEnv, opencodeConfig, serverEnv, unsafeAgents } from "./policy.js";
import { opencodeVersionProblem } from "./resolve.js";

/** Live-feed event types the providers read (the rest arrive on the durable logs). */
export const LIVE_EVENT_TYPES = [
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.step.ended",
  "session.created",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const;

const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_000;
const STDERR_TAIL_BYTES = 4_096;
/** How long `ensure` waits for the live feed's first `server.connected`. */
const FEED_READY_MS = 5_000;

/** The server reported a version codeoid doesn't speak. */
export class OpencodeIncompatibleError extends Error {
  override name = "OpencodeIncompatibleError";
}

export interface OpencodeServerOptions {
  command: string;
  argsPrefix?: string[];
  /** opencode's database (codeoid's data dir, see `opencodeDbPath`). */
  dbPath: string;
  /** Base environment, allow-listed; codeoid's server settings go over it. */
  env?: () => Record<string, string>;
  startTimeoutMs?: number;
  /** Told once a server reports a version outside the supported range. */
  onIncompatible?: (hint: string) => void;
}

/** One running server, as handed to a provider. `generation` changes on every start. */
export interface OpencodeConnection {
  client: OpencodeClient;
  generation: number;
  pid: number | undefined;
}

export interface OpencodeServerListener {
  onEvent(event: OcEvent): void;
  /** The live feed (re)connected: events in a gap may be lost, so re-read what's pending. */
  onResync?(conn: OpencodeConnection): void;
  /** The server process is gone, and everything pending on it with it. */
  onLost?(reason: string): void;
}

interface Launched {
  proc: ChildProcessWithoutNullStreams;
  client: OpencodeClient;
  exited: Promise<void>;
  stderrTail: () => string;
}

/** Every server started in this process, so the daemon can stop them on shutdown. */
const LIVE_SERVERS = new Set<OpencodeServer>();

/** Stop every opencode server this process started (daemon shutdown). */
export async function stopOpencodeServers(): Promise<void> {
  await Promise.all([...LIVE_SERVERS].map((s) => s.stop()));
}

export class OpencodeServer {
  readonly #opts: OpencodeServerOptions;
  readonly #listeners = new Set<OpencodeServerListener>();
  #launched: Launched | null = null;
  #conn: OpencodeConnection | null = null;
  #starting: Promise<OpencodeConnection> | null = null;
  #generation = 0;
  /** Agent overrides learned from a server's own agent list; kept for restarts. */
  #overrides: Record<string, { permissions: OcRule[] }> = {};
  #feedAbort: AbortController | null = null;
  #feedReady: Promise<void> | null = null;

  constructor(opts: OpencodeServerOptions) {
    this.#opts = opts;
  }

  /** The running server's pid, when one runs. */
  get pid(): number | undefined {
    return this.#launched?.proc.pid;
  }

  get running(): boolean {
    return this.#conn !== null;
  }

  listen(listener: OpencodeServerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The running server, starting one if none runs. Concurrent callers share one start. */
  async ensure(): Promise<OpencodeConnection> {
    if (this.#conn) return this.#conn;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    const conn = await this.#starting;
    await this.#feedReady;
    return conn;
  }

  async stop(): Promise<void> {
    const launched = this.#launched;
    this.#detach("opencode server stopped");
    if (launched) await shutdown(launched);
    LIVE_SERVERS.delete(this);
  }

  async #start(): Promise<OpencodeConnection> {
    mkdirSync(dirname(this.#opts.dbPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      const launched = await this.#launch();
      try {
        const info = await launched.client.info();
        const problem = opencodeVersionProblem(info?.version);
        if (problem) {
          this.#opts.onIncompatible?.(problem);
          throw new OpencodeIncompatibleError(problem);
        }
        // Also the auth check: /api/info answers without credentials.
        const agents = await launched.client.agents();
        const unsafe = unsafeAgents(agents);
        if (unsafe.length > 0) {
          if (attempt === 0) {
            // Learned from this server's own agents; the restart applies them.
            this.#overrides = { ...this.#overrides, ...agentOverrides(agents) };
            await shutdown(launched);
            continue;
          }
          throw new Error(
            `opencode agents ${unsafe.map((a) => JSON.stringify(a.id)).join(", ")} would run tools without asking codeoid, even with codeoid's overrides — refusing to use this opencode server`,
          );
        }
        return this.#adopt(launched);
      } catch (err) {
        await shutdown(launched);
        if (err instanceof OpencodeHttpError && err.status === 401) {
          throw new Error("opencode refused codeoid's password — another server may be answering on its port");
        }
        throw err;
      }
    }
  }

  async #launch(): Promise<Launched> {
    const password = randomBytes(32).toString("base64url");
    const env = {
      ...(this.#opts.env?.() ?? buildOpencodeEnv()),
      ...serverEnv({ password, dbPath: this.#opts.dbPath, config: opencodeConfig(this.#overrides) }),
    };
    const proc = spawn(
      this.#opts.command,
      [...(this.#opts.argsPrefix ?? []), "serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"],
      // Requests name their directory; the server's own cwd is only its default.
      { cwd: dirname(this.#opts.dbPath), stdio: ["pipe", "pipe", "pipe"], env },
    );
    // A child that dies mid-write must not crash the daemon.
    proc.stdin.on("error", () => {});
    let stderrTail = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.once("error", () => resolve());
    });
    const url = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => fail(new Error(`opencode didn't report its address within ${this.#opts.startTimeoutMs ?? START_TIMEOUT_MS}ms`)), this.#opts.startTimeoutMs ?? START_TIMEOUT_MS);
      const fail = (err: Error) => {
        clearTimeout(timer);
        proc.off("error", onError);
        proc.off("exit", onExit);
        proc.kill("SIGKILL");
        reject(new Error(`${err.message}${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`));
      };
      const onError = (err: Error) => fail(new Error(`opencode failed to start: ${err.message}`));
      const onExit = (code: number | null, signal: string | null) => fail(new Error(`opencode exited before it was ready (code=${code} signal=${signal})`));
      proc.once("error", onError);
      proc.once("exit", onExit);
      proc.stdout.setEncoding("utf8");
      // Keep draining stdout after readiness so later writes can't block it.
      proc.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          let ready: { url?: unknown } | null = null;
          try {
            ready = JSON.parse(line) as { url?: unknown };
          } catch {
            continue;
          }
          if (typeof ready?.url !== "string") continue;
          clearTimeout(timer);
          proc.off("error", onError);
          proc.off("exit", onExit);
          if (!isLoopbackUrl(ready.url)) {
            fail(new Error(`opencode listened on ${ready.url}, not on this machine only`));
            return;
          }
          resolve(ready.url);
          return;
        }
      });
    });
    const client = new OpencodeClient({ baseUrl: url, password });
    return { proc, client, exited, stderrTail: () => stderrTail };
  }

  #adopt(launched: Launched): OpencodeConnection {
    this.#launched = launched;
    this.#generation++;
    const conn: OpencodeConnection = { client: launched.client, generation: this.#generation, pid: launched.proc.pid };
    this.#conn = conn;
    LIVE_SERVERS.add(this);
    launched.proc.once("exit", (code, signal) => {
      if (this.#launched !== launched) return;
      const tail = launched.stderrTail();
      this.#detach(`opencode exited (code=${code} signal=${signal})${tail ? `: ${tail.slice(-500)}` : ""}`);
    });
    const abort = new AbortController();
    this.#feedAbort = abort;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    // Don't hold a start up forever on a feed that never connects; the
    // resync on its eventual connect catches up.
    this.#feedReady = Promise.race([ready, Bun.sleep(FEED_READY_MS)]);
    void this.#runFeed(conn, abort.signal, markReady);
    return conn;
  }

  /** Forget the current server: everything pending on it is lost. */
  #detach(reason: string): void {
    const had = this.#conn !== null;
    this.#feedAbort?.abort();
    this.#feedAbort = null;
    this.#feedReady = null;
    this.#launched = null;
    this.#conn = null;
    if (!had) return;
    for (const l of [...this.#listeners]) {
      try {
        l.onLost?.(reason);
      } catch (err) {
        console.error(`[opencode-server] a listener failed on server loss: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async #runFeed(conn: OpencodeConnection, signal: AbortSignal, ready: () => void): Promise<void> {
    let backoff = 250;
    let filtered = true;
    while (!signal.aborted && this.#conn === conn) {
      try {
        for await (const event of conn.client.events(filtered ? LIVE_EVENT_TYPES : [], signal)) {
          if (event.type === "server.connected") {
            backoff = 250;
            ready();
            for (const l of [...this.#listeners]) l.onResync?.(conn);
            continue;
          }
          for (const l of [...this.#listeners]) {
            try {
              l.onEvent(event);
            } catch (err) {
              console.error(`[opencode-server] a listener failed on ${event.type}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        // A version that renamed one of the filtered types rejects the whole
        // query: read everything instead of reading nothing.
        if (err instanceof OpencodeHttpError && err.status === 400) filtered = false;
      }
      if (signal.aborted) return;
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 5_000);
    }
  }
}

/** End a server's lease (close its stdin), then signal it if it lingers. */
async function shutdown(launched: Launched): Promise<void> {
  const { proc } = launched;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.stdin.end();
  const gone = await Promise.race([launched.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
  if (gone) return;
  proc.kill("SIGTERM");
  const termed = await Promise.race([launched.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
  if (!termed) proc.kill("SIGKILL");
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
