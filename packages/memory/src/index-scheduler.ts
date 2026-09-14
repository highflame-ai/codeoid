/**
 * IndexScheduler — throttled builder for the workspace memory index.
 *
 * Hybrid trigger (production-grade):
 *   - HARD:   ≥ EPISODE_THRESHOLD new episodes since last build → rebuild now
 *   - TIMED:  ≥ TIME_THRESHOLD_MS elapsed AND ≥ 1 new episode  → rebuild now
 *   - FLOOR:  at most one rebuild per DEBOUNCE_MS regardless of triggers
 *
 * Why both triggers? During active work, episode counts climb fast — we want
 * reactive regen. During idle stretches, timer-based regen catches drift
 * without wasting cycles. The debounce floor caps prompt-cache invalidation
 * frequency — Anthropic's prefix cache is the single biggest cost knob on
 * long sessions, so we protect it.
 *
 * Generation runs synchronously when `get()` is called with a stale cache.
 * Turn latency impact is negligible (<10ms for the pure SQL path) so we don't
 * bother with a background thread.
 */

import type { SqliteEpisodeStore } from "./store.js";
import {
  buildWorkspaceIndex,
  type IndexOptions,
} from "./index-builder.js";
import type { Labeler } from "./cluster-labeler.js";
import {
  workspaceClustererFor,
  type WorkspaceClusterer,
} from "./workspace-clusterer.js";

/** Rebuild once EPISODE_THRESHOLD new episodes have accumulated. */
const EPISODE_THRESHOLD = 5;
/** Rebuild after this long, even if only 1 new episode arrived. */
const TIME_THRESHOLD_MS = 60_000;
/** Minimum gap between successive rebuilds (protects prompt cache). */
const DEBOUNCE_MS = 15_000;

export interface IndexSchedulerOptions {
  store: SqliteEpisodeStore;
  workspaceId: string;
  currentSessionId: string;
  workdir?: string;
  indexOptions?: IndexOptions;
  /** Overrides — tests can shrink thresholds. */
  episodeThreshold?: number;
  timeThresholdMs?: number;
  debounceMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Opt-in clustering. Defaults to the CODEOID_MEMORY_CLUSTERS env flag. */
  clustersEnabled?: boolean;
  /** Custom labeler (tests inject heuristic labelers). Honored on the FIRST
   * scheduler to touch a workspace — the clusterer is shared after that. */
  labeler?: Labeler;
  /** Explicit clusterer injection (tests). Defaults to the shared
   * per-(store, workspace) instance. */
  clusterer?: WorkspaceClusterer;
}

export class IndexScheduler {
  #opts: IndexSchedulerOptions;
  #episodeThreshold: number;
  #timeThresholdMs: number;
  #debounceMs: number;
  #now: () => number;

  #cached = "";
  #cachedAt = 0;
  #pendingEpisodes = 0;

  /** Shared per-(store, workspace) clustering — null when clustering is off.
   * Sharing is the point: N sessions in one workspace used to each hydrate
   * 1000 episodes, run their own k-means, and pay their own Haiku labels. */
  #clusterer: WorkspaceClusterer | null;

  constructor(opts: IndexSchedulerOptions) {
    this.#opts = opts;
    this.#episodeThreshold = opts.episodeThreshold ?? EPISODE_THRESHOLD;
    this.#timeThresholdMs = opts.timeThresholdMs ?? TIME_THRESHOLD_MS;
    this.#debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.#now = opts.now ?? Date.now;
    const clustersEnabled =
      opts.clustersEnabled ?? process.env.CODEOID_MEMORY_CLUSTERS === "1";
    this.#clusterer = clustersEnabled
      ? opts.clusterer ??
        workspaceClustererFor({
          store: opts.store,
          workspaceId: opts.workspaceId,
          labeler: opts.labeler,
          now: opts.now,
        })
      : null;
  }

  /** Call after every episode.ingest — increments the pending counter. */
  onEpisode(): void {
    this.#pendingEpisodes += 1;
    // The shared clusterer may kick an async workspace-wide re-cluster.
    // Runs in the background — doesn't block the caller's turn.
    this.#clusterer?.onEpisode();
  }

  /**
   * Get the current index, rebuilding if triggers fired. Cheap when fresh
   * (returns cached string); spends <10ms when rebuilding. Safe to call on
   * the hot path of every turn.
   */
  get(): string {
    if (this.#shouldRebuild()) {
      this.#rebuild();
    }
    return this.#cached;
  }

  /** Force an immediate rebuild — useful on session start or after pins change. */
  forceRebuild(): string {
    this.#rebuild();
    return this.#cached;
  }

  /** Test-friendly accessor — returns whether the next get() will rebuild. */
  get isStale(): boolean {
    return this.#shouldRebuild();
  }

  #shouldRebuild(): boolean {
    const now = this.#now();
    const ageMs = now - this.#cachedAt;

    // Debounce: never rebuild faster than floor.
    if (this.#cachedAt > 0 && ageMs < this.#debounceMs) return false;

    // Cold start — build on first access.
    if (this.#cachedAt === 0) return true;

    // Hard trigger — enough new material to matter.
    if (this.#pendingEpisodes >= this.#episodeThreshold) return true;

    // Timed trigger — prevents drift during slow sessions.
    if (this.#pendingEpisodes >= 1 && ageMs >= this.#timeThresholdMs) return true;

    return false;
  }

  #rebuild(): void {
    // Cold-start the workspace clusters if enabled and none exist yet.
    this.#clusterer?.coldStart();
    const clusters = this.#clusterer?.clusters ?? [];
    this.#cached = buildWorkspaceIndex(
      {
        store: this.#opts.store,
        workspaceId: this.#opts.workspaceId,
        workdir: this.#opts.workdir,
        currentSessionId: this.#opts.currentSessionId,
        clusters: clusters.length > 0 ? clusters : undefined,
      },
      this.#opts.indexOptions,
    );
    this.#cachedAt = this.#now();
    this.#pendingEpisodes = 0;
  }
}
