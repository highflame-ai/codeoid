/**
 * `codeoid routine …` — flag parsing and output formatting (docs/routines.md).
 * Pure functions: the CLI wires them to the daemon; tests drive them directly.
 */

import { readFileSync } from "node:fs";
import type { RoutineRunWire, RoutineScheduleWire, RoutineSpecWire, RoutineWire } from "../protocol/types.js";
import { hostTimezone, parseInterval } from "../daemon/routines/schedule.js";

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
  if (f.cron !== undefined) return { kind: "cron", expr: f.cron, timezone: f.tz ?? hostTimezone() };
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
    out.workdir = f.workdir ?? process.cwd();
  } else if (f.workdir !== undefined) {
    out.workdir = f.workdir;
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
  return out;
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
  return lines;
}

export function formatRoutine(r: RoutineWire, runs: RoutineRunWire[] = [], now = Date.now()): string[] {
  const s = r.spec;
  const out = [
    `${r.name}  (${r.enabled ? "on" : "paused"})${r.pausedReason ? ` — ${r.pausedReason}` : ""}`,
    `  schedule   ${r.scheduleText}${r.enabled && r.upcoming.length > 0 ? `  · next ${r.upcoming.map((u) => relativeTime(u, now)).join(", ")}` : ""}`,
    `  workdir    ${s.workdir}${s.worktree ? "  (fresh git worktree per run)" : ""}`,
    `  backend    ${s.provider ?? "default"}${s.model ? ` · ${s.model}` : ""}  · ${s.session} session`,
    `  approvals  ${s.approvals}${s.approvals === "autonomous" ? ` (up to ${s.toolBudget} tool calls)` : " (non-read tools wait for you)"}`,
    `  limits     ${s.maxMinutes}m per run${s.maxCostUsd !== undefined ? ` · ${money(s.maxCostUsd)} per run` : ""}${s.dailyCostUsd !== undefined ? ` · ${money(s.dailyCostUsd)}/day` : ""} · pause after ${s.failurePauseAfter || "never"} failures`,
  ];
  if (s.check) out.push(`  check      ${s.check.command}  (timeout ${s.check.timeoutSeconds}s; no output = nothing to do)`);
  out.push(`  notify     ${s.notify.replace("_", " ")} · overlap ${s.overlap}${s.catchUp ? " · catch up missed runs" : ""}`);
  out.push(`  api        ${s.api ? (r.apiTokenSet ? "on (token set)" : "on (no token — run `codeoid routine token`)") : "off"}`);
  out.push("", "  prompt", ...s.prompt.split("\n").map((l) => `    ${l}`));
  if (runs.length > 0) {
    out.push("", "  recent runs");
    for (const run of runs) out.push(...formatRun(run, now).map((l) => `  ${l}`));
  }
  return out;
}
