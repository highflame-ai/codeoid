import { describe, it, expect } from "vitest";

import { buildTimeline, groupByDay } from "./fleet-timeline";
import type { FleetEventWire, FleetTaskWire, SessionInfo } from "../protocol/types";

const T = 1_700_000_000_000;

const task = (id: string, over: Partial<FleetTaskWire> = {}): FleetTaskWire => ({
  id,
  kind: "spawn",
  shape: "scout",
  status: "done",
  attempts: 0,
  createdAt: T,
  createdBy: "conductor:acct/proj",
  ...over,
});

const event = (id: number, over: Partial<FleetEventWire> = {}): FleetEventWire => ({
  id,
  taskId: "t1",
  type: "task_done",
  digest: "finished",
  createdAt: T,
  ...over,
});

describe("buildTimeline", () => {
  it("interleaves dispatches and outcomes, newest first", () => {
    const out = buildTimeline(
      [task("t1", { createdAt: T }), task("t2", { createdAt: T + 2_000 })],
      [event(1, { taskId: "t1", createdAt: T + 1_000 })],
    );
    expect(out.map((e) => e.key)).toEqual(["dispatch:t2", "event:1", "dispatch:t1"]);
  });

  it("keeps a dispatch reading as FIRST when it shares a millisecond with its outcome", () => {
    // A fast task settles in the same tick it was dispatched. Newest-first
    // means the dispatch must render SECOND, or the row order implies the
    // result preceded the request.
    const out = buildTimeline([task("t1")], [event(1, { taskId: "t1", createdAt: T })]);
    expect(out.map((e) => e.kind)).toEqual(["done", "dispatched"]);
  });

  it("maps event types onto the timeline vocabulary", () => {
    const out = buildTimeline(
      [],
      [
        event(1, { type: "task_done" }),
        event(2, { type: "task_blocked" }),
        event(3, { type: "task_failed" }),
      ],
    );
    expect(out.map((e) => e.kind).sort()).toEqual(["blocked", "done", "failed"]);
  });

  it("keeps an event type it has never heard of rather than dropping history", () => {
    // A newer daemon naming something differently must not silently erase rows
    // from a retrospective view.
    const out = buildTimeline([], [event(1, { type: "task_reassigned" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("event");
    expect(out[0]!.label).toBe("task_reassigned");
  });

  it("keeps an event whose task has aged off the capped board", () => {
    // The board is bounded; a long fleet run ages tasks out while their events
    // remain, and the digest is the most useful thing left.
    const out = buildTimeline([], [event(1, { taskId: "long-gone", digest: "the answer" })]);
    expect(out[0]!.taskId).toBe("long-gone");
    expect(out[0]!.detail).toBe("the answer");
  });

  it("labels a dispatch with its target so rows are distinguishable", () => {
    const named = { id: "w9", name: "worker-scout-abc" } as SessionInfo;
    const spawn = buildTimeline([task("t1", { workerSessionId: "w9" })], [], () => named);
    expect(spawn[0]!.label).toBe("spawn scout");
    // The NAME, not the id — a raw UUID is noise in a narrow rail.
    expect(spawn[0]!.detail).toBe("worker-scout-abc");
  });

  it("degrades an unresolvable target to a short id, not a full UUID", () => {
    // A finished task has no session at all: the dispatcher tears its worker
    // down after the digest. The id prefix still correlates by eye.
    const out = buildTimeline(
      [task("t1", { workerSessionId: "7bdbd557-656a-4b0c-bab1-6a7894ab3efe" })],
      [],
    );
    expect(out[0]!.detail).toBe("7bdbd557");
  });

  it("leaves the detail null when a dispatch has no target yet", () => {
    // A queued spawn has neither a worker nor a target; inventing one would be
    // worse than an empty cell.
    expect(buildTimeline([task("t1")], [])[0]!.detail).toBeNull();
  });

  it("orders equal rows totally and stably", () => {
    const a = buildTimeline([task("aaa"), task("bbb")], []);
    const b = buildTimeline([task("bbb"), task("aaa")], []);
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
  });

  it("returns nothing for an empty board", () => {
    expect(buildTimeline([], [])).toEqual([]);
  });
});

describe("groupByDay", () => {
  it("splits on LOCAL midnight, not UTC", () => {
    // A UTC split puts an evening dispatch on "tomorrow" for anyone east of the
    // meridian — the user is reading their own day boundaries.
    const late = new Date(2026, 4, 10, 23, 30).getTime();
    const next = new Date(2026, 4, 11, 0, 30).getTime();
    const days = groupByDay(buildTimeline([task("a", { createdAt: next }), task("b", { createdAt: late })], []));
    expect(days).toHaveLength(2);
    expect(days[0]!.day).toBe(new Date(2026, 4, 11).getTime());
    expect(days[1]!.day).toBe(new Date(2026, 4, 10).getTime());
  });

  it("keeps same-day entries together in order", () => {
    const days = groupByDay(
      buildTimeline([task("a", { createdAt: T }), task("b", { createdAt: T + 1_000 })], []),
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.entries.map((e) => e.key)).toEqual(["dispatch:b", "dispatch:a"]);
  });

  it("returns nothing for an empty timeline", () => {
    expect(groupByDay([])).toEqual([]);
  });
});
