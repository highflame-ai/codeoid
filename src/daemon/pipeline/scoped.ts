/**
 * Pack-scoped registry ids.
 *
 * A pack registers its skills and gates under `<packId>/<id>` so two packs
 * declaring the same bare id coexist instead of overwriting each other
 * last-wins in the daemon-wide registries (org-dev and yash-dev both declare
 * `review`, `ship`, and `tests_pass`; before this the second install silently
 * replaced the first's, and a run from the first pack drove the wrong skill).
 *
 * Phase defs keep the bare id the author wrote — display, CLI, and the web
 * PackBrowser are unchanged. Resolution scopes the id by the run's `packId`
 * first and falls back to the bare id, which is how built-in gates (`always`,
 * `manual`) and explicit-`phases` plans (skills registered directly, no pack)
 * keep resolving exactly as before.
 */

import type { Registry } from "./interface";

/** `<packId>/<id>`, or the bare id when there is no pack. */
export const scopedId = (packId: string | undefined, id: string): string => (packId ? `${packId}/${id}` : id);

/** Resolve `id` for a run: the pack-scoped entry when the run has a pack and the
 *  pack declared it, else the bare (built-in / directly registered) entry. */
export function resolveScoped<T extends { id: string }>(
  reg: Registry<T>,
  packId: string | undefined,
  id: string,
): T | undefined {
  if (packId) {
    const scoped = reg.resolve(scopedId(packId, id));
    if (scoped) return scoped;
  }
  return reg.resolve(id);
}

export const hasScoped = <T extends { id: string }>(reg: Registry<T>, packId: string | undefined, id: string): boolean =>
  resolveScoped(reg, packId, id) !== undefined;
