/**
 * Thinking effort (#417), what the backends share: each maps codeoid's scale
 * (EFFORT_LEVELS) to its own setting in its provider; docs/thinking-effort.md.
 */

import type { EffortLevel } from "../../protocol/types.js";

/** When a server refuses a turn over its thinking effort, say which setting to change. */
export function effortRejectionHint(message: string, effort: EffortLevel): string {
  return /reasoning|effort|thinking/i.test(message)
    ? ` — this model may not take thinking effort "${effort}": choose another, or Default (/effort default).`
    : "";
}
