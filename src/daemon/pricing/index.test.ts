import { describe, expect, it } from "bun:test";
import { estimateCost, PRICING_SNAPSHOT_DATE, priceFor } from "./index.js";

describe("model prices (#430)", () => {
  it("finds a model in the snapshot, with a models/ prefix or a date suffix too", () => {
    const p = priceFor("gpt-5.5");
    expect(p).toBeDefined();
    expect(priceFor("gpt-5.5-2099-01-01")).toEqual(p!);
    expect(priceFor("models/gemini-2.5-pro")).toEqual(priceFor("gemini-2.5-pro")!);
    expect(PRICING_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("knows nothing of a model it has no price for", () => {
    expect(priceFor("my-local-finetune")).toBeUndefined();
  });

  it("takes the config's price first", () => {
    expect(priceFor("gpt-5.5", { "gpt-5.5": { input: 1, output: 2 } })).toEqual({ input: 1, output: 2 });
    expect(priceFor("my-local-finetune", { "my-local-finetune": { input: 0, output: 0 } })).toEqual({ input: 0, output: 0 });
  });

  it("prices each kind of token at its own rate", () => {
    const price = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 };
    expect(estimateCost(price, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(2);
    expect(estimateCost(price, { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(1);
    expect(estimateCost(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 })).toBe(0.5);
    expect(estimateCost(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 })).toBe(2.5);
    // No cache rates: cached tokens cost what input does.
    expect(estimateCost({ input: 2, output: 10 }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 })).toBe(2);
  });

  it("bills a prompt over 200k at the long-context tier where the model has one", () => {
    const price = { input: 1.25, output: 10, inputAbove200k: 2.5, outputAbove200k: 15 };
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(estimateCost(price, tokens, 150_000)).toBe(1.25);
    expect(estimateCost(price, tokens, 250_000)).toBe(2.5);
    expect(estimateCost({ input: 1, output: 1 }, tokens, 250_000)).toBe(1);
  });
});

describe("the models codeoid offers have prices (#430)", () => {
  it("every Gemini model in the picker, the default included", async () => {
    const { GEMINI_DEFAULT_MODEL, GEMINI_MODELS } = await import("../providers/gemini/index.js");
    for (const m of [...GEMINI_MODELS.map((x) => x.id), GEMINI_DEFAULT_MODEL]) expect(priceFor(m)).toBeDefined();
  });
});

describe("the snapshot", () => {
  it("lists no model as free: a provider's $0 free tier isn't the model's price elsewhere (#430)", async () => {
    const snap = (await import("./snapshot.json", { with: { type: "json" } })).default as { models: Record<string, { input: number; output: number }> };
    expect(Object.entries(snap.models).filter(([, p]) => p.input === 0 && p.output === 0)).toEqual([]);
  });
});
