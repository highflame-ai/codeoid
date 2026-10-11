import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PipelineState } from "./interface";
import { PipelineStore } from "./store";

function mk(id: string, over: Partial<PipelineState> = {}): PipelineState {
  const ts = 1_000;
  return {
    id,
    name: `p-${id}`,
    phases: [{ def: { id: "s1", kind: "noop" }, state: { status: "pending" } }],
    cursor: 0,
    status: "draft",
    accountId: "acct",
    projectId: "proj",
    createdBy: "user",
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

describe("PipelineStore", () => {
  test("save + get roundtrips the full state", () => {
    const store = new PipelineStore(new Database(":memory:"));
    const s = mk("a", { spec: "REQ-1" });
    store.save(s);
    expect(store.get("a")).toEqual(s);
    expect(store.get("missing")).toBeUndefined();
  });

  test("save upserts on the same id", () => {
    const store = new PipelineStore(new Database(":memory:"));
    store.save(mk("a"));
    store.save(mk("a", { status: "running", cursor: 1, updatedAt: 2_000 }));
    expect(store.get("a")?.status).toBe("running");
    expect(store.get("a")?.cursor).toBe(1);
  });

  test("activeSessionIds: only the tenant's non-terminal runs, only real session ids", () => {
    const store = new PipelineStore(new Database(":memory:"));
    store.save(mk("draft", { status: "draft", sessionId: "s-draft" }));
    store.save(mk("running", { status: "running", sessionId: "s-running" }));
    store.save(mk("halted", { status: "halted", sessionId: "s-halted" }));
    for (const st of ["merged", "done", "failed", "abandoned"] as const) store.save(mk(st, { status: st, sessionId: `s-${st}` }));
    store.save(mk("no-session", { status: "running" }));
    store.save(mk("other-tenant", { status: "running", sessionId: "s-other", accountId: "other" }));
    expect(store.activeSessionIds("acct", "proj").sort()).toEqual(["s-draft", "s-halted", "s-running"]);
    expect(store.activeSessionIds("other", "proj")).toEqual(["s-other"]);
  });

  test("activeSessionIds skips a corrupt row instead of failing the whole tenant", () => {
    const db = new Database(":memory:");
    const store = new PipelineStore(db);
    store.save(mk("good", { status: "running", sessionId: "s-good" }));
    store.save(mk("bad", { status: "running", sessionId: "s-bad" }));
    db.prepare("UPDATE pipelines SET state_json = '{not json' WHERE id = 'bad'").run();
    expect(store.activeSessionIds("acct", "proj")).toEqual(["s-good"]);
  });

  test("listByTenant filters by tenant and orders newest first", () => {
    const store = new PipelineStore(new Database(":memory:"));
    store.save(mk("a", { createdAt: 1 }));
    store.save(mk("b", { createdAt: 2 }));
    store.save(mk("c", { accountId: "other", createdAt: 3 }));
    expect(store.listByTenant("acct", "proj").map((p) => p.id)).toEqual(["b", "a"]);
  });

  test("listActive excludes terminal pipelines", () => {
    const store = new PipelineStore(new Database(":memory:"));
    store.save(mk("draft", { status: "draft" }));
    store.save(mk("run", { status: "running" }));
    store.save(mk("halt", { status: "halted" }));
    store.save(mk("done", { status: "done" }));
    store.save(mk("fail", { status: "failed" }));
    store.save(mk("gone", { status: "abandoned" }));
    expect(
      store
        .listActive()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["draft", "halt", "run"]);
  });

  test("delete removes a pipeline", () => {
    const store = new PipelineStore(new Database(":memory:"));
    store.save(mk("a"));
    store.delete("a");
    expect(store.get("a")).toBeUndefined();
  });
});
