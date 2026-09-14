/**
 * Runtime-agnostic SQLite handle.
 *
 * The memory engine runs in two places now: inside the codeoid daemon (Bun) and
 * inside the standalone `codeoid-memory` MCP server, which must run under plain
 * `npx` on Node — requiring Bun there would reintroduce the install tax the
 * standalone package exists to remove.
 *
 * `bun:sqlite` and `node:sqlite` agree on the shape that matters (`exec`,
 * `prepare` → `get`/`all`/`run`, positional params, FTS5 + `bm25()`), so this
 * adapter only has to absorb four measured divergences:
 *
 *   1. `node:sqlite` THROWS on an `undefined` parameter; bun binds NULL.
 *   2. `node:sqlite` THROWS on a boolean parameter; bun binds 1/0.
 *   3. `node:sqlite`'s `.get()` returns `undefined` for no row; bun returns `null`.
 *   4. `node:sqlite` has no `.transaction()` at all.
 *
 * 1-3 are normalized toward the bun behaviour the callers were written against,
 * so `store.ts` / `cards.ts` stay runtime-unaware.
 */

import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const onBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
}

/** undefined → null, boolean → 1/0. Everything else passes through untouched. */
function bindable(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

/** Wraps a node:sqlite StatementSync so it answers like a bun:sqlite Statement. */
function adaptStatement(stmt: {
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
  run(...p: unknown[]): { changes: number; lastInsertRowid: number };
}): SqliteStatement {
  return {
    get: (...params) => stmt.get(...bindable(params)) ?? null,
    all: (...params) => stmt.all(...bindable(params)),
    run: (...params) => stmt.run(...bindable(params)),
  };
}

export class Database {
  // biome-ignore lint/suspicious/noExplicitAny: the two driver types are structurally compatible but nominally unrelated.
  readonly #inner: any;
  /** SAVEPOINT nesting depth — mirrors bun:sqlite's nestable transactions. */
  #depth = 0;

  constructor(path: string, options?: { create?: boolean }) {
    if (onBun) {
      const { Database: BunDatabase } = req("bun:sqlite");
      this.#inner = new BunDatabase(path, options);
    } else {
      const { DatabaseSync } = req("node:sqlite");
      this.#inner = new DatabaseSync(path);
    }
  }

  exec(sql: string): void {
    this.#inner.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.#inner.prepare(sql);
    return onBun ? stmt : adaptStatement(stmt);
  }

  /**
   * Returns a function that runs `fn` in a transaction, like bun:sqlite's.
   * Nested calls open a SAVEPOINT instead of a second BEGIN, so an inner
   * rollback unwinds only its own work — the semantics callers already have.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    if (onBun) return this.#inner.transaction(fn);
    return (...args: A): R => {
      const top = this.#depth === 0;
      const sp = `codeoid_sp_${this.#depth}`;
      this.#inner.exec(top ? "BEGIN" : `SAVEPOINT ${sp}`);
      this.#depth++;
      try {
        const result = fn(...args);
        this.#depth--;
        this.#inner.exec(top ? "COMMIT" : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        this.#depth--;
        this.#inner.exec(top ? "ROLLBACK" : `ROLLBACK TO ${sp}`);
        throw err;
      }
    };
  }

  close(): void {
    this.#inner.close();
  }
}

/**
 * How long SQLite waits for a lock before giving up, on every writable store.
 *
 * SQLite defaults this to 0, which means "fail instantly" — a design that only
 * makes sense for a single-connection process. codeoid has several connections
 * (sessions store, memory store, memory cards, an optional second daemon) over
 * WAL databases, so brief contention is normal and instant failure is not.
 * 5s is far longer than any lock this daemon holds and far shorter than a user
 * would wait before assuming a hang.
 *
 * Lives here, beside the driver, because every writable store in the repo —
 * daemon and package alike — sets it from this one definition.
 */
export const BUSY_TIMEOUT_MS = 5_000;
