/**
 * Durable loop watches (docs/loops.md "Watches"): the owner's rules for
 * starting repair runs from repository events, and the events they acted on.
 *
 * `loop_triggers` is the dedupe ledger: one row per (owner, event key), so the
 * same failing check or comment seen on every poll — by any of the owner's
 * watches — starts one run. A row is claimed before its run starts and
 * released if the run can't start, so an event that was skipped (a run
 * already active on the branch, the owner's run cap, the hourly bound) is
 * picked up on a later poll; a skipped comment is kept waiting to retry
 * (`defer`), because it is read again only while one waits. A run whose
 * workspace couldn't be prepared gives its keys back for a bounded number of
 * retries. An event left waiting on a pull request that closed, or for a
 * week, expires. Rows outlive their watch: a new watch must not act on what
 * an old one already did.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { BUSY_TIMEOUT_MS } from "../store.js";
import type { LoopTenant } from "./store.js";

/** A CI check name mapped to the local command that reproduces it. */
export interface WatchCiMapping {
  /** Exact check name, or a glob with `*` and `?`. */
  ciName: string;
  /** Slug of the GitHub App whose check runs count (`github-actions`). Absent on older watches: the default. */
  app?: string;
  command: string;
  timeoutSec: number;
  expectTests?: boolean;
}

/** What a watch looks for and what the runs it starts get. */
export interface WatchSpec {
  /** Explicit branches; empty when `myPrs`. */
  branches: string[];
  /** The heads of the owner's open pull requests. */
  myPrs: boolean;
  ci: WatchCiMapping[];
  review: { enabled: boolean; allow: string[]; mention: string };
  /** The GitHub login gh was signed in as when the watch was made: the owner, trusted by default. */
  ghLogin?: string;
  /** More logins whose commits a head may carry (the owner is always trusted). */
  trust?: string[];
  provider?: string;
  model?: string;
  toolBudget?: number;
  limits?: { attempts?: number; attemptMinutes?: number; runMinutes?: number };
  maxRunsPerHour: number;
}

export interface WatchRow {
  id: string;
  accountId: string;
  projectId: string;
  ownerSub: string;
  ownerName: string | null;
  workdir: string;
  /** `owner/name` on github.com. */
  repo: string;
  spec: WatchSpec;
  enabled: boolean;
  lastPolledAt: number | null;
  lastError: string | null;
  /** The last poll that read everything it meant to (comments are read from shortly before it). */
  lastOkAt: number | null;
  /** When the watch was last resumed: comments made while it was paused don't count. */
  resumedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type TriggerKind = "ci_failure" | "review_comment";

export interface TriggerRow {
  watchId: string;
  key: string;
  kind: TriggerKind;
  branch: string;
  /** The run it started; null while claimed, when ignored, or waiting to retry. */
  runId: string | null;
  /** `retry`: skipped, or its run's workspace couldn't be prepared; a later poll tries again. */
  outcome: "run" | "ignored" | "retry";
  note: string | null;
  createdAt: number;
}

/** A run the ledger hasn't seen end yet, with the keys that started it. */
export interface UnsettledRun {
  runId: string;
  keys: string[];
  retries: number;
}

interface WatchDbRow {
  id: string;
  account_id: string;
  project_id: string;
  owner_sub: string;
  owner_name: string | null;
  workdir: string;
  repo: string;
  spec_json: string;
  enabled: number;
  last_polled_at: number | null;
  last_error: string | null;
  last_ok_at: number | null;
  resumed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TriggerDbRow {
  watch_id: string;
  key: string;
  kind: string;
  branch: string;
  run_id: string | null;
  outcome: string;
  note: string | null;
  created_at: number;
}

export class WatchStore {
  readonly #db: Database;

  constructor(db: Database | string) {
    this.#db = typeof db === "string" ? new Database(db, { create: true }) : db;
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA journal_mode = WAL");
    // The first shape of the ledger keyed events per watch; nothing shipped
    // with it, so it is rebuilt rather than migrated.
    const cols = (t: string) => (this.#db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (cols("loop_triggers").length > 0 && !cols("loop_triggers").includes("owner_sub")) this.#db.exec("DROP TABLE loop_triggers");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS loop_watches (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL,
        project_id      TEXT NOT NULL,
        owner_sub       TEXT NOT NULL,
        owner_name      TEXT,
        workdir         TEXT NOT NULL,
        repo            TEXT NOT NULL,
        spec_json       TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        last_polled_at  INTEGER,
        last_error      TEXT,
        last_ok_at      INTEGER,
        resumed_at      INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loop_watches_owner
        ON loop_watches(account_id, project_id, owner_sub, created_at);

      CREATE TABLE IF NOT EXISTS loop_triggers (
        account_id  TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        owner_sub   TEXT NOT NULL,
        repo        TEXT NOT NULL,
        watch_id    TEXT NOT NULL,
        key         TEXT NOT NULL,
        kind        TEXT NOT NULL,
        branch      TEXT NOT NULL,
        run_id      TEXT,
        outcome     TEXT NOT NULL DEFAULT 'run',
        note        TEXT,
        retries     INTEGER NOT NULL DEFAULT 0,
        settled     INTEGER NOT NULL DEFAULT 0,
        pr          INTEGER,
        created_at  INTEGER NOT NULL,
        UNIQUE (account_id, project_id, owner_sub, key)
      );
      CREATE INDEX IF NOT EXISTS idx_loop_triggers_watch ON loop_triggers(watch_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_loop_triggers_branch ON loop_triggers(account_id, project_id, owner_sub, repo, branch, settled);
    `);
    for (const c of ["last_ok_at", "resumed_at"]) {
      if (!cols("loop_watches").includes(c)) this.#db.exec(`ALTER TABLE loop_watches ADD COLUMN ${c} INTEGER`);
    }
    if (!cols("loop_triggers").includes("pr")) this.#db.exec("ALTER TABLE loop_triggers ADD COLUMN pr INTEGER");
  }

  // ── Watches ─────────────────────────────────────────────────────────────

  create(input: { tenant: LoopTenant; ownerSub: string; ownerName?: string; workdir: string; repo: string; spec: WatchSpec; at?: number }): WatchRow {
    const id = `lw_${randomUUID()}`;
    const at = input.at ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO loop_watches (id, account_id, project_id, owner_sub, owner_name, workdir, repo, spec_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, input.tenant.accountId, input.tenant.projectId, input.ownerSub, input.ownerName ?? null, input.workdir, input.repo, JSON.stringify(input.spec), at, at);
    return this.get(id)!;
  }

  get(id: string): WatchRow | null {
    const row = this.#db.prepare("SELECT * FROM loop_watches WHERE id = ?").get(id) as WatchDbRow | null;
    return row ? toWatch(row) : null;
  }

  /** A watch visible to `ownerSub` in `tenant`; anything else is null. */
  getOwned(id: string, tenant: LoopTenant, ownerSub: string): WatchRow | null {
    const row = this.#db
      .prepare("SELECT * FROM loop_watches WHERE id = ? AND account_id = ? AND project_id = ? AND owner_sub = ?")
      .get(id, tenant.accountId, tenant.projectId, ownerSub) as WatchDbRow | null;
    return row ? toWatch(row) : null;
  }

  listOwned(tenant: LoopTenant, ownerSub: string): WatchRow[] {
    return (
      this.#db
        .prepare("SELECT * FROM loop_watches WHERE account_id = ? AND project_id = ? AND owner_sub = ? ORDER BY created_at DESC")
        .all(tenant.accountId, tenant.projectId, ownerSub) as WatchDbRow[]
    ).map(toWatch);
  }

  /** Whether anyone other than this owner has a watch on the daemon. */
  hasOtherOwners(tenant: LoopTenant, ownerSub: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM loop_watches WHERE NOT (account_id = ? AND project_id = ? AND owner_sub = ?) LIMIT 1")
        .get(tenant.accountId, tenant.projectId, ownerSub) !== null
    );
  }

  listEnabled(): WatchRow[] {
    return (this.#db.prepare("SELECT * FROM loop_watches WHERE enabled = 1 ORDER BY created_at").all() as WatchDbRow[]).map(toWatch);
  }

  update(id: string, patch: { spec?: WatchSpec; enabled?: boolean; resumedAt?: number }): WatchRow | null {
    // Strictly later on every change, even within a millisecond: a poll tells
    // a watch changed under it by this.
    const sets = ["updated_at = MAX(?, updated_at + 1)"];
    const values: Array<string | number> = [Date.now()];
    if (patch.spec) {
      sets.push("spec_json = ?");
      values.push(JSON.stringify(patch.spec));
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.resumedAt !== undefined) {
      sets.push("resumed_at = ?");
      values.push(patch.resumedAt);
    }
    this.#db.prepare(`UPDATE loop_watches SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.get(id);
  }

  /** Record a poll: when it ran, what went wrong (null when nothing did), and whether it read everything. */
  markPolled(id: string, at: number, error: string | null, ok: boolean): void {
    this.#db
      .prepare(`UPDATE loop_watches SET last_polled_at = ?, last_error = ?${ok ? ", last_ok_at = ?" : ""} WHERE id = ?`)
      .run(...(ok ? [at, error?.slice(0, 1_000) ?? null, at, id] : [at, error?.slice(0, 1_000) ?? null, id]));
  }

  /** Delete a watch. Its ledger rows stay (they are the owner's), except its untrusted-head notes. */
  delete(id: string): void {
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM loop_triggers WHERE watch_id = ? AND key LIKE ?").run(id, `untrusted:${id}:%`);
      this.#db.prepare("DELETE FROM loop_watches WHERE id = ?").run(id);
    })();
  }

  // ── Trigger ledger (per owner) ──────────────────────────────────────────

  /** Keys of `keys` the owner already acted on (started a run for, or ignored). A key waiting to retry is not. */
  seen(w: WatchRow, keys: string[]): Set<string> {
    if (keys.length === 0) return new Set();
    const out = new Set<string>();
    const q = this.#db.prepare(
      "SELECT 1 FROM loop_triggers WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND key = ? AND outcome != 'retry'",
    );
    for (const k of keys) if (q.get(w.accountId, w.projectId, w.ownerSub, k)) out.add(k);
    return out;
  }

  /**
   * Claim `keys` for one run, all or none: false when any is already taken
   * (another poll, or another of the owner's watches, got there first). A key
   * waiting to retry is claimed again.
   */
  claim(w: WatchRow, keys: string[], kind: TriggerKind, branch: string, at: number, pr: number | null = null): boolean {
    const ins = this.#db.prepare(
      `INSERT OR IGNORE INTO loop_triggers (account_id, project_id, owner_sub, repo, watch_id, key, kind, branch, outcome, pr, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'run', ?, ?)`,
    );
    const retry = this.#db.prepare(
      `UPDATE loop_triggers SET outcome = 'run', run_id = NULL, settled = 0, watch_id = ?, branch = ?, created_at = ?
       WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND key = ? AND outcome = 'retry'`,
    );
    try {
      this.#db.transaction(() => {
        for (const k of keys) {
          if (Number(ins.run(w.accountId, w.projectId, w.ownerSub, w.repo, w.id, k, kind, branch, pr, at).changes ?? 0) === 1) continue;
          if (Number(retry.run(w.id, branch, at, w.accountId, w.projectId, w.ownerSub, k).changes ?? 0) === 1) continue;
          throw new Rollback();
        }
      })();
      return true;
    } catch (err) {
      if (err instanceof Rollback) return false;
      throw err;
    }
  }

  /** The claimed keys started `runId`. */
  bind(w: WatchRow, keys: string[], runId: string): void {
    const q = this.#db.prepare("UPDATE loop_triggers SET run_id = ? WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND key = ?");
    this.#db.transaction(() => {
      for (const k of keys) q.run(runId, w.accountId, w.projectId, w.ownerSub, k);
    })();
  }

  /** The run couldn't start: give the keys back so a later poll tries again (a retried key goes back to waiting). */
  release(w: WatchRow, keys: string[]): void {
    const del = this.#db.prepare(
      "DELETE FROM loop_triggers WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND key = ? AND run_id IS NULL AND outcome = 'run' AND retries = 0",
    );
    const back = this.#db.prepare(
      "UPDATE loop_triggers SET outcome = 'retry' WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND key = ? AND run_id IS NULL AND outcome = 'run'",
    );
    this.#db.transaction(() => {
      for (const k of keys) {
        del.run(w.accountId, w.projectId, w.ownerSub, k);
        back.run(w.accountId, w.projectId, w.ownerSub, k);
      }
    })();
  }

  /** Remember an event the watch will never act on (codeoid's own commit, an untrusted head). */
  ignore(w: WatchRow, key: string, kind: TriggerKind, branch: string, note: string, at: number): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO loop_triggers (account_id, project_id, owner_sub, repo, watch_id, key, kind, branch, outcome, note, settled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ignored', ?, 1, ?)`,
      )
      .run(w.accountId, w.projectId, w.ownerSub, w.repo, w.id, key, kind, branch, note.slice(0, 500), at);
  }

  /**
   * Keep an event the watch had to skip (its branch busy, a bound reached)
   * waiting to retry, with no run. Its age is when it was first skipped.
   */
  defer(w: WatchRow, key: string, kind: TriggerKind, branch: string, pr: number | null, note: string, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO loop_triggers (account_id, project_id, owner_sub, repo, watch_id, key, kind, branch, outcome, note, settled, pr, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'retry', ?, 1, ?, ?)
         ON CONFLICT (account_id, project_id, owner_sub, key) DO UPDATE
           SET note = excluded.note, watch_id = excluded.watch_id, created_at = MIN(created_at, excluded.created_at)
         WHERE outcome = 'retry'`,
      )
      .run(w.accountId, w.projectId, w.ownerSub, w.repo, w.id, key, kind, branch, note.slice(0, 500), pr, at);
  }

  /** When `key` was first left waiting to retry, or null when it isn't waiting. */
  waitingSince(w: WatchRow, key: string): number | null {
    const row = this.#db
      .prepare("SELECT created_at FROM loop_triggers WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND key = ? AND outcome = 'retry'")
      .get(w.accountId, w.projectId, w.ownerSub, key) as { created_at: number } | null;
    return row?.created_at ?? null;
  }

  /**
   * Give up on this watch's events waiting to retry that were first recorded
   * before `before`, or that are on a pull request not in `openPrs` (null:
   * the open ones aren't all known). Returns how many expired.
   */
  expireRetries(w: WatchRow, before: number, openPrs: Set<number> | null): number {
    const rows = this.#db
      .prepare("SELECT key, pr, created_at FROM loop_triggers WHERE watch_id = ? AND outcome = 'retry'")
      .all(w.id) as Array<{ key: string; pr: number | null; created_at: number }>;
    const expire = this.#db.prepare(
      "UPDATE loop_triggers SET outcome = 'ignored', settled = 1, note = ? WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND key = ? AND outcome = 'retry'",
    );
    let n = 0;
    this.#db.transaction(() => {
      for (const r of rows) {
        const why = r.created_at < before
          ? "expired: it waited a week without a run"
          : r.pr !== null && openPrs !== null && !openPrs.has(r.pr)
            ? `expired: pull request #${r.pr} is no longer open`
            : null;
        if (why) n += Number(expire.run(why, w.accountId, w.projectId, w.ownerSub, r.key).changes ?? 0);
      }
    })();
    return n;
  }

  /** Forget this watch's untrusted-head notes (its trust list changed: judge them again). */
  forgetUntrusted(w: WatchRow): void {
    this.#db.prepare("DELETE FROM loop_triggers WHERE watch_id = ? AND key LIKE ?").run(w.id, `untrusted:${w.id}:%`);
  }

  /** Runs this watch started that the ledger hasn't seen end. */
  unsettled(w: WatchRow): UnsettledRun[] {
    const rows = this.#db
      .prepare("SELECT run_id, key, retries FROM loop_triggers WHERE watch_id = ? AND run_id IS NOT NULL AND settled = 0 AND outcome = 'run'")
      .all(w.id) as Array<{ run_id: string; key: string; retries: number }>;
    const by = new Map<string, UnsettledRun>();
    for (const r of rows) {
      const u = by.get(r.run_id) ?? { runId: r.run_id, keys: [], retries: 0 };
      u.keys.push(r.key);
      u.retries = Math.max(u.retries, r.retries);
      by.set(r.run_id, u);
    }
    return [...by.values()];
  }

  /** The run ended: it no longer holds its branch. */
  settle(w: WatchRow, runId: string): void {
    this.#db.prepare("UPDATE loop_triggers SET settled = 1 WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND run_id = ?").run(w.accountId, w.projectId, w.ownerSub, runId);
  }

  /**
   * The run's workspace couldn't be prepared: give its keys back for another
   * try, or, past `max` tries or when trying again can't help (`retry`
   * false), ignore them for good with the reason. True when it gave up.
   */
  retryOrGiveUp(w: WatchRow, run: UnsettledRun, reason: string, max: number, retry = true): boolean {
    const tries = run.retries + 1;
    const giveUp = !retry || tries >= max;
    this.#db
      .prepare(
        giveUp
          ? "UPDATE loop_triggers SET outcome = 'ignored', settled = 1, retries = ?, note = ? WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND run_id = ?"
          : "UPDATE loop_triggers SET outcome = 'retry', settled = 1, retries = ?, note = ?, run_id = NULL WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND run_id = ?",
      )
      .run(
        tries,
        (!retry ? `the workspace can't be prepared: ${reason}` : giveUp ? `the workspace couldn't be prepared ${tries} times: ${reason}` : reason).slice(0, 500),
        w.accountId,
        w.projectId,
        w.ownerSub,
        run.runId,
      );
    return giveUp;
  }

  /** Whether the watch has events of `kind` waiting to retry. */
  hasRetries(w: WatchRow, kind: TriggerKind): boolean {
    return this.#db.prepare("SELECT 1 FROM loop_triggers WHERE watch_id = ? AND kind = ? AND outcome = 'retry' LIMIT 1").get(w.id, kind) !== null;
  }

  /** Runs any of the owner's watches started on `repo`'s `branch` that haven't been seen to end — what coalescing looks at. */
  runsOnBranch(w: WatchRow, branch: string, limit = 20): string[] {
    return (
      this.#db
        .prepare(
          `SELECT run_id, MAX(created_at) AS at FROM loop_triggers
           WHERE account_id = ? AND project_id = ? AND owner_sub = ? AND repo = ? AND branch = ? AND run_id IS NOT NULL AND settled = 0
           GROUP BY run_id ORDER BY at DESC LIMIT ?`,
        )
        .all(w.accountId, w.projectId, w.ownerSub, w.repo, branch, limit) as Array<{ run_id: string }>
    ).map((r) => r.run_id);
  }

  /** Distinct runs the watch started since `since` — the hourly bound. */
  runsSince(watchId: string, since: number): number {
    return (
      this.#db
        .prepare("SELECT COUNT(DISTINCT run_id) AS n FROM loop_triggers WHERE watch_id = ? AND run_id IS NOT NULL AND created_at >= ?")
        .get(watchId, since) as { n: number }
    ).n;
  }

  listTriggers(watchId: string, limit = 50): TriggerRow[] {
    return (
      this.#db.prepare("SELECT * FROM loop_triggers WHERE watch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(watchId, limit) as TriggerDbRow[]
    ).map((r) => ({
      watchId: r.watch_id,
      key: r.key,
      kind: r.kind as TriggerKind,
      branch: r.branch,
      runId: r.run_id,
      outcome: r.outcome as TriggerRow["outcome"],
      note: r.note,
      createdAt: r.created_at,
    }));
  }
}

/** Thrown inside a transaction to roll it back. */
class Rollback extends Error {}

function toWatch(r: WatchDbRow): WatchRow {
  return {
    id: r.id,
    accountId: r.account_id,
    projectId: r.project_id,
    ownerSub: r.owner_sub,
    ownerName: r.owner_name,
    workdir: r.workdir,
    repo: r.repo,
    spec: JSON.parse(r.spec_json) as WatchSpec,
    enabled: r.enabled === 1,
    lastPolledAt: r.last_polled_at,
    lastError: r.last_error,
    lastOkAt: r.last_ok_at,
    resumedAt: r.resumed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
