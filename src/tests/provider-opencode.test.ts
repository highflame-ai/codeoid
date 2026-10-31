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
 *   O10 subagents (foreground and background, turn_started)
 *   O11 questions (forms) → requestUserInput; cancel = no answer
 *   O12 steering a running turn; later = queue
 *   O13 version range; agent check; saved approvals swept
 *   O14 database location, registry available / unavailable / disabled
 *   O15 what real 2.2.2 / 2.2.5 servers showed: the feed is the only record
 *       (the durable log replays nothing), the title is billed without a
 *       step, a dropped feed is read back
 *
 * See provider-opencode.integration.test.ts for a real `opencode` binary.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeServer, OpencodeIncompatibleError } from "../daemon/providers/opencode/server.js";
import { buildOpencodeEnv, opencodeConfig, ownMountPrefix, sessionRules, survivingAllows, unsafeAgents } from "../daemon/providers/opencode/policy.js";
import { OPENCODE_INSTALL_HINT, opencodeDbPath, opencodeVersionProblem, resolveOpencodeCommand } from "../daemon/providers/opencode/resolve.js";
import { effortOfVariant, gateCallFor, parseModelValue } from "../daemon/providers/opencode/translate.js";
import { parseSse } from "../daemon/providers/opencode/client.js";
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
    expect(st.config.permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
    expect(st.config.plugins).toEqual(["-opencode.tools", "-opencode.tool.schedule"]);
    expect(st.config.update).toBe("disable");
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
    const calls = events.filter((e) => e.type === "llm_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ isPrimary: true, usage: { inputTokens: 100, cacheReadTokens: 30, cacheCreationTokens: 10, outputTokens: 25 } });
    const r = done(events)!;
    expect(r.totalCostUsd).toBeCloseTo(0.0246, 6);
    expect(r).toMatchObject({ providerId: "opencode", inputTokens: 200, outputTokens: 50, cacheReadTokens: 60, cacheCreationTokens: 20, contextWindow: 200_000 });
    expect(r.nativeRef?.backingId.startsWith("ses_")).toBe(true);
    expect(r.nativeRef?.ref.startsWith("msg_")).toBe(true);
  });

  it("bills the title opencode generates, which only its running total reports", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    const first = await collect(p.runTurn(opts("hi")));
    expect(done(first)!.totalCostUsd).toBeCloseTo(0.0123, 6);
    // The title is billed after the first execution ended: it lands in the next turn.
    const second = await collect(p.runTurn(opts("hi again")));
    expect(done(second)!.totalCostUsd).toBeCloseTo(0.0123 + 0.0007, 6);
    const side = second.filter((e) => e.type === "llm_call" && !e.isPrimary);
    expect(side).toEqual([{ type: "llm_call", usage: { inputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 6 }, isPrimary: false }]);
    // Only once: the running total after it adds nothing more.
    const third = await collect(p.runTurn(opts("and again")));
    expect(done(third)!.totalCostUsd).toBeCloseTo(0.0123, 6);
    await p.teardown();
  });

  it("stops at maxBudgetUsd mid-turn, as the spend lands", async () => {
    const { server } = makeServer();
    const events = await collect(makeProvider(server).runTurn(opts("costly", { maxBudgetUsd: 3 })));
    const r = done(events)!;
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toBe(BUDGET_STOP_MESSAGE);
    expect(events.filter((e) => e.type === "llm_call").length).toBeLessThan(3);
    const st = await fakeState(server);
    expect(st.interrupts).toHaveLength(1);
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

  it("session rules deny every codeoid mount but the session's own", () => {
    const rules = sessionRules("sess-1");
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    expect(rules[1]).toEqual({ action: "coid*", resource: "*", effect: "deny" });
    expect(rules[2]).toEqual({ action: `${ownMountPrefix("sess-1")}*`, resource: "*", effect: "ask" });
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
    expect(done(events)!.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.5, 6);
    // The child is held to codeoid's rules too.
    const st = await fakeState(server);
    expect(st.patches.some((x: { sessionID: string; permissions?: unknown }) => x.sessionID === start.agentId && x.permissions)).toBe(true);
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
    // The child's spend and the first prompt's title (billed after that turn ended), carried.
    expect(done(follow)!.totalCostUsd).toBeCloseTo(0.0123 + 0.5 + 0.0007, 6);
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
});

// ── commands, fork ───────────────────────────────────────────────────────────

describe("opencode commands and fork", () => {
  it("lists commands and skills, and runs them", async () => {
    const { server } = makeServer();
    const p = makeProvider(server);
    await collect(p.runTurn(opts("hi")));
    const cmds = await p.listCommands();
    expect(cmds).toEqual([
      { name: "review", description: "Review changes", source: "command" },
      { name: "noop", description: "Does nothing", source: "command" },
      { name: "deploy", description: "Deploy it", source: "skill" },
    ]);
    const review = await collect(p.runTurn(opts("/review the diff")));
    expect(texts(review, "text_done")).toEqual(["Hello, world"]);
    const noop = await collect(p.runTurn(opts("/noop")));
    expect(done(noop)).toBeDefined();
    await collect(p.runTurn(opts("/deploy now")));
    const st = await fakeState(server);
    expect(st.commands).toMatchObject([{ name: "review", text: "the diff" }, { name: "noop", text: "" }]);
    expect(st.prompts.at(-1)).toMatchObject({ text: "now", skills: [{ id: "skl_1" }] });
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

  it("without a native point, continueNatively declines (transcript seed)", async () => {
    const { server } = makeServer();
    expect(await makeProvider(server).continueNatively({ history: [], maxChars: 1000, workdir: "/tmp" })).toBeNull();
  });
});

// ── O13 version range, agent check, saved approvals ─────────────────────────

describe("opencode version and safety checks", () => {
  it("accepts 2.2.x only", () => {
    expect(opencodeVersionProblem("2.2.2")).toBeNull();
    expect(opencodeVersionProblem("2.2.10-beta.1")).toBeNull();
    expect(opencodeVersionProblem("1.4.0")).toContain("1.x");
    expect(opencodeVersionProblem("2.3.0")).toContain("2.2.x");
    expect(opencodeVersionProblem("2.1.9")).toContain("predates");
    expect(opencodeVersionProblem("local")).toContain("can't read");
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
