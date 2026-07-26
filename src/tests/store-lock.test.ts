/**
 * SQLite lock robustness — every writable store must wait for a lock, not die.
 *
 * SQLite's default `busy_timeout` is 0: it fails INSTANTLY on contention. That
 * is only reasonable for a single-connection process, and codeoid is not one —
 * it opens the sessions store, the memory store, the memory-cards store, the
 * pipeline store, and (if a second daemon runs) another set over the same WAL
 * databases.
 *
 * The observed failure: two daemons starting against the same fresh database
 * both ran `PRAGMA journal_mode = WAL`, which takes a brief exclusive lock while
 * it CHANGES the mode. The loser died inside `new DaemonServer` with a raw
 *
 *     SQLiteError: database is locked
 *
 * stack trace — before the daemon could say which file was involved or that
 * another instance was probably running. Mode-independent: `new Store()` runs
 * before the auth posture is chosen, so ZeroID and local mode were hit alike.
 *
 * Asserted two ways, neither of which races two processes (so neither flakes):
 *   1. behaviourally on the sessions store, which exposes its connection and is
 *      the one in the crash path;
 *   2. structurally on all four writable stores — the pragma must be present AND
 *      ordered BEFORE `journal_mode`, because setting it afterwards leaves
 *      exactly the statement that failed unprotected.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUSY_TIMEOUT_MS, Store } from "../daemon/store.js";
import { SessionCardStore } from "../daemon/memory/cards.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import { PipelineStore } from "../daemon/pipeline/store.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-store-lock-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Read the busy timeout back out of a live connection. */
function busyTimeoutOf(db: Database): number {
  const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number } | null;
  return row?.timeout ?? 0;
}

describe("sessions store — behavioural", () => {
  it("sets a non-zero busy_timeout on its connection", () => {
    const store = new Store(join(tmp(), "codeoid.db"));
    try {
      // 0 would mean "fail instantly on contention" — the bug.
      expect(BUSY_TIMEOUT_MS).toBeGreaterThan(0);
      expect(busyTimeoutOf(store.database)).toBe(BUSY_TIMEOUT_MS);
    } finally {
      store.close();
    }
  });

  it("a second connection to the same WAL database also gets the timeout", () => {
    // The real two-daemon shape: one file, two independent Store instances.
    const path = join(tmp(), "shared.db");
    const first = new Store(path);
    const second = new Store(path);
    try {
      expect(busyTimeoutOf(first.database)).toBe(BUSY_TIMEOUT_MS);
      expect(busyTimeoutOf(second.database)).toBe(BUSY_TIMEOUT_MS);
    } finally {
      second.close();
      first.close();
    }
  });

  it("opens fine while another connection is merely READING", () => {
    // Under WAL a reader never blocks the migration's write lock, so this is the
    // common case (a second daemon attaching to an initialized database).
    const path = join(tmp(), "reader.db");
    const first = new Store(path);
    const reader = new Database(path);
    try {
      reader.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      reader.prepare("SELECT count(*) AS n FROM sessions").get();

      const second = new Store(path);
      expect(busyTimeoutOf(second.database)).toBe(BUSY_TIMEOUT_MS);
      second.close();
    } finally {
      reader.close();
      first.close();
    }
  });
});

describe("concurrent cold start — two processes, one fresh database", () => {
  // The actual reported failure. Two daemons initializing the same fresh db
  // raced on two independent things, and BOTH had to be fixed:
  //   1. `PRAGMA journal_mode = WAL` — SQLITE_BUSY, and busy_timeout does not
  //      cover a journal-mode change (see enableWalWithRetry).
  //   2. the add-column migration steps — check-then-act, so both processes saw
  //      a column missing and the second ALTER died "duplicate column name".
  // Baseline before the fixes: 4 failures in 8 rounds. This runs real
  // subprocesses because in-process opens cannot reproduce either race.
  const RUNNER = resolve(import.meta.dir, "fixtures/open-store.ts");

  it("both processes open the database successfully", async () => {
    const dir = tmp();
    const dbPath = join(dir, "race.db");

    const spawn = () =>
      Bun.spawn(["bun", RUNNER, dbPath], { stdout: "pipe", stderr: "pipe" });
    // Started back-to-back with no await between, so their inits overlap.
    const [a, b] = [spawn(), spawn()];
    const [outA, outB, codeA, codeB] = await Promise.all([
      new Response(a.stdout).text(),
      new Response(b.stdout).text(),
      a.exited,
      b.exited,
    ]);

    // Report the actual failure text — a bare exit code is useless here.
    expect({ codeA, outA: outA.trim() }).toEqual({ codeA: 0, outA: "OK" });
    expect({ codeB, outB: outB.trim() }).toEqual({ codeB: 0, outB: "OK" });
  }, 30_000);
});

describe("all writable stores — structural", () => {
  // Ordering is the invariant, not mere presence: `journal_mode = WAL` is the
  // statement that took the lock and died, so a busy_timeout set after it would
  // leave the original bug intact while looking fixed.
  //
  // `daemon/store.ts` is deliberately NOT in this list: its journal-mode switch
  // lives in a helper defined above the constructor, so source order no longer
  // tracks execution order there. It is covered behaviourally above instead
  // (it's the only store that exposes its connection).
  const STORES = [
    "../daemon/memory/store.ts",
    "../daemon/memory/cards.ts",
    "../daemon/pipeline/store.ts",
  ];

  for (const rel of STORES) {
    it(`${rel} sets busy_timeout before journal_mode`, () => {
      const src = readFileSync(resolve(import.meta.dir, rel), "utf8");
      const busy = src.indexOf("PRAGMA busy_timeout");
      const wal = src.indexOf("PRAGMA journal_mode");

      expect(busy).toBeGreaterThan(-1); // present at all
      expect(wal).toBeGreaterThan(-1); // sanity: we found the right file
      expect(busy).toBeLessThan(wal); // and ordered first
    });
  }
});

describe("the other stores still construct and query under the pragma", () => {
  it("memory episode store", () => {
    const store = new SqliteEpisodeStore(join(tmp(), "memory.db"));
    // Migrations ran and the schema is queryable — the pragma broke neither.
    // (needsWorkspaceMigration() is true on a fresh db by design, so it is not
    // a signal about the pragma; a successful query is.)
    expect(store.listTurnsForSession("nope")).toEqual([]);
    expect(store.vectorCacheStats().workspaces).toBe(0);
  });

  it("memory session-cards store", () => {
    const store = new SessionCardStore(join(tmp(), "cards.db"));
    expect(store.getCard("nope")).toBeNull();
  });

  it("pipeline store owning its own connection", () => {
    const store = new PipelineStore(join(tmp(), "pipelines.db"));
    expect(store.listActive()).toEqual([]);
  });
});

describe("an unopenable database reports something actionable", () => {
  it("names the path and the likely cause instead of a bare driver error", () => {
    // A directory where the db file should be: guaranteed unopenable, and the
    // closest reproducible stand-in for the permission/corruption cases.
    const path = tmp();

    let thrown: unknown;
    try {
      new Store(path);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // The three things a user needs: what failed, where, and what to try next.
    expect(msg).toContain("Cannot open the codeoid database");
    expect(msg).toContain(path);
    expect(msg).toContain("another codeoid daemon may already be running");
    expect(msg).toContain("XDG_CONFIG_HOME");
    // The driver error is preserved for debugging, not swallowed.
    expect((thrown as Error).cause).toBeDefined();
  });
});
