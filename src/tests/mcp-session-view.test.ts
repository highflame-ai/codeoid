/**
 * A session's view of its MCP servers (#395): the daemon-wide registry plus
 * its own workdir's Claude servers — the user's own always, a repo's once
 * approved (in Claude's own ~/.claude.json, or in codeoid for that exact
 * entry) — with codeoid's own entries winning, the backends that read a
 * project's .mcp.json themselves left to it, and a server that wants an OAuth
 * sign-in held back (per tenant) from the backends that would only get 401s.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig, RawMcpServerConfig } from "../config.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { importClaudeMcpServers } from "../daemon/mcp/import-claude.js";
import { McpOAuth } from "../daemon/mcp/oauth.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { SessionMcpView } from "../daemon/mcp/session-view.js";
import { fingerprintOf, readWorkdirServers, type WorkdirServer } from "../daemon/mcp/workdir-servers.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SCOPES } from "../protocol/scopes.js";
import type { AuthContext, ClaudeConfigMcpServer } from "../protocol/types.js";

let tmp: string;
let home: string;
let work: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-view-"));
  home = join(tmp, "home");
  work = join(tmp, "work");
  mkdirSync(home);
  mkdirSync(work);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const TENANT = { accountId: "a", projectId: "p" };
const OTHER = { accountId: "b", projectId: "q" };

const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
  ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "workspace", enabled: true, native: false, ...p }) as RawMcpServerConfig;

function claudeJson(projects: Record<string, unknown>, top: Record<string, unknown> = {}): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: top, projects }));
}

describe("reading a workdir's servers", () => {
  it("the user's own count; a repo's carries Claude's approval from the user's ~/.claude.json", async () => {
    claudeJson({ [work]: { mcpServers: { mine: { command: "my-mcp" } }, enabledMcpjsonServers: ["ok"], disabledMcpjsonServers: ["no"] } });
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { ok: { command: "a" }, no: { command: "b" }, unasked: { command: "c" } } }));
    const read = await readWorkdirServers(work, home);
    const by = (n: string) => read.find((w) => w.name === n)!;
    expect(by("mine")).toMatchObject({ origin: "claude-local", claudeApproval: "approved" });
    expect(by("ok")).toMatchObject({ origin: "claude-repo", claudeApproval: "approved" });
    expect(by("no").claudeApproval).toBe("denied");
    expect(by("unasked").claudeApproval).toBe("unset");
  });

  it("enableAllProjectMcpServers approves the project's servers, but not one denied", async () => {
    claudeJson({ [work]: { enableAllProjectMcpServers: true, disabledMcpjsonServers: ["no"] } });
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "a" }, no: { command: "b" } } }));
    const read = await readWorkdirServers(work, home);
    expect(read.find((w) => w.name === "a")?.claudeApproval).toBe("approved");
    expect(read.find((w) => w.name === "no")?.claudeApproval).toBe("denied");
  });

  it("no file in the workdir can approve the repo's servers — however it got there", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    mkdirSync(join(work, "cfg"));
    writeFileSync(join(work, "cfg", "settings.local.json"), JSON.stringify({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ["a"] }));
    symlinkSync(join(work, "cfg"), join(work, ".claude"));
    expect((await readWorkdirServers(work, home)).find((w) => w.name === "a")?.claudeApproval).toBe("unset");
  });

  it("takes no servers from settings files (Claude Code doesn't), nor a .mcp.json that resolves outside the workdir", async () => {
    mkdirSync(join(work, ".claude"));
    writeFileSync(join(work, ".claude", "settings.json"), JSON.stringify({ mcpServers: { s: { command: "s" } } }));
    writeFileSync(join(tmp, "elsewhere.json"), JSON.stringify({ mcpServers: { out: { command: "out" } } }));
    symlinkSync(join(tmp, "elsewhere.json"), join(work, ".mcp.json"));
    expect(await readWorkdirServers(work, home)).toEqual([]);
  });

  it("skips names that could pass for another server's tools, and strips references to codeoid's own secrets", async () => {
    writeFileSync(
      join(work, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh__x: { command: "a" },
          mcp__codeoid_memory: { command: "a" },
          "gіthub": { command: "a" }, // a Cyrillic і
          ok: { command: "a", env: { KEY: "${CODEOID_API_KEY}", HOME_DIR: "${HOME}", T: "x${TELEGRAM_BOT_TOKEN}y" } },
        },
      }),
    );
    const read = await readWorkdirServers(work, home);
    expect(read.map((w) => w.name)).toEqual(["ok"]);
    expect(read[0]!.raw.env).toEqual({ KEY: "", HOME_DIR: "${HOME}", T: "xy" });
  });

  it("an edit to an entry is a new fingerprint", () => {
    expect(fingerprintOf(raw({ command: "a", args: ["1"] }))).not.toBe(fingerprintOf(raw({ command: "a", args: ["2"] })));
    expect(fingerprintOf(raw({ command: "a", env: { X: "1", Y: "2" } }))).toBe(fingerprintOf(raw({ command: "a", env: { Y: "2", X: "1" } })));
  });

  it("the daemon-wide import is ~/.claude.json's global block only", () => {
    claudeJson({}, { a: { command: "from-claude-json" } });
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { b: { command: "b" } } }));
    expect(Object.keys(importClaudeMcpServers(home))).toEqual(["a"]);
  });
});

/** A view over `registry` with these workdir servers read (and no global re-read unless given). */
function view(
  registry: McpRegistry,
  read: WorkdirServer[],
  opts: { hub?: McpHub; approvals?: Set<string>; global?: () => Record<string, RawMcpServerConfig> | null; tenant?: typeof TENANT } = {},
): SessionMcpView {
  return new SessionMcpView(registry, opts.hub ?? null, {
    workdir: "/w",
    tenant: opts.tenant ?? TENANT,
    approvals: () => opts.approvals ?? new Set(),
    read: async () => read,
    readGlobal: async () => (opts.global ? opts.global() : null),
  });
}

function entry(name: string, origin: WorkdirServer["origin"], r: RawMcpServerConfig, approval: WorkdirServer["claudeApproval"] = origin === "claude-local" ? "approved" : "unset"): WorkdirServer {
  return { name, raw: r, origin, path: origin === "claude-local" ? "/h/.claude.json" : "/w/.mcp.json", claudeApproval: approval, fingerprint: fingerprintOf(r) };
}

describe("a session's view", () => {
  it("adds the workdir's servers for every backend but Claude (which loads its own), run in the workdir", async () => {
    const v = view(new McpRegistry({}, { memoryEnabled: false }), [entry("mine", "claude-local", raw({ command: "my-mcp" }))]);
    await v.load();
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["mine"]);
    expect(v.forBackend("openai")[0]?.transport).toMatchObject({ kind: "stdio", cwd: "/w" });
    expect(v.forNativeMount("claude")).toEqual([]);
    expect(v.reachOf("mine", "/h/.claude.json")).toEqual({ reach: "all" });
  });

  it("a repo's server reaches the other backends once approved — in Claude, or in codeoid for that exact entry", async () => {
    const r = raw({ command: "repo-mcp" });
    const approvals = new Set<string>();
    const v = view(new McpRegistry({}, { memoryEnabled: false }), [entry("repo", "claude-repo", r)], { approvals });
    await v.load();
    expect(v.forNativeMount("codex")).toEqual([]);
    expect(v.reachOf("repo", "/w/.mcp.json")).toEqual({ reach: "claude-only", why: "needs-approval" });
    approvals.add(`repo\u0000${fingerprintOf(r)}`);
    expect(await v.stale()).toBe(true); // noticed — not applied
    expect(v.forNativeMount("codex")).toEqual([]);
    expect(v.reachOf("repo", "/w/.mcp.json")).toEqual({ reach: "claude-only", why: "needs-refresh" });
    expect((await v.load()).changed).toBe(true); // applied on a refresh
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["repo"]);
    const edited = view(new McpRegistry({}, { memoryEnabled: false }), [entry("repo", "claude-repo", raw({ command: "evil" }))], { approvals });
    await edited.load();
    expect(edited.forNativeMount("codex")).toEqual([]);
    const inClaude = view(new McpRegistry({}, { memoryEnabled: false }), [entry("repo", "claude-repo", r, "approved")]);
    await inClaude.load();
    expect(inClaude.forNativeMount("codex").map((s) => s.name)).toEqual(["repo"]);
  });

  it("codeoid's own entry wins over a workdir one; the user's own wins over a global import; a repo's never displaces", async () => {
    const reg = new McpRegistry(
      { cfg: raw({ command: "codeoid-config" }), imp: raw({ command: "imported" }), userown: raw({ command: "imported-u" }) },
      { memoryEnabled: false, imported: new Set(["imp", "userown"]) },
    );
    const v = view(reg, [
      entry("cfg", "claude-local", raw({ command: "workdir-cfg" })),
      entry("imp", "claude-local", raw({ command: "workdir-imp" })),
      entry("userown", "claude-repo", raw({ command: "repo-over-import" }), "approved"),
      entry("My-Thing", "claude-repo", raw({ command: "lookalike" }), "approved"),
      entry("my_thing", "claude-local", raw({ command: "mine" })),
    ]);
    await v.load();
    const cmd = (backend: string, name: string) => {
      const t = v.forNativeMount(backend).find((s) => s.name === name)?.transport;
      return t?.kind === "stdio" ? t.command : undefined;
    };
    expect(cmd("codex", "cfg")).toBe("codeoid-config");
    expect(cmd("codex", "imp")).toBe("workdir-imp");
    expect(cmd("claude", "imp")).toBe("imported");
    expect(cmd("codex", "userown")).toBe("imported-u");
    expect(cmd("codex", "my_thing")).toBe("mine");
    expect(v.forNativeMount("codex").some((s) => s.name === "My-Thing")).toBe(false);
    expect(v.reachOf("cfg", "/h/.claude.json")).toEqual({ reach: "claude-only", why: "shadowed" });
    expect(v.reachOf("My-Thing", "/w/.mcp.json")).toEqual({ reach: "claude-only", why: "shadowed" });
    // The global "imp" is shown as not used: the user's workdir one is.
    expect(v.reachOfGlobal("imp", null, "imported")).toEqual({ reach: "claude-only", why: "shadowed" });
    expect(v.reachOfGlobal("userown", null, "imported-u")).toEqual({ reach: "all" });
    expect(v.reachOfGlobal("cfg", null, "codeoid-config")).toEqual({ reach: "claude-only", why: "shadowed" });
    expect(v.reachOfGlobal("codeoid_memory", null, "x")).toEqual({ reach: "claude-only", why: "reserved-name" });
  });

  it("holds a server that wants a sign-in back from this tenant's backends that would get 401s — not Claude, not another tenant", async () => {
    const hub = new McpHub({});
    const reg = new McpRegistry({ remote: raw({ url: "https://r.example.com/mcp" }) }, { memoryEnabled: false, imported: new Set(["remote"]) });
    const mine = view(reg, [], { hub });
    const theirs = view(reg, [], { hub, tenant: OTHER });
    await mine.load();
    await theirs.load();
    hub.markNeedsSignIn("https://r.example.com/mcp", TENANT);
    expect(mine.forNativeMount("codex")).toEqual([]);
    expect(mine.forBackend("openai")).toEqual([]);
    expect(mine.forNativeMount("claude").map((s) => s.name)).toEqual(["remote"]);
    expect(theirs.forNativeMount("codex").map((s) => s.name)).toEqual(["remote"]);
    expect(mine.reachOfGlobal("remote", "https://r.example.com/mcp", null)).toEqual({ reach: "claude-only", why: "needs-sign-in" });
  });

  it("a project's .mcp.json server is left to a backend that reads it itself (Claude, Qwen) — and so is any name it declares", async () => {
    const team = entry("team", "claude-repo", raw({ command: "team" }), "approved");
    const twin = entry("twin", "claude-local", raw({ command: "team" })); // same config, the user's own
    const mine = entry("mine", "claude-local", raw({ command: "m" }));
    const sameName = entry("mine", "claude-repo", raw({ command: "repo-mine" }), "approved");
    const v = view(new McpRegistry({}, { memoryEnabled: false }), [team, twin, mine, sameName]);
    await v.load();
    expect(v.forNativeMount("codex").map((s) => s.name).sort()).toEqual(["mine", "team", "twin"]);
    expect(v.forNativeMount("qwen").map((s) => s.name).sort()).toEqual(["mine", "twin"]);
    expect(v.reachOf("team", "/w/.mcp.json", "qwen")).toEqual({ reach: "claude-only", why: "read-by-backend" });
    expect(v.reachOf("team", "/w/.mcp.json", "codex")).toEqual({ reach: "all" });
    // Qwen's own copy of a .mcp.json name wins over the user's same-named one: said so.
    expect(v.reachOf("mine", "/h/.claude.json", "qwen")).toEqual({ reach: "claude-only", why: "read-by-backend" });
  });

  it("nothing changes until it's applied: stale says so, load applies, and says what went", async () => {
    const read: WorkdirServer[] = [entry("old", "claude-local", raw({ command: "o" }))];
    const v = view(new McpRegistry({}, { memoryEnabled: false }), read);
    expect((await v.load()).changed).toBe(false);
    read.splice(0, 1, entry("new", "claude-local", raw({ command: "n" })));
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["old"]);
    expect(await v.stale()).toBe(true);
    const change = await v.load();
    expect(change.changed).toBe(true);
    expect(change.removed.map((s) => s.name)).toEqual(["old"]);
    expect(await v.stale()).toBe(false);
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["new"]);
  });

  it("a refresh picks up the user's global Claude servers too — never touching codeoid's own entries", async () => {
    const reg = new McpRegistry({ a: raw({ command: "a" }), mine: raw({ command: "codeoid-own" }) }, { memoryEnabled: false, imported: new Set(["a"]) });
    let global: Record<string, RawMcpServerConfig> = { a: raw({ command: "a" }) };
    const v = view(reg, [], { global: () => global });
    await v.load();
    expect(await v.stale()).toBe(false);
    global = { a: raw({ command: "a2" }), b: raw({ command: "b" }), mine: raw({ command: "from-claude" }) };
    expect(await v.stale()).toBe(true);
    expect((await v.load()).changed).toBe(true);
    const cmd = (name: string) => {
      const t = reg.get(name)?.transport;
      return t?.kind === "stdio" ? t.command : undefined;
    };
    expect([cmd("a"), cmd("b"), cmd("mine")]).toEqual(["a2", "b", "codeoid-own"]);
    expect(await v.stale()).toBe(false); // a name codeoid owns doesn't read as a pending change
    global = { b: raw({ command: "b" }) };
    await v.load();
    expect(reg.get("a")).toBeUndefined();
  });
});

describe("the hub and workdir servers", () => {
  it("runs a workdir stdio server in its workdir; never puts it in the daemon-wide registry", async () => {
    const reg = new McpRegistry({}, { memoryEnabled: false });
    const a = view(reg, [entry("db", "claude-local", raw({ command: "db" }))]);
    await a.load();
    expect(a.forNativeMount("codex")[0]!.transport).toMatchObject({ cwd: "/w" });
    expect(reg.get("db")).toBeUndefined();
  });

  it("marks a server that answers the MCP sign-in challenge — for that tenant, and not one given credentials of its own", async () => {
    let challenge = true;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (challenge) return new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"' } });
        const body = (await req.json().catch(() => ({}))) as { id?: number; method?: string };
        if (body.id === undefined) return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "p", version: "1" } }
            : { tools: [{ name: "t", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/mcp`;
      const reg = new McpRegistry({ p: raw({ url }), withToken: raw({ url, headers: { Authorization: "Bearer expired" } }) }, { memoryEnabled: false });
      const hub = new McpHub({});
      const scope = { workspaceId: "w", sessionId: "s", tenant: TENANT };
      expect(await hub.listTools(reg.get("p")!, scope)).toEqual([]);
      expect(hub.needsSignIn(url, TENANT)).toBe(true);
      expect(hub.needsSignIn(url, OTHER)).toBe(false);
      const hub2 = new McpHub({});
      await hub2.listTools(reg.get("withToken")!, scope);
      expect(hub2.needsSignIn(url, TENANT)).toBe(false); // an expired static token isn't a sign-in to adopt
      challenge = false;
      expect((await hub.listTools(reg.get("p")!, scope)).map((t) => t.name)).toEqual(["t"]);
      expect(hub.needsSignIn(url, TENANT)).toBe(false);
      hub.closeAll();
      hub2.closeAll();
    } finally {
      server.stop(true);
    }
  });
});

// ── through the session manager ──────────────────────────────────────────────

const ALL = [SCOPES.SETTINGS_WRITE, SCOPES.SETTINGS_READ, SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND, SCOPES.FS_READ];
const auth = (scopes: string[], delegationDepth = 0): AuthContext => ({
  sub: "user:a",
  scopes: scopes as AuthContext["scopes"],
  delegationDepth,
  accountId: "acc-1",
  projectId: "proj-1",
});
const client = { id: "c1", auth: auth(ALL), send: () => {} };

describe("approve and refresh, through the session manager", () => {
  let store: Store;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    store = new Store(join(tmp, "codeoid.db"));
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      store.close();
    } catch {}
  });

  function manager(make?: () => MockSessionProvider, onProvider?: (p: MockSessionProvider) => void): SessionManager {
    const providers = new ProviderRegistry("claude");
    providers.register({
      id: "claude",
      displayName: "claude",
      create: () => {
        const p = make ? make() : new MockSessionProvider("claude", []);
        onProvider?.(p);
        return p;
      },
    });
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
    const oauth = new McpOAuth({ store, redirectBaseUrl: () => "http://127.0.0.1:7999", env: {} });
    m.setMcp(new McpRegistry({}, { memoryEnabled: false }), new McpHub({ credentials: oauth }), oauth);
    return m;
  }

  async function session(m: SessionManager): Promise<string> {
    const r = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: work }, auth(ALL), client)) as { data: { id: string } };
    return r.data.id;
  }

  async function rows(m: SessionManager, sid: string): Promise<{ servers: ClaudeConfigMcpServer[]; stale: boolean }> {
    const r = (await m.handle({ type: "claude.config", id: "v", sessionId: sid }, auth(ALL), client)) as { mcpServers: ClaudeConfigMcpServer[]; mcpStale?: boolean };
    return { servers: r.mcpServers, stale: r.mcpStale === true };
  }

  const approve = (m: SessionManager, sid: string, row: ClaudeConfigMcpServer, a = auth(ALL)) =>
    m.handle({ type: "mcp.approve", id: "a", sessionId: sid, server: row.name, path: row.path, fingerprint: row.fingerprint! }, a, client);

  it("the drawer says how far each server reaches; approving what it showed takes it everywhere", async () => {
    claudeJson({ [work]: { mcpServers: { mine: { command: "my-mcp" } } } });
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }));
    const m = manager();
    const sid = await session(m);
    let r = await rows(m, sid);
    const team = r.servers.find((s) => s.name === "team")!;
    expect(r.servers.find((s) => s.name === "mine")?.otherBackends).toEqual({ reach: "all" });
    expect(team.otherBackends).toEqual({ reach: "claude-only", why: "needs-approval" });
    expect(team.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(r.stale).toBe(false);

    expect(await approve(m, sid, team)).toMatchObject({ type: "response.ok", data: { server: "team" } });
    await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client);
    r = await rows(m, sid);
    expect(r.servers.find((s) => s.name === "team")?.otherBackends).toEqual({ reach: "all" });

    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const audit = db.query("SELECT detail FROM audit_log WHERE action = 'mcp.approve'").all() as Array<{ detail: string }>;
    db.close();
    expect(audit[0]?.detail).toContain(`source=${JSON.stringify(join(work, ".mcp.json"))}`);
    expect(audit[0]?.detail).toContain(`fingerprint=${team.fingerprint}`);
  });

  it("approves only the entry that was shown: one changed since is refused", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }));
    const m = manager();
    const sid = await session(m);
    const shown = (await rows(m, sid)).servers.find((s) => s.name === "team")!;
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "sh", args: ["-c", "evil"] } } }));
    expect(await approve(m, sid, shown)).toMatchObject({ type: "response.error", error: expect.stringContaining("changed since it was shown") });
  });

  it("an edit to an approved entry needs approval again", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }));
    const m = manager();
    const sid = await session(m);
    await approve(m, sid, (await rows(m, sid)).servers.find((s) => s.name === "team")!);
    await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client);
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp", args: ["--exfil"] } } }));
    await m.handle({ type: "session.mcp_refresh", id: "r2", sessionId: sid }, auth(ALL), client);
    expect((await rows(m, sid)).servers.find((s) => s.name === "team")?.otherBackends).toEqual({ reach: "claude-only", why: "needs-approval" });
  });

  it("approving is the session owner's own act: settings:write, a token of their own", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }));
    const m = manager();
    const sid = await session(m);
    const row = (await rows(m, sid)).servers.find((s) => s.name === "team")!;
    expect(await approve(m, sid, row, auth([SCOPES.SESSION_SEND, SCOPES.FS_READ]))).toMatchObject({ code: "forbidden" });
    expect(await approve(m, sid, row, auth(ALL, 1))).toMatchObject({ code: "forbidden" });
    expect(await approve(m, sid, { ...row, name: "nope" })).toMatchObject({ code: "not_found" });
    expect(await approve(m, sid, row, { ...auth(ALL), accountId: "acc-2" })).toMatchObject({ code: "not_found" });
  });

  it("a refresh that changes something restarts the backend; one that changes nothing doesn't", async () => {
    const providers: MockSessionProvider[] = [];
    const m = manager(undefined, (p) => providers.push(p));
    const sid = await session(m);
    await m.handle({ type: "session.mcp_refresh", id: "r0", sessionId: sid }, auth(ALL), client); // applies the first read
    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client)).toMatchObject({ data: { changed: false } });
    expect(providers[0]!.teardownCount).toBe(0);
    claudeJson({ [work]: { mcpServers: { added: { command: "new-mcp" } } } });
    expect((await rows(m, sid)).stale).toBe(true);
    expect(await m.handle({ type: "session.mcp_refresh", id: "r2", sessionId: sid }, auth(ALL), client)).toMatchObject({ data: { changed: true } });
    expect(providers[0]!.teardownCount).toBe(1);
  });

  it("a refresh asked for mid-turn waits for the turn — it never cuts work short", async () => {
    const providers: MockSessionProvider[] = [];
    const m = manager(() => new MockSessionProvider("claude", [[{ type: "text_delta", content: "working…" } as ProviderEvent]], { stall: true }), (p) => providers.push(p));
    const sid = await session(m);
    await m.handle({ type: "session.mcp_refresh", id: "r0", sessionId: sid }, auth(ALL), client);
    const s = m._sessionForTest(sid)!;
    await s.send("work", auth(ALL));
    for (let i = 0; i < 100 && s.status === "idle"; i++) await Bun.sleep(5);
    expect(s.status).not.toBe("idle"); // the turn is running
    claudeJson({ [work]: { mcpServers: { added: { command: "new-mcp" } } } });
    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client)).toMatchObject({
      data: { changed: true, deferred: true },
    });
    expect(providers[0]!.teardownCount).toBe(0);
  });

  it("opening the drawer applies nothing", async () => {
    claudeJson({ [work]: { mcpServers: { mine: { command: "my-mcp" } } } });
    const m = manager();
    const sid = await session(m);
    expect((await rows(m, sid)).servers.find((s) => s.name === "mine")?.otherBackends).toEqual({ reach: "all" }); // what will apply
    claudeJson({ [work]: { mcpServers: { mine2: { command: "other" } } } });
    // Nothing was applied by looking — so nothing reads as a pending change either.
    expect((await rows(m, sid)).stale).toBe(false);
    // The first read (a refresh, or the first turn) takes the config as it is now.
    await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client);
    expect((await rows(m, sid)).servers.find((s) => s.name === "mine2")?.otherBackends).toEqual({ reach: "all" });
  });

  it("refresh needs session:send on the caller's own session", async () => {
    const m = manager();
    const sid = await session(m);
    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth([SCOPES.FS_READ]), client)).toMatchObject({ code: "forbidden" });
    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, { ...auth(ALL), projectId: "other" }, client)).toMatchObject({ code: "not_found" });
  });
});
