/**
 * ControlMcpHttp — the OUTWARD control-plane MCP endpoint (`/mcp/control`,
 * docs/mcp-control.md, #251). An external agent — Claude Code, Cursor, a CI
 * job — mounts this URL and drives codeoid sessions: list them, read their
 * transcript and usage, and (when the operator allows actions) create, prompt,
 * interrupt, and destroy them.
 *
 * It is the most dangerous surface in the daemon, so its one design rule is
 * that it does NOT grow a parallel authorization path:
 *
 *   - **Same verifier.** The bearer token is verified per request by the exact
 *     TokenVerifier the WebSocket handshake uses (ZeroID JWT, or the local-mode
 *     token). There is no static key, no separate token store. Revocation and
 *     expiry behave as they do for a socket — better, since every request
 *     re-verifies.
 *   - **Same enforcement.** Every tool builds an ordinary `ClientMessage`,
 *     validates it with the protocol schema (`parseClientMessage`, so the same
 *     size limits apply), and runs it through `SessionManager.handle` — the
 *     function that enforces scopes and tenancy for every WebSocket frame. A
 *     token that cannot `session:create` over WebSocket cannot over MCP, by
 *     construction rather than by a second copy of the check.
 *   - **The fleet.ts READ/SEND split.** Observe tools are always available
 *     once the endpoint is on; send-class tools exist only when the operator
 *     set `mcpControl.allowActions`. And there is deliberately NO approve
 *     tool: an external agent can prompt a session, but every privileged tool
 *     call the session's agent makes still parks on the owner's own approval
 *     flow. Driving a session is not the same as authorizing what it does.
 *   - **Attributed.** Every call writes an `mcp.control.call` audit row under
 *     the caller's subject (and its delegator, for an agent token), on top of
 *     the rows `handle` already writes (`session.send`, …).
 *
 * Stateless by design: no Mcp-Session-Id, no SSE stream. Each POST carries its
 * own credential, gets one JSON-RPC response, and leaves nothing behind except
 * a transient observer client that is disconnected before the response goes.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseClientMessage } from "@highflame/codeoid-protocol/schemas";
import { hasScope, SCOPES, type Scope } from "../../protocol/scopes.js";
import { CAPABILITIES, LIMITS } from "../../protocol/types.js";
import type {
  AuthContext,
  ClientMessage,
  DaemonMessage,
  SessionInfo,
  SessionMessage,
} from "../../protocol/types.js";
import type { AttachedClient } from "../session.js";
import type { TokenVerifier } from "../verifier.js";
import type { McpControlConfig } from "../../config.js";
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  ok,
  rpcErr,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "./jsonrpc-http.js";

import { CONTROL_MCP_PATH } from "./control-path.js";

export { CONTROL_MCP_PATH };

const SERVER_INFO = { name: "codeoid", version: "0.1.0" } as const;

const INSTRUCTIONS = [
  "codeoid runs coding-agent sessions (Claude, Codex, Gemini, …) that live in a daemon.",
  "Use list_sessions / get_session to find one, read_transcript to see what it did,",
  "send_message (with wait=true) to prompt it and get its reply.",
  "A session whose status is waiting_approval is blocked on its human owner:",
  "this endpoint cannot approve tool calls — tell the user instead of retrying.",
].join(" ");

/** Room for the largest prompt the protocol accepts (SEND_TEXT_MAX chars)
 *  even when every char is a JSON `\uXXXX` escape, plus the envelope. The
 *  schema still enforces the real limit; this only bounds what is buffered. */
const MAX_BODY_BYTES = 6 * LIMITS.SEND_TEXT_MAX + 64 * 1024;
/** Per-message content cap in tool output, so one huge tool result can't
 *  flood the calling agent's context. */
const MESSAGE_CONTENT_MAX = 8_000;
const TRANSCRIPT_DEFAULT_BYTES = 64 * 1024;
const TRANSCRIPT_MAX_BYTES = 256 * 1024;
const WAIT_POLL_MS = 500;
/**
 * Concurrent waits one subject may hold. Each wait polls the session list
 * twice a second, so without a bound one token could pin the event loop with
 * a few hundred parallel calls. Generous for real use (a CI fan-out), small
 * against abuse.
 */
export const MAX_WAITS_PER_SUBJECT = 16;

/** What the endpoint needs from the daemon — narrow on purpose, so the
 *  unit tests can stand it up without a SessionManager. */
export interface ControlHost {
  handle(msg: ClientMessage, auth: AuthContext, client: AttachedClient): Promise<DaemonMessage>;
  disconnectClient(clientId: string): void;
  audit(subject: string, action: string, sessionId?: string, detail?: string): void;
}

export interface ControlMcpOptions {
  verifier: TokenVerifier;
  host: ControlHost;
  config: McpControlConfig;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Bound on a single daemon call (default maxWaitSeconds + 30 s). Tests only. */
  callDeadlineMs?: number;
}

/** A tool failure the caller should see as `isError: true` text, not a crash. */
class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface CallContext {
  auth: AuthContext;
  signal: AbortSignal;
  /** Admit one wait for this subject, or throw rate_limited; returns the release. */
  admitWait(): () => void;
  /** Run one ClientMessage through SessionManager.handle (schema-validated). */
  call(msg: Record<string, unknown>): Promise<DaemonMessage>;
  /** The session the call ended up acting on — recorded in the audit row. */
  sessionId?: string;
}

interface ToolDef {
  name: string;
  /** `read` tools observe; `act` tools change something and need allowActions. */
  kind: "read" | "act";
  /** The caller needs at least one of these to see the tool listed. The
   *  daemon's `handle` is still the authority — this only keeps tools/list
   *  honest about what will work. */
  anyScope: readonly Scope[];
  description: string;
  inputSchema: Record<string, unknown>;
  args: z.ZodType<Record<string, unknown>>;
  run(args: Record<string, unknown>, ctx: CallContext): Promise<unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unwrap a daemon response, turning `response.error` into a ToolError. */
function expectOk(res: DaemonMessage): DaemonMessage {
  if (res.type === "response.error") throw new ToolError(res.error, res.code ?? "error");
  return res;
}

function canRead(auth: AuthContext): boolean {
  const s = auth.scopes as string[];
  return hasScope(s, SCOPES.SESSION_ATTACH) || hasScope(s, SCOPES.SESSION_WATCH);
}

/** The fields an outside agent needs to reason about a session. */
function summarize(info: SessionInfo): Record<string, unknown> {
  return {
    id: info.id,
    name: info.name,
    status: info.status,
    ...(info.turnQueued ? { turnQueued: true } : {}),
    workdir: info.workdir,
    provider: info.providerId,
    model: info.model,
    mode: info.mode,
    ...(info.role ? { role: info.role } : {}),
    createdBy: info.createdBy,
    createdAt: info.createdAt,
    lastActivityAt: info.lastActivityAt,
    attachedClients: info.attachedClients,
    ...(info.pendingDialog ? { pendingDialog: { title: info.pendingDialog.title, message: info.pendingDialog.message } } : {}),
    ...(info.usage ? { usage: usageTotals(info.usage) } : {}),
  };
}

/** The totals an outside agent reasons about — not the per-turn history,
 *  which would spend its context on every list. */
function usageTotals(u: NonNullable<SessionInfo["usage"]>): Record<string, unknown> {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    totalCostUsd: u.totalCostUsd,
    numTurns: u.numTurns,
    ...(u.contextWindow !== undefined ? { contextWindow: u.contextWindow } : {}),
    ...(u.lastTurnInputTokens !== undefined ? { lastTurnInputTokens: u.lastTurnInputTokens } : {}),
  };
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function shapeMessage(m: SessionMessage): Record<string, unknown> {
  const c = clip(m.content ?? "", MESSAGE_CONTENT_MAX);
  return {
    messageId: m.messageId,
    role: m.role,
    content: c.text,
    ...(c.truncated ? { truncated: true } : {}),
    // Phase only: the full state carries the tool's input/output, which the
    // capped `content` already summarizes.
    ...(m.tool ? { tool: { name: m.tool.name, phase: m.tool.state?.phase } } : {}),
    from: m.identity?.sub,
    timestamp: m.timestamp,
    ...(m.turnId ? { turnId: m.turnId } : {}),
  };
}

/**
 * Not working any more, from an outside caller's point of view: the turn ended
 * (idle/error), or it is parked on something only the owner can resolve (a
 * tool approval or a provider dialog). A queued-but-unstarted prompt is work.
 */
function settled(info: SessionInfo): boolean {
  if (info.status === "waiting_approval" || info.pendingDialog) return true;
  return (info.status === "idle" || info.status === "error") && !info.turnQueued;
}

/**
 * Resolve a session reference (id, or exact name) within the caller's tenant.
 * Goes through `session.list`, so a name lookup inherits the same tenancy
 * filter as every other read. A caller without `session:list` can still act
 * by id — `handle` re-checks ownership on the actual call.
 */
async function resolveSession(ctx: CallContext, ref: string): Promise<SessionInfo | { id: string }> {
  const res = await ctx.call({ type: "session.list" });
  if (res.type !== "session.list.result") {
    if (res.type === "response.error" && res.code === "forbidden") return { id: ref };
    expectOk(res);
    throw new ToolError("Unexpected response to session.list", "internal");
  }
  const byId = res.sessions.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = res.sessions.filter((s) => s.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new ToolError(
      `"${ref}" names ${byName.length} sessions — pass an id: ${byName.map((s) => s.id).join(", ")}`,
      "invalid_request",
    );
  }
  throw new ToolError(`Session not found: ${ref}`, "not_found");
}

/** Resolve, record for audit, and return the full info (or throw not_found). */
async function sessionInfo(ctx: CallContext, ref: string): Promise<SessionInfo> {
  const found = await resolveSession(ctx, ref);
  if (!("status" in found)) throw new ToolError("Missing scope: session:list", "forbidden");
  // Only a session that was actually found goes in the audit row — never the
  // caller's raw reference.
  ctx.sessionId = found.id;
  return found;
}

/**
 * Act tools touch only ordinary sessions. The conductor and its dispatched
 * workers belong to the dispatcher (leases, budgets, its own approval flow);
 * an outside caller prompting or destroying one would fight that owner, and
 * prompting the conductor would be dispatch-by-proxy, which v1 leaves out.
 */
async function actionTarget(ctx: CallContext, ref: string): Promise<string> {
  const found = await resolveSession(ctx, ref);
  // Fail closed: without session:list the target's role is unknowable, and
  // acting blind would let a send-only token prompt the conductor or destroy
  // a dispatcher's worker — the very thing this check exists to refuse.
  if (!("status" in found)) {
    throw new ToolError("acting through this endpoint also needs session:list, to verify the target session", "forbidden");
  }
  if (found.role) {
    throw new ToolError(
      `"${found.name}" is a ${found.role} session — it is driven by codeoid's own dispatcher, not over this endpoint`,
      "forbidden",
    );
  }
  // A collaborative goal's orchestrator spawns and steers role children:
  // prompting it is dispatch by proxy, which v1 leaves out.
  if (found.collaboration || found.collaborationRole) {
    throw new ToolError(
      `"${found.name}" is part of a collaborative session — drive it from codeoid itself, not over this endpoint`,
      "forbidden",
    );
  }
  // Anything else steering it (a live pipeline run injecting its phases).
  if (found.managedBy) {
    throw new ToolError(
      `"${found.name}" is being driven by a ${found.managedBy} run — wait for it to finish, or act on the ${found.managedBy} itself`,
      "forbidden",
    );
  }
  ctx.sessionId = found.id;
  return found.id;
}

/** The newest transcript page, shaped. Requires attach/watch scope. */
async function newestPage(
  ctx: CallContext,
  sessionId: string,
  maxBytes: number,
  before?: string,
): Promise<{ messages: SessionMessage[]; hasMore: boolean }> {
  const res = expectOk(
    await ctx.call({
      type: "scrollback.page",
      sessionId,
      ...(before ? { beforeMessageId: before } : {}),
      maxBytes,
    }),
  );
  if (res.type !== "scrollback.page.result") throw new ToolError("Unexpected response to scrollback.page", "internal");
  return { messages: res.messages, hasMore: res.hasMore };
}

type WaitResult = { info: SessionInfo; settled: boolean } | { gone: true };

async function waitUntilSettled(
  ctx: CallContext,
  sessionId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  /** A slot already admitted by the caller (send_message admits before it
   *  sends); otherwise one is admitted here. Released either way. */
  admitted?: () => void,
): Promise<WaitResult> {
  const release = admitted ?? ctx.admitWait();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let info: SessionInfo;
      try {
        info = await sessionInfo(ctx, sessionId);
      } catch (err) {
        // Destroyed while we waited (by its owner, or another caller).
        if (err instanceof ToolError && err.code === "not_found") return { gone: true };
        throw err;
      }
      if (settled(info)) return { info, settled: true };
      if (Date.now() >= deadline || ctx.signal.aborted) return { info, settled: false };
      await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  } finally {
    release();
  }
}

/**
 * What the session said in answer to the caller's latest prompt: the assistant
 * messages after the newest user message this caller sent. Best effort — if
 * the prompt has scrolled out of the newest page, the page's assistant tail is
 * returned instead.
 */
function replyTo(
  messages: SessionMessage[],
  sub: string,
  text: string,
): { reply: Record<string, unknown>[]; notices: Record<string, unknown>[] } {
  // Anchor on THIS prompt — the newest user message from this caller with this
  // text — so another prompt from the same identity (a person at the TUI in
  // local mode, a second call) doesn't capture the reply. Falls back to the
  // caller's newest prompt when the text isn't found verbatim.
  const mine = (m: SessionMessage) => m.role === "user" && m.identity?.sub === sub;
  let start = -1;
  for (let i = messages.length - 1; i >= 0 && start < 0; i--) {
    if (mine(messages[i]!) && messages[i]!.content === text) start = i + 1;
  }
  for (let i = messages.length - 1; i >= 0 && start < 0; i--) {
    if (mine(messages[i]!)) start = i + 1;
  }
  if (start < 0) start = 0;
  // ...and stops at the next prompt, whoever sent it.
  let end = messages.length;
  for (let i = start; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      end = i;
      break;
    }
  }
  const after = messages.slice(start, end);
  return {
    reply: after.filter((m) => m.role === "assistant").map(shapeMessage),
    // System rows are where a failed send, a turn error, or an interrupt is
    // explained — without them an `error` outcome arrives with no reason.
    notices: after.filter((m) => m.role === "system").map(shapeMessage),
  };
}

function outcomeOf(info: SessionInfo, isSettled: boolean): string {
  if (!isSettled) return "still_working";
  if (info.status === "waiting_approval") return "waiting_approval";
  if (info.pendingDialog) return "waiting_dialog";
  return info.status === "error" ? "error" : "idle";
}

// ── Tools ────────────────────────────────────────────────────────────────────

const sessionRef = z.string().min(1).max(256);
const sessionRefSchema = { type: "string", description: "Session id, or its exact name." };

function buildTools(config: McpControlConfig, sleep: (ms: number) => Promise<void>): ToolDef[] {
  const maxWait = config.maxWaitSeconds;
  const waitSeconds = z.number().int().min(1).max(maxWait).optional();
  const waitSchema = {
    type: "integer",
    minimum: 1,
    maximum: maxWait,
    description: `How long to wait, in seconds (default ${Math.min(60, maxWait)}, max ${maxWait}).`,
  };
  const defaultWaitMs = Math.min(60, maxWait) * 1000;

  return [
    {
      name: "list_sessions",
      kind: "read",
      anyScope: [SCOPES.SESSION_LIST],
      description: "List the sessions you can see, with status, backend, workdir and token/cost usage.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["idle", "thinking", "tool_running", "waiting_approval", "error"],
            description: "Only sessions in this status.",
          },
        },
        additionalProperties: false,
      },
      args: z.object({ status: z.enum(["idle", "thinking", "tool_running", "waiting_approval", "error"]).optional() }).strict(),
      async run(args, ctx) {
        const res = expectOk(await ctx.call({ type: "session.list" }));
        if (res.type !== "session.list.result") throw new ToolError("Unexpected response", "internal");
        const sessions = res.sessions.filter((s) => !args.status || s.status === args.status).map(summarize);
        return { sessions };
      },
    },
    {
      name: "get_session",
      kind: "read",
      anyScope: [SCOPES.SESSION_LIST],
      description:
        "One session's status and usage, plus the tool calls it is waiting on its owner to approve (when you hold session:watch).",
      inputSchema: { type: "object", properties: { session: sessionRefSchema }, required: ["session"], additionalProperties: false },
      args: z.object({ session: sessionRef }).strict(),
      async run(args, ctx) {
        const info = await sessionInfo(ctx, args.session as string);
        const out: Record<string, unknown> = { session: summarize(info) };
        if (canRead(ctx.auth)) {
          const res = await ctx.call({ type: "session.approvals", sessionId: info.id });
          if (res.type === "session.approvals.result") {
            // Names only: the full input is session content an approver needs
            // in full, and this endpoint cannot approve anyway.
            out.pendingApprovals = res.approvals.map((a) => ({ approvalId: a.approvalId, tool: a.toolName }));
          }
        }
        return out;
      },
    },
    {
      name: "read_transcript",
      kind: "read",
      anyScope: [SCOPES.SESSION_ATTACH, SCOPES.SESSION_WATCH],
      description:
        "Read a session's messages, newest page first (oldest→newest within the page). Pass `before` = the returned cursor to page older history.",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionRefSchema,
          before: { type: "string", description: "Page history older than this messageId (the `before` cursor of a previous page)." },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: TRANSCRIPT_MAX_BYTES,
            description: `Soft size budget for the page (default ${TRANSCRIPT_DEFAULT_BYTES}).`,
          },
          roles: {
            type: "array",
            items: { type: "string", enum: ["user", "assistant", "thinking", "tool_call", "tool_result", "system", "info"] },
            description: "Only these message roles.",
          },
        },
        required: ["session"],
        additionalProperties: false,
      },
      args: z
        .object({
          session: sessionRef,
          before: z.string().min(1).max(256).optional(),
          maxBytes: z.number().int().min(1024).max(TRANSCRIPT_MAX_BYTES).optional(),
          roles: z.array(z.enum(["user", "assistant", "thinking", "tool_call", "tool_result", "system", "info"])).max(7).optional(),
        })
        .strict(),
      async run(args, ctx) {
        const found = await resolveSession(ctx, args.session as string);
        const page = await newestPage(
          ctx,
          found.id,
          (args.maxBytes as number | undefined) ?? TRANSCRIPT_DEFAULT_BYTES,
          args.before as string | undefined,
        );
        // Recorded only after the read succeeded: a bare id the caller could
        // not list is otherwise just caller text.
        ctx.sessionId = found.id;
        const roles = args.roles as string[] | undefined;
        return {
          messages: page.messages.filter((m) => !roles || roles.includes(m.role)).map(shapeMessage),
          hasMore: page.hasMore,
          // The cursor is the page's oldest message BEFORE role filtering, so
          // paging never skips history that a filter hid.
          ...(page.hasMore && page.messages.length > 0 ? { before: page.messages[0]!.messageId } : {}),
        };
      },
    },
    {
      name: "get_usage",
      kind: "read",
      anyScope: [SCOPES.SESSION_LIST],
      description:
        "Token and cost usage — for one session, or daily totals across all of yours (daily totals need the daemon's memory store enabled; without it they read zero).",
      inputSchema: {
        type: "object",
        properties: {
          session: { ...sessionRefSchema, description: "Session id or name. Omit for daily totals across your sessions." },
          days: { type: "integer", minimum: 1, maximum: 365, description: "Days of daily totals (default 30)." },
        },
        additionalProperties: false,
      },
      args: z.object({ session: sessionRef.optional(), days: z.number().int().min(1).max(365).optional() }).strict(),
      async run(args, ctx) {
        if (args.session) {
          const info = await sessionInfo(ctx, args.session as string);
          return { session: info.id, name: info.name, ...(info.usage ? { usage: usageTotals(info.usage) } : {}) };
        }
        const res = expectOk(await ctx.call({ type: "usage.daily", ...(args.days ? { days: args.days } : {}) }));
        return res.type === "response.ok" ? res.data : {};
      },
    },
    {
      name: "wait_for_session",
      kind: "read",
      anyScope: [SCOPES.SESSION_LIST],
      description:
        "Wait until a session stops working — its turn ended, or it is blocked on its owner (approval or dialog). Returns the status it settled in.",
      inputSchema: {
        type: "object",
        properties: { session: sessionRefSchema, timeoutSeconds: waitSchema },
        required: ["session"],
        additionalProperties: false,
      },
      args: z.object({ session: sessionRef, timeoutSeconds: waitSeconds }).strict(),
      async run(args, ctx) {
        const first = await sessionInfo(ctx, args.session as string);
        const timeoutMs = ((args.timeoutSeconds as number | undefined) ?? defaultWaitMs / 1000) * 1000;
        const waited = await waitUntilSettled(ctx, first.id, timeoutMs, sleep);
        if ("gone" in waited) return { outcome: "destroyed" };
        return { outcome: outcomeOf(waited.info, waited.settled), session: summarize(waited.info) };
      },
    },
    {
      name: "create_session",
      kind: "act",
      anyScope: [SCOPES.SESSION_CREATE],
      description: "Start a new coding-agent session in a directory on the daemon's host.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Session name." },
          workdir: { type: "string", description: "Absolute directory (or ~/…) the agent works in." },
          provider: { type: "string", description: "Backend id (claude, codex, gemini, …). Omit for the daemon default." },
          model: { type: "string", description: "Model for the backend. Omit for its default." },
        },
        required: ["name", "workdir"],
        additionalProperties: false,
      },
      args: z
        .object({
          name: z.string().min(1).max(256),
          workdir: z.string().min(1).max(4096),
          provider: z.string().min(1).max(64).optional(),
          model: z.string().min(1).max(256).optional(),
        })
        .strict(),
      async run(args, ctx) {
        // Only the fields listed above reach the daemon: no role, no
        // collaboration, no pack — an outside caller gets a plain session.
        const res = expectOk(
          await ctx.call({
            type: "session.create",
            name: args.name,
            workdir: args.workdir,
            ...(args.provider ? { providerId: args.provider } : {}),
            ...(args.model ? { model: args.model } : {}),
          }),
        );
        const info = res.type === "response.ok" ? (res.data as SessionInfo | undefined) : undefined;
        if (info?.id) ctx.sessionId = info.id;
        return { session: info ? summarize(info) : null };
      },
    },
    {
      name: "send_message",
      kind: "act",
      anyScope: [SCOPES.SESSION_SEND],
      description:
        "Send a prompt to a session. With wait=true, block until the reply is done (or the session needs its owner) and return the reply.",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionRefSchema,
          text: { type: "string", description: "The prompt." },
          wait: { type: "boolean", description: "Wait for the turn to finish and return the reply (needs session:list + session:watch)." },
          timeoutSeconds: waitSchema,
          idempotencyKey: {
            type: "string",
            description: "Reuse the same key when retrying an uncertain send — the daemon delivers it once.",
          },
        },
        required: ["session", "text"],
        additionalProperties: false,
      },
      args: z
        .object({
          session: sessionRef,
          text: z.string().min(1),
          wait: z.boolean().optional(),
          timeoutSeconds: waitSeconds,
          idempotencyKey: z.string().min(1).max(128).optional(),
        })
        .strict(),
      async run(args, ctx) {
        const id = await actionTarget(ctx, args.session as string);
        // Claim the wait slot BEFORE sending: refusing the wait after the
        // prompt went out would report an error for a send that happened, and
        // a retry would deliver the prompt twice.
        const slot = args.wait ? ctx.admitWait() : undefined;
        let res: DaemonMessage;
        try {
          res = expectOk(
            await ctx.call({
              type: "session.send",
              sessionId: id,
              text: args.text,
              ...(args.idempotencyKey ? { clientMsgId: args.idempotencyKey } : {}),
            }),
          );
        } catch (err) {
          slot?.();
          throw err;
        }
        const duplicate = res.type === "response.ok" && (res.data as { duplicate?: boolean } | undefined)?.duplicate === true;
        if (!slot) return { sent: true, ...(duplicate ? { duplicate: true } : {}) };

        // From here the prompt HAS been delivered: whatever goes wrong while
        // waiting is reported alongside `sent: true`, never as a tool error —
        // a caller that retries an error would deliver the prompt twice.
        const sent = { sent: true, ...(duplicate ? { duplicate: true } : {}) };
        try {
          const timeoutMs = ((args.timeoutSeconds as number | undefined) ?? defaultWaitMs / 1000) * 1000;
          const waited = await waitUntilSettled(ctx, id, timeoutMs, sleep, slot);
          if ("gone" in waited) return { ...sent, outcome: "destroyed" };
          const out: Record<string, unknown> = {
            ...sent,
            outcome: outcomeOf(waited.info, waited.settled),
            session: summarize(waited.info),
          };
          if (waited.settled && canRead(ctx.auth)) {
            const page = await newestPage(ctx, id, TRANSCRIPT_DEFAULT_BYTES);
            const { reply, notices } = replyTo(page.messages, ctx.auth.sub, args.text as string);
            out.reply = reply;
            if (notices.length > 0) out.notices = notices;
          }
          return out;
        } catch (err) {
          const why = err instanceof ToolError ? `${err.code}: ${err.message}` : String(err);
          return { ...sent, outcome: "wait_failed", error: why };
        }
      },
    },
    {
      name: "interrupt_session",
      kind: "act",
      anyScope: [SCOPES.SESSION_INTERRUPT],
      description: "Stop a session's current turn.",
      inputSchema: { type: "object", properties: { session: sessionRefSchema }, required: ["session"], additionalProperties: false },
      args: z.object({ session: sessionRef }).strict(),
      async run(args, ctx) {
        const id = await actionTarget(ctx, args.session as string);
        expectOk(await ctx.call({ type: "session.interrupt", sessionId: id }));
        return { interrupted: true };
      },
    },
    {
      name: "destroy_session",
      kind: "act",
      anyScope: [SCOPES.SESSION_DESTROY],
      description: "Destroy a session and stop its agent. Its transcript is deleted.",
      inputSchema: { type: "object", properties: { session: sessionRefSchema }, required: ["session"], additionalProperties: false },
      args: z.object({ session: sessionRef }).strict(),
      async run(args, ctx) {
        const id = await actionTarget(ctx, args.session as string);
        expectOk(await ctx.call({ type: "session.destroy", sessionId: id }));
        return { destroyed: true };
      },
    },
  ];
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

/**
 * The request body as text, or null once it passes `max` bytes. Streamed, so a
 * chunked body with no Content-Length is cut off at the cap instead of being
 * buffered whole before the size check.
 */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonError(status: number, error: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

export class ControlMcpHttp {
  readonly #verifier: TokenVerifier;
  readonly #host: ControlHost;
  readonly #config: McpControlConfig;
  readonly #tools: ToolDef[];
  /** Live waits per subject (see MAX_WAITS_PER_SUBJECT). */
  readonly #waits = new Map<string, number>();
  /** Upper bound on any single daemon call made for a tool. */
  readonly #callDeadlineMs: number;

  constructor(opts: ControlMcpOptions) {
    this.#callDeadlineMs = opts.callDeadlineMs ?? (opts.config.maxWaitSeconds + 30) * 1000;
    this.#verifier = opts.verifier;
    this.#host = opts.host;
    this.#config = opts.config;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.#tools = buildTools(opts.config, sleep);
  }

  /** Tools reachable at all under this config (before scope filtering). */
  get toolNames(): string[] {
    return this.#tools.filter((t) => this.#reachable(t)).map((t) => t.name);
  }

  #reachable(t: ToolDef): boolean {
    return t.kind === "read" || this.#config.allowActions;
  }

  #visibleTo(t: ToolDef, auth: AuthContext): boolean {
    const s = auth.scopes as string[];
    return this.#reachable(t) && t.anyScope.some((x) => hasScope(s, x));
  }

  /**
   * Bun.serve fetch handler for {@link CONTROL_MCP_PATH}.
   *
   * `liftIdleTimeout` lifts Bun's idle timeout for this one request. A tool
   * call that waits on an agent's turn is legitimately pending for minutes,
   * while Bun.serve's `idleTimeout` is 10 s and its per-request
   * `server.timeout` is silently capped near 255 s (measured on 1.3.13: a
   * 300 s setting cut a 270 s hold at 256 s) — below `maxWaitSeconds`' 600 s
   * ceiling. So the timeout is disabled rather than raised: the handler bounds
   * itself (every wait ends by `maxWaitSeconds`), it is applied only after
   * authentication and after the whole body has arrived, so a slow-trickled
   * body still meets the normal idle timeout, and it is restored before the
   * response, since Bun scopes it to the connection, not the request.
   *
   * There is no per-address throttle on failed authentication here: on a
   * loopback daemon every caller shares one address, so a throttle let any
   * local process lock out every valid caller, and it never covered the
   * WebSocket handshake anyway. Verification cost is bounded in the verifier
   * instead (see auth.ts — unknown-`kid` cooldown), for both transports.
   */
  async handle(
    req: Request,
    opts: {
      /** Lift the connection's idle timeout for this call; returns the restore. */
      liftIdleTimeout?: () => () => void;
    } = {},
  ): Promise<Response> {
    // DNS-rebinding guard (MCP Streamable HTTP §security): a browser page on
    // another origin must not reach a loopback daemon. Agents send no Origin.
    const origin = req.headers.get("origin");
    if (origin && !this.#config.allowedOrigins.includes(origin)) {
      return jsonError(403, "origin not allowed");
    }
    if (req.method !== "POST") {
      // No server-initiated SSE stream; some clients probe GET first.
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    // Header only — never `?token=`. This credential can create and prompt
    // sessions; a query string ends up in proxy and shell history.
    const authz = req.headers.get("authorization");
    const token = authz && /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, "").trim() : "";
    if (!token) return jsonError(401, "unauthorized", { "WWW-Authenticate": "Bearer" });

    let auth: AuthContext;
    try {
      auth = await this.#verifier.verify(token);
    } catch {
      // Fail closed, and don't echo why — the reason helps an attacker more
      // than a legitimate caller, who can check the token with `codeoid login`.
      return jsonError(401, "unauthorized", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
    }
    if (typeof auth.exp === "number" && auth.exp > 0 && auth.exp <= Math.floor(Date.now() / 1000)) {
      return jsonError(401, "unauthorized", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
    }
    if (this.#config.requireDelegated && auth.delegationDepth < 1) {
      this.#host.audit(auth.sub, "mcp.control.denied", undefined, "reason=not_delegated");
      return jsonError(403, "this endpoint accepts only delegated agent tokens");
    }

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return jsonError(413, "request too large");
    let raw: string | null;
    try {
      raw = await readCapped(req, MAX_BODY_BYTES);
    } catch {
      return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400 });
    }
    if (raw === null) return jsonError(413, "request too large");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400 });
    }
    // JSON-RPC batching was removed from MCP in 2025-06-18; one message per
    // POST also keeps one audit row per call.
    if (Array.isArray(body) || body === null || typeof body !== "object") {
      return Response.json(rpcErr(null, -32600, "Invalid Request: one JSON-RPC message per POST"), { status: 400 });
    }

    // Only a tool call can wait, and it ends itself by maxWaitSeconds. The
    // lift is restored before the response goes out: Bun applies a request's
    // timeout to its whole keep-alive SOCKET, so leaving it at 0 would let any
    // caller who made one valid call hold that connection open forever — and
    // a half-sent next request on it would never time out (measured).
    const restore = (body as JsonRpcMessage).method === "tools/call" ? opts.liftIdleTimeout?.() : undefined;
    let res: JsonRpcResponse | null;
    try {
      res = await this.#dispatch(body as JsonRpcMessage, auth, req.signal);
    } finally {
      restore?.();
    }
    if (!res) return new Response(null, { status: 202 });
    return Response.json(res);
  }

  async #dispatch(msg: JsonRpcMessage, auth: AuthContext, signal: AbortSignal): Promise<JsonRpcResponse | null> {
    if (msg.id === undefined) return null; // notification
    const id: JsonRpcId = msg.id;
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return ok(id, {
          protocolVersion: typeof requested === "string" ? requested : DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: this.#tools
            .filter((t) => this.#visibleTo(t, auth))
            .map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { readOnlyHint: t.kind === "read", destructiveHint: t.name === "destroy_session" },
            })),
        });
      case "tools/call":
        return ok(id, await this.#callTool(msg.params ?? {}, auth, signal));
      default:
        return rpcErr(id, -32601, `Method not found: ${String(msg.method)}`);
    }
  }

  async #callTool(
    params: Record<string, unknown>,
    auth: AuthContext,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const name = typeof params.name === "string" ? params.name.slice(0, 64) : "";
    const tool = this.#tools.find((t) => t.name === name);
    const clientId = `mcp-control:${randomUUID()}`;
    const ctx: CallContext = {
      auth,
      signal,
      admitWait: () => {
        const live = this.#waits.get(auth.sub) ?? 0;
        if (live >= MAX_WAITS_PER_SUBJECT) {
          throw new ToolError(`too many concurrent waits (${MAX_WAITS_PER_SUBJECT}) for this caller — poll get_session instead`, "rate_limited");
        }
        this.#waits.set(auth.sub, live + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const n = (this.#waits.get(auth.sub) ?? 1) - 1;
          if (n <= 0) this.#waits.delete(auth.sub);
          else this.#waits.set(auth.sub, n);
        };
      },
      call: async (partial) => {
        const parsed = parseClientMessage({ ...partial, id: randomUUID() });
        if (!parsed.ok) throw new ToolError(parsed.error, "invalid_request");
        // A sink: this endpoint never attaches, so nothing should stream to
        // it — but if a handler does send, drop it rather than throw.
        const client: AttachedClient = { id: clientId, auth, send: () => {}, capabilities: [CAPABILITIES.SCROLLBACK_PAGING] };
        // The connection's idle timeout is lifted during a tool call, so a
        // handler that never settles (a backend hung starting or tearing down)
        // would hold the socket forever. Bound every daemon call; the work
        // itself carries on in the daemon, the caller just stops waiting.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ToolError(`the daemon did not answer ${partial.type} within ${this.#callDeadlineMs / 1000}s`, "timeout")),
            this.#callDeadlineMs,
          );
        });
        try {
          return await Promise.race([this.#host.handle(parsed.value, auth, client), deadline]);
        } finally {
          clearTimeout(timer);
        }
      },
    };

    const result = (data: unknown, isError: boolean, code?: string): Record<string, unknown> => {
      this.#host.audit(
        auth.sub,
        "mcp.control.call",
        ctx.sessionId,
        [
          // Only a known tool name ever reaches the row — the caller's raw
          // `name` could carry spaces or newlines and forge other fields.
          `tool=${tool ? tool.name : "unknown"}`,
          `outcome=${isError ? `error:${code ?? "error"}` : "ok"}`,
          ...(auth.delegatedBy ? [`delegatedBy=${auth.delegatedBy}`] : []),
        ].join(" "),
      );
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      return {
        content: [{ type: "text", text }],
        ...(isError || typeof data === "string" ? {} : { structuredContent: data }),
        isError,
      };
    };

    if (!tool) return result(`Unknown tool: ${JSON.stringify(name)}`, true, "unknown_tool");
    if (!this.#reachable(tool)) {
      return result(
        `${tool.name} is disabled: this daemon allows observation only (set mcpControl.allowActions to enable it)`,
        true,
        "actions_disabled",
      );
    }
    const parsed = tool.args.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return result(`Invalid arguments: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"}`, true, "invalid_request");
    }
    try {
      return result(await tool.run(parsed.data, ctx), false);
    } catch (err) {
      if (err instanceof ToolError) return result(`${err.code}: ${err.message}`, true, err.code);
      return result(`internal: ${err instanceof Error ? err.message : String(err)}`, true, "internal");
    } finally {
      this.#host.disconnectClient(clientId);
    }
  }
}
