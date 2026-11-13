/**
 * A minimal Slack Socket Mode client and Web API caller.
 *
 * Socket Mode is an outbound WebSocket the app opens to Slack, so the daemon
 * needs no public URL (the same reason Telegram uses long polling). Slack
 * sends each event, button press and slash command as an envelope; the client
 * acknowledges it within three seconds, optionally with a response payload
 * (an ephemeral reply to a slash command), and hands it on.
 *
 * Kept to what the frontend uses: open a connection, acknowledge envelopes,
 * reconnect when Slack asks or the socket drops, and call Web API methods.
 */

export interface SlackEnvelope {
  envelope_id: string;
  type: "events_api" | "interactive" | "slash_commands" | string;
  payload: Record<string, unknown>;
  accepts_response_payload?: boolean;
}

/** A WebSocket as the client uses it (injectable for tests). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SlackTransport {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  connect(url: string): SocketLike;
}

export const defaultTransport: SlackTransport = {
  fetch: (input, init) => fetch(input, init),
  connect: (url) => new WebSocket(url) as unknown as SocketLike,
};

const API = "https://slack.com/api";

/** A Web API error: Slack answered `ok: false`, or the call failed. */
export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`slack ${method}: ${code}`);
  }
}

/**
 * Call a Web API method with a token. Retries once after a 429's
 * `Retry-After`; anything else that isn't `ok` throws SlackApiError.
 */
export async function slackApi<T extends Record<string, unknown>>(
  transport: SlackTransport,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await transport.fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(30, Number(res.headers.get("retry-after")) || 1);
      await Bun.sleep(wait * 1000);
      continue;
    }
    const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok?: boolean; error?: string } & T;
    if (!json.ok) throw new SlackApiError(method, json.error ?? `http_${res.status}`);
    return json;
  }
}

/**
 * One Socket Mode connection, kept open: reconnects when Slack sends a
 * `disconnect` (it refreshes connections every few hours) or the socket
 * drops, backing off from 1 s to 30 s while it can't connect.
 */
export class SlackSocket {
  #appToken: string;
  #transport: SlackTransport;
  #onEnvelope: (env: SlackEnvelope) => Promise<Record<string, unknown> | undefined>;
  #socket: SocketLike | null = null;
  #stopped = false;
  #backoffMs = 1_000;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    appToken: string,
    onEnvelope: (env: SlackEnvelope) => Promise<Record<string, unknown> | undefined>,
    transport: SlackTransport = defaultTransport,
  ) {
    this.#appToken = appToken;
    this.#onEnvelope = onEnvelope;
    this.#transport = transport;
  }

  /** Open the connection; resolves once the first one is open, or throws if Slack refuses the app token. */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const s = this.#socket;
    this.#socket = null;
    s?.close();
  }

  async #open(): Promise<void> {
    const { url } = await slackApi<{ url: string }>(this.#transport, this.#appToken, "apps.connections.open", {});
    if (this.#stopped) return;
    const socket = this.#transport.connect(url);
    this.#socket = socket;
    socket.onopen = () => {
      this.#backoffMs = 1_000;
    };
    socket.onmessage = (ev) => void this.#receive(socket, ev.data);
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.#socket === socket) this.#socket = null;
      this.#reconnect();
    };
  }

  #reconnect(): void {
    if (this.#stopped || this.#timer) return;
    const wait = this.#backoffMs;
    this.#backoffMs = Math.min(30_000, this.#backoffMs * 2);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#open().catch((err) => {
        console.error(`[codeoid:slack] reconnecting failed: ${err instanceof Error ? err.message : String(err)}`);
        this.#reconnect();
      });
    }, wait);
  }

  async #receive(socket: SocketLike, data: unknown): Promise<void> {
    let msg: { type?: string; envelope_id?: string; payload?: unknown; accepts_response_payload?: boolean };
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    if (msg.type === "hello") return;
    if (msg.type === "disconnect") {
      // Slack is about to close this connection: open the next one now, then let this one go.
      const old = socket;
      if (this.#socket === old) this.#socket = null;
      old.onclose = null;
      old.close();
      this.#reconnect();
      return;
    }
    if (!msg.envelope_id || !msg.payload || typeof msg.payload !== "object") return;
    const env: SlackEnvelope = {
      envelope_id: msg.envelope_id,
      type: msg.type ?? "",
      payload: msg.payload as Record<string, unknown>,
      ...(msg.accepts_response_payload ? { accepts_response_payload: true } : {}),
    };
    let response: Record<string, unknown> | undefined;
    try {
      response = await this.#onEnvelope(env);
    } catch (err) {
      console.error(`[codeoid:slack] handling ${env.type} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      socket.send(JSON.stringify({ envelope_id: env.envelope_id, ...(response && env.accepts_response_payload ? { payload: response } : {}) }));
    } catch {
      // The socket closed meanwhile: Slack retries the envelope on the next connection.
    }
  }
}
