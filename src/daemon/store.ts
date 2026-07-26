/**
 * SQLite-backed persistence for session metadata and audit log.
 *
 * Uses Bun's built-in SQLite (no native addon dependency).
 */

import { Database } from "bun:sqlite";
import type { ModelInfo, SessionInfo, SessionStatus } from "../protocol/types.js";

// ── Dispatch queue types (P4) ─────────────────────────────────────────────

export type DispatchTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "done"
  | "failed"
  | "blocked";

export interface DispatchTaskRow {
  id: string;
  accountId: string;
  projectId: string;
  kind: "send" | "spawn";
  shape: "ship" | "scout";
  targetSession: string | null;
  workdir: string | null;
  prompt: string;
  /**
   * Backend the spawned worker runs on. NULL = the daemon default provider,
   * which is what every task written before per-role backends carried.
   * Ignored for `kind: "send"` — that delivers into an existing session which
   * already has a provider of its own.
   */
  provider: string | null;
  /** Per-child model, already resolved against `provider`. NULL = provider default. */
  model: string | null;
  status: DispatchTaskStatus;
  attempts: number;
  failureLimit: number;
  claimOwner: string | null;
  claimedAt: number | null;
  notBefore: number | null;
  workerSessionId: string | null;
  resultDigest: string | null;
  error: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface DispatchEventRow {
  id: number;
  accountId: string;
  projectId: string;
  taskId: string;
  type: "task_done" | "task_failed" | "task_blocked";
  digest: string;
  createdAt: number;
}

interface RawDispatchRow {
  id: string;
  account_id: string;
  project_id: string;
  kind: "send" | "spawn";
  shape: "ship" | "scout";
  target_session: string | null;
  workdir: string | null;
  prompt: string;
  provider: string | null;
  model: string | null;
  status: DispatchTaskStatus;
  attempts: number;
  failure_limit: number;
  claim_owner: string | null;
  claimed_at: number | null;
  not_before: number | null;
  worker_session_id: string | null;
  result_digest: string | null;
  error: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function rowToDispatchTask(r: RawDispatchRow): DispatchTaskRow {
  return {
    id: r.id,
    accountId: r.account_id,
    projectId: r.project_id,
    kind: r.kind,
    shape: r.shape,
    targetSession: r.target_session,
    workdir: r.workdir,
    prompt: r.prompt,
    // Pre-upgrade rows have no column at all; `?? null` normalizes both the
    // missing-column undefined and a stored NULL to the same "use default".
    provider: r.provider ?? null,
    model: r.model ?? null,
    status: r.status,
    attempts: r.attempts,
    failureLimit: r.failure_limit,
    claimOwner: r.claim_owner,
    claimedAt: r.claimed_at,
    notBefore: r.not_before,
    workerSessionId: r.worker_session_id,
    resultDigest: r.result_digest,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Store {
  #db: Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    // Under WAL the default is synchronous=FULL, which fsyncs the WAL on every
    // commit. audit() is a synchronous write on the hot path (fires per tool
    // call / attach / send), so FULL stalls the event loop. NORMAL only syncs
    // at checkpoints — safe under WAL (worst case loses the last few committed
    // txns on OS crash, never corruption). Matches the memory store.
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  /** The underlying connection — shared with sibling stores in the same daemon
   *  (e.g. the pipeline store) so they don't open a second handle to the file. */
  get database(): Database {
    return this.#db;
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        workdir     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'idle',
        created_by  TEXT NOT NULL,
        account_id  TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Rotation columns added post-launch. Use additive ALTER below.
    `);

    // Additive columns — SQLite ALTER TABLE ADD COLUMN is idempotent-ish
    // only via catch; use PRAGMA table_info to be deterministic.
    this.#addColumnIfMissing("sessions", "claude_code_session_id", "TEXT");
    this.#addColumnIfMissing("sessions", "rotation_count", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("sessions", "last_rotated_at", "INTEGER");
    // Model selection — persisted so /model choice survives daemon restart.
    this.#addColumnIfMissing("sessions", "model", "TEXT");
    this.#addColumnIfMissing("sessions", "fallback_model", "TEXT");
    // Session role ("conductor") + backing provider id — persisted so the
    // conductor keeps its role and every session keeps its provider across
    // daemon restarts. NULL = normal session / claude (pre-upgrade rows).
    this.#addColumnIfMissing("sessions", "role", "TEXT");
    this.#addColumnIfMissing("sessions", "provider", "TEXT");
    // Collaborative sessions (docs/collaborative-session-design.md §9): the
    // goal + role→backend bindings, as a JSON blob. NULL = a normal session.
    // The resume path reads transcript meta, not this column; it exists so a
    // collaboration is visible to anything querying the sessions table
    // directly (audit, future admin surfaces) rather than only via meta.
    this.#addColumnIfMissing("sessions", "collaboration", "TEXT");

    this.#db.exec(`

      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
        subject     TEXT NOT NULL,
        session_id  TEXT,
        action      TEXT NOT NULL,
        detail      TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, project_id);

      CREATE TABLE IF NOT EXISTS session_pins (
        session_id  TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        pinned_at   INTEGER NOT NULL,
        PRIMARY KEY (session_id, file_path),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_pins_session ON session_pins(session_id);

      -- Last live model catalog per provider (claude, gemini, openai, ...),
      -- as reported by that provider's backend. Served as the models.list
      -- fallback on boots where no session has run a turn yet, so the picker
      -- shows current model names instead of a baked-in list that goes stale
      -- between codeoid releases.
      CREATE TABLE IF NOT EXISTS provider_model_catalogs (
        provider_id TEXT PRIMARY KEY,
        models_json TEXT NOT NULL,
        cached_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Durable conductor identity (design R2): one row per tenant, reloaded
      -- on daemon restart so the conductor keeps a stable WIMSE URI across
      -- process lifetimes. api_key is the ONE credential at rest — the
      -- conductor's working token is re-minted per boot by owner delegation,
      -- and its actor keypair never touches disk.
      CREATE TABLE IF NOT EXISTS conductor_identity (
        account_id  TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        wimse_uri   TEXT NOT NULL,
        api_key     TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, project_id)
      );

      -- Human decisions on the shell substitutions a skill declares (#233).
      -- These run at slash-command EXPANSION time, before the agent loop, so
      -- they can never reach the canUseTool gate — the only way a human gets a
      -- say is to decide them ahead of the turn and persist it here.
      --
      -- Keyed by the VERBATIM command: editing a skill changes the key, so a
      -- modified command is re-asked rather than inheriting the old verdict.
      -- Denials are retained (allowed = 0) so a "no" is not re-prompted on
      -- every turn.
      CREATE TABLE IF NOT EXISTS skill_command_grants (
        workspace_id TEXT NOT NULL,
        command      TEXT NOT NULL,
        allowed      INTEGER NOT NULL,
        decided_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, command)
      );

      -- Durable dispatch work queue (P4, hermes-Kanban pattern). Tasks are
      -- the source of truth for send-class fleet actions: the queue — not
      -- the conductor's turn — owns their lifecycle, so a spawned worker
      -- survives a daemon restart. claim_owner is the daemon BOOT id: any
      -- claim held by a different boot is a crashed run and gets reclaimed
      -- (attempts++ — the reclaim counter doubles as the stuck-loop guard,
      -- auto-blocking at failure_limit).
      CREATE TABLE IF NOT EXISTS dispatch_tasks (
        id                TEXT PRIMARY KEY,
        account_id        TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        kind              TEXT NOT NULL,             -- 'send' | 'spawn'
        shape             TEXT NOT NULL,             -- 'ship' | 'scout'
        target_session    TEXT,                      -- send: existing session id
        workdir           TEXT,                      -- spawn: worker workdir
        prompt            TEXT NOT NULL,
        provider          TEXT,                      -- spawn: per-child backend id; NULL = daemon default
        model             TEXT,                      -- spawn: per-child model, resolved against the provider above
        status            TEXT NOT NULL DEFAULT 'queued',
        attempts          INTEGER NOT NULL DEFAULT 0,
        failure_limit     INTEGER NOT NULL DEFAULT 2,
        claim_owner       TEXT,                      -- daemon boot id
        claimed_at        INTEGER,
        not_before        INTEGER,                   -- retry backoff gate (claim skips rows still cooling down)
        worker_session_id TEXT,                      -- spawn: created worker
        result_digest     TEXT,
        error             TEXT,
        created_by        TEXT NOT NULL,             -- conductor WIMSE URI / sub
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_status
        ON dispatch_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_dispatch_tenant
        ON dispatch_tasks(account_id, project_id, created_at DESC);

      -- Durable conductor notifications (task completions/failures). An event
      -- survives a crash between "worker finished" and "conductor saw it";
      -- delivery marks delivered_at. Batched into ONE injected conductor turn
      -- per delivery (burst-collapse).
      CREATE TABLE IF NOT EXISTS dispatch_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT NOT NULL,
        project_id   TEXT NOT NULL,
        task_id      TEXT NOT NULL,
        type         TEXT NOT NULL,                  -- 'task_done' | 'task_failed' | 'task_blocked'
        digest       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_events_pending
        ON dispatch_events(account_id, project_id, delivered_at);
    `);

    // Per-child backend selection on spawn tasks. Additive so a database
    // written before collaborative sessions keeps its queued tasks: NULL on
    // an existing row means "daemon default provider", which is exactly the
    // pre-upgrade behaviour. Declared inline on the CREATE above for fresh
    // databases; this ALTER covers the ones already on disk.
    this.#addColumnIfMissing("dispatch_tasks", "provider", "TEXT");
    this.#addColumnIfMissing("dispatch_tasks", "model", "TEXT");

    // Pre-release single-row predecessor of provider_model_catalogs — never
    // shipped in a tagged version; drop from dev databases that ran the branch.
    this.#db.exec("DROP TABLE IF EXISTS cached_model_catalog");
  }

  /**
   * Idempotent column-adder — skips when the column already exists. SQLite
   * lacks `ADD COLUMN IF NOT EXISTS`, so we check PRAGMA first.
   */
  #addColumnIfMissing(table: string, column: string, ddl: string): void {
    const cols = this.#db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ── Pinned attachments ────────────────────────────────────────────────

  pinFile(sessionId: string, filePath: string): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO session_pins (session_id, file_path, pinned_at)
         VALUES (?, ?, ?)`,
      )
      .run(sessionId, filePath, Date.now());
  }

  unpinFile(sessionId: string, filePath: string): void {
    this.#db
      .prepare("DELETE FROM session_pins WHERE session_id = ? AND file_path = ?")
      .run(sessionId, filePath);
  }

  listPins(sessionId: string): string[] {
    const rows = this.#db
      .prepare(
        "SELECT file_path FROM session_pins WHERE session_id = ? ORDER BY pinned_at ASC",
      )
      .all(sessionId) as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  createSession(session: SessionInfo & { accountId: string; projectId: string }): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, name, workdir, status, created_by, account_id, project_id, created_at, role, provider, collaboration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.name,
        session.workdir,
        session.status,
        session.createdBy,
        session.accountId,
        session.projectId,
        session.createdAt,
        session.role ?? null,
        session.providerId ?? null,
        session.collaboration ? JSON.stringify(session.collaboration) : null,
      );
  }

  /**
   * Every persisted session's tenant + workdir, across ALL tenants. Used only
   * by the one-time memory workspace-id migration, which needs to re-key
   * episodes to their owning session's tenant regardless of who's connected.
   */
  listAllSessionsForMigration(): Array<{
    id: string;
    workdir: string;
    accountId: string;
    projectId: string;
  }> {
    return this.#db
      .prepare(
        "SELECT id, workdir, account_id AS accountId, project_id AS projectId FROM sessions",
      )
      .all() as Array<{
        id: string;
        workdir: string;
        accountId: string;
        projectId: string;
      }>;
  }

  listSessions(accountId: string, projectId: string): SessionInfo[] {
    const rows = this.#db
      .prepare("SELECT * FROM sessions WHERE account_id = ? AND project_id = ?")
      .all(accountId, projectId) as Array<{
        id: string;
        name: string;
        workdir: string;
        status: string;
        created_by: string;
        created_at: string;
      }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      workdir: r.workdir,
      status: r.status as SessionStatus,
      createdBy: r.created_by,
      createdAt: r.created_at,
      attachedClients: 0,
    }));
  }

  getSession(id: string): SessionInfo | undefined {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as {
        id: string;
        name: string;
        workdir: string;
        status: string;
        created_by: string;
        created_at: string;
      } | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      name: row.name,
      workdir: row.workdir,
      status: row.status as SessionStatus,
      createdBy: row.created_by,
      createdAt: row.created_at,
      attachedClients: 0,
    };
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    this.#db
      .prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }

  /**
   * Claude Code backing session id — separate from codeoid's stable
   * session.id so we can rotate the underlying context without breaking
   * user-facing identifiers.
   */
  getClaudeCodeSessionId(id: string): string | null {
    const row = this.#db
      .prepare("SELECT claude_code_session_id AS cc FROM sessions WHERE id = ?")
      .get(id) as { cc: string | null } | undefined;
    return row?.cc ?? null;
  }

  setClaudeCodeSessionId(
    id: string,
    backingId: string,
    rotationDelta = 0,
    rotatedAt?: number,
  ): void {
    this.#db
      .prepare(
        `UPDATE sessions SET
           claude_code_session_id = ?,
           rotation_count = rotation_count + ?,
           last_rotated_at = COALESCE(?, last_rotated_at),
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(backingId, rotationDelta, rotatedAt ?? null, id);
  }

  /**
   * Get the persisted model selection for a session. Either field may be
   * null if never set — caller falls back to config defaults.
   */
  getSessionModel(id: string): { model: string | null; fallbackModel: string | null } {
    const row = this.#db
      .prepare(
        "SELECT model AS m, fallback_model AS f FROM sessions WHERE id = ?",
      )
      .get(id) as { m: string | null; f: string | null } | undefined;
    return { model: row?.m ?? null, fallbackModel: row?.f ?? null };
  }

  /**
   * Set the model selection for a session. Passing `null` for either field
   * clears it (next lookup will return null). Caller is responsible for
   * validating the id before calling — Store doesn't gatekeep strings.
   */
  setSessionModel(
    id: string,
    model: string | null,
    fallbackModel: string | null | undefined = undefined,
  ): void {
    if (fallbackModel === undefined) {
      // Only update primary model; leave fallback untouched.
      this.#db
        .prepare(
          `UPDATE sessions SET model = ?, updated_at = datetime('now') WHERE id = ?`,
        )
        .run(model, id);
      return;
    }
    this.#db
      .prepare(
        `UPDATE sessions SET model = ?, fallback_model = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(model, fallbackModel, id);
  }

  /** Rotation counters for a session (for UI display + diagnostics). */
  getRotationStats(id: string): { count: number; lastRotatedAt: number | null } {
    const row = this.#db
      .prepare(
        `SELECT rotation_count AS c, last_rotated_at AS t
         FROM sessions WHERE id = ?`,
      )
      .get(id) as { c: number | null; t: number | null } | undefined;
    return {
      count: row?.c ?? 0,
      lastRotatedAt: row?.t ?? null,
    };
  }

  deleteSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ── Conductor identity ────────────────────────────────────────────────

  saveConductorIdentity(row: {
    accountId: string;
    projectId: string;
    identityId: string;
    wimseUri: string;
    apiKey: string;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO conductor_identity (account_id, project_id, identity_id, wimse_uri, api_key)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, project_id) DO UPDATE SET
           identity_id = excluded.identity_id,
           wimse_uri = excluded.wimse_uri,
           api_key = excluded.api_key,
           updated_at = datetime('now')`,
      )
      .run(row.accountId, row.projectId, row.identityId, row.wimseUri, row.apiKey);
  }

  getConductorIdentity(
    accountId: string,
    projectId: string,
  ): { identityId: string; wimseUri: string; apiKey: string } | null {
    const row = this.#db
      .prepare(
        `SELECT identity_id AS identityId, wimse_uri AS wimseUri, api_key AS apiKey
         FROM conductor_identity WHERE account_id = ? AND project_id = ?`,
      )
      .get(accountId, projectId) as
      | { identityId: string; wimseUri: string; apiKey: string }
      | null;
    return row ?? null;
  }

  /** Commands with a persisted verdict, as command → allowed (#233). */
  getSkillCommandGrants(workspaceId: string): Map<string, boolean> {
    const rows = this.#db
      .prepare(
        "SELECT command, allowed FROM skill_command_grants WHERE workspace_id = ?",
      )
      .all(workspaceId) as Array<{ command: string; allowed: number }>;
    return new Map(rows.map((r) => [r.command, r.allowed === 1]));
  }

  /** Record a human verdict on one skill-declared command (#233). */
  setSkillCommandGrant(
    workspaceId: string,
    command: string,
    allowed: boolean,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO skill_command_grants (workspace_id, command, allowed)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, command)
         DO UPDATE SET allowed = excluded.allowed, decided_at = datetime('now')`,
      )
      .run(workspaceId, command, allowed ? 1 : 0);
  }

  deleteConductorIdentity(accountId: string, projectId: string): void {
    this.#db
      .prepare(
        "DELETE FROM conductor_identity WHERE account_id = ? AND project_id = ?",
      )
      .run(accountId, projectId);
  }

  // ── Dispatch queue (P4) ───────────────────────────────────────────────

  dispatchEnqueue(task: {
    id: string;
    accountId: string;
    projectId: string;
    kind: "send" | "spawn";
    shape: "ship" | "scout";
    targetSession?: string;
    workdir?: string;
    prompt: string;
    /** Per-child backend for a spawn task; omit for the daemon default. */
    provider?: string;
    /** Per-child model, already resolved against `provider`. */
    model?: string;
    failureLimit: number;
    createdBy: string;
    now: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO dispatch_tasks
           (id, account_id, project_id, kind, shape, target_session, workdir,
            prompt, provider, model, failure_limit, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.accountId,
        task.projectId,
        task.kind,
        task.shape,
        task.targetSession ?? null,
        task.workdir ?? null,
        task.prompt,
        task.provider ?? null,
        task.model ?? null,
        task.failureLimit,
        task.createdBy,
        task.now,
        task.now,
      );
  }

  /**
   * Atomically claim the oldest queued task for this boot. A single UPDATE
   * with a scalar subquery — SQLite executes it under one write lock, so two
   * concurrent claimers can never take the same task. `excludeIds` lets the
   * dispatcher skip tasks it already touched this tick (cap deferrals,
   * failed retries) WITHOUT global head-of-line blocking: only the specific
   * deferred tasks are skipped, so neither sends nor other tenants' spawns
   * are starved by one capped tenant.
   */
  dispatchClaimNext(
    bootId: string,
    now: number,
    excludeIds: readonly string[] = [],
  ): DispatchTaskRow | null {
    const row = this.#db
      .prepare(
        `UPDATE dispatch_tasks
         SET status = 'claimed', claim_owner = ?, claimed_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM dispatch_tasks
           WHERE status = 'queued'
             AND (not_before IS NULL OR not_before <= ?)
             AND id NOT IN (SELECT value FROM json_each(?))
           ORDER BY created_at LIMIT 1
         )
         RETURNING *`,
      )
      .get(bootId, now, now, now, JSON.stringify(excludeIds)) as RawDispatchRow | null;
    return row ? rowToDispatchTask(row) : null;
  }

  /** Transition a claimed task to running (worker session known, if spawn). */
  dispatchMarkRunning(id: string, workerSessionId: string | null, now: number): void {
    this.#db
      .prepare(
        `UPDATE dispatch_tasks
         SET status = 'running', worker_session_id = COALESCE(?, worker_session_id), updated_at = ?
         WHERE id = ?`,
      )
      .run(workerSessionId, now, id);
  }

  /** Renew the lease on tasks whose workers are verifiably still alive. */
  dispatchTouch(ids: string[], now: number): void {
    if (ids.length === 0) return;
    const stmt = this.#db.prepare(
      "UPDATE dispatch_tasks SET claimed_at = ? WHERE id = ?",
    );
    // One transaction: the batch is atomic (all-or-nothing) and commits once.
    this.#db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    })();
  }

  dispatchComplete(id: string, digest: string, now: number): void {
    this.#db
      .prepare(
        `UPDATE dispatch_tasks
         SET status = 'done', result_digest = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(digest, now, id);
  }

  /**
   * Record a failure. Retryable failures re-queue until `failure_limit`
   * attempts, then auto-block (hermes anti-spin); non-retryable ones (target
   * gone, invalid input) go terminal immediately. Returns the final status.
   */
  dispatchFail(
    id: string,
    error: string,
    now: number,
    opts: { retryable: boolean; notBefore?: number },
  ): "queued" | "blocked" | "failed" | null {
    const row = this.#db
      .prepare(
        opts.retryable
          ? `UPDATE dispatch_tasks
             SET attempts = attempts + 1,
                 status = CASE WHEN attempts + 1 >= failure_limit THEN 'blocked' ELSE 'queued' END,
                 claim_owner = NULL, claimed_at = NULL, not_before = ?, error = ?, updated_at = ?
             WHERE id = ?
             RETURNING status`
          : `UPDATE dispatch_tasks
             SET attempts = attempts + 1, status = 'failed',
                 claim_owner = NULL, claimed_at = NULL, error = ?, updated_at = ?
             WHERE id = ?
             RETURNING status`,
      )
      .get(
        ...(opts.retryable
          ? [opts.notBefore ?? null, error, now, id]
          : [error, now, id]),
      ) as { status: "queued" | "blocked" | "failed" } | null;
    return row?.status ?? null;
  }

  /**
   * Reclaim tasks whose claim is dead: held by another boot (daemon crashed)
   * or past the lease (worker hung and the dispatcher stopped renewing).
   * Every reclaim costs an attempt — a worker that keeps dying across
   * restarts burns through failure_limit and lands in 'blocked': the
   * stuck-loop escalation, in queue form. worker_session_id is preserved so
   * a re-claimed spawn can continue its (resumed) worker session.
   */
  dispatchReclaimStale(bootId: string, leaseMs: number, now: number): DispatchTaskRow[] {
    const rows = this.#db
      .prepare(
        `UPDATE dispatch_tasks
         SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= failure_limit THEN 'blocked' ELSE 'queued' END,
             claim_owner = NULL, claimed_at = NULL,
             error = COALESCE(error, 'reclaimed: stale claim'), updated_at = ?
         WHERE status IN ('claimed', 'running')
           AND (claim_owner IS NOT ? OR claimed_at IS NULL OR claimed_at + ? < ?)
         RETURNING *`,
      )
      .all(now, bootId, leaseMs, now) as RawDispatchRow[];
    return rows.map(rowToDispatchTask);
  }

  /**
   * Return a claimed task to the queue untouched — a scheduling deferral
   * (e.g. worker cap reached), NOT a failure: attempts and error stay as
   * they were.
   */
  dispatchRelease(id: string, now: number): void {
    this.#db
      .prepare(
        `UPDATE dispatch_tasks
         SET status = 'queued', claim_owner = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(now, id);
  }

  dispatchGet(id: string): DispatchTaskRow | null {
    const row = this.#db
      .prepare("SELECT * FROM dispatch_tasks WHERE id = ?")
      .get(id) as RawDispatchRow | null;
    return row ? rowToDispatchTask(row) : null;
  }

  dispatchListForTenant(
    accountId: string,
    projectId: string,
    limit = 30,
  ): DispatchTaskRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM dispatch_tasks
         WHERE account_id = ? AND project_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(accountId, projectId, limit) as RawDispatchRow[];
    return rows.map(rowToDispatchTask);
  }

  /** Count of live (claimed/running) spawn tasks — the concurrency-cap read. */
  dispatchActiveSpawnCount(accountId: string, projectId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM dispatch_tasks
         WHERE account_id = ? AND project_id = ?
           AND kind = 'spawn' AND status IN ('claimed', 'running')`,
      )
      .get(accountId, projectId) as { n: number };
    return row.n;
  }

  // ── Dispatch events (durable conductor notifications) ────────────────

  dispatchEventAdd(event: {
    accountId: string;
    projectId: string;
    taskId: string;
    type: "task_done" | "task_failed" | "task_blocked";
    digest: string;
    now: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO dispatch_events (account_id, project_id, task_id, type, digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.accountId, event.projectId, event.taskId, event.type, event.digest, event.now);
  }

  dispatchEventsPending(accountId: string, projectId: string): DispatchEventRow[] {
    return this.#db
      .prepare(
        `SELECT id, account_id AS accountId, project_id AS projectId, task_id AS taskId,
                type, digest, created_at AS createdAt
         FROM dispatch_events
         WHERE account_id = ? AND project_id = ? AND delivered_at IS NULL
         ORDER BY id ASC`,
      )
      .all(accountId, projectId) as DispatchEventRow[];
  }

  dispatchEventsMarkDelivered(ids: number[], now: number): void {
    if (ids.length === 0) return;
    const stmt = this.#db.prepare(
      "UPDATE dispatch_events SET delivered_at = ? WHERE id = ?",
    );
    // Atomic batch: a partial mark-delivered would re-surface some events to the
    // conductor as duplicate notifications (the design promises one batched turn).
    this.#db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    })();
  }

  /** Tenants that have undelivered events — the delivery pump's work list. */
  dispatchEventTenants(): Array<{ accountId: string; projectId: string }> {
    return this.#db
      .prepare(
        `SELECT DISTINCT account_id AS accountId, project_id AS projectId
         FROM dispatch_events WHERE delivered_at IS NULL`,
      )
      .all() as Array<{ accountId: string; projectId: string }>;
  }

  // ── Model catalog cache ───────────────────────────────────────────────

  /**
   * Persist the live model catalog a provider's backend reported. One row
   * per provider id — the latest report wins across daemon lifetimes.
   */
  saveModelCatalog(providerId: string, models: readonly ModelInfo[]): void {
    this.#db
      .prepare(
        `INSERT INTO provider_model_catalogs (provider_id, models_json, cached_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(provider_id) DO UPDATE SET
           models_json = excluded.models_json,
           cached_at = excluded.cached_at`,
      )
      .run(providerId, JSON.stringify(models));
  }

  /**
   * The last persisted live model catalog for a provider, or null when that
   * provider has never reported one (first-ever boot) or the stored JSON is
   * unreadable.
   */
  getModelCatalog(providerId: string): ModelInfo[] | null {
    const row = this.#db
      .prepare("SELECT models_json FROM provider_model_catalogs WHERE provider_id = ?")
      .get(providerId) as { models_json: string } | null;
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.models_json);
      if (!Array.isArray(parsed)) return null;
      // Structural validation — a row written by a future/older version with
      // a different shape degrades to the next fallback tier instead of
      // serving malformed entries to pickers.
      const valid = parsed.filter(
        (m): m is ModelInfo =>
          !!m &&
          typeof m === "object" &&
          typeof (m as ModelInfo).value === "string" &&
          typeof (m as ModelInfo).displayName === "string",
      );
      return valid.length > 0 ? valid : null;
    } catch {
      return null;
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────────

  audit(subject: string, action: string, sessionId?: string, detail?: string): void {
    // An audit write must NEVER crash the daemon. The session_id FK can fail
    // when the referenced session is no longer in the sessions table — e.g. a
    // client disconnect audited after the session was destroyed, or a resumed
    // session whose row isn't present. That used to throw out of a sync WS
    // close handler → uncaughtException → full daemon shutdown.
    try {
      this.#db
        .prepare(
          "INSERT INTO audit_log (subject, session_id, action, detail) VALUES (?, ?, ?, ?)",
        )
        .run(subject, sessionId ?? null, action, detail ?? null);
    } catch {
      // Retry unlinked (FK can't fail) so the entry is still recorded; fold
      // the orphaned session id into the detail. Swallow anything further.
      try {
        const d = sessionId ? `${detail ?? ""} [session=${sessionId}]`.trim() : detail ?? null;
        this.#db
          .prepare(
            "INSERT INTO audit_log (subject, session_id, action, detail) VALUES (?, NULL, ?, ?)",
          )
          .run(subject, action, d);
      } catch (err) {
        console.error(
          `[codeoid/store] audit write failed (swallowed): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  close(): void {
    this.#db.close();
  }
}
