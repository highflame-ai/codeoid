/**
 * Fleet board — the P5.0 read+subscribe contract
 * (docs/conductor-frontends-design.md §11).
 *
 * The conductor's dispatch state has lived only in daemon SQLite; this surface
 * is the one additive wire change that lets a client SEE it. What these tests
 * guard, in order of how much damage the failure would do:
 *
 *   1. Tenancy — a board is per-tenant. A leak here shows one customer another
 *      customer's work, and the delta stream makes it a live feed rather than a
 *      one-off read.
 *   2. Scope — `fleet:read` actually gates the surface.
 *   3. Prompt confidentiality — the wire projection drops `prompt`/`workdir`.
 *      Task rows carry raw user text; the board only needs lifecycle.
 *   4. Delta liveness + watermarking — changes reach subscribers exactly once
 *      per change, and a subscription that is dropped stops costing anything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";
import type { AuthContext, ClientMessage, DaemonMessage, FleetSnapshot } from "../protocol/types.js";
import { parseClientMessage } from "@highflame/codeoid-protocol/schemas";

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

const AUTH: AuthContext = {
  sub: "user:fleet",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-fleet",
  projectId: "proj-fleet",
};

/** A second tenant on the same daemon — the isolation counterparty. */
const OTHER_AUTH: AuthContext = {
  ...AUTH,
  sub: "user:other",
  accountId: "acc-other",
  projectId: "proj-other",
};

/** Collects everything the daemon pushed, so deltas can be asserted on. */
function mkClient(id: string, auth: AuthContext = AUTH) {
  const received: DaemonMessage[] = [];
  return {
    client: { id, auth, send: (m: DaemonMessage) => received.push(m) },
    received,
    updates: () => received.filter((m) => m.type === "fleet.update"),
  };
}

/**
 * Enqueue through the REAL dispatcher, not the store.
 *
 * `Dispatcher.enqueue` is what fires the board-change signal, so going through
 * it exercises the actual enqueue → signal → flush → client.send wiring instead
 * of simulating the half of it under test.
 */
function enqueue(
  auth: AuthContext,
  over: Partial<{ kind: "send" | "spawn"; prompt: string; targetSession: string }> = {},
): string {
  return manager.dispatcher.enqueue({
    accountId: auth.accountId,
    projectId: auth.projectId,
    kind: over.kind ?? "spawn",
    shape: "scout",
    targetSession: over.targetSession,
    workdir: over.kind === "send" ? undefined : "/tmp",
    prompt: over.prompt ?? "investigate the flaky test",
    createdBy: `wimse://conductor/${auth.accountId}`,
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-fleet-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript);
});

afterEach(async () => {
  try {
    await manager.drain(3_000);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

/** Round-trips through the real schema so a test can't assert on a shape the
 *  wire would have rejected. */
function subscribeMsg(id: string): ClientMessage {
  const parsed = parseClientMessage({ type: "fleet.subscribe", id, scope: "tenant" });
  if (!parsed.ok) throw new Error(`fleet.subscribe rejected by schema: ${parsed.error}`);
  return parsed.value;
}

/** Narrow a reply to the snapshot, failing loudly on an error response rather
 *  than casting past it. */
function snapshotOf(resp: DaemonMessage): FleetSnapshot {
  if (resp.type !== "fleet.snapshot.result") {
    throw new Error(`expected fleet.snapshot.result, got ${resp.type}: ${JSON.stringify(resp)}`);
  }
  return resp.fleet;
}

describe("fleet.subscribe — schema + scope", () => {
  test("the wire schema accepts subscribe/unsubscribe and pins scope to 'tenant'", () => {
    expect(parseClientMessage({ type: "fleet.subscribe", id: "1", scope: "tenant" }).ok).toBe(true);
    expect(parseClientMessage({ type: "fleet.unsubscribe", id: "2" }).ok).toBe(true);
    // A widened scope must be an explicit protocol change, not something a
    // client can simply ask for.
    expect(parseClientMessage({ type: "fleet.subscribe", id: "3", scope: "machine" }).ok).toBe(false);
  });

  test("without fleet:read the surface is forbidden", async () => {
    const { client } = mkClient("c-noscope");
    const auth: AuthContext = {
      ...AUTH,
      scopes: ALL_SCOPES.filter((s) => s !== SCOPES.FLEET_READ) as AuthContext["scopes"],
    };
    const resp = await manager.handle(subscribeMsg("1"), auth, client);
    expect(resp.type).toBe("response.error");
    expect((resp as { error: string }).error).toContain("fleet:read");
  });
});

describe("fleet.subscribe — snapshot", () => {
  test("returns the tenant's tasks with lifecycle fields", async () => {
    const taskId = enqueue(AUTH, { kind: "spawn" });
    const { client } = mkClient("c1");

    const resp = await manager.handle(subscribeMsg("1"), AUTH, client);
    expect(resp.type).toBe("fleet.snapshot.result");
    const fleet = snapshotOf(resp);

    expect(fleet.tasks).toHaveLength(1);
    expect(fleet.tasks[0]).toMatchObject({
      id: taskId,
      kind: "spawn",
      shape: "scout",
      status: "queued",
      attempts: 0,
    });
  });

  test("NEVER puts the dispatch prompt or workdir on the wire", async () => {
    enqueue(AUTH, { prompt: "SECRET-PROMPT-DO-NOT-LEAK" });
    const { client } = mkClient("c2");

    const resp = await manager.handle(subscribeMsg("1"), AUTH, client);
    const serialized = JSON.stringify(resp);

    // The board draws lifecycle. The prompt is the one field on a task row that
    // carries arbitrary user content to every subscribed client.
    expect(serialized).not.toContain("SECRET-PROMPT-DO-NOT-LEAK");
    const task = snapshotOf(resp).tasks[0];
    expect(task).not.toHaveProperty("prompt");
    expect(task).not.toHaveProperty("workdir");
  });

  test("a tenant never sees another tenant's board", async () => {
    enqueue(AUTH, { prompt: "mine" });
    enqueue(OTHER_AUTH, { prompt: "theirs" });
    const { client } = mkClient("c3");

    const resp = await manager.handle(subscribeMsg("1"), AUTH, client);
    const fleet = snapshotOf(resp);

    expect(fleet.tasks).toHaveLength(1);
    expect(fleet.tasks[0].createdBy).toContain("acc-fleet");
  });

  test("an empty board is a valid snapshot, not an error", async () => {
    const { client } = mkClient("c4");
    const resp = await manager.handle(subscribeMsg("1"), AUTH, client);

    expect(resp.type).toBe("fleet.snapshot.result");
    const fleet = snapshotOf(resp);
    expect(fleet.tasks).toEqual([]);
    expect(fleet.workers).toEqual([]);
    // No conductor session exists yet — a common, valid state, not a failure.
    expect(fleet.conductor).toBeUndefined();
    expect(fleet.agg.activeTasks).toBe(0);
  });

  test("agg counts the WHOLE board, not just the page the snapshot ships", async () => {
    // The rollup is computed in SQL over every row precisely so a tenant with
    // more tasks than the page size doesn't under-report "active".
    for (let i = 0; i < 12; i++) enqueue(AUTH);
    const { client } = mkClient("c5");

    const resp = await manager.handle(subscribeMsg("1"), AUTH, client);
    const agg = snapshotOf(resp).agg;
    expect(agg.activeTasks).toBe(12);
    expect(store.dispatchStatusCounts(AUTH.accountId, AUTH.projectId).active).toBe(12);
  });
});

describe("fleet.update — the delta stream", () => {
  test("a board change after subscribing is pushed to the subscriber", async () => {
    const { client, updates } = mkClient("c6");
    await manager.handle(subscribeMsg("1"), AUTH, client);
    expect(updates()).toHaveLength(0);

    // enqueue() signals the board change itself — this is the real path.
    const taskId = enqueue(AUTH);

    const deltas = updates();
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const task = deltas.find(
      (d) => (d as { delta: { kind: string; task?: { id: string } } }).delta.task?.id === taskId,
    );
    expect(task).toBeDefined();
    expect((task as { delta: { kind: string } }).delta.kind).toBe("task");
  });

  test("a delta never crosses tenants", async () => {
    const mine = mkClient("c7", AUTH);
    const theirs = mkClient("c8", OTHER_AUTH);
    await manager.handle(subscribeMsg("1"), AUTH, mine.client);
    await manager.handle(subscribeMsg("2"), OTHER_AUTH, theirs.client);

    enqueue(AUTH, { prompt: "mine" });

    expect(mine.updates().length).toBeGreaterThanOrEqual(1);
    expect(theirs.updates()).toHaveLength(0);
  });

  test("the watermark advances — a later change re-sends only what moved", async () => {
    const { client, updates } = mkClient("c9");
    await manager.handle(subscribeMsg("1"), AUTH, client);

    const first = enqueue(AUTH, { prompt: "first" });
    const sawFirst = updates().length;
    expect(sawFirst).toBeGreaterThanOrEqual(1);

    // A second enqueue must push the SECOND task only. Without an advancing
    // watermark every flush would re-broadcast the whole board, so this count
    // would grow quadratically as the board fills.
    const second = enqueue(AUTH, { prompt: "second" });
    const newDeltas = updates()
      .slice(sawFirst)
      .map((m) => (m as { delta: { task?: { id: string } } }).delta.task?.id)
      .filter((id): id is string => id !== undefined);

    expect(newDeltas).toContain(second);
    expect(newDeltas).not.toContain(first);
  });

  test("fleet.unsubscribe stops the stream", async () => {
    const { client, updates } = mkClient("c10");
    await manager.handle(subscribeMsg("1"), AUTH, client);

    const unsub = parseClientMessage({ type: "fleet.unsubscribe", id: "2" });
    if (!unsub.ok) throw new Error("unsubscribe rejected");
    const resp = await manager.handle(unsub.value, AUTH, client);
    expect(resp.type).toBe("response.ok");

    enqueue(AUTH);
    expect(updates()).toHaveLength(0);
  });

  test("a disconnected client is reaped, not pushed at forever", async () => {
    const { client, updates } = mkClient("c11");
    await manager.handle(subscribeMsg("1"), AUTH, client);

    manager.disconnectClient(client.id);

    enqueue(AUTH);
    expect(updates()).toHaveLength(0);
  });

  test("with no subscribers a board change costs nothing", () => {
    // Must not throw and must not need a watermark — the dispatcher signals on
    // EVERY tick, including on a daemon nobody is watching.
    expect(() => enqueue(AUTH)).not.toThrow();
  });
});
