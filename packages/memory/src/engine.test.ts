import { describe, test, expect } from "bun:test";
import { SqliteEpisodeStore } from "./store";
import { MemoryEngine } from "./engine";
import type { Embedder } from "./embedder";
import type { Episode } from "./types";
import type { Reranker } from "./reranker";

/**
 * Deterministic fake embedder — an 8-dim char-histogram vector. Related text
 * shares buckets → similar vectors, with zero model/network dependency. Good
 * enough to exercise the vector code path; assertions lean on the FTS/keyword
 * signal so they don't hinge on fake-vector quality.
 */
class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (const ch of t.toLowerCase()) {
        const c = ch.charCodeAt(0);
        if (c >= 97 && c <= 122) v[(c - 97) % this.dimensions]! += 1;
      }
      return v;
    });
  }
  async close(): Promise<void> {}
}

/** Deterministic fake reranker — boosts any doc mentioning "telescope" so the
 * rerank stage visibly reorders regardless of the fusion order. */
class FakeReranker implements Reranker {
  readonly modelName = "fake-rerank";
  async init(): Promise<void> {}
  async rerank(_query: string, docs: string[]): Promise<number[]> {
    return docs.map((d) => (d.toLowerCase().includes("telescope") ? 10 : 0));
  }
  async close(): Promise<void> {}
}

function ep(
  workspaceId: string,
  sessionId: string,
  summary: string,
  content: string,
): Omit<Episode, "id"> {
  return {
    workspaceId,
    sessionId,
    kind: "user_turn",
    summary,
    content,
    filePaths: [],
    tokenEstimate: Math.ceil(content.length / 4),
    createdAt: 1_000_000,
    createdBy: "test",
  };
}

async function seededEngine(reranker?: Reranker): Promise<MemoryEngine> {
  const store = new SqliteEpisodeStore(":memory:");
  const engine = new MemoryEngine({ store, embedder: new FakeEmbedder(), reranker });
  await engine.init();
  engine.ingest(ep("wsA", "sA1", "unicorn deploy", "alpha unicorn deployment pipeline"));
  engine.ingest(ep("wsA", "sA2", "widget refactor", "beta widget refactor cleanup"));
  engine.ingest(ep("wsB", "sB1", "telescope migration", "gamma telescope schema migration"));
  engine.ingest(ep("wsB", "sB2", "penguin caching", "delta penguin cache eviction"));
  await engine.drain();
  return engine;
}

describe("cross-workspace (global) resolution", () => {
  test("searchSessions with no workspaceId resolves across workspaces", async () => {
    const engine = await seededEngine();
    const a = await engine.searchSessions({ query: "unicorn deployment" });
    expect(a[0]?.sessionId).toBe("sA1");
    const b = await engine.searchSessions({ query: "telescope migration" });
    expect(b[0]?.sessionId).toBe("sB1");
    await engine.close();
  });

  test("passing a workspaceId still scopes to that workspace", async () => {
    const engine = await seededEngine();
    // "unicorn" lives in wsA; scoping to wsB must not surface sA1.
    const scoped = await engine.searchSessions({ query: "unicorn", workspaceId: "wsB" });
    expect(scoped.every((h) => h.sessionId !== "sA1")).toBe(true);
    await engine.close();
  });

  test("recallGlobal unions candidates across workspaces", async () => {
    const engine = await seededEngine();
    const hits = await engine.recallGlobal({ query: "widget telescope", limit: 10 });
    const sessions = new Set(hits.map((h) => h.episode.sessionId));
    // A cross-workspace query should pull episodes from both wsA and wsB.
    expect(sessions.has("sA2")).toBe(true);
    expect(sessions.has("sB1")).toBe(true);
    await engine.close();
  });

  test("store cross-workspace primitives", async () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.insert({ ...ep("w1", "s1", "one", "keyword-one body"), id: "e1" });
    store.insert({ ...ep("w2", "s2", "two", "keyword-two body"), id: "e2" });
    expect(new Set(store.listWorkspaceIds())).toEqual(new Set(["w1", "w2"]));
    expect(store.ftsSearchGlobal("keyword-one", 10).map((r) => r.id)).toEqual(["e1"]);
    expect(store.episodesByIds(["e2", "e1"]).map((e) => e.id)).toEqual(["e2", "e1"]);
    store.close();
  });

  test("rerank reorders the top-k by cross-encoder score", async () => {
    const engine = await seededEngine(new FakeReranker());
    const noRerank = await engine.searchSessions({ query: "widget", rerank: false });
    const withRerank = await engine.searchSessions({ query: "widget", rerank: true });
    // The fake reranker boosts the "telescope" session (sB1) to #1.
    expect(withRerank[0]?.sessionId).toBe("sB1");
    expect(withRerank[0]?.sessionId).not.toBe(noRerank[0]?.sessionId);
    await engine.close();
  });
});
