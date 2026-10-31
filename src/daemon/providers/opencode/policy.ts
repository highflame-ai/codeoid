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
 *      ever written; any found in the private database are removed, and the
 *      session's rules set again, before every turn (any process of the
 *      daemon's user can read the server's password from its environment).
 *
 * Tools that never ask (opencode's session-utility tools: `session_rename`,
 * `session_move`, `worktree_*`, and the `schedule_*` tools, which would run
 * work nobody is watching) are removed by disabling the plugins that add
 * them. Code Mode (`execute`) is removed by a deny rule, which hides the
 * tool: on opencode 2.2.2 a Code Mode script's `fetch` runs without asking
 * anything (2.2.5 asks `webfetch`), so the script could reach any URL past
 * codeoid's gate. With Code Mode gone opencode lists the tools it kept in its
 * catalog directly, so opencode's own `browser` deny (its agents have it,
 * and codeoid's ask-everything would reopen it) is kept too.
 *
 * A plugin can settle a permission request itself (its `permission.evaluate`
 * hook runs after the rules), so opencode would never publish it. The server
 * reads its global config — plugins, agents, MCP servers, instructions — from
 * a codeoid-owned directory (`OPENCODE_CONFIG_DIR`), never the user's; only
 * the provider and model keys of the user's global config are carried over
 * ({@link userModelConfig}). A server listing any plugin that isn't one of
 * opencode's built-ins is refused (server.ts), and a call that ran without
 * asking stops it (index.ts).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSubprocessEnv } from "../env.js";
import type { OcAgentInfo, OcPluginInfo, OcRule } from "./client.js";

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

/**
 * opencode's own slash commands, by the description each lists (2.2.2 and
 * 2.2.5 alike). A command from a config dir (`commands/*.md`, codeoid's own
 * or `/etc/opencode`'s) runs every `` !`…` `` of its template through the
 * shell, the message's arguments substituted in first, with no permission
 * request — past codeoid's gate. One named like a built-in replaces it, so a
 * built-in is known by its description too.
 */
const BUILTIN_COMMANDS = new Map([
  ["init", "guided AGENTS.md setup"],
  ["review", "review changes [commit|branch|pr], defaults to uncommitted"],
  ["goal", "keep working until an objective is met [pause|resume|clear]"],
]);

/**
 * Whether a command opencode lists runs as a command in this session (else a
 * `/name …` message goes to the model as text): one of opencode's built-ins,
 * or a prompt of one of this session's own MCP mounts (`<mount>:<prompt>`,
 * `ownMounts` the mounts' normalized names). Another session's mount in the
 * same location lists its prompts too: run here, its server would be called
 * with that session's credential, the result landing in this conversation.
 * With `args`, a built-in carries none with a shell span: it doesn't
 * interpolate them, but a config command that took its name and description
 * would.
 */
export function runnableCommand(sessionId: string, command: { name: string; description?: string }, ownMounts: Iterable<string>, args?: string): boolean {
  const builtin = BUILTIN_COMMANDS.get(command.name);
  if (builtin !== undefined) return command.description === builtin && !args?.includes("!`");
  const prefix = ownMountPrefix(sessionId);
  for (const mount of ownMounts) if (command.name.startsWith(`${prefix}${mount}:`)) return true;
  return false;
}

/** Tools opencode must not offer at all: a deny rule hides them (see the file header). */
export const HIDDEN_TOOL_RULES: readonly OcRule[] = [
  { action: "execute", resource: "*", effect: "deny" },
  { action: "browser", resource: "*", effect: "deny" },
];

/** The session rules: ask for everything, only this session's own mounts, and never Code Mode. */
export function sessionRules(sessionId: string): OcRule[] {
  return [
    { action: "*", resource: "*", effect: "ask" },
    ...HIDDEN_TOOL_RULES,
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

/**
 * The keys of the user's global opencode config codeoid's server takes:
 * which models and providers it has. Nothing that changes what runs or what
 * asks (plugins, agents, permissions, MCP servers, instructions).
 */
const CARRIED_KEYS = ["provider", "providers", "model", "small_model", "enabled_providers", "disabled_providers"] as const;

/** The user's own opencode global config directory, as their opencode finds it. */
export function userOpencodeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "opencode");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The provider and model keys ({@link CARRIED_KEYS}) of the user's global
 * opencode config in `dir` (`opencode.json`, then `opencode.jsonc`, as
 * opencode merges them). Unreadable or absent: nothing.
 */
export function userModelConfig(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    let parsed: unknown;
    try {
      parsed = Bun.JSONC.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    for (const k of CARRIED_KEYS) {
      if (!(k in parsed)) continue;
      const prev = out[k];
      out[k] = isRecord(prev) && isRecord(parsed[k]) ? { ...prev, ...parsed[k] } : parsed[k];
    }
  }
  return out;
}

/**
 * The config injected with `OPENCODE_CONFIG_CONTENT`. `providers` adds model
 * providers (opencode's `providers` key), `carried` the user's provider and
 * model keys ({@link userModelConfig}); the policy keys aren't reachable from
 * either.
 */
export function opencodeConfig(
  overrides: Record<string, { permissions: OcRule[] }> = {},
  providers?: Record<string, unknown>,
  carried: Record<string, unknown> = {},
): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const k of CARRIED_KEYS) if (carried[k] !== undefined) models[k] = carried[k];
  const allProviders = { ...(isRecord(models.providers) ? models.providers : {}), ...(providers ?? {}) };
  delete models.providers;
  return {
    ...models,
    ...(Object.keys(allProviders).length > 0 ? { providers: allProviders } : {}),
    permissions: [{ action: "*", resource: "*", effect: "ask" }, ...HIDDEN_TOOL_RULES],
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
export function serverEnv(opts: { password: string; dbPath: string; configDir: string; config: Record<string, unknown> }): Record<string, string> {
  return {
    OPENCODE_PASSWORD: opts.password,
    OPENCODE_DB: opts.dbPath,
    // Its global config (plugins, agents, MCP servers) is codeoid's, not the
    // user's `~/.config/opencode`: a plugin there could settle permissions.
    OPENCODE_CONFIG_DIR: opts.configDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.config),
    // A repo's opencode.json could allow tools or add MCP servers codeoid
    // never sees; codeoid's own Claude-side settings aren't opencode's.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}

/**
 * Plugins a server runs that aren't opencode's own built-ins: any of them
 * could settle permission requests without codeoid seeing them.
 */
export function foreignPlugins(plugins: readonly OcPluginInfo[]): OcPluginInfo[] {
  return plugins.filter((p) => p.source?.type !== "builtin");
}

/** How a plugin is named in a refusal. */
export function describePlugin(p: OcPluginInfo): string {
  const where = p.source?.path ?? p.source?.target;
  return `${p.id ?? "(unnamed)"}${where ? ` (${where})` : ""}`;
}
