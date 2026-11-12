/**
 * Workstreams and credentials — client half (protocol: workstreams.ts,
 * docs/workstreams-design.md).
 *
 * The daemon owns the config; this module lists it, edits it, and asks what
 * a folder resolves to for the new-session picker. Every edit answers with
 * the full list, which replaces the state. A credential's value only ever
 * travels client → daemon; the daemon sends back whether it is set.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  ClientMessage,
  CredentialInfo,
  CredentialListResultMsg,
  WorkstreamListResultMsg,
  WorkstreamResolution,
  WorkstreamResolveResultMsg,
  WorkstreamSummary,
} from "../protocol/types";

interface WorkstreamsState {
  loaded: boolean;
  loading: boolean;
  revision: string;
  isolateGlobalServers: boolean;
  default?: string;
  workstreams: WorkstreamSummary[];
  error: string | null;
}

interface CredentialsState {
  loaded: boolean;
  store: { kind: string; writable: boolean };
  credentials: CredentialInfo[];
  error: string | null;
}

const EMPTY: WorkstreamsState = { loaded: false, loading: false, revision: "", isolateGlobalServers: false, workstreams: [], error: null };
const EMPTY_CREDS: CredentialsState = { loaded: false, store: { kind: "env-file", writable: true }, credentials: [], error: null };
const [state, setState] = createSignal<WorkstreamsState>(EMPTY);
const [creds, setCreds] = createSignal<CredentialsState>(EMPTY_CREDS);

export const workstreamsState = state;
export const credentialsState = creds;

export function _resetWorkstreamsForTest(): void {
  setState(EMPTY);
  setCreds(EMPTY_CREDS);
  inflight = null;
  refetch = null;
}

export function _setWorkstreamsForTest(s: Partial<WorkstreamsState>): void {
  setState({ ...EMPTY, loaded: true, ...s });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function applyList(res: WorkstreamListResultMsg): void {
  setState({
    loaded: true,
    loading: false,
    revision: res.revision,
    isolateGlobalServers: res.isolateGlobalServers,
    ...(res.default ? { default: res.default } : {}),
    workstreams: res.workstreams,
    error: null,
  });
}

async function listCall(build: (id: string) => ClientMessage): Promise<void> {
  const id = newRequestId();
  const res = await getClient().request<WorkstreamListResultMsg>(build(id), {
    waitForResult: (m) => (m.type === "workstream.list.result" && m.requestId === id ? m : undefined),
  });
  applyList(res);
}

async function credsCall(build: (id: string) => ClientMessage): Promise<void> {
  const id = newRequestId();
  const res = await getClient().request<CredentialListResultMsg>(build(id), {
    waitForResult: (m) => (m.type === "credential.list.result" && m.requestId === id ? m : undefined),
  });
  setCreds({ loaded: true, store: res.store, credentials: res.credentials, error: null });
}

let inflight: Promise<void> | null = null;
let refetch: Promise<void> | null = null;

/**
 * The configured workstreams (settings:read). A failure leaves them unloaded,
 * so the next caller tries again. A forced fetch while one is in flight wants
 * a list newer than that one (a `workstreams.changed` after it was sent): it
 * runs once the current one settles, and several share that refetch.
 */
export function fetchWorkstreams(force = false): Promise<void> {
  if (inflight) {
    if (!force) return inflight;
    refetch ??= inflight.then(() => {
      refetch = null;
      return fetchWorkstreams(true);
    });
    return refetch;
  }
  if (state().loaded && !force) return Promise.resolve();
  setState((s) => ({ ...s, loading: true }));
  inflight = (async () => {
    try {
      await listCall((id) => ({ type: "workstream.list", id }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errText(e) }));
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function fetchCredentials(): Promise<void> {
  try {
    await credsCall((id) => ({ type: "credential.list", id }));
  } catch (e) {
    setCreds((s) => ({ ...s, error: errText(e) }));
  }
}

/** On `workstreams.changed` or a reconnect: refetch what someone already asked for. */
export function refreshWorkstreams(): void {
  if (state().loaded || state().error) void fetchWorkstreams(true);
  if (creds().loaded || creds().error) void fetchCredentials();
}

/** Add or replace one workstream. Throws with the daemon's message (the config is validated whole). */
export function saveWorkstream(item: Record<string, unknown>): Promise<void> {
  return listCall((id) => ({ type: "workstream.upsert", id, item }));
}

export function deleteWorkstream(workstream: string): Promise<void> {
  return listCall((id) => ({ type: "workstream.delete", id, workstream }));
}

export function saveWorkstreamSettings(patch: { isolateGlobalServers?: boolean; default?: string | null }): Promise<void> {
  return listCall((id) => ({ type: "workstream.settings", id, ...patch }));
}

export function saveCredential(item: Record<string, unknown>): Promise<void> {
  return credsCall((id) => ({ type: "credential.upsert", id, item }));
}

export function deleteCredential(credential: string): Promise<void> {
  return credsCall((id) => ({ type: "credential.delete", id, credential }));
}

/** Set (or clear, with null) a credential's value. The value is never sent back. */
export function setCredentialValue(credential: string, value: string | null): Promise<void> {
  return credsCall((id) => ({ type: "credential.set_value", id, credential, value }));
}

/** What `workdir` resolves to (and whether `workstream` conflicts with it), for the new-session picker. */
export async function resolveWorkstream(workdir: string, workstream?: string): Promise<WorkstreamResolution> {
  const id = newRequestId();
  const res = await getClient().request<WorkstreamResolveResultMsg>(
    { type: "workstream.resolve", id, workdir, ...(workstream ? { workstream } : {}) },
    { waitForResult: (m) => (m.type === "workstream.resolve.result" && m.requestId === id ? m : undefined) },
  );
  return res.resolution;
}

/** The workstreams a session can be homed in (no bases). */
export function homeChoices(): WorkstreamSummary[] {
  return state().workstreams.filter((w) => !w.abstract);
}
