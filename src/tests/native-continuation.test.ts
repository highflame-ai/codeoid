/**
 * Native continuation (#387): forks, rewinds and backend switches hand the
 * conversation to Claude and Codex in their OWN form — a fork of the
 * backend's conversation at the turn, or native history codeoid builds —
 * with the transcript seed as the fallback.
 *
 * The provider tests here run offline (a scripted SDK seam for Claude, the
 * fake codex app-server for Codex). The behaviours they encode were verified
 * against the real CLIs in the #387 spike; the live end-to-end run is in the
 * PR's Verification section.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { type CanonicalTurn, CanonicalHistoryAccumulator, fitTurnsToBudget, canonicalTurnChars } from "../daemon/providers/canonical.js";
import { ClaudeProvider, translateSDKMessage, type ClaudeNativeSdk, type TranslateState } from "../daemon/providers/claude/index.js";
import { claudeProjectDirName, toClaudeSessionEntries, type ClaudeSessionEntry } from "../daemon/providers/claude/native-history.js";
import { CodexProvider } from "../daemon/providers/codex/index.js";
import { toResponsesItems } from "../daemon/providers/codex/native-history.js";
import type { NormalizedTurnResult, ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, SessionInfo, SessionMessage } from "../protocol/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const user = (content: string): CanonicalTurn => ({ role: "user", content });
const assistant = (content: string, over: Partial<Extract<CanonicalTurn, { role: "assistant" }>> = {}): CanonicalTurn => ({
  role: "assistant",
  content,
  providerId: "claude",
  model: "claude-test",
  ...over,
});
const tool = (name: string, input: Record<string, unknown>, output: string, over: { originalName?: string; success?: boolean } = {}) => ({
  id: `t-${name}`,
  name,
  input,
  output,
  success: over.success ?? true,
  ...(over.originalName ? { originalName: over.originalName } : {}),
});

// ── Converters ───────────────────────────────────────────────────────────────

describe("canonical history as a Claude session", () => {
  const history: CanonicalTurn[] = [
    user("What's in config.yml?"),
    assistant("It sets the port to 7400.", {
      toolCalls: [tool("read_file", { file_path: "config.yml" }, "port: 7400", { originalName: "Read" })],
    }),
    user("And from codex?"),
    assistant("Codex ran ls.", { providerId: "codex", toolCalls: [tool("run_shell", { command: ["ls"] }, "a.txt", { originalName: "shell" })] }),
  ];

  it("is one chained conversation, alternating, with every tool_use answered by its tool_result", () => {
    const { entries } = toClaudeSessionEntries(history, { sessionId: "s1", cwd: "/w", maxChars: 1e6 });
    // Chained oldest first: each entry's parent is the one before it.
    entries.forEach((e, i) => expect(e.parentUuid).toBe(i === 0 ? null : entries[i - 1]!.uuid));
    expect(new Set(entries.map((e) => e.uuid)).size).toBe(entries.length);
    expect(entries.every((e) => e.sessionId === "s1" && e.cwd === "/w" && !e.isSidechain)).toBe(true);
    // user → tool_use → tool_result → text → user → tool_use → tool_result → text
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    const content = (e: ClaudeSessionEntry) => (e.message as { content: unknown }).content as Array<Record<string, unknown>>;
    const use = content(entries[1]!)[0]!;
    const result = content(entries[2]!)[0]!;
    expect(use.type).toBe("tool_use");
    expect(String(use.id)).toMatch(/^toolu_[0-9a-f]{24}$/);
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: use.id, content: "port: 7400" });
    expect(content(entries[3]!)[0]).toEqual({ type: "text", text: "It sets the port to 7400." });
  });

  it("names a tool by Claude's own name when Claude ran it, by the neutral name when another backend did", () => {
    const { entries } = toClaudeSessionEntries(history, { sessionId: "s1", cwd: "/w", maxChars: 1e6 });
    const names = entries
      .filter((e) => e.type === "assistant")
      .flatMap((e) => ((e.message as { content: Array<{ type: string; name?: string }> }).content).filter((b) => b.type === "tool_use").map((b) => b.name));
    expect(names).toEqual(["Read", "run_shell"]);
  });

  it("merges user turns that got no reply, closes an unanswered last turn, marks failed tools, and makes names API-safe", () => {
    const { entries } = toClaudeSessionEntries(
      [user("first"), user("second"), assistant("", { toolCalls: [tool("mcp.server/do it", {}, "boom", { success: false })] }), user("third")],
      { sessionId: "s", cwd: "/w", maxChars: 1e6 },
    );
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect((entries[0]!.message as { content: string }).content).toBe("first\n\nsecond");
    const use = ((entries[1]!.message as { content: Array<{ name: string }> }).content)[0]!;
    expect(use.name).toBe("mcp_server_do_it");
    expect(((entries[2]!.message as { content: Array<{ is_error?: boolean }> }).content)[0]!.is_error).toBe(true);
    expect(((entries.at(-1)!.message as { content: Array<{ text: string }> }).content)[0]!.text).toContain("ended before a reply");
  });

  it("drops the oldest turns past the budget and says so first", () => {
    const long = Array.from({ length: 10 }, (_, i) => [user(`q${i} ${"x".repeat(500)}`), assistant(`a${i} ${"y".repeat(500)}`)]).flat();
    const { entries, truncation } = toClaudeSessionEntries(long, { sessionId: "s", cwd: "/w", maxChars: 3_000 });
    expect(truncation.omittedTurns).toBeGreaterThan(0);
    expect(truncation.keptTurns + truncation.omittedTurns).toBe(20);
    expect((entries[0]!.message as { content: string }).content).toContain(`${truncation.omittedTurns} earlier turn(s)`);
    expect(entries[0]!.type).toBe("user");
  });

  it("files the session where Claude Code would: every non-alphanumeric becomes '-'", () => {
    expect(claudeProjectDirName("/tmp/spikeB-zI29Li")).toBe("-tmp-spikeB-zI29Li");
    const deep = `/${"a".repeat(300)}`;
    expect(claudeProjectDirName(deep).length).toBeLessThanOrEqual(200);
  });
});

describe("canonical history as Codex items", () => {
  it("pairs each call with its output, names tools honestly, and marks failures", () => {
    const { items } = toResponsesItems(
      [
        user("list it"),
        assistant("done", { providerId: "codex", toolCalls: [tool("run_shell", { command: ["ls"] }, "a.txt", { originalName: "shell" })] }),
        assistant("read", { toolCalls: [tool("read_file", { file_path: "x" }, "denied", { originalName: "Read", success: false })] }),
      ],
      { maxChars: 1e6 },
    );
    expect(items.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output", "message", "function_call", "function_call_output", "message"]);
    const calls = items.filter((i) => i.type === "function_call") as Array<{ name: string; call_id: string; arguments: string }>;
    expect(calls.map((c) => c.name)).toEqual(["shell", "read_file"]);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ command: ["ls"] });
    const outs = items.filter((i) => i.type === "function_call_output") as Array<{ call_id: string; output: string }>;
    expect(outs.map((o) => o.call_id)).toEqual(calls.map((c) => c.call_id));
    expect(outs[1]!.output).toBe("Error: denied");
  });
});

describe("fitting history to a budget", () => {
  it("keeps the newest whole turns, and cuts the newest down when it alone is too big", () => {
    const h = [user(`old ${"o".repeat(4_000)}`), assistant("big", { toolCalls: [tool("read_file", {}, "z".repeat(50_000))] })];
    const { turns, truncation } = fitTurnsToBudget(h, 5_000, canonicalTurnChars);
    expect(truncation).toMatchObject({ omittedTurns: 1, keptTurns: 1, newestTurnSliced: true });
    expect(canonicalTurnChars(turns[0]!)).toBeLessThan(6_000);
    expect((turns[0] as { toolCalls: Array<{ output: string }> }).toolCalls[0]!.output).toContain("truncated to fit");
  });
});

// ── Where a turn ends, natively ──────────────────────────────────────────────

describe("Claude records where each turn ends in its own session", () => {
  it("is the last main-conversation entry — not a subagent's, not a replayed one", () => {
    const events: ProviderEvent[] = [];
    const state: TranslateState = { lastLocalCommandStderr: null, primaryModel: "claude-test" };
    const feed = (m: Record<string, unknown>) => translateSDKMessage(m as never, (e) => events.push(e), "claude", state);
    feed({ type: "user", uuid: "old", isReplay: true, parent_tool_use_id: null, message: { content: "replayed" } });
    feed({ type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } });
    feed({ type: "user", uuid: "u1", parent_tool_use_id: null, message: { content: [] } });
    feed({ type: "assistant", uuid: "a2", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } });
    feed({ type: "assistant", uuid: "sub", parent_tool_use_id: "toolu_x", message: { content: [{ type: "text", text: "sub" }] } });
    feed({ type: "result", subtype: "success", session_id: "backing-1", num_turns: 2, usage: {} });
    const done = events.find((e) => e.type === "turn_done") as { result: NormalizedTurnResult };
    expect(done.result.nativeRef).toEqual({ backingId: "backing-1", ref: "a2" });
    // ...and the next turn starts clean.
    feed({ type: "result", subtype: "success", session_id: "backing-1", num_turns: 1, usage: {} });
    expect((events.filter((e) => e.type === "turn_done")[1] as { result: NormalizedTurnResult }).result.nativeRef).toBeUndefined();
  });

  it("is stamped on the canonical turn, so forks and restarts can find it", () => {
    const acc = new CanonicalHistoryAccumulator();
    acc.pushUserTurn("go", "turn-1");
    acc.handleEvent({ type: "text_done", content: "ok" } as ProviderEvent);
    acc.handleEvent({
      type: "turn_done",
      result: { providerId: "claude", model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 0, nativeRef: { backingId: "b", ref: "r" } },
    });
    expect(acc.history.at(-1)).toMatchObject({ role: "assistant", native: { backingId: "b", ref: "r" } });
  });
});

// ── Claude: continueNatively ─────────────────────────────────────────────────

describe("ClaudeProvider.continueNatively", () => {
  let configDir: string;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "claude-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    rmSync(configDir, { recursive: true, force: true });
  });

  /** A seam that reads back what was written, like the SDK's own reader. */
  const sdk = (over: Partial<ClaudeNativeSdk> = {}): ClaudeNativeSdk & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      forkSession: async (id, opts) => {
        calls.push(`fork ${id} ${opts.upToMessageId}`);
        return { sessionId: "forked-1" };
      },
      getSessionMessages: async (id, opts) => {
        calls.push(`read ${id} ${opts.dir}`);
        const file = join(configDir, "projects", claudeProjectDirName(opts.dir), `${id}.jsonl`);
        return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { uuid: string });
      },
      ...over,
    };
  };
  const provider = (nativeSdk: ClaudeNativeSdk) =>
    new ClaudeProvider({ sessionId: "sess", initialBackingId: "fresh-backing", workspaceId: "ws", store: {} as never, nativeSdk });
  const history = [user("hello"), assistant("hi there")];

  it("same backend: forks Claude's own session at the turn and resumes it", async () => {
    const s = sdk();
    const p = provider(s);
    const r = await p.continueNatively({ history, forkFrom: { backingId: "parent-b", ref: "uuid-9" }, maxChars: 1e6, workdir: "/w" });
    expect(r).toEqual({ via: "fork", backingId: "forked-1" });
    expect(s.calls).toEqual(["fork parent-b uuid-9"]);
    expect(p.backingSessionId).toBe("forked-1");
    expect(p.hasQueried).toBe(true); // resume, not create
  });

  it("when the fork source is gone, builds the session from history instead — and verifies it with the SDK's reader", async () => {
    const s = sdk({ forkSession: async () => Promise.reject(new Error("Session parent-b not found")) });
    const p = provider(s);
    const workdir = join(configDir, "work");
    mkdirSync(workdir);
    const r = await p.continueNatively({ history, forkFrom: { backingId: "parent-b", ref: "uuid-9" }, maxChars: 1e6, workdir });
    expect(r?.via).toBe("history");
    const file = join(configDir, "projects", claudeProjectDirName(workdir), `${r!.backingId}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
    expect(p.backingSessionId).toBe(r?.backingId as string);
    expect(p.hasQueried).toBe(true);
  });

  it("a session the SDK can't read back exactly is removed, and the transcript is used instead", async () => {
    const s = sdk({ getSessionMessages: async () => [{ uuid: "only-one" }] });
    const p = provider(s);
    const workdir = join(configDir, "work2");
    mkdirSync(workdir);
    expect(await p.continueNatively({ history, maxChars: 1e6, workdir })).toBeNull();
    const dir = join(configDir, "projects", claudeProjectDirName(workdir));
    expect(existsSync(dir) ? require("node:fs").readdirSync(dir) : []).toEqual([]);
    expect(p.backingSessionId).toBe("fresh-backing");
    expect(p.hasQueried).toBe(false);
  });
});

// ── Codex: continueNatively over the fake app-server ─────────────────────────

describe("CodexProvider.continueNatively", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex.ts");
  const saved: Array<[string, string]> = [];
  const codex = () =>
    new CodexProvider({
      sessionId: "sess-1",
      initialBackingId: "fresh-uuid",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: { setClaudeCodeSessionId: (s: string, id: string) => saved.push([s, id]) } as never,
    });
  const opts = (userMessage: string): TurnOpts => ({ history: [], userMessage, workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
  async function collect(run: TurnRun): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const e of run.events) {
      events.push(e);
      if (e.type === "turn_done" || e.type === "error") break;
    }
    return events;
  }
  const text = (events: ProviderEvent[]) => events.filter((e) => e.type === "text_done").map((e) => (e as { content: string }).content).join("");
  beforeEach(() => {
    saved.length = 0;
  });

  it("same backend: forks the thread through the turn, adopts and saves it, and anchors its turns", async () => {
    const p = codex();
    const r = await p.continueNatively({ history: [user("x"), assistant("y", { providerId: "codex" })], forkFrom: { backingId: "codex-thread-9", ref: "turn-7" }, maxChars: 1e6, workdir: "/tmp" });
    expect(r).toEqual({ via: "fork" });
    const events = await collect(p.runTurn(opts("echo-native")));
    const calls = JSON.parse(text(events)) as Array<{ method: string; params: Record<string, unknown> }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "thread/fork", params: { threadId: "codex-thread-9", lastTurnId: "turn-7", cwd: "/tmp" } });
    expect(p.backingSessionId).toBe("codex-fork-1");
    expect(saved).toEqual([["sess-1", "codex-fork-1"]]);
    const done = events.find((e) => e.type === "turn_done") as { result: NormalizedTurnResult };
    expect(done.result.nativeRef).toEqual({ backingId: "codex-fork-1", ref: "turn-1" });
    await p.teardown();
  });

  it("another backend's history goes in as native items on a fresh thread", async () => {
    const p = codex();
    const r = await p.continueNatively({
      history: [user("read it"), assistant("it says hi", { toolCalls: [tool("read_file", { file_path: "a" }, "hi", { originalName: "Read" })] })],
      maxChars: 1e6,
      workdir: "/tmp",
    });
    expect(r).toEqual({ via: "history" });
    const calls = JSON.parse(text(await collect(p.runTurn(opts("echo-native"))))) as Array<{ method: string; params: { threadId: string; items: Array<{ type: string; name?: string }> } }>;
    expect(calls.map((c) => c.method)).toEqual(["thread/inject_items"]);
    expect(calls[0]!.params.threadId).toBe("codex-thread-1");
    expect(calls[0]!.params.items.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output", "message"]);
    expect(calls[0]!.params.items[1]!.name).toBe("read_file");
    expect(saved).toEqual([["sess-1", "codex-thread-1"]]);
    await p.teardown();
  });

  it("if the native fork fails, the turn says so and carries the transcript instead", async () => {
    const p = codex();
    await p.continueNatively({ history: [user("remember PELICAN"), assistant("noted", { providerId: "codex" })], forkFrom: { backingId: "gone-thread", ref: "t" }, maxChars: 1e6, workdir: "/tmp" });
    const events = await collect(p.runTurn(opts("echo-prompt")));
    const notice = events.find((e) => e.type === "custom_message") as { content: string; metadata: { event: string } } | undefined;
    expect(notice?.metadata.event).toBe("history.native_fallback");
    expect(notice?.content).toContain("text transcript");
    expect(text(events)).toContain("<conversation-history>");
    expect(text(events)).toContain("remember PELICAN");
    expect(p.backingSessionId).toBe("codex-thread-1");
    await p.teardown();
  });
});

// ── The session picks the path ───────────────────────────────────────────────

const AUTH: AuthContext = { sub: "user:native", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc-n", projectId: "proj-n" };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };
const say = (text: string, providerId = "claude", nativeRef?: { backingId: string; ref: string }): ProviderEvent[] => [
  { type: "text_done", content: text } as ProviderEvent,
  {
    type: "turn_done",
    result: { providerId, model: "mock", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1, ...(nativeRef ? { nativeRef } : {}) },
  } as ProviderEvent,
];

describe("Session: native first, transcript as the fallback", () => {
  let tmp: string;
  let store: Store;
  let transcript: TranscriptStore;
  let managers: SessionManager[];
  let made: MockSessionProvider[];
  /** How each new provider answers continueNatively; undefined = it can't. */
  let nativeAnswer: ((req: Parameters<NonNullable<MockSessionProvider["continueNatively"]>>[0], p: MockSessionProvider) => Awaited<ReturnType<NonNullable<MockSessionProvider["continueNatively"]>>>) | undefined;

  const mkConfig = (session: Record<string, unknown> = {}): CodeoidConfig =>
    ({
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
      session,
      conductor: { enabled: false, name: "conductor", provider: "claude" },
    }) as CodeoidConfig;

  function manager(session: Record<string, unknown> = {}): SessionManager {
    const factory = (id: string) => ({
      id,
      displayName: id,
      create: () => {
        const p = new MockSessionProvider(id, [say("a1", id, { backingId: `${id}-b1`, ref: "end-1" }), say("a2", id, { backingId: `${id}-b1`, ref: "end-2" }), say("a3", id)]);
        // Like a real warm backend (claude, codex, pi), report the transcript it stashed.
        p.seedResultOverride = { text: "<conversation-history>…", totalTurns: 0, keptTurns: 0, omittedTurns: 0, newestTurnSliced: false };
        if (nativeAnswer) {
          const answer = nativeAnswer;
          p.scriptNative((req) => answer(req, p));
        }
        made.push(p);
        return p;
      },
    });
    const registry = new ProviderRegistry("claude");
    registry.register(factory("claude"));
    registry.register(factory("codex"));
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, { config: mkConfig(session), providers: registry });
    managers.push(m);
    return m;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-native-"));
    store = new Store(join(tmp, "codeoid.db"));
    transcript = new TranscriptStore(join(tmp, "transcripts"));
    managers = [];
    made = [];
    nativeAnswer = undefined;
  });
  afterEach(async () => {
    for (const m of managers) await m.drain(2_000).catch(() => {});
    await transcript.flush();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function newSession(m: SessionManager): Promise<string> {
    const r = await m.handle({ type: "session.create", id: "c", name: `n-${Math.random()}`, workdir: tmp }, AUTH, CLIENT);
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    return (r.data as { id: string }).id;
  }
  async function send(m: SessionManager, id: string, text: string): Promise<void> {
    const s = m._sessionForTest(id)!;
    await s.send(text, AUTH);
    for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
  }
  async function fork(m: SessionManager, id: string, extra: Record<string, unknown> = {}): Promise<SessionInfo> {
    const r = await m.handle({ type: "session.fork", id: "f", sessionId: id, isolate: false, ...extra } as never, AUTH, CLIENT);
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    return r.data as SessionInfo;
  }
  const notes = (m: SessionManager, id: string) => {
    const got: SessionMessage[] = [];
    m._sessionForTest(id)!.attach({ id: `w-${Math.random()}`, auth: AUTH, send: (msg) => {
      if (msg.type === "scrollback.replay") got.push(...(msg as { messages: SessionMessage[] }).messages);
    } });
    return got.filter((x) => x.role === "info").map((x) => x.content);
  };

  it("a same-backend fork forks natively from the parent's last turn, and the backend counts as holding it", async () => {
    nativeAnswer = (req) => ({ via: req.forkFrom ? "fork" : "history", backingId: "native-backing" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    await send(m, id, "two");
    const info = await fork(m, id);
    const req = made.at(-1)!.nativeRequests[0]!;
    expect(req.forkFrom).toEqual({ backingId: "claude-b1", ref: "end-2" });
    expect(req.history.map((t) => t.content)).toEqual(["one", "a1", "two", "a2"]);
    expect(store.getClaudeCodeSessionId(info.id)).toBe("native-backing");
    // It holds the conversation already, so a restart resumes it rather than re-seeding.
    await Bun.sleep(20);
    expect((JSON.parse(readFileSync(transcript.metaPath(info.id), "utf8")) as { backingFresh?: boolean }).backingFresh).toBeUndefined();
    expect(notes(m, info.id).some((n) => n.includes("continues its own conversation"))).toBe(true);
    // No transcript was stashed alongside.
    expect(made.at(-1)!.seededHistory).toBeNull();
  });

  it("a fork onto another backend asks for native history — no fork point to borrow", async () => {
    nativeAnswer = () => ({ via: "history" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const info = await fork(m, id, { providerId: "codex" });
    const req = made.at(-1)!.nativeRequests[0]!;
    expect(req.forkFrom).toBeUndefined();
    expect(notes(m, info.id).some((n) => n.includes("given to codex as its own history"))).toBe(true);
  });

  it("falls back to the transcript when the backend declines or throws, and says which way it went", async () => {
    for (const answer of [() => null, () => Promise.reject(new Error("boom"))]) {
      nativeAnswer = answer as never;
      const m = manager();
      const id = await newSession(m);
      await send(m, id, "one");
      const info = await fork(m, id);
      expect(made.at(-1)!.seededHistory?.map((t) => t.content)).toEqual(["one", "a1"]);
      expect(notes(m, info.id).some((n) => n.includes("carried as a text transcript"))).toBe(true);
    }
  });

  it("session.nativeContinuation: false keeps everything on the transcript", async () => {
    nativeAnswer = () => ({ via: "fork", backingId: "nope" });
    const m = manager({ nativeContinuation: false });
    const id = await newSession(m);
    await send(m, id, "one");
    await fork(m, id);
    expect(made.at(-1)!.nativeRequests).toEqual([]);
    expect(made.at(-1)!.seededHistory).not.toBeNull();
  });

  it("a backend switch tries native history, and a backend that builds lazily stays 'fresh' for a restart", async () => {
    nativeAnswer = () => ({ via: "history" }); // no backingId yet, like Codex
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const r = await m.handle({ type: "session.set_provider", id: "p", sessionId: id, providerId: "codex" } as never, AUTH, CLIENT);
    expect(r.type).toBe("response.ok");
    expect(made.at(-1)!.nativeRequests).toHaveLength(1);
    await Bun.sleep(20);
    const meta = JSON.parse(readFileSync(transcript.metaPath(id), "utf8")) as { backingFresh?: boolean };
    expect(meta.backingFresh).toBe(true);
  });

  it("a rewind on the same backend forks natively at the kept turn", async () => {
    nativeAnswer = (req) => (req.forkFrom ? { via: "fork", backingId: "rewound-backing" } : null);
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    await send(m, id, "two");
    const s = m._sessionForTest(id)!;
    const second = s.turnIndex[1]!.turnId;
    await s.rewind(second, { restoreFiles: false }, AUTH);
    const req = made.at(-1)!.nativeRequests.at(-1)!;
    expect(req.forkFrom).toEqual({ backingId: "claude-b1", ref: "end-1" });
    expect(store.getClaudeCodeSessionId(id)).toBe("rewound-backing");
  });
});
