/**
 * Pure math functions for context-window accounting + rotation decisions.
 *
 * Extracted out of Session so the logic is trivially testable in isolation
 * (no SDK, no DB, no clock). Callers pass in the relevant counters; we
 * return a boolean / number. No I/O, no state.
 *
 * Design follows VSCode Claude extension's approach:
 *   - ctx = the PRIMARY agent's current context size
 *   - subagents have separate ephemeral contexts and DO NOT count
 *   - cache_read + cache_creation + new input are all part of primary ctx
 *     (they're all bytes the model processed for that primary call)
 */

/** Default context window for the current Opus / Sonnet families (1M). */
export const CONTEXT_WINDOW_DEFAULT = 1_000_000;

/**
 * Per-LLM-call usage — as reported by Anthropic's API on each response.
 * One primary assistant call = one of these. One subagent call = one too.
 */
export interface LLMCallUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/**
 * Total context size of a single LLM call (what the model was asked to
 * process). Hard-bounded by the API to the context window.
 */
export function callContextSize(u: LLMCallUsage): number {
  return (
    (u.inputTokens || 0) +
    (u.cacheReadTokens || 0) +
    (u.cacheCreationTokens || 0)
  );
}

/**
 * Compute the primary-agent context size from a list of primary LLM calls
 * within a turn. Returns the MAX across those calls — the biggest single
 * primary-context snapshot taken during the turn, which reflects the
 * current state of the primary conversation (subsequent calls repeat
 * that context).
 */
export function primaryTurnContext(calls: readonly LLMCallUsage[]): number {
  let max = 0;
  for (const c of calls) {
    const size = callContextSize(c);
    if (size > max) max = size;
  }
  return max;
}

export interface RotationDecisionInput {
  /** Primary context size from the last turn. */
  primaryLastTurnContext: number;
  /** Number of completed turns so far. */
  numTurns: number;
  /** Whether auto-rotate is enabled. */
  enabled: boolean;
  /** Soft threshold — rotates when enabled + over min turns. */
  rotatePct: number;
  /** Hard threshold — rotates regardless of `enabled` (safety net). */
  hardRotatePct: number;
  /** Minimum turns before rotation is allowed at all. */
  minTurnsBeforeRotate: number;
  /** Context window size (default 1M). */
  contextWindow?: number;
}

export type RotationReason =
  | "below_min_turns"
  | "no_signal" // primaryLastTurnContext <= 0
  | "below_threshold"
  | "disabled_below_hard"
  | "soft_threshold"
  | "hard_threshold";

export interface RotationDecision {
  shouldRotate: boolean;
  reason: RotationReason;
  occupancy: number; // 0..1
}

/**
 * Decide whether to auto-rotate before the next send. Pure function — all
 * inputs passed in, single boolean out + a diagnostic reason code.
 */
export function decideRotation(input: RotationDecisionInput): RotationDecision {
  const W = input.contextWindow ?? CONTEXT_WINDOW_DEFAULT;
  const ctx = input.primaryLastTurnContext;
  if (ctx <= 0) {
    return { shouldRotate: false, reason: "no_signal", occupancy: 0 };
  }
  const occupancy = ctx / W;
  // The hard ceiling is checked FIRST, ahead of the min-turns guard.
  //
  // It is the last line of defence before the backend rejects the prompt
  // outright, and it is documented to fire regardless of the `enabled`
  // toggle — so letting a *different* guard preempt it made it conditional
  // in practice. The min-turns window exists to stop churn right after a
  // rotation (the seed prompt needs a few turns to earn its keep); it was
  // never meant to license running past the context ceiling. A session that
  // legitimately reaches 97% inside its first few turns — one big paste, a
  // wide repo scan — needs the net MORE than a long-running one, not less.
  //
  // Ordering it this way also means a stuck/never-advancing turn counter can
  // no longer disable the net silently, which is exactly how this failed
  // before (see the counter hoist in Session#recordUsageFromTurn).
  if (occupancy >= input.hardRotatePct) {
    return { shouldRotate: true, reason: "hard_threshold", occupancy };
  }
  if (input.numTurns < input.minTurnsBeforeRotate) {
    return { shouldRotate: false, reason: "below_min_turns", occupancy };
  }
  if (!input.enabled) {
    return { shouldRotate: false, reason: "disabled_below_hard", occupancy };
  }
  if (occupancy >= input.rotatePct) {
    return { shouldRotate: true, reason: "soft_threshold", occupancy };
  }
  return { shouldRotate: false, reason: "below_threshold", occupancy };
}

/**
 * When the SDK reports a turn's total usage as a SUM across multiple API
 * calls (primary + subagents + retries), the raw peak can exceed the
 * context window — mathematically impossible for a single call. Detect
 * that so UIs can badge it ("Σ multi-call") rather than showing
 * nonsensical "205% of window".
 */
export function isAggregatedMultiCallTurn(
  turnTotalTokens: number,
  contextWindow = CONTEXT_WINDOW_DEFAULT,
): boolean {
  return turnTotalTokens > contextWindow;
}

/**
 * Cap a displayed percentage at 100%. Raw ratios > 1.0 only happen for
 * multi-call aggregated sums; clamping keeps the UI honest.
 */
export function cappedOccupancy(
  ctx: number,
  contextWindow = CONTEXT_WINDOW_DEFAULT,
): number {
  if (!Number.isFinite(ctx) || ctx <= 0) return 0;
  return Math.min(ctx / contextWindow, 1);
}

/**
 * Average cache_read tokens across the session — a proxy for "typical
 * primary context size" when we don't have per-call data (fallback).
 * Less accurate than primaryTurnContext but works when only aggregates
 * are available.
 */
export function avgCacheReadPerTurn(
  cumulativeCacheReadTokens: number,
  numTurns: number,
): number {
  if (numTurns <= 0) return 0;
  return Math.round(cumulativeCacheReadTokens / numTurns);
}
