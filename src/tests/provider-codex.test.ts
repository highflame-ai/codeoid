/**
 * CodexProvider tests — offline over the fake-codex fixture (newline
 * JSON-RPC subprocess, same pattern as fake-pi).
 *
 *   C1  text turn: thinking + text deltas, text_done, turn_done with usage
 *   C2  approval APPROVED: server request → tool_start → canUseTool(Bash,
 *       command input) → fixture sees "approved" → tool_complete
 *   C3  approval DENIED: decision "denied" reaches codex; no tool_complete
 *   C4  non-gated item: retrospective tool_start/tool_complete pair
 *   C5  seedFromHistory: first prompt carries the structured transcript
 *   C6  requestUserInput: select question round-trips the picked option
 *   C7  missing binary surfaces a clear error
 *   C8  model/list maps to ModelInfo
 *   C9  resolveCodexCommand: config → PATH → null (+ registry hint)
 *   C13 default policies: untrusted + {type:dangerFullAccess} on thread & turn
 *   C14 CODEX_APPROVAL_POLICY / CODEX_SANDBOX_POLICY env overrides (tagged)
 *   C15 unknown env policy value → safe default fallback
 *   C16 read-only maps to the tagged readOnly variant
 *   C17 shared validator rejects the bare-string sandboxPolicy (regression guard)
 *
 * See provider-codex.integration.test.ts for opt-in tests against the REAL
 * `codex app-server` binary (wire-shape acceptance + end-to-end execution).
 */

import { describe, it, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpcProcess } from "../daemon/providers/codex/rpc.js";
import { CodexProvider, describeCodexError } from "../daemon/providers/codex/index.js";
import { MemoryMcpHttp, MEMORY_MCP_SERVER_NAME } from "../daemon/memory/mcp-http.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import type { RawMcpServerConfig } from "../config.js";
import { MemoryEngine } from "../daemon/memory/engine.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import type { Embedder } from "../daemon/memory/embedder.js";
import { sandboxPolicyError } from "./fixtures/fake-codex-validate.js";
import { compareNodeVersionsDesc, resolveCodexCommand } from "../daemon/providers/codex/resolve.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import type { CodeoidConfig } from "../config.js";
import type { Store } from "../daemon/store.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex.ts");

function makeProvider(command = process.execPath, argsPrefix = [FIXTURE]): CodexProvider {
  return new CodexProvider({
    sessionId: "sess-1",
    initialBackingId: "sess-1", // first run — provider starts a fresh thread
    command,
    argsPrefix,
    store: {} as Store, // not consulted in this slice
  });
}

function turnOpts(
  userMessage: string,
  overrides: Partial<TurnOpts> = {},
): TurnOpts {
  return {
    history: [],
    userMessage,
    workdir: "/tmp",
    canUseTool: async () => ({ behavior: "allow" as const }),
    ...overrides,
  };
}

// ── #178 Phase 3: VWS memory mount over the shared HTTP endpoint ───────────────

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

const MOUNT_URL = "http://127.0.0.1:65535/mcp/memory";

async function makeEndpoint(): Promise<{ endpoint: MemoryMcpHttp; engine: MemoryEngine }> {
  const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await engine.init();
  return { endpoint: new MemoryMcpHttp(engine), engine };
}

function makeProviderWithMount(endpoint: MemoryMcpHttp): CodexProvider {
  return new CodexProvider({
    sessionId: "sess-1",
    initialBackingId: "sess-1",
    command: process.execPath,
    argsPrefix: [FIXTURE],
    store: {} as Store,
    workspaceId: "wsX",
    memoryMcp: { endpoint, url: MOUNT_URL },
  });
}

async function collect(run: TurnRun): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === "turn_done" || event.type === "error") break;
  }
  return events;
}

describe("CodexProvider over fake-codex", () => {
  it("C1: text turn streams thinking + text and completes with usage", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("hello")));
    await p.teardown();

    expect(events.some((e) => e.type === "thinking_delta" && e.content === "thinking...")).toBe(true);
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e as { content: string }).content);
    expect(deltas.join("")).toBe("Hello world");
    const done = events.find((e) => e.type === "text_done");
    expect(done && (done as { content: string }).content).toBe("Hello world");
    const turnDone = events.find((e) => e.type === "turn_done");
    expect(turnDone).toBeDefined();
    if (turnDone?.type === "turn_done") {
      expect(turnDone.result.providerId).toBe("codex");
      // Usage comes from thread/tokenUsage/updated (turn/completed has none);
      // inputTokens excludes cache reads (claude convention): 120 - 20.
      expect(turnDone.result.inputTokens).toBe(100);
      expect(turnDone.result.outputTokens).toBe(45);
      expect(turnDone.result.cacheReadTokens).toBe(20);
    }
  });

  it("C2: approval request routes through canUseTool and approval runs the item", async () => {
    const p = makeProvider();
    const gated: Array<{ name: string; input: Record<string, unknown> }> = [];
    const events = await collect(
      p.runTurn(
        turnOpts("please use-tool", {
          canUseTool: async (_toolId, _approvalId, toolName, input) => {
            gated.push({ name: toolName, input });
            return { behavior: "allow" as const };
          },
        }),
      ),
    );
    await p.teardown();

    expect(gated).toEqual([
      { name: "Bash", input: { command: "rm -rf /tmp/scratch", cwd: "/tmp", reason: "cleanup" } },
    ]);
    // tool_start announced at approval time, tool_complete after codex ran it.
    const start = events.find((e) => e.type === "tool_start");
    expect(start && (start as { name: string }).name).toBe("Bash");
    const complete = events.find((e) => e.type === "tool_complete");
    expect(complete && (complete as { output: string }).output).toBe("removed");
    expect(events.some((e) => e.type === "text_done" && e.content === "Cleaned up.")).toBe(true);
  });

  it("C3: denial reaches codex and the item never runs", async () => {
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
    expect(events.some((e) => e.type === "text_done" && e.content === "Approval denied; skipping.")).toBe(true);
  });

  it("C4: non-gated item is recorded retrospectively as start+complete", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("auto-tool please")));
    await p.teardown();

    const start = events.find((e) => e.type === "tool_start");
    const complete = events.find((e) => e.type === "tool_complete");
    expect(start).toBeDefined();
    expect(complete).toBeDefined();
    if (start?.type === "tool_start") {
      expect(start.name).toBe("Bash");
      expect(start.input).toEqual({ command: "ls -la" });
    }
    if (complete?.type === "tool_complete") {
      expect(complete.output).toBe("file-a\nfile-b");
      expect(complete.success).toBe(true);
    }
  });

  it("C5: seedFromHistory prepends the structured transcript to the first prompt", async () => {
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
    await p.teardown();

    const done = events.find((e) => e.type === "text_done");
    expect(done).toBeDefined();
    if (done?.type === "text_done") {
      expect(done.content).toContain("<conversation-history>");
      expect(done.content).toContain("### Tool call: run_shell → ok");
      expect(done.content).toContain("echo-prompt");
    }

    // One-shot: the second turn goes through clean.
    const second = await collect(p.runTurn(turnOpts("echo-prompt again")));
    const done2 = second.find((e) => e.type === "text_done");
    if (done2?.type === "text_done") {
      expect(done2.content).not.toContain("<conversation-history>");
    }
    await p.teardown();
  });

  it("C6: requestUserInput select question round-trips the picked option", async () => {
    const p = makeProvider();
    const asked: string[] = [];
    const events = await collect(
      p.runTurn(
        turnOpts("ask-user", {
          requestUserInput: async (req) => {
            asked.push(`${req.method}:${req.title}:${(req.options ?? []).join("|")}`);
            return { value: "prod", cancelled: false };
          },
        }),
      ),
    );
    await p.teardown();

    expect(asked).toEqual(["select:Pick one:dev|prod"]);
    expect(events.some((e) => e.type === "text_done" && e.content === "You picked: prod")).toBe(true);
  });

  it("C7: a missing codex binary surfaces a clear error", async () => {
    const p = makeProvider("/nonexistent/codex-binary", []);
    const events = await collect(p.runTurn(turnOpts("hello")));
    await p.teardown();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("C8: model/list maps to ModelInfo", async () => {
    const p = makeProvider();
    // Warm the process + thread with a cheap turn first.
    await collect(p.runTurn(turnOpts("hello")));
    const models = await p.listModels();
    await p.teardown();
    expect(models).toEqual([
      { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Balanced agentic coding model." },
    ]);
  });

  it("C9: lifecycle — thread id becomes the backing id, reset/setHasQueried/dispose, onModels fires", async () => {
    const reported: Array<{ value: string; displayName: string }> = [];
    const p = new CodexProvider({
      sessionId: "sess-1",
      initialBackingId: "sess-1",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: {} as Store,
      onModels: (models) => reported.push(...models.map((m) => ({ value: m.value, displayName: m.displayName }))),
    });
    expect(p.hasQueried).toBe(false);
    expect(p.queuedMessages).toBe(0);

    await collect(p.runTurn(turnOpts("hello")));
    expect(p.hasQueried).toBe(true);
    // codex minted the thread — it round-trips as the backing session id.
    expect(p.backingSessionId).toBe("codex-thread-1");
    expect(reported).toEqual([{ value: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" }]);

    p.setHasQueried(false);
    expect(p.hasQueried).toBe(false);
    p.resetToNewSession("fresh-backing");
    expect(p.backingSessionId).toBe("fresh-backing");

    await p.dispose(); // teardown via dispose
    expect(await p.listModels()).toEqual([]); // no live process → empty catalog
  });

  it("C10: interrupt() sends turn/interrupt and the turn ends as interrupted", async () => {
    const p = makeProvider();
    const run = p.runTurn(turnOpts("hang-forever"));
    // Give the turn time to start (thread + turn/start round trips).
    await new Promise((r) => setTimeout(r, 300));
    await run.interrupt();
    const events = await collect(run);
    await p.teardown();

    const done = events.find((e) => e.type === "turn_done");
    expect(done).toBeDefined();
    if (done?.type === "turn_done") expect(done.result.stopReason).toBe("interrupted");
  });

  it("C11: unknown server→client requests are refused with a JSON-RPC error (fail closed)", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("unknown-request")));
    await p.teardown();
    // The fixture saw an error response — codeoid refused rather than guessed.
    expect(events.some((e) => e.type === "text_done" && e.content === "server-request-errored")).toBe(true);
  });

  it("C13: pins danger-full-access sandbox + untrusted approval on thread AND turn start by default", async () => {
    // codeoid is the trust authority; codex must EXECUTE approved actions
    // (sandbox off) instead of re-sandboxing them via bubblewrap, which fails
    // wherever unprivileged user namespaces are forbidden.
    const prev = { a: process.env.CODEX_APPROVAL_POLICY, s: process.env.CODEX_SANDBOX_POLICY };
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_SANDBOX_POLICY;
    try {
      const p = makeProvider();
      const events = await collect(p.runTurn(turnOpts("echo-policy")));
      await p.teardown();
      const done = events.find((e) => e.type === "text_done");
      expect(done).toBeDefined();
      const seen = JSON.parse((done as { content: string }).content);
      // sandboxPolicy is codex's INTERNALLY-TAGGED enum, not the bare string.
      const expected = { approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } };
      expect(seen.thread).toEqual(expected);
      expect(seen.turn).toEqual(expected);
    } finally {
      restoreEnv("CODEX_APPROVAL_POLICY", prev.a);
      restoreEnv("CODEX_SANDBOX_POLICY", prev.s);
    }
  });

  it("C14: CODEX_APPROVAL_POLICY / CODEX_SANDBOX_POLICY env override the pinned defaults", async () => {
    const prev = { a: process.env.CODEX_APPROVAL_POLICY, s: process.env.CODEX_SANDBOX_POLICY };
    process.env.CODEX_APPROVAL_POLICY = "on-request";
    process.env.CODEX_SANDBOX_POLICY = "workspace-write";
    try {
      const p = makeProvider();
      const events = await collect(p.runTurn(turnOpts("echo-policy")));
      await p.teardown();
      const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content);
      // workspace-write maps to the tagged variant WITH the workdir as a writable root.
      const expected = {
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
      expect(seen.thread).toEqual(expected);
      expect(seen.turn).toEqual(expected);
    } finally {
      restoreEnv("CODEX_APPROVAL_POLICY", prev.a);
      restoreEnv("CODEX_SANDBOX_POLICY", prev.s);
    }
  });

  it("C15: an unknown env policy value falls back to the safe default (never rejected by codex)", async () => {
    const prev = { a: process.env.CODEX_APPROVAL_POLICY, s: process.env.CODEX_SANDBOX_POLICY };
    process.env.CODEX_APPROVAL_POLICY = "yolo-mode";
    process.env.CODEX_SANDBOX_POLICY = "";
    try {
      const p = makeProvider();
      const events = await collect(p.runTurn(turnOpts("echo-policy")));
      await p.teardown();
      const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content);
      expect(seen.turn).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } });
    } finally {
      restoreEnv("CODEX_APPROVAL_POLICY", prev.a);
      restoreEnv("CODEX_SANDBOX_POLICY", prev.s);
    }
  });

  it("C16: read-only maps to the tagged readOnly variant", async () => {
    const prev = process.env.CODEX_SANDBOX_POLICY;
    process.env.CODEX_SANDBOX_POLICY = "read-only";
    try {
      const p = makeProvider();
      const events = await collect(p.runTurn(turnOpts("echo-policy")));
      await p.teardown();
      const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content);
      expect(seen.turn.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    } finally {
      restoreEnv("CODEX_SANDBOX_POLICY", prev);
    }
  });

  it("C17: the shared validator rejects the bare-string sandboxPolicy exactly as real codex does", () => {
    // Guards against the #163 wire-shape bug. fake-codex enforces this same
    // validator on every thread/turn start, so a provider regression to the
    // kebab STRING makes ALL turn tests error out — it can't pass offline again.
    expect(sandboxPolicyError("danger-full-access")).toContain("SandboxPolicyDeserialize");
    expect(sandboxPolicyError("workspace-write")).toContain('string "workspace-write"');
    expect(sandboxPolicyError({ type: "bogusVariant" })).toContain("unknown variant");
    expect(sandboxPolicyError({ type: "dangerFullAccess" })).toBeNull();
    expect(sandboxPolicyError({ type: "workspaceWrite", writableRoots: ["/tmp"] })).toBeNull();
    expect(sandboxPolicyError(undefined)).toBeNull(); // optional field
  });

  it("C18: autonomous mode pins approvalPolicy 'never' (codex runs unattended) on thread AND turn", async () => {
    const prev = { a: process.env.CODEX_APPROVAL_POLICY, s: process.env.CODEX_SANDBOX_POLICY };
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_SANDBOX_POLICY;
    try {
      const p = makeProvider();
      const events = await collect(p.runTurn(turnOpts("echo-policy", { mode: "autonomous" })));
      await p.teardown();
      const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content);
      // Full sandbox access stays (network + fs); only the approval policy flips.
      const expected = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
      expect(seen.thread).toEqual(expected);
      expect(seen.turn).toEqual(expected);
    } finally {
      restoreEnv("CODEX_APPROVAL_POLICY", prev.a);
      restoreEnv("CODEX_SANDBOX_POLICY", prev.s);
    }
  });

  it("C19: guarded and interactive both pin 'untrusted' (codex asks → codeoid's gate prompts)", async () => {
    const prev = { a: process.env.CODEX_APPROVAL_POLICY, s: process.env.CODEX_SANDBOX_POLICY };
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_SANDBOX_POLICY;
    try {
      for (const mode of ["guarded", "interactive"] as const) {
        const p = makeProvider();
        const events = await collect(p.runTurn(turnOpts("echo-policy", { mode })));
        await p.teardown();
        const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content);
        const expected = { approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } };
        expect(seen.thread, `mode=${mode}`).toEqual(expected);
        expect(seen.turn, `mode=${mode}`).toEqual(expected);
      }
    } finally {
      restoreEnv("CODEX_APPROVAL_POLICY", prev.a);
      restoreEnv("CODEX_SANDBOX_POLICY", prev.s);
    }
  });

  it("C20: CODEX_APPROVAL_POLICY env still WINS over the mode (operator escape hatch)", async () => {
    const prev = { a: process.env.CODEX_APPROVAL_POLICY, s: process.env.CODEX_SANDBOX_POLICY };
    // Autonomous would derive "never", but an explicit operator pin holds.
    process.env.CODEX_APPROVAL_POLICY = "untrusted";
    delete process.env.CODEX_SANDBOX_POLICY;
    try {
      const p = makeProvider();
      const events = await collect(p.runTurn(turnOpts("echo-policy", { mode: "autonomous" })));
      await p.teardown();
      const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content);
      expect(seen.turn.approvalPolicy).toBe("untrusted");
    } finally {
      restoreEnv("CODEX_APPROVAL_POLICY", prev.a);
      restoreEnv("CODEX_SANDBOX_POLICY", prev.s);
    }
  });

  it("C21: supportsMemoryTools is false without a mount, true with one", async () => {
    const { endpoint, engine } = await makeEndpoint();
    expect(makeProvider().supportsMemoryTools).toBe(false);
    expect(makeProviderWithMount(endpoint).supportsMemoryTools).toBe(true);
    await engine.close();
  });

  it("C22: mounts the shared endpoint via -c mcp_servers overrides + a token env var", async () => {
    const { endpoint, engine } = await makeEndpoint();
    const p = makeProviderWithMount(endpoint);
    const events = await collect(p.runTurn(turnOpts("echo-mcp")));
    const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content) as {
      mcpArgs: string[];
      token: string | null;
    };
    // Two -c overrides: the streamable-HTTP url + the bearer-token env-var name.
    expect(seen.mcpArgs.some((a) => a.includes(`mcp_servers.${MEMORY_MCP_SERVER_NAME}.url=`) && a.includes(MOUNT_URL))).toBe(true);
    expect(seen.mcpArgs.some((a) => a.includes(`mcp_servers.${MEMORY_MCP_SERVER_NAME}.bearer_token_env_var=`))).toBe(true);
    // The token is delivered via the env var (not argv), and matches the mint.
    expect(seen.token).toMatch(/^mmt_/);
    expect(endpoint.activeTokens).toBe(1);
    await p.teardown();
    expect(endpoint.activeTokens).toBe(0);
    await engine.close();
  });

  it("C23: no mcp_servers overrides + no token env when memory is absent", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("echo-mcp")));
    const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content) as {
      mcpArgs: string[];
      token: string | null;
    };
    expect(seen.mcpArgs).toEqual([]);
    expect(seen.token).toBeNull();
    await p.teardown();
  });

  it("C24: an MCP tool-call elicitation routes through canUseTool as mcp__<server>__<tool> and accepts", async () => {
    // Regression: codex gates MCP tool calls with `mcpServer/elicitation/request`
    // (not the item/* approvals), reply shape `{action}` (not `{decision}`).
    // Before the fix this hit the default handler, threw, and codex read the
    // error as a decline — so recall was auto-denied in guarded/interactive.
    const p = makeProvider();
    const gated: Array<{ name: string; input: Record<string, unknown> }> = [];
    const events = await collect(
      p.runTurn(
        turnOpts("please mcp-tool", {
          canUseTool: async (_toolId, _approvalId, toolName, input) => {
            gated.push({ name: toolName, input });
            return { behavior: "allow" as const };
          },
        }),
      ),
    );
    await p.teardown();

    // Canonical `mcp__<server>__<tool>` name — the form the session's isSafeTool
    // recognises, so read-only memory tools auto-approve instead of prompting.
    expect(gated).toEqual([{ name: "mcp__codeoid_memory__recall", input: { query: "compliance" } }]);
    const start = events.find((e) => e.type === "tool_start");
    expect(start && (start as { name: string }).name).toBe("mcp__codeoid_memory__recall");
    const complete = events.find((e) => e.type === "tool_complete");
    expect(complete && (complete as { output: string }).output).toBe("8 episodes");
    expect(complete && (complete as { success: boolean }).success).toBe(true);
    expect(events.some((e) => e.type === "text_done" && e.content === "Recalled.")).toBe(true);
  });

  it("C25: denying an MCP tool-call elicitation replies decline (action shape) and the tool never runs", async () => {
    const p = makeProvider();
    const events = await collect(
      p.runTurn(
        turnOpts("please mcp-tool", {
          canUseTool: async () => ({ behavior: "deny" as const, message: "no" }),
        }),
      ),
    );
    await p.teardown();
    // codex received `{action:"decline"}` → skipped the call → no tool_complete.
    expect(events.some((e) => e.type === "tool_complete")).toBe(false);
    expect(
      events.some((e) => e.type === "text_done" && e.content === "The MCP tool call was rejected by the user."),
    ).toBe(true);
  });

  it("C26: elicitation with no preceding item/started recovers tool from message + args from _meta", async () => {
    // Defensive fallback: build the canonical name from the `message` and the
    // input from `_meta.tool_params` when the mcpToolCall item wasn't observed.
    const p = makeProvider();
    const gated: Array<{ name: string; input: Record<string, unknown> }> = [];
    const events = await collect(
      p.runTurn(
        turnOpts("please mcp-nostart", {
          canUseTool: async (_toolId, _approvalId, toolName, input) => {
            gated.push({ name: toolName, input });
            return { behavior: "allow" as const };
          },
        }),
      ),
    );
    await p.teardown();
    expect(gated).toEqual([{ name: "mcp__codeoid_memory__recall", input: { query: "compliance" } }]);
    expect(events.some((e) => e.type === "text_done" && e.content === "Recalled (nostart).")).toBe(true);
  });

  it("C27: registry external servers mount via -c mcp_servers overrides (stdio + http)", async () => {
    const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
      ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p }) as RawMcpServerConfig;
    const reg = new McpRegistry(
      {
        ghstdio: raw({ command: "npx", args: ["-y", "@mcp/gh"], env: { TOKEN: "${GH_PAT}" } }),
        linear: raw({ url: "https://mcp.linear.app/mcp", bearerTokenEnv: "LINEAR_KEY" }),
      },
      { memoryEnabled: false },
    );
    const p = new CodexProvider({
      sessionId: "sess-1",
      initialBackingId: "sess-1",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: {} as Store,
      mcpRegistry: reg,
    });
    const events = await collect(p.runTurn(turnOpts("echo-mcp")));
    await p.teardown();
    const seen = JSON.parse((events.find((e) => e.type === "text_done") as { content: string }).content) as { mcpArgs: string[] };
    const joined = seen.mcpArgs.join(" ");
    expect(joined).toContain("mcp_servers.ghstdio.command=");
    expect(joined).toContain("mcp_servers.ghstdio.args=");
    expect(joined).toContain('mcp_servers.ghstdio.env={ TOKEN = '); // TOML inline table, not JSON
    expect(joined).toContain("mcp_servers.linear.url=");
    expect(joined).toContain("mcp_servers.linear.bearer_token_env_var=");
  });

  it("C12: rpc edges — spawn failure, request timeout, request/notify after exit", async () => {
    // Spawn failure rejects in-flight requests.
    const dead = new CodexRpcProcess({
      command: "/nonexistent/codex-binary",
      cwd: "/tmp",
      env: {},
      onNotification: () => {},
      onServerRequest: async () => ({}),
      onExit: () => {},
    });
    expect(dead.request("initialize", {})).rejects.toThrow(/spawn failed|exited/);

    // A request the server never answers times out.
    const exited = new Promise<void>((resolve) => {
      const rpc = new CodexRpcProcess({
        command: process.execPath,
        argsPrefix: [FIXTURE],
        cwd: "/tmp",
        env: { PATH: process.env.PATH ?? "" },
        onNotification: () => {},
        onServerRequest: async () => ({}),
        onExit: () => resolve(),
      });
      void (async () => {
        expect(rpc.request("test/noReply", {}, 200)).rejects.toThrow(/timed out/);
        await new Promise((r) => setTimeout(r, 250));
        rpc.kill();
        await exitedSoon(rpc);
        // Post-exit: requests reject, notify is a silent no-op.
        expect(rpc.request("initialize", {})).rejects.toThrow(/exited/);
        rpc.notify("initialized");
      })();
    });
    await exited;
  });
});

/** Restore an env var to a captured prior value (delete if it was unset). */
function restoreEnv(name: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

/** Wait until the rpc process reports dead. */
async function exitedSoon(rpc: CodexRpcProcess): Promise<void> {
  const deadline = Date.now() + 2000;
  while (rpc.alive) {
    if (Date.now() > deadline) throw new Error("codex rpc never exited");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("codex resolution + registry", () => {
  it("config override → PATH → null, with registry hints", () => {
    // Bogus configured command → supported-but-unavailable with the hint.
    const config = {
      providers: {
        pi: { enabled: false, command: "pi" },
        codex: { enabled: true, command: "/definitely/missing/codex" },
      },
    } as unknown as CodeoidConfig;
    const registry = createDefaultProviderRegistry(config);
    expect(registry.has("codex")).toBe(false);
    expect(registry.unavailableHint("codex")).toContain("providers.codex.command");

    // Bare-name override resolves via PATH; system codex resolves as "path".
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-codex-resolve-"));
    // Isolated env: empty HOME + no version-manager vars, so the node-bin
    // fallback has nothing to find (the real machine's nvm codex can't leak in).
    const isolated = { PATH: "", HOME: join(tmp, "empty-home") };

    // No codex anywhere → null + generic install hint.
    expect(resolveCodexCommand(undefined, isolated)).toBeNull();

    try {
      const bin = join(tmp, "my-codex");
      writeFileSync(bin, "#!/bin/sh\necho fake-codex\n");
      chmodSync(bin, 0o755);
      expect(resolveCodexCommand("my-codex", { PATH: tmp })).toEqual({
        command: bin,
        argsPrefix: [],
        source: "config",
      });
      expect(resolveCodexCommand("missing-name", { PATH: tmp })).toBeNull();
      const sys = join(tmp, "codex");
      writeFileSync(sys, "#!/bin/sh\necho fake-codex\n");
      chmodSync(sys, 0o755);
      expect(resolveCodexCommand(undefined, { PATH: tmp })).toEqual({
        command: sys,
        argsPrefix: [],
        source: "path",
      });

      // node-bin fallback: codex NOT on PATH but in ~/.npm-global/bin — the
      // "daemon PATH omits the user's node bin" case this fix exists for.
      const nodeBin = join(tmp, "home", ".npm-global", "bin");
      mkdirSync(nodeBin, { recursive: true });
      const codexInNodeBin = join(nodeBin, "codex");
      writeFileSync(codexInNodeBin, "#!/bin/sh\necho fake\n");
      chmodSync(codexInNodeBin, 0o755);
      expect(resolveCodexCommand(undefined, { PATH: "", HOME: join(tmp, "home") })).toEqual({
        command: codexInNodeBin,
        argsPrefix: [],
        source: "node-bin",
      });

      // nvm: codex under ~/.nvm/versions/node/<version>/bin, resolved
      // NEWEST-version-first (v21.5.0 preferred over v9.0.0 lexical order).
      const nvmHome = join(tmp, "nvmhome");
      for (const v of ["v9.0.0", "v21.5.0"]) {
        const vbin = join(nvmHome, ".nvm", "versions", "node", v, "bin");
        mkdirSync(vbin, { recursive: true });
        writeFileSync(join(vbin, "codex"), "#!/bin/sh\necho fake\n");
        chmodSync(join(vbin, "codex"), 0o755);
      }
      const nvmResolved = resolveCodexCommand(undefined, { PATH: "", HOME: nvmHome });
      expect(nvmResolved?.source).toBe("node-bin");
      // Highest version wins the sort, even though "v21" < "v9" lexically.
      expect(nvmResolved?.command).toBe(join(nvmHome, ".nvm", "versions", "node", "v21.5.0", "bin", "codex"));

      // Active version-manager env vars are searched too (NVM_BIN /
      // VOLTA_HOME / npm_config_prefix), before the home defaults.
      for (const key of ["NVM_BIN", "VOLTA_HOME", "npm_config_prefix"] as const) {
        const base = join(tmp, key.toLowerCase());
        const bin = key === "NVM_BIN" ? base : join(base, "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "codex"), "#!/bin/sh\necho fake\n");
        chmodSync(join(bin, "codex"), 0o755);
        const r = resolveCodexCommand(undefined, {
          PATH: "",
          HOME: join(tmp, "no-home"),
          [key]: base,
        });
        expect(r?.source).toBe("node-bin");
        expect(r?.command).toBe(join(bin, "codex"));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // Disabled → absent entirely, no hint.
    const disabled = createDefaultProviderRegistry({
      providers: {
        pi: { enabled: false, command: "pi" },
        codex: { enabled: false, command: "codex" },
      },
    } as unknown as CodeoidConfig);
    expect(disabled.has("codex")).toBe(false);
    expect(disabled.unavailableHint("codex")).toBeUndefined();
  });

  it("compareNodeVersionsDesc orders newest-first and ties equal versions", () => {
    expect(["v9.0.0", "v21.5.0", "v20.11.1"].sort(compareNodeVersionsDesc)).toEqual([
      "v21.5.0",
      "v20.11.1",
      "v9.0.0",
    ]);
    // Equal versions (incl. a missing patch component) compare as 0.
    expect(compareNodeVersionsDesc("v18.0.0", "v18.0")).toBe(0);
    expect(compareNodeVersionsDesc("v18.1.0", "v18.1.0")).toBe(0);
  });
});

// ── error reporting ─────────────────────────────────────────────────────────

// This exists because a live role-child failed twice with the literal
// `Error: [object Object]` and nothing anywhere said why. The `error`
// notification carries an OBJECT on this wire, and the handler cast it
// `as string` then String()'d it — destroying the cause at the one place whose
// entire job was to report it. A backend whose failures are unreadable is a
// backend nobody can debug.
describe("describeCodexError", () => {
  it("extracts a JSON-RPC-style error object rather than stringifying it", () => {
    const out = describeCodexError({
      error: { code: -32603, message: "model gpt-5.6-sol is not available to this account" },
    });
    expect(out).toContain("not available to this account");
    expect(out).toContain("-32603");
    expect(out).not.toContain("[object Object]");
  });

  it("prefers a direct message when present", () => {
    expect(describeCodexError({ message: "stream closed" })).toBe("stream closed");
  });

  it("accepts a bare string error", () => {
    expect(describeCodexError({ error: "rate limited" })).toBe("rate limited");
  });

  it("falls back to bounded JSON for an unrecognised shape", () => {
    // Tolerating shape beats asserting it: a wrong assumption here costs the
    // whole diagnostic, which is exactly what happened.
    const out = describeCodexError({ error: { unexpected: { nested: true } } });
    expect(out).toContain("unexpected");
    expect(out).not.toContain("[object Object]");
  });

  it("never returns [object Object], whatever it is handed", () => {
    for (const params of [
      {},
      { error: {} },
      { error: null },
      { message: 42 },
      { error: { message: null, code: 7 } },
    ] as Array<Record<string, unknown>>) {
      const out = describeCodexError(params);
      expect(out).not.toContain("[object Object]");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
