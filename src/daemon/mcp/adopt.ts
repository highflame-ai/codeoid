/**
 * Adopting an MCP server from Claude's own config into codeoid's registry
 * (#390).
 *
 * A remote server in `~/.claude.json`, a `.mcp.json` or Claude's settings is
 * connected by the Claude CLI, which can only run its OAuth sign-in in an
 * interactive terminal — a codeoid session drives Claude through the SDK and
 * never can, so such a server just reports "needs authentication". Adopting it
 * puts the same URL in codeoid's registry with `oauth: true`: codeoid signs in
 * (from any frontend), holds and refreshes the token, and serves the server to
 * its backends — Claude included, through an in-process mount, with the CLI's
 * own copy denied so it isn't connected twice.
 *
 * codeoid never reads or writes the CLI's credentials: the sign-in is codeoid's
 * own. Headers in Claude's entry are not carried over — an OAuth server is
 * authorized by its token, and copying them would put whatever they hold into
 * codeoid's config.
 */

import os from "node:os";
import path from "node:path";
import { McpServerSchema, type RawMcpServerConfig } from "../../config.js";
import type { ClaudeConfigMcpServer } from "../../protocol/types.js";
import { readClaudeConfig } from "../claude-config.js";
import { redactMcpUrl } from "./redact.js";
import { isReservedMcpName, type McpRegistry } from "./registry.js";
import { mcpToolPrefix } from "./types.js";

/** Every server in Claude's config: the global ones, plus the workdir's for a
 *  session's workdir. */
export async function claudeMcpServers(workdir: string | null): Promise<ClaudeConfigMcpServer[]> {
  const snapshot = await readClaudeConfig(workdir ?? os.homedir());
  return workdir ? snapshot.mcpServers : snapshot.mcpServers.filter((s) => s.scope === "global");
}

/**
 * Why adopting `chosen` would be refused, or null — the one rule the adopt
 * handler, the drawer's offer and the reconnect hint all apply, so neither
 * of the last two suggests what the first refuses. `all` is every entry in
 * Claude's config the caller can see (adopting denies the CLI's copy at that
 * URL whatever it's called there).
 */
export function adoptionRefusal(
  chosen: ClaudeConfigMcpServer,
  all: readonly ClaudeConfigMcpServer[],
  registry: McpRegistry,
  daemonOrigins: readonly string[],
): string | null {
  const named = adoptableName(chosen.name);
  if (!named.ok) return named.reason;
  const can = adoptability(chosen);
  if (!can.ok) return can.reason;
  if (isDaemonEndpoint(can.url, daemonOrigins)) return `${chosen.name} is one of this daemon's own endpoints`;
  // Every entry at that address, whatever its name, must be adoptable: a
  // repo's header-less copy mustn't stand in for the user's own
  // header-authorized server (which would be denied along with it).
  for (const other of all) {
    if (other === chosen || other.url !== can.url) continue;
    const ok = adoptability(other);
    if (!ok.ok) return ok.reason;
  }
  // A project's own server can't take a name the user's own config gives
  // another address: it would stand in for theirs in every session.
  // Compared loosely (case, "-" vs "_"): a look-alike would sit beside
  // theirs with near-identical tools.
  const loose = (n: string) => n.toLowerCase().replace(/-/g, "_");
  const own = all.find((o) => loose(o.name) === loose(chosen.name) && !fromRepoFile(o) && o.url !== can.url);
  if (fromRepoFile(chosen) && own) {
    return `this project's ${chosen.name} would stand in for your own ${own.name}, at another address`;
  }
  return registryConflict(registry, chosen.name, can.url);
}

/**
 * Whether the entry comes from a file the workdir's repo controls (a
 * `.mcp.json`, the project's `.claude/` settings) rather than from the user's
 * own config (`~/.claude.json`, `~/.claude/`). A cloned repo can name any URL
 * there — and a codeoid session's CLI connects it without asking (measured) —
 * so such a server is adopted only when the caller names its URL: consent to
 * that address, which adopting makes daemon-wide.
 */
export function fromRepoFile(server: ClaudeConfigMcpServer): boolean {
  if (server.scope !== "workdir") return false;
  // readClaudeConfig reads one file of that name — the user's own
  // ~/.claude.json (its projects[workdir] entries); every file a repo
  // controls has another (.mcp.json, .claude/settings*.json).
  return path.basename(server.path) !== ".claude.json";
}

/**
 * Whether adopting this entry takes its full URL, not the one shown (#394):
 * a project's server whose URL has parts hidden. Naming a repo's URL is the
 * consent to it, and consent to "https://host/…/mcp" isn't consent to the
 * tenant or query a repo put behind the "…". (The user's own URLs match as
 * shown: what's hidden there is their own credential.)
 */
export function fullUrlRequired(server: ClaudeConfigMcpServer): boolean {
  return fromRepoFile(server) && server.url !== null && redactMcpUrl(server.url) !== server.url;
}

/**
 * Whether a name may be adopted as is. Adopted names stay plain: no
 * characters the CLI rewrites in tool names, no `__` (the tool-name
 * separator), never one of codeoid's built-ins in any spelling.
 */
export function adoptableName(name: string): { ok: true } | { ok: false; reason: string } {
  if (isReservedMcpName(name)) return { ok: false, reason: `${name} is the name of a codeoid built-in server` };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name.includes("__") || name.startsWith("-")) {
    return { ok: false, reason: `codeoid adopts servers with plain names (letters, digits, - and _, no "__"); rename ${JSON.stringify(name)} in Claude's config first` };
  }
  return { ok: true };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Any spelling of this machine: localhost (and *.localhost), 127.0.0.0/8,
 *  0.0.0.0, ::1, ::, ::ffff:127.x. */
function isLoopbackHost(host: string): boolean {
  return (
    LOOPBACK.has(host) ||
    host === "0.0.0.0" ||
    host === "[::]" ||
    /(^|\.)localhost\.?$/i.test(host) ||
    /^127\./.test(host) ||
    /^\[::ffff:(127\.|7f)/i.test(host)
  );
}

/**
 * Whether a URL points at this daemon's own endpoints (its blackboard and
 * memory servers live there): adopting one would put codeoid's own server on
 * the CLI's denylist. `origins` are the daemon's (its own URL, and any front
 * end a client reaches it by); a loopback URL on one of their ports counts.
 */
export function isDaemonEndpoint(url: string, origins: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const portOf = (x: URL) => x.port || (x.protocol === "https:" || x.protocol === "wss:" ? "443" : "80");
  return origins.some((o) => {
    try {
      const d = new URL(o);
      return d.host === u.host || (isLoopbackHost(u.hostname) && portOf(d) === portOf(u));
    } catch {
      return false;
    }
  });
}

/** Whether codeoid can adopt this server, and if not, why — said to the user. */
export function adoptability(server: ClaudeConfigMcpServer): { ok: true; url: string } | { ok: false; reason: string } {
  if (!server.url) {
    return { ok: false, reason: `${server.name} runs a local command; only a remote (HTTP) MCP server signs in with OAuth` };
  }
  // Configured with headers (a bearer, an API key, a token under any name):
  // adopting drops them, for a sign-in the server may not offer.
  if ((server.headerKeys ?? []).length > 0) {
    return { ok: false, reason: `${server.name} is configured with headers in Claude's config (often its authorization), which adopting would drop` };
  }
  if (server.type === "sse") {
    return { ok: false, reason: `${server.name} uses the older SSE transport, which codeoid's MCP client doesn't speak` };
  }
  if (server.type !== null && server.type !== "http") {
    return { ok: false, reason: `${server.name} is a "${server.type}" server, not a remote HTTP one` };
  }
  // The URL is shown for consent and stored as is: the parser would quietly
  // drop a newline or tab, which could carry text into the prompt.
  // Long enough that it couldn't be shown in full: refused, rather than
  // asking for consent to an address the user can't read.
  if (server.url.length > 2048) return { ok: false, reason: `${server.name}'s URL is unusually long (over 2048 characters)` };
  // ASCII only (an international domain in its punycode form): anything
  // else is either invisible or rewritten by the parser.
  if (/[\s\u0000-\u001f\u007f-\uffff]/.test(server.url)) {
    return { ok: false, reason: `${server.name}'s URL contains spaces, control or non-ASCII characters (write an international domain in its xn-- form)` };
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    return { ok: false, reason: `${server.name}'s URL isn't one codeoid can read` };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    // A token codeoid holds must not travel in the clear.
    return { ok: false, reason: `${server.name}'s URL isn't an https one (plain http is only for this machine)` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: `${server.name}'s URL carries credentials; an adopted server is signed in to by codeoid` };
  }
  // The URL is also what the CLI's own copy is denied by, as a pattern: a
  // wildcard would deny every server it matches, and the CLI expands ${VAR}
  // in it, which codeoid's own copy wouldn't.
  if (/[*${}]/.test(server.url)) return { ok: false, reason: `${server.name}'s URL contains a wildcard or a \${…} reference` };
  return { ok: true, url: server.url };
}

/**
 * Why adopting `name` at `url` would collide with a server codeoid already
 * has, or null: an entry of that name at another address (however it got
 * there), or another whose tools would get the same names.
 */
export function registryConflict(registry: McpRegistry, name: string, url: string): string | null {
  const existing = registry.get(name);
  if (existing && !(existing.transport.kind === "http" && existing.transport.url === url)) {
    return `codeoid already has a server named ${JSON.stringify(name)} at another address; change or remove it in codeoid's config first`;
  }
  const clash = registry.list().find((s) => s.name !== name && mcpToolPrefix(s.name) === mcpToolPrefix(name));
  if (clash) return `${JSON.stringify(name)} and codeoid's ${JSON.stringify(clash.name)} would give their tools the same names`;
  return null;
}

/** One argument for a shell command line shown to the user, quoted so it runs as shown. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_.:/@+=-]+$/.test(value) && !value.startsWith("-") ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The registry entry an adopted server gets: the same URL, signed in by codeoid. */
export function adoptedEntry(url: string): { entry: Record<string, unknown>; raw: RawMcpServerConfig } {
  // `trust: prompt`: a user's server is not assumed read-only (as on import).
  const entry = { url, oauth: true, trust: "prompt" };
  return { entry, raw: McpServerSchema.parse(entry) };
}

/** Whether an existing config.json entry already IS this adoption (same URL, OAuth). */
export function isSameAdoption(existing: Record<string, unknown>, url: string): boolean {
  return existing.url === url && existing.oauth !== undefined && existing.oauth !== false;
}
