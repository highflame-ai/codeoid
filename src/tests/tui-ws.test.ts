/**
 * TuiWsClient reconnect/auth state machine.
 *
 * Regression coverage for the bug where the built-in TUI dead-ended on a 4003
 * "Token expired" close and never recovered (you had to restart `codeoid tui`).
 * Driven against a controllable mock WebSocket + mock token exchange so we can
 * assert: token re-mint on reconnect, recovery from a 4003 close, a bounded
 * give-up when the daemon keeps rejecting, heartbeat-triggered reconnect, and
 * in-flight requests failing fast on a dropped socket — without a real daemon.
 *
 * Timers are real but tiny (intervals injected via TuiWsOptions), so the tests
 * stay fast and don't depend on a fake-timer facility bun:test lacks.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TuiWsClient } from "../tui/ws.js";
import type { CodeoidConfig } from "../config.js";
import type { TuiAction } from "../tui/types.js";

// ── Controllable mock WebSocket (assignable onX handlers, like Bun's) ────────

class MockWS {
  static instances: MockWS[] = [];
  static OPEN = 1;
  static last(): MockWS {
    const w = MockWS.instances[MockWS.instances.length - 1];
    if (!w) throw new Error("no MockWS instance");
    return w;
  }

  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(public url: string) {
    MockWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // ── test drivers ──
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  get parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
  get sentTypes(): string[] {
    return this.parsed.map((m) => String(m.type ?? ""));
  }
}

const AUTH_OK = { type: "auth.ok", identity: { sub: "u" }, scopes: [] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// Minimal config — the client only reads apiKey / zeroidUrl / daemonUrl.
const CONFIG = {
  apiKey: "zid_sk_test",
  zeroidUrl: "https://zeroid.test",
  daemonUrl: "ws://daemon.test",
} as unknown as CodeoidConfig;

let savedWebSocket: unknown;
let savedFetch: unknown;
let tokenSeq = 0;
/** Every client makeClient() builds, so afterEach can stop them even when an
 * assertion throws before the test's own teardown — otherwise a surviving
 * reconnect/heartbeat timer fires after the globals are restored and connects
 * against the real WebSocket/fetch, leaking into the next test. */
const clients: TuiWsClient[] = [];

/** Mock the ZeroID token exchange — each call mints a distinct JWT so we can
 * prove a reconnect re-exchanges the key instead of replaying a dead token. */
function installFetchMock(): void {
  tokenSeq = 0;
  (globalThis as { fetch: unknown }).fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: `fresh-${++tokenSeq}` }),
  });
}

function makeClient(
  actions: TuiAction[],
  opts?: ConstructorParameters<typeof TuiWsClient>[2],
): TuiWsClient {
  const client = new TuiWsClient(CONFIG, (a) => actions.push(a), opts);
  clients.push(client);
  return client;
}

/** start() → open the freshest socket → deliver auth.ok → connected. */
async function connect(client: TuiWsClient): Promise<MockWS> {
  await client.start(); // awaits the token exchange + socket creation
  const ws = MockWS.last();
  ws.open();
  ws.recv(AUTH_OK);
  await flush();
  return ws;
}

const lastConnState = (actions: TuiAction[]): string | undefined => {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i]!;
    if (a.type === "connection.change") return a.state;
  }
  return undefined;
};

describe("TuiWsClient", () => {
  beforeEach(() => {
    MockWS.instances = [];
    savedWebSocket = (globalThis as { WebSocket: unknown }).WebSocket;
    savedFetch = (globalThis as { fetch: unknown }).fetch;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    installFetchMock();
  });
  afterEach(() => {
    // Stop every client first — halts heartbeat intervals and pending reconnect
    // timers — THEN restore the globals, so no stray timer can reconnect against
    // the real WebSocket/fetch.
    for (const c of clients) c.stop();
    clients.length = 0;
    (globalThis as { WebSocket: unknown }).WebSocket = savedWebSocket;
    (globalThis as { fetch: unknown }).fetch = savedFetch;
  });

  it("completes the auth handshake (re-minting the token) and reports connected", async () => {
    const actions: TuiAction[] = [];
    const client = makeClient(actions, { heartbeatMs: 0 });
    const ws = await connect(client);

    expect(ws.parsed[0]).toMatchObject({ token: "fresh-1" }); // auth frame first
    expect(lastConnState(actions)).toBe("connected");
  });

  it("recovers from a 4003 'Token expired' close by reconnecting with a fresh token", async () => {
    // The core regression: a 4003 used to dead-end in `error` with no
    // reconnect. It must now reconnect AND carry a newly-minted JWT.
    const actions: TuiAction[] = [];
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });
    const ws1 = await connect(client);
    expect(MockWS.instances.length).toBe(1);

    ws1.close(4003, "Token expired");
    await flush();
    // It should go to `reconnecting`, never the terminal `error`.
    expect(lastConnState(actions)).toBe("reconnecting");

    await sleep(20); // let the scheduled reconnect (re-exchange + new socket) run
    expect(MockWS.instances.length).toBe(2);
    const ws2 = MockWS.last();
    expect(ws2).not.toBe(ws1);

    ws2.open();
    expect(ws2.parsed[0]).toMatchObject({ token: "fresh-2" }); // re-minted, not replayed
    ws2.recv(AUTH_OK);
    await flush();
    expect(lastConnState(actions)).toBe("connected");
  });

  it("gives up with an error after maxAuthReconnects consecutive 4003s", async () => {
    // A token the daemon keeps rejecting for a non-expiry reason must not loop
    // forever — it surfaces a terminal error once the bound is hit.
    const actions: TuiAction[] = [];
    const client = makeClient(actions, {
      heartbeatMs: 0,
      reconnectDelayMs: 5,
      maxAuthReconnects: 1,
    });
    const ws1 = await connect(client);

    ws1.close(4003, "Token expired"); // authReconnects: 0 -> 1, schedules reconnect
    await sleep(20);
    const ws2 = MockWS.last();
    expect(ws2).not.toBe(ws1);
    ws2.open();
    ws2.close(4003, "token issuer mismatch"); // 1 >= 1 -> give up
    await flush();

    expect(lastConnState(actions)).toBe("error");
    expect(actions.some((a) => a.type === "error")).toBe(true);
  });

  it("sends a heartbeat ping and force-reconnects when no pong arrives", async () => {
    const actions: TuiAction[] = [];
    // Wide margins so the ping/timeout ordering can't race the assertions
    // under CI load: ping fires at ~20ms, its timeout lands at ~60ms.
    const client = makeClient(actions, {
      heartbeatMs: 20,
      heartbeatTimeoutMs: 40,
      reconnectDelayMs: 5,
    });
    const ws1 = await connect(client);
    expect(MockWS.instances.length).toBe(1);

    await sleep(40); // ping has fired (~20ms), well before its ~60ms timeout
    expect(ws1.sentTypes).toContain("ping");

    await sleep(60); // ping times out (~60ms) → forceReconnect opens a new socket
    expect(MockWS.instances.length).toBeGreaterThan(1);
  });

  it("fails in-flight requests immediately when the socket drops (no 30s hang)", async () => {
    const actions: TuiAction[] = [];
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });
    const ws1 = await connect(client);

    const pending = client.interrupt("session-1"); // sent, awaiting response
    expect(ws1.sentTypes).toContain("session.interrupt");

    ws1.close(1006, "dropped"); // network drop under the request
    await expect(pending).rejects.toThrow();
  });

  it("answers a provider dialog by its request id (#348)", async () => {
    const actions: TuiAction[] = [];
    const client = makeClient(actions, { heartbeatMs: 0 });
    const ws = await connect(client);
    void client.uiRespond("session-1", "req-7", { confirmed: true }).catch(() => {});
    expect(ws.parsed.at(-1)).toMatchObject({
      type: "session.ui_response",
      sessionId: "session-1",
      requestId: "req-7",
      confirmed: true,
    });
    client.stop();
  });

  it("4001 (handshake failure) stays terminal — re-minting won't fix it", async () => {
    const actions: TuiAction[] = [];
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });
    await client.start();
    const ws = MockWS.last();
    ws.close(4001, "Authentication timeout");
    await flush();

    expect(lastConnState(actions)).toBe("error");
    await sleep(20);
    expect(MockWS.instances.length).toBe(1); // no reconnect attempted
  });

  // ── #83: transient token-exchange failures must not kill the reconnect loop ──

  it("unreachable token endpoint schedules a reconnect and recovers (#83)", async () => {
    // Laptop wakes before Wi-Fi is up: fetch rejects with ECONNREFUSED. The
    // old code pinned the client to `error` with no reconnect — forever.
    const actions: TuiAction[] = [];
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      calls++;
      if (calls === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:8899");
      return { ok: true, json: async () => ({ access_token: `fresh-${++tokenSeq}` }) };
    };
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });

    await client.start();
    await flush();
    expect(lastConnState(actions)).toBe("reconnecting"); // not terminal `error`
    expect(MockWS.instances.length).toBe(0); // no socket was ever created

    await sleep(20); // scheduled reconnect runs; second token exchange succeeds
    expect(MockWS.instances.length).toBe(1);
    const ws = MockWS.last();
    ws.open();
    ws.recv(AUTH_OK);
    await flush();
    expect(lastConnState(actions)).toBe("connected");
  });

  it("5xx from the token endpoint is transient — reconnects (#83)", async () => {
    const actions: TuiAction[] = [];
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => ({ access_token: `fresh-${++tokenSeq}` }) };
    };
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });

    await client.start();
    await flush();
    expect(lastConnState(actions)).toBe("reconnecting");

    await sleep(20);
    const ws = MockWS.last();
    ws.open();
    ws.recv(AUTH_OK);
    await flush();
    expect(lastConnState(actions)).toBe("connected");
  });

  it("429 from the token endpoint is transient — reconnects (#83)", async () => {
    const actions: TuiAction[] = [];
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, json: async () => ({ access_token: `fresh-${++tokenSeq}` }) };
    };
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });

    await client.start();
    await flush();
    expect(lastConnState(actions)).toBe("reconnecting");

    await sleep(20);
    const ws = MockWS.last();
    ws.open();
    ws.recv(AUTH_OK);
    await flush();
    expect(lastConnState(actions)).toBe("connected");
  });

  it("a transient token failure surfaces no user-facing error (StatusBar stays clean)", async () => {
    // Regression: the error dispatch used to fire before the transient check,
    // leaving a stale error in the store after a successful reconnect.
    const actions: TuiAction[] = [];
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      calls++;
      if (calls === 1) throw new Error("connect ECONNREFUSED");
      return { ok: true, json: async () => ({ access_token: `fresh-${++tokenSeq}` }) };
    };
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });

    await client.start();
    await flush();
    // No `error` action for the transient blip — only the reconnect transition.
    expect(actions.some((a) => a.type === "error")).toBe(false);
    expect(lastConnState(actions)).toBe("reconnecting");
  });

  it("a key the token endpoint rejects (4xx) stays terminal — no reconnect", async () => {
    const actions: TuiAction[] = [];
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_key" }),
    });
    const client = makeClient(actions, { heartbeatMs: 0, reconnectDelayMs: 5 });

    await client.start();
    await flush();
    expect(lastConnState(actions)).toBe("error");
    expect(actions.some((a) => a.type === "error")).toBe(true);

    await sleep(20);
    expect(MockWS.instances.length).toBe(0); // no reconnect, no socket
  });

  it("missing API key stays terminal — no reconnect", async () => {
    const actions: TuiAction[] = [];
    const config = { ...CONFIG, apiKey: undefined } as unknown as CodeoidConfig;
    const client = new TuiWsClient(config, (a) => actions.push(a), {
      heartbeatMs: 0,
      reconnectDelayMs: 5,
    });
    clients.push(client);

    await client.start();
    await flush();
    expect(lastConnState(actions)).toBe("error");

    await sleep(20);
    expect(MockWS.instances.length).toBe(0);
  });
});
