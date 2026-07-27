/**
 * FCM v1 channel — a service-account JWT exchanged for a short-lived OAuth
 * access token (cached), then a REST POST per message. Content-blind: generic
 * `notification` copy + opaque `data` (sessionId, kind).
 *
 * `send()` never throws — it resolves a `PushResult`.
 */
import { signRs256 } from "./jwt.js";
import { ALERT_BODY, ALERT_TITLE, type Device, type FcmCreds, type PushMessage, type PushChannel, type PushResult } from "./types.js";

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const SEND_TIMEOUT_MS = 10_000;

/** The content-blind FCM v1 message body for an approval wake-up. */
export function fcmMessageBody(token: string, msg: PushMessage): string {
  return JSON.stringify({
    message: {
      token,
      notification: { title: ALERT_TITLE, body: ALERT_BODY },
      // Opaque routing data only — no session content.
      data: { sessionId: msg.sessionId, kind: msg.kind },
      android: { priority: "high" },
    },
  });
}

/** Pure classification of an FCM error response — unit-tested without a network. */
export function classifyFcmError(status: number, body: string): { unregistered: boolean; reason: string } {
  let reason = "";
  try {
    reason = (JSON.parse(body) as { error?: { status?: string } }).error?.status ?? "";
  } catch {
    // non-JSON — fall through
  }
  // A dead FCM token surfaces as 404 NOT_FOUND or an UNREGISTERED status.
  const unregistered = status === 404 || reason === "UNREGISTERED" || reason === "NOT_FOUND";
  return { unregistered, reason: reason || `HTTP ${status}` };
}

export class FcmClient implements PushChannel {
  readonly #creds: FcmCreds;
  #accessToken = "";
  #expiresAt = 0;

  constructor(creds: FcmCreds) {
    this.#creds = creds;
  }

  async #getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.#accessToken && now < this.#expiresAt - 60) return this.#accessToken;
    const jwt = signRs256(
      {
        iss: this.#creds.clientEmail,
        scope: OAUTH_SCOPE,
        aud: OAUTH_URL,
        iat: now,
        exp: now + 3600,
      },
      this.#creds.privateKey,
    );
    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FCM OAuth ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("FCM OAuth: no access_token");
    this.#accessToken = body.access_token;
    this.#expiresAt = now + (body.expires_in ?? 3600);
    return this.#accessToken;
  }

  async send(device: Device, msg: PushMessage): Promise<PushResult> {
    try {
      const accessToken = await this.#getAccessToken();
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.#creds.projectId}/messages:send`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: fcmMessageBody(device.token, msg),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
      if (res.ok) return { token: device.token, ok: true };
      const c = classifyFcmError(res.status, await res.text().catch(() => ""));
      return { token: device.token, ok: false, unregistered: c.unregistered, error: c.reason };
    } catch (err) {
      return { token: device.token, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
