/**
 * Protocol v2 tests — validates message shapes, type guards, identity,
 * and the tool state machine contract.
 */

import { describe, test, expect } from "bun:test";
import {
  SYSTEM_IDENTITY,
  authToIdentity,
  type SessionMessage,
  type SessionMessageDelta,
  type AuthContext,
  type MessageRole,
  type ContentPart,
  type ToolState,
  type ToolPhase,
  type DaemonMessage,
  type ClientMessage,
} from "../protocol/types.js";

// =============================================================================
// Identity
// =============================================================================

describe("MessageIdentity", () => {
  test("SYSTEM_IDENTITY has correct shape", () => {
    expect(SYSTEM_IDENTITY.sub).toBe("system:codeoid");
    expect(SYSTEM_IDENTITY.name).toBe("Codeoid");
    expect(SYSTEM_IDENTITY.type).toBe("system");
  });

  test("authToIdentity maps direct auth to human", () => {
    const auth: AuthContext = {
      sub: "spiffe://zeroid.dev/personal/dev/human/ydatta",
      name: "Yash",
      scopes: [],
      delegationDepth: 0,
      accountId: "personal",
      projectId: "dev",
    };
    const identity = authToIdentity(auth);
    expect(identity.sub).toBe(auth.sub);
    expect(identity.name).toBe("Yash");
    expect(identity.type).toBe("human");
  });

  test("authToIdentity maps delegated auth to agent", () => {
    const auth: AuthContext = {
      sub: "spiffe://zeroid.dev/personal/dev/agent/codeoid-session-abc",
      name: "oracle agent",
      scopes: [],
      delegationDepth: 1,
      delegatedBy: "spiffe://zeroid.dev/personal/dev/human/ydatta",
      accountId: "personal",
      projectId: "dev",
    };
    const identity = authToIdentity(auth);
    expect(identity.type).toBe("agent");
  });

  test("authToIdentity preserves sub and name", () => {
    const auth: AuthContext = {
      sub: "spiffe://test",
      name: "Test User",
      scopes: [],
      delegationDepth: 0,
      accountId: "a",
      projectId: "p",
    };
    const identity = authToIdentity(auth);
    expect(identity.sub).toBe("spiffe://test");
    expect(identity.name).toBe("Test User");
  });
});

// =============================================================================
// SessionMessage
// =============================================================================

describe("SessionMessage", () => {
  const baseMessage = (overrides: Partial<SessionMessage> = {}): SessionMessage => ({
    type: "session.message",
    sessionId: "sess-1",
    messageId: "msg-1",
    role: "assistant",
    content: "Hello",
    identity: { sub: "agent:1", name: "Agent", type: "agent" },
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  test("required fields are present", () => {
    const msg = baseMessage();
    expect(msg.type).toBe("session.message");
    expect(msg.sessionId).toBeTruthy();
    expect(msg.messageId).toBeTruthy();
    expect(msg.role).toBeTruthy();
    expect(msg.content).toBeTruthy();
    expect(msg.identity).toBeTruthy();
    expect(msg.identity.sub).toBeTruthy();
    expect(msg.identity.type).toBeTruthy();
    expect(msg.timestamp).toBeTruthy();
  });

  test("all message roles are valid", () => {
    const roles: MessageRole[] = ["user", "assistant", "thinking", "tool_call", "tool_result", "system", "info"];
    for (const role of roles) {
      const msg = baseMessage({ role });
      expect(msg.role).toBe(role);
    }
  });

  test("user message carries sender identity", () => {
    const msg = baseMessage({
      role: "user",
      content: "Review this code",
      identity: { sub: "spiffe://zeroid.dev/personal/dev/human/ydatta", name: "Yash", type: "human" },
    });
    expect(msg.identity.type).toBe("human");
    expect(msg.identity.name).toBe("Yash");
  });

  test("tool_call message carries tool info", () => {
    const msg = baseMessage({
      role: "tool_call",
      content: "Read(file_path)",
      tool: {
        toolId: "tool-1",
        name: "Read",
        state: { phase: "executing" },
      },
    });
    expect(msg.tool).toBeDefined();
    expect(msg.tool!.toolId).toBe("tool-1");
    expect(msg.tool!.name).toBe("Read");
    expect(msg.tool!.state.phase).toBe("executing");
  });

  test("parts are optional and extensible", () => {
    const msg = baseMessage({
      parts: [
        { kind: "text", text: "Hello **world**", markdown: true },
        { kind: "code", code: "console.log('hi')", language: "typescript" },
        { kind: "file_ref", path: "src/main.ts", lines: [10, 20] },
      ],
    });
    expect(msg.parts).toHaveLength(3);
    expect(msg.parts![0].kind).toBe("text");
    expect(msg.parts![1].kind).toBe("code");
    expect(msg.parts![2].kind).toBe("file_ref");
  });

  test("metadata is optional and freeform", () => {
    const msg = baseMessage({ metadata: { event: "identity.registered", agentUri: "spiffe://test" } });
    expect(msg.metadata!.event).toBe("identity.registered");
  });

  test("message is JSON serializable", () => {
    const msg = baseMessage({
      parts: [{ kind: "text", text: "hello" }],
      tool: { toolId: "t1", name: "Bash", state: { phase: "completed", success: true, output: "ok" } },
      metadata: { custom: 42 },
    });
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("session.message");
    expect(parsed.tool.state.phase).toBe("completed");
    expect(parsed.parts[0].kind).toBe("text");
  });
});

// =============================================================================
// SessionMessageDelta
// =============================================================================

describe("SessionMessageDelta", () => {
  test("contentAppend delta", () => {
    const delta: SessionMessageDelta = {
      type: "session.message.delta",
      sessionId: "sess-1",
      messageId: "msg-1",
      contentAppend: " world",
      timestamp: "2026-01-01T00:00:01Z",
    };
    expect(delta.type).toBe("session.message.delta");
    expect(delta.contentAppend).toBe(" world");
  });

  test("toolStateUpdate delta", () => {
    const delta: SessionMessageDelta = {
      type: "session.message.delta",
      sessionId: "sess-1",
      messageId: "msg-1",
      toolStateUpdate: { phase: "completed", success: true, output: "done", elapsedMs: 1500 },
      timestamp: "2026-01-01T00:00:01Z",
    };
    expect(delta.toolStateUpdate!.phase).toBe("completed");
    expect((delta.toolStateUpdate as { success: boolean }).success).toBe(true);
  });

  test("partsAppend delta", () => {
    const delta: SessionMessageDelta = {
      type: "session.message.delta",
      sessionId: "sess-1",
      messageId: "msg-1",
      partsAppend: [{ kind: "code", code: "x = 1", language: "python" }],
      timestamp: "2026-01-01T00:00:01Z",
    };
    expect(delta.partsAppend).toHaveLength(1);
    expect(delta.partsAppend![0].kind).toBe("code");
  });

  test("delta is JSON serializable", () => {
    const delta: SessionMessageDelta = {
      type: "session.message.delta",
      sessionId: "sess-1",
      messageId: "msg-1",
      contentAppend: "token",
      toolStateUpdate: { phase: "executing" },
      timestamp: "2026-01-01T00:00:01Z",
    };
    const parsed = JSON.parse(JSON.stringify(delta));
    expect(parsed.type).toBe("session.message.delta");
    expect(parsed.contentAppend).toBe("token");
  });
});

// =============================================================================
// Tool state machine
// =============================================================================

describe("ToolState machine", () => {
  test("all phases are valid", () => {
    const phases: ToolPhase[] = ["streaming", "waiting_confirmation", "executing", "completed", "cancelled"];
    for (const phase of phases) {
      expect(typeof phase).toBe("string");
    }
  });

  test("streaming state has optional partialInput", () => {
    const state: ToolState = { phase: "streaming", partialInput: { command: "ls -" } };
    expect(state.phase).toBe("streaming");
  });

  test("waiting_confirmation has approvalId and description", () => {
    const state: ToolState = {
      phase: "waiting_confirmation",
      input: { command: "rm -rf /tmp/test" },
      description: "Bash(command)",
      approvalId: "approval-123",
    };
    expect(state.phase).toBe("waiting_confirmation");
    expect(state.approvalId).toBe("approval-123");
    expect(state.description).toBeTruthy();
  });

  test("executing state has optional progress", () => {
    const state: ToolState = { phase: "executing", progress: "Reading file...", elapsedMs: 500 };
    expect(state.phase).toBe("executing");
    expect(state.elapsedMs).toBe(500);
  });

  test("completed state has success flag and output", () => {
    const state: ToolState = {
      phase: "completed",
      success: true,
      output: "file contents here",
      elapsedMs: 200,
      confirmedBy: "user",
    };
    expect(state.phase).toBe("completed");
    expect(state.success).toBe(true);
    expect(state.confirmedBy).toBe("user");
  });

  test("cancelled state has reason", () => {
    const state: ToolState = { phase: "cancelled", reason: "denied", message: "User denied" };
    expect(state.phase).toBe("cancelled");
    expect(state.reason).toBe("denied");
  });

  test("valid tool state transitions", () => {
    // The allowed transitions:
    // streaming → waiting_confirmation → executing → completed
    //                                              → cancelled
    // streaming → executing (auto-approved)
    const transitions: [ToolPhase, ToolPhase[]][] = [
      ["streaming", ["waiting_confirmation", "executing"]],
      ["waiting_confirmation", ["executing", "cancelled"]],
      ["executing", ["completed"]],
      ["completed", []],
      ["cancelled", []],
    ];

    for (const [from, validTargets] of transitions) {
      expect(Array.isArray(validTargets)).toBe(true);
      // completed and cancelled are terminal states
      if (from === "completed" || from === "cancelled") {
        expect(validTargets).toHaveLength(0);
      }
    }
  });
});

// =============================================================================
// Content parts
// =============================================================================

describe("ContentPart", () => {
  test("text part with markdown flag", () => {
    const part: ContentPart = { kind: "text", text: "**bold**", markdown: true };
    expect(part.kind).toBe("text");
  });

  test("code part with language and filePath", () => {
    const part: ContentPart = { kind: "code", code: "fn main() {}", language: "rust", filePath: "src/main.rs" };
    expect(part.kind).toBe("code");
    expect((part as { language: string }).language).toBe("rust");
  });

  test("file_ref part with line range and change", () => {
    const part: ContentPart = { kind: "file_ref", path: "src/app.ts", lines: [10, 25], change: { added: 5, removed: 2 } };
    expect(part.kind).toBe("file_ref");
    expect((part as { lines: number[] }).lines).toEqual([10, 25]);
  });

  test("diff part", () => {
    const part: ContentPart = { kind: "diff", path: "src/app.ts", added: 10, removed: 3 };
    expect(part.kind).toBe("diff");
  });

  test("tree part with nested children", () => {
    const part: ContentPart = {
      kind: "tree",
      label: "src/",
      children: [
        { label: "main.ts", type: "file", path: "src/main.ts" },
        {
          label: "daemon/", type: "directory", children: [
            { label: "server.ts", type: "file", path: "src/daemon/server.ts" },
          ],
        },
      ],
    };
    expect(part.kind).toBe("tree");
    expect((part as { children: unknown[] }).children).toHaveLength(2);
  });

  test("button part with action and style", () => {
    const part: ContentPart = { kind: "button", label: "Apply", action: "apply_diff", style: "primary", data: { diffId: "d1" } };
    expect(part.kind).toBe("button");
    expect((part as { style: string }).style).toBe("primary");
  });

  test("progress part with percent", () => {
    const part: ContentPart = { kind: "progress", message: "Installing...", percent: 75, elapsedMs: 3000 };
    expect(part.kind).toBe("progress");
    expect((part as { percent: number }).percent).toBe(75);
  });

  test("all parts are JSON serializable", () => {
    const parts: ContentPart[] = [
      { kind: "text", text: "hello" },
      { kind: "code", code: "x=1", language: "py" },
      { kind: "file_ref", path: "a.ts" },
      { kind: "diff", path: "b.ts", added: 1, removed: 0 },
      { kind: "tree", label: "root", children: [] },
      { kind: "button", label: "Ok", action: "ok" },
      { kind: "progress", message: "..." },
      { kind: "image", url: "https://example.com/img.png" },
      { kind: "anchor", uri: "https://github.com", title: "GitHub" },
      { kind: "table", headers: ["A", "B"], rows: [["1", "2"]] },
    ];
    const json = JSON.stringify(parts);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(10);
    for (let i = 0; i < parts.length; i++) {
      expect(parsed[i].kind).toBe(parts[i].kind);
    }
  });
});

// =============================================================================
// DaemonMessage discriminated union
// =============================================================================

describe("DaemonMessage routing", () => {
  test("messages can be discriminated by type field", () => {
    const messages: DaemonMessage[] = [
      { type: "auth.ok", identity: { sub: "s", type: "human" }, scopes: [] },
      { type: "response.ok", requestId: "r1" },
      { type: "response.error", requestId: "r2", error: "fail", code: "internal" },
      { type: "session.list.result", requestId: "r3", sessions: [] },
      {
        type: "session.message", sessionId: "s1", messageId: "m1", role: "assistant",
        content: "hi", identity: { sub: "a", type: "agent" }, timestamp: "t",
      },
      {
        type: "session.message.delta", sessionId: "s1", messageId: "m1",
        contentAppend: " world", timestamp: "t",
      },
      { type: "session.status_change", sessionId: "s1", status: "idle", timestamp: "t" },
      { type: "scrollback.replay", sessionId: "s1", messages: [] },
    ];

    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "auth.ok", "response.ok", "response.error", "session.list.result",
      "session.message", "session.message.delta", "session.status_change", "scrollback.replay",
    ]);
  });

  test("switch on type is exhaustive", () => {
    const handle = (msg: DaemonMessage): string => {
      switch (msg.type) {
        case "auth.ok": return "auth";
        case "response.ok": return "ok";
        case "response.error": return "error";
        case "session.list.result": return "list";
        case "session.message": return `msg:${msg.role}`;
        case "session.message.delta": return "delta";
        case "session.status_change": return `status:${msg.status}`;
        case "session.info_update": return `info:${msg.session.id}`;
        case "session.ui_request": return `ui:${msg.method}`;
        case "session.ui_resolved": return `ui_resolved:${msg.reason}`;
        case "session.commands.result": return `commands:${msg.commands.length}`;
        case "scrollback.replay": return `replay:${msg.messages.length}`;
        case "scrollback.page.result": return `page:${msg.source}:${msg.messages.length}`;
        case "session.search.result": return `search:${msg.sessions.length}`;
        case "fs.list.result": return `fs.list:${msg.entries.length}`;
        case "fs.read.result": return `fs.read:${msg.size}`;
        case "fs.browse_dir.result": return `fs.browse:${msg.entries.length}`;
        case "claude.config.result":
          return `cc:${msg.agents.length}/${msg.skills.length}`;
        case "blackboard.index.result":
          return `bb.index:${msg.entries.length}`;
        case "blackboard.read.result":
          return `bb.read:${msg.artifact?.kind ?? "none"}`;
        case "collaboration.panels.result":
          return `panels:${msg.panels.length}`;
        case "models.list.result":
          return `models:${msg.models.length}`;
        case "session.export.result":
          return `export:${msg.manifest.counts.messages}`;
        case "session.import.result":
          return `import:${msg.newSessionId}`;
        case "settings.schema.result":
          return `settings.schema:${msg.manifest.tabs.length}`;
        case "settings.get.result":
          return `settings.get:${Object.keys(msg.snapshot.values).length}`;
        case "settings.set.result":
          return `settings.set:${msg.ok}`;
        case "pipeline.snapshot":
          return `pipeline:${msg.pipeline.id}`;
        case "pipeline.list.result":
          return `pipeline.list:${msg.pipelines.length}`;
        case "pipeline.pack.list.result":
          return `pack.list:${msg.installed.length}/${msg.available.length}`;
      }
    };

    expect(handle({ type: "auth.ok", identity: { sub: "s", type: "human" }, scopes: [] })).toBe("auth");
    expect(handle({
      type: "session.message", sessionId: "s", messageId: "m", role: "user",
      content: "hi", identity: { sub: "u", type: "human" }, timestamp: "t",
    })).toBe("msg:user");
  });
});

// =============================================================================
// ClientMessage
// =============================================================================

describe("ClientMessage", () => {
  test("approve message uses approvalId (not requestId)", () => {
    const msg: ClientMessage = {
      type: "session.approve",
      id: "req-1",
      sessionId: "sess-1",
      approvalId: "approval-abc",
      approved: true,
    };
    expect(msg.type).toBe("session.approve");
    expect((msg as { approvalId: string }).approvalId).toBe("approval-abc");
    // Should NOT have requestId for the approval correlation
    expect((msg as unknown as Record<string, unknown>).requestId).toBeUndefined();
  });

  test("all client message types have id field", () => {
    const messages: ClientMessage[] = [
      { type: "session.create", id: "1", name: "oracle", workdir: "/tmp" },
      { type: "session.list", id: "2" },
      { type: "session.attach", id: "3", sessionId: "s1" },
      { type: "session.detach", id: "4", sessionId: "s1" },
      { type: "session.send", id: "5", sessionId: "s1", text: "hello" },
      { type: "session.interrupt", id: "6", sessionId: "s1" },
      { type: "session.approve", id: "7", sessionId: "s1", approvalId: "a1", approved: true },
      { type: "session.destroy", id: "8", sessionId: "s1" },
    ];

    for (const msg of messages) {
      expect(msg.id).toBeTruthy();
    }
    expect(messages).toHaveLength(8);
  });
});
