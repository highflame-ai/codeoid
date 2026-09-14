/**
 * Hybrid ranker — blends four signals into a single relevance score.
 *
 * Signals:
 *   - Vector similarity (cosine over L2-normalized embeddings) — semantic match
 *   - FTS5 BM25 — keyword/exact match
 *   - Recency — exponential decay over hours
 *   - Path overlap — fraction of query's file paths also touched by the episode
 *
 * Weights are tunable via RankerWeights; the defaults prioritize semantic
 * relevance while keeping keyword matches competitive for exact-string queries
 * (error messages, function names) that embeddings often miss.
 */

import { cosine } from "./embedder.js";
import type { Episode, RecallHit } from "./types.js";

export interface RankerWeights {
  vector: number;
  fts: number;
  recency: number;
  pathOverlap: number;
  /** Recency half-life in hours. Default 48h. */
  recencyHalfLifeHours: number;
}

export const DEFAULT_WEIGHTS: RankerWeights = {
  vector: 0.55,
  fts: 0.25,
  recency: 0.12,
  pathOverlap: 0.08,
  recencyHalfLifeHours: 48,
};

export interface RankInputs {
  queryVector: Float32Array | null;
  ftsHits: Map<string, number>; // episode id → raw bm25 score (lower = more relevant)
  queryFilePaths: string[];
  now: number; // unix ms
  weights?: RankerWeights;
}

/**
 * Rank candidates. Candidates should be the union of FTS hits and vector
 * neighbors (the caller builds this — the ranker just scores).
 */
export function rank(
  candidates: Episode[],
  inputs: RankInputs,
): RecallHit[] {
  const weights = inputs.weights ?? DEFAULT_WEIGHTS;
  const { queryVector, ftsHits, queryFilePaths, now } = inputs;

  // Normalize FTS bm25 scores. sqlite's bm25() returns negative values where
  // more negative = more relevant. Flip sign and min-max normalize to [0,1].
  const bm25Vals = [...ftsHits.values()].map((v) => -v);
  const bm25Min = bm25Vals.length ? Math.min(...bm25Vals) : 0;
  const bm25Max = bm25Vals.length ? Math.max(...bm25Vals) : 1;
  const bm25Range = bm25Max - bm25Min || 1;

  const hits: RecallHit[] = [];

  for (const ep of candidates) {
    const vectorScore =
      queryVector && ep.embedding ? Math.max(0, cosine(queryVector, ep.embedding)) : 0;

    const rawBm25 = ftsHits.get(ep.id);
    const ftsScore =
      rawBm25 !== undefined ? (-rawBm25 - bm25Min) / bm25Range : 0;

    const ageHours = Math.max(0, (now - ep.createdAt) / (1000 * 60 * 60));
    const recencyScore = 0.5 ** (ageHours / weights.recencyHalfLifeHours);

    const pathScore = computePathOverlap(queryFilePaths, ep.filePaths);

    const score =
      weights.vector * vectorScore +
      weights.fts * ftsScore +
      weights.recency * recencyScore +
      weights.pathOverlap * pathScore;

    hits.push({
      episode: ep,
      score,
      components: {
        vector: vectorScore,
        fts: ftsScore,
        recency: recencyScore,
        pathOverlap: pathScore,
      },
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

function computePathOverlap(queryPaths: string[], episodePaths: string[]): number {
  if (queryPaths.length === 0 || episodePaths.length === 0) return 0;
  const qSet = new Set(queryPaths.map((p) => p.toLowerCase()));
  let hits = 0;
  for (const ep of episodePaths) {
    if (qSet.has(ep.toLowerCase())) hits++;
    else {
      // Partial match — basename equality is a common useful signal.
      const base = basename(ep).toLowerCase();
      for (const q of qSet) {
        if (basename(q) === base) {
          hits += 0.5;
          break;
        }
      }
    }
  }
  return Math.min(1, hits / Math.max(queryPaths.length, episodePaths.length));
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
