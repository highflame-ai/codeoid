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
import { isAbsolute, join, resolve } from "node:path";
import { OPENCODE_MODEL_ID } from "../../../config.js";
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
 *
 * Not `goal`: after every round its plugin sends the model a reviewer
 * request of its own (`plugin/goal.ts` `judge`, up to 50 rounds), which no
 * step, `usage.updated` or session total of opencode's reports, so neither
 * the turn's cost nor `maxBudgetUsd` would see it.
 */
const BUILTIN_COMMANDS = new Map([
  ["init", "guided AGENTS.md setup"],
  ["review", "review changes [commit|branch|pr], defaults to uncommitted"],
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
 * opencode's `webfetch` follows redirects itself, checking each hop only
 * against the rules (a hop is never asked about: under ask-everything, every
 * one passes). So while an approved fetch runs, its session's rules also
 * carry this fence: every other site is denied, and a redirect there fails
 * the call — the model has to fetch the new address as a call of its own,
 * which asks. Hops on an approved fetch's own origin still pass. `origins`:
 * of the session's approved fetches still running; null for one whose
 * origin can't be pinned (none of its hops pass).
 */
export function fetchFence(origins: Iterable<string | null>): OcRule[] {
  const pinned = [...new Set([...origins].filter((o): o is string => o !== null))];
  return [
    { action: "webfetch", resource: "*", effect: "deny" },
    ...pinned.map((origin) => ({ action: "webfetch", resource: `${origin}/*`, effect: "ask" as const })),
  ];
}

/**
 * The origin a fetch of `url` stays on, as opencode writes each hop's URL
 * (`URL.href`: `<origin>/…`). Null when it can't be pinned: not http(s), or a
 * `*` in it (a wildcard in a rule).
 */
export function fetchOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin.includes("*")) return null;
    return u.origin;
  } catch {
    return null;
  }
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
 * asks (plugins, agents, permissions, MCP servers, instructions); within
 * them, only what {@link userModelConfig} lets through.
 */
const CARRIED_KEYS = ["provider", "providers", "model", "small_model", "enabled_providers", "disabled_providers"] as const;

const SUBSTITUTION = /\{(?:file|env):/;

/**
 * Whether a config value holds an opencode substitution (`{file:…}` /
 * `{env:…}`): opencode expands them anywhere in the config's text, a
 * relative file against the location it loads (a session's workdir).
 */
export function hasSubstitution(value: unknown): boolean {
  if (typeof value === "string") return SUBSTITUTION.test(value);
  if (Array.isArray(value)) return value.some(hasSubstitution);
  if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => SUBSTITUTION.test(k) || hasSubstitution(v));
  return false;
}

/**
 * The AI SDK package names opencode 2.2.5 maps onto providers it bundles
 * (`@opencode/ai/providers/…`); anything else it imports (`file://`, an
 * installed module) or installs from npm and imports, inside the server.
 */
const BUNDLED_PACKAGE_ALIASES = new Set([
  "@ai-sdk/amazon-bedrock", "@ai-sdk/alibaba", "@ai-sdk/anthropic", "@ai-sdk/azure", "@ai-sdk/cerebras", "@ai-sdk/cohere",
  "@ai-sdk/deepinfra", "@ai-sdk/google", "@ai-sdk/google-vertex", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/groq",
  "@ai-sdk/mistral", "@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/togetherai", "@ai-sdk/xai", "@ai-sdk/gateway",
  "@openrouter/ai-sdk-provider", "ai-gateway-provider", "venice-ai-sdk-provider",
]);
const BUNDLED_PACKAGE = /^@opencode\/ai\/providers\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

/** The first provider package (`package`, v1's `npm`) in a config entry that isn't one opencode bundles. */
function foreignPackage(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(foreignPackage).find((p) => p !== undefined);
  if (!isRecord(value)) return undefined;
  for (const [k, v] of Object.entries(value)) {
    if ((k === "package" || k === "npm") && !(typeof v === "string" && (BUNDLED_PACKAGE.test(v) || BUNDLED_PACKAGE_ALIASES.has(v)))) return String(v);
    const nested = foreignPackage(v);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** A key anywhere in `value` that holds a substitution: opencode would expand it too. */
function substitutionInKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(substitutionInKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([k, v]) => SUBSTITUTION.test(k) || substitutionInKey(v));
}

/**
 * `value` with each relative `{file:…}` made absolute against the user's
 * config dir `dir`, as their own opencode reads it (`~/…` and absolute ones
 * stay): codeoid's server would read it against the location it loads, a
 * session's workdir. Null when a path can't be written back faithfully
 * (`}`, or anything JSON escapes).
 */
function rebasedFileReferences(value: unknown, dir: string): unknown {
  if (typeof value === "string") {
    let ok = true;
    const out = value.replace(/\{file:([^}]+)\}/g, (ref, path: string) => {
      if (path.startsWith("~/") || isAbsolute(path)) return ref;
      const abs = resolve(dir, path);
      if (/[}"\\\u0000-\u001f]/.test(abs)) ok = false;
      return `{file:${abs}}`;
    });
    return ok ? out : null;
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => rebasedFileReferences(v, dir));
    return out.includes(null) ? null : out;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const r = rebasedFileReferences(v, dir);
    if (r === null) return null;
    out[k] = r;
  }
  return out;
}

/**
 * What codeoid's server may take of one carried key from the user's config
 * in `dir`. A provider entry is dropped whole when it names a package
 * opencode doesn't bundle (opencode would import it — a `file://` module,
 * or one it installs from npm — into the server, with the injected config
 * in its environment), or holds an `{env:…}` (it reads the server's
 * environment, its password included; no key is there). Its relative
 * `{file:…}` references are made the user's config dir's. A default model
 * must be a `provider/model` id (`OPENCODE_MODEL_ID`), as codeoid's own is.
 */
function carriedValue(key: (typeof CARRIED_KEYS)[number], value: unknown, dir: string, skipped: string[]): unknown {
  if (key === "provider" || key === "providers") {
    if (!isRecord(value)) return undefined;
    const kept: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(value)) {
      const pkg = foreignPackage(entry);
      const rebased = pkg === undefined ? rebasedFileReferences(entry, dir) : null;
      if (pkg !== undefined) skipped.push(`${key}.${id}: its package ${JSON.stringify(pkg)} isn't one opencode bundles, and opencode would load it into codeoid's server`);
      else if (/\{env:/.test(JSON.stringify(entry)) || SUBSTITUTION.test(id) || substitutionInKey(entry)) {
        skipped.push(`${key}.${id}: it holds an {env:…} reference, which codeoid's server would read from its own environment (no key is there; name a key with {file:…})`);
      } else if (rebased === null) skipped.push(`${key}.${id}: a {file:…} path in it can't be passed on as written`);
      else kept[id] = rebased;
    }
    return kept;
  }
  if (key === "model" || key === "small_model") {
    if (typeof value === "string" && OPENCODE_MODEL_ID.test(value)) return value;
    skipped.push(`${key}: it isn't a \`provider/model\` id (no \`{\`, \`}\`, quotes or spaces)`);
    return undefined;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string") && !hasSubstitution(value)) return value;
  skipped.push(`${key}: it isn't a list of provider ids`);
  return undefined;
}

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
 * opencode merges them), less what {@link carriedValue} drops (each said in
 * `skipped`). Unreadable or absent: nothing.
 */
export function userModelConfig(dir: string, skipped: string[] = []): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
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
      const prev = merged[k];
      merged[k] = isRecord(prev) && isRecord(parsed[k]) ? { ...prev, ...parsed[k] } : parsed[k];
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of CARRIED_KEYS) {
    if (!(k in merged)) continue;
    const v = carriedValue(k, merged[k], dir, skipped);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The config injected with `OPENCODE_CONFIG_CONTENT`. `providers` adds model
 * providers (opencode's `providers` key: codeoid's credentials, see
 * credentials.ts), `carried` the user's provider and model keys
 * ({@link userModelConfig}); the policy keys aren't reachable from either.
 * A provider codeoid configures replaces the user's of the same id (under
 * `providers` and the older `provider`): the user's own stands only where
 * codeoid has nothing. `model` (`providers.opencode.model`) is the default
 * model, over the user's, when it is a `provider/model` id
 * (`OPENCODE_MODEL_ID`): one holding a substitution would have opencode read
 * a file or variable into the model id it sends with every request.
 */
export function opencodeConfig(
  overrides: Record<string, { permissions: OcRule[] }> = {},
  providers?: Record<string, unknown>,
  carried: Record<string, unknown> = {},
  opts: { model?: string } = {},
): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const k of CARRIED_KEYS) if (carried[k] !== undefined) models[k] = carried[k];
  const ours = providers ?? {};
  const allProviders = { ...(isRecord(models.providers) ? models.providers : {}), ...ours };
  delete models.providers;
  if (isRecord(models.provider)) {
    const legacy = Object.fromEntries(Object.entries(models.provider).filter(([id]) => !(id in ours)));
    if (Object.keys(legacy).length > 0) models.provider = legacy;
    else delete models.provider;
  }
  if (opts.model && OPENCODE_MODEL_ID.test(opts.model)) models.model = opts.model;
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
 * Environment for the opencode server: what opencode needs to run and no
 * credential at all — no `*_API_KEY` / `*_API_TOKEN`, no provider-prefixed
 * variable, no `CODEOID_AGENT_ENV_ALLOW` name, no codeoid token. opencode
 * runs some shell lines without asking, and a subagent codeoid hasn't set a
 * shell environment for yet runs its shell with this one, so anything here
 * could be printed into a result the model reads. Model keys reach opencode
 * through its config, from files (credentials.ts). The user's own
 * `OPENCODE_*` settings don't pass either: a password, database or config
 * dir from the user's environment would point the private server at the
 * user's own opencode. codeoid sets its own ({@link serverEnv}).
 */
export function buildOpencodeEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  return basicEnv(base);
}

/** Anything that could substitute, redirect, pipe, group, escape or background: never in a {@link commandlessShellLine}. */
const SHELL_ACTIVE = /[$`<>|(){}\\!]|(?<!&)&(?!&)|&&&/;
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Builtins that only change the shell's own state (it ends with the call), given names or assignments. */
const SHELL_STATE_BUILTINS = new Set(["export", "unset", "readonly"]);
/** Declaration builtins 2.2.5's scanner finds no command in, whatever their words: with options or none, they list the shell's state. */
const SHELL_DECLARATION_BUILTINS = new Set(["export", "unset", "readonly", "declare", "typeset", "local"]);
const SHELL_OPTION = /^-[A-Za-z]+$/;

/**
 * A shell line opencode runs without asking, as 2.2.5 does a line its
 * scanner finds no command in (`shell.ts`: it asks only `if
 * (parsed.commands.length > 0)`), that can do nothing outside the shell
 * process of the call: only assignments, `cd`, `export`/`unset`/`readonly`,
 * comments and separators (`;`, `&&`, newlines), with no substitution,
 * expansion, redirection, pipe, group, escape or background in it. Such a
 * call succeeding unasked is opencode's own rule, not something settling
 * requests behind codeoid's back. Conservative: any other line that ran
 * unasked still stops the server.
 *
 * With `listing`, a declaration builtin given options or nothing
 * (`export -p`, `declare -p`, `unset -v X`, `local`) counts too: it prints
 * the shell's variables or functions. Only for a shell whose environment
 * is known to be codeoid's bare one (the session's, set before its turn):
 * a subagent's may still be the server's, password and all, when a feed
 * gap hid its start, and such a listing stopping the server is what
 * changes that password.
 */
export function commandlessShellLine(line: string, opts: { listing?: boolean } = {}): boolean {
  // A comment runs nothing, whatever it holds (`# $(…)`): judged without them.
  const command = withoutComments(line);
  if (command === null || SHELL_ACTIVE.test(command)) return false;
  const segments: string[][] = [[]];
  let word: string | null = null;
  const end = () => {
    if (word !== null) segments.at(-1)!.push(word);
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      if (close < 0) return false;
      word = (word ?? "") + command.slice(i + 1, close);
      i = close;
    } else if (ch === "#" && word === null) {
      // A comment, to the end of its line.
      const nl = command.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
    } else if (ch === ";" || ch === "\n" || ch === "&") {
      end();
      segments.push([]);
      if (ch === "&") i++; // `&&` (a lone `&` is refused above)
    } else if (ch === " " || ch === "\t") {
      end();
    } else {
      word = (word ?? "") + ch;
    }
  }
  end();
  return segments.every(([first, ...rest]) => {
    if (first === undefined) return true;
    if (first === "cd") return rest.length <= 2;
    const declaration = (w: string) => SHELL_NAME.test(w) || SHELL_ASSIGNMENT.test(w);
    // With no name, or an option (`export -p`), they print variables instead.
    if (opts.listing && SHELL_DECLARATION_BUILTINS.has(first)) return rest.every((w) => declaration(w) || SHELL_OPTION.test(w));
    if (SHELL_STATE_BUILTINS.has(first)) return rest.length > 0 && rest.every(declaration);
    return [first, ...rest].every((w) => SHELL_ASSIGNMENT.test(w));
  });
}

/**
 * A shell line less its comments, as the shell reads them: an unquoted `#`
 * that starts a word, to the end of its line. Null with a quote left open.
 * A `#` after anything but a blank, `;`, `&` or a newline is kept (it may
 * not start a word): a line keeping one is judged as written.
 */
function withoutComments(line: string): string | null {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1);
      if (close < 0) return null;
      out += line.slice(i, close + 1);
      i = close;
    } else if (ch === "#" && (i === 0 || " \t;&\n".includes(line[i - 1]!))) {
      const nl = line.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** What the server and a session's shell keep of the daemon's environment: nothing secret-bearing. */
const SHELL_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR", "TEMP", "TMP", "COLORTERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
const SHELL_PROXY = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
/** The user's own XDG base dirs: a session's commands use them, as the user's would. The server's are codeoid's ({@link serverEnv}). */
const XDG_DIRS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"] as const;

function basicEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SHELL_EXACT.has(k) || k.startsWith("LC_") || (SHELL_PROXY.has(k) && !proxyHasCredentials(v))) env[k] = v;
  }
  return env;
}

/**
 * The environment a codeoid session's shell commands run with (set per
 * opencode session: `PUT …/environment`; opencode uses the server's own
 * otherwise). opencode asks about a shell line only when its scanner finds a
 * command in it, so a line of assignments runs unasked and can print any
 * variable it expands (`X=${U?$PASSWORD}`). The server's environment carries
 * its password and the injected config: none of it reaches the shell. Only
 * basics, locale, CA trust, proxies that carry no credentials, and the
 * daemon's own XDG base dirs and TMPDIR (never the server's, which point into
 * codeoid's opencode data dir); no model key, no `CODEOID_AGENT_ENV_ALLOW` name.
 */
export function opencodeShellEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = basicEnv(base);
  for (const k of XDG_DIRS) {
    const v = base[k];
    if (v) env[k] = v;
  }
  return env;
}

function proxyHasCredentials(value: string): boolean {
  try {
    const u = new URL(value.includes("://") ? value : `http://${value}`);
    return u.username !== "" || u.password !== "";
  } catch {
    // Not a URL (NO_PROXY's host list): credentials would need an `@`.
    return value.includes("@");
  }
}

/**
 * Where opencode keeps its data, logs, state, caches and temp files under
 * codeoid's opencode data dir (`providers.opencode.dataDir`): its XDG base
 * dirs, and its `TMPDIR` (opencode's own tmp is `$TMPDIR/opencode`, created
 * at every start and where `image_generate` saves by default: never a shared
 * `/tmp/opencode` another local user could have made first).
 */
export function opencodeServerDirs(dataDir: string): { XDG_DATA_HOME: string; XDG_STATE_HOME: string; XDG_CACHE_HOME: string; TMPDIR: string } {
  return { XDG_DATA_HOME: join(dataDir, "data"), XDG_STATE_HOME: join(dataDir, "state"), XDG_CACHE_HOME: join(dataDir, "cache"), TMPDIR: join(dataDir, "tmp") };
}

/**
 * The shell opencode runs a session's lines with: the `bash` on `PATH`, else
 * `/bin/sh` (opencode's own fallback). opencode 2.2.5 takes the server's
 * `$SHELL` for any shell but fish and nu, `-Command` for pwsh, while codeoid
 * judges every line as bash reads it (#431): a login shell that reads a line
 * otherwise (pwsh, tcsh, xonsh) could run what the card doesn't show.
 */
export function opencodeServerShell(path: string | undefined = process.env.PATH): string {
  return Bun.which("bash", { PATH: path ?? "" }) ?? "/bin/sh";
}

/** The server's own settings, set last over {@link buildOpencodeEnv}. */
export function serverEnv(opts: { password: string; dbPath: string; configDir: string; dataDir: string; config: Record<string, unknown>; shell?: string }): Record<string, string> {
  return {
    // The shell its lines run with is the one codeoid judges them as; a
    // session's commands still see the user's own `$SHELL` (opencodeShellEnv).
    SHELL: opts.shell ?? opencodeServerShell(),
    // Its logs, shell output, state, caches and temp files: codeoid's, never
    // the user's `~/.local/share/opencode`, `~/.cache/opencode` or a shared
    // `/tmp/opencode`. A session's shell keeps the user's own (opencodeShellEnv).
    ...opencodeServerDirs(opts.dataDir),
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
