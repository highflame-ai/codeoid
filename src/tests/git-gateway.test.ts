/**
 * The git gateway (docs/git-gateway-design.md) against real git: an agent's own `git clone`, `git fetch` and
 * `git push`, through `ext::` and the session's socket, reach a local bare "upstream" (file://, a test-only allowance:
 * a real remote is ssh or https). What is refused is said to the agent's git, and nothing refused reaches the upstream.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GatewayHost, type GatewayPush, GitGateway } from "../daemon/git-gateway/gateway.js";
import { refUpdateProblem } from "../daemon/git-gateway/policy.js";
import { configEnv } from "../daemon/git-gateway/upstream.js";

let root: string;
let upstream: string;
let gw: GitGateway;
let approvals: GatewayPush[];
let reports: Array<{ kind: string; ok: boolean; detail: string }>;
let answer: { ok: true } | { refused: string };
let grantFor: (url: string) => boolean;
let agentBranches: Set<string>;
let approveDelayMs: number;
let lastSignal: AbortSignal | undefined;

const URL = "git@bitbucket.example:team/repo.git";
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const plain = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1", ...ID } }).trim();

/** The agent's git: the session's env as the sandbox spec gives it (the remote's URL goes through the gateway). */
async function agent(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const s = gw.forSession("s1");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "agent-home"),
    GIT_CONFIG_NOSYSTEM: "1",
    ...ID,
    CODEOID_GIT_GATEWAY: s.socket,
    ...configEnv([
      ["protocol.ext.allow", "always"],
      [`url.ext::${s.ext} %S ${URL}.insteadOf`, URL],
    ]),
  };
  // Not spawnSync: the gateway serves from this process's event loop.
  const p = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: `${out}${err}` };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-gw-")));
  mkdirSync(join(root, "agent-home"));
  upstream = join(root, "upstream.git");
  plain(root, "init", "-q", "--bare", "-b", "main", upstream);
  const seed = join(root, "seed");
  plain(root, "clone", "-q", upstream, seed);
  writeFileSync(join(seed, "a.txt"), "a\n");
  plain(seed, "add", ".");
  plain(seed, "commit", "-q", "-m", "first");
  plain(seed, "push", "-q", "origin", "main");
  approvals = [];
  reports = [];
  answer = { ok: true };
  grantFor = (u) => u === URL;
  agentBranches = new Set();
  approveDelayMs = 0;
  lastSignal = undefined;
  const host: GatewayHost = {
    grant: async (_s, _svc, url) =>
      grantFor(url)
        ? { upstream: { url: `file://${upstream}`, kind: "ssh", testFile: true }, ssh: null, protectedBranches: ["main", "master"], agentBranches, cacheKey: `u:${url}` }
        : { refused: `${url} isn't connected: the owner can run \`codeoid sandbox git connect\`` },
    approve: async (_s, push, signal) => {
      approvals.push(push);
      if (approveDelayMs > 0) await new Promise((r) => setTimeout(r, approveDelayMs));
      lastSignal = signal;
      return answer;
    },
    report: (_s, e) => {
      reports.push({ kind: e.kind, ok: e.ok, detail: e.detail });
      // As the manager does: a branch an agent made is one it may move again.
      if (e.ok && e.kind === "push") for (const u of e.updates ?? []) if (/^0+$/.test(u.old)) agentBranches.add(u.ref.replace(/^refs\/heads\//, ""));
    },
  };
  gw = new GitGateway({ base: join(root, "gw"), host });
});
afterEach(async () => {
  await gw.close();
  rmSync(root, { recursive: true, force: true });
});

const clone = async () => {
  const work = join(root, "work");
  const r = await agent(root, "clone", "-q", URL, work);
  expect(r).toMatchObject({ code: 0 });
  return work;
};
const commit = async (work: string, name: string) => {
  writeFileSync(join(work, `${name}.txt`), `${name}\n`);
  await agent(work, "add", ".");
  expect((await agent(work, "commit", "-q", "-m", name)).code).toBe(0);
  return plain(work, "rev-parse", "HEAD");
};
const upstreamRef = (ref: string) => spawnSync("git", ["-C", upstream, "rev-parse", "--verify", "-q", ref], { encoding: "utf8" }).stdout.trim();

describe("the git gateway", () => {
  test("clone and fetch through the gateway; a push to a branch of its own reaches the upstream, after the session's word", async () => {
    const work = await clone();
    expect(plain(work, "log", "--format=%s")).toBe("first");
    await agent(work, "checkout", "-q", "-b", "feature/x");
    const sha = await commit(work, "b");
    const r = await agent(work, "push", "origin", "feature/x");
    expect(r.code).toBe(0);
    expect(r.out).toContain("codeoid pushed feature/x");
    expect(upstreamRef("refs/heads/feature/x")).toBe(sha);
    expect(approvals).toEqual([{ url: URL, updates: [{ old: "0".repeat(40), new: sha, ref: "refs/heads/feature/x" }], defaultBranch: "main" }]);
    // A fast-forward of its own branch.
    const sha2 = await commit(work, "c");
    expect((await agent(work, "push", "origin", "feature/x")).code).toBe(0);
    expect(upstreamRef("refs/heads/feature/x")).toBe(sha2);
    // Someone else's commit upstream, then a fetch shows it.
    const other = join(root, "other");
    plain(root, "clone", "-q", upstream, other);
    plain(other, "checkout", "-q", "-b", "theirs");
    writeFileSync(join(other, "z.txt"), "z\n");
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "z");
    plain(other, "push", "-q", "origin", "theirs");
    expect((await agent(work, "fetch", "-q", "origin")).code).toBe(0);
    expect(plain(work, "rev-parse", "origin/theirs")).toBe(plain(other, "rev-parse", "HEAD"));
    expect(reports.filter((e) => e.kind === "push" && e.ok)).toHaveLength(2);
  });

  test("main, the default branch, a delete, a tag, a force push: refused, said to the agent's git, and the upstream unchanged", async () => {
    const work = await clone();
    const before = upstreamRef("refs/heads/main");
    await commit(work, "m");
    const main = await agent(work, "push", "origin", "main");
    expect(main.code).not.toBe(0);
    expect(main.out).toContain("main is a protected branch");
    expect(upstreamRef("refs/heads/main")).toBe(before);
    // The remote's default branch, whatever its name.
    plain(upstream, "symbolic-ref", "HEAD", "refs/heads/trunk");
    plain(upstream, "branch", "trunk", "main");
    await agent(work, "fetch", "-q", "origin");
    await agent(work, "checkout", "-q", "-B", "trunk", "origin/trunk");
    await commit(work, "t");
    expect((await agent(work, "push", "origin", "trunk")).out).toContain("the remote's default branch");
    // A tag.
    await agent(work, "tag", "v1");
    expect((await agent(work, "push", "origin", "v1")).out).toContain("only branches are pushed");
    expect(upstreamRef("refs/tags/v1")).toBe("");
    // A delete, and a force push, of a branch that is there.
    await agent(work, "checkout", "-q", "-b", "feature/y", "origin/main");
    const y = await commit(work, "y");
    expect((await agent(work, "push", "origin", "feature/y")).code).toBe(0);
    const del = await agent(work, "push", "origin", "--delete", "feature/y");
    expect(del.code).not.toBe(0);
    expect(upstreamRef("refs/heads/feature/y")).toBe(y);
    await agent(work, "reset", "-q", "--hard", "origin/main");
    await commit(work, "rewritten");
    const force = await agent(work, "push", "--force", "origin", "feature/y");
    expect(force.code).not.toBe(0);
    expect(force.out).toContain("a force push isn't done for agents");
    expect(upstreamRef("refs/heads/feature/y")).toBe(y);
  });

  test("the session's no, and a remote that isn't connected, stop it, saying why", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "feature/n");
    await commit(work, "n");
    answer = { refused: "the owner declined" };
    const r = await agent(work, "push", "origin", "feature/n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("the owner declined");
    expect(upstreamRef("refs/heads/feature/n")).toBe("");
    grantFor = () => false;
    const f = await agent(work, "fetch", "origin");
    expect(f.code).not.toBe(0);
    expect(f.out).toContain("isn't connected");
  });

  test("round 1 (gateway): a symref upstream, someone else's branch, an empty remote: refused; the upstream unchanged", async () => {
    const work = await clone();
    // upstream `latest` -> `main`: a push to latest would move main.
    plain(upstream, "symbolic-ref", "refs/heads/latest", "refs/heads/main");
    const mainBefore = upstreamRef("refs/heads/main");
    await commit(work, "s");
    const sym = await agent(work, "push", "origin", "HEAD:refs/heads/latest");
    expect(sym.code).not.toBe(0);
    expect(sym.out).toContain("symbolic ref");
    expect(upstreamRef("refs/heads/main")).toBe(mainBefore);
    // A branch on the remote no agent made (a teammate's): refused, even as a fast-forward.
    plain(upstream, "branch", "develop", "main");
    const dev = await agent(work, "push", "origin", "HEAD:refs/heads/develop");
    expect(dev.code).not.toBe(0);
    expect(dev.out).toContain("wasn't made by an agent");
    expect(upstreamRef("refs/heads/develop")).toBe(mainBefore);
  });

  test("round 1 (gateway): the agent's git gone before the owner's yes: nothing is pushed, and the session's card is told", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "feature/late");
    await commit(work, "l");
    approveDelayMs = 1500;
    const s = gw.forSession("s1");
    const env = { PATH: process.env.PATH ?? "", HOME: join(root, "agent-home"), GIT_CONFIG_NOSYSTEM: "1", ...ID, CODEOID_GIT_GATEWAY: s.socket, ...configEnv([["protocol.ext.allow", "always"], [`url.ext::${s.ext} %S ${URL}.insteadOf`, URL]]) };
    const p = Bun.spawn(["git", "push", "origin", "feature/late"], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    await new Promise((r) => setTimeout(r, 400));
    p.kill("SIGKILL");
    await p.exited;
    await new Promise((r) => setTimeout(r, 2500));
    expect(lastSignal?.aborted).toBe(true);
    expect(upstreamRef("refs/heads/feature/late")).toBe("");
    expect(reports.some((e) => e.kind === "push" && e.ok)).toBe(false);
  });

  test("round 1 (gateway): an empty remote takes no push from an agent (its first branch may become its default)", async () => {
    plain(root, "init", "-q", "--bare", "-b", "main", join(root, "empty.git"));
    rmSync(upstream, { recursive: true, force: true });
    plain(root, "clone", "-q", "--bare", join(root, "empty.git"), upstream);
    const work = join(root, "w-empty");
    mkdirSync(work);
    plain(work, "init", "-q", "-b", "feature/first");
    writeFileSync(join(work, "f.txt"), "f\n");
    plain(work, "add", ".");
    plain(work, "commit", "-q", "-m", "f");
    plain(work, "remote", "add", "origin", URL);
    const r = await agent(work, "push", "origin", "feature/first");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("empty repository");
  });

  test("the policy alone: only plain branch updates that fast-forward", async () => {
    const z = "0".repeat(40);
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const p = { protectedBranches: ["main", "release/*"], defaultBranch: "develop", defaultKnown: true, symrefs: new Set(["refs/heads/latest"]), agentBranches: new Set(["x", "mine"]) };
    const ff = async () => true;
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/feature/x" }, p, ff)).toBeNull();
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/Release/1" }, p, ff)).toContain("protected");
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/DEVELOP" }, p, ff)).toContain("default branch");
    expect(await refUpdateProblem({ old: a, new: z, ref: "refs/heads/x" }, p, ff)).toContain("deleting");
    expect(await refUpdateProblem({ old: a, new: b, ref: "refs/heads/x" }, p, async () => false)).toContain("force push");
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/notes/x" }, p, ff)).toContain("only branches");
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/ma​in" }, p, ff)).toContain("plain branch name");
    expect(await refUpdateProblem({ old: "x", new: a, ref: "refs/heads/x" }, p, ff)).toContain("not an update");
    // Round 1 (gateway): a symref, HEAD, someone else's branch, an unknown default.
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/latest" }, p, ff)).toContain("symbolic ref");
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/HEAD" }, p, ff)).toContain("HEAD isn't a branch");
    expect(await refUpdateProblem({ old: a, new: b, ref: "refs/heads/teammate" }, p, ff)).toContain("wasn't made by an agent");
    expect(await refUpdateProblem({ old: a, new: b, ref: "refs/heads/mine" }, p, ff)).toBeNull();
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/new" }, { ...p, defaultKnown: false }, ff)).toContain("couldn't ask the remote");
  });
});
