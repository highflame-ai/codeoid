/**
 * Reranker tests — the createReranker factory and the TransformersJsReranker
 * batching/score-extraction logic, with @xenova/transformers mocked so no
 * model is downloaded. The logit layout handling (dim 1 = single relevance
 * logit vs dim 2 = [neg, pos] classes) is the part worth pinning down: a
 * wrong stride silently reranks by garbage.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Logits the fake model returns on its next call (flat, row-major). */
let nextLogits: number[] = [];
let tokenizerCalls: Array<{ texts: string[]; opts: Record<string, unknown> }> =
  [];
let fromPretrainedCalls: Array<{ model: string; opts?: unknown }> = [];

const fakeEnv = { cacheDir: "", allowLocalModels: false };

mock.module("@xenova/transformers", () => ({
  env: fakeEnv,
  AutoTokenizer: {
    from_pretrained: async (model: string) => {
      fromPretrainedCalls.push({ model });
      return async (texts: string[], opts: Record<string, unknown>) => {
        tokenizerCalls.push({ texts, opts });
        return { input_ids: texts };
      };
    },
  },
  AutoModelForSequenceClassification: {
    from_pretrained: async (model: string, opts?: unknown) => {
      fromPretrainedCalls.push({ model, opts });
      return async (_inputs: unknown) => ({
        logits: { data: new Float32Array(nextLogits) },
      });
    },
  },
}));

// Import AFTER mock.module so the dynamic import inside init() resolves to
// the fake.
const { createReranker, DEFAULT_RERANKER_MODEL } = await import(
  "@highflame/codeoid-memory/reranker.js"
);
const { TransformersJsReranker } = await import(
  "@highflame/codeoid-memory/reranker-transformersjs.js"
);

describe("TransformersJsReranker", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "codeoid-reranker-"));
    nextLogits = [];
    tokenizerCalls = [];
    fromPretrainedCalls = [];
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("init loads tokenizer + model once and points the cache at cacheDir", async () => {
    const reranker = new TransformersJsReranker("test/model", cacheDir);
    await reranker.init();
    await reranker.init();

    expect(fakeEnv.cacheDir).toBe(cacheDir);
    expect(fakeEnv.allowLocalModels).toBe(true);
    // One tokenizer + one model load despite the double init.
    expect(fromPretrainedCalls).toHaveLength(2);
    expect(fromPretrainedCalls.map((c) => c.model)).toEqual([
      "test/model",
      "test/model",
    ]);
  });

  test("rerank batches (query, doc) pairs and returns single-logit scores (dim 1)", async () => {
    const reranker = new TransformersJsReranker("test/model", cacheDir);
    nextLogits = [0.9, -1.2, 3.4];

    const scores = await reranker.rerank("which session?", ["a", "b", "c"]);
    expect(scores).toEqual([
      expect.closeTo(0.9),
      expect.closeTo(-1.2),
      expect.closeTo(3.4),
    ]);

    // Query repeated per doc, docs as text_pair — the cross-encoder contract.
    expect(tokenizerCalls).toHaveLength(1);
    expect(tokenizerCalls[0]!.texts).toEqual([
      "which session?",
      "which session?",
      "which session?",
    ]);
    expect(tokenizerCalls[0]!.opts.text_pair).toEqual(["a", "b", "c"]);
  });

  test("rerank extracts the positive-class logit for two-class models (dim 2)", async () => {
    const reranker = new TransformersJsReranker("test/model", cacheDir);
    // Rows of [negative, positive]: scores must be 0.7, -0.3.
    nextLogits = [0.1, 0.7, 0.5, -0.3];

    const scores = await reranker.rerank("q", ["a", "b"]);
    expect(scores).toEqual([expect.closeTo(0.7), expect.closeTo(-0.3)]);
  });

  test("rerank on an empty doc list returns [] without loading the model", async () => {
    const reranker = new TransformersJsReranker("test/model", cacheDir);
    expect(await reranker.rerank("q", [])).toEqual([]);
    expect(fromPretrainedCalls).toHaveLength(0);
  });

  test("rerank auto-inits, and close() releases so the next call re-inits", async () => {
    const reranker = new TransformersJsReranker("test/model", cacheDir);
    nextLogits = [1];
    await reranker.rerank("q", ["a"]);
    expect(fromPretrainedCalls).toHaveLength(2);

    await reranker.close();
    nextLogits = [2];
    expect(await reranker.rerank("q", ["a"])).toEqual([2]);
    expect(fromPretrainedCalls).toHaveLength(4);
  });
});

describe("createReranker factory", () => {
  test("defaults to the ms-marco cross-encoder", async () => {
    const reranker = await createReranker();
    expect(reranker.modelName).toBe(DEFAULT_RERANKER_MODEL);
    expect(reranker).toBeInstanceOf(TransformersJsReranker);
  });

  test("honors a custom model + cache dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-reranker-factory-"));
    try {
      const reranker = await createReranker({
        model: "custom/model",
        cacheDir: dir,
      });
      expect(reranker.modelName).toBe("custom/model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
