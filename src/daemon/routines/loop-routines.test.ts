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
import { firstAttemptPrompt } from "../loops/prompt.js";
import { LoopError, type LoopStartInput } from "../loops/service.js";
import type { LoopContract, LoopStatus } from "../loops/types.js";
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
import { handleRoutineFire } from "./http.js";
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
  /** Called as a run starts, before it returns its id. */
  onStart: ((input: LoopStartInput) => void) | null = null;
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
    this.onStart?.(input);
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
  inProgress(owner: RoutineOwner): Array<{ loopRunId: string; routineId: string | null; routineRunId: string }> {
    return this.started
      .filter((s) => s.owner.sub === owner.sub && s.owner.accountId === owner.accountId && s.owner.projectId === owner.projectId)
      .filter((s) => !["completed", "budget_exhausted", "blocked", "failed", "cancelled"].includes(this.runs.get(s.id)?.status ?? "cancelled"))
      .filter((s) => s.input.trigger?.routineRunId)
      .map((s) => ({ loopRunId: s.id, routineId: s.input.trigger!.routineId ?? null, routineRunId: s.input.trigger!.routineRunId! }));
  }
  /** Called as the real service's cancel notice is: before cancel resolves. */
  onCancel: ((id: string) => void) | null = null;
  async cancel(id: string): Promise<void> {
    this.cancelled.push(id);
    this.set(id, "cancelled", { reason: "cancelled by the owner" });
    this.onCancel?.(id);
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
  async stopBackgroundTasks(): Promise<void> {}
  approvalState(): "pending" | "owner" | "gone" {
    return "gone";
  }
  async terminate(): Promise<void> {}
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
    // What the gate found and the payload ride as the trigger's data, apart.
    expect(input.trigger!.summary).toContain("test/a.test.ts flaked");
    expect(input.trigger!.payload).toBe("from the deploy");

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

describe("following the loop", () => {
  async function fireAndStart(over: Partial<RoutineSpecInput> = {}) {
    const { routine } = create(over);
    const fired = svc.fire(routine, "manual", null, "owner");
    await started();
    return { routine, runId: fired.id, loopRunId: loops.started.at(-1)!.id };
  }

  it("a loop that tried and ended blocked counts toward the failure pause; one blocked before any attempt doesn't", async () => {
    const first = await fireAndStart({ failurePauseAfter: 2 });
    loops.set(first.loopRunId, "blocked", { reason: "two attempts in a row left the code as they found it", attempts: 2 });
    svc.loopRunEnded(first.loopRunId);
    expect(store.getRun(first.runId)!.status).toBe("needs_attention");
    expect(store.getRoutine(first.routine.id)!.consecutiveFailures).toBe(1);

    svc.fire(store.getRoutine(first.routine.id)!, "manual", null, "owner");
    await started();
    const second = loops.started.at(-1)!.id;
    loops.set(second, "blocked", { reason: "the worker reports a conflict", attempts: 1 });
    svc.loopRunEnded(second);
    const paused = store.getRoutine(first.routine.id)!;
    expect(paused.enabled).toBe(false);
    expect(paused.pausedReason).toContain("2 consecutive failed runs");
  });

  it("the loop's outcome stays the routine's last outcome behind fires skipped while it ran", async () => {
    const { routine, runId, loopRunId } = await fireAndStart();
    clock += 60_000;
    expect(svc.fire(store.getRoutine(routine.id)!, "manual", null, "owner").status).toBe("skipped");
    clock += 60_000;
    loops.set(loopRunId, "blocked", { attempts: 2, reason: "no progress" });
    svc.loopRunEnded(loopRunId);
    // The newest run is the skip; the newest outcome is the blocked loop.
    expect(store.listRuns(routine.id, { limit: 1 })[0]!.status).toBe("skipped");
    const last = store.lastOutcome(routine.id)!;
    expect(last.id).toBe(runId);
    expect(toRunWire(last)).toMatchObject({ status: "needs_attention", loop: { runId: loopRunId, status: "blocked" } });
    // A later fire, skipped or cancelled, doesn't move it either.
    clock += 60_000;
    const next = svc.fire(store.getRoutine(routine.id)!, "manual", null, "owner");
    await started();
    svc.cancelRun(store.getRun(next.id)!, "owner");
    for (let i = 0; i < 20 && store.getRun(next.id)!.status === "running"; i++) await new Promise((r) => setTimeout(r, 0));
    expect(store.getRun(next.id)!.status).toBe("cancelled");
    expect(store.lastOutcome(routine.id)!.id).toBe(runId);
    // History trimmed to its newest run still keeps it.
    store.trimRuns(routine.id, 1, clock + 1);
    expect(store.listRuns(routine.id, { limit: 10 }).map((r) => r.id)).toContain(runId);
    expect(store.lastOutcome(routine.id)!.id).toBe(runId);
  });

  it("a loop blocked at its baseline (nothing to repair) is silent and breaks no streak", async () => {
    const { routine, runId, loopRunId } = await fireAndStart({ failurePauseAfter: 1 });
    loops.set(loopRunId, "blocked", { reason: "every check already passes", attempts: 0 });
    svc.loopRunEnded(loopRunId);
    expect(store.getRun(runId)!.status).toBe("silent");
    expect(store.getRoutine(routine.id)!.enabled).toBe(true);
    expect(store.getRoutine(routine.id)!.consecutiveFailures).toBe(0);
  });

  it("with loops gone from the daemon, a run following one ends failed instead of running forever", async () => {
    const { runId } = await fireAndStart();
    host.loops = undefined;
    await svc.tick();
    const run = store.getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("loops are not available");
  });

  it("a tick settles a loop that already ended before it judges the next fire", async () => {
    const { routine, runId, loopRunId } = await fireAndStart({ schedule: { kind: "every", seconds: 3600 } });
    // The loop ended, but its notice never came.
    loops.set(loopRunId, "completed", { attempts: 1, deliveredCommit: "b".repeat(40), branch: "codeoid/loop-y" });
    clock = store.getRoutine(routine.id)!.nextFireAt!;
    await svc.tick();
    await started();
    expect(store.getRun(runId)!.status).toBe("succeeded");
    expect(loops.started).toHaveLength(2);
    expect(store.listRuns(routine.id, { limit: 1 })[0]!.status).toBe("running");
  });

  it("a fire reads the followed loop again before skipping, and names its status when it does skip", async () => {
    const { routine, runId, loopRunId } = await fireAndStart();
    loops.set(loopRunId, "completed", { attempts: 1 });
    svc.fire(store.getRoutine(routine.id)!, "manual", null, "owner");
    await started();
    expect(store.getRun(runId)!.status).toBe("succeeded");
    expect(loops.started).toHaveLength(2);

    loops.set(loops.started[1]!.id, "waiting", { reason: "the worker asked a question" });
    await svc.tick();
    const skipped = svc.fire(store.getRoutine(routine.id)!, "manual", null, "owner");
    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toContain("(waiting)");
  });

  it("the gate's output and the payload reach the loop apart, each within its own budget", async () => {
    const { routine } = create({ check: { command: "head -c 9000 /dev/zero | tr '\\\\0' x", timeoutSeconds: 10 } });
    svc.fire(routine, "manual", "the deploy alert", "owner");
    await started();
    const trigger = loops.started[0]!.input.trigger!;
    expect(trigger.summary.length).toBeLessThanOrEqual(4_000);
    expect(trigger.summary).toContain("truncated");
    expect(trigger.summary).not.toContain("the deploy alert");
    expect(trigger.payload).toBe("the deploy alert");
  });

  it("the worker sees them as two data blocks, each labelled with where it came from", () => {
    const contract: LoopContract = {
      recipe: "repair",
      objective: "Fix it.",
      workdir: WORKDIR,
      checks: [{ id: "unit", command: "bun test", timeoutSec: 600 }],
      worker: {},
      toolBudget: 10,
      limits: { attempts: 1, attemptMinutes: 5, runMinutes: 5 },
      trigger: { kind: "routine", key: "routine:r:1", routineName: "flaky-repair", summary: "a.test.ts flaked", payload: "from the deploy" },
    };
    const prompt = firstAttemptPrompt(contract, []);
    expect(prompt).toMatch(/<loop-data source="routine check"[^>]*>\na\.test\.ts flaked\n<\/loop-data>/);
    expect(prompt).toMatch(/<loop-data source="routine payload"[^>]*>\nfrom the deploy\n<\/loop-data>/);
  });

  it("a fire that lands while delete cancels the loop is refused, and starts no loop nothing would follow", async () => {
    const { routine, loopRunId } = await fireAndStart({ schedule: { kind: "every", seconds: 3600 } });
    const refused: string[] = [];
    loops.onCancel = (id) => {
      svc.loopRunEnded(id);
      // Another client's Run now, and the scheduler's tick with the fire due.
      try {
        svc.fire(store.getRoutine(routine.id)!, "manual", null, "owner");
      } catch (e) {
        refused.push(e instanceof RoutineError ? `${e.code}: ${e.message}` : String(e));
      }
      clock = store.getRoutine(routine.id)!.nextFireAt!;
      void svc.tick();
    };
    await svc.delete(store.getRoutine(routine.id)!, "owner");
    await new Promise((r) => setTimeout(r, 10));
    expect(refused).toEqual(["conflict: this routine is being deleted"]);
    expect(loops.started.map((s) => s.id)).toEqual([loopRunId]);
    expect(store.getRoutine(routine.id)).toBeUndefined();
    expect(store.activeRuns()).toEqual([]);
  });

  it("deleting a routine whose loop is cancelled meanwhile announces no routine_end", async () => {
    const { routine, loopRunId } = await fireAndStart();
    loops.onCancel = (id) => svc.loopRunEnded(id);
    const before = host.finished.length;
    await svc.delete(store.getRoutine(routine.id)!, "owner");
    expect(loops.cancelled).toEqual([loopRunId]);
    expect(host.finished.length).toBe(before);
  });
});

describe("a restart between starting a loop and recording it", () => {
  /** A run that died after port.start but before it recorded the loop. */
  async function orphan(status: "queued" | "running" | "interrupted") {
    const { routine } = create();
    const fired = svc.fire(routine, "manual", null, "owner");
    await started();
    const loopRunId = loops.started.at(-1)!.id;
    store.updateRun(fired.id, {
      status,
      loopRunId: null,
      loopStatus: null,
      ...(status === "interrupted" ? { endedAt: clock } : {}),
      ...(status === "queued" ? { startedAt: null } : {}),
    });
    return { routine, runId: fired.id, loopRunId };
  }

  it("a run is running before its loop starts, so no crash can leave it queued", async () => {
    const { routine } = create();
    const seen: Array<string | undefined> = [];
    loops.onStart = (input) => seen.push(store.getRun(input.trigger!.routineRunId!)?.status);
    svc.fire(routine, "manual", null, "owner");
    await started();
    expect(seen).toEqual(["running"]);
  });

  // `queued`: a run recorded before a run was marked running ahead of its loop.
  for (const status of ["queued", "running", "interrupted"] as const) {
    it(`a ${status} run whose loop is still in progress follows it again, and ends with it`, async () => {
      const { runId, loopRunId } = await orphan(status);
      const next = new RoutineService(store, host, { tickMs: 1_000_000 }, { now: () => clock });
      next.start();
      try {
        const run = store.getRun(runId)!;
        expect(run.status).toBe("running");
        expect(run.loopRunId).toBe(loopRunId);
        expect(run.endedAt).toBeNull();
        // Followed again, not started over.
        await next.tick();
        await new Promise((r) => setTimeout(r, 10));
        expect(loops.started).toHaveLength(1);
        loops.set(loopRunId, "completed", { attempts: 1 });
        await next.tick();
        expect(store.getRun(runId)!.status).toBe("succeeded");
      } finally {
        next.stop();
      }
    });
  }

  it("a loop whose trigger names another routine is never linked to the run it names", async () => {
    const { runId } = await orphan("running");
    const trigger = loops.started.at(-1)!.input.trigger!;
    trigger.routineId = "00000000-0000-4000-8000-000000000000";
    const next = new RoutineService(store, host, { tickMs: 1_000_000 }, { now: () => clock });
    next.start();
    try {
      const run = store.getRun(runId)!;
      expect(run.status).toBe("interrupted");
      expect(run.loopRunId).toBeNull();
      expect(host.audits.some((a) => a.includes("routine.run.relinked"))).toBe(false);
    } finally {
      next.stop();
    }
  });

  it("a loop of another owner is never linked to the run it names", async () => {
    const { runId, loopRunId } = await orphan("running");
    loops.started.at(-1)!.owner = { ...OWNER, sub: "spiffe://t/user/someone-else" };
    const next = new RoutineService(store, host, { tickMs: 1_000_000 }, { now: () => clock });
    next.start();
    try {
      const run = store.getRun(runId)!;
      expect(run.status).toBe("interrupted");
      expect(run.loopRunId).toBeNull();
      expect(loopRunId).toBeDefined();
    } finally {
      next.stop();
    }
  });
});

describe("a loop routine's API trigger", () => {
  const fireReq = (id: string, token: string) =>
    new Request(`http://127.0.0.1/routines/${id}/fire`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "" });

  it("a fire skipped behind the loop tells the caller only that it was skipped; the owner sees which loop", async () => {
    const { routine, apiToken } = create({ api: true });
    const first = await handleRoutineFire(fireReq(routine.id, apiToken!), routine.id, svc);
    expect(first.status).toBe(202);
    await started();
    const loopRunId = loops.started.at(-1)!.id;

    const res = await handleRoutineFire(fireReq(routine.id, apiToken!), routine.id, svc);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; status: string; reason?: string };
    expect(body.status).toBe("skipped");
    expect(body.reason).toBe("this fire was skipped: the routine is busy or at one of its limits");
    expect(JSON.stringify(body)).not.toContain(loopRunId);
    // The run itself keeps the full reason, for its owner.
    expect(store.getRun(body.runId)!.reason).toContain(loopRunId);
  });
});

describe("what a loop routine refuses on an edit", () => {
  it("session-run limits are refused when the routine is, or becomes, a loop routine", () => {
    const { routine } = create();
    for (const field of ["toolBudget", "maxMinutes", "keepSessions"] as const) {
      expect(() => svc.update(routine, { spec: { [field]: 7 } }, "owner")).toThrow(`${field} doesn't apply to a routine that starts a loop`);
    }
    const plain = svc.create(OWNER, { name: "plain", prompt: "p", workdir: WORKDIR }).routine;
    expect(() => svc.update(plain, { spec: { loop: LOOP, maxMinutes: 30 } }, "owner")).toThrow("maxMinutes doesn't apply");
    // Turning it into a loop routine without them is fine, and so is a session routine's own edit.
    expect(svc.update(plain, { spec: { toolBudget: 9 } }, "owner").routine.spec.toolBudget).toBe(9);
    expect(svc.update(store.getRoutine(plain.id)!, { spec: { loop: LOOP } }, "owner").routine.spec.loop).toBeDefined();
  });

  it("and on create", () => {
    expect(() => create({ keepSessions: 3 })).toThrow("keepSessions doesn't apply");
  });
});

describe("a loop routine's pushes follow its notify policy", () => {
  it("a loop waiting on the owner pushes unless the routine never notifies; its end is the routine run's to push", () => {
    const quiet = create({ name: "quiet", notify: "never" }).routine;
    const loud = create({ name: "loud", notify: "always" }).routine;
    expect(svc.loopMayPush(quiet.id, "waiting")).toBe(false);
    expect(svc.loopMayPush(loud.id, "waiting")).toBe(true);
    expect(svc.loopMayPush(loud.id, "finished")).toBe(false);
  });

});
