/**
 * Durable evidence records. Shares the daemon's SQLite connection (or opens its
 * own in tests) and migrates with the same `CREATE TABLE IF NOT EXISTS`
 * convention as the routine and pipeline stores.
 *
 * Records are append-only: evidence describes what happened, so it is never
 * edited. Excerpts are bounded by the runner; the full output lives in artifact
 * files whose path, size, and hash are recorded here.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { BUSY_TIMEOUT_MS } from "../store.js";
import type {
  EvidenceArtifact,
  EvidenceEnvironment,
  EvidenceIsolation,
  EvidenceOwnerKind,
  EvidenceRecord,
  EvidenceResult,
} from "./types.js";

interface EvidenceDbRow {
  id: string;
  account_id: string;
  project_id: string;
  owner_kind: string;
  owner_id: string;
  criterion_id: string;
  candidate_digest: string | null;
  verifier_digest: string;
  environment_json: string;
  isolation: string;
  command: string;
  result: string;
  reason: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  started_at: number;
  ended_at: number;
  stdout_excerpt: string;
  stderr_excerpt: string;
  artifacts_json: string;
}

export interface EvidenceTenant {
  accountId: string;
  projectId: string;
}

export class EvidenceStore {
  readonly #db: Database;

  constructor(db: Database | string) {
    this.#db = typeof db === "string" ? new Database(db, { create: true }) : db;
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        id                TEXT PRIMARY KEY,
        account_id        TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        owner_kind        TEXT NOT NULL,
        owner_id          TEXT NOT NULL,
        criterion_id      TEXT NOT NULL,
        candidate_digest  TEXT,
        verifier_digest   TEXT NOT NULL,
        environment_json  TEXT NOT NULL,
        isolation         TEXT NOT NULL,
        command           TEXT NOT NULL,
        result            TEXT NOT NULL,
        reason            TEXT NOT NULL,
        exit_code         INTEGER,
        signal            TEXT,
        timed_out         INTEGER NOT NULL DEFAULT 0,
        started_at        INTEGER NOT NULL,
        ended_at          INTEGER NOT NULL,
        stdout_excerpt    TEXT NOT NULL,
        stderr_excerpt    TEXT NOT NULL,
        artifacts_json    TEXT NOT NULL,
        artifact_dir      TEXT,
        artifact_bytes    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_owner
        ON evidence(owner_kind, owner_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_started ON evidence(started_at);
    `);
  }

  /** Persist a record and return it with its id. */
  insert(record: Omit<EvidenceRecord, "id">): EvidenceRecord {
    const id = `ev_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO evidence (
           id, account_id, project_id, owner_kind, owner_id, criterion_id,
           candidate_digest, verifier_digest, environment_json, isolation, command,
           result, reason, exit_code, signal, timed_out, started_at, ended_at,
           stdout_excerpt, stderr_excerpt, artifacts_json, artifact_dir, artifact_bytes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.accountId,
        record.projectId,
        record.ownerKind,
        record.ownerId,
        record.criterionId,
        record.candidateDigest,
        record.verifierDigest,
        JSON.stringify(record.environment),
        record.isolation,
        record.command,
        record.result,
        record.reason,
        record.exitCode,
        record.signal,
        record.timedOut ? 1 : 0,
        record.startedAt,
        record.endedAt,
        record.stdoutExcerpt,
        record.stderrExcerpt,
        JSON.stringify(record.artifacts),
        record.artifacts[0] ? dirname(record.artifacts[0].path) : null,
        record.artifacts.reduce((n, a) => n + a.bytes, 0),
      );
    return { ...record, id };
  }

  /** A record, only if it belongs to `tenant`. Unknown and foreign ids are the
   *  same `null`, so an id from another tenant reveals nothing. */
  get(id: string, tenant: EvidenceTenant): EvidenceRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM evidence WHERE id = ? AND account_id = ? AND project_id = ?")
      .get(id, tenant.accountId, tenant.projectId) as EvidenceDbRow | null;
    return row ? toRecord(row) : null;
  }

  // ── Retention (EvidenceService.sweep) ─────────────────────────────────

  idsStartedBefore(cutoff: number): string[] {
    return (this.#db.prepare("SELECT id FROM evidence WHERE started_at < ?").all(cutoff) as Array<{ id: string }>).map(
      (r) => r.id,
    );
  }

  artifactSizesNewestFirst(): Array<{ id: string; bytes: number }> {
    return this.#db
      .prepare("SELECT id, artifact_bytes AS bytes FROM evidence ORDER BY started_at DESC, rowid DESC")
      .all() as Array<{ id: string; bytes: number }>;
  }

  artifactDirsFor(ids: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.#db
        .prepare(`SELECT artifact_dir AS d FROM evidence WHERE id IN (${chunk.map(() => "?").join(",")}) AND artifact_dir IS NOT NULL`)
        .all(...chunk) as Array<{ d: string }>;
      out.push(...rows.map((r) => r.d));
    }
    return out;
  }

  allArtifactDirs(): string[] {
    return (
      this.#db.prepare("SELECT artifact_dir AS d FROM evidence WHERE artifact_dir IS NOT NULL").all() as Array<{ d: string }>
    ).map((r) => r.d);
  }

  deleteIds(ids: string[]): void {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      this.#db.prepare(`DELETE FROM evidence WHERE id IN (${chunk.map(() => "?").join(",")})`).run(...chunk);
    }
  }

  /** Every record for one owner, oldest first. */
  listForOwner(ownerKind: EvidenceOwnerKind, ownerId: string, tenant: EvidenceTenant): EvidenceRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM evidence
           WHERE owner_kind = ? AND owner_id = ? AND account_id = ? AND project_id = ?
           ORDER BY started_at, rowid`,
        )
        .all(ownerKind, ownerId, tenant.accountId, tenant.projectId) as EvidenceDbRow[]
    ).map(toRecord);
  }
}

function toRecord(row: EvidenceDbRow): EvidenceRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    projectId: row.project_id,
    ownerKind: row.owner_kind as EvidenceOwnerKind,
    ownerId: row.owner_id,
    criterionId: row.criterion_id,
    candidateDigest: row.candidate_digest,
    verifierDigest: row.verifier_digest,
    environment: JSON.parse(row.environment_json) as EvidenceEnvironment,
    isolation: row.isolation as EvidenceIsolation,
    command: row.command,
    result: row.result as EvidenceResult,
    reason: row.reason,
    exitCode: row.exit_code,
    signal: row.signal,
    timedOut: row.timed_out === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    stdoutExcerpt: row.stdout_excerpt,
    stderrExcerpt: row.stderr_excerpt,
    artifacts: JSON.parse(row.artifacts_json) as EvidenceArtifact[],
  };
}
