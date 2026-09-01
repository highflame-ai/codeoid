import { describe, test, expect } from "bun:test";
import {
  translateQwenMessage,
  resolveQwenAuthType,
  normalizeModelCatalog,
  fetchOpenAiModelCatalog,
  unionCatalogs,
  extractToolResultText,
  coerceBackingId,
  type QwenTranslateState,
} from "../daemon/providers/qwen/index.js";
import { buildQwenEnv } from "../daemon/providers/env.js";
import { resolveQwenBaseUrl, QWEN_BASE_URL_PRESETS } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";

function collector(): { events: ProviderEvent[]; emit: (e: ProviderEvent) => void } {
  const events: ProviderEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function freshState(): QwenTranslateState {
  return { pendingTools: [], seenSubagents: new Set() };
}

describe("buildQwenEnv (GHSA-38vh vector 3, merge semantics)", () => {
  // @qwen-code/sdk spawns with {...process.env, ...options.env}, so an
  // allowlist alone leaks everything it omits. Blanking is the actual control.
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    OPENAI_API_KEY: "sk-real",
    OPENAI_BASE_URL: "https://gateway/v1",
    QWEN_HOME: "/home/u/.qwen",
    DASHSCOPE_API_KEY: "dash",
    CODEOID_API_KEY: "zid_sk_ROOT",
    TELEGRAM_BOT_TOKEN: "bot-secret",
    ZEROID_URL: "highflame",
    SOME_OTHER_SECRET: "nope",
  };

  test("passes through the qwen credential namespaces", () => {
    const env = buildQwenEnv(base);
    expect(env.OPENAI_API_KEY).toBe("sk-real");
    expect(env.OPENAI_BASE_URL).toBe("https://gateway/v1");
    expect(env.QWEN_HOME).toBe("/home/u/.qwen");
    expect(env.DASHSCOPE_API_KEY).toBe("dash");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
  });

  test("BLANKS daemon secrets rather than merely omitting them", () => {
    const env = buildQwenEnv(base);
    // Present-but-empty is the point: an omitted key would survive the merge.
    for (const leaky of ["CODEOID_API_KEY", "TELEGRAM_BOT_TOKEN", "ZEROID_URL", "SOME_OTHER_SECRET"]) {
      expect(env[leaky]).toBe("");
    }
  });

  test("every base key is accounted for, so the merge cannot reintroduce one", () => {
    const env = buildQwenEnv(base);
    for (const k of Object.keys(base)) expect(k in env).toBe(true);
  });

  test("the root ZeroID key is denied even though it matches the _API_KEY suffix", () => {
    expect(buildQwenEnv(base).CODEOID_API_KEY).toBe("");
  });
});

describe("resolveQwenAuthType", () => {
  test("explicit config always wins", () => {
    expect(resolveQwenAuthType("openai", "/definitely/missing")).toBe("openai");
    expect(resolveQwenAuthType("qwen-oauth", "/definitely/missing")).toBe("qwen-oauth");
  });

  test("auto-detect prefers a subscription login on disk, else the key path", () => {
    expect(resolveQwenAuthType(undefined, "/definitely/missing")).toBe("openai");
    // Any file that exists stands in for ~/.qwen/oauth_creds.json.
    expect(resolveQwenAuthType(undefined, import.meta.path)).toBe("qwen-oauth");
  });
});

describe("coerceBackingId", () => {
  // query() throws SYNCHRONOUSLY on a non-UUID sessionId, which would escape
  // runTurn() and wedge the session rather than surfacing as a turn error.
  test("passes a real UUID through untouched", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(coerceBackingId(id, "sess")).toBe(id);
  });

  test("replaces a non-UUID backing id with a fresh UUID", () => {
    for (const bad of ["sess-e2e", "", "not-a-uuid", "1234"]) {
      const out = coerceBackingId(bad, "sess");
      expect(out).not.toBe(bad);
      expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });
});

describe("resolveQwenBaseUrl", () => {
  test("maps the plan-key gateway preset (a standard DashScope host 401s on sk-sp- keys)", () => {
    expect(resolveQwenBaseUrl("bailian-plan-intl")).toBe(
      QWEN_BASE_URL_PRESETS["bailian-plan-intl"],
    );
    expect(resolveQwenBaseUrl("bailian-plan-intl")).toContain("token-plan");
  });

  test("passes a full URL through and leaves undefined alone", () => {
    expect(resolveQwenBaseUrl("https://custom/v1")).toBe("https://custom/v1");
    expect(resolveQwenBaseUrl(undefined)).toBeUndefined();
  });
});

describe("translateQwenMessage — tool announcement + correlation", () => {
  test("a tool_use block announces tool_start carrying the REAL sdk id", () => {
    const { events, emit } = collector();
    const state = freshState();
    translateQwenMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_use", id: "call_abc", name: "write_file", input: { path: "a.txt" } },
          ],
        },
      } as never,
      emit,
      "qwen",
      state,
    );
    const start = events.find((e) => e.type === "tool_start");
    expect(start).toBeDefined();
    expect(start).toMatchObject({ sdkToolUseId: "call_abc", name: "write_file" });
    expect(state.pendingTools).toHaveLength(1);
    expect(state.pendingTools[0].gated).toBe(false);
  });

  test("a repeated tool_use id is not announced twice", () => {
    const { events, emit } = collector();
    const state = freshState();
    const msg = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "call_abc", name: "write_file", input: {} }] },
    } as never;
    translateQwenMessage(msg, emit, "qwen", state);
    translateQwenMessage(msg, emit, "qwen", state);
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
  });

  test("tool_result closes the call and drops it from the pending set", () => {
    const { events, emit } = collector();
    const state = freshState();
    translateQwenMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "call_abc", name: "write_file", input: {} }] },
      } as never,
      emit,
      "qwen",
      state,
    );
    translateQwenMessage(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call_abc", content: "wrote it" }],
        },
      } as never,
      emit,
      "qwen",
      state,
    );
    expect(events.at(-1)).toMatchObject({
      type: "tool_complete",
      sdkToolUseId: "call_abc",
      output: "wrote it",
      success: true,
    });
    expect(state.pendingTools).toHaveLength(0);
  });

  test("a failed tool_result reports success:false", () => {
    const { events, emit } = collector();
    translateQwenMessage(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "x", content: "boom", is_error: true },
          ],
        },
      } as never,
      emit,
      "qwen",
      freshState(),
    );
    expect(events.at(-1)).toMatchObject({ type: "tool_complete", success: false });
  });

  test("a result clears pending state so the next turn cannot mis-correlate", () => {
    const { emit } = collector();
    const state = freshState();
    translateQwenMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "stale", name: "write_file", input: {} }] },
      } as never,
      emit,
      "qwen",
      state,
    );
    expect(state.pendingTools).toHaveLength(1);
    translateQwenMessage({ type: "result", subtype: "success", usage: {} } as never, emit, "qwen", state);
    expect(state.pendingTools).toHaveLength(0);
  });
});

describe("translateQwenMessage — subagents (issue #82)", () => {
  test("subagent text is tagged with parentToolUseId and never read as primary", () => {
    const { events, emit } = collector();
    translateQwenMessage(
      {
        type: "assistant",
        parent_tool_use_id: "call_parent",
        message: { content: [{ type: "text", text: "from the subagent" }] },
      } as never,
      emit,
      "qwen",
      freshState(),
    );
    const text = events.find((e) => e.type === "text_done");
    expect(text).toMatchObject({ parentToolUseId: "call_parent" });
  });

  test("a first sighting of a parent id emits subagent_start exactly once", () => {
    const { events, emit } = collector();
    const state = freshState();
    const msg = {
      type: "assistant",
      parent_tool_use_id: "call_parent",
      message: { content: [{ type: "text", text: "hi" }] },
    } as never;
    translateQwenMessage(msg, emit, "qwen", state);
    translateQwenMessage(msg, emit, "qwen", state);
    expect(events.filter((e) => e.type === "subagent_start")).toHaveLength(1);
  });

  test("primary text carries a null parent", () => {
    const { events, emit } = collector();
    translateQwenMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "primary" }] },
      } as never,
      emit,
      "qwen",
      freshState(),
    );
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ parentToolUseId: null });
  });
});

describe("translateQwenMessage — streaming + result", () => {
  test("text and thinking deltas map to their codeoid events", () => {
    const { events, emit } = collector();
    const state = freshState();
    translateQwenMessage(
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } },
      } as never,
      emit,
      "qwen",
      state,
    );
    translateQwenMessage(
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hmm" } },
      } as never,
      emit,
      "qwen",
      state,
    );
    expect(events[0]).toMatchObject({ type: "text_delta", content: "hel" });
    expect(events[1]).toMatchObject({ type: "thinking_delta", content: "hmm", blockIndex: 1 });
  });

  test("result maps usage and marks errors", () => {
    const { events, emit } = collector();
    translateQwenMessage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1200,
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7 },
        modelUsage: { "qwen3.8-max": {} },
      } as never,
      emit,
      "qwen",
      freshState(),
    );
    expect(events.at(-1)).toMatchObject({
      type: "turn_done",
      result: {
        providerId: "qwen",
        model: "qwen3.8-max",
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 7,
        durationMs: 1200,
      },
    });
  });

  test("falls back to the requested model when the gateway omits modelUsage", () => {
    // Observed against the Bailian plan gateway: result carries usage but no
    // modelUsage, which would attribute every turn to "unknown".
    const { events, emit } = collector();
    translateQwenMessage(
      { type: "result", subtype: "success", usage: {} } as never,
      emit,
      "qwen",
      { ...freshState(), requestedModel: "qwen3.8-max" },
    );
    expect((events.at(-1) as { result: { model: string } }).result.model).toBe("qwen3.8-max");
  });

  test("modelUsage still wins when the gateway does report it", () => {
    const { events, emit } = collector();
    translateQwenMessage(
      { type: "result", subtype: "success", usage: {}, modelUsage: { "glm-5.2": {} } } as never,
      emit,
      "qwen",
      { ...freshState(), requestedModel: "qwen3.8-max" },
    );
    expect((events.at(-1) as { result: { model: string } }).result.model).toBe("glm-5.2");
  });

  test("an errored result surfaces its message", () => {
    const { events, emit } = collector();
    translateQwenMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        usage: {},
        error: { message: "gateway exploded" },
      } as never,
      emit,
      "qwen",
      freshState(),
    );
    const done = events.at(-1) as Extract<ProviderEvent, { type: "turn_done" }>;
    expect(done.result.isError).toBe(true);
    expect(done.result.errorMessage).toBe("gateway exploded");
  });

  test("system init reports mounted MCP servers and their tools", () => {
    const { events, emit } = collector();
    translateQwenMessage(
      {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "codeoid_memory", status: "connected" }],
        tools: ["write_file", "mcp__codeoid_memory__recall"],
      } as never,
      emit,
      "qwen",
      freshState(),
    );
    expect(events.at(-1)).toMatchObject({
      type: "mcp_init",
      servers: { codeoid_memory: "connected" },
      tools: { codeoid_memory: ["mcp__codeoid_memory__recall"] },
    });
  });
});

describe("normalizeModelCatalog", () => {
  test("reads the observed availableModels shape", () => {
    expect(
      normalizeModelCatalog({
        availableModels: [
          { modelId: "qwen3.8-max", name: "Qwen3.8 Max", description: "flagship" },
        ],
      }),
    ).toEqual([{ id: "qwen3.8-max", displayName: "Qwen3.8 Max", description: "flagship" }]);
  });

  // The shape @qwen-code/sdk 0.1.8 actually returns: `models` (not
  // `availableModels`), `id` (not `modelId`), `label` (not `name`), and no
  // description. Reading only `name` left every entry displaying its raw id.
  test("reads the real sdk 0.1.8 shape — models[] with id + label", () => {
    expect(
      normalizeModelCatalog({
        subtype: "get_available_models",
        models: [
          { id: "qwen3.8-max", label: "Qwen 3.8 Max", capabilities: {}, contextWindowSize: 1000000 },
          { id: "glm-5.2", label: "GLM 5.2", capabilities: {}, contextWindowSize: 1000000 },
        ],
      }),
    ).toEqual([
      { id: "qwen3.8-max", displayName: "Qwen 3.8 Max" },
      { id: "glm-5.2", displayName: "GLM 5.2" },
    ]);
  });

  test("falls back to the id when no label or name is present", () => {
    expect(normalizeModelCatalog({ models: [{ id: "qwen3.8-flash" }] })).toEqual([
      { id: "qwen3.8-flash", displayName: "qwen3.8-flash" },
    ]);
  });

  test("tolerates bare arrays, strings, and junk without throwing", () => {
    expect(normalizeModelCatalog(["a"])).toEqual([{ id: "a", displayName: "a" }]);
    expect(normalizeModelCatalog(null)).toEqual([]);
    expect(normalizeModelCatalog({ nope: 1 })).toEqual([]);
    expect(normalizeModelCatalog([{ noId: true }])).toEqual([]);
  });
});

describe("fetchOpenAiModelCatalog", () => {
  function stubFetch(status: number, body: unknown): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      stubFetch.lastUrl = String(url);
      stubFetch.lastAuth = (init?.headers as Record<string, string>)?.Authorization;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => body,
      } as Response;
    }) as unknown as typeof fetch;
  }
  stubFetch.lastUrl = "";
  stubFetch.lastAuth = "";

  test("reads the OpenAI /models list shape", async () => {
    const f = stubFetch(200, {
      object: "list",
      data: [
        { id: "qwen3.8-max", object: "model", owned_by: "system" },
        { id: "glm-5.2", object: "model", owned_by: "system" },
      ],
    });
    expect(await fetchOpenAiModelCatalog("https://gw/v1", "sk-sp-x", f)).toEqual([
      { id: "qwen3.8-max", displayName: "qwen3.8-max" },
      { id: "glm-5.2", displayName: "glm-5.2" },
    ]);
    expect(stubFetch.lastUrl).toBe("https://gw/v1/models");
    expect(stubFetch.lastAuth).toBe("Bearer sk-sp-x");
  });

  test("strips trailing slashes off the base url", async () => {
    await fetchOpenAiModelCatalog("https://gw/v1//", "k", stubFetch(200, { data: [] }));
    expect(stubFetch.lastUrl).toBe("https://gw/v1/models");
  });

  test("throws on non-2xx so the caller can fall back to the registry", async () => {
    await expect(
      fetchOpenAiModelCatalog("https://gw/v1", "bad", stubFetch(401, {})),
    ).rejects.toThrow(/401/);
  });

  test("tolerates a missing or junk data array", async () => {
    expect(await fetchOpenAiModelCatalog("https://gw/v1", "k", stubFetch(200, {}))).toEqual([]);
    expect(
      await fetchOpenAiModelCatalog("https://gw/v1", "k", stubFetch(200, { data: [{ no: 1 }] })),
    ).toEqual([]);
  });
});

describe("unionCatalogs", () => {
  test("dedupes by id and keeps the entry that has a real label", () => {
    // /models returns bare ids; the qwen-code registry supplies labels.
    const live = [{ id: "qwen3.8-max", displayName: "qwen3.8-max" }, { id: "glm-5.2", displayName: "glm-5.2" }];
    const registry = [{ id: "qwen3.8-max", displayName: "Qwen 3.8 Max" }];
    expect(unionCatalogs(live, registry)).toEqual([
      { id: "qwen3.8-max", displayName: "Qwen 3.8 Max" },
      { id: "glm-5.2", displayName: "glm-5.2" },
    ]);
  });

  test("keeps registry-only models the gateway never reported", () => {
    // qwen-oauth's built-in `coder-model` has no /models endpoint behind it.
    expect(
      unionCatalogs([], [{ id: "coder-model", displayName: "coder-model" }]),
    ).toEqual([{ id: "coder-model", displayName: "coder-model" }]);
  });

  test("preserves primary ordering", () => {
    expect(
      unionCatalogs(
        [{ id: "a", displayName: "a" }, { id: "b", displayName: "b" }],
        [{ id: "b", displayName: "B!" }, { id: "c", displayName: "c" }],
      ).map((m) => m.id),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("extractToolResultText", () => {
  test("handles strings, block arrays, and images", () => {
    expect(extractToolResultText("plain")).toBe("plain");
    expect(extractToolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(extractToolResultText([{ type: "image" }])).toBe("[image]");
    expect(extractToolResultText(undefined)).toBe("");
  });
});
