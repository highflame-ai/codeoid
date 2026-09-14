/**
 * Reranker — pluggable cross-encoder for the final precision@1 stage of session
 * resolution. A bi-encoder (the embedder) compresses each doc into one
 * query-agnostic vector; a cross-encoder reads the (query, doc) pair jointly and
 * scores relevance for *this* query — far better at picking THE one right result
 * from a good top-k, which is exactly the conductor's need (right session is
 * usually top-3 after global fusion; the rerank pulls it to #1).
 *
 * Default is a small English cross-encoder (fast, CPU-friendly). Swap to
 * bge-reranker-v2-m3 (multilingual, heavier) behind this same interface later.
 */

/** Small, fast, English cross-encoder. ~22M params; ms-marco trained. */
export const DEFAULT_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

export interface Reranker {
  readonly modelName: string;
  /** Load the model. Safe to call multiple times; only the first does work. */
  init(): Promise<void>;
  /** Relevance score per doc vs the query (higher = more relevant). */
  rerank(query: string, docs: string[]): Promise<number[]>;
  /** Free model resources. */
  close(): Promise<void>;
}

export interface RerankerConfig {
  /** HuggingFace model id (default: ms-marco-MiniLM-L-6-v2). */
  model?: string;
  /** Cache dir for model weights (default: ~/.codeoid/models). */
  cacheDir?: string;
}

/** Factory — returns a ready-to-init Reranker. */
export async function createReranker(config: RerankerConfig = {}): Promise<Reranker> {
  const { TransformersJsReranker } = await import("./reranker-transformersjs.js");
  return new TransformersJsReranker(config.model ?? DEFAULT_RERANKER_MODEL, config.cacheDir);
}
