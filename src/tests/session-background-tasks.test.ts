/**
 * Background-task visibility + the wake path (session-scoped provider events).
 *
 * The incident these guard (real audit data, session 882d0a15): a model spawned
 * background agents via its harness, promised "I'll report as soon as the three
 * agents land", ended its turn — and the landings arrived when no turn was in
 * flight, so the turn queue dropped them unread. codeoid tracked nothing (0
 * sub-agent identities across 5 Agent calls), showed nothing, and the session
 * sat idle until the owner interrupted it.
 *
 * Properties, in priority order:
 *   1. WAKE — a settle that arrives while idle injects a wake turn carrying the
 *      digest, attributed to system:background, exactly once per task.
 *   2. BUFFER — settles that arrive mid-turn deliver in ONE batched wake at the
 *      next idle (burst-collapse, same rule as <fleet_events>).
 *   3. LEVEL — the live set REPLACES on every event and clears on provider
 *      teardown; a missed event can never wedge a stale indicator.
 *   4. GENERIC — everything rides SessionScopedEvent; nothing here mentions a
 *      provider-specific tool or message name.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent, SessionScopedEvent } from "../daemon/providers/interface.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:bg-test",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-bg",
  projectId: "proj-bg",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-bg-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const done = (): ProviderEvent => ({ type: "turn_done", result: mockResult() });
const text = (content: string): ProviderEvent => ({ type: "text_done", content });

const level = (
  ...tasks: Array<{ id: string; status?: string; kind?: string; description?: string }>
): SessionScopedEvent => ({
  type: "background_tasks",
  tasks: tasks.map((t) => ({
    id: t.id,
    kind: t.kind ?? "subagent",
    description: t.description ?? `task ${t.id}`,
    status: t.status ?? "running",
  })),
});

const settled = (
  taskId: string,
  summary = `summary for ${taskId}`,
  status: "completed" | "failed" | "stopped" = "completed",
): SessionScopedEvent => ({ type: "background_task_settled", taskId, status, summary });

function makeSession(script: ProviderEvent[][]): {
  session: Session;
  provider: MockSessionProvider;
  /** Fire a session-scoped event exactly as a provider would. */
  fire: (e: SessionScopedEvent) => void;
} {
  const id = randomUUID();
  const provider = new MockSessionProvider("mock", script);
  const registry = new ProviderRegistry("mock");
  registry.register({ id: "mock", displayName: "mock", create: () => provider });
  store.createSession({
    id,
    name: "bg-test",
    workdir: tmp,
    status: "idle",
    createdBy: AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: AUTH.accountId,
    projectId: AUTH.projectId,
  });
  const session = new Session({
    name: "bg-test",
    workdir: tmp,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: id,
    providers: registry,
    providerId: "mock",
  });
  return {
    session,
    provider,
    fire: (e) => {
      // The Session installed this at construction; a provider with background
      // work calls it — possibly with NO turn in flight, which is the point.
      if (!provider.onSessionEvent) throw new Error("Session never wired onSessionEvent");
      provider.onSessionEvent(e);
    },
  };
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

/** Every prompt the provider was actually sent. */
const prompts = (p: MockSessionProvider): string[] => p.capturedOpts.map((o) => o.userMessage);

// ── 1. Visibility ────────────────────────────────────────────────────────────

describe("background-task visibility", () => {
  it("the level event populates toInfo().backgroundTasks and broadcasts", async () => {
    const { session, fire } = makeSession([[text("ok"), done()]]);
    const client = recordingClient();
    session.attach(client);

    fire(level({ id: "t1", kind: "subagent", description: "survey venues" }, { id: "t2", kind: "shell" }));
    const info = session.toInfo();
    expect(info.backgroundTasks).toHaveLength(2);
    expect(info.backgroundTasks![0]).toMatchObject({ id: "t1", kind: "subagent", description: "survey venues" });
    // Clients heard about it without polling.
    expect(client.received.some((m) => m.type === "session.info_update")).toBe(true);
  });

  it("REPLACE semantics — a smaller set shrinks, absent field when empty", async () => {
    const { session, fire } = makeSession([[done()]]);
    fire(level({ id: "t1" }, { id: "t2" }, { id: "t3" }));
    expect(session.toInfo().backgroundTasks).toHaveLength(3);

    // Not a diff: the payload IS the new truth.
    fire(level({ id: "t2" }));
    expect(session.toInfo().backgroundTasks).toHaveLength(1);
    expect(session.toInfo().backgroundTasks![0]!.id).toBe("t2");

    fire(level());
    // Absent, not empty-array — additive-field convention.
    expect(session.toInfo().backgroundTasks).toBeUndefined();
  });

  it("provider teardown clears the live set — the level is per-process", async () => {
    const { session, fire } = makeSession([[done()], [done()]]);
    session.attach(recordingClient());
    fire(level({ id: "t1" }));
    expect(session.toInfo().backgroundTasks).toHaveLength(1);

    // setModel tears the provider down and rebuilds it; its tasks died with it.
    await session.setModel("sonnet", null, AUTH);
    expect(session.toInfo().backgroundTasks).toBeUndefined();
  });
});

// ── 2. The wake path ─────────────────────────────────────────────────────────

describe("background-task wake", () => {
  it("a settle arriving while IDLE wakes the session with the digest", async () => {
    // Turn 1: the model defers. Turn 2 is consumed by the wake.
    const { session, provider, fire } = makeSession([
      [text("I'll report when the survey lands."), done()],
      [text("Survey results: …"), done()],
    ]);
    session.attach(recordingClient());
    await session.send("run the survey in the background", AUTH);
    await waitFor(() => session.status === "idle");

    fire(settled("t1", "3 venues fit; 1 is a lock"));
    await waitFor(() => prompts(provider).length === 2);
    await waitFor(() => session.status === "idle");

    const wake = prompts(provider)[1]!;
    expect(wake).toContain("<background_tasks>");
    expect(wake).toContain("NOT a message from the owner");
    expect(wake).toContain("[completed] task t1");
    expect(wake).toContain("3 venues fit; 1 is a lock");
    expect(wake).toContain("report the results you promised");
  });

  it("the wake is attributed to system:background in the audit log", async () => {
    const { session, fire } = makeSession([[done()], [done()]]);
    session.attach(recordingClient());
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    fire(settled("t1"));
    // Store has no audit-read API on purpose; read the table directly, the way
    // the migration tests do.
    const { Database } = await import("bun:sqlite");
    await waitFor(() => {
      const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
      const row = db
        .prepare("SELECT subject FROM audit_log WHERE action = ? LIMIT 1")
        .get("session.background_wake") as { subject?: string } | undefined;
      db.close();
      return row?.subject === "system:background";
    });
  });

  it("settles arriving MID-TURN buffer and deliver as ONE wake at idle", async () => {
    const { session, provider, fire } = makeSession([
      [text("working"), done()],
      [done()],
    ]);
    session.attach(recordingClient());
    const turn = session.send("long turn", AUTH);
    // send() is chained/async — wait until the turn has actually STARTED, or
    // the settles would arrive while status is still idle and wake immediately.
    await waitFor(() => prompts(provider).length === 1 && session.status !== "idle");
    // Both land while the turn is still in flight — no wake yet.
    fire(settled("a", "first result"));
    fire(settled("b", "second result", "failed"));
    expect(prompts(provider)).toHaveLength(1);

    await turn;
    await waitFor(() => prompts(provider).length === 2);
    const wake = prompts(provider)[1]!;
    // ONE injection carrying both — burst-collapse, and the failure is SHOWN.
    expect(wake).toContain("[completed] task a");
    expect(wake).toContain("[failed] task b");
    expect(prompts(provider)).toHaveLength(2);
  });

  it("a duplicated settle wakes exactly once", async () => {
    const { session, provider, fire } = makeSession([[done()], [done()], [done()]]);
    session.attach(recordingClient());
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    fire(settled("t1"));
    fire(settled("t1")); // an edge re-delivered by the harness
    await waitFor(() => prompts(provider).length === 2);
    await waitFor(() => session.status === "idle");
    // A third turn would mean the duplicate woke us again.
    await new Promise((r) => setTimeout(r, 150));
    expect(prompts(provider)).toHaveLength(2);
  });

  it("a settle DURING the wake turn queues and delivers after it", async () => {
    const { session, provider, fire } = makeSession([
      [done()],
      [text("reporting first result"), done()],
      [done()],
    ]);
    session.attach(recordingClient());
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    fire(settled("t1", "first"));
    await waitFor(() => prompts(provider).length === 2);
    // While the wake turn runs, a second task lands.
    fire(settled("t2", "second"));
    await waitFor(() => prompts(provider).length === 3);
    expect(prompts(provider)[2]).toContain("task t2");
  });

  it("a settle also drops the task from the live set without waiting for a level event", async () => {
    const { session, fire } = makeSession([[done()], [done()]]);
    session.attach(recordingClient());
    fire(level({ id: "t1" }, { id: "t2" }));
    fire(settled("t1"));
    const ids = (session.toInfo().backgroundTasks ?? []).map((t) => t.id);
    expect(ids).toEqual(["t2"]);
  });
});
