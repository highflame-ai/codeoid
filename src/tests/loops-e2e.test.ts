/**
 * Loops end to end through the real daemon: loop.* over SessionManager.handle,
 * a real git repository, the real dispatcher scheduling attempts, a worker
 * session (scripted provider that edits the worktree), the daemon's own checks
 * recorded as evidence, and delivery as a commit on the run's branch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, LoopRunWire, LoopSnapshotMsg } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:owner",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const client = (auth: AuthContext) => ({ id: `c-${auth.sub}`, auth, send: () => {} });

/** A worker whose turns write files into its workdir, one script step per turn. */
class EditingProvider extends MockSessionProvider {
  #steps: Array<Record<string, string>>;
  #dir: () => string;
  constructor(steps: Array<Record<string, string>>, dir: () => string) {
    super(
      "mock",
      steps.map(() => [
        { type: "text_done", content: "edited" },
        { type: "turn_done", result: mockResult() },
      ] as ProviderEvent[]),
    );
    this.#steps = steps;
    this.#dir = dir;
  }
  override runTurn(opts: TurnOpts): TurnRun {
    const files = this.#steps.shift() ?? {};
    // `$sh` runs a shell command in the workdir after the files are written.
    for (const [rel, body] of Object.entries(files)) if (rel !== "$sh") writeFileSync(join(this.#dir(), rel), body);
    if (files.$sh) execSync(files.$sh, { cwd: this.#dir(), stdio: "ignore" });
    return super.runTurn(opts);
  }
}

/** The worktree of the owner's newest run — where its worker edits. */
function runWorktree(): string {
  const [run] = manager.loops!.list({ sub: AUTH.sub, accountId: AUTH.accountId, projectId: AUTH.projectId }, 1);
  if (!run?.worktreePath) throw new Error("the worker ran before its run had a worktree");
  return run.worktreePath;
}

function mkConfig(dbPath: string): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-loop-e2e-transcripts"),
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
  } as CodeoidConfig;
}

let tmp: string;
let repo: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function start(steps: Array<Record<string, string>>, extra: Partial<CodeoidConfig> = {}): void {
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: { ...mkConfig(join(tmp, "codeoid.db")), ...extra } as CodeoidConfig,
    _testProviderFactory: () => new EditingProvider(steps, runWorktree),
  });
  manager.startDispatcher();
  manager.startLoops();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-loop-e2e-"));
  repo = join(tmp, "repo");
  execFileSync("mkdir", ["-p", repo]);
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.name", "Test");
  gitIn(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "repo\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  manager?.stopLoops();
  manager?.dispatcher.stop();
  try {
    await manager?.drain(3_000);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

const startMsg = {
  type: "loop.start" as const,
  id: "s",
  objective: "Make the status check pass",
  workdir: "",
  checks: [{ id: "status", command: "grep -q ok status.txt", timeoutSec: 30 }],
  limits: { attempts: 3, attemptMinutes: 5, runMinutes: 10 },
};

function snap(m: DaemonMessage): LoopSnapshotMsg {
  if (m.type !== "loop.snapshot") throw new Error(`expected loop.snapshot, got ${JSON.stringify(m)}`);
  return m;
}

async function until(runId: string, done: (r: LoopRunWire) => boolean, ms = 20_000): Promise<LoopSnapshotMsg> {
  const end = Date.now() + ms;
  for (;;) {
    const s = snap(await manager.handle({ type: "loop.get", id: "g", runId, events: true }, AUTH, client(AUTH)));
    if (done(s.run)) return s;
    if (Date.now() > end) throw new Error(`run stuck: ${s.run.status} — ${s.run.reason}\n${JSON.stringify(s.events?.slice(-8), null, 1)}`);
    await Bun.sleep(50);
  }
}
const ended = (r: LoopRunWire) => ["completed", "budget_exhausted", "blocked", "failed", "cancelled"].includes(r.status);

describe("loops end to end", () => {
  test("a failing check is repaired on the second attempt and delivered as a commit on the run's branch", async () => {
    // The worker's first turn writes the wrong thing; its second fixes it.
    start([{ "status.txt": "wrong\n" }, { "status.txt": "ok\n" }]);
    // The checks run in the worktree; the scripted worker writes there too.
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);

    expect(done.run.status).toBe("completed");
    expect(done.attempts.map((a) => a.result)).toEqual(["unverified", "verified"]);
    expect(done.run.deliveredCommit).toMatch(/^[0-9a-f]{40}$/);
    // The commit is on the run's branch and holds the fix; the user's checkout is untouched.
    expect(gitIn(repo, "show", `${done.run.branch}:status.txt`)).toBe("ok\n");
    expect(gitIn(repo, "rev-parse", `${done.run.branch}`).trim()).toBe(done.run.deliveredCommit!);
    expect(gitIn(repo, "status", "--porcelain")).toBe("");

    // The verified attempt's evidence is revision-bound and readable by the owner.
    const verified = done.attempts[1]!;
    expect(verified.evidenceIds).toHaveLength(1);
    const ev = await manager.handle({ type: "evidence.get", id: "e", evidenceId: verified.evidenceIds[0]! }, AUTH, client(AUTH));
    if (ev.type !== "evidence.record") throw new Error(JSON.stringify(ev));
    expect(ev.evidence.result).toBe("pass");
    expect(ev.evidence.candidateDigest).toBe(verified.candidateTree);
  });

  test("checks that already pass on the unmodified code stop the run before any attempt", async () => {
    writeFileSync(join(repo, "status.txt"), "ok\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "already fine");
    start([]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("blocked");
    expect(done.run.reason).toContain("nothing to repair");
    expect(done.attempts).toHaveLength(0);
  });

  test("another user sees no run; a delegated token can't start one", async () => {
    start([{ "status.txt": "ok\n" }]);
    const delegated = { ...AUTH, delegationDepth: 1 };
    const refused = await manager.handle({ ...startMsg, workdir: repo }, delegated, client(delegated));
    expect(refused.type).toBe("response.error");
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const other = { ...AUTH, sub: "user:other" };
    const peek = await manager.handle({ type: "loop.get", id: "g", runId: created.run.id }, other, client(other));
    expect(peek.type === "response.error" && peek.code).toBe("not_found");
    const list = await manager.handle({ type: "loop.list", id: "l" }, other, client(other));
    expect(list.type === "loop.list.result" && list.runs).toEqual([]);
    await manager.handle({ type: "loop.cancel", id: "c", runId: created.run.id }, AUTH, client(AUTH));
  });

  test("a message typed into the worker becomes steering for the run", async () => {
    start([{ "status.txt": "wrong\n" }, { "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const running = await until(created.run.id, (r) => r.workerSessionId !== null);
    const res = await manager.handle(
      { type: "session.send", id: "x", sessionId: running.run.workerSessionId!, text: "Write exactly ok." },
      AUTH,
      client(AUTH),
    );
    expect(res.type === "response.ok" && (res.data as { steered?: string }).steered).toBe(created.run.id);
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    expect(done.events?.some((e) => e.type === "run.steered")).toBe(true);
  });
});

describe("loops end to end — audit round 1", () => {
  test("a git filter the worker plants never runs while the daemon snapshots or delivers", async () => {
    const leak = join(tmp, "leaked-env");
    process.env.CODEOID_TEST_ROOT_SECRET = "zid_sk_must_not_leak";
    try {
      // The worker writes a .gitattributes routing every file through a filter
      // it defined in the repo's config, then fixes the code.
      gitIn(repo, "config", "filter.evil.clean", `sh -c 'env > ${leak}; cat'`);
      start([{ ".gitattributes": "* filter=evil\n", "status.txt": "ok\n" }]);
      const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
      const done = await until(created.run.id, ended);
      expect(done.run.status).toBe("completed");
      expect(require("node:fs").existsSync(leak)).toBe(false);
    } finally {
      delete process.env.CODEOID_TEST_ROOT_SECRET;
    }
  });

  test("a new secret file the worker writes is kept out of the delivered commit", async () => {
    start([{ ".env": "TOKEN=secret\n", "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    const files = gitIn(repo, "ls-tree", "-r", "--name-only", done.run.branch!).split("\n");
    expect(files).toContain("status.txt");
    expect(files).not.toContain(".env");
    expect(done.events?.some((e) => e.type === "candidate.withheld")).toBe(true);
  });

  test("an active run's worker can't have its mode changed or be destroyed from outside", async () => {
    start([{ "status.txt": "wrong\n" }, { "status.txt": "wrong again\n" }, { "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const running = await until(created.run.id, (r) => r.workerSessionId !== null);
    const sid = running.run.workerSessionId!;
    const mode = await manager.handle({ type: "session.set_mode", id: "m", sessionId: sid, mode: "autonomous" } as never, AUTH, client(AUTH));
    expect(mode.type).toBe("response.error");
    const destroy = await manager.handle({ type: "session.destroy", id: "d", sessionId: sid } as never, AUTH, client(AUTH));
    expect(destroy.type).toBe("response.error");
    await until(created.run.id, ended);
    // Once the run ends the worker is an ordinary session again.
    const after = await manager.handle({ type: "session.set_mode", id: "m2", sessionId: sid, mode: "guarded" } as never, AUTH, client(AUTH));
    expect(after.type).not.toBe("response.error");
  });
});

describe("loops end to end — audit round 2", () => {
  test("a filter driver whose name holds '=' can't run either; git refuses the workspace instead", async () => {
    const pwned = join(tmp, "PWNED");
    execFileSync("git", ["config", "-f", join(repo, ".git", "config"), "filter.x=y.clean", `sh -c 'touch ${pwned}; cat'`]);
    start([{ ".gitattributes": "* filter=x=y\n", "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(require("node:fs").existsSync(pwned)).toBe(false);
    expect(done.run.status).toBe("failed");
    expect(done.run.reason).toContain("filter driver");
  });

  test("secrets renamed into place, edited in place, or under odd names stay out of the commit", async () => {
    writeFileSync(join(repo, "notes.txt"), "some notes that look a lot like an env file\nFOO=1\nBAR=2\n");
    execFileSync("mkdir", ["-p", join(repo, "config")]);
    writeFileSync(join(repo, "config", "credentials.json"), '{"token":"committed-placeholder"}\n');
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "fixtures");
    // The worker: renames notes.txt to .env with a key, writes a real token into
    // the tracked credentials file, adds a secret under a non-ASCII directory,
    // and fixes the check.
    const steps = [
      {
        ".env": "some notes that look a lot like an env file\nFOO=1\nBAR=2\nAPI_KEY=leak-one\n",
        "config/credentials.json": '{"token":"leak-two"}\n',
        "status.txt": "ok\n",
      },
    ];
    start(steps);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    // Remove notes.txt and add an odd-named secret in the worktree just before the attempt runs.
    const prepared = await until(created.run.id, (r) => r.worktreePath !== null);
    rmSync(join(prepared.run.worktreePath!, "notes.txt"), { force: true });
    execFileSync("mkdir", ["-p", join(prepared.run.worktreePath!, "configé")]);
    writeFileSync(join(prepared.run.worktreePath!, "configé", ".env"), "TOKEN=leak-three\n");
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    const branch = done.run.branch!;
    const files = gitIn(repo, "ls-tree", "-r", "--name-only", branch);
    expect(files).not.toContain(".env");
    expect(files).not.toContain("configé");
    expect(gitIn(repo, "show", `${branch}:config/credentials.json`)).toContain("committed-placeholder");
  });
});

describe("loops end to end — audit round 3", () => {
  test("a worker that points git at another directory can't get that directory delivered", async () => {
    const evil = join(tmp, "evil");
    start([
      {
        "status.txt": "ok\n",
        $sh: [
          "git config core.repositoryformatversion 1",
          "git config extensions.worktreeConfig true",
          `git config --worktree core.worktree ${evil}`,
          `mkdir -p ${evil}`,
          `printf 'ok\\n' > ${evil}/status.txt`,
          `printf 'x' > ${evil}/backdoor`,
        ].join(" && "),
      },
    ]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    const files = gitIn(repo, "ls-tree", "-r", "--name-only", done.run.branch!).split("\n");
    expect(files).toContain("status.txt");
    expect(files).not.toContain("backdoor");
  });

  test("a secret the worker commits itself stays out, and the branch is its base plus one verified commit", async () => {
    start([{ "status.txt": "ok\n", ".env": "TOKEN=leak\n", $sh: "git add -f .env status.txt && git commit -qm wip" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    const branch = done.run.branch!;
    expect(gitIn(repo, "ls-tree", "-r", "--name-only", branch)).not.toContain(".env");
    expect(gitIn(repo, "rev-list", "--count", `${done.run.baseRevision}..${branch}`).trim()).toBe("1");
    expect(gitIn(repo, "rev-parse", `${branch}^`).trim()).toBe(done.run.baseRevision!);
  });

  test("a file the candidate doesn't hold can't make its checks pass", async () => {
    start([{ "status.txt": "wrong\n", $sh: 'echo .pass-marker >> "$(git rev-parse --git-common-dir)/info/exclude" && touch .pass-marker' }]);
    const created = snap(
      await manager.handle(
        { ...startMsg, workdir: repo, checks: [{ id: "status", command: "grep -q ok status.txt || test -f .pass-marker", timeoutSec: 30 }], limits: { ...startMsg.limits, attempts: 1 } },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("budget_exhausted");
    expect(done.attempts[0]!.result).toBe("unverified");
  });

  test("destroying the worker after the run commits nothing more to its branch", async () => {
    start([{ "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    writeFileSync(join(done.run.worktreePath!, "leftover.txt"), "not verified\n");
    const res = await manager.handle({ type: "session.destroy", id: "d", sessionId: done.run.workerSessionId! } as never, AUTH, client(AUTH));
    expect(res.type).not.toBe("response.error");
    expect(gitIn(repo, "rev-parse", done.run.branch!).trim()).toBe(done.run.deliveredCommit!);
  });

  test("a run that ends before any worker leaves no worktree or branch behind", async () => {
    writeFileSync(join(repo, "status.txt"), "ok\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "already fine");
    start([]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("blocked");
    // Removal runs in the background: the worktree, then the branch.
    const gone = () => gitIn(repo, "worktree", "list").split("\n").filter(Boolean).length === 1 && gitIn(repo, "branch", "--list", done.run.branch!).trim() === "";
    for (let i = 0; i < 100 && !gone(); i++) await Bun.sleep(50);
    expect(gitIn(repo, "worktree", "list").split("\n").filter(Boolean)).toHaveLength(1);
    expect(gitIn(repo, "branch", "--list", done.run.branch!).trim()).toBe("");
  });
});

describe("loops end to end — audit round 4", () => {
  test("a smudge filter scoped to other git directories can't rewrite what the checks see", async () => {
    writeFileSync(join(repo, "check.sh"), "exit 1\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a failing check");
    const cfg = join(tmp, "evil.cfg");
    writeFileSync(cfg, '[filter "evil"]\n\tsmudge = sed s/1/0/\n\tclean = cat\n');
    start([{ ".gitattributes": "check.sh filter=evil\n", $sh: `git config "includeIf.gitdir:**/worktrees/**.path" ${cfg}` }]);
    const created = snap(
      await manager.handle(
        { ...startMsg, workdir: repo, checks: [{ id: "check", command: "sh check.sh", timeoutSec: 30 }], limits: { ...startMsg.limits, attempts: 1 } },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("budget_exhausted");
    expect(done.attempts[0]!.result).toBe("unverified");
  });

  test("no session can be opened inside an active run's worktree", async () => {
    start([{ "status.txt": "wrong\n" }, { "status.txt": "wrong\n" }, { "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const running = await until(created.run.id, (r) => r.workerSessionId !== null);
    const res = await manager.handle({ type: "session.create", id: "n", name: "intruder", workdir: running.run.worktreePath! } as never, AUTH, client(AUTH));
    expect(res.type).toBe("response.error");
    expect(res.type === "response.error" && res.error).toContain("active loop run's worktree");
    await manager.handle({ type: "loop.cancel", id: "c", runId: created.run.id }, AUTH, client(AUTH));
  });

  test("checks that ask git about their directory see the candidate as committed", async () => {
    start([{ "status.txt": "ok\n" }]);
    const created = snap(
      await manager.handle(
        { ...startMsg, workdir: repo, checks: [{ id: "clean", command: "grep -q ok status.txt && git diff-index --quiet HEAD -- && git diff --quiet HEAD && test -z \"$(git status --porcelain)\"", timeoutSec: 30 }] },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });
});

describe("loops end to end — audit round 5", () => {
  test("a replace ref can't swap the trusted setup command the checks are prepared with", async () => {
    writeFileSync(join(repo, "status.txt"), "wrong\n");
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "command: echo trusted > setup-marker\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a recipe");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start(
      [
        {
          "notes.txt": "tried\n",
          $sh: `git replace ${recipeHash} $(printf 'command: echo trusted > setup-marker && echo ok > status.txt\\n' | git hash-object -w --stdin)`,
        },
      ],
      { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>,
    );
    const created = snap(
      await manager.handle(
        { ...startMsg, workdir: repo, checks: [{ id: "status", command: "test -f setup-marker && grep -q ok status.txt", timeoutSec: 30 }], limits: { ...startMsg.limits, attempts: 1 } },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("budget_exhausted");
  });

  test("a symlink the candidate adds that leads out of the repository is never checked", async () => {
    start([{ "status.txt": "ok\n", $sh: `ln -s ${tmp} outside` }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo, limits: { ...startMsg.limits, attempts: 1 } }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("budget_exhausted");
    expect(done.attempts[0]!.note).toContain("leads outside the repository");
  });

  test("links chained so each looks inside can't lead a check out of the candidate", async () => {
    writeFileSync(join(tmp, "OUTSIDE.txt"), "ok\n");
    start([{ "status.txt": "wrong\n", $sh: "mkdir -p d && ln -s .. d/e && rm status.txt && ln -s d/e/../../OUTSIDE.txt status.txt" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo, limits: { ...startMsg.limits, attempts: 1 } }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("budget_exhausted");
    expect(done.attempts[0]!.note).toMatch(/leads (outside the repository|into the daemon's own directory)/);
  });

  test("a check that rewrites the candidate's files makes it unchecked, not judged by later checks", async () => {
    writeFileSync(join(repo, "status.txt"), "wrong\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "wrong");
    start([{ "notes.txt": "tried\n" }]);
    const created = snap(
      await manager.handle(
        {
          ...startMsg,
          workdir: repo,
          checks: [
            { id: "rewrite", command: "echo ok > status.txt; true", timeoutSec: 30 },
            { id: "status", command: "grep -q ok status.txt", timeoutSec: 30 },
          ],
          limits: { ...startMsg.limits, attempts: 1 },
        },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).not.toBe("completed");
  });

  test("a check that changes a tracked file (a build marking a script executable) doesn't sink the contract", async () => {
    writeFileSync(join(repo, "run.sh"), "grep -q ok status.txt\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a script, not executable");
    start([{ "status.txt": "ok\n" }]);
    const created = snap(
      await manager.handle(
        {
          ...startMsg,
          workdir: repo,
          checks: [
            { id: "build", command: "chmod +x run.sh && ./run.sh", timeoutSec: 30 },
            { id: "status", command: "grep -q ok status.txt", timeoutSec: 30 },
          ],
        },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });

  test("an attribute naming a filter no config defines doesn't refuse the repository", async () => {
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=nothing-configured\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a dangling filter attribute");
    start([{ "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });

  test("a repository with files stored through a git filter is refused when the run starts", async () => {
    gitIn(repo, "config", "filter.lfs.clean", "cat");
    gitIn(repo, "config", "filter.lfs.smudge", "cat");
    writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs\n");
    writeFileSync(join(repo, "a.bin"), "data\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "lfs");
    start([]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("failed");
    expect(done.run.reason).toContain('git filter "lfs"');
  });
});

describe("loops end to end — audit round 8", () => {
  const twoChecks = (first: string) => ({
    ...startMsg,
    checks: [
      { id: "first", command: first, timeoutSec: 30 },
      { id: "status", command: "grep -q ok sub/status.txt", timeoutSec: 30 },
    ],
  });

  test("a directory a check swaps for a link to look-alike files is put back before the next check", async () => {
    execFileSync("mkdir", ["-p", join(repo, "sub")]);
    writeFileSync(join(repo, "sub", "status.txt"), "wrong\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "sub");
    start([{ "sub/status.txt": "ok\n" }]);
    const first = 'mkdir -p ../evil && echo wrong > ../evil/status.txt && rm -rf sub && ln -s "$(cd ../evil && pwd)" sub';
    const created = snap(await manager.handle({ ...twoChecks(first), workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });

  test("a directory a check replaces with a file is put back too", async () => {
    execFileSync("mkdir", ["-p", join(repo, "sub")]);
    writeFileSync(join(repo, "sub", "status.txt"), "wrong\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "sub");
    start([{ "sub/status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...twoChecks("rm -rf sub && echo x > sub"), workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });

  test("a filter attribute whose driver only says `required` doesn't refuse the repository", async () => {
    gitIn(repo, "config", "filter.lfs.required", "true");
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=lfs\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "attr");
    start([{ "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });
});

describe("loops end to end — audit round 9", () => {
  /** A repo whose bad.txt says FAIL; the candidate leaves it, and only a check could hide it. */
  function failingFile(): void {
    writeFileSync(join(repo, "bad.txt"), "FAIL\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "bad");
  }
  const checks = (first: string, second: string) => ({
    ...startMsg,
    checks: [
      { id: "first", command: first, timeoutSec: 30 },
      { id: "second", command: second, timeoutSec: 30 },
    ],
    limits: { ...startMsg.limits, attempts: 1 },
  });
  const run = async (msg: Record<string, unknown>) => {
    const created = snap(await manager.handle({ ...msg, workdir: repo } as never, AUTH, client(AUTH)));
    return until(created.run.id, ended);
  };

  // The attack is candidate code (build.sh, which the base lacks), so the
  // baseline fails honestly and only the candidate's checks could be fooled.
  const build = "sh build.sh 2>/dev/null; true";

  test("a check can't make the daemon's own clock probe empty a candidate file", async () => {
    failingFile();
    start([{ "build.sh": "ln -sf ../bad.txt .git/codeoid-tick\n" }]);
    const done = await run(checks(build, "! grep -q FAIL bad.txt"));
    expect(done.run.status).not.toBe("completed");
  });

  test("a hook a check leaves in the check directory's repository never runs for the next", async () => {
    failingFile();
    start([{ "build.sh": "mkdir -p .git/hooks && printf '#!/bin/sh\\n: > bad.txt\\n' > .git/hooks/post-index-change && chmod +x .git/hooks/post-index-change\n" }]);
    const done = await run(checks(build, "git status --porcelain >/dev/null; ! grep -q FAIL bad.txt"));
    expect(done.run.status).not.toBe("completed");
  });

  test("a commondir a check plants can't redirect the next check's repository", async () => {
    start([{ "status.txt": "ok\n" }]);
    const evil = join(tmp, "evil-repo");
    gitIn(tmp, "init", "-q", evil);
    const done = await run(checks(`echo ${evil}/.git > .git/commondir; true`, `test "$(git rev-parse --git-common-dir)" != "${evil}/.git" && grep -q ok status.txt`));
    expect(done.run.status).toBe("completed");
  });

  test("a hardlink a check makes to a candidate file is broken before the next check", async () => {
    failingFile();
    start([{ "build.sh": "mkdir -p .git/logs && ln -f bad.txt .git/logs/HEAD\n" }]);
    // Passes only if something appended to the candidate's one-line file.
    const done = await run(checks(build, 'test "$(wc -l < bad.txt)" -gt 1'));
    expect(done.run.status).not.toBe("completed");
  });

  test("what the setup command changes among tracked files is put back, never delivered", async () => {
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "command: echo churn >> README.md\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a recipe that churns");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start([{ "status.txt": "ok\n" }], { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    expect(gitIn(repo, "show", `${done.run.branch}:README.md`)).toBe("repo\n");
    expect(done.events?.some((e) => e.type === "workspace.note" && e.detail.includes("README.md"))).toBe(true);
  });

  test("a file you staged through a git filter is refused like a committed one", async () => {
    gitIn(repo, "config", "filter.lfs.clean", "cat");
    gitIn(repo, "config", "filter.lfs.smudge", "cat");
    writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs\n");
    writeFileSync(join(repo, "a.bin"), "data\n");
    gitIn(repo, "add", ".gitattributes", "a.bin");
    start([]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("failed");
    expect(done.run.reason).toContain('git filter "lfs"');
  });
});

describe("loops end to end — audit round 10", () => {
  test("a file one check plants outside the candidate's files can't decide a later check", async () => {
    writeFileSync(join(repo, "status.txt"), "wrong\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "wrong");
    // Candidate code the first check runs plants a marker the second accepts.
    start([{ "build.sh": "touch .pass-marker\n" }]);
    const created = snap(
      await manager.handle(
        {
          ...startMsg,
          workdir: repo,
          checks: [
            { id: "build", command: "sh build.sh 2>/dev/null; true", timeoutSec: 30 },
            { id: "status", command: "test -f .pass-marker || grep -q ok status.txt", timeoutSec: 30 },
          ],
          limits: { ...startMsg.limits, attempts: 1 },
        },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("budget_exhausted");
  });

  test("a file the setup command creates is setup's, never delivered as the worker's", async () => {
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "command: echo gen > package-lock.json\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a recipe that makes a lockfile");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start([{ "status.txt": "ok\n" }], { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
    const files = gitIn(repo, "ls-tree", "-r", "--name-only", done.run.branch!);
    expect(files).toContain("status.txt");
    expect(files).not.toContain("package-lock.json");
  });

  test("a check writing next to its directory can't change what later checks see", async () => {
    writeFileSync(join(repo, "status.txt"), "wrong\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "wrong");
    start([{ "build.sh": 'for d in ../*/; do echo ok > "$d/status.txt" 2>/dev/null; done; true\n' }]);
    const created = snap(
      await manager.handle(
        {
          ...startMsg,
          workdir: repo,
          checks: [
            { id: "build", command: "sh build.sh 2>/dev/null; true", timeoutSec: 30 },
            { id: "status", command: "grep -q ok status.txt", timeoutSec: 30 },
          ],
          limits: { ...startMsg.limits, attempts: 1 },
        },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).not.toBe("completed");
  });

  test("absolute paths the setup command wrote lead into each check's own copy", async () => {
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "command: pwd -P > .where\n");
    writeFileSync(join(repo, ".gitignore"), ".where\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a recipe that records where it ran");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start([{ "status.txt": "ok\n" }], { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>);
    const here = 'test "$(cat .where)" = "$(pwd -P)" && touch "$(cat .where)/.mine" && test -f .mine';
    const created = snap(
      await manager.handle(
        {
          ...startMsg,
          workdir: repo,
          checks: [
            { id: "first", command: here, timeoutSec: 30 },
            { id: "second", command: `${here} && grep -q ok status.txt`, timeoutSec: 30 },
          ],
        },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });

  test("a directory of files setup made is one exclusion, and a file named HEAD doesn't confuse git", async () => {
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "command: mkdir -p venv && for i in $(seq 1 3000); do echo $i > venv/f$i; done\n");
    writeFileSync(join(repo, "HEAD"), "a file named HEAD\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a recipe that makes many files");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start([{ "status.txt": "ok\n" }], { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const done = await until(created.run.id, ended, 60_000);
    expect(done.run.status).toBe("completed");
    expect(gitIn(repo, "ls-tree", "-r", "--name-only", done.run.branch!)).not.toContain("venv/");
  }, 60_000);
});

describe("loops end to end — audit round 12", () => {
  test("a process that escapes a check is stopped before the next check's copy", async () => {
    writeFileSync(join(repo, "status.txt"), "wrong\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "wrong");
    start([{ "build.sh": `(setsid sh -c 'sleep 3; echo ok > "$0/status.txt"' "$PWD" > /dev/null 2>&1 &)\nsleep 1\n` }]);
    const created = snap(
      await manager.handle(
        {
          ...startMsg,
          workdir: repo,
          checks: [
            { id: "build", command: "sh build.sh 2>/dev/null; true", timeoutSec: 30 },
            { id: "status", command: "sleep 5; grep -q ok status.txt", timeoutSec: 30 },
          ],
          limits: { ...startMsg.limits, attempts: 1 },
        },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended, 60_000);
    expect(done.run.status).toBe("budget_exhausted");
  }, 60_000);

  test("files setup hard-linked from a shared cache don't break the seal when the cache is used elsewhere", async () => {
    const cache = join(tmp, "cache");
    execFileSync("mkdir", ["-p", cache]);
    writeFileSync(join(cache, "pkg.js"), "module.exports = 1;\n");
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), `command: mkdir -p deps && ln ${cache}/pkg.js deps/pkg.js\n`);
    writeFileSync(join(repo, ".gitignore"), "deps/\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a recipe that links from a cache");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start([{ "status.txt": "ok\n" }], { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>);
    const created = snap(
      await manager.handle(
        {
          ...startMsg,
          workdir: repo,
          checks: [
            // Another install elsewhere links the same cached file again.
            { id: "elsewhere", command: `ln -f ${cache}/pkg.js ${tmp}/other-install.js && test -f deps/pkg.js`, timeoutSec: 30 },
            { id: "status", command: "test -f deps/pkg.js && grep -q ok status.txt", timeoutSec: 30 },
          ],
        },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended);
    expect(done.run.status).toBe("completed");
  });

  test("a process the setup command leaves running can't write into a check's copy", async () => {
    writeFileSync(join(repo, "status.txt"), "wrong\n");
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), `command: (setsid sh -c 'sleep 3; echo ok > status.txt' > /dev/null 2>&1 &)\n`);
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a recipe that leaves a writer running");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start([{ "notes.txt": "x\n" }], { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>);
    const created = snap(
      await manager.handle(
        { ...startMsg, workdir: repo, checks: [{ id: "status", command: "sleep 5; grep -q ok status.txt", timeoutSec: 30 }], limits: { ...startMsg.limits, attempts: 1 } },
        AUTH,
        client(AUTH),
      ),
    );
    const done = await until(created.run.id, ended, 60_000);
    expect(done.run.status).not.toBe("blocked"); // the baseline must not pass on what a leftover wrote
    expect(done.run.status).not.toBe("completed");
  }, 60_000);
});

describe("loops end to end — audit round 14", () => {
  test("no session can open in a run's worktree while its setup still runs", async () => {
    execFileSync("mkdir", ["-p", join(repo, ".codeoid")]);
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "command: sleep 3\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-q", "-m", "a slow recipe");
    const recipeHash = gitIn(repo, "rev-parse", "HEAD:.codeoid/setup.yaml").trim();
    start([{ "status.txt": "ok\n" }], { worktree: { setup: { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash }] } } } as Partial<CodeoidConfig>);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const parent = `${repo}-worktrees`;
    let wt: string | undefined;
    for (let i = 0; i < 100 && !wt; i++) {
      await Bun.sleep(30);
      try {
        wt = require("node:fs").readdirSync(parent).map((n: string) => join(parent, n))[0];
      } catch {}
    }
    expect(wt).toBeDefined();
    const res = await manager.handle({ type: "session.create", id: "n", name: "intruder", workdir: wt! } as never, AUTH, client(AUTH));
    expect(res.type).toBe("response.error");
    await until(created.run.id, ended, 60_000);
  }, 60_000);

  test("nothing else gets a working directory in an active run's worktree", async () => {
    start([{ "status.txt": "wrong\n" }, { "status.txt": "wrong\n" }, { "status.txt": "ok\n" }]);
    const created = snap(await manager.handle({ ...startMsg, workdir: repo }, AUTH, client(AUTH)));
    const running = await until(created.run.id, (r) => r.workerSessionId !== null);
    const grant = await manager.handle({ type: "skill.grant", id: "g", workdir: running.run.worktreePath!, command: "ls", allowed: true } as never, AUTH, client(AUTH));
    expect(grant.type).toBe("response.error");
    const fork = await manager.handle({ type: "session.fork", id: "f", sessionId: running.run.workerSessionId!, isolate: false, providerId: "claude" } as never, AUTH, client(AUTH));
    expect(fork.type === "response.error" && fork.error).toContain("active loop run");
    await manager.handle({ type: "loop.cancel", id: "c", runId: created.run.id }, AUTH, client(AUTH));
  });
});

