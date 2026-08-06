/**
 * Shared pending-approval lookup for ApprovalBar + desktop notifications.
 *
 * The naive version scanned the ENTIRE message array from index 0 on every
 * streaming delta — O(N) per delta on a 5 000-message session. Two levers
 * keep this cheap while preserving user-visible behavior:
 *
 *   1. Status gate. Approvals can only pend mid-turn, so when the session
 *      is `idle` / `error` there is nothing to find and we skip the scan
 *      entirely. We deliberately gate on "any active status" rather than
 *      strictly `waiting_approval`: with parallel pending approvals (rare,
 *      stream-input mode) the daemon flips status to `tool_running` /
 *      `thinking` the moment the FIRST approval resolves even though a
 *      second is still waiting (session.ts resolves each canUseTool with
 *      `setStatus(approved ? "tool_running" : "thinking")`), and a strict
 *      gate would hide that second approval bar forever — deadlocking the
 *      turn from the user's point of view.
 *
 *   2. Turn-bounded backward scan. Pending approvals live in the CURRENT
 *      turn — every earlier turn's tool calls were finalized (executing /
 *      cancelled) before the next user message could be accepted. So scan
 *      backward from the tail and stop at the first `user` message. Within
 *      that window the OLDEST pending match wins, matching the previous
 *      forward-scan semantics (the daemon serializes approvals oldest
 *      first).
 */

import type { SessionMessage, SessionStatus } from "@highflame/codeoid-protocol";

const APPROVAL_POSSIBLE: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "waiting_approval",
  "thinking",
  "tool_running",
]);

/**
 * Find the oldest tool_call in `waiting_confirmation` within the current
 * turn, or null. `status` is the session's current status (undefined when
 * the session record is missing).
 */
export function findPendingApproval(
  messages: readonly SessionMessage[],
  status: SessionStatus | undefined,
): SessionMessage | null {
  if (!status || !APPROVAL_POSSIBLE.has(status)) return null;
  let oldest: SessionMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user") break; // turn boundary — nothing pends earlier
    if (
      m.role === "tool_call" &&
      m.tool &&
      m.tool.state.phase === "waiting_confirmation"
    ) {
      oldest = m; // keep walking — an earlier pending in this turn wins
    }
  }
  return oldest;
}
