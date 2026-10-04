/**
 * SessionMcpTools — the per-(session, backend) view of the registry.
 *
 * Which PROXIED external servers' tools a backend should see, and how to run one
 * through the daemon-owned {@link McpHub} with the session's tenant scope. This
 * is the single place every delivery path (the in-daemon tool-loop for
 * openai/gemini/pi, the in-process SDK server for claude, and the HTTP frontend
 * for codex/gemini-cli) draws from, so the canonical `mcp__<server>__<tool>`
 * name and the trust flag stay identical across backends.
 *
 * `codeoid_memory` is delivered by its own dedicated paths (it's in-process and
 * always-on); this covers the OTHER registry servers uniformly. Built-in and
 * `native:true` (escape-hatch) servers are excluded.
 */

import type { McpCallResult, McpCallScope, McpHub, McpToolDef } from "./hub.js";
import type { McpRegistry } from "./registry.js";
import { canonicalToolName, type McpServerSpec, type McpTrust } from "./types.js";

/** One tool a backend should expose, already keyed by its canonical name. */
export interface McpToolHandle {
  server: string;
  tool: string;
  /** `mcp__<server>__<tool>` — the one name isSafeTool/canUseTool key off. */
  canonicalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  trust: McpTrust;
}

export class SessionMcpTools {
  readonly #registry: McpRegistry;
  readonly #hub: McpHub;
  readonly #backendId: string;
  readonly #scope: McpCallScope;

  constructor(registry: McpRegistry, hub: McpHub, backendId: string, scope: McpCallScope) {
    this.#registry = registry;
    this.#hub = hub;
    this.#backendId = backendId;
    this.#scope = scope;
  }

  /** Proxied (non-native), non-builtin servers this backend should mount. */
  #specs(): McpServerSpec[] {
    return this.#registry.forBackend(this.#backendId).filter((s) => !s.native && !s.builtin);
  }

  /** True when there is at least one proxied external server for this backend
   *  (lets a provider skip the async discovery + declaration work entirely). */
  hasServers(): boolean {
    return this.#specs().length > 0;
  }

  /** Discover the tool handles to expose to the model. Best-effort per server —
   *  a server that fails to list contributes nothing (McpHub already logs/hides). */
  async handles(): Promise<McpToolHandle[]> {
    const out: McpToolHandle[] = [];
    for (const spec of this.#specs()) {
      const tools: McpToolDef[] = await this.#hub.listTools(spec, this.#scope);
      for (const t of tools) {
        out.push({
          server: spec.name,
          tool: t.name,
          canonicalName: canonicalToolName(spec.name, t.name),
          description: t.description,
          inputSchema: t.inputSchema,
          trust: spec.trust,
        });
      }
    }
    return out;
  }

  /** True if `canonicalName` addresses one of this backend's proxied servers. */
  owns(canonicalName: string): boolean {
    return this.#specs().some((s) => canonicalName.startsWith(`mcp__${s.name}__`));
  }

  /** Route a canonical `mcp__<server>__<tool>` call to the hub with the session
   *  scope. Matches the LONGEST server-name prefix, so overlapping names (e.g.
   *  `git` vs `git__extra`, or any name that is a prefix of another) route to
   *  the most specific server rather than the first one that happens to match. */
  async call(canonicalName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    let best: { spec: McpServerSpec; tool: string } | null = null;
    for (const spec of this.#specs()) {
      const prefix = `mcp__${spec.name}__`;
      if (canonicalName.startsWith(prefix) && (best === null || spec.name.length > best.spec.name.length)) {
        best = { spec, tool: canonicalName.slice(prefix.length) };
      }
    }
    if (best) return this.#hub.callTool(best.spec, best.tool, args, this.#scope);
    return { text: `Unknown MCP tool: ${canonicalName}`, isError: true };
  }
}
