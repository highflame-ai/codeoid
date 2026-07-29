/**
 * Per-session message store + delta reducer.
 *
 * Mirrors the Rust TUI's `MessageStore` semantics:
 *   - upsert by `messageId` so re-broadcasts and replays are idempotent
 *   - `applyDelta` patches `content`, `parts`, `tool.state`, `timestamp`
 *   - `version` map bumped on every mutation so downstream renderers can
 *     short-circuit cache reads
 *   - `replaceScrollback` runs on attach / re-attach with the daemon's
 *     authoritative replay
 *
 * Pure SolidJS — components subscribe via `messagesFor(sessionId)` (a
 * memoised slice). The reducer never sees the WS layer; the connection
 * module wires broadcasts in.
 */

import { batch, createMemo, createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { dedupeReplay, mergeDeltaInto } from "@highflame/codeoid-core";

import type { SessionMessage, SessionMessageDelta } from "../protocol/types";

interface MessagesState {
  /** sessionId -> messages array (in arrival order). */
  bySession: Record<string, SessionMessage[]>;
  /** messageId -> monotonic version counter. */
  versions: Record<string, number>;
  /**
   * Per-session epoch counter, bumped on EVERY mutation that touches a
   * session — including in-place delta patches. Use this signal to
   * trigger effects that need to re-fire on streaming content updates,
   * not just on array-reference changes (Solid's store reactivity is
   * path-grained, so mutating `buf[idx].content` in place won't
   * re-trigger an `on(messages, …)` effect).
   */
  epochBySession: Record<string, number>;
}

const [state, setState] = createStore<MessagesState>({
  bySession: {},
  versions: {},
  epochBySession: {},
});

// O(1) positional index — sessionId → (messageId → array index), maintained
// in parallel with bySession. The #73/#75 fix added an existence Set so
// applyDelta could skip an O(N) buf.some(); the POSITIONAL lookup stayed a
// findIndex-from-0, though, so every streaming delta on a 5000-message
// session still walked all 5000 store-proxied entries inside produce() —
// O(N) per event, O(N²) over the session (#90). Indices stay valid because
// the buffer is append-only; replaceScrollback rebuilds the map wholesale.
// Stored outside the Solid store (plain Map) so mutations don't create
// fine-grained reactive overhead; hasMessage intentionally reads it
// without tracking.
const indexBySession = new Map<string, Map<string, number>>();

/** Reactive slice — components consume this. */
export function messagesFor(sessionId: string): SessionMessage[] {
  return state.bySession[sessionId] ?? EMPTY;
}

/** Reactive memo — same as messagesFor but for use inside JSX `<For each>`. */
export function createMessages(sessionId: () => string | null) {
  return createMemo<SessionMessage[]>(() => {
    const id = sessionId();
    return id ? state.bySession[id] ?? EMPTY : EMPTY;
  });
}

/**
 * Singleton memo for the focused session's messages.
 *
 * Multiple components (Transcript, ApprovalBar, WorkerIndicator,
 * desktop-notifications) used to each call `createMessages(
 * focusedSessionId)`, instantiating four separate memos that
 * recomputed on every delta and each held their own subscriber. This
 * shared accessor is the single computation; consumers all hang off
 * one node in the dependency graph instead of four.
 *
 * Wiring runs once via `setFocusedSessionAccessor()` from `sessions.ts`
 * during its module-init so we avoid a top-level import cycle (this
 * file holds the message store; `sessions.ts` already pokes at it on
 * session-destroy and would otherwise import-back).
 */
let focusedSessionIdAccessor: (() => string | null) | null = null;
let focusedMessagesMemo: (() => SessionMessage[]) | null = null;
export function setFocusedSessionAccessor(fn: () => string | null): void {
  focusedSessionIdAccessor = fn;
  focusedMessagesMemo = null; // re-bind on next call
}
export function focusedSessionMessages(): SessionMessage[] {
  if (!focusedSessionIdAccessor) return EMPTY;
  if (!focusedMessagesMemo) {
    // Create the shared memo under a dedicated root so it isn't owned by
    // whichever component/computation calls first — that owner disposing (e.g.
    // ApprovalBar's `pending` memo re-running on the next delta) would tear this
    // down and never recreate it, freezing the transcript for every consumer.
    // It's an app-lifetime singleton, so we intentionally never dispose the root.
    createRoot(() => {
      focusedMessagesMemo = createMessages(focusedSessionIdAccessor!);
    });
  }
  return focusedMessagesMemo!();
}

/** Monotonic version for a message (cache key). 0 = never seen. */
export function versionOf(messageId: string): number {
  return state.versions[messageId] ?? 0;
}

/**
 * Per-session epoch — reactive. Bumped on every applyMessage /
 * applyDelta / replaceScrollback so effects keyed on this signal
 * re-fire even when in-place mutation leaves the array reference
 * unchanged. Use as the trigger for auto-scroll, render-cache
 * invalidation, etc.
 */
export function epochOf(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  return state.epochBySession[sessionId] ?? 0;
}

/**
 * Wall-clock time of the last live message/delta for a session (0 if none this
 * lifetime). A non-reactive side map keyed by session id — read via a tick, not
 * a subscription. Used as the store-derived freshness source for the busy
 * indicator's staleness guard, so it reflects REAL last activity and survives
 * refocus (unlike a component-local clock, which would reset the window).
 */
const activityAtBySession = new Map<string, number>();
export function lastActivityAt(sessionId: string | null | undefined): number {
  return sessionId ? activityAtBySession.get(sessionId) ?? 0 : 0;
}

const EMPTY: SessionMessage[] = [];

// ---------- broadcast ingest ----------

export function applyMessage(msg: SessionMessage): void {
  // Keep the O(1) index in sync before the store mutation so any concurrent
  // hasMessage call (delta arriving in the same tick) sees the correct
  // answer immediately.
  let index = indexBySession.get(msg.sessionId);
  if (!index) {
    index = new Map();
    indexBySession.set(msg.sessionId, index);
  }
  const at = index.get(msg.messageId);

  activityAtBySession.set(msg.sessionId, Date.now());
  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        const buf = (s.bySession[msg.sessionId] ??= []);
        if (at !== undefined) {
          buf[at] = msg;
        } else {
          index.set(msg.messageId, buf.length);
          buf.push(msg);
        }
        s.versions[msg.messageId] = (s.versions[msg.messageId] ?? 0) + 1;
        s.epochBySession[msg.sessionId] =
          (s.epochBySession[msg.sessionId] ?? 0) + 1;
      }),
    );
  });
}

export function applyDelta(delta: SessionMessageDelta): void {
  // Only mutate if the parent message exists. Stale deltas (delivered
  // before scrollback replay or after eviction) are dropped silently —
  // the daemon's replay will resync us on attach.
  const idx = indexBySession.get(delta.sessionId)?.get(delta.messageId);
  if (idx === undefined) return;
  activityAtBySession.set(delta.sessionId, Date.now());
  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        const buf = s.bySession[delta.sessionId];
        if (!buf) return;
        const target = buf[idx];
        if (!target) return;

        // The merge semantics live in @highflame/codeoid-core so every frontend
        // accumulates transcripts identically; inside produce() the store
        // proxy records the same fine-grained paths the inline code did.
        mergeDeltaInto(target, delta);

        s.versions[delta.messageId] = (s.versions[delta.messageId] ?? 0) + 1;
        s.epochBySession[delta.sessionId] =
          (s.epochBySession[delta.sessionId] ?? 0) + 1;
      }),
    );
  });
}

export function replaceScrollback(sessionId: string, messages: readonly SessionMessage[]): void {
  // Defensive dedupe by messageId (shared kernel — first position kept,
  // last content wins, mirroring upsert semantics).
  const { messages: deduped, posById } = dedupeReplay(messages);

  // Rebuild the O(1) positional index for this session before touching the
  // store — applyDelta reads indexBySession directly. `posById` already IS
  // messageId → deduped position, so reuse it wholesale.
  indexBySession.set(sessionId, posById);

  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        s.bySession[sessionId] = deduped;
        // Per-message version bumps are intentionally omitted here. A full
        // scrollback replay replaces the array reference entirely — the
        // session epoch bump below is the cache-invalidation signal for
        // session-level consumers. Bumping N individual version counters
        // inside produce() creates O(N) fine-grained store mutations that
        // slow down large replays without any downstream benefit (versionOf
        // is not used in any render path).
        s.epochBySession[sessionId] = (s.epochBySession[sessionId] ?? 0) + 1;
      }),
    );
  });
}

/**
 * Append a chunk of a multi-frame scrollback replay (#84). The daemon splits a
 * large scrollback into ordered chunks (oldest→newest): chunk 0 arrives via
 * replaceScrollback (which resets the session), and subsequent chunks extend it
 * here. Upserts by messageId — last occurrence wins, keeping the original
 * position — so a redelivered chunk stays idempotent. Normal (non-duplicate)
 * appends are O(1) per message.
 */
export function appendScrollback(sessionId: string, messages: readonly SessionMessage[]): void {
  if (messages.length === 0) return;
  // Reuse the O(1) positional index (messageId → array position), kept in sync
  // before the store mutation exactly like applyMessage.
  let index = indexBySession.get(sessionId);
  if (!index) {
    index = new Map();
    indexBySession.set(sessionId, index);
  }

  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        const buf = (s.bySession[sessionId] ??= []);
        for (const m of messages) {
          const at = index.get(m.messageId);
          if (at !== undefined) {
            buf[at] = m; // redelivered chunk: upsert in place, keep position
          } else {
            index.set(m.messageId, buf.length);
            buf.push(m);
          }
        }
        s.epochBySession[sessionId] = (s.epochBySession[sessionId] ?? 0) + 1;
      }),
    );
  });
}

/**
 * Prepend a page of OLDER history (`scrollback.page` backfill, #152).
 * `messages` arrive oldest→newest and strictly older than the session's
 * current head; they're inserted at the FRONT preserving that order. Dedupe
 * is by messageId — within the incoming batch via the shared kernel
 * (first position kept), and against the store by DROPPING already-held
 * ids: a collision only means an overlapping/re-requested page, and
 * history content is immutable, so there's nothing to upsert.
 *
 * The O(1) positional index is REBUILT here (offset-shifted): prepending
 * breaks the append-only invariant the incremental index maintenance
 * relies on everywhere else in this module.
 */
export function prependMessages(
  sessionId: string,
  messages: readonly SessionMessage[],
): void {
  if (messages.length === 0) return;
  const existing = indexBySession.get(sessionId);
  const { messages: incoming } = dedupeReplay(messages);
  const fresh = existing
    ? incoming.filter((m) => !existing.has(m.messageId))
    : incoming;
  if (fresh.length === 0) return;

  // Rebuild the positional index: fresh pages occupy 0..f-1, every existing
  // entry shifts down by f. Done before the store mutation so a delta
  // landing in the same tick resolves against correct positions.
  const index = new Map<string, number>();
  for (let i = 0; i < fresh.length; i++) index.set(fresh[i]!.messageId, i);
  if (existing) {
    for (const [id, at] of existing) index.set(id, at + fresh.length);
  }
  indexBySession.set(sessionId, index);

  // Deliberately NOT touching activityAtBySession — backfilled history is
  // not live activity and must not un-stale the busy indicator.
  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        const buf = (s.bySession[sessionId] ??= []);
        buf.unshift(...fresh);
        // Per-message version bumps omitted for the same reason as
        // replaceScrollback: the epoch bump is the invalidation signal.
        s.epochBySession[sessionId] = (s.epochBySession[sessionId] ?? 0) + 1;
      }),
    );
  });
}

/** Check whether a (sessionId, messageId) pair exists in the store. O(1). */
export function hasMessage(sessionId: string, messageId: string): boolean {
  return indexBySession.get(sessionId)?.has(messageId) ?? false;
}

/**
 * Session-destroy cache pruners. Components holding per-message caches
 * keyed by `${sessionId}:${messageId}` (e.g. the Transcript virtualizer's
 * itemSizeCache) register here so a DESTROYED session's keys are evicted.
 * Deliberately NOT invoked on mere focus switches — caches surviving
 * revisits is a feature (#73).
 */
type SessionCachePruner = (sessionId: string) => void;
const sessionCachePruners = new Set<SessionCachePruner>();
export function registerSessionCachePruner(fn: SessionCachePruner): () => void {
  sessionCachePruners.add(fn);
  return () => sessionCachePruners.delete(fn);
}

/**
 * Remove all message state for a session. Call when a session is destroyed
 * so its entries don't accumulate in memory indefinitely.
 */
export function clearSessionMessages(sessionId: string): void {
  const ids = indexBySession.get(sessionId);
  indexBySession.delete(sessionId);
  activityAtBySession.delete(sessionId);
  batch(() => {
    setState(
      produce<MessagesState>((s) => {
        // Per-message version counters are keyed by messageId, not by
        // session — without this loop they leak for every destroyed
        // session's messages.
        if (ids) {
          for (const id of ids.keys()) delete s.versions[id];
        }
        delete s.bySession[sessionId];
        delete s.epochBySession[sessionId];
      }),
    );
  });
  for (const prune of sessionCachePruners) {
    try {
      prune(sessionId);
    } catch (err) {
      console.warn("[codeoid] session cache pruner failed:", err);
    }
  }
}

// Test hook — reset the entire store between tests.
export function _resetMessagesForTest(): void {
  setState({ bySession: {}, versions: {}, epochBySession: {} });
  indexBySession.clear();
  activityAtBySession.clear();
}
