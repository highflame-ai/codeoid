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
 * A hook REWRITE is listed only on backends that run the rewritten input;
 * on one that runs its own input (codex, the Gemini CLI, qwen) the call is
 * refused before it parks, so it never appears here (#367). A codex MCP
 * approval names only the server; it is tied to its call by the tool and
 * arguments codex reports, and declined when that is ambiguous (#368).
 */

import type { ToolRisk } from "./types.js";

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
  /** A shell command's risk (#431). */
  risk?: ToolRisk;
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
