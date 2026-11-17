/**
 * The git gateway (docs/git-gateway-design.md) against real git: an agent's own `git clone`, `git fetch` and
 * `git push`, through `ext::` and the session's socket, reach a local bare "upstream" (file://, a test-only allowance:
 * a real remote is ssh or https). What is refused is said to the agent's git, and nothing refused reaches the upstream.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { type GatewayHost, type GatewayPush, GitGateway } from "../daemon/git-gateway/gateway.js";
import { refUpdateProblem } from "../daemon/git-gateway/policy.js";
import { cacheDirty, configEnv, pruneCache, rememberRefs } from "../daemon/git-gateway/upstream.js";

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
    expect(unborn.out).toContain("didn't say which branch is its default");
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
    // Round 28: a lookalike letter (Cyrillic а) in the path.
    expect(remoteUrlProblem("https://github.com/acme/\u0430pp.git")).toContain("printable ASCII");
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
    const { warmOwnerConfig } = await import("../daemon/git-gateway/connect.js");
    const fresh = async () => {
      // The files are read again (asynchronously, as the daemon does before building a spec) between layouts.
      await warmOwnerConfig();
    };
    try {
      // ~/.gitconfig a link into the dotfiles repository.
      writeFileSync(join(dots, "gitconfig"), "[user]\n\tname = t\n");
      symlinkSync(join(dots, "gitconfig"), join(home, ".gitconfig"));
      expect(ownerConfigProblem([dots])).toContain("gitconfig");
      // The spec for a session working there holds the link's target read-only.
      const spec = buildSandboxSpec({ sessionId: "dots", workspace: dots, tempDir: join(root, "t"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, cache: false, ownerConfigFiles: ownerConfigFiles() });
      expect(spec.readOnly).toContain(realpathSync(join(dots, "gitconfig")));
      // A plain ~/.gitconfig including a file there; and ~/.ssh/config including one there.
      rmSync(join(home, ".gitconfig"));
      writeFileSync(join(dots, "extra"), "[user]\n\tname = t\n");
      writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ${join(dots, "extra")}\n`);
      await fresh();
      expect(ownerConfigProblem([dots])).toContain("extra");
      writeFileSync(join(home, ".gitconfig"), "");
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(dots, "ssh", "work.conf"), "Host w\n");
      writeFileSync(join(home, ".ssh", "config"), `Include ${join(dots, "ssh")}/*.conf\n`);
      await fresh();
      expect(ownerConfigProblem([dots])).toMatch(/dotfiles\/ssh/);
      expect(ownerConfigProblem([join(root, "elsewhere")])).toBeNull();
    } finally {
      process.env.HOME = saved;
      delete process.env.CODEOID_TEST_SSH_HOME;
    }
  }, 30_000);

  test("round 12: a push naming an object the cache kept after the remote deleted it is refused (it never comes back)", async () => {
    // The remote had a branch with a secret; the agent's fetch brought it into the cache; then the owner purged it.
    const other = join(root, "other");
    plain(root, "clone", "-q", upstream, other);
    plain(other, "checkout", "-q", "-b", "oops");
    writeFileSync(join(other, "secret.txt"), "TOPSECRET\n");
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "oops");
    plain(other, "push", "-q", "origin", "oops");
    const secret = plain(other, "rev-parse", "HEAD");
    expect((await agent(root, "ls-remote", URL)).out).toContain(secret);
    plain(upstream, "branch", "-D", "oops");
    plain(upstream, "reflog", "expire", "--expire=now", "--all");
    plain(upstream, "gc", "-q", "--prune=now");
    expect(spawnSync("git", ["-C", upstream, "cat-file", "-e", secret]).status).not.toBe(0);
    // A raw receive-pack request through the launcher, as git's ext:: would run it: the command names the purged
    // commit, and the pack is empty (the agent never had its objects).
    const s = gw.forSession("s1");
    const p = Bun.spawn([s.ext, "git-receive-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let got = Buffer.alloc(0);
    while (!got.toString("latin1").endsWith("0000")) {
      const { value, done } = await reader.read();
      if (done) break;
      got = Buffer.concat([got, Buffer.from(value)]);
    }
    const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
    const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
    const pack = Buffer.concat([header, createHash("sha1").update(header).digest()]);
    p.stdin.write(`${pkt(`${"0".repeat(40)} ${secret} refs/heads/x\0report-status\n`)}0000`);
    p.stdin.write(pack);
    p.stdin.end();
    let reply = got.toString("latin1");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      reply += Buffer.from(value).toString("latin1");
    }
    await p.exited;
    expect(upstreamRef("refs/heads/x")).toBe("");
    expect(spawnSync("git", ["-C", upstream, "cat-file", "-e", secret]).status).not.toBe(0);
    expect(reply).not.toContain("ok refs/heads/x");
    // Round 15: the refresh saw the purge, so the cache dropped the object before serving (nothing to name, probe or
    // build on).
    expect(spawnSync("git", ["-C", gw.cachePath(`u:${URL}`), "cat-file", "-e", secret]).status).not.toBe(0);
    // An ordinary push (its objects sent) still goes.
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "fine");
    const sha = await commit(work, "fine");
    expect((await agent(work, "push", "origin", "fine")).code).toBe(0);
    expect(upstreamRef("refs/heads/fine")).toBe(sha);
  });

  test("round 13: a push that restores an older file content (its blob the remote has) goes, from a plain clone and from one with a bitmap", async () => {
    // The remote: f = A, then f = B, then more.
    const seed = join(root, "seed");
    writeFileSync(join(seed, "f.txt"), "A\n");
    plain(seed, "add", ".");
    plain(seed, "commit", "-q", "-m", "fA");
    writeFileSync(join(seed, "f.txt"), "B\n");
    plain(seed, "commit", "-qam", "fB");
    writeFileSync(join(seed, "g.txt"), "g\n");
    plain(seed, "add", ".");
    plain(seed, "commit", "-q", "-m", "g");
    plain(seed, "push", "-q", "origin", "main");
    const work = await clone();
    for (const [branch, bitmap] of [
      ["revert-plain", false],
      ["revert-bitmap", true],
    ] as const) {
      if (bitmap) plain(work, "repack", "-q", "-adb");
      await agent(work, "checkout", "-q", "-B", branch, "origin/main");
      writeFileSync(join(work, "f.txt"), "A\n");
      await agent(work, "commit", "-qam", `back to A (${branch})`);
      const sha = plain(work, "rev-parse", "HEAD");
      const r = await agent(work, "push", "origin", branch);
      expect([branch, r.code]).toEqual([branch, 0]);
      expect(upstreamRef(`refs/heads/${branch}`)).toBe(sha);
    }
  });

  test("round 14: a hand-made thin pack whose delta base is an object the remote deleted is refused (nothing built on it goes out)", async () => {
    const other = join(root, "other");
    plain(root, "clone", "-q", upstream, other);
    plain(other, "checkout", "-q", "-b", "oops");
    const secretText = `${"TOPSECRET line\n".repeat(200)}`;
    writeFileSync(join(other, "secret.txt"), secretText);
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "oops");
    plain(other, "push", "-q", "origin", "oops");
    const purgedBlob = plain(other, "rev-parse", "HEAD:secret.txt");
    // The agent's fetch brings it into the cache; then the owner purges it.
    expect((await agent(root, "ls-remote", URL)).code).toBe(0);
    plain(upstream, "branch", "-D", "oops");
    plain(upstream, "reflog", "expire", "--expire=now", "--all");
    plain(upstream, "gc", "-q", "--prune=now");
    // A commit on main whose secret.txt is the purged blob plus a line: its blob sent as a REF_DELTA on the purged one
    // (copy all of it, add a line), as an agent that knows only the id could send it.
    plain(other, "checkout", "-q", "-B", "derived", "origin/main");
    writeFileSync(join(other, "secret.txt"), `${secretText}x\n`);
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "derived");
    const tip = plain(other, "rev-parse", "HEAD");
    const tree = plain(other, "rev-parse", "HEAD^{tree}");
    const raw = (id: string, type: string) => execFileSync("git", ["-C", other, "cat-file", type, id]);
    const header = (type: number, size: number) => {
      const out = [((type << 4) | (size & 0x0f)) | (size > 0x0f ? 0x80 : 0)];
      let n = size >> 4;
      while (n > 0) {
        out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
        n >>= 7;
      }
      return Buffer.from(out);
    };
    const varint = (value: number) => {
      const out: number[] = [];
      let v = value;
      do {
        out.push((v & 0x7f) | (v > 0x7f ? 0x80 : 0));
        v >>= 7;
      } while (v > 0);
      return Buffer.from(out);
    };
    const src = Buffer.byteLength(secretText);
    const delta = Buffer.concat([varint(src), varint(src + 2), Buffer.from([0x80 | 0x10 | 0x20, src & 0xff, (src >> 8) & 0xff]), Buffer.from([2]), Buffer.from("x\n")]);
    const entries = [
      Buffer.concat([header(1, raw(tip, "commit").length), deflateSync(raw(tip, "commit"))]),
      Buffer.concat([header(2, raw(tree, "tree").length), deflateSync(raw(tree, "tree"))]),
      Buffer.concat([header(7, delta.length), Buffer.from(purgedBlob, "hex"), deflateSync(delta)]),
    ];
    const head = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, entries.length]);
    const body = Buffer.concat([head, ...entries]);
    const pack = Buffer.concat([body, createHash("sha1").update(body).digest()]);
    // It is thin: it doesn't stand on its own.
    const empty = join(root, "empty.git");
    plain(root, "init", "-q", "--bare", empty);
    expect(spawnSync("git", ["-C", empty, "index-pack", "--stdin"], { input: pack }).status).not.toBe(0);
    const s = gw.forSession("s1");
    const p = Bun.spawn([s.ext, "git-receive-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let got = "";
    while (!got.endsWith("0000")) {
      const { value, done } = await reader.read();
      if (done) break;
      got += Buffer.from(value).toString("latin1");
    }
    const pkt = (x: string) => `${(x.length + 4).toString(16).padStart(4, "0")}${x}`;
    p.stdin.write(`${pkt(`${"0".repeat(40)} ${tip} refs/heads/derived\0report-status\n`)}0000`);
    p.stdin.write(pack);
    p.stdin.end();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    await p.exited;
    expect(upstreamRef("refs/heads/derived")).toBe("");
    expect(spawnSync("git", ["-C", gw.cachePath(`u:${URL}`), "cat-file", "-e", purgedBlob]).status).not.toBe(0);
    // A thin push built on what the remote has still goes.
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "thin-ok");
    writeFileSync(join(work, "a.txt"), "a\nmore\n");
    await agent(work, "commit", "-qam", "thin ok");
    expect((await agent(work, "push", "origin", "thin-ok")).code).toBe(0);
  });

  test("round 15: a push connection opened before a purge can't publish the purged object after it (nor build on it)", async () => {
    const other = join(root, "other");
    plain(root, "clone", "-q", upstream, other);
    plain(other, "checkout", "-q", "-b", "oops");
    writeFileSync(join(other, "secret.txt"), `${"TOPSECRET line\n".repeat(200)}`);
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "oops");
    plain(other, "push", "-q", "origin", "oops");
    const secret = plain(other, "rev-parse", "HEAD");
    const purge = () => {
      plain(upstream, "branch", "-D", "oops");
      plain(upstream, "reflog", "expire", "--expire=now", "--all");
      plain(upstream, "gc", "-q", "--prune=now");
    };
    // The agent opens receive-pack while the branch is there (the refresh sees nothing deleted), then the owner
    // purges it, then the agent names it as a new branch's tip with an empty pack.
    const s = gw.forSession("s1");
    const p = Bun.spawn([s.ext, "git-receive-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let got = "";
    while (!got.endsWith("0000")) {
      const { value, done } = await reader.read();
      if (done) break;
      got += Buffer.from(value).toString("latin1");
    }
    expect(got).toContain(secret);
    purge();
    const pkt = (x: string) => `${(x.length + 4).toString(16).padStart(4, "0")}${x}`;
    const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
    p.stdin.write(`${pkt(`${"0".repeat(40)} ${secret} refs/heads/late\0report-status\n`)}0000`);
    p.stdin.write(Buffer.concat([header, createHash("sha1").update(header).digest()]));
    p.stdin.end();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    await p.exited;
    expect(upstreamRef("refs/heads/late")).toBe("");
    expect(spawnSync("git", ["-C", upstream, "cat-file", "-e", secret]).status).not.toBe(0);
    expect(reports.some((e) => e.kind === "push" && !e.ok && /the remote deleted/.test(e.detail))).toBe(true);
  });

  test("round 16: a ref the cache lost without a clean refresh still makes it dirty; the prune drops kept packs too", async () => {
    const other = join(root, "other");
    plain(root, "clone", "-q", upstream, other);
    plain(other, "checkout", "-q", "-b", "oops");
    writeFileSync(join(other, "secret.txt"), "TOPSECRET\n");
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "oops");
    plain(other, "push", "-q", "origin", "oops");
    const secret = plain(other, "rev-parse", "HEAD");
    expect((await agent(root, "ls-remote", URL)).code).toBe(0);
    const cache = gw.cachePath(`u:${URL}`);
    expect(await cacheDirty(cache)).toBe(false);
    // As a fetch that pruned and then failed (or was cut short) leaves it: the ref gone, its objects kept, in a kept pack.
    plain(cache, "repack", "-q", "-a", "-d");
    const pack = readdirSync(join(cache, "objects", "pack")).find((n) => n.endsWith(".pack"));
    writeFileSync(join(cache, "objects", "pack", (pack ?? "").replace(/\.pack$/, ".keep")), "");
    plain(cache, "update-ref", "-d", "refs/heads/oops");
    expect(await cacheDirty(cache)).toBe(true);
    expect(await pruneCache(cache)).toBe(true);
    expect(spawnSync("git", ["-C", cache, "cat-file", "-e", secret]).status).not.toBe(0);
    expect(await cacheDirty(cache)).toBe(false);
    // A branch deleted after it was merged (its commits on main) leaves nothing to prune.
    plain(other, "checkout", "-q", "-b", "merged", "origin/main");
    writeFileSync(join(other, "m.txt"), "m\n");
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "m");
    plain(other, "push", "-q", "origin", "merged", "merged:main");
    expect((await agent(root, "ls-remote", URL)).code).toBe(0);
    plain(upstream, "branch", "-D", "merged");
    expect((await agent(root, "ls-remote", URL)).code).toBe(0);
    expect(await cacheDirty(cache)).toBe(false);
  });

  test("round 16: a push whose card is answered after the remote's main moved on still goes", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "while-moving");
    const sha = await commit(work, "wm");
    // While the owner's card is up, someone pushes main forward.
    approveDelayMs = 1500;
    const pushing = agent(work, "push", "origin", "while-moving");
    await new Promise((r) => setTimeout(r, 500));
    const other = join(root, "mover");
    plain(root, "clone", "-q", upstream, other);
    writeFileSync(join(other, "moved.txt"), "moved\n");
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "moved");
    plain(other, "push", "-q", "origin", "main");
    const r = await pushing;
    expect([r.code, r.out]).toEqual([0, expect.stringContaining("codeoid pushed while-moving")]);
    expect(upstreamRef("refs/heads/while-moving")).toBe(sha);
    // Its check refs are gone.
    expect(plain(gw.cachePath(`u:${URL}`), "for-each-ref", "refs/codeoid-check/")).toBe("");
  });

  test("round 17: a check ref a stopped daemon left is never shown, and is swept with what only it reached; an interrupted fetch's pack is pruned", async () => {
    const other = join(root, "other");
    plain(root, "clone", "-q", upstream, other);
    plain(other, "checkout", "-q", "-b", "oops");
    writeFileSync(join(other, "secret.txt"), "TOPSECRET\n");
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "oops");
    plain(other, "push", "-q", "origin", "oops");
    const secret = plain(other, "rev-parse", "HEAD");
    expect((await agent(root, "ls-remote", URL)).code).toBe(0);
    const cache = gw.cachePath(`u:${URL}`);
    // As a push's last check leaves it when the daemon stops mid-way: a check ref on the commit, the branch then purged.
    plain(cache, "update-ref", "refs/codeoid-check/deadbeef/heads/oops", secret);
    plain(upstream, "branch", "-D", "oops");
    plain(upstream, "reflog", "expire", "--expire=now", "--all");
    plain(upstream, "gc", "-q", "--prune=now");
    const listed = await agent(root, "ls-remote", URL);
    expect(listed.code).toBe(0);
    expect(listed.out).not.toContain("codeoid-check");
    expect(listed.out).not.toContain(secret);
    // That request swept it, and the prune dropped the commit.
    expect(plain(cache, "for-each-ref", "refs/codeoid-check/")).toBe("");
    expect(spawnSync("git", ["-C", cache, "cat-file", "-e", secret]).status).not.toBe(0);
    // An interrupted fetch: its mark left, with a pack it brought that no ref names.
    const blob = execFileSync("git", ["-C", cache, "hash-object", "-w", "--stdin"], { input: "fetched, never under a ref\n" }).toString().trim();
    plain(cache, "repack", "-q");
    writeFileSync(join(cache, "codeoid-unsettled-refresh-old"), "");
    expect(await cacheDirty(cache)).toBe(true);
    expect(await pruneCache(cache)).toBe(true);
    expect(spawnSync("git", ["-C", cache, "cat-file", "-e", blob]).status).not.toBe(0);
    expect(readdirSync(cache).filter((n) => n.startsWith("codeoid-unsettled-"))).toEqual([]);
    expect(await cacheDirty(cache)).toBe(false);
  });

  test("round 18: a shallow clone and a deepen go through the gateway's reading; a push carrying an object its branch doesn't use is refused", async () => {
    // More history, then a shallow clone and a deepen.
    const seed = join(root, "seed");
    for (const n of ["h1", "h2", "h3"]) {
      writeFileSync(join(seed, `${n}.txt`), `${n}\n`);
      plain(seed, "add", ".");
      plain(seed, "commit", "-q", "-m", n);
    }
    plain(seed, "push", "-q", "origin", "main");
    const shallow = join(root, "shallow");
    expect((await agent(root, "clone", "-q", "--depth", "1", URL, shallow)).code).toBe(0);
    expect(plain(shallow, "rev-list", "--count", "HEAD")).toBe("1");
    expect((await agent(shallow, "fetch", "-q", "--deepen", "2")).code).toBe(0);
    expect(plain(shallow, "rev-list", "--count", "HEAD")).toBe("3");
    // A raw push of a new branch whose pack also carries an unrelated blob.
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "extra");
    const tip = await commit(work, "extra");
    const extra = execFileSync("git", ["-C", work, "hash-object", "-w", "--stdin"], { input: "an object no branch uses\n" }).toString().trim();
    const objects = execFileSync("git", ["-C", work, "rev-list", "--objects", "--no-object-names", tip, "--not", "origin/main"]).toString().trim().split("\n");
    const pack = execFileSync("git", ["-C", work, "pack-objects", "--stdout", "-q"], { input: `${[...objects, extra].join("\n")}\n` });
    const s = gw.forSession("s1");
    const p = Bun.spawn([s.ext, "git-receive-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let got = "";
    while (!got.endsWith("0000")) {
      const { value, done } = await reader.read();
      if (done) break;
      got += Buffer.from(value).toString("latin1");
    }
    const pkt = (x: string) => `${(x.length + 4).toString(16).padStart(4, "0")}${x}`;
    p.stdin.write(`${pkt(`${"0".repeat(40)} ${tip} refs/heads/extra\0report-status\n`)}0000`);
    p.stdin.write(pack);
    p.stdin.end();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    await p.exited;
    expect(upstreamRef("refs/heads/extra")).toBe("");
    expect(reports.some((e) => e.kind === "push" && !e.ok && /doesn't use|don't use/.test(e.detail))).toBe(true);
    // The same push, as git makes it, goes.
    expect((await agent(work, "push", "origin", "extra")).code).toBe(0);
    expect(upstreamRef("refs/heads/extra")).toBe(tip);
  });

  test("round 18: a shallow line naming a commit the cache holds but no ref reaches serves nothing of it (whatever the cleanup missed)", async () => {
    const other = join(root, "other");
    plain(root, "clone", "-q", upstream, other);
    plain(other, "checkout", "-q", "-b", "oops");
    writeFileSync(join(other, "secret.txt"), "TOPSECRET-R18\n");
    plain(other, "add", ".");
    plain(other, "commit", "-q", "-m", "oops");
    plain(other, "rm", "-q", "secret.txt");
    plain(other, "commit", "-q", "-m", "removed");
    const tip = plain(other, "rev-parse", "HEAD");
    const secretBlob = plain(other, "rev-parse", "HEAD~1:secret.txt");
    expect((await agent(root, "ls-remote", URL)).code).toBe(0);
    const cache = gw.cachePath(`u:${URL}`);
    // The commits in the cache under no ref, and no record of them (a gap the cleanup didn't see).
    plain(cache, "fetch", "-q", other, "oops:refs/tmp/x");
    plain(cache, "update-ref", "-d", "refs/tmp/x");
    expect(await rememberRefs(cache, true)).toBe(true);
    expect(await cacheDirty(cache)).toBe(false);
    const main = plain(cache, "rev-parse", "refs/heads/main");
    const s = gw.forSession("s1");
    const p = Bun.spawn([s.ext, "git-upload-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = p.stdout.getReader();
    let got = Buffer.alloc(0);
    while (!got.toString("latin1").endsWith("0000")) {
      const { value, done } = await reader.read();
      if (done) break;
      got = Buffer.concat([got, Buffer.from(value)]);
    }
    const pkt = (x: string) => `${(x.length + 4).toString(16).padStart(4, "0")}${x}`;
    // As the round-15 report sent it: unshallow from the purged commit (its parent holds the secret).
    p.stdin.write(`${pkt(`want ${main} shallow\n`)}${pkt(`shallow ${tip}\n`)}${pkt("deepen 2147483647\n")}0000${pkt("done\n")}`);
    p.stdin.end();
    let reply = Buffer.alloc(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      reply = Buffer.concat([reply, Buffer.from(value)]);
    }
    await p.exited;
    const at = reply.indexOf("PACK");
    const empty = join(root, "got.git");
    plain(root, "init", "-q", "--bare", empty);
    if (at >= 0) spawnSync("git", ["-C", empty, "index-pack", "--stdin", "--fix-thin"], { input: reply.subarray(at) });
    expect(spawnSync("git", ["-C", empty, "cat-file", "-e", secretBlob]).status).not.toBe(0);
    expect(reply.toString("latin1")).not.toContain(tip);
  });

  test("round 19: a partial clone asked for is a whole clone; --shallow-exclude with a branch's short name works", async () => {
    const seed = join(root, "seed");
    for (const n of ["e1", "e2"]) {
      writeFileSync(join(seed, `${n}.txt`), `${n}\n`);
      plain(seed, "add", ".");
      plain(seed, "commit", "-q", "-m", n);
    }
    plain(seed, "push", "-q", "origin", "main");
    plain(seed, "push", "-q", "origin", "HEAD~1:refs/heads/base");
    const partial = join(root, "partial");
    const r = await agent(root, "clone", "-q", "--filter=blob:none", URL, partial);
    expect(r.code).toBe(0);
    expect(plain(partial, "rev-list", "--count", "--objects", "--missing=print", "HEAD").length).toBeGreaterThan(0);
    expect(spawnSync("git", ["-C", partial, "fsck", "--connectivity-only"], { encoding: "utf8" }).status).toBe(0);
    expect(plain(partial, "cat-file", "-p", "HEAD:e2.txt")).toBe("e2");
    const excl = join(root, "excl");
    const e = await agent(root, "clone", "-q", "--shallow-exclude=base", URL, excl);
    expect([e.code, e.out]).toEqual([0, ""]);
    expect(plain(excl, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("round 21: an agent that floods a push while its card is up is cut off and nothing is pushed; a session's connections are bounded", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "flood");
    const tip = await commit(work, "flood");
    const objects = execFileSync("git", ["-C", work, "rev-list", "--objects", "--no-object-names", tip, "--not", "origin/main"]).toString().trim().split("\n");
    const pack = execFileSync("git", ["-C", work, "pack-objects", "--stdout", "-q"], { input: `${objects.join("\n")}\n` });
    approveDelayMs = 3000;
    const s = gw.forSession("s1");
    // Node's spawn, whose stdin errors can be handled: the gateway cutting the pipe off is what's expected here.
    const { spawn } = await import("node:child_process");
    const p = spawn(s.ext, ["git-receive-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdio: ["pipe", "pipe", "pipe"] });
    p.stdin.on("error", () => {});
    const exited = new Promise<void>((r) => p.on("close", () => r()));
    let got = "";
    await new Promise<void>((r) => {
      p.stdout.on("data", (d: Buffer) => {
        got += d.toString("latin1");
        if (got.endsWith("0000")) r();
      });
      p.on("close", () => r());
    });
    const pkt = (x: string) => `${(x.length + 4).toString(16).padStart(4, "0")}${x}`;
    // The push, then far more than any push sends after its pack, while the owner is asked.
    const junk = Buffer.alloc(1024 * 1024, 0x41);
    let piping = true;
    p.stdin.on("error", () => {
      piping = false;
    });
    p.on("close", () => {
      piping = false;
    });
    const send = (b: string | Buffer) =>
      new Promise<void>((r) => {
        if (!piping || p.stdin.destroyed) return r();
        if (p.stdin.write(b)) r();
        else {
          p.stdin.once("drain", () => r());
          p.once("close", () => r());
        }
      });
    await send(`${pkt(`${"0".repeat(40)} ${tip} refs/heads/flood\0report-status\n`)}0000`);
    await send(pack);
    for (let i = 0; i < 40 && piping; i++) await send(junk);
    if (piping) p.stdin.end();
    await exited;
    await new Promise((r) => setTimeout(r, 3500));
    expect(upstreamRef("refs/heads/flood")).toBe("");
    // At most a few connections at once from one session: the next is told why.
    const { createConnection } = await import("node:net");
    const open = Array.from({ length: 8 }, () => createConnection(s.socket));
    await new Promise((r) => setTimeout(r, 200));
    const extra = createConnection(s.socket);
    const said = await new Promise<string>((resolve) => {
      let t = "";
      extra.on("data", (d) => {
        t += d.toString("utf8");
      });
      extra.on("close", () => resolve(t));
      extra.on("error", () => resolve(t));
    });
    expect(said).toContain("too many git connections");
    // And what the agent's own launcher says, as the next connection: the reason, not "the daemon isn't reachable".
    const l = Bun.spawn([s.ext, "git-upload-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lerr = await new Response(l.stderr).text();
    await l.exited;
    expect(lerr).toContain("too many git connections");
    for (const o of open) o.destroy();
  }, 30_000);

  test("round 22: a large push (a pack of tens of MiB) goes through the gateway", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "big");
    // Incompressible content, already packed locally (as a reused pack is streamed fast).
    // CODEOID_TEST_BIG_MB: a larger pack, to run by hand (the pinned Bun's stdin race needed hundreds of MiB).
    writeFileSync(join(work, "big.bin"), randomBytes(Number(process.env.CODEOID_TEST_BIG_MB || 40) * 1024 * 1024));
    await agent(work, "add", ".");
    expect((await agent(work, "commit", "-q", "-m", "big")).code).toBe(0);
    plain(work, "repack", "-q", "-a", "-d");
    const r = await agent(work, "push", "origin", "big");
    expect([r.code, r.out]).toEqual([0, expect.stringContaining("codeoid pushed big")]);
    expect(upstreamRef("refs/heads/big")).toBe(plain(work, "rev-parse", "HEAD"));
  }, 300_000);

  test("round 24: a push whose pack stops half way is answered at once (not at the request's limit), and recorded", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "half");
    const tip = await commit(work, "half");
    const objects = execFileSync("git", ["-C", work, "rev-list", "--objects", "--no-object-names", tip, "--not", "origin/main"]).toString().trim().split("\n");
    const pack = execFileSync("git", ["-C", work, "pack-objects", "--stdout", "-q"], { input: `${objects.join("\n")}\n` });
    const s = gw.forSession("s1");
    const { spawn } = await import("node:child_process");
    const p = spawn(s.ext, ["git-receive-pack", URL], { env: { PATH: process.env.PATH ?? "", CODEOID_GIT_GATEWAY: s.socket }, stdio: ["pipe", "pipe", "pipe"] });
    p.stdin.on("error", () => {});
    const exited = new Promise<void>((r) => p.on("close", () => r()));
    let got = "";
    await new Promise<void>((r) => {
      p.stdout.on("data", (d: Buffer) => {
        got += d.toString("latin1");
        if (got.endsWith("0000")) r();
      });
    });
    const pkt = (x: string) => `${(x.length + 4).toString(16).padStart(4, "0")}${x}`;
    const t0 = Date.now();
    // As a client whose pack-objects died: the commands, half a pack, then its input ends.
    p.stdin.write(`${pkt(`${"0".repeat(40)} ${tip} refs/heads/half\0report-status\n`)}0000`);
    p.stdin.end(pack.subarray(0, Math.floor(pack.length / 2)));
    await exited;
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(upstreamRef("refs/heads/half")).toBe("");
    await new Promise((r) => setTimeout(r, 200));
    expect(reports.some((e) => e.kind === "push" && !e.ok && /ended before codeoid checked it/.test(e.detail))).toBe(true);
  }, 30_000);

  test("round 24: pushes and fetches at once on one remote all go (no ref-lock fight, no prune, no fetch cut off)", async () => {
    const works: string[] = [];
    for (const n of ["a", "b", "c", "d"]) {
      const w = join(root, `work-${n}`);
      expect((await agent(root, "clone", "-q", URL, w)).code).toBe(0);
      works.push(w);
    }
    for (let round = 0; round < 4; round++) {
      const jobs: Array<Promise<{ code: number; out: string }>> = [];
      for (const [i, w] of works.entries()) {
        await agent(w, "checkout", "-q", "-B", `br-${i}`);
        writeFileSync(join(w, `f-${i}-${round}.bin`), randomBytes(512 * 1024));
        await agent(w, "add", ".");
        await agent(w, "commit", "-q", "-m", `r${round}`);
        jobs.push(agent(w, "push", "-q", "origin", `br-${i}`));
        jobs.push(agent(w, "fetch", "-q", "origin"));
      }
      const results = await Promise.all(jobs);
      expect(results.map((r) => (r.code === 0 ? "" : r.out))).toEqual(results.map(() => ""));
    }
    expect(reports.filter((e) => !e.ok)).toEqual([]);
  }, 120_000);

  test("round 25: an agent killed while its push waits leaves nothing held: the next request on the remote goes at once", async () => {
    const work = await clone();
    await agent(work, "checkout", "-q", "-b", "killed");
    await commit(work, "killed");
    approveDelayMs = 1500;
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
    const p = Bun.spawn(["git", "push", "origin", "killed"], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    await new Promise((r) => setTimeout(r, 600));
    p.kill("SIGKILL");
    await p.exited;
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    expect((await agent(work, "fetch", "-q", "origin")).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(upstreamRef("refs/heads/killed")).toBe("");
  }, 30_000);

  test("round 29: with the fetch URL and the owner's push URL both connected, an agent's push goes where the owner's git pushes", async () => {
    const { gatewayRoutes } = await import("../daemon/sandbox/session-sandbox.js");
    const { gitGatewayEnv } = await import("../daemon/sandbox/policy.js");
    const fetchUrl = "https://github.com/acme/app.git";
    const pushUrl = "git@github.com:me/app.git";
    // The owner's pushInsteadOf: pushes to acme's go to their fork, over ssh.
    const pushRewrite = (u: string) => (u.startsWith("https://github.com/acme/") ? `git@github.com:me/${u.slice("https://github.com/acme/".length)}` : u);
    const routes = gatewayRoutes([fetchUrl, pushUrl], [fetchUrl], { off: false, rewrite: (u) => u, pushRewrite });
    const env = gitGatewayEnv({ socket: "/s", ext: "/gw/ext", binDir: "/b", runtime: "/r", urls: [fetchUrl, pushUrl], routes });
    // What git inside the sandbox makes of the workspace's origin, for a fetch and for a push.
    const repo = join(root, "routes");
    plain(root, "init", "-q", repo);
    plain(repo, "remote", "add", "origin", fetchUrl);
    const asked = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1", ...env } }).trim();
    expect(asked(["remote", "get-url", "origin"])).toBe(`ext::/gw/ext %S ${fetchUrl}`);
    expect(asked(["remote", "get-url", "--push", "origin"])).toBe(`ext::/gw/ext %S ${pushUrl}`);
    // Round 30: the owner's push URL not connected (an https fork, network on): the push still goes there, to the
    // gateway (which refuses or offers to connect it), never to the fetch URL.
    const forkHttps = (u: string) => (u.startsWith("https://github.com/acme/") ? `https://github.com/me/${u.slice("https://github.com/acme/".length)}` : u);
    expect(gatewayRoutes([fetchUrl], [], { off: false, rewrite: (u) => u, pushRewrite: forkHttps })).toEqual([{ from: fetchUrl, fetch: fetchUrl, push: "https://github.com/me/app.git" }]);
    // An insteadOf alone (https written, ssh used, no pushInsteadOf): the same repository, so the connected URL
    // stands for it both ways when the rewrite isn't connected.
    const toSsh = (u: string) => (u.startsWith("https://github.com/") ? `git@github.com:${u.slice("https://github.com/".length)}` : u);
    expect(gatewayRoutes([fetchUrl], [], { off: false, rewrite: toSsh, pushRewrite: toSsh })).toEqual([{ from: fetchUrl, fetch: fetchUrl, push: fetchUrl }]);
    // A connected URL the owner doesn't rewrite stands for itself, both ways.
    const plainRoutes = gatewayRoutes([fetchUrl], [], { off: false, rewrite: (u) => u, pushRewrite: (u) => u });
    expect(plainRoutes).toEqual([{ from: fetchUrl, fetch: fetchUrl, push: fetchUrl }]);
  });

  test("round 12: a disconnected remote's cache is removed", async () => {
    await clone();
    const cache = gw.cachePath(`u:${URL}`);
    expect(existsSync(cache)).toBe(true);
    await gw.forget(`u:${URL}`);
    expect(existsSync(cache)).toBe(false);
  });

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
    expect(await refUpdateProblem({ old: z, new: a, ref: "refs/heads/new" }, { ...p, defaultKnown: false }, ff)).toContain("didn't say which branch is its default");
  });
});
