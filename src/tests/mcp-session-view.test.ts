/**
 * A session's view of its MCP servers (#395): the daemon-wide registry plus
 * its own workdir's Claude servers — the user's own always, a repo's once
 * approved (in Claude or codeoid) — with codeoid's own entries winning, the
 * Claude CLI left to load its own copies, and a server that wants an OAuth
 * sign-in held back from the backends that would only get 401s from it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig, RawMcpServerConfig } from "../config.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpOAuth } from "../daemon/mcp/oauth.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { SessionMcpView } from "../daemon/mcp/session-view.js";
import { fingerprintOf, readWorkdirServers, type WorkdirServer } from "../daemon/mcp/workdir-servers.js";
import { importClaudeMcpServers } from "../daemon/mcp/import-claude.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
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

const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
  ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "workspace", enabled: true, native: false, ...p }) as RawMcpServerConfig;

function claudeJson(projects: Record<string, unknown>, top: Record<string, unknown> = {}): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: top, projects }));
}

function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe("reading a workdir's servers", () => {
  it("the user's own count; a repo's carries Claude's approval of it", async () => {
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

  it("trusts approvals in the project's settings.local.json only when git says it isn't the repo's", async () => {
    mkdirSync(join(work, ".claude"));
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    writeFileSync(join(work, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["a"] }));
    // Not a git repo: can't tell whose it is — not trusted.
    expect((await readWorkdirServers(work, home)).find((w) => w.name === "a")?.claudeApproval).toBe("unset");
    git(work, "init", "-q");
    // Untracked (as Claude Code leaves it): the user's.
    expect((await readWorkdirServers(work, home)).find((w) => w.name === "a")?.claudeApproval).toBe("approved");
    // Committed by the repo: the repo approving its own servers — not trusted.
    git(work, "add", "-f", ".claude/settings.local.json");
    git(work, "commit", "-q", "-m", "x");
    expect((await readWorkdirServers(work, home)).find((w) => w.name === "a")?.claudeApproval).toBe("unset");
  });

  it("asking git runs nothing a repo's own .git/config names", async () => {
    mkdirSync(join(work, ".claude"));
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    writeFileSync(join(work, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["a"] }));
    git(work, "init", "-q");
    const marker = join(tmp, "fsmonitor-ran");
    git(work, "config", "core.fsmonitor", `touch ${marker}`);
    await readWorkdirServers(work, home);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it("a repo's shared settings.json can't approve its own servers", async () => {
    mkdirSync(join(work, ".claude"));
    writeFileSync(join(work, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["a"], mcpServers: { a: { command: "a" } } }));
    expect((await readWorkdirServers(work, home)).find((w) => w.name === "a")?.claudeApproval).toBe("unset");
  });

  it("an edit to an entry is a new fingerprint", () => {
    expect(fingerprintOf(raw({ command: "a", args: ["1"] }))).not.toBe(fingerprintOf(raw({ command: "a", args: ["2"] })));
    expect(fingerprintOf(raw({ command: "a", env: { X: "1", Y: "2" } }))).toBe(fingerprintOf(raw({ command: "a", env: { Y: "2", X: "1" } })));
  });

  it("the daemon-wide import includes the user's settings files, the first file winning", () => {
    claudeJson({}, { a: { command: "from-claude-json" } });
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { a: { command: "later" }, b: { command: "b" } } }));
    const imported = importClaudeMcpServers(home);
    expect(imported.a?.command).toBe("from-claude-json");
    expect(imported.b?.command).toBe("b");
  });
});

/** A view over `registry` with these workdir servers read. */
function view(registry: McpRegistry, read: WorkdirServer[], opts: { hub?: McpHub; approvals?: Set<string> } = {}): SessionMcpView {
  return new SessionMcpView(registry, opts.hub ?? null, {
    workdir: "/w",
    tenant: { accountId: "a", projectId: "p" },
    approvals: () => opts.approvals ?? new Set(),
    read: async () => read,
  });
}

function entry(name: string, origin: WorkdirServer["origin"], r: RawMcpServerConfig, approval: WorkdirServer["claudeApproval"] = origin === "claude-local" ? "approved" : "unset"): WorkdirServer {
  return { name, raw: r, origin, path: origin === "claude-local" ? "/h/.claude.json" : "/w/.mcp.json", claudeApproval: approval, fingerprint: fingerprintOf(r) };
}

describe("a session's view", () => {
  it("adds the workdir's servers for every backend but Claude (which loads its own)", async () => {
    const v = view(new McpRegistry({}, { memoryEnabled: false }), [entry("mine", "claude-local", raw({ command: "my-mcp" }))]);
    await v.load();
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["mine"]);
    expect(v.forBackend("openai").map((s) => s.name)).toEqual(["mine"]);
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
    expect(await v.load()).toBe(true); // applied on a refresh
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["repo"]);
    // An approval of another entry (the repo edited it) isn't consent to this one.
    const edited = view(new McpRegistry({}, { memoryEnabled: false }), [entry("repo", "claude-repo", raw({ command: "evil" }))], { approvals });
    await edited.load();
    expect(edited.forNativeMount("codex")).toEqual([]);
    // Approved in Claude: counts too.
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
    expect(cmd("codex", "imp")).toBe("workdir-imp"); // as Claude orders them: local over user
    expect(cmd("claude", "imp")).toBe("imported"); // Claude's own copy comes from the CLI
    expect(cmd("codex", "userown")).toBe("imported-u"); // a repo's never stands in
    expect(cmd("codex", "my_thing")).toBe("mine");
    expect(v.forNativeMount("codex").some((s) => s.name === "My-Thing")).toBe(false); // nor a look-alike
    expect(v.reachOf("cfg", "/h/.claude.json")).toEqual({ reach: "claude-only", why: "shadowed" });
    expect(v.reachOf("My-Thing", "/w/.mcp.json")).toEqual({ reach: "claude-only", why: "shadowed" });
    expect(v.reachOfGlobal("imp", null, "imported")).toEqual({ reach: "all" });
    expect(v.reachOfGlobal("cfg", null, "codeoid-config")).toEqual({ reach: "claude-only", why: "shadowed" });
    expect(v.reachOfGlobal("codeoid_memory", null, "x")).toEqual({ reach: "claude-only", why: "reserved-name" });
  });

  it("holds a server that wants a sign-in back from the backends that would get 401s — not from Claude", async () => {
    const hub = new McpHub({});
    const reg = new McpRegistry({ remote: raw({ url: "https://r.example.com/mcp" }) }, { memoryEnabled: false, imported: new Set(["remote"]) });
    const v = view(reg, [], { hub });
    await v.load();
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["remote"]);
    hub.markNeedsSignIn("https://r.example.com/mcp");
    expect(v.forNativeMount("codex")).toEqual([]);
    expect(v.forBackend("openai")).toEqual([]);
    expect(v.forNativeMount("claude").map((s) => s.name)).toEqual(["remote"]);
    expect(v.reachOfGlobal("remote", "https://r.example.com/mcp", null)).toEqual({ reach: "claude-only", why: "needs-sign-in" });
  });

  it("a project's .mcp.json server is left to a backend that reads it itself (Claude, Qwen); its settings-file ones aren't", async () => {
    const fromMcpJson = entry("team", "claude-repo", raw({ command: "team" }), "approved");
    const fromSettings = { ...entry("set", "claude-repo", raw({ command: "set" }), "approved"), path: "/w/.claude/settings.json" };
    // "twin" is the user's own, with the very same config as the project's "team".
    const twin = entry("twin", "claude-local", raw({ command: "team" }));
    const v = view(new McpRegistry({}, { memoryEnabled: false }), [fromMcpJson, fromSettings, entry("mine", "claude-local", raw({ command: "m" })), twin]);
    await v.load();
    expect(v.forNativeMount("codex").map((s) => s.name).sort()).toEqual(["mine", "set", "team", "twin"]);
    expect(v.forNativeMount("qwen").map((s) => s.name).sort()).toEqual(["mine", "set", "twin"]); // Qwen has its own copy of "team" only
    expect(v.reachOf("team", "/w/.mcp.json", "qwen")).toEqual({ reach: "claude-only", why: "read-by-backend" });
    expect(v.reachOf("team", "/w/.mcp.json", "codex")).toEqual({ reach: "all" });
  });

  it("nothing changes until it's read again: stale says so, load applies", async () => {
    const read: WorkdirServer[] = [];
    const v = view(new McpRegistry({}, { memoryEnabled: false }), read);
    expect(await v.load()).toBe(false);
    read.push(entry("new", "claude-local", raw({ command: "n" })));
    expect(v.forNativeMount("codex")).toEqual([]);
    expect(await v.stale()).toBe(true);
    expect(await v.load()).toBe(true);
    expect(await v.stale()).toBe(false);
    expect(v.forNativeMount("codex").map((s) => s.name)).toEqual(["new"]);
  });

  it("two workdirs' same-named servers are different servers", async () => {
    const reg = new McpRegistry({}, { memoryEnabled: false });
    const a = view(reg, [entry("db", "claude-local", raw({ command: "db-a" }))]);
    const b = view(reg, [entry("db", "claude-local", raw({ command: "db-b" }))]);
    await a.load();
    await b.load();
    expect(a.get("db")?.variant).not.toBe(b.get("db")?.variant);
    expect(reg.get("db")).toBeUndefined(); // never in the daemon-wide registry
  });
});

describe("a plain HTTP server that answers with an OAuth challenge", () => {
  it("is marked as wanting a sign-in, said so, and unmarked once it answers", async () => {
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
      const reg = new McpRegistry({ p: raw({ url }) }, { memoryEnabled: false });
      const hub = new McpHub({});
      expect(await hub.listTools(reg.get("p")!)).toEqual([]);
      expect(hub.needsSignIn(url)).toBe(true);
      expect(hub.statusFor("p")?.error).toContain("adopt it");
      challenge = false;
      expect((await hub.listTools(reg.get("p")!)).map((t) => t.name)).toEqual(["t"]);
      expect(hub.needsSignIn(url)).toBe(false);
      hub.closeAll();
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

  function manager(onProvider?: (p: MockSessionProvider) => void): SessionManager {
    const providers = new ProviderRegistry("claude");
    providers.register({
      id: "claude",
      displayName: "claude",
      create: () => {
        const p = new MockSessionProvider("claude", []);
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

  it("the drawer says how far each server reaches; approving a repo's, then refreshing, takes it everywhere", async () => {
    claudeJson({ [work]: { mcpServers: { mine: { command: "my-mcp" } } } });
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }));
    const m = manager();
    const sid = await session(m);
    let r = await rows(m, sid);
    expect(r.servers.find((s) => s.name === "mine")?.otherBackends).toEqual({ reach: "all" });
    expect(r.servers.find((s) => s.name === "team")?.otherBackends).toEqual({ reach: "claude-only", why: "needs-approval" });
    expect(r.stale).toBe(false);

    const ok = await m.handle({ type: "mcp.approve", id: "a", sessionId: sid, server: "team" }, auth(ALL), client);
    expect(ok).toMatchObject({ type: "response.ok", data: { server: "team" } });
    r = await rows(m, sid);
    expect(r.stale).toBe(true); // approved, not yet applied
    expect(r.servers.find((s) => s.name === "team")?.otherBackends).toEqual({ reach: "claude-only", why: "needs-refresh" });

    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client)).toMatchObject({
      type: "response.ok",
      data: { changed: true, deferred: false },
    });
    r = await rows(m, sid);
    expect(r.stale).toBe(false);
    expect(r.servers.find((s) => s.name === "team")?.otherBackends).toEqual({ reach: "all" });

    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const audit = db.query("SELECT action, detail FROM audit_log WHERE action IN ('mcp.approve', 'session.mcp_refresh')").all() as Array<{ action: string; detail: string }>;
    db.close();
    expect(audit.find((a) => a.action === "mcp.approve")?.detail).toContain(`source=${JSON.stringify(join(work, ".mcp.json"))}`);
    expect(audit.find((a) => a.action === "session.mcp_refresh")?.detail).toContain("changed=true");
  });

  it("an edit to an approved entry needs approval again", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }));
    const m = manager();
    const sid = await session(m);
    await m.handle({ type: "mcp.approve", id: "a", sessionId: sid, server: "team" }, auth(ALL), client);
    await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client);
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp", args: ["--exfil"] } } }));
    expect((await rows(m, sid)).servers.find((s) => s.name === "team")?.otherBackends).toEqual({ reach: "all" }); // as applied
    await m.handle({ type: "session.mcp_refresh", id: "r2", sessionId: sid }, auth(ALL), client);
    expect((await rows(m, sid)).servers.find((s) => s.name === "team")?.otherBackends).toEqual({ reach: "claude-only", why: "needs-approval" });
  });

  it("approving is the session owner's own act: settings:write, a token of their own", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "team-mcp" } } }));
    const m = manager();
    const sid = await session(m);
    const msg = { type: "mcp.approve" as const, id: "a", sessionId: sid, server: "team" };
    expect(await m.handle(msg, auth([SCOPES.SESSION_SEND, SCOPES.FS_READ]), client)).toMatchObject({ code: "forbidden" });
    expect(await m.handle(msg, auth(ALL, 1), client)).toMatchObject({ code: "forbidden" });
    expect(await m.handle({ ...msg, server: "nope" }, auth(ALL), client)).toMatchObject({ code: "not_found" });
    const other = { ...auth(ALL), accountId: "acc-2" };
    expect(await m.handle(msg, other, client)).toMatchObject({ code: "not_found" }); // not their session
  });

  it("a refresh that changes something restarts the backend; one that changes nothing doesn't", async () => {
    const providers: MockSessionProvider[] = [];
    const m = manager((p) => providers.push(p));
    const sid = await session(m);
    await rows(m, sid); // the view is read
    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth(ALL), client)).toMatchObject({ data: { changed: false } });
    expect(providers[0]!.teardownCount).toBe(0);
    claudeJson({ [work]: { mcpServers: { added: { command: "new-mcp" } } } });
    expect(await m.handle({ type: "session.mcp_refresh", id: "r2", sessionId: sid }, auth(ALL), client)).toMatchObject({ data: { changed: true } });
    expect(providers[0]!.teardownCount).toBe(1);
  });

  it("refresh needs session:send on the caller's own session", async () => {
    const m = manager();
    const sid = await session(m);
    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, auth([SCOPES.FS_READ]), client)).toMatchObject({ code: "forbidden" });
    expect(await m.handle({ type: "session.mcp_refresh", id: "r", sessionId: sid }, { ...auth(ALL), projectId: "other" }, client)).toMatchObject({ code: "not_found" });
  });
});
