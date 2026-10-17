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
import { isReservedMcpName, type McpRegistry } from "./registry.js";
import { mcpToolPrefix } from "./types.js";

/** Every server of that name in Claude's config: the global ones, plus the
 *  workdir's for a session's workdir. The same name can mean two servers. */
export async function findClaudeMcpServers(name: string, workdir: string | null): Promise<ClaudeConfigMcpServer[]> {
  const snapshot = await readClaudeConfig(workdir ?? os.homedir());
  const all = workdir ? snapshot.mcpServers : snapshot.mcpServers.filter((s) => s.scope === "global");
  return all.filter((s) => s.name === name);
}

/**
 * Whether the entry comes from a file the workdir's repo controls (a
 * `.mcp.json`, the project's `.claude/` settings) rather than from the user's
 * own config (`~/.claude.json`, `~/.claude/`). A cloned repo can name any URL
 * there — and a codeoid session's CLI connects it without asking (measured) —
 * so such a server is adopted only when the caller names its URL: consent to
 * that address, which adopting makes daemon-wide.
 */
export function fromRepoFile(server: ClaudeConfigMcpServer, home: string = os.homedir()): boolean {
  if (server.scope !== "workdir") return false;
  return path.resolve(server.path) !== path.join(home, ".claude.json");
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

/** Any spelling of this machine: localhost, 127.0.0.0/8, ::1, ::ffff:127.x. */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host) || host === "localhost." || /^127\./.test(host) || /^\[::ffff:(127\.|7f)/i.test(host);
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
  // Authorized by a header already (a bearer, an API key): adopting would drop
  // it for a sign-in the server may not offer.
  if ((server.headerKeys ?? []).some((h) => /^(authorization|x-api-key|api-key)$/i.test(h))) {
    return { ok: false, reason: `${server.name} is authorized by a header in Claude's config, not an OAuth sign-in` };
  }
  if (server.type === "sse") {
    return { ok: false, reason: `${server.name} uses the older SSE transport, which codeoid's MCP client doesn't speak` };
  }
  if (server.type !== null && server.type !== "http") {
    return { ok: false, reason: `${server.name} is a "${server.type}" server, not a remote HTTP one` };
  }
  // The URL is shown for consent and stored as is: the parser would quietly
  // drop a newline or tab, which could carry text into the prompt.
  if (/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(server.url)) {
    return { ok: false, reason: `${server.name}'s URL contains spaces or control characters` };
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
