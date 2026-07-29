import { beforeEach, describe, expect, it } from "bun:test";
import { ResumeCursors } from "./resume.js";
import type { ScrollbackReplayMsg } from "@highflame/codeoid-protocol";

function replayFrame(overrides: Partial<ScrollbackReplayMsg> = {}): ScrollbackReplayMsg {
  return {
    type: "scrollback.replay",
    sessionId: "s1",
    messages: [],
    mode: "snapshot",
    resumeKey: "key-a",
    maxSeq: 10,
    ...overrides,
  };
}

describe("ResumeCursors", () => {
  let cursors: ResumeCursors;
  beforeEach(() => {
    cursors = new ResumeCursors();
  });

  it("no cursor until a replay frame with resume meta arrives", () => {
    expect(cursors.resumeFor("s1")).toBeUndefined();
    // Legacy daemon frame (no resumeKey/maxSeq) establishes nothing.
    cursors.noteReplayFrame(replayFrame({ resumeKey: undefined, maxSeq: undefined }));
    expect(cursors.resumeFor("s1")).toBeUndefined();
  });

  it("replay frame establishes the cursor; same-key frames only ever raise it", () => {
    cursors.noteReplayFrame(replayFrame({ maxSeq: 10 }));
    expect(cursors.resumeFor("s1")).toEqual({ key: "key-a", sinceSeq: 10 });

    cursors.noteReplayFrame(replayFrame({ maxSeq: 25 }));
    expect(cursors.resumeFor("s1")!.sinceSeq).toBe(25);

    // A stale/duplicate frame must never LOWER the cursor (leading > lagging
    // is the dangerous direction; lowering is safe but wasteful — keep max).
    cursors.noteReplayFrame(replayFrame({ maxSeq: 5 }));
    expect(cursors.resumeFor("s1")!.sinceSeq).toBe(25);
  });

  it("a NEW resumeKey (daemon restart) resets the cursor to the new domain", () => {
    cursors.noteReplayFrame(replayFrame({ resumeKey: "key-a", maxSeq: 100 }));
    cursors.noteReplayFrame(replayFrame({ resumeKey: "key-b", maxSeq: 3 }));
    // Old-domain seq 100 is meaningless under key-b — cursor must be 3, not 100.
    expect(cursors.resumeFor("s1")).toEqual({ key: "key-b", sinceSeq: 3 });
  });

  it("live seqs raise the cursor, never lower it, and are dropped without a key", () => {
    cursors.noteLiveSeq("s1", 42); // no cursor yet — nothing anchors the domain
    expect(cursors.resumeFor("s1")).toBeUndefined();

    cursors.noteReplayFrame(replayFrame({ maxSeq: 10 }));
    cursors.noteLiveSeq("s1", 12);
    expect(cursors.resumeFor("s1")!.sinceSeq).toBe(12);
    cursors.noteLiveSeq("s1", 11);
    expect(cursors.resumeFor("s1")!.sinceSeq).toBe(12);
    cursors.noteLiveSeq("s1", undefined);
    expect(cursors.resumeFor("s1")!.sinceSeq).toBe(12);
  });

  it("cursors are per-session, cleared individually, and reset wholesale", () => {
    cursors.noteReplayFrame(replayFrame({ sessionId: "s1", maxSeq: 7 }));
    cursors.noteReplayFrame(replayFrame({ sessionId: "s2", resumeKey: "key-z", maxSeq: 3 }));
    expect(cursors.resumeFor("s1")!.sinceSeq).toBe(7);
    expect(cursors.resumeFor("s2")).toEqual({ key: "key-z", sinceSeq: 3 });

    cursors.clear("s1");
    expect(cursors.resumeFor("s1")).toBeUndefined();
    expect(cursors.resumeFor("s2")).toBeDefined();

    cursors.reset();
    expect(cursors.resumeFor("s2")).toBeUndefined();
  });

  it("independent instances do not share state", () => {
    const other = new ResumeCursors();
    cursors.noteReplayFrame(replayFrame());
    expect(other.resumeFor("s1")).toBeUndefined();
  });
});
