/**
 * Telegram frontend — authenticated end-to-end handler flows (offline).
 *
 * Extends the injectable-bot pattern of telegram-bot.test.ts with a REAL
 * auth path: an ES256 keypair generated in the test, a local Bun.serve JWKS
 * endpoint, and a properly signed JWT driven through /auth — so
 * `verifyToken` runs for real (no mocks) and every auth-gated handler
 * becomes reachable. The daemon side is a recording fake SessionManager;
 * the goal is exercising the real TelegramFrontend wiring.
 *
 * Flows covered:
 *   - /auth → /ls (escaped MarkdownV2 session lines)
 *   - /new usage + success
 *   - /attach → streamed turn broadcasts → stop button → idle flush → Done
 *   - stale-session broadcasts dropped after switch (isStaleBroadcast gate)
 *   - /attach switch: disconnect → flush buffered + ✂️ marker → settle →
 *     confirmation strictly after the flush
 *   - failed same-session re-attach restores the previous attachment
 *   - /detach: buffered content + marker delivered before the confirmation
 *   - /destroy
 *   - /search long-result plain-text chunked fallback
 *   - tool approval prompt (inline keyboard) + Approve tap → session.approve
 *   - status_change error → "❌ Error."
 */

import { afterAll, afterEach, beforeAll, describe, it, expect } from "bun:test";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { TelegramFrontend } from "../frontends/telegram/index.js";
import { ZeroIdVerifier } from "../daemon/auth.js";
import type { FrontendContext } from "../frontends/types.js";
import type { AttachedClient } from "../daemon/session.js";
import type { DaemonMessage, ToolState } from "../protocol/types.js";

const ALLOWED_USER = 222;
const CHAT_ID = 777;

// ── Local JWKS server + signed JWT (real verifyToken, no network beyond lo) ──

let jwksServer: ReturnType<typeof Bun.serve>;
let jwt: string;
let authBaseUrl: string;

function b64url(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return buf.toString("base64url");
}

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = {
    keys: [{ ...pubJwk, kid: "test-key", alg: "ES256", use: "sig" }],
  };
  jwksServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/.well-known/jwks.json") {
        return Response.json(jwks);
      }
      return new Response("not found", { status: 404 });
    },
  });
  authBaseUrl = `http://localhost:${jwksServer.port}`;

  const header = { alg: "ES256", typ: "JWT", kid: "test-key" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "user:tester",
    name: "Tester",
    iat: now,
    exp: now + 3600,
    account_id: "acc-1",
    project_id: "proj-1",
    scopes: ["session:attach"],
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;
});

afterAll(() => {
  jwksServer?.stop(true);
});

// ── Stubbed bot (same seam as telegram-bot.test.ts) ──────────────────────────

const botInfo: UserFromGetMe = {
  id: 43,
  is_bot: true,
  first_name: "codeoid-flows",
  username: "codeoid_flows_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

interface ApiCall {
  method: string;
  payload: any;
}

const startedBots: Bot[] = [];
afterEach(async () => {
  while (startedBots.length > 0) {
    await startedBots.pop()?.stop().catch(() => {});
  }
});

/** Recording fake SessionManager: two known sessions, capture attach clients. */
function makeFakeManager() {
  const sessions: Record<string, { id: string; name: string }> = {
    alpha: { id: "sess-a", name: "alpha" },
    beta: { id: "sess-b", name: "beta" },
  };
  const handled: any[] = [];
  const disconnected: string[] = [];
  const attachClients = new Map<string, AttachedClient>();
  /** Every attach client in attach order (attachClients keeps only the last per session). */
  const attachedAll: AttachedClient[] = [];
  /** Session names whose attach should fail with response.error. */
  const failAttach = new Set<string>();
  /** Message types that should fail with response.error. */
  const failTypes = new Set<string>();

  const manager = {
    findByName: (name: string) => sessions[name],
    providerIds: () => ["claude", "codex", "pi"],
    disconnectClient: (clientId: string) => {
      disconnected.push(clientId);
    },
    handle: async (msg: any, _auth: unknown, client: AttachedClient) => {
      handled.push(msg);
      if (failTypes.has(msg.type)) {
        return { type: "response.error", error: `boom:${msg.type}` };
      }
      switch (msg.type) {
        case "session.fork": {
          // Branch the parent into a new session; keep the parent's backend
          // unless the fork asked for a specific one.
          const parent = Object.values(sessions).find((s) => s.id === msg.sessionId);
          return {
            type: "session.fork.result",
            data: {
              id: "sess-fork",
              name: `${parent?.name ?? "session"} (fork)`,
              providerId: msg.providerId ?? "claude",
            },
          };
        }
        case "session.list":
          return {
            type: "session.list.result",
            sessions: [
              { name: "alpha", status: "tool_running", workdir: "/tmp/my_dir" },
              { name: "beta", status: "idle", workdir: "/w/`tick`" },
            ],
          };
        case "session.attach": {
          const failing = [...failAttach].some((n) => sessions[n]?.id === msg.sessionId);
          if (failing) return { type: "response.error", error: "attach exploded" };
          attachClients.set(msg.sessionId, client);
          attachedAll.push(client);
          return { type: "response.ok" };
        }
        case "models.list":
          return {
            type: "models.list.result",
            models: [
              { value: "claude-opus-4.8", displayName: "Claude Opus 4.8", isDefault: true },
              { value: "claude-haiku-4.5", displayName: "Claude Haiku 4.5" },
            ],
          };
        case "claude.config":
          return {
            type: "claude.config.result",
            agents: [{ name: "code-reviewer", description: "Reviews diffs" }],
            skills: [],
            mcpServers: [],
            hooks: [{ command: "scripts/pre-commit.sh --fix" }],
          };
        case "session.search":
          return {
            type: "session.search.result",
            sessions: Array.from({ length: 30 }, (_, i) => ({
              sessionName: `session-${i}-${"x".repeat(60)}`,
              matchCount: 3,
              lastMatchAt: Date.now(),
              snippets: [
                { kind: "user_turn", excerpt: "y".repeat(120) },
                { kind: "assistant_turn", excerpt: "z".repeat(120) },
              ],
            })),
          };
        default:
          return { type: "response.ok" };
      }
    },
    handled,
    disconnected,
    attachClients,
    attachedAll,
    failAttach,
    failTypes,
  };
  return manager;
}

function textUpdate(updateId: number, text: string, fromId = ALLOWED_USER) {
  return {
    update_id: updateId,
    message: {
      message_id: 10_000 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private" as const, first_name: "u" },
      from: { id: fromId, is_bot: false, first_name: "u" },
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }]
        : undefined,
    },
  };
}

function callbackUpdate(updateId: number, data: string, fromId = ALLOWED_USER) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: fromId, is_bot: false, first_name: "u" },
      message: {
        message_id: 20_000 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "private" as const, first_name: "u" },
      },
      chat_instance: "ci-1",
      data,
    },
  };
}

/** Wait for an async condition driven by the relay's promise chain. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface BootOpts {
  /** Allowlisted Telegram user ids (default just ALLOWED_USER). */
  allowed?: number[];
  /** Fail matching sends with a Telegram 400 (call is still recorded). */
  failWhen?: (method: string, payload: any) => boolean;
  /** Delay matching calls by N ms before responding (recorded at call time). */
  delayFor?: (method: string, payload: any) => number;
}

/**
 * Boot a frontend with a stubbed bot + fake manager, authenticate via /auth
 * with the real signed JWT (real verifyToken against the local JWKS).
 */
async function boot(opts: BootOpts = {}) {
  const bot = new Bot("43:TEST_TOKEN", { botInfo });
  const calls: ApiCall[] = [];
  let nextMessageId = 1;
  bot.api.config.use(async (_prev, method, payload, signal) => {
    if (method === "getUpdates") {
      if (!signal) return { ok: true, result: [] } as any;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    calls.push({ method, payload });
    // message_id is assigned in CALL order so tests can correlate a send with
    // its id even when a delayed send resolves after later ones.
    const result = method === "sendMessage" ? { message_id: nextMessageId++ } : true;
    const delay = opts.delayFor?.(method, payload) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (opts.failWhen?.(method, payload)) {
      return {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities",
      } as any;
    }
    return { ok: true, result } as any;
  });

  const manager = makeFakeManager();
  const fe = new TelegramFrontend("43:TEST_TOKEN", opts.allowed ?? [ALLOWED_USER], bot);
  const ctx: FrontendContext = {
    manager: manager as never,
    store: { audit() {} } as never,
    auth: { baseUrl: authBaseUrl },
    // Real ZeroID verification against the local JWKS server (see module doc).
    verifier: new ZeroIdVerifier({ baseUrl: authBaseUrl }),
    httpServer: {} as never,
    host: "localhost",
    port: 0,
  };
  await fe.start(ctx);
  startedBots.push(bot);

  let updateId = 1;
  const drive = (text: string, fromId = ALLOWED_USER) =>
    bot.handleUpdate(textUpdate(updateId++, text, fromId));
  const driveCallback = (data: string, fromId = ALLOWED_USER) =>
    bot.handleUpdate(callbackUpdate(updateId++, data, fromId));
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  const texts = () => sent().map((c) => String(c.payload.text));

  // Authenticate with the real signed JWT — exercises verifyToken + JWKS.
  const authAs = async (fromId: number) => {
    const before = texts().filter((t) => t.startsWith("Authenticated as Tester")).length;
    await drive(`/auth ${jwt}`, fromId);
    await until(
      () => texts().filter((t) => t.startsWith("Authenticated as Tester")).length > before,
    );
  };
  await authAs(ALLOWED_USER);

  return { bot, fe, manager, calls, drive, driveCallback, sent, texts, authAs };
}

// ── Session-scoped daemon broadcast builders ──────────────────────────────────

function assistantMsg(sessionId: string, messageId: string, content: string): DaemonMessage {
  return {
    type: "session.message",
    sessionId,
    messageId,
    role: "assistant",
    content,
    identity: { sub: "agent:x", type: "agent" },
    timestamp: new Date().toISOString(),
  } as DaemonMessage;
}

function deltaMsg(sessionId: string, messageId: string, contentAppend: string): DaemonMessage {
  return {
    type: "session.message.delta",
    sessionId,
    messageId,
    contentAppend,
    timestamp: new Date().toISOString(),
  } as DaemonMessage;
}

function toolCallMsg(
  sessionId: string,
  messageId: string,
  name: string,
  state: ToolState,
): DaemonMessage {
  return {
    type: "session.message",
    sessionId,
    messageId,
    role: "tool_call",
    content: "",
    tool: { toolId: `t-${messageId}`, name, state },
    identity: { sub: "agent:x", type: "agent" },
    timestamp: new Date().toISOString(),
  } as DaemonMessage;
}

function statusMsg(sessionId: string, status: string): DaemonMessage {
  return { type: "session.status_change", sessionId, status } as DaemonMessage;
}

/** AskUserQuestion-style approval: questions ride on `tool.input`. */
function askUserQuestionMsg(
  sessionId: string,
  messageId: string,
  approvalId: string,
  questions: unknown,
): DaemonMessage {
  return {
    type: "session.message",
    sessionId,
    messageId,
    role: "tool_call",
    content: "",
    tool: {
      toolId: `t-${messageId}`,
      name: "AskUserQuestion",
      state: {
        phase: "waiting_confirmation",
        input: { questions },
        description: "AskUserQuestion",
        approvalId,
      },
      input: { questions },
    },
    identity: { sub: "agent:x", type: "agent" },
    timestamp: new Date().toISOString(),
  } as DaemonMessage;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Telegram flows — auth and /ls", () => {
  it("authenticates via real JWT verification and renders escaped /ls lines", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/ls");
    await until(() => texts().some((t) => t.includes("alpha")));

    const ls = sent().find((c) => String(c.payload.text).includes("alpha"));
    expect(ls).toBeDefined();
    expect(ls!.payload.parse_mode).toBe("MarkdownV2");
    // Escaped runtime values: tool_running underscore, workdir backtick.
    expect(ls!.payload.text).toContain("tool\\_running");
    expect(ls!.payload.text).toContain("`/tmp/my_dir`");
    expect(ls!.payload.text).toContain("\\`tick\\`");
  });

  it("renders a read-only /settings summary (secret values never shown)", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/settings");
    await until(() => texts().some((t) => t.includes("Settings")));

    const msg = sent().find((c) => String(c.payload.text).includes("Settings"));
    expect(msg).toBeDefined();
    expect(msg!.payload.parse_mode).toBe("MarkdownV2");
    // Summary lists which secrets are set (never their values) + edit paths.
    expect(msg!.payload.text).toContain("Secrets set");
    expect(msg!.payload.text).toContain("edit:");
  });

  it("handles /new usage error and success", async () => {
    const { drive, texts, manager } = await boot();

    await drive("/new onlyname");
    await until(() => texts().some((t) => t.startsWith("Usage: /new")));

    await drive("/new gamma /tmp/gamma");
    await until(() => texts().some((t) => t.includes("created")));
    expect(manager.handled.some((m) => m.type === "session.create" && m.name === "gamma")).toBe(true);
  });
});

describe("Telegram flows — attach, streaming turn, idle", () => {
  it("attaches and relays a full streamed turn with stop button and Done", async () => {
    const { drive, manager, calls, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a");
    expect(client).toBeDefined();

    // Turn starts — stop button appears.
    client!.send(statusMsg("sess-a", "thinking"));
    await until(() => texts().some((t) => t.startsWith("⏳ Working")));
    const stopSend = calls.filter((c) => c.method === "sendMessage").findIndex((c) => String(c.payload.text).startsWith("⏳ Working"));
    expect(stopSend).toBeGreaterThanOrEqual(0);

    // Streamed assistant block, interleaved tool call, completion delta.
    client!.send(assistantMsg("sess-a", "m1", ""));
    client!.send(deltaMsg("sess-a", "m1", "Working on it. "));
    client!.send(toolCallMsg("sess-a", "tc1", "Bash", { phase: "executing" }));
    client!.send(deltaMsg("sess-a", "m1", "All done."));
    client!.send({
      type: "session.message.delta",
      sessionId: "sess-a",
      messageId: "tc1",
      toolStateUpdate: { phase: "completed", success: true },
      timestamp: new Date().toISOString(),
    } as DaemonMessage);
    client!.send(assistantMsg("sess-a", "m1", "Working on it. All done."));
    client!.send(statusMsg("sess-a", "idle"));
    await until(() => texts().includes("✅ Done."));

    // Exactly-once, in-order through the REAL frontend wiring.
    const streamTexts = texts().filter((t) =>
      ["Working on it. ", "⚡ Bash", "All done.", "✓ Bash", "✅ Done."].includes(t),
    );
    expect(streamTexts).toEqual(["Working on it. ", "⚡ Bash", "All done.", "✓ Bash", "✅ Done."]);
    // Stop button was removed when the turn ended.
    expect(calls.some((c) => c.method === "deleteMessage")).toBe(true);
  });

  it("renders ❌ on status error and drops stale-session broadcasts", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    // Broadcast from some OTHER session must be dropped by the stale gate.
    client.send(assistantMsg("sess-OLD", "mx", "ghost content"));
    client.send(statusMsg("sess-a", "error"));
    await until(() => texts().includes("❌ Error."));

    expect(texts().some((t) => t.includes("ghost content"))).toBe(false);
  });

  it("tool approval prompt renders inline keyboard and Approve tap resolves it", async () => {
    const { drive, driveCallback, manager, calls, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(
      toolCallMsg("sess-a", "tc9", "Write", {
        phase: "waiting_confirmation",
        input: {},
        description: "Write(/tmp/f)",
        approvalId: "abcd1234-rest-of-id",
      }),
    );
    await until(() => texts().some((t) => t.startsWith("⚠️ Permission needed")));
    const prompt = calls.filter((c) => c.method === "sendMessage").find((c) => String(c.payload.text).startsWith("⚠️ Permission needed"));
    expect(prompt!.payload.reply_markup).toBeDefined();

    await driveCallback("a:abcd1234:y");
    await until(() =>
      manager.handled.some(
        (m) => m.type === "session.approve" && m.approvalId === "abcd1234-rest-of-id" && m.approved === true,
      ),
    );
    expect(calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });
});

describe("Telegram flows — provider dialogs (session.ui_request)", () => {
  function uiRequest(
    sessionId: string,
    requestId: string,
    method: "select" | "confirm" | "input" | "editor",
    extra: { title?: string; options?: string[]; message?: string } = {},
  ): DaemonMessage {
    return {
      type: "session.ui_request",
      sessionId,
      requestId,
      method,
      title: extra.title ?? "Provider asks",
      ...(extra.options ? { options: extra.options } : {}),
      ...(extra.message ? { message: extra.message } : {}),
      timestamp: new Date(0).toISOString(),
    } as DaemonMessage;
  }

  it("declares the ui.dialogs capability so the daemon sends it dialogs", async () => {
    const { drive, manager, texts } = await boot();
    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;
    expect(client.capabilities).toContain("ui.dialogs");
  });

  it("select: renders option buttons and a tap sends session.ui_response {value}", async () => {
    const { drive, driveCallback, manager, calls, texts } = await boot();
    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(uiRequest("sess-a", "req12345-rest", "select", { title: "Deploy where?", options: ["staging", "prod"] }));
    await until(() => texts().some((t) => t.startsWith("❓ Deploy where?")));
    const prompt = calls.filter((c) => c.method === "sendMessage").find((c) => String(c.payload.text).startsWith("❓ Deploy where?"));
    expect(prompt!.payload.reply_markup).toBeDefined();

    await driveCallback("uireq:req12345:o1");
    await until(() =>
      manager.handled.some(
        (m) => m.type === "session.ui_response" && m.requestId === "req12345-rest" && m.value === "prod",
      ),
    );
  });

  it("confirm: Yes tap sends session.ui_response {confirmed:true}", async () => {
    const { drive, driveCallback, manager, texts } = await boot();
    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(uiRequest("sess-a", "cfm45678-x", "confirm", { title: "Proceed?" }));
    await until(() => texts().some((t) => t.startsWith("❓ Proceed?")));
    await driveCallback("uireq:cfm45678:y");
    await until(() =>
      manager.handled.some(
        (m) => m.type === "session.ui_response" && m.requestId === "cfm45678-x" && m.confirmed === true,
      ),
    );
  });

  it("input: the user's next text message answers the dialog (not sent to the session)", async () => {
    const { drive, manager, texts } = await boot();
    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(uiRequest("sess-a", "inp99999-y", "input", { title: "Your name?" }));
    await until(() => texts().some((t) => t.startsWith("❓ Your name?")));
    await drive("Ada Lovelace");
    await until(() =>
      manager.handled.some(
        (m) => m.type === "session.ui_response" && m.requestId === "inp99999-y" && m.value === "Ada Lovelace",
      ),
    );
    // It must NOT have been forwarded as a session.send.
    expect(manager.handled.some((m) => m.type === "session.send" && m.text === "Ada Lovelace")).toBe(false);
  });

  it("cancel button sends session.ui_response {cancelled:true}", async () => {
    const { drive, driveCallback, manager, texts } = await boot();
    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(uiRequest("sess-a", "cxl11111-z", "confirm", { title: "Sure?" }));
    await until(() => texts().some((t) => t.startsWith("❓ Sure?")));
    await driveCallback("uireq:cxl11111:x");
    await until(() =>
      manager.handled.some(
        (m) => m.type === "session.ui_response" && m.requestId === "cxl11111-z" && m.cancelled === true,
      ),
    );
  });
});

describe("Telegram flows — switch, failed re-attach, detach, destroy, search", () => {
  it("switching sessions flushes buffered content + marker BEFORE the attach confirmation", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    // Buffer streamed-but-unflushed content on alpha.
    client.send(assistantMsg("sess-a", "m1", ""));
    client.send(deltaMsg("sess-a", "m1", "buffered from alpha"));

    await drive("/attach beta");
    await until(() => texts().some((t) => t.includes("Attached to *beta*")));

    const all = texts();
    const iBuffered = all.indexOf("buffered from alpha");
    const iMarker = all.findIndex((t) => t.includes("✂️"));
    const iConfirm = all.findIndex((t) => t.includes("Attached to *beta*"));
    expect(iBuffered).toBeGreaterThanOrEqual(0);
    expect(iMarker).toBeGreaterThan(iBuffered);
    expect(iConfirm).toBeGreaterThan(iMarker);
    expect(manager.disconnected).toContain(`telegram:${ALLOWED_USER}`);
  });

  it("failed same-session re-attach restores the previous attachment", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    manager.failAttach.add("alpha");
    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Error: attach exploded")));

    // Still attached to alpha: live broadcasts keep flowing.
    client.send(assistantMsg("sess-a", "m2", "still attached"));
    await until(() => texts().includes("still attached"));
  });

  it("detach flushes buffered content + marker BEFORE the detach confirmation", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(assistantMsg("sess-a", "m1", ""));
    client.send(deltaMsg("sess-a", "m1", "tail before detach"));

    await drive("/detach");
    await until(() => texts().some((t) => t.startsWith("Detached from alpha")));

    const all = texts();
    const iTail = all.indexOf("tail before detach");
    const iMarker = all.findIndex((t) => t.includes("✂️"));
    const iConfirm = all.findIndex((t) => t.startsWith("Detached from alpha"));
    expect(iTail).toBeGreaterThanOrEqual(0);
    expect(iMarker).toBeGreaterThan(iTail);
    expect(iConfirm).toBeGreaterThan(iMarker);
    expect(manager.disconnected).toContain(`telegram:${ALLOWED_USER}`);

    // Post-detach broadcasts from the old session are dropped.
    client.send(assistantMsg("sess-a", "m3", "after detach ghost"));
    client.send(statusMsg("sess-a", "idle"));
    await new Promise((r) => setTimeout(r, 25));
    expect(texts().some((t) => t.includes("after detach ghost"))).toBe(false);
  });

  it("destroys a session and confirms with escaped MarkdownV2", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/destroy alpha");
    await until(() => texts().some((t) => t.includes("destroyed")));
    expect(manager.handled.some((m) => m.type === "session.destroy" && m.sessionId === "sess-a")).toBe(true);
  });

  it("falls back to plain-text chunked output for >4096-char search results", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/search needle");
    await until(() => texts().some((t) => t.includes("Search: needle")));

    // The plain-text fallback goes through the relay chunker: no parse_mode.
    const first = sent().find((c) => String(c.payload.text).includes("Search: needle"));
    expect(first!.payload.parse_mode).toBeUndefined();
    for (const c of sent()) {
      expect(String(c.payload.text).length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("Telegram flows — provider switch", () => {
  it("/provider with no arg lists the available backends (first = default)", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/provider");
    await until(() => texts().some((t) => t.includes("Backends")));

    const list = sent().find((c) => String(c.payload.text).includes("Backends"))!;
    expect(list.payload.parse_mode).toBe("MarkdownV2");
    expect(list.payload.text).toContain("claude");
    expect(list.payload.text).toContain("codex");
    expect(list.payload.text).toContain("pi");
    // First backend is tagged as the default (escaped MarkdownV2 parens).
    expect(list.payload.text).toContain("\\(default\\)");
  });

  it("/provider <id> switches the attached session's backend", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/provider codex");
    await until(() => texts().some((t) => t.includes("Backend →")));

    expect(
      manager.handled.some(
        (m) =>
          m.type === "session.set_provider" &&
          m.providerId === "codex" &&
          m.sessionId === "sess-a",
      ),
    ).toBe(true);
  });

  it("/provider without an attached session tells the user to attach", async () => {
    const { drive, texts } = await boot();

    await drive("/provider codex");
    await until(() => texts().some((t) => t.startsWith("Not attached")));

    expect(texts().some((t) => t.includes("Backend →"))).toBe(false);
  });
});

describe("Telegram flows — fork", () => {
  it("/fork branches the attached session (same backend) and auto-attaches to the branch", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/fork");
    await until(() => texts().some((t) => t.includes("Forked into")));

    // Fork frame carried NO providerId (parent's backend kept).
    const forkMsg = manager.handled.find((m) => m.type === "session.fork");
    expect(forkMsg).toBeDefined();
    expect(forkMsg.sessionId).toBe("sess-a");
    expect(forkMsg.providerId).toBeUndefined();

    // Auto-attach: parent disconnected, then the fork attached.
    expect(manager.disconnected).toContain(`telegram:${ALLOWED_USER}`);
    expect(
      manager.handled.some((m) => m.type === "session.attach" && m.sessionId === "sess-fork"),
    ).toBe(true);
  });

  it("/fork <backend> continues the branch on another backend in one step", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/fork codex");
    await until(() => texts().some((t) => t.includes("Forked into")));

    const forkMsg = manager.handled.find((m) => m.type === "session.fork");
    expect(forkMsg.providerId).toBe("codex");
    // The confirmation names the backend it continued on.
    expect(texts().some((t) => t.includes("Forked into") && t.includes("codex"))).toBe(true);
  });

  it("/fork without an attached session tells the user to attach", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/fork");
    await until(() => texts().some((t) => t.startsWith("Not attached")));

    expect(manager.handled.some((m) => m.type === "session.fork")).toBe(false);
  });

  it("/fork settles the flushed tail and removes the parent's stop button before confirming", async () => {
    // Slow down the buffered-tail send: without the settle() the "Forked
    // into" confirmation overtakes the flushed content.
    const { drive, manager, calls, texts } = await boot({
      delayFor: (m, p) =>
        m === "sendMessage" && String(p.text) === "buffered from parent" ? 30 : 0,
    });

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    // Active turn on the parent → ⏹ Stop control visible.
    client.send(statusMsg("sess-a", "thinking"));
    await until(() => texts().some((t) => t.startsWith("⏳ Working")));
    await new Promise((r) => setTimeout(r, 10)); // let stopMessageId store

    // Streamed-but-unflushed parent content.
    client.send(assistantMsg("sess-a", "m1", ""));
    client.send(deltaMsg("sess-a", "m1", "buffered from parent"));

    await drive("/fork");
    await until(() => texts().some((t) => t.includes("Forked into")));

    const all = texts();
    const iTail = all.indexOf("buffered from parent");
    const iMarker = all.findIndex((t) => t.includes("✂️"));
    const iConfirm = all.findIndex((t) => t.includes("Forked into"));
    expect(iTail).toBeGreaterThanOrEqual(0);
    expect(iMarker).toBeGreaterThan(iTail);
    expect(iConfirm).toBeGreaterThan(iMarker);

    // The parent's stop button was deleted (its idle will never arrive).
    const sends = calls.filter((c) => c.method === "sendMessage");
    const workingId = sends.findIndex((c) => String(c.payload.text).startsWith("⏳ Working")) + 1;
    expect(
      calls.some((c) => c.method === "deleteMessage" && c.payload.message_id === workingId),
    ).toBe(true);
  });
});

describe("Telegram flows — response.error surfaced on ls/interrupt/rotate/destroy", () => {
  it("/ls replies with the error instead of staying silent", async () => {
    const { drive, manager, texts } = await boot();

    manager.failTypes.add("session.list");
    await drive("/ls");
    await until(() => texts().some((t) => t === "Error: boom:session.list"));
  });

  it("/interrupt reports the error instead of claiming Interrupted", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    manager.failTypes.add("session.interrupt");
    await drive("/interrupt");
    await until(() => texts().some((t) => t === "Error: boom:session.interrupt"));
    expect(texts().some((t) => t === "Interrupted.")).toBe(false);

    // And still succeeds once the daemon recovers.
    manager.failTypes.delete("session.interrupt");
    await drive("/interrupt");
    await until(() => texts().some((t) => t === "Interrupted."));
  });

  it("/rotate reports the error instead of claiming the context rotated", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    manager.failTypes.add("session.rotate");
    await drive("/rotate");
    await until(() => texts().some((t) => t === "Error: boom:session.rotate"));
    expect(texts().some((t) => t.includes("Context rotated"))).toBe(false);

    manager.failTypes.delete("session.rotate");
    await drive("/rotate");
    await until(() => texts().some((t) => t.includes("Context rotated")));
  });

  it("/destroy reports the error, keeps the attachment, and doesn't claim destruction", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    manager.failTypes.add("session.destroy");
    await drive("/destroy alpha");
    await until(() => texts().some((t) => t === "Error: boom:session.destroy"));
    expect(texts().some((t) => t.includes("destroyed"))).toBe(false);

    // Still attached: the session wasn't destroyed, broadcasts keep flowing.
    client.send(assistantMsg("sess-a", "m9", "still alive"));
    await until(() => texts().includes("still alive"));
  });
});

describe("Telegram flows — /mode aliases and advertised strings", () => {
  it("accepts auto and a as guarded aliases (parity with core slash parsing)", async () => {
    const { drive, manager, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/mode auto");
    await until(() =>
      manager.handled.some((m) => m.type === "session.set_mode" && m.mode === "guarded"),
    );
    await drive("/mode a");
    await until(
      () =>
        manager.handled.filter((m) => m.type === "session.set_mode" && m.mode === "guarded")
          .length >= 2,
    );
    expect(texts().some((t) => t.includes("Mode → *guarded*"))).toBe(true);
  });

  it("advertises the real mode names and lists /provider + /fork in help", async () => {
    const { drive, calls, texts } = await boot();

    // The command menu registered at start() must match what the parser accepts.
    const smc = calls.find((c) => c.method === "setMyCommands");
    expect(smc).toBeDefined();
    const modeCmd = (smc!.payload.commands as { command: string; description: string }[]).find(
      (c) => c.command === "mode",
    );
    expect(modeCmd!.description).toBe("Set mode: interactive | guarded | autonomous");

    await drive("/help");
    await until(() => texts().some((t) => t.includes("Codeoid")));
    const help = texts().find((t) => t.includes("Codeoid"))!;
    expect(help).toContain("interactive|guarded|autonomous");
    expect(help).not.toContain("interactive|auto|autonomous");
    expect(help).toContain("/provider");
    expect(help).toContain("/fork");
  });
});

describe("Telegram flows — inline-code spans escape only ` and \\", () => {
  it("/model renders copy-pasteable model ids inside backticks", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/model");
    await until(() => texts().some((t) => t.includes("Models")));

    const msg = sent().find((c) => String(c.payload.text).includes("Models"))!;
    expect(msg.payload.parse_mode).toBe("MarkdownV2");
    // The id inside the code span is NOT backslash-escaped (copy-paste works)…
    expect(msg.payload.text).toContain("`claude-opus-4.8`");
    expect(msg.payload.text).not.toContain("claude\\-opus");
    // …while the display name outside the span still escapes MarkdownV2.
    expect(msg.payload.text).toContain("Claude Opus 4\\.8");
  });

  it("/who renders identity values in clean code spans", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/who");
    await until(() => texts().some((t) => t.includes("Identity")));

    const msg = sent().find((c) => String(c.payload.text).includes("Identity"))!;
    expect(msg.payload.text).toContain("`acc-1`");
    expect(msg.payload.text).toContain("`proj-1`");
    expect(msg.payload.text).not.toContain("acc\\-1");
  });

  it("/hooks renders hook commands in clean code spans", async () => {
    const { drive, sent, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));

    await drive("/hooks");
    await until(() => texts().some((t) => t.includes("Hooks")));

    const msg = sent().find((c) => String(c.payload.text).includes("Hooks"))!;
    expect(msg.payload.text).toContain("`scripts/pre-commit.sh --fix`");
    expect(msg.payload.text).not.toContain("\\-\\-fix");
  });
});

describe("Telegram flows — AskUserQuestion prompt rendering", () => {
  it("caps a runaway question at 800 chars and still renders the option keyboard", async () => {
    const { drive, driveCallback, manager, sent, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    const longQ = `Should I proceed ${"y".repeat(1200)}ENDMARKER`;
    client.send(
      askUserQuestionMsg("sess-a", "tq0", "12345678-rest", [
        { question: longQ, header: "Plan", options: [{ label: "Yes" }, { label: "No" }] },
      ]),
    );
    await until(() => texts().some((t) => t.startsWith("❓")));

    const prompt = sent().find((c) => String(c.payload.text).startsWith("❓"))!;
    expect(prompt.payload.reply_markup).toBeDefined();
    expect(prompt.payload.text).toContain("Should I proceed");
    expect(prompt.payload.text).not.toContain("ENDMARKER"); // truncated
    expect(String(prompt.payload.text).length).toBeLessThanOrEqual(900);

    // The tap still resolves the approval, keyed by the FULL question text.
    await driveCallback("q:12345678:0:0");
    await until(() => manager.handled.some((m) => m.type === "session.approve"));
    const approve = manager.handled.find((m) => m.type === "session.approve");
    expect(approve.approvalId).toBe("12345678-rest");
    expect(approve.updatedInput.answers[longQ]).toBe("Yes");
  });

  it("retries as plain text (same keyboard) when MarkdownV2 rendering 400s", async () => {
    const { drive, driveCallback, manager, sent, texts } = await boot({
      failWhen: (m, p) =>
        m === "sendMessage" &&
        p.parse_mode === "MarkdownV2" &&
        String(p.text).startsWith("❓"),
    });

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(
      askUserQuestionMsg("sess-a", "tq1", "fa11back-rest", [
        { question: "Pick one```", options: [{ label: "A" }] },
      ]),
    );
    await until(() =>
      sent().some(
        (c) => String(c.payload.text).startsWith("❓") && c.payload.parse_mode === undefined,
      ),
    );
    const plain = sent().find(
      (c) => String(c.payload.text).startsWith("❓") && c.payload.parse_mode === undefined,
    )!;
    expect(plain.payload.reply_markup).toBeDefined();

    // The approval stays actionable through the plain-text keyboard.
    await driveCallback("q:fa11back:0:0");
    await until(() => manager.handled.some((m) => m.type === "session.approve"));
  });

  it("warns visibly (with the short id + /interrupt hint) when the prompt cannot be delivered at all", async () => {
    const { drive, manager, texts } = await boot({
      failWhen: (m, p) => m === "sendMessage" && String(p.text).startsWith("❓"),
    });

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(
      askUserQuestionMsg("sess-a", "tq2", "deadfa11-rest", [
        { question: "Anyone there?", options: [{ label: "Yes" }] },
      ]),
    );
    await until(() =>
      texts().some((t) => t.startsWith("⚠️ Approval prompt failed to render")),
    );
    const warning = texts().find((t) => t.startsWith("⚠️ Approval prompt failed to render"))!;
    expect(warning).toContain("deadfa11");
    expect(warning).toContain("/interrupt");
  });
});

describe("Telegram flows — approvals fan out per user (no clobbering)", () => {
  it("two attached users can each resolve their own registration of the same approval", async () => {
    const OTHER_USER = 333;
    const { drive, driveCallback, manager, calls, texts, authAs } = await boot({
      allowed: [ALLOWED_USER, OTHER_USER],
    });
    await authAs(OTHER_USER);

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    await drive("/attach alpha", OTHER_USER);
    await until(() => texts().filter((t) => t.startsWith("Attached to")).length >= 2);
    const [cA, cB] = manager.attachedAll;
    expect(cA).toBeDefined();
    expect(cB).toBeDefined();

    // The daemon fans the same waiting_confirmation out to every client.
    const fanned = (mid: string) =>
      toolCallMsg("sess-a", mid, "Write", {
        phase: "waiting_confirmation",
        input: {},
        description: "Write(/tmp/f)",
        approvalId: "fanout12-rest",
      });
    cA!.send(fanned("tcA"));
    cB!.send(fanned("tcB"));
    await until(
      () => texts().filter((t) => t.startsWith("⚠️ Permission needed")).length >= 2,
    );

    // Pre-fix, the second registration clobbered the first: the first user's
    // tap hit "Not your approval." forever.
    await driveCallback("a:fanout12:y", ALLOWED_USER);
    await until(
      () => manager.handled.filter((m) => m.type === "session.approve").length >= 1,
    );
    await driveCallback("a:fanout12:n", OTHER_USER);
    await until(
      () => manager.handled.filter((m) => m.type === "session.approve").length >= 2,
    );

    const approves = manager.handled.filter((m) => m.type === "session.approve");
    expect(approves[0]).toMatchObject({ approvalId: "fanout12-rest", approved: true });
    expect(approves[1]).toMatchObject({ approvalId: "fanout12-rest", approved: false });
    const cbAnswers = calls
      .filter((c) => c.method === "answerCallbackQuery")
      .map((c) => String(c.payload.text ?? ""));
    expect(cbAnswers.some((t) => t.includes("Not your approval"))).toBe(false);
  });

  it("a re-broadcast of the same approval preserves already-collected answers", async () => {
    const { drive, driveCallback, manager, calls, texts } = await boot();

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    const questions = [
      { question: "Pick color", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] },
      { question: "Pick size", options: [{ label: "S" }, { label: "L" }] },
    ];
    client.send(askUserQuestionMsg("sess-a", "tq1", "beefcafe-rest", questions));
    await until(() => texts().filter((t) => t.startsWith("❓")).length >= 2);

    // Answer the first question.
    await driveCallback("q:beefcafe:0:0");
    await until(() =>
      calls.some(
        (c) => c.method === "answerCallbackQuery" && String(c.payload.text).includes("Red"),
      ),
    );

    // The daemon re-broadcasts the same waiting_confirmation (e.g. a client
    // re-attach elsewhere). Pre-fix this wiped the collected answer.
    client.send(askUserQuestionMsg("sess-a", "tq1", "beefcafe-rest", questions));
    await until(() => texts().filter((t) => t.startsWith("❓")).length >= 4);

    // Answer the second question — BOTH answers must be submitted.
    await driveCallback("q:beefcafe:1:1");
    await until(() => manager.handled.some((m) => m.type === "session.approve"));
    const approve = manager.handled.find((m) => m.type === "session.approve");
    expect(approve.approved).toBe(true);
    expect(approve.updatedInput.answers).toEqual({ "Pick color": "Red", "Pick size": "L" });
  });
});

describe("Telegram flows — stop-button race", () => {
  it("deletes an orphaned Working message when idle arrives before the send resolves", async () => {
    // The "⏳ Working…" send is slow; the turn's idle lands while it is still
    // in flight. Pre-fix the .then stored the message id afterwards, leaving
    // an orphaned Stop control that fired a spurious interrupt when tapped.
    const { drive, manager, calls, texts } = await boot({
      delayFor: (m, p) =>
        m === "sendMessage" && String(p.text).startsWith("⏳ Working") ? 30 : 0,
    });

    await drive("/attach alpha");
    await until(() => texts().some((t) => t.startsWith("Attached to")));
    const client = manager.attachClients.get("sess-a")!;

    client.send(statusMsg("sess-a", "thinking"));
    client.send(statusMsg("sess-a", "idle")); // idle beats the Working send
    await until(() => texts().includes("✅ Done."));

    // The late-resolving Working message is deleted, not stored as an orphan.
    // (Match its message_id specifically — /auth also issues a deleteMessage
    // for the message that carried the API key.)
    const workingId = () =>
      calls
        .filter((c) => c.method === "sendMessage")
        .findIndex((c) => String(c.payload.text).startsWith("⏳ Working")) + 1;
    expect(workingId()).toBeGreaterThan(0);
    await until(() =>
      calls.some((c) => c.method === "deleteMessage" && c.payload.message_id === workingId()),
    );

    // A fresh turn still gets its own Working control afterwards.
    client.send(statusMsg("sess-a", "thinking"));
    await until(
      () => texts().filter((t) => t.startsWith("⏳ Working")).length >= 2,
    );
  });
});
