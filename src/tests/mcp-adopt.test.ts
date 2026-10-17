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
        notes: { type: "http", url: "https://notes.example.com/mcp", headers: { "X-Team": "t1" } },
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

const adopt = (m: SessionManager, server: string, a = auth(WRITE), sessionId?: string) =>
  m.handle({ type: "mcp.adopt", id: "a", server, ...(sessionId ? { sessionId } : {}) }, a, client) as Promise<DaemonMessage>;
const configJson = () => JSON.parse(readFileSync(join(tmp, "xdg", "codeoid", "config.json"), "utf8")) as { mcpServers: Record<string, unknown> };

describe("mcp.adopt", () => {
  it("puts the server's URL in codeoid's registry with OAuth — on disk and live", async () => {
    const m = manager();
    const r = (await adopt(m, "notes")) as McpAdoptResultMsg;
    expect(r).toMatchObject({ type: "mcp.adopt.result", server: "notes", alreadyAdopted: false });
    // Headers are not carried over: the token authorizes an OAuth server.
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

  it("finds a session workdir's .mcp.json server — only for the session's tenant", async () => {
    const m = manager();
    const created = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: work }, auth(WRITE), client)) as { data: { id: string } };
    const sid = created.data.id;
    expect(await adopt(m, "tracker", { ...auth(WRITE, "user:other"), accountId: "acc-2" }, sid)).toMatchObject({ code: "not_found" });
    expect(await adopt(m, "tracker", auth(WRITE), sid)).toMatchObject({ type: "mcp.adopt.result", server: "tracker" });
    expect(configJson().mcpServers.tracker).toMatchObject({ url: "https://tracker.example.com/mcp", oauth: true });
  });

  it("needs settings:write, and is audited as who asked", async () => {
    const m = manager();
    expect(await adopt(m, "notes", auth([SCOPES.SETTINGS_READ]))).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(registry.get("notes") && isOAuthServer(registry.get("notes")!)).toBe(false);
    await adopt(m, "notes");
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const rows = db.query("SELECT subject, detail FROM audit_log WHERE action = 'mcp.adopt'").all() as Array<{ subject: string; detail: string }>;
    db.close();
    expect(rows).toEqual([{ subject: "user:a", detail: 'server="notes" host=notes.example.com from=global' }]);
  });
});

describe("the capabilities drawer's view", () => {
  it("marks a remote server adoptable, then adopted", async () => {
    const m = manager();
    const created = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: work }, auth(WRITE), client)) as { data: { id: string } };
    const view = async () =>
      ((await m.handle({ type: "claude.config", id: "v", sessionId: created.data.id }, auth(WRITE), client)) as { mcpServers: ClaudeConfigMcpServer[] }).mcpServers;
    const byName = (list: ClaudeConfigMcpServer[], n: string) => list.find((s) => s.name === n);
    const before = await view();
    expect(byName(before, "notes")).toMatchObject({ adoptable: true });
    expect(byName(before, "legacy")?.adoptable).toBeUndefined();
    expect(byName(before, "local")?.adoptable).toBeUndefined();
    await adopt(m, "notes");
    const after = await view();
    expect(byName(after, "notes")).toMatchObject({ adopted: true });
    expect(byName(after, "notes")?.adoptable).toBeUndefined();
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
