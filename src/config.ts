/**
 * Configuration loader — layered precedence: CLI flag > env var > config file > defaults.
 *
 * Single source of truth for daemon + client behavior. File lives at
 * `~/.codeoid/config.json` (or `$XDG_CONFIG_HOME/codeoid/config.json` if set)
 * and is validated through zod on load. Malformed files fail loudly so a
 * subtle typo doesn't silently change runtime.
 *
 * Design goals:
 *   1. Backwards compatible — old config.json files (just `apiKey`) still work.
 *   2. Every field has an env-var override (for Docker / CI / per-invocation tweaks).
 *   3. Paths with ~ or relative get normalized to absolute before return.
 *   4. Zero process.env reads outside this module — downstream code reads
 *      the parsed config, not env vars, so we can mock cleanly in tests.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { AuthConfig } from "./daemon/auth.js";
import type { OAuthConfig } from "./daemon/oauth.js";
import {
  LOCAL_TOKEN_ENV,
  localTokenFilename,
  readLocalTokenFile,
} from "./daemon/local-auth.js";
import { HOOK_EVENTS, type HookEntryConfig } from "./daemon/hooks/types.js";
// The per-goal child cap, so the tenant-wide bound below can refuse to be set
// below it rather than silently contradicting it. No cycle: collaboration.ts
// reaches only protocol types, models.ts, and blackboard/{types,service}.ts.
import { MAX_COLLABORATION_CHILDREN } from "./daemon/collaboration.js";
// One published bound for model-id strings (wire schemas + config maps agree).
import { LIMITS } from "./protocol/types.js";

// ── Paths ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_DIR = join(homedir(), ".codeoid");

/** Resolve the config directory honoring XDG_CONFIG_HOME if set. */
export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "codeoid");
  return DEFAULT_CONFIG_DIR;
}

/**
 * Where a local-mode daemon on `port` publishes its token for local clients.
 * Port-scoped so two local daemons never share (or delete) each other's
 * credential — see `localTokenFilename`.
 */
export function getLocalTokenPath(port: number | string): string {
  return join(getConfigDir(), localTokenFilename(port));
}

/** Default daemon port, used when a daemon URL carries no explicit one. */
const DEFAULT_DAEMON_PORT = "7400";

/**
 * The port a client will dial, from its configured daemon URL. Falls back to
 * codeoid's default port when the URL omits one (`ws://host/`), which is what
 * the connection itself would do. Returns null only for an unparseable URL.
 */
export function daemonPortFromUrl(daemonUrl: string): string | null {
  try {
    const port = new URL(daemonUrl).port;
    return port.length > 0 ? port : DEFAULT_DAEMON_PORT;
  } catch {
    return null;
  }
}

/**
 * The local-mode token to present to the daemon at `daemonUrl`, or null.
 *
 * Precedence, and the reasoning behind it:
 *   1. `CODEOID_LOCAL_TOKEN` — an explicit, per-invocation decision.
 *   2. the token file published for THAT daemon's port — written by
 *      `codeoid start --local` and removed on its shutdown, so its presence
 *      means "a local-mode daemon is listening on this port right now". That
 *      makes it a stronger signal than a durable `apiKey` in config.json, which
 *      says nothing about the daemon currently listening. Clients therefore
 *      prefer it, and someone who ran `--local` once for a demo doesn't have to
 *      unwind their config to go back to ZeroID (or vice versa).
 *
 * Keyed by port so a second local daemon (or a ZeroID daemon) elsewhere on the
 * machine can neither hijack nor invalidate this lookup.
 */
export function resolveLocalToken(
  daemonUrl: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const fromEnv = env[LOCAL_TOKEN_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const port = daemonPortFromUrl(daemonUrl);
  if (!port) return null;
  return readLocalTokenFile(getLocalTokenPath(port));
}

/**
 * Load `~/.codeoid/.env` (or `$XDG_CONFIG_HOME/codeoid/.env`) into process.env.
 *
 * This is the durable home for env-only secrets the daemon needs at launch —
 * notably TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_IDS, which aren't in
 * config.json. Co-located with config.json + the db, it's cwd-independent (a
 * restart from any directory picks it up) and never lives in the git tree.
 *
 * Precedence is preserved: a variable already set in the real environment
 * WINS over the file, so an explicit `TELEGRAM_BOT_TOKEN=… codeoid start`
 * still overrides. Returns the names of the keys it populated (for logging;
 * values are never logged).
 *
 * Format: `KEY=value` per line; `#` comments and blank lines ignored;
 * optional surrounding single/double quotes are stripped. Intentionally
 * minimal — not a full dotenv dialect (no interpolation, no multiline).
 */
export function loadDotEnv(): string[] {
  const envPath = join(getConfigDir(), ".env");
  if (!existsSync(envPath)) return [];
  const loaded: string[] = [];
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return [];
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Real environment wins — file is the fallback, not an override.
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/** Expand a leading `~` to $HOME; leaves absolute paths untouched. */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

// ── ZeroID issuer presets ──────────────────────────────────────────────────

/**
 * Friendly aliases for the ZeroID issuer so the common cases are a single
 * word instead of a URL. The shipped default is the Highflame SaaS issuer
 * (`highflame`) — sign up at highflame.ai, mint a key in Studio's Code Agents
 * screen, and `codeoid login` works with zero further config. Self-hosters set
 * `ZEROID_URL` to their own deployment's URL (anything with a scheme is used
 * verbatim). `highflame-dev` targets our internal dev environment.
 *
 * For every ZeroID deployment the JWT `iss` claim equals the base URL, so we
 * can pin the expected issuer from this value (see `loadConfig`).
 */
export const ZEROID_PRESETS: Readonly<Record<string, string>> = {
  highflame: "https://auth.highflame.ai",
  "highflame-dev": "https://auth-dev.highflame.dev",
  local: "http://localhost:8899",
};

/**
 * Resolve a `zeroidUrl` config value to a concrete base URL:
 *   - a known preset name → its URL
 *   - anything containing a scheme → used verbatim (trailing slash trimmed)
 *   - a bare host (`zeroid.mycorp.com`) → assumed https://
 */
export function resolveZeroidUrl(value: string): string {
  const v = value.trim();
  const preset = ZEROID_PRESETS[v];
  if (preset) return preset;
  const stripped = v.replace(/\/+$/, "");
  if (stripped.includes("://")) return stripped;
  return `https://${stripped}`;
}


// ── Schema ───────────────────────────────────────────────────────────────

/**
 * Zod schema for the config file. Keep this permissive — unknown fields are
 * passed through so future additions don't break older loaders. Required
 * fields are minimal (nothing) — defaults cover everything.
 */
const CompressSchema = z
  .object({
    enabled: z.boolean().default(false),
    excludeCommands: z.array(z.string()).default([]),
    excludePatterns: z.array(z.string()).default([]),
    compressPipes: z.boolean().default(false),
    /** Byte threshold below which compression is skipped (already small). */
    minBytes: z.number().int().nonnegative().default(1024),
  })
  .default({
    enabled: false,
    excludeCommands: [],
    excludePatterns: [],
    compressPipes: false,
    minBytes: 1024,
  });

/**
 * Advisory guards (docs/prior-art-deepseek-harness.md §3.7). These observe the
 * session and may inject model-facing advice; none of them can block a call.
 * On by default — the guard is cheap, and the failure it catches (an unattended
 * worker looping on one tool until its budget is gone) is expensive.
 */
const GuardSchema = z
  .object({
    repeatTool: z
      .object({
        enabled: z.boolean().default(true),
        /** Consecutive-run lengths that trigger a reminder. Each must be >= 2. */
        thresholds: z.array(z.number().int().min(2)).nonempty().default([3, 5, 8]),
        /** Tool-name patterns to track (`*` wildcard). Empty ⇒ all tools. */
        include: z.array(z.string()).default([]),
        /** Tool-name patterns transparent to the chain. */
        exclude: z.array(z.string()).default(["TodoWrite", "todo_write"]),
        /** Cap on arguments quoted in the reminder — never on detection. */
        argumentsPreviewChars: z.number().int().positive().default(500),
      })
      .default({
        enabled: true,
        thresholds: [3, 5, 8],
        include: [],
        exclude: ["TodoWrite", "todo_write"],
        argumentsPreviewChars: 500,
      }),
  })
  .default({
    repeatTool: {
      enabled: true,
      thresholds: [3, 5, 8],
      include: [],
      exclude: ["TodoWrite", "todo_write"],
      argumentsPreviewChars: 500,
    },
  });

const WorkspaceIndexSchema = z
  .object({
    enabled: z.boolean().default(true),
    episodeThreshold: z.number().int().positive().default(5),
    timeThresholdMs: z.number().int().positive().default(60_000),
    debounceMs: z.number().int().positive().default(15_000),
  })
  .default({
    enabled: true,
    episodeThreshold: 5,
    timeThresholdMs: 60_000,
    debounceMs: 15_000,
  });

const MemoryClustersSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({ enabled: false });

const MemorySchema = z
  .object({
    enabled: z.boolean().default(true),
    dbPath: z.string().default("memory.db"),
    model: z.string().optional(),
    modelCacheDir: z.string().default("models"),
    clusters: MemoryClustersSchema,
  })
  .default({
    enabled: true,
    dbPath: "memory.db",
    modelCacheDir: "models",
    clusters: { enabled: false },
  });

const LabelingSchema = z
  .object({
    anthropicApiKey: z.string().optional(),
  })
  .default({});

const TelemetrySchema = z
  .object({
    osc8: z.enum(["auto", "force", "disable"]).default("auto"),
  })
  .default({ osc8: "auto" });

/**
 * Auto-rotation: proactively roll over Claude Code's backing session when
 * the context window gets close to the compaction ceiling. Codeoid's
 * verbatim memory + recall tools mean we can hand off to a fresh context
 * losslessly — the agent just calls `recall` when it needs prior detail.
 *
 * Thresholds are fractions of the context window (1.0 = 1M tokens). Pick
 * sane defaults; users can tune via config or env.
 */
/**
 * Per-session model defaults. `defaultModel` is used on session creation;
 * `fallbackModel` is handed to the SDK's `fallbackModel` option so a 429
 * or 529 transparently retries with a cheaper/less-loaded model instead of
 * failing the turn. Both accept aliases (`opus`/`sonnet`/`haiku`) or full
 * Anthropic model ids.
 */
const SessionSchema = z
  .object({
    defaultModel: z.string().optional(),
    fallbackModel: z.string().optional(),
    /**
     * Hard backstop against a wedged turn. If the provider event stream goes
     * completely silent (no events at all) for this many ms while the MODEL
     * should be producing output (status "thinking"), the turn is treated as
     * stalled: the run is torn down, the subprocess reaped, status reset to
     * idle, and a clear message shown.
     *
     * The watchdog PAUSES whenever silence is legitimate: during tool
     * execution (a multi-minute Bash run, Task subagents, web research emit
     * NO events until they complete) and while a manual approval is pending.
     * Hung tools are covered by finer mechanisms instead — mcpToolTimeoutMs
     * for MCP calls, the SDK's own per-tool timeouts, stream closure on a
     * dead subprocess, and user interrupt.
     * Set to 0 to disable the watchdog.
     */
    turnStallTimeoutMs: z.number().min(0).default(300_000),
    /**
     * Per-call wall-clock timeout (ms) applied to external (user-configured)
     * MCP servers, surfaced to the SDK as each server's `timeout`. A hung MCP
     * tool call (e.g. an unresponsive HTTP gateway) then returns an SDK error
     * the turn loop can act on, instead of going silent. Kept BELOW
     * turnStallTimeoutMs so it fires first — the stall watchdog stays a coarse
     * last-resort backstop. 0 = don't set (use the SDK default). Does not apply
     * to codeoid's in-process memory server.
     */
    mcpToolTimeoutMs: z.number().min(0).default(120_000),
    /**
     * Tail window (bytes) replayed on attach for `scrollback.paging`
     * clients — enough context to continue instantly; older history is
     * paged on demand. Larger = more context up front, slower first paint
     * on big sessions. Legacy clients always get the full buffer.
     */
    attachTailBytes: z.number().int().min(1024).default(512 * 1024),
  })
  .default({
    turnStallTimeoutMs: 300_000,
    mcpToolTimeoutMs: 120_000,
    attachTailBytes: 512 * 1024,
  })
  // Enforce the "SDK signals first" contract across BOTH fields — not just the
  // defaults. An env override / config file could otherwise set the MCP timeout
  // at or above the stall timeout, so the coarse watchdog would force-recover
  // before the SDK's clean per-tool error fires. Exempt the opt-out cases:
  // turnStallTimeoutMs=0 (watchdog off → nothing to race) and mcpToolTimeoutMs=0
  // (use SDK default → relationship is moot).
  .refine(
    (s) =>
      s.turnStallTimeoutMs === 0 ||
      s.mcpToolTimeoutMs === 0 ||
      s.mcpToolTimeoutMs < s.turnStallTimeoutMs,
    {
      message:
        "must be less than session.turnStallTimeoutMs so a hung MCP call surfaces an SDK error before the stall watchdog fires (set either to 0 to opt out)",
      path: ["mcpToolTimeoutMs"],
    },
  );

const AutoRotateSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Below this, no action. */
    warnPct: z.number().min(0).max(1).default(0.75),
    /**
     * Soft rotate at this occupancy (only when `enabled`). Raised from 0.80
     * → 0.90 after observing that the SDK's per-turn `usage` is the SUM of
     * all internal API calls (primary + subagents + retries). A subagent
     * turn can legitimately report 800k+ while no single API call exceeds
     * 300k — false-positive rotations were firing on otherwise-healthy
     * sessions.
     */
    rotatePct: z.number().min(0).max(1).default(0.9),
    /**
     * Hard ceiling — rotate regardless of `enabled`. Lifted from 0.90 →
     * 0.97 for the same reason. Still a genuine safety net against
     * actual compaction; just less trigger-happy.
     */
    hardRotatePct: z.number().min(0).max(1).default(0.97),
    /** Don't rotate within the first N turns — seed prompt matters. */
    minTurnsBeforeRotate: z.number().int().nonnegative().default(5),
    /** Seed strategy. Only "task-anchor" implemented today (loss-free via recall). */
    strategy: z.enum(["task-anchor"]).default("task-anchor"),
  })
  .default({
    enabled: false,
    warnPct: 0.75,
    rotatePct: 0.9,
    hardRotatePct: 0.97,
    minTurnsBeforeRotate: 5,
    strategy: "task-anchor",
  });

const AgentIdentitySchema = z
  .object({
    accountId: z.string().default("personal"),
    projectId: z.string().default("dev"),
    registrarKey: z.string().optional(),
    identityExpiresAt: z.string().optional(),
  })
  .default({ accountId: "personal", projectId: "dev" });

/**
 * Conductor session — the per-tenant fleet supervisor (docs/conductor-design.md).
 * `provider` selects which backend drives it (any registered provider id, so an
 * open-weight backend can run the conductor once its provider exists); `model`
 * overrides the provider's default. Note: fleet MCP tools currently surface
 * only under the "claude" provider (the one provider with MCP support) — a
 * conductor on another provider still chats but cannot see the fleet yet.
 */
const ConductorSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Display name of the conductor session (also what `codeoid attach conductor` resolves). */
    name: z.string().default("conductor"),
    /** Provider id driving the conductor ("claude" | "gemini" | "openai" | future). */
    provider: z.string().default("claude"),
    /** Model override for the conductor (alias or full id). Empty = provider default. */
    model: z.string().optional(),
  })
  .default({ enabled: true, name: "conductor", provider: "claude" });

const AuthSchemaFields = z
  .object({
    issuer: z.string().optional(),
    audience: z.string().optional(),
  })
  .default({});

const OAuthSchemaFields = z
  .object({
    clientId: z.string().optional(),
  })
  .default({});

/**
 * Dispatch queue (P4) — send-class fleet actions run through a durable
 * SQLite work queue with a dispatcher loop. Workers spawned by the queue run
 * autonomously up to `workerToolBudget` tool calls, then wedge safely (the
 * lease reclaims them).
 */
/**
 * Per-subject session limits. BOTH DEFAULT TO 0 = UNLIMITED.
 *
 * codeoid's normal shape is one operator driving many parallel worktrees, and a
 * hardcoded cap (this used to be 10 concurrent / 30 per hour, unconfigurable)
 * trips over that — the README's own hero shot runs 12 sessions. The runaway
 * case is bounded where it actually originates instead, by `dispatch`'s
 * maxConcurrentWorkers / workerToolBudget / failureLimit.
 *
 * Kept configurable for a shared multi-user daemon, where a per-subject bound
 * is a reasonable thing to want. See src/daemon/rate-limit.ts.
 */
const RateLimitSchema = z
  .object({
    /** Sessions alive at once per subject. 0 = unlimited. */
    maxSessionsPerUser: z.number().int().min(0).default(0),
    /** Session creations per subject per hour. 0 = unlimited. */
    maxCreationsPerHour: z.number().int().min(0).default(0),
  })
  .default({ maxSessionsPerUser: 0, maxCreationsPerHour: 0 });

const DispatchSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Dispatcher tick interval (ms): claim / reclaim / deliver cadence. */
    tickMs: z.number().int().min(250).default(5_000),
    /** Claim lease (ms) — an unrenewed claim past this is reclaimed (attempts++). */
    leaseMs: z.number().int().min(10_000).default(10 * 60_000),
    /** Consecutive failures (incl. reclaims) before a task auto-blocks. */
    failureLimit: z.number().int().min(1).default(2),
    /** Max concurrently running spawned workers per tenant. */
    maxConcurrentWorkers: z.number().int().min(1).default(2),
    /** Autonomous tool-call budget per spawned worker. */
    workerToolBudget: z.number().int().min(1).default(50),
    /** Base retry backoff (ms) for retryable failures — doubles per attempt, capped at leaseMs. */
    retryBaseMs: z.number().int().min(0).default(15_000),
  })
  .default({
    enabled: true,
    tickMs: 5_000,
    leaseMs: 10 * 60_000,
    failureLimit: 2,
    maxConcurrentWorkers: 2,
    workerToolBudget: 50,
    retryBaseMs: 15_000,
  });

/**
 * Collaborative-session bounds (docs/collaborative-session-design.md §11 P3).
 *
 * `MAX_COLLABORATION_CHILDREN` already caps ONE goal at 12. Nothing capped the
 * number of goals, and role-children are long-lived `send`-driven sessions
 * rather than `kind:"spawn"` dispatch tasks — so `dispatch.maxConcurrentWorkers`
 * (which counts spawn tasks) never saw them. Ten collaborations meant 120 live
 * autonomous agents with no bound anywhere, since `rateLimit` defaults to
 * unlimited by design.
 *
 * This is the tenant-wide backstop for that. It is a BLAST-RADIUS bound, not a
 * scheduler: it refuses a create that would cross the line, and never queues,
 * throttles, or kills anything already running.
 */
const CollaborationSchema = z
  .object({
    /**
     * Live role-children allowed at once per tenant, across every goal.
     * 0 = unlimited (same opt-out convention as `rateLimit`).
     *
     * Floor of 12 is deliberate: a lower value would reject a single
     * max-size collaboration that `MAX_COLLABORATION_CHILDREN` permits, so the
     * two bounds would contradict each other. The default of 24 is exactly two
     * full-size fleets — enough that the normal case never notices, low enough
     * that a runaway is caught early.
     */
    maxLiveChildren: z
      .number()
      .int()
      .min(0)
      .refine((n) => n === 0 || n >= MAX_COLLABORATION_CHILDREN, {
        message: `collaboration.maxLiveChildren must be 0 (unlimited) or at least ${MAX_COLLABORATION_CHILDREN}, or it would reject a single max-size collaboration`,
      })
      .default(24),
  })
  .default({ maxLiveChildren: 24 });

/**
 * Daemon-native hooks (docs/hooks.md) — config-declared commands/webhooks
 * dispatched at Session's seams (tool_call, tool_result, before_turn,
 * after_turn, lifecycle) uniformly across every backend. Matcher regexes
 * are validated here so a typo fails loudly at load, not silently at
 * dispatch.
 */
const HookEntrySchema = z
  .object({
    event: z.enum(HOOK_EVENTS),
    matcher: z.string().optional(),
    type: z.enum(["command", "webhook"]),
    command: z.string().optional(),
    url: z.string().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    name: z.string().optional(),
  })
  .refine((e) => e.type !== "command" || (e.command !== undefined && e.command.length > 0), {
    message: 'hooks of type "command" require a non-empty `command`',
    path: ["command"],
  })
  .refine((e) => e.type !== "webhook" || (e.url !== undefined && e.url.length > 0), {
    message: 'hooks of type "webhook" require a non-empty `url`',
    path: ["url"],
  })
  .refine(
    (e) => {
      if (e.matcher === undefined) return true;
      try {
        new RegExp(e.matcher);
        return true;
      } catch {
        return false;
      }
    },
    { message: "`matcher` must be a valid regular expression", path: ["matcher"] },
  );

const HooksSchema = z
  .object({
    enabled: z.boolean().default(true),
    entries: z.array(HookEntrySchema).default([]),
  })
  .default({ enabled: true, entries: [] });

/**
 * Embed trust — origins allowed to frame the web UI and pre-authenticate it via
 * the URL-hash credential handoff (embed SSO). This is the allowlist the web UI
 * enforces with a fail-closed trusted-framing-origin gate: a hash-delivered
 * credential is honored ONLY when the page is embedded by one of these origins
 * (exact `scheme://host[:port]` match). Empty (the default) ⇒ NO origin is
 * trusted ⇒ the hash handoff is effectively disabled — the safe default that
 * closes the login-CSRF / session-fixation vector for any deploy that hasn't
 * explicitly opted an embedding parent in.
 */
const EmbedSchema = z
  .object({
    allowedOrigins: z.array(z.string()).default([]),
  })
  .default({ allowedOrigins: [] });

/** Per-backend provider settings. Append-only — one optional block per provider. */
const ProvidersSchema = z
  .object({
    /** pi coding agent (https://pi.dev) driven over `pi --mode rpc`. */
    pi: z
      .object({
        /** Register the pi backend in the provider catalog. */
        enabled: z.boolean().default(true),
        /** Binary to spawn — override for a wrapper script or absolute path. */
        command: z.string().default("pi"),
      })
      .default({ enabled: true, command: "pi" }),
    /** OpenAI Codex CLI driven over `codex app-server` (JSON-RPC/stdio). */
    codex: z
      .object({
        /** Register the codex backend in the provider catalog. */
        enabled: z.boolean().default(true),
        /** Binary to spawn — override for a wrapper script or absolute path. */
        command: z.string().default("codex"),
      })
      .default({ enabled: true, command: "codex" }),
    /** Google gemini-cli driven over ACP (`gemini --acp`). */
    geminiCli: z
      .object({
        enabled: z.boolean().default(true),
        command: z.string().default("gemini"),
      })
      .default({ enabled: true, command: "gemini" }),
    /** Alibaba Qwen Code, driven in-process via `@qwen-code/sdk`. */
    qwen: z
      .object({
        enabled: z.boolean().default(true),
        /**
         * Credential path. `openai` = the OpenAI-compatible API-key path
         * (`OPENAI_API_KEY` + `baseUrl`); `qwen-oauth` = a qwen.ai
         * subscription already logged in under `~/.qwen`. Omit to
         * auto-detect: OAuth creds on disk win, else the key.
         */
        authType: z.enum(["openai", "qwen-oauth"]).optional(),
        /**
         * OpenAI-compatible gateway. Accepts a {@link QWEN_BASE_URL_PRESETS}
         * name or a full URL. Omit to let the CLI use its own default (or
         * `OPENAI_BASE_URL` from the environment).
         */
        baseUrl: z.string().optional(),
        /** Default model when the session doesn't pick one (e.g. `qwen3.8-max`). */
        model: z.string().optional(),
        /**
         * Override the CLI the SDK drives. Omit to use the CLI bundled inside
         * `@qwen-code/sdk`, which is the version this provider was tested
         * against — the same posture as the pinned gemini-cli dependency.
         */
        command: z.string().optional(),
      })
      .default({ enabled: true }),
  })
  .default({
    pi: { enabled: true, command: "pi" },
    codex: { enabled: true, command: "codex" },
    geminiCli: { enabled: true, command: "gemini" },
    qwen: { enabled: true },
  });

/**
 * Named Qwen gateways, so an operator never has to discover these by hand.
 *
 * `bailian-plan-*` is the endpoint behind a Model Studio *plan-specific* key
 * (`sk-sp-…`, issued by the Bailian token-plan installer). It is NOT the
 * standard DashScope host — plan keys are rejected there with
 * `invalid_api_key`, which is a confusing failure to debug from scratch.
 */
export const QWEN_BASE_URL_PRESETS: Record<string, string> = {
  "dashscope-intl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "dashscope-cn": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "bailian-plan-intl":
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
};

/** Resolve a `providers.qwen.baseUrl` preset name (or pass a URL through). */
export function resolveQwenBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return QWEN_BASE_URL_PRESETS[value] ?? value;
}

/**
 * A single MCP server in the canonical registry (see
 * docs/provider-mcp-registry-design.md). Declared once here; codeoid mounts it
 * on EVERY backend. Transport is inferred: exactly one of `command` (stdio) or
 * `url` (streamable-HTTP). `codeoid_memory` is a built-in entry and is NOT
 * declarable here.
 */
const McpServerSchema = z
  .object({
    // ── transport (inferred) ──
    /** stdio: launch this command. Mutually exclusive with `url`. */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    /** Subprocess env for a stdio server. A value of the form `${VAR}` is
     *  resolved from the daemon's own environment at mount time so secrets stay
     *  out of the config file. */
    env: z.record(z.string(), z.string()).default({}),
    /** http: streamable-HTTP endpoint. Mutually exclusive with `command`. */
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    /** Env-var NAME the daemon reads the bearer token from (never inline). */
    bearerTokenEnv: z.string().optional(),
    // ── policy ──
    /** `readonly` → auto-approve on every backend (like the memory tools);
     *  `prompt` → always route through the approval gate. */
    trust: z.enum(["readonly", "prompt"]).default("prompt"),
    /** Tenant binding passed at call time. */
    scope: z.enum(["global", "workspace", "session"]).default("workspace"),
    /** Allowlist of tool names surfaced to the model; omit = all. */
    tools: z.array(z.string()).optional(),
    /** Restrict to specific backends (e.g. ["claude","codex"]); omit = all. */
    backends: z.array(z.string()).optional(),
    enabled: z.boolean().default(true),
    /** Escape hatch: sync into the backend's OWN native config instead of
     *  proxying through the daemon (Model-A backends only). Default false. */
    native: z.boolean().default(false),
  })
  .refine((s) => (s.command === undefined) !== (s.url === undefined), {
    message: "an MCP server must set exactly one of `command` (stdio) or `url` (streamable-HTTP)",
  });

const McpServersSchema = z.record(z.string(), McpServerSchema).default({});

/** Raw (validated, pre-normalization) MCP server config as it appears in the
 *  `mcpServers` block. Normalized into an `McpServerSpec` by `McpRegistry`. */
export type RawMcpServerConfig = z.infer<typeof McpServerSchema>;

/**
 * SDLC pipeline (docs/sdlc-pipeline.md). ON by default — a run is user-initiated
 * (nothing starts until `pipeline.create`), halts at every gate, and is already
 * gated by scopes + pack trust, so there's nothing for an off-by-default to
 * protect; keeping it off only adds friction. The flag survives as an operator
 * opt-out (`enabled: false` / `CODEOID_PIPELINE_ENABLED=false`) for hardened /
 * sandbox deployments that want no pipeline runtime at all. When enabled, the
 * daemon builds a PipelineManager sharing its DB and rehydrates non-terminal
 * pipelines on boot. `defaultPack` is the methodology pack a pipeline runs when
 * created without one (null = none / freestyle). `packs` are directories loaded
 * + installed on boot (each a `pack.yaml` dir); `trusted` (default false) lets a
 * pack's `command` gates execute on this host — leave off for fetched packs.
 */
/** One concrete model choice for the pipeline model maps: which backend, and
 *  optionally which model on it (absent = that backend's default). */
const ModelBindingSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(LIMITS.MODEL_MAX).optional(),
});

const PipelineSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultPack: z.string().nullable().default(null),
    /**
     * Operator model maps for per-role model binding (docs/role-model-binding.md
     * §2.2). `modelTiers` maps a pack role's semantic `tier` ("reasoning-max")
     * to a concrete {provider, model} — one edit here upgrades every installed
     * pack when a new model generation ships. `modelRoles` is the surgical
     * per-pack-role override, keyed "<packId>/<roleName>". Both are read ONCE
     * at pipeline create and the resolved binding is persisted per run.
     * Precedence: CLI --role > modelRoles > pack phase pin > role pin >
     * modelTiers > provider default.
     */
    modelTiers: z.record(z.string().min(1).max(64), ModelBindingSchema).default({}),
    // Key = "<packId>/<roleName>" — both ids are ≤64 chars, plus the slash.
    modelRoles: z.record(z.string().min(1).max(129), ModelBindingSchema).default({}),
    packs: z
      .array(
        z.object({
          dir: z.string().min(1),
          trusted: z.boolean().default(false),
          // Provenance: the registry name a pack was installed from (dynamic
          // pack loading — docs/pack-loading.md). Absent for a hand-added dir.
          registry: z.string().optional(),
        }),
      )
      .default([]),
    // Pack registries (git repos laid out like ai-factory: packs/<id>/pack.yaml).
    // codeoid clones each into ~/.codeoid/packs/<name>/ so packs can be
    // discovered + installed at runtime (docs/pack-loading.md).
    registries: z
      .array(
        z.object({
          name: z.string().min(1),
          url: z.string().min(1),
          ref: z.string().optional(),
        }),
      )
      .default([]),
  })
  .default({ enabled: true, defaultPack: null, packs: [], registries: [], modelTiers: {}, modelRoles: {} });

/**
 * Push notifications (docs/push.md). When a session blocks on a tool approval,
 * the daemon sends a CONTENT-BLIND wake-up (an opaque session id only, never
 * tool args) to the configured transport so the session owner's registered
 * devices are alerted off-LAN. `transport: "none"` (default) disables push.
 */
/** APNs token-auth credentials for embedded (`native`) mode. */
const ApnsSchema = z.object({
  keyId: z.string(),
  teamId: z.string(),
  bundleId: z.string(),
  /** PEM contents of the `.p8` key (multi-line — lives in config.json). */
  p8: z.string(),
  /** Use the APNs sandbox host (development builds). */
  sandbox: z.boolean().default(false),
});

/** FCM v1 service-account credentials for embedded (`native`) mode. */
const FcmSchema = z.object({
  projectId: z.string(),
  clientEmail: z.string(),
  /** PEM contents of the service-account private key. */
  privateKey: z.string(),
});

const PushSchema = z
  .object({
    /**
     * Delivery transport:
     *   - "expo"   — Expo's push service relays to APNs/FCM (a third party in
     *     the path; simplest to set up).
     *   - "native" — the daemon holds APNs/FCM creds and sends DIRECTLY (no
     *     third party). Fits when the daemon operator is the app publisher.
     *   - "relay"  — the daemon POSTs a content-blind wake-up to a self-hosted
     *     relay that sends via APNs/FCM (no creds in the daemon).
     *   - "none"   — push disabled (default).
     */
    transport: z.enum(["expo", "native", "relay", "none"]).default("none"),
    /** Expo access token (Bearer) — `expo` transport only. */
    expoAccessToken: z.string().optional(),
    /** APNs creds — `native` transport (iOS). */
    apns: ApnsSchema.optional(),
    /** FCM creds — `native` transport (Android). */
    fcm: FcmSchema.optional(),
    /** Relay base URL + shared bearer token — `relay` transport (no local creds). */
    relayUrl: z.string().optional(),
    relayToken: z.string().optional(),
  })
  .default({ transport: "none" });

const RootSchema = z.object({
  daemonUrl: z.string().default("ws://127.0.0.1:7400"),
  dbPath: z.string().default("codeoid.db"),
  transcriptDir: z.string().default("transcripts"),
  // Default to the Highflame SaaS issuer so a fresh install + a Studio key
  // works with zero config. Accepts a preset name (highflame / highflame-dev /
  // local) or any URL; resolved via resolveZeroidUrl() in loadConfig.
  zeroidUrl: z.string().default("highflame"),
  apiKey: z.string().optional(),
  auth: AuthSchemaFields,
  oauth: OAuthSchemaFields,
  agentIdentity: AgentIdentitySchema,
  memory: MemorySchema,
  workspaceIndex: WorkspaceIndexSchema,
  compress: CompressSchema,
  guard: GuardSchema,
  labeling: LabelingSchema,
  telemetry: TelemetrySchema,
  autoRotate: AutoRotateSchema,
  session: SessionSchema,
  conductor: ConductorSchema,
  dispatch: DispatchSchema,
  collaboration: CollaborationSchema,
  rateLimit: RateLimitSchema,
  pipeline: PipelineSchema,
  providers: ProvidersSchema,
  mcpServers: McpServersSchema,
  hooks: HooksSchema,
  embed: EmbedSchema,
  push: PushSchema,
  fork: z
    .object({
      /** Shell command run once in a freshly-created fork worktree to make it
       *  buildable (e.g. "bun install", "./gradlew assemble", "make setup").
       *  Runs asynchronously; the fork's first turn waits for it. Empty = the
       *  agent bootstraps the worktree itself. */
      setup: z.string().optional(),
    })
    .default({}),
});

type ParsedConfig = z.infer<typeof RootSchema>;

// ── Public types ─────────────────────────────────────────────────────────

/**
 * Flattened, path-resolved config consumed by the daemon + client. Shape is
 * append-only — add new fields here, don't rename existing ones.
 */
export interface CodeoidConfig {
  /** Daemon WebSocket URL. */
  daemonUrl: string;
  /** SQLite database path (absolute). */
  dbPath: string;
  /** Transcript directory (absolute). */
  transcriptDir: string;
  /** ZeroID auth config. */
  auth: AuthConfig;
  /** OAuth authorization server config — only populated when hmacSecret is set. */
  oauth?: OAuthConfig;
  /** ZeroID API key for token exchange (client-side). */
  apiKey?: string;
  /** ZeroID base URL for token exchange. */
  zeroidUrl: string;
  /** ZeroID tenant for agent identity registration. */
  agentIdentity?: {
    accountId: string;
    projectId: string;
    /**
     * ZeroID registrar key (zid_sk_*) that authenticates agent registration.
     * Injected per-sandbox (e.g. by Forge) so the daemon registers REAL
     * identities against a secured ZeroID instead of degrading to anonymous:*.
     * Distinct from apiKey (the human-operator client token).
     */
    registrarKey?: string;
    /**
     * RFC3339 expiry of the identity `registrarKey` belongs to — the sandbox
     * badge, when Forge injected one. Every identity this daemon registers is
     * capped to it, so a child cannot outlive the sandbox that created it
     * (forge#110). Absent outside a sandbox, where there is no such ceiling to
     * inherit and children expire with the session teardown instead.
     */
    identityExpiresAt?: string;
  };
  /** Memory / recall config — when enabled, stores episodes and exposes recall() to Claude. */
  memory?: {
    enabled: boolean;
    dbPath: string;
    model?: string;
    modelCacheDir?: string;
    clusters: { enabled: boolean };
  };
  /** Workspace memory index — always-in-context pointer to verbatim episodes. */
  workspaceIndex: {
    enabled: boolean;
    episodeThreshold: number;
    timeThresholdMs: number;
    debounceMs: number;
  };
  /** Homegrown CLI output compressor (RTK-style). Disabled by default. */
  compress: {
    enabled: boolean;
    excludeCommands: string[];
    excludePatterns: string[];
    compressPipes: boolean;
    minBytes: number;
  };
  /**
   * Advisory guards — observe and advise, never block. Optional on the type
   * (like `hooks`) so a hand-built config literal need not carry it; the Zod
   * schema still defaults it, so anything loaded through `loadConfig` has it.
   */
  guard?: {
    repeatTool: {
      enabled: boolean;
      thresholds: number[];
      include: string[];
      exclude: string[];
      argumentsPreviewChars: number;
    };
  };
  /** Cluster-label settings (Haiku API key). */
  labeling: {
    anthropicApiKey?: string;
  };
  /** Misc display toggles. */
  telemetry: {
    osc8: "auto" | "force" | "disable";
  };
  /** Auto-rotation of the Claude Code backing session near the context ceiling. */
  autoRotate: {
    enabled: boolean;
    warnPct: number;
    rotatePct: number;
    hardRotatePct: number;
    minTurnsBeforeRotate: number;
    strategy: "task-anchor";
  };
  /** Model selection defaults applied when a session is created. */
  session: {
    defaultModel?: string;
    fallbackModel?: string;
    /** Stall watchdog: ms of event-stream silence while the model should be generating before a turn is force-recovered (0 = off; paused during tool execution and pending approvals). Defaults to 300000 when omitted. */
    turnStallTimeoutMs?: number;
    /** Per-call timeout (ms) for external MCP servers, surfaced as the SDK's per-server `timeout`. 0 = use SDK default. Defaults to 120000 when omitted. */
    mcpToolTimeoutMs?: number;
    /** Tail window (bytes) replayed on attach for `scrollback.paging` clients; older history is paged on demand. Defaults to 524288 (512 KiB) when omitted. */
    attachTailBytes?: number;
  };
  /**
   * The per-tenant conductor session (fleet supervisor). Optional in the
   * type so hand-built test configs stay minimal; loadConfig always
   * populates it (schema defaults). Absent = enabled with defaults.
   */
  conductor?: {
    enabled: boolean;
    name: string;
    provider: string;
    model?: string;
  };
  /**
   * session.fork behavior. `setup` is a shell command run once in a new fork
   * worktree to make it buildable (deps aren't present in a fresh worktree).
   * Optional; absent = the forked agent bootstraps the worktree itself.
   */
  fork?: {
    setup?: string;
  };
  /**
   * Send-class dispatch queue (P4). Optional in the type so hand-built test
   * configs stay minimal; loadConfig always populates it. Absent = enabled
   * with defaults.
   */
  /**
   * Per-subject session limits. Both default to 0 = unlimited (see
   * RateLimitSchema); set them only for a shared multi-user daemon. Optional in
   * the type so hand-built test configs stay minimal; loadConfig always
   * populates it.
   */
  rateLimit?: {
    maxSessionsPerUser: number;
    maxCreationsPerHour: number;
  };
  dispatch?: {
    enabled: boolean;
    tickMs: number;
    leaseMs: number;
    failureLimit: number;
    maxConcurrentWorkers: number;
    workerToolBudget: number;
    retryBaseMs: number;
  };
  /**
   * Collaborative-session bounds (see CollaborationSchema). Optional in the
   * type so hand-built test configs stay minimal; loadConfig always populates
   * it, and an absent value means UNLIMITED rather than the default — a
   * hand-built config must not silently acquire a cap it never declared.
   */
  collaboration?: {
    maxLiveChildren: number;
  };
  /**
   * SDLC pipeline — ON by default (docs/sdlc-pipeline.md); a PipelineManager is
   * constructed at boot sharing the daemon DB, and non-terminal pipelines are
   * rehydrated (resume). Runs are user-initiated + gate-halted + scope/trust
   * gated, so this is an operator opt-out, not a safety gate. Optional in the
   * type so hand-built test configs stay minimal; loadConfig always populates it.
   */
  pipeline?: {
    enabled: boolean;
    defaultPack: string | null;
    packs: { dir: string; trusted: boolean; registry?: string }[];
    /** Pack registries (git repos) — cloned into the pack cache so packs can be
     *  discovered + installed at runtime (docs/pack-loading.md). Optional in the
     *  type so hand-built test configs stay minimal; loadConfig always populates
     *  it (schema default []). */
    registries?: { name: string; url: string; ref?: string }[];
    /** Operator model maps for per-role model binding
     *  (docs/role-model-binding.md §2.2): tier → model, and the surgical
     *  "<packId>/<roleName>" → model override. Optional in the type so
     *  hand-built test configs stay minimal; loadConfig always populates them
     *  (schema default {}). */
    modelTiers?: Record<string, { provider: string; model?: string }>;
    modelRoles?: Record<string, { provider: string; model?: string }>;
  };
  /**
   * Per-backend provider settings. Optional in the type so hand-built test
   * configs stay minimal; loadConfig always populates it (schema defaults).
   */
  providers?: {
    pi: {
      enabled: boolean;
      command: string;
    };
    codex: {
      enabled: boolean;
      command: string;
    };
    geminiCli: {
      enabled: boolean;
      command: string;
    };
    qwen: {
      enabled: boolean;
      authType?: "openai" | "qwen-oauth";
      baseUrl?: string;
      model?: string;
      command?: string;
    };
  };
  /**
   * Canonical MCP server registry — declared once, mounted on every backend
   * (see docs/provider-mcp-registry-design.md). Optional in the type so
   * hand-built test configs stay minimal; loadConfig always populates it
   * (schema default: {}).
   */
  mcpServers?: Record<string, RawMcpServerConfig>;
  /**
   * Daemon-native hooks — dispatched at Session's seams for every backend.
   * Optional in the type so hand-built test configs stay minimal;
   * loadConfig always populates it (schema defaults: enabled, no entries).
   */
  hooks?: {
    enabled: boolean;
    entries: HookEntryConfig[];
  };
  /**
   * Push notifications. Optional in the type so hand-built test configs stay
   * minimal; loadConfig always populates it (schema default: transport "none").
   */
  push?: {
    transport: "expo" | "native" | "relay" | "none";
    expoAccessToken?: string;
    apns?: { keyId: string; teamId: string; bundleId: string; p8: string; sandbox: boolean };
    fcm?: { projectId: string; clientEmail: string; privateKey: string };
    relayUrl?: string;
    relayToken?: string;
  };
  /**
   * Embed trust — origins permitted to frame the web UI and pre-authenticate
   * it via the URL-hash credential handoff. The web UI's trusted-framing-origin
   * gate consults this allowlist; empty ⇒ the hash handoff is disabled (safe
   * default). Optional in the type so hand-built test configs stay minimal;
   * loadConfig always populates it (schema default: empty).
   */
  embed?: {
    allowedOrigins: string[];
  };
}

// ── Env-var override map ─────────────────────────────────────────────────

/**
 * Table-driven env override. Stays explicit so typos in process.env don't
 * silently hijack a field — we only honor keys listed here.
 */
type OverrideKind = "string" | "boolean" | "int" | "float" | "csv";

interface EnvOverride {
  /** Dotted path into ParsedConfig. */
  path: string;
  env: string;
  kind: OverrideKind;
}

const ENV_OVERRIDES: readonly EnvOverride[] = [
  { env: "CODEOID_DAEMON_URL", path: "daemonUrl", kind: "string" },
  { env: "CODEOID_DB_PATH", path: "dbPath", kind: "string" },
  { env: "CODEOID_TRANSCRIPT_DIR", path: "transcriptDir", kind: "string" },
  { env: "CODEOID_API_KEY", path: "apiKey", kind: "string" },
  { env: "ZEROID_URL", path: "zeroidUrl", kind: "string" },
  { env: "ZEROID_ISSUER", path: "auth.issuer", kind: "string" },
  { env: "ZEROID_AUDIENCE", path: "auth.audience", kind: "string" },
  { env: "CODEOID_OAUTH_CLIENT_ID", path: "oauth.clientId", kind: "string" },
  { env: "ZEROID_ACCOUNT_ID", path: "agentIdentity.accountId", kind: "string" },
  { env: "ZEROID_PROJECT_ID", path: "agentIdentity.projectId", kind: "string" },
  { env: "ZEROID_REGISTRAR_KEY", path: "agentIdentity.registrarKey", kind: "string" },
  { env: "ZEROID_IDENTITY_EXPIRES_AT", path: "agentIdentity.identityExpiresAt", kind: "string" },
  { env: "CODEOID_MEMORY", path: "memory.enabled", kind: "boolean" },
  { env: "CODEOID_MEMORY_DB_PATH", path: "memory.dbPath", kind: "string" },
  { env: "CODEOID_MEMORY_MODEL", path: "memory.model", kind: "string" },
  { env: "CODEOID_MEMORY_CACHE_DIR", path: "memory.modelCacheDir", kind: "string" },
  { env: "CODEOID_MEMORY_CLUSTERS", path: "memory.clusters.enabled", kind: "boolean" },
  { env: "CODEOID_WORKSPACE_INDEX", path: "workspaceIndex.enabled", kind: "boolean" },
  { env: "CODEOID_WORKSPACE_INDEX_EPISODE_THRESHOLD", path: "workspaceIndex.episodeThreshold", kind: "int" },
  { env: "CODEOID_WORKSPACE_INDEX_TIME_MS", path: "workspaceIndex.timeThresholdMs", kind: "int" },
  { env: "CODEOID_WORKSPACE_INDEX_DEBOUNCE_MS", path: "workspaceIndex.debounceMs", kind: "int" },
  { env: "CODEOID_COMPRESS", path: "compress.enabled", kind: "boolean" },
  { env: "CODEOID_COMPRESS_EXCLUDE", path: "compress.excludeCommands", kind: "csv" },
  { env: "CODEOID_COMPRESS_EXCLUDE_PATTERNS", path: "compress.excludePatterns", kind: "csv" },
  { env: "CODEOID_COMPRESS_PIPES", path: "compress.compressPipes", kind: "boolean" },
  { env: "CODEOID_COMPRESS_MIN_BYTES", path: "compress.minBytes", kind: "int" },
  { env: "CODEOID_GUARD_REPEAT_TOOL", path: "guard.repeatTool.enabled", kind: "boolean" },
  { env: "CODEOID_GUARD_REPEAT_TOOL_EXCLUDE", path: "guard.repeatTool.exclude", kind: "csv" },
  { env: "ANTHROPIC_API_KEY", path: "labeling.anthropicApiKey", kind: "string" },
  { env: "CODEOID_OSC8", path: "telemetry.osc8", kind: "string" },
  { env: "CODEOID_AUTO_ROTATE", path: "autoRotate.enabled", kind: "boolean" },
  { env: "CODEOID_AUTO_ROTATE_WARN_PCT", path: "autoRotate.warnPct", kind: "float" },
  { env: "CODEOID_AUTO_ROTATE_PCT", path: "autoRotate.rotatePct", kind: "float" },
  { env: "CODEOID_AUTO_ROTATE_HARD_PCT", path: "autoRotate.hardRotatePct", kind: "float" },
  { env: "CODEOID_AUTO_ROTATE_MIN_TURNS", path: "autoRotate.minTurnsBeforeRotate", kind: "int" },
  { env: "CODEOID_DEFAULT_MODEL", path: "session.defaultModel", kind: "string" },
  // Dispatch kill switch — disable send-class fleet dispatch per-invocation
  // without touching config.json. Other dispatch knobs are file-config only,
  // matching the conductor block's convention.
  { env: "CODEOID_DISPATCH_ENABLED", path: "dispatch.enabled", kind: "boolean" },
  { env: "CODEOID_MAX_SESSIONS_PER_USER", path: "rateLimit.maxSessionsPerUser", kind: "int" },
  { env: "CODEOID_MAX_SESSIONS_PER_HOUR", path: "rateLimit.maxCreationsPerHour", kind: "int" },
  // Pipeline enable/kill switch — turn the SDLC pipeline on/off per-invocation
  // without touching config.json (on by default; set false to opt out). Other
  // pipeline knobs are file-config only, matching the dispatch/conductor convention.
  { env: "CODEOID_PIPELINE_ENABLED", path: "pipeline.enabled", kind: "boolean" },
  { env: "CODEOID_FALLBACK_MODEL", path: "session.fallbackModel", kind: "string" },
  // Hooks kill switch — disable every configured hook per-invocation without
  // touching config.json. Entries themselves are file-config only.
  { env: "CODEOID_HOOKS_ENABLED", path: "hooks.enabled", kind: "boolean" },
  // Push transport switch + Expo token — per-invocation without touching
  // config.json (e.g. CODEOID_PUSH_TRANSPORT=expo).
  { env: "CODEOID_PUSH_TRANSPORT", path: "push.transport", kind: "string" },
  { env: "CODEOID_EXPO_ACCESS_TOKEN", path: "push.expoAccessToken", kind: "string" },
  // Relay-mode endpoint — per-invocation without touching config.json.
  { env: "CODEOID_PUSH_RELAY_URL", path: "push.relayUrl", kind: "string" },
  { env: "CODEOID_PUSH_RELAY_TOKEN", path: "push.relayToken", kind: "string" },
  { env: "CODEOID_TURN_STALL_TIMEOUT_MS", path: "session.turnStallTimeoutMs", kind: "int" },
  { env: "CODEOID_MCP_TOOL_TIMEOUT_MS", path: "session.mcpToolTimeoutMs", kind: "int" },
  // Embed-SSO trusted framing origins (comma-separated). Each is an exact
  // origin (scheme://host[:port]) permitted to frame the web UI and hand it a
  // credential via the URL hash. Empty ⇒ hash handoff disabled (safe default).
  { env: "CODEOID_EMBED_ALLOWED_ORIGINS", path: "embed.allowedOrigins", kind: "csv" },
];

// ── Loading ──────────────────────────────────────────────────────────────

export interface LoadOptions {
  /** Explicit config file path; overrides XDG / default search. */
  configPath?: string;
  /** Env source (default process.env). Tests inject a controlled object. */
  env?: Record<string, string | undefined>;
}

/**
 * Load and validate the full config. Never throws on a missing file — that's
 * normal (first run). Throws ONLY on schema validation error when a file
 * exists but is malformed (loud fail is better than silent drift).
 */
export function loadConfig(opts: LoadOptions = {}): CodeoidConfig {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      /* non-fatal; loader still works with defaults */
    }
  }

  const configPath = opts.configPath ?? join(configDir, "config.json");
  const env = opts.env ?? process.env;

  // 1. File defaults.
  let fileConfig: unknown = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      fileConfig = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Validate + fill defaults via zod.
  const parseResult = RootSchema.safeParse(fileConfig);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid config at ${configPath}:\n${issues}\n(Delete or fix the file and retry.)`,
    );
  }
  const parsed: ParsedConfig = parseResult.data;

  // 3. Apply env overrides in declaration order.
  for (const ov of ENV_OVERRIDES) {
    const raw = env[ov.env];
    if (raw === undefined || raw === "") continue;
    setByPath(parsed, ov.path, parseOverride(raw, ov.kind));
  }

  // 3a. Re-validate after overrides. parseOverride() coerces strings to the
  //     declared kind but does NOT enforce schema constraints (e.g. the
  //     non-negative bound on session.turnStallTimeoutMs, or the 0..1 bounds on
  //     the autoRotate percentages). Without this, CODEOID_TURN_STALL_TIMEOUT_MS=-1
  //     would slip through and silently disable the stall watchdog. Re-running
  //     RootSchema over the merged result fails fast on any out-of-range override.
  const revalidated = RootSchema.safeParse(parsed);
  if (!revalidated.success) {
    const issues = revalidated.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid config after applying environment overrides:\n${issues}\n(Check the corresponding CODEOID_* env vars.)`,
    );
  }
  Object.assign(parsed, revalidated.data);

  // 3b. Resolve the ZeroID issuer (preset name or URL → concrete base URL) and
  //     pin the expected issuer claim. Every ZeroID deployment sets `iss` to
  //     its base URL, so defaulting auth.issuer to the resolved URL rejects
  //     tokens minted by any OTHER issuer — essential once codeoid points at a
  //     public multi-tenant SaaS. An explicit auth.issuer / ZEROID_ISSUER
  //     overrides this for deployments whose iss differs from the base URL.
  const resolvedZeroidUrl = resolveZeroidUrl(parsed.zeroidUrl);
  const resolvedIssuer = parsed.auth.issuer ?? resolvedZeroidUrl;

  // 4. Path normalization.
  const configRelResolve = (p: string): string =>
    isAbsolute(expandHome(p)) ? expandHome(p) : resolve(configDir, p);

  const dbPath = configRelResolve(parsed.dbPath);
  const transcriptDir = configRelResolve(parsed.transcriptDir);
  const memoryDbPath = configRelResolve(parsed.memory.dbPath);
  const memoryCacheDir = configRelResolve(parsed.memory.modelCacheDir);

  // 5. Assemble OAuth when Google credentials are present in env.
  const googleClientId = env.GOOGLE_CLIENT_ID;
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET;

  const oauth: OAuthConfig | undefined =
    googleClientId && googleClientSecret
    ? {
        zeroidTokenEndpoint: `${resolvedZeroidUrl}/oauth2/token`,
        clientId: parsed.oauth.clientId ?? "codeoid",
        googleClientId,
        googleClientSecret,
        accountId: parsed.agentIdentity.accountId,
        projectId: parsed.agentIdentity.projectId,
        allowedRedirectUris: [
          "http://localhost:7400/auth/callback",
          "http://127.0.0.1:7400/auth/callback",
        ],
        defaultScopes: [
          "session:create",
          "session:list",
          "session:attach",
          "session:watch",
          "session:send",
          "session:interrupt",
          "session:approve",
          "session:destroy",
        ],
      }
    : undefined;

  // 6. Preserve the "only populate agentIdentity when env or file supplied one"
  //    semantic so existing single-tenant setups don't accidentally flip into
  //    multi-tenant mode.
  const hasExplicitTenant =
    env.ZEROID_ACCOUNT_ID !== undefined ||
    env.ZEROID_REGISTRAR_KEY !== undefined ||
    (typeof fileConfig === "object" &&
      fileConfig !== null &&
      "agentIdentity" in fileConfig);

  // A registrar key (zid_sk_*) is minted into a real tenant, and its injector
  // (e.g. Forge) supplies ZEROID_ACCOUNT_ID + ZEROID_PROJECT_ID alongside it. If
  // the key is present but the tenant fell back to the personal/dev defaults, the
  // daemon's local identity store would be keyed personal/dev while the minted
  // identities live in the badge's actual tenant — a silent split. Surface it.
  if (
    parsed.agentIdentity.registrarKey !== undefined &&
    parsed.agentIdentity.accountId === "personal" &&
    parsed.agentIdentity.projectId === "dev"
  ) {
    console.warn(
      "[codeoid] ZEROID_REGISTRAR_KEY is set but ZEROID_ACCOUNT_ID/ZEROID_PROJECT_ID " +
        "are not — falling back to personal/dev. The registrar key is scoped to a real " +
        "tenant; set both so the local identity store matches the badge's tenant.",
    );
  }

  const osc8Mode = isOsc8Mode(parsed.telemetry.osc8)
    ? parsed.telemetry.osc8
    : "auto";

  return {
    daemonUrl: parsed.daemonUrl,
    dbPath,
    transcriptDir,
    auth: {
      baseUrl: resolvedZeroidUrl,
      issuer: resolvedIssuer,
      audience: parsed.auth.audience,
    },
    oauth,
    apiKey: parsed.apiKey,
    zeroidUrl: resolvedZeroidUrl,
    agentIdentity: hasExplicitTenant
      ? {
          accountId: parsed.agentIdentity.accountId,
          projectId: parsed.agentIdentity.projectId,
          registrarKey: parsed.agentIdentity.registrarKey,
          identityExpiresAt: parsed.agentIdentity.identityExpiresAt,
        }
      : undefined,
    memory: {
      enabled: parsed.memory.enabled,
      dbPath: memoryDbPath,
      model: parsed.memory.model,
      modelCacheDir: memoryCacheDir,
      clusters: parsed.memory.clusters,
    },
    workspaceIndex: parsed.workspaceIndex,
    compress: parsed.compress,
    guard: parsed.guard,
    labeling: parsed.labeling,
    telemetry: { osc8: osc8Mode },
    autoRotate: parsed.autoRotate,
    session: parsed.session,
    conductor: parsed.conductor,
    dispatch: parsed.dispatch,
    collaboration: parsed.collaboration,
    rateLimit: parsed.rateLimit,
    pipeline: parsed.pipeline,
    providers: parsed.providers,
    mcpServers: parsed.mcpServers,
    hooks: parsed.hooks,
    embed: parsed.embed,
    push: parsed.push,
    fork: parsed.fork,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

function parseOverride(raw: string, kind: OverrideKind): unknown {
  switch (kind) {
    case "string":
      return raw;
    case "boolean":
      return raw === "1" || raw.toLowerCase() === "true";
    case "int": {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n))
        throw new Error(`Expected integer for env override, got "${raw}"`);
      return n;
    }
    case "float": {
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n))
        throw new Error(`Expected number for env override, got "${raw}"`);
      return n;
    }
    case "csv":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
  }
}

/** Write a value into `obj` at a dotted path, creating intermediate objects. */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (next === undefined || next === null || typeof next !== "object") {
      const created: Record<string, unknown> = {};
      cur[k] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

function isOsc8Mode(s: string): s is "auto" | "force" | "disable" {
  return s === "auto" || s === "force" || s === "disable";
}

// ── Settings-page support ──────────────────────────────────────────────────

/**
 * Resolved absolute paths of the two backing files the settings page reads and
 * writes. Both are hand-editable directly — the page is just a typed front-end
 * over them.
 */
export function configFilePaths(): {
  configDir: string;
  configPath: string;
  envPath: string;
} {
  const dir = getConfigDir();
  return {
    configDir: dir,
    configPath: join(dir, "config.json"),
    envPath: join(dir, ".env"),
  };
}

/**
 * Validate a candidate raw config object against the authoritative zod schema
 * WITHOUT applying env overrides or path resolution — the check `settings.set`
 * runs before persisting a patched config.json. Keeps `RootSchema` the single
 * source of validation truth (the manifest's bounds are display hints only).
 */
export function validateConfigObject(
  raw: unknown,
): { ok: true } | { ok: false; issues: { path: string; message: string }[] } {
  const result = RootSchema.safeParse(raw);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

// ── Config persistence ──────────────────────────────────────────────────────

/**
 * Atomically write a file (temp + rename) with the given mode. The single
 * atomic-write primitive shared by config.json / .env writers so the tmp+rename
 * + best-effort chmod behavior lives in one place.
 */
export function atomicWrite(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  renameSync(tmp, path);
}

/** Read `config.json` as a raw object (empty object if absent). Throws if the
 *  file is present but not a JSON object. */
export function readRawConfigFile(): Record<string, unknown> {
  const { configPath } = configFilePaths();
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read → mutate → validate → atomically persist `config.json`. The mutator
 * edits the raw object in place; the WHOLE result is validated against
 * `RootSchema` before the atomic `0o600` write, so a bad mutation rejects the
 * batch (no partial write). The single runtime config-write path shared by the
 * settings surface and dynamic pack management (docs/pack-loading.md), keeping
 * config integrity enforced in one place. Returns the mutated raw config.
 */
export function mutateConfigFile(
  mutate: (raw: Record<string, unknown>) => void,
): Record<string, unknown> {
  const raw = readRawConfigFile();
  mutate(raw);
  const validation = validateConfigObject(raw);
  if (!validation.ok) {
    const detail = validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`config change rejected: ${detail}`);
  }
  const { configPath } = configFilePaths();
  atomicWrite(configPath, `${JSON.stringify(raw, null, 2)}\n`, 0o600);
  return raw;
}
