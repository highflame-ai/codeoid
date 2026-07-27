/**
 * GeminiAcpProvider — Google's gemini-cli as a codeoid backend, driven over
 * ACP (Agent Client Protocol: newline JSON-RPC over stdio, the standardized
 * editor↔agent protocol; gemini-cli exposes it via the stable `--acp` flag).
 *
 * Auth is the user's Google account OAuth living in ~/.gemini (free tier /
 * AI Pro / Code Assist) — subscription posture like claude/codex; codeoid
 * never touches tokens. See docs/provider-gemini-acp-design.md.
 *
 * ACP mapping:
 *   session/new {cwd}                  → backing session (sessionId)
 *   session/prompt → result.stopReason → turn boundary (turn_done)
 *   session/update notifications       → agent_message_chunk → text_delta,
 *     agent_thought_chunk → thinking_delta, tool_call/tool_call_update →
 *     tool_start/tool_complete
 *   session/request_permission (server→client request) → canUseTool; deny
 *     picks a reject option — fail-closed: no gate/no reject option → cancel
 *   session/cancel                     → interrupt
 *   fs/* + terminal/* client caps are DECLINED at initialize — gemini-cli
 *   uses its own tools, all gated by session/request_permission; if such a
 *   request still arrives, it is refused (fail closed).
 *
 * The provider is deliberately thin over the protocol: any ACP-speaking
 * agent can become a backend by reusing this shape with a different binary.
 */

import { AsyncQueue } from "../../async-queue.js";
import type { Store } from "../../store.js";
import type {
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  ToolApprovalFn,
  TurnOpts,
  TurnRun,
} from "../interface.js";
import { renderHistorySeed, type CanonicalTurn, type HistorySeedResult } from "../canonical.js";
import { buildGeminiCliEnv } from "../env.js";
import { StdioJsonRpcProcess } from "../jsonrpc-stdio.js";
import { MEMORY_MCP_SERVER_NAME, type MemoryMcpMount } from "../../memory/mcp-http.js";
import { BLACKBOARD_MCP_SERVER_NAME } from "../../blackboard/mcp-http.js";
import type { McpRegistry } from "../../mcp/registry.js";
import { resolveEnvMap } from "../../mcp/types.js";

export interface GeminiAcpProviderInit {
  sessionId: string;
  /** ACP sessionId from a previous run, or the codeoid session id on first run. */
  initialBackingId: string;
  command: string;
  argsPrefix?: string[];
  store: Store;
  /** Tenant-scoped memory workspace id — the scope a mounted memory token binds to. */
  workspaceId?: string;
  /**
   * Shared in-daemon memory MCP endpoint + URL. When present (memory enabled),
   * the provider mounts it on session/new so gemini-cli can page the verbatim
   * store on demand — the precondition for the Verbatim Working Set strategy.
   */
  memoryMcp?: MemoryMcpMount;
  /**
   * Role-scoped goal-blackboard mount, resolved LAZILY.
   *
   * A getter rather than a value because the orchestrator's own mount is
   * scoped to a goal id that IS its session id — so it cannot exist until
   * after the Session is constructed. Providers read it when they build their
   * server list (per turn for claude), by which time it is set.
   */
  blackboardMcp?: () => { url: string; token: string } | undefined;

  /** Cross-backend MCP registry — external servers mount on session/new
   *  (gemini-cli owns its client); approval flows through canUseTool. */
  mcpRegistry?: McpRegistry;
  onModels?: (
    models: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ) => void;
}

export class GeminiAcpProvider implements SessionProvider {
  readonly id = "gemini-cli";
  readonly displayName = "Gemini CLI (Google)";

  onRecoveryNeeded: ((content: string) => void) | undefined;

  #sessionId: string;
  #backingSessionId: string;
  #command: string;
  #argsPrefix: string[];
  #workspaceId: string;
  #memoryMcp: MemoryMcpMount | null;
  /** Role-scoped blackboard mount; token minted+revoked by the SessionManager. */
  readonly #blackboardMcp: (() => { url: string; token: string } | undefined) | null;
  #mcpRegistry: McpRegistry | null;
  /** Live scoped token for the mounted memory endpoint; revoked on teardown. */
  #memoryToken: string | null = null;

  #proc: StdioJsonRpcProcess | null = null;
  #acpSessionId: string | null = null;
  /** Auth methods advertised at initialize (e.g. "oauth-personal"). */
  #authMethods: string[] = [];
  #authenticated = false;
  #hasQueried = false;
  #pendingHistorySeed: string | null = null;
  /** ACP/gemini-cli has no system-prompt channel (session/new takes only cwd +
   *  MCP servers), so systemPromptAppend — the pack constitution + capability-
   *  role contract + memory guidance — is delivered as a prompt preamble. Track
   *  the last one delivered so a stable session sends it once, but a pipeline
   *  phase's role swap (a changed append) re-delivers it. */
  #lastSystemPromptAppend: string | null = null;

  // Per-turn wiring.
  #turnQueue: AsyncQueue<ProviderEvent> | null = null;
  #canUseTool: ToolApprovalFn | null = null;
  #turnStartedAt = 0;
  #turnModel = "gemini-cli";
  /** toolCallId → true once announced via tool_start. */
  #announcedTools = new Set<string>();

  constructor(init: GeminiAcpProviderInit) {
    this.#sessionId = init.sessionId;
    this.#backingSessionId = init.initialBackingId;
    this.#command = init.command;
    this.#argsPrefix = init.argsPrefix ?? [];
    this.#workspaceId = init.workspaceId ?? init.sessionId;
    this.#memoryMcp = init.memoryMcp ?? null;
    this.#blackboardMcp = init.blackboardMcp ?? null;
    this.#mcpRegistry = init.mcpRegistry ?? null;
  }

  /**
   * True when the shared memory endpoint is mounted for this session, so
   * gemini-cli can page the verbatim store on demand. The Verbatim Working Set
   * strategy seeds a compact session map only when this holds; otherwise the
   * session falls back to the transcript seed.
   */
  get supportsMemoryTools(): boolean {
    return this.#memoryMcp != null;
  }

  get backingSessionId(): string {
    return this.#backingSessionId;
  }
  get hasQueried(): boolean {
    return this.#hasQueried;
  }
  get queuedMessages(): number {
    return 0;
  }

  resetToNewSession(newBackingId: string): void {
    this.#backingSessionId = newBackingId;
    this.#acpSessionId = null;
    this.#hasQueried = false;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  seedFromHistory(history: readonly CanonicalTurn[], opts?: { maxChars?: number }): HistorySeedResult {
    const seed = renderHistorySeed(history, { maxChars: opts?.maxChars });
    this.#pendingHistorySeed = seed.text.length > 0 ? seed.text : null;
    return seed;
  }

  /**
   * VWS transport: prepend a strategy-built block (the compact session map) to
   * the next prompt — the same channel seedFromHistory uses. The session decides
   * transcript vs session map; the provider just stashes the block.
   */
  seedText(block: string): void {
    this.#pendingHistorySeed = block.length > 0 ? block : null;
  }

  runTurn(opts: TurnOpts): TurnRun {
    const queue = new AsyncQueue<ProviderEvent>();
    this.#turnQueue = queue;
    this.#canUseTool = opts.canUseTool;
    this.#turnStartedAt = Date.now();
    this.#turnModel = opts.model ?? "gemini-cli";
    this.#announcedTools.clear();
    this.#hasQueried = true;

    void this.#runPrompt(opts).catch((err: unknown) => {
      this.#push({
        type: "error",
        message: `gemini-cli: ${err instanceof Error ? err.message : String(err)}`,
      });
      queue.close();
    });

    return {
      events: queue,
      interrupt: async () => {
        if (this.#proc?.alive && this.#acpSessionId) {
          // session/cancel is a NOTIFICATION; the in-flight session/prompt
          // then resolves with stopReason "cancelled" and closes the turn.
          this.#proc.notify("session/cancel", { sessionId: this.#acpSessionId });
          return;
        }
        queue.close();
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    // ACP has no model-list method; gemini-cli picks the model from its own
    // config/subscription tier. Surface the session default only.
    return [];
  }

  async dispose(): Promise<void> {
    await this.teardown();
  }

  async teardown(): Promise<void> {
    this.#turnQueue?.close();
    this.#turnQueue = null;
    this.#proc?.kill();
    this.#proc = null;
    this.#acpSessionId = null;
    if (this.#memoryToken) {
      this.#memoryMcp?.endpoint.revoke(this.#memoryToken);
      this.#memoryToken = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async #runPrompt(opts: TurnOpts): Promise<void> {
    await this.#ensureSession(opts);
    const seed = this.#pendingHistorySeed;
    this.#pendingHistorySeed = null;
    // Deliver systemPromptAppend as a preamble (no native channel). Send it when
    // it first appears or changes (a pipeline role swap), so a read-only reviewer
    // phase's contract + constitution actually reach gemini-cli.
    const append = opts.systemPromptAppend ?? "";
    const deliverAppend = append.length > 0 && append !== this.#lastSystemPromptAppend;
    if (append.length > 0) this.#lastSystemPromptAppend = append;
    const text = [deliverAppend ? append : "", seed ?? "", opts.userMessage]
      .filter((p) => p.length > 0)
      .join("\n\n");

    // session/prompt resolves when the TURN ends — it IS the turn boundary.
    const result = (await this.#proc!.request(
      "session/prompt",
      {
        sessionId: this.#acpSessionId,
        prompt: [{ type: "text", text }],
      },
      // Turns run for minutes; Session's stall watchdog owns liveness.
      24 * 60 * 60 * 1000,
    )) as { stopReason?: string };

    const turnResult: NormalizedTurnResult = {
      providerId: this.id,
      model: this.#turnModel,
      // ACP carries no token usage; honest zeros (StatusBar shows n/a).
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: Date.now() - this.#turnStartedAt,
      stopReason: result.stopReason,
    };
    this.#push({ type: "turn_done", result: turnResult });
    this.#turnQueue?.close();
  }

  async #ensureSession(opts: TurnOpts): Promise<void> {
    if (this.#proc?.alive && this.#acpSessionId) return;

    if (!this.#proc?.alive) {
      this.#proc = new StdioJsonRpcProcess({
        name: "gemini-cli",
        command: this.#command,
        args: [...this.#argsPrefix, "--acp"],
        cwd: opts.workdir,
        env: buildGeminiCliEnv(),
        onNotification: (method, params) => this.#onNotification(method, params),
        onServerRequest: (method, params) => this.#onServerRequest(method, params),
        onExit: ({ code, signal, stderrTail }) => {
          const queue = this.#turnQueue;
          if (queue && !queue.closed) {
            this.#push({
              type: "error",
              message: `gemini-cli exited unexpectedly (code=${code} signal=${signal})${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`,
            });
            queue.close();
          }
        },
      });
      const init = (await this.#proc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          // Declined on purpose: gemini-cli falls back to its own tools,
          // which all route through session/request_permission.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })) as { authMethods?: Array<{ id?: string } | string> };
      this.#authMethods = (init.authMethods ?? [])
        .map((m) => (typeof m === "string" ? m : (m.id ?? "")))
        .filter((m) => m.length > 0);
      this.#authenticated = false;
    }

    // ACP session/load (resume) is capability-gated and gemini-cli support
    // varies; first slice always starts fresh — the canonical-history seed
    // carries context across daemon restarts and switches.
    const started = await this.#sessionNew(opts.workdir);
    if (!started.sessionId) throw new Error("gemini-cli session/new returned no sessionId");
    this.#acpSessionId = started.sessionId;
    this.#backingSessionId = started.sessionId;
  }

  /**
   * session/new with an authenticate fallback. API-key setups create
   * sessions directly, but an agent whose cached credential has no
   * recorded SELECTION (observed: gemini-cli with ~/.gemini/oauth_creds
   * but no settings.json) rejects session/new until the ACP `authenticate`
   * method picks one. Prefer the OAuth method — the subscription posture
   * this backend exists for — then retry once.
   */
  async #sessionNew(cwd: string): Promise<{ sessionId?: string }> {
    const params = { cwd, mcpServers: this.#buildMcpServers() };
    try {
      return (await this.#proc!.request("session/new", params)) as { sessionId?: string };
    } catch (err) {
      if (this.#authenticated || this.#authMethods.length === 0) throw err;
      const preferred =
        this.#authMethods.find((m) => m.includes("oauth")) ?? this.#authMethods[0]!;
      await this.#proc!.request("authenticate", { methodId: preferred });
      this.#authenticated = true;
      return (await this.#proc!.request("session/new", params)) as { sessionId?: string };
    }
  }

  /**
   * MCP servers to mount on session/new. Empty unless memory is enabled, in
   * which case we mount the shared in-daemon endpoint over ACP's HTTP transport
   * (`{type:"http"}` → gemini's StreamableHTTPClientTransport), scoped by a
   * freshly-minted bearer token. gemini-cli then exposes recall/recall_file/
   * timeline/get_episode as `${MEMORY_MCP_SERVER_NAME}__*` tools it can call.
   */
  #buildMcpServers(): Array<Record<string, unknown>> {
    const servers: Array<Record<string, unknown>> = [];
    const mount = this.#memoryMcp;
    if (mount) {
      // Re-mint each session/new: the token is the per-session tenant scope, and
      // resetToNewSession/re-auth-retry may create more than one backing session.
      if (this.#memoryToken) mount.endpoint.revoke(this.#memoryToken);
      this.#memoryToken = mount.endpoint.mint({
        workspaceId: this.#workspaceId,
        sessionId: this.#sessionId,
      });
      servers.push({
        type: "http",
        name: MEMORY_MCP_SERVER_NAME,
        url: mount.url,
        headers: [{ name: "Authorization", value: `Bearer ${this.#memoryToken}` }],
      });
    }
    // Role-scoped goal blackboard (collaboration children). Deliberately NO
    // mint/revoke here, unlike memory above: the SessionManager owns this
    // token's lifetime, because the scope it encodes belongs to the
    // collaboration rather than to a backing session that resetToNewSession
    // may recreate. Re-minting per backing session would hand this child a
    // second live token the manager can't revoke at teardown.
    const bb = this.#blackboardMcp?.();
    if (bb) {
      servers.push({
        type: "http",
        name: BLACKBOARD_MCP_SERVER_NAME,
        url: bb.url,
        headers: [{ name: "Authorization", value: `Bearer ${bb.token}` }],
      });
    }
    // Registry servers — native mount (gemini-cli owns its MCP client). ACP's
    // McpServer shape: http → {type,url,headers[]}; stdio → {command,args,env[]}
    // (env/headers are {name,value} pairs, mirroring the memory http mount).
    const reg = this.#mcpRegistry;
    if (reg) {
      for (const spec of reg.forBackend(this.id)) {
        if (spec.builtin) continue;
        const t = spec.transport;
        if (t.kind === "http") {
          const headers = Object.entries(t.headers ?? {}).map(([name, value]) => ({ name, value }));
          if (t.bearerTokenEnv) {
            const tok = process.env[t.bearerTokenEnv];
            if (tok) headers.push({ name: "Authorization", value: `Bearer ${tok}` });
          }
          servers.push({ type: "http", name: spec.name, url: t.url, headers });
        } else if (t.kind === "stdio") {
          const env = Object.entries(resolveEnvMap(t.env ?? {}, process.env)).map(([name, value]) => ({ name, value }));
          servers.push({ name: spec.name, command: t.command, args: t.args ?? [], env });
        }
      }
    }
    return servers;
  }

  #push(event: ProviderEvent): void {
    const queue = this.#turnQueue;
    if (!queue || queue.closed) return;
    try {
      queue.push(event);
    } catch {
      /* closed between check and push */
    }
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (text) this.#push({ type: "text_delta", content: text });
        break;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        if (text) this.#push({ type: "thinking_delta", content: text });
        break;
      }
      case "tool_call": {
        const id = String(update.toolCallId ?? "");
        if (!id || this.#announcedTools.has(id)) break;
        this.#announcedTools.add(id);
        this.#push({
          type: "tool_start",
          toolId: id,
          sdkToolUseId: id,
          name: acpToolName(update),
          input: (update.rawInput as Record<string, unknown>) ?? { title: update.title ?? "" },
          approvalId: `acp-${id}`,
        });
        break;
      }
      case "tool_call_update": {
        const id = String(update.toolCallId ?? "");
        const status = update.status as string | undefined;
        if (!id || (status !== "completed" && status !== "failed")) break;
        this.#push({
          type: "tool_complete",
          sdkToolUseId: id,
          output: toolCallOutput(update),
          success: status === "completed",
        });
        this.#announcedTools.delete(id);
        break;
      }
      default:
        break; // plan / available_commands / mode updates — future slices
    }
  }

  async #onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "session/request_permission") {
      const canUseTool = this.#canUseTool;
      const options = (params.options ?? []) as Array<{ optionId?: string; kind?: string }>;
      const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
      const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
      // Fail closed: without a wired gate, reject (or cancel if the agent
      // offered no reject option).
      if (!canUseTool || !allow) {
        return reject?.optionId
          ? { outcome: { outcome: "selected", optionId: reject.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }

      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      const id = String(toolCall.toolCallId ?? `perm-${Date.now()}`);
      if (!this.#announcedTools.has(id)) {
        this.#announcedTools.add(id);
        this.#push({
          type: "tool_start",
          toolId: id,
          sdkToolUseId: id,
          name: acpToolName(toolCall),
          input: (toolCall.rawInput as Record<string, unknown>) ?? { title: toolCall.title ?? "" },
          approvalId: `acp-${id}`,
        });
      }
      const verdict = await canUseTool(
        id,
        `acp-${id}`,
        acpToolName(toolCall),
        (toolCall.rawInput as Record<string, unknown>) ?? {},
      );
      if (verdict.behavior === "allow") {
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
      return reject?.optionId
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    // fs/* and terminal/* were declined at initialize; anything else is
    // refused rather than guessed (fail closed).
    throw new Error(`codeoid does not handle ACP request: ${method}`);
  }
}

/** ACP tool kinds ("execute", "edit", "read", …) → codeoid tool names. */
function acpToolName(toolish: Record<string, unknown>): string {
  const kind = toolish.kind as string | undefined;
  if (kind === "execute") return "Bash";
  if (kind === "edit") return "acp_edit";
  if (kind === "read") return "Read";
  if (kind === "fetch") return "WebFetch";
  return `acp_${kind ?? "tool"}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  const c = content as { type?: string; text?: string } | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

function toolCallOutput(update: Record<string, unknown>): string {
  if (update.rawOutput !== undefined) {
    return typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
  }
  const content = update.content as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(content)) {
    return content
      .map((block) => contentText((block as { content?: unknown }).content ?? block))
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}
