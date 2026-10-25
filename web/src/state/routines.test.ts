// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
/** Swapped to stand for a new connection. */
const clientRef = vi.hoisted(() => ({ current: { request: clientRequestMock } as object }));
vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => clientRef.current,
}));

import {
  VIEW_POLL_MS,
  WATCH_POLL_MS,
  _resetRoutinesForTest,
  cancelRoutineRun,
  closeRoutines,
  createRoutine,
  deleteRoutine,
  fetchRoutines,
  openRoutines,
  previewSchedule,
  rotateRoutineToken,
  routinesState,
  runRoutineNow,
  selectRoutine,
  setRoutineEnabled,
  updateRoutine,
  watchRoutines,
} from "./routines";
import { routine, runWire } from "../lib/automation.fixtures";
import type { RoutineWire } from "../protocol/types";

const list = (routines: RoutineWire[]) => ({ type: "routine.list.result", requestId: "r", routines });
const snap = (over: Partial<RoutineWire> = {}, extra: Record<string, unknown> = {}) => ({
  type: "routine.snapshot",
  requestId: "r",
  routine: routine(over),
  ...extra,
});
const sent = (n: number) => clientRequestMock.mock.calls[n]?.[0] as Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  _resetRoutinesForTest();
  clientRequestMock.mockReset();
  clientRef.current = { request: clientRequestMock };
  vi.useRealTimers();
});

describe("routines store — reads", () => {
  it("lists the owner's routines", async () => {
    clientRequestMock.mockResolvedValue(list([routine(), routine({ id: "rt_2", name: "digest" })]));
    await fetchRoutines();
    expect(sent(0)).toEqual({ type: "routine.list", id: "r" });
    expect(routinesState().routines.map((r) => r.id)).toEqual(["rt_1", "rt_2"]);
    expect(routinesState().loaded).toBe(true);
  });

  it("selecting a routine reads it with its recent runs", async () => {
    clientRequestMock.mockResolvedValue(snap({}, { runs: [runWire()] }));
    selectRoutine("rt_1");
    await tick();
    expect(sent(0)).toEqual({ type: "routine.get", id: "r", routine: "rt_1", runs: 10 });
    expect(routinesState().detail?.runs.map((r) => r.id)).toEqual(["run_1"]);

    // A control's reply carries no runs: what was shown stays.
    clientRequestMock.mockResolvedValue(snap({ enabled: false }));
    await setRoutineEnabled("rt_1", false);
    expect(sent(1)).toEqual({ type: "routine.update", id: "r", routine: "rt_1", enabled: false });
    expect(routinesState().detail?.routine.enabled).toBe(false);
    expect(routinesState().detail?.runs).toHaveLength(1);
  });

  it("a forbidden read clears everything shown, and stops the background watch", async () => {
    vi.useFakeTimers();
    clientRequestMock.mockResolvedValue(list([routine()]));
    const stop = watchRoutines();
    await vi.advanceTimersByTimeAsync(0);
    expect(routinesState().routines).toHaveLength(1);

    // The client rejects a response.error as a plain Error: the words alone must do.
    clientRequestMock.mockRejectedValue(new Error("Missing scope: session:create"));
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);
    expect(routinesState().routines).toEqual([]);
    expect(routinesState().error).toBe("Missing scope: session:create");
    const calls = clientRequestMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(calls);
    stop();
  });

  it("a daemon with routines off stops the background watch too", async () => {
    vi.useFakeTimers();
    clientRequestMock.mockRejectedValue({ error: "routines are disabled on this daemon (routines.enabled)", code: "invalid_request" });
    watchRoutines();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
  });

  it("a new connection starts empty: nothing read over the old one shows", async () => {
    clientRequestMock.mockResolvedValue(snap({}, { runs: [runWire()] }));
    selectRoutine("rt_1");
    await tick();
    expect(routinesState().detail).not.toBeNull();

    const second = vi.fn().mockResolvedValue(list([]));
    clientRef.current = { request: second };
    await fetchRoutines();
    expect(second).toHaveBeenCalledTimes(1);
    expect(routinesState()).toMatchObject({ routines: [], detail: null, selectedId: null });
  });

  it("an error for a routine the user left doesn't paint over another", async () => {
    let reject!: (e: unknown) => void;
    clientRequestMock.mockReturnValueOnce(new Promise((_, rj) => (reject = rj)));
    selectRoutine("rt_1");
    clientRequestMock.mockResolvedValue(list([]));
    selectRoutine(null);
    reject(new Error("Routine not found: rt_1"));
    await tick();
    expect(routinesState().error).toBeNull();
  });
});

describe("routines store — controls", () => {
  it("runs now, shows the queued run at once, then re-reads the routine", async () => {
    clientRequestMock.mockResolvedValueOnce(snap({}, { runs: [] }));
    selectRoutine("rt_1");
    await tick();
    clientRequestMock.mockResolvedValueOnce({ type: "routine.run.result", requestId: "r", run: runWire({ id: "run_new", status: "queued", trigger: "manual" }) });
    clientRequestMock.mockResolvedValueOnce(snap({}, { runs: [runWire({ id: "run_new", status: "running", trigger: "manual" })] }));
    const run = await runRoutineNow("rt_1", "the alert");
    expect(sent(1)).toEqual({ type: "routine.run", id: "r", routine: "rt_1", payload: "the alert" });
    expect(run?.status).toBe("queued");
    expect(routinesState().detail?.runs[0]?.id).toBe("run_new");
    await tick();
    expect(sent(2)).toMatchObject({ type: "routine.get", routine: "rt_1" });
    expect(routinesState().detail?.runs[0]?.status).toBe("running");
  });

  it("a refused run keeps the daemon's words", async () => {
    clientRequestMock.mockRejectedValue(new Error("Missing scope: session:approve (this routine pre-approves work)"));
    expect(await runRoutineNow("rt_1")).toBeNull();
    expect(routinesState().error).toBe("Missing scope: session:approve (this routine pre-approves work)");
    expect(routinesState().busy).toBe(false);
  });

  it("cancels a run and re-reads", async () => {
    clientRequestMock.mockResolvedValueOnce({ type: "response.ok", requestId: "r" }).mockResolvedValue(snap());
    expect(await cancelRoutineRun("rt_1", "run_1")).toBe(true);
    expect(sent(0)).toEqual({ type: "routine.cancel_run", id: "r", runId: "run_1" });
    await tick();
    expect(sent(1)).toMatchObject({ type: "routine.get" });
  });

  it("deleting removes it and leaves its detail", async () => {
    clientRequestMock.mockResolvedValueOnce(snap({}, { runs: [] }));
    selectRoutine("rt_1");
    await tick();
    clientRequestMock.mockResolvedValueOnce({ type: "response.ok", requestId: "r" });
    expect(await deleteRoutine("rt_1")).toBe(true);
    expect(sent(1)).toEqual({ type: "routine.delete", id: "r", routine: "rt_1" });
    expect(routinesState()).toMatchObject({ routines: [], selectedId: null, detail: null });
  });

  it("create selects the new routine and hands back a one-time token", async () => {
    clientRequestMock.mockResolvedValue(snap({ id: "rt_new" }, { apiToken: "rt_secret" }));
    const spec = { name: "x", prompt: "p", workdir: "/w", api: true };
    const res = await createRoutine(spec);
    expect(sent(0)).toEqual({ type: "routine.create", id: "r", spec });
    expect(res.apiToken).toBe("rt_secret");
    expect(routinesState().selectedId).toBe("rt_new");
  });

  it("create, update, preview and token reject with the daemon's words", async () => {
    clientRequestMock.mockRejectedValue(new Error('a routine named "x" already exists'));
    await expect(createRoutine({ name: "x", prompt: "p", workdir: "/w" })).rejects.toThrow('a routine named "x" already exists');
    await expect(updateRoutine("rt_1", { prompt: "q" })).rejects.toThrow('a routine named "x" already exists');
    clientRequestMock.mockRejectedValue(new Error('cron "* * * * *" fires every 60s — the minimum interval is 120s'));
    await expect(previewSchedule({ kind: "cron", expr: "* * * * *" })).rejects.toThrow("the minimum interval is 120s");
    clientRequestMock.mockRejectedValue(new Error("this routine's API trigger is off — enable it first"));
    await expect(rotateRoutineToken("rt_1")).rejects.toThrow("API trigger is off");
  });

  it("preview asks for the next three fires", async () => {
    clientRequestMock.mockResolvedValue({ type: "routine.preview.result", requestId: "r", fires: ["a", "b", "c"] });
    expect(await previewSchedule({ kind: "every", seconds: 900 })).toEqual(["a", "b", "c"]);
    expect(sent(0)).toEqual({ type: "routine.preview", id: "r", schedule: { kind: "every", seconds: 900 }, count: 3 });
  });
});

describe("routines store — polling", () => {
  beforeEach(() => vi.useFakeTimers());

  it("polls the list while open, the selected routine when one is, and stops on close", async () => {
    clientRequestMock.mockResolvedValue(list([routine()]));
    openRoutines();
    expect(sent(0)).toMatchObject({ type: "routine.list" });
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS);
    expect(sent(1)).toMatchObject({ type: "routine.list" });

    clientRequestMock.mockResolvedValue(snap());
    selectRoutine("rt_1");
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS);
    expect(sent(clientRequestMock.mock.calls.length - 1)).toMatchObject({ type: "routine.get", routine: "rt_1" });

    closeRoutines();
    const calls = clientRequestMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS * 5);
    expect(clientRequestMock).toHaveBeenCalledTimes(calls);
  });

  it("opening on a routine reads that routine", async () => {
    clientRequestMock.mockResolvedValue(snap());
    openRoutines("rt_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent(0)).toMatchObject({ type: "routine.get", routine: "rt_1" });
  });

  it("doesn't poll while the page is hidden", async () => {
    clientRequestMock.mockResolvedValue(list([]));
    openRoutines();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const calls = clientRequestMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(calls);
    visibility.mockRestore();
  });

  it("a watcher refreshes slowly and stops when released", async () => {
    clientRequestMock.mockResolvedValue(list([]));
    const stop = watchRoutines();
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    stop();
    stop();
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
  });
});
