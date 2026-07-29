import { describe, it, expect } from "bun:test";
import { findPendingApproval } from "./approvals.js";
import type { SessionMessage, SessionStatus, ToolState } from "@highflame/codeoid-protocol";

const identity = { sub: "spiffe://x/agent/a", name: "you", type: "human" as const };

function msg(
  messageId: string,
  role: SessionMessage["role"],
  tool?: { name: string; state: ToolState },
): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s1",
    messageId,
    role,
    content: "",
    identity,
    timestamp: "2026-05-04T08:00:00Z",
    ...(tool ? { tool: { toolId: `t-${messageId}`, ...tool } } : {}),
  };
}

function waiting(messageId: string, approvalId: string): SessionMessage {
  return msg(messageId, "tool_call", {
    name: "Bash",
    state: { phase: "waiting_confirmation", input: {}, description: "run it", approvalId },
  });
}

function completedTool(messageId: string): SessionMessage {
  return msg(messageId, "tool_call", {
    name: "Bash",
    state: { phase: "completed", success: true, output: "ok" },
  });
}

describe("findPendingApproval", () => {
  it("returns null when the session status precludes approvals (idle / error / missing)", () => {
    const arr = [waiting("m1", "ap-1")];
    expect(findPendingApproval(arr, "idle")).toBeNull();
    expect(findPendingApproval(arr, "error")).toBeNull();
    expect(findPendingApproval(arr, undefined)).toBeNull();
  });

  it("finds a pending approval for every active status", () => {
    const arr = [msg("u1", "user"), waiting("m1", "ap-1")];
    const active: SessionStatus[] = ["waiting_approval", "thinking", "tool_running"];
    for (const status of active) {
      expect(findPendingApproval(arr, status)?.messageId).toBe("m1");
    }
  });

  it("returns the OLDEST pending approval in the current turn (matches previous forward-scan semantics)", () => {
    const arr = [
      msg("u1", "user"),
      waiting("m1", "ap-old"),
      completedTool("m2"),
      waiting("m3", "ap-new"),
    ];
    expect(findPendingApproval(arr, "waiting_approval")?.messageId).toBe("m1");
  });

  it("does not scan past the current turn boundary (last user message)", () => {
    const arr = [
      waiting("stale", "ap-stale"), // previous turn — must be ignored
      msg("u1", "user"),
      completedTool("m2"),
    ];
    expect(findPendingApproval(arr, "waiting_approval")).toBeNull();
  });

  it("returns null when nothing is waiting", () => {
    const arr = [msg("u1", "user"), completedTool("m2"), msg("a1", "assistant")];
    expect(findPendingApproval(arr, "tool_running")).toBeNull();
    expect(findPendingApproval([], "waiting_approval")).toBeNull();
  });

  it("surfaces the second parallel approval after the first resolves mid-turn", () => {
    // The motivating scenario for the active-status gate: two approvals
    // pend in the same turn; the daemon flips status to tool_running when
    // the first is approved while the second still waits.
    const arr = [msg("u1", "user"), waiting("m1", "ap-1"), waiting("m2", "ap-2")];
    expect(findPendingApproval(arr, "waiting_approval")?.messageId).toBe("m1");
    // First approval resolved in place; status now tool_running.
    arr[1] = msg("m1", "tool_call", {
      name: "Bash",
      state: { phase: "executing" },
    });
    expect(findPendingApproval(arr, "tool_running")?.messageId).toBe("m2");
  });
});
