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
import { commandSummary, programName, redactMcpUrl, redactSecretText } from "../daemon/mcp/redact.js";
import { cleanMcpError } from "../daemon/session.js";
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
        dup: { type: "http", url: "https://dup.example.com/mcp?token=hunter2" },
      },
      projects: { [work]: { mcpServers: { wh: { type: "http", url: "https://hooks.example.com/mcp/tok_9f8e7d6c5b4a3210fedcba98/x" } } } },
    }),
  );
  writeFileSync(
    join(work, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        cred: { type: "http", url: "https://ops:s3cr3tpass@ops.example.com/mcp" },
        repoq: { type: "http", url: "https://repo.example.com/mcp?key=s3cr3tpass" },
        dup: { type: "http", url: "https://dup2.example.com/mcp?token=s3cr3tpass" },
      },
    }),
  );
  mkdirSync(join(home, ".claude"));
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "curl -H 'Authorization: Bearer sk-live-0123456789abcdef' https://hooks.example.com/notify?token=hunter2" }] }],
        Notification: [{ hooks: [{ type: "command", command: "node notify.js --api-key s3cr3tpass && curl -u admin:hunter2 https://n.example.com" }] }],
      },
      mcpServers: { envcmd: { command: "env API_KEY=ghp_abcdefghijklmnop1234 npx srv" } },
    }),
  );
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
  it("returns no credential from a server's args, URL or command, nor from a hook's command", async () => {
    const m = manager();
    const created = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: work }, auth(ALL), client)) as { data: { id: string } };
    const whole = await m.handle({ type: "claude.config", id: "v", sessionId: created.data.id }, auth(ALL), client);
    expect((whole as { hooks: unknown[] }).hooks.length).toBeGreaterThan(0);
    expect(leaks(JSON.stringify(whole))).toEqual([]);
  });

  it("shows a server's program and how many args, a hook's program, a URL's host and path shape — not their text", async () => {
    const m = manager();
    const created = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: work }, auth(ALL), client)) as { data: { id: string } };
    const r = (await m.handle({ type: "claude.config", id: "v", sessionId: created.data.id }, auth(ALL), client)) as {
      mcpServers: ClaudeConfigMcpServer[];
      hooks: Array<{ event: string; command: string }>;
    };
    const by = (n: string) => r.mcpServers.find((s) => s.name === n)!;
    expect(by("db")).toMatchObject({ command: "npx", args: [], argCount: 5 });
    expect(by("gh")).toMatchObject({ command: "gh-mcp", args: [], argCount: 2 });
    expect(by("envcmd").command).toBe("env"); // env assignments are the program's args here
    expect(by("notes").url).toBe("https://notes.example.com/mcp?…");
    expect(by("plain").url).toBe("https://plain.example.com/mcp"); // nothing to hide: as written
    expect(by("cred").url).toBe("https://…@ops.example.com/mcp");
    expect(r.hooks.map((h) => h.command).sort()).toEqual(["curl …", "node …"]);
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

describe("two entries that read the same once hidden", () => {
  it("adopt says so and asks for the full URL; the hint doesn't offer the shown one", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [work]: { mcpServers: { twin: { type: "http", url: "https://t.example.com/mcp?k=hunter2" } } } },
      }),
    );
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { twin: { type: "http", url: "https://t.example.com/mcp?k=s3cr3tpass" } } }));
    const m = manager();
    const { sid } = await rows(m);
    const r = (await m.handle({ type: "mcp.adopt", id: "a", server: "twin", sessionId: sid, url: "https://t.example.com/mcp?…" }, auth(ALL), client)) as { error?: string };
    expect(r.error).toContain("differ only in parts hidden here");
    expect(r.error).toContain("pass the full URL");
    expect(leaks(r.error!)).toEqual([]);
    // The real URL, typed from the user's own config, picks it.
    expect(await m.handle({ type: "mcp.adopt", id: "b", server: "twin", sessionId: sid, url: "https://t.example.com/mcp?k=hunter2" }, auth(ALL), client)).toMatchObject({ type: "mcp.adopt.result" });
  });
});

describe("adopt's refusals", () => {
  it("name a URL without its credentials: the project's own server, and an ambiguous name", async () => {
    const m = manager();
    const { sid } = await rows(m);
    const unconfirmed = (await m.handle({ type: "mcp.adopt", id: "a", server: "repoq", sessionId: sid }, auth(ALL), client)) as { error?: string };
    expect(unconfirmed.error).toContain("name that URL (https://repo.example.com/mcp?…)");
    const ambiguous = (await m.handle({ type: "mcp.adopt", id: "b", server: "dup", sessionId: sid }, auth(ALL), client)) as { error?: string };
    expect(ambiguous.error).toContain("more than one server");
    expect(leaks(JSON.stringify([unconfirmed, ambiguous]))).toEqual([]);
  });
});

describe("the URL shown is the URL dialed", () => {
  it("never shows a host the URL doesn't resolve to", () => {
    // ?, # and \ end the host for the parser: "…@trusted.com" would be a lie.
    for (const sneaky of ["https://evil.com?@trusted.com/mcp", "https://evil.com#@trusted.com/mcp", "https://evil.com\\@trusted.com/mcp"]) {
      const shown = redactMcpUrl(sneaky);
      expect(shown).toStartWith("https://evil.com/"); // the host it dials, and nothing before it
      expect(new URL(shown).host).toBe("evil.com");
    }
    expect(redactMcpUrl("https://trusted.com@evil.com/mcp")).toBe("https://…@evil.com/mcp");
  });

  it("hides a path segment that reads as a token or an id, not one that's just long", () => {
    expect(redactMcpUrl("https://h.example.com/org/my-company-mcp-server-v2/mcp")).toBe("https://h.example.com/org/my-company-mcp-server-v2/mcp");
    expect(redactMcpUrl("https://h.example.com/a/123e4567-e89b-12d3-a456-426614174000/mcp")).toBe("https://h.example.com/a/…/mcp");
    expect(redactMcpUrl("https://h.example.com/a/tok_9f8e7d6c5b4a3210fedcba98/mcp")).toBe("https://h.example.com/a/…/mcp");
  });

  it("shows the host of a URL however long the rest; adopt refuses one too long to read", async () => {
    const long = `https://evil.example/${"a".repeat(2_100)}`;
    expect(redactMcpUrl(long)).toBe("https://evil.example/…");
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { longurl: { type: "http", url: long } } }));
    const m = manager();
    const { sid } = await rows(m);
    const r = (await m.handle({ type: "mcp.adopt", id: "a", server: "longurl", sessionId: sid, url: "…" }, auth(ALL), client)) as { error?: string };
    expect(r).toMatchObject({ type: "response.error" }); // "…" is not a URL anyone was shown
    const named = (await m.handle({ type: "mcp.adopt", id: "b", server: "longurl", sessionId: sid, url: "https://evil.example/…" }, auth(ALL), client)) as { error?: string };
    expect(named.error).toContain("unusually long");
  });

  it("never hides the host, however token-like its labels", () => {
    expect(redactMcpUrl("https://abc123def456ghi789jkl0.lambda-url.us-east-1.on.aws/mcp")).toBe("https://abc123def456ghi789jkl0.lambda-url.us-east-1.on.aws/mcp");
    expect(redactMcpUrl("https://my-service-abc123xyz-uc.a.run.app/mcp?x=1")).toBe("https://my-service-abc123xyz-uc.a.run.app/mcp?…");
  });
});

describe("bounded", () => {
  it("reads no repo config file over 1 MB — and says so — but reads the user's own however big", async () => {
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { huge: { command: "x", args: ["y".repeat(1_100_000)] } } }));
    const { servers } = await rows(manager());
    expect(servers.find((s) => s.name === "huge")).toBeUndefined();
    // ...but it isn't invisible: the CLI still loads it, so the drawer says so.
    const marker = servers.find((s) => s.name === "(file too large)")!;
    expect(marker).toMatchObject({ path: join(work, ".mcp.json"), command: null, note: expect.stringContaining("too large to describe") });
    expect(marker.adoptable).toBeUndefined();
    // A settings file's hooks get the same marker, its text the daemon's own.
    mkdirSync(join(work, ".claude"), { recursive: true });
    writeFileSync(join(work, ".claude", "settings.json"), JSON.stringify({ hooks: {}, pad: "p".repeat(1_100_000) }));
    const m = manager();
    const sid = ((await m.handle({ type: "session.create", id: "c", name: "w2", workdir: work }, auth(ALL), client)) as { data: { id: string } }).data.id;
    const r = (await m.handle({ type: "claude.config", id: "v", sessionId: sid }, auth(ALL), client)) as { hooks: Array<{ event: string; command: string; note?: string }> };
    expect(r.hooks.find((h) => h.event === "(file too large)")).toMatchObject({ command: "", note: expect.stringContaining("settings.json is too large") });
    // ...but the user's own ~/.claude.json (which also holds Claude Code's
    // history) is read however big it has grown.
    const own = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ ...own, history: "h".repeat(2_000_000) }));
    const again = await rows(manager());
    expect(again.servers.find((s) => s.name === "notes")).toBeDefined();
  });

  it("hostile URLs and text cost little to clean — at the limit and past it", () => {
    const near = (unit: string) => unit.repeat(Math.floor(1_999 / unit.length));
    const hostile = [near("a-"), near("akey_"), near("token="), near("a://"), near("-"), `https://h/${near("a/b")}`];
    for (const text of [...hostile, "a-".repeat(20_000), `https://h/${"a".repeat(100_000)}`]) {
      const t0 = performance.now();
      redactMcpUrl(text);
      redactSecretText(text);
      programName(text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

describe("redactMcpUrl / programName / error text", () => {
  it("redacts each place a URL holds a credential, and leaves a clean one alone", () => {
    expect(redactMcpUrl("https://a.example.com/mcp")).toBe("https://a.example.com/mcp");
    expect(redactMcpUrl("https://u:pw@a.example.com/mcp")).not.toContain("pw");
    expect(redactMcpUrl("https://a.example.com/mcp?token=abc123&team=x")).not.toContain("abc123");
    expect(redactMcpUrl("https://a.example.com/mcp#access_token=abc123")).not.toContain("abc123");
    expect(redactMcpUrl("https://a.example.com/v1/0123456789abcdef0123456789/mcp")).not.toContain("0123456789abcdef0123456789");
  });

  it("names a command's program only: env assignments skipped, directories dropped, nothing that reads as a secret", () => {
    expect(programName("npx -y pg-mcp --api-key sk-live-0123456789abcdef")).toBe("npx");
    expect(programName("API_KEY=x NODE_ENV=prod /usr/local/bin/node srv.js")).toBe("node");
    expect(programName(`"C:\\Program Files\\srv.exe" --token t`)).toBe("srv.exe");
    expect(programName("sk-live-0123456789abcdef --x")).toBe("(command)");
    expect(commandSummary("curl -H 'Authorization: Bearer x' https://h")).toBe("curl …");
    expect(commandSummary("notify")).toBe("notify");
  });

  it("keeps redacting basic= in error text (it moved to the key=value rule)", () => {
    expect(cleanMcpError("auth failed: basic=dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
  });
});
