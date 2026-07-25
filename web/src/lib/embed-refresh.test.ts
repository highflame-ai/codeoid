// @vitest-environment jsdom
/**
 * installEmbedSessionRefresh tests — the proactive self-refresh scheduler.
 *
 * The scheduler rotates the stored refresh token shortly before the access
 * token expires and forces a reconnect with the fresh token. We mock the
 * rotation call (auth.refreshAccessToken) and the reconnect (connection.
 * reconnectNow) and drive fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auth from "./auth";
import * as connection from "../state/connection";
import { installEmbedSessionRefresh } from "./embed-refresh";

const { STORAGE_KEY_TOKEN, STORAGE_KEY_REFRESH_TOKEN } = auth;

/** Build an unsigned JWT whose payload has the given `exp` (seconds). Only the
 * payload segment matters — jwtExpiryMs decodes it without verifying. */
function tokenExpiringInSeconds(secondsFromNow: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + secondsFromNow, aud: ["codeoid"] };
  const b64 = btoa(JSON.stringify(payload)).replace(/=+$/, "");
  return `header.${b64}.sig`;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("installEmbedSessionRefresh", () => {
  it("is a no-op (and returns a callable cleanup) when no refresh token is stored", () => {
    const spy = vi.spyOn(auth, "refreshAccessToken").mockResolvedValue("new-access");
    const cleanup = installEmbedSessionRefresh({ zeroidUrl: "" });

    vi.advanceTimersByTime(60 * 60_000);

    expect(spy).not.toHaveBeenCalled();
    expect(cleanup).toBeTypeOf("function");
    cleanup();
  });

  it("rotates the token near expiry and reconnects with the fresh one", async () => {
    localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, "zid_rt_abc");
    // Access token valid for 10 minutes → refresh scheduled ~8.75 min out
    // (10min - 75s skew).
    localStorage.setItem(STORAGE_KEY_TOKEN, tokenExpiringInSeconds(600));

    const refreshSpy = vi
      .spyOn(auth, "refreshAccessToken")
      .mockImplementation(async () => {
        // Simulate rotation: a fresh, longer-lived access token is persisted.
        localStorage.setItem(STORAGE_KEY_TOKEN, tokenExpiringInSeconds(600));
        localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, "zid_rt_next");
        return "new-access";
      });
    const reconnectSpy = vi.spyOn(connection, "reconnectNow").mockImplementation(() => {});

    const cleanup = installEmbedSessionRefresh({ zeroidUrl: "" });

    // Not yet due.
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(refreshSpy).not.toHaveBeenCalled();

    // Cross the (10min - 75s) boundary → rotation fires, then reconnect.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(reconnectSpy).toHaveBeenCalledOnce();

    cleanup();
  });

  it("stops scheduling once the refresh token is gone (rotation forgot a dead one)", async () => {
    localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, "zid_rt_dead");
    localStorage.setItem(STORAGE_KEY_TOKEN, tokenExpiringInSeconds(120));

    const refreshSpy = vi.spyOn(auth, "refreshAccessToken").mockImplementation(async () => {
      // Simulate a terminal failure: the dead refresh token is forgotten.
      localStorage.removeItem(STORAGE_KEY_REFRESH_TOKEN);
      throw new auth.AuthError("refresh token rejected (400)", "exchange_failed");
    });
    vi.spyOn(connection, "reconnectNow").mockImplementation(() => {});

    const cleanup = installEmbedSessionRefresh({ zeroidUrl: "" });

    // First rotation fires (120s - 75s ≈ 45s) and fails terminally.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSpy).toHaveBeenCalledOnce();

    // No token remains → no further rotation attempts, ever.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refreshSpy).toHaveBeenCalledOnce();

    cleanup();
  });

  it("cleanup cancels a pending rotation", async () => {
    localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, "zid_rt_abc");
    localStorage.setItem(STORAGE_KEY_TOKEN, tokenExpiringInSeconds(600));
    const refreshSpy = vi.spyOn(auth, "refreshAccessToken").mockResolvedValue("new-access");

    const cleanup = installEmbedSessionRefresh({ zeroidUrl: "" });
    cleanup();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
