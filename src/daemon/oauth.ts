/**
 * OAuth authorization server — handles the browser-facing login flow and
 * exchanges verified identity for a ZeroID RS256 access token.
 *
 * Flow:
 *   1. Frontend redirects to GET /auth/authorize
 *   2. Daemon delegates to the configured IdentityProvider (Google, local, etc.)
 *   3. IdP verifies the user, redirects back to /auth/idp-callback
 *   4. For external IdPs: daemon forwards the raw OIDC id_token to ZeroID's
 *      token-exchange endpoint (RFC 8693) — ZeroID is the authority that issues
 *      the final RS256 access token. Google configured as ZeroID external issuer.
 *   5. Daemon redirects to /auth/callback#token=<access_token> (fragment, never sent to server)
 *   7. Frontend stores token, connects to daemon WebSocket.
 */

import { randomBytes } from "node:crypto";
import type { IdentityProvider, VerifiedUser } from "./identity-provider.js";

export interface OAuthConfig {
  /** ZeroID token endpoint for the final token exchange */
  zeroidTokenEndpoint: string;
  /** Registered OAuth client_id (used to identify this codeoid instance) */
  clientId: string;
  /**
   * client_id codeoid authenticates as at ZeroID's id_token exchange. ZeroID
   * (v1.12+) requires an authenticated client and only accepts an ID token
   * issued to that client (aud/azp), so this is the IdP client the ID token
   * names: the Google OAuth client id by default.
   */
  zeroidClientId: string;
  /** Secret for zeroidClientId (client_secret_post). Unset sends no secret. */
  zeroidClientSecret?: string;
  /** Google OAuth client ID — passed to GoogleOAuthProvider */
  googleClientId: string;
  /** Google OAuth client secret — passed to GoogleOAuthProvider */
  googleClientSecret: string;
  /** Account ID for ZeroID tenant scoping */
  accountId: string;
  /** Project ID for ZeroID tenant scoping */
  projectId: string;
  /** Allowed redirect URIs */
  allowedRedirectUris: string[];
  /** Scopes to grant users */
  defaultScopes: string[];
}

/** Pending authorization — stored between /auth/authorize and IdP callback */
interface PendingAuth {
  redirectUri: string;
  scope: string;
  state: string;
  createdAt: number;
}

/**
 * Cap on the in-memory `#pending` map. A faster-than-1Hz attacker
 * hitting `/auth/authorize` outpaces the 1-min cleanup sweep; without
 * a cap, ~360 k entries per 10 min × ~150 B each ≈ 50 MB until the
 * 10-min TTL kicks in. LRU eviction at the cap keeps steady-state
 * memory bounded even under abuse.
 */
const PENDING_AUTH_MAX = 10_000;
const PENDING_AUTH_TTL_MS = 600_000;
const PENDING_AUTH_SWEEP_MS = 60_000;

export class OAuthHandler {
  #config: OAuthConfig;
  #idp: IdentityProvider;
  #pending = new Map<string, PendingAuth>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OAuthConfig, idp: IdentityProvider) {
    this.#config = config;
    this.#idp = idp;

    // Clean up expired pending auths every 60s. `unref()` so the
    // timer doesn't hold the Bun event loop open after `stop()`.
    this.#sweepTimer = setInterval(() => {
      const cutoff = Date.now() - PENDING_AUTH_TTL_MS;
      for (const [key, auth] of this.#pending) {
        if (auth.createdAt < cutoff) this.#pending.delete(key);
      }
    }, PENDING_AUTH_SWEEP_MS);
    // Bun supports `Timer.unref` via the Node-compat API.
    (this.#sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Cancel the sweep timer and clear pending state. Call from the
   * ShutdownManager so the process can exit cleanly even if the
   * OAuthHandler is still alive at hot-reload / test teardown time.
   */
  stop(): void {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#pending.clear();
  }

  /**
   * Insert into `#pending` with LRU eviction at the cap. Keeps the
   * abuse-driven worst case bounded at ~PENDING_AUTH_MAX entries
   * regardless of inbound rate.
   */
  #setPending(key: string, value: PendingAuth): void {
    while (this.#pending.size >= PENDING_AUTH_MAX) {
      // Map iteration order is insertion order, so .keys().next() is
      // the oldest. O(1) drop.
      const oldest = this.#pending.keys().next();
      if (oldest.done) break;
      this.#pending.delete(oldest.value);
    }
    this.#pending.set(key, value);
  }

  get providerName(): string {
    return this.#idp.name;
  }

  async handleFetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);

    if (url.pathname === "/auth/authorize" && req.method === "GET") {
      return this.#handleAuthorize(url);
    }

    if (url.pathname === "/auth/authorize" && req.method === "POST") {
      // Local provider form submission
      return this.#handleLocalLogin(req);
    }

    if (url.pathname === "/auth/idp-callback") {
      return this.#handleIdpCallback(url);
    }

    if (url.pathname === "/auth/callback") {
      return this.#handleFinalCallback(url);
    }

    if (url.pathname === "/auth/provider" && req.method === "GET") {
      return Response.json({ provider: this.#idp.name });
    }

    return null;
  }

  // ── GET /auth/authorize — start the auth flow ─────────────────────

  #handleAuthorize(url: URL): Response {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const scope = url.searchParams.get("scope") ?? this.#config.defaultScopes.join(" ");
    const state = url.searchParams.get("state") ?? "";

    // Validate client_id if provided (optional for single-client deployments)
    if (clientId && clientId !== this.#config.clientId) {
      return new Response("Invalid client_id", { status: 400 });
    }
    if (!redirectUri || !this.#config.allowedRedirectUris.some(
      (u) => normalizeLoopback(u) === normalizeLoopback(redirectUri),
    )) {
      return new Response("Invalid redirect_uri", { status: 400 });
    }

    // Store pending auth — LRU-bounded via #setPending.
    const internalState = randomBytes(16).toString("hex");
    this.#setPending(internalState, {
      redirectUri,
      scope,
      state,
      createdAt: Date.now(),
    });

    // Delegate to IdP
    if (this.#idp.name !== "local") {
      // External IdP — redirect to their login page
      const callbackUri = `${url.origin}/auth/idp-callback`;
      const authUrl = this.#idp.getAuthorizationUrl(callbackUri, internalState);
      return Response.redirect(authUrl, 302);
    }

    // Local provider — show built-in login form
    return new Response(loginPage(internalState, scope), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // ── POST /auth/authorize — local provider form submission ─────────

  async #handleLocalLogin(req: Request): Promise<Response> {
    const form = await req.formData();
    const internalState = form.get("auth_state") as string;
    const userId = form.get("user_id") as string;
    const userName = form.get("user_name") as string;

    if (!internalState || !userId) {
      return new Response("Missing fields", { status: 400 });
    }

    const user: VerifiedUser = {
      id: userId,
      name: userName || userId,
      provider: "local",
    };

    return await this.#completeAuth(internalState, user);
  }

  // ── GET /auth/idp-callback — external IdP redirects back here ─────

  async #handleIdpCallback(url: URL): Promise<Response> {
    const internalState = url.searchParams.get("state");
    if (!internalState) {
      return new Response("Missing state parameter", { status: 400 });
    }

    const callbackUri = `${url.origin}/auth/idp-callback`;

    try {
      const user = await this.#idp.handleCallback(callbackUri, url.searchParams);
      return await this.#completeAuth(internalState, user);
    } catch (err) {
      const pending = this.#pending.get(internalState);
      this.#pending.delete(internalState);

      if (pending) {
        const callbackUrl = new URL(pending.redirectUri);
        callbackUrl.searchParams.set("error", err instanceof Error ? err.message : "Authentication failed");
        if (pending.state) callbackUrl.searchParams.set("state", pending.state);
        return Response.redirect(callbackUrl.toString(), 302);
      }

      return new Response(`Authentication failed: ${err instanceof Error ? err.message : "unknown"}`, { status: 400 });
    }
  }

  // ── Complete auth — exchange identity for ZeroID token, redirect ──

  async #completeAuth(internalState: string, user: VerifiedUser): Promise<Response> {
    const pending = this.#pending.get(internalState);
    if (!pending) {
      return new Response("Invalid or expired authorization request", { status: 400 });
    }
    this.#pending.delete(internalState);

    let accessToken: string;
    try {
      accessToken = await this.#exchangeForZeroIDToken(user, pending.scope);
    } catch (err) {
      const callbackUrl = new URL(pending.redirectUri);
      callbackUrl.searchParams.set(
        "error",
        err instanceof Error ? err.message : "Token exchange failed",
      );
      if (pending.state) callbackUrl.searchParams.set("state", pending.state);
      return Response.redirect(callbackUrl.toString(), 302);
    }

    const callbackUrl = new URL(pending.redirectUri);
    // Use a URL fragment so the token is never sent to the server (not in logs, history, or Referer).
    callbackUrl.hash = `token=${encodeURIComponent(accessToken)}`;
    if (pending.state) callbackUrl.searchParams.set("state", pending.state);
    return Response.redirect(callbackUrl.toString(), 302);
  }

  async #exchangeForZeroIDToken(user: VerifiedUser, scope: string): Promise<string> {
    if (!user.rawIdToken) {
      throw new Error(
        `Provider "${user.provider}" did not return an OIDC id_token — cannot exchange with ZeroID. Configure Google OAuth or another OIDC provider.`,
      );
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      subject_token: user.rawIdToken,
      client_id: this.#config.zeroidClientId,
      account_id: this.#config.accountId,
      project_id: this.#config.projectId,
      scope,
    });
    if (this.#config.zeroidClientSecret) {
      body.set("client_secret", this.#config.zeroidClientSecret);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(this.#config.zeroidTokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const hint =
        resp.status === 401 && !this.#config.zeroidClientSecret
          ? " — ZeroID requires client authentication for the id_token exchange; set CODEOID_ZEROID_CLIENT_SECRET"
          : "";
      throw new Error(`ZeroID token exchange failed (${resp.status}): ${text.slice(0, 200)}${hint}`);
    }

    const data = (await resp.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error("ZeroID response missing access_token");
    }
    return data.access_token;
  }

  // ── GET /auth/callback — landing page, stores the ZeroID token ────

  #handleFinalCallback(url: URL): Response {
    // Error case: query param (server-side readable, no token involved)
    const error = url.searchParams.get("error");
    if (error) {
      return new Response(errorPage(error), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    // Token case: fragment — the token is never sent to the server.
    // The callbackPage JS reads window.location.hash to extract it.
    return new Response(callbackPage(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

function normalizeLoopback(uri: string): string {
  return uri.replace("://localhost", "://127.0.0.1");
}

// =============================================================================
// HTML pages
// =============================================================================

function loginPage(authState: string, scope: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codeoid — Login</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
  background: #0a0a0f; color: #e4e4ed; height: 100dvh;
  display: flex; align-items: center; justify-content: center;
}
.card {
  background: #141420; border: 1px solid #2a2a3e; border-radius: 16px;
  padding: 2rem; width: min(90vw, 400px); display: flex; flex-direction: column; gap: 1.25rem;
}
.logo { font-size: 1.8rem; font-weight: 700; text-align: center; }
.subtitle { color: #8888a0; font-size: 0.9rem; text-align: center; }
.scopes { background: #0a0a0f; border-radius: 10px; padding: 0.75rem 1rem; font-size: 0.85rem; color: #8888a0; }
.scopes strong { color: #e4e4ed; }
label { font-size: 0.85rem; color: #8888a0; font-weight: 500; }
input {
  background: #0a0a0f; border: 1px solid #2a2a3e; border-radius: 10px;
  color: #e4e4ed; padding: 0.75rem 1rem; font-size: 1rem; outline: none; width: 100%;
}
input:focus { border-color: #6366f1; }
.btn {
  background: #6366f1; color: white; border: none; border-radius: 10px;
  padding: 0.75rem; font-size: 1rem; font-weight: 600; cursor: pointer;
}
.btn:hover { background: #818cf8; }
.field { display: flex; flex-direction: column; gap: 0.35rem; }
.warn { font-size: 0.75rem; color: #eab308; text-align: center; padding: 0.5rem; background: #1c1c2e; border-radius: 8px; }
.security { font-size: 0.75rem; color: #8888a0; text-align: center; }
</style>
</head>
<body>
<form method="POST" action="/auth/authorize" class="card">
  <div class="logo">&#9889; Codeoid</div>
  <p class="subtitle">Authorize access to your AI coding sessions</p>
  <div class="warn">&#9888; Local dev mode — no password verification. Configure Google OAuth for production.</div>
  <div class="scopes">
    <strong>Requested permissions:</strong><br>
    ${scope.split(" ").map((s) => `&bull; ${s}`).join("<br>")}
  </div>
  <div class="field">
    <label for="user_id">User ID</label>
    <input id="user_id" name="user_id" required placeholder="e.g. ydatta" autocomplete="username" autofocus />
  </div>
  <div class="field">
    <label for="user_name">Display Name</label>
    <input id="user_name" name="user_name" placeholder="e.g. Yash Datta" autocomplete="name" />
  </div>
  <input type="hidden" name="auth_state" value="${authState}" />
  <button type="submit" class="btn">Authorize</button>
  <p class="security">Secured by ZeroID &mdash; every action auditable</p>
</form>
</body>
</html>`;
}

function callbackPage(): string {
  // The token exchange has already happened server-side (daemon ↔ ZeroID).
  // The access token is in the URL fragment (#token=...) — never sent to server.
  // This page's JS reads window.location.hash, stores the token, and redirects.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codeoid — Signing in...</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  background: #0a0a0f; color: #e4e4ed; height: 100dvh;
  display: flex; align-items: center; justify-content: center;
}
.card {
  background: #141420; border: 1px solid #2a2a3e; border-radius: 16px;
  padding: 2rem; width: min(90vw, 400px); text-align: center;
}
.status { font-size: 1.2rem; font-weight: 600; margin-bottom: 0.5rem; color: #22c55e; }
.detail { color: #8888a0; font-size: 0.9rem; }
</style>
</head>
<body>
<div class="card">
  <div class="status">Authenticated!</div>
  <div class="detail">Redirecting to Codeoid...</div>
</div>
<script>
(function() {
  var params = new URLSearchParams(window.location.hash.slice(1));
  var token = params.get('token');
  if (token) {
    localStorage.setItem('codeoid.token', token);
    window.location.replace('/ui/');
  } else {
    document.querySelector('.status').textContent = 'Error';
    document.querySelector('.detail').textContent = 'No token in URL. Please try signing in again.';
  }
})();
</script>
</body>
</html>`;
}

function errorPage(error: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;}</style>
</head><body><div><h2>Authorization Failed</h2><p>${escapeHtml(error)}</p><p><a href="/ui/" style="color:#6366f1">Back to Codeoid</a></p></div></body></html>`;
}

/**
 * HTML-escape user-controlled text destined for an HTML response body.
 * `error` arrives via query string from an upstream OAuth provider — a
 * tampered redirect can stuff `<script>` in there, and the daemon's
 * origin holds the codeoid token in localStorage, so reflection here
 * is reachable XSS.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
