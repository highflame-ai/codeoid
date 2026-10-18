/**
 * The capabilities drawer's MCP rows (`claude.config`) don't carry the
 * credentials a Claude config keeps in a server's args or URL (#394) — nor
 * does anything else that shows a server's address: the reconnect hint, the
 * adopt errors, the audit log. Adopting still works from what was shown.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpOAuth } from "../daemon/mcp/oauth.js";
import { redactMcpArgs, redactMcpUrl } from "../daemon/mcp/redact.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SCOPES } from "../protocol/scopes.js";
import type { AuthContext, ClaudeConfigMcpServer, DaemonMessage } from "../protocol/types.js";

const SECRETS = ["sk-live-0123456789abcdef", "hunter2", "ghp_abcdefghijklmnop1234", "tok_9f8e7d6c5b4a3210fedcba98", "s3cr3tpass"];

const auth = (scopes: string[]): AuthContext => ({
  sub: "user:a",
  scopes: scopes as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-1",
  projectId: "proj-1",
});
const ALL = [SCOPES.SETTINGS_WRITE, SCOPES.SETTINGS_READ, SCOPES.SESSION_CREATE, SCOPES.FS_READ];
const client = { id: "c1", auth: auth(ALL), send: () => {} };

let tmp: string;
let home: string;
let work: string;
let store: Store;
let prev: { home?: string; xdg?: string };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-cc-redact-"));
  home = join(tmp, "home");
  work = join(tmp, "work");
  mkdirSync(home);
  mkdirSync(work);
  prev = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        db: { command: "npx", args: ["-y", "pg-mcp", "--api-key", "sk-live-0123456789abcdef", "postgres://admin:hunter2@db.internal:5432/app"] },
        gh: { command: "gh-mcp", args: ["--token=ghp_abcdefghijklmnop1234", "--verbose"] },
        notes: { type: "http", url: "https://notes.example.com/mcp?api_key=tok_9f8e7d6c5b4a3210fedcba98" },
        plain: { type: "http", url: "https://plain.example.com/mcp" },
      },
      projects: { [work]: { mcpServers: { wh: { type: "http", url: "https://hooks.example.com/mcp/tok_9f8e7d6c5b4a3210fedcba98/x" } } } },
    }),
  );
  writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { cred: { type: "http", url: "https://ops:s3cr3tpass@ops.example.com/mcp" } } }));
  store = new Store(join(tmp, "codeoid.db"));
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
  const oauth = new McpOAuth({ store, redirectBaseUrl: () => "http://127.0.0.1:7999", env: {} });
  m.setMcp(new McpRegistry({}, { memoryEnabled: false }), new McpHub({ credentials: oauth }), oauth);
  return m;
}

async function rows(m: SessionManager): Promise<{ sid: string; servers: ClaudeConfigMcpServer[] }> {
  const created = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: work }, auth(ALL), client)) as { data: { id: string } };
  const sid = created.data.id;
  const r = (await m.handle({ type: "claude.config", id: "v", sessionId: sid }, auth(ALL), client)) as { mcpServers: ClaudeConfigMcpServer[] };
  return { sid, servers: r.mcpServers };
}

const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

describe("claude.config", () => {
  it("returns no credential from a server's args or URL", async () => {
    const { servers } = await rows(manager());
    expect(leaks(JSON.stringify(servers))).toEqual([]);
  });

  it("keeps what tells a server apart: command, flags, host and path", async () => {
    const { servers } = await rows(manager());
    const by = (n: string) => servers.find((s) => s.name === n)!;
    expect(by("db").command).toBe("npx");
    expect(by("db").args.slice(0, 3)).toEqual(["-y", "pg-mcp", "--api-key"]);
    expect(by("db").args[4]).toContain("db.internal:5432/app");
    expect(by("gh").args).toEqual(["--token=…", "--verbose"]);
    expect(by("notes").url).toStartWith("https://notes.example.com/mcp");
    expect(by("plain").url).toBe("https://plain.example.com/mcp"); // nothing to hide: unchanged
    expect(by("cred").url).toContain("ops.example.com/mcp");
  });
});

describe("everything else that shows a server's address", () => {
  it("adopting works from the URL that was shown, and its errors and audit carry no credential", async () => {
    const m = manager();
    const { sid, servers } = await rows(m);
    const shown = servers.find((s) => s.name === "notes")!.url!;
    expect(shown).not.toBe("https://notes.example.com/mcp?api_key=tok_9f8e7d6c5b4a3210fedcba98");
    // What the drawer sends back is what it showed.
    const adopted = (await m.handle({ type: "mcp.adopt", id: "a", server: "notes", sessionId: sid, url: shown }, auth(ALL), client)) as DaemonMessage;
    expect(adopted).toMatchObject({ type: "mcp.adopt.result", server: "notes" });
    // codeoid's own config holds the real URL — it's the one it dials.
    const cfg = JSON.parse(readFileSync(join(tmp, "xdg", "codeoid", "config.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    expect(cfg.mcpServers.notes!.url).toBe("https://notes.example.com/mcp?api_key=tok_9f8e7d6c5b4a3210fedcba98");
    // A refusal after the entry is found (its URL carries credentials) is
    // audited with the URL — redacted — and its error doesn't leak it either.
    const refused = (await m.handle({ type: "mcp.adopt", id: "b", server: "cred", sessionId: sid }, auth(ALL), client)) as DaemonMessage;
    expect(refused).toMatchObject({ type: "response.error" });
    expect(leaks(JSON.stringify(refused))).toEqual([]);
    // Adopting a server whose path holds a token: the success row too.
    expect(await m.handle({ type: "mcp.adopt", id: "c", server: "wh", sessionId: sid }, auth(ALL), client)).toMatchObject({ type: "mcp.adopt.result" });
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const audit = db.query("SELECT detail FROM audit_log WHERE action = 'mcp.adopt'").all() as Array<{ detail: string }>;
    db.close();
    expect(audit.map((r) => r.detail).some((d) => d.includes("outcome=refused") && d.includes("url="))).toBe(true);
    expect(leaks(JSON.stringify(audit))).toEqual([]);
  });
});

describe("redactMcpUrl / redactMcpArgs", () => {
  it("redacts each place a URL holds a credential, and leaves a clean one alone", () => {
    expect(redactMcpUrl("https://a.example.com/mcp")).toBe("https://a.example.com/mcp");
    expect(redactMcpUrl("https://u:pw@a.example.com/mcp")).not.toContain("pw");
    expect(redactMcpUrl("https://a.example.com/mcp?token=abc123&team=x")).not.toContain("abc123");
    expect(redactMcpUrl("https://a.example.com/mcp#access_token=abc123")).not.toContain("abc123");
    expect(redactMcpUrl("https://a.example.com/v1/0123456789abcdef0123456789/mcp")).not.toContain("0123456789abcdef0123456789");
  });

  it("redacts a flag's value, in the next argument or after =, and secrets inside an argument", () => {
    expect(redactMcpArgs(["--api-key", "k-1", "--port", "80"])).toEqual(["--api-key", "…", "--port", "80"]);
    expect(redactMcpArgs(["--client-secret=abc", "-p", "x"])).toEqual(["--client-secret=…", "-p", "x"]);
    expect(redactMcpArgs(["API_TOKEN=xyz", "plain"])).toEqual(["API_TOKEN=…", "plain"]);
    expect(redactMcpArgs(["redis://:pw@cache:6379"])[0]).not.toContain("pw@");
    expect(redactMcpArgs(["Bearer abcdef"])[0]).not.toContain("abcdef");
    expect(redactMcpArgs(["-y", "@scope/pkg@1.2.3", "/srv/data"])).toEqual(["-y", "@scope/pkg@1.2.3", "/srv/data"]);
  });
});
