/**
 * McpHub — the daemon-owned MCP client pool (docs/provider-mcp-registry-design.md §5.2).
 *
 * codeoid owns ONE client per server, shared across sessions; the per-session
 * scope ({workspace, session}) is injected at call time, not baked into the
 * connection, so one warm client serves every session. This is what lets the
 * in-daemon backends (openai/gemini/pi) use arbitrary MCP servers at all — they
 * have no MCP client of their own — and gives every backend one uniform place
 * to list + call tools, gate them, time them out, and observe them.
 *
 * Three transports:
 *   - in-process — codeoid_memory: tools run against the live engine, no socket;
 *   - stdio      — a local subprocess speaking JSON-RPC (reuses the shared
 *                  StdioJsonRpcProcess transport);
 *   - http       — streamable-HTTP: JSON-RPC over POST (single-JSON or a one-shot
 *                  SSE frame), bearer read from an env-var name, never argv.
 *
 * Clients connect lazily on first use and are cached; a dead client is dropped
 * and recreated on the next call (simple reconnect — richer health/backoff is S6).
 */

import { StdioJsonRpcProcess } from "../providers/jsonrpc-stdio.js";
import { memoryToolDefs, type MemoryToolContext } from "../memory/tools.js";
import type { MemoryEngine } from "../memory/engine.js";
import { isOAuthServer, resolveEnvMap } from "./types.js";
import type { McpHttpTransport, McpServerSpec, McpStdioTransport } from "./types.js";
import { McpSignInRequired, type McpCredentialSource, type McpTenant } from "./oauth.js";

/** A tool as codeoid surfaces it to a backend (bare name; the canonical
 *  `mcp__<server>__<tool>` form is applied by the mounters, not here). */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Tenant scope for a call — the {workspace, session} binding codeoid_memory
 *  needs and the per-session identity a codeoid-owned HTTP endpoint authorizes. */
export interface McpCallScope {
  workspaceId: string;
  sessionId: string;
  /** The session's tenant — whose credential an OAuth server is called with. */
  tenant?: McpTenant;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(tool: string, args: Record<string, unknown>, scope: McpCallScope): Promise<McpCallResult>;
  close(): void;
}

export interface McpHubOptions {
  /** Live memory engine — required to serve the in-process `codeoid_memory`. */
  engine?: MemoryEngine | null;
  /** Per-call wall-clock timeout (config `session.mcpToolTimeoutMs`). */
  toolTimeoutMs?: number;
  /** Env the daemon resolves `${VAR}` refs + `bearerTokenEnv` against. */
  daemonEnv?: Record<string, string | undefined>;
  /** Where OAuth servers' tokens come from (docs/mcp-oauth-design.md). */
  credentials?: McpCredentialSource;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Last-observed status of a server, accumulated from normal use (list/call).
 *  Read by the settings surface — no live probe on read. */
interface McpLiveStatus {
  tools: string[];
  error?: string;
}

export class McpHub {
  readonly #clients = new Map<string, McpClient>();
  readonly #status = new Map<string, McpLiveStatus>();
  readonly #engine: MemoryEngine | null;
  readonly #timeoutMs: number;
  readonly #env: Record<string, string | undefined>;
  readonly #credentials: McpCredentialSource | null;

  constructor(opts: McpHubOptions = {}) {
    this.#engine = opts.engine ?? null;
    this.#timeoutMs = opts.toolTimeoutMs && opts.toolTimeoutMs > 0 ? opts.toolTimeoutMs : DEFAULT_TIMEOUT_MS;
    this.#env = opts.daemonEnv ?? process.env;
    this.#credentials = opts.credentials ?? null;
  }

  /** Tools `spec` exposes, filtered by its allowlist. Never throws — a server
   *  that fails to list returns [] (its tools are hidden, not presented-and-broken).
   *  An OAuth server lists with the tenant's credential, so `scope` must carry it. */
  async listTools(spec: McpServerSpec, scope?: McpCallScope): Promise<McpToolDef[]> {
    try {
      const client = this.#clientFor(spec, scope?.tenant);
      const all = await client.listTools();
      const tools = spec.toolAllowlist ? all.filter((t) => spec.toolAllowlist?.includes(t.name)) : all;
      this.#status.set(clientKey(spec, scope?.tenant), { tools: tools.map((t) => t.name) });
      return tools;
    } catch (e) {
      // Not having signed in is not a fault of the server.
      if (!(e instanceof McpSignInRequired)) this.#status.set(clientKey(spec, scope?.tenant), { tools: [], error: errMsg(e) });
      this.#drop(clientKey(spec, scope?.tenant));
      return [];
    }
  }

  /** Call one tool. Enforces the allowlist and a per-call timeout; a failure
   *  (throw, timeout, isError) comes back as `{isError:true}` so the caller can
   *  feed it to the model instead of wedging the turn. */
  async callTool(
    spec: McpServerSpec,
    tool: string,
    args: Record<string, unknown>,
    scope: McpCallScope,
  ): Promise<McpCallResult> {
    if (spec.toolAllowlist && !spec.toolAllowlist.includes(tool)) {
      return { text: `Tool "${tool}" is not in the allowlist for server "${spec.name}".`, isError: true };
    }
    let client: McpClient;
    try {
      client = this.#clientFor(spec, scope.tenant);
    } catch (e) {
      return { text: `mcp: ${spec.name} unavailable: ${errMsg(e)}`, isError: true };
    }
    try {
      return await withTimeout(client.callTool(tool, args, scope), this.#timeoutMs, `${spec.name}/${tool}`);
    } catch (e) {
      this.#drop(clientKey(spec, scope.tenant)); // reconnect on next use
      if (e instanceof McpSignInRequired) return { text: e.message, isError: true };
      // codeoid has no OTEL; a failed external tool call is worth one daemon log
      // line (transport error / timeout) so a flaky server is diagnosable.
      console.error(`[codeoid] mcp: ${spec.name}/${tool} failed: ${errMsg(e)}`);
      const key = clientKey(spec, scope.tenant);
      this.#status.set(key, { tools: this.#status.get(key)?.tools ?? [], error: errMsg(e) });
      return { text: `Error calling ${spec.name}/${tool}: ${errMsg(e)}`, isError: true };
    }
  }

  /** Last-observed status for a server (from accumulated use), or undefined if
   *  the daemon hasn't listed/called it yet. Read by the settings surface.
   *  An OAuth server is called as a tenant, so its status is that tenant's —
   *  pass `tenant` for one; another tenant's errors and tools are not shown. */
  statusFor(name: string, tenant?: McpTenant): { tools: string[]; error?: string } | undefined {
    return this.#status.get(tenantKey(name, tenant));
  }

  /** Whether a live client is currently held for this server (for `tenant`,
   *  for an OAuth server). */
  hasClient(name: string, tenant?: McpTenant): boolean {
    return this.#clients.has(tenantKey(name, tenant));
  }

  /** Tear down every client (daemon stop / registry reload). */
  closeAll(): void {
    for (const [, c] of this.#clients) c.close();
    this.#clients.clear();
  }

  /** Drop one server's clients — every tenant's (registry edit / removal). */
  drop(name: string): void {
    for (const key of [...this.#clients.keys()]) {
      if (key === name || key.startsWith(`${name}\u0000`)) this.#drop(key);
    }
  }

  /** Drop one tenant's client for a server (it signed out or back in). */
  dropTenant(name: string, tenant: McpTenant): void {
    this.#drop(tenantKey(name, tenant));
  }

  #drop(key: string): void {
    const c = this.#clients.get(key);
    if (c) {
      c.close();
      this.#clients.delete(key);
    }
  }

  /** One client per server — per (server, tenant) for an OAuth server, whose
   *  upstream session is authenticated as that tenant. */
  #clientFor(spec: McpServerSpec, tenant: McpTenant | undefined): McpClient {
    const key = clientKey(spec, tenant);
    const existing = this.#clients.get(key);
    if (existing) return existing;
    const client = this.#build(spec, tenant);
    this.#clients.set(key, client);
    return client;
  }

  #build(spec: McpServerSpec, tenant: McpTenant | undefined): McpClient {
    switch (spec.transport.kind) {
      case "in-process": {
        if (!this.#engine) throw new Error(`in-process server "${spec.name}" needs a memory engine`);
        return new InProcessMemoryClient(this.#engine);
      }
      case "stdio":
        return new StdioMcpClient(spec.name, spec.transport, this.#env);
      case "http": {
        if (!isOAuthServer(spec)) return new HttpMcpClient(spec.name, spec.transport, this.#env);
        const credentials = this.#credentials;
        if (!credentials || !tenant) throw new McpSignInRequired(spec.name);
        return new HttpMcpClient(spec.name, spec.transport, this.#env, {
          token: () => credentials.accessToken(spec, tenant),
          rejected: (token) => credentials.rejected(spec, tenant, token),
        });
      }
    }
  }
}

// ── in-process (codeoid_memory) ────────────────────────────────────────────

/** Runs codeoid's own memory tools directly against the engine — the reference
 *  registry entry. Scope is applied per call via the MemoryToolContext. */
class InProcessMemoryClient implements McpClient {
  readonly #engine: MemoryEngine;
  readonly #defs = memoryToolDefs();
  constructor(engine: MemoryEngine) {
    this.#engine = engine;
  }
  async listTools(): Promise<McpToolDef[]> {
    return this.#defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.jsonSchema }));
  }
  async callTool(tool: string, args: Record<string, unknown>, scope: McpCallScope): Promise<McpCallResult> {
    const def = this.#defs.find((d) => d.name === tool);
    if (!def) return { text: `Unknown tool: ${tool}`, isError: true };
    const ctx: MemoryToolContext = { engine: this.#engine, workspaceId: scope.workspaceId, sessionId: scope.sessionId };
    try {
      return { text: await def.run(args, ctx), isError: false };
    } catch (e) {
      return { text: `Error: ${errMsg(e)}`, isError: true };
    }
  }
  close(): void {
    /* the engine is owned by the daemon, not this client */
  }
}

// ── stdio ───────────────────────────────────────────────────────────────────

class StdioMcpClient implements McpClient {
  readonly #name: string;
  readonly #transport: McpStdioTransport;
  readonly #env: Record<string, string | undefined>;
  #proc: StdioJsonRpcProcess | null = null;
  #initialized: Promise<void> | null = null;

  constructor(name: string, transport: McpStdioTransport, env: Record<string, string | undefined>) {
    this.#name = name;
    this.#transport = transport;
    this.#env = env;
  }

  #ensure(): StdioJsonRpcProcess {
    if (this.#proc?.alive) return this.#proc;
    this.#initialized = null;
    const base: Record<string, string> = {};
    if (this.#env.PATH) base.PATH = this.#env.PATH;
    if (this.#env.HOME) base.HOME = this.#env.HOME;
    const env = { ...base, ...resolveEnvMap(this.#transport.env, this.#env) };
    this.#proc = new StdioJsonRpcProcess({
      command: this.#transport.command,
      args: this.#transport.args,
      name: this.#name,
      cwd: this.#env.HOME ?? process.cwd(),
      env,
      onNotification: () => {}, // MCP servers may notify (progress/log) — ignored for now
      onServerRequest: async () => {
        throw new Error("codeoid does not handle server→client requests from MCP servers");
      },
      onExit: () => {
        this.#proc = null;
        this.#initialized = null;
      },
    });
    return this.#proc;
  }

  async #handshake(proc: StdioJsonRpcProcess): Promise<void> {
    if (!this.#initialized) {
      this.#initialized = (async () => {
        await proc.request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        });
        proc.notify("notifications/initialized");
      })();
    }
    return this.#initialized;
  }

  async listTools(): Promise<McpToolDef[]> {
    const proc = this.#ensure();
    await this.#handshake(proc);
    const res = (await proc.request("tools/list", {})) as { tools?: RawTool[] };
    return (res.tools ?? []).map(toToolDef);
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const proc = this.#ensure();
    await this.#handshake(proc);
    const res = (await proc.request("tools/call", { name: tool, arguments: args })) as RawCallResult;
    return normalizeCallResult(res);
  }

  close(): void {
    this.#proc?.kill();
    this.#proc = null;
    this.#initialized = null;
  }
}

// ── streamable-HTTP ──────────────────────────────────────────────────────────

class HttpMcpClient implements McpClient {
  readonly #name: string;
  readonly #transport: McpHttpTransport;
  readonly #env: Record<string, string | undefined>;
  #id = 0;
  #sessionId: string | null = null;
  #initialized: Promise<void> | null = null;

  readonly #oauth: OAuthBearer | undefined;

  constructor(
    name: string,
    transport: McpHttpTransport,
    env: Record<string, string | undefined>,
    oauth?: OAuthBearer,
  ) {
    this.#name = name;
    this.#transport = transport;
    this.#env = env;
    this.#oauth = oauth;
  }

  /** Headers for one request; `token` is the OAuth bearer, when there is one. */
  #headers(token: string | undefined): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.#transport.headers,
    };
    if (token) {
      h.Authorization = `Bearer ${token}`;
    } else if (this.#transport.bearerTokenEnv) {
      const envToken = this.#env[this.#transport.bearerTokenEnv];
      if (envToken) h.Authorization = `Bearer ${envToken}`;
    }
    if (this.#sessionId) h["Mcp-Session-Id"] = this.#sessionId;
    return h;
  }

  /** The OAuth bearer for the next request; throws when the tenant must sign in. */
  async #token(): Promise<string | undefined> {
    if (!this.#oauth) return undefined;
    const token = await this.#oauth.token();
    if (!token) throw new McpSignInRequired(this.#name);
    return token;
  }

  /** POST once, and once more with a refreshed token if the server rejects it.
   *  An OAuth request follows no redirect: the token is bound to this URL and
   *  must not be replayed to wherever a redirect points. */
  async #post(body: string): Promise<Response> {
    const redirect = this.#oauth ? ("error" as const) : ("follow" as const);
    const token = await this.#token();
    const resp = await fetch(this.#transport.url, { method: "POST", headers: this.#headers(token), body, redirect });
    if (resp.status !== 401 || !this.#oauth || !token) return resp;
    this.#oauth.rejected(token);
    const retry = await this.#token();
    return fetch(this.#transport.url, { method: "POST", headers: this.#headers(retry), body, redirect });
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.#id;
    const resp = await this.#post(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.#sessionId = sid;
    if (resp.status === 401 && this.#oauth) throw new McpSignInRequired(this.#name);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${this.#name}`);
    const frame = parseJsonRpc(await resp.text());
    if (frame.error) throw new Error(frame.error.message ?? `${this.#name} JSON-RPC error`);
    return frame.result;
  }

  async #handshake(): Promise<void> {
    if (!this.#initialized) {
      this.#initialized = (async () => {
        await this.#rpc("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        });
        // notifications/initialized is a notification (no id) → 202, no body.
        await this.#post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })).catch(() => {});
      })();
    }
    return this.#initialized;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.#handshake();
    const res = (await this.#rpc("tools/list", {})) as { tools?: RawTool[] };
    return (res.tools ?? []).map(toToolDef);
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.#handshake();
    const res = (await this.#rpc("tools/call", { name: tool, arguments: args })) as RawCallResult;
    return normalizeCallResult(res);
  }

  close(): void {
    this.#sessionId = null;
    this.#initialized = null;
  }
}

// ── shared helpers ────────────────────────────────────────────────────────────

/** How an HTTP client authenticates to an OAuth server. */
interface OAuthBearer {
  token(): Promise<string | undefined>;
  rejected(token: string): void;
}

/** A server's client-pool key: per tenant for an OAuth server. */
function clientKey(spec: McpServerSpec, tenant: McpTenant | undefined): string {
  return tenantKey(spec.name, isOAuthServer(spec) ? tenant : undefined);
}

function tenantKey(name: string, tenant: McpTenant | undefined): string {
  return tenant ? `${name}\u0000${tenant.accountId}\u0000${tenant.projectId}` : name;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_CLIENT_INFO = { name: "codeoid", version: "1.0" } as const;

interface RawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}
interface RawCallResult {
  content?: Array<{ type?: string; text?: unknown }>;
  isError?: boolean;
}

function toToolDef(t: RawTool): McpToolDef {
  return {
    name: String(t.name ?? ""),
    description: typeof t.description === "string" ? t.description : "",
    inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : {},
  };
}

/** Flatten an MCP tool result's content blocks into text. */
function normalizeCallResult(res: RawCallResult): McpCallResult {
  const text = (res.content ?? [])
    .filter((c) => c.type === "text" || c.type === undefined)
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("");
  return { text, isError: res.isError === true };
}

/** Parse a JSON-RPC response body — plain JSON, or a one-shot SSE `data:` frame
 *  (some streamable-HTTP servers answer with text/event-stream). */
function parseJsonRpc(body: string): { result?: unknown; error?: { message?: string } } {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const payload = l.slice(5).trim();
      if (payload && payload !== "[DONE]") return JSON.parse(payload);
    }
  }
  throw new Error("unparseable MCP response");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
