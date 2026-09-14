/**
 * Cluster labelers — turn a Cluster into a short human-readable topic name.
 *
 * Two strategies, both with the same interface:
 *   - HeuristicLabeler  — pure SQL/stats, deterministic, no external call.
 *   - HaikuLabeler      — one HTTP call to Anthropic (Haiku 4.5) per cluster,
 *                         gated on ANTHROPIC_API_KEY + aggressive caching by
 *                         cluster signature.
 *
 * The scheduler prefers Haiku when available; falls back to heuristic when
 * the key is missing or the HTTP call fails. Labels are cached by cluster
 * signature — if cluster membership stays stable across regenerations, the
 * label is reused for free.
 */

import type { Cluster } from "./cluster.js";

const STOPWORDS = new Set([
  "a","an","the","and","or","but","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could","should","may",
  "might","must","can","i","you","he","she","it","we","they","them","their",
  "this","that","these","those","my","your","his","her","its","our","there",
  "what","which","who","when","where","why","how","if","then","else","for",
  "to","of","in","on","at","by","with","from","as","into","out","up","down",
  "over","under","just","also","only","not","no","yes","so","too","very",
  "one","two","three","please","make","run","use","see","set","get","add",
  "call","find","let","need","lets","let's","now","after","before","first",
  "last","next","prev","previous","via","through","while","until","about",
  "tool","tools","result","results","file","files","line","lines","code",
  "error","errors","session","sessions","user","edit","edits","write","read",
  "based","here","try","yes","something","some","any","all","most","more",
  "less","like","such","new","old","same","then","again","still",
]);

export interface ClusterLabel {
  /** Human-readable short label, e.g. "Memory / SQLite". */
  label: string;
  /** Which labeler produced it (for debugging). */
  source: "heuristic" | "haiku" | "cache";
}

export interface Labeler {
  label(cluster: Cluster): Promise<ClusterLabel>;
}

// ── Heuristic labeler ────────────────────────────────────────────────────

export class HeuristicLabeler implements Labeler {
  async label(cluster: Cluster): Promise<ClusterLabel> {
    // Combine top directory name + top content term. Directories track
    // where the work is; content terms track what the work is about.
    const topDir = dominantTopDir(cluster);
    const topTerms = topContentTerms(cluster, 2);

    const parts: string[] = [];
    if (topDir) parts.push(topDir);
    if (topTerms.length > 0) parts.push(topTerms.join(" / "));
    const label = parts.length > 0 ? parts.join(" — ") : `Cluster ${cluster.id}`;
    return { label: capitalize(label), source: "heuristic" };
  }
}

// ── Haiku labeler (optional) ─────────────────────────────────────────────

export interface HaikuLabelerOptions {
  apiKey: string;
  /** Model override. Default claude-haiku-4-5-20251001. */
  model?: string;
  /** Fallback labeler used on failure. Default HeuristicLabeler. */
  fallback?: Labeler;
  /** Timeout in ms. Default 10s. */
  timeoutMs?: number;
}

export class HaikuLabeler implements Labeler {
  #apiKey: string;
  #model: string;
  #fallback: Labeler;
  #timeoutMs: number;

  constructor(opts: HaikuLabelerOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? "claude-haiku-4-5-20251001";
    this.#fallback = opts.fallback ?? new HeuristicLabeler();
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async label(cluster: Cluster): Promise<ClusterLabel> {
    try {
      const prompt = buildHaikuPrompt(cluster);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.#timeoutMs);
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.#apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.#model,
            max_tokens: 20,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`Haiku HTTP ${resp.status}`);
        const data = (await resp.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };
        const text = data.content?.find((c) => c.type === "text")?.text?.trim();
        if (!text) throw new Error("Haiku response missing text");
        return { label: clampLabel(text), source: "haiku" };
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      // Soft-fail — fall back to heuristic. Don't let a labeler error kill
      // the index build.
      console.error(
        `[codeoid/memory] Haiku label failed, falling back: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.#fallback.label(cluster);
    }
  }
}

// ── Cached wrapper ───────────────────────────────────────────────────────

/**
 * Wraps any labeler with a signature-keyed cache. Skips the underlying
 * labeler entirely when the cluster's signature matches a prior label —
 * critical when the underlying labeler makes HTTP calls.
 */
export class CachedLabeler implements Labeler {
  #inner: Labeler;
  #cache = new Map<string, string>();

  constructor(inner: Labeler) {
    this.#inner = inner;
  }

  async label(cluster: Cluster): Promise<ClusterLabel> {
    const cached = this.#cache.get(cluster.signature);
    if (cached) return { label: cached, source: "cache" };
    const out = await this.#inner.label(cluster);
    this.#cache.set(cluster.signature, out.label);
    return out;
  }

  /** Evict cached labels whose cluster no longer exists. Call periodically. */
  prune(liveSignatures: Iterable<string>): void {
    const live = new Set(liveSignatures);
    for (const sig of this.#cache.keys()) {
      if (!live.has(sig)) this.#cache.delete(sig);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildHaikuPrompt(cluster: Cluster): string {
  const summaries = cluster.members
    .slice(0, 8)
    .map((m) => `- ${m.episode.summary}`)
    .join("\n");
  const files = cluster.topFiles
    .slice(0, 3)
    .map((f) => f.path)
    .join(", ");
  return [
    "You label clusters of agent-session episodes. Reply with JUST the label — no quotes, no punctuation at the end, no explanation.",
    "The label should be 2-5 words, describe the theme, and use Title Case or a slash-separated compound (e.g. \"Auth / JWT\", \"Memory Architecture\", \"TUI Rendering\").",
    "",
    files ? `Files touched: ${files}` : "",
    "",
    "Episode summaries:",
    summaries,
  ].filter(Boolean).join("\n");
}

function dominantTopDir(cluster: Cluster): string | null {
  const counts = new Map<string, number>();
  for (const m of cluster.members) {
    for (const p of m.episode.filePaths) {
      const seg = firstMeaningfulSegment(p);
      if (seg) counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [seg, c] of counts) {
    if (c > bestCount) {
      best = seg;
      bestCount = c;
    }
  }
  return best;
}

function firstMeaningfulSegment(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  // Skip workspace-root + scaffold dirs to land on the semantic subdir.
  // "Workspace" is common for absolute paths under ~/Workspace; "home"/"Users"
  // show up on Linux/macOS absolute paths. Skip all dir types that don't carry
  // topic signal so "Memory" / "Daemon" / "TUI" / "Auth" surface naturally.
  const skip = new Set([
    "src", "tests", "test", "app", "apps", "packages",
    "workspace", "home", "users", "usr", "var", "tmp",
    "daemon", // too generic on codeoid's tree
  ]);
  for (const p of parts) {
    if (!skip.has(p.toLowerCase())) return p;
  }
  return parts[0] ?? null;
}

function topContentTerms(cluster: Cluster, n: number): string[] {
  const counts = new Map<string, number>();
  for (const m of cluster.members) {
    for (const tok of tokenize(m.episode.summary)) {
      if (STOPWORDS.has(tok) || tok.length < 3) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
    // toolName carries strong signal — weight it 2x if present.
    if (m.episode.toolName) {
      const t = m.episode.toolName.toLowerCase();
      counts.set(t, (counts.get(t) ?? 0) + 2);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([term]) => term);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s_/-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clampLabel(s: string): string {
  // Strip quotes, trailing punctuation, newlines; enforce word cap.
  const cleaned = s.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  const capped = cleaned.split(/\s+/).slice(0, 6).join(" ");
  return capped.replace(/[.!?,;:]+$/g, "");
}

/** Resolve the preferred labeler given environment. Haiku when API key present, heuristic otherwise. */
export function createLabeler(env: NodeJS.ProcessEnv = process.env): Labeler {
  const key = env.ANTHROPIC_API_KEY;
  const base = key
    ? new HaikuLabeler({ apiKey: key })
    : new HeuristicLabeler();
  return new CachedLabeler(base);
}
