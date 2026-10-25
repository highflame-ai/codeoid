/**
 * Routines that start a loop, end to end through the real daemon
 * (docs/routines.md "Routines that start a loop"): routine.* over
 * SessionManager.handle with its scope gates, a fire through the run-now
 * path and the API trigger, a real loop run (real git repository, the
 * dispatcher, a scripted worker that edits its worktree, the daemon's own
 * checks), and the routine run following it to the loop's outcome.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { handleRoutineFire } from "../daemon/routines/http.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, LoopSnapshotMsg, RoutineRunWire, RoutineSnapshotMsg } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:owner",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
/** Can manage routines but not pre-approve work. */
const NO_APPROVE: AuthContext = { ...AUTH, scopes: [SCOPES.SESSION_LIST, SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND] as AuthContext["scopes"] };
const DELEGATED: AuthContext = { ...AUTH, delegationDepth: 1, delegatedBy: AUTH.sub };
const client = (auth: AuthContext) => ({ id: `c-${auth.sub}`, auth, send: () => {} });

/** A worker whose turns write files into its worktree, one step per turn. */
class EditingProvider extends MockSessionProvider {
  #steps: Array<Record<string, string>>;
  constructor(steps: Array<Record<string, string>>) {
    super(
      "mock",
      steps.map(() => [
        { type: "text_done", content: "edited" },
        { type: "turn_done", result: mockResult() },
      ] as ProviderEvent[]),
    );
    this.#steps = steps;
  }
  override runTurn(opts: TurnOpts): TurnRun {
    const files = this.#steps.shift() ?? {};
    const [run] = manager.loops!.list({ sub: AUTH.sub, accountId: AUTH.accountId, projectId: AUTH.projectId }, 1);
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(run!.worktreePath!, rel), body);
    return super.runTurn(opts);
  }
}

function mkConfig(dbPath: string): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-loop-routine-e2e-transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    dispatch: { enabled: true, tickMs: 250, leaseMs: 60_000, failureLimit: 2, maxConcurrentWorkers: 2, workerToolBudget: 7, retryBaseMs: 0 },
    pipeline: { enabled: false, defaultPack: null, packs: [] },
    routines: { enabled: true, tickMs: 200, maxConcurrentRuns: 2, minIntervalSeconds: 60, apiFiresPerHour: 30, missedGraceSeconds: 120 },
  } as CodeoidConfig;
}

let tmp: string;
let repo: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const call = (msg: Record<string, unknown>, auth: AuthContext = AUTH): Promise<DaemonMessage> => manager.handle({ id: "r", ...msg } as never, auth, client(auth));

function start(steps: Array<Record<string, string>>): void {
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db")),
    _testProviderFactory: () => new EditingProvider(steps),
  });
  manager.startDispatcher();
  manager.startLoops();
  manager.startRoutines();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-loop-routine-e2e-"));
  repo = join(tmp, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "repo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  manager?.stopRoutines();
  manager?.stopLoops();
  manager?.dispatcher.stop();
  try {
    await manager?.drain(3_000);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

const loopSpec = () => ({
  name: "status-repair",
  prompt: "Make the status check pass.",
  workdir: repo,
  loop: { checks: [{ id: "status", command: "grep -q ok status.txt", timeoutSec: 30 }], limits: { attempts: 3, attemptMinutes: 5, runMinutes: 10 } },
});

async function createRoutine(spec: Record<string, unknown> = loopSpec()): Promise<RoutineSnapshotMsg> {
  const res = await call({ type: "routine.create", spec });
  if (res.type !== "routine.snapshot") throw new Error(`routine.create: ${JSON.stringify(res)}`);
  return res;
}

/** Poll one routine run until it leaves the active statuses. */
async function runEnds(routine: string, runId: string, ms = 20_000): Promise<RoutineRunWire> {
  const end = Date.now() + ms;
  for (;;) {
    const res = await call({ type: "routine.runs", routine, runId });
    const run = res.type === "routine.runs.result" ? res.runs[0] : undefined;
    if (run && !["queued", "checking", "running"].includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`routine run stuck: ${JSON.stringify(run)}`);
    await Bun.sleep(50);
  }
}

async function loopSnapshot(runId: string): Promise<LoopSnapshotMsg> {
  const res = await call({ type: "loop.get", runId, events: true });
  if (res.type !== "loop.snapshot") throw new Error(JSON.stringify(res));
  return res;
}

describe("a routine that starts a loop", () => {
  test("run now: the routine fires, its loop repairs and is verified, and the routine run ends linked to it", async () => {
    // The worker's first turn writes the wrong thing; its second fixes it.
    start([{ "status.txt": "wrong\n" }, { "status.txt": "ok\n" }]);
    const { routine } = await createRoutine();
    expect(routine.spec.loop?.checks).toEqual([{ id: "status", command: "grep -q ok status.txt", timeoutSec: 30 }]);

    const fired = await call({ type: "routine.run", routine: "status-repair", payload: "status.txt is wrong since the last deploy" });
    if (fired.type !== "routine.run.result") throw new Error(JSON.stringify(fired));
    const done = await runEnds(routine.id, fired.run.id);

    expect(done.status).toBe("succeeded");
    expect(done.loop?.status).toBe("completed");
    const loop = await loopSnapshot(done.loop!.runId);
    expect(loop.run.status).toBe("completed");
    expect(loop.attempts.map((a) => a.result)).toEqual(["unverified", "verified"]);
    // "Started by" names the routine and this routine run; the payload rode as data.
    expect(loop.run.trigger).toMatchObject({ kind: "routine", routineId: routine.id, routineName: "status-repair", routineRunId: fired.run.id });
    expect(loop.run.trigger!.summary).toContain("since the last deploy");
    expect(loop.run.objective).toBe("Make the status check pass.");
    // The summary names the delivered commit; the user's checkout is untouched.
    expect(done.summary).toContain(loop.run.deliveredCommit!.slice(0, 12));
    expect(git("show", `${loop.run.branch}:status.txt`)).toBe("ok\n");
    expect(git("status", "--porcelain")).toBe("");
    // It's an ordinary loop run in the owner's list.
    const list = await call({ type: "loop.list" });
    expect(list.type === "loop.list.result" && list.runs.map((r) => r.id)).toContain(loop.run.id);
  });

  test("the API trigger fires it too, with the payload as the loop's data", async () => {
    start([{ "status.txt": "ok\n" }]);
    const { routine } = await createRoutine({ ...loopSpec(), api: true });
    const token = await call({ type: "routine.token", routine: routine.id });
    if (token.type !== "routine.token.result") throw new Error(JSON.stringify(token));
    const res = await handleRoutineFire(
      new Request(`http://127.0.0.1/routines/${routine.id}/fire`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "the status monitor went red" }),
      }),
      routine.id,
      manager.routines!,
    );
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const done = await runEnds(routine.id, runId);
    expect(done.trigger).toBe("api");
    expect(done.status).toBe("succeeded");
    const loop = await loopSnapshot(done.loop!.runId);
    expect(loop.run.trigger?.summary).toContain("the status monitor went red");
  });

  test("checks that already pass: nothing to repair, the routine run is silent", async () => {
    writeFileSync(join(repo, "status.txt"), "ok\n");
    git("add", ".");
    git("commit", "-q", "-m", "already fine");
    start([]);
    const { routine } = await createRoutine();
    const fired = await call({ type: "routine.run", routine: routine.id });
    if (fired.type !== "routine.run.result") throw new Error(JSON.stringify(fired));
    const done = await runEnds(routine.id, fired.run.id);
    expect(done.status).toBe("silent");
    expect(done.loop?.status).toBe("blocked");
  });

  test("cancelling the routine run cancels its loop run", async () => {
    start([{ "status.txt": "wrong\n" }, { "status.txt": "wrong\n" }, { "status.txt": "wrong\n" }]);
    const { routine } = await createRoutine();
    const fired = await call({ type: "routine.run", routine: routine.id });
    if (fired.type !== "routine.run.result") throw new Error(JSON.stringify(fired));
    let loopRunId: string | undefined;
    for (let i = 0; i < 200 && !loopRunId; i++) {
      const res = await call({ type: "routine.runs", routine: routine.id, runId: fired.run.id });
      loopRunId = res.type === "routine.runs.result" ? res.runs[0]?.loop?.runId : undefined;
      await Bun.sleep(25);
    }
    expect(loopRunId).toBeDefined();
    const cancel = await call({ type: "routine.cancel_run", runId: fired.run.id });
    expect(cancel.type).toBe("response.ok");
    const done = await runEnds(routine.id, fired.run.id);
    expect(done.status).toBe("cancelled");
    expect((await loopSnapshot(loopRunId!)).run.status).toBe("cancelled");
  });
});

describe("who can make, change and fire a loop routine", () => {
  test("a delegated token can't create one, and without session:approve nobody can save or fire one", async () => {
    start([]);
    const delegated = await call({ type: "routine.create", spec: loopSpec() }, DELEGATED);
    expect(delegated.type === "response.error" && delegated.code).toBe("forbidden");
    // Guarded and gate-less, so only the loop asks for session:approve (the
    // scope check comes before the spec is judged).
    const noApprove = await call({ type: "routine.create", spec: { ...loopSpec(), name: "x", approvals: "guarded" } }, NO_APPROVE);
    expect(noApprove.type === "response.error" && noApprove.error).toContain("session:approve");

    // Turning a guarded session routine into a loop routine is a change that needs it too.
    const plain = await call({ type: "routine.create", spec: { name: "plain", prompt: "p", workdir: repo, approvals: "guarded" } }, NO_APPROVE);
    expect(plain.type).toBe("routine.snapshot");
    const toLoop = await call(
      { type: "routine.update", routine: "plain", spec: { loop: loopSpec().loop } },
      NO_APPROVE,
    );
    expect(toLoop.type === "response.error" && toLoop.code).toBe("forbidden");

    // The owner's loop routine can't be fired, changed or re-tokened without it, nor by a delegated token.
    await createRoutine();
    const fire = await call({ type: "routine.run", routine: "status-repair" }, { ...NO_APPROVE, sub: AUTH.sub });
    expect(fire.type === "response.error" && fire.error).toContain("session:approve");
    const edit = await call({ type: "routine.update", routine: "status-repair", spec: { loop: { limits: { attempts: 2 } } } }, { ...NO_APPROVE, sub: AUTH.sub });
    expect(edit.type === "response.error" && edit.code).toBe("forbidden");
    const delegatedFire = await call({ type: "routine.run", routine: "status-repair" }, DELEGATED);
    expect(delegatedFire.type === "response.error" && delegatedFire.code).toBe("forbidden");
    // Pausing is a safety stop any credential that can manage it may use.
    const pause = await call({ type: "routine.update", routine: "status-repair", enabled: false }, { ...NO_APPROVE, sub: AUTH.sub });
    expect(pause.type).toBe("routine.snapshot");
  });

  test("a backend that can't carry a loop worker is refused when it is saved", async () => {
    start([]);
    const res = await call({ type: "routine.create", spec: { ...loopSpec(), provider: "codex" } });
    expect(res.type === "response.error" && res.error).toMatch(/Loops run on claude|unknown provider/);
  });
});
