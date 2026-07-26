/**
 * Telegram frontend — bot-level integration tests (offline).
 *
 * Uses the TelegramFrontend's injectable Bot seam: a real grammy Bot with a
 * pre-set botInfo (skips getMe) and an API transformer that intercepts every
 * outgoing Telegram call, so no network is touched. getUpdates is parked on a
 * never-resolving promise so long polling stays inert.
 *
 * What we verify:
 *   1. bot.catch is installed — a handler error (Telegram 400 on a reply)
 *      does NOT reject handleUpdate / stop update processing (grammy's
 *      default error handler re-throws, which kills long polling).
 *   2. The auto-retry transformer honors 429 retry_after and retries the
 *      call instead of failing it.
 *   3. formatSessionLine escapes MarkdownV2 in /ls lines (unit-level, real
 *      helper): tool_running status + workdir with `_` and backticks.
 */

import { describe, it, expect } from "bun:test";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { TelegramFrontend, isStaleBroadcast } from "../frontends/telegram/index.js";
import { ZeroIdVerifier } from "../daemon/auth.js";
import { LocalVerifier, mintLocalToken } from "../daemon/local-auth.js";
import type { FrontendContext } from "../frontends/types.js";
import type { DaemonMessage } from "../protocol/types.js";
import { formatSessionLine, escMd, escCode } from "../frontends/telegram/stream.js";

const ALLOWED_USER = 111;
const CHAT_ID = 555;

const botInfo: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: "codeoid-test",
  username: "codeoid_test_bot",
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

/**
 * Build a Bot whose API layer is fully stubbed. `respond` decides the raw
 * Telegram API response per call; getUpdates never resolves (polling parks).
 * Installed BEFORE TelegramFrontend's own transformers (auto-retry), so
 * auto-retry wraps this stub exactly like it wraps the real HTTP layer.
 */
function makeStubbedBot(
  respond: (method: string, payload: any, calls: ApiCall[]) => any,
): { bot: Bot; calls: ApiCall[] } {
  const bot = new Bot("42:TEST_TOKEN", { botInfo });
  const calls: ApiCall[] = [];
  bot.api.config.use(async (_prev, method, payload, signal) => {
    if (method === "getUpdates") {
      // The poll loop passes the pollingAbortController signal — park it and
      // reject on abort. bot.stop() additionally issues a signal-less
      // getUpdates({limit: 1}) to save the offset — answer that immediately
      // or stop() would hang forever.
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
    return respond(method, payload, calls);
  });
  return { bot, calls };
}

function fakeContext(): FrontendContext {
  return {
    manager: {} as never,
    store: { audit() {} } as never,
    auth: { baseUrl: "http://localhost:0" },
    verifier: new ZeroIdVerifier({ baseUrl: "http://localhost:0" }),
    httpServer: {} as never,
    host: "localhost",
    port: 0,
  };
}

function textUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private" as const, first_name: "u" },
      from: { id: ALLOWED_USER, is_bot: false, first_name: "u" },
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }]
        : undefined,
    },
  };
}

const OK = (method: string) =>
  ({
    ok: true,
    result: method === "sendMessage" ? { message_id: 1 } : true,
  }) as any;

describe("Telegram bot — error handling keeps polling alive", () => {
  it("a handler error (400 reply) is caught by bot.catch and does not stop update processing", async () => {
    let fail = false;
    const { bot, calls } = makeStubbedBot((method) => {
      if (method === "sendMessage" && fail) {
        fail = false;
        return {
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities",
        } as any;
      }
      return OK(method);
    });

    const fe = new TelegramFrontend("42:TEST_TOKEN", [ALLOWED_USER], bot);
    try {
      await fe.start(fakeContext());

      // /help replies with MarkdownV2; make Telegram reject it. Drive the
      // update through handleUpdates — the exact path grammy's polling loop
      // uses, where the installed error handler runs. With grammy's DEFAULT
      // handler this re-throws and long polling stops permanently.
      fail = true;
      // handleUpdates is TS-private but is the real polling entry point.
      const drive = (u: unknown) => (bot as any).handleUpdates([u]) as Promise<void>;
      await expect(drive(textUpdate(1, "/help"))).resolves.toBeUndefined();

      // The bot still processes the next update.
      const before = calls.filter((c) => c.method === "sendMessage").length;
      await drive(textUpdate(2, "/help"));
      const after = calls.filter((c) => c.method === "sendMessage").length;
      expect(after).toBe(before + 1);
    } finally {
      // Unpark the getUpdates promise so no polling handle leaks.
      await bot.stop().catch(() => {});
    }
  });
});

describe("Telegram bot — 429 auto-retry", () => {
  it("retries a flood-limited sendMessage after retry_after instead of failing it", async () => {
    let sendAttempts = 0;
    const { bot, calls } = makeStubbedBot((method) => {
      if (method === "sendMessage") {
        sendAttempts++;
        if (sendAttempts === 1) {
          return {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 0",
            parameters: { retry_after: 0 },
          } as any;
        }
      }
      return OK(method);
    });

    const fe = new TelegramFrontend("42:TEST_TOKEN", [ALLOWED_USER], bot);
    try {
      await fe.start(fakeContext());

      await bot.handleUpdate(textUpdate(1, "/help"));

      // First attempt hit 429, auto-retry re-sent it, second attempt succeeded.
      expect(sendAttempts).toBe(2);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(2);
    } finally {
      // Unpark the getUpdates promise so no polling handle leaks.
      await bot.stop().catch(() => {});
    }
  });
});

describe("/ls line rendering — MarkdownV2 escaping of runtime values", () => {
  it("escapes a tool_running status (underscore would otherwise 400 and kill polling)", () => {
    const line = formatSessionLine({
      name: "my-session",
      status: "tool_running",
      workdir: "/home/user/work",
    });
    expect(line).toContain("tool\\_running");
    expect(line).toContain("*my\\-session*");
  });

  it("escapes workdir containing _ and ` inside the code span", () => {
    const line = formatSessionLine({
      name: "s",
      status: "idle",
      workdir: "/tmp/my_dir/weird`path",
    });
    // Inside a MarkdownV2 code span only ` and \ are special: the backtick
    // must be escaped (or it terminates the span); the underscore must NOT
    // be escaped (the backslash would render literally).
    expect(line).toContain("`/tmp/my_dir/weird\\`path`");
  });

  it("status icons stay intact for idle/thinking/other", () => {
    expect(formatSessionLine({ name: "a", status: "idle", workdir: "/w" })).toStartWith("🟢");
    expect(formatSessionLine({ name: "a", status: "thinking", workdir: "/w" })).toStartWith("🟡");
    expect(formatSessionLine({ name: "a", status: "error", workdir: "/w" })).toStartWith("🔴");
  });

  it("escMd escapes every MarkdownV2 special; escCode escapes only ` and \\", () => {
    expect(escMd("a_b*c[d]e")).toBe("a\\_b\\*c\\[d\\]e");
    expect(escCode("a_b`c\\d")).toBe("a_b\\`c\\\\d");
  });
});

// ── Stale-session broadcast gating (#forwardToChat) ───────────────────────────

describe("isStaleBroadcast — drop daemon messages from unattached sessions", () => {
  const sessionMsg = (sessionId: string): DaemonMessage =>
    ({
      type: "session.message",
      sessionId,
      messageId: "m1",
      role: "assistant",
      content: "hello",
      identity: { sub: "agent:x", type: "agent" },
      timestamp: new Date().toISOString(),
    }) as DaemonMessage;

  it("keeps messages for the currently attached session", () => {
    expect(isStaleBroadcast(sessionMsg("sess-A"), "sess-A")).toBe(false);
  });

  it("drops in-flight messages from the old session after a switch", () => {
    expect(isStaleBroadcast(sessionMsg("sess-OLD"), "sess-NEW")).toBe(true);
  });

  it("drops session-scoped messages after detach (attachedSessionId null)", () => {
    expect(isStaleBroadcast(sessionMsg("sess-A"), null)).toBe(true);
  });

  it("drops a stale status_change (would otherwise flush + print Done in the new session)", () => {
    const statusMsg = {
      type: "session.status_change",
      sessionId: "sess-OLD",
      status: "idle",
    } as unknown as DaemonMessage;
    expect(isStaleBroadcast(statusMsg, "sess-NEW")).toBe(true);
  });

  it("never treats messages without a sessionId as stale", () => {
    const pong = { type: "response.ok", requestId: "r1" } as unknown as DaemonMessage;
    expect(isStaleBroadcast(pong, "sess-A")).toBe(false);
    expect(isStaleBroadcast(pong, null)).toBe(false);
  });
});

describe("Telegram frontend refuses local mode", () => {
  // Telegram is reached through Telegram's servers — a remote surface. Local
  // mode's trust model is "whoever can read a 0600 file on this machine".
  // Pairing them would let a locally-minted token stand in for a verified
  // identity over the public internet, so the frontend fail-closes rather than
  // relying on the CLI alone to decline registering it.
  it("throws on start() when the daemon has no ZeroID verifier", async () => {
    const bot = new Bot("44:TEST_TOKEN", { botInfo });
    const fe = new TelegramFrontend("44:TEST_TOKEN", [1], bot);
    const ctx = {
      ...fakeContext(),
      verifier: new LocalVerifier(mintLocalToken()),
    };
    await expect(fe.start(ctx)).rejects.toThrow(/requires ZeroID auth/);
  });

  it("still starts under a ZeroID verifier", async () => {
    const bot = new Bot("44:TEST_TOKEN", { botInfo });
    // Swallow the long-poll so start() doesn't hang the test.
    bot.api.config.use(async (_prev, method) =>
      method === "getUpdates" ? ({ ok: true, result: [] } as never) : ({ ok: true, result: true } as never),
    );
    const fe = new TelegramFrontend("44:TEST_TOKEN", [1], bot);
    await fe.start(fakeContext());
    await bot.stop().catch(() => {});
  });
});
