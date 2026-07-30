/**
 * Dispatch queue persistence semantics (P4) — the properties the dispatcher
 * builds on: atomic claims, scheduling releases vs failure retries, the
 * reclaim counter doubling as the stuck-loop guard, and durable events.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../daemon/store.js";

let tmp: string;
let store: Store;

const TENANT = { accountId: "acc-a", projectId: "proj-a" };

let seq = 0;
function enqueue(
  overrides: Partial<Parameters<Store["dispatchEnqueue"]>[0]> = {},
): string {
  seq += 1;
  const id = overrides.id ?? `task-${String(seq).padStart(3, "0")}`;
  store.dispatchEnqueue({
    id,
    ...TENANT,
    kind: "spawn",
    shape: "scout",
    workdir: "/tmp/w",
    prompt: "do the thing",
    failureLimit: 2,
    createdBy: "wimse://test/conductor",
    now: seq, // monotonic — deterministic oldest-first ordering
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-dispatch-store-"));
  store = new Store(join(tmp, "codeoid.db"));
  seq = 0;
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("dispatch queue — per-child backend columns (P0)", () => {
  test("provider + model round-trip through enqueue → get → listForTenant", () => {
    const id = enqueue({ provider: "gemini", model: "gemini-2.5-pro" });
    const row = store.dispatchGet(id)!;
    expect(row.provider).toBe("gemini");
    expect(row.model).toBe("gemini-2.5-pro");
    const listed = store.dispatchListForTenant(TENANT.accountId, TENANT.projectId, 10);
    expect(listed[0]!.provider).toBe("gemini");
    expect(listed[0]!.model).toBe("gemini-2.5-pro");
  });

  test("omitting them stores NULL — the pre-collaboration default-backend meaning", () => {
    const row = store.dispatchGet(enqueue())!;
    expect(row.provider).toBeNull();
    expect(row.model).toBeNull();
  });

  test("a provider with no model is valid (provider's own default)", () => {
    const row = store.dispatchGet(enqueue({ provider: "openai" }))!;
    expect(row.provider).toBe("openai");
    expect(row.model).toBeNull();
  });

  test("the selection survives a claim + reclaim cycle", () => {
    const id = enqueue({ provider: "codex", model: "gpt-5-codex" });
    store.dispatchClaimNext("boot-1", 1_000);
    const claimed = store.dispatchGet(id)!;
    expect(claimed.provider).toBe("codex");
    expect(claimed.model).toBe("gpt-5-codex");
    // Reclaimed by a different boot (crash recovery) — still bound to codex.
    const reclaimed = store.dispatchReclaimStale("boot-2", 1_000, 100_000);
    expect(reclaimed.map((r) => r.provider)).toContain("codex");
    expect(store.dispatchGet(id)!.model).toBe("gpt-5-codex");
  });
});

describe("dispatch queue — claims", () => {
  test("claims are oldest-first and exclusive", () => {
    const first = enqueue();
    const second = enqueue();

    const a = store.dispatchClaimNext("boot-1", 100);
    const b = store.dispatchClaimNext("boot-1", 100);
    const c = store.dispatchClaimNext("boot-1", 100);

    expect(a?.id).toBe(first);
    expect(b?.id).toBe(second);
    expect(c).toBeNull(); // nothing queued left — no double-claim possible
    expect(a?.status).toBe("claimed");
    expect(a?.claimOwner).toBe("boot-1");
  });

  test("excluded ids are skipped — the anti-starvation mechanism", () => {
    const spawn = enqueue({ kind: "spawn" }); // oldest
    const send = enqueue({ kind: "send", targetSession: "sess-1", workdir: undefined });

    // With the oldest task excluded (e.g. deferred at the worker cap), the
    // claim moves PAST it instead of head-of-line blocking the queue.
    const claimed = store.dispatchClaimNext("boot-1", 100, [spawn]);
    expect(claimed?.id).toBe(send);
    // Without the exclusion the oldest wins as usual.
    store.dispatchRelease(send, 101);
    expect(store.dispatchClaimNext("boot-1", 102)?.id).toBe(spawn);
  });

  test("release returns a claim untouched — no attempt burned", () => {
    const id = enqueue();
    store.dispatchClaimNext("boot-1", 100);
    store.dispatchRelease(id, 101);

    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.error).toBeNull();
    expect(row.claimOwner).toBeNull();
  });
});

describe("dispatch queue — failure semantics", () => {
  test("retryable failures requeue until failure_limit, then auto-block", () => {
    const id = enqueue(); // failureLimit 2
    store.dispatchClaimNext("boot-1", 100);
    expect(store.dispatchFail(id, "worker died", 101, { retryable: true })).toBe("queued");

    store.dispatchClaimNext("boot-1", 102);
    expect(store.dispatchFail(id, "worker died again", 103, { retryable: true })).toBe(
      "blocked",
    );
    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("blocked");
    expect(row.attempts).toBe(2);
  });

  test("non-retryable failures go terminal immediately", () => {
    const id = enqueue();
    store.dispatchClaimNext("boot-1", 100);
    expect(store.dispatchFail(id, "target gone", 101, { retryable: false })).toBe("failed");
  });

  test("complete stores the digest and clears the error", () => {
    const id = enqueue();
    store.dispatchClaimNext("boot-1", 100);
    store.dispatchFail(id, "first try failed", 101, { retryable: true });
    store.dispatchClaimNext("boot-1", 102);
    store.dispatchComplete(id, "all done", 103);

    const row = store.dispatchGet(id)!;
    expect(row.status).toBe("done");
    expect(row.resultDigest).toBe("all done");
    expect(row.error).toBeNull();
  });
});

describe("dispatch queue — stale-claim reclaim (crash recovery)", () => {
  test("claims held by another boot are reclaimed with attempts++", () => {
    const id = enqueue();
    store.dispatchClaimNext("boot-DEAD", 100);
    store.dispatchMarkRunning(id, "worker-1", 100);

    const reclaimed = store.dispatchReclaimStale("boot-NEW", 60_000, 200);
    expect(reclaimed.map((t) => t.id)).toEqual([id]);
    expect(reclaimed[0]!.status).toBe("queued");
    expect(reclaimed[0]!.attempts).toBe(1);
    // Worker session id survives — the new boot can continue the worker.
    expect(reclaimed[0]!.workerSessionId).toBe("worker-1");
  });

  test("a live claim by THIS boot inside the lease is untouched", () => {
    enqueue();
    store.dispatchClaimNext("boot-1", 1_000);
    const reclaimed = store.dispatchReclaimStale("boot-1", 60_000, 2_000);
    expect(reclaimed).toHaveLength(0);
  });

  test("an expired lease is reclaimed even for the current boot (hung worker)", () => {
    enqueue();
    store.dispatchClaimNext("boot-1", 1_000);
    const reclaimed = store.dispatchReclaimStale("boot-1", 60_000, 1_000 + 60_001);
    expect(reclaimed).toHaveLength(1);
  });

  test("touch renews the lease and prevents reclaim", () => {
    const id = enqueue();
    store.dispatchClaimNext("boot-1", 1_000);
    store.dispatchTouch([id], 50_000);
    const reclaimed = store.dispatchReclaimStale("boot-1", 60_000, 100_000);
    expect(reclaimed).toHaveLength(0);
  });

  test("repeated crash-reclaims burn through the limit and block — the stuck-loop guard", () => {
    const id = enqueue(); // failureLimit 2
    store.dispatchClaimNext("boot-A", 100);
    expect(store.dispatchReclaimStale("boot-B", 60_000, 200)[0]!.status).toBe("queued");
    store.dispatchClaimNext("boot-B", 300);
    const second = store.dispatchReclaimStale("boot-C", 60_000, 400);
    expect(second[0]!.status).toBe("blocked");
    expect(store.dispatchGet(id)!.attempts).toBe(2);
  });
});

describe("dispatch queue — tenancy + counters", () => {
  test("listForTenant never leaks across tenants", () => {
    enqueue();
    enqueue({ accountId: "acc-b", projectId: "proj-b", id: "task-other" });
    const mine = store.dispatchListForTenant(TENANT.accountId, TENANT.projectId);
    expect(mine.map((t) => t.accountId)).toEqual(["acc-a"]);
  });

  test("activeSpawnCount counts claimed+running spawns for one tenant only", () => {
    const a = enqueue();
    enqueue({ kind: "send", targetSession: "s", workdir: undefined });
    enqueue({ accountId: "acc-b", projectId: "proj-b", id: "task-b" });

    store.dispatchClaimNext("boot-1", 100); // claims `a` (oldest)
    store.dispatchMarkRunning(a, "w-1", 100);
    expect(store.dispatchActiveSpawnCount(TENANT.accountId, TENANT.projectId)).toBe(1);
    expect(store.dispatchActiveSpawnCount("acc-b", "proj-b")).toBe(0);
  });
});

describe("dispatch events — durable conductor notifications", () => {
  test("events stay pending until marked delivered, per tenant", () => {
    store.dispatchEventAdd({
      ...TENANT,
      taskId: "task-1",
      type: "task_done",
      digest: "worker finished",
      now: 100,
    });
    store.dispatchEventAdd({
      accountId: "acc-b",
      projectId: "proj-b",
      taskId: "task-2",
      type: "task_failed",
      digest: "other tenant",
      now: 101,
    });

    expect(store.dispatchEventTenants()).toHaveLength(2);
    const mine = store.dispatchEventsPending(TENANT.accountId, TENANT.projectId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.digest).toBe("worker finished");

    store.dispatchEventsMarkDelivered(
      mine.map((e) => e.id),
      200,
    );
    expect(store.dispatchEventsPending(TENANT.accountId, TENANT.projectId)).toHaveLength(0);
    // The other tenant's event is untouched.
    expect(store.dispatchEventTenants()).toEqual([
      { accountId: "acc-b", projectId: "proj-b" },
    ]);
  });
});

// ── The additive-migration path (upgrading an EXISTING database) ─────────────

// Every other test here builds a fresh database, where `CREATE TABLE` declares
// every column and the migration's ALTER path never runs. That blind spot let a
// real bug ship to a live probe: a partial index on `group_id` was declared
// inside the `CREATE TABLE IF NOT EXISTS` block, which is a no-op on an
// existing database — so the index ran before `ADD COLUMN` and SQLite failed
// the whole migration with "no such column: group_id". The daemon then refused
// to open a database it had been using happily.
//
// These tests reproduce the upgrade by removing the columns from a built
// database and reopening it, which is what an older binary's file looks like.
describe("migration — opening a database written before dispatch groups", () => {
  /** Strip the group columns + index, simulating a pre-panel database file. */
  function downgrade(dbPath: string): void {
    const db = new Database(dbPath);
    // Both group indexes reference the columns below; SQLite refuses to drop a
    // column an index depends on, so they go first. The REAL migration only ever
    // ADDS, so this ordering is an artifact of simulating a downgrade.
    db.exec("DROP INDEX IF EXISTS idx_dispatch_group");
    db.exec("DROP INDEX IF EXISTS idx_dispatch_panels");
    db.exec("ALTER TABLE dispatch_tasks DROP COLUMN group_ordinal");
    db.exec("ALTER TABLE dispatch_tasks DROP COLUMN group_id");
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

  test("adds the group columns in place, without losing existing rows", () => {
    const dbPath = join(tmp, "upgrade.db");
    const old = new Store(dbPath);
    old.dispatchEnqueue({
      id: "pre-upgrade-task",
      ...TENANT,
      kind: "send",
      shape: "ship",
      targetSession: "sess-1",
      prompt: "queued before panels existed",
      failureLimit: 2,
      createdBy: "conductor",
      now: Date.now(),
    });
    downgrade(dbPath);
    expect(columns(dbPath)).not.toContain("group_id");

    // Reopening must MIGRATE, not throw. This is the assertion that was missing.
    const upgraded = new Store(dbPath);
    expect(columns(dbPath)).toContain("group_id");
    expect(columns(dbPath)).toContain("group_ordinal");

    // The pre-upgrade row survives and reads as standalone — which is exactly
    // the old behaviour: it keeps emitting its own completion event.
    const row = upgraded.dispatchGet("pre-upgrade-task");
    expect(row?.prompt).toBe("queued before panels existed");
    expect(row?.groupId).toBeNull();
    expect(row?.groupOrdinal).toBeNull();
  });

  test("is idempotent — opening an already-migrated database is a no-op", () => {
    const dbPath = join(tmp, "twice.db");
    new Store(dbPath);
    downgrade(dbPath);
    new Store(dbPath); // migrates
    expect(() => new Store(dbPath)).not.toThrow(); // and again
    expect(columns(dbPath).filter((c) => c === "group_id")).toHaveLength(1);
  });

  test("groups work on an upgraded database, not just a fresh one", () => {
    const dbPath = join(tmp, "grouped.db");
    new Store(dbPath);
    downgrade(dbPath);
    const upgraded = new Store(dbPath);

    upgraded.dispatchEnqueueGroup(
      ["a", "b"].map((t, i) => ({
        id: `g-${t}`,
        ...TENANT,
        kind: "send" as const,
        shape: "scout" as const,
        targetSession: t,
        prompt: "review",
        failureLimit: 2,
        createdBy: "orchestrator:goal-1",
        groupId: "grp-1",
        groupOrdinal: i + 1,
        now: Date.now(),
      })),
    );
    const members = upgraded.dispatchGroupMembers(TENANT.accountId, TENANT.projectId, "grp-1");
    expect(members.map((m) => m.id)).toEqual(["g-a", "g-b"]);
    expect(members.map((m) => m.groupOrdinal)).toEqual([1, 2]);
  });
});

// ── Index coverage for the polled panel query ───────────────────────────────

// `dispatchRecentGroups` backs a client poll that runs every few seconds while a
// collaboration is focused. Without a supporting index SQLite could only use the
// (account, project) index and then filter `created_by` row by row across the
// tenant's ENTIRE task history — measured at 17.8ms per call over 20k tasks, and
// growing with history rather than with panel count. Asserting the PLAN rather
// than a duration, because a timing assertion in CI is a flake generator.
describe("dispatchRecentGroups is index-covered", () => {
  test("seeks on (account, project, created_by) instead of scanning history", () => {
    const dbPath = join(tmp, "plan.db");
    const s = new Store(dbPath);
    // A realistic long-lived daemon: mostly ungrouped conductor tasks, a few panels.
    for (let i = 0; i < 300; i++) {
      s.dispatchEnqueue({
        id: `bulk-${i}`, ...TENANT, kind: "send", shape: "ship",
        targetSession: "t", prompt: "p", failureLimit: 2,
        createdBy: "conductor:acc-a/proj-a", now: i,
      });
    }
    s.dispatchEnqueueGroup(
      [1, 2, 3].map((n) => ({
        id: `grp-${n}`, ...TENANT, kind: "send" as const, shape: "scout" as const,
        targetSession: `kid-${n}`, prompt: "review", failureLimit: 2,
        createdBy: "orchestrator:goal-1", groupId: "g1", groupOrdinal: n, now: 9_000,
      })),
    );

    const db = new Database(dbPath, { readonly: true });
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM dispatch_tasks
             WHERE account_id = ? AND project_id = ? AND created_by = ?
               AND group_id IN (
                 SELECT group_id FROM dispatch_tasks
                  WHERE account_id = ? AND project_id = ? AND created_by = ?
                    AND group_id IS NOT NULL
                  GROUP BY group_id ORDER BY MAX(created_at) DESC LIMIT ?)
             ORDER BY created_at DESC, group_ordinal ASC, id ASC`,
        )
        .all(
          TENANT.accountId, TENANT.projectId, "orchestrator:goal-1",
          TENANT.accountId, TENANT.projectId, "orchestrator:goal-1", 5,
        ) as Array<{ detail: string }>
    ).map((r) => r.detail);
    db.close();

    // Both the outer query and the group subquery must use it — the subquery is
    // the one that would otherwise walk every task the tenant has ever queued.
    const seeks = plan.filter((d) => d.includes("idx_dispatch_panels"));
    expect(seeks.length).toBeGreaterThanOrEqual(2);
    expect(plan.some((d) => /SCAN dispatch_tasks(?!.*USING)/.test(d))).toBe(false);

    // ...and it still returns the right rows, in fan-out order.
    const members = s.dispatchRecentGroups(
      TENANT.accountId, TENANT.projectId, "orchestrator:goal-1", 5,
    );
    expect(members.map((m) => m.groupOrdinal)).toEqual([1, 2, 3]);
    expect(members.every((m) => m.createdBy === "orchestrator:goal-1")).toBe(true);
  });

  test("never returns another dispatcher's groups", () => {
    const s = new Store(join(tmp, "scoped.db"));
    s.dispatchEnqueueGroup([
      { id: "a1", ...TENANT, kind: "send", shape: "scout", targetSession: "k", prompt: "p",
        failureLimit: 2, createdBy: "orchestrator:goal-A", groupId: "gA", groupOrdinal: 1, now: 1 },
      { id: "b1", ...TENANT, kind: "send", shape: "scout", targetSession: "k", prompt: "p",
        failureLimit: 2, createdBy: "orchestrator:goal-B", groupId: "gB", groupOrdinal: 1, now: 2 },
    ]);
    const mine = s.dispatchRecentGroups(TENANT.accountId, TENANT.projectId, "orchestrator:goal-A");
    expect(mine.map((m) => m.id)).toEqual(["a1"]);
    // And a different tenant sees nothing, group id or not.
    expect(s.dispatchRecentGroups("acc-x", "proj-x", "orchestrator:goal-A")).toEqual([]);
  });
});
