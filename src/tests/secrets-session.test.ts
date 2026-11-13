/**
 * Secrets in what sessions store (docs/secrets-and-memory-design.md §2): a
 * secret a tool prints, a reply streams or a prompt carries never reaches the
 * transcript, the canonical history, the scrollback, memory or a share
 * bundle; a value codeoid knows is named, a detected one fingerprinted, kept
 * only where a workstream says so, and revealed only to its owner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

// Made-up credentials of the right shape, split so no contiguous token sits in this file.
const GHP = "ghp_" + "Zx9Qw3Er5Ty7Ui1Op2As4Df6Gh8Jk0Lz3Xc5V";
const KNOWN = "known-cred-" + "9f8e7d6c5b4a";

let tmp: string;
let home: string;
let store: Store;
let transcript: TranscriptStore;
let memory: MemoryEngine;
let manager: SessionManager;
let secrets: SecretService;
let script: ProviderEvent[][];

beforeAll(async () => {
  await loadShellParser();
});

beforeEach(() => {
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
    _testProviderFactory: () => new MockSessionProvider("mock", script),
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

/** Everything the session stored, as text. */
function storedText(id: string): string {
  const parts = [readFileSync(transcript.transcriptPath(id), "utf8"), readFileSync(transcript.canonicalPath(id), "utf8")];
  for (const ep of memory.store.listEpisodesForSession(id)) parts.push(ep.summary, ep.content, memory.store.getFullContent(ep.id) ?? "");
  return parts.join("\n");
}

describe("what a session stores holds no secret's value", () => {
  test("a tool's output, a streamed reply, thinking and the prompt", async () => {
    script = [
      [
        { type: "thinking_delta", content: `the token is ${GHP.slice(0, 10)}` } as ProviderEvent,
        { type: "thinking_delta", content: `${GHP.slice(10)} hmm` } as ProviderEvent,
        { type: "thinking_done" } as ProviderEvent,
        { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Read", input: { file_path: join(home, "mine", "notes.md") }, approvalId: "ap-1" } as ProviderEvent,
        { type: "tool_complete", sdkToolUseId: "sdk-t1", success: true, output: `token=${GHP}\nknown ${KNOWN}\nDB_PASSWORD=hunter2xyz` } as ProviderEvent,
        { type: "text_delta", content: `Found ${GHP.slice(0, 7)}` } as ProviderEvent,
        { type: "text_delta", content: `${GHP.slice(7)} and ${KNOWN.slice(0, 5)}` } as ProviderEvent,
        { type: "text_delta", content: `${KNOWN.slice(5)} done.` } as ProviderEvent,
        { type: "text_done", content: `Found ${GHP} and ${KNOWN} done.` } as ProviderEvent,
        done,
      ],
    ];
    const sent: string[] = [];
    const { id } = await runIn("mine");
    const text = storedText(id);
    for (const secret of [GHP, KNOWN, "hunter2xyz"]) expect(text).not.toContain(secret);
    expect(text).toContain("‹credential:gh-test›");
    expect(text).toMatch(/‹secret:github-token:[0-9a-f]{8}›/);
    // The scrollback a client replays on attach.
    const attached = (await manager.handle({ type: "session.attach", id: "a", sessionId: id } as never, AUTH, { ...CLIENT, send: (m: unknown) => sent.push(JSON.stringify(m)) })) as unknown;
    const replay = JSON.stringify(attached) + sent.join("\n");
    for (const secret of [GHP, KNOWN, "hunter2xyz"]) expect(replay).not.toContain(secret);
  });

  test("a command that prints credentials keeps no output; a credential file's write keeps no content", async () => {
    script = [
      [
        { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Bash", input: { command: "gh auth token" }, approvalId: "ap-1" } as ProviderEvent,
        { type: "tool_complete", sdkToolUseId: "sdk-t1", success: true, output: "unshaped-but-secret-1234567" } as ProviderEvent,
        { type: "tool_start", toolId: "t2", sdkToolUseId: "sdk-t2", name: "Write", input: { file_path: join(home, "mine", ".env"), content: "PLAIN=unshaped-value-987654" }, approvalId: "ap-2" } as ProviderEvent,
        { type: "tool_complete", sdkToolUseId: "sdk-t2", success: true, output: "ok" } as ProviderEvent,
        done,
      ],
    ];
    const { id } = await runIn("mine");
    const text = storedText(id);
    expect(text).not.toContain("unshaped-but-secret-1234567");
    expect(text).not.toContain("unshaped-value-987654");
    expect(text).toContain("‹output withheld: it prints credentials›");
    expect(text).toContain("‹content withheld: a credential file›");
  });
});

describe("kept secrets", () => {
  const leak = (): ProviderEvent[][] => [
    [
      { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Read", input: { file_path: "x.md" }, approvalId: "ap-1" } as ProviderEvent,
      { type: "tool_complete", sdkToolUseId: "sdk-t1", success: true, output: `token=${GHP}` } as ProviderEvent,
      done,
    ],
  ];

  test("dropped by default; kept where the workstream says vault, and revealed only to its owner's own token", async () => {
    script = leak();
    await runIn("mine");
    const none = (await manager.handle({ type: "secret.list", id: "l1" } as never, AUTH, CLIENT)) as { secrets: unknown[] };
    expect(none.secrets).toEqual([]);

    script = leak();
    await runIn("vaulted");
    const listed = (await manager.handle({ type: "secret.list", id: "l2" } as never, AUTH, CLIENT)) as { secrets: Array<{ workstream: string; fingerprint: string; kind: string }> };
    expect(listed.secrets).toHaveLength(1);
    const kept = listed.secrets[0]!;
    expect(kept).toMatchObject({ workstream: "vaulted", kind: "github-token" });

    const delegated = { ...AUTH, delegationDepth: 1 };
    expect(await manager.handle({ type: "secret.reveal", id: "r1", workstream: "vaulted", fingerprint: kept.fingerprint } as never, delegated, CLIENT)).toMatchObject({ code: "forbidden" });
    // Another workstream doesn't have it.
    expect(await manager.handle({ type: "secret.reveal", id: "r2", workstream: "mine", fingerprint: kept.fingerprint } as never, AUTH, CLIENT)).toMatchObject({ code: "not_found" });
    expect(await manager.handle({ type: "secret.reveal", id: "r3", workstream: "vaulted", fingerprint: kept.fingerprint } as never, AUTH, CLIENT)).toMatchObject({ type: "secret.reveal.result", value: GHP });
    // Another tenant doesn't either.
    const other = { ...AUTH, accountId: "acc-other" };
    expect(await manager.handle({ type: "secret.reveal", id: "r4", workstream: "vaulted", fingerprint: kept.fingerprint } as never, other, CLIENT)).toMatchObject({ code: "not_found" });
    expect(await manager.handle({ type: "secret.forget", id: "f1", workstream: "vaulted", fingerprint: kept.fingerprint } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    expect(((await manager.handle({ type: "secret.list", id: "l3" } as never, AUTH, CLIENT)) as { secrets: unknown[] }).secrets).toEqual([]);
  });
});
