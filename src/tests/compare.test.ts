/**
 * Side-by-side comparisons (#357) through the real SessionManager with mock
 * backends: one prompt to 2–4 forks, each on its own backend, from the same
 * conversation and files; per-branch status, reply, cost and file changes;
 * keeping one (and discarding the rest). Orchestration over forks and sends,
 * so backend-agnostic by construction.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, CompareListResultMsg, CompareState, SessionTurnsResultMsg } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:compare",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-cmp",
  projectId: "proj-cmp",
};
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

function say(provider: string, text: string): ProviderEvent[] {
  return [
    { type: "text_done", content: text } as ProviderEvent,
    {
      type: "turn_done",
      result: { providerId: provider, model: "mock", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.01, durationMs: 7 },
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

/** Each backend replies with its own name; `edits[provider]` runs when its branch's turn starts. */
function newManager(edits: Record<string, (workdir: string) => void> = {}): SessionManager {
  const factory = (id: string) => ({
    id,
    displayName: id,
    create: () => {
      const failing: ProviderEvent[] = [{ type: "error", message: `${id} backend failed` } as ProviderEvent];
      const p = new MockSessionProvider(id, id === "pi" ? [failing, failing] : [say(id, `${id} answer`), say(id, `${id} again`)]);
      const run = p.runTurn.bind(p);
      p.runTurn = (opts) => {
        // Only the compared prompt edits files (not the parent's own turns).
        if (opts.userMessage.includes("do the task")) edits[id]?.(opts.workdir);
        return run(opts);
      };
      return p;
    },
  });
  const registry = new ProviderRegistry("claude");
  for (const id of ["claude", "codex", "pi"]) registry.register(factory(id));
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, { config: mkConfig(tmp), providers: registry });
  managers.push(m);
  return m;
}

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-compare-"));
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
});

afterEach(async () => {
  for (const m of managers) await m.drain(2_000).catch(() => {});
  await transcript.flush();
  rmSync(tmp, { recursive: true, force: true });
});

async function create(m: SessionManager): Promise<string> {
  const r = await m.handle({ type: "session.create", id: "c", name: `cmp-${Math.random()}`, workdir: repo }, AUTH, CLIENT);
  if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
  return (r.data as { id: string }).id;
}

async function compare(m: SessionManager, sessionId: string, extra: Record<string, unknown>): Promise<CompareState> {
  const r = await m.handle({ type: "session.compare", id: "cmp", sessionId, ...extra } as never, AUTH, CLIENT);
  if (r.type !== "compare.state") throw new Error(JSON.stringify(r));
  return r.compare;
}

async function settled(m: SessionManager, compareId: string): Promise<CompareState> {
  for (let i = 0; i < 300; i++) {
    const r = await m.handle({ type: "compare.get", id: "g", compareId }, AUTH, CLIENT);
    if (r.type !== "compare.state") throw new Error(JSON.stringify(r));
    if (r.compare.targets.every((t) => t.done)) return r.compare;
    await Bun.sleep(10);
  }
  throw new Error("comparison never settled");
}

describe("session.compare", () => {
  it("sends one prompt to a fork per backend, from the same conversation, and reports each", async () => {
    const m = newManager({
      claude: (wd) => writeFileSync(join(wd, "a.txt"), "claude's change\nline 2\n"),
      codex: (wd) => writeFileSync(join(wd, "new.txt"), "codex made this\n"),
    });
    const parent = await create(m);
    await m._sessionForTest(parent)!.send("set the scene", AUTH);
    for (let i = 0; i < 200 && m._sessionForTest(parent)!.status !== "idle"; i++) await Bun.sleep(10);

    const started = await compare(m, parent, { prompt: "do the task", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    expect(started.targets.map((t) => t.providerId)).toEqual(["claude", "codex"]);
    const done = await settled(m, started.compareId);
    const [claude, codex] = done.targets;
    expect(claude!.reply).toBe("claude answer");
    expect(codex!.reply).toBe("codex answer");
    expect(claude!.costUsd).toBeGreaterThan(0);
    expect(claude!.files).toMatchObject({ changed: 1, insertions: 2, deletions: 1, paths: ["a.txt"] });
    expect(codex!.files).toMatchObject({ changed: 1, paths: ["new.txt"] });

    // Each branch saw the same conversation, then the prompt; the parent is untouched.
    for (const t of done.targets) {
      const s = m._sessionForTest(t.sessionId!)!;
      expect(s.canonicalHistory.filter((x) => x.role === "user").map((x) => x.content)).toEqual(["set the scene", "do the task"]);
      expect(s.workdir).not.toBe(repo); // own worktree
    }
    expect(m._sessionForTest(parent)!.canonicalHistory).toHaveLength(2);

    const list = (await m.handle({ type: "compare.list", id: "l", sessionId: parent }, AUTH, CLIENT)) as CompareListResultMsg;
    expect(list.compares.map((c) => c.compareId)).toEqual([started.compareId]);
  });

  it("can compare from an earlier turn, and the same backend twice with different models", async () => {
    const m = newManager();
    const parent = await create(m);
    const s = m._sessionForTest(parent)!;
    for (const p of ["one", "two"]) {
      await s.send(p, AUTH);
      for (let i = 0; i < 200 && s.status !== "idle"; i++) await Bun.sleep(10);
    }
    const turns = (await m.handle({ type: "session.turns", id: "t", sessionId: parent }, AUTH, CLIENT)) as SessionTurnsResultMsg;
    const started = await compare(m, parent, {
      prompt: "alt",
      afterTurnId: turns.turns[0]!.turnId,
      targets: [{ providerId: "claude", model: "opus" }, { providerId: "claude", model: "sonnet" }],
    });
    const done = await settled(m, started.compareId);
    expect(done.afterTurnId).toBe(turns.turns[0]!.turnId);
    for (const t of done.targets) {
      expect(m._sessionForTest(t.sessionId!)!.canonicalHistory.filter((x) => x.role === "user").map((x) => x.content)).toEqual(["one", "alt"]);
    }
    expect(done.targets.map((t) => t.model)).toEqual(["opus", "sonnet"]);
  });

  it("a branch whose turn fails is reported — never with the parent's reply — and the others carry on", async () => {
    const m = newManager();
    const parent = await create(m);
    const p = m._sessionForTest(parent)!;
    await p.send("earlier", AUTH);
    for (let i = 0; i < 200 && p.status !== "idle"; i++) await Bun.sleep(10);
    expect(p.lastAssistantText).toBe("claude answer");
    const started = await compare(m, parent, { prompt: "go", targets: [{ providerId: "claude" }, { providerId: "pi" }] });
    // Running: no reply shown yet (not even the inherited one).
    expect(started.targets.every((t) => t.reply === undefined && !t.done)).toBe(true);
    const done = await settled(m, started.compareId);
    expect(done.targets[0]!.reply).toBe("claude answer");
    expect(done.targets[1]!.status).toBe("error");
    expect(done.targets[1]!.error).toContain("pi backend failed");
    expect(done.targets[1]!.reply).toBeUndefined();
  });

  it("freezes each branch's result: carrying on in it later changes nothing", async () => {
    const m = newManager();
    const parent = await create(m);
    const started = await compare(m, parent, { prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    const done = await settled(m, started.compareId);
    const branch = m._sessionForTest(done.targets[0]!.sessionId!)!;
    await branch.send("more", AUTH);
    for (let i = 0; i < 200 && branch.status !== "idle"; i++) await Bun.sleep(10);
    expect(branch.lastAssistantText).toBe("claude again");
    const again = await settled(m, started.compareId);
    expect(again.targets[0]).toMatchObject({ reply: "claude answer", costUsd: done.targets[0]!.costUsd, status: "idle", done: true });
  });

  it("keeps one branch and can discard the others", async () => {
    const m = newManager();
    const parent = await create(m);
    const started = await compare(m, parent, { prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }, { providerId: "claude", model: "sonnet" }] });
    await settled(m, started.compareId);
    const keep = started.targets[1]!.sessionId!;
    const doomed = [started.targets[0]!, started.targets[2]!].map((t) => ({ id: t.sessionId!, wd: m._sessionForTest(t.sessionId!)!.workdir }));
    const r = await m.handle({ type: "compare.keep", id: "k", compareId: started.compareId, sessionId: keep, discardOthers: true }, AUTH, CLIENT);
    if (r.type !== "compare.state") throw new Error(JSON.stringify(r));
    expect(r.compare.keptSessionId).toBe(keep);
    expect(r.compare.targets.map((t) => t.status)).toEqual(["gone", "idle", "gone"]);
    for (const d of doomed) {
      expect(m._sessionForTest(d.id)).toBeUndefined();
      expect(existsSync(d.wd)).toBe(false); // their worktrees went with them
    }
    // One keep per comparison: a second can't destroy the first.
    const second = await m.handle({ type: "compare.keep", id: "k2", compareId: started.compareId, sessionId: started.targets[0]!.sessionId!, discardOthers: true }, AUTH, CLIENT);
    expect(second).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(m._sessionForTest(keep)).toBeDefined();
  });

  it("refuses up front — leaving nothing behind — a model the backend doesn't have, a busy session, and a folder that isn't a git repo", async () => {
    const m = newManager();
    const parent = await create(m);
    const count = async () => {
      const r = await m.handle({ type: "session.list", id: "l" }, AUTH, CLIENT);
      return r.type === "session.list.result" ? r.sessions.length : -1;
    };
    const before = await count();
    const badModel = await m.handle({ type: "session.compare", id: "x", sessionId: parent, prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex", model: "opus" }] } as never, AUTH, CLIENT);
    expect(badModel).toMatchObject({ type: "response.error", code: "invalid_request" });
    const flag = await m.handle({ type: "session.compare", id: "x", sessionId: parent, prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex", model: "--yolo" }] } as never, AUTH, CLIENT);
    expect(flag).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(await count()).toBe(before);

    const p = m._sessionForTest(parent)!;
    await p.send("busy", AUTH); // resolves once its turn has started
    const busy = await m.handle({ type: "session.compare", id: "x", sessionId: parent, prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }] } as never, AUTH, CLIENT);
    expect(busy).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect((busy as { error: string }).error).toContain("working");
    expect(await count()).toBe(before);

    const plain = join(tmp, "plain");
    mkdirSync(plain);
    const r = await m.handle({ type: "session.create", id: "c2", name: "plain", workdir: plain }, AUTH, CLIENT);
    const plainId = (r as { data: { id: string } }).data.id;
    const noGit = await m.handle({ type: "session.compare", id: "x", sessionId: plainId, prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }] } as never, AUTH, CLIENT);
    expect(noGit).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect((noGit as { error: string }).error).toContain("git repository");
  });

  it("forgets a session's comparisons when the session is destroyed", async () => {
    const m = newManager();
    const parent = await create(m);
    const started = await compare(m, parent, { prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    await settled(m, started.compareId);
    await m.handle({ type: "session.destroy", id: "d", sessionId: parent }, AUTH, CLIENT);
    const r = await m.handle({ type: "compare.get", id: "g", compareId: started.compareId }, AUTH, CLIENT);
    expect(r).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("refuses unknown backends, missing scopes and other tenants", async () => {
    const m = newManager();
    const parent = await create(m);
    const bad = await m.handle({ type: "session.compare", id: "x", sessionId: parent, prompt: "go", targets: [{ providerId: "claude" }, { providerId: "nope" }] } as never, AUTH, CLIENT);
    expect(bad).toMatchObject({ type: "response.error", code: "invalid_request" });
    const sendOnly: AuthContext = { ...AUTH, scopes: ["session:send"] as AuthContext["scopes"] };
    const noCreate = await m.handle({ type: "session.compare", id: "x", sessionId: parent, prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }] } as never, sendOnly, CLIENT);
    expect(noCreate).toMatchObject({ type: "response.error", code: "forbidden" });

    const started = await compare(m, parent, { prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    const other: AuthContext = { ...AUTH, accountId: "someone-else" };
    const peek = await m.handle({ type: "compare.get", id: "x", compareId: started.compareId }, other, CLIENT);
    expect(peek).toMatchObject({ type: "response.error", code: "not_found" });
    const keepNoDestroy = await m.handle(
      { type: "compare.keep", id: "x", compareId: started.compareId, sessionId: started.targets[0]!.sessionId!, discardOthers: true },
      { ...AUTH, scopes: ["session:send"] as AuthContext["scopes"] },
      CLIENT,
    );
    expect(keepNoDestroy).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  it("a slow settle of one branch can't undo a keep of another (so a second keep can't destroy it)", async () => {
    const m = newManager();
    const parent = await create(m);
    const started = await compare(m, parent, { prompt: "do the task", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    const a = m._sessionForTest(started.targets[0]!.sessionId!)! as unknown as { turnFiles: (id: string) => Promise<unknown> };
    const orig = a.turnFiles.bind(a);
    a.turnFiles = async (id: string) => {
      await Bun.sleep(600);
      return orig(id);
    };
    const b = started.targets[1]!.sessionId!;
    for (let i = 0; i < 300 && !store.getCompareRun(started.compareId, AUTH.accountId!, AUTH.projectId!)!.targets[1]!.result; i++) await Bun.sleep(10);
    const k = await m.handle({ type: "compare.keep", id: "k", compareId: started.compareId, sessionId: b }, AUTH, CLIENT);
    expect(k.type).toBe("compare.state");
    await Bun.sleep(900); // A's settle lands
    expect(store.getCompareRun(started.compareId, AUTH.accountId!, AUTH.projectId!)!.keptSessionId).toBe(b);
    const k2 = await m.handle({ type: "compare.keep", id: "k2", compareId: started.compareId, sessionId: started.targets[0]!.sessionId!, discardOthers: true }, AUTH, CLIENT);
    expect(k2).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(m._sessionForTest(b)).toBeDefined();
  });

  it("destroying the session while its branches run doesn't bring the comparison back", async () => {
    const m = newManager();
    const parent = await create(m);
    const started = await compare(m, parent, { prompt: "do the task", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    await m.handle({ type: "session.destroy", id: "d", sessionId: parent }, AUTH, CLIENT);
    for (const t of started.targets) {
      const s = m._sessionForTest(t.sessionId!)!;
      for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
    }
    await Bun.sleep(200);
    expect(store.getCompareRun(started.compareId, AUTH.accountId!, AUTH.projectId!)).toBeNull();
    const r = await m.handle({ type: "compare.get", id: "g", compareId: started.compareId }, AUTH, CLIENT);
    expect(r).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("a branch destroyed while working reads as gone, and a branch that never started (restart) as failed", async () => {
    const m = newManager();
    const parent = await create(m);
    const started = await compare(m, parent, { prompt: "do the task", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    await m.handle({ type: "session.destroy", id: "d", sessionId: started.targets[0]!.sessionId! }, AUTH, CLIENT);
    const done = await settled(m, started.compareId);
    expect(done.targets[0]).toMatchObject({ status: "gone", done: true });

    // A stored comparison whose branch's prompt never ran (no live sends: as after a restart).
    const ghost = started.targets[1]!.sessionId!;
    store.saveCompareRun({
      id: "ghost-compare",
      accountId: AUTH.accountId!,
      projectId: AUTH.projectId!,
      parentSessionId: parent,
      prompt: "never ran",
      targets: [{ providerId: "codex", sessionId: ghost }],
      createdBy: AUTH.sub,
      createdAt: new Date().toISOString(),
    });
    const g = await settled(m, "ghost-compare");
    expect(g.targets[0]).toMatchObject({ status: "failed", done: true });
    expect(g.targets[0]!.error).toContain("didn't start");
  });

  it("survives a daemon restart", async () => {
    const m = newManager();
    const parent = await create(m);
    const started = await compare(m, parent, { prompt: "go", targets: [{ providerId: "claude" }, { providerId: "codex" }] });
    await settled(m, started.compareId);
    await m.drain(2_000);
    await transcript.flush();
    const next = newManager();
    await next.resumeSessions();
    const r = await next.handle({ type: "compare.get", id: "g", compareId: started.compareId }, AUTH, CLIENT);
    if (r.type !== "compare.state") throw new Error(JSON.stringify(r));
    expect(r.compare.targets.map((t) => t.reply)).toEqual(["claude answer", "codex answer"]);
  });
});
