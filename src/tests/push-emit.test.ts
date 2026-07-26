/**
 * End-to-end: a manager-owned session that blocks on a tool approval fires a
 * CONTENT-BLIND push to the owner's registered device. Drives a real Session
 * (MockSessionProvider) through SessionManager so the daemon-wide status
 * observer runs, and captures the outbound Expo POST to assert content-blindness.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, SessionInfo } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:push",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const CLIENT = { id: "c", auth: AUTH, send: () => {} };

/** One scripted turn: call a hard-gated fleet tool (requires approval in ANY
 *  mode), then finish — so the session parks at waiting_approval. */
function fleetSendTurn(): ProviderEvent[] {
  return [
    {
      type: "tool_start",
      toolId: "t1",
      sdkToolUseId: "sdk-t1",
      name: "mcp__codeoid_fleet__fleet_send",
      input: { session: "x", message: "go" },
      approvalId: "approval-1",
    } as ProviderEvent,
    {
      type: "turn_done",
      result: {
        providerId: "mock",
        model: "mock-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        durationMs: 1,
      },
    } as ProviderEvent,
  ];
}

function mkConfig(dbPath: string, transcriptDir: string, transport: "expo" | "none"): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir,
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: {
      enabled: false,
      warnPct: 0.6,
      rotatePct: 0.8,
      hardRotatePct: 0.9,
      minTurnsBeforeRotate: 3,
      strategy: "task-anchor",
    },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    dispatch: {
      enabled: false,
      tickMs: 999_999,
      leaseMs: 60_000,
      failureLimit: 2,
      maxConcurrentWorkers: 2,
      workerToolBudget: 7,
      retryBaseMs: 0,
    },
    pipeline: { enabled: false, defaultPack: null, packs: [] },
    push: { transport },
  };
}

let tmp: string;
let workdir: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let pushCalls: Array<Record<string, unknown>[]>;
let origFetch: typeof fetch;

function setup(transport: "expo" | "none") {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-push-emit-"));
  workdir = join(tmp, "repo");
  mkdirSync(workdir, { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db"), join(tmp, "transcripts"), transport),
    _testProviderFactory: () => new MockSessionProvider("mock", [fleetSendTurn()]),
  });
}

beforeEach(() => {
  pushCalls = [];
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    if (String(url).includes("exp.host")) {
      pushCalls.push(JSON.parse((init as RequestInit).body as string));
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  try {
    await manager.drain(3_000);
  } catch {
    // best-effort
  }
  try {
    await transcript.flush();
  } catch {
    // best-effort
  }
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function createAndSend(): Promise<string> {
  const created = await manager.handle(
    { type: "session.create", id: "req", name: "blocker", workdir },
    AUTH,
    CLIENT,
  );
  const sessionId = (created as { data: SessionInfo }).data.id;
  await manager.handle({ type: "session.send", id: "s1", sessionId, text: "go" }, AUTH, CLIENT);
  return sessionId;
}

describe("push emit on waiting_approval", () => {
  test("a blocked session pushes a content-blind wake-up to the owner's device", async () => {
    setup("expo");
    store.registerPush("ExponentPushToken[dev]", "ios", AUTH.sub, AUTH.accountId, AUTH.projectId);

    const sessionId = await createAndSend();
    await until(() => pushCalls.length > 0);

    const batch = pushCalls[0];
    expect(batch).toHaveLength(1);
    const msg = batch[0];
    expect(msg.to).toBe("ExponentPushToken[dev]");
    // Content-blind: the opaque session id + kind, nothing else.
    expect(msg.data).toEqual({ sessionId, kind: "approval" });
    // The tool name that triggered the block must NOT appear anywhere.
    expect(JSON.stringify(msg)).not.toContain("fleet_send");
  });

  test("no push when the owner has no registered devices", async () => {
    setup("expo");
    // No registerPush — a block should look up zero targets and send nothing.
    await createAndSend();
    // Give the turn time to reach waiting_approval, then confirm no push fired.
    await new Promise((r) => setTimeout(r, 150));
    expect(pushCalls).toHaveLength(0);
  });

  test("no push when the transport is disabled (transport: none)", async () => {
    setup("none");
    store.registerPush("ExponentPushToken[dev]", "ios", AUTH.sub, AUTH.accountId, AUTH.projectId);
    await createAndSend();
    await new Promise((r) => setTimeout(r, 150));
    expect(pushCalls).toHaveLength(0);
  });
});
