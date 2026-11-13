/**
 * Memory facts (docs/secrets-and-memory-design.md §3): every tool call reaches
 * memory with its result, its exit code, where it ran and how long it took;
 * every episode with the backend, model and turn origin that produced it; and
 * recall finds by those facts, exact text first, an episode's end first.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "../../protocol/types.js";
import { EpisodeChunker } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { exactQueryText, MemoryEngine } from "./engine.js";
import { exitCodeOf } from "./facts.js";
import { SqliteEpisodeStore } from "./store.js";
import { formatEpisodeLines, memoryToolDefs } from "./tools.js";
import type { Episode } from "./types.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(8).fill(0.35));
  }
  async close(): Promise<void> {}
}

const t = () => new Date().toISOString();
const user = (id: string, content: string): SessionMessage => ({ type: "session.message", sessionId: "s", messageId: id, role: "user", content, identity: { sub: "u", type: "human" }, timestamp: t() }) as SessionMessage;
const assistant = (id: string, content: string): SessionMessage => ({ type: "session.message", sessionId: "s", messageId: id, role: "assistant", content, identity: { sub: "a", type: "agent" }, timestamp: t() }) as SessionMessage;
const tool = (id: string, name: string, state: Record<string, unknown>, input: Record<string, unknown> = {}): SessionMessage =>
  ({ type: "session.message", sessionId: "s", messageId: id, role: "tool_call", content: name, identity: { sub: "a", type: "agent" }, tool: { toolId: id, name, input, state }, timestamp: t() }) as unknown as SessionMessage;

describe("chunker", () => {
  test("every call closes with its result and facts, parallel ones too; the turn's facts on every episode", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const facts: Record<string, { cwd?: string; exitCode?: number; durationMs?: number }> = { t1: { cwd: "/w", exitCode: 1, durationMs: 1200 }, t2: { cwd: "/w/sub", exitCode: 0 } };
    const c = new EpisodeChunker(
      { workspaceId: "w", sessionId: "s", createdBy: "u", toolFacts: (id) => facts[id], turnFacts: () => ({ backend: "codex", model: "gpt-x", origin: "user" }) },
      (ep) => out.push(ep),
    );
    c.onMessage(user("m1", "run both"));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "npm test" } }, { command: "npm test" }));
    c.onMessage(tool("t2", "Bash", { phase: "executing", input: { command: "ls" } }, { command: "ls" }));
    c.onMessage(tool("t2", "Bash", { phase: "completed", success: true, output: "a b" }));
    c.onMessage(tool("t1", "Bash", { phase: "completed", success: false, output: "FAIL x\nExit code 1" }));
    c.onMessage(assistant("m2", "One failed."));
    c.onTurnEnd();
    const calls = out.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(2);
    const npm = calls.find((e) => e.summary.includes("npm test"))!;
    expect(npm.content).toContain("FAIL x");
    expect(npm).toMatchObject({ exitCode: 1, cwd: "/w", durationMs: 1200, backend: "codex", model: "gpt-x", origin: "user" });
    expect(calls.find((e) => e.summary.includes("ls"))).toMatchObject({ exitCode: 0, cwd: "/w/sub" });
    expect(out.find((e) => e.kind === "user_turn")?.content).toContain("One failed.");
  });

  test("a call that never got its result closes at the turn's end, and the reply while it ran is kept", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u" }, (ep) => out.push(ep));
    c.onMessage(user("m1", "go"));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "sleep 9" } }, { command: "sleep 9" }));
    c.onMessage(assistant("m2", "Started it in the background."));
    c.onTurnEnd();
    expect(out.map((e) => e.kind).sort()).toEqual(["assistant_turn", "tool_call"]);
    expect(out.find((e) => e.kind === "tool_call")?.content).toContain("unfinished");
  });
});

describe("exit codes", () => {
  test.each([
    ["Error: Exit code 2\nboom", false, 2],
    ["ok\nExit code: 0", true, 0],
    ["…\nProcess exited with code 137", false, 137],
    ["all good", true, 0],
    ["broke", false, undefined],
  ] as const)("%j", (output, success, code) => {
    expect(exitCodeOf(output, success)).toBe(code);
  });
});

describe("recall", () => {
  let dir: string;
  let store: SqliteEpisodeStore;
  let engine: MemoryEngine;
  const base = { workspaceId: "w", sessionId: "s1", filePaths: [], tokenEstimate: 1, createdBy: "u" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeoid-facts-"));
    store = new SqliteEpisodeStore(join(dir, "m.db"));
    engine = new MemoryEngine({ store, embedder: new StubEmbedder() });
    let at = 1_000;
    for (const ep of [
      { kind: "tool_call", toolName: "Bash", summary: "Bash(npm test)", content: "# Tool: Bash\nnpm test\n## Result\n3 failed", exitCode: 1, cwd: "/repo/web", backend: "claude", origin: "user" },
      { kind: "tool_call", toolName: "Bash", summary: "Bash(npm run build)", content: "# Tool: Bash\nnpm run build\n## Result\nok", exitCode: 0, cwd: "/repo", backend: "codex", origin: "dispatch" },
      { kind: "assistant_turn", summary: "talk", content: "we discussed the build pipeline at length", backend: "claude", origin: "user" },
    ] as const) store.insert({ ...base, ...ep, createdAt: at++ } as Omit<Episode, "id">);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the facts are stored and read back", () => {
    const [ep] = store.listEpisodesForSession("s1").filter((e) => e.summary === "Bash(npm test)");
    expect(ep).toMatchObject({ exitCode: 1, cwd: "/repo/web", backend: "claude", origin: "user" });
  });

  test("only_failed finds the failure even for a query that names nothing of it", async () => {
    const hits = await engine.recall({ query: "what broke", workspaceId: "w", onlyFailed: true });
    expect(hits.map((h) => h.episode.summary)).toEqual(["Bash(npm test)"]);
  });

  test("backend, origin and cwd filters", async () => {
    expect((await engine.recall({ query: "npm", workspaceId: "w", backend: "codex" })).map((h) => h.episode.summary)).toEqual(["Bash(npm run build)"]);
    expect((await engine.recall({ query: "npm", workspaceId: "w", origin: "dispatch" })).map((h) => h.episode.summary)).toEqual(["Bash(npm run build)"]);
    expect((await engine.recall({ query: "npm", workspaceId: "w", cwd: "/repo/web" })).map((h) => h.episode.summary)).toEqual(["Bash(npm test)"]);
    // A directory's prefix is not its parent: /repo/we isn't /repo/web.
    expect(await engine.recall({ query: "npm", workspaceId: "w", cwd: "/repo/we" })).toEqual([]);
  });

  test("an exact command comes first, marked, the related after it", async () => {
    const hits = await engine.recall({ query: '"npm run build"', workspaceId: "w" });
    expect(hits[0]?.episode.summary).toBe("Bash(npm run build)");
    expect(hits[0]?.exact).toBe(true);
    expect(hits.slice(1).every((h) => !h.exact)).toBe(true);
  });

  test("the recall tool shows facts, a divider, and what to loosen when nothing matches", async () => {
    const recall = memoryToolDefs().find((d) => d.name === "recall")!;
    const ctx = { engine, workspaceId: "w", sessionId: "other" } as never;
    const out = await recall.run({ query: '"npm run build"', include_current_session: true }, ctx);
    expect(out).toContain("(exact match)");
    expect(out).toContain("- facts: exit 0 · in /repo · by codex · turn: dispatch");
    const none = await recall.run({ query: "xyzzy", backend: "gemini", include_current_session: true }, ctx);
    expect(none).toContain("Try loosening: backend");
  });

  test.each([
    ['"npm run build"', "npm run build"],
    ["src/daemon/session.ts", "src/daemon/session.ts"],
    ["MAX_TOKENS", "MAX_TOKENS"],
    ["git rebase --onto main", "git rebase --onto main"],
    ["what did we do about the flaky test", null],
  ])("exact text of %s", (q, exact) => {
    expect(exactQueryText(q)).toBe(exact);
  });
});

describe("get_episode lines", () => {
  const ep = { id: "e1", workspaceId: "w", sessionId: "s", kind: "tool_call", toolName: "Bash", summary: "Bash(x)", content: Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n"), filePaths: [], tokenEstimate: 1, createdAt: 1, createdBy: "u", exitCode: 2 } as Episode;

  test("the end first, numbered, with what was skipped and the total", () => {
    const out = formatEpisodeLines(ep, "s", [[-3, -1]]);
    expect(out).toContain("- lines: 298–300 of 300");
    expect(out).toContain("[… 297 lines skipped …]");
    expect(out).toContain("300  line 300");
    expect(out).toContain("- facts: exit 2");
  });

  test("ranges merged and in order", () => {
    const out = formatEpisodeLines(ep, "s", [[10, 12], [1, 2], [11, 14]]);
    expect(out).toContain("- lines: 1–2, 10–14 of 300");
    expect(out).toContain("[… 7 lines skipped …]");
  });
});
