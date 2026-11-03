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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSandboxInfo, SessionSandboxSetting } from "../../protocol/types.js";
import type { CodeoidConfig } from "../../config.js";
import { type ConfinementPlan, confinementFor, runsNoCommands } from "./confinement.js";
import { CWD_FROM_CALLER } from "./docker.js";
import { buildSandboxSpec, networkPolicyOf, type SandboxConfig, sandboxConfigOf, validAllowedHost } from "./policy.js";
import type { SandboxRegistry } from "./registry.js";
import { type NetworkMode, type NetworkPolicy, SANDBOX_AUTO, SANDBOX_OFF, type SandboxHandle, type SandboxProvider, type SandboxSpec } from "./types.js";

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
   * Docker's `-e NAME`).
   */
  launcher(handle: SandboxHandle, argv: readonly string[], envNames?: readonly string[]): string;
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

/** What a setting resolves to for a backend now (no side effects beyond a cached probe). */
export async function resolveSandbox(opts: {
  registry: SandboxRegistry;
  config: SandboxConfig;
  setting: SessionSandboxSetting | undefined;
  backendId: string;
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
  const c = confinementFor(opts.backendId, provider);
  if (!c.ok) return { info: { ...base, ...named, state: "unavailable", reason: c.reason, enforced: false }, provider, plan: null, network };
  const net = enforcedNetwork(c.plan, network.mode, provider.displayName);
  const limits = [...c.plan.limits, ...(net.note ? [net.note] : [])];
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
  #closed = false;
  #launcherDir: string | null = null;
  #launchers = 0;

  constructor(opts: { sessionId: string; workdir: string; registry: SandboxRegistry; config?: CodeoidConfig; setting?: SessionSandboxSetting }) {
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
    return this.#resolvedFor === backendId;
  }

  /** Change the setting; the next {@link refresh} resolves it. Handles opened under the old one are closed. */
  async set(setting: SessionSandboxSetting | undefined): Promise<void> {
    this.#setting = setting && Object.keys(setting).length > 0 ? { ...setting } : undefined;
    this.#resolvedFor = null;
    await this.#closeHandles();
  }

  /** Resolve for `backendId` (a provider switch, a setting change, the first turn). */
  async refresh(backendId: string): Promise<SessionSandboxInfo> {
    const r = await resolveSandbox({ registry: this.#registry, config: this.config, setting: this.#setting, backendId });
    if (this.#closed) {
      this.#runtime = null;
      return r.info;
    }
    this.#info = r.info;
    this.#resolvedFor = backendId;
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
      launcher: (handle, argv, envNames) => this.#writeLauncher(handle, argv, envNames ?? []),
    };
    return r.info;
  }

  #writeLauncher(handle: SandboxHandle, argv: readonly string[], envNames: readonly string[]): string {
    if (!handle.wrap) throw new Error(`${handle.providerId} can't start a local program inside`);
    if (!this.#launcherDir) {
      const safe = this.#sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "session";
      this.#launcherDir = mkdtempSync(`${launcherRoot()}${safe}-`);
    }
    // Started from wherever its caller is: the cwd is the caller's, not fixed here.
    const wrapped = handle.wrap(argv, { cwd: "", env: Object.fromEntries(envNames.map((n) => [n, ""])) });
    const path = join(this.#launcherDir, `launch-${++this.#launchers}`);
    writeFileSync(path, launcherScript(wrapped.argv), { mode: 0o700 });
    return path;
  }

  #track(h: SandboxHandle): SandboxHandle {
    this.#handles.add(h);
    return h;
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
    if (!this.#tempDir) {
      const safe = this.#sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "session";
      this.#tempDir = mkdtempSync(join(tmpdir(), `codeoid-sandbox-${safe}-`));
    }
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
    if (this.#launcherDir) {
      rmSync(this.#launcherDir, { recursive: true, force: true });
      this.#launcherDir = null;
    }
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

/** Where every session's launchers live: `<this prefix><session>-<random>/launch-<n>` (the opencode shell shim checks it). */
export function launcherRoot(): string {
  return join(tmpdir(), "codeoid-launch-");
}
