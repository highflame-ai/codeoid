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
 * (`OPENCODE_DB`), never the user's, so is its global config directory
 * (`OPENCODE_CONFIG_DIR`, `config/` beside the database), and so are its
 * data, logs, state and caches (its XDG base dirs, under
 * `providers.opencode.dataDir`). codeoid's policy rides in
 * `OPENCODE_CONFIG_CONTENT` (policy.ts), with the provider and model keys of
 * the user's own global config and codeoid's own credentials: written at
 * each start to files in this daemon's dir of `codeoid-credentials/`
 * (beside the database), which the config names
 * (credentials.ts). The server's environment carries no credential.
 *
 * Before a server is handed out it must: report a supported version
 * (`GET /api/info`), accept the password, pass the agent check (policy.ts,
 * layer 3) — restarting once with overrides if needed — and run no plugin
 * but opencode's built-ins. The plugin check is made again for each
 * session's location before every turn (`checkPlugins`); a server that fails
 * it is stopped.
 *
 * The live feed (`GET /api/event`) is read here once for all sessions and
 * fanned out; each provider filters for its own sessions. It is the only
 * stream: it carries the sessions' durable events as well.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OPENCODE_MODEL_ID } from "../../../config.js";
import { OpencodeClient, OpencodeHttpError, type OcEvent, type OcRule } from "./client.js";
import { clearOpencodeCredentials, type OpencodeCredentialInputs, planOpencodeCredentials, writeOpencodeCredentials } from "./credentials.js";
import {
  agentOverrides,
  buildOpencodeEnv,
  describePlugin,
  foreignPlugins,
  opencodeConfig,
  opencodeServerDirs,
  opencodeServerShell,
  serverEnv,
  unsafeAgents,
  userModelConfig,
  userOpencodeConfigDir,
} from "./policy.js";
import { opencodeCredentialsDir, opencodeVersionProblem, recordOpencodeDbPath } from "./resolve.js";

/**
 * Live-feed event types the providers read: every session's durable events
 * (opencode 2.2's per-session log endpoint delivers none) and the ephemeral
 * ones. All accepted by the filter on 2.2.2 and 2.2.5; an unknown type makes
 * the server refuse the whole query (see #runFeed).
 */
export const LIVE_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.delivered",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.usage.updated",
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
  /** codeoid's record of the databases its servers ran with (`opencodeLocationsFile`); `dbPath` is added before each start. */
  locationsFile?: string;
  /** opencode's data, logs, state and caches (`opencodeDataDir`). Default: the database's folder. */
  dataDir?: string;
  /** Base environment, credential-free (`buildOpencodeEnv`); codeoid's server settings go over it. */
  env?: () => Record<string, string>;
  /** codeoid's credentials to hand opencode (credentials.ts), read at each start. */
  credentials?: () => OpencodeCredentialInputs | Promise<OpencodeCredentialInputs>;
  /** The default model (`providers.opencode.model`, `provider/model`); absent: opencode's. */
  defaultModel?: string;
  startTimeoutMs?: number;
  /** Told once a server reports a version outside the supported range. */
  onIncompatible?: (hint: string) => void;
  /** Model providers added to the server's config (opencode's `providers`; tests point one at a local scripted model). */
  modelProviders?: Record<string, unknown>;
  /** The user's own opencode global config dir, whose provider and model keys are carried over; null: none. Default: as opencode finds it. */
  userConfigDir?: string | null;
}

/** A server running a plugin codeoid doesn't know: refused. */
export class OpencodeUntrustedError extends Error {
  override name = "OpencodeUntrustedError";
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
  /** The empty directory it runs in (`opencodeServerCwd`). */
  cwd: string;
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
  /** The process a start launched and hasn't adopted yet. */
  #launching: Launched["proc"] | null = null;
  /** Bumped by every stop: a start it overtook gives up what it launched. */
  #stops = 0;
  #generation = 0;
  /** Agent overrides learned from a server's own agent list; kept for restarts. */
  #overrides: Record<string, { permissions: OcRule[] }> = {};
  #feedAbort: AbortController | null = null;
  #feedReady: Promise<void> | null = null;
  #home: string | undefined;

  constructor(opts: OpencodeServerOptions) {
    this.#opts = opts;
  }

  /** The running server's pid, when one runs. */
  get pid(): number | undefined {
    return this.#launched?.proc.pid;
  }

  /** The empty directory the running server was started in. */
  get cwd(): string | undefined {
    return this.#launched?.cwd;
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
    // A daemon shutdown reaches a start in flight too.
    LIVE_SERVERS.add(this);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    const conn = await this.#starting;
    await this.#feedReady;
    return conn;
  }

  /** Stop the server; `reason` is what its sessions are told. */
  async stop(reason = "opencode server stopped"): Promise<void> {
    const launched = this.#launched;
    const starting = this.#starting;
    this.#stops++;
    this.#detach(reason);
    // Before any await: a start that follows writes them again, and must not lose them to this.
    if (launched) clearOpencodeCredentials([this.credentialsDir]);
    // A start in flight gives up (#start): what it launched is told to go now, and is waited out.
    this.#launching?.stdin.end();
    if (launched) await shutdown(launched);
    if (starting) await starting.catch(() => {});
    if (!this.#conn && !this.#starting) LIVE_SERVERS.delete(this);
  }

  /**
   * Refuse a server that runs a plugin opencode doesn't ship, for
   * `directory`'s location (the server's own when omitted): a plugin can
   * settle permission requests itself, so codeoid would never see them.
   * The server is stopped (the next turn starts a new one, which is checked
   * again). The location must have been used (a request naming it) for its
   * plugins to be listed.
   */
  async checkPlugins(conn: OpencodeConnection, directory?: string): Promise<void> {
    const foreign = foreignPlugins(await conn.client.plugins(directory));
    if (foreign.length === 0) return;
    const reason = untrustedPlugins(foreign.map(describePlugin));
    console.error(`[opencode-server] ${reason}`);
    if (this.#conn === conn) await this.stop(reason);
    throw new OpencodeUntrustedError(reason);
  }

  /**
   * Stop the server because it did something codeoid can't allow (a call
   * that ran without asking). `told` is what its sessions are told: the
   * session that saw it says why itself.
   */
  async distrust(conn: OpencodeConnection, reason: string, told = reason): Promise<void> {
    console.error(`[opencode-server] stopping the server: ${reason}`);
    if (this.#conn === conn) await this.stop(told);
  }

  /** codeoid's own config dir for the server (`OPENCODE_CONFIG_DIR`): nothing in it but what codeoid puts there. */
  get configDir(): string {
    return join(dirname(this.#opts.dbPath), "config");
  }

  /** Where the credential files the injected config names live (0700; only codeoid's). */
  get credentialsDir(): string {
    return opencodeCredentialsDir(this.#opts.dbPath);
  }

  /** Where opencode's data, logs, state and caches go. */
  get dataDir(): string {
    return this.#opts.dataDir ?? dirname(this.#opts.dbPath);
  }

  /** Where `~` in a tool call's path leads on this server: the home it started with (opencode's `Global.Path.home`). */
  get home(): string {
    return this.#home ?? homeOf(this.#opts.env?.() ?? buildOpencodeEnv());
  }

  async #start(): Promise<OpencodeConnection> {
    const stops = this.#stops;
    try {
      return await this.#startChecked(stops);
    } catch (err) {
      // A server refused (or never up) reads no key: its files go with it.
      clearOpencodeCredentials([this.credentialsDir]);
      if (this.#stops !== stops) throw new Error("opencode server stopped while it was starting");
      throw err;
    } finally {
      this.#launching = null;
    }
  }

  /** `stops`: the stop count the start began at; a stop since (a daemon shutdown) and it gives up, never adopting a server. */
  async #startChecked(stops: number): Promise<OpencodeConnection> {
    const overtaken = () => {
      if (this.#stops !== stops) throw new Error("opencode server stopped while it was starting");
    };
    mkdirSync(dirname(this.#opts.dbPath), { recursive: true, mode: 0o700 });
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    for (const dir of Object.values(opencodeServerDirs(this.dataDir))) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      overtaken();
      const launched = await this.#launch();
      try {
        overtaken();
        const info = await launched.client.info();
        const problem = opencodeVersionProblem(info?.version);
        if (problem) {
          this.#opts.onIncompatible?.(problem);
          throw new OpencodeIncompatibleError(problem);
        }
        // The auth check too (both routes need the password). It also loads
        // the server's own location, so its plugins are listed below.
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
        // Global plugins (the system config dir's, codeoid's own config dir's) show in every location.
        const foreign = foreignPlugins(await launched.client.plugins());
        if (foreign.length > 0) throw new OpencodeUntrustedError(untrustedPlugins(foreign.map(describePlugin)));
        overtaken();
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
    const userDir = this.#opts.userConfigDir === undefined ? userOpencodeConfigDir() : this.#opts.userConfigDir;
    // codeoid's keys as files, named by the config: never in the server's environment.
    const plan = planOpencodeCredentials((await this.#opts.credentials?.()) ?? { env: {} }, this.credentialsDir);
    for (const why of plan.skipped) console.error(`[opencode-server] not handed to opencode: ${why}`);
    // Before anything is kept there: the location stays covered once the config moves away.
    if (this.#opts.locationsFile) recordOpencodeDbPath(this.#opts.locationsFile, this.#opts.dbPath);
    writeOpencodeCredentials(this.credentialsDir, plan.secrets);
    const defaultModel = this.#opts.defaultModel;
    if (defaultModel && !OPENCODE_MODEL_ID.test(defaultModel)) {
      console.error(`[opencode-server] providers.opencode.model isn't a \`provider/model\` id codeoid hands opencode (no \`{\`, \`}\`, quotes or spaces): opencode's own default is used`);
    }
    const carriedSkipped: string[] = [];
    const config = opencodeConfig(
      this.#overrides,
      { ...plan.providers, ...this.#opts.modelProviders },
      userDir ? userModelConfig(userDir, carriedSkipped) : {},
      { model: this.#opts.defaultModel },
    );
    for (const why of carriedSkipped) console.error(`[opencode-server] not taken from your opencode config: ${why}`);
    const base = this.#opts.env?.() ?? buildOpencodeEnv();
    const env = {
      ...base,
      ...serverEnv({ password, dbPath: this.#opts.dbPath, configDir: this.configDir, dataDir: this.dataDir, config, shell: opencodeServerShell(base.PATH) }),
    };
    this.#home = homeOf(env);
    // Requests name their directory; the server's own cwd is only its default.
    // A shell reaches it as `/proc/$PPID/cwd`, which the gate can't follow, so
    // it holds nothing and leads nowhere: never the database's folder, beside
    // the credential files and the config.
    const cwd = opencodeServerCwd();
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.#opts.command, [...(this.#opts.argsPrefix ?? []), "serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      removeServerCwd(cwd);
      throw err;
    }
    this.#launching = proc;
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
    }).then(() => removeServerCwd(cwd));
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
    return { proc, client, exited, stderrTail: () => stderrTail, cwd };
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
      // A dead server reads no key; the restart writes them again (after this: its listeners may start it).
      clearOpencodeCredentials([this.credentialsDir]);
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

function untrustedPlugins(names: readonly string[]): string {
  return `opencode runs plugins codeoid doesn't know (${names.join(", ")}), which can settle permission requests without asking codeoid — refusing to use this opencode server. Remove them from opencode's system configuration, or from codeoid's own opencode config dir.`;
}

/**
 * A fresh, empty directory for a server to run in: made by `mkdtemp` (0700, so
 * no other user can have planted it), then made read-only so nothing lands in
 * it. Its parent is the system's temp dir, so `..` from it reaches nothing of
 * codeoid's either. Removed when the server exits.
 */
export function opencodeServerCwd(base: string = tmpdir()): string {
  const dir = mkdtempSync(join(base, "codeoid-opencode-cwd-"));
  chmodSync(dir, 0o500);
  return dir;
}

function removeServerCwd(dir: string): void {
  try {
    // Never recursive: it is only codeoid's while it is empty.
    rmdirSync(dir);
  } catch {}
}

/** opencode's home in an environment: `OPENCODE_TEST_HOME`, else `os.homedir()` (which reads `HOME`). */
function homeOf(env: Record<string, string | undefined>): string {
  return env.OPENCODE_TEST_HOME || env.HOME || homedir();
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
