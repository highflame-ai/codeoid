/**
 * The two top-level homes — Conductor and Sessions (conductor-frontends-design
 * §3.A) — and the rule for what each one focuses.
 *
 * §3 is the constraint the whole feature rests on: the conductor is a LENS over
 * the same sessions, never a wall. So this is a navigation preference, not a
 * mode — switching home changes which session you are looking at and nothing
 * else. Every session stays reachable from the list in both homes, and there is
 * no state a user can get stuck in.
 *
 * Pure functions: which session a home resolves to is the decision worth
 * testing, and it needs no reactive root.
 */

import type { SessionInfo } from "../protocol/types";

export type Home = "sessions" | "conductor";

/**
 * Default home for a user who has never chosen.
 *
 * Sessions, deliberately — even once a conductor exists. Silently relocating
 * someone's home the first time they spawn a conductor is exactly the "trapped
 * in an orchestrated mode" feeling §3 exists to prevent, and a user who wants
 * the conductor is one click (and one remembered preference) away.
 */
export const DEFAULT_HOME: Home = "sessions";

export function isHome(v: unknown): v is Home {
  return v === "sessions" || v === "conductor";
}

/** The tenant's conductor, or null when none has been created yet. */
export function findConductor(sessions: readonly SessionInfo[]): SessionInfo | null {
  return sessions.find((s) => s.role === "conductor") ?? null;
}

/**
 * Which session a home should focus.
 *
 * Returns null to mean "leave the focus alone" — a distinct outcome from "focus
 * nothing", and the right answer whenever the home has no better candidate than
 * whatever the user is already reading.
 *
 * `lastSessionId` is the session the user was on before switching to the
 * conductor, so switching back returns them to their work rather than to an
 * arbitrary first row. It is ignored when that session has since been
 * destroyed.
 */
export function homeTarget(
  sessions: readonly SessionInfo[],
  home: Home,
  currentId: string | null,
  lastSessionId: string | null,
): string | null {
  if (home === "conductor") {
    const conductor = findConductor(sessions);
    // No conductor yet is a normal state, not an error: the toggle offers to
    // create one, and until then the current session stays put.
    return conductor && conductor.id !== currentId ? conductor.id : null;
  }

  // Sessions home. Only act when the user is actually sitting on the conductor
  // — otherwise they are already somewhere in Sessions and moving them would be
  // the surprise this design is trying to avoid.
  const current = sessions.find((s) => s.id === currentId) ?? null;
  if (current?.role !== "conductor") return null;

  // Ordinary sessions only, on BOTH paths. Workers are disposable and die with
  // their task, so landing on one is landing somewhere about to disappear —
  // and a worker can legitimately be the last thing you looked at, having
  // drilled into it from the fleet rail.
  const isOrdinary = (s: SessionInfo): boolean => s.role === undefined;

  const remembered = lastSessionId
    ? (sessions.find((s) => s.id === lastSessionId) ?? null)
    : null;
  if (remembered && isOrdinary(remembered)) return remembered.id;

  // Nothing remembered, or it was destroyed, or it was a worker.
  return sessions.find(isOrdinary)?.id ?? null;
}
