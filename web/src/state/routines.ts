/**
 * Routines (docs/routines.md) — the owner's routines, the one being looked
 * at with its recent runs, and the controls. Mirrors state/loops.ts: a
 * module-singleton signal, `getClient().request` with a typed
 * `waitForResult`, and a `_reset*ForTest` hook.
 *
 * There is no push for routines, so the view is kept current by polling:
 *
 *   - while the routines view is open, every {@link VIEW_POLL_MS} — the
 *     selected routine's `routine.get`, or the list when none is selected;
 *   - while something watches for attention (the "Needs you" inbox), the list
 *     every {@link WATCH_POLL_MS}, so a run that failed shows up without the
 *     view open.
 *
 * Neither ticks while the page is hidden. A daemon with routines off, or a
 * token without the scopes, stops the background watch until a read succeeds
 * again (opening the view asks), rather than asking every half minute. What a
 * connection read is never shown over another: a new connection starts empty.
 *
 * Errors are caught and kept as strings; the form calls (create, update,
 * preview, token) reject with the daemon's words instead, so the form can
 * show them next to the inputs that caused them.
 */

import { createSignal } from "solid-js";

import { errMessage, isUnavailable } from "../lib/automation";
import { getClient, newRequestId } from "./connection";
import type {
  ClientMessage,
  RoutineListResultMsg,
  RoutinePreviewResultMsg,
  RoutineRunResultMsg,
  RoutineRunWire,
  RoutineScheduleWire,
  RoutineSnapshotMsg,
  RoutineSpecWire,
  RoutineTokenResultMsg,
  RoutineUpdateMsg,
  RoutineWire,
} from "../protocol/types";

export interface RoutineDetailState {
  routine: RoutineWire;
  runs: RoutineRunWire[];
}

interface RoutinesState {
  routines: RoutineWire[];
  /** A list reply has landed at least once. */
  loaded: boolean;
  /** The routine the view shows (its id); null = the list. */
  selectedId: string | null;
  detail: RoutineDetailState | null;
  /** Controls in flight (pause/resume/run/cancel/delete). */
  busy: boolean;
  /** Last read or control error, verbatim from the daemon. */
  error: string | null;
}

const EMPTY: RoutinesState = { routines: [], loaded: false, selectedId: null, detail: null, busy: false, error: null };

const [state, setState] = createSignal<RoutinesState>(EMPTY);
const [viewOpen, setViewOpen] = createSignal(false);

export const routinesState = state;
/** The routines view is showing. */
export const routinesViewOpen = viewOpen;

const READ_TIMEOUT_MS = 15_000;
/** Saving validates the workdir and backend; a run's first step is queuing. */
const WRITE_TIMEOUT_MS = 30_000;
export const VIEW_POLL_MS = 3_000;
export const WATCH_POLL_MS = 30_000;
/** Runs shown in a routine's detail. */
export const DETAIL_RUNS = 10;

/**
 * Routines are off on this daemon, or this identity can't hold them. The
 * client rejects a `response.error` as an `Error` with only its text, so the
 * read's refusal ("Missing scope: …") is recognised by its words as well as
 * by `code` when it is there.
 */
const OFF = /routines are disabled|not available|^Missing scope/i;

function upsert(list: RoutineWire[], r: RoutineWire): RoutineWire[] {
  const i = list.findIndex((x) => x.id === r.id);
  if (i === -1) return [r, ...list];
  const next = list.slice();
  next[i] = r;
  return next;
}

function applySnapshot(snap: RoutineSnapshotMsg): void {
  setState((s) => {
    const routines = upsert(s.routines, snap.routine);
    if (s.selectedId !== snap.routine.id) return { ...s, routines };
    // A reply without runs (an update) keeps the runs shown.
    const runs = snap.runs ?? s.detail?.runs ?? [];
    return { ...s, routines, detail: { routine: snap.routine, runs }, error: null };
  });
}

function snapshotOf(id: string) {
  return (m: { type: string; requestId?: string }) =>
    m.type === "routine.snapshot" && m.requestId === id ? (m as RoutineSnapshotMsg) : undefined;
}

// ── Connection ───────────────────────────────────────────────────────────────

let unavailable = false;
/** The connection what is shown was read over; a new one starts empty. */
let readOver: object | null = null;

/** The client to read over, dropping everything an earlier connection read. */
function client() {
  const c = getClient();
  if (readOver !== null && readOver !== c) setState({ ...EMPTY });
  readOver = c;
  return c;
}

/** Nothing an identity that can't see routines may keep on screen. */
function forget(e: unknown): void {
  unavailable = true;
  reschedule();
  setState((s) => ({ ...s, routines: [], detail: null, selectedId: null, loaded: true, error: errMessage(e) }));
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function fetchRoutines(): Promise<void> {
  const id = newRequestId();
  try {
    const res = await client().request<RoutineListResultMsg>(
      { type: "routine.list", id },
      {
        waitForResult: (m) => (m.type === "routine.list.result" && m.requestId === id ? m : undefined),
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    unavailable = false;
    setState((s) => {
      // A routine deleted elsewhere leaves the detail too.
      const gone = s.selectedId !== null && !res.routines.some((r) => r.id === s.selectedId);
      return { ...s, routines: res.routines, loaded: true, error: s.selectedId && !gone ? s.error : null };
    });
  } catch (e) {
    if (isUnavailable(e, OFF)) return forget(e);
    setState((s) => ({ ...s, loaded: true, error: errMessage(e) }));
  }
}

export async function fetchRoutine(routineId: string): Promise<void> {
  const id = newRequestId();
  try {
    const snap = await client().request<RoutineSnapshotMsg>(
      { type: "routine.get", id, routine: routineId, runs: DETAIL_RUNS },
      { waitForResult: snapshotOf(id), timeoutMs: READ_TIMEOUT_MS },
    );
    applySnapshot(snap);
  } catch (e) {
    if (isUnavailable(e, OFF)) return forget(e);
    // A read for a routine the user has since left must not paint its error over another.
    if (state().selectedId === routineId) setState((s) => ({ ...s, error: errMessage(e) }));
  }
}

/** Show one routine (null = back to the list), fetching it now. */
export function selectRoutine(routineId: string | null): void {
  setState((s) => ({
    ...s,
    selectedId: routineId,
    detail: routineId && s.detail?.routine.id === routineId ? s.detail : null,
    error: null,
  }));
  if (routineId) void fetchRoutine(routineId);
  else void fetchRoutines();
}

// ── Controls ─────────────────────────────────────────────────────────────────

let inflight = 0;

async function control<T>(run: () => Promise<T>): Promise<T | null> {
  inflight += 1;
  setState((s) => ({ ...s, busy: true, error: null }));
  try {
    return await run();
  } catch (e) {
    setState((s) => ({ ...s, error: errMessage(e) }));
    return null;
  } finally {
    inflight -= 1;
    setState((s) => ({ ...s, busy: inflight > 0 }));
  }
}

async function snapshotRequest(build: (id: string) => ClientMessage, timeoutMs = WRITE_TIMEOUT_MS): Promise<RoutineSnapshotMsg> {
  const id = newRequestId();
  const snap = await client().request<RoutineSnapshotMsg>(build(id), { waitForResult: snapshotOf(id), timeoutMs });
  applySnapshot(snap);
  return snap;
}

/** Pause (a safety stop: needs no approval scope) or resume. */
export async function setRoutineEnabled(routineId: string, enabled: boolean): Promise<boolean> {
  const ok = await control(() => snapshotRequest((id) => ({ type: "routine.update", id, routine: routineId, enabled })));
  return ok !== null;
}

/** Fire now. Resolves the queued run (or null, with the daemon's words in `error`). */
export async function runRoutineNow(routineId: string, payload?: string): Promise<RoutineRunWire | null> {
  const run = await control(async () => {
    const id = newRequestId();
    const res = await client().request<RoutineRunResultMsg>(
      { type: "routine.run", id, routine: routineId, ...(payload ? { payload } : {}) },
      {
        waitForResult: (m) => (m.type === "routine.run.result" && m.requestId === id ? (m as RoutineRunResultMsg) : undefined),
        timeoutMs: WRITE_TIMEOUT_MS,
      },
    );
    return res.run;
  });
  if (run) {
    // Show the queued run at once; the next read brings its progress.
    setState((s) =>
      s.detail?.routine.id === routineId
        ? { ...s, detail: { ...s.detail, runs: [run, ...s.detail.runs.filter((r) => r.id !== run.id)] } }
        : s,
    );
    void fetchRoutine(routineId);
  }
  return run;
}

export async function cancelRoutineRun(routineId: string, runId: string): Promise<boolean> {
  const ok = await control(() => client().request({ type: "routine.cancel_run", id: newRequestId(), runId }, { timeoutMs: WRITE_TIMEOUT_MS }));
  if (ok !== null) void fetchRoutine(routineId);
  return ok !== null;
}

export async function deleteRoutine(routineId: string): Promise<boolean> {
  const ok = await control(() => client().request({ type: "routine.delete", id: newRequestId(), routine: routineId }, { timeoutMs: WRITE_TIMEOUT_MS }));
  if (ok === null) return false;
  setState((s) => ({
    ...s,
    routines: s.routines.filter((r) => r.id !== routineId),
    ...(s.selectedId === routineId ? { selectedId: null, detail: null } : {}),
  }));
  return true;
}

// ── Form calls (reject with the daemon's words) ──────────────────────────────

/** Save a new routine and select it. `apiToken` is set when its API is on: shown once. */
export async function createRoutine(spec: RoutineSpecWire): Promise<{ routine: RoutineWire; apiToken?: string }> {
  try {
    const snap = await snapshotRequest((id) => ({ type: "routine.create", id, spec }));
    setState((s) => ({ ...s, selectedId: snap.routine.id, detail: { routine: snap.routine, runs: [] }, error: null }));
    return { routine: snap.routine, ...(snap.apiToken ? { apiToken: snap.apiToken } : {}) };
  } catch (e) {
    throw new Error(errMessage(e));
  }
}

export async function updateRoutine(
  routineId: string,
  spec: NonNullable<RoutineUpdateMsg["spec"]>,
): Promise<{ routine: RoutineWire; apiToken?: string }> {
  try {
    const snap = await snapshotRequest((id) => ({ type: "routine.update", id, routine: routineId, spec }));
    return { routine: snap.routine, ...(snap.apiToken ? { apiToken: snap.apiToken } : {}) };
  } catch (e) {
    throw new Error(errMessage(e));
  }
}

/** A new API token; the old one stops working at once. Shown once. */
export async function rotateRoutineToken(routineId: string): Promise<{ apiToken: string; endpointPath: string }> {
  const id = newRequestId();
  try {
    const res = await client().request<RoutineTokenResultMsg>(
      { type: "routine.token", id, routine: routineId },
      {
        waitForResult: (m) => (m.type === "routine.token.result" && m.requestId === id ? (m as RoutineTokenResultMsg) : undefined),
        timeoutMs: WRITE_TIMEOUT_MS,
      },
    );
    return { apiToken: res.apiToken, endpointPath: res.endpointPath };
  } catch (e) {
    throw new Error(errMessage(e));
  }
}

/** Validate a schedule and list its next fires, saving nothing. Rejects with the daemon's reason. */
export async function previewSchedule(schedule: RoutineScheduleWire, count = 3): Promise<string[]> {
  const id = newRequestId();
  try {
    const res = await client().request<RoutinePreviewResultMsg>(
      { type: "routine.preview", id, schedule, count },
      {
        waitForResult: (m) => (m.type === "routine.preview.result" && m.requestId === id ? (m as RoutinePreviewResultMsg) : undefined),
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    return res.fires;
  } catch (e) {
    throw new Error(errMessage(e));
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
  if (viewOpen() && selected) void fetchRoutine(selected);
  else void fetchRoutines();
}

function reschedule(): void {
  const ms = viewOpen() ? VIEW_POLL_MS : watchers > 0 && !unavailable ? WATCH_POLL_MS : null;
  if (ms === timerMs) return;
  if (timer !== null) clearInterval(timer);
  timer = ms === null ? null : setInterval(tick, ms);
  timerMs = ms;
}

/** Open the routines view, on a routine's detail when `routineId` is given. */
export function openRoutines(routineId?: string): void {
  setViewOpen(true);
  reschedule();
  if (routineId) selectRoutine(routineId);
  else {
    setState((s) => ({ ...s, selectedId: null, detail: null, error: null }));
    void fetchRoutines();
  }
}

export function closeRoutines(): void {
  setViewOpen(false);
  reschedule();
}

/** Keep the list fresh in the background (for attention). Returns the stop function. */
export function watchRoutines(): () => void {
  watchers++;
  reschedule();
  void fetchRoutines();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers--;
    reschedule();
  };
}

/** Test-only: reset the singleton and stop polling. */
export function _resetRoutinesForTest(): void {
  readOver = null;
  inflight = 0;
  if (timer !== null) clearInterval(timer);
  timer = null;
  timerMs = null;
  watchers = 0;
  unavailable = false;
  setViewOpen(false);
  setState(EMPTY);
}
