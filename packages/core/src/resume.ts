/**
 * Per-session resume cursors (`replay.resume`).
 *
 * Tracks, per session, the daemon's replay-buffer identity (`resumeKey`) and
 * the highest session sequence value observed (`seq`) across replay frames
 * and live message/delta traffic. On re-attach the cursor is passed back so
 * the daemon replays only the tail mutated since — instead of the full
 * scrollback — which is what makes reconnects cheap on flaky links.
 *
 * Safety property: the cursor may lag reality (a frame without `seq` doesn't
 * advance it) but must never lead it — a lagging cursor just means a few
 * messages are resent and deduped by the store's upsert-by-messageId; a
 * leading cursor would silently skip content. Everything here only ever
 * raises the cursor to values actually observed.
 *
 * A class (not module state) so each daemon connection owns its own cursor
 * space; hosts hold one instance next to their `CodeoidClient` /
 * `MessageStore` and pass it to `MessageStore.ingest()`.
 */

import type { ScrollbackReplayMsg } from "@highflame/codeoid-protocol";

interface Cursor {
  key: string;
  seq: number;
}

export class ResumeCursors {
  #cursors = new Map<string, Cursor>();

  /**
   * Ingest a replay frame. A frame carrying a NEW `resumeKey` (first contact,
   * or the daemon restarted and rebuilt its buffer) resets the cursor to that
   * key's `maxSeq` — old-key seq values are meaningless in the new domain.
   * Same-key frames only ever raise the cursor.
   */
  noteReplayFrame(msg: ScrollbackReplayMsg): void {
    if (msg.resumeKey === undefined || msg.maxSeq === undefined) return;
    const existing = this.#cursors.get(msg.sessionId);
    if (existing && existing.key === msg.resumeKey) {
      if (msg.maxSeq > existing.seq) existing.seq = msg.maxSeq;
    } else {
      this.#cursors.set(msg.sessionId, { key: msg.resumeKey, seq: msg.maxSeq });
    }
  }

  /**
   * Ingest a live frame's session cursor (`SessionMessage.seq` /
   * `SessionMessageDelta.seq`). Only meaningful once a replay frame has
   * established which key the seq domain belongs to — live seqs arriving
   * before any cursor exists are dropped (we can't resume without a key).
   */
  noteLiveSeq(sessionId: string, seq: number | undefined): void {
    if (seq === undefined) return;
    const cursor = this.#cursors.get(sessionId);
    if (cursor && seq > cursor.seq) cursor.seq = seq;
  }

  /** The resume argument for `session.attach`, or undefined for a full replay. */
  resumeFor(sessionId: string): { key: string; sinceSeq: number } | undefined {
    const cursor = this.#cursors.get(sessionId);
    return cursor ? { key: cursor.key, sinceSeq: cursor.seq } : undefined;
  }

  /** Drop a session's cursor (session destroyed). */
  clear(sessionId: string): void {
    this.#cursors.delete(sessionId);
  }

  /** Drop everything (new connection to a different daemon, tests). */
  reset(): void {
    this.#cursors.clear();
  }
}
