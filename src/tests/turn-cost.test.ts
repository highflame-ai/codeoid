/**
 * What a turn costs (#430): the backend's figure where it gives one, an
 * estimate from tokens × the model's price where it doesn't, nothing for a
 * model on this machine, and "unknown" — never $0 — when there's no price.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { priceFor } from "../daemon/pricing/index.js";
import type { NormalizedTurnResult, ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SCOPES } from "../protocol/scopes.js";
import type { AuthContext } from "../protocol/types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-cost-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const auth: AuthContext = {
  sub: "user:a",
  scopes: [SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND, SCOPES.SESSION_LIST] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-1",
  projectId: "proj-1",
};
const client = { id: "c1", auth, send: () => {} };

function result(overrides: Partial<NormalizedTurnResult>): NormalizedTurnResult {
  return {
    providerId: "codex",
    model: "gpt-5.5",
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    durationMs: 1,
    ...overrides,
  };
}

async function sessionWith(
  turns: Array<NormalizedTurnResult | ProviderEvent[]>,
  pricing?: CodeoidConfig["pricing"],
  opts: { stall?: boolean; midTurn?: boolean; session?: CodeoidConfig["session"]; provider?: MockSessionProvider } = {},
) {
  const store = new Store(join(tmp, "codeoid.db"));
  const registry = new ProviderRegistry("codex");
  const provider =
    opts.provider ??
    new MockSessionProvider(
      "codex",
      turns.map((r): ProviderEvent[] => (Array.isArray(r) ? r : [{ type: "turn_done", result: r }])),
      opts,
    );
  registry.register({ id: "codex", displayName: "codex", create: () => provider });
  const config = {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: opts.session ?? {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    ...(pricing ? { pricing } : {}),
  } as CodeoidConfig;
  const m = new SessionManager(store, new TranscriptStore(join(tmp, "t")), undefined, undefined, undefined, { config, providers: registry });
  mkdirSync(join(tmp, "work"), { recursive: true });
  const r = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: join(tmp, "work") }, auth, client)) as { data: { id: string } };
  const s = m._sessionForTest(r.data.id)!;
  const run = async () => {
    await s.send("go", auth);
    for (let i = 0; i < 200 && s.status !== "idle"; i++) await Bun.sleep(5);
    await Bun.sleep(10);
  };
  return { s, run, provider };
}

describe("a turn's cost (#430)", () => {
  it("prices the tokens of a backend that reports none, and says it's an estimate", async () => {
    const { s, run } = await sessionWith([result({})]);
    await run();
    const price = priceFor("gpt-5.5")!;
    const expected = price.input + price.output / 10; // 1M input, 100k output
    const u = s.toInfo().usage!;
    expect(u.totalCostUsd).toBeCloseTo(expected, 6);
    expect(u.lastTurnCostUsd).toBeCloseTo(expected, 6);
    expect(u.costEstimated).toBe(true);
    expect(u.costUnknownTurns).toBeUndefined();
  });

  it("takes the backend's own figure when it gives one", async () => {
    const { s, run } = await sessionWith([result({ totalCostUsd: 0.37, costSource: "backend" })]);
    await run();
    const u = s.toInfo().usage!;
    expect(u.totalCostUsd).toBe(0.37);
    expect(u.costEstimated).toBeUndefined();
  });

  it("charges nothing for a model on this machine", async () => {
    const { s, run } = await sessionWith([result({ costSource: "free" })]);
    await run();
    expect(s.toInfo().usage!.totalCostUsd).toBe(0);
    expect(s.toInfo().usage!.costUnknownTurns).toBeUndefined();
  });

  it("calls a model with no price unknown — never $0 a spend cap would count as nothing", async () => {
    const { s, run } = await sessionWith([result({ model: "my-local-finetune" }), result({})]);
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
    expect(s.toInfo().usage!.totalCostUsd).toBe(0);
    await run();
    const u = s.toInfo().usage!;
    expect(u.costUnknownTurns).toBe(1); // the known turn adds its price, the unknown one stays counted apart
    expect(u.totalCostUsd).toBeGreaterThan(0);
  });

  it("counts a backend with no token counts as unknown", async () => {
    const { s, run } = await sessionWith([result({ inputTokens: 0, outputTokens: 0, costSource: "unknown" })]);
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
  });

  it("uses the config's price over the snapshot's, and can make a model free", async () => {
    const { s, run } = await sessionWith([result({ model: "my-local-finetune" })], { models: { "my-local-finetune": { input: 1, output: 10 } } });
    await run();
    expect(s.toInfo().usage!.totalCostUsd).toBeCloseTo(2, 6);
  });

  it("a turn whose usage never arrived is unknown, not free — a server that leaves usage out can't defeat a cap", async () => {
    const { s, run } = await sessionWith([result({ inputTokens: 0, outputTokens: 0 })]);
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
  });

  it("a turn that made no model call says so, and is free", async () => {
    const { s, run } = await sessionWith([result({ inputTokens: 0, outputTokens: 0, costSource: "free" })]);
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBeUndefined();
    expect(s.toInfo().usage!.totalCostUsd).toBe(0);
  });

  it("a placeholder model is priced as the model the backend says it runs", async () => {
    const { s, run, provider } = await sessionWith([result({ model: "codex" })]);
    Object.defineProperty(provider, "runningModel", { get: () => "gpt-5.5" });
    await run();
    expect(s.toInfo().usage!.costEstimated).toBe(true);
    expect(s.toInfo().usage!.costUnknownTurns).toBeUndefined();
  });

  it("a model named like an object's own property finds no price", async () => {
    for (const model of ["constructor", "toString", "__proto__", "Constructor-2025-01-01"]) {
      const { s, run } = await sessionWith([result({ model })]);
      await run();
      expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
      expect(Number.isFinite(s.toInfo().usage!.totalCostUsd)).toBe(true);
    }
  });

  it("a price override matches whatever the case of its key", async () => {
    const { s, run } = await sessionWith([result({ model: "my-model" })], { models: { "My-Model": { input: 1, output: 10 } } });
    await run();
    expect(s.toInfo().usage!.totalCostUsd).toBeCloseTo(2, 6);
  });

  it("the long-context tier needs one request over 200k, not several that add up past it", async () => {
    const tiered = { models: { tiered: { input: 1, output: 0, inputAbove200k: 2 } } };
    const a = await sessionWith([result({ model: "tiered", inputTokens: 1_000_000, outputTokens: 0, largestPromptTokens: 60_000 })], tiered);
    await a.run();
    expect(a.s.toInfo().usage!.totalCostUsd).toBeCloseTo(1, 6);
    const b = await sessionWith([result({ model: "tiered", inputTokens: 1_000_000, outputTokens: 0, largestPromptTokens: 250_000 })], tiered);
    await b.run();
    expect(b.s.toInfo().usage!.totalCostUsd).toBeCloseTo(2, 6);
  });

  it("a turn that did model work but ended with no result is recorded — unknown, never $0 (#430)", async () => {
    const { s, run } = await sessionWith([[{ type: "text_delta", content: "working" }, { type: "error", message: "stream reset" }]]);
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
  });

  it("...priced from the requests it reported, when it reported any (#430)", async () => {
    const { s, run, provider } = await sessionWith([
      [
        { type: "llm_call", isPrimary: true, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } },
        { type: "error", message: "stream reset" },
      ],
    ], { models: { "gpt-5.5": { input: 3, output: 0 } } });
    Object.defineProperty(provider, "runningModel", { get: () => "gpt-5.5" });
    await run();
    const u = s.toInfo().usage!;
    expect(u.costUnknownTurns ?? 0).toBe(0);
    expect(u.costEstimated).toBe(true);
  });

  it("a turn that failed before any model request spent nothing — not unknown (#430)", async () => {
    const { s, run } = await sessionWith([result({ inputTokens: 0, outputTokens: 0, isError: true, errorMessage: "auth" })]);
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBeUndefined();
    expect(s.toInfo().usage!.totalCostUsd).toBe(0);
  });

  it("an error with no model work records no turn at all", async () => {
    const { s, run } = await sessionWith([[{ type: "error", message: "auth failed" }]]);
    await run();
    expect(s.toInfo().usage?.costUnknownTurns).toBeUndefined();
  });

  it("a local server's turn is free — unless you priced its model (a gateway forwarding to a paid API) (#430)", async () => {
    const free = await sessionWith([result({ model: "local-model", costSource: "free" })]);
    await free.run();
    expect(free.s.toInfo().usage!.totalCostUsd).toBe(0);
    const priced = await sessionWith([result({ model: "local-model", costSource: "free" })], { models: { "local-model": { input: 1, output: 10 } } });
    await priced.run();
    expect(priced.s.toInfo().usage!.totalCostUsd).toBeCloseTo(2, 6);
  });

  it("a failed turn whose model did work is priced from its requests, else unknown — not $0 (#430)", async () => {
    const worked = await sessionWith([[{ type: "text_delta", content: "x" }, { type: "turn_done", result: result({ inputTokens: 0, outputTokens: 0, isError: true }) }]]);
    await worked.run();
    expect(worked.s.toInfo().usage!.costUnknownTurns).toBe(1);
    const reported = await sessionWith([
      [
        { type: "llm_call", isPrimary: true, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } },
        { type: "turn_done", result: result({ inputTokens: 0, outputTokens: 0, isError: true }) },
      ],
    ]);
    await reported.run();
    expect(reported.s.toInfo().usage!.costUnknownTurns).toBeUndefined();
    expect(reported.s.toInfo().usage!.totalCostUsd).toBeCloseTo(priceFor("gpt-5.5")!.input, 6);
  });

  it("a local server's turn that ends with no result is still free (#430)", async () => {
    const { s, run, provider } = await sessionWith([[{ type: "text_delta", content: "x" }, { type: "error", message: "stream reset" }]]);
    Object.defineProperty(provider, "free", { get: () => true });
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBeUndefined();
    expect(s.toInfo().usage!.totalCostUsd).toBe(0);
  });

  it("a stopped turn is in flight until it settles and its spend is recorded; observers hear when it does (#430)", async () => {
    const { s } = await sessionWith([[{ type: "text_delta", content: "working" }]], undefined, { stall: true });
    await s.send("go", auth);
    for (let i = 0; i < 50 && !s.turnInFlight; i++) await Bun.sleep(5);
    expect(s.turnInFlight).toBe(true);
    await s.interrupt(auth);
    for (let i = 0; i < 200 && s.turnInFlight; i++) await Bun.sleep(5);
    expect(s.turnInFlight).toBe(false);
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1); // it streamed, and said nothing of its spend
  });

  it("a request the server refused spent nothing: no turn is recorded (#430)", async () => {
    const { s, run } = await sessionWith([[{ type: "error", message: "401 invalid api key" }]]);
    await run();
    expect(s.toInfo().usage?.costUnknownTurns).toBeUndefined();
  });

  it("a turn with a request that never reported its usage is unknown — part of the spend is missing (#430)", async () => {
    const { s, run } = await sessionWith([
      [
        { type: "model_request" },
        { type: "llm_call", isPrimary: true, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } },
        { type: "model_request" },
        { type: "turn_done", result: result({ inputTokens: 100, outputTokens: 10 }) },
      ],
    ]);
    await run();
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
  });

  it("every background task but a plain shell counts as spending — an ambient one may call the model; all are live (#430)", async () => {
    const { s, provider } = await sessionWith([]);
    provider.onSessionEvent!({
      type: "background_tasks",
      tasks: [
        { id: "a", kind: "local_agent", description: "research", status: "running" },
        { id: "b", kind: "local_bash", description: "dev server", status: "running" },
        { id: "c", kind: "dream", description: "ambient", status: "running", ambient: true },
      ],
    });
    expect(s.spendingBackgroundTasks).toBe(2);
    expect(s.liveBackgroundTasks).toBe(3);
  });

  it("Stop with only background work stops it for good: no wake to continue it afterwards (#430)", async () => {
    const { s, provider } = await sessionWith([]);
    provider.continuesAfterBackgroundWork = true;
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "a", kind: "local_agent", description: "x", status: "running" }] });
    await s.interrupt(auth);
    expect(provider.stoppedTasks).toEqual(["a"]);
    provider.onSessionEvent!({ type: "background_task_settled", taskId: "a", status: "stopped", summary: "stopped" });
    expect(s.turnInFlight).toBe(false);
  });

  it("Stop with no turn running also drops results that settled just before — no wake after Stop (#430)", async () => {
    const { s, provider } = await sessionWith([]);
    provider.continuesAfterBackgroundWork = true;
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "a", kind: "local_agent", description: "x", status: "running" }] });
    provider.onSessionEvent!({ type: "background_tasks", tasks: [] });
    provider.onSessionEvent!({ type: "background_task_settled", taskId: "a", status: "completed", summary: "done" });
    expect(s.turnInFlight).toBe(true); // a wake is armed: a continuation is on its way
    await s.interrupt(auth);
    expect(s.turnInFlight).toBe(false);
  });

  it("a turn-only Stop with no turn running leaves the background work alone (#430)", async () => {
    const { s, provider } = await sessionWith([]);
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "a", kind: "local_bash", description: "owner's dev server", status: "running" }] });
    await s.interrupt(auth, { turnOnly: true });
    expect(provider.stoppedTasks).toEqual([]);
    expect(s.liveBackgroundTaskIds).toEqual(["a"]);
  });

  it("stopping tasks by id stops those and only those — and a listed one that just settled wakes nothing (#430)", async () => {
    const { s, provider } = await sessionWith([]);
    provider.continuesAfterBackgroundWork = true;
    provider.onSessionEvent!({
      type: "background_tasks",
      tasks: [
        { id: "a", kind: "local_agent", description: "owner's", status: "running" },
        { id: "b", kind: "local_bash", description: "run's", status: "running" },
        { id: "c", kind: "local_bash", description: "run's, about to settle", status: "running" },
      ],
    });
    expect(s.spendingBackgroundTaskIds).toEqual(["a"]);
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "a", kind: "local_agent", description: "owner's", status: "running" }, { id: "b", kind: "local_bash", description: "run's", status: "running" }] });
    provider.onSessionEvent!({ type: "background_task_settled", taskId: "c", status: "completed", summary: "done" });
    await s.stopBackgroundTasksById(["b", "c"], auth);
    expect(provider.stoppedTasks).toEqual(["b"]);
    expect(s.liveBackgroundTaskIds).toEqual(["a"]);
    // a is still live, so its eventual settle may wake the agent — but c's result won't.
    provider.onSessionEvent!({ type: "background_tasks", tasks: [] });
    expect(s.turnInFlight).toBe(false);
  });

  it("a Stop that catches a wake before its turn starts drops it for good: never requeued to wake again (#430)", async () => {
    const { s, provider } = await sessionWith([result({}), result({})]);
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "a", kind: "local_agent", description: "x", status: "running" }] });
    provider.onSessionEvent!({ type: "background_tasks", tasks: [] });
    provider.onSessionEvent!({ type: "background_task_settled", taskId: "a", status: "completed", summary: "done" });
    // The wake's send is preparing its turn: Stop now.
    await s.interrupt(auth);
    for (let i = 0; i < 40; i++) await Bun.sleep(5);
    expect(s.turnInFlight).toBe(false);
    expect(provider.capturedOpts.length).toBe(0);
  });

  it("a Stop of background work leaves alone a turn that started while it stopped them (#430)", async () => {
    const { s, provider } = await sessionWith([]);
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "a", kind: "local_agent", description: "x", status: "running" }] });
    provider.stopBackgroundTasks = async () => {
      provider.startOwnTurn([{ type: "text_delta", content: "the backend carries on" }]);
      return [];
    };
    await s.interrupt(auth);
    await Bun.sleep(20);
    expect(s.status).not.toBe("idle");
    expect(s.turnInFlight).toBe(true);
  });

  it("a stopped turn that ends after the next one started is recorded with its own counts, not the new turn's (#430)", async () => {
    // A backend whose stop leaves the old stream open: it ends later, mid the next turn.
    class LingeringProvider extends MockSessionProvider {
      runs: TurnRun[] = [];
      override runTurn(opts: TurnOpts): TurnRun {
        const r = super.runTurn(opts);
        this.runs.push(r);
        return { ...r, endTurn: () => {} };
      }
      override async teardown(): Promise<void> {
        this.teardownCount++;
      }
    }
    const usage = { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const provider = new LingeringProvider(
      "codex",
      [
        // One request, its usage never reported: unknown.
        [{ type: "model_request" }, { type: "text_delta", content: "first" }],
        // Every request reported.
        [{ type: "model_request" }, { type: "llm_call", isPrimary: true, usage }],
      ],
      { stall: true },
    );
    Object.defineProperty(provider, "runningModel", { get: () => "gpt-5.5" }); // a priced model: only the counts decide
    const { s } = await sessionWith([], undefined, { provider });
    await s.send("go", auth);
    for (let i = 0; i < 50 && !s.turnInFlight; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    await s.terminateBackend(auth, "test");
    await s.send("again", auth);
    for (let i = 0; i < 50 && provider.runs.length < 2; i++) await Bun.sleep(5);
    await Bun.sleep(20);
    await provider.runs[0]!.interrupt(); // the old stream ends now
    await Bun.sleep(20);
    expect(s.toInfo().usage?.costUnknownTurns).toBe(1);
  });

  it("a turn's origin is its sender's, and a wake joining the user's turn makes it no longer only theirs (#430)", async () => {
    const { s } = await sessionWith([[{ type: "text_delta", content: "working" }]], undefined, { stall: true });
    void s.send("go", auth);
    for (let i = 0; i < 50 && !s.turnInFlight; i++) await Bun.sleep(5);
    await Bun.sleep(10);
    expect(s.lastTurnOrigin).toBe("user");
    // A wake sent mid-turn joins it: the turn now carries the agent's work too.
    const queued = s.send("wake", { ...auth, sub: "system:background" }).catch(() => {});
    await Bun.sleep(10);
    expect(s.lastTurnOrigin).toBe("agent");
    await s.interrupt(auth);
    await queued;
  });

  it("a turn-only Stop with no turn running stops the messages waiting for theirs — a wake — and nothing else (#430)", async () => {
    const { s, provider } = await sessionWith([result({})]);
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "owner", kind: "local_agent", description: "x", status: "running" }] });
    const wake = s.send("wake", { ...auth, sub: "system:background" }).catch((e) => e);
    await s.interrupt(auth, { turnOnly: true });
    expect(await wake).toBeInstanceOf(Error); // stopped before its turn started
    expect(provider.capturedOpts.length).toBe(0);
    expect(provider.stoppedTasks).toEqual([]);
    expect(s.liveBackgroundTaskIds).toEqual(["owner"]);
  });

  it("knows which requests a person said yes to with their own token — the request holding the id now (#430)", async () => {
    const tool = (id: string, name = "Bash"): ProviderEvent => ({ type: "tool_start", toolId: id, sdkToolUseId: id, name, input: { command: "make" }, approvalId: id });
    const { s } = await sessionWith([[tool("a1"), tool("a2"), tool("a3"), tool("a4", "AskUserQuestion"), tool("a5"), tool("a5"), { type: "turn_done", result: result({}) }]]);
    void s.send("go", auth);
    const waitFor = async (id: string) => {
      for (let i = 0; i < 100 && !s.pendingToolApprovals().some((p) => p.approvalId === id); i++) await Bun.sleep(5);
    };
    const decide = async (id: string, approved: boolean, who: Partial<AuthContext>, updatedInput?: Record<string, unknown>) => {
      await waitFor(id);
      s.approve(id, approved, { ...auth, ...who }, updatedInput);
    };
    await decide("a1", false, {});
    await decide("a2", true, { sub: "system:budget" });
    await decide("a3", true, { delegationDepth: 1, delegatedBy: "user:a" });
    await decide("a4", true, {}, { answers: { q: "main" } }); // an answer is a yes too
    await waitFor("a5");
    expect(s.approvalState("a5")).toBe("pending");
    await decide("a5", true, {});
    expect(["a1", "a2", "a3", "a4", "a5", "never"].map((id) => s.approvalState(id))).toEqual(["gone", "gone", "gone", "owner", "owner", "gone"]);
    // A new request under the same id: the old yes isn't its.
    await waitFor("a5");
    expect(s.approvalState("a5")).toBe("pending");
    await decide("a5", false, {});
    expect(s.approvalState("a5")).toBe("gone");
  });

  it("a task is whose its turn was, and a wake delivering only the owner's results is the owner's turn (#430)", async () => {
    const { s, provider } = await sessionWith([[{ type: "text_delta", content: "working" }], result({}), result({})], undefined, { stall: true });
    void s.send("start the server", auth);
    for (let i = 0; i < 50 && !s.turnRunning; i++) await Bun.sleep(5);
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "srv", kind: "local_bash", description: "server", status: "running" }] });
    await s.interrupt(auth);
    for (let i = 0; i < 100 && s.turnInFlight; i++) await Bun.sleep(5);
    // One with no turn behind it is the agent's.
    provider.onSessionEvent!({
      type: "background_tasks",
      tasks: [
        { id: "srv", kind: "local_bash", description: "server", status: "running" },
        { id: "stray", kind: "local_agent", description: "x", status: "running" },
      ],
    });
    expect(s.backgroundTaskOrigins).toEqual({ srv: "user", stray: "agent" });
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "stray", kind: "local_agent", description: "x", status: "running" }] });
    // Someone else's turn since: the latest turn isn't the owner's.
    await s.send("status?", { ...auth, delegationDepth: 1, delegatedBy: "user:a" });
    for (let i = 0; i < 100 && s.status !== "idle"; i++) await Bun.sleep(5);
    expect(s.lastTurnOrigin).toBe("delegated");
    provider.onSessionEvent!({ type: "background_task_settled", taskId: "srv", status: "completed", summary: "up" });
    for (let i = 0; i < 100 && s.lastTurnOrigin !== "user"; i++) await Bun.sleep(5);
    expect(s.lastTurnOrigin).toBe("user");
    await s.interrupt(auth);
  });

  it("someone else joining the owner's turn makes it no longer only theirs (#430)", async () => {
    const { s } = await sessionWith([[{ type: "text_delta", content: "working" }]], undefined, { stall: true, midTurn: true });
    void s.send("go", auth);
    for (let i = 0; i < 50 && !s.turnRunning; i++) await Bun.sleep(5);
    expect(s.lastTurnOrigin).toBe("user");
    await s.send("also this", { ...auth, delegationDepth: 1, delegatedBy: "user:a" });
    expect(s.lastTurnOrigin).toBe("delegated");
    await s.interrupt(auth);
  });

  it("MCP control's sends are automation, not the person — whatever the token's depth (#430)", async () => {
    const { s } = await sessionWith([result({})]);
    const automation: AuthContext = { ...auth, automation: true };
    await s.send("go", automation);
    for (let i = 0; i < 100 && s.status !== "idle"; i++) await Bun.sleep(5);
    expect(s.lastTurnOrigin).toBe("delegated");
  });

  it("a delegated sender's turn — a routine's prompt — is neither the user's nor the agent's own (#430)", async () => {
    const { s, run } = await sessionWith([result({})]);
    void run;
    await s.send("triage", { ...auth, delegationDepth: 1, delegatedBy: "user:a", name: "routine:nightly" });
    for (let i = 0; i < 100 && s.status !== "idle"; i++) await Bun.sleep(5);
    expect(s.lastTurnOrigin).toBe("delegated");
  });

  it("a turn the agent started becomes the owner's when they join it (#430)", async () => {
    const { s, provider } = await sessionWith([], undefined, { midTurn: true });
    provider.startOwnTurn([{ type: "text_delta", content: "carrying on" }]);
    for (let i = 0; i < 50 && s.lastTurnOrigin !== "agent"; i++) await Bun.sleep(5);
    expect(s.lastTurnOrigin).toBe("agent");
    await s.send("and also this", auth);
    expect(s.lastTurnOrigin).toBe("user");
  });

  it("knows who started the latest turn: the owner's prompt, or a wake on its own (#430)", async () => {
    const { s, run, provider } = await sessionWith([result({}), result({})]);
    await run();
    expect(s.lastTurnOrigin).toBe("user");
    provider.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "a", kind: "local_agent", description: "x", status: "running" }] });
    provider.onSessionEvent!({ type: "background_tasks", tasks: [] });
    provider.onSessionEvent!({ type: "background_task_settled", taskId: "a", status: "completed", summary: "done" });
    for (let i = 0; i < 100 && s.lastTurnOrigin !== "agent"; i++) await Bun.sleep(5);
    expect(s.lastTurnOrigin).toBe("agent");
  });
});
