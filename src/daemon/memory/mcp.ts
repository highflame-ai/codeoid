/**
 * Memory MCP server — exposes the memory recall tools to Claude via the Agent
 * SDK's in-process MCP API (createSdkMcpServer + tool), so no subprocess or IPC
 * is involved.
 *
 * This is now a THIN adapter: the tool bodies + formatting live in the
 * transport-neutral registry (./tools.ts) so every other backend can expose the
 * same tools. The server is bound to a single (workspace, session) pair — that
 * binding is the tenant scope; tools take no scope arguments.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { MemoryEngine } from "./engine.js";
import { MEMORY_MCP_SERVER_NAME } from "./mcp-http.js";
import { memoryToolDefs, type MemoryToolContext } from "./tools.js";

export interface MemoryMcpBinding {
  workspaceId: string;
  /** Current session ID — used to exclude the caller's own turns from recall by default. */
  sessionId: string;
}

export function buildMemoryMcpServer(
  engine: MemoryEngine,
  binding: MemoryMcpBinding,
): McpSdkServerConfigWithInstance {
  const ctx: MemoryToolContext = {
    engine,
    workspaceId: binding.workspaceId,
    sessionId: binding.sessionId,
  };
  const tools = memoryToolDefs().map((def) =>
    tool(def.name, def.description, def.zodShape, async (args) => ({
      content: [{ type: "text" as const, text: await def.run(args, ctx) }],
    })),
  );
  return createSdkMcpServer({
    // MUST equal MEMORY_MCP_SERVER_NAME. Backends disagree about which name
    // they namespace mounted tools by: the Claude SDK uses the mcpServers map
    // KEY (always this constant), while qwen-code uses the server INSTANCE's
    // own name. While these differed (`codeoid_memory` vs `codeoid-memory`)
    // the qwen backend exposed `mcp__codeoid-memory__*`, which matched neither
    // the provider's `allowedTools` grant nor `isSafeTool`'s prefixes — so the
    // read-only recall tools prompted for approval on every single call.
    // One name removes the whole class of mismatch.
    name: MEMORY_MCP_SERVER_NAME,
    version: "0.1.0",
    tools,
  });
}
