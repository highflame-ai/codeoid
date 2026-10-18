/**
 * The one way the daemon opens a remote MCP server (docs/mcp-oauth-design.md
 * §5.1): the official SDK client over streamable HTTP, with codeoid's
 * headers, bearer and redirect policy.
 *
 * Two callers: the hub (tools only, for the daemon-run backends and Claude's
 * in-process bridge) and the relay (the whole protocol, for Codex, the Gemini
 * CLI and Qwen). Both get the same protocol handling (version negotiation,
 * sessions, SSE, pagination) from the SDK, and the same credential handling
 * from here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ClientCapabilities, Implementation } from "@modelcontextprotocol/sdk/types.js";
import { McpSignInRequired } from "./oauth.js";
import type { McpHttpTransport } from "./types.js";

/** How an upstream request authenticates to an OAuth server. */
export interface UpstreamBearer {
  /** The tenant's access token, refreshed when due; undefined = sign in first. */
  token(): Promise<string | undefined>;
  /** The server refused this token: the next token() refreshes it. */
  rejected(token: string): void;
}

export interface UpstreamOptions {
  /** The server's registry name (for errors). */
  name: string;
  transport: McpHttpTransport;
  /** Env `bearerTokenEnv` is read from. */
  env: Record<string, string | undefined>;
  /** Set for an OAuth server: the tenant's bearer. */
  oauth?: UpstreamBearer;
  /** Who the upstream server sees connecting (default: codeoid). */
  clientInfo?: Implementation;
  /** What the client declares it can do — the relay passes its backend's. */
  capabilities?: ClientCapabilities;
  /** Bound on the initialize handshake. */
  timeoutMs?: number;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
}

export const UPSTREAM_CLIENT_INFO: Implementation = { name: "codeoid", version: "1.0" };

/**
 * Connect to `opts.transport.url` and complete the MCP handshake. Throws
 * {@link McpSignInRequired} when an OAuth server has no usable token for the
 * tenant (none stored, or refused and not refreshable).
 */
export async function openUpstream(opts: UpstreamOptions): Promise<Client> {
  const client = new Client(opts.clientInfo ?? UPSTREAM_CLIENT_INFO, { capabilities: opts.capabilities ?? {} });
  const transport = new StreamableHTTPClientTransport(new URL(opts.transport.url), { fetch: upstreamFetch(opts) });
  try {
    await client.connect(transport, opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return client;
}

/** End the upstream session (an HTTP DELETE, where the server keeps one) and close. */
export async function closeUpstream(client: Client): Promise<void> {
  const transport = client.transport;
  if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
    await transport.terminateSession().catch(() => {});
  }
  await client.close().catch(() => {});
}

/**
 * Every request the SDK transport makes, with codeoid's credentials: the
 * server's configured headers, then the bearer — the tenant's OAuth token, or
 * one read from `bearerTokenEnv`. An OAuth request follows no redirect (the
 * token is bound to this URL and must not be replayed elsewhere) and, when
 * the server rejects the token, is retried once with a refreshed one.
 */
export function upstreamFetch(opts: UpstreamOptions): typeof fetch {
  const base = opts.fetchFn ?? fetch;
  const { name, transport, env, oauth } = opts;
  const send = (url: string | URL | Request, init: RequestInit | undefined, token: string | undefined): Promise<Response> => {
    const headers = new Headers(init?.headers);
    // What the SDK sets (session id, protocol version, accept) wins over config.
    for (const [k, v] of Object.entries(transport.headers ?? {})) if (!headers.has(k)) headers.set(k, v);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    else if (transport.bearerTokenEnv && env[transport.bearerTokenEnv]) {
      headers.set("Authorization", `Bearer ${env[transport.bearerTokenEnv]}`);
    }
    return base(url, { ...init, headers, ...(oauth ? { redirect: "error" as const } : {}) });
  };
  const bearer = async (): Promise<string> => {
    const token = await oauth!.token();
    if (!token) throw new McpSignInRequired(name);
    return token;
  };
  const wrapped = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!oauth) return send(url, init, undefined);
    const token = await bearer();
    const resp = await send(url, init, token);
    if (resp.status !== 401) return resp;
    await resp.body?.cancel().catch(() => {});
    oauth.rejected(token);
    const again = await send(url, init, await bearer());
    if (again.status === 401) {
      await again.body?.cancel().catch(() => {});
      throw new McpSignInRequired(name);
    }
    return again;
  };
  return Object.assign(wrapped, { preconnect: base.preconnect }) as typeof fetch;
}
