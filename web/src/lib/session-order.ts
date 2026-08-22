/**
 * Session-list ordering — attention bands, then recency.
 *
 * The list used to sort by `createdAt`, which is why it read as arbitrary: when
 * you made a session has nothing to do with whether it wants you now. The
 * operator's actual question, in order, is "who is blocked on me", "what is
 * running", "what did I just leave".
 *
 * Bands rather than one flat multi-key sort, for three reasons:
 *
 *   1. It is already this project's answer. conductor-frontends-design.md §4
 *      locks a state-grouped list (Needs you / Working / …) as the fleet view's
 *      primary, partly because it renders identically in Solid and ratatui. A
 *      second ordering vocabulary in the same client would be a bug in itself.
 *   2. It absorbs thrash. `thinking` and `tool_running` alternate several times
 *      a second; both are WORKING, so nothing moves. A flat sort keyed on status
 *      would jitter continuously.
 *   3. It makes movement legible. A row crossing under a NEEDS YOU header reads
 *      as a state change; the same row silently rising in a flat list reads as a
 *      glitch.
 *
 * Pure functions, no Solid — the ordering is the part worth testing, and the
 * tests shouldn't need a reactive root. Mirrors `lib/fleet.ts`.
 */

import type { SessionInfo, SessionStatus } from "../protocol/types";
import type { FleetGroup } from "./fleet";

/** Bands, most-urgent first. Numeric so comparisons are a subtraction. */
export const BAND = {
  NEEDS_YOU: 0,
  WORKING: 1,
  IDLE: 2,
} as const;

export type Band = (typeof BAND)[keyof typeof BAND];

export const BAND_LABEL: Record<Band, string> = {
  [BAND.NEEDS_YOU]: "Needs you",
  [BAND.WORKING]: "Working",
  [BAND.IDLE]: "Idle",
};

/**
 * Which band one session belongs to.
 *
 * `error` is deliberately NEEDS_YOU, not IDLE: a failed session is the other
 * thing that wants a human, and burying it under idle sessions is how a failure
 * goes unnoticed for an hour.
 */
export function bandOf(status: SessionStatus): Band {
  switch (status) {
    case "waiting_approval":
    case "error":
      return BAND.NEEDS_YOU;
    case "thinking":
    case "tool_running":
      return BAND.WORKING;
    default:
      return BAND.IDLE;
  }
}

/**
 * A fleet takes the most urgent band of anything in it.
 *
 * An orchestrator sits `idle` while its role-children work, so banding a fleet
 * by its lead alone would file a fleet whose child is blocked on an approval
 * under IDLE — the exact case the NEEDS YOU band exists to surface. The group is
 * one unit of work (see lib/fleet.ts) and bands as one.
 */
export function bandOfGroup(group: FleetGroup): Band {
  let band = bandOf(group.lead.status);
  for (const child of group.children) {
    const b = bandOf(child.status);
    if (b < band) band = b;
  }
  return band;
}

/**
 * Recency key. Falls back to `createdAt` when `lastActivityAt` is absent — a
 * daemon that predates the field would otherwise report every session as
 * epoch-0 and sink the entire list into reverse-arbitrary order, which is worse
 * than the behaviour being replaced.
 */
export function activityKey(s: SessionInfo): number {
  const raw = s.lastActivityAt ?? s.createdAt;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

/** Most recently active first. */
export function compareByRecency(a: SessionInfo, b: SessionInfo): number {
  return activityKey(b) - activityKey(a);
}

/**
 * A fleet's recency is the most recent activity anywhere in it — same reasoning
 * as the band: the unit of work is the group, and a fleet whose children are
 * busy is not stale just because its orchestrator is between turns.
 */
export function groupRecency(group: FleetGroup): number {
  let newest = activityKey(group.lead);
  for (const child of group.children) {
    const k = activityKey(child);
    if (k > newest) newest = k;
  }
  return newest;
}

export interface BandedSection<G extends FleetGroup = FleetGroup> {
  band: Band;
  label: string;
  groups: G[];
}

/**
 * Split groups into bands, recency-ordered within each, dropping empty bands.
 *
 * Stable by construction: `band` and `groupRecency` are both derived purely from
 * the input, so the same input always yields the same order — no dependence on
 * arrival order or object identity.
 */
export function bandSections<G extends FleetGroup>(groups: readonly G[]): BandedSection<G>[] {
  const byBand = new Map<Band, G[]>();
  for (const g of groups) {
    const band = bandOfGroup(g);
    const bucket = byBand.get(band);
    if (bucket) bucket.push(g);
    else byBand.set(band, [g]);
  }

  const sections: BandedSection<G>[] = [];
  for (const band of [BAND.NEEDS_YOU, BAND.WORKING, BAND.IDLE] as const) {
    const bucket = byBand.get(band);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => {
      const diff = groupRecency(b) - groupRecency(a);
      // Tie-break by id so two sessions created in the same millisecond — a
      // fleet's children, a scripted burst — have a fixed order instead of
      // swapping places on every re-render.
      return diff !== 0 ? diff : a.lead.id.localeCompare(b.lead.id);
    });
    sections.push({ band, label: BAND_LABEL[band], groups: bucket });
  }
  return sections;
}

/**
 * Where a group sat the last time ordering was allowed to change.
 * Built by {@link snapshotOrder}, consumed by {@link holdOrder}.
 */
export type OrderSnapshot = ReadonlyMap<string, { band: Band; index: number }>;

export function snapshotOrder<G extends FleetGroup>(
  sections: readonly BandedSection<G>[],
): OrderSnapshot {
  const snap = new Map<string, { band: Band; index: number }>();
  for (const s of sections) {
    s.groups.forEach((g, i) => snap.set(g.lead.id, { band: s.band, index: i }));
  }
  return snap;
}

/**
 * Re-project live groups onto a frozen layout — the anti-misclick guarantee.
 *
 * Rows move when sessions change state, which is the point; but a row moving
 * in the instant between aiming and clicking means opening the wrong session.
 * The sidebar therefore holds its layout while the pointer is over it and
 * applies the pending reorder on leave.
 *
 * Membership is NOT frozen, only order: a session that appeared is shown (in its
 * live band, appended), and one that was destroyed disappears. Freezing
 * membership too would leave a dead session clickable, trading a misclick for a
 * worse one.
 */
export function holdOrder<G extends FleetGroup>(
  sections: readonly BandedSection<G>[],
  snapshot: OrderSnapshot | null,
): BandedSection<G>[] {
  if (!snapshot || snapshot.size === 0) return sections as BandedSection<G>[];

  const held = new Map<Band, G[]>();
  const fresh: G[] = [];
  for (const section of sections) {
    for (const g of section.groups) {
      const prev = snapshot.get(g.lead.id);
      if (!prev) {
        fresh.push(g);
        continue;
      }
      const bucket = held.get(prev.band);
      if (bucket) bucket.push(g);
      else held.set(prev.band, [g]);
    }
  }
  for (const bucket of held.values()) {
    bucket.sort((a, b) => snapshot.get(a.lead.id)!.index - snapshot.get(b.lead.id)!.index);
  }
  // Newcomers go to the END of their LIVE band: they have no frozen position,
  // and appending is the one placement that cannot displace a row being aimed at.
  for (const g of fresh) {
    const band = bandOfGroup(g);
    const bucket = held.get(band);
    if (bucket) bucket.push(g);
    else held.set(band, [g]);
  }

  const out: BandedSection<G>[] = [];
  for (const band of [BAND.NEEDS_YOU, BAND.WORKING, BAND.IDLE] as const) {
    const bucket = held.get(band);
    if (bucket && bucket.length > 0) out.push({ band, label: BAND_LABEL[band], groups: bucket });
  }
  return out;
}
