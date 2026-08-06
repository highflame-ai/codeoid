/**
 * Pipeline runtime integration — the REAL SessionManager driving a pipeline
 * phase through a turn on the run's BOUND session, with a MockSessionProvider
 * (no SDK subprocess). Exercises: pipeline.create binds a session → advance →
 * SessionPhaseRunner → runPhaseOnSession → bound session → mock backend →
 * lastAssistantText → phase summary. (No headless worker; the run drives a real
 * attachable session — see docs/pipeline-run.md.)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { PHASE_COMPLETE_MARKER, PHASE_NEEDS_INPUT_MARKER } from "../daemon/pipeline/phase-completion.js";
import { CAPABILITIES } from "../protocol/types.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext } from "../protocol/types.js";

const tenant = { accountId: "acc", projectId: "proj", createdBy: "user:test" };
const AUTH: AuthContext = {
  sub: tenant.createdBy,
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: tenant.accountId,
  projectId: tenant.projectId,
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
  return [{ type: "text_done", content: text } as ProviderEvent, turnDone()];
}
function errorTurn(): ProviderEvent[] {
  return [
    {
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
        isError: true,
        errorMessage: "backend blew up",
      },
    } as ProviderEvent,
  ];
}

function mkConfig(dbPath: string, pipelineEnabled: boolean): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-pl-transcripts"),
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
    pipeline: { enabled: pipelineEnabled, defaultPack: null, packs: [] },
  };
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-pipeline-runner-"));
  mkdirSync(join(tmp, "repo"), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db"), true),
    _testProviderFactory: () =>
      new MockSessionProvider("mock", [sayTurn(`phase complete: implemented X\n${PHASE_COMPLETE_MARKER}`)]),
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

describe("pipeline runtime (real SessionManager + mock backend)", () => {
  test("a skill phase drives a turn on the bound session and captures its final text as the summary", async () => {
    const pm = manager.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "implement", kind: "slash", command: "/implement" });
    // Go through the wire handler so a run-session is created + bound (the real
    // path); driving pm.create directly would leave the run session-less.
    const created = await manager.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "REQ-1",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "implement" }],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    expect(created.pipeline.sessionId).toBeTruthy();
    // The phase runs a turn on the bound session, then halts for review with its
    // produced text surfaced.
    const halted = await manager.handle({ type: "pipeline.advance", id: "2", pipelineId: created.pipeline.id }, AUTH, CLIENT);
    if (halted.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(halted)}`);
    expect(halted.pipeline.status).toBe("halted");
    const halt = halted.pipeline.phases[0];
    expect(halt.status).toBe("halted");
    expect(halt.summary).toContain("phase complete");
    if (halt.status !== "halted" || !halt.requestId) throw new Error("expected halt with requestId");
    // Approve → the run's captured summary is the phase's output.
    const done = await manager.handle(
      { type: "pipeline.answer", id: "3", pipelineId: created.pipeline.id, requestId: halt.requestId, approved: true },
      AUTH,
      CLIENT,
    );
    if (done.type !== "pipeline.snapshot") throw new Error(`answer failed: ${JSON.stringify(done)}`);
    expect(done.pipeline.status).toBe("done");
    const ph = done.pipeline.phases[0];
    expect(ph.status).toBe("passed");
    expect(ph.summary).toContain("phase complete");
  });

  test("phase 2 completes with its OWN output, not a reuse of phase 1's summary", async () => {
    // Guards the cross-phase-contamination class (issue: architecture instantly
    // 'completed' reusing spec's marker-terminated output). Each phase gets its
    // own scripted turn; phase 2's summary must be its own text. (The provider-
    // specific query-loop REBUILD idle that triggered the original reuse isn't
    // reproducible in the mock — one turn per send, no auto-continue — so this is
    // the strongest feasible integration guard; the root fix is the post-send
    // history re-baseline in runPhaseOnSession.)
    const store2 = new Store(join(tmp, "codeoid-2ph.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-2ph.db"), true),
      _testProviderFactory: () =>
        new MockSessionProvider("mock", [
          sayTurn(`SPEC deliverable written\n${PHASE_COMPLETE_MARKER}`),
          sayTurn(`ARCHITECTURE design — distinct from spec\n${PHASE_COMPLETE_MARKER}`),
        ]),
    });
    const pm = m2.pipelines;
    if (!pm) return;
    pm.registries.skills.register({ id: "spec", kind: "slash", command: "/spec" });
    pm.registries.skills.register({ id: "arch", kind: "slash", command: "/arch" });
    const created = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "REQ-2",
        workdir: join(tmp, "repo"),
        phases: [
          { id: "spec", kind: "skill", skill: "spec" },
          { id: "architecture", kind: "skill", skill: "arch" },
        ],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    const id = created.pipeline.id;

    // Phase 1 (spec) runs + halts with the spec output.
    const p1 = await m2.handle({ type: "pipeline.advance", id: "2", pipelineId: id }, AUTH, CLIENT);
    if (p1.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(p1)}`);
    const spec = p1.pipeline.phases[0];
    expect(spec.status).toBe("halted");
    expect(spec.summary).toContain("SPEC deliverable");
    if (spec.status !== "halted" || !spec.requestId) throw new Error("expected spec halt");

    // Approve spec → phase 2 (architecture) runs its OWN turn and halts.
    const p2 = await m2.handle(
      { type: "pipeline.answer", id: "3", pipelineId: id, requestId: spec.requestId, approved: true },
      AUTH,
      CLIENT,
    );
    if (p2.type !== "pipeline.snapshot") throw new Error(`answer failed: ${JSON.stringify(p2)}`);
    const arch = p2.pipeline.phases[1];
    expect(arch.status).toBe("halted");
    // The architecture phase must carry ITS OWN output — not a reuse of spec's.
    expect(arch.summary).toContain("ARCHITECTURE design");
    expect(arch.summary ?? "").not.toContain("SPEC deliverable");
    await m2.drain(3_000);
  });

  test("an errored backend turn fails the phase instead of passing it", async () => {
    const store2 = new Store(join(tmp, "codeoid-err.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-err.db"), true),
      _testProviderFactory: () => new MockSessionProvider("mock", [errorTurn()]),
    });
    const pm = m2.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "impl", kind: "slash", command: "/impl" });
    const created = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "impl", onFail: { action: "abort" } }],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    const out = await m2.handle({ type: "pipeline.advance", id: "2", pipelineId: created.pipeline.id }, AUTH, CLIENT);
    if (out.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(out)}`);
    expect(out.pipeline.status).toBe("failed");
    const ph = out.pipeline.phases[0];
    expect(ph.status).toBe("failed");
    if (ph.status === "failed") expect(ph.reason).toContain("error");
    await m2.drain(3_000);
  });

  test("a phase that rests WITHOUT the completion marker is nudged to continue, not halted mid-work", async () => {
    const store2 = new Store(join(tmp, "codeoid-nudge.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-nudge.db"), true),
      // Turn 1 rests with NO marker (the model paused mid-work) — the phase must
      // NOT halt here. It gets nudged; turn 2 finishes and emits the marker.
      _testProviderFactory: () =>
        new MockSessionProvider("mock", [
          sayTurn("Here's my plan — I'll start implementing now."),
          sayTurn(`implemented the feature\n${PHASE_COMPLETE_MARKER}`),
        ]),
    });
    const pm = m2.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "impl", kind: "slash", command: "/impl" });
    const created = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "impl" }],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    const out = await m2.handle({ type: "pipeline.advance", id: "2", pipelineId: created.pipeline.id }, AUTH, CLIENT);
    if (out.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(out)}`);
    // Only halts AFTER the marker turn — and the summary is the completed
    // turn's text, with the marker stripped.
    expect(out.pipeline.status).toBe("halted");
    const ph = out.pipeline.phases[0];
    expect(ph.status).toBe("halted");
    expect(ph.summary).toContain("implemented the feature");
    expect(ph.summary ?? "").not.toContain(PHASE_COMPLETE_MARKER);
    await m2.drain(3_000);
  });

  test("a phase asking for input (NEED-INPUT) raises a dialog; the answer resumes it to completion", async () => {
    const captured: Array<{ type: string; [k: string]: unknown }> = [];
    const store2 = new Store(join(tmp, "codeoid-ask.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-ask.db"), true),
      _testProviderFactory: () =>
        new MockSessionProvider("mock", [
          // Turn 1 asks a question and ends with the NEED-INPUT marker.
          sayTurn(`Which language should I use?\n${PHASE_NEEDS_INPUT_MARKER}`),
          // Turn 2 (driven by the user's answer) finishes and marks complete.
          sayTurn(`implemented it in TypeScript\n${PHASE_COMPLETE_MARKER}`),
        ]),
    });
    const pm = m2.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "impl", kind: "slash", command: "/impl" });
    const created = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "impl" }],
      },
      AUTH,
      CLIENT,
    );
    if (created.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(created)}`);
    const sessionId = created.pipeline.sessionId;
    expect(sessionId).toBeTruthy();
    // Attach a UI_DIALOGS-capable client so the mid-phase question is delivered.
    const capClient = {
      id: "cap",
      auth: AUTH,
      capabilities: [CAPABILITIES.UI_DIALOGS],
      send: (m: unknown) => captured.push(m as { type: string }),
    };
    await m2.handle(
      { type: "session.attach", id: "att", sessionId } as never,
      AUTH,
      capClient as never,
    );
    // Advance drives the phase; it blocks on the input dialog until we answer.
    const advP = m2.handle({ type: "pipeline.advance", id: "2", pipelineId: created.pipeline.id }, AUTH, CLIENT);
    // Wait for the question dialog, then answer it.
    let req: { requestId?: string; method?: string; message?: string } | undefined;
    for (let i = 0; i < 300 && !req; i++) {
      req = captured.find((m) => m.type === "session.ui_request") as typeof req;
      if (!req) await new Promise((r) => setTimeout(r, 10));
    }
    if (!req?.requestId) throw new Error("no session.ui_request dialog appeared");
    expect(req.method).toBe("input");
    expect(String(req.message)).toContain("Which language");
    expect(String(req.message)).not.toContain(PHASE_NEEDS_INPUT_MARKER);
    await m2.handle(
      { type: "session.ui_response", id: "3", sessionId, requestId: req.requestId, value: "TypeScript" } as never,
      AUTH,
      capClient as never,
    );
    const out = await advP;
    if (out.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(out)}`);
    // Only halts after the model marked completion on the answer-driven turn.
    expect(out.pipeline.status).toBe("halted");
    const ph = out.pipeline.phases[0];
    expect(ph.status).toBe("halted");
    expect(ph.summary).toContain("implemented it in TypeScript");
    await m2.drain(3_000);
  });

  test("get pipelines() is undefined when the pipeline is disabled", () => {
    const store2 = new Store(join(tmp, "codeoid2.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid2.db"), false),
    });
    expect(m2.pipelines).toBeUndefined();
  });

  // ── Per-phase model binding actually applies (docs/role-model-binding.md §3) ──
  // The adversarial review's headline finding was that bindings were resolved,
  // persisted, and DISPLAYED but never used — the phase turn ran on the
  // session's own model regardless. These pin the mechanism end to end: the
  // model handed to the backend for the phase turn IS the bound one, and the
  // session's model is restored once the phase rests.

  /** A registry whose "claude"/"gemini" backends are phase-completing mocks,
   *  with every created provider captured for turn-opts inspection. */
  function makeBindingRegistry(created: MockSessionProvider[]): ProviderRegistry {
    const registry = new ProviderRegistry("claude");
    for (const id of ["claude", "gemini"] as const) {
      registry.register({
        id,
        displayName: id,
        create: () => {
          const p = new MockSessionProvider(id, [sayTurn(`done\n${PHASE_COMPLETE_MARKER}`)]);
          created.push(p);
          return p;
        },
      });
    }
    return registry;
  }

  test("the phase turn runs with the BOUND model, and the session's model is restored after", async () => {
    const created: MockSessionProvider[] = [];
    const store2 = new Store(join(tmp, "codeoid-bind.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-bind.db"), true),
      providers: makeBindingRegistry(created),
    });
    const pm = m2.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "impl", kind: "slash", command: "/impl" });
    const createdResp = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "impl", role: "worker" }],
        roleBindings: { worker: { provider: "claude", model: "claude-fable-5" } },
      },
      AUTH,
      CLIENT,
    );
    if (createdResp.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(createdResp)}`);
    // The binding matches the run session's backend → persisted as effective.
    expect(createdResp.pipeline.phases[0]).toMatchObject({
      provider: "claude",
      model: "claude-fable-5",
      resolvedFrom: "cli",
    });
    const out = await m2.handle({ type: "pipeline.advance", id: "2", pipelineId: createdResp.pipeline.id }, AUTH, CLIENT);
    if (out.type !== "pipeline.snapshot") throw new Error(`advance failed: ${JSON.stringify(out)}`);
    expect(out.pipeline.status).toBe("halted");
    // THE test: the model handed to the backend for the phase turn is the
    // bound one — not the session default (which would be undefined here).
    const runProvider = created.find((p) => p.capturedOpts.length > 0);
    expect(runProvider).toBeDefined();
    expect(runProvider!.capturedOpts[0]!.model).toBe("claude-fable-5");
    // …and once the phase rested, the session is back on its own model.
    const session = m2._sessionForTest(createdResp.pipeline.sessionId!);
    expect(session?.model).toBeNull();
    await m2.drain(3_000);
  });

  test("a cross-provider binding is skipped at create with a warning on the snapshot", async () => {
    const created: MockSessionProvider[] = [];
    const store2 = new Store(join(tmp, "codeoid-xprov.db"));
    const m2 = new SessionManager(store2, transcript, undefined, undefined, undefined, {
      config: mkConfig(join(tmp, "codeoid-xprov.db"), true),
      providers: makeBindingRegistry(created),
    });
    const pm = m2.pipelines;
    expect(pm).toBeDefined();
    if (!pm) return;
    pm.registries.skills.register({ id: "impl", kind: "slash", command: "/impl" });
    // gemini IS registered (it passes the provider check) but the run session
    // is claude-bound — the binding cannot apply, so it must be skipped, not
    // persisted, and the create reply must say so.
    const createdResp = await m2.handle(
      {
        type: "pipeline.create",
        id: "1",
        name: "R",
        workdir: join(tmp, "repo"),
        phases: [{ id: "impl", kind: "skill", skill: "impl", role: "worker" }],
        roleBindings: { worker: { provider: "gemini", model: "gemini-2.5-pro" } },
      },
      AUTH,
      CLIENT,
    );
    if (createdResp.type !== "pipeline.snapshot") throw new Error(`create failed: ${JSON.stringify(createdResp)}`);
    const ph = createdResp.pipeline.phases[0]!;
    expect(ph.provider).toBeUndefined();
    expect(ph.model).toBeUndefined();
    expect(ph.resolvedFrom).toBeUndefined();
    expect(createdResp.warnings?.join("\n")).toMatch(/targets provider "gemini"/);
    expect(createdResp.warnings?.join("\n")).toMatch(/"claude"/);
    await m2.drain(3_000);
  });
});
