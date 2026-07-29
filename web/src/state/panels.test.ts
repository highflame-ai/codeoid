// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown, opts?: unknown) => Promise<unknown>>(),
);
vi.mock("./connection", () => ({
  getClient: () => ({ request: requestMock }),
  newRequestId: () => `r-${Math.random()}`,
}));

import {
  fetchPanels,
  lastJoinedPanel,
  livePanel,
  livePanelMember,
  panelState,
  _resetPanelsForTest,
} from "./panels";
import type { CollaborationPanel } from "../protocol/types";

type Status = CollaborationPanel["members"][number]["status"];

function panel(
  groupId: string,
  statuses: Status[],
  over: Partial<CollaborationPanel> = {},
): CollaborationPanel {
  const members = statuses.map((status, i) => ({
    sessionId: `kid-${i + 1}`,
    ordinal: i + 1,
    status,
  }));
  const settled = members.filter((m) =>
    ["done", "failed", "blocked"].includes(m.status),
  ).length;
  return {
    groupId,
    createdAt: 1_700_000_000_000,
    members,
    settled,
    joined: settled === members.length,
    ...over,
  };
}

const result = (panels: CollaborationPanel[], sessionId = "goal-1") => ({
  type: "collaboration.panels.result" as const,
  requestId: "x",
  sessionId,
  panels,
});

beforeEach(() => _resetPanelsForTest());
afterEach(() => {
  requestMock.mockReset();
  _resetPanelsForTest();
});

describe("fetchPanels", () => {
  it("adopts the daemon's goal id, not the one it asked about", async () => {
    // Focusing a child must land on the same panels as focusing its orchestrator.
    requestMock.mockResolvedValueOnce(result([panel("g1", ["running", "queued"])]));
    await fetchPanels("kid-1");
    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      type: "collaboration.panels",
      sessionId: "kid-1",
    });
    expect(panelState().goalSessionId).toBe("goal-1");
  });

  it("keeps the last state on a transient failure instead of blanking", async () => {
    // A poll that fails must not erase a live "2 of 3" and imply the panel
    // vanished — it polls again in three seconds.
    requestMock.mockResolvedValueOnce(result([panel("g1", ["done", "running"])]));
    await fetchPanels("goal-1");
    expect(livePanel()?.settled).toBe(1);

    requestMock.mockRejectedValueOnce(new Error("socket blip"));
    await fetchPanels("goal-1");
    expect(panelState().error).toBe("socket blip");
    expect(livePanel()?.settled).toBe(1);
  });

  it("drops a slow reply for a goal the user navigated away from", async () => {
    let release: (v: unknown) => void = () => {};
    requestMock
      .mockImplementationOnce(() => new Promise((res) => (release = res)))
      .mockResolvedValueOnce(result([panel("g2", ["queued"])], "goal-2"));

    const first = fetchPanels("goal-1");
    const second = fetchPanels("goal-2");
    await second;
    release(result([panel("g1", ["done", "done"])], "goal-1"));
    await first;

    expect(panelState().goalSessionId).toBe("goal-2");
    expect(livePanel()?.groupId).toBe("g2");
  });
});

describe("livePanel", () => {
  it("is the unjoined fan-out, and null once everything has joined", async () => {
    requestMock.mockResolvedValueOnce(
      result([panel("live", ["running", "done"]), panel("old", ["done", "done"])]),
    );
    await fetchPanels("goal-1");
    expect(livePanel()?.groupId).toBe("live");
    expect(lastJoinedPanel()?.groupId).toBe("old");

    requestMock.mockResolvedValueOnce(result([panel("old", ["done", "done"])]));
    await fetchPanels("goal-1");
    expect(livePanel()).toBeNull();
  });

  it("keys liveness off `joined`, not off member statuses", async () => {
    // The daemon derives `joined` from the barrier's own all-terminal rule. If
    // this recomputed it from statuses the two could disagree, and the UI would
    // show a panel spinning that the barrier has already closed.
    requestMock.mockResolvedValueOnce(
      result([panel("weird", ["done", "done"], { joined: false, settled: 2 })]),
    );
    await fetchPanels("goal-1");
    expect(livePanel()?.groupId).toBe("weird");
  });
});

describe("livePanelMember", () => {
  beforeEach(async () => {
    requestMock.mockResolvedValueOnce(
      result([panel("g1", ["done", "running", "blocked"])]),
    );
    await fetchPanels("goal-1");
    requestMock.mockReset();
  });

  it("maps a session to its position and state in the live fan-out", () => {
    expect(livePanelMember("kid-1")).toEqual({ ordinal: 1, status: "done" });
    expect(livePanelMember("kid-2")).toEqual({ ordinal: 2, status: "running" });
    // A failed member is still reported — never dropped.
    expect(livePanelMember("kid-3")).toEqual({ ordinal: 3, status: "blocked" });
  });

  it("is null for a session outside the fan-out", () => {
    expect(livePanelMember("kid-99")).toBeNull();
  });

  it("is null when nothing is live", async () => {
    requestMock.mockResolvedValueOnce(result([panel("g1", ["done", "done"])]));
    await fetchPanels("goal-1");
    expect(livePanelMember("kid-1")).toBeNull();
  });
});
