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
    expect(store.dispatchHold(id, old.generation, "stale approval", 400, 1_000_000)).toBe(false);
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
  const HOLD_END = 1_000_000;
  const attempt = (o: Partial<Parameters<Store["dispatchEnqueue"]>[0]> = {}) =>
    enqueueRow({ kind: "attempt", runId: "run", attemptId: `att-${seq + 1}`, failureLimit: 1, ...o });

  test("only a loop attempt can be held — a spawn with nobody to release it is refused", () => {
    const spawn = enqueueRow();
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    expect(claim.id).toBe(spawn);
    expect(store.dispatchHold(spawn, claim.generation, "approval", 101, HOLD_END)).toBe(false);
    expect(store.dispatchGet(spawn)!.status).toBe("claimed");
  });

  test("this boot's hold survives lease expiry until it lapses, then is reclaimed terminal", () => {
    const id = attempt();
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    expect(store.dispatchHold(id, claim.generation, "approval", 150, HOLD_END)).toBe(true);
    expect(store.dispatchGet(id)!.heldUntil).toBe(HOLD_END);
    // Long past the lease, inside the hold: untouched.
    expect(store.dispatchReclaimStale("boot-1", LEASE_MS, HOLD_END - 1)).toEqual([]);
    expect(store.dispatchGet(id)!.status).toBe("held");
    // Past the hold: dead, and an attempt is never re-queued.
    const [reclaimed] = store.dispatchReclaimStale("boot-1", LEASE_MS, HOLD_END + 1);
    expect(reclaimed!.status).toBe("failed");
    expect(reclaimed!.heldUntil).toBeNull();
    expect(reclaimed!.generation).toBe(claim.generation + 1);
    expect(reclaimed!.error).toMatch(/hold lapsed/);
  });

  test("a hold placed by a previous boot of this daemon is reclaimed on the next boot", () => {
    const id = attempt({ ownerDaemon: "host:1" });
    const claim = store.dispatchClaimNext("boot-OLD", 100, [], "host:1")!;
    store.dispatchHold(id, claim.generation, "approval", 150, HOLD_END, "host:1");
    expect(store.dispatchReclaimStale("boot-NEW", LEASE_MS, 200, "host:1").map((t) => t.id)).toEqual([id]);
    expect(store.dispatchGet(id)!.status).toBe("failed");
  });

  test("another daemon's hold is neither reclaimed on boot mismatch nor resumable from here", () => {
    const id = attempt({ ownerDaemon: "host:A" });
    const claim = store.dispatchClaimNext("boot-A", 100, [], "host:A")!;
    expect(store.dispatchHold(id, claim.generation, "x", 101, HOLD_END, "host:B")).toBe(false);
    expect(store.dispatchHold(id, claim.generation, "x", 101, HOLD_END, "host:A")).toBe(true);
    expect(store.dispatchReclaimStale("boot-B", LEASE_MS, 200, "host:B")).toEqual([]);
    expect(store.dispatchUnhold(id, claim.generation, "boot-A", 300, "host:B")).toBe(false);
    expect(store.dispatchSettleHeld(id, claim.generation, "x", 300, "host:B")).toBeNull();
    expect(store.dispatchCancelAttempt(id, "x", 300, "host:B")).toBeNull();
    expect(store.dispatchGet(id)!.status).toBe("held");
  });

  test("unhold resumes only under the boot that held it, with a fresh lease and the same generation", () => {
    const id = attempt();
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    store.dispatchHold(id, claim.generation, "approval", 150, HOLD_END);
    expect(store.dispatchUnhold(id, claim.generation + 1, "boot-1", 5_000)).toBe(false);
    expect(store.dispatchUnhold(id, claim.generation, "boot-OTHER", 5_000)).toBe(false);
    expect(store.dispatchUnhold(id, claim.generation, "boot-1", 5_000)).toBe(true);
    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("running");
    expect(row.claimedAt).toBe(5_000);
    expect(row.heldUntil).toBeNull();
    expect(row.generation).toBe(claim.generation);
    // The worker's result, at the unchanged generation, still applies.
    expect(store.dispatchComplete(id, claim.generation, "ok", 7_000)).toBe(true);
  });

  test("a held attempt holds a worker slot but stays off the fleet board", () => {
    const queued = attempt();
    expect(store.dispatchHold(queued, 0, "nope", 100, HOLD_END)).toBe(false);
    const claim = store.dispatchClaimNext("boot-1", 100)!;
    store.dispatchHold(claim.id, claim.generation, "approval", 101, HOLD_END);
    expect(store.dispatchActiveSpawnCount(TENANT.accountId, TENANT.projectId)).toBe(1);
    expect(store.dispatchStatusCounts(TENANT.accountId, TENANT.projectId).active).toBe(0);
    expect(store.dispatchListForTenant(TENANT.accountId, TENANT.projectId)).toEqual([]);
    expect(store.dispatchTasksUpdatedSince(TENANT.accountId, TENANT.projectId, 0)).toEqual([]);
  });

  test("cancel ends an attempt from any live state and fences its worker", () => {
    for (const stage of ["queued", "claimed", "held"] as const) {
      const id = attempt();
      let gen = 0;
      if (stage !== "queued") {
        gen = store.dispatchClaimNext("boot-1", 100, [])!.generation;
        if (stage === "held") store.dispatchHold(id, gen, "approval", 101, HOLD_END);
      }
      const row = store.dispatchCancelAttempt(id, "run cancelled", 200);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe("run cancelled");
      expect(store.dispatchComplete(id, gen, "late", 300)).toBe(false);
      expect(store.dispatchCancelAttempt(id, "again", 400)).toBeNull();
    }
    const spawn = enqueueRow();
    expect(store.dispatchCancelAttempt(spawn, "not an attempt", 500)).toBeNull();
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
    db.exec("ALTER TABLE dispatch_tasks DROP COLUMN held_until");
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
        expect.arrayContaining(["run_id", "attempt_id", "generation", "held_until"]),
      );
      const row = upgraded.dispatchGet("pre-upgrade")!;
      expect(row.generation).toBe(0);
      expect(row.runId).toBeNull();
      expect(row.attemptId).toBeNull();
      expect(row.heldUntil).toBeNull();
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

/**
 * Wait for a condition the dispatcher reaches asynchronously (a worker's turn
 * end is handled on a detached promise). Polls on the event loop rather than
 * sleeping a guessed interval, and fails loudly instead of passing on timing.
 */
async function until(pred: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await Bun.sleep(0);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Drain pending microtasks/immediates so "nothing happened" is actually settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

const statusOf = (id: string) => store.dispatchGet(id)!.status;

/** Minimal scriptable host — no attempt hooks (a daemon without a loop service). */
class FakeHost implements DispatcherHost {
  spawned: DispatchTaskRow[] = [];
  destroyed: string[] = [];
  delivered: DispatchEventRow[][] = [];
  audits: string[] = [];
  statuses = new Map<string, SessionStatus>();
  continueSucceeds = true;
  /** Runs inside continueWorker/continueAttempt before it resolves — a slow start. */
  duringContinue: (() => void) | null = null;
  #next = 0;

  async sendToSession(): Promise<void> {}

  async spawnWorker(task: DispatchTaskRow): Promise<{ sessionId: string }> {
    this.spawned.push(task);
    const sessionId = `worker-${++this.#next}`;
    this.statuses.set(sessionId, "thinking");
    return { sessionId };
  }

  async continueWorker(task: DispatchTaskRow): Promise<boolean> {
    this.duringContinue?.();
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
  orphans: string[] = [];
  /** Runs inside spawnAttemptWorker before it resolves — a slow start. */
  duringAttemptSpawn: (() => void) | null = null;
  #nextAttempt = 0;

  async spawnAttemptWorker(task: DispatchTaskRow): Promise<{ sessionId: string }> {
    this.attemptSpawned.push(task);
    this.duringAttemptSpawn?.();
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

  onAttemptOrphanWorker(_task: DispatchTaskRow, sessionId: string): void {
    this.orphans.push(sessionId);
  }
}

function makeDispatcher(
  host: DispatcherHost,
  over: Partial<ConstructorParameters<typeof Dispatcher>[2]> = {},
): Dispatcher {
  return new Dispatcher(store, host, {
    tickMs: 999_999,
    leaseMs: LEASE_MS,
    failureLimit: 3,
    maxConcurrentWorkers: 4,
    workerToolBudget: 10,
    retryBaseMs: 0,
    ...over,
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

function enqueueAttempt(d: Dispatcher, attemptId = "attempt-1"): string {
  return d.enqueue({
    ...TENANT,
    kind: "attempt",
    shape: "ship",
    workdir: "/tmp/w",
    prompt: "make the failing test pass",
    runId: "run-1",
    attemptId,
    createdBy: "wimse://test/loop",
  });
}

/** Start an attempt and park it on an approval, as a loop would. */
async function heldAttempt(d: Dispatcher, host: LoopHost): Promise<{ id: string; gen: number }> {
  const id = enqueueAttempt(d);
  await d.tick();
  d.onSessionStatus("attempt-worker-1", "waiting_approval");
  host.statuses.set("attempt-worker-1", "waiting_approval");
  const waiting = host.waiting.at(-1)!;
  expect(d.hold(waiting.id, waiting.generation, "approval outside the run's profile")).toBe(true);
  return { id, gen: waiting.generation };
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

    // Boot B reclaims and re-claims; worker-1 did not survive as far as B can
    // tell, so it spawns worker-2.
    host.continueSucceeds = false;
    expireLease(id); // unowned rows (no daemonId) are reclaimed on lease expiry only
    const bootB = makeDispatcher(host);
    await bootB.tick();
    let row = store.dispatchGet(id)!;
    expect(row.workerSessionId).toBe("worker-2");
    expect(row.generation).toBe(3);

    // worker-1 finishes: boot A still watches it, at generation 1.
    bootA.onSessionStatus("worker-1", "idle");
    await until(() => host.audits.some((a) => a.startsWith("dispatch.stale_result")), "stale audit");
    row = store.dispatchGet(id)!;
    expect(row.status).toBe("running");
    expect(row.resultDigest).toBeNull();
    expect(host.audits.some((a) => a.startsWith("dispatch.stale_result") && a.includes("generation=1"))).toBe(true);
    expect(allEvents(host).some((e) => e.type === "task_done")).toBe(false);
    // The stale path tears nothing down — worker-2 is someone else's now.
    expect(host.destroyed).toEqual([]);

    bootB.onSessionStatus("worker-2", "idle");
    await until(() => statusOf(id) === "done", "done");
    await until(() => allEvents(host).some((e) => e.type === "task_done"), "task_done");
    expect(allEvents(host).filter((e) => e.type === "task_done")).toHaveLength(1);
    expect(host.destroyed).toEqual(["worker-2"]);
  });

  test("two generations on one continued worker: only the current one's result applies", async () => {
    // A reclaim that CONTINUES the same session is the case a session-keyed
    // fence cannot handle: both generations watch the same worker, and the
    // same idle transition reaches both. Only the generation fence tells them
    // apart.
    const host = new FakeHost();
    const bootA = makeDispatcher(host);
    const id = enqueueSpawn(bootA);
    await bootA.tick();
    expireLease(id);
    const bootB = makeDispatcher(host);
    await bootB.tick(); // reclaim (gen 2) → re-claim (gen 3) → continue worker-1
    expect(host.spawned).toHaveLength(1);
    expect(store.dispatchGet(id)!.generation).toBe(3);
    expect(bootA.tasksForSession("worker-1")).toEqual([id]);
    expect(bootB.tasksForSession("worker-1")).toEqual([id]);

    bootA.onSessionStatus("worker-1", "idle"); // gen 1 — fenced
    await until(() => host.audits.some((a) => a.startsWith("dispatch.stale_result")), "stale audit");
    expect(statusOf(id)).toBe("running");
    bootB.onSessionStatus("worker-1", "idle"); // gen 3 — applies
    await until(() => statusOf(id) === "done", "done");
    expect(host.destroyed).toEqual(["worker-1"]);
  });

  test("a continued worker that comes up after its claim was replaced is not destroyed", async () => {
    // The continued session predates the call — the successor may own it now.
    const host = new FakeHost();
    const d = makeDispatcher(host);
    const id = enqueueSpawn(d);
    await d.tick();
    expireLease(id);
    host.duringContinue = () => {
      host.duringContinue = null;
      // The continue is slow: another reclaim lands before it resolves.
      expireLease(id);
      store.dispatchReclaimStale("boot-other", LEASE_MS, Date.now());
    };
    await d.tick();
    expect(host.audits.some((a) => a.startsWith("dispatch.stale_result") && a.includes("fresh=false"))).toBe(true);
    expect(host.destroyed).toEqual([]);
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
  });
});

describe("dispatcher — held attempts", () => {
  test("hold is refused for a spawn", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueSpawn(d);
    await d.tick();
    expect(d.hold(id, store.dispatchGet(id)!.generation, "approval")).toBe(false);
    expect(statusOf(id)).toBe("running");
  });

  test("hold survives lease expiry; unhold resumes and the worker's result applies", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const { id, gen } = await heldAttempt(d, host);
    expect(d.hold(id, gen + 1, "stale")).toBe(false);
    expect(d.tasksForSession("attempt-worker-1")).toEqual([]);

    expireLease(id);
    await d.tick();
    expect(statusOf(id)).toBe("held");

    host.statuses.set("attempt-worker-1", "thinking");
    expect(await d.unhold(id, gen)).toBe(true);
    expect(d.tasksForSession("attempt-worker-1")).toEqual([id]);
    d.onSessionStatus("attempt-worker-1", "idle");
    await until(() => host.settled.length > 0, "settled");
    expect(host.settled.map((s) => s.status)).toEqual(["done"]);
    expect(statusOf(id)).toBe("done");
  });

  test("a held row across a restart settles `reclaimed` on the new boot's first tick", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const { id } = await heldAttempt(d, host);
    await makeDispatcher(host).tick();
    expect(statusOf(id)).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["reclaimed"]);
    expect(host.destroyed).toEqual([]);
  });

  test("an unhold that races the restart reconcile never reads the worker's idle as success", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const { id, gen } = await heldAttempt(d, host);
    host.statuses.set("attempt-worker-1", "idle"); // the turn ended while the daemon was down
    const restarted = makeDispatcher(host);
    expect(await restarted.unhold(id, gen)).toBe(false);
    expect(statusOf(id)).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["reclaimed"]);
  });

  test("unhold of a worker that settled while held finishes the task immediately", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const { id, gen } = await heldAttempt(d, host);
    // The approval was granted out of band and the turn ran to the end while
    // nobody was watching — no transition will ever arrive for it.
    host.statuses.set("attempt-worker-1", "idle");
    d.onSessionStatus("attempt-worker-1", "idle");
    expect(statusOf(id)).toBe("held");

    expect(await d.unhold(id, gen)).toBe(true);
    expect(statusOf(id)).toBe("done");
    expect(host.settled.map((s) => s.status)).toEqual(["done"]);
  });

  test("unhold when the worker session is gone fails the attempt at once", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const { id, gen } = await heldAttempt(d, host);
    host.statuses.delete("attempt-worker-1");
    expect(await d.unhold(id, gen)).toBe(false);
    expect(statusOf(id)).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["failed"]);
  });

  test("unhold while the worker is still waiting on an approval reports it to the loop again", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const { id, gen } = await heldAttempt(d, host);
    expect(host.waiting).toHaveLength(1);
    expect(await d.unhold(id, gen)).toBe(true);
    expect(host.waiting).toHaveLength(2);
    expect(host.waiting[1]!.status).toBe("running");
    expect(d.tasksForSession("attempt-worker-1")).toEqual([id]);
  });

  test("an expired hold frees its worker slot for queued work", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host, { maxConcurrentWorkers: 1 });
    const { id } = await heldAttempt(d, host);
    const spawn = enqueueSpawn(d);
    await d.tick();
    expect(statusOf(spawn)).toBe("queued"); // the held attempt still occupies the slot

    store.database.prepare("UPDATE dispatch_tasks SET held_until = 1 WHERE id = ?").run(id);
    await d.tick();
    expect(statusOf(id)).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["reclaimed"]);
    expect(statusOf(spawn)).toBe("running");
  });

  test("the hold window comes from config", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host, { holdMaxMs: 5_000 });
    const before = Date.now();
    const { id } = await heldAttempt(d, host);
    const until_ = store.dispatchGet(id)!.heldUntil!;
    expect(until_).toBeGreaterThanOrEqual(before + 5_000);
    expect(until_).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  test("cancel of a held attempt settles it `failed` and fences its worker", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const { id, gen } = await heldAttempt(d, host);
    expect(d.cancel(id, "run cancelled by owner")).toBe(true);
    expect(statusOf(id)).toBe("failed");
    expect(store.dispatchGet(id)!.error).toBe("run cancelled by owner");
    expect(host.settled.map((s) => s.status)).toEqual(["failed"]);
    expect(await d.unhold(id, gen)).toBe(false);
    expect(d.cancel(id, "again")).toBe(false);
    expect(host.settled).toHaveLength(1);
  });

  test("cancel of a running attempt drops the watch, so its late turn is ignored", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    expect(d.cancel(id, "stop")).toBe(true);
    expect(d.tasksForSession("attempt-worker-1")).toEqual([]);
    d.onSessionStatus("attempt-worker-1", "idle");
    await settle();
    expect(statusOf(id)).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["failed"]);
  });

  test("hold, unhold and cancel are scoped to the owning daemon", async () => {
    const host = new LoopHost();
    const mine = makeDispatcher(host, { daemonId: "host:A" });
    const other = makeDispatcher(host, { daemonId: "host:B" });
    const id = enqueueAttempt(mine);
    await mine.tick();
    const gen = store.dispatchGet(id)!.generation;

    expect(other.hold(id, gen, "not yours")).toBe(false);
    expect(mine.hold(id, gen, "approval")).toBe(true);
    expect(await other.unhold(id, gen)).toBe(false);
    expect(other.cancel(id, "not yours")).toBe(false);
    expect(statusOf(id)).toBe("held");
    expect(host.settled).toEqual([]);

    expect(mine.cancel(id, "mine")).toBe(true);
    expect(statusOf(id)).toBe("failed");
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
    await until(() => host.settled.length > 0, "settled");
    await d.tick();
    expect(statusOf(id)).toBe("done");
    expect(host.settled.map((s) => s.status)).toEqual(["done"]);
    expect(host.settled[0]!.task.status).toBe("done");
    expect(host.destroyed).toEqual([]);
    expect(allEvents(host)).toEqual([]);
  });

  test("an approval wedge reports to the loop, not the conductor", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    d.onSessionStatus("attempt-worker-1", "waiting_approval");
    await d.tick();
    expect(host.waiting.map((t) => t.id)).toEqual([id]);
    expect(allEvents(host)).toEqual([]);
    expect(statusOf(id)).toBe("running"); // not failed
  });

  test("a reclaim is terminal and reported as `reclaimed`; the queue never re-runs it", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    expireLease(id);
    await d.tick();
    await d.tick();
    expect(statusOf(id)).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["reclaimed"]);
    expect(host.attemptSpawned).toHaveLength(1);
    expect(host.destroyed).toEqual([]);
    expect(allEvents(host)).toEqual([]);
  });

  test("a worker started after its attempt was reclaimed is reported, not orphaned", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    host.duringAttemptSpawn = () => {
      // The start outlives the lease: the attempt is reclaimed mid-spawn.
      expireLease(id);
      store.dispatchReclaimStale("boot-other", LEASE_MS, Date.now());
    };
    await d.tick();
    expect(statusOf(id)).toBe("failed");
    expect(host.orphans).toEqual(["attempt-worker-1"]);
    expect(host.destroyed).toEqual([]);
    expect(d.tasksForSession("attempt-worker-1")).toEqual([]);
  });

  test("a worker error settles the attempt as `failed` without a retry", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    const id = enqueueAttempt(d);
    await d.tick();
    d.onSessionStatus("attempt-worker-1", "error");
    await until(() => host.settled.length > 0, "settled");
    await d.tick();
    expect(statusOf(id)).toBe("failed");
    expect(host.settled.map((s) => s.status)).toEqual(["failed"]);
    expect(host.attemptSpawned).toHaveLength(1);
    expect(allEvents(host)).toEqual([]);
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
  });

  test("attempts count against the per-tenant worker cap", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host, { maxConcurrentWorkers: 1 });
    enqueueAttempt(d);
    const spawn = enqueueSpawn(d);
    await d.tick();
    expect(host.attemptSpawned).toHaveLength(1);
    expect(host.spawned).toEqual([]);
    expect(statusOf(spawn)).toBe("queued");
  });

  test("attempts stay off the conductor's board and its deltas", async () => {
    const host = new LoopHost();
    const d = makeDispatcher(host);
    enqueueAttempt(d);
    const spawn = enqueueSpawn(d);
    await d.tick();
    expect(store.dispatchListForTenant(TENANT.accountId, TENANT.projectId).map((t) => t.id)).toEqual([spawn]);
    expect(store.dispatchTasksUpdatedSince(TENANT.accountId, TENANT.projectId, 0).map((t) => t.id)).toEqual([
      spawn,
    ]);
    expect(store.dispatchStatusCounts(TENANT.accountId, TENANT.projectId).active).toBe(1);
  });
});
