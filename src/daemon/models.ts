/**
 * Model catalog — the set of Claude variants codeoid knows about + alias
 * resolution. Users interact with friendly names (`opus`, `sonnet`,
 * `haiku`); we resolve to the full Anthropic model id when plumbing into
 * the SDK's `query({ options: { model } })`.
 *
 * Why maintained here vs hard-coded on the SDK:
 *   - We need display labels + context-window sizes for the UI (picker,
 *     warnings when the new model has a smaller window than current ctx).
 *   - Aliases are opinionated — opus always maps to "current best" for
 *     planning work, haiku always to "fast + cheap" — not just the latest
 *     version bump. Decoupled from Anthropic's id changes.
 *   - A passthrough escape hatch (`resolveModel` accepts any string that
 *     looks like a full id) means users aren't locked to our opinions.
 *
 * NOTE: this catalog is a *fallback* only. The daemon prefers the live list
 * the Claude Code backend reports via the SDK's `supportedModels()` (cached
 * on the SessionManager) — see `fallbackModelInfos` / `resolveAgainstList`.
 */

import type { ModelInfo } from "../protocol/types.js";

export type ModelTier = "premium" | "balanced" | "fast";

export interface ModelDescriptor {
  /** Full Anthropic API model id. */
  id: string;
  /** Short alias the user types. */
  alias: string;
  /** Display label for pickers. */
  label: string;
  /** Context window size in tokens (with any betas that codeoid enables). */
  contextWindow: number;
  /** Rough tier for UI coloring / default routing choices. */
  tier: ModelTier;
  /** One-line description shown in the picker. */
  description: string;
}

/**
 * Canonical model list — order = picker display order (best-first for
 * planning, cheap-last for execution). Keep IDs stable; if Anthropic
 * ships a new point release, bump the id here and the alias stays valid.
 */
export const MODEL_CATALOG: readonly ModelDescriptor[] = [
  {
    id: "claude-opus-5",
    alias: "opus",
    label: "Opus 5",
    contextWindow: 1_000_000,
    tier: "premium",
    description: "Deepest reasoning. Best for planning, refactoring, and hard problems.",
  },
  {
    id: "claude-sonnet-5",
    alias: "sonnet",
    label: "Sonnet 5",
    contextWindow: 1_000_000,
    tier: "balanced",
    description: "Fast and capable. Good default for day-to-day coding.",
  },
  {
    id: "claude-haiku-4-5-20251001",
    alias: "haiku",
    label: "Haiku 4.5",
    contextWindow: 200_000,
    tier: "fast",
    description: "Cheapest + fastest. Good for simple edits and cheap subtasks.",
  },
];

/** Look up a descriptor by alias or full id. Case-insensitive on aliases. */
export function findModel(identifier: string): ModelDescriptor | null {
  if (!identifier) return null;
  const lower = identifier.toLowerCase().trim();
  for (const m of MODEL_CATALOG) {
    if (m.alias === lower) return m;
    if (m.id.toLowerCase() === lower) return m;
  }
  return null;
}

/**
 * Resolve user input → full model id. Accepts:
 *   - an alias ("opus" → "claude-opus-4-8")
 *   - a full known id (passed through)
 *   - any other string that looks like a Claude model id (passed through —
 *     user knows what they want; we don't gatekeep)
 * Returns null on empty/whitespace input.
 */
export function resolveModelId(identifier: string): string | null {
  const trimmed = identifier?.trim();
  if (!trimmed) return null;
  const known = findModel(trimmed);
  if (known) return known.id;
  // Passthrough: allow any "claude-*" id the caller provides even if it's
  // not in our catalog. Typos aren't caught here — they'll surface as
  // errors at SDK time, which is better than us refusing unknown-but-valid
  // point releases.
  if (/^claude-/.test(trimmed)) return trimmed;
  // Otherwise pass it through unchanged. The live backend (and ultimately the
  // SDK) is the real validator — refusing an unknown-but-valid value here is
  // worse than letting the SDK reject a genuine typo. Empty input already
  // returned null above.
  return trimmed;
}

/** Default model when nothing else is specified. */
export const DEFAULT_MODEL_ALIAS = "opus";

/**
 * The provider id whose model space this catalog describes. Must match the
 * default id the provider registry is built with
 * (`createDefaultProviderRegistry` → `new ProviderRegistry("claude")`);
 * `DEFAULT_PROVIDER_ID` in session-manager re-exports this so there is one
 * source of truth.
 */
export const CLAUDE_PROVIDER_ID = "claude";

/**
 * Provider-aware model resolution — the entry point every *session
 * construction* path must use, because `resolveModelId` speaks only Claude.
 *
 * The hazard it closes: model defaults arrive from provider-agnostic places
 * (`config.session.defaultModel`, a conductor/role override, a dispatch
 * task) but `resolveModelId` expands aliases against MODEL_CATALOG. Feed it
 * `"opus"` while building a session on the gemini backend and the session
 * silently carries `claude-opus-4-8` into a Google API call.
 *
 * Rules:
 *   - claude (or unspecified) backend → unchanged `resolveModelId` behavior.
 *   - any other backend → a value that is *Claude-specific* (a catalog alias
 *     or id, or a bare `claude-*` id) is *not applicable* here, so we return
 *     null and let the provider choose its own default. That is strictly
 *     better than forwarding a foreign id the backend will reject.
 *   - any other backend, non-Claude-looking value (`gemini-2.5-pro`,
 *     `gpt-5-codex`) → passed through untouched. Explicit per-child model
 *     choices are the point of per-role backends; we don't gatekeep them.
 *     The live backend catalog (`resolveAgainstList`, used on the
 *     `/model` change path) remains the real validator.
 */
export function resolveModelIdForProvider(
  identifier: string,
  providerId?: string,
): string | null {
  const trimmed = identifier?.trim();
  if (!trimmed) return null;
  if (!providerId || providerId === CLAUDE_PROVIDER_ID) {
    return resolveModelId(trimmed);
  }
  // Non-Claude backend: drop Claude-shaped values instead of forwarding them.
  if (findModel(trimmed)) return null;
  if (/^claude-/i.test(trimmed)) return null;
  return trimmed;
}

// ── Dynamic (live-backend) model resolution ──────────────────────────────

/**
 * The built-in catalog rendered as `ModelInfo`, used as a fallback before
 * any session has initialized and we've cached the live backend list.
 */
export function fallbackModelInfos(): ModelInfo[] {
  return MODEL_CATALOG.map((m) => ({
    value: m.alias,
    displayName: m.label,
    description: m.description,
    isDefault: m.alias === DEFAULT_MODEL_ALIAS,
  }));
}

/**
 * Strip a context-window variant suffix: `opus[1m]` → `opus`.
 *
 * The backend advertises variants as a bracketed suffix on the VALUE, not the
 * display name — the live list reports `opus[1m]` / "Opus (1M context)". A
 * user (or a stored session) typing the bare alias `opus` must still match it,
 * or resolution silently falls through to the baked-in catalog below and
 * pins them to whatever point release that catalog last knew about.
 *
 * Exported for unit testing.
 */
export function stripVariantSuffix(value: string): string {
  const i = value.indexOf("[");
  return i === -1 ? value : value.slice(0, i);
}

/**
 * Resolve user input → a canonical model value against a (live or fallback)
 * `ModelInfo[]`. Matches by exact `value`, by `value` with its variant suffix
 * stripped (so `opus` matches the backend's `opus[1m]`), or by
 * case-insensitive `displayName` (so `fable` matches "Fable"), with a
 * `claude-*` passthrough. Returns null when the input matches nothing — the
 * caller surfaces the set of valid values.
 *
 * Exact matches are checked across the WHOLE list before any suffix-stripped
 * match, so a backend offering both `opus` and `opus[1m]` resolves `opus` to
 * the exact entry rather than to whichever came first.
 */
export function resolveAgainstList(
  input: string,
  models: readonly ModelInfo[],
): string | null {
  const t = input?.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  for (const m of models) {
    if (m.value.toLowerCase() === lower) return m.value;
  }
  for (const m of models) {
    if (stripVariantSuffix(m.value).toLowerCase() === lower) return m.value;
    if (m.displayName.toLowerCase() === lower) return m.value;
  }
  if (/^claude-/i.test(t)) return t;
  return null;
}
