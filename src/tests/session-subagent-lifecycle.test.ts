/**
 * Sub-agent lifecycle cleanup — the orphan/leak regression.
 *
 * `subagent_stop` (the SDK's SubagentStop hook) used to be the ONLY path that
 * removed an entry from Session's `#subagents` map. That hook cannot fire when
 * the SDK query is aborted mid-turn — interrupt, setModel, rotate, provider
 * switch all call `#abortController.abort()` — so every abort permanently
 * orphaned each in-flight sub-agent:
 *
 *   - `subagentSnapshot` only ever grew (the reported count never came down)
 *   - `#subagents` / `#subagentRegistrations` grew for the session's lifetime
 *   - each orphan kept a LIVE delegated ZeroID token until session destroy
 *
 * `#sweepStaleSubagents` now runs at every turn boundary and on the abort
 * paths. These tests pin all three consequences.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import {
  CARRYOVER_EVENT_TYPES,
  MAX_CARRYOVER_EVENTS,
} from "../daemon/providers/claude/index.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { AgentIdentityManager } from "../daemon/agent-identity.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:subagent-test",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-sa",
  projectId: "proj-sa",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-subagent-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const spawn = (agentId: string, agentType = "explore"): ProviderEvent =>
  ({ type: "subagent_start", agentId, agentType });
const stop = (agentId: string): ProviderEvent => ({ type: "subagent_stop", agentId });
const done = (): ProviderEvent => ({ type: "turn_done", result: mockResult() });

/**
 * Records deactivation calls so tests can assert the ZeroID token for an
 * orphaned sub-agent actually gets revoked (the leak that mattered most).
 */
function stubIdentityManager() {
  const deactivatedSubagents: Array<{ sessionId: string; agentId: string }> = [];
  const mgr = {
    async registerSessionAgent(sessionId: string) {
      return { wimseUri: `spiffe://test/session/${sessionId}`, token: "test-token" };
    },
    async registerSubagent(_sessionId: string, agentId: string, agentType: string) {
      return { wimseUri: `spiffe://test/subagent/${agentType}/${agentId}` };
    },
    async deactivateSubagent(sessionId: string, agentId: string) {
      deactivatedSubagents.push({ sessionId, agentId });
    },
    async deactivateSessionAgent() {},
  } as unknown as AgentIdentityManager;
  return { mgr, deactivatedSubagents };
}

function makeSession(
  script: ProviderEvent[][],
  opts: { stall?: boolean; midTurn?: boolean; identityManager?: AgentIdentityManager } = {},
): { session: Session; provider: MockSessionProvider } {
  const id = randomUUID();
  const provider = new MockSessionProvider("mock", script, {
    stall: opts.stall ?? false,
    midTurn: opts.midTurn ?? false,
  });
  const registry = new ProviderRegistry("mock");
  registry.register({ id: "mock", displayName: "mock", create: () => provider });
  store.createSession({
    id,
    name: "subagent-test",
    workdir: tmp,
    status: "idle",
    createdBy: AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: AUTH.accountId,
    projectId: AUTH.projectId,
  });
  const session = new Session({
    name: "subagent-test",
    workdir: tmp,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: id,
    providers: registry,
    providerId: "mock",
    ...(opts.identityManager ? { identityManager: opts.identityManager } : {}),
  });
  return { session, provider };
}

function recordingClient(): AttachedClient & { received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return { id: randomUUID(), auth: AUTH, received, send: (m) => { received.push(m); } };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

describe("sub-agent cleanup at turn boundaries", () => {
  it("sweeps sub-agents whose stop hook never fired when the turn ends", async () => {
    // Three spawns, zero stops — what an aborted or hook-dropping turn leaves.
    const { session } = makeSession([[spawn("a1"), spawn("a2"), spawn("a3"), done()]]);
    session.attach(recordingClient());

    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    // Pre-fix this was 3, and stayed 3 while later turns added more.
    expect(session.subagentSnapshot).toHaveLength(0);
  });

  it("does not accumulate across turns", async () => {
    const { session } = makeSession([
      [spawn("t1-a"), spawn("t1-b"), done()],
      [spawn("t2-a"), spawn("t2-b"), done()],
    ]);
    session.attach(recordingClient());

    await session.send("turn one", AUTH);
    await waitFor(() => session.status === "idle");
    expect(session.subagentSnapshot).toHaveLength(0);

    await session.send("turn two", AUTH);
    await waitFor(() => session.status === "idle");
    // The reported symptom: 2 → 4 → 6 … as turns went by.
    expect(session.subagentSnapshot).toHaveLength(0);
  });

  it("leaves the normal stop path intact (no double-handling)", async () => {
    const { session } = makeSession([[spawn("clean"), stop("clean"), done()]]);
    session.attach(recordingClient());

    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    expect(session.subagentSnapshot).toHaveLength(0);
  });

  it("revokes the ZeroID identity of a swept sub-agent", async () => {
    const { mgr, deactivatedSubagents } = stubIdentityManager();
    const { session } = makeSession([[spawn("orphan"), done()]], { identityManager: mgr });
    session.attach(recordingClient());

    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");
    await waitFor(() => deactivatedSubagents.length > 0);

    // The leak that mattered: pre-fix this token stayed live until the whole
    // session was destroyed.
    expect(deactivatedSubagents.map((d) => d.agentId)).toEqual(["orphan"]);
  });

  it("revokes each orphan exactly once even when a stop also arrives", async () => {
    const { mgr, deactivatedSubagents } = stubIdentityManager();
    const { session } = makeSession([[spawn("both"), stop("both"), done()]], {
      identityManager: mgr,
    });
    session.attach(recordingClient());

    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");
    await waitFor(() => deactivatedSubagents.length > 0);

    // subagent_stop revoked it and removed the entry, so the sweep finds
    // nothing left to revoke.
    expect(deactivatedSubagents).toHaveLength(1);
  });
});

describe("sub-agent cleanup on abort paths", () => {
  it("sweeps on interrupt — the path where SubagentStop provably cannot fire", async () => {
    // stall: emit the spawns, then never close the queue and never emit
    // turn_done. This is a turn still in flight, exactly as when a user
    // interrupts mid-Task.
    const { session } = makeSession([[spawn("live-1"), spawn("live-2")]], { stall: true });
    session.attach(recordingClient());

    await session.send("go", AUTH);
    await waitFor(() => session.subagentSnapshot.length === 2);

    await session.interrupt(AUTH);

    expect(session.subagentSnapshot).toHaveLength(0);
  });

  it("sweeps on provider teardown (setModel / rotate / switch)", async () => {
    const { session } = makeSession([[spawn("live-1"), spawn("live-2")]], { stall: true });
    session.attach(recordingClient());

    await session.send("go", AUTH);
    await waitFor(() => session.subagentSnapshot.length === 2);

    // setModel tears the provider down mid-turn (session.ts:2639), aborting the
    // SDK query — so no SubagentStop can arrive for the two live sub-agents.
    await session.setModel("haiku", undefined, AUTH);

    expect(session.subagentSnapshot).toHaveLength(0);
  });

  it("broadcasts info_update when a sweep actually removes something", async () => {
    const { session } = makeSession([[spawn("live-1")]], { stall: true });
    const client = recordingClient();
    session.attach(client);

    await session.send("go", AUTH);
    await waitFor(() => session.subagentSnapshot.length === 1);
    const before = client.received.filter((m) => m.type === "session.info_update").length;

    await session.interrupt(AUTH);

    // Clients must learn the count dropped, not just the daemon.
    expect(
      client.received.filter((m) => m.type === "session.info_update").length,
    ).toBeGreaterThan(before);
  });
});

describe("turn-boundary accounting (the stuck-'thinking' root cause)", () => {
  /**
   * `#pendingMidTurnCount` exists so the consumer can absorb the intermediate
   * turn_done the SDK emits when a mid-turn push starts a NEW query. It used to
   * be incremented for every mid-turn push — including "later", which merges
   * into the running turn and produces no extra turn_done at all
   * (ClaudeProvider: `shouldQuery = priority !== "later"`).
   *
   * The consequence was the turn's real terminal turn_done being swallowed as
   * an intermediate boundary: status re-asserted to "thinking", loop
   * `continue`d, and the session hung until the 5-minute stall watchdog or the
   * next send. The turn's sub-agents were stranded with it, because neither the
   * boundary flush nor the consumer's finally ever ran.
   */
  it("a 'later' mid-turn push does not make the session swallow its terminal turn_done", async () => {
    const { session, provider } = makeSession([[spawn("sa-1")]], { stall: true, midTurn: true });
    session.attach(recordingClient());

    await session.send("start work", AUTH);
    await waitFor(() => session.subagentSnapshot.length === 1);
    expect(session.status).not.toBe("idle");

    // "later" merges into the running turn — no second query, no second turn_done.
    await session.send("also consider this", AUTH, undefined, "later");
    expect(provider.midTurnPushes).toEqual([
      { content: expect.stringContaining("also consider this"), priority: "later" },
    ]);

    // The one and only turn_done for this turn.
    expect(provider.emitLive({ type: "turn_done", result: mockResult() })).toBe(true);

    // Pre-fix this timed out: status stayed "thinking" forever.
    await waitFor(() => session.status === "idle");
    // And the turn's sub-agent is reconciled, because the consumer actually exited.
    expect(session.subagentSnapshot).toHaveLength(0);
  });

  it("still absorbs the intermediate turn_done for a querying ('now') push", async () => {
    const { session, provider } = makeSession([[spawn("sa-1")]], { stall: true, midTurn: true });
    session.attach(recordingClient());

    await session.send("start work", AUTH);
    await waitFor(() => session.subagentSnapshot.length === 1);

    // "now" DOES start another query, so two turn_dones are expected.
    await session.send("actually, do this instead", AUTH, undefined, "now");
    expect(provider.midTurnPushes[0]!.priority).toBe("now");

    // First turn_done is the intermediate boundary — absorbed, session keeps working.
    provider.emitLive({ type: "turn_done", result: mockResult() });
    await new Promise((r) => setTimeout(r, 50));
    expect(session.status).not.toBe("idle");

    // The continuation's terminal turn_done ends it.
    provider.emitLive({ type: "turn_done", result: mockResult() });
    await waitFor(() => session.status === "idle");
  });

  it("reconciles sub-agents at an absorbed mid-turn boundary", async () => {
    const { session, provider } = makeSession([[spawn("boundary-1")]], {
      stall: true,
      midTurn: true,
    });
    session.attach(recordingClient());

    await session.send("start work", AUTH);
    await waitFor(() => session.subagentSnapshot.length === 1);

    await session.send("steer", AUTH, undefined, "now");
    provider.emitLive({ type: "turn_done", result: mockResult() }); // intermediate

    // The mid-turn branch `continue`s without dispatching to
    // #handleProviderEvent, so this boundary is the only place that can clear it.
    await waitFor(() => session.subagentSnapshot.length === 0);
  });

  it("signals turn exit to the provider so late events can't land in an undrained queue", async () => {
    const { session, provider } = makeSession([[spawn("x"), done()]]);
    session.attach(recordingClient());

    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    expect(provider.endTurnCount).toBe(1);
    // Queue closed: a late event now surfaces through the provider's
    // undeliverable path instead of being buffered where nobody reads it.
    expect(provider.emitLive(stop("x"))).toBe(false);
  });
});

describe("undeliverable-event carryover policy", () => {
  it("carries id-keyed lifecycle events and refuses turn-scoped ones", () => {
    // Safe to replay late: id-keyed, and their handlers no-op on unknown ids.
    expect(CARRYOVER_EVENT_TYPES.has("subagent_stop")).toBe(true);
    expect(CARRYOVER_EVENT_TYPES.has("tool_complete")).toBe(true);

    // Never replay: a stale turn_done would end the next turn the instant it
    // started, and stale text would corrupt its transcript.
    expect(CARRYOVER_EVENT_TYPES.has("turn_done")).toBe(false);
    expect(CARRYOVER_EVENT_TYPES.has("text_delta")).toBe(false);
    expect(CARRYOVER_EVENT_TYPES.has("text_done")).toBe(false);
    expect(CARRYOVER_EVENT_TYPES.has("error")).toBe(false);

    // Bounded, so a delivery failure can't become unbounded memory growth.
    expect(MAX_CARRYOVER_EVENTS).toBeGreaterThan(0);
    expect(MAX_CARRYOVER_EVENTS).toBeLessThanOrEqual(1000);
  });
});
