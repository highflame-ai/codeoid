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

const TENANT = { accountId: "acct-1", projectId: "proj-1" };
const OTHER = { accountId: "acct-2", projectId: "proj-1" };

async function seededEngine(reranker?: Reranker): Promise<MemoryEngine> {
  const store = new SqliteEpisodeStore(":memory:");
  const engine = new MemoryEngine({ store, embedder: new FakeEmbedder(), reranker });
  await engine.init();
  engine.registerWorkspace("wsA", TENANT);
  engine.registerWorkspace("wsB", TENANT);
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
    const a = await engine.searchSessions({ query: "unicorn deployment", tenant: TENANT });
    expect(a[0]?.sessionId).toBe("sA1");
    const b = await engine.searchSessions({ query: "telescope migration", tenant: TENANT });
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
    const hits = await engine.recallGlobal({ query: "widget telescope", tenant: TENANT, limit: 10 });
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
    store.registerWorkspaceTenant("w1", TENANT);
    store.registerWorkspaceTenant("w2", TENANT);
    expect(new Set(store.listWorkspaceIds(TENANT))).toEqual(new Set(["w1", "w2"]));
    expect(store.ftsSearchGlobal("keyword-one", 10, TENANT).map((r) => r.id)).toEqual(["e1"]);
    expect(store.episodesByIds(["e2", "e1"]).map((e) => e.id)).toEqual(["e2", "e1"]);
    store.close();
  });
});

// #415: one daemon can serve several tenants, and the memory store spans all
// of them. Cross-workspace retrieval must stay inside the caller's tenant.
describe("cross-workspace retrieval is tenant-scoped (#415)", () => {
  async function twoTenantEngine(): Promise<{ engine: MemoryEngine; store: SqliteEpisodeStore }> {
    const store = new SqliteEpisodeStore(":memory:");
    const engine = new MemoryEngine({ store, embedder: new FakeEmbedder() });
    await engine.init();
    engine.registerWorkspace("wsMine", TENANT);
    engine.registerWorkspace("wsTheirs", OTHER);
    engine.ingest(ep("wsMine", "mine1", "zebra rollout", "zebra rollout checklist"));
    engine.ingest(ep("wsTheirs", "theirs1", "zebra secrets", "zebra production secrets rotation"));
    // A workspace no tenant ever registered: its owner cannot be proven.
    engine.ingest(ep("wsUnknown", "orphan1", "zebra orphan", "zebra orphaned notes"));
    await engine.drain();
    return { engine, store };
  }

  test("recallGlobal returns only the caller's tenant's episodes", async () => {
    const { engine } = await twoTenantEngine();
    const mine = await engine.recallGlobal({ query: "zebra", tenant: TENANT, limit: 20 });
    expect(mine.map((h) => h.episode.sessionId)).toEqual(["mine1"]);
    const theirs = await engine.recallGlobal({ query: "zebra", tenant: OTHER, limit: 20 });
    expect(theirs.map((h) => h.episode.sessionId)).toEqual(["theirs1"]);
    await engine.close();
  });

  test("searchSessions without a workspace stays inside the tenant", async () => {
    const { engine } = await twoTenantEngine();
    const hits = await engine.searchSessions({ query: "zebra secrets", tenant: TENANT });
    expect(hits.map((h) => h.sessionId)).toEqual(["mine1"]);
    await engine.close();
  });

  test("an unregistered workspace is invisible to every tenant", async () => {
    const { engine, store } = await twoTenantEngine();
    for (const tenant of [TENANT, OTHER]) {
      const hits = await engine.recallGlobal({ query: "orphaned", tenant, limit: 20 });
      expect(hits.some((h) => h.episode.sessionId === "orphan1")).toBe(false);
      expect(store.listWorkspaceIds(tenant)).not.toContain("wsUnknown");
    }
    await engine.close();
  });

  test("registration is idempotent and cannot move a workspace to another tenant", async () => {
    const { engine, store } = await twoTenantEngine();
    engine.registerWorkspace("wsMine", TENANT);
    engine.registerWorkspace("wsMine", OTHER);
    expect(store.listWorkspaceIds(TENANT)).toEqual(["wsMine"]);
    expect(store.listWorkspaceIds(OTHER)).toEqual(["wsTheirs"]);
    await engine.close();
  });

  test("backfill records persisted sessions' workspaces once", () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.insert({ ...ep("ws-/a", "s1", "one", "body"), id: "e1" });
    const idFor = (workdir: string, t: { accountId: string }) => `ws-${workdir}-${t.accountId}`;
    expect(store.needsWorkspaceTenantBackfill()).toBe(true);
    const first = store.backfillWorkspaceTenants(
      [
        { workdir: "/a", ...TENANT },
        { workdir: "/a", ...TENANT },
        { workdir: "/b", ...OTHER },
      ],
      idFor,
    );
    expect(first).toEqual({ applied: true, registered: 2 });
    expect(store.needsWorkspaceTenantBackfill()).toBe(false);
    expect(store.listWorkspaceTenants()).toHaveLength(2);
    expect(store.backfillWorkspaceTenants([{ workdir: "/c", ...TENANT }], idFor)).toEqual({
      applied: false,
      registered: 0,
    });
    store.close();
  });

  test("rerank reorders the top-k by cross-encoder score", async () => {
    const engine = await seededEngine(new FakeReranker());
    const noRerank = await engine.searchSessions({ query: "widget", tenant: TENANT, rerank: false });
    const withRerank = await engine.searchSessions({ query: "widget", tenant: TENANT, rerank: true });
    // The fake reranker boosts the "telescope" session (sB1) to #1.
    expect(withRerank[0]?.sessionId).toBe("sB1");
    expect(withRerank[0]?.sessionId).not.toBe(noRerank[0]?.sessionId);
    await engine.close();
  });
});
