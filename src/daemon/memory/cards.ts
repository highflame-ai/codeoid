/**
 * SessionCardStore — durable, addressable per-session digests ("cards") plus a
 * bi-temporal fact log for session state.
 *
 * This is the storage foundation for the conductor's session-resolution
 * capability (see docs/conductor-session-resolution.md):
 *
 *   - `session_cards` — one compact digest per session (repo, branch, task,
 *     state, open threads, entities) + an embedding of its fuzzy fields. A
 *     standalone FTS5 mirror gives keyword/identifier recall.
 *   - `facts` — bi-temporal state log (Zep/Graphiti pattern). State changes are
 *     recorded, never mutated in place: superseding a fact sets the prior fact's
 *     `invalid_at` (event time) + `expired_at` (system time) and inserts the new
 *     one. This yields free time-travel ("what was this session's state last
 *     Tuesday?") and a lossless audit trail.
 *
 * P0 scope: schema + CRUD + the bi-temporal primitive + FTS. Embedding
 * generation, cross-workspace hybrid recall, and rerank land in P1.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { BUSY_TIMEOUT_MS } from "../store.js";

export interface SessionCard {
  sessionId: string;
  workspaceId: string;
  repo?: string;
  branch?: string;
  /** NL description of what this session is doing — the primary fuzzy field. */
  task?: string;
  /** Current status descriptor (e.g. "WIP", "merged", "blocked"). */
  state?: string;
  lastAction?: string;
  /** Open threads of work, free-form strings. */
  openThreads: string[];
  /** Salient entities: files, symbols, ticket ids, branch names. */
  entities: string[];
  /** Embedding of the fuzzy fields (task + open threads). Filled in P1. */
  embedding?: Float32Array;
  embeddingModel?: string;
  createdAt: number;
  updatedAt: number;
}

/** A bi-temporal fact. `invalidAt`/`expiredAt` null means true-now / current-belief. */
export interface Fact {
  id: string;
  sessionId: string;
  subject: string;
  predicate: string;
  object: string;
  /** Event time: when the fact became true in the world. */
  validAt: number;
  /** Event time: when it stopped being true (null = still true). */
  invalidAt: number | null;
  /** System time: when we recorded it. */
  createdAt: number;
  /** System time: when we superseded our belief (null = current belief). */
  expiredAt: number | null;
}

interface CardRow {
  session_id: string;
  workspace_id: string;
  repo: string | null;
  branch: string | null;
  task: string | null;
  state: string | null;
  last_action: string | null;
  open_threads: string;
  entities: string;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  created_at: number;
  updated_at: number;
}

interface FactRow {
  id: string;
  session_id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_at: number;
  invalid_at: number | null;
  created_at: number;
  expired_at: number | null;
}

export class SessionCardStore {
  #db: Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { create: true });
    // Before any lock-taking statement — SQLite's default is fail-instantly.
    // See BUSY_TIMEOUT_MS in ../store.ts for why every writable store sets it.
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_cards (
        session_id      TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        repo            TEXT,
        branch          TEXT,
        task            TEXT,
        state           TEXT,
        last_action     TEXT,
        open_threads    TEXT NOT NULL DEFAULT '[]',
        entities        TEXT NOT NULL DEFAULT '[]',
        embedding       BLOB,
        embedding_model TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cards_workspace
        ON session_cards(workspace_id, updated_at DESC);

      -- Standalone FTS mirror (populated manually in upsertCard) so identifier
      -- and keyword recall over card text works without external-content triggers.
      CREATE VIRTUAL TABLE IF NOT EXISTS session_cards_fts USING fts5(
        session_id UNINDEXED,
        text
      );

      CREATE TABLE IF NOT EXISTS facts (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        subject      TEXT NOT NULL,
        predicate    TEXT NOT NULL,
        object       TEXT NOT NULL,
        valid_at     INTEGER NOT NULL,
        invalid_at   INTEGER,
        created_at   INTEGER NOT NULL,
        expired_at   INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_facts_subject_pred
        ON facts(subject, predicate, valid_at DESC);
      CREATE INDEX IF NOT EXISTS idx_facts_session
        ON facts(session_id, valid_at DESC);
    `);
  }

  // ── Cards ───────────────────────────────────────────────────────────────

  /** Insert or replace a card. Refreshes the FTS mirror row. */
  upsertCard(
    card: Omit<SessionCard, "createdAt" | "updatedAt"> & {
      createdAt?: number;
      updatedAt?: number;
    },
  ): SessionCard {
    const now = card.updatedAt ?? Date.now();
    const existing = this.getCard(card.sessionId);
    const createdAt = existing?.createdAt ?? card.createdAt ?? now;

    const embeddingBuf = card.embedding
      ? new Uint8Array(
          card.embedding.buffer,
          card.embedding.byteOffset,
          card.embedding.byteLength,
        )
      : null;

    // One transaction for the card row + its FTS mirror: a crash between the
    // two statements must not leave session_cards_fts drifted from
    // session_cards.
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO session_cards (
             session_id, workspace_id, repo, branch, task, state, last_action,
             open_threads, entities, embedding, embedding_model, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             repo = excluded.repo,
             branch = excluded.branch,
             task = excluded.task,
             state = excluded.state,
             last_action = excluded.last_action,
             open_threads = excluded.open_threads,
             entities = excluded.entities,
             embedding = excluded.embedding,
             embedding_model = excluded.embedding_model,
             updated_at = excluded.updated_at`,
        )
        .run(
          card.sessionId,
          card.workspaceId,
          card.repo ?? null,
          card.branch ?? null,
          card.task ?? null,
          card.state ?? null,
          card.lastAction ?? null,
          JSON.stringify(card.openThreads ?? []),
          JSON.stringify(card.entities ?? []),
          embeddingBuf,
          card.embeddingModel ?? null,
          createdAt,
          now,
        );

      // Refresh the FTS mirror: delete any prior row for this session, re-insert.
      this.#db
        .prepare("DELETE FROM session_cards_fts WHERE session_id = ?")
        .run(card.sessionId);
      this.#db
        .prepare("INSERT INTO session_cards_fts (session_id, text) VALUES (?, ?)")
        .run(card.sessionId, cardFtsText(card));
    })();

    return this.getCard(card.sessionId)!;
  }

  getCard(sessionId: string): SessionCard | null {
    const row = this.#db
      .prepare("SELECT * FROM session_cards WHERE session_id = ?")
      .get(sessionId) as CardRow | null;
    return row ? rowToCard(row) : null;
  }

  /** Most-recently-updated cards, optionally scoped to a workspace. */
  listCards(limit = 50, workspaceId?: string): SessionCard[] {
    const rows = workspaceId
      ? (this.#db
          .prepare(
            "SELECT * FROM session_cards WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?",
          )
          .all(workspaceId, limit) as CardRow[])
      : (this.#db
          .prepare("SELECT * FROM session_cards ORDER BY updated_at DESC LIMIT ?")
          .all(limit) as CardRow[]);
    return rows.map(rowToCard);
  }

  /** FTS keyword search over card text. Returns session ids + bm25 (lower = better). */
  ftsSearchCards(
    query: string,
    limit = 24,
  ): Array<{ sessionId: string; bm25: number }> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    return this.#db
      .prepare(
        `SELECT session_id AS sessionId, bm25(session_cards_fts) AS bm25
         FROM session_cards_fts
         WHERE session_cards_fts MATCH ?
         ORDER BY bm25
         LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{ sessionId: string; bm25: number }>;
  }

  // ── Bi-temporal facts ─────────────────────────────────────────────────────

  /**
   * Assert a fact, superseding any currently-open fact for the same
   * (subject, predicate) whose object differs. Invalidate-don't-delete: the
   * prior fact stays, with `invalid_at` (event time) set to the new fact's
   * `validAt` and `expired_at` (system time) set to now.
   *
   * Returns the newly-inserted fact (or the existing open fact when the object
   * is unchanged — no churn).
   */
  assertFact(input: {
    sessionId: string;
    subject: string;
    predicate: string;
    object: string;
    validAt?: number;
    now?: number;
  }): Fact {
    const now = input.now ?? Date.now();
    const validAt = input.validAt ?? now;

    // Lookup + supersede + insert commit atomically: a crash between the
    // close-out UPDATE and the INSERT must never leave (subject, predicate)
    // with no open fact.
    return this.#db.transaction((): Fact => {
      const open = this.#db
        .prepare(
          `SELECT * FROM facts
           WHERE subject = ? AND predicate = ? AND invalid_at IS NULL AND expired_at IS NULL
           ORDER BY valid_at DESC LIMIT 1`,
        )
        .get(input.subject, input.predicate) as FactRow | null;

      if (open && open.object === input.object) {
        return rowToFact(open); // unchanged — no new version
      }

      if (open) {
        // Closing the open fact with invalid_at < valid_at would make that
        // row unsatisfiable for every factsAsOf() query — the fact would
        // silently vanish from all time-travel reads. Reject out-of-order
        // assertions instead of corrupting the bi-temporal history.
        if (validAt < open.valid_at) {
          throw new Error(
            `assertFact: out-of-order validAt (${validAt}) precedes open fact's validAt (${open.valid_at}) for ${input.subject}/${input.predicate}`,
          );
        }
        // Supersede: close the prior belief in both time axes.
        this.#db
          .prepare("UPDATE facts SET invalid_at = ?, expired_at = ? WHERE id = ?")
          .run(validAt, now, open.id);
      }

      const id = randomUUID();
      this.#db
        .prepare(
          `INSERT INTO facts
             (id, session_id, subject, predicate, object, valid_at, invalid_at, created_at, expired_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        )
        .run(
          id,
          input.sessionId,
          input.subject,
          input.predicate,
          input.object,
          validAt,
          now,
        );

      return {
        id,
        sessionId: input.sessionId,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        validAt,
        invalidAt: null,
        createdAt: now,
        expiredAt: null,
      };
    })();
  }

  /** Facts currently believed true for a subject (invalidAt + expiredAt null). */
  currentFacts(subject: string): Fact[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM facts
         WHERE subject = ? AND invalid_at IS NULL AND expired_at IS NULL
         ORDER BY predicate ASC`,
      )
      .all(subject) as FactRow[];
    return rows.map(rowToFact);
  }

  /**
   * Facts that were true (in event time) at `asOf`, regardless of when we
   * learned them. Time-travel query.
   */
  factsAsOf(subject: string, asOf: number): Fact[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM facts
         WHERE subject = ?
           AND valid_at <= ?
           AND (invalid_at IS NULL OR invalid_at > ?)
         ORDER BY predicate ASC`,
      )
      .all(subject, asOf, asOf) as FactRow[];
    return rows.map(rowToFact);
  }

  /** All facts for a session (including superseded), newest event-time first. */
  factsForSession(sessionId: string): Fact[] {
    const rows = this.#db
      .prepare("SELECT * FROM facts WHERE session_id = ? ORDER BY valid_at DESC")
      .all(sessionId) as FactRow[];
    return rows.map(rowToFact);
  }

  close(): void {
    this.#db.close();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** The text blob an FTS card row indexes — all human-fuzzy + identifier fields. */
function cardFtsText(card: {
  repo?: string;
  branch?: string;
  task?: string;
  state?: string;
  lastAction?: string;
  openThreads?: string[];
  entities?: string[];
}): string {
  return [
    card.repo,
    card.branch,
    card.task,
    card.state,
    card.lastAction,
    ...(card.openThreads ?? []),
    ...(card.entities ?? []),
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ");
}

function rowToCard(row: CardRow): SessionCard {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    repo: row.repo ?? undefined,
    branch: row.branch ?? undefined,
    task: row.task ?? undefined,
    state: row.state ?? undefined,
    lastAction: row.last_action ?? undefined,
    openThreads: safeJsonArray(row.open_threads),
    entities: safeJsonArray(row.entities),
    embedding: row.embedding ? uint8ToFloat32(row.embedding) : undefined,
    embeddingModel: row.embedding_model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    sessionId: row.session_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    validAt: row.valid_at,
    invalidAt: row.invalid_at,
    createdAt: row.created_at,
    expiredAt: row.expired_at,
  };
}

function uint8ToFloat32(buf: Uint8Array): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Escape FTS5 operators by quoting each whitespace-split term (implicit AND).
 * `\s+` handles all whitespace incl. control chars, so no separate strip needed.
 */
function sanitizeFtsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" ");
}
