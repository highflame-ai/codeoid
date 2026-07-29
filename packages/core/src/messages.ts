/**
 * Message semantics — the single source of truth for how session transcripts
 * accumulate on a client, shared by every frontend.
 *
 * Two layers:
 *
 *   1. KERNELS — pure functions encoding the merge semantics
 *      (`mergeDeltaInto`, `dedupeReplay`). Frontends with their own reactive
 *      store (the Solid web UI) call these inside their store transactions so
 *      the semantics can't drift per-client.
 *
 *   2. `MessageStore` — a batteries-included, framework-agnostic store built
 *      on the kernels for clients WITHOUT a bespoke reactive layer (React
 *      Native, headless tools). Mirrors the web store's behaviour exactly:
 *      upsert-by-messageId (idempotent re-broadcast/replay), O(1) positional
 *      index, per-message version counters, per-session epoch counters, and
 *      `ingest()` — the full broadcast-routing decision table (live message /
 *      delta / snapshot replay / chunked replay / incremental resume) that is
 *      easy to get subtly wrong when reimplemented.
 *
 * Everything here mirrors the Rust TUI's `MessageStore` semantics.
 */

import type {
  ContentPart,
  DaemonMessage,
  ScrollbackReplayMsg,
  SessionMessage,
  SessionMessageDelta,
  ToolState,
} from "@highflame/codeoid-protocol";
import type { ResumeCursors } from "./resume.js";

// =============================================================================
// Kernels
// =============================================================================

/**
 * Apply a streaming delta to its target message, in place. The daemon
 * guarantees deltas reference an existing message; callers gate on existence
 * (stale deltas for evicted/unknown messages are dropped — the next replay
 * resyncs).
 *
 * Mutates `target` deliberately: both the Solid store (inside `produce`) and
 * `MessageStore` rely on in-place patching so streaming stays O(delta), not
 * O(message). `parts` arrays are copy-on-write so consumers holding the old
 * array reference are not surprised by index mutation.
 */
export function mergeDeltaInto(target: SessionMessage, delta: SessionMessageDelta): void {
  if (delta.contentAppend) {
    target.content = (target.content ?? "") + delta.contentAppend;
  }
  if (delta.partsAppend && delta.partsAppend.length > 0) {
    const parts: ContentPart[] = target.parts ? [...target.parts] : [];
    parts.push(...delta.partsAppend);
    target.parts = parts;
  }
  if (delta.partsUpdate && delta.partsUpdate.length > 0) {
    const parts: ContentPart[] = target.parts ? [...target.parts] : [];
    for (const upd of delta.partsUpdate) {
      const i = upd.index;
      if (i >= 0 && i < parts.length) parts[i] = upd.part;
      else parts.push(upd.part);
    }
    target.parts = parts;
  }
  if (delta.toolStateUpdate && target.tool) {
    // ToolState is a discriminated union; assigning replaces wholesale.
    target.tool = { ...target.tool, state: delta.toolStateUpdate satisfies ToolState };
  }
  target.timestamp = delta.timestamp;
}

/**
 * Dedupe a replayed message array by messageId — the message keeps the
 * position of its FIRST occurrence, the LAST occurrence's content wins
 * (mirrors upsert semantics). Returns the deduped array plus the
 * messageId → position index, which IS the store's positional index for
 * the replaced session.
 */
export function dedupeReplay(messages: readonly SessionMessage[]): {
  messages: SessionMessage[];
  posById: Map<string, number>;
} {
  const deduped: SessionMessage[] = [];
  const posById = new Map<string, number>();
  for (const m of messages) {
    const at = posById.get(m.messageId);
    if (at !== undefined) {
      deduped[at] = m;
    } else {
      posById.set(m.messageId, deduped.length);
      deduped.push(m);
    }
  }
  return { messages: deduped, posById };
}

// =============================================================================
// MessageStore
// =============================================================================

/** Change notification. `messageId` is null for whole-session changes (replay/clear). */
export type MessageStoreListener = (sessionId: string, messageId: string | null) => void;

/** Stable empty slice — avoids an allocation per miss and gives callers a
 * consistent identity for "no messages". */
const EMPTY: readonly SessionMessage[] = Object.freeze([]);

export class MessageStore {
  #bySession = new Map<string, SessionMessage[]>();
  #indexBySession = new Map<string, Map<string, number>>();
  #versions = new Map<string, number>();
  #epochs = new Map<string, number>();
  #listeners = new Set<MessageStoreListener>();

  /** Subscribe to changes. Returns an unsubscribe fn. */
  onChange(listener: MessageStoreListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Messages for a session, in arrival order. The returned array is live —
   * treat as read-only and re-read on change notifications / epoch bumps. */
  messagesFor(sessionId: string): readonly SessionMessage[] {
    return this.#bySession.get(sessionId) ?? EMPTY;
  }

  /** O(1) existence check. */
  hasMessage(sessionId: string, messageId: string): boolean {
    return this.#indexBySession.get(sessionId)?.has(messageId) ?? false;
  }

  /** Monotonic per-message version (render-cache key). 0 = never seen. */
  versionOf(messageId: string): number {
    return this.#versions.get(messageId) ?? 0;
  }

  /** Per-session epoch — bumps on EVERY mutation, including in-place delta
   * patches (array identity is not a reliable change signal). */
  epochOf(sessionId: string | null | undefined): number {
    if (!sessionId) return 0;
    return this.#epochs.get(sessionId) ?? 0;
  }

  /** Upsert a complete message (live broadcast or re-broadcast). */
  applyMessage(msg: SessionMessage): void {
    const index = this.#index(msg.sessionId);
    const buf = this.#buffer(msg.sessionId);
    const at = index.get(msg.messageId);
    if (at !== undefined) {
      buf[at] = msg;
    } else {
      index.set(msg.messageId, buf.length);
      buf.push(msg);
    }
    this.#bumpVersion(msg.messageId);
    this.#bumpEpoch(msg.sessionId);
    this.#notify(msg.sessionId, msg.messageId);
  }

  /** Apply a streaming delta. Unknown/stale targets are dropped silently —
   * the daemon's replay resyncs on the next attach. */
  applyDelta(delta: SessionMessageDelta): void {
    const idx = this.#indexBySession.get(delta.sessionId)?.get(delta.messageId);
    if (idx === undefined) return;
    const target = this.#bySession.get(delta.sessionId)?.[idx];
    if (!target) return;
    mergeDeltaInto(target, delta);
    this.#bumpVersion(delta.messageId);
    this.#bumpEpoch(delta.sessionId);
    this.#notify(delta.sessionId, delta.messageId);
  }

  /** Authoritative snapshot replay — RESET the session to these messages. */
  replaceScrollback(sessionId: string, messages: readonly SessionMessage[]): void {
    const { messages: deduped, posById } = dedupeReplay(messages);
    this.#bySession.set(sessionId, deduped);
    this.#indexBySession.set(sessionId, posById);
    this.#bumpEpoch(sessionId);
    this.#notify(sessionId, null);
  }

  /** Chunked-replay continuation / incremental resume tail — upsert by
   * messageId, keeping first-seen position; new messages append in order. */
  appendScrollback(sessionId: string, messages: readonly SessionMessage[]): void {
    if (messages.length === 0) return;
    const index = this.#index(sessionId);
    const buf = this.#buffer(sessionId);
    for (const m of messages) {
      const at = index.get(m.messageId);
      if (at !== undefined) {
        buf[at] = m;
      } else {
        index.set(m.messageId, buf.length);
        buf.push(m);
      }
    }
    this.#bumpEpoch(sessionId);
    this.#notify(sessionId, null);
  }

  /** Drop all state for a destroyed session. */
  clearSession(sessionId: string): void {
    const ids = this.#indexBySession.get(sessionId);
    if (ids) for (const id of ids.keys()) this.#versions.delete(id);
    this.#bySession.delete(sessionId);
    this.#indexBySession.delete(sessionId);
    this.#epochs.delete(sessionId);
    this.#notify(sessionId, null);
  }

  /**
   * Route a daemon broadcast into the store — the full decision table:
   *
   *   - `session.message` → upsert (and advance the resume cursor);
   *   - `session.message.delta` → in-place merge (and advance the cursor);
   *   - `scrollback.replay`:
   *       · `mode: "incremental"` → APPEND/upsert, never reset — the daemon
   *         sent only the tail mutated since our cursor (chunk 0 of an
   *         incremental replay is NOT a snapshot);
   *       · snapshot chunk 0 / single-frame legacy → RESET the session;
   *       · snapshot chunk > 0 (#84) → append in order.
   *     Replay frames also (re)establish the resume cursor.
   *
   * Returns true when the frame was store-relevant (callers may use this to
   * skip their own routing). Pass `cursors` to keep incremental resume
   * working across reconnects; omit it to opt out of cursor tracking.
   */
  ingest(msg: DaemonMessage, cursors?: ResumeCursors): boolean {
    switch (msg.type) {
      case "session.message":
        cursors?.noteLiveSeq(msg.sessionId, msg.seq);
        this.applyMessage(msg);
        return true;
      case "session.message.delta":
        cursors?.noteLiveSeq(msg.sessionId, msg.seq);
        this.applyDelta(msg);
        return true;
      case "scrollback.replay": {
        const replay = msg as ScrollbackReplayMsg;
        cursors?.noteReplayFrame(replay);
        if (replay.mode === "incremental") {
          this.appendScrollback(replay.sessionId, replay.messages);
        } else if (replay.seq === undefined || replay.seq === 0) {
          this.replaceScrollback(replay.sessionId, replay.messages);
        } else {
          this.appendScrollback(replay.sessionId, replay.messages);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Test/reset hook. */
  clear(): void {
    this.#bySession.clear();
    this.#indexBySession.clear();
    this.#versions.clear();
    this.#epochs.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #buffer(sessionId: string): SessionMessage[] {
    let buf = this.#bySession.get(sessionId);
    if (!buf) {
      buf = [];
      this.#bySession.set(sessionId, buf);
    }
    return buf;
  }

  #index(sessionId: string): Map<string, number> {
    let index = this.#indexBySession.get(sessionId);
    if (!index) {
      index = new Map();
      this.#indexBySession.set(sessionId, index);
    }
    return index;
  }

  #bumpVersion(messageId: string): void {
    this.#versions.set(messageId, (this.#versions.get(messageId) ?? 0) + 1);
  }

  #bumpEpoch(sessionId: string): void {
    this.#epochs.set(sessionId, (this.#epochs.get(sessionId) ?? 0) + 1);
  }

  #notify(sessionId: string, messageId: string | null): void {
    // Isolate subscriber faults: one throwing listener must not break the
    // fan-out for later listeners or unwind the mutation that notified.
    for (const l of this.#listeners) {
      try {
        l(sessionId, messageId);
      } catch (err) {
        console.error("[codeoid/core] MessageStore listener threw:", err);
      }
    }
  }
}
