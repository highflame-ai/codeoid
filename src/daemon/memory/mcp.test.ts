import { describe, test, expect } from "bun:test";
import { SqliteEpisodeStore } from "./store";
import { MemoryEngine } from "./engine";
import { buildMemoryMcpServer } from "./mcp";
import { MEMORY_MCP_SERVER_NAME } from "./mcp-http";
import { MEMORY_TOOL_NAMES } from "./tools";
import { isSafeTool } from "../providers/tool-safety";
import type { Embedder } from "./embedder";

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions));
  }
  async close(): Promise<void> {}
}

describe("buildMemoryMcpServer (thin adapter over the registry)", () => {
  test("builds an in-process SDK MCP server from the shared defs", async () => {
    const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
    await engine.init();
    const server = buildMemoryMcpServer(engine, { workspaceId: "ws", sessionId: "s1" });
    // The adapter enumerates memoryToolDefs() into SDK tool()s under one server;
    // asserting the config shape exercises the whole adapter path without
    // depending on SDK internals.
    expect(server.type).toBe("sdk");
    expect(server.instance).toBeDefined();
  });

  test("names the server with the canonical constant, not a literal", async () => {
    // Regression: this asserted the literal "codeoid-memory" while every mount
    // key and `isSafeTool` prefix derives from MEMORY_MCP_SERVER_NAME
    // ("codeoid_memory"). Backends disagree about which of the two they
    // namespace tools by — Claude uses the map key, qwen-code the instance
    // name — so the divergence silently produced `mcp__codeoid-memory__*` on
    // qwen, matching neither the allowedTools grant nor the safe-tool prefixes,
    // and the read-only recall tools prompted on every call. Asserting against
    // the constant (not a literal) is what keeps them from drifting apart again.
    const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
    await engine.init();
    const server = buildMemoryMcpServer(engine, { workspaceId: "ws", sessionId: "s1" });
    expect(server.name).toBe(MEMORY_MCP_SERVER_NAME);
    // And the tools that name produces must be auto-approvable.
    for (const t of MEMORY_TOOL_NAMES) {
      expect(isSafeTool(`mcp__${server.name}__${t}`)).toBe(true);
    }
  });
});
