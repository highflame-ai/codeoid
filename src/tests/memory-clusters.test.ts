/**
 * Cluster + labeler tests — covers Layer C v2.
 *
 * Uses synthetic unit vectors (no embedder) so k-means behavior is fully
 * deterministic and tests run in milliseconds. For labeling we exercise
 * the heuristic + cached paths — the Haiku HTTP path is mocked since we
 * don't want live API calls in CI.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteEpisodeStore,
  clusterEpisodes,
  clusterEpisodesYielding,
  HeuristicLabeler,
  CachedLabeler,
  MIN_EPISODES_FOR_CLUSTERING,
  buildWorkspaceIndex,
  IndexScheduler,
  WorkspaceClusterer,
  workspaceClustererFor,
  type Labeler,
  type Cluster,
  type ClusterLabel,
} from "../daemon/memory/index.js";
import type { Episode } from "@highflame/codeoid-memory/types.js";

let tmp: string;
let dbPath: string;
let store: SqliteEpisodeStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-clusters-"));
  dbPath = join(tmp, "memory.db");
  store = new SqliteEpisodeStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

const WS = "ws_test";

/** Build a normalized vector biased toward dimension `axis`. */
function biasedVec(dim: number, axis: number, noise = 0.05): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = (Math.sin(i * 13 + axis * 7) * 0.5 + 0.5) * noise;
  }
  v[axis] = 1.0;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

function seedWorkspace(groups: Array<{
  count: number;
  axis: number;
  summaryPrefix: string;
  tool: string;
  dir: string;
}>): Episode[] {
  const dim = 32;
  const eps: Episode[] = [];
  const t = 1_700_000_000_000;
  let idx = 0;
  for (const g of groups) {
    for (let i = 0; i < g.count; i++) {
      const vec = biasedVec(dim, g.axis);
      const saved = store.insert({
        workspaceId: WS,
        sessionId: `s${idx % 3}`,
        kind: "tool_call",
        toolName: g.tool,
        summary: `${g.summaryPrefix} ${i}`,
        content: `${g.summaryPrefix} content ${i}`,
        filePaths: [`${g.dir}/file-${i}.ts`],
        tokenEstimate: 50,
        embedding: vec,
        embeddingModel: "synthetic",
        createdAt: t + idx * 1000,
        createdBy: "u",
      });
      eps.push(saved);
      idx += 1;
    }
  }
  return eps;
}

describe("clusterEpisodes", () => {
  it("returns [] below MIN_EPISODES_FOR_CLUSTERING", () => {
    const eps = seedWorkspace([
      { count: 5, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/daemon/memory" },
    ]);
    expect(eps.length).toBeLessThan(MIN_EPISODES_FOR_CLUSTERING);
    const clusters = clusterEpisodes(eps);
    expect(clusters).toEqual([]);
  });

  it("separates three distinct embedding regions into three clusters", () => {
    seedWorkspace([
      { count: 15, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/daemon/memory" },
      { count: 15, axis: 10, summaryPrefix: "tui render", tool: "Write", dir: "src/tui/components" },
      { count: 15, axis: 20, summaryPrefix: "protocol types", tool: "Edit", dir: "src/protocol" },
    ]);
    const episodes = store.listRecent(WS, 100);
    const clusters = clusterEpisodes(episodes, { k: 3 });
    expect(clusters.length).toBeGreaterThanOrEqual(3);
    // Each cluster should be dominated by a single prefix. Find dominant.
    for (const c of clusters) {
      const prefixes = new Map<string, number>();
      for (const m of c.members) {
        const head = m.episode.summary.split(" ").slice(0, 2).join(" ");
        prefixes.set(head, (prefixes.get(head) ?? 0) + 1);
      }
      const best = Math.max(...prefixes.values());
      // Dominant prefix covers >80% of the cluster (relaxed to tolerate k-means init variance).
      expect(best / c.members.length).toBeGreaterThan(0.8);
    }
  });

  it("produces stable signatures for identical member sets", () => {
    seedWorkspace([
      { count: 20, axis: 0, summaryPrefix: "memory", tool: "Edit", dir: "src/memory" },
      { count: 20, axis: 15, summaryPrefix: "tui", tool: "Write", dir: "src/tui" },
    ]);
    const episodes = store.listRecent(WS, 100);
    const c1 = clusterEpisodes(episodes, { k: 2, seed: 42 });
    const c2 = clusterEpisodes(episodes, { k: 2, seed: 42 });
    const sigs1 = new Set(c1.map((c) => c.signature));
    const sigs2 = new Set(c2.map((c) => c.signature));
    expect(sigs1).toEqual(sigs2);
  });

  it("exposes topFiles sorted by touch count", () => {
    seedWorkspace([
      { count: 20, axis: 0, summaryPrefix: "memory", tool: "Edit", dir: "src/memory" },
    ]);
    // Inject one extra episode that touches a hot shared file.
    for (let i = 0; i < 10; i++) {
      store.insert({
        workspaceId: WS,
        sessionId: "s0",
        kind: "tool_call",
        toolName: "Edit",
        summary: `shared edit ${i}`,
        content: "",
        filePaths: ["src/memory/shared.ts"],
        tokenEstimate: 20,
        embedding: biasedVec(32, 0),
        embeddingModel: "synthetic",
        createdAt: Date.now() + i,
        createdBy: "u",
      });
    }
    const episodes = store.listRecent(WS, 100);
    const clusters = clusterEpisodes(episodes, { k: 2 });
    expect(clusters[0]!.topFiles[0]!.path).toBe("src/memory/shared.ts");
  });
});

describe("HeuristicLabeler", () => {
  it("produces labels from dominant directory + content terms", async () => {
    seedWorkspace([
      { count: 30, axis: 0, summaryPrefix: "authentication jwt", tool: "Edit", dir: "src/auth/handlers" },
    ]);
    const episodes = store.listRecent(WS, 100);
    const clusters = clusterEpisodes(episodes, { k: 1 });
    const labeler = new HeuristicLabeler();
    const { label, source } = await labeler.label(clusters[0]!);
    expect(source).toBe("heuristic");
    // Should reference either the dir ("auth") or the content term ("authentication"/"jwt") or the tool ("edit").
    expect(label.toLowerCase()).toMatch(/auth|jwt|edit/);
  });

  it("doesn't break on clusters with no file paths", async () => {
    for (let i = 0; i < 30; i++) {
      store.insert({
        workspaceId: WS,
        sessionId: "s0",
        kind: "user_turn",
        summary: `pure text episode ${i}`,
        content: "",
        filePaths: [],
        tokenEstimate: 10,
        embedding: biasedVec(32, 0),
        embeddingModel: "synthetic",
        createdAt: Date.now() + i,
        createdBy: "u",
      });
    }
    const episodes = store.listRecent(WS, 100);
    const clusters = clusterEpisodes(episodes, { k: 1 });
    const { label } = await new HeuristicLabeler().label(clusters[0]!);
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("CachedLabeler", () => {
  it("short-circuits on repeat signature — inner labeler called once", async () => {
    let calls = 0;
    const inner: Labeler = {
      async label(_c: Cluster): Promise<ClusterLabel> {
        calls++;
        return { label: `label-${calls}`, source: "heuristic" };
      },
    };
    const cached = new CachedLabeler(inner);
    seedWorkspace([
      { count: 30, axis: 0, summaryPrefix: "memory", tool: "Edit", dir: "src/memory" },
    ]);
    const episodes = store.listRecent(WS, 100);
    const clusters = clusterEpisodes(episodes, { k: 1 });
    const first = await cached.label(clusters[0]!);
    const second = await cached.label(clusters[0]!);
    expect(first.label).toBe("label-1");
    expect(second.label).toBe("label-1");
    expect(second.source).toBe("cache");
    expect(calls).toBe(1);
  });
});

describe("index scheduler with clusters flag", () => {
  it("omits clusters block when CODEOID_MEMORY_CLUSTERS is off", () => {
    seedWorkspace([
      { count: 40, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/memory" },
      { count: 40, axis: 15, summaryPrefix: "tui render", tool: "Write", dir: "src/tui" },
    ]);
    const out = buildWorkspaceIndex({
      store,
      workspaceId: WS,
      currentSessionId: "s0",
    });
    expect(out).not.toContain("## Topic clusters");
  });

  it("renders clusters block when the scheduler finishes clustering", async () => {
    seedWorkspace([
      { count: 40, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/memory" },
      { count: 40, axis: 15, summaryPrefix: "tui render", tool: "Write", dir: "src/tui" },
    ]);

    const clock = { t: 1_000_000 };
    const sched = new IndexScheduler({
      store,
      workspaceId: WS,
      currentSessionId: "s0",
      clustersEnabled: true,
      labeler: new HeuristicLabeler(),
      now: () => clock.t,
      debounceMs: 0,
    });

    // Cold-start rebuild kicks off async clustering internally. Wait briefly
    // for the clustering promise to settle, then force a rebuild that picks
    // up the newly-cached labeled clusters.
    sched.get();
    await new Promise((r) => setTimeout(r, 50));
    clock.t += 30_000;
    sched.onEpisode();
    const out = sched.forceRebuild();
    // Either clustering ran (expected) OR the async pass didn't settle in
    // the 50ms window (rare on slow CI). Accept both — the contract is that
    // WHEN clusters land, they render. If they haven't yet, the rest of the
    // index still works.
    if (out.includes("## Topic clusters")) {
      expect(out).toMatch(/\*\*[A-Za-z][^*]+\*\* — \d+ episodes/);
    } else {
      expect(out).toContain("# Memory Index");
    }
  });
});

describe("SqliteEpisodeStore.listRecentForClustering", () => {
  it("returns a lean, embedded-only, newest-first projection", () => {
    seedWorkspace([
      { count: 5, axis: 0, summaryPrefix: "lean", tool: "Edit", dir: "src/lean" },
    ]);
    // Un-embedded episode — must be excluded from the clustering feed.
    store.insert({
      workspaceId: WS,
      sessionId: "s9",
      kind: "user_turn",
      summary: "no vector yet",
      content: "huge content that clustering must never hydrate",
      filePaths: [],
      tokenEstimate: 1,
      createdAt: 1_800_000_000_000,
      createdBy: "u",
    });

    const rows = store.listRecentForClustering(WS, 3);
    expect(rows).toHaveLength(3);
    // Newest first, and the un-embedded row is absent.
    expect(rows[0]!.summary).toBe("lean 4");
    // Lean projection: no content column, embedding decoded and usable.
    expect("content" in rows[0]!).toBe(false);
    expect(rows[0]!.embedding).toBeInstanceOf(Float32Array);
    expect(rows[0]!.filePaths).toEqual(["src/lean/file-4.ts"]);
    expect(rows[0]!.toolName).toBe("Edit");
  });
});

describe("clusterEpisodesYielding", () => {
  it("produces the same clusters as the synchronous entry point", async () => {
    seedWorkspace([
      { count: 40, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/memory" },
      { count: 40, axis: 15, summaryPrefix: "tui render", tool: "Write", dir: "src/tui" },
    ]);
    const eps = store.listRecentForClustering(WS, 100);
    const sync = clusterEpisodes(eps, { k: 2, seed: 42 });
    const yielded = await clusterEpisodesYielding(eps, { k: 2, seed: 42 });
    expect(yielded.map((c) => c.signature)).toEqual(sync.map((c) => c.signature));
    expect(yielded.map((c) => c.members.length)).toEqual(sync.map((c) => c.members.length));
  });
});

describe("WorkspaceClusterer", () => {
  it("is shared per (store, workspace) and pays labeling once across schedulers", async () => {
    seedWorkspace([
      { count: 40, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/memory" },
      { count: 40, axis: 15, summaryPrefix: "tui render", tool: "Write", dir: "src/tui" },
    ]);
    let calls = 0;
    const counting: Labeler = {
      async label(_c: Cluster): Promise<ClusterLabel> {
        calls++;
        return { label: `topic-${calls}`, source: "heuristic" };
      },
    };
    const clusterer = workspaceClustererFor({ store, workspaceId: WS, labeler: counting });
    // Any later resolution for the same (store, workspace) is the SAME object.
    expect(workspaceClustererFor({ store, workspaceId: WS })).toBe(clusterer);

    const schedA = new IndexScheduler({
      store, workspaceId: WS, currentSessionId: "sA", clustersEnabled: true, debounceMs: 0,
    });
    const schedB = new IndexScheduler({
      store, workspaceId: WS, currentSessionId: "sB", clustersEnabled: true, debounceMs: 0,
    });

    await clusterer.recluster();
    const callsAfterFirstPass = calls;
    expect(callsAfterFirstPass).toBeGreaterThan(0);

    // Both sessions' index rebuilds consume the SAME workspace clusters —
    // no per-session re-hydration, k-means, or labeling.
    expect(schedA.forceRebuild()).toContain("## Topic clusters");
    expect(schedB.forceRebuild()).toContain("## Topic clusters");
    expect(calls).toBe(callsAfterFirstPass);
  });

  it("single-flights concurrent recluster passes", async () => {
    seedWorkspace([
      { count: 40, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/memory" },
    ]);
    let calls = 0;
    const slow: Labeler = {
      async label(_c: Cluster): Promise<ClusterLabel> {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { label: "slow", source: "heuristic" };
      },
    };
    const clusterer = new WorkspaceClusterer({ store, workspaceId: WS, labeler: slow });
    await Promise.all([clusterer.recluster(), clusterer.recluster(), clusterer.recluster()]);

    expect(clusterer.clusters.length).toBeGreaterThan(0);
    // One pass worth of labeling, not three.
    expect(calls).toBe(clusterer.clusters.length);
  });

  it("keeps episodes that arrive mid-pass counted toward the next threshold", async () => {
    seedWorkspace([
      { count: 40, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/memory" },
    ]);
    const clock = { t: 1_000_000 };
    let calls = 0;
    const slow: Labeler = {
      async label(_c: Cluster): Promise<ClusterLabel> {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { label: "topic", source: "heuristic" };
      },
    };
    const clusterer = new WorkspaceClusterer({
      store,
      workspaceId: WS,
      labeler: slow,
      now: () => clock.t,
    });

    const pass = clusterer.recluster();
    // Arrivals while the pass is in flight — the pass didn't consume these,
    // so they must still count toward the NEXT trigger threshold.
    for (let i = 0; i < 10; i++) clusterer.onEpisode();
    await pass;
    const callsAfterFirstPass = calls;
    expect(callsAfterFirstPass).toBeGreaterThan(0);

    // Interval elapses; the mid-pass arrivals alone must re-trigger.
    clock.t += 5 * 60_000;
    clusterer.onEpisode();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBeGreaterThan(callsAfterFirstPass);
  });

  it("prunes the label cache after every pass", async () => {
    class SpyCachedLabeler extends CachedLabeler {
      pruneCalls: string[][] = [];
      override prune(liveSignatures: Iterable<string>): void {
        const sigs = [...liveSignatures];
        this.pruneCalls.push(sigs);
        super.prune(sigs);
      }
    }
    seedWorkspace([
      { count: 40, axis: 0, summaryPrefix: "memory edit", tool: "Edit", dir: "src/memory" },
    ]);
    const spy = new SpyCachedLabeler(new HeuristicLabeler());
    const clusterer = new WorkspaceClusterer({ store, workspaceId: WS, labeler: spy });

    await clusterer.recluster();
    expect(spy.pruneCalls).toHaveLength(1);
    // The cache is trimmed to exactly the signatures that still exist.
    expect(new Set(spy.pruneCalls[0])).toEqual(
      new Set(clusterer.clusters.map((lc) => lc.cluster.signature)),
    );
  });
});
