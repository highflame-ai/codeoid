/**
 * Interactive backend sign-in — client half.
 *
 * A two-step, out-of-band flow: ask the daemon to start the backend's own login
 * command, show the user the URL it returns, take the code the vendor's page
 * gives them, hand it back. At most one attempt is tracked at a time, matching
 * the daemon, which holds at most one per backend.
 *
 * The code is passed straight through and never stored here — not in the state
 * signal, not in a closure that outlives the call. What comes back is a
 * settings snapshot, which reports the resulting credential as *set* and never
 * carries its value.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import { applySnapshot } from "./settings";
import type {
  BackendLoginCancelResultMsg,
  BackendLoginStartResultMsg,
  BackendLoginSubmitResultMsg,
  LoginBackend,
  PendingBackendLogin,
} from "../protocol/types";

/**
 * `starting` and `submitting` are both slow (the daemon is waiting on a vendor
 * command, not on us), which is exactly why they are distinct states rather
 * than one `busy` flag — the two waits need different words on screen.
 */
export type LoginPhase = "idle" | "starting" | "awaiting_code" | "submitting" | "done";

interface State {
  backend: LoginBackend | null;
  phase: LoginPhase;
  login: PendingBackendLogin | null;
  error: string | null;
}

const EMPTY: State = { backend: null, phase: "idle", login: null, error: null };

const [state, setState] = createSignal<State>(EMPTY);

export const backendLoginState = state;

/** Test-only: reset the module singleton between cases. */
export function _resetBackendLoginForTest(): void {
  setState(EMPTY);
}

/** Drop the panel back to its resting state without touching the daemon. */
export function dismissBackendLogin(): void {
  setState(EMPTY);
}

/**
 * Ask the daemon to start the backend's login command.
 *
 * Resolves only once there is a URL to show, so the panel never renders an
 * "in progress" step the user cannot act on. Generous timeout: the daemon is
 * waiting on a vendor binary's first output, not on a round trip.
 */
export async function startBackendLogin(backend: LoginBackend): Promise<void> {
  setState({ backend, phase: "starting", login: null, error: null });
  try {
    const id = newRequestId();
    const res = await getClient().request<BackendLoginStartResultMsg>(
      { type: "backend.login.start", id, backend },
      {
        waitForResult: (m) =>
          m.type === "backend.login.start.result" && m.requestId === id ? m : undefined,
        timeoutMs: 60_000,
      },
    );
    setState({ backend, phase: "awaiting_code", login: res.login, error: null });
  } catch (err) {
    setState({ backend, phase: "idle", login: null, error: errText(err) });
  }
}

/**
 * Submit the vendor's code and finish the exchange.
 *
 * Terminal either way, matching the daemon: a rejected code ends the attempt
 * and the user starts again, rather than retrying into a command whose state
 * neither side can still describe.
 */
export async function submitBackendLoginCode(code: string): Promise<boolean> {
  const cur = state();
  if (!cur.login) return false;
  const loginId = cur.login.loginId;
  setState((s) => ({ ...s, phase: "submitting", error: null }));
  try {
    const id = newRequestId();
    const res = await getClient().request<BackendLoginSubmitResultMsg>(
      { type: "backend.login.submit", id, loginId, code },
      {
        waitForResult: (m) =>
          m.type === "backend.login.submit.result" && m.requestId === id ? m : undefined,
        timeoutMs: 120_000,
      },
    );
    // The snapshot rides back on the result, so the drawer shows the new
    // credential as set without a second round trip.
    applySnapshot(res.snapshot);
    if (res.ok) {
      setState((s) => ({ ...s, phase: "done", login: null, error: null }));
      return true;
    }
    setState((s) => ({
      ...s,
      phase: "idle",
      login: null,
      error: res.error ?? "Sign-in failed. Start again.",
    }));
    return false;
  } catch (err) {
    setState((s) => ({ ...s, phase: "idle", login: null, error: errText(err) }));
    return false;
  }
}

/**
 * Abandon the attempt. Best-effort by design: the local state clears whatever
 * the daemon says, because a user who pressed cancel should not be stuck
 * looking at a dead URL if the message failed to land. The daemon expires the
 * attempt on its own timer regardless.
 */
export async function cancelBackendLogin(): Promise<void> {
  const cur = state();
  setState(EMPTY);
  if (!cur.login) return;
  try {
    const id = newRequestId();
    await getClient().request<BackendLoginCancelResultMsg>(
      { type: "backend.login.cancel", id, loginId: cur.login.loginId },
      {
        waitForResult: (m) =>
          m.type === "backend.login.cancel.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    );
  } catch {
    // Already gone, or the socket is down — the daemon's TTL covers both.
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
