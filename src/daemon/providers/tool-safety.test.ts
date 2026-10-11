/**
 * Tool-safety classification — read-safe set, and the capability-role gate used
 * by ambient pack activation (docs/pack-loading.md).
 */

import { describe, expect, test } from "bun:test";
import {
  isNetworkTool,
  isSafeTool,
  isWriteTool,
  roleDeniesTool,
  roleEnforcement,
  type ToolRole,
} from "./tool-safety";

describe("classifiers", () => {
  test("read-safe tools", () => {
    expect(isSafeTool("Read")).toBe(true);
    expect(isSafeTool("Grep")).toBe(true);
    expect(isSafeTool("Write")).toBe(false);
  });
  test("write tools (Bash is NOT a write tool — reviewer keeps shell)", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) expect(isWriteTool(t)).toBe(true);
    expect(isWriteTool("Bash")).toBe(false);
    expect(isWriteTool("Read")).toBe(false);
  });
  test("network tools", () => {
    expect(isNetworkTool("WebFetch")).toBe(true);
    expect(isNetworkTool("WebSearch")).toBe(true);
    expect(isNetworkTool("Read")).toBe(false);
  });
});

describe("roleDeniesTool", () => {
  const reviewer: ToolRole = { write: false, network: "read-only", envelope: ["read", "grep", "glob", "bash"] };
  const implementer: ToolRole = { write: true, network: "read-only", envelope: "all" };
  const noNet: ToolRole = { write: true, network: false, envelope: "all" };

  test("read-only role denies write tools, allows reads + bash", () => {
    expect(roleDeniesTool(reviewer, "Write")).toMatch(/read-only/);
    expect(roleDeniesTool(reviewer, "Edit")).toMatch(/read-only/);
    expect(roleDeniesTool(reviewer, "Read")).toBeNull();
    expect(roleDeniesTool(reviewer, "Bash")).toBeNull(); // shell kept for inspection
  });

  test("read-only role (network:'read-only') still allows read-only fetches", () => {
    expect(roleDeniesTool(reviewer, "WebFetch")).toBeNull();
  });

  test("write-capable role allows writes", () => {
    expect(roleDeniesTool(implementer, "Write")).toBeNull();
    expect(roleDeniesTool(implementer, "WebFetch")).toBeNull();
  });

  test("network:false denies network tools but not writes", () => {
    expect(roleDeniesTool(noNet, "WebFetch")).toMatch(/network/);
    expect(roleDeniesTool(noNet, "Write")).toBeNull();
  });

  test("codex's file change is a write; its network grant opens egress (#369)", () => {
    expect(roleDeniesTool(reviewer, "codex_file_change")).toMatch(/read-only/);
    // network:'read-only' covers read-only fetches, not open egress
    expect(roleDeniesTool(implementer, "codex_network_access")).toMatch(/egress/);
    expect(roleDeniesTool(noNet, "codex_network_access")).toMatch(/network/);
    const fullNet: ToolRole = { write: true, network: true, envelope: "all" };
    expect(roleDeniesTool(fullNet, "codex_network_access")).toBeNull();
  });
});

describe("roleEnforcement (per-backend)", () => {
  test("claude hard-enforces the role tool gate", () => {
    expect(roleEnforcement("claude")).toBe("hard");
  });
  test("other backends are advisory (soft prompt-contract only)", () => {
    for (const p of ["codex", "pi", "gemini", "gemini-cli", "openai"]) {
      expect(roleEnforcement(p)).toBe("advisory");
    }
  });
  test("an unknown / undefined backend defaults to advisory (never over-claims)", () => {
    expect(roleEnforcement(undefined)).toBe("advisory");
    expect(roleEnforcement("mystery")).toBe("advisory");
  });
});
