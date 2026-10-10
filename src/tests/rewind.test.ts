/**
 * Going back a turn (#355) through the real SessionManager with a mock
 * backend — the conversation, the turn list, what clients see, the files,
 * and that all of it holds across a restart. Backend-agnostic by design: the
 * cut happens in codeoid's canonical history and the backend is re-seeded,
 * so the mock stands in for every provider.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { irreversibleEffects } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { applyRewinds, TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type {
  AuthContext,
  DaemonMessage,
  SessionMessage,
  SessionRewindResultMsg,
  SessionTurnsResultMsg,
} from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:rewind",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-rw",
  projectId: "proj-rw",
};
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

function say(text: string): ProviderEvent[] {
  return [
    { type: "text_done", content: text } as ProviderEvent,
    {
      type: "turn_done",
      result: {
        providerId: "claude",
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
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
  } as CodeoidConfig;
}

let tmp: string;
let repo: string;
let store: Store;
let transcript: TranscriptStore;
let managers: SessionManager[];
let providers: MockSessionProvider[];

function newManager(turns: ProviderEvent[][] = [say("a1"), say("a2"), say("a3"), say("a4")]): SessionManager {
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(tmp),
    _testProviderFactory: () => {
      const p = new MockSessionProvider("claude", turns.map((t) => [...t]));
      providers.push(p);
      return p;
    },
  });
  managers.push(m);
  return m;
}

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-rewind-"));
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
  const r = await m.handle({ type: "session.create", id: "c", name: `rw-${Math.random()}`, workdir }, AUTH, CLIENT);
  if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
  return (r.data as { id: string }).id;
}

async function sendAndSettle(m: SessionManager, id: string, text: string): Promise<void> {
  const s = m._sessionForTest(id)!;
  await s.send(text, AUTH);
  for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
  expect(s.status).toBe("idle");
  await Bun.sleep(30); // let the end-of-turn snapshot start
}

async function turns(m: SessionManager, id: string): Promise<SessionTurnsResultMsg["turns"]> {
  const r = await m.handle({ type: "session.turns", id: "t", sessionId: id }, AUTH, CLIENT);
  if (r.type !== "session.turns.result") throw new Error(JSON.stringify(r));
  return r.turns;
}

async function rewind(
  m: SessionManager,
  id: string,
  turnId: string,
  opts: { restoreFiles?: boolean; dryRun?: boolean; force?: boolean } = {},
): Promise<SessionRewindResultMsg> {
  const r = await m.handle({ type: "session.rewind", id: "rw", sessionId: id, turnId, ...opts }, AUTH, CLIENT);
  if (r.type !== "session.rewind.result") throw new Error(JSON.stringify(r));
  return r;
}

const visible = (msgs: DaemonMessage[]): string[] =>
  msgs
    .filter((m): m is SessionMessage => m.type === "session.message")
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
    .map((m) => m.content);

describe("going back a turn: the conversation", () => {
  it("takes back the last turn: the agent forgets it, the list drops it, the prompt comes back", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    await sendAndSettle(m, id, "oops wrong message\nwith more");
    const before = await turns(m, id);
    const r = await rewind(m, id, before[1]!.turnId);
    expect(r).toMatchObject({ removedTurns: 1, restoredPrompt: "oops wrong message\nwith more", dryRun: false });

    const s = m._sessionForTest(id)!;
    expect(s.canonicalHistory.map((t) => t.content)).toEqual(["first", "a1"]);
    expect((await turns(m, id)).map((t) => t.preview)).toEqual(["first"]);

    // The backend was reset and re-seeded with only what's kept; the next
    // prompt carries the kept conversation.
    const p = providers.at(-1)!;
    expect(p.seededHistory?.map((t) => t.content)).toEqual(["first", "a1"]);
    await sendAndSettle(m, id, "the right message");
    expect(p.capturedOpts.at(-1)!.history.map((t) => t.content).slice(0, 3)).toEqual(["first", "a1", "the right message"]);
  });

  it("going back to an earlier turn takes back every turn after it too", async () => {
    const m = newManager();
    const id = await create(m);
    for (const t of ["one", "two", "three"]) await sendAndSettle(m, id, t);
    const list = await turns(m, id);
    const r = await rewind(m, id, list[1]!.turnId);
    expect(r.removedTurns).toBe(2);
    expect((await turns(m, id)).map((t) => t.preview)).toEqual(["one"]);
    expect(m._sessionForTest(id)!.canonicalHistory.map((t) => t.content)).toEqual(["one", "a1"]);
  });

  it("every attached client gets a fresh view without the taken-back rows, plus a notice", async () => {
    const m = newManager();
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    await sendAndSettle(m, id, "keep me");
    await sendAndSettle(m, id, "take me back");
    const received: DaemonMessage[] = [];
    s.attach({ id: "watch", auth: AUTH, send: (msg) => received.push(msg) });
    received.length = 0;
    await rewind(m, id, (await turns(m, id))[1]!.turnId);
    const replay = received.filter((x) => x.type === "scrollback.replay").at(-1) as { messages: DaemonMessage[]; mode: string };
    expect(replay.mode).toBe("snapshot");
    expect(visible(replay.messages)).toEqual(["keep me", "a1"]);
    const notice = replay.messages.at(-1) as SessionMessage;
    expect(notice.metadata?.event).toBe("session.rewound");
    expect(notice.content).toContain("take me back");
  });

  it("holds across a restart: the transcript, the turn list and the history all stay taken back", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "keep me");
    await sendAndSettle(m, id, "take me back");
    await rewind(m, id, (await turns(m, id))[1]!.turnId);
    await m.drain(2_000);
    await transcript.flush();

    providers = [];
    const next = newManager([say("after")]);
    await next.resumeSessions();
    const s = next._sessionForTest(id)!;
    expect(s.canonicalHistory.map((t) => t.content)).toEqual(["keep me", "a1"]);
    expect((await turns(next, id)).map((t) => t.preview)).toEqual(["keep me"]);
    const received: DaemonMessage[] = [];
    s.attach({ id: "late", auth: AUTH, send: (msg) => received.push(msg) });
    const replay = received.find((x) => x.type === "scrollback.replay") as { messages: DaemonMessage[] };
    expect(visible(replay.messages)).toEqual(["keep me", "a1"]);
  });

  it("a fork made after going back carries neither the taken-back turns nor their rows", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "keep me");
    await sendAndSettle(m, id, "take me back");
    await rewind(m, id, (await turns(m, id))[1]!.turnId);
    const r = await m.handle({ type: "session.fork", id: "f", sessionId: id, isolate: false }, AUTH, CLIENT);
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    const fork = m._sessionForTest((r.data as { id: string }).id)!;
    expect(fork.canonicalHistory.map((t) => t.content)).toEqual(["keep me", "a1"]);
    const received: DaemonMessage[] = [];
    fork.attach({ id: "f", auth: AUTH, send: (msg) => received.push(msg) });
    const replay = received.find((x) => x.type === "scrollback.replay") as { messages: DaemonMessage[] };
    expect(visible(replay.messages)).toEqual(["keep me", "a1"]);
  });

  it("stops a running turn first", async () => {
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(tmp),
      _testProviderFactory: () => {
        const p = new MockSessionProvider("claude", [say("a1"), [{ type: "text_delta", content: "working…" } as ProviderEvent]], { stall: true });
        providers.push(p);
        return p;
      },
    });
    managers.push(m);
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    const s = m._sessionForTest(id)!;
    await s.send("long task", AUTH);
    for (let i = 0; i < 100 && s.status === "idle"; i++) await Bun.sleep(5);
    expect(s.status).not.toBe("idle");
    const r = await rewind(m, id, (await turns(m, id))[1]!.turnId);
    expect(r.removedTurns).toBe(1);
    expect(s.status).toBe("idle");
    expect(s.canonicalHistory.map((t) => t.content)).toEqual(["first", "a1"]);
  });

  it("refuses an unknown turn, a caller without send rights, and another tenant", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    const unknown = await m.handle({ type: "session.rewind", id: "x", sessionId: id, turnId: "nope" }, AUTH, CLIENT);
    expect(unknown.type).toBe("response.error");
    const watcher: AuthContext = { ...AUTH, scopes: ["session:watch"] as AuthContext["scopes"] };
    const t = (await turns(m, id))[0]!.turnId;
    const denied = await m.handle({ type: "session.rewind", id: "x", sessionId: id, turnId: t }, watcher, CLIENT);
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });
    const other: AuthContext = { ...AUTH, accountId: "someone-else" };
    const notFound = await m.handle({ type: "session.rewind", id: "x", sessionId: id, turnId: t }, other, CLIENT);
    expect(notFound).toMatchObject({ type: "response.error", code: "not_found" });
    expect((await turns(m, id))).toHaveLength(1);
  });
});

describe("going back a turn: the files", () => {
  it("restores changed and deleted files and removes created ones; ignored files are left alone", async () => {
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    // What the "agent" did during turn 2:
    writeFileSync(join(repo, "a.txt"), "agent edit\n");
    writeFileSync(join(repo, "new.txt"), "agent created\n");
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "out.js"), "built\n");
    rmSync(join(repo, ".gitignore"));
    writeFileSync(join(repo, ".gitignore"), "build/\n"); // unchanged content, recreated
    const t2 = (await turns(m, id))[0]!.turnId;
    // ...but these happened after turn 1 STARTED, so going back to turn 1 restores them.
    const dry = await rewind(m, id, t2, { restoreFiles: true, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.files?.applied).toBe(false);
    expect(dry.files?.restore).toEqual(["a.txt"]);
    expect(dry.files?.remove).toEqual(["new.txt"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("agent edit\n"); // dry run changed nothing
    expect(m._sessionForTest(id)!.canonicalHistory).toHaveLength(2);
  });

  it("a real restore puts the files back to the start of that turn", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "make v1");
    writeFileSync(join(repo, "a.txt"), "v1\n"); // the agent's edit in turn 1
    await sendAndSettle(m, id, "make v2 and add b");
    writeFileSync(join(repo, "a.txt"), "v2\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    rmSync(join(repo, "a.txt"));
    mkdirSync(join(repo, "deep", "er"), { recursive: true });
    writeFileSync(join(repo, "deep", "er", "c.txt"), "c\n");
    await Bun.sleep(50);
    // Pretend these were the agent's turn-2 edits: take the end snapshot now.
    const s = m._sessionForTest(id)!;
    await sendAndSettle(m, id, "noop");
    const list = await turns(m, id);
    const r = await rewind(m, id, list[1]!.turnId, { restoreFiles: true });
    expect(r.files?.applied).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(existsSync(join(repo, "deep", "er", "c.txt"))).toBe(false);
    expect(s.canonicalHistory.map((t) => t.content)).toEqual(["make v1", "a1"]);
  });

  it("refuses to overwrite hand edits made since the agent's last turn, unless forced", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    writeFileSync(join(repo, "a.txt"), "agent\n");
    await sendAndSettle(m, id, "second"); // its end snapshot records a.txt = agent
    await Bun.sleep(200);
    writeFileSync(join(repo, "a.txt"), "my own careful edit\n"); // by hand, after the agent stopped
    const t1 = (await turns(m, id))[0]!.turnId;

    const refused = await rewind(m, id, t1, { restoreFiles: true });
    expect(refused.refused).toContain("changed by hand");
    expect(refused.files?.conflicts).toEqual(["a.txt"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("my own careful edit\n");
    expect(m._sessionForTest(id)!.canonicalHistory).toHaveLength(4); // nothing taken back

    const forced = await rewind(m, id, t1, { restoreFiles: true, force: true });
    expect(forced.files?.applied).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("v0\n");
  });

  it("works in a directory that isn't a git repository", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "notes.md"), "draft 1\n");
    const m = newManager();
    const id = await create(m, plain);
    await sendAndSettle(m, id, "rewrite notes");
    writeFileSync(join(plain, "notes.md"), "rewritten\n"); // after the turn ended: a hand edit
    const r = await rewind(m, id, (await turns(m, id))[0]!.turnId, { restoreFiles: true, force: true });
    expect(r.files?.applied).toBe(true);
    expect(readFileSync(join(plain, "notes.md"), "utf8")).toBe("draft 1\n");
  });

  it("says why when there's no snapshot to restore, and still goes back", async () => {
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: { ...mkConfig(tmp), session: { checkpoints: { enabled: false } } } as CodeoidConfig,
      _testProviderFactory: () => new MockSessionProvider("claude", [say("a1")]),
    });
    managers.push(m);
    const id = await create(m);
    await sendAndSettle(m, id, "first");
    const r = await rewind(m, id, (await turns(m, id))[0]!.turnId, { restoreFiles: true });
    expect(r.filesUnavailable).toContain("turned off");
    expect(r.removedTurns).toBe(1);
  });
});

describe("irreversibleEffects", () => {
  it("lists external tool calls and shell commands with effects outside the workdir", () => {
    const effects = irreversibleEffects([
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "",
        providerId: "p",
        model: "m",
        toolCalls: [
          { id: "1", name: "run_shell", originalName: "Bash", input: { command: "ls -la" }, output: "", success: true },
          { id: "2", name: "run_shell", originalName: "Bash", input: { command: "git push origin main" }, output: "", success: true },
          { id: "3", name: "mcp__github__create_pr", input: { title: "x" }, output: "", success: true },
          { id: "4", name: "write_file", originalName: "Write", input: { file_path: "a" }, output: "", success: true },
        ],
      },
    ]);
    expect(effects).toEqual([
      { tool: "Bash", detail: "git push origin main" },
      { tool: "mcp__github__create_pr", detail: '{"title":"x"}' },
    ]);
  });
});

describe("applyRewinds", () => {
  const row = (messageId: string, extra: Partial<SessionMessage> = {}) => ({
    message: {
      type: "session.message",
      sessionId: "s",
      messageId,
      role: "user",
      content: messageId,
      identity: { sub: "u", type: "human" },
      timestamp: "t",
      ...extra,
    } as SessionMessage,
  });
  const marker = (from: string | undefined, removed: string[]) =>
    row("marker", { role: "info", metadata: { event: "session.rewound", fromMessageId: from, removedTurnIds: removed } });

  it("hides everything from the first taken-back row up to the marker", () => {
    const out = applyRewinds([row("a", { turnId: "T1" }), row("b", { turnId: "T2" }), row("note"), row("c", { turnId: "T3" }), marker("b", ["T2", "T3"])]);
    expect(out.map((r) => r.message.messageId)).toEqual(["a", "marker"]);
  });

  it("falls back to the removed turn ids when that row isn't loaded — never guesses by position", () => {
    const out = applyRewinds([row("note"), row("c", { turnId: "T3" }), row("d", { turnId: "T1" }), marker("gone", ["T3"])]);
    expect(out.map((r) => r.message.messageId)).toEqual(["note", "d", "marker"]);
  });
});
