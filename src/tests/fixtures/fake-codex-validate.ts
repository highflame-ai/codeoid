/**
 * Pure wire-shape validators shared by fake-codex.ts and the codex tests.
 * Kept side-effect-free (no stdin/stdout) so tests can import it directly.
 */

/** codex `SandboxPolicy` variant `type`s from @openai/codex@0.144.1 generate-ts. */
export const SANDBOX_POLICY_TYPES = new Set([
  "dangerFullAccess",
  "readOnly",
  "workspaceWrite",
  "externalSandbox",
]);

/**
 * Reject any sandboxPolicy shape the REAL codex app-server would reject, with
 * the same serde error text — so a codeoid regression that sends the bare
 * kebab string (the 0.144.1 turn/start failure) trips the offline tests too.
 * Returns an error message, or null when the shape is valid / absent.
 */
export function sandboxPolicyError(sandboxPolicy: unknown): string | null {
  if (sandboxPolicy === undefined || sandboxPolicy === null) return null; // optional field
  if (typeof sandboxPolicy === "string") {
    return `Invalid request: invalid type: string "${sandboxPolicy}", expected internally tagged enum SandboxPolicyDeserialize`;
  }
  if (typeof sandboxPolicy !== "object") {
    return "Invalid request: invalid type, expected internally tagged enum SandboxPolicyDeserialize";
  }
  const type = (sandboxPolicy as { type?: unknown }).type;
  if (typeof type !== "string" || !SANDBOX_POLICY_TYPES.has(type)) {
    return `Invalid request: unknown variant \`${String(type)}\`, expected one of SandboxPolicyDeserialize`;
  }
  return null;
}

/**
 * Approval reply decisions the REAL codex app-server accepts (codex-cli 0.154.0
 * `generate-json-schema`: CommandExecutionApprovalDecision /
 * FileChangeApprovalDecision). The object-shaped command decisions
 * (acceptWithExecpolicyAmendment, …) are omitted — codeoid never sends them.
 */
export const COMMAND_APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
export const FILE_CHANGE_APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

/**
 * Validate a client's reply to an item/* approval request the way the real
 * codex does: an invalid reply fails the approval ("approval request failed"),
 * which codex reports to the agent as a rejection. Returns an error, or null.
 */
export function approvalReplyError(method: string, reply: Record<string, unknown>): string | null {
  if (method === "item/permissions/requestApproval") {
    const p = reply.permissions;
    return p && typeof p === "object" && !Array.isArray(p) ? null : "approval request failed: missing permissions grant";
  }
  const allowed = method === "item/fileChange/requestApproval" ? FILE_CHANGE_APPROVAL_DECISIONS : COMMAND_APPROVAL_DECISIONS;
  const d = reply.decision;
  return typeof d === "string" && allowed.has(d) ? null : `approval request failed: unknown decision ${JSON.stringify(d)}`;
}
