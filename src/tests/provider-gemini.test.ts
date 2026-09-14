/**
 * GeminiProvider unit tests — offline, no Google API calls.
 *
 * mock.module() replaces @google/generative-ai with a controllable in-process
 * implementation so the full streaming path runs without credentials.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import type { ProviderEvent, TurnOpts, UiRequest } from "../daemon/providers/interface.js";

// ── Google AI mock ────────────────────────────────────────────────────────────

type StreamChunk = { text: () => string };
type ToolCall = { name: string; args: Record<string, unknown> };
type Round = { chunks: StreamChunk[]; calls: ToolCall[] };

let streamChunks: StreamChunk[] = [];
let streamError: Error | null = null;
let usageMetadata: Record<string, unknown> = {};
let finishReason: string | undefined;
/** When set, drives a multi-round tool-loop: each sendMessageStream shifts one
 *  round (its text chunks + the functionCalls it returns). */
let roundScript: Round[] | null = null;
/** Every message sent to sendMessageStream — inspect the functionResponse parts. */
const sentMessages: unknown[] = [];

function makeStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  const err = streamError;
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<StreamChunk>> {
          if (err) throw err;
          if (i >= chunks.length) return { done: true as const, value: undefined };
          return { done: false as const, value: chunks[i++] };
        },
      };
    },
  };
}

mock.module("@google/generative-ai", () => ({
  SchemaType: { OBJECT: "object", STRING: "string", INTEGER: "integer", BOOLEAN: "boolean" },
  GoogleGenerativeAI: class {
    getGenerativeModel(_opts: unknown) {
      return {
        startChat(_chatOpts: unknown) {
          return {
            sendMessageStream: async (msg: unknown, _reqOpts: unknown) => {
              sentMessages.push(msg);
              if (roundScript) {
                const round = roundScript.shift() ?? { chunks: [], calls: [] };
                return {
                  stream: makeStream(round.chunks),
                  response: Promise.resolve({
                    usageMetadata,
                    candidates: [{ finishReason: "STOP" }],
                    functionCalls: () => round.calls,
                  }),
                };
              }
              return {
                stream: makeStream([...streamChunks]),
                response: Promise.resolve({
                  usageMetadata,
                  candidates: finishReason ? [{ finishReason }] : [],
                  functionCalls: () => [],
                }),
              };
            },
          };
        },
      };
    }
  },
}));

import { GeminiProvider } from "../daemon/providers/gemini/index.js";
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
  provider: GeminiProvider,
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

describe("GeminiProvider – no-key path", () => {
  it("emits error event when GOOGLE_API_KEY is not set", async () => {
    const provider = new GeminiProvider({ apiKey: "" });
    const events = await runProvider(provider);
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("GOOGLE_API_KEY") });
  });
});

describe("GeminiProvider – streaming", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    usageMetadata = {};
    finishReason = undefined;
    roundScript = null;
    sentMessages.length = 0;
  });

  it("emits text_delta + text_done + turn_done for a normal response", async () => {
    streamChunks = [{ text: () => "Hello " }, { text: () => "world" }];
    usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5 };
    finishReason = "STOP";

    const provider = new GeminiProvider({ apiKey: "fake-key" });
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
        providerId: "gemini",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        stopReason: "STOP",
      },
    });
  });

  it("emits error event when the stream throws", async () => {
    streamError = new Error("quota exceeded");
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("handles chunks with empty text (skips them)", async () => {
    streamChunks = [{ text: () => "" }, { text: () => "content" }];
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    const events = await runProvider(provider);
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ content: "content" });
  });

  it("interrupt aborts the turn", async () => {
    // Provide no chunks — the stream would stall
    streamChunks = [];
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    const events: ProviderEvent[] = [];
    const run = provider.runTurn({
      history: [],
      userMessage: "hi",
      workdir: "/tmp",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    // Interrupt immediately
    await run.interrupt();
    for await (const e of run.events) {
      events.push(e);
    }
    // After abort the queue is closed — no events or just what arrived before close
    expect(events.length).toBeLessThanOrEqual(1);
  });
});

describe("GeminiProvider – memory tool-loop (#178 Phase 5)", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    usageMetadata = {};
    finishReason = undefined;
    roundScript = null;
    sentMessages.length = 0;
  });

  it("supportsMemoryTools reflects whether a memory engine is wired", async () => {
    expect(new GeminiProvider({ apiKey: "k" }).supportsMemoryTools).toBe(false);
    const engine = await memoryWithEpisode();
    expect(new GeminiProvider({ apiKey: "k", memory: engine, workspaceId: "wsA", sessionId: "s1" }).supportsMemoryTools).toBe(true);
    await engine.close();
  });

  it("pages memory: functionCall round → executes recall → functionResponse → final text", async () => {
    const engine = await memoryWithEpisode();
    // Round 1: model asks for recall. Round 2: model answers using the result.
    roundScript = [
      { chunks: [], calls: [{ name: "codeoid_memory__recall", args: { query: "vault passphrase" } }] },
      { chunks: [{ text: () => "It is CRIMSON-OTTER." }], calls: [] },
    ];
    const provider = new GeminiProvider({ apiKey: "k", memory: engine, workspaceId: "wsA", sessionId: "sNew" });
    const events = await runProvider(provider, "what was the vault passphrase?");

    // The memory tool ran through the gate and produced verbatim content.
    const start = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }>;
    const done = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }>;
    expect(start.name).toBe("codeoid_memory__recall");
    expect(done.success).toBe(true);
    expect(done.output).toContain("CRIMSON-OTTER");
    // The final answer is round 2's text.
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ content: "It is CRIMSON-OTTER." });
    // Round 2 replied with a functionResponse part (not a plain string).
    const second = sentMessages[1] as Array<{ functionResponse?: { name: string } }>;
    expect(Array.isArray(second)).toBe(true);
    expect(second[0]?.functionResponse?.name).toBe("codeoid_memory__recall");
    await engine.close();
  });
});

describe("GeminiProvider – listModels", () => {
  it("returns a static list of well-known Gemini models", async () => {
    const provider = new GeminiProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith("gemini"))).toBe(true);
  });
});

describe("GeminiProvider – dispose", () => {
  it("dispose() resolves without throwing (stateless provider)", async () => {
    const provider = new GeminiProvider({ apiKey: "fake-key" });
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});

describe("GeminiProvider – ask-user tool (#178)", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = null;
    usageMetadata = {};
    finishReason = undefined;
    roundScript = null;
    sentMessages.length = 0;
  });

  it("offers ask_user when requestUserInput is available and routes the answer back", async () => {
    roundScript = [
      { chunks: [], calls: [{ name: "ask_user", args: { question: "Deploy where?", options: ["staging", "prod"] } }] },
      { chunks: [{ text: () => "Deploying to prod." }], calls: [] },
    ];
    const seen: UiRequest[] = [];
    const provider = new GeminiProvider({ apiKey: "k" });
    const events = await runProvider(provider, "deploy", {
      requestUserInput: async (req) => {
        seen.push(req);
        return { value: "prod", cancelled: false };
      },
    });
    expect(seen[0]?.method).toBe("select");
    expect(seen[0]?.options).toEqual(["staging", "prod"]);
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ content: "Deploying to prod." });
    // Round 2 replied with a functionResponse for ask_user carrying the answer.
    const second = sentMessages[1] as Array<{ functionResponse?: { name: string; response: { result: string } } }>;
    expect(second[0]?.functionResponse?.name).toBe("ask_user");
    expect(second[0]?.functionResponse?.response.result).toBe("prod");
  });
});
