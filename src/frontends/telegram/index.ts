/**
 * Telegram frontend plugin.
 *
 * Runs inside the daemon process — talks directly to the SessionManager,
 * no WebSocket hop. Enabled when TELEGRAM_BOT_TOKEN is set.
 *
 * Commands:
 *   /auth <api_key>          Authenticate with ZeroID
 *   /ls                      List sessions
 *   /new <name> <workdir>    Create session
 *   /attach <name>           Attach (receive streaming output)
 *   /detach                  Detach from current session
 *   /interrupt               Interrupt running agent
 *   /destroy <name>          Destroy session
 *   (any text)               Send to attached session
 *   (voice)                  Transcribe and send (future)
 */

import { Bot, type Context, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { randomUUID } from "node:crypto";
import { getManifest, getSnapshot } from "../../daemon/settings/store.js";
import { ALL_SCOPES_STRING } from "../../protocol/scopes.js";
import type { Frontend, FrontendContext } from "../types.js";
import type { SessionManager } from "../../daemon/session-manager.js";
import type { AuthConfig } from "../../daemon/auth.js";
import type { TokenVerifier } from "../../daemon/verifier.js";
import type { Store } from "../../daemon/store.js";
import type {
  AuthContext,
  ClaudeConfigResultMsg,
  DaemonMessage,
  ModelsListResultMsg,
  SessionInfo,
  SessionMode,
  SessionSearchResultMsg,
  SessionUiRequestMsg,
  ToolInfo,
  UiRequestMethod,
} from "../../protocol/types.js";
import { CAPABILITIES } from "../../protocol/types.js";
import type { AttachedClient } from "../../daemon/session.js";
import {
  StreamRelay,
  escCode,
  escMd,
  formatSessionLine,
  type RelayApi,
} from "./stream.js";

/** One AskUserQuestion question as it arrives in the tool input. */
interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/**
 * A pending tool approval awaiting a button tap. Keyed by
 * `${userId}:${short}` where `short` is the approvalId's first 8 chars —
 * only `short` travels in callback_data (Telegram's 64-byte limit); the
 * userId half is rebuilt from ctx.from.id on tap. Per-user keys let the same
 * approval fan out to every attached user without one registration
 * clobbering another's. Concurrent approvals each get their own entry.
 */
interface PendingApproval {
  approvalId: string;
  sessionId: string;
  userId: number;
  chatId: number;
  /** Present for AskUserQuestion-style forms; absent for binary approvals. */
  questions?: AskQuestion[];
  /** Collected answers keyed by question text (multi-tap until complete). */
  answers: Record<string, string[]>;
  /** Unix ms when this approval was registered — used to prune stale entries. */
  createdAt: number;
}

/** Cap the pending-approval map so untapped prompts (interrupted turns, closed
 * chats) can't grow it unbounded, and evict anything older than the TTL. */
const MAX_PENDING_APPROVALS = 200;
const APPROVAL_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Capabilities the Telegram client declares to the daemon. `ui.dialogs` opts
 * this frontend into `session.ui_request` broadcasts (provider-initiated
 * dialogs from codex / pi / openai / gemini) — without it the daemon
 * silently withholds them and only Claude's approval-card questions ever show.
 */
const TELEGRAM_CAPABILITIES: readonly string[] = [CAPABILITIES.UI_DIALOGS];

/**
 * A pending provider dialog (`session.ui_request`) awaiting an answer. Keyed by
 * `${userId}:${short}` (short = requestId's first 8 chars) like approvals, so
 * the same fanned-out request never clobbers another user's entry. For
 * input/editor methods `awaitingText` is set: the user's next plain message is
 * consumed as the answer instead of being sent to the session.
 */
interface PendingUiReq {
  requestId: string;
  sessionId: string;
  method: UiRequestMethod;
  options?: string[];
  awaitingText: boolean;
  createdAt: number;
}

interface UserState {
  auth: AuthContext | null;
  attachedSessionId: string | null;
  attachedSessionName: string | null;
  clientId: string;
  /**
   * Per-user stream relay. Buffers streaming deltas (Telegram's rate limits
   * make per-token streaming infeasible) and delivers content exactly once,
   * in order — see stream.ts for the flush rules.
   */
  relay: StreamRelay;
  /**
   * message_id of the live "⏹ Stop" control shown while a turn runs, so we
   * show exactly one per turn and remove it when the turn ends. Null when no
   * turn is active.
   */
  stopMessageId: number | null;
  /**
   * Bumped whenever a turn ends (idle/error) or the attachment is torn down
   * (detach/switch/fork). The "⏳ Working…" send captures the value before
   * the API call; if it has advanced by the time the send resolves, the turn
   * is already over and the just-sent message is deleted instead of stored —
   * otherwise it lingers as an orphaned Stop control that fires a spurious
   * interrupt when tapped.
   */
  stopGeneration: number;
}

export class TelegramFrontend implements Frontend {
  readonly name = "telegram";

  #bot: Bot;
  #allowedUserIds: Set<number>;
  #manager!: SessionManager;
  #authConfig!: AuthConfig;
  #verifier!: TokenVerifier;
  #store!: Store;
  #users = new Map<number, UserState>();
  /** `${userId}:${short}` → pending approval (inline-keyboard approvals). */
  #approvals = new Map<string, PendingApproval>();

  /** `${userId}:${short}` → pending provider dialog (`session.ui_request`). */
  #uiRequests = new Map<string, PendingUiReq>();
  /** Approval time-to-live (ms); overridable so tests can exercise expiry. */
  #approvalTtlMs: number;
  /** Send surface handed to each user's StreamRelay. */
  #relayApi: RelayApi = {
    sendMessage: (chatId, text, opts) =>
      this.#bot.api.sendMessage(chatId, text, opts as never),
  };

  constructor(
    botToken: string,
    allowedUserIds: number[],
    bot?: Bot,
    opts: { approvalTtlMs?: number } = {},
  ) {
    // `bot` is injectable for tests (a Bot with a stubbed API transformer).
    this.#bot = bot ?? new Bot(botToken);
    // Honor Telegram 429s: wait for retry_after and retry instead of letting
    // the flood error be swallowed by the `.catch(() => {})` on each send.
    this.#bot.api.config.use(autoRetry());
    this.#allowedUserIds = new Set(allowedUserIds);
    this.#approvalTtlMs = opts.approvalTtlMs ?? APPROVAL_TTL_MS;
  }

  async start(ctx: FrontendContext): Promise<void> {
    this.#manager = ctx.manager;
    this.#authConfig = ctx.auth;
    this.#verifier = ctx.verifier;
    this.#store = ctx.store;
    // Telegram is a REMOTE surface reached through Telegram's servers; local
    // mode's trust model is "whoever can read a 0600 file on this machine".
    // Pairing them would let a locally-minted token, or a bot-allowlist entry,
    // stand in for a verified identity over the public internet. The CLI
    // already declines to register this frontend under --local; this is the
    // fail-closed backstop for any other embedder.
    if (ctx.verifier.mode !== "zeroid") {
      throw new Error(
        "the Telegram frontend requires ZeroID auth — it is not available in local mode " +
          "(run `codeoid login`, then start without --local)",
      );
    }
    this.#setupHandlers();
    // Register the command menu so Telegram shows a tappable "/" list with
    // descriptions (autocomplete) instead of making the user remember+type.
    this.#bot.api
      .setMyCommands([
        { command: "ls", description: "List sessions" },
        { command: "new", description: "Create a session: /new <name> <dir>" },
        { command: "attach", description: "Attach to a session: /attach <name>" },
        { command: "detach", description: "Detach from the current session" },
        { command: "interrupt", description: "Stop the current turn" },
        { command: "mode", description: "Set mode: interactive | guarded | autonomous" },
        { command: "model", description: "Show or switch the model" },
        { command: "provider", description: "Show or switch the backend: /provider <id>" },
        { command: "fork", description: "Branch this session: /fork [backend]" },
        { command: "rotate", description: "Fresh context (memory kept)" },
        { command: "rename", description: "Rename the attached session" },
        { command: "search", description: "Search across sessions" },
        { command: "agents", description: "Subagents available" },
        { command: "skills", description: "Skills available" },
        { command: "mcp", description: "MCP servers" },
        { command: "hooks", description: "Configured hooks" },
        { command: "who", description: "Show your identity" },
        { command: "settings", description: "Show current settings (read-only)" },
        { command: "destroy", description: "Destroy a session: /destroy <name>" },
        { command: "auth", description: "Authenticate: /auth <api_key>" },
        { command: "help", description: "Show help" },
      ])
      .catch(() => {});
    // Don't await — long-polling runs forever
    this.#bot.start().catch((err) => {
      console.error("[codeoid:telegram] bot crashed:", err);
    });
  }

  async stop(): Promise<void> {
    this.#bot.stop();
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  #setupHandlers(): void {
    // Never let a thrown handler error kill long polling — grammy's default
    // error handler re-throws, which permanently stops the bot. Log and keep
    // processing updates.
    this.#bot.catch((err) => {
      console.error("[codeoid:telegram] handler error:", err.error ?? err);
    });

    // Gate: only allowed Telegram user IDs
    this.#bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.#allowedUserIds.has(userId)) {
        await ctx.reply("Unauthorized.");
        return;
      }
      await next();
    });

    this.#bot.command("start", (ctx) => this.#handleHelp(ctx));
    this.#bot.command("help", (ctx) => this.#handleHelp(ctx));

    this.#bot.command("auth", (ctx) => this.#handleAuth(ctx));
    this.#bot.command("ls", (ctx) => this.#handleList(ctx));
    this.#bot.command("new", (ctx) => this.#handleNew(ctx));
    this.#bot.command("attach", (ctx) => this.#handleAttach(ctx));
    this.#bot.command("detach", (ctx) => this.#handleDetach(ctx));
    this.#bot.command("interrupt", (ctx) => this.#handleInterrupt(ctx));
    this.#bot.command("destroy", (ctx) => this.#handleDestroy(ctx));
    this.#bot.command("search", (ctx) => this.#handleSearch(ctx));
    this.#bot.command("rename", (ctx) => this.#handleRename(ctx));
    this.#bot.command("rotate", (ctx) => this.#handleRotate(ctx));
    this.#bot.command("mode", (ctx) => this.#handleMode(ctx));
    this.#bot.command("model", (ctx) => this.#handleModel(ctx));
    this.#bot.command("provider", (ctx) => this.#handleProvider(ctx));
    this.#bot.command("fork", (ctx) => this.#handleFork(ctx));
    this.#bot.command("who", (ctx) => this.#handleWho(ctx));
    this.#bot.command("settings", (ctx) => this.#handleSettings(ctx));
    // Capabilities discovery — mirror the web /agents /skills /mcp /hooks.
    this.#bot.command("agents", (ctx) => this.#handleCapabilities(ctx, "agents"));
    this.#bot.command("skills", (ctx) => this.#handleCapabilities(ctx, "skills"));
    this.#bot.command("mcp", (ctx) => this.#handleCapabilities(ctx, "mcp"));
    this.#bot.command("hooks", (ctx) => this.#handleCapabilities(ctx, "hooks"));

    // Inline-keyboard taps (tool approvals + AskUserQuestion answers).
    this.#bot.on("callback_query:data", (ctx) => this.#handleCallback(ctx));

    this.#bot.on("message:voice", (ctx) => this.#handleVoice(ctx));
    this.#bot.on("message:text", (ctx) => this.#handleText(ctx));
  }

  async #handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      "🔮 *Codeoid* — control your AI agents from here\\.\n\n" +
        "*Sessions*\n" +
        "/ls — list · /new `<name>` `<dir>` — create\n" +
        "/attach `<name>` · /detach · /destroy `<name>`\n" +
        "/rename `<name>` · /search `<query>`\n\n" +
        "*Run control*\n" +
        "/interrupt — stop the current turn\n" +
        "/rotate — fresh context, memory kept\n" +
        "/mode `<interactive|guarded|autonomous>`\n" +
        "/model `[name]` — show/switch model\n" +
        "/provider `[id]` — show/switch backend\n" +
        "/fork `[backend]` — branch this session\n\n" +
        "*Discover*\n" +
        "/agents · /skills · /mcp · /hooks · /who\n\n" +
        "Send text to talk to the attached session\\. Tool approvals show\n" +
        "*Approve*/*Deny* buttons\\.",
      { parse_mode: "MarkdownV2" },
    );
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  async #handleAuth(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const apiKey = ctx.message?.text?.split(/\s+/)[1];

    if (!apiKey) {
      await ctx.reply("Usage: /auth <zid_sk_...>");
      return;
    }

    // Delete message containing the API key
    try { await ctx.deleteMessage(); } catch { /* may lack permission */ }

    try {
      let token = apiKey;
      if (apiKey.startsWith("zid_sk_")) {
        const zeroidUrl = this.#authConfig.baseUrl;
        const resp = await fetch(`${zeroidUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "api_key", api_key: apiKey, scope: ALL_SCOPES_STRING }),
        });
        if (!resp.ok) {
          await ctx.reply("Authentication failed. Check your API key.");
          return;
        }
        token = ((await resp.json()) as { access_token: string }).access_token;
      }

      const auth = await this.#verifier.verify(token);
      const state = this.#getOrCreate(userId);
      state.auth = auth;

      // Persist the Telegram-id ↔ ZeroID-subject mapping. The allowlist is
      // env-only and in-memory, so without this there's no durable record of
      // which Telegram user authenticated as which subject — making it
      // unrecoverable after a restart. Audited so it's queryable later.
      this.#store.audit(
        auth.sub,
        "telegram.auth",
        undefined,
        `telegram_user_id=${userId}${auth.name ? ` name=${auth.name}` : ""}`,
      );

      await ctx.reply(`Authenticated as ${auth.name ?? auth.sub}. Use /ls to see sessions.`);
    } catch (err) {
      await ctx.reply(`Auth error: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  // ── Session commands (direct to SessionManager, no network) ───────────

  async #handleList(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const resp = await this.#manager.handle(
      { type: "session.list", id: randomUUID() },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    if (resp.type === "session.list.result") {
      if (resp.sessions.length === 0) {
        await ctx.reply("No active sessions.");
        return;
      }
      // Status and workdir are escaped — a `tool_running` underscore or a
      // path with markdown specials must not 400 the reply.
      const lines = resp.sessions.map((s) => formatSessionLine(s));
      await ctx.reply(lines.join("\n\n"), { parse_mode: "MarkdownV2" });
    } else if (resp.type === "response.error") {
      // Never fail silently — a scope/tenancy error would otherwise render
      // as the bot simply not answering.
      await ctx.reply(`Error: ${resp.error}`);
    }
  }

  async #handleNew(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const parts = ctx.message?.text?.split(/\s+/) ?? [];
    const name = parts[1];
    const workdir = parts[2];
    if (!name || !workdir) {
      await ctx.reply("Usage: /new <name> <workdir>");
      return;
    }

    const resp = await this.#manager.handle(
      { type: "session.create", id: randomUUID(), name, workdir },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    if (resp.type === "response.ok") {
      await ctx.reply(`Session *${escMd(name)}* created\\.`, { parse_mode: "MarkdownV2" });
    } else if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
    }
  }

  async #handleAttach(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const name = ctx.message?.text?.split(/\s+/)[1];
    if (!name) {
      await ctx.reply("Usage: /attach <name>");
      return;
    }

    const session = this.#manager.findByName(name, state.auth!);
    if (!session) {
      await ctx.reply(`Session not found: ${name}`);
      return;
    }

    const chatId = ctx.chat!.id;
    const userId = ctx.from!.id;

    // Detach from the current session before switching to a new one.
    // Without this, the old session stays registered as a client and
    // continues streaming into this chat — causing interleaved output
    // and stale streaming/stop-button state when cycling sessions.
    if (state.attachedSessionId && state.attachedSessionId !== session.id) {
      this.#manager.disconnectClient(state.clientId);
      state.attachedSessionId = null;
      state.attachedSessionName = null;
      // Deliver anything still buffered from the old session (with an
      // interruption marker) rather than discarding it invisibly — and wait
      // for it to land so the "Attached to …" confirmation can't overtake it.
      state.relay.flushAndClear(chatId);
      await state.relay.settle();
      // Remove the ⏹ Stop button for the old session. The old session's
      // idle status_change (which normally deletes it) won't arrive after
      // we disconnected, so it would otherwise linger in the chat. Bump the
      // generation so an in-flight "⏳ Working…" send deletes itself too.
      state.stopGeneration++;
      if (state.stopMessageId !== null) {
        this.#bot.api.deleteMessage(chatId, state.stopMessageId).catch(() => {});
        state.stopMessageId = null;
      }
    }

    const client: AttachedClient = {
      id: state.clientId,
      auth: state.auth!,
      capabilities: TELEGRAM_CAPABILITIES,
      send: (msg: DaemonMessage) => this.#forwardToChat(chatId, userId, msg),
    };

    // Mark attached BEFORE the attach call: live broadcasts can start the
    // moment the daemon registers the client, and the stale-session gate in
    // #forwardToChat would otherwise drop them. Restored on failure (a
    // failed same-session re-attach must not fake a detach).
    const prevSessionId = state.attachedSessionId;
    const prevSessionName = state.attachedSessionName;
    state.attachedSessionId = session.id;
    state.attachedSessionName = name;

    const resp = await this.#manager.handle(
      { type: "session.attach", id: randomUUID(), sessionId: session.id },
      state.auth!,
      client,
    );

    if (resp.type === "response.ok") {
      await ctx.reply(`Attached to *${escMd(name)}*\\. Send messages here\\.`, { parse_mode: "MarkdownV2" });
    } else if (resp.type === "response.error") {
      state.attachedSessionId = prevSessionId;
      state.attachedSessionName = prevSessionName;
      await ctx.reply(`Error: ${resp.error}`);
    }
  }

  async #handleDetach(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached to any session.");
      return;
    }

    const chatId = ctx.chat!.id;
    this.#manager.disconnectClient(state.clientId);
    const name = state.attachedSessionName;
    state.attachedSessionId = null;
    state.attachedSessionName = null;
    // Deliver anything still buffered before dropping state — detaching must
    // not silently swallow streamed-but-unflushed content. Wait for it to
    // land so the "Detached from …" confirmation can't overtake it.
    state.relay.flushAndClear(chatId);
    await state.relay.settle();
    state.stopGeneration++;
    if (state.stopMessageId !== null) {
      this.#bot.api.deleteMessage(chatId, state.stopMessageId).catch(() => {});
      state.stopMessageId = null;
    }
    await ctx.reply(`Detached from ${name}.`);
  }

  async #handleInterrupt(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached to any session.");
      return;
    }

    const resp = await this.#manager.handle(
      { type: "session.interrupt", id: randomUUID(), sessionId: state.attachedSessionId },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    await ctx.reply("Interrupted.");
  }

  async #handleDestroy(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const name = ctx.message?.text?.split(/\s+/)[1];
    if (!name) {
      await ctx.reply("Usage: /destroy <name>");
      return;
    }

    const session = this.#manager.findByName(name, state.auth!);
    if (!session) {
      await ctx.reply(`Session not found: ${name}`);
      return;
    }

    const resp = await this.#manager.handle(
      { type: "session.destroy", id: randomUUID(), sessionId: session.id },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      // The session is still alive (and still attached, if it was) — don't
      // report success or clear the attachment.
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }

    if (state.attachedSessionId === session.id) {
      state.attachedSessionId = null;
      state.attachedSessionName = null;
    }
    await ctx.reply(`Session *${escMd(name)}* destroyed\\.`, { parse_mode: "MarkdownV2" });
  }

  // ── Search ──────────────────────────────────────────────────────────────

  async #handleSearch(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const query = (ctx.message?.text?.split(/\s+/).slice(1).join(" ") ?? "").trim();
    if (!query) {
      await ctx.reply("Usage: /search <query>\n\nSearches across all sessions in the workspace.");
      return;
    }

    const resp = await this.#manager.handle(
      {
        type: "session.search",
        id: randomUUID(),
        query,
        scope: "workspace",
        limit: 5,
      },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    if (resp.type === "response.error") {
      await ctx.reply(`Search error: ${resp.error}`);
      return;
    }

    if (resp.type !== "session.search.result") return;

    const results = resp as SessionSearchResultMsg;
    if (results.sessions.length === 0) {
      await ctx.reply(`No results for "${query}".`);
      return;
    }

    const lines: string[] = [];
    lines.push(`🔍 *Search: ${escMd(query)}*\n`);

    for (const hit of results.sessions) {
      const when = formatAgo(hit.lastMatchAt);
      const matchLabel = `${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"}`;
      lines.push(
        `▸ *${escMd(hit.sessionName)}* — ${escMd(matchLabel)} · ${escMd(when)}`,
      );

      for (const snippet of hit.snippets.slice(0, 2)) {
        const prefix =
          snippet.kind === "user_turn"
            ? "you"
            : snippet.kind === "assistant_turn"
              ? "claude"
              : snippet.toolName ?? "tool";
        const excerpt = snippet.excerpt
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
        lines.push(`  _${escMd(prefix)}:_ ${escMd(excerpt)}`);
      }
      lines.push("");
    }

    lines.push("Use /attach \\<name\\> to jump into a session\\.");

    // Telegram has a 4096-char limit; chunk if needed
    const text = lines.join("\n");
    if (text.length <= 4096) {
      await ctx.reply(text, { parse_mode: "MarkdownV2" });
    } else {
      // Fall back to plain text for very long results
      const plain = lines.join("\n").replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
      state.relay.sendChunked(ctx.chat!.id, plain);
    }
  }

  // ── Run control ───────────────────────────────────────────────────────

  async #handleRename(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;
    if (!state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name> first.");
      return;
    }
    const name = ctx.message?.text?.split(/\s+/).slice(1).join(" ").trim();
    if (!name) {
      await ctx.reply("Usage: /rename <new name>");
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.rename", id: randomUUID(), sessionId: state.attachedSessionId, name },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    state.attachedSessionName = name;
    await ctx.reply(`Renamed to *${escMd(name)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  async #handleRotate(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.rotate", id: randomUUID(), sessionId: state.attachedSessionId },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    await ctx.reply("🔄 Context rotated — memory preserved.");
  }

  async #handleMode(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const arg = ctx.message?.text?.split(/\s+/)[1]?.toLowerCase();
    const mode: SessionMode | undefined =
      arg === "i" || arg === "interactive"
        ? "interactive"
        : // `a`/`auto`/`auto-allow` kept as backward-compat aliases for the
          // renamed `guarded` — mirror packages/core/src/slash.ts.
          arg === "g" || arg === "guarded" || arg === "a" || arg === "auto" || arg === "auto-allow"
          ? "guarded"
          : arg === "x" || arg === "autonomous"
            ? "autonomous"
            : undefined;
    if (!mode) {
      await ctx.reply(
        "Usage: /mode <guarded|interactive|autonomous>\n" +
          "  guarded (default) — Read/Grep/Glob auto; Write/Edit/Bash ask\n" +
          "  interactive — every tool asks first\n" +
          "  autonomous — every tool auto-approved (no prompts)",
      );
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.set_mode", id: randomUUID(), sessionId: state.attachedSessionId, mode },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    await ctx.reply(`Mode → *${escMd(mode)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  async #handleModel(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const arg = ctx.message?.text?.split(/\s+/)[1];
    if (!arg) {
      // No argument → list the live model catalog.
      const resp = await this.#manager.handle(
        { type: "models.list", id: randomUUID() },
        state.auth!,
        this.#makeClient(state, ctx),
      );
      if (resp.type !== "models.list.result") {
        await ctx.reply("Could not fetch models.");
        return;
      }
      const list = (resp as ModelsListResultMsg).models
        .map((m) => `• \`${escCode(m.value)}\` — ${escMd(m.displayName)}${m.isDefault ? " \\(default\\)" : ""}`)
        .join("\n");
      await ctx.reply(
        `*Models* \\(use /model \\<name\\>\\)\n${list}`,
        { parse_mode: "MarkdownV2" },
      );
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.set_model", id: randomUUID(), sessionId: state.attachedSessionId, model: arg },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    await ctx.reply(`Model → *${escMd(arg)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  /** `/provider` — list backends; `/provider <id>` switches the attached session. */
  async #handleProvider(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const arg = ctx.message?.text?.split(/\s+/)[1];
    if (!arg) {
      const list = this.#manager
        .providerIds()
        .map((id, i) => `• \`${escCode(id)}\`${i === 0 ? " \\(default\\)" : ""}`)
        .join("\n");
      await ctx.reply(`*Backends* \\(use /provider \\<id\\>\\)\n${list}`, { parse_mode: "MarkdownV2" });
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.set_provider", id: randomUUID(), sessionId: state.attachedSessionId, providerId: arg },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    await ctx.reply(`Backend → *${escMd(arg)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  /**
   * `/fork` — branch the attached session into a new one and switch to it.
   * `/fork <providerId>` forks onto a different backend in one step
   * ("continue this conversation on codex"). The chat auto-attaches to the
   * fork so the next message goes to the branch, not the parent.
   */
  async #handleFork(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const providerId = ctx.message?.text?.split(/\s+/)[1];
    const chatId = ctx.chat!.id;

    const resp = await this.#manager.handle(
      {
        type: "session.fork",
        id: randomUUID(),
        sessionId: state.attachedSessionId,
        ...(providerId ? { providerId } : {}),
      },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type === "response.error") {
      await ctx.reply(`Error: ${resp.error}`);
      return;
    }
    const fork = (resp as { data: SessionInfo }).data;

    // Auto-attach to the fork (mirror /attach): detach the parent so its
    // stream stops landing here, flush anything buffered, then attach the
    // branch. Set attachedSessionId BEFORE the attach call — live broadcasts
    // can arrive the moment the daemon registers the client.
    if (state.attachedSessionId !== fork.id) {
      this.#manager.disconnectClient(state.clientId);
      state.relay.flushAndClear(chatId);
      // Wait for the flushed tail to land so the fork confirmation can't
      // overtake it (mirror #handleAttach's switch sequence).
      await state.relay.settle();
      // Remove the parent's ⏹ Stop button — its idle status_change won't
      // arrive after the disconnect, and a stale Stop tapped later would
      // fire a spurious interrupt at the parent.
      state.stopGeneration++;
      if (state.stopMessageId !== null) {
        this.#bot.api.deleteMessage(chatId, state.stopMessageId).catch(() => {});
        state.stopMessageId = null;
      }
    }
    state.attachedSessionId = fork.id;
    state.attachedSessionName = fork.name;
    await this.#manager.handle(
      { type: "session.attach", id: randomUUID(), sessionId: fork.id },
      state.auth!,
      this.#makeClient(state, ctx),
    );

    const onBackend = providerId ? ` on *${escMd(fork.providerId ?? providerId)}*` : "";
    await ctx.reply(
      `Forked into *${escMd(fork.name)}*${onBackend}\\. You're on the branch now — the parent is untouched\\.`,
      { parse_mode: "MarkdownV2" },
    );
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  async #handleWho(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;
    const a = state.auth!;
    const lines = [
      "*Identity*",
      `sub: \`${escCode(a.sub)}\``,
      a.name ? `name: ${escMd(a.name)}` : "",
      a.accountId ? `account: \`${escCode(a.accountId)}\`` : "",
      a.projectId ? `project: \`${escCode(a.projectId)}\`` : "",
      `scopes: ${escMd((a.scopes ?? []).join(", ") || "none")}`,
      a.delegationDepth ? `delegation depth: ${a.delegationDepth}` : "",
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
  }

  /**
   * Read-only settings summary: the daemon's current, non-default configuration
   * (secret VALUES never shown — only which are set) plus the backing file
   * paths for editing. In-process, so it reads the store directly.
   */
  async #handleSettings(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;
    const manifest = getManifest();
    const snapshot = getSnapshot();
    const fmt = (v: unknown): string => {
      if (v === null || v === undefined) return "—";
      if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
      if (typeof v === "boolean") return v ? "on" : "off";
      return String(v);
    };
    const lines: string[] = ["*Settings*", escMd("Customized values (read-only)")];
    for (const tab of manifest.tabs) {
      const rows: string[] = [];
      for (const group of tab.groups) {
        for (const f of group.fields) {
          if (f.secret) continue;
          const st = snapshot.values[f.key];
          if (!st || st.source === "default") continue; // only what's been changed
          rows.push(`  ${escMd(f.label)}: \`${escCode(fmt(st.value))}\` ${escMd(`(${st.source})`)}`);
        }
      }
      if (rows.length > 0) lines.push(`*${escMd(tab.title)}*`, ...rows);
    }
    if (lines.length === 2) lines.push(escMd("All settings are at their defaults."));
    const secretsSet = Object.entries(snapshot.secrets)
      .filter(([, s]) => s.set)
      .map(([k]) => k);
    lines.push(`*Secrets set*: ${secretsSet.length ? escCode(secretsSet.join(", ")) : escMd("none")}`);
    lines.push(`edit: \`${escCode(snapshot.configPath)}\` · \`${escCode(snapshot.envPath)}\``);
    const text = lines.join("\n");
    if (text.length <= 4000) {
      await ctx.reply(text, { parse_mode: "MarkdownV2" });
    } else {
      await ctx.reply(`Settings summary is long — see ${snapshot.configPath}`);
    }
  }

  async #handleCapabilities(
    ctx: Context,
    tab: "agents" | "skills" | "mcp" | "hooks",
  ): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    const resp = await this.#manager.handle(
      { type: "claude.config", id: randomUUID(), sessionId: state.attachedSessionId },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    if (resp.type !== "claude.config.result") {
      await ctx.reply("Could not fetch capabilities.");
      return;
    }
    const cfg = resp as ClaudeConfigResultMsg;
    let lines: string[];
    if (tab === "agents") {
      lines = cfg.agents.map((a) => `• *${escMd(a.name)}* — ${escMd(a.description ?? "")}`);
    } else if (tab === "skills") {
      lines = cfg.skills.map((s) => `• *${escMd(s.name)}* — ${escMd(s.description ?? "")}`);
    } else if (tab === "mcp") {
      lines = cfg.mcpServers.map(
        (m) => `• *${escMd(m.name)}* — ${escMd(m.command ?? m.scope)}`,
      );
    } else {
      // Inside a MarkdownV2 code span only ` and \ are special — escMd here
      // rendered literal backslashes that broke copy-paste of the command.
      lines = cfg.hooks.map((h) => `• \`${escCode(h.command)}\``);
    }
    const title = { agents: "Subagents", skills: "Skills", mcp: "MCP servers", hooks: "Hooks" }[tab];
    await ctx.reply(
      `*${escMd(title)}*\n${lines.length ? lines.join("\n") : "_none_"}`,
      { parse_mode: "MarkdownV2" },
    );
  }

  // ── Text & voice ─────────────────────────────────────────────────────

  async #handleText(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state) return;

    const text = ctx.message?.text;
    if (!text || !state.attachedSessionId) {
      if (!state.attachedSessionId) await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }

    // A pending input/editor dialog for this user consumes the next message as
    // its answer (oldest first) instead of sending it to the session.
    const uiEntry = [...this.#uiRequests.entries()].find(
      ([k, e]) => k.startsWith(`${ctx.from?.id}:`) && e.awaitingText,
    );
    if (uiEntry) {
      await this.#respondUiRequest(ctx, uiEntry[0], uiEntry[1], { value: text });
      await ctx.reply("✅ Answer sent.").catch(() => {});
      return;
    }

    // Tool approvals go through the inline Approve/Deny buttons (precise
    // approvalId, concurrent-safe), so plain text is always a message to the
    // session — no "yes"/"no" interception.
    const resp = await this.#manager.handle(
      { type: "session.send", id: randomUUID(), sessionId: state.attachedSessionId, text },
      state.auth!,
      this.#makeClient(state, ctx),
    );
    // Never drop a rejected send silently — surface the reason so the user
    // knows their message didn't go through (e.g. missing scope, session gone).
    if (resp?.type === "response.error") {
      await ctx
        .reply(`⚠️ Message not delivered: ${resp.error}`)
        .catch(() => {});
    }
  }

  async #handleVoice(ctx: Context): Promise<void> {
    const state = this.#requireAuth(ctx);
    if (!state || !state.attachedSessionId) {
      await ctx.reply("Not attached. Use /attach <name>.");
      return;
    }
    await ctx.reply("🎙 Voice transcription coming soon. Send text for now.");
  }

  // ── Forward agent output to Telegram chat ─────────────────────────────

  #forwardToChat(chatId: number, userId: number, msg: DaemonMessage): void {
    const state = this.#users.get(userId);
    // Drop broadcasts from sessions the user is no longer attached to — an
    // in-flight callback from the old session can still fire after a detach
    // or switch, and must not reach the current relay/chat (a stale idle
    // would flush the new session's buffers and print a bogus "✅ Done.").
    if (!state || isStaleBroadcast(msg, state.attachedSessionId)) return;
    const relay = state.relay;

    switch (msg.type) {
      case "session.message": {
        const m = msg;
        // Content buffering / exactly-once flushing lives in the relay.
        relay.handleMessage(chatId, m);
        if (
          m.role === "tool_call" &&
          m.tool &&
          m.tool.state.phase === "waiting_confirmation" &&
          "approvalId" in m.tool.state
        ) {
          // Inline Approve/Deny (or AskUserQuestion option buttons) keyed
          // to the exact approvalId — handles concurrent approvals.
          this.#sendApproval(chatId, userId, m.tool);
        }
        break;
      }

      case "session.message.delta": {
        // Buffer; don't stream to Telegram per-token (rate limits).
        relay.handleDelta(chatId, msg);
        break;
      }

      case "session.ui_request": {
        // A provider raised a dialog (codex/pi/openai/gemini ask the user).
        this.#sendUiRequest(chatId, userId, msg);
        break;
      }

      case "session.ui_resolved": {
        // Another client answered (or it timed out / was cancelled) — drop
        // our pending entry so a stale text reply can't answer a dead request.
        const short = msg.requestId.slice(0, 8);
        this.#uiRequests.delete(`${userId}:${short}`);
        break;
      }

      case "session.status_change": {
        const active =
          msg.status === "thinking" || msg.status === "tool_running";
        if (active) {
          // Turn started — show a one-tap ⏹ Stop control (once per turn).
          // Mobile parity with Esc on desktop: no need to type /interrupt.
          if (state.attachedSessionId && state.stopMessageId === null) {
            const sid = state.attachedSessionId;
            const kb = new InlineKeyboard().text("⏹ Stop", `stop:${sid}`);
            // Capture the turn generation BEFORE the send: if idle/error (or
            // a detach/switch) lands while the send is in flight, the .then
            // below must delete the just-sent message rather than store it —
            // a `stopMessageId === null` check alone can't tell "not sent
            // yet" apart from "turn already ended and cleanup already ran".
            const gen = state.stopGeneration;
            this.#bot.api
              .sendMessage(chatId, "⏳ Working…", { reply_markup: kb })
              .then((m) => {
                if (state.stopGeneration === gen && state.stopMessageId === null) {
                  state.stopMessageId = m.message_id;
                } else {
                  // Turn already ended (or another control exists) — remove
                  // the orphan instead of leaving a live spurious Stop.
                  this.#bot.api.deleteMessage(chatId, m.message_id).catch(() => {});
                }
              })
              .catch(() => {});
          }
        } else if (msg.status === "idle" || msg.status === "error") {
          // Turn ended — invalidate any in-flight "⏳ Working…" send and
          // remove the Stop control.
          state.stopGeneration++;
          if (state.stopMessageId !== null) {
            this.#bot.api.deleteMessage(chatId, state.stopMessageId).catch(() => {});
            state.stopMessageId = null;
          }
          if (msg.status === "idle") {
            // Flush any remaining buffered streams, then confirm — the relay
            // queues "✅ Done." after the content so it can't overtake it.
            relay.flushIdle(chatId);
          } else {
            relay.send(chatId, "❌ Error.");
          }
        }
        break;
      }
    }
  }

  // ── Tool approvals (inline keyboard) ──────────────────────────────────

  /**
   * Render a tool-approval prompt with inline buttons. Binary approvals get
   * Approve/Deny; AskUserQuestion-style tools get one message per question
   * with a button per option. Each is keyed to the exact approvalId so
   * concurrent approvals don't collide.
   */
  #sendApproval(chatId: number, userId: number, tool: ToolInfo): void {
    if (tool.state.phase !== "waiting_confirmation") return;
    const state = this.#users.get(userId);
    const sessionId = state?.attachedSessionId;
    if (!sessionId) return;

    const approvalId = tool.state.approvalId;
    const short = approvalId.slice(0, 8);
    const input = (tool.input ?? {}) as { questions?: unknown };
    const rawQuestions = Array.isArray(input.questions) ? input.questions : null;
    const questions: AskQuestion[] | undefined = rawQuestions
      ?.filter(
        (q): q is AskQuestion =>
          !!q &&
          typeof q === "object" &&
          typeof (q as AskQuestion).question === "string" &&
          Array.isArray((q as AskQuestion).options),
      )
      .map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect,
        options: q.options.filter((o) => o && typeof o.label === "string"),
      }));

    this.#pruneApprovals();
    // Keyed by user AND short token: the same waiting_confirmation broadcast
    // fans out to every attached user, and a token-only key meant the last
    // registration won — every other user's tap failed forever. The callback
    // handler rebuilds the key from ctx.from.id, so callback_data stays small.
    const key = `${userId}:${short}`;
    const existing = this.#approvals.get(key);
    // A re-broadcast of the same approval must not wipe answers already
    // collected via the option buttons — preserve the live entry.
    const keepExisting =
      existing?.approvalId === approvalId &&
      Object.keys(existing.answers).length > 0;
    if (!keepExisting) {
      this.#approvals.set(key, {
        approvalId,
        sessionId,
        userId,
        chatId,
        questions,
        answers: {},
        createdAt: Date.now(),
      });
    }

    if (questions && questions.length > 0) {
      questions.forEach((q, qi) => {
        const kb = new InlineKeyboard();
        q.options.forEach((opt, oi) => {
          kb.text(opt.label, `q:${short}:${qi}:${oi}`).row();
        });
        // Cap the question BEFORE escaping — an unbounded model-authored
        // question 400s the send (mirror the 800-char binary-approval cap).
        const question = q.question.slice(0, 800);
        const head = q.header ? `*${escMd(q.header)}* — ` : "";
        this.#bot.api
          .sendMessage(chatId, `❓ ${head}${escMd(question)}`, {
            parse_mode: "MarkdownV2",
            reply_markup: kb,
          } as Record<string, unknown>)
          .catch(() =>
            // MarkdownV2 can still 400 on pathological text; retry as plain
            // text with the same keyboard so the approval stays actionable
            // instead of hanging the turn invisibly.
            this.#bot.api
              .sendMessage(
                chatId,
                `❓ ${q.header ? `${q.header} — ` : ""}${question}`,
                { reply_markup: kb } as Record<string, unknown>,
              )
              .catch(() =>
                // Last resort: tell the user the turn is blocked on an
                // approval they cannot see, and how to get out.
                this.#bot.api
                  .sendMessage(
                    chatId,
                    `⚠️ Approval prompt failed to render — approval ${short} is pending; reply /interrupt to abort`,
                  )
                  .catch(() => {}),
              ),
          );
      });
      return;
    }

    const desc =
      "description" in tool.state ? tool.state.description : tool.name;
    const kb = new InlineKeyboard()
      .text("✅ Approve", `a:${short}:y`)
      .text("❌ Deny", `a:${short}:n`);
    this.#bot.api
      .sendMessage(
        chatId,
        `⚠️ Permission needed — ${tool.name}\n${String(desc).slice(0, 800)}`,
        { reply_markup: kb } as Record<string, unknown>,
      )
      .catch(() => {});
  }

  /** Handle an inline-keyboard tap (approval decision / question answer). */
  async #handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const [kind, short, ...rest] = data.split(":");

    // ⏹ Stop — interrupt the current turn. Handled before the approval
    // lookup since it carries a sessionId, not an approvalId.
    if (kind === "stop") {
      const userId = ctx.from?.id;
      const state = userId !== undefined ? this.#users.get(userId) : undefined;
      const sessionId = short || state?.attachedSessionId || null;
      if (!state?.auth || !sessionId) {
        await ctx.answerCallbackQuery({ text: "Nothing to stop." }).catch(() => {});
        return;
      }
      if (this.#authExpired(state)) {
        this.#expireAuth(userId!, state);
        await ctx.answerCallbackQuery({ text: "Session expired — re-run /auth." }).catch(() => {});
        return;
      }
      const client: AttachedClient = {
        id: state.clientId,
        auth: state.auth,
        send: (m: DaemonMessage) => this.#forwardToChat(ctx.chat!.id, userId!, m),
      };
      await this.#manager.handle(
        { type: "session.interrupt", id: randomUUID(), sessionId },
        state.auth,
        client,
      );
      await ctx.answerCallbackQuery({ text: "⏹ Interrupted" }).catch(() => {});
      // Remove the Stop control; the idle status_change also clears it.
      await ctx.editMessageText("⏹ Interrupted").catch(() => {});
      if (state.stopMessageId !== null) state.stopMessageId = null;
      return;
    }

    // Provider dialog answer (`session.ui_request`). Keyed `${userId}:${short}`
    // like approvals; `rest[0]` is the choice: o<idx> | y | n | x(cancel).
    if (kind === "uireq") {
      const userId = ctx.from?.id;
      if (userId === undefined) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const key = `${userId}:${short}`;
      const entry = this.#uiRequests.get(key);
      if (!entry) {
        await ctx.answerCallbackQuery({ text: "Dialog no longer active." }).catch(() => {});
        await ctx.editMessageReplyMarkup().catch(() => {});
        return;
      }
      const choice = rest[0] ?? "";
      let payload: { value?: string; confirmed?: boolean; cancelled?: boolean };
      let label: string;
      if (choice === "x") {
        payload = { cancelled: true };
        label = "⨯ Cancelled";
      } else if (entry.method === "confirm") {
        const yes = choice === "y";
        payload = { confirmed: yes };
        label = yes ? "✅ Yes" : "🚫 No";
      } else {
        const idx = Number.parseInt(choice.replace(/^o/, ""), 10);
        const value = entry.options?.[idx];
        if (value === undefined) {
          await ctx.answerCallbackQuery({ text: "Invalid option." }).catch(() => {});
          return;
        }
        payload = { value };
        label = value;
      }
      await this.#respondUiRequest(ctx, key, entry, payload);
      await ctx.answerCallbackQuery({ text: label.slice(0, 200) }).catch(() => {});
      await ctx.editMessageText(`❓ ${label}`).catch(() => {});
      return;
    }

    // Approvals are keyed `${userId}:${short}` — each attached user has
    // their own registration for the same fanned-out approval, so one user's
    // entry can never clobber another's. The tapping user's id rebuilds the
    // key; a user can only ever resolve their OWN registration (GHSA-4g69:
    // a different allowlisted user tapping a forwarded button must not act
    // under the owner's identity).
    const tapperId = ctx.from?.id;
    const key = tapperId !== undefined ? `${tapperId}:${short}` : "";
    const pending = short ? this.#approvals.get(key) : undefined;
    if (!pending) {
      // Distinguish "someone else's approval" (forwarded/screenshotted
      // button) from a prompt that is genuinely gone.
      const foreign =
        !!short &&
        [...this.#approvals.keys()].some((k) => k.endsWith(`:${short}`));
      await ctx
        .answerCallbackQuery({ text: foreign ? "Not your approval." : "This prompt expired." })
        .catch(() => {});
      return;
    }
    // Enforce the approval TTL on tap, not just when a later prompt triggers
    // #pruneApprovals — otherwise an approval older than the TTL stays
    // actionable indefinitely if no new prompt ever arrives.
    if (Date.now() - pending.createdAt > this.#approvalTtlMs) {
      this.#approvals.delete(key);
      await ctx.answerCallbackQuery({ text: "This prompt expired." }).catch(() => {});
      return;
    }
    const state = this.#users.get(pending.userId);
    if (!state?.auth) {
      await ctx.answerCallbackQuery({ text: "Not authenticated." }).catch(() => {});
      return;
    }
    // A tool approval runs a shell command under the caller's identity — so an
    // expired token must not be honored here either. #expireAuth drops this
    // user's remaining approvals, including this one.
    if (this.#authExpired(state)) {
      this.#expireAuth(pending.userId, state);
      await ctx.answerCallbackQuery({ text: "Session expired — re-run /auth." }).catch(() => {});
      return;
    }
    const client: AttachedClient = {
      id: state.clientId,
      auth: state.auth,
      send: (m: DaemonMessage) => this.#forwardToChat(pending.chatId, pending.userId, m),
    };

    if (kind === "a") {
      const approved = rest[0] === "y";
      this.#approvals.delete(key);
      await this.#manager.handle(
        {
          type: "session.approve",
          id: randomUUID(),
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          approved,
        },
        state.auth,
        client,
      );
      await ctx.answerCallbackQuery({ text: approved ? "Approved" : "Denied" }).catch(() => {});
      await ctx.editMessageText(approved ? "✅ Approved" : "❌ Denied").catch(() => {});
      return;
    }

    if (kind === "q" && pending.questions) {
      const qi = Number(rest[0]);
      const oi = Number(rest[1]);
      const q = pending.questions[qi];
      const opt = q?.options[oi];
      if (!q || !opt) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      pending.answers[q.question] = [opt.label];
      await ctx.answerCallbackQuery({ text: `${q.header ?? "Answer"}: ${opt.label}` }).catch(() => {});
      await ctx
        .editMessageText(`❓ ${q.question}\n→ ${opt.label}`)
        .catch(() => {});
      // Submit once every question has an answer.
      if (Object.keys(pending.answers).length >= pending.questions.length) {
        this.#approvals.delete(key);
        const answers: Record<string, string> = {};
        for (const qq of pending.questions) {
          answers[qq.question] = (pending.answers[qq.question] ?? []).join(", ");
        }
        await this.#manager.handle(
          {
            type: "session.approve",
            id: randomUUID(),
            sessionId: pending.sessionId,
            approvalId: pending.approvalId,
            approved: true,
            updatedInput: { answers },
          },
          state.auth,
          client,
        );
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Evict approvals older than the TTL, then oldest-first down to the cap.
   * Untapped prompts (interrupted turns, closed chats) are otherwise only ever
   * removed by a tap, so the map would grow unbounded on a long-lived daemon. */
  #pruneApprovals(): void {
    const now = Date.now();
    for (const [key, p] of this.#approvals) {
      if (now - p.createdAt > this.#approvalTtlMs) this.#approvals.delete(key);
    }
    if (this.#approvals.size < MAX_PENDING_APPROVALS) return;
    const byAge = [...this.#approvals.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    for (const [key] of byAge) {
      if (this.#approvals.size < MAX_PENDING_APPROVALS) break;
      this.#approvals.delete(key);
    }
  }

  #getOrCreate(userId: number): UserState {
    let state = this.#users.get(userId);
    if (!state) {
      state = {
        auth: null,
        attachedSessionId: null,
        attachedSessionName: null,
        clientId: `telegram:${userId}`,
        relay: new StreamRelay(this.#relayApi),
        stopMessageId: null,
        stopGeneration: 0,
      };
      this.#users.set(userId, state);
    }
    return state;
  }

  #requireAuth(ctx: Context): UserState | null {
    const state = this.#users.get(ctx.from!.id);
    if (!state?.auth) {
      ctx.reply("Not authenticated. Use /auth <api_key>.").catch(() => {});
      return null;
    }
    // Re-check token expiry on every command. The Telegram surface is a full
    // remote-control channel (it can approve tool executions), so it must not
    // honor a revoked/expired key until the daemon restarts — mirror the WS
    // per-message `exp` enforcement (GHSA-4g69).
    if (this.#authExpired(state)) {
      this.#expireAuth(ctx.from!.id, state);
      ctx.reply("Session expired. Re-authenticate with /auth <api_key>.").catch(() => {});
      return null;
    }
    return state;
  }

  /** True when the cached auth carries a token whose `exp` has passed. No skew
   * — matches the daemon's WS check (server.ts) exactly. */
  #authExpired(state: UserState): boolean {
    const exp = state.auth?.exp;
    return typeof exp === "number" && exp > 0 && exp <= Math.floor(Date.now() / 1000);
  }

  /** Drop a stale cached auth: clear it, tear down any live attachment so
   * streaming under the expired identity stops immediately, and discard this
   * user's pending approvals. Without dropping the approvals, the user could
   * re-authenticate and tap an old prompt — which would then run under the
   * fresh token. The user must re-run /auth to get a fresh token. */
  #expireAuth(userId: number, state: UserState): void {
    state.auth = null;
    try { this.#manager.disconnectClient(state.clientId); } catch { /* not attached */ }
    state.attachedSessionId = null;
    state.attachedSessionName = null;
    for (const [key, approval] of this.#approvals) {
      if (approval.userId === userId) this.#approvals.delete(key);
    }
  }

  /**
   * Render a provider dialog (`session.ui_request`). select/confirm use inline
   * buttons; input/editor prompt for a text reply (the next plain message is
   * consumed as the answer — see #handleText). A ⨯ Cancel button always lets
   * the user dismiss. Only `short` (requestId prefix) travels in callback_data.
   */
  #sendUiRequest(chatId: number, userId: number, req: SessionUiRequestMsg): void {
    // Light cap: the daemon's ui_resolved broadcast normally clears entries,
    // but a detach mid-dialog could otherwise leak one. Evict the oldest.
    if (this.#uiRequests.size >= MAX_PENDING_APPROVALS) {
      const oldest = this.#uiRequests.keys().next().value;
      if (oldest) this.#uiRequests.delete(oldest);
    }
    const short = req.requestId.slice(0, 8);
    const key = `${userId}:${short}`;
    this.#uiRequests.set(key, {
      requestId: req.requestId,
      sessionId: req.sessionId,
      method: req.method,
      options: req.options,
      awaitingText: req.method === "input" || req.method === "editor",
      createdAt: Date.now(),
    });

    const lines = [`❓ ${req.title}`];
    if (req.message) lines.push(req.message);

    const kb = new InlineKeyboard();
    if (req.method === "select" && req.options && req.options.length > 0) {
      req.options.slice(0, 20).forEach((opt, i) => {
        kb.text(opt.slice(0, 60), `uireq:${short}:o${i}`).row();
      });
    } else if (req.method === "confirm") {
      kb.text("✅ Yes", `uireq:${short}:y`).text("🚫 No", `uireq:${short}:n`).row();
    } else {
      // input / editor — the answer arrives as the user's next message.
      lines.push("✍️ Reply with your answer.");
      if (req.prefill) lines.push(`(suggested: ${req.prefill})`);
    }
    kb.text("⨯ Cancel", `uireq:${short}:x`);

    this.#bot.api.sendMessage(chatId, lines.join("\n\n"), { reply_markup: kb }).catch(() => {});
  }

  /** Answer a pending dialog: send `session.ui_response` and drop the entry. */
  async #respondUiRequest(
    ctx: Context,
    key: string,
    entry: PendingUiReq,
    payload: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): Promise<void> {
    this.#uiRequests.delete(key);
    const userId = ctx.from?.id;
    const state = userId !== undefined ? this.#users.get(userId) : undefined;
    if (!state?.auth) return;
    await this.#manager.handle(
      {
        type: "session.ui_response",
        id: randomUUID(),
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        ...payload,
      },
      state.auth,
      this.#makeClient(state, ctx),
    );
  }

  #makeClient(state: UserState, ctx: Context): AttachedClient {
    const chatId = ctx.chat!.id;
    const userId = ctx.from!.id;
    return {
      id: state.clientId,
      auth: state.auth!,
      capabilities: TELEGRAM_CAPABILITIES,
      send: (msg: DaemonMessage) => this.#forwardToChat(chatId, userId, msg),
    };
  }
}

/**
 * True when a session-scoped daemon broadcast belongs to a session the user
 * is not (or no longer) attached to. Messages without a sessionId (e.g.
 * direct responses) are never considered stale. Exported for tests.
 */
export function isStaleBroadcast(
  msg: DaemonMessage,
  attachedSessionId: string | null,
): boolean {
  const sid =
    "sessionId" in msg && typeof msg.sessionId === "string"
      ? msg.sessionId
      : null;
  return sid !== null && sid !== attachedSessionId;
}

/** Relative time string from a unix-ms timestamp. */
function formatAgo(when: number): string {
  const dt = Math.max(0, Date.now() - when);
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}
