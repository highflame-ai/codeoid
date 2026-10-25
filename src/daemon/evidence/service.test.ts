import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceService, ephemeralCheck } from "./service";
import { EvidenceStore } from "./store";

const TENANT = { accountId: "acct-1", projectId: "proj-1" };
const OTHER = { accountId: "acct-2", projectId: "proj-1" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-evidence-svc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = { tenant: TENANT, ownerKind: "pipeline" as const, ownerId: "pipe-1" };

describe("EvidenceService", () => {
  test("a recorded failure survives reopening the database", async () => {
    const dbPath = join(dir, "db.sqlite");
    const svc = new EvidenceService(new EvidenceStore(dbPath), join(dir, "evidence"));
    const { record } = await svc.run({ id: "exit:test", command: "echo boom >&2; exit 1", timeoutMs: 5_000 }, dir, {
      ...ctx,
      candidateDigest: "tree-abc",
    });
    expect(record?.result).toBe("fail");

    const reopened = new EvidenceStore(new Database(dbPath));
    const back = reopened.get(record!.id, TENANT)!;
    expect(back.result).toBe("fail");
    expect(back.candidateDigest).toBe("tree-abc");
    expect(back.stderrExcerpt.trim()).toBe("boom");
    expect(back.exitCode).toBe(1);
    const stderr = back.artifacts.find((a) => a.name === "stderr")!;
    expect(readFileSync(stderr.path, "utf8").trim()).toBe("boom");
  });

  test("another tenant cannot read a record, and an unknown id looks the same", async () => {
    const svc = new EvidenceService(new EvidenceStore(":memory:"), join(dir, "evidence"));
    const { record } = await svc.run({ id: "c", command: "true", timeoutMs: 5_000 }, dir, ctx);
    expect(svc.get(record!.id, TENANT)?.id).toBe(record!.id);
    expect(svc.get(record!.id, OTHER)).toBeNull();
    expect(svc.get("ev_missing", TENANT)).toBeNull();
  });

  test("records list per owner, in order, within the tenant", async () => {
    const svc = new EvidenceService(new EvidenceStore(":memory:"), join(dir, "evidence"));
    const first = await svc.run({ id: "a", command: "true", timeoutMs: 5_000 }, dir, ctx);
    const second = await svc.run({ id: "b", command: "false", timeoutMs: 5_000 }, dir, ctx);
    await svc.run({ id: "c", command: "true", timeoutMs: 5_000 }, dir, { ...ctx, ownerId: "pipe-2" });
    expect(svc.listForOwner("pipeline", "pipe-1", TENANT).map((r) => r.id)).toEqual([first.record!.id, second.record!.id]);
    expect(svc.listForOwner("pipeline", "pipe-1", OTHER)).toEqual([]);
  });

  test("an owner id cannot place artifacts outside the artifact root", async () => {
    const root = join(dir, "evidence");
    const svc = new EvidenceService(new EvidenceStore(":memory:"), root);
    const { record } = await svc.run({ id: "c", command: "echo hi", timeoutMs: 5_000 }, dir, {
      ...ctx,
      ownerId: "../../escape",
    });
    for (const a of record!.artifacts) expect(a.path.startsWith(`${root}/`)).toBe(true);
  });

  test("an unrecorded check leaves no files behind", async () => {
    const { outcome, record } = await ephemeralCheck({ id: "c", command: "echo hi", timeoutMs: 5_000 }, dir);
    expect(record).toBeUndefined();
    expect(outcome.stdoutExcerpt.trim()).toBe("hi");
    for (const a of outcome.artifacts) expect(existsSync(a.path)).toBe(false);
  });
});
