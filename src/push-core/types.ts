/**
 * push-core — the shared APNs/FCM sending core.
 *
 * This module is dependency-light on purpose (only node:crypto / node:http2 /
 * fetch, no daemon imports) so BOTH delivery modes reuse it with zero
 * duplication of the credential-bearing, protocol-heavy sending logic:
 *
 *   - EMBEDDED  (daemon `transport: "native"`): the daemon holds the creds and
 *     calls `PushSender` directly.
 *   - RELAY     (daemon `transport: "relay"`): the daemon POSTs a content-blind
 *     wake-up to a standalone relay service, which calls the SAME `PushSender`.
 *
 * Content-blindness holds either way: a `PushMessage` carries only an opaque
 * session id + a kind — never a tool name, args, or description.
 */

export type Platform = "ios" | "android";

/** A device to deliver to (opaque native APNs/FCM token + its platform). */
export interface Device {
  token: string;
  platform: Platform;
}

/** The content-blind payload — opaque ids only. */
export interface PushMessage {
  sessionId: string;
  kind: "approval";
}

/** Apple Push Notification service credentials (token-based auth, a `.p8` key). */
export interface ApnsCreds {
  /** The `.p8` key id (10 chars) from the Apple Developer portal. */
  keyId: string;
  /** The Apple Developer Team id (10 chars). */
  teamId: string;
  /** The app bundle id — becomes the `apns-topic`. */
  bundleId: string;
  /** PEM contents of the `.p8` private key (`-----BEGIN PRIVATE KEY-----…`). */
  p8: string;
  /** Send to the APNs sandbox host (development builds). Default false (production). */
  sandbox?: boolean;
}

/** Firebase Cloud Messaging v1 credentials (a service account). */
export interface FcmCreds {
  projectId: string;
  clientEmail: string;
  /** PEM contents of the service-account private key. */
  privateKey: string;
}

/** Per-token delivery result. `unregistered` means the caller should prune it. */
export interface PushResult {
  token: string;
  ok: boolean;
  /** The token is dead (uninstalled / rotated) — delete it from the registry. */
  unregistered?: boolean;
  error?: string;
}

/** A per-platform delivery channel — implemented by ApnsClient / FcmClient, and
 *  trivially fakeable in tests. */
export interface PushChannel {
  send(device: Device, msg: PushMessage): Promise<PushResult>;
  close?(): void;
}

/** Content-blind alert copy, shared by both channels — no session content. */
export const ALERT_TITLE = "codeoid";
export const ALERT_BODY = "A session needs your approval";
