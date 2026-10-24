/**
 * PiProvider integration tests — run against the fake-pi RPC fixture
 * (src/tests/fixtures/fake-pi.ts) through a wrapper script, so the whole
 * pipeline (spawn → JSONL framing → bridge approvals → dialogs → turn
 * accounting) is exercised offline with no pi install.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../daemon/store.js";
import { PiProvider, piThinkingLevels } from "../daemon/providers/pi/index.js";
import type {
  ProviderEvent,
  ToolApprovalFn,
  TurnOpts,
  UiRequestFn,
} from "../daemon/providers/interface.js";
import { MemoryEngine } from "../daemon/memory/engine.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import type { Embedder } from "../daemon/memory/embedder.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { McpHub } from "../daemon/mcp/hub.js";
import type { RawMcpServerConfig } from "../config.js";

const MCP_FIXTURE = resolve(import.meta.dir, "fixtures/fake-mcp-stdio.ts");

let wrapperDir: string;
let fakePi: string;
let fakePiNoBridge: string;

beforeAll(() => {
  // `providers.pi.command` is a single binary path, so wrap `bun fake-pi.ts`
  // in tiny shell scripts (one per env knob).
  wrapperDir = mkdtempSync(join(tmpdir(), "codeoid-fake-pi-"));
  const fixture = resolve(import.meta.dir, "fixtures/fake-pi.ts");
  const bunBin = process.execPath;
  fakePi = join(wrapperDir, "fake-pi");
  writeFileSync(fakePi, `#!/bin/sh\nexec "${bunBin}" "${fixture}" "$@"\n`);
  chmodSync(fakePi, 0o755);
  fakePiNoBridge = join(wrapperDir, "fake-pi-no-bridge");
  writeFileSync(
    fakePiNoBridge,
    `#!/bin/sh\nFAKE_PI_NO_BRIDGE=1 exec "${bunBin}" "${fixture}" "$@"\n`,
  );
  chmodSync(fakePiNoBridge, 0o755);
});

afterAll(() => {
  try {
    rmSync(wrapperDir, { recursive: true, force: true });
  } catch {}
});

let tmp: string;
let store: Store;
let provider: PiProvider | null;

let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-pi-test-"));
  store = new Store(join(tmp, "codeoid.db"));
  provider = null;
  // pi runs from an overlay of its agent dir under codeoid's config (#417):
  // both kept in the test's own directory, never the user's.
  savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
  process.env.PI_CODING_AGENT_DIR = join(tmp, "pi-agent");
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await provider?.teardown();
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

const allowAll: ToolApprovalFn = async (_toolId, _approvalId, _toolName, input) => ({
  behavior: "allow",
  updatedInput: input,
});

function makeProvider(command = fakePi): PiProvider {
  store.createSession({
    id: "sess-pi",
    name: "pi-test",
    workdir: tmp,
    status: "idle",
    createdBy: "u",
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: "acc",
    projectId: "proj",
  });
  provider = new PiProvider({
    sessionId: "sess-pi",
    initialBackingId: "sess-pi",
    command,
    store,
  });
  return provider;
}

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (const ch of t.toLowerCase()) { const c = ch.charCodeAt(0); if (c >= 97 && c <= 122) v[(c - 97) % 8]! += 1; }
      return v;
    });
  }
  async close(): Promise<void> {}
}

async function memoryWithEpisode(): Promise<MemoryEngine> {
  const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await engine.init();
  engine.ingest({
    workspaceId: "ws_pi", sessionId: "sOld", kind: "user_turn", summary: "unicorn",
    content: "alpha unicorn deployment", filePaths: [], tokenEstimate: 4, createdAt: 1_000_000, createdBy: "test",
  });
  await engine.drain();
  return engine;
}

function makeProviderWithMemory(memory: MemoryEngine, command = fakePi): PiProvider {
  store.createSession({
    id: "sess-pi", name: "pi-test", workdir: tmp, status: "idle", createdBy: "u",
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: "acc", projectId: "proj",
  });
  provider = new PiProvider({
    sessionId: "sess-pi",
    initialBackingId: "sess-pi",
    command,
    store,
    workspaceId: "ws_pi",
    memory,
  });
  return provider;
}

function turnOpts(
  message: string,
  overrides: Partial<TurnOpts> = {},
): TurnOpts {
  return {
    history: [],
    userMessage: message,
    workdir: tmp,
    canUseTool: allowAll,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("PiProvider", () => {
  it("T1: streams a text turn and settles with per-turn usage", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("hello")).events);

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.map((d) => (d as { content: string }).content)).toEqual(["Hello ", "world"]);
    expect(events.some((e) => e.type === "text_done" && e.content === "Hello world")).toBe(true);

    const done = events.find((e) => e.type === "turn_done");
    expect(done).toBeDefined();
    if (done?.type === "turn_done") {
      expect(done.result.providerId).toBe("pi");
      // fake-pi reports cumulative 100/40 after turn 1 — delta from 0.
      expect(done.result.inputTokens).toBe(100);
      expect(done.result.outputTokens).toBe(40);
      expect(done.result.totalCostUsd).toBeCloseTo(0.01);
      expect(done.result.stopReason).toBe("stop");
      // pi states its window on the stats call codeoid already makes every
      // turn (`contextUsage.contextWindow`); it was being dropped, leaving pi
      // on a model-id guess of 200k for a 1M Gemini.
      expect(done.result.contextWindow).toBe(1_048_576);
    }

    // The pi session file became the persisted backing id.
    expect(p.backingSessionId.endsWith(".jsonl")).toBe(true);
    expect(store.getClaudeCodeSessionId("sess-pi")).toBe(p.backingSessionId);
  });

  it("T2: routes tools through the bridge gate and applies input patches", async () => {
    const p = makeProvider();
    const gated: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const canUseTool: ToolApprovalFn = async (_id, _approvalId, toolName, input) => {
      gated.push({ toolName, input });
      return { behavior: "allow", updatedInput: { ...input, extra: "patched" } };
    };

    const events = await collect(p.runTurn(turnOpts("use-tool", { canUseTool })).events);

    expect(gated).toEqual([{ toolName: "bash", input: { command: "echo hi" } }]);
    const start = events.find((e) => e.type === "tool_start");
    expect(start).toBeDefined();
    if (start?.type === "tool_start") {
      expect(start.name).toBe("bash");
      expect(start.approvalId.length).toBeGreaterThan(0);
    }
    const complete = events.find((e) => e.type === "tool_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "tool_complete") {
      expect(complete.success).toBe(true);
      // fake-pi echoes the EFFECTIVE input — proves the patch reached pi.
      expect(complete.output).toContain('"extra":"patched"');
    }
  });

  it("T3: a denial blocks the tool inside pi", async () => {
    const p = makeProvider();
    const canUseTool: ToolApprovalFn = async () => ({
      behavior: "deny",
      message: "not on my watch",
    });
    const events = await collect(p.runTurn(turnOpts("use-tool", { canUseTool })).events);
    const complete = events.find((e) => e.type === "tool_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "tool_complete") {
      expect(complete.success).toBe(false);
    }
  });

  it("T4: pi extension dialogs route through requestUserInput", async () => {
    const p = makeProvider();
    const seen: Array<{ method: string; title: string }> = [];
    const requestUserInput: UiRequestFn = async (req) => {
      seen.push({ method: req.method, title: req.title });
      return { confirmed: true, cancelled: false };
    };
    const events = await collect(
      p.runTurn(turnOpts("ask-user", { requestUserInput })).events,
    );
    expect(seen).toEqual([{ method: "confirm", title: "Deploy?" }]);
    expect(
      events.some((e) => e.type === "text_done" && e.content.includes("confirmed=true")),
    ).toBe(true);
  });

  it("T5: extension notifications surface as custom messages", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("notify")).events);
    const notice = events.find((e) => e.type === "custom_message");
    expect(notice).toBeDefined();
    if (notice?.type === "custom_message") {
      expect(notice.content).toBe("extension says hi");
      expect(notice.metadata?.kind).toBe("notify");
    }
  });

  it("T6: exposes pi's command catalog and model list once warm", async () => {
    const p = makeProvider();
    await collect(p.runTurn(turnOpts("hello")).events);

    const commands = await p.listCommands();
    expect(commands.map((c) => c.name)).toEqual(["review", "skill:websearch"]);
    expect(commands[0]!.source).toBe("extension");

    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
  });

  it("T7: an ungated tool execution is flagged loudly", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("ungated-tool")).events);
    const warning = events.find(
      (e) => e.type === "custom_message" && e.role === "system",
    );
    expect(warning).toBeDefined();
    if (warning?.type === "custom_message") {
      expect(warning.content).toContain("WITHOUT passing codeoid's approval gate");
    }
  });

  it("T8: fails CLOSED when the bridge never initializes", async () => {
    const p = makeProvider(fakePiNoBridge);
    const events = await collect(p.runTurn(turnOpts("hello")).events);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type === "error") {
      expect(error.message).toContain("bridge extension did not initialize");
    }
  });

  it("T9: a missing pi binary surfaces a clear error", async () => {
    const p = makeProvider("/nonexistent/pi-binary");
    const events = await collect(p.runTurn(turnOpts("hello")).events);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("T11: seedFromHistory prepends the rendered transcript to the next prompt", async () => {
    const p = makeProvider();
    p.seedFromHistory([
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: "earlier answer",
        providerId: "claude",
        model: "opus",
        toolCalls: [
          {
            id: "toolu_01",
            name: "run_shell",
            input: { command: "bun test" },
            output: "1 pass",
            success: true,
          },
        ],
      },
    ]);
    const events = await collect(p.runTurn(turnOpts("echo-prompt")).events);
    const done = events.find((e) => e.type === "text_done");
    expect(done).toBeDefined();
    if (done?.type === "text_done") {
      // fake-pi reflects the full received prompt — the seed reached pi.
      expect(done.content).toContain("<conversation-history>");
      expect(done.content).toContain("earlier question");
      expect(done.content).toContain("earlier answer");
      // Claude→pi round-trip carries STRUCTURED tool history, not the old
      // one-line "[Tool: …]" flattening.
      expect(done.content).toContain("### Tool call: run_shell → ok");
      expect(done.content).toContain(`input: {"command":"bun test"}`);
      expect(done.content).not.toContain("[Tool:");
      expect(done.content).toContain("echo-prompt");
    }

    // The seed is one-shot: the following prompt goes through clean.
    const second = await collect(p.runTurn(turnOpts("echo-prompt again")).events);
    const done2 = second.find((e) => e.type === "text_done");
    if (done2?.type === "text_done") {
      expect(done2.content).not.toContain("<conversation-history>");
    }
  });

  it("T10: second turn reports usage as a DELTA, not the cumulative total", async () => {
    const p = makeProvider();
    await collect(p.runTurn(turnOpts("hello")).events);
    const events = await collect(p.runTurn(turnOpts("hello again")).events);
    const done = events.find((e) => e.type === "turn_done");
    if (done?.type === "turn_done") {
      // Cumulative after turn 2 is 200/80; the turn must report 100/40.
      expect(done.result.inputTokens).toBe(100);
      expect(done.result.outputTokens).toBe(40);
    } else {
      throw new Error("no turn_done");
    }
  });
});

describe("PiProvider – memory tools (#178 Phase 4)", () => {
  it("supportsMemoryTools reflects whether a memory engine is wired", () => {
    expect(makeProvider().supportsMemoryTools).toBe(false);
  });

  it("with memory: supportsMemoryTools is true and seedText stashes a block", async () => {
    const engine = await memoryWithEpisode();
    const p = makeProviderWithMemory(engine);
    expect(p.supportsMemoryTools).toBe(true);
    // seedText is the VWS transport hook (prepended to the next prompt).
    expect(() => p.seedText("<session_map>MAP</session_map>")).not.toThrow();
    await p.teardown();
    await engine.close();
  });

  it("routes a bridge memory-tool call to the daemon engine and returns verbatim content", async () => {
    const engine = await memoryWithEpisode();
    const p = makeProviderWithMemory(engine);
    // The fake-pi "recall-tool" scenario emits a codeoid:memory-tool ui-request;
    // PiProvider runs the recall def and answers — the fixture echoes it back.
    const events = await collect(p.runTurn(turnOpts("recall-tool please")).events);
    await p.teardown();
    const text = events
      .filter((e) => e.type === "text_delta" || e.type === "text_done")
      .map((e) => (e as { content: string }).content)
      .join("");
    expect(text).toContain("RECALL:");
    expect(text).toContain("alpha unicorn deployment");
    await engine.close();
  });

  it("routes a bridge external-MCP call to the daemon hub and returns the tool result", async () => {
    const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
      ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p }) as RawMcpServerConfig;
    const reg = new McpRegistry({ local: raw({ command: process.execPath, args: [MCP_FIXTURE] }) }, { memoryEnabled: false });
    const hub = new McpHub({ daemonEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
    store.createSession({
      id: "sess-pi", name: "pi-test", workdir: tmp, status: "idle", createdBy: "u",
      createdAt: new Date().toISOString(), attachedClients: 0, accountId: "acc", projectId: "proj",
    });
    provider = new PiProvider({
      sessionId: "sess-pi", initialBackingId: "sess-pi", command: fakePi, store, workspaceId: "ws_pi",
      mcpRegistry: reg, mcpHub: hub,
    });
    const events = await collect(provider.runTurn(turnOpts("mcp-tool please")).events);
    await provider.teardown();
    hub.closeAll();
    const text = events
      .filter((e) => e.type === "text_delta" || e.type === "text_done")
      .map((e) => (e as { content: string }).content)
      .join("");
    expect(text).toContain('MCP:echo:{"msg":"hi"}');
  });
});

describe("PiProvider – thinking effort (#417)", () => {
  const said = (events: ProviderEvent[]) => (events.find((e) => e.type === "text_done") as { content: string } | undefined)?.content;

  it("sets pi's thinking level per turn, live between turns, and back to pi's own for the default", async () => {
    const p = makeProvider();
    expect(said(await collect(p.runTurn(turnOpts("echo-thinking", { effort: "high" })).events))).toBe("thinking:high");
    expect(await p.applyEffort("low")).toBe(true);
    expect(said(await collect(p.runTurn(turnOpts("echo-thinking", { effort: "low" })).events))).toBe("thinking:low");
    expect(said(await collect(p.runTurn(turnOpts("echo-thinking")).events))).toBe("thinking:medium"); // pi's own default
    await p.teardown();
  });

  it("reports which levels each model takes, as pi-ai decides them", () => {
    expect(piThinkingLevels({ reasoning: false })).toEqual(["off"]);
    expect(piThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(piThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "x", max: "m" } })).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("PiProvider – thinking effort stays in the session (#417)", () => {
  it("Default is the user's own pi default; pi's writes of a level never reach their settings", async () => {
    const agent = join(tmp, "pi-agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", theme: "dark" }));
    writeFileSync(join(agent, "auth.json"), "{}");
    const p = makeProvider();
    expect((await collect(p.runTurn(turnOpts("echo-thinking", { effort: "xhigh" })).events)).find((e) => e.type === "text_done")).toMatchObject({ content: "thinking:xhigh" });
    expect((await collect(p.runTurn(turnOpts("echo-thinking")).events)).find((e) => e.type === "text_done")).toMatchObject({ content: "thinking:low" });
    await p.teardown();
    // pi ran from an overlay: its own settings copy, the user's logins linked.
    expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))).toEqual({ defaultThinkingLevel: "low", theme: "dark" });
    const overlayRoot = join(tmp, "xdg", "codeoid", "accounts", "pi-session");
    const [overlay] = readdirSync(overlayRoot);
    expect(lstatSync(join(overlayRoot, overlay!, "auth.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(overlayRoot, overlay!, "settings.json")).isSymbolicLink()).toBe(false);
  });
});

describe("PiProvider – thinking effort across a model change (#417)", () => {
  it("sends the level again after a model change, which re-applies pi's own", async () => {
    const p = makeProvider();
    await collect(p.runTurn(turnOpts("echo-thinking", { effort: "xhigh" })).events);
    const after = await collect(p.runTurn(turnOpts("echo-thinking", { effort: "xhigh", model: "openai/gpt-5" })).events);
    expect(after.find((e) => e.type === "text_done")).toMatchObject({ content: "thinking:xhigh" });
    await p.teardown();
  });
});
