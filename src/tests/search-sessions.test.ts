/**
 * MemoryEngine.searchSessions() tests — verify hybrid retrieval returns
 * session-grouped results, FTS5 catches exact keywords, evidence snippets
 * are query-centered, and session-name boost works.
 *
 * Uses a stub embedder (same pattern as memory.test.ts) so the suite is
 * deterministic + offline.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteEpisodeStore,
  MemoryEngine,
} from "../daemon/memory/index.js";
import type { Embedder } from "../daemon/memory/embedder.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub";
  readonly dimensions = 8;
  async init(): Promise<void> {}
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
  async close(): Promise<void> {}
}

let tmp: string;
let dbPath: string;
let store: SqliteEpisodeStore;
let engine: MemoryEngine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-search-"));
  dbPath = join(tmp, "mem.db");
  store = new SqliteEpisodeStore(dbPath);
  engine = new MemoryEngine({ store, embedder: new StubEmbedder() });
  await engine.init();
});

afterEach(async () => {
  try { await engine.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const WS = "ws_test";

function insert(
  sessionId: string,
  kind: "user_turn" | "assistant_turn" | "tool_call",
  summary: string,
  content: string,
  opts: { filePaths?: string[]; toolName?: string; createdAt?: number } = {},
): void {
  engine.ingest({
    workspaceId: WS,
    sessionId,
    kind,
    toolName: opts.toolName,
    summary,
    content,
    filePaths: opts.filePaths ?? [],
    tokenEstimate: Math.ceil(content.length / 4),
    createdAt: opts.createdAt ?? Date.now(),
    createdBy: "user:test",
  });
}

describe("searchSessions — basics", () => {
  it("empty workspace returns []", async () => {
    const hits = await engine.searchSessions({
      query: "anything",
      workspaceId: WS,
    });
    expect(hits).toEqual([]);
  });

  it("FTS5 catches exact keyword across session content (not name)", async () => {
    insert("sess-1", "user_turn", "initial question", "how do I debug the jwtValidator function");
    insert("sess-1", "assistant_turn", "reply", "you should check the jwtValidator at src/auth.ts");
    insert("sess-2", "user_turn", "initial question", "what does the cache eviction policy look like");
    await engine.drain();

    const hits = await engine.searchSessions({
      query: "jwtValidator",
      workspaceId: WS,
    });
    expect(hits.length).toBeGreaterThan(0);
    // Session 1 has the exact keyword in both user + assistant content.
    const top = hits[0]!;
    expect(top.sessionId).toBe("sess-1");
    expect(top.matchCount).toBeGreaterThanOrEqual(1);
  });

  it("groups episodes by session — one row per session", async () => {
    for (let i = 0; i < 5; i++) {
      insert("sess-A", "user_turn", `msg ${i}`, "docker compose setup");
      insert("sess-B", "assistant_turn", `reply ${i}`, "docker compose setup");
    }
    await engine.drain();

    const hits = await engine.searchSessions({
      query: "docker compose",
      workspaceId: WS,
    });
    // Both sessions, deduplicated — not 10 rows.
    expect(hits.length).toBe(2);
    const ids = new Set(hits.map((h) => h.sessionId));
    expect(ids.has("sess-A")).toBe(true);
    expect(ids.has("sess-B")).toBe(true);
  });
});

describe("searchSessions — ranking", () => {
  it("match count influences rank (many matches > single match)", async () => {
    insert("sess-dense", "user_turn", "q1", "tailwind tailwind tailwind tailwind");
    for (let i = 0; i < 6; i++) {
      insert("sess-dense", "assistant_turn", `reply ${i}`, "tailwind config");
    }
    insert("sess-sparse", "user_turn", "q1", "one mention of tailwind here");
    await engine.drain();

    const hits = await engine.searchSessions({
      query: "tailwind",
      workspaceId: WS,
    });
    // Dense session ranks above sparse session.
    const denseIdx = hits.findIndex((h) => h.sessionId === "sess-dense");
    const sparseIdx = hits.findIndex((h) => h.sessionId === "sess-sparse");
    expect(denseIdx).toBeGreaterThanOrEqual(0);
    expect(sparseIdx).toBeGreaterThanOrEqual(0);
    expect(denseIdx).toBeLessThan(sparseIdx);
    expect(hits[denseIdx]!.matchCount).toBeGreaterThan(hits[sparseIdx]!.matchCount);
  });

  it("session-name boost surfaces a session with matching name", async () => {
    // Both sessions have ONE episode mentioning 'kafka'.
    insert("sess-x", "user_turn", "chat", "one mention of kafka in here");
    insert("sess-y", "user_turn", "chat", "one mention of kafka in here");
    await engine.drain();

    const noBoost = await engine.searchSessions({
      query: "kafka",
      workspaceId: WS,
    });

    const boosted = await engine.searchSessions({
      query: "kafka",
      workspaceId: WS,
      sessionNames: new Map([
        ["sess-x", "kafka-debug-session"],
        ["sess-y", "generic-workstream"],
      ]),
    });

    // Without names both are tied-ish; with name boost, x rises above y.
    const boostedIds = boosted.map((h) => h.sessionId);
    const xIdx = boostedIds.indexOf("sess-x");
    const yIdx = boostedIds.indexOf("sess-y");
    expect(xIdx).toBeGreaterThanOrEqual(0);
    expect(yIdx).toBeGreaterThanOrEqual(0);
    expect(xIdx).toBeLessThan(yIdx);
    // Score reflects the boost.
    expect(boosted[xIdx]!.aggregateScore).toBeGreaterThan(
      noBoost.find((h) => h.sessionId === "sess-x")!.aggregateScore,
    );
  });
});

describe("searchSessions — snippets", () => {
  it("returns query-centered excerpt when a literal term is found", async () => {
    const long =
      `${"lorem ipsum ".repeat(40)}the real answer is in authentication flow ${"dolor sit amet ".repeat(40)}`;
    insert("sess-1", "assistant_turn", "big reply", long);
    await engine.drain();

    const hits = await engine.searchSessions({
      query: "authentication flow",
      workspaceId: WS,
    });
    expect(hits.length).toBe(1);
    const snip = hits[0]!.snippets[0]!.excerpt;
    expect(snip).toContain("authentication flow");
    // Should have ellipses when truncated around the match.
    expect(snip.startsWith("…") || snip.endsWith("…")).toBe(true);
  });

  it("honors snippetsPerSession limit", async () => {
    for (let i = 0; i < 10; i++) {
      insert("sess-1", "assistant_turn", `reply ${i}`, "typescript compile error");
    }
    await engine.drain();
    const hits = await engine.searchSessions({
      query: "typescript compile",
      workspaceId: WS,
      snippetsPerSession: 2,
    });
    expect(hits[0]!.snippets.length).toBeLessThanOrEqual(2);
  });

  it("each snippet carries kind, createdAt, and score", async () => {
    insert("sess-1", "tool_call", "Read src/auth.ts", "content of auth file", {
      toolName: "Read",
    });
    await engine.drain();
    const hits = await engine.searchSessions({
      query: "auth",
      workspaceId: WS,
    });
    const s = hits[0]!.snippets[0]!;
    expect(s.kind).toBe("tool_call");
    expect(s.toolName).toBe("Read");
    expect(typeof s.score).toBe("number");
    expect(typeof s.createdAt).toBe("number");
    expect(typeof s.episodeId).toBe("string");
  });
});

describe("searchSessions — limit + workspace scope", () => {
  it("honors the limit parameter", async () => {
    for (let i = 0; i < 6; i++) {
      insert(`sess-${i}`, "user_turn", "q", "findme");
    }
    await engine.drain();
    const hits = await engine.searchSessions({
      query: "findme",
      workspaceId: WS,
      limit: 3,
    });
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it("workspace scope isolates results — a different workspace's content doesn't leak in", async () => {
    insert("sess-1", "user_turn", "q", "unique_marker_string");
    // Also insert into a DIFFERENT workspace.
    engine.ingest({
      workspaceId: "other_workspace",
      sessionId: "sess-2",
      kind: "user_turn",
      summary: "q",
      content: "unique_marker_string",
      filePaths: [],
      tokenEstimate: 10,
      createdAt: Date.now(),
      createdBy: "user:test",
    });
    await engine.drain();

    const scoped = await engine.searchSessions({
      query: "unique_marker_string",
      workspaceId: WS,
    });
    // Only the WS-scoped session is returned; other_workspace is filtered out.
    expect(scoped.length).toBe(1);
    expect(scoped[0]!.sessionId).toBe("sess-1");
  });
});

// ── SessionManager #search scope plumbing ────────────────────────────────────
//
// Regression guard: `scope: "all"` used to pass `workspaceId: ""` to the
// engine — which selects a nonexistent EMPTY workspace, so global search
// always returned zero hits. Global means OMITTING workspaceId entirely
// (the engine treats undefined as "every workspace").
describe("SessionManager session.search scope plumbing", () => {
  it('scope:"all" omits workspaceId; scope:"workspace" passes one', async () => {
    const { SessionManager } = await import("../daemon/session-manager.js");
    const { Store } = await import("../daemon/store.js");
    const { TranscriptStore } = await import("../daemon/transcript.js");

    const dir = mkdtempSync(join(tmpdir(), "codeoid-search-scope-"));
    const store = new Store(join(dir, "db.sqlite"));
    const transcript = new TranscriptStore(join(dir, "transcripts"));

    const calls: Array<Record<string, unknown>> = [];
    const fakeMemory = {
      searchSessions: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return [];
      },
    } as unknown as MemoryEngine;

    const manager = new SessionManager(
      store,
      transcript,
      undefined,
      undefined,
      fakeMemory,
    );
    const auth = {
      sub: "user:t",
      scopes: ["session:list"],
      delegationDepth: 0,
      accountId: "acc",
      projectId: "proj",
    };
    const fakeClient = {
      id: "c1",
      auth,
      send: () => {},
    };

    await manager.handle(
      { type: "session.search", id: "r1", query: "auth bug", scope: "all" } as never,
      auth as never,
      fakeClient as never,
    );
    expect(calls.length).toBe(1);
    expect("workspaceId" in calls[0]!).toBe(false);

    await manager.handle(
      {
        type: "session.search",
        id: "r2",
        query: "auth bug",
        scope: "workspace",
        workdir: dir,
      } as never,
      auth as never,
      fakeClient as never,
    );
    expect(calls.length).toBe(2);
    expect(typeof calls[1]!.workspaceId).toBe("string");
    expect((calls[1]!.workspaceId as string).length).toBeGreaterThan(0);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scope:"workspace" with no resolvable anchor falls back to cross-workspace', async () => {
    // The protocol documents this fallback: when scope="workspace" and no
    // workdir is supplied, the daemon infers from caller focus — and with no
    // focus either, searches every workspace. Previously it passed
    // workspaceId:"" which matched a workspace that does not exist, so the
    // search silently returned zero hits instead of falling back.
    const { SessionManager } = await import("../daemon/session-manager.js");
    const { Store } = await import("../daemon/store.js");
    const { TranscriptStore } = await import("../daemon/transcript.js");

    const dir = mkdtempSync(join(tmpdir(), "codeoid-search-fallback-"));
    const store = new Store(join(dir, "db.sqlite"));
    const transcript = new TranscriptStore(join(dir, "transcripts"));

    const calls: Array<Record<string, unknown>> = [];
    const fakeMemory = {
      searchSessions: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return [];
      },
    } as unknown as MemoryEngine;

    const manager = new SessionManager(store, transcript, undefined, undefined, fakeMemory);
    const auth = {
      sub: "user:t",
      scopes: ["session:list"],
      delegationDepth: 0,
      accountId: "acc",
      projectId: "proj",
    };
    // No sessions exist, so #guessCallerWorkdir has nothing to anchor on.
    const fakeClient = { id: "c1", auth, send: () => {} };

    await manager.handle(
      { type: "session.search", id: "r1", query: "auth bug", scope: "workspace" } as never,
      auth as never,
      fakeClient as never,
    );

    expect(calls.length).toBe(1);
    expect("workspaceId" in calls[0]!).toBe(false);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
