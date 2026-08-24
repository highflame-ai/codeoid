/**
 * ProviderRegistry — the daemon's catalog of session backends.
 *
 * Providers are SESSION-scoped (each session gets its own instance: warm
 * providers hold a live backing loop; stateless ones hold per-session
 * config), so the registry holds FACTORIES, not instances. The registry is
 * built once at daemon startup (`createDefaultProviderRegistry()`), shared
 * by the SessionManager, and consulted on every session construction —
 * replacing the hardcoded provider `switch` that used to live in Session.
 *
 * Adding a backend = one `ProviderFactory` + one `register()` call; nothing
 * in Session/SessionManager changes.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store.js";
import type { AgentIdentityManager } from "../agent-identity.js";
import type { MemoryEngine } from "../memory/index.js";
import type { MemoryMcpMount } from "../memory/mcp-http.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { McpHub } from "../mcp/hub.js";
import type { CompressionRegistry } from "../compress/index.js";
import type { CodeoidConfig } from "../../config.js";
import type { SessionProvider } from "./interface.js";
import { ClaudeProvider } from "./claude/index.js";
import { GeminiProvider } from "./gemini/index.js";
import { OpenAIProvider } from "./openai/index.js";
import { PiProvider } from "./pi/index.js";
import { PI_INSTALL_HINT, resolvePiCommand } from "./pi/resolve.js";
import { CodexProvider } from "./codex/index.js";
import { CODEX_INSTALL_HINT, resolveCodexCommand } from "./codex/resolve.js";
import { GeminiAcpProvider } from "./acp/index.js";
import { GEMINI_CLI_INSTALL_HINT, resolveGeminiCliCommand } from "./acp/resolve.js";
import { QwenProvider } from "./qwen/index.js";
import { StatelessSessionProvider } from "./stateless.js";

/**
 * Everything a factory may need to construct a provider for ONE session.
 * A superset across backends — each factory picks what it uses (the shape
 * mirrors `ClaudeProviderInit`, the most demanding consumer).
 */
export interface ProviderSessionInit {
  sessionId: string;
  /** Tenant-scoped memory workspace id (computed once by Session). */
  workspaceId: string;
  /** Resolved model id for this session, or null for the provider default. */
  model: string | null;
  /** Persisted backing id from Store, or the session id itself on first run. */
  initialBackingId: string;
  store: Store;
  identityManager?: AgentIdentityManager;
  memory?: MemoryEngine;
  /** Shared in-daemon memory MCP endpoint + URL — mounted by URL-based backends
   *  (gemini-cli, later codex). Present only when memory is enabled. */
  memoryMcp?: MemoryMcpMount;
  /** Role-scoped goal-blackboard mount, resolved lazily — see the provider
   *  inits for why it is a getter and not a value. */
  blackboardMcp?: () => { url: string; token: string } | undefined;
  /** Cross-backend MCP registry — the servers to mount on this session's backend. */
  mcpRegistry?: McpRegistry;
  /** Daemon-owned MCP client pool backing the registry (Model-B backends execute
   *  external tool calls through it; Model-A backends mount servers natively). */
  mcpHub?: McpHub;
  /** codeoid_fleet MCP server — conductor sessions only. */
  fleet?: McpSdkServerConfigWithInstance;
  config?: CodeoidConfig;
  compressionRegistry?: CompressionRegistry;
  /** Live model-catalog report, already tagged with the factory's id by Session. */
  onModels?: (
    models: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ) => void;
}

export interface ProviderFactory {
  /** Stable provider id ("claude" | "gemini" | "openai" | ...). */
  readonly id: string;
  readonly displayName: string;
  create(init: ProviderSessionInit): SessionProvider;
}

export class ProviderRegistry {
  readonly #factories = new Map<string, ProviderFactory>();
  /**
   * Backends codeoid supports but could not activate at startup (binary
   * missing, etc.) — id → actionable hint. Lets `session.set_provider`
   * answer "supported but not installed, here's how" instead of a bare
   * "unknown provider".
   */
  readonly #unavailable = new Map<string, string>();
  /** Id used when a session doesn't carry a provider selection. */
  readonly defaultId: string;

  constructor(defaultId = "claude") {
    this.defaultId = defaultId;
  }

  register(factory: ProviderFactory): void {
    if (this.#factories.has(factory.id)) {
      throw new Error(`Provider "${factory.id}" is already registered`);
    }
    this.#factories.set(factory.id, factory);
  }

  has(id: string): boolean {
    return this.#factories.has(id);
  }

  /** Record a supported-but-unactivatable backend with an actionable hint. */
  markUnavailable(id: string, hint: string): void {
    this.#unavailable.set(id, hint);
  }

  /** Hint for a supported backend that isn't activated, if any. */
  unavailableHint(id: string): string | undefined {
    return this.#unavailable.get(id);
  }

  /** All supported-but-unactivated backends (startup diagnostics). */
  unavailableEntries(): Array<{ id: string; hint: string }> {
    return [...this.#unavailable.entries()].map(([id, hint]) => ({ id, hint }));
  }

  get(id: string): ProviderFactory | undefined {
    return this.#factories.get(id);
  }

  getOrThrow(id: string): ProviderFactory {
    const f = this.#factories.get(id);
    if (!f) {
      throw new Error(
        `Provider "${id}" not found. Registered: ${[...this.#factories.keys()].join(", ")}`,
      );
    }
    return f;
  }

  list(): ProviderFactory[] {
    return [...this.#factories.values()];
  }

  ids(): string[] {
    return [...this.#factories.keys()];
  }

  /**
   * Resolve a session's provider selection to a factory. Unknown ids warn
   * and fall back to the default rather than throw — resume must survive a
   * session meta written by a newer codeoid that knew more providers.
   */
  resolve(id: string | undefined, logContext: string): ProviderFactory {
    const requested = id ?? this.defaultId;
    const factory = this.#factories.get(requested);
    if (factory) return factory;
    console.warn(
      `[codeoid/${logContext}] unknown provider "${requested}" — falling back to ${this.defaultId}`,
    );
    return this.getOrThrow(this.defaultId);
  }
}

/**
 * The built-in backends. Daemon startup builds exactly one of these.
 * `config` gates optional backends (pi can be disabled) and carries their
 * settings (binary path); absent = every backend with defaults.
 */
export function createDefaultProviderRegistry(config?: CodeoidConfig): ProviderRegistry {
  const registry = new ProviderRegistry("claude");
  registry.register({
    id: "claude",
    displayName: "Claude (Anthropic)",
    create: (init) =>
      new ClaudeProvider({
        sessionId: init.sessionId,
        initialBackingId: init.initialBackingId,
        workspaceId: init.workspaceId,
        store: init.store,
        identityManager: init.identityManager,
        memory: init.memory,
        fleet: init.fleet,
        blackboardMcp: init.blackboardMcp,
        mcpRegistry: init.mcpRegistry,
        config: init.config,
        compressionRegistry: init.compressionRegistry,
        onModels: init.onModels,
      }),
  });
  // Stateless API backends: usable only with their key in the environment
  // (the daemon loads ~/.codeoid/.env into process.env at startup). Gate
  // registration on the key so a backend that would 401 on its first turn
  // isn't advertised as pickable — same contract as the pi/codex/gemini-cli
  // binary checks below. Without this, forking onto e.g. openai created a
  // session that failed cryptically ("401 Incorrect API key: missing")
  // instead of the option simply not appearing.
  if (process.env.GOOGLE_API_KEY) {
    registry.register({
      id: "gemini",
      displayName: "Gemini (Google)",
      create: (init) =>
        new StatelessSessionProvider(
          new GeminiProvider({
            defaultModel: init.model ?? undefined,
            memory: init.memory,
            workspaceId: init.workspaceId,
            sessionId: init.sessionId,
            mcpRegistry: init.mcpRegistry,
            mcpHub: init.mcpHub,
          }),
          init.sessionId,
        ),
    });
  } else {
    registry.markUnavailable(
      "gemini",
      "GOOGLE_API_KEY is not set — add it to ~/.codeoid/.env to use the Gemini backend",
    );
  }
  if (process.env.OPENAI_API_KEY) {
    registry.register({
      id: "openai",
      displayName: "OpenAI",
      create: (init) =>
        new StatelessSessionProvider(
          new OpenAIProvider({
            defaultModel: init.model ?? undefined,
            memory: init.memory,
            workspaceId: init.workspaceId,
            sessionId: init.sessionId,
            mcpRegistry: init.mcpRegistry,
            mcpHub: init.mcpHub,
          }),
          init.sessionId,
        ),
    });
  } else {
    registry.markUnavailable(
      "openai",
      "OPENAI_API_KEY is not set — add it to ~/.codeoid/.env to use the OpenAI backend",
    );
  }
  if (config?.providers?.pi?.enabled !== false) {
    // Resolve once at startup: explicit config command → system PATH →
    // the bundled optionalDependency (see pi/resolve.ts). A verified
    // resolution means picking pi can't fail on a missing binary; no
    // resolution means the catalog says "not installed" with the fix.
    const configured = config?.providers?.pi?.command;
    const resolution = resolvePiCommand(configured === "pi" ? undefined : configured);
    if (resolution) {
      registry.register({
        id: "pi",
        displayName: "pi (pi.dev)",
        create: (init) =>
          new PiProvider({
            sessionId: init.sessionId,
            initialBackingId: init.initialBackingId,
            command: resolution.command,
            argsPrefix: resolution.argsPrefix,
            store: init.store,
            workspaceId: init.workspaceId,
            memory: init.memory,
            mcpRegistry: init.mcpRegistry,
            mcpHub: init.mcpHub,
            onModels: init.onModels,
          }),
      });
    } else {
      registry.markUnavailable(
        "pi",
        configured !== undefined && configured !== "pi"
          ? `providers.pi.command (${JSON.stringify(configured)}) does not exist or is not on PATH`
          : PI_INSTALL_HINT,
      );
    }
  }
  if (config?.providers?.codex?.enabled !== false) {
    const configured = config?.providers?.codex?.command;
    const resolution = resolveCodexCommand(configured === "codex" ? undefined : configured);
    if (resolution) {
      registry.register({
        id: "codex",
        displayName: "Codex (OpenAI)",
        create: (init) =>
          new CodexProvider({
            sessionId: init.sessionId,
            initialBackingId: init.initialBackingId,
            command: resolution.command,
            argsPrefix: resolution.argsPrefix,
            store: init.store,
            workspaceId: init.workspaceId,
            memoryMcp: init.memoryMcp,
            blackboardMcp: init.blackboardMcp,
            mcpRegistry: init.mcpRegistry,
            onModels: init.onModels,
          }),
      });
    } else {
      registry.markUnavailable(
        "codex",
        configured !== undefined && configured !== "codex"
          ? `providers.codex.command (${JSON.stringify(configured)}) does not exist or is not on PATH`
          : CODEX_INSTALL_HINT,
      );
    }
  }
  if (config?.providers?.geminiCli?.enabled !== false) {
    const configured = config?.providers?.geminiCli?.command;
    const resolution = resolveGeminiCliCommand(configured === "gemini" ? undefined : configured);
    if (resolution) {
      registry.register({
        id: "gemini-cli",
        displayName: "Gemini CLI (Google)",
        create: (init) =>
          new GeminiAcpProvider({
            sessionId: init.sessionId,
            initialBackingId: init.initialBackingId,
            command: resolution.command,
            argsPrefix: resolution.argsPrefix,
            store: init.store,
            workspaceId: init.workspaceId,
            memoryMcp: init.memoryMcp,
            blackboardMcp: init.blackboardMcp,
            mcpRegistry: init.mcpRegistry,
            onModels: init.onModels,
          }),
      });
    } else {
      registry.markUnavailable(
        "gemini-cli",
        configured !== undefined && configured !== "gemini"
          ? `providers.geminiCli.command (${JSON.stringify(configured)}) does not exist or is not on PATH`
          : GEMINI_CLI_INSTALL_HINT,
      );
    }
  }
  if (config?.providers?.qwen?.enabled !== false) {
    // No binary probe: @qwen-code/sdk bundles the CLI it drives, so the backend
    // is always activatable (same reasoning as the bundled gemini-cli, minus the
    // PATH lookup). Auth is checked at first turn, not at registration —
    // `qwen-oauth` credentials and `OPENAI_API_KEY` are both late-bound, and a
    // subscription user has neither set in the daemon env.
    registry.register({
      id: "qwen",
      displayName: "Qwen Code (Alibaba)",
      create: (init) =>
        new QwenProvider({
          sessionId: init.sessionId,
          initialBackingId: init.initialBackingId,
          workspaceId: init.workspaceId,
          store: init.store,
          memory: init.memory,
          fleet: init.fleet as { type: "sdk"; name: string; instance: unknown } | undefined,
          mcpRegistry: init.mcpRegistry,
          config: init.config,
          onModels: init.onModels,
        }),
    });
  }
  return registry;
}
