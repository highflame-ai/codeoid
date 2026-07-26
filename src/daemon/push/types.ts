/**
 * Push notification transport seam.
 *
 * The whole point of this abstraction is content-blindness + swappability: the
 * daemon hands a transport only opaque routing ids, so no session content ever
 * leaves the box regardless of which transport is configured. Expo Push is the
 * v1 transport (routes through Expo's service to APNs/FCM); a self-hosted
 * content-blind relay (APNs .p8 + FCM + iOS Notification Service Extension
 * poll-back) swaps in behind this same interface later — the migration is a
 * transport change, not a redesign.
 */
import type { PushPlatform } from "../../protocol/types.js";

/** A device to deliver to. */
export interface PushTarget {
  token: string;
  platform: PushPlatform;
}

/**
 * The CONTENT-BLIND payload a transport delivers. Deliberately carries only an
 * opaque session id + a kind — never a tool name, args, or description. The app
 * resolves human-readable context over its authenticated socket after the user
 * taps. Even when the transport is a third party (Expo), no session content
 * leaves the daemon.
 */
export interface PushNotification {
  /** Opaque session id the user should open. */
  sessionId: string;
  /** What happened. Only "approval" today (a session is blocked awaiting approval). */
  kind: "approval";
}

/**
 * Delivery seam. Implementations map the content-blind PushNotification to
 * their wire format and fan it out to the targets. Never throws — delivery is
 * best-effort and runs off the daemon's status-change hot path.
 */
export interface PushTransport {
  readonly name: string;
  send(targets: PushTarget[], note: PushNotification): Promise<void>;
}
