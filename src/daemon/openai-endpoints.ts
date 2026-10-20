/**
 * OpenAI-compatible endpoints — any number of user-defined servers that speak
 * the OpenAI Chat Completions API, each registered as backend `oai:<name>`
 * (protocol: endpoints.ts).
 *
 * Stored in `<configDir>/endpoints.json`, 0600, written atomically. API keys
 * and header values never leave this module except into a request to the
 * endpoint itself; clients get `toEndpointInfo`.
 *
 * Every session on an endpoint resolves its connection from this store at the
 * start of each turn (`resolveConnection`), so a changed key or base URL
 * reaches running sessions on their next turn, and a removed endpoint makes
 * them refuse to run — never a silent fallback to another backend.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { atomicWrite, getConfigDir } from "../config.js";
import {
  type EndpointFlavor,
  type EndpointInfo,
  type EndpointModel,
  endpointProviderId,
} from "../protocol/types.js";

export interface StoredEndpoint {
  name: string;
  displayName?: string;
  baseUrl: string;
  flavor: EndpointFlavor;
  apiKey?: string;
  headers?: Record<string, string>;
  models: EndpointModel[];
  defaultModel?: string;
  contextWindow?: number;
  mcpServers: "all" | string[];
  streamUsage: boolean;
  strictToolSchemas: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  createdAt: string;
  updatedAt: string;
}

/** What `endpoints.set` carries (protocol), minus transport fields. */
export interface EndpointInput {
  name: string;
  displayName?: string;
  baseUrl: string;
  flavor?: EndpointFlavor;
  /** absent = keep the stored key, null = remove it, string = replace it. */
  apiKey?: string | null;
  /** absent = keep the stored headers, present = replace them all. */
  headers?: Record<string, string>;
  models?: EndpointModel[];
  defaultModel?: string | null;
  contextWindow?: number | null;
  mcpServers?: "all" | string[];
  streamUsage?: boolean;
  strictToolSchemas?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

/** Everything a request to the endpoint needs, resolved per turn. */
export interface EndpointConnection {
  name: string;
  baseURL: string;
  apiKey?: string;
  headers: Record<string, string>;
  /** Changes when anything a request depends on changes — the client is rebuilt then. */
  fingerprint: string;
}

interface StoreFile {
  version: 1;
  endpoints: StoredEndpoint[];
}

export class EndpointError extends Error {
  override name = "EndpointError";
}

// ── Validation ────────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** RFC 7230 token characters — a header name can't carry a separator or a newline. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** Headers the HTTP client owns; setting them would break or smuggle the request. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "accept-encoding"]);
const MIN_CONTEXT = 256;
const MAX_CONTEXT = 100_000_000;
const MAX_MODELS = 500;

export function validateEndpointName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new EndpointError(
      `invalid endpoint name ${JSON.stringify(name)} — use 1–40 lowercase letters, digits and dashes, starting with a letter or digit`,
    );
  }
}

/**
 * Is `host` on the local machine or a private network? Only those may be
 * reached over plain http: the key rides every request, and on a public host
 * http would hand it to anyone on the path.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const ipVersion = isIP(h);
  if (ipVersion === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (ipVersion === 6) {
    return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
  }
  // A single-label name (a container or LAN host: `ollama`, `gpu-box`) or a
  // local-only suffix.
  return !h.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(h);
}

function validateBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new EndpointError(`invalid base URL ${JSON.stringify(baseUrl)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EndpointError("the base URL must be http(s)");
  }
  // Shown to anyone who can list endpoints: no credentials in it.
  if (url.username || url.password || url.search || url.hash) {
    throw new EndpointError("the base URL must not carry credentials, a query string or a fragment — put a key in the API key or a header");
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new EndpointError(`the base URL must be https for a public host (http is allowed for localhost and private networks): ${url.hostname}`);
  }
  // Normalised without a trailing slash: the client appends `/chat/completions`.
  return url.toString().replace(/\/+$/, "");
}

function validateContext(value: number | undefined, what: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < MIN_CONTEXT || value > MAX_CONTEXT) {
    throw new EndpointError(`${what} must be a whole number of tokens between ${MIN_CONTEXT} and ${MAX_CONTEXT}`);
  }
}

function validateModels(models: EndpointModel[]): void {
  if (models.length > MAX_MODELS) throw new EndpointError(`at most ${MAX_MODELS} models per endpoint`);
  const seen = new Set<string>();
  for (const m of models) {
    if (!m.id || m.id.length > 256 || CONTROL_CHARS.test(m.id)) {
      throw new EndpointError(`invalid model id ${JSON.stringify(m.id)}`);
    }
    if (seen.has(m.id)) throw new EndpointError(`model ${JSON.stringify(m.id)} is listed twice`);
    seen.add(m.id);
    if (m.name !== undefined && (m.name.length > 256 || CONTROL_CHARS.test(m.name))) {
      throw new EndpointError(`invalid name for model ${m.id}`);
    }
    validateContext(m.contextWindow, `the context window of ${m.id}`);
    if (m.maxTokens !== undefined && (!Number.isInteger(m.maxTokens) || m.maxTokens < 1 || m.maxTokens > MAX_CONTEXT)) {
      throw new EndpointError(`the max tokens of ${m.id} must be a positive whole number`);
    }
  }
}

function validateHeaders(headers: Record<string, string>, hasApiKey: boolean): void {
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(k)) throw new EndpointError(`invalid header name ${JSON.stringify(k)}`);
    const lower = k.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) throw new EndpointError(`header ${k} is set by codeoid and can't be overridden`);
    if (lower === "authorization" && hasApiKey) {
      throw new EndpointError("set either an API key or an Authorization header, not both");
    }
    // A CR/LF would inject further headers into every request.
    if (CONTROL_CHARS.test(v)) throw new EndpointError(`header ${k} has a line break or control character in its value`);
  }
}

/** Validate a complete stored entry (on save, and on load — a hand edit must not be applied unchecked). */
export function validateStoredEndpoint(e: StoredEndpoint): StoredEndpoint {
  validateEndpointName(e.name);
  if (e.displayName !== undefined && (e.displayName.length > 128 || CONTROL_CHARS.test(e.displayName))) {
    throw new EndpointError("invalid display name");
  }
  const baseUrl = validateBaseUrl(e.baseUrl);
  if (e.flavor !== "openai" && e.flavor !== "llamacpp") throw new EndpointError(`unknown flavor ${JSON.stringify(e.flavor)}`);
  if (e.apiKey !== undefined && (e.apiKey === "" || CONTROL_CHARS.test(e.apiKey))) {
    throw new EndpointError("the API key must be a single non-empty line with no control characters");
  }
  validateHeaders(e.headers ?? {}, e.apiKey !== undefined);
  if (!Array.isArray(e.models)) throw new EndpointError("models must be a list");
  validateModels(e.models);
  if (e.defaultModel !== undefined && (!e.defaultModel || e.defaultModel.length > 256 || CONTROL_CHARS.test(e.defaultModel))) {
    throw new EndpointError("invalid default model");
  }
  validateContext(e.contextWindow, "the context window");
  if (e.mcpServers !== "all") {
    if (!Array.isArray(e.mcpServers) || e.mcpServers.some((s) => typeof s !== "string" || !s || CONTROL_CHARS.test(s))) {
      throw new EndpointError('mcpServers must be "all" or a list of server names');
    }
  }
  if (e.maxTokensField !== "max_tokens" && e.maxTokensField !== "max_completion_tokens") {
    throw new EndpointError("maxTokensField must be max_tokens or max_completion_tokens");
  }
  return { ...e, baseUrl };
}

export function toEndpointInfo(e: StoredEndpoint): EndpointInfo {
  return {
    name: e.name,
    providerId: endpointProviderId(e.name),
    displayName: e.displayName || e.name,
    baseUrl: e.baseUrl,
    flavor: e.flavor,
    hasApiKey: e.apiKey !== undefined,
    headerNames: Object.keys(e.headers ?? {}),
    models: e.models.map((m) => ({ ...m })),
    ...(e.defaultModel ? { defaultModel: e.defaultModel } : {}),
    ...(e.contextWindow ? { contextWindow: e.contextWindow } : {}),
    mcpServers: e.mcpServers === "all" ? "all" : [...e.mcpServers],
    streamUsage: e.streamUsage,
    strictToolSchemas: e.strictToolSchemas,
    maxTokensField: e.maxTokensField,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** The connection a request needs — fingerprinted so a client is rebuilt only when it changes. */
export function connectionOf(e: Pick<StoredEndpoint, "name" | "baseUrl" | "apiKey" | "headers">): EndpointConnection {
  const headers = { ...(e.headers ?? {}) };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([e.baseUrl, e.apiKey ?? null, Object.entries(headers).sort()]))
    .digest("hex")
    .slice(0, 16);
  return { name: e.name, baseURL: e.baseUrl, ...(e.apiKey !== undefined ? { apiKey: e.apiKey } : {}), headers, fingerprint };
}

/**
 * The connection to TEST: an unsaved draft's values, with a stored endpoint's
 * key and headers filling what the draft leaves out (so an edit form can test
 * without re-entering secrets). Validated by the same rules as a save.
 */
export function draftConnection(
  draft: { baseUrl?: string; apiKey?: string | null; headers?: Record<string, string> },
  existing: StoredEndpoint | undefined,
  name = existing?.name ?? "draft",
): EndpointConnection {
  const baseUrlRaw = draft.baseUrl ?? existing?.baseUrl;
  if (!baseUrlRaw) throw new EndpointError("a base URL is required");
  const baseUrl = validateBaseUrl(baseUrlRaw);
  const apiKey = draft.apiKey === undefined ? existing?.apiKey : draft.apiKey || undefined;
  if (apiKey !== undefined && CONTROL_CHARS.test(apiKey)) throw new EndpointError("the API key must be a single line with no control characters");
  const headers = draft.headers ?? existing?.headers ?? {};
  validateHeaders(headers, apiKey !== undefined);
  return connectionOf({ name, baseUrl, ...(apiKey !== undefined ? { apiKey } : {}), headers });
}

/** The window for `model` on this endpoint, from config only (llama.cpp's live `/props` is separate). */
export function configuredContextWindow(e: StoredEndpoint, model: string | undefined): number | undefined {
  const m = model ? e.models.find((x) => x.id === model) : undefined;
  return m?.contextWindow ?? e.contextWindow;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export type EndpointsListener = () => void;

export class EndpointStore {
  readonly #path: string;
  #data: StoreFile | null = null;
  readonly #listeners = new Set<EndpointsListener>();

  constructor(path: string = join(getConfigDir(), "endpoints.json")) {
    this.#path = path;
  }

  /** Called after every successful change (add, replace, remove). */
  onChange(listener: EndpointsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #load(): StoreFile {
    if (this.#data) return this.#data;
    if (!existsSync(this.#path)) {
      this.#data = { version: 1, endpoints: [] };
      return this.#data;
    }
    let parsed: Partial<StoreFile>;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<StoreFile>;
    } catch {
      // Not the parser's message: it can quote a slice of the file — a key.
      throw new EndpointError(`${this.#path} is not valid JSON — fix or remove it`);
    }
    const endpoints: StoredEndpoint[] = [];
    for (const raw of Array.isArray(parsed.endpoints) ? parsed.endpoints : []) {
      try {
        endpoints.push(validateStoredEndpoint(withDefaults(raw as StoredEndpoint)));
      } catch (err) {
        console.error(`[codeoid] ignoring invalid endpoint in ${this.#path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.#data = { version: 1, endpoints };
    return this.#data;
  }

  #save(data: StoreFile): void {
    atomicWrite(this.#path, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    this.#data = data;
    for (const l of this.#listeners) {
      try {
        l();
      } catch (err) {
        console.error(`[codeoid] endpoint change listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  list(): EndpointInfo[] {
    return this.#load().endpoints.map(toEndpointInfo).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Stored entries, secrets included — daemon-internal. */
  entries(): StoredEndpoint[] {
    return [...this.#load().endpoints];
  }

  get(name: string): StoredEndpoint | undefined {
    return this.#load().endpoints.find((e) => e.name === name);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** Add or replace. Secrets left out of `input` are kept (see EndpointInput). */
  upsert(input: EndpointInput): EndpointInfo {
    validateEndpointName(input.name);
    const data = this.#load();
    const existing = data.endpoints.find((e) => e.name === input.name);
    const now = new Date().toISOString();
    const flavor = input.flavor ?? existing?.flavor ?? "openai";
    const apiKey = input.apiKey === undefined ? existing?.apiKey : input.apiKey === null || input.apiKey === "" ? undefined : input.apiKey;
    const headers = input.headers === undefined ? existing?.headers : input.headers;
    const next = validateStoredEndpoint({
      name: input.name,
      displayName: input.displayName === undefined ? existing?.displayName : input.displayName.trim() || undefined,
      baseUrl: input.baseUrl,
      flavor,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      models: input.models ?? existing?.models ?? [],
      defaultModel: input.defaultModel === undefined ? existing?.defaultModel : input.defaultModel ?? undefined,
      contextWindow: input.contextWindow === undefined ? existing?.contextWindow : input.contextWindow ?? undefined,
      // Tool definitions ride in every prompt: a local server's small context
      // is better off without external servers unless asked for.
      mcpServers: input.mcpServers ?? existing?.mcpServers ?? (flavor === "llamacpp" ? [] : "all"),
      streamUsage: input.streamUsage ?? existing?.streamUsage ?? true,
      strictToolSchemas: input.strictToolSchemas ?? existing?.strictToolSchemas ?? flavor === "llamacpp",
      maxTokensField: input.maxTokensField ?? existing?.maxTokensField ?? "max_tokens",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.#save({ version: 1, endpoints: [...data.endpoints.filter((e) => e.name !== input.name), next] });
    return toEndpointInfo(next);
  }

  remove(name: string): boolean {
    const data = this.#load();
    if (!data.endpoints.some((e) => e.name === name)) return false;
    this.#save({ version: 1, endpoints: data.endpoints.filter((e) => e.name !== name) });
    return true;
  }

  /** The connection for a session's next turn. Throws EndpointError when the endpoint is gone. */
  resolveConnection(name: string): EndpointConnection {
    const e = this.get(name);
    if (!e) {
      throw new EndpointError(
        `the endpoint "${name}" no longer exists — switch this session to another backend, or add the endpoint back (codeoid endpoint add ${name} …)`,
      );
    }
    return connectionOf(e);
  }
}

/** Fill fields a hand-written or older entry may lack, before validation. */
function withDefaults(raw: StoredEndpoint): StoredEndpoint {
  const flavor = raw.flavor ?? "openai";
  return {
    ...raw,
    flavor,
    models: raw.models ?? [],
    mcpServers: raw.mcpServers ?? (flavor === "llamacpp" ? [] : "all"),
    streamUsage: raw.streamUsage ?? true,
    strictToolSchemas: raw.strictToolSchemas ?? flavor === "llamacpp",
    maxTokensField: raw.maxTokensField ?? "max_tokens",
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
  };
}
