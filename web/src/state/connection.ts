/**
 * Connection state — owns the singleton CodeoidClient and exposes a Solid
 * signal for current connection status.
 *
 * `bootstrap()` is the one-shot entrypoint App.tsx calls on mount. It
 * resolves the access token, instantiates the client, wires daemon
 * broadcasts into the message / session stores, and triggers an initial
 * `session.list`. Subsequent reconnects are handled inside the client.
 */

import { createSignal } from "solid-js";

import {
  forgetOAuthToken,
  jwtExpiryMs,
  refreshAccessToken,
  rememberedApiKey,
  rememberedOAuthToken,
  rememberedRefreshToken,
  resolveToken,
} from "../lib/auth";
import { CodeoidClient, type ClientStatus } from "../lib/ws";
import { CAPABILITIES } from "../protocol/types";
import type {
  AuthOkMsg,
  ClientMessage,
  DaemonMessage,
  SessionInfo,
  SessionListResultMsg,
} from "../protocol/types";

import { ingestSessionList, mergeSession, setSessionStatus } from "./sessions";
import { noteAttachReplay } from "./attach";
import {
  applyDelta,
  applyMessage,
  appendScrollback,
  replaceScrollback,
} from "./messages";
import { noteLiveSeq, noteReplayFrame } from "./resume";
import { addUiRequest, removeUiRequest } from "./ui-requests";

// Resolve the daemon WebSocket URL:
//   1. explicit VITE_CODEOID_URL build override, else
//   2. Vite dev server (:5173) → the daemon runs separately on :7400, else
//   3. served from the daemon itself (incl. a Telegram Mini App through an
//      HTTPS tunnel) → same origin, so wss:// works end-to-end.
function resolveDaemonUrl(): string {
  const override = import.meta.env.VITE_CODEOID_URL as string | undefined;
  if (override) return override;
  if (typeof window !== "undefined" && window.location) {
    const { protocol, host, port } = window.location;
    if (port === "5173") return "ws://127.0.0.1:7400";
    return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
  }
  return "ws://127.0.0.1:7400";
}

const DAEMON_URL = resolveDaemonUrl();
// Empty default → auth.ts uses a same-origin /oauth2/token URL that
// Vite's dev proxy (or a prod ingress) forwards to ZeroID. Set
// VITE_ZEROID_URL only if you intentionally want a cross-origin
// exchange and ZeroID is sending CORS headers.
export const ZEROID_URL =
  (import.meta.env.VITE_ZEROID_URL as string | undefined) ?? "";

const [status, setStatus] = createSignal<ClientStatus>({ kind: "idle" });
const [auth, setAuth] = createSignal<AuthOkMsg | null>(null);
const [bootError, setBootError] = createSignal<string | null>(null);

export const connectionStatus = status;
export const authIdentity = auth;
export const bootstrapError = bootError;

let client: CodeoidClient | null = null;

/** Public — every command verb funnels through one of these helpers so the
 * components don't reach into the WS client directly. */
export function getClient(): CodeoidClient {
  if (!client) throw new Error("client not bootstrapped — call bootstrap() first");
  return client;
}

/** Convenience: build a fresh request id. */
export function newRequestId(): string {
  return getClient().nextId();
}

// Outbound queue: messages sent while the socket is down/reconnecting are
// buffered and flushed on reconnect, so a message typed during a blip (or a
// suspended mobile webview) is never silently lost. Bounded so a long outage
// can't grow it without limit.
const MAX_QUEUED = 200;
const pendingSends: ClientMessage[] = [];

/** Send a fire-and-forget message; queues if the socket isn't ready. */
export function send(msg: ClientMessage): void {
  if (!client) {
    if (pendingSends.length < MAX_QUEUED) pendingSends.push(msg);
    return;
  }
  try {
    client.send(msg);
  } catch {
    // Not connected (or socket dead) — queue and flush on reconnect.
    if (pendingSends.length < MAX_QUEUED) pendingSends.push(msg);
  }
}

/** Flush queued sends once the socket is back. Called on `connected`. */
function flushPendingSends(): void {
  if (!client || pendingSends.length === 0) return;
  const batch = pendingSends.splice(0, pendingSends.length);
  for (let i = 0; i < batch.length; i++) {
    try {
      client.send(batch[i] as ClientMessage);
    } catch {
      // Still not ready — requeue this message AND the unsent remainder
      // (preserving order) and bail.
      pendingSends.unshift(...batch.slice(i));
      break;
    }
  }
}

/** Test-only: inspect the outbound queue depth. */
export function _pendingSendCount(): number {
  return pendingSends.length;
}

/** Send a message and await `response.ok`. Throws on `response.error`. */
export function request(msg: ClientMessage, timeoutMs?: number): Promise<unknown> {
  return getClient().request(msg, { timeoutMs });
}

/** Fetch the current session list and merge into the store. */
export async function refreshSessions(): Promise<SessionInfo[]> {
  const c = getClient();
  const id = c.nextId();
  // Stamp the request time so ingest can keep any live status_change that lands
  // AFTER this while the list is in flight (reconnect ordering race).
  const since = Date.now();
  const result = await c.request<SessionListResultMsg>(
    { type: "session.list", id },
    {
      waitForResult: (m) =>
        m.type === "session.list.result" && m.requestId === id ? m : undefined,
    },
  );
  ingestSessionList(result.sessions, since);
  return result.sessions;
}

/**
 * Resolve a fresh access token for a (re)connect, refresh-token aware.
 *
 * Embed self-refresh: when a rotating refresh token is stored (handed off by
 * the host) AND there is no api key to exchange, use the stored access token
 * while it is still valid and rotate the refresh token for a new one once it is
 * missing or within 60s of expiry. This makes every reconnect — a network blip,
 * a laptop waking from sleep past the token's expiry — recover on its own,
 * without the host re-minting. Falls back to the normal resolveToken flow
 * (stored api key exchange, or a raw stored token) when there is no refresh
 * token, or if a rotation attempt fails transiently.
 */
async function freshAccessToken(): Promise<string> {
  const hasApiKey = Boolean(rememberedApiKey());
  if (!hasApiKey && rememberedRefreshToken()) {
    const stored = rememberedOAuthToken();
    const expMs = stored ? jwtExpiryMs(stored) : null;
    // Rotate when we have no usable stored token or it's within the skew window
    // of expiry; otherwise the stored token is still good — use it as-is.
    const needsRefresh = !stored || expMs === null || expMs - Date.now() < 60_000;
    if (!needsRefresh && stored) return stored;
    try {
      return await refreshAccessToken({ zeroidUrl: ZEROID_URL });
    } catch {
      // Transient rotation failure (network): fall through to resolveToken,
      // which will surface a stored token or a sign-in requirement. A dead
      // refresh token was already forgotten inside refreshAccessToken.
    }
  }
  return resolveToken({ zeroidUrl: ZEROID_URL }).then((r) => r.token);
}

/** Force an immediate reconnect (used by the embed refresh scheduler after it
 * rotates the token, so the live socket re-authenticates with the fresh token
 * before the daemon closes the expiring one). No-op if not bootstrapped. */
export function reconnectNow(): void {
  client?.reconnectNow();
}

/**
 * Bootstrap: resolve token → instantiate client → connect → wire broadcasts
 * → hydrate sessions. Returns once the connection is live.
 */
export async function bootstrap(opts: { apiKey?: string; token?: string } = {}): Promise<void> {
  setBootError(null);
  // Tear down any prior client BEFORE creating a new one. Without
  // this, calling bootstrap twice (a stale key being replaced, the
  // user re-entering a different one, or a recovery retry) leaves the
  // old CodeoidClient running its own reconnect loop in parallel with
  // the new one — every broadcast double-fires and neither gets
  // garbage-collected.
  if (client) {
    try {
      client.shutdown();
    } catch {
      /* shutdown is best-effort */
    }
    client = null;
  }
  try {
    const resolved = await resolveToken({
      apiKey: opts.apiKey,
      token: opts.token,
      zeroidUrl: ZEROID_URL,
    });

    client = new CodeoidClient({
      url: DAEMON_URL,
      token: resolved.token,
      // What this frontend can consume — the daemon tailors per-connection
      // behaviour to these (see the protocol's CAPABILITIES).
      capabilities: [
        CAPABILITIES.PARTS,
        CAPABILITIES.CHUNKED_REPLAY,
        CAPABILITIES.SEQ_RESUME,
        CAPABILITIES.UI_DIALOGS,
        // Tail-first attach: the daemon replays only the newest window
        // (instant first paint) and we backfill older history on demand
        // via `scrollback.page` (state/attach.ts + the Transcript sentinel).
        CAPABILITIES.SCROLLBACK_PAGING,
      ],
      clientName: "codeoid-web",
      // Fresh-token supplier for reconnects. Refresh-token aware: rotates a
      // stored refresh token when the access token is (near) expired (embed
      // self-refresh), else re-exchanges a stored zid_sk_ key, else falls back
      // to the last stored token. So a reconnect after the JWT expired always
      // presents a fresh token — the daemon closes 4003 on expiry otherwise.
      getToken: () => freshAccessToken(),
      log: (level, msg, ctx) => {
        // Vite passes through to the browser console; keep the prefix
        // consistent so devtools filters work.
        const tag = `[codeoid:ws]`;
        if (level === "error") console.error(tag, msg, ctx);
        else if (level === "warn") console.warn(tag, msg, ctx);
        else console.debug(tag, msg, ctx);
      },
    });

    client.onStatus((s) => {
      setStatus(s);
      if (s.kind === "connected") {
        // Drain anything queued while the socket was down.
        flushPendingSends();
        // Refresh session list so statuses are current after a reconnect —
        // otherwise a session that finished its turn while we were away stays
        // stuck showing "thinking". (The attach effect re-attaches in parallel
        // and replays scrollback.)
        void refreshSessions().catch(() => {});
      } else if (s.kind === "failed") {
        // The client only reaches `failed` on a terminal auth rejection (it
        // retries network drops forever) — e.g. the daemon closed 4003 on an
        // access token that expired mid-session before the refresh scheduler
        // rotated it. If we hold a refresh token, rotate it and re-bootstrap
        // instead of dropping to sign-in — the self-reliant embed session. On
        // any failure the refresh token has already been forgotten
        // (refreshAccessToken), so we fall through to sign-in and never loop.
        if (rememberedRefreshToken()) {
          void refreshAccessToken({ zeroidUrl: ZEROID_URL })
            .then(() => bootstrap({}))
            .catch(() => {
              forgetOAuthToken();
              setAuth(null);
              setBootError(`Session expired — please sign in again. (${s.reason})`);
            });
          return;
        }
        // No refresh path: drop the identity to fall back to <SignIn> instead of
        // showing "reconnecting…" forever, and forget the stale token so a
        // reload doesn't immediately re-enter the same dead loop.
        forgetOAuthToken();
        setAuth(null);
        setBootError(`Session expired — please sign in again. (${s.reason})`);
      }
    });
    client.onMessage(routeBroadcast);

    const ok = await client.connect();
    setAuth(ok);

    // Initial population.
    await refreshSessions().catch((err) => {
      console.error("[codeoid:bootstrap] session.list failed:", err);
    });
    // Fetch the live model catalog (best-effort, non-blocking). Dynamic
    // import avoids a static connection<->models import cycle.
    void import("./models").then((m) => m.fetchModels()).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBootError(msg);
    throw err;
  }
}

/** Tear down the connection (sign-out / page hide / explicit disconnect). */
export function disconnect(): void {
  if (client) {
    client.shutdown();
    client = null;
  }
  setAuth(null);
}

// ---------- broadcast routing ----------

function routeBroadcast(msg: DaemonMessage): void {
  switch (msg.type) {
    case "session.message":
      noteLiveSeq(msg.sessionId, msg.seq);
      applyMessage(msg);
      return;
    case "session.message.delta":
      noteLiveSeq(msg.sessionId, msg.seq);
      applyDelta(msg);
      return;
    case "scrollback.replay":
      noteReplayFrame(msg);
      // Settle the attach lifecycle (#152) and record whether older history
      // exists beyond a tail-first window (`tail`/`hasMore`).
      noteAttachReplay(msg);
      // Incremental resume (`replay.resume`): the daemon sent only the tail
      // mutated since our cursor — upsert into the existing buffer, never
      // reset (chunk 0 of an incremental replay is NOT a snapshot).
      if (msg.mode === "incremental") {
        appendScrollback(msg.sessionId, msg.messages);
        return;
      }
      // Snapshot (chunked #84): chunk 0 (or a single-frame legacy replay,
      // where seq is absent) resets the session; later chunks append in order.
      if (msg.seq === undefined || msg.seq === 0) {
        replaceScrollback(msg.sessionId, msg.messages);
      } else {
        appendScrollback(msg.sessionId, msg.messages);
      }
      return;
    case "session.info_update":
      mergeSession(msg.session);
      return;
    case "session.status_change":
      setSessionStatus(msg.sessionId, msg.status);
      return;
    case "session.ui_request":
      addUiRequest(msg);
      return;
    case "session.ui_resolved":
      // Authoritative dismiss — fires whether WE answered, another client
      // did, the request timed out, or the turn was interrupted.
      removeUiRequest(msg.sessionId, msg.requestId);
      return;
    // Solicited types resolve via the request registry; nothing to do here.
    // `session.list.result` in particular is ONLY ever sent as the reply to
    // a `session.list` request (verified: the daemon's session-manager emits
    // it with `requestId: msg.id` and nowhere else), and `refreshSessions`
    // already ingests it on the request path. The ws client forwards every
    // frame to onMessage handlers even after resolving the pending request,
    // so ingesting here again double-applied every refresh.
    case "session.list.result":
    case "auth.ok":
    case "response.ok":
    case "response.error":
    case "session.search.result":
    case "scrollback.page.result":
    case "session.commands.result":
      return;
  }
}

// Useful for testing without a real socket.
export function _setClientForTest(stub: CodeoidClient | null): void {
  client = stub;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_CODEOID_URL?: string;
    readonly VITE_ZEROID_URL?: string;
  }
}
