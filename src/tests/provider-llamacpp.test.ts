import { describe, expect, it } from "bun:test";
import { allowedMcpServers, createLlamaCppProvider, isOwnServer, fetchServerContextWindow, llamaCppTools, propsUrl, strictJsonSchema } from "../daemon/providers/llamacpp/index.js";
import type { ProviderEvent, TurnOpts } from "../daemon/providers/interface.js";
import { targetContextWindow } from "../daemon/providers/context-windows.js";

const respond = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("llama.cpp provider", () => {
  it("finds /props beside the OpenAI routes, whatever the base URL's trailing shape", () => {
    expect(propsUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/props");
    expect(propsUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/props");
    expect(propsUrl("http://gpu-box:8080")).toBe("http://gpu-box:8080/props");
  });

  it("reads the per-request window from /props", async () => {
    // The shape llama-server b6310 returns: n_ctx is per slot, which is what one
    // request's prompt has to fit in.
    const props = { default_generation_settings: { n_ctx: 16_384 }, total_slots: 1 };
    expect(await fetchServerContextWindow("http://x/v1", respond(props))).toBe(16_384);
  });

  it("reports no window from a server that doesn't publish one", async () => {
    expect(await fetchServerContextWindow("http://x/v1", respond({}))).toBeUndefined();
    expect(await fetchServerContextWindow("http://x/v1", respond({ default_generation_settings: { n_ctx: 0 } }))).toBeUndefined();
    expect(await fetchServerContextWindow("http://x/v1", respond({}, 404))).toBeUndefined();
  });

  it("sizes a seed before the first turn for llama-server's default context, not a cloud model's", () => {
    // A fork or switch into llamacpp seeds history before the server has
    // reported anything; the 128k fallback would overflow a default server.
    expect(targetContextWindow("llamacpp", null)).toBe(4_096);
    expect(targetContextWindow("llamacpp", "local")).toBe(4_096);
  });
});

describe("llama.cpp tool schemas", () => {
  it("spells out 'any value' for an untyped parameter, keeping its description", () => {
    // The real shape that failed every turn: an MCP tool parameter with only a
    // description, which llama.cpp's grammar compiler rejects with a 500.
    const schema = {
      type: "object",
      properties: { value: { description: "Any JSON value is accepted; use null to clear the field." } },
    };
    expect(strictJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        value: {
          description: "Any JSON value is accepted; use null to clear the field.",
          type: ["string", "number", "integer", "boolean", "object", "array", "null"],
        },
      },
    });
  });

  it("reaches untyped schemas nested in arrays, unions and definitions", () => {
    const out = strictJsonSchema({
      type: "object",
      properties: {
        list: { type: "array", items: { title: "x" } },
        either: { anyOf: [{ type: "string" }, { description: "other" }] },
      },
      $defs: { Loose: { description: "loose" } },
    }) as Record<string, any>;
    expect(out.properties.list.items.type).toContain("null");
    expect(out.properties.either.anyOf[0]).toEqual({ type: "string" });
    expect(out.properties.either.anyOf[1].type).toContain("object");
    expect(out.$defs.Loose.type).toContain("string");
  });

  it("leaves constrained and empty schemas as they are", () => {
    const typed = { type: "object", properties: { n: { type: "integer", description: "count" }, e: { enum: ["a"] } } };
    expect(strictJsonSchema(typed)).toEqual(typed);
    expect(strictJsonSchema({})).toEqual({});
  });

  it("gives every tool a description and never mutates the shared definitions", () => {
    const tools = [{ type: "function" as const, function: { name: "mcp__x__set", description: "", parameters: { type: "object", properties: { v: { description: "d" } } } } }];
    const before = JSON.stringify(tools);
    const out = llamaCppTools(tools);
    expect(out[0]!.function.description).toBe("mcp__x__set");
    expect(JSON.stringify(tools)).toBe(before);
  });
});

describe("llama.cpp MCP servers", () => {
  const spec = (name: string) => ({ name }) as never;
  const registry = { forBackend: () => [spec("linear"), spec("github"), spec("slack")] };

  it("offers no external MCP server unless the backend opts in", () => {
    // A handful of servers' tool definitions overflowed a 32k local model in a
    // live run before the user typed a word.
    expect(allowedMcpServers(registry, [])).toBeUndefined();
    expect(allowedMcpServers(registry, undefined)).toBeUndefined();
  });

  it("offers exactly the servers named", () => {
    const view = allowedMcpServers(registry, ["github"])!;
    expect(view.forBackend("llamacpp").map((s) => (s as { name: string }).name)).toEqual(["github"]);
  });
});

describe("llama.cpp cost (#430)", () => {
  const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  /** An OpenAI-compatible server on this machine; `llamaServer` says whether it answers /props as llama-server. */
  async function turnOn(llamaServer: boolean, cfg: { free?: boolean } = {}): Promise<ProviderEvent | undefined> {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith("/props")) {
          return llamaServer ? Response.json({ default_generation_settings: { n_ctx: 4096 } }) : new Response("not found", { status: 404 });
        }
        const body = [
          sse({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
          sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
          "data: [DONE]\n\n",
        ].join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const provider = createLlamaCppProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "", ...cfg }, {});
      const run = provider.runTurn({ history: [], userMessage: "x", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" }) } as unknown as TurnOpts);
      const events: ProviderEvent[] = [];
      for await (const e of run.events) events.push(e);
      return events.find((e) => e.type === "turn_done");
    } finally {
      server.stop(true);
    }
  }

  it("a loopback server that isn't llama-server (a proxy to a paid API) isn't free unless you say so", async () => {
    expect(((await turnOn(false)) as { result: { costSource?: string } }).result.costSource).toBeUndefined();
    expect(await turnOn(false, { free: true })).toMatchObject({ result: { costSource: "free" } });
  });

  it("a turn on the user's own server costs nothing — not an unknown a spend cap would stop on", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith("/props")) return Response.json({ default_generation_settings: { n_ctx: 4096 } });
        const body = [
          sse({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
          sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
          "data: [DONE]\n\n",
        ].join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const provider = createLlamaCppProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "" }, {});
      const run = provider.runTurn({ history: [], userMessage: "x", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" }) } as unknown as TurnOpts);
      const events: ProviderEvent[] = [];
      for await (const e of run.events) events.push(e);
      expect(events.find((e) => e.type === "turn_done")).toMatchObject({ result: { costSource: "free", inputTokens: 12 } });
    } finally {
      server.stop(true);
    }
  });
});

describe("a llama.cpp server is free only when it's the user's own (#430)", () => {
  it("one on this machine is; one elsewhere only when you say so — it may be a gateway to a paid API", () => {
    expect(isOwnServer("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isOwnServer("http://localhost:8080/v1")).toBe(true);
    expect(isOwnServer("http://[::1]:8080/v1")).toBe(true);
    expect(isOwnServer("http://192.168.1.20:8080/v1")).toBe(false);
    expect(isOwnServer("http://litellm:4000/v1")).toBe(false);
    expect(isOwnServer("http://gpu-box:8080/v1", true)).toBe(true);
    expect(isOwnServer("http://127.0.0.1:8080/v1", false)).toBe(false);
    expect(isOwnServer("https://api.some-inference-host.com/v1")).toBe(false);
    expect(isOwnServer("not a url")).toBe(false);
  });
});
