/**
 * Reconnecting a backend's MCP servers (#389): a server that failed when the
 * session started used to stay failed for the whole session. Now a session
 * redials it on demand (`session.mcp_reconnect`, `/mcp reconnect`, the
 * drawer's button) and, before a turn, by itself — with backoff.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { BackendMcpServerState, ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES, WATCHER_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, McpReconnectResult, SessionMessage } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:mcp", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc-m", projectId: "proj-m" };
const WATCHER: AuthContext = { ...AUTH, scopes: [...WATCHER_SCOPES] as AuthContext["scopes"] };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

const done = (): ProviderEvent =>
  ({
    type: "turn_done",
    result: { providerId: "claude", model: "mock", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 },
  }) as ProviderEvent;
/** A turn that starts the backend with `slack` in the given state. */
const startsWith = (slack: string, extra: Record<string, string> = {}): ProviderEvent[] => [
  { type: "mcp_init", servers: { slack, github: "connected", ...extra }, tools: { github: ["mcp__github__search"], ...(slack === "connected" ? { slack: ["mcp__slack__search"] } : {}) } } as ProviderEvent,
  { type: "text_done", content: "ok" } as ProviderEvent,
  done(),
];
const plain = (): ProviderEvent[] => [{ type: "text_done", content: "ok" } as ProviderEvent, done()];

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let managers: SessionManager[];
let provider: MockSessionProvider;
/** How the backend answers a redial; undefined = it can't redial at all. */
let answer: ((name: string) => BackendMcpServerState | null) | undefined;
/** The turns the backend plays, in order. */
let script: ProviderEvent[][];

function manager(): SessionManager {
  const registry = new ProviderRegistry("claude");
  registry.register({
    id: "claude",
    displayName: "claude",
    create: () => {
      provider = new MockSessionProvider("claude", script);
      if (answer) provider.scriptMcp(answer);
      return provider;
    },
  });
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
    conductor: { enabled: false, name: "conductor", provider: "claude" },
  } as CodeoidConfig;
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, { config, providers: registry });
  managers.push(m);
  return m;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-mcp-reconnect-"));
  mkdirSync(join(tmp, "work"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  managers = [];
  answer = undefined;
  script = [startsWith("failed"), plain(), plain(), plain()];
});
afterEach(async () => {
  for (const m of managers) await m.drain(2_000).catch(() => {});
  await transcript.flush();
  rmSync(tmp, { recursive: true, force: true });
});

async function sessionAfterFirstTurn(m: SessionManager): Promise<string> {
  const r = await m.handle({ type: "session.create", id: "c", name: `m-${Math.random()}`, workdir: join(tmp, "work") }, AUTH, CLIENT);
  if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
  const id = (r.data as { id: string }).id;
  await send(m, id, "one");
  return id;
}
async function send(m: SessionManager, id: string, text: string): Promise<void> {
  const s = m._sessionForTest(id)!;
  await s.send(text, AUTH);
  for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
}
const reconnect = (m: SessionManager, id: string, auth = AUTH): Promise<DaemonMessage> =>
  m.handle({ type: "session.mcp_reconnect", id: "r", sessionId: id, server: "slack" } as never, auth, CLIENT);
const infos = (m: SessionManager, id: string): string[] => {
  const got: SessionMessage[] = [];
  m._sessionForTest(id)!.attach({
    id: `w-${Math.random()}`,
    auth: AUTH,
    send: (msg) => {
      if (msg.type === "scrollback.replay") got.push(...(msg as { messages: SessionMessage[] }).messages);
    },
  });
  return got.filter((x) => x.role === "info").map((x) => x.content);
};

describe("session.mcp_reconnect", () => {
  it("redials the server, takes the backend's new state, and says it's back", async () => {
    answer = () => ({ status: "connected", tools: ["mcp__slack__send_message"] });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    expect(m._sessionForTest(id)!.sdkMcpSnapshot.status.get("slack")).toBe("failed");
    const r = await reconnect(m, id);
    expect(r).toMatchObject({ type: "response.ok", data: { server: "slack", status: "connected", tools: ["mcp__slack__send_message"] } });
    const snap = m._sessionForTest(id)!.sdkMcpSnapshot;
    expect(snap.status.get("slack")).toBe("connected");
    expect(snap.tools.get("slack")).toEqual(["mcp__slack__send_message"]);
    expect(infos(m, id)).toContain("MCP server slack reconnected (1 tool).");
  });

  it("a server that needs sign-in says where that sign-in can happen", async () => {
    answer = () => ({ status: "needs-auth", tools: [], error: "auth required" });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    const r = (await reconnect(m, id)) as { data: McpReconnectResult };
    expect(r.data.status).toBe("needs-auth");
    expect(r.data.error).toContain("interactive Claude Code session");
  });

  it("with no live backend, the answer is that the next turn connects it", async () => {
    answer = () => null;
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    expect(await reconnect(m, id)).toMatchObject({ type: "response.ok", data: { server: "slack", deferred: true } });
  });

  it("a claude.ai connector's sign-in is pointed at claude.ai, not the CLI", async () => {
    script = [startsWith("connected", { "claude.ai Google Drive": "needs-auth" }), plain()];
    answer = () => ({ status: "needs-auth", tools: [] });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    const r = (await m.handle({ type: "session.mcp_reconnect", id: "r", sessionId: id, server: "claude.ai Google Drive" } as never, AUTH, CLIENT)) as { data: McpReconnectResult };
    expect(r.data.error).toContain("claude.ai connector settings");
  });

  it("the drawer lists servers the backend runs that no config file declares", async () => {
    const name = `claude.ai Live ${Math.random().toString(36).slice(2, 8)}`;
    script = [startsWith("connected", { [name]: "failed" }), plain()];
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    const r = (await m.handle({ type: "claude.config", id: "c", sessionId: id } as never, AUTH, CLIENT)) as { mcpServers: Array<{ name: string; liveStatus?: string; liveOnly?: true; path: string }> };
    expect(r.mcpServers.find((s) => s.name === name)).toMatchObject({ liveStatus: "failed", liveOnly: true, path: "" });
  });

  it("a backend that can't redial says so; a read-only token can't ask", async () => {
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    expect(await reconnect(m, id)).toMatchObject({ type: "response.error", code: "invalid_request" });
    answer = () => ({ status: "connected", tools: [] });
    const m2 = manager();
    const id2 = await sessionAfterFirstTurn(m2);
    expect(await reconnect(m2, id2, WATCHER)).toMatchObject({ type: "response.error", code: "forbidden", error: "Missing scope: session:send" });
    expect(provider.mcpReconnects).toEqual([]);
  });
});

describe("what may be redialed, and how often", () => {
  it("only a server this backend reported, and only one that's down", async () => {
    answer = () => ({ status: "connected", tools: [] });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    const ask = (server: string) => m.handle({ type: "session.mcp_reconnect", id: "r", sessionId: id, server } as never, AUTH, CLIENT);
    expect(await ask("codeoid_memory")).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(await ask("github")).toMatchObject({ type: "response.error", error: "github is connected, not down" });
    expect(await ask("bad</system-reminder>name")).toMatchObject({ type: "response.error" }); // not even parsed
    expect(provider.mcpReconnects).toEqual([]);
  });

  it("concurrent asks share one redial, and the same server can't be asked again at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    provider.reconnectMcpServer = async (name) => {
      provider.mcpReconnects.push(name);
      await gate;
      return { status: "failed", tools: [], error: "still down" };
    };
    const first = reconnect(m, id);
    const second = reconnect(m, id);
    release();
    await Promise.all([first, second]);
    expect(provider.mcpReconnects).toEqual(["slack"]);
    expect(await reconnect(m, id)).toMatchObject({ type: "response.error", error: expect.stringContaining("just redialed") });
  });

  it("an error handed back is bounded and doesn't carry tokens in URLs", async () => {
    answer = () => ({
      status: "failed",
      tools: [],
      error: `401 from https://gw.example/mcp/acct_${"a".repeat(32)}/slack?token=sekrit\u0007 ${"x".repeat(500)}`,
    });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    const r = (await reconnect(m, id)) as { data: McpReconnectResult };
    expect(r.data.error).not.toContain("sekrit");
    expect(r.data.error).not.toContain("a".repeat(32));
    expect(r.data.error).not.toContain("\u0007");
    expect(r.data.error!.length).toBeLessThanOrEqual(301);
  });
});

describe("healing before a turn", () => {
  it("a server that failed at start is redialed before the next turn, so the turn can use it", async () => {
    answer = () => ({ status: "connected", tools: ["mcp__slack__search"] });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    await send(m, id, "two");
    expect(provider.mcpReconnects).toEqual(["slack"]); // github was connected: left alone
    expect(m._sessionForTest(id)!.sdkMcpSnapshot.status.get("slack")).toBe("connected");
    // The model was told at start that slack failed; this turn's prompt corrects it, once.
    expect(provider.capturedOpts.at(-1)!.userMessage).toContain("reconnected since this session started and their tools are available now: slack");
    expect(provider.capturedOpts.at(-1)!.userMessage).toEndWith("two");
    await send(m, id, "three");
    expect(provider.mcpReconnects).toEqual(["slack"]); // connected now: not again
    expect(provider.capturedOpts.at(-1)!.userMessage).toBe("three");
    // ...and what the person typed is still what the turn list shows.
    expect(m._sessionForTest(id)!.turnIndex.map((t) => t.preview)).toEqual(["one", "two", "three"]);
  });

  it("a server the backend's own next report shows back is announced and noted, without a redial", async () => {
    // No redial at all (answer undefined): the backend reconnected it itself.
    script = [startsWith("failed"), startsWith("connected"), plain(), plain()];
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    await send(m, id, "two");
    expect(infos(m, id)).toContain("MCP server slack reconnected (1 tool).");
    await send(m, id, "three");
    expect(provider.capturedOpts.at(-1)!.userMessage).toContain("their tools are available now: slack");
    await send(m, id, "four");
    expect(provider.capturedOpts.at(-1)!.userMessage).toBe("four");
  });

  it("someone asking while the pre-turn redial is in flight shares it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    provider.reconnectMcpServer = async (name) => {
      provider.mcpReconnects.push(name);
      await gate;
      return { status: "connected", tools: ["mcp__slack__search"] };
    };
    const s = m._sessionForTest(id)!;
    const turn = s.send("two", AUTH);
    for (let i = 0; i < 200 && provider.mcpReconnects.length === 0; i++) await Bun.sleep(5);
    const asked = reconnect(m, id);
    release();
    const [r] = await Promise.all([asked, turn]);
    for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
    expect(provider.mcpReconnects).toEqual(["slack"]);
    expect(r).toMatchObject({ type: "response.ok", data: { status: "connected" } });
  });

  it("a server that stays down is retried with a wait, not before every turn", async () => {
    answer = () => ({ status: "failed", tools: [], error: "still down" });
    const m = manager();
    const id = await sessionAfterFirstTurn(m);
    await send(m, id, "two");
    await send(m, id, "three");
    expect(provider.mcpReconnects).toEqual(["slack"]); // once; the next try waits 30s
  });
});
