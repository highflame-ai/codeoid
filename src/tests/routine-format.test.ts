import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoutineRunWire, RoutineWire } from "../protocol/types.js";
import {
  formatRoutine,
  formatRoutineList,
  formatRun,
  RoutineFlagError,
  relativeTime,
  scheduleFromFlags,
  specFromFlags,
} from "../terminal/routine-format.js";

describe("specFromFlags", () => {
  it("builds a full spec for add, defaulting the workdir to here", () => {
    const spec = specFromFlags(
      "nightly",
      { prompt: "triage", cron: "0 2 * * *", tz: "UTC", check: "gh pr list --json number", checkTimeout: "30", maxCost: "1.5", guarded: true, worktree: true, api: true },
      "add",
    );
    expect(spec).toEqual({
      name: "nightly",
      prompt: "triage",
      workdir: process.cwd(),
      schedule: { kind: "cron", expr: "0 2 * * *", timezone: "UTC" },
      check: { command: "gh pr list --json number", timeoutSeconds: 30 },
      approvals: "guarded",
      maxCostUsd: 1.5,
      worktree: true,
      api: true,
    });
  });

  it("reads the prompt from a file", () => {
    const f = join(mkdtempSync(join(tmpdir(), "rt-")), "p.md");
    writeFileSync(f, "From a file.");
    expect(specFromFlags("x", { promptFile: f }, "add").prompt).toBe("From a file.");
  });

  it("an edit carries only what was given, and --no-… clears", () => {
    expect(specFromFlags("x", { maxMinutes: "30" }, "edit")).toEqual({ maxMinutes: 30 });
    expect(specFromFlags("x", { schedule: false, check: false, api: false }, "edit")).toEqual({ schedule: null, check: null, api: false });
    // commander defaults a lone --no-schedule to true: that must not clear anything.
    expect(specFromFlags("x", { schedule: true }, "edit")).toEqual({});
  });

  it("parses intervals and rejects contradictions with clear messages", () => {
    expect(specFromFlags("x", { prompt: "p", every: "1h30m" }, "add").schedule).toEqual({ kind: "every", seconds: 5400 });
    const bad: Array<[Parameters<typeof specFromFlags>[1], string]> = [
      [{ prompt: "p", cron: "* * * * *", every: "5m" }, "one of --cron, --every, or --at"],
      [{ prompt: "p", every: "soon" }, "not an interval"],
      [{ prompt: "p", tz: "UTC" }, "--tz applies to --cron"],
      [{ prompt: "p", guarded: true, autonomous: true }, "not both"],
      [{ prompt: "p", maxCost: "lots" }, "--max-cost must be a number"],
      [{ prompt: "p", checkTimeout: "5" }, "--check-timeout needs --check"],
      [{}, "a prompt is required"],
    ];
    for (const [flags, msg] of bad) {
      expect(() => specFromFlags("x", flags, "add")).toThrow(RoutineFlagError);
      expect(() => specFromFlags("x", flags, "add")).toThrow(msg);
    }
  });

  it("cron without --tz leaves the zone to the daemon, and a relative workdir is made absolute here", () => {
    expect(scheduleFromFlags({ cron: "0 9 * * *" })).toEqual({ kind: "cron", expr: "0 9 * * *" });
    expect(specFromFlags("x", { workdir: "sub/dir" }, "edit")).toEqual({ workdir: join(process.cwd(), "sub/dir") });
    expect(specFromFlags("x", { workdir: "~/repo" }, "edit")).toEqual({ workdir: "~/repo" });
  });
});

const NOW = Date.parse("2026-10-16T08:00:00Z");
const run = (over: Partial<RoutineRunWire> = {}): RoutineRunWire => ({
  id: "run-1",
  routineId: "r1",
  trigger: "schedule",
  status: "succeeded",
  createdAt: "2026-10-16T07:58:00Z",
  costUsd: 0.042,
  inputTokens: 100,
  outputTokens: 20,
  ...over,
});
const routine = (over: Partial<RoutineWire> = {}): RoutineWire => ({
  id: "r1",
  name: "triage",
  enabled: true,
  ownerSub: "u",
  spec: {
    name: "triage",
    prompt: "Triage open PRs.\nBe brief.",
    workdir: "/repo",
    approvals: "autonomous",
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
    check: { command: "gh pr list", timeoutSeconds: 60 },
    maxCostUsd: 1,
  },
  scheduleText: "cron 0 9 * * 1-5 (UTC)",
  upcoming: ["2026-10-16T09:00:00Z"],
  consecutiveFailures: 0,
  apiTokenSet: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

describe("output", () => {
  it("relative times read naturally both ways", () => {
    expect(relativeTime("2026-10-16T09:00:00Z", NOW)).toBe("in 1h");
    expect(relativeTime("2026-10-16T07:58:00Z", NOW)).toBe("2m ago");
    expect(relativeTime(undefined, NOW)).toBe("—");
  });

  it("the list is a table with state, next fire, and the last outcome", () => {
    const lines = formatRoutineList([routine({ lastRun: run() }), routine({ name: "paused-one", enabled: false, pausedReason: "paused after 3 consecutive failed runs" })], NOW);
    expect(lines[0]).toMatch(/^NAME\s+STATE\s+SCHEDULE\s+NEXT\s+LAST RUN$/);
    expect(lines[1]).toContain("triage");
    expect(lines[1]).toContain("in 1h");
    expect(lines[1]).toContain("succeeded 2m ago");
    expect(lines[2]).toContain("paused!");
    expect(formatRoutineList([], NOW)[0]).toContain("No routines");
  });

  it("a run shows its outcome, reason, a bounded summary, and where to look", () => {
    const lines = formatRun(run({ status: "needs_attention", reason: "waiting for approval to run Bash", summary: Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), sessionId: "s1" }), NOW);
    expect(lines[0]).toContain("needs_attention");
    expect(lines).toContain("    waiting for approval to run Bash");
    expect(lines.filter((l) => l.includes("│"))).toHaveLength(6);
    expect(lines.at(-1)).toBe("    session s1");
  });

  it("the detail view spells out the safety posture", () => {
    const text = formatRoutine(routine(), [run()], NOW).join("\n");
    expect(text).toContain("autonomous (up to 50 tool calls)");
    expect(text).toContain("15m per run · $1.00 per run");
    expect(text).toContain("no output = nothing to do");
    expect(text).toContain("recent runs");
  });
});
