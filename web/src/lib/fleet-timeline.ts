/**
 * The dispatch timeline — what was dispatched when, and what came back
 * (conductor-frontends-design §4).
 *
 * §4 lists this as a secondary lens over the same nodes the state-grouped list
 * shows: "a dispatch timeline for retrospection: what was dispatched when, what
 * it returned, where it blocked". The lanes answer *what needs me now*; this
 * answers *what happened*, which is a different question and badly served by a
 * list that re-sorts itself by urgency.
 *
 * Built from the two streams the board already carries — tasks and events —
 * with no new wire data.
 *
 * Pure functions: interleaving two streams and deciding what survives is the
 * decision worth testing, and it needs no reactive root.
 */

import type { FleetEventWire, FleetTaskWire, SessionInfo } from "../protocol/types";

export type TimelineKind = "dispatched" | "done" | "blocked" | "failed" | "event";

export interface TimelineEntry {
  /** Stable across rebuilds, so a keyed list does not thrash. */
  key: string;
  at: number;
  taskId: string;
  kind: TimelineKind;
  /** Short subject — "spawn scout", "task_done". */
  label: string;
  detail: string | null;
}

/**
 * Readable target for a dispatch row: the session name when it still exists,
 * else a short id, else nothing.
 */
function targetLabel(task: FleetTaskWire, session: SessionInfo | null): string | null {
  if (session) return session.name;
  const id = task.targetSession ?? task.workerSessionId;
  return id ? id.slice(0, 8) : null;
}

/** Map a dispatch event type onto the timeline's vocabulary. */
function kindOfEvent(type: string): TimelineKind {
  switch (type) {
    case "task_done":
      return "done";
    case "task_blocked":
      return "blocked";
    case "task_failed":
      return "failed";
    default:
      // An event type this client has not heard of still belongs on the
      // timeline — dropping history because a newer daemon named something
      // differently is the one thing a retrospective view must not do.
      return "event";
  }
}

/**
 * Interleave dispatches and outcomes into one newest-first stream.
 *
 * Newest-first matches every other list on this rail (the board sends tasks and
 * events that way, and the lanes read that way), so switching lenses does not
 * invert the reading order under the user.
 *
 * Events are kept even when their task is no longer on the board. The board is
 * capped, so a long-running fleet ages tasks out while their events remain —
 * and "the digest for a task I can no longer see" is still the most useful
 * thing on a retrospective timeline. Such an entry keeps its task id so it can
 * still be correlated by eye.
 */
export function buildTimeline(
  tasks: readonly FleetTaskWire[],
  events: readonly FleetEventWire[],
  sessionFor: (task: FleetTaskWire) => SessionInfo | null = () => null,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const t of tasks) {
    entries.push({
      key: `dispatch:${t.id}`,
      at: t.createdAt,
      taskId: t.id,
      kind: "dispatched",
      label: `${t.kind} ${t.shape}`,
      // The target is what makes a dispatch row meaningful in retrospect;
      // without it every row reads "spawn scout".
      //
      // Prefer the session NAME. The raw id is a full UUID, which is noise in a
      // narrow rail and tells the reader nothing — and a finished task has no
      // session at all, since the dispatcher tears its worker down after the
      // digest. So an unresolvable id degrades to a short prefix that can still
      // be correlated by eye, rather than eating the row.
      detail: targetLabel(t, sessionFor(t)),
    });
  }

  for (const e of events) {
    entries.push({
      key: `event:${e.id}`,
      at: e.createdAt,
      taskId: e.taskId,
      kind: kindOfEvent(e.type),
      label: e.type,
      detail: e.digest,
    });
  }

  return entries.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    // A dispatch and its outcome routinely share a millisecond on a fast task.
    // The dispatch must still read as having come FIRST, which newest-first
    // means rendering it second.
    const rank = (k: TimelineKind) => (k === "dispatched" ? 1 : 0);
    const d = rank(a.kind) - rank(b.kind);
    if (d !== 0) return d;
    // Total and stable, so equal rows do not swap between renders.
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Group entries by calendar day, for date separators.
 *
 * Retrospection is the point of this lens, and a flat list of times with no
 * day boundaries is unreadable past the first screen.
 */
export interface TimelineDay {
  /** Local midnight for the day, as an epoch ms — the key and the sort anchor. */
  day: number;
  entries: TimelineEntry[];
}

/**
 * Days come back newest-first, one per calendar day, whatever order the input
 * is in. Grouping only CONSECUTIVE entries would print the same date twice for
 * input that is not already sorted, so this keys on the day instead of relying
 * on the caller. Within a day, entries keep their input order — `buildTimeline`
 * has already decided it, including the same-millisecond tie-break.
 */
export function groupByDay(entries: readonly TimelineEntry[]): TimelineDay[] {
  const byDay = new Map<number, TimelineEntry[]>();
  for (const entry of entries) {
    const d = new Date(entry.at);
    // LOCAL midnight, not UTC: the user is reading their own day boundaries,
    // and a UTC split puts an evening dispatch on "tomorrow" for anyone east
    // of the meridian.
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const bucket = byDay.get(day);
    if (bucket) bucket.push(entry);
    else byDay.set(day, [entry]);
  }
  return [...byDay]
    .map(([day, dayEntries]) => ({ day, entries: dayEntries }))
    .sort((a, b) => b.day - a.day);
}
