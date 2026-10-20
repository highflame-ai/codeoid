/**
 * OpenAI-compatible endpoints — client half (protocol: endpoints.ts).
 *
 * Each endpoint is a backend (`oai:<name>`). Keys and header values are
 * write-only: sent on save, never returned. Every change answers with the full
 * list, which replaces the state; the provider pickers update separately from
 * the daemon's `providers.changed` push.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type {
  EndpointInfo,
  EndpointsResultMsg,
  EndpointsSetMsg,
  EndpointsTestMsg,
  EndpointsTestResultMsg,
} from "../protocol/types";

interface State {
  loaded: boolean;
  loading: boolean;
  endpoints: EndpointInfo[];
  error: string | null;
}

const EMPTY: State = { loaded: false, loading: false, endpoints: [], error: null };
const [state, setState] = createSignal<State>(EMPTY);

export const endpointsState = state;

export function _resetEndpointsForTest(): void {
  setState(EMPTY);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function listCall(msg: { type: "endpoints.list" | "endpoints.set" | "endpoints.remove" } & Record<string, unknown>): Promise<void> {
  const id = newRequestId();
  const res = await getClient().request<EndpointsResultMsg>({ ...msg, id } as never, {
    waitForResult: (m) => (m.type === "endpoints.result" && m.requestId === id ? m : undefined),
  });
  setState({ loaded: true, loading: false, endpoints: res.endpoints, error: null });
}

export async function fetchEndpoints(): Promise<void> {
  setState((s) => ({ ...s, loading: true }));
  try {
    await listCall({ type: "endpoints.list" });
  } catch (e) {
    setState((s) => ({ ...s, loaded: true, loading: false, error: errText(e) }));
  }
}

/** Add or replace. Throws with the daemon's validation message. */
export async function saveEndpoint(input: Omit<EndpointsSetMsg, "type" | "id">): Promise<void> {
  await listCall({ type: "endpoints.set", ...input });
}

export async function removeEndpoint(name: string): Promise<void> {
  await listCall({ type: "endpoints.remove", name });
}

/** List an endpoint's models — stored, or a draft (the stored key/headers fill gaps). Never throws. */
export async function testEndpoint(input: Omit<EndpointsTestMsg, "type" | "id">): Promise<EndpointsTestResultMsg> {
  const id = newRequestId();
  try {
    return await getClient().request<EndpointsTestResultMsg>(
      { type: "endpoints.test", id, ...input },
      {
        waitForResult: (m) => (m.type === "endpoints.test.result" && m.requestId === id ? m : undefined),
        timeoutMs: 30_000,
      },
    );
  } catch (e) {
    return { type: "endpoints.test.result", requestId: id, ok: false, error: errText(e) };
  }
}

/** Same name rule the daemon enforces. */
export function endpointNameProblem(name: string): string | null {
  if (!name) return "a name is required";
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return "1–40 lowercase letters, digits and dashes, starting with a letter or digit";
  return null;
}
