/**
 * OpenAIProvider — stateless OpenAI backend for codeoid.
 *
 * Each runTurn() call converts the full CanonicalTurn[] history to OpenAI's
 * messages[] format and issues a single streaming chat completion request.
 *
 * History fidelity: tool calls from prior turns (any backend) arrive as
 *   native assistant tool_calls[] + { role: "tool" } messages via
 *   toOpenAIMessages(), so the model sees real tool-call turns. The
 *   provider itself remains text-only in its OWN turns (no function-calling
 *   loop here yet).
 *
 * Auth: reads OPENAI_API_KEY from the environment. Override with
 *   OpenAIProviderInit.apiKey for programmatic control.
 */

import type { McpTenant } from "../../mcp/oauth.js";
import OpenAI from "openai";
import { AsyncQueue } from "../../async-queue.js";
import type {
  AgentProvider,
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  TurnOpts,
  TurnRun,
} from "../interface.js";
import { toOpenAIMessages } from "../canonical.js";
import { splitForStateless } from "../gemini/index.js";
import type { MemoryEngine } from "../../memory/index.js";
import {
  ASK_USER_TOOL_NAME,
  askUserToolAsOpenAI,
  executeAskUserCall,
  executeMcpToolCall,
  executeMemoryToolCall,
  MAX_MEMORY_TOOL_ROUNDS,
  mcpToolsAsOpenAI,
  memoryToolsAsOpenAI,
  type OpenAIFunctionTool,
} from "../tool-loop.js";
import { SessionMcpTools, type McpServerSource } from "../../mcp/tool-source.js";
import type { McpHub } from "../../mcp/hub.js";

export interface OpenAIProviderInit {
  /**
   * Override the id/displayName this instance reports. Lets the same
   * wire-compatible client power more than one registry entry (e.g.
   * "llamacpp" against a local server, "openai" against a cloud gateway)
   * WITHOUT the two colliding on persisted `providerId` / resume lookups —
   * those read the live instance's `.id`, not the factory that built it.
   * Defaults to "openai" / "GPT (OpenAI)".
   */
  id?: string;
  displayName?: string;
  /** Explicit API key — falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Default model when TurnOpts.model is absent. */
  defaultModel?: string;
  /** Override base URL (useful for Azure OpenAI or local proxies). */
  baseURL?: string;
  /** Memory engine — when present, the memory recall tools are offered as
   *  function tools so the model can page the verbatim store on demand. */
  memory?: MemoryEngine;
  /** Tenant-scoped workspace id + session id — the memory tool call scope. */
  workspaceId?: string;
  /** The session's tenant — whose credentials an OAuth MCP server uses. */
  tenant?: McpTenant;
  sessionId?: string;
  /** Cross-backend MCP registry + daemon-owned client — external servers reach
   *  this backend (which has no MCP client) through the hub. */
  mcpRegistry?: McpServerSource;
  mcpHub?: McpHub;
  /**
   * Which of the server's models to list. Defaults to OpenAI's chat families;
   * a local server serves arbitrarily named models, so it lists them all.
   */
  modelFilter?: (id: string) => boolean;
  /** Listed when the server can't be reached. Defaults to a few GPT models. */
  fallbackModels?: ModelInfo[];
  /**
   * The context window the SERVER is running with, asked once per turn and
   * reported on the turn result. Only a server that can say (llama-server's
   * `/props`) passes one; without it the daemon falls back to its tables.
   */
  contextWindow?: () => Promise<number | undefined>;
  /**
   * Rewrite the tool list before it is sent, for servers stricter than
   * OpenAI's about tool schemas (llama.cpp compiles them into a grammar).
   */
  toolsTransform?: (tools: OpenAIFunctionTool[]) => OpenAIFunctionTool[];
}

const OPENAI_CHAT_MODEL = (id: string) =>
  id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3");

const OPENAI_FALLBACK_MODELS: ModelInfo[] = [
  { id: "gpt-4o", displayName: "GPT-4o" },
  { id: "gpt-4o-mini", displayName: "GPT-4o Mini" },
  { id: "o3-mini", displayName: "o3-mini" },
];

export class OpenAIProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;

  #client: OpenAI;
  #defaultModel: string;
  #memory: MemoryEngine | null;
  #workspaceId: string;
  #tenant: McpTenant | undefined;
  #sessionId: string;
  #mcpRegistry: McpServerSource | null;
  #mcpHub: McpHub | null;
  #modelFilter: (id: string) => boolean;
  #fallbackModels: ModelInfo[];
  #contextWindow: (() => Promise<number | undefined>) | null;
  #toolsTransform: ((tools: OpenAIFunctionTool[]) => OpenAIFunctionTool[]) | null;

  constructor(init: OpenAIProviderInit = {}) {
    this.id = init.id ?? "openai";
    this.displayName = init.displayName ?? "GPT (OpenAI)";
    this.#client = new OpenAI({
      apiKey: init.apiKey ?? process.env.OPENAI_API_KEY ?? "missing",
      ...(init.baseURL ? { baseURL: init.baseURL } : {}),
    });
    this.#defaultModel = init.defaultModel ?? "gpt-4o";
    this.#memory = init.memory ?? null;
    this.#workspaceId = init.workspaceId ?? init.sessionId ?? "";
    this.#tenant = init.tenant;
    this.#sessionId = init.sessionId ?? "";
    this.#mcpRegistry = init.mcpRegistry ?? null;
    this.#mcpHub = init.mcpHub ?? null;
    this.#modelFilter = init.modelFilter ?? OPENAI_CHAT_MODEL;
    this.#fallbackModels = init.fallbackModels ?? OPENAI_FALLBACK_MODELS;
    this.#contextWindow = init.contextWindow ?? null;
    this.#toolsTransform = init.toolsTransform ?? null;
  }

  /** The memory recall tools are offered whenever a memory engine is wired,
   *  so the model can page the verbatim store on demand. */
  get supportsMemoryTools(): boolean {
    return this.#memory != null;
  }

  runTurn(opts: TurnOpts): TurnRun {
    const queue = new AsyncQueue<ProviderEvent>();
    const ac = new AbortController();
    const startMs = Date.now();

    void this.#stream(opts, queue, ac, startMs);

    return {
      events: queue,
      interrupt: async () => {
        ac.abort();
        queue.close();
      },
    };
  }

  async #stream(
    opts: TurnOpts,
    queue: AsyncQueue<ProviderEvent>,
    ac: AbortController,
    startMs: number,
  ): Promise<void> {
    const model = opts.model ?? this.#defaultModel;

    try {
      const { chatHistory, userMessage } = splitForStateless(opts);

      // Build the messages array: system prompt + chat history + current user turn.
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (opts.systemPromptAppend) {
        messages.push({ role: "system", content: opts.systemPromptAppend });
      }

      for (const m of toOpenAIMessages(chatHistory)) {
        messages.push(m as OpenAI.Chat.ChatCompletionMessageParam);
      }

      messages.push({ role: "user", content: userMessage });

      // Tools offered: the memory tools when a memory engine is wired, plus the
      // ask-user tool when the session can raise dialogs. With neither this
      // stays the plain single-call text path (unchanged behavior).
      const emit = (e: ProviderEvent) => queue.push(e);
      const memoryDeps = this.#memory
        ? {
            ctx: { engine: this.#memory, workspaceId: this.#workspaceId, sessionId: this.#sessionId },
            canUseTool: opts.canUseTool,
            emit,
          }
        : null;
      const askDeps = opts.requestUserInput
        ? { requestUserInput: opts.requestUserInput, emit }
        : null;
      // External MCP servers (registry) reach this clientless backend through
      // the daemon-owned hub. Discover their tools once per turn.
      const mcpTools =
        this.#mcpRegistry && this.#mcpHub
          ? new SessionMcpTools(this.#mcpRegistry, this.#mcpHub, this.id, {
              workspaceId: this.#workspaceId,
              sessionId: this.#sessionId,
              ...(this.#tenant ? { tenant: this.#tenant } : {}),
            })
          : null;
      const mcpHandles = mcpTools?.hasServers() ? await mcpTools.handles() : [];
      const mcpDeps = mcpTools ? { tools: mcpTools, canUseTool: opts.canUseTool, emit } : null;
      const offered: OpenAIFunctionTool[] = [
        ...(memoryDeps ? memoryToolsAsOpenAI() : []),
        ...mcpToolsAsOpenAI(mcpHandles),
        ...(askDeps ? [askUserToolAsOpenAI()] : []),
      ];
      const toolList = this.#toolsTransform ? this.#toolsTransform(offered) : offered;
      const tools = toolList.length > 0 ? toolList : undefined;

      let finalText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | undefined;

      // Agentic tool-loop: each round streams a completion; if the model asked
      // for tools we execute them, append the results, and loop. The round cap
      // is a runaway/cost guard — past it we stop offering tools so the model
      // must answer. A no-memory turn runs exactly one round (tools undefined).
      for (let round = 0; ; round++) {
        const offerTools = tools && round < MAX_MEMORY_TOOL_ROUNDS;
        const stream = await this.#client.chat.completions.create(
          {
            model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(offerTools ? { tools } : {}),
          },
          { signal: ac.signal },
        );

        let roundText = "";
        // OpenAI streams tool_calls as indexed deltas — accumulate by index.
        const toolCalls: Array<{ id: string; name: string; args: string }> = [];
        let finish: string | undefined;
        let chunks = 0;

        for await (const chunk of stream) {
          if (ac.signal.aborted) return;
          chunks++;
          const choice = chunk.choices[0];
          const delta = choice?.delta?.content;
          if (delta) {
            queue.push({ type: "text_delta", content: delta });
            roundText += delta;
          }
          for (const tc of choice?.delta?.tool_calls ?? []) {
            let slot = toolCalls[tc.index];
            if (!slot) {
              slot = { id: "", name: "", args: "" };
              toolCalls[tc.index] = slot;
            }
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
          if (chunk.usage) {
            inputTokens += chunk.usage.prompt_tokens ?? 0;
            outputTokens += chunk.usage.completion_tokens ?? 0;
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
        if (ac.signal.aborted) return;
        if (chunks === 0) {
          // A stream that ends before its first chunk is a failure the server
          // reported in a form the client could not parse: llama-server sends
          // `error: {...}`, which is not an SSE field, so the SDK drops it and
          // sees a clean [DONE]. Reporting success here would record a turn
          // with no answer and no reason.
          throw new Error(
            "the server ended the response before sending anything. For a local server " +
              "this usually means the prompt exceeded its context size (--ctx-size).",
          );
        }

        finalText = roundText;

        // Deltas are accumulated by index; drop any holes so a non-contiguous
        // (sparse) tool_calls stream can't yield an `undefined` slot below.
        const calls = toolCalls.filter((c) => c?.id);

        // Not a tool round (or cap reached) — this is the final answer.
        if (finish !== "tool_calls" || !tools || calls.length === 0 || round >= MAX_MEMORY_TOOL_ROUNDS) {
          stopReason = finish;
          break;
        }

        // Record the assistant's tool-call turn, then each tool result, and loop.
        messages.push({
          role: "assistant",
          content: roundText || null,
          tool_calls: calls.map((t) => ({
            id: t.id,
            type: "function" as const,
            function: { name: t.name, arguments: t.args || "{}" },
          })),
        });
        for (const t of calls) {
          if (ac.signal.aborted) return; // stop paging if the turn was aborted
          let args: Record<string, unknown> = {};
          try {
            args = t.args ? (JSON.parse(t.args) as Record<string, unknown>) : {};
          } catch {
            /* malformed args — pass {} and let the tool clamp/complain */
          }
          const output =
            t.name === ASK_USER_TOOL_NAME && askDeps
              ? await executeAskUserCall(args, askDeps)
              : mcpDeps && t.name.startsWith("mcp__")
                ? await executeMcpToolCall(t.name, args, mcpDeps)
                : memoryDeps
                  ? await executeMemoryToolCall(t.name, args, memoryDeps)
                  : `Tool unavailable: ${t.name}`;
          messages.push({ role: "tool", tool_call_id: t.id, content: output });
        }
      }

      if (ac.signal.aborted) return;

      // Best-effort: a window the server can't report leaves the daemon on its
      // tables, which is where it would have been anyway.
      const contextWindow = await this.#contextWindow?.().catch(() => undefined);

      queue.push({ type: "text_done", content: finalText });

      const result: NormalizedTurnResult = {
        providerId: this.id,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0, // OpenAI does not return cost in the streaming response.
        durationMs: Date.now() - startMs,
        stopReason,
        ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
      };

      queue.push({ type: "turn_done", result });
    } catch (err) {
      if (!ac.signal.aborted) {
        queue.push({
          type: "error",
          message: `${this.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      queue.close();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const resp = await this.#client.models.list();
      return resp.data
        .filter((m) => this.#modelFilter(m.id))
        // A local server names its model by the file it loaded; the path is
        // noise in a picker, the file name is not.
        .map((m) => ({ id: m.id, displayName: m.id.split("/").pop() || m.id }));
    } catch {
      return this.#fallbackModels;
    }
  }

  async dispose(): Promise<void> {
    // Stateless — nothing to tear down.
  }
}
