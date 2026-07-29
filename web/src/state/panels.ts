/**
 * Live panel state for the focused collaboration — the fan-out, while it runs.
 *
 * The gap this fills: a panel's whole point is that N agents work AT ONCE, and
 * the UI could show the fleet and the joined result but never the parallelism
 * itself. Verified live before this existed — two frontier models reviewed the
 * same file simultaneously on different backends and the UI rendered it as one
 * ordinary transcript message.
 *
 * Daemon-canonical like every other slice: `goalSessionId` comes from the RESULT,
 * never from the id we asked about, so focusing a child and focusing its
 * orchestrator converge on the same board.
 */

import { createMemo, createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  CollaborationPanel,
  CollaborationPanelsResultMsg,
} from "../protocol/types";

interface State {
  goalSessionId: string | null;
  panels: CollaborationPanel[];
  error: string | null;
  fetchedAt: number;
}

const EMPTY: State = { goalSessionId: null, panels: [], error: null, fetchedAt: 0 };

const [state, setState] = createSignal<State>(EMPTY);

export const panelState = state;

/** Drops a slow reply for a goal the user has already navigated away from. */
let inflight: string | null = null;

export async function fetchPanels(sessionId: string): Promise<void> {
  inflight = sessionId;
  try {
    const id = newRequestId();
    const result = await getClient().request<CollaborationPanelsResultMsg>(
      { type: "collaboration.panels", id, sessionId },
      {
        waitForResult: (m) =>
          m.type === "collaboration.panels.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    );
    if (inflight !== sessionId) return;
    setState({
      goalSessionId: result.sessionId,
      panels: result.panels,
      error: null,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    if (inflight !== sessionId) return;
    // Keep whatever we last showed. A transient failure mid-poll should not
    // blank a live "2 of 3" indicator and imply the panel vanished.
    setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Every fan-out currently in flight.
 *
 * PLURAL, because concurrent panels are legal: an orchestrator can start a
 * second one while the first is still resolving, which is exactly why the
 * dispatcher tracks a SET of watchers per session. Reporting only the first
 * unjoined panel under-counted the parallelism this UI exists to show — a child
 * in the other live panel got no badge at all.
 *
 * "Live" means not yet joined — keyed off `joined` rather than off member
 * statuses, so this can never disagree with the barrier's own rule about when a
 * panel is finished.
 */
export const livePanels = createMemo<CollaborationPanel[]>(() =>
  state().panels.filter((p) => !p.joined),
);

/** The first live fan-out, for callers that only need one. */
export const livePanel = createMemo<CollaborationPanel | null>(
  () => livePanels()[0] ?? null,
);

/**
 * Aggregate progress across every live fan-out, or null when none is running.
 *
 * Summed rather than showing one panel's numbers: with two panels in flight a
 * single panel's "1/3" is a lie about how much work is outstanding.
 */
export const liveProgress = createMemo<
  { settled: number; total: number; panels: number } | null
>(() => {
  const live = livePanels();
  if (live.length === 0) return null;
  return {
    settled: live.reduce((n, p) => n + p.settled, 0),
    total: live.reduce((n, p) => n + p.members.length, 0),
    panels: live.length,
  };
});

/** The most recently joined fan-out — context once the live one is gone. */
export const lastJoinedPanel = createMemo<CollaborationPanel | null>(
  () => state().panels.find((p) => p.joined) ?? null,
);

/**
 * How a given session is participating in the live fan-out, or null.
 *
 * Session-keyed rather than role-keyed: a panel targets sessions, and the same
 * role can have several members, so a role name cannot identify a participant.
 */
export function livePanelMember(
  sessionId: string,
): { ordinal: number; status: CollaborationPanel["members"][number]["status"] } | null {
  // Searches EVERY live fan-out, not just the newest: a child participating only
  // in an older still-running panel showed no badge before this.
  for (const p of livePanels()) {
    const m = p.members.find((x) => x.sessionId === sessionId);
    if (m) return { ordinal: m.ordinal, status: m.status };
  }
  return null;
}

export function resetPanels(): void {
  inflight = null;
  setState(EMPTY);
}

/** Test hook. */
export const _resetPanelsForTest = resetPanels;
