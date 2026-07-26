/**
 * Per-child backend on dispatched workers — collaborative sessions P0
 * (docs/collaborative-session-design.md §11).
 *
 * The exit criterion for P0 is "a dispatched worker runs on a chosen
 * non-default backend", so these tests deliberately do NOT use
 * `_testProviderFactory`: that injects one MockSessionProvider into every
 * session and bypasses `Session#createProvider` entirely, which is exactly
 * the code path under test. Instead we hand the manager a real two-backend
 * `ProviderRegistry` of mocks, so the worker's provider is genuinely resolved
 * from the task's `provider` field and `session.providerId` reports what the
 * worker is actually running on.
 *
 * Regressions guarded here:
 *   - a spawn task's provider/model reach the worker's provider construction;
 *   - an unregistered provider FAILS the task instead of silently falling back
 *     to the default backend (ProviderRegistry.resolve() warns + falls back,
 *     so without the claim-time check a worker would run on the wrong vendor
 *     while the task reported success);
 *   - a Claude alias in the global `config.session.defaultModel` does not ride
 *     onto a non-Claude child.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../daemon/session-manager.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import {
  MockSessionProvider,
  mockResult,
} from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { AuthContext, SessionInfo } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:per-child",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-pc",
  projectId: "proj-pc",
};
const CLIENT = { id: "client-pc", auth: AUTH, send: () => {} };

const textTurn = (text: string): ProviderEvent[] => [
  { type: "text_done", content: text } as ProviderEvent,
  { type: "turn_done", result: mockResult() } as ProviderEvent,
];

function mkConfig(session: CodeoidConfig["session"] = {}): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: "/tmp/codeoid.db",
    transcriptDir: "/tmp/transcripts",
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session,
    conductor: { enabled: false, name: "conductor", provider: "mock-a" },
    dispatch: {
      enabled: true,
      tickMs: 999_999, // manual ticks only
      leaseMs: 60_000,
      failureLimit: 2,
      maxConcurrentWorkers: 2,
      workerToolBudget: 7,
      retryBaseMs: 0,
    },
  };
}

/** Two mock backends, `mock-a` being the registry default (stands in for claude). */
function makeRegistry(): {
  registry: ProviderRegistry;
  /** What each provider was constructed WITH — the model boundary under test. */
  inits: Array<{ providerId: string; model: string | null }>;
} {
  const inits: Array<{ providerId: string; model: string | null }> = [];
  const registry = new ProviderRegistry("mock-a");
  for (const id of ["mock-a", "mock-b"] as const) {
    registry.register({
      id,
      displayName: id,
      create: (init) => {
        inits.push({ providerId: id, model: init.model ?? null });
        return new MockSessionProvider(id, [
          textTurn(`${id} finished the task`),
          textTurn("second turn"),
        ]);
      },
    });
  }
  return { registry, inits };
}

let tmp: string;
let workdir: string;
let store: Store;
let transcript: TranscriptStore;

function mkManager(config: CodeoidConfig): {
  manager: SessionManager;
  inits: Array<{ providerId: string; model: string | null }>;
} {
  const { registry, inits } = makeRegistry();
  const manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config,
    providers: registry,
  });
  return { manager, inits };
}

let manager: SessionManager;

async function listSessions(): Promise<SessionInfo[]> {
  const resp = await manager.handle({ type: "session.list", id: "req" }, AUTH, CLIENT);
  return (resp as { sessions: SessionInfo[] }).sessions;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-per-child-"));
  workdir = join(tmp, "repo");
  mkdirSync(workdir, { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  try { manager?.stopDispatcher(); } catch {}
  try { await manager?.drain(3_000); } catch {}
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("dispatched worker — per-child provider (P0)", () => {
  test("a spawn task's provider decides the worker's backend", async () => {
    const built = mkManager(mkConfig());
    manager = built.manager;

    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "look at this on the other backend",
      provider: "mock-b",
      createdBy: "wimse://test/conductor",
    });
    await manager.dispatcher.tick();

    const worker = (await listSessions()).find((s) => s.role === "worker");
    expect(worker).toBeDefined();
    // The whole point of P0: NOT the default backend.
    expect(worker!.providerId).toBe("mock-b");
    expect(store.dispatchGet(taskId)!.provider).toBe("mock-b");
    expect(built.inits).toContainEqual({ providerId: "mock-b", model: null });
  });

  test("a spawn task with no provider still lands on the daemon default", async () => {
    const built = mkManager(mkConfig());
    manager = built.manager;

    manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "default backend please",
      createdBy: "c",
    });
    await manager.dispatcher.tick();

    const worker = (await listSessions()).find((s) => s.role === "worker");
    expect(worker!.providerId).toBe("mock-a");
    expect(built.inits.map((i) => i.providerId)).toContain("mock-a");
  });

  test("per-child model reaches the provider it was chosen for", async () => {
    const built = mkManager(mkConfig());
    manager = built.manager;

    manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "ship",
      workdir,
      prompt: "use the specific model",
      provider: "mock-b",
      model: "mock-b-turbo",
      createdBy: "c",
    });
    await manager.dispatcher.tick();

    expect(built.inits).toContainEqual({
      providerId: "mock-b",
      model: "mock-b-turbo",
    });
    const worker = (await listSessions()).find((s) => s.role === "worker");
    expect(worker!.model).toBe("mock-b-turbo");
  });

  test("an unregistered provider FAILS the task instead of silently using the default", async () => {
    const built = mkManager(mkConfig());
    manager = built.manager;

    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "x",
      provider: "mock-vanished",
      createdBy: "c",
    });
    await manager.dispatcher.tick();

    const row = store.dispatchGet(taskId)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("not registered");
    // The silent-fallback regression: no worker may exist on ANY backend.
    expect((await listSessions()).some((s) => s.role === "worker")).toBe(false);
    expect(built.inits).toHaveLength(0);
  });

  test("a claude alias in config.session.defaultModel does not ride onto a non-claude child", async () => {
    // `defaultModel` is a global, so without provider-aware resolution the
    // worker would be constructed with claude-opus-* on a mock backend.
    const built = mkManager(mkConfig({ defaultModel: "opus" }));
    manager = built.manager;

    manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "x",
      provider: "mock-b",
      createdBy: "c",
    });
    await manager.dispatcher.tick();

    expect(built.inits).toHaveLength(1);
    expect(built.inits[0]!.providerId).toBe("mock-b");
    expect(built.inits[0]!.model).toBeNull(); // provider default, NOT claude-opus-*
    const worker = (await listSessions()).find((s) => s.role === "worker");
    expect(worker!.model ?? null).toBeNull();
  });
});

describe("fleet dispatch deps — resolveBackend (fail-closed, pre-queue)", () => {
  test("accepts a registered provider and passes the selection through", () => {
    const built = mkManager(mkConfig());
    manager = built.manager;
    const deps = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);

    expect(deps.resolveBackend("mock-b")).toEqual({ ok: true, provider: "mock-b" });
    expect(deps.resolveBackend(undefined, undefined)).toEqual({
      ok: true,
      provider: undefined,
    });
  });

  test("rejects an unregistered provider and names the available ones", () => {
    const built = mkManager(mkConfig());
    manager = built.manager;
    const deps = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);

    const out = deps.resolveBackend("mock-nope");
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected rejection");
    expect(out.error).toContain('Unknown provider "mock-nope"');
    expect(out.error).toContain("mock-a");
    expect(out.error).toContain("mock-b");
  });

  test("a rejected backend never reaches the queue via fleet_spawn", async () => {
    const built = mkManager(mkConfig());
    manager = built.manager;
    const deps = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);

    // Same shape the fleet_spawn handler uses: validate, then refuse to enqueue.
    const backend = deps.resolveBackend("mock-nope");
    expect(backend.ok).toBe(false);
    expect(deps.listTasks(10)).toHaveLength(0);
  });
});
