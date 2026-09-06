/**
 * The fleet's status vocabulary and its state-grouped lanes.
 *
 * conductor-frontends-design §4 makes a state-grouped list the primary fleet
 * view — the operator's real job is triage ("who needs me, what is ready to
 * read, what is still running"), and a list grouped by lifecycle answers that
 * faster than a graph. §6 defines the vocabulary that grouping rests on.
 *
 * Pure functions, no Solid: the classification IS the design decision here, so
 * it belongs somewhere a test can reach without a reactive root — the same
 * split `lib/fleet.ts` and `state/fleet.ts` already use.
 */

import type { FleetTaskWire, SessionInfo, SessionStatus } from "../protocol/types";

/**
 * One node's state, derived from dispatch status × session status (§6).
 *
 * Two entries are load-bearing and most tools get them wrong:
 *
 * - `awaiting` **outranks** `working`. A node that needs a human must never
 *   hide behind one that is merely busy, so it is checked first and sorts
 *   first. This is the whole reason the vocabulary is ranked rather than a
 *   plain enum.
 * - `disconnected` is **not** `failed`. A runner dropping is a transport
 *   event, not a task error; rendering it red would train the operator to
 *   ignore red.
 */
export type FleetNodeState =
  | "awaiting"
  | "blocked"
  | "failed"
  | "working"
  | "queued"
  | "disconnected"
  | "done"
  | "idle";

/**
 * Attention rank — lower sorts first. Attention outranks activity, which is
 * why `awaiting` leads and `done` trails.
 */
const RANK: Record<FleetNodeState, number> = {
  awaiting: 0,
  blocked: 1,
  failed: 2,
  working: 3,
  queued: 4,
  disconnected: 5,
  done: 6,
  idle: 7,
};

export function stateRank(s: FleetNodeState): number {
  return RANK[s];
}

/** Session statuses that mean "this agent's turn is actually in flight". */
const BUSY: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["thinking", "tool_running"]);

/**
 * Classify one task, given the session it points at (null when the task has no
 * session yet, or its session is gone).
 *
 * Order matters and encodes §6's ranking rather than the task's own lifecycle:
 * a session sitting at `waiting_approval` is `awaiting` even while its task
 * still reads `running`, because the dispatch status describes the QUEUE and
 * the session status describes the AGENT — and it is the agent that is stuck
 * on a human.
 */
export function nodeState(task: FleetTaskWire, session: SessionInfo | null): FleetNodeState {
  // Needs a human — checked before anything else, including terminal states, so
  // a task whose worker is wedged on an approval cannot be filed under "done"
  // by a status that has not caught up yet.
  if (session?.status === "waiting_approval") return "awaiting";

  switch (task.status) {
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "done":
      return "done";
    case "queued":
      return "queued";
    case "claimed":
    case "running": {
      if (session === null) {
        // Claimed or running with no session to point at. For a spawn that has
        // not created its worker yet this is simply the gap between claim and
        // spawn; for one whose worker has gone it is a dropped runner. Either
        // way it is NOT a failure — the task is alive in the queue and the
        // dispatcher will reconcile it.
        return task.workerSessionId ? "disconnected" : "queued";
      }
      if (session.status === "error") return "failed";
      return BUSY.has(session.status) ? "working" : "idle";
    }
  }
}

/** The four triage lanes of §4, in display order. */
export type FleetLane = "needs-you" | "working" | "review" | "done";

export const LANE_ORDER: readonly FleetLane[] = ["needs-you", "working", "review", "done"];

export const LANE_LABEL: Record<FleetLane, string> = {
  "needs-you": "Needs you",
  working: "Working",
  review: "Ready to review",
  done: "Done",
};

/**
 * Which lane a node belongs in.
 *
 * "Ready to review" is deliberately narrow: a finished task that produced a
 * digest, i.e. one with something for a human to actually read. A `done` task
 * with no digest is settled and goes to Done. §4 envisages this lane eventually
 * carrying worktree diffs and sequenced merge (P5.4); until then, promising a
 * review lane that holds nothing readable would be worse than not having one.
 */
export function laneFor(state: FleetNodeState, task: FleetTaskWire): FleetLane {
  switch (state) {
    case "awaiting":
    case "blocked":
    case "failed":
      return "needs-you";
    case "working":
    case "queued":
    case "disconnected":
      return "working";
    case "done":
      return task.resultDigest ? "review" : "done";
    case "idle":
      // A live task whose agent is quiet: still in flight from the queue's
      // point of view, so it stays under Working rather than looking finished.
      return "working";
  }
}

export interface FleetNode {
  task: FleetTaskWire;
  session: SessionInfo | null;
  state: FleetNodeState;
}

export interface FleetLaneGroup {
  lane: FleetLane;
  label: string;
  nodes: FleetNode[];
}

/**
 * Group tasks into the triage lanes, attention-first within each.
 *
 * Empty lanes are omitted: four permanent headers on a fleet with one running
 * task is chrome, not information.
 */
export function groupIntoLanes(
  tasks: readonly FleetTaskWire[],
  sessionFor: (task: FleetTaskWire) => SessionInfo | null,
): FleetLaneGroup[] {
  const byLane = new Map<FleetLane, FleetNode[]>();

  for (const task of tasks) {
    const session = sessionFor(task);
    const state = nodeState(task, session);
    const lane = laneFor(state, task);
    const node: FleetNode = { task, session, state };
    const bucket = byLane.get(lane);
    if (bucket) bucket.push(node);
    else byLane.set(lane, [node]);
  }

  const out: FleetLaneGroup[] = [];
  for (const lane of LANE_ORDER) {
    const nodes = byLane.get(lane);
    if (!nodes || nodes.length === 0) continue;
    // Attention first, then newest — the caller's list is already newest-first,
    // so a stable sort on rank alone preserves that as the tiebreak.
    nodes.sort((a, b) => stateRank(a.state) - stateRank(b.state));
    out.push({ lane, label: LANE_LABEL[lane], nodes });
  }
  return out;
}

/**
 * How many nodes are waiting on a human — the count worth surfacing ambiently
 * (§8). Blocked and failed are included: both are stopped and neither clears
 * itself.
 */
export function needsYouCount(groups: readonly FleetLaneGroup[]): number {
  return groups.find((g) => g.lane === "needs-you")?.nodes.length ?? 0;
}
