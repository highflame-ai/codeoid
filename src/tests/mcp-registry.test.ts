/**
 * McpRegistry tests — normalization of the config `mcpServers` block into
 * transport-neutral specs, the built-in codeoid_memory entry, reserved-name
 * handling, and per-backend filtering (S1 of the registry-driven MCP mounter).
 */

import { describe, it, expect } from "bun:test";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { canonicalToolName, isProxied, type McpServerSpec } from "../daemon/mcp/types.js";
import { MEMORY_MCP_SERVER_NAME } from "@highflame/codeoid-memory/mcp-http.js";
import type { RawMcpServerConfig } from "../config.js";

/** Fill schema defaults so tests only state the fields they care about. */
function raw(p: Partial<RawMcpServerConfig>): RawMcpServerConfig {
  return {
    args: [],
    env: {},
    headers: {},
    trust: "prompt",
    scope: "workspace",
    enabled: true,
    native: false,
    ...p,
  } as RawMcpServerConfig;
}

function byName(specs: McpServerSpec[], name: string): McpServerSpec | undefined {
  return specs.find((s) => s.name === name);
}

describe("McpRegistry", () => {
  it("normalizes a stdio server (command → stdio transport)", () => {
    const reg = new McpRegistry(
      { github: raw({ command: "npx", args: ["-y", "@mcp/github"], env: { TOKEN: "${GH_PAT}" } }) },
      { memoryEnabled: false },
    );
    const s = reg.get("github");
    expect(s).toBeDefined();
    expect(s?.transport).toEqual({ kind: "stdio", command: "npx", args: ["-y", "@mcp/github"], env: { TOKEN: "${GH_PAT}" } });
    expect(s?.builtin).toBe(false);
    expect(isProxied(s as McpServerSpec)).toBe(true);
  });

  it("normalizes an http server (url → streamable-HTTP transport)", () => {
    const reg = new McpRegistry(
      { linear: raw({ url: "https://mcp.linear.app/mcp", bearerTokenEnv: "LINEAR_KEY", trust: "readonly" }) },
      { memoryEnabled: false },
    );
    const s = reg.get("linear");
    expect(s?.transport).toEqual({ kind: "http", url: "https://mcp.linear.app/mcp", headers: {}, bearerTokenEnv: "LINEAR_KEY" });
    expect(s?.trust).toBe("readonly");
  });

  it("injects the built-in codeoid_memory entry when memory is enabled", () => {
    const reg = new McpRegistry(undefined, { memoryEnabled: true });
    const mem = reg.get(MEMORY_MCP_SERVER_NAME);
    expect(mem).toEqual({
      name: MEMORY_MCP_SERVER_NAME,
      transport: { kind: "in-process" },
      trust: "readonly",
      scope: "session",
      enabled: true,
      native: false,
      builtin: true,
    });
  });

  it("omits the memory entry when memory is disabled", () => {
    const reg = new McpRegistry(undefined, { memoryEnabled: false });
    expect(reg.get(MEMORY_MCP_SERVER_NAME)).toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  it("ignores a user entry that collides with a reserved built-in name (built-in wins)", () => {
    const reg = new McpRegistry(
      { [MEMORY_MCP_SERVER_NAME]: raw({ command: "evil", trust: "readonly" }) },
      { memoryEnabled: true },
    );
    const mem = reg.get(MEMORY_MCP_SERVER_NAME);
    expect(mem?.builtin).toBe(true); // still the in-process built-in, not "evil"
    expect(mem?.transport.kind).toBe("in-process");
    expect(reg.warnings.some((w) => w.includes("reserved"))).toBe(true);
  });

  it("carries trust, scope, and the tool allowlist through", () => {
    const reg = new McpRegistry(
      { gh: raw({ command: "x", trust: "prompt", scope: "session", tools: ["search", "read_file"] }) },
      { memoryEnabled: false },
    );
    const s = reg.get("gh");
    expect(s?.trust).toBe("prompt");
    expect(s?.scope).toBe("session");
    expect(s?.toolAllowlist).toEqual(["search", "read_file"]);
  });

  it("forBackend filters by enabled and the backends allowlist", () => {
    const reg = new McpRegistry(
      {
        everywhere: raw({ command: "a" }),
        claudeOnly: raw({ command: "b", backends: ["claude"] }),
        disabled: raw({ command: "c", enabled: false }),
      },
      { memoryEnabled: true },
    );
    const codex = reg.forBackend("codex").map((s) => s.name).sort();
    // memory (no backends restriction) + everywhere; NOT claudeOnly, NOT disabled.
    expect(codex).toEqual([MEMORY_MCP_SERVER_NAME, "everywhere"].sort());
    const claude = reg.forBackend("claude").map((s) => s.name).sort();
    expect(claude).toEqual([MEMORY_MCP_SERVER_NAME, "claudeOnly", "everywhere"].sort());
    expect(byName(reg.forBackend("claude"), "disabled")).toBeUndefined();
  });

  it("canonicalToolName is the one cross-backend form", () => {
    expect(canonicalToolName("codeoid_memory", "recall")).toBe("mcp__codeoid_memory__recall");
    expect(canonicalToolName("github", "search")).toBe("mcp__github__search");
  });
});
