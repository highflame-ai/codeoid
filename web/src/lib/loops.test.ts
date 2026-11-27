import { describe, expect, it } from "vitest";

import {
  LOOP_APPROVAL_WAIT,
  LOOP_STATUS,
  buildLoopStart,
  emptyCheckRow,
  emptyLoopForm,
  loopActions,
  loopQuestion,
  loopWaitKind,
  type LoopStartForm,
} from "./loops";

const form = (over: Partial<LoopStartForm> = {}): LoopStartForm => ({
  ...emptyLoopForm(),
  objective: "Fix the checkout test",
  workdir: "/repo",
  checks: [{ ...emptyCheckRow(), command: "bun test src/checkout" }],
  ...over,
});

describe("buildLoopStart", () => {
  it("builds the smallest message, leaving defaults to the daemon", () => {
    expect(buildLoopStart(form())).toEqual({
      msg: { type: "loop.start", objective: "Fix the checkout test", workdir: "/repo", checks: [{ command: "bun test src/checkout" }] },
    });
  });

  it("carries named checks, timeouts, test runs, limits, budget, backend and model", () => {
    const built = buildLoopStart(
      form({
        checks: [
          { id: "unit", command: "bun test", timeoutSec: "120", expectTests: true },
          { id: "", command: "bun run typecheck", timeoutSec: "", expectTests: false },
        ],
        attempts: "5",
        runMinutes: "60",
        toolBudget: "100",
        provider: "claude",
        model: "opus",
      }),
    );
    expect(built).toEqual({
      msg: {
        type: "loop.start",
        objective: "Fix the checkout test",
        workdir: "/repo",
        checks: [{ id: "unit", command: "bun test", timeoutSec: 120, expectTests: true }, { command: "bun run typecheck" }],
        provider: "claude",
        model: "opus",
        toolBudget: 100,
        limits: { attempts: 5, runMinutes: 60 },
      },
    });
  });

  it("drops untouched check rows and refuses what the form can judge", () => {
    expect(buildLoopStart(form({ checks: [...form().checks, emptyCheckRow()] }))).toHaveProperty("msg.checks.length", 1);
    expect(buildLoopStart(form({ objective: "  " }))).toEqual({ error: "Describe the objective" });
    expect(buildLoopStart(form({ workdir: "" }))).toEqual({ error: "Choose the repository to work in" });
    expect(buildLoopStart(form({ checks: [emptyCheckRow()] }))).toEqual({ error: "Add at least one check: the command that must pass" });
    expect(buildLoopStart(form({ checks: [{ ...emptyCheckRow(), id: "unit" }] }))).toEqual({ error: "Check 1 has no command" });
    expect(buildLoopStart(form({ attempts: "two" }))).toEqual({ error: "Attempts must be a whole number of at least 1" });
    expect(buildLoopStart(form({ toolBudget: "0" }))).toEqual({ error: "Tool budget must be a whole number of at least 1" });
  });
});

describe("loop status", () => {
  it("tells an approval wait from the worker's question", () => {
    expect(loopWaitKind({ status: "waiting", waitingOn: LOOP_APPROVAL_WAIT })).toBe("approval");
    expect(loopWaitKind({ status: "waiting", waitingOn: "the owner's answer: Keep the old API?" })).toBe("question");
    expect(loopWaitKind({ status: "running", waitingOn: null })).toBeNull();
    expect(loopQuestion("the owner's answer: Keep the old API?")).toBe("Keep the old API?");
  });

  it("says each ending differently", () => {
    const labels = (["completed", "budget_exhausted", "blocked", "failed"] as const).map((s) => LOOP_STATUS[s].label);
    expect(new Set(labels).size).toBe(4);
    expect(LOOP_STATUS.completed.label).toBe("verified");
  });

  it("offers only the controls a status accepts", () => {
    expect(loopActions("running")).toEqual({ pause: true, resume: false, cancel: true, steer: true });
    expect(loopActions("paused")).toEqual({ pause: false, resume: true, cancel: true, steer: true });
    expect(loopActions("completed")).toEqual({ pause: false, resume: false, cancel: false, steer: false });
  });
});
