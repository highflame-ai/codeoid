/**
 * GeminiProvider — stateless Gemini backend for codeoid.
 *
 * Each runTurn() call converts the full CanonicalTurn[] history to Gemini's
 * Content[] format and issues a single streaming generateContent request.
 * No persistent session state: the entire conversation context is resent on
 * every turn, which is the Gemini API's natural model.
 *
 * History fidelity: tool calls from prior turns (any backend) arrive as
 *   native functionCall/functionResponse parts via toGeminiContent(), so
 *   Gemini sees real tool-call turns. Gemini itself remains text-only in
 *   its OWN turns (no function-calling loop here yet).
 *
 * Auth: reads GOOGLE_API_KEY from the environment. Override with
 *   GeminiProviderInit.apiKey for programmatic control (tests, multi-tenant).
 */

import type { McpTenant } from "../../mcp/oauth.js";
import type { EffortLevel } from "../../../protocol/types.js";
import { effortRejectionHint } from "../effort.js";
import {
  GoogleGenerativeAI,
  type FunctionDeclaration,
  type GenerateContentStreamResult,
  type GenerationConfig,
  type Part,
} from "@google/generative-ai";
import { AsyncQueue } from "../../async-queue.js";
import type {
  AgentProvider,
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  TurnOpts,
  TurnRun,
} from "../interface.js";
import { toGeminiContent } from "../canonical.js";
import type { MemoryEngine } from "../../memory/index.js";
import {
  ASK_USER_TOOL_NAME,
  askUserToolAsGemini,
  executeAskUserCall,
  executeMcpToolCall,
  executeMemoryToolCall,
  MAX_MEMORY_TOOL_ROUNDS,
  mcpToolsAsGemini,
  memoryToolsAsGemini,
} from "../tool-loop.js";
import { SessionMcpTools } from "../../mcp/tool-source.js";
import type { McpServerView } from "../../mcp/registry.js";
import type { McpHub } from "../../mcp/hub.js";

export interface GeminiProviderInit {
  /** Explicit API key — falls back to GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** The session's account, per turn (accounts.ts): its key replaces `apiKey`. A throw fails the turn. */
  resolveApiKey?: () => { key: string; fingerprint: string } | null;
  /** Model to use when TurnOpts.model is absent. */
  defaultModel?: string;
  /** Memory engine — when present, the memory recall tools are offered as
   *  function declarations so the model can page the verbatim store on demand. */
  memory?: MemoryEngine;
  /** Tenant-scoped workspace id + session id — the memory tool call scope. */
  workspaceId?: string;
  /** The session's tenant — whose credentials an OAuth MCP server uses. */
  tenant?: McpTenant;
  sessionId?: string;
  /** Cross-backend MCP registry + daemon-owned client — external servers reach
   *  this backend (which has no MCP client) through the hub. */
  mcpRegistry?: McpServerView;
  mcpHub?: McpHub;
}

/** The Gemini API models the picker offers (#430: every one has a price in the snapshot). */
export const GEMINI_MODELS: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" },
  { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite" },
];
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

export class GeminiProvider implements AgentProvider {
  /** tool-loop runs `verdict.updatedInput ?? args` (see AgentProvider.appliesToolInputRewrite). */
  readonly appliesToolInputRewrite = true;
  readonly id = "gemini";
  readonly displayName = "Gemini (Google)";

  #apiKey: string;
  #resolveApiKey: (() => { key: string; fingerprint: string } | null) | null;
  #defaultModel: string;
  #memory: MemoryEngine | null;
  #workspaceId: string;
  #tenant: McpTenant | undefined;
  #sessionId: string;
  #mcpRegistry: McpServerView | null;
  #mcpHub: McpHub | null;

  constructor(init: GeminiProviderInit = {}) {
    this.#apiKey = init.apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    this.#resolveApiKey = init.resolveApiKey ?? null;
    // A current, priced model (#430): 2.0 and 1.5 are retired, and their turns couldn't be priced.
    this.#defaultModel = init.defaultModel ?? GEMINI_DEFAULT_MODEL;
    this.#memory = init.memory ?? null;
    this.#workspaceId = init.workspaceId ?? init.sessionId ?? "";
    this.#tenant = init.tenant;
    this.#sessionId = init.sessionId ?? "";
    this.#mcpRegistry = init.mcpRegistry ?? null;
    this.#mcpHub = init.mcpHub ?? null;
  }

  /** The memory recall tools are offered whenever a memory engine is wired,
   *  so the model can page the verbatim store on demand. */
  get supportsMemoryTools(): boolean {
    return this.#memory != null;
  }

  runTurn(opts: TurnOpts): TurnRun {
    if (!this.#apiKey) {
      const queue = new AsyncQueue<ProviderEvent>();
      queue.push({ type: "error", message: "GeminiProvider: GOOGLE_API_KEY is not set" });
      queue.close();
      return {
        events: queue,
        interrupt: async () => {},
      };
    }

    const queue = new AsyncQueue<ProviderEvent>();
    const ac = new AbortController();
    const startMs = Date.now();

    // Guard the fire-and-forget: work BEFORE #stream's internal try (notably
    // `await mcpTools.handles()` for MCP discovery) can reject, which would be an
    // unhandled rejection AND leave `queue` unclosed — the consumer's `for await`
    // would hang forever with no turn_done/error. Surface it as an error event
    // and close the queue (mirrors the OpenAI provider, which guards this inline).
    void this.#stream(opts, queue, ac, startMs).catch((err) => {
      if (!ac.signal.aborted) {
        queue.push({
          type: "error",
          message: `GeminiProvider: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      queue.close();
    });

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
    const genAI = new GoogleGenerativeAI(this.#resolveApiKey?.()?.key ?? this.#apiKey);
    // Tools offered: the memory tools when a memory engine is wired, plus the
    // ask-user tool when the session can raise dialogs. With neither this stays
    // the plain single-call text path (unchanged behavior).
    const emit = (e: ProviderEvent) => queue.push(e);
    const memoryDeps = this.#memory
      ? {
          ctx: { engine: this.#memory, workspaceId: this.#workspaceId, sessionId: this.#sessionId },
          canUseTool: opts.canUseTool,
          emit,
        }
      : null;
    const askDeps = opts.requestUserInput ? { requestUserInput: opts.requestUserInput, emit } : null;
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
    const declarations = [
      ...(memoryDeps ? memoryToolsAsGemini() : []),
      ...mcpToolsAsGemini(mcpHandles),
      ...(askDeps ? [askUserToolAsGemini()] : []),
    ];
    const genModel = genAI.getGenerativeModel({
      model,
      // Structurally a valid Gemini schema (SchemaType values are the same
      // lowercase strings as JSON Schema); the cast bridges the nominal type.
      ...(declarations.length > 0
        ? { tools: [{ functionDeclarations: declarations as unknown as FunctionDeclaration[] }] }
        : {}),
      // Thinking effort (#417). This SDK predates `thinkingConfig` in its
      // types but sends generationConfig as given; the API reads it.
      ...(opts.effort && geminiThinkingConfig(model, opts.effort)
        ? { generationConfig: { thinkingConfig: geminiThinkingConfig(model, opts.effort) } as GenerationConfig }
        : {}),
    });

    try {
      // Split history: everything before the last user turn goes as chat history;
      // the last user turn (or opts.userMessage) becomes the current request.
      const { chatHistory, userMessage } = splitForStateless(opts);

      const geminiHistory = toGeminiContent(chatHistory);

      const chat = genModel.startChat({
        history: geminiHistory,
        // Gemini accepts systemInstruction as a plain string.
        ...(opts.systemPromptAppend ? { systemInstruction: opts.systemPromptAppend } : {}),
      });

      let finalText = "";
      let inputTokens = 0;
      let cacheReadTokens = 0;
      let largestPrompt = 0;
      let outputTokens = 0;
      let stopReason: string | undefined;
      // First message is the user turn; later rounds send functionResponse parts.
      let message: string | Part[] = userMessage;

      // Agentic tool-loop: stream a response; if the model called tools, execute
      // them and reply with functionResponse parts, then loop. The round cap is
      // a runaway/cost guard. A no-memory turn ends after one round (no calls).
      for (let round = 0; ; round++) {
        let streamResult: GenerateContentStreamResult;
        // The request counts once the API takes it (#430): a refusal spent
        // nothing; one stopped while pending may have.
        const spent = () => {
          try {
            queue.push({ type: "model_request" });
          } catch {
            // The turn's queue already closed.
          }
        };
        try {
          streamResult = await chat.sendMessageStream(message, { signal: ac.signal });
          spent();
        } catch (err) {
          if (ac.signal.aborted) {
            spent();
            return;
          }
          // Only a refusal before any work is unsent; a 5xx or a reset may have spent (#430).
          if (!isRefusal(err)) spent();
          queue.push({
            type: "error",
            message: `Gemini API error: ${err instanceof Error ? err.message : String(err)}${opts.effort ? effortRejectionHint(err instanceof Error ? err.message : String(err), opts.effort) : ""}`,
          });
          return;
        }

        let roundText = "";
        for await (const chunk of streamResult.stream) {
          if (ac.signal.aborted) return;
          const text = chunk.text();
          if (text) {
            queue.push({ type: "text_delta", content: text });
            roundText += text;
          }
        }
        if (ac.signal.aborted) return;

        const response = await streamResult.response;
        // Cached prompt tokens are priced apart, and thinking tokens are billed as output (#430).
        const usage = response.usageMetadata as
          | { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number }
          | undefined;
        const cached = usage?.cachedContentTokenCount ?? 0;
        inputTokens += Math.max(0, (usage?.promptTokenCount ?? 0) - cached);
        largestPrompt = Math.max(largestPrompt, usage?.promptTokenCount ?? 0);
        // This request's own usage, so a turn that ends mid-loop is still counted
        // (#430) — only when the API sent it: zeros would hide what it spent.
        if (usage) queue.push({
          type: "llm_call",
          isPrimary: true,
          usage: {
            inputTokens: Math.max(0, (usage?.promptTokenCount ?? 0) - cached),
            cacheReadTokens: cached,
            cacheCreationTokens: 0,
            outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
          },
        });
        cacheReadTokens += cached;
        outputTokens += (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
        finalText = roundText;
        stopReason = response.candidates?.[0]?.finishReason
          ? String(response.candidates[0].finishReason)
          : undefined;

        const calls = response.functionCalls() ?? [];
        if (calls.length === 0 || declarations.length === 0 || round >= MAX_MEMORY_TOOL_ROUNDS) break;
        if (ac.signal.aborted) return; // don't run tools for an aborted turn

        // Execute each call, reply with functionResponse parts, and loop.
        const parts: Part[] = [];
        for (const call of calls) {
          if (ac.signal.aborted) return;
          const args = (call.args ?? {}) as Record<string, unknown>;
          const output =
            call.name === ASK_USER_TOOL_NAME && askDeps
              ? await executeAskUserCall(args, askDeps)
              : mcpDeps && call.name.startsWith("mcp__")
                ? await executeMcpToolCall(call.name, args, mcpDeps)
                : memoryDeps
                  ? await executeMemoryToolCall(call.name, args, memoryDeps)
                  : `Tool unavailable: ${call.name}`;
          parts.push({ functionResponse: { name: call.name, response: { result: output } } });
        }
        message = parts;
      }

      if (ac.signal.aborted) return;

      queue.push({ type: "text_done", content: finalText });

      const result: NormalizedTurnResult = {
        providerId: this.id,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        totalCostUsd: 0, // no cost in the response: the session prices the tokens (#430)
        ...(largestPrompt > 0 ? { largestPromptTokens: largestPrompt } : {}),
        durationMs: Date.now() - startMs,
        stopReason,
      };

      queue.push({ type: "turn_done", result });
    } catch (err) {
      if (!ac.signal.aborted) {
        queue.push({
          type: "error",
          message: `GeminiProvider: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      queue.close();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Gemini's REST model-list endpoint requires a separate authenticated call.
    // Return a static list of well-known models; this is enough for the
    // session model-picker UI and can be replaced with a live fetch in Phase 2.
    return GEMINI_MODELS.map((m) => ({ ...m, ...(m.id === this.#defaultModel ? { isDefault: true } : {}) }));
  }

  async dispose(): Promise<void> {
    // Stateless — nothing to tear down.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split canonical history into chat context + current user message.
 * Stateless providers receive the full history on every runTurn() call.
 * The last user turn (if present) becomes the live message; everything
 * before it is the chat context.
 */
export function splitForStateless(opts: TurnOpts): {
  chatHistory: readonly import("../canonical.js").CanonicalTurn[];
  userMessage: string;
} {
  const history = opts.history;
  const last = history.at(-1);

  if (last?.role === "user") {
    return {
      chatHistory: history.slice(0, -1),
      userMessage: last.content || opts.userMessage,
    };
  }

  // Fallback: history ended with an assistant turn (e.g. mid-turn re-entry).
  return {
    chatHistory: history,
    userMessage: opts.userMessage,
  };
}

/**
 * A thinking effort as Gemini's thinkingConfig (#417), by model family.
 * 2.5 models take a token budget: 0 turns thinking off, except on Pro (its
 * floor is 128); Flash-Lite thinks from 512; Flash and Flash-Lite stop at
 * 24576. 3.x models take a level — Pro only Low and High, Flash also Minimal
 * and Medium. Other models don't think: nothing is sent.
 */
export function geminiThinkingConfig(model: string, effort: EffortLevel): Record<string, unknown> | null {
  if (/gemini-2\.5/.test(model)) {
    const pro = /pro/.test(model);
    // From Minimal up every budget is at least 512, Flash-Lite's floor.
    const budgets: Record<EffortLevel, number> = { off: 0, minimal: 512, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768 };
    return { thinkingBudget: Math.min(Math.max(budgets[effort], pro ? 128 : 0), pro ? 32768 : 24576) };
  }
  if (/gemini-3/.test(model)) {
    if (/pro/.test(model)) return { thinkingLevel: effort === "off" || effort === "minimal" || effort === "low" ? "low" : "high" };
    const level = effort === "off" || effort === "minimal" ? "minimal" : effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
    return { thinkingLevel: level };
  }
  return null;
}

/** A request the API refused before doing any work (#430): a client error it answered at once. */
function isRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && [400, 401, 403, 404, 422, 429].includes(status);
}
