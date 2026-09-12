/**
 * What a fleet dispatch is about to touch — repo, branch, target session.
 *
 * conductor-design R3 is the reason this exists: a send-class action to an
 * existing session "first proposes it with **repo + branch + content shown**,
 * and acts only on confirm". Silent misrouting is named there as the one
 * failure that would kill trust in the conductor, so the approval prompt has to
 * show the owner where the instruction is actually going — not just the tool's
 * own words for it.
 *
 * Pure: resolving a target name to a session is the decision worth testing.
 */

import type { FleetCard } from "./fleet-cards";
import type { SessionInfo } from "../protocol/types";

export interface DispatchTarget {
  /** The name the conductor used, exactly as it will be dispatched. */
  name: string;
  /** The session it resolves to, or null when nothing matches. */
  session: SessionInfo | null;
  /** Absolute workdir of the resolved session. */
  workdir: string | null;
  /** Worktree branch, when the session has one. */
  branch: string | null;
  /**
   * True when the name matched nothing this client can see.
   *
   * Surfaced rather than hidden: an unresolvable target is EXACTLY the case
   * where an owner is at risk of approving the wrong thing, and a prompt that
   * quietly shows no repo reads as "no repo involved" rather than "I could not
   * tell you". The daemon resolves names itself and may still succeed — the
   * client's view can legitimately be stale — so this is a warning, never a
   * reason to block the approval.
   */
  unresolved: boolean;
}

export interface DispatchPreview {
  /** `spawn` creates a new worker; `send` routes into sessions that already exist. */
  kind: "spawn" | "send";
  targets: DispatchTarget[];
  /** The instruction or brief being delivered, when the card carries one. */
  content: string | null;
}

/**
 * Resolve a session reference the way a human reading the prompt would.
 *
 * The conductor is told to name targets by NAME so the owner can verify the
 * repo at a glance, but its own tools also accept an id or id prefix — so all
 * three are matched here. An exact name wins over a prefix: two sessions can
 * share a prefix, and silently preferring the wrong one is the misrouting R3
 * exists to prevent.
 */
export function resolveTarget(
  ref: string,
  sessions: readonly SessionInfo[],
): SessionInfo | null {
  const exactName = sessions.find((s) => s.name === ref);
  if (exactName) return exactName;
  const exactId = sessions.find((s) => s.id === ref);
  if (exactId) return exactId;

  const byPrefix = sessions.filter((s) => s.id.startsWith(ref));
  // An ambiguous prefix resolves to NOTHING. Picking one would be a coin flip
  // presented as a fact, on the prompt whose job is to prevent exactly that.
  return byPrefix.length === 1 ? byPrefix[0]! : null;
}

function describe(name: string, sessions: readonly SessionInfo[]): DispatchTarget {
  const session = resolveTarget(name, sessions);
  return {
    name,
    session,
    workdir: session?.workdir ?? null,
    branch: session?.worktree?.branch ?? null,
    unresolved: session === null,
  };
}

/** Read a field off a card by label, or null. */
function field(card: FleetCard, label: string): string | null {
  return card.fields.find((f) => f.label === label)?.value ?? null;
}

/**
 * Build the preview for a send-class dispatch, or null when the card is not
 * one (a read verb has nothing to propose — it already ran).
 */
export function dispatchPreview(
  card: FleetCard,
  sessions: readonly SessionInfo[],
): DispatchPreview | null {
  if (!card.sendClass) return null;

  if (card.verb === "fleet_spawn") {
    // A spawn has no existing session to verify — the workdir IS the thing to
    // check, and it comes straight off the card.
    const workdir = field(card, "workdir");
    return {
      kind: "spawn",
      targets: [
        {
          name: field(card, "shape") ?? "worker",
          session: null,
          workdir,
          branch: null,
          // Not "unresolved": there is nothing to resolve yet, and flagging it
          // would cry wolf on every spawn.
          unresolved: false,
        },
      ],
      content: field(card, "task"),
    };
  }

  // send / interrupt / panel all route into sessions that already exist.
  const raw = field(card, "sessions") ?? field(card, "target");
  const names = raw
    ? raw
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
    : [];

  return {
    kind: "send",
    targets: names.map((n) => describe(n, sessions)),
    content: field(card, "message"),
  };
}

/** True when any target could not be resolved — drives the prompt's warning. */
export function hasUnresolved(preview: DispatchPreview): boolean {
  return preview.targets.some((t) => t.unresolved);
}
