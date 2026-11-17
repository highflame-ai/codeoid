/**
 * The git gateway (docs/git-gateway-design.md) against real git: an agent's own `git clone`, `git fetch` and
 * `git push`, through `ext::` and the session's socket, reach a local bare "upstream" (file://, a test-only allowance:
 * a real remote is ssh or https). What is refused is said to the agent's git, and nothing refused reaches the upstream.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
let agentBranches: Map<string, string>;
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
  agentBranches = new Map();
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
      if (e.ok && e.kind === "push") for (const u of e.updates ?? []) agentBranches.set(u.ref.replace(/^refs\/heads\//, ""), u.new);
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

  test("round 2 (gateway): a client claiming an existing branch is new (a hidden advertisement) is refused; nothing moves", async () => {
    const work = await clone();
    plain(upstream, "branch", "release", "main");
    const before = upstreamRef("refs/heads/release");
    await agent(work, "fetch", "-q", "origin");
    await agent(work, "checkout", "-q", "-B", "rel", "origin/release");
    await commit(work, "r");
    // An agent-side wrapper around the launcher that drops refs/heads/release from the advertisement.
    const s = gw.forSession("s1");
    const filter = join(root, "filter.cjs");
    writeFileSync(
      filter,
      `const { spawn } = require("node:child_process");
const [service, url] = process.argv.slice(2);
const p = spawn(${JSON.stringify(s.ext)}, [service, url], { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(p.stdin);
let buf = Buffer.alloc(0), adv = service === "git-receive-pack";
p.stdout.on("data", (d) => {
  if (!adv) return process.stdout.write(d);
  buf = Buffer.concat([buf, d]);
  while (adv && buf.length >= 4) {
    const n = parseInt(buf.subarray(0, 4).toString(), 16);
    if (n === 0) { process.stdout.write(buf.subarray(0, 4)); buf = buf.subarray(4); adv = false; break; }
    if (buf.length < n) return;
    const line = buf.subarray(0, n); buf = buf.subarray(n);
    if (!line.toString("latin1").includes(" refs/heads/release")) process.stdout.write(line);
  }
  if (!adv && buf.length) { process.stdout.write(buf); buf = Buffer.alloc(0); }
});
p.stdout.on("end", () => process.stdout.end());
p.on("exit", (c) => (process.exitCode = c ?? 1));
`,
    );
    const env = { PATH: process.env.PATH ?? "", HOME: join(root, "agent-home"), GIT_CONFIG_NOSYSTEM: "1", ...ID, CODEOID_GIT_GATEWAY: s.socket, ...configEnv([["protocol.ext.allow", "always"], [`url.ext::${process.execPath} ${filter} %S ${URL}.insteadOf`, URL]]) };
    const p = Bun.spawn(["git", "push", "origin", "HEAD:refs/heads/release"], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).not.toBe(0);
    expect(out + err).toContain("isn't what it has");
    expect(upstreamRef("refs/heads/release")).toBe(before);
    expect(agentBranches.has("release")).toBe(false);
  });

  test("round 2 (gateway): a delete is refused as one; a remote with an unborn HEAD but branches takes no push; a broken cache is made again", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "feature/d");
    await commit(work, "d");
    expect((await agent(work, "push", "origin", "feature/d")).code).toBe(0);
    const del = await agent(work, "push", "origin", "--delete", "feature/d");
    expect(del.out).toContain("deleting a branch isn't done for agents");
    expect(reports.some((e) => e.kind === "push" && !e.ok && e.detail.includes("deleting"))).toBe(true);
    // The remote's HEAD names a branch it doesn't have (renamed away), and it has others.
    plain(upstream, "symbolic-ref", "HEAD", "refs/heads/gone");
    await commit(work, "e");
    const unborn = await agent(work, "push", "origin", "HEAD:refs/heads/new-one");
    expect(unborn.code).not.toBe(0);
    expect(unborn.out).toContain("couldn't ask the remote which branch is its default");
    plain(upstream, "symbolic-ref", "HEAD", "refs/heads/main");
    // A cache dir that isn't a repository (a clone cut short): removed and cloned again, never walked up from.
    const cache = gw.cachePath(`u:${URL}`);
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(join(cache, "objects"), { recursive: true });
    writeFileSync(join(cache, "config"), "");
    expect((await agent(work, "fetch", "-q", "origin")).code).toBe(0);
  });

  test("round 2 (gateway): a URL with a password or a query can't be connected, and is shown whole otherwise", async () => {
    const { remoteUrlProblem, shownGitUrl } = await import("../daemon/git-gateway/text.js");
    expect(remoteUrlProblem("https://x-access-token:ghp_FAKE@github.com/o/r.git")).toContain("password");
    expect(remoteUrlProblem("https://github.com/o/r.git?tok=1")).toContain("query");
    expect(remoteUrlProblem("https://github.com/acme/infrastructure-terraform-prod.git")).toBeNull();
    expect(shownGitUrl("https://github.com/acme/infrastructure-terraform-prod.git")).toBe("https://github.com/acme/infrastructure-terraform-prod.git");
    expect(shownGitUrl("https://u:secret@h/x.git")).not.toContain("secret");
    expect(shownGitUrl("git@h:o/r\u202e.git")).toContain("\\u{202e}");
  });

  test("round 3 (gateway): a ref name a refspec would read as two (q:refs/heads/main) and the other names git refuses: refused", async () => {
    const { validBranchRef } = await import("../daemon/git-gateway/policy.js");
    const z = "0".repeat(40);
    const a = "a".repeat(40);
    const p = { protectedBranches: ["main"], defaultBranch: "main", defaultKnown: true, symrefs: new Set<string>(), agentBranches: new Map<string, string>() };
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/q:refs/heads/main" }, p, async () => true)).toContain("isn't a plain branch name");
    for (const bad of ["q:x", "a..b", "x@{1}", "x^", "x~1", "x?", "x*", "x[1]", "a\\b", "/x", "x/", "a//b", ".x", "x.lock", "x.", "@", "a/.b"]) expect([bad, validBranchRef(bad)]).toEqual([bad, false]);
    for (const good of ["feature/x", "fix-1.2", "agent/ü", "release/2026.11"]) expect([good, validBranchRef(good)]).toEqual([good, true]);
    const { remoteUrlProblem, shownGitUrl } = await import("../daemon/git-gateway/text.js");
    expect(remoteUrlProblem("https://ghp_FAKE@github.com/o/r.git")).toContain("user name");
    expect(remoteUrlProblem("ssh://git@host/x=y.git")).toContain("=");
    expect(remoteUrlProblem("git@github.com:o/r.git")).toBeNull();
    expect(shownGitUrl("https://ghp_FAKE@github.com/o/r.git")).not.toContain("ghp_FAKE");
  });

  test("round 4 (gateway): what the card shows is what git reaches; a command with a line feed in its ref is refused; routes and spaces", async () => {
    const { remoteUrlProblem } = await import("../daemon/git-gateway/text.js");
    expect(remoteUrlProblem("https://github.com/myorg/sandbox-play/../../myorg/infra.git")).toContain("path segment");
    expect(remoteUrlProblem("git@github.com:myorg/./x.git")).toContain("path segment");
    expect(remoteUrlProblem("https://github.com/myorg/%2e%2e/infra.git")).toContain("%");
    expect(remoteUrlProblem(`https://github.com/${"a/".repeat(160)}x.git`)).toContain("longer");
    expect(remoteUrlProblem("git@github.com:myorg/app.git")).toBeNull();
    const { CommandReader } = await import("../daemon/git-gateway/gateway.js");
    const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
    const z = "0".repeat(40);
    const a = "a".repeat(40);
    const good = new CommandReader();
    expect(good.ok(Buffer.from(`${pkt(`${z} ${a} refs/heads/x\0report-status\n`) + pkt(`${z} ${a} refs/heads/y\n`)}0000`))).toBe(true);
    const split = new CommandReader();
    expect(split.ok(Buffer.from(pkt(`${z} ${a} refs/heads/a\n${z} ${a} refs/heads/b\0report-status\n`)))).toBe(false);
    expect(new CommandReader().ok(Buffer.from(pkt("push-cert\0report-status\n")))).toBe(false);
    const { gitGatewayEnv } = await import("../daemon/sandbox/policy.js");
    const env = gitGatewayEnv({ socket: "/s", ext: "/home/Jane Doe/gw/codeoid-git-ext", binDir: "/b", runtime: "/r", urls: ["git@github.com:o/r.git"], routes: [{ from: "https://github.com/o/r.git", fetch: "git@github.com:o/r.git", push: "git@github.com:o/r.git" }] });
    expect(env.GIT_CONFIG_PARAMETERS).toContain("'url.ext::/home/Jane% Doe/gw/codeoid-git-ext %S git@github.com:o/r.git.insteadOf=https://github.com/o/r.git'");
    // Round 5: a push rewrite of the owner's own (pushInsteadOf) is routed for pushes, the public fetch left direct.
    const pushOnly = gitGatewayEnv({ socket: "/s", ext: "/gw/ext", binDir: "/b", runtime: "/r", urls: [], routes: [{ from: "https://github.com/o/app", push: "git@github.com:o/app" }] });
    expect(pushOnly.GIT_CONFIG_PARAMETERS).toContain("%S git@github.com:o/app.pushInsteadOf=https://github.com/o/app'");
    expect(pushOnly.GIT_CONFIG_PARAMETERS).not.toContain(".insteadOf=https://github.com/o/app'");
    // Round 5: a ref with a space, or bytes that aren't UTF-8, never reaches git.
    expect(new CommandReader().ok(Buffer.from(pkt(`${z} ${a} refs/heads/ok refs/heads/main\0report-status\n`)))).toBe(false);
    expect(new CommandReader().ok(Buffer.concat([Buffer.from(`00${(4 + 82 + 18).toString(16)}${z} ${a} refs/heads/topic-`), Buffer.from([0xff]), Buffer.from("\0report-status\n")]))).toBe(false);
    // Round 5: a session whose writable dirs hold the owner's git config gets nothing of it.
    const { ownerConfigProblem } = await import("../daemon/git-gateway/connect.js");
    expect(ownerConfigProblem([homedir()])).toContain(".gitconfig");
    expect(ownerConfigProblem(["/srv/work"])).toBeNull();
  });

  test("round 5 (gateway): an agent's branch deleted and made again by someone else isn't the agent's", async () => {
    const z = "0".repeat(40);
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const c = "c".repeat(40);
    const p = { protectedBranches: ["main"], defaultBranch: "main", defaultKnown: true, symrefs: new Set<string>(), agentBranches: new Map([["feature/x", a]]) };
    // The remote's tip is the agent's (or descends from it): its own.
    expect(await refUpdateProblem({ old: a, new: b, ref: "refs/heads/feature/x" }, p, async () => true)).toBeNull();
    // Someone else's branch of that name now (its tip doesn't descend from what the agent pushed).
    expect(await refUpdateProblem({ old: c, new: b, ref: "refs/heads/feature/x" }, p, async (old) => old !== a)).toContain("wasn't made by an agent");
    expect(await refUpdateProblem({ old: z, new: b, ref: "refs/heads/feature/y" }, p, async () => true)).toBeNull();
  });

  test("round 6 (gateway): dotfiles linked or included from a workspace: the owner's config is judged where it really is, and held read-only", async () => {
    const { ownerConfigProblem } = await import("../daemon/git-gateway/connect.js");
    const { buildSandboxSpec } = await import("../daemon/sandbox/policy.js");
    const { ownerConfigFiles } = await import("../daemon/git-gateway/connect.js");
    const home = join(root, "home");
    const dots = join(home, "dotfiles");
    mkdirSync(join(dots, "ssh"), { recursive: true });
    const saved = process.env.HOME;
    process.env.HOME = home;
    process.env.CODEOID_TEST_SSH_HOME = home;
    const fresh = async () => {
      // The files' cache is a few seconds: wait it out between layouts.
      await new Promise((r) => setTimeout(r, 5_100));
    };
    try {
      // ~/.gitconfig a link into the dotfiles repository.
      writeFileSync(join(dots, "gitconfig"), "[user]\n\tname = t\n");
      symlinkSync(join(dots, "gitconfig"), join(home, ".gitconfig"));
      expect(ownerConfigProblem([dots])).toContain("gitconfig");
      // The spec for a session working there holds the link's target read-only.
      const spec = buildSandboxSpec({ sessionId: "dots", workspace: dots, tempDir: join(root, "t"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, cache: false, ownerConfigFiles: ownerConfigFiles() });
      expect(spec.readOnly).toContain(realpathSync(join(dots, "gitconfig")));
      await fresh();
      // A plain ~/.gitconfig including a file there; and ~/.ssh/config including one there.
      rmSync(join(home, ".gitconfig"));
      writeFileSync(join(dots, "extra"), "[user]\n\tname = t\n");
      writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ${join(dots, "extra")}\n`);
      expect(ownerConfigProblem([dots])).toContain("extra");
      await fresh();
      writeFileSync(join(home, ".gitconfig"), "");
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(dots, "ssh", "work.conf"), "Host w\n");
      writeFileSync(join(home, ".ssh", "config"), `Include ${join(dots, "ssh")}/*.conf\n`);
      expect(ownerConfigProblem([dots])).toMatch(/dotfiles\/ssh/);
      expect(ownerConfigProblem([join(root, "elsewhere")])).toBeNull();
    } finally {
      process.env.HOME = saved;
      delete process.env.CODEOID_TEST_SSH_HOME;
    }
  }, 30_000);

  test("the policy alone: only plain branch updates that fast-forward", async () => {
    const z = "0".repeat(40);
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const p = { protectedBranches: ["main", "release/*"], defaultBranch: "develop", defaultKnown: true, symrefs: new Set(["refs/heads/latest"]), agentBranches: new Map([["x", "a".repeat(40)], ["mine", "a".repeat(40)]]) };
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
