/**
 * OAuth MCP servers on Claude (#390).
 *
 * The Claude CLI mounts MCP servers with its own client, and a header fixed at
 * start can't follow a token that expires and refreshes — so a server codeoid
 * signs in to can't be handed to the CLI by URL. Instead each one is mounted
 * as an in-process server, under the server's own name (so tools stay
 * `mcp__<server>__<tool>`), whose list and call go to the daemon-owned client
 * (`McpHub`) as the session's tenant. codeoid holds and refreshes the token;
 * the CLI never sees it, and nothing listens on a port.
 *
 * Tool schemas pass through as the server states them: the handlers are set on
 * the protocol server directly rather than through zod tool definitions.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpCallScope, McpHub } from "../../mcp/hub.js";
import type { McpRegistry } from "../../mcp/registry.js";
import type { McpServerSpec } from "../../mcp/types.js";

/** One OAuth server as an in-process server forwarding to the hub. */
export function oauthBridgeServer(spec: McpServerSpec, hub: McpHub, scope: McpCallScope): McpSdkServerConfigWithInstance {
  const server = new McpServer({ name: spec.name, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await hub.listTools(spec, scope)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", ...t.inputSchema } as { type: "object"; [k: string]: unknown },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await hub.callTool(spec, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, scope);
    return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
  });
  return { type: "sdk", name: spec.name, instance: server };
}

/**
 * What a Claude session gets of the registry's OAuth servers: an in-process
 * mount for each one the tenant has signed in to, and every one's URL — the
 * CLI must not ALSO connect its own copy of a server codeoid now owns (from
 * `~/.claude.json` or a `.mcp.json`), which would keep its own sign-in prompt
 * alive beside codeoid's working one. A same-name mount alone doesn't stop
 * that: the CLI still dials its copy. Denying the URL does.
 */
export function oauthServersForClaude(
  registry: McpRegistry | undefined,
  hub: McpHub | undefined,
  scope: McpCallScope,
): { mounts: () => Record<string, McpSdkServerConfigWithInstance>; deniedUrls: string[]; names: string[]; fingerprint: string } {
  const specs = (registry?.oauthFor("claude") ?? []).filter((s) => s.transport.kind === "http");
  const deniedUrls = specs.map((s) => (s.transport.kind === "http" ? s.transport.url : ""));
  const signedIn = hub ? specs.filter((s) => hub.signedIn(s, scope.tenant)) : [];
  // What the query was built with: a server adopted, removed, signed in to or
  // out of means the next turn must rebuild it.
  const fingerprint = JSON.stringify([specs.map((s, i) => [s.name, deniedUrls[i]]), signedIn.map((s) => s.name)]);
  return {
    // Built only for a query being constructed, not on every turn's check.
    mounts: () => Object.fromEntries(signedIn.map((s) => [s.name, oauthBridgeServer(s, hub!, scope)])),
    deniedUrls,
    names: specs.map((s) => s.name),
    fingerprint,
  };
}
