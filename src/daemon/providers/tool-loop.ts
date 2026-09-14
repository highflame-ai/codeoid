/**
 * Shared memory tool-loop helpers for the stateless function-calling backends
 * (OpenAI, Gemini).
 *
 * These backends resend the full canonical history every turn (lossless by
 * residency), so codeoid's memory tools are the ESCAPE HATCH: they let the
 * model page the verbatim store on demand — cross-session recall, or detail
 * beyond the window when a long history is truncated — via native function
 * calling. Because these providers run IN the daemon (not a subprocess), a tool
 * call executes `def.run()` directly; no MCP endpoint or proxy is involved
 * (that's what the URL-mounting backends in Phases 2–3 needed).
 *
 * SDK-specific streaming stays in each provider; this module owns the parts
 * that must stay identical across them: the tool declarations (namespaced so
 * `isSafeTool` treats them as read-only and they don't prompt), executing one
 * call through codeoid's `canUseTool` gate with tool_start/complete events, and
 * the per-turn runaway guard.
 */

import { randomUUID } from "node:crypto";
import { memoryToolDefs, type MemoryToolContext } from "@highflame/codeoid-memory/tools.js";
import { MEMORY_MCP_SERVER_NAME } from "@highflame/codeoid-memory/mcp-http.js";
import type { McpToolHandle, SessionMcpTools } from "../mcp/tool-source.js";
import type { ProviderEvent, ToolApprovalFn, UiRequest, UiRequestFn } from "./interface.js";

/** Hard cap on tool rounds in a single turn — a runaway + cost guard. After
 *  this many rounds the loop stops paging and lets the model answer. */
export const MAX_MEMORY_TOOL_ROUNDS = 8;

const PREFIX = `${MEMORY_MCP_SERVER_NAME}__`;

/** Namespaced tool name so `isSafeTool` treats it as a read-only memory tool. */
export function namespacedMemoryToolName(bare: string): string {
  return `${PREFIX}${bare}`;
}

interface FunctionToolShape {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The ask-the-user tool. Unlike the memory tools, this backend (openai/gemini)
 * has no native way to ask the human anything mid-turn — this gives it one. A
 * call routes to `requestUserInput` (a `session.ui_request` dialog rendered by
 * every capable frontend), NOT through the canUseTool approval gate: asking the
 * user IS the interaction, so gating it would double-prompt.
 */
export const ASK_USER_TOOL_NAME = "ask_user";

const ASK_USER_DESCRIPTION =
  "Ask the human user a question and wait for their answer. Use ONLY when you need a decision, clarification, or information that only the user can provide — not for things you can determine yourself. Provide `options` for a multiple-choice pick; omit it for free-text.";

const ASK_USER_PARAMETERS = {
  type: "object",
  properties: {
    question: { type: "string", description: "The question to put to the user" },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Optional choices; when given the user picks one",
    },
  },
  required: ["question"],
} as const;

/** OpenAI function-tool declaration for the ask-user tool. */
export function askUserToolAsOpenAI(): { type: "function"; function: FunctionToolShape } {
  return {
    type: "function" as const,
    function: {
      name: ASK_USER_TOOL_NAME,
      description: ASK_USER_DESCRIPTION,
      parameters: { ...ASK_USER_PARAMETERS, additionalProperties: false },
    },
  };
}

/** Gemini functionDeclaration for the ask-user tool (no additionalProperties). */
export function askUserToolAsGemini(): FunctionToolShape {
  return { name: ASK_USER_TOOL_NAME, description: ASK_USER_DESCRIPTION, parameters: { ...ASK_USER_PARAMETERS } };
}

export interface AskUserExecDeps {
  requestUserInput: UiRequestFn;
  emit: (e: ProviderEvent) => void;
}

/**
 * Execute an ask-user tool call: raise a dialog via `requestUserInput` and feed
 * the answer back to the model as the tool result. Emits tool_start/complete
 * for the transcript but does NOT gate through canUseTool. Never throws — a
 * dismissed/timed-out dialog returns a plain "no answer" string.
 */
export async function executeAskUserCall(
  args: Record<string, unknown>,
  deps: AskUserExecDeps,
): Promise<string> {
  const question = typeof args.question === "string" && args.question.trim().length > 0
    ? args.question
    : "The assistant needs your input.";
  const options = Array.isArray(args.options)
    ? args.options.filter((o): o is string => typeof o === "string")
    : undefined;
  const toolId = randomUUID();
  deps.emit({
    type: "tool_start",
    toolId,
    sdkToolUseId: toolId,
    name: ASK_USER_TOOL_NAME,
    input: args,
    approvalId: `ask-${toolId}`,
  });

  const req: UiRequest =
    options && options.length > 0
      ? { method: "select", title: question, options }
      : { method: "input", title: question };
  const resp = await deps.requestUserInput(req);
  const answer = resp.cancelled
    ? "The user dismissed the question without answering."
    : resp.value ?? (resp.confirmed !== undefined ? String(resp.confirmed) : "");
  deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: answer, success: !resp.cancelled });
  return answer;
}

/** OpenAI `tools[]` (chat.completions function tools) for the memory tools. */
export function memoryToolsAsOpenAI(): Array<{ type: "function"; function: FunctionToolShape }> {
  return memoryToolDefs().map((d) => ({
    type: "function" as const,
    function: { name: namespacedMemoryToolName(d.name), description: d.description, parameters: d.jsonSchema },
  }));
}

/** Gemini `functionDeclarations[]` for the memory tools. Gemini's function
 *  schema is an OpenAPI subset that rejects `additionalProperties`, so drop it
 *  (our tool schemas are one level deep — a shallow strip is enough). */
export function memoryToolsAsGemini(): FunctionToolShape[] {
  return memoryToolDefs().map((d) => {
    const { additionalProperties: _drop, ...parameters } = d.jsonSchema as Record<string, unknown>;
    return { name: namespacedMemoryToolName(d.name), description: d.description, parameters };
  });
}

export interface MemoryToolExecDeps {
  ctx: MemoryToolContext;
  canUseTool: ToolApprovalFn;
  emit: (e: ProviderEvent) => void;
}

/**
 * Execute one model-issued memory tool call end to end: emit tool_start, gate
 * through `canUseTool` (read-only memory tools auto-approve via isSafeTool), run
 * the def in-process, emit tool_complete. Never throws — an unknown tool or a
 * denial returns an error string the caller feeds back to the model as the
 * tool result, so the loop stays alive.
 */
export async function executeMemoryToolCall(
  toolName: string,
  args: Record<string, unknown>,
  deps: MemoryToolExecDeps,
): Promise<string> {
  const bare = toolName.startsWith(PREFIX) ? toolName.slice(PREFIX.length) : toolName;
  const def = memoryToolDefs().find((d) => d.name === bare);
  const toolId = randomUUID();
  const approvalId = `mem-${toolId}`;
  deps.emit({ type: "tool_start", toolId, sdkToolUseId: toolId, name: toolName, input: args, approvalId });

  if (!def) {
    const msg = `Unknown tool: ${toolName}`;
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }

  let verdict: Awaited<ReturnType<ToolApprovalFn>>;
  try {
    verdict = await deps.canUseTool(toolId, approvalId, toolName, args);
  } catch {
    verdict = { behavior: "deny" };
  }
  if (verdict.behavior !== "allow") {
    const msg = verdict.message ?? "Tool call denied by policy.";
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }

  try {
    const text = await def.run((verdict.updatedInput ?? args) as Record<string, unknown>, deps.ctx);
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: text, success: true });
    return text;
  } catch (e) {
    const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }
}

// ── external MCP servers (registry, via McpHub) ──────────────────────────────
//
// The in-daemon backends have no MCP client, so external servers reach them the
// same way the memory tools do: declarations here, execution through the shared
// canUseTool gate. Names are the canonical `mcp__<server>__<tool>` so isSafeTool
// / the session gate treat readonly servers the same on every backend.

/** Ensure a tool's parameters are a JSON-schema object OpenAI/Gemini accept. */
function paramsSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === "object" && typeof schema.type === "string") return schema;
  const properties = (schema?.properties as Record<string, unknown> | undefined) ?? {};
  return { type: "object", properties };
}

/** OpenAI function tools for the external MCP servers this backend should see. */
export function mcpToolsAsOpenAI(handles: McpToolHandle[]): Array<{ type: "function"; function: FunctionToolShape }> {
  return handles.map((h) => ({
    type: "function" as const,
    function: { name: h.canonicalName, description: h.description, parameters: paramsSchema(h.inputSchema) },
  }));
}

/** Gemini functionDeclarations for the external MCP servers (no additionalProperties). */
export function mcpToolsAsGemini(handles: McpToolHandle[]): FunctionToolShape[] {
  return handles.map((h) => {
    const { additionalProperties: _drop, ...rest } = paramsSchema(h.inputSchema);
    return { name: h.canonicalName, description: h.description, parameters: rest };
  });
}

export interface McpToolExecDeps {
  tools: SessionMcpTools;
  canUseTool: ToolApprovalFn;
  emit: (e: ProviderEvent) => void;
}

/**
 * Execute one model-issued external-MCP tool call: emit tool_start, gate through
 * canUseTool (readonly servers auto-approve via the session gate's registry
 * check; others prompt), run it through the daemon-owned McpHub, emit
 * tool_complete. Never throws — a denial or error returns a string for the model.
 */
export async function executeMcpToolCall(
  toolName: string,
  args: Record<string, unknown>,
  deps: McpToolExecDeps,
): Promise<string> {
  const toolId = randomUUID();
  const approvalId = `mcp-${toolId}`;
  deps.emit({ type: "tool_start", toolId, sdkToolUseId: toolId, name: toolName, input: args, approvalId });

  let verdict: Awaited<ReturnType<ToolApprovalFn>>;
  try {
    verdict = await deps.canUseTool(toolId, approvalId, toolName, args);
  } catch {
    verdict = { behavior: "deny" };
  }
  if (verdict.behavior !== "allow") {
    const msg = verdict.message ?? "Tool call denied by policy.";
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }

  // The hub is fail-soft, but keep the "never throws" guarantee LOCAL: a future
  // throwing path in tools.call still returns a string result, never a crash.
  try {
    const res = await deps.tools.call(toolName, (verdict.updatedInput ?? args) as Record<string, unknown>);
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: res.text, success: !res.isError });
    return res.text;
  } catch (e) {
    const msg = `Error calling ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
    deps.emit({ type: "tool_complete", sdkToolUseId: toolId, output: msg, success: false });
    return msg;
  }
}
