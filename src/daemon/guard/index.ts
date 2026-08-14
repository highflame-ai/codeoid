/**
 * Guard — advisory plugins that improve agent hygiene without taking authority.
 *
 * A guard observes the session's event stream and may inject model-facing
 * advice. It never vetoes a tool call, never rewrites arguments, and never
 * appears in the tool list. Anything that needs to *stop* a call belongs in the
 * approval flow or the autonomous budget, not here.
 *
 * See docs/prior-art-deepseek-harness.md §3.7.
 */

export {
  RepeatToolGuard,
  DEFAULT_REPEAT_TOOL_CONFIG,
  PRIMARY_CHAIN,
  canonicalizeArguments,
  matchesToolPattern,
  normalizeRepeatToolConfig,
  type RepeatToolGuardConfig,
  type RepeatToolReminder,
} from "./repeat-tool.js";
