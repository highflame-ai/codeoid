/**
 * Durable loop state: runs, their attempts, and an append-only event history.
 *
 * Shares the daemon's SQLite connection (or opens its own in tests) and
 * migrates with the same `CREATE TABLE IF NOT EXISTS` convention as the
 * routine and pipeline stores.
 *
 * Every change to a run is a compare-and-set on `state_version` and writes its
 * event in the same transaction (§5 "Persist each state transition and its
 * event atomically"): a late worker result, a restart, or a racing cancel can
 * never apply on top of a state it did not see.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { BUSY_TIMEOUT_MS } from "../store.js";
import type {
  AttemptResult,
  AttemptStatus,
  LoopAttemptRow,
  LoopContract,
  LoopEventRow,
  LoopRunRow,
  LoopStatus,
  WorkerReport,
} from "./types.js";

interface RunDbRow {
  id: string;
  account_id: string;
  project_id: string;
  owner_sub: string;
  owner_name: string | null;
  contract_json: string;
  status: string;
  reason: string | null;
  waiting_on: string | null;
  base_revision: string | null;
  worktree_path: string | null;
  worktree_root: string | null;
  git_dir: string | null;
  common_dir: string | null;
  branch: string | null;
  worker_session_id: string | null;
  accepted_attempt_id: string | null;
  delivered_commit: string | null;
  pending_steer_json: string;
  setup_paths_json: string;
  base_tree: string | null;
  check_ms: number;
  state_version: number;
  active_ms: number;
  cost_usd: number;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

interface AttemptDbRow {
  id: string;
  run_id: string;
  ordinal: number;
  status: string;
  result: string | null;
  dispatch_task_id: string | null;
  worker_session_id: string | null;
  provider: string | null;
  model: string | null;
  report_json: string | null;
  candidate_tree: string | null;
  evidence_ids_json: string;
  note: string | null;
  started_at: number | null;
  ended_at: number | null;
  cost_usd: number;
  prompt: string | null;
  cost_at_start: number;
  held_ms: number;
  held_since: number | null;
}

/** Fields a run transition may change. */
export type RunPatch = Partial<
  Pick<
    LoopRunRow,
    | "status"
    | "reason"
    | "waitingOn"
    | "baseRevision"
    | "worktreePath"
    | "worktreeRoot"
    | "gitDir"
    | "commonDir"
    | "branch"
    | "workerSessionId"
    | "acceptedAttemptId"
    | "deliveredCommit"
    | "pendingSteer"
    | "setupPaths"
    | "baseTree"
    | "checkMs"
    | "activeMs"
    | "costUsd"
    | "endedAt"
  >
>;

export type AttemptPatch = Partial<
  Pick<
    LoopAttemptRow,
    | "status"
    | "result"
    | "dispatchTaskId"
    | "workerSessionId"
    | "provider"
    | "model"
    | "report"
    | "candidateTree"
    | "evidenceIds"
    | "note"
    | "startedAt"
    | "endedAt"
    | "costUsd"
    | "prompt"
    | "costAtStart"
    | "heldMs"
    | "heldSince"
  >
>;

const RUN_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  reason: "reason",
  waitingOn: "waiting_on",
  baseRevision: "base_revision",
  worktreePath: "worktree_path",
  worktreeRoot: "worktree_root",
  gitDir: "git_dir",
  commonDir: "common_dir",
  branch: "branch",
  workerSessionId: "worker_session_id",
  acceptedAttemptId: "accepted_attempt_id",
  deliveredCommit: "delivered_commit",
  pendingSteer: "pending_steer_json",
  setupPaths: "setup_paths_json",
  baseTree: "base_tree",
  checkMs: "check_ms",
  activeMs: "active_ms",
  costUsd: "cost_usd",
  endedAt: "ended_at",
};

const ATTEMPT_COLUMNS: Record<keyof AttemptPatch, string> = {
  status: "status",
  result: "result",
  dispatchTaskId: "dispatch_task_id",
  workerSessionId: "worker_session_id",
  provider: "provider",
  model: "model",
  report: "report_json",
  candidateTree: "candidate_tree",
  evidenceIds: "evidence_ids_json",
  note: "note",
  startedAt: "started_at",
  endedAt: "ended_at",
  costUsd: "cost_usd",
  prompt: "prompt",
  costAtStart: "cost_at_start",
  heldMs: "held_ms",
  heldSince: "held_since",
};

/** JSON-typed columns: serialized on write. */
const JSON_FIELDS = new Set<string>(["pendingSteer", "setupPaths", "report", "evidenceIds"]);

function sqlValue(field: string, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (JSON_FIELDS.has(field)) return JSON.stringify(value);
  return value as string | number;
}

export interface LoopTenant {
  accountId: string;
  projectId: string;
}

export class LoopStore {
  readonly #db: Database;

  constructor(db: Database | string) {
    this.#db = typeof db === "string" ? new Database(db, { create: true }) : db;
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id                  TEXT PRIMARY KEY,
        account_id          TEXT NOT NULL,
        project_id          TEXT NOT NULL,
        owner_sub           TEXT NOT NULL,
        owner_name          TEXT,
        contract_json       TEXT NOT NULL,
        status              TEXT NOT NULL,
        reason              TEXT,
        waiting_on          TEXT,
        base_revision       TEXT,
        worktree_path       TEXT,
        worktree_root       TEXT,
        git_dir             TEXT,
        common_dir          TEXT,
        branch              TEXT,
        worker_session_id   TEXT,
        accepted_attempt_id TEXT,
        delivered_commit    TEXT,
        pending_steer_json  TEXT NOT NULL DEFAULT '[]',
        setup_paths_json    TEXT NOT NULL DEFAULT '[]',
        base_tree           TEXT,
        check_ms            INTEGER NOT NULL DEFAULT 0,
        state_version       INTEGER NOT NULL DEFAULT 0,
        active_ms           INTEGER NOT NULL DEFAULT 0,
        cost_usd            REAL NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        ended_at            INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_loop_runs_owner
        ON loop_runs(account_id, project_id, owner_sub, created_at);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_status ON loop_runs(status);

      CREATE TABLE IF NOT EXISTS loop_attempts (
        id                 TEXT PRIMARY KEY,
        run_id             TEXT NOT NULL,
        ordinal            INTEGER NOT NULL,
        status             TEXT NOT NULL,
        result             TEXT,
        dispatch_task_id   TEXT,
        worker_session_id  TEXT,
        provider           TEXT,
        model              TEXT,
        report_json        TEXT,
        candidate_tree     TEXT,
        evidence_ids_json  TEXT NOT NULL DEFAULT '[]',
        note               TEXT,
        started_at         INTEGER,
        ended_at           INTEGER,
        cost_usd           REAL NOT NULL DEFAULT 0,
        prompt             TEXT,
        cost_at_start      REAL NOT NULL DEFAULT 0,
        held_ms            INTEGER NOT NULL DEFAULT 0,
        held_since         INTEGER,
        UNIQUE (run_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS loop_events (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id  TEXT NOT NULL,
        at      INTEGER NOT NULL,
        actor   TEXT NOT NULL,
        type    TEXT NOT NULL,
        detail  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loop_events_run ON loop_events(run_id, seq);

      CREATE TABLE IF NOT EXISTS loop_meta (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  // ── Liveness ────────────────────────────────────────────────────────────

  /** The daemon's last recorded sign of life, for charging downtime to no run. */
  aliveAt(): number | null {
    const row = this.#db.prepare("SELECT value FROM loop_meta WHERE key = 'alive_at'").get() as { value: number } | null;
    return row?.value ?? null;
  }

  touchAlive(at: number): void {
    this.#db.prepare("INSERT INTO loop_meta (key, value) VALUES ('alive_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(at);
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  createRun(input: {
    tenant: LoopTenant;
    ownerSub: string;
    ownerName?: string;
    contract: LoopContract;
    actor: string;
  }): LoopRunRow {
    const id = `loop_${randomUUID()}`;
    const at = Date.now();
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO loop_runs (id, account_id, project_id, owner_sub, owner_name, contract_json,
             status, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', 'preparing the run', ?, ?)`,
        )
        .run(
          id,
          input.tenant.accountId,
          input.tenant.projectId,
          input.ownerSub,
          input.ownerName ?? null,
          JSON.stringify(input.contract),
          at,
          at,
        );
      this.#appendEvent(id, input.actor, "run.started", input.contract.objective.slice(0, 500), at);
    })();
    return this.getRun(id)!;
  }

  getRun(id: string): LoopRunRow | null {
    const row = this.#db.prepare("SELECT * FROM loop_runs WHERE id = ?").get(id) as RunDbRow | null;
    return row ? toRun(row) : null;
  }

  /** A run visible to `ownerSub` in `tenant`; anything else is null. */
  getOwnedRun(id: string, tenant: LoopTenant, ownerSub: string): LoopRunRow | null {
    const row = this.#db
      .prepare("SELECT * FROM loop_runs WHERE id = ? AND account_id = ? AND project_id = ? AND owner_sub = ?")
      .get(id, tenant.accountId, tenant.projectId, ownerSub) as RunDbRow | null;
    return row ? toRun(row) : null;
  }

  listOwnedRuns(tenant: LoopTenant, ownerSub: string, limit = 50): LoopRunRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM loop_runs WHERE account_id = ? AND project_id = ? AND owner_sub = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(tenant.accountId, tenant.projectId, ownerSub, limit) as RunDbRow[]
    ).map(toRun);
  }

  /** One owner's runs not in a terminal status, oldest first. */
  listActiveOwnedRuns(tenant: LoopTenant, ownerSub: string): LoopRunRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM loop_runs WHERE account_id = ? AND project_id = ? AND owner_sub = ?
           AND status NOT IN ('completed','budget_exhausted','blocked','failed','cancelled')
           ORDER BY created_at`,
        )
        .all(tenant.accountId, tenant.projectId, ownerSub) as RunDbRow[]
    ).map(toRun);
  }

  /** Runs not in a terminal status — what boot reconciliation looks at. */
  listActiveRuns(): LoopRunRow[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM loop_runs
           WHERE status NOT IN ('completed','budget_exhausted','blocked','failed','cancelled')
           ORDER BY created_at`,
        )
        .all() as RunDbRow[]
    ).map(toRun);
  }

  /**
   * Apply `patch` if the run is still at `expectedVersion`, recording `event`
   * with it. Returns the updated run, or null when another transition got there
   * first — the caller re-reads and decides again rather than overwriting.
   */
  transition(
    id: string,
    expectedVersion: number,
    patch: RunPatch,
    event: { actor: string; type: string; detail?: string },
  ): LoopRunRow | null {
    const at = Date.now();
    const sets: string[] = ["state_version = state_version + 1", "updated_at = ?"];
    const values: Array<string | number | null> = [at];
    for (const [field, value] of Object.entries(patch)) {
      const col = RUN_COLUMNS[field as keyof RunPatch];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(sqlValue(field, value));
    }
    let applied = false;
    this.#db.transaction(() => {
      const res = this.#db
        .prepare(`UPDATE loop_runs SET ${sets.join(", ")} WHERE id = ? AND state_version = ?`)
        .run(...values, id, expectedVersion);
      applied = Number(res.changes ?? 0) === 1;
      if (applied) this.#appendEvent(id, event.actor, event.type, event.detail ?? "", at);
    })();
    return applied ? this.getRun(id) : null;
  }

  // ── Attempts ────────────────────────────────────────────────────────────

  /**
   * Create the run's next attempt and apply `patch` to the run in one
   * transaction, at `expectedVersion` — so a crash can never leave an attempt
   * row the run didn't move to, nor a run that moved without its attempt.
   */
  startAttempt(
    runId: string,
    expectedVersion: number,
    prompt: string,
    patch: RunPatch,
    event: { actor: string; type: string },
  ): { run: LoopRunRow; attempt: LoopAttemptRow } | null {
    const id = `att_${randomUUID()}`;
    let ok = false;
    this.#db.transaction(() => {
      const ordinal =
        ((this.#db.prepare("SELECT MAX(ordinal) AS n FROM loop_attempts WHERE run_id = ?").get(runId) as { n: number | null })
          .n ?? 0) + 1;
      const next = this.transition(runId, expectedVersion, patch, { ...event, detail: id });
      if (!next) return;
      this.#db
        .prepare("INSERT INTO loop_attempts (id, run_id, ordinal, status, prompt) VALUES (?, ?, ?, 'queued', ?)")
        .run(id, runId, ordinal, prompt);
      ok = true;
    })();
    if (!ok) return null;
    return { run: this.getRun(runId)!, attempt: this.getAttempt(id)! };
  }

  /** Active (non-terminal) runs one owner has. */
  countActiveOwnedRuns(tenant: LoopTenant, ownerSub: string): number {
    return (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM loop_runs WHERE account_id = ? AND project_id = ? AND owner_sub = ?
           AND status NOT IN ('completed','budget_exhausted','blocked','failed','cancelled')`,
        )
        .get(tenant.accountId, tenant.projectId, ownerSub) as { n: number }
    ).n;
  }

  getAttempt(id: string): LoopAttemptRow | null {
    const row = this.#db.prepare("SELECT * FROM loop_attempts WHERE id = ?").get(id) as AttemptDbRow | null;
    return row ? toAttempt(row) : null;
  }

  listAttempts(runId: string): LoopAttemptRow[] {
    return (
      this.#db.prepare("SELECT * FROM loop_attempts WHERE run_id = ? ORDER BY ordinal").all(runId) as AttemptDbRow[]
    ).map(toAttempt);
  }

  updateAttempt(id: string, patch: AttemptPatch): LoopAttemptRow | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [field, value] of Object.entries(patch)) {
      const col = ATTEMPT_COLUMNS[field as keyof AttemptPatch];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(sqlValue(field, value));
    }
    if (sets.length === 0) return this.getAttempt(id);
    this.#db.prepare(`UPDATE loop_attempts SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.getAttempt(id);
  }

  // ── Events ──────────────────────────────────────────────────────────────

  appendEvent(runId: string, actor: string, type: string, detail = ""): void {
    this.#appendEvent(runId, actor, type, detail, Date.now());
  }

  #appendEvent(runId: string, actor: string, type: string, detail: string, at: number): void {
    this.#db
      .prepare("INSERT INTO loop_events (run_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)")
      .run(runId, at, actor, type, detail.slice(0, 4_000));
  }

  listEvents(runId: string, limit = 200): LoopEventRow[] {
    return (
      this.#db
        .prepare("SELECT * FROM (SELECT * FROM loop_events WHERE run_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq")
        .all(runId, limit) as Array<{ seq: number; run_id: string; at: number; actor: string; type: string; detail: string }>
    ).map((r) => ({ seq: r.seq, runId: r.run_id, at: r.at, actor: r.actor, type: r.type, detail: r.detail }));
  }
}

function toRun(r: RunDbRow): LoopRunRow {
  return {
    id: r.id,
    accountId: r.account_id,
    projectId: r.project_id,
    ownerSub: r.owner_sub,
    ownerName: r.owner_name,
    contract: JSON.parse(r.contract_json) as LoopContract,
    status: r.status as LoopStatus,
    reason: r.reason,
    waitingOn: r.waiting_on,
    baseRevision: r.base_revision,
    worktreePath: r.worktree_path,
    worktreeRoot: r.worktree_root,
    gitDir: r.git_dir,
    commonDir: r.common_dir,
    branch: r.branch,
    workerSessionId: r.worker_session_id,
    acceptedAttemptId: r.accepted_attempt_id,
    deliveredCommit: r.delivered_commit,
    pendingSteer: JSON.parse(r.pending_steer_json) as string[],
    setupPaths: JSON.parse(r.setup_paths_json) as string[],
    baseTree: r.base_tree,
    checkMs: r.check_ms,
    stateVersion: r.state_version,
    activeMs: r.active_ms,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

function toAttempt(r: AttemptDbRow): LoopAttemptRow {
  return {
    id: r.id,
    runId: r.run_id,
    ordinal: r.ordinal,
    status: r.status as AttemptStatus,
    result: r.result as AttemptResult | null,
    dispatchTaskId: r.dispatch_task_id,
    workerSessionId: r.worker_session_id,
    provider: r.provider,
    model: r.model,
    report: r.report_json ? (JSON.parse(r.report_json) as WorkerReport) : null,
    candidateTree: r.candidate_tree,
    evidenceIds: JSON.parse(r.evidence_ids_json) as string[],
    note: r.note,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    costUsd: r.cost_usd,
    prompt: r.prompt,
    costAtStart: r.cost_at_start,
    heldMs: r.held_ms,
    heldSince: r.held_since,
  };
}
