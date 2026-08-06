/**
 * Codeoid Server Protocol v2
 *
 * Design principles:
 *   1. Every message is self-contained, serializable JSON — no observables, no callbacks
 *   2. Every message carries identity (who produced it) — auditable top to bottom
 *   3. Discriminated unions with `kind` fields — frontends switch on kind, ignore unknown
 *   4. Simple frontends (Telegram) use role + content string, rich frontends use parts[]
 *   5. Tool calls are state machines — streaming → confirmation → executing → completed
 *   6. Streaming via delta messages — reference a messageId, append content
 *   7. Extensible — new roles, content parts, tool states added without breaking existing frontends
 *
 * Inspired by VS Code's IChatProgress union and tool invocation state machine.
 * Adapted for network transport (JSON over WebSocket) and multi-frontend/multi-user.
 */

import type { Scope } from "./scopes.js";
import type {
  SettingsSchemaMsg,
  SettingsGetMsg,
  SettingsSetMsg,
  SettingsSchemaResultMsg,
  SettingsGetResultMsg,
  SettingsSetResultMsg,
} from "./settings.js";

/**
 * Wire-protocol version. Bump on breaking changes (renamed/removed fields,
 * renamed message kinds, altered semantics). Additive changes (new optional
 * fields, new message kinds) do NOT require a bump — the "ignore unknown"
 * discipline covers those.
 *
 * Native clients (e.g. the Rust Ratatui frontend) compare this against their
 * own compiled-in version on `auth.ok` and warn the user if they've drifted.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Capability identifiers exchanged during the auth handshake (see `AuthMsg` /
 * `AuthOkMsg`). Capabilities are the additive-evolution mechanism for
 * behaviour (as opposed to message shape, which the "ignore unknown" rule
 * covers): a client declares what it can consume, the daemon declares what it
 * can produce, and either side simply doesn't use what the other didn't
 * declare. Unknown capability strings MUST be ignored, never rejected.
 */
export const CAPABILITIES = {
  /** Client renders rich `parts[]` content (vs the plain `content` fallback). */
  PARTS: "parts",
  /** Chunked scrollback replay (`scrollback.replay` with `seq`/`final`). */
  CHUNKED_REPLAY: "replay.chunked",
  /** Sequence-based incremental resume on `session.attach`. */
  SEQ_RESUME: "replay.resume",
  /** Duplicate-send suppression via `session.send.clientMsgId`. */
  SEND_IDEMPOTENCY: "send.idempotency",
  /**
   * Provider-initiated dialogs (`session.ui_request` / `session.ui_response`).
   * Declared by clients that can render the request methods; the daemon only
   * targets `ui_request` frames at connections that declared it.
   */
  UI_DIALOGS: "ui.dialogs",
  /**
   * Session-scoped provider command discovery (`session.commands`). Declared
   * by the daemon; clients feature-detect before fetching.
   */
  DYNAMIC_COMMANDS: "commands.dynamic",
  /**
   * Tail-first attach + on-demand history paging. Clients that declare this
   * receive only the newest scrollback window on attach (`scrollback.replay`
   * with `tail: true` + `hasMore`) and backfill older history on demand via
   * `scrollback.page`. Clients that don't declare it keep the legacy
   * full-buffer replay.
   */
  SCROLLBACK_PAGING: "scrollback.paging",
  /**
   * Push notifications. Declared by the DAEMON when a push transport is
   * configured (so clients can feature-detect before registering) and by
   * CLIENTS that can receive them. A client registers a device token via
   * `push.register`; the daemon then sends content-blind wake-ups (only opaque
   * ids, never tool args) when one of that user's sessions blocks on approval.
   */
  PUSH: "push",
  /**
   * Goal-blackboard inspection (`blackboard.index` / `blackboard.read`).
   * Declared by the daemon; clients feature-detect before offering an artifact
   * panel, so an older daemon simply doesn't grow the affordance rather than
   * showing one that errors on click.
   */
  BLACKBOARD: "blackboard",
  /**
   * Live collaboration panel state (`collaboration.panels`). Declared by the
   * daemon so a client only offers panel UI when the data exists behind it.
   */
  PANELS: "collaboration.panels",
  /**
   * Push via NATIVE device tokens (APNs/FCM) rather than Expo. Advertised by
   * the daemon when the `native` or `relay` transport is configured; a client
   * seeing this registers its native `getDevicePushTokenAsync` token (vs the
   * Expo token it sends for `PUSH`).
   */
  PUSH_NATIVE: "push.native",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * Wire-level input limits, enforced by the daemon on inbound messages and
 * published here so clients can pre-validate instead of learning limits from
 * `invalid_request` errors. All limits are counted in UTF-16 code units
 * (JS `string.length`) unless stated otherwise.
 *
 * `SEND_TEXT_MAX` exists as a token-bill safety net: prompt text goes
 * straight into the model's context, so an accidental multi-megabyte paste
 * would burn real money in a single turn. Large inputs belong in
 * `attachments` (bounded per-file, surfaced to the model as files it can
 * read selectively).
 */
export const LIMITS = {
  /** Max `session.send.text` length. ~1M chars ≈ hundreds of thousands of tokens. */
  SEND_TEXT_MAX: 1_000_000,
  /** Max session name length (`session.create` / `session.rename`). */
  NAME_MAX: 256,
  /** Max filesystem path length accepted anywhere a path is sent. */
  PATH_MAX: 4096,
  /** Max `session.search.query` length. */
  QUERY_MAX: 1024,
  /** Max number of attachments on a single `session.send`. */
  ATTACHMENTS_MAX: 32,
  /** Max inline `Attachment.content` length. */
  ATTACHMENT_CONTENT_MAX: 2_000_000,
  /** Max `Attachment.data` (base64) length — bounded by the 16 MiB WS frame cap. */
  ATTACHMENT_DATA_MAX: 12_000_000,
  /** Max correlation / approval / client-generated id length. */
  ID_MAX: 128,
  /** Max model id / alias length (`session.set_model`). */
  MODEL_MAX: 256,
  /**
   * Max length of a single `settings.set` value (a string field, one array
   * element, or a secret). Generous — API keys, shell commands, and paths all
   * fit comfortably under 8 KiB.
   */
  SETTING_VALUE_MAX: 8192,
  /** Max free-text length on a `session.ui_response` (`value`). */
  UI_TEXT_MAX: 65_536,
  /** Max number of options on a `session.ui_request` select. */
  UI_OPTIONS_MAX: 64,
  /** Max `CollaborationConfig.goal` length. A goal is a brief, not a spec. */
  COLLABORATION_GOAL_MAX: 8192,
  /** Max distinct roles in one collaboration. */
  COLLABORATION_ROLES_MAX: 16,
  /**
   * Max children a single role may fan out to (`CollaborationRole.count`).
   * A schema-level backstop only — the live-worker cap (P3) is what actually
   * governs concurrency at run time.
   */
  COLLABORATION_ROLE_COUNT_MAX: 8,
  /** Max device push-token length (`push.register`). Expo tokens are ~40 chars. */
  PUSH_TOKEN_MAX: 512,
} as const;

// =============================================================================
// Session metadata
// =============================================================================

// Active-turn status is split into two sub-states so clients can show what
// the agent is actually doing: `thinking` (reasoning / generating text) vs
// `tool_running` (a tool is executing — clients surface the tool name).
export type SessionStatus =
  | "idle"
  | "thinking"
  | "tool_running"
  | "waiting_approval"
  | "error";

/** True when the session is mid-turn (either reasoning or running a tool). */
export function isActiveStatus(s: SessionStatus): boolean {
  return s === "thinking" || s === "tool_running";
}

/**
 * Execution mode — controls tool approval and autonomous budgeting.
 *
 * - `guarded` (default): Read/Grep/Glob/memory are auto-approved; Write/Edit/Bash/Agent
 *   still ask. The name says it plainly — it AUTO-runs the safe reads but GUARDS the
 *   mutations. (≈ Claude Code's default mode.) Formerly named `auto-allow`.
 * - `interactive`: every tool call asks for approval, including reads.
 * - `autonomous`: every tool auto-approved until the turn budget (`maxTurns`) is exhausted;
 *   session then reverts to `guarded`. (≈ Claude Code's bypass-permissions mode.)
 */
export type SessionMode = "interactive" | "guarded" | "autonomous";

export interface SessionInfo {
  id: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  attachedClients: number;
  /**
   * Session role. "conductor" marks the per-tenant conductor session (the
   * fleet supervisor — one per account/project); "worker" marks a disposable
   * dispatch-spawned worker. Absent = normal session.
   */
  role?: "conductor" | "worker";
  /** Id of the provider backing this session (e.g. "claude", "gemini"). */
  providerId?: string;
  /** Current execution mode (default "interactive"). */
  mode?: SessionMode;
  /** Active SDLC pipeline phase id when this session backs a phase. Absent = not a pipeline session. */
  phase?: string;
  /** Methodology pack/profile driving this session's phase. */
  profile?: string;
  /** Remaining turns budget for autonomous mode (undefined = unbounded, 0 = exhausted). */
  turnsRemaining?: number;
  /** Files pinned to the session — prepended to every turn's prompt. */
  pinnedFiles?: string[];
  /** SPIFFE/WIMSE URI of the primary session agent (falls back to anonymous:session:<id>). */
  agentUri?: string;
  /** Active sub-agents for the identity chain display. */
  subagents?: Subagent[];
  /**
   * Background tasks the session's harness is running OUTSIDE any turn —
   * work the model deferred past its own turn ("I'll report when the agents
   * land"). Provider-agnostic: `kind` is the harness's own vocabulary
   * ("shell", "subagent", …) and is display-only. Absent/empty = none, which
   * is also what daemons that predate this field report.
   */
  backgroundTasks?: Array<{
    id: string;
    kind: string;
    description: string;
    status: string;
  }>;
  /** Cumulative token + cost usage since the session started. */
  usage?: SessionUsage;
  /**
   * Rotation telemetry — how many times the underlying Claude Code session
   * has been rolled over to avoid context compaction. Only populated when
   * auto-rotation is active or the user has manually rotated.
   */
  rotation?: {
    count: number;
    /** Unix ms of last rotation, or null if never rotated. */
    lastRotatedAt: number | null;
    /** Backing Claude Code session id (opaque to UI, useful for debugging). */
    claudeCodeSessionId?: string;
  };
  /**
   * Number of user messages buffered in the streamInput queue, waiting for
   * the SDK consumer to pick them up. > 0 means: user has sent faster than
   * Claude can process — useful signal for mid-turn queueing UX.
   */
  queuedMessages?: number;
  /**
   * Resolved full model id currently in use for this session. When unset,
   * the SDK / Claude Code default applies. Frontends typically display
   * the matching alias + label from the model catalog.
   */
  model?: string;
  /** Fallback model id used on 429/529 capacity errors. */
  fallbackModel?: string;
  /**
   * Lineage for a session created via `session.fork`. Absent = not a fork.
   * Frontends surface it as a chip ("⑃ forked from <name> · turn <atTurn>")
   * that links back to the parent. Recorded at fork time and persisted, so
   * it survives restarts (and a later parent rename/deletion — `name` is a
   * snapshot).
   */
  forkedFrom?: {
    /** Parent session id — focus it when the chip is clicked. */
    sessionId: string;
    /** Parent's name at fork time (snapshot; parent may rename/vanish). */
    name: string;
    /** Conversation rounds (user turns) carried over from the parent — the
     * point the branch was taken. */
    atTurn: number;
  };
  /**
   * Git worktree this session's workdir is (when isolated). Present when the
   * session runs in a dedicated worktree — a fork isolated from its parent, or
   * a session bound to an existing worktree. Absent = the session shares its
   * workdir with no git isolation.
   */
  worktree?: SessionWorktree;
  /**
   * Collaboration this session orchestrates, when it was created with the
   * Collaborative toggle. Absent = a normal session. Persisted, so it
   * survives a daemon restart the way `role`/`providerId` already do.
   */
  collaboration?: CollaborationConfig;
  /**
   * Set on a role-CHILD of a collaborative session: which collaboration it
   * belongs to and which role it plays. Absent = not a collaboration child.
   *
   * The mirror of `collaboration` (set on the parent), so a client can group
   * a fleet without inferring it from names. `ordinal` distinguishes the
   * members of a fanned-out role (`review` ×3 → ordinals 1..3).
   */
  collaborationRole?: {
    /** Session id of the orchestrating parent. */
    parentSessionId: string;
    /** Role name from the parent's config (already lowercased). */
    roleName: string;
    /** 1-based index within this role's fan-out. */
    ordinal: number;
    /** Whether this child's identity carries write authority. */
    write: boolean;
  };
}

/** A git worktree backing a session's workdir (see SessionInfo.worktree). */
export interface SessionWorktree {
  /** Absolute path of the worktree directory (the session's workdir). */
  path: string;
  /** Branch checked out in the worktree (e.g. "codeoid/fix-login-a1b2c3d4"). */
  branch: string;
  /**
   * True when codeoid created this worktree (fork isolation) and therefore
   * owns its cleanup on destroy. False when the session was bound to a
   * worktree the user already had — codeoid never removes those.
   */
  createdByCodeoid: boolean;
}

/**
 * Cumulative usage totals for a session. Aggregated from each SDK `result`
 * message (one per turn). Frontends render this as a "$X · Yk in / Zk out"
 * counter so the user sees what they're spending in near-realtime.
 *
 * Persistent: the daemon records one `TurnUsage` row per turn to SQLite so
 * totals survive daemon restarts and can be queried after the fact.
 */
export interface SessionUsage {
  /** Input tokens consumed across all turns. */
  inputTokens: number;
  /** Output tokens generated across all turns. */
  outputTokens: number;
  /** Tokens read from the prompt cache (cheap). */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache (a premium on cache-misses). */
  cacheCreationTokens: number;
  /** Total cost in USD across all turns, as reported by the SDK. */
  totalCostUsd: number;
  /** Number of turns (round-trips) included in these totals. */
  numTurns: number;
  /** Wall-clock duration of agent work (sum of per-turn `duration_ms`). */
  durationMs: number;
  /** Most recent turns (newest first) — lightweight trend signal for UIs. */
  recentTurns?: TurnUsage[];
  /**
   * Max PRIMARY-AGENT context size ever seen on a single turn — bloat canary.
   * Computed as max(input + cache_read + cache_creation) across the primary
   * agent's per-call usages within each turn (subagent calls excluded). This
   * is the size the model actually processed; NOT a cumulative or billable
   * figure. Capped at the model's context window on historical fallback.
   */
  peakInputTokens?: number;
  /**
   * Most recent turn's PRIMARY-AGENT context size.
   * = input + cache_read + cache_creation on the biggest primary call of the
   * turn (subagents excluded). Matches Claude Code's canonical ctx-occupancy
   * formula (`calculateContextPercentages`). Used as the numerator for the
   * StatusBar's ctx%/window display — NOT billable input.
   */
  lastTurnInputTokens?: number;
  /** Most recent turn's output tokens. */
  lastTurnOutputTokens?: number;
  /** Most recent turn's cost (USD). */
  lastTurnCostUsd?: number;
  /** Most recent turn's cache-read ratio (cache_read / total_input). */
  lastTurnCacheHitRate?: number;
  /**
   * Resolved model's context window in tokens — the denominator for
   * ctx-occupancy displays. Derived from `SessionInfo.model` via the
   * daemon's per-model catalog (`contextWindowForModel`). Switching
   * models mid-session updates this on the next info_update broadcast.
   *
   * Optional for back-compat with daemons that pre-date this field;
   * frontends should fall back to a conservative constant (200k) or
   * skip the percentage when unset.
   */
  contextWindow?: number;
}

/**
 * Per-turn usage record — one row per SDK `result` event.
 *
 * Kept small + serializable so it fits cleanly in SessionInfo broadcasts.
 * `totalInputTokens`, `billableInputTokens` and `cacheHitRate` are derived
 * fields we compute once on write rather than re-computing in every
 * frontend — keeps the StatusBar render cheap.
 *
 * Important Anthropic semantics (easy to get wrong):
 *   - `inputTokens` = NEW (uncached) input tokens only
 *   - `cacheReadTokens` = tokens served from prompt cache (billed 0.1x)
 *   - `cacheCreationTokens` = tokens written to cache (billed 1.25x)
 *   - Actual context size Claude processed = input + cacheRead + cacheCreation
 */
export interface TurnUsage {
  /** 1-indexed turn number within the session. */
  turnNumber: number;
  /** Unix ms when the turn settled. */
  createdAt: number;
  /** New (uncached) input tokens for this turn. Does NOT include cache tokens. */
  inputTokens: number;
  /** Output tokens from the assistant. */
  outputTokens: number;
  /** Cache-read tokens (billed at ~10% of full input). */
  cacheReadTokens: number;
  /** Cache-write tokens (billed at ~125% of full input). */
  cacheCreationTokens: number;
  /** Total cost for the turn in USD, as reported by the SDK. */
  totalCostUsd: number;
  /** Wall-clock duration in ms (agent work, not network). */
  durationMs: number;
  /** Stop reason ("end_turn", "max_tokens", "tool_use", "error", …) if known. */
  stopReason?: string;
  /** Derived: total context size = inputTokens + cacheReadTokens + cacheCreationTokens. */
  totalInputTokens: number;
  /** Derived: full-price input = inputTokens + cacheCreationTokens (cache reads are ~free). */
  billableInputTokens: number;
  /** Derived: cacheReadTokens / totalInputTokens. 0-1. */
  cacheHitRate: number;
  /**
   * Max single-call context size on the primary agent during this turn —
   * `max(input + cache_read + cache_creation)` across the SDK's streamed
   * per-call usage. Authoritative for "% of window" because
   * `totalInputTokens` SUMS across the multiple internal Messages-API
   * calls a tool-using turn makes, overstating single-shot context size.
   *
   * Optional for back-compat: rows persisted before the daemon began
   * tracking this leave it `undefined`. Frontends fall back to
   * `min(totalInputTokens, contextWindow)` (legacy behaviour) for those.
   */
  primaryMaxCallInputTokens?: number;
}

// ── Usage analytics ───────────────────────────────────────────────────────────

export interface DailyUsageBucket {
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  numSessions: number;
}

export interface LifetimeUsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  numSessions: number;
}

export interface Subagent {
  /** SDK-side agent id (opaque handle). */
  agentId: string;
  /** ZeroID WIMSE URI if registered, else undefined. */
  wimseUri?: string;
  /** Subagent type label (e.g. "general-purpose", "code-reviewer", "Explorer"). */
  agentType: string;
  /** Unix ms when the sub-agent started. */
  spawnedAt: number;
  /** True while the sub-agent is running; false after SubagentStop. */
  active: boolean;
}

// =============================================================================
// Identity — WHO produced a message. On every message, always.
// =============================================================================

export type IdentityType = "human" | "agent" | "subagent" | "system";

export interface MessageIdentity {
  /** ZeroID WIMSE URI (e.g. spiffe://zeroid.dev/personal/dev/agent/codeoid-session-abc) */
  sub: string;
  /** Human-readable display name */
  name?: string;
  /** What kind of entity produced this */
  type: IdentityType;
}

/** System identity — used for daemon-generated messages */
export const SYSTEM_IDENTITY: MessageIdentity = {
  sub: "system:codeoid",
  name: "Codeoid",
  type: "system",
};

// =============================================================================
// Message roles
// =============================================================================

/**
 * Every message has a role. Simple frontends render based on role alone.
 * Extensible — add new roles without breaking existing frontends.
 */
export type MessageRole =
  | "user"           // Human sent a prompt
  | "assistant"      // Agent's text response
  | "thinking"       // Agent's reasoning / extended thinking
  | "tool_call"      // Agent invoked a tool
  | "tool_result"    // Tool execution output
  | "system"         // Errors, retries, warnings
  | "info";          // Informational (identity changes, session events)

// =============================================================================
// Content parts — rich, structured content within a message.
//
// Frontends that support rich rendering use parts[].
// Simple frontends (Telegram) fall back to the `content` string.
// Discriminated on `kind` — ignore unknown kinds gracefully.
// =============================================================================

export type ContentPart =
  | TextPart
  | CodePart
  | FileRefPart
  | DiffPart
  | TreePart
  | ButtonPart
  | ProgressPart
  | ImagePart
  | AnchorPart
  | TablePart;

/** Markdown or plain text */
export interface TextPart {
  kind: "text";
  text: string;
  /** If true, text contains markdown. Default: true for assistant role. */
  markdown?: boolean;
}

/** Fenced code block with optional language */
export interface CodePart {
  kind: "code";
  code: string;
  language?: string;
  /** Optional file path this code belongs to */
  filePath?: string;
}

/** Reference to a file (clickable in rich frontends) */
export interface FileRefPart {
  kind: "file_ref";
  path: string;
  /** Optional line range */
  lines?: [start: number, end: number];
  /** Change summary if this is a modified file */
  change?: { added: number; removed: number };
}

/** File diff summary */
export interface DiffPart {
  kind: "diff";
  path: string;
  added: number;
  removed: number;
  /** Original file URI (for multi-diff views) */
  originalPath?: string;
}

/** File tree node */
export interface TreeNode {
  label: string;
  type: "file" | "directory";
  path?: string;
  children?: TreeNode[];
}

export interface TreePart {
  kind: "tree";
  label: string;
  children: TreeNode[];
}

/** Clickable button / action */
export interface ButtonPart {
  kind: "button";
  label: string;
  /** Action identifier — frontends handle based on this */
  action: string;
  /** Additional data for the action */
  data?: Record<string, unknown>;
  /** Visual style hint */
  style?: "primary" | "secondary" | "danger";
}

/** Progress indicator */
export interface ProgressPart {
  kind: "progress";
  message: string;
  /** 0-100 if deterministic, undefined if indeterminate */
  percent?: number;
  /** Elapsed time in milliseconds */
  elapsedMs?: number;
}

/** Inline image */
export interface ImagePart {
  kind: "image";
  url: string;
  alt?: string;
}

/** Hyperlink / anchor */
export interface AnchorPart {
  kind: "anchor";
  uri: string;
  title: string;
}

/** Structured table (for tabular data without markdown) */
export interface TablePart {
  kind: "table";
  headers: string[];
  rows: string[][];
}

// =============================================================================
// Tool invocation state machine
//
// Tool calls are NOT single events — they have a lifecycle.
// Each state transition is sent as a delta update referencing the tool's toolId.
//
// Lifecycle:
//   streaming → waiting_confirmation → executing → completed
//                                   → cancelled
//
// Inspired by VS Code's IChatToolInvocation.StateKind.
// =============================================================================

export type ToolPhase =
  | "streaming"              // LM is still generating the tool call input
  | "waiting_confirmation"   // Awaiting user approval
  | "executing"              // Tool is running
  | "completed"              // Tool finished (success or error)
  | "cancelled";             // User denied or interrupted

export type ToolState =
  | ToolStreamingState
  | ToolWaitingConfirmationState
  | ToolExecutingState
  | ToolCompletedState
  | ToolCancelledState;

export interface ToolStreamingState {
  phase: "streaming";
  /** Partial input as the LM generates it */
  partialInput?: unknown;
}

/**
 * What a collaboration has spent so far, rolled up across its orchestrator and
 * every live role-child (docs/collaborative-session-design.md §11 P3).
 *
 * Attached to a send-class dispatch approval so the owner sees the goal's
 * running total on the button they are about to press. Cost shown anywhere else
 * is trivia; cost shown at the moment of authorizing more work is a control.
 *
 * Optional on the wire and computed per request. A client that doesn't know the
 * field ignores it; a daemon that fails to compute it omits it — the roll-up
 * must never be able to block a dispatch, since an approval path wedged by a
 * cost display is strictly worse than no cost display.
 */
export interface CollaborationCost {
  /** The goal (orchestrator) session id these totals cover. */
  goalSessionId: string;
  /** Live role-children included in the roll-up. */
  children: number;
  /** Summed `SessionUsage.totalCostUsd` across orchestrator + children. */
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Summed turns — how much agent work the goal has already consumed. */
  numTurns: number;
}

export interface ToolWaitingConfirmationState {
  phase: "waiting_confirmation";
  /** Complete tool input */
  input: unknown;
  /** Human-readable description of what the tool will do */
  description: string;
  /** Unique ID for this confirmation — client responds with this */
  approvalId: string;
  /**
   * Present only for a send-class fleet dispatch from a collaborative session:
   * what the goal has cost so far. Absent everywhere else, and absent if the
   * roll-up could not be computed.
   */
  collaborationCost?: CollaborationCost;
}

export interface ToolExecutingState {
  phase: "executing";
  /** Progress message from the tool */
  progress?: string;
  /** Elapsed time in milliseconds */
  elapsedMs?: number;
}

export interface ToolCompletedState {
  phase: "completed";
  success: boolean;
  /** Tool output (may be truncated for large outputs) */
  output?: string;
  /** Elapsed time in milliseconds */
  elapsedMs?: number;
  /** How the tool was confirmed */
  confirmedBy?: "user" | "auto" | "setting";
}

export interface ToolCancelledState {
  phase: "cancelled";
  reason: "denied" | "interrupted" | "timeout";
  /** Optional explanation */
  message?: string;
}

/** Tool call metadata on a session message */
export interface ToolInfo {
  /** Unique ID for this tool invocation — correlate updates via this */
  toolId: string;
  /** Tool name (e.g. "Bash", "Read", "Edit") */
  name: string;
  /** Current state */
  state: ToolState;
  /**
   * The original tool input as provided by the model. Lives on
   * `ToolInfo` (not just on `WaitingConfirmation`) so it survives
   * phase transitions — clients that want to render Edit-as-diff in
   * the completed phase need it after approval, and we don't want to
   * pay a round-trip to fetch it back.
   */
  input?: unknown;
}

// =============================================================================
// Session messages — the core of the protocol.
// =============================================================================

/**
 * A complete session message. Self-contained, serializable, auditable.
 *
 * Every message carries:
 *   - `role` — what kind of message (user, assistant, tool_call, etc.)
 *   - `content` — string fallback for simple frontends
 *   - `parts` — rich content for capable frontends
 *   - `identity` — who produced this message
 *   - `tool` — tool lifecycle (only for role=tool_call)
 *   - `messageId` — unique, for delta updates and cross-references
 */
export interface SessionMessage {
  type: "session.message";
  sessionId: string;
  /** Unique message ID — used by deltas to reference this message */
  messageId: string;
  role: MessageRole;
  /** Plain text content — always present, usable by any frontend */
  content: string;
  /** Rich content parts — optional, for frontends that support them */
  parts?: ContentPart[];
  /** Who produced this message */
  identity: MessageIdentity;
  /** Tool invocation metadata (only when role=tool_call) */
  tool?: ToolInfo;
  /** Extensible metadata — frontends ignore unknown keys */
  metadata?: Record<string, unknown>;
  timestamp: string;
  /**
   * Session sequence cursor (`replay.resume` capability): the session's
   * monotonic mutation counter at the time this frame was produced. Clients
   * track `max(seq)` per session and pass it back on `session.attach.resume`
   * to receive an incremental tail instead of a full scrollback replay.
   * Absent on daemons that predate resume, and on messages the daemon no
   * longer holds in its replay buffer.
   */
  seq?: number;
}

/**
 * Incremental update to an existing message.
 *
 * For streaming: the assistant's response arrives token by token.
 * For tool lifecycle: tool state transitions (executing → completed).
 *
 * Frontends apply deltas to the message with matching messageId.
 * If a frontend doesn't have the message (late attach), it can ignore deltas
 * and rely on the scrollback replay to get the complete state.
 */
export interface SessionMessageDelta {
  type: "session.message.delta";
  sessionId: string;
  /** References the original SessionMessage.messageId */
  messageId: string;
  /** Append to the content string */
  contentAppend?: string;
  /** Append new content parts */
  partsAppend?: ContentPart[];
  /** Replace content parts at a specific index */
  partsUpdate?: { index: number; part: ContentPart }[];
  /** Update tool state (state machine transition) */
  toolStateUpdate?: ToolState;
  timestamp: string;
  /** Session sequence cursor — see `SessionMessage.seq`. */
  seq?: number;
}

// =============================================================================
// Client → Daemon messages
// =============================================================================

/**
 * The authentication handshake — the FIRST frame a client sends on a new
 * WebSocket connection, before any `ClientMessage`. Not part of the
 * `ClientMessage` union: it carries no request `id` (the reply is `auth.ok`
 * or a socket close), and no other message is accepted until it succeeds.
 *
 * `protocolVersion` and `capabilities` make version/feature negotiation
 * bidirectional: the daemon already advertises its version on `auth.ok`;
 * these let the client declare what IT speaks, so the daemon can tailor
 * behaviour per connection (e.g. skip the plain-`content` fallback for a
 * `parts`-capable client). Both optional — clients that predate them are
 * treated as legacy (no capabilities, unknown version).
 */
export interface AuthMsg {
  type: "auth";
  /** ZeroID-issued JWT. */
  token: string;
  /** The client's compiled-in `PROTOCOL_VERSION`. */
  protocolVersion?: number;
  /** Capability identifiers the client supports — see `CAPABILITIES`. */
  capabilities?: string[];
  /** Free-form client name/version for diagnostics (e.g. "codeoid-web/0.1.3"). */
  client?: string;
}

/** Liveness heartbeat — daemon replies with `response.ok`. */
export interface PingMsg extends BaseClientMsg {
  type: "ping";
}

export interface UsageDailyMsg extends BaseClientMsg {
  type: "usage.daily";
  days?: number;
}

export type ClientMessage =
  | PingMsg
  | SessionCreateMsg
  | SessionListMsg
  | SessionAttachMsg
  | SessionDetachMsg
  | SessionSendMsg
  | SessionInterruptMsg
  | SessionApproveMsg
  | SessionUiResponseMsg
  | SessionPartActionMsg
  | SessionCommandsMsg
  | SessionDestroyMsg
  | SessionSetModeMsg
  | SessionPinMsg
  | SessionUnpinMsg
  | SessionRotateMsg
  | SessionSearchMsg
  | SessionSetModelMsg
  | SessionSetProviderMsg
  | SessionForkMsg
  | ScrollbackPageMsg
  | SessionRenameMsg
  | FsListMsg
  | FsReadMsg
  | FsBrowseDirMsg
  | ClaudeConfigMsg
  | BlackboardIndexMsg
  | BlackboardReadMsg
  | CollaborationPanelsMsg
  | ModelsListMsg
  | SessionExportMsg
  | SessionImportMsg
  | SettingsSchemaMsg
  | SettingsGetMsg
  | SettingsSetMsg
  | UsageDailyMsg
  | PipelineCreateMsg
  | PipelineListMsg
  | PipelineGetMsg
  | PipelineAdvanceMsg
  | PipelineAnswerMsg
  | PipelineAbortMsg
  | PipelineReviseMsg
  | PipelinePackListMsg
  | PipelineRegistryAddMsg
  | PipelineRegistryRefreshMsg
  | PipelinePackInstallMsg
  | PipelinePackRemoveMsg
  | PipelinePackTrustMsg
  | PipelinePackSelectMsg
  | PushRegisterMsg
  | PushUnregisterMsg;

interface BaseClientMsg {
  /** Request ID for correlating responses */
  id: string;
}

/**
 * One role in a collaborative session — a `{backend, model}` binding chosen
 * per purpose (docs/collaborative-session-design.md §3).
 *
 * `name` is deliberately a free-form string, not an enum: "a role is data,
 * not an enum". The five defaults (orchestrator / search / reasoning /
 * architecture / review) are a starting profile, so adding
 * "security-reviewer" or "test-author" stays a config change, never a code
 * change.
 */
export interface CollaborationRole {
  /** Role name, unique within the collaboration. */
  name: string;
  /**
   * Backend this role's children run on. Must be an id the daemon
   * advertised in `AuthOkMsg.providers`; an unregistered id is rejected with
   * `invalid_request` rather than silently falling back — the same
   * fail-closed rule as `SessionCreateMsg.providerId`.
   */
  providerId: string;
  /** Model within that backend. Absent = that backend's own default. */
  model?: string;
  /**
   * How many children to fan out for this role. >1 is what makes a review
   * panel a panel (§7). Absent = 1.
   */
  count?: number;
  /** What this role is for; surfaced in the child's brief. */
  purpose?: string;
  /**
   * Whether this role's children may modify the workspace.
   *
   * **Absent = false**, and that default is the point. §3 gives `review` and
   * `search` no repo write, and §6 wants a reviewer that *provably* cannot
   * write rather than one asked not to — so write authority is opt-in per
   * role and is enforced by the child's leaf identity holding no
   * `tools:write` scope at all, not by a line in a prompt.
   *
   * Maps onto the existing dispatch worker shapes: `true` → "ship",
   * `false` → "scout".
   */
  write?: boolean;
  /**
   * Blackboard artifact kinds this role may READ — `spec`, `research`, `adr`,
   * `task-list`, `diff`, `findings`, or `extra/<key>`
   * (docs/collaborative-session-design.md §4).
   *
   * Absent = the default profile for this role name from §3. A role name with
   * no profile and no declaration reads NOTHING — fail-closed in both
   * directions, because the design's standing rule is that an unenforced field
   * is false security.
   *
   * This is what makes reviewer independence structural rather than polite:
   * `review` reads `diff`+`spec` and NOT `research` (the implementer's
   * reasoning by proxy) or `findings` (its peers' opinions).
   */
  reads?: string[];
  /**
   * Blackboard artifact kinds this role may WRITE. Absent = the §3 default
   * profile for this role name; an unprofiled role that declares nothing
   * writes nothing.
   *
   * A role writing a multi-writer kind (`findings`) writes into its OWN slot,
   * chosen by the daemon — so one reviewer can never overwrite another's.
   */
  writes?: string[];
}

/** The role name that must be present exactly once in a collaboration, and
 *  which drives dispatch for the goal. */
export const ORCHESTRATOR_ROLE = "orchestrator";

/**
 * Collaborative-session config: one goal worked by several role-children on
 * possibly different backends. Set on `session.create` behind the
 * Collaborative toggle, which compiles it to an ephemeral one-goal pack
 * (§9) — pack vocabulary stays hidden on this path.
 */
export interface CollaborationConfig {
  /** The single goal this collaboration works. */
  goal: string;
  /**
   * Role→backend bindings. Exactly one role must be named "orchestrator";
   * in v1 it must sit on the claude backend, the only one that mounts the
   * fleet MCP server (non-Claude orchestrators tracked in #245).
   */
  roles: CollaborationRole[];
}

export interface SessionCreateMsg extends BaseClientMsg {
  type: "session.create";
  name: string;
  workdir: string;
  /**
   * Turn this into a collaborative session: one goal, several role-children
   * on their own backends (docs/collaborative-session-design.md). Validated
   * fail-closed — unknown provider, missing/duplicate orchestrator, or a
   * model that doesn't belong to its role's backend all reject the create.
   */
  collaboration?: CollaborationConfig;
  /**
   * Session role. "conductor" requests THE per-tenant conductor session —
   * the daemon chooses its name/workdir itself, creates it on first request,
   * and returns the existing one afterwards (idempotent). Absent = a normal
   * coding session. Typed as an open string (not the `"conductor"` literal)
   * so a future role from a newer client still type-checks on the wire; the
   * daemon rejects roles it doesn't implement.
   */
  role?: string;
  /**
   * Backend for this session (e.g. "claude", "pi"). Must be one of the ids
   * the daemon advertised in `AuthOkMsg.providers` — an id this daemon
   * doesn't have registered is rejected with `invalid_request` (fail-closed:
   * asking for pi must never silently hand back a claude session). Absent =
   * the daemon default.
   */
  providerId?: string;
  /**
   * Model for this session (docs/role-model-binding.md §6.2). Validated
   * provider-aware at create (a Claude alias on a non-Claude backend is
   * rejected); otherwise passed through — the live backend is the real
   * validator. Absent + `pack`/`packRole` = the daemon resolves through the
   * role's model-binding chain (config override → role pin → tier map);
   * absent otherwise = the provider's default.
   */
  model?: string;
  /**
   * Activate an installed SDLC pack on this session (ambient mode): inject its
   * constitution, expose its skills/subagents, and — with `packRole` — run
   * under that capability role. The daemon fail-closes on an unknown pack.
   *
   * With `collaboration`, this is pack ADOPTION (docs/role-model-binding.md
   * §6): the pack — not the collab machinery — defines what each role is.
   * Role names bind strictly to the pack's declared roles, envelopes come
   * from the role YAML, and the constitution composes pack ETHOS → goal →
   * roster under the real pack id.
   */
  pack?: string;
  /** Capability role (declared by `pack`) to run under, e.g. "reviewer"
   *  (read-only). Requires `pack`; rejected with `collaboration` (a collab's
   *  roles each carry their own envelope from the pack). */
  packRole?: string;
}

/**
 * Fork a session — branch its conversation into a brand-new session. The
 * fork gets a fresh id and starts with a COPY of the parent's canonical
 * history and scrollback, so it continues the same conversation from the
 * same point; the parent is untouched and both evolve independently.
 *
 * Optionally forks onto a DIFFERENT backend in one step (`providerId`) —
 * "branch this claude conversation and continue it on codex". The fork's
 * backing agent is always fresh (a claude session id means nothing to
 * codex), so history crosses via the same seed mechanism as
 * `session.set_provider`: stateless backends replay it natively, warm
 * backends receive a rendered transcript.
 *
 * Returns the new session's `SessionInfo` (like `session.create`). Rejected
 * with `not_found` for an unknown/foreign session and `invalid_request` for
 * an unknown `providerId` (fail-closed, same rule as create/set_provider).
 */
/**
 * Fetch a page of history OLDER than a message the client already holds
 * (`scrollback.paging` capability). Anchored by messageId — not seq — so
 * cursors survive daemon restarts and buffer rebuilds. Served from the
 * in-memory scrollback buffer when the anchor is buffered, else from the
 * on-disk JSONL transcript (history beyond the buffer cap, previously
 * unreachable by clients). Daemon answers with `scrollback.page.result`.
 */
export interface ScrollbackPageMsg extends BaseClientMsg {
  type: "scrollback.page";
  sessionId: string;
  /** The OLDEST messageId the client currently holds — pages end before it. */
  beforeMessageId: string;
  /** Soft byte budget for the page (defaults ~256 KiB, daemon-clamped). */
  maxBytes?: number;
}

export interface SessionForkMsg extends BaseClientMsg {
  type: "session.fork";
  /** Session to branch from. */
  sessionId: string;
  /** Name for the fork. Absent = the parent's name + " (fork)". */
  name?: string;
  /** Backend for the fork. Absent = the parent's current backend. */
  providerId?: string;
  /**
   * Git isolation. When the parent's workdir is a git repo, the fork gets its
   * OWN worktree + branch, seeded with the parent's current tracked working
   * state (parent untouched) — so the two sessions never collide on disk.
   * Defaults to TRUE; pass `false` to share the parent's workdir (no
   * isolation). Ignored when the workdir isn't a git repo (falls back to
   * shared with a surfaced warning) or when `workdir` is given (bind mode).
   */
  isolate?: boolean;
  /**
   * Bind the fork to an EXISTING directory/worktree you manage instead of
   * creating one. codeoid records its branch but never creates or removes it.
   */
  workdir?: string;
  /**
   * Fork the isolated worktree from THIS base ref (e.g. "main") instead of the
   * parent's current state. With a base, the worktree is a CLEAN checkout of
   * `baseBranch` — the parent's uncommitted changes are NOT carried (use the
   * default, no base, to continue from where the parent is). Implies isolation
   * (a base needs its own worktree). Ignored in bind mode (`workdir`).
   */
  baseBranch?: string;
}

/**
 * Rename a session. The daemon updates `SessionInfo.name` in memory, writes it
 * through to BOTH the sessions row and the transcript meta (so it survives a
 * daemon restart even if the session is idle), and broadcasts
 * `session.info_update` so every attached client refreshes its tab label. The
 * sessionId is stable — callers can keep using it.
 *
 * Requires the `session:approve` scope. Rejected with `invalid_request` if
 * `name` is empty or whitespace-only, if it collides with the conductor's
 * reserved name (`config.conductor.name`), or if the target is the conductor
 * session itself.
 */
export interface SessionRenameMsg extends BaseClientMsg {
  type: "session.rename";
  sessionId: string;
  name: string;
}

export interface SessionListMsg extends BaseClientMsg {
  type: "session.list";
}

export interface SessionAttachMsg extends BaseClientMsg {
  type: "session.attach";
  sessionId: string;
  /**
   * Incremental resume (`replay.resume` capability). `key` is the
   * `resumeKey` from a previous replay on this session; `sinceSeq` is the
   * highest `seq` the client has applied. When the key matches the daemon's
   * current replay buffer, the daemon replays only entries mutated after
   * `sinceSeq` (`mode: "incremental"`); on any mismatch (daemon restarted,
   * buffer rebuilt, key unknown) it falls back to a full snapshot. Omit for
   * the legacy full-replay behaviour.
   */
  resume?: { key: string; sinceSeq: number };
}

export interface SessionDetachMsg extends BaseClientMsg {
  type: "session.detach";
  sessionId: string;
}

export interface SessionSendMsg extends BaseClientMsg {
  type: "session.send";
  sessionId: string;
  text: string;
  /**
   * One-shot attachments for this turn only. Daemon resolves each path
   * (relative to the session's workdir), reads and prepends the content
   * to the effective prompt. Missing or oversized files are surfaced as
   * inline error markers rather than silently dropped.
   */
  attachments?: Attachment[];
  /**
   * Mid-turn priority hint (SDK semantics):
   *   - `now`   — interrupt the agent's current turn and observe immediately
   *   - `next`  — let the current turn finish, then pick this up
   *   - `later` — queue as a standard follow-up (default)
   * Frontends that don't care pass nothing; FIFO stays the default.
   */
  priority?: "now" | "next" | "later";
  /**
   * Idempotency key (`send.idempotency` capability). Generate ONCE per user
   * action (not per network attempt) and reuse it on retries: a send whose
   * `clientMsgId` the daemon has already processed for this session is
   * acknowledged without running a second turn. This is the guard against
   * ambiguous delivery (socket drop between send and ack) turning one prompt
   * into two billed turns. Omit to opt out (every send processes).
   */
  clientMsgId?: string;
}

export interface Attachment {
  /** File path, absolute or relative to the session workdir. */
  path: string;
  /**
   * Optional inlined text content. When provided, daemon skips the file
   * read and uses this directly — useful for paste-from-clipboard flows or
   * remote editors that push the bytes over the wire.
   */
  content?: string;
  /**
   * MIME type when the attachment carries non-text bytes (images, PDFs).
   * Combined with `data`, lets a frontend push binary payloads that the
   * daemon writes to a temp file under the session workdir so Claude's
   * Read tool can pick them up.
   */
  mimeType?: string;
  /**
   * Base64-encoded bytes. Mutually exclusive with `content` — when set,
   * `mimeType` must also be set. The daemon decodes into a temp file and
   * rewrites `path` to point at that file before handing it to Claude.
   */
  data?: string;
}

export interface SessionInterruptMsg extends BaseClientMsg {
  type: "session.interrupt";
  sessionId: string;
}

export interface SessionApproveMsg extends BaseClientMsg {
  type: "session.approve";
  sessionId: string;
  /** Correlates to ToolWaitingConfirmationState.approvalId */
  approvalId: string;
  approved: boolean;
  /**
   * Optional patch to merge into the original tool input before the SDK
   * runs the tool's `call()`. Required for form-style tools like
   * `AskUserQuestion` where the user's answers ARE the input the tool
   * needs to produce its tool_result. For binary approvals (Bash, Edit,
   * etc.) this is omitted and the daemon passes input through unchanged.
   *
   * Shape is tool-specific. For `AskUserQuestion`:
   *   `{ answers: { "<question text>": "<answer or comma-joined>" } }`
   * The daemon shallow-merges this over the original `input` before
   * returning `{ behavior: "allow", updatedInput: ... }` to the SDK.
   */
  updatedInput?: Record<string, unknown>;
}

/** Device platform for a push registration. */
export type PushPlatform = "ios" | "android";

/**
 * Register a device to receive push notifications for the authenticated
 * user's sessions. Scoped to the caller's identity (ZeroID `sub`) and tenant
 * (account/project) server-side — a client can only register its own devices.
 * `token` is the opaque transport token (an Expo push token today).
 */
export interface PushRegisterMsg extends BaseClientMsg {
  type: "push.register";
  token: string;
  platform: PushPlatform;
}

/** Remove a previously-registered device token (e.g. on sign-out). */
export interface PushUnregisterMsg extends BaseClientMsg {
  type: "push.unregister";
  token: string;
}

/**
 * Answer a provider-initiated dialog (`session.ui_request`). Exactly one of
 * the payload fields applies per method:
 *   - select / input / editor → `value` (the chosen option / entered text)
 *   - confirm                 → `confirmed`
 *   - any method             → `cancelled: true` to dismiss
 * The first response for a `requestId` wins; the daemon broadcasts
 * `session.ui_resolved` so every other attached client dismisses its copy.
 * A response for a request that is no longer pending gets `not_found`.
 */
export interface SessionUiResponseMsg extends BaseClientMsg {
  type: "session.ui_response";
  sessionId: string;
  /** Echoes `SessionUiRequestMsg.requestId`. */
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/**
 * Activate a `ButtonPart` the daemon previously sent in a message's
 * `parts[]`. The daemon validates that `messageId` really carries a button
 * with this `action` (clients can't mint arbitrary provider calls) and
 * forwards it to the session's provider. Providers that don't handle
 * actions reject with `invalid_request`.
 */
export interface SessionPartActionMsg extends BaseClientMsg {
  type: "session.part_action";
  sessionId: string;
  /** The message whose `parts[]` contains the button. */
  messageId: string;
  /** `ButtonPart.action`, verbatim. */
  action: string;
  /** `ButtonPart.data`, verbatim (optional). */
  data?: Record<string, unknown>;
}

/**
 * Fetch the session's provider-defined command catalog — slash commands
 * contributed by the backing provider (e.g. pi extension commands, prompt
 * templates, skills). Invocation needs no dedicated verb: send the command
 * as plain `session.send` text (`"/name args"`); the provider expands it.
 * Gated on the daemon capability `commands.dynamic`.
 */
export interface SessionCommandsMsg extends BaseClientMsg {
  type: "session.commands";
  sessionId: string;
}

/** One provider-defined slash command (see `SessionCommandsMsg`). */
export interface ProviderCommand {
  /** Invokable name without the leading slash. */
  name: string;
  description?: string;
  /**
   * Provider-specific origin taxonomy (e.g. "extension" | "prompt" |
   * "skill"). Open string — clients display it verbatim, never switch on it.
   */
  source?: string;
  /** Optional argument hint for palette display (e.g. "<env>"). */
  argumentHint?: string;
}

export interface SessionDestroyMsg extends BaseClientMsg {
  type: "session.destroy";
  sessionId: string;
}

export interface SessionSetModeMsg extends BaseClientMsg {
  type: "session.set_mode";
  sessionId: string;
  mode: SessionMode;
  /** Only meaningful for `autonomous`; undefined = unbounded. */
  maxTurns?: number;
}

/**
 * Manage the session's pinned-files list. Pinned files get prepended to
 * every turn until unpinned — useful for keeping a spec document or
 * acceptance criteria in Claude's attention across a long task.
 */
export interface SessionPinMsg extends BaseClientMsg {
  type: "session.pin";
  sessionId: string;
  /** File path (absolute or relative to the session workdir). */
  path: string;
}

export interface SessionUnpinMsg extends BaseClientMsg {
  type: "session.unpin";
  sessionId: string;
  path: string;
}

/**
 * Manually rotate the session's backing Claude Code context. Keeps the
 * user-visible session id + scrollback + memory unchanged; starts a fresh
 * Claude Code transcript. Rejected if the session has fewer turns than
 * the configured min-turns-before-rotate.
 */
export interface SessionRotateMsg extends BaseClientMsg {
  type: "session.rotate";
  sessionId: string;
}

/**
 * Switch the BACKEND of a live session (e.g. claude → pi and back). The
 * session id, scrollback, transcript, and identity all stay; the backing
 * agent is torn down and replaced, and the accumulated canonical history is
 * handed to the incoming provider (`seedFromHistory`) so it can continue
 * the conversation. Fidelity contract: STATELESS backends (gemini, openai)
 * replay the history in their native structure (real function-call turns)
 * on every subsequent request; WARM backends (claude, pi) receive a
 * faithful structured-text transcript prepended to their first prompt —
 * neither accepts synthesized native-history injection, so prompt cache
 * and extension state still do not survive the switch.
 *
 * Rejected with `invalid_request` when the provider is unknown (fail-closed,
 * same rule as `session.create`) or the session is mid-turn — interrupt
 * first, then switch.
 */
export interface SessionSetProviderMsg extends BaseClientMsg {
  type: "session.set_provider";
  sessionId: string;
  /** One of the ids from `AuthOkMsg.providers`. */
  providerId: string;
}

/**
 * Switch the model (and optionally fallback) for a session. Accepts
 * aliases (`opus`/`sonnet`/`haiku`) or full Anthropic model ids. Takes
 * effect on the next send — the current streamInput loop is torn down so
 * the new model is handed to the fresh `query()` invocation. Switching
 * invalidates the prompt cache (Anthropic cache is per-model), so the
 * first turn on the new model is a full re-cache cost.
 *
 * Passing `fallbackModel: null` clears any previous fallback; omitting
 * the field leaves it unchanged.
 */
export interface SessionSetModelMsg extends BaseClientMsg {
  type: "session.set_model";
  sessionId: string;
  model: string;
  fallbackModel?: string | null;
}

/**
 * Full-text + semantic search across ALL sessions in a workspace — the
 * human-facing counterpart to Claude's `recall()` tool. Searches over
 * every user message, Claude reply, tool call, tool result, and reasoning
 * block stored in memory. Combines FTS5 BM25 (exact-keyword match) with
 * vector similarity (semantic) + recency + session-name boost.
 *
 * Returns a ranked list of SESSIONS (not a flat list of episodes) with
 * evidence snippets so frontends can render previews without a second
 * round-trip. Pick a session → re-attach to jump into it.
 */
export interface SessionSearchMsg extends BaseClientMsg {
  type: "session.search";
  query: string;
  /** Scope of the search. Default: `workspace` = sessions in the current workdir's workspace. */
  scope?: "workspace" | "all";
  /**
   * Anchor workspace. When `scope="workspace"` and this is unset, the
   * daemon infers from the requesting client's current focus — if the
   * client doesn't have one either, it falls back to cross-workspace.
   */
  workdir?: string;
  /** Max results to return. Default 10. */
  limit?: number;
}

/** Per-session hit returned by session.search. */
export interface SessionSearchHit {
  sessionId: string;
  sessionName: string;
  workdir: string;
  /** Number of matching episodes within the session. */
  matchCount: number;
  firstMatchAt: number;
  lastMatchAt: number;
  /** Aggregate rank score (higher = more relevant). */
  aggregateScore: number;
  /** Top evidence snippets from the session. */
  snippets: SessionSearchSnippet[];
}

/** A single evidence snippet inside a SessionSearchHit. */
export interface SessionSearchSnippet {
  episodeId: string;
  kind: "user_turn" | "assistant_turn" | "tool_call" | "error";
  toolName?: string;
  summary: string;
  /** Query-centered excerpt (~240 chars). */
  excerpt: string;
  createdAt: number;
  /** Hybrid recall score (0..~1). */
  score: number;
  filePaths: string[];
}

// =============================================================================
// File system — read-only access scoped to a session's workdir.
//
// Path semantics: `path` is relative to `session.workdir`. Empty string,
// "." or "/" all mean "the workdir root". Daemon canonicalises and rejects
// any path that resolves outside the workdir (symlink escapes blocked).
// =============================================================================

export interface FsListMsg extends BaseClientMsg {
  type: "fs.list";
  sessionId: string;
  /** Path relative to the session's workdir. */
  path: string;
}

/**
 * Session-less directory browse. Used by the new-session UI to let the
 * user pick a workdir without typing a full path. Daemon resolves
 * `path` (or HOME when omitted) against a configured root (HOME by
 * default), canonicalises, and rejects paths that escape it.
 */
export interface FsBrowseDirMsg extends BaseClientMsg {
  type: "fs.browse_dir";
  /** Absolute path to browse. Defaults to the daemon user's HOME. */
  path?: string;
}

/**
 * Request a Claude Code configuration snapshot for the focused
 * session — agents, skills, MCP servers, hooks. Read-only.
 */
export interface ClaudeConfigMsg extends BaseClientMsg {
  type: "claude.config";
  sessionId: string;
}

/**
 * List what a collaboration's goal blackboard holds — kind, slot, version,
 * author, size — without any artifact bodies
 * (docs/collaborative-session-design.md §4).
 *
 * `sessionId` may name either the orchestrator or any of its role-children;
 * the daemon resolves a child to its parent's goal. Every client would
 * otherwise have to duplicate that hop, and getting it wrong yields a
 * confusing empty board rather than an error.
 */
export interface BlackboardIndexMsg extends BaseClientMsg {
  type: "blackboard.index";
  sessionId: string;
}

/**
 * Live panel state for a collaboration — which fan-outs are in flight and how
 * far along each member is (docs/collaborative-session-design.md §7).
 *
 * Exists because nothing else on the wire carries it. A panel's whole point is
 * that N agents work AT ONCE, and a client could previously see the fleet and
 * the joined result but never the parallelism itself — the most legible part of
 * the feature was the one part invisible to the UI.
 *
 * `sessionId` may name the orchestrator or any of its role-children; the daemon
 * resolves a child to its parent's goal, exactly as `blackboard.index` does.
 */
export interface CollaborationPanelsMsg extends BaseClientMsg {
  type: "collaboration.panels";
  sessionId: string;
}

/**
 * Read one artifact body from a collaboration's goal blackboard.
 *
 * Unlike the agent-facing `blackboard_read` MCP tool, this is NOT filtered by
 * a role's read scope: role scoping exists to keep the agents independent of
 * each other (§6 — a reviewer that can read its peers is an echo, not a
 * panel), which says nothing about the human who owns the goal and can already
 * read every child's transcript.
 */
export interface BlackboardReadMsg extends BaseClientMsg {
  type: "blackboard.read";
  sessionId: string;
  /** A core kind (`spec`, `research`, …) or `extra/<key>`. */
  kind: string;
  /** Multi-writer slot as reported by the index; omit for the singleton. */
  slot?: string | null;
  /** A specific version; omit for the latest. Writes never overwrite, so
   *  older versions stay readable for auditing a handoff after the fact. */
  version?: number;
}

/**
 * Ask the daemon for the model catalog the Claude Code backend actually
 * supports (via the SDK's `supportedModels()`), rather than a hardcoded
 * list that goes stale. Daemon-wide — no sessionId. Returns the cached
 * live list, or a built-in fallback if no session has initialized yet.
 */
export interface ModelsListMsg extends BaseClientMsg {
  type: "models.list";
  /**
   * Which provider's catalog to return. Optional and additive — omitted by
   * older clients, in which case the daemon's default provider is assumed.
   */
  provider?: string;
}

/** One selectable model as reported by the Claude Code backend. */
export interface ModelInfo {
  /** Value passed to `/model` and forwarded to the SDK (e.g. "opus[1m]"). */
  value: string;
  /** Human label (e.g. "Opus"). */
  displayName: string;
  /** Optional one-line description from the backend. */
  description?: string;
  /** True for the backend's recommended default. */
  isDefault?: boolean;
}

/**
 * Export a session as a `ShareBundle` JSON. Daemon resolves a workdir
 * alias (from git remote when available), rewrites every absolute path
 * to `${alias}/${relative}`, and returns either the full bundle inline
 * (small sessions) or writes it to `~/.codeoid/exports/` and returns
 * the on-disk path.
 */
export interface SessionExportMsg extends BaseClientMsg {
  type: "session.export";
  sessionId: string;
  /** Slice memory episodes for this session into the bundle. Default true. */
  includeMemory?: boolean;
  /** Snapshot pinned files into the bundle. Default false (size). */
  includePinnedFiles?: boolean;
  /** Override the auto-resolved alias. Useful for non-git workdirs. */
  aliasOverride?: string;
  /** Force on-disk file output regardless of size. Default: file when > 5 MB. */
  toFile?: boolean;
}

/**
 * Import a session bundle into a fresh session id. The importer's
 * `targetWorkdir` is the local path the bundle anchors to —
 * `${alias}/...` paths get rewritten to this workdir on the way in.
 */
export interface SessionImportMsg extends BaseClientMsg {
  type: "session.import";
  /** Either inline bundle JSON (object) OR a path to a previously-saved file. */
  source: { kind: "inline"; bundle: unknown } | { kind: "file"; path: string };
  targetWorkdir: string;
  /** Override the imported session's name. Default = original name. */
  nameOverride?: string;
  /** Materialise pinnedFiles into targetWorkdir. Default false. */
  writePinnedFiles?: boolean;
}

export type ClaudeConfigScope = "global" | "workdir";

export interface ClaudeConfigAgent {
  name: string;
  description: string | null;
  /** Absolute path to the source `*.md` file. */
  path: string;
  scope: ClaudeConfigScope;
  /** Comma-separated tools list parsed from frontmatter, when set. */
  tools?: string[];
}

export interface ClaudeConfigSkill {
  name: string;
  description: string | null;
  path: string;
  scope: ClaudeConfigScope;
}

export interface ClaudeConfigMcpServer {
  name: string;
  scope: ClaudeConfigScope;
  /** Absolute path to the source file that declared it
   * (`~/.claude.json`, `settings.json`, `.mcp.json`, …). */
  path: string;
  /** stdio command, when present. */
  command: string | null;
  args: string[];
  /** Just the keys of the `env` block (values are secrets, never returned). */
  envKeys: string[];
  /** http URL for non-stdio servers. */
  url: string | null;
  /** Optional `type` field (e.g. "http"). */
  type: string | null;
  /** Just the keys of the `headers` block for http-type servers
   * (values are bearer tokens / API keys, never returned). */
  headerKeys?: string[];
  /**
   * Live connection status the SDK reported for this server name on the
   * most recent `system/init` event for this session. `undefined` when the
   * SDK hasn't started a turn yet (drawer opened before first send) or the
   * server name didn't match any SDK-reported entry. The SDK uses values
   * like `"connected"`, `"failed"`, `"pending"` — we surface the string
   * verbatim so we don't lock in an enum.
   */
  liveStatus?: string;
  /**
   * MCP tool names the SDK exposed in this session for this server,
   * fully-qualified (`mcp__<server>__<tool>`). Empty array means the server
   * connected but exposed no tools; `undefined` means we have no SDK-side
   * data yet.
   */
  liveTools?: string[];
}

export interface ClaudeConfigHook {
  /** Hook event name (e.g. "PreToolUse", "PostToolUse"). */
  event: string;
  scope: ClaudeConfigScope;
  /** Absolute path to the source `settings.json`. */
  path: string;
  /** Tool-name matcher pattern, when present. */
  matcher: string | null;
  /** Hook kind ("command" today; future-proof). */
  kind: string;
  /** The shell command to run. */
  command: string;
}

export interface ClaudeConfigSnapshot {
  agents: ClaudeConfigAgent[];
  skills: ClaudeConfigSkill[];
  mcpServers: ClaudeConfigMcpServer[];
  hooks: ClaudeConfigHook[];
}

export interface FsReadMsg extends BaseClientMsg {
  type: "fs.read";
  sessionId: string;
  path: string;
  /** Hard cap in bytes; daemon also enforces an absolute ceiling. Default 1 MiB. */
  maxBytes?: number;
}

export interface FsEntry {
  /** Just the file or directory name (no path). */
  name: string;
  /** Path relative to the session's workdir. */
  path: string;
  kind: "file" | "directory";
  /** Bytes for files; undefined for directories. */
  size?: number;
  /** Modified time as Unix ms. */
  mtimeMs?: number;
  /** True when this entry is a symlink (kind reflects the resolved target). */
  isSymlink?: boolean;
}

export interface FsListResultMsg {
  type: "fs.list.result";
  requestId: string;
  /** Echoed `path` (canonicalised, still relative to workdir). */
  path: string;
  entries: FsEntry[];
}

export interface FsReadResultMsg {
  type: "fs.read.result";
  requestId: string;
  path: string;
  /** UTF-8 text. Binary files come back base64-encoded with `encoding: "base64"`. */
  content: string;
  encoding: "utf-8" | "base64";
  /** Total size on disk in bytes (may be larger than content if `truncated`). */
  size: number;
  /** Detected language hint for syntax highlighting (best-effort, may be undefined). */
  language?: string;
  /** True when content was clipped at maxBytes. */
  truncated: boolean;
}

export interface FsBrowseDirResultMsg {
  type: "fs.browse_dir.result";
  requestId: string;
  /** Canonical absolute path that was browsed. */
  path: string;
  /** Configured root that bounds the browse (HOME by default). */
  root: string;
  /** Parent path (canonical) — null when `path` is at the root. */
  parent: string | null;
  /** Directory entries; daemon only emits directories for this verb. */
  entries: FsEntry[];
}

export interface ClaudeConfigResultMsg {
  type: "claude.config.result";
  requestId: string;
  /** Workdir the snapshot was taken against. */
  workdir: string;
  agents: ClaudeConfigAgent[];
  skills: ClaudeConfigSkill[];
  mcpServers: ClaudeConfigMcpServer[];
  hooks: ClaudeConfigHook[];
}

/** One member of a dispatch group, as a client sees it. */
export interface CollaborationPanelMember {
  /** Target session id. Null for a member with no session (a spawn-shaped one). */
  sessionId: string | null;
  /** 1-based position within the fan-out, as dispatched — stable across reads. */
  ordinal: number;
  /**
   * Queue state. Terminal values are `done` / `failed` / `blocked`; the barrier
   * fires once every member reaches one, which is why a client can render
   * "2 of 3 settled" without knowing the barrier's rules.
   */
  status: "queued" | "claimed" | "running" | "done" | "failed" | "blocked";
}

/** One fan-out (a dispatch group) and how far along it is. */
export interface CollaborationPanel {
  groupId: string;
  /** Epoch ms the fan-out was queued. */
  createdAt: number;
  /** Members in fan-out order. */
  members: CollaborationPanelMember[];
  /** How many members have reached a terminal state. */
  settled: number;
  /** True once every member is terminal — i.e. the barrier has joined. */
  joined: boolean;
}

export interface CollaborationPanelsResultMsg {
  type: "collaboration.panels.result";
  requestId: string;
  /** The GOAL session — the orchestrator, even when a child was asked for. */
  sessionId: string;
  /** Newest fan-out first. */
  panels: CollaborationPanel[];
}

/** One index row: what exists, at what version, by whom — never a body. */
export interface BlackboardIndexEntry {
  /** A core kind (`spec`, `research`, …) or `extra/<key>`. */
  kind: string;
  /** Multi-writer discriminator (`review#2`); null = the singleton slot. */
  slot: string | null;
  /** Latest version present. Writes append, so this only ever grows. */
  version: number;
  /** ZeroID subject of the producing agent. */
  authorSub: string;
  /** Collaboration role that wrote it, when written by a role-child. */
  authorRole: string | null;
  /** Epoch ms of the latest version. */
  updatedAt: number;
  /** Body size of the latest version, so a client can warn before fetching. */
  bytes: number;
}

export interface BlackboardIndexResultMsg {
  type: "blackboard.index.result";
  requestId: string;
  /** The GOAL session — the orchestrator, even when a child was asked for. */
  sessionId: string;
  /** The collaboration's goal text, for labelling the board. */
  goal: string;
  entries: BlackboardIndexEntry[];
}

/** One artifact version, body included. */
export interface BlackboardArtifact {
  kind: string;
  slot: string | null;
  version: number;
  content: string;
  authorSub: string;
  authorRole: string | null;
  createdAt: number;
}

export interface BlackboardReadResultMsg {
  type: "blackboard.read.result";
  requestId: string;
  /** The GOAL session — the orchestrator, even when a child was asked for. */
  sessionId: string;
  /** Null when nothing has been written to that kind/slot/version yet. Not an
   *  error: "the searcher hasn't produced research yet" is a normal state of a
   *  collaboration in flight, and clients render it as pending. */
  artifact: BlackboardArtifact | null;
}

export interface ModelsListResultMsg {
  type: "models.list.result";
  requestId: string;
  models: ModelInfo[];
  /**
   * True when these came from the live backend this daemon lifetime;
   * false = persisted last-known list or built-in fallback.
   */
  live: boolean;
  /** Provider whose catalog this is (e.g. "claude", "gemini"). */
  provider: string;
}

export interface SessionExportResultMsg {
  type: "session.export.result";
  requestId: string;
  /** Manifest preview — same shape that ships inside the bundle. */
  manifest: {
    exportedAt: string;
    session: {
      id: string;
      name: string;
      createdAt: string;
      model?: string;
      mode?: string;
    };
    workdir: { alias: string; aliasSource: string; originalAbsolute: string };
    counts: {
      messages: number;
      episodes: number;
      turns: number;
      pinnedFiles: number;
    };
  };
  /**
   * The bundle itself. Either inline as a JSON-encoded object (for small
   * sessions) OR `{ kind: "file"; path }` pointing at a file the daemon
   * wrote under `~/.codeoid/exports/`.
   */
  payload:
    | { kind: "inline"; bundle: unknown; sizeBytes: number }
    | { kind: "file"; path: string; sizeBytes: number };
}

export interface SessionImportResultMsg {
  type: "session.import.result";
  requestId: string;
  newSessionId: string;
  importedMessages: number;
  importedEpisodes: number;
  importedTurns: number;
  pinnedFilesWritten: number;
  warnings: string[];
}

// =============================================================================
// Provider-initiated UI — generic dialogs any backend can raise.
//
// A provider (or one of its extensions) may need an answer from the human
// mid-session: a confirmation gate, a pick-one list, a line of text. These
// are NOT tool approvals — they carry no tool input to audit — so they get
// their own request/response pair instead of piggybacking on
// `waiting_confirmation`.
//
// Lifecycle: daemon broadcasts `session.ui_request` to attached clients that
// declared the `ui.dialogs` capability (and re-sends pending requests on
// attach). The first `session.ui_response` wins; the daemon then broadcasts
// `session.ui_resolved` so every client dismisses its copy. `timeoutMs`
// requests auto-resolve as cancelled on expiry — the daemon enforces the
// deadline, clients only display the countdown.
// =============================================================================

export type UiRequestMethod = "select" | "confirm" | "input" | "editor";

export interface SessionUiRequestMsg {
  type: "session.ui_request";
  sessionId: string;
  /** Unique id — clients echo it on `session.ui_response`. */
  requestId: string;
  method: UiRequestMethod;
  /** Short prompt title (always present). */
  title: string;
  /** Longer body text (confirm dialogs; optional elsewhere). */
  message?: string;
  /** Choices for `method: "select"`. */
  options?: string[];
  /** Input placeholder for `method: "input"`. */
  placeholder?: string;
  /** Prefilled text for `method: "editor"` (and optionally "input"). */
  prefill?: string;
  /** Auto-cancel deadline in ms from `timestamp`. Absent = waits for a user. */
  timeoutMs?: number;
  timestamp: string;
}

export interface SessionUiResolvedMsg {
  type: "session.ui_resolved";
  sessionId: string;
  requestId: string;
  /** Why it settled. Open string — clients treat unknown values as "dismiss". */
  reason: "answered" | "cancelled" | "timeout" | "interrupted";
  timestamp: string;
}

/** Reply to `session.commands` — the provider's current command catalog. */
export interface SessionCommandsResultMsg {
  type: "session.commands.result";
  requestId: string;
  sessionId: string;
  /** Provider these commands belong to (e.g. "pi"). */
  providerId: string;
  commands: ProviderCommand[];
}

// =============================================================================
// Daemon → Client messages
// =============================================================================

// ── SDLC pipeline (docs/sdlc-pipeline.md) — additive; no version bump ─────────

/** A pipeline phase projected for the wire (subset of the daemon PhaseState). */
export interface PipelinePhaseWire {
  id: string;
  name?: string;
  status: "pending" | "running" | "halted" | "passed" | "skipped" | "failed";
  /** Capability role this phase runs under (from the pack) — a client can render
   *  the phase's tool envelope (e.g. a read-only reviewer). */
  role?: string;
  /** The phase's bound backend/model + which precedence rung chose it
   *  (docs/role-model-binding.md §3) — resolved once at create and persisted,
   *  so a client can render "claude:claude-fable-5 ← config-tier" and name the
   *  layer to fix when a model id fails at spawn. Absent = provider default. */
  provider?: string;
  model?: string;
  resolvedFrom?: string;
  summary?: string;
  reason?: string;
  /** Set when status==="halted" — echo back in pipeline.answer / pipeline.revise. */
  requestId?: string;
  questions?: string[];
  /** Human revise notes accumulated on this phase (newest last) — the client
   *  renders the revision history. */
  feedback?: string[];
}

/** A pipeline projected for the wire (serializable subset of PipelineState). */
export interface PipelineWire {
  id: string;
  name: string;
  status: "draft" | "running" | "halted" | "merged" | "done" | "failed" | "abandoned";
  cursor: number;
  phases: PipelinePhaseWire[];
  spec?: string;
  workdir?: string;
  /** The bound run-session the phases stream into — a client can auto-attach it
   *  so the run shows up as a normal, interruptible chat. */
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

/** A phase definition supplied by a client creating a pipeline (mirrors the
 *  daemon PhaseDef). Referenced kind/gate/skill ids must be registered. */
export interface PhaseDefWire {
  id: string;
  name?: string;
  kind: string;
  skill?: string;
  gate?: string;
  entryGate?: string;
  provider?: string;
  model?: string;
  /** Capability role this phase runs under (an id into the pack's roles). */
  role?: string;
  /** Reserved metadata (not yet consumed): typed artifact ids (§5a.2). */
  reads?: string[];
  writes?: string;
  onFail?: { action: "halt" } | { action: "retry"; max: number } | { action: "abort" };
}

export interface PipelineCreateMsg extends BaseClientMsg {
  type: "pipeline.create";
  name: string;
  /** Explicit phase plan. Provide this OR `pack` (not both). If neither is
   *  given, the daemon's configured `defaultPack` is used. */
  phases?: PhaseDefWire[];
  /** Id of an installed pack whose pipeline this run uses (see pipeline.packs
   *  config). Mutually exclusive with `phases`. */
  pack?: string;
  spec?: string;
  workdir?: string;
  /** Backend for the run's bound session (default: the daemon's default provider). */
  providerId?: string;
  /** Invocation-time role→model bindings (CLI `--role`), keyed by role name —
   *  the highest-precedence rung of the model-binding chain
   *  (docs/role-model-binding.md §3). Keys must name roles the plan declares;
   *  an unknown role or provider is a create-time error. */
  roleBindings?: Record<string, { provider: string; model?: string }>;
}
export interface PipelineListMsg extends BaseClientMsg {
  type: "pipeline.list";
}
export interface PipelineGetMsg extends BaseClientMsg {
  type: "pipeline.get";
  pipelineId: string;
}
/** Drive a pipeline until it halts or reaches a terminal status. */
export interface PipelineAdvanceMsg extends BaseClientMsg {
  type: "pipeline.advance";
  pipelineId: string;
}
export interface PipelineAbortMsg extends BaseClientMsg {
  type: "pipeline.abort";
  pipelineId: string;
}
/** Revise a halted phase — re-run it with human feedback (the Approve / Revise /
 *  Reject loop, docs/pipeline-run.md). */
export interface PipelineReviseMsg extends BaseClientMsg {
  type: "pipeline.revise";
  pipelineId: string;
  /** Echoes the halted phase's requestId. */
  requestId: string;
  /** The feedback/opinions the phase should re-iterate on. */
  feedback: string;
}
/** Answer a halted phase (mirrors session.ui_response). */
export interface PipelineAnswerMsg extends BaseClientMsg {
  type: "pipeline.answer";
  pipelineId: string;
  /** Echoes the halted phase's requestId. */
  requestId: string;
  approved: boolean;
  /** Free-text — becomes the phase summary (approve) or fail reason (reject). */
  value?: string;
}

/** Single-pipeline reply to pipeline.create / get / answer / abort. */
export interface PipelineSnapshotMsg {
  type: "pipeline.snapshot";
  requestId: string;
  pipeline: PipelineWire;
}
/** Reply to pipeline.list. */
export interface PipelineListResultMsg {
  type: "pipeline.list.result";
  requestId: string;
  pipelines: PipelineWire[];
}

// ── Pack management (dynamic pack loading — docs/pack-loading.md) ──────────────

/** A phase of a pack's pipeline, projected for a pack card. */
export interface PackPhaseWire {
  id: string;
  name?: string;
  /** Capability role (e.g. reviewer = read-only) — lets the UI show the envelope. */
  role?: string;
  /** Exit-gate id, if the phase declares one. */
  gate?: string;
}

/** One declared role's effective model binding under the daemon's CURRENT
 *  config with no CLI overrides — the pre-flight view (`pack show --resolve`,
 *  docs/role-model-binding.md §4). Phase-level pins are deliberately excluded
 *  from this per-role view and listed separately (`PackWire.phasePins`). */
export interface PackResolvedRoleWire {
  name: string;
  /** The role's semantic capability class, if it declares one. */
  tier?: string;
  provider?: string;
  model?: string;
  /** Which precedence rung produced the binding ("config-role" | "role-pin" |
   *  "config-tier" | "default"). */
  resolvedFrom: string;
}

/** A phase-level concrete `provider:`/`model:` pin from pack.yaml — surfaced
 *  separately so a stale pin stays visible next to the tier map's choice. */
export interface PackPhasePinWire {
  phase: string;
  provider?: string;
  model?: string;
}

/** An installed pack + its metadata + trust/selected state, for the browser. */
export interface PackWire {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Absolute directory the pack loaded from. */
  dir: string;
  /** Whether the host trusts this pack to run shell `command` gates. */
  trusted: boolean;
  /** True when this is the selected (default) pack. */
  selected: boolean;
  /** Registry name this pack came from, if it was installed from one. */
  registry?: string;
  phases: PackPhaseWire[];
  /** Capability role names the pack declares. */
  roles: string[];
  /** Gate ids + kinds the pack declares. */
  gates: { id: string; kind: string }[];
  /** Whether the pack is registered into the live pipeline manager (runnable). */
  active: boolean;
  /** Pre-flight model-binding view (docs/role-model-binding.md §4): each
   *  declared role's currently-effective binding under this daemon's config,
   *  no CLI overrides. Absent on a broken pack. */
  resolvedRoles?: PackResolvedRoleWire[];
  /** Phase-level concrete pins from pack.yaml, listed separately from the
   *  per-role view so staleness is visible. Absent on a broken pack. */
  phasePins?: PackPhasePinWire[];
  /** Present when the configured pack dir could not be loaded (bad/missing
   *  pack.yaml) — the card renders as broken rather than vanishing silently. */
  error?: string;
}

/** A pack found in a cached registry but not yet installed. */
export interface AvailablePackWire {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Registry name it was discovered in. */
  registry: string;
  /** Absolute directory in the registry cache. */
  dir: string;
  /** True when a pack with this id is already installed. */
  installed: boolean;
}

/** A configured pack registry (a git repo) + its cache status. */
export interface RegistryWire {
  name: string;
  url: string;
  ref?: string;
  /** True once the registry has been cloned into the local cache. */
  cached: boolean;
  /** Number of packs discovered in the cache (undefined if not cached). */
  packCount?: number;
}

export interface PipelinePackListMsg extends BaseClientMsg {
  type: "pipeline.pack.list";
}
export interface PipelineRegistryAddMsg extends BaseClientMsg {
  type: "pipeline.registry.add";
  url: string;
  name?: string;
  ref?: string;
}
export interface PipelineRegistryRefreshMsg extends BaseClientMsg {
  type: "pipeline.registry.refresh";
  /** Registry name to refresh. Omit to refresh all configured registries. */
  name?: string;
}
export interface PipelinePackInstallMsg extends BaseClientMsg {
  type: "pipeline.pack.install";
  /** Install a pack discovered in a registry cache by its id … */
  packId?: string;
  /** … or install directly from a local pack directory. Exactly one of the two. */
  dir?: string;
  /** Trust the pack to run host `command` gates. Default false. */
  trusted?: boolean;
}
export interface PipelinePackRemoveMsg extends BaseClientMsg {
  type: "pipeline.pack.remove";
  packId: string;
}
export interface PipelinePackTrustMsg extends BaseClientMsg {
  type: "pipeline.pack.trust";
  packId: string;
  trusted: boolean;
}
export interface PipelinePackSelectMsg extends BaseClientMsg {
  type: "pipeline.pack.select";
  /** null clears the selected (default) pack. */
  packId: string | null;
}

/** Reply to pipeline.pack.list — and to every mutating pack verb, so a client
 *  always receives the refreshed pack state after an add/install/remove/etc. */
export interface PackListResultMsg {
  type: "pipeline.pack.list.result";
  requestId: string;
  installed: PackWire[];
  available: AvailablePackWire[];
  registries: RegistryWire[];
}

// =============================================================================

export type DaemonMessage =
  | AuthOkMsg
  | ResponseOkMsg
  | ResponseErrorMsg
  | SessionListResultMsg
  | SessionMessage
  | SessionMessageDelta
  | SessionStatusChangeMsg
  | SessionInfoUpdateMsg
  | SessionUiRequestMsg
  | SessionUiResolvedMsg
  | SessionCommandsResultMsg
  | ScrollbackReplayMsg
  | ScrollbackPageResultMsg
  | SessionSearchResultMsg
  | FsListResultMsg
  | FsReadResultMsg
  | FsBrowseDirResultMsg
  | ClaudeConfigResultMsg
  | BlackboardIndexResultMsg
  | BlackboardReadResultMsg
  | CollaborationPanelsResultMsg
  | ModelsListResultMsg
  | SessionExportResultMsg
  | SessionImportResultMsg
  | SettingsSchemaResultMsg
  | SettingsGetResultMsg
  | SettingsSetResultMsg
  | PipelineSnapshotMsg
  | PipelineListResultMsg
  | PackListResultMsg;

export interface AuthOkMsg {
  type: "auth.ok";
  /** Authenticated identity */
  identity: MessageIdentity;
  scopes: readonly string[];
  /**
   * Wire-protocol version the daemon speaks. Clients compare this against
   * their own compiled-in `PROTOCOL_VERSION` to detect drift. Older clients
   * that predate this field will see `undefined` and skip the check.
   */
  protocolVersion?: number;
  /**
   * Capability identifiers the daemon supports — see `CAPABILITIES`.
   * Clients feature-detect on this instead of version-sniffing. Absent on
   * daemons that predate capability negotiation.
   */
  capabilities?: string[];
  /**
   * Provider ids registered on this daemon (e.g. ["claude", "gemini",
   * "openai", "pi"]), first entry = the default. Feed the new-session
   * provider picker from this; absent on daemons that predate multi-provider
   * session creation (assume claude-only).
   */
  providers?: string[];
  /**
   * Which issuer authenticated this connection.
   *
   * - `"zeroid"` — a ZeroID-issued JWT was verified cryptographically. The
   *   identity is real: attributable, delegatable, revocable.
   * - `"local"` — the daemon is running in local mode (`codeoid start --local`)
   *   and accepted a locally-minted token. The principal is SELF-ASSERTED:
   *   there is no per-agent identity, no delegation, no revocation, and audit
   *   attribution is not cryptographic.
   *
   * Clients MUST surface `"local"` visibly (a badge, a banner — not a tooltip):
   * the failure mode this field exists to prevent is someone demonstrating an
   * identity-first control plane in the one mode that has no identity. Absent
   * on daemons that predate the field; treat absent as `"zeroid"`.
   */
  authMode?: "zeroid" | "local";
}

export interface ResponseOkMsg {
  type: "response.ok";
  requestId: string;
  data?: unknown;
}

export interface ResponseErrorMsg {
  type: "response.error";
  requestId: string;
  error: string;
  code: ErrorCode;
}

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "internal";

export interface SessionListResultMsg {
  type: "session.list.result";
  requestId: string;
  sessions: SessionInfo[];
}

export interface SessionStatusChangeMsg {
  type: "session.status_change";
  sessionId: string;
  status: SessionStatus;
  timestamp: string;
}

/**
 * Broadcast when non-status fields of a SessionInfo change (e.g. execution
 * mode, turns-remaining). Carries the full updated SessionInfo so clients
 * can merge without a separate list refresh.
 */
export interface SessionInfoUpdateMsg {
  type: "session.info_update";
  session: SessionInfo;
  timestamp: string;
}

/**
 * Sent on client attach — replays recent session messages so the
 * client sees what happened while disconnected (device handoff).
 *
 * Contains full SessionMessage objects (not deltas). The scrollback
 * buffer merges deltas into complete messages before replay.
 *
 * Chunked replay (`seq`/`final`, additive & optional — #84): when a
 * session's scrollback is too large to flush as one WS frame under the
 * server's outbound backpressure limit, the daemon splits it into ordered
 * chunks (oldest→newest) and paces them on socket drain. `seq` is the
 * 0-based chunk index; `final` marks the last chunk. Both are ABSENT on a
 * single-frame replay (the legacy shape). Clients: reset scrollback when
 * `seq` is absent or 0, append when `seq > 0`, and treat the replay as
 * complete on `final` (or when `seq` is absent). Clients that predate these
 * fields ignore them and replace on each frame — ending on the newest chunk,
 * which degrades gracefully rather than crashing.
 */
/** Answer to `scrollback.page` — a window of history strictly OLDER than the
 * requested anchor, oldest→newest. Clients PREPEND (upsert by messageId). */
export interface ScrollbackPageResultMsg {
  type: "scrollback.page.result";
  requestId: string;
  sessionId: string;
  messages: SessionMessage[];
  /** Whether history older than this page exists (keep paging). */
  hasMore: boolean;
  /** Where the page came from — diagnostics only. */
  source: "buffer" | "transcript";
}

export interface ScrollbackReplayMsg {
  type: "scrollback.replay";
  sessionId: string;
  messages: SessionMessage[];
  /**
   * 0-based CHUNK index of a chunked replay (#84). Absent = single-frame
   * replay. NOTE: unrelated to the per-message session cursor
   * `SessionMessage.seq` — this one only orders the frames of one replay.
   */
  seq?: number;
  /** True on the last chunk of a chunked replay. Absent = single-frame replay. */
  final?: boolean;
  /**
   * Replay semantics (`replay.resume` capability):
   *   - "snapshot" (or absent — the legacy shape): the authoritative full
   *     scrollback; clients RESET their local buffer to it.
   *   - "incremental": only entries mutated since the client's `sinceSeq`;
   *     clients APPEND/UPSERT by messageId — never reset. Sent when a
   *     `session.attach.resume` key matched.
   */
  mode?: "snapshot" | "incremental";
  /**
   * Identity of the daemon's replay buffer. Store it with `maxSeq` and pass
   * both back on `session.attach.resume`. Changes whenever the buffer is
   * rebuilt (e.g. daemon restart) — a mismatch means cursors are invalid and
   * the daemon answers with a snapshot.
   */
  resumeKey?: string;
  /** Highest session sequence included/known — the client's next cursor. */
  maxSeq?: number;
  /**
   * True when this snapshot is only the NEWEST window of the scrollback
   * (`scrollback.paging` capability): older history exists and is fetched
   * on demand via `scrollback.page`. Absent/false = the full buffer.
   */
  tail?: boolean;
  /** With `tail: true` — whether history older than this window exists. */
  hasMore?: boolean;
}

/** Result of a session.search query. */
export interface SessionSearchResultMsg {
  type: "session.search.result";
  requestId: string;
  query: string;
  sessions: SessionSearchHit[];
  /** Workspace id the search was scoped to ('' = cross-workspace). */
  workspaceId: string;
  /** Cap applied to the search. */
  limit: number;
}

// =============================================================================
// Auth context — attached to every verified connection
// =============================================================================

export interface AuthContext {
  /** ZeroID subject URI (WIMSE) */
  sub: string;
  /** Human-readable name */
  name?: string;
  /** Granted scopes for this connection */
  scopes: readonly Scope[];
  /** Delegation depth (0 = direct, >0 = delegated) */
  delegationDepth: number;
  /** Who delegated (if delegated) */
  delegatedBy?: string;
  /** Account ID (multi-tenant) */
  accountId: string;
  /** Project ID */
  projectId: string;
  /** Token expiry (Unix seconds). Carried so the daemon can reject an
   * expired token on a long-lived connection instead of trusting the
   * handshake forever. 0/undefined means the token carried no exp. */
  exp?: number;
}

/**
 * Convert an AuthContext to a MessageIdentity.
 * Uses delegation depth to infer identity type.
 */
export function authToIdentity(auth: AuthContext): MessageIdentity {
  return {
    sub: auth.sub,
    name: auth.name,
    type: auth.delegationDepth === 0 ? "human" : "agent",
  };
}
