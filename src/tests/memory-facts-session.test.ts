/**
 * Memory facts through a real session (docs/secrets-and-memory-design.md §3):
 * a completed tool call reaches memory with its result, its exit code, the
 * directory it ran in and how long it took; every episode carries the
 * backend and the turn's origin.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { Embedder } from "../daemon/memory/embedder.js";
import { MemoryEngine, SqliteEpisodeStore } from "../daemon/memory/index.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SecretService } from "../daemon/secrets/service.js";
import { SessionManager } from "../daemon/session-manager.js";
import { loadShellParser } from "../daemon/shell/parse.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { FolderReader } from "../daemon/workstreams/folder.js";
import { workstreamsSchema } from "../daemon/workstreams/schema.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, SessionInfo } from "../protocol/types.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(8).fill(0.35));
  }
  async close(): Promise<void> {}
}

const AUTH: AuthContext = { sub: "user:owner", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc-s", projectId: "proj-s" };
const CLIENT = { id: "client-s", auth: AUTH, send: () => {} };
const done: ProviderEvent = { type: "turn_done", result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } } as ProviderEvent;

const KNOWN = "known-cred-" + "9f8e7d6c5b4a";

let tmp: string;
let home: string;
let store: Store;
let transcript: TranscriptStore;
let memory: MemoryEngine;
let manager: SessionManager;
let secrets: SecretService;
let script: ProviderEvent[][];
let providers: MockSessionProvider[] = [];

beforeAll(async () => {
  await loadShellParser();
});

beforeEach(() => {
  providers = [];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-secrets-")));
  home = join(tmp, "home");
  for (const d of ["mine", "vaulted"]) mkdirSync(join(home, d), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  memory = new MemoryEngine({ store: new SqliteEpisodeStore(join(tmp, "mem.db")), embedder: new StubEmbedder() });
  const config = {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    workstreams: workstreamsSchema.parse({
      items: [
        { id: "mine", match: { paths: ["~/mine"] } },
        { id: "vaulted", captureSecrets: "vault", match: { paths: ["~/vaulted"] } },
      ],
    }),
  } as unknown as CodeoidConfig;
  secrets = new SecretService({ configDir: join(tmp, "config"), store });
  secrets.addKnown("test", () => [{ label: "gh-test", value: KNOWN }]);
  manager = new SessionManager(store, transcript, undefined, undefined, memory, {
    config,
    _testProviderFactory: () => {
      const p = new MockSessionProvider("mock", script);
      providers.push(p);
      return p;
    },
    _testFolderReader: new FolderReader({ home, sshConfig: "" }),
    secretService: secrets,
  });
  manager.setMemory(memory);
});

afterEach(async () => {
  try {
    await manager.drain(3000);
  } catch {}
  await transcript.flush();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function runIn(dir: string): Promise<{ id: string }> {
  const made = (await manager.handle({ type: "session.create", id: "c", name: "s", workdir: join(home, dir) } as never, AUTH, CLIENT)) as { data: SessionInfo };
  const session = manager._sessionForTest(made.data.id)!;
  let sent = false;
  const sending = session.send(`please use ${KNOWN} for this`, AUTH).finally(() => {
    sent = true;
  });
  // Approve whatever the guarded session asks (a shell command, a write) until the turn is over.
  const end = Date.now() + 3000;
  while (!sent || session.status !== "idle" || session.pendingToolApprovals().length > 0) {
    for (const p of session.pendingToolApprovals()) session.approve(p.approvalId, true, AUTH);
    if (Date.now() > end) throw new Error(`timed out (${session.status})`);
    await Bun.sleep(5);
  }
  await sending;
  await transcript.flush();
  await memory.drain();
  return { id: made.data.id };
}

describe("memory facts through a session", () => {
  test("a failed shell call is stored with its result, exit code, directory, duration, backend and origin", async () => {
    script = [
      [
        { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Bash", input: { command: "npm test" }, approvalId: "ap-1", shellCwd: join(home, "mine") } as ProviderEvent,
        { type: "tool_complete", sdkToolUseId: "sdk-t1", success: false, output: "3 tests failed\nExit code 1" } as ProviderEvent,
        { type: "text_done", content: "Three tests fail." } as ProviderEvent,
        done,
      ],
    ];
    const { id } = await runIn("mine");
    const eps = memory.store.listEpisodesForSession(id);
    const call = eps.find((e) => e.kind === "tool_call");
    expect(call?.content).toContain("3 tests failed");
    expect(call).toMatchObject({ exitCode: 1, cwd: join(home, "mine"), backend: "mock", origin: "user" });
    expect(typeof call?.durationMs).toBe("number");
    expect(eps.find((e) => e.kind === "user_turn" || e.kind === "assistant_turn")?.content).toContain("Three tests fail.");
    // And recall finds it as a failure.
    const hits = await memory.recall({ query: "anything", workspaceId: call!.workspaceId, onlyFailed: true });
    expect(hits.map((h) => h.episode.id)).toContain(call!.id);
  });
});
