/**
 * The cross-session attention queue — one ranked "Needs you" list
 * (conductor-frontends-design §8).
 *
 * Every blocking event across every agent, in one place: a session wedged on a
 * tool approval, a provider dialog waiting on an answer, a dispatch task that
 * hit the anti-spin limit. Without this the operator polls N sessions to find
 * the one that stopped; with it, the work comes to them.
 *
 * Pure functions — collection and ranking are the decisions worth testing, and
 * they need no reactive root.
 */

import type { FleetTaskWire, SessionInfo, SessionUiRequestMsg } from "../protocol/types";

export type AttentionKind = "question" | "approval" | "blocked" | "failed";

export interface AttentionItem {
  /** Stable across re-collection, so a list keyed on it does not thrash. */
  key: string;
  kind: AttentionKind;
  /** The session to open. Null for a task whose session is gone or not yet spawned. */
  sessionId: string | null;
  /** What to show as the row's subject — a session name, or a task id. */
  label: string;
  detail: string;
  /** Epoch ms this started blocking. See `sinceFor` on why it is approximate. */
  since: number;
}

/**
 * Blocking cost per kind — the multiplier in §8's (blocking-cost × staleness).
 *
 * A `question` or `approval` has stopped a LIVE agent mid-turn: the work is
 * paid for, in flight, and going nowhere until a human answers. A `blocked`
 * task is stopped too but is not burning anything and will never self-clear.
 * A `failed` task ranks lowest because it is the one kind that can still
 * resolve without you — it retries with backoff (§6).
 */
const COST: Record<AttentionKind, number> = {
  question: 3,
  approval: 3,
  blocked: 2,
  failed: 1,
};

/**
 * Floor added to every item's age before scoring, in ms.
 *
 * Without it a brand-new item scores zero regardless of kind, so the queue
 * would rank purely by age for the first moments of anything's life — exactly
 * when a live wedged agent most needs to be at the top. Thirty seconds means
 * kind dominates early and staleness takes over as things sit, which is the
 * behaviour §8 describes ("an agent stuck 8 minutes on a yes/no floats to the
 * top").
 */
const AGE_FLOOR_MS = 30_000;

/** §8's (blocking-cost × staleness). Higher is more urgent. */
export function attentionScore(item: AttentionItem, now: number): number {
  const age = Math.max(0, now - item.since);
  return COST[item.kind] * (age + AGE_FLOOR_MS);
}

export interface AttentionSources {
  sessions: readonly SessionInfo[];
  /** Pending provider dialogs, keyed by session id. */
  uiRequests: Readonly<Record<string, readonly SessionUiRequestMsg[]>>;
  /** Fleet board tasks; only the stopped ones contribute. */
  tasks: readonly FleetTaskWire[];
  /** Resolve a task to its session, when it still has one. */
  taskSession: (task: FleetTaskWire) => SessionInfo | null;
}

/**
 * When an item started blocking.
 *
 * Approximate, and worth being honest about: neither a `ui_request` nor a
 * `FleetTaskWire` carries the moment it began waiting. A session's
 * `lastActivityAt` is the closest true signal — a wedged session stops
 * producing activity the instant it wedges — and a task falls back to its
 * creation time. Both err toward looking OLDER than reality for a task that
 * ran a while before stopping, which biases the queue toward surfacing things
 * rather than hiding them. That is the right direction for this list.
 */
function sinceFor(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

/**
 * Gather every blocking item across the whole session population.
 *
 * `now` is the fallback timestamp for anything with no usable time, so an item
 * with unknown age reads as brand new rather than as infinitely stale — an
 * unknown must not jump the queue.
 */
export function collectAttention(src: AttentionSources, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  const byId = new Map(src.sessions.map((s) => [s.id, s]));

  // Provider dialogs first: they name their own question, so they carry more
  // information than the session status that accompanies them.
  const asked = new Set<string>();
  for (const [sessionId, reqs] of Object.entries(src.uiRequests)) {
    for (const req of reqs) {
      const session = byId.get(sessionId);
      // A request for a session this client cannot see is not actionable —
      // clicking it would go nowhere — so it is skipped rather than shown.
      if (!session) continue;
      asked.add(sessionId);
      items.push({
        key: `ui:${sessionId}:${req.requestId}`,
        kind: "question",
        sessionId,
        label: session.name,
        detail: req.title,
        since: sinceFor(session.lastActivityAt, now),
      });
    }
  }

  // Sessions wedged on a tool approval. Skipped when a dialog is already
  // listed for that session: they are the same stoppage, and showing both
  // would double-count one interruption in a queue whose whole job is to say
  // how many things need you.
  for (const s of src.sessions) {
    if (s.status !== "waiting_approval" || asked.has(s.id)) continue;
    items.push({
      key: `approval:${s.id}`,
      kind: "approval",
      sessionId: s.id,
      label: s.name,
      detail: "waiting for tool approval",
      since: sinceFor(s.lastActivityAt, now),
    });
  }

  // Stopped dispatch tasks.
  for (const task of src.tasks) {
    if (task.status !== "blocked" && task.status !== "failed") continue;
    const session = src.taskSession(task);
    items.push({
      key: `task:${task.id}`,
      kind: task.status,
      sessionId: session?.id ?? null,
      label: session?.name ?? `${task.kind} ${task.id.slice(0, 8)}`,
      detail: task.error ?? (task.status === "blocked" ? "hit the failure limit" : "task failed"),
      since: task.createdAt,
    });
  }

  return items;
}

/**
 * Rank most-urgent first.
 *
 * Ties break on `since` (oldest first) and then on `key`, so the order is
 * total and stable: a queue that reshuffles equal-priority rows between
 * renders is one you cannot click accurately.
 */
export function rankAttention(items: readonly AttentionItem[], now: number): AttentionItem[] {
  return [...items].sort((a, b) => {
    const d = attentionScore(b, now) - attentionScore(a, now);
    if (d !== 0) return d;
    if (a.since !== b.since) return a.since - b.since;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** Everything in one call — collect, then rank. */
export function attentionQueue(src: AttentionSources, now: number): AttentionItem[] {
  return rankAttention(collectAttention(src, now), now);
}
