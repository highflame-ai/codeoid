/**
 * MemoryMcpHttp — the shared in-daemon MCP endpoint that exposes codeoid's
 * verbatim-memory recall tools over HTTP (MCP Streamable HTTP transport) to
 * backends that mount MCP servers by URL rather than in-process (gemini-cli via
 * ACP `session/new.mcpServers`; codex via `CODEX_HOME` in a later phase).
 *
 * Why one shared HTTP endpoint and not a subprocess-per-session: the daemon
 * already runs `Bun.serve` and owns the single live MemoryEngine (one SQLite
 * handle, one embedder). A subprocess-per-session MCP server would mean N DB
 * handles + N embedders + SQLite reader/writer contention. Instead every ACP
 * session mounts THIS endpoint; a per-session bearer token is the tenant scope.
 *
 * Tenant scoping: `mint({workspaceId, sessionId})` returns an opaque token the
 * provider passes as `Authorization: Bearer …` in the mount's headers. Every
 * request authorizes on that token → the (workspace, session) it was minted
 * for, and the tools run under exactly that MemoryToolContext — the same
 * boundary the in-process Claude MCP server (memory/mcp.ts) enforces. No token,
 * or an unknown/revoked one, fails closed (401). Providers revoke on teardown.
 *
 * The MCP wire layer is hand-rolled (like codeoid's ACP/codex/pi RPC): MCP is
 * JSON-RPC 2.0, and these four tools are read-only request/response, so a
 * single-JSON-response Streamable HTTP server (no SSE stream) is spec-compliant
 * and enough. The client POSTs; requests get an `application/json` JSON-RPC
 * response, notifications get `202 Accepted`.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  ok,
  rpcErr,
  tokenFrom,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "../mcp/jsonrpc-http.js";
import type { MemoryEngine } from "./engine.js";
import { memoryToolDefs, type MemoryToolContext, type MemoryToolDef } from "./tools.js";

/** Path the endpoint is mounted at on the daemon's HTTP server. */
export const MEMORY_MCP_PATH = "/mcp/memory";

/** The MCP server name backends mount this under. Tool calls arrive namespaced
 *  by it (e.g. gemini reports `codeoid_memory__recall`); isSafeTool keys off it. */
export const MEMORY_MCP_SERVER_NAME = "codeoid_memory";

/** Env var a URL-mounting backend reads the per-session bearer token from when
 *  the config references a token by env-var name rather than inline (codex's
 *  `bearer_token_env_var`) — keeps the token out of argv. */
export const MEMORY_MCP_TOKEN_ENV = "CODEOID_MEMORY_TOKEN";

/** Tenant scope a token is bound to — identical to the in-process binding. */
export interface MemoryMcpBinding {
  workspaceId: string;
  sessionId: string;
}

/**
 * What a session hands a URL-mounting backend (gemini-cli/codex) so it can mount
 * the shared endpoint: the singleton endpoint (to mint/revoke a scoped token)
 * and the absolute, loopback-reachable URL the local agent subprocess POSTs to.
 * Present only when memory is enabled.
 */
export interface MemoryMcpMount {
  endpoint: MemoryMcpHttp;
  url: string;
}

const SERVER_INFO = { name: "codeoid-memory", version: "0.1.0" } as const;




/** Bearer token from the Authorization header, or a `?token=` query fallback. */

export class MemoryMcpHttp {
  readonly #engine: MemoryEngine;
  readonly #tokens = new Map<string, MemoryMcpBinding>();
  readonly #defs: MemoryToolDef[];

  constructor(engine: MemoryEngine) {
    this.#engine = engine;
    this.#defs = memoryToolDefs();
  }

  /**
   * Mint a bearer token scoped to (workspace, session). The token IS the tenant
   * boundary for every call on this mount; the provider revokes it on teardown.
   */
  mint(binding: MemoryMcpBinding): string {
    const token = `mmt_${randomUUID().replace(/-/g, "")}`;
    this.#tokens.set(token, { ...binding });
    return token;
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }

  /** Live token count — for teardown assertions + telemetry. */
  get activeTokens(): number {
    return this.#tokens.size;
  }

  /** Bun.serve fetch handler for {@link MEMORY_MCP_PATH}. */
  async handle(req: Request): Promise<Response> {
    if (req.method === "GET") {
      // No server-initiated SSE stream — some clients probe GET first.
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const token = tokenFrom(req);
    const binding = token ? this.#tokens.get(token) : undefined;
    if (!binding) {
      // Fail closed — never run a tool without a resolved tenant scope.
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400 });
    }

    const ctx: MemoryToolContext = {
      engine: this.#engine,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
    };

    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcMessage[];
    const responses: JsonRpcResponse[] = [];
    let sawInitialize = false;
    for (const m of messages) {
      if (m && m.method === "initialize") sawInitialize = true;
      const res = await this.#dispatch(m, ctx);
      if (res) responses.push(res);
    }

    // All-notifications POST (e.g. `notifications/initialized`) → 202, no body.
    if (responses.length === 0) return new Response(null, { status: 202 });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Streamable HTTP advertises the session on initialize. We authorize by the
    // bearer token, so this is informational; pin it to the token so a client
    // that echoes Mcp-Session-Id stays bound to the same scope.
    if (sawInitialize && token) headers["Mcp-Session-Id"] = token;
    return new Response(JSON.stringify(batch ? responses : responses[0]), { status: 200, headers });
  }

  async #dispatch(msg: JsonRpcMessage | null, ctx: MemoryToolContext): Promise<JsonRpcResponse | null> {
    const id = msg?.id ?? null;
    const method = msg?.method;
    // JSON-RPC notifications carry no id — acknowledge with no response.
    if (msg?.id === undefined) return null;

    switch (method) {
      case "initialize": {
        const requested = msg?.params?.protocolVersion;
        return ok(id, {
          protocolVersion: typeof requested === "string" ? requested : DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: this.#defs.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.jsonSchema,
          })),
        });
      case "tools/call": {
        const name = msg?.params?.name;
        const args = (msg?.params?.arguments ?? {}) as Record<string, unknown>;
        const def = this.#defs.find((d) => d.name === name);
        if (!def) {
          return ok(id, {
            content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
            isError: true,
          });
        }
        try {
          const text = await def.run(args, ctx);
          return ok(id, { content: [{ type: "text", text }], isError: false });
        } catch (e) {
          return ok(id, {
            content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          });
        }
      }
      default:
        return rpcErr(id, -32601, `Method not found: ${String(method)}`);
    }
  }
}
