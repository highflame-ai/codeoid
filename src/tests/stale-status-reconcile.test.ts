import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import type { SessionStatus } from "../protocol/types.js";

/**
 * `thinking` / `tool_running` / `waiting_approval` all describe work owned by a
 * LIVE process — the provider's turn loop, and for approvals the in-memory
 * resolver map. None of it survives a restart, and a resumed Session starts at
 * `idle` (its `#status` field is initialised, never restored from the row). The
 * rows were nonetheless left untouched, so the session list kept advertising
 * work that no longer existed — observed stuck for 11-19 days across restarts
 * on a live daemon.
 */
describe("reconcileStaleSessionStatuses", () => {
  let dir: string;
  let store: Store;

  const seed = (id: string, status: SessionStatus) =>
    store.createSession({
      id,
      name: `s-${id}`,
      workdir: "/tmp",
      status,
      createdBy: "test",
      accountId: "acct",
      projectId: "proj",
    } as never);

  const statusOf = (id: string) => store.getSession(id)?.status;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeoid-reconcile-"));
    store = new Store(join(dir, "codeoid.db"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("clears every non-terminal status left by a dead process", () => {
    seed("a", "thinking");
    seed("b", "tool_running");
    seed("c", "waiting_approval");

    expect(store.reconcileStaleSessionStatuses()).toBe(3);
    for (const id of ["a", "b", "c"]) expect(statusOf(id)).toBe("idle");
  });

  test("preserves `error` — a terminal state a human may still want to see", () => {
    seed("err", "error");
    seed("busy", "thinking");

    // Only the live-work row is corrected.
    expect(store.reconcileStaleSessionStatuses()).toBe(1);
    expect(statusOf("err")).toBe("error");
    expect(statusOf("busy")).toBe("idle");
  });

  test("leaves already-idle rows untouched and reports zero", () => {
    seed("calm", "idle");
    expect(store.reconcileStaleSessionStatuses()).toBe(0);
    expect(statusOf("calm")).toBe("idle");
  });

  test("is idempotent — a second boot corrects nothing", () => {
    seed("a", "waiting_approval");
    expect(store.reconcileStaleSessionStatuses()).toBe(1);
    expect(store.reconcileStaleSessionStatuses()).toBe(0);
    expect(statusOf("a")).toBe("idle");
  });
});
