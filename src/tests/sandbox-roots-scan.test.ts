/**
 * The look through project roots for credentials (#448 round 13, lows): a
 * fork in a linked worktree isn't told its own repository's git config is
 * hidden; a default root too big to look through says what counts and what
 * to set; the spec reuses the resolution's look; the look lets other work
 * run while it goes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import { projectRootSecretsAsync, rootScanKey } from "../daemon/sandbox/project-roots.js";
import { sandboxDirsOf } from "../daemon/sandbox/session-sandbox.js";

let base: string;
beforeAll(() => {
  const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(parent, { recursive: true });
  base = realpathSync(mkdtempSync(join(parent, "codeoid-pins-")));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function scratch(): string {
  const d = join(base, `t${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const GIT_ENV = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" });
function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV(cwd) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-qm", "i"], dir);
  return dir;
}

describe("the look through roots (#448 round 13 lows)", () => {
  // A home of the test's own (its scratch dir isn't in a hidden dir of it).
  const realHome = process.env.HOME;
  beforeAll(() => {
    process.env.HOME = join(base, "lows-home");
    mkdirSync(process.env.HOME, { recursive: true });
  });
  afterAll(() => {
    process.env.HOME = realHome;
  });

  test("a fork in a linked worktree isn't told its own repository's git config is hidden; a sibling's is", async () => {
    const d = scratch();
    const root = join(d, "W");
    const a = repo(join(root, "a"));
    const b = repo(join(root, "b"));
    git(["remote", "add", "origin", "https://x:OWN@example.invalid/a.git"], a);
    git(["remote", "add", "origin", "https://x:SIB@example.invalid/b.git"], b);
    const fork = join(root, "a-worktrees", "fork-1");
    mkdirSync(join(root, "a-worktrees"));
    git(["worktree", "add", "-q", fork, "-b", "fork"], a);
    const notes = (await sandboxDirsOf(fork, [root], [])).notes.join("\n");
    expect(notes).not.toContain(join(a, ".git", "config"));
    expect(notes).toContain(`${join(b, ".git", "config")} holds a credential`);
  });

  test("a default root too big to look through: said plainly (what counts, what to set); the spec reuses the resolution's look; the look lets other work run", async () => {
    const d = scratch();
    const root = join(d, "W");
    const a = repo(join(root, "a"));
    for (let i = 0; i < 30; i++) mkdirSync(join(root, "big", `target-${i}`), { recursive: true });
    const dirs = await sandboxDirsOf(a, ["@parent"], [], undefined, { scanLimit: 10 });
    expect(dirs.roots).toEqual([]);
    expect(dirs.notes.join("\n")).toContain(`no project root: the default, the repository's parent (${root}), holds more than 10 directories`);
    expect(dirs.notes.join("\n")).toContain("build outputs such as target/");
    // The spec built from a resolution uses its look (a hidden path only that look found is hidden), not a new one.
    const home = join(d, "home");
    mkdirSync(home, { recursive: true });
    const tmp = join(d, "tmp");
    mkdirSync(tmp);
    const own = [a, join(a, ".git")];
    const sentinel = join(root, "only-the-resolution-saw-this");
    const spec = buildSandboxSpec({
      sessionId: "s",
      workspace: a,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      projectRoots: [root],
      cache: false,
      rootScan: { key: rootScanKey([root], own), result: { hidden: [sentinel], gitConfigs: [], over: [] } },
    });
    expect(spec.hidden).toContain(sentinel);
    // The async look yields: a timer set before it fires while it runs.
    for (let i = 0; i < 1500; i++) mkdirSync(join(root, "many", `d${i}`), { recursive: true });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    await projectRootSecretsAsync([root], [a]);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});
