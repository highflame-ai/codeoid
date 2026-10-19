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
 *   of the same name; the user's own workdir entry wins over one from Claude's
 *   global config (as Claude itself orders them); a repo's never stands in
 *   for anything of the same (or a look-alike) name.
 * - On Claude the workdir ones aren't added: the Claude CLI loads its own.
 *   Qwen Code reads a project's `.mcp.json` itself too (measured): any name
 *   that file declares is left to Qwen's own copy on Qwen.
 * - A plain HTTP server found to want an OAuth sign-in is held back from the
 *   backends that would only get 401s from it (for this session's tenant).
 *
 * The user's global Claude servers are a snapshot of this session's too: the
 * registry holds what the daemon imported at start, and a session's refresh
 * re-reads them for that session alone — another session's servers change
 * only when it refreshes.
 *
 * What's applied changes only on `load()` — the session's first turn, or a
 * refresh the user asks for (a backend restart is the cost of applying a
 * change). `stale()` and the drawer's reach read the files without applying
 * anything. A file that can't be read just now (Claude Code mid-rewrite) is
 * no change, never "everything was removed".
 */

import type { RawMcpServerConfig } from "../../config.js";
import type { McpHub } from "./hub.js";
import type { McpTenant } from "./oauth.js";
import { isReservedMcpName, normalizeSpec, type McpRegistry, type McpServerView } from "./registry.js";
import { isOAuthServer, type McpServerSpec } from "./types.js";
import { fingerprintOf as entryFingerprint, readGlobalServers, readWorkdirServers, type WorkdirServer } from "./workdir-servers.js";

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
  /** Injected for tests (null: can't be read just now). */
  read?: (workdir: string) => Promise<WorkdirServer[] | null>;
  /** Injected for tests: the user's global Claude servers (null: can't be read just now). */
  readGlobal?: () => Promise<Record<string, RawMcpServerConfig> | null>;
}

/** What changed when a view was applied. */
export interface ViewChange {
  changed: boolean;
  /** This session's own servers (workdir ones, its global snapshot) it now uses, and no longer does. */
  added: McpServerSpec[];
  removed: McpServerSpec[];
}

/** The drawer's per-row answers, from one indexing pass. */
export interface ReachSnapshot {
  reachOf(name: string, path: string): WorkdirReach | undefined;
  reachOfGlobal(name: string, url: string | null, command: string | null): WorkdirReach;
  /** A project's entry's fingerprint (what an approval binds to). */
  fingerprintOf(name: string, path: string): string | undefined;
}

export class SessionMcpView implements McpServerView {
  readonly #base: McpRegistry;
  readonly #hub: McpHub | null;
  readonly #opts: SessionMcpViewOptions;
  /** Every server the workdir declared, as last read (applied or not). */
  #read: WorkdirServer[] = [];
  /** The user's global servers as last read (applied or not); null until read. */
  #readGlobals: Record<string, RawMcpServerConfig> | null = null;
  /** The workdir servers applied to this session's backends. */
  #layer: McpServerSpec[] = [];
  /** The global servers applied (this session's snapshot); null: the registry's own. */
  #globals: McpServerSpec[] | null = null;
  /** The names the project's .mcp.json declared when applied: left to a backend that reads it itself. */
  #mcpJsonNames: ReadonlySet<string> = new Set();
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

  /** What's applied, as one comparable value. */
  get fingerprint(): string {
    return this.#fingerprint;
  }

  /** This session's own servers in use, once each: their hub clients are its to let go. */
  ownSpecs(): McpServerSpec[] {
    return [...new Map([...this.#layer, ...(this.#globals ?? [])].map((s) => [keyOf(s), s])).values()];
  }

  /** Read Claude's config (global and workdir) and apply it. */
  async load(): Promise<ViewChange> {
    await this.#readAll();
    const before = new Map(this.ownSpecs().map((s) => [keyOf(s), s]));
    const globals = this.#readGlobals ? this.#globalSpecs(this.#readGlobals) : this.#globals;
    const layer = this.#resolve(this.#read, globals);
    const mcpJsonNames = mcpJsonNamesOf(this.#read);
    const fingerprint = fingerprintOfApplied(layer, globals, mcpJsonNames);
    const changed = this.#loaded && fingerprint !== this.#fingerprint;
    this.#layer = layer;
    this.#globals = globals;
    this.#mcpJsonNames = mcpJsonNames;
    this.#fingerprint = fingerprint;
    this.#loaded = true;
    const after = new Map(this.ownSpecs().map((s) => [keyOf(s), s]));
    return {
      changed,
      added: [...after].filter(([k]) => !before.has(k)).map(([, s]) => s),
      removed: [...before].filter(([k]) => !after.has(k)).map(([, s]) => s),
    };
  }

  /** Whether loading again would change what's applied — without applying anything. */
  async stale(): Promise<boolean> {
    if (!this.#loaded) return false;
    await this.#readAll();
    const globals = this.#readGlobals ? this.#globalSpecs(this.#readGlobals) : this.#globals;
    return fingerprintOfApplied(this.#resolve(this.#read, globals), globals, mcpJsonNamesOf(this.#read)) !== this.#fingerprint;
  }

  /** Read Claude's config for the drawer before the view is applied (applies nothing). */
  async peek(): Promise<void> {
    if (!this.#loaded) await this.#readAll();
  }

  /**
   * The drawer's answers for every row at once: what applies (or, before the
   * first turn, will), what would on a refresh, and how each server reaches
   * `backendId` — indexed once, so a row costs a lookup however many servers.
   */
  snapshot(backendId?: string): ReachSnapshot {
    const approvals = this.#opts.approvals();
    const byEntry = new Map(this.#read.map((w) => [`${w.name}\u0000${w.path}`, w]));
    const freshGlobals = this.#readGlobals ? this.#globalSpecs(this.#readGlobals) : this.#globals;
    const wouldLayer = this.#resolve(this.#read, freshGlobals, approvals);
    const appliedLayer = this.#loaded ? this.#layer : wouldLayer;
    const appliedGlobals = this.#loaded ? this.#globals : freshGlobals;
    const entryKey = (s: McpServerSpec) => `${s.name}\u0000${s.variant ?? ""}`; // a workdir entry: its name and fingerprint
    const applied = new Map(appliedLayer.map((s) => [entryKey(s), s]));
    const would = new Set(wouldLayer.map(entryKey));
    const mcpJsonNames = this.#loaded ? this.#mcpJsonNames : mcpJsonNamesOf(this.#read);
    const merged = new Map(this.#mergedWith(undefined, appliedLayer, appliedGlobals, mcpJsonNames).map((s) => [s.name, s]));
    const readByBackend = (name: string) =>
      backendId !== undefined && backendId !== "claude" && READS_MCP_JSON.has(backendId) && mcpJsonNames.has(name);
    return {
      fingerprintOf: (name, path) => {
        const w = byEntry.get(`${name}\u0000${path}`);
        // Only a project's entry is ever approved; the user's own carry no fingerprint out.
        return w?.origin === "claude-repo" ? w.fingerprint : undefined;
      },
      reachOf: (name, path) => {
        const entry = byEntry.get(`${name}\u0000${path}`);
        if (!entry) return undefined;
        if (isReservedMcpName(name)) return { reach: "claude-only", why: "reserved-name" };
        if (readByBackend(name)) return { reach: "claude-only", why: "read-by-backend" };
        const spec = applied.get(`${name}\u0000${entry.fingerprint}`);
        if (spec) return this.#heldBack(spec) ? { reach: "claude-only", why: "needs-sign-in" } : { reach: "all" };
        if (!this.#consented(entry, approvals)) return { reach: "claude-only", why: "needs-approval" };
        return { reach: "claude-only", why: would.has(`${name}\u0000${entry.fingerprint}`) ? "needs-refresh" : "shadowed" };
      },
      reachOfGlobal: (name, url, command) => {
        if (isReservedMcpName(name)) return { reach: "claude-only", why: "reserved-name" };
        if (readByBackend(name)) return { reach: "claude-only", why: "read-by-backend" };
        const spec = merged.get(name);
        const same =
          spec?.origin === "claude-global" &&
          (spec.transport.kind === "http" ? spec.transport.url === url : spec.transport.kind === "stdio" && spec.transport.command === command);
        if (!spec || !same) {
          // Not applied: a refresh would, if it's in the fresh read and nothing else wins.
          const fresh = freshGlobals?.find((s) => s.name === name);
          return { reach: "claude-only", why: fresh && !merged.has(name) ? "needs-refresh" : "shadowed" };
        }
        return this.#heldBack(spec) ? { reach: "claude-only", why: "needs-sign-in" } : { reach: "all" };
      },
    };
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
    const g = this.#readGlobals?.[name];
    if (g?.url) urls.add(g.url);
    for (const w of this.#read) if (w.name === name && w.raw.url) urls.add(w.raw.url);
    return urls.size === 1 ? [...urls][0] : undefined;
  }

  /** Whose approval let a project's server apply: Claude Code's, or codeoid's (for the audit). */
  repoConsent(spec: McpServerSpec): "claude" | "codeoid" | undefined {
    if (spec.origin !== "claude-repo") return undefined;
    const w = this.#read.find((r) => r.origin === "claude-repo" && r.name === spec.name && r.fingerprint === spec.variant);
    return w?.claudeApproval === "approved" ? "claude" : "codeoid";
  }

  /** A name the project's .mcp.json declared, on a backend that loads that file itself: its tools may be the repo's. */
  leftToBackend(name: string, backendId: string): boolean {
    return READS_MCP_JSON.has(backendId) && this.#mcpJsonNames.has(name);
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

  /** Read both; a file that can't be read just now leaves the last read as it was. */
  async #readAll(): Promise<void> {
    const [read, global] = await Promise.all([
      (this.#opts.read ?? readWorkdirServers)(this.#opts.workdir),
      this.#opts.readGlobal ? this.#opts.readGlobal() : readGlobalServers(),
    ]);
    if (read) this.#read = read;
    if (global) this.#readGlobals = global;
  }

  /** The user's global servers as this session's specs: codeoid's own names and reserved ones excluded. */
  #globalSpecs(global: Record<string, RawMcpServerConfig>): McpServerSpec[] {
    const out: McpServerSpec[] = [];
    for (const [name, raw] of Object.entries(global)) {
      const existing = this.#base.get(name);
      if (isReservedMcpName(name) || (existing && existing.origin !== "claude-global")) continue;
      out.push({ ...normalizeSpec(name, raw), origin: "claude-global", variant: entryFingerprint(raw) });
    }
    return out;
  }

  #merged(backendId: string | undefined): McpServerSpec[] {
    return this.#mergedWith(backendId, this.#layer, this.#globals, this.#mcpJsonNames);
  }

  /**
   * The registry with this session's global snapshot and workdir layer
   * applied. On Claude the workdir layer isn't (the CLI loads its own); on a
   * backend that reads the project's .mcp.json, nothing of a name declared there is.
   */
  #mergedWith(
    backendId: string | undefined,
    layer: readonly McpServerSpec[],
    globals: readonly McpServerSpec[] | null,
    declared: ReadonlySet<string>,
  ): McpServerSpec[] {
    const byName = new Map<string, McpServerSpec>();
    for (const s of this.#base.list()) if (!(globals && s.origin === "claude-global")) byName.set(s.name, s);
    for (const g of globals ?? []) if (!byName.has(g.name)) byName.set(g.name, g);
    if (backendId !== "claude") {
      const mcpJsonNames = backendId && READS_MCP_JSON.has(backendId) ? declared : null;
      for (const spec of layer) {
        if (mcpJsonNames?.has(spec.name)) continue;
        const existing = byName.get(spec.name);
        // Only an entry from Claude's global config gives way — to the user's
        // own workdir entry. A repo's never displaces anything.
        if (existing && !(existing.origin === "claude-global" && spec.origin === "claude-local")) continue;
        byName.set(spec.name, spec);
      }
    }
    return [...byName.values()];
  }

  /** The workdir servers that apply, by consent and precedence. */
  #resolve(read: readonly WorkdirServer[], globals: readonly McpServerSpec[] | null, approvals = this.#opts.approvals()): McpServerSpec[] {
    const loose = (n: string) => n.toLowerCase().replace(/-/g, "_");
    const taken = new Map<string, McpServerSpec>();
    for (const s of this.#base.list()) if (!(globals && s.origin === "claude-global")) taken.set(loose(s.name), s);
    for (const g of globals ?? []) if (!taken.has(loose(g.name))) taken.set(loose(g.name), g);
    const out: McpServerSpec[] = [];
    // The user's own first: a repo's of the same name never stands in for them.
    const ordered = [...read].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === "claude-local" ? -1 : 1));
    for (const w of ordered) {
      if (isReservedMcpName(w.name) || !this.#consented(w, approvals)) continue;
      const existing = taken.get(loose(w.name));
      if (existing) {
        const userOverGlobal = w.origin === "claude-local" && existing.origin === "claude-global" && existing.name === w.name;
        if (!userOverGlobal) continue;
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

  #consented(w: WorkdirServer, approvals: ReadonlySet<string>): boolean {
    if (w.origin === "claude-local") return true;
    return w.claudeApproval === "approved" || approvals.has(`${w.name}\u0000${w.fingerprint}`);
  }

  /** A plain HTTP server that has asked this tenant for an OAuth sign-in. */
  #heldBack(spec: McpServerSpec): boolean {
    return spec.transport.kind === "http" && !isOAuthServer(spec) && (this.#hub?.needsSignIn(spec.transport.url, this.#opts.tenant) ?? false);
  }
}

/** A session's own server, as the hub keys its client (with the workdir and tenant). */
export function mcpSpecKey(spec: McpServerSpec): string {
  return keyOf(spec);
}

function keyOf(spec: McpServerSpec): string {
  // As the hub keys its client (hub.ts clientKey): a stdio server's workdir too.
  const cwd = spec.transport.kind === "stdio" ? (spec.transport.cwd ?? "") : "";
  return `${spec.name}\u0000${spec.variant ?? ""}\u0000${cwd}`;
}

function isMcpJson(file: string): boolean {
  return file.endsWith("/.mcp.json") || file.endsWith("\\.mcp.json");
}

/** What's applied — the workdir layer and the global snapshot — as one comparable value. */
function fingerprintOfApplied(layer: readonly McpServerSpec[], globals: readonly McpServerSpec[] | null, mcpJsonNames: ReadonlySet<string>): string {
  const part = (specs: readonly McpServerSpec[]) => specs.map(keyOf).sort().join("\u0001");
  return `${part(layer)}\u0002${globals ? part(globals) : "-"}\u0002${[...mcpJsonNames].sort().join("\u0001")}`;
}

function mcpJsonNamesOf(read: readonly WorkdirServer[]): ReadonlySet<string> {
  return new Set(read.filter((w) => isMcpJson(w.path)).map((w) => w.name));
}
