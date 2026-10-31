/**
 * OpencodeProvider tests — offline over the fake-opencode fixture (a real
 * subprocess speaking opencode 2.2's HTTP API, durable session log and live
 * feed; see fixtures/fake-opencode.ts).
 *
 *   O1  server lifecycle: lazy start, one server shared, restart after death,
 *       auth, loopback + `serve --stdio --port 0`, the injected policy
 *   O2  session create / resume by `ses_…` id / gone → onHistoryLost
 *   O3  streaming text + thinking, text_done / thinking_done
 *   O4  tool cards: tool_start before the gate is asked
 *   O5  approvals: allow → once, deny → reject + message, fail-closed, never always
 *   O6  interrupt
 *   O7  models and efforts (variants), switched only when changed
 *   O8  cost and tokens per turn, llm_call per step, budget stop
 *   O9  MCP mounts per session, memory recall under codeoid's name
 *   O10 subagents (foreground and background, turn_started); background shells
 *   O11 questions (forms) → requestUserInput; cancel = no answer
 *   O12 steering a running turn; later = queue
 *   O13 version range; agent check; saved approvals swept
 *   O14 database location, registry available / unavailable / disabled
 *   O15 what real 2.2.2 / 2.2.5 servers showed: the feed is the only record
 *       (the durable log replays nothing), the title is billed without a
 *       step, Code Mode asks per fetch, a dropped feed is read back
 *
 * See provider-opencode.integration.test.ts for a real `opencode` binary.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeServer, OpencodeIncompatibleError } from "../daemon/providers/opencode/server.js";
import { buildOpencodeEnv, commandlessShellLine, opencodeConfig, opencodeShellEnv, ownMountPrefix, sessionRules, survivingAllows, unsafeAgents } from "../daemon/providers/opencode/policy.js";
import { OPENCODE_INSTALL_HINT, opencodeDbPath, opencodeVersionProblem, resolveOpencodeCommand } from "../daemon/providers/opencode/resolve.js";
import { effortOfVariant, gateCallFor, parseModelValue } from "../daemon/providers/opencode/translate.js";
import { OpencodeClient, parseSse } from "../daemon/providers/opencode/client.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import { BUDGET_STOP_MESSAGE, type ProviderEvent, type ToolApprovalFn, type TurnOpts, type TurnRun, type UiRequest, type UiResponse } from "../daemon/providers/interface.js";
import { MemoryMcpHttp } from "../daemon/memory/mcp-http.js";
import { MemoryEngine } from "../daemon/memory/engine.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import type { Embedder } from "../daemon/memory/embedder.js";
import type { CodeoidConfig } from "../config.js";
import type { Store } from "../daemon/store.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-opencode.ts");
const servers: OpencodeServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "codeoid-oc-"));
}

function makeServer(knobs: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof OpencodeServer>[0]> = {}): { server: OpencodeServer; dir: string; starts: string } {
  const dir = tmp();
  const starts = join(dir, "starts.txt");
  const server = new OpencodeServer({
    command: process.execPath,
    argsPrefix: [FIXTURE],
    dbPath: join(dir, "data", "opencode", "opencode.db"),
    env: () => ({ ...buildOpencodeEnv(), FAKE_OPENCODE_STARTS: starts, ...knobs }),
    // Hermetic: not the user's own opencode config.
    userConfigDir: null,
    ...extra,
  });
  servers.push(server);
  return { server, dir, starts };
}

interface Saved {
  ids: Array<[string, string]>;
}

function makeStore(saved: Saved = { ids: [] }): Store {
  return { setClaudeCodeSessionId: (sid: string, id: string) => saved.ids.push([sid, id]) } as unknown as Store;
}

function makeProvider(server: OpencodeServer, over: Partial<ConstructorParameters<typeof OpencodeProvider>[0]> = {}): OpencodeProvider {
  return new OpencodeProvider({ sessionId: "sess-1", initialBackingId: "sess-1", server, store: makeStore(), ...over });
}

const allow: ToolApprovalFn = async () => ({ behavior: "allow" });

/** A gate that allows everything, telling `seen` what it was asked. */
function allowing(seen: (name: string, input: Record<string, unknown>, agentId: string | undefined) => unknown): ToolApprovalFn {
  return async (_toolId, _approvalId, name, input, _signal, agentId) => {
    seen(name, input, agentId);
    return { behavior: "allow" };
  };
}

function opts(userMessage: string, over: Partial<TurnOpts> = {}): TurnOpts {
  return { history: [], userMessage, workdir: "/tmp/oc-work", canUseTool: allow, ...over };
}

async function collect(run: TurnRun, until: (e: ProviderEvent) => boolean = (e) => e.type === "turn_done" || e.type === "error"): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of run.events) {
    events.push(e);
    if (until(e)) break;
  }
  return events;
}

async function fakeState(server: OpencodeServer): Promise<Record<string, any>> {
  const conn = await server.ensure();
  return (await (await fetch(`${conn.client.baseUrl}/__fake/state`)).json()) as Record<string, any>;
}

function texts(events: ProviderEvent[], type: "text_done" | "text_delta"): string[] {
  return events.flatMap((e) => (e.type === type ? [e.content] : []));
}

function done(events: ProviderEvent[]) {
  const d = events.filter((e) => e.type === "turn_done");
  return d.length > 0 ? (d[d.length - 1] as Extract<ProviderEvent, { type: "turn_done" }>).result : undefined;
}

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions));
  }
  async close(): Promise<void> {}
}

// ── O1 server lifecycle ─────────────────────────────────────────────────────

describe("opencode server lifecycle", () => {
  it("starts lazily on the first turn, once, and shares it", async () => {
    const { server, starts } = makeServer();
    const a = makeProvider(server, { sessionId: "sess-a", initialBackingId: "sess-a" });
    const b = makeProvider(server, { sessionId: "sess-b", initialBackingId: "sess-b" });
    expect(existsSync(starts)).toBe(false); // nothing spawned by constructing providers
    expect(server.running).toBe(false);
    const [ea, eb] = await Promise.all([collect(a.runTurn(opts("hi"))), collect(b.runTurn(opts("hi")))]);
    expect(done(ea)?.isError).toBeUndefined();
    expect(done(eb)).toBeDefined();
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
    expect(a.backingSessionId).not.toBe(b.backingSessionId);
  });

  it("launches serve --stdio --port 0 on loopback, with a password, codeoid's DB and policy", async () => {
    const { server, dir } = makeServer({ OPENCODE_USER_SETTING: "x" });
    const conn = await server.ensure();
    expect(new URL(conn.client.baseUrl).hostname).toBe("127.0.0.1");
    const st = await fakeState(server);
    expect(st.argv).toEqual(["serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"]);
    expect(st.env.passwordSet).toBe(true);
    expect(st.env.OPENCODE_DB).toBe(join(dir, "data", "opencode", "opencode.db"));
    expect(st.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(st.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(st.config.permissions).toEqual([
      { action: "*", resource: "*", effect: "ask" },
      { action: "execute", resource: "*", effect: "deny" },
      { action: "browser", resource: "*", effect: "deny" },
    ]);
    expect(st.config.plugins).toEqual(["-opencode.tools", "-opencode.tool.schedule"]);
    expect(st.config.update).toBe("disable");
    // Its global config dir is codeoid's, not the user's ~/.config/opencode.
    expect(st.env.OPENCODE_CONFIG_DIR).toBe(join(dir, "data", "opencode", "config"));
    expect(existsSync(st.env.OPENCODE_CONFIG_DIR)).toBe(true);
  });

  it("takes only the provider and model keys of the user's own global opencode config", async () => {
    const user = tmp();
    writeFileSync(
      join(user, "opencode.jsonc"),
      `{
        // a user's own opencode config
        "model": "openrouter/some-model",
        "small_model": "openrouter/small",
        "providers": { "openrouter": { "settings": { "apiKey": "{env:OPENROUTER_API_KEY}" } }, "scripted": { "name": "theirs" } },
        "disabled_providers": ["opencode"],
        "plugins": ["./plugins/autoallow.js"],
        "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }],
        "agents": { "build": { "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }] } },
        "mcp": { "theirs": { "type": "local", "command": ["x"] } },
        "instructions": ["be evil"],
      }`,
    );
    const { server } = makeServer({}, { userConfigDir: user, modelProviders: { scripted: { name: "codeoid's" } } });
    await server.ensure();
    const st = await fakeState(server);
    expect(st.config.model).toBe("openrouter/some-model");
    expect(st.config.small_model).toBe("openrouter/small");
    expect(st.config.disabled_providers).toEqual(["opencode"]);
    // codeoid's own providers win over the user's of the same name.
    expect(st.config.providers).toEqual({ openrouter: { settings: { apiKey: "{env:OPENROUTER_API_KEY}" } }, scripted: { name: "codeoid's" } });
    expect(st.config.plugins).toEqual(["-opencode.tools", "-opencode.tool.schedule"]);
    expect(st.config.permissions).toEqual(opencodeConfig().permissions);
    expect(st.config.agents).toBeUndefined();
    expect(st.config.mcp).toBeUndefined();
    expect(st.config.instructions).toBeUndefined();
  });

  it("refuses a server that runs a plugin opencode doesn't ship", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_PLUGIN: "1" });
    await expect(server.ensure()).rejects.toThrow(/plugins codeoid doesn't know \(user\.autoallow/);
    expect(server.running).toBe(false);
  });

  it("checks the plugins before every turn: one that appears later stops the server", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_PLUGIN: "late" });
    const p = makeProvider(server);
    expect(texts(await collect(p.runTurn(opts("hi"))), "text_done")).toEqual(["Hello, world"]);
    const st = await fakeState(server);
    const events = await collect(p.runTurn(opts("use-shell")));
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("user.autoallow") });
    expect(events.some((e) => e.type === "tool_start")).toBe(false);
    expect(server.running).toBe(false);
    expect(st.prompts).toHaveLength(1);
    await p.teardown();
  });

  it("a call that ran without asking codeoid stops the server, and ends the turn with why", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_AUTOALLOW: "1" });
    const asked: string[] = [];
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("use-shell", { canUseTool: allowing((name) => asked.push(name)) })));
    expect(asked).toEqual([]);
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ name: "Bash", input: { command: "ls -la /tmp" } });
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("ran shell without asking codeoid") });
    for (let i = 0; i < 50 && server.running; i++) await Bun.sleep(20);
    expect(server.running).toBe(false);
    await p.teardown();
  });

  it("a child's call that ran without asking stops the server too", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_AUTOALLOW: "child" });
    const asked: string[] = [];
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("subagent", { canUseTool: allowing((name) => asked.push(name)) })));
    expect(asked).toEqual(["Task"]);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("ran shell without asking codeoid") });
    for (let i = 0; i < 50 && server.running; i++) await Bun.sleep(20);
    expect(server.running).toBe(false);
    await p.teardown();
  });

  it("a shell line with no command in it, which opencode runs unasked by its own rule, keeps the server", async () => {
    const { server } = makeServer();
    const generation = (await server.ensure()).generation;
    for (const line of ["cd .", "export FOO=bar", "X=1", "# just a comment", "cd src && X=1"]) {
      const p = makeProvider(server, { sessionId: `sess-${line.length}`, initialBackingId: `sess-${line.length}` });
      const events = await collect(p.runTurn(opts(`unasked-shell:${line}`)));
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      // Shown as a card that ran without asking, and the turn goes on.
      expect(events.find((e) => e.type === "tool_start")).toMatchObject({ name: "Bash", input: { command: line }, approvalId: expect.stringMatching(/^opencode-auto-/) });
      expect(texts(events, "text_done")).toEqual(["ran it"]);
      expect(server.running).toBe(true);
      await p.teardown();
    }
    expect((await server.ensure()).generation).toBe(generation);
  });

  it("a genuine unasked call tells the session that saw it why, and the other sessions only that the server restarted", async () => {
    const { server } = makeServer();
    const a = makeProvider(server, { sessionId: "sess-a", initialBackingId: "sess-a" });
    const b = makeProvider(server, { sessionId: "sess-b", initialBackingId: "sess-b" });
    await collect(b.runTurn(opts("hi")));
    const bRun = collect(b.runTurn(opts("slow")));
    await Bun.sleep(150);
    // A line with a command word in it never runs unasked on its own: something settled it.
    const aEvents = await collect(a.runTurn(opts("unasked-shell:ls")));
    const bEvents = await bRun;
    const [aEnd, bEnd] = [aEvents.at(-1), bEvents.at(-1)] as Array<{ type: string; message: string }>;
    expect(aEnd!.type).toBe("error");
    expect(aEnd!.message).toContain("something in its configuration settles permission requests");
    expect(bEnd!.type).toBe("error");
    expect(bEnd!.message).toContain("a tool ran without asking codeoid in another session");
    expect(bEnd!.message).not.toContain("configuration");
    await a.teardown();
    await b.teardown();
  });

  it("a session's shell runs without the server's environment: a line that runs unasked can't print a key", async () => {
    const { server } = makeServer({ R4_SECRET_API_KEY: "sk-test-not-for-the-shell" });
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    const st = await fakeState(server);
    const set = st.environments.find((e: { sessionID: string }) => e.sessionID === p.backingSessionId);
    expect(set.variables.PATH).toBe(process.env.PATH);
    expect(Object.keys(set.variables).filter((k) => /API_KEY|OPENCODE_/.test(k))).toEqual([]);
    // `$` in it: codeoid can't tell it ran no command, so the server is stopped — but the value never left.
    const events = await collect(p.runTurn(opts("unasked-shell:X=${UNSET?$R4_SECRET_API_KEY}", { canUseTool: async () => ({ behavior: "deny", message: "no" }) })));
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: true });
    expect(JSON.stringify(events)).not.toContain("sk-test-not-for-the-shell");
    await p.teardown();
  });

  it("a subagent's shell environment is set before anything it asks is allowed; one that can't be set is declined", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("subagent")));
    const child = (events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    const st = await fakeState(server);
    expect(st.environments.some((e: { sessionID: string }) => e.sessionID === child)).toBe(true);
    expect(st.replies.find((r: { sessionID: string }) => r.sessionID === child)).toMatchObject({ decision: "once" });

    const failing = makeServer({ FAKE_OPENCODE_ENV_FAIL: "child" }).server;
    const declined = await collect(makeProvider(failing).runTurn(opts("subagent")));
    const failedChild = (declined.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    const st2 = await fakeState(failing);
    expect(st2.replies.find((r: { sessionID: string }) => r.sessionID === failedChild)).toMatchObject({ decision: "reject" });
    expect(declined.some((e) => e.type === "tool_complete" && e.output.includes("couldn't set up this subagent's shell environment"))).toBe(true);
  });

  it("requires the per-start password", async () => {
    const { server } = makeServer();
    const conn = await server.ensure();
    const res = await fetch(`${conn.client.baseUrl}/api/agent`);
    expect(res.status).toBe(401);
    const wrong = await fetch(`${conn.client.baseUrl}/api/agent`, { headers: { authorization: `Basic ${Buffer.from("opencode:nope").toString("base64")}` } });
    expect(wrong.status).toBe(401);
    expect((await conn.client.agents()).length).toBeGreaterThan(0);
  });

  it("starts a new server on next use after the old one died, and the session resumes", async () => {
    const { server, starts } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    const first = p.backingSessionId;
    process.kill(server.pid!, "SIGKILL");
    for (let i = 0; i < 50 && server.running; i++) await Bun.sleep(20);
    expect(server.running).toBe(false);
    // The fake's sessions are in memory: the resumed id is gone → a fresh one, from history.
    let lost = 0;
    p.onHistoryLost = () => lost++;
    const events = await collect(p.runTurn(opts("hi again")));
    expect(done(events)).toBeDefined();
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(2);
    expect(lost).toBe(1);
    // Created on the new server (whose ids start over, so it may even match `first`).
    const st = await fakeState(server);
    expect(st.sessions.map((x: { id: string }) => x.id)).toEqual([p.backingSessionId]);
    expect(first.startsWith("ses_")).toBe(true);
  });

  it("stops: closing its stdin lease ends the process", async () => {
    const { server } = makeServer();
    await server.ensure();
    const pid = server.pid!;
    await server.stop();
    expect(server.running).toBe(false);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("doesn't pass the user's OPENCODE_* settings or codeoid's secrets to the server", () => {
    const env = buildOpencodeEnv({ PATH: "/bin", OPENCODE_PASSWORD: "theirs", OPENCODE_DB: "/home/u/.local/share/opencode/opencode.db", CODEOID_API_KEY: "zid_sk_x", ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "o" });
    expect(env.OPENCODE_PASSWORD).toBeUndefined();
    expect(env.OPENCODE_DB).toBeUndefined();
    expect(env.CODEOID_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect(env.OPENROUTER_API_KEY).toBe("o");
  });

  it("a session's shell gets basics only: no model key, no injected config, no proxy credentials", () => {
    const env = opencodeShellEnv({
      PATH: "/bin",
      HOME: "/home/u",
      LC_ALL: "C",
      ANTHROPIC_API_KEY: "k",
      GITHUB_API_TOKEN: "t",
      OPENCODE_CONFIG_CONTENT: "{}",
      AWS_SECRET_ACCESS_KEY: "s",
      CODEOID_AGENT_ENV_ALLOW: "AWS_SECRET_ACCESS_KEY",
      HTTPS_PROXY: "http://user:pw@proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost,.internal",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/u", LC_ALL: "C", HTTP_PROXY: "http://proxy:3128", NO_PROXY: "localhost,.internal" });
  });

  it("tells a shell line with no command in it from one that could act", () => {
    for (const line of ["cd .", "cd src", "cd 'my dir'", "export FOO=bar", "X=1", "X=1 Y='a b'", "# a comment", "cd src && X=1", "X=1; Y=2\nunset X", "readonly A"]) {
      expect([line, commandlessShellLine(line)]).toEqual([line, true]);
    }
    const acting = [
      "ls", "echo hi", "true", ":", "X=1 touch f", "cd x; ls", "X=$(id)", "X=`id`", "X=${U?$KEY}", "X=1 > f", "cat < f", "a | b",
      "X=1 &", "(X=1)", "{ X=1; }", "export", "export -p", "readonly -p", "X=a\\$b", "! X=1", "X='unterminated", "cd a b c",
    ];
    for (const line of acting) expect([line, commandlessShellLine(line)]).toEqual([line, false]);
  });
});

// ── O2 sessions ─────────────────────────────────────────────────────────────

describe("opencode sessions", () => {
  it("creates one in the workdir with codeoid's rules, and persists its id", async () => {
    const { server } = makeServer();
    const saved: Saved = { ids: [] };
    const p = makeProvider(server, { store: makeStore(saved) });
    await collect(p.runTurn(opts("hi", { workdir: "/tmp/oc-a" })));
    expect(p.backingSessionId.startsWith("ses_")).toBe(true);
    expect(saved.ids).toEqual([["sess-1", p.backingSessionId]]);
    const st = await fakeState(server);
    const ses = st.sessions.find((s: { id: string }) => s.id === p.backingSessionId);
    expect(ses.location.directory).toBe("/tmp/oc-a");
    expect(ses.permissions).toEqual(sessionRules("sess-1"));
  });

  it("resumes by reusing the ses_ id, re-applying its rules", async () => {
    const { server } = makeServer();
    const first = makeProvider(server);
    await collect(first.runTurn(opts("hi")));
    await first.teardown();
    const resumed = makeProvider(server, { initialBackingId: first.backingSessionId });
    await collect(resumed.runTurn(opts("again")));
    expect(resumed.backingSessionId).toBe(first.backingSessionId);
    const st = await fakeState(server);
    expect(st.sessions.filter((s: { parentID?: string }) => !s.parentID)).toHaveLength(1);
    expect(st.patches.some((x: { sessionID: string }) => x.sessionID === first.backingSessionId)).toBe(true);
  });

  it("a gone session asks for codeoid's history, unless a seed is queued", async () => {
    const { server } = makeServer();
    const p = makeProvider(server, { initialBackingId: "ses_gone" });
    let lost = 0;
    p.onHistoryLost = () => lost++;
    await collect(p.runTurn(opts("hi")));
    expect(lost).toBe(1);
    const q = makeProvider(server, { initialBackingId: "ses_gone2", sessionId: "sess-2" });
    q.onHistoryLost = () => lost++;
    q.seedText("PRIOR CONTEXT");
    await collect(q.runTurn(opts("echo-state")));
    expect(lost).toBe(1);
    const st = await fakeState(server);
    expect(st.prompts.at(-1).text).toBe("PRIOR CONTEXT\n\necho-state");
  });

  it("a session deleted while attached, unannounced, goes on in a new one from codeoid's history", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    let lost = 0;
    // As Session does: the history is handed over at once.
    p.onHistoryLost = () => {
      lost++;
      p.seedText("PRIOR CONTEXT");
    };
    await collect(p.runTurn(opts("hi")));
    const gone = p.backingSessionId;
    const conn = await server.ensure();
    await fetch(`${conn.client.baseUrl}/__fake/delete/${gone}?quiet=1`, { method: "POST" });
    const events = await collect(p.runTurn(opts("echo-state")));
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(lost).toBe(1);
    expect(p.backingSessionId).not.toBe(gone);
    expect(p.backingSessionId.startsWith("ses_")).toBe(true);
    const st = await fakeState(server);
    expect(st.prompts.at(-1)).toMatchObject({ sessionID: p.backingSessionId, text: "PRIOR CONTEXT\n\necho-state" });
    await p.teardown();
  });

  it("a session deleted under a running turn ends it; the next turn goes on in a new one", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    let lost = 0;
    p.onHistoryLost = () => lost++;
    const run = p.runTurn(opts("slow"));
    const events: ProviderEvent[] = [];
    const conn = await server.ensure();
    for await (const e of run.events) {
      events.push(e);
      if (e.type === "llm_call" && events.filter((x) => x.type === "llm_call").length === 1) {
        void fetch(`${conn.client.baseUrl}/__fake/delete/${p.backingSessionId}`, { method: "POST" });
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("deleted") });
    const gone = p.backingSessionId;
    const next = await collect(p.runTurn(opts("hi")));
    expect(texts(next, "text_done")).toEqual(["Hello, world"]);
    expect(lost).toBe(1);
    expect(p.backingSessionId).not.toBe(gone);
    await p.teardown();
  });

  it("re-asserts the session's rules and sweeps saved approvals before every turn", async () => {
    // Any process of the daemon's user can read the server's password and
    // rewrite them between turns.
    const { server } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    const conn = await server.ensure();
    await fetch(`${conn.client.baseUrl}/__fake/tamper/${p.backingSessionId}`, { method: "POST" });
    await collect(p.runTurn(opts("hi again")));
    const st = await fakeState(server);
    expect(st.sessions.find((x: { id: string }) => x.id === p.backingSessionId).permissions).toEqual(sessionRules("sess-1"));
    expect(st.saved).toEqual([]);
    expect(st.savedRemoved).toHaveLength(1);
    await p.teardown();
  });

  it("delivers systemPromptAppend once, as a synthetic message", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi", { systemPromptAppend: "Be terse." })));
    await collect(p.runTurn(opts("hi", { systemPromptAppend: "Be terse." })));
    await collect(p.runTurn(opts("hi", { systemPromptAppend: "Be verbose." })));
    const st = await fakeState(server);
    expect(st.synthetic.map((s: { text: string; resume: boolean }) => [s.text, s.resume])).toEqual([
      ["Be terse.", false],
      ["Be verbose.", false],
    ]);
  });
});

// ── O3 streaming ─────────────────────────────────────────────────────────────

describe("opencode streaming", () => {
  it("streams text deltas and ends the block with text_done", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("hi")));
    // Deltas come on the live feed, the block's end on the durable log: a
    // delta can lose the race to it, and text_done carries the whole text.
    const streamed = texts(events, "text_delta").join("");
    expect(streamed.length).toBeGreaterThan(0);
    expect("Hello, world".startsWith(streamed)).toBe(true);
    expect(texts(events, "text_done")).toEqual(["Hello, world"]);
    expect(events.at(-1)?.type).toBe("turn_done");
  });

  it("streams thinking and closes it with thinking_done", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("think")));
    const thinking = events.filter((e) => e.type === "thinking_delta").map((e) => (e as { content: string }).content);
    expect(thinking.join("")).toBe("pondering");
    const di = events.findIndex((e) => e.type === "thinking_done");
    expect(di).toBeGreaterThan(events.findIndex((e) => e.type === "thinking_delta"));
    expect(texts(events, "text_done")).toEqual(["thought about it"]);
  });

  it("reports a scheduled retry as api_retry", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("retry")));
    const retry = events.find((e) => e.type === "api_retry") as Extract<ProviderEvent, { type: "api_retry" }>;
    expect(retry.attempt).toBe(1);
    expect(retry.errorStatus).toBe(529);
    expect(texts(events, "text_done")).toEqual(["after retry"]);
  });

  it("a failed execution is an error carrying opencode's structured detail", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("fail")));
    const err = events.at(-1) as Extract<ProviderEvent, { type: "error" }>;
    expect(err.type).toBe("error");
    expect(err.message).toContain("Rate limit reached");
    expect(err.detail).toMatchObject({ type: "provider.rate-limit", status: 429, retryDelayMs: 5000 });
    // The failed turn's spend still counts — on the next turn.
    const next = done(await collect(p.runTurn(opts("hi"))));
    expect(next?.totalCostUsd).toBeCloseTo(0.25 + 0.0123, 6);
  });
});

// ── O4/O5 approvals ─────────────────────────────────────────────────────────

describe("opencode approvals", () => {
  it("shows the tool card before asking, as Bash with the command, and replies once", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const order: string[] = [];
    const run = p.runTurn(
      opts("use-shell", {
        canUseTool: async (toolId, _approvalId, name, input) => {
          // Session's gate yields once so the tool_start reaches it first.
          await Bun.sleep(0);
          order.push(`gate:${name}:${String(input.command)}:${toolId}`);
          return { behavior: "allow" };
        },
      }),
    );
    const events: ProviderEvent[] = [];
    for await (const e of run.events) {
      if (e.type === "tool_start") order.push(`card:${e.name}:${e.toolId}`);
      events.push(e);
      if (e.type === "turn_done" || e.type === "error") break;
    }
    expect(order[0]).toMatch(/^card:Bash:call_/);
    expect(order[1]).toMatch(/^gate:Bash:ls -la \/tmp:call_/);
    const complete = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }>;
    expect(complete.success).toBe(true);
    expect(texts(events, "text_done")).toEqual(["listed it"]);
    const st = await fakeState(server);
    expect(st.replies.map((r: { decision: string }) => r.decision)).toEqual(["once"]);
  });

  it("a denial rejects with the gate's message, so the model carries on", async () => {
    const { server } = makeServer();
    const events = await collect(
      makeProvider(server).runTurn(opts("use-shell", { canUseTool: async () => ({ behavior: "deny", message: "Not on my machine" }) })),
    );
    expect(texts(events, "text_done")).toEqual(["not allowed: Not on my machine"]);
    // codeoid's own card already says it was declined: no second completion.
    expect(events.filter((e) => e.type === "tool_complete")).toHaveLength(0);
    const st = await fakeState(server);
    expect(st.replies).toMatchObject([{ decision: "reject", message: "Not on my machine" }]);
  });

  it("a denial without a message still sends one (a bare reject would end the step)", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("use-shell", { canUseTool: async () => ({ behavior: "deny" }) })));
    expect(done(events)).toBeDefined();
    const st = await fakeState(server);
    expect(st.replies[0].message).toBeTruthy();
  });

  it("maps edits to Edit with an absolute file_path", async () => {
    const { server } = makeServer();
    const seen: Array<[string, Record<string, unknown>]> = [];
    await collect(makeProvider(server).runTurn(opts("use-edit", { workdir: "/tmp/oc-w", canUseTool: allowing((name, input) => seen.push([name, input])) })));
    expect(seen).toEqual([["Edit", { file_path: "/tmp/oc-w/src/a.ts", old_string: "a", new_string: "b" }]]);
  });

  it("fails closed: an unknown action is rejected without asking", async () => {
    const { server } = makeServer();
    let asked = 0;
    const events = await collect(makeProvider(server).runTurn(opts("unknown-action", { canUseTool: allowing(() => asked++) })));
    expect(asked).toBe(0);
    const complete = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }>;
    expect(complete).toMatchObject({ success: false, declinedByBackend: true });
    expect(texts(events, "text_done")[0]).toContain("refused: codeoid declined this");
    const st = await fakeState(server);
    expect(st.replies.map((r: { decision: string }) => r.decision)).toEqual(["reject"]);
  });

  it("fails closed: another session's MCP mount is rejected without asking", async () => {
    const { server } = makeServer();
    let asked = 0;
    await collect(makeProvider(server).runTurn(opts("foreign-mcp", { canUseTool: allowing(() => asked++) })));
    expect(asked).toBe(0);
    const st = await fakeState(server);
    expect(st.replies.map((r: { decision: string }) => r.decision)).toEqual(["reject"]);
  });

  it("a gate that throws is a denial", async () => {
    const { server } = makeServer();
    await collect(makeProvider(server).runTurn(opts("use-shell", { canUseTool: async () => { throw new Error("boom"); } })));
    const st = await fakeState(server);
    expect(st.replies[0]).toMatchObject({ decision: "reject" });
    expect(st.replies[0].message).toContain("boom");
  });

  it("never replies always — not even when the request offers one to save", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    for (const prompt of ["use-shell", "use-edit", "subagent", "ask-user"]) {
      await collect(p.runTurn(opts(prompt, { requestUserInput: async () => ({ cancelled: false, value: "Option A", confirmed: true }) })));
    }
    const st = await fakeState(server);
    expect(st.replies.length).toBeGreaterThan(3);
    expect(st.replies.every((r: { decision: string }) => r.decision === "once" || r.decision === "reject")).toBe(true);
  });

  it("a request pending when the server dies is withdrawn and the turn fails", async () => {
    const { server } = makeServer();
    let signal: AbortSignal | undefined;
    const events = await collect(
      makeProvider(server).runTurn(
        opts("die-asking", {
          canUseTool: (_t, _a, _n, _i, s) =>
            new Promise((resolve) => {
              signal = s;
              s?.addEventListener("abort", () => resolve({ behavior: "deny" }));
            }),
        }),
      ),
    );
    expect(signal?.aborted).toBe(true);
    expect(events.some((e) => e.type === "tool_complete" && !e.success && e.output.includes("server stopped"))).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("an approved fetch can't follow a redirect to another site; the fence is lifted when it ends", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const asked: unknown[] = [];
    const events = await collect(p.runTurn(opts("use-webfetch", { canUseTool: allowing((name, input) => asked.push([name, input])) })));
    expect(asked).toEqual([["WebFetch", { url: "https://docs.example/start" }]]);
    // opencode checks the hop only against the rules: the fence refused it, so it never went out.
    const st = await fakeState(server);
    expect(st.fetched).toEqual(["https://docs.example/start"]);
    expect(events.some((e) => e.type === "tool_complete" && !e.success && e.output.includes("Permission denied"))).toBe(true);
    expect(texts(events, "text_done")).toEqual(["couldn't fetch it"]);
    // Set before the reply, lifted after: no fetch is fenced once it's over.
    const fenced = st.patches.filter((x: { permissions?: Array<{ action: string; effect: string }> }) => x.permissions?.some((r) => r.action === "webfetch" && r.effect === "deny"));
    expect(fenced).toHaveLength(1);
    expect(st.replies.at(-1)).toMatchObject({ decision: "once" });
    let rules: unknown;
    for (let i = 0; i < 50; i++) {
      rules = (await fakeState(server)).sessions.find((x: { id: string }) => x.id === p.backingSessionId)?.permissions;
      if (JSON.stringify(rules) === JSON.stringify(sessionRules("sess-1"))) break;
      await Bun.sleep(20);
    }
    expect(rules).toEqual(sessionRules("sess-1"));
  });

  it("an approved fetch still follows a redirect on the site that was approved", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("use-webfetch-same")));
    expect((await fakeState(server)).fetched).toEqual(["https://docs.example/start", "https://docs.example/final"]);
    expect(texts(events, "text_done")).toEqual(["fetched it"]);
  });
});

// ── O6 interrupt ─────────────────────────────────────────────────────────────

describe("opencode interrupt", () => {
  it("interrupts the running execution through opencode's endpoint", async () => {
    const { server } = makeServer();
    const run = makeProvider(server).runTurn(opts("slow"));
    const events: ProviderEvent[] = [];
    let interrupted = false;
    for await (const e of run.events) {
      events.push(e);
      if (!interrupted && e.type === "llm_call") {
        interrupted = true;
        void run.interrupt();
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    expect(done(events)?.stopReason).toBe("interrupted");
    const st = await fakeState(server);
    expect(st.interrupts).toHaveLength(1);
  });

  it("an interrupt before the prompt went out stops it from going out", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_SLOW_SYNTHETIC_MS: "1000" });
    const p = makeProvider(server);
    const adopted: string[] = [];
    p.onSessionEvent = (e) => adopted.push(e.type);
    await collect(p.runTurn(opts("hi"))); // attached, no instructions yet
    // The instructions' request is slow: the interrupt lands before the prompt is posted.
    const run = p.runTurn(opts("hi again", { systemPromptAppend: "be brief" }));
    setTimeout(() => void run.interrupt(), 50);
    const events = await collect(run);
    expect(done(events)?.stopReason).toBe("interrupted");
    await Bun.sleep(1_500);
    const st = await fakeState(server);
    expect(st.prompts.map((x: { text: string }) => x.text)).toEqual(["hi"]);
    expect(adopted).not.toContain("turn_started");
    await p.teardown();
  });

  /** A gate that holds `who`'s requests open until they're withdrawn; `reached` resolves at the first. */
  function holding(who: "main" | "child") {
    let reach = () => {};
    const reached = new Promise<void>((r) => {
      reach = r;
    });
    const held: AbortSignal[] = [];
    const gate: ToolApprovalFn = async (_t, _a, _n, _i, signal, agentId) => {
      if ((who === "child") !== (agentId !== undefined)) return { behavior: "allow" };
      held.push(signal!);
      reach();
      return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ behavior: "deny" })));
    };
    return { gate, reached, held };
  }

  it("a request the interrupt dropped (opencode says nothing of it) is withdrawn from the gate", async () => {
    const { server } = makeServer();
    const { gate, reached, held } = holding("main");
    const run = makeProvider(server).runTurn(opts("use-shell", { canUseTool: gate }));
    const collected = collect(run);
    await reached;
    void run.interrupt();
    const events = await collected;
    expect(done(events)?.stopReason).toBe("interrupted");
    expect(held[0]!.aborted).toBe(true);
    expect(events.some((e) => e.type === "tool_complete" && !e.success && e.output.includes("Tool execution interrupted"))).toBe(true);
    // The interrupted step is billed, and the first prompt's title (booked as the execution ends).
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 + 0.0007, 6);
  });

  it("a foreground subagent's request the interrupt dropped is withdrawn too", async () => {
    const { server } = makeServer();
    const { gate, reached, held } = holding("child");
    const run = makeProvider(server).runTurn(opts("subagent", { canUseTool: gate }));
    const collected = collect(run);
    await reached;
    void run.interrupt();
    const events = await collected;
    expect(done(events)?.stopReason).toBe("interrupted");
    expect(held[0]!.aborted).toBe(true);
    expect(events.some((e) => e.type === "subagent_stop")).toBe(true);
  });

  it("stopping a background subagent that's asking withdraws its request from the gate", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const settled: string[] = [];
    p.onSessionEvent = (e) => {
      if (e.type === "background_task_settled") settled.push(e.status);
    };
    const { gate, reached, held } = holding("child");
    const events = await collect(p.runTurn(opts("background", { canUseTool: gate })));
    const child = (events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    await reached;
    expect(await p.stopBackgroundTasks([child])).toEqual([]);
    for (let i = 0; i < 100 && settled.length === 0; i++) await Bun.sleep(20);
    expect(settled).toEqual(["stopped"]);
    expect(held[0]!.aborted).toBe(true);
    await p.teardown();
  });

  it("teardown stops the session's background subagents on the shared server, and the wake that follows", async () => {
    // Session counts a torn-down backend's background work as gone; the
    // server outlives the provider, so the provider stops it there.
    const { server } = makeServer();
    const p = makeProvider(server);
    const seen: string[] = [];
    p.onSessionEvent = (e) => seen.push(e.type);
    const { gate, reached, held } = holding("child");
    const events = await collect(p.runTurn(opts("background", { canUseTool: gate })));
    const child = (events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    await reached;
    const parent = p.backingSessionId;
    await p.teardown();
    expect(held[0]!.aborted).toBe(true);
    const st = await fakeState(server);
    expect(st.interrupts).toContain(child);
    expect(st.sessions.find((x: { id: string }) => x.id === child)).toMatchObject({ outcome: "interrupted" });
    // opencode woke the parent with the stopped subagent's result: stopped too, not handed to a torn-down session.
    expect(st.interrupts).toContain(parent);
    expect(seen).not.toContain("turn_started");
  });
});

// ── O7 models and effort ─────────────────────────────────────────────────────

describe("opencode models and effort", () => {
  it("lists usable chat models as provider/model with variants as efforts", async () => {
    const { server } = makeServer();
    const reported: unknown[] = [];
    const p = makeProvider(server, { onModels: (m) => reported.push(...m) });
    expect(await p.listModels()).toEqual([]); // no server started for a list
    await collect(p.runTurn(opts("hi")));
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-5"]);
    expect(models[0]).toMatchObject({ contextWindow: 200_000, efforts: ["high", "max"], isDefault: true });
    // "fancy" isn't an effort level: not offered as one.
    expect(models[1]?.efforts).toEqual(["minimal", "low", "medium", "high"]);
    expect(reported).toHaveLength(2);
  });

  it("switches model and variant before the prompt, only when they change", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    await collect(p.runTurn(opts("hi", { model: "openai/gpt-5", effort: "low" })));
    await collect(p.runTurn(opts("hi", { model: "openai/gpt-5", effort: "low" })));
    await collect(p.runTurn(opts("hi", { model: "openai/gpt-5" })));
    const e = await collect(p.runTurn(opts("hi", { effort: "max", model: "anthropic/claude-sonnet-4" })));
    const st = await fakeState(server);
    expect(st.modelSwitches.map((s: { model: unknown }) => s.model)).toEqual([
      { providerID: "openai", id: "gpt-5", variant: "low" },
      { providerID: "openai", id: "gpt-5" },
      { providerID: "anthropic", id: "claude-sonnet-4", variant: "max" },
    ]);
    expect(done(e)?.model).toBe("anthropic/claude-sonnet-4");
    expect(p.runningModel).toBe("anthropic/claude-sonnet-4");
  });

  it("selects the configured agent on the session", async () => {
    const { server } = makeServer();
    const p = makeProvider(server, { agent: "plan" });
    await collect(p.runTurn(opts("hi")));
    await collect(p.runTurn(opts("hi")));
    const st = await fakeState(server);
    expect(st.sessions[0].agent).toBe("plan");
    expect(st.agentSwitches).toEqual([]); // set at creation, not switched again
  });

  it("maps variants and model ids", () => {
    expect(effortOfVariant("none")).toBe("off");
    expect(effortOfVariant("XHigh")).toBe("xhigh");
    expect(effortOfVariant("thinking")).toBeNull();
    expect(parseModelValue("openrouter/anthropic/claude#high")).toEqual({ providerID: "openrouter", id: "anthropic/claude" });
    expect(parseModelValue("opencode")).toBeNull();
  });
});

// ── O8 cost ──────────────────────────────────────────────────────────────────

describe("opencode cost and tokens", () => {
  it("sums each step's real cost and tokens into turn_done, with an llm_call per step", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("use-shell")));
    const calls = events.filter((e) => e.type === "llm_call" && e.isPrimary);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ isPrimary: true, usage: { inputTokens: 100, cacheReadTokens: 30, cacheCreationTokens: 10, outputTokens: 25 } });
    const r = done(events)!;
    // Two steps, and the first prompt's title (a side call).
    expect(r.totalCostUsd).toBeCloseTo(0.0246 + 0.0007, 6);
    expect(r).toMatchObject({ providerId: "opencode", inputTokens: 200 + 40, outputTokens: 50 + 6, cacheReadTokens: 60, cacheCreationTokens: 20, contextWindow: 200_000 });
    expect(r.nativeRef?.backingId.startsWith("ses_")).toBe(true);
    expect(r.nativeRef?.ref.startsWith("msg_")).toBe(true);
  });

  it("bills the title opencode generates, which only its running total reports", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    // The title is billed just after the first execution ended: that turn
    // still reports it (the running total is read before its end), not a
    // next turn that may never come.
    const first = await collect(p.runTurn(opts("hi")));
    expect(done(first)!.totalCostUsd).toBeCloseTo(0.0123 + 0.0007, 6);
    const side = first.filter((e) => e.type === "llm_call" && !e.isPrimary);
    expect(side).toEqual([{ type: "llm_call", usage: { inputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 6 }, isPrimary: false }]);
    // Only once: the running total landing after the turn's end adds nothing more.
    const second = await collect(p.runTurn(opts("hi again")));
    expect(done(second)!.totalCostUsd).toBeCloseTo(0.0123, 6);
    expect(second.filter((e) => e.type === "llm_call" && !e.isPrimary)).toEqual([]);
    const third = await collect(p.runTurn(opts("and again")));
    expect(done(third)!.totalCostUsd).toBeCloseTo(0.0123, 6);
    await p.teardown();
  });

  it("counts a compaction's requests once: as the running total bills them, not again at its end", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    const events = await collect(p.runTurn(opts("compact")));
    const r = done(events)!;
    // Two steps and the compaction's two requests (the first turn reported its title).
    expect(r.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.003, 6);
    expect(r.inputTokens).toBe(100 * 2 + 2 * 1000);
    expect(events.filter((e) => e.type === "llm_call" && !e.isPrimary)).toHaveLength(2);
    await p.teardown();
  });

  it("stops at maxBudgetUsd mid-turn, as the spend lands", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("costly", { maxBudgetUsd: 3 })));
    const r = done(events)!;
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toBe(BUDGET_STOP_MESSAGE);
    expect(events.filter((e) => e.type === "llm_call" && e.isPrimary).length).toBeLessThan(3);
    const st = await fakeState(server);
    expect(st.interrupts).toHaveLength(1);
  });

  it("a budget stop with a steer pending pays the steer's boundary first, so Session reads the stop", async () => {
    const { server } = makeServer();
    const run = makeProvider(server).runTurn(opts("costly", { maxBudgetUsd: 3 }));
    const events: ProviderEvent[] = [];
    let pushed = false;
    for await (const e of run.events) {
      events.push(e);
      if (!pushed && e.type === "llm_call") {
        pushed = true;
        run.pushMidTurn?.("also this", "now");
      }
    }
    // Session absorbs one turn_done per now/next push; the last one is the stop.
    const doneEvents = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
    expect(doneEvents.map((d) => d.result.stopReason)).toEqual(["steered", "budget"]);
    expect(doneEvents[1]!.result).toMatchObject({ isError: true, errorMessage: BUDGET_STOP_MESSAGE });
    // The spend is reported once across the two (two steps, and the first prompt's title).
    expect(doneEvents.reduce((sum, d) => sum + d.result.totalCostUsd, 0)).toBeCloseTo(4 + 0.0007, 6);
  });

  it("a turn the server's death ended still reports its spend, on the next turn", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const run = p.runTurn(opts("costly"));
    const events: ProviderEvent[] = [];
    let calls = 0;
    for await (const e of run.events) {
      events.push(e);
      if (e.type === "llm_call" && ++calls === 2) process.kill(server.pid!, "SIGKILL");
      if (e.type === "turn_done" || e.type === "error") break;
    }
    expect(events.at(-1)?.type).toBe("error");
    expect(calls).toBe(2);
    // Two $2 steps ran before the death; Session records no cost for an error.
    // The new server's session bills its own first prompt's title.
    const next = await collect(p.runTurn(opts("hi")));
    expect(done(next)!.totalCostUsd).toBeCloseTo(4 + 0.0123 + 0.0007, 6);
    await p.teardown();
  });
});

// ── O9 MCP ───────────────────────────────────────────────────────────────────

describe("opencode MCP mounts", () => {
  it("mounts memory per session with a scoped token; recall reaches the gate under codeoid's name", async () => {
    const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
    await engine.init();
    const endpoint = new MemoryMcpHttp(engine);
    const { server } = makeServer();
    const p = makeProvider(server, { memoryMcp: { endpoint, url: "http://127.0.0.1:65535/mcp/memory" }, workspaceId: "ws1" });
    expect(p.supportsMemoryTools).toBe(true);
    const names: string[] = [];
    const events = await collect(p.runTurn(opts("use-mcp", { canUseTool: allowing((name) => names.push(name)) })));
    expect(names).toEqual(["mcp__codeoid_memory__recall"]);
    expect(texts(events, "text_done").at(-1)).toBe("recalled");
    const st = await fakeState(server);
    const mount = st.mcp[0];
    expect(mount.name).toBe(`${ownMountPrefix("sess-1")}codeoid_memory`);
    expect(mount.directory).toBe("/tmp/oc-work");
    expect(mount.config).toMatchObject({ type: "remote", url: "http://127.0.0.1:65535/mcp/memory", oauth: false, codemode: false });
    const token = String(mount.config.headers.Authorization).replace(/^Bearer /, "");
    expect(endpoint.activeTokens).toBe(1);
    expect(token.startsWith("mmt_")).toBe(true);
    await p.teardown();
    expect(endpoint.activeTokens).toBe(0);
    const after = await fakeState(server);
    expect(after.mcpRemoved.map((r: { name: string }) => r.name)).toContain(mount.name);
  });

  it("session rules deny every codeoid mount but the session's own, and hide Code Mode", () => {
    const rules = sessionRules("sess-1");
    expect(rules).toEqual([
      { action: "*", resource: "*", effect: "ask" },
      // Code Mode's fetch runs unasked on 2.2.2; the deny hides the tool on 2.2.2 and 2.2.5.
      { action: "execute", resource: "*", effect: "deny" },
      { action: "browser", resource: "*", effect: "deny" },
      { action: "coid*", resource: "*", effect: "deny" },
      { action: `${ownMountPrefix("sess-1")}*`, resource: "*", effect: "ask" },
    ]);
    expect(ownMountPrefix("sess-1")).not.toBe(ownMountPrefix("sess-2"));
  });
});

// ── O10 subagents ────────────────────────────────────────────────────────────

describe("opencode subagents", () => {
  it("shows a foreground subagent, gates its calls as its own agent, and counts its spend", async () => {
    const { server } = makeServer();
    const asks: Array<[string, string | undefined]> = [];
    const events = await collect(
      makeProvider(server).runTurn(opts("subagent", { canUseTool: allowing((name, _input, agentId) => asks.push([name, agentId])) })),
    );
    const start = events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>;
    expect(start.agentType).toBe("explore");
    expect(events.some((e) => e.type === "subagent_stop" && e.agentId === start.agentId)).toBe(true);
    expect(asks[0]).toEqual(["Task", undefined]);
    expect(asks[1]).toEqual(["Bash", start.agentId]);
    expect(events.some((e) => e.type === "llm_call" && !e.isPrimary)).toBe(true);
    // The parent's two steps, the child's, and the first prompt's title.
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.5 + 0.0007, 6);
    // The child is held to codeoid's rules too.
    const st = await fakeState(server);
    expect(st.patches.some((x: { sessionID: string; permissions?: unknown }) => x.sessionID === start.agentId && x.permissions)).toBe(true);
  });

  it("counts a subagent's failed step, which opencode bills", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("subagent-fail")));
    const start = events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>;
    expect(events.some((e) => e.type === "subagent_stop" && e.agentId === start.agentId)).toBe(true);
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.25 + 0.0007, 6);
  });

  it("a background subagent is background work; opencode's own follow-up turn is adopted", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const levels: unknown[] = [];
    const settled: unknown[] = [];
    const adopted: TurnRun[] = [];
    p.onSessionEvent = (e) => {
      if (e.type === "background_tasks") levels.push(e.tasks);
      if (e.type === "background_task_settled") settled.push(e);
      if (e.type === "turn_started") adopted.push(e.run);
    };
    const events = await collect(p.runTurn(opts("background")));
    expect(texts(events, "text_done")).toEqual(["launched"]);
    for (let i = 0; i < 100 && adopted.length === 0; i++) await Bun.sleep(20);
    expect(levels[0]).toMatchObject([{ kind: "subagent", description: "look around", status: "running" }]);
    expect(settled).toMatchObject([{ status: "completed" }]);
    expect(levels.at(-1)).toEqual([]);
    adopted[0]!.bindGate?.({ canUseTool: allow });
    const follow = await collect(adopted[0]!);
    expect(texts(follow, "text_done")).toEqual(["background result received"]);
    // The child's spend, carried (the launching turn reported the first prompt's title).
    expect(done(follow)!.totalCostUsd).toBeCloseTo(0.0123 + 0.5, 6);
  });

  /** A turn that an unanswered request would hang: interrupted after `ms`, so the test reads "interrupted", not a timeout. */
  async function bounded(run: TurnRun, ms = 4_000): Promise<ProviderEvent[]> {
    const timer = setTimeout(() => void run.interrupt(), ms);
    try {
      return await collect(run);
    } finally {
      clearTimeout(timer);
    }
  }

  it("a subagent continued by its id after the provider was rebuilt is learned: asked, shown, counted", async () => {
    // opencode reuses the child session and announces nothing; a rebuilt
    // provider (a model switch, a daemon restart) never saw it created.
    const { server } = makeServer();
    const first = makeProvider(server);
    const events1 = await collect(first.runTurn(opts("subagent")));
    const child = (events1.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    await first.teardown();
    const p = makeProvider(server, { initialBackingId: first.backingSessionId });
    const asks: Array<[string, string | undefined]> = [];
    const events = await bounded(p.runTurn(opts(`subagent continue:${child}`, { canUseTool: allowing((name, _input, agentId) => asks.push([name, agentId])) })));
    expect(done(events)?.stopReason).toBe("stop");
    expect(asks).toEqual([
      ["Task", undefined],
      ["Bash", child],
    ]);
    expect(events.some((e) => e.type === "subagent_start" && e.agentId === child)).toBe(true);
    expect(events.some((e) => e.type === "subagent_stop" && e.agentId === child)).toBe(true);
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.5, 6);
  });

  it("a background subagent continued after a rebuild is background work again, and settles", async () => {
    const { server } = makeServer();
    const first = makeProvider(server);
    const events1 = await collect(first.runTurn(opts("subagent")));
    const child = (events1.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    await first.teardown();
    const p = makeProvider(server, { initialBackingId: first.backingSessionId });
    const levels: unknown[] = [];
    const settled: string[] = [];
    p.onSessionEvent = (e) => {
      if (e.type === "background_tasks") levels.push(e.tasks);
      if (e.type === "background_task_settled") settled.push(e.taskId);
    };
    const asks: string[] = [];
    await bounded(p.runTurn(opts(`background continue:${child}`, { canUseTool: allowing((name, _input, agentId) => asks.push(agentId ? `${name}@child` : name)) })));
    for (let i = 0; i < 100 && settled.length === 0; i++) await Bun.sleep(20);
    expect(asks).toEqual(["Task", "Bash@child"]);
    expect(levels).toContainEqual([{ id: child, kind: "subagent", description: "look around", status: "running" }]);
    expect(settled).toEqual([child]);
    expect(levels.at(-1)).toEqual([]);
    await p.teardown();
  });

  it("another session's executions and requests on the shared server are looked up once, and left alone", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    const other = makeProvider(server, { sessionId: "sess-other", initialBackingId: "sess-other" });
    const asks: string[] = [];
    p.onSessionEvent = () => {};
    for (let i = 0; i < 2; i++) await collect(other.runTurn(opts("use-shell", { canUseTool: allowing((name) => asks.push(name)) })));
    expect(asks).toEqual(["Bash", "Bash"]);
    const st = await fakeState(server);
    // `p` answered none of it, and read the other session once (to learn it
    // isn't a child of its own); `other` read its own total as each turn ended.
    expect(st.replies).toHaveLength(2);
    expect(st.requests.filter((r: string) => r === `GET /api/session/${other.backingSessionId}`)).toHaveLength(1 + 2);
    await other.teardown();
    await p.teardown();
  });
});

describe("opencode background shells", () => {
  /** A turn that an unanswered request would hang: interrupted after `ms`, so the test reads it, not a timeout. */
  async function bounded(run: TurnRun, ms = 4_000): Promise<{ events: ProviderEvent[]; hung: boolean }> {
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      void run.interrupt();
    }, ms);
    const events = await collect(run);
    clearTimeout(timer);
    return { events, hung };
  }

  it("while attached, a background shell's wake is adopted and its call gated", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const adopted: TurnRun[] = [];
    p.onSessionEvent = (e) => {
      if (e.type === "turn_started") adopted.push(e.run);
    };
    const asked: string[] = [];
    const events = await collect(p.runTurn(opts("bg-shell", { canUseTool: allowing((_n, input) => asked.push(String(input.command))) })));
    expect(texts(events, "text_done")).toEqual(["started it in the background"]);
    for (let i = 0; i < 100 && adopted.length === 0; i++) await Bun.sleep(20);
    const follow = await collect(adopted[0]!);
    expect(texts(follow, "text_done")).toEqual(["woke and ran it"]);
    expect(asked).toEqual(["sleep 1; echo bg", "echo woke-tool"]);
    await p.teardown();
  });

  it("tearing down stops the session's background shells and the wake that follows: the rebuilt backend's turn answers", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_BG_SHELL_MS: "1500" });
    const p = makeProvider(server, { sessionId: "sess-bg", initialBackingId: "sess-bg" });
    await collect(p.runTurn(opts("bg-shell")));
    const ses = p.backingSessionId;
    await p.teardown();
    const st = await fakeState(server);
    expect(st.shellsRemoved).toHaveLength(1);
    // The wake opencode ran for the removed shell was stopped, its request with it.
    expect(st.interrupts).toContain(ses);
    await Bun.sleep(1_800);
    const rebuilt = makeProvider(server, { sessionId: "sess-bg", initialBackingId: ses });
    const { events, hung } = await bounded(rebuilt.runTurn(opts("hi")));
    expect(hung).toBe(false);
    expect(texts(events, "text_done")).toEqual(["Hello, world"]);
    await rebuilt.teardown();
  });

  it("a wake that ran after the backend was torn down is stopped when the session is attached again, not queued behind", async () => {
    // Teardown can't find the shell, so its wake runs unwatched and asks.
    const { server } = makeServer({ FAKE_OPENCODE_SHELLS_UNLISTED: "1", FAKE_OPENCODE_BG_SHELL_MS: "300" });
    const p = makeProvider(server, { sessionId: "sess-bg2", initialBackingId: "sess-bg2" });
    await collect(p.runTurn(opts("bg-shell")));
    const ses = p.backingSessionId;
    await p.teardown();
    await Bun.sleep(800);
    const conn = await server.ensure();
    expect(await conn.client.pendingPermissions(ses)).toHaveLength(1);
    const rebuilt = makeProvider(server, { sessionId: "sess-bg2", initialBackingId: ses });
    const { events, hung } = await bounded(rebuilt.runTurn(opts("hi")));
    expect(hung).toBe(false);
    expect(texts(events, "text_done")).toEqual(["Hello, world"]);
    expect(await conn.client.pendingPermissions(ses)).toEqual([]);
    await rebuilt.teardown();
  });

  it("a session its dead server left marked busy, running nothing, takes the next turn: nothing is stopped", async () => {
    const { server } = makeServer();
    const p = makeProvider(server, { sessionId: "sess-died", initialBackingId: "sess-died" });
    await collect(p.runTurn(opts("hi")));
    const ses = p.backingSessionId;
    await p.teardown();
    const conn = await server.ensure();
    await fetch(`${conn.client.baseUrl}/__fake/died/${ses}`, { method: "POST" });
    for (const provider of [p, makeProvider(server, { sessionId: "sess-died", initialBackingId: ses })]) {
      const interrupts = (await fakeState(server)).interrupts.length;
      const started = Date.now();
      const events = await collect(provider.runTurn(opts("hi")));
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(texts(events, "text_done")).toEqual(["Hello, world"]);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(provider.backingSessionId).toBe(ses);
      expect((await fakeState(server)).interrupts.slice(interrupts)).toEqual([]);
      await provider.teardown();
      await fetch(`${conn.client.baseUrl}/__fake/died/${ses}`, { method: "POST" });
    }
  });
});

// ── O11 questions ────────────────────────────────────────────────────────────

describe("opencode questions", () => {
  it("asks a form's fields through requestUserInput and replies with the answers", async () => {
    const { server } = makeServer();
    const asked: UiRequest[] = [];
    const events = await collect(
      makeProvider(server).runTurn(
        opts("ask-user", {
          requestUserInput: async (req): Promise<UiResponse> => {
            asked.push(req);
            return req.method === "select" ? { cancelled: false, value: "Option B" } : { cancelled: false, confirmed: true };
          },
        }),
      ),
    );
    expect(asked.map((a) => [a.method, a.title])).toEqual([["select", "Pick"], ["confirm", "Sure?"]]);
    expect(asked[0]?.options).toEqual(["Option A", "Option B", "Type my own answer"]);
    expect(texts(events, "text_done").at(-1)).toBe('answers: {"q0":"B","q1":true}');
  });

  it("a cancelled dialog is no answer: the form is cancelled with a reason", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("ask-user", { requestUserInput: async () => ({ cancelled: true, reason: "dismissed" }) })));
    expect(texts(events, "text_done").at(-1)).toBe("dismissed: The user dismissed the question.");
  });

  it("with nobody to ask, the form is cancelled", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("ask-user")));
    expect(texts(events, "text_done").at(-1)).toContain("dismissed: Nobody can answer");
  });
});

// ── O12 steering ─────────────────────────────────────────────────────────────

describe("opencode mid-turn messages", () => {
  it("steers a running turn: one absorbed boundary, then the turn's end", async () => {
    const { server } = makeServer();
    const run = makeProvider(server).runTurn(opts("steer"));
    const events: ProviderEvent[] = [];
    let pushed = false;
    let dones = 0;
    for await (const e of run.events) {
      events.push(e);
      if (!pushed && e.type === "text_done") {
        pushed = true;
        run.pushMidTurn?.("also this", "now");
      }
      if (e.type === "turn_done" && ++dones === 2) break;
      if (e.type === "error") break;
    }
    const doneEvents = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
    expect(doneEvents.map((d) => d.result.stopReason)).toEqual(["steered", "stop"]);
    expect(texts(events, "text_done")).toEqual(["first part", "steered: also this (steer)"]);
    const st = await fakeState(server);
    expect(st.prompts.at(-1)).toMatchObject({ text: "also this", delivery: "steer" });
  });

  for (const [priority, ends] of [
    ["now", ["steered", "stop"]],
    ["later", ["stop"]],
  ] as const) {
    it(`a ${priority} message pushed while the turn's end reads opencode's total is still this turn's, and answered in it`, async () => {
      const { server } = makeServer();
      const p = makeProvider(server);
      const adopted: unknown[] = [];
      p.onSessionEvent = (e) => adopted.push(e.type);
      const run = p.runTurn(opts("hi"));
      const events: ProviderEvent[] = [];
      let armed = false;
      const read = OpencodeClient.prototype.getSession;
      // The push lands just as the read answers, before opencode starts the execution it runs the message in.
      OpencodeClient.prototype.getSession = async function (this: OpencodeClient, id: string) {
        const info = await read.call(this, id);
        if (armed) {
          armed = false;
          run.pushMidTurn?.("also this", priority);
        }
        return info;
      };
      try {
        let dones = 0;
        const reader = (async () => {
          for await (const e of run.events) {
            events.push(e);
            if (e.type === "text_done" && dones === 0 && !armed && texts(events, "text_done").length === 1) armed = true;
            if ((e.type === "turn_done" && ++dones === ends.length) || e.type === "error") break;
          }
        })();
        await Promise.race([reader, Bun.sleep(6_000)]);
      } finally {
        OpencodeClient.prototype.getSession = read;
      }
      const doneEvents = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
      expect(doneEvents.map((d) => d.result.stopReason)).toEqual([...ends]);
      expect(texts(events, "text_done")).toEqual(["Hello, world", "Hello, world"]);
      expect(adopted).toEqual([]);
      const st = await fakeState(server);
      expect(st.prompts.at(-1)).toMatchObject({ text: "also this", delivery: priority === "later" ? "queue" : "steer" });
    });
  }

  it("a steer delivered and answered before its request returns still ends the turn", async () => {
    // The feed can beat the prompt reply: opencode takes the steer at the
    // step boundary and answers it in the same execution.
    const { server } = makeServer({ FAKE_OPENCODE_STEER_REPLY_MS: "400" });
    const run = makeProvider(server).runTurn(opts("steer"));
    const events: ProviderEvent[] = [];
    let pushed = false;
    let dones = 0;
    const reader = (async () => {
      for await (const e of run.events) {
        events.push(e);
        if (!pushed && e.type === "text_done") {
          pushed = true;
          run.pushMidTurn?.("also this", "now");
        }
        if (e.type === "turn_done" && ++dones === 2) break;
        if (e.type === "error") break;
      }
    })();
    await Promise.race([reader, Bun.sleep(5_000)]);
    const doneEvents = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
    expect(doneEvents.map((d) => d.result.stopReason)).toEqual(["steered", "stop"]);
    expect(texts(events, "text_done")).toEqual(["first part", "steered: also this (steer)"]);
  });

  it("a message pushed before the turn's prompt is posted goes after it, and the turn answers both", async () => {
    // The instructions request is slow, so the push lands while the turn is
    // still attaching (turn 1: no opencode session yet) or switching (turn 2).
    const { server } = makeServer({ FAKE_OPENCODE_SLOW_SYNTHETIC_MS: "400" });
    const p = makeProvider(server);
    for (const [instructions, pushAfterMs] of [["be brief", 0], ["be briefer", 150]] as const) {
      const run = p.runTurn(opts("steer", { systemPromptAppend: instructions }));
      if (pushAfterMs === 0) run.pushMidTurn?.("also this", "now");
      else setTimeout(() => run.pushMidTurn?.("also this", "now"), pushAfterMs);
      const events: ProviderEvent[] = [];
      let dones = 0;
      const reader = (async () => {
        for await (const e of run.events) {
          events.push(e);
          if ((e.type === "turn_done" && ++dones === 2) || e.type === "error") break;
        }
      })();
      await Promise.race([reader, Bun.sleep(6_000)]);
      const doneEvents = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
      expect(doneEvents.map((d) => d.result.stopReason)).toEqual(["steered", "stop"]);
      expect(texts(events, "text_done")).toEqual(["first part", "steered: also this (steer)"]);
    }
    const st = await fakeState(server);
    expect(st.prompts.map((x: { text: string }) => x.text)).toEqual(["steer", "also this", "steer", "also this"]);
    await p.teardown();
  });

  it("a steer opencode refuses still pays the boundary Session counted, at the turn's end", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_STEER_FAIL: "1" });
    const run = makeProvider(server).runTurn(opts("steer"));
    const events: ProviderEvent[] = [];
    let pushed = false;
    let dones = 0;
    const reader = (async () => {
      for await (const e of run.events) {
        events.push(e);
        if (!pushed && e.type === "text_done") {
          pushed = true;
          run.pushMidTurn?.("also this", "now");
        }
        if ((e.type === "turn_done" && ++dones === 2) || e.type === "error") break;
      }
    })();
    await Promise.race([reader, Bun.sleep(6_000)]);
    expect(events.some((e) => e.type === "custom_message" && e.metadata?.event === "opencode.steer_failed")).toBe(true);
    const doneEvents = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
    // Session absorbs the first; the second is the turn's end.
    expect(doneEvents.map((d) => d.result.stopReason)).toEqual(["steered", "stop"]);
  });

  it("a steer delivered in a feed gap that closes before the execution ends is paid from the read-back", async () => {
    const { server } = makeServer();
    const run = makeProvider(server).runTurn(opts("steer-gap"));
    const events: ProviderEvent[] = [];
    let pushed = false;
    let dones = 0;
    const reader = (async () => {
      for await (const e of run.events) {
        events.push(e);
        if (!pushed && e.type === "text_done") {
          pushed = true;
          run.pushMidTurn?.("also this", "now");
        }
        if ((e.type === "turn_done" && ++dones === 2) || e.type === "error") break;
      }
    })();
    await Promise.race([reader, Bun.sleep(6_000)]);
    const order = events.flatMap((e) => (e.type === "text_done" ? [e.content] : e.type === "turn_done" ? [`turn_done ${e.result.stopReason}`] : []));
    // The boundary falls where the steer was taken, before its answer.
    expect(order).toEqual(["first part", "turn_done steered", "steered: also this", "after the gap", "turn_done stop"]);
  });

  it("a later message is queued behind the turn", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    p.onSessionEvent = () => {};
    const run = p.runTurn(opts("slow"));
    for await (const e of run.events) {
      if (e.type === "llm_call") {
        run.pushMidTurn?.("afterwards", "later");
        await Bun.sleep(50);
        void run.interrupt();
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    const st = await fakeState(server);
    expect(st.prompts.at(-1)).toMatchObject({ text: "afterwards", delivery: "queue" });
  });

  it("what the user's interrupt dropped is withdrawn from opencode's inbox: the next turn doesn't get it", async () => {
    // The steer's request answers after the interrupt (its id comes back late); the queued one answers at once.
    const { server } = makeServer({ FAKE_OPENCODE_STEER_REPLY_MS: "300" });
    const p = makeProvider(server);
    const run = p.runTurn(opts("slow"));
    for await (const e of run.events) {
      if (e.type === "llm_call") {
        run.pushMidTurn?.("dropped steer", "now");
        run.pushMidTurn?.("dropped queued", "later");
        await Bun.sleep(100);
        void run.interrupt();
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    await Bun.sleep(500);
    const next = await collect(p.runTurn(opts("echo-state")));
    const seen = JSON.parse(texts(next, "text_done")[0]!) as { prompt: string };
    expect(seen.prompt).toBe("echo-state");
    const st = await fakeState(server);
    const ids = st.prompts.filter((x: { text: string }) => x.text.startsWith("dropped")).map((x: { id: string }) => x.id);
    expect(ids).toHaveLength(2);
    expect([...st.inboxCancels].sort()).toEqual([...ids].sort());
    await p.teardown();
  });

  it("a later message is answered inside the running turn, which ends once", async () => {
    // Real 2.2.x delivers a queued input in the running execution, after its reply.
    const { server } = makeServer();
    const p = makeProvider(server);
    let adopted = 0;
    p.onSessionEvent = (e) => {
      if (e.type === "turn_started") adopted++;
    };
    const run = p.runTurn(opts("steer"));
    const events: ProviderEvent[] = [];
    let pushed = false;
    for await (const e of run.events) {
      events.push(e);
      if (!pushed && e.type === "text_done") {
        pushed = true;
        run.pushMidTurn?.("queued one", "later");
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    expect(texts(events, "text_done")).toEqual(["first part", "steered: queued one (queue)"]);
    expect(events.filter((e) => e.type === "turn_done")).toHaveLength(1);
    expect(adopted).toBe(0);
    await p.teardown();
  });

  it("a later message queued as the execution ends is answered in the same turn, which ends once", async () => {
    // Real 2.2.x takes a queued input only between steps: one that lands
    // after the last step runs in an execution of its own, right after.
    const { server } = makeServer();
    const p = makeProvider(server);
    let adopted = 0;
    p.onSessionEvent = (e) => {
      if (e.type === "turn_started") adopted++;
    };
    const run = p.runTurn(opts("hi"));
    const events: ProviderEvent[] = [];
    let pushed = false;
    for await (const e of run.events) {
      events.push(e);
      if (!pushed && e.type === "text_done") {
        pushed = true;
        run.pushMidTurn?.("again", "later");
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    expect(texts(events, "text_done")).toEqual(["Hello, world", "Hello, world"]);
    expect(events.filter((e) => e.type === "turn_done")).toHaveLength(1);
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.0007, 6);
    await Bun.sleep(300);
    expect(adopted).toBe(0);
    await p.teardown();
  });
});

// ── commands, fork ───────────────────────────────────────────────────────────

describe("opencode commands and fork", () => {
  it("lists commands and skills, and runs them", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    const cmds = await p.listCommands();
    expect(cmds).toEqual([
      { name: "init", description: "guided AGENTS.md setup", source: "command" },
      { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted", source: "command" },
      { name: "goal", description: "keep working until an objective is met [pause|resume|clear]", source: "command" },
      { name: "deploy", description: "Deploy it", source: "skill" },
    ]);
    const review = await collect(p.runTurn(opts("/review the diff")));
    expect(texts(review, "text_done")).toEqual(["Hello, world"]);
    // A command that only acts (starts no execution) still ends the turn.
    const clear = await collect(p.runTurn(opts("/goal clear")));
    expect(done(clear)).toBeDefined();
    await collect(p.runTurn(opts("/deploy now")));
    const st = await fakeState(server);
    expect(st.commands).toMatchObject([{ name: "review", text: "the diff" }, { name: "goal", text: "clear" }]);
    expect(st.prompts.at(-1)).toMatchObject({ text: "now", skills: [{ id: "skl_1" }] });
  });

  it("another session's MCP prompts in the same workdir aren't listed or run here: the message goes as text", async () => {
    const { server } = makeServer();
    const blackboardMcp = () => ({ url: "http://127.0.0.1:9/mcp", token: "A-TOKEN" });
    const a = makeProvider(server, { sessionId: "sess-tenant-a", initialBackingId: "sess-tenant-a", blackboardMcp });
    const b = makeProvider(server, { sessionId: "sess-tenant-b", initialBackingId: "sess-tenant-b" });
    await collect(a.runTurn(opts("hi")));
    await collect(b.runTurn(opts("hi")));
    const own = `${ownMountPrefix("sess-tenant-a")}codeoid_blackboard:brief`;
    expect((await a.listCommands()).map((c) => c.name)).toContain(own);
    expect((await b.listCommands()).map((c) => c.name)).not.toContain(own);
    await collect(b.runTurn(opts(`/${own} payroll`)));
    let st = await fakeState(server);
    expect(st.mcpPromptCalls).toEqual([]);
    expect(st.prompts.at(-1)).toMatchObject({ text: `/${own} payroll` });
    // Its own session runs it.
    await collect(a.runTurn(opts(`/${own} payroll`)));
    st = await fakeState(server);
    expect(st.mcpPromptCalls).toMatchObject([{ mount: own.slice(0, own.indexOf(":")) }]);
    await a.teardown();
    await b.teardown();
  });

  it("a command from a config dir isn't run as one: its template's shell spans never run, the message goes as text", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_CONFIG_COMMANDS: "1" });
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    expect((await p.listCommands()).map((c) => c.name)).not.toContain("summarize");
    const message = "/summarize the build !`touch marker`";
    await collect(p.runTurn(opts(message)));
    // A built-in never carries a shell span either.
    await collect(p.runTurn(opts("/review !`touch marker`")));
    const st = await fakeState(server);
    expect(st.commands).toEqual([]);
    expect(st.shellRan).toEqual([]);
    expect(st.prompts.slice(-2).map((x: { text: string }) => x.text)).toEqual([message, "/review !`touch marker`"]);
    await p.teardown();
  });

  it("a config command that replaces a built-in isn't run as the built-in", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_CONFIG_COMMANDS: "shadow" });
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    expect((await p.listCommands()).map((c) => c.name)).not.toContain("review");
    await collect(p.runTurn(opts("/review the build")));
    const st = await fakeState(server);
    expect(st.commands).toEqual([]);
    expect(st.prompts.at(-1)).toMatchObject({ text: "/review the build" });
    await p.teardown();
  });

  it("forks natively at the turn's end", async () => {
    const { server } = makeServer();
    const parent = makeProvider(server);
    const first = done(await collect(parent.runTurn(opts("hi"))))!;
    await collect(parent.runTurn(opts("hi")));
    const fork = makeProvider(server, { sessionId: "sess-fork", initialBackingId: "sess-fork" });
    const res = await fork.continueNatively({ history: [], forkFrom: first.nativeRef, maxChars: 10_000, workdir: "/tmp/oc-work" });
    expect(res).toEqual({ via: "fork" });
    await collect(fork.runTurn(opts("hi")));
    const st = await fakeState(server);
    expect(st.forks).toHaveLength(1);
    expect(st.forks[0].source).toBe(parent.backingSessionId);
    expect(st.forks[0].before).toMatch(/^msg_/); // the message after the first turn's last
    expect(fork.backingSessionId).toBe(st.forks[0].id);
    expect(st.patches.some((x: { sessionID: string }) => x.sessionID === st.forks[0].id)).toBe(true);
  });

  it("a fork into a worktree of its own is moved there before it runs: its tools act in the fork's directory", async () => {
    // The move's own execution reaches the feed late: it's no turn's.
    const { server } = makeServer({ FAKE_OPENCODE_MOVE_FEED_LAG_MS: "5" });
    const parentDir = realpathSync(tmp());
    const forkDir = realpathSync(tmp());
    const parent = makeProvider(server);
    const first = done(await collect(parent.runTurn(opts("hi", { workdir: parentDir }))))!;
    const fork = makeProvider(server, { sessionId: "sess-fork", initialBackingId: "sess-fork" });
    expect(await fork.continueNatively({ history: [], forkFrom: first.nativeRef, maxChars: 10_000, workdir: forkDir })).toEqual({ via: "fork" });
    const events = await collect(fork.runTurn(opts("hi", { workdir: forkDir })));
    expect(texts(events, "text_done")).toEqual(["Hello, world"]);
    expect(events.filter((e) => e.type === "turn_done")).toHaveLength(1);
    const st = await fakeState(server);
    expect(fork.backingSessionId).toBe(st.forks[0].id);
    expect(st.moves).toEqual([{ sessionID: st.forks[0].id, directory: forkDir }]);
    expect(st.sessions.find((x: { id: string }) => x.id === st.forks[0].id).location).toEqual({ directory: forkDir });
    expect(st.prompts.at(-1)).toMatchObject({ sessionID: st.forks[0].id, text: "hi" });
    // The parent stays where it is.
    expect(st.sessions.find((x: { id: string }) => x.id === parent.backingSessionId).location).toEqual({ directory: parentDir });
    await fork.teardown();
    await parent.teardown();
  });

  it("a fork opencode won't move goes on from the transcript, in a new session in the fork's directory", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_MOVE_IGNORED: "1" });
    const parentDir = realpathSync(tmp());
    const forkDir = realpathSync(tmp());
    const parent = makeProvider(server);
    const first = done(await collect(parent.runTurn(opts("hi", { workdir: parentDir }))))!;
    const fork = makeProvider(server, { sessionId: "sess-fork", initialBackingId: "sess-fork" });
    await fork.continueNatively({ history: [{ role: "user", content: "hi" } as never], forkFrom: first.nativeRef, maxChars: 10_000, workdir: forkDir });
    const events = await collect(fork.runTurn(opts("next", { workdir: forkDir })));
    expect(events.some((e) => e.type === "custom_message" && e.metadata?.event === "history.native_fallback")).toBe(true);
    const st = await fakeState(server);
    const ran = st.sessions.find((x: { id: string }) => x.id === fork.backingSessionId);
    expect(fork.backingSessionId).not.toBe(st.forks[0].id);
    expect(ran.location).toEqual({ directory: forkDir });
    expect(st.prompts.at(-1).sessionID).toBe(fork.backingSessionId);
    await fork.teardown();
    await parent.teardown();
  });

  it("a session resumed in another directory is moved there", async () => {
    const { server } = makeServer();
    const before = realpathSync(tmp());
    const after = realpathSync(tmp());
    const a = makeProvider(server);
    await collect(a.runTurn(opts("hi", { workdir: before })));
    const id = a.backingSessionId;
    await a.teardown();
    const b = makeProvider(server, { initialBackingId: id });
    const events = await collect(b.runTurn(opts("hi", { workdir: after })));
    expect(texts(events, "text_done")).toEqual(["Hello, world"]);
    expect(b.backingSessionId).toBe(id);
    const st = await fakeState(server);
    expect(st.moves).toEqual([{ sessionID: id, directory: after }]);
    expect(st.sessions.find((x: { id: string }) => x.id === id).location).toEqual({ directory: after });
    await b.teardown();
  });

  it("without a native point, continueNatively declines (transcript seed)", async () => {
    const { server } = makeServer();
    expect(await makeProvider(server).continueNatively({ history: [], maxChars: 1000, workdir: "/tmp" })).toBeNull();
  });
});

// ── O13 version range, agent check, saved approvals ─────────────────────────

describe("opencode version and safety checks", () => {
  it("accepts 2.2.5 and later 2.2 releases only", () => {
    expect(opencodeVersionProblem("2.2.5")).toBeNull();
    expect(opencodeVersionProblem("v2.2.5")).toBeNull();
    expect(opencodeVersionProblem("2.2.5+build.7")).toBeNull();
    expect(opencodeVersionProblem("2.2.10-beta.1")).toBeNull();
    // 2.2.2 runs a shell line made only of redirections without asking.
    expect(opencodeVersionProblem("2.2.2")).toContain("runs some shell commands without asking codeoid");
    expect(opencodeVersionProblem("2.2.4")).toContain("2.2.5 or a later 2.2.x");
    expect(opencodeVersionProblem("2.2.5-beta.1")).toContain("without asking");
    expect(opencodeVersionProblem("1.4.0")).toContain("1.x");
    expect(opencodeVersionProblem("2.3.0")).toContain("2.2.5 or a later 2.2.x");
    expect(opencodeVersionProblem("2.1.9")).toContain("predates");
    expect(opencodeVersionProblem("local")).toContain("can't read");
  });

  it("refuses a 2.2 release below the floor", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_VERSION: "2.2.2" });
    await expect(server.ensure()).rejects.toThrow(/opencode 2\.2\.2 is installed.*without asking codeoid/);
  });

  it("refuses a server outside the range, and says so", async () => {
    let hint = "";
    const { server } = makeServer({ FAKE_OPENCODE_VERSION: "1.9.0" }, { onIncompatible: (h) => {
      hint = h;
    } });
    await expect(server.ensure()).rejects.toBeInstanceOf(OpencodeIncompatibleError);
    expect(hint).toContain("opencode 1.9.0 is installed");
    expect(server.running).toBe(false);
  });

  it("restarts once with overrides when a subagent would act without asking", async () => {
    const { server, starts } = makeServer({ FAKE_OPENCODE_UNSAFE_AGENT: "1" });
    await server.ensure();
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(2);
    const st = await fakeState(server);
    expect(st.config.agents.explore.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "ask" },
    ]);
  });

  it("refuses a server whose subagents still act without asking", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_UNSAFE_AGENT: "1", FAKE_OPENCODE_STUBBORN: "1" });
    await expect(server.ensure()).rejects.toThrow(/would run tools without asking codeoid/);
  });

  it("removes saved approvals from codeoid's database", async () => {
    const { server } = makeServer({ FAKE_OPENCODE_SAVED: "1" });
    await collect(makeProvider(server).runTurn(opts("hi")));
    const st = await fakeState(server);
    expect(st.savedRemoved).toEqual(["prm_1"]);
  });

  it("judges which allow rules survive", () => {
    expect(survivingAllows([{ action: "*", resource: "*", effect: "allow" }, { action: "*", resource: "*", effect: "ask" }])).toEqual([]);
    expect(survivingAllows([{ action: "*", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "allow" }])).toHaveLength(1);
    expect(survivingAllows([{ action: "read", resource: "*.env.example", effect: "allow" }, { action: "read", resource: "*", effect: "ask" }])).toEqual([]);
    expect(unsafeAgents([{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] }])).toEqual([]);
    expect(opencodeConfig({ x: { permissions: [] } }).agents).toEqual({ x: { permissions: [] } });
  });

  it("maps permission requests onto the gate's names, or refuses them", () => {
    const ctx = { workdir: "/w", ownPrefix: "coidabc_", mounts: new Map([["codeoid_memory", "codeoid_memory"], ["my_srv", "my.srv"]]) };
    const req = (action: string, resources: string[] = [], metadata?: Record<string, unknown>) => ({ id: "per_1", sessionID: "ses_1", action, resources, metadata });
    expect(gateCallFor(req("shell", ["ls"]), { name: "shell", input: { command: "ls && pwd" } }, ctx)).toEqual({ name: "Bash", input: { command: "ls && pwd" } });
    expect(gateCallFor(req("shell", ["ls"]), undefined, ctx).unshowable).toBeTruthy();
    expect(gateCallFor(req("read", ["src/x.ts"]), undefined, ctx)).toEqual({ name: "Read", input: { file_path: "/w/src/x.ts" } });
    expect(gateCallFor(req("edit", ["a.txt"]), { name: "write", input: { path: "a.txt", content: "hi" } }, ctx)).toEqual({ name: "Write", input: { file_path: "/w/a.txt", content: "hi" } });
    expect(gateCallFor(req("webfetch", ["https://x"]), undefined, ctx)).toEqual({ name: "WebFetch", input: { url: "https://x" } });
    expect(gateCallFor(req("coidabc_my_srv_do_it", ["*"], { input: { a: 1 } }), undefined, ctx)).toEqual({ name: "mcp__my.srv__do_it", input: { a: 1 } });
    expect(gateCallFor(req("coidabc_codeoid_memory_recall", ["*"]), undefined, ctx).name).toBe("mcp__codeoid_memory__recall");
    expect(gateCallFor(req("coidzzz_codeoid_memory_recall", ["*"]), undefined, ctx).unshowable).toBeTruthy();
    expect(gateCallFor(req("context7_resolve", ["*"]), undefined, ctx).unshowable).toBeTruthy();
  });

  it("shows where a path really leads; a read or search a symlink takes out of the workdir isn't a safe Read", () => {
    const root = realpathSync(tmp());
    const work = join(root, "work");
    const outside = join(root, "outside");
    mkdirSync(join(work, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "x");
    writeFileSync(join(outside, "profile.txt"), "x");
    writeFileSync(join(work, "plain.txt"), "x");
    symlinkSync(join(outside, "secret.txt"), join(work, "notes.txt"));
    symlinkSync(outside, join(work, "docs"));
    symlinkSync(join(outside, "profile.txt"), join(work, "config.txt"));
    symlinkSync(join(outside, "new.txt"), join(work, "dangling.txt"));
    symlinkSync(join(work, "sub"), join(work, "inner"));
    const ctx = { workdir: work, ownPrefix: "coidabc_", mounts: new Map<string, string>() };
    const req = (action: string, resources: string[] = []) => ({ id: "per_1", sessionID: "ses_1", action, resources });
    const external = (tool: string, path: string, requested: string, dir = outside) => ({ name: "opencode_external_directory", input: { directories: [dir], tool, path, requested } });

    expect(gateCallFor(req("read", [join(work, "notes.txt")]), undefined, ctx)).toEqual(external("read", join(outside, "secret.txt"), join(work, "notes.txt")));
    expect(gateCallFor(req("read", [join(work, "docs", "secret.txt")]), undefined, ctx)).toEqual(external("read", join(outside, "secret.txt"), join(work, "docs", "secret.txt")));
    expect(gateCallFor(req("read", [join(work, "docs")]), undefined, ctx)).toEqual(external("read", outside, join(work, "docs")));
    expect(gateCallFor(req("grep", ["TOP"]), { name: "grep", input: { pattern: "TOP", path: "docs" } }, ctx)).toEqual(external("grep", outside, join(work, "docs")));
    expect(gateCallFor(req("glob", ["**/*.txt"]), { name: "glob", input: { pattern: "**/*.txt", path: "docs" } }, ctx)).toEqual(external("glob", outside, join(work, "docs")));
    // Inside, as written and really: the safe names, with the real path.
    expect(gateCallFor(req("read", [join(work, "plain.txt")]), undefined, ctx)).toEqual({ name: "Read", input: { file_path: join(work, "plain.txt") } });
    expect(gateCallFor(req("read", [join(work, "inner")]), undefined, ctx)).toEqual({ name: "Read", input: { file_path: join(work, "sub"), requested_path: join(work, "inner") } });
    expect(gateCallFor(req("grep", ["TOP"]), { name: "grep", input: { pattern: "TOP" } }, ctx)).toEqual({ name: "Grep", input: { pattern: "TOP" } });
    // Outside as written: opencode asked external_directory for it already.
    expect(gateCallFor(req("read", [join(outside, "secret.txt")]), undefined, ctx)).toEqual({ name: "Read", input: { file_path: join(outside, "secret.txt") } });
    // A write names the file it really changes, a dangling link the file it creates.
    expect(gateCallFor(req("edit", [join(work, "config.txt")]), { name: "write", input: { path: "config.txt", content: "hi" } }, ctx)).toEqual({
      name: "Write",
      input: { file_path: join(outside, "profile.txt"), content: "hi", requested_path: join(work, "config.txt") },
    });
    expect(gateCallFor(req("edit", [join(work, "dangling.txt")]), { name: "edit", input: { path: "dangling.txt", oldString: "a", newString: "b" } }, ctx).input).toMatchObject({
      file_path: join(outside, "new.txt"),
      requested_path: join(work, "dangling.txt"),
    });
    expect(gateCallFor(req("edit", [join(work, "config.txt")]), { name: "patch", input: { patchText: "*** x" } }, ctx).input.file_path).toBe(join(outside, "profile.txt"));
    expect(gateCallFor(req("edit", [join(work, "new", "file.txt")]), { name: "write", input: { path: "new/file.txt", content: "" } }, ctx).input.file_path).toBe(join(work, "new", "file.txt"));
    // A shell's working directory too.
    expect(gateCallFor(req("shell", ["ls"]), { name: "shell", input: { command: "ls", workdir: "docs" } }, ctx).input.cwd).toBe(outside);
  });

  it("parses server-sent events", async () => {
    const body = new Response('data: {"type":"a"}\n\n: comment\n\nevent: x\ndata: {"type":\ndata: "b"}\n\ndata: not json\n\n').body!;
    const out = [];
    for await (const e of parseSse(body)) out.push(e.type);
    expect(out).toEqual(["a", "b"]);
  });
});

// ── O14 database location, registry ─────────────────────────────────────────

describe("opencode database location and registry", () => {
  it("defaults beside codeoid's database, with its own override", () => {
    expect(opencodeDbPath({ dbPath: "/data/codeoid/codeoid.db" } as CodeoidConfig)).toBe("/data/codeoid/opencode/opencode.db");
    expect(
      opencodeDbPath({ dbPath: "/data/codeoid/codeoid.db", providers: { opencode: { enabled: true, command: "opencode", dbPath: "/elsewhere/oc.db" } } } as unknown as CodeoidConfig),
    ).toBe("/elsewhere/oc.db");
  });

  function binDir(): string {
    const dir = tmp();
    const bin = join(dir, "opencode");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    return dir;
  }

  it("registers when the binary resolves, from PATH or providers.opencode.command", () => {
    const dir = binDir();
    expect(resolveOpencodeCommand(undefined, { PATH: dir })?.source).toBe("path");
    expect(resolveOpencodeCommand(join(dir, "opencode"), { PATH: "" })?.source).toBe("config");
    const reg = createDefaultProviderRegistry(undefined, { PATH: dir });
    expect(reg.has("opencode")).toBe(true);
    expect(reg.get("opencode")?.displayName).toBe("opencode");
  });

  it("is unavailable, with a hint, when the binary is missing", () => {
    const reg = createDefaultProviderRegistry(undefined, { PATH: "" });
    expect(reg.has("opencode")).toBe(false);
    expect(reg.unavailableHint("opencode")).toBe(OPENCODE_INSTALL_HINT);
    const cfg = { providers: { opencode: { enabled: true, command: "/nope/opencode" } } } as unknown as CodeoidConfig;
    expect(createDefaultProviderRegistry(cfg, { PATH: "" }).unavailableHint("opencode")).toContain("providers.opencode.command");
  });

  it("is neither registered nor hinted when disabled", () => {
    const dir = binDir();
    const cfg = { providers: { opencode: { enabled: false, command: "opencode" } } } as unknown as CodeoidConfig;
    const reg = createDefaultProviderRegistry(cfg, { PATH: dir });
    expect(reg.has("opencode")).toBe(false);
    expect(reg.unavailableHint("opencode")).toBeUndefined();
  });
});

// ── O15 what the real binaries showed ───────────────────────────────────────

describe("opencode as real 2.2.x servers behave", () => {
  it("reads its session from the live feed: the durable log replays nothing, and no turn waits on it", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const started = Date.now();
    const events = await collect(p.runTurn(opts("hi")));
    // The old reader waited 10s for a `log.synced` the follow stream never sends.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(texts(events, "text_done")).toEqual(["Hello, world"]);
    const st = await fakeState(server);
    expect(st.requests.some((r: string) => r.includes("/log"))).toBe(false);
    await p.teardown();
  });

  it("hides Code Mode: a script call fails unrun, so its fetch can't get past the gate (2.2.2 runs it unasked)", async () => {
    const { server } = makeServer();
    const asked: string[] = [];
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("use-codemode", { canUseTool: allowing((name) => asked.push(name)) })));
    expect(asked).toEqual([]);
    const card = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }>;
    expect(card.name).toBe("opencode_execute");
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ sdkToolUseId: card.toolId, success: false });
    expect(texts(events, "text_done")).toEqual(["no code mode"]);
    expect((await fakeState(server)).replies).toEqual([]);
    await p.teardown();
  });

  it("if Code Mode runs anyway, each fetch of a script is gated under a card of its own, inside the script's card", async () => {
    // As 2.2.5 behaves with the tool offered: every fetch asks webfetch, naming the script's call.
    const { server } = makeServer({ FAKE_OPENCODE_CODEMODE: "1" });
    const asked: Array<[string, Record<string, unknown>]> = [];
    const gate: ToolApprovalFn = async (_t, _a, name, input) => {
      asked.push([name, input]);
      return input.method === "POST" ? { behavior: "deny", message: "no posting" } : { behavior: "allow" };
    };
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("use-codemode", { canUseTool: gate })));
    expect(asked).toEqual([
      ["WebFetch", { url: "https://example.com/a" }],
      ["WebFetch", { url: "https://example.com/b", method: "POST" }],
    ]);
    const starts = events.filter((e) => e.type === "tool_start") as Array<Extract<ProviderEvent, { type: "tool_start" }>>;
    expect(starts.map((e) => e.name)).toEqual(["opencode_execute", "WebFetch", "WebFetch"]);
    const script = starts[0]!;
    expect(script.input).toMatchObject({ code: expect.stringContaining("fetch(") });
    // Each fetch has its own card id, under the script's call.
    expect(new Set(starts.map((e) => e.toolId)).size).toBe(3);
    expect(starts[1]!.toolId.startsWith(`${script.toolId}:`)).toBe(true);
    const completes = events.filter((e) => e.type === "tool_complete") as Array<Extract<ProviderEvent, { type: "tool_complete" }>>;
    expect(completes.find((e) => e.sdkToolUseId === starts[1]!.toolId)?.success).toBe(true);
    expect(completes.find((e) => e.sdkToolUseId === script.toolId)).toMatchObject({ success: true, output: "200,rejected" });
    const st = await fakeState(server);
    expect(st.replies.map((r: { decision: string }) => r.decision)).toEqual(["once", "reject"]);
    expect(texts(events, "text_done")).toEqual(["fetched: 200,rejected"]);
    await p.teardown();
  });

  it("a turn whose end the feed dropped is read back from the session: its text, its spend, its outcome", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("gap")));
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(texts(events, "text_done")).toEqual(["before the gap", "said in the gap"]);
    const r = done(events)!;
    expect(r.stopReason).toBe("stop");
    // Both steps (0.0123 + 0.5) and the title (0.0007, billed in the gap), each once.
    expect(r.totalCostUsd).toBeCloseTo(0.0123 + 0.5 + 0.0007, 6);
    expect(r.nativeRef?.ref.startsWith("msg_")).toBe(true);
    // The session carries on normally after it.
    const next = await collect(p.runTurn(opts("hi")));
    expect(texts(next, "text_done")).toEqual(["Hello, world"]);
    expect(done(next)!.totalCostUsd).toBeCloseTo(0.0123, 6);
    await p.teardown();
  });

  it("a gap that closes while the execution runs: its result, text and spend are read back, once", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("midgap")));
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(texts(events, "text_done")).toEqual(["before the gap", "said in the gap", "after the gap"]);
    // The call settled in the gap: its card completes from the stored message.
    const call = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }>;
    expect(events.filter((e) => e.type === "tool_complete")).toEqual([
      { type: "tool_complete", sdkToolUseId: call.toolId, output: "shell ran: echo in-gap", success: true },
    ]);
    // Each step once: 0.0123 + 0.5 + 0.0123, and the title (booked as the execution ends).
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 + 0.5 + 0.0123 + 0.0007, 6);
    expect(events.filter((e) => e.type === "llm_call" && e.isPrimary)).toHaveLength(3);
    await p.teardown();
  });

  it("a block that ended in a gap closing mid-step is read again once its step ends", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("gap-open")));
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(texts(events, "text_done").sort()).toEqual(["after the gap", "said in the gap"]);
    await p.teardown();
  });

  it("a result read back after a gap, then delivered by a feed that's behind, settles once and isn't 'ran unasked'", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const generation = (await server.ensure()).generation;
    const events = await collect(p.runTurn(opts("lag-settle")));
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(texts(events, "text_done")).toEqual(["after the call", "after the lag"]);
    const call = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }>;
    expect(events.filter((e) => e.type === "tool_complete")).toEqual([
      { type: "tool_complete", sdkToolUseId: call.toolId, output: "shell ran: echo lagged", success: true },
    ]);
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.0007, 6);
    // The shared server wasn't stopped as one that runs tools unasked.
    expect((await server.ensure()).generation).toBe(generation);
    await p.teardown();
  });

  it("a permission asked in a gap is judged on the call opencode stored, not refused", async () => {
    const { server } = makeServer();
    const asked: Array<[string, Record<string, unknown>]> = [];
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("gap-ask", { canUseTool: allowing((name, input) => asked.push([name, input])) })));
    expect(asked).toEqual([["Bash", { command: "echo gap-ok", description: "x" }]]);
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: true });
    expect(texts(events, "text_done")).toEqual(["about to run a shell", "ran it"]);
    await p.teardown();
  });

  it("requests re-offered after a gap come after the reasoning that led to them, in the order they were made", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const events = await collect(p.runTurn(opts("gap-reason-ask")));
    const order = events.flatMap((e) => (e.type === "thinking_done" ? ["thinking_done"] : e.type === "tool_start" ? [`tool_start ${String(e.input.command)}`] : []));
    expect(order).toEqual(["thinking_done", "tool_start echo one", "tool_start echo two"]);
    expect(texts(events, "text_done")).toEqual(["ran both"]);
    expect(done(events)?.stopReason).toBe("stop");
    await p.teardown();
  });

  it("a subagent created in a feed gap is found again: its request is asked and answered, and the turn ends", async () => {
    const { server } = makeServer();
    const asks: Array<[string, string | undefined]> = [];
    const p = makeProvider(server);
    const run = p.runTurn(opts("subagent-gapstart", { canUseTool: allowing((name, _input, agentId) => asks.push([name, agentId])) }));
    const events = await Promise.race([collect(run), Bun.sleep(8_000).then(() => [] as ProviderEvent[])]);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const start = events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>;
    expect(start?.agentType).toBe("explore");
    expect(asks).toEqual([["Task", undefined], ["Bash", start.agentId]]);
    expect(events.some((e) => e.type === "subagent_stop" && e.agentId === start.agentId)).toBe(true);
    expect(texts(events, "text_done")).toEqual(["subagent done"]);
    // The parent's two steps and the child's; the title lands in this turn or the next.
    const next = await collect(p.runTurn(opts("hi")));
    expect(done(events)!.totalCostUsd + done(next)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.5 + 0.0123 + 0.0007, 6);
    await p.teardown();
  });

  it("a subagent created in a feed gap whose call ran unasked, read back after it, stops the server; its output isn't shown", async () => {
    // Created in the gap, the child runs with the server's environment until
    // codeoid learns of it: a command-less line expands a key unasked.
    const secret = "sk-fake-gap-secret";
    const { server, starts } = makeServer({ FAKE_GAP_PROBE_API_KEY: secret });
    const p = makeProvider(server);
    const asks: string[] = [];
    const line = "X=${UNSET_FAKE_VAR?$FAKE_GAP_PROBE_API_KEY}";
    const events = await Promise.race([collect(p.runTurn(opts(`subagent-gapunasked:${line}`, { canUseTool: allowing((name) => asks.push(name)) }))), Bun.sleep(8_000).then(() => [] as ProviderEvent[])]);
    expect(asks).toEqual(["Task"]);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect((last as Extract<ProviderEvent, { type: "error" }>).message).toContain("without asking codeoid");
    expect(JSON.stringify(events)).not.toContain(secret);
    // Stopped: the next turn starts a new server.
    expect(texts(await collect(p.runTurn(opts("hi"))), "text_done")).toEqual(["Hello, world"]);
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(2);
    await p.teardown();
  });

  it("a subagent that ends in a feed gap is read back: its card settles, its spend counts, it stops", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const events = await Promise.race([collect(p.runTurn(opts("subagent-gapend"))), Bun.sleep(8_000).then(() => [] as ProviderEvent[])]);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const start = events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>;
    const cards = events.filter((e) => e.type === "tool_start") as Array<Extract<ProviderEvent, { type: "tool_start" }>>;
    const childCard = cards.find((c) => c.sdkAgentId === start.agentId)!;
    expect(events.filter((e) => e.type === "tool_complete").map((e) => (e as { sdkToolUseId: string }).sdkToolUseId).sort()).toEqual(cards.map((c) => c.toolId).sort());
    expect(events.find((e) => e.type === "tool_complete" && e.sdkToolUseId === childCard.toolId)).toMatchObject({ success: true, output: "shell ran: grep -r auth ." });
    expect(events.some((e) => e.type === "subagent_stop" && e.agentId === start.agentId)).toBe(true);
    expect(texts(events, "text_done")).toEqual(["subagent done"]);
    // The parent's two steps and the child's, each once, and the title.
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.5 + 0.0007, 6);
    await p.teardown();
  });

  it("a background subagent that ends in a gap with no turn open settles, and opencode's follow-up in the gap is adopted", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const levels: unknown[] = [];
    const settled: unknown[] = [];
    const adopted: TurnRun[] = [];
    p.onSessionEvent = (e) => {
      if (e.type === "background_tasks") levels.push(e.tasks);
      if (e.type === "background_task_settled") settled.push(e);
      if (e.type === "turn_started") adopted.push(e.run);
    };
    const events = await collect(p.runTurn(opts("background-gap")));
    expect(texts(events, "text_done")).toEqual(["launched"]);
    for (let i = 0; i < 150 && adopted.length === 0; i++) await Bun.sleep(20);
    expect(settled).toMatchObject([{ status: "completed" }]);
    expect(levels.at(-1)).toEqual([]);
    expect(adopted).toHaveLength(1);
    const follow = await Promise.race([collect(adopted[0]!), Bun.sleep(3_000).then(() => [] as ProviderEvent[])]);
    expect(texts(follow, "text_done")).toEqual(["background result received"]);
    // The follow-up's step and the child's (read back with no turn open, carried); the launching turn reported the title.
    expect(done(follow)!.totalCostUsd).toBeCloseTo(0.0123 + 0.5, 6);
    await p.teardown();
  });

  it("a child session inherits its parent's rules, and still gets codeoid's set on it", async () => {
    const { server } = makeServer();
    const p = makeProvider(server, { sessionId: "sess-kid", initialBackingId: "sess-kid" });
    await collect(p.runTurn(opts("subagent")));
    const st = await fakeState(server);
    const child = st.sessions.find((x: { parentID?: string }) => x.parentID);
    expect(child.permissions).toEqual(sessionRules("sess-kid"));
    expect(st.patches.some((x: { sessionID: string }) => x.sessionID === child.id)).toBe(true);
    await p.teardown();
  });
});
