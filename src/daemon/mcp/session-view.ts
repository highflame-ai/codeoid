/**
 * A session's view of its MCP servers (#395): the daemon-wide registry, plus
 * the session's own workdir servers from Claude's config, so they reach every
 * backend in that workdir — and only there.
 *
 * - The user's own (`claude mcp add` local scope) always count.
 * - A repo's (`.mcp.json`) count once approved — in Claude (its own approval,
 *   from the user's `~/.claude.json`) or in codeoid (the drawer's Approve,
 *   bound to that exact entry).
 * - codeoid's own entries (config, adopted, built-in) win over a workdir one
 *   of the same name; the user's own workdir entry wins over one imported
 *   from Claude's global config (as Claude itself orders them); a repo's
 *   never stands in for anything of the same (or a look-alike) name.
 * - On Claude the workdir ones aren't added: the Claude CLI loads its own.
 *   Qwen Code reads a project's `.mcp.json` itself too (under its own
 *   folder trust, measured): those aren't added on Qwen either — a copy of
 *   the same name would only collide with Qwen's own.
 * - A plain HTTP server found to want an OAuth sign-in is held back from the
 *   backends that would only get 401s from it (for this session's tenant).
 *
 * What's applied changes only on `load()` — the session's start, or a refresh
 * the user asks for (a backend restart is the cost of applying a change).
 * `stale()` and the drawer's reach read the files without applying anything.
 */

import type { McpHub } from "./hub.js";
import type { McpTenant } from "./oauth.js";
import { isReservedMcpName, normalizeSpec, type McpRegistry, type McpServerView } from "./registry.js";
import { isOAuthServer, type McpServerSpec } from "./types.js";
import { readGlobalServers, readWorkdirServers, type WorkdirServer } from "./workdir-servers.js";

/** Why a server reaches only Claude (or this session's backend's own copy), when it does. */
export type WorkdirReach =
  | { reach: "all" }
  | { reach: "claude-only"; why: "needs-approval" | "needs-refresh" | "shadowed" | "needs-sign-in" | "reserved-name" | "read-by-backend" };

/** Backends that read a project's `.mcp.json` themselves, under their own consent. */
const READS_MCP_JSON = new Set(["claude", "qwen"]);

export interface SessionMcpViewOptions {
  workdir: string;
  tenant: McpTenant;
  /** codeoid-side approvals of repo servers ("server\0fingerprint"). */
  approvals: () => ReadonlySet<string>;
  /** Injected for tests. */
  read?: (workdir: string) => Promise<WorkdirServer[]>;
  /** Injected for tests: the user's global Claude servers (null: leave the registry's as they are). */
  readGlobal?: () => Promise<Record<string, import("../../config.js").RawMcpServerConfig> | null>;
}

/** What changed when a view was applied. */
export interface ViewChange {
  changed: boolean;
  /** Workdir servers no longer applied: their clients can go. */
  removed: McpServerSpec[];
}

/** The drawer's per-row answers, from one indexing pass. */
export interface ReachSnapshot {
  reachOf(name: string, path: string): WorkdirReach | undefined;
  reachOfGlobal(name: string, url: string | null, command: string | null): WorkdirReach;
  fingerprintOf(name: string, path: string): string | undefined;
}

export class SessionMcpView implements McpServerView {
  readonly #base: McpRegistry;
  readonly #hub: McpHub | null;
  readonly #opts: SessionMcpViewOptions;
  /** Every server the workdir declared, as last read (applied or not). */
  #read: WorkdirServer[] = [];
  /** The ones applied to this session's backends. */
  #layer: McpServerSpec[] = [];
  /** Names a `.mcp.json` declares (applied or not): a backend that reads it has its own. */
  #mcpJsonNames = new Set<string>();
  /** The applied ones declared in a `.mcp.json`, by name and fingerprint. */
  #fromMcpJson = new Set<string>();
  #fingerprint = "";
  #loaded = false;

  constructor(base: McpRegistry, hub: McpHub | null, opts: SessionMcpViewOptions) {
    this.#base = base;
    this.#hub = hub;
    this.#opts = opts;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  /** Read Claude's config (global and workdir) and apply it. */
  async load(): Promise<ViewChange> {
    const [read, global] = await Promise.all([this.#readWorkdir(), this.#readGlobal()]);
    // The user's global servers, as they are now (the daemon-wide registry's
    // imported entries; a change there is the user's own config).
    const globalsChanged = global ? this.#base.syncImported(global).length > 0 : false;
    const layer = this.#resolve(read);
    const fingerprint = this.#fingerprintOf(layer);
    const changed = this.#loaded && (globalsChanged || fingerprint !== this.#fingerprint);
    const kept = new Set(layer.map(keyOf));
    const removed = this.#layer.filter((s) => !kept.has(keyOf(s)));
    this.#apply(read, layer);
    this.#fingerprint = fingerprint;
    this.#loaded = true;
    return { changed, removed };
  }

  /** Whether loading again would change what's applied — without applying anything. */
  async stale(): Promise<boolean> {
    if (!this.#loaded) return false;
    const [read, global] = await Promise.all([this.#readWorkdir(), this.#readGlobal()]);
    this.#read = read; // for the drawer's reach; nothing applied
    this.#mcpJsonNames = new Set(read.filter((w) => isMcpJson(w.path)).map((w) => w.name));
    if (global && globalFingerprint(global, this.#base) !== this.#base.importedFingerprint()) return true;
    return this.#fingerprintOf(this.#resolve(read)) !== this.#fingerprint;
  }

  /** Read the workdir's servers for the drawer before the view is applied (applies nothing). */
  async peek(): Promise<void> {
    if (this.#loaded) return;
    this.#read = await this.#readWorkdir();
    this.#mcpJsonNames = new Set(this.#read.filter((w) => isMcpJson(w.path)).map((w) => w.name));
  }

  /**
   * The drawer's answers for every row at once (#395): what applies, what
   * would, and how each server reaches `backendId` — indexed once, so a row
   * costs a lookup however many servers a config holds.
   */
  snapshot(backendId?: string): ReachSnapshot {
    const byEntry = new Map(this.#read.map((w) => [`${w.name}\u0000${w.path}`, w]));
    const appliedNow = this.#loaded ? this.#layer : this.#resolve(this.#read);
    const applied = new Map(appliedNow.map((s) => [`${s.name}\u0000${s.variant ?? ""}`, s]));
    const would = new Set(this.#resolve(this.#read).map((s) => `${s.name}\u0000${s.variant ?? ""}`));
    const merged = new Map(this.#merged(undefined).map((s) => [s.name, s]));
    const readByBackend = (name: string) => this.#readByBackend(name, backendId);
    return {
      fingerprintOf: (name, path) => byEntry.get(`${name}\u0000${path}`)?.fingerprint,
      reachOf: (name, path) => {
        const entry = byEntry.get(`${name}\u0000${path}`);
        if (!entry) return undefined;
        if (isReservedMcpName(name)) return { reach: "claude-only", why: "reserved-name" };
        if (readByBackend(name)) return { reach: "claude-only", why: "read-by-backend" };
        const spec = applied.get(`${name}\u0000${entry.fingerprint}`);
        if (spec) return this.#heldBack(spec) ? { reach: "claude-only", why: "needs-sign-in" } : { reach: "all" };
        if (!this.#consented(entry)) return { reach: "claude-only", why: "needs-approval" };
        return { reach: "claude-only", why: would.has(`${name}\u0000${entry.fingerprint}`) ? "needs-refresh" : "shadowed" };
      },
      reachOfGlobal: (name, url, command) => {
        if (isReservedMcpName(name)) return { reach: "claude-only", why: "reserved-name" };
        if (readByBackend(name)) return { reach: "claude-only", why: "read-by-backend" };
        const spec = merged.get(name);
        const same =
          spec?.origin === "claude-global" &&
          (spec.transport.kind === "http" ? spec.transport.url === url : spec.transport.kind === "stdio" && spec.transport.command === command);
        if (!spec || !same) return { reach: "claude-only", why: "shadowed" };
        return this.#heldBack(spec) ? { reach: "claude-only", why: "needs-sign-in" } : { reach: "all" };
      },
    };
  }

  /** The workdir servers applied now (their hub clients go with the session). */
  workdirSpecs(): readonly McpServerSpec[] {
    return this.#layer;
  }

  /** How far a workdir server (by name and file) reaches on `backendId` (the session's). */
  reachOf(name: string, path: string, backendId?: string): WorkdirReach | undefined {
    return this.snapshot(backendId).reachOf(name, path);
  }

  /** How far a server from Claude's global config reaches on `backendId`. */
  reachOfGlobal(name: string, url: string | null, command: string | null, backendId?: string): WorkdirReach {
    return this.snapshot(backendId).reachOfGlobal(name, url, command);
  }

  /** The URL Claude dials for `name`, when every entry of that name agrees on one. */
  claudeUrlOf(name: string): string | undefined {
    const urls = new Set<string>();
    const base = this.#base.get(name);
    if (base?.transport.kind === "http") urls.add(base.transport.url);
    for (const w of this.#read) if (w.name === name && w.raw.url) urls.add(w.raw.url);
    return urls.size === 1 ? [...urls][0] : undefined;
  }

  // ── McpServerView ──

  list(): McpServerSpec[] {
    return this.#merged(undefined);
  }

  get(name: string): McpServerSpec | undefined {
    return this.list().find((s) => s.name === name);
  }

  forBackend(backendId: string): McpServerSpec[] {
    return this.#merged(backendId).filter(
      (s) => s.enabled && (s.backends === undefined || s.backends.includes(backendId)) && !(backendId !== "claude" && this.#heldBack(s)),
    );
  }

  oauthFor(backendId: string): McpServerSpec[] {
    return this.forBackend(backendId).filter((s) => !s.builtin && isOAuthServer(s));
  }

  forNativeMount(backendId: string): McpServerSpec[] {
    return this.forBackend(backendId).filter((s) => !s.builtin && !isOAuthServer(s));
  }

  // ── internals ──

  #readWorkdir(): Promise<WorkdirServer[]> {
    return (this.#opts.read ?? readWorkdirServers)(this.#opts.workdir);
  }

  #readGlobal(): Promise<Record<string, import("../../config.js").RawMcpServerConfig> | null> {
    return this.#opts.readGlobal ? this.#opts.readGlobal() : readGlobalServers();
  }

  #apply(read: WorkdirServer[], layer: McpServerSpec[]): void {
    this.#read = read;
    this.#layer = layer;
    this.#mcpJsonNames = new Set(read.filter((w) => isMcpJson(w.path)).map((w) => w.name));
    this.#fromMcpJson = new Set(read.filter((w) => isMcpJson(w.path)).map((w) => `${w.name}\u0000${w.fingerprint}`));
  }

  /** A backend that reads the project's `.mcp.json` itself uses its own copy of any name declared there. */
  #readByBackend(name: string, backendId: string | undefined): boolean {
    return backendId !== undefined && backendId !== "claude" && READS_MCP_JSON.has(backendId) && this.#mcpJsonNames.has(name);
  }

  /** The registry with the workdir layer applied (not on Claude, which loads its own). */
  #merged(backendId: string | undefined): McpServerSpec[] {
    const byName = new Map(this.#base.list().map((s) => [s.name, s]));
    if (backendId !== "claude") {
      for (const spec of this.#layer) {
        // A backend that reads the project's .mcp.json itself has its own copy.
        if (backendId && READS_MCP_JSON.has(backendId) && this.#fromMcpJson.has(`${spec.name}\u0000${spec.variant ?? ""}`)) continue;
        const existing = byName.get(spec.name);
        // Only an import from Claude's global config gives way — to the
        // user's own workdir entry. A repo's never displaces anything.
        if (existing && !(existing.origin === "claude-global" && spec.origin === "claude-local")) continue;
        byName.set(spec.name, spec);
      }
    }
    return [...byName.values()];
  }

  /** The workdir servers that apply, by consent and precedence. */
  #resolve(read: readonly WorkdirServer[]): McpServerSpec[] {
    const loose = (n: string) => n.toLowerCase().replace(/-/g, "_");
    const taken = new Map(this.#base.list().map((s) => [loose(s.name), s]));
    const out: McpServerSpec[] = [];
    // The user's own first: a repo's of the same name never stands in for them.
    const ordered = [...read].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === "claude-local" ? -1 : 1));
    for (const w of ordered) {
      if (isReservedMcpName(w.name) || !this.#consented(w)) continue;
      const existing = taken.get(loose(w.name));
      if (existing) {
        const userOverImport = w.origin === "claude-local" && existing.origin === "claude-global" && existing.name === w.name;
        if (!userOverImport) continue;
      }
      const base = normalizeSpec(w.name, w.raw);
      // A stdio server runs in its workdir, as every backend that reads it runs it.
      const transport = base.transport.kind === "stdio" ? { ...base.transport, cwd: this.#opts.workdir } : base.transport;
      const spec: McpServerSpec = { ...base, transport, origin: w.origin, variant: w.fingerprint };
      taken.set(loose(w.name), spec);
      out.push(spec);
    }
    return out;
  }

  #consented(w: WorkdirServer): boolean {
    if (w.origin === "claude-local") return true;
    return w.claudeApproval === "approved" || this.#opts.approvals().has(`${w.name}\u0000${w.fingerprint}`);
  }

  /** A plain HTTP server that has asked this tenant for an OAuth sign-in. */
  #heldBack(spec: McpServerSpec): boolean {
    return spec.transport.kind === "http" && !isOAuthServer(spec) && (this.#hub?.needsSignIn(spec.transport.url, this.#opts.tenant) ?? false);
  }

  /** What's applied: the workdir layer and the imported global entries. */
  #fingerprintOf(layer: readonly McpServerSpec[]): string {
    const local = layer
      .map((s) => `${s.name}\u0000${s.variant ?? ""}`)
      .sort()
      .join("\u0001");
    return `${local}\u0002${this.#base.importedFingerprint()}`;
  }
}

function keyOf(spec: McpServerSpec): string {
  return `${spec.name}\u0000${spec.variant ?? ""}`;
}

function isMcpJson(file: string): boolean {
  return file.endsWith("/.mcp.json") || file.endsWith("\\.mcp.json");
}

/** The fingerprint `McpRegistry.importedFingerprint()` would give for these entries. */
function globalFingerprint(servers: Record<string, import("../../config.js").RawMcpServerConfig>, base: McpRegistry): string {
  return Object.entries(servers)
    // As syncImported would take them: not reserved, not one of codeoid's own entries.
    .filter(([name]) => {
      const existing = base.get(name);
      return !isReservedMcpName(name) && (!existing || existing.origin === "claude-global");
    })
    .map(([name, raw]) => `${name}\u0000${JSON.stringify({ ...normalizeSpec(name, raw), origin: "claude-global" }.transport)}`)
    .sort()
    .join("\u0001");
}
