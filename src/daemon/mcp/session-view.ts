/**
 * A session's view of its MCP servers (#395): the daemon-wide registry, plus
 * the session's own workdir servers from Claude's config, so they reach every
 * backend in that workdir — and only there.
 *
 * - The user's own (`claude mcp add` local scope) always count.
 * - A repo's (`.mcp.json`, project settings) count once approved — in Claude
 *   (its own approval of the project's servers) or in codeoid (the drawer's
 *   Approve, bound to that exact entry).
 * - codeoid's own entries (config, adopted, built-in) win over a workdir one
 *   of the same name; the user's own workdir entry wins over one imported
 *   from Claude's global config (as Claude itself orders them); a repo's
 *   never stands in for anything of the same (or a look-alike) name.
 * - On Claude the workdir ones aren't added: the Claude CLI loads its own.
 * - A plain HTTP server found to want an OAuth sign-in is held back from the
 *   backends that would only get 401s from it, until it's adopted.
 *
 * The view is read when the session starts and when asked to refresh — never
 * on its own (a backend restart is the cost of applying a change).
 */

import type { McpHub } from "./hub.js";
import type { McpTenant } from "./oauth.js";
import { isReservedMcpName, normalizeSpec, type McpRegistry, type McpServerView } from "./registry.js";
import { isOAuthServer, type McpServerSpec } from "./types.js";
import { readWorkdirServers, type WorkdirServer } from "./workdir-servers.js";

/** Why a workdir server reaches only Claude, when it does. */
export type WorkdirReach =
  | { reach: "all" }
  | { reach: "claude-only"; why: "needs-approval" | "needs-refresh" | "shadowed" | "needs-sign-in" | "reserved-name" };

export interface SessionMcpViewOptions {
  workdir: string;
  tenant: McpTenant;
  /** codeoid-side approvals of repo servers ("server\0fingerprint"). */
  approvals: () => ReadonlySet<string>;
  /** Injected for tests. */
  read?: (workdir: string) => Promise<WorkdirServer[]>;
}

export class SessionMcpView implements McpServerView {
  readonly #base: McpRegistry;
  readonly #hub: McpHub | null;
  readonly #opts: SessionMcpViewOptions;
  /** Every server the workdir declared, as last read (for the drawer). */
  #read: WorkdirServer[] = [];
  /** The ones applied to this session's backends. */
  #layer: McpServerSpec[] = [];
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

  /** Read the workdir's servers and apply them. True when what's applied changed. */
  async load(): Promise<boolean> {
    const read = await (this.#opts.read ?? readWorkdirServers)(this.#opts.workdir);
    const layer = this.#resolve(read);
    const fingerprint = fingerprintOf(layer);
    const changed = this.#loaded && fingerprint !== this.#fingerprint;
    this.#read = read;
    this.#layer = layer;
    this.#fingerprint = fingerprint;
    this.#loaded = true;
    return changed;
  }

  /** Whether reading again would change what's applied — without applying it. */
  async stale(): Promise<boolean> {
    if (!this.#loaded) return false;
    const read = await (this.#opts.read ?? readWorkdirServers)(this.#opts.workdir);
    return fingerprintOf(this.#resolve(read)) !== this.#fingerprint;
  }

  /** How far a workdir server (by name and file) reaches, as last read. */
  reachOf(name: string, path: string): WorkdirReach | undefined {
    const entry = this.#read.find((w) => w.name === name && w.path === path);
    if (!entry) return undefined;
    if (isReservedMcpName(name)) return { reach: "claude-only", why: "reserved-name" };
    const applied = this.#layer.find((s) => s.name === name && s.variant === entry.fingerprint);
    if (applied) return this.#heldBack(applied) ? { reach: "claude-only", why: "needs-sign-in" } : { reach: "all" };
    if (!this.#consented(entry)) return { reach: "claude-only", why: "needs-approval" };
    // Consented since it was applied (approved meanwhile): a refresh applies it.
    const wouldApply = this.#resolve(this.#read).some((s) => s.name === name && s.variant === entry.fingerprint);
    return { reach: "claude-only", why: wouldApply ? "needs-refresh" : "shadowed" };
  }

  /**
   * How far a server from Claude's global config reaches: everywhere, as the
   * entry the daemon imported — unless another entry of that name won (codeoid's
   * own, or an earlier file's), the name is codeoid's, or it wants a sign-in.
   */
  reachOfGlobal(name: string, url: string | null, command: string | null): WorkdirReach {
    if (isReservedMcpName(name)) return { reach: "claude-only", why: "reserved-name" };
    const spec = this.#base.get(name);
    const same =
      spec?.origin === "claude-global" &&
      (spec.transport.kind === "http" ? spec.transport.url === url : spec.transport.kind === "stdio" && spec.transport.command === command);
    if (!spec || !same) return { reach: "claude-only", why: "shadowed" };
    return this.#heldBack(spec) ? { reach: "claude-only", why: "needs-sign-in" } : { reach: "all" };
  }

  /** A server's URL by name, from the registry or anything the workdir declared. */
  urlOf(name: string): string | undefined {
    const spec = this.#base.get(name) ?? this.#layer.find((s) => s.name === name);
    if (spec?.transport.kind === "http") return spec.transport.url;
    return this.#read.find((w) => w.name === name)?.raw.url;
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

  /** The registry with the workdir layer applied (not on Claude, which loads its own). */
  #merged(backendId: string | undefined): McpServerSpec[] {
    const byName = new Map(this.#base.list().map((s) => [s.name, s]));
    if (backendId !== "claude") {
      for (const spec of this.#layer) {
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
      const spec: McpServerSpec = { ...normalizeSpec(w.name, w.raw), origin: w.origin, variant: w.fingerprint };
      taken.set(loose(w.name), spec);
      out.push(spec);
    }
    return out;
  }

  #consented(w: WorkdirServer): boolean {
    if (w.origin === "claude-local") return true;
    return w.claudeApproval === "approved" || this.#opts.approvals().has(`${w.name}\u0000${w.fingerprint}`);
  }

  /** A plain HTTP server that has asked for an OAuth sign-in (it 401s until adopted). */
  #heldBack(spec: McpServerSpec): boolean {
    return spec.transport.kind === "http" && !isOAuthServer(spec) && (this.#hub?.needsSignIn(spec.transport.url) ?? false);
  }
}

function fingerprintOf(layer: readonly McpServerSpec[]): string {
  return layer
    .map((s) => `${s.name}\u0000${s.variant ?? ""}`)
    .sort()
    .join("\u0001");
}
