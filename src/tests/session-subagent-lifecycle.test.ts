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
  opts: { stall?: boolean; identityManager?: AgentIdentityManager } = {},
): { session: Session; provider: MockSessionProvider } {
  const id = randomUUID();
  const provider = new MockSessionProvider("mock", script, { stall: opts.stall ?? false });
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
