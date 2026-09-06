/**
 * Fleet board slice — the conductor's task board, live.
 *
 * `fleet.subscribe` replies with a snapshot and then streams `fleet.update`
 * deltas (P5.0). Daemon-canonical like every other slice here: nothing is
 * derived locally, and a delta is applied verbatim rather than reconciled
 * against a guess.
 *
 * The reducers are exported as PURE functions and hold all the ordering and
 * bounding rules, so the part worth testing needs no reactive root — the same
 * split `lib/fleet.ts` uses for grouping. The signal layer below is a thin
 * shell over them.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId, send } from "./connection";
import type {
  FleetDelta,
  FleetEventWire,
  FleetSnapshot,
  FleetSnapshotResultMsg,
  FleetTaskWire,
  FleetUsage,
  SessionInfo,
} from "../protocol/types";

/**
 * Client-side caps, matching the daemon's own board page sizes
 * (`FLEET_TASK_LIMIT` / `FLEET_EVENT_LIMIT` in session-manager.ts).
 *
 * The snapshot is bounded, but the delta stream is not: a board left open for a
 * day would otherwise grow without limit, since every task transition and every
 * digest appends. Capping to the same window the daemon would have sent keeps a
 * long-lived board the same size as a freshly-subscribed one — which also means
 * a reconnect cannot silently change how much history is on screen.
 */
export const FLEET_TASK_LIMIT = 100;
export const FLEET_EVENT_LIMIT = 50;

export const EMPTY_USAGE: FleetUsage = {
  activeTasks: 0,
  blockedTasks: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalCostUsd: 0,
};

export interface FleetState {
  /** True between a successful subscribe and an explicit unsubscribe. */
  subscribed: boolean;
  loading: boolean;
  error: string | null;
  /** Absent when the tenant has no conductor — a valid, common state. */
  conductor: SessionInfo | null;
  /** Spawned workers AND existing sessions dispatched to. Join target for task ids. */
  workers: SessionInfo[];
  /** Newest first. */
  tasks: FleetTaskWire[];
  /** Newest first. */
  events: FleetEventWire[];
  agg: FleetUsage;
  /** Epoch ms of the last snapshot; 0 = never loaded. */
  fetchedAt: number;
}

export const EMPTY_FLEET: FleetState = {
  subscribed: false,
  loading: false,
  error: null,
  conductor: null,
  workers: [],
  tasks: [],
  events: [],
  agg: EMPTY_USAGE,
  fetchedAt: 0,
};

// ── pure reducers ────────────────────────────────────────────────────────────

/**
 * Insert or replace `row` in a list held in DESCENDING `key` order.
 *
 * Replace is IN PLACE: a task's `createdAt` never changes, so a status
 * transition must not make the row jump while you are looking at it. Insert
 * finds the position by key rather than unshifting, because "deltas arrive
 * newest-last" is an assumption about the network, not a guarantee — a
 * reconnect can replay, and a burst can interleave.
 */
function upsertDesc<T>(rows: readonly T[], row: T, id: (r: T) => string | number, key: (r: T) => number, cap: number): T[] {
  const rowId = id(row);
  const at = rows.findIndex((r) => id(r) === rowId);
  if (at >= 0) {
    const next = rows.slice();
    next[at] = row;
    return next;
  }
  const k = key(row);
  const insertAt = rows.findIndex((r) => key(r) < k);
  const next = rows.slice();
  next.splice(insertAt === -1 ? next.length : insertAt, 0, row);
  // Drop from the OLD end: the newest rows are the ones a board is for.
  return next.length > cap ? next.slice(0, cap) : next;
}

export function upsertTask(tasks: readonly FleetTaskWire[], task: FleetTaskWire): FleetTaskWire[] {
  return upsertDesc(tasks, task, (t) => t.id, (t) => t.createdAt, FLEET_TASK_LIMIT);
}

export function upsertEvent(events: readonly FleetEventWire[], event: FleetEventWire): FleetEventWire[] {
  // Keyed on the autoincrement id, not createdAt: several events routinely
  // land in the same millisecond (one dispatcher tick settling a group), and
  // ordering those by time would shuffle them arbitrarily between renders.
  return upsertDesc(events, event, (e) => e.id, (e) => e.id, FLEET_EVENT_LIMIT);
}

/** Fold one delta into the board. Pure — the whole ordering contract lives here. */
export function applyDelta(state: FleetState, delta: FleetDelta): FleetState {
  // `agg` rides on every delta and is a daemon-computed rollup, so it is
  // replaced wholesale rather than recomputed from the (capped) task list —
  // the counts must stay true even for tasks that have aged off this board.
  if (delta.kind === "task") {
    return { ...state, tasks: upsertTask(state.tasks, delta.task), agg: delta.agg };
  }
  return { ...state, events: upsertEvent(state.events, delta.event), agg: delta.agg };
}

/** Replace the board from a snapshot, trusting the daemon's ordering. */
export function applySnapshot(state: FleetState, fleet: FleetSnapshot, now: number): FleetState {
  return {
    ...state,
    loading: false,
    error: null,
    conductor: fleet.conductor ?? null,
    workers: fleet.workers,
    // Defensive slice: a future daemon that raises its page size must not
    // silently raise this client's memory ceiling too.
    tasks: fleet.tasks.slice(0, FLEET_TASK_LIMIT),
    events: fleet.events.slice(0, FLEET_EVENT_LIMIT),
    agg: fleet.agg,
    fetchedAt: now,
  };
}

/** The session a task points at, resolved against the board's own worker list. */
export function taskSession(state: FleetState, task: FleetTaskWire): SessionInfo | null {
  const id = task.workerSessionId ?? task.targetSession;
  if (!id) return null;
  return state.workers.find((w) => w.id === id) ?? null;
}

// ── signal layer ─────────────────────────────────────────────────────────────

const [state, setState] = createSignal<FleetState>(EMPTY_FLEET);

export const fleetBoard = state;

/**
 * Which subscription each async reply belongs to.
 *
 * Bumped on every subscribe and unsubscribe, and compared on arrival, so a
 * snapshot for a subscription the user has already left cannot overwrite a
 * newer board — the same guard `blackboard.ts` uses for its index fetch.
 */
let generation = 0;

/**
 * Subscribe to the tenant's board: snapshot now, deltas after.
 *
 * Safe to call when already subscribed — the daemon treats a second
 * `fleet.subscribe` as a re-snapshot, which is also how a reconnecting client
 * resynchronises after missing deltas.
 */
export async function subscribeFleet(): Promise<void> {
  const gen = ++generation;
  setState((s) => ({ ...s, loading: true, error: null }));
  try {
    const id = newRequestId();
    const result = await getClient().request<FleetSnapshotResultMsg>(
      { type: "fleet.subscribe", id, scope: "tenant" },
      {
        waitForResult: (m) =>
          m.type === "fleet.snapshot.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    );
    if (gen !== generation) return;
    setState((s) => ({ ...applySnapshot(s, result.fleet, Date.now()), subscribed: true }));
  } catch (err) {
    if (gen !== generation) return;
    setState((s) => ({ ...s, loading: false, subscribed: false, error: message(err) }));
  }
}

/**
 * Stop the delta stream.
 *
 * The board is deliberately KEPT. Leaving the conductor pane should not blank
 * what you just read, and the next subscribe re-snapshots anyway — clearing
 * here would only produce a flash of empty state on every visit.
 */
export function unsubscribeFleet(): void {
  generation++;
  if (!state().subscribed) return;
  send({ type: "fleet.unsubscribe", id: newRequestId() });
  setState((s) => ({ ...s, subscribed: false }));
}

/** Route a `fleet.update` broadcast into the board. */
export function ingestFleetDelta(delta: FleetDelta): void {
  // A delta arriving while unsubscribed is not an error: the daemon may still
  // have one in flight from just before the unsubscribe. Applying it is
  // harmless and keeps the retained board (see unsubscribeFleet) accurate.
  setState((s) => applyDelta(s, delta));
}

/** Drop everything — used on sign-out, where the next user's board must not inherit this one. */
export function resetFleet(): void {
  generation++;
  setState(EMPTY_FLEET);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
