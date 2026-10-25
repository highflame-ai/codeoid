/**
 * Shared by the automation views (loop runs, watches, routines): times that
 * read relative with the absolute one on hover, the daemon's error words, and
 * the one place a URL from the daemon may become a link.
 *
 * Pure, so it is tested without a reactive root.
 */

/** A `response.error` rejection is the raw `{ error, code }`; a transport failure is an `Error`. */
export function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "error" in e) {
    const m = (e as { error?: unknown }).error;
    if (typeof m === "string") return m;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * A rejection as an `Error` with the daemon's words, keeping its `detail`
 * (what a form can act on without parsing the words, e.g. a moved head).
 */
export function asRequestError(e: unknown): Error & { detail?: unknown } {
  const out: Error & { detail?: unknown } = new Error(errMessage(e));
  if (e && typeof e === "object" && "detail" in e && (e as { detail?: unknown }).detail !== undefined) out.detail = (e as { detail?: unknown }).detail;
  return out;
}

/**
 * This feature isn't usable on this connection at all — the token lacks the
 * scopes, or the daemon has it off — so background refreshes stop asking.
 */
export function isUnavailable(e: unknown, offText: RegExp): boolean {
  if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "forbidden") return true;
  return offText.test(errMessage(e));
}

function parseTime(ts: string | number | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * A time relative to `now`, both ways: "in 4m", "in 2h", "tomorrow 09:00",
 * "3m ago", "yesterday". Unlike `relativeTime` (past only), a routine's next
 * fire is in the future and must read as such.
 */
export function relativeWhen(ts: string | number | null | undefined, now: number): string {
  const t = parseTime(ts);
  if (t === null) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 60_000) return future ? "in under a minute" : "just now";
  if (abs < 3_600_000) {
    const m = Math.floor(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.floor(abs / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  if (abs < 172_800_000) {
    const hm = new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return future ? `tomorrow ${hm}` : "yesterday";
  }
  if (abs < 7 * 86_400_000) {
    const d = Math.floor(abs / 86_400_000);
    return future ? `in ${d}d` : `${d}d ago`;
  }
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The absolute time, for a hover title: local, with the zone named. */
export function absoluteTime(ts: string | number | null | undefined): string {
  const t = parseTime(ts);
  if (t === null) return "";
  return new Date(t).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * A URL the daemon passed along (from GitHub's API), as a link only when it is
 * an https://github.com/ URL; anything else stays text.
 */
export function githubUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith("https://github.com/")) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === "github.com" ? u.href : null;
  } catch {
    return null;
  }
}

/** A commit on github.com for `owner/name` — only for a well-formed repo and hex sha. */
export function githubCommitUrl(repo: string, sha: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  return `https://github.com/${repo}/commit/${sha.toLowerCase()}`;
}

/** A blank optional number, a whole number ≥ `min`, or the reason it is neither. */
export function optionalInt(raw: string, name: string, min = 1): number | undefined | { error: string } {
  const v = raw.trim();
  if (!v) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min) return { error: `${name} must be a whole number of at least ${min}` };
  return Number(v);
}

/** A blank optional amount of dollars, a positive number, or the reason it is neither. */
export function optionalUsd(raw: string, name: string): number | undefined | { error: string } {
  const v = raw.trim().replace(/^\$/, "");
  if (!v) return undefined;
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) return { error: `${name} must be a dollar amount above 0` };
  return Number(v);
}
