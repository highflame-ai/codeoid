/**
 * The OAuth engine for remote MCP servers (docs/mcp-oauth-design.md), run
 * against a local spec-shaped authorization + MCP server: discovery, dynamic
 * registration, authorization code + PKCE, callback, refresh, rejection.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import { McpOAuth, type McpTenant } from "../daemon/mcp/oauth.js";
import type { McpServerSpec } from "../daemon/mcp/types.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { registryServersForClaude } from "../daemon/providers/claude/index.js";
import { registryServersForQwen } from "../daemon/providers/qwen/index.js";
import { SCOPES } from "../protocol/scopes.js";
import type { McpServerStatus } from "../protocol/types.js";
import type { RawMcpServerConfig } from "../config.js";
import { FakeOAuthMcp } from "./fixtures/fake-oauth-mcp.js";

const TENANT: McpTenant = { accountId: "acc-1", projectId: "proj-1" };
const OTHER: McpTenant = { accountId: "acc-2", projectId: "proj-2" };
const REDIRECT_BASE = "http://127.0.0.1:7999";

let tmp: string;
let store: Store;
let fake: FakeOAuthMcp;
let now: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-mcp-oauth-"));
  store = new Store(join(tmp, "codeoid.db"));
  now = 1_000_000;
});

afterEach(() => {
  fake?.stop();
  try { store.close(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function spec(oauth: NonNullable<Extract<McpServerSpec["transport"], { kind: "http" }>["oauth"]> = {}): McpServerSpec {
  return {
    name: "notes",
    transport: { kind: "http", url: fake.mcpUrl, headers: {}, oauth },
    trust: "prompt",
    scope: "workspace",
    enabled: true,
    native: false,
    builtin: false,
  };
}

function engine(opts: { base?: string; env?: Record<string, string> } = {}): McpOAuth {
  return new McpOAuth({
    store,
    redirectBaseUrl: () => opts.base ?? REDIRECT_BASE,
    env: opts.env ?? {},
    now: () => now,
  });
}

/** Play the browser: follow the authorize URL to the redirect it issues. */
async function signIn(url: string): Promise<string> {
  const resp = await fetch(url, { redirect: "manual" });
  expect(resp.status).toBe(302);
  return resp.headers.get("location")!;
}

async function connect(oauth: McpOAuth, s: McpServerSpec, tenant = TENANT): Promise<void> {
  const begun = await oauth.begin(s, tenant);
  if (begun.status !== "redirect") throw new Error("expected a redirect");
  const callbackUrl = await signIn(begun.url);
  await oauth.complete({ callbackUrl }, { tenant: TENANT }, () => s);
}

describe("connecting", () => {
  it("discovers, registers dynamically, and completes an authorization code + PKCE flow", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();

    const begun = await oauth.begin(s, TENANT);
    expect(begun.status).toBe("redirect");
    if (begun.status !== "redirect") return;
    const q = new URL(begun.url).searchParams;
    expect(q.get("redirect_uri")).toBe(`${REDIRECT_BASE}/mcp/oauth/callback`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBeTruthy();
    // The resource indicator binds the token to this MCP server.
    expect(q.get("resource")).toBe(fake.mcpUrl);
    expect(fake.stats.registrations).toBe(1);

    const callbackUrl = await signIn(begun.url);
    const done = await oauth.complete({ callbackUrl }, { tenant: TENANT }, () => s);
    expect(done).toEqual({ server: "notes", tenant: TENANT });
    expect(oauth.status(s, TENANT)).toBe("connected");

    const token = await oauth.accessToken(s, TENANT);
    expect(token).toBeTruthy();
    const call = await fetch(fake.mcpUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
    });
    expect(call.status).toBe(200);
  });

  it("reports connected without a new sign-in once a tenant has a credential", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    expect(await oauth.begin(s, TENANT)).toEqual({ status: "connected" });
    expect(fake.stats.registrations).toBe(1);
  });

  it("keeps each tenant's credential separate", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s, TENANT);
    expect(oauth.status(s, OTHER)).toBe("disconnected");
    expect(await oauth.accessToken(s, OTHER)).toBeUndefined();
  });

  it("uses a pre-registered client when the server does not register dynamically", async () => {
    fake = new FakeOAuthMcp({
      dynamicRegistration: false,
      preRegistered: { clientId: "codeoid-app", clientSecret: "s3cret" },
    });
    const oauth = engine({ env: { NOTES_CLIENT_SECRET: "s3cret" } });
    const s = spec({ clientId: "codeoid-app", clientSecretEnv: "NOTES_CLIENT_SECRET" });
    await connect(oauth, s);
    expect(fake.stats.registrations).toBe(0);
    expect(oauth.status(s, TENANT)).toBe("connected");
  });

  it("re-registers when the daemon's redirect URL changed", async () => {
    fake = new FakeOAuthMcp();
    const s = spec();
    await connect(engine(), s);
    store.clearMcpOAuth(TENANT, { name: "notes", url: fake.mcpUrl }, "tokens");
    // A registration for the old redirect cannot complete a flow at the new one.
    await connect(engine({ base: "https://codeoid.example.com" }), s);
    expect(fake.stats.registrations).toBe(2);
  });

  it("requests the configured scopes", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const begun = await oauth.begin(spec({ scopes: ["notes:read", "notes:write"] }), TENANT);
    if (begun.status !== "redirect") throw new Error("expected a redirect");
    expect(new URL(begun.url).searchParams.get("scope")).toBe("notes:read notes:write");
  });
});

describe("completing a sign-in", () => {
  it("refuses an unknown or already-used state", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    const begun = await oauth.begin(s, TENANT);
    if (begun.status !== "redirect") throw new Error("expected a redirect");
    const callbackUrl = await signIn(begun.url);
    await oauth.complete({ callbackUrl }, { tenant: TENANT }, () => s);
    // Single use: replaying the same redirect fails.
    await expect(oauth.complete({ callbackUrl }, { tenant: TENANT }, () => s)).rejects.toThrow(/unknown or has expired/);
    await expect(
      oauth.complete({ callbackUrl: `${REDIRECT_BASE}/mcp/oauth/callback?code=x&state=forged` }, { tenant: TENANT }, () => s),
    ).rejects.toThrow(/unknown or has expired/);
  });

  it("expires a sign-in left unfinished", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    const begun = await oauth.begin(s, TENANT);
    if (begun.status !== "redirect") throw new Error("expected a redirect");
    const callbackUrl = await signIn(begun.url);
    now += 11 * 60_000;
    await expect(oauth.complete({ callbackUrl }, { tenant: TENANT }, () => s)).rejects.toThrow(/expired/);
  });

  it("honours a pasted URL only for the tenant that started the sign-in", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    const begun = await oauth.begin(s, TENANT);
    if (begun.status !== "redirect") throw new Error("expected a redirect");
    const callbackUrl = await signIn(begun.url);
    await expect(oauth.complete({ callbackUrl }, { tenant: OTHER }, () => s)).rejects.toThrow(/different workspace/);
  });

  it("reports the provider's error instead of a missing code", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    const begun = await oauth.begin(s, TENANT);
    if (begun.status !== "redirect") throw new Error("expected a redirect");
    const state = new URL(begun.url).searchParams.get("state");
    await expect(
      oauth.complete(
        { callbackUrl: `${REDIRECT_BASE}/mcp/oauth/callback?state=${state}&error=access_denied&error_description=User+cancelled` },
        { tenant: TENANT },
        () => s,
      ),
    ).rejects.toThrow(/User cancelled/);
  });
});

describe("using the credential", () => {
  it("refreshes an expired access token — once, however many callers ask", async () => {
    fake = new FakeOAuthMcp({ expiresIn: 600 });
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    const first = await oauth.accessToken(s, TENANT);

    now += 600_000; // past expiry
    const [a, b, c] = await Promise.all([oauth.accessToken(s, TENANT), oauth.accessToken(s, TENANT), oauth.accessToken(s, TENANT)]);
    expect(fake.stats.refreshes).toBe(1);
    expect(a).toBeTruthy();
    expect(a).not.toBe(first);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("refreshes a token the server rejected, even before it expires", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    const first = (await oauth.accessToken(s, TENANT))!;
    fake.revokeAccessTokens();

    oauth.rejected(s, TENANT, first);
    const next = await oauth.accessToken(s, TENANT);
    expect(next).toBeTruthy();
    expect(next).not.toBe(first);
    expect(fake.stats.refreshes).toBe(1);
  });

  it("gives no token — sign-in required — when the refresh itself is refused", async () => {
    fake = new FakeOAuthMcp({ expiresIn: 600 });
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    fake.revokeRefreshTokens();
    now += 600_000;
    expect(await oauth.accessToken(s, TENANT)).toBeUndefined();
  });

  it("forgets the tokens on disconnect", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    oauth.disconnect(s, TENANT);
    expect(oauth.status(s, TENANT)).toBe("disconnected");
    expect(await oauth.accessToken(s, TENANT)).toBeUndefined();
  });
});

// ── The daemon-owned client (openai, gemini, pi) ──────────────────────────────

describe("the hub calls an OAuth server with the tenant's token", () => {
  const scope = (tenant?: McpTenant) => ({ workspaceId: "w", sessionId: "s", ...(tenant ? { tenant } : {}) });

  it("lists and calls tools as the signed-in tenant", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    const hub = new McpHub({ credentials: oauth });
    expect((await hub.listTools(s, scope(TENANT))).map((t) => t.name)).toEqual(["whoami"]);
    const res = await hub.callTool(s, "whoami", {}, scope(TENANT));
    expect(res).toEqual({ text: "you are user-1", isError: false });
    // The upstream session id the server issued is carried on later requests.
    expect(fake.lastMcpHeaders?.get("mcp-session-id")).toBe("fake-session-1");
    hub.closeAll();
  });

  it("refreshes and retries once when the server rejects the token mid-session", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    const hub = new McpHub({ credentials: oauth });
    await hub.callTool(s, "whoami", {}, scope(TENANT));
    fake.revokeAccessTokens();
    const res = await hub.callTool(s, "whoami", {}, scope(TENANT));
    expect(res.isError).toBe(false);
    expect(fake.stats.refreshes).toBe(1);
    hub.closeAll();
  });

  it("tells the model to sign in — and leaves shared health alone — for a tenant with no credential", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s, TENANT);
    const hub = new McpHub({ credentials: oauth });
    const res = await hub.callTool(s, "whoami", {}, scope(OTHER));
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/needs sign-in/);
    expect(await hub.listTools(s, scope(OTHER))).toEqual([]);
    expect(hub.statusFor("notes", OTHER)).toBeUndefined();
    // The signed-in tenant is unaffected.
    expect((await hub.callTool(s, "whoami", {}, scope(TENANT))).text).toBe("you are user-1");
    hub.closeAll();
  });

  it("never calls an OAuth server without a tenant", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    const hub = new McpHub({ credentials: oauth });
    expect((await hub.callTool(s, "whoami", {}, scope())).isError).toBe(true);
    expect(fake.stats.mcpCalls).toBe(0);
    hub.closeAll();
  });
});

// ── Native-mount backends ─────────────────────────────────────────────────────

const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
  ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p }) as RawMcpServerConfig;

describe("native-mount backends", () => {
  it("do not mount an OAuth server (no baked-in token), but keep the others", () => {
    const reg = new McpRegistry(
      {
        notes: raw({ url: "https://notes.example.com/mcp", oauth: true }),
        plain: raw({ url: "https://plain.example.com/mcp" }),
      },
      { memoryEnabled: false },
    );
    expect(Object.keys(registryServersForClaude(reg))).toEqual(["plain"]);
    expect(Object.keys(registryServersForQwen(reg))).toEqual(["plain"]);
    expect(reg.forNativeMount("codex").map((s) => s.name)).toEqual(["plain"]);
    expect(reg.forNativeMount("gemini-cli").map((s) => s.name)).toEqual(["plain"]);
    // The daemon-owned client still sees it.
    expect(reg.forBackend("openai").map((s) => s.name)).toEqual(["notes", "plain"]);
  });
});

// ── The mcp.oauth.* protocol ──────────────────────────────────────────────────

describe("mcp.oauth.* through the session manager", () => {
  const auth = (scopes: string[], tenant: McpTenant = TENANT) => ({
    sub: "user:oauth-test",
    scopes: scopes as never,
    delegationDepth: 0,
    ...tenant,
  });
  const client = { id: "c1", auth: auth([]), send: () => {} };
  const WRITE = [SCOPES.SETTINGS_WRITE, SCOPES.SETTINGS_READ];

  function manager(oauth: McpOAuth, hub = new McpHub({ credentials: oauth })): SessionManager {
    const m = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    m.setMcp(
      new McpRegistry(
        {
          notes: raw({ url: fake.mcpUrl, oauth: true }),
          plain: raw({ url: "https://plain.example.com/mcp" }),
        },
        { memoryEnabled: false },
      ),
      hub,
      oauth,
    );
    return m;
  }

  const statusOf = (snapshot: { mcpServers?: McpServerStatus[] }, name: string) =>
    snapshot.mcpServers?.find((s) => s.name === name);

  it("needs settings:write", async () => {
    fake = new FakeOAuthMcp();
    const m = manager(engine());
    for (const msg of [
      { type: "mcp.oauth.begin" as const, id: "1", server: "notes" },
      { type: "mcp.oauth.complete" as const, id: "2", callbackUrl: `${REDIRECT_BASE}/mcp/oauth/callback?code=c&state=s` },
      { type: "mcp.oauth.disconnect" as const, id: "3", server: "notes" },
    ]) {
      expect(await m.handle(msg, auth([SCOPES.SETTINGS_READ]), client)).toMatchObject({
        type: "response.error",
        code: "forbidden",
      });
    }
  });

  it("refuses a server that is not configured for OAuth", async () => {
    fake = new FakeOAuthMcp();
    const m = manager(engine());
    for (const server of ["plain", "missing"]) {
      expect(await m.handle({ type: "mcp.oauth.begin", id: "1", server }, auth(WRITE), client)).toMatchObject({
        type: "response.error",
        code: "invalid_request",
      });
    }
  });

  it("connects, reports per-tenant status, and disconnects", async () => {
    fake = new FakeOAuthMcp();
    const m = manager(engine());

    const before = (await m.handle({ type: "settings.get", id: "0" }, auth(WRITE), client)) as {
      snapshot: { mcpServers?: McpServerStatus[] };
    };
    expect(statusOf(before.snapshot, "notes")?.oauth).toEqual({
      status: "disconnected",
      unsupportedBackends: ["claude", "codex", "gemini-cli", "qwen"],
    });
    expect(statusOf(before.snapshot, "plain")?.oauth).toBeUndefined();

    const begun = (await m.handle({ type: "mcp.oauth.begin", id: "1", server: "notes" }, auth(WRITE), client)) as {
      type: string;
      status: string;
      url: string;
    };
    expect(begun).toMatchObject({ type: "mcp.oauth.begin.result", status: "redirect" });

    // The paste fallback: only the tenant that began it can finish it.
    const callbackUrl = await signIn(begun.url);
    expect(
      await m.handle({ type: "mcp.oauth.complete", id: "2", callbackUrl }, auth(WRITE, OTHER), client),
    ).toMatchObject({ type: "response.error", error: expect.stringMatching(/different workspace/) });
    const done = (await m.handle({ type: "mcp.oauth.complete", id: "3", callbackUrl }, auth(WRITE), client)) as {
      type: string;
      server: string;
      snapshot: { mcpServers?: McpServerStatus[] };
    };
    expect(done).toMatchObject({ type: "mcp.oauth.complete.result", server: "notes" });
    expect(statusOf(done.snapshot, "notes")?.oauth?.status).toBe("connected");

    // Another tenant still sees it disconnected.
    const other = (await m.handle({ type: "settings.get", id: "4" }, auth(WRITE, OTHER), client)) as {
      snapshot: { mcpServers?: McpServerStatus[] };
    };
    expect(statusOf(other.snapshot, "notes")?.oauth?.status).toBe("disconnected");

    // Already connected: begin needs no sign-in.
    expect(await m.handle({ type: "mcp.oauth.begin", id: "5", server: "notes" }, auth(WRITE), client)).toMatchObject({
      status: "connected",
    });

    const gone = (await m.handle({ type: "mcp.oauth.disconnect", id: "6", server: "notes" }, auth(WRITE), client)) as {
      snapshot: { mcpServers?: McpServerStatus[] };
    };
    expect(statusOf(gone.snapshot, "notes")?.oauth?.status).toBe("disconnected");
  });

  it("shows each tenant only its own health and tools for an OAuth server", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const hub = new McpHub({ credentials: oauth });
    const m = manager(oauth, hub);
    await connect(oauth, spec(), TENANT);
    await hub.listTools(spec(), { workspaceId: "w", sessionId: "s", tenant: TENANT });
    const get = async (tenant: McpTenant) =>
      statusOf(
        ((await m.handle({ type: "settings.get", id: "g" }, auth(WRITE, tenant), client)) as {
          snapshot: { mcpServers?: McpServerStatus[] };
        }).snapshot,
        "notes",
      );
    expect(await get(TENANT)).toMatchObject({ health: "connected", tools: ["whoami"] });
    expect(await get(OTHER)).toMatchObject({ health: "idle", tools: [] });
    hub.closeAll();
  });

  it("hands the starting browser a binding for the callback route", async () => {
    fake = new FakeOAuthMcp();
    const m = manager(engine());
    const begun = (await m.handle({ type: "mcp.oauth.begin", id: "1", server: "notes" }, auth(WRITE), client)) as {
      url: string;
      browserBinding: { cookie: string; value: string };
    };
    const back = new URL(await signIn(begun.url));
    const state = back.searchParams.get("state")!;
    expect(begun.browserBinding.cookie).toBe(`codeoid_mcp_oauth_${state}`);
    const done = await m.completeMcpOAuth(
      { state, code: back.searchParams.get("code")! },
      { binding: begun.browserBinding.value },
    );
    expect(done).toEqual({ server: "notes", tenant: TENANT });
  });
});

// ── Security properties ───────────────────────────────────────────────────────

describe("login CSRF: a sign-in completes only for whoever started it", () => {
  it("refuses a callback from a browser without the binding — and leaves it for the starter to paste", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    // The attacker (TENANT) starts a sign-in and hands the link to a victim,
    // whose browser approves it and lands on the callback.
    const begun = await oauth.begin(s, TENANT);
    if (begun.status !== "redirect") throw new Error("expected a redirect");
    const callbackUrl = await signIn(begun.url);
    const q = new URL(callbackUrl).searchParams;
    const params = { state: q.get("state")!, code: q.get("code")! };
    await expect(oauth.complete(params, { binding: undefined }, () => s)).rejects.toThrow(/did not start this sign-in/);
    await expect(oauth.complete(params, { binding: "forged" }, () => s)).rejects.toThrow(/did not start this sign-in/);
    expect(oauth.status(s, TENANT)).toBe("disconnected");
    // The victim pasting into their own workspace binds nothing either.
    await expect(oauth.complete({ callbackUrl }, { tenant: OTHER }, () => s)).rejects.toThrow(/different workspace/);
    // The real owner, in the browser that began it, still can.
    await oauth.complete(params, { binding: begun.binding }, () => s);
    expect(oauth.status(s, TENANT)).toBe("connected");
  });
});

describe("credential binding and limits", () => {
  it("never presents a token to a server re-pointed at another URL", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s);
    const moved: McpServerSpec = { ...s, transport: { kind: "http", url: "https://elsewhere.example.com/mcp", headers: {}, oauth: {} } };
    expect(oauth.status(moved, TENANT)).toBe("disconnected");
    expect(await oauth.accessToken(moved, TENANT)).toBeUndefined();
  });

  it("caps the sign-ins one tenant can leave pending, dropping the oldest", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    const first = await oauth.begin(s, TENANT);
    if (first.status !== "redirect") throw new Error("expected a redirect");
    for (let i = 0; i < 16; i++) await oauth.begin(s, TENANT);
    const callbackUrl = await signIn(first.url);
    await expect(oauth.complete({ callbackUrl }, { tenant: TENANT }, () => s)).rejects.toThrow(/unknown or has expired/);
  });

  it("keeps one tenant's server errors and tools out of another's settings", async () => {
    fake = new FakeOAuthMcp();
    const oauth = engine();
    const s = spec();
    await connect(oauth, s, TENANT);
    const hub = new McpHub({ credentials: oauth });
    await hub.listTools(s, { workspaceId: "w", sessionId: "s", tenant: TENANT });
    expect(hub.statusFor("notes", TENANT)?.tools).toEqual(["whoami"]);
    expect(hub.hasClient("notes", TENANT)).toBe(true);
    expect(hub.statusFor("notes", OTHER)).toBeUndefined();
    expect(hub.hasClient("notes", OTHER)).toBe(false);
    hub.closeAll();
  });
});
