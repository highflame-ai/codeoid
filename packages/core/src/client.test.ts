/**
 * CodeoidClient reconnection state machine — the critical multi-frontend
 * reliability core. Driven against a controllable mock WebSocket so we can
 * assert the auth handshake (incl. capability declaration), send gating,
 * request correlation, reconnect-on-drop, heartbeat-triggered recovery, and
 * reconnect-now — without a real daemon.
 *
 * Uses REAL timers with injected tiny timings (the timing knobs exist on
 * ConnectOptions precisely so hosts and tests can tune them) — bun:test has
 * no fake-timer facility. Margins are generous to stay CI-stable.
 *
 * Runs without a DOM, so the browser resume listeners no-op; that path is
 * exercised indirectly via reconnectNow().
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CodeoidClient, RequestError } from "./client.js";
import type { ClientStatus, ConnectOptions } from "./client.js";

// ── Controllable mock WebSocket ───────────────────────────────────────────

type Listener = (ev: unknown) => void;

class MockWS {
  static instances: MockWS[] = [];
  static last(): MockWS {
    const w = MockWS.instances[MockWS.instances.length - 1];
    if (!w) throw new Error("no MockWS instance");
    return w;
  }

  readyState = 0;
  sent: string[] = [];
  #listeners: Record<string, Listener[]> = {};

  constructor(public url: string) {
    MockWS.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.#listeners[type]) this.#listeners[type] = [];
    this.#listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.#listeners[type] = (this.#listeners[type] ?? []).filter((f) => f !== fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code, reason });
  }

  // ── test drivers ──
  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }
  recv(obj: unknown): void {
    this.#emit("message", { data: JSON.stringify(obj) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.#emit("close", { code, reason: "dropped" });
  }
  get parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
  #emit(type: string, ev: unknown): void {
    for (const f of this.#listeners[type] ?? []) f(ev);
  }
}

const AUTH_OK = { type: "auth.ok", identity: { sub: "u" }, scopes: [] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Tiny real-timer knobs — fast tests, generous assertion margins. */
const FAST: Partial<ConnectOptions> = {
  heartbeatMs: 40,
  heartbeatTimeoutMs: 25,
  minBackoffMs: 5,
  maxBackoffMs: 15,
};

function makeClient(overrides: Partial<ConnectOptions> = {}): CodeoidClient {
  return new CodeoidClient({ url: "ws://x", token: "t", ...FAST, ...overrides });
}

/** Drive a client to `connected` against the freshest mock socket. */
async function connectClient(c: CodeoidClient): Promise<MockWS> {
  const p = c.connect();
  await flush();
  const ws = MockWS.last();
  ws.open();
  await flush();
  ws.recv(AUTH_OK);
  await p;
  return ws;
}

let savedWebSocket: unknown;
const clients: CodeoidClient[] = [];
function track(c: CodeoidClient): CodeoidClient {
  clients.push(c);
  return c;
}

describe("CodeoidClient", () => {
  beforeEach(() => {
    MockWS.instances = [];
    savedWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = MockWS;
  });
  afterEach(() => {
    // Shut down every client so surviving heartbeat/backoff timers can't
    // fire after the mock is restored and leak into the next test.
    for (const c of clients.splice(0)) {
      try {
        c.shutdown();
      } catch {
        /* ignore */
      }
    }
    (globalThis as Record<string, unknown>).WebSocket = savedWebSocket;
  });

  it("completes the auth handshake and reports connected", async () => {
    const statuses: ClientStatus["kind"][] = [];
    const c = track(makeClient({ token: "tok" }));
    c.onStatus((s) => statuses.push(s.kind));
    const ws = await connectClient(c);

    expect(ws.parsed[0]).toMatchObject({ type: "auth", token: "tok" });
    expect(statuses).toContain("connected");
  });

  it("declares protocol version + capabilities + client name when configured", async () => {
    const c = track(
      makeClient({ capabilities: ["parts", "replay.chunked"], clientName: "test-host/1.0" }),
    );
    const ws = await connectClient(c);
    expect(ws.parsed[0]).toMatchObject({
      type: "auth",
      capabilities: ["parts", "replay.chunked"],
      client: "test-host/1.0",
    });
    expect(typeof ws.parsed[0]?.protocolVersion).toBe("number");
  });

  it("omits capabilities/client for a legacy configuration", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    expect("capabilities" in ws.parsed[0]!).toBe(false);
    expect("client" in ws.parsed[0]!).toBe(false);
  });

  it("gates send() on the connection and writes once connected", async () => {
    const c = track(makeClient());
    expect(() => c.send({ type: "ping", id: "1" })).toThrow(); // not connected
    const ws = await connectClient(c);
    c.send({ type: "session.interrupt", id: "2", sessionId: "s" });
    expect(ws.parsed.some((m) => m.type === "session.interrupt")).toBe(true);
  });

  it("correlates request() responses and rejects on response.error", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);

    const ok = c.request({ type: "ping", id: "req-1" });
    ws.recv({ type: "response.ok", requestId: "req-1", data: { pong: true } });
    await expect(ok).resolves.toMatchObject({ requestId: "req-1" });

    const bad = c.request({ type: "session.attach", id: "req-2", sessionId: "s" });
    ws.recv({ type: "response.error", requestId: "req-2", error: "nope", code: "not_found" });
    await expect(bad).rejects.toThrow("nope");
  });

  it("a refusal keeps its code and structured detail, not only its words", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const bad = c.request({ type: "loop.watch.update", id: "req-9", watchId: "lw_1", trustHead: { main: "a".repeat(40) } });
    const detail = { kind: "head_moved", branch: "main", head: "b".repeat(40), pinned: "a".repeat(40) } as const;
    ws.recv({ type: "response.error", requestId: "req-9", error: "main's head is … now", code: "invalid_request", detail });
    const err = await bad.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ message: "main's head is … now", code: "invalid_request", detail });
  });

  it("resolves waitForResult requests on their typed result frame", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const p = c.request(
      { type: "session.list", id: "req-3" },
      {
        waitForResult: (m) =>
          m.type === "session.list.result" && m.requestId === "req-3" ? m : undefined,
      },
    );
    // The plain ack must NOT resolve it; the typed result must.
    ws.recv({ type: "response.ok", requestId: "req-3" });
    ws.recv({ type: "session.list.result", requestId: "req-3", sessions: [] });
    const result = await p;
    expect(result).toMatchObject({ type: "session.list.result" });
  });

  it("reconnects automatically after an unexpected drop", async () => {
    const c = track(makeClient());
    await connectClient(c);
    expect(MockWS.instances.length).toBe(1);

    MockWS.last().drop(); // socket dies
    await flush();
    // First reconnect attempt opens a new socket immediately (no pre-backoff).
    expect(MockWS.instances.length).toBe(2);

    const ws2 = MockWS.last();
    ws2.open();
    await flush();
    ws2.recv(AUTH_OK);
    await flush();
    expect(c.status.kind).toBe("connected");
  });

  it("times out a handshake the peer never answers instead of hanging forever", async () => {
    // Socket opens, auth frame is sent, but no auth.ok / response.error /
    // close ever arrives (hung middlebox). The handshake deadline must fail
    // the attempt so backoff (or, with bounded attempts, the caller) takes
    // over — previously connect() hung indefinitely here.
    const c = track(makeClient({ requestTimeoutMs: 30, maxAttempts: 1 }));
    const p = c.connect();
    await flush();
    MockWS.last().open();
    await flush();
    expect(MockWS.last().parsed[0]?.type).toBe("auth"); // frame went out
    await expect(p).rejects.toThrow(/auth handshake timed out/);
    expect(c.status.kind).toBe("failed");
  });

  it("goes terminal (failed, no retry loop) when auth is rejected via a 4003 close", async () => {
    // Default maxAttempts=0 means "retry network drops forever" — an expired
    // OAuth JWT would otherwise loop on the dead token. Auth rejection is terminal.
    const c = track(makeClient());
    const statuses: string[] = [];
    c.onStatus((s) => statuses.push(s.kind));
    const p = c.connect();
    await flush();
    MockWS.last().open();
    await flush();
    MockWS.last().close(4003, "token expired");
    await expect(p).rejects.toThrow();
    await flush();
    expect(c.status.kind).toBe("failed");
    expect(MockWS.instances.length).toBe(1); // did NOT spin up another socket
    expect(statuses).not.toContain("reconnecting");
  });

  it("goes terminal (failed) when auth is rejected via response.error", async () => {
    const c = track(makeClient());
    const p = c.connect();
    await flush();
    MockWS.last().open();
    await flush();
    MockWS.last().recv({ type: "response.error", error: "invalid token" });
    await expect(p).rejects.toThrow(/auth rejected/);
    await flush();
    expect(c.status.kind).toBe("failed");
    expect(MockWS.instances.length).toBe(1);
  });

  it("still RETRIES a non-auth drop before auth completes (not terminal)", async () => {
    // A 1006 abnormal-closure before auth is a transient network drop, not an
    // auth rejection — it must back off and retry, not go to failed.
    const c = track(makeClient({ maxAttempts: 2 }));
    const p = c.connect();
    await flush();
    MockWS.last().open();
    await flush();
    MockWS.last().close(1006, "");
    // Let the backoff timer fire so the retry socket is created.
    await sleep(30);
    // A second socket was created (retry), and we never went terminal on the drop.
    expect(MockWS.instances.length).toBeGreaterThan(1);
    // Land the retry so the test doesn't leak a pending connect.
    MockWS.last().open();
    await flush();
    MockWS.last().recv(AUTH_OK);
    await p;
    expect(c.status.kind).toBe("connected");
  });

  it("rejects in-flight requests when the socket drops (no 30s hang)", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const p = c.request({ type: "ping", id: "req-4" });
    ws.drop();
    await expect(p).rejects.toThrow(/connection lost/);
  });

  it("detects a dead socket via heartbeat and force-reconnects", async () => {
    const c = track(makeClient());
    const ws1 = await connectClient(c);
    const before = MockWS.instances.length;

    // heartbeatMs(40) fires a ping; no pong → timeout(25) → force reconnect.
    await sleep(120);
    expect(ws1.parsed.some((m) => m.type === "ping")).toBe(true);
    expect(MockWS.instances.length).toBeGreaterThan(before);
  });

  it("reconnectNow() retries immediately instead of waiting out backoff", async () => {
    // Huge backoff floor so only reconnectNow (not the timer) can explain a
    // new attempt within the test window.
    const c = track(makeClient({ minBackoffMs: 60_000, maxBackoffMs: 60_000 }));
    await connectClient(c);
    MockWS.last().drop();
    await flush();
    const afterFirstRetry = MockWS.instances.length; // immediate retry socket
    MockWS.last().drop(); // retry fails too → now sleeping in long backoff
    await flush();

    c.reconnectNow();
    await flush();
    expect(MockWS.instances.length).toBeGreaterThan(afterFirstRetry);
  });

  it("re-exchanges the token via getToken on each (re)connect, with fallback", async () => {
    let n = 0;
    const c = track(
      makeClient({ token: "static-fallback", getToken: async () => `fresh-${++n}` }),
    );
    const ws1 = await connectClient(c);
    expect(ws1.parsed[0]).toMatchObject({ token: "fresh-1" });

    ws1.drop();
    await flush();
    const ws2 = MockWS.last();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    await flush();
    expect(ws2.parsed[0]).toMatchObject({ token: "fresh-2" });
    ws2.recv(AUTH_OK);

    const failing = track(
      makeClient({
        token: "static-fallback",
        getToken: async () => {
          throw new Error("no stored key");
        },
      }),
    );
    const ws3 = await connectClient(failing);
    expect(ws3.parsed[0]).toMatchObject({ token: "static-fallback" });
  });

  it("concurrent connect() calls join one attempt instead of racing (or throwing)", async () => {
    const c = track(makeClient());
    const p1 = c.connect();
    const p2 = c.connect(); // previously: threw "connect already in progress"
    await flush();
    expect(MockWS.instances.length).toBe(1); // one socket, not two
    const ws = MockWS.last();
    ws.open();
    await flush();
    ws.recv(AUTH_OK);
    const [a1, a2] = await Promise.all([p1, p2]);
    expect(a1.type).toBe("auth.ok");
    expect(a2.type).toBe("auth.ok");
  });

  it("connect() after shutdown() fails with a clear terminal-instance error", async () => {
    const c = track(makeClient());
    await connectClient(c);
    c.shutdown();
    await expect(c.connect()).rejects.toThrow(/shut down/);
  });

  it("rejects a duplicate request id instead of clobbering the pending entry", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const first = c.request({ type: "ping", id: "dup-1" });
    await expect(c.request({ type: "ping", id: "dup-1" })).rejects.toThrow(
      /duplicate request id/,
    );
    // The FIRST request is unharmed and still resolves.
    ws.recv({ type: "response.ok", requestId: "dup-1" });
    await expect(first).resolves.toMatchObject({ requestId: "dup-1" });
  });

  it("a throwing message handler doesn't break dispatch to later handlers", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const seen: string[] = [];
    c.onMessage(() => {
      throw new Error("bad consumer");
    });
    c.onMessage((m) => seen.push(m.type));
    ws.recv({ type: "session.status_change", sessionId: "s", status: "idle", timestamp: "t" });
    ws.recv({ type: "session.status_change", sessionId: "s", status: "thinking", timestamp: "t" });
    expect(seen).toHaveLength(2); // both frames reached the second handler
  });

  it("shutdown() closes, rejects pending requests, and stops reconnecting", async () => {
    const c = track(makeClient());
    const ws = await connectClient(c);
    const p = c.request({ type: "ping", id: "req-5" });
    c.shutdown();
    await expect(p).rejects.toThrow(/shutdown/);
    // A post-shutdown drop must not spawn a new socket.
    const count = MockWS.instances.length;
    ws.drop();
    await sleep(30);
    expect(MockWS.instances.length).toBe(count);
  });
});
