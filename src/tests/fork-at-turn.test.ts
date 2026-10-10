/**
 * Forking from an earlier turn (#356) through the real SessionManager with a
 * mock backend: the fork carries the conversation through that turn (not
 * after), its turn list and rows, and — in a worktree codeoid makes — the
 * files as they were right after it. Backend-agnostic: everything comes from
 * codeoid's own records.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { cutRowsBeforeTurns, SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo, SessionMessage, SessionTurnsResultMsg } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:fork-at",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-fa",
  projectId: "proj-fa",
};
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

function say(text: string): ProviderEvent[] {
  return [
    { type: "text_done", content: text } as ProviderEvent,
    {
      type: "turn_done",
      result: { providerId: "claude", model: "mock", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 },
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

/** `agentEdits[i]` runs when the backend starts turn i (after the start snapshot). */
function newManager(agentEdits: Array<(() => void) | undefined> = []): SessionManager {
  let turn = 0;
  const factory = (id: string) => ({
    id,
    displayName: id,
    create: () => {
      const p = new MockSessionProvider(id, [say("a1"), say("a2"), say("a3"), say("a4"), say("a5")]);
      const run = p.runTurn.bind(p);
      p.runTurn = (opts) => {
        agentEdits[turn++]?.();
        return run(opts);
      };
      providers.push(p);
      return p;
    },
  });
  const registry = new ProviderRegistry("claude");
  registry.register(factory("claude"));
  registry.register(factory("pi"));
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, { config: mkConfig(tmp), providers: registry });
  managers.push(m);
  return m;
}

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-forkat-"));
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
  const r = await m.handle({ type: "session.create", id: "c", name: `fa-${Math.random()}`, workdir }, AUTH, CLIENT);
  if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
  return (r.data as { id: string }).id;
}

async function sendAndSettle(m: SessionManager, id: string, text: string): Promise<void> {
  const s = m._sessionForTest(id)!;
  await s.send(text, AUTH);
  for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
  expect(s.status).toBe("idle");
  await Bun.sleep(40); // the end-of-turn snapshot
}

async function turns(m: SessionManager, id: string): Promise<SessionTurnsResultMsg["turns"]> {
  const r = await m.handle({ type: "session.turns", id: "t", sessionId: id }, AUTH, CLIENT);
  if (r.type !== "session.turns.result") throw new Error(JSON.stringify(r));
  return r.turns;
}

async function fork(m: SessionManager, id: string, extra: Record<string, unknown>): Promise<SessionInfo> {
  const r = await m.handle({ type: "session.fork", id: "f", sessionId: id, ...extra } as never, AUTH, CLIENT);
  if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
  return r.data as SessionInfo;
}

function replayOf(m: SessionManager, id: string): SessionMessage[] {
  const received: DaemonMessage[] = [];
  m._sessionForTest(id)!.attach({ id: `w-${Math.random()}`, auth: AUTH, send: (msg) => received.push(msg) });
  const replay = received.find((x) => x.type === "scrollback.replay") as { messages: SessionMessage[] } | undefined;
  return replay?.messages ?? [];
}

describe("forking from an earlier turn", () => {
  it("carries the conversation, turn list and rows through that turn — not after", async () => {
    const m = newManager();
    const id = await create(m);
    for (const t of ["one", "two", "three"]) await sendAndSettle(m, id, t);
    const list = await turns(m, id);
    const info = await fork(m, id, { afterTurnId: list[1]!.turnId, isolate: false });
    const f = m._sessionForTest(info.id)!;
    expect(f.canonicalHistory.map((t) => t.content)).toEqual(["one", "a1", "two", "a2"]);
    expect((await turns(m, info.id)).map((t) => t.preview)).toEqual(["one", "two"]);
    expect(info.forkedFrom?.atTurn).toBe(2);
    const visible = replayOf(m, info.id).filter((x) => x.role === "user" || (x.role === "assistant" && x.content)).map((x) => x.content);
    expect(visible).toEqual(["one", "a1", "two", "a2"]);
    // The parent is untouched.
    expect(m._sessionForTest(id)!.canonicalHistory).toHaveLength(6);
  });

  it("in its own worktree, the fork's files are as they were right after that turn", async () => {
    const m = newManager([
      () => writeFileSync(join(repo, "a.txt"), "after turn 1\n"),
      () => {
        writeFileSync(join(repo, "a.txt"), "after turn 2\n");
        writeFileSync(join(repo, "b.txt"), "created in turn 2\n");
      },
    ]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const list = await turns(m, id);
    const info = await fork(m, id, { afterTurnId: list[0]!.turnId });
    expect(info.worktree?.createdByCodeoid).toBe(true);
    expect(readFileSync(join(info.workdir, "a.txt"), "utf8")).toBe("after turn 1\n");
    expect(existsSync(join(info.workdir, "b.txt"))).toBe(false);
    // The parent's files stay as they are now.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("after turn 2\n");
    expect(replayOf(m, info.id).some((x) => x.metadata?.event === "fork.files" && x.content.includes("right after prompt 1"))).toBe(true);
    // The fork keeps its inherited snapshots and can itself go further back.
    expect((await turns(m, info.id))[0]!.checkpoint).toBeDefined();
  });

  it("in a shared directory, the files are left alone and the fork says so", async () => {
    const m = newManager([() => writeFileSync(join(repo, "a.txt"), "after turn 1\n"), () => writeFileSync(join(repo, "a.txt"), "after turn 2\n")]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const info = await fork(m, id, { afterTurnId: (await turns(m, id))[0]!.turnId, isolate: false });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("after turn 2\n");
    expect(replayOf(m, info.id).some((x) => x.metadata?.event === "fork.files" && x.content.includes("current ones"))).toBe(true);
  });

  it("from the latest turn it's an ordinary fork (current files, no notice)", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    const info = await fork(m, id, { afterTurnId: (await turns(m, id))[0]!.turnId, isolate: false });
    expect(m._sessionForTest(info.id)!.canonicalHistory.map((t) => t.content)).toEqual(["one", "a1"]);
    expect(replayOf(m, info.id).some((x) => x.metadata?.event === "fork.files")).toBe(false);
  });

  it("can continue on another backend from that point", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const info = await fork(m, id, { afterTurnId: (await turns(m, id))[0]!.turnId, providerId: "pi", isolate: false });
    expect(info.providerId).toBe("pi");
    expect(providers.at(-1)!.seededHistory?.map((t) => t.content)).toEqual(["one", "a1"]);
  });

  it("works after a daemon restart", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    await m.drain(2_000);
    await transcript.flush();
    const next = newManager();
    await next.resumeSessions();
    const info = await fork(next, id, { afterTurnId: (await turns(next, id))[0]!.turnId, isolate: false });
    expect(next._sessionForTest(info.id)!.canonicalHistory.map((t) => t.content)).toEqual(["one", "a1"]);
  });

  it("refuses a turn the session doesn't have", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    const r = await m.handle({ type: "session.fork", id: "f", sessionId: id, afterTurnId: "nope" } as never, AUTH, CLIENT);
    expect(r).toMatchObject({ type: "response.error", code: "not_found" });
  });
});

describe("forking from an earlier turn: round-1 regressions", () => {
  it("a session in an untracked subdirectory: the fork opens in that subdirectory with its files; the repo's files are intact", async () => {
    git("init", "-q");
    writeFileSync(join(repo, "README"), "top\n");
    git("add", ".");
    git("commit", "-qm", "readme");
    const sub = join(repo, "newpkg");
    mkdirSync(sub);
    writeFileSync(join(sub, "x.txt"), "x0\n");
    const m = newManager([() => writeFileSync(join(sub, "x.txt"), "x1\n"), () => writeFileSync(join(sub, "x.txt"), "x2\n")]);
    const id = await create(m, sub);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const info = await fork(m, id, { afterTurnId: (await turns(m, id))[0]!.turnId });
    expect(info.workdir.endsWith("/newpkg")).toBe(true);
    expect(readFileSync(join(info.workdir, "x.txt"), "utf8")).toBe("x1\n");
    const root = info.worktree!.path;
    expect(readFileSync(join(root, "README"), "utf8")).toBe("top\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v0\n");
  });

  it("refuses a point before a context rotation instead of forking with no conversation", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    await sendAndSettle(m, id, "three"); // rotation needs a few turns first
    const r = await m.handle({ type: "session.rotate", id: "rot", sessionId: id }, AUTH, CLIENT);
    expect(r).toMatchObject({ type: "response.ok", data: { rotated: true } });
    await sendAndSettle(m, id, "four");
    const list = await turns(m, id);
    const refused = await m.handle({ type: "session.fork", id: "f", sessionId: id, afterTurnId: list[0]!.turnId } as never, AUTH, CLIENT);
    expect(refused).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect((refused as { error: string }).error).toContain("context rotation");
    // A point after the rotation still works.
    const ok = await fork(m, id, { afterTurnId: list[3]!.turnId, isolate: false });
    const kept = m._sessionForTest(ok.id)!.canonicalHistory;
    expect(kept.map((t) => t.turnId)).toEqual([list[3]!.turnId, list[3]!.turnId]);
    expect(kept.at(-1)!.content).toBe("a4");
  });

  it("refuses an earlier turn together with a base branch", async () => {
    const m = newManager();
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const r = await m.handle(
      { type: "session.fork", id: "f", sessionId: id, afterTurnId: (await turns(m, id))[0]!.turnId, baseBranch: "main" } as never,
      AUTH,
      CLIENT,
    );
    expect(r).toMatchObject({ type: "response.error", code: "invalid_request" });
  });

  it("starts the fork's git history at the commit checked out back then", async () => {
    const m = newManager([undefined, () => {
      writeFileSync(join(repo, "a.txt"), "committed later\n");
      git("commit", "-qam", "a later commit");
    }]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    const headAtOne = git("rev-parse", "HEAD").trim();
    await sendAndSettle(m, id, "two");
    expect(git("rev-parse", "HEAD").trim()).not.toBe(headAtOne);
    const info = await fork(m, id, { afterTurnId: (await turns(m, id))[0]!.turnId });
    const wt = (...a: string[]) => execFileSync("git", a, { cwd: info.workdir, encoding: "utf8" });
    expect(wt("rev-parse", "HEAD").trim()).toBe(headAtOne);
    expect(wt("status", "--porcelain").trim()).toBe(""); // no phantom revert of later commits
    expect(readFileSync(join(info.workdir, "a.txt"), "utf8")).toBe("v0\n");
  });

  it("going back later in the fork has its baseline (no false conflicts)", async () => {
    const m = newManager([() => writeFileSync(join(repo, "a.txt"), "after one\n"), () => writeFileSync(join(repo, "a.txt"), "after two\n")]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const { deleteCheckpoint, endSnapshotId } = await import("../daemon/checkpoints.js");
    const list = await turns(m, id);
    // Force the next-turn-start fallback.
    await deleteCheckpoint(join(tmp, "transcripts", "checkpoints"), id, endSnapshotId(list[0]!.turnId));
    const info = await fork(m, id, { afterTurnId: list[0]!.turnId });
    await Bun.sleep(100);
    const r = await m.handle({ type: "session.rewind", id: "rw", sessionId: info.id, turnId: list[0]!.turnId, restoreFiles: true, dryRun: true }, AUTH, CLIENT);
    if (r.type !== "session.rewind.result") throw new Error(JSON.stringify(r));
    expect(r.files?.conflicts).toEqual([]);
  });
});

describe("cutRowsBeforeTurns", () => {
  const row = (id: string, turnId?: string) => ({ message: { type: "session.message", messageId: id, ...(turnId ? { turnId } : {}) } as unknown as DaemonMessage });
  it("cuts at the first row of the first later turn, notices between turns going with what came after", () => {
    const out = cutRowsBeforeTurns([row("a", "T1"), row("b", "T1"), row("note"), row("c", "T2"), row("d", "T3")], ["T2", "T3"]);
    expect(out.map((r) => (r.message as { messageId: string }).messageId)).toEqual(["a", "b", "note"]);
  });
  it("keeps everything when no later turn is given or loaded", () => {
    expect(cutRowsBeforeTurns([row("a", "T1")], [])).toHaveLength(1);
    expect(cutRowsBeforeTurns([row("a", "T1")], ["T9"])).toHaveLength(1);
  });
});
