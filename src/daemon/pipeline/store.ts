/**
 * Durable pipeline state (§5.2). One row per pipeline; the full `PipelineState`
 * is the source of truth in `state_json`, with scalar columns denormalized for
 * cheap tenant / status queries. Mirrors the daemon Store's bun:sqlite +
 * `CREATE TABLE IF NOT EXISTS` conventions; accepts an existing `Database` so it
 * can share the daemon's DB file (or a `:memory:` handle in tests).
 */

import { Database } from "bun:sqlite";
import type { PipelineState } from "./interface";
import { ACTIVE_STATUSES } from "./interface";
import { BUSY_TIMEOUT_MS } from "../store.js";

export class PipelineStore {
  #db: Database;

  constructor(db: Database | string) {
    this.#db = typeof db === "string" ? new Database(db, { create: true }) : db;
    // Before any lock-taking statement — SQLite's default is fail-instantly.
    // See BUSY_TIMEOUT_MS in ../store.ts. Harmless when `db` is the daemon's
    // shared connection (which already set it); required when it's our own.
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        account_id  TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'draft',
        cursor      INTEGER NOT NULL DEFAULT 0,
        spec        TEXT,
        state_json  TEXT NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pipelines_tenant
        ON pipelines(account_id, project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pipelines_status
        ON pipelines(status, updated_at);
    `);
  }

  /** Upsert the full pipeline state. */
  save(state: PipelineState): void {
    this.#db
      .prepare(
        `INSERT INTO pipelines
           (id, name, account_id, project_id, status, cursor, spec, state_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           status     = excluded.status,
           cursor     = excluded.cursor,
           spec       = excluded.spec,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.id,
        state.name,
        state.accountId,
        state.projectId,
        state.status,
        state.cursor,
        state.spec ?? null,
        JSON.stringify(state),
        state.createdBy,
        state.createdAt,
        state.updatedAt,
      );
  }

  get(id: string): PipelineState | undefined {
    const row = this.#db.prepare("SELECT id, state_json FROM pipelines WHERE id = ?").get(id) as
      | { id: string; state_json: string }
      | undefined;
    return row ? parseRow(row) : undefined;
  }

  /** Tenant-scoped list, newest first. */
  listByTenant(accountId: string, projectId: string): PipelineState[] {
    const rows = this.#db
      .prepare(
        "SELECT id, state_json FROM pipelines WHERE account_id = ? AND project_id = ? ORDER BY created_at DESC",
      )
      .all(accountId, projectId) as Array<{ id: string; state_json: string }>;
    return rows.map(parseRow).filter((s): s is PipelineState => s !== undefined);
  }

  /** Non-terminal pipelines — the set a fresh daemon rehydrates on boot. A
   *  positive `status IN (…)` (vs `NOT IN`) so idx_pipelines_status is usable;
   *  placeholders derived from ACTIVE_STATUSES so the set stays single-sourced. */
  listActive(): PipelineState[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(`SELECT id, state_json FROM pipelines WHERE status IN (${placeholders})`)
      .all(...ACTIVE_STATUSES) as Array<{ id: string; state_json: string }>;
    return rows.map(parseRow).filter((s): s is PipelineState => s !== undefined);
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM pipelines WHERE id = ?").run(id);
  }
}

/** Parse a persisted row, returning undefined (and logging) on corrupt JSON.
 *  A single bad row must NOT throw out of listActive() — that runs on every boot
 *  via resume(), so one unparseable/version-drifted row would sink rehydration
 *  of ALL pipelines rather than just itself (sibling stores skip+log likewise). */
function parseRow(row: { id: string; state_json: string }): PipelineState | undefined {
  try {
    return JSON.parse(row.state_json) as PipelineState;
  } catch (e) {
    console.error(`[pipeline] skipping unparseable pipeline row ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
