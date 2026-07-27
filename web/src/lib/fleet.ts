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
  /** The orchestrator, or the standalone session. */
  lead: SessionInfo;
  /** Role-children of `lead`, role-then-ordinal ordered. Empty unless a fleet. */
  children: SessionInfo[];
  /**
   * True when `lead` orchestrates a collaboration. Distinct from
   * `children.length > 0`: between create and spawn a fleet legitimately has
   * zero children, and it should still render as a fleet rather than blinking
   * from plain session to fleet a second later.
   */
  isFleet: boolean;
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

  for (const s of sessions) {
    const parentId = s.collaborationRole?.parentSessionId;
    // A child whose parent is missing is treated as a lead below, so only
    // bucket the ones that actually have somewhere to go.
    if (!parentId || !present.has(parentId)) continue;
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(s);
    else childrenByParent.set(parentId, [s]);
  }

  const groups: FleetGroup[] = [];
  for (const s of sessions) {
    const parentId = s.collaborationRole?.parentSessionId;
    if (parentId && present.has(parentId)) continue; // rendered under its parent
    const children = childrenByParent.get(s.id) ?? [];
    children.sort(compareChildren);
    groups.push({ lead: s, children, isFleet: Boolean(s.collaboration) });
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
  if (!ra || !rb) return 0;
  if (ra.roleName !== rb.roleName) return ra.roleName < rb.roleName ? -1 : 1;
  return ra.ordinal - rb.ordinal;
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

/** Name, workdir, or — for a child — its role name. */
function matchesSession(s: SessionInfo, lowercaseQuery: string): boolean {
  if (s.name.toLowerCase().includes(lowercaseQuery)) return true;
  if (s.workdir.toLowerCase().includes(lowercaseQuery)) return true;
  const role = s.collaborationRole?.roleName;
  return role !== undefined && role.includes(lowercaseQuery);
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
  if (!r) return null;
  return r.ordinal > 1 ? `${r.roleName}#${r.ordinal}` : r.roleName;
}
