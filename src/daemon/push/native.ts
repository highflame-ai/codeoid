/**
 * EMBEDDED mode (`transport: "native"`): the daemon holds the APNs/FCM creds
 * and delivers directly via push-core's PushSender — no third party, no relay.
 * The right fit when the daemon operator IS the app publisher (personal /
 * self-host-your-own-app). For multi-user / hosted, `RelayPushTransport` POSTs
 * to a relay that runs the SAME PushSender.
 *
 * Dead tokens reported by APNs/FCM are pruned via the `onUnregistered` hook so
 * the registry stays clean. Best-effort — never throws onto the status path.
 */
import type { PushResult, PushSender } from "../../push-core/index.js";
import type { PushNotification, PushTarget, PushTransport } from "./types.js";

export class NativePushTransport implements PushTransport {
  readonly name = "native";

  constructor(
    private readonly sender: PushSender,
    /** Called with a token APNs/FCM reports as dead, so the caller can prune it. */
    private readonly onUnregistered?: (token: string) => void,
  ) {}

  async send(targets: PushTarget[], note: PushNotification): Promise<void> {
    if (targets.length === 0) return;
    let results: PushResult[];
    try {
      results = await this.sender.send(
        targets.map((t) => ({ token: t.token, platform: t.platform })),
        { sessionId: note.sessionId, kind: note.kind },
      );
    } catch (err) {
      console.error("[codeoid/push] native send failed:", err);
      return;
    }
    for (const r of results) {
      if (r.unregistered) {
        this.onUnregistered?.(r.token);
      } else if (!r.ok) {
        console.error(`[codeoid/push] delivery failed (${r.token.slice(0, 8)}…): ${r.error}`);
      }
    }
  }
}
