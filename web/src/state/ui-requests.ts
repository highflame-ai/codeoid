/**
 * Provider-dialog state (`session.ui_request` / `session.ui_resolved`).
 *
 * The daemon broadcasts a request to every capable client, re-sends pending
 * ones on attach, and broadcasts `ui_resolved` once ANY client (or the
 * timeout) settles it — so this store just mirrors the daemon: add on
 * request, drop on resolved. Answering is `respondToUiRequest`, which ships
 * `session.ui_response`; the authoritative dismiss is still the resolved
 * broadcast (a not_found response means someone else won the race — the
 * broadcast already cleaned up).
 */

import { createStore, produce, reconcile } from "solid-js/store";

import type { SessionUiRequestMsg } from "../protocol/types";
import { newRequestId, request } from "./connection";

interface UiRequestState {
  /** Pending requests per session, oldest first (daemon order). */
  bySession: Record<string, SessionUiRequestMsg[]>;
}

const [state, setState] = createStore<UiRequestState>({ bySession: {} });

export function addUiRequest(msg: SessionUiRequestMsg): void {
  setState(
    produce((s) => {
      const list = (s.bySession[msg.sessionId] ??= []);
      // Attach re-delivery makes duplicates normal — upsert by requestId.
      if (!list.some((r) => r.requestId === msg.requestId)) list.push(msg);
    }),
  );
}

export function removeUiRequest(sessionId: string, requestId: string): void {
  setState(
    produce((s) => {
      const list = s.bySession[sessionId];
      if (!list) return;
      const next = list.filter((r) => r.requestId !== requestId);
      if (next.length === 0) delete s.bySession[sessionId];
      else s.bySession[sessionId] = next;
    }),
  );
}

/** Oldest pending dialog for a session (what the bar renders), or null. */
export function pendingUiRequest(sessionId: string | null): SessionUiRequestMsg | null {
  if (!sessionId) return null;
  return state.bySession[sessionId]?.[0] ?? null;
}

/**
 * Every pending dialog, keyed by session — the cross-session attention queue
 * (lib/attention.ts) needs the whole population, not one session's slice.
 * Reading the store directly keeps it reactive for callers inside a memo.
 */
export function allPendingUiRequests(): Readonly<Record<string, readonly SessionUiRequestMsg[]>> {
  return state.bySession;
}

/** Count of pending dialogs for a session (badge / tests). */
export function pendingUiRequestCount(sessionId: string): number {
  return state.bySession[sessionId]?.length ?? 0;
}

/**
 * Answer a dialog. Optimistically removes the local copy — the daemon's
 * `ui_resolved` broadcast is the authoritative dismiss for everyone else.
 * A rejected response (someone answered first, or it timed out) is fine:
 * the broadcast already removed it here too.
 */
export function respondToUiRequest(
  sessionId: string,
  requestId: string,
  response: { value?: string; confirmed?: boolean; cancelled?: boolean },
): void {
  removeUiRequest(sessionId, requestId);
  request({
    type: "session.ui_response",
    id: newRequestId(),
    sessionId,
    requestId,
    ...response,
  }).catch(() => {
    // Lost the race (answered elsewhere / timed out) — nothing to restore;
    // the resolved broadcast governs.
  });
}

/** Test-only reset. */
export function _resetUiRequestsForTest(): void {
  setState(reconcile({ bySession: {} }));
}
