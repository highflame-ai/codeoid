/**
 * SandboxRegistry — the daemon's sandbox providers (#448), like the
 * ProviderRegistry is its backends'. A setting names one by id, or `auto`
 * (the platform's own: bubblewrap on Linux, Seatbelt on macOS; Docker only
 * when chosen), or `off`. Probes are cached: a session asks on every
 * creation, and a probe runs a real sandbox.
 */

import { BwrapSandboxProvider } from "./bwrap.js";
import type { SandboxConfig } from "./policy.js";
import { SeatbeltSandboxProvider } from "./seatbelt.js";
import { SANDBOX_AUTO, SANDBOX_OFF, type SandboxProbe, type SandboxProvider } from "./types.js";

/** How long a probe's answer stands (a package installed meanwhile is seen within it). */
const PROBE_TTL_MS = 5 * 60_000;

/** What a sandbox setting resolves to. */
export type SandboxResolution =
  | { kind: "off" }
  | { kind: "provider"; provider: SandboxProvider; probe: SandboxProbe }
  | { kind: "unknown"; reason: string };

export class SandboxRegistry {
  readonly #providers = new Map<string, SandboxProvider>();
  readonly #probes = new Map<string, { at: number; probe: SandboxProbe; pending?: Promise<SandboxProbe> }>();
  readonly #platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.#platform = platform;
  }

  register(provider: SandboxProvider): void {
    if (this.#providers.has(provider.id)) throw new Error(`Sandbox provider "${provider.id}" is already registered`);
    if (provider.id === SANDBOX_AUTO || provider.id === SANDBOX_OFF) throw new Error(`"${provider.id}" is reserved`);
    this.#providers.set(provider.id, provider);
  }

  get(id: string): SandboxProvider | undefined {
    return this.#providers.get(id);
  }

  list(): SandboxProvider[] {
    return [...this.#providers.values()];
  }

  ids(): string[] {
    return [...this.#providers.keys()];
  }

  /** The provider `auto` means here: the first registered one for this platform that is local and mounts the workspace. */
  autoId(): string | null {
    const preferred = this.#platform === "linux" ? "bwrap" : this.#platform === "darwin" ? "seatbelt" : null;
    if (preferred && this.#providers.has(preferred)) return preferred;
    return null;
  }

  /** Whether `choice` names something this registry knows (`auto`, `off`, a provider id). */
  knows(choice: string): boolean {
    return choice === SANDBOX_AUTO || choice === SANDBOX_OFF || this.#providers.has(choice);
  }

  /** The cached probe of a provider, run when stale. */
  async probe(id: string): Promise<SandboxProbe> {
    const provider = this.#providers.get(id);
    if (!provider) return { available: false, reason: `no sandbox provider "${id}"` };
    if (!provider.capabilities.platforms.includes(this.#platform)) {
      return { available: false, reason: `${provider.displayName} doesn't run on ${this.#platform}` };
    }
    const had = this.#probes.get(id);
    if (had?.pending) return had.pending;
    if (had && Date.now() - had.at < PROBE_TTL_MS) return had.probe;
    const pending = provider.probe().catch((err): SandboxProbe => ({ available: false, reason: `probe failed: ${err instanceof Error ? err.message : String(err)}` }));
    this.#probes.set(id, { at: had?.at ?? 0, probe: had?.probe ?? { available: false, reason: "probing" }, pending });
    const probe = await pending;
    this.#probes.set(id, { at: Date.now(), probe });
    return probe;
  }

  /** The last probe of a provider without running one (null: never probed). */
  cachedProbe(id: string): SandboxProbe | null {
    const had = this.#probes.get(id);
    return had && !had.pending ? had.probe : null;
  }

  /** Forget cached probes (a settings change, a test). */
  resetProbes(): void {
    this.#probes.clear();
  }

  /** Resolve a setting (`auto`, `off`, an id) to a provider and whether it runs here. */
  async resolve(choice: string): Promise<SandboxResolution> {
    if (choice === SANDBOX_OFF) return { kind: "off" };
    const id = choice === SANDBOX_AUTO ? this.autoId() : choice;
    if (!id) return { kind: "unknown", reason: `no sandbox provider for ${this.#platform} — choose one (${this.ids().join(", ") || "none registered"}) or off` };
    const provider = this.#providers.get(id);
    if (!provider) return { kind: "unknown", reason: `unknown sandbox provider "${choice}" — available: ${[SANDBOX_AUTO, SANDBOX_OFF, ...this.ids()].join(", ")}` };
    return { kind: "provider", provider, probe: await this.probe(id) };
  }
}

/** The registry the daemon builds. */
export function createDefaultSandboxRegistry(config: SandboxConfig, platform: NodeJS.Platform = process.platform): SandboxRegistry {
  const registry = new SandboxRegistry(platform);
  registry.register(new BwrapSandboxProvider(config.bwrapPath ? { bwrapPath: config.bwrapPath } : {}));
  registry.register(new SeatbeltSandboxProvider());
  return registry;
}
