/**
 * The adapter's whole job is absorbing four measured bun:sqlite/node:sqlite
 * divergences, and `bun test` only ever exercises the bun branch — so the node
 * branch is driven through a real `node` subprocess. Node >= 22.6 strips types
 * on import, so the source file runs unbuilt.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSY_TIMEOUT_MS, Database } from "./db.js";

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "codeoid-db-")), "t.db");

/** Run `src` under plain node against the same adapter; returns its stdout. */
async function underNode(src: string): Promise<string> {
  const proc = Bun.spawn(
    ["node", "--input-type=module", "-e", `import("${import.meta.dir}/db.ts").then(async (m) => {${src}})`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`node failed: ${err}`);
  return out.trim();
}

const SEED = `const db = new m.Database(":memory:", { create: true });
  db.exec("CREATE TABLE t(a TEXT, b INTEGER)");`;

describe("sqlite adapter", () => {
  test("shares one busy-timeout definition", () => {
    expect(BUSY_TIMEOUT_MS).toBe(5_000);
  });

  test("bun: binds undefined as NULL and booleans as 1/0", () => {
    const db = new Database(tmpDb(), { create: true });
    db.exec("CREATE TABLE t(a TEXT, b INTEGER)");
    db.prepare("INSERT INTO t VALUES (?,?)").run(undefined, true);
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ a: null, b: 1 }]);
    db.close();
  });

  test("node: binds undefined as NULL and booleans as 1/0", async () => {
    // node:sqlite THROWS on both without the adapter's normalization.
    const out = await underNode(`${SEED}
    db.prepare("INSERT INTO t VALUES (?,?)").run(undefined, true);
    console.log(JSON.stringify(db.prepare("SELECT * FROM t").all()));`);
    expect(JSON.parse(out)).toEqual([{ a: null, b: 1 }]);
  });

  test("node: get() returns null for no row, as bun does", async () => {
    // node:sqlite returns undefined here; `=== null` checks in store.ts would flip.
    const out = await underNode(`${SEED}
    console.log(JSON.stringify(db.prepare("SELECT * FROM t WHERE a='zz'").get()));`);
    expect(out).toBe("null");
  });

  test("node: FTS5 + bm25() are available", async () => {
    const out = await underNode(`const db = new m.Database(":memory:", { create: true });
    db.exec("CREATE VIRTUAL TABLE f USING fts5(body)");
    db.prepare("INSERT INTO f(body) VALUES (?)").run("the quick brown fox");
    const rows = db.prepare("SELECT bm25(f) AS s FROM f WHERE f MATCH ?").all("quick");
    console.log(String(rows.length));`);
    expect(out).toBe("1");
  });

  test("node: a nested transaction rolls back only its own work", async () => {
    // bun:sqlite nests via SAVEPOINT; a naive BEGIN/COMMIT shim would either
    // throw on the inner BEGIN or discard the outer writes on inner failure.
    const out = await underNode(`${SEED}
    const ins = db.prepare("INSERT INTO t VALUES (?,?)");
    db.transaction(() => {
      ins.run("outer", 1);
      try {
        db.transaction(() => { ins.run("inner", 2); throw new Error("nope"); })();
      } catch {}
    })();
    console.log(JSON.stringify(db.prepare("SELECT a FROM t ORDER BY a").all()));`);
    expect(JSON.parse(out)).toEqual([{ a: "outer" }]);
  });

  test("bun: a nested transaction rolls back only its own work", () => {
    const db = new Database(tmpDb(), { create: true });
    db.exec("CREATE TABLE t(a TEXT, b INTEGER)");
    const ins = db.prepare("INSERT INTO t VALUES (?,?)");
    db.transaction(() => {
      ins.run("outer", 1);
      try {
        db.transaction(() => {
          ins.run("inner", 2);
          throw new Error("nope");
        })();
      } catch {}
    })();
    expect(db.prepare("SELECT a FROM t ORDER BY a").all()).toEqual([{ a: "outer" }]);
    db.close();
  });
});
