/**
 * Workspace memory index — the "always-in-context pointer" layer.
 *
 * Every turn, Claude sees this block appended to its system prompt. It's a
 * compact (~1-1.5 KB) markdown snapshot of what memory knows about this
 * workspace: recent sessions, hot files, and explicit recall shortcuts.
 *
 * The design goals:
 *   1. Always-in-context — no tool call needed to discover memory contents.
 *   2. Lossless bridge — the index is a POINTER to the verbatim store, never
 *      a replacement. It says "here's what exists; call recall() for detail."
 *   3. Prefix-cache-friendly — structure is stable across regenerations; only
 *      counts and timestamps drift. Regen is throttled by the scheduler so
 *      cache invalidation is bounded (at most ~1/minute during active work).
 *   4. Cheap — pure SQL aggregates + in-memory sort. No LLM calls in v1.
 *
 * Why this matters more than another recall tool: `timeline()` already exists
 * as a tool call, but Claude has to KNOW to call it. A passive index flips
 * the discovery burden — Claude now sees what's available every turn.
 */

import type { SqliteEpisodeStore } from "./store.js";
import type { Cluster } from "./cluster.js";

/** Hard cap on rendered index size (bytes). */
export const MAX_INDEX_BYTES = 1_800;
/** Default hot-files budget. */
const DEFAULT_HOT_FILES = 8;
/** Default session-history budget. */
const DEFAULT_RECENT_SESSIONS = 5;
/** Default cluster budget. */
const DEFAULT_CLUSTERS = 6;

export interface IndexOptions {
  /** Max files in the "Hot files" section (default 8). */
  hotFiles?: number;
  /** Max sessions in the "Recent sessions" section (default 5). */
  recentSessions?: number;
  /** Max topic clusters to render (default 6). */
  clusters?: number;
  /** Absolute ceiling on output bytes (default 1800). */
  maxBytes?: number;
}

/**
 * Resolved cluster rendering input — the scheduler pre-computes and labels
 * clusters asynchronously, then hands them to the synchronous index build.
 */
export interface LabeledCluster {
  cluster: Cluster;
  label: string;
}

export interface BuildIndexInput {
  store: SqliteEpisodeStore;
  workspaceId: string;
  /** Human-readable workdir for the header — purely cosmetic. */
  workdir?: string;
  /** Current session ID — tagged as [current] in the recent-sessions list. */
  currentSessionId: string;
  /** Optional pre-computed clusters to include. When absent, index omits the clusters block. */
  clusters?: LabeledCluster[];
}

/**
 * Build the workspace memory index as a markdown string.
 *
 * Empty workspace (no episodes yet) returns an empty string — caller should
 * fall back to the stable system-prompt nudge alone.
 */
export function buildWorkspaceIndex(
  input: BuildIndexInput,
  opts: IndexOptions = {},
): string {
  const stats = input.store.workspaceStats(input.workspaceId);
  if (stats.episodeCount === 0) return "";

  const hotFiles = input.store.hotFiles(
    input.workspaceId,
    opts.hotFiles ?? DEFAULT_HOT_FILES,
  );
  const sessions = input.store.sessionSummaries(
    input.workspaceId,
    opts.recentSessions ?? DEFAULT_RECENT_SESSIONS,
  );
  const clusterBudget = opts.clusters ?? DEFAULT_CLUSTERS;

  const lines: string[] = [];
  const now = Date.now();

  // ── Header / fingerprint ─────────────────────────────────────────────
  const scope = input.workdir ? ` — ${input.workdir}` : "";
  lines.push(`# Memory Index${scope}`);
  lines.push(
    `${stats.episodeCount} episodes across ${stats.sessionCount} session${stats.sessionCount === 1 ? "" : "s"} · last activity ${formatAgo(stats.lastCreatedAt, now)}`,
  );
  lines.push("");

  // ── Topic clusters — semantic entry points. When the scheduler has
  //    computed + labeled clusters, render them above hot files so Claude
  //    sees the high-level map first.
  const clusters = (input.clusters ?? []).slice(0, clusterBudget);
  if (clusters.length > 0) {
    lines.push('## Topic clusters (call `recall("<label>")` to retrieve)');
    for (const lc of clusters) {
      const label = lc.label;
      const size = lc.cluster.members.length;
      const latest = formatAgo(lc.cluster.lastActivityAt, now);
      const files = lc.cluster.topFiles
        .slice(0, 2)
        .map((f) => shortPath(f.path))
        .join(", ");
      const fileHint = files ? ` · ${files}` : "";
      lines.push(
        `- **${label}** — ${size} episodes, latest ${latest}${fileHint}`,
      );
    }
    lines.push("");
  }

  // ── Hot files — highest ROI: Claude sees these and knows to recall_file
  //    before a fresh Read. This is the single biggest token-saving branch
  //    of the index on repeat-edit workflows.
  if (hotFiles.length > 0) {
    lines.push(
      "## Hot files (call `recall_file(path)` before reading)",
    );
    for (const f of hotFiles) {
      lines.push(
        `- ${shortPath(f.path)} — ${f.touches} touch${f.touches === 1 ? "" : "es"}, last ${formatAgo(f.lastTouchedAt, now)}`,
      );
    }
    lines.push("");
  }

  // ── Recent sessions — orients Claude on "what was I doing" across sessions
  if (sessions.length > 0) {
    lines.push("## Recent sessions");
    for (const s of sessions) {
      const tag = s.sessionId === input.currentSessionId ? "current" : formatAgo(s.lastActivityAt, now);
      const summary = truncate(s.firstSummary, 100);
      lines.push(`- [${tag}] ${summary}`);
    }
    lines.push("");
  }

  // ── Recall shortcuts — explicit usage guide. Stable text (never changes),
  //    doesn't invalidate prompt cache.
  lines.push("## Recall shortcuts");
  lines.push('- `recall("<topic>")` — semantic search across all episodes');
  lines.push('- `recall_file("<path>")` — prior reads of a specific file');
  lines.push("- `timeline()` — chronological recent activity");

  const body = lines.join("\n");
  const cap = opts.maxBytes ?? MAX_INDEX_BYTES;
  if (body.length <= cap) return body;

  // Trim from the hot-files section (most compressible) when we overflow.
  return `${body.slice(0, cap - 24)}\n… (index truncated) …`;
}

// ── Formatting helpers ──────────────────────────────────────────────────

/** Compact relative-time — "just now" / "5m ago" / "2h ago" / "3d ago". */
function formatAgo(when: number | null, now: number): string {
  if (!when) return "never";
  const dt = Math.max(0, now - when);
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Compact a path for inline rendering — keep last two segments when deep. */
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `.../${parts.slice(-2).join("/")}`;
}
