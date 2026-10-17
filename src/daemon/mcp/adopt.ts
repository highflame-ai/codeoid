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
import { McpServerSchema, type RawMcpServerConfig } from "../../config.js";
import type { ClaudeConfigMcpServer } from "../../protocol/types.js";
import { readClaudeConfig } from "../claude-config.js";

/** Find a server by name in Claude's config: the workdir's and the global ones
 *  for a session's workdir, else the global ones only. */
export async function findClaudeMcpServer(name: string, workdir: string | null): Promise<ClaudeConfigMcpServer | undefined> {
  const snapshot = await readClaudeConfig(workdir ?? os.homedir());
  const all = workdir ? snapshot.mcpServers : snapshot.mcpServers.filter((s) => s.scope === "global");
  // A workdir entry overrides a global one of the same name, as in the CLI.
  return all.find((s) => s.name === name && s.scope === "workdir") ?? all.find((s) => s.name === name);
}

/** Whether codeoid can adopt this server, and if not, why — said to the user. */
export function adoptability(server: ClaudeConfigMcpServer): { ok: true; url: string } | { ok: false; reason: string } {
  if (!server.url) {
    return { ok: false, reason: `${server.name} runs a local command; only a remote (HTTP) MCP server signs in with OAuth` };
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
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `${server.name}'s URL isn't an http(s) one` };
  }
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
