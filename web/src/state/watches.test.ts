// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
const clientRef = vi.hoisted(() => ({ current: { request: clientRequestMock } as object }));
vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => clientRef.current,
}));

import {
  VIEW_POLL_MS,
  WATCH_POLL_MS,
  _resetWatchesForTest,
  closeWatches,
  createWatch,
  deleteWatch,
  fetchWatches,
  openWatches,
  pollWatch,
  selectWatch,
  setWatchEnabled,
  updateWatch,
  watchWatches,
  watchesState,
} from "./watches";
import { trigger, watch } from "../lib/automation.fixtures";
import type { LoopWatchWire } from "../protocol/types";

const list = (watches: LoopWatchWire[]) => ({ type: "loop.watch.list.result", requestId: "r", watches });
const snap = (over: Partial<LoopWatchWire> = {}, extra: Record<string, unknown> = {}) => ({
  type: "loop.watch.snapshot",
  requestId: "r",
  watch: watch(over),
  ...extra,
});
const sent = (n: number) => clientRequestMock.mock.calls[n]?.[0] as Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  _resetWatchesForTest();
  clientRequestMock.mockReset();
  clientRef.current = { request: clientRequestMock };
  vi.useRealTimers();
});

describe("watches store — reads", () => {
  it("lists the owner's watches", async () => {
    clientRequestMock.mockResolvedValue(list([watch(), watch({ id: "w_2" })]));
    await fetchWatches();
    expect(sent(0)).toEqual({ type: "loop.watch.list", id: "r" });
    expect(watchesState().watches.map((w) => w.id)).toEqual(["w_1", "w_2"]);
  });

  it("selecting a watch reads it with what it acted on; a control keeps that history", async () => {
    clientRequestMock.mockResolvedValue(snap({}, { triggers: [trigger()] }));
    selectWatch("w_1");
    await tick();
    expect(sent(0)).toEqual({ type: "loop.watch.get", id: "r", watchId: "w_1" });
    expect(watchesState().detail?.triggers).toHaveLength(1);

    clientRequestMock.mockResolvedValue(snap({ enabled: false }));
    expect(await setWatchEnabled("w_1", false)).toBe(true);
    expect(sent(1)).toEqual({ type: "loop.watch.update", id: "r", watchId: "w_1", enabled: false });
    expect(watchesState().detail).toMatchObject({ watch: { enabled: false }, triggers: [{ key: trigger().key }] });
  });

  it("a forbidden read clears what was shown and stops the background watch", async () => {
    vi.useFakeTimers();
    clientRequestMock.mockResolvedValue(list([watch()]));
    watchWatches();
    await vi.advanceTimersByTimeAsync(0);
    clientRequestMock.mockRejectedValue({ error: "Missing scope: session:send", code: "forbidden" });
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS);
    expect(watchesState()).toMatchObject({ watches: [], error: "Missing scope: session:send" });
    const calls = clientRequestMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS * 3);
    expect(clientRequestMock).toHaveBeenCalledTimes(calls);
  });

  it("a new connection starts empty", async () => {
    clientRequestMock.mockResolvedValue(snap({}, { triggers: [trigger()] }));
    selectWatch("w_1");
    await tick();
    clientRef.current = { request: vi.fn().mockResolvedValue(list([])) };
    await fetchWatches();
    expect(watchesState()).toMatchObject({ watches: [], detail: null, selectedId: null, lastPoll: null });
  });
});

describe("watches store — controls", () => {
  it("poll now keeps what it started and skipped for that watch", async () => {
    clientRequestMock.mockResolvedValueOnce(snap({}, { triggers: [] }));
    selectWatch("w_1");
    await tick();
    clientRequestMock.mockResolvedValue(snap({}, { triggers: [trigger()], poll: { started: ["loop_9"], skipped: ["main: not vouched for yet"] } }));
    expect(await pollWatch("w_1")).toBe(true);
    expect(sent(1)).toEqual({ type: "loop.watch.poll", id: "r", watchId: "w_1" });
    expect(watchesState().lastPoll).toEqual({ watchId: "w_1", started: ["loop_9"], skipped: ["main: not vouched for yet"] });
    // Another watch's view doesn't carry it.
    clientRequestMock.mockResolvedValue(snap({ id: "w_2" }));
    selectWatch("w_2");
    expect(watchesState().lastPoll).toBeNull();
  });

  it("a refused control keeps the daemon's words", async () => {
    clientRequestMock.mockRejectedValue(new Error("A delegated token cannot create, change, enable, or poll a loop watch"));
    expect(await pollWatch("w_1")).toBe(false);
    expect(watchesState().error).toBe("A delegated token cannot create, change, enable, or poll a loop watch");
    expect(watchesState().busy).toBe(false);
  });

  it("delete removes it and leaves its detail", async () => {
    clientRequestMock.mockResolvedValueOnce(snap());
    selectWatch("w_1");
    await tick();
    clientRequestMock.mockResolvedValueOnce({ type: "response.ok", requestId: "r", data: { deleted: "w_1" } });
    expect(await deleteWatch("w_1")).toBe(true);
    expect(sent(1)).toEqual({ type: "loop.watch.delete", id: "r", watchId: "w_1" });
    expect(watchesState()).toMatchObject({ watches: [], selectedId: null, detail: null });
  });

  it("create selects the new watch", async () => {
    clientRequestMock.mockResolvedValue(snap({ id: "w_new" }, { triggers: [] }));
    const body = { type: "loop.watch.create" as const, spec: { workdir: "/src/shop", myPrs: true, ci: [{ ciName: "t", command: "x" }] } };
    await createWatch(body);
    expect(sent(0)).toEqual({ ...body, id: "r" });
    expect(watchesState().selectedId).toBe("w_new");
    expect(watchesState().detail?.watch.id).toBe("w_new");
  });

  it("update sends the trust list and a vouch, and rejects with the daemon's words", async () => {
    clientRequestMock.mockResolvedValue(snap({ trust: [] }));
    await updateWatch("w_1", { spec: { trust: [] }, trustHead: { main: "0123456789ab" } });
    expect(sent(0)).toEqual({ type: "loop.watch.update", id: "r", watchId: "w_1", spec: { trust: [] }, trustHead: { main: "0123456789ab" } });

    clientRequestMock.mockRejectedValue(new Error("main's head is 0123456789ab now, not fedcba987654: it moved, so nothing was vouched for; look at it again"));
    await expect(updateWatch("w_1", { trustHead: { main: "fedcba987654" } })).rejects.toThrow("it moved");
  });
});

describe("watches store — polling", () => {
  beforeEach(() => vi.useFakeTimers());

  it("polls while open and stops on close", async () => {
    clientRequestMock.mockResolvedValue(list([]));
    openWatches();
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    closeWatches();
    await vi.advanceTimersByTimeAsync(VIEW_POLL_MS * 5);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
  });

  it("opening on a watch reads that watch", async () => {
    clientRequestMock.mockResolvedValue(snap());
    openWatches("w_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent(0)).toEqual({ type: "loop.watch.get", id: "r", watchId: "w_1" });
  });
});
