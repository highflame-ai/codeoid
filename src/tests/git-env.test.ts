/** git-env.ts: git the daemon runs in a repository an agent can write. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverOverrides, gitEnv, hardenedGit, safeGit } from "../daemon/git-env.js";
import { createForkWorktree, removeForkWorktree } from "../daemon/git-worktree.js";

let tmp: string;
let repo: string;
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-git-env-"));
  repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("git-env", () => {
  test("the environment never carries the daemon's own credentials", () => {
    process.env.CODEOID_API_KEY = "zid_sk_test";
    try {
      expect(gitEnv().CODEOID_API_KEY).toBeUndefined();
      expect(gitEnv({}, { network: true }).CODEOID_API_KEY).toBeUndefined();
    } finally {
      delete process.env.CODEOID_API_KEY;
    }
  });

  test("hardened git runs no fsmonitor, hook or filter a repository's config names", async () => {
    const marker = join(tmp, "ran");
    const script = join(tmp, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho "$CODEOID_API_KEY" >> ${marker}\n`);
    chmodSync(script, 0o755);
    git("config", "core.fsmonitor", script);
    git("config", "filter.x.clean", script);
    writeFileSync(join(repo, ".gitattributes"), "* filter=x\n");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    process.env.CODEOID_API_KEY = "zid_sk_test";
    try {
      await hardenedGit(["--no-optional-locks", "status", "--porcelain"], repo);
    } finally {
      delete process.env.CODEOID_API_KEY;
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("a session's work is saved on destroy even with commit signing on", async () => {
    git("config", "commit.gpgsign", "true");
    git("config", "gpg.program", "false");
    const wt = join(tmp, "wt");
    git("worktree", "add", "-q", "-b", "fork", wt);
    writeFileSync(join(wt, "work.txt"), "work\n");
    await removeForkWorktree({ workdir: repo, worktreePath: wt, branch: "fork" });
    expect(git("show", "fork:work.txt")).toBe("work\n");
  });

  test("git that exits before reading its input is an error, not a crash", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codeoid-not-a-repo-"));
    try {
      await expect(hardenedGit(["check-attr", "--stdin", "-z", "filter"], outside, {}, { input: "a\0".repeat(8_000_000) })).rejects.toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("removing a worktree whose directory is already gone still prunes it", async () => {
    const wt = join(tmp, "gone");
    git("worktree", "add", "-q", "-b", "gone", wt);
    rmSync(wt, { recursive: true, force: true });
    await removeForkWorktree({ workdir: repo, worktreePath: wt, branch: "gone" });
    expect(git("worktree", "list")).not.toContain("gone");
  });
});


/**
 * #448 round 2: every git the daemon runs in a user's repository an agent
 * can write runs nothing that repository's config names. The planted
 * program only appends to a marker in the test's own temp dir.
 */
describe("the daemon's own git in a user's repository (#448 round 2)", () => {
  let marker: string;
  let evil: string;
  beforeEach(() => {
    marker = join(tmp, "ran");
    evil = join(tmp, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`);
    chmodSync(evil, 0o755);
  });
  const plant = (cwd: string) => {
    for (const [k, v] of [
      ["core.fsmonitor", evil],
      ["filter.x.clean", evil],
      ["filter.x.smudge", evil],
      ["filter.x.process", evil],
      ["diff.x.textconv", evil],
      ["diff.x.command", evil],
      ["merge.x.driver", evil],
      ["core.sshCommand", evil],
      ["credential.helper", `!${evil}`],
      ["core.hooksPath", tmp],
    ] as const) {
      execFileSync("git", ["config", k, v], { cwd });
    }
    writeFileSync(join(tmp, "post-checkout"), `#!/bin/sh\necho hook >> '${marker}'\n`, { mode: 0o755 });
  };

  test("destroying a --worktree session (its snapshot, the worktree's removal) after a planted fsmonitor, filter, drivers, helper and hook runs none of them, and the work is saved", async () => {
    const wt = await createForkWorktree({ workdir: repo, label: "s", shortId: "abcd1234" });
    plant(repo);
    writeFileSync(join(wt.path, ".gitattributes"), "* filter=x diff=x merge=x\n");
    writeFileSync(join(wt.path, "work.txt"), "work\n");
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    await removeForkWorktree({ workdir: repo, worktreePath: wt.path, branch: wt.branch });
    expect(existsSync(marker)).toBe(false);
    expect(git("show", `${wt.branch}:work.txt`)).toBe("work\n");
    expect(existsSync(wt.path)).toBe(false);
  });

  test("forking (a worktree made and the parent's state carried) runs nothing planted either", async () => {
    plant(repo);
    writeFileSync(join(repo, ".gitattributes"), "* filter=x\n");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const wt = await createForkWorktree({ workdir: repo, label: "f", shortId: "ffff0000" });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("dirty\n");
  });

  test("a driver the user defined in their own config (git lfs, globally) still runs; a repository redefining it, or defining its own, doesn't", async () => {
    const home = join(tmp, "home");
    mkdirSync(home);
    const own = join(tmp, "own.sh");
    const ownMarker = join(tmp, "own-ran");
    writeFileSync(own, `#!/bin/sh\necho own >> '${ownMarker}'\ncat\n`, { mode: 0o755 });
    writeFileSync(join(home, ".gitconfig"), `[filter "lfs"]\n\tclean = ${own}\n`);
    git("config", "filter.lfs.clean", evil);
    git("config", "filter.y.clean", evil);
    writeFileSync(join(repo, ".gitattributes"), "a.txt filter=lfs\nb.txt filter=y\n");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      await safeGit(["add", "-A"], repo);
    } finally {
      process.env.HOME = prev;
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(ownMarker)).toBe(true);
  });

  test("driverOverrides: an agent-writable scope's drivers and credential helpers reset, the user's own put back; strict resets every driver", () => {
    const entries = [
      { scope: "global", key: "filter.lfs.clean", value: "git-lfs clean -- %f" },
      { scope: "local", key: "filter.lfs.clean", value: "evil" },
      { scope: "global", key: "filter.only-global.clean", value: "g" },
      { scope: "worktree", key: "diff.d.textconv", value: "evil" },
      { scope: "global", key: "credential.helper", value: "store" },
      { scope: "local", key: "credential.https://Example.com.helper", value: "!evil" },
      { scope: "local", key: "credential.helper", value: "!evil" },
    ];
    const o = driverOverrides(entries, false);
    expect(o).toContainEqual(["filter.lfs.clean", ""]);
    expect(o.findLast(([k]) => k === "filter.lfs.clean")).toEqual(["filter.lfs.clean", "git-lfs clean -- %f"]);
    expect(o.some(([k]) => k.startsWith("filter.only-global."))).toBe(false);
    expect(o).toContainEqual(["diff.d.textconv", ""]);
    expect(o.filter(([k]) => k === "credential.helper")).toEqual([["credential.helper", ""], ["credential.helper", "store"]]);
    // A URL subsection keeps its case.
    expect(o).toContainEqual(["credential.https://Example.com.helper", ""]);
    const strict = driverOverrides(entries, true);
    expect(strict).toContainEqual(["filter.only-global.clean", ""]);
    expect(strict.findLast(([k]) => k === "filter.lfs.clean")).toEqual(["filter.lfs.clean", ""]);
    expect(() => driverOverrides([{ scope: "local", key: "filter.a=b c.clean", value: "x" }], false)).toThrow(/refusing/);
  });
});
