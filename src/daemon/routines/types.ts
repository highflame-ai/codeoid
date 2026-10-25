/**
 * Routine model (docs/routines.md). A routine is a saved, owned, scheduled or
 * triggered agent job: a prompt + a workdir + a backend, plus the policy that
 * makes running it unattended safe — a pre-run check, budgets, an approval
 * posture, and a delivery rule.
 */

import type { RoutineSchedule } from "./schedule.js";

export type ApprovalPosture = "autonomous" | "guarded";
export type SessionStrategy = "fresh" | "persistent";
export type OverlapPolicy = "skip" | "queue";
export type NotifyPolicy = "on_change" | "always" | "never";

/** Everything the owner configures. Stored as JSON; validated on every write. */
export interface RoutineSpec {
  name: string;
  /** The prompt. May reference {{check}}, {{payload}}, {{last_summary}}, {{trigger}}, {{now}}, {{routine}}. */
  prompt: string;
  workdir: string;
  provider?: string;
  model?: string;
  /** Absent = runs only when triggered (API or manual). */
  schedule?: RoutineSchedule;
  /**
   * Pre-run gate. Runs in the workdir before any agent starts:
   * exit 0 + output → the agent runs with the output as context;
   * exit 0 + no output → nothing to do, the run is `silent` and costs nothing;
   * any other exit → the run fails without starting an agent.
   */
  check?: { command: string; timeoutSeconds: number };
  /** `autonomous`: tools auto-approve within `toolBudget`. `guarded`: every non-read tool waits for the owner. */
  approvals: ApprovalPosture;
  toolBudget: number;
  /** Wall-clock limit per run; the run is interrupted at the deadline. */
  maxMinutes: number;
  /** Per-run spend ceiling (USD). A hard stop on Claude for fresh sessions (the SDK's maxBudgetUsd); everywhere, the daemon checks the spend the session reports while the run waits. */
  maxCostUsd?: number;
  /** Per-routine spend ceiling per UTC day (USD). Further fires that day are skipped. */
  dailyCostUsd?: number;
  session: SessionStrategy;
  /** Run in a fresh git worktree (fresh sessions) so the run never touches the checkout you work in. */
  worktree: boolean;
  overlap: OverlapPolicy;
  /** After downtime that missed a scheduled fire, run once on recovery. */
  catchUp: boolean;
  /** Spread the fire by up to this many seconds (stable per routine). */
  jitterSeconds: number;
  notify: NotifyPolicy;
  /** Run sessions kept per routine; older ones are destroyed (their run records stay). */
  keepSessions: number;
  /** Accept fires on this routine's API endpoint. */
  api: boolean;
  /** Pause the routine after this many consecutive failed runs (0 = never). */
  failurePauseAfter: number;
}

export type RunTrigger = "schedule" | "catchup" | "api" | "manual";

export type RunStatus =
  | "queued"
  | "checking"
  | "running"
  /** The agent finished and has something to report. */
  | "succeeded"
  /** Nothing to report: the check found nothing, or the agent answered [SILENT]. */
  | "silent"
  /** Parked on a tool approval only the owner can give (including one an exhausted tool budget raised). */
  | "needs_attention"
  | "failed"
  | "timed_out"
  | "over_budget"
  /** Not run: overlapping run, daily spend cap, or the routine was paused. */
  | "skipped"
  | "cancelled"
  /** The daemon stopped while the run was in flight. */
  | "interrupted";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "silent",
  "needs_attention",
  "failed",
  "timed_out",
  "over_budget",
  "skipped",
  "cancelled",
  "interrupted",
];

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "checking", "running"];

/** Runs that count toward the failure auto-pause. */
export const FAILURE_RUN_STATUSES: readonly RunStatus[] = ["failed", "timed_out", "over_budget"];

export interface RoutineRow {
  id: string;
  accountId: string;
  projectId: string;
  ownerSub: string;
  spec: RoutineSpec;
  enabled: boolean;
  /** Why it was paused automatically (failures), when it was. */
  pausedReason: string | null;
  /** Next scheduled fire (ms since epoch); null = not scheduled. */
  nextFireAt: number | null;
  /** Phase anchor for `every` schedules (ms). */
  anchorAt: number;
  lastRunAt: number | null;
  consecutiveFailures: number;
  /** The session reused by `persistent` routines. */
  persistentSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunRow {
  id: string;
  routineId: string;
  accountId: string;
  projectId: string;
  trigger: RunTrigger;
  status: RunStatus;
  /** Scheduled instant the run was for (ms), when scheduled. */
  scheduledFor: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  sessionId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** The agent's final message, bounded. */
  summary: string | null;
  /** Why it ended the way it did — an error, a skip reason, what it waits on. */
  reason: string | null;
  checkOutput: string | null;
  payload: string | null;
}
