/**
 * Settings state — the manifest + current effective values fetched from the
 * daemon, plus save orchestration. Daemon-canonical: the drawer only renders
 * this slice and dispatches patches back through `saveSettings`.
 */

import { batch, createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  SettingError,
  SettingPatch,
  SettingsGetResultMsg,
  SettingsManifest,
  SettingsSchemaResultMsg,
  SettingsSetResultMsg,
  SettingsSnapshot,
} from "../protocol/types";

interface State {
  loading: boolean;
  saving: boolean;
  manifest: SettingsManifest | null;
  snapshot: SettingsSnapshot | null;
  error: string | null;
  saveErrors: SettingError[];
  /** Sticky: true once any saved change needs a daemon restart to take effect. */
  restartRequired: boolean;
  fetchedAt: number;
}

const EMPTY: State = {
  loading: false,
  saving: false,
  manifest: null,
  snapshot: null,
  error: null,
  saveErrors: [],
  restartRequired: false,
  fetchedAt: 0,
};

const [state, setState] = createSignal<State>(EMPTY);

export const settingsState = state;

let inflight = false;

/** Test-only: reset the module singleton between cases. */
export function _resetSettingsForTest(): void {
  inflight = false;
  setState(EMPTY);
}

/**
 * Fetch the manifest (once) + current values. Idempotent — a second call while
 * one is in flight is a no-op, and the manifest is only fetched when missing.
 */
export async function fetchSettings(force = false): Promise<void> {
  if (inflight) return;
  const cur = state();
  if (!force && cur.manifest && cur.snapshot) return; // already loaded
  inflight = true;
  // Clear stale save errors so a reopened drawer doesn't show an old banner.
  setState((s) => ({ ...s, loading: true, error: null, saveErrors: [] }));
  try {
    // A forced refresh reloads the manifest too (the daemon's schema may have
    // changed), not just the values.
    let manifest = force ? null : cur.manifest;
    if (!manifest) {
      const sid = newRequestId();
      const res = await getClient().request<SettingsSchemaResultMsg>(
        { type: "settings.schema", id: sid },
        {
          waitForResult: (m) =>
            m.type === "settings.schema.result" && m.requestId === sid ? m : undefined,
          timeoutMs: 8_000,
        },
      );
      manifest = res.manifest;
    }
    const gid = newRequestId();
    const snap = await getClient().request<SettingsGetResultMsg>(
      { type: "settings.get", id: gid },
      {
        waitForResult: (m) =>
          m.type === "settings.get.result" && m.requestId === gid ? m : undefined,
        timeoutMs: 8_000,
      },
    );
    batch(() =>
      setState((s) => ({
        ...s,
        loading: false,
        manifest,
        snapshot: snap.snapshot,
        error: null,
        fetchedAt: Date.now(),
      })),
    );
  } catch (err) {
    setState((s) => ({
      ...s,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  } finally {
    inflight = false;
  }
}

/**
 * Adopt a snapshot that arrived on someone else's result message.
 *
 * A completed backend sign-in writes a secret, and its result already carries
 * the settings AFTER that write — so the drawer shows the new credential as set
 * without a redundant `settings.get`. Values only; the manifest is untouched.
 */
export function applySnapshot(snapshot: SettingsSnapshot): void {
  setState((s) => ({ ...s, snapshot, fetchedAt: Date.now() }));
}

/**
 * Persist a batch of changes. Returns the result so the caller can clear its
 * dirty state on success / surface per-field errors on failure.
 */
export async function saveSettings(patches: SettingPatch[]): Promise<SettingsSetResultMsg | null> {
  if (patches.length === 0) return null;
  setState((s) => ({ ...s, saving: true, saveErrors: [] }));
  try {
    const id = newRequestId();
    const res = await getClient().request<SettingsSetResultMsg>(
      { type: "settings.set", id, patches },
      {
        waitForResult: (m) =>
          m.type === "settings.set.result" && m.requestId === id ? m : undefined,
        timeoutMs: 10_000,
      },
    );
    batch(() =>
      setState((s) => ({
        ...s,
        saving: false,
        snapshot: res.snapshot,
        saveErrors: res.errors,
        restartRequired: s.restartRequired || (res.ok && res.restartRequired),
      })),
    );
    return res;
  } catch (err) {
    setState((s) => ({
      ...s,
      saving: false,
      saveErrors: [{ key: "", message: err instanceof Error ? err.message : String(err) }],
    }));
    return null;
  }
}
