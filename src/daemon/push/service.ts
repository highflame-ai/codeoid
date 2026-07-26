/**
 * Push service: resolves a blocked session's owner to their registered devices
 * and delivers a content-blind wake-up through the configured transport.
 *
 * Routing key is the owner's ZeroID identity (`sub` == `sessions.created_by`),
 * tenant-scoped by account/project — so only the human who owns the session is
 * alerted, and never across tenants.
 */
import type { Store } from "../store.js";
import { ExpoPushTransport } from "./expo.js";
import type { PushNotification, PushTransport } from "./types.js";

/** Config shape this module needs (a subset of CodeoidConfig["push"]). */
export interface PushConfig {
  transport: "expo" | "none";
  expoAccessToken?: string;
}

const noopTransport: PushTransport = {
  name: "none",
  async send() {},
};

/** Build the transport for the daemon's push config. */
export function createPushTransport(config: PushConfig | undefined): PushTransport {
  if (!config || config.transport === "none") return noopTransport;
  if (config.transport === "expo") return new ExpoPushTransport(config.expoAccessToken);
  return noopTransport;
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
