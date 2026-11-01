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

import type { ResolvedClaudeAccount } from "../claude-accounts.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store.js";
import type { AgentIdentityManager } from "../agent-identity.js";
import type { MemoryEngine } from "../memory/index.js";
import type { MemoryMcpMount } from "../memory/mcp-http.js";
import type { McpServerView } from "../mcp/registry.js";
import type { McpHub } from "../mcp/hub.js";
import type { McpTenant } from "../mcp/oauth.js";
import type { CompressionRegistry } from "../compress/index.js";
import type { CodeoidConfig } from "../../config.js";
import type { SessionProvider, CatalogEntry } from "./interface.js";
import { CLAUDE_PROVIDER_ID } from "../models.js";
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
import { OPENCODE_DISPLAY_NAME, OPENCODE_PROVIDER_ID, OpencodeProvider } from "./opencode/index.js";
import { opencodeCredentialInputs } from "./opencode/credentials.js";
import { OPENCODE_INSTALL_HINT, opencodeDataDir, opencodeDbPath, opencodeLocationsFile, opencodeRefusedPaths, resolveOpencodeCommand } from "./opencode/resolve.js";
import { OpencodeServer } from "./opencode/server.js";
import { SCRIPTED_ENV, SCRIPTED_PROVIDER_ID, ScriptedProvider } from "./scripted/index.js";
import { StatelessSessionProvider } from "./stateless.js";
import { LLAMACPP_DISPLAY_NAME, LLAMACPP_PROVIDER_ID, createLlamaCppProvider } from "./llamacpp/index.js";
import type { EndpointStore } from "../openai-endpoints.js";
import { AccountError, type AccountStore, type ResolvedAccount } from "../accounts.js";
import { type EndpointCatalog, syncEndpointProviders } from "./endpoint/index.js";
import { registerSecretPaths } from "../secret-paths.js";

/**
 * Everything a factory may need to construct a provider for ONE session.
 * A superset across backends — each factory picks what it uses (the shape
 * mirrors `ClaudeProviderInit`, the most demanding consumer).
 */
export interface ProviderSessionInit {
  sessionId: string;
  /** Tenant-scoped memory workspace id (computed once by Session). */
  workspaceId: string;
  /** The session's tenant — whose credentials an OAuth MCP server uses. */
  tenant?: McpTenant;
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
  mcpRegistry?: McpServerView;
  /** Daemon-owned MCP client pool backing the registry (Model-B backends execute
   *  external tool calls through it; Model-A backends mount servers natively). */
  mcpHub?: McpHub;
  /** codeoid_fleet MCP server — conductor sessions only. */
  fleet?: McpSdkServerConfigWithInstance;
  /** codeoid_loop MCP server (`loop_report`) — loop worker sessions only. */
  loop?: McpSdkServerConfigWithInstance;
  config?: CodeoidConfig;
  compressionRegistry?: CompressionRegistry;
  /** Live model-catalog report, already tagged with the factory's id by Session. */
  onModels?: (models: ReadonlyArray<CatalogEntry>) => void;
  /** The session's Claude account, resolved per query — Claude backend only (claude-accounts.ts). */
  resolveClaudeAccount?: () => ResolvedClaudeAccount | null;
  /**
   * The session's account for THIS backend, resolved now (accounts.ts); null
   * = the daemon's own credential. Throws when the chosen account can't be
   * used — a provider surfaces that as the turn's error, never falls back.
   * HTTP backends call it per turn; process backends when they spawn.
   */
  resolveAccount?: () => ResolvedAccount | null;
  /**
   * Caller-supplied env for the backend's child process (SessionCreateOptions
   * .extraEnv), merged last via `withExtraEnv` (env.ts), which never lets it
   * override a credential / account-isolation variable. Honored by every
   * process-backed provider — claude, codex, gemini-cli, pi, qwen. In-process
   * backends (openai, gemini, llama.cpp, user endpoints) spawn nothing, so it
   * has no effect there.
   */
  extraEnv?: Readonly<Record<string, string>>;
  /**
   * When this session is a fork, the moment it began (ISO; fork-isolation.ts),
   * read each time the backend is started. Background work recorded before it
   * is the parent's. Claude only (CLAUDE_CODE_RESUME_SOURCE_ALIVE).
   */
  forkBoundary?: () => string | undefined;
  /**
   * When this session is a fork: whether an agent id is one of its parent's
   * agents (fork-isolation.ts), read on every tool call. Claude only: its
   * PreToolUse hook denies such an agent's every call, the ones the CLI
   * approves itself included.
   */
  isForeignAgent?: (agentId: string) => boolean;
  /**
   * When this session is a fork: whether a task id is one of its parent's
   * (fork-isolation.ts). Claude only: a native fork's copy of the parent's
   * cloud-agent registrations is cleared by it.
   */
  isForeignTask?: (taskId: string) => boolean;
  /** Whether this session is a fork (fork-isolation.ts), read on every tool call. */
  isFork?: () => boolean;
  /**
   * Whether a task id is one of this session's own, as its level showed it
   * (Session#isOwnTask). Claude only: on a fork a stop-task call may name
   * only one of these, or a teammate of its own team.
   */
  isOwnTask?: (taskId: string) => boolean;
  /** One of the parent's agents had a tool call denied (for the scrollback; the provider audits it). */
  onForeignAgentDenied?: (agentId: string, toolName: string) => void;
}

/** An HTTP backend's key from the session's account (accounts.ts), or null for the daemon's own. */
function accountKey(init: ProviderSessionInit): { key: string; fingerprint: string } | null {
  const account = init.resolveAccount?.() ?? null;
  return account ? { key: account.account.token ?? "", fingerprint: account.fingerprint } : null;
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

  constructor(defaultId = CLAUDE_PROVIDER_ID) {
    this.defaultId = defaultId;
  }

  /**
   * Builds a factory for an id that is not registered but belongs to a family
   * whose members come and go at runtime (user-defined endpoints, `oai:*`).
   * Consulted by `resolve` only — `has` stays strict, so nothing new can be
   * created on an id that isn't registered.
   */
  #prefixResolver: ((id: string) => ProviderFactory | undefined) | null = null;
  /** What building this registry changed outside it (the gate's credential paths), undone by {@link dispose}. */
  readonly #cleanups: Array<() => void> = [];

  /** Undo, when the registry is let go, what building it changed elsewhere. */
  onDispose(cleanup: () => void): void {
    this.#cleanups.push(cleanup);
  }

  /**
   * Let the registry go: the credential paths it registered for the gate are
   * dropped (a test's daemon built under /tmp would otherwise leave every
   * later session judging /tmp to hold credentials). Idempotent.
   */
  dispose(): void {
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
  }

  register(factory: ProviderFactory): void {
    if (this.#factories.has(factory.id)) {
      throw new Error(`Provider "${factory.id}" is already registered`);
    }
    this.#factories.set(factory.id, factory);
    // Registered after startup (it gained accounts): no longer "unavailable".
    this.#unavailable.delete(factory.id);
  }

  /**
   * Remove a factory (a user-defined endpoint was removed). Sessions already
   * built from it keep their provider instance; whether that instance still
   * works is the factory's business (endpoint providers refuse to run).
   */
  unregister(id: string): boolean {
    if (id === this.defaultId) throw new Error(`Provider "${id}" is the default and can't be removed`);
    return this.#factories.delete(id);
  }

  /** Swap a registered factory for one with the same id (a re-labelled endpoint) — the default included. */
  replace(factory: ProviderFactory): void {
    if (!this.#factories.has(factory.id)) throw new Error(`Provider "${factory.id}" is not registered`);
    this.#factories.set(factory.id, factory);
  }

  setPrefixResolver(resolver: (id: string) => ProviderFactory | undefined): void {
    this.#prefixResolver = resolver;
  }

  /**
   * Can a session that ran on `id` be rebuilt on it — registered now, or a
   * member of a runtime family (a removed endpoint, which then refuses to
   * run with its own message instead of the session being moved elsewhere)?
   */
  resolvable(id: string): boolean {
    return this.#factories.has(id) || this.#prefixResolver?.(id) !== undefined;
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
    const factory = this.#factories.get(requested) ?? this.#prefixResolver?.(requested);
    if (factory) return factory;
    console.warn(
      `[codeoid/${logContext}] unknown provider "${requested}" — falling back to ${this.defaultId}`,
    );
    return this.getOrThrow(this.defaultId);
  }
}

/**
 * A `session.defaultProvider` the daemon cannot honour. Its own class so the
 * CLI can print it as the operator's config mistake it is — one line, exit 1
 * — without also swallowing the stack trace of a genuine startup bug.
 */
export class DefaultProviderError extends Error {
  override name = "DefaultProviderError";
}

/**
 * Why `id` cannot be this daemon's default backend, or undefined when it can.
 *
 * Shared by startup (`createDefaultProviderRegistry`) and the settings write
 * path, so a value the settings UI accepts is exactly a value the next boot
 * accepts. A backend codeoid supports but could not activate (binary missing,
 * no API key) gets its actionable hint; anything else is a typo or a backend
 * disabled under `providers.<id>.enabled`.
 */
export function defaultProviderProblem(registry: ProviderRegistry, id: string): string | undefined {
  if (registry.has(id)) return undefined;
  // JSON-quoted: the value is caller-supplied on the settings path, and a
  // quoted string can't smuggle a newline into a log line.
  const quoted = JSON.stringify(id);
  const hint = registry.unavailableHint(id);
  if (hint) return `session.defaultProvider ${quoted} is not available on this daemon: ${hint}`;
  const toggle = ENABLE_KEY[id];
  const fix = toggle ? `It is disabled — set providers.${toggle}.enabled to true.` : "Check the spelling.";
  return `session.defaultProvider ${quoted} is not a registered backend (registered: ${registry.ids().join(", ")}). ${fix}`;
}

/** Backend id → its `providers.<key>.enabled` switch, for the ones that have one. */
const ENABLE_KEY: Record<string, string> = {
  pi: "pi",
  codex: "codex",
  "gemini-cli": "geminiCli",
  qwen: "qwen",
  llamacpp: "llamacpp",
  opencode: "opencode",
};

/**
 * The built-in backends. Daemon startup builds exactly one of these.
 * `config` gates optional backends (pi can be disabled) and carries their
 * settings (binary path); absent = every backend with defaults.
 *
 * `config.session.defaultProvider` picks the default backend and is checked
 * once every backend has registered. It THROWS rather than warns: unlike
 * `resolve()`'s fallback — which exists so resume survives a session written
 * by a newer codeoid — a misspelled default is operator error, and falling
 * back would silently put every new session on a backend they opted out of.
 */
/** HTTP backends that need a key: one in the environment, or a named account. */
const KEYED_BACKENDS = [
  {
    id: "gemini",
    displayName: "Gemini (Google)",
    envKey: "GOOGLE_API_KEY",
    missing: "GOOGLE_API_KEY is not set — add it to ~/.codeoid/.env, or add a Gemini account, to use the Gemini backend",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    envKey: "OPENAI_API_KEY",
    missing: "OPENAI_API_KEY is not set — add it to ~/.codeoid/.env, or add an OpenAI account, to use the OpenAI backend",
  },
] as const;

function hasAccounts(accounts: AccountStore | undefined, backend: string): boolean {
  try {
    return (accounts?.list(backend).length ?? 0) > 0;
  } catch {
    return false; // an unreadable accounts file: no accounts to offer
  }
}

/**
 * A keyed backend's key for one turn: the session's account, else the
 * environment's. Neither = a clear refusal, not a 401 from the vendor.
 */
function keyFor(init: ProviderSessionInit, backend: (typeof KEYED_BACKENDS)[number], env: Record<string, string | undefined>) {
  const account = accountKey(init);
  if (account) return account;
  if (!env[backend.envKey]) {
    throw new AccountError(`the ${backend.id} backend has no key of its own (${backend.envKey}) — choose an account for this session, or set a default ${backend.id} account`);
  }
  return null;
}

function keyedFactory(backend: (typeof KEYED_BACKENDS)[number], env: Record<string, string | undefined>): ProviderFactory {
  const common = (init: ProviderSessionInit) => ({
    defaultModel: init.model ?? undefined,
    resolveApiKey: () => keyFor(init, backend, env),
    memory: init.memory,
    workspaceId: init.workspaceId,
    tenant: init.tenant,
    sessionId: init.sessionId,
    mcpRegistry: init.mcpRegistry,
    mcpHub: init.mcpHub,
  });
  return {
    id: backend.id,
    displayName: backend.displayName,
    create: (init) =>
      new StatelessSessionProvider(backend.id === "gemini" ? new GeminiProvider(common(init)) : new OpenAIProvider(common(init)), init.sessionId),
  };
}

/**
 * Register a keyed backend that has gained accounts since startup (accounts
 * are added while the daemon runs). Never unregisters: sessions may be on it.
 * Returns whether anything changed.
 */
export function registerAccountBackends(registry: ProviderRegistry, accounts: AccountStore, env: Record<string, string | undefined> = process.env): boolean {
  let changed = false;
  for (const backend of KEYED_BACKENDS) {
    if (!registry.has(backend.id) && hasAccounts(accounts, backend.id)) {
      registry.register(keyedFactory(backend, env));
      changed = true;
    }
  }
  return changed;
}

export function createDefaultProviderRegistry(
  config?: CodeoidConfig,
  /** Where backend keys and binary PATH lookups are read. A parameter so the
   *  settings path can dry-run the NEXT boot's registry without touching the
   *  live process env. */
  env: Record<string, string | undefined> = process.env,
  /** User-defined endpoints to register (openai-endpoints.ts). */
  endpoints?: { store: EndpointStore; catalog: EndpointCatalog },
  /** Named accounts: a keyed backend with accounts is registered without an environment key. */
  accounts?: AccountStore,
  /** `preview`: only checking what the next boot would build (a settings write): nothing is registered with the live daemon's gate. */
  options: { preview?: boolean } = {},
): ProviderRegistry {
  const registry = new ProviderRegistry(config?.session?.defaultProvider ?? CLAUDE_PROVIDER_ID);
  registry.register({
    id: "claude",
    displayName: "Claude (Anthropic)",
    create: (init) =>
      new ClaudeProvider({
        sessionId: init.sessionId,
        initialBackingId: init.initialBackingId,
        workspaceId: init.workspaceId,
        tenant: init.tenant,
        store: init.store,
        identityManager: init.identityManager,
        memory: init.memory,
        fleet: init.fleet,
        loop: init.loop,
        blackboardMcp: init.blackboardMcp,
        mcpRegistry: init.mcpRegistry,
        mcpHub: init.mcpHub,
        config: init.config,
        compressionRegistry: init.compressionRegistry,
        onModels: init.onModels,
        resolveAccount: init.resolveClaudeAccount,
        extraEnv: init.extraEnv,
        forkBoundary: init.forkBoundary,
        isForeignAgent: init.isForeignAgent,
        isForeignTask: init.isForeignTask,
        isFork: init.isFork,
        isOwnTask: init.isOwnTask,
        onForeignAgentDenied: init.onForeignAgentDenied,
      }),
  });
  // Stateless API backends: usable only with a key — in the environment (the
  // daemon loads ~/.codeoid/.env into process.env at startup) or as a named
  // account (accounts.ts). Gate registration on one so a backend that would
  // 401 on its first turn isn't advertised as pickable — same contract as the
  // pi/codex/gemini-cli binary checks below. Without this, forking onto e.g.
  // openai created a session that failed cryptically ("401 Incorrect API key:
  // missing") instead of the option simply not appearing.
  for (const backend of KEYED_BACKENDS) {
    if (env[backend.envKey] || hasAccounts(accounts, backend.id)) registry.register(keyedFactory(backend, env));
    else registry.markUnavailable(backend.id, backend.missing);
  }
  // A local OpenAI-compatible server (llama.cpp's `llama-server`) — a
  // distinct id from "openai" so it runs alongside a cloud gateway there
  // instead of replacing it. Opt-in: there's no startup-time way to tell
  // whether something is actually listening at `baseUrl`.
  const llamacpp = config?.providers?.llamacpp;
  if (llamacpp?.enabled) {
    registry.register({
      id: LLAMACPP_PROVIDER_ID,
      displayName: LLAMACPP_DISPLAY_NAME,
      create: (init) =>
        new StatelessSessionProvider(
          createLlamaCppProvider(llamacpp, {
            defaultModel: init.model ?? undefined,
            resolveApiKey: () => accountKey(init),
            memory: init.memory,
            workspaceId: init.workspaceId,
            tenant: init.tenant,
            sessionId: init.sessionId,
            mcpRegistry: init.mcpRegistry,
            mcpHub: init.mcpHub,
          }),
          init.sessionId,
        ),
    });
  }
  if (config?.providers?.pi?.enabled !== false) {
    // Resolve once at startup: explicit config command → system PATH →
    // the bundled optionalDependency (see pi/resolve.ts). A verified
    // resolution means picking pi can't fail on a missing binary; no
    // resolution means the catalog says "not installed" with the fix.
    const configured = config?.providers?.pi?.command;
    const resolution = resolvePiCommand(configured === "pi" ? undefined : configured, env);
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
            tenant: init.tenant,
            memory: init.memory,
            mcpRegistry: init.mcpRegistry,
            mcpHub: init.mcpHub,
            onModels: init.onModels,
            resolveAccount: init.resolveAccount,
            extraEnv: init.extraEnv,
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
    const resolution = resolveCodexCommand(configured === "codex" ? undefined : configured, env);
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
            tenant: init.tenant,
            memoryMcp: init.memoryMcp,
            mcpProxy: init.mcpHub?.proxy ?? undefined,
            blackboardMcp: init.blackboardMcp,
            mcpRegistry: init.mcpRegistry,
            onModels: init.onModels,
            resolveAccount: init.resolveAccount,
            extraEnv: init.extraEnv,
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
    const resolution = resolveGeminiCliCommand(configured === "gemini" ? undefined : configured, env);
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
            tenant: init.tenant,
            memoryMcp: init.memoryMcp,
            mcpProxy: init.mcpHub?.proxy ?? undefined,
            blackboardMcp: init.blackboardMcp,
            mcpRegistry: init.mcpRegistry,
            onModels: init.onModels,
            resolveAccount: init.resolveAccount,
            extraEnv: init.extraEnv,
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
          tenant: init.tenant,
          store: init.store,
          memory: init.memory,
          fleet: init.fleet as { type: "sdk"; name: string; instance: unknown } | undefined,
          mcpProxy: init.mcpHub?.proxy ?? undefined,
          mcpRegistry: init.mcpRegistry,
          config: init.config,
          onModels: init.onModels,
          resolveAccount: init.resolveAccount,
          extraEnv: init.extraEnv,
        }),
    });
  }
  // opencode's credential files and database (stored sign-ins) are refused to
  // every backend's file tools, as codeoid's own are: registered whether or
  // not opencode is enabled or found, since both outlive the daemon that
  // wrote them, and at the default and recorded locations too (a moved dbPath
  // leaves them). So are the server's config, data, state and cache dirs: a
  // plugin written to its config dir runs in the server at once. Not for a
  // preview: the live daemon's gate isn't its to change.
  if (!options.preview) registry.onDispose(registerSecretPaths(opencodeRefusedPaths(config)));
  if (config?.providers?.opencode?.enabled !== false) {
    const configured = config?.providers?.opencode?.command;
    const resolution = resolveOpencodeCommand(configured === "opencode" ? undefined : configured, env);
    if (resolution) {
      // ONE server for every opencode session of this daemon, started by the
      // first one's first turn (opencode/server.ts). A server reporting a
      // version outside the supported range takes the backend off the
      // catalog, with the reason as its hint.
      const dbPath = opencodeDbPath(config);
      let server: OpencodeServer | null = null;
      const shared = (store: Store): OpencodeServer => {
        server ??= new OpencodeServer({
          command: resolution.command,
          argsPrefix: resolution.argsPrefix,
          dbPath,
          locationsFile: opencodeLocationsFile(config),
          dataDir: opencodeDataDir(config),
          // The server's cwd leads to none of these (opencodeServerCwd).
          codeoidPaths: [config?.dbPath, config?.transcriptDir].filter((p): p is string => typeof p === "string"),
          defaultModel: config?.providers?.opencode?.model,
          // codeoid's keys reach opencode through its config, from files; read at each server start.
          credentials: () =>
            opencodeCredentialInputs(config, env, {
              qwenCatalog: () => store.getModelCatalog("qwen"),
              // The Qwen backend's own default account, as its sessions resolve it.
              qwenAccount: accounts ? () => accounts.resolve("qwen", null) : undefined,
              endpoints: () => endpoints?.store.entries() ?? [],
            }),
          onIncompatible: (hint) => {
            // The default backend stays registered: its sessions keep failing with the hint instead.
            if (registry.has(OPENCODE_PROVIDER_ID) && registry.defaultId !== OPENCODE_PROVIDER_ID) registry.unregister(OPENCODE_PROVIDER_ID);
            registry.markUnavailable(OPENCODE_PROVIDER_ID, hint);
          },
        });
        return server;
      };
      registry.register({
        id: OPENCODE_PROVIDER_ID,
        displayName: OPENCODE_DISPLAY_NAME,
        create: (init) =>
          new OpencodeProvider({
            sessionId: init.sessionId,
            initialBackingId: init.initialBackingId,
            server: shared(init.store),
            store: init.store,
            workspaceId: init.workspaceId,
            tenant: init.tenant,
            memoryMcp: init.memoryMcp,
            mcpProxy: init.mcpHub?.proxy ?? undefined,
            blackboardMcp: init.blackboardMcp,
            mcpRegistry: init.mcpRegistry,
            onModels: init.onModels,
            agent: config?.providers?.opencode?.agent,
            modelPrices: () => config?.pricing?.models,
          }),
      });
    } else {
      registry.markUnavailable(
        OPENCODE_PROVIDER_ID,
        configured !== undefined && configured !== "opencode"
          ? `providers.opencode.command (${JSON.stringify(configured)}) does not exist or is not on PATH`
          : OPENCODE_INSTALL_HINT,
      );
    }
  }
  // The end-to-end suite's scripted backend (#429): only when a test names a
  // script, so a normal install never offers it.
  const script = env[SCRIPTED_ENV];
  if (script) {
    registry.register({
      id: SCRIPTED_PROVIDER_ID,
      displayName: "Scripted (end-to-end tests)",
      create: (init) => new StatelessSessionProvider(new ScriptedProvider(script), init.sessionId),
    });
  }
  // User-defined OpenAI-compatible endpoints (`oai:<name>`) — registered
  // before the default check, so one of them can be the default backend.
  if (endpoints) {
    try {
      syncEndpointProviders(registry, endpoints.store, endpoints.catalog);
    } catch (err) {
      console.error(`[codeoid] could not load endpoints: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const problem = defaultProviderProblem(registry, registry.defaultId);
  if (problem) throw new DefaultProviderError(problem);
  return registry;
}
