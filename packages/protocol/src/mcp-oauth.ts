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
 *
 * `mcp.adopt` (#390) puts a remote server from Claude's own config into
 * codeoid's registry, signed in by codeoid, so the steps above can connect it.
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

/**
 * Adopt a remote MCP server from Claude's own config (`~/.claude.json`, a
 * `.mcp.json`, Claude's settings) into codeoid's registry: the same URL, with
 * codeoid's OAuth sign-in. Claude sessions then use codeoid's copy, not the
 * CLI's. Needs `settings:write`; with `sessionId`, also a session the caller
 * owns, whose workdir's servers are looked in too.
 */
export interface McpAdoptMsg {
  type: "mcp.adopt";
  id: string;
  /** The server's name in Claude's config. */
  server: string;
  /** A session whose workdir's servers to look in, beside the global ones. */
  sessionId?: string;
  /**
   * The URL the caller was shown for it. Two entries can share a name (a
   * global one and a repo's); this says which is meant, and a mismatch is
   * refused. Without it, a name that means two URLs is refused.
   */
  url?: string;
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

export interface McpAdoptResultMsg {
  type: "mcp.adopt.result";
  requestId: string;
  server: string;
  /** It was already adopted (same URL): nothing changed. */
  alreadyAdopted: boolean;
  /** Settings after adopting: the server is listed, to be signed in to. */
  snapshot: SettingsSnapshot;
}
