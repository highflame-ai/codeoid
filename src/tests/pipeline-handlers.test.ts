/**
 * Pipeline control-plane handlers — pipeline.* messages routed through the real
 * SessionManager.handle(), covering scope enforcement, tenancy, validation, and
 * the create → list → get → abort lifecycle over the wire.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, PipelineWire } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:t",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const CLIENT = { id: "c", auth: AUTH, send: () => {} };

function mkConfig(dbPath: string, enabled: boolean): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-plh-transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: {
      enabled: false,
      warnPct: 0.6,
      rotatePct: 0.8,
      hardRotatePct: 0.9,
      minTurnsBeforeRotate: 3,
      strategy: "task-anchor",
    },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    dispatch: {
      enabled: false,
      tickMs: 999_999,
      leaseMs: 60_000,
      failureLimit: 2,
      maxConcurrentWorkers: 2,
      workerToolBudget: 7,
      retryBaseMs: 0,
    },
    pipeline: { enabled, defaultPack: null, packs: [] },
  };
}

function snapshot(m: DaemonMessage): PipelineWire {
  if (m.type !== "pipeline.snapshot") throw new Error(`expected pipeline.snapshot, got ${m.type}`);
  return m.pipeline;
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-plh-"));
  mkdirSync(join(tmp, "repo"), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db"), true),
  });
});

afterEach(async () => {
  try {
    await manager.drain(3_000);
  } catch {}
  try {
    await transcript.flush();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

describe("pipeline.* handlers", () => {
  test("create → list → get → abort lifecycle over the wire", async () => {
    const created = snapshot(
      await manager.handle(
        {
          type: "pipeline.create",
          id: "1",
          name: "REQ-1",
          phases: [{ id: "one", kind: "noop", gate: "always" }],
          workdir: join(tmp, "repo"),
        },
        AUTH,
        CLIENT,
      ),
    );
    expect(created.status).toBe("draft");
    const pid = created.id;

    const list = await manager.handle({ type: "pipeline.list", id: "2" }, AUTH, CLIENT);
    if (list.type !== "pipeline.list.result") throw new Error("expected list.result");
    expect(list.pipelines.map((p) => p.id)).toContain(pid);

    const got = snapshot(await manager.handle({ type: "pipeline.get", id: "3", pipelineId: pid }, AUTH, CLIENT));
    expect(got.id).toBe(pid);

    const aborted = snapshot(await manager.handle({ type: "pipeline.abort", id: "4", pipelineId: pid }, AUTH, CLIENT));
    expect(aborted.status).toBe("abandoned");
  });

  test("advance + halt→answer→resume round-trip over the wire", async () => {
    const created = snapshot(
      await manager.handle(
        {
          type: "pipeline.create",
          id: "1",
          name: "R",
          phases: [
            { id: "gate", kind: "noop", gate: "manual" },
            { id: "tail", kind: "noop", gate: "always" },
          ],
          workdir: join(tmp, "repo"),
        },
        AUTH,
        CLIENT,
      ),
    );
    expect(created.status).toBe("draft");
    const pid = created.id;

    const advanced = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: pid }, AUTH, CLIENT));
    expect(advanced.status).toBe("halted");
    const halted = advanced.phases[0];
    expect(halted.status).toBe("halted");
    expect(halted.requestId).toBe("exit:gate");
    expect(halted.reason).toBeDefined();

    // Approving "gate" records "ok" and resumes into "tail", which runs and then
    // halts at its own boundary (every phase halts for a human).
    const resumed = snapshot(
      await manager.handle(
        { type: "pipeline.answer", id: "3", pipelineId: pid, requestId: halted.requestId ?? "", approved: true, value: "ok" },
        AUTH,
        CLIENT,
      ),
    );
    expect(resumed.status).toBe("halted");
    expect(resumed.phases[0].status).toBe("passed");
    expect(resumed.phases[0].summary).toBe("ok");
    // Approve the "tail" boundary → done.
    const done = snapshot(
      await manager.handle(
        { type: "pipeline.answer", id: "4", pipelineId: pid, requestId: resumed.phases[resumed.cursor].requestId ?? "", approved: true },
        AUTH,
        CLIENT,
      ),
    );
    expect(done.status).toBe("done");
    expect(done.phases[1].status).toBe("passed");
  });

  test("advance requires the PIPELINE_CREATE scope", async () => {
    const created = snapshot(
      await manager.handle(
        { type: "pipeline.create", id: "1", name: "R", phases: [{ id: "one", kind: "noop" }], workdir: join(tmp, "repo") },
        AUTH,
        CLIENT,
      ),
    );
    const readOnly: AuthContext = { ...AUTH, scopes: [SCOPES.PIPELINE_READ] as AuthContext["scopes"] };
    const r = await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, readOnly, CLIENT);
    expect(r.type).toBe("response.error");
    if (r.type === "response.error") expect(r.code).toBe("forbidden");
  });

  test("cross-tenant answer / abort → not_found", async () => {
    const created = snapshot(
      await manager.handle(
        {
          type: "pipeline.create",
          id: "1",
          name: "R",
          phases: [{ id: "one", kind: "noop", gate: "manual" }],
          workdir: join(tmp, "repo"),
        },
        AUTH,
        CLIENT,
      ),
    );
    const other: AuthContext = { ...AUTH, accountId: "other-acc" };
    const a = await manager.handle(
      { type: "pipeline.answer", id: "2", pipelineId: created.id, requestId: "exit:one", approved: true },
      other,
      CLIENT,
    );
    expect(a.type).toBe("response.error");
    if (a.type === "response.error") expect(a.code).toBe("not_found");
    const b = await manager.handle({ type: "pipeline.abort", id: "3", pipelineId: created.id }, other, CLIENT);
    expect(b.type).toBe("response.error");
    if (b.type === "response.error") expect(b.code).toBe("not_found");
  });

  test("create rejects an unusable workdir and an unknown provider", async () => {
    const badWd = await manager.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        phases: [{ id: "one", kind: "noop" }],
        workdir: "/nonexistent/does/not/exist",
      },
      AUTH,
      CLIENT,
    );
    expect(badWd.type).toBe("response.error");
    if (badWd.type === "response.error") expect(badWd.code).toBe("invalid_request");

    const badProv = await manager.handle(
      {
        type: "pipeline.create",
        id: "2",
        name: "R",
        phases: [{ id: "one", kind: "noop", provider: "nope-provider" }],
        workdir: join(tmp, "repo"),
      },
      AUTH,
      CLIENT,
    );
    expect(badProv.type).toBe("response.error");
    if (badProv.type === "response.error") expect(badProv.error).toContain("provider");
  });

  test("create rejects a role binding naming an unknown provider (§5)", async () => {
    const r = await manager.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        phases: [{ id: "one", kind: "noop", role: "worker" }],
        workdir: join(tmp, "repo"),
        roleBindings: { worker: { provider: "nope-provider" } },
      },
      AUTH,
      CLIENT,
    );
    expect(r.type).toBe("response.error");
    if (r.type === "response.error") {
      expect(r.code).toBe("invalid_request");
      expect(r.error).toContain('unknown provider "nope-provider"');
    }
  });

  test("create persists a role binding's provider/model + resolvedFrom on the phase wire", async () => {
    const created = snapshot(
      await manager.handle(
        {
          type: "pipeline.create",
          id: "1",
          name: "R",
          phases: [{ id: "one", kind: "noop", role: "worker" }],
          workdir: join(tmp, "repo"),
          roleBindings: { worker: { provider: "claude", model: "claude-fable-5" } },
        },
        AUTH,
        CLIENT,
      ),
    );
    expect(created.phases[0]).toMatchObject({
      provider: "claude",
      model: "claude-fable-5",
      resolvedFrom: "cli",
    });
  });

  test("create validation surfaces as response.error", async () => {
    const r = await manager.handle(
      { type: "pipeline.create", id: "1", name: "x", phases: [{ id: "one", kind: "nope" }] },
      AUTH,
      CLIENT,
    );
    expect(r.type).toBe("response.error");
    if (r.type === "response.error") expect(r.error).toContain("unknown kind");
  });

  test("missing scope → forbidden", async () => {
    const noScope: AuthContext = { ...AUTH, scopes: [] as AuthContext["scopes"] };
    const r = await manager.handle({ type: "pipeline.list", id: "1" }, noScope, CLIENT);
    expect(r.type).toBe("response.error");
    if (r.type === "response.error") expect(r.code).toBe("forbidden");
  });

  test("cross-tenant get → not_found", async () => {
    const created = snapshot(
      await manager.handle(
        {
          type: "pipeline.create",
          id: "1",
          name: "x",
          phases: [{ id: "one", kind: "noop" }],
          workdir: join(tmp, "repo"),
        },
        AUTH,
        CLIENT,
      ),
    );
    const other: AuthContext = { ...AUTH, accountId: "other-acc" };
    const r = await manager.handle({ type: "pipeline.get", id: "2", pipelineId: created.id }, other, CLIENT);
    expect(r.type).toBe("response.error");
    if (r.type === "response.error") expect(r.code).toBe("not_found");
  });

  test("disabled pipeline → invalid_request", async () => {
    const store2 = new Store(join(tmp, "codeoid2.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid2.db"), false),
    });
    const r = await m2.handle({ type: "pipeline.list", id: "1" }, AUTH, CLIENT);
    expect(r.type).toBe("response.error");
    if (r.type === "response.error") expect(r.code).toBe("invalid_request");
  });
});
