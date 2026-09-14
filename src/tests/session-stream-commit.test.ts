/**
 * Streamed-message commit regression tests — the #50 bug class.
 *
 * A streamed message (assistant text, thinking) is pushed into scrollback
 * once at stream start (empty, held by reference so mid-stream attaches see
 * it grow) and must be COMMITTED — never pushed again — when the stream
 * finalizes. A second push for the same messageId puts two entries in the
 * ring buffer; scrollback.replay then renders the message twice and
 * virtualizers keyed on messageId collide (web UI overlapping rows).
 *
 * #50 fixed this only inside #artificiallyStreamText. These tests pin the
 * fix across ALL finalize paths:
 *
 *   C1  text_delta → text_done          (normal streamed turn)
 *   C2  thinking_delta → thinking_done  (reasoning blocks)
 *   C3  text_done only                  (batch reply → artificial streaming)
 *   C4  text_delta → turn_done          (turn ends mid-stream → flush)
 *   C5  ScrollbackBuffer byte accounting never drifts negative and the
 *       byte cap keeps evicting after by-reference growth
 *   C6  EpisodeChunker sees one commit-time assistant message per turn →
 *       one combined user+assistant episode (not two half-episodes)
 *   C7  #seq resumes past the persisted transcript tail after restart
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ScrollbackBuffer } from "../daemon/scrollback.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { mockResult } from "../daemon/providers/mock/index.js";
import {
  EpisodeChunker,
  MemoryEngine,
  SqliteEpisodeStore,
} from "../daemon/memory/index.js";
import type { Embedder } from "@highflame/codeoid-memory/embedder.js";
import type { Episode } from "@highflame/codeoid-memory/types.js";
import type { DaemonMessage, AuthContext, SessionMessage } from "../protocol/types.js";
import { SYSTEM_IDENTITY } from "../protocol/types.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";

// ── Fixtures (same shape as session-integration.test.ts) ─────────────────────

const TEST_AUTH: AuthContext = {
  sub: "user:test-stream-commit",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc-stream",
  projectId: "proj-stream",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-stream-commit-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  // Yield so fire-and-forget writes from the previous test settle before
  // the store closes and the tmp dir is removed (see session-integration).
  await new Promise<void>((r) => setTimeout(r, 100));
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** Deterministic embedder so MemoryEngine runs offline (same as memory.test.ts). */
class StubEmbedder implements Embedder {
  readonly modelName = "stub-embed";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) {
        v[i % this.dimensions]! += t.charCodeAt(i) / 1000;
      }
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    });
  }
}

function makeSession(
  provider: MockSessionProvider,
  name = "stream-commit-test",
  memory?: MemoryEngine,
): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name,
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId!,
    projectId: TEST_AUTH.projectId!,
  });
  return new Session({
    name,
    workdir: tmp,
    auth: TEST_AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: provider,
    memory,
  });
}

function makeClient(id = randomUUID()): { client: AttachedClient; received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return {
    client: { id, auth: TEST_AUTH, send: (msg) => received.push(msg) },
    received,
  };
}

function waitForIdle(session: Session, timeoutMs = 8000): Promise<void> {
  if (session.status === "idle" || session.status === "error") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcherId = randomUUID();
    const timer = setTimeout(() => {
      session.detach(watcherId);
      reject(new Error(`session did not reach idle within ${timeoutMs}ms — status=${session.status}`));
    }, timeoutMs);
    const watcher: AttachedClient = {
      id: watcherId,
      auth: TEST_AUTH,
      send(msg) {
        if (msg.type === "session.status_change" &&
            (msg.status === "idle" || msg.status === "error")) {
          clearTimeout(timer);
          session.detach(watcherId);
          resolve();
        }
      },
    };
    session.attach(watcher);
  });
}

/** Attach a fresh client and return the scrollback.replay it receives. */
function replayFor(session: Session): SessionMessage[] {
  const { client, received } = makeClient();
  session.attach(client);
  session.detach(client.id);
  const replay = received.find((m) => m.type === "scrollback.replay");
  if (!replay) return [];
  return (replay as { messages: SessionMessage[] }).messages;
}

/** Assert every messageId appears exactly once; returns messages of a role. */
function assertNoDuplicates(messages: SessionMessage[]): void {
  const seen = new Map<string, number>();
  for (const m of messages) {
    seen.set(m.messageId, (seen.get(m.messageId) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  expect(dupes).toEqual([]);
}

const turnDone: ProviderEvent = { type: "turn_done", result: mockResult() };

// ── C1: normal streamed turn ──────────────────────────────────────────────────

describe("C1 – text_delta → text_done commits exactly one scrollback entry", () => {
  it("replay after a streamed turn has one assistant entry with final content", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_delta", content: "Hello " },
        { type: "text_delta", content: "world" },
        { type: "text_done", content: "Hello world" },
        turnDone,
      ],
    ]);
    const session = makeSession(provider);

    await session.send("greet me", TEST_AUTH);
    await waitForIdle(session);

    const replay = replayFor(session);
    assertNoDuplicates(replay);
    const assistant = replay.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toBe("Hello world");
  });
});

// ── C8: subagent text stays out of the primary stream (#82) ──────────────────

describe("C8 – subagent text/thinking (parentToolUseId set) never reaches the primary stream", () => {
  it("subagent text_done cannot clobber the streaming primary message", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_delta", content: "Primary " },
        // Subagent output interleaves mid-stream — must be ignored entirely.
        { type: "text_delta", content: "SUB DELTA", parentToolUseId: "tu-task" },
        { type: "text_done", content: "SUBAGENT FINAL", parentToolUseId: "tu-task" },
        { type: "thinking_delta", content: "sub think", blockIndex: 0, parentToolUseId: "tu-task" },
        { type: "thinking_done", blockIndex: 0, parentToolUseId: "tu-task" },
        { type: "text_delta", content: "answer" },
        { type: "text_done", content: "Primary answer" },
        turnDone,
      ],
    ]);
    const session = makeSession(provider);

    await session.send("delegate", TEST_AUTH);
    await waitForIdle(session);

    const replay = replayFor(session);
    assertNoDuplicates(replay);
    const assistant = replay.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toBe("Primary answer");
    const thinking = replay.filter((m) => m.role === "thinking");
    expect(thinking).toHaveLength(0);
    for (const m of replay) {
      expect(m.content).not.toContain("SUB DELTA");
      expect(m.content).not.toContain("SUBAGENT FINAL");
    }
  });
});

// ── C2: thinking blocks ───────────────────────────────────────────────────────

describe("C2 – thinking stream commits exactly one scrollback entry", () => {
  it("replay after a thinking block has one thinking entry with full content", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "thinking_delta", content: "hmm ", blockIndex: 0 },
        { type: "thinking_delta", content: "got it", blockIndex: 0 },
        { type: "thinking_done", blockIndex: 0 },
        { type: "text_delta", content: "answer" },
        { type: "text_done", content: "answer" },
        turnDone,
      ],
    ]);
    const session = makeSession(provider);

    await session.send("think hard", TEST_AUTH);
    await waitForIdle(session);

    const replay = replayFor(session);
    assertNoDuplicates(replay);
    const thinking = replay.filter((m) => m.role === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.content).toBe("hmm got it");
  });
});

// ── C3: batch reply → artificial streaming (the original #50 path) ───────────

describe("C3 – text_done without deltas (artificial streaming) commits one entry", () => {
  it("replay after a batch reply has one assistant entry", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "batch reply, no streaming" },
        turnDone,
      ],
    ]);
    const session = makeSession(provider);

    await session.send("reply in batch", TEST_AUTH);
    await waitForIdle(session);

    const replay = replayFor(session);
    assertNoDuplicates(replay);
    const assistant = replay.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toBe("batch reply, no streaming");
  });
});

// ── C4: turn ends mid-stream → #flushActiveAssistant ─────────────────────────

describe("C4 – turn boundary without text_done commits the partial exactly once", () => {
  it("replay after a flushed partial has one assistant entry with the partial content", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_delta", content: "partial rep" },
        turnDone, // no text_done — flush path commits the partial
      ],
    ]);
    const session = makeSession(provider);

    await session.send("get cut off", TEST_AUTH);
    await waitForIdle(session);

    const replay = replayFor(session);
    assertNoDuplicates(replay);
    const assistant = replay.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toBe("partial rep");
  });
});

// ── C5: ScrollbackBuffer accounting under by-reference growth ─────────────────

describe("C5 – ScrollbackBuffer upsert + byte accounting", () => {
  function msg(id: string, content: string): SessionMessage {
    return {
      type: "session.message",
      sessionId: "s1",
      messageId: id,
      role: "assistant",
      content,
      identity: SYSTEM_IDENTITY,
      timestamp: new Date().toISOString(),
    };
  }

  it("re-pushing the same messageId upserts instead of appending", () => {
    const buf = new ScrollbackBuffer();
    const m = msg("m1", "");
    buf.push(m);
    m.content = "grown by reference during streaming";
    buf.push(m); // commit — must not create a second entry
    expect(buf.length).toBe(1);
    expect((buf.read()[0] as SessionMessage).content).toBe(
      "grown by reference during streaming",
    );
  });

  it("bytes match the final serialized size after by-reference growth + re-push", () => {
    const buf = new ScrollbackBuffer();
    const m = msg("m1", "");
    buf.push(m);
    m.content = "x".repeat(10_000);
    buf.push(m);
    expect(buf.bytes).toBe(JSON.stringify(m).length);
  });

  it("byte cap keeps evicting after streamed growth (no negative drift)", () => {
    // Pre-fix, the empty-push/full-subtract asymmetry drove #bytes negative,
    // permanently disabling the byte cap. Stream many messages through the
    // push-grow-push lifecycle and verify the cap still holds.
    const buf = new ScrollbackBuffer({ maxBytes: 5_000, maxEntries: 1_000 });
    for (let i = 0; i < 50; i++) {
      const m = msg(`m${i}`, "");
      buf.push(m);
      m.content = "y".repeat(1_000);
      buf.push(m);
    }
    expect(buf.bytes).toBeGreaterThanOrEqual(0);
    expect(buf.bytes).toBeLessThanOrEqual(5_000);
    expect(buf.length).toBeLessThan(50);
  });

  it("eviction forgets the id: a later push appends a fresh entry", () => {
    const buf = new ScrollbackBuffer({ maxEntries: 2, maxBytes: 1024 * 1024 });
    const m1 = msg("m1", "a");
    buf.push(m1);
    buf.push(msg("m2", "b"));
    buf.push(msg("m3", "c")); // evicts m1
    expect(buf.length).toBe(2);
    buf.push(msg("m1", "reborn")); // must append, not resurrect the old slot
    expect(buf.length).toBe(2); // m2 evicted by the cap
    const ids = buf.read().map((e) => (e as SessionMessage).messageId);
    expect(ids).toEqual(["m3", "m1"]);
  });

  it("updateMessage re-accounts against the recorded size", () => {
    const buf = new ScrollbackBuffer();
    const m = msg("m1", "small");
    buf.push(m);
    buf.updateMessage("m1", (entry) => {
      (entry as SessionMessage).content = "z".repeat(5_000);
    });
    expect(buf.bytes).toBe(JSON.stringify(m).length);
  });

  it("accounts UTF-8 bytes, not UTF-16 code units", () => {
    const buf = new ScrollbackBuffer();
    const m = msg("m1", "नमस्ते 🙏 — multi-byte content");
    buf.push(m);
    const json = JSON.stringify(m);
    expect(buf.bytes).toBe(Buffer.byteLength(json, "utf8"));
    expect(buf.bytes).toBeGreaterThan(json.length); // .length would undercount
  });
});

// ── C6: chunker episode pairing ───────────────────────────────────────────────

describe("C6 – one commit-time assistant message → one combined episode", () => {
  function sm(role: SessionMessage["role"], content: string): SessionMessage {
    return {
      type: "session.message",
      sessionId: "s1",
      messageId: randomUUID(),
      role,
      content,
      identity: SYSTEM_IDENTITY,
      timestamp: new Date().toISOString(),
    };
  }

  it("user + finalized assistant yields a single user_turn episode with both halves", () => {
    const episodes: Omit<Episode, "id">[] = [];
    const chunker = new EpisodeChunker(
      { workspaceId: "w1", sessionId: "s1", createdBy: TEST_AUTH.sub },
      (ep) => episodes.push(ep),
    );
    // Post-fix message sequence: the session feeds the chunker ONCE per
    // streamed message, at commit time, with final content.
    chunker.onMessage(sm("user", "write me a haiku"));
    chunker.onMessage(sm("assistant", "an old silent pond"));

    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe("user_turn");
    expect(episodes[0]!.content).toContain("write me a haiku");
    expect(episodes[0]!.content).toContain("an old silent pond");
  });

  it("live session feeds the chunker exactly once per streamed turn", async () => {
    // End-to-end version of the pairing test: a real Session with a real
    // MemoryEngine. A stray chunker feed at stream start (the pre-fix
    // behavior) would ingest a prompt-only user_turn plus a promptless
    // assistant_turn — this asserts exactly one combined episode lands.
    const memStore = new SqliteEpisodeStore(join(tmp, "memory.db"));
    const engine = new MemoryEngine({ store: memStore, embedder: new StubEmbedder() });
    await engine.init();

    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_delta", content: "an old " },
        { type: "text_delta", content: "silent pond" },
        { type: "text_done", content: "an old silent pond" },
        turnDone,
      ],
    ]);
    const session = makeSession(provider, "chunker-e2e", engine);

    await session.send("write me a haiku", TEST_AUTH);
    await waitForIdle(session);

    const episodes = memStore.listEpisodesForSession(session.id);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe("user_turn");
    expect(episodes[0]!.content).toContain("write me a haiku");
    expect(episodes[0]!.content).toContain("an old silent pond");
    memStore.close();
  });

  it("documents the pre-fix fragmentation: an empty stream-start assistant splits the turn", () => {
    // This is what the session used to emit (push at stream start with empty
    // content, push again at finalize) and why #commitStreamed must be the
    // only chunker feed for streamed messages.
    const episodes: Omit<Episode, "id">[] = [];
    const chunker = new EpisodeChunker(
      { workspaceId: "w1", sessionId: "s1", createdBy: TEST_AUTH.sub },
      (ep) => episodes.push(ep),
    );
    chunker.onMessage(sm("user", "write me a haiku"));
    chunker.onMessage(sm("assistant", "")); // stream-start push (pre-fix)
    chunker.onMessage(sm("assistant", "an old silent pond")); // finalize push

    expect(episodes).toHaveLength(2);
    expect(episodes[0]!.content).not.toContain("an old silent pond");
    expect(episodes[1]!.kind).toBe("assistant_turn"); // promptless half-episode
  });
});

// ── C7: seq resumes past the persisted tail ───────────────────────────────────

describe("C7 – transcript seq seeds from the loaded log on resume", () => {
  it("appends after restoreScrollback continue the sequence instead of restarting at 0", async () => {
    const sessionId = randomUUID();
    const mkMsg = (id: string, role: SessionMessage["role"], content: string): SessionMessage => ({
      type: "session.message",
      sessionId,
      messageId: id,
      role,
      content,
      identity: SYSTEM_IDENTITY,
      timestamp: new Date().toISOString(),
    });

    // Simulate a prior daemon lifetime: three persisted rows, seq 0..2.
    await transcriptStore.append(sessionId, mkMsg("p1", "user", "old prompt"), 0);
    await transcriptStore.append(sessionId, mkMsg("p2", "assistant", "old reply"), 1);
    await transcriptStore.append(sessionId, mkMsg("p3", "user", "old prompt 2"), 2);

    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_delta", content: "new reply" },
        { type: "text_done", content: "new reply" },
        turnDone,
      ],
    ]);
    store.createSession({
      id: sessionId,
      name: "resume-seq",
      workdir: tmp,
      status: "idle",
      createdBy: TEST_AUTH.sub,
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: TEST_AUTH.accountId!,
      projectId: TEST_AUTH.projectId!,
    });
    const session = new Session({
      name: "resume-seq",
      workdir: tmp,
      auth: TEST_AUTH,
      store,
      transcriptStore,
      existingId: sessionId,
      _testProvider: provider,
    });

    // Mirror SessionManager.resumeSessions: load, seed seq past the tail.
    const entries = await transcriptStore.loadTranscript(sessionId);
    const maxSeq = entries.reduce((max, e) => Math.max(max, e.seq), -1);
    session.restoreScrollback(entries.map((e) => e.message), maxSeq + 1);
    expect(maxSeq).toBe(2);

    await session.send("new prompt", TEST_AUTH);
    await waitForIdle(session);
    // Let the fire-and-forget transcript appends settle.
    await new Promise<void>((r) => setTimeout(r, 150));

    const raw = await Bun.file(transcriptStore.transcriptPath(sessionId)).text();
    const rows = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { seq: number });
    const newSeqs = rows.slice(3).map((r) => r.seq);
    expect(newSeqs.length).toBeGreaterThan(0);
    // Every post-resume row continues past the persisted tail.
    for (const s of newSeqs) expect(s).toBeGreaterThanOrEqual(3);
    // And the sequence is strictly increasing (no reuse).
    for (let i = 1; i < newSeqs.length; i++) {
      expect(newSeqs[i]!).toBeGreaterThan(newSeqs[i - 1]!);
    }
  });
});
