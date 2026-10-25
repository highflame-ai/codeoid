/**
 * `codeoid routine …` — flag parsing and output formatting (docs/routines.md).
 * Pure functions: the CLI wires them to the daemon; tests drive them directly.
 */

import { readFileSync } from "node:fs";
import type { RoutineRunWire, RoutineScheduleWire, RoutineSpecWire, RoutineWire } from "../protocol/types.js";
import { isAbsolute, resolve } from "node:path";
import { parseInterval } from "../daemon/routines/schedule.js";
import { parseCheckFlag } from "./loop-format.js";

/** A relative path means relative to where the command was typed, not the daemon's cwd. `~` is the daemon's to expand. */
const absWorkdir = (p: string): string => (isAbsolute(p) || p.startsWith("~") ? p : resolve(p));

/** Flags shared by `routine add` and `routine edit` (commander's camelCased options). */
export interface RoutineFlags {
  workdir?: string;
  prompt?: string;
  promptFile?: string;
  cron?: string;
  tz?: string;
  every?: string;
  at?: string;
  schedule?: boolean; // --no-schedule (edit only) → false
  check?: string | boolean; // --check <cmd>; --no-check (edit) → false
  checkTimeout?: string;
  provider?: string;
  model?: string;
  guarded?: boolean;
  autonomous?: boolean;
  toolBudget?: string;
  maxMinutes?: string;
  maxCost?: string;
  dailyCost?: string;
  persistent?: boolean;
  fresh?: boolean;
  worktree?: boolean;
  overlap?: string;
  catchUp?: boolean;
  jitter?: string;
  notify?: string;
  keep?: string;
  api?: boolean;
  failurePause?: string;
  /** --loop: start a loop instead of a session; --no-loop (edit) → false. */
  loop?: boolean;
  /** --verify: the loop's acceptance checks, `cmd` or `id: cmd` (repeatable). */
  verify?: string[];
  test?: boolean;
  attempts?: string;
  attemptMinutes?: string;
  runMinutes?: string;
  budget?: string;
}

export class RoutineFlagError extends Error {}

const num = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RoutineFlagError(`--${flag} must be a number, got "${v}"`);
  return n;
};

/** The schedule the flags describe, `null` for --no-schedule, `undefined` when none given. */
export function scheduleFromFlags(f: RoutineFlags): RoutineScheduleWire | null | undefined {
  const given = [f.cron, f.every, f.at].filter((x) => x !== undefined).length;
  if (given > 1) throw new RoutineFlagError("use one of --cron, --every, or --at");
  if (f.schedule === false) {
    if (given > 0) throw new RoutineFlagError("--no-schedule can't be combined with a schedule");
    return null;
  }
  // No --tz: the daemon decides — its own zone on add, the routine's current one on edit.
  if (f.cron !== undefined) return { kind: "cron", expr: f.cron, ...(f.tz !== undefined ? { timezone: f.tz } : {}) };
  if (f.tz !== undefined) throw new RoutineFlagError("--tz applies to --cron");
  if (f.every !== undefined) {
    try {
      return { kind: "every", seconds: parseInterval(f.every) };
    } catch (err) {
      throw new RoutineFlagError(err instanceof Error ? err.message : String(err));
    }
  }
  if (f.at !== undefined) return { kind: "once", at: f.at };
  return undefined;
}

/**
 * Build a spec (add) or a patch (edit) from flags. On edit, only flags the
 * user gave are included, and `--no-…` flags clear with `null`.
 */
export function specFromFlags(
  name: string,
  f: RoutineFlags,
  mode: "add" | "edit",
): Partial<Record<keyof RoutineSpecWire, unknown>> {
  const out: Partial<Record<keyof RoutineSpecWire, unknown>> = {};
  if (mode === "add") out.name = name;
  if (f.prompt !== undefined && f.promptFile !== undefined) throw new RoutineFlagError("use --prompt or --prompt-file, not both");
  if (f.prompt !== undefined) out.prompt = f.prompt;
  if (f.promptFile !== undefined) {
    try {
      out.prompt = readFileSync(f.promptFile, "utf8");
    } catch (err) {
      throw new RoutineFlagError(`can't read --prompt-file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (mode === "add") {
    if (out.prompt === undefined) throw new RoutineFlagError("a prompt is required: --prompt \"…\" or --prompt-file <path>");
    out.workdir = absWorkdir(f.workdir ?? ".");
  } else if (f.workdir !== undefined) {
    out.workdir = absWorkdir(f.workdir);
  }
  const schedule = scheduleFromFlags(f);
  if (schedule !== undefined) out.schedule = schedule;
  if (f.check === false) out.check = null;
  else if (typeof f.check === "string") out.check = { command: f.check, ...(f.checkTimeout ? { timeoutSeconds: num(f.checkTimeout, "check-timeout") } : {}) };
  else if (f.checkTimeout !== undefined) throw new RoutineFlagError("--check-timeout needs --check");
  if (f.provider !== undefined) out.provider = f.provider;
  if (f.model !== undefined) out.model = f.model;
  if (f.guarded && f.autonomous) throw new RoutineFlagError("use --guarded or --autonomous, not both");
  if (f.guarded) out.approvals = "guarded";
  if (f.autonomous) out.approvals = "autonomous";
  if (f.persistent && f.fresh) throw new RoutineFlagError("use --persistent or --fresh, not both");
  if (f.persistent) out.session = "persistent";
  if (f.fresh) out.session = "fresh";
  const ints: Array<[keyof RoutineFlags, keyof RoutineSpecWire, string]> = [
    ["toolBudget", "toolBudget", "tool-budget"],
    ["maxMinutes", "maxMinutes", "max-minutes"],
    ["jitter", "jitterSeconds", "jitter"],
    ["keep", "keepSessions", "keep"],
    ["failurePause", "failurePauseAfter", "failure-pause"],
  ];
  for (const [flag, field, label] of ints) {
    const v = num(f[flag] as string | undefined, label);
    if (v !== undefined) out[field] = v;
  }
  const maxCost = num(f.maxCost, "max-cost");
  if (maxCost !== undefined) out.maxCostUsd = maxCost;
  const dailyCost = num(f.dailyCost, "daily-cost");
  if (dailyCost !== undefined) out.dailyCostUsd = dailyCost;
  if (f.worktree !== undefined) out.worktree = f.worktree;
  if (f.catchUp !== undefined) out.catchUp = f.catchUp;
  if (f.api !== undefined) out.api = f.api;
  if (f.overlap !== undefined) out.overlap = f.overlap;
  if (f.notify !== undefined) out.notify = f.notify;
  const loop = loopFromFlags(f, mode);
  if (loop !== undefined) out.loop = loop;
  return out;
}

/**
 * The loop a routine starts, from `--loop` and its flags: `null` for
 * --no-loop, `undefined` when none given. `--check` stays the routine's gate;
 * `--verify` names the loop's acceptance checks. On edit the daemon merges
 * what is given over the current loop, so `--verify` replaces the checks and
 * a limit alone changes just that limit.
 */
function loopFromFlags(f: RoutineFlags, mode: "add" | "edit"): Record<string, unknown> | null | undefined {
  const verify = f.verify ?? [];
  const limits: Record<string, number> = {};
  const lim: Array<[keyof RoutineFlags, string, string]> = [
    ["attempts", "attempts", "attempts"],
    ["attemptMinutes", "attemptMinutes", "attempt-minutes"],
    ["runMinutes", "runMinutes", "run-minutes"],
  ];
  for (const [flag, field, label] of lim) {
    const v = num(f[flag] as string | undefined, label);
    if (v !== undefined) limits[field] = v;
  }
  const budget = num(f.budget, "budget");
  const given = verify.length > 0 || f.test !== undefined || Object.keys(limits).length > 0 || budget !== undefined;
  if (f.loop === false) {
    if (given) throw new RoutineFlagError("--no-loop can't be combined with --verify, --test, or a loop limit");
    return null;
  }
  if (f.test && verify.length === 0) throw new RoutineFlagError("--test applies to the --verify checks: give them with it");
  if (mode === "add") {
    if (!f.loop) {
      if (given) throw new RoutineFlagError("--verify, --test, --attempts, --attempt-minutes, --run-minutes and --budget need --loop");
      return undefined;
    }
    if (verify.length === 0) throw new RoutineFlagError('a loop routine needs at least one --verify "id: cmd" — the check its loop must make pass (--check is the gate that decides whether it starts)');
    // These shape a session run and would be silently ignored by a loop.
    const ignored: Array<[keyof RoutineFlags, string, string]> = [
      ["toolBudget", "--tool-budget", "use --budget (tool calls per attempt)"],
      ["maxMinutes", "--max-minutes", "use --attempt-minutes and --run-minutes"],
      ["keep", "--keep", "a loop keeps its own worker session"],
    ];
    for (const [flag, label, instead] of ignored) {
      if (f[flag] !== undefined) throw new RoutineFlagError(`${label} doesn't apply to a loop routine: ${instead}`);
    }
  } else if (!f.loop && !given) {
    return undefined;
  }
  return {
    ...(verify.length > 0 ? { checks: verify.map((raw) => ({ ...parseCheckFlag(raw), ...(f.test ? { expectTests: true } : {}) })) } : {}),
    ...(budget !== undefined ? { toolBudget: budget } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

/** "in 3h", "2m ago" — relative to `now`. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const unit =
    abs < 60_000 ? `${Math.round(abs / 1000)}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

const money = (usd: number) => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;

function pad(cells: string[][]): string[] {
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd());
}

export function formatRoutineList(routines: RoutineWire[], now = Date.now()): string[] {
  if (routines.length === 0) return ["No routines. Create one with: codeoid routine add <name> --cron \"0 9 * * 1-5\" --prompt \"…\""];
  const rows = [["NAME", "STATE", "SCHEDULE", "NEXT", "LAST RUN"]];
  for (const r of routines) {
    rows.push([
      r.name,
      r.enabled ? "on" : r.pausedReason ? "paused!" : "paused",
      r.scheduleText,
      r.enabled ? relativeTime(r.upcoming[0], now) : "—",
      r.lastRun ? `${r.lastRun.status} ${relativeTime(r.lastRun.createdAt, now)}` : "never",
    ]);
  }
  return pad(rows);
}

export function formatRun(run: RoutineRunWire, now = Date.now()): string[] {
  const head = `${relativeTime(run.createdAt, now).padEnd(8)} ${run.status.padEnd(15)} ${run.trigger.padEnd(8)} ${money(run.costUsd)}`;
  const lines = [head];
  if (run.reason) lines.push(`    ${run.reason}`);
  if (run.summary) lines.push(...run.summary.split("\n").slice(0, 6).map((l) => `    │ ${l}`));
  if (run.sessionId) lines.push(`    session ${run.sessionId}`);
  if (run.loop) lines.push(`    loop ${run.loop.runId}  ${run.loop.status}  (codeoid loop show ${run.loop.runId})`);
  return lines;
}

export function formatRoutine(r: RoutineWire, runs: RoutineRunWire[] = [], now = Date.now()): string[] {
  const s = r.spec;
  const head = [
    `${r.name}  (${r.enabled ? "on" : "paused"})${r.pausedReason ? ` — ${r.pausedReason}` : ""}`,
    `  schedule   ${r.scheduleText}${r.enabled && r.upcoming.length > 0 ? `  · next ${r.upcoming.map((u) => relativeTime(u, now)).join(", ")}` : ""}`,
  ];
  const daily = s.dailyCostUsd !== undefined ? ` · ${money(s.dailyCostUsd)}/day` : "";
  const out = s.loop
    ? [
        ...head,
        `  action     starts a loop run (codeoid loop ls), in its own worktree of ${s.workdir}`,
        `  backend    ${s.provider ?? "default"}${s.model ? ` · ${s.model}` : ""}`,
        ...s.loop.checks.map((c) => `  verify     ${c.id}: ${c.command}${c.expectTests ? " (tests)" : ""}`),
        `  limits     ${s.loop.limits.attempts} attempts · ${s.loop.limits.attemptMinutes}m each · ${s.loop.limits.runMinutes}m per run · ${s.loop.toolBudget} tool calls per attempt${daily} · pause after ${s.failurePauseAfter || "never"} failures`,
      ]
    : [
        ...head,
        `  workdir    ${s.workdir}${s.worktree ? "  (fresh git worktree per run)" : ""}`,
        `  backend    ${s.provider ?? "default"}${s.model ? ` · ${s.model}` : ""}  · ${s.session} session`,
        `  approvals  ${s.approvals}${s.approvals === "autonomous" ? ` (up to ${s.toolBudget} tool calls)` : " (non-read tools wait for you)"}`,
        `  limits     ${s.maxMinutes}m per run${s.maxCostUsd !== undefined ? ` · ${money(s.maxCostUsd)} per run` : ""}${daily} · pause after ${s.failurePauseAfter || "never"} failures`,
      ];
  if (s.check) out.push(`  check      ${s.check.command}  (timeout ${s.check.timeoutSeconds}s; no output = nothing to do)`);
  out.push(`  notify     ${s.notify.replace("_", " ")} · overlap ${s.overlap}${s.catchUp ? " · catch up missed runs" : ""}`);
  out.push(`  api        ${s.api ? (r.apiTokenSet ? "on (token set)" : "on (no token — run `codeoid routine token`)") : "off"}`);
  out.push("", s.loop ? "  objective" : "  prompt", ...s.prompt.split("\n").map((l) => `    ${l}`));
  if (runs.length > 0) {
    out.push("", "  recent runs");
    for (const run of runs) out.push(...formatRun(run, now).map((l) => `  ${l}`));
  }
  return out;
}
