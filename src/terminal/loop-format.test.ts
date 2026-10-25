import { describe, expect, test } from "bun:test";
import type { LoopRunWire } from "../protocol/types.js";
import { formatLoop, formatLoopRow, parseCheckFlag } from "./loop-format";

const run: LoopRunWire = {
  id: "loop_12345678-aaaa-bbbb-cccc-1234567890ab",
  recipe: "repair",
  objective: "Fix the checkout regression\nwith detail",
  workdir: "/repo",
  checks: [{ id: "test", command: "bun test", timeoutSec: 600 }],
  limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 },
  toolBudget: 60,
  status: "completed",
  reason: "every check passed on attempt 2",
  waitingOn: null,
  waitingKind: null,
  baseRevision: "abcdef0123456789",
  branch: "codeoid/loop-12345678-ab12",
  worktreePath: "/wt",
  workerSessionId: "sess-1234-5678",
  acceptedAttemptId: "att_2",
  deliveredCommit: "0123456789abcdef0123456789abcdef01234567",
  attempts: 2,
  activeMs: 95_000,
  costUsd: 0.42,
  createdAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:02:00.000Z",
  endedAt: "2026-10-25T10:02:00.000Z",
};

describe("loop formatting", () => {
  test("a row shows status, attempts and the objective's first line", () => {
    expect(formatLoopRow(run)).toBe("✓ loop_12345678  completed        2/3  Fix the checkout regression");
  });

  test("the detail names the delivered commit, the budget, and each attempt's evidence", () => {
    const text = formatLoop(run, [
      {
        id: "att_1",
        ordinal: 1,
        status: "done",
        result: "unverified",
        note: "1 of 1 check(s) not passing: test fail",
        report: { outcome: "ready_for_verification", summary: "done" },
        candidateTree: "t1",
        evidenceIds: ["ev_1"],
        workerSessionId: "s",
        provider: "claude",
        model: null,
        startedAt: "2026-10-25T10:00:00.000Z",
        endedAt: "2026-10-25T10:01:00.000Z",
        costUsd: 0.2,
      },
    ]).join("\n");
    expect(text).toContain("delivered  0123456789ab on codeoid/loop-12345678-ab12");
    expect(text).toContain("2/3 attempts · 1.6m of 30m · $0.42");
    expect(text).toContain("#1 unverified 1.0m — 1 of 1 check(s) not passing");
    expect(text).toContain("worker: ready_for_verification — done");
    expect(text).toContain("evidence: ev_1");
  });

  test("--check takes a command or `id: command`", () => {
    expect(parseCheckFlag("bun test")).toEqual({ command: "bun test" });
    expect(parseCheckFlag("unit: bun test --bail")).toEqual({ id: "unit", command: "bun test --bail" });
    expect(parseCheckFlag("NODE_ENV=test bun test")).toEqual({ command: "NODE_ENV=test bun test" });
    expect(parseCheckFlag("go test ./...")).toEqual({ command: "go test ./..." });
  });
});
