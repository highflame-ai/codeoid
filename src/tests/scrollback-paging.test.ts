/**
 * Tail-first attach + on-demand history paging (`scrollback.paging`, #152).
 *
 * The legacy attach replays the WHOLE in-memory buffer oldest→newest — on a
 * large session the tail the user actually needs arrives last, and history
 * evicted from the buffer (5k msgs / 20 MB caps) is unreachable by clients
 * entirely. Paging-capable clients instead get the newest window on attach
 * (`tail: true` + `hasMore`) and pull older pages via `scrollback.page`,
 * anchored by messageId — served from the buffer, or from the on-disk JSONL
 * transcript when the anchor predates the buffer.
 *
 * Covers:
 *   - ScrollbackBuffer.readTailChunked / readPageBefore / partialHistory
 *   - Session.attach: capability-gated tail vs legacy full replay
 *   - Session.pageScrollback: buffer pages, transcript fallback, exhaustion
 *   - SessionManager `scrollback.page`: scope gate, unknown session, happy path
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ScrollbackBuffer } from "../daemon/scrollback.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { CAPABILITIES } from "../protocol/types.js";
import type {
  AuthContext,
  DaemonMessage,
  ScrollbackPageResultMsg,
  ScrollbackReplayMsg,
  SessionMessage,
} from "../protocol/types.js";

const TEST_AUTH: AuthContext = {
  sub: "user:paging",
  scopes: ["session:create", "session:attach", "session:list"],
  delegationDepth: 0,
  accountId: "acc-p",
  projectId: "proj-p",
};

function msg(id: string, content: string, sessionId = "s"): SessionMessage {
  return {
    type: "session.message",
    sessionId,
    messageId: id,
    role: "assistant",
    content,
    identity: { sub: "agent:x", type: "agent" },
    timestamp: "2026-07-11T00:00:00Z",
  } as SessionMessage;
}

// ── ScrollbackBuffer primitives ──────────────────────────────────────────────

describe("ScrollbackBuffer — tail + page reads", () => {
  it("readTailChunked returns the NEWEST window and reports older history", () => {
    const buf = new ScrollbackBuffer();
    const pushed: SessionMessage[] = [];
    for (let i = 0; i < 10; i++) {
      const m = msg(`m${i}`, "x".repeat(1000));
      buf.push(m);
      pushed.push(m);
    }
    // push() stamps seq in place — measure the ACCOUNTED per-entry size
    // from the stamped object instead of guessing envelope overhead.
    const sz = JSON.stringify(pushed[9]).length;

    // Budget for exactly 3 messages: the tail is the newest 3, oldest→newest.
    const tail = buf.readTailChunked(3 * sz + 1, 1024 * 1024);
    const ids = tail.chunks.flat().map((m) => (m as SessionMessage).messageId);
    expect(ids).toEqual(["m7", "m8", "m9"]);
    expect(tail.hasMore).toBe(true);

    // Budget for everything: full buffer, nothing more.
    const all = buf.readTailChunked(1024 * 1024, 1024 * 1024);
    expect(all.chunks.flat().length).toBe(10);
    expect(all.hasMore).toBe(false);

    // Always at least the newest message, even under a tiny budget.
    const tiny = buf.readTailChunked(1, 1024 * 1024);
    expect(tiny.chunks.flat().map((m) => (m as SessionMessage).messageId)).toEqual(["m9"]);
    expect(tiny.hasMore).toBe(true);

    expect(new ScrollbackBuffer().readTailChunked(1000, 1000)).toEqual({
      chunks: [],
      hasMore: false,
    });
  });

  it("readPageBefore pages strictly older than the anchor, budget-walked", () => {
    const buf = new ScrollbackBuffer();
    const pushed: SessionMessage[] = [];
    for (let i = 0; i < 10; i++) {
      const m = msg(`m${i}`, "x".repeat(1000));
      buf.push(m);
      pushed.push(m);
    }
    const sz = JSON.stringify(pushed[5]).length;

    // Anchor mid-buffer, budget for exactly 2 messages → the two just before it.
    const page = buf.readPageBefore("m6", 2 * sz + 1);
    expect(page).not.toBeNull();
    expect(page!.messages.map((m) => (m as SessionMessage).messageId)).toEqual(["m4", "m5"]);
    expect(page!.hasMore).toBe(true);

    // Anchor near the floor: the rest, nothing more.
    const rest = buf.readPageBefore("m2", 1024 * 1024);
    expect(rest!.messages.map((m) => (m as SessionMessage).messageId)).toEqual(["m0", "m1"]);
    expect(rest!.hasMore).toBe(false);

    // Anchor IS the floor: empty page, not an error.
    expect(buf.readPageBefore("m0", 1000)).toEqual({ messages: [], hasMore: false });

    // Unknown anchor → null (caller falls back to the transcript).
    expect(buf.readPageBefore("nope", 1000)).toBeNull();

    // At least one message per page even when a single one busts the budget.
    const one = buf.readPageBefore("m6", 1);
    expect(one!.messages.length).toBe(1);
    expect(one!.messages.map((m) => (m as SessionMessage).messageId)).toEqual(["m5"]);
  });

  it("partialHistory flips on eviction and on explicit marking", () => {
    const evicting = new ScrollbackBuffer({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) evicting.push(msg(`m${i}`, "x"));
    expect(evicting.partialHistory).toBe(true);

    const marked = new ScrollbackBuffer();
    expect(marked.partialHistory).toBe(false);
    marked.markPartialHistory();
    expect(marked.partialHistory).toBe(true);
  });
});

// ── Session attach + pageScrollback ──────────────────────────────────────────

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-paging-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await transcriptStore.flush();
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function makeSession(name = "paging"): Session {
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
    _testProvider: new MockSessionProvider("claude"),
  });
}

function makeClient(capabilities?: readonly string[]): {
  client: AttachedClient;
  received: DaemonMessage[];
} {
  const received: DaemonMessage[] = [];
  return {
    received,
    client: {
      id: randomUUID(),
      auth: TEST_AUTH,
      send: (m) => received.push(m),
      ...(capabilities ? { capabilities } : {}),
    },
  };
}

/** 60 × ~20 KB messages ≈ 1.2 MB — larger than the 512 KB attach tail. */
function seedBig(session: Session, count = 60, bytes = 20_000): SessionMessage[] {
  const messages = Array.from({ length: count }, (_, i) =>
    msg(`m${i}`, "x".repeat(bytes), session.id),
  );
  session.restoreScrollback(messages);
  return messages;
}

describe("Session.attach — tail-first for paging clients", () => {
  it("paging client gets only the newest window, tail-flagged", () => {
    const session = makeSession();
    seedBig(session);
    const { client, received } = makeClient([CAPABILITIES.SCROLLBACK_PAGING]);

    session.attach(client);

    const replays = received.filter(
      (m): m is ScrollbackReplayMsg => m.type === "scrollback.replay",
    );
    expect(replays.length).toBeGreaterThan(0);
    expect(replays[0]!.tail).toBe(true);
    expect(replays[0]!.hasMore).toBe(true);
    const total = replays.reduce((n, r) => n + r.messages.length, 0);
    expect(total).toBeLessThan(60);
    // The window is the NEWEST slice — its last message is the session's last.
    const all = replays.flatMap((r) => r.messages);
    expect(all.at(-1)!.messageId).toBe("m59");
  });

  it("legacy client (no capability) keeps the full replay", () => {
    const session = makeSession();
    seedBig(session);
    const { client, received } = makeClient(); // no capabilities

    session.attach(client);

    const replays = received.filter(
      (m): m is ScrollbackReplayMsg => m.type === "scrollback.replay",
    );
    const total = replays.reduce((n, r) => n + r.messages.length, 0);
    expect(total).toBe(60);
    expect(replays[0]!.tail).toBeUndefined();
  });

  it("small session: tail covers everything, hasMore false", () => {
    const session = makeSession();
    session.restoreScrollback([msg("a", "hi", session.id), msg("b", "there", session.id)]);
    const { client, received } = makeClient([CAPABILITIES.SCROLLBACK_PAGING]);

    session.attach(client);

    const replay = received.find(
      (m): m is ScrollbackReplayMsg => m.type === "scrollback.replay",
    )!;
    expect(replay.messages.length).toBe(2);
    expect(replay.tail).toBe(true);
    expect(replay.hasMore).toBe(false);
  });
});

describe("Session.pageScrollback", () => {
  it("pages backwards through the buffer to exhaustion", async () => {
    const session = makeSession();
    seedBig(session, 20, 10_000);

    // First page before m10: budget ~3 messages.
    const p1 = await session.pageScrollback("m10", 33_000);
    expect(p1.source).toBe("buffer");
    expect(p1.messages.map((m) => m.messageId)).toEqual(["m7", "m8", "m9"]);
    expect(p1.hasMore).toBe(true);

    // Keep walking to the very beginning.
    const p2 = await session.pageScrollback("m7", 1024 * 1024);
    expect(p2.messages.map((m) => m.messageId)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
    expect(p2.hasMore).toBe(false);

    // Anchor at the true beginning: cleanly done.
    const p3 = await session.pageScrollback("m0", 1024 * 1024);
    expect(p3.messages).toEqual([]);
    expect(p3.hasMore).toBe(false);
  });

  it("falls back to the on-disk transcript when the anchor predates the buffer", async () => {
    const session = makeSession();
    // Disk: m0..m9 persisted; buffer: only m5..m9 (restart-style truncation).
    for (let i = 0; i < 10; i++) {
      await transcriptStore.append(session.id, msg(`m${i}`, `body ${i}`, session.id), i);
    }
    session.restoreScrollback(
      Array.from({ length: 5 }, (_, i) => msg(`m${i + 5}`, `body ${i + 5}`, session.id)),
      10,
      undefined,
      { partialHistory: true },
    );

    // Anchor at the buffer floor: buffer can't serve older — disk can.
    const page = await session.pageScrollback("m5", 1024 * 1024);
    expect(page.source).toBe("transcript");
    expect(page.messages.map((m) => m.messageId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(page.hasMore).toBe(false);

    // Anchor deep in disk history pages from disk too.
    const deep = await session.pageScrollback("m3", 1024 * 1024);
    expect(deep.source).toBe("transcript");
    expect(deep.messages.map((m) => m.messageId)).toEqual(["m0", "m1", "m2"]);
  });

  it("unknown anchor ends paging instead of scanning unbounded history", async () => {
    const session = makeSession();
    session.restoreScrollback([msg("a", "hi", session.id)]);
    const page = await session.pageScrollback("not-a-message", 1024);
    expect(page).toEqual({ messages: [], hasMore: false, source: "transcript" });
  });
});

// ── SessionManager dispatch ──────────────────────────────────────────────────

describe("SessionManager scrollback.page", () => {
  function makeManager(): SessionManager {
    const registry = new ProviderRegistry("claude");
    registry.register({
      id: "claude",
      displayName: "claude",
      create: () => new MockSessionProvider("claude"),
    });
    return new SessionManager(store, transcriptStore, undefined, undefined, undefined, {
      providers: registry,
    });
  }

  function client(auth: AuthContext): AttachedClient & { received: DaemonMessage[] } {
    const received: DaemonMessage[] = [];
    return { id: randomUUID(), auth, received, send: (m) => received.push(m) };
  }

  it("serves pages, enforces scope, rejects foreign sessions", async () => {
    const manager = makeManager();
    const c = client(TEST_AUTH);
    const created = (await manager.handle(
      { type: "session.create", id: "r1", name: "paged", workdir: tmp },
      TEST_AUTH,
      c,
    )) as { data: { id: string } };
    const sessionId = created.data.id;
    const session = manager.findByName("paged", TEST_AUTH)!;
    session.restoreScrollback(
      Array.from({ length: 6 }, (_, i) => msg(`m${i}`, `c${i}`, sessionId)),
    );

    const ok = (await manager.handle(
      { type: "scrollback.page", id: "r2", sessionId, beforeMessageId: "m4" },
      TEST_AUTH,
      c,
    )) as ScrollbackPageResultMsg;
    expect(ok.type).toBe("scrollback.page.result");
    expect(ok.requestId).toBe("r2");
    expect(ok.messages.map((m) => m.messageId)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(ok.hasMore).toBe(false);

    // Missing scope → forbidden.
    const noScope = await manager.handle(
      { type: "scrollback.page", id: "r3", sessionId, beforeMessageId: "m4" },
      { ...TEST_AUTH, scopes: [] },
      c,
    );
    expect(noScope).toMatchObject({ type: "response.error", code: "forbidden" });

    // Another tenant's session → not found (never existence-leaks).
    const foreign = await manager.handle(
      { type: "scrollback.page", id: "r4", sessionId, beforeMessageId: "m4" },
      { ...TEST_AUTH, accountId: "other-acc" },
      c,
    );
    expect(foreign).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("with no anchor, serves the NEWEST page, and its oldest id pages on back", async () => {
    // A caller that never attached (the /mcp/control endpoint, a one-shot
    // CLI) holds no message to anchor on.
    const manager = makeManager();
    const c = client(TEST_AUTH);
    const created = (await manager.handle(
      { type: "session.create", id: "n1", name: "newest", workdir: tmp },
      TEST_AUTH,
      c,
    )) as { data: { id: string } };
    const sessionId = created.data.id;
    const session = manager.findByName("newest", TEST_AUTH)!;
    session.restoreScrollback(Array.from({ length: 6 }, (_, i) => msg(`m${i}`, `c${i}`, sessionId)));
    const one = JSON.stringify(msg("m0", "c0", sessionId)).length;

    const newest = (await manager.handle(
      { type: "scrollback.page", id: "n2", sessionId, maxBytes: one * 2 + 10 },
      TEST_AUTH,
      c,
    )) as ScrollbackPageResultMsg;
    // A newest SUFFIX of the history, smaller than all of it.
    const ids = newest.messages.map((m) => m.messageId);
    const all = ["m0", "m1", "m2", "m3", "m4", "m5"];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(all.length);
    expect(ids).toEqual(all.slice(all.length - ids.length));
    expect(newest.hasMore).toBe(true);

    // Its oldest id pages back to exactly the rest — no gap, no overlap.
    const older = (await manager.handle(
      { type: "scrollback.page", id: "n3", sessionId, beforeMessageId: ids[0]!, maxBytes: 1024 * 1024 },
      TEST_AUTH,
      c,
    )) as ScrollbackPageResultMsg;
    expect([...older.messages.map((m) => m.messageId), ...ids]).toEqual(all);

    // Same scope + tenancy gate as an anchored page.
    const noScope = await manager.handle({ type: "scrollback.page", id: "n4", sessionId }, { ...TEST_AUTH, scopes: [] }, c);
    expect(noScope).toMatchObject({ type: "response.error", code: "forbidden" });
    const foreign = await manager.handle({ type: "scrollback.page", id: "n5", sessionId }, { ...TEST_AUTH, accountId: "other-acc" }, c);
    expect(foreign).toMatchObject({ type: "response.error", code: "not_found" });
  });
});
