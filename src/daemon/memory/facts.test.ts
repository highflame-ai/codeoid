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

  test("a call still running at the turn's end (background work) closes when its result comes; the reply while it ran is kept", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u" }, (ep) => out.push(ep));
    c.onMessage(user("m1", "go"));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "sleep 9" } }, { command: "sleep 9" }));
    c.onMessage(assistant("m2", "Started it in the background."));
    c.onTurnEnd();
    expect(out.map((e) => e.kind)).toEqual(["user_turn"]);
    c.onMessage(tool("t1", "Bash", { phase: "completed", success: true, output: "slept" }));
    expect(out.find((e) => e.kind === "tool_call")?.content).toContain("slept");
  });

  test("a plain question while an earlier turn's call is still open is its own episode, with its prompt", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u" }, (ep) => out.push(ep));
    c.onMessage(user("m1", "start the server"));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "serve" } }, { command: "serve" }));
    c.onTurnEnd();
    c.onMessage(user("m2", "what is 2+2"));
    c.onMessage(assistant("m3", "4"));
    c.onTurnEnd();
    expect(out.find((e) => e.content.includes("what is 2+2"))?.content).toContain("4");
  });

  test("reasoning before a call stays with it; the answer after the calls is the turn's, with its prompt", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u" }, (ep) => out.push(ep));
    c.onMessage(user("m1", "fix the tests"));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "npm test" } }, { command: "npm test" }));
    c.onMessage(tool("t1", "Bash", { phase: "completed", success: false, output: "1 failed" }));
    c.onMessage(assistant("m2", "Let me read the failing file."));
    c.onMessage(tool("t2", "Read", { phase: "executing", input: { file_path: "a.ts" } }, { file_path: "a.ts" }));
    c.onMessage(tool("t2", "Read", { phase: "completed", success: true, output: "code" }));
    c.onMessage(assistant("m3", "Fixed it."));
    c.onTurnEnd();
    expect(out.find((e) => e.toolName === "Read")?.content).toContain("Let me read the failing file.");
    expect(out.filter((e) => e.content.includes("Let me read the failing file."))).toHaveLength(1);
    const answer = out.find((e) => e.kind === "user_turn");
    expect(answer?.content).toContain("fix the tests");
    expect(answer?.content).toContain("Fixed it.");
  });

  test("text before the first call is its reasoning, and the prompt goes with the call and the answer", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u" }, (ep) => out.push(ep));
    c.onMessage(user("m1", "run the tests"));
    c.onMessage(assistant("m2", "Let me run the tests."));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "npm test" } }, { command: "npm test" }));
    c.onMessage(tool("t1", "Bash", { phase: "completed", success: false, output: "1 failed" }));
    c.onMessage(assistant("m3", "One fails."));
    c.onTurnEnd();
    const call = out.find((e) => e.kind === "tool_call")!;
    expect(call.content).toContain("# User intent\nrun the tests");
    expect(call.content).toContain("Let me run the tests.");
    const answer = out.find((e) => e.kind === "user_turn")!;
    expect(answer.content).toContain("run the tests");
    expect(answer.content).toContain("One fails.");
    expect(answer.content).not.toContain("Let me run the tests.");
  });

  test("a plain turn is one episode, prompt and answer", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u" }, (ep) => out.push(ep));
    c.onMessage(user("m1", "what is 2+2"));
    c.onMessage(assistant("m2", "4"));
    c.onTurnEnd();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "user_turn" });
    expect(out[0]!.content).toContain("what is 2+2");
  });

  test("at the session's end every open call is stored as unfinished; an interrupted one says so", () => {
    const out: Array<Omit<Episode, "id">> = [];
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u" }, (ep) => out.push(ep));
    c.onMessage(user("m1", "go"));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "serve" } }, { command: "serve" }));
    c.onMessage(tool("t2", "Bash", { phase: "executing", input: { command: "watch" } }, { command: "watch" }));
    c.onMessage(tool("t2", "Bash", { phase: "cancelled", reason: "interrupted" }));
    c.onTurnEnd();
    c.flushAll();
    const calls = out.filter((e) => e.kind === "tool_call");
    expect(calls.find((e) => e.summary.includes("watch"))?.content).toContain("## Result\ninterrupted");
    expect(calls.find((e) => e.summary.includes("serve"))?.content).toContain("## Result\nunfinished");
  });

  test("a call's origin and workstream are as they were when it opened", () => {
    const out: Array<Omit<Episode, "id">> = [];
    let facts: { origin: "user" | "delegated"; workstream: string } = { origin: "user", workstream: "a" };
    const c = new EpisodeChunker({ workspaceId: "w", sessionId: "s", createdBy: "u", turnFacts: () => facts }, (ep) => out.push(ep));
    c.onMessage(tool("t1", "Bash", { phase: "executing", input: { command: "x" } }, { command: "x" }));
    facts = { origin: "delegated", workstream: "b" };
    c.onMessage(tool("t1", "Bash", { phase: "completed", success: true, output: "done" }));
    expect(out[0]).toMatchObject({ origin: "user", workstreamId: "a" });
  });
});

describe("exit codes", () => {
  test.each([
    ["Error: Exit code 2\nboom", false, 2],
    ["ok\nExit code: 0", true, 0],
    ["…\nProcess exited with code 137", false, 137],
    ["all good", true, 0],
    // A success is 0 whatever its output prints (a log naming another process's status).
    ["--- FAIL: x\nexit status 1\nok", true, 0],
    // A failure is never 0, and failed with no code is -1.
    ["Exit status: 0", false, -1],
    ["broke", false, -1],
    // pi's wording.
    ["npm ERR!\n\nCommand exited with code 7", false, 7],
    ["nothing said", undefined, undefined],
  ] as const)("%j", (output, success, code) => {
    expect(exitCodeOf(output, success)).toBe(code);
  });

  test("a code the backend reports as a field wins", () => {
    expect(exitCodeOf("Exit code 1", false, 3)).toBe(3);
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
    ["rate-limiting", null],
    ["e.g.", null],
    ["TODO", null],
    ["what does -v do", null],
    ["package.json", "package.json"],
    ["camelCaseThing", "camelCaseThing"],
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

  test("a very long line is cut at the page size, and says so", () => {
    const big = { ...ep, content: `${"x".repeat(300_000)}\nend` };
    const out = formatEpisodeLines(big, "s", [[1, -1]]);
    expect(out.length).toBeLessThan(270_000);
    expect(out).toContain("…[line cut: the rest with get_episode offset");
  });

  test("ranges merged and in order", () => {
    const out = formatEpisodeLines(ep, "s", [[10, 12], [1, 2], [11, 14]]);
    expect(out).toContain("- lines: 1–2, 10–14 of 300");
    expect(out).toContain("[… 7 lines skipped …]");
  });
});
