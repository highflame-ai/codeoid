/**
 * Turn identity, workspace checkpoints and restart-proof canonical history
 * (#354), through the real Session / SessionManager with a mock backend.
 *
 * Everything here is backend-agnostic by design: turn ids, the turn list and
 * the snapshots come from codeoid's own records, never from a backend's
 * native session — so the mock is a faithful stand-in for every provider.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { AsyncQueue } from "../daemon/async-queue.js";
import { canonicalFromTranscript } from "../daemon/canonical-restore.js";
import { HookBus } from "../daemon/hooks/bus.js";
import { listCheckpoints, shadowRepoPath } from "../daemon/checkpoints.js";
import { DaemonStoppingError, SendStoppedError } from "../daemon/session.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import type { SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { SessionManager, TURN_END_SETTLE_MS } from "../daemon/session-manager.js";
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

  it("drain() returns as soon as the work it stopped has settled, not after a fixed half second", async () => {
    const m = newManager();
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const sending = s.send("go", AUTH).catch((e) => e);
    // When the work itself has settled: the stopped send, then the writes it made.
    const settled = sending.then(() => transcript.flush()).then(() => performance.now());
    await m.drain(2_000);
    const returned = performance.now();
    // drain used to wait 500 ms before looking again, however soon the stop
    // settled; it looks again within 50 ms now. Measured from the work's own
    // end, so a slow stop under load doesn't count against it.
    expect(returned - (await settled)).toBeLessThan(300);
    expect(await sending).toBeInstanceOf(SendStoppedError);
  });
});

/**
 * A backend whose interrupt is acknowledged at once while the turn's result
 * follows `late` ms after it, as real ones do: Claude's result after the
 * interrupt receipt, Codex's turn/completed after turn/interrupt, opencode's
 * feed or read-back after its interrupt call.
 */
class LateResultProvider extends MockSessionProvider {
  /** `clean`: the stopped turn's result is no error (the session ends idle, where a wake is delivered). */
  constructor(
    private readonly late: number,
    private readonly clean = false,
  ) {
    super("claude");
  }

  override runTurn(opts: TurnOpts): TurnRun {
    this.capturedOpts.push(opts);
    const queue = new AsyncQueue<ProviderEvent>();
    void Promise.resolve().then(() => queue.push({ type: "text_delta", content: "working on it" } as ProviderEvent));
    let interrupted = false;
    return {
      events: queue,
      interrupt: async () => {
        if (interrupted) return;
        interrupted = true;
        setTimeout(() => {
          try {
            queue.push({ type: "text_done", content: "working on it, cut short" } as ProviderEvent);
            queue.push({
              type: "turn_done",
              result: {
                providerId: "mock",
                model: "mock",
                inputTokens: 1000,
                outputTokens: 200,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                totalCostUsd: 0.42,
                costSource: "backend",
                durationMs: 1,
                ...(this.clean ? {} : { isError: true, errorMessage: "interrupted" }),
              },
            } as ProviderEvent);
          } catch {
            // closed
          }
          queue.close();
        }, this.late);
      },
      endTurn: () => queue.close(),
    };
  }
}

describe("drain() at shutdown", () => {
  for (const late of [0, 20, 100, 300, 600]) {
    it(`records an interrupted turn whose result comes ${late} ms after the interrupt, before it returns`, async () => {
      const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
        config: mkConfig(tmp),
        _testProviderFactory: () => new LateResultProvider(late),
      });
      const id = await create(m);
      const s = m._sessionForTest(id)!;
      const sending = s.send("go", AUTH).catch((e) => e);
      for (let i = 0; i < 200 && s.status !== "thinking"; i++) await Bun.sleep(5);
      expect(s.status).toBe("thinking");

      const errors: string[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      };
      try {
        const started = performance.now();
        await m.drain(10_000);
        const took = performance.now() - started;
        // What is on disk now is what the daemon leaves: the store closes next, then the process exits.
        const persisted = store.getSession(id)?.status;
        store.close();
        const canonical = readFileSync(transcript.canonicalPath(id), "utf8");
        const lines = readFileSync(join(tmp, "transcripts", `${id}.jsonl`), "utf8");
        const usage = s.toInfo().usage!;

        expect(s.turnInFlight).toBe(false);
        expect(canonical.split("\n").filter((l) => l.includes('"assistant"'))).toHaveLength(1);
        expect(lines).toContain("working on it, cut short");
        expect(usage.numTurns).toBe(1);
        expect(usage.totalCostUsd).toBeCloseTo(0.42);
        expect(persisted).toBe(s.status);
        // As soon as the turn has ended, not after a fixed wait.
        expect(took).toBeLessThan(late + 400);

        await Bun.sleep(50);
        expect(errors.filter((e) => /closed database|persist failed/i.test(e))).toEqual([]);
      } finally {
        console.error = consoleError;
      }
      await sending;
    });
  }

  /** A manager on `provider`, its session mid-turn. */
  async function midTurn(provider: () => MockSessionProvider): Promise<{ m: SessionManager; id: string; sending: Promise<unknown> }> {
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(tmp),
      _testProviderFactory: () => {
        const p = provider();
        providers.push(p);
        return p;
      },
    });
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const sending = s.send("go", AUTH).catch((e) => e);
    for (let i = 0; i < 200 && s.status !== "thinking"; i++) await Bun.sleep(5);
    expect(s.status).toBe("thinking");
    return { m, id, sending };
  }

  /** Errors logged while `fn` runs, and a moment after (a write that lands once the store closed). */
  async function errorsDuring(fn: () => Promise<void>): Promise<string[]> {
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      await fn();
      await Bun.sleep(50);
    } finally {
      console.error = consoleError;
    }
    return errors;
  }

  it("waits for a turn stopped just before shutdown began, whose end is still on its way", async () => {
    const { m, id, sending } = await midTurn(() => new LateResultProvider(300));
    const s = m._sessionForTest(id)!;
    // The owner's Stop: acknowledged at once, so the session reads idle, its result 300 ms away.
    await s.interrupt(AUTH);
    expect(s.status).toBe("idle");
    expect(s.turnInFlight).toBe(true);

    const errors = await errorsDuring(async () => {
      const started = performance.now();
      await m.drain(10_000);
      const took = performance.now() - started;
      store.close();
      const canonical = readFileSync(transcript.canonicalPath(id), "utf8");
      expect(s.turnInFlight).toBe(false);
      expect(canonical.split("\n").filter((l) => l.includes('"assistant"'))).toHaveLength(1);
      expect(s.toInfo().usage!.totalCostUsd).toBeCloseTo(0.42);
      expect(took).toBeGreaterThanOrEqual(250);
      expect(took).toBeLessThan(300 + 1_000);
    });
    expect(errors.filter((e) => /closed database|persist failed/i.test(e))).toEqual([]);
    await sending;
  });

  it("interrupts a turn the backend starts on its own after drain's interrupt, and waits for it", async () => {
    // The interrupted turn ends 50 ms after the interrupt; as the session lets
    // go of it, the backend starts one of its own (the Claude CLI answering a
    // background agent that settled).
    class SelfStarting extends LateResultProvider {
      own = 0;
      override runTurn(opts: TurnOpts): TurnRun {
        const run = super.runTurn(opts);
        return {
          ...run,
          endTurn: () => {
            run.endTurn?.();
            if (this.own++ > 0) return;
            queueMicrotask(() => this.startOwnTurn([{ type: "text_delta", content: "carrying on" } as ProviderEvent]));
          },
        };
      }
    }
    const { m, id, sending } = await midTurn(() => new SelfStarting(50));
    const s = m._sessionForTest(id)!;
    const provider = providers.at(-1) as SelfStarting;
    await m.drain(10_000);
    expect(provider.own).toBe(1);
    // Stopped as it started, and its end recorded before drain returned.
    expect(provider.ownTurnInterrupts).toBe(1);
    expect(s.status).toBe("idle");
    expect(s.turnInFlight).toBe(false);
    await sending;
  });

  it("starts no background wake once drain has begun", async () => {
    // Background work settles as the interrupted turn ends: the session would wake itself.
    class SettlesOnStop extends LateResultProvider {
      override runTurn(opts: TurnOpts): TurnRun {
        const run = super.runTurn(opts);
        return {
          ...run,
          interrupt: async () => {
            this.onSessionEvent?.({ type: "background_task_settled", taskId: "task-1", status: "completed", summary: "done" } as never);
            await run.interrupt();
          },
        };
      }
    }
    const { m, id, sending } = await midTurn(() => new SettlesOnStop(20, true));
    const s = m._sessionForTest(id)!;
    await m.drain(10_000);
    await Bun.sleep(100);
    // Only the prompted turn ever reached the backend.
    expect(providers.at(-1)!.capturedOpts).toHaveLength(1);
    expect(s.status).toBe("idle");
    expect(s.preparingTurn).toBe(false);
    expect(s.turnInFlight).toBe(false);
    await sending;
  });

  it("refuses a send once drain has begun", async () => {
    const m = newManager();
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    await m.drain(2_000);
    await expect(s.send("late", AUTH)).rejects.toBeInstanceOf(DaemonStoppingError);
    const r = await m.handle({ type: "session.send", id: "s1", sessionId: id, text: "late" } as never, AUTH, {
      id: "cli",
      auth: AUTH,
      send: () => {},
    });
    expect(r.type).toBe("response.error");
    expect(providers.at(-1)!.capturedOpts).toHaveLength(0);
  });

  it("waits for a turn that never ends only its backend's settle bound, for every session at once", async () => {
    // Acknowledges the interrupt, or never answers it, and never ends the turn.
    class Wedged extends MockSessionProvider {
      readonly interruptSettleMs = 300;
      constructor(private readonly ack: boolean) {
        super("claude");
      }
      override runTurn(opts: TurnOpts): TurnRun {
        this.capturedOpts.push(opts);
        const queue = new AsyncQueue<ProviderEvent>();
        void Promise.resolve().then(() => queue.push({ type: "text_delta", content: "working" } as ProviderEvent));
        return {
          events: queue,
          interrupt: () => (this.ack ? Promise.resolve() : new Promise<void>(() => {})),
          endTurn: () => queue.close(),
        };
      }
    }
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(tmp),
      // Every other one never answers the interrupt.
      _testProviderFactory: () => new Wedged(providers.push(new MockSessionProvider("claude")) % 2 === 0),
    });
    managers.push(m);
    const sends: Promise<unknown>[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await create(m);
      ids.push(id);
      const s = m._sessionForTest(id)!;
      sends.push(s.send("go", AUTH).catch((e) => e));
      for (let j = 0; j < 200 && s.status !== "thinking"; j++) await Bun.sleep(5);
    }
    const warned: string[] = [];
    const consoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    let took = 0;
    try {
      const started = performance.now();
      await m.drain(10_000);
      took = performance.now() - started;
    } finally {
      console.warn = consoleWarn;
    }
    // One bound, not four in a row, and nowhere near the deadline.
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(300 + 1_500);
    for (const id of ids) expect(warned.some((w) => w.includes(id.slice(0, 8)) && /didn't end its turn/.test(w))).toBe(true);
  });
});

describe("drain() and the work a turn's end starts", () => {
  /** A sandbox provider that wraps nothing: enough for the session's #448 git check to run. */
  function fakeSandboxes(): SandboxRegistry {
    const open = (spec: SandboxSpec) => new LocalSandboxHandle("bwrap", spec, (argv, o) => ({ argv: [...argv], env: o.env }));
    const reg = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
    reg.register({
      id: "bwrap",
      displayName: "bwrap",
      capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms: ["linux"] },
      probe: async () => ({ available: true }),
      open: async (spec) => open(spec),
      openSync: open,
    } as SandboxProvider);
    return reg;
  }

  /** The agent commits a project settings file during its turn (what #checkSettingsCommits exists to catch). */
  class SettingsCommitter extends LateResultProvider {
    override runTurn(opts: TurnOpts): TurnRun {
      mkdirSync(join(repo, ".claude"), { recursive: true });
      writeFileSync(join(repo, ".claude", "settings.json"), "{}\n");
      git("add", ".claude");
      git("commit", "-qm", "settings");
      return super.runTurn(opts);
    }
  }

  /** A manager on `provider`, its session mid-turn; drained, then the store closed: what is on disk is what the daemon leaves. */
  async function drainMidTurn(provider: () => MockSessionProvider, extra: { sandboxRegistry?: SandboxRegistry; hooks?: HookBus } = {}) {
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(tmp),
      _testProviderFactory: provider,
      ...extra,
    });
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const sending = s.send("go", AUTH).catch((e) => e);
    // A large workspace's start snapshot holds the turn back up to its 2 s wait.
    for (let i = 0; i < 1_000 && s.status !== "thinking"; i++) await Bun.sleep(5);
    expect(s.status).toBe("thinking");
    const errors: string[] = [];
    const warned: string[] = [];
    const consoleError = console.error;
    const consoleWarn = console.warn;
    console.error = (...args: unknown[]) => void errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    let took = 0;
    // Read synchronously right after the store closes: nothing still running gets a turn first.
    let snapshots: string[] = [];
    let lines = "";
    try {
      const started = performance.now();
      await m.drain(10_000);
      took = performance.now() - started;
      store.close();
      lines = readFileSync(join(tmp, "transcripts", `${id}.jsonl`), "utf8");
      snapshots = existsSync(shadowRepoPath(ckptRoot(), id))
        ? execFileSync("git", ["--git-dir", shadowRepoPath(ckptRoot(), id), "for-each-ref", "--format=%(refname)", "refs/turns/"], { encoding: "utf8" })
            .split("\n")
            .filter(Boolean)
        : [];
      await Bun.sleep(50);
    } finally {
      console.error = consoleError;
      console.warn = consoleWarn;
    }
    await sending;
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const audit = (db.query("SELECT action FROM audit_log WHERE session_id = ?").all(id) as Array<{ action: string }>).map((r) => r.action);
    db.close();
    return { id, took, errors, warned, lines, snapshots, audit };
  }

  const closedStore = (errors: string[]) => errors.filter((e) => /closed database|persist failed|audit write failed/i.test(e));

  /** A repository with a 3000-commit history, a tag on each: git takes longer than drain's poll slack. */
  function deepHistory(): void {
    const head = git("rev-parse", "HEAD").trim();
    let script = "";
    for (let i = 0; i < 3000; i++) {
      script += `commit refs/heads/main\nmark :${i + 1}\ncommitter t <t@e> ${1_700_000_000 + i} +0000\ndata 2\nc\n${i === 0 ? `from ${head}\n` : ""}M 644 inline f${i % 50}.txt\ndata 2\n${i % 10}\n\nreset refs/tags/t${i}\nfrom :${i + 1}\n\n`;
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: script });
    git("checkout", "-q", "-f", "main");
  }

  it("records the turn end's settings-commit check (audit row, warning line) before the store closes", async () => {
    const r = await drainMidTurn(() => new SettingsCommitter(20), { sandboxRegistry: fakeSandboxes() });
    expect(r.audit).toContain("session.settings_committed");
    expect(r.lines).toContain("sandbox.settings_committed");
    expect(closedStore(r.errors)).toEqual([]);
  });

  for (const late of [20, 100, 300]) {
    it(`records it in a repository with a 3000-commit history, the result ${late} ms after the interrupt`, async () => {
      deepHistory();
      const r = await drainMidTurn(() => new SettingsCommitter(late), { sandboxRegistry: fakeSandboxes() });
      expect(r.audit).toContain("session.settings_committed");
      expect(r.lines).toContain("sandbox.settings_committed");
      expect(closedStore(r.errors)).toEqual([]);
    }, 30_000);
  }

  it("takes the interrupted turn's end snapshot of a large workspace before it returns", async () => {
    mkdirSync(join(repo, "src"));
    for (let i = 0; i < 20_000; i++) writeFileSync(join(repo, "src", `f${i}.txt`), `file ${i}\n`.repeat(20));
    const r = await drainMidTurn(() => new LateResultProvider(20));
    // The start snapshot and the end one: a rewind past this turn has the files it ended with.
    expect(r.snapshots).toHaveLength(2);
    expect(r.snapshots.filter((ref) => ref.endsWith("-end"))).toHaveLength(1);
    expect(closedStore(r.errors)).toEqual([]);
  }, 30_000);

  it("lets an after_turn hook finish", async () => {
    const out = join(tmp, "after-turn.json");
    const hooks = new HookBus([{ event: "after_turn", type: "command", command: `sleep 0.3; cat > "${out}"` }]);
    const r = await drainMidTurn(() => new LateResultProvider(20), { hooks });
    expect(existsSync(out)).toBe(true);
    expect(r.took).toBeGreaterThanOrEqual(250);
  });

  it("waits for a turn end's work at most its bound, and names the session", async () => {
    const out = join(tmp, "never.json");
    // A hook that outlives the bound: shutdown goes on without it.
    const hooks = new HookBus([{ event: "after_turn", type: "command", command: `sleep 7; cat > "${out}"`, timeoutMs: 10_000 }]);
    const r = await drainMidTurn(() => new LateResultProvider(20), { hooks });
    expect(r.took).toBeGreaterThanOrEqual(TURN_END_SETTLE_MS - 100);
    expect(r.took).toBeLessThan(TURN_END_SETTLE_MS + 1_500);
    expect(r.warned.some((w) => w.includes(r.id.slice(0, 8)) && /didn't finish its turn's end/.test(w))).toBe(true);
  }, 15_000);
});

describe("a stopped turn's last reply", () => {
  it("is shown whole, not typed out frame by frame, so the turn ends as its result arrives", async () => {
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(tmp),
      _testProviderFactory: () => new LateResultProvider(0),
    });
    managers.push(m);
    const id = await create(m);
    const s = m._sessionForTest(id)!;
    const seen: DaemonMessage[] = [];
    s.attach({ id: "w", auth: AUTH, send: (msg: DaemonMessage) => { seen.push(msg); } });
    const sending = s.send("go", AUTH).catch((e) => e);
    for (let i = 0; i < 200 && s.status !== "thinking"; i++) await Bun.sleep(5);
    await s.interrupt(AUTH);
    await s.turnDrained(5_000);
    await sending;

    const last = seen.filter(
      (x): x is SessionMessage & DaemonMessage => x.type === "session.message" && x.role === "assistant" && x.content === "working on it, cut short",
    );
    expect(last).toHaveLength(1);
    expect(seen.some((x) => x.type === "session.message.delta" && x.messageId === last[0]!.messageId)).toBe(false);
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
        // Rebuilt from what was shown, not recorded from the backend (#387).
        restored: true,
      },
      {
        role: "user",
        content: "(Background work finished; the agent harness delivered the results.)",
        turnId: "T2",
        at: "2026-01-01T00:00:00Z",
        background: true,
      },
      { role: "assistant", content: "background result", turnId: "T2", providerId: "codex", model: "unknown", restored: true },
    ]);
  });
});
