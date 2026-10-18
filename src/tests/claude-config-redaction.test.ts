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
import { redactMcpArgs, redactMcpUrl, redactSecretText, redactShellCommand } from "../daemon/mcp/redact.js";
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
  it("shows at most 64 args a server has, and reads no config file over 1 MB", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `arg${i}`);
    expect(redactMcpArgs(many)).toHaveLength(65);
    expect(redactMcpArgs(many).at(-1)).toBe("…");
    writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { huge: { command: "x", args: ["y".repeat(1_100_000)] } } }));
    const { servers } = await rows(manager());
    expect(servers.find((s) => s.name === "huge")).toBeUndefined();
    // ...but it isn't invisible: the CLI still loads it, so the drawer says so.
    const marker = servers.find((s) => s.name === "(file too large)")!;
    expect(marker).toMatchObject({ path: join(work, ".mcp.json"), command: expect.stringContaining("too large to describe") });
    expect(marker.adoptable).toBeUndefined();
    // ...but the user's own ~/.claude.json (which also holds Claude Code's
    // history) is read however big it has grown.
    const own = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ ...own, history: "h".repeat(2_000_000) }));
    const again = await rows(manager());
    expect(again.servers.find((s) => s.name === "notes")).toBeDefined();
  });

  it("hostile args, URLs and text cost little to clean — at the limit and past it", () => {
    const near = (unit: string) => unit.repeat(Math.floor(1_999 / unit.length));
    const hostile = [near("a-"), near("akey_"), near("token="), near("a://"), near("-"), `https://h/${near("a/b")}`, `--${near("x-")}`];
    for (const text of [...hostile, "a-".repeat(20_000), `https://h/${"a".repeat(100_000)}`]) {
      const t0 = performance.now();
      redactMcpArgs([text, text]);
      redactMcpUrl(text);
      redactSecretText(text);
      redactShellCommand(text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
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

  it("reads camelCase flags as words; a flag naming where a credential is keeps its value", () => {
    for (const flag of ["--apiToken", "--authToken", "--githubToken", "--slackBotToken", "--dbPassword", "--clientSecret"]) {
      expect(redactMcpArgs([flag, "abc"])).toEqual([flag, "…"]);
    }
    for (const flag of ["--authtoken", "--apitoken", "--secretkey", "--refreshToken", "--session-id", "--auth-header"]) {
      expect(redactMcpArgs([flag, "abc"])).toEqual([flag, "…"]);
    }
    for (const flag of ["--key-file", "--auth-type", "--session-name", "--cookie-jar", "--private-key-path"]) {
      expect(redactMcpArgs([flag, "plain"])).toEqual([flag, "plain"]);
    }
  });

  it("redacts a command line as its arguments are: flag values, user:password, headers", () => {
    expect(redactShellCommand("node notify.js --api-key hunter2")).toBe("node notify.js --api-key …");
    expect(redactShellCommand("curl -u admin:hunter2 https://x.example.com")).toBe("curl -u admin:… https://x.example.com/");
    expect(redactShellCommand(`curl -H "Authorization: Bearer abc" https://x.example.com/n`)).toBe("curl -H 'Authorization: …' https://x.example.com/n");
    // A command inside a quoted word (sh -c "…") is redacted as one.
    expect(redactShellCommand(`bash -c "notify --password hunter2"`)).toBe("bash -c 'notify --password …'");
    expect(redactShellCommand("npx -y @scope/srv --port 8080")).toBe("npx -y @scope/srv --port 8080");
  });

  it("reads a command's words as the shell does: quotes mid-word, sh -c bodies, empty strings", () => {
    expect(redactShellCommand(`cmd --password="correct horse battery staple"`)).toBe("cmd --password=…");
    expect(redactShellCommand(`PASSWORD='correct horse' run`)).toBe("PASSWORD=… run");
    expect(redactShellCommand(`docker run -e "TOKEN=hunter two" img`)).toBe("docker run -e TOKEN=… img");
    // A body is redacted as a command even when something else in it already was.
    expect(redactShellCommand(`bash -c "TOKEN=abc node x --password hunter2"`)).not.toContain("hunter2");
    expect(redactShellCommand(`bash -c "curl https://h.example.com/x?y=1 --api-key hunter2"`)).not.toContain("hunter2");
    expect(redactShellCommand(`sh -c "sh -c 'srv --password x9 https://h/?q'"`)).not.toContain("x9");
    expect(redactShellCommand(`echo "" ''`)).toBe("echo '' ''");
  });

  it("hides --flag=value and KEY=value by the name, whole values, user:password in one argument", () => {
    expect(redactMcpArgs(["--token-value=sesame", "--accessKeyId=abcdefgh", "DB_PW=x", "--password=correct horse"])).toEqual([
      "--token-value=…",
      "--accessKeyId=…",
      "DB_PW=…",
      "--password=…",
    ]);
    expect(redactMcpArgs(["--user=admin:hunter2", "-uadmin:hunter2"])).toEqual(["--user=admin:…", "-uadmin:…"]);
    expect(redactMcpArgs(["a\tb\nINJECTED"])).toEqual(["a b INJECTED"]);
  });

  it("leaves flags alone that only sound like credentials", () => {
    for (const flag of ["--monkey", "--hotkey", "--token-limit", "--max-token", "--auth-method", "--password-stdin", "--api-key-env", "--signature-version"]) {
      expect(redactMcpArgs([flag, "plain"])).toEqual([flag, "plain"]);
    }
  });

  it("knows a credential flag by its words, not by a substring", () => {
    for (const flag of ["--pat", "--github-pat", "--pass", "--passphrase", "--sig", "--signature", "--private-key", "--access-token"]) {
      expect(redactMcpArgs([flag, "X1"])).toEqual([flag, "…"]);
    }
    expect(redactMcpArgs(["--passphrase=X1"])).toEqual(["--passphrase=…"]);
    for (const flag of ["--keyboard-layout", "--author", "--no-auth"]) {
      expect(redactMcpArgs([flag, "plain"])).toEqual([flag, "plain"]);
    }
  });

  it("hides a credential header's value, split or in one argument, and a value that starts with -", () => {
    expect(redactMcpArgs(["--header", "Authorization", "x1y2z3"])).toEqual(["--header", "Authorization", "…"]);
    expect(redactMcpArgs(["--header", "X-Auth", "x1y2z3"])).toEqual(["--header", "X-Auth", "…"]);
    expect(redactMcpArgs(["--header", "Authorization:", "x1y2z3"])).toEqual(["--header", "Authorization:", "…"]);
    expect(redactMcpArgs(["-H", "X-Api-Key: abc"])).toEqual(["-H", "X-Api-Key: …"]);
    expect(redactMcpArgs(["--password", "-weird9Value"])).toEqual(["--password", "…"]);
    // A credential flag's value is hidden whatever it looks like — even one that reads as a flag.
    expect(redactMcpArgs(["--token", "--verbose"])).toEqual(["--token", "…"]);
  });

  it("keeps redacting basic= in error text (it moved to the key=value rule)", () => {
    expect(cleanMcpError("auth failed: basic=dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
  });
});
