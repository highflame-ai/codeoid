/**
 * Live model catalog from the daemon (which sources it from the Claude Code
 * backend via the SDK's `supportedModels()`), so `/model` and the picker use
 * the real, current models instead of a list baked into the client that goes
 * stale. Fetched once after connect; `live` is false when the daemon is still
 * serving its built-in fallback (no session has initialized yet).
 */

import { createSignal } from "solid-js";
import { resolveAgainstList } from "@highflame/codeoid-core";

import { getClient, newRequestId } from "./connection";
import type { ModelInfo, ModelsListResultMsg } from "../protocol/types";

const [models, setModels] = createSignal<ModelInfo[]>([]);
const [live, setLive] = createSignal(false);

/** Current model catalog (may be the daemon's fallback until `modelsLive()`). */
export const modelCatalog = models;
/** True once the catalog reflects the live backend list, not a fallback. */
export const modelsLive = live;

/** Catalogs are per-backend ("opus" means nothing to codex), so cache by
 *  provider and remember which one the visible catalog currently reflects —
 *  a backend switch must refetch, never show the old backend's models. */
const cache = new Map<string, { models: ModelInfo[]; live: boolean }>();
const DEFAULT_KEY = "__default__";
let catalogProvider = DEFAULT_KEY;

/**
 * Fetch the model catalog for a backend and make it the visible catalog.
 * Pass the focused session's `providerId`; omit it only before a session is
 * focused (the daemon then serves its default backend). Cached live lists are
 * served instantly; a not-yet-live backend is refetched. `force` refetches
 * even a cached live list (used on an explicit backend switch).
 */
export async function fetchModels(provider?: string, force = false): Promise<void> {
  const key = provider ?? DEFAULT_KEY;
  catalogProvider = key;

  const cached = cache.get(key);
  if (cached) {
    // Show the cached list immediately (no stale-other-backend flash).
    setModels(cached.models);
    setLive(cached.live);
    if (cached.live && !force) return;
  } else {
    // Switching to a backend we haven't fetched: clear the previous
    // backend's list so the picker never shows the wrong models.
    setModels([]);
    setLive(false);
  }

  try {
    const id = newRequestId();
    const result = await getClient().request<ModelsListResultMsg>(
      { type: "models.list", id, ...(provider ? { provider } : {}) },
      {
        waitForResult: (m) =>
          m.type === "models.list.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    );
    cache.set(key, { models: result.models, live: result.live });
    // A faster switch may have moved the focus to another backend while we
    // awaited — only apply if this backend is still the visible one.
    if (catalogProvider === key) {
      setModels(result.models);
      setLive(result.live);
    }
  } catch {
    // Non-fatal — the prompt/picker fall back to whatever is cached (possibly
    // empty), and the daemon still validates /model server-side.
  }
}

/**
 * Resolve user input → a canonical model value against the fetched catalog.
 *
 * Delegates to `@highflame/codeoid-core` so this cannot drift from the
 * daemon's rule again — it previously did, and the client rejected `opus` as
 * unknown (the live list offers `opus[1m]`) before the request was ever sent,
 * while the daemon behind it would have resolved it. Returns null when nothing
 * matches (caller reports the available values). When the catalog is empty
 * (not yet fetched) the trimmed input passes through, so we don't block before
 * the list arrives — the daemon is the backstop validator either way.
 */
export function resolveModelInput(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const list = models();
  if (list.length === 0) return t;
  return resolveAgainstList(t, list);
}

export function _resetModelsForTest(): void {
  cache.clear();
  catalogProvider = DEFAULT_KEY;
  setModels([]);
  setLive(false);
}
