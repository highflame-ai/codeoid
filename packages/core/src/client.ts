/**
 * Codeoid daemon WebSocket client — framework-agnostic transport core.
 *
 * Owns the entire transport lifecycle — connect, auth handshake (token +
 * protocol version + capability declaration), request/response correlation,
 * broadcast subscription, liveness heartbeat, exponential-backoff reconnect
 * with full jitter. Consumers subscribe to `onMessage`/`onStatus` and never
 * touch the raw socket.
 *
 * Environment assumptions (deliberately minimal):
 *   - a WHATWG `WebSocket` global (browsers, React Native, Bun, Node ≥ 22);
 *   - `setTimeout`/`setInterval`.
 * The browser resume listeners (focus / online / visibilitychange) are
 * feature-detected and no-op elsewhere; native hosts (React Native AppState,
 * a TUI regaining the foreground) call `reconnectNow()` on their own resume
 * signal instead. All timing (heartbeat cadence, backoff bounds, request
 * timeout) is injectable via `ConnectOptions` — mobile hosts typically slow
 * the heartbeat while backgrounded.
 */

import type {
  AuthOkMsg,
  ClientMessage,
  DaemonMessage,
  ResponseErrorMsg,
  ResponseOkMsg,
} from "@highflame/codeoid-protocol";
import { PROTOCOL_VERSION } from "@highflame/codeoid-protocol";

export type ClientStatus =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; auth: AuthOkMsg }
  | { kind: "reconnecting"; attempt: number; nextInMs: number; reason: string }
  | { kind: "failed"; reason: string };

/**
 * The daemon actively REJECTED the presented token (auth `response.error`, or a
 * close with the auth codes 4001/4003) — as opposed to a transient network
 * drop. Retrying won't help: there's no refresh path for an OAuth JWT, and a
 * key that fails re-exchange won't recover. The reconnect loop treats this as
 * terminal (→ `failed`) so the host can fall back to sign-in instead of
 * looping forever on a dead token.
 */
export class AuthRejectedError extends Error {
  readonly authRejected = true as const;
  constructor(message: string) {
    super(message);
    this.name = "AuthRejectedError";
  }
}

export interface ConnectOptions {
  url: string; // ws://host:port — daemon's WS endpoint
  /** Initial access token used for the first handshake (and the fallback
   * if `getToken` is absent or fails). */
  token: string;
  /** Optional fresh-token supplier, called on every (re)connect's open so a
   * reconnect after the initial JWT expired re-exchanges the stored key for
   * a new JWT instead of replaying the dead token forever. */
  getToken?: () => Promise<string>;
  /** Bounded reconnect attempts; once exhausted we land in `failed`. */
  maxAttempts?: number;
  /** Logger for transport-level diagnostics. */
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /**
   * Capability identifiers this client declares on the auth frame (see the
   * protocol's `CAPABILITIES`). Omit to authenticate as a legacy client —
   * the daemon then assumes nothing beyond the base protocol.
   */
  capabilities?: string[];
  /** Client name/version sent on the auth frame for daemon-side diagnostics
   * (e.g. "codeoid-web", "codeoid-mobile/0.1.0"). */
  clientName?: string;
  /** Liveness ping cadence while connected. Default 20s. */
  heartbeatMs?: number;
  /** How long a ping may go unanswered before the socket is declared dead. Default 8s. */
  heartbeatTimeoutMs?: number;
  /** Reconnect backoff floor. Default 500ms. */
  minBackoffMs?: number;
  /** Reconnect backoff ceiling. Default 30s. */
  maxBackoffMs?: number;
  /** Default `request()` timeout. Default 30s. */
  requestTimeoutMs?: number;
}

type StatusHandler = (status: ClientStatus) => void;
type MessageHandler = (msg: DaemonMessage) => void;

interface PendingRequest {
  resolve: (ok: ResponseOkMsg) => void;
  reject: (err: ResponseErrorMsg | Error) => void;
  /** When true, ResponseOk/Error doesn't resolve — we wait for a typed result message. */
  waitForResult?: (msg: DaemonMessage) => DaemonMessage | undefined;
  /** Aborts auto-reject after timeoutMs. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Minimal typed view of the browser host, feature-detected at call time.
 * Keeps the package compilable without the DOM lib while preserving the
 * exact runtime behaviour in browsers.
 */
interface HostEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
function browserHost(): {
  window?: HostEventTarget;
  document?: HostEventTarget & { visibilityState?: string };
} {
  const g = globalThis as Record<string, unknown>;
  return {
    window: g.window as HostEventTarget | undefined,
    document: g.document as (HostEventTarget & { visibilityState?: string }) | undefined,
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Decorrelated jitter envelope: pick uniformly in [min, computed * factor]. */
const JITTER_FACTOR = 1.5;
/** Liveness heartbeat — detects a half-open socket the host never closed. */
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 8_000;

export class CodeoidClient {
  #opts: ConnectOptions;
  /** Current access token; refreshed via opts.getToken on each connect. */
  #token: string;
  // Resolved timing knobs (see ConnectOptions) — read once at construction.
  #heartbeatMs: number;
  #heartbeatTimeoutMs: number;
  #minBackoffMs: number;
  #maxBackoffMs: number;
  #requestTimeoutMs: number;
  #ws: WebSocket | null = null;
  #pending = new Map<string, PendingRequest>();
  #statusHandlers = new Set<StatusHandler>();
  #messageHandlers = new Set<MessageHandler>();
  #status: ClientStatus = { kind: "idle" };
  #reqCounter = 0;
  #shutdown = false;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Resolver that interrupts the current backoff sleep (reconnect-now). */
  #wake: (() => void) | null = null;
  /** True while a connect loop is running (prevents concurrent loops). */
  #connecting = false;
  /**
   * The in-flight connect loop, shared by every entry point (connect(),
   * reconnectNow(), close-triggered and heartbeat-triggered reconnects) so a
   * caller landing mid-reconnect JOINS the attempt instead of racing it —
   * previously a connect() during a background reconnect threw
   * "connect already in progress".
   */
  #loopPromise: Promise<AuthOkMsg> | null = null;
  #resumeWired = false;
  #onResume: (() => void) | null = null;

  constructor(opts: ConnectOptions) {
    this.#opts = opts;
    this.#token = opts.token;
    this.#heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#minBackoffMs = opts.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.#maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Current connection status, synchronously. */
  get status(): ClientStatus {
    return this.#status;
  }

  /** Subscribe to status changes. Returns an unsubscribe fn. */
  onStatus(handler: StatusHandler): () => void {
    this.#statusHandlers.add(handler);
    try {
      handler(this.#status);
    } catch (err) {
      this.#log("error", "status handler threw", { err });
    }
    return () => this.#statusHandlers.delete(handler);
  }

  /** Subscribe to incoming daemon messages. Returns an unsubscribe fn. */
  onMessage(handler: MessageHandler): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  /**
   * Connect and complete the auth handshake. Resolves on `auth.ok`. Safe to
   * call at any time: already connected → resolves immediately; a reconnect
   * loop already running → joins it. Throws only after `shutdown()` — a
   * client instance is terminal once shut down; construct a fresh one.
   */
  async connect(): Promise<AuthOkMsg> {
    if (this.#shutdown) throw new Error("client is shut down — construct a new CodeoidClient");
    this.#wireResumeListeners();
    if (this.#status.kind === "connected") return this.#status.auth;
    return this.#joinLoop();
  }

  /** Start the connect loop, or join the one already in flight. */
  #joinLoop(): Promise<AuthOkMsg> {
    if (!this.#loopPromise) {
      this.#loopPromise = this.#connectWithBackoff(1).finally(() => {
        this.#loopPromise = null;
      });
    }
    return this.#loopPromise;
  }

  /**
   * Reconnect immediately — used on resume (tab focus / network online /
   * webview unsuspend / React Native AppState). If a backoff sleep is in
   * progress, wake it so we retry now instead of waiting out the timer; if
   * no loop is running and we're not connected, start one.
   */
  reconnectNow(): void {
    if (this.#shutdown || this.#status.kind === "connected") return;
    if (this.#wake) {
      this.#wake();
    } else if (!this.#connecting) {
      void this.#joinLoop().catch((e) => this.#log("error", "reconnect failed", { e }));
    }
  }

  /** Send a fire-and-forget client message. */
  send(msg: ClientMessage): void {
    if (this.#status.kind !== "connected") {
      throw new Error(`cannot send while ${this.#status.kind}`);
    }
    this.#ws!.send(JSON.stringify(msg));
  }

  /**
   * Send a request and resolve with the daemon's response. By default the
   * `response.ok`/`response.error` for the request id resolves the promise;
   * pass `waitForResult` to instead resolve on a typed broadcast (e.g.
   * `session.list.result`) that carries `requestId`.
   */
  request<T extends DaemonMessage = ResponseOkMsg>(
    msg: ClientMessage,
    options: { timeoutMs?: number; waitForResult?: (m: DaemonMessage) => T | undefined } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#status.kind !== "connected") {
        reject(new Error(`cannot request while ${this.#status.kind}`));
        return;
      }
      const id = msg.id;
      // A duplicate id would silently clobber the earlier pending entry,
      // leaving its caller to hang until the timeout with a misleading
      // "timed out" — surface the programmer error immediately instead.
      if (this.#pending.has(id)) {
        reject(new Error(`duplicate request id: ${id}`));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`request ${id} timed out`));
      }, options.timeoutMs ?? this.#requestTimeoutMs);

      this.#pending.set(id, {
        resolve: (ok) => resolve(ok as unknown as T),
        reject: (e) => reject(e instanceof Error ? e : new Error(e.error)),
        waitForResult: options.waitForResult,
        timer,
      });
      this.#ws!.send(JSON.stringify(msg));
    });
  }

  /** Generate a unique request id. Monotonic + random suffix for safety across reconnects. */
  nextId(): string {
    this.#reqCounter += 1;
    return `${Date.now().toString(36)}-${this.#reqCounter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Close the connection. No further reconnects after this. */
  shutdown(): void {
    this.#shutdown = true;
    this.#stopHeartbeat();
    this.#unwireResumeListeners();
    this.#wake?.();
    if (this.#ws) {
      try {
        this.#ws.close(1000, "client shutdown");
      } catch {
        /* ignore */
      }
      this.#ws = null;
    }
    for (const [, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("client shutdown"));
    }
    this.#pending.clear();
    this.#setStatus({ kind: "idle" });
  }

  // ---------- internals ----------

  #setStatus(next: ClientStatus): void {
    this.#status = next;
    // Isolate subscriber faults: one throwing handler must not break the
    // fan-out for later handlers (or unwind transport internals).
    for (const h of this.#statusHandlers) {
      try {
        h(next);
      } catch (err) {
        this.#log("error", "status handler threw", { err });
      }
    }
  }

  #log(level: "debug" | "info" | "warn" | "error", msg: string, ctx?: unknown): void {
    this.#opts.log?.(level, msg, ctx);
  }

  async #connectWithBackoff(startAttempt: number): Promise<AuthOkMsg> {
    let attempt = startAttempt;
    // `maxAttempts: 0` (or undefined) means "never give up" — the
    // common case is a laptop lid closing for an hour, the daemon
    // bouncing during dev, or a flaky home wifi. Capping at 5
    // attempts used to leave the user staring at "failed" until
    // they refreshed; that's worse than waiting longer between
    // attempts. Callers that explicitly want a bound can still set
    // `maxAttempts` to a positive number.
    const max = this.#opts.maxAttempts ?? 0;
    const isBounded = max > 0;
    if (this.#connecting) {
      // A loop is already running — don't start a second.
      throw new Error("connect already in progress");
    }
    this.#connecting = true;
    try {
      while (!this.#shutdown && (!isBounded || attempt <= max)) {
        try {
          this.#setStatus({ kind: "connecting", attempt });
          const auth = await this.#connectOnce();
          this.#setStatus({ kind: "connected", auth });
          this.#startHeartbeat();
          return auth;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // Terminal auth rejection (bad/expired token, no refresh path — e.g.
          // an OAuth JWT that expired) never self-heals by retrying; fail so the
          // host falls back to sign-in instead of looping forever on it.
          if (err instanceof AuthRejectedError || (isBounded && attempt >= max)) {
            this.#setStatus({ kind: "failed", reason });
            throw err;
          }
          // Exponential backoff with full jitter — picks uniformly in
          // [minBackoff, computed * JITTER_FACTOR] to break thundering
          // herds when many clients reconnect at once (post-restart) and
          // to avoid the "wakes up exactly on the second" pattern.
          const ceiling = Math.min(this.#maxBackoffMs, this.#minBackoffMs * 2 ** (attempt - 1));
          const upper = Math.min(this.#maxBackoffMs, Math.floor(ceiling * JITTER_FACTOR));
          const backoff = this.#minBackoffMs + Math.floor(Math.random() * Math.max(0, upper - this.#minBackoffMs));
          this.#log("warn", `connect attempt ${attempt} failed: ${reason}; retry in ${backoff}ms`);
          this.#setStatus({ kind: "reconnecting", attempt, nextInMs: backoff, reason });
          await this.#sleep(backoff);
          attempt += 1;
        }
      }
    } finally {
      this.#connecting = false;
    }
    throw new Error("shutdown during reconnect");
  }

  /** Backoff sleep that `reconnectNow()` can interrupt via `#wake`. */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(t);
        this.#wake = null;
        resolve();
      };
    });
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat();
    }, this.#heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  /** Ping the daemon; a missed pong means the socket is dead → reconnect. */
  async #heartbeat(): Promise<void> {
    if (this.#status.kind !== "connected") return;
    try {
      await this.request(
        { type: "ping", id: this.nextId() },
        { timeoutMs: this.#heartbeatTimeoutMs },
      );
    } catch {
      this.#log("warn", "heartbeat failed — socket is dead, forcing reconnect");
      this.#forceReconnect();
    }
  }

  /** Tear down a presumed-dead socket and reconnect from attempt 1. */
  #forceReconnect(): void {
    if (this.#shutdown) return;
    this.#stopHeartbeat();
    const ws = this.#ws;
    this.#ws = null; // so onClose for this socket short-circuits (no double kick)
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    for (const [, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("connection reset"));
    }
    this.#pending.clear();
    if (!this.#connecting) {
      void this.#joinLoop().catch((e) => this.#log("error", "reconnect failed", { e }));
    }
  }

  /**
   * Reconnect/revalidate on resume — tab focus, network online, or a
   * suspended webview waking. Mobile webviews (Telegram Mini App) freeze the
   * socket without a close event, so on resume we either reconnect (if down)
   * or fire an immediate heartbeat to detect a zombie socket.
   *
   * Browser-only: feature-detected via globalThis so this module stays
   * environment-agnostic (typed without the DOM lib). Non-browser hosts get
   * a no-op and call `reconnectNow()` from their own resume signal instead
   * (React Native `AppState`, a TUI regaining the foreground).
   */
  #wireResumeListeners(): void {
    const { window: win, document: doc } = browserHost();
    if (this.#resumeWired || !win) return;
    this.#resumeWired = true;
    const onResume = () => {
      if (this.#shutdown) return;
      if (doc?.visibilityState === "hidden") return;
      if (this.#status.kind === "connected") {
        void this.#heartbeat();
      } else {
        this.reconnectNow();
      }
    };
    this.#onResume = onResume;
    win.addEventListener("online", onResume);
    win.addEventListener("focus", onResume);
    doc?.addEventListener("visibilitychange", onResume);
  }

  #unwireResumeListeners(): void {
    const { window: win, document: doc } = browserHost();
    if (!this.#onResume || !win) return;
    win.removeEventListener("online", this.#onResume);
    win.removeEventListener("focus", this.#onResume);
    doc?.removeEventListener("visibilitychange", this.#onResume);
    this.#onResume = null;
    this.#resumeWired = false;
  }

  #connectOnce(): Promise<AuthOkMsg> {
    return new Promise<AuthOkMsg>((resolve, reject) => {
      const ws = new WebSocket(this.#opts.url);
      this.#ws = ws;

      let authResolved = false;
      // Handshake deadline: a peer (or middlebox) that accepts the socket but
      // never answers the auth frame would otherwise hang connect() forever —
      // the heartbeat only starts after `connected`, and request timeouts
      // don't cover this pre-auth frame. Bounded by requestTimeoutMs; the
      // rejection feeds the normal backoff loop.
      const authTimer = setTimeout(() => {
        if (authResolved) return;
        authResolved = true;
        this.#log("warn", "auth handshake timed out — closing socket");
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("auth handshake timed out"));
      }, this.#requestTimeoutMs);

      const onOpen = async () => {
        // Refresh the token before the handshake so a reconnect after the
        // prior JWT expired mints a fresh one (the daemon now closes 4003 on
        // an expired token; without this we'd replay the dead token forever).
        if (this.#opts.getToken) {
          try {
            this.#token = await this.#opts.getToken();
          } catch (err) {
            this.#log("warn", "getToken failed; using last token", { err });
          }
        }
        // We may have awaited above — bail if a newer connect superseded
        // this socket meanwhile.
        if (this.#ws !== ws) return;
        // Daemon requires the first frame to be the auth handshake. Beyond
        // the token we declare our protocol version + whatever capabilities
        // the host configured (additive — older daemons ignore the extra
        // fields; omitting capabilities authenticates as a legacy client).
        try {
          ws.send(JSON.stringify({
            type: "auth",
            token: this.#token,
            protocolVersion: PROTOCOL_VERSION,
            ...(this.#opts.capabilities ? { capabilities: this.#opts.capabilities } : {}),
            ...(this.#opts.clientName ? { client: this.#opts.clientName } : {}),
          }));
        } catch (err) {
          this.#log("warn", "auth send failed (socket closed during refresh)", { err });
        }
      };
      const onMessage = (ev: MessageEvent<string>) => {
        let msg: DaemonMessage;
        try {
          msg = JSON.parse(ev.data) as DaemonMessage;
        } catch (err) {
          this.#log("error", "non-JSON frame from daemon", { err });
          return;
        }
        if (!authResolved && msg.type === "auth.ok") {
          authResolved = true;
          clearTimeout(authTimer);
          resolve(msg);
          // From here on, dispatch normally.
          this.#routeMessage(msg);
          return;
        }
        if (!authResolved && msg.type === "response.error") {
          authResolved = true;
          clearTimeout(authTimer);
          reject(new AuthRejectedError(`auth rejected: ${msg.error}`));
          return;
        }
        this.#routeMessage(msg);
      };
      const onClose = (ev: CloseEvent) => {
        const reason = ev.reason || `socket closed (code ${ev.code})`;
        if (!authResolved) {
          authResolved = true;
          clearTimeout(authTimer);
          // 4001 (auth handshake timeout) / 4003 (auth rejected) are the
          // daemon's auth-failure close codes — terminal, not a retryable drop.
          reject(
            ev.code === 4001 || ev.code === 4003
              ? new AuthRejectedError(reason)
              : new Error(reason),
          );
          return;
        }
        clearTimeout(authTimer);
        if (this.#shutdown) return;
        // If this isn't the current socket, a forceReconnect/newer connect
        // already took over — don't kick a second reconnect loop.
        if (this.#ws !== ws) return;
        this.#stopHeartbeat();
        // Reject any in-flight requests so the UI doesn't hang on a
        // dead socket waiting for the 30s default timeout — drawers
        // and modals freeze otherwise. Reconnect kicks off below; the
        // caller can simply retry once `connected` returns.
        for (const [, p] of this.#pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new Error(`connection lost (${reason})`));
        }
        this.#pending.clear();
        this.#log("warn", "connection dropped, attempting reconnect", { code: ev.code });
        // Asynchronously kick off reconnect — caller already moved on.
        if (!this.#connecting) {
          void this.#joinLoop().catch((e) => {
            this.#log("error", "reconnect exhausted", { e });
          });
        }
      };
      const onError = (ev: Event) => {
        if (!authResolved) {
          authResolved = true;
          clearTimeout(authTimer);
          reject(new Error("websocket error during connect"));
        }
        this.#log("error", "websocket error", { ev });
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    });
  }

  #routeMessage(msg: DaemonMessage): void {
    // Request/response correlation first.
    if (msg.type === "response.ok" || msg.type === "response.error") {
      const pending = this.#pending.get(msg.requestId);
      if (pending) {
        if (msg.type === "response.ok" && !pending.waitForResult) {
          if (pending.timer) clearTimeout(pending.timer);
          this.#pending.delete(msg.requestId);
          pending.resolve(msg);
          return;
        }
        if (msg.type === "response.error") {
          if (pending.timer) clearTimeout(pending.timer);
          this.#pending.delete(msg.requestId);
          pending.reject(msg);
          return;
        }
      }
    }
    // Typed result correlation: list/search/etc carry their own requestId.
    for (const [id, pending] of this.#pending) {
      if (pending.waitForResult) {
        const matched = pending.waitForResult(msg);
        if (matched) {
          if (pending.timer) clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.resolve(matched as ResponseOkMsg);
          break;
        }
      }
    }
    // Isolate subscriber faults: a throwing UI handler must not break the
    // fan-out for later handlers or propagate into the WS event callback.
    for (const h of this.#messageHandlers) {
      try {
        h(msg);
      } catch (err) {
        this.#log("error", "message handler threw", { err });
      }
    }
  }
}
