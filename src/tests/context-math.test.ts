/**
 * Pure-function tests for context-math — rotation decisions, multi-call
 * detection, primary-context computation. No SDK, no DB, no clock.
 *
 * These are the tests that prevent "the math drifts silently and we only
 * notice when the ctx indicator looks insane" — the exact class of bug
 * that prompted this module's extraction.
 */

import { describe, it, expect } from "bun:test";
import {
  CONTEXT_WINDOW_DEFAULT,
  callContextSize,
  primaryTurnContext,
  decideRotation,
  isAggregatedMultiCallTurn,
  cappedOccupancy,
  avgCacheReadPerTurn,
  type LLMCallUsage,
  type RotationDecisionInput,
} from "../daemon/context-math.js";

function call(overrides: Partial<LLMCallUsage> = {}): LLMCallUsage {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

// ── callContextSize ─────────────────────────────────────────────────────

describe("callContextSize", () => {
  it("sums input + cache_read + cache_creation", () => {
    const size = callContextSize(
      call({
        inputTokens: 100,
        cacheReadTokens: 50_000,
        cacheCreationTokens: 5_000,
      }),
    );
    expect(size).toBe(55_100);
  });

  it("excludes output — output isn't part of input context", () => {
    expect(
      callContextSize(
        call({ inputTokens: 100, outputTokens: 9_999_999 }),
      ),
    ).toBe(100);
  });

  it("zero on empty input", () => {
    expect(callContextSize(call())).toBe(0);
  });

  it("treats missing fields as 0", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const partial: any = { inputTokens: 500 };
    expect(callContextSize(partial)).toBe(500);
  });
});

// ── primaryTurnContext ──────────────────────────────────────────────────

describe("primaryTurnContext", () => {
  it("empty array → 0", () => {
    expect(primaryTurnContext([])).toBe(0);
  });

  it("single call → that call's size", () => {
    expect(
      primaryTurnContext([call({ inputTokens: 100, cacheReadTokens: 50_000 })]),
    ).toBe(50_100);
  });

  it("multiple primary calls → MAX (not sum) — biggest snapshot", () => {
    // Three calls in one turn. Each has context approximately equal to the
    // current conversation state at its moment. Biggest = current ctx.
    const size = primaryTurnContext([
      call({ inputTokens: 50, cacheReadTokens: 100_000 }),
      call({ inputTokens: 80, cacheReadTokens: 150_000 }),
      call({ inputTokens: 120, cacheReadTokens: 200_000 }),
    ]);
    expect(size).toBe(200_120); // the biggest one, not the sum (550k)
  });

  it("the classic 24-turn session with 214k avg stays healthy", () => {
    // Simulated: each primary call is ~214k (the avg-cache-read proxy).
    expect(
      primaryTurnContext([
        call({ cacheReadTokens: 210_000 }),
        call({ cacheReadTokens: 215_000 }),
        call({ inputTokens: 500, cacheReadTokens: 214_000 }),
      ]),
    ).toBe(215_000);
  });
});

// ── decideRotation ──────────────────────────────────────────────────────

describe("decideRotation", () => {
  function baseInput(): RotationDecisionInput {
    return {
      primaryLastTurnContext: 0,
      numTurns: 10,
      enabled: true,
      rotatePct: 0.9,
      hardRotatePct: 0.97,
      minTurnsBeforeRotate: 5,
    };
  }

  it("no signal yet → no rotation", () => {
    const out = decideRotation({ ...baseInput(), primaryLastTurnContext: 0 });
    expect(out.shouldRotate).toBe(false);
    expect(out.reason).toBe("no_signal");
  });

  it("below min-turns guard → no rotation at elevated (but sub-ceiling) occupancy", () => {
    // 91%: past the soft threshold, still under the 97% hard ceiling. This is
    // the guard's actual job — suppress churn in the first few turns after a
    // rotation, while the seed prompt is still earning its keep.
    const out = decideRotation({
      ...baseInput(),
      primaryLastTurnContext: 910_000,
      numTurns: 2,
    });
    expect(out.shouldRotate).toBe(false);
    expect(out.reason).toBe("below_min_turns");
  });

  it("under soft threshold → no rotation", () => {
    const out = decideRotation({
      ...baseInput(),
      primaryLastTurnContext: 850_000, // 85% < 90% soft
    });
    expect(out.shouldRotate).toBe(false);
    expect(out.reason).toBe("below_threshold");
    expect(out.occupancy).toBeCloseTo(0.85, 3);
  });

  it("soft threshold when enabled → rotates", () => {
    const out = decideRotation({
      ...baseInput(),
      primaryLastTurnContext: 910_000, // 91% ≥ 90% soft
    });
    expect(out.shouldRotate).toBe(true);
    expect(out.reason).toBe("soft_threshold");
  });

  it("disabled + under hard threshold → no rotation", () => {
    const out = decideRotation({
      ...baseInput(),
      enabled: false,
      primaryLastTurnContext: 910_000,
    });
    expect(out.shouldRotate).toBe(false);
    expect(out.reason).toBe("disabled_below_hard");
  });

  it("hard threshold fires REGARDLESS of enabled (safety net)", () => {
    const out = decideRotation({
      ...baseInput(),
      enabled: false,
      primaryLastTurnContext: 975_000, // 97.5% ≥ 97% hard
    });
    expect(out.shouldRotate).toBe(true);
    expect(out.reason).toBe("hard_threshold");
  });

  it("hard threshold PREEMPTS min-turns — the net is unconditional", () => {
    // Deliberate inversion of the previous behaviour. The ceiling is the last
    // defence before the backend rejects the prompt outright, so no other
    // guard may gate it. A session that reaches 97% inside its first turns —
    // one large paste, a wide repo scan — needs the net more than a
    // long-running one, not less.
    //
    // This ordering also means a stuck turn counter can no longer disable the
    // net silently, which is precisely how it failed: with memory enabled the
    // counter never advanced past 0, so `below_min_turns` was returned on
    // every check and a 999,627-token session rotated zero times.
    const out = decideRotation({
      ...baseInput(),
      numTurns: 1,
      primaryLastTurnContext: 999_999,
    });
    expect(out.shouldRotate).toBe(true);
    expect(out.reason).toBe("hard_threshold");
  });

  it("a never-advancing turn counter cannot suppress the ceiling", () => {
    // The exact shape of the bug: numTurns pinned at 0 forever.
    const out = decideRotation({
      ...baseInput(),
      enabled: false,
      numTurns: 0,
      primaryLastTurnContext: 999_627, // the observed live value
    });
    expect(out.shouldRotate).toBe(true);
    expect(out.reason).toBe("hard_threshold");
  });

  it("the user's 24-turn 214k avg case: NO rotation (healthy)", () => {
    // With new defaults. User reported a session rotating at 24 turns with
    // ~214k avg primary context. That SHOULD be healthy under the new
    // primary-only metric + raised thresholds.
    const out = decideRotation({
      primaryLastTurnContext: 214_000,
      numTurns: 24,
      enabled: true,
      rotatePct: 0.9,
      hardRotatePct: 0.97,
      minTurnsBeforeRotate: 5,
    });
    expect(out.shouldRotate).toBe(false);
    expect(out.occupancy).toBeCloseTo(0.214, 3);
  });
});

// ── isAggregatedMultiCallTurn ───────────────────────────────────────────

describe("isAggregatedMultiCallTurn", () => {
  it("flag true when sum exceeds window (e.g. 2.05M on 1M window)", () => {
    expect(isAggregatedMultiCallTurn(2_050_000)).toBe(true);
  });

  it("false when within window", () => {
    expect(isAggregatedMultiCallTurn(950_000)).toBe(false);
    expect(isAggregatedMultiCallTurn(1_000_000)).toBe(false);
  });

  it("respects custom window size", () => {
    expect(isAggregatedMultiCallTurn(210_000, 200_000)).toBe(true);
    expect(isAggregatedMultiCallTurn(190_000, 200_000)).toBe(false);
  });
});

// ── cappedOccupancy ─────────────────────────────────────────────────────

describe("cappedOccupancy", () => {
  it("returns ratio within [0, 1]", () => {
    expect(cappedOccupancy(500_000)).toBeCloseTo(0.5, 3);
    expect(cappedOccupancy(0)).toBe(0);
  });

  it("caps at 1.0 even when input exceeds window (multi-call aggregate)", () => {
    expect(cappedOccupancy(2_050_000)).toBe(1);
  });

  it("safe on invalid input", () => {
    expect(cappedOccupancy(Number.NaN)).toBe(0);
    expect(cappedOccupancy(-100)).toBe(0);
  });
});

// ── avgCacheReadPerTurn ─────────────────────────────────────────────────

describe("avgCacheReadPerTurn", () => {
  it("returns 0 on zero turns (safe)", () => {
    expect(avgCacheReadPerTurn(1_000_000, 0)).toBe(0);
  });

  it("rounds the average", () => {
    expect(avgCacheReadPerTurn(5_140_000, 24)).toBe(214_167);
  });
});

// ── defaults + sanity ───────────────────────────────────────────────────

describe("CONTEXT_WINDOW_DEFAULT", () => {
  it("is 1M", () => {
    expect(CONTEXT_WINDOW_DEFAULT).toBe(1_000_000);
  });
});
