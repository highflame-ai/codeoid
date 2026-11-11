/**
 * Workstream isolation (docs/workstreams-design.md §6.1, G1, G4): with
 * `isolateGlobalServers` on, a session reaches only what its home selects —
 * on every backend — no backend holds a secret, and a server the workstream
 * drops stops on the next call.
 */

import { describe, expect, it } from "bun:test";
import type { RawMcpServerConfig } from "../config.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { secretFree, SessionMcpView } from "../daemon/mcp/session-view.js";
import { McpCredentialMissing, upstreamFetch } from "../daemon/mcp/upstream.js";
import { fingerprintOf, type WorkdirServer } from "../daemon/mcp/workdir-servers.js";
import { oauthServersForClaude } from "../daemon/providers/claude/oauth-bridge.js";
import { grantRefusal, type McpGrant } from "../daemon/workstreams/grant.js";
import { workstreamsSchema } from "../daemon/workstreams/schema.js";
import { WorkstreamService } from "../daemon/workstreams/service.js";
import { FolderReader } from "../daemon/workstreams/folder.js";
import { McpProxy } from "../daemon/mcp/proxy.js";

const TENANT = { accountId: "a", projectId: "p" };
const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
  ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "workspace", enabled: true, native: false, ...p }) as RawMcpServerConfig;
const entry = (name: string, origin: WorkdirServer["origin"], r: RawMcpServerConfig): WorkdirServer => ({
  name,
  raw: r,
  origin,
  path: origin === "claude-local" ? "/h/.claude.json" : "/w/.mcp.json",
  claudeApproval: "approved",
  fingerprint: fingerprintOf(r),
});

const REGISTRY = () =>
  new McpRegistry(
    {
      github: raw({ url: "https://gh.example/mcp" }),
      notes: raw({ command: "notes-mcp" }),
      vault: raw({ command: "vault-mcp", env: { TOKEN: "${VAULT_TOKEN}" } }),
      platform: raw({ url: "https://hf.example/mcp", headers: { "X-Api-Key": "${HF_KEY}" } }),
    },
    { memoryEnabled: true },
  );

async function view(grant: McpGrant | undefined, read: WorkdirServer[] = [], global: Record<string, RawMcpServerConfig> | null = null): Promise<SessionMcpView> {
  const v = new SessionMcpView(REGISTRY(), null, {
    workdir: "/w",
    tenant: TENANT,
    approvals: () => new Set(),
    read: async () => read,
    readGlobal: async () => global,
    grant: () => grant,
  });
  await v.load();
  return v;
}

const names = (specs: { name: string }[]) => specs.map((s) => s.name).sort();

describe("the session's view under a grant", () => {
  it("no grant: everything, as before", async () => {
    const v = await view(undefined, [entry("mine", "claude-local", raw({ command: "m" }))]);
    expect(v.isolated).toBe(false);
    expect(names(v.forBackend("codex"))).toEqual(["codeoid_memory", "github", "mine", "notes", "platform", "vault"]);
  });

  it("only built-ins and what the home selects, by name; a user-global server too only by name", async () => {
    const grant: McpGrant = { workstream: "acme", servers: new Map([["github", {}], ["slackish", {}]]), workdirServers: false };
    const v = await view(grant, [entry("mine", "claude-local", raw({ command: "m" }))], { slackish: raw({ url: "https://s.example" }), other: raw({ url: "https://o.example" }) });
    expect(v.isolated).toBe(true);
    expect(names(v.forBackend("codex"))).toEqual(["codeoid_memory", "github", "slackish"]);
  });

  it("the folder's own servers only when the folder is the home's — and on Claude too, which runs strict", async () => {
    const read = [entry("mine", "claude-local", raw({ command: "m" })), entry("repo", "claude-repo", raw({ command: "r" }))];
    const inHome = await view({ workstream: "acme", servers: new Map(), workdirServers: true }, read);
    expect(names(inHome.forBackend("claude"))).toEqual(["codeoid_memory", "mine", "repo"]);
    const override = await view({ workstream: "acme", servers: new Map(), workdirServers: false }, read);
    expect(names(override.forBackend("claude"))).toEqual(["codeoid_memory"]);
  });

  it("a server selected with a credential carries a reference, never the value, and a variant of its own", async () => {
    const v = await view({ workstream: "acme", servers: new Map([["github", { credential: { id: "gh-acme" } }]]), workdirServers: false });
    const gh = v.get("github");
    expect(gh?.transport).toMatchObject({ kind: "http", credential: { id: "gh-acme" } });
    expect(gh?.variant).toContain("#cred:gh-acme");
    expect(JSON.stringify(v.list())).not.toContain("ghp_");
  });

  it("an OAuth slot (not supported yet) or a credential a stdio server can't take: withheld, never called without it", async () => {
    const v = await view({ workstream: "acme", servers: new Map([["github", { oauthSlot: "gh-2" }], ["notes", { credential: { id: "x" } }]]), workdirServers: false });
    expect(names(v.list())).toEqual(["codeoid_memory"]);
  });

  it("CLI backends: native mounts only secret-free; credentialed HTTP through the relay; stdio needing env values withheld", async () => {
    const v = await view({ workstream: "acme", servers: new Map([["github", { credential: { id: "gh" } }], ["notes", {}], ["vault", {}], ["platform", {}]]), workdirServers: false });
    expect(names(v.forNativeMount("codex"))).toEqual(["notes"]);
    expect(names(v.relayFor("codex"))).toEqual(["github", "platform"]);
    expect(names(v.withheldFromNative("codex"))).toEqual(["vault"]);
    expect(secretFree(v.get("notes")!)).toBe(true);
  });
});

describe("credential references are resolved in the daemon, when a request is made", () => {
  const transport = (credential: { id: string; header?: string }) => ({ kind: "http" as const, url: "https://x.example/mcp", headers: {}, credential });

  it("as a bearer, or in the named header", async () => {
    const seen: Headers[] = [];
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await upstreamFetch({ name: "s", transport: transport({ id: "a" }), env: {}, secrets: () => "tok-a", fetchFn })("https://x.example/mcp", {});
    await upstreamFetch({ name: "s", transport: transport({ id: "b", header: "X-Api-Key" }), env: {}, secrets: () => "tok-b", fetchFn })("https://x.example/mcp", {});
    expect(seen[0]!.get("authorization")).toBe("Bearer tok-a");
    expect(seen[1]!.get("x-api-key")).toBe("tok-b");
  });

  it("refuses when the value is missing — the request is never sent without it", async () => {
    let sent = 0;
    const fetchFn = (async () => {
      sent++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const f = upstreamFetch({ name: "s", transport: transport({ id: "gone" }), env: {}, secrets: () => undefined, fetchFn });
    await expect(f("https://x.example/mcp", {})).rejects.toBeInstanceOf(McpCredentialMissing);
    expect(sent).toBe(0);
  });
});

describe("every call is checked against the grant as it is now (G4)", () => {
  it("the hub refuses a server the session may no longer reach, mid-turn, saying why", async () => {
    const hub = new McpHub({});
    let grant: McpGrant | undefined = { workstream: "acme", servers: new Map([["notes", {}]]), workdirServers: false };
    hub.setPermit((_sid, spec) => grantRefusal(grant, spec));
    const spec = REGISTRY().get("notes")!;
    grant = { workstream: "acme", servers: new Map(), workdirServers: false };
    const r = await hub.callTool(spec, "anything", {}, { workspaceId: "w", sessionId: "s1" });
    expect(r).toEqual({ isError: true, text: 'MCP server "notes" is not in workstream "acme"' });
    await expect(hub.listToolsOrThrow(spec, { workspaceId: "w", sessionId: "s1" })).rejects.toThrow(/not in workstream "acme"/);
  });

  it("grantRefusal: built-ins always; a changed credential applies from the next turn; folder servers by home", () => {
    const g: McpGrant = { workstream: "acme", servers: new Map([["gh", { credential: { id: "new" } }]]), workdirServers: false };
    expect(grantRefusal(g, { name: "codeoid_memory", builtin: true, transport: { kind: "in-process" } })).toBeUndefined();
    expect(grantRefusal(g, { name: "gh", builtin: false, transport: { kind: "http", credential: { id: "new" } } as never })).toBeUndefined();
    expect(grantRefusal(g, { name: "gh", builtin: false, transport: { kind: "http", credential: { id: "old" } } as never })).toMatch(/another credential/);
    expect(grantRefusal(g, { name: "mine", builtin: false, origin: "claude-local", transport: { kind: "stdio" } })).toMatch(/this folder's own/);
    expect(grantRefusal(undefined, { name: "x", builtin: false, transport: { kind: "stdio" } })).toBeUndefined();
  });
});

describe("Claude under isolation", () => {
  it("runs strict, and every reachable server is a bridge to the hub — no config, command or secret of its own", async () => {
    const v = await view({ workstream: "acme", servers: new Map([["notes", {}], ["platform", {}]]), workdirServers: false });
    const hub = new McpHub({});
    const r = oauthServersForClaude(v, hub, { workspaceId: "w", sessionId: "s", tenant: TENANT });
    expect(r.strict).toBe(true);
    const mounts = r.mounts();
    expect(Object.keys(mounts).sort()).toEqual(["notes", "platform"]);
    for (const m of Object.values(mounts)) expect(m.type).toBe("sdk");
  });

  it("without isolation nothing changes: not strict, no bridges beyond signed-in OAuth servers", async () => {
    const r = oauthServersForClaude(await view(undefined), new McpHub({}), { workspaceId: "w", sessionId: "s", tenant: TENANT });
    expect(r.strict).toBe(false);
    expect(Object.keys(r.mounts())).toEqual([]);
  });
});

describe("the relay takes the session's view (G1, G4)", () => {
  it("mints for what the session may reach on that backend, credentialed servers included", async () => {
    const v = await view({ workstream: "acme", servers: new Map([["github", { credential: { id: "gh" } }], ["notes", {}]]), workdirServers: false });
    const proxy = new McpProxy({ registry: REGISTRY(), credentials: null, baseUrl: () => "http://127.0.0.1:1" });
    expect(proxy.mint({ tenant: TENANT, sessionId: "s", backendId: "codex", view: v }).servers).toEqual(["github"]);
    // The daemon-wide registry alone (no view): its OAuth servers only, as before.
    expect(proxy.mint({ tenant: TENANT, sessionId: "s", backendId: "codex" }).servers).toEqual([]);
  });
});

describe("WorkstreamService.grantFor", () => {
  const svc = (isolate: boolean) =>
    new WorkstreamService(
      workstreamsSchema.parse({
        isolateGlobalServers: isolate,
        items: [{ id: "acme", mcpServers: ["notes", { server: "github", credential: "gh-acme" }, { server: "slack", credential: "slack-2" }, { server: "hf", credential: "hf-key" }] }],
      }),
      new FolderReader({ home: "/nonexistent", sshConfig: "" }),
      [
        { id: "gh-acme", kind: "bearer" },
        { id: "slack-2", kind: "oauth", server: "slack" },
        { id: "hf-key", kind: "header", header: "X-Api-Key" },
      ],
    );

  it("undefined with isolation off: every session keeps today's servers", () => {
    expect(svc(false).grantFor({ id: "acme", source: "explicit", revision: "r" })).toBeUndefined();
  });

  it("the home's servers with their credential references; no home, reserved or orphaned: built-ins only", () => {
    const s = svc(true);
    const g = s.grantFor({ id: "acme", source: "matched", revision: "r" });
    expect(g?.workdirServers).toBe(true);
    expect([...(g?.servers.entries() ?? [])]).toEqual([
      ["notes", {}],
      ["github", { credential: { id: "gh-acme" } }],
      ["slack", { oauthSlot: "slack-2" }],
      ["hf", { credential: { id: "hf-key", header: "X-Api-Key" } }],
    ]);
    expect(s.grantFor({ id: "acme", source: "override", revision: "r" })?.workdirServers).toBe(false);
    for (const b of [{ source: "none" as const, revision: "r" }, { id: "conductor", source: "reserved" as const, revision: "r" }, { id: "gone", source: "matched" as const, revision: "r" }, undefined]) {
      expect(s.grantFor(b)?.servers.size).toBe(0);
    }
  });
});
