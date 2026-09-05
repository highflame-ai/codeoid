/**
 * Fleet grouping — turning a flat session list into orchestrator + role-children.
 *
 * A collaborative session (docs/collaborative-session-design.md) is really N+1
 * sessions: the orchestrator the user created, and one long-lived role-child per
 * role binding. The daemon already tells us how they relate — the parent carries
 * `collaboration`, each child carries `collaborationRole` — but a flat list
 * renders them as N+1 unrelated sessions, which is exactly the wrong mental
 * model for something whose whole point is that it's ONE unit of work.
 *
 * Pure functions, no Solid: grouping is the part worth testing, and the tests
 * shouldn't need a reactive root to run.
 */

import type { SessionInfo } from "../protocol/types";

/**
 * One top-level row in the session list, plus whatever hangs under it.
 *
 * A standalone session is a group of one — the list is uniformly groups, so the
 * renderer never branches on "is this a fleet" to decide its outer shape.
 */
export interface FleetGroup {
  /** The orchestrator, the conductor, or the standalone session. */
  lead: SessionInfo;
  /**
   * Sessions rendered beneath `lead` — a collaboration's role-children
   * (role-then-ordinal ordered) or the conductor's dispatch workers (oldest
   * first). Empty unless a fleet or a conductor.
   */
  children: SessionInfo[];
  /**
   * True when `lead` orchestrates a collaboration. Distinct from
   * `children.length > 0`: between create and spawn a fleet legitimately has
   * zero children, and it should still render as a fleet rather than blinking
   * from plain session to fleet a second later.
   */
  isFleet: boolean;
  /**
   * True when `lead` is the tenant's conductor. Same reasoning as `isFleet`:
   * a conductor with nothing dispatched is still a conductor, and must not
   * render as a plain session until its first worker appears.
   *
   * Kept separate from `isFleet` rather than folded into one "has children"
   * flag because the two group KINDS differ in what their children are: a
   * collaboration's role-children are long-lived sessions you drive, while
   * dispatch workers are disposable and die with their task.
   */
  isConductor: boolean;
}

/**
 * Group sessions into fleets, preserving the caller's ordering for leads.
 *
 * Orphan children — `parentSessionId` names a session that isn't in the list —
 * are promoted to their own top-level group rather than dropped. The parent can
 * be legitimately absent (destroyed while children drain, or not yet delivered
 * to this client), and a session that silently disappears from the sidebar is a
 * far worse failure than one rendered without its group.
 */
export function groupFleet(sessions: readonly SessionInfo[]): FleetGroup[] {
  const present = new Set(sessions.map((s) => s.id));
  const childrenByParent = new Map<string, SessionInfo[]>();

  // The tenant's conductor, when this client can see it. Dispatch workers
  // carry no parent pointer — the conductor→worker link lives in the dispatch
  // queue, not on SessionInfo — but there is exactly one conductor per tenant
  // (the daemon enforces the singleton), so it is an unambiguous parent.
  const conductor = sessions.find((s) => s.role === "conductor");

  const parentOf = (s: SessionInfo): string | undefined => {
    const collab = s.collaborationRole?.parentSessionId;
    if (collab) return collab;
    // A worker never nests under itself, and a conductor is never a worker.
    if (s.role === "worker" && conductor && conductor.id !== s.id) return conductor.id;
    return undefined;
  };

  for (const s of sessions) {
    const parentId = parentOf(s);
    // A child whose parent is missing is treated as a lead below, so only
    // bucket the ones that actually have somewhere to go.
    if (!parentId || !present.has(parentId)) continue;
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(s);
    else childrenByParent.set(parentId, [s]);
  }

  const groups: FleetGroup[] = [];
  for (const s of sessions) {
    const parentId = parentOf(s);
    if (parentId && present.has(parentId)) continue; // rendered under its parent
    const children = childrenByParent.get(s.id) ?? [];
    children.sort(compareChildren);
    groups.push({
      lead: s,
      children,
      isFleet: Boolean(s.collaboration),
      isConductor: s.role === "conductor",
    });
  }
  return groups;
}

/**
 * Children order: role name, then fan-out ordinal. Deliberately NOT createdAt —
 * `review` ×3 spawn within milliseconds of each other, so creation order is
 * effectively arbitrary and the list would reshuffle between renders.
 */
function compareChildren(a: SessionInfo, b: SessionInfo): number {
  const ra = a.collaborationRole;
  const rb = b.collaborationRole;
  if (ra && rb) {
    if (ra.roleName !== rb.roleName) return ra.roleName < rb.roleName ? -1 : 1;
    return ra.ordinal - rb.ordinal;
  }
  // Dispatch workers have no role/ordinal. Oldest first, so a worker keeps its
  // place as siblings come and go — workers are disposable and a list that
  // reorders itself while you read it is worse than a stale-looking one. Name
  // breaks ties, since several workers can be spawned in the same millisecond.
  if (!ra && !rb) {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }
  // Mixed (a collaboration child beside a dispatch worker) cannot happen today
  // — a session is one or the other — but order them deterministically rather
  // than leaving it to sort stability if it ever does.
  return ra ? -1 : 1;
}

/**
 * Apply the sidebar's name/workdir filter across a grouped list.
 *
 * Matching is per-session, but visibility is per-group, and the two directions
 * differ on purpose:
 *
 * - lead matches   → keep the whole group. You searched for the fleet; you want
 *                    the fleet, not a fleet with its members hidden.
 * - child matches  → keep the lead as context, with only the matching children.
 *                    Showing a bare `search#1` row with no indication of which
 *                    goal it belongs to is worse than not filtering at all.
 *
 * A lead kept only as context is reported via `leadMatched: false` so the
 * renderer can de-emphasise it instead of implying it matched the query.
 */
export interface FilteredFleetGroup extends FleetGroup {
  /** False when the lead is present only to give matching children a parent. */
  leadMatched: boolean;
}

export function filterFleet(
  groups: readonly FleetGroup[],
  query: string,
): FilteredFleetGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.map((g) => ({ ...g, leadMatched: true }));

  const out: FilteredFleetGroup[] = [];
  for (const g of groups) {
    const leadMatched = matchesSession(g.lead, q);
    if (leadMatched) {
      out.push({ ...g, leadMatched: true });
      continue;
    }
    const children = g.children.filter((c) => matchesSession(c, q));
    if (children.length > 0) out.push({ ...g, children, leadMatched: false });
  }
  return out;
}

/** Name, workdir, role name, or the session role ("conductor" / a worker's shape). */
function matchesSession(s: SessionInfo, lowercaseQuery: string): boolean {
  if (s.name.toLowerCase().includes(lowercaseQuery)) return true;
  if (s.workdir.toLowerCase().includes(lowercaseQuery)) return true;
  const role = s.collaborationRole?.roleName;
  if (role !== undefined && role.includes(lowercaseQuery)) return true;
  // "conductor" / "worker" / "scout" / "ship" are how you'd actually search
  // for these rows — the name alone only carries the shape by convention.
  if (s.role !== undefined && s.role.includes(lowercaseQuery)) return true;
  const shape = workerShape(s);
  return shape !== null && shape.includes(lowercaseQuery);
}

/** How many sessions a filtered group puts on screen — for the header count. */
export function countVisible(groups: readonly FleetGroup[]): number {
  let n = 0;
  for (const g of groups) n += 1 + g.children.length;
  return n;
}

/**
 * Display label for a role-child: `search` for a singleton, `review#2` for a
 * member of a fan-out. Mirrors the blackboard's own slot naming
 * (`RoleBlackboard#ownSlot`), so a `findings` slot in the artifact panel reads
 * the same as the session that wrote it.
 */
export function roleLabel(s: SessionInfo): string | null {
  const r = s.collaborationRole;
  if (r) return r.ordinal > 1 ? `${r.roleName}#${r.ordinal}` : r.roleName;
  const w = parseWorkerName(s);
  if (!w) return null;
  // `worker-scout-c0234348` → `scout·c0234348`. The task-id tail is what lets
  // you match a row against a `fleet_tasks` entry, so it earns its width.
  return w.task ? `${w.shape}·${w.task}` : w.shape;
}

/** The daemon's dispatch-worker naming: `worker-<shape>-<task>`. */
const WORKER_PREFIX = "worker-";
const WORKER_SHAPES = ["ship", "scout"] as const;

export type WorkerShape = (typeof WORKER_SHAPES)[number];

/**
 * Split a dispatch worker's name into its shape and task id, or null when this
 * is not a worker.
 *
 * ONE place owns the `worker-<shape>-<task>` format. It was briefly split
 * across `workerShape` (matching the prefix) and `roleLabel` (re-deriving the
 * same prefix to slice the tail), which meant a change to the daemon's naming
 * had two call sites to find and only one of them would fail loudly.
 *
 * Parsed from the name rather than read from a wire field because
 * `SessionInfo` carries no shape: the ship/scout contract lives on the
 * dispatch task, which the session list does not join against.
 *
 * The `role === "worker"` guard is the security-relevant part and belongs
 * HERE, not at the call sites — a user is free to name a session
 * `worker-ship-anything`, and only the daemon sets the role. Callers therefore
 * cannot opt out of the check by forgetting it.
 */
function parseWorkerName(
  s: SessionInfo,
): { shape: WorkerShape; task: string } | null {
  if (s.role !== "worker") return null;
  for (const shape of WORKER_SHAPES) {
    const prefix = `${WORKER_PREFIX}${shape}-`;
    if (s.name.startsWith(prefix)) {
      return { shape, task: s.name.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * A dispatch worker's shape, or null when this is not a worker.
 * Thin accessor over {@link parseWorkerName} — see it for the guard rationale.
 */
export function workerShape(s: SessionInfo): WorkerShape | null {
  return parseWorkerName(s)?.shape ?? null;
}
