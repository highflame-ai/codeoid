/**
 * Telegram frontend — token-expiry re-check + approval ownership (GHSA-4g69).
 *
 * The Telegram control surface cached the AuthContext from /auth forever and
 * never re-checked `exp`, so a revoked/expired key kept working (creating
 * sessions, approving tool executions) until the daemon restarted. These tests
 * drive real signed JWTs through a local JWKS (real verifyToken) and assert:
 *
 *   - a fresh token authorizes commands (control)
 *   - a cached-but-expired token is refused on a command, the attachment is
 *     torn down, and the request never reaches the SessionManager
 *   - a cached-but-expired token is refused on the ⏹ Stop callback
 *   - a tool-approval tap by a different (allowlisted) user is refused
 *   - a tool-approval tap after the token expires is refused
 *
 * The ZeroID SDK's own verify rejects a past `exp`, so we auth with a token a
 * couple seconds out (valid at /auth) and let it lapse before the command —
 * exercising the STALE-cache path, which is exactly the vulnerable one.
 */

import { afterAll, afterEach, beforeAll, describe, it, expect } from "bun:test";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { TelegramFrontend } from "../frontends/telegram/index.js";
import { ZeroIdVerifier } from "../daemon/auth.js";
import type { FrontendContext } from "../frontends/types.js";
import type { AttachedClient } from "../daemon/session.js";
import type { DaemonMessage, ToolState } from "../protocol/types.js";

const USER_A = 222;
const USER_B = 333;
const CHAT_ID = 777;

// ── Local JWKS + a signer we can point at any exp ─────────────────────────────

let jwksServer: ReturnType<typeof Bun.serve>;
let keyPair: CryptoKeyPair;
let authBaseUrl: string;

function b64url(data: Uint8Array | string): string {
  return Buffer.from(data as never).toString("base64url");
}

async function signJwt(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", kid: "test-key" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "user:tester",
    name: "Tester",
    iat: now,
    account_id: "acc-1",
    project_id: "proj-1",
    scopes: ["session:attach", "session:create", "session:list", "session:interrupt", "session:approve"],
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = { keys: [{ ...pubJwk, kid: "test-key", alg: "ES256", use: "sig" }] };
  jwksServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/.well-known/jwks.json") return Response.json(jwks);
      return new Response("not found", { status: 404 });
    },
  });
  authBaseUrl = `http://localhost:${jwksServer.port}`;
});

afterAll(() => {
  jwksServer?.stop(true);
});

// ── Stubbed bot + recording fake manager ──────────────────────────────────────

const botInfo: UserFromGetMe = {
  id: 44,
  is_bot: true,
  first_name: "codeoid-expiry",
  username: "codeoid_expiry_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

interface ApiCall { method: string; payload: any }

const startedBots: Bot[] = [];
afterEach(async () => {
  while (startedBots.length > 0) await startedBots.pop()?.stop().catch(() => {});
});

function makeFakeManager() {
  const handled: any[] = [];
  const disconnected: string[] = [];
  const attachClients = new Map<string, AttachedClient>();
  const manager = {
    findByName: (name: string) => (name === "alpha" ? { id: "sess-a", name: "alpha" } : undefined),
    disconnectClient: (clientId: string) => { disconnected.push(clientId); },
    handle: async (msg: any, _auth: unknown, client: AttachedClient) => {
      handled.push(msg);
      switch (msg.type) {
        case "session.list":
          return { type: "session.list.result", sessions: [] };
        case "session.attach":
          attachClients.set(msg.sessionId, client);
          return { type: "response.ok" };
        default:
          return { type: "response.ok" };
      }
    },
    handled,
    disconnected,
    attachClients,
  };
  return manager;
}

function textUpdate(updateId: number, text: string, fromId = USER_A) {
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

function callbackUpdate(updateId: number, data: string, fromId = USER_A) {
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

function toolCallMsg(sessionId: string, messageId: string, name: string, state: ToolState): DaemonMessage {
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

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Boot a frontend + authenticate `USER_A` with a token carrying `expClaim`.
 * `approvalTtlMs` overrides the pending-approval TTL so expiry-on-tap is
 * reachable without sleeping the production hour. */
async function boot(expClaim: number, allowed = [USER_A], approvalTtlMs?: number) {
  const bot = new Bot("44:TEST_TOKEN", { botInfo });
  const calls: ApiCall[] = [];
  let nextMessageId = 1;
  bot.api.config.use(async (_prev, method, payload, signal) => {
    if (method === "getUpdates") {
      if (!signal) return { ok: true, result: [] } as any;
      return new Promise((_r, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    calls.push({ method, payload });
    return { ok: true, result: method === "sendMessage" ? { message_id: nextMessageId++ } : true } as any;
  });

  const manager = makeFakeManager();
  const fe = new TelegramFrontend("44:TEST_TOKEN", allowed, bot, approvalTtlMs !== undefined ? { approvalTtlMs } : {});
  const ctx: FrontendContext = {
    manager: manager as never,
    store: { audit() {} } as never,
    auth: { baseUrl: authBaseUrl },
    // Real ZeroID verification against the local JWKS server — the point of
    // this suite is that `verifyToken` runs for real, so the frontend gets the
    // production verifier, not a stub.
    verifier: new ZeroIdVerifier({ baseUrl: authBaseUrl }),
    httpServer: {} as never,
    host: "localhost",
    port: 0,
  };
  await fe.start(ctx);
  startedBots.push(bot);

  let updateId = 1;
  const drive = (text: string, fromId = USER_A) => bot.handleUpdate(textUpdate(updateId++, text, fromId));
  const driveCallback = (data: string, fromId = USER_A) => bot.handleUpdate(callbackUpdate(updateId++, data, fromId));
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.payload.text ?? ""));

  const jwt = await signJwt({ exp: expClaim });
  await drive(`/auth ${jwt}`);
  await until(() => texts().some((t) => t.startsWith("Authenticated as Tester")));

  return { bot, manager, calls, drive, driveCallback, texts, answers };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Telegram token expiry (GHSA-4g69)", () => {
  it("a fresh token authorizes a command (control)", async () => {
    const { drive, manager, texts } = await boot(nowSec() + 3600);
    await drive("/ls");
    await until(() => texts().some((t) => t.includes("No active sessions")));
    expect(manager.handled.some((m) => m.type === "session.list")).toBe(true);
  });

  it("refuses a command when the cached token has expired, and never reaches the manager", async () => {
    // exp ~2s out: valid at /auth + /attach, then lapses before the command.
    const { drive, manager, texts } = await boot(nowSec() + 2);
    // Attach first so the teardown assertion below is meaningful — otherwise
    // disconnectClient is recorded only because #expireAuth calls it always.
    await drive("/attach alpha");
    await until(() => manager.attachClients.has("sess-a"));
    await new Promise((r) => setTimeout(r, 3000));
    await drive("/ls");
    await until(() => texts().some((t) => t.startsWith("Session expired")));
    expect(manager.handled.some((m) => m.type === "session.list")).toBe(false);
    // The live attachment is torn down on expiry.
    expect(manager.disconnected).toContain(`telegram:${USER_A}`);
  });

  it("refuses the ⏹ Stop callback when the cached token has expired", async () => {
    const { driveCallback, manager, answers } = await boot(nowSec() + 2);
    await new Promise((r) => setTimeout(r, 3000));
    await driveCallback("stop:sess-a");
    await until(() => answers().some((t) => t.includes("Session expired")));
    expect(manager.handled.some((m) => m.type === "session.interrupt")).toBe(false);
  });

  it("refuses an approval tap from a different user than the one it was queued for", async () => {
    const { drive, driveCallback, manager, calls, answers } = await boot(nowSec() + 3600, [USER_A, USER_B]);
    await drive("/attach alpha");
    await until(() => manager.attachClients.has("sess-a"));
    const client = manager.attachClients.get("sess-a")!;
    client.send(
      toolCallMsg("sess-a", "tc1", "Write", {
        phase: "waiting_confirmation",
        input: {},
        description: "Write(/tmp/f)",
        approvalId: "deadbeef-rest",
      } as ToolState),
    );
    await until(() => calls.some((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("⚠️ Permission needed")));

    // USER_B taps USER_A's approval button.
    await driveCallback("a:deadbeef:y", USER_B);
    await until(() => answers().some((t) => t.includes("Not your approval")));
    expect(manager.handled.some((m) => m.type === "session.approve")).toBe(false);
  });

  it("refuses an approval tap after the token expires", async () => {
    // exp ~2s out: /auth + /attach + the approval broadcast all land while
    // valid; the tap happens after it lapses.
    const { drive, driveCallback, manager, calls, answers } = await boot(nowSec() + 2);
    await drive("/attach alpha");
    await until(() => manager.attachClients.has("sess-a"));
    const client = manager.attachClients.get("sess-a")!;
    client.send(
      toolCallMsg("sess-a", "tc2", "Write", {
        phase: "waiting_confirmation",
        input: {},
        description: "Write(/tmp/f)",
        approvalId: "cafef00d-rest",
      } as ToolState),
    );
    await until(() => calls.some((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("⚠️ Permission needed")));

    // Let the token lapse, then tap.
    await new Promise((r) => setTimeout(r, 3000));
    await driveCallback("a:cafef00d:y", USER_A);
    await until(() => answers().some((t) => t.includes("Session expired")));
    expect(manager.handled.some((m) => m.type === "session.approve")).toBe(false);
  });

  it("drops the user's pending approvals on expiry so a re-auth can't reuse them", async () => {
    // Register an approval while valid, let the token lapse, trigger expiry via
    // a command, then tap the old approval — it must be gone, not merely denied.
    const { drive, driveCallback, manager, calls, answers } = await boot(nowSec() + 2);
    await drive("/attach alpha");
    await until(() => manager.attachClients.has("sess-a"));
    manager.attachClients.get("sess-a")!.send(
      toolCallMsg("sess-a", "tc3", "Write", {
        phase: "waiting_confirmation",
        input: {},
        description: "Write(/tmp/f)",
        approvalId: "beadfeed-rest",
      } as ToolState),
    );
    await until(() => calls.some((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("⚠️ Permission needed")));

    await new Promise((r) => setTimeout(r, 3000));
    await drive("/ls"); // triggers #expireAuth → drops this user's approvals
    await until(() => calls.some((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("Session expired")));

    // The old approval is gone: tapping it reports "This prompt expired", not
    // "Session expired" (which would mean it was still present).
    await driveCallback("a:beadfeed:y", USER_A);
    await until(() => answers().some((t) => t.includes("This prompt expired")));
    expect(manager.handled.some((m) => m.type === "session.approve")).toBe(false);
  });

  it("enforces the approval TTL when the button is tapped (no later prompt needed)", async () => {
    // Tiny TTL so a stale approval lapses without a prune-triggering insert.
    const { drive, driveCallback, manager, calls, answers } = await boot(nowSec() + 3600, [USER_A], 40);
    await drive("/attach alpha");
    await until(() => manager.attachClients.has("sess-a"));
    manager.attachClients.get("sess-a")!.send(
      toolCallMsg("sess-a", "tc4", "Write", {
        phase: "waiting_confirmation",
        input: {},
        description: "Write(/tmp/f)",
        approvalId: "0ddba11-rest",
      } as ToolState),
    );
    await until(() => calls.some((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("⚠️ Permission needed")));

    // Auth is still valid; only the approval's own TTL lapses.
    await new Promise((r) => setTimeout(r, 300));
    await driveCallback("a:0ddba11:y", USER_A);
    await until(() => answers().some((t) => t.includes("This prompt expired")));
    expect(manager.handled.some((m) => m.type === "session.approve")).toBe(false);
  });
});
