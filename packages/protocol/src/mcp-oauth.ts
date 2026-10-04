/**
 * Connecting an OAuth-protected remote MCP server (docs/mcp-oauth-design.md §4).
 *
 *   1. `mcp.oauth.begin` — the daemon discovers the server's authorization
 *      server and returns the URL the user opens, or reports the tenant is
 *      already connected.
 *   2. The provider redirects the browser to the daemon's callback route, which
 *      completes the exchange on its own. When the browser cannot reach the
 *      daemon, the user pastes the address it landed on:
 *      `mcp.oauth.complete {callbackUrl}`.
 *   3. `mcp.oauth.disconnect` forgets the tenant's tokens.
 *
 * All three need `settings:write`: connecting an account configures the tenant.
 * The credential itself never crosses the wire.
 */

import type { SettingsSnapshot } from "./settings.js";

// ── Messages (client → daemon) ────────────────────────────────────────────────

export interface McpOAuthBeginMsg {
  type: "mcp.oauth.begin";
  id: string;
  /** Registry server name. */
  server: string;
}

export interface McpOAuthCompleteMsg {
  type: "mcp.oauth.complete";
  id: string;
  /** The full callback address the browser landed on (holds `code` + `state`). */
  callbackUrl: string;
}

export interface McpOAuthDisconnectMsg {
  type: "mcp.oauth.disconnect";
  id: string;
  server: string;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface McpOAuthBeginResultMsg {
  type: "mcp.oauth.begin.result";
  requestId: string;
  /** `connected` — nothing to do; `redirect` — open `url` to sign in. */
  status: "connected" | "redirect";
  url?: string;
  /**
   * With `redirect`: a cookie the client sets on the daemon's origin before
   * opening `url` (`Path=/`, `SameSite=Lax`, ten minutes). The daemon's
   * callback completes a sign-in only for the browser holding it, so a
   * sign-in link handed to someone else cannot bind their account into this
   * workspace. Without it (another origin, another browser) the user finishes
   * with `mcp.oauth.complete`.
   */
  browserBinding?: { cookie: string; value: string };
}

export interface McpOAuthCompleteResultMsg {
  type: "mcp.oauth.complete.result";
  requestId: string;
  server: string;
  /** Settings after connecting, so the drawer updates without a round trip. */
  snapshot: SettingsSnapshot;
}

export interface McpOAuthDisconnectResultMsg {
  type: "mcp.oauth.disconnect.result";
  requestId: string;
  snapshot: SettingsSnapshot;
}
