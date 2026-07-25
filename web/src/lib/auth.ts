/**
 * Resolve a daemon access token. Mirrors the Rust client's `resolve_token`:
 *
 *   1. If a JWT is provided directly (`token`), use it.
 *   2. Else if an API key is provided (`apiKey` starting with `zid_sk_`),
 *      exchange it at ZeroID's `/oauth2/token` for a JWT.
 *   3. Else throw a structured error so the caller can surface a "sign in"
 *      affordance instead of crashing.
 *
 * The web UI persists credentials in localStorage so reloads stay signed in:
 * the API key (`codeoid.apiKey`, a long-lived `zid_sk_` secret) for the key
 * flow, and the JWT (`codeoid.token`) for the OAuth flow. SECURITY: both are
 * therefore readable by any same-origin script — an XSS would exfiltrate a
 * durable credential, not just a session. This is a known tradeoff for
 * reload-persistence; hardening (httpOnly cookie / non-persistent key) is
 * tracked separately. The markdown render path is XSS-sanitized (see
 * lib/sanitize-url) precisely because these live here.
 */

export const STORAGE_KEY_API_KEY = "codeoid.apiKey";
export const STORAGE_KEY_TOKEN = "codeoid.token";
// The rotating refresh token (ZeroID `zid_rt_`) handed off by an embedding host
// (Studio) alongside the access token. When present, the web UI renews its OWN
// access token by rotating this at ZeroID's /oauth2/token — the self-reliant
// embed session model — instead of the host re-minting on a timer. Rotated
// (replaced) on every successful refresh; single-use like every ZeroID refresh
// token. SECURITY: same durable-credential caveat as the api key (readable by
// same-origin script) — it is shorter-lived (bounded by the audience refresh
// TTL) and audience-scoped, but still never logged.
export const STORAGE_KEY_REFRESH_TOKEN = "codeoid.refreshToken";

export interface ResolveOptions {
  /** Pre-issued daemon JWT. Takes precedence. */
  token?: string;
  /** ZeroID API key (`zid_sk_...`) to exchange for a JWT. */
  apiKey?: string;
  /** ZeroID base URL. Defaults to http://localhost:8899. */
  zeroidUrl?: string;
  /**
   * Space-delimited scopes to request when exchanging an api_key.
   * Defaults to the codeoid web operator set — every verb the UI sends.
   * ZeroID propagates these into the issued JWT's `scopes` claim, which
   * the daemon enforces per-message. Without this, JWTs come back with
   * an empty scope set and every protocol verb is denied.
   */
  scope?: string;
  /** AbortSignal for the exchange call. */
  signal?: AbortSignal;
}

/** Default scope request for the web UI — every codeoid verb it sends. */
export const DEFAULT_WEB_SCOPES = [
  "session:list",
  "session:create",
  "session:attach",
  "session:watch",
  "session:send",
  "session:interrupt",
  "session:approve",
  "session:destroy",
  // Conductor scopes — delegated owner → conductor when the web UI opens the
  // conductor session. Harmless on non-conductor use.
  "session:read",
  "session:dispatch",
  "fs:read",
  // Pipeline / pack management — the /packs Pack Browser lists packs
  // (pipeline:read) and adds registries / installs / trusts / selects them
  // (pipeline:manage, owner-tier). Without these the browser renders but every
  // verb is rejected "Missing scope: pipeline:read".
  "pipeline:read",
  "pipeline:manage",
  // Pipeline RUNS — the /pipeline runner creates + advances + aborts
  // (pipeline:create) and answers / revises halts (pipeline:answer).
  "pipeline:create",
  "pipeline:answer",
].join(" ");

export interface ResolvedAuth {
  /** Bearer token to use against the daemon. */
  token: string;
  /** True if this came from an apiKey exchange (vs. a direct JWT). */
  exchanged: boolean;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly kind: "missing" | "exchange_failed" | "invalid",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function resolveToken(opts: ResolveOptions): Promise<ResolvedAuth> {
  if (opts.token) return { token: opts.token, exchanged: false };

  // After Google OAuth, /auth/callback stores a ZeroID RS256 token directly
  // in localStorage. Use it only when no API key is available (explicit or stored),
  // so a saved API key always takes precedence over an OAuth token.
  const storedApiKey = localStorage.getItem(STORAGE_KEY_API_KEY) ?? undefined;
  if (!opts.apiKey && !storedApiKey) {
    const storedToken = localStorage.getItem(STORAGE_KEY_TOKEN);
    if (storedToken) return { token: storedToken, exchanged: false };
  }

  const apiKey = opts.apiKey ?? storedApiKey;
  if (!apiKey) {
    throw new AuthError(
      "no auth — supply CODEOID_API_KEY (a zid_sk_… token) or sign in",
      "missing",
    );
  }
  if (!apiKey.startsWith("zid_sk_")) {
    throw new AuthError(
      `api key must start with "zid_sk_" — got "${apiKey.slice(0, 8)}…"`,
      "invalid",
    );
  }

  // Default to a same-origin URL ("/oauth2/token") so the browser doesn't
  // hit ZeroID cross-origin (ZeroID's /oauth2/token doesn't return CORS
  // headers). In dev, Vite's proxy intercepts /oauth2/* and forwards to
  // ZEROID_URL server-side. In prod, the deploy is expected to do the
  // same (ingress / nginx). An explicit `zeroidUrl` override still
  // works for absolute URLs.
  const zeroidUrl = opts.zeroidUrl ?? "";
  const url = zeroidUrl
    ? `${zeroidUrl.replace(/\/+$/, "")}/oauth2/token`
    : "/oauth2/token";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "api_key",
        api_key: apiKey,
        scope: opts.scope ?? DEFAULT_WEB_SCOPES,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new AuthError(`cannot reach ZeroID at ${url}`, "exchange_failed", err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AuthError(
      `ZeroID rejected the API key (${res.status}): ${body.slice(0, 200) || res.statusText}`,
      "exchange_failed",
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new AuthError("ZeroID returned non-JSON", "exchange_failed", err);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("access_token" in payload) ||
    typeof (payload as { access_token: unknown }).access_token !== "string"
  ) {
    throw new AuthError("ZeroID response missing access_token", "exchange_failed");
  }

  const token = (payload as { access_token: string }).access_token;
  return { token, exchanged: true };
}

/** Persist an API key for re-use across reloads (no JWT — those are short-lived). */
export function rememberApiKey(apiKey: string): void {
  localStorage.setItem(STORAGE_KEY_API_KEY, apiKey);
}

/**
 * Persist a ZeroID JWT in the OAuth-token slot so `resolveToken` picks it up and
 * reloads stay signed in. Used by the OAuth callback and the embed handoff.
 */
export function rememberOAuthToken(token: string): void {
  localStorage.setItem(STORAGE_KEY_TOKEN, token);
}

/** Persist a rotating refresh token for the self-reliant embed session. */
export function rememberRefreshToken(refreshToken: string): void {
  localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, refreshToken);
}

/** The stored rotating refresh token, or null when none was handed off. */
export function rememberedRefreshToken(): string | null {
  return localStorage.getItem(STORAGE_KEY_REFRESH_TOKEN);
}

/** Forget the stored refresh token — on sign-out or once it is spent/rejected. */
export function forgetRefreshToken(): void {
  localStorage.removeItem(STORAGE_KEY_REFRESH_TOKEN);
}

/** Decode a JWT payload without verifying it — for reading non-authoritative
 * hints (exp, aud) the CLIENT uses only for scheduling/routing. The daemon
 * re-verifies every token on the WS handshake, so a forged payload here buys
 * nothing. Returns {} on any malformed input (never throws). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    // base64url → base64, then atob. Pad to a multiple of 4.
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The token's `exp` as epoch milliseconds, or null when absent/unparseable. */
export function jwtExpiryMs(token: string): number | null {
  const exp = decodeJwtPayload(token)["exp"];
  return typeof exp === "number" && exp > 0 ? exp * 1000 : null;
}

/** The token's first `aud` value (its audience-profile name), or null. Used as
 * the `client_id` binding when rotating the refresh token (ZeroID binds the
 * audience-profile refresh token to that name — RFC 6749 §10.4). */
export function jwtAudience(token: string): string | null {
  const aud = decodeJwtPayload(token)["aud"];
  if (typeof aud === "string") return aud;
  if (Array.isArray(aud) && typeof aud[0] === "string") return aud[0];
  return null;
}

/** Default `client_id` for refresh rotation when the access token carries no
 * usable `aud` claim (should not happen for a codeoid-audience token). */
const DEFAULT_REFRESH_CLIENT_ID = "codeoid";

/**
 * Rotate the stored refresh token for a fresh access token at ZeroID's
 * `/oauth2/token` (`grant_type=refresh_token`). This is the self-reliant embed
 * refresh: no host round-trip, no Clerk. On success BOTH tokens are persisted
 * (the refresh token rotates — single-use) and the new access token is returned.
 *
 * client_id is the access token's audience-profile name (the binding ZeroID
 * set at issuance). Public/client-less: no secret is sent.
 *
 * On failure the refresh token is FORGOTTEN (a rejected/expired refresh token
 * is dead — ZeroID rotates single-use and revokes the family on reuse), so the
 * caller falls back to sign-in rather than looping on a dead token.
 */
export async function refreshAccessToken(opts: {
  zeroidUrl?: string;
  signal?: AbortSignal;
} = {}): Promise<string> {
  const refreshToken = rememberedRefreshToken();
  if (!refreshToken) {
    throw new AuthError("no refresh token to rotate", "missing");
  }

  const zeroidUrl = opts.zeroidUrl ?? "";
  const url = zeroidUrl ? `${zeroidUrl.replace(/\/+$/, "")}/oauth2/token` : "/oauth2/token";

  // Bind the rotation to the audience the current access token carries.
  const currentToken = localStorage.getItem(STORAGE_KEY_TOKEN);
  const clientId =
    (currentToken && jwtAudience(currentToken)) || DEFAULT_REFRESH_CLIENT_ID;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    // A network error is TRANSIENT — do NOT forget the token; the caller can
    // retry (e.g. the next reconnect) once connectivity returns.
    throw new AuthError(`cannot reach ZeroID at ${url}`, "exchange_failed", err);
  }

  if (!res.ok) {
    // A 4xx means the refresh token is spent/expired/revoked — forget it so we
    // don't loop. (A 5xx is arguably transient, but ZeroID returns 400
    // invalid_grant for a dead token; treat any non-2xx as terminal for the
    // token to keep the fallback simple and fail toward sign-in.)
    forgetRefreshToken();
    const body = await res.text().catch(() => "");
    throw new AuthError(
      `refresh token rejected (${res.status}): ${body.slice(0, 200) || res.statusText}`,
      "exchange_failed",
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new AuthError("ZeroID returned non-JSON on refresh", "exchange_failed", err);
  }
  if (!payload || typeof payload !== "object") {
    throw new AuthError("ZeroID refresh response was not an object", "exchange_failed");
  }
  const obj = payload as { access_token?: unknown; refresh_token?: unknown };
  if (typeof obj.access_token !== "string" || !obj.access_token) {
    throw new AuthError("ZeroID refresh response missing access_token", "exchange_failed");
  }

  rememberOAuthToken(obj.access_token);
  // Rotation: ZeroID returns a fresh refresh token each time. Persist it so the
  // NEXT rotation uses the successor (reusing the old one trips reuse-detection
  // and revokes the family). If the server ever omits it, keep the current one.
  if (typeof obj.refresh_token === "string" && obj.refresh_token) {
    rememberRefreshToken(obj.refresh_token);
  }
  return obj.access_token;
}

/** Minimal window surface consumeEmbedToken needs — so it's unit-testable. */
interface EmbedWindowLike {
  parent: unknown;
  location: { hash: string; pathname: string; search: string };
  history: { replaceState: (data: unknown, unused: string, url: string) => void };
}

/**
 * Embedded-handoff bootstrap. When codeoid's web UI is framed by a host app
 * (Highflame Studio), that host hands us a short-lived ZeroID token in the URL
 * hash (`#codeoid_token=…`) so the user never sees codeoid's own sign-in — the
 * platform already authenticated them. Capture it into the OAuth-token slot
 * (`resolveToken` then uses it) and scrub it from the address bar / history.
 *
 * Runs ONLY when actually framed (`window.parent !== window`): at the top level
 * ("Open in new tab") no token is handed off, so we never consume one outside
 * the embed path. The token is still verified by the daemon on every WebSocket
 * (signature via JWKS, tenancy, expiry), so this only skips the *interactive*
 * sign-in — it does not bypass authorization.
 *
 * @returns true if a token was consumed.
 */
export function consumeEmbedToken(
  win: EmbedWindowLike = window as unknown as EmbedWindowLike,
): boolean {
  if (win.parent === win) return false;
  const raw = win.location.hash.startsWith("#")
    ? win.location.hash.slice(1)
    : win.location.hash;
  if (!raw) return false;

  const params = new URLSearchParams(raw);
  const token = params.get("codeoid_token");
  if (!token) return false;

  rememberOAuthToken(token);

  // Scrub only our param from the URL; preserve any other hash state the app
  // may rely on. History is replaced so the token never lingers in the bar.
  params.delete("codeoid_token");
  const rest = params.toString();
  win.history.replaceState(
    null,
    "",
    `${win.location.pathname}${win.location.search}${rest ? `#${rest}` : ""}`,
  );
  return true;
}

/** Forget all persisted credentials (sign-out). */
export function forgetApiKey(): void {
  localStorage.removeItem(STORAGE_KEY_API_KEY);
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  localStorage.removeItem(STORAGE_KEY_REFRESH_TOKEN);
}

/** Forget only the stored OAuth JWT (not the API key). Used when the daemon
 * rejects the token: the OAuth flow has no refresh path, so keeping the dead
 * JWT would just re-loop on the next reload — but a valid API key should stay. */
export function forgetOAuthToken(): void {
  localStorage.removeItem(STORAGE_KEY_TOKEN);
}

export function rememberedApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY_API_KEY);
}

/** Returns the ZeroID token stored after a successful Google OAuth login. */
export function rememberedOAuthToken(): string | null {
  return localStorage.getItem(STORAGE_KEY_TOKEN);
}

/**
 * Fetch which OAuth provider the daemon is configured with.
 * Returns null when Google OAuth is not configured (API-key-only mode).
 */
export async function fetchOAuthProvider(): Promise<"google" | null> {
  try {
    const res = await fetch("/auth/provider");
    if (!res.ok) return null;
    const data = (await res.json()) as { provider: string | null };
    return data.provider === "google" ? "google" : null;
  } catch {
    return null;
  }
}

/**
 * Start the Google OAuth login flow. Redirects to the daemon's /auth/authorize;
 * the daemon handles the Google redirect and ZeroID token exchange server-side,
 * then lands the browser on /auth/callback with the ready access token.
 */
export function startOAuthLogin(opts?: { scope?: string }): void {
  const params = new URLSearchParams({
    client_id: "codeoid",
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: opts?.scope ?? DEFAULT_WEB_SCOPES,
  });
  window.location.href = `/auth/authorize?${params}`;
}

/**
 * Register a fresh agent identity in ZeroID and return the new API key.
 *
 * Used by the SignIn flow's "Register new web agent" affordance so a
 * brand-new user doesn't have to do CLI gymnastics. Defaults pick
 * sensible labels (`codeoid-web`) so the connected identity reads as
 * an actual web client, not a borrowed TUI agent.
 *
 * Endpoint: ZeroID's `/api/v1/agents/register`. Today the daemon's
 * default ZeroID is configured without admin auth on this route — fine
 * for local dev; production deploys must front it with proper auth.
 */
export async function registerWebAgent(opts: {
  name?: string;
  accountId?: string;
  projectId?: string;
  ownerId?: string;
  zeroidUrl?: string;
  signal?: AbortSignal;
} = {}): Promise<{ apiKey: string; agentUri: string; identityId: string }> {
  const baseUrl = (opts.zeroidUrl ?? "").replace(/\/+$/, "");
  const url = baseUrl
    ? `${baseUrl}/api/v1/agents/register`
    : "/api/v1/agents/register";

  const accountId = opts.accountId ?? "acct_demo";
  const projectId = opts.projectId ?? "proj_demo";
  const ownerId = opts.ownerId ?? "web-user@local";
  const name = opts.name ?? "codeoid-web";
  const externalId = `${name}-${Math.random().toString(36).slice(2, 10)}`;

  const body = {
    name,
    external_id: externalId,
    sub_type: "autonomous",
    trust_level: "first_party",
    framework: "codeoid-web",
    publisher: "codeoid",
    created_by: ownerId,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Account-ID": accountId,
        "X-Project-ID": projectId,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new AuthError(
      `cannot reach ZeroID admin endpoint at ${url}`,
      "exchange_failed",
      err,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AuthError(
      `ZeroID rejected the registration (${res.status}): ${text.slice(0, 240) || res.statusText}`,
      "exchange_failed",
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new AuthError("ZeroID returned non-JSON", "exchange_failed", err);
  }

  if (!payload || typeof payload !== "object") {
    throw new AuthError("ZeroID response missing fields", "exchange_failed");
  }
  const obj = payload as Record<string, unknown>;
  const apiKey = obj["api_key"];
  const identity = obj["identity"];
  if (typeof apiKey !== "string") {
    throw new AuthError("ZeroID response missing api_key", "exchange_failed");
  }
  const identityObj = identity && typeof identity === "object" ? (identity as Record<string, unknown>) : null;
  const agentUri =
    typeof identityObj?.["wimse_uri"] === "string"
      ? (identityObj["wimse_uri"] as string)
      : "";
  const identityId =
    typeof identityObj?.["id"] === "string"
      ? (identityObj["id"] as string)
      : "";

  return { apiKey, agentUri, identityId };
}
