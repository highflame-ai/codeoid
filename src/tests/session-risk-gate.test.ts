/**
 * The approval gate judges a shell command by what it runs (#431), through a
 * real Session + MockSessionProvider (which calls canUseTool as the SDK does):
 * high risk asks in every mode, a credential file is refused, a low-risk read
 * runs unasked in guarded mode only when the config says so, and what the
 * gate decides is what the approval card shows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { getConfigDir } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Session, type SessionCreateOptions } from "../daemon/session.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext, SessionMessage, SessionMode } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-riskgate-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});
afterEach(async () => {
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function bash(command: string): ProviderEvent[] {
  return [
    { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Bash", input: { command }, approvalId: "ap-1" },
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

function makeSession(provider: MockSessionProvider, mode: SessionMode, approvals?: CodeoidConfig["approvals"]): { session: Session; cards: SessionMessage[] } {
  const id = randomUUID();
  store.createSession({
    id, name: "rg", workdir: tmp, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  const opts: SessionCreateOptions = {
    name: "rg", workdir: tmp, auth: AUTH, store, transcriptStore, existingId: id, _testProvider: provider,
    initialMode: { mode, ...(mode === "autonomous" ? { maxTurns: 10 } : {}) },
    ...(approvals ? { config: { ...BASE_CONFIG, approvals } as unknown as CodeoidConfig } : {}),
  };
  const session = new Session(opts);
  const cards: SessionMessage[] = [];
  // A snapshot: the session updates its message objects in place as the call settles.
  session.attach({ id: "c", auth: AUTH, send: (m: { type: string; role?: string }) => { if (m.type === "session.message" && m.role === "tool_call") cards.push(structuredClone(m) as SessionMessage); } } as never);
  return { session, cards };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Run one command; say whether the gate let it through unasked, and what the card showed. */
async function gate(command: string, mode: SessionMode, approvals?: CodeoidConfig["approvals"]) {
  const provider = new MockSessionProvider("mock", [bash(command)]);
  const { session, cards } = makeSession(provider, mode, approvals);
  void session.send("go", AUTH);
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const asked = session.pendingToolApprovals().length > 0;
  const card = cards[0]?.tool?.state as { phase: string; risk?: { level: string; reasons: string[] } } | undefined;
  if (asked) await session.interrupt(AUTH);
  return { asked, behavior: provider.canUseToolResults[0]?.behavior, card, pending: session.pendingToolApprovals() };
}

describe("the approval gate judges shell commands by risk (#431)", () => {
  test("a high-risk command asks in autonomous mode, with the risk on the card", async () => {
    const r = await gate("rm -rf ~", "autonomous");
    expect(r.asked).toBe(true);
    expect(r.card?.phase).toBe("waiting_confirmation");
    expect(r.card?.risk).toMatchObject({ level: "high" });
    expect(r.card?.risk?.reasons[0]).toContain("rm deletes");
  });

  test("a force push asks in autonomous mode, and its card waits for the answer", async () => {
    const r = await gate("git push --force origin main", "autonomous");
    expect(r.asked).toBe(true);
    expect(r.card?.phase).toBe("waiting_confirmation");
    expect(r.card?.risk?.level).toBe("high");
  });

  test("a search over a directory holding credential files asks in autonomous mode", async () => {
    const r = await gate("grep -r token ~", "autonomous");
    expect(r.asked).toBe(true);
    expect(r.card?.phase).toBe("waiting_confirmation");
  });

  test("a command it can't read asks in autonomous mode — unless the config says not to", async () => {
    expect((await gate('eval "$X"', "autonomous")).asked).toBe(true);
    expect((await gate('eval "$X"', "autonomous", { autoAllowLowRisk: false, askOnUnknown: false })).asked).toBe(false);
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
