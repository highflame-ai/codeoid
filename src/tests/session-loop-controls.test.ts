/**
 * Session-level controls a loop controller drives (loop design §6, §8, §12.11),
 * through a real Session over MockSessionProvider:
 *
 *   - lastTurnInfraError: a turn failed on a usage / rate limit (with its
 *     reset), set on failure, cleared by the next successful turn;
 *   - onBudgetExhausted: "end_attempt" denies and ends the turn, settling idle,
 *     while the default "park" still waits for approval;
 *   - extraEnv: refused keys fail the create; allowed ones reach the provider init;
 *   - supervise(): a wall-time deadline that fires while a tool is running
 *     (stall watchdog paused), kills the backend after the grace period, and
 *     never fires once cancelled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, type SessionCreateOptions } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { mockResult } from "../daemon/providers/mock/index.js";
import { ProviderRegistry, type ProviderSessionInit } from "../daemon/providers/registry.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { supervise, type DeadlineEvent, type SupervisedSession } from "../daemon/supervisor.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext, SessionStatus } from "../protocol/types.js";
import type { CodeoidConfig } from "../config.js";

const AUTH: AuthContext = { sub: "user:loops", scopes: [], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const SYSTEM: AuthContext = { ...AUTH, sub: "system:dispatch" };

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-loopctl-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});
afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function makeSession(extra: Partial<SessionCreateOptions> = {}): Session {
  const id = randomUUID();
  store.createSession({
    id, name: "loop", workdir: tmp, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  return new Session({ name: "loop", workdir: tmp, auth: AUTH, store, transcriptStore, existingId: id, ...extra });
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const done = (overrides: Parameters<typeof mockResult>[0] = {}): ProviderEvent => ({ type: "turn_done", result: mockResult(overrides) });
const bash = (n: number): ProviderEvent => ({
  type: "tool_start", toolId: `t${n}`, sdkToolUseId: `sdk-t${n}`, name: "Bash", input: { command: `echo ${n}` }, approvalId: `ap-${n}`,
});
const bashDone = (n: number): ProviderEvent => ({ type: "tool_complete", sdkToolUseId: `sdk-t${n}`, output: `${n}`, success: true });

/** Config with a short stall watchdog (autoRotate off — #shouldRotate reads it on every send). */
function stallConfig(turnStallTimeoutMs: number): CodeoidConfig {
  return {
    session: { turnStallTimeoutMs },
    autoRotate: { enabled: false, warnPct: 0.75, rotatePct: 0.9, hardRotatePct: 0.95, minTurnsBeforeRotate: 1, strategy: "task-anchor" },
  } as unknown as CodeoidConfig;
}

// ── lastTurnInfraError ──────────────────────────────────────────────────────

describe("lastTurnInfraError", () => {
  test("a usage-limit turn records kind + reset; the next successful turn clears it", async () => {
    const provider = new MockSessionProvider("claude", [
      [done({ isError: true, errorMessage: "You've hit your session limit · resets 3pm (UTC)" })],
      [{ type: "text_done", content: "ok" }, done()],
    ]);
    const session = makeSession({ _testProvider: provider });
    expect(session.lastTurnInfraError).toBeNull();

    await session.send("work", AUTH);
    await until(() => session.status === "error");
    const infra = session.lastTurnInfraError;
    expect(infra?.kind).toBe("usage_limit");
    expect(infra?.provider).toBe("claude");
    expect(infra?.message).toContain("session limit");
    expect(new Date(infra!.resetAt!).getUTCHours()).toBe(15);
    expect(infra!.resetAt!).toBeGreaterThan(Date.now() - 60_000);

    await session.send("again", AUTH);
    await until(() => session.status === "idle" && session.lastTurnInfraError === null);
  });

  test("the Claude CLI's limit notice in the turn's own assistant text is recognized", async () => {
    const provider = new MockSessionProvider("claude", [
      [{ type: "text_done", content: "API Error: Repeated 529 Overloaded errors" }, done({ isError: true })],
    ]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError?.kind).toBe("rate_limit");
  });

  test("a provider error event, and an ordinary failure afterwards resets it to null", async () => {
    const provider = new MockSessionProvider("codex", [
      [{ type: "error", message: "codex: You've hit your usage limit. Try again in 2h." }],
      [{ type: "error", message: "codex exited unexpectedly (code=1 signal=null)" }],
    ]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    const infra = session.lastTurnInfraError;
    expect(infra?.kind).toBe("usage_limit");
    expect(infra!.resetAt! - infra!.at).toBeGreaterThan(2 * 3600_000 - 5_000);

    await session.send("again", AUTH);
    await until(() => session.status === "error" && session.lastTurnInfraError === null);
  });

  test("a provider error's structured detail (codex) gives the exact reset", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 3 * 3600;
    const provider = new MockSessionProvider("codex", [
      [{ type: "error", message: "codex: You've hit your usage limit.", detail: { codexErrorInfo: "usageLimitExceeded", resetsAt: resetSec } }],
    ]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError).toMatchObject({
      kind: "usage_limit",
      resetAt: resetSec * 1000,
      message: "codex: You've hit your usage limit.",
      provider: "codex",
    });
  });

  test("Claude's rate_limit_event supplies the exact reset when the error text has none", async () => {
    const resetsAt = Date.now() + 4 * 3600_000;
    const provider = new MockSessionProvider("claude", [
      [{ type: "rate_limit", status: "rejected", resetsAt, limitType: "five_hour" }, done({ isError: true, errorMessage: "Claude AI usage limit reached" })],
    ]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError).toMatchObject({ kind: "usage_limit", resetAt: resetsAt });
  });

  test("an ordinary failed turn records nothing", async () => {
    const provider = new MockSessionProvider("claude", [[done({ isError: true, errorMessage: "Prompt is too long" })]]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError).toBeNull();
  });
});

// ── onBudgetExhausted ──────────────────────────────────────────────────────

describe("onBudgetExhausted", () => {
  // Budget 1: the first Bash spends it, the second finds it spent. `stall`
  // keeps the turn open afterwards, so only an interrupt can end it.
  const script = () => [[bash(1), bashDone(1), bash(2)]];

  test("default park: the call waits for approval, the session wedges at waiting_approval", async () => {
    const provider = new MockSessionProvider("claude", script(), { stall: true });
    const session = makeSession({ _testProvider: provider, initialMode: { mode: "autonomous", maxTurns: 1 } });
    await session.send("work", AUTH);
    await until(() => session.pendingToolApprovals().length === 1);
    expect(session.status).toBe("waiting_approval");
    expect(session.pendingToolApprovals()[0]!.toolName).toBe("Bash");
    expect(provider.canUseToolResults.map((r) => r.behavior)).toEqual(["allow"]);
    expect(session.budgetExhausted).toBe(false);
    expect(session.mode).toBe("guarded");
    await session.interrupt(AUTH);
  });

  test("end_attempt: the call is denied, the turn interrupted, the session idle with budgetExhausted", async () => {
    const provider = new MockSessionProvider("claude", script(), { stall: true });
    const session = makeSession({
      _testProvider: provider,
      initialMode: { mode: "autonomous", maxTurns: 1 },
      onBudgetExhausted: "end_attempt",
    });
    const seen: SessionStatus[] = [];
    session.attach({ id: "c", auth: AUTH, send: (m) => { if (m.type === "session.status_change") seen.push(m.status); } });
    await session.send("work", AUTH);
    await until(() => provider.canUseToolResults.length === 2);
    expect(provider.canUseToolResults[1]!.behavior).toBe("deny");
    expect(provider.canUseToolResults[1]!.message).toMatch(/budget/i);
    await until(() => session.status === "idle" && session.turnInterrupted);
    expect(seen).not.toContain("waiting_approval");
    expect(session.budgetExhausted).toBe(true);
    expect(session.mode).toBe("guarded");
    expect(session.pendingToolApprovals()).toEqual([]);

    // A new autonomous budget is a new attempt.
    session.setMode("autonomous", 3);
    expect(session.budgetExhausted).toBe(false);
  });

  test("end_attempt with budget to spare behaves exactly like park", async () => {
    const provider = new MockSessionProvider("claude", [[bash(1), bashDone(1), done()]]);
    const session = makeSession({
      _testProvider: provider,
      initialMode: { mode: "autonomous", maxTurns: 5 },
      onBudgetExhausted: "end_attempt",
    });
    await session.send("work", AUTH);
    await until(() => session.status === "idle" && provider.canUseToolResults.length === 1);
    expect(provider.canUseToolResults[0]!.behavior).toBe("allow");
    expect(session.turnsRemaining).toBe(4);
    expect(session.budgetExhausted).toBe(false);
  });
});

// ── extraEnv ───────────────────────────────────────────────────────────────

describe("extraEnv", () => {
  test("refused keys fail the create, naming them", () => {
    expect(() =>
      makeSession({ _testProvider: new MockSessionProvider("claude"), extraEnv: { LOOP_RUN_ID: "r", ANTHROPIC_API_KEY: "k", HOME: "/x" } }),
    ).toThrow(/ANTHROPIC_API_KEY, HOME/);
  });

  test("allowed keys reach the provider through ProviderSessionInit", () => {
    let captured: ProviderSessionInit | undefined;
    const providers = new ProviderRegistry("cap");
    providers.register({
      id: "cap",
      displayName: "Capture",
      create: (init) => {
        captured = init;
        return new MockSessionProvider("cap");
      },
    });
    makeSession({ providers, providerId: "cap", extraEnv: { LOOP_RUN_ID: "run-1", DATABASE_URL: "postgres://t" } });
    expect(captured?.extraEnv).toEqual({ LOOP_RUN_ID: "run-1", DATABASE_URL: "postgres://t" });
  });
});

// ── supervise() ────────────────────────────────────────────────────────────

/** A backend whose interrupt never returns — the wedge that makes the kill necessary. */
class WedgedProvider extends MockSessionProvider {
  override runTurn(opts: TurnOpts): TurnRun {
    const run = super.runTurn(opts);
    return { ...run, interrupt: () => new Promise<void>(() => {}) };
  }
}

describe("supervise()", () => {
  test("fires while a tool is running (watchdog paused) and kills the backend after the grace period", async () => {
    // The tool starts and never completes: tool_running, the stall watchdog
    // (30ms here) paused for the whole time.
    const provider = new WedgedProvider("claude", [[bash(1)]], { stall: true });
    const session = makeSession({ _testProvider: provider, config: stallConfig(30), initialMode: { mode: "autonomous" } });
    await session.send("long tool", AUTH);
    await until(() => session.status === "tool_running");
    await new Promise((r) => setTimeout(r, 80)); // well past the stall window
    expect(session.status).toBe("tool_running");
    expect(provider.teardownCount).toBe(0);

    const events: DeadlineEvent[] = [];
    const deadline = supervise(session, { wallMs: 50, graceMs: 60, onEvent: (e) => events.push(e) });
    expect(await deadline.expired).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["expired", "terminated"]);
    expect(provider.teardownCount).toBe(1);
    expect(session.status).toBe("idle");
    expect(session.turnInterrupted).toBe(true);
  });

  test("a session the interrupt settles is not killed", async () => {
    const provider = new MockSessionProvider("claude", [[bash(1)]], { stall: true });
    const session = makeSession({ _testProvider: provider, initialMode: { mode: "autonomous" } });
    await session.send("long tool", AUTH);
    await until(() => session.status === "tool_running");
    const events: DeadlineEvent[] = [];
    const deadline = supervise(session, { wallMs: 20, graceMs: 2_000, onEvent: (e) => events.push(e) });
    expect(await deadline.expired).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["expired", "settled"]);
    expect(provider.teardownCount).toBe(0);
  });
});

describe("supervise() — timers", () => {
  function fake(status: SessionStatus = "tool_running") {
    const calls: string[] = [];
    const s: SupervisedSession & { status: SessionStatus } = {
      id: "s1",
      accountId: "a",
      projectId: "p",
      status,
      preparingTurn: false,
      interrupt: async (sender) => { calls.push(`interrupt:${sender.sub}`); },
      terminateBackend: async (sender) => { calls.push(`terminate:${sender.sub}`); s.status = "idle"; },
    };
    return { s, calls };
  }

  test("cancel before expiry: nothing fires, expired resolves false", async () => {
    const { s, calls } = fake();
    const d = supervise(s, { wallMs: 30, graceMs: 10 });
    d.cancel();
    expect(await d.expired).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual([]);
    d.cancel(); // idempotent
  });

  test("interrupt, then kill when still busy after grace; audited as the supervisor", async () => {
    const { s, calls } = fake();
    const d = supervise(s, { wallMs: 10, graceMs: 20 });
    expect(await d.expired).toBe(true);
    expect(calls).toEqual(["interrupt:system:supervisor", "terminate:system:supervisor"]);
  });

  test("cancel during the grace period abandons the kill", async () => {
    const { s, calls } = fake();
    const d = supervise(s, { wallMs: 10, graceMs: 200 });
    await until(() => calls.length === 1);
    d.cancel();
    expect(await d.expired).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toEqual(["interrupt:system:supervisor"]);
  });

  test("a queued send counts as busy", async () => {
    const { s, calls } = fake("idle");
    (s as { preparingTurn: boolean }).preparingTurn = true;
    const d = supervise(s, { wallMs: 5, graceMs: 15 });
    expect(await d.expired).toBe(true);
    expect(calls.at(-1)).toBe("terminate:system:supervisor");
  });

  test("rejects a non-positive wall time or a negative grace", () => {
    const { s } = fake();
    expect(() => supervise(s, { wallMs: 0, graceMs: 0 })).toThrow(RangeError);
    expect(() => supervise(s, { wallMs: 10, graceMs: -1 })).toThrow(RangeError);
  });
});

// ── Round-1 audit fixes ──────────────────────────────────────────────────────

const rejected = (extra: Partial<Extract<ProviderEvent, { type: "rate_limit" }>> = {}): ProviderEvent => ({
  type: "rate_limit",
  status: "rejected",
  resetsAt: Date.now() + 3600_000,
  ...extra,
});

describe("rate_limit fallback (audit #1)", () => {
  test("a rejection that overage is carrying is not a limit", async () => {
    const provider = new MockSessionProvider("claude", [[rejected({ overage: true }), done({ isError: true, errorMessage: "tool crashed" })]]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError).toBeNull();
  });

  for (const [label, errorMessage] of [
    ["prompt too long", "Prompt is too long"],
    ["the spend ceiling", "Stopped at the spend ceiling for this run (maxBudgetUsd)."],
  ] as const) {
    test(`a rejection does not relabel a failure already explained by ${label}`, async () => {
      const provider = new MockSessionProvider("claude", [[rejected(), done({ isError: true, errorMessage })]]);
      const session = makeSession({ _testProvider: provider });
      await session.send("work", AUTH);
      await until(() => session.status === "error");
      expect(session.lastTurnInfraError).toBeNull();
    });
  }

  test("an unexplained failure after a plain rejection is still a usage limit", async () => {
    const r = rejected();
    const provider = new MockSessionProvider("claude", [[r, done({ isError: true })]]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError).toMatchObject({ kind: "usage_limit", resetAt: (r as { resetsAt: number }).resetsAt });
  });
});

describe("CLI notice in result / assistant text (audit #2)", () => {
  test("Claude's result text on an is_error turn is classified", async () => {
    const provider = new MockSessionProvider("claude", [
      [done({ isError: true, resultText: "You've hit your weekly limit · resets Oct 28, 9am (UTC)" })],
    ]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError?.kind).toBe("usage_limit");
  });

  for (const reply of [
    "The upstream API returned 429 Too Many Requests twice, so I added retries.",
    "HTTP 429 handler added; tests pass",
    "You've reached your goal: the rate limit test passes",
  ]) {
    test(`a model reply in a failed turn is not a limit: ${JSON.stringify(reply)}`, async () => {
      const provider = new MockSessionProvider("claude", [[{ type: "text_done", content: reply }, done({ isError: true, resultText: reply })]]);
      const session = makeSession({ _testProvider: provider });
      await session.send("work", AUTH);
      await until(() => session.status === "error");
      expect(session.lastTurnInfraError).toBeNull();
    });
  }
});

describe("turn-start clearing (audit #3, #5)", () => {
  test("lastTurnInfraError is cleared when the next turn starts, not when it ends", async () => {
    const provider = new MockSessionProvider("claude", [
      [done({ isError: true, errorMessage: "You've hit your session limit · resets 3pm (UTC)" })],
      [bash(1)],
    ]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError).not.toBeNull();
    await session.send("again", AUTH);
    await until(() => session.pendingToolApprovals().length === 1); // turn 2 running, parked on approval
    expect(session.lastTurnInfraError).toBeNull();
    await session.interrupt(AUTH);
  });

  test("a message that joins the running turn keeps that turn's rate-limit record", async () => {
    const r = rejected();
    const provider = new MockSessionProvider("claude", [[r, { type: "text_delta", content: "working" }]], { stall: true, midTurn: true });
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "thinking");
    await new Promise((res) => setTimeout(res, 20));
    await session.send("also this", AUTH); // joins (mid-turn push), no new turn
    expect(provider.midTurnPushes.length).toBe(1);
    // The interrupted partial turn's boundary is absorbed; the continuation fails.
    provider.emitLive(done());
    provider.emitLive(done({ isError: true }));
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError).toMatchObject({ kind: "usage_limit", resetAt: (r as { resetsAt: number }).resetsAt });
  });
});

describe("end_attempt keeps the attempt ended (audit #4)", () => {
  test("later prompted and backend-started turns are denied too, and background tasks are stopped", async () => {
    const provider = new MockSessionProvider("claude", [[bash(1), bashDone(1), bash(2)], [bash(3)]], { stall: true });
    const session = makeSession({
      _testProvider: provider,
      initialMode: { mode: "autonomous", maxTurns: 1 },
      onBudgetExhausted: "end_attempt",
    });
    provider.onSessionEvent?.({ type: "background_tasks", tasks: [{ id: "bg-1", kind: "subagent", description: "bg", status: "running" }] });
    await session.send("work", AUTH);
    await until(() => provider.canUseToolResults.length === 2 && session.status === "idle");
    await until(() => provider.stoppedTasks.includes("bg-1"));
    expect(session.budgetExhausted).toBe(true);

    // A later prompt from a system principal (the dispatcher, a controller): still ended.
    await session.send("try again", SYSTEM);
    await until(() => provider.canUseToolResults.length === 3);
    expect(provider.canUseToolResults[2]!.behavior).toBe("deny");
    await until(() => session.status === "idle");
    expect(session.budgetExhausted).toBe(true);

    // A turn the backend starts on its own: still ended, flag kept.
    provider.startOwnTurn([bash(4)]);
    await until(() => provider.boundGates.length === 1);
    await new Promise((res) => setTimeout(res, 20));
    const verdict = await provider.boundGates[0]!.canUseTool("t4", "ap-4", "Bash", { command: "echo 4" });
    expect(verdict.behavior).toBe("deny");
    expect(session.budgetExhausted).toBe(true);

    session.setMode("autonomous", 2);
    expect(session.budgetExhausted).toBe(false);
  });
});

class UnbudgetedProvider extends MockSessionProvider {
  readonly enforcesToolBudget = false;
}

describe("toolBudgetEnforced (audit #7)", () => {
  test("true on a gated backend; false, with a warning, on one that skips approvals", () => {
    expect(makeSession({ _testProvider: new MockSessionProvider("claude") }).toolBudgetEnforced).toBe(true);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: unknown) => { warnings.push(String(m)); };
    try {
      const s = makeSession({ _testProvider: new UnbudgetedProvider("codex"), onBudgetExhausted: "end_attempt" });
      expect(s.toolBudgetEnforced).toBe(false);
      expect(warnings.some((w) => w.includes("can't be enforced"))).toBe(true);
      warnings.length = 0;
      makeSession({ _testProvider: new UnbudgetedProvider("codex") }); // park: nothing to warn about
      expect(warnings).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });
});

/** A backend whose interrupt waits for the test to release it. */
class SlowInterruptProvider extends MockSessionProvider {
  release!: () => void;
  override runTurn(opts: TurnOpts): TurnRun {
    const run = super.runTurn(opts);
    const gate = new Promise<void>((r) => { this.release = r; });
    return { ...run, interrupt: () => gate };
  }
}

/** A backend whose teardown never completes. */
class StuckTeardownProvider extends MockSessionProvider {
  override async teardown(): Promise<void> {
    this.teardownCount++;
    await new Promise<void>(() => {});
  }
}

describe("interrupt and terminate races (audit #8)", () => {
  test("an interrupt that returns after another turn took over leaves that turn alone", async () => {
    const provider = new SlowInterruptProvider("claude", [[bash(1)], [bash(2)]], { stall: true });
    const session = makeSession({ _testProvider: provider });
    await session.send("first", AUTH);
    await until(() => session.pendingToolApprovals().length === 1);
    const releaseFirst = provider.release; // turn 1's gate (turn 2 gets its own)
    const pending = session.interrupt(AUTH);
    await session.terminateBackend(AUTH, "test");
    expect(session.status).toBe("idle");
    await session.send("second", AUTH);
    await until(() => session.pendingToolApprovals().some((a) => a.approvalId === "ap-2"));
    releaseFirst();
    await pending;
    expect(session.status).toBe("waiting_approval");
    expect(session.pendingToolApprovals().map((a) => a.approvalId)).toEqual(["ap-2"]);
    await session.terminateBackend(AUTH, "cleanup");
  });

  test("terminateBackend does not hang on a teardown that never finishes", async () => {
    const provider = new StuckTeardownProvider("claude", [[bash(1)]], { stall: true });
    const session = makeSession({ _testProvider: provider, initialMode: { mode: "autonomous" } });
    await session.send("work", AUTH);
    await until(() => session.status === "tool_running");
    const t0 = Date.now();
    await session.terminateBackend(AUTH, "test", { teardownTimeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(session.status).toBe("idle");
    expect(provider.teardownCount).toBe(1);
  });
});

// ── Round-2 audit fixes ──────────────────────────────────────────────────────

describe("a person can take over a spent end_attempt worker (audit-2 #1)", () => {
  async function spentWorker() {
    const provider = new MockSessionProvider("claude", [[bash(1), bashDone(1), bash(2)], [bash(3)]], { stall: true });
    const session = makeSession({
      _testProvider: provider,
      initialMode: { mode: "autonomous", maxTurns: 1 },
      onBudgetExhausted: "end_attempt",
    });
    const infos: Array<Record<string, unknown>> = [];
    session.attach({ id: "c", auth: AUTH, send: (m) => { if (m.type === "session.info_update") infos.push(m as unknown as Record<string, unknown>); } });
    await session.send("work", SYSTEM);
    await until(() => provider.canUseToolResults.length === 2 && session.status === "idle");
    expect(session.budgetExhausted).toBe(true);
    return { provider, session, infos };
  }

  test("session info says so, and the denial says how to re-arm", async () => {
    const { provider, session, infos } = await spentWorker();
    const last = infos.at(-1) as { session?: { budgetExhausted?: boolean } } | undefined;
    expect(JSON.stringify(last)).toContain('"budgetExhausted":true');
    expect(provider.canUseToolResults[1]!.message).toContain("/mode");
    void session;
  });

  test("a person's setMode lifts it — even to the mode already set; a system one does not", async () => {
    const { session } = await spentWorker();
    session.setMode("guarded", undefined, SYSTEM);
    expect(session.budgetExhausted).toBe(true);
    session.setMode("guarded", undefined, AUTH); // already guarded
    expect(session.budgetExhausted).toBe(false);
  });

  test("a person's new turn lifts it: the call is gated normally, not denied", async () => {
    const { provider, session } = await spentWorker();
    await session.send("let me look", AUTH);
    await until(() => session.pendingToolApprovals().length === 1);
    expect(session.budgetExhausted).toBe(false);
    expect(provider.canUseToolResults).toHaveLength(2); // the third call is waiting on a person, not refused
    await session.interrupt(AUTH);
  });
});

describe("the CLI notice as the reply's last block (audit-2 #6)", () => {
  test("narration, then the limit notice", async () => {
    const reply = "I'll start with the failing test.\n\nYou've hit your session limit · resets 3pm (UTC)";
    const provider = new MockSessionProvider("claude", [[{ type: "text_done", content: reply }, done({ isError: true })]]);
    const session = makeSession({ _testProvider: provider });
    await session.send("work", AUTH);
    await until(() => session.status === "error");
    expect(session.lastTurnInfraError?.kind).toBe("usage_limit");
  });
});
