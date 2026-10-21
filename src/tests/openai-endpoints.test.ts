/**
 * OpenAI-compatible endpoints (openai-endpoints.ts, providers/endpoint): the
 * store, the CLI helpers, and the daemon end to end against a real HTTP
 * server speaking the OpenAI API — the real OpenAIProvider, no mocks between
 * the session and the wire.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftConnection, EndpointError, EndpointStore, isPrivateHost } from "../daemon/openai-endpoints.js";
import { EndpointCatalog, syncEndpointProviders, watchEndpointProviders } from "../daemon/providers/endpoint/index.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";
import { importPiModels, parseModelFlags, parseTokens, resolvePiValue } from "../terminal/endpoints.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-endpoints-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const storeAt = () => new EndpointStore(join(dir, "endpoints.json"));

// ── A real OpenAI-compatible server ──────────────────────────────────────────

interface SeenRequest {
  path: string;
  auth: string | null;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
let server: ReturnType<typeof Bun.serve>;
const seen: SeenRequest[] = [];
let validKey = "sk-good";
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : null;
      seen.push({ path: url.pathname, auth: req.headers.get("authorization"), headers: Object.fromEntries(req.headers), body });
      // A server that bounces requests to another origin (localhost vs 127.0.0.1).
      if (url.pathname.startsWith("/bounce/")) {
        return new Response(null, { status: 307, headers: { location: `http://localhost:${url.port}${url.pathname.slice("/bounce".length)}` } });
      }
      if (req.headers.get("authorization") !== `Bearer ${validKey}`) {
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      }
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "served-a" }, { id: "org/served-b.gguf" }] });
      if (url.pathname === "/props") return Response.json({ default_generation_settings: { n_ctx: 8192 } });
      if (url.pathname === "/v1/chat/completions") {
        const model = String(body?.model);
        const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
        const sse = [
          chunk({ id: "c", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: `hello from ${model}` } }] }),
          chunk({ id: "c", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          chunk({ id: "c", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
          "data: [DONE]\n\n",
        ].join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
});
const baseUrl = () => `http://127.0.0.1:${server.port}/v1`;

// ── Store ─────────────────────────────────────────────────────────────────────

describe("EndpointStore", () => {
  test("stores 0600 and never lists the key or header values", () => {
    const store = storeAt();
    store.upsert({ name: "vllm", baseUrl: "http://gpu-box:8000/v1/", apiKey: "sk-secret", headers: { "x-team": "t-secret" } });
    expect(statSync(join(dir, "endpoints.json")).mode & 0o777).toBe(0o600);
    const listed = JSON.stringify(store.list());
    expect(listed).not.toContain("sk-secret");
    expect(listed).not.toContain("t-secret");
    expect(store.list()[0]).toMatchObject({
      name: "vllm",
      providerId: "oai:vllm",
      baseUrl: "http://gpu-box:8000/v1", // trailing slash dropped
      hasApiKey: true,
      headerNames: ["x-team"],
      mcpServers: "all",
      streamUsage: true,
      strictToolSchemas: false,
    });
  });

  test("stored secrets stay with their server: a different origin must re-enter them", () => {
    const store = storeAt();
    store.upsert({ name: "e", baseUrl: "https://api.example.com/v1", apiKey: "k1", headers: { "x-a": "1" } });
    // Same origin, new path: kept.
    store.upsert({ name: "e", baseUrl: "https://api.example.com/v2" });
    expect(store.get("e")).toMatchObject({ apiKey: "k1", headers: { "x-a": "1" } });
    // Another host, scheme or port: refused while either secret would carry over.
    for (const elsewhere of ["https://attacker.example/v1", "https://api.example.com:8443/v1", "http://localhost/v1"]) {
      expect(() => store.upsert({ name: "e", baseUrl: elsewhere })).toThrow(/re-enter its API key and headers/);
      expect(() => store.upsert({ name: "e", baseUrl: elsewhere, apiKey: "k2" })).toThrow(/re-enter its headers/);
    }
    expect(store.get("e")?.baseUrl).toBe("https://api.example.com/v2");
    // Re-entered (or dropped) explicitly: moves.
    store.upsert({ name: "e", baseUrl: "https://other.example/v1", apiKey: "k2", headers: {} });
    expect(store.get("e")).toMatchObject({ baseUrl: "https://other.example/v1", apiKey: "k2" });
    expect(store.get("e")?.headers).toBeUndefined();
    // A test of an edit follows the same rule.
    expect(() => draftConnection({ baseUrl: "https://attacker.example/v1" }, store.get("e"))).toThrow(/re-enter its API key/);
    expect(draftConnection({ baseUrl: "https://other.example/v2" }, store.get("e")).apiKey).toBe("k2");
    expect(draftConnection({ baseUrl: "https://attacker.example/v1", apiKey: null }, store.get("e")).apiKey).toBeUndefined();
  });

  test("secrets are write-only: absent keeps, null clears, a string replaces", () => {
    const store = storeAt();
    store.upsert({ name: "e", baseUrl: "https://api.example.com/v1", apiKey: "k1", headers: { "x-a": "1" } });
    store.upsert({ name: "e", baseUrl: "https://api.example.com/v2" });
    expect(store.get("e")).toMatchObject({ apiKey: "k1", headers: { "x-a": "1" }, baseUrl: "https://api.example.com/v2" });
    store.upsert({ name: "e", baseUrl: "https://api.example.com/v2", apiKey: null, headers: {} });
    expect(store.get("e")?.apiKey).toBeUndefined();
    expect(store.get("e")?.headers).toBeUndefined();
  });

  test("llamacpp flavor defaults: strict tool schemas, no external MCP servers", () => {
    const store = storeAt();
    store.upsert({ name: "local", baseUrl: "http://127.0.0.1:8080/v1", flavor: "llamacpp" });
    expect(store.list()[0]).toMatchObject({ flavor: "llamacpp", strictToolSchemas: true, mcpServers: [] });
  });

  test("rotating a key preserves model settings; explicit values clear overrides", () => {
    const store = storeAt();
    const baseUrl = "http://localhost:8000/v1";
    store.upsert({ name: "box", baseUrl, displayName: "GPU box", defaultModel: "local-model", contextWindow: 32768, apiKey: "old-key" });
    store.upsert({ name: "box", baseUrl, apiKey: "new-key" });
    expect(store.get("box")).toMatchObject({ displayName: "GPU box", defaultModel: "local-model", contextWindow: 32768, apiKey: "new-key" });
    store.upsert({ name: "box", baseUrl, displayName: "", defaultModel: null, contextWindow: null });
    expect(store.get("box")?.displayName).toBeUndefined();
    expect(store.get("box")?.defaultModel).toBeUndefined();
    expect(store.get("box")?.contextWindow).toBeUndefined();
  });

  test("validates URLs: https for public hosts, http only for local and private ones", () => {
    const store = storeAt();
    expect(() => store.upsert({ name: "p", baseUrl: "http://api.openrouter.ai/v1" })).toThrow(/https for a public host/);
    for (const ok of ["http://localhost:1234/v1", "http://192.168.1.20:8000/v1", "http://10.0.0.5/v1", "http://ollama:11434/v1", "http://box.local/v1", "http://[::1]:8080/v1"]) {
      expect(() => store.upsert({ name: "p", baseUrl: ok })).not.toThrow();
    }
    for (const bad of ["https://u:p@api.example.com/v1", "https://api.example.com/v1?key=x", "ftp://x/v1", "not a url"]) {
      expect(() => store.upsert({ name: "p", baseUrl: bad })).toThrow(EndpointError);
    }
  });

  test("validates names, headers and models", () => {
    const store = storeAt();
    const b = "https://api.example.com/v1";
    expect(() => store.upsert({ name: "Has Space", baseUrl: b })).toThrow(/invalid endpoint name/);
    expect(() => store.upsert({ name: "e", baseUrl: b, headers: { host: "x" } })).toThrow(/set by codeoid/);
    expect(() => store.upsert({ name: "e", baseUrl: b, apiKey: "k", headers: { Authorization: "Bearer x" } })).toThrow(/not both/);
    expect(() => store.upsert({ name: "e", baseUrl: b, headers: { "x-a": "1\r\nx-evil: 2" } })).toThrow(/control character/);
    expect(() => store.upsert({ name: "e", baseUrl: b, apiKey: "k\u0000" })).toThrow(/control characters/);
    expect(() => store.upsert({ name: "e", baseUrl: b, models: [{ id: "m" }, { id: "m" }] })).toThrow(/twice/);
    expect(() => store.upsert({ name: "e", baseUrl: b, models: [{ id: "m", contextWindow: 10 }] })).toThrow(/between/);
    expect(() => store.upsert({ name: "e", baseUrl: b, apiKey: "k", headers: { "x-api-key": "v" } })).not.toThrow();
  });

  test("a corrupt file fails closed; an invalid hand-edited entry is ignored, never applied — and never lost", () => {
    const path = join(dir, "endpoints.json");
    writeFileSync(path, "{nope");
    expect(() => storeAt().list()).toThrow(/not valid JSON/);
    const bad = { name: "bad", baseUrl: "http://public.example.com/v1", apiKey: "sk-keep-me" };
    writeFileSync(path, JSON.stringify({ version: 1, endpoints: [{ name: "ok", baseUrl: "http://127.0.0.1:1/v1" }, bad] }));
    const store = storeAt();
    expect(store.list().map((e) => e.name)).toEqual(["ok"]);
    // An unrelated save writes it back as it was, for the user to fix.
    store.upsert({ name: "other", baseUrl: "http://127.0.0.1:2/v1" });
    const onDisk = () => (JSON.parse(readFileSync(path, "utf8")) as { endpoints: Array<{ name: string }> }).endpoints;
    expect(onDisk()).toContainEqual(bad);
    expect(storeAt().list().map((e) => e.name)).toEqual(["ok", "other"]);
    // Replacing it by name, or removing it, does drop it.
    store.upsert({ name: "bad", baseUrl: "https://public.example.com/v1", apiKey: "sk-new" });
    expect(onDisk().filter((e) => e.name === "bad")).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ version: 1, endpoints: [bad] }));
    const again = storeAt();
    expect(again.remove("bad")).toBe(true);
    expect(onDisk()).toEqual([]);
  });

  test("onChange fires after each change; resolveConnection throws for a removed endpoint", () => {
    const store = storeAt();
    let n = 0;
    store.onChange(() => n++);
    store.upsert({ name: "e", baseUrl: "http://127.0.0.1:1/v1" });
    const a = store.resolveConnection("e").fingerprint;
    store.upsert({ name: "e", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" });
    expect(store.resolveConnection("e").fingerprint).not.toBe(a);
    store.remove("e");
    expect(n).toBe(3);
    expect(() => store.resolveConnection("e")).toThrow(/no longer exists/);
  });

  test("isPrivateHost", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.9", "100.100.1.1", "::1", "fd00::1", "gpu-box", "nas.lan"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    // Link-local is out: it's where cloud metadata services answer.
    for (const h of ["8.8.8.8", "172.32.0.1", "api.openai.com", "2001:4860::1", "169.254.169.254", "fe80::1"]) expect(isPrivateHost(h)).toBe(false);
  });

  test("re-labelling the default endpoint keeps the backends in sync", () => {
    const store = storeAt();
    store.upsert({ name: "foo", baseUrl: "http://127.0.0.1:1/v1" });
    const registry = new ProviderRegistry("oai:foo");
    const catalog = new EndpointCatalog(store);
    syncEndpointProviders(registry, store, catalog);
    watchEndpointProviders(registry, store, catalog);
    store.upsert({ name: "foo", baseUrl: "http://127.0.0.1:1/v1", displayName: "Foo!" });
    store.upsert({ name: "bar", baseUrl: "http://127.0.0.1:2/v1" });
    expect(registry.get("oai:foo")?.displayName).toBe("Foo!");
    expect(registry.has("oai:bar")).toBe(true);
  });
});

// ── CLI helpers ───────────────────────────────────────────────────────────────

describe("CLI helpers", () => {
  test("--model parses trailing numbers only, so Ollama ids with colons survive", () => {
    expect(parseModelFlags(["qwen3-coder:128k", "llama3.1:8b", "llama3.1:8b:32k:4096", "plain"])).toEqual([
      { id: "qwen3-coder", contextWindow: 128000 },
      { id: "llama3.1:8b" },
      { id: "llama3.1:8b", contextWindow: 32000, maxTokens: 4096 },
      { id: "plain" },
    ]);
    expect(parseTokens("32k")).toBe(32000);
    expect(() => parseTokens("lots")).toThrow();
  });

  test("pi values: $VAR / ${VAR} interpolate, $$ escapes, !command is never run", () => {
    const env = { KEY: "abc" };
    expect(resolvePiValue("$KEY", env)).toEqual({ value: "abc" });
    expect(resolvePiValue("Bearer ${KEY}", env)).toEqual({ value: "Bearer abc" });
    expect(resolvePiValue("a$$b", env)).toEqual({ value: "a$b" });
    expect(resolvePiValue("MY_API_KEY", env)).toEqual({ value: "MY_API_KEY" }); // a literal, as in pi
    expect(resolvePiValue("$MISSING", env).problem).toContain("MISSING");
    expect(resolvePiValue("!security find-generic-password", env).problem).toContain("doesn't run");
  });

  test("importPiModels carries over openai-completions providers only, with models and compat", () => {
    const { entries, skipped } = importPiModels(
      {
        providers: {
          Ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            compat: { supportsUsageInStreaming: false, maxTokensField: "max_tokens" },
            models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B", contextWindow: 131072, maxTokens: 8192 }],
          },
          gateway: { baseUrl: "https://gw.example.com/v1", api: "openai-completions", apiKey: "$GW_KEY", headers: { "x-ws": "${WS}" } },
          resp: { baseUrl: "https://x.example.com", api: "openai-responses", models: [{ id: "a" }] },
          anthropic: { modelOverrides: {} },
        },
      },
      { GW_KEY: "gw-secret" },
    );
    expect(skipped.map((s) => s.provider).sort()).toEqual(["anthropic", "resp"]);
    const ollama = entries.find((e) => e.endpoint.name === "ollama")!;
    expect(ollama.endpoint).toMatchObject({
      displayName: "Ollama",
      apiKey: "ollama",
      streamUsage: false,
      maxTokensField: "max_tokens",
      models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B", contextWindow: 131072, maxTokens: 8192 }],
    });
    const gw = entries.find((e) => e.endpoint.name === "gateway")!;
    expect(gw.endpoint.apiKey).toBe("gw-secret");
    expect(gw.endpoint.headers).toBeUndefined(); // ${WS} unset → reported, not sent empty
    expect(gw.warnings[0]).toContain("WS");
    // Resolved values are explicit, so --replace replaces them too.
    expect(ollama.endpoint.headers).toEqual({});
  });

  test("importPiModels: two providers with one endpoint name — the second is skipped, not silently merged", () => {
    const p = { baseUrl: "http://localhost:1/v1", api: "openai-completions" };
    const { entries, skipped } = importPiModels({ providers: { "My GPU": p, "my-gpu": { ...p, baseUrl: "http://localhost:2/v1" } } }, {});
    expect(entries.map((e) => e.endpoint.baseUrl)).toEqual(["http://localhost:1/v1"]);
    expect(entries[0]!.endpoint.apiKey).toBeNull(); // pi has none: --replace drops a stored one
    expect(skipped).toEqual([{ provider: "my-gpu", reason: expect.stringContaining('"my-gpu" is already taken') }]);
  });
});

// ── Daemon end to end ─────────────────────────────────────────────────────────

describe("daemon", () => {
  setDefaultTimeout(20_000);
  const AUTH: AuthContext = {
    sub: "user:endpoints",
    scopes: [...ALL_SCOPES] as AuthContext["scopes"],
    delegationDepth: 0,
    accountId: "acc",
    projectId: "proj",
  };
  let store: Store;
  let transcript: TranscriptStore;
  let endpoints: EndpointStore;
  let manager: SessionManager;
  let pushed: DaemonMessage[];
  let client: { id: string; auth: AuthContext; send: (m: DaemonMessage) => void };

  beforeEach(() => {
    seen.length = 0;
    validKey = "sk-good";
    store = new Store(join(dir, "codeoid.db"));
    transcript = new TranscriptStore(join(dir, "transcripts"));
    endpoints = storeAt();
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints });
    pushed = [];
    client = { id: "c1", auth: AUTH, send: (m) => pushed.push(m) };
  });
  afterEach(async () => {
    try {
      await transcript.flush();
    } catch {}
    try {
      store.close();
    } catch {}
  });

  const handle = (msg: Parameters<SessionManager["handle"]>[0], auth: AuthContext = AUTH) =>
    manager.handle(msg, auth, { ...client, auth }) as Promise<DaemonMessage & Record<string, unknown>>;

  const waitFor = async (pred: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out; pushed: ${JSON.stringify(pushed.map((m) => [m.type, (m as { role?: string }).role, String((m as { content?: unknown }).content ?? "").slice(0, 120)])).slice(0, 3000)}; seen: ${seen.map((r) => r.path).join(",")}`);
      await Bun.sleep(20);
    }
  };
  /** Final assistant messages, one per message id (a streamed message is sent again when it completes). */
  const assistantTexts = () => {
    const byId = new Map<string, string>();
    for (const m of pushed) if (m.type === "session.message" && m.role === "assistant") byId.set(m.messageId, String(m.content));
    return [...byId.values()];
  };
  const errors = () => pushed.flatMap((m) => (m.type === "session.message" && m.role === "system" ? [String(m.content)] : []));

  test("an endpoint appears as a backend, live — and subscribers are told", async () => {
    const before = (await handle({ type: "providers.list", id: "p" })) as unknown as { providers: Array<{ id: string }> };
    expect(before.providers.some((p) => p.id.startsWith("oai:"))).toBe(false);
    await handle({ type: "endpoints.set", id: "s", name: "box", displayName: "GPU box", baseUrl: baseUrl(), apiKey: validKey });
    const changed = pushed.find((m) => m.type === "providers.changed") as {
      providers: Array<{ id: string; displayName: string; kind: string; isDefault: boolean }>;
    };
    expect(changed.providers).toContainEqual({ id: "oai:box", displayName: "GPU box", kind: "endpoint", isDefault: false });
    expect(manager.providerIds()).toContain("oai:box");
  });

  test("a session runs on the endpoint: key, headers, default model; edits apply next turn; removal refuses", async () => {
    await handle({
      type: "endpoints.set",
      id: "s",
      name: "box",
      baseUrl: baseUrl(),
      apiKey: validKey,
      headers: { "x-workspace": "ws-1" },
      models: [{ id: "cfg-model", contextWindow: 16000, maxTokens: 512 }],
    });
    const created = (await handle({ type: "session.create", id: "c", name: "s1", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    const sid = created.data!.id;
    expect(created.data?.providerId).toBe("oai:box");
    await handle({ type: "session.attach", id: "a", sessionId: sid });

    await handle({ type: "session.send", id: "m1", sessionId: sid, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from cfg-model");
    const chat = seen.filter((r) => r.path === "/v1/chat/completions");
    expect(chat[0]!.auth).toBe(`Bearer ${validKey}`);
    expect(chat[0]!.headers["x-workspace"]).toBe("ws-1");
    expect(chat[0]!.body).toMatchObject({ model: "cfg-model", max_tokens: 512, stream_options: { include_usage: true } });

    // Rotate the key and drop usage streaming: the running session picks both up.
    validKey = "sk-rotated";
    await handle({ type: "endpoints.set", id: "s2", name: "box", baseUrl: baseUrl(), apiKey: "sk-rotated", streamUsage: false });
    await waitFor(() => pushed.at(-1)?.type === "session.status_change");
    await handle({ type: "session.send", id: "m2", sessionId: sid, text: "again" });
    await waitFor(() => assistantTexts().length === 2);
    const last = seen.filter((r) => r.path === "/v1/chat/completions").at(-1)!;
    expect(last.auth).toBe("Bearer sk-rotated");
    expect(last.body?.stream_options).toBeUndefined();

    // Removed: the session refuses, it doesn't fall back to another backend.
    await handle({ type: "endpoints.remove", id: "r", name: "box" });
    expect(manager.providerIds()).not.toContain("oai:box");
    await Bun.sleep(50);
    await handle({ type: "session.send", id: "m3", sessionId: sid, text: "still there?" });
    await waitFor(() => errors().some((e) => e.includes("no longer exists")));
    expect(seen.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(2);
  });

  test("with no configured models, the server's own list is offered and its first is the default", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    const models = (await handle({ type: "models.list", id: "m", provider: "oai:box" })) as unknown as {
      models: Array<{ value: string; displayName: string }>;
      live: boolean;
    };
    expect(models.live).toBe(true);
    expect(models.models).toEqual([
      { value: "served-a", displayName: "served-a" },
      { value: "org/served-b.gguf", displayName: "served-b.gguf" },
    ]);
    const created = (await handle({ type: "session.create", id: "c", name: "s2", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await handle({ type: "session.attach", id: "a", sessionId: created.data!.id });
    await handle({ type: "session.send", id: "m1", sessionId: created.data!.id, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from served-a");
  });

  test("endpoints.test: a stored endpoint, a draft, a rejected key, llama.cpp's window", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, flavor: "llamacpp" });
    const stored = await handle({ type: "endpoints.test", id: "t1", name: "box" });
    expect(stored).toMatchObject({ type: "endpoints.test.result", ok: true, models: ["served-a", "org/served-b.gguf"], contextWindow: 8192 });
    // A draft edit of the stored endpoint: new URL, stored key fills in.
    const draft = await handle({ type: "endpoints.test", id: "t2", name: "box", baseUrl: `${baseUrl()}/` });
    expect(draft).toMatchObject({ ok: true });
    const bad = await handle({ type: "endpoints.test", id: "t3", baseUrl: baseUrl(), apiKey: "sk-wrong" });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("rejected the credentials") });
    const publicHttp = await handle({ type: "endpoints.test", id: "t4", baseUrl: "http://api.example.com/v1" });
    expect(publicHttp).toMatchObject({ ok: false, error: expect.stringContaining("https") });
  });

  test("endpoints.test never sends a stored key to another server", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, headers: { "x-team": "t-secret" } });
    seen.length = 0;
    const elsewhere = `http://localhost:${server.port}/v1`; // same server, another origin
    const refused = await handle({ type: "endpoints.test", id: "t", name: "box", baseUrl: elsewhere });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("re-enter") });
    expect(seen).toHaveLength(0);
    expect(await handle({ type: "endpoints.set", id: "s2", name: "box", baseUrl: elsewhere })).toMatchObject({ type: "response.error" });
    expect(endpoints.get("box")?.baseUrl).toBe(baseUrl());
  });

  test("a chat request doesn't follow a redirect with the endpoint's headers", async () => {
    await handle({
      type: "endpoints.set",
      id: "s",
      name: "box",
      baseUrl: `http://127.0.0.1:${server.port}/bounce/v1`,
      apiKey: validKey,
      headers: { "x-api-key": "hdr-secret" },
      models: [{ id: "m" }],
    });
    const created = (await handle({ type: "session.create", id: "c", name: "sr", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await handle({ type: "session.attach", id: "a", sessionId: created.data!.id });
    await handle({ type: "session.send", id: "m1", sessionId: created.data!.id, text: "hi" });
    await waitFor(() => errors().length > 0 || pushed.some((m) => m.type === "session.status_change" && (m as { status?: string }).status === "error"));
    expect(seen.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(0);
    expect(assistantTexts()).toEqual([]);
  });

  test("the endpoint session.defaultProvider names can't be removed — the next start would fail", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      mkdirSync(join(dir, "codeoid"), { recursive: true });
      writeFileSync(join(dir, "codeoid", "config.json"), JSON.stringify({ session: { defaultProvider: "oai:box" } }));
      expect(await handle({ type: "endpoints.remove", id: "r", name: "box" })).toMatchObject({
        type: "response.error",
        error: expect.stringContaining("default backend"),
      });
      expect(endpoints.has("box")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  test("a delegated token can't change, remove or test endpoints", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    const delegated = { ...AUTH, delegationDepth: 1 };
    for (const msg of [
      { type: "endpoints.set", id: "x", name: "e2", baseUrl: baseUrl() },
      { type: "endpoints.remove", id: "y", name: "box" },
      { type: "endpoints.test", id: "z", name: "box" },
    ] as const) {
      expect(await handle(msg, delegated)).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    expect((await handle({ type: "endpoints.list", id: "l" }, delegated)).type).toBe("endpoints.result");
  });

  test("scopes: listing needs settings:read; changing or testing needs settings:write; the list never carries secrets", async () => {
    const reader = { ...AUTH, scopes: ["settings:read"] as AuthContext["scopes"] };
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: "sk-wire-secret" });
    const listed = await handle({ type: "endpoints.list", id: "l" }, reader);
    expect(listed.type).toBe("endpoints.result");
    expect(JSON.stringify(listed)).not.toContain("sk-wire-secret");
    for (const msg of [
      { type: "endpoints.set", id: "x", name: "e2", baseUrl: baseUrl() },
      { type: "endpoints.remove", id: "y", name: "box" },
      { type: "endpoints.test", id: "z", name: "box" },
    ] as const) {
      expect(await handle(msg, reader)).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    const none = { ...AUTH, scopes: [] as AuthContext["scopes"] };
    expect(await handle({ type: "endpoints.list", id: "l2" }, none)).toMatchObject({ code: "forbidden" });
    expect((await handle({ type: "providers.list", id: "p" }, none)).type).toBe("providers.result");
  });

  test("a session on a removed endpoint resumes on it and refuses — it is not moved to Claude", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    const created = (await handle({ type: "session.create", id: "c", name: "s3", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await transcript.flush();
    endpoints.remove("box");
    // A new daemon over the same data.
    const manager2 = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints: storeAt() });
    await manager2.resumeSessions();
    const list = (await manager2.handle({ type: "session.list", id: "l" }, AUTH, client)) as unknown as { sessions: SessionInfo[] };
    const resumed = list.sessions.find((s) => s.id === created.data!.id);
    expect(resumed?.providerId).toBe("oai:box");
    // Creating a NEW session on it is refused: has() stays strict.
    const fresh = await manager2.handle({ type: "session.create", id: "c2", name: "s4", workdir: dir, providerId: "oai:box" }, AUTH, client);
    expect(fresh).toMatchObject({ type: "response.error", code: "invalid_request" });
  });

  test("meta persists the endpoint provider id", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    const created = (await handle({ type: "session.create", id: "c", name: "s5", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await transcript.flush();
    const meta = JSON.parse(readFileSync(join(dir, "transcripts", `${created.data!.id}.meta.json`), "utf8"));
    expect(meta.providerId).toBe("oai:box");
  });
});
