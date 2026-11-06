/**
 * Real bubblewrap (#448 follow-up), skipped where it can't run: an agent
 * makes git worktrees inside the sandbox, and tests that start containers
 * get the container runtime's socket only when the owner opted in.
 *
 * Everything destructive runs INSIDE the sandbox under test, against a
 * repository this test planted in its own temp dir; "the user's next git"
 * runs outside the session's sandbox, in a bubblewrap that may write only the
 * test's dir, and must run nothing a command planted. No real Docker socket
 * is touched: a listening unix socket this test makes stands in for one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { gitControlSnapshot } from "../daemon/sandbox/git-watch.js";
import { buildSandboxSpec, dockerSocketPaths } from "../daemon/sandbox/policy.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";
import { noteCodeoidWorktree, worktreeAdminsOf } from "../daemon/sandbox/worktrees.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();

/** Not under the host's /tmp, which the sandbox replaces with its own. */
function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const p = mkdtempSync(join(dir, "codeoid-wt-probe-"));
      rmSync(p, { recursive: true, force: true });
      return dir;
    } catch {
      /* next */
    }
  }
  return tmpdir();
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
}

function git(args: string[], cwd: string, home: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(home) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: an agent's own git worktrees", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-wt-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string>) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  /**
   * A repository with a commit, two worktrees of the user's (one beside it,
   * one in its `-worktrees` location), and one whose checkout is gone (as
   * after an unmounted disk: `git worktree prune` would remove it). The
   * session's baseline is what is there now, as SessionSandbox takes it.
   */
  function fixture(name: string, opts: { workspace?: "main" | "worktree" } = {}) {
    const dir = join(root, name);
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo, home);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "."], repo, home);
    git(["commit", "-qm", "init"], repo, home);
    const userWt = join(dir, "userwt");
    git(["worktree", "add", "-q", "-b", "user", userWt], repo, home);
    const userLoc = join(dir, "repo-worktrees", "userloc");
    git(["worktree", "add", "-q", "-b", "userloc", userLoc], repo, home);
    const gone = join(dir, "gone");
    git(["worktree", "add", "-q", "-b", "gone", gone], repo, home);
    rmSync(gone, { recursive: true, force: true });
    let ws = repo;
    if (opts.workspace === "worktree") {
      ws = join(dir, "repo-worktrees", "session");
      git(["worktree", "add", "-q", "-b", "session", ws], repo, home);
    }
    const common = join(repo, ".git");
    const marker = join(dir, "RAN-OUTSIDE");
    const mark = join(dir, "mark.sh");
    writeFileSync(mark, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const baseline = new Set(worktreeAdminsOf(common).map((a) => a.dir));
    const spec = () =>
      buildSandboxSpec({
        sessionId: name,
        workspace: ws,
        tempDir: tmp,
        network: { mode: "off" },
        hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
        worktreeBaseline: baseline,
      });
    return { dir, home, repo, ws, common, userWt, userLoc, gone, marker, mark, spec, env: gitEnv(home) };
  }

  /** The user's next git in `cwd`, outside the session's sandbox (it may write only the test's dir). */
  function userGit(f: { dir: string; home: string }, cwd: string): void {
    const bwrap = provider.binary() as string;
    Bun.spawnSync([bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", f.dir, f.dir, "--chdir", cwd, "--", "git", "status", "--short"], { env: gitEnv(f.home) });
  }

  test("git worktree add in the sibling -worktrees location, commit there, list, remove, add in .worktrees, prune: all from inside", async () => {
    const f = fixture("add");
    const h = await provider.open(f.spec());
    try {
      const add = await sh(h, f.repo, "git worktree add ../repo-worktrees/x -b feature/x && echo ADDED", f.env);
      expect(add.stderr).not.toContain("Operation not permitted");
      expect(add.stdout).toContain("ADDED");
      const commit = await sh(h, join(f.dir, "repo-worktrees", "x"), "echo x > x.txt && git add x.txt && git commit -qm in-worktree && echo COMMITTED && git rebase -q main && echo REBASED", f.env);
      expect(commit.stdout).toContain("COMMITTED");
      expect(commit.stdout).toContain("REBASED");
      const list = await sh(h, f.repo, "git worktree list --porcelain", f.env);
      expect(list.stdout).toContain(join(f.dir, "repo-worktrees", "x"));
      // A second one, in the repository's .worktrees, then both gone again.
      const more = await sh(h, f.repo, "git worktree add -q .worktrees/y -b y && echo ADDED-Y && git worktree remove ../repo-worktrees/x && echo REMOVED-X && git worktree remove .worktrees/y && echo REMOVED-Y", f.env);
      expect(more.stdout).toContain("ADDED-Y");
      expect(more.stdout).toContain("REMOVED-X");
      expect(more.stdout).toContain("REMOVED-Y");
      // prune runs; the user's admin dir whose checkout is gone (an unmounted disk) is not the session's to remove.
      const prune = await sh(h, f.repo, "git worktree prune; echo PRUNED", f.env);
      expect(prune.stdout).toContain("PRUNED");
    } finally {
      await h.close();
    }
    expect(git(["log", "--oneline", "feature/x"], f.repo, f.home)).toContain("in-worktree");
    expect(existsSync(join(f.dir, "repo-worktrees", "x"))).toBe(false);
    expect(existsSync(join(f.common, "worktrees", "x"))).toBe(false);
    expect(existsSync(join(f.common, "worktrees", "gone"))).toBe(true);
    expect(git(["status", "--short"], f.userLoc, f.home)).toBe("");
  });

  test("a worktree the session made stays its own in its next sandbox: committed in and removed there", async () => {
    const f = fixture("own");
    const h1 = await provider.open(f.spec());
    try {
      expect((await sh(h1, f.repo, "git worktree add -q ../repo-worktrees/mine -b mine && echo ADDED", f.env)).stdout).toContain("ADDED");
    } finally {
      await h1.close();
    }
    // The next sandbox (a backend restarted, the next query) is built with the same baseline.
    const h2 = await provider.open(f.spec());
    try {
      const r = await sh(h2, join(f.dir, "repo-worktrees", "mine"), "echo m > m.txt && git add m.txt && git commit -qm mine && echo COMMITTED && cd ../../repo && git worktree remove --force ../repo-worktrees/mine && echo REMOVED", f.env);
      expect(r.stdout).toContain("COMMITTED");
      expect(r.stdout).toContain("REMOVED");
    } finally {
      await h2.close();
    }
    expect(git(["log", "--oneline", "mine"], f.repo, f.home)).toContain("mine");
  });

  test("the user's worktrees can't be redirected, renamed, removed or pruned; worktrees/ can't be swapped; config and hooks stay read-only", async () => {
    for (const workspace of ["main", "worktree"] as const) {
      const f = fixture(`held-${workspace}`, { workspace });
      const wts = join(f.common, "worktrees");
      const h = await provider.open(f.spec());
      try {
        const r = await sh(
          h,
          f.ws,
          [
            `cp -r '${f.common}' "$PWD/.evil" && git --git-dir="$PWD/.evil" config core.fsmonitor '${f.mark}' && echo BUILT`,
            // An existing worktree's admin files: what decides where git looks.
            `echo "$PWD/.evil" > '${join(wts, "userwt", "commondir")}' 2>/dev/null && echo REWROTE-COMMONDIR || echo COMMONDIR-HELD`,
            `echo x > '${join(wts, "userwt", "gitdir")}' 2>/dev/null && echo REWROTE-GITDIR || echo GITDIR-HELD`,
            `echo '[core]' > '${join(wts, "userloc", "config.worktree")}' 2>/dev/null && echo WROTE-CONFIG-WORKTREE || echo CONFIG-WORKTREE-HELD`,
            // Renamed away, then planted again under its name.
            `mv '${join(wts, "userwt")}' '${join(wts, "moved")}' 2>/dev/null && echo MOVED-ADMIN || echo ADMIN-PINNED`,
            `rm -rf '${join(wts, "userwt")}' 2>/dev/null; [ -f '${join(wts, "userwt", "commondir")}' ] && echo ADMIN-KEPT || echo ADMIN-REMOVED`,
            `mv '${wts}' '${join(f.common, "wt-old")}' 2>/dev/null && echo MOVED-WORKTREES || echo WORKTREES-PINNED`,
            // The checkout in a worktree location the session didn't make: not removed, not redirected.
            `git worktree remove --force '${f.userLoc}' 2>/dev/null && echo REMOVED-USERLOC || echo USERLOC-NOT-REMOVED`,
            `echo "gitdir: $PWD/.evil" > '${join(f.userLoc, ".git")}' 2>/dev/null && echo REDIRECTED-USERLOC || echo USERLOC-DOTGIT-HELD`,
            `echo hi > '${join(f.userLoc, "new.txt")}' 2>/dev/null && echo WROTE-USERLOC || echo USERLOC-READ-ONLY`,
            // The checkout outside every location: its .git file isn't the session's either.
            `echo "gitdir: $PWD/.evil" > '${join(f.userWt, ".git")}' 2>/dev/null && echo REDIRECTED-USERWT || echo USERWT-HELD`,
            // A prunable worktree of the user's (its disk unmounted) stays.
            "git worktree prune 2>/dev/null; echo PRUNE-RAN",
            `[ -d '${join(wts, "gone")}' ] && echo GONE-KEPT || echo GONE-PRUNED`,
            // The repository's own structure, as before.
            `echo bad >> '${join(f.common, "config")}' 2>/dev/null && echo WROTE-CONFIG || echo CONFIG-HELD`,
            `echo bad > '${join(f.common, "hooks", "post-checkout")}' 2>/dev/null && echo WROTE-HOOK || echo HOOKS-HELD`,
            `echo bad > '${join(f.common, "info", "attributes")}' 2>/dev/null && echo WROTE-INFO || echo INFO-HELD`,
          ].join("; "),
          f.env,
        );
        expect(r.stdout).toContain("BUILT");
        for (const held of ["COMMONDIR-HELD", "GITDIR-HELD", "CONFIG-WORKTREE-HELD", "ADMIN-PINNED", "ADMIN-KEPT", "WORKTREES-PINNED", "USERLOC-NOT-REMOVED", "USERLOC-DOTGIT-HELD", "USERLOC-READ-ONLY", "USERWT-HELD", "PRUNE-RAN", "GONE-KEPT", "CONFIG-HELD", "HOOKS-HELD", "INFO-HELD"]) {
          expect(r.stdout).toContain(held);
        }
        // Still: a worktree of its own, and a commit where it works.
        const own = await sh(h, f.ws, "git worktree add -q ../repo-worktrees/agent -b agent 2>&1 && echo ADDED", f.env);
        expect(own.stdout).toContain("ADDED");
        writeFileSync(join(f.ws, "w.txt"), "w\n");
        expect((await sh(h, f.ws, "git add w.txt && git commit -qm inside && echo COMMITTED", f.env)).stdout).toContain("COMMITTED");
      } finally {
        await h.close();
      }
      expect(readFileSync(join(f.userLoc, "a.txt"), "utf8")).toBe("a\n");
      for (const at of [f.ws, f.userWt, f.userLoc, f.repo]) userGit(f, at);
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  test("planting an admin dir: a new one is the session's own, never one a checkout of the user's names", async () => {
    const f = fixture("plant");
    const wts = join(f.common, "worktrees");
    const h = await provider.open(f.spec());
    try {
      // The user's checkout names worktrees/userwt: held, so nothing can be laid in its place.
      const r = await sh(
        h,
        f.repo,
        `cp -r '${f.common}' "$PWD/.evil" && git --git-dir="$PWD/.evil" config core.fsmonitor '${f.mark}'; mkdir -p '${join(wts, "userwt", "x")}' 2>/dev/null && echo MADE-IN-USERS || echo USERS-HELD; echo "$PWD/.evil" > '${join(wts, "userwt", "commondir.new")}' 2>/dev/null && echo WROTE-BESIDE || echo USERS-DIR-HELD`,
        f.env,
      );
      expect(r.stdout).toContain("USERS-HELD");
      expect(r.stdout).toContain("USERS-DIR-HELD");
    } finally {
      await h.close();
    }
    userGit(f, f.userWt);
    expect(existsSync(f.marker)).toBe(false);
  });

  test("a worktree added by someone else after the session started is held in the session's next sandbox (outside the locations, or made by codeoid)", async () => {
    const f = fixture("late");
    const late = join(f.dir, "late");
    git(["worktree", "add", "-q", "-b", "late", late], f.repo, f.home);
    const fork = join(f.dir, "repo-worktrees", "fork");
    noteCodeoidWorktree(fork);
    git(["worktree", "add", "-q", "-b", "fork", fork], f.repo, f.home);
    const h = await provider.open(f.spec());
    try {
      const r = await sh(
        h,
        f.repo,
        `echo x > '${join(f.common, "worktrees", "late", "commondir")}' 2>/dev/null && echo REWROTE-LATE || echo LATE-HELD; echo x > '${join(f.common, "worktrees", "fork", "commondir")}' 2>/dev/null && echo REWROTE-FORK || echo FORK-HELD; echo x > '${join(fork, "f.txt")}' 2>/dev/null && echo WROTE-FORK || echo FORK-CHECKOUT-HELD`,
        f.env,
      );
      expect(r.stdout).toContain("LATE-HELD");
      expect(r.stdout).toContain("FORK-HELD");
      expect(r.stdout).toContain("FORK-CHECKOUT-HELD");
    } finally {
      await h.close();
    }
  });

  test("the end-of-turn warning: a worktree git made reads as nothing changed; one naming another repository is named", async () => {
    const f = fixture("watch");
    const before = gitControlSnapshot(f.repo, f.home);
    const h = await provider.open(f.spec());
    try {
      await sh(h, f.repo, "git worktree add -q ../repo-worktrees/w -b w", f.env);
    } finally {
      await h.close();
    }
    const after = gitControlSnapshot(f.repo, f.home);
    expect([...after.keys()].filter((k) => !before.has(k))).toEqual([]);
    writeFileSync(join(f.common, "worktrees", "w", "commondir"), "/elsewhere\n");
    expect([...gitControlSnapshot(f.repo, f.home).keys()].some((k) => k.includes("worktrees/w/commondir"))).toBe(true);
  });

  test("a location planted as a link (.worktrees in the main checkout, made by a command) leads no later session anywhere", async () => {
    const f = fixture("link");
    const elsewhere = join(f.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "keep\n");
    // A session in the main checkout: its workspace, so it may make `.worktrees` a link.
    const h = await provider.open(f.spec());
    try {
      expect((await sh(h, f.repo, `ln -s '${elsewhere}' .worktrees && echo LINKED`, f.env)).stdout).toContain("LINKED");
    } finally {
      await h.close();
    }
    // A later session in a linked worktree of the repository: `.worktrees` would be a location of its own.
    const ws = join(f.dir, "repo-worktrees", "later");
    git(["worktree", "add", "-q", "-b", "later", ws], f.repo, f.home);
    const spec = buildSandboxSpec({ sessionId: "later", workspace: ws, tempDir: join(f.dir, "tmp"), network: { mode: "off" }, hidden: { home: f.home, configDir: join(f.home, ".codeoid"), env: { HOME: f.home }, daemonTmp: "/tmp" } });
    expect(spec.worktreeLocations ?? []).not.toContain(elsewhere);
    expect(spec.writable).not.toContain(elsewhere);
    const h2 = await provider.open(spec);
    try {
      const r = await sh(h2, ws, `echo x > '${join(elsewhere, "keep.txt")}' 2>/dev/null && echo WROTE || echo ELSEWHERE-READ-ONLY`, f.env);
      expect(r.stdout).toContain("ELSEWHERE-READ-ONLY");
    } finally {
      await h2.close();
    }
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("sandbox.worktreeRoots: a configured location is writable; one holding the repository, or the home, is not", async () => {
    const f = fixture("roots");
    const extra = join(f.dir, "elsewhere", "wts");
    const config = { sandbox: { worktreeRoots: [extra, "..", "~"] } } as never;
    const spec = buildSandboxSpec({
      sessionId: "roots",
      workspace: f.repo,
      tempDir: join(f.dir, "tmp"),
      network: { mode: "off" },
      config,
      hidden: { home: f.home, configDir: join(f.home, ".codeoid"), env: { HOME: f.home }, daemonTmp: "/tmp" },
      worktreeBaseline: new Set(worktreeAdminsOf(f.common).map((a) => a.dir)),
    });
    expect(spec.worktreeLocations).toContain(realpathSync(extra));
    expect(spec.worktreeLocations).not.toContain(f.dir);
    expect(spec.worktreeLocations).not.toContain(f.home);
    const h = await provider.open(spec);
    try {
      const r = await sh(h, f.repo, `git worktree add -q '${join(extra, "e")}' -b e && echo ADDED; echo x > '${join(f.dir, "beside.txt")}' 2>/dev/null && echo WROTE-PARENT || echo PARENT-READ-ONLY`, f.env);
      expect(r.stdout).toContain("ADDED");
      expect(r.stdout).toContain("PARENT-READ-ONLY");
    } finally {
      await h.close();
    }
  });
});

describe.skipIf(!probe.available)("bubblewrap, for real: Docker access (a planted socket stands in for the runtime's)", () => {
  let root: string;
  let runtime: string;
  let sock: string;
  let server: Server;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-docker-")));
    // Rootless Docker's place: $XDG_RUNTIME_DIR/docker.sock, in a dir every sandbox hides.
    runtime = join(root, "run-user");
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(join(root, "ws"));
    mkdirSync(join(root, "tmp"));
    sock = join(runtime, "docker.sock");
    server = createServer((c) => c.end("PLANTED-RUNTIME\n"));
    await new Promise<void>((r) => server.listen(sock, r));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  const env = () => ({ HOME: join(root, "home"), XDG_RUNTIME_DIR: runtime, PATH: process.env.PATH ?? "/usr/bin:/bin" });
  const spec = (dockerSocket: boolean, network: "on" | "off" = "off") =>
    buildSandboxSpec({
      sessionId: "docker",
      workspace: join(root, "ws"),
      tempDir: join(root, "tmp"),
      network: { mode: network },
      git: false,
      dockerSocket,
      hidden: { home: join(root, "home"), configDir: join(root, "home", ".codeoid"), env: env(), daemonTmp: "/tmp" },
    });
  const connect = (h: SandboxHandle, target: string) =>
    h.exec(["/bin/sh", "-c", `python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print(s.recv(100).decode().strip())' '${target}' 2>&1; echo "DOCKER_HOST=$DOCKER_HOST"`], { cwd: join(root, "ws"), env: { PATH: "/usr/bin:/bin", DOCKER_HOST: "unix:///host-value" }, timeoutMs: 20_000 });

  test.skipIf(!Bun.which("python3"))("hidden by default; reachable, with DOCKER_HOST naming it, only with the option (network off too)", async () => {
    expect(dockerSocketPaths(join(root, "home"), env())).toEqual([sock]);
    const off = spec(false);
    expect(off.dockerSockets).toBeUndefined();
    const h0 = await provider.open(off);
    try {
      const r = await connect(h0, sock);
      expect(r.stdout).not.toContain("PLANTED-RUNTIME");
      expect(r.stdout).toContain("DOCKER_HOST=\n");
    } finally {
      await h0.close();
    }
    for (const network of ["off", "on"] as const) {
      const on = spec(true, network);
      expect(on.dockerSockets).toEqual([sock]);
      const h1 = await provider.open(on);
      try {
        const r = await connect(h1, sock);
        expect(r.stdout).toContain("PLANTED-RUNTIME");
        expect(r.stdout).toContain(`DOCKER_HOST=unix://${sock}`);
        // Reachable, never removable or replaceable.
        const rm = await h1.exec(["/bin/sh", "-c", `rm -f '${sock}' 2>/dev/null; [ -S '${sock}' ] && echo SOCKET-KEPT`], { cwd: join(root, "ws"), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
        expect(rm.stdout).toContain("SOCKET-KEPT");
        // The rest of the runtime dir stays hidden.
        const ls = await h1.exec(["/bin/sh", "-c", `ls -A '${runtime}'`], { cwd: join(root, "ws"), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
        expect(ls.stdout.trim()).toBe("docker.sock");
      } finally {
        await h1.close();
      }
    }
  });
});
