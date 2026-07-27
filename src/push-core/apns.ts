/**
 * APNs channel — token-based (`.p8`) auth over HTTP/2 (the only transport APNs
 * accepts). Content-blind: the alert copy is generic and the custom keys carry
 * only the opaque `sessionId` + `kind`.
 *
 * The provider JWT is signed once and reused (~50 min; APNs allows up to 60);
 * the HTTP/2 session is reused across sends and lazily re-established if it
 * drops. `send()` never throws — it resolves a `PushResult` so a delivery
 * failure can't escape onto the daemon's status path.
 */
import http2 from "node:http2";

import { signEs256 } from "./jwt.js";
import { ALERT_BODY, ALERT_TITLE, type ApnsCreds, type Device, type PushMessage, type PushChannel, type PushResult } from "./types.js";

const APNS_HOST_PROD = "https://api.push.apple.com";
const APNS_HOST_SANDBOX = "https://api.sandbox.push.apple.com";
const JWT_REUSE_SECONDS = 3000; // < 60 min, APNs's provider-token lifetime
const SEND_TIMEOUT_MS = 10_000;

/** Pure classification of an APNs response — unit-tested without a real socket. */
export function classifyApnsResponse(
  status: number,
  body: string,
): { ok: boolean; unregistered: boolean; reason: string } {
  if (status === 200) return { ok: true, unregistered: false, reason: "" };
  let reason = "";
  try {
    reason = (JSON.parse(body) as { reason?: string }).reason ?? "";
  } catch {
    // non-JSON error body — fall through with an empty reason
  }
  // 410 Gone, or BadDeviceToken / Unregistered = the token is dead, prune it.
  const unregistered = status === 410 || reason === "Unregistered" || reason === "BadDeviceToken";
  return { ok: false, unregistered, reason: reason || `HTTP ${status}` };
}

/** The content-blind APNs payload for an approval wake-up. */
export function apnsPayload(msg: PushMessage): string {
  return JSON.stringify({
    aps: { alert: { title: ALERT_TITLE, body: ALERT_BODY }, sound: "default" },
    // Opaque routing data only — no session content.
    sessionId: msg.sessionId,
    kind: msg.kind,
  });
}

export class ApnsClient implements PushChannel {
  readonly #creds: ApnsCreds;
  readonly #host: string;
  readonly #connect: typeof http2.connect;
  #jwt = "";
  #jwtIat = 0;
  #session: http2.ClientHttp2Session | null = null;

  /** `connect` is injectable so the HTTP/2 send path is unit-testable without
   *  a real APNs socket; it defaults to node:http2's connect. */
  constructor(creds: ApnsCreds, connect: typeof http2.connect = http2.connect) {
    this.#creds = creds;
    this.#host = creds.sandbox ? APNS_HOST_SANDBOX : APNS_HOST_PROD;
    this.#connect = connect;
  }

  #token(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.#jwt && now - this.#jwtIat < JWT_REUSE_SECONDS) return this.#jwt;
    this.#jwt = signEs256({ iss: this.#creds.teamId, iat: now }, this.#creds.keyId, this.#creds.p8);
    this.#jwtIat = now;
    return this.#jwt;
  }

  #getSession(): http2.ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const session = this.#connect(this.#host);
    // Swallow session-level errors; the next send lazily reconnects.
    session.on("error", () => {});
    this.#session = session;
    return session;
  }

  send(device: Device, msg: PushMessage): Promise<PushResult> {
    return new Promise<PushResult>((resolve) => {
      const done = (r: Omit<PushResult, "token">) => resolve({ token: device.token, ...r });
      let req: http2.ClientHttp2Stream;
      try {
        req = this.#getSession().request({
          [http2.constants.HTTP2_HEADER_METHOD]: "POST",
          [http2.constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
          authorization: `bearer ${this.#token()}`,
          "apns-topic": this.#creds.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
        });
      } catch (err) {
        done({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      let status = 0;
      let data = "";
      req.setEncoding("utf8");
      req.on("response", (h) => {
        status = Number(h[http2.constants.HTTP2_HEADER_STATUS]) || 0;
      });
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        const c = classifyApnsResponse(status, data);
        done({ ok: c.ok, unregistered: c.unregistered, error: c.ok ? undefined : c.reason });
      });
      req.on("error", (err) => done({ ok: false, error: err.message }));
      req.setTimeout(SEND_TIMEOUT_MS, () => {
        req.close();
        done({ ok: false, error: "timeout" });
      });
      req.end(apnsPayload(msg));
    });
  }

  close(): void {
    this.#session?.close();
    this.#session = null;
  }
}
