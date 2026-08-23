/**
 * Sessions store. Daemon-canonical: signals are pure projections of the
 * `session.list.result` + `session.info_update` + `session.status_change`
 * broadcasts. Local mutations are forbidden — the store is read-only to
 * components except via the action functions in this module, which only
 * exist so the connection layer can ingest broadcasts.
 */

import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import type { SessionInfo, SessionStatus } from "../protocol/types";
import { clearSessionMessages, setFocusedSessionAccessor } from "./messages";
import { clearResumeCursor } from "./resume";
import { clearDraft } from "./prompt-drafts";
import { compareByRecency } from "../lib/session-order";

interface SessionsState {
  byId: Record<string, SessionInfo>;
}

const [state, setState] = createStore<SessionsState>({ byId: {} });
const [focusedId, setFocusedId] = createSignal<string | null>(null);

/** Local wall-clock time each session's status was last set from a live
 * `status_change` — used to defend a fresh status against a stale list snapshot
 * arriving out of order on reconnect. Non-reactive side map. */
const statusUpdatedAt = new Map<string, number>();

/**
 * Sorted list — most recent activity first.
 *
 * Was `createdAt`, under this same comment: the intent was always recency, the
 * code delivered creation order, and a session you made last week but have been
 * driving all morning sat at the bottom. `compareByRecency` uses the daemon's
 * `lastActivityAt` (falling back to `createdAt` on an older daemon).
 *
 * This is the base order. The sidebar bands it by attention state on top — see
 * lib/session-order.ts — but everything else consuming `sessionList()` gets a
 * sensible most-recent-first list for free.
 */
export const sessionList = createMemo<SessionInfo[]>(() => {
  const items = Object.values(state.byId);
  items.sort(compareByRecency);
  return items;
});

/** Currently-focused session id (null if none). */
export const focusedSessionId = focusedId;

// Wire the singleton focused-messages memo in messages.ts. Done once
// at module load so all consumers can pull the shared accessor
// instead of each one creating its own memo.
setFocusedSessionAccessor(focusedSessionId);

/** Currently-focused session record (null if missing or none focused). */
export const focusedSession = createMemo<SessionInfo | null>(() => {
  const id = focusedId();
  if (!id) return null;
  return state.byId[id] ?? null;
});

/** Look up by id without subscribing the caller. */
export function getSession(id: string): SessionInfo | undefined {
  return state.byId[id];
}

/** Snapshot of the full id-keyed map (read-only). */
export function sessionsSnapshot(): Readonly<Record<string, SessionInfo>> {
  return state.byId;
}

// ---------- broadcast ingest ----------

/** Cheap deep equality for small JSON-shaped values (session list fields). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false; // primitives were already compared by reference
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Sync the store to the daemon's authoritative payload.
 *
 * Merges PER-ID instead of wholesale-replacing `byId`: unchanged sessions
 * keep their store object identity, so Solid's fine-grained reactivity
 * doesn't tear down and re-create every SessionRow on each periodic
 * refresh — only fields that actually changed trigger updates.
 */
export function ingestSessionList(
  items: readonly SessionInfo[],
  /** Wall-clock time the list was requested. When set, a session's `status` is
   * NOT overwritten if a live `status_change` for it landed AFTER this — the
   * snapshot is then stale for that field (the reconnect "stuck thinking" race). */
  since?: number,
): void {
  batch(() => {
    const removedIds: string[] = [];
    setState(
      produce<SessionsState>((s) => {
        const seen = new Set<string>();
        for (const it of items) {
          seen.add(it.id);
          const existing = s.byId[it.id];
          if (!existing) {
            s.byId[it.id] = it;
            continue;
          }
          // Update changed fields in place. Skip prototype-polluting keys:
          // the payload is network-sourced and JSON.parse produces
          // "__proto__" as a plain own property — assigning it through a
          // computed key would rewrite the object's prototype.
          const target = existing as unknown as Record<string, unknown>;
          const source = it as unknown as Record<string, unknown>;
          for (const k of Object.keys(source)) {
            if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
            // Keep a live status_change that's newer than this snapshot.
            if (
              k === "status" &&
              since !== undefined &&
              (statusUpdatedAt.get(it.id) ?? 0) > since
            ) {
              continue;
            }
            // Object-valued fields (usage, subagents, pinnedFiles) arrive as
            // fresh references on every list refresh; reassigning them when
            // deep-equal would notify their subscribers for nothing.
            if (target[k] !== source[k] && !jsonEqual(target[k], source[k])) {
              target[k] = source[k];
            }
          }
          // Drop fields the daemon no longer sends (e.g. an optional
          // `model` that was unset). Object.hasOwn (not `in`) so inherited
          // keys like "constructor" can't mask a legitimate delete.
          for (const k of Object.keys(target)) {
            if (!Object.hasOwn(source, k)) delete target[k];
          }
        }
        // Delete sessions missing from the authoritative list.
        for (const id of Object.keys(s.byId)) {
          if (!seen.has(id)) {
            delete s.byId[id];
            removedIds.push(id);
          }
        }
      }),
    );
    // Prune the per-session state that hangs off a session id — message
    // buffer, resume cursor, drafts — exactly as removeSession() does. A remote
    // removal (destroyed by another client → dropped from this list) otherwise
    // leaked all of it, growing without bound across reconnects.
    for (const id of removedIds) {
      clearSessionMessages(id);
      clearResumeCursor(id);
      clearDraft(id);
      statusUpdatedAt.delete(id);
    }
    // Auto-focus the most recently-ACTIVE session if nothing is focused.
    // Creation order picked whatever session happened to be newest, which after
    // a daemon restart is rarely the one you were working in.
    const cur = focusedId();
    if (!cur || !state.byId[cur]) {
      const sorted = [...items].sort(compareByRecency);
      setFocusedId(sorted[0]?.id ?? null);
    }
  });
}

/**
 * Merge a partial or full session info into the store. Used for
 * `session.info_update` (full) and `session.status_change` (partial —
 * we patch only the status field).
 *
 * `next` may be a full SessionInfo or a partial with at least `id`.
 */
export function mergeSession(next: Partial<SessionInfo> & { id: string }): void {
  // `produce()` never runs its callback on an `undefined` leaf, so the old
  // "materialises lazily" assumption silently dropped `session.info_update` for
  // a session we hadn't seen yet (e.g. one created by another client) — with no
  // periodic list poll, it never appeared until reconnect. Upsert directly when
  // absent; merge in place when present (info_update carries a full SessionInfo).
  // The payload is network-sourced (JSON.parse yields "__proto__" as a plain
  // own key), so skip prototype-polluting keys on both paths — the same guard
  // ingestSessionList already applies.
  if (!state.byId[next.id]) {
    setState("byId", next.id, withoutProtoKeys(next) as SessionInfo);
    return;
  }
  setState(
    "byId",
    next.id,
    produce<SessionInfo>((s) => {
      const target = s as unknown as Record<string, unknown>;
      const source = next as unknown as Record<string, unknown>;
      for (const k of Object.keys(source)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
        target[k] = source[k];
      }
    }),
  );
}

function withoutProtoKeys<T extends object>(obj: T): T {
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    clean[k] = (obj as Record<string, unknown>)[k];
  }
  return clean as T;
}

/** Apply a status-only update from `session.status_change`. */
export function setSessionStatus(id: string, status: SessionStatus): void {
  if (!state.byId[id]) return;
  statusUpdatedAt.set(id, Date.now());
  setState("byId", id, "status", status);
}

export function removeSession(id: string): void {
  batch(() => {
    // A collaboration's role-children have per-goal lifetime: destroying the
    // goal tears them down on the daemon too. Mirror that here or the sidebar
    // keeps listing children whose sessions no longer exist — clicking one then
    // attaches to nothing, and the ghosts survive until a full refresh.
    const ids = [
      id,
      ...Object.values(state.byId)
        .filter((s) => s.collaborationRole?.parentSessionId === id)
        .map((s) => s.id),
    ];
    for (const sid of ids) {
      clearSessionMessages(sid);
      clearResumeCursor(sid);
      clearDraft(sid);
      statusUpdatedAt.delete(sid);
    }
    setState(
      "byId",
      produce<Record<string, SessionInfo>>((m) => {
        for (const sid of ids) delete m[sid];
      }),
    );
    if (ids.includes(focusedId() ?? "")) {
      const remaining = sessionList();
      setFocusedId(remaining[0]?.id ?? null);
    }
  });
}

// ---------- focus actions ----------

export function focusSession(id: string | null): void {
  setFocusedId(id);
}

export function focusNext(): void {
  const list = sessionList();
  if (list.length === 0) return;
  const cur = focusedId();
  const idx = list.findIndex((s) => s.id === cur);
  const next = list[(idx + 1) % list.length];
  if (next) setFocusedId(next.id);
}

export function focusPrev(): void {
  const list = sessionList();
  if (list.length === 0) return;
  const cur = focusedId();
  const idx = list.findIndex((s) => s.id === cur);
  const prev = list[(idx - 1 + list.length) % list.length];
  if (prev) setFocusedId(prev.id);
}

// Test hook — reset the entire store between tests.
export function _resetSessionsForTest(): void {
  batch(() => {
    setState({ byId: {} });
    setFocusedId(null);
  });
}
