/**
 * push-core — the shared APNs/FCM sender. The load-bearing property is
 * CONTENT-BLINDNESS: every payload carries only opaque ids + generic copy.
 * Crypto is verified against the public key; the APNs HTTP/2 send is driven
 * through an injected fake connect; FCM is driven through a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
import type http2 from "node:http2";
import {
  ApnsClient,
  apnsPayload,
  classifyApnsResponse,
  classifyFcmError,
  createPushSender,
  FcmClient,
  fcmMessageBody,
  PushSender,
  signEs256,
  signRs256,
  type PushChannel,
  type PushMessage,
} from "../push-core/index.js";

const MSG: PushMessage = { sessionId: "sess-opaque-123", kind: "approval" };

function ecPem(): string {
  return generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

// ── JWT ──────────────────────────────────────────────────────────────────────

describe("jwt", () => {
  test("ES256 (APNs .p8) signs a JWT that verifies against the public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const jwt = signEs256({ iss: "TEAM", iat: 1_700_000_000 }, "KEY10", privateKey);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY10" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "TEAM", iat: 1_700_000_000 });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    expect(ok).toBe(true);
  });

  test("RS256 (FCM service account) signs a JWT that verifies", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const jwt = signRs256({ iss: "sa@x.iam", iat: 1, exp: 2 }, privateKey);
    const [h, c, s] = jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

// ── APNs ─────────────────────────────────────────────────────────────────────

describe("APNs payload + response classification", () => {
  test("payload is content-blind — opaque ids + generic copy only", () => {
    const p = JSON.parse(apnsPayload(MSG));
    expect(p.aps.alert).toEqual({ title: "codeoid", body: "A session needs your approval" });
    expect(p.sessionId).toBe("sess-opaque-123");
    expect(p.kind).toBe("approval");
    expect(apnsPayload(MSG)).not.toContain("Bash");
  });

  test("classify 200 → ok", () => {
    expect(classifyApnsResponse(200, "")).toEqual({ ok: true, unregistered: false, reason: "" });
  });
  test("classify 410 Unregistered → unregistered", () => {
    expect(classifyApnsResponse(410, JSON.stringify({ reason: "Unregistered" }))).toEqual({
      ok: false,
      unregistered: true,
      reason: "Unregistered",
    });
  });
  test("classify BadDeviceToken → unregistered", () => {
    expect(classifyApnsResponse(400, JSON.stringify({ reason: "BadDeviceToken" })).unregistered).toBe(true);
  });
  test("classify other 4xx → failure, not unregistered", () => {
    const r = classifyApnsResponse(403, JSON.stringify({ reason: "ExpiredProviderToken" }));
    expect(r).toEqual({ ok: false, unregistered: false, reason: "ExpiredProviderToken" });
  });
  test("classify non-JSON body → HTTP status reason", () => {
    expect(classifyApnsResponse(503, "upstream boom").reason).toBe("HTTP 503");
  });
});

/** Minimal fake of node:http2 connect capturing the request headers + payload. */
function fakeHttp2(status: number, body = "") {
  const requests: Array<{ headers: Record<string, unknown>; payload: string }> = [];
  const connect = ((_authority: string) => {
    const session = new EventEmitter() as EventEmitter & Record<string, unknown>;
    session.closed = false;
    session.destroyed = false;
    session.close = () => {
      session.closed = true;
    };
    session.request = (headers: Record<string, unknown>) => {
      const stream = new EventEmitter() as EventEmitter & Record<string, unknown>;
      stream.setEncoding = () => {};
      stream.setTimeout = () => {};
      stream.close = () => {};
      stream.end = (payload: string) => {
        requests.push({ headers, payload });
        queueMicrotask(() => {
          stream.emit("response", { ":status": status });
          if (body) stream.emit("data", body);
          stream.emit("end");
        });
      };
      return stream;
    };
    return session;
  }) as unknown as typeof http2.connect;
  return { connect, requests };
}

describe("ApnsClient.send (injected HTTP/2)", () => {
  test("success — content-blind headers + payload", async () => {
    const { connect, requests } = fakeHttp2(200);
    const client = new ApnsClient(
      { keyId: "K", teamId: "T", bundleId: "ai.codeoid.mobile", p8: ecPem() },
      connect,
    );
    const res = await client.send({ token: "devtok", platform: "ios" }, MSG);
    expect(res).toEqual({ token: "devtok", ok: true, unregistered: false, error: undefined });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.headers[":path"]).toBe("/3/device/devtok");
    expect(req.headers["apns-topic"]).toBe("ai.codeoid.mobile");
    expect(req.headers["apns-push-type"]).toBe("alert");
    expect(String(req.headers.authorization)).toMatch(/^bearer /);
    expect(JSON.parse(req.payload).sessionId).toBe("sess-opaque-123");
  });

  test("410 → ok:false, unregistered:true", async () => {
    const { connect } = fakeHttp2(410, JSON.stringify({ reason: "Unregistered" }));
    const client = new ApnsClient({ keyId: "K", teamId: "T", bundleId: "b", p8: ecPem() }, connect);
    const res = await client.send({ token: "dead", platform: "ios" }, MSG);
    expect(res.ok).toBe(false);
    expect(res.unregistered).toBe(true);
  });

  test("reuses the session across sends (one connect for two)", async () => {
    let connects = 0;
    const { connect } = fakeHttp2(200);
    const counting = ((authority: string) => {
      connects++;
      return connect(authority);
    }) as unknown as typeof http2.connect;
    const client = new ApnsClient({ keyId: "K", teamId: "T", bundleId: "b", p8: ecPem() }, counting);
    await client.send({ token: "a", platform: "ios" }, MSG);
    await client.send({ token: "b", platform: "ios" }, MSG);
    expect(connects).toBe(1);
    client.close();
  });
});

// ── FCM ──────────────────────────────────────────────────────────────────────

describe("FCM", () => {
  let origFetch: typeof fetch;
  let calls: Array<{ url: string; init: RequestInit }>;
  const creds = {
    projectId: "proj",
    clientEmail: "sa@x.iam",
    privateKey: generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
  };

  beforeEach(() => {
    calls = [];
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function mock(handler: (url: string) => Response) {
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return handler(String(url));
    }) as unknown as typeof fetch;
  }
  const oauthOk = (url: string) =>
    url.includes("oauth2")
      ? new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 })
      : new Response("{}", { status: 200 });

  test("message body is content-blind", () => {
    const b = JSON.parse(fcmMessageBody("tok", MSG));
    expect(b.message.token).toBe("tok");
    expect(b.message.data).toEqual({ sessionId: "sess-opaque-123", kind: "approval" });
    expect(b.message.notification).toEqual({ title: "codeoid", body: "A session needs your approval" });
    expect(fcmMessageBody("tok", MSG)).not.toContain("Bash");
  });

  test("classifyFcmError: 404 / UNREGISTERED / NOT_FOUND → unregistered", () => {
    expect(classifyFcmError(404, "").unregistered).toBe(true);
    expect(classifyFcmError(400, JSON.stringify({ error: { status: "UNREGISTERED" } })).unregistered).toBe(true);
    expect(classifyFcmError(500, JSON.stringify({ error: { status: "INTERNAL" } })).unregistered).toBe(false);
  });

  test("send: OAuth then POST with Bearer + content-blind body", async () => {
    mock(oauthOk);
    const res = await new FcmClient(creds).send({ token: "tok", platform: "android" }, MSG);
    expect(res).toEqual({ token: "tok", ok: true });
    const send = calls.find((c) => c.url.includes("messages:send"));
    expect((send?.init.headers as Record<string, string>).authorization).toBe("Bearer AT");
    expect(JSON.parse(send?.init.body as string).message.data.sessionId).toBe("sess-opaque-123");
  });

  test("send: caches the access token (one OAuth for two sends)", async () => {
    mock(oauthOk);
    const client = new FcmClient(creds);
    await client.send({ token: "a", platform: "android" }, MSG);
    await client.send({ token: "b", platform: "android" }, MSG);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });

  test("send: 404 → unregistered", async () => {
    mock((url) =>
      url.includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 })
        : new Response("{}", { status: 404 }),
    );
    const res = await new FcmClient(creds).send({ token: "dead", platform: "android" }, MSG);
    expect(res.ok).toBe(false);
    expect(res.unregistered).toBe(true);
  });

  test("send: OAuth failure → ok:false (swallowed)", async () => {
    mock(() => new Response("nope", { status: 401 }));
    const res = await new FcmClient(creds).send({ token: "t", platform: "android" }, MSG);
    expect(res.ok).toBe(false);
  });
});

// ── PushSender routing ───────────────────────────────────────────────────────

describe("PushSender", () => {
  function fake() {
    const sent: Array<{ token: string; msg: PushMessage }> = [];
    const ch: PushChannel = {
      async send(device, msg) {
        sent.push({ token: device.token, msg });
        return { token: device.token, ok: true };
      },
    };
    return { ch, sent };
  }

  test("routes ios→apns channel, android→fcm channel, passing the content-blind note", async () => {
    const ios = fake();
    const android = fake();
    const sender = new PushSender({ ios: ios.ch, android: android.ch });
    const results = await sender.send(
      [
        { token: "i", platform: "ios" },
        { token: "a", platform: "android" },
      ],
      MSG,
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(ios.sent.map((s) => s.token)).toEqual(["i"]);
    expect(android.sent.map((s) => s.token)).toEqual(["a"]);
    expect(ios.sent[0].msg).toEqual(MSG);
  });

  test("missing channel → ok:false, never throws", async () => {
    const [r] = await new PushSender({}).send([{ token: "x", platform: "ios" }], MSG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no ios channel");
  });

  test("createPushSender builds only the configured channels", async () => {
    const sender = createPushSender({ apns: { keyId: "K", teamId: "T", bundleId: "b", p8: ecPem() } });
    expect(sender).toBeInstanceOf(PushSender);
    // No fcm channel → android delivery fails gracefully (no network touched).
    const [r] = await sender.send([{ token: "x", platform: "android" }], MSG);
    expect(r.ok).toBe(false);
  });
});
