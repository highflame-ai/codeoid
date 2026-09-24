/**
 * Target context-window resolution for cross-backend history seeding.
 *
 * When a session forks or switches onto another backend, its conversation is
 * replayed to the new backend as a prompt-prefix "seed" (see
 * renderHistorySeed). The seed must fit the TARGET model's context window —
 * so we size it to that window and only truncate when the history genuinely
 * doesn't fit (and surface it when we do).
 *
 * The numbers are HYBRID (per the design decision):
 *   1. Exact per-model window when we know the model — Claude via the shared
 *      MODEL_CATALOG, a few high-confidence non-Claude families below.
 *   2. Otherwise a conservative per-provider DEFAULT — used at fork/seed time,
 *      when the exact target model isn't chosen yet (a cross-backend fork
 *      resets to the new provider's default model), or for unknown models.
 *
 * Conservative-by-design: under-estimating a window over-truncates (safe, and
 * surfaced); over-estimating risks overflowing the model's real window (breaks
 * the turn).
 *
 * Both functions take an optional `reported` window that OUTRANKS everything
 * here — the daemon caches what each backend said about a model on a completed
 * turn (`SessionManager.modelContextWindow`). The tables below are the
 * bootstrap for what that cache cannot answer: a model no turn has run on yet,
 * and backends that report no limits at all. They are a floor, not the truth.
 */

import { contextWindowForModel as claudeContextWindow } from "../context-windows.js";

/** Fallback when neither the model nor the provider is recognized. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Per-provider DEFAULT context window (tokens). Used when the exact target
 * model is unknown (the common fork case) or unrecognized.
 */
const PROVIDER_DEFAULT_WINDOW: Readonly<Record<string, number>> = {
  claude: 200_000, // Opus/Sonnet are 1M (via catalog); 200k is the safe floor.
  codex: 256_000, // gpt-5-codex family.
  openai: 128_000, // gpt-4o floor; larger models refined per-model below.
  gemini: 1_000_000,
  "gemini-cli": 1_000_000,
  pi: 200_000, // pi is multi-provider (defaults to google/1M); 200k is a safe middle.
};

/**
 * High-confidence exact per-model windows for NON-Claude models (Claude comes
 * from MODEL_CATALOG). Matched by substring/regex on the model id. Keep only
 * entries we're confident about — a wrong (too-high) number risks overflow.
 */
const MODEL_WINDOW_OVERRIDES: ReadonlyArray<{ match: RegExp; window: number }> = [
  { match: /gemini-(1\.5|2\.0|2\.5|3)/i, window: 1_000_000 },
  { match: /gpt-4\.1/i, window: 1_000_000 },
  { match: /gpt-4o/i, window: 128_000 },
];

/**
 * Resolve the TARGET context window (tokens) for a (provider, model) pair when
 * seeding a fork/switch. Exact per-model when known — Claude defers to the
 * canonical catalog in ../context-windows.ts (single source of truth), other
 * families use the overrides above — else the provider default, else fallback.
 *
 * Distinct from ../context-windows.ts `contextWindowForModel(model)`, which is
 * Claude-only and drives SessionInfo's percent-of-window UI. This one is
 * provider-aware and sized for cross-backend seeding.
 */
export function targetContextWindow(
  providerId: string,
  model?: string | null,
  reported?: number,
): number {
  // A number the BACKEND reported for this exact (provider, model) beats
  // every guess below it. The tiers that follow are inference — they exist
  // because nothing knows a window until a turn has run, and some backends
  // never report one.
  if (reported !== undefined && reported > 0) return reported;
  if (model) {
    // Claude models: reuse the canonical Claude catalog (opus/sonnet/haiku +
    // full ids + aliases), so there's one place that knows Claude windows.
    if (providerId === "claude" || /claude|opus|sonnet|haiku|fable|mythos/i.test(model)) {
      return claudeContextWindow(model);
    }
    for (const { match, window } of MODEL_WINDOW_OVERRIDES) {
      if (match.test(model)) return window;
    }
  }
  return PROVIDER_DEFAULT_WINDOW[providerId] ?? FALLBACK_CONTEXT_WINDOW;
}

/**
 * Fraction of the target window the seed may occupy — the rest is headroom
 * for the system prompt, the user's next message, and the model's generation.
 */
export const SEED_WINDOW_FRACTION = 0.7;

/**
 * Conservative chars-per-token for sizing the seed. Rendered seeds carry code
 * and JSON, which tokenize denser than prose, so we UNDER-estimate (fewer
 * chars per token → smaller char budget → safe against overflow).
 */
export const SEED_CHARS_PER_TOKEN = 3.5;

/**
 * Character budget for a history seed targeting (provider, model). This is the
 * `maxChars` handed to renderHistorySeed — sized to the target window so a
 * fork only truncates when the conversation genuinely won't fit.
 *
 * `CODEOID_SEED_BUDGET_CHARS` overrides the computed budget with a hard cap
 * (any positive integer). Operators use it to bound the transcript seed
 * regardless of the target window (e.g. to keep first-turn cost predictable on
 * a huge-context model); it also lets the resume-beyond-budget eval force
 * truncation with a small history instead of ~490k chars.
 */
export function seedBudgetChars(
  providerId: string,
  model?: string | null,
  reported?: number,
): number {
  const override = Number(process.env.CODEOID_SEED_BUDGET_CHARS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const window = targetContextWindow(providerId, model, reported);
  return Math.floor(window * SEED_WINDOW_FRACTION * SEED_CHARS_PER_TOKEN);
}
