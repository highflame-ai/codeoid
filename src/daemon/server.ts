/**
 * Codeoid daemon — Bun WebSocket server + frontend plugin host.
 *
 * Production-grade patterns:
 *   - Graceful shutdown with cleanup registry
 *   - Session resume from transcript on startup
 *   - Frontend plugin architecture (Telegram, Web UI)
 *   - ZeroID JWT verification on every connection
 */

import { randomUUID } from "node:crypto";
import { ZeroIdVerifier, type AuthConfig } from "./auth.js";
import type { TokenVerifier } from "./verifier.js";
import {
  LocalVerifier,
  removeLocalTokenFile,
  writeLocalTokenFile,
} from "./local-auth.js";
import { SessionManager } from "./session-manager.js";
import { Store } from "./store.js";
import { TranscriptStore } from "./transcript.js";
import { RateLimiter } from "./rate-limit.js";
import { ShutdownManager } from "./shutdown.js";
import { AgentIdentityManager } from "./agent-identity.js";
import { OAuthHandler, type OAuthConfig } from "./oauth.js";
import { GoogleOAuthProvider } from "./identity-provider.js";
import {
  createMemory,
  workspaceIdFromPath,
  MemoryMcpHttp,

  MEMORY_MCP_PATH,
  type MemoryEngine,
} from "./memory/index.js";
import { BLACKBOARD_MCP_PATH } from "./blackboard/mcp-http.js";
import { McpRegistry } from "./mcp/registry.js";
import { McpHub } from "./mcp/hub.js";
import { importClaudeMcpServers } from "./mcp/import-claude.js";
import {
  type CompressionRegistry,
  createRegistry,
} from "./compress/index.js";
import { createHookBus } from "./hooks/bus.js";
import type { CodeoidConfig } from "../config.js";
import { CAPABILITIES, PROTOCOL_VERSION, type AuthContext, type DaemonMessage } from "../protocol/types.js";
import { parseAuthMsg, parseClientMessage } from "@codeoid/protocol/schemas";
import type { AttachedClient } from "./session.js";
import type { Frontend, FrontendContext } from "../frontends/types.js";
import type { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Capabilities THIS daemon advertises on `auth.ok`. Grow this list as
 * capability-gated behaviour lands; clients feature-detect on it instead of
 * version-sniffing.
 */
const SERVER_CAPABILITIES: string[] = [
  CAPABILITIES.CHUNKED_REPLAY,
  CAPABILITIES.SEQ_RESUME,
  CAPABILITIES.SEND_IDEMPOTENCY,
  CAPABILITIES.UI_DIALOGS,
  CAPABILITIES.DYNAMIC_COMMANDS,
  CAPABILITIES.BLACKBOARD,
];

/**
 * Per-connection state carried on `ws.data`. Defined once and cast against in
 * every websocket handler so the shape can't drift between them; `drainWaiters`
 * backs the scrollback-replay backpressure pacing (#84).
 */
type SocketData = {
  clientId: string;
  authenticated: boolean;
  auth: AuthContext | null;
  /**
   * The verified bearer token, kept for the connection's lifetime so flows
   * that need the caller as an RFC 8693 delegation SUBJECT (owner →
   * conductor token exchange) can present it. In-memory only — never
   * logged, never persisted, dies with the socket.
   */
  rawToken?: string;
  authTimer?: ReturnType<typeof setTimeout>;
  drainWaiters?: Array<() => void>;
  /** Protocol version the client declared on its auth frame (absent = legacy client). */
  protocolVersion?: number;
  /** Capabilities the client declared on its auth frame (absent = legacy client). */
  capabilities?: string[];
};

// ── Token-proxy guards ──────────────────────────────────────────────────────
// The /oauth2/token proxy is unauthenticated (pre-auth exchange), so cap body
// size, restrict content types, and rate-limit per source IP so it can't be
// abused as an anonymizing amplifier against the ZeroID issuer.
const PROXY_RATE_MAX = 30;
const PROXY_RATE_WINDOW_MS = 60_000;
const PROXY_BODY_MAX_BYTES = 8 * 1024;
const proxyHits = new Map<string, number[]>();
/** Entries whose newest hit fell out of the window are dead weight — sweep
 * them so a scan from many source IPs (this is a PRE-AUTH endpoint) can't
 * grow the map without bound. O(map) but bounded by the sweep itself. */
function sweepProxyHits(now: number): void {
  for (const [ip, hits] of proxyHits) {
    const newest = hits[hits.length - 1];
    if (newest === undefined || now - newest >= PROXY_RATE_WINDOW_MS) {
      proxyHits.delete(ip);
    }
  }
}
function proxyRateOk(ip: string): boolean {
  const now = Date.now();
  sweepProxyHits(now);
  const arr = (proxyHits.get(ip) ?? []).filter((t) => now - t < PROXY_RATE_WINDOW_MS);
  if (arr.length >= PROXY_RATE_MAX) {
    proxyHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  proxyHits.set(ip, arr);
  return true;
}

/**
 * Local mode (`codeoid start --local`) — see ./local-auth.ts for the full
 * rationale and for what this posture gives up. Presence of this field is the
 * ONE switch that selects the degraded issuer; everything downstream of the
 * verifier is unchanged.
 */
export interface LocalModeConfig {
  /** The single bearer token this daemon accepts. Minted per boot. */
  token: string;
  /**
   * Where to publish the token for local clients (0600). Written on `start()`,
   * removed on shutdown — so the file's presence means "a local-mode daemon is
   * running here", which is what lets `codeoid tui` self-configure. Omit to
   * skip publication (the operator hands the token over some other way).
   */
  tokenFile?: string;
}

export interface DaemonConfig {
  port: number;
  host: string;
  dbPath: string;
  transcriptDir: string;
  auth: AuthConfig;
  /**
   * When set, the daemon authenticates with a locally-minted token instead of
   * ZeroID: no account, no login, no network. Mutually exclusive with the
   * ZeroID path in practice — `auth` is still required (and still used for the
   * ZeroID base URL by non-auth call sites), but no token is ever verified
   * against it while this is present.
   */
  localMode?: LocalModeConfig;
  oauth?: OAuthConfig;
  agentIdentity?: {
    accountId: string;
    projectId: string;
    /** ZeroID registrar key (zid_sk_*) authenticating agent registration. */
    registrarKey?: string;
  };
  /** Memory config — when present, episodes are stored and recall() is exposed to Claude. */
  memory?: {
    /** Absolute path to the episode database. */
    dbPath: string;
    /** HuggingFace embedding model (default: Xenova/bge-small-en-v1.5). */
    model?: string;
    /** Weight cache directory (default: ~/.codeoid/models). */
    modelCacheDir?: string;
  };
  /**
   * Full parsed CodeoidConfig — wired through to Session so the compression
   * subsystem (Layer B) can consult toggles and rule exclusions.
   */
  fullConfig?: CodeoidConfig;
}

interface AuthenticatedSocket {
  ws: WebSocket;
  clientId: string;
  auth: AuthContext;
}

export class DaemonServer {
  #config: DaemonConfig;
  #store: Store;
  #transcriptStore: TranscriptStore;
  #manager: SessionManager;
  #shutdown: ShutdownManager;
  #memory: MemoryEngine | null = null;
  #memoryMcp: MemoryMcpHttp | null = null;
  #mcpRegistry: McpRegistry | null = null;
  #mcpHub: McpHub | null = null;
  #bunServer: ReturnType<typeof Bun.serve> | null = null;
  /** Capabilities advertised on auth.ok — SERVER_CAPABILITIES plus PUSH when a
   *  push transport is configured, so clients can feature-detect push support. */
  #advertisedCapabilities: string[];
  #sockets = new Map<string, AuthenticatedSocket>();
  #frontends: Frontend[] = [];
  #httpHandlers: Array<(req: IncomingMessage, res: ServerResponse) => boolean> = [];
  #oauthHandler: OAuthHandler | null = null;
  /** The one function that turns a bearer token into an AuthContext. */
  #verifier: TokenVerifier;

  constructor(config: DaemonConfig) {
    this.#config = config;
    const pushOn = (config.fullConfig?.push?.transport ?? "none") !== "none";
    this.#advertisedCapabilities = pushOn
      ? [...SERVER_CAPABILITIES, CAPABILITIES.PUSH]
      : SERVER_CAPABILITIES;
    this.#store = new Store(config.dbPath);
    this.#transcriptStore = new TranscriptStore(config.transcriptDir);
    this.#shutdown = new ShutdownManager();

    // The auth posture is chosen exactly once, here. Every enforcement site
    // downstream reads the resulting AuthContext and never learns which issuer
    // produced it (see ./verifier.ts — REVIEW INVARIANT).
    if (config.localMode) {
      this.#verifier = new LocalVerifier(config.localMode.token);
      // Loud and unmissable. The failure this guards against is demonstrating
      // an identity-first control plane in the mode that has no identity.
      console.warn("[codeoid] ┌──────────────────────────────────────────────────────────────┐");
      console.warn("[codeoid] │  LOCAL MODE — no ZeroID, no verified identity                │");
      console.warn("[codeoid] │  Principal is self-asserted; agent identity, delegation,     │");
      console.warn("[codeoid] │  revocation and cryptographic attribution are OFF.           │");
      console.warn("[codeoid] │  For real identities: codeoid login  (docs/local-mode.md)    │");
      console.warn("[codeoid] └──────────────────────────────────────────────────────────────┘");
    } else {
      // Bound to a local so the issuer read needs no cast — a `as ZeroIdVerifier`
      // here would keep compiling if these branches were ever reordered.
      const zeroid = new ZeroIdVerifier(config.auth);
      this.#verifier = zeroid;
      console.log(`[codeoid] auth: ZeroID (issuer ${zeroid.issuer})`);
    }

    // Google OAuth mints tokens by exchanging at the ZeroID token endpoint, so
    // it is meaningless (and would reach the network) under local mode.
    if (config.oauth && !config.localMode) {
      const idp = new GoogleOAuthProvider({
        clientId: config.oauth.googleClientId,
        clientSecret: config.oauth.googleClientSecret,
      });
      this.#oauthHandler = new OAuthHandler(config.oauth, idp);
      console.log(`[codeoid] auth provider: ${idp.name}`);
    } else if (config.oauth) {
      console.warn("[codeoid] local mode: Google OAuth sign-in disabled (it needs ZeroID)");
    }

    // Agent identity registers SPIFFE/WIMSE identities against ZeroID. In local
    // mode there is nothing to register against, and attempting it is exactly
    // the boot-time network dependency local mode exists to avoid. Guarded here
    // (not only in the CLI) so any embedder gets the same guarantee.
    let identityManager: AgentIdentityManager | undefined;
    if (config.agentIdentity && !config.localMode) {
      identityManager = new AgentIdentityManager(
        {
          auth: config.auth,
          accountId: config.agentIdentity.accountId,
          projectId: config.agentIdentity.projectId,
          registrarKey: config.agentIdentity.registrarKey,
        },
        this.#store,
      );
    } else if (config.agentIdentity) {
      console.warn(
        "[codeoid] local mode: per-agent ZeroID identity disabled (agents run as anonymous:*)",
      );
    }

    // Build the compression registry once at startup. It's stateless and
    // safe to share across all sessions — rules never mutate.
    const compressionRegistry: CompressionRegistry | undefined = config.fullConfig
      ? createRegistry(config.fullConfig)
      : undefined;

    // Build the hook bus once at startup — config-declared hooks dispatched
    // at every session's seams, uniformly across backends (hooks/bus.ts).
    const hooks = createHookBus(config.fullConfig);
    if (hooks) {
      console.log(`[codeoid] hooks: ${hooks.size} configured`);
    }

    // Unlimited unless the operator configured a bound — see rate-limit.ts for
    // why a hardcoded cap was the wrong default for a single-operator daemon.
    const rateLimiter = new RateLimiter(config.fullConfig?.rateLimit);
    if (config.fullConfig?.rateLimit && !rateLimiter.disabled) {
      const { maxSessionsPerUser, maxCreationsPerHour } = config.fullConfig.rateLimit;
      console.log(
        `[codeoid] session limits: ${maxSessionsPerUser || "unlimited"} concurrent, ` +
          `${maxCreationsPerHour || "unlimited"}/hr per subject`,
      );
    }
    this.#manager = new SessionManager(
      this.#store, this.#transcriptStore, identityManager, rateLimiter,
      // Memory is wired post-construction via initMemory() — see start()
      undefined,
      { config: config.fullConfig, compressionRegistry, hooks },
    );

    console.log(`[codeoid] providers: ${this.#manager.providerIds().join(", ")}`);
    for (const { id, hint } of this.#manager.unavailableProviders()) {
      console.warn(`[codeoid] provider ${id} unavailable: ${hint}`);
    }

    // Register cleanup functions. ShutdownManager runs them LIFO, so the
    // LAST registered runs FIRST. Order matters: sessions must DRAIN (their
    // final audit/usage writes land in store + memory) BEFORE store/memory
    // close — hence store/memory are registered first (they close last) and
    // sessions is registered after them (drains first).
    this.#shutdown.register("memory", async () => {
      if (this.#memory) await this.#memory.close();
    });
    this.#shutdown.register("mcp", () => this.#mcpHub?.closeAll());
    this.#shutdown.register("store", () => this.#store.close());
    this.#shutdown.register("sessions", () => this.#manager.drain(10_000));
    // LIFO: registered after sessions → stops BEFORE the drain, so the
    // dispatcher can't claim new work or inject events into draining sessions.
    this.#shutdown.register("dispatcher", () => this.#manager.stopDispatcher());
    this.#shutdown.register("websockets", () => {
      for (const { ws } of this.#sockets.values()) {
        ws.close(1001, "Server shutting down");
      }
    });
    this.#shutdown.register("server", () => {
      this.#bunServer?.stop();
    });
    // LIFO: registered last → runs FIRST, so the published token stops being
    // discoverable before anything else winds down. The token dies with the
    // process (a fresh one is minted next boot), which is what keeps it from
    // becoming a durable credential lying around in the config dir.
    const tokenFile = config.localMode?.tokenFile;
    if (tokenFile) {
      this.#shutdown.register("local-token", () => removeLocalTokenFile(tokenFile));
    }
  }

  get manager(): SessionManager {
    return this.#manager;
  }

  /**
   * The port actually being listened on — differs from `config.port` when the
   * caller passed 0 to let the OS pick. Falls back to the configured value
   * before `start()`.
   */
  get port(): number {
    return this.#bunServer?.port ?? this.#config.port;
  }

  /** Which issuer this daemon verifies tokens against. */
  get authMode(): TokenVerifier["mode"] {
    return this.#verifier.mode;
  }

  // ── Frontend plugin management ──────────────────────────────────────

  use(frontend: Frontend): void {
    this.#frontends.push(frontend);

    // Register frontend cleanup
    this.#shutdown.register(`frontend:${frontend.name}`, () => frontend.stop());
  }

  route(handler: (req: IncomingMessage, res: ServerResponse) => boolean): void {
    this.#httpHandlers.push(handler);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Install signal handlers
    this.#shutdown.install();

    // Publish the local-mode token for clients on this machine BEFORE the
    // socket opens, so `codeoid tui` in another terminal can never observe a
    // listening daemon without a readable token.
    const localMode = this.#config.localMode;
    if (localMode?.tokenFile) {
      writeLocalTokenFile(localMode.tokenFile, localMode.token);
      console.log(`[codeoid] local-mode token published to ${localMode.tokenFile} (0600)`);
    }

    // Boot memory engine if configured — before resume so ingestion queue is ready.
    if (this.#config.memory) {
      try {
        this.#memory = await createMemory({
          dbPath: this.#config.memory.dbPath,
          embedder: {
            model: this.#config.memory.model,
            cacheDir: this.#config.memory.modelCacheDir,
          },
        });
        await this.#memory.init();
        this.#manager.setMemory(this.#memory);
        // Shared in-daemon MCP endpoint over the same live engine, mounted by
        // URL-based backends (gemini-cli via ACP). Loopback URL: the agent
        // subprocess runs on this host regardless of the daemon's bind address.
        this.#memoryMcp = new MemoryMcpHttp(this.#memory);
        this.#manager.setMemoryMcp({
          endpoint: this.#memoryMcp,
          url: `http://127.0.0.1:${this.#config.port}${MEMORY_MCP_PATH}`,
        });
        console.log(
          `[codeoid] memory enabled — episodes -> ${this.#config.memory.dbPath}`,
        );
        // One-time: re-key episodes written under the old path-only workspace
        // ids to the tenant-scoped ids, so memory from before the upgrade stays
        // recallable. Gate on needsWorkspaceMigration() so the session-table
        // read only happens on the first boot, not every restart. Best-effort.
        if (this.#memory.store.needsWorkspaceMigration()) {
          try {
            const r = this.#memory.store.migrateWorkspaceIdsToTenant(
              this.#store.listAllSessionsForMigration(),
              workspaceIdFromPath,
            );
            if (r.migrated) {
              console.log(
                `[codeoid] memory: re-keyed ${r.reKeyed} pre-upgrade episode(s) to tenant-scoped workspaces`,
              );
            }
          } catch (err) {
            console.error(
              `[codeoid] memory workspace migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[codeoid] memory init failed, continuing without recall: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.#memory = null;
      }
    }

    // Cross-backend MCP registry + daemon-owned client pool (see
    // docs/provider-mcp-registry-design.md). Built whether or not memory is on:
    // the registry injects `codeoid_memory` only when memory is enabled, and the
    // hub serves external servers with or without an engine. Providers mount the
    // registry's servers on every backend through one uniform gate.
    // Import global ~/.claude.json servers so a user's existing Claude MCP
    // servers work on every backend; an explicit config entry wins on collision.
    const imported = importClaudeMcpServers();
    const mcpServers = { ...imported, ...(this.#config.fullConfig?.mcpServers ?? {}) };
    const importedCount = Object.keys(imported).length;
    if (importedCount > 0) console.log(`[codeoid] mcp: imported ${importedCount} server(s) from ~/.claude.json`);
    this.#mcpRegistry = new McpRegistry(mcpServers, {
      memoryEnabled: this.#memory != null,
    });
    this.#mcpHub = new McpHub({
      engine: this.#memory,
      toolTimeoutMs: this.#config.fullConfig?.session.mcpToolTimeoutMs,
      daemonEnv: process.env,
    });
    for (const w of this.#mcpRegistry.warnings) console.warn(`[codeoid] ${w}`);
    // Goal blackboard: loopback URL regardless of bind address — the agent
    // subprocess runs on this host, and the endpoint must not become
    // reachable off-box just because the daemon binds wide.
    this.#manager.setBlackboardUrl(
      `http://127.0.0.1:${this.#config.port}${BLACKBOARD_MCP_PATH}`,
    );
    this.#manager.setMcp(this.#mcpRegistry, this.#mcpHub);
    const mcpCount = this.#mcpRegistry.list().filter((s) => !s.builtin).length;
    if (mcpCount > 0) console.log(`[codeoid] mcp: ${mcpCount} external server(s) registered`);

    // Resume sessions from transcripts
    const resumed = await this.#manager.resumeSessions();
    if (resumed > 0) {
      console.log(`[codeoid] resumed ${resumed} session(s) from transcript`);
    }

    // Start the dispatch queue AFTER resume: the first tick reclaims tasks
    // claimed by the previous boot, and surviving workers must already be
    // back in the session map for continuation to find them.
    this.#manager.startDispatcher();

    // Re-drive any SDLC pipelines interrupted mid-run before the restart
    // (no-op when the pipeline feature is disabled).
    this.#manager.startPipelines();

    // Start Bun HTTP + WebSocket server
    const self = this;
    const authConfig = this.#config.auth;

    this.#bunServer = Bun.serve({
      port: this.#config.port,
      hostname: this.#config.host,

      async fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const success = server.upgrade(req, {
            data: { clientId: randomUUID(), authenticated: false, auth: null } satisfies SocketData,
          });
          return success
            ? undefined
            : new Response("WebSocket upgrade failed", { status: 500 });
        }

        // HTTP routes
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", version: "0.1.0" });
        }

        // Shared memory MCP endpoint (URL-mounting backends: gemini-cli/codex).
        // Auth is the per-session bearer token minted by the mounting provider;
        // the endpoint fails closed on a missing/unknown token.
        if (url.pathname === MEMORY_MCP_PATH) {
          const ep = self.#memoryMcp;
          if (!ep) return new Response("memory disabled", { status: 503 });
          return ep.handle(req);
        }

        // Goal-blackboard MCP endpoint. Same contract as memory: the bearer
        // token minted per role-child IS the scope (one goal, one role's
        // read/write set), and an unknown token fails closed. Always mounted —
        // unlike memory it has no enable flag, and with no minted tokens every
        // request 401s anyway.
        if (url.pathname === BLACKBOARD_MCP_PATH) {
          return self.#manager.blackboardMcp.handle(req);
        }

        if (url.pathname === "/config") {
          return Response.json({
            zeroid_url: authConfig.baseUrl,
            // Which issuer this daemon actually verifies against. Same value as
            // `auth.ok`'s authMode; exposed here too so an operator can check
            // the posture with curl before connecting anything.
            auth_mode: self.#verifier.mode,
          });
        }

        // Token exchange proxy (avoids CORS). `/oauth2/token` is the path the
        // web UI posts to same-origin — Vite proxies it in dev; the daemon
        // proxies it when it serves the UI itself (the Telegram Mini App
        // through a tunnel). `/auth/token` is the legacy alias.
        if (
          (url.pathname === "/auth/token" || url.pathname === "/oauth2/token") &&
          req.method === "POST"
        ) {
          // Local mode has no issuer to exchange against, and forwarding would
          // turn the daemon into an unauthenticated egress path to ZeroID for
          // any local process. Refuse it outright rather than proxying a token
          // that could never authenticate here anyway.
          if (self.#config.localMode) {
            return Response.json(
              { error: "token exchange unavailable in local mode" },
              { status: 503 },
            );
          }
          const ip = server.requestIP(req)?.address ?? "unknown";
          if (!proxyRateOk(ip)) {
            return Response.json({ error: "rate limited" }, { status: 429 });
          }
          // Only the content types the exchange legitimately uses.
          const contentType =
            req.headers.get("Content-Type") ?? "application/json";
          const ctBase = contentType.split(";")[0]!.trim().toLowerCase();
          if (
            ctBase !== "application/json" &&
            ctBase !== "application/x-www-form-urlencoded"
          ) {
            return Response.json({ error: "unsupported content-type" }, { status: 415 });
          }
          const clen = Number(req.headers.get("Content-Length") ?? "0");
          if (Number.isFinite(clen) && clen > PROXY_BODY_MAX_BYTES) {
            return Response.json({ error: "request too large" }, { status: 413 });
          }
          try {
            const body = await req.text();
            if (body.length > PROXY_BODY_MAX_BYTES) {
              return Response.json({ error: "request too large" }, { status: 413 });
            }
            // Forward the caller's actual Content-Type — the web UI posts
            // application/x-www-form-urlencoded; hardcoding JSON made ZeroID
            // JSON-parse a form body ("invalid character 'g'"). Forward the
            // source IP so ZeroID's own abuse controls see the real client.
            const fwdHeaders: Record<string, string> = { "Content-Type": contentType };
            if (ip !== "unknown") fwdHeaders["X-Forwarded-For"] = ip;

            // Retry transient upstream 5xx (ZeroID has intermittently returned
            // "500 Internal Server Error" on token exchange). A 4xx is a real
            // rejection (bad/expired key) — never retried. Up to 3 attempts
            // with short backoff so a flaky upstream doesn't fail a login on
            // the first try. Every attempt's status is logged so a recurring
            // 500 is visible in the daemon log (secrets are never logged).
            const ZEROID_URL = `${authConfig.baseUrl}/oauth2/token`;
            let zeroidResp: Response | null = null;
            let data = "";
            for (let attempt = 1; attempt <= 3; attempt++) {
              zeroidResp = await fetch(ZEROID_URL, {
                method: "POST",
                headers: fwdHeaders,
                body,
              });
              data = await zeroidResp.text();
              if (zeroidResp.status < 500) break;
              console.warn(
                `[codeoid] /oauth2/token upstream ${zeroidResp.status} (attempt ${attempt}/3) from ${ZEROID_URL} — body: ${data.slice(0, 200)}`,
              );
              if (attempt < 3) await Bun.sleep(250 * attempt);
            }
            if (zeroidResp && zeroidResp.status >= 400) {
              console.warn(
                `[codeoid] /oauth2/token returning ${zeroidResp.status} to client (ct=${ctBase})`,
              );
            }
            return new Response(data, {
              status: zeroidResp?.status ?? 502,
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            console.error(
              `[codeoid] /oauth2/token proxy error: ${err instanceof Error ? err.message : String(err)}`,
            );
            return Response.json({ error: "ZeroID unreachable" }, { status: 502 });
          }
        }

        // OAuth authorization routes (/auth/authorize, /auth/callback, /auth/provider)
        if (url.pathname.startsWith("/auth/")) {
          if (url.pathname === "/auth/provider" && req.method === "GET" && !self.#oauthHandler) {
            return Response.json({ provider: null });
          }
          if (self.#oauthHandler) {
            const oauthResp = await self.#oauthHandler.handleFetch(req);
            if (oauthResp) return oauthResp;
          }
        }

        // Frontend routes (Web UI etc.)
        for (const frontend of self.#frontends) {
          if ("handleFetch" in frontend && typeof frontend.handleFetch === "function") {
            const resp = await (frontend as { handleFetch: (req: Request) => Promise<Response | null> }).handleFetch(req);
            if (resp) return resp;
          }
        }

        return new Response("Not Found", { status: 404 });
      },

      websocket: {
        // Bound inbound frame size so a client can't send a huge payload
        // (16MB is generous for prompts/attachments + inline import bundles,
        // far under Bun's ~128MB default). Bound the per-client OUTBOUND
        // buffer and auto-close a client that can't keep up — a suspended
        // mobile webview otherwise accrues unbounded server-side buffer during
        // a chatty streaming turn and is never pruned (Bun's send() returns a
        // backpressure code rather than throwing, so the broadcast catch never
        // fires). closeOnBackpressureLimit handles that natively.
        maxPayloadLength: 16 * 1024 * 1024,
        backpressureLimit: 16 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        open(ws) {
          // Auth timeout — client must authenticate within 10 seconds
          const data = ws.data as SocketData;
          data.authTimer = setTimeout(() => {
            if (!data.authenticated) {
              ws.close(4001, "Authentication timeout");
            }
          }, 10_000);
        },

        async message(ws, rawMessage) {
          const data = ws.data as SocketData;
          let parsed: Record<string, unknown>;

          try {
            parsed = JSON.parse(typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage));
          } catch {
            ws.send(JSON.stringify({ type: "response.error", requestId: "", error: "Invalid JSON", code: "invalid_request" }));
            return;
          }

          // First message must be a valid auth frame (schema-validated —
          // unknown fields stripped, malformed frames close the socket).
          if (!data.authenticated) {
            if (data.authTimer) clearTimeout(data.authTimer);
            const authParse = parseAuthMsg(parsed);
            if (!authParse.ok) {
              ws.close(4001, `Invalid auth message: ${authParse.error}`.slice(0, 123));
              return;
            }
            const authMsg = authParse.value;

            try {
              data.auth = await self.#verifier.verify(authMsg.token);
            } catch (err) {
              ws.close(4003, `Authentication failed: ${err instanceof Error ? err.message : "unknown"}`);
              return;
            }

            data.authenticated = true;
            data.rawToken = authMsg.token;
            // Record what the client declared so capability-gated behaviour
            // (parts-only streaming, seq resume, …) can branch per connection.
            data.protocolVersion = authMsg.protocolVersion;
            data.capabilities = authMsg.capabilities;
            if (authMsg.client || authMsg.protocolVersion !== undefined) {
              console.log(
                `[codeoid] client authenticated: ${authMsg.client ?? "unknown"} proto=${authMsg.protocolVersion ?? "?"} caps=[${(authMsg.capabilities ?? []).join(",")}]`,
              );
            }
            self.#sockets.set(data.clientId, { ws: ws as unknown as WebSocket, clientId: data.clientId, auth: data.auth });

            ws.send(JSON.stringify({
              type: "auth.ok",
              identity: {
                sub: data.auth.sub,
                name: data.auth.name,
                type: data.auth.delegationDepth === 0 ? "human" : "agent",
              },
              scopes: data.auth.scopes,
              protocolVersion: PROTOCOL_VERSION,
              capabilities: self.#advertisedCapabilities,
              // Registered backends, default first — feeds the new-session
              // provider picker (see AuthOkMsg.providers).
              providers: self.#manager.providerIds(),
              // Which issuer authenticated this connection. Clients render
              // "local" as a visible badge — degradation must never be silent.
              authMode: self.#verifier.mode,
            }));
            return;
          }

          // Enforce token expiry on every message. Without this a
          // continuously-open socket would honor an expired token forever
          // (revocation/expiry only took effect on reconnect). On expiry we
          // close 4003; the client reconnects and re-exchanges its key for a
          // fresh JWT. (Instant revocation of a still-valid token would need
          // a periodic re-verify / revocation check — tracked separately.)
          if (
            typeof data.auth?.exp === "number" &&
            data.auth.exp > 0 &&
            data.auth.exp <= Math.floor(Date.now() / 1000)
          ) {
            self.#sockets.delete(data.clientId);
            self.#manager.disconnectClient(data.clientId);
            ws.close(4003, "Token expired");
            return;
          }

          // Authenticated — validate against the protocol schemas before
          // acting. Unknown fields are stripped (forward-compat: a newer
          // client may send additive fields); unknown message types and
          // out-of-bounds payloads (e.g. text > LIMITS.SEND_TEXT_MAX) are
          // rejected with invalid_request instead of reaching daemon logic.
          const inbound = parseClientMessage(parsed);
          if (!inbound.ok) {
            ws.send(JSON.stringify({
              type: "response.error",
              requestId: typeof parsed.id === "string" ? parsed.id : "",
              error: inbound.error,
              code: "invalid_request",
            }));
            return;
          }
          const msg = inbound.value;
          const client: AttachedClient = {
            id: data.clientId,
            auth: data.auth!,
            // Declared on the auth frame; Session gates capability-specific
            // frames (session.ui_request) on this.
            capabilities: data.capabilities,
            send: (m: DaemonMessage) => {
              try {
                ws.send(JSON.stringify(m));
              } catch { /* client may have disconnected */ }
            },
            // Resolves once the outbound buffer has drained below one replay
            // chunk, so a chunked scrollback replay (#84) paces itself and never
            // accumulates past backpressureLimit. Resolved by `drain` (or, if the
            // socket dies mid-replay, by `close`).
            flush: () => {
              const LOW_WATER = 4 * 1024 * 1024;
              const buffered = (ws as unknown as { getBufferedAmount(): number }).getBufferedAmount();
              if (buffered <= LOW_WATER) return Promise.resolve();
              return new Promise<void>((resolve) => {
                if (!data.drainWaiters) data.drainWaiters = [];
                data.drainWaiters.push(resolve);
              });
            },
          };

          try {
            const response = await self.#manager.handle(msg, data.auth!, client, {
              rawToken: data.rawToken,
            });
            ws.send(JSON.stringify(response));
          } catch (err) {
            ws.send(JSON.stringify({
              type: "response.error",
              requestId: (msg as { id?: string }).id ?? "",
              error: err instanceof Error ? err.message : "Internal error",
              code: "internal",
            }));
          }
        },

        // Backpressure relieved — release any replay chunk waiting to be sent
        // (see the client `flush` above and Session#streamReplay, #84).
        drain(ws) {
          const data = ws.data as SocketData;
          const waiters = data.drainWaiters;
          if (waiters && waiters.length > 0) {
            data.drainWaiters = [];
            for (const resolve of waiters) resolve();
          }
        },

        close(ws) {
          const data = ws.data as SocketData;
          if (data.authTimer) clearTimeout(data.authTimer);
          // Unblock any in-flight replay flush so its stream loop can observe
          // the detach and stop instead of awaiting a drain that never comes.
          if (data.drainWaiters && data.drainWaiters.length > 0) {
            const waiters = data.drainWaiters;
            data.drainWaiters = [];
            for (const resolve of waiters) resolve();
          }
          self.#manager.disconnectClient(data.clientId);
          self.#sockets.delete(data.clientId);
        },
      },
    });

    console.log(`[codeoid] daemon listening on ${this.#config.host}:${this.#config.port}`);

    // Start all registered frontends
    const ctx: FrontendContext = {
      manager: this.#manager,
      store: this.#store,
      auth: this.#config.auth,
      verifier: this.#verifier,
      httpServer: null as unknown as Server, // Not used with Bun.serve
      host: this.#config.host,
      port: this.#config.port,
    };

    for (const frontend of this.#frontends) {
      try {
        await frontend.start(ctx);
        console.log(`[codeoid] frontend started: ${frontend.name}`);
      } catch (err) {
        console.error(`[codeoid] frontend failed to start: ${frontend.name}`, err);
      }
    }
  }

  async stop(): Promise<void> {
    await this.#shutdown.shutdown("manual");
  }
}
