/**
 * P0 baseline runner — measures the CURRENT session resolver against a labeled
 * fixture, establishing the precision@1 number that P1 must beat.
 *
 * The current resolver (`MemoryEngine.searchSessions`) is **workspace-scoped**,
 * so we measure two regimes:
 *   - **within-workspace** — query the gold session's workspace only. Upper bound
 *     of today's capability (assumes you already know which repo).
 *   - **cross-workspace** — the conductor's real need. Today's code can't do this
 *     natively, so the baseline is the naive "run per-workspace, merge by
 *     aggregateScore" approach P1 replaces with global fusion + rerank.
 *
 * Run (points at a real memory.db + the local BGE-small model cache):
 *   MEMORY_DB=/path/to/memory.db bun run src/daemon/eval/baseline.ts
 *   optional: FIXTURE=... MODEL_CACHE=~/.codeoid/models
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteEpisodeStore } from "@highflame/codeoid-memory/store.js";
import { createEmbedder } from "@highflame/codeoid-memory/embedder.js";
import { createReranker } from "@highflame/codeoid-memory/reranker.js";
import { MemoryEngine, type SessionSearchHit } from "@highflame/codeoid-memory/engine.js";
import { precisionAt1, mrr, recallAtK, percentile, type EvalCase } from "./metrics.js";

interface FixtureCase {
  reference: string;
  expectedSessionId: string;
  expectedWorkspaceId: string;
}

const HOME = process.env.HOME ?? "";
const MEMORY_DB = process.env.MEMORY_DB ?? `${HOME}/.codeoid/memory.db`;
const MODEL_CACHE = process.env.MODEL_CACHE ?? `${HOME}/.codeoid/models`;
const FIXTURE =
  process.env.FIXTURE ??
  fileURLToPath(new URL("./fixtures/session-resolution.json", import.meta.url));

const cases: FixtureCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
const evalCases: EvalCase[] = cases.map((c) => ({
  reference: c.reference,
  expectedSessionId: c.expectedSessionId,
}));

const store = new SqliteEpisodeStore(MEMORY_DB);
const embedder = await createEmbedder({ cacheDir: MODEL_CACHE });
const reranker = await createReranker({ cacheDir: MODEL_CACHE });
const engine = new MemoryEngine({ store, embedder, reranker });
await engine.init();

// Enumerate workspaces + count sessions straight from the DB (read-only).
const raw = new Database(MEMORY_DB, { readonly: true });
const workspaces = (
  raw.query("SELECT DISTINCT workspace_id AS w FROM episodes").all() as { w: string }[]
).map((r) => r.w);
const sessionCount = (
  raw.query("SELECT count(DISTINCT session_id) AS c FROM episodes").get() as { c: number }
).c;

/** Cross-workspace: run per-workspace searchSessions, merge, rank by aggregateScore. */
async function crossRank(query: string): Promise<string[]> {
  const all: SessionSearchHit[] = [];
  for (const ws of workspaces) {
    all.push(...(await engine.searchSessions({ query, workspaceId: ws, limit: 10 })));
  }
  const best = new Map<string, number>();
  for (const h of all) {
    const cur = best.get(h.sessionId);
    if (cur === undefined || h.aggregateScore > cur) best.set(h.sessionId, h.aggregateScore);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

/** Within-workspace: query only the gold session's workspace. */
async function withinRank(query: string, ws: string): Promise<string[]> {
  const hits = await engine.searchSessions({ query, workspaceId: ws, limit: 10 });
  return hits.map((h) => h.sessionId);
}

/** Cross-workspace GLOBAL fusion, no rerank (P1 slice 1). */
async function globalRank(query: string): Promise<string[]> {
  const hits = await engine.searchSessions({ query, limit: 15, rerank: false });
  return hits.map((h) => h.sessionId);
}

/** Cross-workspace GLOBAL fusion + cross-encoder rerank (P1 slice 2). */
async function globalRerankRank(query: string): Promise<string[]> {
  const hits = await engine.searchSessions({ query, limit: 15, rerank: true });
  return hits.map((h) => h.sessionId);
}

const crossRanked: string[][] = [];
const crossLat: number[] = [];
const withinRanked: string[][] = [];
const withinLat: number[] = [];
const globalRanked: string[][] = [];
const globalLat: number[] = [];
const rerankRanked: string[][] = [];
const rerankLat: number[] = [];

for (const c of cases) {
  let t = performance.now();
  crossRanked.push(await crossRank(c.reference));
  crossLat.push(performance.now() - t);

  t = performance.now();
  withinRanked.push(await withinRank(c.reference, c.expectedWorkspaceId));
  withinLat.push(performance.now() - t);

  t = performance.now();
  globalRanked.push(await globalRank(c.reference));
  globalLat.push(performance.now() - t);

  t = performance.now();
  rerankRanked.push(await globalRerankRank(c.reference));
  rerankLat.push(performance.now() - t);
}

function report(label: string, ranked: string[][], lat: number[]): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\n${label}`);
  console.log(`  P@1 = ${pct(precisionAt1(evalCases, ranked))}   MRR = ${mrr(evalCases, ranked).toFixed(3)}`);
  console.log(`  R@3 = ${pct(recallAtK(evalCases, ranked, 3))}   R@5 = ${pct(recallAtK(evalCases, ranked, 5))}`);
  console.log(`  latency p50/p95 = ${percentile(lat, 50).toFixed(0)}/${percentile(lat, 95).toFixed(0)} ms`);
}

console.log("═".repeat(72));
console.log(
  `Baseline: ${sessionCount} sessions across ${workspaces.length} workspaces; ${cases.length} labeled references`,
);
console.log(`Embedder: ${embedder.modelName} (${embedder.dimensions}d)`);
report("WITHIN-workspace (upper bound — you already know the repo):", withinRanked, withinLat);
report("CROSS-workspace (BASELINE — naive per-ws merge):", crossRanked, crossLat);
report("CROSS-workspace GLOBAL fusion (P1 slice 1 — no rerank):", globalRanked, globalLat);
report("CROSS-workspace GLOBAL + rerank (P1 slice 2):", rerankRanked, rerankLat);

console.log("\nCross-workspace GLOBAL+rerank (P1) P@1 misses:");
let misses = 0;
cases.forEach((c, i) => {
  const top = rerankRanked[i]?.[0];
  if (top !== c.expectedSessionId) {
    misses++;
    const r = rerankRanked[i]?.indexOf(c.expectedSessionId) ?? -1;
    console.log(
      `  ✗ "${c.reference.slice(0, 58)}" → got ${top?.slice(0, 8) ?? "∅"}, want ${c.expectedSessionId.slice(0, 8)} (rank ${r < 0 ? "NF" : r + 1})`,
    );
  }
});
if (misses === 0) console.log("  (none)");
console.log("═".repeat(72));

await engine.close();
raw.close();
