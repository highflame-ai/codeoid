/**
 * Self-reliant embed session refresh.
 *
 * When an embedding host (Highflame Studio) hands off a rotating refresh token
 * alongside the access token, the codeoid web UI keeps its OWN session alive by
 * rotating that refresh token at ZeroID — no host re-mint on a timer, no
 * postMessage. This module owns the PROACTIVE half: a scheduler that rotates the
 * access token shortly before it expires and forces the live socket to
 * re-authenticate with the fresh token, so the session never blips.
 *
 * The REACTIVE half lives in state/connection.ts:
 *   - `freshAccessToken()` rotates on demand for any (re)connect, so a socket
 *     that drops (network blip, laptop waking past expiry) recovers on its own.
 *   - the `failed`-status handler rotates + re-bootstraps if the daemon ever
 *     closes 4003 before this scheduler fired.
 * Together they make an embedded session survive tab switches, reloads, and long
 * idle periods, bounded only by the refresh token's own TTL.
 *
 * A `setTimeout` is throttled/suspended while the tab is backgrounded, so we also
 * refresh on `visibilitychange`→visible when the scheduled time has passed.
 */

import {
  jwtExpiryMs,
  refreshAccessToken,
  rememberedOAuthToken,
  rememberedRefreshToken,
} from "./auth";
import { reconnectNow } from "../state/connection";

/** Rotate this many ms before the access token's `exp`, covering clock skew +
 * the round-trip so the fresh token is in place before the daemon closes 4003. */
const REFRESH_SKEW_MS = 75_000;
/** Never schedule sooner than this, so a token minted already near expiry (or a
 * refresh returning a short-lived token) can't spin a tight rotation loop. */
const MIN_DELAY_MS = 5_000;
/** Fallback cadence when the access token carries no readable `exp`. */
const FALLBACK_DELAY_MS = 10 * 60_000;

export interface EmbedSessionRefreshOptions {
  /** ZeroID base URL passed through to the rotation call. */
  zeroidUrl?: string;
}

/**
 * Start the proactive refresh scheduler. No-op (returns a no-op cleanup) when no
 * refresh token was handed off — i.e. this is not a self-refreshing embed
 * session (native sign-in, api-key flow, or an older host/ZeroID that didn't
 * issue one). Returns a cleanup function; call it on teardown.
 */
export function installEmbedSessionRefresh(
  opts: EmbedSessionRefreshOptions = {},
): () => void {
  if (typeof window === "undefined") return noop;
  if (!rememberedRefreshToken()) return noop;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** ms until we should next rotate, from the current stored access token. */
  function delayUntilRefresh(): number {
    const token = rememberedOAuthToken();
    const expMs = token ? jwtExpiryMs(token) : null;
    if (expMs === null) return FALLBACK_DELAY_MS;
    return Math.max(MIN_DELAY_MS, expMs - REFRESH_SKEW_MS - Date.now());
  }

  function schedule(): void {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    // If no refresh token remains (signed out, or a rotation forgot a dead one),
    // stop scheduling — nothing to rotate.
    if (!rememberedRefreshToken()) return;
    timer = setTimeout(runRefresh, delayUntilRefresh());
  }

  async function runRefresh(): Promise<void> {
    if (stopped) return;
    if (!rememberedRefreshToken()) return;
    try {
      await refreshAccessToken({ zeroidUrl: opts.zeroidUrl });
      // Apply the fresh token to the live socket before the daemon closes the
      // expiring one — a brief, seamless reconnect (scrollback replays).
      reconnectNow();
    } catch {
      // Rotation failed. If it was terminal (dead refresh token), refreshAccessToken
      // already forgot it, so the next schedule() bails and the connection layer's
      // failed-recovery / sign-in path takes over. If transient, the next reconnect
      // (freshAccessToken) will retry. Either way, reschedule to keep trying while a
      // token remains.
    }
    schedule();
  }

  function onVisible(): void {
    // Background tabs throttle/suspend timers; when we return to the foreground,
    // re-evaluate immediately (delayUntilRefresh clamps to MIN_DELAY so an
    // already-overdue token rotates right away rather than on the stale timer).
    if (document.visibilityState === "visible") schedule();
  }

  document.addEventListener("visibilitychange", onVisible);
  schedule();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function noop(): void {}
