/**
 * Display formatters — the data formatting lives in `@codeoid/core` (shared
 * with the TUI and mobile); only the Tailwind colour mapping is web-local.
 */
import { ctxWindowSeverity } from "@codeoid/core";

export {
  ctxWindowSeverity,
  elapsedSince,
  formatClock,
  formatCollaborationCost,
  formatCostUsd,
  formatDuration,
  formatPercent,
  formatTokens,
  relativeTime,
} from "@codeoid/core";
export type { CtxSeverity } from "@codeoid/core";

/**
 * Context-window utilization colour cue — maps the shared severity to this
 * design system's Tailwind text-* classes.
 */
export function ctxWindowColorClass(ratio: number): string {
  switch (ctxWindowSeverity(ratio)) {
    case "ok":
      return "text-success";
    case "warn":
      return "text-warn";
    default:
      return "text-danger";
  }
}
