/**
 * Turn-usage persistence tests — production-grade token instrumentation.
 *
 * Exercises:
 *   - recordTurnUsage / listTurnsForSession round-trip
 *   - sessionUsageTotals roll-up with cache + cost
 *   - nextTurnNumber monotonicity + resume-after-restart semantics
 *   - Derived fields (billableInputTokens, cacheHitRate) computed on read
 *   - Upsert semantics on duplicate (session_id, turn_number)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEpisodeStore } from "../daemon/memory/index.js";
import type { TurnUsage } from "../protocol/types.js";

let tmp: string;
let store: SqliteEpisodeStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-usage-"));
  store = new SqliteEpisodeStore(join(tmp, "memory.db"));
});

afterEach(() => {
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const WS = "ws_test";

function mkTurn(n: number, overrides: Partial<TurnUsage> = {}): TurnUsage {
  const input = overrides.inputTokens ?? 1000;
  const cacheRead = overrides.cacheReadTokens ?? 0;
  const cacheCreate = overrides.cacheCreationTokens ?? 0;
  const total = input + cacheRead + cacheCreate;
  return {
    turnNumber: n,
    createdAt: 1_700_000_000_000 + n * 1000,
    inputTokens: input,
    outputTokens: overrides.outputTokens ?? 100,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    totalCostUsd: overrides.totalCostUsd ?? 0.01,
    durationMs: overrides.durationMs ?? 500,
    stopReason: overrides.stopReason,
    totalInputTokens: total,
    billableInputTokens: input + cacheCreate,
    cacheHitRate: total > 0 ? cacheRead / total : 0,
  };
}

describe("recordTurnUsage / listTurnsForSession", () => {
  it("persists a turn and reads it back with derived fields", () => {
    // Realistic turn: 4 new input, 20k from cache read, 0 cache write.
    const turn = mkTurn(1, {
      inputTokens: 4,
      cacheReadTokens: 20_000,
      outputTokens: 500,
      totalCostUsd: 0.032,
    });
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s1", turn });

    const rows = store.listTurnsForSession("s1", 10);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.turnNumber).toBe(1);
    expect(r.inputTokens).toBe(4);
    expect(r.cacheReadTokens).toBe(20_000);
    // Derived on read, not stored.
    expect(r.totalInputTokens).toBe(20_004); // new + cache_read + cache_create
    expect(r.billableInputTokens).toBe(4); // new + cache_create (no cache writes here)
    expect(r.cacheHitRate).toBeCloseTo(20_000 / 20_004, 5);
    // Crucial: cache hit rate must be <= 1.0 (the old bug made it 5000).
    expect(r.cacheHitRate).toBeLessThanOrEqual(1);
  });

  it("cache hit rate stays in [0,1] even when new input_tokens is tiny", () => {
    const turn = mkTurn(1, {
      inputTokens: 4,
      cacheReadTokens: 22_744,
      cacheCreationTokens: 0,
    });
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s1", turn });
    const r = store.listTurnsForSession("s1", 10)[0]!;
    expect(r.cacheHitRate).toBeGreaterThan(0.99);
    expect(r.cacheHitRate).toBeLessThanOrEqual(1);
  });

  it("counts cache_creation as billable (cache writes are ~1.25x price)", () => {
    const turn = mkTurn(1, {
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 5_000,
    });
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s1", turn });
    const r = store.listTurnsForSession("s1", 10)[0]!;
    expect(r.billableInputTokens).toBe(5_100);
    expect(r.totalInputTokens).toBe(5_100);
    // No cache reads = 0% hit rate.
    expect(r.cacheHitRate).toBe(0);
  });

  it("returns turns newest-first", () => {
    for (let n = 1; n <= 5; n++) {
      store.recordTurnUsage({
        workspaceId: WS,
        sessionId: "s1",
        turn: mkTurn(n),
      });
    }
    const rows = store.listTurnsForSession("s1", 10);
    expect(rows.map((r) => r.turnNumber)).toEqual([5, 4, 3, 2, 1]);
  });

  it("honors the limit", () => {
    for (let n = 1; n <= 50; n++) {
      store.recordTurnUsage({
        workspaceId: WS,
        sessionId: "s1",
        turn: mkTurn(n),
      });
    }
    expect(store.listTurnsForSession("s1", 5).length).toBe(5);
    expect(store.listTurnsForSession("s1", 20).length).toBe(20);
  });

  it("upserts on duplicate (session_id, turn_number)", () => {
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(1, { inputTokens: 1_000 }),
    });
    // Same turn number, different totals — should replace, not duplicate.
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(1, { inputTokens: 5_000 }),
    });
    const rows = store.listTurnsForSession("s1", 10);
    expect(rows.length).toBe(1);
    expect(rows[0]!.inputTokens).toBe(5_000);
  });

  it("scopes by session_id (no cross-session leakage)", () => {
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(1),
    });
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s2",
      turn: mkTurn(1),
    });
    expect(store.listTurnsForSession("s1", 10).length).toBe(1);
    expect(store.listTurnsForSession("s2", 10).length).toBe(1);
  });
});

describe("sessionUsageTotals", () => {
  it("returns zeros for unknown session", () => {
    const t = store.sessionUsageTotals("nonexistent");
    expect(t.inputTokens).toBe(0);
    expect(t.numTurns).toBe(0);
    expect(t.peakInputTokens).toBe(0);
  });

  it("rolls up across turns", () => {
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(1, { inputTokens: 1_000, outputTokens: 200, totalCostUsd: 0.01 }),
    });
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(2, { inputTokens: 3_000, outputTokens: 100, totalCostUsd: 0.03 }),
    });
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(3, { inputTokens: 2_000, outputTokens: 400, totalCostUsd: 0.02 }),
    });

    const t = store.sessionUsageTotals("s1");
    expect(t.inputTokens).toBe(6_000);
    expect(t.outputTokens).toBe(700);
    expect(t.totalCostUsd).toBeCloseTo(0.06, 5);
    expect(t.numTurns).toBe(3);
    // Peak is the MAX of total context (input + cache_read + cache_create).
    // No cache fields here so it equals the max raw input (3k).
    expect(t.peakInputTokens).toBe(3_000);
  });

  it("peak tracks total context size, not just new input", () => {
    // Turn 1: 100 new + 50k cached = 50,100 total context
    // Turn 2: 5k new + 0 cached = 5,000 total context
    // Peak should be 50,100 — the turn with massive cached context was
    // the real bloat indicator, even though its new_input was tiny.
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(1, { inputTokens: 100, cacheReadTokens: 50_000 }),
    });
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(2, { inputTokens: 5_000, cacheReadTokens: 0 }),
    });
    const t = store.sessionUsageTotals("s1");
    expect(t.peakInputTokens).toBe(50_100);
  });

  it("tracks cache tokens separately from input", () => {
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(1, {
        inputTokens: 10_000,
        cacheReadTokens: 7_000,
        cacheCreationTokens: 2_000,
      }),
    });
    const t = store.sessionUsageTotals("s1");
    expect(t.cacheReadTokens).toBe(7_000);
    expect(t.cacheCreationTokens).toBe(2_000);
  });
});

describe("nextTurnNumber", () => {
  it("starts at 1 for a fresh session", () => {
    expect(store.nextTurnNumber("new-session")).toBe(1);
  });

  it("increments past the max existing turn", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      store.recordTurnUsage({
        workspaceId: WS,
        sessionId: "s1",
        turn: mkTurn(n),
      });
    }
    expect(store.nextTurnNumber("s1")).toBe(6);
  });

  it("is immune to daemon restart (reads from disk)", () => {
    store.recordTurnUsage({
      workspaceId: WS,
      sessionId: "s1",
      turn: mkTurn(7),
    });
    const path = (store as unknown as { constructor: { name: string } }).constructor.name;
    expect(path).toBe("SqliteEpisodeStore"); // sanity: we're exercising the SQLite impl
    store.close();
    // Reopen — simulates daemon restart.
    const reopened = new SqliteEpisodeStore(join(tmp, "memory.db"));
    expect(reopened.nextTurnNumber("s1")).toBe(8);
    reopened.close();
  });
});

describe("where a turn's cost came from (#430)", () => {
  it("is kept with the turn, and the totals say what's estimated and what's unknown", () => {
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s1", turn: { ...mkTurn(1, { totalCostUsd: 0.5 }), costSource: "backend" } });
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s1", turn: { ...mkTurn(2, { totalCostUsd: 0.25 }), costSource: "estimated" } });
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s1", turn: { ...mkTurn(3, { totalCostUsd: 0 }), costSource: "unknown" } });
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s1", turn: { ...mkTurn(4, { totalCostUsd: 0 }), costSource: "unknown" } });
    expect(store.listTurnsForSession("s1").map((t) => t.costSource)).toEqual(["unknown", "unknown", "estimated", "backend"]);
    const totals = store.sessionUsageTotals("s1");
    expect(totals.totalCostUsd).toBeCloseTo(0.75, 9);
    expect(totals.costEstimated).toBe(true);
    expect(totals.costUnknownTurns).toBe(2);
  });

  it("reads turns recorded before it as plain reported costs", () => {
    store.recordTurnUsage({ workspaceId: WS, sessionId: "s2", turn: mkTurn(1, { totalCostUsd: 0.1 }) });
    expect(store.listTurnsForSession("s2")[0]?.costSource).toBeUndefined();
    const totals = store.sessionUsageTotals("s2");
    expect(totals.costEstimated).toBe(false);
    expect(totals.costUnknownTurns).toBe(0);
  });

  it("adds the column to a database made before it", () => {
    const old = new (require("bun:sqlite").Database)(join(tmp, "old.db"));
    old.exec(`CREATE TABLE turn_usage (
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, created_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, stop_reason TEXT,
      PRIMARY KEY (session_id, turn_number))`);
    old.close();
    const upgraded = new SqliteEpisodeStore(join(tmp, "old.db"));
    upgraded.recordTurnUsage({ workspaceId: WS, sessionId: "s3", turn: { ...mkTurn(1), costSource: "estimated" } });
    expect(upgraded.listTurnsForSession("s3")[0]?.costSource).toBe("estimated");
    upgraded.close();
  });
});
