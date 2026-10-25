import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
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

  test("aborting an owner stops its running checks and records them cancelled", async () => {
    const svc = new EvidenceService(new EvidenceStore(":memory:"), join(dir, "evidence"));
    const running = svc.run({ id: "c", command: "sleep 30", timeoutMs: 60_000 }, dir, ctx);
    const other = svc.run({ id: "c", command: "sleep 0.3", timeoutMs: 60_000 }, dir, { ...ctx, ownerId: "pipe-2" });
    await Bun.sleep(150);
    svc.abortOwner("pipeline", "pipe-1");
    expect((await running).record?.result).toBe("cancelled");
    expect((await other).record?.result).toBe("pass");
  });

  test("retention drops old records, then the oldest past the size cap, with their files", async () => {
    const svc = new EvidenceService(new EvidenceStore(":memory:"), join(dir, "evidence"));
    const a = (await svc.run({ id: "a", command: "head -c 3000 /dev/zero", timeoutMs: 5_000 }, dir, ctx)).record!;
    await Bun.sleep(5);
    const b = (await svc.run({ id: "b", command: "head -c 3000 /dev/zero", timeoutMs: 5_000 }, dir, ctx)).record!;
    await Bun.sleep(5);
    const c = (await svc.run({ id: "c", command: "head -c 3000 /dev/zero", timeoutMs: 5_000 }, dir, ctx)).record!;
    // Size cap fits two records: the oldest goes.
    expect(svc.sweep({ maxAgeMs: 1e12, maxTotalBytes: 6_500 })).toBe(1);
    expect(svc.get(a.id, TENANT)).toBeNull();
    expect(existsSync(a.artifacts[0]!.path)).toBe(false);
    expect(svc.get(b.id, TENANT)).not.toBeNull();
    // Age: everything started before now+1 goes.
    expect(svc.sweep({ maxAgeMs: -1, maxTotalBytes: 1e12 })).toBe(2);
    expect(existsSync(c.artifacts[0]!.path)).toBe(false);
  });

  test("retention removes artifact directories no record points at, once they are old", async () => {
    const root = join(dir, "evidence");
    const svc = new EvidenceService(new EvidenceStore(":memory:"), root);
    const orphan = join(root, "pipeline", "pipe-x", "stale");
    const fresh = join(root, "pipeline", "pipe-x", "fresh");
    mkdirSync(orphan, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(orphan, old, old);
    svc.sweep();
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("an unrecorded check leaves no files behind", async () => {
    const { outcome, record } = await ephemeralCheck({ id: "c", command: "echo hi", timeoutMs: 5_000 }, dir);
    expect(record).toBeUndefined();
    expect(outcome.stdoutExcerpt.trim()).toBe("hi");
    for (const a of outcome.artifacts) expect(existsSync(a.path)).toBe(false);
  });
});
