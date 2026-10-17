/**
 * Native history for the Codex backend (#387): codeoid's canonical
 * conversation as Responses API items, appended to a fresh thread with
 * `thread/inject_items`, so a fork, rewind or backend switch onto Codex
 * continues a real conversation — tool calls as `function_call` /
 * `function_call_output` items — instead of reading a transcript in its first
 * prompt. Codex persists injected items like its own (verified live across an
 * app-server restart).
 *
 * Reasoning is not carried: Codex's own is encrypted, other vendors' can't be
 * replayed as Codex reasoning.
 */

import { randomBytes } from "node:crypto";
import { type CanonicalTurn, canonicalTurnChars, fitTurnsToBudget, type HistorySeedResult } from "../canonical.js";

export type ResponsesItem =
  | { type: "message"; role: "user"; content: Array<{ type: "input_text"; text: string }> }
  | { type: "message"; role: "assistant"; content: Array<{ type: "output_text"; text: string }> }
  | { type: "function_call"; name: string; call_id: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Function names the Responses API accepts. */
const functionName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";

/**
 * Canonical history → Responses items, oldest first. Per assistant turn: each
 * tool call as a `function_call` with its `function_call_output`, then the
 * turn's text. Tool names are the backend's own when the turn ran on Codex,
 * else the neutral canonical name (Codex accepts history naming tools it
 * doesn't have — verified live). Dropped turns are announced in a leading note.
 */
export function toResponsesItems(
  history: readonly CanonicalTurn[],
  opts: { maxChars: number },
): { items: ResponsesItem[]; truncation: HistorySeedResult } {
  const { turns, truncation } = fitTurnsToBudget(history, opts.maxChars, canonicalTurnChars);
  const items: ResponsesItem[] = [];
  const user = (text: string) => items.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  if (truncation.omittedTurns > 0) {
    user(`[${truncation.omittedTurns} earlier turn(s) of this conversation were left out to fit the context window.]`);
  }
  for (const turn of turns) {
    if (turn.role === "user") {
      user(turn.content);
      continue;
    }
    const own = turn.providerId === "codex";
    for (const tc of turn.toolCalls ?? []) {
      const call_id = `call_${randomBytes(12).toString("hex")}`;
      items.push({ type: "function_call", name: functionName(own && tc.originalName ? tc.originalName : tc.name), call_id, arguments: JSON.stringify(tc.input) });
      items.push({ type: "function_call_output", call_id, output: tc.success ? tc.output : `Error: ${tc.output}` });
    }
    if (turn.content) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: turn.content }] });
  }
  return { items, truncation };
}
