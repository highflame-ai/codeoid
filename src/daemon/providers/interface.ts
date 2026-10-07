/**
 * AgentProvider — the abstraction that lets codeoid use multiple LLM backends
 * (Claude, Gemini, OpenAI) over the same session, canonical history, scrollback,
 * auth, and tool approval flow.
 *
 * Design:
 *   - Codeoid owns the conversation history as CanonicalTurn[].
 *   - Each provider translates that history to its own API format on runTurn().
 *   - Tool approvals, scrollback, and transcript stay in Session; providers
 *     emit ProviderEvents which Session maps to SessionMessages.
 */

import type {
  AuthContext,
  ContentPart,
  ProviderCommand,
  SessionMode,
  UiRequestMethod,
} from "../../protocol/types.js";
import type { CanonicalTurn, HistorySeedResult } from "./canonical.js";
import type { LLMCallUsage } from "../context-math.js";
import type { PackSubagent } from "../pipeline/subagents.js";

// ── Auth ──────────────────────────────────────────────────────────────────────

export type ProviderAuth =
  | { type: "subscription" }
  | { type: "api_key"; apiKey: string }
  | { type: "env"; envVar: string };

export interface ProviderConfig {
  auth: ProviderAuth;
  defaultModel?: string;
  baseURL?: string;
}

// ── Turn options ──────────────────────────────────────────────────────────────

/**
 * Approval callback — called by a provider from within its tool-use gate.
 * Session implements this as a closure capturing sender + approval state.
 */
export type ToolApprovalFn = (
  toolId: string,
  approvalId: string,
  toolName: string,
  input: Record<string, unknown>,
  /**
   * Fires when the backend abandons the request (e.g. the CLI cancelled the
   * agent that asked). A pending approval is then withdrawn rather than left
   * waiting on an answer nobody will read.
   */
  signal?: AbortSignal,
) => Promise<{
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}>;

/**
 * A dialog a provider raises mid-session (extension confirm gates, pick-one
 * lists, free-text prompts). Mirrors the wire shape of
 * `session.ui_request` minus the session/correlation fields — Session owns
 * those. See the protocol's "Provider-initiated UI" section for semantics.
 */
export interface UiRequest {
  method: UiRequestMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Auto-cancel deadline in ms. Absent = wait for a human (or interrupt). */
  timeoutMs?: number;
}

/**
 * The user's answer to a `UiRequest`. `cancelled: true` covers dismissal,
 * timeout, interrupt, session teardown, and an unattended turn — `reason` says
 * which. Providers must treat it as "no answer", never as consent.
 */
export interface UiResponse {
  value?: string;
  confirmed?: boolean;
  cancelled: boolean;
  /**
   * Why a cancelled dialog got no answer: a client dismissed it, its own
   * `timeoutMs` elapsed, the turn was interrupted / the session torn down, or
   * the turn is unattended (`unattended` — the daemon is driving it, e.g. a
   * pipeline phase, and never prompts). Absent when answered.
   */
  reason?: "dismissed" | "timeout" | "interrupted" | "unattended";
}

/** Raise a dialog and await the user's answer. Implemented by Session. */
export type UiRequestFn = (req: UiRequest) => Promise<UiResponse>;

export interface TurnOpts {
  /**
   * Full canonical history up to and including the current user turn.
   * ClaudeProvider ignores this (uses its own backing session).
   * Gemini/OpenAI convert it to their native message format via
   * toGeminiContent() / toOpenAIMessages() on each runTurn().
   */
  history: readonly CanonicalTurn[];
  userMessage: string;
  model?: string;
  fallbackModel?: string;
  workdir: string;
  systemPromptAppend?: string;
  /** Session's unified approval gate — same semantics across all providers. */
  canUseTool: ToolApprovalFn;
  /**
   * Session's dialog gate — lets the provider (or its extensions) ask the
   * user something that is NOT a tool approval. Optional so existing
   * providers and tests compile unchanged; providers must handle absence
   * (treat as `{ cancelled: true }`).
   */
  requestUserInput?: UiRequestFn;
  sender?: AuthContext;
  /**
   * The session's current execution mode. codeoid's `canUseTool` gate enforces
   * it uniformly for every backend (auto-approve in autonomous, prompt in
   * guarded, prompt-everything in interactive). Backends that ALSO have a
   * native approval/sandbox policy (codex) map the mode onto it so switching
   * modes actually reconfigures the backend — e.g. `autonomous` lets codex run
   * unattended (no per-action approval round-trip) with full sandbox access,
   * instead of asking on every action and relying on codeoid to auto-approve.
   * Backends without a native policy (claude via the SDK gate, gemini-cli/pi
   * via their request-permission channels) ignore it — the gate already
   * carries the mode. Absent = treat as `guarded`.
   */
  mode?: SessionMode;
  /**
   * Subagents contributed by an ambient-activated pack (docs/pack-loading.md).
   * The Claude backend maps these to the SDK's programmatic `agents` option so
   * they're available for auto-selection; other backends currently ignore them
   * (symlinking `~/.claude/agents` doesn't work — the provider excludes the
   * user settings tier). Absent = none.
   */
  subagents?: readonly PackSubagent[];
  /**
   * Session-scoped skill plugins from an ambient-activated pack
   * (`pipeline.skillScope: "session"`, docs/pack-loading.md §3a). Each entry is
   * a Claude-Code-plugin-shaped directory (`.claude-plugin/plugin.json` +
   * `skills/`); the Claude backend hands them to the SDK `plugins` option so the
   * pack's slash skills exist for THIS session without touching
   * `~/.claude/skills`. Other backends currently ignore them. Absent = none.
   */
  pluginDirs?: readonly string[];
}

// ── Normalized turn result ────────────────────────────────────────────────────

/**
 * Provider-agnostic turn summary emitted with turn_done.
 * Each provider maps its native response object to this shape so Session's
 * usage accounting and canonical-history recording stay provider-neutral.
 */
export interface NormalizedTurnResult {
  /** Provider that ran this turn (e.g. "claude", "gemini", "openai"). */
  providerId: string;
  /** Model identifier actually used (e.g. "claude-opus-4-5", "gemini-2.0-flash"). */
  model: string;
  /** NEW tokens consumed (excludes cache reads for Claude). */
  inputTokens: number;
  outputTokens: number;
  /** Claude-specific; 0 for other providers. */
  cacheReadTokens: number;
  /** Claude-specific; 0 for other providers. */
  cacheCreationTokens: number;
  totalCostUsd: number;
  durationMs: number;
  /**
   * Context window of the model that ran this turn, as the backend stated it.
   * Absent when the backend doesn't say (gemini, openai, acp report none).
   *
   * "Stated" is not "measured": the Claude CLI computes it from its own tables
   * and per-workdir settings, which is why the daemon scopes what it remembers
   * (SessionManager.modelContextWindow). It is still the number that backend
   * enforces, which a model-id table is not.
   */
  contextWindow?: number;
  stopReason?: string;
  isError?: boolean;
  errorMessage?: string;
}

// ── Provider event stream ─────────────────────────────────────────────────────

/** Normalized event emitted by any provider. Session maps these to SessionMessages.
 *
 *  Text/thinking events carry `parentToolUseId` when they were produced by a
 *  subagent (the id of the tool call that spawned it). `null`/absent = primary
 *  agent. Consumers must not record non-primary text as primary conversation
 *  content — see issue #82. */
export type ProviderEvent =
  | { type: "text_delta"; content: string; parentToolUseId?: string | null }
  | { type: "text_done"; content: string; parentToolUseId?: string | null }
  | { type: "thinking_delta"; content: string; blockIndex?: number; parentToolUseId?: string | null }
  | { type: "thinking_done"; blockIndex?: number; parentToolUseId?: string | null }
  /** Fired when a tool call starts (from the provider's canUseTool gate).
   *  Carries the provider-internal tool_use_id so Session can correlate messages. */
  | {
      type: "tool_start";
      toolId: string;
      sdkToolUseId: string;
      sdkAgentId?: string;
      name: string;
      input: Record<string, unknown>;
      approvalId: string;
      /**
       * Input keys the client may patch via `session.approve.updatedInput`
       * for THIS tool call (form-style tools where the user's answer IS the
       * input). Absent = the built-in whitelist applies (AskUserQuestion
       * only). Providers with form tools declare the patchable keys here so
       * the daemon's approval sanitizer doesn't need per-tool hardcoding.
       */
      patchableKeys?: string[];
    }
  /** Fired when a tool result is available (from the provider's user message). */
  | { type: "tool_complete"; sdkToolUseId: string; output: string; success: boolean }
  | { type: "subagent_start"; agentId: string; agentType: string }
  | { type: "subagent_stop"; agentId: string }
  | { type: "mcp_init"; servers: Record<string, string>; tools: Record<string, string[]> }
  /** Per-LLM-call usage, split by primary vs subagent (null parent_tool_use_id = primary). */
  | { type: "llm_call"; usage: LLMCallUsage; isPrimary: boolean }
  | { type: "api_retry"; attempt?: number; retryDelayMs?: number; errorStatus?: number | null }
  | { type: "tool_progress"; toolName?: string; elapsedSeconds?: number }
  /**
   * Provider-authored standalone message — extension output, status cards,
   * rich widgets. `content` is the plain-text fallback every frontend can
   * render; `parts` carries the rich blocks for capable ones. Persisted to
   * scrollback + transcript like any other message; NOT sent to the LLM
   * (canonical history ignores it).
   */
  | {
      type: "custom_message";
      /** Message role for rendering. Default "info". */
      role?: "info" | "system";
      content: string;
      parts?: ContentPart[];
      metadata?: Record<string, unknown>;
    }
  | { type: "turn_done"; result: NormalizedTurnResult }
  /**
   * A skill's expansion-time command was blocked and we've raised an approval
   * for it (#233). This PARKS the turn — the session shows waiting_approval and
   * the pipeline phase stays alive — WITHOUT ending it: the provider retries the
   * same prompt in-place once approved, or emits a terminal `turn_done` if
   * denied. Distinct from a tool approval, whose SDK turn is still live.
   */
  | { type: "approval_pending"; command: string }
  | { type: "error"; message: string };

/**
 * True when a text/thinking ProviderEvent was produced by a subagent
 * (`parentToolUseId` set). Such events must never be recorded as primary
 * conversation content — see issue #82. Centralised so the canonical
 * accumulator and Session's event consumer can't drift as new subagent-aware
 * event types are added.
 */
export function isSubagentEvent(event: ProviderEvent): boolean {
  return (
    (event.type === "text_delta" ||
      event.type === "text_done" ||
      event.type === "thinking_delta" ||
      event.type === "thinking_done") &&
    event.parentToolUseId != null
  );
}

// ── Session-scoped events ─────────────────────────────────────────────────────

/**
 * One live background task, in provider-agnostic shape.
 *
 * `kind` is the provider's own vocabulary ("shell", "subagent", "monitor", …)
 * and is display-only — the daemon never branches on it, so a new harness can
 * introduce kinds freely without touching core.
 */
export interface BackgroundTaskSnapshot {
  id: string;
  kind: string;
  description: string;
  status: string;
}

/**
 * Events scoped to the SESSION's lifetime rather than to any turn.
 *
 * Why this exists as a separate channel: `TurnRun.events` is turn-scoped by
 * construction — its own contract documents that an event arriving between
 * turns is "accepted and then discarded unread". Background tasks are the case
 * that breaks the taxonomy: a model can end its turn with work still running
 * ("I'll report when the three agents land"), and the completion arrives when
 * no turn is in flight. Routing it through the turn queue is structural loss,
 * observed live — a session promised a report, its tasks settled into a closed
 * queue, and it sat idle until the owner interrupted it.
 *
 * Four events. The first two mirror the level+edge design the Claude SDK
 * itself settled on:
 *
 * - `background_tasks` is a LEVEL: the full live set after any membership
 *   change, with REPLACE semantics. Consumers swap their state for the payload,
 *   so a missed event can never wedge a stale "running" indicator.
 * - `background_task_settled` is the EDGE that carries the outcome digest —
 *   the thing a session must be woken with.
 * - `background_event` carries a background agent's own lifecycle — a tool
 *   call, a tool result, a sub-agent starting or stopping — that happened with
 *   no turn in flight. Background agents outlive the turn that spawned them,
 *   so their tool calls (and the approvals those need) routinely land between
 *   turns; sent to the turn queue they were dropped, the approval card never
 *   rendered, and the session sat blocked on a prompt nobody could see.
 * - `turn_started` hands the session a turn the BACKEND started on its own.
 *   The Claude CLI answers a finished background task by running the main
 *   agent itself — no prompt from codeoid. With no turn queue open, that whole
 *   turn (its reply, its tool calls and their approvals, its turn_done) was
 *   dropped: the owner saw nothing, and an approval inside it wedged the
 *   session invisibly. The session consumes it like any turn it started.
 *
 * Provider-agnostic on purpose: claude maps its SDK notifications onto these
 * today; pi/gemini/codex emit nothing until their harnesses grow background
 * work, and a future harness only has to speak this shape — core never learns
 * provider-specific event names.
 */
export type SessionScopedEvent =
  | { type: "background_tasks"; tasks: readonly BackgroundTaskSnapshot[] }
  | {
      type: "background_task_settled";
      taskId: string;
      status: "completed" | "failed" | "stopped";
      /** Compressed outcome — what the session is woken with. Never a raw transcript. */
      summary: string;
    }
  | { type: "background_event"; event: BackgroundLifecycleEvent }
  | { type: "turn_started"; run: TurnRun };

/** The provider events a background agent emits on its own, between turns. */
export type BackgroundLifecycleEvent = Extract<
  ProviderEvent,
  { type: "tool_start" | "tool_complete" | "subagent_start" | "subagent_stop" }
>;

/** Event types a provider reroutes to `background_event` when no turn can take them. */
export const BACKGROUND_LIFECYCLE_EVENT_TYPES: ReadonlySet<ProviderEvent["type"]> = new Set([
  "tool_start",
  "tool_complete",
  "subagent_start",
  "subagent_stop",
]);

export function isBackgroundLifecycleEvent(e: ProviderEvent): e is BackgroundLifecycleEvent {
  return BACKGROUND_LIFECYCLE_EVENT_TYPES.has(e.type);
}

// ── TurnRun ───────────────────────────────────────────────────────────────────

export interface TurnRun {
  /** Event stream — stays open across turns for keep-warm providers (Claude).
   *  Closes when the underlying loop ends. */
  events: AsyncIterable<ProviderEvent>;
  /** Stop the in-flight turn. */
  interrupt(): Promise<void>;
  /** Push a message mid-turn (ClaudeProvider only). */
  pushMidTurn?(content: string, priority: "now" | "next" | "later"): void;
  /**
   * Signal that the consumer has stopped reading `events` — called from
   * Session's turn-exit path, exactly once per run.
   *
   * Keep-warm providers hold one queue per turn but only close it when the NEXT
   * turn replaces it. Between those points the queue is open with nobody
   * draining it, so a late event (a `SubagentStop` hook resolving after the
   * result message, a trailing tool_result) is accepted and then discarded
   * unread — the silent loss that leaves sub-agents dangling and tools stuck
   * "running". Closing here turns that into an observable, recoverable case:
   * the provider sees the closed queue and can buffer or log instead.
   *
   * Optional and best-effort — providers with no per-turn queue omit it, and it
   * must never throw into the consumer's finally.
   */
  endTurn?(): void;
  /**
   * Adopted turns only (`turn_started`): bind the approval gate, dialog
   * handler and acting principal for this turn. A turn the backend started on
   * its own would otherwise run under the previous prompted turn's gate, and
   * audit every auto-approval in it to a human who never asked for it.
   */
  bindGate?(gate: Pick<TurnOpts, "canUseTool" | "requestUserInput" | "sender">): void;
}

// ── ModelInfo ─────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
  /** Context window in tokens, when the backend publishes it on its catalog.
   *  qwen-code and pi do; Claude and codex report the window per turn. */
  contextWindow?: number;
}

/**
 * One entry of the catalog a provider reports through `onModels`.
 *
 * Named once and used at every hop (provider init → registry → Session →
 * manager). It used to be written inline at each, and only the two ends
 * declared `contextWindow` — the field survived only because nothing in
 * between rebuilt the array, which is exactly how qwen's window had been lost
 * once already.
 */
export interface CatalogEntry {
  value: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
}

/**
 * A turn result's `model` that names no model: "unknown", or a provider's
 * stand-in for "whatever its default is" (codex reports its own id, pi
 * "pi-default"). Fine to display against; never a key another session can hit.
 */
export function isPlaceholderModel(providerId: string, model: string): boolean {
  return !model || model === "unknown" || model === providerId || model === `${providerId}-default`;
}

// ── AgentProvider interface ───────────────────────────────────────────────────

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;

  /** Start a turn, return an event stream that closes on turn_done (stateless)
   *  or stays warm (ClaudeProvider). */
  runTurn(opts: TurnOpts): TurnRun;
  listModels(): Promise<ModelInfo[]>;
  /**
   * Provider-defined slash commands currently available in this session
   * (extension commands, prompt templates, skills). Served to clients via
   * `session.commands`; invoked by sending "/name args" as plain prompt
   * text. Optional — absent means "no dynamic commands".
   */
  listCommands?(): Promise<ProviderCommand[]>;
  /**
   * Handle a `ButtonPart` activation (`session.part_action`). The daemon
   * validates the button exists on a real message before calling this.
   * Optional — absent means the provider emits no actionable buttons and
   * the daemon rejects the action.
   */
  handlePartAction?(
    action: string,
    data: Record<string, unknown> | undefined,
  ): void | Promise<void>;
  /**
   * Seed a FRESH provider with the session's canonical history — called
   * once by `session.set_provider` / `session.fork` on the incoming backend,
   * before its first turn. Provider-owned fidelity: stateless backends no-op
   * (they consume `TurnOpts.history` natively every turn); warm backends
   * implement their best strategy (typically prepending a rendered
   * transcript — see `renderHistorySeed` — to their first prompt).
   *
   * `opts.maxChars` is sized by the session to the TARGET model's context
   * window (see seedBudgetChars) so the seed only truncates when the history
   * won't fit. Warm backends return the {@link HistorySeedResult} so the
   * session can surface truncation to the user; a `void`/`undefined` return
   * means "not seeded / nothing to report" (e.g. stateless no-op).
   *
   * Optional and best-effort: a throw degrades to an unseeded switch, it
   * must never wedge the session.
   */
  seedFromHistory?(
    history: readonly CanonicalTurn[],
    opts?: { maxChars?: number },
  ): HistorySeedResult | undefined | Promise<HistorySeedResult | undefined>;
  /**
   * Transport-only hook for a strategy-built seed block (e.g. the compact
   * session map). The session decides the CONTENT (transcript vs session map);
   * the provider just stashes `block` and prepends it to its first prompt —
   * the same channel `seedFromHistory` already uses (`#pendingHistorySeed`).
   * Warm backends implement it; stateless backends omit it (they carry the
   * full history natively every turn).
   */
  seedText?(block: string): void;
  /**
   * True when codeoid's memory recall tools (recall/recall_file/timeline/
   * get_episode) are mounted for this provider+session, so the model can page
   * the verbatim store on demand. A context-light strategy (session map) is
   * used ONLY when this is true; otherwise the session falls back to the
   * transcript seed. This is the per-backend rollout gate — a backend sets it
   * true only after its tool mount is confirmed.
   */
  readonly supportsMemoryTools?: boolean;
  dispose(): Promise<void>;
}

// ── SessionProvider interface ─────────────────────────────────────────────────

/**
 * Extended provider interface that Session requires in addition to AgentProvider.
 * ClaudeProvider satisfies this. Tests inject MockSessionProvider via
 * SessionCreateOptions._testProvider so integration tests run without the SDK.
 */
export interface SessionProvider extends AgentProvider {
  /** Set by Session before each runTurn(). Handles "backing session lost" errors. */
  onRecoveryNeeded: ((content: string) => void) | undefined;
  /**
   * The session-lifetime event listener (at most one — the owning Session).
   * Session-scoped events MUST be delivered here and never through
   * `TurnRun.events`: they can fire between turns, when the turn queue has no
   * reader and would silently drop them. Optional — providers with no
   * background work simply never call it.
   */
  onSessionEvent?: ((event: SessionScopedEvent) => void) | undefined;
  /**
   * The backend continues the conversation by itself when background work it
   * started settles (delivering the result to the model and running a turn,
   * surfaced as `turn_started`). The session then waits for that turn instead
   * of injecting its own wake, which would be a second, duplicate turn — and
   * wakes itself only as a fallback if no turn begins.
   */
  readonly continuesAfterBackgroundWork?: boolean;
  /**
   * Stop background tasks by id (the ids of the `background_tasks` level).
   * What Stop does when no turn is in flight: without it, nobody holding only
   * `session:interrupt` could halt a misbehaving background agent. Optional —
   * a backend with no background work never has any to stop.
   */
  stopBackgroundTasks?(taskIds: readonly string[]): Promise<void>;
  /** Underlying backing session ID (for display and Store persistence). */
  readonly backingSessionId: string;
  /** True once runTurn() has been called at least once (guards agent registration). */
  readonly hasQueried: boolean;
  /** Depth of the queued input messages (for StatusBar display). */
  readonly queuedMessages: number;
  /** Called on rotation/recovery to mint a fresh backing session ID. */
  resetToNewSession(newBackingId: string): void;
  /** Mark the provider as having queried (used on session resume to skip re-registration). */
  setHasQueried(value: boolean): void;
  /** Tear down the running query loop. Called on model switch, rotation, or destroy. */
  teardown(): Promise<void>;
}
