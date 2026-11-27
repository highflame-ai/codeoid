/**
 * OAuthHandler tests — exercise all HTTP routes and the ZeroID token-exchange
 * path without spawning a real daemon or hitting any network.
 *
 * Auth paths covered:
 *   A. Google OAuth (external IdP):
 *      GET /auth/authorize → 302 to Google
 *      GET /auth/idp-callback → ZeroID token exchange → 302 to /auth/callback#token=…
 *   B. API-key path is not handled here — that's ZeroID's /oauth2/token proxy,
 *      tested in tui-ws.test.ts.
 *
 * Routes also covered:
 *   GET /auth/provider  — discovery endpoint
 *   GET /auth/callback  — static landing page (success + error variants)
 *   Input validation (bad client_id, bad redirect_uri, missing state)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OAuthHandler, type OAuthConfig } from "../daemon/oauth.js";
import type { IdentityProvider, VerifiedUser } from "../daemon/identity-provider.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: OAuthConfig = {
  zeroidTokenEndpoint: "http://zeroid.test/oauth2/token",
  clientId: "codeoid",
  zeroidClientId: "gid_xxx",
  zeroidClientSecret: "zsecret_xxx",
  googleClientId: "gid_xxx",
  googleClientSecret: "gsecret_xxx",
  accountId: "acct_test",
  projectId: "proj_test",
  allowedRedirectUris: ["http://localhost:7400/auth/callback"],
  defaultScopes: ["session:list", "session:create"],
};

const CALLBACK_URI = "http://localhost:7400/auth/callback";

// Minimal IdentityProvider stub — simulates Google OIDC.
// handleCallback reads `id_token` from params so tests can inject specific tokens.
class StubIdP implements IdentityProvider {
  readonly name = "google";

  getAuthorizationUrl(callbackUri: string, state: string): string {
    return `https://accounts.google.com/o/oauth2/auth?redirect_uri=${encodeURIComponent(callbackUri)}&state=${state}`;
  }

  async handleCallback(_callbackUri: string, params: URLSearchParams): Promise<VerifiedUser> {
    const idToken = params.get("id_token") ?? "stub-id-token";
    return {
      id: "google-sub-123",
      email: "user@example.com",
      name: "Test User",
      provider: "google",
      rawIdToken: idToken,
    };
  }
}

// Variant that always throws from handleCallback (simulates IdP auth failure).
class FailingIdP extends StubIdP {
  override async handleCallback(): Promise<VerifiedUser> {
    throw new Error("IdP rejected the code");
  }
}

function makeHandler(idp: IdentityProvider = new StubIdP()): OAuthHandler {
  return new OAuthHandler(BASE_CONFIG, idp);
}

function get(handler: OAuthHandler, path: string): Promise<Response | null> {
  return handler.handleFetch(new Request(`http://localhost:7400${path}`));
}

// Run a GET /auth/authorize to obtain the internal state value that the handler
// embedded in the Google redirect URL, then return it so tests can chain to
// /auth/idp-callback with the correct state.
async function authorize(handler: OAuthHandler): Promise<string> {
  const params = new URLSearchParams({
    client_id: "codeoid",
    redirect_uri: CALLBACK_URI,
    scope: "session:list",
  });
  const resp = await get(handler, `/auth/authorize?${params}`);
  expect(resp?.status).toBe(302);
  const location = resp!.headers.get("Location")!;
  const stateMatch = location.match(/state=([^&]+)/);
  expect(stateMatch).not.toBeNull();
  return stateMatch![1];
}

// ── ZeroID fetch mock ─────────────────────────────────────────────────────────

let savedFetch: typeof globalThis.fetch;

function mockZeroIDOk(token = "zeroid-rs256-token"): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: token }),
    text: async () => "",
  });
}

function mockZeroIDFail(status = 500, body = "internal error"): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: false,
    status,
    text: async () => body,
  });
}

beforeEach(() => {
  savedFetch = globalThis.fetch;
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = savedFetch;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /auth/provider", () => {
  it("returns the IdP name when OAuth is configured", async () => {
    const handler = makeHandler();
    const resp = await get(handler, "/auth/provider");
    expect(resp?.status).toBe(200);
    const body = await resp!.json() as { provider: string };
    expect(body.provider).toBe("google");
    handler.stop();
  });
});

describe("GET /auth/authorize", () => {
  it("redirects to Google with a state param embedded", async () => {
    const handler = makeHandler();
    const params = new URLSearchParams({
      client_id: "codeoid",
      redirect_uri: CALLBACK_URI,
      scope: "session:list",
    });
    const resp = await get(handler, `/auth/authorize?${params}`);
    expect(resp?.status).toBe(302);
    const location = resp!.headers.get("Location")!;
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("state=");
    handler.stop();
  });

  it("accepts localhost and 127.0.0.1 redirect URIs interchangeably", async () => {
    const handler = makeHandler();
    const params = new URLSearchParams({
      redirect_uri: "http://127.0.0.1:7400/auth/callback",
      scope: "session:list",
    });
    const resp = await get(handler, `/auth/authorize?${params}`);
    expect(resp?.status).toBe(302);
    handler.stop();
  });

  it("returns 400 on wrong client_id", async () => {
    const handler = makeHandler();
    const params = new URLSearchParams({
      client_id: "evil-client",
      redirect_uri: CALLBACK_URI,
    });
    const resp = await get(handler, `/auth/authorize?${params}`);
    expect(resp?.status).toBe(400);
    handler.stop();
  });

  it("returns 400 on unregistered redirect_uri", async () => {
    const handler = makeHandler();
    const params = new URLSearchParams({
      redirect_uri: "https://evil.example.com/callback",
    });
    const resp = await get(handler, `/auth/authorize?${params}`);
    expect(resp?.status).toBe(400);
    handler.stop();
  });

  it("returns 400 when redirect_uri is missing", async () => {
    const handler = makeHandler();
    const resp = await get(handler, "/auth/authorize?client_id=codeoid");
    expect(resp?.status).toBe(400);
    handler.stop();
  });
});

describe("GET /auth/idp-callback — Google OAuth (ZeroID token exchange)", () => {
  it("exchanges id_token with ZeroID and redirects to /auth/callback#token=…", async () => {
    const handler = makeHandler();
    mockZeroIDOk("final-rs256-token");

    const internalState = await authorize(handler);
    const params = new URLSearchParams({
      state: internalState,
      code: "google-auth-code",
      id_token: "google-id-token-abc",
    });
    const resp = await get(handler, `/auth/idp-callback?${params}`);
    expect(resp?.status).toBe(302);
    const location = resp!.headers.get("Location")!;
    // Token must be in the fragment — never in the query string (not server-logged)
    expect(location).toContain("#token=");
    expect(location).toContain("final-rs256-token");
    expect(location).not.toContain("?token=");
    handler.stop();
  });

  it("forwards scope and client_id to ZeroID", async () => {
    const handler = makeHandler();
    const captured: { body?: string } = {};
    (globalThis as { fetch: unknown }).fetch = async (_url: string, opts: RequestInit) => {
      captured.body = opts.body as string;
      return { ok: true, json: async () => ({ access_token: "tok" }), text: async () => "" };
    };

    const internalState = await authorize(handler);
    await get(handler, `/auth/idp-callback?state=${internalState}&id_token=gid-tok`);

    const body = new URLSearchParams(captured.body);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(body.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:id_token");
    // The exchange authenticates as the client the ID token was issued to
    // (ZeroID D13), not as codeoid's own front-door client id.
    expect(body.get("client_id")).toBe("gid_xxx");
    expect(body.get("client_secret")).toBe("zsecret_xxx");
    expect(body.get("account_id")).toBe("acct_test");
    expect(body.get("project_id")).toBe("proj_test");
    expect(body.get("scope")).toBe("session:list"); // scope from /auth/authorize
    handler.stop();
  });

  it("sends no client_secret when none is configured", async () => {
    const handler = new OAuthHandler({ ...BASE_CONFIG, zeroidClientSecret: undefined }, new StubIdP());
    const captured: { body?: string } = {};
    (globalThis as { fetch: unknown }).fetch = async (_url: string, opts: RequestInit) => {
      captured.body = opts.body as string;
      return { ok: true, json: async () => ({ access_token: "tok" }), text: async () => "" };
    };

    const internalState = await authorize(handler);
    await get(handler, `/auth/idp-callback?state=${internalState}&id_token=gid-tok`);

    const body = new URLSearchParams(captured.body);
    expect(body.get("client_id")).toBe("gid_xxx");
    expect(body.has("client_secret")).toBe(false);
    handler.stop();
  });

  it("names CODEOID_ZEROID_CLIENT_SECRET when ZeroID refuses an unauthenticated exchange", async () => {
    const handler = new OAuthHandler({ ...BASE_CONFIG, zeroidClientSecret: undefined }, new StubIdP());
    mockZeroIDFail(401, '{"error":"invalid_client"}');

    const internalState = await authorize(handler);
    const resp = await get(handler, `/auth/idp-callback?state=${internalState}&id_token=gid-tok`);
    const location = decodeURIComponent(resp!.headers.get("Location")!);
    expect(location).toContain("CODEOID_ZEROID_CLIENT_SECRET");
    handler.stop();
  });

  it("redirects to callback with ?error= when ZeroID rejects", async () => {
    const handler = makeHandler();
    mockZeroIDFail(401, "invalid id_token");

    const internalState = await authorize(handler);
    const resp = await get(handler, `/auth/idp-callback?state=${internalState}&id_token=bad`);
    expect(resp?.status).toBe(302);
    const location = resp!.headers.get("Location")!;
    expect(location).toContain("error=");
    expect(location).not.toContain("#token=");
    handler.stop();
  });

  it("redirects with ?error= when the IdP itself fails", async () => {
    const handler = makeHandler(new FailingIdP());

    const internalState = await authorize(handler);
    const resp = await get(handler, `/auth/idp-callback?state=${internalState}`);
    expect(resp?.status).toBe(302);
    const location = resp!.headers.get("Location")!;
    expect(location).toContain("error=");
    handler.stop();
  });

  it("returns 400 when state param is absent", async () => {
    const handler = makeHandler();
    const resp = await get(handler, "/auth/idp-callback");
    expect(resp?.status).toBe(400);
    handler.stop();
  });

  it("returns 400 on an unknown / expired state", async () => {
    const handler = makeHandler();
    mockZeroIDOk();
    const resp = await get(handler, "/auth/idp-callback?state=nonexistent");
    // IdP callback is called; StubIdP succeeds; but #completeAuth finds no pending → 400
    expect(resp?.status).toBe(400);
    handler.stop();
  });

  it("consumes pending state so replay is rejected", async () => {
    const handler = makeHandler();
    mockZeroIDOk();
    const internalState = await authorize(handler);
    // First callback: succeeds
    const first = await get(handler, `/auth/idp-callback?state=${internalState}&id_token=tok`);
    expect(first?.status).toBe(302);
    // Replay with the same state: pending is gone
    const replay = await get(handler, `/auth/idp-callback?state=${internalState}&id_token=tok`);
    expect(replay?.status).toBe(400);
    handler.stop();
  });
});

describe("GET /auth/callback", () => {
  it("serves the landing page (reads token from fragment client-side)", async () => {
    const handler = makeHandler();
    const resp = await get(handler, "/auth/callback");
    expect(resp?.status).toBe(200);
    const html = await resp!.text();
    expect(html).toContain("window.location.hash");
    expect(html).toContain("localStorage.setItem");
    expect(html).toContain("codeoid.token");
    handler.stop();
  });

  it("serves an error page when ?error= is present", async () => {
    const handler = makeHandler();
    const resp = await get(handler, "/auth/callback?error=access_denied");
    expect(resp?.status).toBe(200);
    const html = await resp!.text();
    expect(html).toContain("access_denied");
    expect(html).not.toContain("<script>");
    handler.stop();
  });

  it("HTML-escapes the error value to prevent XSS", async () => {
    const handler = makeHandler();
    const resp = await get(handler, "/auth/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    const html = await resp!.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    handler.stop();
  });
});

describe("unhandled routes", () => {
  it("returns null for unknown paths", async () => {
    const handler = makeHandler();
    const resp = await get(handler, "/some/other/path");
    expect(resp).toBeNull();
    handler.stop();
  });

  it("returns null for POST to /auth/provider", async () => {
    const handler = makeHandler();
    const resp = await handler.handleFetch(
      new Request("http://localhost:7400/auth/provider", { method: "POST" }),
    );
    expect(resp).toBeNull();
    handler.stop();
  });
});
