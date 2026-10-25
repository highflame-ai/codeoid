/** git-env.ts: git the daemon runs in a repository an agent can write. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, hardenedGit } from "../daemon/git-env.js";
import { removeForkWorktree } from "../daemon/git-worktree.js";

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

