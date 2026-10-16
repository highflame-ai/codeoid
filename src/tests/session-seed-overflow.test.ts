/**
 * A history seed that overflows the incoming model's window.
 *
 * A fork / provider switch prepends the parent's conversation to the new
 * backend's first prompt, sized by seedBudgetChars. A real fork sized that seed
 * at 3.5 chars/token, sent 2.36M chars (~1.09M tokens) into a 1M window, and
 * the turn died with "Prompt is too long". Every later send resumed the same
 * backing session — which still held the oversized prompt — and died the same
 * way, while /rotate refused to run because the session had "only 2 turns".
 *
 *   O1  An overflowing seeded first turn is retried on a fresh backing session
 *       with a halved seed, without re-posting the user's message.
 *   O2  After the retry cap the overflow is surfaced, with a /rotate hint.
 *   O3  /rotate is allowed after an overflow, whatever the turn count.
 *   O4  An overflow with no seed in play is not retried.
 *   O5  config session.seed* sizes the seed.
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
import { isPromptTooLongError, seedBudgetChars } from "../daemon/providers/context-windows.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { CodeoidConfig } from "../config.js";
import type { AuthContext, DaemonMessage, SessionMessage } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:seed-overflow",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-so",
  projectId: "proj-so",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-seed-overflow-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const textTurn = (text: string): ProviderEvent[] => [
  { type: "text_done", content: text },
  { type: "turn_done", result: mockResult() },
];

/** What the Claude CLI emits when the request exceeds the window. */
const overflowTurn = (): ProviderEvent[] => [
  { type: "text_done", content: "Prompt is too long · the request is ~1091272 tokens (limit 1000000)" },
  { type: "turn_done", result: mockResult({ isError: true, errorMessage: "Turn ended with an error" }) },
];

/** mock-a → mock-b, where mock-b reports a stashed transcript seed like a warm backend. */
function makeRegistry(b: ProviderEvent[][]) {
  const created: MockSessionProvider[] = [];
  const registry = new ProviderRegistry("mock-a");
  registry.register({
    id: "mock-a",
    displayName: "mock-a",
    create: () => new MockSessionProvider("mock-a", [textTurn("from A")]),
  });
  registry.register({
    id: "mock-b",
    displayName: "mock-b",
    create: () => {
      const p = new MockSessionProvider("mock-b", b.map((t) => [...t]));
      p.seedResultOverride = { text: "<conversation-history/>", totalTurns: 2, keptTurns: 2, omittedTurns: 0, newestTurnSliced: false };
      created.push(p);
      return p;
    },
  });
  return { registry, created };
}

function makeSession(registry: ProviderRegistry, config?: CodeoidConfig): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name: "seed-overflow",
    workdir: tmp,
    status: "idle",
    createdBy: AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: AUTH.accountId!,
    projectId: AUTH.projectId!,
  });
  return new Session({
    name: "seed-overflow",
    workdir: tmp,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: id,
    providers: registry,
    providerId: "mock-a",
    ...(config ? { config } : {}),
  });
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

const messages = (c: { received: DaemonMessage[] }) =>
  c.received.filter((m): m is SessionMessage => m.type === "session.message");

/** Start on mock-a, then switch to mock-b so its first turn carries a seed. */
async function switchedSession(b: ProviderEvent[][], config?: CodeoidConfig) {
  const { registry, created } = makeRegistry(b);
  const session = makeSession(registry, config);
  const client = recordingClient();
  session.attach(client);
  await session.send("hello", AUTH);
  await waitFor(() => session.status === "idle" && session.lastAssistantText === "from A");
  await session.switchProvider("mock-b", AUTH);
  return { session, client, provider: created[0]! };
}

describe("isPromptTooLongError", () => {
  it("matches the CLI's and the API's wording, nothing else", () => {
    expect(isPromptTooLongError("Prompt is too long")).toBe(true);
    expect(isPromptTooLongError("prompt is too long: 1091272 tokens > 1000000 maximum")).toBe(true);
    expect(isPromptTooLongError("Turn ended with an error")).toBe(false);
    expect(isPromptTooLongError(undefined)).toBe(false);
  });
});

describe("a seeded first turn that overflows the window", () => {
  it("O1: retries on a fresh backing session with a halved seed, without re-posting the message", async () => {
    const { session, client, provider } = await switchedSession([overflowTurn(), overflowTurn(), textTurn("fits now")]);
    const firstBudget = provider.seededMaxChars!;
    const firstBacking = provider.backingSessionId;

    await session.send("continue", AUTH);
    await waitFor(() => session.status === "idle" && session.lastAssistantText === "fits now");

    // Same prompt three times; the seed halved twice.
    expect(provider.capturedOpts.map((o) => o.userMessage)).toEqual(["continue", "continue", "continue"]);
    expect(provider.seededMaxChars).toBe(Math.floor(Math.floor(firstBudget / 2) / 2));
    // The failed backing session holds the oversized prompt — never resume it.
    expect(provider.backingSessionId).not.toBe(firstBacking);

    const msgs = messages(client);
    expect(msgs.filter((m) => m.role === "user" && m.content === "continue")).toHaveLength(1);
    expect(msgs.filter((m) => m.metadata?.event === "history.seed_overflow")).toHaveLength(2);
    expect(msgs.some((m) => m.metadata?.event === "agent_error")).toBe(false);

    // The failed attempts are gone from the canonical history.
    expect(session.canonicalHistory.filter((t) => t.role === "user" && t.content === "continue")).toHaveLength(1);
    expect(session.canonicalHistory.some((t) => isPromptTooLongError(t.content))).toBe(false);
  });

  it("O2: surfaces the overflow with a /rotate hint once the retries run out", async () => {
    const { session, client, provider } = await switchedSession([overflowTurn(), overflowTurn(), overflowTurn(), overflowTurn()]);
    await session.send("continue", AUTH);
    await waitFor(() => session.status === "error");

    expect(provider.capturedOpts).toHaveLength(4);
    const err = messages(client).find((m) => m.metadata?.event === "agent_error");
    expect(err?.content).toContain("/rotate");
  });
});

describe("/rotate after an overflow", () => {
  it("O3: is allowed before the min-turns guard would normally permit it", async () => {
    const { session, client } = await switchedSession([overflowTurn(), overflowTurn(), overflowTurn(), overflowTurn()]);
    await session.send("continue", AUTH);
    await waitFor(() => session.status === "error");

    expect(await session.manualRotate(AUTH)).toBe(true);
    expect(messages(client).some((m) => m.metadata?.event === "rotation.rejected")).toBe(false);
  });

  it("survives a daemon restart: a restored session whose last reply was the overflow can rotate", async () => {
    const { registry } = makeRegistry([]);
    const session = makeSession(registry);
    const row = (role: string, content: string) =>
      ({ type: "session.message", sessionId: session.id, messageId: randomUUID(), role, content, timestamp: new Date().toISOString() }) as unknown as DaemonMessage;
    session.restoreScrollback([row("user", "please investigate"), row("assistant", "Prompt is too long")]);
    expect(await session.manualRotate(AUTH)).toBe(true);
  });

  it("is still refused on a healthy young session", async () => {
    const { registry } = makeRegistry([]);
    const session = makeSession(registry);
    await session.send("hello", AUTH);
    await waitFor(() => session.status === "idle" && session.lastAssistantText === "from A");
    expect(await session.manualRotate(AUTH)).toBe(false);
  });
});

describe("an overflow with no seed in play", () => {
  it("O4: is not retried", async () => {
    const registry = new ProviderRegistry("mock-a");
    const provider = new MockSessionProvider("mock-a", [overflowTurn(), textTurn("unused")]);
    registry.register({ id: "mock-a", displayName: "mock-a", create: () => provider });
    const session = makeSession(registry);
    const client = recordingClient();
    session.attach(client);

    await session.send("hello", AUTH);
    await waitFor(() => session.status === "error");
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(provider.capturedOpts).toHaveLength(1);
    expect(messages(client).find((m) => m.metadata?.event === "agent_error")?.content).toContain("/rotate");
  });
});

const NO_ROTATE = { enabled: false, rotatePct: 0.9, hardRotatePct: 0.97, minTurnsBeforeRotate: 5 };

describe("seed sizing config", () => {
  it("O5: session.seedBudgetChars caps the seed", async () => {
    const config = { session: { seedBudgetChars: 1234 }, autoRotate: NO_ROTATE } as unknown as CodeoidConfig;
    const { provider } = await switchedSession([textTurn("ok")], config);
    expect(provider.seededMaxChars).toBe(1234);
  });

  it("O5: session.seedCharsPerToken / seedWindowFraction size it against the window", async () => {
    const config = { session: { seedCharsPerToken: 1, seedWindowFraction: 0.5 }, autoRotate: NO_ROTATE } as unknown as CodeoidConfig;
    const { provider } = await switchedSession([textTurn("ok")], config);
    expect(provider.seededMaxChars).toBe(seedBudgetChars("mock-b", null, undefined, { charsPerToken: 1, windowFraction: 0.5 }));
    expect(provider.seededMaxChars).toBeLessThan(seedBudgetChars("mock-b", null));
  });
});
