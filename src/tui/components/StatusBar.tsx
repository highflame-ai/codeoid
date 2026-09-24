/**
 * StatusBar — one-line context row above the prompt. Shows connection state,
 * focused session info, cumulative token/cost usage, and the last error.
 */

import React from "react";
import { Box, Text } from "ink";
import type { TuiSession } from "../types.js";
import { findModel } from "../../daemon/models.js";

interface Props {
  connection: "connecting" | "connected" | "reconnecting" | "error";
  focused: TuiSession | null;
  lastError: string | null;
  /**
   * All sessions — used to surface background activity counts (unread,
   * approvals) as a compact pill-summary at the end of the bar. Kept
   * on the status bar instead of a separate tab strip so the Ink live
   * dock stays fixed-height; users switch sessions via Ctrl-G.
   */
  sessions?: readonly TuiSession[];
  /**
   * Epoch ms when the focused session started working, or null when
   * idle/approving/errored. Renders a "working 12s" hint inline so the
   * former WorkingIndicator block doesn't need to live in the dock
   * (that block's variable height was a major source of stacking).
   */
  workingSince?: number | null;
  /**
   * Terminal column count. Required so we can constrain the outer
   * Box width and force `<Text wrap="truncate-end">` to clip at the
   * real terminal edge. Without this, Ink's layout engine lets wide
   * content soft-wrap across multiple physical rows — which in turn
   * desyncs Ink's cursor math (it tracks logical rows, not terminal
   * rows) and stacks the bar on every re-render.
   */
  cols: number;
}

const CONNECTION_COLOR: Record<Props["connection"], string> = {
  connecting: "yellow",
  connected: "green",
  reconnecting: "yellow",
  error: "red",
};

export function StatusBar({
  connection,
  focused,
  lastError,
  sessions,
  workingSince,
  cols,
}: Props) {
  const usage = focused?.info.usage;
  // Background-activity summary: count sessions (other than focused) with
  // unread messages or pending approvals. Shown as a single compact pill
  // at the end of the bar — no per-session chrome.
  const others = (sessions ?? []).filter((s) => s.info.id !== focused?.info.id);
  const unreadCount = others.filter((s) => s.unread > 0).length;
  const approvalCount = others.filter((s) => s.pendingApproval).length;
  const sessionCount = (sessions ?? []).length;
  // Elapsed seconds since the focused session started working — read
  // once per render (parent re-renders every 1s tick via workingSince).
  const workingSec =
    workingSince !== null && workingSince !== undefined
      ? Math.max(0, Math.floor((Date.now() - workingSince) / 1000))
      : null;
  // The daemon's resolved window first — the one the backend reported, the
  // same number the web UI and auto-rotate use. The static catalog only knows
  // three Claude ids, so a codex session at 250k of 272k read "25%" in green
  // here while the web UI showed 92%.
  const contextWindow =
    focused?.info.usage?.contextWindow ||
    (focused?.info.model && findModel(focused.info.model)?.contextWindow) ||
    CONTEXT_WINDOW_FALLBACK;
  // Outer Box is width-constrained to `cols` and the inner <Text> uses
  // wrap="truncate-end". Together these guarantee the bar renders as
  // EXACTLY one terminal row regardless of how much dynamic content
  // (cost, tokens, path, peak) we try to cram in. Without this, wide
  // content soft-wraps → Ink's cursor math (logical rows only) doesn't
  // match the terminal → each re-render appends a fresh copy below the
  // old one instead of repainting, producing the stacked-bar artifact.
  //
  // Nested <Text> elements are treated as inline spans inside the outer
  // wrap-controlled text, so colors/bold/dim are preserved. We pad the
  // left edge with a single space in place of the old `paddingX={1}`.
  return (
    <Box width={cols} height={1}>
      <Text wrap="truncate-end">
        <Text> </Text>
        <Text color={CONNECTION_COLOR[connection]}>●</Text>
        <Text> {connection}</Text>
      {focused && (
        <>
          <Text dimColor>{"   │   "}</Text>
          <Text bold>{focused.info.name}</Text>
          <Text dimColor>{" @ "}</Text>
          <Text dimColor>{focused.info.workdir}</Text>
          <Text dimColor>{" · "}</Text>
          <Text
            color={
              focused.info.status === "thinking" ||
              focused.info.status === "tool_running"
                ? "yellow"
                : focused.info.status === "waiting_approval"
                  ? "red"
                  : focused.info.status === "error"
                    ? "red"
                    : "green"
            }
            bold={focused.info.status !== "idle"}
          >
            {focused.info.status}
          </Text>
          {workingSec !== null && (
            <Text color="yellow" dimColor>
              {` · ${formatDuration(workingSec)}`}
            </Text>
          )}
          {focused.info.queuedMessages !== undefined &&
            focused.info.queuedMessages > 0 && (
              <Text color="yellow" bold>
                {` · ⎆ ${focused.info.queuedMessages} queued`}
              </Text>
            )}
          <Text dimColor>{" · mode: "}</Text>
          <Text
            color={
              (focused.info.mode ?? "interactive") === "interactive"
                ? "white"
                : (focused.info.mode ?? "") === "guarded"
                  ? "blue"
                  : "magenta"
            }
            bold
          >
            {focused.info.mode ?? "interactive"}
          </Text>
          {focused.info.mode === "autonomous" &&
            focused.info.turnsRemaining !== undefined && (
              <Text dimColor>
                {` (${focused.info.turnsRemaining} actions left)`}
              </Text>
            )}
          {focused.info.model && (
            <>
              <Text dimColor>{" · "}</Text>
              <Text color="cyan">
                {/* Prefer the resolved full id (e.g. "claude-opus-4-8") so
                    operators can see the exact version routed to the SDK.
                    Falls through to whatever the session reports if we
                    don't recognize it in the catalog. */}
                {findModel(focused.info.model)?.id ?? focused.info.model}
              </Text>
            </>
          )}
          {focused.info.pinnedFiles && focused.info.pinnedFiles.length > 0 && (
            <>
              <Text dimColor>{" · pinned: "}</Text>
              <Text color="yellow">
                {focused.info.pinnedFiles.length}
              </Text>
              <Text dimColor>
                {` (${focused.info.pinnedFiles.slice(0, 3).join(", ")}${focused.info.pinnedFiles.length > 3 ? ", …" : ""})`}
              </Text>
            </>
          )}
          {usage && usage.numTurns > 0 && (
            <>
              <Text dimColor>{"   │   "}</Text>
              <Text color="cyan" bold>
                {formatCost(usage.totalCostUsd)}
              </Text>
              {usage.lastTurnCostUsd !== undefined && usage.lastTurnCostUsd > 0 && (
                <Text color="cyan" dimColor>
                  {` (Δ ${formatCost(usage.lastTurnCostUsd)})`}
                </Text>
              )}
              <Text dimColor>
                {` · ${formatTokens(totalInputOf(usage))} in / ${formatTokens(usage.outputTokens)} out`}
              </Text>
              {usage.cacheReadTokens > 0 && (
                <Text
                  color={pickCacheColor(usage)}
                  dimColor
                >
                  {` · ${formatPct(cacheRateCumulative(usage))} cache`}
                </Text>
              )}
              <Text dimColor>{` · ${usage.numTurns} turns`}</Text>
              {usage.lastTurnInputTokens !== undefined && usage.lastTurnInputTokens > 0 && (
                <>
                  <Text dimColor>{" · ctx "}</Text>
                  <Text color={pickContextColor(usage.lastTurnInputTokens, contextWindow)} bold>
                    {formatTokens(usage.lastTurnInputTokens)}
                  </Text>
                  <Text dimColor>
                    {`/${formatTokens(contextWindow)} (`}
                  </Text>
                  <Text color={pickContextColor(usage.lastTurnInputTokens, contextWindow)}>
                    {formatPct(usage.lastTurnInputTokens / contextWindow)}
                  </Text>
                  <Text dimColor>{")"}</Text>
                </>
              )}
              {usage.peakInputTokens !== undefined &&
                usage.peakInputTokens > 0 &&
                usage.peakInputTokens !== usage.lastTurnInputTokens && (
                  <Text
                    color={pickContextColor(usage.peakInputTokens, contextWindow)}
                    dimColor
                  >
                    {` · peak ${formatTokens(Math.min(usage.peakInputTokens, contextWindow))}`}
                    {/* When raw peak exceeds the window, that turn summed
                        multiple internal API calls (subagents/retries). The
                        sum isn't a real single-call context size — badge
                        it so the user knows not to trust the raw figure. */}
                    {usage.peakInputTokens > contextWindow && (
                      <Text color="yellow">{" (Σ multi-call)"}</Text>
                    )}
                  </Text>
                )}
              {focused.info.rotation &&
                focused.info.rotation.count > 0 && (
                  <Text color="magenta" dimColor>
                    {` · 🔄 ${focused.info.rotation.count}`}
                  </Text>
                )}
            </>
          )}
        </>
      )}
      {sessionCount > 1 && (
        <>
          <Text dimColor>{"   │   "}</Text>
          <Text dimColor>{`${sessionCount} sessions`}</Text>
          {unreadCount > 0 && (
            <Text color="yellow">{` · ${unreadCount} unread`}</Text>
          )}
          {approvalCount > 0 && (
            <Text color="red" bold>
              {` · ⎆ ${approvalCount}`}
            </Text>
          )}
        </>
      )}
      {lastError && (
        <>
          <Text dimColor>{"   │   "}</Text>
          <Text color="red">⚠ {lastError}</Text>
        </>
      )}
      </Text>
    </Box>
  );
}

/** "12s" / "1m 23s" / "1h 5m" — compact working-duration stamp. */
function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/** Render a token count as 1234 / 12.3k / 1.2M to keep the status bar tight. */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Render cost in USD with one decimal below $10 (e.g. "$0.42", "$9.8") and
 * whole dollars above (e.g. "$42", "$1.2k"). Tiny costs collapse to "$0.00"
 * rather than a noisy exponential.
 */
function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  if (usd < 1_000) return `$${Math.round(usd)}`;
  return `$${(usd / 1_000).toFixed(1)}k`;
}

/** Render a 0-1 ratio as a compact "NN%". */
function formatPct(r: number): string {
  if (!Number.isFinite(r) || r <= 0) return "0%";
  return `${Math.round(r * 100)}%`;
}

/** Total context tokens processed = new input + cache read + cache write. */
function totalInputOf(u: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * Cumulative cache hit rate across all turns. Denominator is the total
 * context size (new input + cache read + cache creation), NOT just
 * new input — Anthropic's `input_tokens` excludes cached tokens.
 */
function cacheRateCumulative(u: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const total = totalInputOf(u);
  return total > 0 ? u.cacheReadTokens / total : 0;
}

/** Color the cache percentage by desirability (higher = greener). */
function pickCacheColor(u: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): string {
  const r = cacheRateCumulative(u);
  if (r >= 0.7) return "green";
  if (r >= 0.4) return "yellow";
  return "red";
}

/**
 * Fallback context window when the session reports a model we don't recognize.
 * 1M matches the default codeoid ships with (Opus 4.8 / Sonnet 5 both 1M).
 * The real denominator comes from `findModel(id).contextWindow` per-session
 * — this only kicks in for unknown ids (e.g. a passthrough `claude-foo-bar`).
 */
const CONTEXT_WINDOW_FALLBACK = 1_000_000;

/**
 * Color a context-size value by occupancy of the given window.
 * > 80% → red (compaction imminent), 50-80% → yellow, < 50% → green.
 */
function pickContextColor(inputTokens: number, contextWindow: number): string {
  const r = inputTokens / contextWindow;
  if (r >= 0.8) return "red";
  if (r >= 0.5) return "yellow";
  return "green";
}

