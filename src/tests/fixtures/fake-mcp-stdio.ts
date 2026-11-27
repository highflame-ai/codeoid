/**
 * fake-mcp-stdio — a minimal stdio MCP server for McpHub tests. Newline JSON-RPC:
 * answers initialize / tools/list / tools/call. One tool `echo` returns its args;
 * `where` (listed only with FAKE_MCP_WHERE=1) says which process answered, and in what directory.
 */
export {}; // module scope — keeps top-level `buf`/`send` out of the global fixture namespace

const enc = new TextEncoder();
function send(obj: unknown): void {
  process.stdout.write(enc.encode(`${JSON.stringify(obj)}\n`));
}

const TOOLS = [
  { name: "echo", description: "Echo the arguments back as text.", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
  { name: "boom", description: "Always errors.", inputSchema: { type: "object", properties: {} } },
  ...(process.env.FAKE_MCP_WHERE === "1" ? [{ name: "where", description: "This process's pid and working directory.", inputSchema: { type: "object", properties: {} } }] : []),
];

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notification (e.g. notifications/initialized)
    const id = msg.id;
    switch (msg.method) {
      case "initialize":
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp-stdio", version: "0.1.0" } } });
        break;
      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        break;
      case "tools/call": {
        const name = msg.params?.name;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (name === "echo") {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }], isError: false } });
        } else if (name === "where") {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, cwd: process.cwd() }) }], isError: false } });
        } else if (name === "boom") {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "kaboom" }], isError: true } });
        } else {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool: ${String(name)}` }], isError: true } });
        }
        break;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(msg.method)}` } });
    }
  }
});
