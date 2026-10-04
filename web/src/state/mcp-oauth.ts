/**
 * Remote MCP server sign-in — client half (docs/mcp-oauth-design.md §4).
 *
 * `begin` returns the provider's sign-in URL, which the user opens in a new
 * tab. The provider redirects that tab to the daemon, which completes the
 * exchange by itself; this drawer only learns of it by re-reading settings.
 * When the tab cannot reach the daemon (a remote daemon behind a loopback
 * redirect), the user pastes the address it landed on and `complete` finishes
 * it here. The credential never reaches the browser — what comes back is a
 * settings snapshot that reports the server as connected.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import { applySnapshot, fetchSettings } from "./settings";
import type {
  McpOAuthBeginResultMsg,
  McpOAuthCompleteResultMsg,
  McpOAuthDisconnectResultMsg,
} from "../protocol/types";

export type McpOAuthPhase = "idle" | "starting" | "awaiting_redirect" | "completing" | "disconnecting";

interface State {
  /** Server the in-flight attempt belongs to (one at a time, like backend login). */
  server: string | null;
  phase: McpOAuthPhase;
  /** The provider's sign-in URL while awaiting the redirect. */
  url: string | null;
  error: string | null;
}

const EMPTY: State = { server: null, phase: "idle", url: null, error: null };

const [state, setState] = createSignal<State>(EMPTY);

export const mcpOAuthState = state;

/** Test-only: reset the module singleton between cases. */
export function _resetMcpOAuthForTest(): void {
  setState(EMPTY);
}

export function dismissMcpOAuth(): void {
  setState(EMPTY);
}

/** Start connecting a server; resolves once there is a URL to open (or none needed). */
export async function beginMcpOAuth(server: string): Promise<void> {
  setState({ server, phase: "starting", url: null, error: null });
  try {
    const id = newRequestId();
    const res = await getClient().request<McpOAuthBeginResultMsg>(
      { type: "mcp.oauth.begin", id, server },
      {
        waitForResult: (m) => (m.type === "mcp.oauth.begin.result" && m.requestId === id ? m : undefined),
        // Discovery + dynamic registration are a few round trips to the provider.
        timeoutMs: 45_000,
      },
    );
    if (res.status === "redirect" && res.url) {
      if (res.browserBinding) setBindingCookie(res.browserBinding);
      setState({ server, phase: "awaiting_redirect", url: res.url, error: null });
      return;
    }
    setState(EMPTY);
    await fetchSettings(true);
  } catch (err) {
    setState({ server, phase: "idle", url: null, error: errText(err) });
  }
}

/** Finish a sign-in from the address the provider's redirect landed on. */
export async function completeMcpOAuth(callbackUrl: string): Promise<boolean> {
  const cur = state();
  setState((s) => ({ ...s, phase: "completing", error: null }));
  try {
    const id = newRequestId();
    const res = await getClient().request<McpOAuthCompleteResultMsg>(
      { type: "mcp.oauth.complete", id, callbackUrl: callbackUrl.trim() },
      {
        waitForResult: (m) => (m.type === "mcp.oauth.complete.result" && m.requestId === id ? m : undefined),
        timeoutMs: 45_000,
      },
    );
    applySnapshot(res.snapshot);
    setState(EMPTY);
    return true;
  } catch (err) {
    setState({ ...cur, phase: cur.url ? "awaiting_redirect" : "idle", error: errText(err) });
    return false;
  }
}

/** The redirect landed in another tab: re-read settings to see if it connected. */
export async function checkMcpOAuth(): Promise<void> {
  await fetchSettings(true);
}

export async function disconnectMcpOAuth(server: string): Promise<void> {
  setState({ server, phase: "disconnecting", url: null, error: null });
  try {
    const id = newRequestId();
    const res = await getClient().request<McpOAuthDisconnectResultMsg>(
      { type: "mcp.oauth.disconnect", id, server },
      {
        waitForResult: (m) => (m.type === "mcp.oauth.disconnect.result" && m.requestId === id ? m : undefined),
        timeoutMs: 10_000,
      },
    );
    applySnapshot(res.snapshot);
    setState(EMPTY);
  } catch (err) {
    setState({ server, phase: "idle", url: null, error: errText(err) });
  }
}

/**
 * Prove to the daemon's callback that this browser started the sign-in. Set on
 * this page's origin — the daemon's, when it serves the UI — so it reaches the
 * callback only if the redirect lands on the same host; otherwise the user
 * finishes by pasting, which is authenticated.
 */
function setBindingCookie(b: { cookie: string; value: string }): void {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${b.cookie}=${b.value}; Path=/; Max-Age=600; SameSite=Lax${secure}`;
  } catch {
    // No cookies (sandboxed frame): the paste fallback still works.
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
