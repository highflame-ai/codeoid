/**
 * Loop runs (docs/loops.md) — the words and colours for a run's status and an
 * attempt's result, and the start form's validation. Pure, so the decisions
 * are tested without a reactive root.
 */

import type { LoopAttemptResultWire, LoopRunWire, LoopStartMsg, LoopStatusWire } from "../protocol/types";

export interface LoopStatusStyle {
  mark: string;
  /** Short label for a badge. */
  label: string;
  cls: string;
  /** What the status means, in docs/loops.md's words. */
  meaning: string;
}

/**
 * The four ways a run ends short of `cancelled` read differently on purpose:
 * only `completed` was verified, `budget_exhausted` ran out trying, `blocked`
 * needs you, and `failed` broke outside the work.
 */
export const LOOP_STATUS: Record<LoopStatusWire, LoopStatusStyle> = {
  running: { mark: "▶", label: "running", cls: "border-accent/50 bg-accent/10 text-accent", meaning: "An attempt is running." },
  verifying: {
    mark: "⋯",
    label: "verifying",
    cls: "border-accent/50 bg-accent/10 text-accent",
    meaning: "The daemon is running the checks on the attempt's snapshot.",
  },
  waiting: { mark: "⏸", label: "waiting on you", cls: "border-warn/60 bg-warn/15 text-warn", meaning: "The run is waiting on you." },
  paused: {
    mark: "⏸",
    label: "paused",
    cls: "border-border bg-bg/40 text-fg-muted",
    meaning: "Paused: no new attempt starts until you resume. An attempt already running finishes and is checked first.",
  },
  completed: {
    mark: "✓",
    label: "verified",
    cls: "border-success/50 bg-success/10 text-success",
    meaning: "Every check passed on the delivered commit. Merge its branch like any branch.",
  },
  budget_exhausted: {
    mark: "✗",
    label: "out of budget",
    cls: "border-warn/50 bg-warn/10 text-warn",
    meaning:
      "The attempts or time ran out without every check passing. Nothing was delivered; the worktree holds the last attempt.",
  },
  blocked: {
    mark: "!",
    label: "blocked",
    cls: "border-danger/60 bg-danger/15 text-danger",
    meaning:
      "The run can't make progress without you: the checks already passed, two attempts left the same tree, or the worker reported that the objective conflicts with the checks.",
  },
  failed: {
    mark: "✗",
    label: "failed",
    cls: "border-danger/40 bg-danger/5 text-danger",
    meaning:
      "Something outside the work went wrong: the worktree couldn't be prepared, a check couldn't run on the unmodified code, or the result couldn't be committed.",
  },
  cancelled: { mark: "■", label: "cancelled", cls: "border-border bg-bg/40 text-fg-faint", meaning: "You stopped it." },
};

export const ATTEMPT_RESULT: Record<LoopAttemptResultWire, { label: string; cls: string }> = {
  verified: { label: "verified", cls: "text-success" },
  unverified: { label: "checks failed", cls: "text-danger" },
  cannot_satisfy: { label: "cannot satisfy", cls: "text-danger" },
  needs_input: { label: "asked you", cls: "text-warn" },
  timed_out: { label: "timed out", cls: "text-warn" },
  worker_failed: { label: "worker failed", cls: "text-danger" },
  stopped: { label: "stopped", cls: "text-fg-faint" },
};

const TERMINAL: readonly LoopStatusWire[] = ["completed", "budget_exhausted", "blocked", "failed", "cancelled"];

export function isTerminalLoop(status: LoopStatusWire): boolean {
  return TERMINAL.includes(status);
}

/**
 * The `waitingOn` a run carries while an approval in its worker session waits
 * (src/daemon/loops/service.ts). The wire has no separate kind, so this is the
 * one string that tells an approval wait from the worker's question.
 */
export const LOOP_APPROVAL_WAIT = "an approval in the worker session";

/** What a `waiting` run waits on, or null for any other status. The daemon
 *  says (`waitingKind`); older daemons only give the text. */
export function loopWaitKind(
  run: Pick<LoopRunWire, "status" | "waitingOn"> & Partial<Pick<LoopRunWire, "waitingKind">>,
): "approval" | "question" | null {
  if (run.status !== "waiting") return null;
  if (run.waitingKind) return run.waitingKind;
  return run.waitingOn === LOOP_APPROVAL_WAIT ? "approval" : "question";
}

/** The question itself, without the daemon's "the owner's answer: " lead-in. */
export function loopQuestion(waitingOn: string | null): string {
  return (waitingOn ?? "").replace(/^the owner's answer:\s*/, "");
}

/** The objective's first line, for a row. */
export function objectiveTitle(objective: string, max = 80): string {
  const line = objective.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Which controls a run in `status` accepts (the daemon decides; this keeps dead buttons off). */
export function loopActions(status: LoopStatusWire): { pause: boolean; resume: boolean; cancel: boolean; steer: boolean } {
  const live = !isTerminalLoop(status);
  return {
    pause: status === "running" || status === "verifying" || status === "waiting",
    resume: status === "paused",
    cancel: live,
    steer: live,
  };
}

// ── Start form ───────────────────────────────────────────────────────────────

/** The daemon's defaults (LOOP_DEFAULTS), shown as placeholders. */
export const LOOP_FORM_DEFAULTS = { attempts: 3, attemptMinutes: 10, runMinutes: 30, toolBudget: 60 } as const;

export interface LoopCheckRow {
  id: string;
  command: string;
  /** Seconds; blank = the daemon's default. */
  timeoutSec: string;
  expectTests: boolean;
}

export interface LoopStartForm {
  objective: string;
  workdir: string;
  checks: LoopCheckRow[];
  /** Blank = the daemon's default. */
  attempts: string;
  attemptMinutes: string;
  runMinutes: string;
  toolBudget: string;
  provider: string;
  model: string;
}

export function emptyCheckRow(): LoopCheckRow {
  return { id: "", command: "", timeoutSec: "", expectTests: false };
}

export function emptyLoopForm(): LoopStartForm {
  return {
    objective: "",
    workdir: "",
    checks: [emptyCheckRow()],
    attempts: "",
    attemptMinutes: "",
    runMinutes: "",
    toolBudget: "",
    provider: "",
    model: "",
  };
}

/** A blank optional number, a positive integer, or the reason it is neither. */
function positiveInt(raw: string, name: string): number | undefined | { error: string } {
  const v = raw.trim();
  if (!v) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1) return { error: `${name} must be a whole number of at least 1` };
  return Number(v);
}

/**
 * The `loop.start` body for a filled form (without the request id), or the
 * first thing wrong with it. Only what the form can know is checked here —
 * ranges and backends are the daemon's to judge, and its words are shown.
 */
export function buildLoopStart(form: LoopStartForm): { msg: Omit<LoopStartMsg, "id"> } | { error: string } {
  const objective = form.objective.trim();
  if (!objective) return { error: "Describe the objective" };
  const workdir = form.workdir.trim();
  if (!workdir) return { error: "Choose the repository to work in" };
  const rows = form.checks.filter((c) => c.command.trim() || c.id.trim() || c.timeoutSec.trim());
  if (rows.length === 0) return { error: "Add at least one check: the command that must pass" };
  const checks: LoopStartMsg["checks"] = [];
  for (const [i, c] of rows.entries()) {
    const command = c.command.trim();
    if (!command) return { error: `Check ${i + 1} has no command` };
    const timeout = positiveInt(c.timeoutSec, `Check ${i + 1}'s timeout`);
    if (typeof timeout === "object") return timeout;
    checks.push({
      ...(c.id.trim() ? { id: c.id.trim() } : {}),
      command,
      ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
      ...(c.expectTests ? { expectTests: true } : {}),
    });
  }
  const limits: Partial<Record<"attempts" | "attemptMinutes" | "runMinutes", number>> = {};
  for (const [key, name] of [
    ["attempts", "Attempts"],
    ["attemptMinutes", "Minutes per attempt"],
    ["runMinutes", "Minutes per run"],
  ] as const) {
    const v = positiveInt(form[key], name);
    if (typeof v === "object") return v;
    if (v !== undefined) limits[key] = v;
  }
  const toolBudget = positiveInt(form.toolBudget, "Tool budget");
  if (typeof toolBudget === "object") return toolBudget;
  return {
    msg: {
      type: "loop.start",
      objective,
      workdir,
      checks,
      ...(form.provider.trim() ? { provider: form.provider.trim() } : {}),
      ...(form.model.trim() ? { model: form.model.trim() } : {}),
      ...(toolBudget !== undefined ? { toolBudget } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    },
  };
}
