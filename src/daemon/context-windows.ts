/**
 * Per-model context-window catalog.
 *
 * Anthropic publishes context windows per model family; today the relevant
 * facts for codeoid are:
 *
 *   - claude-fable-5 / claude-mythos-5: 1,000,000
 *   - claude-opus-4-5 through claude-opus-4-8: 1,000,000
 *   - claude-opus-5 / claude-opus-5-5: 1,000,000
 *   - claude-sonnet-5 / claude-sonnet-4-6: 1,000,000
 *   - claude-haiku-4-x: 200,000
 *
 * Aliases (`opus` / `sonnet` / `haiku`) resolve to the family's context
 * window. When the SDK swaps in a different concrete model under the
 * alias, the daemon updates `SessionInfo.model` and we re-derive.
 *
 * Unknown models fall back to 200k — the conservative miss matches every
 * non-1M Claude model and keeps the percent-of-window accurate within
 * the model's actual capacity. Better to over-warn than under-warn.
 */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const ONE_MILLION_CONTEXT = 1_000_000;

/** Model-id fragments (lowercase) whose families ship a 1M context window. */
const ONE_MILLION_FAMILIES = [
  "fable-5",
  "mythos-5",
  "opus-4-5",
  "opus-4.5",
  "opus-4-6",
  "opus-4.6",
  "opus-4-7",
  "opus-4.7",
  "opus-4-8",
  "opus-4.8",
  // `opus-5` covers claude-opus-5, claude-opus-5-5 and any later 5.x point
  // release, since the match is a substring. It was MISSING while the catalog
  // already pointed `opus` at claude-opus-5, so once the SDK reported the
  // concrete id back, `SessionInfo.model` became a value this table did not
  // know and the window collapsed to the 200k fallback — a 5x under-size on
  // the percent-of-window display, the fork seed budget, and the auto-rotate
  // occupancy that decides when a session rolls. Confirmed on 0.3.281:
  // `modelUsage["claude-opus-5-5"].contextWindow` is 1,000,000.
  "opus-5",
  "sonnet-5",
  "sonnet-4-6",
  "sonnet-4.6",
] as const;

/**
 * Resolve the context window for a model id (or alias). Case-insensitive.
 * Matches by prefix + substring so future minor versions (e.g.
 * `claude-opus-4-8-20260101`) don't break the table.
 */
export function contextWindowForModel(modelId: string | undefined | null): number {
  if (!modelId) return ONE_MILLION_CONTEXT; // codeoid default; the `opus` alias family is 1M
  const m = modelId.toLowerCase();

  // Known 1M-context families.
  for (const family of ONE_MILLION_FAMILIES) {
    if (m.includes(family)) return ONE_MILLION_CONTEXT;
  }
  // The 1M variant appears in two forms: the suffix on a full model id
  // (`claude-opus-4-5-1m`) and the BRACKET form Claude Code uses on aliases
  // and ids alike (`opus[1m]`, `claude-opus-5[1m]`). Matching only the former
  // meant an EXPLICIT 1M request resolved to 200k while the bare `opus` alias
  // correctly resolved to 1M — inverting the caller's intent, and under-sizing
  // the window that drives the percent-of-window display, the fork seed budget
  // (seedBudgetChars), and auto-rotate occupancy.
  if (m.includes("-1m") || m.includes("[1m]")) return ONE_MILLION_CONTEXT;

  // Bare aliases, matching the daemon's model resolver: `opus` and `sonnet`
  // are 1M families, `haiku` is 200k. Deliberately not versioned here — the
  // alias floats to whatever the backend currently serves it as, and the
  // family lists above cover the concrete ids it reports back.
  if (m === "opus" || m === "sonnet") return ONE_MILLION_CONTEXT;
  if (m === "haiku") return DEFAULT_CONTEXT_WINDOW;

  // Other Claude models: 200k.
  if (m.startsWith("claude-")) return DEFAULT_CONTEXT_WINDOW;

  // Unknown — be conservative.
  return DEFAULT_CONTEXT_WINDOW;
}
