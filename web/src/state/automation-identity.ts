/**
 * The automation stores (loop runs, watches, routines) hold what one identity
 * may see — a routine's API token shown once among it. This keeps them on the
 * identity signed in now: when it changes, or signs out, each store is
 * emptied at once, not on its next request. A reconnect as the same identity
 * (the socket dropping, a token refreshed) changes nothing, so a token shown
 * a moment ago is still there.
 */

import { createEffect, on } from "solid-js";

import { identityKey } from "../lib/automation";
import { setLoopsIdentity } from "./loops";
import { setRoutinesIdentity } from "./routines";
import { setWatchesIdentity } from "./watches";
import type { AuthOkMsg } from "../protocol/types";

/** Follow `auth` (connection.ts's `authIdentity`); call inside a reactive owner. */
export function followAutomationIdentity(auth: () => AuthOkMsg | null): void {
  createEffect(
    on(auth, (a) => {
      const key = identityKey(a);
      setLoopsIdentity(key);
      setWatchesIdentity(key);
      setRoutinesIdentity(key);
    }),
  );
}
