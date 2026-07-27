/**
 * Push service: resolves a blocked session's owner to their registered devices
 * and delivers a content-blind wake-up through the configured transport.
 *
 * Routing key is the owner's ZeroID identity (`sub` == `sessions.created_by`),
 * tenant-scoped by account/project — so only the human who owns the session is
 * alerted, and never across tenants.
 */
import { createPushSender, type ApnsCreds, type FcmCreds } from "../../push-core/index.js";
import type { Store } from "../store.js";
import { ExpoPushTransport } from "./expo.js";
import { NativePushTransport } from "./native.js";
import { RelayPushTransport } from "./relay.js";
import type { PushNotification, PushTransport } from "./types.js";

/** Config shape this module needs (a subset of CodeoidConfig["push"]). */
export interface PushConfig {
  transport: "expo" | "native" | "relay" | "none";
  expoAccessToken?: string;
  /** Embedded (native) mode — APNs/FCM creds the daemon sends with directly. */
  apns?: ApnsCreds;
  fcm?: FcmCreds;
  /** Relay mode — where to POST content-blind wake-ups (no creds in the daemon). */
  relayUrl?: string;
  relayToken?: string;
}

const noopTransport: PushTransport = {
  name: "none",
  async send() {},
};

/**
 * Build the transport for the daemon's push config. `onUnregistered` is invoked
 * with dead device tokens (native mode) so the caller can prune the registry.
 */
export function createPushTransport(
  config: PushConfig | undefined,
  onUnregistered?: (token: string) => void,
): PushTransport {
  if (!config) return noopTransport;
  switch (config.transport) {
    case "expo":
      return new ExpoPushTransport(config.expoAccessToken);
    case "native":
      return new NativePushTransport(
        createPushSender({ apns: config.apns, fcm: config.fcm }),
        onUnregistered,
      );
    case "relay":
      if (!config.relayUrl || !config.relayToken) {
        console.error("[codeoid/push] transport=relay needs relayUrl + relayToken; push disabled");
        return noopTransport;
      }
      return new RelayPushTransport(config.relayUrl, config.relayToken);
    default:
      return noopTransport;
  }
}

/** Owner identity + tenant of a session — the push routing key. */
export interface SessionOwner {
  sub: string;
  accountId: string;
  projectId: string;
}

export class PushService {
  /** False for the noop transport, so callers can skip the store lookup entirely. */
  readonly enabled: boolean;

  constructor(
    private readonly store: Store,
    private readonly transport: PushTransport,
  ) {
    this.enabled = transport.name !== "none";
  }

  /**
   * Deliver a content-blind "a session needs your approval" wake-up to the
   * owner's devices. Best-effort — the transport swallows delivery failures;
   * this wraps the store lookup so a DB hiccup can't escape onto the caller's
   * status-change path either.
   */
  async notifyApproval(sessionId: string, owner: SessionOwner): Promise<void> {
    if (!this.enabled) return;
    let targets: Array<{ token: string; platform: "ios" | "android" }>;
    try {
      targets = this.store.listPushForOwner(owner.sub, owner.accountId, owner.projectId);
    } catch (err) {
      console.error("[codeoid/push] registration lookup failed:", err);
      return;
    }
    if (targets.length === 0) return;
    const note: PushNotification = { sessionId, kind: "approval" };
    await this.transport.send(targets, note);
  }
}
