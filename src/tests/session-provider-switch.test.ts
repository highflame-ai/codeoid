/**
 * Mid-session provider switching (`session.set_provider`) — Session-level
 * tests over a two-backend mock registry, plus manager wire coverage.
 *
 *   S1  Happy path: old provider torn down, new one built from the registry,
 *       canonical history seeded, backing id + model reset, info message +
 *       metadata broadcast, subsequent turns run on the new provider.
 *   S2  Unknown id fails closed; the session keeps its provider.
 *   S3  Same-id switch is an ack-only no-op (no teardown).
 *   S4  Mid-turn switches are rejected (pending approval blocks it).
 *   S5  A throwing seedFromHistory degrades to an unseeded switch.
 *   M1  Manager verb: scope + ownership + wire shapes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { AuthContext, DaemonMessage, SessionMessage } from "../protocol/types.js";
import { ALL_SCOPES, SCOPES, type Scope } from "../protocol/scopes.js";
import { MemoryEngine } from "@highflame/codeoid-memory/engine.js";
import { SqliteEpisodeStore } from "@highflame/codeoid-memory/store.js";
import type { Embedder } from "@highflame/codeoid-memory/embedder.js";

/** Minimal embedder so a MemoryEngine can be constructed for the VWS test. */
class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions));
  }
  async close(): Promise<void> {}
}

const AUTH: AuthContext = {
  sub: "user:switch-test",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-sw",
  projectId: "proj-sw",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  // These tests use gemini/openai as generic non-claude backends; the API
  // backends now register only with their key present. Fake keys are fine —
  // the StatelessSessionProvider doesn't call the API at construction.
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.GOOGLE_API_KEY = "gk-test";
  tmp = mkdtempSync(join(tmpdir(), "codeoid-switch-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 100));
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const textTurn = (text: string): ProviderEvent[] => [
  { type: "text_done", content: text },
  { type: "turn_done", result: mockResult() },
];

/** Two-backend registry; instances are captured so tests can inspect them. */
function makeRegistry(scripts: { a?: ProviderEvent[][]; b?: ProviderEvent[][] } = {}) {
  const created: Record<string, MockSessionProvider[]> = { "mock-a": [], "mock-b": [] };
  const registry = new ProviderRegistry("mock-a");
  for (const id of ["mock-a", "mock-b"] as const) {
    registry.register({
      id,
      displayName: id,
      create: () => {
        const provider = new MockSessionProvider(
          id,
          (id === "mock-a" ? scripts.a : scripts.b)?.map((s) => [...s]) ?? [],
        );
        created[id]!.push(provider);
        return provider;
      },
    });
  }
  return { registry, created };
}

function makeSession(registry: ProviderRegistry, providerId = "mock-a", memory?: MemoryEngine): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name: "switch-test",
    workdir: tmp,
    status: "idle",
    createdBy: AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: AUTH.accountId!,
    projectId: AUTH.projectId!,
  });
  return new Session({
    name: "switch-test",
    workdir: tmp,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: id,
    providers: registry,
    providerId,
    ...(memory ? { memory } : {}),
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

describe("Session.switchProvider", () => {
  it("S1: tears down, rebuilds, seeds, resets backing id + model, broadcasts", async () => {
    const { registry, created } = makeRegistry({
      a: [textTurn("from A")],
      b: [textTurn("from B")],
    });
    const session = makeSession(registry);
    const client = recordingClient();
    session.attach(client);
    expect(session.providerId).toBe("mock-a");

    // One real turn so there's history to seed.
    await session.send("hello a", AUTH);
    await waitFor(() => session.status === "idle" && session.lastAssistantText === "from A");

    const oldBacking = store.getClaudeCodeSessionId(session.id);
    const result = await session.switchProvider("mock-b", AUTH);
    expect(result).toEqual({ ok: true, providerId: "mock-b" });

    // Old torn down; new built by the registry.
    expect(created["mock-a"]![0]!.teardownCount).toBeGreaterThanOrEqual(1);
    expect(created["mock-b"]).toHaveLength(1);
    expect(session.providerId).toBe("mock-b");

    // History reached the incoming provider (user + assistant turns).
    const seeded = created["mock-b"]![0]!.seededHistory;
    expect(seeded).not.toBeNull();
    expect(seeded!.some((t) => t.role === "user" && t.content === "hello a")).toBe(true);
    expect(seeded!.some((t) => t.role === "assistant" && t.content === "from A")).toBe(true);

    // Backing id was re-minted; model reset to the new provider's default.
    expect(store.getClaudeCodeSessionId(session.id)).not.toBe(oldBacking);
    expect(session.model).toBeNull();

    // The switch is visible: info message with structured metadata.
    const info = client.received.find(
      (m): m is SessionMessage =>
        m.type === "session.message" &&
        m.role === "info" &&
        m.metadata?.event === "provider.switched",
    );
    expect(info).toBeDefined();
    expect(info!.metadata?.from).toBe("mock-a");
    expect(info!.metadata?.to).toBe("mock-b");
    expect(info!.metadata?.seeded).toBe(true);

    // The next turn runs on the NEW provider.
    await session.send("hello b", AUTH);
    await waitFor(() => session.lastAssistantText === "from B");
    expect(created["mock-b"]![0]!.capturedOpts).toHaveLength(1);

    await session.destroy(AUTH);
  });

  it("S9: VWS seeds a compact session map (not a transcript) when the incoming backend has the tools", async () => {
    const prev = process.env.CODEOID_CONTEXT_STRATEGY;
    process.env.CODEOID_CONTEXT_STRATEGY = "vws";
    try {
      const memory = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
      await memory.init();

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
          const p = new MockSessionProvider("mock-b", [textTurn("from B")]);
          p.supportsMemoryTools = true; // backend has the recall tools mounted
          created.push(p);
          return p;
        },
      });

      const session = makeSession(registry, "mock-a", memory);
      session.attach(recordingClient());
      await session.send("hello a", AUTH); // populate history to seed from
      await waitFor(() => session.status === "idle" && session.lastAssistantText === "from A");

      const res = await session.switchProvider("mock-b", AUTH);
      expect(res).toEqual({ ok: true, providerId: "mock-b" });

      const b = created[0]!;
      // VWS path: a compact session map via seedText, NOT a rendered transcript.
      expect(b.seededText).toHaveLength(1);
      expect(b.seededText[0]!).toContain("<session_map>");
      expect(b.seededText[0]!).toContain("hello a"); // last user turn, verbatim
      expect(b.seededHistory).toBeNull(); // transcript path was not taken

      await session.destroy(AUTH);
    } finally {
      if (prev === undefined) delete process.env.CODEOID_CONTEXT_STRATEGY;
      else process.env.CODEOID_CONTEXT_STRATEGY = prev;
    }
  });

  it("S8: surfaces a visible warning when the seed is truncated for the target window", async () => {
    // The incoming backend reports a truncated seed (older turns didn't fit
    // its context window); the session must tell the user in scrollback.
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
        const p = new MockSessionProvider("mock-b", [textTurn("from B")]);
        p.seedResultOverride = {
          text: "<conversation-history>…</conversation-history>",
          totalTurns: 40,
          keptTurns: 12,
          omittedTurns: 28,
          newestTurnSliced: false,
        };
        created.push(p);
        return p;
      },
    });
    const session = makeSession(registry, "mock-a");
    const client = recordingClient();
    session.attach(client);
    await session.send("hello", AUTH);
    await waitFor(() => session.status === "idle" && session.lastAssistantText === "from A");

    await session.switchProvider("mock-b", AUTH);

    // The incoming provider got a window-sized budget (not the old fixed 24k).
    expect(created[0]!.seededMaxChars).toBeGreaterThan(0);

    const warn = client.received.find(
      (m): m is SessionMessage =>
        m.type === "session.message" &&
        m.role === "info" &&
        m.metadata?.event === "history.truncated",
    );
    expect(warn).toBeDefined();
    expect(warn!.metadata?.provider).toBe("mock-b");
    expect(warn!.metadata?.totalTurns).toBe(40);
    expect(warn!.metadata?.keptTurns).toBe(12);
    expect(warn!.metadata?.omittedTurns).toBe(28);

    await session.destroy(AUTH);
  });

  it("S9: no truncation warning when the whole history fits", async () => {
    // Default mock seed (no override) reports omittedTurns=0 → silence.
    const { registry } = makeRegistry({ a: [textTurn("from A")], b: [textTurn("from B")] });
    const session = makeSession(registry);
    const client = recordingClient();
    session.attach(client);
    await session.send("hello", AUTH);
    await waitFor(() => session.status === "idle" && session.lastAssistantText === "from A");
    await session.switchProvider("mock-b", AUTH);
    const warn = client.received.find(
      (m) => m.type === "session.message" && (m as SessionMessage).metadata?.event === "history.truncated",
    );
    expect(warn).toBeUndefined();
    await session.destroy(AUTH);
  });

  it("S2: unknown provider fails closed and keeps the current backend", async () => {
    const { registry, created } = makeRegistry();
    const session = makeSession(registry);
    const result = await session.switchProvider("harness-from-the-future", AUTH);
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    if (!result.ok) expect(result.error).toContain("mock-a");
    expect(session.providerId).toBe("mock-a");
    expect(created["mock-a"]![0]!.teardownCount).toBe(0);
    await session.destroy(AUTH);
  });

  it("S2b: supported-but-unavailable provider fails with the install hint", async () => {
    const { registry } = makeRegistry();
    registry.markUnavailable("pi", "no pi binary found — install it");
    const session = makeSession(registry);
    const result = await session.switchProvider("pi", AUTH);
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    if (!result.ok) {
      expect(result.error).toContain("supported but not available");
      expect(result.error).toContain("no pi binary found");
    }
    expect(session.providerId).toBe("mock-a");
    await session.destroy(AUTH);
  });

  it("S3: same-id switch is a no-op ack", async () => {
    const { registry, created } = makeRegistry();
    const session = makeSession(registry);
    const result = await session.switchProvider("mock-a", AUTH);
    expect(result).toEqual({ ok: true, providerId: "mock-a" });
    expect(created["mock-a"]).toHaveLength(1); // no rebuild
    expect(created["mock-a"]![0]!.teardownCount).toBe(0);
    await session.destroy(AUTH);
  });

  it("S4: rejected while an approval is pending", async () => {
    const { registry } = makeRegistry({
      a: [
        [
          {
            type: "tool_start",
            toolId: "t1",
            sdkToolUseId: "sdk-t1",
            name: "custom_tool",
            input: {},
            approvalId: "ap-1",
          },
          { type: "tool_complete", sdkToolUseId: "sdk-t1", output: "ok", success: true },
          { type: "turn_done", result: mockResult() },
        ],
      ],
    });
    const session = makeSession(registry);
    session.setMode("interactive", undefined, AUTH);

    const sent = session.send("go", AUTH);
    await waitFor(() => session.status === "waiting_approval");

    const result = await session.switchProvider("mock-b", AUTH);
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    if (!result.ok) expect(result.error).toContain("mid-turn");

    session.approve("ap-1", true, AUTH);
    await sent;
    await waitFor(() => session.status === "idle");
    await session.destroy(AUTH);
  });

  it("S6: a send racing the switch on the chain wins — the switch is rejected, not the turn aborted", async () => {
    // A stalling provider: the turn starts and never completes, exactly the
    // state #sendInner leaves behind when it returns mid-stream.
    const created: MockSessionProvider[] = [];
    const registry = new ProviderRegistry("mock-a");
    registry.register({
      id: "mock-a",
      displayName: "mock-a",
      create: () => {
        const provider = new MockSessionProvider(
          "mock-a",
          [[{ type: "text_delta", content: "streaming…" }]],
          { stall: true },
        );
        created.push(provider);
        return provider;
      },
    });
    registry.register({ id: "mock-b", displayName: "mock-b", create: () => new MockSessionProvider("mock-b") });
    const session = makeSession(registry);

    // Fire the send and the switch back-to-back WITHOUT awaiting the send:
    // the switch's pre-check sees an idle session (the race), but its
    // chain-serialized inner guard must see the running turn and reject.
    const sendPromise = session.send("go", AUTH);
    const result = await session.switchProvider("mock-b", AUTH);
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    if (!result.ok) expect(result.error).toContain("mid-turn");
    expect(session.providerId).toBe("mock-a");
    expect(created[0]!.teardownCount).toBe(0);

    await sendPromise;
    await session.interrupt(AUTH);
    await session.destroy(AUTH);
  });

  it("S7: switching clears a pending rotation seed (no stacked Claude-worded anchor)", async () => {
    const { registry, created } = makeRegistry({
      a: [textTurn("a1"), textTurn("a2"), textTurn("a3")],
      b: [textTurn("from B")],
    });
    const session = makeSession(registry);
    // Rotation requires min 3 turns before it arms.
    for (const prompt of ["one", "two", "three"]) {
      await session.send(prompt, AUTH);
      await waitFor(() => session.status === "idle");
    }

    // Manual rotation arms the next-send rotation seed (Claude-worded).
    const rotated = await session.manualRotate(AUTH);
    expect(rotated).toBe(true);
    const result = await session.switchProvider("mock-b", AUTH);
    expect(result).toEqual({ ok: true, providerId: "mock-b" });

    // The next send must NOT carry the rotation anchor — only the switch's
    // own transcript seed reached the provider (via seedFromHistory), so
    // the prompt itself is the raw user text.
    await session.send("hello b", AUTH);
    await waitFor(() => created["mock-b"]![0]!.capturedOpts.length === 1);
    const prompt = created["mock-b"]![0]!.capturedOpts[0]!.userMessage;
    expect(prompt).not.toContain("rotated");
    expect(prompt).toContain("hello b");

    await session.destroy(AUTH);
  });

  it("S5: a throwing seedFromHistory degrades to an unseeded switch", async () => {
    const { registry, created } = makeRegistry({ a: [textTurn("from A")] });
    // Poison every FUTURE mock-b instance via a wrapping factory.
    const poisoned = new ProviderRegistry("mock-a");
    poisoned.register(registry.get("mock-a")!);
    poisoned.register({
      id: "mock-b",
      displayName: "mock-b",
      create: () => {
        const provider = new MockSessionProvider("mock-b");
        provider.seedFromHistoryError = new Error("seed exploded");
        created["mock-b"]!.push(provider);
        return provider;
      },
    });
    const session = makeSession(poisoned);
    const client = recordingClient();
    session.attach(client);
    await session.send("hello a", AUTH);
    await waitFor(() => session.status === "idle");

    const result = await session.switchProvider("mock-b", AUTH);
    expect(result).toEqual({ ok: true, providerId: "mock-b" });
    const info = client.received.find(
      (m): m is SessionMessage =>
        m.type === "session.message" && m.metadata?.event === "provider.switched",
    );
    expect(info!.metadata?.seeded).toBe(false);
    await session.destroy(AUTH);
  });
});

describe("session.set_provider via SessionManager", () => {
  function scoped(scopes: Scope[]): AuthContext {
    return { ...AUTH, scopes };
  }
  const client = (auth: AuthContext): AttachedClient => ({
    id: `client-${auth.sub}`,
    auth,
    send: () => {},
  });

  it("M1: enforces scope, ownership, and returns the new provider id", async () => {
    const manager = new SessionManager(store, transcriptStore, undefined, undefined, undefined, {
      _testProviderFactory: () => new MockSessionProvider("mock"),
    });
    const createResp = await manager.handle(
      { type: "session.create", id: "c1", name: "sw", workdir: tmp },
      AUTH,
      client(AUTH),
    );
    const sessionId = (createResp as { data: { id: string } }).data.id;

    const noScope = scoped([SCOPES.SESSION_LIST]);
    const denied = await manager.handle(
      { type: "session.set_provider", id: "p1", sessionId, providerId: "pi" },
      noScope,
      client(noScope),
    );
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });

    const missing = await manager.handle(
      { type: "session.set_provider", id: "p2", sessionId: "nope", providerId: "pi" },
      AUTH,
      client(AUTH),
    );
    expect(missing).toMatchObject({ type: "response.error", code: "not_found" });

    const unknown = await manager.handle(
      { type: "session.set_provider", id: "p3", sessionId, providerId: "zeta" },
      AUTH,
      client(AUTH),
    );
    expect(unknown).toMatchObject({ type: "response.error", code: "invalid_request" });

    const ok = await manager.handle(
      { type: "session.set_provider", id: "p4", sessionId, providerId: "gemini" },
      AUTH,
      client(AUTH),
    );
    expect(ok).toMatchObject({ type: "response.ok", data: { providerId: "gemini" } });
  });
});
