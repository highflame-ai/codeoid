/**
 * The settings manifest — codeoid's single, declarative description of every
 * user-tunable knob. The daemon serves it over `settings.schema`; the web,
 * TUI, and (later) mobile clients render it generically. Adding a knob is one
 * entry here, picked up by every frontend — no per-client edits.
 *
 * Backing stores (both hand-editable directly, which is the point):
 *   - `config` fields → `~/.codeoid/config.json`, validated by the zod schema
 *     in `src/config.ts` (that schema stays the authoritative validator; the
 *     `default`/`min`/`max` here are display hints only).
 *   - `env` fields → `~/.codeoid/.env` (`KEY=value`). All SECRETS are env-backed
 *     so a secret never lands in config.json through the UI.
 *
 * `key` is the stable client-facing id: the dotted config path for config
 * fields, the env-var name for env fields. `store.ts` maps a key back to its
 * field via `fieldByKey`.
 */

import type { SettingField, SettingsManifest, SettingsTab } from "../../protocol/types.js";

/** Bump when the manifest SHAPE changes (fields added/removed/retyped). */
export const MANIFEST_VERSION = 1;

// ── Field builders — keep the tab tables terse ────────────────────────────────

/** A config.json-backed field. `key` defaults to the dotted path. */
function cfg(path: string, label: string, help: string, extra: Partial<SettingField> = {}): SettingField {
  return { key: path, path, label, help, kind: "string", backing: "config", applies: "restart", ...extra };
}

/** A `.env`-backed field. `key` is the env-var name. */
function env(envVar: string, label: string, help: string, extra: Partial<SettingField> = {}): SettingField {
  return { key: envVar, envVar, label, help, kind: "string", backing: "env", applies: "restart", ...extra };
}

/** An env-backed secret (value never echoed to a client). */
function secret(envVar: string, label: string, help: string, extra: Partial<SettingField> = {}): SettingField {
  return { key: envVar, envVar, label, help, kind: "secret", backing: "env", secret: true, applies: "restart", ...extra };
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const general: SettingsTab = {
  id: "general",
  title: "General",
  icon: "⚙",
  description: "Daemon-wide defaults applied to every session.",
  groups: [
    {
      id: "session",
      title: "Session defaults",
      description: "Applied when a new session is created.",
      fields: [
        cfg("session.defaultModel", "Default model", "Model for new sessions — an alias (opus / sonnet / haiku) or a full model id.", {
          envVar: "CODEOID_DEFAULT_MODEL",
          placeholder: "opus",
        }),
        cfg("session.fallbackModel", "Fallback model", "Retried automatically on a 429/529 from the primary model (Claude only). Alias or full id.", {
          envVar: "CODEOID_FALLBACK_MODEL",
        }),
        cfg("session.turnStallTimeoutMs", "Turn stall timeout (ms)", "Force-recover a turn whose model stream goes silent this long. 0 disables the watchdog.", {
          kind: "int",
          envVar: "CODEOID_TURN_STALL_TIMEOUT_MS",
          min: 0,
          default: 300000,
        }),
        cfg("session.mcpToolTimeoutMs", "MCP tool timeout (ms)", "Per-call timeout for external MCP servers. Must be below the stall timeout. 0 uses the SDK default.", {
          kind: "int",
          envVar: "CODEOID_MCP_TOOL_TIMEOUT_MS",
          min: 0,
          default: 120000,
        }),
        cfg("session.attachTailBytes", "Attach tail (bytes)", "History replayed on attach for paging clients; older scrollback is paged on demand.", {
          kind: "int",
          min: 1024,
          default: 524288,
          advanced: true,
        }),
      ],
    },
    {
      id: "auto-rotate",
      title: "Auto-rotation",
      description: "Proactively roll the backing session over before it hits the context ceiling (lossless — history stays in memory/recall).",
      fields: [
        cfg("autoRotate.enabled", "Enable auto-rotation", "Soft-rotate the session as it approaches the context window.", {
          kind: "boolean",
          envVar: "CODEOID_AUTO_ROTATE",
          default: false,
        }),
        cfg("autoRotate.warnPct", "Warn threshold", "Context occupancy (0–1) at which to warn. Below this, no action.", {
          kind: "float",
          envVar: "CODEOID_AUTO_ROTATE_WARN_PCT",
          min: 0,
          max: 1,
          default: 0.75,
          advanced: true,
        }),
        cfg("autoRotate.rotatePct", "Rotate threshold", "Occupancy (0–1) that triggers a soft rotation (only when enabled).", {
          kind: "float",
          envVar: "CODEOID_AUTO_ROTATE_PCT",
          min: 0,
          max: 1,
          default: 0.9,
        }),
        cfg("autoRotate.hardRotatePct", "Hard rotate ceiling", "Occupancy (0–1) that rotates regardless of the enabled toggle — a safety net.", {
          kind: "float",
          envVar: "CODEOID_AUTO_ROTATE_HARD_PCT",
          min: 0,
          max: 1,
          default: 0.97,
          advanced: true,
        }),
        cfg("autoRotate.minTurnsBeforeRotate", "Min turns before rotate", "Never rotate within the first N turns — the seed prompt matters.", {
          kind: "int",
          envVar: "CODEOID_AUTO_ROTATE_MIN_TURNS",
          min: 0,
          default: 5,
          advanced: true,
        }),
      ],
    },
    {
      id: "display",
      title: "Display",
      fields: [
        cfg("telemetry.osc8", "Terminal hyperlinks (OSC-8)", "Emit clickable OSC-8 hyperlinks in terminal output.", {
          kind: "enum",
          envVar: "CODEOID_OSC8",
          default: "auto",
          options: [
            { value: "auto", label: "Auto", description: "Detect terminal support." },
            { value: "force", label: "Always" },
            { value: "disable", label: "Never" },
          ],
        }),
      ],
    },
    {
      id: "fork",
      title: "Fork",
      fields: [
        cfg("fork.setup", "Fork setup command", "Shell command run once in a fresh fork worktree to make it buildable (e.g. `bun install`).", {
          placeholder: "bun install",
        }),
      ],
    },
  ],
};

const memory: SettingsTab = {
  id: "memory",
  title: "Memory & Context",
  icon: "🧠",
  description: "The verbatim episodic store, its in-context index, and how history crosses backends.",
  groups: [
    {
      id: "episodic",
      title: "Episodic memory",
      fields: [
        cfg("memory.enabled", "Enable memory", "Store episodes and expose recall tools to every backend.", {
          kind: "boolean",
          envVar: "CODEOID_MEMORY",
          default: true,
        }),
        cfg("memory.dbPath", "Memory database path", "SQLite file holding the episodic store. Relative paths resolve under the config dir.", {
          envVar: "CODEOID_MEMORY_DB_PATH",
          default: "memory.db",
          advanced: true,
        }),
        cfg("memory.model", "Embedding model", "Hugging Face model id used for episode embeddings.", {
          envVar: "CODEOID_MEMORY_MODEL",
          placeholder: "Xenova/bge-small-en-v1.5",
          advanced: true,
        }),
        cfg("memory.modelCacheDir", "Model cache dir", "Where embedding weights are cached.", {
          envVar: "CODEOID_MEMORY_CACHE_DIR",
          default: "models",
          advanced: true,
        }),
        cfg("memory.clusters.enabled", "Episode clustering", "Cluster episodes for higher-level recall (experimental).", {
          kind: "boolean",
          envVar: "CODEOID_MEMORY_CLUSTERS",
          default: false,
          advanced: true,
        }),
      ],
    },
    {
      id: "workspace-index",
      title: "Workspace index",
      description: "The always-in-context pointer to the verbatim store.",
      fields: [
        cfg("workspaceIndex.enabled", "Enable workspace index", "Keep a compact, always-in-context index of recent episodes.", {
          kind: "boolean",
          envVar: "CODEOID_WORKSPACE_INDEX",
          default: true,
        }),
        cfg("workspaceIndex.episodeThreshold", "Reindex after N episodes", "Rebuild the index once this many new episodes accumulate.", {
          kind: "int",
          envVar: "CODEOID_WORKSPACE_INDEX_EPISODE_THRESHOLD",
          min: 1,
          default: 5,
          advanced: true,
        }),
        cfg("workspaceIndex.timeThresholdMs", "Reindex interval (ms)", "Maximum time before the index is rebuilt.", {
          kind: "int",
          envVar: "CODEOID_WORKSPACE_INDEX_TIME_MS",
          min: 1,
          default: 60000,
          advanced: true,
        }),
        cfg("workspaceIndex.debounceMs", "Reindex debounce (ms)", "Coalesce bursts of activity before reindexing.", {
          kind: "int",
          envVar: "CODEOID_WORKSPACE_INDEX_DEBOUNCE_MS",
          min: 1,
          default: 15000,
          advanced: true,
        }),
      ],
    },
    {
      id: "context-strategy",
      title: "Cross-backend context",
      description: "How a session's history is handed to a backend on switch / fork / rotate.",
      fields: [
        env("CODEOID_CONTEXT_STRATEGY", "Context strategy", "`transcript` re-seeds a text transcript (classic). `vws` seeds a compact session map + lets the backend page the verbatim store on demand (lossless, context-light).", {
          kind: "enum",
          default: "transcript",
          applies: "next-session",
          options: [
            { value: "transcript", label: "Transcript", description: "Front-load a text transcript." },
            { value: "vws", label: "Verbatim Working Set", description: "Compact map + demand-paging." },
          ],
        }),
        env("CODEOID_SEED_BUDGET_CHARS", "Seed budget (chars)", "Hard cap on transcript-seed characters. Empty = computed from the target model's window.", {
          kind: "int",
          min: 0,
          advanced: true,
          applies: "next-session",
        }),
      ],
    },
    {
      id: "compress",
      title: "Output compression",
      description: "Homegrown CLI-output compressor (disabled by default).",
      fields: [
        cfg("compress.enabled", "Enable compression", "Compress large command output before it enters the context.", {
          kind: "boolean",
          envVar: "CODEOID_COMPRESS",
          default: false,
        }),
        cfg("compress.minBytes", "Minimum size (bytes)", "Skip compression for output smaller than this.", {
          kind: "int",
          envVar: "CODEOID_COMPRESS_MIN_BYTES",
          min: 0,
          default: 1024,
          advanced: true,
        }),
        cfg("compress.compressPipes", "Compress piped output", "Also compress output from piped commands.", {
          kind: "boolean",
          envVar: "CODEOID_COMPRESS_PIPES",
          default: false,
          advanced: true,
        }),
        cfg("compress.excludeCommands", "Never compress commands", "Command names whose output is always kept verbatim.", {
          kind: "string[]",
          envVar: "CODEOID_COMPRESS_EXCLUDE",
          advanced: true,
        }),
        cfg("compress.excludePatterns", "Never compress patterns", "Output patterns that are always kept verbatim.", {
          kind: "string[]",
          envVar: "CODEOID_COMPRESS_EXCLUDE_PATTERNS",
          advanced: true,
        }),
      ],
    },
  ],
};

const fleet: SettingsTab = {
  id: "fleet",
  title: "Fleet & Dispatch",
  icon: "🚦",
  description: "The per-tenant conductor supervisor and the send-class work queue.",
  groups: [
    {
      id: "conductor",
      title: "Conductor",
      fields: [
        cfg("conductor.enabled", "Enable conductor", "Run the per-tenant fleet-supervisor session.", { kind: "boolean", default: true }),
        cfg("conductor.name", "Conductor name", "Display name / `attach conductor` target.", { default: "conductor", advanced: true }),
        cfg("conductor.provider", "Conductor provider", "Backend that drives the conductor (fleet tools currently work only under `claude`).", { default: "claude" }),
        cfg("conductor.model", "Conductor model", "Model override for the conductor. Empty = the provider default.", { advanced: true }),
      ],
    },
    {
      id: "dispatch",
      title: "Dispatch queue",
      description: "Send-class fleet actions run through a durable work queue.",
      fields: [
        cfg("dispatch.enabled", "Enable dispatch", "Allow the conductor to enqueue send-class fleet work.", {
          kind: "boolean",
          envVar: "CODEOID_DISPATCH_ENABLED",
          default: true,
        }),
        cfg("dispatch.maxConcurrentWorkers", "Max concurrent workers", "Most spawned workers running at once, per tenant.", { kind: "int", min: 1, default: 2 }),
        cfg("dispatch.workerToolBudget", "Worker tool budget", "Autonomous tool-call budget per spawned worker.", { kind: "int", min: 1, default: 50 }),
        cfg("dispatch.failureLimit", "Failure limit", "Consecutive failures before a task auto-blocks.", { kind: "int", min: 1, default: 2, advanced: true }),
        cfg("dispatch.tickMs", "Tick interval (ms)", "Dispatcher claim/reclaim/deliver cadence.", { kind: "int", min: 250, default: 5000, advanced: true }),
        cfg("dispatch.leaseMs", "Claim lease (ms)", "An unrenewed claim past this is reclaimed.", { kind: "int", min: 10000, default: 600000, advanced: true }),
        cfg("dispatch.retryBaseMs", "Retry backoff base (ms)", "Base backoff for retryable failures — doubles per attempt.", { kind: "int", min: 0, default: 15000, advanced: true }),
      ],
    },
  ],
};

// ── Per-backend tabs (one per supported backend) ──────────────────────────────

const claude: SettingsTab = {
  id: "claude",
  title: "Claude",
  icon: "✳",
  description: "The default in-process backend (Anthropic SDK). Always enabled. Sign in with your Claude subscription, or set an API key.",
  groups: [
    {
      id: "claude-auth",
      title: "Authentication",
      description: "Sign in above to use a Claude subscription — no key to paste. A key is only needed instead of signing in, or for cluster labeling.",
      fields: [
        // Written by "Sign in with Claude", not typed. It is still a manifest
        // field (and so still hand-editable, clearable, and visible as set)
        // because a credential the UI can create but not show or revoke is a
        // credential nobody can reason about. `next-session`, not `restart`:
        // the store updates process.env live and each Claude turn builds its
        // subprocess env fresh, so the next session picks it up.
        secret("CLAUDE_CODE_OAUTH_TOKEN", "Claude subscription token", "Set by “Sign in with Claude”. A long-lived token from your Claude subscription, used instead of an API key.", {
          applies: "next-session",
        }),
        secret("ANTHROPIC_API_KEY", "Anthropic API key", "Used by the Claude backend when not signed in, and for cluster labeling."),
        env("CLAUDE_CODE_USE_BEDROCK", "Use Amazon Bedrock", "Route Claude through Amazon Bedrock (requires AWS credentials in the environment).", {
          kind: "boolean",
          default: false,
          advanced: true,
        }),
      ],
    },
  ],
};

const codex: SettingsTab = {
  id: "codex",
  title: "Codex",
  icon: "▲",
  description: "OpenAI Codex CLI over app-server. Credentials come from `~/.codex/auth.json`.",
  groups: [
    {
      id: "codex-provider",
      title: "Backend",
      fields: [
        cfg("providers.codex.enabled", "Enable Codex", "Register the codex backend in the provider catalog.", { kind: "boolean", default: true }),
        cfg("providers.codex.command", "Codex command", "Binary to spawn — a wrapper script or absolute path.", { default: "codex", advanced: true }),
      ],
    },
    {
      id: "codex-policy",
      title: "Approval & sandbox",
      description: "Defaults for Codex's native gates. The session mode still drives these unless you pin a value here.",
      fields: [
        env("CODEX_APPROVAL_POLICY", "Approval policy", "When Codex asks before acting. Default is derived from the session mode (autonomous → never).", {
          kind: "enum",
          applies: "next-session",
          options: [
            { value: "untrusted", label: "Untrusted", description: "Ask for anything not trusted." },
            { value: "on-request", label: "On request" },
            { value: "never", label: "Never", description: "Autonomous." },
          ],
        }),
        env("CODEX_SANDBOX_POLICY", "Sandbox policy", "Filesystem/network sandbox Codex runs under. codeoid pins full access by default (it is the trust authority).", {
          kind: "enum",
          default: "danger-full-access",
          advanced: true,
          applies: "next-session",
          options: [
            { value: "read-only", label: "Read only" },
            { value: "workspace-write", label: "Workspace write" },
            { value: "danger-full-access", label: "Full access" },
          ],
        }),
      ],
    },
  ],
};

const geminiCli: SettingsTab = {
  id: "gemini-cli",
  title: "Gemini CLI",
  icon: "◆",
  description: "Google gemini-cli over ACP (streaming + tools). Auth: a Gemini API key or Vertex — a consumer Google subscription can't be used.",
  groups: [
    {
      id: "gemini-cli-provider",
      title: "Backend",
      fields: [
        cfg("providers.geminiCli.enabled", "Enable Gemini CLI", "Register the gemini-cli backend in the provider catalog.", { kind: "boolean", default: true }),
        cfg("providers.geminiCli.command", "Gemini command", "Binary to spawn — a wrapper script or absolute path.", { default: "gemini", advanced: true }),
      ],
    },
  ],
};

const pi: SettingsTab = {
  id: "pi",
  title: "pi",
  icon: "π",
  description: "The pi coding agent over RPC. Credentials come from `~/.pi/agent/auth.json`.",
  groups: [
    {
      id: "pi-provider",
      title: "Backend",
      fields: [
        cfg("providers.pi.enabled", "Enable pi", "Register the pi backend in the provider catalog.", { kind: "boolean", default: true }),
        cfg("providers.pi.command", "pi command", "Binary to spawn — a wrapper script or absolute path.", { default: "pi", advanced: true }),
        env("PI_CONFIG_DIR", "pi config dir", "Override pi's config/credential directory.", { advanced: true }),
      ],
    },
  ],
};

const openai: SettingsTab = {
  id: "openai",
  title: "OpenAI",
  icon: "○",
  description: "Stateless in-daemon OpenAI backend. Registered only when an API key is present.",
  groups: [
    {
      id: "openai-auth",
      title: "Authentication",
      fields: [secret("OPENAI_API_KEY", "OpenAI API key", "Enables the openai backend and is used for its API calls.")],
    },
  ],
};

const gemini: SettingsTab = {
  id: "gemini",
  title: "Gemini",
  icon: "✦",
  description: "Stateless in-daemon Google Gemini backend. Registered only when an API key is present.",
  groups: [
    {
      id: "gemini-auth",
      title: "Authentication",
      fields: [secret("GOOGLE_API_KEY", "Google API key", "Enables the gemini backend. GEMINI_API_KEY is also accepted.")],
    },
  ],
};

const identity: SettingsTab = {
  id: "identity",
  title: "Identity & Auth",
  icon: "🔐",
  description: "ZeroID issuer, tenant identity, and browser sign-in.",
  groups: [
    {
      id: "zeroid",
      title: "ZeroID",
      fields: [
        cfg("zeroidUrl", "ZeroID URL", "Auth issuer — a preset (`highflame`, `highflame-dev`, `local`) or any URL.", {
          envVar: "ZEROID_URL",
          default: "highflame",
        }),
        secret("CODEOID_API_KEY", "ZeroID API key", "API key (`zid_sk_…`) exchanged for a session token."),
        cfg("auth.issuer", "Expected issuer", "Override the expected JWT `iss` claim. Empty = derived from the ZeroID URL.", {
          envVar: "ZEROID_ISSUER",
          advanced: true,
        }),
        cfg("auth.audience", "Expected audience", "Override the expected JWT audience claim.", { envVar: "ZEROID_AUDIENCE", advanced: true }),
      ],
    },
    {
      id: "tenant",
      title: "Agent identity (multi-tenant)",
      fields: [
        cfg("agentIdentity.accountId", "Account ID", "ZeroID tenant account for agent-identity registration.", {
          envVar: "ZEROID_ACCOUNT_ID",
          default: "personal",
        }),
        cfg("agentIdentity.projectId", "Project ID", "ZeroID tenant project.", { envVar: "ZEROID_PROJECT_ID", default: "dev" }),
      ],
    },
    {
      id: "oauth",
      title: "Browser sign-in (OAuth)",
      description: "Google OAuth authorization server — populated only when both client id and secret are set.",
      fields: [
        cfg("oauth.clientId", "OAuth client id", "Client id advertised by the built-in authorization server.", {
          envVar: "CODEOID_OAUTH_CLIENT_ID",
          default: "codeoid",
          advanced: true,
        }),
        secret("GOOGLE_CLIENT_ID", "Google client id", "Google OAuth client id (with the secret, enables browser sign-in).", { advanced: true }),
        secret("GOOGLE_CLIENT_SECRET", "Google client secret", "Google OAuth client secret.", { advanced: true }),
      ],
    },
  ],
};

const frontends: SettingsTab = {
  id: "frontends",
  title: "Frontends",
  icon: "📱",
  description: "Clients that connect to this daemon.",
  groups: [
    {
      id: "telegram",
      title: "Telegram",
      description: "Set a bot token and an allowlist to run the Telegram frontend.",
      fields: [
        secret("TELEGRAM_BOT_TOKEN", "Bot token", "BotFather token that enables the Telegram frontend."),
        env("TELEGRAM_ALLOWED_USER_IDS", "Allowed user ids", "Numeric Telegram user ids permitted to use the bot (required with a token).", {
          kind: "string[]",
        }),
      ],
    },
    {
      id: "web",
      title: "Web",
      fields: [
        env("CODEOID_FS_BROWSE_ROOT", "File-browser root", "Root directory the web file picker is allowed to browse. Defaults to your home directory.", {}),
        cfg("embed.allowedOrigins", "Embed SSO allowed origins", "Parent origins (scheme://host[:port]) permitted to frame the web UI and pre-authenticate it via the URL-hash handoff. Empty = the hash handoff is disabled (safe default).", {
          kind: "string[]",
          envVar: "CODEOID_EMBED_ALLOWED_ORIGINS",
        }),
      ],
    },
  ],
};

const hooks: SettingsTab = {
  id: "hooks",
  title: "Hooks",
  icon: "🪝",
  description: "Daemon-native lifecycle hooks. Individual hook entries are edited directly in config.json.",
  groups: [
    {
      id: "hooks-master",
      title: "Hooks",
      fields: [
        cfg("hooks.enabled", "Enable hooks", "Master switch for all configured hooks.", {
          kind: "boolean",
          envVar: "CODEOID_HOOKS_ENABLED",
          default: true,
        }),
      ],
    },
    {
      id: "subprocess-env",
      title: "Subprocess environment",
      fields: [
        env("CODEOID_AGENT_ENV_ALLOW", "Extra env passthrough", "Additional environment variable names passed into every backend subprocess (escape hatch).", {
          kind: "string[]",
          advanced: true,
        }),
      ],
    },
  ],
};

export const SETTINGS_MANIFEST: SettingsManifest = {
  version: MANIFEST_VERSION,
  tabs: [general, memory, fleet, claude, codex, geminiCli, pi, openai, gemini, identity, frontends, hooks],
};

// ── Derived accessors ─────────────────────────────────────────────────────────

let flatCache: SettingField[] | null = null;

/** Every field across every tab/group, flattened. */
export function manifestFields(): SettingField[] {
  if (!flatCache) {
    flatCache = SETTINGS_MANIFEST.tabs.flatMap((t) => t.groups.flatMap((g) => g.fields));
  }
  return flatCache;
}

/** Look up a field by its client-facing `key`. */
export function fieldByKey(key: string): SettingField | undefined {
  return manifestFields().find((f) => f.key === key);
}
