/**
 * The policy codeoid imposes on its private opencode server.
 *
 * codeoid owns approvals, so opencode must ask about EVERY action and never
 * settle one itself. opencode evaluates a request against
 * `[...agent rules (global config rules included), ...session rules]`, last
 * match winning, then saved "always" approvals and plugin hooks. Four layers
 * make that hold:
 *
 *   1. Every codeoid session (and every child session a subagent spawns) is
 *      given `SESSION_RULES`: `* / * / ask` last, so nothing an agent allows
 *      survives on it.
 *   2. The injected config's global `permissions` is the same catch-all.
 *   3. opencode documents that "a custom subagent uses its own permissions":
 *      agent rules come after global ones, and a child session may not carry
 *      its parent's session rules. The built-in `explore` subagent allows
 *      `shell`, for one. So once a server is up, codeoid reads every agent's
 *      rules (`GET /api/agent`) and, if any `allow` is not overridden by a
 *      later ask/deny, restarts the server once with config overrides that
 *      turn each agent's allows into asks ({@link agentOverrides}), and refuses
 *      to use a server where one still survives ({@link unsafeAgents}).
 *   4. codeoid replies `once` or `reject`, never `always`, so no saved rule is
 *      ever written; any found in the private database are removed.
 *
 * Tools that never ask (opencode's session-utility tools: `session_rename`,
 * `session_move`, `worktree_*`, and the `schedule_*` tools, which would run
 * work nobody is watching) are removed by disabling the plugins that add
 * them.
 */

import { createHash } from "node:crypto";
import { buildSubprocessEnv } from "../env.js";
import type { OcAgentInfo, OcRule } from "./client.js";

/** Plugins whose tools act without asking — disabled (`-<id>`, opencode's plugin control). */
export const DISABLED_PLUGINS = ["-opencode.tools", "-opencode.tool.schedule"] as const;

/** Prefix of every MCP server codeoid mounts on opencode (`coid<session>_<name>`). */
export const MCP_MOUNT_PREFIX = "coid";

/**
 * The per-session part of a mounted server's name. opencode's MCP set is per
 * DIRECTORY, not per session, so two codeoid sessions in one workdir see each
 * other's mounts; each mount is named for its session and the session rules
 * deny every other session's (`coid*` deny, then own `coid<sfx>_*` ask).
 */
export function mountSuffix(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
}

/** `coid<sfx>_` — the action prefix of this session's own MCP tools. */
export function ownMountPrefix(sessionId: string): string {
  return `${MCP_MOUNT_PREFIX}${mountSuffix(sessionId)}_`;
}

/** opencode's server-name normalization (`McpTool.namespace`): anything outside [a-zA-Z0-9_-] becomes `_`. */
export function mcpNamespace(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The session rules: ask for everything, and only this session's own mounts. */
export function sessionRules(sessionId: string): OcRule[] {
  return [
    { action: "*", resource: "*", effect: "ask" },
    { action: `${MCP_MOUNT_PREFIX}*`, resource: "*", effect: "deny" },
    { action: `${ownMountPrefix(sessionId)}*`, resource: "*", effect: "ask" },
  ];
}

/**
 * opencode's wildcard (`Wildcard.match`): `*` matches any run, the rest is
 * literal. Used to judge whether one rule's pattern covers another's.
 */
function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
}

/** True when every value `inner` matches, `outer` matches too (conservative: literal or `*`-pattern match). */
function covers(outer: string, inner: string): boolean {
  if (outer === "*" || outer === inner) return true;
  return !inner.includes("*") && wildcard(outer).test(inner);
}

/**
 * The `allow` rules of a ruleset that no later ask/deny rule overrides — what
 * an agent would run without asking anyone.
 */
export function survivingAllows(rules: readonly OcRule[]): OcRule[] {
  return rules.filter(
    (r, i) =>
      r.effect === "allow" &&
      !rules.slice(i + 1).some((later) => later.effect !== "allow" && covers(later.action, r.action) && covers(later.resource, r.resource)),
  );
}

/**
 * Agents a child session could run as that would act on something without
 * asking. Only subagents: opencode's subagent tool refuses a `primary` agent,
 * and a primary agent only runs in a codeoid session, whose own rules end in
 * ask-everything.
 */
export function unsafeAgents(agents: readonly OcAgentInfo[]): OcAgentInfo[] {
  return agents.filter((a) => a.mode !== "primary" && survivingAllows(a.permissions ?? []).length > 0);
}

/**
 * Config overrides that make each unsafe agent ask where it allowed: its
 * surviving allows, appended again as asks. Agent config rules are appended
 * after the agent's own, so these are last for it; its denies stay in force.
 */
export function agentOverrides(agents: readonly OcAgentInfo[]): Record<string, { permissions: OcRule[] }> {
  const out: Record<string, { permissions: OcRule[] }> = {};
  for (const a of unsafeAgents(agents)) {
    out[a.id] = { permissions: survivingAllows(a.permissions).map((r) => ({ ...r, effect: "ask" as const })) };
  }
  return out;
}

/** The config injected with `OPENCODE_CONFIG_CONTENT`. */
export function opencodeConfig(overrides: Record<string, { permissions: OcRule[] }> = {}): Record<string, unknown> {
  return {
    permissions: [{ action: "*", resource: "*", effect: "ask" }],
    plugins: [...DISABLED_PLUGINS],
    // codeoid pins the version it speaks; opencode must not replace itself.
    update: "disable",
    share: "disabled",
    ...(Object.keys(overrides).length > 0 ? { agents: overrides } : {}),
  };
}

/**
 * Environment for the opencode server. opencode drives 75+ model providers,
 * each reading its own key, so — like pi — conventional credential shapes
 * pass through; anything exotic (`AWS_*` for Bedrock) goes through
 * `CODEOID_AGENT_ENV_ALLOW`. The user's own `OPENCODE_*` settings do NOT pass:
 * a password, database or config dir from the user's environment would point
 * the private server at the user's own opencode. codeoid sets its own below.
 */
export function buildOpencodeEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = buildSubprocessEnv(
    {
      prefixes: ["LC_", "ANTHROPIC_", "OPENAI_", "GOOGLE_", "GEMINI_", "OPENROUTER_", "AZURE_", "GROQ_", "MISTRAL_", "DEEPSEEK_", "XAI_", "OLLAMA_"],
      suffixes: ["_API_KEY", "_API_TOKEN"],
    },
    base,
  );
  for (const k of Object.keys(env)) if (k.startsWith("OPENCODE_")) delete env[k];
  return env;
}

/** The server's own settings, set last over {@link buildOpencodeEnv}. */
export function serverEnv(opts: { password: string; dbPath: string; config: Record<string, unknown> }): Record<string, string> {
  return {
    OPENCODE_PASSWORD: opts.password,
    OPENCODE_DB: opts.dbPath,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.config),
    // A repo's opencode.json could allow tools or add MCP servers codeoid
    // never sees; codeoid's own Claude-side settings aren't opencode's.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}
