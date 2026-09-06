import { describe, test, expect } from "bun:test";
import { FLEET_READ_TOOLS, FLEET_SEND_TOOLS } from "../protocol/types.js";
import { isElicitationTool, isSafeTool } from "../daemon/providers/tool-safety.js";
import { MEMORY_TOOL_NAMES } from "../daemon/memory/tools.js";

describe("isSafeTool", () => {
  test("built-in read-only tools are safe", () => {
    for (const t of ["Read", "Grep", "Glob"]) expect(isSafeTool(t)).toBe(true);
  });

  test("write/exec tools are never safe", () => {
    for (const t of ["Write", "Edit", "Bash", "WebFetch"]) expect(isSafeTool(t)).toBe(false);
  });

  test("known memory tools are safe under both namespaces", () => {
    for (const t of MEMORY_TOOL_NAMES) {
      expect(isSafeTool(`mcp__codeoid_memory__${t}`)).toBe(true); // Claude in-process
      expect(isSafeTool(`codeoid_memory__${t}`)).toBe(true); // gemini-cli/codex URL mount
    }
  });

  test("look-alike names cannot bypass the prompt (the Gemini #182 finding)", () => {
    // A third-party/malicious server whose name merely CONTAINS the segment.
    expect(isSafeTool("x_codeoid_memory__wipe")).toBe(false);
    expect(isSafeTool("not_codeoid_memory__delete")).toBe(false);
    expect(isSafeTool("malicious_codeoid_memory")).toBe(false);
    // Correct namespace but an UNKNOWN (e.g. future write-capable) memory tool.
    expect(isSafeTool("codeoid_memory__delete_all")).toBe(false);
    expect(isSafeTool("mcp__codeoid_memory__purge")).toBe(false);
    // Namespace as a substring but not a prefix.
    expect(isSafeTool("evil.codeoid_memory__recall")).toBe(false);
  });
});

describe("isElicitationTool", () => {
  test("AskUserQuestion and its snake_case alias are elicitation tools", () => {
    expect(isElicitationTool("AskUserQuestion")).toBe(true);
    expect(isElicitationTool("ask_user_question")).toBe(true);
  });

  test("ordinary tools are not elicitation tools", () => {
    for (const t of [
      "Read",
      "Bash",
      "Write",
      "AskUser", // partial name must not match
      "askuserquestion", // wrong case must not match
      "mcp__codeoid_fleet__fleet_send",
    ]) {
      expect(isElicitationTool(t)).toBe(false);
    }
  });
});

describe("isSafeTool — the conductor's fleet mount", () => {
  // The fleet READ surface is specified to run silently (conductor-design §3):
  // "fleet_list / fleet_find / fleet_summary / fleet_recall / fleet_tasks /
  // machine_map run silently". They did not — `isSafeTool` knew the memory and
  // blackboard mounts but not the fleet, so in guarded mode every `fleet_find`
  // raised an approval prompt. An assistant that asks permission to look
  // something up is not an assistant.

  test("every read verb runs unprompted, under both namespacings", () => {
    for (const verb of FLEET_READ_TOOLS) {
      expect(isSafeTool(`mcp__codeoid_fleet__${verb}`)).toBe(true);
      expect(isSafeTool(`codeoid_fleet__${verb}`)).toBe(true);
    }
  });

  test("NO send-class verb is ever safe", () => {
    // The one that must never regress. These are hard-gated earlier too
    // (isFleetSendTool, before any mode logic), so this is the second fence.
    for (const verb of FLEET_SEND_TOOLS) {
      expect(isSafeTool(`mcp__codeoid_fleet__${verb}`)).toBe(false);
      expect(isSafeTool(`codeoid_fleet__${verb}`)).toBe(false);
    }
  });

  test("an unknown verb on the fleet prefix prompts rather than auto-approving", () => {
    expect(isSafeTool("mcp__codeoid_fleet__fleet_detonate")).toBe(false);
    expect(isSafeTool("mcp__codeoid_fleet__")).toBe(false);
  });

  test("a look-alike server segment does not inherit fleet safety", () => {
    // Matching on the server segment alone would let these through; the prefix
    // must match exactly, then the suffix must be a known read verb.
    expect(isSafeTool("mcp__evil_codeoid_fleet__fleet_find")).toBe(false);
    expect(isSafeTool("x_codeoid_fleet__fleet_find")).toBe(false);
    expect(isSafeTool("mcp__codeoid_fleet_x__fleet_find")).toBe(false);
  });
});
