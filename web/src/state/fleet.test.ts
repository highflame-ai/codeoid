import { describe, it, expect } from "vitest";

import {
  applyDelta,
  applySnapshot,
  EMPTY_FLEET,
  EMPTY_USAGE,
  FLEET_EVENT_LIMIT,
  FLEET_TASK_LIMIT,
  taskSession,
  upsertEvent,
  upsertTask,
  type FleetState,
} from "./fleet";
import type {
  FleetEventWire,
  FleetSnapshot,
  FleetTaskWire,
  FleetUsage,
  SessionInfo,
} from "../protocol/types";

function task(id: string, createdAt: number, over: Partial<FleetTaskWire> = {}): FleetTaskWire {
  return {
    id,
    kind: "spawn",
    shape: "scout",
    status: "queued",
    attempts: 0,
    createdAt,
    createdBy: "agent:conductor",
    ...over,
  };
}

function event(id: number, over: Partial<FleetEventWire> = {}): FleetEventWire {
  return { id, taskId: "t1", type: "task_done", digest: "d", createdAt: 1_000, ...over };
}

const usage = (over: Partial<FleetUsage> = {}): FleetUsage => ({ ...EMPTY_USAGE, ...over });

describe("upsertTask", () => {
  it("replaces IN PLACE so a status change does not move the row", () => {
    // createdAt never changes, so a running→done transition must not make the
    // row you are reading jump position.
    const rows = [task("c", 300), task("b", 200), task("a", 100)];
    const next = upsertTask(rows, task("b", 200, { status: "done" }));
    expect(next.map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(next[1]!.status).toBe("done");
    expect(rows[1]!.status).toBe("queued"); // input untouched
  });

  it("inserts by createdAt rather than assuming deltas arrive newest-last", () => {
    // "Newest arrives last" is an assumption about the network, not a
    // guarantee — a reconnect can replay and a burst can interleave.
    const rows = [task("c", 300), task("a", 100)];
    expect(upsertTask(rows, task("b", 200)).map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(upsertTask(rows, task("d", 400)).map((t) => t.id)).toEqual(["d", "c", "a"]);
    expect(upsertTask(rows, task("z", 50)).map((t) => t.id)).toEqual(["c", "a", "z"]);
  });

  it("caps the list by dropping the OLDEST rows", () => {
    const rows = Array.from({ length: FLEET_TASK_LIMIT }, (_, i) =>
      task(`t${i}`, 10_000 - i),
    );
    const next = upsertTask(rows, task("newest", 99_999));
    expect(next).toHaveLength(FLEET_TASK_LIMIT);
    expect(next[0]!.id).toBe("newest");
    expect(next.some((t) => t.id === `t${FLEET_TASK_LIMIT - 1}`)).toBe(false);
  });

  it("does not grow past the cap when replacing an existing row", () => {
    const rows = Array.from({ length: FLEET_TASK_LIMIT }, (_, i) => task(`t${i}`, 10_000 - i));
    const next = upsertTask(rows, task("t5", 9_995, { status: "done" }));
    expect(next).toHaveLength(FLEET_TASK_LIMIT);
  });
});

describe("upsertEvent", () => {
  it("orders by autoincrement id, not timestamp", () => {
    // A dispatcher tick settles several events in the SAME millisecond;
    // ordering those by createdAt would shuffle them between renders.
    const rows = [event(3, { createdAt: 5 }), event(1, { createdAt: 5 })];
    expect(upsertEvent(rows, event(2, { createdAt: 5 })).map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("caps at the event limit", () => {
    const rows = Array.from({ length: FLEET_EVENT_LIMIT }, (_, i) => event(FLEET_EVENT_LIMIT - i));
    const next = upsertEvent(rows, event(9_999));
    expect(next).toHaveLength(FLEET_EVENT_LIMIT);
    expect(next[0]!.id).toBe(9_999);
  });
});

describe("applyDelta", () => {
  it("replaces agg wholesale rather than recomputing from the capped list", () => {
    // The rollup counts tasks that may have aged off this board, so a locally
    // derived count would drift low on a long-lived session.
    const next = applyDelta(EMPTY_FLEET, {
      kind: "task",
      task: task("a", 1),
      agg: usage({ activeTasks: 7, blockedTasks: 2, totalCostUsd: 1.5 }),
    });
    expect(next.agg.activeTasks).toBe(7);
    expect(next.agg.blockedTasks).toBe(2);
    expect(next.tasks.map((t) => t.id)).toEqual(["a"]);
  });

  it("applies an event delta without disturbing tasks", () => {
    const withTask = applyDelta(EMPTY_FLEET, { kind: "task", task: task("a", 1), agg: usage() });
    const next = applyDelta(withTask, { kind: "event", event: event(1), agg: usage({ activeTasks: 1 }) });
    expect(next.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(next.events.map((e) => e.id)).toEqual([1]);
    expect(next.agg.activeTasks).toBe(1);
  });

  it("is idempotent — a redelivered delta does not duplicate a row", () => {
    // The daemon's watermark is exactly-once by design, but a reconnect
    // re-snapshot plus an in-flight delta can still repeat one.
    const d = { kind: "task", task: task("a", 1), agg: usage() } as const;
    const once = applyDelta(EMPTY_FLEET, d);
    const twice = applyDelta(once, d);
    expect(twice.tasks).toHaveLength(1);
  });
});

describe("applySnapshot", () => {
  const snapshot = (over: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
    workers: [],
    tasks: [],
    events: [],
    agg: usage(),
    ...over,
  });

  it("takes the daemon's ordering and stamps fetchedAt", () => {
    const next = applySnapshot(
      EMPTY_FLEET,
      snapshot({ tasks: [task("b", 2), task("a", 1)], agg: usage({ activeTasks: 3 }) }),
      1_234,
    );
    expect(next.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    expect(next.agg.activeTasks).toBe(3);
    expect(next.fetchedAt).toBe(1_234);
    expect(next.loading).toBe(false);
    expect(next.error).toBeNull();
  });

  it("treats a missing conductor as a valid state, not an error", () => {
    expect(applySnapshot(EMPTY_FLEET, snapshot(), 1).conductor).toBeNull();
  });

  it("clears a previous error so a recovered subscribe does not keep showing it", () => {
    const failed: FleetState = { ...EMPTY_FLEET, error: "boom", loading: true };
    const next = applySnapshot(failed, snapshot(), 1);
    expect(next.error).toBeNull();
    expect(next.loading).toBe(false);
  });

  it("caps an over-large snapshot rather than trusting the page size", () => {
    // A future daemon raising its limit must not raise this client's ceiling.
    const next = applySnapshot(
      EMPTY_FLEET,
      snapshot({
        tasks: Array.from({ length: FLEET_TASK_LIMIT + 25 }, (_, i) => task(`t${i}`, 9_999 - i)),
        events: Array.from({ length: FLEET_EVENT_LIMIT + 10 }, (_, i) => event(9_999 - i)),
      }),
      1,
    );
    expect(next.tasks).toHaveLength(FLEET_TASK_LIMIT);
    expect(next.events).toHaveLength(FLEET_EVENT_LIMIT);
  });
});

describe("taskSession", () => {
  const worker = { id: "w1", name: "worker-scout-abc" } as SessionInfo;
  const base: FleetState = { ...EMPTY_FLEET, workers: [worker] };

  it("resolves a spawn worker and a send target through the same join", () => {
    expect(taskSession(base, task("a", 1, { workerSessionId: "w1" }))?.id).toBe("w1");
    expect(taskSession(base, task("b", 1, { targetSession: "w1" }))?.id).toBe("w1");
  });

  it("returns null for an unjoinable task rather than inventing a row", () => {
    // A queued spawn has no worker yet, and a target can be destroyed while
    // its task is still on the board.
    expect(taskSession(base, task("c", 1))).toBeNull();
    expect(taskSession(base, task("d", 1, { workerSessionId: "gone" }))).toBeNull();
  });
});
