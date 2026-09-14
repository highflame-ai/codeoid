import { describe, test, expect } from "bun:test";
import { SqliteEpisodeStore } from "./store";
import { MemoryEngine } from "./engine";
import { MemoryMcpHttp, MEMORY_MCP_PATH } from "./mcp-http";
import type { Embedder } from "./embedder";
import type { Episode } from "./types";

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

function ep(workspaceId: string, sessionId: string, summary: string, content: string, extra: Partial<Omit<Episode, "id">> = {}): Omit<Episode, "id"> {
  return {
    workspaceId, sessionId, kind: "user_turn", summary, content, filePaths: [],
    tokenEstimate: Math.ceil(content.length / 4), createdAt: 1_000_000, createdBy: "test", ...extra,
  };
}

async function setup(): Promise<{ endpoint: MemoryMcpHttp; engine: MemoryEngine; ids: Record<string, string> }> {
  const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await engine.init();
  const ids: Record<string, string> = {};
  ids.a1 = engine.ingest(ep("wsA", "sA1", "alpha", "alpha unicorn deployment")).id;
  ids.b1 = engine.ingest(ep("wsB", "sB1", "gamma", "gamma telescope migration")).id;
  await engine.drain();
  return { endpoint: new MemoryMcpHttp(engine), engine, ids };
}

function post(endpoint: MemoryMcpHttp, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return endpoint.handle(new Request(`http://daemon${MEMORY_MCP_PATH}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

const initMsg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

describe("MemoryMcpHttp", () => {
  test("fails closed: no token and unknown token both 401", async () => {
    const { endpoint } = await setup();
    expect((await post(endpoint, null, initMsg)).status).toBe(401);
    expect((await post(endpoint, "mmt_bogus", initMsg)).status).toBe(401);
  });

  test("GET is 405 (no server-initiated stream)", async () => {
    const { endpoint } = await setup();
    const res = await endpoint.handle(new Request(`http://daemon${MEMORY_MCP_PATH}`, { method: "GET" }));
    expect(res.status).toBe(405);
  });

  test("initialize echoes protocol version, advertises tools, sets Mcp-Session-Id", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    const res = await post(endpoint, token, initMsg);
    expect(res.status).toBe(200);
    expect(res.headers.get("Mcp-Session-Id")).toBe(token);
    const body = (await res.json()) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("codeoid-memory");
  });

  test("notifications/initialized → 202 with no body", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    const res = await post(endpoint, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("tools/list returns the four memory tools with JSON-Schema inputSchema", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    const res = await post(endpoint, token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(["get_episode", "recall", "recall_file", "timeline"]);
    for (const t of body.result.tools) expect(t.inputSchema.type).toBe("object");
  });

  test("tools/call recall runs under the token's tenant scope, returns verbatim content", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sOther" });
    const res = await post(endpoint, token, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "recall", arguments: { query: "unicorn deployment" } },
    });
    const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]!.text).toContain("alpha unicorn deployment");
  });

  test("tools/call get_episode is tenant-scoped by the token: wsA token cannot read a wsB episode", async () => {
    const { endpoint, ids } = await setup();
    const tokenA = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    const foreign = await post(endpoint, tokenA, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "get_episode", arguments: { episode_id: ids.b1 } },
    });
    const fbody = (await foreign.json()) as { result: { content: Array<{ text: string }> } };
    expect(fbody.result.content[0]!.text).toContain("not found in this workspace");
    expect(fbody.result.content[0]!.text).not.toContain("telescope");

    // Its own workspace token reaches it.
    const tokenB = endpoint.mint({ workspaceId: "wsB", sessionId: "sB1" });
    const own = await post(endpoint, tokenB, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "get_episode", arguments: { episode_id: ids.b1 } },
    });
    const obody = (await own.json()) as { result: { content: Array<{ text: string }> } };
    expect(obody.result.content[0]!.text).toContain("gamma telescope migration");
  });

  test("tools/call unknown tool → isError result (not a transport error)", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    const res = await post(endpoint, token, {
      jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "drop_table", arguments: {} },
    });
    const body = (await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain("Unknown tool");
  });

  test("unknown method → JSON-RPC method-not-found (-32601)", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    const res = await post(endpoint, token, { jsonrpc: "2.0", id: 7, method: "resources/list" });
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32601);
  });

  test("batch request returns an array of responses", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    const res = await post(endpoint, token, [
      initMsg,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const body = (await res.json()) as Array<{ id: number }>;
    expect(Array.isArray(body)).toBe(true);
    // The notification contributes no response → 2 responses (init + tools/list).
    expect(body.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  test("revoke: a revoked token no longer authorizes", async () => {
    const { endpoint } = await setup();
    const token = endpoint.mint({ workspaceId: "wsA", sessionId: "sA1" });
    expect((await post(endpoint, token, initMsg)).status).toBe(200);
    expect(endpoint.activeTokens).toBe(1);
    endpoint.revoke(token);
    expect(endpoint.activeTokens).toBe(0);
    expect((await post(endpoint, token, initMsg)).status).toBe(401);
  });
});
