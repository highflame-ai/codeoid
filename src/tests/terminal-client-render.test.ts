/**
 * Legacy readline client — stream rendering + ANSI sanitization (#92).
 *
 * The `codeoid attach` readline client writes model/tool content straight to
 * the TTY. #91 wired sanitizeTerminalOutput into the TUI + web renderers but
 * deferred this path because the rendering lived in a closure. That logic is
 * now the pure, exported renderStreamMessage; these tests drive it directly
 * and assert every untrusted field is stripped of terminal-control escapes
 * (OSC 52 clipboard, cursor moves, DCS) while our own SGR framing survives.
 */

import { describe, it, expect } from "bun:test";
import {
  renderStreamMessage,
  newStreamRenderState,
} from "../terminal/client.js";
import type { DaemonMessage } from "../protocol/types.js";
import { type PendingDialog, parseDialogAnswer } from "../terminal/dialog.js";

// An OSC 52 clipboard-write sequence — the headline injection vector.
const OSC52 = "\x1b]52;c;ZXZpbA==\x07";
// A cursor-move CSI and a lone DCS opener.
const CURSOR = "\x1b[2J\x1b[H";

function noEscapes(s: string): void {
  // No OSC introducer, no DCS, no raw CSI beyond our own known SGR codes.
  expect(s).not.toContain("\x1b]"); // OSC
  expect(s).not.toContain("\x1b]52");
  expect(s).not.toContain("\x1bP"); // DCS
  expect(s).not.toContain("\x1b[2J"); // erase-display CSI
}

describe("renderStreamMessage — sanitization", () => {
  it("strips OSC 52 from assistant content but keeps the trailing newline", () => {
    const out = renderStreamMessage(
      { type: "session.message", role: "assistant", content: `hello${OSC52}world` } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("strips a cursor-move CSI from user content, keeps our cyan framing", () => {
    const out = renderStreamMessage(
      { type: "session.message", role: "user", content: `${CURSOR}hi` } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("\x1b[36m"); // our own cyan prompt framing survives
    expect(out).toContain("hi");
  });

  it("sanitizes identity.name", () => {
    const out = renderStreamMessage(
      { type: "session.message", role: "user", content: "x", identity: { name: `evil${OSC52}` } } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("evil");
  });

  it("sanitizes tool name + description and records the approval id", () => {
    const state = newStreamRenderState();
    const out = renderStreamMessage(
      {
        type: "session.message",
        role: "tool_call",
        tool: {
          name: `Bash${OSC52}`,
          state: { phase: "waiting_confirmation", approvalId: "appr-1", description: `rm -rf${OSC52} /` },
        },
      } as DaemonMessage,
      state,
    );
    noEscapes(out);
    expect(out).toContain("Bash");
    expect(out).toContain("rm -rf");
    expect(out).toContain("Type 'yes' to approve");
    expect(state.latestApprovalId).toBe("appr-1");
  });

  it("sanitizes streaming deltas and dedupes the committed assistant message", () => {
    const state = newStreamRenderState();
    const delta = renderStreamMessage(
      { type: "session.message.delta", messageId: "m1", contentAppend: `chunk${OSC52}` } as DaemonMessage,
      state,
    );
    noEscapes(delta);
    expect(delta).toContain("chunk");
    expect(state.streamingAssistantMsgId).toBe("m1");

    // The committed assistant message for the same id must not re-print content —
    // just close the streamed line with a newline.
    const committed = renderStreamMessage(
      { type: "session.message", role: "assistant", messageId: "m1", content: "chunk" } as DaemonMessage,
      state,
    );
    expect(committed).toBe("\n");
    expect(state.streamingAssistantMsgId).toBeNull();
  });

  it("sanitizes every entry in a scrollback replay", () => {
    const out = renderStreamMessage(
      {
        type: "scrollback.replay",
        messages: [
          { type: "session.message", role: "assistant", content: `a${OSC52}` },
          { type: "session.message", role: "user", content: `u${CURSOR}`, identity: { name: `n${OSC52}` } },
          { type: "session.message", role: "tool_call", tool: { name: `T${OSC52}` } },
          { type: "session.message", role: "system", content: `s${OSC52}` },
        ],
      } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("--- scrollback (4 messages) ---");
    expect(out).toContain("--- end scrollback ---");
  });

  it("returns empty string for unhandled message types", () => {
    expect(renderStreamMessage({ type: "auth.ok" } as DaemonMessage, newStreamRenderState())).toBe("");
  });

  it("renders status_change without leaking (controlled enum)", () => {
    const out = renderStreamMessage(
      { type: "session.status_change", status: "thinking" } as DaemonMessage,
      newStreamRenderState(),
    );
    expect(out).toBe("\n[status] thinking\n");
  });
});

// #348: an interactive attach shows provider dialogs and answers them.
describe("provider dialogs in the CLI attach loop", () => {
  const request = (over: Record<string, unknown> = {}) =>
    ({
      type: "session.ui_request",
      sessionId: "s1",
      requestId: "r1",
      method: "confirm",
      title: "Allow the skill command `./probe.sh`?",
      message: "A skill needs to run:\n\n    ./probe.sh",
      timestamp: "t",
      ...over,
    }) as unknown as DaemonMessage;

  it("renders a yes/no with its message and remembers it as pending", () => {
    const state = newStreamRenderState();
    const out = renderStreamMessage(request(), state);
    expect(out).toContain("Allow the skill command `./probe.sh`?");
    expect(out).toContain("./probe.sh");
    expect(out).toContain("'yes' or 'no'");
    expect(state.dialogs.map((d) => d.dialog)).toEqual([{ requestId: "r1", method: "confirm" }]);
  });

  it("numbers a pick list, and strips escapes from untrusted text", () => {
    const state = newStreamRenderState();
    const out = renderStreamMessage(
      request({ method: "select", title: "Pick\x1b]52;c;ZXZpbA==\x07 one", message: undefined, options: ["pg", "my\x1b[2Jsql"] }),
      state,
    );
    expect(out).toContain("1. pg");
    expect(out).toContain("2. mysql");
    noEscapes(out.replace(/\x1b\[(?:3[16]|2|0)m/g, ""));
  });

  it("forgets the dialog when it is resolved elsewhere, saying so unless it was answered", () => {
    const state = newStreamRenderState();
    renderStreamMessage(request(), state);
    const out = renderStreamMessage(
      { type: "session.ui_resolved", sessionId: "s1", requestId: "r1", reason: "interrupted", timestamp: "t" } as unknown as DaemonMessage,
      state,
    );
    expect(state.dialogs).toEqual([]);
    expect(out).toContain("question closed: interrupted");
  });

  it("remembers which prompt was printed last, so a typed yes/no answers that one", () => {
    const state = newStreamRenderState();
    renderStreamMessage(request(), state);
    expect(state.lastPrompt).toBe("dialog");
    renderStreamMessage(
      {
        type: "session.message",
        role: "tool_call",
        content: "Bash",
        messageId: "m1",
        tool: { name: "Bash", state: { phase: "waiting_confirmation", approvalId: "a1", description: "ls" } },
      } as unknown as DaemonMessage,
      state,
    );
    expect(state.lastPrompt).toBe("tool");
    expect(state.latestApprovalId).toBe("a1");
    // Approved on another surface: the next yes/no goes back to the question.
    renderStreamMessage(
      {
        type: "session.message.delta",
        sessionId: "s1",
        messageId: "m1",
        toolStateUpdate: { phase: "executing" },
      } as unknown as DaemonMessage,
      state,
    );
    expect(state.latestApprovalId).toBeNull();
    expect(state.lastPrompt).toBe("dialog");
  });

  it("queues several pending questions: shows the oldest, then the next once it resolves", () => {
    const state = newStreamRenderState();
    expect(renderStreamMessage(request({ requestId: "r1", title: "First?" }), state)).toContain("First?");
    // The second waits its turn, silently; a re-send of the first is ignored.
    expect(renderStreamMessage(request({ requestId: "r2", title: "Second?" }), state)).toBe("");
    expect(renderStreamMessage(request({ requestId: "r1", title: "First?" }), state)).toBe("");
    expect(state.dialogs.map((d) => d.dialog.requestId)).toEqual(["r1", "r2"]);
    const next = renderStreamMessage(
      { type: "session.ui_resolved", sessionId: "s1", requestId: "r1", reason: "answered", timestamp: "t" } as unknown as DaemonMessage,
      state,
    );
    expect(next).toContain("Second?");
    expect(state.dialogs.map((d) => d.dialog.requestId)).toEqual(["r2"]);
    // Resolving a queued (unshown) one prints nothing.
    renderStreamMessage(request({ requestId: "r3", title: "Third?" }), state);
    expect(
      renderStreamMessage(
        { type: "session.ui_resolved", sessionId: "s1", requestId: "r3", reason: "cancelled", timestamp: "t" } as unknown as DaemonMessage,
        state,
      ),
    ).toBe("");
  });
});

describe("parseDialogAnswer", () => {
  it("confirm: yes/no in either case; anything else re-prompts", () => {
    const d = { requestId: "r", method: "confirm" } as const;
    expect(parseDialogAnswer("Y", d)).toEqual({ confirmed: true });
    expect(parseDialogAnswer("no", d)).toEqual({ confirmed: false });
    expect(parseDialogAnswer("maybe", d)).toHaveProperty("error");
  });

  it("select: a 1-based number or the exact option", () => {
    const d: PendingDialog = { requestId: "r", method: "select", options: ["pg", "mysql"] };
    expect(parseDialogAnswer("2", d)).toEqual({ value: "mysql" });
    expect(parseDialogAnswer("pg", d)).toEqual({ value: "pg" });
    expect(parseDialogAnswer("3", d)).toHaveProperty("error");
    expect(parseDialogAnswer("0", d)).toHaveProperty("error");
  });

  it("input: the trimmed line; empty re-prompts; /skip dismisses any kind", () => {
    const d = { requestId: "r", method: "input" } as const;
    expect(parseDialogAnswer("  TypeScript ", d)).toEqual({ value: "TypeScript" });
    expect(parseDialogAnswer("   ", d)).toHaveProperty("error");
    expect(parseDialogAnswer("/skip", d)).toEqual({ cancelled: true });
    expect(parseDialogAnswer("/skip", { requestId: "r", method: "confirm" })).toEqual({ cancelled: true });
  });
});
