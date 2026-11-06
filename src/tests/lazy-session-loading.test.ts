/**
 * Lazy session loading: a resumed session holds its metadata only, and loads
 * its scrollback and canonical history the first time something uses it.
 *
 * Every client-visible behaviour of a resumed session must be the one an
 * eagerly loaded session has. So each test here runs the same scenario on two
 * copies of one daemon's data — one resumed with `session.lazyLoad: false`
 * (the history loaded at start, as before) and one lazily — and compares what
 * a client sees: ids, timestamps and the data dirs normalized, nothing else.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { CanonicalTurn } from "../daemon/providers/canonical.js";
import type { ProviderEvent, SessionScopedEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { type AttachedClient, Session } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { type AuthContext, CAPABILITIES, type DaemonMessage, type SessionInfo, type SessionMessage } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:lazy",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-lazy",
  projectId: "proj-lazy",
};

const RESULT = {
  providerId: "mock",
  model: "mock",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalCostUsd: 0.01,
  durationMs: 1,
};

function say(text: string): ProviderEvent[] {
  return [{ type: "text_done", content: text } as ProviderEvent, { type: "turn_done", result: RESULT } as ProviderEvent];
}

/** A turn that reads a file (a safe tool: it runs unasked), then answers. */
function readThenSay(n: number, text: string): ProviderEvent[] {
  return [
    { type: "tool_start", toolId: `t${n}`, sdkToolUseId: `sdk-t${n}`, name: "Read", input: { file_path: "a.txt" }, approvalId: `ap-${n}` } as ProviderEvent,
    { type: "tool_complete", sdkToolUseId: `sdk-t${n}`, output: `v0 (read ${n})`, success: true } as ProviderEvent,
    ...say(text),
  ];
}

/** Replies long enough that a 2 KiB attach tail and paging have work to do. */
const long = (n: number): string => `answer ${n}: ${"lorem ipsum dolor sit amet ".repeat(12)}`;

function mkConfig(root: string, lazyLoad?: boolean): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(root, "codeoid.db"),
    transcriptDir: join(root, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: { attachTailBytes: 2048, ...(lazyLoad !== undefined ? { lazyLoad } : {}) },
    conductor: { enabled: false, name: "conductor", provider: "claude" },
  } as CodeoidConfig;
}

/** One daemon over one data dir. */
interface Env {
  label: string;
  root: string;
  repo: string;
  store: Store;
  transcript: TranscriptStore;
  m: SessionManager;
  /** Every provider the manager built, oldest first. */
  made: MockSessionProvider[];
}

/** Each provider replies to the next prompts with these, in order. */
const REPLIES = (): ProviderEvent[][] => [say("r1"), say("r2"), say("r3"), say("r4")];

function openEnv(label: string, root: string, lazyLoad?: boolean, script: () => ProviderEvent[][] = REPLIES): Env {
  const made: MockSessionProvider[] = [];
  const registry = new ProviderRegistry("claude");
  for (const id of ["claude", "codex", "gemini-cli"]) {
    registry.register({
      id,
      displayName: id,
      create: () => {
        const p = new MockSessionProvider(id, script());
        made.push(p);
        return p;
      },
    });
  }
  const store = new Store(join(root, "codeoid.db"));
  const transcript = new TranscriptStore(join(root, "transcripts"));
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(root, lazyLoad),
    providers: registry,
  });
  return { label, root, repo: join(root, "repo"), store, transcript, m, made };
}

async function closeEnv(env: Env): Promise<void> {
  env.m.stopRoutines();
  env.m.stopLoops();
  await env.m.drain(3_000).catch(() => {});
  await env.transcript.flush();
  try {
    env.store.close();
  } catch {}
}

const client = (id: string, sink: DaemonMessage[], capabilities?: string[]): AttachedClient => ({
  id,
  auth: AUTH,
  send: (msg: DaemonMessage) => sink.push(msg),
  ...(capabilities ? { capabilities } : {}),
});

async function call(env: Env, msg: Record<string, unknown>, sink: DaemonMessage[] = []): Promise<DaemonMessage> {
  return env.m.handle({ id: "req", ...msg } as never, AUTH, client("cli", sink));
}

async function settle(env: Env, sessionId: string): Promise<void> {
  const s = env.m._sessionForTest(sessionId)!;
  const busy = () => s.status !== "idle" || s.turnInFlight || s.preparingTurn;
  for (let i = 0; i < 400 && busy(); i++) await Bun.sleep(5);
  expect(s.status).toBe("idle");
  await Bun.sleep(20);
}

async function sendAndSettle(env: Env, sessionId: string, text: string): Promise<DaemonMessage> {
  const r = await call(env, { type: "session.send", sessionId, text });
  await settle(env, sessionId);
  return r;
}

// ── The data both daemons resume ─────────────────────────────────────────

let base: string;
/** Session ids in the fixture, by name. */
const ids: Record<string, string> = {};
const roots: string[] = [];

/**
 * One daemon's data: a long session with tool calls and notices, a short
 * one, an empty one, one on a backend that is re-seeded after a teardown,
 * and one from before the canonical log (loaded at start either way).
 */
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "codeoid-lazy-base-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "v0\n");
  git("add", ".");
  git("commit", "-qm", "init");

  const script = () => [
    say(long(1)),
    readThenSay(2, long(2)),
    say(long(3)),
    readThenSay(4, long(4)),
    say(long(5)),
    say(long(6)),
  ];
  const env = openEnv("base", base, undefined, script);
  const create = async (name: string, providerId?: string): Promise<string> => {
    const r = await call(env, { type: "session.create", name, workdir: repo, ...(providerId ? { providerId } : {}) });
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    return (r.data as { id: string }).id;
  };
  ids.rich = await create("rich");
  for (let i = 1; i <= 6; i++) await sendAndSettle(env, ids.rich, `prompt ${i}: ${"please ".repeat(20)}`);
  await call(env, { type: "session.pin", sessionId: ids.rich, path: "a.txt" });
  await call(env, { type: "session.set_mode", sessionId: ids.rich, mode: "autonomous", maxTurns: 7 });

  ids.short = await create("short");
  await sendAndSettle(env, ids.short, "hello");
  await call(env, { type: "session.rename", sessionId: ids.short, name: "short-renamed" });

  ids.empty = await create("empty");

  ids.gemini = await create("gemini", "gemini-cli");
  await sendAndSettle(env, ids.gemini, "hi gemini");

  ids.legacy = await create("legacy");
  await sendAndSettle(env, ids.legacy, "old times");

  // A routine that keeps its session across runs: its session is resumed.
  const routine = await call(env, {
    type: "routine.create",
    spec: { name: "daily", prompt: "report", workdir: repo, approvals: "guarded", session: "persistent" },
  });
  if (routine.type !== "routine.snapshot") throw new Error(JSON.stringify(routine));
  ids.routine = routine.routine.id;
  const run = await call(env, { type: "routine.run", routine: "daily" });
  if (run.type !== "routine.run.result") throw new Error(JSON.stringify(run));
  ids.routineSession = (await runEnds(env, ids.routine, run.run.id)).sessionId!;

  await closeEnv(env);
  // From before the canonical log and the turn index (#354).
  rmSync(join(base, "transcripts", `${ids.legacy}.canonical.jsonl`));
  rmSync(join(base, "transcripts", `${ids.legacy}.turns.jsonl`));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await closeEnv(e);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A copy of the fixture, its sessions pointed at the copy's repo. */
function cloneBase(label: string): string {
  // Same-length names: a path inside an export counts toward its size.
  const root = mkdtempSync(join(tmpdir(), `codeoid-lazy-${label.slice(0, 4)}-`));
  roots.push(root);
  cpSync(base, root, { recursive: true });
  const dir = join(root, "transcripts");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".meta.json")) continue;
    const p = join(dir, f);
    writeFileSync(p, readFileSync(p, "utf8").split(base).join(root));
  }
  // A copied repository's index has stale stat data, which makes a fork's
  // `git stash create` fail: refresh it, as any git command would.
  execFileSync("git", ["status", "--porcelain"], { cwd: join(root, "repo") });
  return root;
}

/** The fixture resumed eagerly and lazily. */
async function both(script?: () => ProviderEvent[][]): Promise<{ eager: Env; lazy: Env }> {
  const eager = openEnv("eager", cloneBase("eager"), false, script);
  const lazy = openEnv("lazy", cloneBase("lazy"), true, script);
  envs.push(eager, lazy);
  await eager.m.resumeSessions();
  await lazy.m.resumeSessions();
  return { eager, lazy };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
/** A git object id (a checkpoint taken during the test embeds the clock). */
const SHA = /\b[0-9a-f]{40}\b/g;
/** Epoch milliseconds (a turn's `createdAt`). */
const EPOCH_MS = /\b1[7-9]\d{11}\b/g;

/** A stable placeholder per distinct value, numbered by first appearance. */
function token(seen: Map<string, string>, value: string, kind: string): string {
  let t = seen.get(value);
  if (t === undefined) {
    t = `<${kind}${seen.size}>`;
    seen.set(value, t);
  }
  return t;
}

/** What a client sees, with each daemon's own ids, clock and paths taken out. */
function norm(env: Env, v: unknown): unknown {
  const fixed = new Map(Object.values(ids).map((id) => [id, id]));
  const fresh = new Map<string, string>();
  const shas = new Map<string, string>();
  const text = JSON.stringify(v ?? null)
    .split(env.root)
    .join("<root>")
    .split(base)
    .join("<root>")
    .replace(ISO, "<ts>")
    .replace(EPOCH_MS, "\"<ms>\"")
    .replace(SHA, (sha) => token(shas, sha, "sha"))
    .replace(UUID, (id) => fixed.get(id) ?? token(fresh, id, "id"));
  return JSON.parse(text);
}

/** Run `scenario` on both and expect the same result. */
async function same<T>(pair: { eager: Env; lazy: Env }, scenario: (env: Env) => Promise<T>): Promise<T> {
  const before = Session.syncHydrations;
  const a = await scenario(pair.eager);
  const b = await scenario(pair.lazy);
  expect(norm(pair.lazy, b)).toEqual(norm(pair.eager, a));
  // Every path above awaited the load: none had to block on it.
  expect(Session.syncHydrations).toBe(before);
  return b;
}

const sessionOf = (env: Env, name: keyof typeof ids) => env.m._sessionForTest(ids[name]!)!;
const loaded = (env: Env, name: keyof typeof ids) => sessionOf(env, name).hydrated;

/** Infos as a client lists them. */
async function list(env: Env): Promise<SessionInfo[]> {
  const r = await call(env, { type: "session.list" });
  if (r.type !== "session.list.result") throw new Error(JSON.stringify(r));
  return [...r.sessions].sort((x, y) => x.id.localeCompare(y.id));
}

/** What attaching shows. */
async function attach(env: Env, sessionId: string, capabilities?: string[], resume?: { key: string; sinceSeq: number }): Promise<DaemonMessage[]> {
  const frames: DaemonMessage[] = [];
  const r = await env.m.handle(
    { type: "session.attach", id: "att", sessionId, ...(resume ? { resume } : {}) } as never,
    AUTH,
    client(`att-${Math.random()}`, frames, capabilities),
  );
  return [r, ...frames.filter((f) => f.type === "scrollback.replay")];
}

async function runEnds(env: Env, routine: string, runId: string): Promise<{ status: string; sessionId?: string; summary?: string }> {
  for (let i = 0; i < 400; i++) {
    const r = await call(env, { type: "routine.runs", routine, runId });
    const run = r.type === "routine.runs.result" ? r.runs[0] : undefined;
    if (run && !["queued", "checking", "running"].includes(run.status)) return run;
    await Bun.sleep(25);
  }
  throw new Error("routine run never ended");
}

/** The transcript's seqs, in file order. */
function seqsOnDisk(env: Env, sessionId: string): number[] {
  const text = readFileSync(env.transcript.transcriptPath(sessionId), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { seq: number }).seq);
}

const PAGING = [CAPABILITIES.SCROLLBACK_PAGING];

// ── Tests ────────────────────────────────────────────────────────────────

describe("lazy session loading: a resumed session before it is used", () => {
  it("lists with the same info, and loads nothing (a session from before the canonical log, or with none yet, loads at start)", async () => {
    const pair = await both();
    await same(pair, list);
    await same(pair, async (env) => Object.keys(ids).filter((k) => k !== "routine").map((k) => env.m._sessionForTest(ids[k]!)?.toInfo()));
    for (const name of ["rich", "short", "gemini", "routineSession"] as const) {
      expect([name, loaded(pair.eager, name)]).toEqual([name, true]);
      expect([name, loaded(pair.lazy, name)]).toEqual([name, false]);
    }
    expect(loaded(pair.lazy, "legacy")).toBe(true);
    // Never had a turn: no log to read lazily, and nothing to hold.
    expect(loaded(pair.lazy, "empty")).toBe(true);
  });

  it("reports the same newest turn (what a routine reads before its run) without loading", async () => {
    const pair = await both();
    await same(pair, async (env) =>
      (["rich", "short", "empty", "gemini"] as const).map((n) => [sessionOf(env, n).lastTurnId, sessionOf(env, n).lastTurnRole, sessionOf(env, n).currentTurnId]),
    );
    expect(loaded(pair.lazy, "rich")).toBe(false);
  });

  it("the fleet board shows the same, without loading", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const r = await call(env, { type: "fleet.subscribe", scope: "tenant" });
      return r;
    });
    expect(loaded(pair.lazy, "rich")).toBe(false);
  });

  it("the turn list is the same, without loading", async () => {
    const pair = await both();
    await same(pair, async (env) => call(env, { type: "session.turns", sessionId: ids.rich }));
    expect(loaded(pair.lazy, "rich")).toBe(false);
  });

  it("a notice while unloaded (mode, rename) is in the scrollback and on disk in order, its seq never reused", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      await call(env, { type: "session.set_mode", sessionId: ids.short, mode: "guarded" });
      await call(env, { type: "session.rename", sessionId: ids.short, name: "short-again" });
      return sessionOf(env, "short").toInfo();
    });
    expect(loaded(pair.lazy, "short")).toBe(false);
    await same(pair, async (env) => attach(env, ids.short!));
    await same(pair, async (env) => {
      await sendAndSettle(env, ids.short!, "after the notices");
      await env.transcript.flush();
      return attach(env, ids.short!);
    });
    for (const env of [pair.eager, pair.lazy]) {
      const seqs = seqsOnDisk(env, ids.short!);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    }
    expect(seqsOnDisk(pair.lazy, ids.short!)).toEqual(seqsOnDisk(pair.eager, ids.short!));
  });
});

describe("lazy session loading: using a resumed session", () => {
  it("attach replays the same: tail-first with paging, whole for a legacy client, and a stale cursor gets a snapshot", async () => {
    const pair = await both();
    await same(pair, (env) => attach(env, ids.rich!, PAGING));
    await same(pair, (env) => attach(env, ids.rich!));
    await same(pair, (env) => attach(env, ids.rich!, PAGING, { key: "from-before-the-restart", sinceSeq: 3 }));
    expect(loaded(pair.lazy, "rich")).toBe(true);
  });

  it("incremental resume by seq continues the same after a new turn", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const first = await attach(env, ids.rich!, PAGING);
      const replay = first.find((f) => f.type === "scrollback.replay") as { resumeKey: string; maxSeq: number };
      await sendAndSettle(env, ids.rich!, "one more");
      const again = await attach(env, ids.rich!, PAGING, { key: replay.resumeKey, sinceSeq: replay.maxSeq });
      return { maxSeq: replay.maxSeq, again };
    });
  });

  it("paging back through the whole history gives the same pages; MCP control's read_transcript page too", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const pages: DaemonMessage[] = [];
      // read_transcript: the newest page, no anchor.
      pages.push(await call(env, { type: "scrollback.page", sessionId: ids.rich, maxBytes: 4096 }));
      const replay = (await attach(env, ids.rich!, PAGING)).find((f) => f.type === "scrollback.replay") as { messages: SessionMessage[] };
      let anchor = replay.messages[0]?.messageId;
      for (let i = 0; anchor && i < 50; i++) {
        const page = await call(env, { type: "scrollback.page", sessionId: ids.rich, beforeMessageId: anchor, maxBytes: 1500 });
        pages.push(page);
        const p = page as { messages: SessionMessage[]; hasMore: boolean };
        if (!p.hasMore || p.messages.length === 0) break;
        anchor = p.messages[0]!.messageId;
      }
      return pages;
    });
  });

  it("forking at a turn carries the same conversation, turns and scrollback", async () => {
    const pair = await both();
    const forkId = await same(pair, async (env) => {
      const turns = (await call(env, { type: "session.turns", sessionId: ids.rich })) as { turns: Array<{ turnId: string }> };
      const r = await call(env, { type: "session.fork", sessionId: ids.rich, name: "branch", afterTurnId: turns.turns[2]!.turnId, isolate: false });
      expect(r.type).toBe("response.ok");
      return r;
    });
    const id = (forkId as { data?: { id: string } }).data?.id ?? (forkId as { session?: { id: string } }).session?.id;
    expect(id).toBeString();
    await same(pair, async (env) => {
      const r = (await call(env, { type: "session.list" })) as { sessions: SessionInfo[] };
      const fork = r.sessions.find((s) => s.name === "branch")!;
      const p = env.made.at(-1)!;
      return {
        fork,
        replay: await attach(env, fork.id, PAGING),
        turns: await call(env, { type: "session.turns", sessionId: fork.id }),
        history: env.m._sessionForTest(fork.id)!.canonicalHistory.map((t: CanonicalTurn) => [t.role, t.content, t.turnId]),
        seeded: p.seededHistory?.map((t) => [t.role, t.content]),
      };
    });
    const fork = (await list(pair.lazy)).find((s) => s.name === "branch")!;
    expect(pair.lazy.m._sessionForTest(fork.id)!.canonicalHistory.length).toBe(6);
  });

  it("going back a turn removes the same, and the next prompt carries the same history", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const turns = (await call(env, { type: "session.turns", sessionId: ids.rich })) as { turns: Array<{ turnId: string }> };
      const r = await call(env, { type: "session.rewind", sessionId: ids.rich, turnId: turns.turns[4]!.turnId });
      expect(r.type).toBe("session.rewind.result");
      await settle(env, ids.rich!);
      const after = await attach(env, ids.rich!, PAGING);
      await sendAndSettle(env, ids.rich!, "instead");
      const opts = env.made.at(-1)!.capturedOpts.at(-1)!;
      return { r, after, history: opts.history.map((t) => [t.role, t.content]), user: opts.userMessage };
    });
  });

  it("a comparison runs from the same conversation and settles the same", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const r = (await call(env, {
        type: "session.compare",
        sessionId: ids.rich,
        prompt: "do it two ways",
        targets: [{ providerId: "claude" }, { providerId: "codex" }],
      })) as { type: string; compare?: { compareId: string } };
      expect([r.type, (r as { error?: string }).error]).toEqual(["compare.state", undefined]);
      if (r.type !== "compare.state") return r;
      for (let i = 0; i < 400; i++) {
        const g = (await call(env, { type: "compare.get", compareId: r.compare!.compareId })) as { compare: { targets: Array<{ done?: boolean }> } };
        if (g.compare.targets.every((t) => t.done)) {
          const seeded = env.made.slice(-2).map((p) => p.seededHistory?.map((t) => [t.role, t.content]));
          return { g, seeded };
        }
        await Bun.sleep(10);
      }
      throw new Error("comparison never settled");
    });
  });

  it("a backend switch hands the new backend the same history", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const r = await call(env, { type: "session.set_provider", sessionId: ids.rich, providerId: "codex" });
      expect(r.type).toBe("response.ok");
      const p = env.made.at(-1)!;
      expect(p.id).toBe("codex");
      return { r, id: p.id, seeded: p.seededHistory?.map((t) => [t.role, t.content, t.turnId]), replay: await attach(env, ids.rich!, PAGING) };
    });
  });

  it("export bundles the same", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const r = (await call(env, { type: "session.export", sessionId: ids.rich, includeMemory: false })) as unknown as Record<string, unknown>;
      expect(r.type).toBe("session.export.result");
      return r;
    });
  });

  it("a new prompt hands the backend the same history, and the transcript's seq continues past the log", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const before = seqsOnDisk(env, ids.rich!);
      const r = await sendAndSettle(env, ids.rich!, "next");
      await env.transcript.flush();
      const after = seqsOnDisk(env, ids.rich!);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(Math.min(...after.slice(before.length))).toBe(Math.max(...before) + 1);
      expect(new Set(after).size).toBe(after.length);
      const opts = env.made.at(-1)!.capturedOpts.at(-1)!;
      return { r, history: opts.history.map((t) => [t.role, t.content, t.turnId]), hasQueried: env.made.at(-1)!.hasQueried, info: sessionOf(env, "rich").toInfo() };
    });
  });

  it("a background task settling on a resumed session wakes it on the same history", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const s = sessionOf(env, "short");
      const p = env.made.find((x) => x.onSessionEvent && env.m._sessionForTest(ids.short!)?.providerId === x.id && s.toInfo().rotation?.claudeCodeSessionId === x.backingSessionId)!;
      p.onSessionEvent!({ type: "background_tasks", tasks: [{ id: "bg1", kind: "local_bash", description: "build", status: "running" }] } as SessionScopedEvent);
      p.onSessionEvent!({ type: "background_task_settled", taskId: "bg1", status: "completed", summary: "built" } as SessionScopedEvent);
      for (let i = 0; i < 200 && p.capturedOpts.length === 0; i++) await Bun.sleep(5);
      await settle(env, ids.short!);
      expect(p.capturedOpts.length).toBe(1);
      return { turns: p.capturedOpts.map((o) => ({ user: o.userMessage, history: o.history.map((t) => [t.role, t.content]) })), replay: await attach(env, ids.short!, PAGING) };
    });
  });

  it("a persistent routine's run on its resumed session ends the same", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const r = await call(env, { type: "routine.run", routine: "daily" });
      if (r.type !== "routine.run.result") throw new Error(JSON.stringify(r));
      const run = await runEnds(env, ids.routine!, r.run.id);
      expect(run.status).toBe("succeeded");
      expect(run.sessionId).toBe(ids.routineSession);
      const p = env.made.find((x) => x.capturedOpts.length > 0)!;
      expect(p.capturedOpts.at(-1)!.history.length).toBeGreaterThan(2);
      return { run, history: p.capturedOpts.at(-1)?.history.map((t) => [t.role, t.content]) };
    });
  });

  it("an idle release before first use re-seeds a backend that needs it once the history loads", async () => {
    const pair = await both();
    await same(pair, async (env) => {
      const s = sessionOf(env, "gemini");
      s.releaseIdleProvider({ idle: true });
      await Bun.sleep(50);
      const p = env.made.find((x) => x.id === "gemini-cli")!;
      // Before anything uses it: the lazy one owes the seed until it loads.
      if (env.label === "lazy") expect(s.hydrated).toBe(false);
      await sendAndSettle(env, ids.gemini!, "back again");
      expect(p.seededHistory?.length).toBe(2);
      return { seeded: p.seededHistory?.map((t) => [t.role, t.content]), teardowns: p.teardownCount, history: p.capturedOpts.at(-1)?.history.map((t) => [t.role, t.content]) };
    });
  });
});

describe("lazy session loading: restarts", () => {
  it("restarting twice, with notices and a turn in between, keeps everything the same", async () => {
    const pair = await both();
    const restart = async (env: Env): Promise<Env> => {
      await closeEnv(env);
      envs.splice(envs.indexOf(env), 1);
      const next = openEnv(env.label, env.root, env.label === "lazy");
      envs.push(next);
      await next.m.resumeSessions();
      return next;
    };
    let { eager, lazy } = pair;
    const step = async (env: Env) => {
      await call(env, { type: "session.set_mode", sessionId: ids.short, mode: "autonomous", maxTurns: 2 });
      await sendAndSettle(env, ids.rich!, "between restarts");
      return list(env);
    };
    await same({ eager, lazy }, step);
    eager = await restart(eager);
    lazy = await restart(lazy);
    await same({ eager, lazy }, list);
    await same({ eager, lazy }, step);
    eager = await restart(eager);
    lazy = await restart(lazy);
    await same({ eager, lazy }, list);
    await same({ eager, lazy }, async (env) => ({
      short: await attach(env, ids.short!),
      rich: await attach(env, ids.rich!, PAGING),
      turns: await call(env, { type: "session.turns", sessionId: ids.rich }),
    }));
    for (const env of [eager, lazy]) {
      const seqs = seqsOnDisk(env, ids.short!);
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });
});

describe("lazy session loading: a history past the resume budgets", () => {
  /**
   * A session from a long-lived daemon: a transcript past the 24 MiB the
   * scrollback is read from, and a canonical log past the 4 MiB the history
   * is, written into both copies.
   */
  function writeBig(root: string): string {
    const id = "0b16b16b-0000-4000-8000-00000000b16b";
    const dir = join(root, "transcripts");
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const lines: string[] = [];
    const canon: string[] = [];
    const index: string[] = [];
    let seq = 0;
    for (let t = 0; t < 1100; t++) {
      const turnId = `turn-${String(t).padStart(5, "0")}`;
      const prompt = `prompt ${t} ${"x".repeat(200)}`;
      const reply = `reply ${t} ${"y".repeat(24_000)}`;
      const user = { type: "session.message", sessionId: id, messageId: `u-${t}`, role: "user", content: prompt, identity: { sub: AUTH.sub, type: "human" }, timestamp: at(2 * t), turnId };
      const asst = { type: "session.message", sessionId: id, messageId: `a-${t}`, role: "assistant", content: reply, identity: { sub: `agent:${id}`, type: "agent", name: "big (Claude)" }, timestamp: at(2 * t + 1), turnId };
      lines.push(JSON.stringify({ seq: seq++, timestamp: user.timestamp, message: user }));
      lines.push(JSON.stringify({ seq: seq++, timestamp: asst.timestamp, message: asst }));
      canon.push(JSON.stringify({ op: "append", turn: { role: "user", content: prompt, turnId, prompt, at: user.timestamp } }));
      canon.push(JSON.stringify({ op: "append", turn: { role: "assistant", content: reply.slice(0, 4_000), turnId } }));
      index.push(JSON.stringify({ turnId, kind: "prompt", preview: `prompt ${t}`, startedAt: user.timestamp }));
    }
    writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
    writeFileSync(join(dir, `${id}.canonical.jsonl`), `${canon.join("\n")}\n`);
    writeFileSync(join(dir, `${id}.turns.jsonl`), `${index.join("\n")}\n`);
    writeFileSync(
      join(dir, `${id}.meta.json`),
      JSON.stringify({
        sessionId: id,
        sessionName: "big",
        workdir: join(root, "repo"),
        createdBy: AUTH.sub,
        createdAt: at(0),
        lastStatus: "idle",
        lastActivityAt: at(2200),
        accountId: AUTH.accountId,
        projectId: AUTH.projectId,
        providerId: "claude",
      }),
    );
    return id;
  }

  it("loads the same windows: a partial scrollback paged from disk, a partial history read whole on demand", async () => {
    const eager = openEnv("eager", cloneBase("eager"), false);
    const lazy = openEnv("lazy", cloneBase("lazy"), true);
    envs.push(eager, lazy);
    const id = writeBig(eager.root);
    writeBig(lazy.root);
    ids.big = id;
    try {
      await eager.m.resumeSessions();
      await lazy.m.resumeSessions();
      const pair = { eager, lazy };
      expect(lazy.m._sessionForTest(id)!.hydrated).toBe(false);
      // A notice while unloaded: the load's window still starts where a resume's did.
      await same(pair, async (env) => call(env, { type: "session.set_mode", sessionId: id, mode: "guarded" }));
      await same(pair, async (env) => {
        const replay = await attach(env, id, PAGING);
        const s = env.m._sessionForTest(id)!;
        const full = await s.fullCanonicalHistory();
        const pages: DaemonMessage[] = [];
        let anchor = (replay.find((f) => f.type === "scrollback.replay") as { messages: SessionMessage[] }).messages[0]?.messageId;
        // Back past the buffer's floor, into the transcript on disk.
        for (let i = 0; anchor && i < 400; i++) {
          const page = (await call(env, { type: "scrollback.page", sessionId: id, beforeMessageId: anchor, maxBytes: 2_000_000 })) as { messages: SessionMessage[]; hasMore: boolean; source?: string };
          pages.push({ ...page, messages: page.messages.map((m) => m.messageId) } as never);
          if (!page.hasMore || page.messages.length === 0) break;
          anchor = page.messages[0]!.messageId;
        }
        return {
          replay,
          partial: s.historyIsPartial,
          inMemory: s.historyLength,
          full: full.length,
          last: [s.lastTurnId, s.lastTurnRole, s.lastAssistantText?.slice(0, 20)],
          pages,
        };
      });
      expect(lazy.m._sessionForTest(id)!.historyIsPartial).toBe(true);
    } finally {
      delete ids.big;
    }
  });
});

describe("lazy session loading: the load itself", () => {
  it("concurrent first uses share one load", async () => {
    const lazy = openEnv("lazy", cloneBase("lazy"), true);
    envs.push(lazy);
    await lazy.m.resumeSessions();
    const reads: string[] = [];
    const load = lazy.transcript.loadTranscript.bind(lazy.transcript);
    lazy.transcript.loadTranscript = (sessionId, opts) => {
      reads.push(sessionId);
      return load(sessionId, opts);
    };
    const results = await Promise.all([
      attach(lazy, ids.rich!, PAGING),
      call(lazy, { type: "scrollback.page", sessionId: ids.rich, maxBytes: 4096 }),
      attach(lazy, ids.rich!),
      call(lazy, { type: "session.fork", sessionId: ids.rich, name: "f", isolate: false }),
    ]);
    expect(results[1]!.type).toBe("scrollback.page.result");
    expect(results[3]!.type).toBe("response.ok");
    // One load; the fork reads the parent's transcript itself, as it always has.
    expect(reads.filter((r) => r === ids.rich).length).toBe(2);
    expect(sessionOf(lazy, "rich").hydrated).toBe(true);
  });

  it("an unreadable transcript is an error for the request that needed it, and the next one loads it", async () => {
    const lazy = openEnv("lazy", cloneBase("lazy"), true);
    envs.push(lazy);
    await lazy.m.resumeSessions();
    const path = lazy.transcript.transcriptPath(ids.short!);
    const { chmodSync } = await import("node:fs");
    chmodSync(path, 0o000);
    try {
      const r = await call(lazy, { type: "session.attach", sessionId: ids.short });
      expect(r.type).toBe("response.error");
      expect(sessionOf(lazy, "short").hydrated).toBe(false);
      const send = await call(lazy, { type: "session.send", sessionId: ids.short, text: "hi" });
      expect(send.type).toBe("response.error");
    } finally {
      chmodSync(path, 0o600);
    }
    const ok = await attach(lazy, ids.short!, PAGING);
    expect(ok[0]!.type).toBe("response.ok");
    expect(sessionOf(lazy, "short").hydrated).toBe(true);
    expect((ok[1] as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
  });
});
