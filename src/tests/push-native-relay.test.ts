/**
 * The daemon-side transports that wrap push-core: NativePushTransport
 * (embedded — maps targets→devices, prunes dead tokens) and RelayPushTransport
 * (POSTs a content-blind wake-up), plus the createPushTransport factory and the
 * store's dead-token prune.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushTransport, NativePushTransport, RelayPushTransport } from "../daemon/push/index.js";
import { Store } from "../daemon/store.js";
import type { PushMessage, PushResult, PushSender } from "../push-core/index.js";

const NOTE = { sessionId: "s-1", kind: "approval" as const };

function fakeSender(results: PushResult[]) {
  const calls: Array<{ devices: unknown; msg: PushMessage }> = [];
  const sender = {
    async send(devices: unknown, msg: PushMessage) {
      calls.push({ devices, msg });
      return results;
    },
    close() {},
  } as unknown as PushSender;
  return { sender, calls };
}

describe("NativePushTransport", () => {
  test("maps targets→devices and passes the content-blind note", async () => {
    const { sender, calls } = fakeSender([{ token: "t", ok: true }]);
    await new NativePushTransport(sender).send([{ token: "t", platform: "ios" }], NOTE);
    expect(calls[0].devices).toEqual([{ token: "t", platform: "ios" }]);
    expect(calls[0].msg).toEqual({ sessionId: "s-1", kind: "approval" });
  });

  test("prunes only the unregistered tokens via the callback", async () => {
    const { sender } = fakeSender([
      { token: "dead", ok: false, unregistered: true },
      { token: "live", ok: true },
    ]);
    const pruned: string[] = [];
    await new NativePushTransport(sender, (t) => pruned.push(t)).send(
      [
        { token: "dead", platform: "ios" },
        { token: "live", platform: "android" },
      ],
      NOTE,
    );
    expect(pruned).toEqual(["dead"]);
  });

  test("empty targets → sender not called", async () => {
    const { sender, calls } = fakeSender([]);
    await new NativePushTransport(sender).send([], NOTE);
    expect(calls).toHaveLength(0);
  });
});

describe("RelayPushTransport", () => {
  let origFetch: typeof fetch;
  let calls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    calls = [];
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("POSTs content-blind {targets, note} with Bearer auth to /push", async () => {
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await new RelayPushTransport("https://relay.example", "reltok").send(
      [{ token: "t", platform: "ios" }],
      NOTE,
    );
    expect(calls[0].url).toBe("https://relay.example/push");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer reltok");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      targets: [{ token: "t", platform: "ios" }],
      note: { sessionId: "s-1", kind: "approval" },
    });
  });

  test("empty targets → no POST", async () => {
    globalThis.fetch = (async () => {
      calls.push({ url: "x", init: {} });
      return new Response("");
    }) as unknown as typeof fetch;
    await new RelayPushTransport("https://r", "t").send([], NOTE);
    expect(calls).toHaveLength(0);
  });
});

describe("createPushTransport", () => {
  test("undefined / none → noop", () => {
    expect(createPushTransport(undefined).name).toBe("none");
    expect(createPushTransport({ transport: "none" }).name).toBe("none");
  });
  test("expo → expo", () => {
    expect(createPushTransport({ transport: "expo" }).name).toBe("expo");
  });
  test("native → native", () => {
    expect(createPushTransport({ transport: "native" }).name).toBe("native");
  });
  test("relay with url+token → relay", () => {
    expect(
      createPushTransport({ transport: "relay", relayUrl: "https://r", relayToken: "t" }).name,
    ).toBe("relay");
  });
  test("relay missing url/token → noop (fail safe)", () => {
    expect(createPushTransport({ transport: "relay" }).name).toBe("none");
  });
});

describe("store.pruneDeadToken", () => {
  let tmp: string;
  let store: Store;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-push-prune-"));
    store = new Store(join(tmp, "codeoid.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("deletes a token regardless of owner", () => {
    store.registerPush("t1", "ios", "user:a", "acc", "proj");
    store.pruneDeadToken("t1");
    expect(store.listPushForOwner("user:a", "acc", "proj")).toEqual([]);
  });
});
