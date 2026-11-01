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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { getConfigDir, OPENCODE_MODEL_ID } from "../../../config.js";
import { OpencodeClient, OpencodeHttpError, type OcEvent, type OcRule } from "./client.js";
import { clearOpencodeCredentials, fileReference, type OpencodeCredentialInputs, planOpencodeCredentials, writeOpencodeCredentials } from "./credentials.js";
import {
  agentOverrides,
  buildOpencodeEnv,
  describePlugin,
  foreignPlugins,
  formatterProblem,
  gitOverrideEnv,
  OPENCODE_GIT_ENV,
  opencodeConfig,
  opencodeServerDirs,
  OPENCODE_HG_ENV,
  opencodeServerShell,
  serverEnv,
  unsafeAgents,
  userModelConfig,
  userOpencodeConfigDir,
} from "./policy.js";
import { opencodeConfigDir, opencodeCredentialsDir, opencodeVersionProblem, recordOpencodeDbPath } from "./resolve.js";

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
  /** codeoid's own places besides the server's (its database, transcripts): the server's cwd leads to none of them (`opencodeServerCwd`). */
  codeoidPaths?: readonly string[];
  /** Where the server's cwd may be made, in order (`SERVER_CWD_BASES`; tests). */
  cwdBases?: readonly string[];
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
  /** The empty directory it runs in, and the fresh root holding it alone (`opencodeServerCwd`). */
  cwd: string;
  cwdRoot: string;
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
  #mercurial: string | null = null;
  #git: string | null = null;

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

  /** Why the running server's hg could run a repository's code (`mercurialProblem`), or null. */
  get mercurial(): string | null {
    return this.#mercurial;
  }

  /** Why the running server's git could run a repository's code (`gitProblem`), or null. */
  get git(): string | null {
    return this.#git;
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
   * settle permission requests itself, so codeoid would never see them. Or
   * one whose config turns formatters on: they run unasked after an edit.
   * The server is stopped (the next turn starts a new one, which is checked
   * again). The location must have been used (a request naming it) for its
   * plugins to be listed.
   */
  async checkPlugins(conn: OpencodeConnection, directory?: string): Promise<void> {
    const foreign = foreignPlugins(await conn.client.plugins(directory));
    // A config document that turns formatters on (`formatterProblem`) is refused the same way.
    const reason = foreign.length > 0 ? untrustedPlugins(foreign.map(describePlugin)) : formatterProblem(await conn.client.config(directory));
    if (!reason) return;
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

  /** codeoid's own config dir for the server (`OPENCODE_CONFIG_DIR`): nothing in it but what codeoid puts there (a tool call naming it is refused: `opencodeSecretLocations`). */
  get configDir(): string {
    return opencodeConfigDir(this.#opts.dbPath);
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
        // So do formatters a config document above codeoid's turns on.
        const formatters = formatterProblem(await launched.client.config());
        if (formatters) throw new OpencodeUntrustedError(formatters);
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
    // The user's own providers too: what is written literally in them goes through files as well.
    const secrets = new Map(plan.secrets);
    const carriedSkipped: string[] = [];
    const carried = userDir
      ? userModelConfig(userDir, carriedSkipped, (literal) => {
          const name = `carried-${secrets.size}.value`;
          secrets.set(name, literal);
          return fileReference(this.credentialsDir, name);
        })
      : {};
    for (const why of carriedSkipped) console.error(`[opencode-server] not taken from your opencode config: ${why}`);
    // Before anything is kept there: the location stays covered once the config moves away.
    if (this.#opts.locationsFile) recordOpencodeDbPath(this.#opts.locationsFile, this.#opts.dbPath);
    writeOpencodeCredentials(this.credentialsDir, secrets);
    const defaultModel = this.#opts.defaultModel;
    if (defaultModel && !OPENCODE_MODEL_ID.test(defaultModel)) {
      console.error(`[opencode-server] providers.opencode.model isn't a \`provider/model\` id codeoid hands opencode (no \`{\`, \`}\`, quotes or spaces): opencode's own default is used`);
    }
    const config = opencodeConfig(this.#overrides, { ...plan.providers, ...this.#opts.modelProviders }, carried, { model: this.#opts.defaultModel });
    const base = this.#opts.env?.() ?? buildOpencodeEnv();
    const env = {
      ...base,
      ...serverEnv({ password, dbPath: this.#opts.dbPath, configDir: this.configDir, dataDir: this.dataDir, config, shell: opencodeServerShell(base.PATH), path: base.PATH }),
    };
    this.#home = homeOf(env);
    // Requests name their directory; the server's own cwd is only its default.
    // A shell reaches it as `/proc/$PPID/cwd`, which the gate can't follow, so
    // it holds nothing and leads nowhere, `..` included: never the database's
    // folder, beside the credential files and the config, nor the temp dir
    // codeoid's sign-in homes are made in.
    const { cwd, root: cwdRoot } = opencodeServerCwd(
      [this.#opts.dbPath, this.configDir, this.credentialsDir, this.dataDir, ...(this.#opts.locationsFile ? [this.#opts.locationsFile] : []), getConfigDir(), ...(this.#opts.codeoidPaths ?? [])],
      this.#opts.cwdBases,
    );
    let proc: ChildProcessWithoutNullStreams;
    try {
      // The hg opencode would run in a Mercurial checkout, judged before it can run one.
      this.#mercurial = await mercurialProblem(env.PATH, cwd);
      // So is the git it runs in a git repository.
      this.#git = await gitProblem(env.PATH, cwd);
      proc = spawn(this.#opts.command, [...(this.#opts.argsPrefix ?? []), "serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      removeServerCwd(cwd, cwdRoot);
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
    }).then(() => removeServerCwd(cwd, cwdRoot));
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
    return { proc, client, exited, stderrTail: () => stderrTail, cwd, cwdRoot };
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
 * Where a server's cwd may be made, in order: shared temp dirs codeoid makes
 * nothing else in. The daemon's own temp dir is never one (`leadsToCodeoid`):
 * codeoid's sign-in homes, evidence and bridges are made there.
 */
export const SERVER_CWD_BASES: readonly string[] = ["/var/tmp", "/dev/shm", "/tmp"];

/** The fresh root a server's cwd is made in; nothing of codeoid's but such roots is named with it. */
export const SERVER_CWD_PREFIX = "codeoid-ocserver-";

/**
 * A fresh, empty directory for a server to run in, alone in a fresh root:
 * both made by `mkdtemp`/`mkdir` (0700, so no other user can have planted
 * them), then made read-only so nothing lands in them. A shell reaches the
 * cwd as `/proc/$PPID/cwd`, and any number of `..` after it, so the root is
 * made in the first of `bases` where no directory from it up to `/` holds
 * anything of codeoid's (`leadsToCodeoid`: `codeoidPaths`, the daemon's
 * temp dir, anything named codeoid). None: refused, never made where it would
 * lead somewhere. Both are removed when the server exits.
 */
export function opencodeServerCwd(
  codeoidPaths: readonly string[],
  bases: readonly string[] = SERVER_CWD_BASES,
  tempDir: string = tmpdir(),
): { root: string; cwd: string } {
  const tried: string[] = [];
  for (const base of bases) {
    const why = leadsToCodeoid(base, codeoidPaths, tempDir);
    if (why) {
      tried.push(`${base}: ${why}`);
      continue;
    }
    let root: string;
    try {
      root = mkdtempSync(join(base, SERVER_CWD_PREFIX));
    } catch (err) {
      tried.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const cwd = join(root, "cwd");
    try {
      mkdirSync(cwd, { mode: 0o700 });
      chmodSync(cwd, 0o500);
      chmodSync(root, 0o500);
    } catch (err) {
      removeServerCwd(cwd, root);
      throw err;
    }
    return { root, cwd };
  }
  throw new Error(
    `no directory to run opencode's server in that leads to nothing of codeoid's (a shell reaches it as /proc/$PPID/cwd): ${tried.join("; ")}`,
  );
}

/**
 * Why `/proc/$PPID/cwd` and its `..`s would reach something of codeoid's
 * from a root made in `base`, or null: some directory from `base` up to `/`
 * is one of `codeoidPaths`, inside one, or holds one at any depth; is, is inside or
 * holds (at any depth) the daemon's temp dir; holds an entry named codeoid (another daemon's temp dirs, a
 * `.codeoid`) other than a server cwd root; or holds a `.git` or `.hg`
 * (opencode runs version control in a repository above its cwd). One that can't be read or
 * resolved fails closed.
 */
export function leadsToCodeoid(base: string, codeoidPaths: readonly string[], tempDir: string = tmpdir()): string | null {
  let dir: string;
  try {
    dir = realpathSync(base);
  } catch {
    return "doesn't exist";
  }
  const real = (p: string) => {
    const abs = resolve(p);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  };
  const places = codeoidPaths.map(real);
  const temp = real(tempDir);
  for (;;) {
    // Sign-in homes sit inside the temp dir, so a directory holding it at
    // any depth leads to them, not only one holding it directly (but `/`,
    // which holds everything: reaching it is the known #448 limit).
    if (dir === temp) return `${dir} is the daemon's temp dir`;
    if (dir !== sep && temp.startsWith(`${dir}${sep}`)) return `${dir} holds the daemon's temp dir ${temp}`;
    if (dir.startsWith(`${temp}${sep}`)) return `${dir} is inside the daemon's temp dir ${temp}`;
    for (const p of places) {
      // At any depth, as the temp dir (but from `/`, only its own entries).
      if (p === dir || (dir === sep ? dirname(p) === dir : p.startsWith(`${dir}${sep}`))) return `${dir} holds ${p}`;
      if (dir.startsWith(`${p}${sep}`)) return `${dir} is inside ${p}`;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return `${dir} can't be listed`;
    }
    const named = names.find((n) => /^\.?codeoid/i.test(n) && !n.startsWith(SERVER_CWD_PREFIX));
    if (named) return `${dir} holds ${join(dir, named)}`;
    // opencode looks up from its own cwd for a repository and runs its
    // version control there unasked: never in one someone else could make.
    const repo = names.find((n) => n === ".git" || n === ".hg");
    if (repo) return `${dir} holds a repository, ${join(dir, repo)}`;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The Mercurial from which a repository's `.hg/hgrc` can be skipped (`HGRCSKIPREPO`, policy.ts `OPENCODE_HG_ENV`). */
export const MERCURIAL_FLOOR: readonly [number, number] = [5, 4];

/**
 * Why the `hg` opencode would run (the first on the server's `PATH`) could
 * still read a repository's `.hg/hgrc`, whose hooks and extensions run code,
 * or null: none on `PATH`, or one from {@link MERCURIAL_FLOOR} on. Asked of hg
 * itself (`hg --version`) in the server's empty cwd, reading no config; one
 * that doesn't say fails closed. A session under a `.hg` is refused on a
 * server with a problem (index.ts): opencode runs hg there unasked.
 */
export async function mercurialProblem(path: string | undefined, cwd: string, timeoutMs = 10_000): Promise<string | null> {
  const hg = Bun.which("hg", { PATH: path ?? "", cwd });
  if (!hg) return null;
  const out = await versionOutput([hg, "--version", "--quiet"], cwd, { PATH: path ?? "", HOME: cwd, ...OPENCODE_HG_ENV }, timeoutMs);
  const m = /version (\d+)\.(\d+)/.exec(out);
  const [major, minor] = MERCURIAL_FLOOR;
  if (!m) return `the Mercurial on opencode's PATH (${hg}) didn't say its version, so codeoid can't be sure it skips a repository's .hg/hgrc`;
  const v = [Number(m[1]), Number(m[2])] as const;
  if (v[0] > major || (v[0] === major && v[1] >= minor)) return null;
  return `the Mercurial on opencode's PATH (${hg}) is ${v.join(".")}: before ${major}.${minor} it can't skip a repository's .hg/hgrc, whose hooks would run unasked`;
}

/** The git from which every override codeoid gives it reaches it (`GIT_CONFIG_COUNT`, policy.ts `gitOverrideEnv`). */
export const GIT_FLOOR: readonly [number, number] = [2, 31];

/**
 * Why the `git` opencode would run (the first on the server's `PATH`) could
 * still apply a repository's config, whose hooks, fsmonitor and external
 * diff run code, or null: none on `PATH`, or one from {@link GIT_FLOOR} on.
 * An older git ignores `GIT_CONFIG_COUNT`, so none of codeoid's overrides
 * (policy.ts `OPENCODE_GIT_OVERRIDES`) reach it, silently. Asked of git
 * itself (`git --version`) in the server's empty cwd, reading no config; one
 * that doesn't say fails closed. A session in a git repository is refused on
 * a server with a problem (index.ts): opencode runs git there unasked.
 */
export async function gitProblem(path: string | undefined, cwd: string, timeoutMs = 10_000): Promise<string | null> {
  const git = Bun.which("git", { PATH: path ?? "", cwd });
  if (!git) return null;
  const env = { PATH: path ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...gitOverrideEnv(), ...OPENCODE_GIT_ENV };
  const out = await versionOutput([git, "--version"], cwd, env, timeoutMs);
  const m = /^git version (\d+)\.(\d+)/m.exec(out);
  const [major, minor] = GIT_FLOOR;
  if (!m) return `the git on opencode's PATH (${git}) didn't say its version, so codeoid can't be sure it takes the overrides that keep a repository's config from running anything`;
  const v = [Number(m[1]), Number(m[2])] as const;
  if (v[0] > major || (v[0] === major && v[1] >= minor)) return null;
  return `the git on opencode's PATH (${git}) is ${v.join(".")}: before ${major}.${minor} it ignores the overrides codeoid gives it (GIT_CONFIG_COUNT), so a repository's hooks or fsmonitor would run unasked — install git ${major}.${minor} or later`;
}

/** What `argv` prints on stdout, or "" (it failed, or took longer than `timeoutMs`). */
async function versionOutput(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<string> {
  try {
    const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch {
    return "";
  }
}

/**
 * The first directory from `dir` up to `/` that git would take for a
 * repository (where opencode runs git unasked): one holding a `.git` (a
 * directory, or a file as in a worktree or submodule), or one that is a
 * bare repository itself (`HEAD`, `objects`, `refs`). Null if none.
 */
export function gitCheckout(dir: string): string | null {
  let real = resolve(dir);
  try {
    real = realpathSync(dir);
  } catch {}
  const bare = (at: string) => existsSync(join(at, "HEAD")) && existsSync(join(at, "objects")) && existsSync(join(at, "refs"));
  for (const start of new Set([resolve(dir), real])) {
    for (let at = start; ; at = dirname(at)) {
      if (existsSync(join(at, ".git")) || bare(at)) return at;
      if (dirname(at) === at) break;
    }
  }
  return null;
}

/** The first directory from `dir` up to `/` holding a `.hg` (where opencode 2.2.5 runs hg unasked), or null. */
export function mercurialCheckout(dir: string): string | null {
  let real = resolve(dir);
  try {
    real = realpathSync(dir);
  } catch {}
  // As written and as resolved: opencode looks up from the one it was given.
  for (const start of new Set([resolve(dir), real])) {
    for (let at = start; ; at = dirname(at)) {
      if (existsSync(join(at, ".hg"))) return at;
      if (dirname(at) === at) break;
    }
  }
  return null;
}

function removeServerCwd(cwd: string, root: string): void {
  // Never recursive: they are only codeoid's while they are empty. The root is
  // made writable again for the cwd to go (an rmdir writes its parent).
  try {
    chmodSync(root, 0o700);
  } catch {}
  for (const dir of [cwd, root]) {
    try {
      rmdirSync(dir);
    } catch {}
  }
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
