/**
 * Rebuild a session's canonical history from its transcript (#354).
 *
 * Only for sessions recorded before the canonical-history log existed: until
 * then the backend-neutral history lived in memory alone, so after a restart
 * a session forked or switched backend with NO conversation. The transcript
 * is the only durable record of those sessions, so we reconstruct from it —
 * best-effort: what the person typed (not the attachment bodies injected
 * alongside), the agent's visible replies, its thinking, and the primary
 * agent's completed tool calls. Sub-agent work is excluded, matching what the
 * live accumulator records.
 */

import type { DaemonMessage, SessionMessage } from "../protocol/types.js";
import {
  type CanonicalToolCall,
  type CanonicalTurn,
  limitToolOutput,
  normalizeToolName,
} from "./providers/canonical.js";

/** Text recorded for a turn the agent started on its own (see Session#adoptTurn). */
const BACKGROUND_TURN_TEXT = "(Background work finished; the agent harness delivered the results.)";

export function canonicalFromTranscript(messages: readonly DaemonMessage[], providerId: string): CanonicalTurn[] {
  const out: CanonicalTurn[] = [];
  let text: string[] = [];
  let thinking = "";
  let tools: CanonicalToolCall[] = [];
  let turnId: string | undefined;
  let open = false;

  const flush = () => {
    if (!open) return;
    const content = text.join("\n\n");
    if (content || tools.length > 0 || thinking) {
      out.push({
        role: "assistant",
        content,
        ...(turnId ? { turnId } : {}),
        ...(tools.length > 0 ? { toolCalls: tools } : {}),
        ...(thinking ? { thinking } : {}),
        providerId,
        model: "unknown",
      });
    }
    text = [];
    thinking = "";
    tools = [];
  };

  for (const raw of messages) {
    if (raw.type !== "session.message") continue;
    const m = raw as SessionMessage;
    if (m.identity?.type === "subagent") continue;
    const background = m.role === "info" && m.metadata?.event === "turn.adopted";
    if (m.role === "user" || background) {
      flush();
      turnId = m.turnId;
      out.push({
        role: "user",
        content: background ? BACKGROUND_TURN_TEXT : m.content,
        ...(turnId ? { turnId } : {}),
        ...(m.timestamp ? { at: m.timestamp } : {}),
        ...(background ? { background: true } : {}),
      });
      open = true;
      continue;
    }
    if (!open) continue; // replies before the first prompt can't be placed
    if (m.role === "assistant" && m.content) {
      text.push(m.content);
    } else if (m.role === "thinking" && m.content) {
      thinking += m.content;
    } else if (m.role === "tool_call" && m.tool && m.tool.state.phase === "completed") {
      const name = normalizeToolName(m.tool.name);
      const input = m.tool.input && typeof m.tool.input === "object" ? (m.tool.input as Record<string, unknown>) : {};
      tools.push({
        id: m.tool.toolId,
        name,
        originalName: m.tool.name,
        input,
        output: limitToolOutput(name, m.tool.state.output ?? ""),
        success: m.tool.state.success,
      });
    }
  }
  flush();
  return out;
}
