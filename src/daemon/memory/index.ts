/**
 * Daemon-side memory barrel.
 *
 * The engine itself lives in `@highflame/codeoid-memory` so it can ship as a
 * standalone MCP server on plain Node. What stays here is the one binding that
 * is *not* transport-neutral: `buildMemoryMcpServer()` wires the recall tools
 * into the Claude Agent SDK's in-process MCP API, and keeping it out of the
 * package keeps `@anthropic-ai/claude-agent-sdk` off the standalone install.
 *
 * Daemon code imports memory from here and gets both halves.
 */

export * from "@highflame/codeoid-memory";
export { buildMemoryMcpServer } from "./mcp.js";
