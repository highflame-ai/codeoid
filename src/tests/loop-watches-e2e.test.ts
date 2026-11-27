/**
 * Loop watches through the real daemon: loop.watch.* over SessionManager.handle
 * (authorization, owner scoping), a scripted `gh` (no network), and a real git
 * repository — a failing check on a pull request's branch starts a repair run
 * whose worktree is that branch's head, not the owner's checkout.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { GhExec } from "../daemon/loops/triggers/github.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";
import type { AuthContext, ClientMessage, DaemonMessage, LoopRunWire, LoopSnapshotMsg, LoopWatchSnapshotMsg } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:owner",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const client = (auth: AuthContext) => ({ id: `c-${auth.sub}`, auth, send: () => {} });

/** A worker whose turns write files into its workdir. */
class EditingProvider extends MockSessionProvider {
  #steps: Array<Record<string, string>>;
  #dir: () => string;
  constructor(steps: Array<Record<string, string>>, dir: () => string) {
    super("mock", steps.map(() => [{ type: "text_done", content: "edited" }, { type: "turn_done", result: mockResult() }] as ProviderEvent[]));
    this.#steps = steps;
    this.#dir = dir;
  }
  override runTurn(opts: TurnOpts): TurnRun {
    for (const [rel, body] of Object.entries(this.#steps.shift() ?? {})) writeFileSync(join(this.#dir(), rel), body);
    return super.runTurn(opts);
  }
}

let tmp: string;
let repo: string;
let featureSha: string;
let store: Store;
let manager: SessionManager;
let ghCalls: string[][];
let checkRuns: Array<{ id: number; name: string; status: string; conclusion: string }>;
let prHead: () => string;
let headCommits: Array<{ author: string | null; committer: string | null }>;
/** Who GitHub records as having pushed the pull request's head. */
let pusher: string;

const fakeGh: GhExec = async (args) => {
  ghCalls.push(args);
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  if (args[0] === "api" && args[1] === "user") return ok({ login: "owner" });
  if (args[0] === "pr") {
    return ok([
      { number: 7, headRefName: "feature", headRefOid: prHead(), url: "https://github.com/acme/shop/pull/7", headRepository: { name: "shop" }, headRepositoryOwner: { login: "acme" } },
    ]);
  }
  const path = args.at(-1)!;
  if (path === "repos/acme/shop") return ok({ default_branch: "main" });
  if (path.startsWith("repos/acme/shop/activity?")) return ok([{ after: prHead(), activity_type: "push", actor: { login: pusher } }]);
  if (path.includes("/compare/main...")) {
    return ok({ total_commits: headCommits.length, commits: headCommits.map((c, i) => ({ sha: String(i).repeat(40), author: c.author && { login: c.author }, committer: c.committer && { login: c.committer } })) });
  }
  if (path.includes("/check-runs")) {
    return ok({ total_count: checkRuns.length, check_runs: checkRuns.map((c) => ({ ...c, app: { slug: "github-actions" }, check_suite: { id: 5 }, output: { title: "status", summary: "status.txt is not ok" } })) });
  }
  if (path.includes("/git/commits/")) return ok({ message: "feat: the feature" });
  if (path.includes("/comments") || path.includes("/reviews")) return ok([]);
  return { code: 1, stdout: "", stderr: "unscripted" };
};

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function mkConfig(dbPath: string): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-watch-e2e-transcripts"),
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

function runWorktree(): string {
  const [run] = manager.loops!.list({ sub: AUTH.sub, accountId: AUTH.accountId, projectId: AUTH.projectId }, 1);
  if (!run?.worktreePath) throw new Error("the worker ran before its run had a worktree");
  return run.worktreePath;
}

function start(steps: Array<Record<string, string>>, githubRemote?: (repo: string) => string): void {
  manager = new SessionManager(store, new TranscriptStore(join(tmp, "transcripts")), undefined, undefined, undefined, {
    config: mkConfig(join(tmp, "codeoid.db")),
    _testProviderFactory: () => new EditingProvider(steps, runWorktree),
    _testGhExec: fakeGh,
    // Never github.com: the fetch's tests point it at a local repository or at nothing.
    _testGithubRemote: githubRemote ?? (() => "https://127.0.0.1:9/acme/shop.git"),
  });
  manager.startDispatcher();
  manager.startLoops();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-watch-e2e-"));
  repo = join(tmp, "repo");
  execFileSync("mkdir", ["-p", repo]);
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.name", "Test");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
  writeFileSync(join(repo, "README.md"), "repo\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "init");
  // The pull request's branch: a commit that isn't on main.
  gitIn(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "feature.txt"), "the feature\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "feat: the feature");
  featureSha = gitIn(repo, "rev-parse", "HEAD").trim();
  gitIn(repo, "checkout", "-q", "main");
  // Uncommitted work in the owner's checkout: never carried into a triggered run.
  writeFileSync(join(repo, "README.md"), "my local edit\n");
  store = new Store(join(tmp, "codeoid.db"));
  ghCalls = [];
  checkRuns = [{ id: 41, name: "status", status: "completed", conclusion: "failure" }];
  prHead = () => featureSha;
  headCommits = [{ author: "owner", committer: "owner" }];
  pusher = "owner";
});

afterEach(async () => {
  manager?.stopLoops();
  manager?.dispatcher.stop();
  try {
    await manager?.drain(3_000);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

const createMsg = (workdir = repo): Extract<ClientMessage, { type: "loop.watch.create" }> => ({
  type: "loop.watch.create",
  id: "w",
  spec: { workdir, myPrs: true, ci: [{ ciName: "status", command: "grep -q ok status.txt", timeoutSec: 30 }], limits: { attempts: 2, attemptMinutes: 5, runMinutes: 10 } },
});

function wsnap(m: DaemonMessage): LoopWatchSnapshotMsg {
  if (m.type !== "loop.watch.snapshot") throw new Error(`expected loop.watch.snapshot, got ${JSON.stringify(m)}`);
  return m;
}

async function until(runId: string, done: (r: LoopRunWire) => boolean, ms = 20_000): Promise<LoopSnapshotMsg> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await manager.handle({ type: "loop.get", id: "g", runId, events: true }, AUTH, client(AUTH));
    if (s.type !== "loop.snapshot") throw new Error(JSON.stringify(s));
    if (done(s.run)) return s;
    if (Date.now() > end) throw new Error(`run stuck: ${s.run.status} — ${s.run.reason}\n${JSON.stringify(s.events?.slice(-8), null, 1)}`);
    await Bun.sleep(50);
  }
}
const ended = (r: LoopRunWire) => ["completed", "budget_exhausted", "blocked", "failed", "cancelled"].includes(r.status);

describe("loop watches end to end", () => {
  test("a failing check on a PR branch is repaired from that branch's head, and fires once", async () => {
    start([{ "status.txt": "ok\n" }]);
    const w = wsnap(await manager.handle(createMsg(), AUTH, client(AUTH)));
    expect(w.watch.repo).toBe("acme/shop");

    const polled = wsnap(await manager.handle({ type: "loop.watch.poll", id: "p", watchId: w.watch.id }, AUTH, client(AUTH)));
    expect(polled.poll?.started).toHaveLength(1);
    const runId = polled.poll!.started[0]!;
    const done = await until(runId, ended);

    expect(done.run.status).toBe("completed");
    expect(done.run.trigger).toMatchObject({ kind: "ci_failure", key: `ci:acme/shop:${featureSha}:41:5`, watchId: w.watch.id });
    expect(done.run.baseRef).toEqual({ sha: featureSha, branch: "feature" });
    // Worked from the PR's head: the feature is there, the owner's edit isn't.
    expect(done.run.baseRevision).toBe(featureSha);
    expect(gitIn(repo, "rev-parse", `${done.run.deliveredCommit}^`).trim()).toBe(featureSha);
    expect(gitIn(repo, "show", `${done.run.branch}:feature.txt`)).toBe("the feature\n");
    expect(gitIn(repo, "show", `${done.run.branch}:README.md`)).toBe("repo\n");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("my local edit\n");
    expect(existsSync(join(repo, "status.txt"))).toBe(false);

    // The same event on later polls starts nothing more.
    const again = wsnap(await manager.handle({ type: "loop.watch.poll", id: "p2", watchId: w.watch.id }, AUTH, client(AUTH)));
    expect(again.poll?.started).toEqual([]);
    expect(again.triggers?.map((t) => t.runId)).toEqual([runId]);
  });

  test("a head pushed by someone you don't trust starts nothing, even with commits that name you", async () => {
    start([]);
    // Unsigned commits with your email: GitHub names you, which proves nothing.
    headCommits = [{ author: "owner", committer: "owner" }];
    pusher = "mallory";
    const w = wsnap(await manager.handle(createMsg(), AUTH, client(AUTH)));
    const polled = wsnap(await manager.handle({ type: "loop.watch.poll", id: "p", watchId: w.watch.id }, AUTH, client(AUTH)));
    expect(polled.poll?.started).toEqual([]);
    expect(polled.triggers?.[0]).toMatchObject({ outcome: "ignored", runId: null });
    expect(polled.triggers?.[0]?.note).toContain("@mallory");
    expect(manager.loops!.list({ sub: AUTH.sub, accountId: AUTH.accountId, projectId: AUTH.projectId })).toHaveLength(0);
  });

  /** A commit that exists only in another repository (as a pull request's head is only on GitHub). */
  function remoteOnly(): { other: string; sha: string } {
    const other = join(tmp, "other");
    gitIn(tmp, "clone", "-q", repo, other);
    gitIn(other, "config", "user.name", "Test");
    gitIn(other, "config", "user.email", "test@example.com");
    gitIn(other, "checkout", "-q", "feature");
    writeFileSync(join(other, "remote-only.txt"), "x\n");
    gitIn(other, "add", ".");
    gitIn(other, "commit", "-q", "-m", "feat: only on GitHub");
    // Where GitHub keeps a pull request's head.
    gitIn(other, "update-ref", "refs/pull/7/head", "HEAD");
    return { other, sha: gitIn(other, "rev-parse", "HEAD").trim() };
  }

  /** Config an agent could write into your repository, aimed at the fetch. */
  function poisonConfig(redirectTo: string): void {
    gitIn(repo, "config", `url.${redirectTo}.insteadOf`, "https://127.0.0.1:9/acme/shop.git");
    gitIn(repo, "config", "credential.helper", `!touch ${join(tmp, "pwned-credential")}`);
    gitIn(repo, "config", "core.sshCommand", `touch ${join(tmp, "pwned-ssh")}`);
    gitIn(repo, "config", "http.sslVerify", "false");
  }

  test("a head that must be fetched comes into a repository of the daemon's own, with your config out of it, and is repaired", async () => {
    const { other, sha } = remoteOnly();
    prHead = () => sha;
    start([{ "status.txt": "ok\n" }], () => `file://${other}`);
    const w = wsnap(await manager.handle(createMsg(), AUTH, client(AUTH)));
    // Your repository's config would send the fetch somewhere that doesn't exist.
    poisonConfig(`file://${join(tmp, "nowhere")}`);
    gitIn(repo, "config", `url.file://${join(tmp, "nowhere")}.insteadOf`, `file://${other}`);
    // A remote-tracking tip: what the fetch says it already has.
    gitIn(repo, "update-ref", "refs/remotes/origin/main", "main");
    const polled = wsnap(await manager.handle({ type: "loop.watch.poll", id: "p", watchId: w.watch.id }, AUTH, client(AUTH)));
    expect(polled.poll?.started).toHaveLength(1);
    const done = await until(polled.poll!.started[0]!, ended);
    expect(done.run.status).toBe("completed");
    expect(done.run.baseRevision).toBe(sha);
    expect(gitIn(repo, "show", `${done.run.branch}:remote-only.txt`)).toBe("x\n");
    expect(existsSync(join(tmp, "pwned-credential"))).toBe(false);
    expect(existsSync(join(tmp, "pwned-ssh"))).toBe(false);
  });

  test("a failed fetch says why and retries three times; your config never redirects it", async () => {
    const { other, sha } = remoteOnly();
    prHead = () => sha;
    start([]);
    const w = wsnap(await manager.handle(createMsg(), AUTH, client(AUTH)));
    // Followed, this would fetch the commit from the other repository.
    poisonConfig(`file://${other}`);
    const runs: string[] = [];
    for (let i = 0; i < 6 && runs.length < 3; i++) {
      const p = wsnap(await manager.handle({ type: "loop.watch.poll", id: `p${i}`, watchId: w.watch.id }, AUTH, client(AUTH)));
      for (const id of p.poll?.started ?? []) {
        runs.push(id);
        const done = await until(id, ended);
        expect(done.run.status).toBe("failed");
        expect(done.run.reason).toContain("could not be fetched from github.com/acme/shop");
        expect(done.run.reason).toContain("127.0.0.1"); // git's own words: where it tried
      }
    }
    expect(runs).toHaveLength(3);
    const last = wsnap(await manager.handle({ type: "loop.watch.poll", id: "last", watchId: w.watch.id }, AUTH, client(AUTH)));
    expect(last.poll?.started).toEqual([]);
    expect(last.triggers?.[0]).toMatchObject({ outcome: "ignored" });
    expect(last.triggers?.[0]?.note).toContain("couldn't be prepared 3 times");
    expect(existsSync(join(tmp, "pwned-credential"))).toBe(false);
    expect(existsSync(join(tmp, "pwned-ssh"))).toBe(false);
    expect(() => gitIn(repo, "cat-file", "-e", sha)).toThrow();
  });

  test("a shallow or partial clone can't take a fetched head: the run says so and the event isn't retried", async () => {
    const { other, sha } = remoteOnly();
    prHead = () => sha;
    start([], () => `file://${other}`);
    const shallow = join(tmp, "shallow");
    gitIn(tmp, "clone", "-q", "--depth", "1", "--branch", "main", `file://${repo}`, shallow);
    gitIn(shallow, "remote", "set-url", "origin", "https://github.com/acme/shop.git");
    const partial = join(tmp, "partial");
    gitIn(tmp, "clone", "-q", repo, partial);
    gitIn(partial, "remote", "set-url", "origin", "https://github.com/acme/shop.git");
    gitIn(partial, "config", "remote.origin.promisor", "true");
    gitIn(partial, "config", "extensions.partialClone", "origin");
    for (const [i, [dir, what]] of ([[shallow, "shallow clone"], [partial, "partial clone"]] as const).entries()) {
      // A new event each time: the first is the owner's, acted on, whichever watch sees it.
      checkRuns = [{ id: 50 + i, name: "status", status: "completed", conclusion: "failure" }];
      const w = wsnap(await manager.handle(createMsg(dir), AUTH, client(AUTH)));
      const polled = wsnap(await manager.handle({ type: "loop.watch.poll", id: "p", watchId: w.watch.id }, AUTH, client(AUTH)));
      expect(polled.poll?.started).toHaveLength(1);
      const done = await until(polled.poll!.started[0]!, ended);
      expect(done.run.status).toBe("failed");
      expect(done.run.reason).toContain(`this repository is a ${what}`);
      expect(() => gitIn(dir, "cat-file", "-e", sha)).toThrow(); // nothing was fetched
      const again = wsnap(await manager.handle({ type: "loop.watch.poll", id: "p2", watchId: w.watch.id }, AUTH, client(AUTH)));
      expect(again.poll?.started).toEqual([]);
      expect(again.triggers?.[0]).toMatchObject({ outcome: "ignored" });
      expect(again.triggers?.[0]?.note).toContain("can't be prepared");
      await manager.handle({ type: "loop.watch.delete", id: "d", watchId: w.watch.id }, AUTH, client(AUTH));
    }
  });

  test("the fetch's haves are only the remote-tracking tips of remotes that are github.com/<repo>", async () => {
    const { fetchHaves } = await import("../daemon/loops/host.js");
    const tree = gitIn(repo, "rev-parse", "main^{tree}").trim();
    const commit = (msg: string) => gitIn(repo, "commit-tree", tree, "-m", msg).trim();
    const tips = { origin: commit("origin"), upstream: commit("upstream"), evil: commit("evil"), stray: commit("stray"), rewritten: commit("rewritten") };
    gitIn(repo, "remote", "add", "upstream", "git@github.com:Acme/Shop.git");
    gitIn(repo, "remote", "add", "evil", "https://github.com/mallory/shop.git");
    gitIn(repo, "remote", "add", "rewritten", "https://github.com/acme/shop");
    // Fetched through this, `rewritten`'s refs came from somewhere else.
    gitIn(repo, "config", "url.https://evil.example/acme/shop.insteadOf", "https://github.com/acme/shop");
    for (const [name, sha] of Object.entries(tips)) gitIn(repo, "update-ref", `refs/remotes/${name}/main`, sha);
    // `rewritten`'s prefix also matches `origin`'s URL (`https://github.com/acme/shop.git`): neither is a have.
    expect(await fetchHaves(repo, "acme/shop")).toEqual([tips.upstream]);
    gitIn(repo, "config", "--unset", "url.https://evil.example/acme/shop.insteadOf");
    expect((await fetchHaves(repo, "acme/shop")).sort()).toEqual([tips.origin, tips.upstream, tips.rewritten].sort());
    // A remote named under another's name would be listed with it. Newer git
    // refuses `remote add` for that name, but config can still define it.
    gitIn(repo, "config", "remote.origin/x.url", "https://github.com/mallory/shop.git");
    expect((await fetchHaves(repo, "acme/shop")).sort()).toEqual([tips.upstream, tips.rewritten].sort());
    expect(await fetchHaves(repo, "someone/else")).toEqual([]);
  });

  test("gh never sees the daemon's secrets", async () => {
    const { ghEnv } = await import("../daemon/loops/triggers/github.js");
    const env = ghEnv({ PATH: "/bin", HOME: "/h", GH_CONFIG_DIR: "/h/gh", CODEOID_API_KEY: "zid_sk_x", ZEROID_URL: "u", ANTHROPIC_API_KEY: "k", GH_TOKEN: "t" });
    expect(Object.keys(env).sort()).toEqual(["GH_CONFIG_DIR", "GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED", "HOME", "LANG", "NO_COLOR", "PATH"]);
  });
});

describe("loop watch authorization", () => {
  test("owner-only: another user, or another project, sees nothing", async () => {
    start([]);
    const w = wsnap(await manager.handle(createMsg(), AUTH, client(AUTH)));
    for (const other of [{ ...AUTH, sub: "user:other" }, { ...AUTH, projectId: "elsewhere" }]) {
      for (const msg of [
        { type: "loop.watch.get" as const, id: "g", watchId: w.watch.id },
        { type: "loop.watch.poll" as const, id: "p", watchId: w.watch.id },
        { type: "loop.watch.delete" as const, id: "d", watchId: w.watch.id },
        { type: "loop.watch.update" as const, id: "u", watchId: w.watch.id, enabled: false },
      ]) {
        const res = await manager.handle(msg, other, client(other));
        expect(res.type === "response.error" && res.code).toBe("not_found");
      }
      const list = await manager.handle({ type: "loop.watch.list", id: "l" }, other, client(other));
      expect(list.type === "loop.watch.list.result" && list.watches).toEqual([]);
    }
    expect(ghCalls.some((c) => c.join(" ").includes("check-runs"))).toBe(false);
  });

  test("a delegated token can't create, change, enable, or poll — but can disable and delete", async () => {
    start([]);
    const delegated = { ...AUTH, delegationDepth: 1 };
    const forbidden = async (msg: ClientMessage) => {
      const res = await manager.handle(msg, delegated, client(delegated));
      expect(res.type === "response.error" && res.code).toBe("forbidden");
    };
    await forbidden(createMsg());
    const w = wsnap(await manager.handle(createMsg(), AUTH, client(AUTH)));
    await forbidden({ type: "loop.watch.poll", id: "p", watchId: w.watch.id });
    await forbidden({ type: "loop.watch.update", id: "u", watchId: w.watch.id, enabled: true });
    await forbidden({ type: "loop.watch.update", id: "u", watchId: w.watch.id, spec: { maxRunsPerHour: 60 } });
    await forbidden({ type: "loop.watch.update", id: "u", watchId: w.watch.id, enabled: false, spec: { maxRunsPerHour: 60 } });
    // Vouching for a head is standing trust, not a stop, even alongside one.
    await forbidden({ type: "loop.watch.update", id: "u", watchId: w.watch.id, enabled: false, trustHead: true });
    await forbidden({ type: "loop.watch.update", id: "u", watchId: w.watch.id, enabled: false, trustHead: { main: "0123456789abcdef0123456789abcdef01234567" } });
    await forbidden({ ...createMsg(), trustHead: true });
    const off = wsnap(await manager.handle({ type: "loop.watch.update", id: "u", watchId: w.watch.id, enabled: false }, delegated, client(delegated)));
    expect(off.watch.enabled).toBe(false);
    const gone = await manager.handle({ type: "loop.watch.delete", id: "d", watchId: w.watch.id }, delegated, client(delegated));
    expect(gone.type).toBe("response.ok");
  });

  test("the loop scopes: create needs session:approve; everything needs session:create and session:send", async () => {
    start([]);
    const noApprove = { ...AUTH, scopes: ALL_SCOPES.filter((s) => s !== SCOPES.SESSION_APPROVE) as AuthContext["scopes"] };
    const res = await manager.handle(createMsg(), noApprove, client(noApprove));
    expect(res.type === "response.error" && res.error).toContain("session:approve");
    const watcher = { ...AUTH, scopes: [SCOPES.SESSION_LIST, SCOPES.SESSION_ATTACH] as AuthContext["scopes"] };
    const list = await manager.handle({ type: "loop.watch.list", id: "l" }, watcher, client(watcher));
    expect(list.type === "response.error" && list.code).toBe("forbidden");
  });

  test("watches are one person's: another user can't add one to this daemon", async () => {
    start([]);
    wsnap(await manager.handle(createMsg(), AUTH, client(AUTH)));
    const other = { ...AUTH, sub: "user:other" };
    const res = await manager.handle(createMsg(), other, client(other));
    expect(res.type === "response.error" && res.code).toBe("forbidden");
    expect(res.type === "response.error" && res.error).toContain("gh login");
  });

  test("a backend that can't carry a loop worker is refused", async () => {
    start([]);
    const res = await manager.handle({ ...createMsg(), spec: { ...createMsg().spec, provider: "gemini-cli" } }, AUTH, client(AUTH));
    expect(res.type === "response.error" && res.error).toContain("Loops run on");
  });
});
