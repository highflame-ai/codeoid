/**
 * Transcript store tests — validates JSONL persistence, append,
 * load, metadata, and cleanup.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../daemon/transcript.js";
import { SYSTEM_IDENTITY, type SessionMessage } from "../protocol/types.js";

let tmpDir: string;
let store: TranscriptStore;

function makeMsg(content: string, sessionId = "sess-1"): SessionMessage {
  return {
    type: "session.message",
    sessionId,
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    content,
    identity: SYSTEM_IDENTITY,
    timestamp: new Date().toISOString(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "codeoid-test-"));
  store = new TranscriptStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("TranscriptStore", () => {
  test("append and load transcript", async () => {
    const msg = makeMsg("hello world");
    await store.append("sess-1", msg, 0);

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(0);
    expect(entries[0].message.type).toBe("session.message");
    expect((entries[0].message as SessionMessage).content).toBe("hello world");
  });

  test("append multiple messages preserves order", async () => {
    await store.append("sess-1", makeMsg("first"), 0);
    await store.append("sess-1", makeMsg("second"), 1);
    await store.append("sess-1", makeMsg("third"), 2);

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(3);
    expect(entries[0].seq).toBe(0);
    expect(entries[1].seq).toBe(1);
    expect(entries[2].seq).toBe(2);
    expect((entries[0].message as SessionMessage).content).toBe("first");
    expect((entries[2].message as SessionMessage).content).toBe("third");
  });

  test("load nonexistent transcript returns empty", async () => {
    const entries = await store.loadTranscript("nonexistent");
    expect(entries).toHaveLength(0);
  });

  test("skips non-persisted message types", async () => {
    // status_change should be persisted
    await store.append("sess-1", {
      type: "session.status_change",
      sessionId: "sess-1",
      status: "thinking",
      timestamp: new Date().toISOString(),
    }, 0);

    // auth.ok should NOT be persisted
    await store.append("sess-1", {
      type: "auth.ok",
      identity: SYSTEM_IDENTITY,
      scopes: [],
    } as any, 1);

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(1);
  });

  test("save and load metadata", async () => {
    await store.saveMeta({
      sessionId: "sess-1",
      sessionName: "oracle",
      workdir: "/tmp/oracle",
      createdBy: "spiffe://test",
      createdAt: "2026-01-01T00:00:00Z",
      lastStatus: "idle",
      lastActivityAt: "2026-01-01T00:01:00Z",
      accountId: "personal",
      projectId: "dev",
    });

    const metas = await store.loadAllMeta();
    expect(metas).toHaveLength(1);
    expect(metas[0].sessionId).toBe("sess-1");
    expect(metas[0].sessionName).toBe("oracle");
    expect(metas[0].workdir).toBe("/tmp/oracle");
    expect(metas[0].lastStatus).toBe("idle");
  });

  test("a failed meta write does not wedge writes queued behind it", async () => {
    const meta = (status: "idle" | "thinking") => ({
      sessionId: "sess-chain",
      sessionName: "chain",
      workdir: "/tmp/chain",
      createdBy: "u",
      createdAt: "t",
      lastStatus: status,
      lastActivityAt: "t",
      accountId: "a",
      projectId: "p",
    });

    // Make the FIRST write fail: read-only transcript dir. saveMeta chains
    // per-session; before the fix a rejected leaf skipped every write
    // queued behind it in the same burst (bare `prev.then(...)`).
    const { chmodSync } = await import("node:fs");
    chmodSync(tmpDir, 0o555);
    const first = store.saveMeta(meta("thinking"));
    await expect(first).rejects.toThrow();
    chmodSync(tmpDir, 0o755);

    // The next write must go through — the chain absorbed the failure.
    await store.saveMeta(meta("idle"));
    const metas = await store.loadAllMeta();
    const chain = metas.find((m) => m.sessionId === "sess-chain");
    expect(chain?.lastStatus).toBe("idle");
  });

  test("loadAllMeta loads multiple sessions", async () => {
    await store.saveMeta({
      sessionId: "s1", sessionName: "oracle", workdir: "/tmp/1",
      createdBy: "u1", createdAt: "t1", lastStatus: "idle", lastActivityAt: "t1",
      accountId: "a", projectId: "p",
    });
    await store.saveMeta({
      sessionId: "s2", sessionName: "shield", workdir: "/tmp/2",
      createdBy: "u1", createdAt: "t2", lastStatus: "thinking", lastActivityAt: "t2",
      accountId: "a", projectId: "p",
    });

    const metas = await store.loadAllMeta();
    expect(metas).toHaveLength(2);
    const names = metas.map((m) => m.sessionName).sort();
    expect(names).toEqual(["oracle", "shield"]);
  });

  test("delete removes transcript and metadata", async () => {
    await store.append("sess-1", makeMsg("data"), 0);
    await store.saveMeta({
      sessionId: "sess-1", sessionName: "test", workdir: "/tmp",
      createdBy: "u", createdAt: "t", lastStatus: "idle", lastActivityAt: "t",
      accountId: "a", projectId: "p",
    });

    await store.delete("sess-1");

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(0);

    const metas = await store.loadAllMeta();
    expect(metas).toHaveLength(0);
  });

  test("handles corrupted JSONL lines gracefully", async () => {
    // Write valid + invalid lines manually — each with a unique messageId
    const path = store.transcriptPath("sess-1");
    const msg1 = makeMsg("valid");
    const msg2 = makeMsg("also valid");
    const line1 = JSON.stringify({ seq: 0, timestamp: "t", message: msg1 });
    const line2 = JSON.stringify({ seq: 1, timestamp: "t", message: msg2 });
    await Bun.write(path, `${line1}\nnot json\n${line2}\n`);

    const entries = await store.loadTranscript("sess-1");
    expect(entries).toHaveLength(2); // Skips the corrupted line
  });

  test("transcript path is deterministic", () => {
    const path = store.transcriptPath("sess-123");
    expect(path).toContain("sess-123.jsonl");
  });

  test("meta path is deterministic", () => {
    const path = store.metaPath("sess-123");
    expect(path).toContain("sess-123.meta.json");
  });

  test("separate sessions have separate transcripts", async () => {
    await store.append("s1", makeMsg("session one", "s1"), 0);
    await store.append("s2", makeMsg("session two", "s2"), 0);

    const e1 = await store.loadTranscript("s1");
    const e2 = await store.loadTranscript("s2");
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(1);
    expect((e1[0].message as SessionMessage).content).toBe("session one");
    expect((e2[0].message as SessionMessage).content).toBe("session two");
  });
});

describe("TranscriptStore — rotation, bounded load, output cap (#85)", () => {
  test("rotates the live file past the segment ceiling; load spans all segments", async () => {
    const small = new TranscriptStore(tmpDir, { segmentMaxBytes: 600, maxRotatedSegments: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const msg = makeMsg(`message number ${i} ${"x".repeat(120)}`);
      ids.push(msg.messageId);
      await small.append("rot", msg, i);
    }
    await small.flush();

    // The live file stayed under the ceiling and at least one segment exists.
    expect(Bun.file(small.transcriptPath("rot")).size).toBeLessThanOrEqual(600);
    expect(await Bun.file(`${small.transcriptPath("rot")}.1`).exists()).toBe(true);

    // An unbounded load reads across all segments in order.
    const entries = await small.loadTranscript("rot");
    const loadedIds = entries.map((e) => (e.message as SessionMessage).messageId);
    // Oldest segments beyond the retention window are deleted, so we expect
    // a SUFFIX of the ids, in order, ending at the newest.
    expect(loadedIds.length).toBeGreaterThan(0);
    expect(loadedIds).toEqual(ids.slice(ids.length - loadedIds.length));
  });

  test("merges message updates across a segment boundary", async () => {
    const small = new TranscriptStore(tmpDir, { segmentMaxBytes: 400, maxRotatedSegments: 2 });
    const first = makeMsg("original content");
    await small.append("merge", first, 0);
    // Enough traffic to force the first message's line into a rotated segment.
    await small.append("merge", makeMsg(`filler ${"y".repeat(300)}`), 1);
    // Update the FIRST message from the live file.
    await small.append("merge", { ...first, content: "updated content" }, 2);
    await small.flush();
    expect(await Bun.file(`${small.transcriptPath("merge")}.1`).exists()).toBe(true);

    const entries = await small.loadTranscript("merge");
    const merged = entries.find(
      (e) => (e.message as SessionMessage).messageId === first.messageId,
    );
    expect(merged).toBeDefined();
    expect((merged!.message as SessionMessage).content).toBe("updated content");
    expect(merged!.seq).toBe(2);
  });

  test("maxBytes reads only the newest tail of the log", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const msg = makeMsg(`entry ${i} ${"z".repeat(100)}`);
      ids.push(msg.messageId);
      await store.append("tail", msg, i);
    }
    await store.flush();
    const total = Bun.file(store.transcriptPath("tail")).size;

    const entries = await store.loadTranscript("tail", { maxBytes: Math.floor(total / 4) });
    const loadedIds = entries.map((e) => (e.message as SessionMessage).messageId);

    expect(loadedIds.length).toBeGreaterThan(0);
    expect(loadedIds.length).toBeLessThan(50);
    // Strictly the newest suffix, in order — never the head of the file.
    expect(loadedIds).toEqual(ids.slice(ids.length - loadedIds.length));
    expect(loadedIds.at(-1)).toBe(ids.at(-1));
    // Entries carry the line-length hint for scrollback accounting.
    expect(entries.every((e) => typeof e.bytes === "number" && e.bytes > 0)).toBe(true);
  });

  test("deadlineAt stops a parse mid-file instead of wedging", async () => {
    // 1200 lines > the 512-line deadline-check stride, so an already-expired
    // deadline must abort the parse partway through.
    for (let i = 0; i < 1200; i++) {
      await store.append("slow", makeMsg(`line ${i}`), i);
    }
    await store.flush();

    const entries = await store.loadTranscript("slow", { deadlineAt: Date.now() - 1 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(1200);
  });

  test("caps persisted tool output while leaving the in-memory message alone", async () => {
    const bigOutput = "A".repeat(80 * 1024);
    const toolMsg: SessionMessage = {
      ...makeMsg("ran the tool"),
      role: "tool_call",
      tool: {
        toolId: "t1",
        name: "Bash",
        state: { phase: "completed", success: true, output: bigOutput },
      },
    };
    await store.append("cap", toolMsg, 0);
    await store.flush();

    // Caller's object untouched (broadcast/scrollback keep the full output).
    expect(toolMsg.tool!.state.phase === "completed" && toolMsg.tool!.state.output).toBe(bigOutput);

    const entries = await store.loadTranscript("cap");
    const persisted = (entries[0]!.message as SessionMessage).tool!.state;
    expect(persisted.phase).toBe("completed");
    const output = persisted.phase === "completed" ? persisted.output! : "";
    expect(output.length).toBeLessThan(70 * 1024);
    expect(output).toContain("[output truncated for persistence: 81920 bytes total]");
  });

  test("caps persisted tool output by UTF-8 bytes, not UTF-16 code units", async () => {
    // 32k CJK chars = 32k code units but ~96 KB of UTF-8 — over the 64 KiB
    // cap even though the CHARACTER count is well under it.
    const bigOutput = "語".repeat(32 * 1024);
    const toolMsg: SessionMessage = {
      ...makeMsg("ran the tool"),
      role: "tool_call",
      tool: {
        toolId: "t2",
        name: "Bash",
        state: { phase: "completed", success: true, output: bigOutput },
      },
    };
    await store.append("cap-utf8", toolMsg, 0);
    await store.flush();

    const entries = await store.loadTranscript("cap-utf8");
    const persisted = (entries[0]!.message as SessionMessage).tool!.state;
    const output = persisted.phase === "completed" ? persisted.output! : "";
    expect(output).toContain("bytes total]");
    // The kept prefix is byte-capped (the small marker suffix rides on top).
    // Slack of one U+FFFD: a slice through a multi-byte char decodes to a
    // replacement char that re-encodes up to 2 bytes larger than the stub.
    const prefix = output.slice(0, output.lastIndexOf("\n…"));
    expect(Buffer.byteLength(prefix, "utf-8")).toBeLessThanOrEqual(64 * 1024 + 3);
    expect(Buffer.byteLength(prefix, "utf-8")).toBeGreaterThan(60 * 1024);
  });

  test("delete removes rotated segments too", async () => {
    const small = new TranscriptStore(tmpDir, { segmentMaxBytes: 300, maxRotatedSegments: 2 });
    for (let i = 0; i < 8; i++) {
      await small.append("gone", makeMsg(`del ${i} ${"w".repeat(120)}`), i);
    }
    await small.flush();
    expect(await Bun.file(`${small.transcriptPath("gone")}.1`).exists()).toBe(true);

    await small.delete("gone");
    expect(await Bun.file(small.transcriptPath("gone")).exists()).toBe(false);
    expect(await Bun.file(`${small.transcriptPath("gone")}.1`).exists()).toBe(false);
    expect(await Bun.file(`${small.transcriptPath("gone")}.2`).exists()).toBe(false);
  });
});

describe("TranscriptStore — the log as it was (lazy session loading)", () => {
  test("a read as of a tail's marks leaves out what was appended since, whatever its seqs, rotated or not", async () => {
    const small = new TranscriptStore(tmpDir, { segmentMaxBytes: 1500, maxRotatedSegments: 3 });
    const ids: string[] = [];
    // Seqs that go back down, as an older daemon's restarts left them.
    for (let i = 0; i < 6; i++) {
      const msg = makeMsg(`before ${i} ${"x".repeat(120)}`);
      ids.push(msg.messageId);
      await small.append("asof", msg, i < 4 ? i : i - 4);
    }
    await small.flush();
    const want = (await small.loadTranscript("asof")).map((e) => (e.message as SessionMessage).messageId);
    expect(want).toEqual(ids);
    const tail = await small.transcriptTail("asof");
    expect(tail).toMatchObject({ nextSeq: 2, hasEntries: true });
    // Appended since, at seqs the log already holds, and enough to rotate the files.
    for (let i = 0; i < 4; i++) await small.append("asof", makeMsg(`after ${i} ${"y".repeat(200)}`), 2 + i);
    await small.flush();
    expect(await Bun.file(`${small.transcriptPath("asof")}.2`).exists()).toBe(true);
    const got = await small.loadTranscript("asof", { asOf: tail.files });
    expect(got.map((e) => (e.message as SessionMessage).messageId)).toEqual(want);
    const gotSync = small.loadTranscriptSync("asof", { asOf: tail.files });
    expect(gotSync.map((e) => (e.message as SessionMessage).messageId)).toEqual(want);
  });

  test("a log with entries but no seqs has entries; an unreadable one is an error, never an empty log", async () => {
    const { appendFileSync, chmodSync } = await import("node:fs");
    const path = store.transcriptPath("noseq");
    appendFileSync(path, `${JSON.stringify({ timestamp: "t", message: makeMsg("no seq") })}\n`);
    expect(await store.transcriptTail("noseq")).toMatchObject({ nextSeq: 0, hasEntries: true });
    chmodSync(path, 0o000);
    try {
      await expect(store.transcriptTail("noseq")).rejects.toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
    expect(await store.transcriptTail("missing")).toEqual({ nextSeq: 0, hasEntries: false, files: [] });
  });
});
