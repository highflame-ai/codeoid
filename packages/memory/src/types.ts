/**
 * Memory module types — episode-structured virtual context for Claude sessions.
 *
 * An episode is the atomic unit of memory: one tool call (with surrounding
 * assistant reasoning and user intent) or one user-turn / assistant-turn pair.
 * Episodes are stored verbatim — never summarized — and retrieved by semantic
 * similarity, keyword match, recency, and path overlap.
 */

export type EpisodeKind =
  | "user_turn"        // A user message (standalone, no tool)
  | "assistant_turn"   // An assistant reply (standalone, no tool)
  | "tool_call"        // A tool call + result + surrounding reasoning
  | "error";           // An error event (agent_error, denied tool, etc.)

/** A persisted episode in the memory store. */
export interface Episode {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: EpisodeKind;
  /** Tool name for tool_call episodes. */
  toolName?: string;
  /** One-line descriptor used for the warm-tier index and display. */
  summary: string;
  /** Full body — concatenates user intent + tool input + tool result + assistant reasoning. */
  content: string;
  /** File paths touched in this episode (for path-overlap ranking). */
  filePaths: string[];
  /** Rough token count of the content (content.length / 4). */
  tokenEstimate: number;
  /** Embedding vector (owned by store, lazy-loaded on recall). */
  embedding?: Float32Array;
  embeddingModel?: string;
  createdAt: number;
  createdBy: string;
}

/** Result of a recall query. */
export interface RecallHit {
  episode: Episode;
  score: number;
  /** Sub-scores for debugging / future tuning. */
  components: {
    vector: number;
    fts: number;
    recency: number;
    pathOverlap: number;
  };
}

/** Query options for recall. */
export interface RecallQuery {
  query: string;
  workspaceId: string;
  /** Restrict to a single session (default: workspace-wide). */
  sessionId?: string;
  /** Exclude episodes from this session (typically the caller's own session). */
  excludeSessionId?: string;
  /** Max hits to return. Default 8. */
  limit?: number;
  /** Only include episodes touching these file paths. */
  filePaths?: string[];
  /** Only episodes from this tool. */
  toolName?: string;
  /** Exclude episodes newer than this (unix ms). */
  before?: number;
  /** Exclude episodes older than this (unix ms). */
  after?: number;
}

/** File read cache entry — enables silent reuse across sessions in a workspace. */
export interface FileReadRecord {
  workspaceId: string;
  filePath: string;
  contentHash: string;
  mtimeMs?: number;
  readAt: number;
  episodeId: string;
}
