/**
 * Loop runs (docs/loops.md) — the owner's runs, the one being looked at, and
 * the controls. Mirrors state/pipelines.ts: a module-singleton signal,
 * `getClient().request` with a typed `waitForResult`, and a `_reset*ForTest`
 * hook.
 *
 * There is no push for loops, so the view is kept current by polling:
 *
 *   - while the loops view is open, every {@link VIEW_POLL_MS} — the selected
 *     run's `loop.get`, or the list when none is selected;
 *   - while something watches for attention (the "Needs you" inbox), the list
 *     every {@link WATCH_POLL_MS}, so a run that starts waiting on you shows up
 *     without the view open.
 *
 * Neither ticks while the page is hidden. A daemon without loops, or a token
 * without the scopes, stops the background watch until a read succeeds again
 * (opening the view asks), rather than asking every half minute.
 *
 * Every control replies with a `loop.snapshot`; each reply replaces the run.
 * Errors are caught and kept as strings; nothing here throws except
 * `startLoop`, whose caller shows the daemon's words in its form.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  ClientMessage,
  LoopAttemptWire,
  LoopEventWire,
  LoopListResultMsg,
  LoopRunWire,
  LoopSnapshotMsg,
  LoopStartMsg,
} from "../protocol/types";

export interface LoopDetailState {
  run: LoopRunWire;
  attempts: LoopAttemptWire[];
  /** Present once the history has been asked for. */
  events: LoopEventWire[] | null;
}

interface LoopsState {
  runs: LoopRunWire[];
  /** A list reply has landed at least once. */
  loaded: boolean;
  /** The run the view shows; null = the list. */
  selectedId: string | null;
  detail: LoopDetailState | null;
  /** The history section is open, so reads include events. */
  historyOpen: boolean;
  /** A control (pause/resume/cancel/steer) is in flight. */
  busy: boolean;
  /** Last read or control error, verbatim from the daemon. */
  error: string | null;
}

const EMPTY: LoopsState = {
  runs: [],
  loaded: false,
  selectedId: null,
  detail: null,
  historyOpen: false,
  busy: false,
  error: null,
};

const [state, setState] = createSignal<LoopsState>(EMPTY);
const [viewOpen, setViewOpen] = createSignal(false);

export const loopsState = state;
/** The loops view (LoopsPanel) is showing. */
export const loopsViewOpen = viewOpen;

const READ_TIMEOUT_MS = 15_000;
/** Starting prepares a worktree and runs the checks once; give it room. */
const START_TIMEOUT_MS = 120_000;
export const VIEW_POLL_MS = 3_000;
export const WATCH_POLL_MS = 30_000;

/** A `response.error` rejection is the raw `{ error, code }`; a transport failure is an `Error`. */
function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "error" in e) {
    const m = (e as { error?: unknown }).error;
    if (typeof m === "string") return m;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Loops aren't usable on this connection at all: don't keep asking in the background. */
function isUnavailable(e: unknown): boolean {
  if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "forbidden") return true;
  return /not available/i.test(errMessage(e));
}

function snapshotOf(id: string) {
  return (m: { type: string; requestId?: string }) =>
    m.type === "loop.snapshot" && m.requestId === id ? (m as LoopSnapshotMsg) : undefined;
}

/** Put a run's latest state into the list (newest first for one not seen yet). */
function upsertRun(runs: LoopRunWire[], run: LoopRunWire): LoopRunWire[] {
  const i = runs.findIndex((r) => r.id === run.id);
  if (i === -1) return [run, ...runs];
  const next = runs.slice();
  next[i] = run;
  return next;
}

function applySnapshot(snap: LoopSnapshotMsg): void {
  setState((s) => {
    const runs = upsertRun(s.runs, snap.run);
    if (s.selectedId !== snap.run.id) return { ...s, runs };
    // A reply without events (a control, or a read with the history shut)
    // keeps what was shown rather than blanking it.
    const events = snap.events ?? s.detail?.events ?? null;
    return { ...s, runs, detail: { run: snap.run, attempts: snap.attempts, events }, error: null };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

let unavailable = false;
/** The connection the shown runs were read over; a new one starts empty. */
let readOver: object | null = null;

export async function fetchLoops(): Promise<void> {
  const id = newRequestId();
  const client = getClient();
  if (readOver !== null && readOver !== client) {
    setState((s) => ({ ...s, runs: [], detail: null, selectedId: null, loaded: false }));
  }
  readOver = client;
  try {
    const res = await client.request<LoopListResultMsg>(
      { type: "loop.list", id },
      {
        waitForResult: (m) => (m.type === "loop.list.result" && m.requestId === id ? m : undefined),
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    unavailable = false;
    setState((s) => ({ ...s, runs: res.runs, loaded: true, error: s.selectedId ? s.error : null }));
  } catch (e) {
    if (isUnavailable(e)) {
      unavailable = true;
      reschedule();
      // This identity can't see loops: nothing an earlier one could see stays up.
      setState((s) => ({ ...s, runs: [], detail: null, selectedId: null, loaded: true, error: errMessage(e) }));
      return;
    }
    setState((s) => ({ ...s, loaded: true, error: errMessage(e) }));
  }
}

export async function fetchLoop(runId: string): Promise<void> {
  const id = newRequestId();
  const events = state().historyOpen;
  try {
    const snap = await getClient().request<LoopSnapshotMsg>(
      { type: "loop.get", id, runId, ...(events ? { events: true } : {}) },
      { waitForResult: snapshotOf(id), timeoutMs: READ_TIMEOUT_MS },
    );
    applySnapshot(snap);
  } catch (e) {
    // A read for a run the user has since left must not paint its error over another.
    if (state().selectedId === runId) setState((s) => ({ ...s, error: errMessage(e) }));
  }
}

/** Show one run (null = back to the list), fetching it now. */
export function selectLoop(runId: string | null): void {
  setState((s) => ({
    ...s,
    selectedId: runId,
    // Keep the detail only when it is the same run (a re-select); otherwise
    // show the list's copy until the read lands.
    detail: runId && s.detail?.run.id === runId ? s.detail : null,
    historyOpen: runId && s.selectedId === runId ? s.historyOpen : false,
    error: null,
  }));
  if (runId) void fetchLoop(runId);
  else void fetchLoops();
}

/** Open or shut the history; opening fetches it. */
export function setLoopHistoryOpen(open: boolean): void {
  setState((s) => ({ ...s, historyOpen: open }));
  const id = state().selectedId;
  if (open && id) void fetchLoop(id);
}

// ── Controls ─────────────────────────────────────────────────────────────────

/** Controls in flight: cancel may overlap another, so `busy` is a count, not a flag. */
let inflight = 0;

async function control(build: (id: string) => ClientMessage): Promise<boolean> {
  const id = newRequestId();
  inflight += 1;
  setState((s) => ({ ...s, busy: true, error: null }));
  try {
    const snap = await getClient().request<LoopSnapshotMsg>(build(id), {
      waitForResult: snapshotOf(id),
      timeoutMs: READ_TIMEOUT_MS,
    });
    applySnapshot(snap);
    return true;
  } catch (e) {
    setState((s) => ({ ...s, error: errMessage(e) }));
    return false;
  } finally {
    inflight -= 1;
    setState((s) => ({ ...s, busy: inflight > 0 }));
  }
}

export function pauseLoop(runId: string): Promise<boolean> {
  return control((id) => ({ type: "loop.pause", id, runId }));
}

export function resumeLoop(runId: string): Promise<boolean> {
  return control((id) => ({ type: "loop.resume", id, runId }));
}

export function cancelLoop(runId: string): Promise<boolean> {
  return control((id) => ({ type: "loop.cancel", id, runId }));
}

/** Guidance for the next attempt, or the answer to the worker's question. */
export function steerLoop(runId: string, text: string): Promise<boolean> {
  return control((id) => ({ type: "loop.steer", id, runId, text }));
}

/**
 * Start a run and select it. Rejects with the daemon's message, verbatim, so
 * the start form can show it next to the inputs that caused it.
 */
export async function startLoop(body: Omit<LoopStartMsg, "id">): Promise<LoopRunWire> {
  const id = newRequestId();
  let snap: LoopSnapshotMsg;
  try {
    snap = await getClient().request<LoopSnapshotMsg>({ ...body, id }, { waitForResult: snapshotOf(id), timeoutMs: START_TIMEOUT_MS });
  } catch (e) {
    throw new Error(errMessage(e));
  }
  setState((s) => ({ ...s, selectedId: snap.run.id, detail: null, historyOpen: false, error: null }));
  applySnapshot(snap);
  return snap.run;
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
  if (viewOpen() && selected) void fetchLoop(selected);
  else void fetchLoops();
}

/** One timer, at the fastest cadence anything currently needs. */
function reschedule(): void {
  const ms = viewOpen() ? VIEW_POLL_MS : watchers > 0 && !unavailable ? WATCH_POLL_MS : null;
  if (ms === timerMs) return;
  if (timer !== null) clearInterval(timer);
  timer = ms === null ? null : setInterval(tick, ms);
  timerMs = ms;
}

/** Open the loops view, on a run's detail when `runId` is given. */
export function openLoops(runId?: string): void {
  setViewOpen(true);
  reschedule();
  if (runId) selectLoop(runId);
  else {
    setState((s) => ({ ...s, selectedId: null, detail: null, error: null }));
    void fetchLoops();
  }
}

export function closeLoops(): void {
  setViewOpen(false);
  reschedule();
}

/**
 * Keep the run list fresh in the background (for attention). Returns the
 * stop function; several watchers share one timer.
 */
export function watchLoops(): () => void {
  watchers++;
  reschedule();
  void fetchLoops();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers--;
    reschedule();
  };
}

/** Test-only: reset the singleton and stop polling. */
export function _resetLoopsForTest(): void {
  readOver = null;
  if (timer !== null) clearInterval(timer);
  timer = null;
  timerMs = null;
  watchers = 0;
  unavailable = false;
  setViewOpen(false);
  setState(EMPTY);
}
