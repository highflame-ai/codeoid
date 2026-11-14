/**
 * Slack frontend: talk to codeoid's conductor from a Slack DM.
 *
 * Runs inside the daemon, over Socket Mode (socket.ts), so it needs no public
 * URL. Enabled when CODEOID_SLACK_APP_TOKEN, CODEOID_SLACK_BOT_TOKEN and
 * CODEOID_SLACK_ALLOWED_USER_IDS are set; ZeroID only, never in local mode.
 *
 * - `/codeoid auth <zid_sk_…>`: sign in with your own ZeroID key. A slash
 *   command is never posted to the conversation, so the key isn't left in it.
 *   Everything after runs under that identity, as Telegram does.
 * - A DM to the bot goes to the conductor (made on first use), or to the
 *   session you attached with `/codeoid attach <name>`. Replies come back in
 *   the DM.
 * - A tool waiting for approval in that session gets a card with Approve and
 *   Deny buttons, naming the workstream it acts in. Only the person it was
 *   sent to can press them.
 * - When another of your sessions starts waiting on you, a DM says so.
 *
 * Other people's Slack messages never reach a session from here (S2 adds
 * intake, as data).
 */

import { randomUUID } from "node:crypto";
import { approvalSandboxLine, formatCollaborationCost, formatToolRisk } from "@highflame/codeoid-core";
import { ALL_SCOPES_STRING } from "../../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo, ToolInfo } from "../../protocol/types.js";
import type { AuthConfig } from "../../daemon/auth.js";
import type { AttachedClient } from "../../daemon/session.js";
import type { SessionManager } from "../../daemon/session-manager.js";
import type { Store } from "../../daemon/store.js";
import type { TokenVerifier } from "../../daemon/verifier.js";
import type { Frontend, FrontendContext } from "../types.js";
import { KNOWN_KEY_FORMATS } from "../../daemon/mcp/redact.js";
import { defaultTransport, type SlackEnvelope, SlackSocket, type SlackTransport, slackApi } from "./socket.js";

/** An approval card awaiting a button press, keyed `${slackUserId}:${approvalId}`. */
interface PendingApproval {
  approvalId: string;
  sessionId: string;
  userId: string;
  channel: string;
  ts?: string;
  /** The tool call's message, whose later updates close the card. */
  messageId?: string;
  createdAt: number;
}

interface UserState {
  auth: AuthContext | null;
  /** The token behind `auth`, kept for the conductor's owner → conductor delegation. Never logged. */
  rawToken: string | null;
  attachedSessionId: string | null;
  attachedName: string | null;
  clientId: string;
  /** Their DM with the bot, where replies and cards go. */
  dmChannel: string | null;
  /** Replies streaming in, by message id, not yet posted. */
  streams: Map<string, string>;
  /** Posts to this user, in order. */
  outbox: Promise<void>;
  /** Bumped when the sign-in changes: work queued under an earlier one is dropped, never done under this. */
  epoch: number;
}

const APPROVAL_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_APPROVALS = 200;
/** Slack's section text limit is 3000; a message's 40 000. Replies are split below the first. */
const CHUNK = 2_900;

export interface SlackFrontendOptions {
  /** Transport for Slack (tests inject one). */
  transport?: SlackTransport;
  approvalTtlMs?: number;
  /** Only this Slack workspace's events (CODEOID_SLACK_TEAM_ID); unset: any the app receives. */
  teamId?: string;
}

export class SlackFrontend implements Frontend {
  readonly name = "slack";

  #appToken: string;
  #botToken: string;
  #allowed: Set<string>;
  #transport: SlackTransport | undefined;
  #approvalTtlMs: number;
  #teamId: string | undefined;
  #socket: SlackSocket | null = null;
  /** When each non-allowlisted user was last told so, and each session's last "needs you": neither repeated often. */
  #toldStranger = new Map<string, number>();
  #toldNeeds = new Map<string, number>();
  /** A card's tool-call message → its cards' approval keys (one per Slack user holding it), to close them when answered elsewhere. */
  #cardOfMessage = new Map<string, Set<string>>();
  /** Tool-call messages already answered: a card queued for one isn't posted. */
  #answered = new Set<string>();
  /** Cards just answered here: a repeated press says nothing more. */
  #justAnswered = new Set<string>();
  #manager!: SessionManager;
  #authConfig!: AuthConfig;
  #verifier!: TokenVerifier;
  #store!: Store;
  #users = new Map<string, UserState>();
  #approvals = new Map<string, PendingApproval>();
  #unsubscribe: (() => void) | null = null;

  constructor(appToken: string, botToken: string, allowedUserIds: string[], opts: SlackFrontendOptions = {}) {
    this.#appToken = appToken;
    this.#botToken = botToken;
    this.#allowed = new Set(allowedUserIds);
    this.#transport = opts.transport;
    this.#approvalTtlMs = opts.approvalTtlMs ?? APPROVAL_TTL_MS;
    this.#teamId = opts.teamId;
  }

  async start(ctx: FrontendContext): Promise<void> {
    this.#manager = ctx.manager;
    this.#authConfig = ctx.auth;
    this.#verifier = ctx.verifier;
    this.#store = ctx.store;
    // Slack is reached through Slack's servers: a remote surface, which local mode's trust model doesn't cover.
    if (ctx.verifier.mode !== "zeroid") {
      throw new Error("the Slack frontend requires ZeroID auth — it is not available in local mode (run `codeoid login`, then start without --local)");
    }
    this.#socket = new SlackSocket(this.#appToken, (env) => this.handleEnvelope(env), this.#transport);
    await this.#socket.start();
    // Only once connected: a start that fails leaves nothing subscribed.
    this.#unsubscribe = this.#manager.onNeedsOwner((sessionId, name, owner) => this.#needsYou(sessionId, name, owner));
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#socket?.stop();
    for (const state of this.#users.values()) {
      try {
        this.#manager.disconnectClient(state.clientId);
      } catch {}
    }
  }

  /** One Socket Mode envelope; what it returns is the ack's payload (a slash command's ephemeral reply). Public for tests. */
  async handleEnvelope(env: SlackEnvelope): Promise<Record<string, unknown> | undefined> {
    if (this.#teamId) {
      const p = env.payload;
      const team = p.team_id ?? (p.team as { id?: unknown } | undefined)?.id ?? (p.event as { team?: unknown } | undefined)?.team;
      if (team !== this.#teamId) return undefined;
    }
    if (env.type === "slash_commands") return this.#slashCommand(env.payload);
    if (env.type === "events_api") {
      const event = env.payload.event as Record<string, unknown> | undefined;
      if (event) await this.#event(event);
      return undefined;
    }
    if (env.type === "interactive") {
      await this.#interactive(env.payload);
      return undefined;
    }
    return undefined;
  }

  // ── Slash command: /codeoid <subcommand> ──────────────────────────────

  async #slashCommand(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = String(p.user_id ?? "");
    const reply = (text: string) => ({ response_type: "ephemeral", text });
    if (!this.#allowed.has(userId)) return reply("You're not on this codeoid's allowlist.");
    const [sub = "help", ...args] = String(p.text ?? "").trim().split(/\s+/);
    switch (sub.toLowerCase()) {
      case "auth":
        return reply(await this.#auth(userId, args[0]));
      case "ls":
      case "sessions":
        return reply(await this.#list(userId));
      case "attach":
        return reply(await this.#attachByName(userId, args.join(" ")));
      case "conductor":
        return reply(await this.#attachConductor(userId));
      case "interrupt":
      case "stop":
        return reply(await this.#interrupt(userId));
      case "who": {
        const state = this.#authed(userId);
        if (typeof state === "string") return reply(state);
        return reply(`Signed in as ${state.auth?.name ?? state.auth?.sub}. Talking to ${state.attachedName ?? "the conductor (on your next message)"}.`);
      }
      default:
        return reply(
          [
            "*codeoid*",
            "`/codeoid auth <zid_sk_…>` sign in with your ZeroID key (once)",
            "`/codeoid ls` your sessions · `/codeoid attach <name>` talk to one · `/codeoid conductor` back to the conductor",
            "`/codeoid stop` interrupt the current turn · `/codeoid who` who you are signed in as",
            "Message me here to talk to the conductor. Approvals come here with buttons.",
          ].join("\n"),
        );
    }
  }

  async #auth(userId: string, key: string | undefined): Promise<string> {
    if (!key) return "Usage: `/codeoid auth <zid_sk_…>`";
    try {
      let token = key;
      if (key.startsWith("zid_sk_")) {
        const resp = await fetch(`${this.#authConfig.baseUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "api_key", api_key: key, scope: ALL_SCOPES_STRING }),
        });
        if (!resp.ok) return "Sign-in failed: check the key.";
        token = ((await resp.json()) as { access_token: string }).access_token;
      }
      const auth = await this.#verifier.verify(token);
      const state = this.#state(userId);
      // A new identity: what the old one was attached to and asked is let go.
      this.#forget(userId, state);
      state.auth = auth;
      state.rawToken = token;
      this.#store.audit(auth.sub, "slack.auth", undefined, `slack_user_id=${userId}${auth.name ? ` name=${auth.name}` : ""}`);
      // Their DM with the app, so replies have somewhere to go before they first write there.
      if (!state.dmChannel) {
        try {
          const opened = await slackApi<{ channel: { id: string } }>(this.#transportOrDefault(), this.#botToken, "conversations.open", { users: userId });
          state.dmChannel = opened.channel.id;
        } catch {}
      }
      if (!state.dmChannel) return `Signed in as ${auth.name ?? auth.sub}. Message me once so I can reply to you (I couldn't open our DM).`;
      return `Signed in as ${auth.name ?? auth.sub}. Message me to talk to the conductor.`;
    } catch (err) {
      return `Sign-in failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  async #list(userId: string): Promise<string> {
    const state = this.#authed(userId);
    if (typeof state === "string") return state;
    const resp = await this.#manager.handle({ type: "session.list", id: randomUUID() }, state.auth!, this.#client(userId, state));
    if (resp.type !== "session.list.result") return resp.type === "response.error" ? `Error: ${resp.error}` : "No sessions.";
    const sessions = (resp as { sessions: SessionInfo[] }).sessions;
    if (sessions.length === 0) return "No sessions.";
    return sessions
      .slice(0, 40)
      .map((s) => `• *${esc(s.name)}* — ${s.status}${s.workstream?.id ? ` · ${esc(s.workstream.id)}` : ""}${s.id === state.attachedSessionId ? " ← here" : ""}`)
      .join("\n");
  }

  async #attachByName(userId: string, name: string): Promise<string> {
    const state = this.#authed(userId);
    if (typeof state === "string") return state;
    if (!name) return "Usage: `/codeoid attach <name>`";
    const session = this.#manager.findByName(name, state.auth!);
    if (!session) return `No session named ${esc(name)}. \`/codeoid ls\` lists them.`;
    return this.#attach(userId, state, session.id, session.name);
  }

  async #attachConductor(userId: string): Promise<string> {
    const state = this.#authed(userId);
    if (typeof state === "string") return state;
    const id = await this.#conductorId(userId, state);
    if (typeof id !== "string") return id.error;
    return this.#attach(userId, state, id, "conductor");
  }

  /** The caller's conductor, made on first use with their own token (the owner → conductor delegation needs it). */
  async #conductorId(userId: string, state: UserState): Promise<string | { error: string }> {
    const resp = await this.#manager.handle(
      { type: "session.create", id: randomUUID(), name: "conductor", workdir: ".", role: "conductor" },
      state.auth!,
      this.#client(userId, state),
      state.rawToken ? { rawToken: state.rawToken } : undefined,
    );
    if (resp.type === "response.ok") return ((resp as { data?: SessionInfo }).data as SessionInfo).id;
    return { error: resp.type === "response.error" ? `The conductor isn't available: ${resp.error}` : "The conductor isn't available." };
  }

  async #attach(userId: string, state: UserState, sessionId: string, name: string): Promise<string> {
    if (state.attachedSessionId && state.attachedSessionId !== sessionId) {
      this.#manager.disconnectClient(state.clientId);
      state.streams.clear();
    }
    const prev = { id: state.attachedSessionId, name: state.attachedName };
    state.attachedSessionId = sessionId;
    state.attachedName = name;
    const resp = await this.#manager.handle({ type: "session.attach", id: randomUUID(), sessionId }, state.auth!, this.#client(userId, state));
    if (resp.type === "response.error") {
      state.attachedSessionId = prev.id;
      state.attachedName = prev.name;
      return `Couldn't attach: ${resp.error}`;
    }
    // What it was already waiting on was said before this attach: shown now, as cards.
    if (state.dmChannel) {
      const approvals = await this.#manager.handle({ type: "session.approvals", id: randomUUID(), sessionId }, state.auth!, this.#client(userId, state));
      const pending = (approvals as { approvals?: Array<{ approvalId: string; messageId?: string; toolName: string; input: unknown; risk?: unknown; sandboxed?: boolean; sandboxNote?: string; sandboxDocker?: boolean; targetWorkstream?: { workstream?: string; warning?: string } }> }).approvals ?? [];
      const epoch = state.epoch;
      const channel = state.dmChannel;
      for (const a of pending) {
        const tool = {
          name: a.toolName,
          toolId: a.approvalId,
          state: { phase: "waiting_confirmation", approvalId: a.approvalId, input: a.input, description: a.toolName, risk: a.risk, sandboxed: a.sandboxed, sandboxNote: a.sandboxNote, sandboxDocker: a.sandboxDocker, targetWorkstream: a.targetWorkstream },
        } as unknown as ToolInfo;
        this.#queue(userId, () => (state.epoch === epoch ? this.#approvalCard(userId, state, tool, sessionId, channel, a.messageId) : Promise.resolve()));
      }
    }
    return `Talking to *${esc(name)}* now.`;
  }

  async #interrupt(userId: string): Promise<string> {
    const state = this.#authed(userId);
    if (typeof state === "string") return state;
    if (!state.attachedSessionId) return "Nothing to stop.";
    const resp = await this.#manager.handle({ type: "session.interrupt", id: randomUUID(), sessionId: state.attachedSessionId }, state.auth!, this.#client(userId, state));
    return resp.type === "response.error" ? `Error: ${resp.error}` : "Stopped.";
  }

  // ── Events: a DM to the bot ───────────────────────────────────────────

  async #event(event: Record<string, unknown>): Promise<void> {
    // Only people's own messages in a DM with the bot: never a bot's (our own replies), an edit or a join.
    if (event.type !== "message" || event.channel_type !== "im" || event.bot_id || event.subtype) return;
    const userId = String(event.user ?? "");
    const channel = String(event.channel ?? "");
    const text = String(event.text ?? "").trim();
    if (!userId || !channel || !text) return;
    if (!this.#allowed.has(userId)) {
      const last = this.#toldStranger.get(userId) ?? 0;
      if (Date.now() - last > 60 * 60 * 1000) {
        this.#toldStranger.set(userId, Date.now());
        if (this.#toldStranger.size > 1000) this.#toldStranger.clear();
        await this.#post(channel, "You're not on this codeoid's allowlist.");
      }
      return;
    }
    // A key or a token pasted here would reach the model and its transcript: never forwarded.
    if (looksLikeSecret(text)) {
      await this.#post(channel, "⚠️ That looks like a key or a token, so it wasn't sent. Revoke it, and delete your message (I can't). Sign in with `/codeoid auth <key>`: a slash command isn't kept in the conversation.");
      return;
    }
    const state = this.#state(userId);
    state.dmChannel = channel;
    const authed = this.#authed(userId);
    if (typeof authed === "string") {
      await this.#post(channel, authed);
      return;
    }
    const epoch = state.epoch;
    if (!state.attachedSessionId) {
      const id = await this.#conductorId(userId, state);
      if (typeof id !== "string") {
        await this.#post(channel, id.error);
        return;
      }
      const attached = await this.#attach(userId, state, id, "conductor");
      if (!attached.startsWith("Talking")) {
        await this.#post(channel, attached);
        return;
      }
    }
    // Signed in again, or attached elsewhere, while this waited: the message isn't sent under the new sign-in.
    if (state.epoch !== epoch || !state.auth || !state.attachedSessionId) {
      await this.#post(channel, "⚠️ Not sent: your sign-in changed meanwhile. Send it again.");
      return;
    }
    const resp = await this.#manager.handle(
      { type: "session.send", id: randomUUID(), sessionId: state.attachedSessionId, text },
      state.auth!,
      this.#client(userId, state),
    );
    if (resp.type === "response.error") await this.#post(channel, `⚠️ Not delivered: ${resp.error}`);
  }

  // ── What a session says, to the DM ────────────────────────────────────

  #forward(userId: string, msg: DaemonMessage): void {
    const state = this.#users.get(userId);
    if (!state?.dmChannel) return;
    // Another session's broadcast, after a switch: not this DM's.
    if ("sessionId" in msg && typeof msg.sessionId === "string" && msg.sessionId !== state.attachedSessionId) return;
    const channel = state.dmChannel;
    if (msg.type === "session.message") {
      const m = msg;
      if (m.role === "assistant") {
        // A reply streams as deltas; its final broadcast carries the whole text, but not always: what
        // hasn't been posted is posted at the turn's end.
        if (m.content) {
          state.streams.delete(m.messageId);
          this.#say(userId, channel, esc(m.content));
        } else if (!state.streams.has(m.messageId)) state.streams.set(m.messageId, "");
      } else if (m.role === "tool_call" && m.tool?.state.phase === "waiting_confirmation" && "approvalId" in m.tool.state) {
        const tool = m.tool;
        // Bound now: the session it came from and the sign-in it came to (H1).
        const epoch = state.epoch;
        const sessionId = m.sessionId;
        const messageId = m.messageId;
        this.#queue(userId, () => (state.epoch === epoch ? this.#approvalCard(userId, state, tool, sessionId, channel, messageId) : Promise.resolve()));
      } else if (m.role === "system" && m.content) {
        this.#say(userId, channel, `⚠️ ${esc(m.content)}`);
      }
      return;
    }
    if (msg.type === "session.message.delta") {
      if (msg.contentAppend && state.streams.has(msg.messageId)) state.streams.set(msg.messageId, (state.streams.get(msg.messageId) ?? "") + msg.contentAppend);
      // A card's call answered elsewhere (the web UI, the CLI) or cancelled: its buttons go.
      const phase = msg.toolStateUpdate?.phase;
      if (phase && phase !== "waiting_confirmation") {
        this.#answered.add(msg.messageId);
        if (this.#answered.size > 1000) this.#answered.delete(this.#answered.values().next().value!);
        for (const key of this.#cardOfMessage.get(msg.messageId) ?? []) {
          const card = this.#approvals.get(key);
          if (!card) continue;
          this.#dropCard(key);
          if (card.ts) this.#queue(card.userId, () => this.#update(card.channel, card.ts!, "Answered elsewhere."));
        }
        this.#cardOfMessage.delete(msg.messageId);
      }
      return;
    }
    if (msg.type === "session.status_change" && (msg.status === "idle" || msg.status === "error")) {
      for (const text of state.streams.values()) if (text.trim()) this.#say(userId, channel, esc(text));
      state.streams.clear();
      if (msg.status === "error") this.#say(userId, channel, "❌ The turn ended with an error.");
      return;
    }
    if (msg.type === "session.ui_request") {
      this.#say(userId, channel, `❓ ${esc(msg.title)} — answer it in the web UI or with \`codeoid attach\`.`);
    }
  }

  /** Post `text` after everything already queued for this user, so replies and cards keep their order. */
  #say(userId: string, channel: string, text: string): void {
    this.#queue(userId, () => this.#post(channel, text));
  }

  #queue(userId: string, job: () => Promise<void>): void {
    const state = this.#users.get(userId);
    if (!state) return;
    state.outbox = state.outbox.then(job, job).catch(() => {});
  }

  // ── Approval cards ────────────────────────────────────────────────────

  async #approvalCard(userId: string, state: UserState, tool: ToolInfo, sessionId: string, channel: string, messageId?: string): Promise<void> {
    const st = tool.state;
    if (st.phase !== "waiting_confirmation" || !state.auth) return;
    // A question for you (AskUserQuestion) needs its options, which a card here can't take: say where to answer.
    if (tool.name === "AskUserQuestion") {
      await this.#post(channel, "❓ A question is waiting for you — answer it in the web UI or with `codeoid attach`.");
      return;
    }
    this.#prune();
    // Answered meanwhile (in the web UI, while this waited its turn to post): nothing to show.
    if (messageId && this.#answered.has(messageId)) return;
    const key = `${userId}:${st.approvalId}`;
    if (this.#approvals.has(key)) return;
    const pending: PendingApproval = { approvalId: st.approvalId, sessionId, userId, channel, createdAt: Date.now(), ...(messageId ? { messageId } : {}) };
    this.#approvals.set(key, pending);
    if (messageId) {
      const keys = this.#cardOfMessage.get(messageId) ?? new Set<string>();
      keys.add(key);
      this.#cardOfMessage.set(messageId, keys);
    }
    // What runs, from its input: the description only names the tool and its arguments.
    const lines = [`*Approval needed* — \`${esc(tool.name)}\``, callText(tool.name, st.input)];
    const tw = st.targetWorkstream;
    if (tw?.workstream) lines.push(`⌂ workstream *${esc(tw.workstream)}*`);
    if (tw?.warning) lines.push(`⚠ ${esc(tw.warning)}`);
    const risk = formatToolRisk(st.risk);
    if (risk) lines.push(`▲ ${esc(risk)}`);
    const sandbox = approvalSandboxLine(st);
    if (sandbox) lines.push(esc(sandbox));
    if (st.collaborationCost) lines.push(`◇ ${esc(formatCollaborationCost(st.collaborationCost))}`);
    const text = lines.join("\n");
    try {
      const res = await slackApi<{ ts: string }>(this.#transportOrDefault(), this.#botToken, "chat.postMessage", {
        channel: pending.channel,
        text: `Approval needed — ${tool.name}`,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [
          // Split across sections (each holds 3000), never cut.
          ...sections(text),
          {
            type: "actions",
            block_id: "codeoid_approval",
            elements: [
              { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve", value: st.approvalId },
              { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: "deny", value: st.approvalId },
            ],
          },
        ],
      });
      pending.ts = res.ts;
    } catch (err) {
      console.error(`[codeoid:slack] approval card failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.#post(pending.channel, `⚠️ An approval is waiting that couldn't be shown here — answer it in the web UI or with \`codeoid approve\`.`);
    }
  }

  async #interactive(p: Record<string, unknown>): Promise<void> {
    if (p.type !== "block_actions") return;
    const userId = String((p.user as { id?: unknown } | undefined)?.id ?? "");
    const action = ((p.actions as Array<{ action_id?: string; value?: string }> | undefined) ?? [])[0];
    if (!action || (action.action_id !== "approve" && action.action_id !== "deny")) return;
    const channel = String((p.channel as { id?: unknown } | undefined)?.id ?? (p.container as { channel_id?: unknown } | undefined)?.channel_id ?? "");
    const ts = String((p.message as { ts?: unknown } | undefined)?.ts ?? (p.container as { message_ts?: unknown } | undefined)?.message_ts ?? "");
    const say = (text: string) => (channel && ts ? this.#update(channel, ts, text) : Promise.resolve());
    if (!this.#allowed.has(userId)) return;
    // Keyed by the presser: a card shared with someone else can't be pressed by them.
    const key = `${userId}:${action.value ?? ""}`;
    const pending = this.#approvals.get(key);
    if (!pending) {
      // A press repeated (a double click, Slack resending it): the first already said what happened.
      if (this.#justAnswered.has(key)) return;
      const someoneElses = [...this.#approvals.keys()].some((k) => k.endsWith(`:${action.value}`));
      await say(someoneElses ? "This approval isn't yours." : "This approval is no longer waiting.");
      return;
    }
    this.#dropCard(key);
    this.#justAnswered.add(key);
    if (this.#justAnswered.size > 500) this.#justAnswered.delete(this.#justAnswered.values().next().value!);
    if (Date.now() - pending.createdAt > this.#approvalTtlMs) {
      await say("This approval expired.");
      return;
    }
    const state = this.#authed(userId);
    if (typeof state === "string") {
      await say(state);
      return;
    }
    const approved = action.action_id === "approve";
    const resp = await this.#manager.handle(
      { type: "session.approve", id: randomUUID(), sessionId: pending.sessionId, approvalId: pending.approvalId, approved },
      state.auth!,
      this.#client(userId, state),
    );
    if (resp.type === "response.error") await say(`⚠️ ${resp.error}`);
    else await say(approved ? "✅ Approved" : "❌ Denied");
  }

  #prune(): void {
    const now = Date.now();
    for (const [k, a] of this.#approvals) if (now - a.createdAt > this.#approvalTtlMs) this.#dropCard(k);
    while (this.#approvals.size >= MAX_PENDING_APPROVALS) {
      const oldest = this.#approvals.keys().next().value;
      if (!oldest) break;
      this.#dropCard(oldest);
    }
  }

  /** Forget one card, and its place in #cardOfMessage. */
  #dropCard(key: string): void {
    const card = this.#approvals.get(key);
    this.#approvals.delete(key);
    if (!card?.messageId) return;
    const keys = this.#cardOfMessage.get(card.messageId);
    keys?.delete(key);
    if (keys && keys.size === 0) this.#cardOfMessage.delete(card.messageId);
  }

  // ── "Needs you": another of your sessions waits on you ────────────────

  #needsYou(sessionId: string, name: string, owner: { sub: string; accountId: string; projectId: string }): void {
    for (const [userId, state] of this.#users) {
      const a = state.auth;
      const channel = state.dmChannel;
      if (!a || !channel || this.#expired(state)) continue;
      if (a.sub !== owner.sub || a.accountId !== owner.accountId || a.projectId !== owner.projectId) continue;
      // The attached session's cards come with the conversation.
      if (state.attachedSessionId === sessionId) continue;
      const told = `${userId}:${sessionId}`;
      if (Date.now() - (this.#toldNeeds.get(told) ?? 0) < 10 * 60 * 1000) continue;
      this.#toldNeeds.set(told, Date.now());
      if (this.#toldNeeds.size > 1000) this.#toldNeeds.clear();
      this.#queue(userId, () => this.#post(channel, `🔔 *${esc(name)}* is waiting for you. \`/codeoid attach ${esc(name)}\` to answer it here.`));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  #state(userId: string): UserState {
    let s = this.#users.get(userId);
    if (!s) {
      s = { auth: null, rawToken: null, attachedSessionId: null, attachedName: null, clientId: `slack:${userId}`, dmChannel: null, streams: new Map(), outbox: Promise.resolve(), epoch: 0 };
      this.#users.set(userId, s);
    }
    return s;
  }

  /** The user's state when signed in and unexpired, else what to tell them. Every command re-checks expiry. */
  #authed(userId: string): UserState | string {
    const state = this.#users.get(userId);
    if (!state?.auth) return "Not signed in. Run `/codeoid auth <zid_sk_…>`.";
    if (this.#expired(state)) {
      this.#forget(userId, state);
      return "Your sign-in expired. Run `/codeoid auth <zid_sk_…>` again.";
    }
    return state;
  }

  #expired(state: UserState): boolean {
    const exp = state.auth?.exp;
    return typeof exp === "number" && exp > 0 && exp <= Math.floor(Date.now() / 1000);
  }

  /** Let go of a user's identity, attachment and pending cards: a card is never answered under another sign-in. */
  #forget(userId: string, state: UserState): void {
    state.epoch++;
    state.auth = null;
    state.rawToken = null;
    try {
      this.#manager.disconnectClient(state.clientId);
    } catch {}
    state.attachedSessionId = null;
    state.attachedName = null;
    state.streams.clear();
    for (const [k, a] of this.#approvals) if (a.userId === userId) this.#dropCard(k);
  }

  #client(userId: string, state: UserState): AttachedClient {
    return { id: state.clientId, auth: state.auth!, send: (msg: DaemonMessage) => this.#forward(userId, msg) };
  }

  #transportOrDefault(): SlackTransport {
    return this.#transport ?? defaultTransport;
  }

  async #post(channel: string, text: string): Promise<void> {
    for (let i = 0; i < text.length || i === 0; i += CHUNK) {
      try {
        await slackApi(this.#transportOrDefault(), this.#botToken, "chat.postMessage", { channel, text: text.slice(i, i + CHUNK), mrkdwn: true, unfurl_links: false, unfurl_media: false });
      } catch (err) {
        console.error(`[codeoid:slack] post failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
  }

  async #update(channel: string, ts: string, text: string): Promise<void> {
    try {
      await slackApi(this.#transportOrDefault(), this.#botToken, "chat.update", { channel, ts, text, blocks: [] });
    } catch (err) {
      console.error(`[codeoid:slack] update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Slack's three control characters, escaped for mrkdwn (a name or text can't make a mention or a link). */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Whether a DM looks like a credential pasted by mistake: a ZeroID key, a
 * JWT, or a Slack token. It is never forwarded to a session.
 */
export function looksLikeSecret(text: string): boolean {
  return (
    new RegExp(`(?:${KNOWN_KEY_FORMATS})`).test(text) ||
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
  );
}

/** Most characters of a call a card shows; past it the card says it was cut. */
export const CALL_SHOWN = 2_400;

/**
 * What a tool call would do, as a card shows it: the command a shell runs,
 * the file a write or edit touches with what it writes, a plan; else its
 * input whole. Escaped for Slack, and cut only with a note saying so.
 */
export function callText(_toolName: string, input: unknown): string {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  let head = "";
  let body: string;
  const command = str(i.command) ?? str(i.cmd);
  const path = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
  if (command !== undefined) body = command;
  else if (str(i.plan) !== undefined) body = str(i.plan)!;
  else if (path !== undefined && (str(i.content) !== undefined || str(i.new_string) !== undefined)) {
    head = path;
    body = str(i.content) ?? `${str(i.old_string) ?? ""}\n→\n${str(i.new_string) ?? ""}`;
  } else body = JSON.stringify(input ?? {}, null, 2);
  const cut = body.length > CALL_SHOWN;
  const shown = esc(cut ? body.slice(0, CALL_SHOWN) : body).replace(/```/g, "ˋˋˋ");
  return `${head ? `\`${esc(head)}\`\n` : ""}\`\`\`${shown}\`\`\`${cut ? `\n_(cut short at ${CALL_SHOWN} of ${body.length} characters: see the whole call in the web UI or with \`codeoid approve\`)_` : ""}`;
}

/** Text as mrkdwn section blocks of at most CHUNK characters each, split at line ends where it can. */
function sections(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let rest = text;
  while (rest.length > 0) {
    let at = rest.length <= CHUNK ? rest.length : rest.lastIndexOf("\n", CHUNK);
    if (at <= 0) at = Math.min(CHUNK, rest.length);
    out.push({ type: "section", text: { type: "mrkdwn", text: rest.slice(0, at) } });
    rest = rest.slice(at).replace(/^\n/, "");
  }
  return out;
}
