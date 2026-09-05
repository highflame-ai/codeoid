import { describe, it, expect } from "vitest";

import {
  groupIntoLanes,
  laneFor,
  needsYouCount,
  nodeState,
  stateRank,
  type FleetNodeState,
} from "./fleet-lanes";
import type { FleetTaskWire, SessionInfo, SessionStatus } from "../protocol/types";

function task(id: string, over: Partial<FleetTaskWire> = {}): FleetTaskWire {
  return {
    id,
    kind: "spawn",
    shape: "scout",
    status: "running",
    attempts: 0,
    createdAt: 1_000,
    createdBy: "agent:conductor",
    ...over,
  };
}

const session = (status: SessionStatus): SessionInfo => ({ id: "s1", status }) as SessionInfo;

describe("nodeState", () => {
  it("ranks awaiting above everything — a wedged agent never hides behind its task status", () => {
    // The dispatch status describes the QUEUE; the session status describes the
    // AGENT. A worker stuck on an approval is what needs a human, whatever the
    // queue currently says.
    for (const s of ["running", "claimed", "done", "queued"] as const) {
      expect(nodeState(task("t", { status: s }), session("waiting_approval"))).toBe("awaiting");
    }
  });

  it("maps terminal dispatch states straight through", () => {
    expect(nodeState(task("t", { status: "blocked" }), null)).toBe("blocked");
    expect(nodeState(task("t", { status: "failed" }), null)).toBe("failed");
    expect(nodeState(task("t", { status: "done" }), session("idle"))).toBe("done");
  });

  it("reads working vs idle from the agent, not the queue", () => {
    expect(nodeState(task("t"), session("thinking"))).toBe("working");
    expect(nodeState(task("t"), session("tool_running"))).toBe("working");
    // Claimed by the dispatcher but the agent is quiet — in flight, not busy.
    expect(nodeState(task("t", { status: "claimed" }), session("idle"))).toBe("idle");
  });

  it("treats a session error as a failure of the task", () => {
    expect(nodeState(task("t"), session("error"))).toBe("failed");
  });

  it("distinguishes a dropped runner from a failure", () => {
    // §6: `disconnected` is a transport event, not a task error. Rendering it
    // red would train the operator to ignore red.
    expect(nodeState(task("t", { workerSessionId: "gone" }), null)).toBe("disconnected");
    expect(stateRank("disconnected")).toBeLessThan(stateRank("done"));
  });

  it("treats a claimed spawn with no worker yet as queued, not disconnected", () => {
    // The gap between claim and spawn is normal; calling it disconnected would
    // flag every healthy dispatch for a moment.
    expect(nodeState(task("t", { status: "claimed" }), null)).toBe("queued");
  });
});

describe("stateRank", () => {
  it("puts attention ahead of activity", () => {
    const order: FleetNodeState[] = [
      "awaiting",
      "blocked",
      "failed",
      "working",
      "queued",
      "disconnected",
      "done",
      "idle",
    ];
    const ranks = order.map(stateRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(stateRank("awaiting")).toBeLessThan(stateRank("working"));
  });
});

describe("laneFor", () => {
  it("routes stopped states to Needs you", () => {
    expect(laneFor("awaiting", task("t"))).toBe("needs-you");
    expect(laneFor("blocked", task("t"))).toBe("needs-you");
    expect(laneFor("failed", task("t"))).toBe("needs-you");
  });

  it("keeps in-flight states under Working, including a quiet agent", () => {
    expect(laneFor("working", task("t"))).toBe("working");
    expect(laneFor("queued", task("t"))).toBe("working");
    expect(laneFor("disconnected", task("t"))).toBe("working");
    // A live task whose agent is idle still belongs to the queue, and must not
    // look finished.
    expect(laneFor("idle", task("t"))).toBe("working");
  });

  it("only calls something reviewable when there is a digest to read", () => {
    expect(laneFor("done", task("t", { resultDigest: "found the bug" }))).toBe("review");
    expect(laneFor("done", task("t"))).toBe("done");
  });
});

describe("groupIntoLanes", () => {
  const sessions: Record<string, SessionInfo> = {
    busy: { id: "busy", status: "thinking" } as SessionInfo,
    stuck: { id: "stuck", status: "waiting_approval" } as SessionInfo,
  };
  const lookup = (t: FleetTaskWire) =>
    t.workerSessionId ? (sessions[t.workerSessionId] ?? null) : null;

  it("orders lanes for triage and omits empty ones", () => {
    const groups = groupIntoLanes(
      [
        task("done1", { status: "done", resultDigest: "d" }),
        task("run1", { workerSessionId: "busy" }),
        task("stuck1", { workerSessionId: "stuck" }),
      ],
      lookup,
    );
    expect(groups.map((g) => g.lane)).toEqual(["needs-you", "working", "review"]);
    // "Done" had no members and is absent — four permanent headers over one
    // running task would be chrome, not information.
    expect(groups.some((g) => g.lane === "done")).toBe(false);
  });

  it("sorts by attention within a lane, keeping input order as the tiebreak", () => {
    const groups = groupIntoLanes(
      [
        task("failed1", { status: "failed" }),
        task("stuck1", { workerSessionId: "stuck" }),
        task("blocked1", { status: "blocked" }),
      ],
      lookup,
    );
    const needsYou = groups[0]!;
    expect(needsYou.lane).toBe("needs-you");
    expect(needsYou.nodes.map((n) => n.state)).toEqual(["awaiting", "blocked", "failed"]);
  });

  it("preserves the caller's newest-first order for equal states", () => {
    const groups = groupIntoLanes(
      [task("newer", { status: "blocked" }), task("older", { status: "blocked" })],
      lookup,
    );
    expect(groups[0]!.nodes.map((n) => n.task.id)).toEqual(["newer", "older"]);
  });

  it("carries the resolved session onto each node", () => {
    const [g] = groupIntoLanes([task("run1", { workerSessionId: "busy" })], lookup);
    expect(g!.nodes[0]!.session?.id).toBe("busy");
    expect(g!.nodes[0]!.state).toBe("working");
  });

  it("returns nothing for an empty board", () => {
    expect(groupIntoLanes([], lookup)).toEqual([]);
    expect(needsYouCount([])).toBe(0);
  });
});

describe("needsYouCount", () => {
  it("counts everything stopped, since none of it clears itself", () => {
    const groups = groupIntoLanes(
      [
        task("a", { status: "blocked" }),
        task("b", { status: "failed" }),
        task("c", { status: "done" }),
      ],
      () => null,
    );
    expect(needsYouCount(groups)).toBe(2);
  });
});
