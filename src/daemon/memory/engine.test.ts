import { describe, test, expect } from "bun:test";
import { SqliteEpisodeStore, legacyWorkspaceIdFromPath, workspaceIdFromPath } from "./store";
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

  test("a workspace passed with a tenant must belong to it", async () => {
    const { engine } = await twoTenantEngine();
    const own = await engine.searchSessions({ query: "zebra", workspaceId: "wsMine", tenant: TENANT });
    expect(own.map((h) => h.sessionId)).toEqual(["mine1"]);
    const foreign = await engine.searchSessions({ query: "zebra", workspaceId: "wsTheirs", tenant: TENANT });
    expect(foreign).toEqual([]);
    await engine.close();
  });

  test("a tenant id containing NUL is refused rather than colliding with another", () => {
    expect(() => workspaceIdFromPath("/tmp", { accountId: "a\u0000p", projectId: "" })).toThrow();
    expect(() => workspaceIdFromPath("/tmp", { accountId: "a", projectId: "p\u0000" })).toThrow();
  });

  test("backfill registers the ids episodes carry, under their sessions' tenant, once", () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.migrateWorkspaceIdsToTenant([], workspaceIdFromPath);
    // A worktree session's episodes carry the repo's id, not one recomputed
    // from its (possibly removed) workdir — the backfill must use the former.
    store.insert({ ...ep("ws-repo", "s1", "one", "body"), id: "e1" });
    store.insert({ ...ep("ws-other", "s2", "two", "body"), id: "e2" });
    const idFor = () => "ws-recomputed-never-matches";
    expect(store.needsWorkspaceTenantBackfill()).toBe(true);
    const first = store.backfillWorkspaceTenants({
      sessions: [
        { id: "s1", workdir: "/gone/worktree", ...TENANT },
        { id: "s2", workdir: "/b", ...OTHER },
      ],
      workspaceIdFor: idFor,
    });
    expect(first).toEqual({ applied: true, registered: 2, unowned: 0 });
    expect(store.listWorkspaceIds(TENANT)).toEqual(["ws-repo"]);
    expect(store.listWorkspaceIds(OTHER)).toEqual(["ws-other"]);
    expect(store.needsWorkspaceTenantBackfill()).toBe(false);
    expect(store.backfillWorkspaceTenants({ sessions: [], workspaceIdFor: idFor }).applied).toBe(false);
    store.close();
  });

  test("backfill gives an orphan an owner only when the hash proves it", () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.migrateWorkspaceIdsToTenant([], workspaceIdFromPath);
    const proven = workspaceIdFromPath("/srv/proj-gone", TENANT);
    store.insert({ ...ep(proven, "gone-1", "x", "body"), filePaths: ["/srv/proj-gone/src/a.ts"], id: "e1" });
    store.insert({ ...ep("ws-unprovable", "gone-2", "y", "body"), id: "e2" });
    const r = store.backfillWorkspaceTenants({
      sessions: [{ id: "live", workdir: "/elsewhere", ...OTHER }],
      workspaceIdFor: workspaceIdFromPath,
      extraTenants: [TENANT],
      probeRoots: ["/srv"],
    });
    expect(r).toEqual({ applied: true, registered: 1, unowned: 1 });
    expect(store.listWorkspaceIds(TENANT)).toEqual([proven]);
    expect(store.listWorkspaceIds(OTHER)).toEqual([]);
    store.close();
  });

  test("backfill waits while the pre-tenant re-key is still pending", () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.insert({ ...ep("ws-x", "s1", "x", "body"), id: "e1" });
    expect(store.needsWorkspaceMigration()).toBe(true);
    const sessions = [{ id: "s1", workdir: "/x", ...TENANT }];
    expect(store.backfillWorkspaceTenants({ sessions, workspaceIdFor: () => "unused" }).applied).toBe(false);
    expect(store.needsWorkspaceTenantBackfill()).toBe(true);
    store.migrateWorkspaceIdsToTenant(sessions, () => "ws-x");
    expect(store.backfillWorkspaceTenants({ sessions, workspaceIdFor: () => "unused" }).applied).toBe(true);
    store.close();
  });

  test("orphan probing stays under session workdirs and the given roots", () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.migrateWorkspaceIdsToTenant([], workspaceIdFromPath);
    const proven = workspaceIdFromPath("/mnt/remote/proj", TENANT);
    store.insert({ ...ep(proven, "gone", "x", "body"), filePaths: ["/mnt/remote/proj/a.ts"], id: "e1" });
    const probed: string[] = [];
    const r = store.backfillWorkspaceTenants({
      sessions: [],
      workspaceIdFor: (d, t) => {
        probed.push(d);
        return workspaceIdFromPath(d, t);
      },
      extraTenants: [TENANT],
      probeRoots: ["/home/someone"],
    });
    expect(probed).toEqual([]);
    expect(r.unowned).toBe(1);
    store.close();
  });

  test("backfill never registers a pre-tenant path-only id", () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.migrateWorkspaceIdsToTenant([], workspaceIdFromPath);
    const legacy = legacyWorkspaceIdFromPath("/shared");
    store.insert({ ...ep(legacy, "s1", "x", "body"), id: "e1" });
    const r = store.backfillWorkspaceTenants({
      sessions: [{ id: "s1", workdir: "/shared", ...TENANT }],
      workspaceIdFor: workspaceIdFromPath,
    });
    expect(r.registered).toBe(0);
    expect(store.listWorkspaceIds(TENANT)).toEqual([]);
    store.close();
  });

  test("keyword search is driven by the FTS index, not by the tenant's episodes", () => {
    const store = new SqliteEpisodeStore(":memory:");
    // Guards the CROSS JOIN order: with a plain JOIN SQLite scanned the
    // tenant's episodes and re-ran MATCH per row (seconds on a real store).
    const plan = store.explainFtsSearchGlobal(TENANT);
    expect(plan[0]).toContain("episodes_fts");
    store.close();
  });

  test("the keyword LIMIT applies after the tenant filter", () => {
    const store = new SqliteEpisodeStore(":memory:");
    store.registerWorkspaceTenant("wa", TENANT);
    store.registerWorkspaceTenant("wb", OTHER);
    for (let i = 0; i < 20; i++) store.insert({ ...ep("wb", `b${i}`, "kiwi", "kiwi kiwi kiwi"), id: `b${i}` });
    store.insert({ ...ep("wa", "a1", "kiwi", "kiwi"), id: "a1" });
    expect(store.ftsSearchGlobal("kiwi", 5, TENANT).map((r) => r.id)).toEqual(["a1"]);
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
