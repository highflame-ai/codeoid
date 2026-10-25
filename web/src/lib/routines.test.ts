import { describe, expect, it } from "vitest";

import {
  LOOP_ROUTINE_REFUSES,
  buildRoutinePatch,
  buildRoutineSpec,
  compactInterval,
  cronWords,
  emptyRoutineForm,
  formFromRoutine,
  intervalWords,
  isCancellableRun,
  isFailingRun,
  isoToLocal,
  localToIso,
  parseEvery,
  routineLoopOf,
  routineRunLoop,
  routineRunStatusStyle,
  routineBudgetText,
  routineState,
  routineWarnings,
  scheduleWords,
  type RoutineForm,
} from "./routines";
import { routine, runWire } from "./automation.fixtures";

function filled(over: Partial<RoutineForm> = {}): RoutineForm {
  return { ...emptyRoutineForm(), name: "ci-watch", workdir: "/repo", prompt: "Look at CI", ...over };
}

describe("schedules in words", () => {
  it("names the cron shapes people write, and leaves the rest as the expression", () => {
    expect(cronWords("0 9 * * 1-5")).toBe("weekdays at 09:00");
    expect(cronWords("30 8 * * *")).toBe("every day at 08:30");
    expect(cronWords("0 7 * * 1")).toBe("every Monday at 07:00");
    expect(cronWords("0 7 * * 1,3")).toBe("every Monday and Wednesday at 07:00");
    expect(cronWords("0 10 * * 0,6")).toBe("weekends at 10:00");
    expect(cronWords("*/15 * * * *")).toBe("every 15 minutes");
    expect(cronWords("5 * * * *")).toBe("every hour at :05");
    expect(cronWords("0 */6 * * *")).toBe("every 6 hours at :00");
    expect(cronWords("0 9,17 * * *")).toBe("every day at 09:00, 17:00");
    expect(cronWords("0 2 1 * *")).toBe("on day 1 of every month at 02:00");
    expect(cronWords("0 9 * 1 *")).toBe("cron 0 9 * 1 *");
    expect(cronWords("0 9-17/2 * * *")).toBe("cron 0 9-17/2 * * *");
    expect(cronWords("bad")).toBe("cron bad");
  });

  it("puts the zone, interval and on-demand in words", () => {
    expect(scheduleWords({ kind: "cron", expr: "0 9 * * 1-5", timezone: "Europe/London" })).toBe("weekdays at 09:00 (Europe/London)");
    expect(scheduleWords({ kind: "every", seconds: 5400 })).toBe("every 1 hour 30 minutes");
    expect(scheduleWords(undefined)).toBe("on demand only");
    expect(scheduleWords({ kind: "once", at: "2026-10-27T07:00:00.000Z" })).toMatch(/^once, /);
    expect(intervalWords(60)).toBe("1 minute");
    expect(intervalWords(2 * 86_400)).toBe("2 days");
  });

  it("parses intervals as the CLI does", () => {
    expect(parseEvery("15m")).toBe(900);
    expect(parseEvery("1h30m")).toBe(5400);
    expect(parseEvery("90")).toBe(90);
    expect(parseEvery("2d")).toBe(172_800);
    expect(parseEvery("15 minutes")).toHaveProperty("error");
    expect(parseEvery("0m")).toEqual({ error: "The interval can't be zero" });
    expect(parseEvery("")).toHaveProperty("error");
    expect(compactInterval(5400)).toBe("1h30m");
  });

  it("turns a datetime-local value into an instant with a zone, and back", () => {
    const iso = localToIso("2026-10-27T09:00");
    expect(iso).toMatch(/Z$/);
    expect(isoToLocal(iso!)).toBe("2026-10-27T09:00");
    expect(localToIso("tomorrow")).toBeNull();
  });
});

describe("outcomes", () => {
  it("a loop routine's blocked loop reads as such and counts as failing; a session's park does neither", () => {
    const blocked = runWire({ status: "needs_attention", loop: { runId: "loop_1", status: "blocked" } });
    expect(routineRunStatusStyle(blocked).label).toBe("loop blocked");
    expect(routineRunStatusStyle(blocked).meaning).toMatch(/Counts toward the failure pause/);
    expect(isFailingRun(blocked.status, blocked.loop)).toBe(true);
    const parked = runWire({ status: "needs_attention" });
    expect(routineRunStatusStyle(parked).label).toBe("needs you");
    expect(isFailingRun(parked.status, parked.loop)).toBe(false);
  });

  it("knows which runs fail, which can be cancelled, and a routine's state", () => {
    expect(isFailingRun("failed")).toBe(true);
    expect(isFailingRun("over_budget")).toBe(true);
    expect(isFailingRun("silent")).toBe(false);
    expect(isCancellableRun("checking")).toBe(true);
    expect(isCancellableRun("needs_attention")).toBe(false);
    expect(routineState({ enabled: true }).label).toBe("active");
    expect(routineState({ enabled: false }).label).toBe("paused");
    expect(routineState({ enabled: false, pausedReason: "3 failed runs in a row" })).toMatchObject({
      label: "auto-paused",
      title: "3 failed runs in a row",
    });
  });
});

describe("the form", () => {
  it("builds a full spec", () => {
    const built = buildRoutineSpec(
      filled({ scheduleKind: "cron", cronExpr: " 0  9 * * 1-5 ", cronTz: "Asia/Singapore", checkCommand: "git status --porcelain", checkTimeout: "30", maxCostUsd: "1.5", api: true }),
    );
    expect(built).toEqual({
      spec: {
        name: "ci-watch",
        prompt: "Look at CI",
        workdir: "/repo",
        schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Singapore" },
        check: { command: "git status --porcelain", timeoutSeconds: 30 },
        approvals: "guarded",
        maxCostUsd: 1.5,
        session: "fresh",
        worktree: false,
        overlap: "skip",
        catchUp: false,
        notify: "on_change",
        api: true,
      },
    });
  });

  it("names the field that is wrong", () => {
    expect(buildRoutineSpec(filled({ name: "" }))).toMatchObject({ field: "name" });
    expect(buildRoutineSpec(filled({ name: "CI Watch" }))).toMatchObject({ field: "name" });
    expect(buildRoutineSpec(filled({ workdir: " " }))).toMatchObject({ field: "workdir" });
    expect(buildRoutineSpec(filled({ prompt: "" }))).toMatchObject({ field: "prompt" });
    expect(buildRoutineSpec(filled({ scheduleKind: "cron", cronExpr: "0 9 * *" }))).toEqual({
      error: "A cron has 5 fields (minute hour day month weekday); this has 4",
      field: "cron",
    });
    expect(buildRoutineSpec(filled({ scheduleKind: "every", every: "soon" }))).toMatchObject({ field: "every" });
    expect(buildRoutineSpec(filled({ scheduleKind: "once", onceAt: "" }))).toMatchObject({ field: "once" });
    expect(buildRoutineSpec(filled({ checkCommand: "x", checkTimeout: "-1" }))).toMatchObject({ field: "check" });
    expect(buildRoutineSpec(filled({ maxCostUsd: "free" }))).toMatchObject({ field: "maxCostUsd" });
    expect(buildRoutineSpec(filled({ toolBudget: "0" }))).toMatchObject({ field: "toolBudget" });
    // The daemon keeps at least one session.
    expect(buildRoutineSpec(filled({ keepSessions: "0" }))).toMatchObject({ field: "keepSessions" });
    expect(buildRoutineSpec(filled({ keepSessions: "1" }))).toHaveProperty("spec.keepSessions", 1);
  });

  it("on demand sends no schedule", () => {
    const built = buildRoutineSpec(filled({ scheduleKind: "none" }));
    expect(built).toHaveProperty("spec");
    expect("spec" in built && "schedule" in built.spec).toBe(false);
  });

  it("warns about what the docs warn about", () => {
    expect(routineWarnings(filled({ approvals: "autonomous", session: "persistent", worktree: true }))[0]).toMatch(/Persistent and autonomous/);
    expect(routineWarnings(filled({ approvals: "autonomous" })).join(" ")).toMatch(/edits your checkout/);
    expect(routineWarnings(filled({ scheduleKind: "none" })).join(" ")).toMatch(/only when you press Run now/);
    expect(routineWarnings(filled({ worktree: true }))).toEqual([]);
  });
});

describe("editing", () => {
  it("an untouched form changes nothing", () => {
    const r = routine();
    expect(buildRoutinePatch(r, formFromRoutine(r))).toEqual({ patch: {}, changed: [] });
  });

  it("sends only what changed, null for a cleared block, and a blanked default as its default", () => {
    const r = routine({}, { toolBudget: 80, maxCostUsd: 2 });
    const f = { ...formFromRoutine(r), checkCommand: "", toolBudget: "", maxCostUsd: "", prompt: "New prompt" };
    expect(buildRoutinePatch(r, f)).toEqual({
      patch: { prompt: "New prompt", toolBudget: 50, check: null, maxCostUsd: null },
      changed: ["prompt", "toolBudget", "check", "maxCostUsd"],
    });
  });

  it("switching to on demand clears the schedule; a cron without a zone keeps the routine's", () => {
    const cron = routine({}, { schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Singapore" } });
    expect(buildRoutinePatch(cron, { ...formFromRoutine(cron), cronTz: "" })).toEqual({ patch: {}, changed: [] });
    expect(buildRoutinePatch(cron, { ...formFromRoutine(cron), scheduleKind: "none" })).toEqual({ patch: { schedule: null }, changed: ["schedule"] });
    const p = buildRoutinePatch(cron, { ...formFromRoutine(cron), cronExpr: "0 10 * * 1-5" });
    expect(p).toEqual({ patch: { schedule: { kind: "cron", expr: "0 10 * * 1-5", timezone: "Asia/Singapore" } }, changed: ["schedule"] });
  });

  it("a one-off whose time wasn't touched is not a change, though the field shows it only to the minute", () => {
    const at = "2026-11-02T09:30:45.250Z";
    const once = routine({}, { schedule: { kind: "once", at } });
    expect(formFromRoutine(once).onceAt).toBe(isoToLocal(at));
    expect(buildRoutinePatch(once, formFromRoutine(once))).toEqual({ patch: {}, changed: [] });
    // An unrelated edit leaves the schedule out, so the daemon keeps the saved instant.
    expect(buildRoutinePatch(once, { ...formFromRoutine(once), prompt: "Another prompt" })).toEqual({ patch: { prompt: "Another prompt" }, changed: ["prompt"] });
    // Moving it is a change.
    const moved = buildRoutinePatch(once, { ...formFromRoutine(once), onceAt: isoToLocal("2026-11-03T09:30:00.000Z") });
    expect(moved).toMatchObject({ changed: ["schedule"], patch: { schedule: { kind: "once", at: "2026-11-03T09:30:00.000Z" } } });
  });

  it("a check left at the default timeout is not a change", () => {
    const r = routine({}, { check: { command: "gh run list" } });
    expect(buildRoutinePatch(r, formFromRoutine(r))).toEqual({ patch: {}, changed: [] });
  });
});

describe("loop routines", () => {
  const loopForm = (over: Partial<RoutineForm> = {}): RoutineForm =>
    filled({
      action: "loop",
      prompt: "Fix the flaky tests the check found",
      loop: { checks: [{ id: "unit", command: "bun test", timeoutSec: "", expectTests: true }], toolBudget: "", attempts: "2", attemptMinutes: "", runMinutes: "45" },
      ...over,
    });
  const loopSpec = { checks: [{ id: "unit", command: "bun test", timeoutSec: 600, expectTests: true }], toolBudget: 60, limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 } };

  it("builds the loop contract and sets what a loop can't take to what it can", () => {
    const built = buildRoutineSpec(loopForm({ approvals: "guarded", session: "persistent", worktree: true, overlap: "queue", toolBudget: "9", maxMinutes: "9", keepSessions: "9" }));
    expect(built).toMatchObject({
      spec: {
        approvals: "autonomous",
        session: "fresh",
        worktree: false,
        overlap: "skip",
        loop: { checks: [{ id: "unit", command: "bun test", expectTests: true }], limits: { attempts: 2, runMinutes: 45 } },
      },
    });
    // The session-run limits don't apply, so they aren't sent.
    expect("spec" in built && ["toolBudget", "maxMinutes", "keepSessions"].some((k) => k in built.spec)).toBe(false);
  });

  it("says, before the daemon does, what a loop routine refuses", () => {
    expect(buildRoutineSpec(loopForm({ prompt: "Fix it. {{check}}" }))).toMatchObject({ field: "prompt", error: expect.stringMatching(/placeholders/) });
    expect(buildRoutineSpec(loopForm({ prompt: "x".repeat(8_001) }))).toMatchObject({ field: "prompt", error: expect.stringMatching(/8,000/) });
    expect(buildRoutineSpec(loopForm({ maxCostUsd: "2" }))).toEqual({ error: LOOP_ROUTINE_REFUSES.maxCostUsd, field: "maxCostUsd" });
    expect(buildRoutineSpec(loopForm({ provider: "codex" }))).toEqual({ error: LOOP_ROUTINE_REFUSES.provider, field: "provider" });
    expect(buildRoutineSpec(loopForm({ loop: { checks: [{ id: "", command: "", timeoutSec: "", expectTests: false }], toolBudget: "", attempts: "", attemptMinutes: "", runMinutes: "" } }))).toMatchObject({ field: "loop" });
    expect(buildRoutineSpec(loopForm({ loop: { checks: [{ id: "a", command: "t", timeoutSec: "", expectTests: false }], toolBudget: "0", attempts: "", attemptMinutes: "", runMinutes: "" } }))).toMatchObject({ field: "loop" });
  });

  it("reads a saved loop routine back into the form, and an untouched one changes nothing", () => {
    const r = routine({}, { prompt: "Fix the flaky tests", approvals: "autonomous", check: undefined, loop: loopSpec });
    const f = formFromRoutine(r);
    expect(f.action).toBe("loop");
    expect(f.loop).toEqual({ checks: [{ id: "unit", command: "bun test", timeoutSec: "600", expectTests: true }], toolBudget: "60", attempts: "3", attemptMinutes: "10", runMinutes: "30" });
    expect(buildRoutinePatch(r, f)).toEqual({ patch: {}, changed: [] });
  });

  it("an edited loop is sent whole with its defaults, so a blanked limit returns to its default", () => {
    const r = routine({}, { prompt: "Fix the flaky tests", approvals: "autonomous", check: undefined, loop: { ...loopSpec, limits: { attempts: 5, attemptMinutes: 10, runMinutes: 30 } } });
    const f = formFromRoutine(r);
    expect(buildRoutinePatch(r, { ...f, loop: { ...f.loop, attempts: "" } })).toEqual({
      patch: { loop: { ...loopSpec, limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 } } },
      changed: ["loop"],
    });
  });

  it("switches a session routine to a loop and back", () => {
    // A session prompt's placeholders have to go first: the objective is fixed text.
    const withPlaceholder = routine();
    expect(buildRoutinePatch(withPlaceholder, { ...formFromRoutine(withPlaceholder), action: "loop", loop: loopForm().loop })).toMatchObject({ field: "prompt" });
    const session = routine({}, { prompt: "Fix the flaky tests" });
    const toLoop = buildRoutinePatch(session, { ...formFromRoutine(session), action: "loop", loop: loopForm().loop });
    expect(toLoop).toMatchObject({ patch: { approvals: "autonomous", loop: { checks: [{ id: "unit" }], limits: { attempts: 2, runMinutes: 45 } } } });
    const looped = routine({}, { prompt: "Fix the flaky tests", approvals: "autonomous", check: undefined, loop: loopSpec });
    expect(buildRoutinePatch(looped, { ...formFromRoutine(looped), action: "session" })).toEqual({ patch: { loop: null }, changed: ["loop"] });
  });

  it("reads a run's loop run off the wire, and words the loop's budgets", () => {
    expect(routineRunLoop(runWire({ loop: { runId: "loop_9", status: "verifying" } }))).toEqual({ runId: "loop_9", status: "verifying" });
    expect(routineRunLoop(runWire())).toBeNull();
    expect(routineLoopOf(routine())).toBeNull();
    expect(routineBudgetText(routine({}, { loop: loopSpec, dailyCostUsd: 5 }).spec)).toBe(
      "loop: 3 attempts of up to 10m · 30m per loop run · 60 tool calls per attempt · $5 per day",
    );
  });

  it("warns when a loop routine has no gate", () => {
    expect(routineWarnings(loopForm()).join(" ")).toMatch(/No gate/);
    expect(routineWarnings(loopForm({ checkCommand: "bun test 2>&1 | grep fail || true" }))).toEqual([]);
  });
});
