/**
 * Turn identity, workspace checkpoints and restart-proof canonical history
 * (#354), through the real Session / SessionManager with a mock backend.
 *
 * Everything here is backend-agnostic by design: turn ids, the turn list and
 * the snapshots come from codeoid's own records, never from a backend's
 * native session — so the mock is a faithful stand-in for every provider.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { canonicalFromTranscript } from "../daemon/canonical-restore.js";
import { listCheckpoints, shadowRepoPath } from "../daemon/checkpoints.js";
import { SendStoppedError } from "../daemon/session.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionMessage, SessionTurnsResultMsg } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:turns",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-turns",
  projectId: "proj-turns",
};

function say(text: string): ProviderEvent[] {
  return [
    { type: "text_done", content: text } as ProviderEvent,
    {
      type: "turn_done",
      result: {
        providerId: "mock",
        model: "mock",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        durationMs: 1,
      },
    } as ProviderEvent,
  ];
}

function mkConfig(tmp: string): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: {
      enabled: false,
      warnPct: 0.6,
      rotatePct: 0.8,
      hardRotatePct: 0.9,
      minTurnsBeforeRotate: 3,
      strategy: "task-anchor",
    },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
  } as CodeoidConfig;
}

let tmp: string;
let repo: string;
let store: Store;
let transcript: TranscriptStore;
let managers: SessionManager[] = [];
/** Providers built by the current manager, newest last. */
let providers: MockSessionProvider[] = [];

function newManager(turns: ProviderEvent[][] = [say("a1"), say("a2"), say("a3")]): SessionManager {
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(tmp),
    _testProviderFactory: () => {
      // Reports as "claude" so it is a registered id (fork validates it); the
      // behaviour under test never depends on which backend it claims to be.
      const p = new MockSessionProvider("claude", turns.map((t) => [...t]));
      providers.push(p);
      return p;
    },
  });
  managers.push(m);
  return m;
}

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const ckptRoot = (): string => join(tmp, "transcripts", "checkpoints");
const showAt = (session: string, sha: string, file: string): string =>
  execFileSync("git", ["--git-dir", shadowRepoPath(ckptRoot(), session), "show", `${sha}:${file}`], { encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-turns-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "v0\n");
  git("add", ".");
  git("commit", "-qm", "init");
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  managers = [];
  providers = [];
});

afterEach(async () => {
  for (const m of managers) await m.drain(2_000).catch(() => {});
  await transcript.flush();
  rmSync(tmp, { recursive: true, force: true });
});

async function create(m: SessionManager, workdir = repo): Promise<string> {
  const r = await m.handle({ type: "session.create", id: "c1", name: `t-${Math.random()}`, workdir }, AUTH, {
    id: "cli",
    auth: AUTH,
    send: () => {},
  });
  if (r.type !== "response.ok") throw new Error(`create failed: ${JSON.stringify(r)}`);
  return (r.data as { id: string }).id;
}

async function sendAndSettle(m: SessionManager, sessionId: string, text: string): Promise<void> {
  const s = m._sessionForTest(sessionId)!;
  await s.send(text, AUTH);
  for (let i = 0; i < 200 && s.status !== "idle"; i++) await Bun.sleep(10);
  expect(s.status).toBe("idle");
}

async function turnsOf(m: SessionManager, sessionId: string): Promise<SessionTurnsResultMsg> {
  const r = await m.handle({ type: "session.turns", id: "t1", sessionId }, AUTH, { id: "cli", auth: AUTH, send: () => {} });
  if (r.type !== "session.turns.result") throw new Error(`turns failed: ${JSON.stringify(r)}`);
  return r;
}

describe("turn identity", () => {
  it("stamps one id on a prompt and everything that answers it, a new id per turn", async () => {
    const m = newManager();
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const seen: SessionMessage[] = [];
    s.attach({ id: "watch", auth: AUTH, send: (msg: DaemonMessage) => { if (msg.type === "session.message") seen.push(msg); } });

    await sendAndSettle(m, id, "first");
    await sendAndSettle(m, id, "second");

    const users = seen.filter((x) => x.role === "user");
    // A streamed reply is broadcast at start and again on commit (same messageId).
    const replies = [...new Map(seen.filter((x) => x.role === "assistant").map((x) => [x.messageId, x])).values()];
    expect(users).toHaveLength(2);
    expect(users[0]!.turnId).toBeTruthy();
    expect(users[1]!.turnId).toBeTruthy();
    expect(users[0]!.turnId).not.toBe(users[1]!.turnId);
    expect(replies.map((r) => r.turnId)).toEqual([users[0]!.turnId, users[1]!.turnId]);

    // The canonical history carries the same ids, user and assistant alike.
    const h = s.canonicalHistory;
    expect(h.map((t) => [t.role, t.turnId])).toEqual([
      ["user", users[0]!.turnId],
      ["assistant", users[0]!.turnId],
      ["user", users[1]!.turnId],
      ["assistant", users[1]!.turnId],
    ]);
  });
});

describe("session.turns + checkpoints", () => {
  it("lists turns oldest first, each with the snapshot of the files it started from", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "make it v1\nwith detail");
    writeFileSync(join(repo, "a.txt"), "v1\n"); // what the "agent" did in turn 1
    await sendAndSettle(m, id, "now v2");

    const r = await turnsOf(m, id);
    expect(r.checkpointsSupported).toBe(true);
    expect(r.turns.map((t) => [t.index, t.kind, t.preview])).toEqual([
      [1, "prompt", "make it v1"],
      [2, "prompt", "now v2"],
    ]);
    expect(r.turns.every((t) => t.startedAt)).toBe(true);
    // Turn 1 started from v0; turn 2 started from v1.
    expect(showAt(id, r.turns[0]!.checkpoint!.sha, "a.txt")).toBe("v0\n");
    expect(showAt(id, r.turns[1]!.checkpoint!.sha, "a.txt")).toBe("v1\n");
    expect(r.turns[0]!.checkpoint!.late).toBeUndefined();
    // Nothing changed in the user's repository: no refs, no log entries.
    expect(git("status", "--porcelain").trim()).toBe("M a.txt");
    expect(git("log", "--all", "--oneline").trim().split("\n")).toHaveLength(1);
    expect(git("for-each-ref").trim().split("\n")).toHaveLength(1);
  });

  it("snapshots a workdir that is not a git repository too", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "notes.md"), "draft\n");
    const m = newManager();
    const id = await create(m, plain);
    await sendAndSettle(m, id, "hello");
    const r = await turnsOf(m, id);
    expect(r.checkpointsSupported).toBe(true);
    expect(showAt(id, r.turns[0]!.checkpoint!.sha, "notes.md")).toBe("draft\n");
    expect(existsSync(join(plain, ".git"))).toBe(false);
  });

  it("honours session.checkpoints.enabled = false", async () => {
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: { ...mkConfig(tmp), session: { checkpoints: { enabled: false } } } as CodeoidConfig,
      _testProviderFactory: () => new MockSessionProvider("mock", [say("a")]),
    });
    managers.push(m);
    const id = await create(m);
    await sendAndSettle(m, id, "hello");
    const r = await turnsOf(m, id);
    expect(r.checkpointsSupported).toBe(false);
    expect([...(await listCheckpoints(ckptRoot(), id)).keys()].filter((k) => !k.endsWith("-end")).length).toBe(0);
  });

  it("deletes the session's snapshots when it is destroyed", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "hello");
    expect([...(await listCheckpoints(ckptRoot(), id)).keys()].filter((k) => !k.endsWith("-end")).length).toBe(1);
    const r = await m.handle({ type: "session.destroy", id: "d", sessionId: id }, AUTH, { id: "cli", auth: AUTH, send: () => {} });
    expect(r.type).toBe("response.ok");
    expect(existsSync(shadowRepoPath(ckptRoot(), id))).toBe(false);
  });

  it("requires read access to the session", async () => {
    const m = newManager();
    const id = await create(m);
    const noScope: AuthContext = { ...AUTH, scopes: [] };
    const r = await m.handle({ type: "session.turns", id: "t", sessionId: id }, noScope, { id: "x", auth: noScope, send: () => {} });
    expect(r.type).toBe("response.error");
    const other: AuthContext = { ...AUTH, accountId: "someone-else" };
    const r2 = await m.handle({ type: "session.turns", id: "t", sessionId: id }, other, { id: "x", auth: other, send: () => {} });
    expect(r2.type).toBe("response.error");
  });
});

describe("canonical history survives a restart", () => {
  async function restart(): Promise<SessionManager> {
    for (const m of managers) await m.drain(2_000);
    await transcript.flush();
    providers = [];
    const next = newManager([say("after-restart")]);
    await next.resumeSessions();
    return next;
  }

  it("a stateless backend still sees the conversation on the first prompt after a restart", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    await sendAndSettle(m, id, "second");

    const next = await restart();
    await sendAndSettle(next, id, "third");
    const sent = providers.at(-1)!.capturedOpts.at(-1)!.history.map((t) => [t.role, t.content]);
    expect(sent.slice(0, 5)).toEqual([
      ["user", "first"],
      ["assistant", "a1"],
      ["user", "second"],
      ["assistant", "a2"],
      ["user", "third"],
    ]);
  });

  it("forking after a restart carries the conversation (it used to carry nothing)", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    const next = await restart();
    const r = await next.handle({ type: "session.fork", id: "f", sessionId: id, isolate: false }, AUTH, { id: "cli", auth: AUTH, send: () => {} });
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    const fork = next._sessionForTest((r.data as { id: string }).id)!;
    expect(fork.canonicalHistory.map((t) => t.content)).toEqual(["first", "a1"]);
  });

  it("the turn list and its snapshots survive a restart", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    await sendAndSettle(m, id, "second");
    const before = await turnsOf(m, id);
    const next = await restart();
    expect((await turnsOf(next, id)).turns).toEqual(before.turns);
  });

  it("when memory holds only the log's tail, forks still get the whole conversation", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    await sendAndSettle(m, id, "second");
    const s = m._sessionForTest(id)!;
    const full = [...s.canonicalHistory];
    await transcript.flush();
    s.restoreTurns(full.slice(-2), s.turnIndex, { persistHistory: false, persistIndex: false, partial: true });
    expect(s.historyIsPartial).toBe(true);
    expect((await s.fullCanonicalHistory()).map((t) => t.content)).toEqual(["first", "a1", "second", "a2"]);
  });

  it("rebuilds the history of a session from before the log existed, once", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "legacy prompt");
    await m.drain(2_000);
    await transcript.flush();
    rmSync(transcript.canonicalPath(id)); // what a pre-#354 session looks like on disk

    const next = await restart();
    expect(next._sessionForTest(id)!.canonicalHistory.map((t) => [t.role, t.content])).toEqual([
      ["user", "legacy prompt"],
      ["assistant", "a1"],
    ]);
    await transcript.flush();
    expect(existsSync(transcript.canonicalPath(id))).toBe(true); // written back for next time
  });
});

describe("a Stop while a send prepares its turn", () => {
  it("cancels the turn instead of letting it start after the Stop", async () => {
    const m = newManager();
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const seen: SessionMessage[] = [];
    s.attach({ id: "w", auth: AUTH, send: (msg: DaemonMessage) => { if (msg.type === "session.message") seen.push(msg); } });

    const sending = s.send("go", AUTH);
    expect(s.preparingTurn).toBe(true);
    void s.interrupt(AUTH);
    await expect(sending).rejects.toBeInstanceOf(SendStoppedError);

    expect(providers.at(-1)!.capturedOpts).toHaveLength(0); // the backend never got the prompt
    expect(seen.some((x) => x.role === "user" && x.content === "go")).toBe(true); // but it was kept
    expect(seen.some((x) => x.metadata?.event === "send.stopped_before_start")).toBe(true);
    expect(s.status).toBe("idle");
    expect(s.preparingTurn).toBe(false);

    // The next send works normally.
    await sendAndSettle(m, id, "again");
    expect(providers.at(-1)!.capturedOpts).toHaveLength(1);
  });

  it("drain() stops a send that is still preparing, so no turn starts during shutdown", async () => {
    const m = newManager();
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const sending = s.send("go", AUTH).catch((e) => e);
    await m.drain(2_000);
    expect(await sending).toBeInstanceOf(SendStoppedError);
    expect(providers.at(-1)!.capturedOpts).toHaveLength(0);
    expect(s.status).toBe("idle");
  });
});

describe("turn attribution across mid-turn messages, rotation and forks", () => {
  it("a message sent while the agent works joins the running turn", async () => {
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(tmp),
      _testProviderFactory: () => {
        const p = new MockSessionProvider("claude", [[{ type: "text_delta", content: "working…" } as ProviderEvent]], {
          stall: true,
          midTurn: true,
        });
        providers.push(p);
        return p;
      },
    });
    managers.push(m);
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    await s.send("do the big thing", AUTH);
    for (let i = 0; i < 100 && s.status === "idle"; i++) await Bun.sleep(10);
    await s.send("also add tests", AUTH);
    expect(providers.at(-1)!.midTurnPushes).toHaveLength(1);
    const users = s.canonicalHistory.filter((t) => t.role === "user");
    expect(users).toHaveLength(2);
    expect(users[1]!.turnId).toBe(users[0]!.turnId); // one turn, not two
    expect((await turnsOf(m, id)).turns).toHaveLength(1);
    await s.interrupt(AUTH);
  });

  it("a context rotation keeps the turn list", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    const r = await m.handle({ type: "session.rotate", id: "rot", sessionId: id }, AUTH, { id: "cli", auth: AUTH, send: () => {} });
    expect(r.type).toBe("response.ok");
    await sendAndSettle(m, id, "second");
    expect((await turnsOf(m, id)).turns.map((t) => t.preview)).toEqual(["first", "second"]);
  });

  it("a fork inherits the parent's turns and snapshots, which outlive the parent", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    writeFileSync(join(repo, "a.txt"), "v1\n");
    await sendAndSettle(m, id, "second");
    const r = await m.handle({ type: "session.fork", id: "f", sessionId: id, isolate: false }, AUTH, { id: "cli", auth: AUTH, send: () => {} });
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    const forkId = (r.data as { id: string }).id;
    await m.handle({ type: "session.destroy", id: "d", sessionId: id }, AUTH, { id: "cli", auth: AUTH, send: () => {} });

    const ft = await turnsOf(m, forkId);
    expect(ft.turns.map((t) => t.preview)).toEqual(["first", "second"]);
    expect(showAt(forkId, ft.turns[1]!.checkpoint!.sha, "a.txt")).toBe("v1\n");
  });

  it("a stopped send is not a turn: nothing is listed and later messages keep the previous turn's id", async () => {
    const m = newManager();
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    await sendAndSettle(m, id, "real");
    const sending = s.send("stopped", AUTH);
    void s.interrupt(AUTH);
    await expect(sending).rejects.toBeInstanceOf(SendStoppedError);
    const t = await turnsOf(m, id);
    expect(t.turns.map((x) => x.preview)).toEqual(["real"]);
    expect([...(await listCheckpoints(ckptRoot(), id)).keys()].filter((k) => !k.endsWith("-end")).length).toBe(1);
  });
});

describe("a turn the backend starts on its own during the snapshot", () => {
  it("is joined, never overwritten by a second turn", async () => {
    // A tree big enough that the snapshot takes a while.
    for (let i = 0; i < 3000; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(tmp),
      _testProviderFactory: () => {
        const p = new MockSessionProvider("claude", [], { midTurn: true });
        p.continuesAfterBackgroundWork = true;
        providers.push(p);
        return p;
      },
    });
    managers.push(m);
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const sending = s.send("is it done?", AUTH);
    for (let i = 0; i < 500 && !s.preparingTurn; i++) await Bun.sleep(1);
    await Bun.sleep(5); // inside the snapshot wait
    providers.at(-1)!.startOwnTurn([{ type: "text_delta", content: "background result…" } as ProviderEvent]);
    await sending;
    const p = providers.at(-1)!;
    expect(p.capturedOpts).toHaveLength(0); // no second runTurn over the adopted turn
    expect(p.midTurnPushes.map((x) => x.content)).toEqual(["is it done?"]);
    expect(p.endTurnCount).toBe(0);
    await s.interrupt(AUTH);
  });
});

describe("a pipeline phase and a Stop before its turn starts", () => {
  it("the phase returns instead of waiting forever for a turn that never starts", async () => {
    const m = newManager([say("unused")]);
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const phase = m.runPhaseOnSession({ sessionId: id, prompt: "do the phase" });
    for (let i = 0; i < 500 && !s.preparingTurn; i++) await Bun.sleep(1);
    expect(s.preparingTurn).toBe(true);
    void s.interrupt(AUTH);
    const result = await Promise.race([phase, Bun.sleep(5_000).then(() => "hung" as const)]);
    expect(result).not.toBe("hung");
    expect(providers.at(-1)!.capturedOpts).toHaveLength(0);
  });
});

describe("canonicalFromTranscript", () => {
  it("rebuilds prompts, replies, thinking and primary tool calls, skipping sub-agents", () => {
    const base = { type: "session.message", sessionId: "s", timestamp: "2026-01-01T00:00:00Z" } as const;
    const human = { sub: "u", type: "human" } as const;
    const agent = { sub: "a", type: "agent" } as const;
    const rows = [
      { ...base, messageId: "1", role: "assistant", content: "orphan before any prompt", identity: agent },
      { ...base, messageId: "2", role: "user", content: "fix it", identity: human, turnId: "T1" },
      { ...base, messageId: "3", role: "thinking", content: "hmm", identity: agent, turnId: "T1" },
      {
        ...base, messageId: "4", role: "tool_call", content: "", identity: agent, turnId: "T1",
        tool: { toolId: "tu1", name: "Read", input: { file_path: "a.txt" }, state: { phase: "completed", success: true, output: "v0" } },
      },
      {
        ...base, messageId: "5", role: "tool_call", content: "", identity: { sub: "x", type: "subagent" },
        tool: { toolId: "tu2", name: "Bash", input: {}, state: { phase: "completed", success: true, output: "sub" } },
      },
      { ...base, messageId: "6", role: "assistant", content: "done", identity: agent, turnId: "T1" },
      { ...base, messageId: "7", role: "info", content: "↻", identity: agent, metadata: { event: "turn.adopted" }, turnId: "T2" },
      { ...base, messageId: "8", role: "assistant", content: "background result", identity: agent, turnId: "T2" },
    ] as unknown as DaemonMessage[];

    const h = canonicalFromTranscript(rows, "codex");
    expect(h).toEqual([
      { role: "user", content: "fix it", turnId: "T1", at: "2026-01-01T00:00:00Z" },
      {
        role: "assistant",
        content: "done",
        turnId: "T1",
        thinking: "hmm",
        toolCalls: [{ id: "tu1", name: "read_file", originalName: "Read", input: { file_path: "a.txt" }, output: "v0", success: true }],
        providerId: "codex",
        model: "unknown",
      },
      {
        role: "user",
        content: "(Background work finished; the agent harness delivered the results.)",
        turnId: "T2",
        at: "2026-01-01T00:00:00Z",
        background: true,
      },
      { role: "assistant", content: "background result", turnId: "T2", providerId: "codex", model: "unknown" },
    ]);
  });
});
