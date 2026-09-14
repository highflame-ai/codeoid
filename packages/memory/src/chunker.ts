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

import type { SessionMessage } from "@highflame/codeoid-protocol";
import type { Episode } from "./types.js";

/** Ceiling on tool output persisted into a memory episode — mirrors the
 * transcript layer's 64 KiB persist cap (transcript.ts). */
const EPISODE_OUTPUT_CAP_CHARS = 64 * 1024;

export interface ChunkerContext {
  workspaceId: string;
  sessionId: string;
  createdBy: string;
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

export class EpisodeChunker {
  #ctx: ChunkerContext;
  #onEpisode: (ep: Omit<Episode, "id">) => void;

  /** The most recent user prompt, kept as context for the next tool_call or assistant_turn. */
  #pendingUserPrompt: string | null = null;
  /** Assistant reasoning accumulated between tool calls. */
  #pendingAssistantText: string[] = [];
  /** Open tool_call episode awaiting completion. */
  #openToolCall: {
    messageId: string;
    toolName: string;
    input: unknown;
    filePaths: string[];
    startedAt: number;
    userPrompt: string | null;
    priorAssistantText: string;
  } | null = null;

  constructor(ctx: ChunkerContext, onEpisode: (ep: Omit<Episode, "id">) => void) {
    this.#ctx = ctx;
    this.#onEpisode = onEpisode;
  }

  /** Push a session message. May synchronously invoke the emit callback. */
  onMessage(msg: SessionMessage): void {
    switch (msg.role) {
      case "user":
        this.#closeStandaloneAssistantTurnIfAny();
        this.#pendingUserPrompt = msg.content;
        this.#pendingAssistantText = [];
        break;

      case "assistant":
        if (this.#openToolCall) {
          // Assistant text between tool calls — treat as follow-up reasoning for next tool call.
          this.#pendingAssistantText.push(msg.content);
        } else {
          // Plain assistant turn with no tool use — emit user+assistant combined.
          this.#emitTurnEpisode(msg.content, msg.timestamp, msg.identity.sub);
          this.#pendingUserPrompt = null;
          this.#pendingAssistantText = [];
        }
        break;

      case "tool_call": {
        if (!msg.tool) break;
        const phase = msg.tool.state.phase;
        if (phase === "executing" || phase === "waiting_confirmation") {
          // Close any prior unfinished tool_call before opening a new one.
          if (this.#openToolCall) {
            this.#emitOpenToolCall("unfinished", msg.timestamp, msg.identity.sub);
          }
          const input =
            "input" in msg.tool.state ? (msg.tool.state.input as unknown) : {};
          this.#openToolCall = {
            messageId: msg.messageId,
            toolName: msg.tool.name,
            input,
            filePaths: extractFilePaths(msg.tool.name, input),
            startedAt: Date.parse(msg.timestamp),
            userPrompt: this.#pendingUserPrompt,
            priorAssistantText: this.#pendingAssistantText.join("\n\n"),
          };
          this.#pendingAssistantText = [];
        } else if (phase === "completed" || phase === "cancelled") {
          if (
            this.#openToolCall &&
            this.#openToolCall.messageId === msg.messageId
          ) {
            const output =
              phase === "completed" && "output" in msg.tool.state
                ? (msg.tool.state.output as string | undefined)
                : undefined;
            this.#emitOpenToolCall(output ?? "", msg.timestamp, msg.identity.sub);
          }
        }
        break;
      }

      case "tool_result": {
        // If the SDK ever surfaces explicit tool_result messages, treat as completion.
        if (this.#openToolCall) {
          this.#emitOpenToolCall(msg.content, msg.timestamp, msg.identity.sub);
        }
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

  /** Call when the turn is done (SDK result message) to flush any standalone assistant turn. */
  onTurnEnd(): void {
    this.#closeStandaloneAssistantTurnIfAny();
  }

  // ── Episode emission ──────────────────────────────────────────────────

  #emitOpenToolCall(output: string, timestamp: string, createdBy: string): void {
    const tc = this.#openToolCall;
    if (!tc) return;
    this.#openToolCall = null;

    const parts: string[] = [];
    if (tc.userPrompt) parts.push(`# User intent\n${tc.userPrompt}`);
    if (tc.priorAssistantText) parts.push(`# Reasoning\n${tc.priorAssistantText}`);
    parts.push(`# Tool: ${tc.toolName}`);
    parts.push(`## Input\n${safeStringify(tc.input)}`);
    // Cap what memory persists, mirroring the transcript layer's cap: the
    // insert (and its FTS tokenization) runs on the shared event path, so
    // an uncapped 10 MB build log would stall every attached client while
    // SQLite chews it — and the episodes DB has no retention story yet.
    if (output) {
      const capped =
        output.length > EPISODE_OUTPUT_CAP_CHARS
          ? `${output.slice(0, EPISODE_OUTPUT_CAP_CHARS)}\n…truncated for memory…`
          : output;
      parts.push(`## Result\n${capped}`);
    }

    const content = parts.join("\n\n");
    const summary = `${tc.toolName}(${summarizeInput(tc.input)})`;

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
    });
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
