/**
 * Routines (docs/routines.md) — the words and colours for a run's outcome,
 * schedules in human words, and the create/edit form's validation and diff.
 * Pure, so the decisions are tested without a reactive root.
 *
 * The form only checks what it can know (shape, required fields, the
 * schedule's syntax); ranges, workdirs and backends are the daemon's to judge,
 * and its words are shown as they come.
 */

import { absoluteTime, optionalInt, optionalUsd } from "./automation";
import type { LoopStatusStyle } from "./loops";
import { emptyCheckRow, type LoopCheckRow } from "./loops";
import type {
  LoopStatusWire,
  RoutineLoopSpecWire,
  RoutineLoopWire,
  RoutineRunStatus,
  RoutineRunWire,
  RoutineScheduleWire,
  RoutineSpecWire,
  RoutineUpdateMsg,
  RoutineWire,
} from "../protocol/types";

// ── Outcomes ─────────────────────────────────────────────────────────────────

/** Same shape as `LOOP_STATUS`, so the two read as one family of badges. */
export const ROUTINE_RUN_STATUS: Record<RoutineRunStatus, LoopStatusStyle> = {
  queued: { mark: "…", label: "queued", cls: "border-accent/50 bg-accent/10 text-accent", meaning: "Waiting for a free run slot." },
  checking: {
    mark: "⋯",
    label: "checking",
    cls: "border-accent/50 bg-accent/10 text-accent",
    meaning: "The check is running. No agent has started yet.",
  },
  running: { mark: "▶", label: "running", cls: "border-accent/50 bg-accent/10 text-accent", meaning: "The agent is working." },
  succeeded: {
    mark: "✓",
    label: "succeeded",
    cls: "border-success/50 bg-success/10 text-success",
    meaning: "The agent finished and reported something. Its summary is the run's headline.",
  },
  silent: {
    mark: "○",
    label: "silent",
    cls: "border-border bg-bg/40 text-fg-muted",
    meaning: "Nothing to do: the check printed nothing, or the agent replied [SILENT]. Nothing was spent on a silent check.",
  },
  needs_attention: {
    mark: "⏸",
    label: "needs you",
    cls: "border-warn/60 bg-warn/15 text-warn",
    meaning: "The agent waits on you for a tool approval. Its session stays parked so you can answer it there.",
  },
  failed: {
    mark: "✗",
    label: "failed",
    cls: "border-danger/40 bg-danger/5 text-danger",
    meaning: "The check failed, the agent errored, or the session went away. Counts toward the failure pause.",
  },
  timed_out: {
    mark: "✗",
    label: "timed out",
    cls: "border-warn/50 bg-warn/10 text-warn",
    meaning: "It ran past its time limit and was interrupted. Counts toward the failure pause.",
  },
  over_budget: {
    mark: "✗",
    label: "over budget",
    cls: "border-warn/50 bg-warn/10 text-warn",
    meaning: "It crossed its spend limit and was stopped. Counts toward the failure pause.",
  },
  skipped: {
    mark: "–",
    label: "skipped",
    cls: "border-border bg-bg/40 text-fg-faint",
    meaning:
      "It didn't run: the last run was still going, the daily spend cap was reached, the routine was paused, or the fire was missed while the daemon was down.",
  },
  cancelled: { mark: "■", label: "cancelled", cls: "border-border bg-bg/40 text-fg-faint", meaning: "Someone cancelled it." },
  interrupted: {
    mark: "!",
    label: "interrupted",
    cls: "border-danger/40 bg-danger/5 text-danger",
    meaning: "The daemon stopped while it was in flight.",
  },
};

/**
 * A loop routine's run whose loop tried and ended blocked: `needs_attention`
 * on the wire, but it is the loop that is stuck, not a session waiting on an
 * approval — and it counts toward the failure pause.
 */
const LOOP_BLOCKED: LoopStatusStyle = {
  mark: "⏸",
  label: "loop blocked",
  cls: "border-warn/60 bg-warn/15 text-warn",
  meaning: "The loop it started tried and stopped blocked: it isn't making progress, or the objective conflicts with its checks. Open the loop run to see why. Counts toward the failure pause.",
};

/** How a run's outcome reads: as its status says, except a loop routine's blocked loop. */
export function routineRunStatusStyle(run: Pick<RoutineRunWire, "status" | "loop">): LoopStatusStyle {
  return run.status === "needs_attention" && run.loop ? LOOP_BLOCKED : ROUTINE_RUN_STATUS[run.status];
}

/** Statuses that count toward the failure pause (docs/routines.md "Outcomes"). */
const FAILING: readonly RoutineRunStatus[] = ["failed", "timed_out", "over_budget"];

/** Counts toward the failure pause: a failure, or a loop routine's loop that ended blocked after trying. */
export function isFailingRun(status: RoutineRunStatus, loop?: RoutineRunWire["loop"]): boolean {
  return FAILING.includes(status) || (status === "needs_attention" && !!loop);
}

/**
 * The routine wants a look (the drawer's tab alert): it paused itself, or its
 * last outcome failed. The outcome, not the last run: fires skipped behind a
 * loop, or cancelled, say nothing about how it went.
 */
export function routineNeedsALook(r: Pick<RoutineWire, "pausedReason" | "lastOutcome">): boolean {
  return !!r.pausedReason || (!!r.lastOutcome && isFailingRun(r.lastOutcome.status, r.lastOutcome.loop));
}

/** A run that is still going, so cancel applies (the daemon decides; this keeps dead buttons off). */
export function isCancellableRun(status: RoutineRunStatus): boolean {
  return status === "queued" || status === "checking" || status === "running";
}

export function isLiveRun(status: RoutineRunStatus): boolean {
  return isCancellableRun(status) || status === "needs_attention";
}

export const RUN_TRIGGER: Record<RoutineRunWire["trigger"], string> = {
  schedule: "on schedule",
  catchup: "catch-up after downtime",
  api: "by its API",
  manual: "by hand",
};

/** A routine's state in one word, for its list badge. */
export function routineState(r: Pick<RoutineWire, "enabled" | "pausedReason">): { label: string; cls: string; title: string } {
  if (!r.enabled && r.pausedReason) {
    return { label: "auto-paused", cls: "border-danger/60 bg-danger/15 text-danger", title: r.pausedReason };
  }
  if (!r.enabled) return { label: "paused", cls: "border-border bg-bg/40 text-fg-muted", title: "Paused: it doesn't fire on its schedule or its API." };
  return { label: "active", cls: "border-success/50 bg-success/10 text-success", title: "Fires on its schedule and, if on, its API." };
}

// ── Schedules in words ───────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "1h30m" → "1 hour 30 minutes"; whole units pluralised. */
export function intervalWords(seconds: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.floor(seconds));
  for (const [unit, size] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ] as const) {
    if (rest >= size) {
      const n = Math.floor(rest / size);
      parts.push(`${n} ${unit}${n === 1 ? "" : "s"}`);
      rest %= size;
    }
  }
  return parts.join(" ") || "0 seconds";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isNum(s: string, max: number): boolean {
  return /^\d+$/.test(s) && Number(s) <= max;
}

/** The days a cron's weekday field names, in words, or null when it is something else. */
function weekdayWords(field: string): string | null {
  if (field === "*") return "every day";
  if (field === "1-5") return "weekdays";
  if (field === "0,6" || field === "6,0") return "weekends";
  const days = field.split(",");
  if (days.every((d) => isNum(d, 7))) {
    const names = days.map((d) => DAY_NAMES[Number(d) % 7]!);
    return `every ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}`;
  }
  return null;
}

/**
 * A 5-field cron in words for the shapes people actually write; anything else
 * comes back as the expression itself (never a guess).
 */
export function cronWords(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `cron ${expr.trim()}`;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const raw = `cron ${f.join(" ")}`;
  if (mon !== "*") return raw;
  // */N minutes, every day.
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && hour === "*" && dom === "*" && dow === "*") return `every ${intervalWords(Number(stepMin[1]) * 60)}`;
  if (min === "*" && hour === "*" && dom === "*" && dow === "*") return "every minute";
  if (isNum(min, 59) && hour === "*" && dom === "*" && dow === "*") return `every hour at :${pad2(Number(min))}`;
  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (isNum(min, 59) && stepHour && dom === "*" && dow === "*") {
    return `every ${intervalWords(Number(stepHour[1]) * 3600)} at :${pad2(Number(min))}`;
  }
  if (!isNum(min, 59)) return raw;
  const hours = hour.split(",");
  if (!hours.every((h) => isNum(h, 23))) return raw;
  const at = hours.map((h) => `${pad2(Number(h))}:${pad2(Number(min))}`).join(", ");
  if (dom === "*") {
    const days = weekdayWords(dow);
    return days ? `${days} at ${at}` : raw;
  }
  if (isNum(dom, 31) && dow === "*") return `on day ${Number(dom)} of every month at ${at}`;
  return raw;
}

/** A schedule in words: "weekdays at 09:00 (Europe/London)", "every 15 minutes", "once, …", "on demand only". */
export function scheduleWords(s: RoutineScheduleWire | undefined): string {
  if (!s) return "on demand only";
  switch (s.kind) {
    case "cron":
      return `${cronWords(s.expr)}${s.timezone ? ` (${s.timezone})` : ""}`;
    case "every":
      return `every ${intervalWords(s.seconds)}`;
    case "once":
      return `once, ${absoluteTime(s.at) || s.at}`;
  }
}

/**
 * Parse a human interval as the CLI does (`90s`, `15m`, `2h`, `1d`, `1h30m`,
 * or bare seconds). Mirrors the daemon's `parseInterval`; the daemon still
 * judges the minimum.
 */
export function parseEvery(text: string): number | { error: string } {
  const s = text.trim().toLowerCase();
  if (!s) return { error: "Give an interval, e.g. 15m or 1h30m" };
  if (/^\d+$/.test(s)) return Number(s) > 0 ? Number(s) : { error: "The interval can't be zero" };
  if (!/^(\s*\d+\s*[dhms])+$/.test(s)) return { error: `"${text.trim()}" is not an interval — use e.g. 90s, 15m, 2h, 1d or 1h30m` };
  const size = { d: 86_400, h: 3_600, m: 60, s: 1 } as const;
  let total = 0;
  for (const m of s.matchAll(/(\d+)\s*([dhms])/g)) total += Number(m[1]) * size[m[2] as keyof typeof size];
  return total > 0 ? total : { error: "The interval can't be zero" };
}

/** Seconds back to the CLI's compact form ("1h30m"), for prefilling. */
export function compactInterval(seconds: number): string {
  const parts: string[] = [];
  let rest = seconds;
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.join("") || "0s";
}

/** A `datetime-local` value ("2026-10-27T09:00") as an ISO instant with an explicit zone, or null. */
export function localToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value.trim())) return null;
  const t = new Date(value.trim());
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** An ISO instant as a `datetime-local` value in this browser's zone. */
export function isoToLocal(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}T${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

// ── Loop routines (docs/routines.md "Routines that start a loop") ───────────
//
// A routine's action can be a verified loop run instead of a session: the
// prompt becomes the loop's objective, `--check` stays the gate (is there
// work?), and the loop's own checks are its acceptance (is the work done?).

/** The loop's own defaults (LOOP_DEFAULTS), shown as placeholders. */
export const ROUTINE_LOOP_DEFAULTS = { toolBudget: 60, attempts: 3, attemptMinutes: 10, runMinutes: 30, checkTimeoutSec: 600 } as const;
export const ROUTINE_LOOP_CHECKS_MAX = 10;
export const LOOP_OBJECTIVE_MAX = 8_000;
/** The daemon's PLACEHOLDER_RE: a loop's objective is fixed text, so these aren't expanded and are refused. */
const LOOP_PLACEHOLDER_RE = /\{\{\s*(check|payload|last_summary|trigger|now|routine)\s*\}\}/;

/** The routine's loop contract, when it starts a loop. */
export function routineLoopOf(r: Pick<RoutineWire, "spec">): RoutineLoopSpecWire | null {
  return r.spec.loop ?? null;
}

/** The loop run a routine run started, and its status (live while running). */
export function routineRunLoop(run: RoutineRunWire): { runId: string; status: LoopStatusWire } | null {
  return run.loop ?? null;
}

/**
 * Why a session setting can't be used on a loop routine, in the daemon's
 * words (src/daemon/routines/service.ts #normalizeLoop) — shown next to the
 * field instead of waiting for the refusal.
 */
export const LOOP_ROUTINE_REFUSES = {
  approvals: "A loop's worker runs autonomously within its tool budget, so a loop routine can't be guarded.",
  session: "A loop has its own worker session, so a loop routine can't be persistent.",
  worktree: "A loop always works in its own worktree.",
  maxCostUsd: "A loop has no per-run spend ceiling: use the spend per day, or the loop's attempt and time limits.",
  overlap: "A loop routine never queues behind its last loop run: a fire while it is still going is skipped.",
  sessionLimits: "Tool calls, minutes per run and sessions kept shape a session run; a loop is bounded by its own limits above.",
  provider: "Loops run on the Claude backend for now.",
} as const;

// ── Form ─────────────────────────────────────────────────────────────────────

/** The daemon's defaults (SPEC_DEFAULTS), shown as placeholders. */
export const ROUTINE_DEFAULTS = {
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
  checkTimeoutSeconds: 60,
} as const;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ScheduleKind = "none" | "cron" | "every" | "once";

/** The loop action's fields: the acceptance checks and the loop's limits (blank = its defaults). */
export interface RoutineLoopForm {
  checks: LoopCheckRow[];
  toolBudget: string;
  attempts: string;
  attemptMinutes: string;
  runMinutes: string;
}

export function emptyLoopFields(): RoutineLoopForm {
  return { checks: [emptyCheckRow()], toolBudget: "", attempts: "", attemptMinutes: "", runMinutes: "" };
}

export interface RoutineForm {
  name: string;
  prompt: string;
  workdir: string;
  scheduleKind: ScheduleKind;
  cronExpr: string;
  /** Blank = the daemon's zone (on edit, the routine's current one). */
  cronTz: string;
  every: string;
  /** `datetime-local` value. */
  onceAt: string;
  checkCommand: string;
  checkTimeout: string;
  approvals: "autonomous" | "guarded";
  toolBudget: string;
  maxMinutes: string;
  maxCostUsd: string;
  dailyCostUsd: string;
  session: "fresh" | "persistent";
  worktree: boolean;
  overlap: "skip" | "queue";
  catchUp: boolean;
  jitterSeconds: string;
  notify: "on_change" | "always" | "never";
  keepSessions: string;
  api: boolean;
  failurePauseAfter: string;
  provider: string;
  model: string;
  /** What a fire does: prompt an agent session, or start a verified loop run. */
  action: "session" | "loop";
  loop: RoutineLoopForm;
}

export function emptyRoutineForm(): RoutineForm {
  return {
    name: "",
    prompt: "",
    workdir: "",
    scheduleKind: "every",
    cronExpr: "0 9 * * 1-5",
    cronTz: "",
    every: "1h",
    onceAt: "",
    checkCommand: "",
    checkTimeout: "",
    approvals: "guarded",
    toolBudget: "",
    maxMinutes: "",
    maxCostUsd: "",
    dailyCostUsd: "",
    session: "fresh",
    worktree: false,
    overlap: "skip",
    catchUp: false,
    jitterSeconds: "",
    notify: "on_change",
    keepSessions: "",
    api: false,
    failurePauseAfter: "",
    provider: "",
    model: "",
    action: "session",
    loop: emptyLoopFields(),
  };
}

/** A saved routine as the form shows it for editing. */
export function formFromRoutine(r: RoutineWire): RoutineForm {
  const s = r.spec;
  const sched = s.schedule;
  const loop = routineLoopOf(r);
  return {
    ...emptyRoutineForm(),
    name: s.name,
    prompt: s.prompt,
    workdir: s.workdir,
    scheduleKind: sched ? (sched.kind === "once" ? "once" : sched.kind) : "none",
    cronExpr: sched?.kind === "cron" ? sched.expr : "0 9 * * 1-5",
    cronTz: sched?.kind === "cron" ? (sched.timezone ?? "") : "",
    every: sched?.kind === "every" ? compactInterval(sched.seconds) : "1h",
    onceAt: sched?.kind === "once" ? isoToLocal(sched.at) : "",
    checkCommand: s.check?.command ?? "",
    checkTimeout: s.check?.timeoutSeconds !== undefined ? String(s.check.timeoutSeconds) : "",
    approvals: s.approvals,
    toolBudget: String(s.toolBudget),
    maxMinutes: String(s.maxMinutes),
    maxCostUsd: s.maxCostUsd !== undefined ? String(s.maxCostUsd) : "",
    dailyCostUsd: s.dailyCostUsd !== undefined ? String(s.dailyCostUsd) : "",
    session: s.session,
    worktree: s.worktree,
    overlap: s.overlap,
    catchUp: s.catchUp,
    jitterSeconds: String(s.jitterSeconds),
    notify: s.notify,
    keepSessions: String(s.keepSessions),
    api: s.api,
    failurePauseAfter: String(s.failurePauseAfter),
    provider: s.provider ?? "",
    model: s.model ?? "",
    action: loop ? "loop" : "session",
    loop: loop
      ? {
          checks: loop.checks.map((c) => ({
            id: c.id,
            command: c.command,
            timeoutSec: String(c.timeoutSec),
            expectTests: !!c.expectTests,
          })),
          toolBudget: String(loop.toolBudget),
          attempts: String(loop.limits.attempts),
          attemptMinutes: String(loop.limits.attemptMinutes),
          runMinutes: String(loop.limits.runMinutes),
        }
      : emptyLoopFields(),
  };
}

export type FormError = { error: string; field: string };

/** The form's schedule, or why it isn't one. Null = on demand only. */
export function scheduleFromForm(form: Pick<RoutineForm, "scheduleKind" | "cronExpr" | "cronTz" | "every" | "onceAt">):
  | { schedule: RoutineScheduleWire | null }
  | FormError {
  switch (form.scheduleKind) {
    case "none":
      return { schedule: null };
    case "cron": {
      const expr = form.cronExpr.trim().replace(/\s+/g, " ");
      if (!expr) return { error: "Give a cron expression, e.g. 0 9 * * 1-5", field: "cron" };
      const n = expr.split(" ").length;
      if (n !== 5) return { error: `A cron has 5 fields (minute hour day month weekday); this has ${n}`, field: "cron" };
      const tz = form.cronTz.trim();
      return { schedule: { kind: "cron", expr, ...(tz ? { timezone: tz } : {}) } };
    }
    case "every": {
      const s = parseEvery(form.every);
      if (typeof s === "object") return { error: s.error, field: "every" };
      return { schedule: { kind: "every", seconds: s } };
    }
    case "once": {
      const at = localToIso(form.onceAt);
      if (!at) return { error: "Pick the date and time it should run", field: "once" };
      return { schedule: { kind: "once", at } };
    }
  }
}

/** The loop contract the form sets (only what was given; the daemon fills defaults), or what is wrong. */
export function loopFromForm(loop: RoutineLoopForm): { loop: RoutineLoopWire } | FormError {
  const rows = loop.checks.filter((c) => c.command.trim() || c.id.trim() || c.timeoutSec.trim());
  if (rows.length === 0) return { error: "Add at least one acceptance check: the command that must pass for the loop to be done", field: "loop" };
  if (rows.length > ROUTINE_LOOP_CHECKS_MAX) return { error: `At most ${ROUTINE_LOOP_CHECKS_MAX} acceptance checks`, field: "loop" };
  const checks: RoutineLoopWire["checks"] = [];
  for (const [i, c] of rows.entries()) {
    const command = c.command.trim();
    if (!command) return { error: `Acceptance check ${i + 1} has no command`, field: "loop" };
    const timeout = optionalInt(c.timeoutSec, `Acceptance check ${i + 1}'s timeout`);
    if (typeof timeout === "object") return { ...timeout, field: "loop" };
    checks.push({
      ...(c.id.trim() ? { id: c.id.trim() } : {}),
      command,
      ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
      ...(c.expectTests ? { expectTests: true } : {}),
    });
  }
  const limits: Partial<Record<"attempts" | "attemptMinutes" | "runMinutes", number>> = {};
  for (const [key, label] of [
    ["attempts", "Attempts"],
    ["attemptMinutes", "Minutes per attempt"],
    ["runMinutes", "Minutes per loop run"],
  ] as const) {
    const v = optionalInt(loop[key], label);
    if (typeof v === "object") return { ...v, field: "loop" };
    if (v !== undefined) limits[key] = v;
  }
  const toolBudget = optionalInt(loop.toolBudget, "Tool calls per attempt");
  if (typeof toolBudget === "object") return { ...toolBudget, field: "loop" };
  return {
    loop: {
      checks,
      ...(toolBudget !== undefined ? { toolBudget } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    },
  };
}

/** A loop contract with every default filled, as the daemon saves it — so an edit compares like with like. */
export function normalizeLoop(loop: RoutineLoopWire): RoutineLoopSpecWire {
  return {
    checks: loop.checks.map((c, i) => ({
      id: c.id ?? `check${i + 1}`,
      command: c.command,
      timeoutSec: c.timeoutSec ?? ROUTINE_LOOP_DEFAULTS.checkTimeoutSec,
      ...(c.expectTests ? { expectTests: true } : {}),
    })),
    toolBudget: loop.toolBudget ?? ROUTINE_LOOP_DEFAULTS.toolBudget,
    limits: {
      attempts: loop.limits?.attempts ?? ROUTINE_LOOP_DEFAULTS.attempts,
      attemptMinutes: loop.limits?.attemptMinutes ?? ROUTINE_LOOP_DEFAULTS.attemptMinutes,
      runMinutes: loop.limits?.runMinutes ?? ROUTINE_LOOP_DEFAULTS.runMinutes,
    },
  };
}

function sameLoop(a: RoutineLoopSpecWire, b: RoutineLoopSpecWire): boolean {
  const norm = (l: RoutineLoopSpecWire) => ({
    checks: l.checks.map((c) => ({ id: c.id, command: c.command, timeoutSec: c.timeoutSec, expectTests: !!c.expectTests })),
    toolBudget: l.toolBudget,
    limits: { attempts: l.limits.attempts, attemptMinutes: l.limits.attemptMinutes, runMinutes: l.limits.runMinutes },
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Every field the form sets, as a full spec (create), or the first thing wrong. */
export function buildRoutineSpec(form: RoutineForm): { spec: RoutineSpecWire } | FormError {
  const name = form.name.trim();
  if (!name) return { error: "Name the routine", field: "name" };
  if (!NAME_RE.test(name)) {
    return { error: "A name is 1–64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit", field: "name" };
  }
  const workdir = form.workdir.trim();
  if (!workdir) return { error: "Choose the directory it works in", field: "workdir" };
  const prompt = form.prompt.trim();
  if (!prompt) return { error: "Say what the agent should do", field: "prompt" };
  if (prompt.length > 20_000) return { error: "The prompt is longer than 20,000 characters", field: "prompt" };
  const sched = scheduleFromForm(form);
  if ("error" in sched) return sched;
  const checkCommand = form.checkCommand.trim();
  const checkTimeout = optionalInt(form.checkTimeout, "The check's timeout");
  if (typeof checkTimeout === "object") return { ...checkTimeout, field: "check" };
  const ints: Partial<Record<"toolBudget" | "maxMinutes" | "jitterSeconds" | "keepSessions" | "failurePauseAfter", number>> = {};
  for (const [key, label, min] of [
    ["toolBudget", "Tool budget", 1],
    ["maxMinutes", "Minutes per run", 1],
    ["jitterSeconds", "Jitter", 0],
    ["keepSessions", "Sessions kept", 1],
    ["failurePauseAfter", "Failure pause", 0],
  ] as const) {
    const v = optionalInt(form[key], label, min);
    if (typeof v === "object") return { ...v, field: key };
    if (v !== undefined) ints[key] = v;
  }
  const money: Partial<Record<"maxCostUsd" | "dailyCostUsd", number>> = {};
  for (const [key, label] of [
    ["maxCostUsd", "Spend per run"],
    ["dailyCostUsd", "Spend per day"],
  ] as const) {
    const v = optionalUsd(form[key], label);
    if (typeof v === "object") return { ...v, field: key };
    if (v !== undefined) money[key] = v;
  }
  if (form.action === "loop") {
    // What the daemon refuses on a loop routine, said here first.
    if (prompt.length > LOOP_OBJECTIVE_MAX) {
      return { error: `A loop routine's prompt is the loop's objective: at most ${LOOP_OBJECTIVE_MAX.toLocaleString("en-US")} characters`, field: "prompt" };
    }
    if (LOOP_PLACEHOLDER_RE.test(prompt)) {
      return {
        error: "A loop's objective is fixed text, so {{…}} placeholders aren't expanded: the check's output and any payload reach the worker as data on their own",
        field: "prompt",
      };
    }
    if (money.maxCostUsd !== undefined) return { error: LOOP_ROUTINE_REFUSES.maxCostUsd, field: "maxCostUsd" };
    const provider = form.provider.trim();
    if (provider && provider !== "claude") return { error: LOOP_ROUTINE_REFUSES.provider, field: "provider" };
    const loop = loopFromForm(form.loop);
    if ("error" in loop) return loop;
    const spec: RoutineSpecWire = {
      name,
      prompt,
      workdir,
      ...(sched.schedule ? { schedule: sched.schedule } : {}),
      ...(checkCommand ? { check: { command: checkCommand, ...(checkTimeout !== undefined ? { timeoutSeconds: checkTimeout } : {}) } } : {}),
      // The settings a loop can't honour, set to what it can.
      approvals: "autonomous",
      session: "fresh",
      worktree: false,
      overlap: "skip",
      ...(ints.jitterSeconds !== undefined ? { jitterSeconds: ints.jitterSeconds } : {}),
      ...(ints.failurePauseAfter !== undefined ? { failurePauseAfter: ints.failurePauseAfter } : {}),
      ...(money.dailyCostUsd !== undefined ? { dailyCostUsd: money.dailyCostUsd } : {}),
      catchUp: form.catchUp,
      notify: form.notify,
      api: form.api,
      ...(provider ? { provider } : {}),
      ...(form.model.trim() ? { model: form.model.trim() } : {}),
      loop: loop.loop,
    };
    return { spec };
  }
  const spec: RoutineSpecWire = {
    name,
    prompt,
    workdir,
    ...(sched.schedule ? { schedule: sched.schedule } : {}),
    ...(checkCommand ? { check: { command: checkCommand, ...(checkTimeout !== undefined ? { timeoutSeconds: checkTimeout } : {}) } } : {}),
    approvals: form.approvals,
    ...ints,
    ...money,
    session: form.session,
    worktree: form.worktree,
    overlap: form.overlap,
    catchUp: form.catchUp,
    notify: form.notify,
    api: form.api,
    ...(form.provider.trim() ? { provider: form.provider.trim() } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
  };
  return { spec };
}

type RoutinePatch = NonNullable<RoutineUpdateMsg["spec"]>;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The `routine.update` spec for an edited form: only what changed, `null`
 * for an optional block cleared (schedule, check, spend limits, backend), and
 * a blanked defaulted field sent as its default (the daemon has no null for
 * those). `changed` names them, for the save button.
 */
export function buildRoutinePatch(current: RoutineWire, form: RoutineForm): { patch: RoutinePatch; changed: string[] } | FormError {
  const built = buildRoutineSpec(form);
  if ("error" in built) return built;
  const next = built.spec;
  const cur = current.spec;
  const patch: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    patch[k] = v;
  };
  for (const k of ["name", "prompt", "workdir", "approvals", "session", "worktree", "overlap", "catchUp", "notify", "api"] as const) {
    if (!sameJson(next[k], cur[k])) set(k, next[k]);
  }
  // A loop routine leaves the session-run limits as they are (they don't apply to it).
  const sessionOnly = next.loop ? ["toolBudget", "maxMinutes", "keepSessions"] : [];
  for (const k of ["toolBudget", "maxMinutes", "jitterSeconds", "keepSessions", "failurePauseAfter"] as const) {
    if (sessionOnly.includes(k)) continue;
    const v = next[k] ?? ROUTINE_DEFAULTS[k];
    if (v !== cur[k]) set(k, v);
  }
  // A cron saved without a zone keeps the routine's (the daemon fills it in),
  // so compare with the zone it would end up with. A `once` the form shows to
  // the minute is the saved instant while the field still reads the same:
  // the saved value, seconds and all, is what is compared (and kept).
  const sched = next.schedule;
  const unchangedOnce = sched?.kind === "once" && cur.schedule?.kind === "once" && form.onceAt === isoToLocal(cur.schedule.at);
  const effective = unchangedOnce
    ? cur.schedule
    : sched?.kind === "cron" && !sched.timezone && cur.schedule?.kind === "cron"
      ? { ...sched, timezone: cur.schedule.timezone }
      : sched;
  if (!sameJson(effective, cur.schedule)) set("schedule", sched ?? null);
  const curCheck = cur.check ? { command: cur.check.command, timeoutSeconds: cur.check.timeoutSeconds ?? ROUTINE_DEFAULTS.checkTimeoutSeconds } : null;
  const nextCheck = next.check
    ? { command: next.check.command, timeoutSeconds: next.check.timeoutSeconds ?? ROUTINE_DEFAULTS.checkTimeoutSeconds }
    : null;
  if (!sameJson(nextCheck, curCheck)) set("check", next.check ?? null);
  for (const k of ["maxCostUsd", "dailyCostUsd", "provider", "model"] as const) {
    if (!sameJson(next[k], cur[k])) set(k, next[k] ?? null);
  }
  // The loop is merged over the current one on the daemon; send it whole, with
  // its defaults, so a field blanked here returns to its default there.
  if (!next.loop) {
    if (cur.loop) set("loop", null);
  } else {
    const n = normalizeLoop(next.loop);
    if (!cur.loop || !sameLoop(n, cur.loop)) set("loop", n);
  }
  return { patch: patch as RoutinePatch, changed: Object.keys(patch) };
}

/** The form's warnings — not errors, but worth reading before saving (docs/routines.md "Safety model"). */
export function routineWarnings(form: RoutineForm): string[] {
  const out: string[] = [];
  if (form.action === "loop") {
    if (form.scheduleKind === "none" && !form.api) out.push("No schedule and no API trigger: it starts a loop only when you press Run now.");
    if (!form.checkCommand.trim()) {
      out.push("No gate: every fire starts a loop run, even when there is nothing to repair. A check that prints nothing when all is well keeps those fires free.");
    }
    return out;
  }
  if (form.approvals === "autonomous" && form.session === "persistent") {
    out.push(
      "Persistent and autonomous: anything said in its session between runs becomes context for the next autonomous run. Prefer a fresh session, or guarded approvals, where send-only tokens can reach it.",
    );
  }
  if (form.approvals === "autonomous" && !form.worktree) {
    out.push("Autonomous without its own worktree: the agent edits your checkout directly, within its tool budget.");
  }
  if (form.scheduleKind === "none" && !form.api) {
    out.push("No schedule and no API trigger: it runs only when you press Run now.");
  }
  return out;
}

/** Placeholders the prompt may use (docs/routines.md "The prompt"). */
export const PROMPT_PLACEHOLDERS: { token: string; meaning: string }[] = [
  { token: "{{check}}", meaning: "the check's output" },
  { token: "{{payload}}", meaning: "text sent with an API or manual fire" },
  { token: "{{last_summary}}", meaning: "what the previous successful run reported" },
  { token: "{{trigger}}", meaning: "schedule, catchup, api or manual" },
  { token: "{{now}}", meaning: "the run's start time" },
  { token: "{{routine}}", meaning: "the routine's name" },
];

/** A routine's spend and limits on one line. */
export function routineBudgetText(s: RoutineWire["spec"]): string {
  if (s.loop) {
    const l = s.loop;
    const parts = [
      `loop: ${l.limits.attempts} attempt${l.limits.attempts === 1 ? "" : "s"} of up to ${l.limits.attemptMinutes}m`,
      `${l.limits.runMinutes}m per loop run`,
      `${l.toolBudget} tool calls per attempt`,
    ];
    if (s.dailyCostUsd !== undefined) parts.push(`$${s.dailyCostUsd} per day`);
    return parts.join(" · ");
  }
  const parts = [
    s.approvals === "autonomous" ? `autonomous, ${s.toolBudget} tool calls` : "guarded: every edit or command waits for you",
    `${s.maxMinutes}m per run`,
  ];
  if (s.maxCostUsd !== undefined) parts.push(`$${s.maxCostUsd} per run`);
  if (s.dailyCostUsd !== undefined) parts.push(`$${s.dailyCostUsd} per day`);
  return parts.join(" · ");
}
