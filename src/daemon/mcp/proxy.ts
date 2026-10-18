/**
 * The loopback MCP relay (docs/mcp-oauth-design.md §5.1, #396): how Codex,
 * the Gemini CLI and Qwen — backends that own their MCP clients and run the
 * agent's shell as their children — use OAuth MCP servers without ever
 * holding the upstream token.
 *
 * A backend mounts `http://127.0.0.1:<port>/mcp/proxy/<server>` with a
 * per-session proxy token. Each backend MCP session gets a relay: an MCP
 * server toward the backend and an MCP client toward the real server, both
 * the official SDK, joined generically so the whole protocol passes —
 * requests and notifications both ways, server→client requests (sampling,
 * elicitation, roots) included. The upstream side authenticates as the
 * session's tenant through the same layer the hub uses (mcp/upstream.ts).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  type JSONRPCRequest,
  McpError,
  type Notification,
  type Result,
  ResultSchema,
  type ServerCapabilities,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpHub } from "./hub.js";
import { upstreamBearer } from "./hub.js";
import { McpSignInRequired, type McpCredentialSource, type McpTenant } from "./oauth.js";
import { cleanMcpError } from "./redact.js";
import type { McpRegistry } from "./registry.js";
import type { McpServerSpec } from "./types.js";
import { closeUpstream, openUpstream } from "./upstream.js";

export const MCP_PROXY_PATH_PREFIX = "/mcp/proxy/";

/** Env var Codex reads the proxy token from (`bearer_token_env_var`). Its name
 *  ends in TOKEN, which Codex's default shell environment policy strips from
 *  the commands it runs. */
export const MCP_PROXY_TOKEN_ENV = "CODEOID_MCP_PROXY_TOKEN";

/** Who a proxy token speaks for. The tenant comes from here, never the request. */
export interface McpProxyBinding {
  tenant: McpTenant;
  sessionId: string;
  /** The backend that mounts it: only its OAuth servers are reachable. */
  backendId: string;
}

/** What a provider needs to mount OAuth servers through the relay. */
export interface McpProxyMount {
  /** The relay URL for a server. */
  url(server: string): string;
  /** A token for the binding's backend's OAuth servers (as of now). */
  mint(binding: McpProxyBinding): { token: string; servers: string[] };
  /** Revoke a token and close its relay sessions. */
  revoke(token: string): void;
}

export interface McpProxyOptions {
  registry: McpRegistry;
  credentials: McpCredentialSource | null;
  /** Where per-tenant status is recorded, so Settings sees one status per server. */
  hub?: McpHub | null;
  /** The daemon's loopback base, e.g. `http://127.0.0.1:7400`. */
  baseUrl: () => string;
  env?: Record<string, string | undefined>;
  /** Bound on each forwarded request (config `session.mcpToolTimeoutMs`). */
  requestTimeoutMs?: number;
  limits?: Partial<McpProxyLimits>;
}

export interface McpProxyLimits {
  /** Relay sessions one token may hold. */
  sessionsPerToken: number;
  /** An upstream session unused this long is closed (and reopened on use). */
  upstreamIdleMs: number;
  /** Largest request body accepted. */
  maxBodyBytes: number;
  /** Bound on a request the upstream server makes of the backend (a human may answer it). */
  serverRequestTimeoutMs: number;
}

const DEFAULT_LIMITS: McpProxyLimits = {
  sessionsPerToken: 8,
  upstreamIdleMs: 10 * 60_000,
  maxBodyBytes: 4 * 1024 * 1024,
  serverRequestTimeoutMs: 10 * 60_000,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** JSON-RPC error code for "this server needs sign-in" (application-defined range). */
export const SIGN_IN_REQUIRED_CODE = -32001;

interface TokenRecord {
  binding: McpProxyBinding;
  servers: ReadonlySet<string>;
  relays: Map<string, Relay>;
  /** Relays started but not yet given a session id. */
  starting: number;
}

export class McpProxy implements McpProxyMount {
  readonly #registry: McpRegistry;
  readonly #credentials: McpCredentialSource | null;
  readonly #hub: McpHub | null;
  readonly #baseUrl: () => string;
  readonly #env: Record<string, string | undefined>;
  readonly #timeoutMs: number;
  readonly #limits: McpProxyLimits;
  /** sha256(token) → record: the token itself is never kept. */
  readonly #tokens = new Map<string, TokenRecord>();

  constructor(opts: McpProxyOptions) {
    this.#registry = opts.registry;
    this.#credentials = opts.credentials;
    this.#hub = opts.hub ?? null;
    this.#baseUrl = opts.baseUrl;
    this.#env = opts.env ?? process.env;
    this.#timeoutMs = opts.requestTimeoutMs && opts.requestTimeoutMs > 0 ? opts.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
    this.#limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  url(server: string): string {
    return `${this.#baseUrl().replace(/\/+$/, "")}${MCP_PROXY_PATH_PREFIX}${encodeURIComponent(server)}`;
  }

  mint(binding: McpProxyBinding): { token: string; servers: string[] } {
    const servers = this.#registry
      .oauthFor(binding.backendId)
      .filter((s) => s.transport.kind === "http")
      .map((s) => s.name);
    const token = randomBytes(32).toString("base64url");
    this.#tokens.set(hashOf(token), { binding, servers: new Set(servers), relays: new Map(), starting: 0 });
    return { token, servers };
  }

  revoke(token: string): void {
    const key = hashOf(token);
    const record = this.#tokens.get(key);
    if (!record) return;
    this.#tokens.delete(key);
    for (const relay of record.relays.values()) void relay.close();
  }

  /** The tenant signed in to or out of a server: its relays reconnect upstream
   *  on next use, and tell their backend the tool list changed. */
  credentialsChanged(server: string, tenant: McpTenant): void {
    for (const record of this.#tokens.values()) {
      if (!sameTenant(record.binding.tenant, tenant)) continue;
      for (const relay of record.relays.values()) if (relay.server === server) void relay.resetUpstream();
    }
  }

  /** A server's registry entry changed or went away: its relays close. */
  serverChanged(server: string): void {
    for (const record of this.#tokens.values()) {
      for (const [id, relay] of record.relays) {
        if (relay.server === server) {
          record.relays.delete(id);
          void relay.close();
        }
      }
    }
  }

  /** Close every relay and forget every token (daemon shutdown). */
  async closeAll(): Promise<void> {
    const relays = [...this.#tokens.values()].flatMap((r) => [...r.relays.values()]);
    this.#tokens.clear();
    await Promise.all(relays.map((r) => r.close()));
  }

  /** Live relay sessions (tests, diagnostics). */
  get relayCount(): number {
    let n = 0;
    for (const r of this.#tokens.values()) n += r.relays.size;
    return n;
  }

  /**
   * One HTTP request to `/mcp/proxy/<server>`. `loopbackPeer` is whether the
   * connection came from this host; the relay serves nothing else.
   * `liftIdleTimeout` turns off the daemon's idle-connection timeout for this
   * request once it is authenticated: a relayed call may stay quiet for as
   * long as the tool takes, or as a person takes to answer the server.
   */
  async handle(req: Request, loopbackPeer: boolean, opts: { liftIdleTimeout?: () => void } = {}): Promise<Response> {
    // Loopback only, and not from a web page: a page can reach 127.0.0.1, but
    // it can't make its Host or Origin a loopback name (DNS rebinding).
    if (!loopbackPeer || !loopbackHost(req.headers.get("host")) || !loopbackOrigin(req.headers.get("origin"))) {
      return rpcError(403, ErrorCode.InvalidRequest, "forbidden");
    }
    let server: string;
    try {
      server = decodeURIComponent(new URL(req.url).pathname.slice(MCP_PROXY_PATH_PREFIX.length));
    } catch {
      return rpcError(404, ErrorCode.InvalidRequest, "no such MCP server here");
    }
    // Never a 401: a 401 with WWW-Authenticate would start the backend's own
    // OAuth flow inside the agent process.
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    const record = token ? this.#tokens.get(hashOf(token)) : undefined;
    if (!record) return rpcError(403, ErrorCode.InvalidRequest, "unknown or revoked proxy token");
    // Bound at mint AND still the backend's OAuth server now: an entry edited
    // or re-scoped since isn't reachable on an old token.
    const spec = record.servers.has(server)
      ? this.#registry.oauthFor(record.binding.backendId).find((s) => s.name === server && s.transport.kind === "http")
      : undefined;
    if (!spec) return rpcError(404, ErrorCode.InvalidRequest, `no MCP server "${server}" here`);
    opts.liftIdleTimeout?.();

    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const relay = record.relays.get(sessionId);
      if (!relay || relay.server !== server) return rpcError(404, ErrorCode.InvalidRequest, "session not found");
      if (req.method !== "POST") return relay.handle(req);
      const body = await readBody(req, this.#limits.maxBodyBytes);
      return body instanceof Response ? body : relay.handle(req, body);
    }

    // No session yet: only an initialize starts one — checked in full before
    // anything is opened upstream as the tenant.
    if (req.method !== "POST") return rpcError(400, ErrorCode.InvalidRequest, "no session: initialize first");
    const accept = req.headers.get("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return rpcError(406, ErrorCode.InvalidRequest, "Accept must allow application/json and text/event-stream");
    }
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
      return rpcError(415, ErrorCode.InvalidRequest, "Content-Type must be application/json");
    }
    const body = await readBody(req, this.#limits.maxBodyBytes);
    if (body instanceof Response) return body;
    const init = body as { method?: unknown; params?: { protocolVersion?: unknown; capabilities?: unknown; clientInfo?: unknown } };
    if (Array.isArray(body) || init.method !== "initialize" || typeof init.params?.protocolVersion !== "string") {
      return rpcError(400, ErrorCode.InvalidRequest, "no session: initialize first");
    }
    // At the cap, the least recently used session makes room (its backend
    // re-initializes if it comes back): a backend that opens a session per
    // thread never locks itself out, and a token still holds a bounded number.
    if (record.relays.size + record.starting >= this.#limits.sessionsPerToken) {
      const lru = [...record.relays.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!lru) return rpcError(429, ErrorCode.InvalidRequest, "too many MCP sessions starting for this token");
      record.relays.delete(lru[0]);
      void lru[1].close();
    }
    record.starting++;
    let relay: Relay;
    try {
      relay = await Relay.start({
        spec,
        binding: record.binding,
        credentials: this.#credentials,
        hub: this.#hub,
        env: this.#env,
        timeoutMs: this.#timeoutMs,
        limits: this.#limits,
        clientCapabilities: (init.params?.capabilities ?? {}) as Record<string, unknown>,
        clientInfo: init.params?.clientInfo as { name?: string; version?: string } | undefined,
        onSession: (id, r) => {
          // Revoked while starting: close it rather than leak it.
          if (this.#tokens.get(hashOf(token!)) === record) record.relays.set(id, r);
          else void r.close();
        },
        onClosed: (id) => record.relays.delete(id),
      });
    } finally {
      record.starting--;
    }
    const res = await relay.handle(req, body);
    // The transport refused the initialize after all: no session, so nothing
    // may stay open upstream.
    if (!relay.sessionId) void relay.close();
    return res;
  }
}

// ── one backend MCP session ──────────────────────────────────────────────────

interface RelayInit {
  spec: McpServerSpec;
  binding: McpProxyBinding;
  credentials: McpCredentialSource | null;
  hub: McpHub | null;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  limits: McpProxyLimits;
  clientCapabilities: Record<string, unknown>;
  clientInfo: { name?: string; version?: string } | undefined;
  onSession: (id: string, relay: Relay) => void;
  onClosed: (id: string) => void;
}

type DownstreamExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The backend request an upstream message belongs to, carried through the
 *  async work it starts, so a server→client request or notification made
 *  during a tool call goes back on that call's stream. */
const relatedRequest = new AsyncLocalStorage<string | number>();

/** What the backend may ask of the server (initialize and ping are answered here). */
const FORWARDED_METHODS = new Set([
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
]);

/** Methods outside tools: a server limited to some of its tools has none of them here. */
const BEYOND_TOOLS = /^(resources|prompts|completion)\//;

/** What the server may ask of the backend. */
const SERVER_REQUESTS = new Set(["sampling/createMessage", "elicitation/create", "roots/list", "ping"]);

class Relay {
  readonly server: string;
  /** When the backend last used this session (for eviction at the cap). */
  lastUsed = Date.now();
  readonly #init: RelayInit;
  readonly #transport: WebStandardStreamableHTTPServerTransport;
  #downstream!: Server;
  /** The upstream session: connecting, or connected. */
  #upstream: Promise<Client> | null = null;
  /** Requests being forwarded now; the idle drop waits for none. */
  #inflight = 0;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  private constructor(init: RelayInit) {
    this.#init = init;
    this.server = init.spec.name;
    this.#transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(16).toString("hex"),
      onsessioninitialized: (id) => init.onSession(id, this),
    });
    this.#transport.onclose = () => {
      if (this.#transport.sessionId) init.onClosed(this.#transport.sessionId);
      void this.close();
    };
  }

  get sessionId(): string | undefined {
    return this.#transport.sessionId;
  }

  /**
   * Open the upstream session first, announcing the backend's own
   * capabilities, so the backend is answered with the real server's
   * capabilities, info and instructions. A tenant not signed in still gets a
   * session (with tools that say to sign in), so the backend neither marks
   * the server failed nor starts an OAuth flow of its own.
   */
  static async start(init: RelayInit): Promise<Relay> {
    const relay = new Relay(init);
    let upstream: Client | null = null;
    try {
      upstream = await relay.#ensureUpstream();
    } catch (e) {
      if (e instanceof McpSignInRequired) relay.#note({ signedOut: true });
      else relay.#note({ error: cleanMcpError(errMsg(e)) });
    }
    const caps: ServerCapabilities = { ...(upstream?.getServerCapabilities() ?? {}) };
    // A server limited to some tools is only those tools here.
    if (init.spec.toolAllowlist) {
      delete caps.resources;
      delete caps.prompts;
      delete caps.completions;
    }
    relay.#downstream = new Server(upstream?.getServerVersion() ?? { name: init.spec.name, version: "0" }, {
      // Tools always announce list changes: a sign-in mid-session changes them.
      capabilities: { ...caps, tools: { ...caps.tools, listChanged: true } },
      ...(upstream?.getInstructions() ? { instructions: upstream.getInstructions() } : {}),
    });
    relay.#wireDownstream();
    await relay.#downstream.connect(relay.#transport);
    relay.#armIdle();
    return relay;
  }

  async handle(req: Request, parsedBody?: unknown): Promise<Response> {
    this.lastUsed = Date.now();
    return this.#transport.handleRequest(req, parsedBody === undefined ? undefined : { parsedBody });
  }

  /** Drop the upstream session; the next request opens a new one. Tells the
   *  backend its tools may have changed (a sign-in, a sign-out). */
  async resetUpstream(): Promise<void> {
    await this.#dropUpstream(this.#upstream);
    await this.#downstream.sendToolListChanged().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idle) clearTimeout(this.#idle);
    await this.#dropUpstream(this.#upstream);
    await this.#transport.close().catch(() => {});
  }

  // ── downstream (the backend) → upstream (the server) ──

  #wireDownstream(): void {
    const down = this.#downstream;
    // The upstream server applies the log level, so setLevel goes there too.
    down.removeRequestHandler("logging/setLevel");
    down.fallbackRequestHandler = (request, extra) => this.#forward(request, extra as DownstreamExtra);
    down.fallbackNotificationHandler = async (notification) => {
      const up = await this.#upstream?.catch(() => null);
      await up?.notification(notification as Notification).catch(() => {});
    };
  }

  async #forward(request: JSONRPCRequest, extra: DownstreamExtra): Promise<Result> {
    const { spec } = this.#init;
    const allow = spec.toolAllowlist;
    const params = request.params as Record<string, unknown> | undefined;
    if (!FORWARDED_METHODS.has(request.method) || (allow && BEYOND_TOOLS.test(request.method))) {
      throw new McpError(ErrorCode.MethodNotFound, `${request.method} is not available for ${spec.name} here`);
    }
    if (request.method === "tools/call" && allow && !allow.includes(String(params?.name))) {
      return { content: [{ type: "text", text: `Tool "${String(params?.name)}" is not in the allowlist for server "${spec.name}".` }], isError: true };
    }
    this.#inflight++;
    if (this.#idle) clearTimeout(this.#idle);
    let up: Client | undefined;
    try {
      up = await this.#ensureUpstream();
      const progressToken = (params?._meta as { progressToken?: string | number } | undefined)?.progressToken;
      const client = up;
      const result = await relatedRequest.run(extra.requestId, () =>
        client.request({ method: request.method, params }, ResultSchema, {
          signal: extra.signal,
          timeout: this.#init.timeoutMs,
          resetTimeoutOnProgress: true,
          ...(progressToken !== undefined
            ? {
                onprogress: (p) =>
                  void extra
                    .sendNotification({ method: "notifications/progress", params: { ...p, progressToken } })
                    .catch(() => {}),
              }
            : {}),
        }),
      );
      if (request.method === "tools/list") return this.#listed(result, params?.cursor !== undefined);
      return result;
    } catch (e) {
      if (e instanceof McpSignInRequired) {
        // Not signed in, or the credential was lost mid-session (a refused
        // refresh): what the backend reads, and Settings shows, is the same.
        this.#note({ signedOut: true });
        if (up) void this.#dropUpstream(this.#upstream, up);
        if (request.method === "tools/call") return { content: [{ type: "text", text: e.message }], isError: true };
        throw new McpError(SIGN_IN_REQUIRED_CODE, e.message);
      }
      if (e instanceof McpError) throw e;
      // The upstream session is gone (server restarted, network): reopen next
      // time — the session this request used, not a newer one.
      if (up) void this.#dropUpstream(this.#upstream, up);
      const message = cleanMcpError(errMsg(e));
      this.#note({ error: message });
      if (request.method === "tools/call") return { content: [{ type: "text", text: `${spec.name} unavailable: ${message}` }], isError: true };
      throw new McpError(ErrorCode.InternalError, `${spec.name}: ${message}`);
    } finally {
      this.#inflight--;
      this.#armIdle();
    }
  }

  /** tools/list, filtered to the allowlist; a complete listing is noted as the tenant's status. */
  #listed(result: Result, paged: boolean): Result {
    const allow = this.#init.spec.toolAllowlist;
    const tools = Array.isArray(result.tools) ? (result.tools as Array<{ name?: unknown }>) : [];
    const shown = allow ? tools.filter((t) => allow.includes(String(t.name))) : tools;
    if (!paged && !result.nextCursor) this.#note({ tools: shown.map((t) => String(t.name)) });
    return { ...result, tools: shown };
  }

  // ── upstream (the server) → downstream (the backend) ──

  #ensureUpstream(): Promise<Client> {
    if (this.#closed) return Promise.reject(new Error("relay closed"));
    if (this.#upstream) return this.#upstream;
    const { spec, binding, credentials, env, clientCapabilities, clientInfo } = this.#init;
    if (spec.transport.kind !== "http") return Promise.reject(new Error(`${spec.name} is not an HTTP server`));
    if (!credentials) return Promise.reject(new McpSignInRequired(spec.name));
    const connecting: Promise<Client> = openUpstream({
      name: spec.name,
      transport: spec.transport,
      env,
      oauth: upstreamBearer(credentials, spec, binding.tenant),
      clientInfo: {
        name: `codeoid relay${clientInfo?.name ? ` (${String(clientInfo.name).slice(0, 64)})` : ""}`,
        version: String(clientInfo?.version ?? "1.0").slice(0, 32),
      },
      // What the backend can do is what the server may ask of it.
      capabilities: clientCapabilities,
      timeoutMs: this.#init.timeoutMs,
    }).then((client) => {
      this.#wireUpstream(client, connecting);
      return client;
    });
    this.#upstream = connecting;
    connecting.catch(() => {
      if (this.#upstream === connecting) this.#upstream = null;
    });
    return connecting;
  }

  #wireUpstream(up: Client, mine: Promise<Client>): void {
    up.fallbackRequestHandler = async (request, extra) => {
      if (!SERVER_REQUESTS.has(request.method)) {
        throw new McpError(ErrorCode.MethodNotFound, `${request.method} is not relayed`);
      }
      // The server's own _meta isn't passed on: a backend may read markers
      // there as its own (Codex marks its tool approvals that way).
      const { _meta, ...params } = (request.params ?? {}) as Record<string, unknown>;
      void _meta;
      const related = relatedRequest.getStore();
      return this.#downstream.request({ method: request.method, params } as ServerRequest, ResultSchema, {
        signal: extra.signal,
        timeout: this.#init.limits.serverRequestTimeoutMs,
        ...(related !== undefined ? { relatedRequestId: related } : {}),
      });
    };
    up.fallbackNotificationHandler = async (notification) => {
      const related = relatedRequest.getStore();
      await this.#downstream
        .notification(notification as ServerNotification, related !== undefined ? { relatedRequestId: related } : undefined)
        .catch(() => {});
    };
    // Only this session closing drops it — never a newer one opened since.
    up.onclose = () => void this.#dropUpstream(mine, up);
  }

  /**
   * Close an upstream session and forget it, if it is still the current one
   * (`which`). `client` is the session itself when known; a session still
   * connecting is closed once it connects.
   */
  async #dropUpstream(which: Promise<Client> | null, client?: Client): Promise<void> {
    if (!which) return;
    if (this.#upstream === which) this.#upstream = null;
    const up = client ?? (await which.catch(() => null));
    if (up) {
      up.onclose = undefined;
      await closeUpstream(up);
    }
  }

  /** Close the upstream session once nothing has used it for a while (it
   *  reopens on the next request); never while a request is in flight. */
  #armIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    if (this.#closed || this.#inflight > 0) return;
    this.#idle = setTimeout(() => {
      if (this.#inflight === 0) void this.#dropUpstream(this.#upstream);
    }, this.#init.limits.upstreamIdleMs);
    this.#idle.unref?.();
  }

  #note(status: { tools?: string[]; error?: string; signedOut?: boolean }): void {
    this.#init.hub?.noteStatus(this.#init.spec, this.#init.binding.tenant, status);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameTenant(a: McpTenant, b: McpTenant): boolean {
  return a.accountId === b.accountId && a.projectId === b.projectId;
}

/** A loopback address as the peer of a connection. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function loopbackHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || isLoopbackAddress(name);
}

/** No Origin (a backend's client sends none), or a loopback one. */
function loopbackOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  try {
    return loopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

async function readBody(req: Request, max: number): Promise<unknown | Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return rpcError(413, ErrorCode.InvalidRequest, "request too large");
  // Read as it arrives, and stop at the cap: a chunked body has no length to check first.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return rpcError(413, ErrorCode.InvalidRequest, "request too large");
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return rpcError(400, ErrorCode.ParseError, "parse error");
  }
}

function rpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── a provider's hold on the relay ───────────────────────────────────────────

/** A server to mount through the relay: its name, and the relay URL for it. */
export interface McpProxiedServer {
  name: string;
  url: string;
}

/**
 * A provider's hold on the relay: at most one live proxy token, re-minted for
 * each backend process it starts (the previous one revoked) and revoked on
 * teardown — so a token outlives neither its process nor its session.
 */
export class McpProxyLease {
  readonly #mount: McpProxyMount | null;
  readonly #binding: McpProxyBinding | null;
  #token: string | null = null;

  constructor(mount: McpProxyMount | null | undefined, binding: McpProxyBinding | null) {
    this.#mount = mount ?? null;
    this.#binding = binding;
  }

  /** A fresh token and the OAuth servers it reaches; null when there are none. */
  renew(): { token: string; servers: McpProxiedServer[] } | null {
    this.revoke();
    const mount = this.#mount;
    if (!mount || !this.#binding) return null;
    const { token, servers } = mount.mint(this.#binding);
    if (servers.length === 0) {
      mount.revoke(token);
      return null;
    }
    this.#token = token;
    return { token, servers: servers.map((name) => ({ name, url: mount.url(name) })) };
  }

  revoke(): void {
    if (this.#token) this.#mount?.revoke(this.#token);
    this.#token = null;
  }
}
