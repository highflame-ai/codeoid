/**
 * RELAY mode (`transport: "relay"`): POST a content-blind wake-up to a
 * standalone relay service that holds the APNs/FCM creds and does the actual
 * send (via the same push-core PushSender). In this mode the daemon holds NO
 * push credentials — only the relay URL + a shared bearer token.
 *
 * The relay service itself is a thin HTTP wrapper around push-core, added when
 * the multi-user / hosted path is needed; this transport is the daemon half of
 * that seam. Best-effort — never throws onto the status path.
 */
import type { PushNotification, PushTarget, PushTransport } from "./types.js";

const POST_TIMEOUT_MS = 10_000;

export class RelayPushTransport implements PushTransport {
  readonly name = "relay";

  constructor(
    private readonly relayUrl: string,
    private readonly relayToken: string,
  ) {}

  async send(targets: PushTarget[], note: PushNotification): Promise<void> {
    if (targets.length === 0) return;
    try {
      const res = await fetch(new URL("/push", this.relayUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.relayToken}`,
        },
        // Content-blind: opaque device tokens + { sessionId, kind }. The relay
        // never sees session content.
        body: JSON.stringify({ targets, note }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) console.error(`[codeoid/push] relay POST ${res.status}`);
    } catch (err) {
      console.error("[codeoid/push] relay POST error:", err);
    }
  }
}
