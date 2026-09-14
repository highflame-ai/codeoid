/**
 * OpenAIProvider unit tests — offline, no OpenAI API calls.
 *
 * mock.module() replaces the openai package with a controllable in-process
 * implementation so the full streaming path runs without credentials.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import type { ProviderEvent, TurnOpts, UiRequest } from "../daemon/providers/interface.js";

// ── OpenAI mock ───────────────────────────────────────────────────────────────

type ToolCallDelta = { index: number; id?: string; function?: { name?: string; arguments?: string } };
type CompletionChunk = {
  choices: Array<{ delta?: { content?: string | null; tool_calls?: ToolCallDelta[] }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};
type ModelItem = { id: string };

let streamChunks: CompletionChunk[] = [];
let streamError: Error | null = null;
let modelsResult: ModelItem[] | Error = [];
/** When set, drives a multi-round tool-loop: each create() shifts one round. */
let roundScript: CompletionChunk[][] | null = null;
/** Every request body passed to create() — inspect tools + tool result messages. */
const sentBodies: Array<Record<string, unknown>> = [];

function streamFrom(chunks: CompletionChunk[]): AsyncIterable<CompletionChunk> {
  const err = streamError;
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<CompletionChunk>> {
          if (err) throw err;
          if (i >= chunks.length) return { done: true as const, value: undefined };
          return { done: false as const, value: chunks[i++] };
        },
      };
    },
  };
}

mock.module("openai", () => {
  return {
    default: class OpenAI {
      chat = {
        completions: {
          create: async (body: Record<string, unknown>, _opts: unknown) => {
            sentBodies.push(body);
            if (roundScript) return streamFrom(roundScript.shift() ?? []);
            return streamFrom([...streamChunks]);
          },
        },
      };
      models = {
        list: async () => {
          if (modelsResult instanceof Error) throw modelsResult;
          return { data: modelsResult };
        },
      };
    },
  };
});

import { OpenAIProvider } from "../daemon/providers/openai/index.js";
import { MemoryEngine } from "@highflame/codeoid-memory/engine.js";
import { SqliteEpisodeStore } from "@highflame/codeoid-memory/store.js";
import type { Embedder } from "@highflame/codeoid-memory/embedder.js";

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (const ch of t.toLowerCase()) { const c = ch.charCodeAt(0); if (c >= 97 && c <= 122) v[(c - 97) % 8]! += 1; }
      return v;
    });
  }
  async close(): Promise<void> {}
}

async function memoryWithEpisode(): Promise<MemoryEngine> {
  const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await engine.init();
  engine.ingest({
    workspaceId: "wsA", sessionId: "sOld", kind: "user_turn", summary: "vault", content: "the vault passphrase is CRIMSON-OTTER",
    filePaths: [], tokenEstimate: 4, createdAt: 1_000_000, createdBy: "test",
  });
  await engine.drain();
  return engine;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runProvider(
  provider: OpenAIProvider,
  userMessage = "hello",
  extra: Partial<TurnOpts> = {},
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const run = provider.runTurn({
    history: [],
    userMessage,
    workdir: "/tmp",
    canUseTool: async () => ({ behavior: "allow" as const }),
    ...extra,
  });
  for await (const e of run.events) {
    events.push(e);
  }
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OpenAIProvider – streaming", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    modelsResult = [];
    roundScript = null;
    sentBodies.length = 0;
  });

  it("emits text_delta + text_done + turn_done for a normal response", async () => {
    streamChunks = [
      { choices: [{ delta: { content: "Hello " } }] },
      { choices: [{ delta: { content: "world" }, finish_reason: "stop" }] },
      { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ content: "Hello " });
    expect(deltas[1]).toMatchObject({ content: "world" });

    const done = events.find((e) => e.type === "text_done");
    expect(done).toMatchObject({ content: "Hello world" });

    const turnDone = events.find((e) => e.type === "turn_done");
    expect(turnDone).toMatchObject({
      type: "turn_done",
      result: {
        providerId: "openai",
        inputTokens: 10,
        outputTokens: 5,
        stopReason: "stop",
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
      },
    });
  });

  it("emits error event when the stream throws", async () => {
    streamError = new Error("rate limit exceeded");
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);
    expect(events.some((e) => e.type === "error")).toBe(true);
    const err = events.find((e) => e.type === "error") as { message?: string } | undefined;
    expect(err?.message).toContain("rate limit exceeded");
  });

  it("includes systemPromptAppend as a system message when provided", async () => {
    streamChunks = [
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    ];
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const events: ProviderEvent[] = [];
    const run = provider.runTurn({
      history: [],
      userMessage: "hello",
      workdir: "/tmp",
      systemPromptAppend: "You are a coding assistant.",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    for await (const e of run.events) events.push(e);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });

  it("interrupt aborts the turn", async () => {
    streamChunks = [];
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const run = provider.runTurn({
      history: [],
      userMessage: "hi",
      workdir: "/tmp",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    await run.interrupt();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.length).toBeLessThanOrEqual(1);
  });
});

describe("OpenAIProvider – listModels", () => {
  beforeEach(() => { modelsResult = []; });

  it("returns filtered GPT/o-series models from the API", async () => {
    modelsResult = [
      { id: "gpt-4o" },
      { id: "gpt-4o-mini" },
      { id: "o3-mini" },
      { id: "text-embedding-ada-002" }, // filtered out
    ];
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini", "o3-mini"]);
  });

  it("returns static fallback list when the API throws", async () => {
    modelsResult = new Error("forbidden");
    const provider = new OpenAIProvider({ apiKey: "bad-key" });
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.length > 0)).toBe(true);
  });
});

describe("OpenAIProvider – dispose", () => {
  it("dispose() resolves without throwing (stateless provider)", async () => {
    const provider = new OpenAIProvider({ apiKey: "fake-key" });
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});

describe("OpenAIProvider – memory tool-loop (#178 Phase 5)", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    modelsResult = [];
    roundScript = null;
    sentBodies.length = 0;
  });

  it("supportsMemoryTools reflects whether a memory engine is wired", async () => {
    expect(new OpenAIProvider({ apiKey: "k" }).supportsMemoryTools).toBe(false);
    const engine = await memoryWithEpisode();
    expect(new OpenAIProvider({ apiKey: "k", memory: engine, workspaceId: "wsA", sessionId: "s1" }).supportsMemoryTools).toBe(true);
    await engine.close();
  });

  it("offers tools, pages memory on a tool_calls round, loops to a final answer", async () => {
    const engine = await memoryWithEpisode();
    // Round 1: the model emits a tool_call (streamed as indexed deltas) and
    // finishes with "tool_calls". Round 2: it answers using the tool result.
    roundScript = [
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "codeoid_memory__recall", arguments: '{"query":"vault' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' passphrase"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [{}], usage: { prompt_tokens: 20, completion_tokens: 4 } },
      ],
      [
        { choices: [{ delta: { content: "It is CRIMSON-OTTER." }, finish_reason: "stop" }] },
        { choices: [{}], usage: { prompt_tokens: 30, completion_tokens: 6 } },
      ],
    ];
    const provider = new OpenAIProvider({ apiKey: "k", memory: engine, workspaceId: "wsA", sessionId: "sNew" });
    const events = await runProvider(provider, "what was the vault passphrase?");

    // The recall tool ran through the gate with verbatim content.
    const start = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }>;
    const done = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }>;
    expect(start.name).toBe("codeoid_memory__recall");
    expect(done.success).toBe(true);
    expect(done.output).toContain("CRIMSON-OTTER");
    // The final answer is round 2's text; usage summed across rounds.
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ content: "It is CRIMSON-OTTER." });
    expect(events.find((e) => e.type === "turn_done")).toMatchObject({ result: { inputTokens: 50, outputTokens: 10 } });

    // Round 1 offered tools; round 2's request carried the assistant tool_calls
    // turn + the tool result message.
    expect(sentBodies[0]?.tools).toBeDefined();
    const round2Messages = sentBodies[1]?.messages as Array<{ role: string; tool_call_id?: string }>;
    expect(round2Messages.some((m) => m.role === "assistant")).toBe(true);
    expect(round2Messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
    await engine.close();
  });

  it("does NOT offer tools when no memory engine is wired (unchanged single-call path)", async () => {
    streamChunks = [{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }];
    const provider = new OpenAIProvider({ apiKey: "k" });
    await runProvider(provider);
    expect(sentBodies[0]?.tools).toBeUndefined();
  });
});

describe("OpenAIProvider – ask-user tool (#178)", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    modelsResult = [];
    roundScript = null;
    sentBodies.length = 0;
  });

  it("offers ask_user when requestUserInput is available and routes the answer back", async () => {
    roundScript = [
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ask_user", arguments: '{"question":"Deploy where?","options":["staging","prod"]}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ],
      [
        { choices: [{ delta: { content: "Deploying to prod." }, finish_reason: "stop" }] },
        { choices: [{}], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ],
    ];
    const seen: UiRequest[] = [];
    const provider = new OpenAIProvider({ apiKey: "k" });
    const events = await runProvider(provider, "deploy", {
      requestUserInput: async (req) => {
        seen.push(req);
        return { value: "prod", cancelled: false };
      },
    });
    expect(seen[0]?.method).toBe("select");
    expect(seen[0]?.options).toEqual(["staging", "prod"]);
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ content: "Deploying to prod." });
    // ask_user was offered as a tool, and round 2 carried the answer as a tool result.
    const offered = sentBodies[0]?.tools as Array<{ function: { name: string } }> | undefined;
    expect(offered?.some((t) => t.function.name === "ask_user")).toBe(true);
    const r2 = sentBodies[1]?.messages as Array<{ role: string; content?: string }>;
    expect(r2.some((m) => m.role === "tool" && m.content === "prod")).toBe(true);
  });
});
