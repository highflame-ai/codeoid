/**
 * Routines that start a loop (docs/routines.md "Routines that start a loop"):
 * RoutineService against a scripted loop port and a fake clock. The fire
 * contract, the gate, one loop at a time, the owner's cap, the loop's outcome
 * on the routine run, cancel, restart, and the spec rules. Authorization and
 * a real loop run are covered through SessionManager in
 * src/tests/loop-routines-e2e.test.ts.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { LoopError, type LoopStartInput } from "../loops/service.js";
import type { LoopStatus } from "../loops/types.js";
import {
  RoutineError,
  RoutineService,
  routineOutcomeOfLoop,
  type RoutineHost,
  type RoutineLoopPort,
  type RoutineLoopState,
  type RoutineOwner,
  type RoutineRunEvent,
  type RoutineSpecInput,
} from "./service.js";
import { RoutineStore } from "./store.js";
import { toRunWire } from "./wire.js";

const WORKDIR = mkdtempSync(`${tmpdir()}/codeoid-loop-routine-`);
const OWNER = { sub: "spiffe://t/user/owner", accountId: "acc", projectId: "proj" };

/** A loop service stand-in: records what was started, and holds each run's state. */
class FakeLoops implements RoutineLoopPort {
  started: Array<{ input: LoopStartInput; owner: RoutineOwner; id: string }> = [];
  cancelled: string[] = [];
  runs = new Map<string, RoutineLoopState>();
  /** Thrown by the next start. */
  failNext: Error | null = null;
  #n = 0;

  providerProblem(provider: string | undefined): string | null {
    return provider === undefined || provider === "claude" ? null : `Loops run on claude for now; "${provider}" cannot report an attempt's outcome yet`;
  }
  start(input: LoopStartInput, owner: RoutineOwner): string {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const id = `loop_${++this.#n}`;
    this.started.push({ input, owner, id });
    this.runs.set(id, { status: "running", reason: "checking the unmodified code", attempts: 0, costUsd: 0, branch: null, deliveredCommit: null });
    return id;
  }
  state(id: string, owner: RoutineOwner): RoutineLoopState | null {
    const mine = this.started.find((s) => s.id === id);
    if (!mine || mine.owner.sub !== owner.sub || mine.owner.accountId !== owner.accountId) return null;
    return this.runs.get(id) ?? null;
  }
  async cancel(id: string): Promise<void> {
    this.cancelled.push(id);
    this.set(id, "cancelled", { reason: "cancelled by the owner" });
  }
  set(id: string, status: LoopStatus, over: Partial<RoutineLoopState> = {}): void {
    this.runs.set(id, { ...this.runs.get(id)!, status, ...over });
  }
}

class Host implements RoutineHost {
  loops?: FakeLoops = new FakeLoops();
  finished: RoutineRunEvent[] = [];
  audits: string[] = [];
  async createSession(): Promise<string> {
    throw new Error("a loop routine never creates a session");
  }
  sessionAlive(): boolean {
    return false;
  }
  armSession(): void {}
  disarm(): void {}
  defaultProviderId(): string {
    return "claude";
  }
  async send(): Promise<void> {}
  info() {
    return null;
  }
  result() {
    return { text: null, error: null };
  }
  beginUnattended(): () => void {
    return () => {};
  }
  async interrupt(): Promise<void> {}
  async destroy(): Promise<void> {}
  runFinished(e: RoutineRunEvent): void {
    this.finished.push(e);
  }
  audit(subject: string, action: string, _s: string | undefined, detail: string): void {
    this.audits.push(`${subject} ${action} ${detail}`);
  }
  hasProvider(id: string): boolean {
    return ["claude", "codex"].includes(id);
  }
  providerIds(): string[] {
    return ["claude", "codex"];
  }
  normalizeWorkdir(p: string): string | null {
    return existsSync(p) ? p : null;
  }
}

let host: Host;
let loops: FakeLoops;
let store: RoutineStore;
let clock: number;
let svc: RoutineService;

beforeEach(() => {
  host = new Host();
  loops = host.loops!;
  store = new RoutineStore(":memory:");
  clock = Date.parse("2026-10-16T08:00:00Z");
  svc = new RoutineService(store, host, { tickMs: 1_000_000 }, {
    now: () => clock,
    sleep: async (ms) => {
      clock += Math.max(ms, 1);
      await new Promise((r) => setTimeout(r, 0));
    },
  });
});

const LOOP = { checks: [{ id: "unit", command: "bun test", expectTests: true }], limits: { attempts: 2, runMinutes: 45 }, toolBudget: 25 };

function create(over: Partial<RoutineSpecInput> = {}) {
  return svc.create(OWNER, { name: "flaky-repair", prompt: "Fix the flaky tests.", workdir: WORKDIR, loop: LOOP, ...over } as RoutineSpecInput);
}

/** Let the run's executor get past the gate (it stops following the loop, not finishing). */
async function started(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (!store.activeRuns().some((r) => r.status === "queued" || r.status === "checking" || (r.status === "running" && r.loopRunId === null))) return;
  }
  throw new Error(`runs still starting: ${JSON.stringify(store.activeRuns().map((r) => r.status))}`);
}

describe("a loop routine's fire", () => {
  it("starts a loop run as the owner, with the saved contract and a routine trigger", async () => {
    const { routine } = create({ check: { command: "echo 'test/a.test.ts flaked'", timeoutSeconds: 10 } });
    const fired = svc.fire(routine, "manual", "from the deploy", "owner");
    await started();

    expect(loops.started).toHaveLength(1);
    const { input, owner, id } = loops.started[0]!;
    expect(owner).toEqual(OWNER);
    expect(input.objective).toBe("Fix the flaky tests.");
    expect(input.workdir).toBe(WORKDIR);
    expect(input.checks).toEqual([{ id: "unit", command: "bun test", timeoutSec: 600, expectTests: true }]);
    expect(input.toolBudget).toBe(25);
    expect(input.limits).toEqual({ attempts: 2, attemptMinutes: 10, runMinutes: 45 });
    expect(input.baseRef).toBeUndefined();
    expect(input.trigger).toMatchObject({ kind: "routine", key: `routine:${routine.id}:${fired.id}`, routineId: routine.id, routineName: "flaky-repair", routineRunId: fired.id });
    // What the gate found and the payload ride as the trigger's data.
    expect(input.trigger!.summary).toContain("test/a.test.ts flaked");
    expect(input.trigger!.summary).toContain("from the deploy");

    const run = store.getRun(fired.id)!;
    expect(run.status).toBe("running");
    expect(run.loopRunId).toBe(id);
    expect(run.sessionId).toBeNull();
    expect(toRunWire(run).loop).toEqual({ runId: id, status: "running" });
    // It follows the loop without holding one of the routine run slots.
    expect(svc.isLive(fired.id)).toBe(false);
    expect(host.audits.some((a) => a.includes("routine.run.started") && a.includes(`loop=${id}`))).toBe(true);
  });

  it("a gate that finds nothing starts no loop", async () => {
    const { routine } = create({ check: { command: "true", timeoutSeconds: 10 } });
    const fired = svc.fire(routine, "manual", null, "owner");
    await started();
    expect(loops.started).toHaveLength(0);
    expect(store.getRun(fired.id)!.status).toBe("silent");
  });

  it("a failing gate fails the run and starts no loop", async () => {
    const { routine } = create({ check: { command: "exit 2", timeoutSeconds: 10 } });
    const fired = svc.fire(routine, "manual", null, "owner");
    await started();
    expect(loops.started).toHaveLength(0);
    expect(store.getRun(fired.id)!.status).toBe("failed");
  });

  it("while its last loop run is in progress, a fire is skipped, saying which run", async () => {
    const { routine } = create({ schedule: { kind: "every", seconds: 3600 } });
    svc.fire(routine, "manual", null, "owner");
    await started();
    const first = loops.started[0]!.id;
    clock = store.getRoutine(routine.id)!.nextFireAt!;
    await svc.tick();
    await started();
    expect(loops.started).toHaveLength(1);
    const [latest] = store.listRuns(routine.id, { limit: 1 });
    expect(latest!.status).toBe("skipped");
    expect(latest!.reason).toContain(first);
    expect(latest!.reason).toContain("still in progress");
  });

  it("the owner's cap on loop runs skips the fire, and isn't a failure", async () => {
    const { routine } = create({ failurePauseAfter: 1 });
    loops.failNext = new LoopError("You already have 3 loop runs in progress; wait for one to end or cancel one", "conflict");
    const fired = svc.fire(routine, "manual", null, "owner");
    await started();
    const run = store.getRun(fired.id)!;
    expect(run.status).toBe("skipped");
    expect(run.reason).toContain("3 loop runs in progress");
    const after = store.getRoutine(routine.id)!;
    expect(after.enabled).toBe(true);
    expect(after.consecutiveFailures).toBe(0);
  });

  it("a loop that can't start (its workdir went away) fails the run", async () => {
    const { routine } = create();
    loops.failNext = new LoopError("workdir not usable: /gone", "invalid_request");
    const fired = svc.fire(routine, "manual", null, "owner");
    await started();
    expect(store.getRun(fired.id)!.status).toBe("failed");
    expect(store.getRun(fired.id)!.reason).toContain("could not start the loop run");
  });
});

describe("the loop's outcome on the routine run", () => {
  async function fireAndStart() {
    const { routine } = create();
    const fired = svc.fire(routine, "manual", null, "owner");
    await started();
    return { routine, runId: fired.id, loopRunId: loops.started.at(-1)!.id };
  }

  it("a completed loop ends the routine run succeeded, naming the commit; a tick or the loop's notice settles it", async () => {
    const { runId, loopRunId } = await fireAndStart();
    loops.set(loopRunId, "verifying", { costUsd: 0.4 });
    await svc.tick();
    expect(store.getRun(runId)!.status).toBe("running");
    expect(store.getRun(runId)!.loopStatus).toBe("verifying");
    expect(store.getRun(runId)!.costUsd).toBe(0.4);

    loops.set(loopRunId, "completed", { reason: "every check passed on attempt 1", attempts: 1, costUsd: 0.9, branch: "codeoid/loop-x", deliveredCommit: "a".repeat(40) });
    svc.loopRunEnded(loopRunId);
    const run = store.getRun(runId)!;
    expect(run.status).toBe("succeeded");
    expect(run.loopStatus).toBe("completed");
    expect(run.costUsd).toBe(0.9);
    expect(run.summary).toContain("aaaaaaaaaaaa");
    expect(run.summary).toContain("codeoid/loop-x");
    expect(toRunWire(run).loop).toEqual({ runId: loopRunId, status: "completed" });
    expect(host.finished.at(-1)!.run.id).toBe(runId);
  });

  it("a loop out of budget fails the run and counts toward the failure pause", async () => {
    const { routine, runId, loopRunId } = await fireAndStart();
    svc.update(store.getRoutine(routine.id)!, { spec: { failurePauseAfter: 1 } }, "owner");
    loops.set(loopRunId, "budget_exhausted", { reason: "2 attempt(s) used without passing every check", attempts: 2 });
    await svc.tick();
    expect(store.getRun(runId)!.status).toBe("failed");
    expect(store.getRun(runId)!.reason).toContain("ran out of budget");
    expect(store.getRoutine(routine.id)!.enabled).toBe(false);
  });

  it("a loop whose checks already passed found nothing to repair: silent", async () => {
    const { runId, loopRunId } = await fireAndStart();
    loops.set(loopRunId, "blocked", { reason: "every check already passes on the unmodified code — there is nothing to repair", attempts: 0 });
    svc.loopRunEnded(loopRunId);
    expect(store.getRun(runId)!.status).toBe("silent");
  });

  it("maps every terminal loop status", () => {
    const base = { reason: "r", attempts: 1, costUsd: 0, branch: null, deliveredCommit: null };
    const of = (status: LoopStatus, attempts = 1) => routineOutcomeOfLoop({ ...base, status, attempts }).status;
    expect(of("completed")).toBe("succeeded");
    expect(of("blocked")).toBe("needs_attention");
    expect(of("blocked", 0)).toBe("silent");
    expect(of("budget_exhausted")).toBe("failed");
    expect(of("failed")).toBe("failed");
    expect(of("cancelled")).toBe("cancelled");
  });

  it("a loop that is gone fails the run", async () => {
    const { runId, loopRunId } = await fireAndStart();
    loops.runs.delete(loopRunId);
    await svc.tick();
    expect(store.getRun(runId)!.status).toBe("failed");
    expect(store.getRun(runId)!.reason).toContain("is gone");
  });

  it("cancelling the routine run cancels the loop, and the run ends with it", async () => {
    const { runId, loopRunId } = await fireAndStart();
    expect(svc.cancelRun(store.getRun(runId)!, "owner")).toBe(true);
    for (let i = 0; i < 20 && store.getRun(runId)!.status === "running"; i++) await new Promise((r) => setTimeout(r, 0));
    expect(loops.cancelled).toEqual([loopRunId]);
    expect(store.getRun(runId)!.status).toBe("cancelled");
  });

  it("deleting the routine cancels a loop run still in progress", async () => {
    const { routine, loopRunId } = await fireAndStart();
    await svc.delete(store.getRoutine(routine.id)!, "owner");
    expect(loops.cancelled).toEqual([loopRunId]);
  });

  it("a restart leaves a run following a loop open, and the next tick settles it", async () => {
    const { runId, loopRunId } = await fireAndStart();
    const next = new RoutineService(store, host, { tickMs: 1_000_000 }, { now: () => clock });
    next.start();
    try {
      expect(store.getRun(runId)!.status).toBe("running");
      loops.set(loopRunId, "completed", { attempts: 1 });
      await next.tick();
      expect(store.getRun(runId)!.status).toBe("succeeded");
    } finally {
      next.stop();
    }
  });
});

describe("a loop routine's spec", () => {
  const bad = (over: Partial<RoutineSpecInput>, message: RegExp) => {
    expect(() => create(over)).toThrow(message);
    try {
      create(over);
    } catch (e) {
      expect(e).toBeInstanceOf(RoutineError);
      expect((e as RoutineError).code).toBe("invalid_request");
    }
  };

  it("is stored validated and filled, like a run's contract", () => {
    const { routine } = create({ loop: { checks: [{ command: "bun test" }, { id: "lint", command: "bun run lint" }] } });
    expect(routine.spec.loop).toEqual({
      checks: [
        { id: "check1", command: "bun test", timeoutSec: 600 },
        { id: "lint", command: "bun run lint", timeoutSec: 600 },
      ],
      toolBudget: 60,
      limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 },
    });
  });

  it("refuses what a loop can't honour", () => {
    bad({ approvals: "guarded" }, /can't be guarded/);
    bad({ session: "persistent" }, /can't be persistent/);
    bad({ worktree: true }, /own worktree/);
    bad({ maxCostUsd: 2 }, /maxCostUsd/);
    bad({ overlap: "queue" }, /overlap must be skip/);
    bad({ provider: "codex" }, /Loops run on claude/);
    bad({ prompt: "Fix {{check}}" }, /placeholders/);
    bad({ prompt: "x".repeat(8_001) }, /8000 characters/);
    bad({ loop: { checks: [] } }, /loop: A repair run needs at least one check/);
    bad({ loop: { checks: [{ command: "a" }], limits: { attempts: 11 } } }, /loop: attempts must be 1–10/);
    bad({ loop: { checks: [{ id: "x", command: "a" }, { id: "x", command: "b" }] } }, /Two checks are named "x"/);
  });

  it("is refused when the daemon has no loops", () => {
    host.loops = undefined;
    bad({}, /loops are not available/);
  });

  it("an edit merges over the current loop; null makes it a session routine again", () => {
    const { routine } = create();
    const edited = svc.update(routine, { spec: { loop: { limits: { attempts: 5 } } } }, "owner").routine;
    expect(edited.spec.loop!.checks).toEqual(routine.spec.loop!.checks);
    expect(edited.spec.loop!.limits).toEqual({ attempts: 5, attemptMinutes: 10, runMinutes: 45 });
    expect(edited.spec.loop!.toolBudget).toBe(25);
    const replaced = svc.update(edited, { spec: { loop: { checks: [{ id: "e2e", command: "bun run e2e" }] } } }, "owner").routine;
    expect(replaced.spec.loop!.checks.map((c) => c.id)).toEqual(["e2e"]);
    const plain = svc.update(replaced, { spec: { loop: null } }, "owner").routine;
    expect(plain.spec.loop).toBeUndefined();
    expect(host.audits.some((a) => a.includes("routine.update") && a.includes("loop:"))).toBe(true);
  });
});
