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
  blackboard,
  clearSelection,
  closeBlackboard,
  fetchIndex,
  isBlackboardOpen,
  openBlackboard,
  refKey,
  refreshBlackboard,
  selectArtifact,
  _resetBlackboardForTest,
} from "./blackboard";
import type { BlackboardIndexEntry } from "../protocol/types";

function entry(kind: string, slot: string | null = null): BlackboardIndexEntry {
  return {
    kind,
    slot,
    version: 1,
    authorSub: `agent:goal:${kind}`,
    authorRole: kind === "findings" ? "review" : "search",
    updatedAt: 1_700_000_000_000,
    bytes: 42,
  };
}

const indexResult = (sessionId: string, entries: BlackboardIndexEntry[], goal = "ship it") => ({
  type: "blackboard.index.result" as const,
  requestId: "x",
  sessionId,
  goal,
  entries,
});

const readResult = (content: string | null, kind = "spec") => ({
  type: "blackboard.read.result" as const,
  requestId: "x",
  sessionId: "goal-1",
  artifact:
    content === null
      ? null
      : {
          kind,
          slot: null,
          version: 2,
          content,
          authorSub: "agent:goal:orch",
          authorRole: "orchestrator",
          createdAt: 1_700_000_000_000,
        },
});

beforeEach(() => _resetBlackboardForTest());
afterEach(() => {
  requestMock.mockReset();
  _resetBlackboardForTest();
});

describe("fetchIndex", () => {
  it("adopts the daemon's goal session id, not the one it was asked about", async () => {
    // Focusing a role-child must land on the same board as focusing its
    // orchestrator; the daemon does the hop and the client must not re-derive it.
    requestMock.mockResolvedValueOnce(indexResult("goal-1", [entry("spec")]));
    await fetchIndex("child-7");

    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      type: "blackboard.index",
      sessionId: "child-7",
    });
    expect(blackboard().goalSessionId).toBe("goal-1");
    expect(blackboard().goal).toBe("ship it");
    expect(blackboard().entries).toHaveLength(1);
    expect(blackboard().error).toBeNull();
  });

  it("surfaces a daemon rejection instead of showing an empty board", async () => {
    requestMock.mockRejectedValueOnce(new Error("Session not found"));
    await fetchIndex("nope");
    expect(blackboard().error).toBe("Session not found");
    expect(blackboard().loading).toBe(false);
  });

  it("drops a slow reply for a board the user already navigated away from", async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    requestMock
      .mockImplementationOnce(() => new Promise((res) => (releaseFirst = res)))
      .mockResolvedValueOnce(indexResult("goal-2", [entry("diff")], "second goal"));

    const first = fetchIndex("goal-1");
    const second = fetchIndex("goal-2");
    await second;
    releaseFirst(indexResult("goal-1", [entry("spec")], "first goal"));
    await first;

    expect(blackboard().goal).toBe("second goal");
    expect(blackboard().entries.map((e) => e.kind)).toEqual(["diff"]);
  });

  it("keeps the previous board on screen while re-fetching the same one", async () => {
    requestMock.mockResolvedValueOnce(indexResult("goal-1", [entry("spec")]));
    await fetchIndex("goal-1");

    let release: (v: unknown) => void = () => {};
    requestMock.mockImplementationOnce(() => new Promise((res) => (release = res)));
    const pending = refreshBlackboard();
    // Mid-refresh the panel must not blank out — a fleet polling every few
    // seconds would flicker on every tick.
    expect(blackboard().loading).toBe(true);
    expect(blackboard().entries).toHaveLength(1);
    release(indexResult("goal-1", [entry("spec"), entry("diff")]));
    await pending;
    expect(blackboard().entries).toHaveLength(2);
  });

  it("clears a selection whose artifact left the board", async () => {
    requestMock.mockResolvedValueOnce(indexResult("goal-1", [entry("spec")]));
    await fetchIndex("goal-1");
    requestMock.mockResolvedValueOnce(readResult("SPEC"));
    await selectArtifact({ kind: "spec", slot: null });
    expect(blackboard().artifact?.content).toBe("SPEC");

    // Goal torn down and rebuilt: `spec` is gone. Leaving the body pane showing
    // it would display an artifact nothing in the list points at.
    requestMock.mockResolvedValueOnce(indexResult("goal-1", [entry("diff")]));
    await refreshBlackboard();
    expect(blackboard().selected).toBeNull();
    expect(blackboard().artifact).toBeNull();
  });

  it("keeps a selection that is still on the board", async () => {
    requestMock.mockResolvedValueOnce(indexResult("goal-1", [entry("spec")]));
    await fetchIndex("goal-1");
    requestMock.mockResolvedValueOnce(readResult("SPEC"));
    await selectArtifact({ kind: "spec", slot: null });

    requestMock.mockResolvedValueOnce(indexResult("goal-1", [entry("spec"), entry("diff")]));
    await refreshBlackboard();
    expect(blackboard().selected).toEqual({ kind: "spec", slot: null });
    expect(blackboard().artifact?.content).toBe("SPEC");
  });

  it("refreshBlackboard is a no-op with no board open", async () => {
    await refreshBlackboard();
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("selectArtifact", () => {
  beforeEach(async () => {
    requestMock.mockResolvedValueOnce(
      indexResult("goal-1", [entry("findings", "review"), entry("findings", "review#2")]),
    );
    await fetchIndex("goal-1");
    requestMock.mockReset();
  });

  it("requests the exact slot, so one reviewer is never served for another", async () => {
    requestMock.mockResolvedValueOnce(readResult("SECOND", "findings"));
    await selectArtifact({ kind: "findings", slot: "review#2" });
    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      type: "blackboard.read",
      sessionId: "goal-1",
      kind: "findings",
      slot: "review#2",
    });
    expect(blackboard().artifact?.content).toBe("SECOND");
  });

  it("treats a null artifact as pending, not as an error", async () => {
    requestMock.mockResolvedValueOnce(readResult(null));
    await selectArtifact({ kind: "findings", slot: "review" });
    expect(blackboard().artifact).toBeNull();
    expect(blackboard().artifactError).toBeNull();
    expect(blackboard().artifactLoading).toBe(false);
  });

  it("drops a slow body for an artifact that is no longer selected", async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    requestMock
      .mockImplementationOnce(() => new Promise((res) => (releaseFirst = res)))
      .mockResolvedValueOnce(readResult("SECOND", "findings"));

    const first = selectArtifact({ kind: "findings", slot: "review" });
    const second = selectArtifact({ kind: "findings", slot: "review#2" });
    await second;
    releaseFirst(readResult("FIRST", "findings"));
    await first;

    expect(blackboard().selected).toEqual({ kind: "findings", slot: "review#2" });
    expect(blackboard().artifact?.content).toBe("SECOND");
  });

  it("does nothing when no board is loaded", async () => {
    _resetBlackboardForTest();
    await selectArtifact({ kind: "spec", slot: null });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("clearSelection empties the body pane without touching the index", async () => {
    requestMock.mockResolvedValueOnce(readResult("BODY", "findings"));
    await selectArtifact({ kind: "findings", slot: "review" });
    clearSelection();
    expect(blackboard().selected).toBeNull();
    expect(blackboard().artifact).toBeNull();
    expect(blackboard().entries).toHaveLength(2);
  });
});

describe("open / close", () => {
  it("openBlackboard opens and fetches; closeBlackboard leaves the data cached", async () => {
    requestMock.mockResolvedValue(indexResult("goal-1", [entry("spec")]));
    openBlackboard("goal-1");
    await vi.waitFor(() => expect(blackboard().entries).toHaveLength(1));
    expect(isBlackboardOpen()).toBe(true);

    closeBlackboard();
    expect(isBlackboardOpen()).toBe(false);
    // Cached, so re-opening the same board doesn't flash empty.
    expect(blackboard().entries).toHaveLength(1);
  });
});

describe("refKey", () => {
  it("distinguishes slots within a kind and survives a null slot", () => {
    expect(refKey({ kind: "findings", slot: "review" })).not.toBe(
      refKey({ kind: "findings", slot: "review#2" }),
    );
    expect(refKey({ kind: "spec", slot: null })).toBe(refKey({ kind: "spec", slot: null }));
  });
});
