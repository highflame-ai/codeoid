/**
 * Model-value resolution, shared by the daemon and every frontend.
 *
 * This lived in two places — `src/daemon/models.ts` and
 * `web/src/state/models.ts` — with the web copy a hand-maintained mirror of
 * the daemon's. The two drifted: the daemon learned to match a bare alias
 * against a variant-suffixed value (`opus` → `opus[1m]`) and the mirror did
 * not, so the client rejected `opus` as unknown before the request was ever
 * sent, while the daemon behind it would have resolved it fine. One
 * implementation, imported by both, is the only version of this that stays
 * correct.
 */

/** The shape both sides agree on; the protocol's `ModelInfo` is assignable. */
export interface ModelChoice {
  value: string;
  displayName: string;
}

/**
 * Strip a context-window variant suffix: `opus[1m]` → `opus`.
 *
 * The backend advertises variants as a bracketed suffix on the VALUE, not the
 * display name — the live list reports `opus[1m]` / "Opus (1M context)". A
 * user typing the bare alias `opus` must still match it.
 */
export function stripVariantSuffix(value: string): string {
  const i = value.indexOf("[");
  return i === -1 ? value : value.slice(0, i);
}

/**
 * Resolve user input → a canonical model value against a model list.
 *
 * Matches by exact `value`, by `value` with its variant suffix stripped (so
 * `opus` matches `opus[1m]`), or by case-insensitive `displayName` (so `fable`
 * matches "Fable"), with a `claude-*` passthrough so an id newer than both the
 * catalog and the live list stays reachable. Returns null when nothing
 * matches — the caller surfaces the set of valid values.
 *
 * Exact matches are checked across the WHOLE list before any suffix-stripped
 * match, so a backend offering both `opus` and `opus[1m]` resolves `opus` to
 * the exact entry rather than to whichever came first.
 */
export function resolveAgainstList(
  input: string,
  models: readonly ModelChoice[],
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
