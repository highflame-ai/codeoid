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
 * An ordinary coding session — one you own and drive, as opposed to the
 * conductor or a disposable dispatch worker. The only kind this module will
 * ever move focus TO.
 *
 * Tested as "has no role" rather than "is not conductor and not worker", and
 * the difference is a fail-safe, not a style choice. `SessionInfo.role` is
 * documented as *"Absent = normal session"*, and the protocol deliberately
 * anticipates roles this client has not heard of — `session.create` types its
 * role as an open string precisely "so a future role from a newer client still
 * type-checks on the wire".
 *
 * So the two forms differ exactly when a new role appears:
 *
 *   role === undefined            → an unknown role is NOT ordinary  (excluded)
 *   role !== "conductor" && ...   → an unknown role IS ordinary      (included)
 *
 * The second reads as more explicit and is the more dangerous of the two: it
 * silently opts every future session kind into being a landing target. Since
 * the whole reason workers are excluded is "do not send someone to a session
 * that is about to disappear", inheriting that risk for kinds we know nothing
 * about is the wrong default. An unknown role stays excluded until somebody
 * deliberately adds it here.
 */
export function isOrdinarySession(s: SessionInfo): boolean {
  return s.role === undefined;
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

  // Ordinary sessions only, on BOTH paths — see isOrdinarySession. Workers are
  // disposable and die with their task, so landing on one is landing somewhere
  // about to disappear, and a worker can legitimately be the last thing you
  // looked at, having drilled into it from the fleet rail.
  const remembered = lastSessionId
    ? (sessions.find((s) => s.id === lastSessionId) ?? null)
    : null;
  if (remembered && isOrdinarySession(remembered)) return remembered.id;

  // Nothing remembered, or it was destroyed, or it was not an ordinary session.
  return sessions.find(isOrdinarySession)?.id ?? null;
}
