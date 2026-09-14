/**
 * WorkspaceClusterer — workspace-scoped, single-flight clustering + labeling.
 *
 * Before this existed, every Session owned its own recluster loop and its
 * own labeler: N sessions in one workspace hydrated the same 1000 episodes
 * N times, ran N identical k-means passes on the shared daemon event loop,
 * and paid N separate sets of Haiku label calls (each behind its own
 * never-pruned cache). One instance per (store, workspace) shares all of it:
 *
 *   - single-flight — concurrent triggers collapse into one running pass
 *   - lean hydration — clusters over `listRecentForClustering` (no content)
 *   - yielding k-means — `clusterEpisodesYielding` gives the event loop back
 *     between Lloyd's iterations
 *   - label-cache pruning — signatures that no longer exist are evicted
 *     after every pass
 */

import type { SqliteEpisodeStore } from "./store.js";
import {
  clusterEpisodesYielding,
  MIN_EPISODES_FOR_CLUSTERING,
  type Cluster,
} from "./cluster.js";
import { CachedLabeler, createLabeler, type Labeler } from "./cluster-labeler.js";
import type { LabeledCluster } from "./index-builder.js";

/** How often to re-cluster (expensive; doesn't need to track each episode). */
const RECLUSTER_INTERVAL_MS = 5 * 60_000;
/** Pending-episode floor below which clustering skips the re-run. */
const RECLUSTER_EPISODE_THRESHOLD = 10;
/** Cluster over the most recent N embedded episodes; older content has lower
 * discovery value. */
const RECLUSTER_EPISODE_LIMIT = 1000;

export interface WorkspaceClustererOptions {
  store: SqliteEpisodeStore;
  workspaceId: string;
  /** Custom labeler (tests inject heuristic labelers). */
  labeler?: Labeler;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export class WorkspaceClusterer {
  #store: SqliteEpisodeStore;
  #workspaceId: string;
  #labeler: Labeler;
  #now: () => number;

  #labeled: LabeledCluster[] = [];
  #lastClusteredAt = 0;
  #running = false;
  #episodesSinceLast = 0;

  constructor(opts: WorkspaceClustererOptions) {
    this.#store = opts.store;
    this.#workspaceId = opts.workspaceId;
    this.#labeler = opts.labeler ?? createLabeler();
    this.#now = opts.now ?? Date.now;
  }

  /** Latest labeled clusters — empty until the first pass completes. */
  get clusters(): LabeledCluster[] {
    return this.#labeled;
  }

  /** Notify of a new episode in the workspace; may kick a background pass. */
  onEpisode(): void {
    this.#episodesSinceLast += 1;
    if (this.#shouldRecluster()) void this.recluster();
  }

  /** Kick the first pass if none has run yet (index cold start). */
  coldStart(): void {
    if (this.#lastClusteredAt === 0 && !this.#running) void this.recluster();
  }

  #shouldRecluster(): boolean {
    if (this.#running) return false;
    if (this.#episodesSinceLast < RECLUSTER_EPISODE_THRESHOLD) return false;
    return this.#now() - this.#lastClusteredAt >= RECLUSTER_INTERVAL_MS;
  }

  async recluster(): Promise<void> {
    if (this.#running) return; // single flight — a pass is already underway
    this.#running = true;
    // Snapshot the pending counter: onEpisode() keeps incrementing while the
    // pass is awaiting, and those mid-pass arrivals must still count toward
    // the NEXT threshold — the pass only consumed what preceded it.
    const consumed = this.#episodesSinceLast;
    try {
      const episodes = this.#store.listRecentForClustering(
        this.#workspaceId,
        RECLUSTER_EPISODE_LIMIT,
      );
      if (episodes.length < MIN_EPISODES_FOR_CLUSTERING) {
        this.#labeled = [];
        this.#finishPass([], consumed);
        return;
      }
      const clusters = await clusterEpisodesYielding(episodes, { k: 8 });
      // Label in parallel — CachedLabeler short-circuits on repeat signatures.
      const labeled = await Promise.all(
        clusters.map(async (c: Cluster) => ({
          cluster: c,
          label: (await this.#labeler.label(c)).label,
        })),
      );
      this.#labeled = labeled;
      this.#finishPass(clusters, consumed);
    } catch (err) {
      console.error(
        `[codeoid/memory] recluster failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.#running = false;
    }
  }

  #finishPass(clusters: Cluster[], consumed: number): void {
    this.#lastClusteredAt = this.#now();
    this.#episodesSinceLast = Math.max(0, this.#episodesSinceLast - consumed);
    // Evict cached labels whose cluster no longer exists — the cache used to
    // grow without bound over a long-lived daemon.
    if (this.#labeler instanceof CachedLabeler) {
      this.#labeler.prune(clusters.map((c) => c.signature));
    }
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

/** One clusterer per (store, workspace). WeakMap on the store instance so
 * tests (and any future multi-engine setup) never share state across
 * distinct databases, and teardown is automatic with the store. */
const registry = new WeakMap<SqliteEpisodeStore, Map<string, WorkspaceClusterer>>();

/**
 * Shared WorkspaceClusterer for a (store, workspace) pair. All sessions in
 * a workspace get the same instance, which is what makes clustering
 * single-flight across them. `labeler`/`now` are honored on FIRST creation
 * only — later callers share whatever the workspace already has.
 */
export function workspaceClustererFor(opts: WorkspaceClustererOptions): WorkspaceClusterer {
  let byWorkspace = registry.get(opts.store);
  if (!byWorkspace) {
    byWorkspace = new Map();
    registry.set(opts.store, byWorkspace);
  }
  let clusterer = byWorkspace.get(opts.workspaceId);
  if (!clusterer) {
    clusterer = new WorkspaceClusterer(opts);
    byWorkspace.set(opts.workspaceId, clusterer);
  }
  return clusterer;
}
