/**
 * PiProvider — pi (https://pi.dev) as a codeoid session backend.
 *
 * Architecture: one warm `pi --mode rpc` subprocess per session (spawned
 * lazily on first turn, kept across turns like ClaudeProvider's SDK loop).
 * pi owns its own durable session tree on disk; codeoid stores the pi
 * session FILE as the backing-session id so daemon restarts resume the
 * same pi conversation via `switch_session`.
 *
 * What flows where:
 *   - prompts → RPC `prompt`; mid-turn sends → `steer` / `follow_up`
 *   - pi streaming events → ProviderEvents (see translate.ts)
 *   - tool gating → the injected bridge extension (see bridge.ts) routes
 *     every pi tool_call through codeoid's `canUseTool`. pi has NO native
 *     permission system, so a missing bridge fails the turn CLOSED.
 *   - pi extension dialogs (select/confirm/input/editor from the user's own
 *     extensions) → `TurnOpts.requestUserInput` → codeoid session.ui_request
 *   - extension notifications → `custom_message` info/system rows
 *   - `get_commands` → codeoid `session.commands` (slash passthrough)
 */

import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../../async-queue.js";
import type { Store } from "../../store.js";
import type {
  CatalogEntry,
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  ToolApprovalFn,
  TurnOpts,
  TurnRun,
  UiRequestFn,
} from "../interface.js";
import type { ProviderCommand } from "../../../protocol/types.js";
import { renderHistorySeed, type CanonicalTurn, type HistorySeedResult } from "../canonical.js";
import { buildPiEnv } from "../env.js";
import {
  APPROVAL_TITLE,
  type BridgeMcpTool,
  BRIDGE_READY_VALUE,
  BRIDGE_STATUS_KEY,
  MCP_TOOL_TITLE,
  MEMORY_TOOL_TITLE,
  writeBridgeExtension,
} from "./bridge.js";
import { memoryToolDefs, type MemoryEngine, type MemoryToolContext } from "../../memory/index.js";
import { SessionMcpTools } from "../../mcp/tool-source.js";
import type { McpRegistry } from "../../mcp/registry.js";
import type { McpHub } from "../../mcp/hub.js";
import { PiRpcProcess, type PiFrame } from "./rpc.js";
import { translatePiEvent } from "./translate.js";

export interface PiProviderInit {
  sessionId: string;
  /** pi session FILE from a previous run (absolute .jsonl path), or the
   *  codeoid session id on first run (nothing to resume). */
  initialBackingId: string;
  /** Resolved binary/wrapper (see pi/resolve.ts — config → PATH → bundled). */
  command: string;
  /** argv entries preceding `--mode rpc` (bundled: the cli entry path). */
  argsPrefix?: string[];
  store: Store;
  /** Tenant-scoped memory workspace id — the scope memory tool calls run under. */
  workspaceId?: string;
  /** Memory engine — when present, the bridge registers the recall tools and
   *  the provider runs them against this engine (pi has no MCP; see bridge.ts). */
  memory?: MemoryEngine;
  /** Cross-backend MCP registry + daemon-owned client — external servers reach
   *  pi (which has no MCP client) by registering bridge tools that proxy to the hub. */
  mcpRegistry?: McpRegistry;
  mcpHub?: McpHub;
  onModels?: (models: ReadonlyArray<CatalogEntry>) => void;
}

interface PiSessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  /** `contextUsage.contextWindow` — pi's window for its current model. */
  contextWindow?: number;
}

const EMPTY_STATS: PiSessionStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
};

export class PiProvider implements SessionProvider {
  readonly id = "pi";
  readonly displayName = "pi (pi.dev)";

  onRecoveryNeeded: ((content: string) => void) | undefined;

  #sessionId: string;
  #backingSessionId: string;
  #command: string;
  #argsPrefix: string[];
  #store: Store;
  #onModels?: PiProviderInit["onModels"];
  #workspaceId: string;
  #memory: MemoryEngine | null;
  #mcpRegistry: McpRegistry | null;
  #mcpHub: McpHub | null;

  #proc: PiRpcProcess | null = null;
  #bridgeReady = false;
  #hasQueried = false;
  #model: string | null = null;
  /** Rendered transcript from seedFromHistory() — prepended to the next prompt. */
  #pendingHistorySeed: string | null = null;

  // Per-turn wiring, set by runTurn and read by the event pump.
  #turnQueue: AsyncQueue<ProviderEvent> | null = null;
  #canUseTool: ToolApprovalFn | null = null;
  #requestUserInput: UiRequestFn | undefined;
  #turnStartedAt = 0;
  #lastStats: PiSessionStats = EMPTY_STATS;
  #lastStopReason: string | undefined;
  /** sdkToolUseIds the bridge gated this turn — the ungated-tool detector. */
  #gatedToolIds = new Set<string>();

  constructor(init: PiProviderInit) {
    this.#sessionId = init.sessionId;
    this.#backingSessionId = init.initialBackingId;
    this.#command = init.command;
    this.#argsPrefix = init.argsPrefix ?? [];
    this.#store = init.store;
    this.#onModels = init.onModels;
    this.#workspaceId = init.workspaceId ?? init.sessionId;
    this.#memory = init.memory ?? null;
    this.#mcpRegistry = init.mcpRegistry ?? null;
    this.#mcpHub = init.mcpHub ?? null;
  }

  /**
   * True when memory is wired: the bridge registers the recall tools and this
   * provider runs them, so the model can page the verbatim store on demand —
   * the precondition for the Verbatim Working Set strategy on pi.
   */
  get supportsMemoryTools(): boolean {
    return this.#memory != null;
  }

  /** VWS transport: prepend a strategy-built block (the session map) to the
   *  next prompt — the same channel seedFromHistory uses. */
  seedText(block: string): void {
    this.#pendingHistorySeed = block.length > 0 ? block : null;
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
    // A live process starts a fresh pi session; the real session file is
    // re-captured (and persisted) on the next turn's get_state.
    this.#proc?.send({ type: "new_session" });
    this.#hasQueried = false;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  async teardown(): Promise<void> {
    this.#failTurn("pi session torn down");
    this.#proc?.kill();
    this.#proc = null;
    this.#bridgeReady = false;
  }

  async dispose(): Promise<void> {
    return this.teardown();
  }

  async listModels(): Promise<ModelInfo[]> {
    // Spawning a subprocess just to list models is not worth it — the
    // catalog is reported (and cached daemon-wide) once a pi session runs.
    if (!this.#proc?.alive) return [];
    try {
      const resp = await this.#proc.request({ type: "get_available_models" });
      return this.#mapModels(resp).map((m) => ({
        id: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Provider switch seeding: pi's fresh session hasn't seen the
   * conversation — prepend the rendered transcript to the first
   * post-switch prompt. (Writing a native pi session file would be higher
   * fidelity; deliberately not done — pi's session format is internal.)
   */
  seedFromHistory(history: readonly CanonicalTurn[], opts?: { maxChars?: number }): HistorySeedResult {
    const seed = renderHistorySeed(history, { maxChars: opts?.maxChars });
    this.#pendingHistorySeed = seed.text.length > 0 ? seed.text : null;
    return seed;
  }

  async listCommands(): Promise<ProviderCommand[]> {
    if (!this.#proc?.alive) return [];
    const resp = await this.#proc.request({ type: "get_commands" });
    const data = resp.data as { commands?: unknown } | undefined;
    if (!Array.isArray(data?.commands)) return [];
    return data.commands
      .filter(
        (c): c is { name: string; description?: string; source?: string } =>
          !!c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string",
      )
      .map((c) => ({
        name: c.name,
        ...(typeof c.description === "string" ? { description: c.description } : {}),
        ...(typeof c.source === "string" ? { source: c.source } : {}),
      }));
  }

  runTurn(opts: TurnOpts): TurnRun {
    const queue = new AsyncQueue<ProviderEvent>();
    this.#turnQueue = queue;
    this.#canUseTool = opts.canUseTool;
    this.#requestUserInput = opts.requestUserInput;
    this.#turnStartedAt = Date.now();
    this.#lastStopReason = undefined;
    this.#gatedToolIds.clear();
    this.#hasQueried = true;

    void this.#startTurn(opts).catch((err) => {
      this.#failTurn(err instanceof Error ? err.message : String(err));
    });

    return {
      events: queue,
      interrupt: async () => {
        this.#proc?.send({ type: "abort" });
      },
      pushMidTurn: (content, priority) => {
        // codeoid `now`/`next` ≈ pi steering (delivered after the current
        // tool batch); `later` ≈ pi follow-up (after the agent finishes).
        this.#proc?.send(
          priority === "later"
            ? { type: "follow_up", message: content }
            : { type: "steer", message: content },
        );
      },
    };
  }

  async #startTurn(opts: TurnOpts): Promise<void> {
    await this.#ensureProcess(opts);

    if (!this.#bridgeReady) {
      // pi has no native permission gate — running without the bridge means
      // every tool executes unreviewed. Fail CLOSED instead.
      throw new Error(
        "codeoid's pi bridge extension did not initialize — tools would run ungated. " +
          "Check `pi --version` and the daemon log.",
      );
    }

    if (opts.model && opts.model !== this.#model) {
      await this.#setModel(opts.model);
    }

    let message = opts.userMessage;
    if (this.#pendingHistorySeed) {
      message = `${this.#pendingHistorySeed}\n\n${message}`;
      this.#pendingHistorySeed = null;
    }
    const resp = await this.#proc!.request({ type: "prompt", message });
    if (resp.success === false) {
      throw new Error(`pi rejected the prompt: ${String(resp.error ?? "unknown error")}`);
    }
  }

  async #ensureProcess(opts: TurnOpts): Promise<void> {
    if (this.#proc?.alive) return;

    const mcpTools = await this.#discoverMcpTools();
    const args: string[] = ["-e", writeBridgeExtension({ memoryTools: this.#memory != null, mcpTools })];
    if (opts.systemPromptAppend) {
      args.push("--append-system-prompt", opts.systemPromptAppend);
    }

    this.#bridgeReady = false;
    this.#proc = new PiRpcProcess({
      command: this.#command,
      argsPrefix: this.#argsPrefix,
      args,
      cwd: opts.workdir,
      // Allowlisted env (GHSA-38vh): pi gets its credentials (~/.pi via
      // HOME, provider API keys), never codeoid's own secrets.
      env: buildPiEnv(),
      onEvent: (frame) => this.#onFrame(frame),
      onExit: ({ code, signal, stderrTail }) => {
        this.#bridgeReady = false;
        const tail = stderrTail ? ` — ${stderrTail.trim().slice(-300)}` : "";
        this.#failTurn(
          `pi exited unexpectedly (code=${code ?? "?"} signal=${signal ?? "?"})${tail}`,
        );
      },
    });

    // Resume the previous pi conversation when we have a session file from
    // a prior run. First run: capture (and persist) the file pi creates so
    // the NEXT daemon lifetime resumes it.
    const looksLikeSessionFile = this.#backingSessionId.endsWith(".jsonl");
    if (looksLikeSessionFile) {
      const resp = await this.#proc.request({
        type: "switch_session",
        sessionPath: this.#backingSessionId,
      });
      if (resp.success === false) {
        console.warn(
          `[codeoid/pi ${this.#sessionId}] resume of ${this.#backingSessionId} failed — starting fresh`,
        );
      }
    }

    const state = await this.#proc.request({ type: "get_state" });
    const data = state.data as { sessionFile?: string; sessionId?: string } | undefined;
    const file = data?.sessionFile;
    if (typeof file === "string" && file.length > 0 && file !== this.#backingSessionId) {
      this.#backingSessionId = file;
      try {
        // The store column predates multi-provider naming; it holds "the
        // provider's backing session id" generically.
        this.#store.setClaudeCodeSessionId(this.#sessionId, file);
      } catch (err) {
        console.error(
          `[codeoid/pi ${this.#sessionId}] failed to persist pi session file: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.#lastStats = await this.#fetchStats();

    void this.#reportModels();

    // Give the bridge's session_start handshake a beat to arrive before the
    // first turn checks it (frames are processed in arrival order, so the
    // get_state round-trip above usually already flushed it).
    if (!this.#bridgeReady) {
      await new Promise<void>((r) => setTimeout(r, 250));
    }
  }

  async #reportModels(): Promise<void> {
    if (!this.#onModels || !this.#proc?.alive) return;
    try {
      const resp = await this.#proc.request({ type: "get_available_models" });
      const models = this.#mapModels(resp);
      if (models.length > 0) this.#onModels(models);
    } catch {
      // Catalog is a nicety; never fail a turn over it.
    }
  }

  #mapModels(resp: PiFrame): CatalogEntry[] {
    const data = resp.data as { models?: unknown } | undefined;
    if (!Array.isArray(data?.models)) return [];
    return data.models
      .filter(
        (m): m is { id: string; provider: string; name?: string; contextWindow?: unknown } =>
          !!m &&
          typeof m === "object" &&
          typeof (m as { id?: unknown }).id === "string" &&
          typeof (m as { provider?: unknown }).provider === "string",
      )
      .map((m) => ({
        value: `${m.provider}/${m.id}`,
        displayName: typeof m.name === "string" ? m.name : m.id,
        // pi's catalog entries are full pi-ai Model objects, window included.
        ...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
      }));
  }

  async #setModel(model: string): Promise<void> {
    // codeoid model values for pi are "provider/modelId" (as reported via
    // onModels). Anything else is passed through as an anthropic id so
    // `/model opus-4-5` style values still do something predictable.
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "anthropic";
    const modelId = slash > 0 ? model.slice(slash + 1) : model;
    const resp = await this.#proc!.request({ type: "set_model", provider, modelId });
    if (resp.success === false) {
      throw new Error(`pi could not switch model to "${model}": ${String(resp.error ?? "")}`);
    }
    this.#model = model;
  }

  async #fetchStats(): Promise<PiSessionStats> {
    try {
      const resp = await this.#proc!.request({ type: "get_session_stats" });
      const data = resp.data as
        | {
            tokens?: Partial<PiSessionStats["tokens"]>;
            cost?: number;
            contextUsage?: { contextWindow?: number };
          }
        | undefined;
      // pi reports the window of the model it is running on the same stats
      // call codeoid already makes every turn (verified against pi 0.80.6:
      // `contextUsage: { tokens, contextWindow, percent }`). It was dropped
      // here, which left pi on a model-id guess — 200k for a 1M Gemini.
      const window = data?.contextUsage?.contextWindow;
      return {
        ...(typeof window === "number" && window > 0 ? { contextWindow: window } : {}),
        tokens: {
          input: data?.tokens?.input ?? 0,
          output: data?.tokens?.output ?? 0,
          cacheRead: data?.tokens?.cacheRead ?? 0,
          cacheWrite: data?.tokens?.cacheWrite ?? 0,
        },
        cost: data?.cost ?? 0,
      };
    } catch {
      return this.#lastStats;
    }
  }

  // ── Event pump ─────────────────────────────────────────────────────────

  #onFrame(frame: PiFrame): void {
    switch (frame.type) {
      case "extension_ui_request":
        void this.#onUiRequest(frame);
        return;
      case "agent_end":
        void this.#finishTurn();
        return;
      case "message_end": {
        const message = frame.message as { role?: string; stopReason?: string } | undefined;
        if (message?.role === "assistant" && typeof message.stopReason === "string") {
          this.#lastStopReason = message.stopReason;
        }
        break;
      }
      case "tool_execution_end": {
        // Defense-in-depth: every executed tool must have passed the bridge.
        // An ungated execution can't be un-run — surface it LOUDLY.
        const toolCallId = frame.toolCallId;
        if (typeof toolCallId === "string" && !this.#gatedToolIds.has(toolCallId)) {
          this.#turnQueue?.push({
            type: "custom_message",
            role: "system",
            content: `pi executed tool "${String(frame.toolName ?? "?")}" WITHOUT passing codeoid's approval gate — check the bridge extension.`,
            metadata: { source: "pi", kind: "ungated_tool" },
          });
        }
        break;
      }
      default:
        break;
    }
    const queue = this.#turnQueue;
    if (!queue) return;
    for (const event of translatePiEvent(frame)) {
      queue.push(event);
    }
  }

  async #finishTurn(): Promise<void> {
    const queue = this.#turnQueue;
    if (!queue) return;
    const stats = await this.#fetchStats();
    const prev = this.#lastStats;
    this.#lastStats = stats;
    const result: NormalizedTurnResult = {
      providerId: this.id,
      model: this.#model ?? "pi-default",
      inputTokens: Math.max(0, stats.tokens.input - prev.tokens.input),
      outputTokens: Math.max(0, stats.tokens.output - prev.tokens.output),
      cacheReadTokens: Math.max(0, stats.tokens.cacheRead - prev.tokens.cacheRead),
      cacheCreationTokens: Math.max(0, stats.tokens.cacheWrite - prev.tokens.cacheWrite),
      totalCostUsd: Math.max(0, stats.cost - prev.cost),
      durationMs: Date.now() - this.#turnStartedAt,
      ...(stats.contextWindow !== undefined ? { contextWindow: stats.contextWindow } : {}),
      stopReason: this.#lastStopReason,
    };
    queue.push({ type: "turn_done", result });
    queue.close();
    this.#turnQueue = null;
    this.#canUseTool = null;
  }

  /**
   * Abort the in-flight turn queue with an error event (spawn failure,
   * process death, teardown). Idempotent and double-close-safe: the process
   * exit handler and the runTurn catch can both race here for one failure.
   */
  #failTurn(message: string): void {
    const queue = this.#turnQueue;
    this.#turnQueue = null;
    this.#canUseTool = null;
    if (!queue) return;
    try {
      queue.push({ type: "error", message });
    } catch {
      return; // queue already closed — the turn already ended
    }
    queue.close();
  }

  // ── Extension UI requests ──────────────────────────────────────────────

  async #onUiRequest(frame: PiFrame): Promise<void> {
    const method = frame.method;
    const id = typeof frame.id === "string" ? frame.id : null;

    // Bridge readiness handshake (fire-and-forget setStatus).
    if (
      method === "setStatus" &&
      frame.statusKey === BRIDGE_STATUS_KEY &&
      frame.statusText === BRIDGE_READY_VALUE
    ) {
      this.#bridgeReady = true;
      return;
    }

    // Bridge tool-approval (blocking input dialog with the reserved title).
    if (method === "input" && frame.title === APPROVAL_TITLE && id) {
      await this.#onApprovalRequest(id, frame);
      return;
    }

    // Bridge memory-tool call: the pi-registered recall tool proxies here (pi
    // has no MCP). The call was already gated by the tool_call approval hook
    // above (isSafeTool auto-approves recall); run it against the daemon engine.
    if (method === "input" && frame.title === MEMORY_TOOL_TITLE && id) {
      await this.#onMemoryToolRequest(id, frame);
      return;
    }

    // Bridge external-MCP call: the pi-registered tool proxies here (pi has no
    // MCP). Already gated by the tool_call approval hook; run it via McpHub.
    if (method === "input" && frame.title === MCP_TOOL_TITLE && id) {
      await this.#onMcpToolRequest(id, frame);
      return;
    }

    // Fire-and-forget extension output → visible rows.
    if (method === "notify") {
      const level = frame.notifyType === "error" ? "system" : "info";
      this.#turnQueue?.push({
        type: "custom_message",
        role: level as "info" | "system",
        content: String(frame.message ?? ""),
        metadata: { source: "pi", kind: "notify", level: String(frame.notifyType ?? "info") },
      });
      return;
    }
    if (
      method === "setStatus" ||
      method === "setWidget" ||
      method === "setTitle" ||
      method === "set_editor_text"
    ) {
      return; // cosmetic TUI affordances with no codeoid surface (yet)
    }

    // Genuine extension dialogs → codeoid's session.ui_request flow.
    if ((method === "select" || method === "confirm" || method === "input" || method === "editor") && id) {
      await this.#onDialogRequest(id, frame);
    }
  }

  async #onApprovalRequest(id: string, frame: PiFrame): Promise<void> {
    const reply = (value: string) =>
      this.#proc?.send({ type: "extension_ui_response", id, value });

    const canUseTool = this.#canUseTool;
    if (!canUseTool) {
      // No active turn (shouldn't happen — approvals only fire mid-turn).
      reply(JSON.stringify({ behavior: "deny", message: "no active codeoid turn" }));
      return;
    }

    let payload: { toolCallId?: string; toolName?: string; input?: Record<string, unknown> };
    try {
      payload = JSON.parse(String(frame.placeholder ?? "{}")) as typeof payload;
    } catch {
      reply(JSON.stringify({ behavior: "deny", message: "malformed bridge payload" }));
      return;
    }
    const toolCallId = payload.toolCallId ?? randomUUID();
    const toolName = payload.toolName ?? "unknown_tool";
    const input = payload.input ?? {};
    this.#gatedToolIds.add(toolCallId);

    const approvalId = randomUUID();
    this.#turnQueue?.push({
      type: "tool_start",
      toolId: toolCallId,
      sdkToolUseId: toolCallId,
      name: toolName,
      input,
      approvalId,
    });

    try {
      const decision = await canUseTool(toolCallId, approvalId, toolName, input);
      if (decision.behavior === "allow") {
        // Only ship a patch when the gate actually changed something —
        // the bridge merges keys into pi's live tool input.
        const updated =
          decision.updatedInput && decision.updatedInput !== input
            ? decision.updatedInput
            : undefined;
        reply(JSON.stringify({ behavior: "allow", ...(updated ? { updatedInput: updated } : {}) }));
      } else {
        reply(JSON.stringify({ behavior: "deny", message: decision.message ?? "Denied by user" }));
      }
    } catch (err) {
      reply(
        JSON.stringify({
          behavior: "deny",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /**
   * Run a bridge memory-tool call against the daemon's MemoryEngine and answer
   * with the verbatim result text. The call already passed the approval gate
   * (tool_call hook), so there is no second gate here; the tool_start/complete
   * events come from that path + pi's normal tool-result flow.
   */
  /** Per-(session) view of the registry for the pi backend, or null when no
   *  registry/hub is wired. */
  #mcpToolsView(): SessionMcpTools | null {
    if (!this.#mcpRegistry || !this.#mcpHub) return null;
    return new SessionMcpTools(this.#mcpRegistry, this.#mcpHub, this.id, {
      workspaceId: this.#workspaceId,
      sessionId: this.#sessionId,
    });
  }

  /** Discover external MCP tools to register in the bridge at spawn time. */
  async #discoverMcpTools(): Promise<BridgeMcpTool[]> {
    const view = this.#mcpToolsView();
    if (!view || !view.hasServers()) return [];
    const handles = await view.handles();
    return handles.map((h) => ({ name: h.canonicalName, description: h.description, parameters: h.inputSchema }));
  }

  /** Bridge external-MCP call: the pi-registered tool proxies here (pi has no
   *  MCP). Already gated by the tool_call hook; run it through the daemon hub. */
  async #onMcpToolRequest(id: string, frame: PiFrame): Promise<void> {
    const reply = (value: string) => this.#proc?.send({ type: "extension_ui_response", id, value });
    const view = this.#mcpToolsView();
    if (!view) {
      reply("codeoid MCP is not enabled for this session.");
      return;
    }
    let payload: { name?: string; args?: Record<string, unknown> };
    try {
      payload = JSON.parse(String(frame.placeholder ?? "{}")) as typeof payload;
    } catch {
      reply("Error: malformed mcp-tool payload");
      return;
    }
    if (!payload.name) {
      reply("Error: missing mcp tool name");
      return;
    }
    // view.call is fail-soft, but always reply — a missing RPC response would
    // hang the pi process waiting on the ui.input round-trip.
    try {
      const res = await view.call(payload.name, payload.args ?? {});
      reply(res.text);
    } catch (err) {
      reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #onMemoryToolRequest(id: string, frame: PiFrame): Promise<void> {
    const reply = (value: string) =>
      this.#proc?.send({ type: "extension_ui_response", id, value });
    const memory = this.#memory;
    if (!memory) {
      reply("codeoid memory is not enabled for this session.");
      return;
    }
    let payload: { tool?: string; args?: Record<string, unknown> };
    try {
      payload = JSON.parse(String(frame.placeholder ?? "{}")) as typeof payload;
    } catch {
      reply("Error: malformed memory-tool payload");
      return;
    }
    const def = memoryToolDefs().find((d) => d.name === payload.tool);
    if (!def) {
      reply(`Unknown memory tool: ${String(payload.tool)}`);
      return;
    }
    const ctx: MemoryToolContext = {
      engine: memory,
      workspaceId: this.#workspaceId,
      sessionId: this.#sessionId,
    };
    try {
      reply(await def.run(payload.args ?? {}, ctx));
    } catch (err) {
      reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #onDialogRequest(id: string, frame: PiFrame): Promise<void> {
    const requestUserInput = this.#requestUserInput;
    const cancel = () => this.#proc?.send({ type: "extension_ui_response", id, cancelled: true });
    if (!requestUserInput) {
      cancel(); // dialog raised outside a turn — nobody to route it to
      return;
    }

    const method = frame.method as "select" | "confirm" | "input" | "editor";
    const response = await requestUserInput({
      method,
      title: String(frame.title ?? "pi extension"),
      ...(typeof frame.message === "string" ? { message: frame.message } : {}),
      ...(Array.isArray(frame.options)
        ? { options: frame.options.filter((o): o is string => typeof o === "string") }
        : {}),
      ...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}),
      ...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
      ...(typeof frame.timeout === "number" ? { timeoutMs: frame.timeout } : {}),
    });

    if (response.cancelled) {
      cancel();
    } else if (method === "confirm") {
      this.#proc?.send({
        type: "extension_ui_response",
        id,
        confirmed: response.confirmed === true,
      });
    } else {
      this.#proc?.send({ type: "extension_ui_response", id, value: response.value ?? "" });
    }
  }
}
