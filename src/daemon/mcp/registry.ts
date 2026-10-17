/**
 * McpRegistry — the single source of truth for which MCP servers exist.
 *
 * Parses the config `mcpServers` block into normalized {@link McpServerSpec}s
 * and injects `codeoid_memory` as a built-in entry when memory is enabled, so
 * the memory server is just the reference registry entry rather than a special
 * case (see docs/provider-mcp-registry-design.md §9). Per-backend mounters (S4)
 * and the daemon-owned client (`McpHub`, S2) read specs from here; hot-reload
 * (S5) rebuilds the registry and reconciles live sessions.
 */

import type { RawMcpServerConfig } from "../../config.js";
import { MEMORY_MCP_SERVER_NAME } from "../memory/mcp-http.js";
import { isOAuthServer, mcpToolPrefix, type McpServerSpec, type McpTransport } from "./types.js";

/** Names codeoid owns internally — a user entry using one is ignored (the
 *  built-in wins) rather than silently shadowing an internal server. Compared
 *  in the form tool names use (`mcpToolPrefix`): `codeoid.memory` would give
 *  its tools the built-in's names, some of which are pre-approved. The
 *  blackboard is mounted by name for collaboration children (#245). */
const RESERVED_PREFIXES = new Set<string>([MEMORY_MCP_SERVER_NAME, "codeoid_fleet", "codeoid_blackboard"].map(mcpToolPrefix));

/** Whether `name` is, or reads in tool names as, one of codeoid's built-in servers. */
export function isReservedMcpName(name: string): boolean {
  return RESERVED_PREFIXES.has(mcpToolPrefix(name));
}

export interface McpRegistryOptions {
  /** When true, inject the built-in `codeoid_memory` entry (in-process). */
  memoryEnabled: boolean;
}

export class McpRegistry {
  readonly #specs = new Map<string, McpServerSpec>();
  readonly #warnings: string[] = [];

  constructor(servers: Record<string, RawMcpServerConfig> | undefined, opts: McpRegistryOptions) {
    // Built-in memory entry first, so a user `mcpServers.codeoid_memory` can't
    // shadow it (it's added to RESERVED_NAMES and skipped below).
    if (opts.memoryEnabled) {
      this.#specs.set(MEMORY_MCP_SERVER_NAME, {
        name: MEMORY_MCP_SERVER_NAME,
        transport: { kind: "in-process" },
        trust: "readonly",
        scope: "session",
        enabled: true,
        native: false,
        builtin: true,
      });
    }
    for (const [name, raw] of Object.entries(servers ?? {})) {
      if (isReservedMcpName(name)) {
        this.#warnings.push(`mcp: ignoring reserved server name "${name}" (codeoid built-in)`);
        continue;
      }
      this.#specs.set(name, normalizeSpec(name, raw));
    }
  }

  /** Non-fatal issues surfaced at construction (reserved-name collisions, …). */
  get warnings(): readonly string[] {
    return this.#warnings;
  }

  list(): McpServerSpec[] {
    return [...this.#specs.values()];
  }

  get(name: string): McpServerSpec | undefined {
    return this.#specs.get(name);
  }

  /** Enabled servers that should mount on `backendId` (honoring `backends`). */
  forBackend(backendId: string): McpServerSpec[] {
    return this.list().filter(
      (s) => s.enabled && (s.backends === undefined || s.backends.includes(backendId)),
    );
  }

  /**
   * Add or replace a user server while the daemon runs — a server adopted from
   * Claude's config (#390). Everything that holds this registry (sessions,
   * providers, the hub) reads the new entry from here; a reserved name is
   * refused, as at start.
   */
  upsert(name: string, raw: RawMcpServerConfig): McpServerSpec {
    if (isReservedMcpName(name)) throw new Error(`"${name}" is a codeoid built-in server name`);
    const spec = normalizeSpec(name, raw);
    this.#specs.set(name, spec);
    return spec;
  }

  /** Enabled OAuth servers for `backendId`: what codeoid signs in to and calls
   *  itself, for a backend that reaches them through codeoid. */
  oauthFor(backendId: string): McpServerSpec[] {
    return this.forBackend(backendId).filter((s) => !s.builtin && isOAuthServer(s));
  }

  /** External servers a native-mount backend mounts itself. OAuth servers are
   *  left out: a header baked in at start cannot follow a token that expires
   *  and refreshes, and would put the user's token in the agent's process. */
  forNativeMount(backendId: string): McpServerSpec[] {
    return this.forBackend(backendId).filter((s) => !s.builtin && !isOAuthServer(s));
  }
}

/** Raw (zod-validated) config → normalized spec. Transport is inferred from
 *  which of `command` / `url` is set (the schema's refine guarantees exactly
 *  one); `url` wins defensively if both somehow slip through. */
function normalizeSpec(name: string, raw: RawMcpServerConfig): McpServerSpec {
  const transport: McpTransport =
    raw.url !== undefined
      ? {
          kind: "http",
          url: raw.url,
          headers: raw.headers,
          bearerTokenEnv: raw.bearerTokenEnv,
          ...(raw.oauth !== undefined ? { oauth: raw.oauth === true ? {} : raw.oauth } : {}),
        }
      : { kind: "stdio", command: raw.command ?? "", args: raw.args, env: raw.env };
  return {
    name,
    transport,
    trust: raw.trust,
    scope: raw.scope,
    toolAllowlist: raw.tools,
    backends: raw.backends,
    enabled: raw.enabled,
    native: raw.native,
    builtin: false,
  };
}
