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
  /** The commit a triggered run works from, instead of the owner's checkout. */
  baseRef?: { sha: string; branch?: string };
  /** What started the run, when a watch did ("started by"). */
  trigger?: LoopTriggerWire;
}

/** The repository event that started a run. `summary` is event text: data. */
export interface LoopTriggerWire {
  kind: "ci_failure" | "review_comment";
  key: string;
  watchId?: string;
  url?: string;
  summary: string;
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

// ── Watches ──────────────────────────────────────────────────────────────────
//
// A watch is an owner-defined, opt-in rule that starts ordinary repair runs
// from repository events: a failing CI check on a watched branch, or a review
// comment addressed to codeoid on the owner's pull request. Authorized like
// loop.start (session:create + session:send, plus session:approve for
// anything that can start runs); creating, changing, enabling, and polling
// are refused to a delegated token, while disabling and deleting are safety
// stops any credential that can see the watch may use. A watch is its
// owner's alone.

/** Which CI check names start a run, and the local command that reproduces each. */
export interface LoopWatchCiWire {
  /** The check run's name on GitHub, exact or a glob (`*`, `?`). */
  ciName: string;
  /** Slug of the GitHub App that must have reported it. Default `github-actions`. */
  app?: string;
  /** The local command the run must make pass. */
  command: string;
  timeoutSec?: number;
  expectTests?: boolean;
}

export interface LoopWatchSpecWire {
  /** The repository; its `origin` remote must be on github.com. */
  workdir: string;
  /** Watch these branches… */
  branches?: string[];
  /** …or the heads of your open pull requests. Exactly one of the two. */
  myPrs?: boolean;
  ci: LoopWatchCiWire[];
  review?: {
    enabled: boolean;
    /** GitHub logins whose comments count. Default: the gh-authenticated user. */
    allow?: string[];
    /** The token a comment must contain. Default `@codeoid`. */
    mention?: string;
  };
  /**
   * More GitHub logins whose commits a head may carry. A watch runs a head's
   * code only when every commit past the default branch was authored and
   * committed by you (gh's login) or one of these.
   */
  trust?: string[];
  provider?: string;
  model?: string;
  toolBudget?: number;
  limits?: Partial<LoopLimitsWire>;
  /** Runs this watch may start per hour. Default 6. */
  maxRunsPerHour?: number;
}

export interface LoopWatchWire {
  id: string;
  workdir: string;
  /** `owner/name`, from the workdir's origin when the watch was made. */
  repo: string;
  branches: string[];
  myPrs: boolean;
  ci: Array<{ ciName: string; app: string; command: string; timeoutSec: number; expectTests?: boolean }>;
  review: { enabled: boolean; allow: string[]; mention: string };
  /** The GitHub login the watch reads as (gh's, when it was made): always trusted. */
  ghLogin: string | null;
  /** More logins trusted to have written a head's commits. */
  trust: string[];
  provider?: string;
  model?: string;
  toolBudget?: number;
  limits?: Partial<LoopLimitsWire>;
  maxRunsPerHour: number;
  enabled: boolean;
  lastPolledAt: string | null;
  /** Why the last poll could not finish, or what it had to skip. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An event a watch acted on: a run it started, or one it ignored for good. */
export interface LoopWatchTriggerWire {
  key: string;
  kind: "ci_failure" | "review_comment";
  branch: string;
  runId: string | null;
  /** `retry`: its run's workspace couldn't be prepared; a later poll tries again. */
  outcome: "run" | "ignored" | "retry";
  note: string | null;
  createdAt: string;
}

export interface LoopWatchCreateMsg {
  type: "loop.watch.create";
  id: string;
  spec: LoopWatchSpecWire;
}

export interface LoopWatchListMsg {
  type: "loop.watch.list";
  id: string;
}

export interface LoopWatchGetMsg {
  type: "loop.watch.get";
  id: string;
  watchId: string;
}

/** Enable or disable, and/or change fields (the repository can't change). */
export interface LoopWatchUpdateMsg {
  type: "loop.watch.update";
  id: string;
  watchId: string;
  enabled?: boolean;
  spec?: Partial<Omit<LoopWatchSpecWire, "workdir">>;
}

export interface LoopWatchDeleteMsg {
  type: "loop.watch.delete";
  id: string;
  watchId: string;
}

/** Poll now instead of at the next tick. */
export interface LoopWatchPollMsg {
  type: "loop.watch.poll";
  id: string;
  watchId: string;
}

export interface LoopWatchSnapshotMsg {
  type: "loop.watch.snapshot";
  requestId: string;
  watch: LoopWatchWire;
  /** Recent events it acted on, newest first. */
  triggers?: LoopWatchTriggerWire[];
  /** After loop.watch.poll: the runs it started, and what it skipped. */
  poll?: { started: string[]; skipped: string[] };
}

export interface LoopWatchListResultMsg {
  type: "loop.watch.list.result";
  requestId: string;
  watches: LoopWatchWire[];
}
