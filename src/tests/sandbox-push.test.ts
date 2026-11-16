/**
 * The sandbox's `push` (sandbox/push.ts): what is pushed, from where, to
 * where, and what is refused — against real git repositories and a local
 * bare remote (file://, a test-only allowance: a real push takes ssh and
 * https only).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPushTool, isSafeTool } from "../daemon/providers/tool-safety.js";
import { branchMatches, cleanPushInput, planPush, pushUrlProblem, runPush, shownUrl, type PushPlan } from "../daemon/sandbox/push.js";
import { SandboxMcpHttp } from "../daemon/sandbox/request-directory.js";

let root: string;
let repo: string;
let bare: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-push-")));
  bare = join(root, "remote.git");
  repo = join(root, "work", "repo");
  mkdirSync(repo, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "remote", "add", "origin", `file://${bare}`);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feature/x");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "second");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ protectedBranches: ["main", "master"], home: root, _testFileRemote: true });
const plan = async (input: Parameters<typeof planPush>[1] = {}, o: Partial<Parameters<typeof planPush>[2]> = {}) => planPush(repo, input, { ...opts(), ...o });
const planned = async (input: Parameters<typeof planPush>[1] = {}): Promise<PushPlan> => {
  const p = await plan(input);
  if ("refused" in p) throw new Error(p.refused);
  return p;
};
const refusal = async (input: Parameters<typeof planPush>[1] = {}, o: Partial<Parameters<typeof planPush>[2]> = {}): Promise<string> => {
  const p = await plan(input, o);
  if (!("refused" in p)) throw new Error(`expected a refusal, got a plan for ${p.branch}`);
  return p.refused;
};

describe("push: the plan", () => {
  test("the checked-out branch, as its commit now, to origin's URL from the repository's own config", async () => {
    const p = await planned();
    expect(p).toMatchObject({ branch: "feature/x", remote: "origin", url: `file://${bare}`, sha: git(repo, "rev-parse", "HEAD"), ahead: 1 });
  });

  test("never main, master, a protected pattern, or the remote's default branch", async () => {
    git(repo, "checkout", "-q", "main");
    expect(await refusal()).toContain("protected branch");
    expect(await refusal({ branch: "feature/x" }, { protectedBranches: ["feature/*"] })).toContain("protected branch");
    expect(await refusal({ branch: "feature/x" }, { remoteDefault: async () => "feature/x" })).toContain("the remote's default branch");
    expect(branchMatches("release/*", "release/1.2")).toBe(true);
    expect(branchMatches("release/*", "releases")).toBe(false);
  });

  test("a detached HEAD, a branch that doesn't exist, a remote that doesn't, a non-repository: refused, saying why", async () => {
    git(repo, "checkout", "-q", "--detach");
    expect(await refusal()).toContain("detached HEAD");
    expect(await refusal({ branch: "nope" })).toContain("no local branch nope");
    expect(await refusal({ branch: "feature/x", remote: "upstream" })).toContain("no remote named upstream");
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect("refused" in (await planPush(plain, {}, opts()))).toBe(true);
  });

  test("where the push goes is decided only by your config and the repository's own .git/config: an include's remote, rewrite or proxy is refused", async () => {
    const inc = join(root, "work", "inc.cfg");
    for (const body of ['[remote "origin"]\n\tpushurl = https://evil.example/x.git\n', '[url "https://evil.example/"]\n\tinsteadOf = file://\n', "[http]\n\tproxy = http://evil.example:1\n", "[core]\n\tsshCommand = ssh -o ProxyCommand=evil\n"]) {
      writeFileSync(inc, body);
      git(repo, "config", "include.path", inc);
      expect(await refusal()).toContain("a file this session's agent could write");
      git(repo, "config", "--unset", "include.path");
    }
    // The repository's own config is the user's (read-only to sandboxed commands): its settings are taken.
    git(repo, "config", "http.postBuffer", "1048576");
    expect("refused" in (await plan())).toBe(false);
  });

  test("only ssh and https remotes are pushed to for real; two push URLs, or borrowed objects, are refused", async () => {
    expect(await refusal({}, { _testFileRemote: false })).toContain("only ssh and https");
    for (const url of ["git@bitbucket.org:team/repo.git", "ssh://git@host:2222/x.git", "https://bitbucket.org/team/repo.git"]) expect([url, pushUrlProblem(url)]).toEqual([url, null]);
    for (const url of ["file:///tmp/x", "ext::sh -c touch% /tmp/pwned", "-oProxyCommand=x:y", "http://plain.example/x.git", "/abs/path"]) expect(pushUrlProblem(url)).not.toBeNull();
    expect(shownUrl("https://user:tok@host/x.git?k=v")).not.toContain("tok");
    git(repo, "config", "--add", "remote.origin.pushurl", `file://${bare}`);
    git(repo, "config", "--add", "remote.origin.pushurl", `file://${bare}`);
    expect(await refusal()).toContain("2 push URLs");
    git(repo, "config", "--unset-all", "remote.origin.pushurl");
    writeFileSync(join(repo, ".git", "objects", "info", "alternates"), "/elsewhere/objects\n");
    expect(await refusal()).toContain("borrows objects");
  });

  test("the tool's input: a branch name and a remote name, checked", () => {
    expect(cleanPushInput({ branch: "feature/x", remote: "origin" })).toEqual({ branch: "feature/x", remote: "origin" });
    for (const branch of ["-f", "a..b", "x:y", "+main", ":refs/heads/main", "main~1", "a b"]) expect(typeof cleanPushInput({ branch })).toBe("string");
    for (const remote of ["--receive-pack=x", "a/b", "ext::sh"]) expect(typeof cleanPushInput({ remote })).toBe("string");
    expect(typeof cleanPushInput({ branch: 3 })).toBe("string");
  });
});

describe("push: the run", () => {
  test("pushes the one branch, as planned, to the same branch; nothing else (no other branch, no tags); a second push is up to date", async () => {
    git(repo, "branch", "other");
    git(repo, "tag", "v1");
    const p = await planned();
    const r = await runPush(p, 60_000, true);
    expect(r).toMatchObject({ ok: true });
    expect(r.summary).toContain("a new branch there");
    expect(git(bare, "rev-parse", "refs/heads/feature/x")).toBe(p.sha);
    expect(() => git(bare, "rev-parse", "--verify", "-q", "refs/heads/other")).toThrow();
    expect(() => git(bare, "rev-parse", "--verify", "-q", "refs/tags/v1")).toThrow();
    const again = await runPush(await planned(), 60_000, true);
    expect(again).toMatchObject({ ok: true });
    expect(again.summary).toContain("already up to date");
  });

  test("the repository's hooks never run (pre-push), and a commit made after the plan isn't pushed", async () => {
    const marker = join(root, "hook-ran");
    const hook = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    const p = await planned();
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "after the plan");
    const r = await runPush(p, 60_000, true);
    expect(r.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(bare, "rev-parse", "refs/heads/feature/x")).toBe(p.sha);
  });

  test("a remote branch with commits ours doesn't have: refused by the remote, never forced, and the agent is told what to do", async () => {
    await runPush(await planned(), 60_000, true);
    // Someone else moves the remote branch.
    const other = join(root, "other");
    git(root, "clone", "-q", `file://${bare}`, other);
    git(other, "checkout", "-q", "feature/x");
    writeFileSync(join(other, "z.txt"), "z\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "theirs");
    git(other, "push", "-q", "origin", "feature/x");
    const theirs = git(other, "rev-parse", "HEAD");
    git(repo, "commit", "-q", "--amend", "-m", "rewritten");
    const r = await runPush(await planned(), 60_000, true);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("a force push isn't done for agents");
    expect(git(bare, "rev-parse", "refs/heads/feature/x")).toBe(theirs);
  });
});

describe("push: how it is offered", () => {
  test("the gate knows it by every backend's name for it, and nothing else", () => {
    for (const name of ["mcp__codeoid_sandbox__push", "codeoid_sandbox__push"]) {
      expect(isPushTool(name)).toBe(true);
      // The session decides it (its checks, the owner's answer): it is never a "safe" read the gate waves through.
      expect(isSafeTool(name)).toBe(false);
    }
    for (const name of ["push", "mcp__other__push", "mcp__codeoid_sandbox__pushx", "x_mcp__codeoid_sandbox__push"]) expect(isPushTool(name)).toBe(false);
  });

  test("the daemon's /mcp/sandbox lists push beside request_directory and routes a call to the session's handler", async () => {
    const calls: unknown[] = [];
    const http = new SandboxMcpHttp(async () => "dir", async (sessionId, input) => {
      calls.push({ sessionId, input });
      return "Done: pushed";
    });
    const token = http.mint("s1");
    const rpc = async (body: unknown) =>
      (await (await http.handle(new Request("http://x/mcp/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }))).json()) as {
        result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> };
      };
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.result.tools?.map((t) => t.name)).toEqual(["request_directory", "push"]);
    const called = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "push", arguments: { branch: "feature/x" } } });
    expect(called.result.content?.[0]?.text).toBe("Done: pushed");
    expect(calls).toEqual([{ sessionId: "s1", input: { branch: "feature/x" } }]);
    const bad = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "push", arguments: { branch: "+main" } } });
    expect(bad.result.content?.[0]?.text).toContain("isn't a branch name");
    expect(calls).toHaveLength(1);
    // Without a push handler (an older wiring), only request_directory is there.
    const plain = new SandboxMcpHttp(async () => "dir");
    const t2 = plain.mint("s2");
    const listed = (await (await plain.handle(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${t2}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }))).json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name)).toEqual(["request_directory"]);
  });
});
