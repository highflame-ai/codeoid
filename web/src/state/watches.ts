/**
 * Loop watches (docs/loops.md "Watches") — the owner's watches, the one being
 * looked at with the events it acted on, and the controls. Mirrors
 * state/loops.ts: a module-singleton signal, `getClient().request` with a
 * typed `waitForResult`, and a `_reset*ForTest` hook.
 *
 * Polled like loops: every {@link VIEW_POLL_MS} while the watches view is
 * open (the selected watch, or the list), every {@link WATCH_POLL_MS} while
 * the "Needs you" inbox watches for a failing poll, never while the page is
 * hidden, and not in the background once this connection can't see watches.
 * A new connection starts empty.
 *
 * Read and control errors are kept as strings; create, update (trust) and
 * vouch reject with the daemon's words, so their forms show them where they
 * were caused — the vouch dialog reads a moved head out of their `detail`.
 *
 * As in state/routines.ts, every request is numbered when it is sent and a
 * reply older than what is shown changes nothing: a list read sent before a
 * delete can't bring the watch back.
 */

import { createSignal } from "solid-js";

import { asRequestError, errMessage, isUnavailable } from "../lib/automation";
import { getClient, newRequestId } from "./connection";
import type {
  ClientMessage,
  LoopWatchCreateMsg,
  LoopWatchListResultMsg,
  LoopWatchSnapshotMsg,
  LoopWatchTriggerWire,
  LoopWatchUpdateMsg,
  LoopWatchWire,
} from "../protocol/types";

export interface WatchDetailState {
  watch: LoopWatchWire;
  /** Recent events it acted on, newest first. */
  triggers: LoopWatchTriggerWire[];
}

interface WatchesState {
  watches: LoopWatchWire[];
  loaded: boolean;
  selectedId: string | null;
  detail: WatchDetailState | null;
  /** The last "Poll now" result for the selected watch: what it started and skipped. */
  lastPoll: { watchId: string; started: string[]; skipped: string[] } | null;
  busy: boolean;
  error: string | null;
}

const EMPTY: WatchesState = { watches: [], loaded: false, selectedId: null, detail: null, lastPoll: null, busy: false, error: null };

const [state, setState] = createSignal<WatchesState>(EMPTY);
const [viewOpen, setViewOpen] = createSignal(false);

export const watchesState = state;
export const watchesViewOpen = viewOpen;

const READ_TIMEOUT_MS = 15_000;
/** Creating reads gh's login and the repo's origin; a vouch reads every head; a poll reads GitHub. */
const WRITE_TIMEOUT_MS = 90_000;
export const VIEW_POLL_MS = 3_000;
export const WATCH_POLL_MS = 30_000;

/** Loops are off, or this identity can't read watches (see state/routines.ts on matching words). */
const OFF = /not available|^Missing scope/i;

function upsert(list: LoopWatchWire[], w: LoopWatchWire): LoopWatchWire[] {
  const i = list.findIndex((x) => x.id === w.id);
  if (i === -1) return [w, ...list];
  const next = list.slice();
  next[i] = w;
  return next;
}

// ── Reply ordering ───────────────────────────────────────────────────────────

let seq = 0;
let listApplied = 0;
/** When the list was last asked for: the inbox reads it while a watch's detail is open too. */
let lastListAt = 0;
const snapApplied = new Map<string, number>();
const deletedAt = new Map<string, number>();

function applySnapshot(snap: LoopWatchSnapshotMsg, sent: number): void {
  const id = snap.watch.id;
  if ((deletedAt.get(id) ?? 0) > sent || (snapApplied.get(id) ?? 0) > sent) return;
  snapApplied.set(id, sent);
  setState((s) => {
    const watches = upsert(s.watches, snap.watch);
    const lastPoll = snap.poll ? { watchId: snap.watch.id, ...snap.poll } : s.lastPoll;
    if (s.selectedId !== snap.watch.id) return { ...s, watches, lastPoll };
    const triggers = snap.triggers ?? s.detail?.triggers ?? [];
    return { ...s, watches, lastPoll, detail: { watch: snap.watch, triggers }, error: null };
  });
}

function snapshotOf(id: string) {
  return (m: { type: string; requestId?: string }) =>
    m.type === "loop.watch.snapshot" && m.requestId === id ? (m as LoopWatchSnapshotMsg) : undefined;
}

// ── Connection ───────────────────────────────────────────────────────────────

let unavailable = false;
let readOver: object | null = null;

function client() {
  const c = getClient();
  if (readOver !== null && readOver !== c) {
    setState({ ...EMPTY });
    snapApplied.clear();
    deletedAt.clear();
  }
  readOver = c;
  return c;
}

function forget(e: unknown): void {
  unavailable = true;
  reschedule();
  setState((s) => ({ ...s, watches: [], detail: null, selectedId: null, lastPoll: null, loaded: true, error: errMessage(e) }));
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function fetchWatches(): Promise<void> {
  const id = newRequestId();
  const sent = ++seq;
  lastListAt = Date.now();
  try {
    const res = await client().request<LoopWatchListResultMsg>(
      { type: "loop.watch.list", id },
      {
        waitForResult: (m) => (m.type === "loop.watch.list.result" && m.requestId === id ? m : undefined),
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    unavailable = false;
    if (sent < listApplied) return;
    listApplied = sent;
    setState((s) => {
      const watches = res.watches
        .filter((w) => (deletedAt.get(w.id) ?? 0) <= sent)
        .map((w) => ((snapApplied.get(w.id) ?? 0) > sent ? (s.watches.find((x) => x.id === w.id) ?? w) : w));
      return { ...s, watches, loaded: true, error: s.selectedId ? s.error : null };
    });
  } catch (e) {
    if (isUnavailable(e, OFF)) return forget(e);
    setState((s) => ({ ...s, loaded: true, error: errMessage(e) }));
  }
}

export async function fetchWatch(watchId: string): Promise<void> {
  const id = newRequestId();
  const sent = ++seq;
  try {
    const snap = await client().request<LoopWatchSnapshotMsg>(
      { type: "loop.watch.get", id, watchId },
      { waitForResult: snapshotOf(id), timeoutMs: READ_TIMEOUT_MS },
    );
    applySnapshot(snap, sent);
  } catch (e) {
    if (isUnavailable(e, OFF)) return forget(e);
    if (state().selectedId === watchId) setState((s) => ({ ...s, error: errMessage(e) }));
  }
}

export function selectWatch(watchId: string | null): void {
  setState((s) => ({
    ...s,
    selectedId: watchId,
    detail: watchId && s.detail?.watch.id === watchId ? s.detail : null,
    lastPoll: watchId && s.lastPoll?.watchId === watchId ? s.lastPoll : null,
    error: null,
  }));
  if (watchId) void fetchWatch(watchId);
  else void fetchWatches();
}

// ── Controls ─────────────────────────────────────────────────────────────────

let inflight = 0;

async function control(build: (id: string) => ClientMessage): Promise<boolean> {
  const id = newRequestId();
  const sent = ++seq;
  inflight += 1;
  setState((s) => ({ ...s, busy: true, error: null }));
  try {
    const snap = await client().request<LoopWatchSnapshotMsg>(build(id), { waitForResult: snapshotOf(id), timeoutMs: WRITE_TIMEOUT_MS });
    applySnapshot(snap, sent);
    return true;
  } catch (e) {
    setState((s) => ({ ...s, error: errMessage(e) }));
    return false;
  } finally {
    inflight -= 1;
    setState((s) => ({ ...s, busy: inflight > 0 }));
  }
}

/** Pause (a safety stop any credential that sees it may use) or resume (needs the owner's own token). */
export function setWatchEnabled(watchId: string, enabled: boolean): Promise<boolean> {
  return control((id) => ({ type: "loop.watch.update", id, watchId, enabled }));
}

export function pollWatch(watchId: string): Promise<boolean> {
  return control((id) => ({ type: "loop.watch.poll", id, watchId }));
}

export async function deleteWatch(watchId: string): Promise<boolean> {
  const sent = ++seq;
  inflight += 1;
  setState((s) => ({ ...s, busy: true, error: null }));
  try {
    await client().request({ type: "loop.watch.delete", id: newRequestId(), watchId }, { timeoutMs: WRITE_TIMEOUT_MS });
    deletedAt.set(watchId, sent);
    setState((s) => ({
      ...s,
      watches: s.watches.filter((w) => w.id !== watchId),
      ...(s.selectedId === watchId ? { selectedId: null, detail: null, lastPoll: null } : {}),
    }));
    return true;
  } catch (e) {
    setState((s) => ({ ...s, error: errMessage(e) }));
    return false;
  } finally {
    inflight -= 1;
    setState((s) => ({ ...s, busy: inflight > 0 }));
  }
}

// ── Form calls (reject with the daemon's words) ──────────────────────────────

/** Make a watch and select it. */
export async function createWatch(body: Omit<LoopWatchCreateMsg, "id">): Promise<LoopWatchWire> {
  const id = newRequestId();
  const sent = ++seq;
  let snap: LoopWatchSnapshotMsg;
  try {
    snap = await client().request<LoopWatchSnapshotMsg>({ ...body, id }, { waitForResult: snapshotOf(id), timeoutMs: WRITE_TIMEOUT_MS });
  } catch (e) {
    throw new Error(errMessage(e));
  }
  setState((s) => ({ ...s, selectedId: snap.watch.id, detail: null, lastPoll: null, error: null }));
  applySnapshot(snap, sent);
  return snap.watch;
}

/**
 * Change a watch — its trust list, or a vouch (`trustHead`). A vouch pinned
 * to a commit that moved is refused whole, and its error names the new head.
 */
export async function updateWatch(watchId: string, patch: Pick<LoopWatchUpdateMsg, "spec" | "trustHead" | "enabled">): Promise<LoopWatchWire> {
  const id = newRequestId();
  const sent = ++seq;
  try {
    const snap = await client().request<LoopWatchSnapshotMsg>(
      { type: "loop.watch.update", id, watchId, ...patch },
      { waitForResult: snapshotOf(id), timeoutMs: WRITE_TIMEOUT_MS },
    );
    applySnapshot(snap, sent);
    return snap.watch;
  } catch (e) {
    // The refusal's detail rides along: the vouch dialog re-pins from it.
    throw asRequestError(e);
  }
}

// ── Polling ──────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let timerMs: number | null = null;
let watchers = 0;

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function tick(): void {
  if (hidden()) return;
  const selected = state().selectedId;
  if (viewOpen() && selected) {
    void fetchWatch(selected);
    // The inbox reads the list: kept fresh at its own pace while a detail is open.
    if (watchers > 0 && Date.now() - lastListAt >= WATCH_POLL_MS) void fetchWatches();
  } else void fetchWatches();
}

function reschedule(): void {
  const ms = viewOpen() ? VIEW_POLL_MS : watchers > 0 && !unavailable ? WATCH_POLL_MS : null;
  if (ms === timerMs) return;
  if (timer !== null) clearInterval(timer);
  timer = ms === null ? null : setInterval(tick, ms);
  timerMs = ms;
}

export function openWatches(watchId?: string): void {
  setViewOpen(true);
  reschedule();
  if (watchId) selectWatch(watchId);
  else {
    setState((s) => ({ ...s, selectedId: null, detail: null, error: null }));
    void fetchWatches();
  }
}

export function closeWatches(): void {
  setViewOpen(false);
  reschedule();
}

export function watchWatches(): () => void {
  watchers++;
  reschedule();
  void fetchWatches();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers--;
    reschedule();
  };
}

/** Test-only: reset the singleton and stop polling. */
export function _resetWatchesForTest(): void {
  readOver = null;
  inflight = 0;
  seq = 0;
  listApplied = 0;
  lastListAt = 0;
  snapApplied.clear();
  deletedAt.clear();
  if (timer !== null) clearInterval(timer);
  timer = null;
  timerMs = null;
  watchers = 0;
  unavailable = false;
  setViewOpen(false);
  setState(EMPTY);
}
