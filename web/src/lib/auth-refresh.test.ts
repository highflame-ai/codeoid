// @vitest-environment jsdom
/**
 * Tests for the self-reliant refresh primitives in auth.ts:
 *   - jwtExpiryMs / jwtAudience (unverified payload decode)
 *   - refreshAccessToken (grant_type=refresh_token rotation)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  jwtAudience,
  jwtExpiryMs,
  refreshAccessToken,
  rememberedOAuthToken,
  rememberedRefreshToken,
  STORAGE_KEY_REFRESH_TOKEN,
  STORAGE_KEY_TOKEN,
} from "./auth";

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/=+$/, "");
  return `header.${b64}.sig`;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jwtExpiryMs / jwtAudience", () => {
  it("decodes exp (seconds → ms) and aud (array or string)", () => {
    const t = makeJwt({ exp: 1_900_000_000, aud: ["codeoid"] });
    expect(jwtExpiryMs(t)).toBe(1_900_000_000 * 1000);
    expect(jwtAudience(t)).toBe("codeoid");

    expect(jwtAudience(makeJwt({ aud: "agent-sandbox" }))).toBe("agent-sandbox");
  });

  it("returns null on malformed / missing claims (never throws)", () => {
    expect(jwtExpiryMs("not-a-jwt")).toBeNull();
    expect(jwtExpiryMs(makeJwt({}))).toBeNull();
    expect(jwtAudience(makeJwt({}))).toBeNull();
    expect(jwtAudience("garbage")).toBeNull();
  });
});

describe("refreshAccessToken", () => {
  it("throws (missing) when there is no stored refresh token", async () => {
    await expect(refreshAccessToken({ zeroidUrl: "" })).rejects.toMatchObject({
      kind: "missing",
    });
  });

  it("rotates: persists the new access + refresh tokens and binds client_id to the aud", async () => {
    localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, "zid_rt_old");
    localStorage.setItem(STORAGE_KEY_TOKEN, makeJwt({ aud: ["codeoid"], exp: 1 }));

    const newAccess = makeJwt({ aud: ["codeoid"], exp: 2_000_000_000 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: newAccess, refresh_token: "zid_rt_new" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const returned = await refreshAccessToken({ zeroidUrl: "" });

    expect(returned).toBe(newAccess);
    expect(rememberedOAuthToken()).toBe(newAccess);
    // Rotation: the successor refresh token is persisted (single-use).
    expect(rememberedRefreshToken()).toBe("zid_rt_new");

    // The request used grant_type=refresh_token, the stored refresh token, and
    // client_id = the access token's aud (the ZeroID binding).
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/oauth2/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("zid_rt_old");
    expect(body.get("client_id")).toBe("codeoid");
  });

  it("forgets the refresh token on a 4xx (spent/revoked) so we don't loop", async () => {
    localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, "zid_rt_dead");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      ),
    );

    await expect(refreshAccessToken({ zeroidUrl: "" })).rejects.toMatchObject({
      kind: "exchange_failed",
    });
    expect(rememberedRefreshToken()).toBeNull();
  });

  it("keeps the refresh token on a network error (transient — retry later)", async () => {
    localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, "zid_rt_keep");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await expect(refreshAccessToken({ zeroidUrl: "" })).rejects.toMatchObject({
      kind: "exchange_failed",
    });
    // NOT forgotten — a transient failure must not brick the session.
    expect(rememberedRefreshToken()).toBe("zid_rt_keep");
  });
});
