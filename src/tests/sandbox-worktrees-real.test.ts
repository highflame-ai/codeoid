/**
 * Real bubblewrap (#448 follow-up, round 10), skipped where it can't run: an
 * agent makes git worktrees inside the sandbox, in its own folder of each
 * worktree location only, and tests that start containers get the container
 * runtime's socket only when the owner opted in (no other runtime's).
 *
 * Everything destructive runs INSIDE the sandbox under test, against a
 * repository this test planted in its own temp dir; "the user's next git"
 * runs outside the session's sandbox, in a bubblewrap that may write only the
 * test's dir, and must run nothing a command planted. No real Docker socket
 * is touched: a listening unix socket this test makes stands in for one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { gitControlChanges, gitControlSnapshot } from "../daemon/sandbox/git-watch.js";
import { buildSandboxSpec, dockerSocketPaths } from "../daemon/sandbox/policy.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { SessionSandbox } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";
import { noteCodeoidWorktree } from "../daemon/sandbox/worktrees.js";

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

const FOLDER = "agent-1111aaaa";

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: an agent's own git worktrees, in its own folder (#448 round 10)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-wt-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string>) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  /**
   * A repository with a commit; the user's worktrees (one beside it, one in
   * its `-worktrees` location); one whose checkout is gone (as after an
   * unmounted disk); another session's worktree in its own folder there; and
   * a codeoid fork's checkout. The session under test is `FOLDER`'s.
   */
  function fixture(name: string, opts: { workspace?: "main" | "worktree"; config?: unknown } = {}) {
    const dir = join(root, name);
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo, home);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "."], repo, home);
    git(["commit", "-qm", "init"], repo, home);
    const loc = join(dir, "repo-worktrees");
    const userWt = join(dir, "userwt");
    git(["worktree", "add", "-q", "-b", "user", userWt], repo, home);
    const userLoc = join(loc, "userloc");
    git(["worktree", "add", "-q", "-b", "userloc", userLoc], repo, home);
    const gone = join(dir, "gone");
    git(["worktree", "add", "-q", "-b", "gone", gone], repo, home);
    rmSync(gone, { recursive: true, force: true });
    // Another session's worktree, in its folder.
    const otherWt = join(loc, "other-2222bbbb", "ow");
    git(["worktree", "add", "-q", "-b", "ow", otherWt], repo, home);
    // A codeoid fork's checkout.
    const fork = join(loc, "fork-3333cccc");
    noteCodeoidWorktree(fork);
    git(["worktree", "add", "-q", "-b", "fork", fork], repo, home);
    let ws = repo;
    if (opts.workspace === "worktree") {
      ws = join(loc, "session-4444dddd");
      noteCodeoidWorktree(ws);
      git(["worktree", "add", "-q", "-b", "session", ws], repo, home);
    }
    const common = join(repo, ".git");
    const marker = join(dir, "RAN-OUTSIDE");
    const mark = join(dir, "mark.sh");
    writeFileSync(mark, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const spec = (folder: string = FOLDER) =>
      buildSandboxSpec({
        sessionId: name,
        workspace: ws,
        tempDir: tmp,
        network: { mode: "off" },
        ...(opts.config ? { config: opts.config as never } : {}),
        hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
        worktreeFolder: folder,
      });
    return { dir, home, repo, ws, loc, own: join(loc, FOLDER), common, userWt, userLoc, gone, otherWt, fork, marker, mark, spec, env: gitEnv(home) };
  }

  /** The user's next git in `cwd`, outside the session's sandbox (it may write only the test's dir). */
  function userGit(f: { dir: string; home: string }, cwd: string): void {
    const bwrap = provider.binary() as string;
    Bun.spawnSync([bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", f.dir, f.dir, "--chdir", cwd, "--", "git", "status", "--short"], { env: gitEnv(f.home) });
  }

  test("in its own folder: git worktree add, commit, rebase, list, remove, prune; from a linked worktree too; still its own in the next sandbox", async () => {
    for (const workspace of ["main", "worktree"] as const) {
      const f = fixture(`add-${workspace}`, { workspace });
      const spec = f.spec();
      // Only beside the repository: nothing is made in the main checkout (#448 round 11).
      expect(spec.worktreeFolders).toEqual([f.own]);
      expect(existsSync(join(f.repo, ".worktrees"))).toBe(false);
      const h = await provider.open(spec);
      try {
        const add = await sh(h, f.ws, `git worktree add '${join(f.own, "x")}' -b feature/x 2>&1 && echo ADDED`, f.env);
        expect(add.stdout).toContain("ADDED");
        const commit = await sh(h, join(f.own, "x"), "echo x > x.txt && git add x.txt && git commit -qm in-worktree && echo COMMITTED && git rebase -q main && echo REBASED", f.env);
        expect(commit.stdout).toContain("COMMITTED");
        expect(commit.stdout).toContain("REBASED");
        expect((await sh(h, f.ws, "git worktree list --porcelain", f.env)).stdout).toContain(join(f.own, "x"));
        expect((await sh(h, f.ws, `git worktree remove '${join(f.own, "x")}' && echo REMOVED && git worktree prune && echo PRUNED`, f.env)).stdout).toContain("PRUNED");
        expect((await sh(h, f.ws, `git worktree add -q '${join(f.own, "mine")}' -b mine-${workspace} && echo ADDED`, f.env)).stdout).toContain("ADDED");
      } finally {
        await h.close();
      }
      // The next sandbox (a backend restarted, the next query, a daemon restart): it is checked out in the session's folder.
      const h2 = await provider.open(f.spec());
      try {
        const r = await sh(h2, join(f.own, "mine"), `echo m > m.txt && git add m.txt && git commit -qm mine && echo COMMITTED && cd '${f.ws}' && git worktree remove --force '${join(f.own, "mine")}' && echo REMOVED`, f.env);
        expect(r.stdout).toContain("COMMITTED");
        expect(r.stdout).toContain("REMOVED");
      } finally {
        await h2.close();
      }
      expect(git(["log", "--oneline", "feature/x"], f.repo, f.home)).toContain("in-worktree");
      expect(git(["log", "--oneline", `mine-${workspace}`], f.repo, f.home)).toContain("mine");
      expect(existsSync(join(f.common, "worktrees", "x"))).toBe(false);
      expect(existsSync(join(f.common, "worktrees", "gone"))).toBe(true);
      expect(git(["status", "--short"], f.userLoc, f.home)).toBe("");
    }
  });

  test("anywhere else in a location it fails (Read-only file system): the location itself, another session's folder, a .worktrees you have in the main checkout from a session there", async () => {
    const f = fixture("elsewhere");
    // Yours, from before: no location (nothing is made there), but held for a session working in the checkout.
    mkdirSync(join(f.repo, ".worktrees"));
    const h = await provider.open(f.spec());
    try {
      const r = await sh(
        h,
        f.repo,
        [
          `git worktree add '${join(f.loc, "x")}' -b x 2>&1 && echo ADDED-IN-LOCATION || echo LOCATION-REFUSED`,
          `git worktree add '${join(f.loc, "other-2222bbbb", "y")}' -b y 2>&1 && echo ADDED-IN-OTHER || echo OTHER-REFUSED`,
          `mkdir '${join(f.loc, "mine-too")}' 2>&1 && echo MADE-FOLDER || echo FOLDER-REFUSED`,
          "git worktree add .worktrees/z -b z 2>&1 && echo ADDED-DOT || echo DOT-REFUSED",
        ].join("; "),
        f.env,
      );
      for (const w of ["LOCATION-REFUSED", "OTHER-REFUSED", "FOLDER-REFUSED", "DOT-REFUSED"]) expect(r.stdout).toContain(w);
      expect(r.stdout).toContain("Read-only file system");
    } finally {
      await h.close();
    }
    for (const p of [join(f.loc, "x"), join(f.loc, "other-2222bbbb", "y"), join(f.loc, "mine-too"), join(f.repo, ".worktrees", "z")]) expect(existsSync(p)).toBe(false);
  });

  test("another session's folder, the user's worktrees and a codeoid fork stay read-only, and so do a folder and a fork made after the sandbox opened", async () => {
    for (const workspace of ["main", "worktree"] as const) {
      const f = fixture(`others-${workspace}`, { workspace });
      const h = await provider.open(f.spec());
      // Made while the sandbox runs: another session's folder with a worktree in it, and a codeoid fork.
      const lateOther = join(f.loc, "late-5555eeee", "lw");
      git(["worktree", "add", "-q", "-b", "lw", lateOther], f.repo, f.home);
      const lateFork = join(f.loc, "fork2-6666ffff");
      noteCodeoidWorktree(lateFork);
      git(["worktree", "add", "-q", "-b", "fork2", lateFork], f.repo, f.home);
      try {
        const lines: string[] = [];
        for (const [tag, at] of [["OTHER", f.otherWt], ["USERLOC", f.userLoc], ["USERWT", f.userWt], ["FORK", f.fork], ["LATE", lateOther], ["LATEFORK", lateFork]] as const) {
          lines.push(`echo hi > '${join(at, "new.txt")}' 2>/dev/null && echo WROTE-${tag} || echo ${tag}-READ-ONLY`);
          lines.push(`echo "gitdir: /planted" > '${join(at, ".git")}' 2>/dev/null && echo REDIRECTED-${tag} || echo ${tag}-DOTGIT-HELD`);
          lines.push(`mkdir -p '${join(at, ".claude")}' 2>/dev/null; echo '{}' > '${join(at, ".claude", "settings.json")}' 2>/dev/null && echo SETTINGS-${tag} || echo ${tag}-SETTINGS-HELD`);
        }
        lines.push(`git worktree remove --force '${f.otherWt}' 2>/dev/null && echo REMOVED-OTHER || echo OTHER-NOT-REMOVED`);
        lines.push(`mkdir '${join(f.loc, "late-5555eeee", "planted")}' 2>/dev/null && echo WROTE-LATE-FOLDER || echo LATE-FOLDER-READ-ONLY`);
        const r = await sh(h, f.ws, lines.join("; "), f.env);
        for (const tag of ["OTHER", "USERLOC", "USERWT", "FORK", "LATE", "LATEFORK"]) {
          expect(r.stdout).toContain(`${tag}-READ-ONLY`);
          expect(r.stdout).toContain(`${tag}-DOTGIT-HELD`);
          expect(r.stdout).toContain(`${tag}-SETTINGS-HELD`);
        }
        expect(r.stdout).toContain("OTHER-NOT-REMOVED");
        expect(r.stdout).toContain("LATE-FOLDER-READ-ONLY");
      } finally {
        await h.close();
      }
      // The next sandbox holds the late ones' admin dirs too.
      const h2 = await provider.open(f.spec());
      try {
        const r = await sh(h2, f.ws, `echo x > '${join(f.common, "worktrees", "lw", "commondir")}' 2>/dev/null && echo REWROTE-LATE || echo LATE-ADMIN-HELD; echo x > '${join(f.common, "worktrees", "fork2-6666ffff", "commondir")}' 2>/dev/null && echo REWROTE-FORK || echo FORK-ADMIN-HELD`, f.env);
        expect(r.stdout).toContain("LATE-ADMIN-HELD");
        expect(r.stdout).toContain("FORK-ADMIN-HELD");
      } finally {
        await h2.close();
      }
      for (const at of [f.otherWt, f.userLoc, f.userWt, f.fork, lateOther, lateFork]) {
        expect(existsSync(join(at, "new.txt"))).toBe(false);
        expect(readFileSync(join(at, ".git"), "utf8")).not.toContain("planted");
        userGit(f, at);
      }
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  test("the repository's existing worktrees can't be redirected, renamed, removed or pruned; worktrees/ can't be swapped; config and hooks stay read-only", async () => {
    for (const workspace of ["main", "worktree"] as const) {
      const f = fixture(`held-${workspace}`, { workspace });
      const wts = join(f.common, "worktrees");
      const h = await provider.open(f.spec());
      try {
        const r = await sh(
          h,
          f.ws,
          [
            `cp -r '${f.common}' '${join(f.own, "evil")}' && git --git-dir='${join(f.own, "evil")}' config core.fsmonitor '${f.mark}' && echo BUILT`,
            // An existing worktree's admin files: what decides where git looks.
            `echo '${join(f.own, "evil")}' > '${join(wts, "userwt", "commondir")}' 2>/dev/null && echo REWROTE-COMMONDIR || echo COMMONDIR-HELD`,
            `echo x > '${join(wts, "userwt", "gitdir")}' 2>/dev/null && echo REWROTE-GITDIR || echo GITDIR-HELD`,
            `echo '[core]' > '${join(wts, "userloc", "config.worktree")}' 2>/dev/null && echo WROTE-CONFIG-WORKTREE || echo CONFIG-WORKTREE-HELD`,
            `echo x > '${join(wts, "ow", "commondir")}' 2>/dev/null && echo REWROTE-OTHER-ADMIN || echo OTHER-ADMIN-HELD`,
            // Renamed away, then planted again under its name.
            `mv '${join(wts, "userwt")}' '${join(wts, "moved")}' 2>/dev/null && echo MOVED-ADMIN || echo ADMIN-PINNED`,
            `rm -rf '${join(wts, "userwt")}' 2>/dev/null; [ -f '${join(wts, "userwt", "commondir")}' ] && echo ADMIN-KEPT || echo ADMIN-REMOVED`,
            `mv '${wts}' '${join(f.common, "wt-old")}' 2>/dev/null && echo MOVED-WORKTREES || echo WORKTREES-PINNED`,
            // A prunable worktree of the user's (its disk unmounted) stays.
            "git worktree prune 2>/dev/null; echo PRUNE-RAN",
            `[ -d '${join(wts, "gone")}' ] && echo GONE-KEPT || echo GONE-PRUNED`,
            // The session's own folder can't be renamed away either.
            `mv '${f.own}' '${join(f.own, "..", "renamed")}' 2>/dev/null && echo MOVED-OWN || echo OWN-PINNED`,
            // The repository's own structure, as before.
            `echo bad >> '${join(f.common, "config")}' 2>/dev/null && echo WROTE-CONFIG || echo CONFIG-HELD`,
            `echo bad > '${join(f.common, "hooks", "post-checkout")}' 2>/dev/null && echo WROTE-HOOK || echo HOOKS-HELD`,
            `echo bad > '${join(f.common, "info", "attributes")}' 2>/dev/null && echo WROTE-INFO || echo INFO-HELD`,
          ].join("; "),
          f.env,
        );
        expect(r.stdout).toContain("BUILT");
        for (const held of ["COMMONDIR-HELD", "GITDIR-HELD", "CONFIG-WORKTREE-HELD", "OTHER-ADMIN-HELD", "ADMIN-PINNED", "ADMIN-KEPT", "WORKTREES-PINNED", "PRUNE-RAN", "GONE-KEPT", "OWN-PINNED", "CONFIG-HELD", "HOOKS-HELD", "INFO-HELD"]) {
          expect(r.stdout).toContain(held);
        }
        // Still: a commit where it works.
        writeFileSync(join(f.ws, "w.txt"), "w\n");
        expect((await sh(h, f.ws, "git add w.txt && git commit -qm inside && echo COMMITTED", f.env)).stdout).toContain("COMMITTED");
      } finally {
        await h.close();
      }
      for (const at of [f.ws, f.userWt, f.userLoc, f.repo, f.otherWt]) userGit(f, at);
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  test("planting an admin dir under a held one's name fails; a new one is the session's own only when checked out in its folder", async () => {
    const f = fixture("plant");
    const wts = join(f.common, "worktrees");
    const h = await provider.open(f.spec());
    try {
      const r = await sh(
        h,
        f.repo,
        `mkdir -p '${join(wts, "userwt", "x")}' 2>/dev/null && echo MADE-IN-USERS || echo USERS-HELD; echo x > '${join(wts, "userwt", "commondir.new")}' 2>/dev/null && echo WROTE-BESIDE || echo USERS-DIR-HELD`,
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

  test("a session's sandbox spec is built again when a worktree appears: a fork made after its first query is held from then on (SessionSandbox)", async () => {
    const f = fixture("refresh");
    const registry = new SandboxRegistry("linux");
    registry.register(provider);
    const sbx = new SessionSandbox({ sessionId: "1111aaaa-0000-4000-8000-000000000000", name: "agent", workdir: f.repo, registry, setting: { provider: "bwrap", network: "off" } });
    try {
      const info = await sbx.refresh("pi");
      expect(info.state).toBe("on");
      const rt = sbx.runtimeFor("pi");
      if (!rt) throw new Error("no runtime");
      const first = rt.spec;
      expect(rt.spec).toBe(first);
      expect(sbx.worktreeFolders()).toEqual([join(f.loc, FOLDER)]);
      const fork = join(f.loc, "fork9-7777aaaa");
      noteCodeoidWorktree(fork);
      git(["worktree", "add", "-q", "-b", "fork9", fork], f.repo, f.home);
      const next = rt.spec;
      expect(next).not.toBe(first);
      expect(next.readOnly).toContain(join(f.common, "worktrees", "fork9-7777aaaa"));
      const h = await provider.open(next);
      try {
        const r = await sh(h, f.repo, `echo x > '${join(f.common, "worktrees", "fork9-7777aaaa", "commondir")}' 2>/dev/null && echo REWROTE || echo FORK-ADMIN-HELD; echo x > '${join(fork, "f.txt")}' 2>/dev/null && echo WROTE || echo FORK-CHECKOUT-HELD`, f.env);
        expect(r.stdout).toContain("FORK-ADMIN-HELD");
        expect(r.stdout).toContain("FORK-CHECKOUT-HELD");
      } finally {
        await h.close();
      }
    } finally {
      await sbx.close();
    }
    // Its folder, left empty, is removed with the session.
    expect(existsSync(join(f.loc, FOLDER))).toBe(false);
  });

  test("the end-of-turn warning: a worktree git made in the session's folder reads as nothing changed; its .git pointed at a planted git dir is named", async () => {
    const f = fixture("watch");
    const opts = { ownFolders: [f.own] };
    const spec = f.spec();
    const before = gitControlSnapshot(f.repo, f.home, opts);
    const h = await provider.open(spec);
    try {
      await sh(h, f.repo, `git worktree add -q '${join(f.own, "w")}' -b w`, f.env);
    } finally {
      await h.close();
    }
    const after = gitControlSnapshot(f.repo, f.home, opts);
    expect(gitControlChanges(before, after)).toEqual([]);
    // The agent redirects its own worktree's .git to a copy of the git dir carrying core.fsmonitor.
    const h2 = await provider.open(spec);
    try {
      const r = await sh(
        h2,
        f.repo,
        `cp -r '${f.common}' '${join(f.own, ".evil")}' && git --git-dir='${join(f.own, ".evil")}' config core.fsmonitor '${f.mark}' && echo "gitdir: ${join(f.own, ".evil")}" > '${join(f.own, "w", ".git")}' && echo REDIRECTED`,
        f.env,
      );
      expect(r.stdout).toContain("REDIRECTED");
    } finally {
      await h2.close();
    }
    const changed = gitControlChanges(after, gitControlSnapshot(f.repo, f.home, opts));
    expect(changed).toContain(join(f.own, "w", ".git"));
    // A .git dir planted in the folder (a repository of its own, its config obeyed there) is named too.
    const before3 = gitControlSnapshot(f.repo, f.home, opts);
    mkdirSync(join(f.own, "clone", ".git"), { recursive: true });
    writeFileSync(join(f.own, "clone", ".git", "config"), "[core]\n");
    expect(gitControlChanges(before3, gitControlSnapshot(f.repo, f.home, opts))).toContain(join(f.own, "clone", ".git"));
    // Another's admin dir changed is named; one removed is not news.
    const before4 = gitControlSnapshot(f.repo, f.home, opts);
    writeFileSync(join(f.common, "worktrees", "ow", "gitdir"), "/elsewhere/.git\n");
    rmSync(join(f.common, "worktrees", "userloc"), { recursive: true, force: true });
    expect(gitControlChanges(before4, gitControlSnapshot(f.repo, f.home, opts))).toEqual([".git/worktrees/ow/gitdir"]);
  });

  test("a location planted as a link (.worktrees in the main checkout, made by a command) leads no later session anywhere", async () => {
    const f = fixture("link");
    const elsewhere = join(f.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "keep\n");
    // Made by a command before any sandbox held .worktrees (or by hand).
    rmSync(join(f.repo, ".worktrees"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(f.repo, ".worktrees"));
    // A later session in a linked worktree of the repository: `.worktrees` would be a location of its own.
    const ws = join(f.loc, "later");
    git(["worktree", "add", "-q", "-b", "later", ws], f.repo, f.home);
    const spec = buildSandboxSpec({ sessionId: "later", workspace: ws, tempDir: join(f.dir, "tmp"), network: { mode: "off" }, hidden: { home: f.home, configDir: join(f.home, ".codeoid"), env: { HOME: f.home }, daemonTmp: "/tmp" }, worktreeFolder: "later-8888aaaa" });
    expect(spec.worktreeFolders ?? []).toEqual([join(f.loc, "later-8888aaaa")]);
    expect(spec.writable.some((w) => w.startsWith(elsewhere))).toBe(false);
    const h2 = await provider.open(spec);
    try {
      const r = await sh(h2, ws, `echo x > '${join(elsewhere, "keep.txt")}' 2>/dev/null && echo WROTE || echo ELSEWHERE-READ-ONLY`, f.env);
      expect(r.stdout).toContain("ELSEWHERE-READ-ONLY");
    } finally {
      await h2.close();
    }
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
  });

  test("sandbox.worktreeRoots: a root shared by repositories gets <root>/<repo>/<folder>; another repository's worktree there stays read-only; a missing root elsewhere isn't made; a refused one isn't used", async () => {
    const base = join(root, "roots-elsewhere");
    const shared = join(base, "shared");
    mkdirSync(shared, { recursive: true });
    const f = fixture("roots", { config: { sandbox: { worktreeRoots: [shared, join(base, "missing"), "../beside", "~/.config", "~"] } } });
    // Repository B's worktree in the shared root (the docs' old `~/wt` shape).
    const b = join(base, "b");
    mkdirSync(b);
    git(["init", "-q", "-b", "main"], b, f.home);
    writeFileSync(join(b, "b.txt"), "b\n");
    git(["add", "."], b, f.home);
    git(["commit", "-qm", "b"], b, f.home);
    const bFeat = join(shared, "b-feat");
    git(["worktree", "add", "-q", "-b", "feat", bFeat], b, f.home);
    const spec = f.spec();
    const mine = join(shared, "repo", FOLDER);
    const beside = join(f.dir, "beside", "repo", FOLDER);
    expect(spec.worktreeFolders).toEqual([f.own, mine, beside]);
    expect(existsSync(join(base, "missing"))).toBe(false);
    const h = await provider.open(spec);
    try {
      const r = await sh(
        h,
        f.repo,
        [
          `git worktree add -q '${join(mine, "e")}' -b e && echo ADDED`,
          `echo "gitdir: /planted" > '${join(bFeat, ".git")}' 2>/dev/null && echo REDIRECTED-B || echo B-DOTGIT-HELD`,
          `echo x > '${join(bFeat, "b.txt")}' 2>/dev/null && echo WROTE-B || echo B-READ-ONLY`,
          `mkdir '${join(shared, "x")}' 2>/dev/null && echo WROTE-ROOT || echo ROOT-READ-ONLY`,
        ].join("; "),
        f.env,
      );
      for (const w of ["ADDED", "B-DOTGIT-HELD", "B-READ-ONLY", "ROOT-READ-ONLY"]) expect(r.stdout).toContain(w);
    } finally {
      await h.close();
    }
    expect(readFileSync(join(bFeat, ".git"), "utf8")).not.toContain("planted");
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
    // A session libvirt's socket beside it ($XDG_RUNTIME_DIR/libvirt/libvirt-sock): a VM with the host's disk.
    mkdirSync(join(runtime, "libvirt"), { mode: 0o700 });
    libvirtSock = join(runtime, "libvirt", "libvirt-sock");
    libvirt = createServer((c) => c.end("PLANTED-LIBVIRT\n"));
    await new Promise<void>((r) => libvirt.listen(libvirtSock, r));
  });
  let libvirt: Server;
  let libvirtSock: string;
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => libvirt.close(() => r()));
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
        // The rest of the runtime dir stays hidden (another runtime's dir in it is there empty: its mount point).
        const ls = await h1.exec(["/bin/sh", "-c", `ls -A '${runtime}'; echo ---; ls -A '${join(runtime, "libvirt")}'`], { cwd: join(root, "ws"), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
        expect(ls.stdout.trim().split(/\s+/)).toEqual(["docker.sock", "libvirt", "---"]);
      } finally {
        await h1.close();
      }
    }
  });

  test.skipIf(!Bun.which("python3"))("another runtime's socket (libvirt's, #448 round 10) stays hidden with Docker access on; the host's own libvirt, LXD and Incus sockets are unreachable in every sandbox", async () => {
    const on = spec(true);
    expect(on.containerSockets).toContain(join(runtime, "libvirt"));
    const h = await provider.open(on);
    try {
      const r = await connect(h, libvirtSock);
      expect(r.stdout).not.toContain("PLANTED-LIBVIRT");
      expect((await connect(h, sock)).stdout).toContain("PLANTED-RUNTIME");
    } finally {
      await h.close();
    }
    for (const p of ["/run/libvirt", "/var/run/libvirt", "/var/snap/lxd/common/lxd", "/var/lib/lxd", "/var/lib/incus", "/run/incus", "/run/dbus", "/run/screen"]) {
      expect([...spec(false).containerSockets, ...spec(false).hidden]).toContain(p);
    }
    // Where the host has them (this one may: a libvirt daemon), nothing of them is there inside.
    const real = ["/run/libvirt/libvirt-sock", "/run/libvirt/libvirt-sock-ro", "/var/snap/lxd/common/lxd/unix.socket", "/var/lib/incus/unix.socket", "/run/dbus/system_bus_socket"].filter((p) => existsSync(p));
    for (const docker of [false, true]) {
      const h2 = await provider.open(spec(docker));
      try {
        for (const p of real) {
          const r = await connect(h2, p);
          expect(r.stdout).toMatch(/FileNotFoundError|ConnectionRefusedError|No such file|refused/);
        }
      } finally {
        await h2.close();
      }
    }
  });
});
