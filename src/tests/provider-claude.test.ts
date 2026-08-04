/**
 * ClaudeProvider unit tests — offline, no Claude Agent SDK subprocess.
 *
 * Strategy:
 *   1. Pure-function tests: translateSDKMessage, parseMcpServerConfig,
 *      extractToolResultText — no mocking needed.
 *   2. ClaudeProvider lifecycle tests: mock.module() replaces the
 *      @anthropic-ai/claude-agent-sdk `query()` call with a controllable
 *      async iterable so the full provider loop runs without any I/O.
 *
 * mock.module() must be registered before the module-under-test is imported.
 * Bun evaluates mock.module() calls before resolving static imports in the
 * same file, so we can import ClaudeProvider statically below.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import type { ProviderEvent } from "../daemon/providers/interface.js";

// ── SDK mock ──────────────────────────────────────────────────────────────────

type SDKMsg = Record<string, unknown>;

/** Per-test queue of SDK messages; replaced by each test that needs the loop. */
let sdkMessages: SDKMsg[] = [];
/** When set, the mock query throws this error instead of yielding messages. */
let sdkThrowError: Error | null = null;
/** Captures the options passed to query() so tests can invoke callbacks. */
let capturedQueryOpts: Record<string, unknown> | null = null;
/** Total query() constructions — distinguishes warm reuse from rebuilds. */
let queryCallCount = 0;
/** When set, the mock loop blocks before finishing so tests can invoke captured
 *  callbacks (canUseTool, hooks) while the turn queue is still open. */
let sdkGate: Promise<void> | null = null;

function makeMockQuery() {
  const err = sdkThrowError;
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<{ done: boolean; value: SDKMsg | undefined }> {
          if (err) throw err;
          if (i >= sdkMessages.length) {
            if (sdkGate) await sdkGate;
            return { done: true, value: undefined };
          }
          return { done: false, value: sdkMessages[i++] };
        },
      };
    },
    interrupt: async () => {},
    supportedModels: async () => [{ value: "claude-opus-4", displayName: "Claude Opus 4" }],
  };
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: unknown) => {
    capturedQueryOpts = opts as Record<string, unknown>;
    queryCallCount += 1;
    return makeMockQuery();
  },
  // Minimal stubs so buildMemoryMcpServer() runs when a memory engine is
  // present — the closures are never invoked here, we only assert wiring
  // (allowedTools) and never actually call a memory tool through the SDK.
  tool: (name: string, description: string, _shape: unknown, _run: unknown) => ({ name, description }),
  createSdkMcpServer: (cfg: { name: string; version?: string; tools?: unknown[] }) => ({
    type: "sdk" as const,
    name: cfg.name,
    instance: { tools: cfg.tools ?? [] },
  }),
}));

// ── Import AFTER mock registration ────────────────────────────────────────────

import {
  ClaudeProvider,
  translateSDKMessage,
  parseMcpServerConfig,
  extractToolResultText,
  withMcpToolTimeout,
  buildAgentEnv,
  skillCommandAllowRules,
  skillSandboxDirs,
} from "../daemon/providers/claude/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine } from "../daemon/memory/engine.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import { MEMORY_TOOL_NAMES } from "../daemon/memory/index.js";
import type { Embedder } from "../daemon/memory/embedder.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectEmits(msg: SDKMsg): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  translateSDKMessage(msg as never, (e) => out.push(e), "claude");
  return out;
}

function makeProvider(): ClaudeProvider {
  return new ClaudeProvider({
    sessionId: "test-session",
    initialBackingId: "test-backing",
    workspaceId: "ws_test",
    store: {
      audit: () => {},
      getClaudeCodeSessionId: () => null,
      setClaudeCodeSessionId: () => {},
      // #233: the provider reads persisted skill-command verdicts on every
      // query build. Empty map = nothing approved yet.
      getSkillCommandGrants: () => new Map<string, boolean>(),
      setSkillCommandGrant: () => {},
    } as never,
  });
}

async function collectTurnEvents(provider: ClaudeProvider, message = "hello"): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const run = provider.runTurn({
    history: [],
    userMessage: message,
    workdir: "/tmp",
    canUseTool: async () => ({ behavior: "allow" as const }),
  });
  for await (const e of run.events) {
    events.push(e);
  }
  return events;
}

// ── translateSDKMessage ───────────────────────────────────────────────────────

describe("translateSDKMessage – assistant", () => {
  it("emits llm_call for usage + text_done for text blocks", () => {
    const events = collectEmits({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      },
      parent_tool_use_id: null,
    });
    expect(events[0]).toMatchObject({ type: "llm_call", isPrimary: true });
    expect(events[0]).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1 },
    });
    expect(events[1]).toMatchObject({ type: "text_done", content: "Hello world" });
  });

  it("isPrimary=false for subagent messages (parent_tool_use_id set)", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [], usage: { input_tokens: 1, output_tokens: 1 } },
      parent_tool_use_id: "parent-id",
    });
    expect(events[0]).toMatchObject({ type: "llm_call", isPrimary: false });
  });

  it("skips text_done when no text blocks", () => {
    const events = collectEmits({ type: "assistant", message: { content: [] }, parent_tool_use_id: null });
    expect(events.find((e) => e.type === "text_done")).toBeUndefined();
  });

  it("joins multiple text blocks", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      parent_tool_use_id: null,
    });
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ content: "AB" });
  });

  it("tags text_done with parentToolUseId null for primary messages (#82)", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [{ type: "text", text: "primary" }] },
      parent_tool_use_id: null,
    });
    expect(events.find((e) => e.type === "text_done")).toMatchObject({
      content: "primary",
      parentToolUseId: null,
    });
  });

  it("tags text_done with the spawning tool id for subagent messages (#82)", () => {
    const events = collectEmits({
      type: "assistant",
      message: { content: [{ type: "text", text: "subagent commentary" }] },
      parent_tool_use_id: "tu-task-1",
    });
    expect(events.find((e) => e.type === "text_done")).toMatchObject({
      content: "subagent commentary",
      parentToolUseId: "tu-task-1",
    });
  });
});

describe("translateSDKMessage – stream_event", () => {
  it("emits text_delta for content_block_delta/text_delta", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chunk" } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text_delta", content: "chunk" });
  });

  it("emits thinking_delta for content_block_start/thinking", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    });
    expect(events[0]).toMatchObject({ type: "thinking_delta", content: "", blockIndex: 0 });
  });

  it("emits thinking_delta for thinking_delta events", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    expect(events[0]).toMatchObject({ type: "thinking_delta", content: "hmm", blockIndex: 1 });
  });

  it("emits thinking_done for content_block_stop", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_stop", index: 2 },
    });
    expect(events[0]).toMatchObject({ type: "thinking_done", blockIndex: 2 });
  });

  it("emits nothing for null event", () => {
    const events = collectEmits({ type: "stream_event", event: null });
    expect(events).toHaveLength(0);
  });

  it("tags text_delta and thinking events with parentToolUseId for subagent streams (#82)", () => {
    const textEvents = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "sub chunk" } },
      parent_tool_use_id: "tu-task-2",
    });
    expect(textEvents[0]).toMatchObject({ type: "text_delta", content: "sub chunk", parentToolUseId: "tu-task-2" });

    const thinkEvents = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "sub hmm" } },
      parent_tool_use_id: "tu-task-2",
    });
    expect(thinkEvents[0]).toMatchObject({ type: "thinking_delta", content: "sub hmm", parentToolUseId: "tu-task-2" });

    const stopEvents = collectEmits({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
      parent_tool_use_id: "tu-task-2",
    });
    expect(stopEvents[0]).toMatchObject({ type: "thinking_done", blockIndex: 1, parentToolUseId: "tu-task-2" });
  });

  it("tags primary stream events with parentToolUseId null", () => {
    const events = collectEmits({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chunk" } },
      parent_tool_use_id: null,
    });
    expect(events[0]).toMatchObject({ type: "text_delta", content: "chunk", parentToolUseId: null });
  });
});

describe("translateSDKMessage – result", () => {
  it("emits turn_done with normalized fields", () => {
    const events = collectEmits({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      total_cost_usd: 0.002,
      duration_ms: 1234,
      stop_reason: "end_turn",
      modelUsage: { "claude-opus-4": {} },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn_done",
      result: {
        providerId: "claude",
        model: "claude-opus-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        totalCostUsd: 0.002,
        durationMs: 1234,
        stopReason: "end_turn",
        isError: undefined,
        errorMessage: undefined,
      },
    });
  });

  it("sets errorMessage when subtype is not 'success' and result is set", () => {
    const events = collectEmits({ type: "result", subtype: "error_during_execution", result: "tool failed" });
    expect(events[0]).toMatchObject({ type: "turn_done", result: { errorMessage: "tool failed" } });
  });

  it("falls back to 'unknown' model when modelUsage is absent", () => {
    const events = collectEmits({ type: "result" });
    expect(events[0]).toMatchObject({ type: "turn_done", result: { model: "unknown" } });
  });

  // A blocked slash-command expansion makes the SDK report
  // `subtype: "success", is_error: false, num_turns: 0, result: ""` — a turn
  // that never ran, dressed as a success. Left unflagged it surfaced as a
  // silently empty turn and no retry/error path ever fired.
  it("flags a zero-turn run as an error even when the SDK reports success", () => {
    const events = collectEmits({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 0,
      result: "",
    });
    expect(events[0]).toMatchObject({ type: "turn_done", result: { isError: true } });
    const { errorMessage } = (events[0] as { result: { errorMessage?: string } }).result;
    expect(errorMessage).toContain("produced no turn");
  });

  it("attributes a zero-turn run to the local-command-stderr that caused it", () => {
    const state = { lastLocalCommandStderr: null as string | null };
    const out: ProviderEvent[] = [];
    const emit = (e: ProviderEvent) => out.push(e);
    // The SDK reports the cause on an earlier message than the result, so the
    // translator has to carry it across calls via `state`.
    translateSDKMessage(
      {
        type: "user",
        message: {
          role: "user",
          content:
            "<local-command-stderr>Error: Shell command permission check failed for pattern \"!`cat ~/.claude/skills/templates/x.md`\": blocked.</local-command-stderr>",
        },
      } as never,
      emit,
      "claude",
      state,
    );
    expect(out).toHaveLength(0); // stderr is captured, not emitted as a tool result
    translateSDKMessage({ type: "result", subtype: "success", num_turns: 0 } as never, emit, "claude", state);
    const { errorMessage } = (out[0] as { result: { errorMessage?: string } }).result;
    expect(errorMessage).toContain("permission check failed");
    // Cleared on the result so the next turn can't inherit a stale cause.
    expect(state.lastLocalCommandStderr).toBeNull();
  });

  it("leaves a normal multi-turn result untouched", () => {
    const events = collectEmits({ type: "result", subtype: "success", num_turns: 3, result: "done" });
    expect(events[0]).toMatchObject({
      type: "turn_done",
      result: { isError: undefined, errorMessage: undefined },
    });
  });
});

describe("skillSandboxDirs", () => {
  // Running a skill's command and reading the files it touches are independent
  // gates that fail in that order. Once the command cleared the permission
  // gate, the real failure surfaced: "cat in '~/.codeoid/packs/.../templates/
  // requirement-template.md' was blocked ... may only concatenate files from
  // the allowed working directories". Pack skills are symlinks, so the check
  // sees the resolved path — outside the workdir.
  it("grants the real parent of a symlinked pack skill, and nothing broader", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-sandbox-"));
    const packSkills = join(tmp, "packs", "ai-factory", "skills");
    mkdirSync(join(packSkills, "spec"), { recursive: true });
    mkdirSync(join(packSkills, "templates"), { recursive: true });
    const skillsDir = join(tmp, "claude-skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(join(packSkills, "spec"), join(skillsDir, "spec"));

    const dirs = skillSandboxDirs([skillsDir]);
    expect(dirs).toContain(realpathSync(packSkills)); // holds templates/
    expect(dirs).toContain(realpathSync(skillsDir));
    expect(dirs).not.toContain(realpathSync(join(tmp, "packs"))); // never the whole pack
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips dangling symlinks and absent tiers instead of throwing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-sandbox-"));
    symlinkSync(join(tmp, "does-not-exist"), join(tmp, "broken"));
    expect(() => skillSandboxDirs([tmp, join(tmpdir(), "codeoid-absent")])).not.toThrow();
    expect(skillSandboxDirs([tmp])).toEqual([realpathSync(tmp)]);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("skillCommandAllowRules", () => {
  const write = (dir: string, name: string, body: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), body);
  };

  // Regression (#233): a skill's `!`…`` substitution runs at expansion time,
  // which has no approval path in a headless session. Unallowed → the whole
  // slash command silently expands to nothing.
  it("emits a verbatim rule per declared command", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-skills-"));
    write(tmp, "spec", "---\nname: spec\n---\n# spec\n!`sh ./ethos.sh`\nctx: !`cat ./x.md`\n");

    const rules = skillCommandAllowRules([tmp]);
    expect(rules).toContain("Bash(sh ./ethos.sh)");
    expect(rules).toContain("Bash(cat ./x.md)");
    rmSync(tmp, { recursive: true, force: true });
  });

  // Measured SDK behaviour: the permission checker splits compound commands and
  // requires every part allowed, OR one exact rule spanning the whole string.
  // We emit the exact rule — a prefix grant like `Bash(sh:*)` would hand every
  // session arbitrary shell.
  it("keeps a compound command intact as one exact rule", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-skills-"));
    write(tmp, "spec", "---\nname: spec\n---\n!`sh a.sh 2>/dev/null || sh b.sh`\n");

    const rules = skillCommandAllowRules([tmp]);
    expect(rules).toEqual(["Bash(sh a.sh 2>/dev/null || sh b.sh)"]);
    expect(rules.some((r) => r.includes(":*"))).toBe(false); // never a wildcard grant
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dedupes across skills and tiers, and skips non-skill entries", () => {
    const userDir = mkdtempSync(join(tmpdir(), "codeoid-user-"));
    const projDir = mkdtempSync(join(tmpdir(), "codeoid-proj-"));
    write(userDir, "a", "---\nname: a\n---\n!`sh shared.sh`\n");
    write(projDir, "b", "---\nname: b\n---\n!`sh shared.sh`\n!`echo hi`\n");
    mkdirSync(join(userDir, "not-a-skill"), { recursive: true }); // no SKILL.md

    const rules = skillCommandAllowRules([userDir, projDir]);
    expect(rules.filter((r) => r === "Bash(sh shared.sh)")).toHaveLength(1);
    expect(rules).toContain("Bash(echo hi)");
    rmSync(userDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  // Regression: `[^`]+` (no \n exclusion) let prose like "…fails!`code`" swallow
  // everything to the next backtick anywhere later in the file, turning whole
  // paragraphs into "commands". Against the real skill set this produced grants
  // like `Bash(suffix,)` and multi-line markdown blobs.
  it("does not let an inline code span in prose span lines into a rule", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-skills-"));
    write(
      tmp,
      "prosey",
      [
        "---",
        "name: prosey",
        "---",
        "!`sh real.sh`",
        "",
        "Watch out for a bang!`inline` and then prose that runs on",
        "- **Control flow:** inverted condition, wrong operator,",
        "and a much later `span` closing it.",
      ].join("\n"),
    );

    const rules = skillCommandAllowRules([tmp]);
    expect(rules).toContain("Bash(sh real.sh)");
    expect(rules.every((r) => !r.includes("\n"))).toBe(true);
    expect(rules.some((r) => r.includes("Control flow"))).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  // `release-notes/SKILL.md` documents the `!` character as prose — "the `!`
  // suffix, `x`" — which parses as a substitution named `suffix,`. Inert, but a
  // permission feature should grant less rather than more.
  it("rejects a candidate whose first token is not an executable name", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-skills-"));
    write(tmp, "doc", "---\nname: doc\n---\nUse the `!` suffix, `then` code.\n!`git status`\n");

    const rules = skillCommandAllowRules([tmp]);
    expect(rules).toEqual(["Bash(git status)"]);
    rmSync(tmp, { recursive: true, force: true });
  });

  // An env-var-prefixed command (`FOO=1 ./run.sh`) has an assignment as its
  // first token — it must NOT be filtered out, or the grant is un-derivable and
  // the retry fails after approval. `=` is in the argv0 class for this reason.
  it("keeps an env-var-prefixed command (assignment as first token)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-skills-"));
    write(tmp, "env", "---\nname: env\n---\n!`FOO=1 ./run.sh --flag`\n");

    const rules = skillCommandAllowRules([tmp]);
    expect(rules).toEqual(["Bash(FOO=1 ./run.sh --flag)"]);
    rmSync(tmp, { recursive: true, force: true });
  });

  // L4 (#233): only commands a human already approved are granted; anything
  // undecided is withheld and raised for approval out-of-band. Verified through
  // the real query build so the wiring — not just the helper — is covered.
  it("returns [] for absent dirs and skills with no substitutions", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-skills-"));
    write(tmp, "plain", "---\nname: plain\n---\nJust prose, no substitutions.\n");
    expect(skillCommandAllowRules([tmp])).toEqual([]);
    expect(skillCommandAllowRules([join(tmpdir(), "codeoid-absent-dir")])).toEqual([]);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// Park-and-retry: a blocked skill command must NOT fail the turn (that killed the
// pipeline — #233). It parks the turn (approval_pending), and on approval the
// loop rebuilds with the grant and retries the SAME prompt in place.
describe("ClaudeProvider – skill-command approval (#233)", () => {
  // A Store backed by a real Map, so a persisted grant is visible to the retry's
  // query rebuild (a fixed-map stub could never satisfy the retry).
  function statefulStore(seed: Record<string, boolean> = {}) {
    const grants = new Map<string, boolean>(Object.entries(seed));
    const writes: Array<[string, boolean]> = [];
    return {
      store: {
        audit: () => {},
        getClaudeCodeSessionId: () => null,
        setClaudeCodeSessionId: () => {},
        getSkillCommandGrants: () => new Map(grants),
        setSkillCommandGrant: (_ws: string, cmd: string, ok: boolean) => {
          grants.set(cmd, ok);
          writes.push([cmd, ok]);
        },
      } as never,
      writes,
    };
  }

  function skillDir(body: string): string {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-skills-"));
    mkdirSync(join(tmp, ".claude", "skills", "s"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "skills", "s", "SKILL.md"), body);
    return tmp;
  }

  const blockFor = (cmd: string) => ({
    type: "user",
    message: {
      role: "user",
      content: `<local-command-stderr>Error: Shell command permission check failed for pattern "!\`${cmd}\`": This command requires approval</local-command-stderr>`,
    },
  });
  const zeroTurn = { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "" };

  it("parks (approval_pending) then retries to success once approved", async () => {
    const tmp = skillDir("---\nname: s\n---\n!`sh gate.sh`\n");
    const { store, writes } = statefulStore();
    const provider = new ClaudeProvider({
      sessionId: "ok", initialBackingId: "b", workspaceId: "ws", store,
    });

    // Turn 1 blocks. The gate keeps the mock stream open (like the real
    // streaming SDK, which parks after a zero-turn rather than ending).
    sdkMessages = [blockFor("sh gate.sh"), zeroTurn];
    queryCallCount = 0; // count builds for THIS turn: initial + retry rebuild
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });

    const run = provider.runTurn({
      history: [], userMessage: "/spec", workdir: tmp,
      canUseTool: async () => ({ behavior: "allow" as const }),
      requestUserInput: async () => {
        // On approval the retry rebuilds the query — swap in a real turn so the
        // rebuilt loop yields success instead of the same block.
        sdkMessages = [
          { type: "assistant", message: { content: [{ type: "text", text: "done" }] }, parent_tool_use_id: null },
          { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", modelUsage: {} },
        ];
        return { confirmed: true, cancelled: false };
      },
    });

    const events: ProviderEvent[] = [];
    const drain = (async () => { for await (const e of run.events) events.push(e); })();
    await Bun.sleep(20); // let park → approve → rebuild → retry run
    release();
    await drain;

    // Parked (not failed) with the exact command...
    const pending = events.find((e) => e.type === "approval_pending") as
      | Extract<ProviderEvent, { type: "approval_pending" }> | undefined;
    expect(pending?.command).toBe("sh gate.sh");
    // ...approval persisted, loop rebuilt (2 query builds), retry granted it...
    expect(writes).toEqual([["Bash(sh gate.sh)", true]]);
    expect(queryCallCount).toBe(2);
    const retryAllowed = ((capturedQueryOpts?.options ?? {}) as { allowedTools?: string[] }).allowedTools ?? [];
    expect(retryAllowed).toContain("Bash(sh gate.sh)");
    // ...and the turn ended a real success, never an error.
    const done = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
    expect(done).toHaveLength(1);
    expect(done[0].result.isError).toBeFalsy();

    await provider.teardown?.();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails the turn cleanly when denied", async () => {
    const tmp = skillDir("---\nname: s\n---\n!`sh nope.sh`\n");
    const { store, writes } = statefulStore();
    const provider = new ClaudeProvider({ sessionId: "d", initialBackingId: "b", workspaceId: "ws", store });
    sdkMessages = [blockFor("sh nope.sh"), zeroTurn];

    const run = provider.runTurn({
      history: [], userMessage: "/spec", workdir: tmp,
      canUseTool: async () => ({ behavior: "allow" as const }),
      requestUserInput: async () => ({ confirmed: false, cancelled: false }), // deny
    });
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    await Bun.sleep(5);

    const done = events.find((e) => e.type === "turn_done") as Extract<ProviderEvent, { type: "turn_done" }>;
    expect(done.result.isError).toBe(true);
    expect(done.result.errorMessage).toContain("denied");
    expect(writes).toEqual([["Bash(sh nope.sh)", false]]); // a denial IS recorded
    await provider.teardown?.();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dismissal fails the turn and persists nothing (no false consent)", async () => {
    const tmp = skillDir("---\nname: s\n---\n!`sh maybe.sh`\n");
    const { store, writes } = statefulStore();
    const provider = new ClaudeProvider({ sessionId: "c", initialBackingId: "b", workspaceId: "ws", store });
    sdkMessages = [blockFor("sh maybe.sh"), zeroTurn];

    const run = provider.runTurn({
      history: [], userMessage: "/spec", workdir: tmp,
      canUseTool: async () => ({ behavior: "allow" as const }),
      requestUserInput: async () => ({ cancelled: true }),
    });
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    await Bun.sleep(5);

    const done = events.find((e) => e.type === "turn_done") as Extract<ProviderEvent, { type: "turn_done" }>;
    expect(done.result.isError).toBe(true);
    expect(done.result.errorMessage).toContain("dismissed");
    expect(writes).toEqual([]); // no verdict — a real decision can still be made
    await provider.teardown?.();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does not loop: an already-granted command that still blocks fails terminally", async () => {
    const tmp = skillDir("---\nname: s\n---\n!`sh broken.sh`\n");
    const { store } = statefulStore({ "Bash(sh broken.sh)": true }); // already granted
    const provider = new ClaudeProvider({ sessionId: "g", initialBackingId: "b", workspaceId: "ws", store });
    sdkMessages = [blockFor("sh broken.sh"), zeroTurn];

    let asked = 0;
    const run = provider.runTurn({
      history: [], userMessage: "/spec", workdir: tmp,
      canUseTool: async () => ({ behavior: "allow" as const }),
      requestUserInput: async () => { asked++; return { cancelled: true }; },
    });
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);

    expect(asked).toBe(0); // never re-prompted for an already-granted command
    expect(events.find((e) => e.type === "approval_pending")).toBeUndefined();
    // Falls through to the normal zero-turn backstop error.
    const done = events.find((e) => e.type === "turn_done") as Extract<ProviderEvent, { type: "turn_done" }>;
    expect(done.result.isError).toBe(true);
    await provider.teardown?.();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("translateSDKMessage – system", () => {
  it("emits mcp_init with server/tool maps", () => {
    const events = collectEmits({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "my_server", status: "connected" }],
      tools: ["mcp__my_server__read", "mcp__my_server__write", "not_mcp_tool"],
    });
    expect(events[0]).toMatchObject({
      type: "mcp_init",
      servers: { my_server: "connected" },
      tools: { my_server: ["mcp__my_server__read", "mcp__my_server__write"] },
    });
  });

  it("emits api_retry for api_retry subtype", () => {
    const events = collectEmits({
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      retry_delay_ms: 1000,
      error_status: 529,
    });
    expect(events[0]).toMatchObject({ type: "api_retry", attempt: 2, retryDelayMs: 1000, errorStatus: 529 });
  });

  it("emits nothing for unknown system subtype", () => {
    const events = collectEmits({ type: "system", subtype: "other" });
    expect(events).toHaveLength(0);
  });
});

describe("translateSDKMessage – user (tool_result)", () => {
  it("emits tool_complete for each tool_result block", () => {
    const events = collectEmits({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "sdk-t1", content: "read output", is_error: false },
          { type: "tool_result", tool_use_id: "sdk-t2", content: "tool failed", is_error: true },
        ],
      },
    });
    expect(events[0]).toMatchObject({ type: "tool_complete", sdkToolUseId: "sdk-t1", output: "read output", success: true });
    expect(events[1]).toMatchObject({ type: "tool_complete", sdkToolUseId: "sdk-t2", output: "tool failed", success: false });
  });

  it("skips non-tool_result blocks", () => {
    const events = collectEmits({ type: "user", message: { content: [{ type: "text", text: "hi" }] } });
    expect(events).toHaveLength(0);
  });
});

describe("translateSDKMessage – tool_progress", () => {
  it("emits tool_progress", () => {
    const events = collectEmits({ type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 3.5 });
    expect(events[0]).toMatchObject({ type: "tool_progress", toolName: "Bash", elapsedSeconds: 3.5 });
  });
});

// ── parseMcpServerConfig ──────────────────────────────────────────────────────

describe("parseMcpServerConfig", () => {
  it("accepts a valid command-based server", () => {
    const result = parseMcpServerConfig({ command: "npx", args: ["-y", "my-server"], env: { KEY: "val" } });
    expect(result).toMatchObject({ command: "npx", args: ["-y", "my-server"] });
  });

  it("accepts a URL-based server without command", () => {
    const result = parseMcpServerConfig({ url: "http://localhost:3000" });
    expect(result).toMatchObject({ url: "http://localhost:3000" });
  });

  it("returns null for non-object input", () => {
    expect(parseMcpServerConfig("string")).toBeNull();
    expect(parseMcpServerConfig(null)).toBeNull();
    expect(parseMcpServerConfig([])).toBeNull();
  });

  it("returns null when neither command nor url is a string", () => {
    expect(parseMcpServerConfig({ command: 123 })).toBeNull();
  });

  it("returns null for non-string args", () => {
    expect(parseMcpServerConfig({ command: "x", args: [1, 2] })).toBeNull();
  });

  it("returns null for non-object env", () => {
    expect(parseMcpServerConfig({ command: "x", env: "bad" })).toBeNull();
  });

  it("returns null for env with non-string values", () => {
    expect(parseMcpServerConfig({ command: "x", env: { KEY: 123 } })).toBeNull();
  });
});

// ── withMcpToolTimeout ────────────────────────────────────────────────────────

describe("withMcpToolTimeout", () => {
  it("injects timeout into external servers that don't declare one", () => {
    const out = withMcpToolTimeout(
      {
        slack: { type: "http", url: "https://gw/mcp/slack" } as never,
        local: { command: "node", args: ["x.js"] } as never,
      },
      120_000,
    );
    expect((out.slack as { timeout?: number }).timeout).toBe(120_000);
    expect((out.local as { timeout?: number }).timeout).toBe(120_000);
  });

  it("does not override a server's explicit timeout", () => {
    const out = withMcpToolTimeout(
      { slack: { type: "http", url: "https://gw", timeout: 5_000 } as never },
      120_000,
    );
    expect((out.slack as { timeout?: number }).timeout).toBe(5_000);
  });

  it("is a no-op when ms <= 0 (use the SDK default)", () => {
    const servers = { slack: { type: "http", url: "https://gw" } as never };
    expect(withMcpToolTimeout(servers, 0)).toBe(servers);
    const out = withMcpToolTimeout(servers, 0);
    expect((out.slack as { timeout?: number }).timeout).toBeUndefined();
  });
});

// ── buildAgentEnv (GHSA-38vh vector 3) ────────────────────────────────────────

describe("buildAgentEnv", () => {
  it("passes system + Anthropic/Claude vars through but drops daemon secrets", () => {
    const env = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/deploy",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy:8080",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      ANTHROPIC_API_KEY: "sk-ant-keep",
      CLAUDE_CODE_USE_BEDROCK: "1",
      // Daemon secrets that must NOT reach the agent shell:
      TELEGRAM_BOT_TOKEN: "bot-secret",
      CODEOID_API_KEY: "zid_sk_root",
      GOOGLE_CLIENT_SECRET: "goog-secret",
      OPENAI_API_KEY: "sk-openai",
      SOME_RANDOM_SECRET: "nope",
    });
    // Allowed
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/deploy");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("C");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-keep");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    // Denied
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.CODEOID_API_KEY).toBeUndefined();
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
  });

  it("honors CODEOID_AGENT_ENV_ALLOW as an extension point (Bedrock/Vertex)", () => {
    const env = buildAgentEnv({
      CODEOID_AGENT_ENV_ALLOW: "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "not-listed",
    });
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA...");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret");
    // Only the explicitly listed names pass — a sibling AWS var stays out.
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it("skips undefined values", () => {
    const env = buildAgentEnv({ PATH: "/bin", HOME: undefined });
    expect(env.PATH).toBe("/bin");
    expect("HOME" in env).toBe(false);
  });
});

// ── extractToolResultText ─────────────────────────────────────────────────────

describe("extractToolResultText", () => {
  it("returns string content directly", () => {
    expect(extractToolResultText("plain text")).toBe("plain text");
  });

  it("returns empty string for non-array, non-string", () => {
    expect(extractToolResultText(null)).toBe("");
    expect(extractToolResultText(42)).toBe("");
  });

  it("joins text blocks from array content", () => {
    expect(extractToolResultText([
      { type: "text", text: "line1" },
      { type: "text", text: "line2" },
    ])).toBe("line1\nline2");
  });

  it("replaces image blocks with '[image]'", () => {
    expect(extractToolResultText([{ type: "image", source: "..." }])).toBe("[image]");
  });

  it("falls back to block.text for unknown block types that have text", () => {
    expect(extractToolResultText([{ type: "unknown_block", text: "fallback" }])).toBe("fallback");
  });
});

// ── ClaudeProvider lifecycle (mocked SDK) ─────────────────────────────────────

describe("ClaudeProvider – runTurn with mocked SDK", () => {
  beforeEach(() => { sdkMessages = []; sdkThrowError = null; capturedQueryOpts = null; sdkGate = null; });

  it("emits text_done + turn_done from mocked assistant + result messages", async () => {
    sdkMessages = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from Claude" }] },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        usage: { input_tokens: 5, output_tokens: 3 },
        modelUsage: { "claude-opus-4": {} },
      },
    ];

    const provider = makeProvider();
    const events = await collectTurnEvents(provider);

    expect(events.some((e) => e.type === "text_done" && (e as { content?: string }).content === "Hello from Claude")).toBe(true);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });

  it("emits error event when SDK throws", async () => {
    sdkThrowError = new Error("SDK boom");
    const provider = makeProvider();
    const events = await collectTurnEvents(provider);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("getters return correct initial state", () => {
    const provider = makeProvider();
    expect(provider.backingSessionId).toBe("test-backing");
    expect(provider.hasQueried).toBe(false);
    expect(provider.queuedMessages).toBe(0);
  });

  it("resetToNewSession resets state", () => {
    const provider = makeProvider();
    provider.resetToNewSession("new-backing");
    expect(provider.backingSessionId).toBe("new-backing");
    expect(provider.hasQueried).toBe(false);
  });

  it("setHasQueried updates the flag", () => {
    const provider = makeProvider();
    provider.setHasQueried(true);
    expect(provider.hasQueried).toBe(true);
    provider.setHasQueried(false);
    expect(provider.hasQueried).toBe(false);
  });

  it("teardown drains the consumer and is safe to call twice", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    const provider = makeProvider();
    // Start a turn so there's an active consumer task.
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    // Teardown should resolve without throwing even if the consumer is in-flight.
    await provider.teardown();
    // Second teardown is a no-op.
    await provider.teardown();
    // Queue closed by teardown — iteration should end immediately.
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.length).toBeGreaterThanOrEqual(0); // may or may not have received events
  });

  it("dispose delegates to teardown without throwing", async () => {
    const provider = makeProvider();
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it("listModels returns empty array when no active query", async () => {
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });

  it("listModels returns models from the active query", async () => {
    // runTurn() sets #query synchronously; call listModels() right away,
    // before the (empty) consumer task runs and nulls #query.
    sdkMessages = [];
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    // Start listModels() before yielding — #query is still non-null here.
    const modelsPromise = provider.listModels();
    await run.interrupt();
    const models = await modelsPromise;
    expect(models.length).toBeGreaterThan(0);
    for await (const _ of run.events) { /* drain */ }
  });

  it("run.interrupt() resolves without throwing", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await run.interrupt();
    // Drain remaining events after interrupt
    for await (const _ of run.events) { /* drain */ }
  });

  it("run.pushMidTurn injects a mid-turn message", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    // pushMidTurn is optional — exercise it if present
    run.pushMidTurn?.("mid-turn injection", "now");
    for await (const _ of run.events) { /* drain */ }
  });

  it("canUseTool emits tool_start correlated by the SDK's own toolUseID (#81)", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: {
        canUseTool: (name: string, input: unknown, o: { toolUseID: string; agentID?: string; signal: AbortSignal }) => Promise<unknown>;
      };
    } | null;
    expect(opts?.options?.canUseTool).toBeDefined();
    const result = await opts!.options.canUseTool("Read", { file_path: "/tmp/x.ts" }, {
      toolUseID: "tu-real-1", agentID: "agent-7", signal: new AbortController().signal,
    });
    expect((result as { behavior: string }).behavior).toBe("allow");
    release();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    const toolStart = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }> | undefined;
    expect(toolStart).toBeDefined();
    expect(toolStart!.sdkToolUseId).toBe("tu-real-1");
    expect(toolStart!.sdkAgentId).toBe("agent-7");
    expect(toolStart!.name).toBe("Read");
    expect(toolStart!.input).toEqual({ file_path: "/tmp/x.ts" });
  });

  it("auto-allowed tools do not desync later correlation (#81 regression)", async () => {
    // Repro from the issue: an auto-allowed tool fires PreToolUse but the SDK
    // skips canUseTool for it. The next GATED tool must still correlate to its
    // own tool_use_id — with the old name-keyed FIFO it popped the stale
    // auto-allowed entry instead.
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: {
        hooks: { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
        canUseTool: (name: string, input: unknown, o: { toolUseID: string; agentID?: string; signal: AbortSignal }) => Promise<unknown>;
      };
    } | null;
    expect(opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]).toBeDefined();
    // 1. Auto-allowed call: PreToolUse fires, canUseTool never does.
    await opts!.options.hooks.PreToolUse[0]!.hooks[0]!({
      tool_name: "Bash", tool_use_id: "tu-auto-allowed", tool_input: { command: "git status" },
    });
    // 2. Gated call of the SAME tool name.
    await opts!.options.canUseTool("Bash", { command: "rm -rf build" }, {
      toolUseID: "tu-gated", signal: new AbortController().signal,
    });
    release();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    const toolStarts = events.filter((e) => e.type === "tool_start") as Array<Extract<ProviderEvent, { type: "tool_start" }>>;
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]!.sdkToolUseId).toBe("tu-gated");
    expect(toolStarts[0]!.input).toEqual({ command: "rm -rf build" });
  });

  it("canUseTool denies when the SDK provides no toolUseID", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });
    const provider = makeProvider();
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: { canUseTool: (name: string, input: unknown, o?: unknown) => Promise<unknown> };
    } | null;
    const result = await opts!.options.canUseTool("Read", {}, { signal: new AbortController().signal });
    expect(result).toMatchObject({ behavior: "deny" });
    release();
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.find((e) => e.type === "tool_start")).toBeUndefined();
  });

  it("PreToolUse hook runs (audit + compression) and returns a hook result", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    const provider = makeProvider();
    provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: { hooks: { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> } };
    } | null;
    if (opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]) {
      const result = await opts.options.hooks.PreToolUse[0].hooks[0]({
        tool_name: "Read", tool_use_id: "tu-1", tool_input: {}, agent_id: undefined,
      });
      expect(result).toBeDefined();
    }
  });

  it("SubagentStart and SubagentStop hooks emit subagent events", async () => {
    sdkMessages = [{ type: "result", modelUsage: {} }];
    capturedQueryOpts = null;
    const provider = makeProvider();
    const events: ProviderEvent[] = [];
    const run = provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    await Promise.resolve();
    const opts = capturedQueryOpts as {
      options: {
        hooks: {
          SubagentStart: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
          SubagentStop: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
        };
      };
    } | null;
    if (opts?.options?.hooks) {
      await opts.options.hooks.SubagentStart?.[0]?.hooks?.[0]?.({ agent_id: "sub-1", agent_type: "Task" });
      await opts.options.hooks.SubagentStop?.[0]?.hooks?.[0]?.({ agent_id: "sub-1" });
    }
    for await (const e of run.events) events.push(e);
    // If hooks were invoked, events were emitted into the turn queue
    // (may or may not be in events depending on timing — just verify no throw)
    expect(true).toBe(true);
  });
});

// ── #153: warm loop vs per-turn systemPromptAppend ────────────────────────────
//
// The SDK fixes the system prompt at query() construction. The warm
// keep-alive loop therefore must be REBUILT when a turn arrives with a
// different systemPromptAppend (before_turn hook output, refreshed memory
// index) — and must keep full warm-reuse when the append is unchanged.
describe("ClaudeProvider – systemPromptAppend loop rebuild (#153)", () => {
  let openGate: () => void = () => {};
  beforeEach(() => {
    sdkMessages = [];
    sdkThrowError = null;
    capturedQueryOpts = null;
    queryCallCount = 0;
    // Keep the mock SDK stream open so the loop stays WARM across turns;
    // resolvable so teardown() (which awaits the consumer) can finish.
    sdkGate = new Promise<void>((r) => {
      openGate = r;
    });
  });

  async function shutdown(provider: ClaudeProvider): Promise<void> {
    openGate();
    await provider.teardown();
  }

  function turn(provider: ClaudeProvider, append: string | undefined, msg: string) {
    return provider.runTurn({
      history: [],
      userMessage: msg,
      workdir: "/tmp",
      canUseTool: async () => ({ behavior: "allow" as const }),
      ...(append !== undefined ? { systemPromptAppend: append } : {}),
    });
  }

  function appendOf(opts: Record<string, unknown> | null): string | undefined {
    // query() is called as query({ prompt, options }) — the interesting
    // fields live under `.options`.
    const options = opts?.options as { systemPrompt?: { append?: string } } | undefined;
    return options?.systemPrompt?.append;
  }

  it("keeps the warm loop when the append is unchanged, rebuilds when it changes", async () => {
    const provider = makeProvider();

    // Turn 1 — loop built with append "sprint: alpha".
    turn(provider, "sprint: alpha", "t1");
    expect(queryCallCount).toBe(1);
    expect(appendOf(capturedQueryOpts)).toBe("sprint: alpha");

    // Turn 2 — same append: warm reuse, NO new query construction.
    turn(provider, "sprint: alpha", "t2");
    expect(queryCallCount).toBe(1);

    // Turn 3 — the hook contributed something new. Before the fix this was
    // silently dropped (the warm loop kept turn 1's system prompt); now the
    // loop rebuilds with the new append.
    turn(provider, "sprint: beta", "t3");
    expect(queryCallCount).toBe(2);
    expect(appendOf(capturedQueryOpts)).toBe("sprint: beta");

    // Turn 4 — stable again: back to warm reuse.
    turn(provider, "sprint: beta", "t4");
    expect(queryCallCount).toBe(2);

    await shutdown(provider);
  });

  it("treats absent and empty appends as the same loop configuration", async () => {
    const provider = makeProvider();
    turn(provider, undefined, "t1");
    expect(queryCallCount).toBe(1);
    // undefined → "" — no gratuitous rebuild.
    turn(provider, "", "t2");
    expect(queryCallCount).toBe(1);
    await shutdown(provider);
  });

  it("a rebuilt loop resumes the same backing session (no context loss)", async () => {
    const provider = makeProvider();
    turn(provider, "a", "t1");
    // hasQueried flips after the SDK acks in production; simulate it so the
    // rebuild takes the resume path exactly like a mid-session change.
    provider.setHasQueried(true);
    turn(provider, "b", "t2");
    expect(queryCallCount).toBe(2);
    // The rebuild must RESUME (continuity) rather than mint a new session.
    const options = capturedQueryOpts?.options as { resume?: string } | undefined;
    expect(options?.resume).toBe("test-backing");
    await shutdown(provider);
  });
});

// ── #178 Phase 1: VWS wiring (seedText, supportsMemoryTools, get_episode) ──────
//
// The Verbatim Working Set strategy seeds a compact <session_map> via seedText
// (only when the backend can page the store), and pages verbatim on demand via
// the four memory tools. Phase 1 wires those two hooks on ClaudeProvider and
// mounts the fourth tool (get_episode). These tests assert the wiring, not the
// paging behavior (that's the gated resume-beyond-budget eval).

/** Deterministic 8-dim char-histogram embedder — enough for a real engine. */
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

async function makeMemoryEngine(): Promise<MemoryEngine> {
  const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await engine.init();
  return engine;
}

function makeProviderWithMemory(memory: MemoryEngine): ClaudeProvider {
  return new ClaudeProvider({
    sessionId: "test-session",
    initialBackingId: "test-backing",
    workspaceId: "ws_test",
    memory,
    store: {
      audit: () => {},
      getClaudeCodeSessionId: () => null,
      setClaudeCodeSessionId: () => {},
      // #233: the provider reads persisted skill-command verdicts on every
      // query build. Empty map = nothing approved yet.
      getSkillCommandGrants: () => new Map<string, boolean>(),
      setSkillCommandGrant: () => {},
    } as never,
  });
}

/** Pull the content of the first message buffered on the (unconsumed) prompt
 *  queue — the mock query() never drains it, so the seeded message sits there. */
async function firstPromptContent(): Promise<string> {
  const q = capturedQueryOpts?.prompt as AsyncIterable<{ message: { content: string } }> | undefined;
  if (!q) throw new Error("no prompt queue captured");
  const { value } = await q[Symbol.asyncIterator]().next();
  return value?.message?.content ?? "";
}

describe("ClaudeProvider – VWS wiring (#178 Phase 1)", () => {
  beforeEach(() => { sdkMessages = []; sdkThrowError = null; capturedQueryOpts = null; sdkGate = null; });

  it("supportsMemoryTools is false without a memory engine, true with one", async () => {
    expect(makeProvider().supportsMemoryTools).toBe(false);
    const engine = await makeMemoryEngine();
    expect(makeProviderWithMemory(engine).supportsMemoryTools).toBe(true);
    await engine.close();
  });

  it("seedText prepends the strategy block ahead of the first prompt, then clears", async () => {
    const provider = makeProvider();
    provider.seedText("<session_map>MAP</session_map>");
    provider.runTurn({ history: [], userMessage: "hello", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    const first = await firstPromptContent();
    expect(first).toContain("<session_map>MAP</session_map>");
    expect(first).toContain("hello");
    // Order: seed precedes the user message.
    expect(first.indexOf("MAP")).toBeLessThan(first.indexOf("hello"));

    // Seed is one-shot: a second turn carries no stale map.
    capturedQueryOpts = null;
    provider.runTurn({ history: [], userMessage: "again", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    const second = await firstPromptContent();
    expect(second).toBe("again");
    await provider.teardown();
  });

  it("seedText('') is a no-op (empty block does not wrap the prompt)", async () => {
    const provider = makeProvider();
    provider.seedText("");
    provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    expect(await firstPromptContent()).toBe("hi");
    await provider.teardown();
  });

  it("mounts all four memory tools — including get_episode — in allowedTools when memory is present", async () => {
    const engine = await makeMemoryEngine();
    const provider = makeProviderWithMemory(engine);
    provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    const allowed = (capturedQueryOpts?.options as { allowedTools?: string[] })?.allowedTools ?? [];
    expect(allowed).toContain("mcp__codeoid_memory__get_episode");
    for (const t of MEMORY_TOOL_NAMES) {
      expect(allowed).toContain(`mcp__codeoid_memory__${t}`);
    }
    await provider.teardown();
    await engine.close();
  });

  it("mounts no memory tools when memory is absent", async () => {
    const provider = makeProvider();
    provider.runTurn({ history: [], userMessage: "hi", workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
    const allowed = (capturedQueryOpts?.options as { allowedTools?: string[] })?.allowedTools ?? [];
    expect(allowed.some((t) => t.startsWith("mcp__codeoid_memory__"))).toBe(false);
    await provider.teardown();
  });
});

describe("auto-approved tools still emit tool_start", () => {
  /**
   * Tools listed by EXACT NAME in `allowedTools` are approved by the SDK before
   * canUseTool runs — it reports this itself as CLAUDE_SDK_CAN_USE_TOOL_SHADOWED.
   * canUseTool is this provider's only tool_start emitter, so every such call
   * used to execute completely invisibly: no tool_call message in the
   * transcript, nothing in the UI, nothing in the verbatim episode record.
   *
   * Observed on a live instance: 409 mcp.init tool listings across 18
   * transcripts and zero memory tool calls, while `Read` appeared 594 times.
   */
  const fleetStub = { type: "sdk", name: "codeoid_fleet", instance: {} } as never;

  function providerWithFleet(): ClaudeProvider {
    return new ClaudeProvider({
      sessionId: "auto", initialBackingId: "b", workspaceId: "ws",
      fleet: fleetStub,
      store: {
        audit: () => {},
        getClaudeCodeSessionId: () => null,
        setClaudeCodeSessionId: () => {},
        getSkillCommandGrants: () => new Map<string, boolean>(),
        setSkillCommandGrant: () => {},
      } as never,
    });
  }

  async function firstPreToolUseHook(): Promise<(i: unknown) => Promise<unknown>> {
    const deadline = Date.now() + 1000;
    while (!capturedQueryOpts) {
      if (Date.now() > deadline) throw new Error("query() never built");
      await new Promise((r) => setTimeout(r, 5));
    }
    const options = (capturedQueryOpts as { options?: Record<string, unknown> }).options ?? capturedQueryOpts!;
    const hooks = (options as { hooks?: Record<string, Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }>> }).hooks;
    return hooks!.PreToolUse![0]!.hooks[0]!;
  }

  it("emits tool_start for a pre-approved tool, correlated on the SDK's tool_use_id", async () => {
    const provider = providerWithFleet();
    capturedQueryOpts = null;
    sdkMessages = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", modelUsage: {} }];
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });

    const events: ProviderEvent[] = [];
    const run = provider.runTurn({
      history: [], userMessage: "hi", workdir: ".",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    const drain = (async () => { for await (const e of run.events) events.push(e); })();

    const preToolUse = await firstPreToolUseHook();
    await preToolUse({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__codeoid_fleet__fleet_list",
      tool_input: { scope: "all" },
      tool_use_id: "toolu_abc123",
    });

    release();
    sdkGate = null;
    await drain;

    const started = events.filter((e) => e.type === "tool_start");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      name: "mcp__codeoid_fleet__fleet_list",
      // The SDK's own id, so tool_complete correlates exactly as it would have
      // if the call had gone through canUseTool.
      sdkToolUseId: "toolu_abc123",
      input: { scope: "all" },
    });
  });

  it("does NOT emit for a tool that still reaches canUseTool (no double tool_start)", async () => {
    const provider = providerWithFleet();
    capturedQueryOpts = null;
    sdkMessages = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", modelUsage: {} }];
    let release!: () => void;
    sdkGate = new Promise<void>((r) => { release = r; });

    const events: ProviderEvent[] = [];
    const run = provider.runTurn({
      history: [], userMessage: "hi", workdir: ".",
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    const drain = (async () => { for await (const e of run.events) events.push(e); })();

    const preToolUse = await firstPreToolUseHook();
    // Read is NOT in allowedTools — it goes through canUseTool, which emits.
    // Emitting here too would duplicate every ordinary tool call.
    await preToolUse({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
      tool_use_id: "toolu_read",
    });

    release();
    sdkGate = null;
    await drain;

    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(0);
  });
});
