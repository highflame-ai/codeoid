/**
 * Durable storage for goal-blackboard artifacts
 * (docs/collaborative-session-design.md §4).
 *
 * Shares the daemon's SQLite connection rather than opening a second handle —
 * same contract as the pipeline store (`Store.database`).
 *
 * Two invariants this layer owns:
 *
 *  1. **Every query is tenant-scoped** on `account_id` AND `project_id`. A
 *     goal id alone is not a permission: reading by goal without the tenant
 *     would let one account's agent read another's artifacts if a session id
 *     ever leaked or collided.
 *  2. **Writes never overwrite.** A write appends version N+1, so the history
 *     of a handoff is intact and a reviewer's findings can't be silently
 *     replaced by a later run. Readers ask for "latest" explicitly.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Artifact, ArtifactIndexEntry } from "./types.js";

interface RawArtifactRow {
  id: string;
  goal_session_id: string;
  kind: string;
  slot: string | null;
  version: number;
  content: string;
  author_sub: string;
  author_role: string | null;
  created_at: number;
}

function toArtifact(r: RawArtifactRow): Artifact {
  return {
    id: r.id,
    goalSessionId: r.goal_session_id,
    kind: r.kind,
    slot: r.slot,
    version: r.version,
    content: r.content,
    authorSub: r.author_sub,
    authorRole: r.author_role,
    createdAt: r.created_at,
  };
}

/** Tenant + goal scope carried on every call — never derived from a client. */
export interface GoalScope {
  accountId: string;
  projectId: string;
  goalSessionId: string;
}

export class BlackboardStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_artifacts (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL,
        project_id      TEXT NOT NULL,
        -- Goal scope = the orchestrating parent session's id. Artifacts die
        -- with the goal, so this cascades on session delete.
        goal_session_id TEXT NOT NULL,
        kind            TEXT NOT NULL,           -- core kind | 'extra/<key>'
        slot            TEXT,                    -- multi-writer discriminator; NULL = singleton
        version         INTEGER NOT NULL,        -- 1-based, monotonic per (goal, kind, slot)
        content         TEXT NOT NULL,
        author_sub      TEXT NOT NULL,           -- producing ZeroID subject
        author_role     TEXT,                    -- collaboration role name
        created_at      INTEGER NOT NULL,
        -- Makes the append-only contract a storage guarantee, not a convention:
        -- a racing double-write on the same version fails loudly instead of one
        -- silently winning.
        UNIQUE (goal_session_id, kind, slot, version)
      );
      -- The read path is always (tenant, goal) then kind/slot, newest first.
      CREATE INDEX IF NOT EXISTS idx_artifacts_goal
        ON collaboration_artifacts(account_id, project_id, goal_session_id, kind, slot, version DESC);
    `);
  }

  /**
   * Append the next version of one artifact and return it.
   *
   * The read-max-then-insert pair runs inside an IMMEDIATE transaction so two
   * concurrent writers can't compute the same next version — one of them would
   * otherwise lose its write to the UNIQUE constraint. Children on different
   * backends genuinely do write concurrently, so this is a real race, not a
   * theoretical one.
   */
  append(input: {
    scope: GoalScope;
    kind: string;
    slot?: string | null;
    content: string;
    authorSub: string;
    authorRole?: string | null;
    now: number;
  }): Artifact {
    const slot = input.slot ?? null;
    const run = this.#db.transaction((): Artifact => {
      const row = this.#db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS v
             FROM collaboration_artifacts
            WHERE account_id = ? AND project_id = ? AND goal_session_id = ?
              AND kind = ? AND slot IS ?`,
        )
        .get(
          input.scope.accountId,
          input.scope.projectId,
          input.scope.goalSessionId,
          input.kind,
          slot,
        ) as { v: number };
      const version = row.v + 1;
      const id = randomUUID();
      this.#db
        .prepare(
          `INSERT INTO collaboration_artifacts
             (id, account_id, project_id, goal_session_id, kind, slot, version,
              content, author_sub, author_role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.scope.accountId,
          input.scope.projectId,
          input.scope.goalSessionId,
          input.kind,
          slot,
          version,
          input.content,
          input.authorSub,
          input.authorRole ?? null,
          input.now,
        );
      return {
        id,
        goalSessionId: input.scope.goalSessionId,
        kind: input.kind,
        slot,
        version,
        content: input.content,
        authorSub: input.authorSub,
        authorRole: input.authorRole ?? null,
        createdAt: input.now,
      };
    });
    // IMMEDIATE: take the write lock up front rather than upgrading mid-txn,
    // which under WAL is what produces SQLITE_BUSY between two writers.
    return run.immediate();
  }

  /** Latest version of one artifact, or null. */
  latest(scope: GoalScope, kind: string, slot?: string | null): Artifact | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM collaboration_artifacts
          WHERE account_id = ? AND project_id = ? AND goal_session_id = ?
            AND kind = ? AND slot IS ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(
        scope.accountId,
        scope.projectId,
        scope.goalSessionId,
        kind,
        slot ?? null,
      ) as RawArtifactRow | undefined;
    return row ? toArtifact(row) : null;
  }

  /** One specific version — for auditing a handoff after the fact. */
  version(
    scope: GoalScope,
    kind: string,
    version: number,
    slot?: string | null,
  ): Artifact | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM collaboration_artifacts
          WHERE account_id = ? AND project_id = ? AND goal_session_id = ?
            AND kind = ? AND slot IS ? AND version = ?`,
      )
      .get(
        scope.accountId,
        scope.projectId,
        scope.goalSessionId,
        kind,
        slot ?? null,
        version,
      ) as RawArtifactRow | undefined;
    return row ? toArtifact(row) : null;
  }

  /**
   * Every slot of one kind at its latest version — how a synthesizing
   * orchestrator collects all N reviewers' `findings` in one call.
   */
  latestAllSlots(scope: GoalScope, kind: string): Artifact[] {
    const rows = this.#db
      .prepare(
        `SELECT a.* FROM collaboration_artifacts a
           JOIN (
             SELECT slot, MAX(version) AS v
               FROM collaboration_artifacts
              WHERE account_id = ? AND project_id = ? AND goal_session_id = ? AND kind = ?
              GROUP BY slot
           ) m ON m.v = a.version AND m.slot IS a.slot
          WHERE a.account_id = ? AND a.project_id = ? AND a.goal_session_id = ? AND a.kind = ?
          ORDER BY a.slot IS NULL DESC, a.slot ASC`,
      )
      .all(
        scope.accountId,
        scope.projectId,
        scope.goalSessionId,
        kind,
        scope.accountId,
        scope.projectId,
        scope.goalSessionId,
        kind,
      ) as RawArtifactRow[];
    return rows.map(toArtifact);
  }

  /**
   * The index: what exists at what version, no bodies. `bytes` is computed in
   * SQL so a large artifact is never loaded just to report its size.
   */
  index(scope: GoalScope): ArtifactIndexEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT a.kind, a.slot, a.version, a.author_sub, a.author_role,
                a.created_at, LENGTH(a.content) AS bytes
           FROM collaboration_artifacts a
           JOIN (
             SELECT kind, slot, MAX(version) AS v
               FROM collaboration_artifacts
              WHERE account_id = ? AND project_id = ? AND goal_session_id = ?
              GROUP BY kind, slot
           ) m ON m.kind = a.kind AND m.slot IS a.slot AND m.v = a.version
          WHERE a.account_id = ? AND a.project_id = ? AND a.goal_session_id = ?
          ORDER BY a.kind ASC, a.slot IS NULL DESC, a.slot ASC`,
      )
      .all(
        scope.accountId,
        scope.projectId,
        scope.goalSessionId,
        scope.accountId,
        scope.projectId,
        scope.goalSessionId,
      ) as Array<{
        kind: string;
        slot: string | null;
        version: number;
        author_sub: string;
        author_role: string | null;
        created_at: number;
        bytes: number;
      }>;
    return rows.map((r) => ({
      kind: r.kind,
      slot: r.slot,
      version: r.version,
      authorSub: r.author_sub,
      authorRole: r.author_role,
      updatedAt: r.created_at,
      bytes: r.bytes,
    }));
  }

  /** Drop a goal's artifacts (goal end). Tenant-scoped like everything else. */
  deleteGoal(scope: GoalScope): number {
    return this.#db
      .prepare(
        `DELETE FROM collaboration_artifacts
          WHERE account_id = ? AND project_id = ? AND goal_session_id = ?`,
      )
      .run(scope.accountId, scope.projectId, scope.goalSessionId).changes;
  }
}
