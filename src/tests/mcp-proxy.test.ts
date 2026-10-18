/**
 * The loopback MCP relay (#396, docs/mcp-oauth-design.md §5.1): Codex, the
 * Gemini CLI and Qwen reach OAuth servers through it with a per-session proxy
 * token, and never hold the upstream token.
 *
 * A real SDK client plays the backend; behind the relay is a spec-shaped
 * OAuth-protected MCP server (an SDK server too).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ResultSchema as ResultSchemaLoose,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RawMcpServerConfig } from "../config.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpOAuth, type McpTenant } from "../daemon/mcp/oauth.js";
import {
  isLoopbackAddress,
  MCP_PROXY_PATH_PREFIX,
  McpProxy,
  McpProxyLease,
  type McpProxyLimits,
  SIGN_IN_REQUIRED_CODE,
} from "../daemon/mcp/proxy.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import type { McpServerSpec } from "../daemon/mcp/types.js";
import { codexKeySafe, codexShellEnvExcludeArgs } from "../daemon/providers/codex/shell-env.js";
import { Store } from "../daemon/store.js";
import { FAKE_TOOL_NAMES, FakeOAuthMcp } from "./fixtures/fake-oauth-mcp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const TENANT: McpTenant = { accountId: "acc-1", projectId: "proj-1" };
const OTHER: McpTenant = { accountId: "acc-2", projectId: "proj-2" };

let tmp: string;
let store: Store;
let fake: FakeOAuthMcp;
let oauth: McpOAuth;
let registry: McpRegistry;
let hub: McpHub;
let proxy: McpProxy;
let daemon: ReturnType<typeof Bun.serve>;
/** What the daemon route sees as the peer — flipped to test the loopback rule. */
let peerIsLoopback = true;
const clients: Client[] = [];

const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
  ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p }) as RawMcpServerConfig;

function start(opts: { allow?: string[]; limits?: Partial<McpProxyLimits>; idleSeconds?: number; timeoutMs?: number } = {}): void {
  registry = new McpRegistry(
    {
      notes: raw({ url: fake.mcpUrl, oauth: true, ...(opts.allow ? { tools: opts.allow } : {}) }),
      plain: raw({ url: "https://plain.example.com/mcp" }),
      claudeOnly: raw({ url: fake.mcpUrl, oauth: true, backends: ["claude"] }),
    },
    { memoryEnabled: false },
  );
  hub = new McpHub({ credentials: oauth });
  daemon = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // The daemon's idle-connection cut (10 s there).
    idleTimeout: opts.idleSeconds ?? 10,
    // The daemon's route, as server.ts mounts it.
    fetch: (req, server) => {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(MCP_PROXY_PATH_PREFIX)) return new Response("not found", { status: 404 });
      return proxy.handle(req, peerIsLoopback && isLoopbackAddress(server.requestIP(req)?.address), {
        liftIdleTimeout: () => server.timeout(req, 0),
      });
    },
  });
  proxy = new McpProxy({
    registry,
    credentials: oauth,
    hub,
    baseUrl: () => `http://127.0.0.1:${daemon.port}`,
    env: {},
    requestTimeoutMs: opts.timeoutMs ?? 5_000,
    limits: opts.limits,
  });
  hub.proxy = proxy;
}

function notes(): McpServerSpec {
  return registry.get("notes")!;
}

/** Sign a tenant in to the fake, as the Settings flow would. */
async function signIn(tenant: McpTenant): Promise<void> {
  const begun = await oauth.begin(notes(), tenant);
  if (begun.status !== "redirect") throw new Error("expected a redirect");
  const resp = await fetch(begun.url, { redirect: "manual" });
  await oauth.complete({ callbackUrl: resp.headers.get("location")! }, { tenant }, () => notes());
}

/** A backend's MCP client, mounted the way Codex / the Gemini CLI / Qwen mount it. */
async function backend(
  token: string,
  opts: { server?: string; capabilities?: Record<string, unknown>; setup?: (c: Client) => void } = {},
): Promise<Client> {
  const client = new Client({ name: "fake-backend", version: "1" }, { capabilities: opts.capabilities ?? {} });
  opts.setup?.(client);
  const transport = new StreamableHTTPClientTransport(new URL(proxy.url(opts.server ?? "notes")), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function mint(tenant = TENANT, backendId = "codex"): { token: string; servers: string[] } {
  return proxy.mint({ tenant, sessionId: "s1", backendId });
}

/** A raw request to the relay, as a backend's HTTP client would send it. */
function post(server: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(proxy.url(server), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-mcp-proxy-"));
  store = new Store(join(tmp, "codeoid.db"));
  fake = new FakeOAuthMcp();
  oauth = new McpOAuth({ store, redirectBaseUrl: () => "http://127.0.0.1:7999", env: {} });
  peerIsLoopback = true;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await proxy?.closeAll();
  daemon?.stop(true);
  fake.stop();
  try {
    store.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

describe("the relay carries the whole protocol", () => {
  it("answers as the real server, and lists and calls its tools as the session's tenant", async () => {
    start();
    await signIn(TENANT);
    const { token, servers } = mint();
    expect(servers).toEqual(["notes"]); // codex's OAuth servers: not plain (mounted directly), not claudeOnly
    const client = await backend(token);
    expect(client.getServerVersion()).toMatchObject({ name: "fake-oauth-mcp" });
    expect(client.getInstructions()).toBe("A fake server for tests.");
    expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true }, resources: {}, prompts: {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...FAKE_TOOL_NAMES]);
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "you are user-1" }] });
    // The upstream server saw the tenant's token; the backend only ever held the proxy token.
    const upstreamAuth = fake.lastMcpHeaders?.get("authorization");
    expect(upstreamAuth).toStartWith("Bearer ");
    expect(upstreamAuth).not.toContain(token);
    expect(hub.statusFor("notes", TENANT)?.tools).toEqual([...FAKE_TOOL_NAMES]); // Settings sees it
  });

  it("passes resources and prompts", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["fake://readme"]);
    expect(await client.readResource({ uri: "fake://readme" })).toMatchObject({ contents: [{ text: "the readme" }] });
    expect(await client.getPrompt({ name: "greet" })).toMatchObject({ messages: [{ content: { text: "hello there" } }] });
  });

  it("relays progress for a call that asked for it", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    const seen: number[] = [];
    const r = await client.callTool({ name: "count", arguments: { n: 3 } }, undefined, { onprogress: (p) => seen.push(p.progress) });
    expect(r).toMatchObject({ content: [{ text: "counted to 3" }] });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("carries the server's own requests to the backend: elicitation and sampling, during the call that made them", async () => {
    start();
    const elicitMeta: unknown[] = [];
    await signIn(TENANT);
    const client = await backend(mint().token, {
      capabilities: { elicitation: {}, sampling: {} },
      setup: (c) => {
        c.setRequestHandler(ElicitRequestSchema, async (request) => {
          elicitMeta.push(request.params._meta);
          return { action: "accept", content: { ok: true } };
        });
        c.setRequestHandler(CreateMessageRequestSchema, async () => ({
          role: "assistant",
          content: { type: "text", text: "hello" },
          model: "test-model",
        }));
      },
    });
    expect(await client.callTool({ name: "ask", arguments: {} })).toMatchObject({ content: [{ text: 'answer: accept {"ok":true}' }] });
    expect(await client.callTool({ name: "sample", arguments: {} })).toMatchObject({ content: [{ text: "model said: hello" }] });
    // The server's own _meta (here a forged approval marker) never reaches the backend.
    expect(elicitMeta).toEqual([undefined]);
  });

  it("cancels the upstream call when the backend cancels", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    const abort = new AbortController();
    const call = client.callTool({ name: "slow", arguments: {} }, undefined, { signal: abort.signal });
    await Bun.sleep(100);
    abort.abort();
    await expect(call).rejects.toThrow();
    await until(() => fake.cancelled === 1);
  });

  it("relays the server's notifications: a changed tool list reaches the backend", async () => {
    start();
    await signIn(TENANT);
    let changed = 0;
    const client = await backend(mint().token, {
      setup: (c) => c.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed++),
    });
    await client.listTools();
    await fake.announceToolsChanged();
    await until(() => changed >= 1);
  });
});

describe("signing in and out", () => {
  it("serves a tenant not signed in — tools that say to sign in, never a 401 — and picks up a sign-in live", async () => {
    start();
    const { token } = mint();
    // The raw exchange: initialize succeeds, with a session.
    const init = await post("notes", token, INIT);
    expect(init.status).toBe(200);
    expect(init.headers.get("www-authenticate")).toBeNull();
    let changed = 0;
    const client = await backend(token, {
      setup: (c) => c.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed++),
    });
    const listed = await client.listTools().catch((e: unknown) => e);
    expect(listed).toBeInstanceOf(McpError);
    expect((listed as McpError).code).toBe(SIGN_IN_REQUIRED_CODE);
    expect((listed as McpError).message).toContain("notes needs sign-in");
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("needs sign-in") }],
    });
    expect(fake.stats.mcpCalls).toBe(0); // nothing reached the server
    // Signing in tells the running backend, which then gets the tools.
    await signIn(TENANT);
    proxy.credentialsChanged("notes", TENANT);
    await until(() => changed >= 1);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...FAKE_TOOL_NAMES]);
  });

  it("signing out drops the upstream session; the next call says to sign in, and reaches nothing", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    await client.listTools();
    oauth.disconnect(notes(), TENANT);
    proxy.credentialsChanged("notes", TENANT);
    await Bun.sleep(50);
    const authorizedBefore = fake.mcpLog.filter((l) => l.authorized).length;
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("needs sign-in") }],
    });
    expect(fake.mcpLog.filter((l) => l.authorized).length).toBe(authorizedBefore);
  });

  it("refreshes a token the server rejects mid-session, and retries", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    await client.listTools();
    fake.revokeAccessTokens();
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({ content: [{ text: "you are user-1" }] });
    expect(fake.stats.refreshes).toBe(1);
  });
});

describe("who can use the relay", () => {
  it("each tenant's token calls as that tenant — never another's credential", async () => {
    start();
    await signIn(TENANT);
    const other = await backend(mint(OTHER).token);
    expect(await other.callTool({ name: "whoami", arguments: {} })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("needs sign-in") }] });
    await signIn(OTHER);
    proxy.credentialsChanged("notes", OTHER);
    expect(await other.callTool({ name: "whoami", arguments: {} })).toMatchObject({ content: [{ text: "you are user-2" }] });
    const mine = await backend(mint(TENANT).token);
    expect(await mine.callTool({ name: "whoami", arguments: {} })).toMatchObject({ content: [{ text: "you are user-1" }] });
  });

  it("refuses — with 403, never 401 — a missing, unknown, revoked or query-string token", async () => {
    start();
    await signIn(TENANT);
    const { token } = mint();
    for (const res of [
      await post("notes", null, INIT),
      await post("notes", "not-a-token", INIT),
      await fetch(`${proxy.url("notes")}?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(INIT) }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
    const client = await backend(token);
    await client.listTools();
    expect(proxy.relayCount).toBe(1);
    proxy.revoke(token);
    expect(proxy.relayCount).toBe(0);
    expect((await post("notes", token, INIT)).status).toBe(403);
    await until(() => fake.openSessions === 0); // its upstream session ended with it
  });

  it("reaches only the servers the token was minted for", async () => {
    start();
    const { token } = mint(TENANT, "codex");
    for (const server of ["plain", "claudeOnly", "nope"]) expect((await post(server, token, INIT)).status).toBe(404);
    // gemini-cli's token, the same: notes only.
    expect(mint(TENANT, "gemini-cli").servers).toEqual(["notes"]);
    expect(mint(TENANT, "claude").servers).toEqual(["notes", "claudeOnly"]);
  });

  it("serves only this host, and not a web page: a remote peer, a foreign Host or Origin is refused", async () => {
    start();
    const { token } = mint();
    peerIsLoopback = false;
    expect((await post("notes", token, INIT)).status).toBe(403);
    peerIsLoopback = true;
    expect((await post("notes", token, INIT, { Origin: "http://evil.example" })).status).toBe(403);
    // A DNS-rebound page: its own name in Host, though the address is loopback.
    const port = daemon.port!;
    const rebound = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify(INIT);
      const sock = createConnection({ host: "127.0.0.1", port }, () => {
        sock.write(
          `POST ${MCP_PROXY_PATH_PREFIX}notes HTTP/1.1\r\nHost: evil.example:${port}\r\nAuthorization: Bearer ${token}\r\n` +
            `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
      sock.once("data", (d) => {
        resolve(d.toString().split("\r\n")[0]!);
        sock.destroy();
      });
      sock.once("error", reject);
    });
    expect(rebound).toContain("403");
    expect((await post("notes", token, INIT, { Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  it("enforces the server's tool allowlist on the list and on calls", async () => {
    start({ allow: ["whoami"] });
    await signIn(TENANT);
    const client = await backend(mint().token);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]);
    const before = fake.mcpLog.filter((l) => l.method === "tools/call").length;
    expect(await client.callTool({ name: "echo", arguments: { text: "x" } })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("not in the allowlist") }],
    });
    expect(fake.mcpLog.filter((l) => l.method === "tools/call").length).toBe(before); // never sent upstream
  });

  it("bounds sessions per token — the least recently used makes room — and request size", async () => {
    start({ limits: { sessionsPerToken: 2, maxBodyBytes: 4_096 } });
    await signIn(TENANT);
    const { token } = mint();
    const first = (await post("notes", token, INIT)).headers.get("mcp-session-id")!;
    expect((await post("notes", token, INIT)).status).toBe(200);
    expect((await post("notes", token, INIT)).status).toBe(200);
    expect(proxy.relayCount).toBe(2);
    expect((await post("notes", token, { jsonrpc: "2.0", id: 2, method: "ping" }, { "Mcp-Session-Id": first })).status).toBe(404);
    await until(() => fake.openSessions === 2); // the evicted one's upstream session ended too
    const huge = JSON.stringify({ ...INIT, params: { ...INIT.params, pad: "x".repeat(10_000) } });
    expect((await post("notes", mint().token, huge)).status).toBe(413);
  });

  it("a backend's session ending ends the relay's, and the upstream's", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    await client.listTools();
    expect(proxy.relayCount).toBe(1);
    await (client.transport as StreamableHTTPClientTransport).terminateSession();
    await until(() => proxy.relayCount === 0 && fake.openSessions === 0);
  });

  it("closes an idle upstream session, and reopens it on the next request", async () => {
    start({ limits: { upstreamIdleMs: 50 } });
    await signIn(TENANT);
    const client = await backend(mint().token);
    await client.listTools();
    await until(() => fake.openSessions === 0);
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({ content: [{ text: "you are user-1" }] });
  });
});

describe("a provider's lease", () => {
  it("holds one token at a time, and none when there's nothing to reach", async () => {
    start();
    await signIn(TENANT);
    const lease = new McpProxyLease(proxy, { tenant: TENANT, sessionId: "s1", backendId: "qwen" });
    const first = lease.renew()!;
    expect(first.servers).toEqual([{ name: "notes", url: proxy.url("notes") }]);
    const second = lease.renew()!;
    expect((await post("notes", first.token, INIT)).status).toBe(403); // the earlier one is revoked
    expect((await post("notes", second.token, INIT)).status).toBe(200);
    lease.revoke();
    expect((await post("notes", second.token, INIT)).status).toBe(403);
    expect(new McpProxyLease(proxy, null).renew()).toBeNull(); // no tenant, no token
    expect(new McpProxyLease(proxy, { tenant: TENANT, sessionId: "s1", backendId: "nothing-oauth" }).renew()).not.toBeNull();
  });
});

describe("codex's shell environment", () => {
  it("excludes codeoid's token variables from the commands codex runs, keeping the user's own excludes", () => {
    const at = (toml: string | null) =>
      codexShellEnvExcludeArgs({ HOME: "/h" }, () => {
        if (toml === null) throw new Error("ENOENT");
        return toml;
      });
    expect(at(null)).toEqual(["-c", 'shell_environment_policy.exclude=["CODEOID_*_TOKEN"]']);
    expect(at('[shell_environment_policy]\nexclude = ["AWS_*"]\nignore_default_excludes = true\n')).toEqual([
      "-c",
      'shell_environment_policy.exclude=["AWS_*","CODEOID_*_TOKEN"]',
    ]);
    // Unreadable here: the user's list can't be kept, so nothing is overridden.
    expect(at("not = [valid")).toBeNull();
    expect(at("d = 1979-05-27T07:32:00Z\n")).toBeNull();
    expect(codexKeySafe("notes")).toBe(true);
    expect(codexKeySafe("claude.ai Slack")).toBe(false);
    expect(codexKeySafe('x.url="http://evil" #')).toBe(false);
  });
});

describe("round-1 findings stay fixed", () => {
  it("a call quiet for longer than the daemon's idle cut still completes", async () => {
    // A 1 s idle setting cuts a quiet connection at about 4 s (measured).
    start({ idleSeconds: 1, timeoutMs: 15_000 });
    await signIn(TENANT);
    const client = await backend(mint().token);
    expect(await client.callTool({ name: "sleep", arguments: { ms: 6_000 } })).toMatchObject({ content: [{ text: "slept" }] });
  }, 20_000);

  it("the idle drop never closes the upstream session under a call in flight", async () => {
    start({ limits: { upstreamIdleMs: 100 } });
    await signIn(TENANT);
    const client = await backend(mint().token);
    const long = client.callTool({ name: "sleep", arguments: { ms: 600 } });
    // Another call finishing mid-way must not start the idle clock under the long one.
    await Bun.sleep(50);
    await client.callTool({ name: "whoami", arguments: {} });
    expect(await long).toMatchObject({ content: [{ text: "slept" }] });
  });

  it("closing the old upstream session doesn't take down the new one", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    await client.listTools();
    fake.deleteDelayMs = 400; // the old session's DELETE is still on its way…
    proxy.credentialsChanged("notes", TENANT);
    // …while a new call opens a new session.
    expect(await client.callTool({ name: "sleep", arguments: { ms: 700 } })).toMatchObject({ content: [{ text: "slept" }] });
  });

  it("an initialize the transport would refuse opens nothing upstream", async () => {
    start({ limits: { sessionsPerToken: 1 } });
    await signIn(TENANT);
    const { token } = mint();
    for (let i = 0; i < 3; i++) expect((await post("notes", token, INIT, { Accept: "application/json" })).status).toBe(406);
    expect((await post("notes", token, INIT, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("notes", token, { ...INIT, params: { capabilities: {} } })).status).toBe(400);
    await Bun.sleep(100);
    expect(fake.openSessions).toBe(0);
    expect(proxy.relayCount).toBe(0);
  });

  it("a server limited to some tools is only those tools: no resources, prompts or unknown methods", async () => {
    start({ allow: ["whoami"] });
    await signIn(TENANT);
    const client = await backend(mint().token);
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    for (const call of [
      client.request({ method: "resources/read", params: { uri: "fake://readme" } }, ResultSchemaLoose),
      client.request({ method: "prompts/get", params: { name: "greet" } }, ResultSchemaLoose),
    ]) {
      const err = await call.catch((e: unknown) => e);
      expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
    }
    expect(fake.mcpLog.some((l) => l.method === "resources/read" || l.method === "prompts/get")).toBe(false);
  });

  it("refuses a method MCP doesn't define, without asking the server", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    const err = await client.request({ method: "tasks/run", params: {} }, ResultSchemaLoose).catch((e: unknown) => e);
    expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
    expect(fake.mcpLog.some((l) => l.method === "tasks/run")).toBe(false);
  });

  it("a sign-in lost mid-session reads as not signed in — for the model and in Settings", async () => {
    start();
    await signIn(TENANT);
    const client = await backend(mint().token);
    await client.listTools();
    expect(hub.statusFor("notes", TENANT)?.tools?.length).toBeGreaterThan(0);
    fake.revokeAccessTokens();
    fake.revokeRefreshTokens(); // the refresh is refused: the credential is gone
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("needs sign-in") }],
    });
    const listed = await client.listTools().catch((e: unknown) => e);
    expect((listed as McpError).code).toBe(SIGN_IN_REQUIRED_CODE);
    expect(hub.statusFor("notes", TENANT)).toBeUndefined();
  });

  it("an entry changed since the token was minted isn't reachable on it", async () => {
    start();
    await signIn(TENANT);
    const { token } = mint();
    registry.upsert("notes", raw({ url: fake.mcpUrl, oauth: true, backends: ["claude"] }));
    expect((await post("notes", token, INIT)).status).toBe(404);
  });

  it("answers a malformed path with 404, not a crash", async () => {
    start();
    const { token } = mint();
    const res = await fetch(`http://127.0.0.1:${daemon.port}${MCP_PROXY_PATH_PREFIX}%E0%A4%A`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("the hub still reads a sloppy server: a tool with an odd schema, an output schema answered in text", async () => {
    fake.stop();
    fake = new FakeOAuthMcp({ malformedTool: true });
    start();
    await signIn(TENANT);
    const scope = { workspaceId: "w", sessionId: "s", tenant: TENANT };
    const names = (await hub.listTools(notes(), scope)).map((t) => t.name);
    expect(names).toContain("sloppy");
    expect(names).toContain("whoami");
    expect(await hub.callTool(notes(), "structured", {}, scope)).toEqual({ text: "not structured", isError: false });
    hub.closeAll();
  });
});
