/**
 * Web binding for `@highflame/codeoid-core`'s ResumeCursors — one singleton per app
 * (the web UI holds exactly one daemon connection). Keeps the existing
 * function-style API so call sites stay unchanged.
 */
import { ResumeCursors } from "@highflame/codeoid-core";
import type { ScrollbackReplayMsg } from "../protocol/types";

const cursors = new ResumeCursors();

export function noteReplayFrame(msg: ScrollbackReplayMsg): void {
  cursors.noteReplayFrame(msg);
}

export function noteLiveSeq(sessionId: string, seq: number | undefined): void {
  cursors.noteLiveSeq(sessionId, seq);
}

export function resumeFor(sessionId: string): { key: string; sinceSeq: number } | undefined {
  return cursors.resumeFor(sessionId);
}

export function clearResumeCursor(sessionId: string): void {
  cursors.clear(sessionId);
}

/** Test-only: reset module state. */
export function _resetResumeForTest(): void {
  cursors.reset();
}
