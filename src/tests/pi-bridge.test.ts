import { describe, test, expect } from "bun:test";
import { buildBridgeSource, APPROVAL_TITLE, MCP_TOOL_TITLE, MEMORY_TOOL_TITLE } from "../daemon/providers/pi/bridge.js";
import { MEMORY_TOOL_NAMES } from "../daemon/memory/tools.js";

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

describe("pi bridge tool_call gate — runtime (#367)", () => {
  /** Load the REAL generated bridge with a stub `pi`, and return its tool_call handler. */
  async function loadToolCallHandler(): Promise<(event: Record<string, unknown>, ctx: unknown) => Promise<unknown>> {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pi-bridge-rt-"));
    const path = join(dir, "bridge.mjs");
    writeFileSync(path, buildBridgeSource(false));
    const mod = (await import(path)) as { default: (pi: unknown) => void };
    const handlers: Record<string, (e: Record<string, unknown>, c: unknown) => Promise<unknown>> = {};
    mod.default({
      on: (evt: string, fn: (e: Record<string, unknown>, c: unknown) => Promise<unknown>) => {
        handlers[evt] = fn;
      },
    });
    return handlers.tool_call!;
  }
  const ctxAnswering = (decision: unknown) => ({ hasUI: true, ui: { input: async () => JSON.stringify(decision) } });

  test("updatedInput REPLACES pi's input — a key the rewrite drops is dropped from what runs", async () => {
    const handler = await loadToolCallHandler();
    const event: { toolCallId: string; toolName: string; input: Record<string, unknown> } = {
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "rm -rf ~/x", force: true },
    };
    const verdict = await handler(event, ctxAnswering({ behavior: "allow", updatedInput: { command: "echo SAFE" } }));
    expect(verdict).toBeUndefined(); // allowed
    expect(event.input).toEqual({ command: "echo SAFE" });
  });

  test("prototype-named keys are handled as plain keys", async () => {
    const handler = await loadToolCallHandler();
    const event: { toolCallId: string; toolName: string; input: Record<string, unknown> } = {
      toolCallId: "c3",
      toolName: "bash",
      input: { command: "x", constructor: "dropped-by-rewrite" },
    };
    const updated = JSON.parse('{"command":"y","__proto__":{"polluted":true}}');
    await handler(event, ctxAnswering({ behavior: "allow", updatedInput: updated }));
    expect(Object.keys(event.input)).toEqual(["command"]);
    expect(event.input.command).toBe("y");
    expect((event.input as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("no updatedInput leaves the input as proposed; deny blocks", async () => {
    const handler = await loadToolCallHandler();
    const event = { toolCallId: "c2", toolName: "bash", input: { command: "ls" } };
    expect(await handler(event, ctxAnswering({ behavior: "allow" }))).toBeUndefined();
    expect(event.input).toEqual({ command: "ls" });
    expect(await handler(event, ctxAnswering({ behavior: "deny", message: "no" }))).toMatchObject({ block: true });
  });
});
