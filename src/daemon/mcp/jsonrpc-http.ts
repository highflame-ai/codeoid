/**
 * Shared JSON-RPC + bearer-auth plumbing for the daemon's in-process MCP
 * endpoints (memory, goal blackboard).
 *
 * Extracted rather than copied: `tokenFrom` is the authorization boundary for
 * every one of these mounts, and two hand-maintained copies of bearer parsing
 * is precisely the kind of duplication that drifts — one gets a fix, the other
 * quietly keeps the hole.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcErr(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Bearer token from the Authorization header, falling back to a `token` query
 * param for clients that can't set headers on an MCP mount.
 */
export function tokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.length > 7 && auth.slice(0, 7).toLowerCase() === "bearer ") {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  // Fallback base so a relative req.url (some test/client setups) can't throw;
  // Bun.serve hands us absolute URLs, the base is only used to parse the query.
  const q = new URL(req.url, "http://localhost").searchParams.get("token");
  return q && q.length > 0 ? q : null;
}

/** Echoed only when the client doesn't propose its own protocolVersion. */
export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-06-18";
