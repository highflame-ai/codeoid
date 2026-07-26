/**
 * Push transport + service. The load-bearing property under test is
 * CONTENT-BLINDNESS: the Expo payload must carry only an opaque session id +
 * kind and generic copy — never a tool name, args, or description — so no
 * session content leaves the daemon even through a third-party transport.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { ExpoPushTransport } from "./expo.js";
import { createPushTransport, PushService } from "./service.js";
import type { PushNotification, PushTarget, PushTransport } from "./types.js";

describe("ExpoPushTransport", () => {
  let calls: Array<{ url: string; init: RequestInit }>;
  let origFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("payload is CONTENT-BLIND — opaque id + kind only, no tool details", async () => {
    await new ExpoPushTransport().send(
      [{ token: "ExponentPushToken[x]", platform: "ios" }],
      { sessionId: "s-123", kind: "approval" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(calls[0].init.body as string) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    const msg = body[0];
    expect(msg.to).toBe("ExponentPushToken[x]");
    expect(msg.title).toBe("codeoid"); // generic
    expect(msg.data).toEqual({ sessionId: "s-123", kind: "approval" });
    // The ENTIRE data object must contain nothing but the two opaque fields.
    expect(Object.keys(msg.data as object).sort()).toEqual(["kind", "sessionId"]);
  });

  test("Bearer auth is sent only when an access token is configured", async () => {
    await new ExpoPushTransport("tok-abc").send(
      [{ token: "t", platform: "android" }],
      { sessionId: "s", kind: "approval" },
    );
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok-abc");

    calls.length = 0;
    await new ExpoPushTransport().send(
      [{ token: "t", platform: "android" }],
      { sessionId: "s", kind: "approval" },
    );
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("batches at 100 messages per request", async () => {
    const targets: PushTarget[] = Array.from({ length: 250 }, (_, i) => ({
      token: `t${i}`,
      platform: "ios" as const,
    }));
    await new ExpoPushTransport().send(targets, { sessionId: "s", kind: "approval" });
    expect(calls).toHaveLength(3); // 100 + 100 + 50
  });

  test("no targets → no HTTP call", async () => {
    await new ExpoPushTransport().send([], { sessionId: "s", kind: "approval" });
    expect(calls).toHaveLength(0);
  });

  test("swallows a non-2xx response (best-effort delivery)", async () => {
    globalThis.fetch = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    await expect(
      new ExpoPushTransport().send([{ token: "t", platform: "ios" }], {
        sessionId: "s",
        kind: "approval",
      }),
    ).resolves.toBeUndefined();
  });

  test("swallows a network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      new ExpoPushTransport().send([{ token: "t", platform: "ios" }], {
        sessionId: "s",
        kind: "approval",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("createPushTransport", () => {
  test("undefined / none → noop transport", () => {
    expect(createPushTransport(undefined).name).toBe("none");
    expect(createPushTransport({ transport: "none" }).name).toBe("none");
  });

  test("expo → Expo transport", () => {
    expect(createPushTransport({ transport: "expo" }).name).toBe("expo");
  });
});

describe("PushService.notifyApproval", () => {
  let tmp: string;
  let store: Store;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-push-svc-"));
    store = new Store(join(tmp, "codeoid.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakeTransport() {
    const sent: Array<{ targets: PushTarget[]; note: PushNotification }> = [];
    const transport: PushTransport = {
      name: "expo",
      async send(targets, note) {
        sent.push({ targets, note });
      },
    };
    return { transport, sent };
  }

  test("noop transport → disabled, delivers nothing", async () => {
    const svc = new PushService(store, { name: "none", async send() {} });
    expect(svc.enabled).toBe(false);
    store.registerPush("tok", "ios", "user:a", "acc", "proj");
    await svc.notifyApproval("s-1", { sub: "user:a", accountId: "acc", projectId: "proj" });
    // enabled=false short-circuits before any transport work — nothing to assert
    // beyond not throwing.
  });

  test("delivers a content-blind note to the owner's devices only", async () => {
    store.registerPush("tok-a", "ios", "user:a", "acc", "proj");
    store.registerPush("tok-b", "ios", "user:b", "acc", "proj"); // other owner
    const { transport, sent } = fakeTransport();
    const svc = new PushService(store, transport);
    expect(svc.enabled).toBe(true);

    await svc.notifyApproval("s-1", { sub: "user:a", accountId: "acc", projectId: "proj" });
    expect(sent).toHaveLength(1);
    expect(sent[0].targets.map((t) => t.token)).toEqual(["tok-a"]);
    expect(sent[0].note).toEqual({ sessionId: "s-1", kind: "approval" });
  });

  test("no registered devices → no send", async () => {
    const { transport, sent } = fakeTransport();
    await new PushService(store, transport).notifyApproval("s-1", {
      sub: "nobody",
      accountId: "acc",
      projectId: "proj",
    });
    expect(sent).toHaveLength(0);
  });

  test("swallows a store lookup failure", async () => {
    const throwingStore = {
      listPushForOwner() {
        throw new Error("db gone");
      },
    } as unknown as Store;
    const { transport, sent } = fakeTransport();
    await new PushService(throwingStore, transport).notifyApproval("s-1", {
      sub: "u",
      accountId: "a",
      projectId: "p",
    });
    expect(sent).toHaveLength(0);
  });
});
