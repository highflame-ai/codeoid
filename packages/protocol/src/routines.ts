/**
 * Routines (docs/routines.md): saved agent jobs that run on a schedule, on an
 * API call, or on demand — unattended, inside budgets the owner sets.
 *
 * Scopes:
 *   - `routine.preview` (no routine involved): `session:list`;
 *   - reading routines and runs (`routine.list`, `routine.get`, `routine.runs`):
 *     `routine:manage` — prompts, check commands, check output and payloads
 *     are not for read-only share tokens;
 *   - changing anything (create, update, delete, run, cancel, token): `routine:manage`,
 *     plus `session:create` and `session:send` — a routine creates and prompts
 *     sessions on its owner's behalf, so it can never grant more than they hold.
 *     An autonomous routine, or one with a check command, also needs
 *     `session:approve`: it pre-approves tool use and host commands. A
 *     delegated token (an agent acting for someone) cannot change routines:
 *     a routine is standing authority, and delegation is meant to be narrow.
 *
 * A routine is its owner's alone: another user in the same tenant sees no
 * routine of theirs, by id or by name.
 *
 * Every request names its routine by id or by name (`routine`).
 */

// ── Shapes ────────────────────────────────────────────────────────────────────

export type RoutineScheduleWire =
  /** `timezone` is IANA; omitted on input, the daemon's zone (or, on edit, the routine's current one). Always set on output. */
  | { kind: "cron"; expr: string; timezone?: string }
  | { kind: "every"; seconds: number }
  | { kind: "once"; at: string };

/** A routine's configuration. On create, only name/prompt/workdir are required. */
export interface RoutineSpecWire {
  name: string;
  /** May reference {{check}}, {{payload}}, {{last_summary}}, {{trigger}}, {{now}}, {{routine}}. */
  prompt: string;
  workdir: string;
  provider?: string;
  model?: string;
  /** Absent = runs only when fired (API or manual). */
  schedule?: RoutineScheduleWire;
  /** Pre-run gate: no output → silent run, no agent; non-zero exit → failed run, no agent. */
  check?: { command: string; timeoutSeconds?: number };
  approvals?: "autonomous" | "guarded";
  toolBudget?: number;
  maxMinutes?: number;
  maxCostUsd?: number;
  dailyCostUsd?: number;
  session?: "fresh" | "persistent";
  worktree?: boolean;
  overlap?: "skip" | "queue";
  catchUp?: boolean;
  jitterSeconds?: number;
  notify?: "on_change" | "always" | "never";
  keepSessions?: number;
  api?: boolean;
  failurePauseAfter?: number;
}

export type RoutineRunStatus =
  | "queued"
  | "checking"
  | "running"
  | "succeeded"
  | "silent"
  | "needs_attention"
  | "failed"
  | "timed_out"
  | "over_budget"
  | "skipped"
  | "cancelled"
  | "interrupted";

export interface RoutineRunWire {
  id: string;
  routineId: string;
  trigger: "schedule" | "catchup" | "api" | "manual";
  status: RoutineRunStatus;
  /** ISO timestamps. */
  scheduledFor?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** The run's session — open it to see everything the agent did. */
  sessionId?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** The agent's final message (bounded). */
  summary?: string;
  /** Why it ended this way: an error, a skip reason, what it waits on. */
  reason?: string;
  checkOutput?: string;
  payload?: string;
}

export interface RoutineWire {
  id: string;
  name: string;
  enabled: boolean;
  /** Set when the routine paused itself (repeated failures). */
  pausedReason?: string;
  ownerSub: string;
  /** The full configuration, defaults filled in. */
  spec: Required<Omit<RoutineSpecWire, "provider" | "model" | "schedule" | "check" | "maxCostUsd" | "dailyCostUsd">> &
    Pick<RoutineSpecWire, "provider" | "model" | "schedule" | "check" | "maxCostUsd" | "dailyCostUsd">;
  /** "cron 0 9 * * 1-5 (Asia/Singapore)", "every 15m", "once at …", or "on demand". */
  scheduleText: string;
  /** Next fires (ISO), soonest first; empty when paused or unscheduled. */
  upcoming: string[];
  lastRunAt?: string;
  consecutiveFailures: number;
  /** An API token is set (it is only ever shown once, on create or rotate). */
  apiTokenSet: boolean;
  /** The routine's most recent run, if any. */
  lastRun?: RoutineRunWire;
  createdAt: string;
  updatedAt: string;
}

// ── Messages (client → daemon) ────────────────────────────────────────────────

export interface RoutineCreateMsg {
  type: "routine.create";
  id: string;
  spec: RoutineSpecWire;
}

/**
 * Change a routine. `spec` is merged over the current one; `null` clears an
 * optional field (schedule, check, maxCostUsd, …). `enabled` pauses/resumes.
 */
export interface RoutineUpdateMsg {
  type: "routine.update";
  id: string;
  routine: string;
  spec?: { [K in keyof RoutineSpecWire]?: RoutineSpecWire[K] | null };
  enabled?: boolean;
}

export interface RoutineDeleteMsg {
  type: "routine.delete";
  id: string;
  routine: string;
}

export interface RoutineListMsg {
  type: "routine.list";
  id: string;
}

/** A routine with its recent runs (default 10). */
export interface RoutineGetMsg {
  type: "routine.get";
  id: string;
  routine: string;
  runs?: number;
}

/** Fire now, optionally with a payload (available to the prompt as {{payload}}). */
export interface RoutineRunMsg {
  type: "routine.run";
  id: string;
  routine: string;
  payload?: string;
}

export interface RoutineCancelRunMsg {
  type: "routine.cancel_run";
  id: string;
  runId: string;
}

/** Run history, newest first. `before` (ISO) pages older. */
export interface RoutineRunsMsg {
  type: "routine.runs";
  id: string;
  routine: string;
  limit?: number;
  before?: string;
  /** Just this run (empty when it is not one of this routine's). */
  runId?: string;
}

/** Mint a new API token (the old one stops working immediately). */
export interface RoutineTokenMsg {
  type: "routine.token";
  id: string;
  routine: string;
}

/** Validate a schedule and list its next fires, without saving anything. */
export interface RoutinePreviewMsg {
  type: "routine.preview";
  id: string;
  schedule: RoutineScheduleWire;
  count?: number;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface RoutineSnapshotMsg {
  type: "routine.snapshot";
  requestId: string;
  routine: RoutineWire;
  runs?: RoutineRunWire[];
  /** Present only right after create/enable-api: the token is never shown again. */
  apiToken?: string;
}

export interface RoutineListResultMsg {
  type: "routine.list.result";
  requestId: string;
  routines: RoutineWire[];
}

export interface RoutineRunResultMsg {
  type: "routine.run.result";
  requestId: string;
  run: RoutineRunWire;
}

export interface RoutineRunsResultMsg {
  type: "routine.runs.result";
  requestId: string;
  routineId: string;
  runs: RoutineRunWire[];
  hasMore: boolean;
}

export interface RoutineTokenResultMsg {
  type: "routine.token.result";
  requestId: string;
  routineId: string;
  /** Shown once. POST it as `Authorization: Bearer <token>` to the routine's endpoint. */
  apiToken: string;
  /** Path of the routine's endpoint on the daemon (`/routines/<id>/fire`). */
  endpointPath: string;
}

export interface RoutinePreviewResultMsg {
  type: "routine.preview.result";
  requestId: string;
  fires: string[];
}

/** Path of a routine's API trigger on the daemon's HTTP server. */
export function routineFirePath(routineId: string): string {
  return `/routines/${routineId}/fire`;
}
