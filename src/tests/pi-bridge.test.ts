import { describe, test, expect } from "bun:test";
import { buildBridgeSource, APPROVAL_TITLE, MCP_TOOL_TITLE, MEMORY_TOOL_TITLE } from "../daemon/providers/pi/bridge.js";
import { MEMORY_TOOL_NAMES } from "@highflame/codeoid-memory/tools.js";

describe("pi bridge source", () => {
  test("base bridge (no memory): approval gate present, no memory tools or typebox import", () => {
    const src = buildBridgeSource(false);
    expect(src).toContain("export default function (pi)");
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain(APPROVAL_TITLE);
    // No memory machinery when memory is off — keeps the bridge dependency-free.
    expect(src).not.toContain('import { Type } from "typebox"');
    expect(src).not.toContain("pi.registerTool");
    expect(src).not.toContain(MEMORY_TOOL_TITLE);
  });

  test("memory bridge: imports typebox, registers all four recall tools, proxies via the reserved title", () => {
    const src = buildBridgeSource(true);
    // ESM import (spike-verified to resolve in pi's -e loader).
    expect(src).toContain('import { Type } from "typebox"');
    // Still keeps the approval gate.
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain("pi.registerTool");
    // Each memory tool is registered under the codeoid_memory__ namespace.
    for (const name of MEMORY_TOOL_NAMES) {
      expect(src).toContain(`"${name}"`);
    }
    expect(src).toContain('"codeoid_memory__" + bare');
    // execute() proxies to the daemon over the reserved memory-tool title.
    expect(src).toContain(MEMORY_TOOL_TITLE);
    expect(src).toContain("ctx.ui.input");
  });

  test("external MCP tools: registered with raw JSON-Schema params, proxied via the mcp title (no typebox)", () => {
    const src = buildBridgeSource(false, [
      { name: "mcp__github__search", description: "Search repos.", parameters: { type: "object", properties: { q: { type: "string" } } } },
    ]);
    // No typebox needed — external params are raw JSON Schema.
    expect(src).not.toContain('import { Type } from "typebox"');
    expect(src).toContain("pi.registerTool");
    expect(src).toContain("mcp__github__search");
    expect(src).toContain('"type":"object"'); // the raw JSON Schema is embedded verbatim
    expect(src).toContain(MCP_TOOL_TITLE);
    // Still gated by the tool_call approval hook.
    expect(src).toContain(APPROVAL_TITLE);
  });

  test("no external block when the mcp tool list is empty", () => {
    expect(buildBridgeSource(false, [])).not.toContain(MCP_TOOL_TITLE);
  });
});
