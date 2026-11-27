/**
 * The backends this daemon offers, with display names — built-ins plus every
 * user-defined OpenAI-compatible endpoint (`oai:<name>`).
 *
 * Seeded from `auth.ok` (`providerInfo`, or bare `providers` ids from an older
 * daemon) and kept current by `providers.changed`, which the daemon pushes to
 * every connection that sent `providers.list` (connection.ts does, on every
 * connect). A pure store: the connection module feeds it, so there is no
 * import cycle.
 */

import { createSignal } from "solid-js";
import type { ProviderInfo } from "../protocol/types";

const [providers, setProvidersSignal] = createSignal<ProviderInfo[]>([]);

/** Default first, as the daemon orders them. */
export const providerList = providers;

/** Provider ids, default first — what the pickers iterate. */
export function providerIds(): string[] {
  return providers().map((p) => p.id);
}

export function setProviders(list: ProviderInfo[]): void {
  setProvidersSignal(list);
}

/** From `auth.ok`: the rich list when the daemon sends it, else synthesized from bare ids. */
export function ingestAuthProviders(ok: { providers?: string[]; providerInfo?: ProviderInfo[] } | null): void {
  if (!ok) {
    setProvidersSignal([]);
    return;
  }
  if (ok.providerInfo?.length) {
    setProvidersSignal(ok.providerInfo);
    return;
  }
  setProvidersSignal(
    (ok.providers ?? []).map((id, i) => ({
      id,
      displayName: id,
      kind: id.startsWith("oai:") ? ("endpoint" as const) : ("builtin" as const),
      isDefault: i === 0,
    })),
  );
}

/** A provider's label for display; the id itself for one we don't know (a removed endpoint). */
export function providerLabel(id: string | undefined): string {
  if (!id) return "";
  return providers().find((p) => p.id === id)?.displayName ?? id;
}

/** The default backend's id, or undefined before auth. */
export function defaultProviderId(): string | undefined {
  return providers().find((p) => p.isDefault)?.id ?? providers()[0]?.id;
}

export function _resetProvidersForTest(): void {
  setProvidersSignal([]);
}
