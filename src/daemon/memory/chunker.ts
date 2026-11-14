/**
 * EpisodeChunker — converts a stream of session messages into episodes.
 *
 * Chunking strategy: one episode per natural boundary.
 *   - Each completed tool call (input + result + surrounding reasoning) → tool_call episode
 *   - A user message followed by assistant text with NO tool use → user_turn + assistant_turn merged into one episode
 *   - An error event → error episode
 *
 * The chunker is stateful per-session: it accumulates pending context (the last
 * user prompt, any assistant text leading into a tool call) and emits episodes
 * as boundaries close. Callers push messages via `onMessage`; the chunker
 * invokes the `emit` callback whenever an episode is ready.
 */

import type { SessionMessage } from "../../protocol/types.js";
import type { Episode, EpisodeOrigin } from "./types.js";
import { takeSpill } from "../compress/spill.js";

export interface ChunkerContext {
  workspaceId: string;
  sessionId: string;
  createdBy: string;
  /** Where compressed commands spill their raw output (compress/spill.ts).
   *  When set, a tool result naming a spill file is stored with the raw
   *  output in place of the compressed text the agent saw. */
  spillDir?: string;
  /** What the session knows of a tool call (docs/secrets-and-memory-design.md §3): where it ran, its exit code, how long it ran. */
  toolFacts?: (messageId: string) => { cwd?: string; exitCode?: number; durationMs?: number } | undefined;
  /** Who and what produced the episodes of the turn running now. */
  turnFacts?: () => { backend?: string; model?: string; origin?: EpisodeOrigin; workstream?: string };
}

/** Paths seen in a tool input — used for path-overlap ranking. */
export function extractFilePaths(
  toolName: string | undefined,
  input: unknown,
): string[] {
  if (!input || typeof input !== "object") return [];
  const rec = input as Record<string, unknown>;
  const paths: string[] = [];

  const candidates = ["file_path", "path", "filePath", "filename"];
  for (const key of candidates) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) paths.push(v);
  }

  const arrCandidates = ["paths", "files"];
  for (const key of arrCandidates) {
    const v = rec[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") paths.push(item);
      }
    }
  }

  // Grep/Glob patterns aren't literal file paths but are still routing signals.
  if (toolName === "Grep" || toolName === "Glob") {
    const pat = rec.pattern ?? rec.glob;
    if (typeof pat === "string") paths.push(pat);
  }

  return [...new Set(paths)];
}

function estimateTokens(text: string): number {
  // Conservative ~4 chars/token heuristic. Good enough for budget tracking.
  return Math.ceil(text.length / 4);
}

interface OpenToolCall {
  messageId: string;
  toolName: string;
  input: unknown;
  filePaths: string[];
  startedAt: number;
  userPrompt: string | null;
  priorAssistantText: string;
  createdBy: string;
  /** Who and what, and in which workstream, as they were when the call opened (it may complete after a later turn began). */
  facts: { backend?: string; model?: string; origin?: EpisodeOrigin; workstream?: string };
}

export class EpisodeChunker {
  #ctx: ChunkerContext;
  #onEpisode: (ep: Omit<Episode, "id">) => void;

  /** The most recent user prompt, kept as context for the next tool_call or assistant_turn. */
  #pendingUserPrompt: string | null = null;
  /** Assistant reasoning accumulated between tool calls. */
  #pendingAssistantText: string[] = [];
  /** Tool calls awaiting their result, by message id: a turn can run several at once. */
  #openToolCalls = new Map<string, OpenToolCall>();
  #lastAssistantBy: string | null = null;
  #lastAssistantAt: string | null = null;

  constructor(ctx: ChunkerContext, onEpisode: (ep: Omit<Episode, "id">) => void) {
    this.#ctx = ctx;
    this.#onEpisode = onEpisode;
  }

  /** Push a session message. May synchronously invoke the emit callback. */
  onMessage(msg: SessionMessage): void {
    switch (msg.role) {
      case "user":
        this.#closeStandaloneAssistantTurnIfAny();
        // What the previous turn left unsaid (a reply after its calls) is its own episode.
        this.#flushReply();
        this.#pendingUserPrompt = msg.content;
        this.#pendingAssistantText = [];
        break;

      case "assistant":
        // Held until it is known what it is: reasoning for the call that follows it (a call opens
        // with it), or the turn's answer, stored with the prompt when the turn ends (#flushReply).
        this.#pendingAssistantText.push(msg.content);
        this.#lastAssistantBy = msg.identity.sub;
        this.#lastAssistantAt = msg.timestamp;
        break;

      case "tool_call": {
        if (!msg.tool) break;
        const phase = msg.tool.state.phase;
        if (phase === "executing" || phase === "waiting_confirmation") {
          // Already open (a call asked, then approved): keep what it opened with.
          if (this.#openToolCalls.has(msg.messageId)) break;
          const input =
            "input" in msg.tool.state ? (msg.tool.state.input as unknown) : {};
          this.#openToolCalls.set(msg.messageId, {
            messageId: msg.messageId,
            toolName: msg.tool.name,
            input,
            filePaths: extractFilePaths(msg.tool.name, input),
            startedAt: Date.parse(msg.timestamp) || Date.now(),
            createdBy: msg.identity.sub,
            facts: this.#ctx.turnFacts?.() ?? {},
            userPrompt: this.#pendingUserPrompt,
            priorAssistantText: this.#pendingAssistantText.join("\n\n"),
          });
          this.#pendingAssistantText = [];
        } else if (phase === "completed" || phase === "cancelled") {
          if (this.#openToolCalls.has(msg.messageId)) {
            const state = msg.tool.state as { output?: unknown; message?: unknown };
            const output = phase === "completed" ? state.output : state.message;
            const reason = (msg.tool.state as { reason?: unknown }).reason;
            this.#emitOpenToolCall(
              msg.messageId,
              typeof output === "string" && output ? output : phase === "cancelled" ? (reason === "interrupted" ? "interrupted" : "cancelled") : "",
              msg.timestamp,
              msg.identity.sub,
            );
          }
        }
        break;
      }

      case "tool_result": {
        // If the SDK ever surfaces explicit tool_result messages, treat as the oldest open call's completion.
        const first = this.#openToolCalls.keys().next().value;
        if (first !== undefined) this.#emitOpenToolCall(first, msg.content, msg.timestamp, msg.identity.sub);
        break;
      }

      case "system":
      case "info": {
        const isError = msg.role === "system" && /error|failed/i.test(msg.content);
        if (isError) {
          this.#emitErrorEpisode(msg.content, msg.timestamp, msg.identity.sub);
        }
        break;
      }

      case "thinking":
        // Thinking isn't persisted as an episode — it's transient UX.
        break;
    }
  }

  /**
   * Call when the turn is done (SDK result message): a call still open never
   * got its result (a backend that settled it unseen) and closes as
   * unfinished; a reply that came after the turn's tool calls is the turn's
   * answer, and becomes its episode.
   */
  onTurnEnd(): void {
    // A call still open may be background work that completes later: it stays open, its episode
    // closing with its result. Bounded: past an hour, or past 64 open, the oldest close unfinished.
    const now = Date.now();
    for (const [id, tc] of [...this.#openToolCalls]) {
      if (!(now - tc.startedAt <= 3_600_000) || this.#openToolCalls.size > 64) this.#emitOpenToolCall(id, "unfinished", new Date().toISOString(), tc.createdBy);
    }
    this.#flushReply();
    this.#closeStandaloneAssistantTurnIfAny();
  }

  /**
   * The turn's answer: the text no call took as its reasoning, one episode with the prompt it
   * answers. The prompt stays for the rest of the turn (a turn can end and go on: a mid-turn
   * boundary), until the next prompt.
   */
  #flushReply(): void {
    if (this.#pendingAssistantText.length === 0) return;
    this.#emitTurnEpisode(this.#pendingAssistantText.join("\n\n"), this.#lastAssistantAt ?? new Date().toISOString(), this.#lastAssistantBy ?? this.#ctx.createdBy);
    this.#pendingAssistantText = [];
  }

  /** A turn the backend began itself (a background wake): what came before is stored, and no prompt goes on. */
  onAdoptedTurn(): void {
    this.#flushReply();
    this.#pendingUserPrompt = null;
  }

  /**
   * The session is ending (destroyed, the daemon stopping): every call still open is stored as
   * unfinished, and what the turn said is stored, so nothing it did is lost.
   */
  flushAll(): void {
    for (const [id, tc] of [...this.#openToolCalls]) this.#emitOpenToolCall(id, "unfinished", new Date().toISOString(), tc.createdBy);
    this.#flushReply();
  }

  // ── Episode emission ──────────────────────────────────────────────────

  #emitOpenToolCall(messageId: string, output: string, timestamp: string, createdBy: string): void {
    const tc = this.#openToolCalls.get(messageId);
    if (!tc) return;
    this.#openToolCalls.delete(messageId);

    const parts: string[] = [];
    if (tc.userPrompt) parts.push(`# User intent\n${tc.userPrompt}`);
    if (tc.priorAssistantText) parts.push(`# Reasoning\n${tc.priorAssistantText}`);
    parts.push(`# Tool: ${tc.toolName}`);
    parts.push(`## Input\n${safeStringify(tc.input)}`);
    // The whole output, verbatim. MemoryEngine.ingest keeps it in full and
    // indexes a bounded view, so a huge build log costs storage, not a stall.
    // A compressed command's raw output replaces the compressed text here.
    const raw = output && this.#ctx.spillDir ? takeSpill(output, this.#ctx.spillDir) : null;
    if (raw !== null) {
      parts.push(`## Result (uncompressed — the agent saw a compressed version)\n${raw}`);
    } else if (output) {
      parts.push(`## Result\n${output}`);
    }

    const content = parts.join("\n\n");
    const summary = `${tc.toolName}(${summarizeInput(tc.input)})`;

    const facts = this.#ctx.toolFacts?.(tc.messageId);
    this.#onEpisode({
      workspaceId: this.#ctx.workspaceId,
      sessionId: this.#ctx.sessionId,
      kind: "tool_call",
      toolName: tc.toolName,
      summary,
      content,
      filePaths: tc.filePaths,
      tokenEstimate: estimateTokens(content),
      createdAt: Date.parse(timestamp) || Date.now(),
      createdBy,
      ...this.#turnFacts(tc.facts),
      ...(tc.facts.workstream ? { workstreamId: tc.facts.workstream } : {}),
      ...(facts?.cwd ? { cwd: facts.cwd } : {}),
      ...(facts?.exitCode !== undefined ? { exitCode: facts.exitCode } : {}),
      ...(facts?.durationMs !== undefined ? { durationMs: facts.durationMs } : {}),
    });

    // Leave pendingUserPrompt in place — later tool calls in the same turn share it.
  }

  #emitTurnEpisode(assistantText: string, timestamp: string, createdBy: string): void {
    const userPrompt = this.#pendingUserPrompt;
    if (!userPrompt && !assistantText) return;

    const content = [
      userPrompt ? `# User\n${userPrompt}` : "",
      assistantText ? `# Assistant\n${assistantText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const summary = userPrompt
      ? truncate(userPrompt.replace(/\s+/g, " "), 120)
      : truncate(assistantText.replace(/\s+/g, " "), 120);

    this.#onEpisode({
      workspaceId: this.#ctx.workspaceId,
      sessionId: this.#ctx.sessionId,
      kind: userPrompt ? "user_turn" : "assistant_turn",
      summary,
      content,
      filePaths: [],
      tokenEstimate: estimateTokens(content),
      createdAt: Date.parse(timestamp) || Date.now(),
      createdBy,
      ...this.#turnFacts(),
    });
  }

  #emitErrorEpisode(text: string, timestamp: string, createdBy: string): void {
    this.#onEpisode({
      workspaceId: this.#ctx.workspaceId,
      sessionId: this.#ctx.sessionId,
      kind: "error",
      summary: truncate(text, 120),
      content: text,
      filePaths: [],
      tokenEstimate: estimateTokens(text),
      createdAt: Date.parse(timestamp) || Date.now(),
      createdBy,
      ...this.#turnFacts(),
    });
  }

  #turnFacts(at?: OpenToolCall["facts"]): { backend?: string; model?: string; origin?: EpisodeOrigin } {
    const f = at ?? this.#ctx.turnFacts?.();
    if (!f) return {};
    return { ...(f.backend ? { backend: f.backend } : {}), ...(f.model ? { model: f.model } : {}), ...(f.origin ? { origin: f.origin } : {}) };
  }

  #closeStandaloneAssistantTurnIfAny(): void {
    // If a user prompt is pending with no tool calls or assistant reply,
    // it stays pending — we only emit once the assistant responds or a new turn starts.
    // This method is a hook for future behaviors (timeouts, etc.); currently a no-op.
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function summarizeInput(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 0) return "";
  // Prefer path-like fields in the summary.
  for (const key of ["file_path", "path", "pattern", "command"]) {
    const val = rec[key];
    if (typeof val === "string") return truncate(val, 60);
  }
  return keys.slice(0, 3).join(", ");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
