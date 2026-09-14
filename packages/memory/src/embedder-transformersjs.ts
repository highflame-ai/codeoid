/**
 * TransformersJsEmbedder — pure-WASM BGE embeddings via @xenova/transformers.
 *
 * No native dependencies, works everywhere Bun runs. First init downloads the
 * model weights (~50MB for bge-small) to the cache dir. Subsequent runs load
 * from cache.
 *
 * Throughput on a modern laptop CPU: ~20-50ms per batch of 8 strings.
 * Acceptable because ingestion runs off the hot path — we embed episodes
 * asynchronously after a turn completes.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { Embedder } from "./embedder.js";

// Type-only — the real type is imported dynamically to keep startup fast.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional dep
type Pipeline = any;

export class TransformersJsEmbedder implements Embedder {
  readonly modelName: string;
  #cacheDir: string;
  #pipeline: Pipeline | null = null;
  #initPromise: Promise<void> | null = null;
  #dimensions = 384;

  constructor(modelName: string, cacheDir?: string) {
    this.modelName = modelName;
    this.#cacheDir = cacheDir ?? join(homedir(), ".codeoid", "models");
    if (!existsSync(this.#cacheDir)) {
      mkdirSync(this.#cacheDir, { recursive: true });
    }
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  async init(): Promise<void> {
    if (this.#pipeline) return;
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

    // Point HF cache at our directory so model weights live under ~/.codeoid/models.
    mod.env.cacheDir = this.#cacheDir;
    mod.env.allowLocalModels = true;

    this.#pipeline = await mod.pipeline("feature-extraction", this.modelName, {
      quantized: true,
    });

    // Probe the dimension by embedding a no-op string.
    const probe = await this.#pipeline("probe", { pooling: "mean", normalize: true });
    const data = probe.data as Float32Array;
    this.#dimensions = data.length;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.#pipeline) {
      await this.init();
    }
    if (texts.length === 0) return [];

    const output = await this.#pipeline!(texts, {
      pooling: "mean",
      normalize: true,
    });

    // output.data is a flat Float32Array of shape [N, D]; split into per-text vectors.
    const data = output.data as Float32Array;
    const dim = this.#dimensions;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      // Copy slice so each vector owns its buffer (safer for long-lived storage).
      const slice = new Float32Array(dim);
      slice.set(data.subarray(i * dim, (i + 1) * dim));
      out.push(slice);
    }
    return out;
  }

  async close(): Promise<void> {
    this.#pipeline = null;
    this.#initPromise = null;
  }
}
