// @vitest-environment jsdom
/**
 * URL-hash credential handoff tests — consumeHandoffCredential.
 *
 * The handoff is guarded by a fail-closed trusted-framing-origin gate: a
 * hash-delivered credential is consumed ONLY when the page is embedded by an
 * allowlisted parent origin. The suite is split in two:
 *
 *   1. "trusted-framing-origin gate" — the gate itself: not framed → ignored;
 *      framed by an allowlisted origin → consumed; framed by a non-allowlisted
 *      origin → ignored; `ancestorOrigins` absent (Firefox) → ignored
 *      (fail-closed); empty allowlist → ignored.
 *
 *   2. Everything else runs UNDER a passing gate (framed by ALLOWED, with the
 *      allowlist supplied) and covers the hash-parsing/persist/strip behavior:
 *        A. token case   — #codeoid_token=<JWT> persists to codeoid.token
 *        B. key case     — #codeoid_key=<zid_sk_...> persists to codeoid.apiKey
 *        C. both at once — token + key handed together
 *        D. empty/malformed — no hash, empty value, unknown params, non-throwing
 *        E. hash-stripping — the credential is removed from the URL on consume
 *        F. other-hash-preserved — unrelated hash content survives the strip
 *        G. value handling — URL-encoded values are decoded; whitespace trimmed
 */

import { describe, it, expect, beforeEach } from "vitest";
import { consumeHandoffCredential, readEmbedAllowedOrigins } from "./handoff";
import { STORAGE_KEY_API_KEY, STORAGE_KEY_REFRESH_TOKEN, STORAGE_KEY_TOKEN } from "./auth";

const ALLOWED = "https://studio.highflame.com";
const OTHER = "https://evil.example.com";
const ALLOWLIST = [ALLOWED];

/** Reset URL + storage before each test so cases don't leak into each other. */
function setHash(hash: string): void {
  history.replaceState(null, "", `/ui/${hash}`);
}

/** Simulate being EMBEDDED by `origin` (framed + browser-set ancestorOrigins). */
function frameAs(origin: string): void {
  Object.defineProperty(window, "top", { configurable: true, value: {} as Window });
  Object.defineProperty(window.location, "ancestorOrigins", {
    configurable: true,
    value: [origin],
  });
}

/** Simulate a TOP-LEVEL page (not embedded): window.top === window.self. */
function notFramed(): void {
  Object.defineProperty(window, "top", { configurable: true, value: window });
  Object.defineProperty(window.location, "ancestorOrigins", {
    configurable: true,
    value: undefined,
  });
}

/** Simulate being framed but WITHOUT ancestorOrigins (e.g. Firefox). */
function frameWithoutAncestorOrigins(): void {
  Object.defineProperty(window, "top", { configurable: true, value: {} as Window });
  Object.defineProperty(window.location, "ancestorOrigins", {
    configurable: true,
    value: undefined,
  });
}

/** Consume under the default passing-gate allowlist. */
function consume() {
  return consumeHandoffCredential({ allowedOrigins: ALLOWLIST });
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/ui/");
  delete window.__CODEOID_EMBED_ORIGINS__;
  // Default: embedded by the allowlisted origin so the gate passes and the
  // hash-parsing tests exercise consume/persist/strip. Gate tests override this.
  frameAs(ALLOWED);
});

// ── Trusted-framing-origin gate (login-CSRF / session-fixation defense) ────────

describe("consumeHandoffCredential — trusted-framing-origin gate", () => {
  it("ignores a hash credential on a TOP-LEVEL page (not framed)", () => {
    notFramed();
    setHash("#codeoid_token=attacker-jwt");
    const result = consumeHandoffCredential({ allowedOrigins: ALLOWLIST });

    // The login-CSRF core case: nothing consumed, nothing persisted, URL left
    // untouched (the unconsumed hash is harmless — never sent to a server).
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    expect(window.location.hash).toBe("#codeoid_token=attacker-jwt");
  });

  it("consumes when framed by an allowlisted origin", () => {
    frameAs(ALLOWED);
    setHash("#codeoid_token=trusted-jwt");
    const result = consumeHandoffCredential({ allowedOrigins: ALLOWLIST });

    expect(result).toEqual({ token: "trusted-jwt" });
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("trusted-jwt");
    expect(window.location.hash).toBe("");
  });

  it("matches the framing origin case-insensitively", () => {
    frameAs("HTTPS://Studio.Highflame.com");
    setHash("#codeoid_token=trusted-jwt");
    const result = consumeHandoffCredential({ allowedOrigins: ALLOWLIST });

    expect(result).toEqual({ token: "trusted-jwt" });
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("trusted-jwt");
  });

  it("ignores a hash credential when framed by a NON-allowlisted origin", () => {
    frameAs(OTHER);
    setHash("#codeoid_token=attacker-jwt");
    const result = consumeHandoffCredential({ allowedOrigins: ALLOWLIST });

    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    // Untrusted framing → never even strips the hash.
    expect(window.location.hash).toBe("#codeoid_token=attacker-jwt");
  });

  it("fails CLOSED when ancestorOrigins is absent (e.g. Firefox)", () => {
    frameWithoutAncestorOrigins();
    setHash("#codeoid_token=attacker-jwt");
    const result = consumeHandoffCredential({ allowedOrigins: ALLOWLIST });

    // No verifiable framing origin ⇒ ignore (do NOT trust document.referrer).
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
  });

  it("ignores a hash credential when the allowlist is empty", () => {
    frameAs(ALLOWED);
    setHash("#codeoid_token=trusted-jwt");
    const result = consumeHandoffCredential({ allowedOrigins: [] });

    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
  });

  it("ignores a hash credential when no options are supplied (no allowlist)", () => {
    frameAs(ALLOWED);
    setHash("#codeoid_token=trusted-jwt");
    const result = consumeHandoffCredential();

    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
  });

  it("does not clobber an existing stored credential on a failing gate", () => {
    // A valid remembered session must survive an ungated (attacker) hash.
    localStorage.setItem(STORAGE_KEY_TOKEN, "existing-good-token");
    notFramed();
    setHash("#codeoid_token=attacker-jwt");
    const result = consumeHandoffCredential({ allowedOrigins: ALLOWLIST });

    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("existing-good-token");
  });
});

// ── readEmbedAllowedOrigins ────────────────────────────────────────────────────

describe("readEmbedAllowedOrigins", () => {
  it("returns [] when the daemon published nothing (fail closed)", () => {
    delete window.__CODEOID_EMBED_ORIGINS__;
    expect(readEmbedAllowedOrigins()).toEqual([]);
  });

  it("returns the published string origins", () => {
    window.__CODEOID_EMBED_ORIGINS__ = [ALLOWED, OTHER];
    expect(readEmbedAllowedOrigins()).toEqual([ALLOWED, OTHER]);
  });

  it("returns [] for a malformed (non-array) global and drops non-strings", () => {
    window.__CODEOID_EMBED_ORIGINS__ = "not-an-array";
    expect(readEmbedAllowedOrigins()).toEqual([]);

    window.__CODEOID_EMBED_ORIGINS__ = [ALLOWED, 42, "", "  "];
    expect(readEmbedAllowedOrigins()).toEqual([ALLOWED]);
  });

  it("end-to-end: a published allowlist gates a real consume", () => {
    window.__CODEOID_EMBED_ORIGINS__ = [ALLOWED];
    frameAs(ALLOWED);
    setHash("#codeoid_token=trusted-jwt");
    const result = consumeHandoffCredential({
      allowedOrigins: readEmbedAllowedOrigins(),
    });
    expect(result).toEqual({ token: "trusted-jwt" });
  });
});

// ── A. token case ─────────────────────────────────────────────────────────────

describe("consumeHandoffCredential — token", () => {
  it("reads #codeoid_token, persists it, and strips the hash", () => {
    setHash("#codeoid_token=jwt-abc");
    const result = consume();

    expect(result).toEqual({ token: "jwt-abc" });
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("jwt-abc");
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

// ── B. key case ───────────────────────────────────────────────────────────────

describe("consumeHandoffCredential — api key", () => {
  it("reads #codeoid_key, persists it, and strips the hash", () => {
    setHash("#codeoid_key=zid_sk_xyz");
    const result = consume();

    expect(result).toEqual({ apiKey: "zid_sk_xyz" });
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBe("zid_sk_xyz");
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

// ── C. both at once ───────────────────────────────────────────────────────────

describe("consumeHandoffCredential — token + key together", () => {
  it("consumes both and strips both", () => {
    setHash("#codeoid_token=jwt-1&codeoid_key=zid_sk_2");
    const result = consume();

    expect(result).toEqual({ token: "jwt-1", apiKey: "zid_sk_2" });
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("jwt-1");
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBe("zid_sk_2");
    expect(window.location.hash).toBe("");
  });
});

// ── Refresh token handoff (self-reliant embed session) ─────────────────────────

describe("consumeHandoffCredential — refresh token", () => {
  it("reads #codeoid_refresh alongside the access token, persists both, strips both", () => {
    setHash("#codeoid_token=jwt-9&codeoid_refresh=zid_rt_r9");
    const result = consume();

    expect(result).toEqual({ token: "jwt-9", refreshToken: "zid_rt_r9" });
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBe("jwt-9");
    expect(localStorage.getItem(STORAGE_KEY_REFRESH_TOKEN)).toBe("zid_rt_r9");
    expect(window.location.hash).toBe("");
  });
});

// ── D. empty / malformed ──────────────────────────────────────────────────────

describe("consumeHandoffCredential — empty / malformed", () => {
  it("returns {} and writes nothing when there is no hash", () => {
    const result = consume();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBeNull();
  });

  it("treats an empty credential value as absent (but still strips it)", () => {
    setHash("#codeoid_token=");
    const result = consume();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    // The empty handoff param is still removed from the URL.
    expect(window.location.hash).toBe("");
  });

  it("ignores unknown hash params and leaves the URL untouched", () => {
    setHash("#some_other=value&foo=bar");
    const result = consume();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY_API_KEY)).toBeNull();
    // Unknown content is preserved verbatim (no known param → no rewrite).
    expect(window.location.hash).toBe("#some_other=value&foo=bar");
  });

  it("ignores a bare anchor-style hash with no params", () => {
    setHash("#section-2");
    const result = consume();
    expect(result).toEqual({});
    expect(window.location.hash).toBe("#section-2");
  });

  it("does not throw on a malformed percent-encoding", () => {
    setHash("#codeoid_token=%E0%A4%A"); // truncated escape → decode would throw
    let result: ReturnType<typeof consumeHandoffCredential>;
    expect(() => {
      result = consume();
    }).not.toThrow();
    // safeDecode falls back to the raw value, which is non-empty here.
    expect(result!.token).toBe("%E0%A4%A");
  });
});

// ── E. hash stripping ─────────────────────────────────────────────────────────

describe("consumeHandoffCredential — hash stripping", () => {
  it("leaves no trace of the credential in the URL after consuming", () => {
    setHash("#codeoid_token=super-secret-jwt");
    consume();
    expect(window.location.href).not.toContain("super-secret-jwt");
    expect(window.location.hash).toBe("");
  });
});

// ── F. other hash content preserved ───────────────────────────────────────────

describe("consumeHandoffCredential — preserves other hash content", () => {
  it("strips only the handoff params, keeping unrelated hash params", () => {
    setHash("#codeoid_token=jwt-x&view=settings&tab=providers");
    const result = consume();

    expect(result).toEqual({ token: "jwt-x" });
    expect(window.location.hash).toBe("#view=settings&tab=providers");
  });

  it("preserves other content when it precedes the handoff param", () => {
    setHash("#view=settings&codeoid_key=zid_sk_9");
    const result = consume();

    expect(result).toEqual({ apiKey: "zid_sk_9" });
    expect(window.location.hash).toBe("#view=settings");
  });
});

// ── G. value handling ─────────────────────────────────────────────────────────

describe("consumeHandoffCredential — value handling", () => {
  it("URL-decodes the credential value", () => {
    setHash(`#codeoid_key=${encodeURIComponent("zid_sk_a b")}`);
    const result = consume();
    expect(result.apiKey).toBe("zid_sk_a b");
  });

  it("trims surrounding whitespace and treats whitespace-only as empty", () => {
    setHash(`#codeoid_token=${encodeURIComponent("   ")}`);
    const result = consume();
    expect(result).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY_TOKEN)).toBeNull();
  });
});
