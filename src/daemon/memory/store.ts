/**
 * SqliteEpisodeStore — durable episode storage + hybrid retrieval primitives.
 *
 * Storage model:
 *   - `episodes` table holds structured columns + full content + embedding BLOB
 *   - `episodes_fts` FTS5 virtual table mirrors summary + content for BM25 keyword search
 *   - `file_reads` table indexes content-hashed file reads for cross-session dedup
 *
 * Vector search is brute-force cosine over an in-memory Float32Array matrix,
 * lazy-loaded on the first recall() and refreshed when new episodes are added.
 * Fine up to ~100k episodes on a laptop; swap to a real ANN index behind the
 * same interface if we outgrow it.
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import type { ClusterableEpisode } from "./cluster.js";
import type { Episode, FileReadRecord, RecallQuery } from "./types.js";
import type { TurnUsage } from "../../protocol/types.js";
import { BUSY_TIMEOUT_MS } from "../store.js";

/** Default byte ceiling for the decoded embedding-matrix cache (#154).
 * 128 MiB ≈ 87k episodes of 384-dim float32 — generous for interactive
 * recall while bounding a long-lived daemon whose recallGlobal would
 * otherwise pin every workspace's matrix forever. Overridable per store. */
const DEFAULT_VECTOR_CACHE_MAX_BYTES = 128 * 1024 * 1024;

export interface DailyUsageBucket {
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  numSessions: number;
}

export interface LifetimeUsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  numSessions: number;
}

/** Row shape as stored in SQLite. */
interface EpisodeRow {
  id: string;
  workspace_id: string;
  session_id: string;
  kind: string;
  tool_name: string | null;
  summary: string;
  content: string;
  file_paths: string;
  token_estimate: number;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  created_at: number;
  created_by: string;
}

/** The tenant a workspace id is scoped to. Every episode query filters by
 * workspace_id, so folding the tenant into the id is what keeps two accounts
 * that happen to work in the same directory from reading each other's memory. */
export interface WorkspaceTenant {
  accountId: string;
  projectId: string;
}

/**
 * Derive a stable, TENANT-SCOPED workspace ID from a working directory.
 *
 * For git repos, we anchor on `git rev-parse --git-common-dir` — the shared
 * .git directory that's identical across all worktrees of the same repo. That
 * way two sessions running in separate worktrees of the same codebase
 * (e.g. `/Workspace/codeoid` and `/Workspace/codeoid.wt-feat-x`) share one
 * workspace and cross-pollinate memory. For non-git directories, we fall back
 * to hashing the absolute workdir path.
 *
 * The `tenant` (account_id + project_id) is mixed into the hash so that two
 * DIFFERENT tenants working the SAME directory get DISTINCT workspace ids.
 * Without this, they'd share a path-derived id and one tenant's `recall()` /
 * `timeline()` would return the other's episodes — a cross-tenant disclosure,
 * since every episode query scopes solely by workspace_id. Same tenant + same
 * repo still collapse to one id, preserving cross-worktree sharing.
 *
 * NOTE: because the tenant is now part of the id, episodes written before this
 * change (path-only ids) are not visible to the tenant-scoped ids computed
 * after it — memory re-accumulates from the next session. Acceptable one-time
 * reset for the isolation guarantee.
 *
 * MEMOIZED per (tenant, path): the git probe is a synchronous fork+exec
 * (~5–30 ms, worse on cold/network filesystems) that runs on the daemon's
 * shared event loop — and callers hit it per session.search request (i.e.
 * per search-as-you-type keystroke) and per session create. The result is
 * deterministic for a given path within a daemon's lifetime for the same
 * reason Session captures #workspaceId once at construction. Staleness
 * caveat: a directory that becomes a git repo AFTER its first lookup keeps
 * its path-derived id until the daemon restarts — the same stability
 * trade-off the per-session capture already makes.
 */
const workspaceIdCache = new Map<string, string>();
const WORKSPACE_ID_CACHE_MAX = 512;

export function workspaceIdFromPath(
  workdir: string,
  tenant: WorkspaceTenant,
): string {
  const normalized = workdir.replace(/\/+$/, "");
  // NUL separators can't appear in ids/paths, so this is an unambiguous
  // prefix. Written as \u0000 ESCAPES deliberately: raw NUL bytes in the
  // source made git treat this file as binary and refuse to text-merge it
  // (every pair of PRs touching this file conflicted wholesale). The
  // string VALUE is identical, so derived workspace ids are unchanged.
  const scope = `${tenant.accountId}\u0000${tenant.projectId}\u0000`;

  const cacheKey = scope + normalized;
  const cached = workspaceIdCache.get(cacheKey);
  if (cached !== undefined) {
    // Re-insert so Map iteration order tracks recency → eviction is LRU.
    workspaceIdCache.delete(cacheKey);
    workspaceIdCache.set(cacheKey, cached);
    return cached;
  }

  const id = computeWorkspaceId(normalized, scope);
  workspaceIdCache.set(cacheKey, id);
  if (workspaceIdCache.size > WORKSPACE_ID_CACHE_MAX) {
    const oldest = workspaceIdCache.keys().next().value;
    if (oldest !== undefined) workspaceIdCache.delete(oldest);
  }
  return id;
}

function computeWorkspaceId(normalized: string, scope: string): string {
  try {
    const out = execSync("git rev-parse --git-common-dir", {
      cwd: normalized,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      const absolute = isAbsolute(out) ? out : resolve(normalized, out);
      const hash = createHash("sha256").update(scope + absolute).digest("hex");
      return `ws_${hash.slice(0, 16)}`;
    }
  } catch {
    // Not a git repo, or git not installed — fall through.
  }

  const hash = createHash("sha256").update(scope + normalized).digest("hex");
  return `ws_${hash.slice(0, 16)}`;
}

/**
 * The PRE-tenant workspace-id derivation (path only). Frozen so the one-time
 * migration can recognise ids written before tenant scoping. Do NOT "improve"
 * it — it must reproduce historical ids exactly, or the orphan re-key misses.
 * Exported for the migration test to construct pre-upgrade rows.
 */
export function legacyWorkspaceIdFromPath(workdir: string): string {
  const normalized = workdir.replace(/\/+$/, "");
  try {
    const out = execSync("git rev-parse --git-common-dir", {
      cwd: normalized,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      const absolute = isAbsolute(out) ? out : resolve(normalized, out);
      const hash = createHash("sha256").update(absolute).digest("hex");
      return `ws_${hash.slice(0, 16)}`;
    }
  } catch {
    /* not a git repo */
  }
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `ws_${hash.slice(0, 16)}`;
}

/** Bump when adding a new PRAGMA user_version-guarded episode migration. */
const TENANT_WS_MIGRATION_VERSION = 1;

export class SqliteEpisodeStore {
  #db: Database;
  /** Decoded embedding matrix per workspace, memoized so recall() doesn't
   * re-read + re-decode every embedding BLOB on each query. Kept in sync
   * incrementally on writes (insert-with-embedding / setEmbedding) — new
   * vectors are appended in place. `indexById` makes the re-embed (replace)
   * path O(1). LRU-bounded by `#vectorCacheMaxBytes` (#154): without a
   * ceiling, a long-lived daemon pinned every workspace ever searched
   * (recallGlobal touches ALL of them) for the life of the process —
   * 300+ MB on a 200k-episode corpus. */
  #vectorCache = new Map<
    string,
    { ids: string[]; vectors: Float32Array[]; indexById: Map<string, number>; sizeBytes: number }
  >();
  /** Total vector bytes currently cached (id strings / index maps are noise
   * next to the Float32Arrays and aren't counted). */
  #vectorCacheBytes = 0;
  #vectorCacheMaxBytes: number;

  constructor(dbPath: string, opts: { vectorCacheMaxBytes?: number } = {}) {
    this.#vectorCacheMaxBytes = Math.max(
      1,
      Math.floor(opts.vectorCacheMaxBytes ?? DEFAULT_VECTOR_CACHE_MAX_BYTES),
    );
    this.#db = new Database(dbPath, { create: true });
    // Before any lock-taking statement — SQLite's default is fail-instantly.
    // See BUSY_TIMEOUT_MS in ../store.ts for why every writable store sets it.
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  /** Observable cache accounting — diagnostics + tests. */
  vectorCacheStats(): { workspaces: number; bytes: number; maxBytes: number } {
    return {
      workspaces: this.#vectorCache.size,
      bytes: this.#vectorCacheBytes,
      maxBytes: this.#vectorCacheMaxBytes,
    };
  }

  /** Evict least-recently-used matrices until the total fits the ceiling.
   * Map insertion order is the recency order (loadVectorMatrix re-inserts
   * on hit). `keep` — the workspace just queried/extended — is never
   * evicted, so one workspace larger than the whole ceiling stays usable;
   * it just evicts everything else. An evicted workspace reloads from
   * SQLite on its next query. */
  #evictVectorCacheOver(keep: string): void {
    for (const [ws, entry] of this.#vectorCache) {
      if (this.#vectorCacheBytes <= this.#vectorCacheMaxBytes) break;
      if (ws === keep) continue;
      this.#vectorCache.delete(ws);
      this.#vectorCacheBytes -= entry.sizeBytes;
    }
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        kind            TEXT NOT NULL,
        tool_name       TEXT,
        summary         TEXT NOT NULL,
        content         TEXT NOT NULL,
        file_paths      TEXT NOT NULL DEFAULT '[]',
        token_estimate  INTEGER NOT NULL,
        embedding       BLOB,
        embedding_model TEXT,
        created_at      INTEGER NOT NULL,
        created_by      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_workspace
        ON episodes(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodes_session
        ON episodes(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodes_tool
        ON episodes(workspace_id, tool_name);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        summary, content, tool_name,
        content='episodes',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS episodes_fts_insert
        AFTER INSERT ON episodes BEGIN
          INSERT INTO episodes_fts(rowid, summary, content, tool_name)
          VALUES (new.rowid, new.summary, new.content, coalesce(new.tool_name, ''));
        END;

      CREATE TRIGGER IF NOT EXISTS episodes_fts_delete
        AFTER DELETE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, summary, content, tool_name)
          VALUES ('delete', old.rowid, old.summary, old.content, coalesce(old.tool_name, ''));
        END;

      CREATE TRIGGER IF NOT EXISTS episodes_fts_update
        AFTER UPDATE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, summary, content, tool_name)
          VALUES ('delete', old.rowid, old.summary, old.content, coalesce(old.tool_name, ''));
          INSERT INTO episodes_fts(rowid, summary, content, tool_name)
          VALUES (new.rowid, new.summary, new.content, coalesce(new.tool_name, ''));
        END;

      CREATE TABLE IF NOT EXISTS turn_usage (
        workspace_id                    TEXT NOT NULL,
        session_id                      TEXT NOT NULL,
        turn_number                     INTEGER NOT NULL,
        created_at                      INTEGER NOT NULL,
        input_tokens                    INTEGER NOT NULL DEFAULT 0,
        output_tokens                   INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens               INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens           INTEGER NOT NULL DEFAULT 0,
        total_cost_usd                  REAL    NOT NULL DEFAULT 0,
        duration_ms                     INTEGER NOT NULL DEFAULT 0,
        stop_reason                     TEXT,
        primary_max_call_input_tokens   INTEGER,
        PRIMARY KEY (session_id, turn_number)
      );

      CREATE INDEX IF NOT EXISTS idx_turn_usage_session
        ON turn_usage(session_id, turn_number DESC);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_workspace
        ON turn_usage(workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS file_reads (
        workspace_id   TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        content_hash   TEXT NOT NULL,
        mtime_ms       INTEGER,
        read_at        INTEGER NOT NULL,
        episode_id     TEXT NOT NULL,
        PRIMARY KEY (workspace_id, file_path, content_hash),
        FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_reads_recent
        ON file_reads(workspace_id, file_path, read_at DESC);
    `);

    // Idempotent migration: add primary_max_call_input_tokens column to
    // turn_usage tables created before that field existed. SQLite has no
    // "ADD COLUMN IF NOT EXISTS"; pragma_table_info gives us the same
    // effect cheaply.
    const hasPrimaryMaxCol = (
      this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM pragma_table_info('turn_usage') WHERE name = 'primary_max_call_input_tokens'",
        )
        .get() as { n: number } | undefined
    )?.n ?? 0;
    if (!hasPrimaryMaxCol) {
      this.#db.exec(
        "ALTER TABLE turn_usage ADD COLUMN primary_max_call_input_tokens INTEGER",
      );
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────

  insert(episode: Omit<Episode, "id"> & { id?: string }): Episode {
    const id = episode.id ?? randomUUID();
    const embeddingBuf = episode.embedding
      ? new Uint8Array(episode.embedding.buffer, episode.embedding.byteOffset, episode.embedding.byteLength)
      : null;

    this.#db
      .prepare(
        `INSERT INTO episodes (
          id, workspace_id, session_id, kind, tool_name, summary, content,
          file_paths, token_estimate, embedding, embedding_model, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        episode.workspaceId,
        episode.sessionId,
        episode.kind,
        episode.toolName ?? null,
        episode.summary,
        episode.content,
        JSON.stringify(episode.filePaths),
        episode.tokenEstimate,
        embeddingBuf,
        episode.embeddingModel ?? null,
        episode.createdAt,
        episode.createdBy,
      );

    // An insert that already carries an embedding extends the matrix for
    // its workspace; append to the cached copy rather than dropping it (a
    // drop would force a full O(N) BLOB reload on the next recall).
    if (episode.embedding) {
      this.#upsertCachedVector(episode.workspaceId, id, episode.embedding);
    }

    return { ...episode, id };
  }

  /**
   * One-time migration: re-key episodes from the old path-only workspace ids to
   * the tenant-scoped ids introduced with `workspaceIdFromPath(workdir, tenant)`,
   * so memory written before the upgrade stays recallable instead of orphaning.
   *
   * `sessions` is every persisted session (id, workdir, tenant). Episodes are
   * re-keyed by their OWNING session — precise, and it isolates two tenants that
   * shared a directory. Episodes whose session was destroyed are re-keyed only
   * when their old workspace id maps to a SINGLE tenant (unambiguous); ambiguous
   * multi-tenant orphans are left untouched rather than risk mis-attribution.
   *
   * Guarded by PRAGMA user_version so it runs once, and idempotent (re-keying to
   * the same id is a no-op) if it runs again. Only `episodes` is re-keyed —
   * recall/timeline read by workspace_id; turn_usage/file_reads are read by
   * session_id / are a pure cache, so their workspace_id column is inert here.
   */
  /**
   * Whether the one-time workspace-id tenant migration still needs to run. Lets
   * the caller skip the (potentially large) `sessions` read on every boot after
   * the first — the re-key itself is already guarded + idempotent, but the
   * session-table scan feeding it isn't, so gate on this to avoid paying it
   * forever.
   */
  needsWorkspaceMigration(): boolean {
    const version =
      (this.#db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version ?? 0;
    return version < TENANT_WS_MIGRATION_VERSION;
  }

  migrateWorkspaceIdsToTenant(
    sessions: ReadonlyArray<{
      id: string;
      workdir: string;
      accountId: string;
      projectId: string;
    }>,
    workspaceIdFor: (workdir: string, tenant: WorkspaceTenant) => string,
  ): { migrated: boolean; reKeyed: number } {
    if (!this.needsWorkspaceMigration()) {
      return { migrated: false, reKeyed: 0 };
    }

    let reKeyed = 0;
    this.#db.transaction(() => {
      const bySession = this.#db.prepare(
        "UPDATE episodes SET workspace_id = ? WHERE session_id = ? AND workspace_id != ?",
      );
      // old path-only id -> distinct new ids, to detect multi-tenant ambiguity.
      const oldToNew = new Map<string, Set<string>>();

      for (const s of sessions) {
        const newWs = workspaceIdFor(s.workdir, {
          accountId: s.accountId,
          projectId: s.projectId,
        });
        reKeyed += Number(bySession.run(newWs, s.id, newWs).changes ?? 0);
        const oldWs = legacyWorkspaceIdFromPath(s.workdir);
        const set = oldToNew.get(oldWs) ?? new Set<string>();
        set.add(newWs);
        oldToNew.set(oldWs, set);
      }

      // Orphans (session destroyed): re-key only where the old id resolves to a
      // single tenant, so we never merge two tenants' memory.
      const byWorkspace = this.#db.prepare(
        "UPDATE episodes SET workspace_id = ? WHERE workspace_id = ?",
      );
      for (const [oldWs, news] of oldToNew) {
        if (news.size !== 1) continue;
        const newWs = [...news][0]!;
        if (newWs === oldWs) continue;
        reKeyed += Number(byWorkspace.run(newWs, oldWs).changes ?? 0);
      }

      this.#db.exec(`PRAGMA user_version = ${TENANT_WS_MIGRATION_VERSION}`);
      this.#vectorCache.clear();
      this.#vectorCacheBytes = 0;
    })();

    return { migrated: true, reKeyed };
  }

  setEmbedding(
    episodeId: string,
    embedding: Float32Array,
    model: string,
    workspaceId: string,
  ): void {
    const buf = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.#db
      .prepare("UPDATE episodes SET embedding = ?, embedding_model = ? WHERE id = ?")
      .run(buf, model, episodeId);
    // Embed batches fire continuously during active work — clearing the cache
    // here would force the next recall into a full O(N) BLOB reload. Both the
    // id and the vector are known, so extend the cached matrix in place.
    this.#upsertCachedVector(workspaceId, episodeId, embedding);
  }

  /** Append (or replace, for a re-embed) one row of a workspace's cached
   * vector matrix. No-op when the matrix hasn't been built yet — the next
   * loadVectorMatrix() reads the row from SQLite along with everything else.
   * The vector is copied so the cache can't diverge from the persisted BLOB
   * if the caller mutates its array afterwards. */
  #upsertCachedVector(workspaceId: string, id: string, vector: Float32Array): void {
    const cached = this.#vectorCache.get(workspaceId);
    if (!cached) return;
    const copy = new Float32Array(vector);
    const existing = cached.indexById.get(id);
    if (existing !== undefined) {
      const delta = copy.byteLength - cached.vectors[existing]!.byteLength;
      cached.vectors[existing] = copy;
      cached.sizeBytes += delta;
      this.#vectorCacheBytes += delta;
    } else {
      cached.indexById.set(id, cached.ids.length);
      cached.ids.push(id);
      cached.vectors.push(copy);
      cached.sizeBytes += copy.byteLength;
      this.#vectorCacheBytes += copy.byteLength;
    }
    // A write is a recency signal too: re-insert so an actively-WRITTEN
    // workspace can't sit at the front of the Map (oldest position) and be
    // evicted by the next query on some other workspace (review catch).
    this.#vectorCache.delete(workspaceId);
    this.#vectorCache.set(workspaceId, cached);
    // Growth can push the total past the ceiling — evict OTHER workspaces
    // (the one being written stays; it's clearly hot).
    this.#evictVectorCacheOver(workspaceId);
  }

  /** Run `fn` inside a single transaction so a batch of writes commits once
   * (one WAL fsync + one FTS-trigger pass) instead of N. */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  /** Prune file-read dedup-cache rows older than `maxAgeMs`. This is a pure
   * cache (re-populated on next read), so pruning loses no semantic data —
   * unlike episodes/audit_log, whose retention is a policy decision (#14). */
  pruneFileReads(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const res = this.#db.prepare("DELETE FROM file_reads WHERE read_at < ?").run(cutoff);
    return Number(res.changes ?? 0);
  }

  // ── Turn usage (persistent token/cost tracking) ─────────────────────────

  /**
   * Upsert a per-turn usage row. Idempotent on (session_id, turn_number).
   * Keeps the DB as the source of truth — an in-memory #usage object on
   * Session is just a cache rebuilt from DB on resume.
   */
  recordTurnUsage(input: {
    workspaceId: string;
    sessionId: string;
    turn: TurnUsage;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO turn_usage (
          workspace_id, session_id, turn_number, created_at,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          total_cost_usd, duration_ms, stop_reason, primary_max_call_input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, turn_number) DO UPDATE SET
          created_at = excluded.created_at,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_creation_tokens = excluded.cache_creation_tokens,
          total_cost_usd = excluded.total_cost_usd,
          duration_ms = excluded.duration_ms,
          stop_reason = excluded.stop_reason,
          primary_max_call_input_tokens = excluded.primary_max_call_input_tokens`,
      )
      .run(
        input.workspaceId,
        input.sessionId,
        input.turn.turnNumber,
        input.turn.createdAt,
        input.turn.inputTokens,
        input.turn.outputTokens,
        input.turn.cacheReadTokens,
        input.turn.cacheCreationTokens,
        input.turn.totalCostUsd,
        input.turn.durationMs,
        input.turn.stopReason ?? null,
        input.turn.primaryMaxCallInputTokens ?? null,
      );
  }

  /** Recent turns for a session (newest first). */
  listTurnsForSession(sessionId: string, limit = 20): TurnUsage[] {
    const rows = this.#db
      .prepare(
        `SELECT turn_number, created_at, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens,
                total_cost_usd, duration_ms, stop_reason,
                primary_max_call_input_tokens
         FROM turn_usage
         WHERE session_id = ?
         ORDER BY turn_number DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{
        turn_number: number;
        created_at: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        total_cost_usd: number;
        duration_ms: number;
        stop_reason: string | null;
        primary_max_call_input_tokens: number | null;
      }>;

    return rows.map((r) => this.#rowToTurnUsage(r));
  }

  /**
   * Roll up a session's turn history into a cumulative totals object.
   * Returns zeros if the session has no turn records yet.
   */
  sessionUsageTotals(sessionId: string): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCostUsd: number;
    durationMs: number;
    numTurns: number;
    peakInputTokens: number;
  } {
    const row = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)           AS input_tokens,
           COALESCE(SUM(output_tokens), 0)          AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0)      AS cache_read_tokens,
           COALESCE(SUM(cache_creation_tokens), 0)  AS cache_creation_tokens,
           COALESCE(SUM(total_cost_usd), 0)         AS total_cost_usd,
           COALESCE(SUM(duration_ms), 0)            AS duration_ms,
           COUNT(*)                                  AS num_turns,
           COALESCE(MAX(
             COALESCE(
               primary_max_call_input_tokens,
               input_tokens + cache_read_tokens + cache_creation_tokens
             )
           ), 0) AS peak_input_tokens
         FROM turn_usage WHERE session_id = ?`,
      )
      .get(sessionId) as {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        total_cost_usd: number;
        duration_ms: number;
        num_turns: number;
        peak_input_tokens: number;
      } | null;

    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      cacheReadTokens: row?.cache_read_tokens ?? 0,
      cacheCreationTokens: row?.cache_creation_tokens ?? 0,
      totalCostUsd: row?.total_cost_usd ?? 0,
      durationMs: row?.duration_ms ?? 0,
      numTurns: row?.num_turns ?? 0,
      peakInputTokens: row?.peak_input_tokens ?? 0,
    };
  }

  /** Max turn_number recorded for a session (0 if none). Used to resume numbering. */
  nextTurnNumber(sessionId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MAX(turn_number), 0) AS last_turn
         FROM turn_usage WHERE session_id = ?`,
      )
      .get(sessionId) as { last_turn: number } | null;
    return (row?.last_turn ?? 0) + 1;
  }

  dailyUsage(days = 30, sessionIds?: string[]): DailyUsageBucket[] {
    // Scoping contract: `undefined` = unscoped (internal callers only);
    // an ARRAY — including an empty one — is a strict ownership filter.
    // Treating [] as "no filter" let a zero-session identity read
    // EVERYONE's usage.
    if (sessionIds && sessionIds.length === 0) return [];
    // Filter via json_each over a single JSON-array bind param instead of
    // one `?` per session id: `IN (?,?,...)` blows SQLite's bound-variable
    // limit at ~1000 sessions (the sessions table lives in a different DB
    // file, so a JOIN isn't available here).
    const sessionFilter = sessionIds
      ? "AND session_id IN (SELECT value FROM json_each(?))"
      : "";
    const rows = this.#db
      .prepare(
        `SELECT
           date(created_at / 1000, 'unixepoch') AS day,
           COALESCE(SUM(total_cost_usd), 0)     AS cost_usd,
           COALESCE(SUM(input_tokens), 0)        AS input_tokens,
           COALESCE(SUM(output_tokens), 0)       AS output_tokens,
           COUNT(*)                              AS num_turns,
           COUNT(DISTINCT session_id)            AS num_sessions
         FROM turn_usage
         WHERE date(created_at / 1000, 'unixepoch') >= date('now', printf('-%d days', ? - 1))
         ${sessionFilter}
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(
        ...(sessionIds ? [days, JSON.stringify(sessionIds)] : [days]),
      ) as Array<{
      day: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      num_turns: number;
      num_sessions: number;
    }>;

    return rows.map((r) => ({
      day: r.day,
      costUsd: r.cost_usd,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      numTurns: r.num_turns,
      numSessions: r.num_sessions,
    }));
  }

  lifetimeTotals(sessionIds?: string[]): LifetimeUsageTotals {
    // Same scoping contract as dailyUsage: [] = strict empty scope → zeros.
    if (sessionIds && sessionIds.length === 0) {
      return {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        numTurns: 0,
        numSessions: 0,
      };
    }
    // json_each over one JSON bind param — see dailyUsage for rationale.
    const sessionFilter = sessionIds
      ? "WHERE session_id IN (SELECT value FROM json_each(?))"
      : "";
    const row = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(total_cost_usd), 0)     AS cost_usd,
           COALESCE(SUM(input_tokens), 0)        AS input_tokens,
           COALESCE(SUM(output_tokens), 0)       AS output_tokens,
           COUNT(*)                              AS num_turns,
           COUNT(DISTINCT session_id)            AS num_sessions
         FROM turn_usage ${sessionFilter}`,
      )
      .get(...(sessionIds ? [JSON.stringify(sessionIds)] : [])) as {
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      num_turns: number;
      num_sessions: number;
    };

    return {
      costUsd: row?.cost_usd ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      numTurns: row?.num_turns ?? 0,
      numSessions: row?.num_sessions ?? 0,
    };
  }

  #rowToTurnUsage(row: {
    turn_number: number;
    created_at: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_cost_usd: number;
    duration_ms: number;
    stop_reason: string | null;
    primary_max_call_input_tokens: number | null;
  }): TurnUsage {
    // Anthropic's input_tokens counts NEW bytes only. `total` here SUMS
    // across the multiple internal Messages-API calls a tool-using turn
    // makes — correct for billing, but overstates single-shot context
    // size. `primaryMaxCallInputTokens` (when populated) is the honest
    // per-turn ctx size for "% of window" displays.
    const total =
      row.input_tokens + row.cache_read_tokens + row.cache_creation_tokens;
    const billable = row.input_tokens + row.cache_creation_tokens;
    const hit = total > 0 ? row.cache_read_tokens / total : 0;
    return {
      turnNumber: row.turn_number,
      createdAt: row.created_at,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      totalCostUsd: row.total_cost_usd,
      durationMs: row.duration_ms,
      stopReason: row.stop_reason ?? undefined,
      totalInputTokens: total,
      billableInputTokens: billable,
      cacheHitRate: hit,
      ...(row.primary_max_call_input_tokens != null
        ? { primaryMaxCallInputTokens: row.primary_max_call_input_tokens }
        : {}),
    };
  }

  recordFileRead(record: FileReadRecord): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO file_reads
         (workspace_id, file_path, content_hash, mtime_ms, read_at, episode_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.workspaceId,
        record.filePath,
        record.contentHash,
        record.mtimeMs ?? null,
        record.readAt,
        record.episodeId,
      );
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  getEpisode(id: string): Episode | null {
    const row = this.#db
      .prepare("SELECT * FROM episodes WHERE id = ?")
      .get(id) as EpisodeRow | null;
    return row ? this.#rowToEpisode(row) : null;
  }

  /**
   * Tenant-scoped exact fetch — returns null if the episode belongs to another
   * workspace. The bare `getEpisode` above is NOT tenant-scoped; only this
   * variant is safe to expose to a model (a `get_episode` tool must never be a
   * cross-tenant read primitive).
   */
  getEpisodeInWorkspace(id: string, workspaceId: string): Episode | null {
    const row = this.#db
      .prepare("SELECT * FROM episodes WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as EpisodeRow | null;
    return row ? this.#rowToEpisode(row) : null;
  }

  listRecent(workspaceId: string, limit: number, offset = 0): Episode[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM episodes WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .all(workspaceId, limit, offset) as EpisodeRow[];
    return rows.map((r) => this.#rowToEpisode(r));
  }

  /**
   * Compact projection for clustering: the newest `limit` EMBEDDED episodes
   * with only the columns k-means + labeling read (id, summary, file paths,
   * tool name, created_at, embedding). Skips `content` — the column that
   * carries full tool outputs and dominated the heap cost when the recluster
   * path hydrated full episodes.
   */
  listRecentForClustering(workspaceId: string, limit: number): ClusterableEpisode[] {
    const rows = this.#db
      .prepare(
        `SELECT id, summary, file_paths, tool_name, created_at, embedding
         FROM episodes
         WHERE workspace_id = ? AND embedding IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as Array<{
        id: string;
        summary: string;
        file_paths: string;
        tool_name: string | null;
        created_at: number;
        embedding: Uint8Array;
      }>;

    return rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      filePaths: safeJsonArray(r.file_paths),
      toolName: r.tool_name ?? undefined,
      createdAt: r.created_at,
      embedding: uint8ToFloat32(r.embedding),
    }));
  }

  /** All episodes for one session, oldest first — used by share.pack. */
  listEpisodesForSession(sessionId: string): Episode[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as EpisodeRow[];
    return rows.map((r) => this.#rowToEpisode(r));
  }

  /**
   * Workspace-level counters used by the index builder. One round-trip; cheap
   * even on many-thousand-episode stores because the idx_episodes_workspace
   * index covers both the count and the min/max aggregates.
   */
  workspaceStats(workspaceId: string): {
    episodeCount: number;
    sessionCount: number;
    firstCreatedAt: number | null;
    lastCreatedAt: number | null;
  } {
    const row = this.#db
      .prepare(
        `SELECT
          COUNT(*)                      AS episode_count,
          COUNT(DISTINCT session_id)    AS session_count,
          MIN(created_at)               AS first_created_at,
          MAX(created_at)               AS last_created_at
         FROM episodes WHERE workspace_id = ?`,
      )
      .get(workspaceId) as {
        episode_count: number;
        session_count: number;
        first_created_at: number | null;
        last_created_at: number | null;
      } | null;

    return {
      episodeCount: row?.episode_count ?? 0,
      sessionCount: row?.session_count ?? 0,
      firstCreatedAt: row?.first_created_at ?? null,
      lastCreatedAt: row?.last_created_at ?? null,
    };
  }

  /**
   * Top-N files by touch count across the workspace. Uses json_each to
   * unnest file_paths (stored as a JSON array) so we can aggregate without
   * pulling full rows into TS. Scales to ~50k episodes in <50ms.
   */
  hotFiles(
    workspaceId: string,
    limit: number,
  ): Array<{ path: string; touches: number; lastTouchedAt: number }> {
    const rows = this.#db
      .prepare(
        `SELECT
           json_each.value        AS path,
           COUNT(*)               AS touches,
           MAX(e.created_at)      AS last_touched_at
         FROM episodes e, json_each(e.file_paths)
         WHERE e.workspace_id = ?
         GROUP BY json_each.value
         ORDER BY touches DESC, last_touched_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, limit) as Array<{
        path: string;
        touches: number;
        last_touched_at: number;
      }>;

    return rows.map((r) => ({
      path: r.path,
      touches: r.touches,
      lastTouchedAt: r.last_touched_at,
    }));
  }

  /**
   * Most-recent sessions in the workspace, with a one-line descriptor drawn
   * from the first user_turn episode of each session (falls back to the
   * first episode of any kind if no user_turn exists yet).
   */
  sessionSummaries(
    workspaceId: string,
    limit: number,
  ): Array<{
    sessionId: string;
    firstSummary: string;
    firstCreatedAt: number;
    lastActivityAt: number;
    episodeCount: number;
  }> {
    // Aggregate per-session counters first, ordered by recency.
    const sessionRows = this.#db
      .prepare(
        `SELECT
           session_id           AS session_id,
           MIN(created_at)      AS first_created_at,
           MAX(created_at)      AS last_activity_at,
           COUNT(*)             AS episode_count
         FROM episodes
         WHERE workspace_id = ?
         GROUP BY session_id
         ORDER BY last_activity_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, limit) as Array<{
        session_id: string;
        first_created_at: number;
        last_activity_at: number;
        episode_count: number;
      }>;
    if (sessionRows.length === 0) return [];

    // Per-session: prefer the first user_turn's summary as the intent marker.
    const pickSummary = this.#db.prepare(
      `SELECT summary FROM episodes
       WHERE workspace_id = ? AND session_id = ?
       ORDER BY
         CASE kind WHEN 'user_turn' THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 1`,
    );

    return sessionRows.map((r) => {
      const summaryRow = pickSummary.get(workspaceId, r.session_id) as
        | { summary: string }
        | null;
      return {
        sessionId: r.session_id,
        firstSummary: summaryRow?.summary ?? "(no summary)",
        firstCreatedAt: r.first_created_at,
        lastActivityAt: r.last_activity_at,
        episodeCount: r.episode_count,
      };
    });
  }

  /** FTS5 keyword search returning top-K rows with BM25 scores. */
  ftsSearch(workspaceId: string, query: string, limit: number): Array<{ id: string; bm25: number }> {
    if (!query.trim()) return [];
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.#db
      .prepare(
        `SELECT e.id AS id, bm25(episodes_fts) AS bm25
         FROM episodes_fts
         JOIN episodes e ON e.rowid = episodes_fts.rowid
         WHERE episodes_fts MATCH ? AND e.workspace_id = ?
         ORDER BY bm25
         LIMIT ?`,
      )
      .all(sanitized, workspaceId, limit) as Array<{ id: string; bm25: number }>;

    return rows;
  }

  /** Build or return the cached (rowid → embedding) matrix for a workspace.
   * Built from SQLite at most once per workspace; writes keep it in sync
   * incrementally (see #upsertCachedVector), so recall never pays a full
   * reload after the first query. */
  loadVectorMatrix(workspaceId: string): { ids: string[]; vectors: Float32Array[] } {
    const cached = this.#vectorCache.get(workspaceId);
    if (cached) {
      // Touch: re-insert so Map order tracks query recency (LRU).
      this.#vectorCache.delete(workspaceId);
      this.#vectorCache.set(workspaceId, cached);
      return cached;
    }

    const rows = this.#db
      .prepare(
        `SELECT id, embedding FROM episodes
         WHERE workspace_id = ? AND embedding IS NOT NULL`,
      )
      .all(workspaceId) as Array<{ id: string; embedding: Uint8Array }>;

    const ids: string[] = [];
    const vectors: Float32Array[] = [];
    const indexById = new Map<string, number>();
    let sizeBytes = 0;
    for (const row of rows) {
      indexById.set(row.id, ids.length);
      ids.push(row.id);
      const v = uint8ToFloat32(row.embedding);
      sizeBytes += v.byteLength;
      vectors.push(v);
    }
    const matrix = { ids, vectors, indexById, sizeBytes };
    this.#vectorCache.set(workspaceId, matrix);
    this.#vectorCacheBytes += sizeBytes;
    this.#evictVectorCacheOver(workspaceId);
    return matrix;
  }

  /** Look up a recent file read by path + content hash (dedup hit). */
  findFileRead(
    workspaceId: string,
    filePath: string,
    contentHash: string,
  ): FileReadRecord | null {
    const row = this.#db
      .prepare(
        `SELECT workspace_id, file_path, content_hash, mtime_ms, read_at, episode_id
         FROM file_reads
         WHERE workspace_id = ? AND file_path = ? AND content_hash = ?`,
      )
      .get(workspaceId, filePath, contentHash) as
      | {
          workspace_id: string;
          file_path: string;
          content_hash: string;
          mtime_ms: number | null;
          read_at: number;
          episode_id: string;
        }
      | null;

    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      contentHash: row.content_hash,
      mtimeMs: row.mtime_ms ?? undefined,
      readAt: row.read_at,
      episodeId: row.episode_id,
    };
  }

  /** Apply post-retrieval filters from RecallQuery. */
  filter(ids: string[], query: RecallQuery): Episode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.#db
      .prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`)
      .all(...ids) as EpisodeRow[];

    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered: Episode[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      const ep = this.#rowToEpisode(row);
      if (!matchesQuery(ep, query)) continue;
      ordered.push(ep);
    }
    return ordered;
  }

  // ── Cross-workspace (global) retrieval primitives ─────────────────────────
  // The conductor resolves a fuzzy reference to the right session across ALL
  // workspaces on the machine, not within one. These are the unscoped twins of
  // ftsSearch / loadVectorMatrix / filter. Ranking a single GLOBAL candidate set
  // (rather than merging per-workspace results) is what makes BM25 scores
  // comparable across workspaces — see engine.recallGlobal().
  //
  // NOTE: "global" here means the whole store, which is single-tenant per user
  // (workspace ids already fold in account+project). When the conductor grows a
  // multi-tenant surface, scope these to the caller's tenant workspace set.

  /** Distinct workspace ids present in the store. */
  listWorkspaceIds(): string[] {
    return (
      this.#db
        .prepare("SELECT DISTINCT workspace_id AS w FROM episodes")
        .all() as Array<{ w: string }>
    ).map((r) => r.w);
  }

  /** FTS5 keyword search across ALL workspaces. */
  ftsSearchGlobal(query: string, limit: number): Array<{ id: string; bm25: number }> {
    if (!query.trim()) return [];
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    return this.#db
      .prepare(
        `SELECT e.id AS id, bm25(episodes_fts) AS bm25
         FROM episodes_fts
         JOIN episodes e ON e.rowid = episodes_fts.rowid
         WHERE episodes_fts MATCH ?
         ORDER BY bm25
         LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{ id: string; bm25: number }>;
  }

  /** Fetch episodes by id (no workspace scoping), preserving input order. */
  episodesByIds(ids: string[]): Episode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.#db
      .prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`)
      .all(...ids) as EpisodeRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered: Episode[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row) ordered.push(this.#rowToEpisode(row));
    }
    return ordered;
  }

  close(): void {
    this.#db.close();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  #rowToEpisode(row: EpisodeRow): Episode {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      kind: row.kind as Episode["kind"],
      toolName: row.tool_name ?? undefined,
      summary: row.summary,
      content: row.content,
      filePaths: safeJsonArray(row.file_paths),
      tokenEstimate: row.token_estimate,
      embedding: row.embedding ? uint8ToFloat32(row.embedding) : undefined,
      embeddingModel: row.embedding_model ?? undefined,
      createdAt: row.created_at,
      createdBy: row.created_by,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function uint8ToFloat32(buf: Uint8Array): Float32Array {
  // Copy into a fresh backing buffer — the SQLite-returned Uint8Array may not
  // be 4-byte aligned, which breaks a direct Float32Array view. Allocating
  // the Float32Array first and blitting bytes into its buffer needs one
  // allocation per row instead of two.
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Escape FTS5 operators and wrap terms to survive user input. */
function sanitizeFtsQuery(q: string): string {
  // Strip control chars and trailing punctuation; split on whitespace; drop empties.
  const terms = q
    .replace(/[\u0000-\u001f]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return "";
  // Quote each term to prevent FTS5 operator interpretation; join with implicit AND.
  return terms.map((t) => `"${t}"`).join(" ");
}

function matchesQuery(ep: Episode, q: RecallQuery): boolean {
  if (q.sessionId && ep.sessionId !== q.sessionId) return false;
  if (q.excludeSessionId && ep.sessionId === q.excludeSessionId) return false;
  if (q.toolName && ep.toolName !== q.toolName) return false;
  if (q.before && ep.createdAt >= q.before) return false;
  if (q.after && ep.createdAt <= q.after) return false;
  if (q.filePaths && q.filePaths.length > 0) {
    const has = ep.filePaths.some((p) => q.filePaths!.includes(p));
    if (!has) return false;
  }
  return true;
}
