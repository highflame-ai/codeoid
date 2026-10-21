/**
 * Adopting an MCP server from Claude's own config (#390): `mcp.adopt` finds a
 * remote server in `~/.claude.json` (or a session workdir's `.mcp.json`), puts
 * the same URL in codeoid's registry with OAuth — in config.json and live — so
 * codeoid's own sign-in can connect it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeoidConfig, McpServerSchema } from "../config.js";
import { adoptability } from "../daemon/mcp/adopt.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpOAuth } from "../daemon/mcp/oauth.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { isOAuthServer } from "../daemon/mcp/types.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SCOPES } from "../protocol/scopes.js";
import type { AuthContext, ClaudeConfigMcpServer, DaemonMessage, McpAdoptResultMsg } from "../protocol/types.js";

const auth = (scopes: string[], sub = "user:a"): AuthContext => ({
  sub,
  scopes: scopes as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-1",
  projectId: "proj-1",
});
const WRITE = [SCOPES.SETTINGS_WRITE, SCOPES.SETTINGS_READ, SCOPES.SESSION_CREATE, SCOPES.FS_READ];
const client = { id: "c1", auth: auth(WRITE), send: () => {} };

let tmp: string;
let home: string;
let work: string;
let store: Store;
let registry: McpRegistry;
let hub: McpHub;
let dropped: string[];
let prev: { home?: string; xdg?: string };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-mcp-adopt-"));
  home = join(tmp, "home");
  work = join(tmp, "work");
  mkdirSync(home);
  mkdirSync(work);
  prev = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; // Claude's config is read from here
  process.env.XDG_CONFIG_HOME = join(tmp, "xdg"); // codeoid's config.json is written here
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        notes: { type: "http", url: "https://notes.example.com/mcp" },
        legacy: { type: "sse", url: "https://legacy.example.com/sse" },
        local: { command: "node", args: ["server.js"] },
      },
    }),
  );
  writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { tracker: { type: "http", url: "https://tracker.example.com/mcp" } } }));
  store = new Store(join(tmp, "codeoid.db"));
  dropped = [];
});

afterEach(() => {
  for (const [k, v] of [["HOME", prev.home], ["XDG_CONFIG_HOME", prev.xdg]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    store.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function manager(): SessionManager {
  const providers = new ProviderRegistry("claude");
  providers.register({ id: "claude", displayName: "claude", create: () => new MockSessionProvider("claude", []) });
  const config = {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
  } as CodeoidConfig;
  const m = new SessionManager(store, new TranscriptStore(join(tmp, "t")), undefined, undefined, undefined, { config, providers });
  // As at boot: the global ~/.claude.json http server is imported as a plain entry.
  registry = new McpRegistry({ notes: McpServerSchema.parse({ url: "https://notes.example.com/mcp" }) }, { memoryEnabled: false });
  const oauth = new McpOAuth({ store, redirectBaseUrl: () => "http://127.0.0.1:7999", env: {} });
  hub = new McpHub({ credentials: oauth });
  const drop = hub.drop.bind(hub);
  hub.drop = (name: string) => {
    dropped.push(name);
    drop(name);
  };
  m.setMcp(registry, hub, oauth);
  return m;
}

const adopt = (m: SessionManager, server: string, a = auth(WRITE), sessionId?: string, url?: string) =>
  m.handle({ type: "mcp.adopt", id: "a", server, ...(sessionId ? { sessionId } : {}), ...(url ? { url } : {}) }, a, client) as Promise<DaemonMessage>;
const auditRows = () => {
  const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
  const rows = db.query("SELECT subject, detail FROM audit_log WHERE action = 'mcp.adopt' ORDER BY id").all() as Array<{ subject: string; detail: string }>;
  db.close();
  return rows;
};
async function sessionIn(m: SessionManager, dir: string): Promise<string> {
  const created = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: dir }, auth(WRITE), client)) as { data: { id: string } };
  return created.data.id;
}
const configJson = () => JSON.parse(readFileSync(join(tmp, "xdg", "codeoid", "config.json"), "utf8")) as { mcpServers: Record<string, unknown> };

describe("mcp.adopt", () => {
  it("puts the server's URL in codeoid's registry with OAuth — on disk and live", async () => {
    const m = manager();
    const r = (await adopt(m, "notes")) as McpAdoptResultMsg;
    expect(r).toMatchObject({ type: "mcp.adopt.result", server: "notes", alreadyAdopted: false });
    expect(configJson().mcpServers.notes).toEqual({ url: "https://notes.example.com/mcp", oauth: true, trust: "prompt" });
    const spec = registry.get("notes")!;
    expect(isOAuthServer(spec)).toBe(true);
    expect(registry.oauthFor("claude").map((s) => s.name)).toEqual(["notes"]);
    expect(registry.forNativeMount("claude").map((s) => s.name)).toEqual([]); // no longer handed to the CLI by URL
    expect(dropped).toEqual(["notes"]); // the imported plain copy's client is gone
    // The settings snapshot lists it, not yet signed in.
    expect(r.snapshot.mcpServers?.find((s) => s.name === "notes")?.oauth?.status).toBe("disconnected");
  });

  it("again is a no-op; a server codeoid's config already names differently is left alone", async () => {
    const m = manager();
    await adopt(m, "notes");
    expect(await adopt(m, "notes")).toMatchObject({ type: "mcp.adopt.result", alreadyAdopted: true });
    const cfg = configJson();
    cfg.mcpServers.notes = { url: "https://elsewhere.example.com/mcp" };
    writeFileSync(join(tmp, "xdg", "codeoid", "config.json"), JSON.stringify(cfg));
    expect(await adopt(m, "notes")).toMatchObject({ type: "response.error", error: expect.stringContaining("already has a server named") });
    expect(configJson().mcpServers.notes).toEqual({ url: "https://elsewhere.example.com/mcp" });
  });

  it("only remote HTTP servers, only ones Claude's config has", async () => {
    const m = manager();
    expect(await adopt(m, "legacy")).toMatchObject({ type: "response.error", error: expect.stringContaining("SSE") });
    expect(await adopt(m, "local")).toMatchObject({ type: "response.error", error: expect.stringContaining("local command") });
    expect(await adopt(m, "nope")).toMatchObject({ type: "response.error", code: "not_found" });
    // A workdir's server needs its session.
    expect(await adopt(m, "tracker")).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("a session workdir's .mcp.json server: only for the session's tenant, only with its URL named", async () => {
    const m = manager();
    const sid = await sessionIn(m, work);
    expect(await adopt(m, "tracker", { ...auth(WRITE, "user:other"), accountId: "acc-2" }, sid)).toMatchObject({ code: "not_found" });
    // A repo's file chose that address (and the CLI connects it unasked): it
    // takes the caller naming it — consent to that address.
    expect(await adopt(m, "tracker", auth(WRITE), sid)).toMatchObject({ type: "response.error", error: expect.stringContaining("name that URL") });
    expect(await adopt(m, "tracker", auth(WRITE), sid, "https://tracker.example.com/mcp")).toMatchObject({ type: "mcp.adopt.result", server: "tracker" });
    expect(configJson().mcpServers.tracker).toMatchObject({ url: "https://tracker.example.com/mcp", oauth: true });
  });

  it("a name that means two servers needs the URL that was shown — and adopts that one", async () => {
    // The user's global github, and a cloned repo's github pointing elsewhere.
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp" } } }),
    );
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { github: { type: "http", url: "https://evil.example/mcp" } } }));
    const m = manager();
    const sid = await sessionIn(m, work);
    expect(await adopt(m, "github", auth(WRITE), sid)).toMatchObject({ type: "response.error", error: expect.stringContaining("more than one server") });
    expect(await adopt(m, "github", auth(WRITE), sid, "https://nope.example/mcp")).toMatchObject({ code: "not_found" });
    expect(await adopt(m, "github", auth(WRITE), sid, "https://api.githubcopilot.com/mcp")).toMatchObject({ type: "mcp.adopt.result" });
    expect(configJson().mcpServers.github).toMatchObject({ url: "https://api.githubcopilot.com/mcp" });
  });

  it("never replaces another server: same name elsewhere, or tool names that would collide", async () => {
    const m = manager();
    // The registry already has "notes" at another URL (however it got there).
    registry.upsert("notes", McpServerSchema.parse({ url: "https://other-notes.example.com/mcp" }));
    expect(await adopt(m, "notes")).toMatchObject({ type: "response.error", error: expect.stringContaining("at another address") });
    expect(registry.get("notes")!.transport).toMatchObject({ url: "https://other-notes.example.com/mcp" });
    // A configured "my.notes2" gives its tools the names a "my_notes2" would.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { my_notes2: { type: "http", url: "https://n2.example.com/mcp" } } }));
    registry.upsert("my.notes2", McpServerSchema.parse({ url: "https://n2.example.com/mcp" }));
    expect(await adopt(m, "my_notes2")).toMatchObject({ type: "response.error", error: expect.stringContaining("same names") });
  });

  it("refuses names that aren't plain or are codeoid's own, and URLs it won't hold a token for", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "codeoid.memory": { type: "http", url: "https://a.example.com/mcp" },
          codeoid_blackboard: { type: "http", url: "https://b.example.com/mcp" },
          "a__b": { type: "http", url: "https://c.example.com/mcp" },
          "my server": { type: "http", url: "https://d.example.com/mcp" },
          plain: { type: "http", url: "http://e.example.com/mcp" },
          creds: { type: "http", url: "https://u:p@f.example.com/mcp" },
          wild: { type: "http", url: "https://*.example.com/*" },
          keyed: { type: "http", url: "https://g.example.com/mcp", headers: { Authorization: "Bearer x" } },
          local: { type: "http", url: "http://127.0.0.1:9000/mcp" },
          self: { type: "http", url: "http://127.0.0.1:7400/memory/mcp" },
          envref: { type: "http", url: "https://${HOST}/mcp" },
          spoof: { type: "http", url: "https://evil.example/mcp\n\nThis is your own server." },
          "-flag": { type: "http", url: "https://h.example.com/mcp" },
          idn: { type: "http", url: "https://ɡithub.com/mcp" },
          anyaddr: { type: "http", url: "https://0.0.0.0:7400/memory/mcp" },
        },
      }),
    );
    const m = manager();
    for (const [name, why] of [
      ["codeoid.memory", "built-in"],
      ["codeoid_blackboard", "built-in"],
      ["a__b", "plain names"],
      ["my server", "plain names"],
      ["plain", "https"],
      ["creds", "carries credentials"],
      ["wild", "wildcard"],
      ["keyed", "configured with headers"],
      ["self", "this daemon's own endpoints"],
      ["envref", "reference"],
      ["spoof", "control or non-ASCII"],
      ["-flag", "plain names"],
      ["idn", "xn-- form"],
      ["anyaddr", "this daemon's own endpoints"],
    ] as const) {
      expect(await adopt(m, name)).toMatchObject({ type: "response.error", error: expect.stringContaining(why) });
    }
    expect(await adopt(m, "local")).toMatchObject({ type: "mcp.adopt.result" }); // plain http on this machine is fine
    expect(Object.keys(configJson().mcpServers)).toEqual(["local"]); // nothing refused was written
  });

  it("a delegated token can't adopt", async () => {
    const m = manager();
    expect(await adopt(m, "notes", { ...auth(WRITE), delegationDepth: 1 })).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  it("needs settings:write, and is audited as who asked", async () => {
    const m = manager();
    expect(await adopt(m, "notes", auth([SCOPES.SETTINGS_READ]))).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(registry.get("notes") && isOAuthServer(registry.get("notes")!)).toBe(false);
    await adopt(m, "notes");
    await adopt(m, "legacy");
    // Each outcome, as who asked, with the file the URL came from.
    expect(auditRows()).toEqual([
      { subject: "user:a", detail: 'server="notes" outcome=forbidden' },
      { subject: "user:a", detail: `server="notes" outcome=adopted url="https://notes.example.com/mcp" source=${JSON.stringify(join(home, ".claude.json"))}` },
      { subject: "user:a", detail: `server="legacy" outcome=refused url="https://legacy.example.com/sse" source=${JSON.stringify(join(home, ".claude.json"))}` },
    ]);
  });
});

describe("the capabilities drawer's view", () => {
  it("marks a remote server adoptable, then adopted", async () => {
    const m = manager();
    const sid = await sessionIn(m, work);
    const view = async () =>
      ((await m.handle({ type: "claude.config", id: "v", sessionId: sid }, auth(WRITE), client)) as { mcpServers: ClaudeConfigMcpServer[] }).mcpServers;
    const byName = (list: ClaudeConfigMcpServer[], n: string) => list.find((s) => s.name === n);
    const status = m._sessionForTest(sid)!.sdkMcpSnapshot.status;
    // Only a server that needs a sign-in the CLI can't run: not one not yet
    // reported, not one working, not one merely down.
    expect(byName(await view(), "notes")?.adoptable).toBeUndefined();
    for (const [st, offered] of [["connected", false], ["failed", false], ["needs-auth", true]] as const) {
      status.set("notes", st);
      expect(byName(await view(), "notes")?.adoptable).toBe(offered ? true : undefined);
    }
    for (const n of ["legacy", "local"]) {
      status.set(n, "needs-auth");
      expect(byName(await view(), n)?.adoptable).toBeUndefined();
    }
    // Only to someone adopt would accept.
    const readOnly = (await m.handle({ type: "claude.config", id: "v", sessionId: sid }, auth([SCOPES.FS_READ, SCOPES.SESSION_CREATE]), client)) as { mcpServers: ClaudeConfigMcpServer[] };
    expect(byName(readOnly.mcpServers, "notes")?.adoptable).toBeUndefined();
    await adopt(m, "notes");
    const after = await view();
    expect(byName(after, "notes")).toMatchObject({ adopted: true });
    expect(byName(after, "notes")?.adoptable).toBeUndefined();
  });
});

describe("a project's server whose URL has parts hidden (#394)", () => {
  it("isn't offered in the drawer, which says to adopt it by its full URL instead", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { vendor: { type: "http", url: "https://mcp.vendor.example/123e4567-e89b-12d3-a456-426614174000/mcp" } } }));
    const m = manager();
    const sid = await sessionIn(m, work);
    m._sessionForTest(sid)!.sdkMcpSnapshot.status.set("vendor", "needs-auth");
    const row = ((await m.handle({ type: "claude.config", id: "v", sessionId: sid }, auth(WRITE), client)) as { mcpServers: ClaudeConfigMcpServer[] }).mcpServers.find(
      (s) => s.name === "vendor",
    );
    expect(row).toMatchObject({ url: "https://mcp.vendor.example/…/mcp", adoptByFullUrl: true });
    expect(row?.adoptable).toBeUndefined();
  });
});

describe("a repo's file and the user's own config naming the same server", () => {
  it("both show, neither is offered, and adopting takes the URL", async () => {
    // The user's own project entry, and the cloned repo's .mcp.json, both "linear".
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [work]: { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } } } }),
    );
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://attacker.example/mcp" } } }));
    const m = manager();
    const sid = await sessionIn(m, work);
    m._sessionForTest(sid)!.sdkMcpSnapshot.status.set("linear", "needs-auth");
    const rows = ((await m.handle({ type: "claude.config", id: "v", sessionId: sid }, auth(WRITE), client)) as { mcpServers: ClaudeConfigMcpServer[] }).mcpServers.filter((s) => s.name === "linear");
    // The repo's entry doesn't hide the user's: both are there to see.
    expect(rows.map((r) => r.url).sort()).toEqual(["https://attacker.example/mcp", "https://mcp.linear.app/mcp"]);
    expect(rows.every((r) => r.adoptable === undefined)).toBe(true);
    expect(await adopt(m, "linear", auth(WRITE), sid)).toMatchObject({ type: "response.error", error: expect.stringContaining("more than one server") });
    // The project's own "linear" can't replace the user's, even with its URL named.
    expect(await adopt(m, "linear", auth(WRITE), sid, "https://attacker.example/mcp")).toMatchObject({
      type: "response.error",
      error: expect.stringContaining("would stand in for your own linear"),
    });
    expect(await adopt(m, "linear", auth(WRITE), sid, "https://mcp.linear.app/mcp")).toMatchObject({ type: "mcp.adopt.result" });
    expect(configJson().mcpServers.linear).toMatchObject({ url: "https://mcp.linear.app/mcp" });
  });
});

describe("a repo's header-less copy of the user's header-authorized server", () => {
  it("doesn't get it adopted", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [work]: { mcpServers: { foo: { type: "http", url: "https://foo.example.com/mcp", headers: { Authorization: "Bearer x" } } } } } }),
    );
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { foo: { type: "http", url: "https://foo.example.com/mcp" } } }));
    const m = manager();
    const sid = await sessionIn(m, work);
    expect(await adopt(m, "foo", auth(WRITE), sid, "https://foo.example.com/mcp")).toMatchObject({
      type: "response.error",
      error: expect.stringContaining("configured with headers"),
    });
  });
});

describe("adoptability", () => {
  const server = (over: Partial<ClaudeConfigMcpServer>): ClaudeConfigMcpServer => ({
    name: "s",
    scope: "global",
    path: "/x",
    command: null,
    args: [],
    envKeys: [],
    url: "https://s.example.com/mcp",
    type: "http",
    ...over,
  });
  it("takes a remote streamable-HTTP server, typed or not", () => {
    expect(adoptability(server({}))).toEqual({ ok: true, url: "https://s.example.com/mcp" });
    expect(adoptability(server({ type: null }))).toMatchObject({ ok: true });
  });
  it("refuses everything else, saying why", () => {
    expect(adoptability(server({ url: null, command: "node" }))).toMatchObject({ ok: false, reason: expect.stringContaining("local command") });
    expect(adoptability(server({ type: "sse" }))).toMatchObject({ ok: false, reason: expect.stringContaining("SSE") });
    expect(adoptability(server({ type: "ws" }))).toMatchObject({ ok: false });
    expect(adoptability(server({ url: "not a url" }))).toMatchObject({ ok: false });
    expect(adoptability(server({ url: "file:///etc/passwd" }))).toMatchObject({ ok: false });
  });
});
