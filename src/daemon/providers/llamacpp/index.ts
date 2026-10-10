/**
 * llama.cpp — a local `llama-server` driven over its OpenAI-compatible API.
 *
 * The wire format is OpenAI's, so the turn loop is `OpenAIProvider`'s under a
 * distinct id. What differs is what a local server can and can't tell us:
 *
 * - Its model list is whatever GGUF it loaded, named by file path — every
 *   entry is listed, and an unreachable server lists nothing rather than
 *   pretending to offer GPT models.
 * - Its context is small, so external MCP servers are opt-in per server
 *   ({@link allowedMcpServers}); codeoid's own memory tools are always offered.
 * - Its tool schemas are compiled into a grammar, which is stricter than
 *   OpenAI's API about schema shape — see {@link strictJsonSchema}.
 * - Its context window is set by `--ctx-size` at launch and is usually far
 *   smaller than any cloud model's. The server reports it on `/props`, so
 *   each turn carries the real number: the history seeded on a fork or
 *   provider switch, the occupancy shown, and auto-rotate all size from it
 *   instead of a cloud-sized table entry that would overflow the server.
 */

import { OpenAIProvider, type OpenAIProviderInit } from "../openai/index.js";
import type { OpenAIFunctionTool } from "../tool-loop.js";
import type { McpServerSource } from "../../mcp/tool-source.js";

export const LLAMACPP_PROVIDER_ID = "llamacpp";
export const LLAMACPP_DISPLAY_NAME = "llama.cpp (local)";

/** How long to wait on `/props` before reporting no window for the turn. */
const PROPS_TIMEOUT_MS = 2_000;

/**
 * `/props` sits beside the OpenAI routes, not under them: strip a trailing
 * `/v1` from the configured base URL.
 */
export function propsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/props`;
}

/**
 * The context window ONE request gets. `default_generation_settings.n_ctx` is
 * per slot: a server started with `--parallel 4 --ctx-size 32768` gives each
 * request 8192, and that — not the 32768 — is what a prompt must fit in.
 */
export async function fetchServerContextWindow(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | undefined> {
  const res = await fetchImpl(propsUrl(baseUrl), { signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) });
  if (!res.ok) return undefined;
  const props = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown } };
  const n = props.default_generation_settings?.n_ctx;
  return typeof n === "number" && n > 0 ? n : undefined;
}

/** Keywords that say what a value IS. A schema with none of them accepts anything. */
const CONSTRAINING_KEYWORDS = [
  "type", "$ref", "enum", "const", "anyOf", "oneOf", "allOf", "not",
  "properties", "items", "prefixItems", "additionalProperties", "patternProperties",
];
const ANY_JSON_TYPE = ["string", "number", "integer", "boolean", "object", "array", "null"];

/**
 * Make a JSON schema acceptable to llama.cpp without changing what it accepts.
 *
 * llama.cpp compiles tool schemas into a sampling grammar and rejects, with a
 * 500 for the WHOLE request, any subschema that only annotates — `{
 * "description": "Any JSON value" }` — though JSON Schema reads that as
 * "anything". MCP servers emit exactly this for untyped parameters, and one
 * such tool on any mounted server would fail every turn. Spelling "anything"
 * out as every JSON type is the same constraint in a form it accepts; the
 * description stays, because it is what tells the model what to pass.
 */
export function strictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    switch (key) {
      case "properties":
      case "patternProperties":
      case "$defs":
      case "definitions":
        out[key] =
          value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strictJsonSchema(v)]))
            : value;
        break;
      case "items":
      case "prefixItems":
      case "additionalProperties":
      case "not":
      case "anyOf":
      case "oneOf":
      case "allOf":
        out[key] = strictJsonSchema(value);
        break;
      default:
        out[key] = value;
    }
  }
  const keys = Object.keys(out);
  if (keys.length > 0 && !keys.some((k) => CONSTRAINING_KEYWORDS.includes(k))) {
    out.type = ANY_JSON_TYPE;
  }
  return out;
}

/**
 * The tool list in the form llama.cpp accepts: strict parameter schemas, and a
 * description on every tool — chat templates such as Qwen's read
 * `function.description` unconditionally and fail the request without one.
 */
export function llamaCppTools(tools: OpenAIFunctionTool[]): OpenAIFunctionTool[] {
  return tools.map((t) => ({
    ...t,
    function: {
      ...t.function,
      description: t.function.description || t.function.name,
      parameters: strictJsonSchema(t.function.parameters) as Record<string, unknown>,
    },
  }));
}

export interface LlamaCppConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  /** External MCP servers this backend is offered; none when empty. */
  mcpServers?: readonly string[];
}

/**
 * The registry narrowed to the servers a local backend opted into. A cloud
 * model can afford every mounted server's tool definitions in every prompt; a
 * local one usually can't — a handful of servers is tens of thousands of
 * tokens, past a typical `--ctx-size` before the conversation starts.
 */
export function allowedMcpServers(
  registry: McpServerSource | undefined,
  allow: readonly string[] = [],
): McpServerSource | undefined {
  if (!registry || allow.length === 0) return undefined;
  return { forBackend: (id) => registry.forBackend(id).filter((s) => allow.includes(s.name)) };
}

export function createLlamaCppProvider(
  cfg: LlamaCppConfig,
  init: Omit<
    OpenAIProviderInit,
    "id" | "displayName" | "apiKey" | "baseURL" | "modelFilter" | "fallbackModels" | "contextWindow" | "toolsTransform"
  >,
): OpenAIProvider {
  return new OpenAIProvider({
    ...init,
    id: LLAMACPP_PROVIDER_ID,
    displayName: LLAMACPP_DISPLAY_NAME,
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    defaultModel: init.defaultModel ?? cfg.model ?? "local",
    mcpRegistry: allowedMcpServers(init.mcpRegistry, cfg.mcpServers),
    modelFilter: () => true,
    fallbackModels: [],
    contextWindow: () => fetchServerContextWindow(cfg.baseUrl),
    toolsTransform: llamaCppTools,
  });
}
