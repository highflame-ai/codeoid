/**
 * Loops (docs/loop-engineering-design.md): a daemon-owned run that pursues an
 * objective through bounded attempts and accepts the result only on evidence.
 *
 * This file holds the durable shapes. The contract is fixed when a run starts;
 * everything a run decides afterwards is checked against it.
 */

/** A check the run's acceptance depends on (§4 `checks.visible`). */
export interface LoopCheck {
  /** Stable id within the run, e.g. `test`. */
  id: string;
  /** Shell command, run in the candidate's directory. */
  command: string;
  timeoutSec: number;
  /** A test run: exiting 0 after selecting no tests does not pass. */
  expectTests?: boolean;
}

export interface LoopLimits {
  /** Worker attempts, including the first. */
  attempts: number;
  /** Wall time one attempt may run before it is stopped. */
  attemptMinutes: number;
  /** Active execution time across the whole run (attempts plus checks). */
  runMinutes: number;
}

/**
 * What started a run (§4 "two entry points"), when a watch or a routine
 * started it rather than a person. `summary` is event text — a check's
 * output, a comment's body, a routine's gate output or payload — and only
 * ever reaches a worker as data.
 */
export interface LoopTrigger {
  kind: "ci_failure" | "review_comment" | "routine";
  /** Dedupe key of the event, e.g. `ci:acme/shop:<sha>:<checkRunId>:1`, or
   *  `routine:<routineId>:<routineRunId>`. */
  key: string;
  /** The watch that saw it. */
  watchId?: string;
  /** The routine that fired, and its run that started this one. */
  routineId?: string;
  routineName?: string;
  routineRunId?: string;
  /** Where the event is on GitHub (the check run, the comment). */
  url?: string;
  summary: string;
}

/**
 * Base the run's worktree on this commit instead of the user's checkout: a
 * triggered run repairs the branch the event happened on.
 */
export interface LoopBaseRef {
  /** Full commit id. */
  sha: string;
  /** The branch it is the head of, for display. */
  branch?: string;
  /** The github.com repository (`owner/name`) to fetch it from when it isn't local. */
  repo?: string;
  /** What to fetch when the commit isn't local, e.g. `refs/pull/12/head`. */
  fetchRef?: string;
  /** A watch checked that someone the owner trusts pushed this head (or
   *  signed every commit past the default branch, verified by GitHub). Only
   *  then does the setup recipe copy the owner's files next to a commit that
   *  isn't on their checkout's history. */
  trusted?: boolean;
}

/** The run's rules, fixed at start (§4). */
export interface LoopContract {
  /** The only recipe so far: reproduce a failing check, repair, verify. */
  recipe: "repair";
  objective: string;
  /** The user's repository; the run works in its own worktree of it. */
  workdir: string;
  checks: LoopCheck[];
  worker: { provider?: string; model?: string };
  /** Autonomous tool calls per attempt. Past it the attempt ends; the run decides what's next. */
  toolBudget: number;
  limits: LoopLimits;
  /** Work from this commit, not the user's checkout (set by watches only). */
  baseRef?: LoopBaseRef;
  /** What started the run (set by watches and routines only). */
  trigger?: LoopTrigger;
}

/**
 * Lifecycle (§6). `verifying` is the daemon running checks; `waiting` names
 * what it waits on; the last five are terminal.
 */
export type LoopStatus =
  | "running"
  | "verifying"
  | "waiting"
  | "paused"
  | "completed"
  | "budget_exhausted"
  | "blocked"
  | "failed"
  | "cancelled";

export const TERMINAL_LOOP_STATUSES: readonly LoopStatus[] = [
  "completed",
  "budget_exhausted",
  "blocked",
  "failed",
  "cancelled",
];

export function isTerminalLoopStatus(s: LoopStatus): boolean {
  return TERMINAL_LOOP_STATUSES.includes(s);
}

/**
 * How a worker ended an attempt (§5), reported through the loop_report tool.
 * A report is a request for verification, never a verdict.
 */
export type WorkerOutcome = "ready_for_verification" | "cannot_satisfy" | "needs_input";

export interface WorkerReport {
  outcome: WorkerOutcome;
  /** What the worker did or concluded, in its words. */
  summary: string;
  /** cannot_satisfy: the conflict. needs_input: the question. */
  detail?: string;
  at: number;
}

export type AttemptStatus = "queued" | "running" | "verifying" | "done";

/** How an attempt ended, from the run's point of view. */
export type AttemptResult =
  /** Every check passed on this attempt's candidate. */
  | "verified"
  /** At least one check did not pass. */
  | "unverified"
  /** The worker reported a conflict with the objective or its checks. */
  | "cannot_satisfy"
  /** The worker needs a decision from the user. */
  | "needs_input"
  /** The attempt hit its time limit. */
  | "timed_out"
  /** The worker's session failed, or its claim was lost. */
  | "worker_failed"
  /** The run was cancelled or paused while it ran. */
  | "stopped";

export interface LoopAttemptRow {
  id: string;
  runId: string;
  /** 1-based. */
  ordinal: number;
  status: AttemptStatus;
  result: AttemptResult | null;
  dispatchTaskId: string | null;
  workerSessionId: string | null;
  provider: string | null;
  model: string | null;
  report: WorkerReport | null;
  /** Tree of the workspace when the attempt ended — the candidate its checks judged. */
  candidateTree: string | null;
  evidenceIds: string[];
  /** One line on why the attempt ended as it did. */
  note: string | null;
  startedAt: number | null;
  endedAt: number | null;
  costUsd: number;
  /** The prompt the attempt was queued with — re-queued when a pause stopped it before it started. */
  prompt: string | null;
  /** The worker session's cumulative cost when the attempt started. */
  costAtStart: number;
  /** Time the attempt spent waiting on an approval (its clock stops then). */
  heldMs: number;
  /** When the current approval wait began, while one is open. */
  heldSince: number | null;
}

export interface LoopRunRow {
  id: string;
  accountId: string;
  projectId: string;
  ownerSub: string;
  ownerName: string | null;
  contract: LoopContract;
  status: LoopStatus;
  /** Why the run is in its status — the line a person reads first. */
  reason: string | null;
  /** What a `waiting` run waits on. */
  waitingOn: string | null;
  /** Commit the run's worktree was made from. */
  baseRevision: string | null;
  /** The run's own worktree and branch. `worktreePath` is where the run
   *  works (the user's workdir inside the worktree); `worktreeRoot` the
   *  worktree's top. */
  worktreePath: string | null;
  worktreeRoot: string | null;
  /** The worktree's git directories, recorded before the worker could touch
   *  them: every git command the daemon runs for the run is pinned to these,
   *  so nothing the worker writes (a `.git` file, `core.worktree`) can aim it
   *  at another tree. */
  gitDir: string | null;
  commonDir: string | null;
  branch: string | null;
  /** The worker session, kept across attempts for continuity. */
  workerSessionId: string | null;
  /** Latest attempt whose candidate passed every check. */
  acceptedAttemptId: string | null;
  /** Commit holding the accepted candidate on the run's branch. */
  deliveredCommit: string | null;
  /** Steering from the user, applied at the next attempt boundary. */
  pendingSteer: string[];
  /** Paths the setup recipe copied or linked into the worktree; never committed. */
  setupPaths: string[];
  /** Tree of the unmodified workspace (the baseline's candidate). */
  baseTree: string | null;
  /** Time spent running checks (baseline and verification), for `limits.runMinutes`. */
  checkMs: number;
  /** Compare-and-set guard: every transition bumps it. */
  stateVersion: number;
  /** Active execution so far (attempts and checks), for `limits.runMinutes`. */
  activeMs: number;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

/** One entry in a run's append-only history. */
export interface LoopEventRow {
  seq: number;
  runId: string;
  at: number;
  actor: string;
  type: string;
  detail: string;
}

/** What a run waits on while its worker waits for an approval. */
export const APPROVAL_WAIT = "an approval in the worker session";
/** Prefix of what a run waits on while the worker's question is open. */
export const QUESTION_WAIT_PREFIX = "the owner's answer: ";

export const LOOP_DEFAULTS = {
  toolBudget: 60,
  limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 },
  checkTimeoutSec: 600,
} as const;

export const LOOP_LIMITS = {
  OBJECTIVE_MAX: 8_000,
  CHECKS_MAX: 10,
  CHECK_COMMAND_MAX: 4_000,
  CHECK_TIMEOUT_MAX_S: 3_600,
  ATTEMPTS_MAX: 10,
  ATTEMPT_MINUTES_MAX: 240,
  RUN_MINUTES_MAX: 24 * 60,
  TOOL_BUDGET_MAX: 1_000,
  STEER_MAX: 8_000,
  /** Steering queued for one attempt boundary. */
  STEER_PENDING_MAX: 10,
  STEER_PENDING_CHARS_MAX: 32_000,
  /** Runs one owner may have in progress at once. */
  ACTIVE_RUNS_PER_OWNER: 3,
  REPORT_SUMMARY_MAX: 4_000,
  REPORT_DETAIL_MAX: 4_000,
  /** Event text a trigger carries into a run. */
  TRIGGER_SUMMARY_MAX: 4_000,
} as const;

/**
 * The run's workspace can't be prepared for a reason trying again won't
 * change (a shallow clone can't take a fetched head): a watch drops the event
 * at once instead of retrying it.
 */
export class LoopWorkspaceUnsupportedError extends Error {}

/** The run event that marks a run whose workspace can't be prepared at all. */
export const WORKSPACE_UNSUPPORTED_EVENT = "workspace.unsupported";
