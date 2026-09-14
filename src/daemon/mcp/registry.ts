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
import { MEMORY_MCP_SERVER_NAME } from "@highflame/codeoid-memory/mcp-http.js";
import type { McpServerSpec, McpTransport } from "./types.js";

/** Names codeoid owns internally — a user entry using one is ignored (the
 *  built-in wins) rather than silently shadowing an internal server. */
const RESERVED_NAMES = new Set<string>([MEMORY_MCP_SERVER_NAME, "codeoid_fleet"]);

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
      if (RESERVED_NAMES.has(name)) {
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
}

/** Raw (zod-validated) config → normalized spec. Transport is inferred from
 *  which of `command` / `url` is set (the schema's refine guarantees exactly
 *  one); `url` wins defensively if both somehow slip through. */
function normalizeSpec(name: string, raw: RawMcpServerConfig): McpServerSpec {
  const transport: McpTransport =
    raw.url !== undefined
      ? { kind: "http", url: raw.url, headers: raw.headers, bearerTokenEnv: raw.bearerTokenEnv }
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
