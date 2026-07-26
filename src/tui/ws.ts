/**
 * TUI WebSocket client — daemon connection + reducer dispatch.
 *
 * Separated from the React tree so the connection survives focus changes and
 * re-renders. Uses Bun's native WebSocket. Token exchange is identical to the
 * readline client (legacy terminal/client.ts) — we could refactor out the
 * shared logic later; for now correctness beats DRY.
 */

import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import type {
  Attachment,
  ClientMessage,
  DaemonMessage,
  SessionMessage,
  ToolState,
} from "../protocol/types.js";
import { ALL_SCOPES_STRING } from "../protocol/scopes.js";
import { resolveLocalToken } from "../config.js";
import type { CodeoidConfig } from "../config.js";
import type { Dispatch } from "react";
import type { TuiAction } from "./types.js";

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_AUTH_RECONNECTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Knobs for reconnect/heartbeat behavior. Production uses the defaults; tests
 * inject tiny intervals so the state machine is exercised without real waits. */
export interface TuiWsOptions {
  /** Liveness ping interval (ms). `0` disables the heartbeat. */
  heartbeatMs?: number;
  /** How long to wait for a ping reply before declaring the socket dead (ms). */
  heartbeatTimeoutMs?: number;
  /** Consecutive token-rejection (4003) reconnects to attempt before giving up. */
  maxAuthReconnects?: number;
  /** Initial reconnect backoff (ms); doubles up to MAX_RECONNECT_DELAY_MS. */
  reconnectDelayMs?: number;
}

interface PendingRequest {
  /** Resolve the request with the daemon's response; clears its own timer. */
  settle: (msg: DaemonMessage) => void;
  /** Reject the request (timeout, or socket closed under it); clears its timer. */
  fail: (err: Error) => void;
}

/**
 * Token-exchange failure with a retryability verdict. `transient` failures
 * (endpoint unreachable, 5xx, 429) get the same unbounded reconnect-with-
 * backoff as a dropped socket; non-transient ones (missing key, key rejected)
 * dead-end with a visible error — re-minting can't fix them (#83).
 */
export class TokenExchangeError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "TokenExchangeError";
    this.transient = transient;
  }
}

export class TuiWsClient {
  #config: CodeoidConfig;
  #dispatch: Dispatch<TuiAction>;
  #ws: WebSocket | null = null;
  #pending = new Map<string, PendingRequest>();
  #reconnectDelay: number;
  #reconnectDelayBase: number;
  #stopped = false;
  #heartbeatMs: number;
  #heartbeatTimeoutMs: number;
  #maxAuthReconnects: number;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive 4003 reconnects since the last successful auth.ok. */
  #authReconnects = 0;
  /** Guards against two reconnect loops racing (a 4003 close and a heartbeat
   * miss can fire for the same dead socket). */
  #reconnectPending = false;

  constructor(
    config: CodeoidConfig,
    dispatch: Dispatch<TuiAction>,
    opts: TuiWsOptions = {},
  ) {
    this.#config = config;
    this.#dispatch = dispatch;
    this.#heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#maxAuthReconnects = opts.maxAuthReconnects ?? DEFAULT_MAX_AUTH_RECONNECTS;
    this.#reconnectDelayBase = opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#reconnectDelay = this.#reconnectDelayBase;
  }

  async start(): Promise<void> {
    await this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#stopHeartbeat();
    this.#rejectPending("client stopped");
    this.#ws?.close();
    this.#ws = null;
  }

  // ── Session operations ────────────────────────────────────────────────

  listSessions(): Promise<DaemonMessage> {
    return this.#request({ type: "session.list", id: randomUUID() });
  }

  createSession(name: string, workdir: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.create", id: randomUUID(), name, workdir });
  }

  attachSession(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.attach", id: randomUUID(), sessionId });
  }

  detachSession(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.detach", id: randomUUID(), sessionId });
  }

  send(
    sessionId: string,
    text: string,
    attachments?: readonly Attachment[],
    priority?: "now" | "next" | "later",
  ): Promise<DaemonMessage> {
    return this.#request({
      type: "session.send",
      id: randomUUID(),
      sessionId,
      text,
      attachments:
        attachments && attachments.length > 0 ? [...attachments] : undefined,
      priority,
    });
  }

  pin(sessionId: string, path: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.pin", id: randomUUID(), sessionId, path });
  }

  unpin(sessionId: string, path: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.unpin", id: randomUUID(), sessionId, path });
  }

  setMode(
    sessionId: string,
    mode: import("../protocol/types.js").SessionMode,
    maxTurns?: number,
  ): Promise<DaemonMessage> {
    return this.#request({
      type: "session.set_mode",
      id: randomUUID(),
      sessionId,
      mode,
      maxTurns,
    });
  }

  interrupt(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.interrupt", id: randomUUID(), sessionId });
  }

  approve(sessionId: string, approvalId: string, approved: boolean): Promise<DaemonMessage> {
    return this.#request({
      type: "session.approve",
      id: randomUUID(),
      sessionId,
      approvalId,
      approved,
    });
  }

  destroy(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.destroy", id: randomUUID(), sessionId });
  }

  rotate(sessionId: string): Promise<DaemonMessage> {
    return this.#request({ type: "session.rotate", id: randomUUID(), sessionId });
  }

  search(
    query: string,
    workdir?: string,
    limit?: number,
    scope?: "workspace" | "all",
  ): Promise<DaemonMessage> {
    return this.#request({
      type: "session.search",
      id: randomUUID(),
      query,
      workdir,
      limit,
      scope,
    });
  }

  setModel(
    sessionId: string,
    model: string,
    fallbackModel?: string | null,
  ): Promise<DaemonMessage> {
    return this.#request({
      type: "session.set_model",
      id: randomUUID(),
      sessionId,
      model,
      fallbackModel,
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────

  async #connect(): Promise<void> {
    // A connect attempt is now underway — clear the "reconnect queued" guard so
    // a later drop can schedule the next one.
    this.#reconnectPending = false;
    if (this.#stopped) return;
    this.#dispatch({ type: "connection.change", state: "connecting" });

    // Re-exchange the stored API key for a fresh JWT on every (re)connect. This
    // is what lets a reconnect recover from an expired token.
    let token: string;
    try {
      token = await this.#getToken();
    } catch (err) {
      // Only a definitively non-retryable failure (missing key, key rejected
      // by ZeroID) dead-ends. Anything else — ECONNREFUSED while Wi-Fi comes
      // up after a laptop wake, DNS hiccup, ZeroID restarting — is transient
      // and gets the same unbounded reconnect-with-backoff as a dropped
      // socket (#83). Stopping here used to kill the reconnect loop for good.
      if (err instanceof TokenExchangeError && !err.transient) {
        // Surface the error ONLY on the terminal path. Dispatching it for a
        // transient blip would leave a stale error in the StatusBar even after
        // the reconnect succeeds (the store clears lastError only on `error`
        // actions, never on connection.change).
        this.#dispatch({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        this.#dispatch({ type: "connection.change", state: "error" });
        return;
      }
      this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#config.daemonUrl);
    } catch (err) {
      this.#dispatch({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.#dispatch({ type: "connection.change", state: "error" });
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      // A newer connect may have superseded this socket while it was opening.
      if (this.#ws !== ws) return;
      // `type: "auth"` is REQUIRED — the daemon validates this pre-auth frame
      // against `authMsgSchema` and closes 4001 on anything else. A bare
      // `{ token }` frame is rejected outright.
      ws.send(
        JSON.stringify({
          type: "auth",
          token,
          protocolVersion: PROTOCOL_VERSION,
          client: "codeoid-tui-ink",
        }),
      );
    };

    ws.onmessage = (event) => {
      if (this.#ws !== ws) return;
      const raw =
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      let msg: DaemonMessage & { type: string; requestId?: string };
      try {
        msg = JSON.parse(raw) as DaemonMessage & { type: string; requestId?: string };
      } catch {
        // A malformed frame from the daemon shouldn't take down the handler —
        // drop it. (Structural validation of daemon frames is tracked
        // separately in #15.)
        return;
      }
      this.#handleMessage(msg);
    };

    ws.onclose = (event) => {
      // Ignore closes from a socket we've already replaced (force-reconnect
      // nulls #ws before closing the old one) so we never run two loops.
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#stopHeartbeat();
      // Fail in-flight requests now so awaiting callers (approve/send) don't
      // hang for the full request timeout on a socket that's already gone.
      this.#rejectPending(`connection closed (code ${event.code})`);
      if (this.#stopped) return;

      // 4003 = the daemon rejected the token. The overwhelmingly common case is
      // an expired JWT: the daemon enforces `exp` on every message, so a token
      // that was valid at connect time expires mid-session and the next frame
      // (often a heartbeat ping, or the user's first action after an idle
      // approval gate) trips it. Reconnecting re-mints the JWT via #getToken,
      // so we recover instead of dead-ending. Bound the attempts so a token the
      // daemon keeps rejecting for a *non*-expiry reason (issuer/claims) ends in
      // a clear error rather than an infinite loop. Reset on a fresh auth.ok.
      if (event.code === 4003) {
        if (this.#authReconnects >= this.#maxAuthReconnects) {
          this.#dispatch({ type: "connection.change", state: "error" });
          this.#dispatch({
            type: "error",
            message: `auth failed: ${event.reason || "token rejected"}`,
          });
          return;
        }
        this.#authReconnects += 1;
        this.#scheduleReconnect();
        return;
      }

      // 4001 = missing token / handshake timeout — a handshake/config problem
      // re-minting won't fix. Surface and stop.
      if (event.code === 4001) {
        this.#dispatch({ type: "connection.change", state: "error" });
        this.#dispatch({ type: "error", message: `auth failed: ${event.reason}` });
        return;
      }

      // Any other close (network drop, daemon restart) — reconnect unbounded.
      this.#scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires after onerror; don't double-handle.
    };
  }

  /** Queue a reconnect with backoff. No-op if one is already queued or we've
   * stopped — this is the single guard that keeps a 4003 close and a heartbeat
   * miss for the same socket from each starting a loop. */
  #scheduleReconnect(immediate = false): void {
    if (this.#reconnectPending || this.#stopped) return;
    this.#reconnectPending = true;
    this.#dispatch({ type: "connection.change", state: "reconnecting" });
    const delay = immediate ? 0 : this.#reconnectDelay;
    setTimeout(() => void this.#connect(), delay);
    if (!immediate) {
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  /** Tear down a presumed-dead socket (no close event) and reconnect promptly.
   * Nulls #ws first so the old socket's onclose short-circuits. */
  #forceReconnect(): void {
    if (this.#stopped) return;
    const ws = this.#ws;
    this.#ws = null;
    this.#stopHeartbeat();
    this.#rejectPending("connection reset");
    try {
      ws?.close();
    } catch {
      // ignore — already closing/closed
    }
    this.#scheduleReconnect(true);
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    if (this.#heartbeatMs <= 0) return;
    this.#heartbeatTimer = setInterval(() => void this.#heartbeat(), this.#heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  /** Ping the daemon; a missed pong means the socket is half-open (suspended
   * terminal, slept laptop) or the token just expired — either way, reconnect
   * (which re-mints). When the daemon closes 4003 in reply, onclose handles the
   * reconnect and the #reconnectPending guard makes this path a no-op. */
  async #heartbeat(): Promise<void> {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    try {
      await this.#request({ type: "ping", id: randomUUID() }, this.#heartbeatTimeoutMs);
    } catch {
      this.#forceReconnect();
    }
  }

  /** Reject every in-flight request (socket died under them). */
  #rejectPending(reason: string): void {
    for (const p of [...this.#pending.values()]) {
      p.fail(new Error(reason));
    }
    this.#pending.clear();
  }

  #handleMessage(msg: DaemonMessage & { type: string; requestId?: string }): void {
    if (msg.type === "auth.ok") {
      this.#dispatch({ type: "connection.change", state: "connected" });
      this.#reconnectDelay = this.#reconnectDelayBase;
      this.#authReconnects = 0;
      this.#startHeartbeat();
      // Fetch session list on connect.
      void this.#refreshSessions();
      return;
    }

    // Responses — settle pending requests.
    if (msg.requestId && this.#pending.has(msg.requestId)) {
      const pending = this.#pending.get(msg.requestId)!;
      pending.settle(msg as DaemonMessage);
      if (msg.type === "session.list.result") {
        const result = msg as Extract<DaemonMessage, { type: "session.list.result" }>;
        this.#dispatch({ type: "sessions.set", sessions: result.sessions });
      }
      return;
    }

    // Broadcast events — fan into the store.
    switch (msg.type) {
      case "session.message": {
        const m = msg as SessionMessage;
        this.#dispatch({ type: "session.message", sessionId: m.sessionId, message: m });
        break;
      }
      case "session.message.delta": {
        const d = msg as {
          sessionId: string;
          messageId: string;
          contentAppend?: string;
          toolStateUpdate?: ToolState;
        };
        this.#dispatch({
          type: "session.delta",
          sessionId: d.sessionId,
          messageId: d.messageId,
          contentAppend: d.contentAppend,
          toolStateUpdate: d.toolStateUpdate,
        });
        break;
      }
      case "session.status_change": {
        const s = msg as { sessionId: string; status: "idle" | "thinking" | "tool_running" | "waiting_approval" | "error" };
        this.#dispatch({ type: "session.status", sessionId: s.sessionId, status: s.status });
        break;
      }
      case "session.info_update": {
        const s = msg as { session: import("../protocol/types.js").SessionInfo };
        this.#dispatch({ type: "session.info", session: s.session });
        break;
      }
      case "scrollback.replay": {
        const s = msg as { sessionId: string; messages: SessionMessage[] };
        this.#dispatch({ type: "session.scrollback", sessionId: s.sessionId, messages: s.messages });
        break;
      }
    }
  }

  async #refreshSessions(): Promise<void> {
    try {
      await this.listSessions();
    } catch {
      // Error already surfaced via dispatch.
    }
  }

  #request(
    msg: ClientMessage,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<DaemonMessage> {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const timeout = setTimeout(() => {
        this.#pending.delete(msg.id);
        reject(new Error("Request timeout"));
      }, timeoutMs);
      this.#pending.set(msg.id, {
        settle: (resp) => {
          clearTimeout(timeout);
          this.#pending.delete(msg.id);
          resolve(resp);
        },
        fail: (err) => {
          clearTimeout(timeout);
          this.#pending.delete(msg.id);
          reject(err);
        },
      });
      this.#ws.send(JSON.stringify(msg));
    });
  }

  async #getToken(): Promise<string> {
    // Local mode first — see TerminalClient#getToken and config.resolveLocalToken
    // for why a token published for this daemon's port outranks a durable apiKey.
    const localToken = resolveLocalToken(this.#config.daemonUrl);
    if (localToken) return localToken;

    const token = this.#config.apiKey;
    if (!token) {
      throw new TokenExchangeError(
        "No API key configured. Set CODEOID_API_KEY or add apiKey to ~/.codeoid/config.json, " +
          "run `codeoid login`, or start the daemon with `codeoid start --local` to try it with no account.",
        false,
      );
    }
    if (!token.startsWith("zid_sk_")) return token;

    let resp: Response;
    try {
      resp = await fetch(`${this.#config.zeroidUrl}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "api_key",
          api_key: token,
          scope: ALL_SCOPES_STRING,
        }),
      });
    } catch (err) {
      // fetch() rejects only on network-level failures (endpoint unreachable,
      // DNS, connection reset) — retryable by definition.
      throw new TokenExchangeError(
        `Token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      };
      // 5xx/429 = ZeroID having a moment — retry. Anything else means the key
      // itself was rejected, and re-minting with the same key won't help.
      throw new TokenExchangeError(
        `Token exchange failed (${resp.status}): ${body.error_description ?? body.error ?? "unknown"}`,
        resp.status >= 500 || resp.status === 429,
      );
    }
    const data = (await resp.json()) as { access_token: string };
    return data.access_token;
  }
}
