/**
 * OpenAI-compatible endpoints (openai-endpoints.ts, providers/endpoint): the
 * store, the CLI helpers, and the daemon end to end against a real HTTP
 * server speaking the OpenAI API — the real OpenAIProvider, no mocks between
 * the session and the wire.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftConnection, EndpointError, EndpointStore, isPrivateHost } from "../daemon/openai-endpoints.js";
import { EndpointCatalog, fetchListedModels, syncEndpointProviders, watchEndpointProviders } from "../daemon/providers/endpoint/index.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { resolveOnEndpoint, SessionManager } from "../daemon/session-manager.js";
import { backendLabel } from "../daemon/session.js";
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
/** What the fake server's /models lists: entries as a server sends them. */
const DEFAULT_LISTED: unknown[] = [{ id: "served-a" }, { id: "org/served-b.gguf" }];
let listedModels: unknown[] = DEFAULT_LISTED;
/** False: the fake server's /models fails (a gateway without one, or one that is down). */
let modelsUp = true;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // The same server under another base path: another connection to codeoid.
      if (url.pathname.startsWith("/alt/")) url.pathname = url.pathname.slice("/alt".length);
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : null;
      seen.push({ path: url.pathname, auth: req.headers.get("authorization"), headers: Object.fromEntries(req.headers), body });
      // A server that bounces requests to another origin (localhost vs 127.0.0.1).
      if (url.pathname.startsWith("/bounce/")) {
        return new Response(null, { status: 307, headers: { location: `http://localhost:${url.port}${url.pathname.slice("/bounce".length)}` } });
      }
      if (req.headers.get("authorization") !== `Bearer ${validKey}`) {
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      }
      if (url.pathname === "/v1/models") return modelsUp ? Response.json({ data: listedModels }) : new Response("no", { status: 404 });
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

  test("cloud metadata services are refused by name, whatever the scheme", () => {
    const store = storeAt();
    for (const url of ["http://metadata.google.internal/v1", "https://metadata.google.internal./v1", "http://metadata/v1", "http://100.100.100.200/v1", "http://[fd00:ec2::254]/v1", "http://169.254.169.254/v1"]) {
      expect(() => store.upsert({ name: "m", baseUrl: url })).toThrow(EndpointError);
    }
    expect(() => draftConnection({ baseUrl: "http://metadata.google.internal/v1", headers: { "Metadata-Flavor": "Google" } }, undefined)).toThrow(/metadata/);
  });

  test("a hand-edited name must be a string — `5` doesn't pass as \"5\"", () => {
    writeFileSync(join(dir, "endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ name: 5, baseUrl: "http://127.0.0.1:1/v1" }] }));
    const store = storeAt();
    expect(store.list()).toEqual([]);
    store.upsert({ name: "5", baseUrl: "http://127.0.0.1:2/v1" });
    expect(storeAt().list().map((e) => e.name)).toEqual(["5"]);
  });

  test("a hand edit while the daemon runs is picked up, not overwritten by the next save", () => {
    const path = join(dir, "endpoints.json");
    const store = storeAt();
    let changes = 0;
    store.onChange(() => changes++);
    store.upsert({ name: "a", baseUrl: "http://127.0.0.1:1/v1" });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { endpoints: Array<Record<string, unknown>> };
    onDisk.endpoints.push({ name: "hand", baseUrl: "http://127.0.0.1:3/v1" });
    writeFileSync(path, JSON.stringify(onDisk));
    // Make sure the edit's mtime differs from the save's, whatever the clock resolution.
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    expect(store.list().map((e) => e.name)).toEqual(["a", "hand"]);
    expect(changes).toBe(2); // the save, then the reload
    store.upsert({ name: "b", baseUrl: "http://127.0.0.1:2/v1" });
    expect(storeAt().list().map((e) => e.name)).toEqual(["a", "b", "hand"]);
    // A broken edit fails closed — and a save can't write over it.
    writeFileSync(path, "{broken");
    utimesSync(path, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(() => store.upsert({ name: "c", baseUrl: "http://127.0.0.1:4/v1" })).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });

  test("a loopback llama.cpp endpoint is free only once it answered /props as llama-server — a proxy to a paid API isn't (#430)", async () => {
    for (const llamaServer of [true, false]) {
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const local = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          if (new URL(req.url).pathname === "/props") {
            return llamaServer ? Response.json({ default_generation_settings: { n_ctx: 4096 } }) : new Response("not found", { status: 404 });
          }
          const sse = [
            chunk({ id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }),
            chunk({ id: "c", object: "chat.completion.chunk", model: "m", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
            "data: [DONE]\n\n",
          ].join("");
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        },
      });
      try {
        const store = storeAt();
        store.upsert({ name: "box", baseUrl: `http://127.0.0.1:${local.port}/v1`, flavor: "llamacpp", models: [{ id: "m" }] });
        const registry = new ProviderRegistry("oai:box");
        syncEndpointProviders(registry, store, new EndpointCatalog(store));
        const provider = registry.get("oai:box")!.create({ sessionId: "s" } as never);
        expect(provider.free).toBe(false); // not asked yet
        const run = provider.runTurn({ history: [], userMessage: "x", workdir: dir, canUseTool: async () => ({ behavior: "allow" }) } as never);
        let done: { result: { costSource?: string } } | undefined;
        for await (const e of run.events) if (e.type === "turn_done") done = e as never;
        expect(done?.result.costSource).toBe(llamaServer ? "free" : undefined);
      } finally {
        local.stop(true);
      }
    }
  });

  test("...and it answers /props before the first request, so a first turn that fails there is free too (#430)", async () => {
    const local = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/props") return Response.json({ default_generation_settings: { n_ctx: 4096 } });
        return Response.json({ error: { message: "context overflow" } }, { status: 500 });
      },
    });
    try {
      const store = storeAt();
      store.upsert({ name: "box", baseUrl: `http://127.0.0.1:${local.port}/v1`, flavor: "llamacpp", models: [{ id: "m" }] });
      const registry = new ProviderRegistry("oai:box");
      syncEndpointProviders(registry, store, new EndpointCatalog(store));
      const provider = registry.get("oai:box")!.create({ sessionId: "s" } as never);
      const run = provider.runTurn({ history: [], userMessage: "x", workdir: dir, canUseTool: async () => ({ behavior: "allow" }) } as never);
      for await (const _ of run.events) {
        /* drain */
      }
      expect(provider.free).toBe(true);
    } finally {
      local.stop(true);
    }
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

describe("a server's model list", () => {
  const answering = (body: unknown, status = 200): typeof fetch =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;
  const conn = { baseURL: "http://127.0.0.1:1/v1", headers: {} };

  test("is read as the server sends it: ids or names, objects or strings, once each; a bad id is dropped, never cut", async () => {
    const listed = await fetchListedModels(
      conn,
      answering({ data: ["plain", { id: "obj" }, { name: "named" }, { id: "obj" }, { id: "x".repeat(257) }, { id: "bad\nid" }, { id: "" }, 42, null] }),
    );
    expect(listed).toEqual([
      { id: "plain", chat: true },
      { id: "obj", chat: true },
      { id: "named", chat: true },
    ]);
    expect(await fetchListedModels(conn, answering({ models: [{ id: "ollama-style" }] }))).toEqual([{ id: "ollama-style", chat: true }]);
  });

  test("only a kind the server marks makes a model not for chat", async () => {
    const listed = await fetchListedModels(
      conn,
      answering({
        data: [
          { id: "a", type: "embedding" },
          { id: "b", type: "Embeddings" },
          { id: "c", mode: "rerank" },
          { id: "d", task: "text-embedding" },
          { id: "e", mode: "image_generation" },
          { id: "f", type: "llm" },
          { id: "g", mode: "chat" },
          { id: "Some-Embedding-Model" },
        ],
      }),
    );
    expect(listed.filter((m) => m.chat).map((m) => m.id)).toEqual(["f", "g", "Some-Embedding-Model"]);
  });

  test("a kept list that is unreadable or malformed is ignored, not trusted", async () => {
    const store = storeAt();
    store.upsert({ name: "box", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "cfg" }] });
    for (const content of ["{not json", JSON.stringify({ version: 2, endpoints: {} }), JSON.stringify({ version: 1, endpoints: { box: { fingerprint: 7, at: 0, models: [] } } })]) {
      writeFileSync(store.modelsCachePath, content);
      const catalog = new EndpointCatalog(store, (async () => new Response("down", { status: 503 })) as unknown as typeof fetch, { cacheFile: store.modelsCachePath });
      expect(await catalog.models("box")).toEqual({ models: [{ id: "cfg", displayName: "cfg" }], live: false, source: "configured" });
    }
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
    listedModels = DEFAULT_LISTED;
    modelsUp = true;
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
    // The configured model the server serves is the default, ahead of the server's own first.
    listedModels = [{ id: "served-a" }, { id: "cfg-model" }];
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

  const pickable = async (provider = "oai:box") => {
    const r = (await handle({ type: "models.list", id: "m", provider })) as unknown as { models: Array<{ value: string; displayName: string; contextWindow?: number }>; live: boolean };
    return { ids: r.models.map((m) => m.value), models: r.models, live: r.live };
  };

  test("the server's list decides what's offered: configured models are settings, the reported case (2 configured, 5 served)", async () => {
    // The shape of the report: two models configured, the gateway serves five, one of them an embedding model.
    listedModels = [
      { id: "DeepSeek-V4-Flash" },
      { id: "DeepSeek-V4.1-Flash" },
      { id: "GLM-5.3-Coding" },
      { id: "MiMo-V2.5" },
      { id: "Qwen3-Embedding-8B" },
    ];
    await handle({
      type: "endpoints.set",
      id: "s",
      name: "box",
      baseUrl: baseUrl(),
      apiKey: validKey,
      models: [{ id: "GLM-5.3-Coding", name: "GLM coding", contextWindow: 200_000 }, { id: "DeepSeek-V4.1-Flash" }],
    });
    const offered = await pickable();
    expect(offered.live).toBe(true);
    // Every served model, the configured ones first in their configured order. A name is
    // never guessed from: the server marks nothing, so the embedding model is offered too.
    expect(offered.ids).toEqual(["GLM-5.3-Coding", "DeepSeek-V4.1-Flash", "DeepSeek-V4-Flash", "MiMo-V2.5", "Qwen3-Embedding-8B"]);
    // Configured settings apply by id.
    expect(offered.models[0]).toMatchObject({ displayName: "GLM coding", contextWindow: 200_000 });
    // A served model nobody configured is a pick like any other, and runs.
    const created = (await handle({ type: "session.create", id: "c", name: "r1", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    const sessionId = created.data!.id;
    await handle({ type: "session.attach", id: "a", sessionId });
    expect(await handle({ type: "session.set_model", id: "sm", sessionId, model: "MiMo-V2.5" })).toMatchObject({ type: "response.ok" });
    await handle({ type: "session.send", id: "m1", sessionId, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from MiMo-V2.5");
  });

  test("a model the server marks as not for chat isn't offered or chosen as the default; test says which", async () => {
    // LM Studio / Together mark `type`, LiteLLM `mode`.
    listedModels = [
      { id: "embed-a", type: "embeddings" },
      { id: "rerank-b", mode: "rerank" },
      { id: "chat-c", type: "llm" },
      { id: "chat-d" },
    ];
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    expect((await pickable()).ids).toEqual(["chat-c", "chat-d"]);
    const created = (await handle({ type: "session.create", id: "c", name: "r2", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await handle({ type: "session.attach", id: "a", sessionId: created.data!.id });
    await handle({ type: "session.send", id: "m1", sessionId: created.data!.id, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from chat-c");
    const t = await handle({ type: "endpoints.test", id: "t", name: "box" });
    expect(t).toMatchObject({ ok: true, models: ["embed-a", "rerank-b", "chat-c", "chat-d"], notChat: ["embed-a", "rerank-b"] });
  });

  test("a configured model the server doesn't list stays offered, marked, and test names it; a draft's test doesn't", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "gone-model" }, { id: "served-a" }] });
    const offered = await pickable();
    // The owner's choice: a gateway can serve an alias it doesn't list, and a retired name is theirs to remove.
    expect(offered.ids).toEqual(["gone-model", "served-a", "org/served-b.gguf"]);
    expect(offered.models[0]!.displayName).toBe("gone-model (not listed by the server)");
    expect(offered.models[1]!.displayName).toBe("served-a");
    const t = await handle({ type: "endpoints.test", id: "t", name: "box" });
    expect(t).toMatchObject({ ok: true, notServed: ["gone-model"] });
    // A draft on another URL is a different server: its list says nothing about the stored models.
    const draft = await handle({ type: "endpoints.test", id: "t2", name: "box", baseUrl: baseUrl().replace("/v1", "/alt/v1") });
    expect(draft).toMatchObject({ ok: true });
    expect("notServed" in draft).toBe(false);
  });

  test("a server that can't answer: its last list stands in (also after a restart); without one, the configured models", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "served-a", contextWindow: 9000 }] });
    expect((await pickable()).ids).toEqual(["served-a", "org/served-b.gguf"]);
    const kept = join(dir, "endpoint-models.json");
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    expect(readFileSync(kept, "utf8")).not.toContain(validKey);

    modelsUp = false;
    // A label edit keeps the connection: the minute's answer is dropped, the kept list isn't.
    await handle({ type: "endpoints.set", id: "s2", name: "box", baseUrl: baseUrl(), displayName: "Box" });
    expect(await pickable()).toMatchObject({ ids: ["served-a", "org/served-b.gguf"], live: false });

    // A daemon restart: read back from disk.
    const restarted = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints: storeAt() });
    const again = (await restarted.handle({ type: "models.list", id: "m", provider: "oai:box" }, AUTH, { ...client })) as unknown as {
      models: Array<{ value: string }>;
      live: boolean;
    };
    expect(again.models.map((m) => m.value)).toEqual(["served-a", "org/served-b.gguf"]);
    expect(again.live).toBe(false);

    // A list read over another connection is never used: here a new path on the same server.
    await handle({ type: "endpoints.set", id: "s3", name: "box", baseUrl: `${baseUrl()}/elsewhere` });
    expect(await pickable()).toMatchObject({ ids: ["served-a"], live: false });
  });

  test("with no list from the server and none kept, the first configured model runs", async () => {
    modelsUp = false;
    listedModels = [{ id: "cfg-1" }, { id: "cfg-2" }];
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "cfg-2" }, { id: "cfg-1" }] });
    expect(await pickable()).toMatchObject({ ids: ["cfg-2", "cfg-1"], live: false });
    const created = (await handle({ type: "session.create", id: "c", name: "r3", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await handle({ type: "session.attach", id: "a", sessionId: created.data!.id });
    await handle({ type: "session.send", id: "m1", sessionId: created.data!.id, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from cfg-2");
  });

  const modelsHits = () => seen.filter((r) => r.path === "/v1/models").length;

  test("round 1: a configured model is the default with no request, even one the gateway routes but doesn't list", async () => {
    // LiteLLM / OpenRouter aliases: routed, not listed. On main the first configured model was the default; it still is.
    listedModels = [{ id: "zz-expensive-model" }, { id: "cheap" }];
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "my-alias" }] });
    const created = (await handle({ type: "session.create", id: "c", name: "al", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    const sessionId = created.data!.id;
    await handle({ type: "session.attach", id: "a", sessionId });
    const before = modelsHits();
    await handle({ type: "session.send", id: "m1", sessionId, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from my-alias");
    expect(modelsHits()).toBe(before);
    // Offered first, marked, and pickable.
    const offered = await pickable();
    expect(offered.ids).toEqual(["my-alias", "zz-expensive-model", "cheap"]);
    expect(await handle({ type: "session.set_model", id: "sm", sessionId, model: "my-alias" })).toMatchObject({ type: "response.ok" });
  });

  test("round 1: a configured Claude id stays pickable on a gateway that doesn't list it", async () => {
    listedModels = [{ id: "gpt-x" }];
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "claude-sonnet-4-5" }] });
    const created = (await handle({ type: "session.create", id: "c", name: "cl", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await handle({ type: "session.attach", id: "a", sessionId: created.data!.id });
    expect(await handle({ type: "session.set_model", id: "sm", sessionId: created.data!.id, model: "claude-sonnet-4-5" })).toMatchObject({ type: "response.ok" });
    // An unconfigured, unlisted Claude id is still refused, naming what the server serves.
    const refused = await handle({ type: "session.set_model", id: "sm2", sessionId: created.data!.id, model: "claude-opus-4-1" });
    expect(String(refused.error)).toContain("It serves: claude-sonnet-4-5, gpt-x");
  });

  test("round 1: a server that is down is asked once per half minute, and concurrent asks share one request", async () => {
    modelsUp = false;
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    const before = modelsHits();
    await Promise.all(Array.from({ length: 20 }, () => pickable()));
    for (let i = 0; i < 5; i++) await pickable();
    expect(modelsHits() - before).toBe(1);
    // With nothing known, the refusal names nothing as served.
    const created = (await handle({ type: "session.create", id: "c", name: "dn", workdir: dir, providerId: "oai:box", model: "local-x" })) as { data?: SessionInfo };
    const refused = await handle({ type: "session.set_model", id: "sm", sessionId: created.data!.id, model: "sonnet" });
    expect(String(refused.error)).not.toContain("It serves");
    // Up again: concurrent cold asks share one request too.
    modelsUp = true;
    await handle({ type: "endpoints.set", id: "s2", name: "box", baseUrl: baseUrl(), displayName: "Box" }); // an edit forgets the failure
    const mid = modelsHits();
    await Promise.all(Array.from({ length: 20 }, () => pickable()));
    expect(modelsHits() - mid).toBe(1);
  });

  test("round 1: with only configured models to go on, the refusal says Configured, not It serves", async () => {
    modelsUp = false;
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "gone-model" }] });
    const created = (await handle({ type: "session.create", id: "c", name: "cf", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    const refused = await handle({ type: "session.set_model", id: "sm", sessionId: created.data!.id, model: "sonnet" });
    expect(String(refused.error)).toContain("Configured: gone-model");
  });

  test("round 1: a configured model the server marks not for chat is the owner's: offered, not listed as not-for-chat, never the default ahead of a chat one", async () => {
    listedModels = [{ id: "embed-x", type: "embeddings" }, { id: "chat-a" }];
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "embed-x" }, { id: "chat-a" }] });
    expect((await pickable()).ids).toEqual(["embed-x", "chat-a"]);
    const t = await handle({ type: "endpoints.test", id: "t", name: "box" });
    expect("notChat" in t).toBe(false);
    const created = (await handle({ type: "session.create", id: "c", name: "nc", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    await handle({ type: "session.attach", id: "a", sessionId: created.data!.id });
    await handle({ type: "session.send", id: "m1", sessionId: created.data!.id, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from chat-a");
  });

  test("round 1: ids with terminal controls, invisible or direction marks are dropped, and can't be picked", async () => {
    listedModels = [{ id: "ok-model" }, { id: "evil\u009b2J" }, { id: "bidi\u202egnp.exe" }, { id: "zw\u200bsp" }, { id: "line\u2028sep" }];
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey });
    expect((await pickable()).ids).toEqual(["ok-model"]);
    const created = (await handle({ type: "session.create", id: "c", name: "ct", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    for (const model of ["evil\u009b2J", "bidi\u202egnp.exe"]) {
      const r = await handle({ type: "session.set_model", id: "sm", sessionId: created.data!.id, model });
      expect(String(r.error)).toContain("isn't a model id");
    }
  });

  test("round 1: a FIFO, a link or a huge file at the kept-lists path never hangs or misleads the daemon", async () => {
    await handle({ type: "endpoints.set", id: "s", name: "box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "cfg" }] });
    const kept = join(dir, "endpoint-models.json");
    expect(spawnSync("mkfifo", [kept]).status).toBe(0);
    modelsUp = false;
    const restarted = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints: storeAt() });
    const started = Date.now();
    const r = (await restarted.handle({ type: "models.list", id: "m", provider: "oai:box" }, AUTH, { ...client })) as unknown as { models: Array<{ value: string }> };
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.models.map((m) => m.value)).toEqual(["cfg"]);
    rmSync(kept);
    writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ version: 1, endpoints: {} }));
    symlinkSync(join(dir, "elsewhere.json"), kept);
    const viaLink = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints: storeAt() });
    const r2 = (await viaLink.handle({ type: "models.list", id: "m", provider: "oai:box" }, AUTH, { ...client })) as unknown as { models: Array<{ value: string }> };
    expect(r2.models.map((m) => m.value)).toEqual(["cfg"]);
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
    await waitFor(() => errors().some((e) => e.includes("redirected elsewhere")));
    expect(seen.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(0);
    expect(assistantTexts()).toEqual([]);
    // /models says the same.
    const tested = await handle({ type: "endpoints.test", id: "t", name: "box" });
    expect(tested).toMatchObject({ ok: false, error: expect.stringContaining("redirected elsewhere") });
  });

  test("a keyless endpoint gets no Authorization, and never the daemon's OpenAI org or project", async () => {
    const got: Array<Record<string, string>> = [];
    const open = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        got.push(Object.fromEntries(req.headers));
        const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
        return new Response(
          `${chunk({ id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: "stop" }] })}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const saved = { org: process.env.OPENAI_ORG_ID, project: process.env.OPENAI_PROJECT_ID };
    process.env.OPENAI_ORG_ID = "org-daemon-owner";
    process.env.OPENAI_PROJECT_ID = "proj-daemon-owner";
    try {
      await handle({ type: "endpoints.set", id: "s", name: "open", baseUrl: `http://127.0.0.1:${open.port}/v1`, models: [{ id: "m" }] });
      const created = (await handle({ type: "session.create", id: "c", name: "sk", workdir: dir, providerId: "oai:open" })) as { data?: SessionInfo };
      await handle({ type: "session.attach", id: "a", sessionId: created.data!.id });
      await handle({ type: "session.send", id: "m1", sessionId: created.data!.id, text: "hi" });
      await waitFor(() => assistantTexts().length === 1);
      expect(got[0]!.authorization).toBeUndefined();
      expect(got[0]!["openai-organization"]).toBeUndefined();
      expect(got[0]!["openai-project"]).toBeUndefined();
    } finally {
      if (saved.org === undefined) delete process.env.OPENAI_ORG_ID;
      else process.env.OPENAI_ORG_ID = saved.org;
      if (saved.project === undefined) delete process.env.OPENAI_PROJECT_ID;
      else process.env.OPENAI_PROJECT_ID = saved.project;
      open.stop(true);
    }
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

  test("a model the dropdown offers is one the switch accepts, and the server answers on it; a custom id passes through, a Claude one is refused", async () => {
    listedModels = [{ id: "conf-b" }, { id: "served-a" }, { id: "conf-a" }];
    await handle({ type: "endpoints.set", id: "s", name: "box", displayName: "GPU box", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "conf-a" }, { id: "conf-b" }] });
    const listed = (await handle({ type: "models.list", id: "m", provider: "oai:box" })) as unknown as { models: Array<{ value: string }> };
    expect(listed.models.map((m) => m.value)).toEqual(["conf-a", "conf-b", "served-a"]);
    const created = (await handle({ type: "session.create", id: "c", name: "sm", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    const sessionId = created.data!.id;
    await handle({ type: "session.attach", id: "a", sessionId });

    // A model from the dropdown: accepted (it was refused with "Available: " and nothing after it), and used.
    expect(await handle({ type: "session.set_model", id: "sm1", sessionId, model: "conf-b" })).toMatchObject({ type: "response.ok", data: { model: "conf-b" } });
    await handle({ type: "session.send", id: "m1", sessionId, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from conf-b");

    // The dropdown's custom model id: not listed, so the server is the judge.
    expect(await handle({ type: "session.set_model", id: "sm2", sessionId, model: "unlisted-x" })).toMatchObject({ type: "response.ok", data: { model: "unlisted-x" } });
    await handle({ type: "session.send", id: "m2", sessionId, text: "again" });
    await waitFor(() => assistantTexts().length === 2);
    expect(assistantTexts()[1]).toBe("hello from unlisted-x");

    // A Claude model isn't the endpoint's: refused, saying why and what is configured.
    for (const model of ["claude-sonnet-4-5", "opus"]) {
      const refused = await handle({ type: "session.set_model", id: `sm-${model}`, sessionId, model });
      expect(refused).toMatchObject({ type: "response.error", code: "invalid_request" });
      expect(String(refused.error)).toContain("is a Claude model");
      expect(String(refused.error)).toContain("It serves: conf-a, conf-b, served-a");
    }

    // Its replies are labelled with the endpoint, not "(Claude)".
    const replies = pushed.flatMap((m) => (m.type === "session.message" && m.role === "assistant" ? [m.identity.name] : []));
    expect(replies.length).toBeGreaterThan(0);
    for (const name of replies) expect(name).toBe("sm (GPU box)");
  });

  test("a Claude model a gateway lists is a model it serves; a removed endpoint takes no model (round-1 audit)", async () => {
    listedModels = [{ id: "claude-sonnet-4-5" }];
    await handle({ type: "endpoints.set", id: "s", name: "gw", baseUrl: baseUrl(), apiKey: validKey, models: [{ id: "claude-sonnet-4-5" }] });
    const created = (await handle({ type: "session.create", id: "c", name: "gw1", workdir: dir, providerId: "oai:gw" })) as { data?: SessionInfo };
    const sessionId = created.data!.id;
    await handle({ type: "session.attach", id: "a", sessionId });
    expect(await handle({ type: "session.set_model", id: "m1", sessionId, model: "claude-sonnet-4-5" })).toMatchObject({ type: "response.ok", data: { model: "claude-sonnet-4-5" } });
    await handle({ type: "session.send", id: "t1", sessionId, text: "hi" });
    await waitFor(() => assistantTexts().length === 1);
    expect(assistantTexts()[0]).toBe("hello from claude-sonnet-4-5");
    // Not listed: refused.
    expect(await handle({ type: "session.set_model", id: "m2", sessionId, model: "us.anthropic.claude-3-5-sonnet-20241022-v2:0" })).toMatchObject({ type: "response.error" });
    // A control character never reaches the gateway.
    const bad = await handle({ type: "session.set_model", id: "m3", sessionId, model: "x\r\nX-Injected: 1" });
    expect(bad).toMatchObject({ type: "response.error" });
    expect(String(bad.error)).toContain("isn't a model id");
    await handle({ type: "endpoints.remove", id: "r", name: "gw" });
    const gone = await handle({ type: "session.set_model", id: "m4", sessionId, model: "anything" });
    expect(gone).toMatchObject({ type: "response.error" });
    expect(String(gone.error)).toContain("no longer exists");
  });
});

describe("a session's agent label", () => {
  test("names its backend, without the vendor in parentheses: Claude sessions read as before", () => {
    expect(backendLabel({ id: "claude", displayName: "Claude (Anthropic)" })).toBe("Claude");
    expect(backendLabel({ id: "codex", displayName: "Codex (OpenAI)" })).toBe("Codex");
    expect(backendLabel({ id: "qwen", displayName: "Qwen Code (Alibaba)" })).toBe("Qwen Code");
    expect(backendLabel({ id: "oai:box", displayName: "GPU box" })).toBe("GPU box");
    expect(backendLabel({ id: "oai:rakuten-oss", displayName: "rakuten-oss" })).toBe("rakuten-oss");
    expect(backendLabel({ id: "opencode", displayName: "" })).toBe("opencode");
    // An endpoint's display name is the user's own words: kept whole.
    expect(backendLabel({ id: "oai:rakuten", displayName: "Rakuten (internal)" })).toBe("Rakuten (internal)");
    expect(backendLabel({ id: "oai:rakuten", displayName: "" })).toBe("rakuten");
  });
});

describe("a model pick on an endpoint (round-1 audit of #468)", () => {
  const listed = [
    { value: "conf-a", displayName: "Conf A" },
    { value: "claude-sonnet-4-5", displayName: "Claude via gateway" },
  ];
  test("a model the endpoint lists is taken, Claude-shaped or not, by id or display name", () => {
    expect(resolveOnEndpoint("conf-a", listed, "oai:gw")).toBe("conf-a");
    expect(resolveOnEndpoint("conf a", listed, "oai:gw")).toBe("conf-a");
    expect(resolveOnEndpoint("claude-sonnet-4-5", listed, "oai:gw")).toBe("claude-sonnet-4-5");
  });
  test("a Claude model it doesn't list is refused, in Claude's, Bedrock's and alias forms; any other id passes", () => {
    for (const id of ["claude-opus-4-1", "opus", "us.anthropic.claude-3-5-sonnet-20241022-v2:0", "anthropic.claude-3-haiku-20240307-v1:0"]) {
      expect([id, resolveOnEndpoint(id, listed, "oai:gw")]).toEqual([id, null]);
    }
    expect(resolveOnEndpoint("org/model:tag", listed, "oai:gw")).toBe("org/model:tag");
    expect(resolveOnEndpoint("  deepseek-v4  ", [], "oai:gw")).toBe("deepseek-v4");
  });
  test("an id the endpoint store wouldn't accept is refused: empty, over 256 characters, control characters", () => {
    for (const id of ["", "   ", "x".repeat(257), "a\nb", "a\rb", "a\u0000b", "a\u007fb"]) {
      expect([JSON.stringify(id), resolveOnEndpoint(id, [], "oai:gw")]).toEqual([JSON.stringify(id), null]);
    }
  });
});
