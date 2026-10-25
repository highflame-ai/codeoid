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
