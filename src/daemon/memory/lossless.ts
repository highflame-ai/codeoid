/**
 * Lossless storage helpers — keep every byte, index a bounded view of it.
 *
 * Memory stores episodes verbatim. What it can't afford is to full-text index
 * or embed an arbitrarily large body on the daemon's event path: FTS5
 * tokenizes the whole `content` column inside the insert (measured: ~9 ms per
 * MiB, ~220 ms for a 10 MiB build log — every attached client stalls for it).
 *
 * So storage and indexing are separate decisions:
 *   - the FULL body goes to `episode_payloads`, zstd-compressed (~5 ms and
 *     ~5% of the size for a 10 MiB log), and `get_episode` pages through it;
 *   - `episodes.content` — what FTS5, excerpts and window embeddings see —
 *     holds a bounded view: the head, the tail, and the diagnostic lines from
 *     the middle, with a marker saying how much the view elides.
 */

/** Bodies up to this size are indexed whole; larger ones get a view. */
export const INDEX_VIEW_MAX_CHARS = 256 * 1024;
const HEAD_CHARS = 96 * 1024;
const TAIL_CHARS = 64 * 1024;
/** Budget for diagnostic lines lifted from the elided middle. */
const MIDDLE_LINES_CHARS = 64 * 1024;

/** Lines worth indexing even when they sit in the elided middle of a body. */
const DIAGNOSTIC_LINE =
  /\b(error|errors|fail|failed|failure|fatal|panic|exception|traceback|warn|warning|assert|denied|not found|undefined|cannot|unable)\b/i;

/** Marker text, so a reader (human or model) knows the view isn't the whole body. */
export function elisionMarker(elidedChars: number): string {
  return `\n…[${elidedChars} chars not shown in this index view — get_episode returns the full verbatim content]…\n`;
}

/**
 * The bounded view of `full` that memory indexes. Returns `full` unchanged when
 * it already fits.
 */
export function indexView(full: string, maxChars = INDEX_VIEW_MAX_CHARS): string {
  if (full.length <= maxChars) return full;
  const head = full.slice(0, HEAD_CHARS);
  const tail = full.slice(full.length - TAIL_CHARS);
  const middle = full.slice(HEAD_CHARS, full.length - TAIL_CHARS);

  const picked: string[] = [];
  let used = 0;
  for (const line of middle.split("\n")) {
    if (!DIAGNOSTIC_LINE.test(line)) continue;
    const l = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
    if (used + l.length + 1 > MIDDLE_LINES_CHARS) break;
    picked.push(l);
    used += l.length + 1;
  }

  const elided = middle.length - used;
  const parts = [head, elisionMarker(elided)];
  if (picked.length > 0) {
    parts.push(`…[diagnostic lines from the elided middle]…\n${picked.join("\n")}\n`);
  }
  parts.push(tail);
  return parts.join("");
}

/**
 * Character length of one embedding window. bge-small reads at most 512
 * tokens and silently drops the rest; code and logs tokenize at roughly three
 * characters per token, so ~1600 chars is what one window can actually see.
 */
export const EMBED_WINDOW_CHARS = 1600;

/**
 * The texts to embed for one episode: up to `maxWindows` windows of
 * `EMBED_WINDOW_CHARS`, each prefixed with the summary so every window carries
 * the episode's identity. A body that fits is tiled in order. A longer one
 * can't be covered, so the windows go where recall needs them most: the head
 * (intent, input, the start of the result), the tail (where outcomes land),
 * windows centred on diagnostic lines (errors, failures, warnings — what
 * people search past output for), and the rest spaced evenly.
 */
export function embedWindows(summary: string, body: string, maxWindows: number): string[] {
  const n = Math.max(1, Math.floor(maxWindows));
  const W = EMBED_WINDOW_CHARS;
  if (body.length <= W || n === 1) return [`${summary}\n\n${body.slice(0, W)}`];

  const needed = Math.ceil(body.length / W);
  if (needed <= n) {
    return Array.from({ length: needed }, (_, i) => `${summary}\n\n${body.slice(i * W, (i + 1) * W)}`);
  }

  const last = body.length - W;
  const starts: number[] = [0, last];
  const overlaps = (s: number) => starts.some((x) => Math.abs(x - s) < W);
  const take = (s: number) => {
    const clamped = Math.min(Math.max(0, s), last);
    if (starts.length < n && !overlaps(clamped)) starts.push(clamped);
  };

  // Diagnostic lines, centred, in order of appearance.
  const diag = new RegExp(DIAGNOSTIC_LINE.source, "gi");
  for (let m = diag.exec(body); m && starts.length < n; m = diag.exec(body)) {
    take(m.index - Math.floor(W / 2));
    // One window per line is enough: skip to the next line.
    const nl = body.indexOf("\n", m.index);
    if (nl < 0) break;
    diag.lastIndex = nl + 1;
  }

  // Fill what's left evenly across the gaps.
  for (let k = 1; starts.length < n && k < 4 * n; k++) {
    const slots = n + k;
    for (let i = 1; i < slots && starts.length < n; i++) take(Math.round((last * i) / slots));
  }

  return starts.sort((a, b) => a - b).map((s) => `${summary}\n\n${body.slice(s, s + W)}`);
}
