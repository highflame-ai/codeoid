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
import type { Episode, EpisodeOrigin, RecallHit } from "./types.js";

export interface MemoryToolContext {
  engine: MemoryEngine;
  workspaceId: string;
  /** Excluded from recall by default so the caller doesn't recall its own turns. */
  sessionId: string;
  /**
   * The workstreams the calling session may read (workstreams §6.4: its home
   * and references), read at each call; undefined = no filter (isolation off).
   */
  workstreams?: () => readonly string[] | undefined;
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

/** The caller's workstream filter for a query (MemoryToolContext.workstreams). */
function readable(ctx: MemoryToolContext): { workstreams?: readonly string[] } {
  const w = ctx.workstreams ? ctx.workstreams() : ctx.engine.workstreamsOf(ctx.sessionId);
  return w === undefined ? {} : { workstreams: w };
}

/**
 * When to use the memory tools, for a backend or an outside agent that gets
 * no system prompt from codeoid (the memory MCP server's `instructions`).
 * Codeoid's own sessions get the same as part of theirs.
 */
export const MEMORY_INSTRUCTIONS = [
  "Durable memory of this workspace: every tool call (with its input, its full output, its exit code, where it ran and how long it took) and every reply, across all past sessions, verbatim.",
  "- Before re-running a command to find out what failed, or what fixed it last time, call recall(query, only_failed: true): the output and the exit code are there.",
  "- For an exact command, path or identifier, quote it or pass it as is: episodes holding it exactly come first.",
  "- Before reading a file, call recall_file(path): an unchanged earlier read can be reused.",
  "- When the user refers to earlier work, call recall first; call timeline() to see what happened recently.",
  "- get_episode(episode_id, lines: [[-80, -1]]) returns the end of an episode first, where an error is; ask for more ranges as needed.",
].join("\n");

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
      only_failed: z.boolean().optional().describe("Only calls that failed (a non-zero exit code) and errors: 'what failed last time'"),
      backend: z.string().optional().describe("Only what one backend did (e.g. 'claude', 'codex')"),
      origin: z.enum(["user", "delegated", "agent", "dispatch"]).optional().describe("Only turns of this origin: the owner's, another person's, the agent's own background work, or a dispatched worker's"),
      cwd: z.string().optional().describe("Only shell calls run in this directory or below it"),
    },
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query describing what you want to recall" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max episodes (default 6, max 20)" },
        include_current_session: { type: "boolean", description: "Include current-session episodes (default false)" },
        tool_name: { type: "string", description: "Restrict to a specific tool" },
        only_failed: { type: "boolean", description: "Only calls that failed (a non-zero exit code) and errors" },
        backend: { type: "string", description: "Only what one backend did (e.g. 'claude', 'codex')" },
        origin: { type: "string", enum: ["user", "delegated", "agent", "dispatch"], description: "Only turns of this origin" },
        cwd: { type: "string", description: "Only shell calls run in this directory or below it" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const includeCurrent = args.include_current_session === true;
      const facts = {
        ...(args.only_failed === true ? { onlyFailed: true } : {}),
        ...(str(args.backend) ? { backend: str(args.backend) } : {}),
        ...(ORIGINS.has(String(args.origin)) ? { origin: args.origin as EpisodeOrigin } : {}),
        ...(str(args.cwd) ? { cwd: str(args.cwd) } : {}),
      };
      const hits = await ctx.engine.recall({
        query: String(args.query ?? ""),
        workspaceId: ctx.workspaceId,
        limit: clampInt(args.limit, 1, 20, 6),
        toolName: str(args.tool_name),
        excludeSessionId: includeCurrent ? undefined : ctx.sessionId,
        ...facts,
        ...readable(ctx),
      });
      const out = formatHits(hits, ctx.sessionId, includeCurrent);
      // Nothing, with filters: say which to loosen, rather than leave the agent to guess.
      const used = [args.only_failed === true ? "only_failed" : "", facts.backend ? "backend" : "", facts.origin ? "origin" : "", facts.cwd ? "cwd" : "", str(args.tool_name) ? "tool_name" : ""].filter(Boolean);
      return hits.length === 0 && used.length > 0 ? `${out} Try loosening: ${used.join(", ")}.` : out;
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
        ...readable(ctx),
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
      const episodes = ctx.engine.timeline(ctx.workspaceId, limit, offset, readable(ctx).workstreams);
      return formatTimeline(episodes, ctx.sessionId, offset);
    },
  };

  const getEpisode: MemoryToolDef = {
    name: "get_episode",
    description:
      "Fetch one episode by its episode_id (from recall or timeline output) and return its full verbatim content — nothing is truncated in storage. This is how you page an exact past turn or tool result back into context. Long episodes come back a page at a time: pass `offset` to read further.",
    zodShape: {
      episode_id: z.string().describe("The episode_id from a recall or timeline result"),
      lines: z
        .array(z.tuple([z.number().int(), z.number().int()]))
        .max(20)
        .optional()
        .describe("Line ranges to return, 1-based and inclusive; negative counts from the end. Ask [[-80, -1]] first: the end of a tool's output is where its error is"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset into the content to start from (default 0)"),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(GET_EPISODE_MAX_PAGE)
        .optional()
        .describe(`Characters to return (default ${GET_EPISODE_DEFAULT_PAGE}, max ${GET_EPISODE_MAX_PAGE})`),
    },
    jsonSchema: {
      type: "object",
      properties: {
        episode_id: { type: "string", description: "The episode_id from recall/timeline output" },
        lines: {
          type: "array",
          maxItems: 20,
          items: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
          description: "Line ranges, 1-based and inclusive; negative counts from the end. Ask [[-80, -1]] first: the end of a tool's output is where its error is",
        },
        offset: { type: "integer", minimum: 0, description: "Character offset into the content to start from (default 0)" },
        max_chars: {
          type: "integer",
          minimum: 1000,
          maximum: GET_EPISODE_MAX_PAGE,
          description: `Characters to return (default ${GET_EPISODE_DEFAULT_PAGE}, max ${GET_EPISODE_MAX_PAGE})`,
        },
      },
      required: ["episode_id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = String(args.episode_id ?? "");
      const { workstreams } = readable(ctx);
      const ep = ctx.engine.getEpisodeScoped(id, ctx.workspaceId, workstreams);
      if (!ep) return `Episode ${id} not found in this workspace.`;
      const full = ctx.engine.getFullContentScoped(id, ctx.workspaceId, workstreams) ?? ep.content;
      const ranges = lineRanges(args.lines);
      if (ranges) return formatEpisodeLines({ ...ep, content: full }, ctx.sessionId, ranges);
      const offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const maxChars = clampInt(args.max_chars, 1000, GET_EPISODE_MAX_PAGE, GET_EPISODE_DEFAULT_PAGE);
      return formatEpisode({ ...ep, content: full }, ctx.sessionId, { offset, maxChars });
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
    // Where the exact matches end and the related ones begin.
    const divider = !h.exact && i > 0 && filtered[i - 1]!.exact ? "── related, not exact ──\n\n" : "";
    return [
      `${divider}### [${i + 1}] ${ep.summary} — ${l}${h.exact ? " (exact match)" : ""}`,
      `- when: ${new Date(ep.createdAt).toISOString()}`,
      `- kind: ${ep.kind}${ep.toolName ? ` (${ep.toolName})` : ""}`,
      ...factLine(ep),
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

/** get_episode page size: default, and the most one call may ask for. */
export const GET_EPISODE_DEFAULT_PAGE = 64 * 1024;
export const GET_EPISODE_MAX_PAGE = 256 * 1024;

export function formatEpisode(
  ep: Episode,
  currentSessionId: string,
  page: { offset?: number; maxChars?: number } = {},
): string {
  const label = ep.sessionId === currentSessionId ? "current session" : "a prior session";
  const total = ep.content.length;
  const offset = Math.min(Math.max(0, page.offset ?? 0), total);
  const end = Math.min(total, offset + (page.maxChars ?? GET_EPISODE_DEFAULT_PAGE));
  const paged = offset > 0 || end < total;
  return [
    `### ${ep.summary} — ${label}`,
    `- when: ${new Date(ep.createdAt).toISOString()}`,
    `- kind: ${ep.kind}${ep.toolName ? ` (${ep.toolName})` : ""}`,
    ...factLine(ep),
    `- episode_id: ${ep.id}`,
    ...(ep.filePaths.length > 0 ? [`- files: ${ep.filePaths.join(", ")}`] : []),
    ...(paged ? [`- showing: chars ${offset}–${end} of ${total}`] : []),
    "",
    ep.content.slice(offset, end),
    ...(end < total
      ? ["", `…[${total - end} more chars — call get_episode with episode_id "${ep.id}" and offset ${end} to continue]`]
      : []),
  ].join("\n");
}

const ORIGINS = new Set(["user", "delegated", "agent", "dispatch"]);

/** An episode's facts as one line: exit code, directory, how long, who and what (§3 of secrets-and-memory-design.md). */
function factLine(ep: Episode): string[] {
  const parts = [
    ep.exitCode !== undefined ? (ep.exitCode === -1 ? "failed" : `exit ${ep.exitCode}`) : "",
    ep.cwd ? `in ${ep.cwd}` : "",
    ep.durationMs !== undefined ? `took ${ep.durationMs < 1000 ? `${ep.durationMs} ms` : `${(ep.durationMs / 1000).toFixed(1)} s`}` : "",
    ep.backend ? `by ${ep.backend}${ep.model ? `/${ep.model}` : ""}` : "",
    ep.origin ? `turn: ${ep.origin}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? [`- facts: ${parts.join(" · ")}`] : [];
}

/** `lines` as [start, end] pairs, or null when absent or malformed. */
function lineRanges(v: unknown): Array<[number, number]> | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: Array<[number, number]> = [];
  for (const r of v.slice(0, 20)) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1])) return null;
    out.push([r[0] as number, r[1] as number]);
  }
  return out;
}

/** Most lines one call returns (the rest is said, with how to get it). */
const MAX_LINES = 2000;

/**
 * The asked line ranges of an episode, numbered, merged and in order, a
 * `[… N lines skipped …]` marker between them, and the total: so an agent
 * fetches the end of a long output first, and only then what it needs.
 */
export function formatEpisodeLines(ep: Episode, currentSessionId: string, ranges: Array<[number, number]>): string {
  const lines = ep.content.split("\n");
  const total = lines.length;
  /** Where each line starts, as a character offset: what a cut line says to read it from. */
  const starts: number[] = [];
  for (let i = 0, at = 0; i < total; i++) {
    starts.push(at);
    at += lines[i]!.length + 1;
  }
  const shownRanges: Array<[number, number]> = [];
  const at = (n: number) => (n < 0 ? total + n + 1 : n);
  const spans = ranges
    .map(([a, b]) => [Math.max(1, Math.min(total, at(a))), Math.max(1, Math.min(total, at(b)))] as [number, number])
    .map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const width = String(total).length;
  const body: string[] = [];
  let shown = 0;
  let chars = 0;
  let prevEnd = 0;
  let stopped = false;
  for (const [a, b] of merged) {
    if (a > prevEnd + 1) body.push(`[… ${a - prevEnd - 1} lines skipped …]`);
    for (let n = a; n <= b; n++) {
      if (shown >= MAX_LINES || chars >= GET_EPISODE_MAX_PAGE) {
        body.push(`[… stopped at line ${n - 1}: ${shown >= MAX_LINES ? `${MAX_LINES} lines` : `${GET_EPISODE_MAX_PAGE} characters`} is the most one call returns; ask a narrower range …]`);
        stopped = true;
        break;
      }
      let line = lines[n - 1] ?? "";
      // One very long line (minified JSON, a one-line log) is cut, and says so.
      if (chars + line.length > GET_EPISODE_MAX_PAGE) {
        const keep = Math.max(0, GET_EPISODE_MAX_PAGE - chars);
        line = `${line.slice(0, keep)}…[line cut: the rest with get_episode offset ${starts[n - 1]! + keep}]`;
      }
      body.push(`${String(n).padStart(width)}  ${line}`);
      const last = shownRanges[shownRanges.length - 1];
      if (last && last[1] === n - 1) last[1] = n;
      else shownRanges.push([n, n]);
      chars += line.length;
      shown++;
    }
    prevEnd = b;
    if (stopped) break;
  }
  if (prevEnd < total && !stopped) body.push(`[… ${total - prevEnd} lines skipped …]`);
  const label = ep.sessionId === currentSessionId ? "current session" : "a prior session";
  return [
    `### ${ep.summary} — ${label}`,
    `- kind: ${ep.kind}${ep.toolName ? ` (${ep.toolName})` : ""}`,
    ...factLine(ep),
    `- episode_id: ${ep.id}`,
    `- lines: ${shownRanges.map(([a, b]) => `${a}–${b}`).join(", ") || "none"} of ${total} (${ep.content.length} chars)`,
    "",
    ...body,
  ].join("\n");
}
