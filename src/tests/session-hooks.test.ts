/**
 * Session ↔ HookBus integration tests — MockSessionProvider harness, offline.
 *
 * Exercises the daemon-native hook seams end-to-end through Session:
 *
 *   H1  tool_call block — the hook denies the tool BEFORE the approval gate:
 *       the provider sees behavior "deny", the tool message resolves to
 *       cancelled, an info message explains which hook blocked and why,
 *       and (in autonomous mode) the turn budget is NOT decremented.
 *
 *   H2  tool_call block wins even for auto-approved safe tools.
 *
 *   H3  tool_call mutation — the provider receives the hook's updatedInput
 *       and an info message records the mutation.
 *
 *   H4  before_turn — the hook's systemPromptAppend reaches the provider's
 *       TurnOpts, appended after the session's base append.
 *
 *   H5  tool_result patch — the completed tool message carries the patched
 *       output (redaction), and the canonical history records it.
 *
 *   H6  Lifecycle observe hooks — session_start and after_turn fire with
 *       the session context.
 *
 *   H7  No hooks configured — zero behavioral change (guarded dispatch).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { mockResult } from "../daemon/providers/mock/index.js";
import { HookBus } from "../daemon/hooks/bus.js";
import type { HookEntryConfig } from "../daemon/hooks/types.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { CodeoidConfig } from "../config.js";
import type { DaemonMessage, AuthContext } from "../protocol/types.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";

const TEST_AUTH: AuthContext = {
  sub: "user:test-hooks",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc-hooks",
  projectId: "proj-hooks",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-session-hooks-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 100));
  try {
    await transcriptStore.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function commandEntry(
  command: string,
  overrides: Partial<HookEntryConfig> = {},
): HookEntryConfig {
  return { event: "tool_call", type: "command", command, ...overrides };
}

function makeSession(
  provider: MockSessionProvider,
  hooks?: HookBus,
  initialMode?: { mode: "guarded" | "autonomous" | "interactive"; maxTurns?: number },
  extra?: Partial<ConstructorParameters<typeof Session>[0]>,
): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name: "hooks-integ",
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId!,
    projectId: TEST_AUTH.projectId!,
  });
  return new Session({
    name: "hooks-integ",
    workdir: tmp,
    auth: TEST_AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: provider,
    hooks,
    ...(initialMode ? { initialMode } : {}),
    ...(extra ?? {}),
  });
}

/**
 * Poll until `path` holds parseable JSON and return it. Existence alone is
 * not enough: `cat > file` creates (truncates) the file before the payload
 * bytes land, so an exists-check races a partial write.
 */
async function waitForJson(path: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        /* partial write — keep polling */
      }
    }
    if (Date.now() > deadline) throw new Error(`no JSON payload appeared at: ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeClient(): { client: AttachedClient; received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return {
    client: { id: randomUUID(), auth: TEST_AUTH, send: (msg) => received.push(msg) },
    received,
  };
}

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
        if (
          msg.type === "session.status_change" &&
          (msg.status === "idle" || msg.status === "error")
        ) {
          clearTimeout(timer);
          session.detach(watcherId);
          resolve();
        }
      },
    };
    session.attach(watcher);
  });
}

/** One scripted turn: a single Bash tool call, then a text reply. */
function bashToolTurn(): ProviderEvent[] {
  return [
    {
      type: "tool_start",
      toolId: "t1",
      sdkToolUseId: "sdk-t1",
      name: "Bash",
      input: { command: "rm -rf /tmp/x" },
      approvalId: "a1",
    },
    { type: "text_done", content: "done" },
    { type: "turn_done", result: mockResult({ providerId: "mock-session" }) },
  ];
}

describe("Session hook integration", () => {
  it("H1: tool_call hook blocks before the approval gate (no budget burn)", async () => {
    const hooks = new HookBus([
      commandEntry(`printf '{"decision":"block","reason":"env files are off-limits"}'`, {
        name: "env-guard",
        matcher: "^Bash$",
      }),
    ]);
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    // Autonomous with a budget: a hook block must not decrement it.
    const session = makeSession(provider, hooks, { mode: "autonomous", maxTurns: 5 });
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);

    expect(provider.canUseToolResults).toHaveLength(1);
    expect(provider.canUseToolResults[0]).toMatchObject({
      behavior: "deny",
      message: 'Blocked by hook "env-guard": env files are off-limits',
    });
    // Budget untouched — the hook gate runs before #shouldAutoApprove.
    expect(session.turnsRemaining).toBe(5);

    // The user sees WHY: an info message tagged hook.blocked.
    const info = received.find(
      (m) =>
        m.type === "session.message" &&
        m.metadata?.event === "hook.blocked",
    );
    expect(info).toBeDefined();
    if (info?.type === "session.message") {
      expect(info.content).toContain("env-guard");
      expect(info.content).toContain("env files are off-limits");
      expect(info.metadata?.tool).toBe("Bash");
    }

    // The tool message resolved to cancelled with the hook's explanation.
    const cancelled = received.find(
      (m) =>
        m.type === "session.message.delta" &&
        m.toolStateUpdate?.phase === "cancelled",
    );
    expect(cancelled).toBeDefined();
    if (cancelled?.type === "session.message.delta" && cancelled.toolStateUpdate?.phase === "cancelled") {
      expect(cancelled.toolStateUpdate.message).toContain("env-guard");
    }
  });

  it("H2: a hook block wins even for auto-approved safe tools", async () => {
    const hooks = new HookBus([
      commandEntry(`printf '{"decision":"block","reason":"no reads today"}'`, {
        matcher: "^Read$",
      }),
    ]);
    const provider = new MockSessionProvider("mock-session", [
      [
        {
          type: "tool_start",
          toolId: "t1",
          sdkToolUseId: "sdk-t1",
          name: "Read",
          input: { file_path: "/etc/passwd" },
          approvalId: "a1",
        },
        { type: "text_done", content: "done" },
        { type: "turn_done", result: mockResult({ providerId: "mock-session" }) },
      ],
    ]);
    const session = makeSession(provider, hooks);
    await session.send("read it", TEST_AUTH);
    await waitForIdle(session);

    expect(provider.canUseToolResults[0]?.behavior).toBe("deny");
  });

  it("H3: tool_call hook mutation reaches the provider as updatedInput", async () => {
    const hooks = new HookBus([
      commandEntry(`printf '{"updatedInput":{"command":"echo SAFE"}}'`, {
        name: "rewriter",
        matcher: "^Bash$",
      }),
    ]);
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    const session = makeSession(provider, hooks, { mode: "autonomous" });
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);

    expect(provider.canUseToolResults).toHaveLength(1);
    expect(provider.canUseToolResults[0]).toMatchObject({
      behavior: "allow",
      updatedInput: { command: "echo SAFE" },
    });
    const info = received.find(
      (m) => m.type === "session.message" && m.metadata?.event === "hook.updated_input",
    );
    expect(info).toBeDefined();
    if (info?.type === "session.message") {
      expect(info.metadata?.hooks).toEqual(["rewriter"]);
    }
  });

  it("H4: before_turn hook append reaches the provider's TurnOpts", async () => {
    const hooks = new HookBus([
      commandEntry(`printf '{"systemPromptAppend":"Always answer in haiku."}'`, {
        event: "before_turn",
      }),
    ]);
    const provider = new MockSessionProvider("mock-session", [
      [
        { type: "text_done", content: "ok" },
        { type: "turn_done", result: mockResult({ providerId: "mock-session" }) },
      ],
    ]);
    const session = makeSession(provider, hooks);
    await session.send("hello", TEST_AUTH);
    await waitForIdle(session);

    expect(provider.capturedOpts).toHaveLength(1);
    expect(provider.capturedOpts[0]?.systemPromptAppend).toContain("Always answer in haiku.");
  });

  it("H5: tool_result hook patches the recorded output and canonical history", async () => {
    const hooks = new HookBus([
      commandEntry(`printf '{"updatedOutput":"[REDACTED BY HOOK]"}'`, {
        event: "tool_result",
        matcher: "^Bash$",
      }),
    ]);
    const provider = new MockSessionProvider("mock-session", [
      [
        {
          type: "tool_start",
          toolId: "t1",
          sdkToolUseId: "sdk-t1",
          name: "Bash",
          input: { command: "cat secrets.txt" },
          approvalId: "a1",
        },
        { type: "tool_complete", sdkToolUseId: "sdk-t1", output: "AWS_SECRET=hunter2", success: true },
        { type: "text_done", content: "done" },
        { type: "turn_done", result: mockResult({ providerId: "mock-session" }) },
      ],
    ]);
    const session = makeSession(provider, hooks, { mode: "autonomous" });
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);

    const completed = received.find(
      (m) =>
        m.type === "session.message.delta" &&
        m.toolStateUpdate?.phase === "completed",
    );
    expect(completed).toBeDefined();
    if (completed?.type === "session.message.delta" && completed.toolStateUpdate?.phase === "completed") {
      expect(completed.toolStateUpdate.output).toBe("[REDACTED BY HOOK]");
      expect(completed.toolStateUpdate.output).not.toContain("hunter2");
    }
  });

  it("H6: session_start and after_turn observe hooks fire with session context", async () => {
    const marker = join(tmp, "lifecycle.jsonl");
    const hooks = new HookBus([
      commandEntry(`cat >> "${marker}"; printf '\\n' >> "${marker}"`, { event: "session_start" }),
      commandEntry(`cat >> "${marker}"; printf '\\n' >> "${marker}"`, { event: "after_turn" }),
    ]);
    const provider = new MockSessionProvider("mock-session", [
      [
        { type: "text_done", content: "ok" },
        { type: "turn_done", result: mockResult({ providerId: "mock-session" }) },
      ],
    ]);
    const session = makeSession(provider, hooks);
    await session.send("hello", TEST_AUTH);
    await waitForIdle(session);

    // Fire-and-forget hooks — poll for both lines to land.
    const deadline = Date.now() + 3000;
    let lines: string[] = [];
    while (Date.now() < deadline) {
      if (existsSync(marker)) {
        lines = readFileSync(marker, "utf8").split("\n").filter((l) => l.trim().length > 0);
        if (lines.length >= 2) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const events = lines.map((l) => JSON.parse(l));
    const start = events.find((e) => e.event === "session_start");
    const after = events.find((e) => e.event === "after_turn");
    expect(start).toMatchObject({ source: "resume", sessionName: "hooks-integ" });
    expect(after?.result?.model).toBeDefined();
    expect(after?.sessionId).toBe(session.id);
  });

  it("H7: without a bus, tool flow is unchanged", async () => {
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    const session = makeSession(provider, undefined, { mode: "autonomous", maxTurns: 5 });
    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);

    expect(provider.canUseToolResults).toHaveLength(1);
    expect(provider.canUseToolResults[0]?.behavior).toBe("allow");
    // Budget decremented exactly once — the pre-hook contract holds.
    expect(session.turnsRemaining).toBe(4);
  });

  it("H8: hook mutation composes with MANUAL approval — user approves the mutated input", async () => {
    const hooks = new HookBus([
      commandEntry(`printf '{"updatedInput":{"command":"echo SAFE"}}'`, {
        name: "rewriter",
        matcher: "^Bash$",
      }),
    ]);
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    // Default guarded mode: Bash is a write/exec tool → manual approval.
    const session = makeSession(provider, hooks);
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run it", TEST_AUTH);
    // Wait for the hook's mutation broadcast, not just waiting_approval:
    // the tool_start handler flips the status from its side-effect-free
    // peek BEFORE canUseTool's hook gate has run.
    const deadline = Date.now() + 4000;
    while (
      !received.some(
        (m) => m.type === "session.message" && m.metadata?.event === "hook.updated_input",
      )
    ) {
      if (Date.now() > deadline) throw new Error(`mutation never broadcast — ${session.status}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(session.status).toBe("waiting_approval");

    // The approval UI must display what will ACTUALLY run — the delta from
    // the mutation broadcast carries the hook-rewritten input.
    const mutatedDelta = received.find(
      (m) =>
        m.type === "session.message.delta" &&
        m.toolStateUpdate?.phase === "waiting_confirmation" &&
        (m.toolStateUpdate.input as { command?: string })?.command === "echo SAFE",
    );
    expect(mutatedDelta).toBeDefined();

    session.approve("a1", true, TEST_AUTH);
    await waitForIdle(session);

    // The provider runs the mutated input (the approval merge base is the
    // hook's output, not the model's original).
    expect(provider.canUseToolResults).toHaveLength(1);
    expect(provider.canUseToolResults[0]).toMatchObject({
      behavior: "allow",
      updatedInput: { command: "echo SAFE" },
    });
  });

  it("H9: provider_switched observe hook fires with from/to on backend switch", async () => {
    const marker = join(tmp, "switched.json");
    const hooks = new HookBus([
      commandEntry(`cat > "${marker}"`, { event: "provider_switched" }),
    ]);
    // Registry supplying the incoming backend for switchProvider().
    const registry = new ProviderRegistry("mock-session");
    registry.register({
      id: "mock-b",
      displayName: "mock-b",
      create: () => new MockSessionProvider("mock-b", []),
    });
    const provider = new MockSessionProvider("mock-session", []);
    const session = makeSession(provider, hooks, undefined, { providers: registry });

    const result = await session.switchProvider("mock-b", TEST_AUTH);
    expect(result.ok).toBe(true);

    const payload = await waitForJson(marker);
    expect(payload).toMatchObject({
      event: "provider_switched",
      from: "mock-session",
      to: "mock-b",
      providerId: "mock-b", // context reports the NEW backend
      sessionId: session.id,
    });
  });

  it("H10: rotated observe hook fires on manual context rotation", async () => {
    const marker = join(tmp, "rotated.json");
    const hooks = new HookBus([commandEntry(`cat > "${marker}"`, { event: "rotated" })]);
    // Minimal config: manualRotate's min-turns guard reads autoRotate, and
    // #shouldRotate dereferences it on every send.
    const config = {
      session: {},
      autoRotate: {
        enabled: false,
        warnPct: 0.75,
        rotatePct: 0.9,
        hardRotatePct: 0.97,
        minTurnsBeforeRotate: 1,
        strategy: "task-anchor",
      },
    } as unknown as CodeoidConfig;
    const provider = new MockSessionProvider("mock-session", [
      [
        { type: "text_done", content: "ok" },
        { type: "turn_done", result: mockResult({ providerId: "mock-session" }) },
      ],
    ]);
    const session = makeSession(provider, hooks, undefined, { config });

    await session.send("hello", TEST_AUTH);
    await waitForIdle(session);
    const rotated = await session.manualRotate(TEST_AUTH);
    expect(rotated).toBe(true);

    const payload = await waitForJson(marker);
    expect(payload).toMatchObject({
      event: "rotated",
      reason: "manual",
      rotationCount: 1,
      sessionId: session.id,
    });
  });

  it("H11: session_end observe hook fires on destroy", async () => {
    const marker = join(tmp, "ended.json");
    const hooks = new HookBus([commandEntry(`cat > "${marker}"`, { event: "session_end" })]);
    const provider = new MockSessionProvider("mock-session", []);
    const session = makeSession(provider, hooks);

    await session.destroy(TEST_AUTH);

    const payload = await waitForJson(marker);
    expect(payload).toMatchObject({ event: "session_end", sessionId: session.id });
  });
});

/**
 * #367: a backend that only answers yes/no runs the input IT proposed, so a
 * hook's rewrite would be shown (and approved) while the original ran. Such a
 * call is refused instead — before it is shown or parked.
 */
describe("hook rewrite on a backend that can't apply it (#367)", () => {
  function auditActions(): string[] {
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    try {
      return (db.query("SELECT action FROM audit_log ORDER BY id").all() as Array<{ action: string }>).map((r) => r.action);
    } finally {
      db.close();
    }
  }

  function rewritingHooks(): HookBus {
    return new HookBus([
      commandEntry(`printf '{"updatedInput":{"command":"echo SAFE"}}'`, { name: "rewriter", matcher: "^Bash$" }),
    ]);
  }

  it("refuses the call — never runs the original, never shows the rewrite", async () => {
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    provider.appliesToolInputRewrite = false;
    const session = makeSession(provider, rewritingHooks(), { mode: "autonomous" });
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);

    expect(provider.canUseToolResults).toHaveLength(1);
    expect(provider.canUseToolResults[0]?.behavior).toBe("deny");
    expect(provider.canUseToolResults[0]?.message).toContain("rewrote");
    const refused = received.find((m) => m.type === "session.message" && m.metadata?.event === "hook.rewrite_refused");
    expect(refused).toBeDefined();
    // The rewrite never reached a display as if it would run.
    expect(received.some((m) => m.type === "session.message" && m.metadata?.event === "hook.updated_input")).toBe(false);
    expect(auditActions()).toContain("session.hook_rewrite_refused");
  });

  it("in interactive mode nothing is parked for approval", async () => {
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    provider.appliesToolInputRewrite = false;
    const session = makeSession(provider, rewritingHooks(), { mode: "interactive" });
    const { client, received } = makeClient();
    session.attach(client);

    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);

    expect(provider.canUseToolResults[0]?.behavior).toBe("deny");
    expect(session.pendingToolApprovals()).toEqual([]);
    // The announced call ends cancelled, with the reason — not left awaiting a yes.
    const final = received
      .filter((m) => m.type === "session.message.delta" && m.toolStateUpdate)
      .map((m) => (m.type === "session.message.delta" ? m.toolStateUpdate : undefined))
      .at(-1) as { phase?: string; message?: string } | undefined;
    expect(final?.phase).toBe("cancelled");
    expect(final?.message).toContain("can't run a rewritten input");
  });

  it("a backend that applies rewrites is unchanged", async () => {
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    const session = makeSession(provider, rewritingHooks(), { mode: "autonomous" });
    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);
    expect(provider.canUseToolResults[0]).toMatchObject({ behavior: "allow", updatedInput: { command: "echo SAFE" } });
  });

  it("an approver's form answers that the backend would drop: refused, not run without them", async () => {
    const provider = new MockSessionProvider("mock-session", [
      [
        {
          type: "tool_start",
          toolId: "t1",
          sdkToolUseId: "sdk-t1",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Which scope?", header: "Scope", options: [{ label: "A" }, { label: "B" }] }] },
          approvalId: "a1",
          patchableKeys: ["answers"],
        },
        { type: "turn_done", result: mockResult({ providerId: "mock-session" }) },
      ] as ProviderEvent[],
    ]);
    provider.appliesToolInputRewrite = false;
    const session = makeSession(provider, undefined, { mode: "interactive" });
    const { client, received } = makeClient();
    session.attach(client);
    await session.send("ask", TEST_AUTH);
    for (let i = 0; i < 200 && session.pendingToolApprovals().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(session.pendingToolApprovals()).toHaveLength(1);

    session.approve("a1", true, TEST_AUTH, { answers: { "Which scope?": "A" } });
    await waitForIdle(session);

    expect(provider.canUseToolResults[0]?.behavior).toBe("deny");
    expect(provider.canUseToolResults[0]?.message).toContain("answers");
    const actions = auditActions();
    expect(actions).toContain("session.patch_refused");
    // The user's answer is audited (they did approve); the GATE never records
    // the call as approved-and-running.
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const gateApproved = db
      .query("SELECT count(*) AS n FROM audit_log WHERE action = 'session.approve' AND detail LIKE 'tool=%'")
      .get() as { n: number };
    db.close();
    expect(gateApproved.n).toBe(0);
    // The card ends cancelled — never left showing an approved, running call.
    const phases = received
      .filter((m) => m.type === "session.message.delta" && m.toolStateUpdate)
      .map((m) => (m.type === "session.message.delta" ? (m.toolStateUpdate as { phase?: string }).phase : undefined));
    expect(phases).not.toContain("executing");
    expect(phases.at(-1)).toBe("cancelled");
  });

  it("a hook that returns the input unchanged is not a rewrite — allowed even on such a backend", async () => {
    const hooks = new HookBus([
      commandEntry(`printf '{"updatedInput":{"command":"rm -rf /tmp/x"}}'`, { name: "echoer", matcher: "^Bash$" }),
    ]);
    const provider = new MockSessionProvider("mock-session", [bashToolTurn()]);
    provider.appliesToolInputRewrite = false;
    const session = makeSession(provider, hooks, { mode: "autonomous" });
    await session.send("run it", TEST_AUTH);
    await waitForIdle(session);
    expect(provider.canUseToolResults[0]?.behavior).toBe("allow");
    expect(auditActions()).not.toContain("session.hook_rewrite_refused");
  });
});
