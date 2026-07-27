/**
 * PushSender — routes a content-blind message to the right per-platform channel
 * (iOS→APNs, Android→FCM). The channels are injected so routing/fan-out is
 * unit-testable with fakes; `createPushSender` builds the real ones from creds.
 *
 * This is the single piece BOTH delivery modes share — the daemon's embedded
 * `NativePushTransport` and (later) the standalone relay both call it, so the
 * credential-bearing APNs/FCM logic lives exactly once.
 */
import { ApnsClient } from "./apns.js";
import { FcmClient } from "./fcm.js";
import type { ApnsCreds, Device, FcmCreds, PushChannel, PushMessage, PushResult } from "./types.js";

export class PushSender {
  readonly #ios?: PushChannel;
  readonly #android?: PushChannel;

  constructor(channels: { ios?: PushChannel; android?: PushChannel }) {
    this.#ios = channels.ios;
    this.#android = channels.android;
  }

  /** Deliver to every device; one PushResult per device (per-token feedback). */
  async send(devices: Device[], msg: PushMessage): Promise<PushResult[]> {
    return Promise.all(devices.map((d) => this.#one(d, msg)));
  }

  #one(device: Device, msg: PushMessage): Promise<PushResult> {
    const channel = device.platform === "ios" ? this.#ios : this.#android;
    if (!channel) {
      return Promise.resolve({
        token: device.token,
        ok: false,
        error: `no ${device.platform} channel configured`,
      });
    }
    return channel.send(device, msg);
  }

  close(): void {
    this.#ios?.close?.();
    this.#android?.close?.();
  }
}

/** Build a PushSender from raw credentials (a channel per configured platform). */
export function createPushSender(creds: { apns?: ApnsCreds; fcm?: FcmCreds }): PushSender {
  return new PushSender({
    ios: creds.apns ? new ApnsClient(creds.apns) : undefined,
    android: creds.fcm ? new FcmClient(creds.fcm) : undefined,
  });
}
