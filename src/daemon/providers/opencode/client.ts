/**
 * A small typed client for exactly the opencode 2.x server routes codeoid
 * uses. Shapes are taken from opencode's `packages/protocol/openapi.json`
 * (v2.2.2) — only the fields read here are declared; the server sends more.
 *
 * Auth is HTTP Basic (`opencode:<password>`) on every request. A request is
 * bound to a directory by the `x-opencode-directory` header (URI-encoded),
 * which is how one server serves every codeoid workdir.
 *
 * One stream: `GET /api/event`, the server-wide live feed. It carries every
 * session's durable events (each with `durable: {aggregateID, seq}`) and the
 * ephemeral ones (text/reasoning deltas, `permission.asked`, `form.created`,
 * `session.usage.updated`). Volatile: no replay, a slow reader is dropped.
 *
 * Not used: `GET /api/experimental/session/:id/log`. On opencode 2.2.2 and
 * 2.2.5 it replays no events (only its `log.synced` marker) and, with
 * `follow=true`, sends nothing but heartbeats — not even that marker.
 */

// ── Wire types (subset of the OpenAPI components) ───────────────────────────

/** `Model.Ref`. */
export interface OcModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** `TokenUsage.Info`. `input` excludes cache reads (TokenUsage.total adds them separately). */
export interface OcTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** `Permission.Rule`. Last match wins; no match = ask. */
export interface OcRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** `Session.Info` (public). */
/** A shell command (`GET /api/shell`): only running ones are listed. */
export interface OcShellInfo {
  id: string;
  status: string;
  command: string;
  metadata?: { sessionID?: string; [k: string]: unknown };
}

export interface OcSessionInfo {
  id: string;
  parentID?: string;
  fork?: { sessionID: string };
  agent?: string;
  model?: OcModelRef;
  cost?: number;
  tokens?: OcTokenUsage;
  title?: string;
  permissions?: OcRule[];
  location?: { directory: string };
  /** How the session's last execution ended. */
  outcome?: "succeeded" | "failed" | "interrupted";
  /** `busy`: when its last execution started; `idle`: when one last ended. */
  time?: { created?: number; updated?: number; busy?: number; idle?: number };
}

/** `Permission.Request` — also the `permission.asked` event's data. */
export interface OcPermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
  message?: string;
}

/** `Form.Option`. */
export interface OcFormOption {
  value: string;
  label: string;
  description?: string;
}

/** `Form.Field` (tagged by `type`). */
export interface OcFormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }>;
  options?: OcFormOption[];
  placeholder?: string;
  default?: unknown;
  url?: string;
}

/** `Form.Info` — also `form.created`'s `data.form`. */
export interface OcForm {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: OcFormField[];
}

/** `Form.Value`. */
export type OcFormValue = string | number | boolean | string[];

/** `Model.Info` (subset). */
export interface OcModelInfo {
  id: string;
  providerID: string;
  name: string;
  type?: string;
  variants: Array<{ id: string }>;
  enabled: boolean;
  status?: string;
  limit: { context: number; output?: number };
}

/** `Agent.Info` (subset). `permissions` is the agent's whole ruleset, config rules included. */
export interface OcAgentInfo {
  id: string;
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  permissions: OcRule[];
}

/** `Plugin.Info` (subset). */
export interface OcPluginInfo {
  id?: string;
  source: { type: "builtin" | "package" | "local" | "sdk" | string; path?: string; target?: string };
  state?: { status: string; error?: string };
}

/** `Command.Info`. */
export interface OcCommandInfo {
  name: string;
  description?: string;
}

/** `Skill.Info` (subset). */
export interface OcSkillInfo {
  id: string;
  name: string;
  description?: string;
}

/** A tool block's `state` (`Session.Message.ToolState`): `streaming` input is still partial JSON text. */
export interface OcToolState {
  status: "streaming" | "running" | "completed" | "error";
  input?: Record<string, unknown> | string;
  content?: unknown[];
  metadata?: Record<string, unknown>;
  error?: OcError;
}

/** `Session.Message.Info` (what a fork boundary and a feed gap need). */
export interface OcMessage {
  id: string;
  type: string;
  /** An assistant message's blocks, in order. */
  content?: Array<{ type: string; text?: string; id?: string; name?: string; state?: OcToolState }>;
  cost?: number;
  tokens?: OcTokenUsage;
  error?: OcError;
  finish?: string;
  /** An assistant message's model: a subagent's may be another than its parent's. */
  model?: OcModelRef;
  /** `streamed`: the model's response ended (every text and reasoning block is final); `completed`: the step ended. */
  time?: { created?: number; streamed?: number; completed?: number };
}

/** `ServerInfo`. */
export interface OcServerInfo {
  version: string;
  pid: number;
  urls?: string[];
}

/** `Session.StructuredError`. */
export interface OcError {
  type: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

/**
 * An event envelope, from either stream: `{id, type, created, data,
 * durable?: {aggregateID, seq, version}}`. The log's replay boundary
 * (`log.synced`) has no `data`, only `aggregateID` and `seq`.
 */
export interface OcEvent {
  id?: string;
  type: string;
  created?: number;
  data?: Record<string, unknown>;
  durable?: { aggregateID: string; seq: number; version: number };
  aggregateID?: string;
  seq?: number;
}

/** A non-2xx reply, with the server's tagged error body when it sent one. */
export class OpencodeHttpError extends Error {
  override name = "OpencodeHttpError";
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface OpencodeClientOptions {
  /** `http://127.0.0.1:<port>` as the server printed it. */
  baseUrl: string;
  password: string;
  /** Per-request timeout for ordinary calls (streams have none). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class OpencodeClient {
  readonly baseUrl: string;
  readonly #auth: string;
  readonly #timeoutMs: number;

  constructor(opts: OpencodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#auth = `Basic ${Buffer.from(`opencode:${opts.password}`).toString("base64")}`;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  #headers(directory?: string, json = false): Record<string, string> {
    return {
      authorization: this.#auth,
      ...(json ? { "content-type": "application/json" } : {}),
      ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
    };
  }

  async #request<T>(method: string, path: string, opts: { body?: unknown; directory?: string; query?: Record<string, string | undefined> } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: this.#headers(opts.directory, opts.body !== undefined),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let tag: string | undefined;
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { _tag?: string; message?: string };
        tag = parsed._tag;
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        /* not JSON */
      }
      throw new OpencodeHttpError(res.status, tag, `opencode ${method} ${path} → ${res.status}${tag ? ` ${tag}` : ""}: ${message}`);
    }
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ── Server ──────────────────────────────────────────────────────────

  info(): Promise<OcServerInfo> {
    return this.#request("GET", "/api/info");
  }

  async agents(directory?: string): Promise<OcAgentInfo[]> {
    return (await this.#request<{ data: OcAgentInfo[] }>("GET", "/api/agent", { directory })).data ?? [];
  }

  /** The plugins the server runs for `directory`'s location (empty until the location has been used). */
  async plugins(directory?: string): Promise<OcPluginInfo[]> {
    return (await this.#request<{ data: OcPluginInfo[] }>("GET", "/api/plugin", { directory })).data ?? [];
  }

  // ── Sessions ────────────────────────────────────────────────────────

  async createSession(body: { location: { directory: string }; permissions: OcRule[]; agent?: string; model?: OcModelRef; title?: string }): Promise<OcSessionInfo> {
    return (await this.#request<{ data: OcSessionInfo }>("POST", "/api/session", { body, directory: body.location.directory })).data;
  }

  async getSession(sessionID: string): Promise<OcSessionInfo> {
    return (await this.#request<{ data: OcSessionInfo }>("GET", `/api/session/${encodeURIComponent(sessionID)}`)).data;
  }

  /** The sessions `sessionID`'s subagents run in (newest first, up to 50). */
  async childSessions(sessionID: string): Promise<OcSessionInfo[]> {
    return (await this.#request<{ data: OcSessionInfo[] }>("GET", "/api/session", { query: { parentID: sessionID, order: "desc" } })).data ?? [];
  }

  async updateSession(sessionID: string, body: { permissions?: OcRule[]; title?: string }): Promise<void> {
    await this.#request("PATCH", `/api/session/${encodeURIComponent(sessionID)}`, { body });
  }

  /** Shell commands still running at a location (a background one's `metadata.sessionID` names its session). */
  async shells(directory: string): Promise<OcShellInfo[]> {
    return (await this.#request<{ data: OcShellInfo[] }>("GET", "/api/shell", { directory })).data ?? [];
  }

  /** Terminate a shell command (its job ends, and opencode still notifies its session). */
  async removeShell(id: string, directory: string): Promise<void> {
    await this.#request("DELETE", `/api/shell/${encodeURIComponent(id)}`, { directory });
  }

  /** Replace the environment the session's shell commands run with (opencode 2.2.5: `process.env` otherwise). */
  async setEnvironment(sessionID: string, variables: Record<string, string>): Promise<void> {
    await this.#request("PUT", `/api/session/${encodeURIComponent(sessionID)}/environment`, { body: { variables } });
  }

  async forkSession(sessionID: string, before?: string): Promise<OcSessionInfo> {
    return (await this.#request<{ data: OcSessionInfo }>("POST", `/api/session/${encodeURIComponent(sessionID)}/fork`, { body: before ? { before } : {} })).data;
  }

  /** Rebind the session to another directory (an inbox item: an idle session takes it at once). */
  async moveSession(sessionID: string, directory: string): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/move`, { body: { directory } });
  }

  async switchModel(sessionID: string, model: OcModelRef): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/model`, { body: { model } });
  }

  async switchAgent(sessionID: string, agent: string): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/agent`, { body: { agent } });
  }

  /** Durably admit one input. Returns the inbox item; its `id` is the user message id `session.inbox.delivered` names. */
  async prompt(
    sessionID: string,
    body: { text: string; delivery?: "steer" | "queue"; skills?: Array<{ id: string }> },
  ): Promise<{ id: string }> {
    return (await this.#request<{ data: { id: string } }>("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, { body })).data;
  }

  /**
   * Admit synthetic input without running it (`resume: false`): context the
   * model reads with the next prompt. opencode's own ACP bridge sends embedded
   * context this way.
   */
  async synthetic(sessionID: string, text: string, description: string): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/synthetic`, {
      body: { text, description, delivery: "steer", resume: false },
    });
  }

  async command(sessionID: string, body: { name: string; text: string; delivery?: "steer" | "queue" }): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/command`, { body });
  }

  /** What waits in the session's inbox, not delivered yet, oldest first: user, synthetic, compaction and move items. */
  async inbox(sessionID: string): Promise<Array<{ id: string; type: string }>> {
    return (await this.#request<{ data?: Array<{ id: string; type: string }> }>("GET", `/api/session/${encodeURIComponent(sessionID)}/inbox`)).data ?? [];
  }

  /** Withdraw an input not delivered yet (one already delivered is left as it is). */
  async cancelInput(sessionID: string, inboxID: string): Promise<void> {
    await this.#request("DELETE", `/api/session/${encodeURIComponent(sessionID)}/inbox/${encodeURIComponent(inboxID)}`);
  }

  async interrupt(sessionID: string): Promise<{ interrupted: boolean }> {
    return this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`);
  }

  async activeSessions(): Promise<Record<string, unknown>> {
    return (await this.#request<{ data: Record<string, unknown> }>("GET", "/api/session/active")).data ?? {};
  }

  /** One page of messages, oldest first. */
  async messages(sessionID: string, cursor?: string): Promise<{ data: OcMessage[]; cursor?: { next?: string } }> {
    return this.#request("GET", `/api/session/${encodeURIComponent(sessionID)}/message`, {
      query: cursor ? { cursor, limit: "200" } : { order: "asc", limit: "200" },
    });
  }

  async message(sessionID: string, messageID: string): Promise<OcMessage> {
    return (await this.#request<{ data: OcMessage }>("GET", `/api/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`)).data;
  }

  /** One page of messages, newest first. */
  async recentMessages(sessionID: string, cursor?: string): Promise<{ data: OcMessage[]; cursor?: { next?: string } }> {
    return this.#request("GET", `/api/session/${encodeURIComponent(sessionID)}/message`, {
      query: cursor ? { cursor, limit: "50" } : { order: "desc", limit: "50" },
    });
  }

  /** Attach or replace one durable instruction entry (experimental). */
  async putInstruction(sessionID: string, key: string, value: string): Promise<void> {
    await this.#request("PUT", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`, { body: { value } });
  }

  async removeInstruction(sessionID: string, key: string): Promise<void> {
    await this.#request("DELETE", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`);
  }

  // ── Permissions and forms ──────────────────────────────────────────

  async pendingPermissions(sessionID: string): Promise<OcPermissionRequest[]> {
    return (await this.#request<{ data: OcPermissionRequest[] }>("GET", `/api/session/${encodeURIComponent(sessionID)}/permission`)).data ?? [];
  }

  /** `decision` is typed without "always" on purpose: codeoid owns the policy and never saves one. */
  async replyPermission(sessionID: string, requestID: string, decision: "once" | "reject", message?: string): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, {
      body: { decision, ...(message !== undefined ? { message } : {}) },
    });
  }

  async savedPermissions(directory: string): Promise<Array<{ id: string; action: string; resource: string }>> {
    return (await this.#request<{ data: Array<{ id: string; action: string; resource: string }> }>("GET", "/api/permission/saved", { directory })).data ?? [];
  }

  async removeSavedPermission(id: string): Promise<void> {
    await this.#request("DELETE", `/api/permission/saved/${encodeURIComponent(id)}`);
  }

  async pendingForms(sessionID: string): Promise<OcForm[]> {
    return (await this.#request<{ data: OcForm[] }>("GET", `/api/session/${encodeURIComponent(sessionID)}/form`)).data ?? [];
  }

  async replyForm(sessionID: string, formID: string, answer: Record<string, OcFormValue>): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, { body: { answer } });
  }

  async cancelForm(sessionID: string, formID: string, message?: string): Promise<void> {
    await this.#request("DELETE", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`, {
      query: { message },
    });
  }

  // ── Catalogs ────────────────────────────────────────────────────────

  async models(directory?: string): Promise<OcModelInfo[]> {
    return (await this.#request<{ data: OcModelInfo[] }>("GET", "/api/model", { directory })).data ?? [];
  }

  async defaultModel(directory?: string): Promise<OcModelInfo | undefined> {
    return (await this.#request<{ data?: OcModelInfo }>("GET", "/api/model/default", { directory })).data;
  }

  async commands(directory?: string): Promise<OcCommandInfo[]> {
    return (await this.#request<{ data: OcCommandInfo[] }>("GET", "/api/command", { directory })).data ?? [];
  }

  async skills(directory?: string): Promise<OcSkillInfo[]> {
    return (await this.#request<{ data: OcSkillInfo[] }>("GET", "/api/skill", { directory })).data ?? [];
  }

  // ── MCP (experimental runtime set, per location) ───────────────────

  async addMcp(directory: string, name: string, config: Record<string, unknown>): Promise<void> {
    await this.#request("PUT", `/api/experimental/mcp/${encodeURIComponent(name)}`, { body: { config }, directory });
  }

  async removeMcp(directory: string, name: string): Promise<void> {
    await this.#request("DELETE", `/api/experimental/mcp/${encodeURIComponent(name)}`, { directory });
  }

  // ── Streams ─────────────────────────────────────────────────────────

  /** The live feed, filtered server-side to `types` (plus `server.connected`). */
  events(types: readonly string[], signal: AbortSignal): AsyncIterable<OcEvent> {
    const query = new URLSearchParams();
    for (const t of types) query.append("types", t);
    return this.#sse(`/api/event?${query}`, signal);
  }

  async *#sse(path: string, signal: AbortSignal): AsyncIterable<OcEvent> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { ...this.#headers(), accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) {
      throw new OpencodeHttpError(res.status, undefined, `opencode GET ${path.split("?")[0]} → ${res.status}`);
    }
    yield* parseSse(res.body, signal);
  }
}

/**
 * Server-sent events → parsed JSON payloads. One event per blank-line-
 * terminated block; its `data:` lines are joined with newlines (the SSE
 * spec), `event:`/`id:`/comment lines are ignored. A block that isn't JSON
 * is skipped rather than ending the stream.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<OcEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end = buf.indexOf("\n\n");
      while (end >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data.length > 0) {
          try {
            yield JSON.parse(data) as OcEvent;
          } catch {
            /* not an event */
          }
        }
        end = buf.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
