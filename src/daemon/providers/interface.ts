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
 * timeout, interrupt, and session teardown — providers must treat it as
 * "no answer", never as consent.
 */
export interface UiResponse {
  value?: string;
  confirmed?: boolean;
  cancelled: boolean;
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
}

// ── ModelInfo ─────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
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
