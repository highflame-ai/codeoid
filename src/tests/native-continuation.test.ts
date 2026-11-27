/**
 * Native continuation (#387): forks, rewinds and backend switches hand the
 * conversation to Claude and Codex in their OWN form — a fork of the
 * backend's conversation at the turn, or native history codeoid builds —
 * with the transcript seed as the fallback.
 *
 * The provider tests here run offline (a scripted SDK seam for Claude, the
 * fake codex app-server for Codex). The behaviours they encode were verified
 * against the real CLIs in the #387 spike; the live end-to-end run is in the
 * PR's Verification section.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { type CanonicalTurn, CanonicalHistoryAccumulator, fitTurnsToBudget, canonicalTurnChars } from "../daemon/providers/canonical.js";
import { ClaudeProvider, translateSDKMessage, type ClaudeNativeSdk, type TranslateState } from "../daemon/providers/claude/index.js";
import { claudeProjectDirName, toClaudeSessionEntries, type ClaudeSessionEntry } from "../daemon/providers/claude/native-history.js";
import { CodexProvider } from "../daemon/providers/codex/index.js";
import { toResponsesItems } from "../daemon/providers/codex/native-history.js";
import type { NormalizedTurnResult, ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { HookBus } from "../daemon/hooks/bus.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, SessionInfo, SessionMessage } from "../protocol/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const user = (content: string): CanonicalTurn => ({ role: "user", content });
const assistant = (content: string, over: Partial<Extract<CanonicalTurn, { role: "assistant" }>> = {}): CanonicalTurn => ({
  role: "assistant",
  content,
  providerId: "claude",
  model: "claude-test",
  ...over,
});
const tool = (name: string, input: Record<string, unknown>, output: string, over: { originalName?: string; success?: boolean } = {}) => ({
  id: `t-${name}`,
  name,
  input,
  output,
  success: over.success ?? true,
  ...(over.originalName ? { originalName: over.originalName } : {}),
});

// ── Converters ───────────────────────────────────────────────────────────────

describe("canonical history as a Claude session", () => {
  const history: CanonicalTurn[] = [
    user("What's in config.yml?"),
    assistant("It sets the port to 7400.", {
      toolCalls: [tool("read_file", { file_path: "config.yml" }, "port: 7400", { originalName: "Read" })],
    }),
    user("And from codex?"),
    assistant("Codex ran ls.", { providerId: "codex", toolCalls: [tool("run_shell", { command: ["ls"] }, "a.txt", { originalName: "shell" })] }),
  ];

  it("is one chained conversation, alternating, with every tool_use answered by its tool_result", () => {
    const { entries } = toClaudeSessionEntries(history, { sessionId: "s1", cwd: "/w", maxChars: 1e6 });
    // Chained oldest first: each entry's parent is the one before it.
    entries.forEach((e, i) => expect(e.parentUuid).toBe(i === 0 ? null : entries[i - 1]!.uuid));
    expect(new Set(entries.map((e) => e.uuid)).size).toBe(entries.length);
    expect(entries.every((e) => e.sessionId === "s1" && e.cwd === "/w" && !e.isSidechain)).toBe(true);
    // user → tool_use → tool_result → text → user → tool_use → tool_result → text
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    const content = (e: ClaudeSessionEntry) => (e.message as { content: unknown }).content as Array<Record<string, unknown>>;
    const use = content(entries[1]!)[0]!;
    const result = content(entries[2]!)[0]!;
    expect(use.type).toBe("tool_use");
    expect(String(use.id)).toMatch(/^toolu_[0-9a-f]{24}$/);
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: use.id, content: "port: 7400" });
    expect(content(entries[3]!)[0]).toEqual({ type: "text", text: "It sets the port to 7400." });
  });

  it("names a tool by Claude's own name when Claude ran it, by the neutral name when another backend did", () => {
    const { entries } = toClaudeSessionEntries(history, { sessionId: "s1", cwd: "/w", maxChars: 1e6 });
    const names = entries
      .filter((e) => e.type === "assistant")
      .flatMap((e) => ((e.message as { content: Array<{ type: string; name?: string }> }).content).filter((b) => b.type === "tool_use").map((b) => b.name));
    expect(names).toEqual(["Read", "run_shell"]);
  });

  it("merges user turns that got no reply, closes an unanswered last turn, marks failed tools, and makes names API-safe", () => {
    const { entries } = toClaudeSessionEntries(
      [user("first"), user("second"), assistant("", { toolCalls: [tool("mcp.server/do it", {}, "boom", { success: false })] }), user("third")],
      { sessionId: "s", cwd: "/w", maxChars: 1e6 },
    );
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect((entries[0]!.message as { content: string }).content).toBe("first\n\nsecond");
    const use = ((entries[1]!.message as { content: Array<{ name: string }> }).content)[0]!;
    expect(use.name).toBe("mcp_server_do_it");
    expect(((entries[2]!.message as { content: Array<{ is_error?: boolean }> }).content)[0]!.is_error).toBe(true);
    expect(((entries.at(-1)!.message as { content: Array<{ text: string }> }).content)[0]!.text).toContain("ended before a reply");
  });

  it("drops the oldest turns past the budget and says so first", () => {
    const long = Array.from({ length: 10 }, (_, i) => [user(`q${i} ${"x".repeat(500)}`), assistant(`a${i} ${"y".repeat(500)}`)]).flat();
    const { entries, truncation } = toClaudeSessionEntries(long, { sessionId: "s", cwd: "/w", maxChars: 3_000 });
    expect(truncation.omittedTurns).toBeGreaterThan(0);
    expect(truncation.keptTurns + truncation.omittedTurns).toBe(20);
    expect((entries[0]!.message as { content: string }).content).toContain(`${truncation.omittedTurns} earlier turn(s)`);
    expect(entries[0]!.type).toBe("user");
  });

  it("files the session exactly where Claude Code would, long paths included", () => {
    expect(claudeProjectDirName("/tmp/spikeB-zI29Li")).toBe("-tmp-spikeB-zI29Li");
    // The SDK: over 200 chars → the first 200, "-", then |31-hash| in base 36.
    const deep = `/${"a".repeat(300)}`;
    let h = 0;
    for (const ch of deep) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
    expect(claudeProjectDirName(deep)).toBe(`-${"a".repeat(199)}-${Math.abs(h).toString(36)}`);
  });
});

describe("canonical history as Codex items", () => {
  it("pairs each call with its output, names tools honestly, and marks failures", () => {
    const { items } = toResponsesItems(
      [
        user("list it"),
        assistant("done", { providerId: "codex", toolCalls: [tool("run_shell", { command: ["ls"] }, "a.txt", { originalName: "shell" })] }),
        assistant("read", { toolCalls: [tool("read_file", { file_path: "x" }, "denied", { originalName: "Read", success: false })] }),
      ],
      { maxChars: 1e6 },
    );
    expect(items.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output", "message", "function_call", "function_call_output", "message"]);
    const calls = items.filter((i) => i.type === "function_call") as Array<{ name: string; call_id: string; arguments: string }>;
    expect(calls.map((c) => c.name)).toEqual(["shell", "read_file"]);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ command: ["ls"] });
    const outs = items.filter((i) => i.type === "function_call_output") as Array<{ call_id: string; output: string }>;
    expect(outs.map((o) => o.call_id)).toEqual(calls.map((c) => c.call_id));
    expect(outs[1]!.output).toBe("Error: denied");
  });
});

describe("fitting history to a budget", () => {
  it("keeps the newest whole turns, and cuts the newest down when it alone is too big", () => {
    const h = [user(`old ${"o".repeat(4_000)}`), assistant("big", { toolCalls: [tool("read_file", {}, "z".repeat(50_000))] })];
    const { turns, truncation } = fitTurnsToBudget(h, 5_000, canonicalTurnChars);
    expect(truncation).toMatchObject({ omittedTurns: 1, keptTurns: 1, newestTurnSliced: true });
    expect(canonicalTurnChars(turns[0]!)).toBeLessThan(6_000);
    expect((turns[0] as { toolCalls: Array<{ output: string }> }).toolCalls[0]!.output).toContain("truncated to fit");
  });
});

// ── Where a turn ends, natively ──────────────────────────────────────────────

describe("Claude records where each turn ends in its own session", () => {
  it("is the last main-conversation entry — not a subagent's, not a replayed one", () => {
    const events: ProviderEvent[] = [];
    const state: TranslateState = { lastLocalCommandStderr: null, primaryModel: "claude-test" };
    const feed = (m: Record<string, unknown>) => translateSDKMessage(m as never, (e) => events.push(e), "claude", state);
    feed({ type: "user", uuid: "old", isReplay: true, parent_tool_use_id: null, message: { content: "replayed" } });
    feed({ type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } });
    feed({ type: "user", uuid: "u1", parent_tool_use_id: null, message: { content: [] } });
    feed({ type: "assistant", uuid: "a2", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } });
    feed({ type: "assistant", uuid: "sub", parent_tool_use_id: "toolu_x", message: { content: [{ type: "text", text: "sub" }] } });
    feed({ type: "result", subtype: "success", session_id: "backing-1", num_turns: 2, usage: {} });
    const done = events.find((e) => e.type === "turn_done") as { result: NormalizedTurnResult };
    expect(done.result.nativeRef).toEqual({ backingId: "backing-1", ref: "a2" });
    // ...and the next turn starts clean.
    feed({ type: "result", subtype: "success", session_id: "backing-1", num_turns: 1, usage: {} });
    expect((events.filter((e) => e.type === "turn_done")[1] as { result: NormalizedTurnResult }).result.nativeRef).toBeUndefined();
  });

  it("an errored or budget-stopped turn is no point to fork at", () => {
    for (const result of [
      { subtype: "error_during_execution", is_error: true },
      { subtype: "success", is_error: true, result: "Prompt is too long" },
      { subtype: "error_max_budget_usd" },
    ]) {
      const events: ProviderEvent[] = [];
      const state: TranslateState = { lastLocalCommandStderr: null, primaryModel: "m" };
      translateSDKMessage({ type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { content: [] } } as never, (e) => events.push(e), "claude", state);
      translateSDKMessage({ type: "result", session_id: "b", num_turns: 1, usage: {}, ...result } as never, (e) => events.push(e), "claude", state);
      expect((events.find((e) => e.type === "turn_done") as { result: NormalizedTurnResult }).result.nativeRef).toBeUndefined();
    }
  });

  it("names the project dir the session is filed under, so a fork looks only there", () => {
    const events: ProviderEvent[] = [];
    const state: TranslateState = { lastLocalCommandStderr: null, primaryModel: "m", cwd: "/work/repo" };
    translateSDKMessage({ type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { content: [] } } as never, (e) => events.push(e), "claude", state);
    translateSDKMessage({ type: "result", subtype: "success", session_id: "b", num_turns: 1, usage: {} } as never, (e) => events.push(e), "claude", state);
    expect((events.find((e) => e.type === "turn_done") as { result: NormalizedTurnResult }).result.nativeRef).toEqual({ backingId: "b", ref: "a1", dir: "/work/repo" });
  });

  it("is stamped on the canonical turn, so forks and restarts can find it", () => {
    const acc = new CanonicalHistoryAccumulator();
    acc.pushUserTurn("go", "turn-1");
    acc.handleEvent({ type: "text_done", content: "ok" } as ProviderEvent);
    acc.handleEvent({
      type: "turn_done",
      result: { providerId: "claude", model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 0, nativeRef: { backingId: "b", ref: "r" } },
    });
    expect(acc.history.at(-1)).toMatchObject({ role: "assistant", native: { backingId: "b", ref: "r" } });
  });
});

// ── Claude: continueNatively ─────────────────────────────────────────────────

describe("ClaudeProvider.continueNatively", () => {
  let configDir: string;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "claude-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    rmSync(configDir, { recursive: true, force: true });
  });

  /** A seam that reads back what was written, like the SDK's own reader. */
  const sdk = (over: Partial<ClaudeNativeSdk> = {}): ClaudeNativeSdk & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      forkSession: async (id, opts) => {
        calls.push(`fork ${id} ${opts.upToMessageId}`);
        return { sessionId: "forked-1" };
      },
      getSessionMessages: async (id, opts) => {
        calls.push(`read ${id}${opts?.dir ? ` ${opts.dir}` : ""}`);
        // No dir: the fork read-back. The forked session exists.
        if (!opts?.dir) return id === "forked-1" || id === "f2" ? [{ uuid: "x" }] : [];
        const file = join(configDir, "projects", claudeProjectDirName(opts.dir), `${id}.jsonl`);
        return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { uuid: string });
      },
      ...over,
    };
  };
  const provider = (nativeSdk: ClaudeNativeSdk) =>
    new ClaudeProvider({ sessionId: "sess", initialBackingId: "fresh-backing", workspaceId: "ws", store: {} as never, nativeSdk });
  const history = [user("hello"), assistant("hi there")];

  it("same backend: forks Claude's own session at the turn and resumes it", async () => {
    const s = sdk();
    const p = provider(s);
    const r = await p.continueNatively({ history, forkFrom: { backingId: "parent-b", ref: "uuid-9" }, maxChars: 1e6, workdir: "/w" });
    expect(r).toEqual({ via: "fork", backingId: "forked-1" });
    expect(s.calls).toEqual(["fork parent-b uuid-9", "read forked-1"]);
    // With the source's dir, the lookup is pinned there.
    let seen: unknown;
    const pinned = provider(
      sdk({
        forkSession: async (_id, o) => {
          seen = o;
          return { sessionId: "f2" };
        },
      }),
    );
    await pinned.continueNatively({ history, forkFrom: { backingId: "parent-b", ref: "uuid-9", dir: "/src/repo" }, maxChars: 1e6, workdir: "/w" });
    expect(seen).toEqual({ upToMessageId: "uuid-9", dir: "/src/repo" });
    expect(p.backingSessionId).toBe("forked-1");
    expect(p.hasQueried).toBe(true); // resume, not create
  });

  it("a fork that reads back empty is not adopted — history is built instead", async () => {
    const s = sdk({ forkSession: async () => ({ sessionId: "ghost" }) });
    const p = provider(s);
    const workdir = join(configDir, "work-ghost");
    mkdirSync(workdir);
    const r = await p.continueNatively({ history, forkFrom: { backingId: "parent-b", ref: "uuid-9" }, maxChars: 1e6, workdir });
    expect(r?.via).toBe("history");
    expect(p.backingSessionId).not.toBe("ghost");
  });

  it("when the fork source is gone, builds the session from history instead — and verifies it with the SDK's reader", async () => {
    const s = sdk({ forkSession: async () => Promise.reject(new Error("Session parent-b not found")) });
    const p = provider(s);
    const workdir = join(configDir, "work");
    mkdirSync(workdir);
    const r = await p.continueNatively({ history, forkFrom: { backingId: "parent-b", ref: "uuid-9" }, maxChars: 1e6, workdir });
    expect(r?.via).toBe("history");
    const file = join(configDir, "projects", claudeProjectDirName(workdir), `${r!.backingId}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant"]);
    expect(p.backingSessionId).toBe(r?.backingId as string);
    expect(p.hasQueried).toBe(true);
  });

  it("told not to build history (restored turns), a failed fork resolves null rather than building it", async () => {
    const s = sdk({ forkSession: async () => Promise.reject(new Error("gone")) });
    const p = provider(s);
    expect(await p.continueNatively({ history, forkFrom: { backingId: "parent-b", ref: "uuid-9" }, maxChars: 1e6, workdir: "/w", allowHistory: false })).toBeNull();
    expect(s.calls.some((c) => c.startsWith("read "))).toBe(false);
  });

  it("a session the SDK can't read back exactly is removed, and the transcript is used instead", async () => {
    const s = sdk({ getSessionMessages: async () => [{ uuid: "only-one" }] });
    const p = provider(s);
    const workdir = join(configDir, "work2");
    mkdirSync(workdir);
    expect(await p.continueNatively({ history, maxChars: 1e6, workdir })).toBeNull();
    const dir = join(configDir, "projects", claudeProjectDirName(workdir));
    expect(existsSync(dir) ? require("node:fs").readdirSync(dir) : []).toEqual([]);
    expect(p.backingSessionId).toBe("fresh-backing");
    expect(p.hasQueried).toBe(false);
  });

  // ── A fork's copy of its parent's cloud agents (fork-isolation.ts, round 3 H-1) ──

  /**
   * A forkSession that, beside the JSONL, copies the parent's cloud agent
   * registrations (`<project>/<session>/remote-agents/`) — what the CLI
   * restores and polls on resume. The SDK doesn't copy them today; this is
   * the copy the fork must never resume with.
   */
  /** What forkSession mints: a session id (the clear refuses anything else). */
  const FORKED = "1f0c2a4e-7b3d-4c5e-9a8b-0d1e2f3a4b5c";
  const PARENT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const copyingSdk = (projectCwd: string, opts: { forkedId?: string; after?: (project: string) => void } = {}) => {
    const project = join(configDir, "projects", claudeProjectDirName(projectCwd));
    const registration = (taskId: string, spawnedAt: number) => JSON.stringify({ taskId, remoteTaskType: "remote-agent", sessionId: `cse_${taskId}`, title: "review", command: "review --fix", spawnedAt });
    const sidecar = (id: string) => join(project, id, "remote-agents");
    const forkedId = opts.forkedId ?? FORKED;
    mkdirSync(sidecar(PARENT), { recursive: true });
    writeFileSync(join(project, `${PARENT}.jsonl`), "{}\n");
    writeFileSync(join(sidecar(PARENT), "remote-agent-rparent1.meta.json"), registration("rparent1", Date.parse("2026-10-27T09:00:00.000Z")));
    return {
      project,
      sidecar,
      sdk: sdk({
        forkSession: async () => {
          if (forkedId !== PARENT) {
            writeFileSync(join(project, `${forkedId}.jsonl`), "{}\n");
            mkdirSync(sidecar(forkedId), { recursive: true });
            for (const name of readdirSync(sidecar(PARENT))) writeFileSync(join(sidecar(forkedId), name), readFileSync(join(sidecar(PARENT), name)));
            // One the fork itself launched, after its boundary (a rewind inside the fork re-forks it).
            writeFileSync(join(sidecar(forkedId), "remote-agent-rforkown.meta.json"), registration("rforkown", Date.parse("2026-10-27T11:00:00.000Z")));
            writeFileSync(join(sidecar(forkedId), "remote-agent-rbroken.meta.json"), "{not json");
          }
          opts.after?.(project);
          return { sessionId: forkedId };
        },
        getSessionMessages: async (id, o) => {
          if (!o?.dir) return [{ uuid: `read-${id}` }];
          const file = join(configDir, "projects", claudeProjectDirName(o.dir), `${id}.jsonl`);
          return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { uuid: string });
        },
      }),
    };
  };
  const forkProvider = (nativeSdk: ClaudeNativeSdk) =>
    new ClaudeProvider({
      sessionId: "sess", initialBackingId: "fresh-backing", workspaceId: "ws", store: {} as never, nativeSdk,
      forkBoundary: () => "2026-10-27T10:00:00.000Z",
      isForeignTask: (id) => id === "rparent1",
    });

  it("a fork's native copy is cleared of the parent's cloud agents before it is resumed; the parent's session is untouched", async () => {
    const { sdk: s, sidecar } = copyingSdk("/src/repo");
    const p = forkProvider(s);
    const r = await p.continueNatively({ history, forkFrom: { backingId: PARENT, ref: "uuid-9", dir: "/src/repo" }, maxChars: 1e6, workdir: "/w" });
    expect(r).toEqual({ via: "fork", backingId: FORKED });
    // The parent's (and an unreadable one) gone; the fork's own, spawned after its boundary, kept.
    expect(readdirSync(sidecar(FORKED))).toEqual(["remote-agent-rforkown.meta.json"]);
    expect(readdirSync(sidecar(PARENT))).toEqual(["remote-agent-rparent1.meta.json"]);
  });

  it("a session that isn't a fork keeps its own cloud agents across a rewind's native copy", async () => {
    const { sdk: s, sidecar } = copyingSdk("/src/repo");
    const p = provider(s);
    await p.continueNatively({ history, forkFrom: { backingId: PARENT, ref: "uuid-9", dir: "/src/repo" }, maxChars: 1e6, workdir: "/w" });
    expect(readdirSync(sidecar(FORKED)).length).toBe(3);
  });

  // ── Round 4 (L4-5, I4-2): the clear never reaches past the fork's own files ──

  /** A native fork the clear refused: built from history instead, and the abandoned copy (`forkedId`'s) removed. */
  const expectRefused = async (s: ClaudeNativeSdk, project: string, forkedId?: string) => {
    const r = await forkProvider(s).continueNatively({ history, forkFrom: { backingId: PARENT, ref: "uuid-9", dir: "/src/repo" }, maxChars: 1e6, workdir: join(configDir, "w") });
    expect(r?.via).toBe("history");
    if (forkedId) expect(existsSync(join(project, `${forkedId}.jsonl`))).toBe(false);
    // The parent's session and registrations are untouched.
    expect(existsSync(join(project, `${PARENT}.jsonl`))).toBe(true);
    expect(readdirSync(join(project, PARENT, "remote-agents"))).toEqual(["remote-agent-rparent1.meta.json"]);
  };

  it("refuses a sidecar that is a symlink, leaving what it points at alone", async () => {
    const elsewhere = join(configDir, "elsewhere");
    const { sdk: s, project } = copyingSdk("/src/repo", {
      after: (proj) => {
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, "remote-agent-rvictim.meta.json"), "{}");
        rmSync(join(proj, FORKED, "remote-agents"), { recursive: true });
        symlinkSync(elsewhere, join(proj, FORKED, "remote-agents"));
      },
    });
    await expectRefused(s, project, FORKED);
    expect(readdirSync(elsewhere)).toEqual(["remote-agent-rvictim.meta.json"]);
  });

  it("refuses a session dir that is a symlink: here, to the parent's own", async () => {
    const { sdk: s, project } = copyingSdk("/src/repo", {
      after: (proj) => {
        rmSync(join(proj, FORKED), { recursive: true });
        symlinkSync(join(proj, PARENT), join(proj, FORKED));
      },
    });
    await expectRefused(s, project, FORKED);
  });

  it("only a missing dir is empty: one it can't read refuses the fork", async () => {
    const { sdk: s, project } = copyingSdk("/src/repo", {
      after: (proj) => {
        rmSync(join(proj, FORKED, "remote-agents"), { recursive: true });
        writeFileSync(join(proj, FORKED, "remote-agents"), "not a dir");
      },
    });
    await expectRefused(s, project, FORKED);
  });

  it("refuses a forked id that isn't a session id, or is the source's own, and removes nothing by it", async () => {
    const odd = copyingSdk("/src/repo", { forkedId: "../forked" });
    await expectRefused(odd.sdk, odd.project);
    // Named by that id, outside any session: left alone.
    expect(existsSync(join(odd.project, "../forked.jsonl"))).toBe(true);
    rmSync(join(configDir, "projects"), { recursive: true, force: true });
    const same = copyingSdk("/src/repo", { forkedId: PARENT });
    await expectRefused(same.sdk, same.project);
  });
});

// ── Codex: continueNatively over the fake app-server ─────────────────────────

describe("CodexProvider.continueNatively", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex.ts");
  const saved: Array<[string, string]> = [];
  const codex = () =>
    new CodexProvider({
      sessionId: "sess-1",
      initialBackingId: "fresh-uuid",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: { setClaudeCodeSessionId: (s: string, id: string) => saved.push([s, id]) } as never,
    });
  const opts = (userMessage: string): TurnOpts => ({ history: [], userMessage, workdir: "/tmp", canUseTool: async () => ({ behavior: "allow" as const }) });
  async function collect(run: TurnRun): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const e of run.events) {
      events.push(e);
      if (e.type === "turn_done" || e.type === "error") break;
    }
    return events;
  }
  const text = (events: ProviderEvent[]) => events.filter((e) => e.type === "text_done").map((e) => (e as { content: string }).content).join("");
  beforeEach(() => {
    saved.length = 0;
  });

  it("same backend: forks the thread through the turn, adopts and saves it, and anchors its turns", async () => {
    const p = codex();
    const r = await p.continueNatively({ history: [user("x"), assistant("y", { providerId: "codex" })], forkFrom: { backingId: "codex-thread-9", ref: "turn-7" }, maxChars: 1e6, workdir: "/tmp" });
    expect(r).toEqual({ via: "fork" });
    const events = await collect(p.runTurn(opts("echo-native")));
    const calls = JSON.parse(text(events)) as Array<{ method: string; params: Record<string, unknown> }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "thread/fork", params: { threadId: "codex-thread-9", lastTurnId: "turn-7", cwd: "/tmp" } });
    expect(p.backingSessionId).toBe("codex-fork-1");
    expect(saved).toEqual([["sess-1", "codex-fork-1"]]);
    const done = events.find((e) => e.type === "turn_done") as { result: NormalizedTurnResult };
    expect(done.result.nativeRef).toEqual({ backingId: "codex-fork-1", ref: "turn-1" });
    await p.teardown();
  });

  it("another backend's history goes in as native items on a fresh thread", async () => {
    const p = codex();
    const r = await p.continueNatively({
      history: [user("read it"), assistant("it says hi", { toolCalls: [tool("read_file", { file_path: "a" }, "hi", { originalName: "Read" })] })],
      maxChars: 1e6,
      workdir: "/tmp",
    });
    expect(r).toEqual({ via: "history" });
    const calls = JSON.parse(text(await collect(p.runTurn(opts("echo-native"))))) as Array<{ method: string; params: { threadId: string; items: Array<{ type: string; name?: string }> } }>;
    expect(calls.map((c) => c.method)).toEqual(["thread/inject_items"]);
    expect(calls[0]!.params.threadId).toBe("codex-thread-1");
    expect(calls[0]!.params.items.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output", "message"]);
    expect(calls[0]!.params.items[1]!.name).toBe("read_file");
    expect(saved).toEqual([["sess-1", "codex-thread-1"]]);
    await p.teardown();
  });

  it("if the native fork fails, the turn says so and carries the transcript instead", async () => {
    const p = codex();
    await p.continueNatively({ history: [user("remember PELICAN"), assistant("noted", { providerId: "codex" })], forkFrom: { backingId: "gone-thread", ref: "t" }, maxChars: 1e6, workdir: "/tmp" });
    const events = await collect(p.runTurn(opts("echo-prompt")));
    const notice = events.find((e) => e.type === "custom_message") as { content: string; metadata: { event: string } } | undefined;
    expect(notice?.metadata.event).toBe("history.native_fallback");
    expect(notice?.content).toContain("text transcript");
    // Backend errors name rollout paths and thread ids: they stay in the daemon log.
    expect(notice?.content).not.toContain("gone-thread");
    expect(text(events)).toContain("<conversation-history>");
    expect(text(events)).toContain("remember PELICAN");
    expect(p.backingSessionId).toBe("codex-thread-1");
    await p.teardown();
  });
});

// ── The session picks the path ───────────────────────────────────────────────

const AUTH: AuthContext = { sub: "user:native", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc-n", projectId: "proj-n" };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };
const say = (text: string, providerId = "claude", nativeRef?: { backingId: string; ref: string }): ProviderEvent[] => [
  { type: "text_done", content: text } as ProviderEvent,
  {
    type: "turn_done",
    result: { providerId, model: "mock", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1, ...(nativeRef ? { nativeRef } : {}) },
  } as ProviderEvent,
];

describe("Session: native first, transcript as the fallback", () => {
  let tmp: string;
  let store: Store;
  let transcript: TranscriptStore;
  let managers: SessionManager[];
  let made: MockSessionProvider[];
  /** How each new provider answers continueNatively; undefined = it can't. */
  let nativeAnswer: ((req: Parameters<NonNullable<MockSessionProvider["continueNatively"]>>[0], p: MockSessionProvider) => Awaited<ReturnType<NonNullable<MockSessionProvider["continueNatively"]>>>) | undefined;

  const mkConfig = (session: Record<string, unknown> = {}): CodeoidConfig =>
    ({
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
      session,
      conductor: { enabled: false, name: "conductor", provider: "claude" },
    }) as CodeoidConfig;

  let identity: { registered: string[] } | undefined;
  /** Input tokens each scripted turn reports (the context size a fork of it starts at). */
  let turnInputTokens = 1;
  /** Replaces the scripted turns of every new provider, when set. */
  let script: ProviderEvent[][] | undefined;
  let hooks: HookBus | undefined;

  function manager(session: Record<string, unknown> = {}): SessionManager {
    const factory = (id: string) => ({
      id,
      displayName: id,
      create: () => {
        const big = (events: ProviderEvent[]) =>
          events.map((e) => (e.type === "turn_done" ? { ...e, result: { ...e.result, inputTokens: turnInputTokens } } : e)) as ProviderEvent[];
        const p = new MockSessionProvider(
          id,
          script ?? [big(say("a1", id, { backingId: `${id}-b1`, ref: "00000000-0000-0000-0000-0000000000e1" })), big(say("a2", id, { backingId: `${id}-b1`, ref: "00000000-0000-0000-0000-0000000000e2" })), say("a3", id), say("a4", id)],
        );
        // Like a real warm backend (claude, codex, pi), report the transcript it stashed.
        p.seedResultOverride = { text: "<conversation-history>…", totalTurns: 0, keptTurns: 0, omittedTurns: 0, newestTurnSliced: false };
        if (nativeAnswer) {
          const answer = nativeAnswer;
          p.scriptNative((req) => answer(req, p));
        }
        made.push(p);
        return p;
      },
    });
    const registry = new ProviderRegistry("claude");
    registry.register(factory("claude"));
    registry.register(factory("codex"));
    const im = identity
      ? ({
          registerSessionAgent: async (sessionId: string) => {
            identity!.registered.push(sessionId);
            return { wimseUri: `spiffe://test/agent/${sessionId}` };
          },
          deactivateSessionAgent: async () => {},
          getGatewayCredential: () => undefined,
        } as never)
      : undefined;
    const m = new SessionManager(store, transcript, im, undefined, undefined, { config: mkConfig(session), providers: registry, ...(hooks ? { hooks } : {}) });
    managers.push(m);
    return m;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-native-"));
    store = new Store(join(tmp, "codeoid.db"));
    transcript = new TranscriptStore(join(tmp, "transcripts"));
    managers = [];
    made = [];
    nativeAnswer = undefined;
    identity = undefined;
    turnInputTokens = 1;
    script = undefined;
    hooks = undefined;
  });
  afterEach(async () => {
    for (const m of managers) await m.drain(2_000).catch(() => {});
    await transcript.flush();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function newSession(m: SessionManager): Promise<string> {
    const workdir = join(tmp, "work");
    mkdirSync(workdir, { recursive: true });
    const r = await m.handle({ type: "session.create", id: "c", name: `n-${Math.random()}`, workdir }, AUTH, CLIENT);
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    return (r.data as { id: string }).id;
  }
  async function send(m: SessionManager, id: string, text: string): Promise<void> {
    const s = m._sessionForTest(id)!;
    await s.send(text, AUTH);
    for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
  }
  async function fork(m: SessionManager, id: string, extra: Record<string, unknown> = {}): Promise<SessionInfo> {
    const r = await m.handle({ type: "session.fork", id: "f", sessionId: id, isolate: false, ...extra } as never, AUTH, CLIENT);
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    return r.data as SessionInfo;
  }
  const notes = (m: SessionManager, id: string) => {
    const got: SessionMessage[] = [];
    m._sessionForTest(id)!.attach({ id: `w-${Math.random()}`, auth: AUTH, send: (msg) => {
      if (msg.type === "scrollback.replay") got.push(...(msg as { messages: SessionMessage[] }).messages);
    } });
    return got.filter((x) => x.role === "info").map((x) => x.content);
  };

  it("a same-backend fork forks natively from the parent's last turn, and the backend counts as holding it", async () => {
    nativeAnswer = (req) => ({ via: req.forkFrom ? "fork" : "history", backingId: "native-backing" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    await send(m, id, "two");
    const info = await fork(m, id);
    const req = made.at(-1)!.nativeRequests[0]!;
    expect(req.forkFrom).toEqual({ backingId: "claude-b1", ref: "00000000-0000-0000-0000-0000000000e2" });
    expect(req.history.map((t) => t.content)).toEqual(["one", "a1", "two", "a2"]);
    expect(store.getClaudeCodeSessionId(info.id)).toBe("native-backing");
    // It holds the conversation already, so a restart resumes it rather than re-seeding.
    await Bun.sleep(20);
    expect((JSON.parse(readFileSync(transcript.metaPath(info.id), "utf8")) as { backingFresh?: boolean }).backingFresh).toBeUndefined();
    expect(notes(m, info.id).some((n) => n.includes("continues its own conversation"))).toBe(true);
    // No transcript was stashed alongside.
    expect(made.at(-1)!.seededHistory).toBeNull();
  });

  it("never forks natively past a hook's redaction — the backend's record still has the original", async () => {
    nativeAnswer = (req) => ({ via: req.forkFrom ? "fork" : "history", backingId: "nb" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const s = m._sessionForTest(id)!;
    const h = s.canonicalHistory as CanonicalTurn[];
    const last = h.at(-1) as Extract<CanonicalTurn, { role: "assistant" }>;
    last.toolCalls = [{ id: "t", name: "run_shell", input: {}, output: "[redacted]", success: true, redacted: true }];
    await fork(m, id);
    const req = made.at(-1)!.nativeRequests[0]!;
    expect(req.forkFrom).toBeUndefined(); // rebuilt from codeoid's redacted record instead
    expect(req.history.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("once a hook redacts output in a backing, every later turn of it is marked — no native fork, even where the redacted call isn't in view", async () => {
    hooks = new HookBus([{ event: "tool_result", type: "command", command: `printf '{"updatedOutput":"[REDACTED]"}'` }]);
    const ref = (n: number) => ({ backingId: "claude-b1", ref: `00000000-0000-0000-0000-00000000000${n}` });
    script = [
      [
        { type: "tool_start", toolId: "t1", sdkToolUseId: "su1", name: "Bash", input: { command: "cat .env" }, approvalId: "ap1" } as ProviderEvent,
        { type: "tool_complete", sdkToolUseId: "su1", output: "API_KEY=hunter2", success: true } as ProviderEvent,
        ...say("read it", "claude", ref(1)),
      ],
      say("later", "claude", ref(2)),
    ];
    nativeAnswer = (req) => ({ via: req.forkFrom ? "fork" : "history", backingId: "nb" });
    const m = manager();
    const id = await newSession(m);
    await m.handle({ type: "session.set_mode", id: "md", sessionId: id, mode: "autonomous", maxTurns: 10 } as never, AUTH, CLIENT);
    await send(m, id, "one");
    await send(m, id, "two");
    const h = m._sessionForTest(id)!.canonicalHistory;
    const first = h[1] as Extract<CanonicalTurn, { role: "assistant" }>;
    expect(first.toolCalls?.[0]).toMatchObject({ output: "[REDACTED]", redacted: true });
    // The later turn has no redacted call of its own, but its backing does.
    expect((h.at(-1) as Extract<CanonicalTurn, { role: "assistant" }>).native).toMatchObject({ ...ref(2), redacted: true });
    // Durable the moment it happened: in the meta a restart reads.
    const meta = JSON.parse(readFileSync(transcript.metaPath(id), "utf8")) as { redactedBackings?: string[] };
    expect(meta.redactedBackings).toContain("claude-b1");
    const forked = await fork(m, id);
    expect(made.at(-1)!.nativeRequests[0]!.forkFrom).toBeUndefined();
    // ...and the fork inherits it, so its own rewinds can't fork that backing either.
    expect(m._sessionForTest(forked.id)!.redactedBackings).toContain("claude-b1");

    // A restart that loads only the newest turns still knows — and keeps
    // marking that backing's new turns, though nothing in them was redacted.
    script = undefined;
    hooks = undefined;
    const m2 = manager();
    const id2 = await newSession(m2);
    const s2 = m2._sessionForTest(id2)!;
    s2.restoreTurns([user("two"), assistant("later", { native: { ...ref(2), redacted: true } })], [], { persistHistory: true, persistIndex: false, partial: true });
    await send(m2, id2, "three");
    expect((s2.canonicalHistory.at(-1) as Extract<CanonicalTurn, { role: "assistant" }>).native).toMatchObject({ backingId: "claude-b1", redacted: true });
    await fork(m2, id2);
    expect(made.at(-1)!.nativeRequests[0]!.forkFrom).toBeUndefined();
  });

  it("turns rebuilt from a displayed transcript stay a transcript — never native history in the assistant's voice", async () => {
    nativeAnswer = () => ({ via: "history", backingId: "nb" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const last = m._sessionForTest(id)!.canonicalHistory.at(-1) as Extract<CanonicalTurn, { role: "assistant" }>;
    last.restored = true; // rebuilt turns never carry a native point
    delete last.native;
    await fork(m, id);
    expect(made.at(-1)!.nativeRequests).toEqual([]);
    expect(made.at(-1)!.seededHistory).not.toBeNull();
  });

  it("an imported session with a real turn since may still fork natively — but is never rebuilt as native history", async () => {
    nativeAnswer = (req) => (req.forkFrom ? { via: "fork", backingId: "nb" } : null);
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    await send(m, id, "two");
    const first = m._sessionForTest(id)!.canonicalHistory[1] as Extract<CanonicalTurn, { role: "assistant" }>;
    first.restored = true;
    await fork(m, id);
    const req = made.at(-1)!.nativeRequests[0]!;
    expect(req.forkFrom).toBeDefined(); // the backend's own record, not the rebuilt text
    expect(req.allowHistory).toBe(false);
  });

  it("a malformed native point is not acted on", async () => {
    nativeAnswer = (req) => ({ via: req.forkFrom ? "fork" : "history", backingId: "nb" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const last = m._sessionForTest(id)!.canonicalHistory.at(-1) as Extract<CanonicalTurn, { role: "assistant" }>;
    last.native = { backingId: "../../etc", ref: "x" };
    await fork(m, id);
    expect(made.at(-1)!.nativeRequests[0]!.forkFrom).toBeUndefined();
  });

  it("a natively continued fork still registers its own agent identity on its first send", async () => {
    identity = { registered: [] };
    nativeAnswer = (req) => ({ via: req.forkFrom ? "fork" : "history", backingId: "native-backing" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const info = await fork(m, id);
    expect(made.at(-1)!.hasQueried).toBe(true); // resumes the adopted session...
    await send(m, info.id, "two");
    expect(identity.registered).toEqual([id, info.id]); // ...and is still its own agent
  });

  it("doesn't fork natively when the parent's context was already near the target's window", async () => {
    turnInputTokens = 50_000_000; // far past any window: the fork would overflow at once
    nativeAnswer = (req) => ({ via: req.forkFrom ? "fork" : "history", backingId: "nb" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    await fork(m, id);
    const req = made.at(-1)!.nativeRequests[0]!;
    expect(req.forkFrom).toBeUndefined(); // budgeted history instead
  });

  it("when Claude can't find its session, recovery hands the new one the conversation", async () => {
    nativeAnswer = () => ({ via: "history", backingId: "recovered" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    await send(m, id, "two");
    const p = made.at(-1)!;
    p.onRecoveryNeeded!("two");
    for (let i = 0; i < 100 && p.nativeRequests.length === 0; i++) await Bun.sleep(10);
    expect(p.nativeRequests[0]!.history.map((t) => t.content)).toEqual(["one", "a1", "two", "a2"]);
  });

  it("a fork onto another backend asks for native history — no fork point to borrow", async () => {
    nativeAnswer = () => ({ via: "history" });
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const info = await fork(m, id, { providerId: "codex" });
    const req = made.at(-1)!.nativeRequests[0]!;
    expect(req.forkFrom).toBeUndefined();
    expect(notes(m, info.id).some((n) => n.includes("given to codex as its own history"))).toBe(true);
  });

  it("falls back to the transcript when the backend declines or throws, and says which way it went", async () => {
    for (const answer of [() => null, () => Promise.reject(new Error("boom"))]) {
      nativeAnswer = answer as never;
      const m = manager();
      const id = await newSession(m);
      await send(m, id, "one");
      const info = await fork(m, id);
      expect(made.at(-1)!.seededHistory?.map((t) => t.content)).toEqual(["one", "a1"]);
      expect(notes(m, info.id).some((n) => n.includes("as a text transcript"))).toBe(true);
    }
  });

  it("session.nativeContinuation: false keeps everything on the transcript", async () => {
    nativeAnswer = () => ({ via: "fork", backingId: "nope" });
    const m = manager({ nativeContinuation: false });
    const id = await newSession(m);
    await send(m, id, "one");
    await fork(m, id);
    expect(made.at(-1)!.nativeRequests).toEqual([]);
    expect(made.at(-1)!.seededHistory).not.toBeNull();
  });

  it("a backend switch tries native history, and a backend that builds lazily stays 'fresh' for a restart", async () => {
    nativeAnswer = () => ({ via: "history" }); // no backingId yet, like Codex
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    const r = await m.handle({ type: "session.set_provider", id: "p", sessionId: id, providerId: "codex" } as never, AUTH, CLIENT);
    expect(r.type).toBe("response.ok");
    expect(made.at(-1)!.nativeRequests).toHaveLength(1);
    // The switch line first, then how the conversation went over.
    const said = notes(m, id);
    expect(said.findIndex((n) => n.startsWith("Backend switched"))).toBeLessThan(said.findIndex((n) => n.includes("given to codex")));
    await Bun.sleep(20);
    const meta = JSON.parse(readFileSync(transcript.metaPath(id), "utf8")) as { backingFresh?: boolean };
    expect(meta.backingFresh).toBe(true);
  });

  it("a rewind on the same backend forks natively at the kept turn", async () => {
    nativeAnswer = (req) => (req.forkFrom ? { via: "fork", backingId: "rewound-backing" } : null);
    const m = manager();
    const id = await newSession(m);
    await send(m, id, "one");
    await send(m, id, "two");
    const s = m._sessionForTest(id)!;
    const second = s.turnIndex[1]!.turnId;
    await s.rewind(second, { restoreFiles: false }, AUTH);
    const req = made.at(-1)!.nativeRequests.at(-1)!;
    expect(req.forkFrom).toEqual({ backingId: "claude-b1", ref: "00000000-0000-0000-0000-0000000000e1" });
    expect(store.getClaudeCodeSessionId(id)).toBe("rewound-backing");
  });
});
