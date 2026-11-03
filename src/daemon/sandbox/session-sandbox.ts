/**
 * One session's sandbox (#448): the setting it carries, what that resolves
 * to for its backend on this machine ({@link SessionSandboxInfo}), its
 * private temp dir, and the handles opened for it.
 *
 * Resolution: the session's setting over the daemon's `sandbox.*`; the
 * provider (`auto` is the platform's own) and whether it runs here; how
 * the backend is put inside it (confinement.ts); the network that can be
 * enforced that way. Narrowing is never silent and widening never happens
 * unseen: an allowlist a provider can't enforce runs with the network off
 * (and says so); a backend that needs the network to reach its model keeps
 * it on, and the session is then not `enforced`, so nothing unattended
 * starts on it.
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionSandboxInfo, SessionSandboxSetting } from "../../protocol/types.js";
import type { CodeoidConfig } from "../../config.js";
import type { ClaudeTempDirs } from "./claude-native.js";
import { type ConfinementPlan, confinementFor, runsNoCommands } from "./confinement.js";
import { GIT_BIN } from "../git-env.js";
import { CWD_FROM_CALLER } from "./docker.js";
import { buildSandboxSpec, gitLayoutProblem, networkPolicyOf, type SandboxConfig, sandboxConfigOf, validAllowedHost } from "./policy.js";
import type { SandboxRegistry } from "./registry.js";
import { gitProgramLocations, gitShimSpec, writeGitShim } from "./git-shim.js";
import { launcherRoot, sandboxRoot } from "./root.js";
import {
  type NetworkMode,
  type NetworkPolicy,
  SANDBOX_AUTO,
  SANDBOX_OFF,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpawnOptions,
  type SandboxSpec,
} from "./types.js";

/** A session's sandbox can't satisfy what an unattended or autonomous run needs. */
export class SandboxRequiredError extends Error {
  override name = "SandboxRequiredError";
}

/**
 * Why an autonomous session, a routine or a loop can't start on `info`, or
 * null: a sandbox asked for that can't run here, or one that can't hold what
 * was asked (the network). One the owner turned off runs (their choice,
 * itself an approval); a backend that runs no commands needs none.
 */
export function sandboxRefusalOf(info: SessionSandboxInfo): string | null {
  if (info.state === "unavailable") return `not sandboxed: ${info.reason ?? "the sandbox can't run here"}`;
  if (info.state === "on" && !info.enforced) {
    const why = info.limits?.find((l) => l.includes("network")) ?? "the sandbox can't hold what was asked";
    return `the sandbox can't enforce network ${info.networkRequested ?? info.network}: ${why}`;
  }
  return null;
}

export interface OpenOptions {
  /**
   * The backend's own process talks to its model from inside: the network is
   * on for the handle, while the backend's own sandbox holds its commands to
   * the session's network (Codex's).
   */
  backendNetwork?: boolean;
  /** Read-only locations the backend's process needs that would otherwise be hidden or under the host's /tmp (its own program). */
  readable?: readonly string[];
}

/** What a resolved, running sandbox gives a backend. */
export interface SandboxRuntime {
  readonly info: SessionSandboxInfo;
  readonly plan: ConfinementPlan;
  readonly provider: SandboxProvider;
  readonly config: SandboxConfig;
  /** The spec commands run under (no backend state). */
  readonly spec: SandboxSpec;
  /**
   * A handle whose spec also lets the backend's own process reach its state
   * (`backendState`: its home, login, sessions). Closed with the session or
   * when the sandbox is changed.
   */
  open(backendState?: readonly string[], opts?: OpenOptions): Promise<SandboxHandle>;
  /** The same, for a caller that can't wait (a spawn callback); local providers only. */
  openSync(backendState?: readonly string[], opts?: OpenOptions): SandboxHandle;
  /**
   * An executable that runs `argv` inside `handle` with the arguments it is
   * given appended, in the directory it is started from, for a spawner
   * codeoid doesn't control (an SDK that takes a path to its CLI, opencode's
   * shell). Written to a daemon-private dir outside anything the sandbox can
   * write; removed with the session. `envNames`: the variables its caller
   * passes that must reach the program (a provider that copies them by name,
   * Docker's `-e NAME`). `name`: rewrite that launcher in place (atomically)
   * rather than add one — a caller that refreshes it as the filesystem
   * changes (a hidden path that appeared or went).
   */
  launcher(handle: SandboxHandle, argv: readonly string[], envNames?: readonly string[], name?: string): string;
  /**
   * A fresh, empty, private directory for the backend's own home inside the
   * sandbox (backend-home.ts), the same path for the same `key` each time:
   * what was there from its last start is gone.
   */
  privateHome(key: string): string;
  /**
   * The session's own dir for what its backend keeps across starts (its
   * conversations: backend-home.ts), the same for the same `key` each time:
   * under the daemon's transcripts (hidden from every sandbox but this
   * session's backend), removed with the session.
   */
  stateDir(key: string): string;
  /** Claude's native sandbox: where its CLI and its commands keep temp files (claude-native.ts). */
  claudeTemp(): ClaudeTempDirs;
  /** Say something on the session (a warning line): a login not written back from the sandbox (backend-home.ts). */
  warn(text: string): void;
  /**
   * A dir to put first on the `PATH` of a backend CLI that runs outside the
   * sandbox (Claude's, under its own sandbox): its `git` runs the real one
   * inside this sandbox, read-only and offline (git-shim.ts), so a
   * repository a command planted runs nothing on the host. The same dir for
   * the runtime's life; `caller` names the CLI in the script.
   */
  gitShim(caller: string): string;
}

/** The setting a session ends up with: its own fields over the config's. */
export function effectiveSetting(config: SandboxConfig, setting: SessionSandboxSetting | undefined): { choice: string; network: NetworkPolicy } {
  const choice = setting?.provider ?? config.provider;
  const network = networkPolicyOf(config, {
    ...(setting?.network ? { mode: setting.network } : {}),
    ...(setting?.allowedHosts ? { allow: setting.allowedHosts } : {}),
  });
  return { choice, network };
}

/** Why a setting is malformed (an unknown provider, a host that isn't one), or null. */
export function sandboxSettingProblem(setting: SessionSandboxSetting, registry: SandboxRegistry): string | null {
  if (setting.provider !== undefined && !registry.knows(setting.provider)) {
    return `unknown sandbox provider "${setting.provider}" — available: ${[SANDBOX_AUTO, SANDBOX_OFF, ...registry.ids()].join(", ")}`;
  }
  const bad = (setting.allowedHosts ?? []).filter((h) => !validAllowedHost(h));
  if (bad.length > 0) return `not a host an allowlist can name: ${bad.slice(0, 3).join(", ")}`;
  return null;
}

/** How wide a setting is, to tell a widening change (asked) from a narrowing one (applied). */
function networkWidth(mode: NetworkMode): number {
  return mode === "off" ? 0 : mode === "allowlist" ? 1 : 2;
}

/**
 * Whether moving from `before` to `after` lets commands do more: the sandbox
 * turned off, the network wider, an allowlist with a host it didn't have.
 * Switching provider counts as widening (a different boundary).
 */
export function widens(before: { choice: string; network: NetworkPolicy }, after: { choice: string; network: NetworkPolicy }): boolean {
  if (after.choice === SANDBOX_OFF && before.choice !== SANDBOX_OFF) return true;
  if (before.choice === SANDBOX_OFF) return false;
  if (after.choice !== before.choice) return true;
  const b = networkWidth(before.network.mode);
  const a = networkWidth(after.network.mode);
  if (a !== b) return a > b;
  if (after.network.mode === "allowlist") {
    const had = new Set(before.network.allow ?? []);
    return (after.network.allow ?? []).some((h) => !had.has(h));
  }
  return false;
}

/** The network this plan enforces for `asked`: narrowed when it can't do an allowlist, widened (and said) when it can't turn it off. */
function enforcedNetwork(plan: ConfinementPlan, asked: NetworkMode, providerName: string): { mode: NetworkMode; note?: string; widened: boolean } {
  if (plan.network.includes(asked)) return { mode: asked, widened: false };
  if (asked === "allowlist" && plan.network.includes("off")) {
    return { mode: "off", note: `${providerName} can't enforce a host allowlist here, so commands get no network`, widened: false };
  }
  const best = plan.network.includes("off") ? "off" : "on";
  return { mode: best, note: `the network can't be ${asked === "off" ? "turned off" : "limited to an allowlist"} this way: ${plan.via}, and the backend needs it to reach its model`, widened: best === "on" };
}

/** Why `workspace` can't be a sandbox's writable workspace, or null: `/` would make the whole filesystem writable, and cover the sandbox's own /proc, /dev and /tmp. */
export function workspaceProblem(workspace: string): string | null {
  return resolve(workspace) === "/" ? "a session working in / can't be sandboxed (the whole filesystem would be its writable workspace) — give it a project directory" : null;
}

/** What a setting resolves to for a backend now (no side effects beyond a cached probe). */
export async function resolveSandbox(opts: {
  registry: SandboxRegistry;
  config: SandboxConfig;
  setting: SessionSandboxSetting | undefined;
  backendId: string;
  /** The session's working directory: `/` can't be a sandbox's workspace. */
  workspace?: string;
}): Promise<{ info: SessionSandboxInfo; provider: SandboxProvider | null; plan: ConfinementPlan | null; network: NetworkPolicy }> {
  const { choice, network } = effectiveSetting(opts.config, opts.setting);
  const base = {
    choice,
    network: network.mode,
    ...(network.mode === "allowlist" ? { allowedHosts: [...(network.allow ?? [])] } : {}),
  };
  if (runsNoCommands(opts.backendId)) {
    const r = confinementFor(opts.backendId, null);
    return { info: { ...base, state: "no-shell", reason: `${opts.backendId} runs no commands`, enforced: true }, provider: null, plan: r.ok ? r.plan : null, network };
  }
  if (choice === SANDBOX_OFF) {
    return { info: { ...base, state: "off", reason: "the sandbox is turned off for this session", enforced: false }, provider: null, plan: null, network };
  }
  const resolved = await opts.registry.resolve(choice);
  if (resolved.kind === "off") return { info: { ...base, state: "off", reason: "turned off", enforced: false }, provider: null, plan: null, network };
  if (resolved.kind === "unknown") return { info: { ...base, state: "unavailable", reason: resolved.reason, enforced: false }, provider: null, plan: null, network };
  const provider = resolved.provider;
  const named = { provider: provider.id, providerName: provider.displayName, isolation: provider.capabilities.isolation };
  if (!resolved.probe.available) {
    return { info: { ...base, ...named, state: "unavailable", reason: resolved.probe.reason, enforced: false }, provider, plan: null, network };
  }
  const rootProblem = opts.workspace !== undefined ? workspaceProblem(opts.workspace) : null;
  if (rootProblem) return { info: { ...base, ...named, state: "unavailable", reason: rootProblem, enforced: false }, provider, plan: null, network };
  const c = confinementFor(opts.backendId, provider, opts.registry.host);
  if (!c.ok) return { info: { ...base, ...named, state: "unavailable", reason: c.reason, enforced: false }, provider, plan: null, network };
  const net = enforcedNetwork(c.plan, network.mode, provider.displayName);
  // A repository whose `.git` names a git dir codeoid can't verify: held read-only, said (policy.ts gitWorkspacePaths).
  const gitNote = opts.workspace !== undefined && c.plan.kind !== "no-shell" ? gitLayoutProblem(opts.workspace) : null;
  const limits = [...c.plan.limits, ...(net.note ? [net.note] : []), ...(gitNote ? [gitNote] : [])];
  const applied: NetworkPolicy = net.mode === "allowlist" ? network : { mode: net.mode };
  return {
    info: {
      choice,
      ...named,
      state: "on",
      network: net.mode,
      ...(net.mode !== network.mode ? { networkRequested: network.mode } : {}),
      ...(network.mode === "allowlist" ? { allowedHosts: [...(network.allow ?? [])] } : {}),
      confinement: c.plan.kind === "no-shell" ? undefined : c.plan.kind,
      via: c.plan.via,
      ...(limits.length > 0 ? { limits } : {}),
      enforced: !net.widened,
    },
    provider,
    plan: c.plan,
    network: applied,
  };
}

/** A session's sandbox: its setting, what it resolved to, its temp dir and handles. */
export class SessionSandbox {
  readonly #sessionId: string;
  readonly #workdir: string;
  readonly #registry: SandboxRegistry;
  readonly #config: CodeoidConfig | undefined;
  #setting: SessionSandboxSetting | undefined;
  #info: SessionSandboxInfo | null = null;
  #runtime: SandboxRuntime | null = null;
  #tempDir: string | null = null;
  #handles = new Set<SandboxHandle>();
  #resolvedFor: string | null = null;
  /** The setting changed since the last resolution (which still stands until the next one replaces it). */
  #stale = false;
  /** Bumped by every {@link set}: a resolution that started before it is done again. */
  #generation = 0;
  /** Resolutions run one at a time, in order: the last one asked for is the one that stands. */
  #refreshing: Promise<unknown> = Promise.resolve();
  #closed = false;
  #launcherDir: string | null = null;
  #launchers = 0;
  #homesDir: string | null = null;
  #claudeTemp: ClaudeTempDirs | null = null;

  readonly #onWarning: ((text: string) => void) | undefined;

  constructor(opts: {
    sessionId: string;
    workdir: string;
    registry: SandboxRegistry;
    config?: CodeoidConfig;
    setting?: SessionSandboxSetting;
    /** A warning line on the session (SandboxRuntime.warn). */
    onWarning?: (text: string) => void;
  }) {
    this.#onWarning = opts.onWarning;
    this.#sessionId = opts.sessionId;
    this.#workdir = opts.workdir;
    this.#registry = opts.registry;
    this.#config = opts.config;
    this.#setting = opts.setting;
  }

  get registry(): SandboxRegistry {
    return this.#registry;
  }

  /** The session's own setting (persisted); absent fields follow the config. */
  get setting(): SessionSandboxSetting | undefined {
    return this.#setting;
  }

  /** The daemon's config section. */
  get config(): SandboxConfig {
    return sandboxConfigOf(this.#config);
  }

  /** What `setting` means with the config filled in. */
  effective(setting: SessionSandboxSetting | undefined = this.#setting): { choice: string; network: NetworkPolicy } {
    return effectiveSetting(this.config, setting);
  }

  /** The last resolution, or null before the first. */
  get info(): SessionSandboxInfo | null {
    return this.#info;
  }

  /** What a backend is given while the sandbox is on; null when off, unavailable, or the backend runs no commands. */
  get runtime(): SandboxRuntime | null {
    return this.#runtime;
  }

  /** Whether the last resolution was for `backendId` with the current setting. */
  resolvedFor(backendId: string): boolean {
    return this.#resolvedFor === backendId && !this.#stale;
  }

  /**
   * The runtime for `backendId`: the last resolution's, kept while a changed
   * setting is being resolved (never nothing in between: that would read as
   * "off" to a backend starting meanwhile). Null when that resolution was for
   * another backend, or isn't on.
   */
  runtimeFor(backendId: string): SandboxRuntime | null {
    return this.#resolvedFor === backendId ? this.#runtime : null;
  }

  /**
   * Change the setting; the next {@link refresh} resolves it and replaces the
   * runtime. Handles a backend opened under the old one stay until that
   * backend is torn down (Session restarts it, idle: a running turn is never
   * cut off by a change of setting) or the session closes.
   */
  async set(setting: SessionSandboxSetting | undefined): Promise<void> {
    this.#setting = setting && Object.keys(setting).length > 0 ? { ...setting } : undefined;
    this.#stale = true;
    this.#generation += 1;
  }

  /**
   * Resolve for `backendId` (a provider switch, a setting change, the first
   * turn). One at a time; one that started before a {@link set} resolves
   * again, so a change made while a slow probe runs is never lost.
   */
  refresh(backendId: string): Promise<SessionSandboxInfo> {
    const run = this.#refreshing.catch(() => {}).then(() => this.#refreshNow(backendId));
    this.#refreshing = run;
    return run;
  }

  async #refreshNow(backendId: string): Promise<SessionSandboxInfo> {
    let r: Awaited<ReturnType<typeof resolveSandbox>>;
    for (;;) {
      const generation = this.#generation;
      r = await resolveSandbox({ registry: this.#registry, config: this.config, setting: this.#setting, backendId, workspace: this.#workdir });
      if (generation === this.#generation) break;
    }
    if (this.#closed) {
      this.#runtime = null;
      return r.info;
    }
    this.#info = r.info;
    this.#resolvedFor = backendId;
    this.#stale = false;
    if (r.info.state !== "on" || !r.provider || !r.plan) {
      this.#runtime = null;
      return r.info;
    }
    const provider = r.provider;
    const plan = r.plan;
    const config = this.config;
    const open = (backendState: readonly string[] = [], o: OpenOptions = {}) => {
      if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
      return this.#spec(o.backendNetwork ? { mode: "on" } : r.network, backendState, o.readable ?? []);
    };
    // Built (and the temp dir made) when a backend first needs it.
    let spec: SandboxSpec | null = null;
    let gitShim: string | null = null;
    this.#runtime = {
      info: r.info,
      plan,
      provider,
      config,
      get spec() {
        spec ??= open([]);
        return spec;
      },
      open: async (backendState, o) => this.#track(await provider.open(open(backendState, o))),
      openSync: (backendState, o) => {
        if (!provider.openSync) throw new Error(`${provider.displayName} can't be opened synchronously`);
        return this.#track(provider.openSync(open(backendState, o)));
      },
      launcher: (handle, argv, envNames, name) => this.#writeLauncher(handle, argv, envNames ?? [], name),
      privateHome: (key) => this.#privateHome(key),
      stateDir: (key) => this.#stateDir(key),
      claudeTemp: () => this.#ensureClaudeTemp(),
      gitShim: (caller) => {
        gitShim ??= this.#writeGitShim(provider, caller);
        return gitShim;
      },
      warn: (text) => {
        try {
          this.#onWarning?.(text);
        } catch {
          /* a session gone meanwhile: the daemon's log has it */
        }
      },
    };
    return r.info;
  }

  #sessionSlug(): string {
    return this.#sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "session";
  }

  #privateHome(key: string): string {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    if (!this.#homesDir) this.#homesDir = mkdtempSync(join(sandboxRoot(), `home-${this.#sessionSlug()}-`));
    const dir = join(this.#homesDir, key.replace(/[^A-Za-z0-9_-]/g, "") || "backend");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    return dir;
  }

  /** The session's state root: under the transcripts dir when there is one, else (an embedder, tests) with its private homes. */
  #stateRoot(): string {
    const dir = this.#config?.transcriptDir;
    const safe = this.#sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "session";
    if (dir) return join(resolve(dir), "sandbox-state", safe);
    if (!this.#homesDir) this.#homesDir = mkdtempSync(join(sandboxRoot(), `home-${this.#sessionSlug()}-`));
    return join(this.#homesDir, ".state");
  }

  #stateDir(key: string): string {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    const dir = join(this.#stateRoot(), key.replace(/[^A-Za-z0-9_-]/g, "") || "backend");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Remove what the session's backends kept across starts (with the session: its destroy). */
  removeState(): void {
    rmSync(this.#stateRoot(), { recursive: true, force: true });
  }

  #ensureClaudeTemp(): ClaudeTempDirs {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    if (!this.#claudeTemp) {
      const base = mkdtempSync(join(sandboxRoot(), `claude-${this.#sessionSlug()}-`));
      const uid = typeof process.getuid === "function" ? process.getuid() : "user";
      const t: ClaudeTempDirs = { cli: join(base, "cli"), root: join(base, "cmd"), commands: join(base, "cmd", `claude-${uid}`) };
      mkdirSync(t.cli, { mode: 0o700 });
      mkdirSync(t.commands, { recursive: true, mode: 0o700 });
      this.#claudeTemp = t;
    }
    return this.#claudeTemp;
  }

  #ensureLauncherDir(): string {
    if (!this.#launcherDir) this.#launcherDir = mkdtempSync(`${launcherRoot()}${this.#sessionSlug()}-`);
    return this.#launcherDir;
  }

  /**
   * The git shim's dir (git-shim.ts) in the session's launcher dir: a
   * launcher for the read-only, offline spec when the provider can start a
   * local program inside, else git defused.
   */
  #writeGitShim(provider: SandboxProvider, caller: string): string {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    const dir = join(this.#ensureLauncherDir(), "git-bin");
    let launcher: string | null = null;
    let program: string | null = null;
    if (provider.openSync && provider.capabilities.wrapsArgv && provider.capabilities.placement === "local") {
      const handle = this.#track(provider.openSync(gitShimSpec(this.#spec({ mode: "off" }, [], gitProgramLocations()))));
      // In the caller's own directory, or not at all: one the sandbox hides isn't swapped for another (bwrap's `$HOME`).
      launcher = this.#writeLauncher(handle, [GIT_BIN], [], "git", CWD_FROM_CALLER);
      program = handle.wrap?.([GIT_BIN], { cwd: "", env: {} }).argv[0] ?? null;
    }
    return writeGitShim(dir, { launcher, provider: program, caller });
  }

  #writeLauncher(handle: SandboxHandle, argv: readonly string[], envNames: readonly string[], name?: string, cwd = ""): string {
    if (!handle.wrap) throw new Error(`${handle.providerId} can't start a local program inside`);
    const launcherDir = this.#ensureLauncherDir();
    // Started from wherever its caller is: the cwd is the caller's, not fixed here
    // (CWD_FROM_CALLER: named to the provider as the dir it is run from).
    const wrapped = handle.wrap(argv, { cwd, env: Object.fromEntries(envNames.map((n) => [n, ""])) });
    const path = join(launcherDir, `launch-${name ? name.replace(/[^A-Za-z0-9_-]/g, "") : ++this.#launchers}`);
    // Written beside it and renamed over it: a caller running it meanwhile gets the old one or the new one, whole.
    const part = `${path}.${++this.#launchers}.part`;
    writeFileSync(part, launcherScript(wrapped.argv), { mode: 0o700 });
    renameSync(part, path);
    return path;
  }

  /** Kept until closed (by its backend when its process ends, or with the session); a closed one is let go. */
  #track(h: SandboxHandle): SandboxHandle {
    const tracked = new TrackedHandle(h, () => this.#handles.delete(tracked));
    this.#handles.add(tracked);
    return tracked;
  }

  /** How many handles are open (tests). */
  get openHandles(): number {
    return this.#handles.size;
  }

  #spec(network: NetworkPolicy, backendState: readonly string[], readable: readonly string[] = []): SandboxSpec {
    return buildSandboxSpec({
      backendReadable: readable,
      sessionId: this.#sessionId,
      workspace: this.#workdir,
      tempDir: this.#ensureTempDir(),
      network,
      ...(this.#config ? { config: this.#config } : {}),
      backendState,
    });
  }

  /** The session's private temp dir (made on first use, 0700). */
  #ensureTempDir(): string {
    if (!this.#tempDir) this.#tempDir = mkdtempSync(join(sandboxRoot(), `tmp-${this.#sessionSlug()}-`));
    return this.#tempDir;
  }

  async #closeHandles(): Promise<void> {
    const handles = [...this.#handles];
    this.#handles.clear();
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  }

  /** End everything opened for the session and remove its temp dir (idempotent). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#runtime = null;
    await this.#closeHandles();
    if (this.#tempDir) {
      rmSync(this.#tempDir, { recursive: true, force: true });
      this.#tempDir = null;
    }
    for (const dir of [this.#launcherDir, this.#homesDir, this.#claudeTemp ? join(this.#claudeTemp.cli, "..") : null]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    this.#launcherDir = null;
    this.#homesDir = null;
    this.#claudeTemp = null;
  }
}

/** A handle the session tracks, let go of when closed. */
class TrackedHandle implements SandboxHandle {
  readonly #inner: SandboxHandle;
  readonly #onClose: () => void;
  readonly wrap?: SandboxHandle["wrap"];

  constructor(inner: SandboxHandle, onClose: () => void) {
    this.#inner = inner;
    this.#onClose = onClose;
    if (inner.wrap) this.wrap = inner.wrap.bind(inner);
  }

  get providerId(): string {
    return this.#inner.providerId;
  }

  get spec(): SandboxSpec {
    return this.#inner.spec;
  }

  spawn(command: string, args: readonly string[], opts: SandboxSpawnOptions) {
    return this.#inner.spawn(command, args, opts);
  }

  exec(argv: readonly string[], opts: SandboxExecOptions): Promise<SandboxExecResult> {
    return this.#inner.exec(argv, opts);
  }

  async close(): Promise<void> {
    this.#onClose();
    await this.#inner.close();
  }
}

/** A word as the shell reads it literally. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * A POSIX sh script that execs `argv` with its own arguments appended. A
 * word that is {@link CWD_FROM_CALLER} becomes the directory it is run from.
 */
export function launcherScript(argv: readonly string[]): string {
  const words = argv.map((w) => (w === CWD_FROM_CALLER ? '"$PWD"' : shellQuote(w)));
  return `#!/bin/sh\n# Written by codeoid (#448): starts a backend inside its session's sandbox.\nexec ${words.join(" ")} "$@"\n`;
}

export { launcherRoot } from "./root.js";

/** How a check runs (#448): inside a sandbox, refused (the one asked for can't run), or as is (off / no sandboxing). */
export type CheckSandbox =
  | { kind: "on"; wrap: NonNullable<SandboxHandle["wrap"]>; close(): Promise<void> }
  | { kind: "refused"; reason: string }
  | { kind: "off" };

/**
 * A sandbox for a daemon-run check over agent-written code (a loop's
 * acceptance checks, a routine's gate): the same setting a session would
 * resolve, the check's directory as the workspace, a fresh private temp dir.
 * Off (by setting) runs as is; one that can't run here, or can't hold its
 * network, is refused (the check doesn't run).
 */
export async function openCheckSandbox(opts: {
  registry: SandboxRegistry;
  config: CodeoidConfig | undefined;
  setting: SessionSandboxSetting | undefined;
  workspace: string;
  label: string;
}): Promise<CheckSandbox> {
  const cfg = sandboxConfigOf(opts.config);
  const { choice, network } = effectiveSetting(cfg, opts.setting);
  if (choice === SANDBOX_OFF) return { kind: "off" };
  const resolved = await opts.registry.resolve(choice);
  if (resolved.kind === "off") return { kind: "off" };
  if (resolved.kind === "unknown") return { kind: "refused", reason: resolved.reason };
  if (!resolved.probe.available) return { kind: "refused", reason: resolved.probe.reason };
  const provider = resolved.provider;
  if (!provider.capabilities.commands || !provider.capabilities.wrapsArgv) {
    return { kind: "refused", reason: `${provider.displayName} can't run a local command` };
  }
  const rootProblem = workspaceProblem(opts.workspace);
  if (rootProblem) return { kind: "refused", reason: rootProblem };
  const mode: NetworkMode = provider.capabilities.network.includes(network.mode) ? network.mode : "off";
  const safe = opts.label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "check";
  const tempDir = mkdtempSync(join(sandboxRoot(), `check-${safe}-`));
  let handle: SandboxHandle;
  try {
    const spec = buildSandboxSpec({
      sessionId: `check-${safe}`,
      workspace: opts.workspace,
      tempDir,
      network: mode === "allowlist" ? network : { mode },
      ...(opts.config ? { config: opts.config } : {}),
    });
    handle = await provider.open(spec);
  } catch (err) {
    // Nothing opened: nothing of it is left behind.
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
  if (!handle.wrap) {
    await handle.close();
    rmSync(tempDir, { recursive: true, force: true });
    return { kind: "refused", reason: `${provider.displayName} can't run a local command` };
  }
  return {
    kind: "on",
    wrap: handle.wrap.bind(handle),
    close: async () => {
      await handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
