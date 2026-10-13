/**
 * Memory module — durable episode storage + retrieval for Claude sessions.
 *
 * Public surface:
 *   - createMemory() — factory wiring store + embedder + engine
 *   - SqliteEpisodeStore, MemoryEngine, EpisodeChunker — lower-level handles
 *   - workspaceIdFromPath() — canonicalize a workdir into a stable workspace id
 *   - buildMemoryMcpServer() — wrap the engine as an MCP server for the Agent SDK
 */

import { SqliteEpisodeStore } from "./store.js";
import { createEmbedder, type EmbedderConfig } from "./embedder.js";
import { MemoryEngine } from "./engine.js";

export {
  SqliteEpisodeStore,
  workspaceIdFromPath,
  legacyWorkspaceIdFromPath,
  type WorkspaceTenant,
} from "./store.js";
export { MemoryEngine, type SessionSearchHit } from "./engine.js";
export { EpisodeChunker, extractFilePaths } from "./chunker.js";
export { buildMemoryMcpServer } from "./mcp.js";
export {
  MemoryMcpHttp,
  MEMORY_MCP_PATH,
  MEMORY_MCP_SERVER_NAME,
  MEMORY_MCP_TOKEN_ENV,
  type MemoryMcpBinding,
  type MemoryMcpMount,
} from "./mcp-http.js";
export {
  memoryToolDefs,
  MEMORY_TOOL_NAMES,
  formatHits,
  formatTimeline,
  formatEpisode,
  type MemoryToolDef,
  type MemoryToolContext,
} from "./tools.js";
export { DEFAULT_EMBEDDING_MODEL, createEmbedder, WorkerEmbedder } from "./embedder.js";
export { buildWorkspaceIndex, MAX_INDEX_BYTES } from "./index-builder.js";
export { IndexScheduler } from "./index-scheduler.js";
export {
  clusterEpisodes,
  clusterEpisodesYielding,
  MIN_EPISODES_FOR_CLUSTERING,
  type Cluster,
  type ClusterMember,
  type ClusterableEpisode,
} from "./cluster.js";
export {
  WorkspaceClusterer,
  workspaceClustererFor,
  type WorkspaceClustererOptions,
} from "./workspace-clusterer.js";
export {
  HeuristicLabeler,
  HaikuLabeler,
  CachedLabeler,
  createLabeler,
  type Labeler,
  type ClusterLabel,
} from "./cluster-labeler.js";
export type { Episode, EpisodeKind, RecallHit, RecallQuery } from "./types.js";

export interface MemoryConfig {
  /** Absolute path to the memory SQLite database. */
  dbPath: string;
  /** Embedder config — model name, cache dir. */
  embedder?: EmbedderConfig;
  /** Compute embeddings at all (default true). False = keyword-only recall. */
  embeddingsEnabled?: boolean;
  /** Embedding windows per episode (default 8). */
  maxEmbedWindows?: number;
}

/** Build a ready-to-use MemoryEngine. Caller must call `engine.init()` before first use. */
export async function createMemory(config: MemoryConfig): Promise<MemoryEngine> {
  const store = new SqliteEpisodeStore(config.dbPath);
  const embedder = await createEmbedder(config.embedder);
  return new MemoryEngine({
    store,
    embedder,
    embeddingsEnabled: config.embeddingsEnabled,
    maxEmbedWindows: config.maxEmbedWindows,
  });
}
