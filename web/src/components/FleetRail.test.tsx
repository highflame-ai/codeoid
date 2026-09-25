// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

import { TimelineView } from "./FleetRail";
import { buildTimeline, groupByDay } from "../lib/fleet-timeline";
import type { FleetEventWire, FleetTaskWire } from "../protocol/types";

afterEach(cleanup);

const T = new Date(2026, 4, 10, 9).getTime();

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

const renderTimeline = (tasks: FleetTaskWire[], events: FleetEventWire[]) =>
  render(() => <TimelineView days={groupByDay(buildTimeline(tasks, events))} />);

// The logic tests prove fleet-timeline KEEPS these rows; these prove the
// renderer SHOWS them. Raised by review on #335: the retrospective value is
// lost just as surely if the component drops a row as if the module does.
describe("TimelineView", () => {
  it("renders an event type this client has never heard of, by its raw name", () => {
    const { container } = renderTimeline([task("t1")], [
      event(1, { type: "task_rerouted_v9", digest: "moved to a faster worker", createdAt: T + 1 }),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("task_rerouted_v9");
    expect(text).toContain("moved to a faster worker");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders an event whose task has aged off the board, by its task id", () => {
    // No task on the board at all — the row carries only the id, and the
    // entry type has no task field to dereference.
    const { container } = renderTimeline([], [
      event(1, { taskId: "0123456789abcdef", type: "task_done", digest: "the digest" }),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("01234567");
    expect(text).toContain("the digest");
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("shows the empty state when nothing was dispatched", () => {
    const { container } = renderTimeline([], []);
    expect(container.textContent).toContain("no history to replay");
  });
});
