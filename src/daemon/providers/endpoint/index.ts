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

import type { McpServerSource } from "../../mcp/tool-source.js";
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
import { OpenAIProvider } from "../openai/index.js";
import type { ProviderFactory, ProviderRegistry, ProviderSessionInit } from "../registry.js";
import { StatelessSessionProvider } from "../stateless.js";

const MODELS_TIMEOUT_MS = 5_000;
const PROPS_TIMEOUT_MS = 2_000;
/** How long a server's `/models` answer is reused before asking again. */
const MODELS_TTL_MS = 60_000;
const MAX_LISTED_MODELS = 200;

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
  let res: Response;
  try {
    res = await fetchImpl(`${conn.baseURL}/models`, {
      headers: requestHeaders(conn),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not connect";
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
  const ids: string[] = [];
  for (const m of data) {
    const id = typeof m === "string" ? m : (m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name;
    if (typeof id === "string" && id && !/[\x00-\x1f\x7f]/.test(id)) ids.push(id.slice(0, 256));
    if (ids.length >= MAX_LISTED_MODELS) break;
  }
  return ids;
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

/**
 * Model catalogs for endpoints: the configured list when there is one, else
 * the server's own `/models`, cached briefly. Shared by the factories (default
 * model) and the session manager (`models.list`).
 */
export class EndpointCatalog {
  readonly #store: EndpointStore;
  readonly #fetch: typeof fetch;
  readonly #live = new Map<string, { at: number; fingerprint: string; ids: string[] }>();

  constructor(store: EndpointStore, fetchImpl: typeof fetch = fetch) {
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  /** The models to offer for `name`. `live` = asked the server just now (or within the TTL). */
  async models(name: string): Promise<{ models: ModelInfo[]; live: boolean }> {
    const e = this.#store.get(name);
    if (!e) return { models: [], live: false };
    if (e.models.length > 0) {
      return {
        models: e.models.map((m) => ({
          id: m.id,
          displayName: m.name || m.id,
          ...(m.contextWindow ?? e.contextWindow ? { contextWindow: m.contextWindow ?? e.contextWindow } : {}),
        })),
        live: true,
      };
    }
    try {
      const ids = await this.#liveIds(e);
      return {
        models: ids.map((id) => ({
          id,
          // A local server names its model by the file it loaded; the path is noise in a picker.
          displayName: id.split("/").pop() || id,
          ...(e.contextWindow ? { contextWindow: e.contextWindow } : {}),
        })),
        live: true,
      };
    } catch {
      return { models: [], live: false };
    }
  }

  /** The model a turn without an explicit choice runs on. Throws when none can be determined. */
  async defaultModel(name: string): Promise<string> {
    const e = this.#store.get(name);
    if (!e) throw new EndpointError(`the endpoint "${name}" no longer exists`);
    if (e.defaultModel) return e.defaultModel;
    if (e.models[0]) return e.models[0].id;
    let ids: string[] = [];
    try {
      ids = await this.#liveIds(e);
    } catch (err) {
      throw new EndpointError(
        `no model chosen for endpoint "${name}", and its model list couldn't be read (${err instanceof Error ? err.message : String(err)}) — pick one with /model, or configure models on the endpoint`,
      );
    }
    if (!ids[0]) throw new EndpointError(`endpoint "${name}" lists no models — pick one with /model, or configure models on the endpoint`);
    return ids[0];
  }

  /** Forget cached `/models` answers (after an edit). */
  invalidate(name?: string): void {
    if (name) this.#live.delete(name);
    else this.#live.clear();
  }

  async #liveIds(e: StoredEndpoint): Promise<string[]> {
    const conn = connectionOf(e);
    const hit = this.#live.get(e.name);
    if (hit && hit.fingerprint === conn.fingerprint && Date.now() - hit.at < MODELS_TTL_MS) return hit.ids;
    const ids = await fetchEndpointModels(conn, this.#fetch);
    this.#live.set(e.name, { at: Date.now(), fingerprint: conn.fingerprint, ids });
    return ids;
  }
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
    create: (init: ProviderSessionInit) =>
      new StatelessSessionProvider(
        new OpenAIProvider({
          id,
          displayName,
          connection: () => {
            const conn = store.resolveConnection(name); // throws when removed
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
              if (live) return live;
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
      ),
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
    if (current) registry.unregister(id);
    registry.register(endpointFactory(e.name, store, catalog, displayName));
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
