/**
 * Target context-window resolution for cross-backend history seeding.
 *
 * Hybrid model: exact per-model window when known (Claude via MODEL_CATALOG,
 * a few non-Claude overrides), else a conservative per-provider default, else
 * a fallback. The seed budget is a fraction of that window in chars.
 */

import { describe, it, expect } from "bun:test";
import {
  targetContextWindow,
  seedBudgetChars,
  FALLBACK_CONTEXT_WINDOW,
  SEED_WINDOW_FRACTION,
  SEED_CHARS_PER_TOKEN,
} from "../daemon/providers/context-windows.js";

describe("a backend-reported window outranks every inference", () => {
  // The point of the change: the tables in context-windows.ts are a bootstrap,
  // not the truth. They were the truth, and they went stale every time a model
  // shipped — `claude-opus-5-5` inferred to 200k while the backend reported
  // 1,000,000 on every single turn.
  it("wins over the per-model table, even when the table has an answer", () => {
    // The table says 1M for opus; a backend reporting 512k is still right.
    expect(targetContextWindow("claude", "opus", 512_000)).toBe(512_000);
    // ...and over a table answer that is WRONG, which is the real case.
    expect(targetContextWindow("claude", "claude-opus-9-unknown", 1_000_000)).toBe(1_000_000);
  });

  it("wins over the per-provider default for an unknown model", () => {
    expect(targetContextWindow("openai", "some-new-model")).toBe(128_000); // inferred
    expect(targetContextWindow("openai", "some-new-model", 400_000)).toBe(400_000);
  });

  it("is ignored when absent or non-positive, so inference still answers", () => {
    // A backend that reports nothing must not collapse the window to zero —
    // that would divide-by-zero the percent-of-window and starve the seed.
    expect(targetContextWindow("claude", "opus", undefined)).toBe(1_000_000);
    expect(targetContextWindow("claude", "opus", 0)).toBe(1_000_000);
    expect(targetContextWindow("claude", "opus", -1)).toBe(1_000_000);
  });

  it("sizes the seed budget from the reported window", () => {
    const reported = 600_000;
    expect(seedBudgetChars("claude", "opus", reported)).toBe(
      Math.floor(reported * SEED_WINDOW_FRACTION * SEED_CHARS_PER_TOKEN),
    );
    // The env override still outranks everything, reported included.
    process.env.CODEOID_SEED_BUDGET_CHARS = "1234";
    try {
      expect(seedBudgetChars("claude", "opus", reported)).toBe(1234);
    } finally {
      delete process.env.CODEOID_SEED_BUDGET_CHARS;
    }
  });
});

describe("targetContextWindow", () => {
  it("uses the exact Claude catalog window for a known Claude model/alias", () => {
    expect(targetContextWindow("claude", "opus")).toBe(1_000_000);
    expect(targetContextWindow("claude", "claude-opus-4-8")).toBe(1_000_000);
    // Haiku is a smaller window — proves per-model precision, not just provider default.
    expect(targetContextWindow("claude", "claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("falls back to the per-provider default when the model is unknown/absent", () => {
    // The common fork case: target model not chosen yet.
    expect(targetContextWindow("claude", undefined)).toBe(200_000);
    expect(targetContextWindow("codex", null)).toBe(256_000);
    expect(targetContextWindow("openai", undefined)).toBe(128_000);
    expect(targetContextWindow("gemini", undefined)).toBe(1_000_000);
    expect(targetContextWindow("gemini-cli", undefined)).toBe(1_000_000);
    expect(targetContextWindow("pi", undefined)).toBe(200_000);
  });

  it("applies high-confidence non-Claude per-model overrides", () => {
    expect(targetContextWindow("openai", "gpt-4o")).toBe(128_000);
    expect(targetContextWindow("openai", "gpt-4.1-mini")).toBe(1_000_000);
    expect(targetContextWindow("gemini", "gemini-2.5-pro")).toBe(1_000_000);
  });

  it("uses the global fallback for an unknown provider", () => {
    expect(targetContextWindow("brand-new-backend", undefined)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(targetContextWindow("brand-new-backend", "some-model")).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});

describe("seedBudgetChars", () => {
  it("is a fraction of the target window converted to chars", () => {
    const window = targetContextWindow("gemini", undefined); // 1M
    expect(seedBudgetChars("gemini", undefined)).toBe(
      Math.floor(window * SEED_WINDOW_FRACTION * SEED_CHARS_PER_TOKEN),
    );
  });

  it("a bigger target window yields a bigger seed budget (less truncation)", () => {
    // gemini (1M) must allow a strictly larger seed than openai (128k default).
    expect(seedBudgetChars("gemini", undefined)).toBeGreaterThan(seedBudgetChars("openai", undefined));
  });

  it("leaves headroom below the raw window (never spends 100%)", () => {
    expect(SEED_WINDOW_FRACTION).toBeLessThan(1);
    const rawWindowChars = targetContextWindow("codex", undefined) * SEED_CHARS_PER_TOKEN;
    expect(seedBudgetChars("codex", undefined)).toBeLessThan(rawWindowChars);
  });
});
