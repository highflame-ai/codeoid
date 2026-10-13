/**
 * Embedder — pluggable interface for text → vector conversion.
 *
 * Ships with a transformers.js implementation (pure-WASM, zero native deps).
 * A faster fastembed-js impl can slot in later behind the same interface;
 * the factory will try it first and fall back on init failure.
 */

import type { EmbedderWorkerRequest, EmbedderWorkerResponse } from "./embedder-worker.js";

/** Name of the default local model. 384-dim, ~50MB, BGE-small quality. */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

export interface Embedder {
  readonly modelName: string;
  readonly dimensions: number;
  /** Load the model. Safe to call multiple times; only the first init does work. */
  init(): Promise<void>;
  /** Compute embeddings for a batch of strings. Returned vectors are L2-normalized. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Free model resources. */
  close(): Promise<void>;
}

export interface EmbedderConfig {
  /** HuggingFace model ID (default: Xenova/bge-small-en-v1.5). */
  model?: string;
  /** Cache dir for model weights (default: ~/.codeoid/models). */
  cacheDir?: string;
}

/**
 * Factory — returns a ready-to-init Embedder. The model runs on a worker
 * thread (see embedder-worker.ts): inference is synchronous CPU work, and on
 * the daemon's main thread it froze the event loop for the whole batch.
 */
export async function createEmbedder(config: EmbedderConfig = {}): Promise<Embedder> {
  return new WorkerEmbedder(config.model ?? DEFAULT_EMBEDDING_MODEL, config.cacheDir);
}

/** Main-thread proxy for the model hosted in embedder-worker.ts. */
export class WorkerEmbedder implements Embedder {
  readonly modelName: string;
  #cacheDir: string | undefined;
  #worker: Worker | null = null;
  #initPromise: Promise<void> | null = null;
  #dimensions = 384;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

  constructor(modelName: string, cacheDir?: string) {
    this.modelName = modelName;
    this.#cacheDir = cacheDir;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  init(): Promise<void> {
    this.#initPromise ??= this.#start().catch((err) => {
      // Let a later init() retry from scratch rather than replay the failure.
      this.#initPromise = null;
      this.#teardown(err instanceof Error ? err : new Error(String(err)));
      throw err;
    });
    return this.#initPromise;
  }

  #start(): Promise<void> {
    const worker = new Worker(new URL("./embedder-worker.ts", import.meta.url).href);
    this.#worker = worker;
    return new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<EmbedderWorkerResponse>) => {
        const msg = event.data;
        switch (msg.type) {
          case "ready":
            this.#dimensions = msg.dimensions;
            resolve();
            break;
          case "init_error":
            reject(new Error(msg.message));
            break;
          case "embedded":
            this.#pending.get(msg.id)?.resolve(msg.vectors);
            this.#pending.delete(msg.id);
            break;
          case "embed_error":
            this.#pending.get(msg.id)?.reject(new Error(msg.message));
            this.#pending.delete(msg.id);
            break;
        }
      };
      worker.onerror = (event) => {
        const err = new Error(`embedder worker crashed: ${event.message}`);
        reject(err);
        this.#teardown(err);
        this.#initPromise = null;
      };
      const req: EmbedderWorkerRequest = { type: "init", model: this.modelName, cacheDir: this.#cacheDir };
      worker.postMessage(req);
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    const worker = this.#worker;
    if (!worker) throw new Error("embedder worker is not running");
    const id = this.#nextId++;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const req: EmbedderWorkerRequest = { type: "embed", id, texts };
      worker.postMessage(req);
    });
  }

  async close(): Promise<void> {
    this.#initPromise = null;
    this.#teardown(new Error("embedder closed"));
  }

  #teardown(reason: Error): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const p of this.#pending.values()) p.reject(reason);
    this.#pending.clear();
  }
}

/** L2-normalize a vector in place. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/** Cosine similarity — assumes both vectors are L2-normalized (returns dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}
