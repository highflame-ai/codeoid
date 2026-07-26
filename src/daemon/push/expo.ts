/**
 * Expo Push transport. Delivers via Expo's push service, which holds the
 * APNs/FCM credentials and relays to the OS — so a self-hosted daemon never
 * needs its own Apple/Google credentials for v1.
 *
 * CONTENT-BLIND: the alert copy is generic and `data` carries only the opaque
 * sessionId + kind, so Expo (a third party in the delivery path) never sees a
 * tool name, args, or description. The tradeoff Expo introduces — a third party
 * seeing device tokens + timing — is why the self-hosted relay is the eventual
 * end state; this transport keeps the payload content-blind so that migration
 * changes nothing about what's exposed.
 *
 * Best-effort: logs and swallows failures so a push outage can never wedge the
 * status-change path that fires it.
 */
import type { PushNotification, PushTarget, PushTransport } from "./types.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo accepts at most 100 messages per request. */
const BATCH_SIZE = 100;
const TIMEOUT_MS = 10_000;

export class ExpoPushTransport implements PushTransport {
  readonly name = "expo";

  constructor(private readonly accessToken?: string) {}

  async send(targets: PushTarget[], note: PushNotification): Promise<void> {
    if (targets.length === 0) return;
    const messages = targets.map((t) => ({
      to: t.token,
      title: "codeoid",
      body: "A session needs your approval",
      // Content-blind: opaque ids only. The app fetches real context over its
      // authenticated socket after the user taps.
      data: { sessionId: note.sessionId, kind: note.kind },
      priority: "high",
      // Collapse repeated pings for the same session on the device.
      threadId: note.sessionId,
    }));
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      await this.#post(messages.slice(i, i + BATCH_SIZE));
    }
  }

  async #post(batch: unknown[]): Promise<void> {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`[codeoid/push] Expo push HTTP ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error("[codeoid/push] Expo push error:", err);
    }
  }
}
