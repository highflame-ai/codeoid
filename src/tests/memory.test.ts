/**
 * Smoke test for the memory module.
 *
 * Exercises: store → chunker → engine → ranker, with a stub embedder so the
 * test runs fast and offline. Verifies:
 *   - FTS5 triggers fire (keyword search returns the right episode)
 *   - Embedding BLOB roundtrips through SQLite cleanly
 *   - Ranker combines signals and returns episodes sorted by score
 *   - Chunker emits one tool_call episode per completed tool invocation
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteEpisodeStore,
  MemoryEngine,
  EpisodeChunker,
  workspaceIdFromPath,
  legacyWorkspaceIdFromPath,
} from "../daemon/memory/index.js";
import type { Embedder } from "@highflame/codeoid-memory/embedder.js";
import type { SessionMessage, TurnUsage } from "../protocol/types.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub-embed";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    // Deterministic pseudo-embeddings from text hash — same input → same vector.
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) {
        v[i % this.dimensions]! += t.charCodeAt(i) / 1000;
      }
      // L2-normalize.
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-memory-"));
  dbPath = join(tmp, "memory.db");
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe("SqliteEpisodeStore", () => {
  it("round-trips an episode with embedding BLOB", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const saved = store.insert({
      workspaceId: "ws_test",
      sessionId: "sess1",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read src/foo.ts",
      content: "user: look at foo\n\nTool: Read\nInput: src/foo.ts\nResult: contents...",
      filePaths: ["src/foo.ts"],
      tokenEstimate: 42,
      embedding: vec,
      embeddingModel: "stub",
      createdAt: Date.now(),
      createdBy: "user:yash",
    });

    const fetched = store.getEpisode(saved.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.summary).toBe("Read src/foo.ts");
    expect(fetched!.filePaths).toEqual(["src/foo.ts"]);
    expect(fetched!.embedding).toBeDefined();
    // Float32 precision — use closeTo rather than exact equality.
    const roundtripped = Array.from(fetched!.embedding!);
    expect(roundtripped.length).toBe(4);
    expect(roundtripped[0]!).toBeCloseTo(0.1, 5);
    expect(roundtripped[1]!).toBeCloseTo(0.2, 5);
    expect(roundtripped[2]!).toBeCloseTo(0.3, 5);
    expect(roundtripped[3]!).toBeCloseTo(0.4, 5);

    store.close();
  });

  it("FTS5 keyword search returns matching episodes", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.insert({
      workspaceId: "ws_test",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Bash",
      summary: "npm install",
      content: "Tool: Bash\nInput: npm install express",
      filePaths: [],
      tokenEstimate: 10,
      createdAt: Date.now(),
      createdBy: "u",
    });
    store.insert({
      workspaceId: "ws_test",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read package.json",
      content: "Tool: Read\nInput: package.json",
      filePaths: ["package.json"],
      tokenEstimate: 5,
      createdAt: Date.now(),
      createdBy: "u",
    });

    const hits = store.ftsSearch("ws_test", "express install", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.bm25).toBeLessThan(0); // bm25 uses negative scores (more negative = more relevant)

    store.close();
  });
});

describe("MemoryEngine.recall excludeSessionId", () => {
  it("excludes episodes from the caller's own session", async () => {
    const store = new SqliteEpisodeStore(dbPath);
    const embedder = new StubEmbedder();
    const engine = new MemoryEngine({ store, embedder });
    await engine.init();

    const now = Date.now();
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "current",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read from current session",
      content: "auth.ts contents from current session",
      filePaths: ["auth.ts"],
      tokenEstimate: 10,
      createdAt: now,
      createdBy: "u",
    });
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "prior",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read from prior session",
      content: "auth.ts contents from prior session",
      filePaths: ["auth.ts"],
      tokenEstimate: 10,
      createdAt: now - 1000,
      createdBy: "u",
    });

    await engine.drain();

    const withCurrent = await engine.recall({
      query: "auth contents",
      workspaceId: "ws_a",
      limit: 5,
    });
    const withoutCurrent = await engine.recall({
      query: "auth contents",
      workspaceId: "ws_a",
      excludeSessionId: "current",
      limit: 5,
    });

    expect(withCurrent.some((h) => h.episode.sessionId === "current")).toBe(true);
    expect(withoutCurrent.some((h) => h.episode.sessionId === "current")).toBe(false);
    expect(withoutCurrent.every((h) => h.episode.sessionId === "prior")).toBe(true);

    await engine.close();
  });
});

describe("MemoryEngine.recall", () => {
  it("ranks by hybrid vector + FTS + recency", async () => {
    const store = new SqliteEpisodeStore(dbPath);
    const embedder = new StubEmbedder();
    const engine = new MemoryEngine({ store, embedder });
    await engine.init();

    const now = Date.now();
    // Recent, relevant
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Read",
      summary: "Read auth.ts",
      content: "Tool: Read\nInput: auth.ts\nResult: oauth flow implementation",
      filePaths: ["src/auth.ts"],
      tokenEstimate: 20,
      createdAt: now - 1000,
      createdBy: "u",
    });
    // Old, unrelated
    engine.ingest({
      workspaceId: "ws_a",
      sessionId: "s1",
      kind: "tool_call",
      toolName: "Bash",
      summary: "ls -la",
      content: "Tool: Bash\nInput: ls -la\nResult: file listing",
      filePaths: [],
      tokenEstimate: 10,
      createdAt: now - 1000 * 60 * 60 * 24 * 30, // 30 days old
      createdBy: "u",
    });

    await engine.drain();

    const hits = await engine.recall({
      query: "oauth flow",
      workspaceId: "ws_a",
      limit: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.episode.toolName).toBe("Read"); // the relevant + recent one wins

    await engine.close();
  });
});

const TENANT_A = { accountId: "acc-a", projectId: "proj-a" };
const TENANT_B = { accountId: "acc-b", projectId: "proj-b" };

describe("workspaceIdFromPath", () => {
  it("returns the same ID for different subdirs of the same repo (same tenant)", () => {
    // Use the actual repo this test runs in (process.cwd() is the repo root,
    // which is a git repo) rather than a hardcoded path that may not exist on
    // every machine — the prior literal `/Workspace/codeoid` made git
    // rev-parse fail and fall back to path-hashing, so the IDs diverged.
    const mainRepo = process.cwd();
    const srcSubdir = join(process.cwd(), "src");
    const mainId = workspaceIdFromPath(mainRepo, TENANT_A);
    const subdirId = workspaceIdFromPath(srcSubdir, TENANT_A);
    // Same git repo, different subdirectory → same workspace (anchored on git-common-dir).
    expect(mainId).toBe(subdirId);
  });

  it("returns different IDs for unrelated directories", () => {
    const a = workspaceIdFromPath("/tmp", TENANT_A);
    const b = workspaceIdFromPath("/home", TENANT_A);
    expect(a).not.toBe(b);
  });

  it("falls back to path hash for non-git dirs", () => {
    const id = workspaceIdFromPath("/tmp", TENANT_A);
    expect(id).toMatch(/^ws_[a-f0-9]{16}$/);
  });

  it("is stable for the same (path, tenant)", () => {
    expect(workspaceIdFromPath("/tmp/p", TENANT_A)).toBe(
      workspaceIdFromPath("/tmp/p", TENANT_A),
    );
  });

  it("returns DIFFERENT ids for the same path under different tenants", () => {
    // The core isolation property: two accounts working the same directory
    // must not collide on a workspace id (else one's recall reads the other's).
    expect(workspaceIdFromPath("/tmp/p", TENANT_A)).not.toBe(
      workspaceIdFromPath("/tmp/p", TENANT_B),
    );
    // account and project each independently affect the id.
    expect(
      workspaceIdFromPath("/tmp/p", { accountId: "x", projectId: "1" }),
    ).not.toBe(workspaceIdFromPath("/tmp/p", { accountId: "x", projectId: "2" }));
    expect(
      workspaceIdFromPath("/tmp/p", { accountId: "x", projectId: "1" }),
    ).not.toBe(workspaceIdFromPath("/tmp/p", { accountId: "y", projectId: "1" }));
  });

  it("memoizes per (path, tenant): a repeat lookup skips re-derivation", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-memo-"));
    try {
      const before = workspaceIdFromPath(dir, TENANT_A);
      // Turning the directory into a git repo would change a FRESH derivation
      // (git-common-dir anchor instead of path hash)…
      execSync("git init", { cwd: dir, stdio: "ignore" });
      // …but the repeat lookup serves the memoized id — stable within a
      // daemon lifetime, the same trade-off Session makes by capturing
      // #workspaceId once at construction.
      expect(workspaceIdFromPath(dir, TENANT_A)).toBe(before);
      // A different tenant is a different cache key → fresh derivation
      // (which sees the git repo), and tenant isolation still holds.
      expect(workspaceIdFromPath(dir, TENANT_B)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace-id migration (re-key legacy episodes to tenant)", () => {
  function insertEp(
    store: SqliteEpisodeStore,
    workspaceId: string,
    sessionId: string,
    summary: string,
  ) {
    return store.insert({
      workspaceId,
      sessionId,
      kind: "user_turn",
      summary,
      content: `${summary} — body`,
      filePaths: [],
      tokenEstimate: 10,
      createdAt: Date.now(),
      createdBy: sessionId,
    });
  }
  const sess = (id: string, workdir: string, t: typeof TENANT_A) => ({
    id,
    workdir,
    accountId: t.accountId,
    projectId: t.projectId,
  });

  it("re-keys a session's legacy episodes to the tenant-scoped id, once", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const workdir = "/tmp/legacy-proj";
    const oldWs = legacyWorkspaceIdFromPath(workdir);
    const newWs = workspaceIdFromPath(workdir, TENANT_A);
    expect(oldWs).not.toBe(newWs);

    const ep = insertEp(store, oldWs, "s1", "did a thing");
    expect(store.listRecent(newWs, 10)).toHaveLength(0); // invisible pre-migration
    expect(store.needsWorkspaceMigration()).toBe(true);

    const r = store.migrateWorkspaceIdsToTenant([sess("s1", workdir, TENANT_A)], workspaceIdFromPath);
    expect(r.migrated).toBe(true);
    expect(store.needsWorkspaceMigration()).toBe(false); // guard flips after run
    expect(r.reKeyed).toBeGreaterThanOrEqual(1);

    // Visible under the tenant-scoped id now; gone from the old id.
    expect(store.listRecent(newWs, 10).map((e) => e.id)).toEqual([ep.id]);
    expect(store.listRecent(oldWs, 10)).toHaveLength(0);

    // Guarded — a second run is a no-op.
    expect(store.migrateWorkspaceIdsToTenant([sess("s1", workdir, TENANT_A)], workspaceIdFromPath).migrated).toBe(false);
    store.close();
  });

  it("keeps two tenants that shared a directory separate", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const workdir = "/tmp/shared-checkout";
    const oldWs = legacyWorkspaceIdFromPath(workdir);
    const epA = insertEp(store, oldWs, "sa", "tenant A secret");
    const epB = insertEp(store, oldWs, "sb", "tenant B secret");

    store.migrateWorkspaceIdsToTenant(
      [sess("sa", workdir, TENANT_A), sess("sb", workdir, TENANT_B)],
      workspaceIdFromPath,
    );

    expect(store.listRecent(workspaceIdFromPath(workdir, TENANT_A), 10).map((e) => e.id)).toEqual([epA.id]);
    expect(store.listRecent(workspaceIdFromPath(workdir, TENANT_B), 10).map((e) => e.id)).toEqual([epB.id]);
    store.close();
  });

  it("recovers an orphan (destroyed session) only when its workspace is single-tenant", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const soloDir = "/tmp/solo-proj";
    const sharedDir = "/tmp/shared-proj";
    const soloOrphan = insertEp(store, legacyWorkspaceIdFromPath(soloDir), "gone-1", "solo orphan");
    const sharedOrphan = insertEp(store, legacyWorkspaceIdFromPath(sharedDir), "gone-2", "shared orphan");

    store.migrateWorkspaceIdsToTenant(
      [
        sess("s-solo", soloDir, TENANT_A), // single tenant → orphan recovered
        sess("s-shared-a", sharedDir, TENANT_A), // two tenants on sharedDir →
        sess("s-shared-b", sharedDir, TENANT_B), // ambiguous → orphan left alone
      ],
      workspaceIdFromPath,
    );

    expect(store.listRecent(workspaceIdFromPath(soloDir, TENANT_A), 10).map((e) => e.id)).toContain(soloOrphan.id);
    expect(store.getEpisode(sharedOrphan.id)!.workspaceId).toBe(legacyWorkspaceIdFromPath(sharedDir));
    store.close();
  });
});

describe("tenant isolation (episode store + engine)", () => {
  function makeEpisode(workspaceId: string, sessionId: string, summary: string) {
    return {
      workspaceId,
      sessionId,
      kind: "user_turn" as const,
      summary,
      content: `${summary} — secret body for ${sessionId}`,
      filePaths: [],
      tokenEstimate: 10,
      createdAt: Date.now(),
      createdBy: sessionId,
    };
  }

  it("does not leak episodes across tenants sharing a directory", async () => {
    // Same workdir, two tenants → two distinct workspace ids.
    const workdir = "/tmp/shared-checkout";
    const wsA = workspaceIdFromPath(workdir, TENANT_A);
    const wsB = workspaceIdFromPath(workdir, TENANT_B);
    expect(wsA).not.toBe(wsB);

    const store = new SqliteEpisodeStore(dbPath);
    const engine = new MemoryEngine({ store, embedder: new StubEmbedder() });
    await engine.init();

    // Tenant A ingests a sensitive episode.
    engine.ingest(makeEpisode(wsA, "sess-a", "read the API key from config"));
    await engine.drain();

    // Tenant B recalls in the SAME directory → sees nothing of A's.
    const bHits = await engine.recall({ query: "API key", workspaceId: wsB });
    expect(bHits).toHaveLength(0);
    expect(engine.timeline(wsB)).toHaveLength(0);
    expect(store.listRecent(wsB, 10)).toHaveLength(0);
    expect(store.ftsSearch(wsB, "API key", 10)).toHaveLength(0);

    // Tenant A still recalls its own episode.
    const aHits = await engine.recall({ query: "API key", workspaceId: wsA });
    expect(aHits.length).toBeGreaterThan(0);
    expect(aHits[0]!.episode.content).toContain("secret body for sess-a");

    await engine.close();
  });
});

describe("SqliteEpisodeStore — vector cache incrementality", () => {
  const WS = "ws_veccache";

  function makeEpisode(summary: string, embedding?: Float32Array) {
    return {
      workspaceId: WS,
      sessionId: "sess-vec",
      kind: "user_turn" as const,
      summary,
      content: summary,
      filePaths: [],
      tokenEstimate: 5,
      embedding,
      embeddingModel: embedding ? "stub" : undefined,
      createdAt: Date.now(),
      createdBy: "u",
    };
  }

  it("setEmbedding extends a built matrix in place instead of clearing it", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.insert(makeEpisode("first", new Float32Array([1, 0, 0, 0])));
    const matrix = store.loadVectorMatrix(WS);
    expect(matrix.ids).toHaveLength(1);

    const ep2 = store.insert(makeEpisode("second"));
    store.setEmbedding(ep2.id, new Float32Array([0, 1, 0, 0]), "stub", WS);

    // Same object — the cache survived the write — and it has the new row.
    const after = store.loadVectorMatrix(WS);
    expect(after).toBe(matrix);
    expect(after.ids).toEqual([after.ids[0]!, ep2.id]);
    expect(Array.from(after.vectors[1]!)).toEqual([0, 1, 0, 0]);

    // The cached rows match what a cold rebuild would read from SQLite.
    // (Row ORDER differs — the rebuild SELECT is unordered — but recall's
    // cosine scan is order-independent, so compare by id.)
    const cold = new SqliteEpisodeStore(dbPath);
    const rebuilt = cold.loadVectorMatrix(WS);
    expect([...rebuilt.ids].sort()).toEqual([...after.ids].sort());
    expect(Array.from(rebuilt.vectors[rebuilt.ids.indexOf(ep2.id)]!)).toEqual([0, 1, 0, 0]);
    cold.close();
    store.close();
  });

  it("insert with embedding appends to a built matrix", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.insert(makeEpisode("first", new Float32Array([1, 0])));
    const matrix = store.loadVectorMatrix(WS);

    const ep2 = store.insert(makeEpisode("second", new Float32Array([0.5, 0.5])));

    const after = store.loadVectorMatrix(WS);
    expect(after).toBe(matrix);
    expect(after.ids).toHaveLength(2);
    expect(after.ids[1]).toBe(ep2.id);
    expect(Array.from(after.vectors[1]!)).toEqual([0.5, 0.5]);
    store.close();
  });

  it("re-embedding an episode replaces its cached vector without duplicating", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const ep = store.insert(makeEpisode("first", new Float32Array([1, 0])));
    const matrix = store.loadVectorMatrix(WS);

    store.setEmbedding(ep.id, new Float32Array([0, 1]), "stub-v2", WS);

    const after = store.loadVectorMatrix(WS);
    expect(after).toBe(matrix);
    expect(after.ids).toEqual([ep.id]);
    expect(Array.from(after.vectors[0]!)).toEqual([0, 1]);
    store.close();
  });

  it("caches nothing until the first load, then reads new rows from SQLite", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const ep = store.insert(makeEpisode("first"));
    // No matrix built yet — this write must not conjure a partial cache.
    store.setEmbedding(ep.id, new Float32Array([1, 0]), "stub", WS);

    const matrix = store.loadVectorMatrix(WS);
    expect(matrix.ids).toEqual([ep.id]);
    expect(Array.from(matrix.vectors[0]!)).toEqual([1, 0]);
    store.close();
  });

  it("copies the vector so later caller mutation can't desync the cache", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const ep = store.insert(makeEpisode("first", new Float32Array([1, 0])));
    store.loadVectorMatrix(WS);

    const v = new Float32Array([0, 1]);
    store.setEmbedding(ep.id, v, "stub", WS);
    v[0] = 99;

    expect(Array.from(store.loadVectorMatrix(WS).vectors[0]!)).toEqual([0, 1]);
    store.close();
  });
});

describe("EpisodeChunker", () => {
  it("emits one tool_call episode per completed tool invocation", () => {
    const emitted: Array<{ kind: string; toolName?: string; summary: string }> = [];
    const chunker = new EpisodeChunker(
      {
        workspaceId: workspaceIdFromPath("/tmp/project", TENANT_A),
        sessionId: "s1",
        createdBy: "u",
      },
      (ep) => emitted.push({ kind: ep.kind, toolName: ep.toolName, summary: ep.summary }),
    );

    const t = new Date().toISOString();

    // User message
    chunker.onMessage(msg("m1", "user", "please read foo.ts", t));
    // Tool call starts
    chunker.onMessage(
      msgTool("m2", "Read", { phase: "executing" }, { file_path: "foo.ts" }, t),
    );
    // Tool call completes
    chunker.onMessage(
      msgTool(
        "m2",
        "Read",
        { phase: "completed", success: true, output: "file contents" },
        { file_path: "foo.ts" },
        t,
      ),
    );
    // Assistant reply
    chunker.onMessage(msg("m3", "assistant", "Here's the content.", t));
    chunker.onTurnEnd();

    expect(emitted.length).toBe(2);
    expect(emitted[0]!.kind).toBe("tool_call");
    expect(emitted[0]!.toolName).toBe("Read");
    // Second episode is a user_turn — the pending user prompt + final assistant reply
    // get merged into one episode keyed by user intent.
    expect(emitted[1]!.kind).toBe("user_turn");
  });

  it("caps persisted tool output — a 10 MB build log must not enter the episode row", () => {
    // The episode insert (and its FTS tokenization) runs on the shared
    // event path; an uncapped multi-MB output stalls every attached client
    // and grows the retention-less episodes DB without bound.
    const emitted: Array<{ content: string }> = [];
    const chunker = new EpisodeChunker(
      {
        workspaceId: workspaceIdFromPath("/tmp/project", TENANT_A),
        sessionId: "s1",
        createdBy: "u",
      },
      (ep) => emitted.push({ content: ep.content }),
    );
    const t = new Date().toISOString();
    const hugeOutput = "x".repeat(2 * 1024 * 1024); // 2 MiB

    chunker.onMessage(msg("m1", "user", "build it", t));
    chunker.onMessage(msgTool("m2", "Bash", { phase: "executing" }, { command: "make" }, t));
    chunker.onMessage(
      msgTool(
        "m2",
        "Bash",
        { phase: "completed", success: true, output: hugeOutput },
        { command: "make" },
        t,
      ),
    );
    chunker.onTurnEnd();

    const toolEpisode = emitted[0]!;
    // Mirrors the transcript layer's 64 KiB persist cap (+ small headers).
    expect(toolEpisode.content.length).toBeLessThan(70 * 1024);
    expect(toolEpisode.content).toContain("…truncated for memory…");
  });
});

// ── Usage analytics (dailyUsage / lifetimeTotals) ───────────────────────

function makeTurnInput(
  sessionId: string,
  turnNumber: number,
  overrides: Partial<TurnUsage> = {},
): Parameters<SqliteEpisodeStore["recordTurnUsage"]>[0] {
  const base: TurnUsage = {
    turnNumber,
    createdAt: Date.now(),
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0.001,
    durationMs: 500,
    totalInputTokens: 100,
    billableInputTokens: 100,
    cacheHitRate: 0,
    ...overrides,
  };
  return { workspaceId: "ws_analytics", sessionId, turn: base };
}

describe("SqliteEpisodeStore — dailyUsage", () => {
  it("returns empty array when no turns exist", () => {
    const store = new SqliteEpisodeStore(dbPath);
    expect(store.dailyUsage()).toEqual([]);
    store.close();
  });

  it("aggregates turns from the same day into one bucket", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1, { totalCostUsd: 0.01, inputTokens: 200, outputTokens: 100 }));
    store.recordTurnUsage(makeTurnInput("s-a", 2, { totalCostUsd: 0.02, inputTokens: 300, outputTokens: 150 }));
    store.recordTurnUsage(makeTurnInput("s-b", 1, { totalCostUsd: 0.005, inputTokens: 50, outputTokens: 25 }));

    const buckets = store.dailyUsage();
    expect(buckets.length).toBe(1);
    const b = buckets[0]!;
    expect(b.numTurns).toBe(3);
    expect(b.numSessions).toBe(2);
    expect(b.costUsd).toBeCloseTo(0.035, 6);
    expect(b.inputTokens).toBe(550);
    expect(b.outputTokens).toBe(275);
    expect(b.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    store.close();
  });

  it("filters to only the specified sessionIds", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1, { totalCostUsd: 0.01, inputTokens: 100, outputTokens: 50 }));
    store.recordTurnUsage(makeTurnInput("s-b", 1, { totalCostUsd: 0.02, inputTokens: 200, outputTokens: 100 }));

    const buckets = store.dailyUsage(30, ["s-a"]);
    expect(buckets.length).toBe(1);
    expect(buckets[0]!.numTurns).toBe(1);
    expect(buckets[0]!.numSessions).toBe(1);
    expect(buckets[0]!.costUsd).toBeCloseTo(0.01, 6);
    store.close();
  });

  it("filters across multiple sessionIds", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1, { totalCostUsd: 0.01 }));
    store.recordTurnUsage(makeTurnInput("s-b", 1, { totalCostUsd: 0.02 }));
    store.recordTurnUsage(makeTurnInput("s-c", 1, { totalCostUsd: 0.04 }));

    const buckets = store.dailyUsage(30, ["s-a", "s-b"]);
    expect(buckets[0]!.numTurns).toBe(2);
    expect(buckets[0]!.numSessions).toBe(2);
    expect(buckets[0]!.costUsd).toBeCloseTo(0.03, 6);
    store.close();
  });

  it("empty sessionIds array is a STRICT filter — returns no buckets (zero-session identity must not see everyone's usage)", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1));
    store.recordTurnUsage(makeTurnInput("s-b", 1));

    expect(store.dailyUsage(30, [])).toEqual([]);
    // undefined stays unscoped (internal callers).
    expect(store.dailyUsage(30, undefined)[0]?.numSessions).toBe(2);
    store.close();
  });

  it("returns empty when sessionIds filter matches nothing", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1));
    const buckets = store.dailyUsage(30, ["nonexistent"]);
    expect(buckets).toEqual([]);
    store.close();
  });

  it("scoping excludes other identities' sessions", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("mine-1", 1, { totalCostUsd: 0.01 }));
    store.recordTurnUsage(makeTurnInput("mine-2", 1, { totalCostUsd: 0.02 }));
    store.recordTurnUsage(makeTurnInput("theirs-1", 1, { totalCostUsd: 5 }));

    const buckets = store.dailyUsage(30, ["mine-1", "mine-2"]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.numSessions).toBe(2);
    expect(buckets[0]!.costUsd).toBeCloseTo(0.03, 6);
    store.close();
  });

  it("does not throw with more than 1000 session ids (old IN-list hit SQLite's variable limit)", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-500", 1, { totalCostUsd: 0.01 }));
    const ids = Array.from({ length: 2500 }, (_, i) => `s-${i}`);
    const buckets = store.dailyUsage(30, ids);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.numTurns).toBe(1);
    expect(buckets[0]!.costUsd).toBeCloseTo(0.01, 6);
    store.close();
  });
});

describe("SqliteEpisodeStore — lifetimeTotals", () => {
  it("returns zeros when no turns exist", () => {
    const store = new SqliteEpisodeStore(dbPath);
    const totals = store.lifetimeTotals();
    expect(totals.costUsd).toBe(0);
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(0);
    expect(totals.numTurns).toBe(0);
    expect(totals.numSessions).toBe(0);
    store.close();
  });

  it("sums all turns across all sessions", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1, { totalCostUsd: 0.01, inputTokens: 100, outputTokens: 50 }));
    store.recordTurnUsage(makeTurnInput("s-a", 2, { totalCostUsd: 0.02, inputTokens: 200, outputTokens: 100 }));
    store.recordTurnUsage(makeTurnInput("s-b", 1, { totalCostUsd: 0.005, inputTokens: 50, outputTokens: 25 }));

    const totals = store.lifetimeTotals();
    expect(totals.numTurns).toBe(3);
    expect(totals.numSessions).toBe(2);
    expect(totals.costUsd).toBeCloseTo(0.035, 6);
    expect(totals.inputTokens).toBe(350);
    expect(totals.outputTokens).toBe(175);
    store.close();
  });

  it("filters to the specified sessionIds", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1, { totalCostUsd: 0.01, inputTokens: 100, outputTokens: 50 }));
    store.recordTurnUsage(makeTurnInput("s-b", 1, { totalCostUsd: 0.02, inputTokens: 200, outputTokens: 100 }));

    const totals = store.lifetimeTotals(["s-a"]);
    expect(totals.numTurns).toBe(1);
    expect(totals.numSessions).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.01, 6);
    expect(totals.inputTokens).toBe(100);
    store.close();
  });

  it("filters across multiple sessionIds", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1, { totalCostUsd: 0.01 }));
    store.recordTurnUsage(makeTurnInput("s-b", 1, { totalCostUsd: 0.02 }));
    store.recordTurnUsage(makeTurnInput("s-c", 1, { totalCostUsd: 0.04 }));

    const totals = store.lifetimeTotals(["s-a", "s-b"]);
    expect(totals.numTurns).toBe(2);
    expect(totals.numSessions).toBe(2);
    expect(totals.costUsd).toBeCloseTo(0.03, 6);
    store.close();
  });

  it("empty sessionIds array is a STRICT filter — returns zeros (zero-session identity must not see everyone's usage)", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1));
    store.recordTurnUsage(makeTurnInput("s-b", 1));

    const withEmpty = store.lifetimeTotals([]);
    expect(withEmpty.numTurns).toBe(0);
    expect(withEmpty.numSessions).toBe(0);
    expect(withEmpty.costUsd).toBe(0);
    expect(withEmpty.inputTokens).toBe(0);
    expect(withEmpty.outputTokens).toBe(0);
    // undefined stays unscoped (internal callers).
    expect(store.lifetimeTotals(undefined).numSessions).toBe(2);
    store.close();
  });

  it("returns zeros when sessionIds filter matches nothing", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-a", 1));
    const totals = store.lifetimeTotals(["nonexistent"]);
    expect(totals.numTurns).toBe(0);
    expect(totals.numSessions).toBe(0);
    store.close();
  });

  it("scoping excludes other identities' sessions", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("mine-1", 1, { totalCostUsd: 0.01, inputTokens: 100 }));
    store.recordTurnUsage(makeTurnInput("theirs-1", 1, { totalCostUsd: 5, inputTokens: 9999 }));

    const totals = store.lifetimeTotals(["mine-1"]);
    expect(totals.numSessions).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.01, 6);
    expect(totals.inputTokens).toBe(100);
    store.close();
  });

  it("does not throw with more than 1000 session ids (old IN-list hit SQLite's variable limit)", () => {
    const store = new SqliteEpisodeStore(dbPath);
    store.recordTurnUsage(makeTurnInput("s-1234", 1, { totalCostUsd: 0.02 }));
    const ids = Array.from({ length: 2500 }, (_, i) => `s-${i}`);
    const totals = store.lifetimeTotals(ids);
    expect(totals.numTurns).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.02, 6);
    store.close();
  });
});

// ── test helpers ────────────────────────────────────────────────────────

function msg(
  messageId: string,
  role: SessionMessage["role"],
  content: string,
  timestamp: string,
): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s1",
    messageId,
    role,
    content,
    identity: { sub: "user:test", type: "human" },
    timestamp,
  };
}

function msgTool(
  messageId: string,
  name: string,
  state: any,
  input: any,
  timestamp: string,
): SessionMessage {
  const hasInput = state.phase === "waiting_confirmation" || state.phase === "executing";
  return {
    type: "session.message",
    sessionId: "s1",
    messageId,
    role: "tool_call",
    content: `${name}(...)`,
    identity: { sub: "agent:test", type: "agent" },
    tool: {
      toolId: "tid",
      name,
      state: hasInput ? { ...state, input } : state,
    },
    timestamp,
  };
}

// ── #154: vector-cache LRU bound ─────────────────────────────────────────────
//
// The decoded embedding-matrix cache used to grow forever ("stays warm for
// the lifetime of the process") and recallGlobal touches EVERY workspace —
// one global search pinned the whole corpus's Float32Arrays in RAM. The
// cache is now byte-bounded with least-recently-QUERIED eviction.
describe("SqliteEpisodeStore — vector cache LRU (#154)", () => {
  const DIM = 8;
  /** 3 episodes × 8 dims × 4 bytes = 96 bytes per workspace matrix. */
  const WS_BYTES = 3 * DIM * 4;

  function seedWorkspace(store: SqliteEpisodeStore, ws: string): void {
    for (let i = 0; i < 3; i++) {
      store.insert({
        workspaceId: ws,
        sessionId: `sess-${ws}`,
        kind: "tool_call",
        toolName: "Read",
        summary: `${ws} ep ${i}`,
        content: `content ${ws} ${i}`,
        filePaths: [],
        tokenEstimate: 1,
        embedding: new Float32Array(DIM).fill(i + 1),
        embeddingModel: "stub",
        createdAt: Date.now(),
        createdBy: "u",
      });
    }
  }

  it("evicts the least-recently-queried workspace past the byte ceiling", () => {
    // Ceiling fits exactly two matrices.
    const store = new SqliteEpisodeStore(":memory:", {
      vectorCacheMaxBytes: WS_BYTES * 2,
    });
    for (const ws of ["ws_a", "ws_b", "ws_c"]) seedWorkspace(store, ws);

    const a1 = store.loadVectorMatrix("ws_a");
    store.loadVectorMatrix("ws_b");
    expect(store.vectorCacheStats()).toMatchObject({
      workspaces: 2,
      bytes: WS_BYTES * 2,
    });

    // Touch ws_a so ws_b becomes the LRU victim, then load ws_c.
    const a2 = store.loadVectorMatrix("ws_a");
    expect(a2).toBe(a1); // cache HIT — same object identity
    store.loadVectorMatrix("ws_c");

    const stats = store.vectorCacheStats();
    expect(stats.workspaces).toBe(2);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);

    // ws_a survived (recently touched): identity preserved. ws_b was
    // evicted: a fresh load rebuilds a NEW matrix from SQLite — with the
    // right contents (correctness never depends on the cache).
    expect(store.loadVectorMatrix("ws_a")).toBe(a1);
    const bReloaded = store.loadVectorMatrix("ws_b");
    expect(bReloaded.ids.length).toBe(3);
    expect(bReloaded.vectors[0]!.length).toBe(DIM);
  });

  it("keeps a single workspace even when it alone exceeds the ceiling", () => {
    const store = new SqliteEpisodeStore(":memory:", { vectorCacheMaxBytes: 16 });
    seedWorkspace(store, "ws_big");
    const m = store.loadVectorMatrix("ws_big");
    expect(m.ids.length).toBe(3);
    // Documented: the just-queried workspace is never evicted — recall must
    // still work; the ceiling empties everything else instead.
    expect(store.vectorCacheStats().workspaces).toBe(1);

    // A second oversized workspace displaces the first.
    seedWorkspace(store, "ws_big2");
    store.loadVectorMatrix("ws_big2");
    expect(store.vectorCacheStats().workspaces).toBe(1);
  });

  it("a write refreshes recency — an actively-written workspace outlives a colder read-only one", () => {
    const store = new SqliteEpisodeStore(":memory:", {
      vectorCacheMaxBytes: WS_BYTES * 2 + DIM * 4,
    });
    for (const ws of ["ws_a", "ws_b", "ws_c"]) seedWorkspace(store, ws);

    const a1 = store.loadVectorMatrix("ws_a");
    store.loadVectorMatrix("ws_b"); // recency now: a (oldest), b

    // ws_a receives a WRITE (no read) — that must count as recency,
    // otherwise the next query on ws_c evicts the actively-written ws_a.
    store.insert({
      workspaceId: "ws_a",
      sessionId: "sess-ws_a",
      kind: "tool_call",
      toolName: "Read",
      summary: "hot write",
      content: "hot write",
      filePaths: [],
      tokenEstimate: 1,
      embedding: new Float32Array(DIM).fill(7),
      embeddingModel: "stub",
      createdAt: Date.now(),
      createdBy: "u",
    });

    store.loadVectorMatrix("ws_c"); // evicts the LRU — must be ws_b
    expect(store.loadVectorMatrix("ws_a")).toBe(a1); // identity: never evicted
  });

  it("write-path growth is byte-accounted and can trigger eviction", () => {
    const store = new SqliteEpisodeStore(":memory:", {
      vectorCacheMaxBytes: WS_BYTES * 2,
    });
    for (const ws of ["ws_a", "ws_b"]) seedWorkspace(store, ws);
    store.loadVectorMatrix("ws_a");
    store.loadVectorMatrix("ws_b");
    const before = store.vectorCacheStats().bytes;

    // Insert-with-embedding into the cached ws_b: the in-place append must
    // be accounted (and ws_a — now over the ceiling — evicted).
    store.insert({
      workspaceId: "ws_b",
      sessionId: "sess-ws_b",
      kind: "tool_call",
      toolName: "Read",
      summary: "growth",
      content: "growth",
      filePaths: [],
      tokenEstimate: 1,
      embedding: new Float32Array(DIM).fill(9),
      embeddingModel: "stub",
      createdAt: Date.now(),
      createdBy: "u",
    });

    const stats = store.vectorCacheStats();
    expect(stats.bytes).toBeGreaterThan(before - WS_BYTES); // grew…
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes); // …then fit
    expect(stats.workspaces).toBe(1); // ws_a evicted, hot ws_b kept
    // The evicted workspace reloads correctly on demand.
    expect(store.loadVectorMatrix("ws_a").ids.length).toBe(3);
  });
});
