/**
 * Pack state — the installed / available / registry snapshot fetched from the
 * daemon, plus mutation orchestration (add registry · install · remove · trust
 * · select). Daemon-canonical: every verb replies with the FULL refreshed
 * `pipeline.pack.list.result`, so each call just replaces the slice from the
 * result — no optimistic patching. The PackBrowser only renders this slice.
 *
 * Mirrors state/settings.ts: a module-singleton signal, `getClient().request`
 * with a typed `waitForResult` (the pack verbs reply with their own result
 * frame, never a bare `response.ok`), and a `_resetPacksForTest` hook.
 */

import { batch, createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  AvailablePackWire,
  ClientMessage,
  PackListResultMsg,
  PackWire,
  RegistryWire,
} from "../protocol/types";

interface PacksState {
  /** A read (`pipeline.pack.list`) is in flight. */
  loading: boolean;
  /** A mutation (add/install/remove/trust/select) is in flight. */
  busy: boolean;
  /** True once at least one list result has landed. */
  loaded: boolean;
  installed: PackWire[];
  available: AvailablePackWire[];
  registries: RegistryWire[];
  /** Last fetch/mutation error (e.g. a `forbidden` scope rejection). */
  error: string | null;
}

const EMPTY: PacksState = {
  loading: false,
  busy: false,
  loaded: false,
  installed: [],
  available: [],
  registries: [],
  error: null,
};

const [state, setState] = createSignal<PacksState>(EMPTY);

export const packsState = state;

/** Test-only: reset the module singleton between cases. */
export function _resetPacksForTest(): void {
  setState(EMPTY);
}

/** Registry `add` / pack `install` may `git clone` — give them room. */
const MUTATE_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 15_000;

/** A `response.error` rejection is the raw wire object `{ error, code }`; a
 *  transport failure is an `Error`. Surface whichever human string we have. */
function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "error" in e) {
    const m = (e as { error?: unknown }).error;
    if (typeof m === "string") return m;
  }
  return e instanceof Error ? e.message : String(e);
}

function applyResult(res: PackListResultMsg): void {
  batch(() =>
    setState((s) => ({
      ...s,
      installed: res.installed,
      available: res.available,
      registries: res.registries,
      loaded: true,
      error: null,
    })),
  );
}

/**
 * Send a pack verb and await its `pipeline.pack.list.result`, applying the
 * refreshed slice. `mutation` toggles the right in-flight flag so the browser
 * can disable read vs. write affordances independently.
 */
async function dispatch(
  build: (id: string) => ClientMessage,
  mutation: boolean,
): Promise<void> {
  const id = newRequestId();
  setState((s) => ({
    ...s,
    error: null,
    loading: mutation ? s.loading : true,
    busy: mutation ? true : s.busy,
  }));
  try {
    const res = await getClient().request<PackListResultMsg>(build(id), {
      waitForResult: (m) =>
        m.type === "pipeline.pack.list.result" && m.requestId === id ? m : undefined,
      timeoutMs: mutation ? MUTATE_TIMEOUT_MS : READ_TIMEOUT_MS,
    });
    applyResult(res);
  } catch (e) {
    setState((s) => ({ ...s, error: errMessage(e) }));
  } finally {
    setState((s) => ({ ...s, loading: false, busy: false }));
  }
}

/** Fetch the full pack snapshot (scope `pipeline:read`). */
export function fetchPacks(): Promise<void> {
  return dispatch((id) => ({ type: "pipeline.pack.list", id }), false);
}

/**
 * Pull + in-memory reload a registry's installed packs (scope `pipeline:manage`).
 * `name` is required here; the protocol supports omitting it (refresh all registries),
 * but the web UI only exposes per-registry refresh.
 */
export function refreshRegistry(name: string): Promise<void> {
  return dispatch((id) => ({ type: "pipeline.registry.refresh", id, name }), true);
}

/** Add + clone a git pack registry (scope `pipeline:manage`). */
export function addRegistry(url: string, name?: string, ref?: string): Promise<void> {
  return dispatch(
    (id) => ({
      type: "pipeline.registry.add",
      id,
      url,
      ...(name ? { name } : {}),
      ...(ref ? { ref } : {}),
    }),
    true,
  );
}

/** Install a registry-discovered pack by id (scope `pipeline:manage`). */
export function installPack(packId: string, trusted = false): Promise<void> {
  return dispatch(
    (id) => ({ type: "pipeline.pack.install", id, packId, trusted }),
    true,
  );
}

/** Uninstall a pack (scope `pipeline:manage`). */
export function removePack(packId: string): Promise<void> {
  return dispatch((id) => ({ type: "pipeline.pack.remove", id, packId }), true);
}

/** Toggle whether a pack may run host shell `command` gates (scope `pipeline:manage`). */
export function trustPack(packId: string, trusted: boolean): Promise<void> {
  return dispatch(
    (id) => ({ type: "pipeline.pack.trust", id, packId, trusted }),
    true,
  );
}

/** Set (or clear, with `null`) the selected default pack (scope `pipeline:manage`). */
export function selectPack(packId: string | null): Promise<void> {
  return dispatch((id) => ({ type: "pipeline.pack.select", id, packId }), true);
}
