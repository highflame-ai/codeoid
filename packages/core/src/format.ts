/**
 * Display formatters for usage metrics — pure, deterministic, shared by
 * every frontend so "1.2M tokens · $3.42 · 2m 15s" reads identically in the
 * web UI, the TUI, and the mobile app. Colour/style decisions stay in each
 * frontend (they're design-system-specific); everything here returns plain
 * strings.
 */

/** Token count → "1.2M" / "12.5k" / "342". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimZeros(n / 1_000_000)}M`;
  if (abs >= 10_000) {
    // Guard the boundary: 999_500..999_999 rounds to 1000k — promote to "1M".
    const k = Math.round(n / 1_000);
    return Math.abs(k) >= 1_000 ? `${trimZeros(k / 1_000)}M` : `${k}k`;
  }
  if (abs >= 1_000) return `${trimZeros(n / 1_000)}k`;
  return Math.round(n).toString();
}

/** USD cost → "$3.42" / "$0.012" / "<$0.01". Never returns "$0.00" for non-zero amounts. */
export function formatCostUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.005) return "<$0.01";
  if (usd < 0.1) return `$${usd.toFixed(3)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

/** What a session's cost display needs (a subset of `SessionUsage`). */
export interface CostUsage {
  totalCostUsd: number;
  costEstimated?: boolean;
  costUnknownTurns?: number;
}

/**
 * A session's cost, honest about where it came from (#430): `~$0.42` when
 * some of it is an estimate (tokens × list price), `$0.42+` when some turns'
 * cost isn't known, `$?` when none is. `title` says why, for a tooltip.
 */
export function formatSessionCost(u: CostUsage | null | undefined): { text: string; title: string } {
  if (!u) return { text: "—", title: "No usage yet" };
  const unknown = u.costUnknownTurns ?? 0;
  if (unknown > 0 && u.totalCostUsd === 0 && !u.costEstimated) {
    return { text: "$?", title: `Cost unknown: no price for the model, or the backend reports no token counts (${unknown} turn${unknown === 1 ? "" : "s"})` };
  }
  const base = formatCostUsd(u.totalCostUsd);
  const parts: string[] = [u.costEstimated ? "Partly estimated from tokens × the model's list price" : "As reported by the backend"];
  if (unknown > 0) parts.push(`plus ${unknown} turn${unknown === 1 ? "" : "s"} whose cost isn't known`);
  return { text: `${u.costEstimated ? "~" : ""}${base}${unknown > 0 ? "+" : ""}`, title: parts.join(", ") };
}

/** One turn's cost by where it came from (#430): `$?` when unknown, `~$0.42` when estimated. */
export function formatTurnCost(usd: number | null | undefined, source?: "backend" | "estimated" | "free" | "unknown"): string {
  if (source === "unknown") return "$?";
  return `${source === "estimated" ? "~" : ""}${formatCostUsd(usd)}`;
}

/** Duration in ms → "1h 24m" / "2m 15s" / "8s" / "240ms". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Wall-clock elapsed since `since` (ISO 8601 string or epoch ms). */
export function elapsedSince(since: string | number | Date, now = Date.now()): string {
  const t = since instanceof Date ? since.getTime() : typeof since === "number" ? since : Date.parse(since);
  if (!Number.isFinite(t)) return "—";
  return formatDuration(now - t);
}

/** Compact relative time → "5m ago" / "2h ago" / "yesterday" / "Mar 5". */
export function relativeTime(ts: string | number | Date, now = Date.now()): string {
  const t = ts instanceof Date ? ts.getTime() : typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return "—";
  const diff = now - t;
  if (diff < 0) return "just now";
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 172_800_000) return "yesterday";
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Cache hit rate (0-1) → "63%". Returns "—" if not provided. */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Context-window utilization severity — frontends map this to their own
 * colour tokens. <60% "ok", 60-85% "warn", >85% "danger".
 */
export type CtxSeverity = "ok" | "warn" | "danger";
export function ctxWindowSeverity(ratio: number): CtxSeverity {
  if (ratio < 0.6) return "ok";
  if (ratio < 0.85) return "warn";
  return "danger";
}

/** HH:MM:SS for a timestamp string/number. Best-effort; falls back to the input. */
export function formatClock(ts: string | number): string {
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return String(ts);
  return new Date(t).toLocaleTimeString(undefined, { hour12: false });
}

// One decimal, but trim a trailing ".0" so "3.0k" reads as "3k".
function trimZeros(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * One-line summary of what a collaboration has spent, for the approval prompt.
 *
 * Lives in core rather than in any one client because all three approval
 * surfaces — web, Telegram, TUI — must show the owner the SAME number in the
 * same words. Three independent format helpers would drift, and a cost that
 * reads differently depending on where you approve from is worse than none.
 *
 * Deliberately compact: this sits next to a decision, not on a dashboard.
 */
export function formatCollaborationCost(c: {
  children: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
}): string {
  const fleet = `${c.children + 1} session${c.children === 0 ? "" : "s"}`;
  return [
    `this goal so far: ${formatCostUsd(c.totalCostUsd)}`,
    `${formatTokens(c.inputTokens)}/${formatTokens(c.outputTokens)} tok`,
    `${c.numTurns} turn${c.numTurns === 1 ? "" : "s"}`,
    `across ${fleet}`,
  ].join(" · ");
}

/**
 * One line on a shell command's risk, for the approval prompt (#431): the
 * level and the most serious reason. Shared so every approval surface says it
 * in the same words; empty for a low-risk command, which needs no warning.
 */
export function formatToolRisk(risk: { level: "low" | "medium" | "high" | "unknown"; reasons: readonly string[] } | undefined): string {
  if (!risk || risk.level === "low") return "";
  const label = risk.level === "unknown" ? "not understood" : `${risk.level} risk`;
  const reason = risk.reasons[0];
  return reason ? `${label}: ${reason}` : label;
}
