/**
 * GeminiAcpProvider tests — offline over the fake-acp fixture (newline
 * JSON-RPC subprocess; session/prompt resolves when the turn ends).
 *
 *   A1 text turn: thought + message chunks, turn_done (stopReason, zero usage)
 *   A2 permission ALLOW: canUseTool(Bash) → allow option → tool runs
 *   A3 permission DENY: reject option picked → tool never runs
 *   A4 non-gated tool_call/tool_call_update pair (Read, content-join output)
 *   A5 seedFromHistory prepends the structured transcript (one-shot)
 *   A6 interrupt → session/cancel → stopReason "cancelled"
 *   A7 unknown server→client request refused (fail closed)
 *   A8 missing binary error
 *   A9 lifecycle: ACP sessionId → backing id, reset/dispose, empty models
 *   +  resolution order & registry activation/unavailable/disabled
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAcpProvider } from "../daemon/providers/acp/index.js";
import { resolveGeminiCliCommand } from "../daemon/providers/acp/resolve.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import type { CodeoidConfig } from "../config.js";
import type { Store } from "../daemon/store.js";
import { MemoryMcpHttp, MEMORY_MCP_SERVER_NAME } from "../daemon/memory/mcp-http.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import type { RawMcpServerConfig } from "../config.js";
import { MemoryEngine } from "../daemon/memory/engine.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import type { Embedder } from "../daemon/memory/embedder.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-acp.ts");

function makeProvider(command = process.execPath, argsPrefix = [FIXTURE]): GeminiAcpProvider {
  return new GeminiAcpProvider({
    sessionId: "sess-1",
    initialBackingId: "sess-1",
    command,
    argsPrefix,
    store: {} as Store,
  });
}

function turnOpts(userMessage: string, overrides: Partial<TurnOpts> = {}): TurnOpts {
  return {
    history: [],
    userMessage,
    workdir: "/tmp",
    canUseTool: async () => ({ behavior: "allow" as const }),
    ...overrides,
  };
}

async function collect(run: TurnRun): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === "turn_done" || event.type === "error") break;
  }
  return events;
}

describe("GeminiAcpProvider over fake-acp", () => {
  it("A1: text turn streams thought + message chunks and completes", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("hello")));
    await p.teardown();

    expect(events.some((e) => e.type === "thinking_delta" && e.content === "pondering...")).toBe(true);
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { content: string }).content)
      .join("");
    expect(text).toBe("Hello ACP");
    const done = events.find((e) => e.type === "turn_done");
    expect(done).toBeDefined();
    if (done?.type === "turn_done") {
      expect(done.result.providerId).toBe("gemini-cli");
      expect(done.result.stopReason).toBe("end_turn");
      expect(done.result.inputTokens).toBe(0); // ACP carries no usage — honest zeros
    }
  });

  it("A2: permission request routes through canUseTool; allow runs the tool", async () => {
    const p = makeProvider();
    const gated: Array<{ name: string; input: Record<string, unknown> }> = [];
    const events = await collect(
      p.runTurn(
        turnOpts("please use-tool", {
          canUseTool: async (_id, _approvalId, toolName, input) => {
            gated.push({ name: toolName, input });
            return { behavior: "allow" as const };
          },
        }),
      ),
    );
    await p.teardown();

    expect(gated).toEqual([{ name: "Bash", input: { command: "rm -rf /tmp/scratch" } }]);
    const start = events.find((e) => e.type === "tool_start");
    expect(start && (start as { name: string }).name).toBe("Bash");
    const complete = events.find((e) => e.type === "tool_complete");
    expect(complete && (complete as { output: string }).output).toBe("removed");
    expect(events.some((e) => e.type === "text_done" || (e.type === "text_delta" && e.content === "Cleaned up."))).toBe(true);
  });

  it("A3: denial picks the reject option and the tool never runs", async () => {
    const p = makeProvider();
    const events = await collect(
      p.runTurn(
        turnOpts("please use-tool", {
          canUseTool: async () => ({ behavior: "deny" as const, message: "no" }),
        }),
      ),
    );
    await p.teardown();

    expect(events.some((e) => e.type === "tool_complete")).toBe(false);
    expect(
      events.some((e) => e.type === "text_delta" && e.content === "Permission refused; skipping."),
    ).toBe(true);
  });

  it("A4: non-gated tool_call/tool_call_update surfaces as a start+complete pair", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("auto-tool please")));
    await p.teardown();

    const start = events.find((e) => e.type === "tool_start");
    expect(start).toBeDefined();
    if (start?.type === "tool_start") {
      expect(start.name).toBe("Read");
      expect(start.input).toEqual({ path: "a.ts" });
    }
    const complete = events.find((e) => e.type === "tool_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "tool_complete") {
      expect(complete.output).toBe("export {}");
      expect(complete.success).toBe(true);
    }
  });

  it("A5: seedFromHistory prepends the structured transcript (one-shot)", async () => {
    const p = makeProvider();
    p.seedFromHistory([
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: "earlier answer",
        providerId: "claude",
        model: "opus",
        toolCalls: [
          { id: "t1", name: "run_shell", input: { command: "bun test" }, output: "1 pass", success: true },
        ],
      },
    ]);
    const events = await collect(p.runTurn(turnOpts("echo-prompt")));
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { content: string }).content)
      .join("");
    expect(text).toContain("<conversation-history>");
    expect(text).toContain("### Tool call: run_shell → ok");
    expect(text).toContain("echo-prompt");

    const second = await collect(p.runTurn(turnOpts("echo-prompt again")));
    const text2 = second
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { content: string }).content)
      .join("");
    expect(text2).not.toContain("<conversation-history>");
    await p.teardown();
  });

  it("A5b: delivers systemPromptAppend as a prompt preamble, re-sending only when it changes (pipeline role swap)", async () => {
    const p = makeProvider();
    const textOfEvents = (evts: ProviderEvent[]): string =>
      evts.filter((e) => e.type === "text_delta").map((e) => (e as { content: string }).content).join("");
    // ACP/gemini-cli has no system-prompt channel, so the pack constitution +
    // role contract must ride the prompt text — else a reviewer phase's role
    // would be silently dropped on this backend.
    const t1 = textOfEvents(
      await collect(p.runTurn(turnOpts("echo-prompt", { systemPromptAppend: "ROLE: read-only reviewer" }))),
    );
    expect(t1).toContain("ROLE: read-only reviewer");
    expect(t1.indexOf("ROLE: read-only reviewer")).toBeLessThan(t1.indexOf("echo-prompt"));
    // Same append next turn → not re-sent (a stable session delivers it once).
    const t2 = textOfEvents(
      await collect(p.runTurn(turnOpts("echo-prompt", { systemPromptAppend: "ROLE: read-only reviewer" }))),
    );
    expect(t2).not.toContain("ROLE: read-only reviewer");
    // Changed append (a pipeline phase swapped the role) → re-delivered.
    const t3 = textOfEvents(
      await collect(p.runTurn(turnOpts("echo-prompt", { systemPromptAppend: "ROLE: implementer" }))),
    );
    expect(t3).toContain("ROLE: implementer");
    await p.teardown();
  });

  it("A6: interrupt sends session/cancel and the turn ends cancelled", async () => {
    const p = makeProvider();
    const run = p.runTurn(turnOpts("hang-forever"));
    await new Promise((r) => setTimeout(r, 300));
    await run.interrupt();
    const events = await collect(run);
    await p.teardown();

    const done = events.find((e) => e.type === "turn_done");
    expect(done).toBeDefined();
    if (done?.type === "turn_done") expect(done.result.stopReason).toBe("cancelled");
  });

  it("A7: unknown server→client requests are refused (fail closed)", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("unknown-request")));
    await p.teardown();
    expect(events.some((e) => e.type === "text_delta" && e.content === "server-request-errored")).toBe(true);
  });

  it("A10: authenticate fallback — auth-required session/new retries after selecting OAuth", async () => {
    // Mirrors real gemini-cli with ~/.gemini/oauth_creds.json but no
    // settings.json: session/new rejects until `authenticate` runs.
    process.env.GEMINI_FAKE_REQUIRE_AUTH = "1";
    try {
      const p = makeProvider();
      const events = await collect(p.runTurn(turnOpts("hello")));
      await p.teardown();
      const done = events.find((e) => e.type === "turn_done");
      expect(done).toBeDefined(); // turn succeeded despite the auth gate
      expect(events.some((e) => e.type === "error")).toBe(false);
    } finally {
      delete process.env.GEMINI_FAKE_REQUIRE_AUTH;
    }
  });

  it("A8: a missing gemini binary surfaces a clear error", async () => {
    const p = makeProvider("/nonexistent/gemini-binary", []);
    const events = await collect(p.runTurn(turnOpts("hello")));
    await p.teardown();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("A9: lifecycle — ACP sessionId becomes the backing id; reset/dispose", async () => {
    const p = makeProvider();
    expect(p.hasQueried).toBe(false);
    expect(p.queuedMessages).toBe(0);
    await collect(p.runTurn(turnOpts("hello")));
    expect(p.hasQueried).toBe(true);
    expect(p.backingSessionId).toBe("acp-session-1");
    expect(await p.listModels()).toEqual([]); // ACP has no model catalog

    p.setHasQueried(false);
    expect(p.hasQueried).toBe(false);
    p.resetToNewSession("fresh");
    expect(p.backingSessionId).toBe("fresh");
    await p.dispose();
  });
});

// ── #178 Phase 2: VWS memory mount over the shared HTTP endpoint ───────────────

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (const ch of t.toLowerCase()) {
        const c = ch.charCodeAt(0);
        if (c >= 97 && c <= 122) v[(c - 97) % this.dimensions]! += 1;
      }
      return v;
    });
  }
  async close(): Promise<void> {}
}

async function makeEndpoint(): Promise<{ endpoint: MemoryMcpHttp; engine: MemoryEngine }> {
  const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await engine.init();
  return { endpoint: new MemoryMcpHttp(engine), engine };
}

const MOUNT_URL = "http://127.0.0.1:65535/mcp/memory";

function makeProviderWithMount(endpoint: MemoryMcpHttp): GeminiAcpProvider {
  return new GeminiAcpProvider({
    sessionId: "sess-1",
    initialBackingId: "sess-1",
    command: process.execPath,
    argsPrefix: [FIXTURE],
    store: {} as Store,
    workspaceId: "wsX",
    memoryMcp: { endpoint, url: MOUNT_URL },
  });
}

function textOf(events: ProviderEvent[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { content: string }).content)
    .join("");
}

describe("GeminiAcpProvider — VWS memory mount (#178 Phase 2)", () => {
  it("supportsMemoryTools is false without a mount, true with one", async () => {
    expect(makeProvider().supportsMemoryTools).toBe(false);
    const { endpoint, engine } = await makeEndpoint();
    expect(makeProviderWithMount(endpoint).supportsMemoryTools).toBe(true);
    await engine.close();
  });

  it("mounts the shared endpoint as an ACP http MCP server with a bearer token", async () => {
    const { endpoint, engine } = await makeEndpoint();
    const p = makeProviderWithMount(endpoint);
    const events = await collect(p.runTurn(turnOpts("echo-mcp")));
    const raw = textOf(events).replace(/^MCP:/, "");
    const servers = JSON.parse(raw) as Array<{ type: string; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
    expect(servers).toHaveLength(1);
    expect(servers[0]!.type).toBe("http");
    expect(servers[0]!.name).toBe(MEMORY_MCP_SERVER_NAME);
    expect(servers[0]!.url).toBe(MOUNT_URL);
    const authHeader = servers[0]!.headers.find((h) => h.name.toLowerCase() === "authorization");
    expect(authHeader?.value).toMatch(/^Bearer mmt_/);
    // A live token is scoped for this session; teardown revokes it.
    expect(endpoint.activeTokens).toBe(1);
    await p.teardown();
    expect(endpoint.activeTokens).toBe(0);
    await engine.close();
  });

  it("mounts NO servers when memory is absent (unchanged behavior)", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("echo-mcp")));
    expect(textOf(events)).toBe("MCP:[]");
    await p.teardown();
  });

  it("mounts registry external servers on session/new (http + stdio ACP shapes)", async () => {
    const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
      ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p }) as RawMcpServerConfig;
    const reg = new McpRegistry(
      {
        linear: raw({ url: "https://mcp.linear.app/mcp", bearerTokenEnv: "LINEAR_KEY" }),
        ghstdio: raw({ command: "npx", args: ["-y", "@mcp/gh"] }),
      },
      { memoryEnabled: false },
    );
    const p = new GeminiAcpProvider({
      sessionId: "sess-1",
      initialBackingId: "sess-1",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: {} as Store,
      mcpRegistry: reg,
    });
    const events = await collect(p.runTurn(turnOpts("echo-mcp")));
    await p.teardown();
    const servers = JSON.parse(textOf(events).replace(/^MCP:/, "")) as Array<Record<string, unknown>>;
    const http = servers.find((s) => s.name === "linear");
    expect(http?.type).toBe("http");
    expect(http?.url).toBe("https://mcp.linear.app/mcp");
    const stdio = servers.find((s) => s.name === "ghstdio");
    expect(stdio?.command).toBe("npx");
    expect(stdio?.args).toEqual(["-y", "@mcp/gh"]);
  });

  it("seedText prepends the strategy block (session map) to the next prompt", async () => {
    const { endpoint, engine } = await makeEndpoint();
    const p = makeProviderWithMount(endpoint);
    p.seedText("<session_map>PAGE-TABLE</session_map>");
    const events = await collect(p.runTurn(turnOpts("echo-prompt")));
    const text = textOf(events);
    expect(text).toContain("<session_map>PAGE-TABLE</session_map>");
    expect(text).toContain("echo-prompt");
    expect(text.indexOf("PAGE-TABLE")).toBeLessThan(text.indexOf("echo-prompt"));
    await p.teardown();
    await engine.close();
  });
});

describe("gemini-cli resolution + registry", () => {
  it("resolution order and registry states", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-acp-resolve-"));
    try {
      // Explicit path override.
      const bin = join(tmp, "my-gemini");
      writeFileSync(bin, "#!/bin/sh\necho fake\n");
      chmodSync(bin, 0o755);
      expect(resolveGeminiCliCommand(bin, { PATH: "" })).toEqual({
        command: bin,
        argsPrefix: [],
        source: "config",
      });
      expect(resolveGeminiCliCommand(join(tmp, "nope"), { PATH: "" })).toBeNull();
      expect(resolveGeminiCliCommand("my-gemini", { PATH: tmp })?.source).toBe("config");

      // System gemini on PATH beats the bundle.
      const sys = join(tmp, "gemini");
      writeFileSync(sys, "#!/bin/sh\necho fake\n");
      chmodSync(sys, 0o755);
      expect(resolveGeminiCliCommand(undefined, { PATH: tmp })).toEqual({
        command: sys,
        argsPrefix: [],
        source: "path",
      });

      // Bundled fallback (no gemini on PATH — true on this machine and CI).
      const bundled = resolveGeminiCliCommand(undefined, { PATH: "" });
      expect(bundled?.source).toBe("bundled");
      expect(bundled?.command).toBe(process.execPath);
      expect(bundled?.argsPrefix[0]).toEndWith("gemini.js");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // Registry: bundled activation by default; hint on bogus override; disabled.
    expect(createDefaultProviderRegistry().has("gemini-cli")).toBe(true);
    const withBogus = createDefaultProviderRegistry({
      providers: {
        pi: { enabled: false, command: "pi" },
        codex: { enabled: false, command: "codex" },
        geminiCli: { enabled: true, command: "/definitely/missing/gemini" },
      },
    } as unknown as CodeoidConfig);
    expect(withBogus.has("gemini-cli")).toBe(false);
    expect(withBogus.unavailableHint("gemini-cli")).toContain("providers.geminiCli.command");
    const disabled = createDefaultProviderRegistry({
      providers: {
        pi: { enabled: false, command: "pi" },
        codex: { enabled: false, command: "codex" },
        geminiCli: { enabled: false, command: "gemini" },
      },
    } as unknown as CodeoidConfig);
    expect(disabled.has("gemini-cli")).toBe(false);
    expect(disabled.unavailableHint("gemini-cli")).toBeUndefined();
  });

  it("live smoke: the bundled gemini-cli runs under the daemon runtime", async () => {
    const bundled = resolveGeminiCliCommand(undefined, { PATH: "" });
    expect(bundled).not.toBeNull();
    const proc = Bun.spawn([bundled!.command, ...bundled!.argsPrefix, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
    // Cold-starting the bundled gemini-cli (a large JS bundle bun must parse
    // and run) costs 3-4s on its own, which fits inside the 5s default only
    // when the machine is idle. Under the full suite's parallel load it tips
    // over, so this test failed ~2 runs in 3 while the CLI itself was fine.
    // The generous ceiling keeps it a real smoke test without the flake.
  }, 30_000);
});
