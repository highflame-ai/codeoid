/**
 * OpenAI-compatible endpoints: any number of servers that speak the OpenAI
 * Chat Completions API — a local llama.cpp / vLLM / Ollama / LM Studio, an
 * aggregator like OpenRouter, a company gateway — each a backend of its own.
 *
 * WHY. Most local and hosted model servers speak the same API, but codeoid
 * had exactly two slots for them: `openai` (one key, one base URL from the
 * environment) and `llamacpp` (one local server from config). Someone with a
 * vLLM box, an Ollama laptop and an OpenRouter key could use one at a time,
 * and only by editing the daemon's environment and restarting it.
 *
 * SHAPE. Modelled on pi's `models.json` (a provider = base URL + key +
 * headers + models with their context windows), stored by the daemon. Each
 * endpoint registers as provider `oai:<name>`, so it appears in every
 * provider picker, can be chosen when creating a session or switched to
 * mid-session, and keeps working across a daemon restart. Endpoints are added,
 * changed and removed at runtime — no restart.
 *
 * SECRETS. The API key and header values are stored by the daemon (0600) and
 * never sent to a client: a client sees whether a key is set and the header
 * names only.
 */

// ── Shared types ─────────────────────────────────────────────────────────────

/** Provider ids of endpoints are `oai:<name>`. */
export const ENDPOINT_PROVIDER_PREFIX = "oai:";

/** The provider id an endpoint registers as. */
export function endpointProviderId(name: string): string {
  return `${ENDPOINT_PROVIDER_PREFIX}${name}`;
}

/** The endpoint name a provider id names, or null for a built-in backend. */
export function endpointNameOf(providerId: string): string | null {
  return providerId.startsWith(ENDPOINT_PROVIDER_PREFIX) ? providerId.slice(ENDPOINT_PROVIDER_PREFIX.length) : null;
}

/**
 * - `openai`: any OpenAI-compatible server.
 * - `llamacpp`: llama.cpp's `llama-server` — the context window is read from
 *   its `/props` after every turn, and tool schemas are made strict (it
 *   compiles them into a grammar and rejects an unconstrained subschema).
 */
export type EndpointFlavor = "openai" | "llamacpp";

/**
 * A starting point for a new endpoint: the server's base URL and request
 * shape, and whether it takes a key. Shared by the web UI's "Add" and the
 * CLI's `--template`; the endpoint itself stores only what was saved.
 */
export interface EndpointTemplate {
  id: string;
  /** Label in pickers ("OpenRouter"). */
  name: string;
  /** Empty for `custom`: the user gives one. */
  baseUrl: string;
  flavor: EndpointFlavor;
  /** Whether the server needs an API key. */
  key: "required" | "optional" | "none";
  /** Where to get a key. */
  keyUrl?: string;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** A suggested endpoint name. */
  suggestedName: string;
  /** One line shown beside the template. */
  note?: string;
}

/** The templates "Add endpoint" offers, hosted first, then local servers, then custom. */
export const ENDPOINT_TEMPLATES: readonly EndpointTemplate[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    flavor: "openai",
    key: "required",
    keyUrl: "https://platform.openai.com/api-keys",
    maxTokensField: "max_completion_tokens",
    suggestedName: "openai-api",
    note: "Another OpenAI key or project beside the built-in OpenAI backend.",
  },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", flavor: "openai", key: "required", keyUrl: "https://openrouter.ai/keys", suggestedName: "openrouter" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", flavor: "openai", key: "required", keyUrl: "https://console.groq.com/keys", suggestedName: "groq" },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", flavor: "openai", key: "required", keyUrl: "https://api.together.ai/settings/api-keys", suggestedName: "together" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", flavor: "openai", key: "required", keyUrl: "https://platform.deepseek.com/api_keys", suggestedName: "deepseek" },
  { id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", flavor: "openai", key: "required", keyUrl: "https://fireworks.ai/account/api-keys", suggestedName: "fireworks" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", flavor: "openai", key: "required", keyUrl: "https://console.mistral.ai/api-keys", suggestedName: "mistral" },
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", flavor: "openai", key: "none", suggestedName: "ollama", note: "Run `ollama serve`; models are the ones you pulled." },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", flavor: "openai", key: "none", suggestedName: "lmstudio", note: "Start the server in LM Studio's Developer tab." },
  {
    id: "llamacpp",
    name: "llama.cpp server",
    baseUrl: "http://127.0.0.1:8080/v1",
    flavor: "llamacpp",
    key: "optional",
    suggestedName: "llama",
    note: "A llama-server: context window read from it, strict tool schemas. See docs/local-models.md.",
  },
  { id: "vllm", name: "vLLM", baseUrl: "http://localhost:8000/v1", flavor: "openai", key: "optional", suggestedName: "vllm", note: "`vllm serve <model>`; a key only if started with --api-key." },
  { id: "custom", name: "Custom", baseUrl: "", flavor: "openai", key: "optional", suggestedName: "", note: "Any server that speaks the OpenAI Chat Completions API." },
];

/** The template named `id`, if any. */
export function endpointTemplate(id: string): EndpointTemplate | undefined {
  return ENDPOINT_TEMPLATES.find((t) => t.id === id);
}

/**
 * A built-in backend of the same kind, shown in the same list as the
 * endpoints: OpenAI's own API (`openai`) and the configured llama.cpp server
 * (`llamacpp`). Configured in Settings (their own fields) or the environment,
 * not stored as endpoints; their ids are unchanged.
 */
export interface BuiltinServerInfo {
  id: "openai" | "llamacpp";
  displayName: string;
  /** Registered as a backend now (a key or an account; enabled). */
  available: boolean;
  baseUrl: string;
  /** How it is set up, or what it needs. */
  detail: string;
}

/** One model an endpoint serves, as configured. */
export interface EndpointModel {
  /** The id sent as `model` on every request. */
  id: string;
  /** Label for pickers. Defaults to the id. */
  name?: string;
  /** Context window in tokens — the session's context budget is sized to it. */
  contextWindow?: number;
  /** Cap on output tokens per response (sent as the endpoint's max-tokens field). */
  maxTokens?: number;
}

/** What a client may see of an endpoint — never its key or header values. */
export interface EndpointInfo {
  name: string;
  /** The provider id sessions use: `oai:<name>`. */
  providerId: string;
  /** Label for pickers. Defaults to the name. */
  displayName: string;
  baseUrl: string;
  flavor: EndpointFlavor;
  /** Whether an API key is stored (sent as `Authorization: Bearer …`). */
  hasApiKey: boolean;
  /** Names of the extra headers sent; values are secret. */
  headerNames: string[];
  /**
   * Models to offer first, with their settings (label, context window, output
   * cap). Pickers then offer every other chat model the server's `/models`
   * lists; a configured one the server doesn't list is still offered, marked.
   */
  models: EndpointModel[];
  /**
   * Model a new session uses. Defaults to the first configured model, then the
   * server's first chat model.
   */
  defaultModel?: string;
  /** Context window for a model without its own. */
  contextWindow?: number;
  /**
   * External MCP servers offered to sessions on this endpoint: every server
   * (`all`) or a named list (empty = none). Tool definitions ride in every
   * prompt, so a small local context is better served by few or none.
   */
  mcpServers: "all" | string[];
  /** Send `stream_options.include_usage` (some servers reject it). */
  streamUsage: boolean;
  /** Make tool schemas strict (needed by servers that compile them to a grammar). */
  strictToolSchemas: boolean;
  /** Field name for the output-token cap. */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  createdAt: string;
  updatedAt: string;
}

/** A backend clients can offer in a picker. */
export interface ProviderInfo {
  /** The id `session.create` / `session.set_provider` take. */
  id: string;
  displayName: string;
  /** `endpoint` = a user-defined OpenAI-compatible endpoint. */
  kind: "builtin" | "endpoint";
  /** The backend a session without a provider choice lands on. */
  isDefault: boolean;
}

// ── Messages (client → daemon) ────────────────────────────────────────────────

/**
 * The backends this daemon offers, default first. Also subscribes the
 * connection to `providers.changed`, pushed whenever an endpoint is added,
 * changed or removed. Scope: none beyond a valid connection — the same list
 * `auth.ok` carries.
 */
export interface ProvidersListMsg {
  type: "providers.list";
  id: string;
}

/** List endpoints. Scope: `settings:read`. */
export interface EndpointsListMsg {
  type: "endpoints.list";
  id: string;
}

/**
 * Add or replace an endpoint. Scope: `settings:write`, undelegated.
 *
 * Secrets are write-only: `apiKey` absent keeps the stored key, `null` removes
 * it, a string replaces it. `headers` absent keeps the stored headers; present
 * replaces them all (values included — they are never sent back, so an edit
 * re-enters them).
 * Stored secrets are kept only while `baseUrl` stays on the same origin
 * (scheme, host, port): moving an endpoint to another server is refused
 * unless the request gives `apiKey` (when one is stored) and `headers` (when
 * any are stored) explicitly — a stored credential is never sent to a server
 * it wasn't entered for.
 * Other omitted fields keep their stored values. An empty displayName removes
 * the label; null defaultModel or contextWindow removes that override.
 */
export interface EndpointsSetMsg {
  type: "endpoints.set";
  id: string;
  name: string;
  displayName?: string;
  baseUrl: string;
  flavor?: EndpointFlavor;
  apiKey?: string | null;
  headers?: Record<string, string>;
  models?: EndpointModel[];
  defaultModel?: string | null;
  contextWindow?: number | null;
  mcpServers?: "all" | string[];
  streamUsage?: boolean;
  strictToolSchemas?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

/**
 * Remove an endpoint. Scope: `settings:write`. Sessions on it refuse to run
 * until switched to another backend (or the endpoint is added back).
 */
export interface EndpointsRemoveMsg {
  type: "endpoints.remove";
  id: string;
  name: string;
}

/**
 * Check that an endpoint answers: list its models. Either a stored endpoint
 * (`name`) or an unsaved draft (`baseUrl` + optional `apiKey` / `headers`) —
 * with `name` AND draft fields, the draft's values win and the stored key or
 * headers fill what the draft leaves out, so an edit form can test before
 * saving without re-entering secrets — on the same origin only, as for
 * `endpoints.set`. Scope: `settings:write`, undelegated (the daemon makes a
 * request with a stored credential).
 */
export interface EndpointsTestMsg {
  type: "endpoints.test";
  id: string;
  name?: string;
  baseUrl?: string;
  flavor?: EndpointFlavor;
  apiKey?: string | null;
  headers?: Record<string, string>;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface ProvidersResultMsg {
  type: "providers.result";
  requestId: string;
  providers: ProviderInfo[];
}

/** Pushed to every connection that sent `providers.list`, whenever the list changes. */
export interface ProvidersChangedMsg {
  type: "providers.changed";
  providers: ProviderInfo[];
}

export interface EndpointsResultMsg {
  type: "endpoints.result";
  requestId: string;
  endpoints: EndpointInfo[];
  /** The built-in backends of the same kind, listed with them (absent from older daemons). */
  builtins?: BuiltinServerInfo[];
}

export interface EndpointsTestResultMsg {
  type: "endpoints.test.result";
  requestId: string;
  ok: boolean;
  /** Model ids the server listed (up to 200). */
  models?: string[];
  /** Listed ids the server marks as not for chat (embeddings, rerankers), configured ones aside. Pickers don't offer them. */
  notChat?: string[];
  /** A stored endpoint's configured model ids the server doesn't list: an alias it serves unlisted, or a name that went stale. */
  notServed?: string[];
  /** llama.cpp flavor: the context window the server runs with. */
  contextWindow?: number;
  latencyMs?: number;
  /** User-safe reason, on failure. */
  error?: string;
}
