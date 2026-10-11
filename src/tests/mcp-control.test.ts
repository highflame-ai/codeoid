/**
 * `/mcp/control` (#251) — the outward control-plane MCP endpoint.
 *
 * The claim under test is that this endpoint adds NO authorization path of its
 * own: the bearer token goes through a TokenVerifier, and every tool runs as an
 * ordinary ClientMessage through the real SessionManager.handle — so scopes,
 * tenancy and audit are exactly what a WebSocket client gets. Hence most of
 * these tests use the real manager with a scripted mock backend (turns really
 * run), and assert parity with a direct `handle` call where it matters.
 *
 * A fake host covers what the manager can't easily stage (dispatcher-owned
 * sessions, ambiguous names, a turn that never ends), and two real daemons
 * cover the HTTP mount itself.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { CodeoidConfig, McpControlConfig } from "../config.js";
import { CONTROL_MCP_PATH, ControlMcpHttp, type ControlHost } from "../daemon/mcp/control-http.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { TokenVerifier } from "../daemon/verifier.js";
import { DaemonServer } from "../daemon/server.js";
import { mintLocalToken } from "../daemon/local-auth.js";
import { ALL_SCOPES, SCOPES, WATCHER_SCOPES } from "../protocol/scopes.js";
import { type AuthContext, type DaemonMessage, LIMITS, type SessionInfo } from "../protocol/types.js";

// ── Identities ───────────────────────────────────────────────────────────────

const OWNER: AuthContext = {
  sub: "spiffe://test/user/owner",
  scopes: [...ALL_SCOPES],
  delegationDepth: 0,
  accountId: "acc-a",
  projectId: "proj-a",
};
/** An external agent holding a delegated token: attenuated, no destroy. */
const AGENT: AuthContext = {
  sub: "spiffe://test/agent/ci-bot",
  scopes: [
    SCOPES.SESSION_LIST,
    SCOPES.SESSION_CREATE,
    SCOPES.SESSION_SEND,
    SCOPES.SESSION_WATCH,
    SCOPES.SESSION_INTERRUPT,
  ],
  delegationDepth: 1,
  delegatedBy: OWNER.sub,
  accountId: "acc-a",
  projectId: "proj-a",
};
const WATCHER: AuthContext = { ...OWNER, sub: "spiffe://test/user/watcher", scopes: [...WATCHER_SCOPES] };
const NO_SCOPES: AuthContext = { ...OWNER, sub: "spiffe://test/user/nobody", scopes: [] };
const OTHER_TENANT: AuthContext = { ...OWNER, sub: "spiffe://test/user/other", accountId: "acc-b", projectId: "proj-b" };
const EXPIRED: AuthContext = { ...OWNER, sub: "spiffe://test/user/expired", exp: 1 };

const TOKENS: Record<string, AuthContext> = {
  "tok-owner": OWNER,
  "tok-agent": AGENT,
  "tok-watcher": WATCHER,
  "tok-none": NO_SCOPES,
  "tok-other": OTHER_TENANT,
  "tok-expired": EXPIRED,
};

/** Stands in for ZeroID: a token maps to the context the issuer would mint. */
const verifier: TokenVerifier = {
  mode: "zeroid",
  verify: async (token) => {
    const ctx = TOKENS[token];
    if (!ctx) throw new Error("invalid token");
    return ctx;
  },
};

function controlConfig(over: Partial<McpControlConfig> = {}): McpControlConfig {
  return { enabled: true, allowActions: true, requireDelegated: false, allowedOrigins: [], maxWaitSeconds: 30, ...over };
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

let rpcId = 0;

async function post(
  ep: { handle(req: Request): Promise<Response> },
  body: unknown,
  opts: { token?: string; headers?: Record<string, string>; url?: string; method?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return ep.handle(
    new Request(opts.url ?? `http://127.0.0.1${CONTROL_MCP_PATH}`, {
      method: opts.method ?? "POST",
      headers,
      ...(opts.method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
}

async function rpc(ep: ControlMcpHttp, token: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await post(ep, { jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }, { token });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (json.error) throw new Error(`rpc error: ${JSON.stringify(json.error)}`);
  return json.result!;
}

interface ToolResult {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

async function call(ep: ControlMcpHttp, token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = await rpc(ep, token, "tools/call", { name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  return { isError: r.isError as boolean, text, data: (r.structuredContent as Record<string, unknown>) ?? {} };
}

async function toolNames(ep: ControlMcpHttp, token: string): Promise<string[]> {
  const r = await rpc(ep, token, "tools/list");
  return (r.tools as Array<{ name: string }>).map((t) => t.name).sort();
}

const READ_TOOLS = ["get_session", "get_usage", "list_sessions", "read_transcript", "wait_for_session"];
const ACT_TOOLS = ["create_session", "destroy_session", "interrupt_session", "send_message"];

// ── Real manager + scripted backend ──────────────────────────────────────────

function say(text: string): ProviderEvent[] {
  return [
    { type: "text_done", content: text } as ProviderEvent,
    {
      type: "turn_done",
      result: { providerId: "claude", model: "mock", inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.02, durationMs: 5 },
    } as ProviderEvent,
  ];
}

/** A turn that asks to run a shell command — parks on the owner's approval. */
const NEEDS_APPROVAL: ProviderEvent[] = [
  { type: "tool_start", toolId: "t-rm", sdkToolUseId: "sdk-rm", name: "Bash", input: { command: "rm -rf build" }, approvalId: "appr-rm" } as ProviderEvent,
];

function mkConfig(tmp: string): CodeoidConfig {
  return {
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
}

let tmp: string;
let workdir: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let audits: Array<{ sub: string; action: string; sessionId?: string; detail?: string }>;
let disconnected: string[];

function endpoint(over: Partial<McpControlConfig> = {}): ControlMcpHttp {
  return new ControlMcpHttp({
    verifier,
    config: controlConfig(over),
    host: {
      handle: (msg, auth, client) => manager.handle(msg, auth, client),
      disconnectClient: (id) => {
        disconnected.push(id);
        manager.disconnectClient(id);
      },
      audit: (sub, action, sessionId, detail) => {
        audits.push({ sub, action, sessionId, detail });
        store.audit(sub, action, sessionId, detail);
      },
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-mcpctl-"));
  workdir = join(tmp, "repo");
  mkdirSync(workdir);
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  audits = [];
  disconnected = [];
  const registry = new ProviderRegistry("claude");
  registry.register({
    id: "claude",
    displayName: "claude",
    create: () => new MockSessionProvider("claude", [say("the answer is 42"), NEEDS_APPROVAL, say("third")]),
  });
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, { config: mkConfig(tmp), providers: registry });
});

afterEach(async () => {
  await manager.drain(2_000).catch(() => {});
  await transcript.flush().catch(() => {});
  try {
    store.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

/** Create a session the way a WebSocket client would. */
async function wsCreate(auth: AuthContext, name: string): Promise<SessionInfo> {
  const res = await manager.handle({ type: "session.create", id: "c", name, workdir }, auth, { id: "ws", auth, send: () => {} });
  if (res.type !== "response.ok") throw new Error(JSON.stringify(res));
  return res.data as SessionInfo;
}

describe("transport and authentication", () => {
  it("refuses a request with no token, a bad token, or an expired one — before any tool runs", async () => {
    const ep = endpoint();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    for (const token of [undefined, "tok-forged", "tok-expired"]) {
      const res = await post(ep, body, { token });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect(audits).toEqual([]);
  });

  it("never accepts the token from the query string", async () => {
    const ep = endpoint();
    const res = await post(ep, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { url: `http://127.0.0.1${CONTROL_MCP_PATH}?token=tok-owner` });
    expect(res.status).toBe(401);
  });

  it("refuses browser origins unless allowlisted (DNS rebinding)", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "ping" };
    const denied = await post(endpoint(), body, { token: "tok-owner", headers: { Origin: "http://evil.example" } });
    expect(denied.status).toBe(403);
    const allowed = await post(endpoint({ allowedOrigins: ["http://ok.example"] }), body, {
      token: "tok-owner",
      headers: { Origin: "http://ok.example" },
    });
    expect(allowed.status).toBe(200);
  });

  it("answers GET with 405, rejects batches and malformed JSON, and acknowledges notifications with 202", async () => {
    const ep = endpoint();
    expect((await post(ep, null, { token: "tok-owner", method: "GET" })).status).toBe(405);
    expect((await post(ep, [{ jsonrpc: "2.0", id: 1, method: "ping" }], { token: "tok-owner" })).status).toBe(400);
    expect((await post(ep, "{not json", { token: "tok-owner" })).status).toBe(400);
    expect((await post(ep, { jsonrpc: "2.0", method: "notifications/initialized" }, { token: "tok-owner" })).status).toBe(202);
  });

  it("refuses an oversized body", async () => {
    const res = await post(endpoint(), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(6 * LIMITS.SEND_TEXT_MAX + 64 * 1024 + 1) }), {
      token: "tok-owner",
    });
    expect(res.status).toBe(413);
  });

  it("initialize advertises tools and tells the caller it cannot approve", async () => {
    const r = await rpc(endpoint(), "tok-owner", "initialize", { protocolVersion: "2025-06-18" });
    expect(r.protocolVersion).toBe("2025-06-18");
    expect(r.capabilities).toEqual({ tools: {} });
    expect(String(r.instructions)).toContain("cannot approve");
  });

  it("with requireDelegated, refuses a human token (audited) and accepts an agent token", async () => {
    const ep = endpoint({ requireDelegated: true });
    const human = await post(ep, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: "tok-owner" });
    expect(human.status).toBe(403);
    expect(audits).toContainEqual({ sub: OWNER.sub, action: "mcp.control.denied", sessionId: undefined, detail: "reason=not_delegated" });
    expect(await toolNames(ep, "tok-agent")).toContain("list_sessions");
  });
});

describe("the READ/SEND split", () => {
  it("observe-only by default: act tools are neither listed nor callable", async () => {
    const ep = endpoint({ allowActions: false });
    expect(await toolNames(ep, "tok-owner")).toEqual(READ_TOOLS);
    const r = await call(ep, "tok-owner", "create_session", { name: "x", workdir });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("observation only");
    expect(audits.at(-1)?.detail).toContain("outcome=error:actions_disabled");
    // And nothing was created behind the refusal.
    const list = await manager.handle({ type: "session.list", id: "l" }, OWNER, { id: "x", auth: OWNER, send: () => {} });
    expect(list.type === "session.list.result" && list.sessions.length).toBe(0);
  });

  it("lists only the tools the caller's scopes can use", async () => {
    const ep = endpoint();
    expect(await toolNames(ep, "tok-owner")).toEqual([...ACT_TOOLS, ...READ_TOOLS].sort());
    expect(await toolNames(ep, "tok-watcher")).toEqual(READ_TOOLS);
    expect(await toolNames(ep, "tok-none")).toEqual([]);
    // The agent's token carries no session:destroy — so no destroy tool.
    expect(await toolNames(ep, "tok-agent")).not.toContain("destroy_session");
  });

  it("there is no approve tool at any scope — driving a session never authorizes its tool calls", async () => {
    const r = await rpc(endpoint(), "tok-owner", "tools/list");
    const names = (r.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.some((n) => n.includes("approve"))).toBe(false);
    const call1 = await call(endpoint(), "tok-owner", "approve", { session: "x" });
    expect(call1.isError).toBe(true);
    expect(call1.text).toContain("Unknown tool");
  });
});

describe("authorization parity with the WebSocket path", () => {
  it("a scope the token lacks is refused by SessionManager itself, even if the tool is called directly", async () => {
    const s = await wsCreate(OWNER, "s1");
    const ep = endpoint();
    // Watcher holds no session:send. Calling the hidden tool anyway reaches
    // handle(), which answers exactly as it would over WebSocket.
    const viaMcp = await call(ep, "tok-watcher", "send_message", { session: s.id, text: "hi" });
    const viaWs = await manager.handle({ type: "session.send", id: "w", sessionId: s.id, text: "hi" }, WATCHER, {
      id: "ws",
      auth: WATCHER,
      send: () => {},
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaWs.type).toBe("response.error");
    if (viaWs.type === "response.error") expect(viaMcp.text).toBe(`forbidden: ${viaWs.error}`);

    // Agent token has no session:destroy.
    const destroy = await call(ep, "tok-agent", "destroy_session", { session: s.id });
    expect(destroy.isError).toBe(true);
    expect(destroy.text).toBe("forbidden: Missing scope: session:destroy");
  });

  it("another tenant's sessions are invisible and unreachable, by name or by id", async () => {
    const s = await wsCreate(OWNER, "private");
    const ep = endpoint();
    const listed = await call(ep, "tok-other", "list_sessions");
    expect(listed.data.sessions).toEqual([]);
    for (const ref of [s.id, "private"]) {
      for (const [tool, args] of [
        ["get_session", {}],
        ["read_transcript", {}],
        ["send_message", { text: "leak?" }],
        ["destroy_session", {}],
      ] as const) {
        const r = await call(ep, "tok-other", tool, { session: ref, ...args });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("not_found");
      }
    }
    // Still alive for its owner.
    expect((await call(ep, "tok-owner", "get_session", { session: s.id })).isError).toBe(false);
  });

  it("argument validation rejects unknown fields — no smuggling role/collaboration into create", async () => {
    const r = await call(endpoint(), "tok-owner", "create_session", { name: "c", workdir, role: "conductor" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invalid arguments");
  });

  it("a maximum-length prompt in multibyte text fits the body cap", async () => {
    const s = await wsCreate(OWNER, "wide");
    const r = await call(endpoint(), "tok-owner", "send_message", { session: s.id, text: "é".repeat(LIMITS.SEND_TEXT_MAX) });
    expect(r.isError).toBe(false);
  });

  it("protocol limits still apply: an over-long prompt is refused by the shared schema", async () => {
    const s = await wsCreate(OWNER, "big");
    const r = await call(endpoint(), "tok-owner", "send_message", { session: s.id, text: "x".repeat(LIMITS.SEND_TEXT_MAX + 1) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("invalid_request");
  });
});

describe("driving a session end to end", () => {
  it("an agent creates a session, prompts it, and gets the reply — attributed to the agent", async () => {
    const ep = endpoint();
    const created = await call(ep, "tok-agent", "create_session", { name: "ci-fix", workdir });
    expect(created.isError).toBe(false);
    const session = created.data.session as { id: string; createdBy: string; status: string };
    expect(session.createdBy).toBe(AGENT.sub);

    const sent = await call(ep, "tok-agent", "send_message", { session: "ci-fix", text: "what is the answer?", wait: true });
    expect(sent.isError).toBe(false);
    expect(sent.data.outcome).toBe("idle");
    const reply = sent.data.reply as Array<{ role: string; content: string }>;
    expect(reply.map((m) => m.content)).toEqual(["the answer is 42"]);

    // The prompt is the agent's, not the owner's.
    const page = await call(ep, "tok-agent", "read_transcript", { session: session.id, roles: ["user"] });
    const users = page.data.messages as Array<{ from: string; content: string }>;
    expect(users.at(-1)).toMatchObject({ from: AGENT.sub, content: "what is the answer?" });

    // Usage flows through.
    const usage = await call(ep, "tok-agent", "get_usage", { session: "ci-fix" });
    expect((usage.data.usage as { outputTokens?: number }).outputTokens).toBeGreaterThan(0);

    // Every call is in the durable audit log under the agent, with its delegator.
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const rows = db
      .query("SELECT subject, action, session_id, detail FROM audit_log WHERE action = 'mcp.control.call' ORDER BY id")
      .all() as Array<{ subject: string; session_id: string | null; detail: string }>;
    db.close();
    expect(rows.map((r) => r.detail.split(" ")[0])).toEqual([
      "tool=create_session",
      "tool=send_message",
      "tool=read_transcript",
      "tool=get_usage",
    ]);
    for (const r of rows) {
      expect(r.subject).toBe(AGENT.sub);
      expect(r.session_id).toBe(session.id);
      expect(r.detail).toContain(`delegatedBy=${OWNER.sub}`);
      expect(r.detail).toContain("outcome=ok");
    }
  });

  it("a turn that needs approval returns waiting_approval and names the parked tool — it cannot be approved from here", async () => {
    const s = await wsCreate(OWNER, "guarded");
    const ep = endpoint();
    await call(ep, "tok-owner", "send_message", { session: s.id, text: "first", wait: true });
    const r = await call(ep, "tok-owner", "send_message", { session: s.id, text: "clean the build", wait: true });
    expect(r.data.outcome).toBe("waiting_approval");
    const info = await call(ep, "tok-owner", "get_session", { session: s.id });
    expect(info.data.pendingApprovals).toEqual([{ approvalId: "appr-rm", tool: "Bash" }]);
    // The only way out is the owner's own approval flow — still parked.
    expect((info.data.session as { status: string }).status).toBe("waiting_approval");

    // Interrupt is an act the caller CAN take.
    const stop = await call(ep, "tok-owner", "interrupt_session", { session: s.id });
    expect(stop.isError).toBe(false);
    const after = await call(ep, "tok-owner", "wait_for_session", { session: s.id, timeoutSeconds: 5 });
    expect(after.data.outcome).toBe("idle");
  });

  it("an idempotency key delivers a retried send once", async () => {
    const s = await wsCreate(OWNER, "idem");
    const ep = endpoint();
    const a = await call(ep, "tok-owner", "send_message", { session: s.id, text: "once", idempotencyKey: "k-1" });
    const b = await call(ep, "tok-owner", "send_message", { session: s.id, text: "once", idempotencyKey: "k-1" });
    expect(a.data).toEqual({ sent: true });
    expect(b.data).toEqual({ sent: true, duplicate: true });
  });

  it("read_transcript pages newest-first with a cursor that walks back through all history", async () => {
    const s = await wsCreate(OWNER, "paged");
    const ep = endpoint();
    await call(ep, "tok-owner", "send_message", { session: s.id, text: "q1", wait: true });
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await call(ep, "tok-owner", "read_transcript", { session: s.id, maxBytes: 1024, ...(before ? { before } : {}) });
      const ids = (page.data.messages as Array<{ messageId: string }>).map((m) => m.messageId);
      seen.unshift(...ids);
      before = page.data.before as string | undefined;
      if (!page.data.hasMore) break;
      expect(before).toBe(ids[0]);
    }
    const whole = await call(ep, "tok-owner", "read_transcript", { session: s.id, maxBytes: 256 * 1024 });
    expect(seen).toEqual((whole.data.messages as Array<{ messageId: string }>).map((m) => m.messageId));
  });

  it("destroy removes the session; the transient observer client never lingers", async () => {
    const s = await wsCreate(OWNER, "gone");
    const ep = endpoint();
    expect((await call(ep, "tok-owner", "destroy_session", { session: "gone" })).data).toEqual({ destroyed: true });
    expect((await call(ep, "tok-owner", "get_session", { session: s.id })).text).toContain("not_found");
    // One disconnect per tools/call — nothing left attached.
    expect(disconnected.length).toBe(2);
  });
});

// ── Fake host: what the manager can't easily stage ──────────────────────────

function fakeEndpoint(sessions: Partial<SessionInfo>[], onHandle?: (type: string) => DaemonMessage | undefined) {
  const handled: string[] = [];
  const host: ControlHost = {
    handle: async (msg) => {
      handled.push(msg.type);
      const custom = onHandle?.(msg.type);
      if (custom) return custom;
      if (msg.type === "session.list") {
        return { type: "session.list.result", requestId: msg.id, sessions: sessions as SessionInfo[] };
      }
      return { type: "response.ok", requestId: msg.id };
    },
    disconnectClient: () => {},
    audit: () => {},
  };
  const ep = new ControlMcpHttp({ verifier, host, config: controlConfig({ maxWaitSeconds: 1 }), sleep: async () => {} });
  return { ep, handled };
}

describe("edge cases", () => {
  it("refuses to act on the conductor or a dispatcher worker, but still lets you read them", async () => {
    const { ep, handled } = fakeEndpoint([
      { id: "c1", name: "conductor", role: "conductor", status: "idle" },
      { id: "w1", name: "worker-1", role: "worker", status: "thinking" },
    ]);
    for (const ref of ["conductor", "w1"]) {
      for (const tool of ["send_message", "interrupt_session", "destroy_session"]) {
        const r = await call(ep, "tok-owner", tool, { session: ref, ...(tool === "send_message" ? { text: "go" } : {}) });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("dispatcher");
      }
    }
    expect(handled.filter((t) => t !== "session.list")).toEqual([]);
    expect((await call(ep, "tok-owner", "get_session", { session: "conductor" })).isError).toBe(false);
  });

  it("an ambiguous name asks for an id instead of guessing", async () => {
    const { ep } = fakeEndpoint([
      { id: "a", name: "dup", status: "idle" },
      { id: "b", name: "dup", status: "idle" },
    ]);
    const r = await call(ep, "tok-owner", "send_message", { session: "dup", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("pass an id: a, b");
  });

  it("an id always wins over a name", async () => {
    const { ep } = fakeEndpoint([
      { id: "x", name: "y", status: "idle" },
      { id: "y", name: "z", status: "idle" },
    ]);
    const r = await call(ep, "tok-owner", "get_session", { session: "y" });
    expect((r.data.session as { id: string }).id).toBe("y");
  });

  it("wait gives up at the timeout and says the session is still working", async () => {
    const { ep } = fakeEndpoint([{ id: "busy", name: "busy", status: "thinking" }]);
    const r = await call(ep, "tok-owner", "wait_for_session", { session: "busy", timeoutSeconds: 1 });
    expect(r.data.outcome).toBe("still_working");
  });

  it("a queued prompt counts as work even while the status still reads idle", async () => {
    const { ep } = fakeEndpoint([{ id: "q", name: "q", status: "idle", turnQueued: true }]);
    const r = await call(ep, "tok-owner", "wait_for_session", { session: "q", timeoutSeconds: 1 });
    expect(r.data.outcome).toBe("still_working");
  });

  it("a pending provider dialog counts as needing the owner", async () => {
    const { ep } = fakeEndpoint([
      { id: "d", name: "d", status: "thinking", pendingDialog: { requestId: "r", method: "confirm", title: "Run skill?" } },
    ]);
    const r = await call(ep, "tok-owner", "wait_for_session", { session: "d" });
    expect(r.data.outcome).toBe("waiting_dialog");
  });

  it("timeoutSeconds above the operator's cap is refused", async () => {
    const { ep } = fakeEndpoint([{ id: "a", name: "a", status: "idle" }]);
    const r = await call(ep, "tok-owner", "wait_for_session", { session: "a", timeoutSeconds: 5 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("timeoutSeconds");
  });

  it("an internal throw becomes an isError result, not a 500", async () => {
    const host: ControlHost = {
      handle: async () => {
        throw new Error("boom");
      },
      disconnectClient: () => {},
      audit: () => {},
    };
    const ep = new ControlMcpHttp({ verifier, host, config: controlConfig() });
    const r = await call(ep, "tok-owner", "list_sessions");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("internal: boom");
  });
});

// ── The HTTP mount on a real daemon ──────────────────────────────────────────

describe("daemon mount", () => {
  const token = mintLocalToken();
  let dir: string;
  let on: DaemonServer;
  let off: DaemonServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "codeoid-mcpctl-daemon-"));
    const boot = async (name: string, mcpControl?: McpControlConfig): Promise<DaemonServer> => {
      const d = new DaemonServer({
        port: 0,
        host: "127.0.0.1",
        dbPath: join(dir, `${name}.db`),
        transcriptDir: join(dir, `${name}-transcripts`),
        auth: { baseUrl: "http://127.0.0.1:1/unreachable-issuer" },
        localMode: { token },
        ...(mcpControl ? { mcpControl } : {}),
      });
      await d.start();
      return d;
    };
    on = await boot("on", controlConfig({ allowActions: false }));
    off = await boot("off");
  });

  afterAll(async () => {
    await on.stop();
    await off.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const hit = (d: DaemonServer, tok?: string) =>
    fetch(`http://127.0.0.1:${d.port}${CONTROL_MCP_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("is not mounted unless enabled", async () => {
    expect((await hit(off, token)).status).toBe(404);
  });

  it("authenticates with the daemon's own verifier (the local-mode token here)", async () => {
    expect((await hit(on)).status).toBe(401);
    expect((await hit(on, "not-the-token")).status).toBe(401);
    const res = await hit(on, token);
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();
    expect(names).toEqual(READ_TOOLS);
  });
});
