/**
 * Tool-safety classification — which tools are read-only and may run WITHOUT a
 * confirmation prompt (in guarded mode) or without burning the autonomous
 * budget. Pure + isolated so the boundary is unit-testable and can't silently
 * widen: an over-broad match here is a prompt-bypass, so it's security-relevant.
 */

import { BLACKBOARD_MCP_SERVER_NAME } from "../blackboard/mcp-http.js";
import { MEMORY_MCP_SERVER_NAME } from "../memory/mcp-http.js";
import { MEMORY_TOOL_NAMES } from "../memory/tools.js";

/** Built-in read-only tools that never require confirmation. */
const SAFE_TOOLS = new Set<string>(["Read", "Grep", "Glob"]);

/** Namespace prefixes a backend gives the mounted memory MCP tools. */
const MEMORY_TOOL_PREFIXES = [
  `mcp__${MEMORY_MCP_SERVER_NAME}__`, // Claude in-process MCP
  `${MEMORY_MCP_SERVER_NAME}__`, // gemini-cli / codex URL mount
] as const;

/** Same two namespacing conventions, for the goal-blackboard mount. */
const BLACKBOARD_TOOL_PREFIXES = [
  `mcp__${BLACKBOARD_MCP_SERVER_NAME}__`,
  `${BLACKBOARD_MCP_SERVER_NAME}__`,
] as const;

/**
 * Blackboard tools that may run unprompted.
 *
 * READS ONLY. `blackboard_write` is deliberately absent even though the service
 * already scope-checks it: a write publishes into shared state other agents act
 * on, so it stays on the same footing as any other write tool. The role's write
 * scope decides whether it is *permitted*; this decides whether it happens
 * *without anyone looking*, and those are different questions.
 */
const BLACKBOARD_SAFE_TOOLS = [
  "blackboard_index",
  "blackboard_read",
  "blackboard_read_all",
] as const;

/**
 * True for read-only tools safe to run unprompted. The memory recall tools are
 * read-only, but a backend namespaces them (`mcp__codeoid_memory__recall`,
 * `codeoid_memory__recall`, …). We require BOTH the exact namespace prefix AND
 * that the suffix is one of the known read-only tools — matching on the server
 * segment alone would let a look-alike (`x_codeoid_memory__wipe`) or a future
 * write-capable memory tool bypass confirmation. A different separator simply
 * prompts (fail-safe), never auto-approves by accident.
 */
export function isSafeTool(name: string): boolean {
  if (SAFE_TOOLS.has(name)) return true;
  for (const prefix of MEMORY_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) {
      return (MEMORY_TOOL_NAMES as readonly string[]).includes(name.slice(prefix.length));
    }
  }
  for (const prefix of BLACKBOARD_TOOL_PREFIXES) {
    if (name.startsWith(prefix)) {
      return (BLACKBOARD_SAFE_TOOLS as readonly string[]).includes(name.slice(prefix.length));
    }
  }
  return false;
}

/**
 * Built-in elicitation tools whose entire purpose is to collect a human answer
 * (the model poses questions; a person picks). They must NEVER auto-approve, in
 * ANY mode: an elicitation is a user-input requirement by definition, so
 * auto-approving hands control back to the backend with no answer and the SDK's
 * tool body immediately reports "The user did not answer the questions." They
 * always route to manual approval — the answer arrives via `session.approve`'s
 * `answers` patch. (`ask_user_question` is the snake_case alias some non-Claude
 * backends surface.)
 */
const ELICITATION_TOOLS = new Set<string>(["AskUserQuestion", "ask_user_question"]);

export function isElicitationTool(name: string): boolean {
  return ELICITATION_TOOLS.has(name);
}

// ── Capability-role enforcement (ambient pack activation — docs/pack-loading.md)

/** Built-in file-mutation tools. A `write:false` capability role (e.g. the
 *  reviewer) may not use these. Bash is deliberately NOT here — a reviewer keeps
 *  shell for read-only inspection (matching the ai-factory reviewer envelope
 *  `[read, grep, glob, bash]`); gating all of Bash would break inspection.
 *  NOTE: this makes the read-only role a call-time DENY of the write tools, NOT
 *  a hard sandbox — a determined agent could still mutate files via Bash
 *  (`>`, tee, sed -i, git apply). The role's system-prompt contract instructs
 *  the model not to; a true sandbox (Shield/OS fence) is a later slice. */
const WRITE_TOOLS = new Set<string>(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Built-in network tools. A role with `network:false` may not use these;
 *  `read-only` and `true` allow them (both built-ins are read-only fetches). */
const NETWORK_TOOLS = new Set<string>(["WebFetch", "WebSearch"]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}
export function isNetworkTool(name: string): boolean {
  return NETWORK_TOOLS.has(name);
}

/** A capability role's tool envelope (subset of the pack role schema). */
export interface ToolRole {
  write: boolean;
  network: boolean | "read-only";
  envelope: "all" | string[];
}

/**
 * If a capability role forbids `toolName`, returns a human reason; otherwise
 * null. Enforced at the `canUseTool` gate (call-time deny, cross-backend) —
 * NOT a static sandbox (the model still sees the tool and may attempt it). Only
 * the high-signal, cleanly-mapped rules are enforced: `write:false` blocks
 * file-mutation tools and `network:false` blocks the network tools. The role's
 * `envelope` allow-list is carried for display but not gated here (its category
 * names don't map 1:1 to concrete backend tool names); tighten in a later slice.
 */
export function roleDeniesTool(role: ToolRole, toolName: string): string | null {
  if (role.write === false && isWriteTool(toolName)) {
    return `capability role is read-only (write: false) — "${toolName}" is not permitted`;
  }
  if (role.network === false && isNetworkTool(toolName)) {
    return `capability role forbids network access (network: false) — "${toolName}" is not permitted`;
  }
  return null;
}

/** Backends that HARD-enforce a capability role via the canUseTool deny above.
 *  Only the Claude SDK routes every tool through canUseTool under the canonical
 *  tool names this file keys off. Other backends use their own tool names, skip
 *  canUseTool in autonomous mode (codex), or expose no write tools — so a role
 *  there is ADVISORY: the constitution + role-contract system prompt guide the
 *  model, but nothing hard-denies. See docs/pipeline-run.md (enforcement matrix). */
const HARD_ROLE_ENFORCEMENT = new Set(["claude"]);

/** Whether the capability-role tool gate is HARD-enforced on `providerId`, or
 *  only ADVISORY (soft, prompt-contract-only). */
export function roleEnforcement(providerId: string | undefined): "hard" | "advisory" {
  return providerId !== undefined && HARD_ROLE_ENFORCEMENT.has(providerId) ? "hard" : "advisory";
}
