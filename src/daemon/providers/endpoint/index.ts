/**
 * Endpoint backends — one per user-defined OpenAI-compatible endpoint
 * (openai-endpoints.ts), registered as `oai:<name>`.
 *
 * The factory is a thin binding of `OpenAIProvider` to the store: everything
 * that can change while a session runs — URL, key, headers, request shape,
 * default model, context windows, tool-schema strictness, which MCP servers
 * are offered — is read from the store at the start of each turn, so an edit
 * reaches running sessions on their next turn and a removed endpoint makes
 * them refuse to run rather than fall back to another backend.
 */

import { readFileSync } from "node:fs";
import { atomicWrite } from "../../../config.js";
import { isOwnServer } from "../llamacpp/index.js";
import type { McpServerSource } from "../../mcp/tool-source.js";
import { AccountError, type ResolvedAccount } from "../../accounts.js";
import {
  configuredContextWindow,
  connectionOf,
  type EndpointConnection,
  EndpointError,
  type EndpointStore,
  type StoredEndpoint,
} from "../../openai-endpoints.js";
import { endpointNameOf, endpointProviderId } from "../../../protocol/types.js";
import type { ModelInfo } from "../interface.js";
import { llamaCppTools, propsUrl } from "../llamacpp/index.js";
import { isRedirectRefusal, OpenAIProvider, REDIRECT_HINT } from "../openai/index.js";
import type { ProviderFactory, ProviderRegistry, ProviderSessionInit } from "../registry.js";
import { StatelessSessionProvider } from "../stateless.js";

const MODELS_TIMEOUT_MS = 5_000;
const PROPS_TIMEOUT_MS = 2_000;
/** How long a server's `/models` answer is reused before asking again. */
const MODELS_TTL_MS = 60_000;
/** A gateway can serve hundreds (OpenRouter); past this the list is cut. */
const MAX_LISTED_MODELS = 1000;

/** One model a server's `/models` lists. */
export interface ListedModel {
  id: string;
  /**
   * False when the server marks it as something other than a chat model
   * (embeddings, rerankers, image or audio models). Only a mark the server
   * gives counts; a name is never guessed from ("Qwen3-Embedding-8B" on a
   * server that marks nothing stays a chat model, and a pick of it fails at
   * the server, which says why).
   */
  chat: boolean;
}

/**
 * The fields servers mark a model's kind with: LM Studio and Together `type`,
 * LiteLLM `mode`, others `task`. A value names a kind that isn't chat.
 */
const NOT_CHAT_KIND =
  /^(?:embeddings?|text[-_]embedding|rerank(?:er|ing)?|moderation|image(?:[-_]generation)?|audio(?:[-_](?:transcription|speech))?|transcription|tts|speech)$/i;

function isChatEntry(m: unknown): boolean {
  if (typeof m !== "object" || m === null) return true;
  for (const key of ["type", "mode", "task"] as const) {
    const v = (m as Record<string, unknown>)[key];
    if (typeof v === "string" && NOT_CHAT_KIND.test(v.trim())) return false;
  }
  return true;
}

function isModelId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id);
}

/** `Authorization` + custom headers for a direct request to the endpoint. */
function requestHeaders(conn: Pick<EndpointConnection, "apiKey" | "headers">): Record<string, string> {
  return {
    accept: "application/json",
    ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
    ...conn.headers,
  };
}

/**
 * GET `<baseUrl>/models`. Throws with a user-safe message (never the response
 * body, which a misconfigured proxy can fill with anything).
 */
export async function fetchEndpointModels(
  conn: Pick<EndpointConnection, "baseURL" | "apiKey" | "headers">,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  return (await fetchListedModels(conn, fetchImpl)).map((m) => m.id);
}

/** GET `<baseUrl>/models`, with each model's kind where the server marks it. Throws as {@link fetchEndpointModels}. */
export async function fetchListedModels(
  conn: Pick<EndpointConnection, "baseURL" | "apiKey" | "headers">,
  fetchImpl: typeof fetch = fetch,
): Promise<ListedModel[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${conn.baseURL}/models`, {
      headers: requestHeaders(conn),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? "timed out"
        : isRedirectRefusal(err)
          ? REDIRECT_HINT
          : "could not connect";
    throw new EndpointError(`${conn.baseURL}/models ${reason}`);
  }
  if (res.status === 401 || res.status === 403) throw new EndpointError(`the endpoint rejected the credentials (HTTP ${res.status})`);
  if (!res.ok) throw new EndpointError(`${conn.baseURL}/models answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new EndpointError(`${conn.baseURL}/models did not answer JSON — is the base URL right (usually ending in /v1)?`);
  }
  const data = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models;
  if (!Array.isArray(data)) throw new EndpointError(`${conn.baseURL}/models did not list models`);
  const listed: ListedModel[] = [];
  const seen = new Set<string>();
  for (const m of data) {
    const id = typeof m === "string" ? m : (m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name;
    // An over-long id is dropped, not cut: a cut id names a model the server doesn't serve.
    if (!isModelId(id) || seen.has(id)) continue;
    seen.add(id);
    listed.push({ id, chat: isChatEntry(m) });
    if (listed.length >= MAX_LISTED_MODELS) break;
  }
  return listed;
}

/** llama-server's per-request context window, from `/props` (with the endpoint's credentials). */
export async function fetchLlamaCppContext(
  conn: Pick<EndpointConnection, "baseURL" | "apiKey" | "headers">,
  fetchImpl: typeof fetch = fetch,
): Promise<number | undefined> {
  const res = await fetchImpl(propsUrl(conn.baseURL), {
    headers: requestHeaders(conn),
    signal: AbortSignal.timeout(PROPS_TIMEOUT_MS),
    redirect: "error",
  });
  if (!res.ok) return undefined;
  const props = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown } };
  const n = props.default_generation_settings?.n_ctx;
  return typeof n === "number" && n > 0 ? n : undefined;
}

/** A server's answer, and the connection it was read over. */
interface KnownList {
  at: number;
  fingerprint: string;
  models: ListedModel[];
}

/**
 * Model catalogs for endpoints. The server's `/models` is the source of truth:
 * model names change and retire, so codeoid doesn't keep a list of its own.
 * Configured models are settings applied by id (label, context window), and the
 * fallback when the server's list can't be read. Shared by the factories
 * (default model) and the session manager (`models.list`, `endpoints.test`).
 *
 * Each list a server gives is kept, in memory for a minute and on disk
 * (`cacheFile`, 0600) for good, so a daemon restart or a server that is down
 * for a moment still offers what it served last. A kept list is used only on
 * the connection it was read over (base URL, key and headers, fingerprinted):
 * an endpoint moved to another server never offers the old server's models.
 *
 * Fallback order: the server now; the list it gave last; the configured
 * models; nothing (a custom id can still be typed).
 */
export class EndpointCatalog {
  readonly #store: EndpointStore;
  readonly #fetch: typeof fetch;
  readonly #cacheFile: string | undefined;
  readonly #live = new Map<string, KnownList>();
  #known: Map<string, KnownList> | undefined;

  constructor(store: EndpointStore, fetchImpl: typeof fetch = fetch, opts?: { cacheFile?: string }) {
    this.#store = store;
    this.#fetch = fetchImpl;
    this.#cacheFile = opts?.cacheFile;
  }

  /**
   * The models to offer for `name`. `live` = the server answered (now or
   * within the minute); false = a kept list or the configured one stands in.
   */
  async models(name: string): Promise<{ models: ModelInfo[]; live: boolean }> {
    const e = this.#store.get(name);
    if (!e) return { models: [], live: false };
    const { listed, live } = await this.#listed(e);
    if (!listed) return { models: e.models.map((m) => modelInfo(e, m.id)), live: false };
    return { models: offered(e, listed).map((id) => modelInfo(e, id)), live };
  }

  /**
   * The model a turn without an explicit choice runs on: the endpoint's
   * default; else the first configured model the server lists; else the
   * server's first chat model. Without a list from the server, the first
   * configured model. Throws when none can be determined.
   */
  async defaultModel(name: string): Promise<string> {
    const e = this.#store.get(name);
    if (!e) throw new EndpointError(`the endpoint "${name}" no longer exists`);
    if (e.defaultModel) return e.defaultModel;
    const { listed, error } = await this.#listed(e);
    if (!listed) {
      if (e.models[0]) return e.models[0].id;
      throw new EndpointError(
        `no model chosen for endpoint "${name}", and its model list couldn't be read (${error ?? "no answer"}) — pick one with /model, or set a default model on the endpoint`,
      );
    }
    const first = offered(e, listed)[0];
    if (!first) throw new EndpointError(`endpoint "${name}" lists no chat models — pick one with /model, or set a default model on the endpoint`);
    return first;
  }

  /**
   * Keep a list read for a stored endpoint elsewhere (`endpoints.test`), when
   * it was read over the endpoint's own connection: a draft's never counts.
   * True when it was kept.
   */
  remember(name: string, fingerprint: string, models: ListedModel[]): boolean {
    const e = this.#store.get(name);
    if (!e || connectionOf(e).fingerprint !== fingerprint) return false;
    this.#keep(name, { at: Date.now(), fingerprint, models });
    return true;
  }

  /** Forget the minute's `/models` answers (after an edit). Kept lists stay, bound to their connection. */
  invalidate(name?: string): void {
    if (name) this.#live.delete(name);
    else this.#live.clear();
  }

  async #listed(e: StoredEndpoint): Promise<{ listed: ListedModel[] | undefined; live: boolean; error?: string }> {
    const conn = connectionOf(e);
    const hit = this.#live.get(e.name);
    if (hit && hit.fingerprint === conn.fingerprint && Date.now() - hit.at < MODELS_TTL_MS) return { listed: hit.models, live: true };
    try {
      const models = await fetchListedModels(conn, this.#fetch);
      this.#keep(e.name, { at: Date.now(), fingerprint: conn.fingerprint, models });
      return { listed: models, live: true };
    } catch (err) {
      const kept = this.#loadKnown().get(e.name);
      return {
        listed: kept && kept.fingerprint === conn.fingerprint ? kept.models : undefined,
        live: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  #keep(name: string, list: KnownList): void {
    this.#live.set(name, list);
    const known = this.#loadKnown();
    const before = known.get(name);
    known.set(name, list);
    // Written only when the list or its connection changed, not every minute.
    if (before && before.fingerprint === list.fingerprint && sameList(before.models, list.models)) return;
    this.#saveKnown(known);
  }

  #loadKnown(): Map<string, KnownList> {
    if (this.#known) return this.#known;
    this.#known = new Map();
    if (!this.#cacheFile) return this.#known;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#cacheFile, "utf8"));
    } catch {
      return this.#known; // missing or unreadable: nothing kept yet
    }
    const lists = (raw as { version?: unknown; endpoints?: unknown })?.endpoints;
    if ((raw as { version?: unknown })?.version !== 1 || typeof lists !== "object" || lists === null) return this.#known;
    for (const [name, v] of Object.entries(lists as Record<string, unknown>)) {
      const l = v as Partial<KnownList> | null;
      if (!l || typeof l.fingerprint !== "string" || typeof l.at !== "number" || !Array.isArray(l.models)) continue;
      const models = l.models
        .filter((m): m is ListedModel => isModelId((m as ListedModel)?.id) && typeof (m as ListedModel).chat === "boolean")
        .slice(0, MAX_LISTED_MODELS)
        .map((m) => ({ id: m.id, chat: m.chat }));
      this.#known.set(name, { at: l.at, fingerprint: l.fingerprint, models });
    }
    return this.#known;
  }

  #saveKnown(known: Map<string, KnownList>): void {
    if (!this.#cacheFile) return;
    // Removed endpoints' lists go with the next write.
    const names = new Set(this.#store.entries().map((e) => e.name));
    const endpoints: Record<string, KnownList> = {};
    for (const [name, list] of known) if (names.has(name)) endpoints[name] = list;
    try {
      atomicWrite(this.#cacheFile, `${JSON.stringify({ version: 1, endpoints })}\n`, 0o600);
    } catch (err) {
      // A cache: a failed write costs the fallback after a restart, nothing else.
      console.error(`[codeoid] could not keep endpoint model lists: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function sameList(a: readonly ListedModel[], b: readonly ListedModel[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i]!.id && m.chat === b[i]!.chat);
}

/**
 * What a picker offers from a server's list: configured models it lists
 * first, in their configured order (the owner's choices), then its other
 * chat models in its order. A configured model it doesn't list isn't offered.
 */
function offered(e: StoredEndpoint, listed: readonly ListedModel[]): string[] {
  const served = new Map(listed.map((m) => [m.id, m]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of e.models) {
    if (served.has(m.id) && !seen.has(m.id)) {
      out.push(m.id);
      seen.add(m.id);
    }
  }
  for (const m of listed) {
    if (m.chat && !seen.has(m.id)) {
      out.push(m.id);
      seen.add(m.id);
    }
  }
  return out;
}

/** Configured ids the server doesn't list: names that went stale. */
export function notServed(e: StoredEndpoint, listed: readonly ListedModel[]): string[] {
  const served = new Set(listed.map((m) => m.id));
  return e.models.map((m) => m.id).filter((id) => !served.has(id));
}

function modelInfo(e: StoredEndpoint, id: string): ModelInfo {
  const m = e.models.find((x) => x.id === id);
  const contextWindow = m?.contextWindow ?? e.contextWindow;
  return {
    id,
    // A local server names its model by the file it loaded; the path is noise in a picker.
    displayName: m?.name || id.split("/").pop() || id,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/** The MCP registry narrowed to what the endpoint offers — read live, so an edit applies next turn. */
function liveMcpSource(registry: McpServerSource | undefined, store: EndpointStore, name: string): McpServerSource | undefined {
  if (!registry) return undefined;
  return {
    forBackend: (id) => {
      const allow = store.get(name)?.mcpServers ?? [];
      const servers = registry.forBackend(id);
      return allow === "all" ? servers : servers.filter((s) => allow.includes(s.name));
    },
  };
}

/** The factory for endpoint `name`. Works whether or not the endpoint exists right now. */
/**
 * The connection with a session's account applied: the account's key and
 * headers replace the endpoint's own. Only on the server the account was
 * entered for — an endpoint moved to another origin since makes the account
 * refuse to run (re-enter it), the same rule as the endpoint's own secrets.
 */
export function withAccount(conn: EndpointConnection, account: ResolvedAccount | null): EndpointConnection {
  if (!account) return conn;
  const origin = new URL(conn.baseURL).origin;
  if (account.account.origin !== origin) {
    throw new AccountError(
      `the ${account.backend} account "${account.name}" was entered for ${account.account.origin ?? "another server"}, and this endpoint now points at ${origin} — re-enter the account for the new server`,
    );
  }
  return connectionOf({
    name: conn.name,
    baseUrl: conn.baseURL,
    ...(account.account.token !== undefined ? { apiKey: account.account.token } : {}),
    headers: account.account.headers ?? {},
  });
}

export function endpointFactory(
  name: string,
  store: EndpointStore,
  catalog: EndpointCatalog,
  displayName: string = store.get(name)?.displayName || name,
): ProviderFactory {
  const id = endpointProviderId(name);
  return {
    id,
    displayName,
    create: (init: ProviderSessionInit) => {
      // The address whose /props answered as llama-server: a loopback proxy to a paid API doesn't (#430).
      let llamaServerAt: string | null = null;
      return new StatelessSessionProvider(
        new OpenAIProvider({
          id,
          displayName,
          // A llama-server on this machine costs nothing (#430); a LAN one is
          // free by a $0 price in pricing.models — it may be a paid gateway.
          // Asked each turn: the endpoint's address can change under a live session.
          free: () => {
            const e = store.get(name);
            return e?.flavor === "llamacpp" && isOwnServer(e.baseUrl) && llamaServerAt === e.baseUrl;
          },
          // Before the first request, not only at a result: a first turn that fails or is stopped is priced too.
          proveFree: async () => {
            const e = store.get(name);
            if (e?.flavor !== "llamacpp" || !isOwnServer(e.baseUrl) || llamaServerAt === e.baseUrl) return;
            if (await fetchLlamaCppContext(connectionOf(e)).catch(() => undefined)) llamaServerAt = e.baseUrl;
          },
          connection: () => {
            const conn = withAccount(store.resolveConnection(name), init.resolveAccount?.() ?? null); // throws when removed
            const e = store.get(name)!;
            return { ...conn, streamUsage: e.streamUsage, maxTokensField: e.maxTokensField };
          },
          ...(init.model ? { defaultModel: init.model } : {}),
          resolveDefaultModel: () => catalog.defaultModel(name),
          maxTokens: (model) => store.get(name)?.models.find((m) => m.id === model)?.maxTokens,
          contextWindow: async (model) => {
            const e = store.get(name);
            if (!e) return undefined;
            // A llama.cpp server knows the window it was started with; that
            // beats anything configured, which can drift from it.
            if (e.flavor === "llamacpp") {
              const live = await fetchLlamaCppContext(connectionOf(e)).catch(() => undefined);
              if (live) {
                llamaServerAt = e.baseUrl;
                return live;
              }
            }
            return configuredContextWindow(e, model);
          },
          toolsTransform: (tools) => (store.get(name)?.strictToolSchemas ? llamaCppTools(tools) : tools),
          modelFilter: () => true,
          fallbackModels: [],
          memory: init.memory,
          workspaceId: init.workspaceId,
          tenant: init.tenant,
          sessionId: init.sessionId,
          mcpRegistry: liveMcpSource(init.mcpRegistry, store, name),
          mcpHub: init.mcpHub,
        }),
        init.sessionId,
      );
    },
  };
}

/**
 * Bring `registry`'s endpoint factories in line with the store: add new ones,
 * re-label renamed ones, drop removed ones — except the daemon default, which
 * stays registered (its sessions then refuse to run with the store's message).
 * Also installs the prefix resolver, so a removed endpoint's id stays
 * resolvable and a session on it resumes and refuses to run with a clear
 * message instead of being moved to another backend.
 */
export function syncEndpointProviders(registry: ProviderRegistry, store: EndpointStore, catalog: EndpointCatalog): void {
  registry.setPrefixResolver((providerId) => {
    const name = endpointNameOf(providerId);
    return name ? endpointFactory(name, store, catalog) : undefined;
  });
  const wanted = new Map(store.entries().map((e) => [endpointProviderId(e.name), e]));
  for (const id of registry.ids()) {
    if (endpointNameOf(id) !== null && !wanted.has(id) && id !== registry.defaultId) registry.unregister(id);
  }
  for (const [id, e] of wanted) {
    const displayName = e.displayName || e.name;
    const current = registry.get(id);
    if (current?.displayName === displayName) continue;
    // Replaced in place: the default can't be unregistered, even to re-label it.
    if (current) registry.replace(endpointFactory(e.name, store, catalog, displayName));
    else registry.register(endpointFactory(e.name, store, catalog, displayName));
  }
}

/**
 * Keep `registry` in step with the store from now on. `onChange` runs after
 * each sync (the session manager pushes `providers.changed`). Returns the
 * unsubscribe.
 */
export function watchEndpointProviders(
  registry: ProviderRegistry,
  store: EndpointStore,
  catalog: EndpointCatalog,
  onChange?: () => void,
): () => void {
  return store.onChange(() => {
    catalog.invalidate();
    try {
      syncEndpointProviders(registry, store, catalog);
    } catch (err) {
      console.error(`[codeoid] could not update endpoint backends: ${err instanceof Error ? err.message : String(err)}`);
    }
    onChange?.();
  });
}
