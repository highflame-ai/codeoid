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
 * again (opening the view asks), rather than asking every half minute. What
 * one identity read is never shown to another: the moment the identity
 * changes (or signs out) the store is emptied, and a reply to a request sent
 * before then changes nothing ({@link setRoutinesIdentity}). A reconnect as
 * the same identity keeps everything.
 *
 * Errors are caught and kept as strings; the form calls (create, update,
 * preview, token) reject with the daemon's words instead, so the form can
 * show them next to the inputs that caused them.
 *
 * Replies can land out of order (a slow list read behind a delete). Every
 * request is numbered when it is sent, and a reply older than what is shown
 * changes nothing: a list read sent before a delete can't bring the routine
 * back, and an older read can't undo a newer snapshot of one routine.
 *
 * An API token the daemon hands over is shown once, held here rather than in
 * a component, so it goes with everything else when the identity changes or
 * signs out — and only to the identity that asked for it: one that arrives
 * after a change of identity is not shown.
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
  /** An API token just handed over, shown once (with its routine and endpoint). */
  token: { routineId: string; apiToken: string; endpointPath: string } | null;
}

const EMPTY: RoutinesState = { routines: [], loaded: false, selectedId: null, detail: null, busy: false, error: null, token: null };

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

/** A reply that arrived after the identity changed: nothing in it is shown. */
const IDENTITY_CHANGED = "You signed in as someone else while this was saved, so its result (and any API token) isn't shown here.";
const ROTATED_FOR_ANOTHER =
  "You signed in as someone else while the token was rotated, so the new token isn't shown here. The old one no longer works: rotate again to get one.";

function upsert(list: RoutineWire[], r: RoutineWire): RoutineWire[] {
  const i = list.findIndex((x) => x.id === r.id);
  if (i === -1) return [r, ...list];
  const next = list.slice();
  next[i] = r;
  return next;
}

// ── Reply ordering ───────────────────────────────────────────────────────────

/** Numbers requests as they are sent. */
let seq = 0;
/** The newest list read applied. */
let listApplied = 0;
/** When the list was last asked for: the inbox reads it while a routine's detail is open too. */
let lastListAt = 0;
/** Per routine: the newest snapshot applied. */
const snapApplied = new Map<string, number>();
/** Per routine: the request that deleted it — a reply sent before then can't bring it back. */
const deletedAt = new Map<string, number>();

/** Requests sent at or before this were asked as an earlier identity: their replies change nothing. */
let resetAt = 0;
/** Bumped when the identity changes: what was asked under an earlier one is dropped. */
let generation = 0;

function stale(routineId: string, sent: number): boolean {
  return sent <= resetAt || (deletedAt.get(routineId) ?? 0) > sent || (snapApplied.get(routineId) ?? 0) > sent;
}

function applySnapshot(snap: RoutineSnapshotMsg, sent: number): void {
  if (stale(snap.routine.id, sent)) return;
  snapApplied.set(snap.routine.id, sent);
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
/** Who the store reads as (identityKey); null = nobody signed in. */
let identity: string | null = null;

function client() {
  return getClient();
}

/**
 * The identity this client acts as changed, or signed out (null): everything
 * shown — the routines, the detail, a token shown once — goes now, and a
 * reply to a request sent before now changes nothing. The same identity again
 * (a reconnect) keeps it all.
 */
export function setRoutinesIdentity(key: string | null): void {
  if (key === identity) return;
  identity = key;
  resetAt = seq;
  generation += 1;
  inflight = 0;
  unavailable = false;
  snapApplied.clear();
  deletedAt.clear();
  setState({ ...EMPTY });
  reschedule();
  if (key !== null && (viewOpen() || watchers > 0)) void fetchRoutines();
}

/** Nothing an identity that can't see routines may keep on screen. */
function forget(e: unknown): void {
  unavailable = true;
  reschedule();
  setState((s) => ({ ...s, routines: [], detail: null, selectedId: null, loaded: true, error: errMessage(e), token: null }));
}

/** Put away a token shown once. */
export function forgetRoutineToken(): void {
  if (state().token) setState((s) => ({ ...s, token: null }));
}

/** Which identity the store holds now: pass it back to {@link revealRoutineToken}. */
export function routinesGeneration(): number {
  return generation;
}

/**
 * Show a token the daemon just handed over (once) — only when the request
 * that got it was asked as the identity signed in now (`askedIn`, the
 * {@link routinesGeneration} when it was sent). Says whether it was shown.
 */
export function revealRoutineToken(token: NonNullable<RoutinesState["token"]>, askedIn: number = generation): boolean {
  if (askedIn !== generation) return false;
  setState((s) => ({ ...s, token }));
  return true;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function fetchRoutines(): Promise<void> {
  const id = newRequestId();
  const sent = ++seq;
  lastListAt = Date.now();
  try {
    const res = await client().request<RoutineListResultMsg>(
      { type: "routine.list", id },
      {
        waitForResult: (m) => (m.type === "routine.list.result" && m.requestId === id ? m : undefined),
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    // Asked as an earlier identity, or a newer list already landed: nothing new.
    if (sent <= resetAt) return;
    unavailable = false;
    if (sent < listApplied) return;
    listApplied = sent;
    setState((s) => {
      // Not one deleted since this was sent; a routine with a newer snapshot keeps it.
      const routines = res.routines
        .filter((r) => (deletedAt.get(r.id) ?? 0) <= sent)
        .map((r) => ((snapApplied.get(r.id) ?? 0) > sent ? (s.routines.find((x) => x.id === r.id) ?? r) : r));
      // A routine deleted elsewhere leaves the detail too.
      const gone = s.selectedId !== null && !routines.some((r) => r.id === s.selectedId);
      return { ...s, routines, loaded: true, error: s.selectedId && !gone ? s.error : null };
    });
  } catch (e) {
    if (sent <= resetAt) return;
    if (isUnavailable(e, OFF)) return forget(e);
    setState((s) => ({ ...s, loaded: true, error: errMessage(e) }));
  }
}

export async function fetchRoutine(routineId: string): Promise<void> {
  const id = newRequestId();
  const sent = ++seq;
  try {
    const snap = await client().request<RoutineSnapshotMsg>(
      { type: "routine.get", id, routine: routineId, runs: DETAIL_RUNS },
      { waitForResult: snapshotOf(id), timeoutMs: READ_TIMEOUT_MS },
    );
    applySnapshot(snap, sent);
  } catch (e) {
    if (sent <= resetAt) return;
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
  const asked = generation;
  inflight += 1;
  setState((s) => ({ ...s, busy: true, error: null }));
  try {
    const out = await run();
    return asked === generation ? out : null;
  } catch (e) {
    if (asked === generation) setState((s) => ({ ...s, error: errMessage(e) }));
    return null;
  } finally {
    // A reset already zeroed the count this one was part of.
    if (asked === generation) {
      inflight -= 1;
      setState((s) => ({ ...s, busy: inflight > 0 }));
    }
  }
}

async function snapshotRequest(build: (id: string) => ClientMessage, timeoutMs = WRITE_TIMEOUT_MS): Promise<RoutineSnapshotMsg> {
  const id = newRequestId();
  const sent = ++seq;
  const snap = await client().request<RoutineSnapshotMsg>(build(id), { waitForResult: snapshotOf(id), timeoutMs });
  applySnapshot(snap, sent);
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
  const sent = ++seq;
  const ok = await control(() => client().request({ type: "routine.delete", id: newRequestId(), routine: routineId }, { timeoutMs: WRITE_TIMEOUT_MS }));
  if (ok === null) return false;
  // Any reply sent before the delete is about a routine that is gone.
  deletedAt.set(routineId, sent);
  setState((s) => ({
    ...s,
    routines: s.routines.filter((r) => r.id !== routineId),
    ...(s.selectedId === routineId ? { selectedId: null, detail: null } : {}),
    ...(s.token?.routineId === routineId ? { token: null } : {}),
  }));
  return true;
}

// ── Form calls (reject with the daemon's words) ──────────────────────────────

/** Hold a token the daemon handed over with a routine, for the identity that asked. */
function revealWith(routine: RoutineWire, apiToken: string | undefined, askedIn: number): void {
  if (apiToken) revealRoutineToken({ routineId: routine.id, apiToken, endpointPath: `/routines/${routine.id}/fire` }, askedIn);
}

/**
 * Save a new routine and select it. When its API is on, the token comes back
 * once (`apiToken`) and is held in the store to show.
 */
export async function createRoutine(spec: RoutineSpecWire): Promise<{ routine: RoutineWire; apiToken?: string }> {
  const asked = generation;
  try {
    const snap = await snapshotRequest((id) => ({ type: "routine.create", id, spec }));
    if (asked !== generation) throw new Error(IDENTITY_CHANGED);
    setState((s) => ({ ...s, selectedId: snap.routine.id, detail: { routine: snap.routine, runs: [] }, error: null }));
    revealWith(snap.routine, snap.apiToken, asked);
    return { routine: snap.routine, ...(snap.apiToken ? { apiToken: snap.apiToken } : {}) };
  } catch (e) {
    throw new Error(errMessage(e));
  }
}

export async function updateRoutine(
  routineId: string,
  spec: NonNullable<RoutineUpdateMsg["spec"]>,
): Promise<{ routine: RoutineWire; apiToken?: string }> {
  const asked = generation;
  try {
    const snap = await snapshotRequest((id) => ({ type: "routine.update", id, routine: routineId, spec }));
    if (asked !== generation) throw new Error(IDENTITY_CHANGED);
    revealWith(snap.routine, snap.apiToken, asked);
    return { routine: snap.routine, ...(snap.apiToken ? { apiToken: snap.apiToken } : {}) };
  } catch (e) {
    throw new Error(errMessage(e));
  }
}

/**
 * A new API token; the old one stops working at once. Held in the store to
 * show once — unless the identity changed while it was asked for: then it is
 * not shown here, and this rejects saying so.
 */
export async function rotateRoutineToken(routineId: string): Promise<{ apiToken: string; endpointPath: string }> {
  const id = newRequestId();
  const asked = generation;
  let res: RoutineTokenResultMsg;
  try {
    res = await client().request<RoutineTokenResultMsg>(
      { type: "routine.token", id, routine: routineId },
      {
        waitForResult: (m) => (m.type === "routine.token.result" && m.requestId === id ? (m as RoutineTokenResultMsg) : undefined),
        timeoutMs: WRITE_TIMEOUT_MS,
      },
    );
  } catch (e) {
    throw new Error(errMessage(e));
  }
  if (!revealRoutineToken({ routineId, apiToken: res.apiToken, endpointPath: res.endpointPath }, asked)) throw new Error(ROTATED_FOR_ANOTHER);
  return { apiToken: res.apiToken, endpointPath: res.endpointPath };
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
  if (viewOpen() && selected) {
    void fetchRoutine(selected);
    // The detail reads one routine; the "Needs you" inbox reads the list,
    // which is kept fresh at its own pace meanwhile.
    if (watchers > 0 && Date.now() - lastListAt >= WATCH_POLL_MS) void fetchRoutines();
  } else void fetchRoutines();
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
  identity = null;
  resetAt = 0;
  generation = 0;
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
