// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown) => Promise<unknown>>(() => Promise.resolve(undefined)),
);
vi.mock("../../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
}));

import ApprovalBar, { SandboxLine } from "./ApprovalBar";
import {
  ingestSessionList,
  focusSession,
  _resetSessionsForTest,
} from "../../state/sessions";
import { applyMessage, _resetMessagesForTest } from "../../state/messages";
import type { SessionInfo, SessionMessage } from "../../protocol/types";

function pendingSession(): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
    status: "waiting_approval",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  } as SessionInfo;
}

function pendingToolMsg(): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s",
    messageId: "m1",
    role: "tool_call",
    content: "run a command",
    identity: { sub: "x", name: "a", type: "agent" },
    timestamp: "2026-05-04T08:00:00Z",
    tool: {
      name: "Bash",
      toolId: "t1",
      state: {
        phase: "waiting_confirmation",
        approvalId: "ap-1",
        description: "rm -rf build",
        input: { command: "rm -rf build" },
      },
    },
  } as unknown as SessionMessage;
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  _resetMessagesForTest();
  requestMock.mockReset();
  requestMock.mockImplementation(() => Promise.resolve(undefined));
});

function setup() {
  ingestSessionList([pendingSession()]);
  focusSession("s");
  applyMessage(pendingToolMsg());
  return render(() => <ApprovalBar />);
}

describe("ApprovalBar keyboard shortcuts", () => {
  it("Alt+Y approves the pending tool", () => {
    const { container } = setup();
    expect(container.textContent).toContain("Bash"); // bar is showing
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", altKey: true, bubbles: true }));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.approve", approvalId: "ap-1", approved: true }),
    );
  });

  it("Alt+D denies the pending tool", () => {
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", altKey: true, bubbles: true }));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.approve", approvalId: "ap-1", approved: false }),
    );
  });

  it("ignores the shortcut without the Alt modifier", () => {
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("does not double-fire while an approve is already in flight", () => {
    requestMock.mockImplementationOnce(() => new Promise(() => {}));
    setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", altKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", altKey: true, bubbles: true }));
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe("ApprovalBar buttons", () => {
  it("a double-click on approve sends ONE session.approve", () => {
    const { getByText } = setup();
    const btn = getByText("approve") as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.approve", approvalId: "ap-1", approved: true }),
    );
  });

  it("disables every button while the approve is in flight", () => {
    requestMock.mockImplementationOnce(() => new Promise(() => {}));
    const { getByText } = setup();
    fireEvent.click(getByText("approve"));
    expect((getByText("approve") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("refine") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("deny") as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces a daemon rejection inline and re-enables the buttons", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("stale approval — the turn was interrupted")),
    );
    const { getByText, findByText } = setup();
    fireEvent.click(getByText("approve"));
    expect(await findByText(/stale approval/)).toBeTruthy();
    // Re-enabled after the rejection: a second attempt goes out.
    const btn = getByText("approve") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
  });

  it("deny also routes through the gated request path", () => {
    const { getByText } = setup();
    const btn = getByText("deny") as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.approve", approvalId: "ap-1", approved: false }),
    );
  });
});

describe("SandboxLine (#448)", () => {
  it("a sandbox with Docker access is a warning on the card, saying why in its tooltip", () => {
    const { getByText } = render(() => <SandboxLine sandboxed sandboxDocker sandboxNote="sandboxed, Docker access: bubblewrap, network on" />);
    const line = getByText("⚠️ sandboxed, Docker access: bubblewrap, network on");
    expect(line.className).toContain("text-warn");
    expect(line.getAttribute("title")).toContain("Docker access can reach the whole machine");
    cleanup();
    const plain = render(() => <SandboxLine sandboxed sandboxNote="sandboxed: bubblewrap, network on" />).getByText("🛡 sandboxed: bubblewrap, network on");
    expect(plain.className).toContain("text-success");
    expect(plain.getAttribute("title")).toBeNull();
  });
});


describe("ApprovalBar — the workstream a fleet dispatch acts in (workstreams §10)", () => {
  it("names it, and shows the override warning approving confirms", () => {
    ingestSessionList([pendingSession()]);
    focusSession("s");
    const msg = pendingToolMsg() as unknown as { tool: { name: string; state: Record<string, unknown> } };
    msg.tool.name = "mcp__codeoid_fleet__fleet_spawn";
    msg.tool.state = { ...msg.tool.state, input: { workdir: "/w/acme", task: "t" }, targetWorkstream: { workstream: "mine", warning: "Past the folder's own workstream (exclusive)" } };
    applyMessage(msg as unknown as SessionMessage);
    const { getByTestId } = render(() => <ApprovalBar />);
    expect(getByTestId("approval-workstream").textContent).toContain("workstream mine");
    expect(getByTestId("approval-workstream").textContent).toContain("Past the folder's own");
  });
});
