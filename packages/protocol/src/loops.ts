/**
 * Loops (docs/loop-engineering-design.md): a daemon-owned run that pursues an
 * objective through bounded attempts and accepts the result only on evidence
 * the daemon collected itself.
 *
 * Scopes (the same model as routines):
 *   - every loop message needs `session:create` + `session:send` — a loop
 *     creates and drives a worker session on its owner's behalf;
 *   - `loop.start` also needs `session:approve`: the worker runs autonomously
 *     within the run's tool budget, which pre-approves its tool use;
 *   - starting, steering, and resuming are refused to a delegated token; any
 *     credential that can see the run may pause or cancel it (a safety stop).
 *
 * A run is its owner's alone: another user in the same tenant sees no run of
 * theirs, by id or in a list.
 */

export interface LoopCheckWire {
  /** Stable id within the run (defaults to `check1`, `check2`, …). */
  id?: string;
  command: string;
  timeoutSec?: number;
  /** A test run: exiting 0 after selecting no tests does not pass. */
  expectTests?: boolean;
}

export interface LoopLimitsWire {
  attempts: number;
  attemptMinutes: number;
  runMinutes: number;
}

export type LoopStatusWire =
  | "running"
  | "verifying"
  | "waiting"
  | "paused"
  | "completed"
  | "budget_exhausted"
  | "blocked"
  | "failed"
  | "cancelled";

export type LoopAttemptResultWire =
  | "verified"
  | "unverified"
  | "cannot_satisfy"
  | "needs_input"
  | "timed_out"
  | "worker_failed"
  | "stopped";

export interface LoopRunWire {
  id: string;
  recipe: "repair";
  objective: string;
  workdir: string;
  checks: Required<Pick<LoopCheckWire, "id" | "command" | "timeoutSec">>[];
  limits: LoopLimitsWire;
  toolBudget: number;
  provider?: string;
  model?: string;
  status: LoopStatusWire;
  /** Why the run is in its status. */
  reason: string | null;
  /** What a `waiting` run waits on. */
  waitingOn: string | null;
  /** Whether that is an approval in the worker session (answered there) or
   *  the worker's question (answered with loop.steer). Also set while paused. */
  waitingKind: "approval" | "question" | null;
  baseRevision: string | null;
  branch: string | null;
  worktreePath: string | null;
  workerSessionId: string | null;
  acceptedAttemptId: string | null;
  /** Commit on `branch` holding the accepted result. */
  deliveredCommit: string | null;
  attempts: number;
  activeMs: number;
  costUsd: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface LoopAttemptWire {
  id: string;
  ordinal: number;
  status: "queued" | "running" | "verifying" | "done";
  result: LoopAttemptResultWire | null;
  note: string | null;
  report: { outcome: "ready_for_verification" | "cannot_satisfy" | "needs_input"; summary: string; detail?: string } | null;
  /** Git tree the checks judged. */
  candidateTree: string | null;
  /** Read each with `evidence.get`. */
  evidenceIds: string[];
  workerSessionId: string | null;
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number;
}

export interface LoopEventWire {
  seq: number;
  at: string;
  actor: string;
  type: string;
  detail: string;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface LoopStartMsg {
  type: "loop.start";
  id: string;
  objective: string;
  workdir: string;
  checks: LoopCheckWire[];
  provider?: string;
  model?: string;
  toolBudget?: number;
  limits?: Partial<LoopLimitsWire>;
}

export interface LoopListMsg {
  type: "loop.list";
  id: string;
  limit?: number;
}

export interface LoopGetMsg {
  type: "loop.get";
  id: string;
  runId: string;
  /** Include the run's event history. */
  events?: boolean;
}

/** Stop the run: its attempt is stopped and nothing more starts. */
export interface LoopCancelMsg {
  type: "loop.cancel";
  id: string;
  runId: string;
}

/** Stop at the next attempt boundary; a running attempt finishes first. */
export interface LoopPauseMsg {
  type: "loop.pause";
  id: string;
  runId: string;
}

export interface LoopResumeMsg {
  type: "loop.resume";
  id: string;
  runId: string;
}

export type LoopControlMsg = LoopCancelMsg | LoopPauseMsg | LoopResumeMsg;

export interface LoopSteerMsg {
  type: "loop.steer";
  id: string;
  runId: string;
  /** Guidance for the next attempt, or the answer to the worker's question. */
  text: string;
}

export interface LoopSnapshotMsg {
  type: "loop.snapshot";
  requestId: string;
  run: LoopRunWire;
  attempts: LoopAttemptWire[];
  events?: LoopEventWire[];
}

export interface LoopListResultMsg {
  type: "loop.list.result";
  requestId: string;
  runs: LoopRunWire[];
}
