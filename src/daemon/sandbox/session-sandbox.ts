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

import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionSandboxInfo, SessionSandboxSetting } from "../../protocol/types.js";
import { type CodeoidConfig, getConfigDir } from "../../config.js";
import type { ClaudeTempDirs } from "./claude-native.js";
import { type ConfinementPlan, confinementFor, runsNoCommands } from "./confinement.js";
import { GIT_BIN } from "../git-env.js";
import { CWD_FROM_CALLER } from "./docker.js";
import { buildSandboxSpec, dockerSocketPaths, gitLayoutOf, gitLayoutProblem, networkPolicyOf, type SandboxConfig, sandboxConfigOf, sandboxWorkspaceOf, unconnectableDockerSockets, validAllowedHost } from "./policy.js";
import { ENTRY_GRACE_MS, WorktreeEntryGuard, type WorktreeEntryFinding } from "./worktree-entries.js";
import { existingFolderName, mainCheckoutOf, sessionFolderName, worktreeFoldersOf, worktreeLocationDirs, worktreeRootNotes } from "./worktrees.js";
import type { SandboxRegistry } from "./registry.js";
import { cliWorktrees, gitProgramLocations, gitShimSpec, writeGitShim } from "./git-shim.js";
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

/**
 * What Docker access also lets a command reach under Claude's own Linux
 * sandbox, which can't allow a single socket (`allowAllUnixSockets`): the
 * limits line says it (docs/sandbox.md, Docker access).
 */
export const CLAUDE_ALL_SOCKETS_NOTE =
  "on Claude's Linux sandbox that lets a command connect to any unix socket it can see: the host's /tmp, the desktop's runtime dir, the system bus and every other runtime's socket are hidden, and local databases' (Postgres, MySQL, Redis) while the network is off, but a socket in the workspace, in what your home shows (sandbox.homeReadable) or in a system dir open to every user (systemd's journal, printing; a database's with the network on) is reachable";

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
   * inside this sandbox, offline, with an environment of its own and a
   * fresh temp dir per git (git-shim.ts), so a
   * repository a command planted runs nothing on the host. The same dir for
   * the runtime's life; `caller` names the CLI in the script.
   */
  gitShim(caller: string): string;
}

/** A sandbox setting with the config filled in: the provider choice, the network, and whether commands reach the container runtime. */
export interface EffectiveSandbox {
  choice: string;
  network: NetworkPolicy;
  /** The host's container runtime socket is reachable (`sandbox.docker.socket` / the session's `dockerSocket`): root-equivalent. */
  dockerSocket: boolean;
}

/** The setting a session ends up with: its own fields over the config's. */
export function effectiveSetting(config: SandboxConfig, setting: SessionSandboxSetting | undefined): EffectiveSandbox {
  const choice = setting?.provider ?? config.provider;
  const network = networkPolicyOf(config, {
    ...(setting?.network ? { mode: setting.network } : {}),
    ...(setting?.allowedHosts ? { allow: setting.allowedHosts } : {}),
  });
  return { choice, network, dockerSocket: setting?.dockerSocket ?? config.docker.socket ?? false };
}

/** A setting in words, for a change's line and audit: "bwrap, network on, Docker access". */
export function describeSandbox(e: EffectiveSandbox): string {
  if (e.choice === SANDBOX_OFF) return "off";
  return `${e.choice}, network ${e.network.mode}${e.network.mode === "allowlist" ? ` (${(e.network.allow ?? []).join(", ")})` : ""}${e.dockerSocket ? ", Docker access" : ""}`;
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
 * turned off, the network wider, an allowlist with a host it didn't have,
 * the container runtime's socket let in (root on the machine). Switching
 * provider counts as widening (a different boundary).
 */
export function widens(
  before: { choice: string; network: NetworkPolicy; dockerSocket?: boolean },
  after: { choice: string; network: NetworkPolicy; dockerSocket?: boolean },
): boolean {
  if (after.choice === SANDBOX_OFF && before.choice !== SANDBOX_OFF) return true;
  if (before.choice === SANDBOX_OFF) return false;
  if (after.choice !== before.choice) return true;
  if (after.dockerSocket === true && before.dockerSocket !== true) return true;
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
  const { choice, network, dockerSocket } = effectiveSetting(opts.config, opts.setting);
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
  // A monorepo's package: what its commands may write is the whole repository (#448 round 9).
  const top = opts.workspace !== undefined && c.plan.kind !== "no-shell" ? sandboxWorkspaceOf(opts.workspace) : null;
  const topNote = top && opts.workspace !== undefined && top !== resolve(opts.workspace) ? `the workspace is the repository's top (${top}), which the working directory is inside: all of it is readable and writable, its git structure and every project settings dir on the way held read-only` : null;
  // The container runtime's socket, when the owner let it in: said, and said when there is none to reach.
  const home = process.env.HOME ?? homedir();
  const sockets = dockerSocket ? dockerSocketPaths(home) : [];
  const unconnectable = dockerSocket && sockets.length === 0 ? unconnectableDockerSockets(home) : [];
  // Claude's Linux sandbox can't allow one socket: every one a command can see is connectable then (#448 round 10).
  const allSockets = sockets.length > 0 && c.plan.kind === "native" && process.platform === "linux";
  const dockerNote = dockerSocket
    ? sockets.length > 0
      ? `Docker access: commands can reach the container runtime (${sockets.join(", ")}), which can reach the whole machine (a container can mount /)${allSockets ? `; ${CLAUDE_ALL_SOCKETS_NOTE}` : ""}`
      : unconnectable.length > 0
        ? `Docker access was asked for, but the container runtime socket found here (${unconnectable.join(", ")}) isn't one you can connect to (is your user in its group?): not shown`
        : "Docker access was asked for, but no container runtime socket was found here"
    : null;
  // `sandbox.worktreeRoots` refused here, or missing and not beside the repository (never made): said (worktrees.ts).
  const layout = top !== null && opts.config.worktreeRoots.length > 0 ? gitLayoutOf(top) : null;
  const rootNotes = layout ? worktreeRootNotes(layout, { roots: opts.config.worktreeRoots, configDir: getConfigDir() }) : [];
  const limits = [...c.plan.limits, ...(net.note ? [net.note] : []), ...(gitNote ? [gitNote] : []), ...(topNote ? [topNote] : []), ...(dockerNote ? [dockerNote] : []), ...rootNotes];
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
      ...(dockerSocket ? { dockerSocket: true } : {}),
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
  #gitTempDir: string | null = null;
  /** The session's worktree folder name (worktrees.ts), once found or chosen: the same for its life. */
  #folderName: string | null = null;
  /** The worktree folders a spec gave the session: the empty ones are removed (tidyFolders, close). */
  #folders = new Set<string>();
  /** The repository's worktree entries as git makes them (#448 round 11, worktree-entries.ts). */
  readonly #entries = new WorktreeEntryGuard();
  /** The spec last built for the session: what its commands can write, for the entries' look. */
  #lastSpec: SandboxSpec | null = null;
  #entriesRecheck: ReturnType<typeof setTimeout> | null = null;

  readonly #onWarning: ((text: string) => void) | undefined;
  readonly #onWorktreeEntries: ((common: string, findings: WorktreeEntryFinding[]) => void) | undefined;
  readonly #name: () => string;

  constructor(opts: {
    sessionId: string;
    /** The session's name (its worktree folder is named after it, with a short id: worktrees.ts `sessionFolderName`). */
    name?: string | (() => string);
    workdir: string;
    registry: SandboxRegistry;
    config?: CodeoidConfig;
    setting?: SessionSandboxSetting;
    /** A warning line on the session (SandboxRuntime.warn). */
    onWarning?: (text: string) => void;
    /** What a look at the repository's worktree entries found (checkWorktreeEntries): said on the session and audited. */
    onWorktreeEntries?: (common: string, findings: WorktreeEntryFinding[]) => void;
  }) {
    this.#onWarning = opts.onWarning;
    this.#onWorktreeEntries = opts.onWorktreeEntries;
    this.#sessionId = opts.sessionId;
    const name = opts.name;
    this.#name = typeof name === "function" ? name : () => name ?? opts.sessionId;
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
  effective(setting: SessionSandboxSetting | undefined = this.#setting): EffectiveSandbox {
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
    const dockerSocket = r.info.dockerSocket === true;
    // Local services' sockets follow the network the session asked for, not a handle's (a process backend's has it on
    // for its model) nor one widened because the backend can't turn it off: hiding them needs no network rule.
    const hideLocalServices = (r.info.networkRequested ?? r.info.network) !== "on";
    const open = (backendState: readonly string[] = [], o: OpenOptions = {}) => {
      if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
      return this.#spec(o.backendNetwork ? { mode: "on" } : r.network, backendState, o.readable ?? [], dockerSocket, hideLocalServices);
    };
    // Built (and the temp dir made) when a backend first needs it, then kept: a worktree added or removed in the
    // repository never rebuilds it (#448 round 11: that would rebuild a Claude query, its background tasks with it).
    // An entry made meanwhile is checked instead (checkWorktreeEntries), and held from the next spec on.
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
        // Checked at each query: one removed meanwhile (a temp cleaner) is written again rather than leave the CLI the host's git.
        if (!gitShim || !existsSync(join(gitShim, "git"))) gitShim = this.#writeGitShim(provider, caller);
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
   * launcher for the shim's spec (the command sandbox, offline, a fresh temp
   * dir per git, the CLI's worktree dirs writable) when the provider can
   * start a local program inside, else git defused.
   */
  #writeGitShim(provider: SandboxProvider, caller: string): string {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    const launcherDir = this.#ensureLauncherDir();
    // Gone (a temp cleaner, #448 round 5): made again, so a CLI started now finds the shim, not the host's git.
    mkdirSync(launcherDir, { recursive: true, mode: 0o700 });
    const dir = join(launcherDir, "git-bin");
    let launcher: string | null = null;
    let program: string | null = null;
    if (provider.openSync && provider.capabilities.wrapsArgv && provider.capabilities.placement === "local") {
      const spec = gitShimSpec(this.#spec({ mode: "off" }, [], gitProgramLocations()), { tempParent: this.#ensureGitTempDir(), worktrees: cliWorktrees(this.#workdir) });
      const handle = this.#track(provider.openSync(spec));
      // In the caller's own directory, or not at all: one the sandbox hides isn't swapped for another (bwrap's `$HOME`).
      launcher = this.#writeLauncher(handle, [GIT_BIN], [], "git", CWD_FROM_CALLER);
      program = handle.wrap?.([GIT_BIN], { cwd: "", env: {} }).argv[0] ?? null;
    }
    return writeGitShim(dir, { launcher, provider: program, caller, home: homedir() });
  }

  /** Where the shim's git gets a fresh temp dir per run where the provider needs a real one (Seatbelt): its own, not the session's. */
  #ensureGitTempDir(): string {
    if (!this.#gitTempDir) this.#gitTempDir = mkdtempSync(join(sandboxRoot(), `git-tmp-${this.#sessionSlug()}-`));
    mkdirSync(this.#gitTempDir, { recursive: true, mode: 0o700 });
    return this.#gitTempDir;
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

  #spec(network: NetworkPolicy, backendState: readonly string[], readable: readonly string[] = [], dockerSocket = false, hideLocalServices = network.mode !== "on"): SandboxSpec {
    // A monorepo's package: the repository's top (#448 round 9); the session's cwd stays the workdir.
    const workspace = sandboxWorkspaceOf(this.#workdir);
    const folder = this.#worktreeFolderName(workspace);
    // The repository's worktree entries looked at first: the spec holds every one the session didn't make.
    if (folder) this.#checkEntries();
    const spec = buildSandboxSpec({
      backendReadable: readable,
      sessionId: this.#sessionId,
      workspace,
      workdir: this.#workdir,
      tempDir: this.#ensureTempDir(),
      network,
      ...(this.#config ? { config: this.#config } : {}),
      backendState,
      ...(folder ? { worktreeFolder: folder, ownWorktreeEntries: this.#entries.ownEntries() } : {}),
      dockerSocket,
      hideLocalServices,
    });
    for (const f of spec.worktreeFolders ?? []) this.#folders.add(f);
    this.#lastSpec = spec;
    return spec;
  }

  /**
   * Look at the repository's worktree entries now (#448 round 11,
   * worktree-entries.ts): what isn't as git makes it is restored where that
   * is certain, and said (onWorktreeEntries) either way. At the end of every
   * turn, at destroy, and when a spec is built. Only while the sandbox is on
   * (its commands are what could have changed them unseen). Never throws.
   */
  checkWorktreeEntries(): void {
    if (this.#closed || !this.#runtime) return;
    if (!this.#worktreeFolderName(sandboxWorkspaceOf(this.#workdir))) return;
    this.#checkEntries();
  }

  #checkEntries(): void {
    try {
      const workspace = sandboxWorkspaceOf(this.#workdir);
      const layout = gitLayoutOf(workspace);
      const folder = this.#folderName;
      if (!layout?.common || !folder) return;
      const opts = { roots: this.config.worktreeRoots, configDir: getConfigDir() };
      const main = mainCheckoutOf(layout);
      const last = this.#lastSpec;
      // Before the first spec, the folders as they are (nothing is made for a look).
      const folders = last ? [...(last.worktreeFolders ?? [])] : worktreeFoldersOf(layout, folder, { ...opts, workspace, make: false }).folders;
      const dot = main ? join(main, ".worktrees") : null;
      const { findings, pending } = this.#entries.check({
        common: layout.common,
        main,
        ownFolders: folders,
        writable: [workspace, ...(this.#tempDir ? [this.#tempDir] : []), ...folders, ...(last?.writable ?? [])],
        readOnly: last?.readOnly ?? [],
        locations: [...worktreeLocationDirs(layout, opts).locations.map((l) => l.dir), ...(dot ? [dot] : [])],
      });
      if (pending && !this.#entriesRecheck) {
        // An entry git may still be making: looked at once it is done.
        this.#entriesRecheck = setTimeout(() => {
          this.#entriesRecheck = null;
          this.checkWorktreeEntries();
        }, ENTRY_GRACE_MS + 100);
        this.#entriesRecheck.unref?.();
      }
      if (findings.length > 0) this.#onWorktreeEntries?.(layout.common, findings);
    } catch (err) {
      console.error(`[codeoid/sandbox ${this.#sessionId.slice(0, 8)}] looking at the repository's worktree entries failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Make the session's worktree folders again where {@link tidyFolders}
   * removed them (a turn's start: its commands, and a Claude query's sandbox,
   * need them there). Never through a link (worktrees.ts `worktreeFoldersOf`).
   */
  prepareFolders(): void {
    if (this.#closed || this.#folders.size === 0 || [...this.#folders].every((f) => existsSync(f))) return;
    try {
      const workspace = sandboxWorkspaceOf(this.#workdir);
      const layout = gitLayoutOf(workspace);
      if (!layout || !this.#folderName) return;
      worktreeFoldersOf(layout, this.#folderName, { roots: this.config.worktreeRoots, configDir: getConfigDir(), workspace });
    } catch {
      /* a folder that can't be made: a worktree add there fails, as outside one */
    }
  }

  /**
   * Remove the session's worktree folders that are empty, and the location
   * holding one when that is left empty too (#448 round 11: nothing of the
   * sandbox's stays beside your repository for a session that made no
   * worktree): never anything with something in it, never through a link.
   * At the end of a turn with nothing running, and with the session.
   */
  tidyFolders(): void {
    for (const f of this.#folders) {
      for (const dir of [f, dirname(f)]) {
        try {
          if (!lstatSync(dir).isDirectory()) break;
          rmdirSync(dir);
        } catch {
          break;
        }
      }
    }
  }

  /**
   * The session's worktree folder name (#448 round 10, worktrees.ts): the
   * one it already has in a location (found by its short id, so a rename
   * or a daemon restart keeps it), else its name and short id. Null outside
   * a repository codeoid can verify.
   */
  #worktreeFolderName(workspace: string): string | null {
    if (this.#folderName) return this.#folderName;
    const layout = gitLayoutOf(workspace);
    if (!layout?.common) return null;
    const { locations } = worktreeLocationDirs(layout, { roots: this.config.worktreeRoots, configDir: getConfigDir() });
    this.#folderName = existingFolderName(locations, this.#sessionId) ?? sessionFolderName(this.#name(), this.#sessionId);
    return this.#folderName;
  }

  /**
   * Where the session's commands may check a git worktree out: its own
   * folder in each worktree location (SandboxSpec.worktreeFolders), as the
   * running sandbox has them; empty without one.
   */
  worktreeFolders(): string[] {
    try {
      return [...(this.#runtime?.spec.worktreeFolders ?? [])];
    } catch {
      return [];
    }
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
    for (const dir of [this.#launcherDir, this.#homesDir, this.#gitTempDir, this.#claudeTemp ? join(this.#claudeTemp.cli, "..") : null]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    if (this.#entriesRecheck) {
      clearTimeout(this.#entriesRecheck);
      this.#entriesRecheck = null;
    }
    // The session's worktree folders it left empty: never one with anything in it (a worktree is the user's to keep).
    this.tidyFolders();
    this.#folders.clear();
    this.#launcherDir = null;
    this.#gitTempDir = null;
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
  const { choice, network, dockerSocket } = effectiveSetting(cfg, opts.setting);
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
      workspace: sandboxWorkspaceOf(opts.workspace),
      workdir: opts.workspace,
      tempDir,
      network: mode === "allowlist" ? network : { mode },
      ...(opts.config ? { config: opts.config } : {}),
      // A check that starts containers (testcontainers) gets the socket when the owner let the run's sandbox have it.
      dockerSocket,
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
