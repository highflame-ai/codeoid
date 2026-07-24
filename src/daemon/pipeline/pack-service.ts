/**
 * PackService — the runtime pack layer (docs/pack-loading.md).
 *
 * Turns pack loading from a boot-only config read into a live, curatable surface:
 * add a git **registry**, discover the packs in it, **install** / **remove** /
 * **trust** / **select** individual packs — each change registered into the live
 * PipelineManager (when the pipeline is enabled) AND persisted to config.json so
 * it survives a restart. Always constructed (it is cheap: no DB, no runner), so a
 * user can curate packs even before turning the pipeline runtime on.
 *
 * State is authoritative IN MEMORY (initialized from config at construction),
 * mutated by the methods, and written back to config.json via the single shared
 * `mutateConfigFile` path. The daemon's boot-time `#config` is not the source of
 * truth for packs at runtime — this service is.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AvailablePackWire, PackWire, RegistryWire } from "@codeoid/protocol";
import type { Pack } from "./interface";
import { loadPack, type LoadedPack, type RoleDef } from "./pack";
import { loadSubagents, type PackSubagent } from "./subagents";

/** A pack resolved for ambient activation on a session (docs/pack-loading.md):
 *  its constitution, an optional capability role to run under, and the
 *  subagents its registry ships. */
export interface PackActivation {
  id: string;
  constitution?: string;
  /** The capability role named at activation (undefined = no tool restriction). */
  role?: RoleDef;
  roleName?: string;
  subagents: PackSubagent[];
}

/** The minimal slice of PipelineManager the service needs to (un)register packs
 *  for live effect — kept structural so tests can inject a fake. `installPack`
 *  registers the pack's skills + gates AND indexes it (so pipeline.create({pack})
 *  resolves it); `unregister` drops the index entry on removal. */
interface PackRegistrySink {
  installPack(pack: Pack): void;
  registries: { packs: { unregister(id: string): void; has(id: string): boolean } };
}

/** One configured registry (a git repo laid out like ai-factory). */
export interface RegistryEntry {
  name: string;
  url: string;
  ref?: string;
}

/** One installed pack: where it loaded from + host trust + provenance. */
export interface InstalledPackEntry {
  dir: string;
  trusted: boolean;
  /** Registry name it was installed from (absent for a hand-added dir). */
  registry?: string;
}

/** The pipeline sub-config slice this service reads + owns. */
export interface PackServiceConfig {
  defaultPack: string | null;
  packs: InstalledPackEntry[];
  registries: RegistryEntry[];
}

/** Result of a git invocation (injectable so tests don't shell out). */
export interface GitResult {
  ok: boolean;
  stderr: string;
}

export interface PackServiceDeps {
  /** Initial state (from config.pipeline at boot). */
  config: PackServiceConfig;
  /**
   * Persist the current pack state to config.json. Given the three fields to
   * write; the impl merges them under `pipeline` and atomically writes +
   * validates (see mutateConfigFile). Omit in tests to skip persistence.
   */
  persist?: (state: PackServiceConfig) => void;
  /** The live pipeline manager (register/unregister packs). Returns undefined
   *  when the pipeline is disabled — install still persists + is picked up on
   *  the next boot / enable. */
  manager?: () => PackRegistrySink | undefined;
  /** Base directory for registry caches (default: <configDir>/packs). */
  cacheDir?: string;
  /** Where to link a registry's runnable skills (default: ~/.claude/skills). */
  skillsDir?: string;
  /** Run git (injectable). Default: `git` via Bun.spawn. */
  git?: (args: string[], cwd?: string) => Promise<GitResult>;
}

/** Lightweight pack metadata read straight from a pack.yaml (no role/constitution
 *  IO) — enough to render an "available" card. */
interface PackMeta {
  id: string;
  name: string;
  version: string;
  description?: string;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

async function defaultGit(args: string[], cwd?: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stderr: stderr.trim() };
}

/** Derive a cache-safe registry name from a git URL (last path segment, minus
 *  `.git`). `git@github.com:highflame-ai/ai-factory.git` → `ai-factory`. */
export function registryNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe || !NAME_RE.test(safe)) throw new Error(`cannot derive a registry name from "${url}" — pass --name`);
  return safe;
}

export class PackService {
  #registries: RegistryEntry[];
  #packs: InstalledPackEntry[];
  #defaultPack: string | null;
  #cacheDir: string;
  #skillsDir: string;
  #git: (args: string[], cwd?: string) => Promise<GitResult>;
  #persist?: (state: PackServiceConfig) => void;
  #manager: PackServiceDeps["manager"];

  constructor(deps: PackServiceDeps) {
    this.#registries = [...deps.config.registries];
    this.#packs = [...deps.config.packs];
    this.#defaultPack = deps.config.defaultPack;
    this.#cacheDir = deps.cacheDir ?? join(homedir(), ".codeoid", "packs");
    this.#skillsDir = deps.skillsDir ?? join(homedir(), ".claude", "skills");
    this.#git = deps.git ?? defaultGit;
    this.#persist = deps.persist;
    this.#manager = deps.manager;
  }

  // ── Registries ────────────────────────────────────────────────────────────

  /** Absolute cache dir for a registry (whether or not it exists yet). */
  #cachePath(name: string): string {
    return join(this.#cacheDir, name);
  }

  listRegistries(): RegistryWire[] {
    return this.#registries.map((r) => {
      const cached = existsSync(join(this.#cachePath(r.name), ".git"));
      const packCount = cached ? this.#packDirsIn(this.#cachePath(r.name)).length : undefined;
      return { name: r.name, url: r.url, ref: r.ref, cached, packCount };
    });
  }

  /**
   * Add a registry: clone it into the cache (or pull if already cloned), then
   * persist it to config. Idempotent by name — re-adding refreshes. Throws on a
   * git failure or a name collision with a different URL.
   */
  async addRegistry(opts: { url: string; name?: string; ref?: string }): Promise<void> {
    const name = opts.name?.trim() || registryNameFromUrl(opts.url);
    if (!NAME_RE.test(name)) throw new Error(`invalid registry name "${name}"`);
    const existing = this.#registries.find((r) => r.name === name);
    if (existing && existing.url !== opts.url) {
      throw new Error(`registry "${name}" already points at a different url (${existing.url})`);
    }
    const dir = this.#cachePath(name);
    mkdirSync(this.#cacheDir, { recursive: true });
    if (existsSync(join(dir, ".git"))) {
      const pull = await this.#git(["pull", "--ff-only"], dir);
      if (!pull.ok) throw new Error(`git pull failed for registry "${name}": ${pull.stderr}`);
    } else {
      const args = ["clone", "--depth", "1"];
      if (opts.ref) args.push("--branch", opts.ref);
      // `--` before the positionals so a url beginning with `-` can't be parsed
      // as a git flag (option injection).
      args.push("--", opts.url, dir);
      const clone = await this.#git(args);
      if (!clone.ok) throw new Error(`git clone failed for "${opts.url}": ${clone.stderr}`);
    }
    // Re-check presence AFTER the async git boundary: two concurrent addRegistry
    // calls for the same name could both have seen it absent above, so guard the
    // push against a duplicate entry.
    if (!this.#registries.some((r) => r.name === name)) this.#registries.push({ name, url: opts.url, ref: opts.ref });
    this.#save();
  }

  /** Re-pull one registry (or all cached ones). Best-effort per registry. */
  async refresh(name?: string): Promise<void> {
    const targets = name ? this.#registries.filter((r) => r.name === name) : this.#registries;
    for (const r of targets) {
      const dir = this.#cachePath(r.name);
      if (!existsSync(join(dir, ".git"))) continue;
      const pull = await this.#git(["pull", "--ff-only"], dir);
      if (!pull.ok) throw new Error(`git pull failed for registry "${r.name}": ${pull.stderr}`);
    }
  }

  // Two steps required: pull alone leaves the live pipeline stale (issue #236).
  // Skills re-linked only for trusted packs — invariant from install()/trust() (issue #233).
  async refreshRegistry(name?: string): Promise<void> {
    await this.refresh(name);
    const mgr = this.#manager?.();
    const skillRoots = new Set<string>();
    for (const entry of this.#packs) {
      if (name !== undefined && entry.registry !== name) continue;
      if (!entry.registry) continue; // dir-installed pack — no registry to reload from
      try {
        const loaded = loadPack(entry.dir, { trusted: entry.trusted });
        mgr?.installPack(loaded);
      } catch (e) {
        console.warn(`[PackService] refreshRegistry: failed to reload ${entry.dir}:`, e);
      }
      if (entry.trusted) {
        const root = this.#cachePath(entry.registry);
        if (existsSync(root)) skillRoots.add(root);
      }
    }
    for (const root of skillRoots) this.#linkSkills(root);
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  /** Directories under `<registry>/packs` that contain a pack.yaml. */
  #packDirsIn(registryRoot: string): string[] {
    const packsRoot = join(registryRoot, "packs");
    if (!existsSync(packsRoot)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(packsRoot)) {
      const dir = join(packsRoot, entry);
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, "pack.yaml"))) out.push(dir);
      } catch {
        /* skip unreadable entries */
      }
    }
    return out;
  }

  /** Packs found across all cached registries but not yet installed. */
  available(): AvailablePackWire[] {
    const installedIds = new Set(this.installedIds());
    const out: AvailablePackWire[] = [];
    const seen = new Set<string>();
    for (const r of this.#registries) {
      for (const dir of this.#packDirsIn(this.#cachePath(r.name))) {
        const meta = readPackMeta(dir);
        if (!meta) continue;
        const key = `${r.name}/${meta.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: meta.id,
          name: meta.name,
          version: meta.version,
          description: meta.description,
          registry: r.name,
          dir,
          installed: installedIds.has(meta.id),
        });
      }
    }
    return out;
  }

  // ── Installed ─────────────────────────────────────────────────────────────

  /** Ids of installed packs (best-effort: skips a dir whose manifest won't parse). */
  installedIds(): string[] {
    const ids: string[] = [];
    for (const p of this.#packs) {
      const meta = readPackMeta(p.dir);
      if (meta) ids.push(meta.id);
    }
    return ids;
  }

  installed(): PackWire[] {
    const mgr = this.#manager?.();
    return this.#packs.map((entry) => {
      let loaded: LoadedPack;
      try {
        loaded = loadPack(entry.dir, { trusted: entry.trusted });
      } catch (e) {
        // Show broken packs rather than dropping them — an id we can't parse
        // still needs to be visible so the user can remove/fix it.
        const meta = readPackMeta(entry.dir);
        return {
          id: meta?.id ?? entry.dir,
          name: meta?.name ?? entry.dir,
          version: meta?.version ?? "?",
          dir: entry.dir,
          trusted: entry.trusted,
          selected: false,
          registry: entry.registry,
          phases: [],
          roles: [],
          gates: [],
          active: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      return {
        id: loaded.id,
        name: loaded.name,
        version: loaded.version,
        description: loaded.description,
        dir: entry.dir,
        trusted: entry.trusted,
        selected: this.#defaultPack === loaded.id,
        registry: entry.registry,
        phases: loaded.pipeline.map((p) => ({ id: p.id, name: p.name, role: p.role, gate: p.gate })),
        roles: Object.keys(loaded.roles),
        gates: loaded.gateSpecs,
        active: mgr?.registries.packs.has(loaded.id) ?? false,
      };
    });
  }

  /** The combined pack state (the wire payload for pipeline.pack.list). */
  snapshot(): { installed: PackWire[]; available: AvailablePackWire[]; registries: RegistryWire[] } {
    return { installed: this.installed(), available: this.available(), registries: this.listRegistries() };
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  /**
   * Install a pack — by its registry `id` (found in a cached registry) or from a
   * local `dir`. Validates via loadPack, persists to config, registers it into
   * the live manager (if any), and links the source registry's runnable skills
   * into the skills dir. Idempotent by pack id (re-installing updates trust/dir).
   */
  install(opts: { packId?: string; dir?: string; trusted?: boolean }): PackWire[] {
    const trusted = opts.trusted ?? false;
    let dir: string;
    let registry: string | undefined;
    let registryRoot: string | undefined;

    if (opts.dir !== undefined) {
      dir = resolve(opts.dir);
    } else if (opts.packId !== undefined) {
      const found = this.#findAvailable(opts.packId);
      if (!found) throw new Error(`pack "${opts.packId}" not found in any registry — add its registry first`);
      dir = found.dir;
      registry = found.registry;
      registryRoot = this.#cachePath(found.registry);
    } else {
      throw new Error("install: provide `packId` or `dir`");
    }

    // Validate: loadPack throws on a bad manifest / role / traversal.
    const loaded = loadPack(dir, { trusted });

    // Persist (replace any existing entry for the same id or dir).
    const others = this.#packs.filter((p) => p.dir !== dir && this.#idOf(p) !== loaded.id);
    this.#packs = [...others, { dir, trusted, registry }];
    this.#save();

    // Live effect: register the pack's skills + gates AND index it, so
    // pipeline.create({pack}) resolves it (installPack does the full wiring).
    this.#manager?.()?.installPack(loaded);

    // Make the pack runnable: link the registry's slash-skills into the skills
    // dir (best-effort, never overwrites an existing skill).
    //
    // Trust-gated, same as command gates. A skill's `!`…`` frontmatter runs a
    // host shell at slash-command expansion time, so linking an UNTRUSTED
    // pack's skills is executing declared shell without the operator opt-in the
    // gate path already requires — the exact "declaring is not executing" model
    // in loadPack. Only trusted packs get linked; an untrusted pack still
    // installs and indexes, it just contributes no runnable slash-skills.
    if (registryRoot && trusted) this.#linkSkills(registryRoot);

    return this.installed();
  }

  /** Remove an installed pack by id: unregister from the manager + drop config. */
  remove(packId: string): PackWire[] {
    this.#packs = this.#packs.filter((p) => this.#idOf(p) !== packId);
    if (this.#defaultPack === packId) this.#defaultPack = null;
    this.#save();
    this.#manager?.()?.registries.packs.unregister(packId);
    return this.installed();
  }

  /** Toggle host trust for an installed pack — reloads it at the new trust so its
   *  `command` gates start/stop being executable immediately. */
  trust(packId: string, trusted: boolean): PackWire[] {
    const entry = this.#packs.find((p) => this.#idOf(p) === packId);
    if (!entry) throw new Error(`pack "${packId}" is not installed`);
    entry.trusted = trusted;
    this.#save();
    // Re-register at the new trust level (gates are compiled at load).
    this.#manager?.()?.installPack(loadPack(entry.dir, { trusted }));
    // Trust gates skill linking (see install). Toggling ON must now make the
    // pack's slash-skills runnable — otherwise trusting is a no-op for skills
    // and the pack silently stays half-installed. (Toggling OFF leaves the
    // links; removing them belongs to `remove`, and unlinking live skills
    // mid-session is out of scope here.)
    if (trusted && entry.registry) {
      const root = this.#cachePath(entry.registry);
      if (existsSync(root)) this.#linkSkills(root);
    }
    return this.installed();
  }

  /** Set (or clear, with null) the selected/default pack. */
  select(packId: string | null): PackWire[] {
    if (packId !== null && !this.installedIds().includes(packId)) {
      throw new Error(`pack "${packId}" is not installed — install it before selecting`);
    }
    this.#defaultPack = packId;
    this.#save();
    return this.installed();
  }

  /** The currently selected (default) pack id, or null. */
  get selectedPack(): string | null {
    return this.#defaultPack;
  }

  /**
   * Resolve an installed pack for ambient session activation: its constitution,
   * an optional capability role (by name), and the subagents its registry
   * ships. Throws if the pack isn't installed, won't load, or (when `roleName`
   * is given) the pack doesn't declare that role — the daemon fail-closes.
   */
  resolveActivation(packId: string, roleName?: string): PackActivation {
    const entry = this.#packs.find((p) => this.#idOf(p) === packId);
    if (!entry) throw new Error(`pack "${packId}" is not installed`);
    const loaded = loadPack(entry.dir, { trusted: entry.trusted });
    let role: RoleDef | undefined;
    if (roleName) {
      role = loaded.roles[roleName];
      if (!role) {
        const have = Object.keys(loaded.roles).join(", ") || "none";
        throw new Error(`pack "${packId}" has no role "${roleName}" (roles: ${have})`);
      }
    }
    // Subagents ship at the registry root's `agents/` dir (like skills). A
    // local-dir install has no registry → no subagents.
    const subagents = entry.registry ? loadSubagents(join(this.#cachePath(entry.registry), "agents")) : [];
    return { id: loaded.id, constitution: loaded.constitution, role, roleName, subagents };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #idOf(entry: InstalledPackEntry): string | undefined {
    return readPackMeta(entry.dir)?.id;
  }

  #findAvailable(packId: string): { dir: string; registry: string } | undefined {
    for (const r of this.#registries) {
      for (const dir of this.#packDirsIn(this.#cachePath(r.name))) {
        if (readPackMeta(dir)?.id === packId) return { dir, registry: r.name };
      }
    }
    return undefined;
  }

  /** Symlink each `skills/<name>` in a registry into the skills dir — additively
   *  (never clobbers an existing skill). Best-effort: a link failure is logged,
   *  not fatal, since it only affects a pack's *runnability*, not its install. */
  #linkSkills(registryRoot: string): string[] {
    const src = join(registryRoot, "skills");
    if (!existsSync(src)) return [];
    const linked: string[] = [];
    try {
      mkdirSync(this.#skillsDir, { recursive: true });
    } catch {
      return [];
    }
    for (const name of readdirSync(src)) {
      const from = join(src, name);
      const to = join(this.#skillsDir, name);
      try {
        // lstatSync (NOT statSync): a `skills/<name>` that is itself a symlink in
        // an untrusted registry must NOT be treated as a directory and propagated
        // into the host skills dir (it could point at /etc, ~/.ssh, …). A real
        // directory links; a symlink is skipped.
        if (!lstatSync(from).isDirectory() || existsSync(to)) continue;
        symlinkSync(from, to, "dir");
        linked.push(name);
      } catch (e) {
        console.warn(`[packs] could not link skill "${name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return linked;
  }

  #save(): void {
    this.#persist?.({ defaultPack: this.#defaultPack, packs: this.#packs, registries: this.#registries });
  }
}

/** The pack-resolution capability a pipeline phase needs — satisfied by
 *  PackService, stubbable in tests. */
export interface PackActivator {
  resolveActivation(packId: string, roleName?: string): PackActivation;
}

/**
 * Resolve the pack activation for one pipeline phase, applying the per-phase
 * failure policy. A declared capability role is a SECURITY BOUNDARY: if it
 * can't be applied we fail CLOSED (throw) rather than silently run the worker
 * unrestricted — that would escalate a read-only phase to full write. Without a
 * role, activation only adds the constitution (guidance), so a resolution error
 * fails SOFT (logged) and the phase runs unactivated.
 *
 * A thrown error is caught upstream by the pipeline engine (→ phase failure →
 * onFail halt for a human); it never crashes the daemon.
 */
export function resolvePhaseActivation(
  packs: PackActivator,
  packId: string | undefined,
  roleName: string | undefined,
): PackActivation | undefined {
  if (!packId) return undefined;
  try {
    return packs.resolveActivation(packId, roleName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (roleName) {
      throw new Error(
        `pipeline phase pack activation failed for role "${roleName}" (pack="${packId}"): ${msg}`,
      );
    }
    console.warn(`[pipeline] phase pack activation failed (pack="${packId}"): ${msg}`);
    return undefined;
  }
}

/** Parse just enough of a pack.yaml to identify it — no role/constitution IO,
 *  so an available-pack listing stays cheap and never fails on a missing skill. */
function readPackMeta(dir: string): PackMeta | undefined {
  const path = join(dir, "pack.yaml");
  if (!existsSync(path)) return undefined;
  try {
    const raw = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const name = typeof raw.name === "string" ? raw.name : undefined;
    const version = typeof raw.version === "string" ? raw.version : undefined;
    if (!id || !name || !version) return undefined;
    return { id, name, version, description: typeof raw.description === "string" ? raw.description : undefined };
  } catch {
    return undefined;
  }
}
