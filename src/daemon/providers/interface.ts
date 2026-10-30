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
  EffortLevel,
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
  /**
   * The agent that asked, when it isn't the session's main agent (Claude: the
   * SDK's `agentID`, which for a background agent is its task id). Lets the
   * gate refuse an agent that isn't this session's (a fork's parent's).
   */
  agentId?: string,
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

/**
 * The turn error a backend reports when it stopped itself at its native spend
 * ceiling (`TurnOpts.maxBudgetUsd`). One constant, so a caller (routines) can
 * tell "over budget" from any other failure without parsing vendor text.
 */
export const BUDGET_STOP_MESSAGE = "Stopped at the spend ceiling for this run (maxBudgetUsd).";

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
  /** Thinking effort for this turn (#417), on codeoid's scale; absent = the backend's default. */
  effort?: EffortLevel;
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
   * Spend ceiling (USD) for the backend's own query loop, for backends that
   * can enforce one natively (Claude: the SDK's `maxBudgetUsd`, which counts
   * spend since its query started). Set only on sessions whose query lifetime
   * IS the budget's scope — a routine's fresh run session. Absent = no cap.
   * Backends without native enforcement ignore it; the daemon still checks
   * spend between turns.
   */
  maxBudgetUsd?: number;
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
  /**
   * Where `totalCostUsd` comes from (#430). `backend`: the backend said what
   * the turn cost (Claude, pi). `free`: nothing to pay (a model on this
   * machine). `unknown`: the backend can't tell (no token counts). Absent: it
   * gave tokens but no cost, and the session prices them.
   */
  costSource?: "backend" | "free" | "unknown";
  /**
   * The largest single request's prompt in the turn (input + cache), for a
   * backend that sums several requests into the turn's counts and reports no
   * per-request usage (#430): prices with a long-context tier need it.
   */
  largestPromptTokens?: number;
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
  /**
   * The backend's own result text for a turn it flagged as an error without
   * an error subtype (Claude: `subtype: "success"`, `is_error: true`) — where
   * the CLI puts a usage-limit or "API Error: …" notice. Text the CLI wrote,
   * possibly the model's: read only with CLI-shaped rules (classifyCliNotice).
   */
  resultText?: string;
  /**
   * Where this turn ends in the backend's OWN record of the conversation, for
   * a backend that can later fork or resume from that point natively (#387).
   * Stamped on the canonical turn, so a fork, rewind or restart can continue
   * the backend's own conversation instead of a rendered transcript.
   */
  nativeRef?: NativeTurnRef;
}

/**
 * A point in a backend's native conversation: the backing session/thread and
 * the backend's id for the last entry of a turn in it (a Claude transcript
 * entry uuid, a Codex turn id). Opaque to everything but the provider that
 * minted it.
 */
export interface NativeTurnRef {
  backingId: string;
  ref: string;
  /**
   * The working directory the backing session ran in, when the backend files
   * sessions by it (Claude): a fork looks the source up there and nowhere else.
   */
  dir?: string;
  /**
   * Some tool output in this backing session was redacted by a tool_result
   * hook: the backend's own record holds the original, so this point must not
   * be forked natively. Stamped by the session on every later turn of the
   * backing, so it survives history that no longer shows the redacted call.
   */
  redacted?: boolean;
}

/** What a session asks a provider when it hands it an existing conversation. */
export interface NativeContinuationRequest {
  /** The conversation to continue, oldest first. */
  history: readonly CanonicalTurn[];
  /**
   * Set when the history's last turn ran on THIS backend and it recorded where
   * that turn ends: the provider may fork its own conversation there, which
   * loses nothing (reasoning included).
   */
  forkFrom?: NativeTurnRef;
  /** Char budget for history the provider builds itself (sized to the target window). */
  maxChars: number;
  /**
   * False when the history holds turns rebuilt from a displayed transcript:
   * the provider may fork, but must not build native history from them —
   * resolve null instead (the session uses the transcript).
   */
  allowHistory?: boolean;
  /** Where the continued session runs. */
  workdir: string;
}

/** A native continuation that took. */
export interface NativeContinuationResult {
  /** `fork`: the backend's own conversation, forked. `history`: native history codeoid built. */
  via: "fork" | "history";
  /**
   * The backend's new backing session/thread id, when it exists already: the
   * session persists it and treats the backend as holding the conversation.
   * Absent for a backend that builds it on its first turn (Codex needs that
   * turn's instructions); until then a restart re-runs the continuation.
   */
  backingId?: string;
  /** Set when building the history dropped older turns to fit the budget. */
  truncation?: HistorySeedResult;
}

/** One backend-mounted MCP server's state, as the backend reports it. */
export interface BackendMcpServerState {
  status: string;
  /** Full tool names (`mcp__<server>__<tool>`), matching the `mcp_init` event. */
  tools: string[];
  error?: string;
  /** A claude.ai connector, by the backend's own account (signed in on claude.ai, not by the CLI). */
  connector?: boolean;
  /** The backend still runs its own copy of a server codeoid signs in to now
   *  (adopted since the query started, #390): not redialed — the next query
   *  uses codeoid's copy. */
  codeoidOwned?: boolean;
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
  | {
      type: "tool_complete";
      sdkToolUseId: string;
      output: string;
      success: boolean;
      /** The backend refused this call itself, never asking codeoid's gate
       *  (codex declining an approval it can't show, #369) — audited. */
      declinedByBackend?: boolean;
      /** A tool_result hook replaced `output`: the backend's own record still holds the original. */
      redacted?: boolean;
    }
  | { type: "subagent_start"; agentId: string; agentType: string }
  | { type: "subagent_stop"; agentId: string }
  | { type: "mcp_init"; servers: Record<string, string>; tools: Record<string, string[]> }
  /** Per-LLM-call usage, split by primary vs subagent (null parent_tool_use_id = primary). */
  | { type: "llm_call"; usage: LLMCallUsage; isPrimary: boolean }
  /**
   * A request was sent to the model (#430), for a backend whose usage arrives
   * only when the request ends: a turn stopped before then still spent.
   */
  | { type: "model_request" }
  | { type: "api_retry"; attempt?: number; retryDelayMs?: number; errorStatus?: number | null }
  /**
   * The backend's plan rate-limit state changed (Claude's `rate_limit_event`,
   * subscription accounts only). `rejected` means requests are refused until
   * `resetsAt` (epoch ms) — the exact reset a usage-limit error's text often
   * gives only as a wall-clock time. Observational: nothing retries on it.
   */
  | {
      type: "rate_limit";
      status: "allowed" | "allowed_warning" | "rejected";
      resetsAt?: number;
      limitType?: string;
      /** Extra usage (overage) is carrying requests past the spent window — nothing is refused. */
      overage?: boolean;
    }
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
  /**
   * The turn failed. `detail` is the backend's STRUCTURED error, when it gave
   * one (codex's `codexErrorInfo` + reset instant — codexErrorDetail): read by
   * the usage-limit classifier, never shown. `message` stays the display text.
   */
  | { type: "error"; message: string; detail?: Record<string, unknown> };

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
  /** The backend says it's ambient (a watcher it started itself): not the agent's work. */
  ambient?: boolean;
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
  /** Thinking efforts the model takes, when the backend reports them (#417). */
  efforts?: EffortLevel[];
  defaultEffort?: EffortLevel;
  /** The model the backend runs when none is chosen. */
  isDefault?: boolean;
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
  /** Thinking efforts the model takes (#417), when the backend reports them; [] = it doesn't think. */
  efforts?: EffortLevel[];
  /** The backend's default effort for the model, when it says. */
  defaultEffort?: EffortLevel;
  /** The model the backend runs when none is chosen, when it says (the effort picker reads its levels). */
  isDefault?: boolean;
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
   * Redial one of the MCP servers the backend itself mounts (#389) and report
   * its state afterwards. Resolves null when the backend has no live
   * connection to ask (no live query: before its first turn, or after a teardown) — it dials its
   * servers when the next turn starts anyway. Never throws for a failed
   * reconnect: that's a result with `status` and `error`.
   */
  reconnectMcpServer?(name: string): Promise<BackendMcpServerState | null>;
  /**
   * Thinking effort (#417): how a change reaches this backend. Absent or
   * "turn" = it takes each turn's `TurnOpts.effort`; "restart" = only when the
   * backend starts (the Gemini CLI's settings), so the session rebuilds it
   * before the next turn.
   */
  readonly effortChange?: "turn" | "restart";
  /** What Default means on this backend now, once known (#417) — for the session's pickers. */
  readonly defaultEffort?: EffortLevel | null;
  /** The model it runs when the session names none, once known. */
  readonly runningModel?: string | null;
  /**
   * Apply a new effort to the running backend now, where it can (Claude,
   * Qwen, pi) — never cutting a turn short. True when it did; false (or
   * absent) = it applies from the next turn's options.
   */
  applyEffort?(effort: EffortLevel | null): Promise<boolean>;
  /**
   * Hand this (fresh) backend an existing conversation in its OWN native form,
   * instead of a transcript in the first prompt (#387): fork its own
   * conversation at `forkFrom` when given, else build native history from
   * `history`. Resolves null when the backend can't, and the session falls
   * back to the transcript seed; a throw is treated the same. On success the
   * backend's backing id is `result.backingId` and its next turn resumes it.
   */
  continueNatively?(req: NativeContinuationRequest): Promise<NativeContinuationResult | null>;
  /**
   * True when codeoid's memory recall tools (recall/recall_file/timeline/
   * get_episode) are mounted for this provider+session, so the model can page
   * the verbatim store on demand. A context-light strategy (session map) is
   * used ONLY when this is true; otherwise the session falls back to the
   * transcript seed. This is the per-backend rollout gate — a backend sets it
   * true only after its tool mount is confirmed.
   */
  readonly supportsMemoryTools?: boolean;
  /**
   * Its turns cost nothing (a model on the user's own server, #430) — also the
   * ones that end with no result, which the session records itself.
   */
  readonly free?: boolean;
  /**
   * True when the backend runs the `updatedInput` an `allow` verdict carries —
   * a hook's rewrite of a tool call, or an approver's form answers — instead
   * of the input it proposed. Absent = false: a backend that only hears
   * yes/no runs its OWN input, and showing a rewrite it then ignores would
   * have the user approve one thing while another runs. Session refuses such
   * a call instead (#367). Declare it only after confirming the backend
   * applies the new input to what it actually executes.
   */
  readonly appliesToolInputRewrite?: boolean;
  /**
   * False when, in autonomous mode, the backend runs tool calls WITHOUT
   * asking canUseTool — so codeoid's autonomous tool budget (and
   * `onBudgetExhausted`) cannot see, count or stop them. Codex: autonomous
   * maps to `approvalPolicy: "never"`. Absent = true (every call is gated).
   * A loop controller falls back to wall-time limits (supervisor.ts) there.
   */
  readonly enforcesToolBudget?: boolean;
  /**
   * Pids of the processes this backend spawned itself (its CLI / app-server)
   * that are alive now. Session.terminateBackend snapshots their whole tree
   * before the teardown and kills what outlives it (process-tree.ts). Absent
   * or empty = unknown (in-process backends; qwen-code, whose SDK spawns
   * internally): only the teardown runs.
   */
  backendProcessIds?(): Promise<number[]>;
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
   * Set by Session. A backend that could not resume its native conversation
   * (a thread written under another account's home, a vendor that lost it)
   * and is about to start an empty one calls this, synchronously, before it
   * sends the prompt: Session seeds it with the canonical history so the
   * conversation carries on instead of silently starting over.
   */
  onHistoryLost?: (() => void) | undefined;
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
   * a backend with no background work never has any to stop. Resolves to
   * the ids it couldn't stop (still running), [] when every stop went through.
   */
  stopBackgroundTasks?(taskIds: readonly string[]): Promise<string[]>;
  /**
   * On a fork, why a tool call is its parent's work and is refused, or null:
   * the backend's own check (the Claude provider's), run again by Session on
   * an input a codeoid hook rewrote, since the backend checked the input it
   * proposed. Absent on a backend with no such check.
   */
  foreignCallRefusal?(toolName: string, input: unknown, agentId: string | undefined): string | null;
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
