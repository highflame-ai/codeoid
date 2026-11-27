/**
 * Test fixtures for the automation views: a routine, a routine run, a watch,
 * a watch trigger, and a loop run, each overridable. Not a test file itself,
 * so several tests can share it without running each other's cases.
 */

import type { LoopRunWire, LoopWatchTriggerWire, LoopWatchWire, RoutineRunWire, RoutineWire } from "../protocol/types";

export function routine(over: Partial<RoutineWire> = {}, spec: Partial<RoutineWire["spec"]> = {}): RoutineWire {
  return {
    id: "rt_1",
    name: "ci-watch",
    enabled: true,
    ownerSub: "u",
    spec: {
      name: "ci-watch",
      prompt: "Find why CI is red. {{check}}",
      workdir: "/repo",
      schedule: { kind: "every", seconds: 900 },
      check: { command: "gh run list", timeoutSeconds: 60 },
      approvals: "guarded",
      toolBudget: 50,
      maxMinutes: 15,
      session: "fresh",
      worktree: false,
      overlap: "skip",
      catchUp: false,
      jitterSeconds: 0,
      notify: "on_change",
      keepSessions: 5,
      api: false,
      failurePauseAfter: 3,
      ...spec,
    },
    scheduleText: "every 15m",
    upcoming: ["2026-10-26T12:15:00.000Z", "2026-10-26T12:30:00.000Z", "2026-10-26T12:45:00.000Z"],
    consecutiveFailures: 0,
    apiTokenSet: false,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    ...over,
  };
}

export function runWire(over: Partial<RoutineRunWire> = {}): RoutineRunWire {
  return {
    id: "run_1",
    routineId: "rt_1",
    trigger: "schedule",
    status: "succeeded",
    createdAt: "2026-10-26T11:00:00.000Z",
    startedAt: "2026-10-26T11:00:01.000Z",
    endedAt: "2026-10-26T11:02:01.000Z",
    costUsd: 0.12,
    inputTokens: 1000,
    outputTokens: 200,
    summary: "CI is green again",
    ...over,
  };
}

export function watch(over: Partial<LoopWatchWire> = {}): LoopWatchWire {
  return {
    id: "w_1",
    workdir: "/src/shop",
    repo: "acme/shop",
    branches: ["main"],
    myPrs: false,
    ci: [{ ciName: "test (*)", app: "github-actions", command: "bun test", timeoutSec: 600, expectTests: true }],
    review: { enabled: false, allow: [], mention: "@codeoid" },
    ghLogin: "me",
    trust: ["alice"],
    maxRunsPerHour: 6,
    enabled: true,
    lastPolledAt: "2026-10-26T11:55:00.000Z",
    lastError: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    ...over,
  };
}

export function trigger(over: Partial<LoopWatchTriggerWire> = {}): LoopWatchTriggerWire {
  return {
    key: "ci:acme/shop:0123456789abcdef0123:77:5",
    kind: "ci_failure",
    branch: "main",
    runId: "loop_1",
    outcome: "run",
    note: null,
    createdAt: "2026-10-26T11:00:00.000Z",
    ...over,
  };
}

export function loopRun(over: Partial<LoopRunWire> = {}): LoopRunWire {
  return {
    id: "loop_1",
    recipe: "repair",
    objective: "Make test (*) pass",
    workdir: "/src/shop",
    checks: [{ id: "check1", command: "bun test", timeoutSec: 600 }],
    limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 },
    toolBudget: 60,
    status: "running",
    reason: null,
    waitingOn: null,
    waitingKind: null,
    baseRevision: null,
    branch: null,
    worktreePath: null,
    workerSessionId: null,
    acceptedAttemptId: null,
    deliveredCommit: null,
    attempts: 1,
    activeMs: 0,
    costUsd: 0,
    createdAt: "2026-10-26T11:00:00.000Z",
    updatedAt: "2026-10-26T11:00:00.000Z",
    endedAt: null,
    ...over,
  };
}
