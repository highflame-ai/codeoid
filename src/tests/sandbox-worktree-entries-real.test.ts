/**
 * Real bubblewrap (#448 round 11), skipped where it can't run: the
 * repository's worktree entries (`.git/worktrees/<name>`) kept as git makes
 * them (sandbox/worktree-entries.ts), without rebuilding a session's sandbox
 * when a worktree is added; nothing made in the user's checkout, the
 * session's worktree folder removed while empty.
 *
 * Everything destructive runs INSIDE the sandbox under test, against a
 * repository this test planted in its own dir; "the user's next git" runs
 * outside the session's sandbox, in a bubblewrap that may write only the
 * test's dir, and must run nothing a command planted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { SessionSandbox } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";
import { QUARANTINE_DIR, type WorktreeEntryFinding } from "../daemon/sandbox/worktree-entries.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();

/** Not under the host's /tmp, which the sandbox replaces with its own. */
function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const p = mkdtempSync(join(dir, "codeoid-wte-probe-"));
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

const SESSION_ID = "1111aaaa-0000-4000-8000-000000000000";
const FOLDER = "agent-1111aaaa";

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: worktree entries kept as git makes them (#448 round 11)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-wte-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string>) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  /** A repository with a commit and a worktree of the user's beside it; a session sandbox (bwrap, network off) whose folder is FOLDER. */
  async function fixture(name: string) {
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
    const marker = join(dir, "RAN-OUTSIDE");
    const mark = join(dir, "mark.sh");
    writeFileSync(mark, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    const registry = new SandboxRegistry("linux");
    registry.register(provider);
    const found: WorktreeEntryFinding[] = [];
    const sbx = new SessionSandbox({ sessionId: SESSION_ID, name: "agent", workdir: repo, registry, setting: { provider: "bwrap", network: "off" }, onWorktreeEntries: (_c, f) => found.push(...f) });
    const info = await sbx.refresh("pi");
    expect(info.state).toBe("on");
    const rt = sbx.runtimeFor("pi");
    if (!rt) throw new Error("no runtime");
    const loc = join(dir, "repo-worktrees");
    return { dir, home, repo, userWt, marker, mark, sbx, rt, found, loc, own: join(loc, FOLDER), common: join(repo, ".git"), env: gitEnv(home) };
  }

  /** The user's next git in `cwd`, outside the session's sandbox (it may write only the test's dir); its exit code. */
  function userGit(f: { dir: string; home: string }, cwd: string, args: string[] = ["status", "--short"]): number {
    const bwrap = provider.binary() as string;
    return Bun.spawnSync([bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", f.dir, f.dir, "--chdir", cwd, "--", "git", ...args], { env: gitEnv(f.home) }).exitCode;
  }

  test("an entry made after the sandbox started and taken over in it is restored at the turn's end and said; the user's git runs nothing planted; the sandbox isn't rebuilt", async () => {
    const f = await fixture("takeover");
    try {
      const spec = f.rt.spec;
      const h = await provider.open(spec);
      const wts = join(f.common, "worktrees");
      // Made while the sandbox runs, as you (or a fork, or another session) would: one beside the repository, the
      // rest in the worktree location.
      const late: Record<string, string> = {};
      for (const n of ["la", "lb", "lc", "ld", "le"]) {
        late[n] = n === "la" ? join(f.dir, n) : join(f.loc, n);
        git(["worktree", "add", "-q", "-b", n, late[n] as string], f.repo, f.home);
      }
      // No rebuild: the spec (a Claude query's, a process backend's sandbox) is the same object.
      expect(f.rt.spec).toBe(spec);
      try {
        const P = join(f.own, "p");
        const r = await sh(
          h,
          f.repo,
          [
            // A planted git dir with core.fsmonitor, in the session's own folder.
            `git init -q --bare '${P}' && cp -r '${join(f.common, "objects")}/.' '${P}/objects/' && cp -r '${join(f.common, "refs")}/.' '${P}/refs/' && git --git-dir='${P}' config core.fsmonitor '${f.mark}' && echo PLANTED`,
            // la: its gitdir pointed into the session's folder.
            `printf '%s\\n' '${join(f.own, "x", ".git")}' > '${join(wts, "la", "gitdir")}' && echo RETARGETED-LA`,
            // lb: the same, with a checkout planted there naming it back.
            `mkdir -p '${join(f.own, "y")}' && printf 'gitdir: %s\\n' '${join(wts, "lb")}' > '${join(f.own, "y", ".git")}' && printf '%s\\n' '${join(f.own, "y", ".git")}' > '${join(wts, "lb", "gitdir")}' && echo FORGED-LB`,
            // lc: replaced with a link to a copy in the folder, whose ../.. is the planted git dir.
            `mkdir -p '${join(P, "q")}' && cp -r '${join(wts, "lc")}' '${join(P, "q", "lc")}' && rm -rf '${join(wts, "lc")}' && ln -s '${join(P, "q", "lc")}' '${join(wts, "lc")}' && echo SWAPPED-LC`,
            // ld: its commondir at the planted git dir.
            `printf '%s\\n' '${P}' > '${join(wts, "ld", "commondir")}' && echo REDIRECTED-LD`,
            // le: a config.worktree with core.fsmonitor, a config and a hook of its own.
            `printf '[core]\\n\\tfsmonitor = %s\\n' '${f.mark}' > '${join(wts, "le", "config.worktree")}' && printf '[core]\\n\\tfsmonitor = %s\\n' '${f.mark}' > '${join(wts, "le", "config")}' && mkdir -p '${join(wts, "le", "hooks")}' && printf '#!/bin/sh\\n%s\\n' '${f.mark}' > '${join(wts, "le", "hooks", "post-checkout")}' && chmod +x '${join(wts, "le", "hooks", "post-checkout")}' && echo PLANTED-LE`,
          ].join(" && "),
          f.env,
        );
        for (const w of ["PLANTED", "RETARGETED-LA", "FORGED-LB", "SWAPPED-LC", "REDIRECTED-LD", "PLANTED-LE"]) expect(r.stdout).toContain(w);
      } finally {
        await h.close();
      }
      // The turn's end. `la` names no checkout yet, as an entry git is still making would: looked at again once the
      // grace is over (never later, however its times are touched).
      f.sbx.checkWorktreeEntries();
      const by = (n: string) => f.found.filter((x) => x.name === n);
      expect(by("la")).toEqual([]);
      for (let i = 0; i < 60 && by("la").length === 0; i++) await Bun.sleep(100);
      for (const n of ["la", "lb", "ld", "le"]) expect([n, by(n).some((x) => x.restored)]).toEqual([n, true]);
      expect(by("lc")).toEqual([expect.objectContaining({ restored: false, what: expect.stringContaining("link") })]);
      expect(readFileSync(join(wts, "la", "gitdir"), "utf8").trim()).toBe(join(late.la as string, ".git"));
      expect(readFileSync(join(wts, "lb", "gitdir"), "utf8").trim()).toBe(join(late.lb as string, ".git"));
      expect(readFileSync(join(wts, "ld", "commondir"), "utf8").trim()).toBe("../..");
      expect(readFileSync(join(wts, "le", "config.worktree"), "utf8")).toBe("");
      expect(existsSync(join(wts, "le", "config"))).toBe(false);
      expect(existsSync(join(wts, "le", "hooks"))).toBe(false);
      expect(existsSync(join(wts, "lc"))).toBe(false);
      expect(readdirSync(join(f.common, QUARANTINE_DIR)).length).toBeGreaterThan(0);
      // None of them is the session's own.
      expect(f.sbx.worktreeFolders()).toEqual([f.own]);
      // The user's next git there: what works works, and nothing planted runs.
      for (const n of ["la", "lb", "ld", "le"]) expect([n, userGit(f, late[n] as string)]).toEqual([n, 0]);
      userGit(f, late.lc as string);
      expect(existsSync(f.marker)).toBe(false);
      // Said once: the next look finds nothing new.
      const before = f.found.length;
      f.sbx.checkWorktreeEntries();
      expect(f.found.length).toBe(before);
    } finally {
      await f.sbx.close();
    }
  });

  test("an entry planted naming your worktree's checkout is moved aside before git worktree repair can adopt it; one it already adopted is undone", async () => {
    const f = await fixture("repair");
    try {
      const wts = join(f.common, "worktrees");
      const head = git(["rev-parse", "HEAD"], f.repo, f.home).trim();
      const plant = (prefix: string) =>
        Array.from({ length: 6 }, (_, i) => `mkdir -p '${join(wts, `${prefix}${i}`)}' && printf '../..\\n' > '${join(wts, `${prefix}${i}`, "commondir")}' && printf '%s\\n' '${join(f.userWt, ".git")}' > '${join(wts, `${prefix}${i}`, "gitdir")}' && printf '${head}\\n' > '${join(wts, `${prefix}${i}`, "HEAD")}'`).join(" && ");
      // The first look, as at the session's first turn.
      f.sbx.checkWorktreeEntries();
      const h = await provider.open(f.rt.spec);
      try {
        expect((await sh(h, f.repo, `${plant("zz")} && echo PLANTED`, f.env)).stdout).toContain("PLANTED");
      } finally {
        await h.close();
      }
      f.sbx.checkWorktreeEntries();
      expect(f.found.filter((x) => x.name.startsWith("zz") && x.restored).length).toBe(6);
      expect(readdirSync(wts).filter((n) => n.startsWith("zz"))).toEqual([]);
      expect(userGit(f, f.repo, ["worktree", "repair"])).toBe(0);
      expect(readFileSync(join(f.userWt, ".git"), "utf8").trim()).toBe(`gitdir: ${join(wts, "userwt")}`);
      // Planted again, and the user's repair runs before the session's next look.
      const h2 = await provider.open(f.rt.spec);
      try {
        expect((await sh(h2, f.repo, `${plant("yy")} && echo PLANTED`, f.env)).stdout).toContain("PLANTED");
      } finally {
        await h2.close();
      }
      userGit(f, f.repo, ["worktree", "repair"]);
      expect(readFileSync(join(f.userWt, ".git"), "utf8")).toContain(join(wts, "yy"));
      f.sbx.checkWorktreeEntries();
      expect(readFileSync(join(f.userWt, ".git"), "utf8").trim()).toBe(`gitdir: ${join(wts, "userwt")}`);
      expect(readdirSync(wts).filter((n) => n.startsWith("yy"))).toEqual([]);
      expect(f.found.some((x) => x.name === "userwt" && x.restored && x.what.includes("pointed back"))).toBe(true);
      expect(userGit(f, f.userWt)).toBe(0);
    } finally {
      await f.sbx.close();
    }
  });

  test("a name the session's own worktree had, reused by yours, is yours: checked, never left to the session", async () => {
    const f = await fixture("reuse");
    try {
      const wts = join(f.common, "worktrees");
      const h = await provider.open(f.rt.spec);
      try {
        expect((await sh(h, f.repo, `git worktree add -q '${join(f.own, "feat")}' -b feat-own && echo ADDED`, f.env)).stdout).toContain("ADDED");
        f.sbx.checkWorktreeEntries();
        expect(f.found).toEqual([]);
        expect((await sh(h, f.repo, `git worktree remove '${join(f.own, "feat")}' && echo REMOVED`, f.env)).stdout).toContain("REMOVED");
        // Yours, under the same name, while the sandbox still runs (its spec never held `feat`: it was the session's).
        const yours = join(f.dir, "u", "feat");
        mkdirSync(join(f.dir, "u"));
        git(["worktree", "add", "-q", "-b", "feat-user", yours], f.repo, f.home);
        expect((await sh(h, f.repo, `echo '${join(f.own, "p")}' > '${join(wts, "feat", "commondir")}' && echo REDIRECTED`, f.env)).stdout).toContain("REDIRECTED");
      } finally {
        await h.close();
      }
      f.sbx.checkWorktreeEntries();
      expect(f.found).toEqual([expect.objectContaining({ name: "feat", restored: true, what: expect.stringContaining("commondir") })]);
      expect(readFileSync(join(wts, "feat", "commondir"), "utf8").trim()).toBe("../..");
    } finally {
      await f.sbx.close();
    }
  });

  test("nothing is made in the checkout; the session's sibling folder goes while empty and stays once it holds a worktree", async () => {
    const f = await fixture("tidy");
    try {
      const spec = f.rt.spec;
      expect(spec.worktreeFolders).toEqual([f.own]);
      expect(existsSync(join(f.repo, ".worktrees"))).toBe(false);
      expect(existsSync(f.own)).toBe(true);
      // A turn's end with nothing made: the folder, and the location it alone was in, go.
      f.sbx.tidyFolders();
      expect(existsSync(f.own)).toBe(false);
      expect(existsSync(f.loc)).toBe(false);
      // The next turn's start makes them again, and a worktree made there keeps them.
      f.sbx.prepareFolders();
      expect(existsSync(f.own)).toBe(true);
      const h = await provider.open(spec);
      try {
        expect((await sh(h, f.repo, `git worktree add -q '${join(f.own, "w")}' -b w && echo ADDED`, f.env)).stdout).toContain("ADDED");
      } finally {
        await h.close();
      }
      f.sbx.tidyFolders();
      expect(existsSync(join(f.own, "w", "a.txt"))).toBe(true);
    } finally {
      await f.sbx.close();
    }
    // Kept with the session gone: a worktree is the user's to keep.
    expect(existsSync(join(f.own, "w", "a.txt"))).toBe(true);
    expect(existsSync(join(f.repo, ".worktrees"))).toBe(false);
  });
});
