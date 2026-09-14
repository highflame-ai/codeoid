import { describe, test, expect } from "bun:test";
import {
  ASK_USER_TOOL_NAME,
  askUserToolAsGemini,
  askUserToolAsOpenAI,
  executeAskUserCall,
  executeMemoryToolCall,
  memoryToolsAsGemini,
  memoryToolsAsOpenAI,
  namespacedMemoryToolName,
  MAX_MEMORY_TOOL_ROUNDS,
} from "../daemon/providers/tool-loop.js";
import { MemoryEngine } from "@highflame/codeoid-memory/engine.js";
import { SqliteEpisodeStore } from "@highflame/codeoid-memory/store.js";
import { MEMORY_TOOL_NAMES } from "@highflame/codeoid-memory/tools.js";
import type { Embedder } from "@highflame/codeoid-memory/embedder.js";
import type { Episode } from "@highflame/codeoid-memory/types.js";
import type { ProviderEvent, UiRequest, UiResponse } from "../daemon/providers/interface.js";

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (const ch of t.toLowerCase()) {
        const c = ch.charCodeAt(0);
        if (c >= 97 && c <= 122) v[(c - 97) % this.dimensions]! += 1;
      }
      return v;
    });
  }
  async close(): Promise<void> {}
}

async function engineWith(): Promise<MemoryEngine> {
  const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await engine.init();
  const ep = (summary: string, content: string): Omit<Episode, "id"> => ({
    workspaceId: "wsA", sessionId: "sOther", kind: "user_turn", summary, content,
    filePaths: [], tokenEstimate: 4, createdAt: 1_000_000, createdBy: "test",
  });
  engine.ingest(ep("alpha", "alpha unicorn deployment"));
  await engine.drain();
  return engine;
}

function deps(engine: MemoryEngine, gate: "allow" | "deny" = "allow") {
  const events: ProviderEvent[] = [];
  return {
    events,
    d: {
      ctx: { engine, workspaceId: "wsA", sessionId: "sCaller" },
      canUseTool: async () => ({ behavior: gate }),
      emit: (e: ProviderEvent) => events.push(e),
    },
  };
}

describe("tool-loop declarations", () => {
  test("openai tools are namespaced function tools carrying each def's schema", () => {
    const tools = memoryToolsAsOpenAI();
    expect(tools.map((t) => t.function.name).sort()).toEqual(
      [...MEMORY_TOOL_NAMES].map((n) => `codeoid_memory__${n}`).sort(),
    );
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect((t.function.parameters as { type: string }).type).toBe("object");
    }
  });

  test("gemini functionDeclarations are namespaced and strip additionalProperties", () => {
    const decls = memoryToolsAsGemini();
    expect(decls.map((d) => d.name).sort()).toEqual(
      [...MEMORY_TOOL_NAMES].map((n) => `codeoid_memory__${n}`).sort(),
    );
    for (const d of decls) {
      expect(d.parameters).not.toHaveProperty("additionalProperties");
      expect((d.parameters as { type: string }).type).toBe("object");
    }
  });
});

describe("executeMemoryToolCall", () => {
  test("runs a namespaced tool, emits tool_start + tool_complete(success), returns verbatim text", async () => {
    const engine = await engineWith();
    const { events, d } = deps(engine);
    const out = await executeMemoryToolCall(namespacedMemoryToolName("recall"), { query: "unicorn deployment" }, d);
    expect(out).toContain("alpha unicorn deployment");
    const start = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }>;
    const done = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }>;
    expect(start.name).toBe("codeoid_memory__recall");
    expect(done.success).toBe(true);
    expect(done.output).toContain("alpha unicorn deployment");
    await engine.close();
  });

  test("accepts a bare (un-namespaced) tool name too", async () => {
    const engine = await engineWith();
    const { d } = deps(engine);
    const out = await executeMemoryToolCall("recall", { query: "unicorn" }, d);
    expect(out).toContain("alpha unicorn deployment");
    await engine.close();
  });

  test("a denied call does NOT run the tool and returns the denial message", async () => {
    const engine = await engineWith();
    const { events, d } = deps(engine, "deny");
    const out = await executeMemoryToolCall("codeoid_memory__recall", { query: "unicorn" }, d);
    expect(out).toMatch(/denied/i);
    const done = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }>;
    expect(done.success).toBe(false);
    await engine.close();
  });

  test("an unknown tool returns an error result (never throws), tool_complete failed", async () => {
    const engine = await engineWith();
    const { events, d } = deps(engine);
    const out = await executeMemoryToolCall("codeoid_memory__drop_all", {}, d);
    expect(out).toContain("Unknown tool");
    const done = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }>;
    expect(done.success).toBe(false);
    await engine.close();
  });

  test("round cap is a small positive guard", () => {
    expect(MAX_MEMORY_TOOL_ROUNDS).toBeGreaterThan(0);
    expect(MAX_MEMORY_TOOL_ROUNDS).toBeLessThanOrEqual(16);
  });
});

describe("ask-user tool", () => {
  test("declarations: named ask_user with a required question, options optional", () => {
    const o = askUserToolAsOpenAI();
    expect(o.type).toBe("function");
    expect(o.function.name).toBe(ASK_USER_TOOL_NAME);
    expect((o.function.parameters as { required: string[] }).required).toEqual(["question"]);
    const g = askUserToolAsGemini();
    expect(g.name).toBe(ASK_USER_TOOL_NAME);
    // Gemini schema must not carry additionalProperties.
    expect(g.parameters).not.toHaveProperty("additionalProperties");
  });

  test("with options → select dialog; returns the picked value", async () => {
    const seen: UiRequest[] = [];
    const events: ProviderEvent[] = [];
    const out = await executeAskUserCall(
      { question: "Deploy where?", options: ["staging", "prod"] },
      {
        requestUserInput: async (req: UiRequest): Promise<UiResponse> => {
          seen.push(req);
          return { value: "prod", cancelled: false };
        },
        emit: (e) => events.push(e),
      },
    );
    expect(out).toBe("prod");
    expect(seen[0]!.method).toBe("select");
    expect(seen[0]!.options).toEqual(["staging", "prod"]);
    expect(seen[0]!.title).toBe("Deploy where?");
    // Emits tool_start + tool_complete(success) — but does NOT gate (no canUseTool).
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ name: ASK_USER_TOOL_NAME });
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: true, output: "prod" });
  });

  test("without options → free-text input dialog", async () => {
    let method = "";
    const out = await executeAskUserCall(
      { question: "Your name?" },
      {
        requestUserInput: async (req) => {
          method = req.method;
          return { value: "Ada", cancelled: false };
        },
        emit: () => {},
      },
    );
    expect(method).toBe("input");
    expect(out).toBe("Ada");
  });

  test("a dismissed dialog returns a 'no answer' string (never throws), tool_complete failed", async () => {
    const events: ProviderEvent[] = [];
    const out = await executeAskUserCall(
      { question: "Proceed?" },
      { requestUserInput: async () => ({ cancelled: true }), emit: (e) => events.push(e) },
    );
    expect(out).toMatch(/dismissed|no answer|without answering/i);
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: false });
  });
});
