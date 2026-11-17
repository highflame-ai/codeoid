/**
 * What the git gateway takes of the owner's setup (docs/git-gateway-design.md §3.4): data, never a program. ssh's
 * config is resolved by OpenSSH itself (`ssh -G`) once codeoid's scan found no Match block and nothing a session may
 * write, and written back as a config of codeoid's own; a credential helper is run only when it is one of git's or
 * the platforms' own, as a line codeoid writes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { credentialUrlMatches, fillGitCredential, safeHelper } from "../daemon/git-gateway/connect.js";
import { resolveSshSnapshot, scanSshConfig, sshG, snapshotProblem, sshConfigSources, sshConfigText, sshHostOf, sshSnapshotLine, sshUrlUserPort } from "../daemon/git-gateway/ssh-snapshot.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "gw-owner-")));
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const ssh = (text: string, file = "config") => writeFileSync(join(home, ".ssh", file), text, { mode: 0o600 });

const SSH = "/usr/bin/ssh";
const resolve = (url: string, writable: string[] = []) => resolveSshSnapshot(url, { ssh: SSH, home, writable });

describe("ssh snapshot", () => {
  test("the host an ssh URL names, and its own user and port", () => {
    expect(sshHostOf("git@bitbucket.org:team/app.git")).toBe("bitbucket.org");
    expect(sshHostOf("ssh://git@host.example:2222/team/app.git")).toBe("host.example");
    expect(sshHostOf("ssh://[::1]/x")).toBeNull();
    expect(sshHostOf("https://host/x")).toBeNull();
    expect(sshHostOf("git@-oProxyCommand=x:y")).toBeNull();
    expect(sshUrlUserPort("ssh://alice@bb:2222/x.git")).toEqual({ user: "alice", port: "2222" });
  });

  test("OpenSSH resolves it: IdentitiesOnly in any spelling, the URL's user and port, jump hosts as their own blocks", async () => {
    const key = join(home, ".ssh", "id_bb");
    writeFileSync(key, "k", { mode: 0o600 });
    ssh(["Host bb", "  HostName bitbucket.org", "  User git", "  IdentitiesOnly true", `  IdentityFile ${key}`, "  ProxyJump j1", "Host j1", "  HostName jump.example", "  Port 2200", "  User jumper"].join("\n"));
    const s = await resolve("bb:team/app.git");
    if ("error" in s) throw new Error(s.error);
    expect(s.hostName).toBe("bitbucket.org");
    expect(s.identitiesOnly).toBe(true);
    expect(s.identityFiles).toContain(key);
    expect(s.jumps?.[0]).toMatchObject({ host: "j1", hostName: "jump.example", port: "2200", user: "jumper" });
    expect(snapshotProblem(s, [], home)).toBeNull();
    const text = sshConfigText(s);
    expect(text).toContain("IdentitiesOnly yes");
    expect(text).toContain("Host j1\n  HostName jump.example\n  User jumper\n  Port 2200");
    for (const k of ["ProxyCommand none", "PermitLocalCommand no", "ControlPath none", "BatchMode yes"]) expect(text).toContain(k);
    expect(sshSnapshotLine(s)).toContain(`bitbucket.org as git via j1, key ${key}`);
    const u = await resolve("ssh://alice@bb:2222/x.git");
    if ("error" in u) throw new Error(u.error);
    expect(u).toMatchObject({ user: "alice", port: "2222" });
  });

  test("a Match block in any spelling, in any file the config can read, is refused before ssh runs", async () => {
    const mark = join(home, "ran");
    mkdirSync(join(home, ".ssh", "d"));
    for (const line of [`Match exec "touch ${mark}"`, `"Match" exec "touch ${mark}"`, `=match exec "touch ${mark}"`, `MATCH exec "touch ${mark}"`, `M\\atch exec "touch ${mark}"`]) {
      ssh(["Host other", "  Include d/inner", "Host bb", "  HostName bitbucket.org"].join("\n"));
      ssh(line, "d/inner");
      const s = await resolve("bb:x.git");
      expect("error" in s && s.error).toContain("Match");
    }
    expect(existsSync(mark)).toBe(false);
  });

  test("what codeoid doesn't take is refused: ProxyCommand, KnownHostsCommand, CanonicalizeHostname, variables", async () => {
    for (const [cfg, word] of [
      ["  ProxyCommand nc %h %p", "ProxyCommand"],
      ["  KnownHostsCommand /bin/true", "KnownHostsCommand"],
      ["  CanonicalizeHostname yes", "CanonicalizeHostname"],
      ["  IdentityFile ${HOME}/.ssh/id", "doesn't take"],
      ["  IdentityFile %d/.ssh/id", "doesn't take"],
    ] as const) {
      ssh(["Host bb", cfg].join("\n"));
      const s = await resolve("bb:x.git");
      const why = "error" in s ? s.error : snapshotProblem(s, [], home);
      expect(why).toContain(word);
    }
    ssh(["Include $HOME/x"].join("\n"));
    expect(scanSshConfig(home).problem).toContain("Include");
  });

  test("round 10: a Match exec ssh -G reaches never runs, even one the scan didn't see (ssh's shell is false)", async () => {
    const mark = join(home, "ran");
    const cfg = join(home, "direct.conf");
    writeFileSync(cfg, `Match exec "touch ${mark}"\n  User matched\nHost *\n  User plain\n`);
    const g = await sshG(SSH, cfg, home, { host: "bb" });
    if ("error" in g) throw new Error(g.error);
    expect(g.get("user")?.[0]).toBe("plain");
    expect(existsSync(mark)).toBe(false);
  });

  test("round 10: Include forms codeoid can't read exactly as ssh does are refused", () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "x.conf"), "User x\n");
    for (const inc of [
      `Include ~${userInfo().username}/ws/x.conf`,
      `Include "${ws.slice(0, -1)}"${ws.slice(-1)}/x.conf`,
      `Include ${ws}/"x".conf`,
      `Include ${ws}/../ws/x.conf`,
      `Include ${ws}/./x.conf`,
      `Include ${ws}/[x].conf`,
      `Include ${ws}/x .conf`,
      `Include\t${ws}/x\u000b.conf`,
      // Round 11: ssh skips one `=` (strdelim); a second is the argument's.
      `Include ==${ws}/x.conf`,
      `Include = =${ws}/x.conf`,
    ]) {
      ssh(inc);
      expect(scanSshConfig(home).problem, inc).toContain("Include");
    }
  });

  test("round 10: a file too big to read whole, and a glob over a name that isn't plain, are refused", () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "big.conf"), `${"# pad\n".repeat(200_000)}Match all\n`);
    ssh(`Include ${join(ws, "big.conf")}`);
    expect(scanSshConfig(home).problem).toContain("whole");
    writeFileSync(join(ws, "a\nb.conf"), "User x\n");
    ssh(`Include ${join(ws, "*.conf")}`);
    expect(scanSshConfig(home).problem).toContain("pattern");
  });

  test("a FIFO the config includes is never read (nothing blocks), and refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    spawnSync("mkfifo", [join(ws, "fifo")]);
    ssh(`Include ${join(ws, "fifo")}`);
    const t = Date.now();
    const scan = scanSshConfig(home);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(scan.problem).toContain("plain file");
  });

  test("a file the config is read from in what a session may write is refused, in every Include form, and held", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "inc"), "Host bb\n  HostName agent.example\n");
    for (const inc of [`Include=${join(ws, "inc")}`, `Include "${join(ws, "inc")}"`, `"Include" ${join(ws, "*")}`, `Host nomatch\n  Include ${join(ws, "inc")}`, `include ${join(ws, "missing")}`]) {
      ssh(inc);
      const s = await resolve("bb:x.git", [ws]);
      expect("error" in s).toBe(true);
    }
    ssh(`Include=${join(ws, "inc")}`);
    expect(sshConfigSources(home)).toContain(join(ws, "inc"));
  });

  test("a key file that leads into what a session may write is refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "key"), "k", { mode: 0o600 });
    symlinkSync(join(ws, "key"), join(home, ".ssh", "id_link"));
    ssh(["Host bb", `  IdentityFile ${join(home, ".ssh", "id_link")}`].join("\n"));
    const s = await resolve("bb:x.git");
    if ("error" in s) throw new Error(s.error);
    expect(snapshotProblem(s, [ws], home)).toContain("id_link");
  });
});

describe("credential helpers", () => {
  test("a helper that isn't git's or a platform's own is never run", async () => {
    const mark = join(home, "ran");
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = "!touch ${mark}; echo password=x"\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [] }, 10_000);
    expect("error" in r && r.error).toContain("--token");
    expect(existsSync(mark)).toBe(false);
  });

  test("git's own store helper is run, with only the helpers allowed", async () => {
    const store = join(home, ".git-credentials");
    writeFileSync(store, "https://agent:secret-value@host.invalid\n", { mode: 0o600 });
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file ${store}\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [] }, 10_000);
    expect(r).toEqual({ username: "agent", password: "secret-value" });
  });

  test("an allowed helper's name is never found in a PATH dir a session may write", async () => {
    const ws = join(home, "ws");
    const mark = join(home, "ran");
    mkdirSync(join(ws, "bin"), { recursive: true });
    writeFileSync(join(ws, "bin", "git-credential-manager"), `#!/bin/sh\ntouch ${mark}\necho password=x\n`, { mode: 0o755 });
    writeFileSync(join(home, ".gitconfig"), "[credential]\n\thelper = manager\n");
    process.env.HOME = home;
    const savedPath = process.env.PATH;
    process.env.PATH = `${join(ws, "bin")}:${savedPath}`;
    try {
      const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [ws] }, 10_000);
      expect("error" in r).toBe(true);
      expect(existsSync(mark)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a store helper carrying shell is refused, and nothing of it runs", async () => {
    const mark = join(home, "ran");
    for (const h of [`store --file=/usr/x|touch\${IFS}${mark}|true`, `store --file=/x$(touch ${mark})`, `store --file=/x\`touch ${mark}\``]) {
      expect("error" in safeHelper(h, home)).toBe(true);
      writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = ${JSON.stringify(h)}\n`);
      process.env.HOME = home;
      const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [] }, 10_000);
      expect("error" in r).toBe(true);
    }
    expect(existsSync(mark)).toBe(false);
    expect(safeHelper("store --file ~/.git-credentials", home)).toEqual({ line: `store --file '${join(home, ".git-credentials")}'`, file: join(home, ".git-credentials") });
  });

  test("a helper scoped to another URL isn't used (git's urlmatch, not a prefix)", () => {
    const u = new URL("https://host.example/team/app.git");
    expect(credentialUrlMatches("https://host.example", u)).toBe(true);
    expect(credentialUrlMatches("https://host.example/team", u)).toBe(true);
    expect(credentialUrlMatches("https://*.example", u)).toBe(true);
    expect(credentialUrlMatches("https://host.example/te", u)).toBe(false);
    expect(credentialUrlMatches("https://host.example.evil", u)).toBe(false);
    expect(credentialUrlMatches("http://host.example", u)).toBe(false);
    expect(credentialUrlMatches("https://host.example:8443", u)).toBe(false);
    expect(credentialUrlMatches("host.example", u)).toBe(false);
  });

  test("a store file a session may write is refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file ${join(ws, "creds")}\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [ws] }, 10_000);
    expect("error" in r).toBe(true);
  });
});

describe("round 31: the owner's rewrites as git applies them in the repository", () => {
  test("a pushInsteadOf in a conditional include, or in the repository's own config, counts; from / it doesn't", async () => {
    const { ownerPushRewrite, ownerRewrite, warmRewrites } = await import("../daemon/git-gateway/connect.js");
    const repo = join(home, "work", "app");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(join(home, "fork.gitconfig"), '[url "git@github.com:me/"]\n\tpushInsteadOf = https://github.com/acme/\n');
    writeFileSync(join(home, ".gitconfig"), `[includeIf "gitdir:${join(home, "work")}/"]\n\tpath = ${join(home, "fork.gitconfig")}\n`);
    process.env.HOME = home;
    const url = "https://github.com/acme/app.git";
    expect(ownerPushRewrite(url)).toBe(url);
    // The repository's rules are read asynchronously (never on the daemon's thread), before they are used.
    await warmRewrites(repo, true);
    expect(ownerPushRewrite(url, repo)).toBe("git@github.com:me/app.git");
    expect(ownerRewrite(url, repo)).toBe(url);
    // The repository's own rule.
    writeFileSync(join(home, ".gitconfig"), "");
    spawnSync("git", ["-C", repo, "config", "url.git@gitlab.com:me/.pushInsteadOf", "https://github.com/acme/"]);
    await warmRewrites(repo, true);
    expect(ownerPushRewrite(url, repo)).toBe("git@gitlab.com:me/app.git");
  });

  test("an insteadOf to another repository is reached as the owner's git reaches it, not as the connected URL", async () => {
    const { gatewayRoutes } = await import("../daemon/sandbox/session-sandbox.js");
    const connected = "https://github.com/acme/app.git";
    const mirror = (u: string) => (u === connected ? "https://mirror.example/acme/app.git" : u);
    expect(gatewayRoutes([connected], [], { off: false, rewrite: mirror, pushRewrite: mirror })).toEqual([{ from: connected, fetch: "https://mirror.example/acme/app.git", push: "https://mirror.example/acme/app.git" }]);
    // The same repository by ssh (not connected): the connected URL stands for it.
    const toSsh = (u: string) => (u === connected ? "git@github.com:acme/app.git" : u);
    expect(gatewayRoutes([connected], [], { off: false, rewrite: toSsh, pushRewrite: toSsh })).toEqual([{ from: connected, fetch: connected, push: connected }]);
  });
});

describe("round 32: the repository's files are read without blocking, and asked only when plain", () => {
  test("a FIFO config or HEAD: nothing blocks, the repository isn't asked; a subdirectory finds its top", async () => {
    const { workspaceRemoteUrls, repositoryForRewrites, gatewayRoutes } = await import("../daemon/sandbox/session-sandbox.js");
    const { ownerPushRewrite, warmRewrites } = await import("../daemon/git-gateway/connect.js");
    process.env.HOME = home;
    const repo = join(home, "proj");
    mkdirSync(join(repo, "sub"), { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/app.git"]);
    spawnSync("git", ["-C", repo, "config", "url.git@github.com:me/.pushInsteadOf", "https://github.com/acme/"]);
    // A subdirectory: its repository's top is asked, and the repository's rule applies.
    expect(repositoryForRewrites(join(repo, "sub"))).toBe(repo);
    await warmRewrites(repo, true);
    expect(ownerPushRewrite("https://github.com/acme/app.git", repositoryForRewrites(join(repo, "sub")))).toBe("git@github.com:me/app.git");
    // The config a FIFO: read at once as nothing, the repository not asked.
    rmSync(join(repo, ".git", "config"));
    spawnSync("mkfifo", [join(repo, ".git", "config")]);
    const t = Date.now();
    expect(workspaceRemoteUrls(repo)).toEqual([]);
    expect(repositoryForRewrites(repo)).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(2_000);
    // HEAD a FIFO: not asked either.
    rmSync(join(repo, ".git", "config"));
    writeFileSync(join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    rmSync(join(repo, ".git", "HEAD"));
    spawnSync("mkfifo", [join(repo, ".git", "HEAD")]);
    expect(repositoryForRewrites(repo)).toBeUndefined();
    // An insteadOf to an http:// mirror (the gateway reaches only ssh and https): the connected URL, as before.
    const connected = "https://github.com/acme/app.git";
    const httpMirror = (u: string) => (u === connected ? "http://mirror.local/acme/app.git" : u);
    expect(gatewayRoutes([connected], [], { off: false, rewrite: httpMirror, pushRewrite: httpMirror })).toEqual([{ from: connected, fetch: connected, push: connected }]);
  });
});

describe("round 33: nothing of an agent's repository, or of the owner's config, is read on the daemon's thread blocking", () => {
  test("a worktree whose gitdir back-link is a FIFO: gitLayoutOf answers at once", async () => {
    const { gitLayoutOf } = await import("../daemon/sandbox/policy.js");
    const repo = join(home, "r33");
    spawnSync("git", ["init", "-q", repo]);
    const wt = join(home, "r33-wt");
    mkdirSync(join(repo, ".git", "worktrees", "w"), { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "w")}\n`);
    spawnSync("mkfifo", [join(repo, ".git", "worktrees", "w", "gitdir")]);
    const t = Date.now();
    expect(gitLayoutOf(wt, home)?.kind).not.toBe("worktree");
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  test("the repository's rules are read without holding the daemon up, a FIFO in its config included", async () => {
    const { warmRewrites, ownerPushRewrite } = await import("../daemon/git-gateway/connect.js");
    process.env.HOME = home;
    const repo = join(home, "r33b");
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("mkfifo", [join(repo, "planted")]);
    spawnSync("git", ["-C", repo, "config", "include.path", join(repo, "planted")]);
    let ticks = 0;
    const tick = setInterval(() => ticks++, 50);
    const t = Date.now();
    await warmRewrites(repo, true);
    clearInterval(tick);
    // The read waited (up to its own limit), the daemon's thread didn't: timers kept firing all along.
    expect(ticks).toBeGreaterThan(Math.floor((Date.now() - t) / 50) - 5);
    // Not read: the rules from / stand.
    expect(ownerPushRewrite("https://github.com/acme/app.git", repo)).toBe("https://github.com/acme/app.git");
  }, 20_000);

  test("an owner include target that is a FIFO: the rules from / aren't read; a missing one in a workspace is made empty and held", async () => {
    const { ownerConfigPlain, ownerConfigFiles } = await import("../daemon/git-gateway/connect.js");
    const { buildSandboxSpec } = await import("../daemon/sandbox/policy.js");
    process.env.HOME = home;
    const dots = join(home, "dotfiles");
    mkdirSync(dots);
    spawnSync("mkfifo", [join(dots, "fifo.gitconfig")]);
    writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ${join(dots, "fifo.gitconfig")}\n[include]\n\tpath = ${join(dots, "missing.gitconfig")}\n`);
    // ownerConfigFiles is cached a few seconds: a fresh home key each test.
    expect(ownerConfigFiles()).toContain(join(dots, "missing.gitconfig"));
    expect(ownerConfigPlain()).toBe(false);
    const spec = buildSandboxSpec({ sessionId: "r33", workspace: dots, tempDir: join(home, "t"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, cache: false, ownerConfigFiles: ownerConfigFiles() });
    expect(existsSync(join(dots, "missing.gitconfig"))).toBe(true);
    expect(spec.readOnly).toContain(realpathSync(join(dots, "missing.gitconfig")));
  });
});

describe("round 34: the sandbox's own looks at a repository read without blocking; owner config made with its dirs", () => {
  test("a FIFO .gitattributes, a FIFO worktree gitdir: the end-of-turn snapshot and the worktree list answer at once", async () => {
    const { gitControlSnapshot } = await import("../daemon/sandbox/git-watch.js");
    const { worktreeAdminsOf } = await import("../daemon/sandbox/worktrees.js");
    const repo = join(home, "r34");
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("mkfifo", [join(repo, ".gitattributes")]);
    mkdirSync(join(repo, ".git", "worktrees", "w"), { recursive: true });
    spawnSync("mkfifo", [join(repo, ".git", "worktrees", "w", "gitdir")]);
    const t = Date.now();
    gitControlSnapshot(repo, home);
    worktreeAdminsOf(join(repo, ".git"));
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  test("a missing owner include whose dir is missing too, in a workspace: both made, and held", async () => {
    const { ownerConfigFiles, warmOwnerConfig } = await import("../daemon/git-gateway/connect.js");
    const { buildSandboxSpec } = await import("../daemon/sandbox/policy.js");
    process.env.HOME = home;
    const dots = join(home, "dots34");
    mkdirSync(dots);
    const target = join(dots, "conf.d", "work.gitconfig");
    writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ${target}\n`);
    await warmOwnerConfig();
    expect(ownerConfigFiles()).toContain(target);
    const spec = buildSandboxSpec({ sessionId: "r34", workspace: dots, tempDir: join(home, "t34"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, cache: false, ownerConfigFiles: ownerConfigFiles() });
    expect(existsSync(target)).toBe(true);
    expect(spec.readOnly).toContain(realpathSync(target));
    expect(spec.readOnly).toContain(realpathSync(join(dots, "conf.d")));
  });
});

describe("round 35: placeholders only where the real dir is writable; no synchronous fallback after a failed read", () => {
  test("an owner include under a link out of the workspace: nothing is made there", async () => {
    const { ownerConfigFiles, warmOwnerConfig } = await import("../daemon/git-gateway/connect.js");
    const { buildSandboxSpec } = await import("../daemon/sandbox/policy.js");
    process.env.HOME = home;
    const dots = join(home, "dots35");
    const outside = join(home, "outside35");
    mkdirSync(dots);
    mkdirSync(outside);
    symlinkSync(outside, join(dots, "lnk"));
    const target = join(dots, "lnk", "sub", "x.gitconfig");
    writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ${target}\n`);
    await warmOwnerConfig();
    buildSandboxSpec({ sessionId: "r35", workspace: dots, tempDir: join(home, "t35"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, cache: false, ownerConfigFiles: ownerConfigFiles() });
    expect(existsSync(join(outside, "sub"))).toBe(false);
  });

  test("the rules from / read and failed: the rewrite is none, never a synchronous git run", async () => {
    const { warmRewrites, ownerRewrite } = await import("../daemon/git-gateway/connect.js");
    process.env.HOME = home;
    const dots = join(home, "dots35b");
    mkdirSync(dots);
    spawnSync("mkfifo", [join(dots, "slow.gitconfig")]);
    writeFileSync(join(home, ".gitconfig"), `[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[include]\n\tpath = ${join(dots, "slow.gitconfig")}\n`);
    await warmRewrites("/", true);
    const t = Date.now();
    expect(ownerRewrite("https://github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
    expect(Date.now() - t).toBeLessThan(500);
  }, 20_000);
});
