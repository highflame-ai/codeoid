/**
 * QwenProvider — Alibaba's Qwen Code as a codeoid backend, driven in-process
 * through `@qwen-code/sdk`.
 *
 * Shape follows ClaudeProvider, not the ACP providers: the Qwen SDK is a
 * deliberate clone of the Claude Agent SDK (`query({prompt, options})`,
 * `createSdkMcpServer()`, `tool()`), so the warm-loop model — one long-running
 * query per codeoid session, fed by an AsyncQueue of user messages — maps
 * across directly. qwen-code also speaks ACP (`qwen --acp`), but that path has
 * no in-process MCP mount and no typed auth selection, so the SDK wins.
 *
 * Auth (both paths, selected by `authType`):
 *   - `qwen-oauth` — a qwen.ai subscription already logged in under `~/.qwen`.
 *     Tokens never transit codeoid; HOME is in the subprocess env basics.
 *   - `openai`     — the OpenAI-compatible key path: `OPENAI_API_KEY` plus a
 *     base URL. Note that a Model Studio *plan* key (`sk-sp-…`) is rejected by
 *     the standard DashScope host and needs the `bailian-plan-intl` gateway —
 *     see QWEN_BASE_URL_PRESETS.
 *   Omit `authType` and we auto-detect: OAuth creds on disk win, else the key.
 *
 * Two deliberate divergences from ClaudeProvider, both forced by the SDK:
 *
 *   1. Tool correlation. Qwen's `canUseTool` receives only `{signal,
 *      suggestions}` — there is no `toolUseID` like the Claude SDK passes, so
 *      the id has to come from the assistant message's `tool_use` block. See
 *      #matchPendingTool.
 *   2. Subprocess env. The SDK spawns with `{...process.env, ...options.env}`
 *      (a MERGE, where the Claude SDK replaces), so an allowlist alone leaks
 *      the daemon's secrets. buildQwenEnv() blanks the rest — see its docs.
 */

import { query, type Query, type SDKMessage, type SDKUserMessage } from "@qwen-code/sdk";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsyncQueue } from "../../async-queue.js";
import type { Store } from "../../store.js";
import { buildMemoryMcpServer, MEMORY_TOOL_NAMES, type MemoryEngine } from "../../memory/index.js";
import type { McpRegistry } from "../../mcp/registry.js";
import { resolveEnvMap } from "../../mcp/types.js";
import { FLEET_TOOL_NAMES } from "../../fleet.js";
import { resolveQwenBaseUrl, type CodeoidConfig } from "../../../config.js";
import type { AuthContext } from "../../../protocol/types.js";
import type {
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  TurnOpts,
  TurnRun,
} from "../interface.js";
import { renderHistorySeed, type CanonicalTurn, type HistorySeedResult } from "../canonical.js";
import { buildQwenEnv } from "../env.js";
import type { LLMCallUsage } from "../../context-math.js";

/** Where qwen-code persists a qwen.ai subscription login. */
const QWEN_OAUTH_CREDS = join(homedir(), ".qwen", "oauth_creds.json");

/** A tool call the model asked for, awaiting its approval + result. */
interface PendingTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  approvalId: string;
  /** True once the approval gate has consumed this entry. */
  gated: boolean;
}

export interface QwenProviderInit {
  sessionId: string;
  /** Persisted backing id from Store, or the session id itself on first run. */
  initialBackingId: string;
  /** Tenant-scoped memory workspace id (computed once by Session). */
  workspaceId: string;
  store: Store;
  memory?: MemoryEngine;
  /** codeoid_fleet MCP server — conductor sessions only. */
  fleet?: { type: "sdk"; name: string; instance: unknown };
  /** Cross-backend MCP registry — mounted natively (qwen owns its MCP client). */
  mcpRegistry?: McpRegistry;
  config?: CodeoidConfig;
  onModels?: (
    models: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ) => void;
}

export class QwenProvider implements SessionProvider {
  readonly id = "qwen";
  readonly displayName = "Qwen Code (Alibaba)";

  onRecoveryNeeded: ((content: string) => void) | undefined;

  #backingId: string;
  #hasQueried = false;
  #init: QwenProviderInit;

  #query: Query | null = null;
  #abortController: AbortController | null = null;
  #inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  #consumerTask: Promise<void> | null = null;
  #currentTurnQueue: AsyncQueue<ProviderEvent> | null = null;
  #builtSystemPromptAppend = "";
  /** Bumped on every (re)build so an orphaned consumer can't clobber the new loop. */
  #loopGeneration = 0;

  #currentCanUseTool: TurnOpts["canUseTool"] | null = null;
  #currentSender: AuthContext | null = null;
  #pendingHistorySeed: string | null = null;

  /** In-flight tool calls, oldest first — see #matchPendingTool. */
  #pendingTools: PendingTool[] = [];
  /** Subagent ids seen this session, so subagent_start fires exactly once. */
  #seenSubagents = new Set<string>();
  /** Model the live loop was built with — the turn_done attribution fallback. */
  #currentModel: string | null = null;
  /** Resolved gateway URL + credential path of the live loop — see #loadCatalog. */
  #currentBaseUrl: string | null = null;
  #currentAuthType: "openai" | "qwen-oauth" | null = null;

  constructor(init: QwenProviderInit) {
    this.#backingId = coerceBackingId(init.initialBackingId, init.sessionId);
    this.#init = init;
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  get backingSessionId(): string {
    return this.#backingId;
  }
  get queuedMessages(): number {
    return this.#inputQueue?.size ?? 0;
  }
  get hasQueried(): boolean {
    return this.#hasQueried;
  }
  /** Memory recall tools ride the in-process MCP mount whenever memory is wired. */
  get supportsMemoryTools(): boolean {
    return this.#init.memory != null;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  resetToNewSession(newBackingId: string): void {
    this.#backingId = coerceBackingId(newBackingId, this.#init.sessionId);
    this.#hasQueried = false;
    this.#pendingTools = [];
    this.#seenSubagents.clear();
  }

  // ── AgentProvider ─────────────────────────────────────────────────────────

  runTurn(opts: TurnOpts): TurnRun {
    this.#currentCanUseTool = opts.canUseTool;
    this.#currentSender = opts.sender ?? null;

    this.#ensureQueryLoop(opts);

    this.#currentTurnQueue?.close();
    const turnQueue = new AsyncQueue<ProviderEvent>();
    this.#currentTurnQueue = turnQueue;

    let userMessage = opts.userMessage;
    if (this.#pendingHistorySeed && userMessage) {
      userMessage = `${this.#pendingHistorySeed}\n\n${userMessage}`;
      this.#pendingHistorySeed = null;
    }
    if (userMessage) this.#push(userMessage);

    return {
      events: turnQueue,
      interrupt: async () => {
        const q = this.#query;
        if (q) {
          try {
            await q.interrupt();
            return;
          } catch {
            // fall through to hard abort
          }
        }
        this.#abortController?.abort();
        this.#inputQueue?.close();
      },
      // The Qwen SDK's SDKUserMessage has no priority/shouldQuery fields, so a
      // mid-turn push is just another queued user message.
      pushMidTurn: (content) => this.#push(content),
    };
  }

  seedFromHistory(history: readonly CanonicalTurn[], opts?: { maxChars?: number }): HistorySeedResult {
    const seed = renderHistorySeed(history, { maxChars: opts?.maxChars });
    this.#pendingHistorySeed = seed.text.length > 0 ? seed.text : null;
    return seed;
  }

  seedText(block: string): void {
    this.#pendingHistorySeed = block.length > 0 ? block : null;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.#loadCatalog();
  }

  /**
   * The model catalog, unioned from both sources it can come from.
   *
   * qwen-code's `getAvailableModels()` is NOT a catalog fetch — it returns
   * `modelRegistry.getModelsForAuthType(currentAuthType)`, an in-memory
   * registry seeded once at construction from (a) the hardcoded
   * `QWEN_OAUTH_MODELS` (a single entry, `coder-model`) for `qwen-oauth` and
   * (b) the user's `modelProviders` setting for every other authType. Under
   * `authType: "openai"` with no `modelProviders` declared it returns `[]`,
   * which is why the picker used to render empty against a gateway serving a
   * dozen models: qwen-code never asks the gateway what it hosts.
   *
   * So on the `openai` path we ask the gateway ourselves — it is an
   * OpenAI-compatible endpoint, so `GET /models` is authoritative and stays
   * current as the provider adds models. The registry is still unioned in
   * (rather than replaced) because it carries real display labels, and because
   * `qwen-oauth` has a dynamic base URL and no key to present, so HTTP is not
   * an option there and the registry is the only source.
   *
   * Everything the endpoint reports is returned. The response carries only
   * `{id, object, created, owned_by}` — no modality field — so filtering
   * non-chat entries (image/audio models) would mean pattern-matching ids,
   * which is exactly the kind of hardcoded list this method exists to remove.
   */
  async #loadCatalog(): Promise<ModelInfo[]> {
    const registry = this.#query
      ? await this.#query
          .getAvailableModels()
          .then(normalizeModelCatalog)
          .catch(() => [] as ModelInfo[])
      : [];

    if (this.#currentAuthType !== "openai") return registry;

    const baseUrl = this.#currentBaseUrl ?? process.env.OPENAI_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!baseUrl || !apiKey) return registry;

    try {
      const live = await fetchOpenAiModelCatalog(baseUrl, apiKey);
      return unionCatalogs(live, registry);
    } catch (err) {
      // A catalog fetch is best-effort: the session still runs on the
      // configured model, only the picker is poorer for it.
      console.error(
        `[qwen-provider ${this.#init.sessionId.slice(0, 8)}] model catalog fetch failed (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to the qwen-code registry`,
      );
      return registry;
    }
  }

  async dispose(): Promise<void> {
    await this.teardown();
  }

  async teardown(): Promise<void> {
    this.#inputQueue?.close();
    this.#abortController?.abort();
    if (this.#query) {
      try {
        await this.#query.close();
      } catch {
        /* already closed */
      }
    }
    if (this.#consumerTask) {
      try {
        await this.#consumerTask;
      } catch {
        /* consumer handles its own errors */
      }
    }
    this.#currentTurnQueue?.close();
    this.#currentTurnQueue = null;
    this.#inputQueue = null;
    this.#consumerTask = null;
    this.#query = null;
    this.#abortController = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #push(content: string): void {
    if (!this.#inputQueue) {
      console.error(
        `[qwen-provider ${this.#init.sessionId.slice(0, 8)}] push without active queue — dropping`,
      );
      return;
    }
    try {
      this.#inputQueue.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: this.#backingId,
      } as SDKUserMessage);
    } catch (err) {
      console.error(
        `[qwen-provider] push failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  #emit(event: ProviderEvent): void {
    try {
      this.#currentTurnQueue?.push(event);
    } catch {
      // Queue may be closed if the turn ended early — ignore.
    }
  }

  #ensureQueryLoop(opts: TurnOpts): void {
    const desiredAppend = opts.systemPromptAppend ?? "";
    if (this.#consumerTask && this.#inputQueue && !this.#inputQueue.closed) {
      // The SDK fixes the system prompt at query construction, so a changed
      // append (before_turn hooks, refreshed memory index) needs a rebuild.
      // The fresh query RESUMES the same backing session, so nothing is lost.
      if (this.#builtSystemPromptAppend === desiredAppend) return;
      console.log(
        `[qwen-provider ${this.#init.sessionId.slice(0, 8)}] systemPromptAppend changed — rebuilding query loop`,
      );
      this.#inputQueue.close();
      this.#abortController?.abort();
    }

    const init = this.#init;
    const qwenCfg = init.config?.providers?.qwen;
    this.#abortController = new AbortController();
    this.#inputQueue = new AsyncQueue<SDKUserMessage>();
    this.#builtSystemPromptAppend = desiredAppend;
    this.#loopGeneration += 1;
    const myGeneration = this.#loopGeneration;

    const sessionOpts = this.#hasQueried
      ? { resume: this.#backingId }
      : { sessionId: this.#backingId };

    // In-process servers (memory, fleet) mount natively; the Claude SDK's
    // McpSdkServerConfigWithInstance and Qwen's SDKMcpServerConfig are the same
    // `{type:"sdk", name, instance}` shape, so the builder is reused as-is.
    const mcpServers: Record<string, unknown> = {
      ...registryServersForQwen(init.mcpRegistry),
      ...(init.memory
        ? {
            codeoid_memory: buildMemoryMcpServer(init.memory, {
              workspaceId: init.workspaceId,
              sessionId: init.sessionId,
            }),
          }
        : {}),
      ...(init.fleet ? { codeoid_fleet: init.fleet } : {}),
    };

    const authType = resolveQwenAuthType(qwenCfg?.authType);
    const baseUrl = resolveQwenBaseUrl(qwenCfg?.baseUrl);
    const model = opts.model ?? qwenCfg?.model;
    this.#currentModel = model ?? null;
    this.#currentBaseUrl = baseUrl ?? null;
    this.#currentAuthType = authType;

    this.#query = query({
      prompt: this.#inputQueue,
      options: {
        cwd: opts.workdir,
        abortController: this.#abortController,
        // Explicit allowlist + blanking of everything else — the SDK MERGES
        // this over process.env rather than replacing it (see buildQwenEnv).
        env: {
          ...buildQwenEnv(),
          ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
          ...(model ? { OPENAI_MODEL: model } : {}),
        },
        authType,
        ...(model ? { model } : {}),
        // qwen-code takes a LIST of capacity fallbacks (max 3), where the
        // Claude SDK takes a single id; codeoid tracks one, so wrap it.
        ...(opts.fallbackModel ? { fallbackModel: [opts.fallbackModel] } : {}),
        ...(qwenCfg?.command ? { pathToQwenExecutable: qwenCfg.command } : {}),
        // codeoid's gate is the only approval authority. `default` keeps
        // read-only tools uncontrolled and routes every write through
        // canUseTool; qwen-code's own `auto` mode would silently auto-approve
        // edits and shell commands, bypassing the gate entirely.
        permissionMode: "default",
        includePartialMessages: true,
        allowedTools: [
          ...(init.memory ? MEMORY_TOOL_NAMES.map((t) => `mcp__codeoid_memory__${t}`) : []),
          ...(init.fleet ? FLEET_TOOL_NAMES.map((t) => `mcp__codeoid_fleet__${t}`) : []),
        ],
        ...(Object.keys(mcpServers).length > 0
          ? { mcpServers: mcpServers as never }
          : {}),
        ...(desiredAppend
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "qwen_code" as const,
                append: desiredAppend,
              },
            }
          : {}),
        ...sessionOpts,
        stderr: (data: string) => {
          process.stderr.write(`[qwen-subprocess ${init.sessionId.slice(0, 8)}] ${data}`);
        },
        canUseTool: async (toolName, input) => {
          const inputObj = (input ?? {}) as Record<string, unknown>;
          const canUse = this.#currentCanUseTool;
          if (!canUse) return { behavior: "deny" as const, message: "provider not ready" };

          const pending = this.#matchPendingTool(toolName, inputObj);
          init.store.audit(
            this.#currentSender?.sub ?? "unknown",
            "session.tool_call",
            init.sessionId,
            `tool=${toolName}`,
          );
          const result = await canUse(pending.id, pending.approvalId, toolName, inputObj);
          if (result.behavior === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: (result.updatedInput ?? inputObj) as never,
            };
          }
          return { behavior: "deny" as const, message: result.message ?? "Denied" };
        },
      },
    });

    this.#hasQueried = true;

    if (init.onModels) {
      // Fired on every loop build, so a model added to the gateway shows up on
      // the next session rather than waiting for a daemon restart.
      void this.#loadCatalog()
        .then((models) => {
          if (models.length > 0) {
            init.onModels?.(
              models.map((m) => ({
                value: m.id,
                displayName: m.displayName,
                ...(m.description ? { description: m.description } : {}),
              })),
            );
          }
        })
        .catch(() => {});
    }

    const query$ = this.#query;
    const ac = this.#abortController;
    const queue$ = this.#inputQueue;
    let selfTask: Promise<void> | null = null;

    selfTask = this.#consumerTask = (async () => {
      try {
        for await (const msg of query$) {
          if (this.#loopGeneration !== myGeneration) break;
          this.#translate(msg);
        }
      } catch (err) {
        if (!ac.signal.aborted && this.#loopGeneration === myGeneration) {
          const emsg = err instanceof Error ? err.message : String(err);
          console.error(`[qwen-provider ${init.sessionId.slice(0, 8)}] SDK query failed: ${emsg}`);
          this.#emit({ type: "error", message: emsg });
        }
      } finally {
        if (this.#loopGeneration === myGeneration) {
          this.#currentTurnQueue?.close();
          this.#currentTurnQueue = null;
        }
        if (this.#query === query$) this.#query = null;
        if (this.#abortController === ac) this.#abortController = null;
        queue$?.close();
        if (this.#inputQueue === queue$) this.#inputQueue = null;
        if (this.#consumerTask === selfTask) this.#consumerTask = null;
      }
    })();
  }

  /**
   * Resolve the `tool_use` id for a `canUseTool` callback.
   *
   * Qwen's CanUseTool signature is `(toolName, input, {signal, suggestions})` —
   * no `toolUseID`, unlike the Claude SDK (which codeoid leans on for issue
   * #81). The real id therefore has to come from the assistant message's
   * `tool_use` block, which always arrives BEFORE the permission request.
   *
   * Matching is oldest-first among UNGATED entries of the same NAME, never
   * positional: read-only tools are auto-approved and never reach this
   * callback, so a positional queue would desync on the first auto-allowed
   * call — exactly the #81 failure. Name-keyed is sound because auto-approval
   * is a property of the tool's identity, so either every call of a name is
   * gated or none is.
   *
   * A miss (no announced block — e.g. a tool synthesised outside the assistant
   * turn) still yields a usable correlation pair rather than denying, and is
   * announced so the client renders it.
   */
  #matchPendingTool(toolName: string, input: Record<string, unknown>): PendingTool {
    const hit = this.#pendingTools.find((p) => p.name === toolName && !p.gated);
    if (hit) {
      hit.gated = true;
      return hit;
    }
    const synthetic: PendingTool = {
      id: randomUUID(),
      name: toolName,
      input,
      approvalId: randomUUID(),
      gated: true,
    };
    this.#pendingTools.push(synthetic);
    this.#emit({
      type: "tool_start",
      toolId: synthetic.id,
      sdkToolUseId: synthetic.id,
      name: toolName,
      input,
      approvalId: synthetic.approvalId,
    });
    return synthetic;
  }

  /** Translate one SDKMessage into ProviderEvents. */
  #translate(msg: SDKMessage): void {
    translateQwenMessage(msg, this.#emit.bind(this), this.id, {
      pendingTools: this.#pendingTools,
      seenSubagents: this.#seenSubagents,
      requestedModel: this.#currentModel,
    });
  }
}

// ── Pure translation (exported for unit tests) ────────────────────────────────

export interface QwenTranslateState {
  pendingTools: PendingTool[];
  seenSubagents: Set<string>;
  /**
   * Model this loop was built with. qwen-code's `result` message frequently
   * omits `modelUsage` (observed empty against the Bailian gateway), which
   * would leave every turn attributed to "unknown" in usage accounting — so
   * the requested id is the fallback.
   */
  requestedModel?: string | null;
}

/**
 * Translate one `@qwen-code/sdk` SDKMessage into zero or more ProviderEvents.
 * Pure apart from calling `emit` and mutating the caller-owned `state`, so it
 * can be unit-tested without spawning the CLI.
 */
export function translateQwenMessage(
  msg: SDKMessage,
  emit: (event: ProviderEvent) => void,
  providerId: string,
  state: QwenTranslateState,
): void {
  switch (msg.type) {
    case "assistant": {
      const m = msg as unknown as {
        message: {
          content?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        parent_tool_use_id: string | null;
      };
      const parentToolUseId = m.parent_tool_use_id ?? null;

      // The SDK exposes no SubagentStart hook, so a first sighting of a
      // parent_tool_use_id IS the subagent's start. agent_type isn't reported;
      // the spawning tool's name is the closest available label.
      if (parentToolUseId && !state.seenSubagents.has(parentToolUseId)) {
        state.seenSubagents.add(parentToolUseId);
        const spawner = state.pendingTools.find((p) => p.id === parentToolUseId);
        emit({
          type: "subagent_start",
          agentId: parentToolUseId,
          agentType: spawner?.name ?? "subagent",
        });
      }

      const perCall = m.message?.usage;
      if (perCall) {
        const usage: LLMCallUsage = {
          inputTokens: perCall.input_tokens ?? 0,
          cacheReadTokens: perCall.cache_read_input_tokens ?? 0,
          cacheCreationTokens: perCall.cache_creation_input_tokens ?? 0,
          outputTokens: perCall.output_tokens ?? 0,
        };
        emit({ type: "llm_call", usage, isPrimary: parentToolUseId === null });
      }

      const content = Array.isArray(m.message?.content)
        ? (m.message.content as Array<Record<string, unknown>>)
        : [];
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
          continue;
        }
        // Announce tool calls here — this is the only place the real
        // tool_use id is available (see QwenProvider#matchPendingTool).
        if (block.type === "tool_use" && typeof block.id === "string") {
          if (state.pendingTools.some((p) => p.id === block.id)) continue;
          const pending: PendingTool = {
            id: block.id,
            name: typeof block.name === "string" ? block.name : "unknown",
            input: (block.input as Record<string, unknown>) ?? {},
            approvalId: randomUUID(),
            gated: false,
          };
          state.pendingTools.push(pending);
          emit({
            type: "tool_start",
            toolId: pending.id,
            sdkToolUseId: pending.id,
            ...(parentToolUseId ? { sdkAgentId: parentToolUseId } : {}),
            name: pending.name,
            input: pending.input,
            approvalId: pending.approvalId,
          });
        }
      }
      if (textParts.length > 0) {
        emit({ type: "text_done", content: textParts.join(""), parentToolUseId });
      }
      break;
    }

    case "stream_event": {
      const m = msg as unknown as {
        event?: {
          type?: string;
          index?: number;
          content_block?: { type?: string };
          delta?: { type?: string; text?: string; thinking?: string };
        };
        parent_tool_use_id?: string | null;
      };
      const event = m.event;
      if (!event) break;
      const parentToolUseId = m.parent_tool_use_id ?? null;

      if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
        emit({ type: "thinking_delta", content: "", blockIndex: event.index, parentToolUseId });
        break;
      }
      if (event.type === "content_block_delta" && event.delta) {
        if (event.delta.type === "text_delta" && event.delta.text) {
          emit({ type: "text_delta", content: event.delta.text, parentToolUseId });
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          emit({
            type: "thinking_delta",
            content: event.delta.thinking,
            blockIndex: event.index,
            parentToolUseId,
          });
        }
        break;
      }
      if (event.type === "content_block_stop") {
        emit({ type: "thinking_done", blockIndex: event.index, parentToolUseId });
      }
      break;
    }

    case "user": {
      const content = (msg.message as { content?: unknown }).content;
      if (!Array.isArray(content)) break;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_result") continue;
        const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (!useId) continue;
        emit({
          type: "tool_complete",
          sdkToolUseId: useId,
          output: extractToolResultText(block.content),
          success: block.is_error !== true,
        });
        const i = state.pendingTools.findIndex((p) => p.id === useId);
        if (i !== -1) state.pendingTools.splice(i, 1);
      }
      break;
    }

    case "system": {
      const subtype = (msg as { subtype?: string }).subtype;
      if (subtype !== "init") break;
      const m = msg as { mcp_servers?: Array<{ name: string; status: string }>; tools?: string[] };
      const servers: Record<string, string> = {};
      const tools: Record<string, string[]> = {};
      for (const s of m.mcp_servers ?? []) {
        servers[s.name] = s.status;
        tools[s.name] = [];
      }
      for (const t of m.tools ?? []) {
        if (!t.startsWith("mcp__")) continue;
        const rest = t.slice("mcp__".length);
        const sep = rest.indexOf("__");
        if (sep <= 0) continue;
        const server = rest.slice(0, sep);
        tools[server] ??= [];
        tools[server].push(t);
      }
      emit({ type: "mcp_init", servers, tools });
      break;
    }

    case "result": {
      const r = msg as unknown as {
        subtype?: string;
        is_error?: boolean;
        num_turns?: number;
        result?: string;
        duration_ms?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        modelUsage?: Record<string, unknown>;
        error?: { message?: string };
      };
      // A turn is over: nothing may stay pending into the next one, or a stale
      // entry would mis-correlate a later same-named call.
      state.pendingTools.length = 0;
      state.seenSubagents.clear();

      const normalized: NormalizedTurnResult = {
        providerId,
        model: Object.keys(r.modelUsage ?? {})[0] ?? state.requestedModel ?? "unknown",
        inputTokens: r.usage?.input_tokens ?? 0,
        outputTokens: r.usage?.output_tokens ?? 0,
        cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
        // The Qwen gateway does not price responses; cost stays 0 like the
        // other non-Anthropic backends.
        totalCostUsd: 0,
        durationMs: r.duration_ms ?? 0,
        stopReason: r.subtype,
        isError: r.is_error,
        errorMessage:
          r.is_error === true ? (r.error?.message ?? r.result ?? "qwen turn failed") : undefined,
      };
      emit({ type: "turn_done", result: normalized });
      break;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guarantee the backing id the SDK receives is a UUID.
 *
 * `query()` validates `sessionId`/`resume` and THROWS SYNCHRONOUSLY on a
 * non-UUID ("Invalid sessionId … Must be a valid UUID"). That throw would
 * escape `runTurn()` rather than arriving as a turn error, wedging the
 * session. Live codeoid ids are `randomUUID()`, so this only fires for a
 * backing id persisted by another backend, a hand-built id, or a test — where
 * degrading to a fresh backing session beats a hard failure.
 *
 * Pure + exported for unit testing.
 */
export function coerceBackingId(candidate: string, sessionId: string): string {
  if (UUID_RE.test(candidate)) return candidate;
  const replacement = randomUUID();
  console.warn(
    `[qwen-provider ${sessionId.slice(0, 8)}] backing id ${JSON.stringify(candidate)} is not a UUID — qwen-code requires one; starting a fresh backing session instead`,
  );
  return replacement;
}

/**
 * Pick the credential path. An explicit config value always wins; otherwise a
 * qwen.ai login on disk beats the API key, matching the subscription-first
 * posture codeoid uses for claude/codex.
 */
export function resolveQwenAuthType(
  configured: "openai" | "qwen-oauth" | undefined,
  oauthCredsPath: string = QWEN_OAUTH_CREDS,
): "openai" | "qwen-oauth" {
  if (configured) return configured;
  return existsSync(oauthCredsPath) ? "qwen-oauth" : "openai";
}

/**
 * Normalize `Query.getAvailableModels()`, which is typed only as
 * `Record<string, unknown> | null`.
 *
 * The shape actually emitted by @qwen-code/sdk 0.1.8 is
 * `{ subtype, models: [{ id, label, capabilities, contextWindowSize }] }` —
 * note `label`, not `name`, and no `description` (the CLI's
 * `handleGetAvailableModels` projects the registry entry down to those four
 * fields, dropping the description the registry itself carries). `name` /
 * `modelId` / `availableModels` are kept as accepted aliases so a future
 * rename doesn't silently empty the picker.
 *
 * A bare array is accepted too; anything else yields `[]` rather than throwing.
 */
export function normalizeModelCatalog(raw: unknown): ModelInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { availableModels?: unknown })?.availableModels)
      ? ((raw as { availableModels: unknown[] }).availableModels)
      : Array.isArray((raw as { models?: unknown })?.models)
        ? ((raw as { models: unknown[] }).models)
        : [];
  const out: ModelInfo[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      out.push({ id: entry, displayName: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.modelId === "string" ? e.modelId : typeof e.id === "string" ? e.id : null;
    if (!id) continue;
    const label =
      typeof e.label === "string" ? e.label : typeof e.name === "string" ? e.name : id;
    out.push({
      id,
      displayName: label,
      ...(typeof e.description === "string" ? { description: e.description } : {}),
    });
  }
  return out;
}

/** Give up on a catalog fetch well inside any reasonable session-start budget. */
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch an OpenAI-compatible `GET /models` catalog.
 *
 * Every gateway codeoid points the qwen backend at (DashScope, the Bailian
 * token-plan host, or a bring-your-own URL) speaks the OpenAI wire protocol —
 * that is the whole premise of `authType: "openai"` — so `/models` is
 * available and authoritative. Response shape is
 * `{ object: "list", data: [{ id, object, created, owned_by }] }`; only `id`
 * is load-bearing here.
 *
 * Exported for unit testing. Throws on transport error or non-2xx.
 */
export async function fetchOpenAiModelCatalog(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const body: unknown = await res.json();
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelInfo[] = [];
  for (const entry of data) {
    const id =
      typeof entry === "string"
        ? entry
        : typeof (entry as { id?: unknown })?.id === "string"
          ? ((entry as { id: string }).id)
          : null;
    if (id) out.push({ id, displayName: id });
  }
  return out;
}

/**
 * Union two catalogs, deduped by model id, `primary` order first.
 *
 * Where both sources carry the same id, the richer entry wins: an entry whose
 * `displayName` differs from its id has a real human label behind it (the
 * qwen-code registry supplies these; `/models` returns bare ids), so that one
 * is kept and its description carried over.
 *
 * Exported for unit testing.
 */
export function unionCatalogs(
  primary: readonly ModelInfo[],
  secondary: readonly ModelInfo[],
): ModelInfo[] {
  const labelled = (m: ModelInfo): boolean => m.displayName !== m.id;
  const byId = new Map<string, ModelInfo>();
  for (const m of [...primary, ...secondary]) {
    const existing = byId.get(m.id);
    if (!existing) {
      byId.set(m.id, m);
      continue;
    }
    if (!labelled(existing) && labelled(m)) byId.set(m.id, m);
  }
  return [...byId.values()];
}

/**
 * Registry servers for the qwen backend, as SDK MCP configs — a native mount,
 * since qwen-code owns its own MCP client. `${VAR}` env refs and
 * `bearerTokenEnv` resolve against the daemon env here so secrets never live
 * in config; tool calls still gate through canUseTool.
 */
export function registryServersForQwen(
  registry: McpRegistry | undefined,
): Record<string, unknown> {
  if (!registry) return {};
  const out: Record<string, unknown> = {};
  for (const spec of registry.forBackend("qwen")) {
    if (spec.builtin) continue;
    const t = spec.transport;
    if (t.kind === "stdio") {
      out[spec.name] = {
        command: t.command,
        args: t.args,
        env: resolveEnvMap(t.env ?? {}, process.env),
      };
    } else if (t.kind === "http") {
      const headers: Record<string, string> = { ...t.headers };
      if (t.bearerTokenEnv) {
        const tok = process.env[t.bearerTokenEnv];
        if (tok) headers.Authorization = `Bearer ${tok}`;
      }
      out[spec.name] = { httpUrl: t.url, headers };
    }
  }
  return out;
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "image") {
      parts.push("[image]");
    } else if (typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}
