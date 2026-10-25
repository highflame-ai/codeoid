/**
 * The cross-session attention queue, wired to live state (§8).
 *
 * Thin by design: `lib/attention.ts` owns collection and ranking, and this
 * only joins the sources — the session population, pending provider dialogs,
 * the fleet board, and the owner's loop runs, watches and routines — and
 * re-ranks as the clock moves.
 */

import { createMemo } from "solid-js";

import { attentionQueue, type AttentionItem } from "../lib/attention";
import { nowTick } from "./clock";
import { fleetBoard, taskSession } from "./fleet";
import { loopsState } from "./loops";
import { routinesState } from "./routines";
import { watchesState } from "./watches";
import { sessionList } from "./sessions";
import { allPendingUiRequests } from "./ui-requests";

/**
 * Ranked "needs you" items, most urgent first.
 *
 * Depends on `nowTick` because the ranking is (blocking-cost × staleness) —
 * an item that nobody touches still climbs as it ages, so the order has to be
 * recomputed on the shared clock rather than only when the data changes.
 */
export const attentionItems = createMemo<AttentionItem[]>(() => {
  const board = fleetBoard();
  return attentionQueue(
    {
      sessions: sessionList(),
      uiRequests: allPendingUiRequests(),
      tasks: board.tasks,
      taskSession: (t) => taskSession(board, t),
      loops: loopsState().runs,
      watches: watchesState().watches,
      routines: routinesState().routines,
    },
    nowTick(),
  );
});

/** How many things are waiting on you — for the ambient badge. */
export const attentionCount = createMemo(() => attentionItems().length);
