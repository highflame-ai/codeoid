/**
 * Embedder — pluggable interface for text → vector conversion.
 *
 * Ships with a transformers.js implementation (pure-WASM, zero native deps).
 * A faster fastembed-js impl can slot in later behind the same interface;
 * the factory will try it first and fall back on init failure.
 */

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

/** Factory — returns a ready-to-init Embedder. */
export async function createEmbedder(config: EmbedderConfig = {}): Promise<Embedder> {
  const { TransformersJsEmbedder } = await import("./embedder-transformersjs.js");
  return new TransformersJsEmbedder(
    config.model ?? DEFAULT_EMBEDDING_MODEL,
    config.cacheDir,
  );
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
