/**
 * The approval gate judges a shell command by what it runs (#431), through a
 * real Session + MockSessionProvider (which calls canUseTool as the SDK does):
 * high risk asks in guarded mode, a credential file is refused in every mode,
 * a low-risk read runs unasked in guarded mode only when the config says so,
 * and what the gate decides is what the approval card shows. Autonomous mode
 * waits on no one (#448): a command of any level runs (the OS sandbox holds
 * it), a credential search is refused with its reason, and a spent budget
 * says so the moment it reverts the session to guarded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { getConfigDir } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { AUTONOMOUS_BUDGET_SPENT, Session, type SessionCreateOptions } from "../daemon/session.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext, SessionMessage, SessionMode } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;
let audits: Array<{ action: string; detail?: string }> = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-riskgate-"));
  store = new Store(join(tmp, "codeoid.db"));
  audits = [];
  const audit = store.audit.bind(store);
  store.audit = (subject, action, sessionId, detail) => {
    audits.push({ action, ...(detail ? { detail } : {}) });
    audit(subject, action, sessionId, detail);
  };
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});
afterEach(async () => {
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function bash(command: string | Record<string, unknown>, name = "Bash"): ProviderEvent[] {
  const input = typeof command === "string" ? { command } : command;
  return [
    { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name, input, approvalId: "ap-1" },
    {
      type: "turn_done",
      result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 },
    },
  ];
}

/** What a session reads of the config, at its defaults. */
const BASE_CONFIG = {
  workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
  compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
  labeling: {},
  telemetry: { osc8: "auto" },
  autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
  session: {},
};

function makeSession(provider: MockSessionProvider, mode: SessionMode, approvals?: CodeoidConfig["approvals"], maxTurns = 10): { session: Session; cards: SessionMessage[]; infos: SessionMessage[] } {
  const id = randomUUID();
  store.createSession({
    id, name: "rg", workdir: tmp, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  const opts: SessionCreateOptions = {
    name: "rg", workdir: tmp, auth: AUTH, store, transcriptStore, existingId: id, _testProvider: provider,
    initialMode: { mode, ...(mode === "autonomous" ? { maxTurns } : {}) },
    ...(approvals ? { config: { ...BASE_CONFIG, approvals } as unknown as CodeoidConfig } : {}),
  };
  const session = new Session(opts);
  const cards: SessionMessage[] = [];
  const infos: SessionMessage[] = [];
  // A snapshot: the session updates its message objects in place as the call settles.
  session.attach({
    id: "c",
    auth: AUTH,
    send: (m: { type: string; role?: string }) => {
      if (m.type === "session.message" && m.role === "tool_call") cards.push(structuredClone(m) as SessionMessage);
      if (m.type === "session.message" && m.role === "info") infos.push(m as SessionMessage);
    },
  } as never);
  return { session, cards, infos };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Run one command (or `name`'s call); say whether the gate let it through unasked, and what the card showed. */
async function gate(command: string | Record<string, unknown>, mode: SessionMode, approvals?: CodeoidConfig["approvals"], opts: { name?: string; unattended?: boolean } = {}) {
  const provider = new MockSessionProvider("mock", [bash(command, opts.name)]);
  const { session, cards, infos } = makeSession(provider, mode, approvals);
  const release = opts.unattended ? session.beginUnattended() : null;
  void session.send("go", AUTH);
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const asked = session.pendingToolApprovals().length > 0;
  const status = session.status;
  const card = cards[0]?.tool?.state as { phase: string; message?: string; risk?: { level: string; reasons: string[] } } | undefined;
  if (asked) await session.interrupt(AUTH);
  release?.();
  const result = provider.canUseToolResults[0] as { behavior?: string; message?: string } | undefined;
  return { asked, status, behavior: result?.behavior, message: result?.message, card, infos, budget: session.turnsRemaining, pending: session.pendingToolApprovals() };
}

describe("the approval gate judges shell commands by risk (#431)", () => {
  test("a high-risk command asks in guarded mode, with the risk on the card", async () => {
    const r = await gate("rm -rf ~", "guarded");
    expect(r.asked).toBe(true);
    expect(r.card?.phase).toBe("waiting_confirmation");
    expect(r.card?.risk).toMatchObject({ level: "high" });
    expect(r.card?.risk?.reasons[0]).toContain("rm deletes");
  });

  test("a force push asks in guarded mode, and its card waits for the answer", async () => {
    const r = await gate("git push --force origin main", "guarded");
    expect(r.asked).toBe(true);
    expect(r.card?.phase).toBe("waiting_confirmation");
    expect(r.card?.risk?.level).toBe("high");
  });

  test("a search over a directory holding credential files asks in guarded mode", async () => {
    const r = await gate("grep -r token ~", "guarded");
    expect(r.asked).toBe(true);
    expect(r.card?.phase).toBe("waiting_confirmation");
  });

  test("a command it can't read asks in guarded mode, whatever askOnUnknown says (guarded asks about every command that isn't low)", async () => {
    expect((await gate('eval "$X"', "guarded")).asked).toBe(true);
    expect((await gate('eval "$X"', "guarded", { autoAllowLowRisk: true, askOnUnknown: false })).asked).toBe(true);
    const missing = await gate({ description: "no command here" }, "guarded", { autoAllowLowRisk: true, askOnUnknown: false });
    expect(missing.asked).toBe(true);
    expect(missing.card?.risk?.level).toBe("unknown");
  });

  test("an ordinary command still runs unasked in autonomous mode, and its card says it ran", async () => {
    const r = await gate("npm test", "autonomous");
    expect(r.asked).toBe(false);
    expect(r.behavior).toBe("allow");
    expect(r.card?.phase).toBe("executing");
  });

  test("a read inside the workspace asks in guarded mode by default, and runs unasked when the config allows", async () => {
    expect((await gate("git status", "guarded")).asked).toBe(true);
    const r = await gate("git status", "guarded", { autoAllowLowRisk: true, askOnUnknown: true });
    expect(r.asked).toBe(false);
    expect(r.card?.phase).toBe("executing");
    // Never a medium one, and never in interactive mode.
    expect((await gate("npm test", "guarded", { autoAllowLowRisk: true, askOnUnknown: true })).asked).toBe(true);
    expect((await gate("git status", "interactive", { autoAllowLowRisk: true, askOnUnknown: true })).asked).toBe(true);
  });

  test("a command naming one of codeoid's credential files is refused, in any mode", async () => {
    const r = await gate(`cat ${join(getConfigDir(), "config.json")}`, "autonomous");
    expect(r.asked).toBe(false);
    expect(r.behavior).toBe("deny");
  });

  test("codeoid approve sees the risk too", async () => {
    const provider = new MockSessionProvider("mock", [bash("git push --force")]);
    const { session } = makeSession(provider, "guarded");
    void session.send("go", AUTH);
    await until(() => session.pendingToolApprovals().length > 0);
    expect(session.pendingToolApprovals()[0]?.risk?.level).toBe("high");
    await session.interrupt(AUTH);
  });
});

describe("autonomous mode waits on no one: the OS sandbox is its boundary (#448)", () => {
  test("a command of any risk level runs unasked, the not-understood and unreadable included; it spends budget and the audit names its level", async () => {
    for (const command of ["rm -rf ~/projects/x", "git push --force origin main", 'eval "$X"'] as const) {
      const r = await gate(command, "autonomous");
      expect([command, r.asked, r.behavior, r.card?.phase, r.budget]).toEqual([command, false, "allow", "executing", 9]);
    }
    for (const input of [{ description: "no command here" }, { command: ["rm", "-rf", 1] }, { command: "x".repeat(100_001) }]) {
      const r = await gate(input, "autonomous");
      expect([r.asked, r.behavior]).toEqual([false, "allow"]);
    }
    expect(audits.some((a) => a.action === "session.auto_approve" && a.detail === "tool=Bash mode=autonomous risk=high")).toBe(true);
    expect(audits.some((a) => a.action === "session.auto_approve" && a.detail === "tool=Bash mode=autonomous risk=unreadable")).toBe(true);
    expect(audits.some((a) => a.action === "session.risk_ask")).toBe(false);
  });

  test("an unattended run doesn't park on a high-risk command", async () => {
    const r = await gate("rm -rf ~/projects/x", "autonomous", undefined, { unattended: true });
    expect([r.asked, r.behavior, r.status === "waiting_approval"]).toEqual([false, "allow", false]);
  });

  test("a search or command reaching a directory that holds credentials is refused at once, never asked: the agent reads why, the transcript and the audit say so, no budget is spent", async () => {
    for (const [name, input, what] of [
      ["Bash", { command: "grep -r token ~" }, "a command reaching"],
      ["Bash", { command: "rm -rf ~" }, "a command reaching"],
      ["Grep", { pattern: "token", path: homedir() }, "a call reaching"],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const r = await gate(input, "autonomous", undefined, { name });
      expect([name, r.asked, r.behavior, r.budget]).toEqual([name, false, "deny", 10]);
      expect(r.message).toStartWith(`Refused: autonomous mode doesn't allow ${what} `);
      expect(r.message).toContain("which may lead to credentials");
      expect(r.message).toContain("switch this session to guarded mode");
      expect(r.card).toMatchObject({ phase: "cancelled", message: r.message });
      const info = r.infos.find((m) => (m.metadata as { event?: string } | undefined)?.event === "autonomous.refused");
      expect(info?.content).toContain(`Refused ${name} in autonomous mode: ${what}`);
      expect(info?.metadata).toMatchObject({ tool: name, kind: "credential_dir" });
    }
    expect(audits.filter((a) => a.action === "session.autonomous_refuse").map((a) => a.detail)).toEqual(["tool=Bash kind=credential_dir", "tool=Bash kind=credential_dir", "tool=Grep kind=credential_dir"]);
  });

  test("a credential read stays refused, as in every mode", async () => {
    const r = await gate(`cat ${join(getConfigDir(), "config.json")}`, "autonomous");
    expect([r.asked, r.behavior]).toEqual([false, "deny"]);
    expect(r.message).toContain("holds credentials");
  });

  test("a question to the owner still asks", async () => {
    const r = await gate({ questions: [{ question: "which?", options: [] }] }, "autonomous", undefined, { name: "AskUserQuestion" });
    expect(r.asked).toBe(true);
  });

  test("the budget running out says so at once, on the session and in the transcript, and the session is guarded from then on", async () => {
    const call = (id: string): ProviderEvent => ({ type: "tool_start", toolId: id, sdkToolUseId: `sdk-${id}`, name: "Bash", input: { command: "npm test" }, approvalId: `ap-${id}` });
    const done = bash("x").at(-1)!;
    const provider = new MockSessionProvider("mock", [[call("1"), call("2"), done]]);
    const { session, infos } = makeSession(provider, "autonomous", undefined, 1);
    void session.send("go", AUTH);
    await until(() => session.pendingToolApprovals().length > 0);
    expect(provider.canUseToolResults[0]?.behavior).toBe("allow");
    expect(session.mode).toBe("guarded");
    const notice = infos.find((m) => (m.metadata as { event?: string } | undefined)?.event === "budget.spent");
    expect(notice?.content).toBe(`⚠ ${AUTONOMOUS_BUDGET_SPENT}`);
    expect(AUTONOMOUS_BUDGET_SPENT).toContain("now guarded, writes and commands will ask");
    expect(session.toInfo()).toMatchObject({ mode: "guarded", autonomousBudgetSpent: true });
    expect(audits.some((a) => a.action === "session.budget_spent")).toBe(true);
    await session.interrupt(AUTH);
    // Choosing a mode answers it.
    session.setMode("autonomous", 5, AUTH);
    expect(session.toInfo().autonomousBudgetSpent).toBeUndefined();
  });
});
