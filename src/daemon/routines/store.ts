/**
 * Durable routine state: the routines themselves and every run they made.
 *
 * Shares the daemon's SQLite connection (or opens its own in tests), and
 * migrates with the same `CREATE TABLE IF NOT EXISTS` convention as the daemon
 * Store and PipelineStore.
 *
 * The one piece of concurrency logic lives here, in `claimFire`: a scheduled
 * fire is claimed by a compare-and-set on `next_fire_at`. Only the caller that
 * moves it from the value it read wins, so two overlapping ticks can never
 * both start the same fire. That is the "tick lock", without a lock file to
 * go stale. It covers claiming only: starting queued runs and boot recovery
 * assume one daemon per database, which is how codeoid runs.
 */

import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { BUSY_TIMEOUT_MS } from "../store.js";
import type { LoopStatus } from "../loops/types.js";
import {
  ACTIVE_RUN_STATUSES,
  OUTCOME_RUN_STATUSES,
  type RoutineRow,
  type RoutineSpec,
  type RunRow,
  type RunStatus,
  type RunTrigger,
} from "./types.js";

interface RoutineDbRow {
  id: string;
  account_id: string;
  project_id: string;
  name: string;
  owner_sub: string;
  spec_json: string;
  enabled: number;
  paused_reason: string | null;
  next_fire_at: number | null;
  anchor_at: number;
  last_run_at: number | null;
  consecutive_failures: number;
  persistent_session_id: string | null;
  api_token_hash: string | null;
  created_at: number;
  updated_at: number;
}

interface RunDbRow {
  id: string;
  routine_id: string;
  account_id: string;
  project_id: string;
  trigger: string;
  status: string;
  scheduled_for: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  session_id: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  summary: string | null;
  reason: string | null;
  check_output: string | null;
  payload: string | null;
  loop_run_id: string | null;
  loop_status: string | null;
}

/** sha256 of an API token — only the hash is stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RoutineStore {
  readonly #db: Database;

  constructor(db: Database | string) {
    this.#db = typeof db === "string" ? new Database(db, { create: true }) : db;
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        id                     TEXT PRIMARY KEY,
        account_id             TEXT NOT NULL,
        project_id             TEXT NOT NULL,
        name                   TEXT NOT NULL,
        owner_sub              TEXT NOT NULL,
        spec_json              TEXT NOT NULL,
        enabled                INTEGER NOT NULL DEFAULT 1,
        paused_reason          TEXT,
        next_fire_at           INTEGER,
        anchor_at              INTEGER NOT NULL,
        last_run_at            INTEGER,
        consecutive_failures   INTEGER NOT NULL DEFAULT 0,
        persistent_session_id  TEXT,
        api_token_hash         TEXT,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );
      -- Names are unique per owner: a routine is its owner's alone, so a
      -- teammate's choice of name must neither collide nor be revealed.
      DROP INDEX IF EXISTS idx_routines_tenant_name;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_owner_name
        ON routines(account_id, project_id, owner_sub, name);
      CREATE INDEX IF NOT EXISTS idx_routines_due
        ON routines(enabled, next_fire_at);

      CREATE TABLE IF NOT EXISTS routine_runs (
        id             TEXT PRIMARY KEY,
        routine_id     TEXT NOT NULL,
        account_id     TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        trigger        TEXT NOT NULL,
        status         TEXT NOT NULL,
        scheduled_for  INTEGER,
        created_at     INTEGER NOT NULL,
        started_at     INTEGER,
        ended_at       INTEGER,
        session_id     TEXT,
        cost_usd       REAL NOT NULL DEFAULT 0,
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        summary        TEXT,
        reason         TEXT,
        check_output   TEXT,
        payload        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
        ON routine_runs(routine_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_routine_runs_status
        ON routine_runs(status);
    `);
    // Loop routines (added later): the loop run a routine run started.
    const cols = (this.#db.prepare("PRAGMA table_info(routine_runs)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["loop_run_id", "loop_status"]) {
      if (!cols.includes(c)) this.#db.exec(`ALTER TABLE routine_runs ADD COLUMN ${c} TEXT`);
    }
  }

  // ── Routines ────────────────────────────────────────────────────────────

  insertRoutine(r: RoutineRow, apiTokenHash: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO routines (id, account_id, project_id, name, owner_sub, spec_json, enabled, paused_reason,
           next_fire_at, anchor_at, last_run_at, consecutive_failures, persistent_session_id, api_token_hash,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.accountId,
        r.projectId,
        r.spec.name,
        r.ownerSub,
        JSON.stringify(r.spec),
        r.enabled ? 1 : 0,
        r.pausedReason,
        r.nextFireAt,
        r.anchorAt,
        r.lastRunAt,
        r.consecutiveFailures,
        r.persistentSessionId,
        apiTokenHash,
        r.createdAt,
        r.updatedAt,
      );
  }

  /** Replace the spec (and the schedule state that depends on it). */
  updateRoutine(
    id: string,
    patch: { spec: RoutineSpec; enabled: boolean; pausedReason: string | null; nextFireAt: number | null; anchorAt: number; resetStreak: boolean },
    now: number,
  ): void {
    this.#db
      .prepare(
        `UPDATE routines SET name = ?, spec_json = ?, enabled = ?, paused_reason = ?, next_fire_at = ?, anchor_at = ?,
           consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures END, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.spec.name,
        JSON.stringify(patch.spec),
        patch.enabled ? 1 : 0,
        patch.pausedReason,
        patch.nextFireAt,
        patch.anchorAt,
        // Only resuming resets the failure streak; an edit keeps it.
        patch.resetStreak ? 1 : 0,
        now,
        id,
      );
  }

  deleteRoutine(id: string): void {
    this.#db.prepare("DELETE FROM routines WHERE id = ?").run(id);
  }

  getRoutine(id: string): RoutineRow | undefined {
    const row = this.#db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineDbRow | null;
    return row ? toRoutine(row) : undefined;
  }

  getRoutineByName(accountId: string, projectId: string, ownerSub: string, name: string): RoutineRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM routines WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND name = ?")
      .get(accountId, projectId, ownerSub, name) as RoutineDbRow | null;
    return row ? toRoutine(row) : undefined;
  }

  listRoutines(accountId: string, projectId: string, ownerSub: string): RoutineRow[] {
    return (
      this.#db
        .prepare("SELECT * FROM routines WHERE account_id = ? AND project_id = ? AND owner_sub = ? ORDER BY name")
        .all(accountId, projectId, ownerSub) as RoutineDbRow[]
    ).map(toRoutine);
  }

  /** Enabled routines whose next fire is due — across tenants (the scheduler serves them all). */
  listDue(now: number): RoutineRow[] {
    return (
      this.#db
        .prepare("SELECT * FROM routines WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at")
        .all(now) as RoutineDbRow[]
    ).map(toRoutine);
  }

  /**
   * Claim a scheduled fire: move `next_fire_at` from `expected` to `next`.
   * True only for the caller that actually moved it.
   */
  claimFire(id: string, expected: number, next: number | null, now: number): boolean {
    const res = this.#db
      .prepare("UPDATE routines SET next_fire_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_fire_at = ?")
      .run(next, now, id, expected);
    return res.changes === 1;
  }

  setPaused(id: string, reason: string, now: number): void {
    this.#db.prepare("UPDATE routines SET enabled = 0, paused_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, id);
  }

  recordOutcome(id: string, outcome: { at: number; failed: boolean }): number {
    this.#db
      .prepare(
        `UPDATE routines SET last_run_at = ?,
           consecutive_failures = CASE WHEN ? = 1 THEN consecutive_failures + 1 ELSE 0 END
         WHERE id = ?`,
      )
      .run(outcome.at, outcome.failed ? 1 : 0, id);
    const row = this.#db.prepare("SELECT consecutive_failures AS n FROM routines WHERE id = ?").get(id) as { n: number } | null;
    return row?.n ?? 0;
  }

  setPersistentSession(id: string, sessionId: string | null): void {
    this.#db.prepare("UPDATE routines SET persistent_session_id = ? WHERE id = ?").run(sessionId, id);
  }

  setApiTokenHash(id: string, hash: string | null, now: number): void {
    this.#db.prepare("UPDATE routines SET api_token_hash = ?, updated_at = ? WHERE id = ?").run(hash, now, id);
  }

  hasApiToken(id: string): boolean {
    const row = this.#db.prepare("SELECT api_token_hash AS h FROM routines WHERE id = ?").get(id) as { h: string | null } | null;
    return !!row?.h;
  }

  /** Constant-time check of a presented API token against the stored hash. */
  verifyApiToken(id: string, token: string): boolean {
    const row = this.#db.prepare("SELECT api_token_hash AS h FROM routines WHERE id = ?").get(id) as { h: string | null } | null;
    if (!row?.h) return false;
    const a = Buffer.from(row.h, "hex");
    const b = Buffer.from(hashToken(token), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  insertRun(run: RunRow): void {
    this.#db
      .prepare(
        `INSERT INTO routine_runs (id, routine_id, account_id, project_id, trigger, status, scheduled_for, created_at,
           started_at, ended_at, session_id, cost_usd, input_tokens, output_tokens, summary, reason, check_output, payload,
           loop_run_id, loop_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.routineId,
        run.accountId,
        run.projectId,
        run.trigger,
        run.status,
        run.scheduledFor,
        run.createdAt,
        run.startedAt,
        run.endedAt,
        run.sessionId,
        run.costUsd,
        run.inputTokens,
        run.outputTokens,
        run.summary,
        run.reason,
        run.checkOutput,
        run.payload,
        run.loopRunId,
        run.loopStatus,
      );
  }

  updateRun(id: string, patch: Partial<Omit<RunRow, "id" | "routineId" | "accountId" | "projectId" | "createdAt">>): void {
    const cols: Record<string, string> = {
      trigger: "trigger",
      status: "status",
      scheduledFor: "scheduled_for",
      startedAt: "started_at",
      endedAt: "ended_at",
      sessionId: "session_id",
      costUsd: "cost_usd",
      inputTokens: "input_tokens",
      outputTokens: "output_tokens",
      summary: "summary",
      reason: "reason",
      checkOutput: "check_output",
      payload: "payload",
      loopRunId: "loop_run_id",
      loopStatus: "loop_status",
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(v as string | number | null);
    }
    if (sets.length === 0) return;
    this.#db.prepare(`UPDATE routine_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  getRun(id: string): RunRow | undefined {
    const row = this.#db.prepare("SELECT * FROM routine_runs WHERE id = ?").get(id) as RunDbRow | null;
    return row ? toRun(row) : undefined;
  }

  /**
   * Newest first. Ties on `created_at` (two fires in one millisecond) break by
   * insertion order (`rowid`), never by the random run id — "latest run",
   * retention, and {{last_summary}} all depend on this order being real.
   */
  listRuns(routineId: string, opts: { limit: number; before?: number }): RunRow[] {
    const rows = (
      opts.before === undefined
        ? this.#db.prepare("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(routineId, opts.limit)
        : this.#db
            .prepare("SELECT * FROM routine_runs WHERE routine_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
            .all(routineId, opts.before, opts.limit)
    ) as RunDbRow[];
    return rows.map(toRun);
  }

  /** Runs not yet finished, for this routine (or every routine when omitted). */
  activeRuns(routineId?: string): RunRow[] {
    const ph = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    const rows = (
      routineId
        ? this.#db.prepare(`SELECT * FROM routine_runs WHERE routine_id = ? AND status IN (${ph}) ORDER BY created_at, rowid`).all(routineId, ...ACTIVE_RUN_STATUSES)
        : this.#db.prepare(`SELECT * FROM routine_runs WHERE status IN (${ph}) ORDER BY created_at, rowid`).all(...ACTIVE_RUN_STATUSES)
    ) as RunDbRow[];
    return rows.map(toRun);
  }

  /**
   * The newest run that ended with an outcome, by when it ended: what "how is
   * this routine doing" means. Skipped, cancelled and interrupted runs are
   * not outcomes, so a loop routine's blocked loop is not hidden behind the
   * fires skipped while it ran.
   */
  lastOutcome(routineId: string): RunRow | undefined {
    const ph = OUTCOME_RUN_STATUSES.map(() => "?").join(", ");
    const row = this.#db
      .prepare(
        `SELECT * FROM routine_runs WHERE routine_id = ? AND status IN (${ph}) AND ended_at IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
      )
      .get(routineId, ...OUTCOME_RUN_STATUSES) as RunDbRow | null;
    return row ? toRun(row) : undefined;
  }

  /** Spend since `since` (ms) — the daily cap's numerator. */
  costSince(routineId: string, since: number): number {
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM routine_runs WHERE routine_id = ? AND created_at >= ?")
      .get(routineId, since) as { c: number };
    return row.c;
  }

  /** Session ids of finished runs, newest first — retention picks from here. */
  finishedRunSessions(routineId: string): Array<{ runId: string; sessionId: string }> {
    const ph = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    return this.#db
      .prepare(
        `SELECT id AS runId, session_id AS sessionId FROM routine_runs
         WHERE routine_id = ? AND session_id IS NOT NULL AND status NOT IN (${ph})
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(routineId, ...ACTIVE_RUN_STATUSES) as Array<{ runId: string; sessionId: string }>;
  }

  /**
   * When the last run that dealt with its input started: the newest
   * `succeeded` or `silent` run. A check asking "anything new since?" must not
   * skip what a failed, cancelled or parked run found and left undone.
   */
  lastHandledStart(routineId: string): number | null {
    const row = this.#db
      .prepare(
        "SELECT started_at AS t FROM routine_runs WHERE routine_id = ? AND status IN ('succeeded', 'silent') AND started_at IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(routineId) as { t: number } | null;
    return row?.t ?? null;
  }

  /**
   * Keep a routine's newest `keep` finished runs; delete older ones — except
   * what later runs still read: anything since `keepSince` (today's spend,
   * which the daily cap sums), the newest summary ({{last_summary}}), and the
   * newest handled run (CODEOID_ROUTINE_SINCE), and the newest outcome
   * (`lastOutcome`, which a long run of skips must not push out).
   */
  trimRuns(routineId: string, keep: number, keepSince: number): void {
    const ph = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    const outcomes = OUTCOME_RUN_STATUSES.map(() => "?").join(", ");
    this.#db
      .prepare(
        `DELETE FROM routine_runs WHERE routine_id = ? AND status NOT IN (${ph}) AND created_at < ?
           AND rowid NOT IN (
             SELECT rowid FROM routine_runs WHERE routine_id = ? AND status NOT IN (${ph})
             ORDER BY created_at DESC, rowid DESC LIMIT ?)
           AND rowid NOT IN (
             SELECT rowid FROM routine_runs WHERE routine_id = ? AND status = 'succeeded' AND summary IS NOT NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1)
           AND rowid NOT IN (
             SELECT rowid FROM routine_runs WHERE routine_id = ? AND status IN ('succeeded', 'silent') AND started_at IS NOT NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1)
           AND rowid NOT IN (
             SELECT rowid FROM routine_runs WHERE routine_id = ? AND status IN (${outcomes}) AND ended_at IS NOT NULL
             ORDER BY ended_at DESC, rowid DESC LIMIT 1)`,
      )
      .run(routineId, ...ACTIVE_RUN_STATUSES, keepSince, routineId, ...ACTIVE_RUN_STATUSES, keep, routineId, routineId, routineId, ...OUTCOME_RUN_STATUSES);
  }

  /** The last run that produced a summary — feeds {{last_summary}}. */
  lastSummary(routineId: string): string | null {
    const row = this.#db
      .prepare("SELECT summary FROM routine_runs WHERE routine_id = ? AND status = 'succeeded' AND summary IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(routineId) as { summary: string } | null;
    return row?.summary ?? null;
  }

  /** Session ids of runs currently in flight, for this tenant (SessionInfo.managedBy). */
  activeRunSessionIds(accountId: string, projectId: string): string[] {
    const ph = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    return (
      this.#db
        .prepare(`SELECT session_id AS s FROM routine_runs WHERE account_id = ? AND project_id = ? AND session_id IS NOT NULL AND status IN (${ph})`)
        .all(accountId, projectId, ...ACTIVE_RUN_STATUSES) as Array<{ s: string }>
    ).map((r) => r.s);
  }

  /** Delete a routine's runs (with the routine). */
  deleteRuns(routineId: string): void {
    this.#db.prepare("DELETE FROM routine_runs WHERE routine_id = ?").run(routineId);
  }

  /** Everyone who holds a routine, once each, with their tenant. */
  owners(): Array<{ sub: string; accountId: string; projectId: string }> {
    return (
      this.#db.prepare("SELECT DISTINCT account_id, project_id, owner_sub FROM routines").all() as Array<{
        account_id: string;
        project_id: string;
        owner_sub: string;
      }>
    ).map((r) => ({ sub: r.owner_sub, accountId: r.account_id, projectId: r.project_id }));
  }

  /** Runs following a loop run they started — still open until the loop ends. */
  loopFollowingRuns(): RunRow[] {
    return this.activeRuns().filter((r) => r.loopRunId !== null);
  }

  /**
   * Boot recovery: runs that were checking or running belong to a process that
   * is gone, so they are closed as interrupted. Queued runs never started and
   * stay queued — an API fire answered 202 still runs after a restart. A run
   * following a loop is left open: the loop survives the restart, and the
   * scheduler picks the run up again.
   */
  interruptActiveRuns(now: number, reason: string): RunRow[] {
    const active = this.activeRuns().filter((r) => r.status !== "queued" && r.loopRunId === null);
    for (const r of active) this.updateRun(r.id, { status: "interrupted", endedAt: now, reason });
    return active;
  }

  setRunStatus(id: string, status: RunStatus, extra: Partial<RunRow> = {}): void {
    this.updateRun(id, { ...extra, status });
  }

  countRuns(routineId: string, trigger: RunTrigger, since: number): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ? AND trigger = ? AND created_at >= ?")
      .get(routineId, trigger, since) as { n: number };
    return row.n;
  }
}

function toRoutine(r: RoutineDbRow): RoutineRow {
  return {
    id: r.id,
    accountId: r.account_id,
    projectId: r.project_id,
    ownerSub: r.owner_sub,
    spec: JSON.parse(r.spec_json) as RoutineSpec,
    enabled: r.enabled === 1,
    pausedReason: r.paused_reason,
    nextFireAt: r.next_fire_at,
    anchorAt: r.anchor_at,
    lastRunAt: r.last_run_at,
    consecutiveFailures: r.consecutive_failures,
    persistentSessionId: r.persistent_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: RunDbRow): RunRow {
  return {
    id: r.id,
    routineId: r.routine_id,
    accountId: r.account_id,
    projectId: r.project_id,
    trigger: r.trigger as RunTrigger,
    status: r.status as RunStatus,
    scheduledFor: r.scheduled_for,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    sessionId: r.session_id,
    costUsd: r.cost_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    summary: r.summary,
    reason: r.reason,
    checkOutput: r.check_output,
    payload: r.payload,
    loopRunId: r.loop_run_id ?? null,
    loopStatus: (r.loop_status as LoopStatus | null) ?? null,
  };
}
