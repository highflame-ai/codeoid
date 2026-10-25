// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  VIEW_POLL_MS,
  WATCH_POLL_MS,
  _resetLoopsForTest,
  cancelLoop,
  closeLoops,
  fetchLoops,
  loopsState,
  openLoops,
  pauseLoop,
  resumeLoop,
  selectLoop,
  setLoopHistoryOpen,
  startLoop,
  steerLoop,
  watchLoops,
} from "./loops";
import type { LoopRunWire } from "../protocol/types";

function run(over: Partial<LoopRunWire> = {}): LoopRunWire {
  return {
    id: "loop_1",
    recipe: "repair",
    objective: "Fix the checkout test",
    workdir: "/repo",
    checks: [{ id: "check1", command: "bun test", timeoutSec: 600 }],
    limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 },
    toolBudget: 60,
    status: "running",
    reason: null,
    waitingOn: null, waitingKind: null,
    baseRevision: null,
    branch: null,
    worktreePath: null,
    workerSessionId: null,
    acceptedAttemptId: null,
    deliveredCommit: null,
    attempts: 1,
    activeMs: 0,
    costUsd: 0,
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    endedAt: null,
    ...over,
  };
}

const snap = (over: Partial<LoopRunWire> = {}, extra: Record<string, unknown> = {}) => ({
  type: "loop.snapshot",
  requestId: "r",
  run: run(over),
  attempts: [],
  ...extra,
});
const list = (runs: LoopRunWire[]) => ({ type: "loop.list.result", requestId: "r", runs });

/** The message of the `n`th request. */
const sent = (n: number) => clientRequestMock.mock.calls[n]?.[0] as Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  _resetLoopsForTest();
  clientRequestMock.mockReset();
  vi.useRealTimers();
});

describe("loops store — reads", () => {
  it("lists the owner's runs", async () => {
    clientRequestMock.mockResolvedValue(list([run(), run({ id: "loop_2" })]));
    await fetchLoops();
    expect(sent(0)).toEqual({ type: "loop.list", id: "r" });
    expect(loopsState().runs.map((r) => r.id)).toEqual(["loop_1", "loop_2"]);
    expect(loopsState().loaded).toBe(true);
  });

  it("selecting a run reads it, and opening the history asks for events", async () => {
    clientRequestMock.mockResolvedValue(snap());
    selectLoop("loop_1");
    await tick();
    expect(sent(0)).toEqual({ type: "loop.get", id: "r", runId: "loop_1" });
    expect(loopsState().detail?.run.id).toBe("loop_1");

    clientRequestMock.mockResolvedValue(snap({}, { events: [{ seq: 1, at: "x", actor: "u", type: "run.started", detail: "" }] }));
    setLoopHistoryOpen(true);
    await tick();
    expect(sent(1)).toEqual({ type: "loop.get", id: "r", runId: "loop_1", events: true });
    expect(loopsState().detail?.events?.[0]?.type).toBe("run.started");

    // A control's reply carries no events: what was shown stays.
    clientRequestMock.mockResolvedValue(snap({ status: "paused" }));
    await pauseLoop("loop_1");
    expect(loopsState().detail?.run.status).toBe("paused");
    expect(loopsState().detail?.events).toHaveLength(1);
  });

  it("keeps the daemon's error words", async () => {
    clientRequestMock.mockRejectedValue({ error: "Missing scope: loops need session:create and session:send", code: "forbidden" });
    await fetchLoops();
    expect(loopsState().error).toBe("Missing scope: loops need session:create and session:send");
  });
});

describe("loops store — controls", () => {
  it("sends each control for the run and applies the reply", async () => {
    clientRequestMock.mockResolvedValue(snap());
    await pauseLoop("loop_1");
    await resumeLoop("loop_1");
    await cancelLoop("loop_1");
    expect(await steerLoop("loop_1", "Keep the v1 API")).toBe(true);
    expect([0, 1, 2, 3].map(sent)).toEqual([
      { type: "loop.pause", id: "r", runId: "loop_1" },
      { type: "loop.resume", id: "r", runId: "loop_1" },
      { type: "loop.cancel", id: "r", runId: "loop_1" },
      { type: "loop.steer", id: "r", runId: "loop_1", text: "Keep the v1 API" },
    ]);
    expect(loopsState().runs.map((r) => r.id)).toEqual(["loop_1"]);
    expect(loopsState().busy).toBe(false);
  });

  it("a refused control resolves false and surfaces why", async () => {
    clientRequestMock.mockRejectedValue({ error: "A delegated token cannot steer a loop", code: "forbidden" });
    expect(await steerLoop("loop_1", "x")).toBe(false);
    expect(loopsState().error).toBe("A delegated token cannot steer a loop");
  });

  it("start sends loop.start with the body and selects the new run", async () => {
    clientRequestMock.mockResolvedValue(snap({ id: "loop_new" }));
    const body = { type: "loop.start" as const, objective: "Fix it", workdir: "/repo", checks: [{ command: "bun test" }] };
    const started = await startLoop(body);
    expect(sent(0)).toEqual({ ...body, id: "r" });
    expect(started.id).toBe("loop_new");
    expect(loopsState().selectedId).toBe("loop_new");
    expect(loopsState().detail?.run.id).toBe("loop_new");
  });

  it("start rejects with the daemon's message", async () => {
    clientRequestMock.mockRejectedValue({ error: 'Loops run on claude for now; "codex" cannot report an attempt\'s outcome yet', code: "invalid_request" });
    await expect(startLoop({ type: "loop.start", objective: "x", workdir: "/r", checks: [{ command: "t" }], provider: "codex" })).rejects.toThrow(
      'Loops run on claude for now; "codex" cannot report an attempt\'s outcome yet',
    );
  });
});

describe("loops store — polling", () => {
  beforeEach(() => vi.useFakeTimers());

  it("polls the list while the view is open, the selected run when one is, and stops on close", async () => {
    clientRequestMock.mockResolvedValue(list([run()]));
    openLoops();
    expect(sent(0)).toMatchObject({ type: "loop.list" });
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    expect(sent(1)).toMatchObject({ type: "loop.list" });

    clientRequestMock.mockResolvedValue(snap());
    selectLoop("loop_1");
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS);
    expect(sent(clientRequestMock.mock.calls.length - 1)).toMatchObject({ type: "loop.get", runId: "loop_1" });

    closeLoops();
    const calls = clientRequestMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS * 5);
    expect(clientRequestMock).toHaveBeenCalledTimes(calls);
  });

  it("opening on a run reads that run", async () => {
    clientRequestMock.mockResolvedValue(snap());
    openLoops("loop_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent(0)).toEqual({ type: "loop.get", id: "r", runId: "loop_1" });
    expect(loopsState().selectedId).toBe("loop_1");
  });

  it("does not poll while the page is hidden", async () => {
    clientRequestMock.mockResolvedValue(list([]));
    openLoops();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const calls = clientRequestMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(calls);
    visibility.mockRestore();
  });

  it("a watcher refreshes the list slowly and stops when released", async () => {
    clientRequestMock.mockResolvedValue(list([]));
    const stop = watchLoops();
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS);
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
  });

  it("a daemon without loops stops the background watch", async () => {
    clientRequestMock.mockRejectedValue({ error: "Loops are not available on this daemon", code: "invalid_request" });
    watchLoops();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
  });
});
