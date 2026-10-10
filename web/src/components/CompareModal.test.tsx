// @vitest-environment jsdom
/** Compare backends (#357): starts N branches with one prompt, renders them side by side, keeps one. */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../state/connection", () => ({
  getClient: () => ({ request: (msg: Record<string, unknown>) => requestMock(msg) }),
  newRequestId: () => "r",
  refreshSessions: vi.fn(() => Promise.resolve([])),
  authIdentity: () => ({ providers: ["claude", "codex", "pi"] }),
}));
const focusMock = vi.hoisted(() => vi.fn());
vi.mock("../state/sessions", () => ({ focusSession: focusMock }));

import CompareModal, { openCompare } from "./CompareModal";

const STATE = {
  compareId: "c1",
  parentSessionId: "s",
  prompt: "make it fast",
  createdAt: "2026-10-10T00:00:00.000Z",
  createdBy: "u",
  targets: [
    { providerId: "claude", sessionId: "b1", status: "idle", done: true, reply: "reply from claude", files: { changed: 1, insertions: 4, deletions: 1, paths: ["a.ts"] } },
    { providerId: "codex", model: "gpt-5.5", sessionId: "b2", status: "idle", done: true, reply: "reply from codex" },
  ],
};

function respond(overrides: Partial<Record<string, unknown>> = {}) {
  requestMock.mockImplementation(async (msg) => {
    if (msg.type === "compare.list") return { type: "compare.list.result", requestId: "r", sessionId: "s", compares: [] };
    if (msg.type === "compare.keep") return { type: "compare.state", requestId: "r", compare: { ...STATE, keptSessionId: msg.sessionId } };
    const type = String(msg.type);
    if (type in overrides) {
      const o = overrides[type];
      if (o instanceof Error) throw o;
      return o;
    }
    return { type: "compare.state", requestId: "r", compare: STATE };
  });
}

beforeEach(() => {
  requestMock.mockReset();
  focusMock.mockReset();
});
afterEach(() => cleanup());

describe("CompareModal", () => {
  it("sends one prompt to the chosen backends from the chosen point and shows them side by side", async () => {
    respond();
    const r = render(() => <CompareModal />);
    openCompare("s", "t3");
    fireEvent.input(await r.findByLabelText("model 2"), { target: { value: "gpt-5.5" } });
    fireEvent.change(r.getByLabelText("backend 2"), { target: { value: "codex" } });
    fireEvent.input(r.getByLabelText("prompt"), { target: { value: "make it fast" } });
    fireEvent.click(r.getByRole("button", { name: "Compare 2 backends" }));
    await r.findByText("reply from codex");
    r.getByText("reply from claude");
    const sent = requestMock.mock.calls.map((c) => c[0]).find((m) => m.type === "session.compare")!;
    expect(sent).toMatchObject({
      sessionId: "s",
      prompt: "make it fast",
      afterTurnId: "t3",
      targets: [{ providerId: "claude" }, { providerId: "codex", model: "gpt-5.5" }],
    });
    expect(sent.isolate).toBeUndefined();
  });

  it("keeps one branch, discarding the others, and focuses it", async () => {
    respond();
    const r = render(() => <CompareModal />);
    openCompare("s");
    fireEvent.input(await r.findByLabelText("prompt"), { target: { value: "go" } });
    fireEvent.click(r.getByRole("button", { name: "Compare 2 backends" }));
    await r.findByText("reply from codex");
    fireEvent.click(r.getAllByRole("button", { name: "keep, discard others" })[1]!);
    await waitFor(() => expect(focusMock).toHaveBeenCalledWith("b2"));
    const keep = requestMock.mock.calls.map((c) => c[0]).find((m) => m.type === "compare.keep")!;
    expect(keep).toMatchObject({ compareId: "c1", sessionId: "b2", discardOthers: true });
    await r.findByText("kept");
  });

  it("says when a branch needs an approval, and only lets a finished branch be kept", async () => {
    respond({
      "session.compare": {
        type: "compare.state",
        requestId: "r",
        compare: {
          ...STATE,
          targets: [
            { providerId: "claude", sessionId: "b1", status: "waiting_approval", done: false },
            { providerId: "codex", sessionId: "b2", status: "idle", done: true, reply: "reply from codex" },
          ],
        },
      },
      "compare.get": {
        type: "compare.state",
        requestId: "r",
        compare: {
          ...STATE,
          targets: [
            { providerId: "claude", sessionId: "b1", status: "waiting_approval", done: false },
            { providerId: "codex", sessionId: "b2", status: "idle", done: true, reply: "reply from codex" },
          ],
        },
      },
    });
    const r = render(() => <CompareModal />);
    openCompare("s");
    fireEvent.input(await r.findByLabelText("prompt"), { target: { value: "go" } });
    fireEvent.click(r.getByRole("button", { name: "Compare 2 backends" }));
    await r.findByText("needs your approval — open it");
    expect(r.getAllByRole("button", { name: "keep" })).toHaveLength(1);
  });

  it("needs a prompt and shows the daemon's refusal", async () => {
    respond({ "session.compare": new Error("Unknown provider") });
    const r = render(() => <CompareModal />);
    openCompare("s");
    const go = await r.findByRole("button", { name: "Compare 2 backends" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(r.getByLabelText("prompt"), { target: { value: "go" } });
    fireEvent.click(go);
    await r.findByText("Unknown provider");
  });
});
