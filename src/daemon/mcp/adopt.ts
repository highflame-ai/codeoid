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
import { isReservedMcpName } from "./registry.js";

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
 * own config (`~/.claude.json`, `~/.claude/`). A cloned repo can put anything
 * there, so such a server is adopted only once Claude itself has approved and
 * connected it — and adopting makes it daemon-wide.
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
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name.includes("__")) {
    return { ok: false, reason: `codeoid adopts servers with plain names (letters, digits, - and _, no "__"); rename ${JSON.stringify(name)} in Claude's config first` };
  }
  return { ok: true };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
  // wildcard would deny every server it matches.
  if (server.url.includes("*")) return { ok: false, reason: `${server.name}'s URL contains a wildcard` };
  return { ok: true, url: server.url };
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
