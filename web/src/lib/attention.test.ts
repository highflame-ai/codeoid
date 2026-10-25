import { describe, it, expect } from "vitest";

import {
  attentionQueue,
  attentionScore,
  collectAttention,
  rankAttention,
  type AttentionItem,
  type AttentionSources,
} from "./attention";
import { routine, runWire, watch } from "./automation.fixtures";
import { LOOP_APPROVAL_WAIT } from "./loops";
import type { FleetTaskWire, LoopRunWire, SessionInfo, SessionUiRequestMsg } from "../protocol/types";

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

  it("lists a held task as an approval, once — not again beside its session's own", () => {
    const wedged = session("w", { status: "waiting_approval" });
    const quiet = session("q");
    const items = collectAttention(
      sources({
        sessions: [wedged, quiet],
        tasks: [
          task("held-1", { status: "held", workerSessionId: "w", error: "approval outside profile" }),
          task("held-2", { status: "held", workerSessionId: "q" }),
        ],
        taskSession: (t) => (t.workerSessionId === "w" ? wedged : t.workerSessionId === "q" ? quiet : null),
      }),
      NOW,
    );
    expect(items.map((i) => [i.key, i.kind])).toEqual([
      ["approval:w", "approval"],
      ["task:held-2", "approval"],
    ]);
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

describe("collectAttention — loop runs", () => {
  const loop = (id: string, over: Partial<LoopRunWire>): LoopRunWire =>
    ({
      id,
      objective: `Objective ${id}\nmore`,
      status: "running",
      reason: null,
      waitingOn: null, waitingKind: null,
      workerSessionId: `w-${id}`,
      updatedAt: iso(NOW - 5 * MIN),
      ...over,
    }) as LoopRunWire;

  it("lists a run's question and a blocked run, deep-linked to the run", () => {
    const items = collectAttention(
      sources({
        loops: [
          loop("q", { status: "waiting", waitingOn: "the owner's answer: Keep the old API?" }),
          loop("b", { status: "blocked", reason: "the checks already pass", endedAt: new Date(NOW - 5 * MIN).toISOString() }),
          // Blocked more than a day ago: no longer asks for attention.
          loop("old", { status: "blocked", reason: "stale", endedAt: new Date(NOW - 25 * 60 * MIN).toISOString() }),
          loop("r", { status: "running" }),
          loop("c", { status: "completed" }),
        ],
      }),
      NOW,
    );
    expect(items.map((i) => [i.key, i.kind, i.runId, i.sessionId, i.detail])).toEqual([
      ["loop:q", "question", "q", null, "Keep the old API?"],
      ["loop:b", "blocked", "b", null, "the checks already pass"],
    ]);
    expect(items[0]!.label).toBe("loop · Objective q");
    expect(items[0]!.since).toBe(NOW - 5 * MIN);
  });

  it("uses the daemon's waitingKind over the text", () => {
    const items = collectAttention(
      sources({ loops: [loop("k", { status: "waiting", waitingOn: "anything", waitingKind: "approval" })] }),
      NOW,
    );
    expect(items.filter((i) => i.key === "loop:k")).toEqual([]);
  });

  it("leaves an approval wait to its worker session's approval row", () => {
    const items = collectAttention(
      sources({
        sessions: [session("w-a", { status: "waiting_approval" })],
        loops: [loop("a", { status: "waiting", waitingOn: LOOP_APPROVAL_WAIT })],
      }),
      NOW,
    );
    expect(items.map((i) => i.key)).toEqual(["approval:w-a"]);
  });
});

describe("collectAttention — watches and routines", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it("lists a watch whose poll failed, backing off or not, and one that paused itself", () => {
    const items = collectAttention(
      sources({
        watches: [
          watch({ id: "ok" }),
          watch({ id: "err", lastError: "reading main's head: HTTP 404", lastPolledAt: iso(NOW - 2 * MIN) }),
          watch({ id: "rl", lastError: "GitHub API rate limit exceeded", lastPolledAt: iso(NOW - MIN) }),
          watch({ id: "self", enabled: false, lastError: "gh is now signed in as @x, but this watch acts as @me, so it paused itself" }),
          // Paused by you: quiet, whatever its last poll said.
          watch({ id: "paused", enabled: false, lastError: "reading main's head: HTTP 404" }),
        ],
      }),
      NOW,
    );
    expect(items.map((i) => [i.key, i.kind, i.watchId])).toEqual([
      ["watch:err", "failed", "err"],
      ["watch:rl", "failed", "rl"],
      ["watch:self", "blocked", "self"],
    ]);
    expect(items[1]!.detail).toMatch(/^backing off: /);
    expect(items[0]!.label).toBe("watch · acme/shop");
  });

  it("lists a routine that paused itself, and one whose last run failed in the last day", () => {
    const items = collectAttention(
      sources({
        routines: [
          routine({ id: "fine", lastRun: runWire() }),
          routine({ id: "auto", name: "auto", enabled: false, pausedReason: "paused after 3 failed runs in a row" }),
          routine({ id: "bad", name: "bad", lastRun: runWire({ status: "failed", reason: "check exited 1", endedAt: iso(NOW - 10 * MIN) }) }),
          routine({ id: "old", lastRun: runWire({ status: "timed_out", endedAt: iso(NOW - 25 * 60 * MIN) }) }),
          // Parked on an approval: the session's approval row stands for it.
          routine({ id: "parked", lastRun: runWire({ status: "needs_attention" }) }),
        ],
      }),
      NOW,
    );
    expect(items.map((i) => [i.key, i.kind, i.routineId, i.detail])).toEqual([
      ["routine:auto", "blocked", "auto", "paused after 3 failed runs in a row"],
      ["routine:bad", "failed", "bad", "failed: check exited 1"],
    ]);
    expect(items[1]!.since).toBe(NOW - 10 * MIN);
  });

  it("lists a loop routine whose loop ended blocked as a failure, labelled as the loop's", () => {
    const items = collectAttention(
      sources({
        routines: [
          routine({
            id: "lb",
            name: "lb",
            lastRun: runWire({ status: "needs_attention", reason: "the loop run is blocked after 2 attempt(s): no progress", endedAt: iso(NOW - MIN), loop: { runId: "loop_1", status: "blocked" } }),
          }),
        ],
      }),
      NOW,
    );
    expect(items.map((i) => [i.key, i.kind, i.detail])).toEqual([["routine:lb", "failed", "loop blocked: the loop run is blocked after 2 attempt(s): no progress"]]);
  });

  it("lists a loop routine whose loop waits on you, or is paused, even behind a later skipped fire", () => {
    const following = (status: "waiting" | "paused" | "running") =>
      runWire({ status: "running", startedAt: iso(NOW - 5 * MIN), endedAt: undefined, loop: { runId: `loop_${status}`, status } });
    const skipped = runWire({ id: "run_skip", status: "skipped", reason: "the loop run its last fire started (loop_waiting) is still in progress (waiting)" });
    const items = collectAttention(
      sources({
        routines: [
          routine({ id: "w", name: "w", lastRun: skipped, activeLoopRun: following("waiting") }),
          routine({ id: "p", name: "p", lastRun: following("paused"), activeLoopRun: following("paused") }),
          // Working on its own: nothing for you to do.
          routine({ id: "r", name: "r", lastRun: following("running"), activeLoopRun: following("running") }),
        ],
      }),
      NOW,
    );
    expect(items.map((i) => [i.key, i.kind, i.routineId])).toEqual([
      ["routine:w", "blocked", "w"],
      ["routine:p", "blocked", "p"],
    ]);
    expect(items[0]!.detail).toMatch(/^waiting on its loop/);
    expect(items[1]!.detail).toContain("paused");
    expect(items[0]!.since).toBe(NOW - 5 * MIN);
  });
});
