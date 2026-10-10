/**
 * Canonical conversation history — the format codeoid uses internally so
 * multiple providers can share turns.
 *
 * Capture (CanonicalHistoryAccumulator) has always been structured:
 * CanonicalTurn carries content, thinking, and CanonicalToolCall[] with
 * ids/inputs/outputs. Phase 2 (this file's converters) renders that history
 * in each provider's NATIVE structure — Anthropic tool_use/tool_result
 * blocks, Gemini functionCall/functionResponse parts, OpenAI tool_calls +
 * tool-role messages — so a switched session's history reads as real
 * tool-call turns, not a narrated summary.
 *
 * Two honest fidelity limits remain:
 *   - `thinking` is captured but NOT replayed into any provider payload:
 *     Anthropic requires a cryptographic signature on replayed thinking
 *     blocks (ours are synthesized, so they'd be rejected — and the API
 *     ignores prior-turn thinking anyway), and neither Gemini nor OpenAI
 *     accepts imported reasoning. Display-only by design.
 *   - A CanonicalTurn flattens an agent loop (text → tool → text …) into
 *     one turn, so converters emit the parallel-tool-call shape: one
 *     assistant message with every tool_use, then one message with every
 *     result. Valid everywhere, but intra-turn interleaving is not
 *     reconstructed.
 */

import { type ProviderEvent, isSubagentEvent } from "./interface.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A captured tool call — input from the canUseTool gate, output from the
 * provider's tool_result event.
 */
export interface CanonicalToolCall {
  /** Provider tool_use_id (or a generated UUID for providers that omit it). */
  id: string;
  /** Normalized snake_case name ("read_file", "run_shell"). */
  name: string;
  /** Tool input using Claude Code's field-name conventions as reference. */
  input: Record<string, unknown>;
  /** Tool result text, subject to TOOL_OUTPUT_LIMITS. */
  output: string;
  success: boolean;
  /** Original provider name before normalization ("Read", "Bash"). */
  originalName?: string;
}

export type CanonicalTurn =
  | {
      role: "user";
      content: string;
      /**
       * Stable id of the turn this prompt starts (#354). Every message the
       * session emits for the turn carries the same id, so clients can point
       * at a turn (go back, fork from here, show its diff). Optional: turns
       * recorded before #354 have none.
       */
      turnId?: string;
      /**
       * The words the person actually typed, when `content` also carries
       * context codeoid injected (attached files, a rotation anchor). Used
       * for turn previews; absent when it equals `content`.
       */
      prompt?: string;
      /** When the turn started (ISO). */
      at?: string;
      /** A turn the agent started on its own (background work finished). */
      background?: boolean;
    }
  | {
      role: "assistant";
      content: string;
      /** The turnId of the user turn this answers (#354). */
      turnId?: string;
      toolCalls?: CanonicalToolCall[];
      thinking?: string;
      /** Which provider produced this turn. */
      providerId: string;
      model: string;
    };

// ── Tool name normalization ───────────────────────────────────────────────────

/**
 * Claude Code Pascal-case → canonical snake_case.
 * Applied at capture time in ClaudeProvider.
 */
export const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "str_replace_file",
  MultiEdit: "multi_edit_file",
  Bash: "run_shell",
  Glob: "glob_files",
  Grep: "search_in_files",
  LS: "list_directory",
  Task: "spawn_subagent",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  TodoRead: "read_todos",
  TodoWrite: "write_todos",
};

export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

// ── Tool output size limits ───────────────────────────────────────────────────

/**
 * Per-category output size limits applied at capture time (not at conversion).
 * Prevents a single large tool result from flooding a switching provider's
 * context window. When exceeded, a truncation note is appended.
 */
export const TOOL_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  read_file: 32_768,
  run_shell: 8_192,
  str_replace_file: Number.POSITIVE_INFINITY,
  write_file: Number.POSITIVE_INFINITY,
  multi_edit_file: Number.POSITIVE_INFINITY,
  glob_files: 8_192,
  list_directory: 8_192,
  search_in_files: 8_192,
  spawn_subagent: 8_192,
  default_mcp: 16_384,
};

export function limitToolOutput(canonicalName: string, output: string): string {
  const limit = canonicalName.startsWith("mcp__")
    ? TOOL_OUTPUT_LIMITS.default_mcp
    : (TOOL_OUTPUT_LIMITS[canonicalName] ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(limit) || output.length <= limit) return output;
  return `${output.slice(0, limit)}\n…output truncated at ${limit} chars (full output was ${output.length} chars)`;
}

// ── Native message shapes ─────────────────────────────────────────────────────
//
// Structural subsets of each provider's message-param types, declared here so
// canonical.ts stays dependency-free. Providers pass the converter output to
// their SDKs, where structural typing (or a single cast at the call site)
// takes over.

/** Anthropic Messages API content blocks (the subset codeoid emits). */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

/** @google/generative-ai Content — functionResponse parts ride role "function". */
export interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

export type OpenAIMessageParam =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

// ── History converters ────────────────────────────────────────────────────────

/**
 * Render a CanonicalTurn[] as Google Gemini Content[].
 *
 * Tool calls become native { functionCall } parts on the model turn,
 * followed by a role:"function" turn carrying { functionResponse } parts
 * (the shape @google/generative-ai validates for chat history). Gemini
 * pairs responses by NAME, not id — a limitation of its wire format.
 */
export function toGeminiContent(history: readonly CanonicalTurn[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const turn of history) {
    if (turn.role === "user") {
      out.push({ role: "user", parts: [{ text: turn.content }] });
      continue;
    }

    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      out.push({ role: "model", parts: [{ text: turn.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    if (turn.content) parts.push({ text: turn.content });
    for (const tc of turn.toolCalls) {
      parts.push({ functionCall: { name: tc.name, args: tc.input } });
    }
    out.push({ role: "model", parts });
    out.push({
      role: "function",
      parts: turn.toolCalls.map((tc) => ({
        functionResponse: {
          name: tc.name,
          // functionResponse.response must be an OBJECT — wrap the text.
          response: { output: tc.output, success: tc.success },
        },
      })),
    });
  }

  return out;
}

/**
 * Render a CanonicalTurn[] as OpenAI ChatCompletionMessageParam[].
 *
 * Tool calls become native assistant `tool_calls[]` followed by one
 * role:"tool" message per call (paired by `tool_call_id`). OpenAI accepts
 * tool-history replay without the original function schemas declared.
 */
export function toOpenAIMessages(history: readonly CanonicalTurn[]): OpenAIMessageParam[] {
  const out: OpenAIMessageParam[] = [];

  for (const turn of history) {
    if (turn.role === "user") {
      out.push({ role: "user", content: turn.content });
      continue;
    }

    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      out.push({ role: "assistant", content: turn.content });
      continue;
    }

    out.push({
      role: "assistant",
      // OpenAI wants null (not "") when the turn is tool-calls-only.
      content: turn.content || null,
      tool_calls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    });
    for (const tc of turn.toolCalls) {
      // OpenAI has no is_error equivalent — failures are carried in the
      // content string (design doc §11.3).
      out.push({
        role: "tool",
        tool_call_id: tc.id,
        content: tc.success ? tc.output : `Error: ${tc.output}`,
      });
    }
  }

  return out;
}

/**
 * Render a CanonicalTurn[] as Anthropic API messages[].
 * Used when ClaudeProvider is switched into stateless mode,
 * or when seeding a new Claude backing session with prior context.
 *
 * Tool calls become native `tool_use` blocks on the assistant message,
 * followed by a user message of `tool_result` blocks paired by
 * `tool_use_id` (the CanonicalToolCall id round-trips). Consecutive
 * same-role messages are legal — the API merges them into one turn.
 *
 * `thinking` is deliberately NOT emitted: replayed thinking blocks must
 * carry the API's signature, which synthesized history can't produce.
 */
export function toAnthropicMessages(
  history: readonly CanonicalTurn[],
): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];

  for (const turn of history) {
    if (turn.role === "user") {
      out.push({ role: "user", content: turn.content });
      continue;
    }

    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      out.push({ role: "assistant", content: turn.content });
      continue;
    }

    const blocks: AnthropicContentBlock[] = [];
    // Empty text blocks are rejected by the API — only emit when non-empty.
    if (turn.content) blocks.push({ type: "text", text: turn.content });
    for (const tc of turn.toolCalls) {
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    out.push({ role: "assistant", content: blocks });
    out.push({
      role: "user",
      content: turn.toolCalls.map((tc) => ({
        type: "tool_result" as const,
        tool_use_id: tc.id,
        content: tc.output,
        ...(tc.success ? {} : { is_error: true }),
      })),
    });
  }

  return out;
}

// ── CanonicalHistoryAccumulator ───────────────────────────────────────────────

/**
 * Accumulates ProviderEvents into a CanonicalTurn[] history.
 *
 * This is the single source of truth for multi-provider history sharing.
 * Session.ts will eventually delegate to this class; for now it is used
 * directly by the provider E2E tests and can be composed into any host.
 *
 * Lifecycle:
 *   1. Call pushUserTurn() before each runTurn() call.
 *   2. Feed every ProviderEvent from the TurnRun.events stream to handleEvent().
 *   3. On turn_done, the completed assistant CanonicalTurn is appended.
 *   4. history is ready for the next provider's TurnOpts.history.
 */
/**
 * A change to the canonical history, for durable persistence (#354). The
 * history is the backend-neutral record every fork, backend switch and rewind
 * is built from, so it must survive a daemon restart — a listener appends
 * these to a per-session log.
 */
export type CanonicalHistoryChange =
  | { op: "append"; turn: CanonicalTurn }
  | { op: "replace"; turns: readonly CanonicalTurn[] };

export class CanonicalHistoryAccumulator {
  #history: CanonicalTurn[] = [];
  /** turnId of the latest user turn — stamped on the assistant turn that answers it. */
  #currentTurnId: string | undefined;
  /** Notified after every committed change (see CanonicalHistoryChange). */
  onChange: ((change: CanonicalHistoryChange) => void) | undefined;

  // In-progress assistant turn state — reset on each turn_done.
  #currentText = "";
  #currentThinking = "";
  #currentTools = new Map<
    string, // sdkToolUseId
    { id: string; name: string; originalName?: string; input: Record<string, unknown>; output?: string; success?: boolean }
  >();

  get history(): readonly CanonicalTurn[] {
    return this.#history;
  }

  /** Append a user turn. Call once per runTurn() before feeding events. */
  pushUserTurn(
    content: string,
    turnId?: string,
    extra?: { prompt?: string; at?: string; background?: boolean },
  ): void {
    const turn: CanonicalTurn = {
      role: "user",
      content,
      ...(turnId ? { turnId } : {}),
      ...(extra?.prompt !== undefined && extra.prompt !== content ? { prompt: extra.prompt } : {}),
      ...(extra?.at ? { at: extra.at } : {}),
      ...(extra?.background ? { background: true } : {}),
    };
    this.#currentTurnId = turnId;
    this.#history.push(turn);
    this.#emit({ op: "append", turn });
  }

  #emit(change: CanonicalHistoryChange): void {
    try {
      this.onChange?.(change);
    } catch {
      // Persistence must never break the conversation.
    }
  }

  /**
   * Feed one ProviderEvent from the TurnRun.events stream.
   * On turn_done, the completed assistant turn is appended to history.
   */
  handleEvent(event: ProviderEvent): void {
    // Subagent text/thinking is not primary conversation content — recording
    // it would corrupt cross-provider history (#82). Session already filters
    // these before feeding the accumulator; this guards standalone callers.
    if (isSubagentEvent(event)) return;
    switch (event.type) {
      case "text_done":
        // A turn can span several assistant messages (text → tool → text →
        // final text); each fires its own text_done. Append every block —
        // assigning would keep only the last one and drop all interleaved
        // reasoning from the canonical history (#82).
        this.#currentText = this.#currentText
          ? `${this.#currentText}\n\n${event.content}`
          : event.content;
        break;

      case "thinking_delta":
        this.#currentThinking += event.content;
        break;

      case "tool_start":
        this.#currentTools.set(event.sdkToolUseId, {
          id: event.sdkToolUseId,
          name: normalizeToolName(event.name),
          originalName: event.name,
          input: event.input,
        });
        break;

      case "tool_complete": {
        const partial = this.#currentTools.get(event.sdkToolUseId);
        if (partial) {
          partial.output = limitToolOutput(partial.name, event.output);
          partial.success = event.success;
        }
        break;
      }

      case "turn_done": {
        const toolCalls: CanonicalToolCall[] = [
          ...this.#currentTools.values(),
        ].filter((t): t is CanonicalToolCall => t.output !== undefined);

        // Only commit a turn that actually PRODUCED something (text, tools, or
        // thinking). A content-free turn_done is not a model turn — the Claude
        // provider emits one when it rebuilds its query loop (e.g. on a phase-
        // activation systemPromptAppend change), and committing a phantom empty
        // assistant turn corrupts every "did the model respond yet?" signal
        // (historyLength, lastTurnRole, lastAssistantText), which made a pipeline
        // phase's transient rebuild idle look like a real rest. Skip it.
        const produced =
          this.#currentText.length > 0 || toolCalls.length > 0 || this.#currentThinking.length > 0;
        if (produced) {
          const turn: CanonicalTurn = {
            role: "assistant",
            content: this.#currentText,
            ...(this.#currentTurnId ? { turnId: this.#currentTurnId } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            ...(this.#currentThinking ? { thinking: this.#currentThinking } : {}),
            providerId: event.result.providerId,
            model: event.result.model,
          };
          this.#history.push(turn);
          this.#emit({ op: "append", turn });
        }

        // Reset in-progress state for the next turn.
        this.#currentText = "";
        this.#currentThinking = "";
        this.#currentTools.clear();
        break;
      }
    }
  }

  /** Reset the entire history. Useful after a session rotation. */
  reset(): void {
    this.#clear();
    this.#emit({ op: "replace", turns: [] });
  }

  #clear(): void {
    this.#history = [];
    this.#currentTurnId = undefined;
    this.#currentText = "";
    this.#currentThinking = "";
    this.#currentTools.clear();
  }

  /**
   * Replace the history with a DEEP copy of `turns` — used to prime a FORK
   * from its parent's canonical history (`session.fork`). Clears any
   * in-progress turn state, like reset(). structuredClone (not a spread) so
   * the fork and parent never share nested `toolCalls` / `input` objects —
   * a mutation on either side can't leak to the other.
   */
  seed(turns: readonly CanonicalTurn[]): void {
    this.#clear();
    this.#history = turns.map((t) => structuredClone(t));
    this.#currentTurnId = lastTurnId(this.#history);
    this.#emit({ op: "replace", turns: this.#history });
  }

  /**
   * Load a persisted history on restart (#354). Like seed(), but silent: the
   * turns came FROM the log, so writing them back would be a no-op rewrite.
   */
  restore(turns: readonly CanonicalTurn[]): void {
    this.#clear();
    this.#history = turns.map((t) => structuredClone(t));
    this.#currentTurnId = lastTurnId(this.#history);
  }
}

function lastTurnId(turns: readonly CanonicalTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const id = turns[i]?.turnId;
    if (id) return id;
  }
  return undefined;
}

// ── History seeding (provider switch) ─────────────────────────────────────────

/** Character budget for a rendered history seed (~6k tokens). */
export const HISTORY_SEED_MAX_CHARS = 24_000;

/** Per-tool output budget inside the seed — the global budget drops whole
 *  turns oldest-first, this keeps one chatty tool from eating a turn. */
const SEED_TOOL_OUTPUT_MAX_CHARS = 2_000;

/**
 * Render one tool call as a structured text block for the seed: full input
 * as JSON, fenced output. Structured-text — richer than a one-line summary,
 * still prose (see renderHistorySeed's fidelity contract).
 */
function toolCallToSeedText(tc: CanonicalToolCall): string {
  const output =
    tc.output.length > SEED_TOOL_OUTPUT_MAX_CHARS
      ? `${tc.output.slice(0, SEED_TOOL_OUTPUT_MAX_CHARS)}\n…output truncated for seed…`
      : tc.output;
  // Inputs need the same cap: a Write/Edit tool call carries the full file
  // contents in `input.content`, so an uncapped stringify can put multiple
  // MB into a seed with a ~24 KB budget.
  const inputJson = JSON.stringify(tc.input);
  const input =
    inputJson.length > SEED_TOOL_OUTPUT_MAX_CHARS
      ? `${inputJson.slice(0, SEED_TOOL_OUTPUT_MAX_CHARS)}…input truncated for seed…`
      : inputJson;
  return [
    `### Tool call: ${tc.name} → ${tc.success ? "ok" : "ERROR"}`,
    `input: ${input}`,
    "output:",
    "```",
    output,
    "```",
  ].join("\n");
}

/**
 * Render the canonical history as a structured-text transcript block for
 * seeding a NEW warm backend after `session.set_provider`. Stateless
 * providers ignore this (they consume `TurnOpts.history` natively every
 * turn — see the to*Messages converters above); warm providers (claude, pi)
 * prepend it to their first post-switch prompt so the incoming agent can
 * continue the conversation.
 *
 * Fidelity contract: this is a faithful TRANSCRIPT, not a native
 * continuation. Tool calls are rendered as structured text blocks (name,
 * JSON input, fenced output) rather than native tool_use structures —
 * neither the Claude Agent SDK nor pi's RPC accepts synthesized native
 * history injection, so a prompt-prefix transcript is the warm-backend
 * ceiling. Oldest turns are dropped first when the budget is exceeded
 * (recent context matters most), with an elision note.
 *
 * `maxChars` should be sized to the TARGET model's context window by the
 * caller (see seedBudgetChars in context-windows.ts) so a fork only truncates
 * when the history genuinely won't fit. The result reports how many turns were
 * kept vs omitted so the session can SURFACE truncation to the user.
 */
export interface HistorySeedResult {
  /** The rendered <conversation-history> block, or "" for empty history. */
  text: string;
  /** Turns in the source history. */
  totalTurns: number;
  /** Turns carried into the seed whole (newest-first). */
  keptTurns: number;
  /** Oldest turns dropped because they exceeded the budget. */
  omittedTurns: number;
  /** True when the single newest turn alone busted the budget and was sliced. */
  newestTurnSliced: boolean;
}

export function renderHistorySeed(
  history: readonly CanonicalTurn[],
  opts: { maxChars?: number } = {},
): HistorySeedResult {
  if (history.length === 0) {
    return { text: "", totalTurns: 0, keptTurns: 0, omittedTurns: 0, newestTurnSliced: false };
  }
  const maxChars = opts.maxChars ?? HISTORY_SEED_MAX_CHARS;

  const rendered = history.map((turn) => {
    if (turn.role === "user") {
      return `## User\n${turn.content}`;
    }
    const parts: string[] = [`## Assistant (${turn.providerId}/${turn.model})`];
    if (turn.content) parts.push(turn.content);
    for (const tc of turn.toolCalls ?? []) {
      parts.push(toolCallToSeedText(tc));
    }
    return parts.join("\n");
  });

  // Keep the newest turns whole; drop the oldest that don't fit. The
  // newest block is kept even when it alone busts the budget — but
  // hard-sliced to it, so one pathological turn can't blow the incoming
  // backend's first prompt (or the RPC frame) by orders of magnitude.
  const kept: string[] = [];
  let used = 0;
  let newestTurnSliced = false;
  for (let i = rendered.length - 1; i >= 0; i--) {
    let block = rendered[i]!;
    if (used + block.length > maxChars) {
      if (kept.length > 0) break;
      block = `${block.slice(0, maxChars)}\n…turn truncated for seed…`;
      newestTurnSliced = true;
    }
    kept.unshift(block);
    used += block.length;
  }
  const keptTurns = kept.length;
  const omittedTurns = rendered.length - keptTurns;
  if (omittedTurns > 0) {
    kept.unshift(`[…${omittedTurns} earlier turn(s) omitted for length…]`);
  }

  const text = [
    "<conversation-history>",
    "You are taking over an ongoing session from another agent backend.",
    "The conversation so far follows — tool calls appear as structured",
    "blocks (name, input JSON, fenced output), possibly truncated.",
    "Continue it seamlessly — do not re-introduce yourself or repeat",
    "completed work.",
    "",
    kept.join("\n\n"),
    "</conversation-history>",
  ].join("\n");

  return { text, totalTurns: rendered.length, keptTurns, omittedTurns, newestTurnSliced };
}
