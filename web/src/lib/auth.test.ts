/**
 * Auth library tests — resolveToken precedence, OAuth token fallback,
 * API-key exchange, and provider discovery.
 *
 * Auth paths covered:
 *   A. API-key path: resolveToken exchanges zid_sk_… at ZeroID → JWT
 *   B. OAuth path:   resolveToken falls back to codeoid.token from localStorage
 *   C. Priority:     stored API key always beats stored OAuth token
 *   D. fetchOAuthProvider: discovery endpoint → "google" | null
 *   E. localStorage helpers: rememberApiKey, rememberedApiKey, forgetApiKey,
 *      rememberedOAuthToken
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveToken,
  rememberApiKey,
  rememberedApiKey,
  forgetApiKey,
  rememberedOAuthToken,
  fetchOAuthProvider,
  consumeEmbedToken,
  readLocalModeToken,
  AuthError,
} from "./auth";

// ── localStorage mock (Node env has no browser storage) ──────────────────────

const store = new Map<string, string>();
const mockStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};
Object.defineProperty(globalThis, "localStorage", {
  value: mockStorage,
  writable: true,
  configurable: true,
});

// ── fetch mock ────────────────────────────────────────────────────────────────

let savedFetch: typeof globalThis.fetch;

function mockFetch(response: object, ok = true, status = 200): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
}

beforeEach(() => {
  store.clear();
  savedFetch = globalThis.fetch;
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = savedFetch;
});

// ── A. API-key exchange path ──────────────────────────────────────────────────

describe("resolveToken — API key exchange", () => {
  it("exchanges a supplied zid_sk_ key for a JWT", async () => {
    mockFetch({ access_token: "jwt-from-zeroid" });
    const result = await resolveToken({ apiKey: "zid_sk_test123" });
    expect(result.token).toBe("jwt-from-zeroid");
    expect(result.exchanged).toBe(true);
  });

  it("exchanges a key stored in localStorage", async () => {
    rememberApiKey("zid_sk_stored");
    mockFetch({ access_token: "jwt-stored" });
    const result = await resolveToken({});
    expect(result.token).toBe("jwt-stored");
    expect(result.exchanged).toBe(true);
  });

  it("throws AuthError(invalid) when key does not start with zid_sk_", async () => {
    await expect(resolveToken({ apiKey: "bad_key_format" })).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  it("throws AuthError(exchange_failed) when ZeroID returns non-ok", async () => {
    mockFetch({ error: "invalid_client" }, false, 401);
    await expect(resolveToken({ apiKey: "zid_sk_x" })).rejects.toMatchObject({
      kind: "exchange_failed",
    });
  });

  it("throws AuthError(exchange_failed) when ZeroID response lacks access_token", async () => {
    mockFetch({ error_description: "missing token" });
    await expect(resolveToken({ apiKey: "zid_sk_x" })).rejects.toMatchObject({
      kind: "exchange_failed",
    });
  });
});

// ── B. OAuth token fallback path ──────────────────────────────────────────────

describe("resolveToken — OAuth token fallback", () => {
  it("returns a stored OAuth token when no API key is available", async () => {
    store.set("codeoid.token", "oauth-rs256-token");
    const result = await resolveToken({});
    expect(result.token).toBe("oauth-rs256-token");
    expect(result.exchanged).toBe(false);
  });

  it("returns a directly supplied token without touching localStorage or fetch", async () => {
    store.set("codeoid.token", "should-not-be-used");
    let fetchCalled = false;
    (globalThis as { fetch: unknown }).fetch = async () => { fetchCalled = true; return {}; };
    const result = await resolveToken({ token: "direct-token" });
    expect(result.token).toBe("direct-token");
    expect(result.exchanged).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it("throws AuthError(missing) when nothing is available", async () => {
    await expect(resolveToken({})).rejects.toMatchObject({ kind: "missing" });
  });
});

// ── C. Priority: API key beats OAuth token ────────────────────────────────────

describe("resolveToken — API key takes priority over OAuth token", () => {
  it("uses stored API key even when an OAuth token is also in localStorage", async () => {
    rememberApiKey("zid_sk_wins");
    store.set("codeoid.token", "oauth-should-be-ignored");
    mockFetch({ access_token: "jwt-from-key" });
    const result = await resolveToken({});
    expect(result.token).toBe("jwt-from-key");
    expect(result.exchanged).toBe(true);
  });

  it("explicit apiKey overrides stored OAuth token", async () => {
    store.set("codeoid.token", "oauth-should-be-ignored");
    mockFetch({ access_token: "jwt-explicit" });
    const result = await resolveToken({ apiKey: "zid_sk_explicit" });
    expect(result.token).toBe("jwt-explicit");
    expect(result.exchanged).toBe(true);
  });
});

// ── D. fetchOAuthProvider ─────────────────────────────────────────────────────

describe("fetchOAuthProvider", () => {
  it("returns 'google' when the daemon reports provider=google", async () => {
    mockFetch({ provider: "google" });
    const result = await fetchOAuthProvider();
    expect(result).toBe("google");
  });

  it("returns null when the daemon reports provider=null", async () => {
    mockFetch({ provider: null });
    const result = await fetchOAuthProvider();
    expect(result).toBeNull();
  });

  it("returns null on a non-ok response (OAuth not configured → 404)", async () => {
    mockFetch({}, false, 404);
    const result = await fetchOAuthProvider();
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    (globalThis as { fetch: unknown }).fetch = async () => { throw new Error("network"); };
    const result = await fetchOAuthProvider();
    expect(result).toBeNull();
  });

  it("returns null for unknown provider names", async () => {
    mockFetch({ provider: "github" });
    const result = await fetchOAuthProvider();
    expect(result).toBeNull();
  });
});

// ── E. localStorage helpers ───────────────────────────────────────────────────

describe("localStorage helpers", () => {
  it("rememberApiKey persists the key for rememberedApiKey", () => {
    rememberApiKey("zid_sk_abc");
    expect(rememberedApiKey()).toBe("zid_sk_abc");
  });

  it("rememberedOAuthToken reads the OAuth token from localStorage", () => {
    store.set("codeoid.token", "rs256-token-xyz");
    expect(rememberedOAuthToken()).toBe("rs256-token-xyz");
  });

  it("rememberedOAuthToken returns null when no OAuth token is stored", () => {
    expect(rememberedOAuthToken()).toBeNull();
  });

  it("forgetApiKey clears both the API key and the OAuth token", () => {
    rememberApiKey("zid_sk_toforget");
    store.set("codeoid.token", "oauth-token");
    forgetApiKey();
    expect(rememberedApiKey()).toBeNull();
    expect(rememberedOAuthToken()).toBeNull();
  });
});

// ── F. AuthError shape ────────────────────────────────────────────────────────

describe("AuthError", () => {
  it("carries the kind discriminant and extends Error", () => {
    const err = new AuthError("test", "missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("missing");
    expect(err.name).toBe("AuthError");
    expect(err.message).toBe("test");
  });
});

// ── G. Embedded-handoff token (Studio → codeoid iframe) ───────────────────────

/** A framed window whose hash carries the handed-off token. */
function fakeWin(hash: string, framed = true) {
  const replaced: string[] = [];
  const win = {
    parent: {} as unknown, // distinct object → framed
    location: { hash, pathname: "/ui/", search: "" },
    history: {
      replaceState: (_d: unknown, _u: string, url: string) => replaced.push(url),
    },
  };
  if (!framed) win.parent = win; // parent === self → top-level
  return { win, replaced };
}

describe("consumeEmbedToken", () => {
  it("stores the hash token in the OAuth slot and scrubs the URL when framed", () => {
    const { win, replaced } = fakeWin("#codeoid_token=jwt-abc");
    expect(consumeEmbedToken(win)).toBe(true);
    // resolveToken now finds it via the OAuth-token fallback.
    expect(rememberedOAuthToken()).toBe("jwt-abc");
    expect(replaced).toEqual(["/ui/"]); // token scrubbed from the address bar
  });

  it("resolveToken picks up the token consumed from the hash", async () => {
    consumeEmbedToken(fakeWin("#codeoid_token=jwt-xyz").win);
    const res = await resolveToken({});
    expect(res).toEqual({ token: "jwt-xyz", exchanged: false });
  });

  it("preserves other hash state while removing only codeoid_token", () => {
    const { win, replaced } = fakeWin("#codeoid_token=jwt-abc&view=files");
    expect(consumeEmbedToken(win)).toBe(true);
    expect(replaced).toEqual(["/ui/#view=files"]);
  });

  it("does nothing at the top level (never consume outside the embed path)", () => {
    const { win } = fakeWin("#codeoid_token=jwt-abc", /* framed */ false);
    expect(consumeEmbedToken(win)).toBe(false);
    expect(rememberedOAuthToken()).toBeNull();
  });

  it("is a no-op when the hash carries no token", () => {
    const { win, replaced } = fakeWin("#view=files");
    expect(consumeEmbedToken(win)).toBe(false);
    expect(rememberedOAuthToken()).toBeNull();
    expect(replaced).toEqual([]);
  });
});

// ── F. Local mode (no ZeroID) ────────────────────────────────────────────────

describe("readLocalModeToken + local-mode precedence", () => {
  const W = globalThis as { window?: unknown };
  let savedWindow: unknown;

  beforeEach(() => {
    savedWindow = W.window;
    W.window = {};
  });
  afterEach(() => {
    if (savedWindow === undefined) delete W.window;
    else W.window = savedWindow;
  });

  function injectLocalToken(token: string): void {
    (W.window as { __CODEOID_LOCAL_TOKEN__?: string }).__CODEOID_LOCAL_TOKEN__ = token;
  }

  it("returns null when the daemon injected nothing (ZeroID mode)", () => {
    expect(readLocalModeToken()).toBeNull();
  });

  it("ignores a non-string or empty global", () => {
    (W.window as { __CODEOID_LOCAL_TOKEN__?: unknown }).__CODEOID_LOCAL_TOKEN__ = 42;
    expect(readLocalModeToken()).toBeNull();
    (W.window as { __CODEOID_LOCAL_TOKEN__?: unknown }).__CODEOID_LOCAL_TOKEN__ = "";
    expect(readLocalModeToken()).toBeNull();
  });

  it("reads the injected token", () => {
    injectLocalToken("codeoid_local_abc");
    expect(readLocalModeToken()).toBe("codeoid_local_abc");
  });

  it("BEATS a stored ZeroID key — the daemon's posture is authoritative", async () => {
    // Without this precedence the stored key would exchange successfully at
    // ZeroID and then be rejected on the daemon handshake, dumping the user at
    // a sign-in screen on a daemon that needs no sign-in.
    rememberApiKey("zid_sk_stale");
    injectLocalToken("codeoid_local_wins");
    mockFetch({ access_token: "should-not-be-used" });

    const result = await resolveToken({});
    expect(result.token).toBe("codeoid_local_wins");
    expect(result.exchanged).toBe(false);
  });

  it("yields to an explicitly supplied token (embed handoff)", async () => {
    injectLocalToken("codeoid_local_abc");
    const result = await resolveToken({ token: "explicit-jwt" });
    expect(result.token).toBe("explicit-jwt");
  });

  it("accepts a hand-pasted local token verbatim, with no exchange", async () => {
    // The manual path for a --local daemon on a non-loopback bind, where the
    // token is deliberately NOT injected into the page.
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error("must not attempt a token exchange");
    };
    const result = await resolveToken({ apiKey: "codeoid_local_pasted" });
    expect(result.token).toBe("codeoid_local_pasted");
    expect(result.exchanged).toBe(false);
  });

  it("still rejects a credential that is neither a ZeroID key nor a local token", async () => {
    await expect(resolveToken({ apiKey: "garbage_key" })).rejects.toThrow(AuthError);
    await expect(resolveToken({ apiKey: "garbage_key" })).rejects.toThrow(/codeoid_local_/);
  });
});
