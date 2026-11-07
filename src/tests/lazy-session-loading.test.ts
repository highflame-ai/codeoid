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

import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
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

// Two daemons per test, each resuming and shutting down: slower than the default under a loaded suite.
setDefaultTimeout(60_000);

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
}, 60_000);

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

  it("notices while unloaded (model, effort) are in the scrollback and on disk in order, their seqs never reused", async () => {
    const pair = await both();
    const before = seqsOnDisk(pair.lazy, ids.short!).length;
    await same(pair, async (env) => {
      const results = [
        await call(env, { type: "session.set_mode", sessionId: ids.short, mode: "guarded" }),
        await call(env, { type: "session.rename", sessionId: ids.short, name: "short-again" }),
        await call(env, { type: "session.set_model", sessionId: ids.short, model: "sonnet" }),
        await call(env, { type: "session.set_effort", sessionId: ids.short, effort: "high" }),
      ];
      expect(results.map((r) => r.type)).toEqual(["response.ok", "response.ok", "response.ok", "response.ok"]);
      await env.transcript.flush();
      return { results, info: sessionOf(env, "short").toInfo() };
    });
    // Appended while the history stayed on disk.
    expect(loaded(pair.lazy, "short")).toBe(false);
    expect(seqsOnDisk(pair.lazy, ids.short!).length).toBeGreaterThan(before);
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
  it("restarting twice, with notices (some while unloaded) and a turn in between, keeps everything the same", async () => {
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
    const models: Record<string, number> = {};
    const step = async (env: Env) => {
      await call(env, { type: "session.set_mode", sessionId: ids.short, mode: "autonomous", maxTurns: 2 });
      // A notice appended while "short" is unloaded (lazy), persisted across the restarts.
      const n = (models[env.label] ?? 0) + 1;
      models[env.label] = n;
      const r = await call(env, { type: "session.set_model", sessionId: ids.short, model: n === 1 ? "sonnet" : "haiku" });
      expect([r.type, (r as { error?: string }).error]).toEqual(["response.ok", undefined]);
      if (env.label === "lazy") expect(sessionOf(env, "short").hydrated).toBe(false);
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
      const replay = (await attach(env, ids.short!)).find((f) => f.type === "scrollback.replay") as { messages: SessionMessage[] };
      expect(replay.messages.filter((m) => m.metadata?.event === "session.model_changed").length).toBe(2);
    }
  });
});

/**
 * A session from a long-lived daemon: a transcript past the 24 MiB the
 * scrollback is read from, and a canonical log past the 4 MiB the history
 * is, written into both copies. `seqOf` gives line i of n its seq (none: undefined).
 */
function writeBig(root: string, seqOf: (i: number, n: number) => number | undefined = (i) => i): string {
  const id = "0b16b16b-0000-4000-8000-00000000b16b";
  const dir = join(root, "transcripts");
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const lines: string[] = [];
  const canon: string[] = [];
  const index: string[] = [];
  const entries: Array<{ timestamp: string; message: object }> = [];
  for (let t = 0; t < 1100; t++) {
    const turnId = `turn-${String(t).padStart(5, "0")}`;
    const prompt = `prompt ${t} ${"x".repeat(200)}`;
    const reply = `reply ${t} ${"y".repeat(24_000)}`;
    const user = { type: "session.message", sessionId: id, messageId: `u-${t}`, role: "user", content: prompt, identity: { sub: AUTH.sub, type: "human" }, timestamp: at(2 * t), turnId };
    const asst = { type: "session.message", sessionId: id, messageId: `a-${t}`, role: "assistant", content: reply, identity: { sub: `agent:${id}`, type: "agent", name: "big (Claude)" }, timestamp: at(2 * t + 1), turnId };
    entries.push({ timestamp: user.timestamp, message: user }, { timestamp: asst.timestamp, message: asst });
    canon.push(JSON.stringify({ op: "append", turn: { role: "user", content: prompt, turnId, prompt, at: user.timestamp } }));
    canon.push(JSON.stringify({ op: "append", turn: { role: "assistant", content: reply.slice(0, 4_000), turnId } }));
    index.push(JSON.stringify({ turnId, kind: "prompt", preview: `prompt ${t}`, startedAt: user.timestamp }));
  }
  for (let i = 0; i < entries.length; i++) lines.push(JSON.stringify({ seq: seqOf(i, entries.length), ...entries[i]! }));
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

describe("lazy session loading: a history past the resume budgets", () => {
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

describe("lazy session loading: a log that can't be read at start", () => {
  it("a transcript that can't be read fails the session's resume, as an eager resume did, and leaves it as it was for the next start", async () => {
    const { chmodSync } = await import("node:fs");
    const roots = { eager: cloneBase("eager"), lazy: cloneBase("lazy") };
    const paths = Object.values(roots).map((r) => join(r, "transcripts", `${ids.short}.jsonl`));
    const before = readFileSync(paths[0]!, "utf8");
    for (const p of paths) chmodSync(p, 0o000);
    try {
      const pair = { eager: openEnv("eager", roots.eager, false), lazy: openEnv("lazy", roots.lazy, true) };
      envs.push(pair.eager, pair.lazy);
      await pair.eager.m.resumeSessions();
      await pair.lazy.m.resumeSessions();
      // Not listed as a session with no history (its seq at 0, its backend starting over): not listed.
      await same(pair, async (env) => (await list(env)).map((i) => i.name));
      expect(pair.lazy.m._sessionForTest(ids.short!)).toBeUndefined();
      await same(pair, (env) => call(env, { type: "session.set_model", sessionId: ids.short, model: "sonnet" }));
      for (const env of [pair.eager, pair.lazy]) await closeEnv(env);
      envs.splice(0);
    } finally {
      for (const p of paths) chmodSync(p, 0o600);
    }
    for (const p of paths) expect(readFileSync(p, "utf8")).toBe(before);
    // Readable again: the next start resumes it whole.
    const pair = { eager: openEnv("eager", roots.eager, false), lazy: openEnv("lazy", roots.lazy, true) };
    envs.push(pair.eager, pair.lazy);
    await pair.eager.m.resumeSessions();
    await pair.lazy.m.resumeSessions();
    const queried = await same(pair, async (env) => env.made.map((p) => p.hasQueried));
    expect(queried.filter((q) => !q).length).toBe(1); // the empty session's
    await same(pair, async (env) => attach(env, ids.short!, PAGING));
    await same(pair, async (env) => {
      await sendAndSettle(env, ids.short!, "again");
      return attach(env, ids.short!, PAGING);
    });
  });

  it("a canonical log or turn index that can't be read: the session resumes without its history, as an eager resume did, and reads it on its next use once it can", async () => {
    const { chmodSync } = await import("node:fs");
    const roots = { eager: cloneBase("eager"), lazy: cloneBase("lazy") };
    const paths = Object.values(roots).map((r) => join(r, "transcripts", `${ids.short}.canonical.jsonl`));
    for (const p of paths) chmodSync(p, 0o000);
    const pair = { eager: openEnv("eager", roots.eager, false), lazy: openEnv("lazy", roots.lazy, true) };
    envs.push(pair.eager, pair.lazy);
    try {
      await pair.eager.m.resumeSessions();
      await pair.lazy.m.resumeSessions();
      await same(pair, async (env) => {
        const s = sessionOf(env, "short");
        return { names: (await list(env)).map((i) => i.name), history: s.historyLength, last: s.lastTurnId, replay: await attach(env, ids.short!, PAGING) };
      });
    } finally {
      for (const p of paths) chmodSync(p, 0o600);
    }
    // Readable again: the next use reads it.
    await same(pair, async (env) => {
      await attach(env, ids.short!, PAGING);
      const s = sessionOf(env, "short");
      return { history: s.historyLength, last: s.lastTurnId };
    });
    expect(sessionOf(pair.lazy, "short").historyLength).toBe(2);
  });
});

describe("lazy session loading: logs whose seqs don't grow along the file", () => {
  /** Line i of n's seq in each shape the audits found on disk (undefined: the line has none). */
  const SHAPES: Record<string, (i: number, n: number) => number | undefined> = {
    // A daemon from before 2026-07-03 started every run's seqs at 0.
    "seqs restarted at 0 by an older daemon": (i, n) => (i < n - 2 ? i : i - (n - 2)),
    "the newest lines' seqs back down": (i, n) => (i < n - 4 ? i : i - (n - 4)),
    // An import writes 1..N; the imported session's own prompt then started at 0.
    "an import, then a prompt": (i, n) => (i < n - 2 ? i + 1 : i - (n - 2)),
    "no seqs at all": () => undefined,
    "the newest lines without a seq": (i, n) => (i < n - 2 ? i : undefined),
  };

  /** Rewrite a session's transcript with `shape`'s seqs, its lines unchanged otherwise. */
  function reshape(root: string, sessionId: string, shape: (i: number, n: number) => number | undefined): void {
    const path = join(root, "transcripts", `${sessionId}.jsonl`);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    const out = lines.map((l, i) => {
      const { seq: _seq, ...rest } = JSON.parse(l) as { seq?: number };
      const seq = shape(i, lines.length);
      return JSON.stringify(seq === undefined ? rest : { seq, ...rest });
    });
    writeFileSync(path, `${out.join("\n")}\n`);
  }

  /** What a resume read before lazy loading (origin/main's loader): the log's newest 24 MiB, merged, as it is now. */
  async function eagerRead(root: string, sessionId: string): Promise<{ messages: unknown[]; truncated: boolean }> {
    const stats: { truncated?: boolean } = {};
    const entries = await new TranscriptStore(join(root, "transcripts")).loadTranscript(sessionId, { maxBytes: 24 * 1024 * 1024, stats });
    return { messages: entries.map((e) => e.message), truncated: stats.truncated === true };
  }

  /** A replayed message as the log holds it (the buffer stamps its own seq; a resumed tool call is reconciled). */
  const shown = (m: unknown) => {
    const { seq: _seq, ...rest } = m as SessionMessage;
    return { messageId: rest.messageId, role: rest.role, content: rest.content };
  };

  for (const [label, shape] of Object.entries(SHAPES)) {
    it(`${label}: every line loads, as an eager resume read it, with and without lazy loading`, async () => {
      const roots = { eager: cloneBase("eager"), lazy: cloneBase("lazy") };
      for (const root of Object.values(roots)) {
        reshape(root, ids.rich!, shape);
        reshape(root, ids.legacy!, shape);
      }
      const want = await eagerRead(roots.eager, ids.rich!);
      const wantLegacy = await eagerRead(roots.eager, ids.legacy!);
      expect(want.messages.length).toBeGreaterThan(10);
      const pair = { eager: openEnv("eager", roots.eager, false), lazy: openEnv("lazy", roots.lazy, true) };
      envs.push(pair.eager, pair.lazy);
      await pair.eager.m.resumeSessions();
      await pair.lazy.m.resumeSessions();
      expect(loaded(pair.lazy, "rich")).toBe(false);
      // Every backend with a conversation on disk is told to resume it, seqs or none.
      expect(pair.eager.made.length).toBeGreaterThan(0);
      const queried = await same(pair, async (env) => env.made.map((p) => p.hasQueried));
      // All but the empty session's.
      expect(queried.filter((q) => !q).length).toBe(1);
      // A notice while unloaded is appended past the log, whatever its seqs.
      await same(pair, (env) => call(env, { type: "session.set_model", sessionId: ids.rich, model: "sonnet" }));
      const replays = await same(pair, async (env) => {
        const replay = (await attach(env, ids.rich!))[1] as { messages: SessionMessage[] };
        const s = sessionOf(env, "rich");
        return { messages: replay.messages, partial: s.historyIsPartial };
      });
      // What the log held, in its order, then the notice.
      expect(replays.messages.slice(0, -1).map(shown)).toEqual(want.messages.map(shown));
      expect(replays.messages.at(-1)!.content).toContain("Model switched");
      expect(replays.partial).toBe(want.truncated);
      // A session from before the canonical log rebuilds its history from every line, and persists it.
      await same(pair, async (env) => {
        const s = sessionOf(env, "legacy");
        const replay = (await attach(env, ids.legacy!))[1] as { messages: SessionMessage[] };
        expect(replay.messages.map(shown)).toEqual(wantLegacy.messages.map(shown));
        return { history: s.historyLength, turns: (await call(env, { type: "session.turns", sessionId: ids.legacy })) };
      });
      // A new prompt's lines continue past every seq the log holds.
      await same(pair, (env) => sendAndSettle(env, ids.rich!, "after the restart"));
      for (const env of [pair.eager, pair.lazy]) {
        const seqs = seqsOnDisk(env, ids.rich!);
        const before = seqs.slice(0, want.messages.length).filter((q) => q !== undefined);
        const newest = seqs.slice(-2);
        if (before.length > 0) for (const q of newest) expect(q).toBeGreaterThan(Math.max(...before));
      }
      // And the next restart reads the same log from both.
      const after = await Promise.all([eagerRead(roots.eager, ids.rich!), eagerRead(roots.lazy, ids.rich!)]);
      expect(norm(pair.lazy, after[1].messages.map(shown))).toEqual(norm(pair.eager, after[0].messages.map(shown)));
    });
  }

  it("a log past the read budget whose seqs restarted: the same window, the same partial flag", async () => {
    const pair = { eager: openEnv("eager", cloneBase("eager"), false), lazy: openEnv("lazy", cloneBase("lazy"), true) };
    envs.push(pair.eager, pair.lazy);
    // Seqs restarted at 0 for the newest 20 turns.
    const restart = (i: number, n: number) => (i < n - 40 ? i : i - (n - 40));
    const id = writeBig(pair.eager.root, restart);
    writeBig(pair.lazy.root, restart);
    const want = await eagerRead(pair.eager.root, id);
    expect(want.truncated).toBe(true);
    ids.big = id;
    try {
      await pair.eager.m.resumeSessions();
      await pair.lazy.m.resumeSessions();
      await same(pair, (env) => call(env, { type: "session.set_model", sessionId: id, model: "sonnet" }));
      const got = await same(pair, async (env) => {
        const s = env.m._sessionForTest(id)!;
        const page = (await call(env, { type: "scrollback.page", sessionId: id, maxBytes: 2_000_000 })) as { messages: SessionMessage[] };
        return { ids: page.messages.map((m) => m.messageId), partial: s.historyIsPartial };
      });
      // The newest page is what was read, in its order, up to its newest line, then the notice.
      const read = want.messages.map((m) => (m as SessionMessage).messageId);
      const kept = got.ids.slice(0, -1);
      expect(kept.length).toBeGreaterThan(50);
      const at = kept.map((k) => read.indexOf(k!));
      expect(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!))).toBe(true);
      expect(kept.at(-1)).toBe(read.at(-1));
      // It reaches back past where the seqs restarted (turn 1080).
      expect(kept).toContain("a-1070");
      expect(got.partial).toBe(true);
    } finally {
      delete ids.big;
    }
  });
});

describe("lazy session loading: messages while a load is in flight", () => {
  /** The fixture resumed eagerly and lazily, every transcript read held `ms` (a large log). */
  async function slowPair(ms: number): Promise<{ eager: Env; lazy: Env }> {
    const pair = await both();
    for (const env of [pair.eager, pair.lazy]) {
      const load = env.transcript.loadTranscript.bind(env.transcript);
      env.transcript.loadTranscript = async (sessionId, opts) => {
        await Bun.sleep(ms);
        return load(sessionId, opts);
      };
    }
    return pair;
  }

  /** A turn's worth of provider sends the session's backends were handed. */
  const prompts = (env: Env) => env.made.reduce((n, p) => n + p.capturedOpts.length, 0);

  it("are handled in the order they came: an interrupt stops the prompt sent before it, a detach follows its attach", async () => {
    const pair = await slowPair(50);
    await same(pair, async (env) => {
      const sent = env.m.handle({ type: "session.send", id: "s", sessionId: ids.rich, text: "go" } as never, AUTH, client("c", []));
      const stop = env.m.handle({ type: "session.interrupt", id: "i", sessionId: ids.rich } as never, AUTH, client("c", []));
      const responses = await Promise.all([sent, stop]);
      await settle(env, ids.rich!);
      return { responses, prompts: prompts(env), turns: sessionOf(env, "rich").toInfo().usage?.numTurns };
    });
    expect(prompts(pair.lazy)).toBe(0);
    await same(pair, async (env) => {
      const frames: DaemonMessage[] = [];
      const c = client("ws", frames);
      const attached = env.m.handle({ type: "session.attach", id: "a", sessionId: ids.short } as never, AUTH, c);
      const detached = env.m.handle({ type: "session.detach", id: "d", sessionId: ids.short } as never, AUTH, c);
      const responses = await Promise.all([attached, detached]);
      return { responses: responses.map((r) => r.type), clients: sessionOf(env, "short").attachedClientCount };
    });
    expect(sessionOf(pair.lazy, "short").attachedClientCount).toBe(0);
  });

  it("an attach whose socket closed while it waited leaves no client attached", async () => {
    const pair = await slowPair(50);
    await same(pair, async (env) => {
      const attached = env.m.handle({ type: "session.attach", id: "a", sessionId: ids.rich } as never, AUTH, client("ws1", []));
      env.m.disconnectClient("ws1"); // the socket's close handler
      await attached;
      return sessionOf(env, "rich").attachedClientCount;
    });
    expect(sessionOf(pair.lazy, "rich").attachedClientCount).toBe(0);
    // Another client of the same session is unaffected.
    const frames: DaemonMessage[] = [];
    await pair.lazy.m.handle({ type: "session.attach", id: "b", sessionId: ids.rich } as never, AUTH, client("ws2", frames));
    expect(sessionOf(pair.lazy, "rich").attachedClientCount).toBe(1);
  });

  it("a prompt waiting on the load is work the shutdown drain sees: no turn starts after it", async () => {
    const pair = await slowPair(300);
    for (const env of [pair.eager, pair.lazy]) {
      const sent = env.m.handle({ type: "session.send", id: "s", sessionId: ids.rich, text: "go" } as never, AUTH, client("c", []));
      expect(sessionOf(env, "rich").preparingTurn).toBe(true);
      await env.m.drain(5_000);
      const drained = prompts(env);
      expect((await sent).type).toBe("response.ok");
      await Bun.sleep(100);
      expect(prompts(env)).toBe(drained);
      expect(sessionOf(env, "rich").preparingTurn).toBe(false);
      expect(sessionOf(env, "rich").status).toBe("idle");
    }
    expect(prompts(pair.lazy)).toBe(0);
  });

  it("the drain waits for a message waiting on a load", async () => {
    const lazy = openEnv("lazy", cloneBase("lazy"), true);
    envs.push(lazy);
    await lazy.m.resumeSessions();
    const load = lazy.transcript.loadTranscript.bind(lazy.transcript);
    lazy.transcript.loadTranscript = async (sessionId, opts) => {
      await Bun.sleep(300);
      return load(sessionId, opts);
    };
    let answered = false;
    const attached = lazy.m.handle({ type: "session.attach", id: "a", sessionId: ids.rich } as never, AUTH, client("c", [])).then((r) => {
      answered = true;
      return r;
    });
    await lazy.m.drain(5_000);
    expect(answered).toBe(true);
    expect((await attached).type).toBe("response.ok");
  });

  it("a request its handler refuses on scope loads nothing", async () => {
    const lazy = openEnv("lazy", cloneBase("lazy"), true);
    envs.push(lazy);
    await lazy.m.resumeSessions();
    const asked: Array<[string, Record<string, unknown>]> = [
      ["session.attach", {}],
      ["scrollback.page", { maxBytes: 4096 }],
      ["session.send", { text: "hi" }],
      ["session.part_action", { messageId: "m", action: "a" }],
      ["session.rotate", {}],
      ["session.rewind", { turnId: "t" }],
      ["session.approve", { approvalId: "x", decision: "allow" }],
      ["session.fork", { name: "f" }],
      ["session.set_provider", { providerId: "codex" }],
    ];
    for (const scopes of [[], ["session:watch"]] as const) {
      const auth: AuthContext = { ...AUTH, scopes: [...scopes] as AuthContext["scopes"] };
      for (const [type, rest] of asked) {
        if (type === "session.attach" || type === "scrollback.page") {
          if (scopes.length > 0) continue; // a watcher may read the history
        }
        const r = await lazy.m.handle({ type, id: "r", sessionId: ids.rich, ...rest } as never, auth, client("c", []));
        expect([type, r.type, (r as { error?: string }).error?.startsWith("Missing scope")]).toEqual([type, "response.error", true]);
        expect(sessionOf(lazy, "rich").hydrated).toBe(false);
      }
    }
    // A watcher's attach does load it.
    const watcher: AuthContext = { ...AUTH, scopes: ["session:watch"] as AuthContext["scopes"] };
    const r = await lazy.m.handle({ type: "session.attach", id: "w", sessionId: ids.rich } as never, watcher, client("w", []));
    expect(r.type).toBe("response.ok");
    expect(sessionOf(lazy, "rich").hydrated).toBe(true);
  });
});

describe("lazy session loading: a canonical log that can't be read", () => {
  /** The canonical log's lines on disk. */
  const canonicalLines = (env: Env, sessionId: string) =>
    readFileSync(env.transcript.canonicalPath(sessionId), "utf8").split("\n").filter((l) => l.trim()).length;
  const newestTurn = async (env: Env, sessionId: string) =>
    ((await call(env, { type: "session.turns", sessionId })) as { turns: Array<{ turnId: string }> }).turns.at(-1)!.turnId;

  it("at the first use: that request fails, nothing is lost, and the next use loads the whole conversation", async () => {
    const pair = await both();
    const { chmodSync } = await import("node:fs");
    const path = pair.lazy.transcript.canonicalPath(ids.rich!);
    chmodSync(path, 0o000);
    try {
      const r = await call(pair.lazy, { type: "session.attach", sessionId: ids.rich });
      expect(r.type).toBe("response.error");
      expect(sessionOf(pair.lazy, "rich").hydrated).toBe(false);
      const send = await call(pair.lazy, { type: "session.send", sessionId: ids.rich, text: "hi" });
      expect(send.type).toBe("response.error");
    } finally {
      chmodSync(path, 0o600);
    }
    expect(pair.lazy.made.reduce((n, p) => n + p.capturedOpts.length, 0)).toBe(0);
    await same(pair, async (env) => {
      const replay = await attach(env, ids.rich!, PAGING);
      const s = sessionOf(env, "rich");
      return { replay, history: s.historyLength, last: s.lastTurnId, text: s.lastAssistantText };
    });
    expect(sessionOf(pair.lazy, "rich").historyLength).toBe(12);
    // Going back the newest turn keeps the rest on disk.
    await same(pair, async (env) => {
      const r = await call(env, { type: "session.rewind", sessionId: ids.rich, turnId: await newestTurn(env, ids.rich!) });
      expect(r.type).toBe("session.rewind.result");
      await settle(env, ids.rich!);
      return canonicalLines(env, ids.rich!);
    });
    expect(canonicalLines(pair.lazy, ids.rich!)).toBe(10);
  });

  it("a synchronous load that can't read it throws, and leaves the session unloaded for the next use", async () => {
    const lazy = openEnv("lazy", cloneBase("lazy"), true);
    envs.push(lazy);
    await lazy.m.resumeSessions();
    const { chmodSync } = await import("node:fs");
    const path = lazy.transcript.canonicalPath(ids.rich!);
    const s = sessionOf(lazy, "rich");
    chmodSync(path, 0o000);
    try {
      expect(() => s.canonicalHistory).toThrow();
      expect(s.hydrated).toBe(false);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(s.canonicalHistory.length).toBe(12);
    expect(s.hydrated).toBe(true);
  });

  it("at resume: the session runs without it, as before, never writes over it, and reads it again on its next use", async () => {
    const pair = { eager: openEnv("eager", cloneBase("eager"), false), lazy: openEnv("lazy", cloneBase("lazy"), true) };
    envs.push(pair.eager, pair.lazy);
    let failing = true;
    for (const env of [pair.eager, pair.lazy]) {
      const load = env.transcript.loadCanonical.bind(env.transcript);
      env.transcript.loadCanonical = (sessionId, opts) => {
        if (failing && sessionId === ids.rich) return Promise.reject(new Error("EIO: i/o error, read"));
        return load(sessionId, opts);
      };
    }
    await pair.eager.m.resumeSessions();
    await pair.lazy.m.resumeSessions();
    const env = pair.eager;
    expect(sessionOf(env, "rich").historyLength).toBe(0);
    const turnId = await newestTurn(env, ids.rich!);
    // Going back or forking would rewrite the log from what's in memory: refused, the log untouched.
    const rewind = await call(env, { type: "session.rewind", sessionId: ids.rich, turnId });
    expect([rewind.type, (rewind as { error?: string }).error]).toEqual(["response.error", expect.stringContaining("couldn't be read")]);
    const preview = await call(env, { type: "session.rewind", sessionId: ids.rich, turnId, dryRun: true });
    expect(preview.type).toBe("response.error");
    for (const fork of [{}, { afterTurnId: turnId }]) {
      const r = await call(env, { type: "session.fork", sessionId: ids.rich, name: "f", isolate: false, ...fork });
      expect([r.type, (r as { error?: string }).error]).toEqual(["response.error", expect.stringContaining("couldn't be read")]);
    }
    expect(canonicalLines(env, ids.rich!)).toBe(12);
    // A turn still runs, and is appended to the log.
    expect((await sendAndSettle(env, ids.rich!, "more")).type).toBe("response.ok");
    expect(canonicalLines(env, ids.rich!)).toBe(14);
    expect(sessionOf(env, "rich").historyLength).toBe(2);
    // Readable again: the next use reads it, the turn since included.
    failing = false;
    await attach(env, ids.rich!, PAGING);
    expect(sessionOf(env, "rich").historyLength).toBe(14);
    const r = await call(env, { type: "session.rewind", sessionId: ids.rich, turnId: await newestTurn(env, ids.rich!) });
    expect(r.type).toBe("session.rewind.result");
    await settle(env, ids.rich!);
    expect(canonicalLines(env, ids.rich!)).toBe(12);
    // The lazy daemon read it at the first use, failing or not.
    expect(sessionOf(pair.lazy, "rich").hydrated).toBe(false);
    await attach(pair.lazy, ids.rich!, PAGING);
    expect(sessionOf(pair.lazy, "rich").historyLength).toBe(12);
  });

  it("at resume: a rotation empties it, as it always does, and nothing is read back after it", async () => {
    const env = openEnv("eager", cloneBase("eager"), false);
    envs.push(env);
    let failing = true;
    const load = env.transcript.loadCanonical.bind(env.transcript);
    env.transcript.loadCanonical = (sessionId, opts) =>
      failing && sessionId === ids.rich ? Promise.reject(new Error("EIO: i/o error, read")) : load(sessionId, opts);
    await env.m.resumeSessions();
    // Past the turns a rotation needs, each appended to the log.
    for (const text of ["one", "two", "three"]) await sendAndSettle(env, ids.rich!, text);
    await env.transcript.flush();
    expect(canonicalLines(env, ids.rich!)).toBe(18);
    expect((await call(env, { type: "session.rotate", sessionId: ids.rich })).type).toBe("response.ok");
    await settle(env, ids.rich!);
    expect(sessionOf(env, "rich").toInfo().rotation?.count).toBe(1);
    await env.transcript.flush();
    expect(canonicalLines(env, ids.rich!)).toBe(0);
    failing = false;
    await attach(env, ids.rich!, PAGING);
    expect(sessionOf(env, "rich").historyLength).toBe(0);
    expect((await sendAndSettle(env, ids.rich!, "after")).type).toBe("response.ok");
    expect(sessionOf(env, "rich").historyLength).toBe(2);
    expect(canonicalLines(env, ids.rich!)).toBe(2);
  });
});
