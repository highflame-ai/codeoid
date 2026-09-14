/**
 * TransformersJsReranker — pure-WASM cross-encoder reranking via
 * @xenova/transformers. Runs a (query, doc) sequence-classification model and
 * returns the relevance logit per doc. First init downloads the model to the
 * cache dir; subsequent runs load from cache.
 *
 * Only called on the top-k (~8) candidates per query, so cost is bounded and
 * off the recall hot path's critical width.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { Reranker } from "./reranker.js";

// Type-only — real types imported dynamically to keep startup fast.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional dep
type Any = any;

export class TransformersJsReranker implements Reranker {
  readonly modelName: string;
  #cacheDir: string;
  #tokenizer: Any = null;
  #model: Any = null;
  #initPromise: Promise<void> | null = null;

  constructor(modelName: string, cacheDir?: string) {
    this.modelName = modelName;
    this.#cacheDir = cacheDir ?? join(homedir(), ".codeoid", "models");
    if (!existsSync(this.#cacheDir)) {
      mkdirSync(this.#cacheDir, { recursive: true });
    }
  }

  async init(): Promise<void> {
    if (this.#model) return;
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = this.#doInit();
    return this.#initPromise;
  }

  async #doInit(): Promise<void> {
    const mod = await import("@xenova/transformers").catch((err) => {
      throw new Error(
        `Failed to load @xenova/transformers — is it installed? (${err instanceof Error ? err.message : String(err)})`,
      );
    });
    mod.env.cacheDir = this.#cacheDir;
    mod.env.allowLocalModels = true;

    this.#tokenizer = await mod.AutoTokenizer.from_pretrained(this.modelName);
    this.#model = await mod.AutoModelForSequenceClassification.from_pretrained(this.modelName, {
      quantized: true,
    });
  }

  async rerank(query: string, docs: string[]): Promise<number[]> {
    if (docs.length === 0) return [];
    if (!this.#model) await this.init();

    // Tokenize (query, doc) pairs as a batch: text = query repeated, text_pair = docs.
    const inputs = await this.#tokenizer(new Array(docs.length).fill(query), {
      text_pair: docs,
      padding: true,
      truncation: true,
    });
    const { logits } = await this.#model(inputs);
    const data = logits.data as Float32Array;
    const n = docs.length;
    const dim = data.length / n; // 1 for ms-marco (single relevance logit), 2 for some models

    const scores: number[] = [];
    for (let i = 0; i < n; i++) {
      // dim===1 → the logit; dim===2 → positive-class logit.
      scores.push(dim === 1 ? data[i]! : data[i * dim + 1]!);
    }
    return scores;
  }

  async close(): Promise<void> {
    // Release the ONNX sessions' WASM memory — dropping the JS reference
    // alone doesn't free it. Best-effort: a "cannot release session" from
    // the runtime must not fail close(). (AutoTokenizer has no dispose().)
    try {
      await this.#model?.dispose?.();
    } catch {
      // Best-effort.
    }
    this.#tokenizer = null;
    this.#model = null;
    this.#initPromise = null;
  }
}
