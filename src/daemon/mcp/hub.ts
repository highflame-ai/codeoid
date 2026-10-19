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
 *   - http       — streamable-HTTP through the official SDK client
 *                  (mcp/upstream.ts, shared with the relay); a bearer read from
 *                  an env-var name, never argv, or the tenant's OAuth token.
 *
 * Clients connect lazily on first use and are cached; a dead client is dropped
 * and recreated on the next call (simple reconnect — richer health/backoff is S6).
 */

import { StdioJsonRpcProcess } from "../providers/jsonrpc-stdio.js";
import { memoryToolDefs, type MemoryToolContext } from "../memory/tools.js";
import type { MemoryEngine } from "../memory/engine.js";
import { isOAuthServer, resolveEnvMap } from "./types.js";
import type { McpServerSpec, McpStdioTransport } from "./types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpSignInRequired, type McpCredentialSource, type McpTenant } from "./oauth.js";
import type { McpProxy } from "./proxy.js";
import { cleanMcpError } from "./redact.js";
import { closeUpstream, FailureStreak, McpServerWantsSignIn, openUpstream, sessionGone, sessionTrouble, type UpstreamBearer, type UpstreamOptions } from "./upstream.js";

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
  /** Whether this failure leaves the client unusable (dropped, and remade on
   *  next use). Absent: every failure does. A client shared by concurrent
   *  calls says no to a failure that was one call's alone. */
  brokenBy?(e: unknown): boolean;
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
    return this.listToolsOrThrow(spec, scope).catch(() => []);
  }

  /**
   * List a server's tools, or throw why not (not signed in, a revoked token,
   * a server down, a timeout) — for a caller that reports the failure itself,
   * like Claude's in-process mount (#390), where an empty list would read as a
   * healthy server with no tools. Timed like a call.
   */
  async listToolsOrThrow(spec: McpServerSpec, scope?: McpCallScope): Promise<McpToolDef[]> {
    const key = clientKey(spec, scope?.tenant);
    let client: McpClient | undefined;
    try {
      client = this.#clientFor(spec, scope?.tenant);
      const all = await withTimeout(client.listTools(), this.#timeoutMs, `${spec.name}/tools/list`);
      const tools = spec.toolAllowlist ? all.filter((t) => spec.toolAllowlist?.includes(t.name)) : all;
      this.#status.set(key, { tools: tools.map((t) => t.name) });
      // It answers without a sign-in now: no longer held back.
      if (spec.transport.kind === "http" && scope?.tenant) this.#wantsSignIn.delete(signInKey(spec.transport.url, scope.tenant));
      return tools;
    } catch (e) {
      if (e instanceof McpServerWantsSignIn && spec.transport.kind === "http") this.markNeedsSignIn(spec.transport.url, scope?.tenant);
      // Not having signed in is not a fault of the server: no health to
      // record — and the tool list from before is gone with the credential.
      if (e instanceof McpSignInRequired) this.#status.delete(key);
      else this.#status.set(key, { tools: [], error: cleanMcpError(errMsg(e)) });
      if (client) this.#dropIfBroken(key, e, client);
      throw e;
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
      return { text: `mcp: ${spec.name} unavailable: ${cleanMcpError(errMsg(e))}`, isError: true };
    }
    try {
      return await withTimeout(client.callTool(tool, args, scope), this.#timeoutMs, `${spec.name}/${tool}`);
    } catch (e) {
      if (e instanceof McpServerWantsSignIn && spec.transport.kind === "http") {
        this.markNeedsSignIn(spec.transport.url, scope.tenant);
        this.#dropIfBroken(clientKey(spec, scope.tenant), e, client);
        return { text: e.message, isError: true };
      }
      this.#dropIfBroken(clientKey(spec, scope.tenant), e, client); // reconnect on next use
      if (e instanceof McpSignInRequired) return { text: e.message, isError: true };
      // codeoid has no OTEL; a failed external tool call is worth one daemon log
      // line (transport error / timeout) so a flaky server is diagnosable.
      // A transport error can quote the URL or a server's stderr: cleaned
      // before it reaches the log, the model or the transcript.
      const error = cleanMcpError(errMsg(e));
      console.error(`[codeoid] mcp: ${spec.name}/${tool} failed: ${error}`);
      const key = clientKey(spec, scope.tenant);
      this.#status.set(key, { tools: this.#status.get(key)?.tools ?? [], error });
      return { text: `Error calling ${spec.name}/${tool}: ${error}`, isError: true };
    }
  }

  /** Last-observed status for a server (from accumulated use), or undefined if
   *  the daemon hasn't listed/called it yet. Read by the settings surface.
   *  An OAuth server is called as a tenant, so its status is that tenant's —
   *  pass `tenant` for one; another tenant's errors and tools are not shown. */
  statusFor(name: string, tenant?: McpTenant): { tools: string[]; error?: string } | undefined {
    return this.#status.get(tenantKey(name, tenant));
  }

  /**
   * Whether calls to this server can be made as `tenant` now: always for a
   * server without OAuth; for an OAuth one, only once the tenant has signed in
   * (a stored credential, no network call). Lets a backend that lists a
   * server's tools up front leave out one that would only fail.
   */
  signedIn(spec: McpServerSpec, tenant: McpTenant | undefined): boolean {
    if (!isOAuthServer(spec)) return true;
    if (!tenant || !this.#credentials?.signedIn) return false;
    return this.#credentials.signedIn(spec, tenant);
  }

  /** Changes whenever the tenant's credential for an OAuth server does; "" for
   *  a server without OAuth, undefined when not signed in. */
  credentialStamp(spec: McpServerSpec, tenant: McpTenant | undefined): string | undefined {
    if (!isOAuthServer(spec)) return "";
    if (!tenant) return undefined;
    return this.#credentials?.credentialStamp?.(spec, tenant);
  }

  /**
   * Record what another path to a server observed (the relay, #396), so
   * Settings shows one status per server whichever path used it: its tools
   * after a listing, or the last error (keeping the tools known before).
   */
  noteStatus(spec: McpServerSpec, tenant: McpTenant | undefined, status: { tools?: string[]; error?: string; signedOut?: boolean }): void {
    const key = clientKey(spec, tenant);
    // Not signed in is no fault of the server: no health, and no tools from before.
    if (status.signedOut) this.#status.delete(key);
    else if (status.tools) this.#status.set(key, { tools: status.tools });
    else this.#status.set(key, { tools: this.#status.get(key)?.tools ?? [], ...(status.error ? { error: status.error } : {}) });
  }

  /**
   * Plain HTTP servers that answered with the MCP sign-in challenge (#395), per
   * tenant: held back from that tenant's backends that would only get 401s.
   * A mark lasts ten minutes (then the server is tried again), and goes as
   * soon as the server answers.
   */
  readonly #wantsSignIn = new Map<string, number>();

  /** Whether the plain HTTP server at `url` has asked `tenant` for an OAuth sign-in. */
  needsSignIn(url: string, tenant: McpTenant | undefined): boolean {
    if (!tenant) return false;
    const key = signInKey(url, tenant);
    const until = this.#wantsSignIn.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.#wantsSignIn.delete(key);
    return false;
  }

  /** Note that the server at `url` asked `tenant` for a sign-in (here, or as Claude saw it). */
  markNeedsSignIn(url: string, tenant: McpTenant | undefined): void {
    if (tenant) this.#wantsSignIn.set(signInKey(url, tenant), Date.now() + SIGN_IN_HOLD_MS);
  }

  /** Close one server's client (a workdir server no longer in a session's view). */
  dropSpec(spec: McpServerSpec, tenant: McpTenant | undefined): void {
    this.#drop(clientKey(spec, tenant));
  }

  /** How native backends that own their MCP clients reach this daemon's OAuth
   *  servers (Codex, the Gemini CLI, Qwen — mcp/proxy.ts); unset when the
   *  daemon serves no relay. */
  proxy: McpProxy | null = null;

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
      if (key === name || key.startsWith(`${name}\u0000`) || key.startsWith(`${name}\u0001`)) this.#drop(key);
    }
  }

  /** Drop one tenant's client for a server (it signed out or back in). */
  dropTenant(name: string, tenant: McpTenant): void {
    this.#drop(tenantKey(name, tenant));
  }

  /** Drop `client` if this failure broke it — and only if it is still the
   *  one held: a newer client, opened since, isn't the one that failed. */
  #dropIfBroken(key: string, e: unknown, client: McpClient): void {
    if (this.#clients.get(key) === client && (client.brokenBy?.(e) ?? true)) this.#drop(key);
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
        const base = { name: spec.name, transport: spec.transport, env: this.#env };
        if (!isOAuthServer(spec)) return new HttpMcpClient(base, this.#timeoutMs);
        const credentials = this.#credentials;
        if (!credentials || !tenant) throw new McpSignInRequired(spec.name);
        return new HttpMcpClient({ ...base, oauth: upstreamBearer(credentials, spec, tenant) }, this.#timeoutMs);
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
      cwd: this.#transport.cwd ?? this.#env.HOME ?? process.cwd(),
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

/** A remote server, through the daemon's one upstream client (mcp/upstream.ts). */
class HttpMcpClient implements McpClient {
  readonly #opts: UpstreamOptions;
  readonly #timeoutMs: number;
  #client: Promise<Client> | null = null;

  constructor(opts: UpstreamOptions, timeoutMs: number) {
    this.#opts = opts;
    this.#timeoutMs = timeoutMs;
  }

  readonly #streak = new FailureStreak();

  #connect(): Promise<Client> {
    if (!this.#client) {
      const connecting = openUpstream({ ...this.#opts, timeoutMs: this.#timeoutMs });
      this.#client = connecting;
      // A failed handshake isn't kept: the next call tries again.
      connecting.catch(() => {
        if (this.#client === connecting) this.#client = null;
      });
    }
    return this.#client;
  }

  async listTools(): Promise<McpToolDef[]> {
    const client = await this.#connect();
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    // Read loosely, as before the SDK client: one tool with an odd schema
    // mustn't hide all of a server's tools (the SDK's listTools validates
    // every one strictly).
    do {
      const page = (await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        ResultSchema,
        { timeout: this.#timeoutMs },
      )) as { tools?: unknown; nextCursor?: unknown };
      if (Array.isArray(page.tools)) {
        tools.push(...(page.tools as RawTool[]).filter((t) => typeof t === "object" && t !== null && typeof t.name === "string").map(toToolDef));
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      // A server repeating a cursor would page forever.
      if (cursor !== undefined && seen.has(cursor)) break;
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor && tools.length < MAX_TOOLS && seen.size < MAX_PAGES);
    this.#streak.succeeded();
    return tools;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const client = await this.#connect();
    // Loosely too: the SDK's callTool also enforces a declared outputSchema,
    // which the hub (text results) never did.
    const res = await client.request({ method: "tools/call", params: { name: tool, arguments: args } }, ResultSchema, {
      timeout: this.#timeoutMs,
    });
    this.#streak.succeeded();
    return normalizeCallResult(res as RawCallResult);
  }

  close(): void {
    const client = this.#client;
    this.#client = null;
    client?.then((c) => closeUpstream(c), () => {});
  }

  /** One session serves every call to this server (for this tenant): only a
   *  failure of the session itself ends it, never one call's error or timeout.
   *  A sign-in needed again is the credential, not the session. */
  brokenBy(e: unknown): boolean {
    if (e instanceof McpSignInRequired) return false;
    return sessionGone(e) || (sessionTrouble(e) && this.#streak.failed());
  }
}

/** Pages of tools/list read at most up to this many tools, or this many pages. */
const MAX_TOOLS = 10_000;
const MAX_PAGES = 100;

// ── shared helpers ────────────────────────────────────────────────────────────

/** The tenant's OAuth bearer for a server, from the credential source. */
export function upstreamBearer(credentials: McpCredentialSource, spec: McpServerSpec, tenant: McpTenant): UpstreamBearer {
  return {
    token: () => credentials.accessToken(spec, tenant),
    rejected: (token) => credentials.rejected(spec, tenant, token),
  };
}

/** A server's client-pool key: per tenant for an OAuth server. */
function clientKey(spec: McpServerSpec, tenant: McpTenant | undefined): string {
  // A workdir's server (#395) is keyed by its config, its workdir and the
  // tenant: two workdirs' "db" — or two tenants' — are different servers, and
  // a session never reaches another's process.
  if (spec.variant) {
    const cwd = spec.transport.kind === "stdio" ? (spec.transport.cwd ?? "") : "";
    return tenantKey(`${spec.name}\u0001${spec.variant}\u0001${cwd}`, tenant);
  }
  return tenantKey(spec.name, isOAuthServer(spec) ? tenant : undefined);
}

const SIGN_IN_HOLD_MS = 10 * 60_000;

function signInKey(url: string, tenant: McpTenant): string {
  return `${tenant.accountId}\u0000${tenant.projectId}\u0000${url}`;
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
  // Tolerant of a server's malformed result: a throw here would read as a
  // broken session and cut the calls beside this one.
  const content = Array.isArray(res?.content) ? res.content : [];
  const text = content
    .filter((c) => typeof c === "object" && c !== null && (c.type === "text" || c.type === undefined))
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("");
  return { text, isError: res?.isError === true };
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
