/**
 * Session integration tests — provider-injection harness.
 *
 * These tests exercise Session's internal logic end-to-end (send → event
 * consumer → scrollback → broadcast) without spawning the Claude Agent SDK.
 * MockSessionProvider supplies scripted ProviderEvent sequences so the tests
 * run offline in CI and complete in milliseconds.
 *
 * MockSessionProvider simulates the SDK's PreToolUse hook by calling
 * opts.canUseTool for each tool_start event it emits — this is what drives
 * the autonomous budget decrement and manual approval paths.
 *
 * Coverage:
 *
 *   T1  Async event ordering — text_delta sequences accumulate in order;
 *       tool_start + tool_complete produces a completed tool message.
 *
 *   T2  Autonomous single-decrement — a non-safe tool call decrements
 *       turnsRemaining exactly once (not twice — double-decrement regression).
 *
 *   T3  Map cleanup on interrupt — after interrupt(), subsequent turns work
 *       correctly (stale entries in #toolCallMessages, #toolUseIdToMessageId,
 *       #messageIdToToolUseId would corrupt tool output).
 *
 *   T4  Recovery path — onRecoveryNeeded fires → session calls resetToNewSession
 *       and issues a second runTurn(); the session reaches idle.
 *
 *   T5  Session resume after restart — restoreScrollback replays to newly
 *       attached clients; subsequent send() using MockSessionProvider works.
 *
 *   T6  ZeroID fence timeout — when AgentIdentityManager.registerSubagent hangs
 *       indefinitely, tool_start completes within ~6 s (fence times out at 5 s).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { mockResult } from "../daemon/providers/mock/index.js";
import { AsyncQueue } from "../daemon/async-queue.js";
import type { DaemonMessage, AuthContext } from "../protocol/types.js";
import type { ProviderEvent, TurnRun } from "../daemon/providers/interface.js";
import type { CodeoidConfig } from "../config.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_AUTH: AuthContext = {
  sub: "user:test-integration",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc-integ",
  projectId: "proj-integ",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-integ-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  // Yield to the macrotask queue so fire-and-forget async operations from the
  // previous test (consumer finally block → store.updateSessionStatus,
  // TranscriptStore.saveMeta atomic rename) can complete before we close the
  // store and delete the tmp directory.  Without this, the next test's setup
  // races with the previous test's in-flight I/O, producing spurious
  // "Cannot use a closed database" and ENOENT errors.
  await new Promise<void>((r) => setTimeout(r, 100));
  // The sleep alone is a heuristic — under CI load a pending saveMeta
  // temp+rename can outlive it and ENOENT after rmSync, failing whichever
  // test happens to be running. Drain the write chains deterministically.
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a Session wired with the given MockSessionProvider.
 * Uses existingId so the constructor skips the async saveMeta call,
 * eliminating ENOENT races with afterEach's rmSync.
 */
function makeSession(
  provider: MockSessionProvider,
  name = "integ-test",
  config?: CodeoidConfig,
): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name,
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId!,
    projectId: TEST_AUTH.projectId!,
  });
  return new Session({
    name,
    workdir: tmp,
    auth: TEST_AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: provider,
    config,
  });
}

/** Minimal config whose only meaningful field is a tiny stall timeout, so the
 *  watchdog fires in milliseconds instead of the 300s default. autoRotate is
 *  included (disabled) because #shouldRotate dereferences it on every send. */
function stallConfig(turnStallTimeoutMs: number): CodeoidConfig {
  return {
    session: { turnStallTimeoutMs },
    autoRotate: {
      enabled: false,
      warnPct: 0.75,
      rotatePct: 0.9,
      hardRotatePct: 0.95,
      minTurnsBeforeRotate: 1,
      strategy: "task-anchor",
    },
  } as unknown as CodeoidConfig;
}

/** Build a stub AttachedClient that records every DaemonMessage it receives. */
function makeClient(id = randomUUID()): { client: AttachedClient; received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return {
    client: { id, auth: TEST_AUTH, send: (msg) => received.push(msg) },
    received,
  };
}

/**
 * Resolve when the session broadcasts session.status_change with status "idle"
 * or "error". Checks current status first so we don't miss an already-idle
 * session. Rejects after `timeoutMs` to prevent hung tests.
 *
 * IMPORTANT: Call `await session.send(...)` first (not `void session.send(...)`)
 * so that the session is in "thinking" state before this is called. Otherwise
 * the idle check fires immediately on a session that hasn't started yet.
 */
function waitForIdle(session: Session, timeoutMs = 8000): Promise<void> {
  if (session.status === "idle" || session.status === "error") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcherId = randomUUID();
    const timer = setTimeout(() => {
      session.detach(watcherId);
      reject(new Error(`session did not reach idle within ${timeoutMs}ms — status=${session.status}`));
    }, timeoutMs);
    const watcher: AttachedClient = {
      id: watcherId,
      auth: TEST_AUTH,
      send(msg) {
        if (msg.type === "session.status_change" &&
            (msg.status === "idle" || msg.status === "error")) {
          clearTimeout(timer);
          session.detach(watcherId);
          resolve();
        }
      },
    };
    session.attach(watcher);
  });
}

/**
 * Resolve when the session broadcasts a session.status_change with the given
 * status. Checks the current status first. Rejects after timeoutMs.
 */
function waitForStatus(session: Session, targetStatus: string, timeoutMs = 4000): Promise<void> {
  if (session.status === targetStatus) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcherId = randomUUID();
    const timer = setTimeout(() => {
      session.detach(watcherId);
      reject(new Error(`session did not reach '${targetStatus}' within ${timeoutMs}ms — status=${session.status}`));
    }, timeoutMs);
    const watcher: AttachedClient = {
      id: watcherId,
      auth: TEST_AUTH,
      send(msg) {
        if (msg.type === "session.status_change" && msg.status === targetStatus) {
          clearTimeout(timer);
          session.detach(watcherId);
          resolve();
        }
      },
    };
    session.attach(watcher);
    // Re-check after attaching: if the status flipped to the target in the
    // window between the initial check and attach(), we'd otherwise miss the
    // only broadcast and time out.
    if (session.status === targetStatus) {
      clearTimeout(timer);
      session.detach(watcherId);
      resolve();
    }
  });
}

// ── T1: Async event ordering ──────────────────────────────────────────────────

describe("T1 – async event ordering", () => {
  it("accumulates 50 text_delta events in order; final assistant message has full content", async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `chunk${i} `);
    const finalText = chunks.join("");
    const deltas: ProviderEvent[] = chunks.map((c) => ({ type: "text_delta" as const, content: c }));

    const provider = new MockSessionProvider("claude", [
      [
        ...deltas,
        { type: "text_done", content: finalText },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    // await (not void) so session is in "thinking" state when waitForIdle starts.
    await session.send("count to 50", TEST_AUTH);
    await waitForIdle(session);

    // text_done re-broadcasts the assistant message with the full content.
    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "assistant",
    );
    const lastMsg = assistantMsgs.at(-1);
    expect(lastMsg).toBeDefined();
    if (lastMsg?.type === "session.message") {
      expect(lastMsg.content).toBe(finalText);
    }
  });

  it("Read tool (safe) — tool_start + tool_complete produces a completed tool_call message", async () => {
    const toolUseId = "sdk-read-1";
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "t1",
          sdkToolUseId: toolUseId,
          name: "Read",
          input: { file_path: "/tmp/foo.ts" },
          approvalId: "approval-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "export const x = 1;",
          success: true,
        },
        { type: "text_done", content: "I read the file." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("read foo.ts", TEST_AUTH);
    await waitForIdle(session);

    // tool_start produces a session.message with role "tool_call".
    const toolMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "tool_call",
    );
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);

    // After tool_complete the state should be "completed" — broadcast via session.message.delta.
    const completedDeltas = received.filter(
      (m) => m.type === "session.message.delta" && m.toolStateUpdate?.phase === "completed",
    );
    expect(completedDeltas.length).toBeGreaterThanOrEqual(1);
  });
});

// ── T2: Autonomous single-decrement ───────────────────────────────────────────

describe("T2 – autonomous mode single-decrement", () => {
  it("a non-safe tool (Bash) decrements turnsRemaining exactly once", async () => {
    const toolUseId = "sdk-bash-1";
    // Bash is a mutation tool — not in the safe-tool set (Read/Grep/Glob).
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "bash-t1",
          sdkToolUseId: toolUseId,
          name: "Bash",
          input: { command: "ls /tmp" },
          approvalId: "ap-bash-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "file1\nfile2",
          success: true,
        },
        { type: "text_done", content: "Listed." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);

    session.setMode("autonomous", 3);
    expect(session.turnsRemaining).toBe(3);

    await session.send("list tmp", TEST_AUTH);
    await waitForIdle(session);

    // canUseTool calls #shouldAutoApprove which decrements once.
    // tool_start handler uses #peekAutoApprove (no side effect) — not a second decrement.
    expect(session.turnsRemaining).toBe(2);
  });

  it("budget=1: after one non-safe tool, turnsRemaining is 0 (exhausted, not negative)", async () => {
    const toolUseId = "sdk-edit-1";
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "edit-t1",
          sdkToolUseId: toolUseId,
          name: "Edit",
          input: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
          approvalId: "ap-edit-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "ok",
          success: true,
        },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    session.setMode("autonomous", 1);

    await session.send("edit x.ts", TEST_AUTH);
    await waitForIdle(session);

    // Single-decrement: budget=1 → 0 after one tool (not -1 from a double-decrement).
    expect(session.turnsRemaining).toBe(0);
    // Mode stays autonomous until the NEXT tool call finds turnsRemaining=0 and flips it.
    expect(session.mode).toBe("autonomous");
  });
});

// ── T3: Map cleanup on interrupt ──────────────────────────────────────────────

describe("T3 – map cleanup after interrupt", () => {
  it("a second turn works correctly after interrupting the first mid-tool", async () => {
    const toolUseId = "sdk-stuck-1";

    // Turn 1: Bash tool (manual approval required in guarded mode) with no tool_complete.
    // MockSessionProvider calls canUseTool → waits for approval → interrupt fires.
    // Turn 2: clean simple turn (emitted after interrupt resolves).
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "stuck-t1",
          sdkToolUseId: toolUseId,
          name: "Bash",
          input: { command: "sleep 60" },
          approvalId: "ap-stuck-1",
        },
        // No tool_complete — interrupt resolves the pending canUseTool approval.
      ],
      [
        { type: "text_done", content: "Clean turn." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);

    // Kick off turn 1. MockSessionProvider emits tool_start, calls canUseTool,
    // and waits for approval (Bash is not auto-approved in guarded mode).
    await session.send("sleep forever", TEST_AUTH);

    // Let the event consumer process tool_start and canUseTool start waiting.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Interrupt resolves all pending approvals with {approved: false}.
    await session.interrupt(TEST_AUTH);
    await waitForIdle(session);

    // Turn 2: send again — if maps leaked, stale entries from turn 1 would
    // cause tool correlation mismatches. The clean turn should produce a
    // proper assistant message.
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("do something clean", TEST_AUTH);
    await waitForIdle(session);

    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "assistant",
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const last = assistantMsgs.at(-1);
    if (last?.type === "session.message") {
      expect(last.content).toBe("Clean turn.");
    }
  });
});

// ── T4: Recovery path ─────────────────────────────────────────────────────────

describe("T4 – onRecoveryNeeded recovery path", () => {
  it("recovery triggers a second runTurn and the session reaches idle", async () => {
    // Scripted events for the RECOVERY run (the second runTurn call).
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "Recovered." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);

    let callCount = 0;
    let recoveryTriggered = false;

    // Override runTurn: first call fires onRecoveryNeeded then returns an
    // immediately-closing queue; second call uses the scripted events above.
    const originalRunTurn = provider.runTurn.bind(provider);
    provider.runTurn = (opts): TurnRun => {
      callCount++;
      if (callCount === 1) {
        const queue = new AsyncQueue<ProviderEvent>();
        void Promise.resolve().then(() => {
          recoveryTriggered = true;
          // onRecoveryNeeded is wired by Session.#sendInner before calling runTurn.
          // Calling it here simulates the ClaudeProvider "No conversation found" error.
          provider.onRecoveryNeeded?.(opts.userMessage);
          try { queue.close(); } catch {}
        });
        return {
          events: queue,
          interrupt: async () => { try { queue.close(); } catch {} },
        };
      }
      return originalRunTurn(opts);
    };

    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("trigger recovery", TEST_AUTH);
    await waitForIdle(session, 10000);

    expect(recoveryTriggered).toBe(true);
    expect(callCount).toBe(2);

    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && m.role === "assistant",
    );
    const last = assistantMsgs.at(-1);
    if (last?.type === "session.message") {
      expect(last.content).toBe("Recovered.");
    }
  });

  // #233: a skill's blocked expansion-time command must PARK the turn, not fail
  // it. The session goes waiting_approval (so a driving pipeline phase — which
  // resolves only on idle/error — stays alive) and posts a visible cue, while
  // the turn stays open for the provider's in-place retry.
  it("approval_pending parks the turn as waiting_approval, not error", async () => {
    // stall:true leaves the queue OPEN after the scripted events — the turn is
    // parked awaiting approval, exactly as ClaudeProvider does.
    const provider = new MockSessionProvider(
      "claude",
      [[{ type: "approval_pending", command: "sh .aif/partials/ethos.sh" }]],
      { stall: true },
    );
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("/spec", TEST_AUTH);
    await waitForStatus(session, "waiting_approval", 10000);

    expect(session.status).toBe("waiting_approval"); // NOT error, NOT idle
    const note = received.find(
      (m) => m.type === "session.message" && m.role === "system" && m.content.includes("needs approval"),
    );
    expect(note).toBeDefined();
    if (note?.type === "session.message") {
      expect(note.content).toContain("sh .aif/partials/ethos.sh");
    }

    await session.interrupt(TEST_AUTH); // unblock the parked (stalled) consumer
  });
});

// ── T5: Session resume after restart ─────────────────────────────────────────

describe("T5 – session resume / scrollback replay", () => {
  it("restoreScrollback replays messages to a client that attaches later", () => {
    const provider = new MockSessionProvider("claude");
    const session = makeSession(provider);

    const messages: DaemonMessage[] = [
      {
        type: "session.message",
        sessionId: session.id,
        messageId: randomUUID(),
        role: "user",
        content: "Hello from before restart",
        identity: { sub: TEST_AUTH.sub, name: "User", type: "human" },
        timestamp: new Date().toISOString(),
      },
      {
        type: "session.message",
        sessionId: session.id,
        messageId: randomUUID(),
        role: "assistant",
        content: "I was already here.",
        identity: { sub: "agent:test", name: "Claude", type: "agent" },
        timestamp: new Date().toISOString(),
      },
    ];
    session.restoreScrollback(messages);

    const { client, received } = makeClient();
    session.attach(client);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("scrollback.replay");
    if (received[0]?.type === "scrollback.replay") {
      expect(received[0].messages).toHaveLength(2);
    }
  });

  it("send() after restoreScrollback works: new turn appends to scrollback", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "Post-restart reply." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);

    session.restoreScrollback([
      {
        type: "session.message",
        sessionId: session.id,
        messageId: randomUUID(),
        role: "user",
        content: "prior turn",
        identity: { sub: TEST_AUTH.sub, name: "User", type: "human" },
        timestamp: new Date().toISOString(),
      },
    ]);

    await session.send("follow-up after restart", TEST_AUTH);
    await waitForIdle(session);

    // Attach a fresh client — replay should include the restored message AND the new reply.
    const { client, received } = makeClient();
    session.attach(client);

    const replay = received.find((m) => m.type === "scrollback.replay");
    expect(replay).toBeDefined();
    if (replay?.type === "scrollback.replay") {
      const assistantMsg = replay.messages.find(
        (m) => m.type === "session.message" && m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
    }
  });
});

// ── T5b: chunked scrollback replay for large sessions (#84) ──────────────────

describe("T5b – chunked scrollback replay (#84)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const MB = 1024 * 1024;

  /** Three ~3MB messages so the 4MB replay-chunk budget yields one chunk each. */
  function restoreLargeScrollback(session: Session): string[] {
    const ids = ["big-0", "big-1", "big-2"];
    session.restoreScrollback(
      ids.map((id, i) => ({
        type: "session.message" as const,
        sessionId: session.id,
        messageId: id,
        role: "assistant" as const,
        content: "x".repeat(3 * MB) + i,
        identity: { sub: "agent:test", name: "Claude", type: "agent" as const },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      })),
    );
    return ids;
  }

  /** Client whose flush() is gated — the test releases each chunk explicitly. */
  function makePacedClient(id = randomUUID()) {
    const received: DaemonMessage[] = [];
    let resolveFlush: (() => void) | null = null;
    const client: AttachedClient = {
      id,
      auth: TEST_AUTH,
      send: (m) => received.push(m),
      flush: () => new Promise<void>((res) => { resolveFlush = res; }),
    };
    return {
      client,
      received,
      releaseFlush: () => { const r = resolveFlush; resolveFlush = null; r?.(); },
    };
  }

  const replayFrames = (received: DaemonMessage[]) =>
    received.filter((m) => m.type === "scrollback.replay") as Extract<
      DaemonMessage,
      { type: "scrollback.replay" }
    >[];

  it("splits a large scrollback into ordered seq'd frames covering every message", async () => {
    const session = makeSession(new MockSessionProvider("claude"));
    const ids = restoreLargeScrollback(session);

    // Auto-resolving flush so the whole replay streams to completion.
    const received: DaemonMessage[] = [];
    const client: AttachedClient = {
      id: randomUUID(),
      auth: TEST_AUTH,
      send: (m) => received.push(m),
      flush: () => Promise.resolve(),
    };
    session.attach(client);
    await tick();
    await tick();

    const frames = replayFrames(received);
    expect(frames).toHaveLength(3);
    frames.forEach((f, i) => {
      expect(f.seq).toBe(i);
      expect(f.final).toBe(i === frames.length - 1);
    });
    // Concatenating the chunks reproduces the full scrollback in order.
    expect(frames.flatMap((f) => f.messages.map((m) => m.messageId))).toEqual(ids);
  });

  it("paces chunks on flush and stops streaming if the client detaches mid-replay", async () => {
    const session = makeSession(new MockSessionProvider("claude"));
    restoreLargeScrollback(session);
    const { client, received, releaseFlush } = makePacedClient();

    session.attach(client);
    await tick();
    // Only the first chunk is out; the stream is parked awaiting drain.
    expect(replayFrames(received)).toHaveLength(1);
    expect(replayFrames(received)[0]!.seq).toBe(0);

    session.detach(client.id);
    releaseFlush();
    await tick();
    // Detach observed before the next send — no further chunks.
    expect(replayFrames(received)).toHaveLength(1);
  });

  it("buffers live broadcasts during a chunked replay so they arrive after it", async () => {
    const session = makeSession(new MockSessionProvider("claude"));
    restoreLargeScrollback(session);
    const { client, received, releaseFlush } = makePacedClient();

    session.attach(client);
    await tick();

    // A live broadcast lands mid-replay (chunk 0 sent, awaiting flush).
    session.rename("renamed-mid-replay", TEST_AUTH);
    await tick();
    // It must be buffered, not delivered ahead of the older replayed chunks.
    expect(received.some((m) => m.type === "session.info_update")).toBe(false);

    releaseFlush(); await tick(); // chunk 1
    releaseFlush(); await tick(); // chunk 2 (final) → replay done, buffer flushed

    const types = received.map((m) => m.type);
    const lastReplayIdx = types.lastIndexOf("scrollback.replay");
    const infoIdx = types.indexOf("session.info_update");
    expect(infoIdx).toBeGreaterThan(lastReplayIdx);
    expect(replayFrames(received)).toHaveLength(3);
  });
});

// ── T5c: incremental resume + send idempotency (replay.resume / send.idempotency)

describe("T5c – incremental resume & send idempotency", () => {
  type ReplayFrame = Extract<DaemonMessage, { type: "scrollback.replay" }>;
  const replays = (received: DaemonMessage[]) =>
    received.filter((m) => m.type === "scrollback.replay") as ReplayFrame[];

  function makeRestoredMsg(session: Session, id: string, content: string): DaemonMessage {
    return {
      type: "session.message",
      sessionId: session.id,
      messageId: id,
      role: "assistant",
      content,
      identity: { sub: "agent:test", name: "Claude", type: "agent" },
      timestamp: new Date().toISOString(),
    };
  }

  it("snapshot replay carries resume meta (mode, resumeKey, maxSeq)", () => {
    const session = makeSession(new MockSessionProvider("claude"));
    session.restoreScrollback([makeRestoredMsg(session, "m0", "hello")]);

    const { client, received } = makeClient();
    session.attach(client);

    const frames = replays(received);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.mode).toBe("snapshot");
    expect(typeof frames[0]!.resumeKey).toBe("string");
    expect(frames[0]!.maxSeq).toBeGreaterThanOrEqual(1);
  });

  it("matching-key resume replays only the tail; wrong key falls back to snapshot", () => {
    const session = makeSession(new MockSessionProvider("claude"));
    session.restoreScrollback([
      makeRestoredMsg(session, "m0", "old-0"),
      makeRestoredMsg(session, "m1", "old-1"),
    ]);

    // First attach: full snapshot; capture the cursor.
    const a = makeClient();
    session.attach(a.client);
    const snap = replays(a.received)[0]!;
    session.detach(a.client.id);

    // New activity after the cursor.
    session.restoreScrollback([makeRestoredMsg(session, "m2", "new-2")]);

    // Resume with the captured cursor → incremental, only m2.
    const b = makeClient();
    session.attach(b.client, { key: snap.resumeKey!, sinceSeq: snap.maxSeq! });
    const inc = replays(b.received)[0]!;
    expect(inc.mode).toBe("incremental");
    expect(inc.messages.map((m) => m.messageId)).toEqual(["m2"]);
    expect(inc.maxSeq!).toBeGreaterThan(snap.maxSeq!);

    // Wrong key → authoritative snapshot with everything.
    const c = makeClient();
    session.attach(c.client, { key: "not-this-buffer", sinceSeq: snap.maxSeq! });
    const full = replays(c.received)[0]!;
    expect(full.mode).toBe("snapshot");
    expect(full.messages.map((m) => m.messageId)).toEqual(["m0", "m1", "m2"]);
  });

  it("fully-caught-up resume gets an empty incremental ack (legacy attach stays silent)", () => {
    const session = makeSession(new MockSessionProvider("claude"));
    session.restoreScrollback([makeRestoredMsg(session, "m0", "only")]);

    const a = makeClient();
    session.attach(a.client);
    const snap = replays(a.received)[0]!;
    session.detach(a.client.id);

    // Caught-up resume → one empty incremental frame (cursor ack).
    const b = makeClient();
    session.attach(b.client, { key: snap.resumeKey!, sinceSeq: snap.maxSeq! });
    const ack = replays(b.received)[0]!;
    expect(ack.mode).toBe("incremental");
    expect(ack.messages).toHaveLength(0);
    expect(ack.maxSeq).toBe(snap.maxSeq!);

    // Legacy attach (no resume) on an EMPTY session sends no frame at all.
    const empty = makeSession(new MockSessionProvider("claude"));
    const c = makeClient();
    empty.attach(c.client);
    expect(replays(c.received)).toHaveLength(0);
  });

  it("a live streamed turn advances the cursor; resuming from the pre-turn cursor returns only the turn's messages", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_delta", content: "He" },
        { type: "text_delta", content: "llo" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    session.restoreScrollback([makeRestoredMsg(session, "m0", "pre-turn")]);

    const a = makeClient();
    session.attach(a.client);
    const preTurn = replays(a.received)[0]!;

    await session.send("hi there", TEST_AUTH);
    await waitForIdle(session);

    // Live frames carry the session cursor: streamed deltas are stamped via
    // scrollback.touch, new messages via scrollback.push.
    const deltas = a.received.filter((m) => m.type === "session.message.delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => typeof (d as { seq?: number }).seq === "number")).toBe(true);
    const liveMsgs = a.received.filter((m) => m.type === "session.message");
    expect(liveMsgs.some((m) => typeof (m as { seq?: number }).seq === "number")).toBe(true);
    session.detach(a.client.id);

    // Resume from the PRE-turn cursor: only the turn's messages, not m0.
    const b = makeClient();
    session.attach(b.client, { key: preTurn.resumeKey!, sinceSeq: preTurn.maxSeq! });
    const inc = replays(b.received)[0]!;
    expect(inc.mode).toBe("incremental");
    const ids = inc.messages.map((m) => m.messageId);
    expect(ids).not.toContain("m0");
    expect(inc.messages.some((m) => m.role === "user")).toBe(true);
    expect(inc.messages.some((m) => m.role === "assistant" && m.content === "Hello")).toBe(true);
  });

  it("markClientMsgSeen: first sight false, duplicate true, FIFO eviction past 256", () => {
    const session = makeSession(new MockSessionProvider("claude"));
    expect(session.markClientMsgSeen("k1")).toBe(false);
    expect(session.markClientMsgSeen("k1")).toBe(true);
    expect(session.markClientMsgSeen("k2")).toBe(false);

    // Evict k1 by inserting 256 more distinct ids (cap is 256).
    for (let i = 0; i < 256; i++) session.markClientMsgSeen(`fill-${i}`);
    expect(session.markClientMsgSeen("k1")).toBe(false); // forgotten → processes again
  });

  it("duplicate clientMsgId does not dispatch a second turn (manager guard semantics)", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "reply one" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
      [
        { type: "text_done", content: "reply two" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);

    // Mirrors SessionManager#send exactly: check-and-record, skip dispatch on
    // duplicate. Two "deliveries" of the same user action, one turn.
    // (Awaited so waitForIdle observes a session that actually started —
    // see the waitForIdle doc note.)
    const dispatch = async (text: string, clientMsgId: string): Promise<boolean> => {
      if (session.markClientMsgSeen(clientMsgId)) return false; // duplicate → ack only
      await session.send(text, TEST_AUTH);
      return true;
    };

    expect(await dispatch("do the thing", "action-1")).toBe(true);
    expect(await dispatch("do the thing", "action-1")).toBe(false);
    await waitForIdle(session);

    const { client, received } = makeClient();
    session.attach(client);
    expect(replays(received)).toHaveLength(1);
    const userMsgs = replays(received)[0]!.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
  });
});

// ── T6: ZeroID fence timeout ──────────────────────────────────────────────────

describe("T6 – ZeroID fence 5 s timeout", () => {
  it("tool_start completes within 6 s when registerSubagent hangs indefinitely", async () => {
    const subagentId = "subagent-hanging";
    const toolUseId = "sdk-hang-tool-1";

    // Identity manager whose registerSubagent never resolves.
    // registerSessionAgent works normally so #ensureAgentIdentity succeeds.
    const hangingIdentityManager = {
      registerSessionAgent: async (_sid: string, _name: string, _sub: string) => ({
        wimseUri: `wimse://test/${_sid}`,
      }),
      registerSubagent: (_sid: string, _agentId: string, _type: string) =>
        new Promise<never>(() => {}), // hangs forever
      deactivateSubagent: async () => {},
      deactivateSessionAgent: async () => {},
    };

    const provider = new MockSessionProvider("claude", [
      [
        // subagent_start installs the hanging fence.
        { type: "subagent_start", agentId: subagentId, agentType: "Task" },
        // tool_start for that subagent — Session must timeout the fence after 5 s.
        {
          type: "tool_start",
          toolId: "hang-t1",
          sdkToolUseId: toolUseId,
          sdkAgentId: subagentId,
          name: "Read",
          input: { file_path: "/tmp/x.ts" },
          approvalId: "ap-hang-1",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "content",
          success: true,
        },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);

    const id = randomUUID();
    store.createSession({
      id,
      name: "fence-test",
      workdir: tmp,
      status: "idle",
      createdBy: TEST_AUTH.sub,
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: TEST_AUTH.accountId!,
      projectId: TEST_AUTH.projectId!,
    });

    const session = new Session({
      name: "fence-test",
      workdir: tmp,
      auth: TEST_AUTH,
      store,
      transcriptStore,
      existingId: id,
      _testProvider: provider,
      // Cast to never — we only implement the subset Session calls.
      identityManager: hangingIdentityManager as never,
    });

    const start = Date.now();
    await session.send("trigger subagent with hanging ZeroID", TEST_AUTH);
    await waitForIdle(session, 15000);
    const elapsed = Date.now() - start;

    // Fence timeout fires at 5 s. Total time should be under 12 s including
    // overhead. The waitForIdle(15s) timeout guards against a true hang.
    expect(elapsed).toBeLessThan(12000);
    expect(session.status).toBe("idle");
  }, 15000);
});

// ── T7: MockSessionProvider direct API ───────────────────────────────────────
// Covers the mock's own helper methods so the file stays above the 80% patch
// coverage gate.  These also serve as sanity checks: if the mock's API drifts
// from SessionProvider's contract the integration tests would silently test
// the wrong thing.

describe("T7 – MockSessionProvider direct API", () => {
  it("listModels returns the mock model list", async () => {
    const provider = new MockSessionProvider("m");
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.id).toBeTruthy();
  });

  it("teardown increments teardownCount and clears onRecoveryNeeded", async () => {
    const provider = new MockSessionProvider("m");
    provider.onRecoveryNeeded = () => {};
    await provider.teardown();
    expect(provider.teardownCount).toBe(1);
    expect(provider.onRecoveryNeeded).toBeUndefined();
  });

  it("dispose delegates to teardown", async () => {
    const provider = new MockSessionProvider("m");
    await provider.dispose();
    expect(provider.teardownCount).toBe(1);
  });

  it("setHasQueried updates hasQueried", () => {
    const provider = new MockSessionProvider("m");
    expect(provider.hasQueried).toBe(false);
    provider.setHasQueried(true);
    expect(provider.hasQueried).toBe(true);
    provider.setHasQueried(false);
    expect(provider.hasQueried).toBe(false);
  });

  it("runTurn with empty script falls back to default turn_done", async () => {
    const provider = new MockSessionProvider("m");
    const session = makeSession(provider);
    await session.send("hello", TEST_AUTH);
    await waitForIdle(session);
    expect(session.status).toBe("idle");
  });
});

// ── T8: Regression – text overlap + stale status ─────────────────────────────
// Guards the two regressions introduced by the multi-provider PR:
//
//  (a) Terminal text overlap: session.message.delta events and the committed
//      session.message from text_done must share the same messageId so the
//      terminal client can suppress re-printing content already streamed.
//
//  (b) Stale amber status: session.toInfo() must reflect the live status at
//      call time so that the web UI can update immediately from the
//      session.attach response (rather than waiting for a future broadcast).

describe("T8 – regression guards: text overlap + stale status", () => {
  it("(a) delta and final session.message share the same messageId", async () => {
    const chunks = ["Hello", " world"];
    const deltas: ProviderEvent[] = chunks.map((c) => ({ type: "text_delta" as const, content: c }));
    const provider = new MockSessionProvider("claude", [
      [
        ...deltas,
        { type: "text_done", content: "Hello world" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("hi", TEST_AUTH);
    await waitForIdle(session);

    // Collect all messageIds that arrived via session.message.delta
    const deltaIds = new Set(
      received
        .filter((m) => m.type === "session.message.delta" && m.messageId)
        .map((m) => (m as { messageId: string }).messageId),
    );
    expect(deltaIds.size).toBeGreaterThan(0);

    // The committed assistant message must carry one of those same IDs.
    const finalMsg = received
      .filter((m) => m.type === "session.message" && m.role === "assistant" && m.content)
      .at(-1) as { messageId?: string } | undefined;
    expect(finalMsg).toBeDefined();
    expect(deltaIds.has(finalMsg!.messageId!)).toBe(true);
  });

  it("(b) toInfo() reflects live status — idle before/after a turn, error on provider error", async () => {
    // Before any turn: toInfo() reports idle (this is what the web UI reads
    // from the session.attach response to immediately correct a stale status).
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_done", content: "hi" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
      [
        { type: "error", message: "api blew up" },
      ],
    ]);
    const session = makeSession(provider);

    expect(session.toInfo().status).toBe("idle");

    await session.send("turn 1", TEST_AUTH);
    await waitForIdle(session);
    expect(session.toInfo().status).toBe("idle");

    await session.send("turn 2 — error", TEST_AUTH);
    await waitForIdle(session);
    expect(session.toInfo().status).toBe("error");
  });

  it("(c) parallel tool_start events do not cancel each other (subagent regression)", async () => {
    // Two concurrent tool calls (mimicking parallel subagents). The second
    // tool_start must NOT cancel the first — both must end as "completed".
    const toolUseIdA = "sdk-parallel-A";
    const toolUseIdB = "sdk-parallel-B";
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "t-A",
          sdkToolUseId: toolUseIdA,
          name: "Read",
          input: { file_path: "/tmp/a.ts" },
          approvalId: "approval-A",
        },
        {
          type: "tool_start",
          toolId: "t-B",
          sdkToolUseId: toolUseIdB,
          name: "Read",
          input: { file_path: "/tmp/b.ts" },
          approvalId: "approval-B",
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseIdA,
          output: "A",
          success: true,
        },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseIdB,
          output: "B",
          success: true,
        },
        { type: "text_done", content: "Done." },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);

    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run two tools in parallel", TEST_AUTH);
    await waitForIdle(session);

    // Both tool messages must reach "completed" — neither should be cancelled.
    const toolMsgs = received.filter((m) => m.type === "session.message" && m.role === "tool_call");
    expect(toolMsgs).toHaveLength(2);

    const finalPhases = toolMsgs.map((m) => {
      const tool = (m as { tool?: { state?: { phase?: string } } }).tool;
      // Walk deltas to find the last phase update for each messageId
      const msgId = (m as { messageId?: string }).messageId;
      const lastDelta = received
        .filter((d) => d.type === "session.message.delta" && (d as { messageId?: string }).messageId === msgId && (d as { toolStateUpdate?: { phase?: string } }).toolStateUpdate)
        .at(-1) as { toolStateUpdate?: { phase?: string } } | undefined;
      return lastDelta?.toolStateUpdate?.phase ?? tool?.state?.phase;
    });

    expect(finalPhases).not.toContain("cancelled");
    expect(finalPhases.every((p) => p === "completed")).toBe(true);
  });

  it("(d) text_done arriving before tool_complete does not cancel the in-flight tool", async () => {
    // The real Claude Agent SDK emits the committed assistant message (→ text_done)
    // BEFORE the user/tool_result message (→ tool_complete). A previous bug had
    // #completeActiveTools() in the text_done handler which cancelled any tool
    // still in #activeToolMsgIds at that moment, producing ghost
    // "cancelled — interrupted" cards in the UI.
    //
    // This test uses the real-world SDK ordering:
    //   tool_start → text_done → tool_complete → turn_done
    // to verify the tool ends as "completed", not "cancelled".
    const toolUseId = "sdk-real-order";
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "t-real",
          sdkToolUseId: toolUseId,
          name: "Read",
          input: { file_path: "/tmp/test.ts" },
          approvalId: "approval-real",
        },
        // text_done fires from the committed assistant message — BEFORE tool_result.
        { type: "text_done", content: "Reading the file." },
        {
          type: "tool_complete",
          sdkToolUseId: toolUseId,
          output: "file contents",
          success: true,
        },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);

    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run bash", TEST_AUTH);
    await waitForIdle(session);

    const toolMsg = received.find((m) => m.type === "session.message" && m.role === "tool_call");
    expect(toolMsg).toBeDefined();
    const msgId = (toolMsg as { messageId?: string }).messageId!;
    const lastDelta = received
      .filter((d) => d.type === "session.message.delta" && (d as { messageId?: string }).messageId === msgId && (d as { toolStateUpdate?: { phase?: string } }).toolStateUpdate)
      .at(-1) as { toolStateUpdate?: { phase?: string } } | undefined;
    const finalPhase = lastDelta?.toolStateUpdate?.phase ?? (toolMsg as { tool?: { state?: { phase?: string } } }).tool?.state?.phase;
    expect(finalPhase).toBe("completed");
  });
});

// ── T9: Mid-turn message handling ─────────────────────────────────────────────

describe("T9 – mid-turn message handling", () => {
  /**
   * Regression test for the bug where #consumeEvents broke on the first
   * turn_done (the interrupted partial turn) and left the continuation turn
   * with no consumer, causing the session to stop dead with an error instead
   * of processing the injected message.
   *
   * The test drives a custom TurnRun directly:
   *   1. Emit text_delta so the session enters "thinking" status.
   *   2. Wait for the mid-turn send() to arrive (via pushMidTurn).
   *   3. Emit turn_done(isError, "conversation ended mid-turn") — the aborted turn.
   *   4. Emit the continuation turn (text_delta + text_done + turn_done(success)).
   */
  it("mid-turn message is consumed as a continuation turn, not an error stop", async () => {
    const queue = new AsyncQueue<ProviderEvent>();
    let notifyMidTurnReceived: (() => void) | null = null;

    // Custom SessionProvider whose TurnRun supports pushMidTurn.
    const provider: import("../daemon/providers/interface.js").SessionProvider = {
      id: "claude",
      displayName: "MidTurnTest",
      onRecoveryNeeded: undefined,
      backingSessionId: "mid-turn-test-backing",
      hasQueried: false,
      queuedMessages: 0,
      resetToNewSession() {},
      setHasQueried(_v: boolean) { },
      async teardown() { queue.close(); },
      async dispose() { queue.close(); },
      async listModels() { return []; },

      runTurn(_opts: import("../daemon/providers/interface.js").TurnOpts): TurnRun {
        void (async () => {
          await Promise.resolve(); // yield so #consumeEvents loop has started
          // First turn: emit a partial text_delta so the session enters "thinking",
          // then stall until the mid-turn message arrives via pushMidTurn.
          queue.push({ type: "text_delta", content: "Working on original task..." });
          await new Promise<void>((r) => { notifyMidTurnReceived = r; });
          // Simulate SDK interrupting the turn when a now-priority message lands.
          queue.push({
            type: "turn_done",
            result: mockResult({ providerId: "claude", isError: true, errorMessage: "conversation ended mid-turn" }),
          });
          // Continuation turn for the injected mid-turn message.
          queue.push({ type: "text_delta", content: "Continuing with your request." });
          queue.push({ type: "text_done", content: "Continuing with your request." });
          queue.push({ type: "turn_done", result: mockResult({ providerId: "claude" }) });
          queue.close();
        })();

        return {
          events: queue,
          interrupt: async () => { queue.close(); },
          pushMidTurn: (_content: string, _priority: string) => {
            notifyMidTurnReceived?.();
          },
        };
      },
    };

    // makeSession() requires MockSessionProvider; construct Session directly.
    const id = randomUUID();
    store.createSession({
      id,
      name: "mid-turn-integ",
      workdir: tmp,
      status: "idle",
      createdBy: TEST_AUTH.sub,
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: TEST_AUTH.accountId!,
      projectId: TEST_AUTH.projectId!,
    });
    const { Session: SessionCtor } = await import("../daemon/session.js");
    const session = new SessionCtor({
      name: "mid-turn-integ",
      workdir: tmp,
      auth: TEST_AUTH,
      store,
      transcriptStore,
      existingId: id,
      _testProvider: provider as unknown as import("../daemon/providers/mock/session-provider.js").MockSessionProvider,
    });

    const { client, received } = makeClient();
    session.attach(client);

    // Start the first turn.
    await session.send("original task", TEST_AUTH);

    // Wait until the session is "thinking" before sending the mid-turn message.
    await waitForStatus(session, "thinking");

    // Send mid-turn message — triggers pushMidTurn on the active run.
    await session.send("mid-turn add something", TEST_AUTH);

    // Session must reach idle (not error) after both turns complete.
    await waitForIdle(session);

    expect(session.status).toBe("idle");

    // No "Error: conversation ended mid-turn" should appear in the scrollback.
    const errorMsgs = received.filter(
      (m) =>
        m.type === "session.message" &&
        (m as { role?: string }).role === "system" &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { content: string }).content).startsWith("Error:"),
    );
    expect(errorMsgs).toHaveLength(0);

    // The continuation assistant message from the mid-turn response must exist.
    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && (m as { role?: string }).role === "assistant",
    );
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const lastAssistant = assistantMsgs.at(-1) as { content?: string };
    expect(lastAssistant?.content).toContain("Continuing");
  });
});

// ── T9: Stall watchdog — wedged turn self-recovers ──────────────────────────────
//
// Regression guard for the "stuck in replying, no messages" wedge (#46): when a
// provider's event stream goes silent without a terminal turn_done (hung tool /
// dead subprocess), the session must NOT block forever. The watchdog force-
// recovers the turn, reaps the provider, and a subsequent send works normally.
describe("T9 – stall watchdog recovers a wedged turn", () => {
  it("a turn whose stream goes silent recovers to idle, emits a timeout notice, and reaps the provider", async () => {
    // stall:true → MockSessionProvider emits the delta then leaves the queue
    // open forever (no turn_done, no close), exactly like a hung stream.
    const provider = new MockSessionProvider(
      "claude",
      [[{ type: "text_delta", content: "working on it" }]],
      { stall: true },
    );
    const session = makeSession(provider, "stall-watchdog", stallConfig(80));
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("do the thing", TEST_AUTH);
    expect(session.status).toBe("thinking");

    // Watchdog fires at 80ms → recovery. Allow generous slack for CI.
    await waitForIdle(session, 4000);
    expect(session.status).toBe("idle");

    // A clear timeout breadcrumb was surfaced (not a silent wedge).
    const stalledMsg = received.find(
      (m) =>
        m.type === "session.message" &&
        (m as { role?: string }).role === "system" &&
        /timed out/i.test((m as { content?: string }).content ?? ""),
    );
    expect(stalledMsg).toBeTruthy();

    // The presumed-hung subprocess was reaped (provider torn down).
    expect(provider.teardownCount).toBeGreaterThanOrEqual(1);
  });

  it("after a stall recovery, the next send starts a fresh turn and gets a reply (no permanent wedge)", async () => {
    // First turn stalls; second turn is a normal scripted reply.
    const provider = new MockSessionProvider(
      "claude",
      [
        [{ type: "text_delta", content: "hang…" }], // stalls (queue left open)
        [
          { type: "text_done", content: "Recovered and replied." },
          { type: "turn_done", result: mockResult({ providerId: "claude" }) },
        ],
      ],
      { stall: true },
    );
    const session = makeSession(provider, "stall-then-send", stallConfig(80));
    const { client, received } = makeClient();
    session.attach(client);

    // Turn 1 wedges → watchdog recovers it.
    await session.send("first", TEST_AUTH);
    await waitForIdle(session, 4000);
    expect(session.status).toBe("idle");

    // Turn 2 must behave like a normal turn (not get swallowed into the dead run).
    await session.send("second", TEST_AUTH);
    await waitForIdle(session, 4000);

    const assistantMsgs = received.filter(
      (m) => m.type === "session.message" && (m as { role?: string }).role === "assistant",
    );
    const last = assistantMsgs.at(-1) as { content?: string };
    expect(last?.content).toBe("Recovered and replied.");
    // Two runTurn() calls: the stalled one + the recovered one.
    expect(provider.capturedOpts.length).toBeGreaterThanOrEqual(2);
  });

  it("watchdog disabled (turnStallTimeoutMs=0) leaves a silent turn blocked (no false recovery)", async () => {
    const provider = new MockSessionProvider(
      "claude",
      [[{ type: "text_delta", content: "indefinite" }]],
      { stall: true },
    );
    const session = makeSession(provider, "stall-disabled", stallConfig(0));
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("go", TEST_AUTH);
    expect(session.status).toBe("thinking");

    // With the watchdog off, the turn stays "thinking" — give it room to (not) recover.
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(session.status).toBe("thinking");
    const stalledMsg = received.find(
      (m) => m.type === "session.message" && /timed out/i.test((m as { content?: string }).content ?? ""),
    );
    expect(stalledMsg).toBeUndefined();

    // Clean up the still-open run so afterEach doesn't race a live consumer.
    await session.interrupt(TEST_AUTH);
  });

  it("does NOT fire while waiting for a manual tool approval (legitimate silent period)", async () => {
    // Bash is a mutation tool — in guarded (default) mode it requires approval.
    // The mock blocks in canUseTool until approve(), leaving the stream silent.
    // The watchdog must pause during that wait, not cancel the approval prompt.
    const provider = new MockSessionProvider(
      "claude",
      [
        [
          {
            type: "tool_start",
            toolId: "bash-stall",
            sdkToolUseId: "sdk-bash-stall",
            name: "Bash",
            input: { command: "sleep 999" },
            approvalId: "ap-stall-1",
          },
        ],
      ],
      { stall: true },
    );
    const session = makeSession(provider, "stall-approval", stallConfig(80));
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run it", TEST_AUTH);
    await waitForStatus(session, "waiting_approval", 4000);

    // Wait well past the 80ms stall window — the watchdog must stay paused.
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(session.status).toBe("waiting_approval");
    const stalledMsg = received.find(
      (m) => m.type === "session.message" && /timed out/i.test((m as { content?: string }).content ?? ""),
    );
    expect(stalledMsg).toBeUndefined();

    // Clean up the pending approval + open run.
    await session.interrupt(TEST_AUTH);
  });

  it("does NOT fire while a long-running tool is executing (silence during tools is legitimate)", async () => {
    // Regression for the 300s-timeout-kills-long-tasks bug: a Read (auto-
    // approved in guarded mode) starts executing and the stream then goes
    // silent — exactly what a multi-minute Bash run, Task subagent, or web
    // research looks like (the SDK emits NOTHING until the tool completes).
    // The watchdog must pause instead of tearing down legitimate work.
    const provider = new MockSessionProvider(
      "claude",
      [
        [
          {
            type: "tool_start",
            toolId: "read-long",
            sdkToolUseId: "sdk-read-long",
            name: "Read",
            input: { file_path: "/big/repo/file.ts" },
            approvalId: "ap-read-long",
          },
        ],
      ],
      { stall: true },
    );
    const session = makeSession(provider, "stall-long-tool", stallConfig(80));
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("explore the codebase", TEST_AUTH);
    await waitForStatus(session, "tool_running", 4000);

    // Wait well past the 80ms stall window — no recovery, no teardown.
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(session.status).toBe("tool_running");
    const stalledMsg = received.find(
      (m) => m.type === "session.message" && /timed out/i.test((m as { content?: string }).content ?? ""),
    );
    expect(stalledMsg).toBeUndefined();
    expect(provider.teardownCount).toBe(0);

    await session.interrupt(TEST_AUTH);
  });

  it("a send arriving mid-long-tool queues instead of killing the run (liveness guard pauses too)", async () => {
    // Same long-silent-tool setup; the user asks "how's it going?" after the
    // stall window has elapsed. The #sendInner liveness guard previously
    // force-recovered here — cancelling the in-flight tool and resetting the
    // session. It must respect the same pause conditions as the watchdog.
    const provider = new MockSessionProvider(
      "claude",
      [
        [
          {
            type: "tool_start",
            toolId: "read-long-2",
            sdkToolUseId: "sdk-read-long-2",
            name: "Read",
            input: { file_path: "/big/repo/other.ts" },
            approvalId: "ap-read-long-2",
          },
        ],
      ],
      { stall: true },
    );
    const session = makeSession(provider, "stall-midtool-send", stallConfig(80));
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("do a long exploration", TEST_AUTH);
    await waitForStatus(session, "tool_running", 4000);

    // Let the stall window lapse, then send into the silent-but-working run.
    await new Promise<void>((r) => setTimeout(r, 300));
    await session.send("how's it going?", TEST_AUTH);

    // The liveness guard must NOT have treated the tool-executing run as
    // stalled: before the fix this path emitted "⚠️ Previous turn timed out …
    // being retried in a fresh turn" and force-reaped the provider. (The mock
    // lacks pushMidTurn, so the send legitimately starts a fresh turn — what
    // matters is that it wasn't a STALL recovery; the real ClaudeProvider
    // queues mid-turn and the run survives.)
    const stalledMsg = received.find(
      (m) => m.type === "session.message" && /timed out|stalled/i.test((m as { content?: string }).content ?? ""),
    );
    expect(stalledMsg).toBeUndefined();
    // Pin the post-send state so an overlapping-turn regression fails loudly:
    // exactly the first run + the send's fresh turn (no third), and — the key
    // discriminator vs the old bug — NO forced provider teardown (the stall
    // recovery path called provider.teardown(), so it would show ≥ 1 here).
    expect(provider.capturedOpts.length).toBe(2);
    expect(provider.teardownCount).toBe(0);

    await session.interrupt(TEST_AUTH);
  });
});

// ── T7: status persistence — dedupe, write-through, debounce ──────────────────

describe("T7 – status persistence", () => {
  it("suppresses duplicate status broadcasts and persists terminal states immediately", async () => {
    const provider = new MockSessionProvider("claude", [
      [
        { type: "text_delta", content: "hi " },
        { type: "text_done", content: "hi there" },
        { type: "turn_done", result: mockResult({ providerId: "claude" }) },
      ],
    ]);
    const session = makeSession(provider, "status-dedupe");
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("hello", TEST_AUTH);
    await waitForIdle(session);

    // The turn re-asserts "thinking" several times internally; clients see
    // each distinct status exactly once: thinking → idle.
    const statuses = received
      .filter((m) => m.type === "session.status_change")
      .map((m) => (m as { status: string }).status);
    expect(statuses).toEqual(["thinking", "idle"]);

    // Terminal state wrote through immediately — no debounce window to wait out.
    expect(store.getSession(session.id)?.status).toBe("idle");
    await transcriptStore.flush();
    const meta = JSON.parse(
      readFileSync(transcriptStore.metaPath(session.id), "utf-8"),
    ) as { lastStatus: string };
    expect(meta.lastStatus).toBe("idle");
  });

  it("debounces persistence of active statuses instead of writing per flip", async () => {
    // A stalling provider holds the session in an ACTIVE status past the
    // 500 ms debounce window; a 2 s watchdog recovers it afterwards.
    const provider = new MockSessionProvider("claude", [[]], { stall: true });
    const session = makeSession(provider, "status-debounce", stallConfig(2000));

    await session.send("wedge", TEST_AUTH);
    expect(session.status).toBe("thinking");
    // In-memory state flipped, but the sync UPDATE is deferred — the DB row
    // still shows the status the session was created with.
    expect(store.getSession(session.id)?.status).toBe("idle");

    // …until the trailing debounce fires with the CURRENT value. Generous
    // margin over the 500 ms window — this asserts "persisted by now", so
    // extra slack only makes it MORE robust under CI load.
    await new Promise<void>((r) => setTimeout(r, 900));
    expect(store.getSession(session.id)?.status).toBe("thinking");

    // Watchdog recovery lands on idle (terminal → immediate write-through).
    await waitForIdle(session, 6000);
    expect(store.getSession(session.id)?.status).toBe("idle");
  });
});

describe("mid-turn provider teardown emits idle", () => {
  it("broadcasts status_change idle when setModel tears down an in-flight turn", async () => {
    // A tool that needs approval keeps the turn genuinely in flight (the mock
    // blocks in canUseTool, no tool_complete), so we can tear it down mid-turn.
    const provider = new MockSessionProvider("claude", [
      [
        {
          type: "tool_start",
          toolId: "mid-t1",
          sdkToolUseId: "sdk-mid-1",
          name: "Bash",
          input: { command: "sleep 60" },
          approvalId: "ap-mid-1",
        },
        // No tool_complete — the turn stays in flight.
      ],
    ]);
    const session = makeSession(provider);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("start a long turn", TEST_AUTH);
    // Let the consumer process tool_start; the turn is now in flight (busy).
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(session.status).not.toBe("idle");

    // Switch model mid-turn — this tears the provider down. Before the fix the
    // drained consumer skipped its idle reset (run already nulled) and no
    // status_change:idle was ever broadcast, stranding clients on "thinking".
    await session.setModel("sonnet", undefined, TEST_AUTH);
    await waitForIdle(session);

    expect(session.status).toBe("idle");
    const idleBroadcasts = received.filter(
      (m) => m.type === "session.status_change" && m.status === "idle",
    );
    expect(idleBroadcasts.length).toBeGreaterThanOrEqual(1);
  });
});

// ── T10: send during a pending approval must not auto-deny the tool ───────────
//
// Regression guard: `wasWorking` used to cover only thinking/tool_running, so
// a send arriving in `waiting_approval` skipped the mid-turn path and called
// provider.runTurn() — which closed the live turn queue, whose consumer's
// `finally` resolved every pending approval with {approved: false}. Net
// effect: typing "wait, what does this do?" at an approval prompt silently
// DENIED the tool and orphaned the question's reply.
describe("T10 – send during waiting_approval", () => {
  const approvalToolStart = (approvalId: string) =>
    [
      [
        {
          type: "tool_start" as const,
          toolId: `bash-${approvalId}`,
          sdkToolUseId: `sdk-${approvalId}`,
          name: "Bash",
          input: { command: "rm -rf build" },
          approvalId,
        },
      ],
    ];

  it("queues mid-turn (pushMidTurn backend) and keeps the approval pending", async () => {
    const provider = new MockSessionProvider("claude", approvalToolStart("ap-t10-a"), {
      stall: true,
      midTurn: true,
    });
    const session = makeSession(provider, "t10-midturn");
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run the cleanup", TEST_AUTH);
    await waitForStatus(session, "waiting_approval", 4000);

    // The user asks a question INSTEAD of deciding.
    await session.send("wait, what does this do?", TEST_AUTH);

    // Queued into the LIVE run — no second runTurn, no teardown…
    expect(provider.midTurnPushes.length).toBe(1);
    expect(provider.midTurnPushes[0]!.content).toContain("what does this do?");
    expect(provider.capturedOpts.length).toBe(1);
    expect(provider.teardownCount).toBe(0);
    // …the approval is still pending (nothing resolved it)…
    expect(provider.canUseToolResults.length).toBe(0);
    // …and the status stays waiting_approval so every frontend keeps its
    // approval bar up (the old path flipped it and hid the prompt).
    expect(session.status).toBe("waiting_approval");

    // The user can still decide — approve resolves the ORIGINAL tool.
    session.approve("ap-t10-a", true, TEST_AUTH);
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(provider.canUseToolResults.length).toBe(1);
    expect(provider.canUseToolResults[0]!.behavior).toBe("allow");

    const denied = received.find(
      (m) =>
        m.type === "session.message.delta" &&
        (m as { toolStateUpdate?: { phase?: string } }).toolStateUpdate?.phase === "cancelled",
    );
    expect(denied).toBeUndefined();

    await session.interrupt(TEST_AUTH);
  });

  it("a mid-turn push during a RUNNING tool leaves the status at tool_running", async () => {
    // The reported symptom: type while Claude is working and the session goes
    // quiet. A tool that is genuinely executing is a legitimately-silent state,
    // and the stall watchdog pauses on `tool_running` for exactly that reason
    // (#watchdogPaused). Flipping the status to "thinking" on a mid-turn push
    // silently UNPAUSES it, so a long tool — a Snowflake sweep, a big build —
    // gets force-recovered at the stall window with the user's queued message
    // still in it. It also makes every frontend disagree with itself: the tool
    // card says "executing" while the session header says "thinking".
    //
    // waiting_approval already had this carve-out (test above). tool_running is
    // the same situation for the same reason.
    const provider = new MockSessionProvider(
      "claude",
      [
        [
          {
            type: "tool_start",
            toolId: "long-sweep",
            sdkToolUseId: "sdk-long-sweep",
            name: "Read",
            input: { file_path: "/big/repo/sweep-results.csv" },
            approvalId: "ap-long-sweep",
          },
        ],
      ],
      { stall: true, midTurn: true },
    );
    const session = makeSession(provider, "t10-midturn-tool");
    const { client } = makeClient();
    session.attach(client);

    await session.send("run the sweep", TEST_AUTH);
    await waitForStatus(session, "tool_running", 4000);

    // The user adds context while the tool is still running.
    await session.send("also get me the per-client numbers", TEST_AUTH);

    // Queued into the live run, as designed…
    expect(provider.midTurnPushes.length).toBe(1);
    expect(provider.midTurnPushes[0]!.content).toContain("per-client numbers");
    expect(provider.capturedOpts.length).toBe(1);
    expect(provider.teardownCount).toBe(0);

    // …and the tool is still executing, so the status must still say so —
    // otherwise the watchdog starts counting against a healthy tool.
    expect(session.status).toBe("tool_running");

    await session.interrupt(TEST_AUTH);
  });

  it("a mid-turn push does not re-arm the stall watchdog against a running tool", async () => {
    // The damage the status flip actually caused. The watchdog pauses while a
    // tool executes because silence there is expected. Flipping to "thinking"
    // on a mid-turn push re-armed it, so once the stall window lapsed the run
    // was force-recovered — killing a healthy tool AND the message the user had
    // just queued into it. Short stall window so the test can outlive it.
    const provider = new MockSessionProvider(
      "claude",
      [
        [
          {
            type: "tool_start",
            toolId: "long-sweep-2",
            sdkToolUseId: "sdk-long-sweep-2",
            name: "Read",
            input: { file_path: "/big/repo/huge.csv" },
            approvalId: "ap-long-sweep-2",
          },
        ],
      ],
      { stall: true, midTurn: true },
    );
    const session = makeSession(provider, "t10-midturn-nostall", stallConfig(80));
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("read the huge file", TEST_AUTH);
    await waitForStatus(session, "tool_running", 4000);

    await session.send("and summarize the totals", TEST_AUTH);
    expect(provider.midTurnPushes.length).toBe(1);

    // Sit well past the stall window with the tool still running.
    await new Promise<void>((r) => setTimeout(r, 400));

    // The run must be untouched: no stall recovery, no provider teardown, no
    // second turn started behind the user's back.
    const stalledMsg = received.find(
      (m) =>
        m.type === "session.message" &&
        /timed out|stalled/i.test((m as { content?: string }).content ?? ""),
    );
    expect(stalledMsg).toBeUndefined();
    expect(provider.teardownCount).toBe(0);
    expect(provider.capturedOpts.length).toBe(1);
    expect(session.status).toBe("tool_running");

    await session.interrupt(TEST_AUTH);
  });

  it("rejects the send loudly on a backend without mid-turn injection (never auto-denies)", async () => {
    const provider = new MockSessionProvider("claude", approvalToolStart("ap-t10-b"), {
      stall: true,
    });
    const session = makeSession(provider, "t10-no-midturn");
    const { client } = makeClient();
    session.attach(client);

    await session.send("run the cleanup", TEST_AUTH);
    await waitForStatus(session, "waiting_approval", 4000);

    // No pushMidTurn on this backend: the send must FAIL LOUDLY instead of
    // starting a fresh turn (which would close the turn queue and auto-deny).
    await expect(session.send("hold on, explain first", TEST_AUTH)).rejects.toThrow(
      /approval is pending/i,
    );

    // The approval survived: nothing resolved it, no fresh turn started.
    expect(provider.canUseToolResults.length).toBe(0);
    expect(provider.capturedOpts.length).toBe(1);
    expect(session.status).toBe("waiting_approval");

    // Deciding still works.
    session.approve("ap-t10-b", false, TEST_AUTH);
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(provider.canUseToolResults.length).toBe(1);
    expect(provider.canUseToolResults[0]!.behavior).toBe("deny");

    await session.interrupt(TEST_AUTH);
  });
});
