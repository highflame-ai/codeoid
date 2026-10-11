/**
 * `codeoid mcp headers|config` and the shared token helper (#251).
 *
 * What matters: a token handed to an outside MCP client is narrowed at ZeroID
 * to what was asked for (observe-only by default), the helper prints exactly
 * one JSON object on stdout (Claude Code's headersHelper contract), and the
 * printed config never interpolates unvalidated text into the shell command a
 * client will run.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { acquireToken, cleartextOffHost, controlUrl, MCP_SCOPE_PRESETS, resolveMcpScopes, TokenError } from "../terminal/token.js";
import { mcpConfig, mcpHeaders } from "../terminal/mcp-control-cli.js";
import { SCOPES } from "../protocol/scopes.js";

// A port nothing publishes a local token for, so acquireToken takes the key path.
const BASE = { daemonUrl: "ws://127.0.0.1:65531", zeroidUrl: "http://zeroid.test" };

let savedLocal: string | undefined;
beforeEach(() => {
  savedLocal = process.env.CODEOID_LOCAL_TOKEN;
  delete process.env.CODEOID_LOCAL_TOKEN;
});
afterEach(() => {
  if (savedLocal === undefined) delete process.env.CODEOID_LOCAL_TOKEN;
  else process.env.CODEOID_LOCAL_TOKEN = savedLocal;
});

function fakeZeroid(status = 200, body: unknown = { access_token: "jwt-abc" }) {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("resolveMcpScopes", () => {
  it("defaults are least-privilege: observe cannot act", () => {
    expect(resolveMcpScopes("observe").split(" ").sort()).toEqual([SCOPES.SESSION_LIST, SCOPES.SESSION_WATCH].sort());
    expect(MCP_SCOPE_PRESETS.operate).not.toContain(SCOPES.SESSION_DESTROY);
    expect(MCP_SCOPE_PRESETS.full).toContain(SCOPES.SESSION_DESTROY);
  });

  it("no preset grants approve — an outside agent never answers the owner's approvals", () => {
    for (const p of Object.values(MCP_SCOPE_PRESETS)) expect(p).not.toContain(SCOPES.SESSION_APPROVE);
  });

  it("accepts an explicit list (comma or space) and rejects unknown scopes", () => {
    expect(resolveMcpScopes("session:list, session:send")).toBe("session:list session:send");
    expect(() => resolveMcpScopes("session:list,root")).toThrow(TokenError);
    expect(() => resolveMcpScopes("")).toThrow(TokenError);
  });
});

describe("controlUrl", () => {
  it("maps the daemon's WebSocket URL to the endpoint, TLS-preserving", () => {
    expect(controlUrl("ws://127.0.0.1:7400")).toBe("http://127.0.0.1:7400/mcp/control");
    expect(controlUrl("wss://codeoid.example/ws?x=1")).toBe("https://codeoid.example/mcp/control");
  });
});

describe("acquireToken", () => {
  it("exchanges a zid_sk_ key at ZeroID for exactly the requested scopes", async () => {
    const z = fakeZeroid();
    const t = await acquireToken({ ...BASE, apiKey: "zid_sk_123" }, { scope: "session:list session:watch", fetchImpl: z.fetchImpl });
    expect(t).toEqual({ token: "jwt-abc", source: "zeroid" });
    expect(z.seen[0]!.url).toBe("http://zeroid.test/oauth2/token");
    expect(z.seen[0]!.body).toEqual({ grant_type: "api_key", api_key: "zid_sk_123", scope: "session:list session:watch" });
  });

  it("prefers a local-mode token for the daemon over any key", async () => {
    process.env.CODEOID_LOCAL_TOKEN = "local-tok";
    const z = fakeZeroid();
    expect(await acquireToken({ ...BASE, apiKey: "zid_sk_123" }, { fetchImpl: z.fetchImpl })).toEqual({ token: "local-tok", source: "local" });
    expect(z.seen).toEqual([]);
  });

  it("explains a missing key and a rejected key instead of throwing raw errors", async () => {
    await expect(acquireToken({ ...BASE, apiKey: undefined })).rejects.toBeInstanceOf(TokenError);
    const z = fakeZeroid(401, { error: "invalid_grant", error_description: "key revoked" });
    try {
      await acquireToken({ ...BASE, apiKey: "zid_sk_bad" }, { fetchImpl: z.fetchImpl });
      throw new Error("expected a TokenError");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenError);
      expect((err as TokenError).lines).toContain("  key revoked");
    }
  });
});

describe("mcp headers", () => {
  it("prints one JSON object with the bearer header — the headersHelper contract", async () => {
    const z = fakeZeroid();
    const out = await mcpHeaders({ ...BASE, apiKey: "zid_sk_1" }, "operate", (c, o) => acquireToken(c, { ...o, fetchImpl: z.fetchImpl }));
    expect(JSON.parse(out.stdout)).toEqual({ Authorization: "Bearer jwt-abc" });
    expect(out.warnings).toEqual([]);
    expect(String(z.seen[0]!.body.scope).split(" ")).toEqual([...MCP_SCOPE_PRESETS.operate!]);
  });

  it("warns (on stderr, not in the JSON) that a local token cannot be narrowed", async () => {
    process.env.CODEOID_LOCAL_TOKEN = "local-tok";
    const out = await mcpHeaders({ ...BASE }, "observe");
    expect(JSON.parse(out.stdout)).toEqual({ Authorization: "Bearer local-tok" });
    expect(out.warnings[0]).toContain("cannot narrow");
  });
});

describe("mcp config", () => {
  it("points at the endpoint with a helper that re-mints the token", () => {
    expect(mcpConfig(BASE, { name: "codeoid", scopes: "observe" })).toEqual({
      mcpServers: {
        codeoid: { type: "http", url: "http://127.0.0.1:65531/mcp/control", headersHelper: "codeoid mcp headers --scopes observe" },
      },
    });
  });

  it("normalizes an explicit list into a shell-safe argument", () => {
    const cfg = mcpConfig(BASE, { name: "c", scopes: "session:list session:send" }) as {
      mcpServers: Record<string, { headersHelper: string }>;
    };
    expect(cfg.mcpServers.c!.headersHelper).toBe("codeoid mcp headers --scopes session:list,session:send");
  });

  it("never treats an inherited property name as a preset", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(() => resolveMcpScopes(name)).toThrow(TokenError);
      expect(() => mcpConfig(BASE, { name: "c", scopes: name })).toThrow(TokenError);
    }
  });

  it("flags only an off-host plain-http URL as cleartext", () => {
    expect(cleartextOffHost("http://127.0.0.1:7400/mcp/control")).toBe(false);
    expect(cleartextOffHost("http://localhost:7400/mcp/control")).toBe(false);
    expect(cleartextOffHost("https://codeoid.example/mcp/control")).toBe(false);
    expect(cleartextOffHost("http://10.0.0.5:7400/mcp/control")).toBe(true);
  });

  it("refuses anything that could smuggle shell syntax into the helper", () => {
    expect(() => mcpConfig(BASE, { name: "c", scopes: "observe; rm -rf ~" })).toThrow();
    expect(() => mcpConfig(BASE, { name: "c$(id)", scopes: "observe" })).toThrow();
  });
});
