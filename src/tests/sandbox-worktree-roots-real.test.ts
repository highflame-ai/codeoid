/**
 * Real bubblewrap (#448 round 11), skipped where it can't run: a relative
 * `sandbox.worktreeRoots` entry is judged where it leads for the repository
 * (`../.config` of one in the home is `~/.config`): refused, never made,
 * nothing of it writable inside; a relative one that is fine still works.
 * Everything runs against a fake home and repository this test made.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec, gitLayoutOf } from "../daemon/sandbox/policy.js";
import { worktreeLocationDirs } from "../daemon/sandbox/worktrees.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();

/** Not under the host's /tmp, which the sandbox replaces with its own. */
function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const p = mkdtempSync(join(dir, "codeoid-roots-probe-"));
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

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: relative worktree roots judged where they lead (#448 round 11)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-roots-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("../.config of a repository in the home is refused and never made, nothing of ~/.config is writable inside; ../wt still works", async () => {
    const home = join(root, "home");
    const repo = join(home, "proj");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo, home);
    git(["commit", "-q", "--allow-empty", "-m", "i"], repo, home);
    const layout = gitLayoutOf(repo, join(root, "elsewhere"));
    if (!layout) throw new Error("no layout");
    const { locations, problems } = worktreeLocationDirs(layout, { roots: ["../.config", "../.local/share", "../wt"], home });
    expect(locations.map((l) => l.dir)).toEqual([join(home, "proj-worktrees"), join(home, "wt", "proj")]);
    expect(problems).toEqual([expect.stringContaining("hidden dir of your home (~/.config)"), expect.stringContaining("hidden dir of your home (~/.local)")]);
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({
      sessionId: "roots",
      workspace: repo,
      tempDir: tmp,
      network: { mode: "off" },
      config: { sandbox: { worktreeRoots: ["../.config", "../wt"] } } as never,
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      worktreeFolder: FOLDER,
    });
    expect(spec.worktreeFolders).toEqual([join(home, "proj-worktrees", FOLDER), join(home, "wt", "proj", FOLDER)]);
    expect(existsSync(join(home, ".config"))).toBe(false);
    const h = await provider.open(spec);
    try {
      const r = await h.exec(
        [
          "/bin/sh",
          "-c",
          [
            `mkdir -p '${join(home, ".config", "proj", FOLDER)}' 2>/dev/null && echo MADE-CONFIG || echo CONFIG-REFUSED`,
            `git worktree add -q '${join(home, "wt", "proj", FOLDER, "x")}' -b x && echo ADDED`,
          ].join("; "),
        ],
        { cwd: repo, env: gitEnv(home), timeoutMs: 30_000 },
      );
      expect(r.stdout).toContain("CONFIG-REFUSED");
      expect(r.stdout).toContain("ADDED");
    } finally {
      await h.close();
    }
    expect(existsSync(join(home, ".config"))).toBe(false);
  });
});
