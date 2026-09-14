/**
 * McpHub tests — the daemon-owned MCP client across all three transports
 * (in-process memory, streamable-HTTP, stdio), plus allowlist enforcement,
 * per-call timeout, and error normalization (S2 of the registry mounter).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { McpHub } from "../daemon/mcp/hub.js";
import type { McpCallScope } from "../daemon/mcp/hub.js";
import type { McpServerSpec } from "../daemon/mcp/types.js";
import { MemoryEngine } from "@highflame/codeoid-memory/engine.js";
import { SqliteEpisodeStore } from "@highflame/codeoid-memory/store.js";
import type { Embedder } from "@highflame/codeoid-memory/embedder.js";

const SCOPE: McpCallScope = { workspaceId: "ws1", sessionId: "sess1" };
const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-stdio.ts");

class FakeEmbedder implements Embedder {
  readonly modelName = "fake";
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

function spec(p: Partial<McpServerSpec> & Pick<McpServerSpec, "name" | "transport">): McpServerSpec {
  return { trust: "prompt", scope: "session", enabled: true, native: false, builtin: false, ...p };
}

// ── a mock streamable-HTTP MCP server (bearer required; tools: ping, slow) ──
const HTTP_TOKEN = "sekret";
const httpServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method !== "POST") return new Response("no", { status: 405 });
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${HTTP_TOKEN}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const msg = (await req.json()) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (msg.id === undefined) return new Response(null, { status: 202 }); // notification
    const id = msg.id;
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (msg.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" } });
    if (msg.method === "tools/list")
      return ok({ tools: [
        { name: "ping", description: "ping", inputSchema: { type: "object" } },
        { name: "slow", description: "slow", inputSchema: { type: "object" } },
      ] });
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      if (name === "slow") await new Promise((r) => setTimeout(r, 300));
      return ok({ content: [{ type: "text", text: name === "ping" ? `pong:${JSON.stringify(msg.params?.arguments ?? {})}` : "slept" }], isError: false });
    }
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });
  },
});
const HTTP_URL = `http://127.0.0.1:${httpServer.port}/mcp`;
const DAEMON_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, TOK: HTTP_TOKEN };

afterAll(() => httpServer.stop(true));

describe("McpHub — in-process (codeoid_memory)", () => {
  it("lists and runs the memory tools against the live engine", async () => {
    const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
    await engine.init();
    const hub = new McpHub({ engine });
    const memSpec = spec({ name: "codeoid_memory", transport: { kind: "in-process" }, trust: "readonly", builtin: true });

    const tools = (await hub.listTools(memSpec)).map((t) => t.name);
    expect(tools).toContain("recall");
    expect(tools).toContain("get_episode");

    const res = await hub.callTool(memSpec, "recall", { query: "anything" }, SCOPE);
    expect(res.isError).toBe(false);
    expect(typeof res.text).toBe("string");

    const bad = await hub.callTool(memSpec, "no_such_tool", {}, SCOPE);
    expect(bad.isError).toBe(true);
    hub.closeAll();
    await engine.close();
  });

  it("fails closed when the in-process server has no engine", async () => {
    const hub = new McpHub({ engine: null });
    const memSpec = spec({ name: "codeoid_memory", transport: { kind: "in-process" }, builtin: true });
    const res = await hub.callTool(memSpec, "recall", {}, SCOPE);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("unavailable");
  });
});

describe("McpHub — streamable-HTTP", () => {
  it("injects the bearer from env, lists + calls tools, round-trips args", async () => {
    const hub = new McpHub({ daemonEnv: DAEMON_ENV });
    const s = spec({ name: "remote", transport: { kind: "http", url: HTTP_URL, headers: {}, bearerTokenEnv: "TOK" } });
    const tools = (await hub.listTools(s)).map((t) => t.name).sort();
    expect(tools).toEqual(["ping", "slow"]);
    const res = await hub.callTool(s, "ping", { a: 1 }, SCOPE);
    expect(res.isError).toBe(false);
    expect(res.text).toBe('pong:{"a":1}');
    hub.closeAll();
  });

  it("returns isError when the bearer is missing (fails closed, no wedge)", async () => {
    const hub = new McpHub({ daemonEnv: { PATH: process.env.PATH, HOME: process.env.HOME } }); // no TOK
    const s = spec({ name: "remote", transport: { kind: "http", url: HTTP_URL, headers: {}, bearerTokenEnv: "TOK" } });
    const res = await hub.callTool(s, "ping", {}, SCOPE);
    expect(res.isError).toBe(true);
    hub.closeAll();
  });

  it("enforces the tool allowlist before hitting the server", async () => {
    const hub = new McpHub({ daemonEnv: DAEMON_ENV });
    const s = spec({ name: "remote", transport: { kind: "http", url: HTTP_URL, headers: {}, bearerTokenEnv: "TOK" }, toolAllowlist: ["ping"] });
    expect((await hub.listTools(s)).map((t) => t.name)).toEqual(["ping"]);
    const blocked = await hub.callTool(s, "slow", {}, SCOPE);
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("allowlist");
    hub.closeAll();
  });

  it("times a slow call out as an error result", async () => {
    const hub = new McpHub({ daemonEnv: DAEMON_ENV, toolTimeoutMs: 50 });
    const s = spec({ name: "remote", transport: { kind: "http", url: HTTP_URL, headers: {}, bearerTokenEnv: "TOK" } });
    const res = await hub.callTool(s, "slow", {}, SCOPE); // server sleeps 300ms
    expect(res.isError).toBe(true);
    expect(res.text).toContain("timed out");
    hub.closeAll();
  });
});

describe("McpHub — stdio", () => {
  it("handshakes, lists, and calls tools on a subprocess server", async () => {
    const hub = new McpHub({ daemonEnv: DAEMON_ENV });
    const s = spec({ name: "local", transport: { kind: "stdio", command: process.execPath, args: [FIXTURE], env: {} } });
    const tools = (await hub.listTools(s)).map((t) => t.name).sort();
    expect(tools).toEqual(["boom", "echo"]);
    const ok = await hub.callTool(s, "echo", { msg: "hi" }, SCOPE);
    expect(ok.isError).toBe(false);
    expect(ok.text).toBe('echo:{"msg":"hi"}');
    const bad = await hub.callTool(s, "boom", {}, SCOPE);
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe("kaboom");
    hub.closeAll();
  });

  it("tracks live status (tools + connected) for the settings surface", async () => {
    const hub = new McpHub({ daemonEnv: DAEMON_ENV });
    const s = spec({ name: "local", transport: { kind: "stdio", command: process.execPath, args: [FIXTURE], env: {} } });
    expect(hub.statusFor("local")).toBeUndefined(); // untouched
    expect(hub.hasClient("local")).toBe(false);
    await hub.listTools(s);
    expect(hub.hasClient("local")).toBe(true);
    expect(hub.statusFor("local")?.tools.sort()).toEqual(["boom", "echo"]);
    expect(hub.statusFor("local")?.error).toBeUndefined();
    hub.closeAll();
  });

  it("records a transport failure in status (timeout → error)", async () => {
    const hub = new McpHub({ daemonEnv: DAEMON_ENV, toolTimeoutMs: 50 });
    const s = spec({ name: "remote", transport: { kind: "http", url: HTTP_URL, headers: {}, bearerTokenEnv: "TOK" } });
    await hub.callTool(s, "slow", {}, SCOPE); // server sleeps 300ms → times out
    expect(hub.statusFor("remote")?.error).toContain("timed out");
    hub.closeAll();
  });
});
