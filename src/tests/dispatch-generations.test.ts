/**
 * Claim generations, `held` tasks, and loop-attempt routing on the dispatch
 * queue (docs/loop-engineering-design.md §5, §6 "Restart guarantees").
 *
 * The bug these fence: `dispatchComplete` updated by id alone, so a worker
 * replaced after a reclaim — still alive, finishing late — overwrote the
 * outcome its successor recorded, or resurrected a task that had already gone
 * terminal. Every worker result now presents the generation it was started
 * under, and only that generation of a live claim applies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttemptSettledStatus,
  Dispatcher,
  type DispatcherHost,
} from "../daemon/dispatch.js";
import { type DispatchEventRow, type DispatchTaskRow, Store } from "../daemon/store.js";
import type { SessionStatus } from "../protocol/types.js";

const TENANT = { accountId: "acc-a", projectId: "proj-a" };
const LEASE_MS = 60_000;

let tmp: string;
let store: Store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-dispatch-gen-"));
  store = new Store(join(tmp, "codeoid.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function enqueueRow(overrides: Partial<Parameters<Store["dispatchEnqueue"]>[0]> = {}): string {
  seq += 1;
  const id = overrides.id ?? `task-${seq}`;
  store.dispatchEnqueue({
    id,
    ...TENANT,
    kind: "spawn",
    shape: "scout",
    workdir: "/tmp/w",
    prompt: "do the thing",
    failureLimit: 3,
    createdBy: "wimse://test/conductor",
    now: seq,
    ...overrides,
  });
  return id;
}

/** Age a task's lease so the next reclaim treats it as dead. */
function expireLease(id: string): void {
  store.database.prepare("UPDATE dispatch_tasks SET claimed_at = 1 WHERE id = ?").run(id);
}

// ── Store ─────────────────────────────────────────────────────────────────

describe("dispatch store — claim generations", () => {
  test("every claim and every reclaim bumps the generation", () => {
    const id = enqueueRow();
    expect(store.dispatchGet(id)!.generation).toBe(0);
    expect(store.dispatchClaimNext("boot-1", 100)!.generation).toBe(1);
    // A reclaim fences the dead worker at once, not only at the next claim.
    expect(store.dispatchReclaimStale("boot-2", LEASE_MS, 200)[0]!.generation).toBe(2);
    expect(store.dispatchClaimNext("boot-2", 300)!.generation).toBe(3);
  });

  test("a stale worker's completion after reclaim + re-claim is a no-op; the successor's applies", () => {
    const id = enqueueRow();
    const old = store.dispatchClaimNext("boot-1", 100)!;
    expect(store.dispatchMarkRunning(id, old.generation, "worker-1", 100)).toBe(true);
    store.dispatchReclaimStale("boot-2", LEASE_MS, 200);
    const fresh = store.dispatchClaimNext("boot-2", 300)!;
    expect(store.dispatchMarkRunning(id, fresh.generation, "worker-2", 300)).toBe(true);

    // The replaced worker finishes late — every result path refuses it.
    expect(store.dispatchComplete(id, old.generation, "stale digest", 400)).toBe(false);
    expect(store.dispatchFail(id, old.generation, "stale error", 400, { retryable: true })).toBeNull();
    expect(store.dispatchMarkRunning(id, old.generation, "worker-1", 400)).toBe(false);
    expect(store.dispatchHold(id, old.generation, "stale approval", 400)).toBe(false);
    let row = store.dispatchGet(id)!;
    expect(row.status).toBe("running");
    expect(row.workerSessionId).toBe("worker-2");
    expect(row.resultDigest).toBeNull();

    expect(store.dispatchComplete(id, fresh.generation, "real digest", 500)).toBe(true);
    row = store.dispatchGet(id)!;
    expect(row.status).toBe("done");
    expect(row.resultDigest).toBe("real digest");
  });

  test("a terminal task cannot be completed or failed again, even at its own generation", () => {
    const id = enqueueRow();
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    expect(store.dispatchFail(id, claim.generation, "gone", 101, { retryable: false })).toBe("failed");
    // Previously this resurrected a failed task as `done`.
    expect(store.dispatchComplete(id, claim.generation, "late", 102)).toBe(false);
    expect(store.dispatchGet(id)!.status).toBe("failed");
  });

  test("a stale lease renewal does not keep the successor's claim fresh", () => {
    const id = enqueueRow();
    const old = store.dispatchClaimNext("boot-1", 1_000)!;
    store.dispatchReclaimStale("boot-2", LEASE_MS, 2_000);
    store.dispatchClaimNext("boot-2", 3_000);
    store.dispatchTouch([{ id, generation: old.generation }], 50_000);
    expect(store.dispatchGet(id)!.claimedAt).toBe(3_000);
  });
});

describe("dispatch store — held tasks", () => {
  test("a held task is never reclaimed, by boot mismatch or by lease expiry", () => {
    const id = enqueueRow();
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    expect(store.dispatchHold(id, claim.generation, "waiting on approval", 150)).toBe(true);
    expect(store.dispatchReclaimStale("boot-2", LEASE_MS, 10_000_000)).toEqual([]);
    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("held");
    expect(row.attempts).toBe(0);
    expect(row.generation).toBe(claim.generation);
  });

  test("unhold resumes under the caller's boot with a fresh lease and the same generation", () => {
    const id = enqueueRow();
    const claim = store.dispatchClaimNext("boot-OLD", 100)!;
    store.dispatchHold(id, claim.generation, "approval", 150);
    expect(store.dispatchUnhold(id, claim.generation + 1, "boot-NEW", 5_000)).toBe(false);
    expect(store.dispatchUnhold(id, claim.generation, "boot-NEW", 5_000)).toBe(true);
    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("running");
    expect(row.claimOwner).toBe("boot-NEW");
    expect(row.claimedAt).toBe(5_000);
    expect(row.generation).toBe(claim.generation);
    // Re-owned, so the new boot's fast path does not take it for a crash.
    expect(store.dispatchReclaimStale("boot-NEW", LEASE_MS, 6_000)).toEqual([]);
    // And the worker's result, at the unchanged generation, still applies.
    expect(store.dispatchComplete(id, claim.generation, "ok", 7_000)).toBe(true);
  });

  test("only a live claim can be held, and a held task is still active and still a worker", () => {
    const queued = enqueueRow();
    expect(store.dispatchHold(queued, 0, "nope", 100)).toBe(false);
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    store.dispatchHold(claim.id, claim.generation, "approval", 101);
    expect(store.dispatchStatusCounts(TENANT.accountId, TENANT.projectId).active).toBe(1);
    expect(store.dispatchActiveSpawnCount(TENANT.accountId, TENANT.projectId)).toBe(1);
  });
});

describe("dispatch store — attempt tasks", () => {
  test("run and attempt ids round-trip", () => {
    const id = enqueueRow({ kind: "attempt", runId: "run-1", attemptId: "att-1", failureLimit: 1 });
    const row = store.dispatchGet(id)!;
    expect(row.kind).toBe("attempt");
    expect(row.runId).toBe("run-1");
    expect(row.attemptId).toBe("att-1");
  });

  test("a reclaimed attempt goes terminal `failed` instead of re-queueing, whatever its limit", () => {
    // failureLimit 3 on purpose: the store's rule, not the row's budget, is what
    // stops the queue retrying an attempt behind the loop's back.
    const id = enqueueRow({ kind: "attempt", runId: "r", attemptId: "a" });
    store.dispatchClaimNext("boot-1", 100);
    const [reclaimed] = store.dispatchReclaimStale("boot-2", LEASE_MS, 200);
    expect(reclaimed!.status).toBe("failed");
    expect(store.dispatchClaimNext("boot-2", 300)).toBeNull();
    expect(store.dispatchGet(id)!.error).toContain("reclaimed");
  });

  test("a retryable failure of an attempt is terminal too", () => {
    const id = enqueueRow({ kind: "attempt", runId: "r", attemptId: "a" });
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    expect(store.dispatchFail(id, claim.generation, "x", 101, { retryable: true })).toBe("failed");
  });
});

describe("migration — opening a database written before generations", () => {
  function downgrade(dbPath: string): void {
    const db = new Database(dbPath);
    // The run index references run_id; SQLite refuses to drop an indexed column.
    db.exec("DROP INDEX IF EXISTS idx_dispatch_run");
    db.exec("ALTER TABLE dispatch_tasks DROP COLUMN generation");
    db.exec("ALTER TABLE dispatch_tasks DROP COLUMN attempt_id");
    db.exec("ALTER TABLE dispatch_tasks DROP COLUMN run_id");
    db.close();
  }

  const columns = (dbPath: string): string[] => {
    const db = new Database(dbPath, { readonly: true });
    const cols = (
      db.prepare("PRAGMA table_info(dispatch_tasks)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    db.close();
    return cols;
  };

  test("adds the columns in place; existing rows read as generation 0 and fence normally", () => {
    const dbPath = join(tmp, "upgrade.db");
    const old = new Store(dbPath);
    old.dispatchEnqueue({
      id: "pre-upgrade",
      ...TENANT,
      kind: "spawn",
      shape: "scout",
      workdir: "/tmp/w",
      prompt: "queued before generations",
      failureLimit: 2,
      createdBy: "conductor",
      now: 1,
    });
    // A claim in flight when the old binary went down.
    old.dispatchClaimNext("boot-OLD", 2);
    old.close();
    downgrade(dbPath);
    expect(columns(dbPath)).not.toContain("generation");

    const upgraded = new Store(dbPath);
    try {
      expect(columns(dbPath)).toEqual(
        expect.arrayContaining(["run_id", "attempt_id", "generation"]),
      );
      const row = upgraded.dispatchGet("pre-upgrade")!;
      expect(row.generation).toBe(0);
      expect(row.runId).toBeNull();
      expect(row.attemptId).toBeNull();
      expect(row.status).toBe("claimed");

      // The old binary's worker presents generation 0; once the new boot
      // reclaims and re-claims, that result no longer applies.
      upgraded.dispatchReclaimStale("boot-NEW", LEASE_MS, 3);
      const fresh = upgraded.dispatchClaimNext("boot-NEW", 4)!;
      expect(fresh.generation).toBe(2);
      expect(upgraded.dispatchComplete("pre-upgrade", 0, "stale", 5)).toBe(false);
      expect(upgraded.dispatchComplete("pre-upgrade", fresh.generation, "ok", 6)).toBe(true);
    } finally {
      upgraded.close();
    }
  });
});

// ── Dispatcher ────────────────────────────────────────────────────────────

/** Minimal scriptable host — no attempt hooks (a daemon without a loop service). */
class FakeHost implements DispatcherHost {
  spawned: DispatchTaskRow[] = [];
  destroyed: string[] = [];
  delivered: DispatchEventRow[][] = [];
  audits: string[] = [];
  statuses = new Map<string, SessionStatus>();
  continueSucceeds = true;
  #next = 0;

  async sendToSession(): Promise<void> {}

  async spawnWorker(task: DispatchTaskRow): Promise<{ sessionId: string }> {
    this.spawned.push(task);
    const sessionId = `worker-${++this.#next}`;
    this.statuses.set(sessionId, "thinking");
    return { sessionId };
  }

  async continueWorker(task: DispatchTaskRow): Promise<boolean> {
    if (this.continueSucceeds && task.workerSessionId) {
      this.statuses.set(task.workerSessionId, "thinking");
      return true;
    }
    return false;
  }

  workerStatus(sessionId: string): SessionStatus | null {
    return this.statuses.get(sessionId) ?? null;
  }

  buildWorkerDigest(task: DispatchTaskRow): string {
    return `digest for ${task.id}`;
  }

  async destroyWorker(sessionId: string): Promise<void> {
    this.destroyed.push(sessionId);
    this.statuses.delete(sessionId);
  }

  async deliverEvents(
    _a: string,
    _p: string,
    events: DispatchEventRow[],
  ): Promise<readonly number[]> {
    this.delivered.push(events);
    return events.map((e) => e.id);
  }

  audit(action: string, detail: string): void {
    this.audits.push(`${action} ${detail}`);
  }
}

/** A host with a loop service behind it. */
class LoopHost extends FakeHost {
  attemptSpawned: DispatchTaskRow[] = [];
  settled: Array<{ task: DispatchTaskRow; status: AttemptSettledStatus }> = [];
  waiting: DispatchTaskRow[] = [];
  #nextAttempt = 0;

  async spawnAttemptWorker(task: DispatchTaskRow): Promise<{ sessionId: string }> {
    this.attemptSpawned.push(task);
    const sessionId = `attempt-worker-${++this.#nextAttempt}`;
    this.statuses.set(sessionId, "thinking");
    return { sessionId };
  }

  onAttemptSettled(task: DispatchTaskRow, status: AttemptSettledStatus): void {
    this.settled.push({ task, status });
  }

  onAttemptWaiting(task: DispatchTaskRow): void {
    this.waiting.push(task);
  }
}

function makeDispatcher(host: DispatcherHost): Dispatcher {
  return new Dispatcher(store, host, {
    tickMs: 999_999,
    leaseMs: LEASE_MS,
    failureLimit: 3,
    maxConcurrentWorkers: 4,
    workerToolBudget: 10,
    retryBaseMs: 0,
  });
}

function enqueueSpawn(d: Dispatcher): string {
  return d.enqueue({
    ...TENANT,
    kind: "spawn",
    shape: "scout",
    workdir: "/tmp/w",
    prompt: "investigate",
    createdBy: "wimse://test/conductor",
  });
}

function enqueueAttempt(d: Dispatcher): string {
  return d.enqueue({
    ...TENANT,
    kind: "attempt",
    shape: "ship",
    workdir: "/tmp/w",
    prompt: "make the failing test pass",
    runId: "run-1",
    attemptId: "attempt-1",
    createdBy: "wimse://test/loop",
  });
}

const allEvents = (host: FakeHost) => host.delivered.flat();

describe("dispatcher — stale workers are fenced", () => {
  test("a replaced worker finishing late changes nothing; its successor's completion applies", async () => {
    const host = new FakeHost();
    // Boot A starts worker-1, then "crashes" — but the object (and the worker
    // it watches) is still around, which is what a slow-dying process or a
    // worker outliving its daemon looks like.
    const bootA = makeDispatcher(host);
    const id = enqueueSpawn(bootA);
    await bootA.tick();
    expect(store.dispatchGet(id)!.workerSessionId).toBe("worker-1");

    // Boot B reclaims and re-claims; worker-1 did not survive
    // as far as B can tell, so it spawns worker-2.
    host.continueSucceeds = false;
    expireLease(id); // unowned rows (no daemonId) are reclaimed on lease expiry only
    const bootB = makeDispatcher(host);
    await bootB.tick();
    let row = store.dispatchGet(id)!;
    expect(row.workerSessionId).toBe("worker-2");
    expect(row.generation).toBe(3);

    // worker-1 finishes: boot A still watches it, at generation 1.
    bootA.onSessionStatus("worker-1", "idle");
    await Bun.sleep(10);
    row = store.dispatchGet(id)!;
    expect(row.status).toBe("running");
    expect(row.resultDigest).toBeNull();
    expect(host.audits.some((a) => a.startsWith("dispatch.stale_result") && a.includes("generation=1"))).toBe(true);
    expect(allEvents(host).some((e) => e.type === "task_done")).toBe(false);
    // The stale path tears nothing down — worker-2 is someone else's now.
    expect(host.destroyed).toEqual([]);

    bootB.onSessionStatus("worker-2", "idle");
    await Bun.sleep(10);
    row = store.dispatchGet(id)!;
    expect(row.status).toBe("done");
    expect(allEvents(host).filter((e) => e.type === "task_done")).toHaveLength(1);
    expect(host.destroyed).toEqual(["worker-2"]);
    bootA.stop();
    bootB.stop();
  });

  test("a lease-expired worker is unwatched at reclaim, so its late turn is never routed", async () => {
    const host = new FakeHost();
    const d = makeDispatcher(host);
    const id = enqueueSpawn(d);
    await d.tick();
    host.continueSucceeds = false;
    expireLease(id);
    await d.tick(); // reclaim → re-claim → worker-2
    expect(d.tasksForSession("worker-1")).toEqual([]);
    expect(d.tasksForSession("worker-2")).toEqual([id]);
    d.stop();
  });
});

describe("dispatcher — held tasks", () => {
  test("hold survives lease expiry and a restart; unhold resumes and the worker's result applies", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueSpawn(d);
    await d.tick();
    const gen = store.dispatchGet(id)!.generation;
    expect(d.hold(id, gen + 1, "stale")).toBe(false);
    expect(d.hold(id, gen, "approval outside the profile")).toBe(true);
    expect(d.tasksForSession("worker-1")).toEqual([]);

    expireLease(id);
    const restarted = makeDispatcher(host);
    await restarted.tick();
    expect(store.dispatchGet(id)!.status).toBe("held");
    expect(host.spawned).toHaveLength(1);

    expect(await restarted.unhold(id, gen)).toBe(true);
    expect(restarted.tasksForSession("worker-1")).toEqual([id]);
    restarted.onSessionStatus("worker-1", "idle");
    await Bun.sleep(10);
    expect(store.dispatchGet(id)!.status).toBe("done");
    d.stop();
    restarted.stop();
  });

  test("unhold of a worker that settled while held finishes the task immediately", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueSpawn(d);
    await d.tick();
    const gen = store.dispatchGet(id)!.generation;
    d.hold(id, gen, "approval");
    // The approval was granted out of band and the turn ran to the end while
    // nobody was watching — no transition will ever arrive for it.
    host.statuses.set("worker-1", "idle");
    d.onSessionStatus("worker-1", "idle");
    expect(store.dispatchGet(id)!.status).toBe("held");

    await d.unhold(id, gen);
    await Bun.sleep(10);
    expect(store.dispatchGet(id)!.status).toBe("done");
    d.stop();
  });
});

describe("dispatcher — attempt tasks", () => {
  test("enqueue insists on loop ids for attempts and refuses them elsewhere", () => {
    const d = makeDispatcher(new LoopHost());
    expect(() =>
      d.enqueue({ ...TENANT, kind: "attempt", shape: "ship", prompt: "x", createdBy: "c" }),
    ).toThrow(/runId and attemptId/);
    expect(() =>
      d.enqueue({
        ...TENANT,
        kind: "spawn",
        shape: "ship",
        prompt: "x",
        createdBy: "c",
        runId: "r",
        attemptId: "a",
      }),
    ).toThrow(/only valid on an attempt/);
  });

  test("routes to the host's attempt hooks: no fleet events, no teardown", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    expect(store.dispatchGet(id)!.failureLimit).toBe(1);
    await d.tick();
    expect(host.spawned).toEqual([]);
    expect(host.attemptSpawned.map((t) => t.attemptId)).toEqual(["attempt-1"]);

    d.onSessionStatus("attempt-worker-1", "idle");
    await Bun.sleep(10);
    await d.tick();
    expect(store.dispatchGet(id)!.status).toBe("done");
    expect(host.settled.map((s) => s.status)).toEqual(["done"]);
    expect(host.settled[0]!.task.status).toBe("done");
    expect(host.destroyed).toEqual([]);
    expect(allEvents(host)).toEqual([]);
    d.stop();
  });

  test("an approval wedge reports to the loop, not the conductor, and the loop can hold it", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    d.onSessionStatus("attempt-worker-1", "waiting_approval");
    await d.tick();
    expect(host.waiting.map((t) => t.id)).toEqual([id]);
    expect(allEvents(host)).toEqual([]);
    expect(store.dispatchGet(id)!.status).toBe("running"); // not failed

    const waiting = host.waiting[0]!;
    expect(d.hold(waiting.id, waiting.generation, "approval outside the run's profile")).toBe(true);
    expireLease(id);
    await makeDispatcher(host).tick();
    expect(store.dispatchGet(id)!.status).toBe("held");
    expect(host.settled).toEqual([]);
    d.stop();
  });

  test("a reclaim is terminal and reported as `reclaimed`; the queue never re-runs it", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    expireLease(id);
    await d.tick();
    await d.tick();
    expect(store.dispatchGet(id)!.status).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["reclaimed"]);
    expect(host.attemptSpawned).toHaveLength(1);
    expect(host.destroyed).toEqual([]);
    expect(allEvents(host)).toEqual([]);
    d.stop();
  });

  test("a worker error settles the attempt as `failed` without a retry", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    d.onSessionStatus("attempt-worker-1", "error");
    await Bun.sleep(10);
    await d.tick();
    expect(store.dispatchGet(id)!.status).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["failed"]);
    expect(host.attemptSpawned).toHaveLength(1);
    expect(allEvents(host)).toEqual([]);
    d.stop();
  });

  test("fails closed on a host without loop support — never runs as an ordinary spawn", async () => {
    const host = new FakeHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/no loop host/);
    expect(host.spawned).toEqual([]);
    expect(allEvents(host)).toEqual([]);
    d.stop();
  });

  test("attempts count against the per-tenant worker cap", async () => {
    const host = new LoopHost();
    const d = new Dispatcher(store, host, {
      tickMs: 999_999,
      leaseMs: LEASE_MS,
      failureLimit: 3,
      maxConcurrentWorkers: 1,
      workerToolBudget: 10,
      retryBaseMs: 0,
    });
    enqueueAttempt(d);
    const spawn = enqueueSpawn(d);
    await d.tick();
    expect(host.attemptSpawned).toHaveLength(1);
    expect(host.spawned).toEqual([]);
    expect(store.dispatchGet(spawn)!.status).toBe("queued");
    d.stop();
  });
});
