/**
 * OAuth registry servers on Claude (#390): an in-process server in front of the
 * daemon-owned client, mounted only once the tenant has signed in, with every
 * OAuth server's URL denied to the CLI so its own copy isn't connected too.
 */

import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServerSchema } from "../config.js";
import type { McpCallScope, McpHub } from "../daemon/mcp/hub.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import type { McpServerSpec } from "../daemon/mcp/types.js";
import { oauthBridgeServer, oauthServersForClaude } from "../daemon/providers/claude/oauth-bridge.js";

const SCOPE: McpCallScope = { workspaceId: "ws", sessionId: "s1", tenant: { accountId: "acc", projectId: "proj" } };

function registry(): McpRegistry {
  return new McpRegistry(
    {
      notes: McpServerSchema.parse({ url: "https://notes.example.com/mcp", oauth: true }),
      tracker: McpServerSchema.parse({ url: "https://tracker.example.com/mcp", oauth: true }),
      codexOnly: McpServerSchema.parse({ url: "https://c.example.com/mcp", oauth: true, backends: ["codex"] }),
      plain: McpServerSchema.parse({ url: "https://plain.example.com/mcp" }),
    },
    { memoryEnabled: false },
  );
}

/** A hub stand-in: who is signed in, and what list/call answer. */
function fakeHub(signedIn: Set<string>, calls: Array<{ server: string; tool: string; args: unknown; scope: McpCallScope }> = []): McpHub {
  return {
    signedIn: (spec: McpServerSpec) => signedIn.has(spec.name),
    listToolsOrThrow: async (spec: McpServerSpec) => {
      if (spec.name === "broken") throw new Error("broken needs sign-in — connect it in Settings (MCP servers)");
      return [{ name: "search", description: `search ${spec.name}`, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }];
    },
    callTool: async (spec: McpServerSpec, tool: string, args: Record<string, unknown>, scope: McpCallScope) => {
      calls.push({ server: spec.name, tool, args, scope });
      return { text: `${spec.name}/${tool}: ${JSON.stringify(args)}`, isError: false };
    },
  } as unknown as McpHub;
}

describe("oauthServersForClaude", () => {
  it("mounts only signed-in OAuth servers for claude, and denies every one's URL", () => {
    const got = oauthServersForClaude(registry(), fakeHub(new Set(["notes"])), SCOPE);
    expect(Object.keys(got.mounts())).toEqual(["notes"]);
    expect(got.mounts().notes).toMatchObject({ type: "sdk", name: "notes" });
    // tracker isn't signed in: not mounted, but the CLI still mustn't connect its own copy.
    expect(got.deniedUrls).toEqual(["https://notes.example.com/mcp", "https://tracker.example.com/mcp"]);
    // not codexOnly (not for claude), not plain (not OAuth: the CLI mounts that one)
  });

  it("a sign-in changes what's mounted, not what the query is built with; adopting changes both", () => {
    const signed = new Set<string>();
    const reg = registry();
    const a = oauthServersForClaude(reg, fakeHub(signed), SCOPE);
    expect(oauthServersForClaude(reg, fakeHub(signed), SCOPE)).toMatchObject({ fingerprint: a.fingerprint, mountFingerprint: a.mountFingerprint });
    signed.add("tracker");
    const b = oauthServersForClaude(reg, fakeHub(signed), SCOPE);
    expect(b.fingerprint).toBe(a.fingerprint); // no rebuild for a sign-in
    expect(b.mountFingerprint).not.toBe(a.mountFingerprint); // a live update instead
    reg.upsert("another", McpServerSchema.parse({ url: "https://another.example.com/mcp", oauth: true }));
    expect(oauthServersForClaude(reg, fakeHub(signed), SCOPE).fingerprint).not.toBe(a.fingerprint); // a new denylist: rebuild
  });

  it("with no hub or registry, mounts nothing and denies nothing", () => {
    expect(oauthServersForClaude(undefined, undefined, SCOPE)).toMatchObject({ deniedUrls: [] });
    expect(Object.keys(oauthServersForClaude(registry(), undefined, SCOPE).mounts())).toEqual([]);
  });
});

describe("the in-process bridge", () => {
  it("lists the server's tools with their own schemas and calls them through the hub as the session's tenant", async () => {
    const calls: Array<{ server: string; tool: string; args: unknown; scope: McpCallScope }> = [];
    const spec = registry().get("notes")!;
    const bridge = oauthBridgeServer(spec, fakeHub(new Set(["notes"]), calls), SCOPE);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await bridge.instance.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      { name: "search", description: "search notes", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    ]);
    const r = await client.callTool({ name: "search", arguments: { q: "roadmap" } });
    expect(r).toMatchObject({ content: [{ type: "text", text: 'notes/search: {"q":"roadmap"}' }], isError: false });
    expect(calls).toEqual([{ server: "notes", tool: "search", args: { q: "roadmap" }, scope: SCOPE }]);
    await client.close();
  });

  it("a server it can't list (signed out, revoked, down) is an error, not a healthy server with no tools", async () => {
    const spec = { ...registry().get("notes")!, name: "broken" };
    const bridge = oauthBridgeServer(spec, fakeHub(new Set(["broken"])), SCOPE);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await bridge.instance.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    await expect(client.listTools()).rejects.toThrow("needs sign-in");
    await client.close();
  });
});
