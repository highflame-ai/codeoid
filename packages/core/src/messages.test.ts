/**
 * MessageStore + kernel tests — the transcript-accumulation contract every
 * frontend relies on. Mirrors the semantics the web UI's Solid store is
 * tested against (upsert-by-messageId, in-place delta merge, replay dedupe)
 * plus the ingest() routing table (snapshot / chunked / incremental replay).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type {
  ContentPart,
  ScrollbackReplayMsg,
  SessionMessage,
  SessionMessageDelta,
} from "@highflame/codeoid-protocol";
import { MessageStore, dedupeReplay, mergeDeltaInto } from "./messages.js";
import { ResumeCursors } from "./resume.js";

const identity = { sub: "spiffe://x/agent/a", name: "you", type: "human" as const };

function makeMsg(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s1",
    messageId: "m1",
    role: "user",
    content: "hello",
    identity,
    timestamp: "2026-05-04T08:00:00Z",
    ...overrides,
  };
}

function delta(overrides: Partial<SessionMessageDelta> = {}): SessionMessageDelta {
  return {
    type: "session.message.delta",
    sessionId: "s1",
    messageId: "m1",
    timestamp: "2026-05-04T08:00:01Z",
    ...overrides,
  };
}

// ── Kernels ───────────────────────────────────────────────────────────────────

describe("mergeDeltaInto", () => {
  it("appends content and updates the timestamp", () => {
    const m = makeMsg({ content: "hello" });
    mergeDeltaInto(m, delta({ contentAppend: " world" }));
    expect(m.content).toBe("hello world");
    expect(m.timestamp).toBe("2026-05-04T08:00:01Z");
  });

  it("appends and index-updates parts copy-on-write", () => {
    const p1: ContentPart = { kind: "text", text: "one" };
    const m = makeMsg({ parts: [p1] });
    const before = m.parts;

    mergeDeltaInto(m, delta({ partsAppend: [{ kind: "text", text: "two" }] }));
    expect(m.parts).toHaveLength(2);
    expect(before).toHaveLength(1); // old array reference untouched

    mergeDeltaInto(m, delta({ partsUpdate: [{ index: 0, part: { kind: "text", text: "ONE" } }] }));
    expect((m.parts![0] as { text: string }).text).toBe("ONE");

    // Out-of-range index appends instead of dropping.
    mergeDeltaInto(m, delta({ partsUpdate: [{ index: 9, part: { kind: "text", text: "tail" } }] }));
    expect(m.parts).toHaveLength(3);
  });

  it("replaces tool state wholesale; ignores toolStateUpdate without a tool", () => {
    const withTool = makeMsg({
      role: "tool_call",
      tool: { toolId: "t1", name: "Bash", state: { phase: "streaming" } },
    });
    mergeDeltaInto(withTool, delta({ toolStateUpdate: { phase: "completed", success: true } }));
    expect(withTool.tool?.state.phase).toBe("completed");

    const noTool = makeMsg();
    mergeDeltaInto(noTool, delta({ toolStateUpdate: { phase: "executing" } }));
    expect(noTool.tool).toBeUndefined();
  });
});

describe("dedupeReplay", () => {
  it("keeps first position, last content wins, index matches positions", () => {
    const { messages, posById } = dedupeReplay([
      makeMsg({ messageId: "m1", content: "v1" }),
      makeMsg({ messageId: "m2", content: "other" }),
      makeMsg({ messageId: "m1", content: "v2-final" }),
    ]);
    expect(messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(messages[0]?.content).toBe("v2-final");
    expect(posById.get("m1")).toBe(0);
    expect(posById.get("m2")).toBe(1);
  });
});

// ── MessageStore ──────────────────────────────────────────────────────────────

describe("MessageStore", () => {
  let store: MessageStore;
  beforeEach(() => {
    store = new MessageStore();
  });

  it("applyMessage appends, then upserts on re-broadcast", () => {
    store.applyMessage(makeMsg({ messageId: "m1", content: "v1" }));
    store.applyMessage(makeMsg({ messageId: "m2" }));
    store.applyMessage(makeMsg({ messageId: "m1", content: "v2" }));
    const buf = store.messagesFor("s1");
    expect(buf.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(buf[0]?.content).toBe("v2");
    expect(store.hasMessage("s1", "m1")).toBe(true);
    expect(store.hasMessage("s1", "nope")).toBe(false);
  });

  it("applyDelta merges in place and drops unknown targets silently", () => {
    store.applyMessage(makeMsg({ messageId: "m1", content: "hel" }));
    store.applyDelta(delta({ contentAppend: "lo" }));
    expect(store.messagesFor("s1")[0]?.content).toBe("hello");

    store.applyDelta(delta({ messageId: "ghost", contentAppend: "x" }));
    expect(store.messagesFor("s1")).toHaveLength(1);
  });

  it("versions bump per message mutation; epochs bump per session mutation", () => {
    expect(store.versionOf("m1")).toBe(0);
    expect(store.epochOf("s1")).toBe(0);
    store.applyMessage(makeMsg({ messageId: "m1" }));
    store.applyDelta(delta({ contentAppend: "!" }));
    expect(store.versionOf("m1")).toBe(2);
    expect(store.epochOf("s1")).toBe(2);
    expect(store.epochOf(null)).toBe(0);
  });

  it("replaceScrollback resets the session and dedupes duplicates", () => {
    store.applyMessage(makeMsg({ messageId: "old" }));
    store.replaceScrollback("s1", [
      makeMsg({ messageId: "r1", content: "a" }),
      makeMsg({ messageId: "r1", content: "b-final" }),
      makeMsg({ messageId: "r2" }),
    ]);
    const buf = store.messagesFor("s1");
    expect(buf.map((m) => m.messageId)).toEqual(["r1", "r2"]);
    expect(buf[0]?.content).toBe("b-final");
    expect(store.hasMessage("s1", "old")).toBe(false);
    // Deltas target the deduped positions correctly after replace.
    store.applyDelta(delta({ messageId: "r2", contentAppend: "!" }));
    expect(store.messagesFor("s1")[1]?.content).toBe("hello!");
  });

  it("appendScrollback extends in order and upserts redelivered ids in place", () => {
    store.replaceScrollback("s1", [makeMsg({ messageId: "c0" })]);
    store.appendScrollback("s1", [makeMsg({ messageId: "c1", content: "v1" })]);
    store.appendScrollback("s1", [
      makeMsg({ messageId: "c1", content: "v2" }),
      makeMsg({ messageId: "c2" }),
    ]);
    const buf = store.messagesFor("s1");
    expect(buf.map((m) => m.messageId)).toEqual(["c0", "c1", "c2"]);
    expect(buf[1]?.content).toBe("v2");
  });

  it("clearSession drops messages, index, epoch, and version entries", () => {
    store.applyMessage(makeMsg({ messageId: "m1" }));
    store.applyMessage(makeMsg({ sessionId: "s2", messageId: "keep" }));
    store.clearSession("s1");
    expect(store.messagesFor("s1")).toHaveLength(0);
    expect(store.hasMessage("s1", "m1")).toBe(false);
    expect(store.versionOf("m1")).toBe(0);
    expect(store.epochOf("s1")).toBe(0);
    expect(store.hasMessage("s2", "keep")).toBe(true);
  });

  it("notifies listeners with message- and session-level granularity", () => {
    const events: Array<[string, string | null]> = [];
    const unsub = store.onChange((sid, mid) => events.push([sid, mid]));
    store.applyMessage(makeMsg({ messageId: "m1" }));
    store.replaceScrollback("s1", [makeMsg({ messageId: "m1" })]);
    unsub();
    store.applyMessage(makeMsg({ messageId: "m2" }));
    expect(events).toEqual([
      ["s1", "m1"],
      ["s1", null],
    ]);
  });

  it("a throwing listener doesn't break later listeners or the mutation", () => {
    const seen: string[] = [];
    store.onChange(() => {
      throw new Error("bad listener");
    });
    store.onChange((sid) => seen.push(sid));
    store.applyMessage(makeMsg({ messageId: "m1" }));
    expect(seen).toEqual(["s1"]); // second listener still ran
    expect(store.hasMessage("s1", "m1")).toBe(true); // mutation landed
  });

  it("messagesFor returns a stable empty slice for unknown sessions", () => {
    expect(store.messagesFor("nope")).toBe(store.messagesFor("also-nope"));
    expect(store.messagesFor("nope")).toHaveLength(0);
  });
});

// ── ingest() — the broadcast routing table ────────────────────────────────────

describe("MessageStore.ingest", () => {
  function replay(overrides: Partial<ScrollbackReplayMsg>): ScrollbackReplayMsg {
    return { type: "scrollback.replay", sessionId: "s1", messages: [], ...overrides };
  }

  let store: MessageStore;
  let cursors: ResumeCursors;
  beforeEach(() => {
    store = new MessageStore();
    cursors = new ResumeCursors();
  });

  it("routes live messages and deltas, advancing the resume cursor", () => {
    store.ingest(replay({ messages: [], resumeKey: "k", maxSeq: 1, mode: "snapshot" }), cursors);
    expect(store.ingest(makeMsg({ messageId: "m1", seq: 2 }), cursors)).toBe(true);
    expect(store.ingest(delta({ contentAppend: "!", seq: 3 }), cursors)).toBe(true);
    expect(store.messagesFor("s1")[0]?.content).toBe("hello!");
    expect(cursors.resumeFor("s1")).toEqual({ key: "k", sinceSeq: 3 });
  });

  it("snapshot replay resets; chunked snapshot appends; incremental never resets", () => {
    // Single-frame legacy snapshot → reset.
    store.ingest(replay({ messages: [makeMsg({ messageId: "a" })] }));
    // Chunked snapshot: chunk 0 resets, chunk 1 appends (#84 semantics).
    store.ingest(replay({ messages: [makeMsg({ messageId: "b" })], seq: 0, final: false }));
    store.ingest(replay({ messages: [makeMsg({ messageId: "c" })], seq: 1, final: true }));
    expect(store.messagesFor("s1").map((m) => m.messageId)).toEqual(["b", "c"]);

    // Incremental replay — even its chunk 0 must APPEND, not reset.
    store.ingest(
      replay({ messages: [makeMsg({ messageId: "d" })], seq: 0, final: true, mode: "incremental" }),
    );
    expect(store.messagesFor("s1").map((m) => m.messageId)).toEqual(["b", "c", "d"]);
  });

  it("returns false for frames the store doesn't own", () => {
    const status = {
      type: "session.status_change",
      sessionId: "s1",
      status: "idle",
      timestamp: "t",
    } as const;
    expect(store.ingest(status)).toBe(false);
  });
});
