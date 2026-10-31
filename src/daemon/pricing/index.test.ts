import { describe, expect, it } from "bun:test";
import { estimateCost, estimateCostByRequest, PRICING_SNAPSHOT_DATE, priceFor } from "./index.js";

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

  it("bills cached tokens at the long-context tier too: their own long rate, else raised as input's is", () => {
    const cached = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 };
    const price = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 2, inputAbove200k: 2.5 };
    expect(estimateCost(price, cached, 150_000)).toBeCloseTo(2.125, 9);
    expect(estimateCost(price, cached, 250_000)).toBeCloseTo(4.25, 9);
    expect(estimateCost({ ...price, cacheReadAbove200k: 0.3, cacheWriteAbove200k: 5 }, cached, 250_000)).toBeCloseTo(5.3, 9);
  });

  it("bills each request at its own tier when the requests add up to the turn, else gives up", () => {
    const price = { input: 1, output: 0, inputAbove200k: 2 };
    const req = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(estimateCostByRequest(price, req(350_000), [req(100_000), req(250_000)])).toBeCloseTo(0.6, 9);
    expect(estimateCostByRequest(price, req(400_000), [req(100_000), req(250_000)])).toBeUndefined();
    expect(estimateCostByRequest(price, req(0), [])).toBeUndefined();
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
