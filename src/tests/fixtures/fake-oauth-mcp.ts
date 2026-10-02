/**
 * A local OAuth-protected MCP server + authorization server, per the MCP
 * authorization spec (2025-06-18), for exercising codeoid's OAuth end to end
 * without the network:
 *
 *   - POST /mcp — streamable-HTTP MCP; 401 + `WWW-Authenticate: Bearer
 *     resource_metadata=…` without a valid access token
 *   - /.well-known/oauth-protected-resource[/mcp] — RFC 9728
 *   - /.well-known/oauth-authorization-server — RFC 8414
 *   - POST /register — RFC 7591 (can be switched off)
 *   - GET /authorize — auto-approves; checks client, redirect URI, PKCE S256
 *   - POST /token — authorization_code (verifies the verifier) and
 *     refresh_token (rotates)
 */

import { createHash, randomBytes } from "node:crypto";

export interface FakeOAuthMcpOptions {
  /** Access-token lifetime in seconds (default 3600). */
  expiresIn?: number;
  /** Disable dynamic registration: only `preRegistered` clients work. */
  dynamicRegistration?: boolean;
  preRegistered?: { clientId: string; clientSecret?: string; redirectUris?: string[] };
}

interface Client {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

export class FakeOAuthMcp {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly base: string;
  readonly mcpUrl: string;
  /** Counters tests assert on. */
  readonly stats = { registrations: 0, codeExchanges: 0, refreshes: 0, mcpCalls: 0, unauthorized: 0 };
  /** The last /authorize query, for asserting PKCE / resource / scope. */
  lastAuthorize: URLSearchParams | undefined;
  /** Headers of the last authorized MCP request. */
  lastMcpHeaders: Headers | undefined;

  readonly #opts: FakeOAuthMcpOptions;
  readonly #clients = new Map<string, Client>();
  readonly #codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource?: string }>();
  readonly #access = new Map<string, { clientId: string; subject: string }>();
  readonly #refresh = new Map<string, { clientId: string; subject: string }>();
  #subjectSeq = 0;

  constructor(opts: FakeOAuthMcpOptions = {}) {
    this.#opts = opts;
    if (opts.preRegistered) {
      this.#clients.set(opts.preRegistered.clientId, {
        clientId: opts.preRegistered.clientId,
        clientSecret: opts.preRegistered.clientSecret,
        redirectUris: opts.preRegistered.redirectUris ?? [],
      });
    }
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.#handle(req) });
    this.base = `http://127.0.0.1:${this.server.port}`;
    this.mcpUrl = `${this.base}/mcp`;
  }

  stop(): void {
    this.server.stop(true);
  }

  /** Invalidate every issued access token — the next MCP call gets 401. */
  revokeAccessTokens(): void {
    this.#access.clear();
  }

  /** Invalidate refresh tokens too — a refresh then fails. */
  revokeRefreshTokens(): void {
    this.#refresh.clear();
  }

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: this.mcpUrl, authorization_servers: [this.base], scopes_supported: ["mcp:read"] });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: this.base,
        authorization_endpoint: `${this.base}/authorize`,
        token_endpoint: `${this.base}/token`,
        ...(this.#opts.dynamicRegistration === false ? {} : { registration_endpoint: `${this.base}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
    }
    if (path === "/register" && req.method === "POST") {
      if (this.#opts.dynamicRegistration === false) return new Response("not found", { status: 404 });
      const body = (await req.json()) as { redirect_uris?: string[] };
      const clientId = `client-${randomBytes(6).toString("hex")}`;
      this.#clients.set(clientId, { clientId, redirectUris: body.redirect_uris ?? [] });
      this.stats.registrations++;
      return json({ ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
    }
    if (path === "/authorize") return this.#authorize(url);
    if (path === "/token" && req.method === "POST") return this.#token(req);
    if (path === "/mcp") return this.#mcp(req);
    return new Response("not found", { status: 404 });
  }

  #authorize(url: URL): Response {
    const q = url.searchParams;
    this.lastAuthorize = q;
    const client = this.#clients.get(q.get("client_id") ?? "");
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client) return new Response("unknown client", { status: 400 });
    if (client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) {
      return new Response("redirect_uri not registered", { status: 400 });
    }
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
      return new Response("PKCE S256 required", { status: 400 });
    }
    const code = randomBytes(16).toString("hex");
    this.#codes.set(code, {
      clientId: client.clientId,
      challenge: q.get("code_challenge")!,
      redirectUri,
      ...(q.get("resource") ? { resource: q.get("resource")! } : {}),
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    if (q.get("state")) back.searchParams.set("state", q.get("state")!);
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }

  async #token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = this.#codes.get(form.get("code") ?? "");
      this.#codes.delete(form.get("code") ?? "");
      if (!code) return json({ error: "invalid_grant" }, 400);
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== code.challenge) return json({ error: "invalid_grant", error_description: "PKCE mismatch" }, 400);
      if (form.get("redirect_uri") !== code.redirectUri) return json({ error: "invalid_grant" }, 400);
      this.stats.codeExchanges++;
      return json(this.#issue(code.clientId, `user-${++this.#subjectSeq}`));
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      const held = this.#refresh.get(rt);
      if (!held) return json({ error: "invalid_grant" }, 400);
      this.#refresh.delete(rt); // rotation
      this.stats.refreshes++;
      return json(this.#issue(held.clientId, held.subject));
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  #issue(clientId: string, subject: string): Record<string, unknown> {
    const access = randomBytes(16).toString("hex");
    const refresh = randomBytes(16).toString("hex");
    this.#access.set(access, { clientId, subject });
    this.#refresh.set(refresh, { clientId, subject });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: this.#opts.expiresIn ?? 3600,
      scope: "mcp:read",
    };
  }

  async #mcp(req: Request): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const who = this.#access.get(token);
    if (!who) {
      this.stats.unauthorized++;
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    this.lastMcpHeaders = req.headers;
    this.stats.mcpCalls++;
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const msg = (await req.json()) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const sessionHeaders = { "Mcp-Session-Id": "fake-session-1" };
    switch (msg.method) {
      case "initialize":
        return json(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-oauth-mcp", version: "1" } },
          },
          200,
          sessionHeaders,
        );
      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [{ name: "whoami", description: "Who the token belongs to", inputSchema: { type: "object", properties: {} } }],
          },
        });
      case "tools/call":
        return json({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `you are ${who.subject}` }] },
        });
      default:
        return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
