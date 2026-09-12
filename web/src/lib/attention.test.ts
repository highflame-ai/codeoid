import { describe, it, expect } from "vitest";

import {
  attentionQueue,
  attentionScore,
  collectAttention,
  rankAttention,
  type AttentionItem,
  type AttentionSources,
} from "./attention";
import type { FleetTaskWire, SessionInfo, SessionUiRequestMsg } from "../protocol/types";

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name: id, status: "idle", ...over }) as SessionInfo;

const uiReq = (sessionId: string, requestId: string, title: string): SessionUiRequestMsg =>
  ({ type: "session.ui_request", sessionId, requestId, method: "confirm", title }) as SessionUiRequestMsg;

const task = (id: string, over: Partial<FleetTaskWire> = {}): FleetTaskWire => ({
  id,
  kind: "spawn",
  shape: "scout",
  status: "blocked",
  attempts: 2,
  createdAt: NOW,
  createdBy: "agent:conductor",
  ...over,
});

const sources = (over: Partial<AttentionSources> = {}): AttentionSources => ({
  sessions: [],
  uiRequests: {},
  tasks: [],
  taskSession: () => null,
  ...over,
});

const iso = (ms: number) => new Date(ms).toISOString();

describe("collectAttention", () => {
  it("gathers dialogs, wedged sessions and stopped tasks into one queue", () => {
    const items = collectAttention(
      sources({
        sessions: [
          session("a", { status: "waiting_approval" }),
          session("b"),
          session("c", { status: "idle" }),
        ],
        uiRequests: { b: [uiReq("b", "r1", "Pick a branch")] },
        tasks: [task("t1"), task("t2", { status: "failed" }), task("t3", { status: "done" })],
      }),
      NOW,
    );
    expect(items.map((i) => i.kind).sort()).toEqual([
      "approval",
      "blocked",
      "failed",
      "question",
    ]);
    // A `done` task is not an interruption.
    expect(items.some((i) => i.key.includes("t3"))).toBe(false);
  });

  it("does not double-count one stoppage as both a dialog and an approval", () => {
    // A session showing a provider dialog is usually ALSO waiting_approval.
    // Counting both would tell the operator two things need them when one does.
    const items = collectAttention(
      sources({
        sessions: [session("a", { status: "waiting_approval" })],
        uiRequests: { a: [uiReq("a", "r1", "Confirm?")] },
      }),
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("question");
    expect(items[0]!.detail).toBe("Confirm?");
  });

  it("skips a dialog whose session this client cannot see", () => {
    // Clicking it would go nowhere, so it is not actionable.
    const items = collectAttention(
      sources({ sessions: [], uiRequests: { ghost: [uiReq("ghost", "r1", "?")] } }),
      NOW,
    );
    expect(items).toEqual([]);
  });

  it("labels a task by its session when it has one, and by id when it does not", () => {
    const worker = session("w1", { name: "worker-scout-abc" });
    const withSession = collectAttention(
      sources({
        sessions: [worker],
        tasks: [task("t1", { workerSessionId: "w1" })],
        taskSession: () => worker,
      }),
      NOW,
    );
    expect(withSession[0]!.label).toBe("worker-scout-abc");
    expect(withSession[0]!.sessionId).toBe("w1");

    // A finished worker is torn down, so a stopped task often has no session.
    const orphan = collectAttention(sources({ tasks: [task("abcdef12")] }), NOW);
    expect(orphan[0]!.label).toBe("spawn abcdef12");
    expect(orphan[0]!.sessionId).toBeNull();
  });

  it("carries the task's real error as the detail", () => {
    const items = collectAttention(
      sources({ tasks: [task("t1", { error: "reclaimed: stale claim" })] }),
      NOW,
    );
    expect(items[0]!.detail).toBe("reclaimed: stale claim");
  });

  it("treats an unknown or unparseable age as brand new, never as ancient", () => {
    // An unknown must not jump the queue.
    const items = collectAttention(
      sources({
        sessions: [
          session("a", { status: "waiting_approval" }),
          session("b", { status: "waiting_approval", lastActivityAt: "not-a-date" }),
        ],
      }),
      NOW,
    );
    expect(items.every((i) => i.since === NOW)).toBe(true);
  });
});

describe("attentionScore / rankAttention", () => {
  const item = (over: Partial<AttentionItem>): AttentionItem => ({
    key: "k",
    kind: "approval",
    sessionId: "s",
    label: "s",
    detail: "",
    since: NOW,
    ...over,
  });

  it("ranks a live wedged agent above a stopped task of the same age", () => {
    const q = rankAttention(
      [
        item({ key: "task", kind: "blocked" }),
        item({ key: "agent", kind: "approval" }),
      ],
      NOW,
    );
    expect(q.map((i) => i.key)).toEqual(["agent", "task"]);
  });

  it("floats a long-stuck yes/no above a fresher one — §8's worked example", () => {
    const q = rankAttention(
      [
        item({ key: "fresh", kind: "question", since: NOW }),
        item({ key: "stuck8m", kind: "question", since: NOW - 8 * MIN }),
      ],
      NOW,
    );
    expect(q[0]!.key).toBe("stuck8m");
  });

  it("lets kind dominate while everything is new", () => {
    // Without the age floor every fresh item scores zero and the queue would
    // rank purely by age exactly when a wedged agent most needs to be first.
    const q = rankAttention(
      [
        item({ key: "failed", kind: "failed", since: NOW }),
        item({ key: "question", kind: "question", since: NOW }),
      ],
      NOW,
    );
    expect(q[0]!.key).toBe("question");
  });

  it("lets staleness eventually overtake kind", () => {
    const q = rankAttention(
      [
        item({ key: "freshQuestion", kind: "question", since: NOW }),
        item({ key: "oldFailure", kind: "failed", since: NOW - 30 * MIN }),
      ],
      NOW,
    );
    expect(q[0]!.key).toBe("oldFailure");
  });

  it("orders ties totally and stably", () => {
    // A queue that reshuffles equal rows between renders is one you cannot
    // click accurately.
    const a = item({ key: "aaa" });
    const b = item({ key: "bbb" });
    expect(rankAttention([b, a], NOW).map((i) => i.key)).toEqual(["aaa", "bbb"]);
    expect(rankAttention([a, b], NOW).map((i) => i.key)).toEqual(["aaa", "bbb"]);
  });

  it("scores a future timestamp as brand new rather than negative", () => {
    // Clock skew between daemon and browser is normal; it must not produce a
    // negative score that buries a real interruption.
    const future = item({ since: NOW + 5 * MIN });
    expect(attentionScore(future, NOW)).toBeGreaterThan(0);
    expect(attentionScore(future, NOW)).toBe(attentionScore(item({ since: NOW }), NOW));
  });
});

describe("attentionQueue", () => {
  it("collects and ranks in one call", () => {
    const q = attentionQueue(
      sources({
        sessions: [session("wedged", { status: "waiting_approval", lastActivityAt: iso(NOW) })],
        tasks: [task("old", { createdAt: NOW - 60 * MIN })],
      }),
      NOW,
    );
    expect(q).toHaveLength(2);
    // The hour-old blocked task outranks the just-wedged agent.
    expect(q[0]!.key).toBe("task:old");
  });

  it("returns an empty queue when nothing needs you", () => {
    expect(attentionQueue(sources({ sessions: [session("a")] }), NOW)).toEqual([]);
  });
});
