/**
 * Dispatch host integration (P4) — the REAL SessionManager host behind the
 * Dispatcher, with MockSessionProviders injected via _testProviderFactory so
 * no SDK subprocess runs. Covers what dispatcher.test.ts fakes: worker
 * sessions actually spawn (role, mode, brief), digests read the real session
 * + memory, events inject into a real conductor session, and the fleet
 * dispatch deps close over real manager state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { AuthContext, SessionInfo } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:host-test",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-h",
  projectId: "proj-h",
};
const CLIENT = { id: "client-h", auth: AUTH, send: () => {} };

function mkConfig(): CodeoidConfig {
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
    session: {},
    conductor: { enabled: true, name: "conductor", provider: "claude" },
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

function turnDone(): ProviderEvent {
  return {
    type: "turn_done",
    result: {
      providerId: "mock",
      model: "mock-model",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: 1,
    },
  } as ProviderEvent;
}

/** A scripted turn that says something, then finishes. */
function sayTurn(text: string): ProviderEvent[] {
  return [{ type: "text_done", content: text } as ProviderEvent, turnDone()];
}

let tmp: string;
let workdir: string;
let store: Store;
let transcript: TranscriptStore;
let providers: MockSessionProvider[];
let manager: SessionManager;

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function listSessions(): Promise<SessionInfo[]> {
  const resp = await manager.handle({ type: "session.list", id: "req" }, AUTH, CLIENT);
  return (resp as { sessions: SessionInfo[] }).sessions;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-dispatch-host-"));
  workdir = join(tmp, "repo");
  rmSync(workdir, { recursive: true, force: true });
  require("node:fs").mkdirSync(workdir, { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  providers = [];
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(),
    _testProviderFactory: () => {
      // Every session (conductor, targets, workers) speaks in scripted turns.
      const p = new MockSessionProvider("mock", [
        sayTurn("scouted: the bug is in auth.ts line 42"),
        sayTurn("second turn"),
        sayTurn("third turn"),
      ]);
      providers.push(p);
      return p;
    },
  });
});

afterEach(async () => {
  manager.stopDispatcher();
  // Sessions may still be mid-mock-turn (e.g. the conductor processing an
  // injected event) with fire-and-forget meta writes in flight — drain them
  // to idle, then flush the write chains, THEN remove the temp dir. Without
  // this, a pending atomic rename lands after rmSync and surfaces as an
  // unhandled ENOENT in unrelated test files.
  try { await manager.drain(3_000); } catch {}
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("dispatch host — spawn end-to-end", () => {
  test("spawn runs a real worker session: brief, budget, digest, teardown, conductor injection", async () => {
    // A real conductor session to receive the event injection.
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "x", workdir: ".", role: "conductor" },
      AUTH,
      CLIENT,
    );
    expect((created as { data: SessionInfo }).data.role).toBe("conductor");
    const conductorProvider = providers[0]!;

    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "find the auth bug",
      createdBy: "wimse://test/conductor",
    });
    await manager.dispatcher.tick();

    // A real worker session exists with the right shape.
    const sessions = await listSessions();
    const worker = sessions.find((s) => s.role === "worker");
    expect(worker).toBeDefined();
    expect(worker!.name).toStartWith("worker-scout-");
    expect(worker!.mode).toBe("autonomous");
    expect(worker!.turnsRemaining).toBe(7); // config.dispatch.workerToolBudget

    // The worker got a complete, sentinel-marked brief with the scout contract.
    const workerProvider = providers.find((p) => p !== conductorProvider)!;
    const brief = workerProvider.capturedOpts[0]!.userMessage;
    expect(brief).toContain('<fleet_dispatch task="');
    expect(brief).toContain("Do NOT modify files");
    expect(brief).toContain("find the auth bug");

    // Worker's scripted turn finishes → digest, done, teardown, injection.
    await until(() => store.dispatchGet(taskId)?.status === "done");
    const task = store.dispatchGet(taskId)!;
    expect(task.resultDigest).toContain("scouted: the bug is in auth.ts line 42");

    {
      // Teardown is fired from the async finisher — poll until the worker
      // session is gone from the tenant's list.
      const deadline = Date.now() + 3_000;
      while ((await listSessions()).some((s) => s.role === "worker")) {
        if (Date.now() > deadline) throw new Error("worker not torn down");
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    expect((await listSessions()).some((s) => s.role === "worker")).toBe(false);

    // The conductor received ONE daemon-injected <fleet_events> turn.
    await until(() => conductorProvider.capturedOpts.length >= 1);
    const injected = conductorProvider.capturedOpts[0]!.userMessage;
    expect(injected).toContain("<fleet_events>");
    expect(injected).toContain("task_done");
    expect(injected).toContain("scouted: the bug is in auth.ts line 42");
    expect(store.dispatchEventsPending(AUTH.accountId, AUTH.projectId)).toHaveLength(0);
  });

  test("spawn with a vanished workdir fails terminally", async () => {
    const gone = join(tmp, "vanished");
    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "spawn",
      shape: "ship",
      workdir: gone,
      prompt: "x",
      createdBy: "c",
    });
    await manager.dispatcher.tick();
    expect(store.dispatchGet(taskId)!.status).toBe("failed");
    expect(store.dispatchGet(taskId)!.error).toContain("workdir not usable");
  });
});

describe("dispatch host — send end-to-end", () => {
  test("send delivers a conductor-attributed, prefixed prompt to the real target session", async () => {
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "target", workdir: tmp },
      AUTH,
      CLIENT,
    );
    const targetId = (created as { data: SessionInfo }).data.id;
    const targetProvider = providers[0]!;

    const taskId = manager.dispatcher.enqueue({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      kind: "send",
      shape: "ship",
      targetSession: targetId,
      prompt: "continue the latest_only fix",
      createdBy: "wimse://test/conductor",
    });
    await manager.dispatcher.tick();

    expect(store.dispatchGet(taskId)!.status).toBe("done");
    const delivered = targetProvider.capturedOpts[0]!.userMessage;
    expect(delivered).toContain("[conductor dispatch");
    expect(delivered).toContain("owner-approved");
    expect(delivered).toContain("continue the latest_only fix");
    // Attribution: the send audits under the conductor principal.
    expect(targetProvider.capturedOpts[0]!.sender?.sub).toBe("wimse://test/conductor");
  });

  test("send to a session of ANOTHER tenant fails terminally (tenancy wall)", async () => {
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "target", workdir: tmp },
      AUTH,
      CLIENT,
    );
    const targetId = (created as { data: SessionInfo }).data.id;

    const taskId = manager.dispatcher.enqueue({
      accountId: "acc-OTHER",
      projectId: "proj-OTHER",
      kind: "send",
      shape: "ship",
      targetSession: targetId, // exists, but belongs to acc-h
      prompt: "x",
      createdBy: "c",
    });
    await manager.dispatcher.tick();
    expect(store.dispatchGet(taskId)!.status).toBe("failed");
  });
});

describe("dispatch host — fleet dispatch deps (real closures)", () => {
  test("enqueue stamps tenant + conductor lineage; listTasks maps the board", async () => {
    const deps = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);
    const taskId = deps.enqueue({
      kind: "spawn",
      shape: "scout",
      workdir,
      prompt: "look around",
    });

    const row = store.dispatchGet(taskId)!;
    expect(row.accountId).toBe(AUTH.accountId);
    expect(row.createdBy).toContain("conductor:acc-h/proj-h"); // no identity manager → fallback lineage

    const board = deps.listTasks(10);
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ id: taskId, kind: "spawn", shape: "scout", status: "queued", target: workdir });
  });

  test("checkWorkdir normalizes real dirs and rejects missing ones", () => {
    const deps = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);
    expect(deps.checkWorkdir(workdir)).toBe(workdir);
    expect(deps.checkWorkdir(join(tmp, "nope"))).toBeNull();
  });

  test("interrupt refuses cross-tenant and missing sessions", async () => {
    const created = await manager.handle(
      { type: "session.create", id: "req", name: "t", workdir: tmp },
      AUTH,
      CLIENT,
    );
    const id = (created as { data: SessionInfo }).data.id;

    const foreign = manager._fleetDispatchDeps("acc-OTHER", "proj-OTHER");
    expect(foreign.interrupt(id)).rejects.toThrow("no longer exists");

    const mine = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);
    await mine.interrupt(id); // idle session — harmless no-op interrupt
  });
});

// ── Dispatch-event ROUTING (the real host, not a fake) ──────────────────────

// These exist because `dispatcher.test.ts` drives a FakeHost whose
// `deliverEvents` always accepts. Every barrier test passed against events that
// were, in production, undeliverable: the real host sent everything to the
// tenant's CONDUCTOR, so a collaboration orchestrator never received its own
// dispatch results — and with no conductor on the daemon (the common case, since
// one is only created on explicit request) they were retried forever. A fake
// that rubber-stamps the last mile cannot see a last-mile bug.
describe("dispatch host — event routing", () => {
  const COLLAB = {
    goal: "route my results",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "claude", count: 2 },
    ],
  };

  const createCollab = async (): Promise<SessionInfo> => {
    manager.setBlackboardUrl("http://127.0.0.1:1/mcp/bb");
    const resp = await manager.handle(
      { type: "session.create", id: "c1", name: "goal", workdir, collaboration: COLLAB },
      AUTH,
      { id: "cl", auth: AUTH, send: () => {} },
    );
    if (resp.type !== "response.ok") throw new Error(`create failed: ${JSON.stringify(resp)}`);
    const info = resp.data as SessionInfo;
    // Creating a collaboration now starts the orchestrator on its goal, so it
    // is BUSY the moment create returns. These tests are about dispatch
    // routing, not about that opening turn: let it settle so each test starts
    // from an idle orchestrator, the precondition they were written against.
    // Wait for that turn to have RUN, not merely for the session to look idle:
    // the kickoff send is fire-and-forget, so an immediate status read still
    // sees "idle" before it has started, and the test would then tick the
    // dispatcher into a mid-turn orchestrator and see its event held back.
    await until(() => {
      const s = manager._sessionForTest(info.id);
      return (s?.toInfo().usage?.numTurns ?? 0) > 0 && s?.status === "idle";
    });
    return info;
  };

  const childrenOf = async (parentId: string): Promise<SessionInfo[]> => {
    const resp = await manager.handle({ type: "session.list", id: "l" }, AUTH, {
      id: "cl",
      auth: AUTH,
      send: () => {},
    });
    return (resp as { sessions: SessionInfo[] }).sessions.filter(
      (s) => s.collaborationRole?.parentSessionId === parentId,
    );
  };

  const pending = () => store.dispatchEventsPending(AUTH.accountId, AUTH.projectId);

  /**
   * Turns this session has taken.
   *
   * Delivery calls `session.send()`, which runs a turn — so a rise here is proof
   * the injection reached THIS session. Asserting only `pending().length === 0`
   * was the flaw in the first draft of these tests: an event RETIRED as
   * undeliverable also drains the queue, so a mutation reverting to
   * conductor-only routing passed. Draining is not delivering.
   */
  const turnsOf = (sessionId: string): number =>
    manager._sessionForTest(sessionId)?.toInfo().usage?.numTurns ?? 0;

  /** Wait for an injected turn to actually complete on `sessionId`.
   *  `Session.send()` resolves before the turn finishes, so a bare read of
   *  `numTurns` right after the tick races the turn it is trying to observe. */
  const untilTurn = (sessionId: string) => until(() => turnsOf(sessionId) > 0);

  test("an orchestrator's panel result reaches the ORCHESTRATOR, with no conductor present", async () => {
    const goal = await createCollab();
    const kids = await childrenOf(goal.id);
    expect(kids).toHaveLength(2);
    // Nobody asked for a conductor, so there isn't one. This is the case that
    // made the whole barrier→synthesis loop unreachable.
    expect(manager._sessionForTest(goal.id)!.role).toBeUndefined();

    const deps = manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId);
    const { groupId } = deps.dispatch!.enqueuePanel!({
      targets: kids.map((k) => k.id),
      prompt: "review",
      shape: "scout",
    });
    for (const m of store.dispatchGroupMembers(AUTH.accountId, AUTH.projectId, groupId)) {
      store.dispatchComplete(m.id, `digest ${m.id.slice(0, 4)}`, Date.now());
    }
    store.dispatchEventAdd({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      taskId: store.dispatchGroupMembers(AUTH.accountId, AUTH.projectId, groupId)[0]!.id,
      type: "group_done",
      digest: `group=${groupId} joined`,
      now: Date.now(),
    });

    // Baseline, not zero: the orchestrator already took its opening goal turn.
    const turnsBefore = turnsOf(goal.id);
    await manager.dispatcher.tick();

    // Delivered TO THE ORCHESTRATOR — proven by it having taken a turn, not
    // merely by the queue draining (a retired event drains it too).
    // Delivered TO THE ORCHESTRATOR — proven by a completed turn on that exact
    // session, not by the queue draining (a retired event drains it too).
    await until(() => turnsOf(goal.id) > turnsBefore);
    expect(turnsOf(goal.id)).toBeGreaterThan(turnsBefore);
    expect(pending()).toHaveLength(0);
  });

  test("a conductor's own dispatch still goes to the conductor", async () => {
    // The contrast, so the routing can't be over-applied: an event whose task
    // was NOT created by an orchestrator keeps its original destination.
    const conductor = await manager.handle(
      { type: "session.create", id: "cd", name: "conductor", workdir, role: "conductor" },
      AUTH,
      { id: "cl", auth: AUTH, send: () => {} },
    );
    expect(conductor.type).toBe("response.ok");
    const target = await manager.handle(
      { type: "session.create", id: "t1", name: "target", workdir },
      AUTH,
      { id: "cl", auth: AUTH, send: () => {} },
    );
    const targetId = (target as { data: SessionInfo }).data.id;

    const taskId = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId).enqueue({
      kind: "send",
      shape: "ship",
      targetSession: targetId,
      prompt: "go",
    });
    store.dispatchComplete(taskId, "delivered", Date.now());
    store.dispatchEventAdd({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      taskId,
      type: "task_done",
      digest: "done",
      now: Date.now(),
    });
    const conductorId = (conductor as { data: SessionInfo }).data.id;
    expect(turnsOf(conductorId)).toBe(0);
    await manager.dispatcher.tick();
    // The contrast: routing must not be over-applied. A non-orchestrator task's
    // event still lands on the conductor.
    await untilTurn(conductorId);
    expect(turnsOf(conductorId)).toBeGreaterThan(0);
    expect(pending()).toHaveLength(0);
  });

  test("events for a destroyed collaboration are retired, not retried forever", async () => {
    const goal = await createCollab();
    const kids = await childrenOf(goal.id);
    const deps = manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId);
    const { groupId } = deps.dispatch!.enqueuePanel!({
      targets: kids.map((k) => k.id),
      prompt: "review",
      shape: "scout",
    });
    const first = store.dispatchGroupMembers(AUTH.accountId, AUTH.projectId, groupId)[0]!;
    store.dispatchEventAdd({
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      taskId: first.id,
      type: "group_done",
      digest: "joined",
      now: Date.now(),
    });
    // The goal goes away before the event is delivered.
    await manager.handle({ type: "session.destroy", id: "d", sessionId: goal.id }, AUTH, {
      id: "cl",
      auth: AUTH,
      send: () => {},
    });

    await manager.dispatcher.tick();
    // Retired rather than left pending: there is nothing to deliver them to,
    // and holding them makes the queue grow forever.
    expect(pending()).toHaveLength(0);
  });

  test("a busy recipient holds only ITS events — others still deliver", async () => {
    // Why deliverEvents returns ids instead of a boolean. With two possible
    // recipients, "one is mid-turn" is normal, and all-or-nothing would either
    // stall the idle one or re-deliver it later as a duplicate.
    const goal = await createCollab();
    const kids = await childrenOf(goal.id);
    const deps = manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId);
    const { groupId } = deps.dispatch!.enqueuePanel!({
      targets: kids.map((k) => k.id),
      prompt: "review",
      shape: "scout",
    });
    const member = store.dispatchGroupMembers(AUTH.accountId, AUTH.projectId, groupId)[0]!;

    // An orchestrator event (deliverable) and a conductor-attributed one whose
    // conductor does not exist (must stay pending).
    store.dispatchEventAdd({
      accountId: AUTH.accountId, projectId: AUTH.projectId, taskId: member.id,
      type: "group_done", digest: "joined", now: Date.now(),
    });
    const orphanTask = manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId).enqueue({
      kind: "send", shape: "ship", targetSession: kids[0]!.id, prompt: "x",
    });
    store.dispatchEventAdd({
      accountId: AUTH.accountId, projectId: AUTH.projectId, taskId: orphanTask,
      type: "task_done", digest: "conductor-bound", now: Date.now(),
    });

    await manager.dispatcher.tick();
    const left = pending();
    // The orchestrator's landed; the conductor-bound one waits for a conductor.
    expect(left).toHaveLength(1);
    expect(left[0]!.digest).toBe("conductor-bound");
  });
});
