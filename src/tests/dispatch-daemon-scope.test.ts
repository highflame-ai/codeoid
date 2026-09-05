/**
 * Dispatch ownership scope — two daemons, one database.
 *
 * `claim_owner` is a daemon BOOT id, so the reclaim predicate's "not my boot"
 * arm cannot tell *my own crashed run* apart from *another daemon's healthy
 * claim*. Running a second daemon against the same `~/.codeoid/codeoid.db` is
 * a supported setup — local-mode.md port-scopes its token file precisely so
 * two daemons can coexist on one machine — and before `owner_daemon` existed
 * the two dispatchers stole each other's in-flight tasks:
 *
 *   - a healthy worker's task was reclaimed within a tick or two of a
 *     10-MINUTE lease, hit `failure_limit`, and auto-BLOCKED, so the conductor
 *     was told the work had failed while the worker was reporting success; and
 *   - `dispatchClaimNext` had no ownership predicate at all, so one daemon
 *     could claim and execute another tenant's queued task.
 *
 * Both were observed end-to-end against a real daemon before this fix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";

const LEASE_MS = 10 * 60_000;

const DAEMON_A = "127.0.0.1:7400";
const DAEMON_B = "127.0.0.1:7455";
const BOOT_A = "boot-a";
const BOOT_A2 = "boot-a-after-restart";
const BOOT_B = "boot-b";

let dir: string;
let store: Store;

function enqueue(ownerDaemon: string | undefined, now: number, accountId = "acc"): string {
  const id = randomUUID();
  store.dispatchEnqueue({
    id,
    accountId,
    projectId: "proj",
    kind: "spawn",
    shape: "scout",
    workdir: "/tmp",
    prompt: "investigate",
    failureLimit: 2,
    createdBy: "conductor:test",
    ownerDaemon,
    now,
  });
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dispatch-scope-"));
  store = new Store(join(dir, "codeoid.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dispatch ownership across two daemons sharing a database", () => {
  test("a second daemon does not reclaim a live claim (the auto-block bug)", () => {
    const now = Date.now();
    const id = enqueue(DAEMON_A, now);

    expect(store.dispatchClaimNext(BOOT_A, now, [], DAEMON_A)?.id).toBe(id);

    // Daemon B's ordinary tick, one second in — 10 minutes of lease remain.
    expect(store.dispatchReclaimStale(BOOT_B, LEASE_MS, now + 1_000, DAEMON_B)).toEqual([]);

    // A second tick must not accumulate attempts either: two of these used to
    // be enough to reach failure_limit and auto-block healthy work.
    expect(store.dispatchReclaimStale(BOOT_B, LEASE_MS, now + 6_000, DAEMON_B)).toEqual([]);

    const task = store.dispatchGet(id);
    expect(task?.status).toBe("claimed");
    expect(task?.attempts).toBe(0);
    expect(task?.error).toBeNull();
  });

  test("a daemon still reclaims its OWN previous boot on the first tick", () => {
    const now = Date.now();
    const id = enqueue(DAEMON_A, now);
    store.dispatchClaimNext(BOOT_A, now, [], DAEMON_A);

    // Same daemon (same host:port), new boot id — a crash and restart. Fast
    // recovery must survive the ownership scoping, well inside the lease.
    const reclaimed = store.dispatchReclaimStale(BOOT_A2, LEASE_MS, now + 1_000, DAEMON_A);
    expect(reclaimed.map((t) => t.id)).toEqual([id]);
    expect(store.dispatchGet(id)?.status).toBe("queued");
    expect(store.dispatchGet(id)?.attempts).toBe(1);
  });

  test("a daemon cannot claim another daemon's queued task", () => {
    const now = Date.now();
    const mine = enqueue(DAEMON_A, now, "acc-a");

    // B has nothing of its own; the only queued row belongs to A.
    expect(store.dispatchClaimNext(BOOT_B, now, [], DAEMON_B)).toBeNull();
    expect(store.dispatchGet(mine)?.status).toBe("queued");

    // A still gets it.
    expect(store.dispatchClaimNext(BOOT_A, now, [], DAEMON_A)?.id).toBe(mine);
  });

  test("an expired lease is still reclaimed by its owner", () => {
    const now = Date.now();
    const id = enqueue(DAEMON_A, now);
    store.dispatchClaimNext(BOOT_A, now, [], DAEMON_A);

    // Same boot, but the worker wedged and stopped renewing: lease expiry is
    // the backstop and must keep working.
    const reclaimed = store.dispatchReclaimStale(BOOT_A, LEASE_MS, now + LEASE_MS + 1, DAEMON_A);
    expect(reclaimed.map((t) => t.id)).toEqual([id]);
  });

  test("pre-upgrade rows (no owner) stay claimable, and reclaim only on lease expiry", () => {
    const now = Date.now();
    const id = enqueue(undefined, now);

    // Claimable by whoever is running — nothing is stranded by the migration.
    expect(store.dispatchClaimNext(BOOT_A, now, [], DAEMON_A)?.id).toBe(id);

    // But an unowned row must NOT be reclaimed on the boot-id arm, or the
    // original theft returns for exactly the rows that predate the fix.
    expect(store.dispatchReclaimStale(BOOT_B, LEASE_MS, now + 1_000, DAEMON_B)).toEqual([]);
    expect(
      store.dispatchReclaimStale(BOOT_B, LEASE_MS, now + LEASE_MS + 1, DAEMON_B).map((t) => t.id),
    ).toEqual([id]);
  });
});
