/**
 * End-to-end: a declarative pack on disk → loaded via config at boot →
 * create-from-pack over the wire → advanced through a real worker turn (mock
 * backend). This is the full path a client uses to run a shared methodology
 * pack (e.g. ai-factory's aif-sdlc), exercised without an SDK subprocess.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { PHASE_COMPLETE_MARKER } from "../daemon/pipeline/phase-completion.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, PipelineWire } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:t",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const CLIENT = { id: "c", auth: AUTH, send: () => {} };

function turnDone(): ProviderEvent {
  return {
    type: "turn_done",
    result: {
      providerId: "mock",
      model: "mock",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: 1,
    },
  } as ProviderEvent;
}
function sayTurn(text: string): ProviderEvent[] {
  // Every turn here represents a phase the model has COMPLETED, so emit the
  // completion marker — runPhaseOnSession only ends a phase when it sees it
  // (otherwise it nudges the model to keep going).
  return [
    { type: "text_done", content: `${text}\n${PHASE_COMPLETE_MARKER}` } as ProviderEvent,
    turnDone(),
  ];
}

const IMPLEMENTER_ROLE = `name: implementer
write: true
network: read-only
envelope: all
`;

const REVIEWER_ROLE = `name: reviewer
write: false
network: read-only
envelope: [read, grep, glob, bash]
`;

/** A gateless 2-phase pack: build (implementer) then check (reviewer). With no
 *  gates the run drives BOTH phases on one bound session, swapping the role. */
function writeTwoPhasePack(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-2phase-"));
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "roles", "implementer.yaml"), IMPLEMENTER_ROLE);
  writeFileSync(join(dir, "roles", "reviewer.yaml"), REVIEWER_ROLE);
  writeFileSync(
    join(dir, "pack.yaml"),
    `schema: codeoid/pack@v1
id: two-phase
name: Two Phase
version: 0.0.1
roles:
  - ./roles/implementer.yaml
  - ./roles/reviewer.yaml
skills:
  - { id: build, kind: slash, command: /build }
  - { id: check, kind: slash, command: /check }
phases:
  - { id: build, skill: build, role: implementer }
  - { id: check, skill: check, role: reviewer }
`,
  );
  return dir;
}

/** Write a fixture pack whose single skill phase is gated by a command gate. */
function writeE2EPack(gateRun: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-e2e-pack-"));
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "roles", "implementer.yaml"), IMPLEMENTER_ROLE);
  writeFileSync(
    join(dir, "pack.yaml"),
    `schema: codeoid/pack@v1
id: e2e-pack
name: E2E Pack
version: 0.0.1
roles:
  - ./roles/implementer.yaml
skills:
  - { id: build, kind: slash, command: /build }
gates:
  - { id: gate, kind: command, run: "${gateRun}" }
phases:
  - { id: impl, skill: build, role: implementer, gate: gate }
`,
  );
  return dir;
}

function mkConfig(dbPath: string, packDir: string, trusted: boolean, defaultPack: string | null): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-e2e-transcripts"),
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
    pipeline: { enabled: true, defaultPack, packs: [{ dir: packDir, trusted }] },
  };
}

function snapshot(m: DaemonMessage): PipelineWire {
  if (m.type !== "pipeline.snapshot") throw new Error(`expected pipeline.snapshot, got ${m.type}`);
  return m.pipeline;
}

/** The requestId of the phase currently halted at the cursor (every phase halts
 *  for a human decision — see docs/pipeline-run.md). */
function haltedReqId(w: PipelineWire): string {
  const ph = w.phases[w.cursor];
  if (!ph || ph.status !== "halted" || !ph.requestId) {
    throw new Error(`pipeline ${w.id} is not halted at cursor ${w.cursor} (status ${ph?.status})`);
  }
  return ph.requestId;
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;

function makeManager(packDir: string, trusted: boolean, defaultPack: string | null): SessionManager {
  return new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db"), packDir, trusted, defaultPack),
    _testProviderFactory: () => new MockSessionProvider("mock", [sayTurn("phase complete")]),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-e2e-"));
  mkdirSync(join(tmp, "repo"), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pack E2E (config → wire create-from-pack → advance)", () => {
  test("a trusted pack: phase runs, its command gate passes, then halts for review; approve → done", async () => {
    const packDir = writeE2EPack("true");
    const manager = makeManager(packDir, true, null);
    try {
      // Installed at boot from config.
      expect(manager.pipelines?.registries.packs.has("e2e-pack")).toBe(true);

      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "REQ-1", pack: "e2e-pack", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      expect(created.status).toBe("draft");
      expect(created.phases.map((p) => p.id)).toEqual(["impl"]);
      // The pack's capability role is projected onto the wire.
      expect(created.phases[0].role).toBe("implementer");

      // Even though the command gate passes, the phase HALTS for human review;
      // its produced output is surfaced at the halt.
      const halted = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(halted.status).toBe("halted");
      expect(halted.phases[0].summary).toContain("phase complete");

      // Approve the boundary → done.
      const done = snapshot(
        await manager.handle(
          { type: "pipeline.answer", id: "3", pipelineId: created.id, requestId: haltedReqId(halted), approved: true },
          AUTH,
          CLIENT,
        ),
      );
      expect(done.status).toBe("done");
      expect(done.phases[0].status).toBe("passed");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("a run binds a real attachable session and drives every phase on it, swapping the role per phase", async () => {
    const packDir = writeTwoPhasePack();
    const manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid.db"), packDir, true, null),
      _testProviderFactory: () => new MockSessionProvider("mock", [sayTurn("built it"), sayTurn("checked it")]),
    });
    try {
      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "R", pack: "two-phase", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      // The run is bound to a real session (not a headless, disposable worker).
      expect(created.sessionId).toBeTruthy();

      // Phase "build" runs + halts; approve → phase "check" runs + halts; approve → done.
      const h0 = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(h0.status).toBe("halted");
      expect(h0.cursor).toBe(0);
      const h1 = snapshot(
        await manager.handle(
          { type: "pipeline.answer", id: "3", pipelineId: created.id, requestId: haltedReqId(h0), approved: true },
          AUTH,
          CLIENT,
        ),
      );
      expect(h1.status).toBe("halted");
      expect(h1.cursor).toBe(1);
      const done = snapshot(
        await manager.handle(
          { type: "pipeline.answer", id: "4", pipelineId: created.id, requestId: haltedReqId(h1), approved: true },
          AUTH,
          CLIENT,
        ),
      );
      expect(done.status).toBe("done");
      expect(done.phases.map((p) => p.status)).toEqual(["passed", "passed"]);

      // The bound session is attachable (present in the session list), and its
      // ACTIVE role ended as the last phase's role — proving the one live
      // session ran both phases with the role swapped between them.
      const list = await manager.handle({ type: "session.list", id: "5" }, AUTH, CLIENT);
      if (list.type !== "session.list.result") throw new Error(`expected session.list.result, got ${list.type}`);
      const runSession = list.sessions.find((s) => s.id === created.sessionId);
      expect(runSession).toBeDefined();
      expect(runSession?.profile).toBe("two-phase (reviewer)");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("defaultPack: create with no phases/pack uses the configured default", async () => {
    const packDir = writeE2EPack("true");
    const manager = makeManager(packDir, true, "e2e-pack");
    try {
      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "REQ-1", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      expect(created.phases.map((p) => p.id)).toEqual(["impl"]);
      const halted = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(halted.status).toBe("halted");
      const done = snapshot(
        await manager.handle(
          { type: "pipeline.answer", id: "3", pipelineId: created.id, requestId: haltedReqId(halted), approved: true },
          AUTH,
          CLIENT,
        ),
      );
      expect(done.status).toBe("done");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("an UNTRUSTED pack's command gate fails closed → the pipeline halts", async () => {
    const packDir = writeE2EPack("true"); // gate would pass IF it ran — but untrusted, so it must not run
    const manager = makeManager(packDir, false, null);
    try {
      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "R", pack: "e2e-pack", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      const halted = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(halted.status).toBe("halted");
      if (halted.phases[0].status === "halted") expect(halted.phases[0].reason).toContain("trusted pack");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("revise re-runs a halted phase with feedback recorded, then approve → done", async () => {
    // Exit gate FAILS ("false") → the phase halts at its gate after each run.
    const packDir = writeE2EPack("false");
    const manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid.db"), packDir, true, null),
      _testProviderFactory: () => new MockSessionProvider("mock", [sayTurn("attempt one"), sayTurn("attempt two")]),
    });
    try {
      const created = snapshot(
        await manager.handle(
          { type: "pipeline.create", id: "1", name: "R", pack: "e2e-pack", spec: "add a flag", workdir: join(tmp, "repo") },
          AUTH,
          CLIENT,
        ),
      );
      const halted = snapshot(await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.id }, AUTH, CLIENT));
      expect(halted.status).toBe("halted");
      expect(halted.phases[0].status).toBe("halted");
      const reqId = halted.phases[0].requestId;
      expect(reqId).toBeTruthy();

      // Revise: re-run the SAME phase with feedback (a fresh attempt; the gate
      // still fails, so it halts again with a NEW requestId).
      const revised = snapshot(
        await manager.handle(
          { type: "pipeline.revise", id: "3", pipelineId: created.id, requestId: reqId as string, feedback: "handle the empty case" },
          AUTH,
          CLIENT,
        ),
      );
      expect(revised.status).toBe("halted");
      expect(revised.phases[0].feedback).toEqual(["handle the empty case"]);
      // A halt id is derived from the phase/gate, so it's stable across the
      // re-run — the client answers the revised halt with the same requestId.
      const reqId2 = revised.phases[0].requestId;
      expect(reqId2).toBe(reqId);

      // Approve = human override of the failing gate → single-phase pack → done.
      const done = snapshot(
        await manager.handle(
          { type: "pipeline.answer", id: "4", pipelineId: created.id, requestId: reqId2 as string, approved: true, value: "looks good" },
          AUTH,
          CLIENT,
        ),
      );
      expect(done.status).toBe("done");
      expect(done.phases[0].status).toBe("passed");
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("create with an unknown pack → invalid_request", async () => {
    const packDir = writeE2EPack("true");
    const manager = makeManager(packDir, true, null);
    try {
      const r = await manager.handle(
        { type: "pipeline.create", id: "1", name: "R", pack: "ghost", workdir: join(tmp, "repo") },
        AUTH,
        CLIENT,
      );
      expect(r.type).toBe("response.error");
      if (r.type === "response.error") {
        expect(r.code).toBe("invalid_request");
        expect(r.error).toContain("unknown pack");
      }
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });

  test("session.create with a pack role surfaces binding warnings on the response", async () => {
    // A role declaring a tier with no modelTiers mapping resolves to the
    // provider default (never an error), and the warning must reach the
    // CREATING CLIENT — not just the daemon console (role-model-binding §5).
    const packDir = mkdtempSync(join(tmpdir(), "codeoid-tier-pack-"));
    mkdirSync(join(packDir, "roles"), { recursive: true });
    writeFileSync(
      join(packDir, "roles", "adversary.yaml"),
      "name: adversary\ntier: reasoning-max\nwrite: false\nnetwork: read-only\nenvelope: all\n",
    );
    writeFileSync(
      join(packDir, "pack.yaml"),
      `schema: codeoid/pack@v1
id: tier-pack
name: Tier Pack
version: 0.0.1
roles:
  - ./roles/adversary.yaml
phases:
  - { id: attack, kind: noop, role: adversary }
`,
    );
    const manager = makeManager(packDir, false, null);
    try {
      const r = await manager.handle(
        {
          type: "session.create",
          id: "1",
          name: "adv",
          workdir: join(tmp, "repo"),
          pack: "tier-pack",
          packRole: "adversary",
        },
        AUTH,
        CLIENT,
      );
      expect(r.type).toBe("response.ok");
      if (r.type === "response.ok") {
        expect((r.warnings ?? []).join("\n")).toMatch(/tier "reasoning-max"/);
        expect((r.warnings ?? []).join("\n")).toMatch(/no modelTiers mapping/);
      }
      rmSync(packDir, { recursive: true, force: true });
    } finally {
      await manager.drain(3_000);
    }
  });
});
