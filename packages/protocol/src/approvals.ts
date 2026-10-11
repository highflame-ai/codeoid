/**
 * Pending tool approvals (#349): what a session is parked on, read by a client
 * that is not attached to the stream — the one-shot `codeoid approve` — so it
 * can show exactly what would run and answer by the real id.
 *
 * The daemon reports the input its approval gate RECEIVED (after any hook
 * rewrite), not the announced tool message: a backend that ties a gate to its
 * announcement by tool name alone could otherwise show one call while another
 * is parked. Only calls actually waiting are listed — never a leftover
 * `waiting_confirmation` row in the scrollback from a past run.
 *
 * Known limits, inherited from the backends (tracked separately): codex and
 * the Gemini CLI (ACP) answer an approval with yes/no only and run their own
 * input, so a hook REWRITE shown here does not apply on them; and codex ties
 * an MCP elicitation to its call by server name, so with two calls in flight
 * to one server the input shown can be the other call's.
 */

// ── Messages (client → daemon) ────────────────────────────────────────────────

/** List the tool calls a session is waiting on, oldest first. Scope: `session:watch`. */
export interface SessionApprovalsMsg {
  type: "session.approvals";
  id: string;
  sessionId: string;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface PendingToolApproval {
  /** Answer it with `session.approve` and this id. */
  approvalId: string;
  toolName: string;
  /** The input the approval gate received — what runs if approved, within the limits above. */
  input: unknown;
}

export interface SessionApprovalsResultMsg {
  type: "session.approvals.result";
  requestId: string;
  sessionId: string;
  approvals: PendingToolApproval[];
}

/**
 * `data` of the `response.ok` to a `session.approve`: whether the answer took
 * effect. `stale` = nothing was waiting on that id (answered elsewhere,
 * withdrawn, or from a past run) — still `response.ok`, because a client
 * dismissing a leftover prompt is not an error.
 */
export type SessionApproveOutcome = "settled" | "early" | "stale";
