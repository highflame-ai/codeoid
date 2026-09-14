/**
 * K-means clustering over episode embeddings.
 *
 * Used by the workspace index to group episodes into topics. k-means is
 * chosen over DBSCAN / hierarchical because:
 *   - Embeddings are unit-normalized (BGE models). Cosine similarity == dot
 *     product == Euclidean on the unit sphere, so Lloyd's converges fast.
 *   - We want a fixed cluster count for a stable index layout — DBSCAN
 *     would produce variable numbers, destabilizing the rendered output
 *     and invalidating prompt cache on every regen.
 *   - Workspaces rarely exceed ~5k episodes; brute-force iteration is fine.
 *
 * The output is a stable cluster assignment + per-cluster metadata
 * (members, centroid, top files, signature hash for caching).
 */

import { createHash } from "node:crypto";
import type { Episode } from "./types.js";

/**
 * The subset of an Episode that clustering + labeling actually read. Loading
 * full Episodes (notably `content`, which can carry entire tool outputs)
 * into the heap just to k-means their embeddings was the dominant memory
 * cost of a recluster — `SqliteEpisodeStore.listRecentForClustering`
 * hydrates only this projection.
 */
export type ClusterableEpisode = Pick<
  Episode,
  "id" | "summary" | "filePaths" | "createdAt" | "toolName"
> & { embedding?: Float32Array };

export interface ClusterMember {
  episode: ClusterableEpisode;
  /** Similarity to the cluster centroid (dot product for unit vectors). */
  similarity: number;
}

export interface Cluster {
  /** Deterministic id — "c0", "c1", … in descending size order. */
  id: string;
  /** Member episodes, sorted by similarity to centroid (descending). */
  members: ClusterMember[];
  /** Centroid vector (unit-normalized). */
  centroid: Float32Array;
  /** Top file paths across members, by frequency. */
  topFiles: Array<{ path: string; count: number }>;
  /**
   * Stable signature — hash of the sorted top-N member ids. Used to cache
   * cluster labels: if the signature hasn't changed, reuse the last label
   * rather than re-running the labeler (especially important for LLM labels).
   */
  signature: string;
  /** Unix ms of the most recent member. Used for ordering + freshness. */
  lastActivityAt: number;
}

export interface KMeansOptions {
  /** Target cluster count. Default 8. */
  k?: number;
  /** Max iterations. Default 20 — k-means converges fast on normalized data. */
  maxIterations?: number;
  /** Seed for deterministic init. */
  seed?: number;
}

/** Minimum episode count below which clustering isn't worth running. */
export const MIN_EPISODES_FOR_CLUSTERING = 30;

/**
 * Cluster embedded episodes. Returns clusters sorted by size (descending).
 * Episodes without embeddings are silently dropped — caller should have
 * drained the embed queue before calling for best results.
 */
export function clusterEpisodes(
  episodes: ClusterableEpisode[],
  opts: KMeansOptions = {},
): Cluster[] {
  const gen = clusterSteps(episodes, opts);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * Same algorithm, but yields the event loop between Lloyd's iterations.
 * Each iteration over 1000 × 384-dim vectors × 8 centroids is a few
 * megaflops of synchronous math; run back-to-back the full pass blocks the
 * shared daemon event loop for hundreds of ms, freezing every session's
 * token streaming. Interleaving with setImmediate caps the per-slice block
 * at one iteration.
 */
export async function clusterEpisodesYielding(
  episodes: ClusterableEpisode[],
  opts: KMeansOptions = {},
): Promise<Cluster[]> {
  const gen = clusterSteps(episodes, opts);
  let step = gen.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = gen.next();
  }
  return step.value;
}

/** K-means core as a generator — one `yield` per Lloyd's iteration, so the
 * sync and yielding entry points share the exact same algorithm. */
function* clusterSteps(
  episodes: ClusterableEpisode[],
  opts: KMeansOptions,
): Generator<undefined, Cluster[]> {
  const embedded = episodes.filter((e) => e.embedding);
  if (embedded.length < MIN_EPISODES_FOR_CLUSTERING) return [];

  // Honor an explicit k (including k=1, for "collapse into one topic") but
  // when k is unspecified, default to ~N/3 capped at 8 so we don't emit
  // dozens of sparse clusters on modestly-sized workspaces.
  const kRequested = opts.k ?? Math.min(8, Math.max(2, Math.floor(embedded.length / 3)));
  const k = Math.max(1, Math.min(kRequested, embedded.length));
  if (k < 1) return [];

  const maxIter = opts.maxIterations ?? 20;
  const dim = embedded[0]!.embedding!.length;
  const vectors = embedded.map((e) => e.embedding!);

  // Initialize with k-means++ — pick first centroid randomly, then each
  // subsequent one weighted by distance² to nearest existing centroid.
  // (yield* so the yielding entry point can breathe between centroid picks —
  // init is k full passes over the vectors, as heavy as Lloyd's iterations.)
  const centroids = yield* kmeansPlusPlusInit(vectors, k, opts.seed ?? 42);

  // Lloyd's iterations.
  const assignments = new Int32Array(embedded.length);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    // Assign each episode to the nearest centroid (by dot product — unit vectors).
    for (let i = 0; i < vectors.length; i++) {
      let bestK = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      const v = vectors[i]!;
      for (let c = 0; c < k; c++) {
        const cn = centroids[c]!;
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += v[d]! * cn[d]!;
        if (dot > bestScore) {
          bestScore = dot;
          bestK = c;
        }
      }
      if (assignments[i] !== bestK) {
        assignments[i] = bestK;
        changed++;
      }
    }
    if (changed === 0) break;

    // Recompute centroids as mean of members, then L2-normalize.
    const sums: Float32Array[] = Array.from(
      { length: k },
      () => new Float32Array(dim),
    );
    const counts = new Int32Array(k);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i]!;
      counts[c]! += 1;
      const v = vectors[i]!;
      const s = sums[c]!;
      for (let d = 0; d < dim; d++) s[d]! += v[d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c]! === 0) continue;
      const s = sums[c]!;
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += s[d]! * s[d]!;
      norm = Math.sqrt(norm) || 1;
      const cn = centroids[c]!;
      for (let d = 0; d < dim; d++) cn[d] = s[d]! / norm;
    }
    yield;
  }

  // Build Cluster output with member similarities + signatures. This final
  // pass (N×dim similarity + per-cluster sorts) is its own sizable chunk —
  // give the yielding driver one more chance to breathe before it.
  yield;
  const clustersRaw: Array<{ ep: ClusterableEpisode; sim: number; c: number }> = [];
  for (let i = 0; i < embedded.length; i++) {
    const c = assignments[i]!;
    const v = vectors[i]!;
    const cn = centroids[c]!;
    let sim = 0;
    for (let d = 0; d < dim; d++) sim += v[d]! * cn[d]!;
    clustersRaw.push({ ep: embedded[i]!, sim, c });
  }

  const byCluster = new Map<number, ClusterMember[]>();
  for (const r of clustersRaw) {
    if (!byCluster.has(r.c)) byCluster.set(r.c, []);
    byCluster.get(r.c)!.push({ episode: r.ep, similarity: r.sim });
  }

  const clusters: Cluster[] = [];
  for (const [cIdx, members] of byCluster) {
    if (members.length === 0) continue;
    members.sort((a, b) => b.similarity - a.similarity);
    clusters.push({
      id: `c${cIdx}`,
      members,
      centroid: centroids[cIdx]!,
      topFiles: topFilesOf(members),
      signature: signatureOf(members),
      lastActivityAt: Math.max(...members.map((m) => m.episode.createdAt)),
    });
  }

  // Sort clusters by size descending — largest topics first in the index.
  clusters.sort((a, b) => b.members.length - a.members.length);
  // Stable re-id so "c0" is always the biggest cluster.
  clusters.forEach((c, i) => {
    c.id = `c${i}`;
  });
  return clusters;
}

// ── Internals ────────────────────────────────────────────────────────────

function* kmeansPlusPlusInit(
  vectors: Float32Array[],
  k: number,
  seed: number,
): Generator<undefined, Float32Array[]> {
  const rng = mulberry32(seed);
  const dim = vectors[0]!.length;
  const centroids: Float32Array[] = [];

  // First centroid: random vector.
  const first = vectors[Math.floor(rng() * vectors.length)]!;
  centroids.push(new Float32Array(first));

  const dist = new Float32Array(vectors.length);
  // Work with (1 - similarity) as distance for unit vectors.
  for (let c = 1; c < k; c++) {
    yield;
    let total = 0;
    for (let i = 0; i < vectors.length; i++) {
      let nearest = Number.NEGATIVE_INFINITY;
      const v = vectors[i]!;
      for (const cn of centroids) {
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += v[d]! * cn[d]!;
        if (dot > nearest) nearest = dot;
      }
      const d = Math.max(0, 1 - nearest);
      dist[i] = d * d;
      total += dist[i]!;
    }
    if (total === 0) break;
    const target = rng() * total;
    let acc = 0;
    let picked = vectors.length - 1;
    for (let i = 0; i < vectors.length; i++) {
      acc += dist[i]!;
      if (acc >= target) {
        picked = i;
        break;
      }
    }
    centroids.push(new Float32Array(vectors[picked]!));
  }
  return centroids;
}

function topFilesOf(members: ClusterMember[]): Array<{ path: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of members) {
    for (const p of m.episode.filePaths) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 5);
}

function signatureOf(members: ClusterMember[]): string {
  // Hash of top-10 member ids (sorted by similarity descending, then by id
  // for tie-break stability). Covers the cluster's dominant members — if
  // they shift, the signature shifts, invalidating cached labels.
  const top = members.slice(0, 10).map((m) => m.episode.id);
  top.sort();
  const h = createHash("sha1").update(top.join("|")).digest("hex");
  return h.slice(0, 16);
}

/** Tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
