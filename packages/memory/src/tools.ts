/**
 * Transport-neutral memory tool registry.
 *
 * The read-only recall tools (recall / recall_file / timeline / get_episode)
 * defined ONCE, over the provider-neutral MemoryEngine, so every backend
 * transport exposes the SAME tools by adapting these defs:
 *   - Claude:            in-process SDK MCP (memory/mcp.ts wraps these).
 *   - Codex / Gemini CLI: a shared MCP endpoint (later phases).
 *   - OpenAI / Gemini:   native function-calling (later phases).
 *   - pi:                the extension bridge (later phase).
 * Each def's `run()` returns the model-visible text; the wrappers are thin.
 *
 * Scoping: `run()` is bound at call time to a MemoryToolContext carrying the
 * caller's tenant workspaceId + sessionId. `get_episode` uses the tenant-scoped
 * `engine.getEpisodeScoped`, so it can never read another workspace's episode.
 * All four tools are read-only.
 */

import { z, type ZodRawShape } from "zod";
import type { MemoryEngine } from "./engine.js";
import type { Episode, RecallHit } from "./types.js";

export interface MemoryToolContext {
  engine: MemoryEngine;
  workspaceId: string;
  /** Excluded from recall by default so the caller doesn't recall its own turns. */
  sessionId: string;
}

export interface MemoryToolDef {
  name: string;
  description: string;
  /** zod shape for the Claude Agent SDK's `tool()` adapter. */
  zodShape: ZodRawShape;
  /** JSON Schema for MCP-stdio / OpenAI functions / Gemini declarations. */
  jsonSchema: Record<string, unknown>;
  /** Execute the tool; returns the model-visible text. */
  run(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<string>;
}

export const MEMORY_TOOL_NAMES = [
  "recall",
  "recall_file",
  "timeline",
  "get_episode",
] as const;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
/** Clamp to [min, max] with a default — the zod/JSON schemas bound these for
 *  Claude, but run() must not trust its args: other transports (native
 *  function-calling, MCP-stdio) may not enforce ranges. */
const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = num(v);
  if (n === undefined) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** The four defs. A function (not a const) so each call gets fresh zod objects. */
export function memoryToolDefs(): MemoryToolDef[] {
  const recall: MemoryToolDef = {
    name: "recall",
    description:
      "Search past episodes (tool calls + user intents + assistant reasoning) from this workspace, across all past and current sessions. Returns the most relevant episodes verbatim. Use this whenever you need context from earlier work — do not rely on summaries.",
    zodShape: {
      query: z.string().describe("Natural-language query describing what you want to recall"),
      limit: z.number().int().min(1).max(20).optional().describe("Max episodes (default 6, max 20)"),
      include_current_session: z
        .boolean()
        .optional()
        .describe("Include episodes from the current session (default false)"),
      tool_name: z.string().optional().describe("Restrict to a specific tool (e.g. 'Read', 'Bash', 'Edit')"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query describing what you want to recall" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max episodes (default 6, max 20)" },
        include_current_session: { type: "boolean", description: "Include current-session episodes (default false)" },
        tool_name: { type: "string", description: "Restrict to a specific tool" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const includeCurrent = args.include_current_session === true;
      const hits = await ctx.engine.recall({
        query: String(args.query ?? ""),
        workspaceId: ctx.workspaceId,
        limit: clampInt(args.limit, 1, 20, 6),
        toolName: str(args.tool_name),
        excludeSessionId: includeCurrent ? undefined : ctx.sessionId,
      });
      return formatHits(hits, ctx.sessionId, includeCurrent);
    },
  };

  const recallFile: MemoryToolDef = {
    name: "recall_file",
    description:
      "Check whether a file has been read in this workspace recently (across all sessions) and retrieve the most recent read verbatim. Useful to avoid re-reading unchanged files.",
    zodShape: {
      path: z.string().describe("Absolute or workspace-relative file path"),
    },
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute or workspace-relative file path" } },
      required: ["path"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const path = String(args.path ?? "");
      const hits = await ctx.engine.recall({
        query: `file ${path}`,
        workspaceId: ctx.workspaceId,
        filePaths: [path],
        limit: 3,
      });
      if (hits.length === 0) return `No prior reads of ${path} in this workspace.`;
      return `Found ${hits.length} prior read(s) of ${path}:\n\n${formatHits(hits, ctx.sessionId, true)}`;
    },
  };

  const timeline: MemoryToolDef = {
    name: "timeline",
    description:
      "Ordered, paginated list of episodes in this workspace, newest first. Walk the whole history with `offset` (page size `limit`). Each line carries an episode_id you can pass to get_episode. Use this to orient a session or to reach any turn deterministically when recall doesn't surface it.",
    zodShape: {
      limit: z.number().int().min(1).max(60).optional().describe("Page size (default 20, max 60)"),
      offset: z.number().int().min(0).optional().describe("How many newest episodes to skip (default 0)"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 60, description: "Page size (default 20, max 60)" },
        offset: { type: "integer", minimum: 0, description: "How many newest episodes to skip (default 0)" },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const limit = clampInt(args.limit, 1, 60, 20);
      const offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const episodes = ctx.engine.timeline(ctx.workspaceId, limit, offset);
      return formatTimeline(episodes, ctx.sessionId, offset);
    },
  };

  const getEpisode: MemoryToolDef = {
    name: "get_episode",
    description:
      "Fetch one episode by its episode_id (from recall or timeline output) and return its full verbatim content. This is how you page an exact past turn or tool result back into context.",
    zodShape: {
      episode_id: z.string().describe("The episode_id from a recall or timeline result"),
    },
    jsonSchema: {
      type: "object",
      properties: { episode_id: { type: "string", description: "The episode_id from recall/timeline output" } },
      required: ["episode_id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = String(args.episode_id ?? "");
      const ep = ctx.engine.getEpisodeScoped(id, ctx.workspaceId);
      if (!ep) return `Episode ${id} not found in this workspace.`;
      return formatEpisode(ep, ctx.sessionId);
    },
  };

  return [recall, recallFile, timeline, getEpisode];
}

// ── Shared formatters (model-visible text) ────────────────────────────────────

/** Stable per-session labels so a model can reason about cross-session origin
 *  without seeing raw UUIDs. */
function sessionLabeler(currentSessionId: string): (sessionId: string) => string {
  const labels = new Map<string, string>();
  let prior = 0;
  return (sessionId: string) => {
    const existing = labels.get(sessionId);
    if (existing) return existing;
    const label = sessionId === currentSessionId ? "current session" : `prior session #${++prior}`;
    labels.set(sessionId, label);
    return label;
  };
}

export function formatHits(hits: RecallHit[], currentSessionId: string, includeCurrent: boolean): string {
  const filtered = includeCurrent
    ? hits
    : hits.filter((h) => h.episode.sessionId !== currentSessionId);
  if (filtered.length === 0) return "No matching episodes in memory.";

  const label = sessionLabeler(currentSessionId);
  const priorLabels = new Set<string>();
  const blocks = filtered.map((h, i) => {
    const ep = h.episode;
    const l = label(ep.sessionId);
    if (l !== "current session") priorLabels.add(l);
    return [
      `### [${i + 1}] ${ep.summary} — ${l}`,
      `- when: ${new Date(ep.createdAt).toISOString()}`,
      `- kind: ${ep.kind}${ep.toolName ? ` (${ep.toolName})` : ""}`,
      `- score: ${h.score.toFixed(3)} (vec=${h.components.vector.toFixed(2)}, fts=${h.components.fts.toFixed(2)}, rec=${h.components.recency.toFixed(2)}, path=${h.components.pathOverlap.toFixed(2)})`,
      `- episode_id: ${ep.id}`,
      "",
      ep.content,
    ].join("\n");
  });
  const priorCount = priorLabels.size;
  const header =
    priorCount > 0
      ? `Found ${filtered.length} matching episode(s) across sessions (${priorCount} prior).\n\n`
      : `Found ${filtered.length} matching episode(s), all from the current session.\n\n`;
  return header + blocks.join("\n\n---\n\n");
}

export function formatTimeline(episodes: Episode[], currentSessionId: string, offset: number): string {
  if (episodes.length === 0) {
    return offset > 0
      ? `No more episodes past offset ${offset}.`
      : "Timeline is empty.";
  }
  const label = sessionLabeler(currentSessionId);
  const priorLabels = new Set<string>();
  const lines = episodes.map((e) => {
    const l = label(e.sessionId);
    if (l !== "current session") priorLabels.add(l);
    return `- [${new Date(e.createdAt).toISOString()}] [${l}] ${e.kind}: ${e.summary}  (episode_id: ${e.id})`;
  });
  const range = offset > 0 ? ` (offset ${offset})` : "";
  const priorCount = priorLabels.size;
  const header =
    priorCount > 0
      ? `Showing ${episodes.length} episode(s)${range}, newest first, across sessions (${priorCount} prior). Use offset to page further back.\n\n`
      : `Showing ${episodes.length} episode(s)${range}, newest first — all from the current session.\n\n`;
  return header + lines.join("\n");
}

export function formatEpisode(ep: Episode, currentSessionId: string): string {
  const label = ep.sessionId === currentSessionId ? "current session" : "a prior session";
  return [
    `### ${ep.summary} — ${label}`,
    `- when: ${new Date(ep.createdAt).toISOString()}`,
    `- kind: ${ep.kind}${ep.toolName ? ` (${ep.toolName})` : ""}`,
    `- episode_id: ${ep.id}`,
    ...(ep.filePaths.length > 0 ? [`- files: ${ep.filePaths.join(", ")}`] : []),
    "",
    ep.content,
  ].join("\n");
}
