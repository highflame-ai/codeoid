/**
 * The end-of-session signal (#448 round 3, sandbox/git-watch.ts): what of a
 * repository git runs or obeys at the user's next command, outside any
 * sandbox, that `git status` doesn't show — its config, hooks (the hooks
 * dir's and `core.hooksPath`'s: husky's `.husky/_`), attributes, the links
 * naming its git dirs — and a session saying when they changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitControlChanges, gitControlSnapshot, gitControlWarning } from "../daemon/sandbox/git-watch.js";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-git-watch-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (args: string[], cwd: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...ENV, HOME: root } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "a"), "a\n");
  git(["add", "."], dir);
  git(["commit", "-qm", "i"], dir);
  return dir;
}

describe("what of a repository git runs at your next command, and what changed (#448 round 3)", () => {
  test("codeoid's own placeholders read as nothing changed; config, a hook, attributes do", () => {
    const r = repo("plain");
    const before = gitControlSnapshot(r, root);
    buildSandboxSpec({ sessionId: "s", workspace: r, tempDir: join(root, "t"), network: { mode: "off" }, hidden: { home: root, configDir: join(root, ".codeoid"), env: { HOME: root }, daemonTmp: "/tmp" } });
    expect(gitControlChanges(before, gitControlSnapshot(r, root))).toEqual([]);
    git(["config", "core.fsmonitor", "planted"], r);
    writeFileSync(join(r, ".git", "hooks", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(r, ".git", "info", "attributes"), "* filter=x\n");
    writeFileSync(join(r, ".gitattributes"), "* diff=x\n");
    const changed = gitControlChanges(before, gitControlSnapshot(r, root));
    expect(changed).toEqual([".git/config", ".git/hooks/pre-commit", ".git/info/attributes", ".gitattributes"]);
    expect(gitControlWarning(changed)).toContain(".git/hooks/pre-commit");
    // #448 round 4: what runs them is the user's git and other host tools, not the CLIs codeoid starts (git-shim.ts).
    expect(gitControlWarning(changed)).toContain("the backends codeoid starts run theirs contained");
    // An ordinary edit isn't one.
    const now = gitControlSnapshot(r, root);
    writeFileSync(join(r, "a"), "changed\n");
    expect(gitControlChanges(now, gitControlSnapshot(r, root))).toEqual([]);
  });

  test("core.hooksPath into the workspace (husky's .husky/_): a hook planted there, which git status doesn't show, is seen", () => {
    const r = repo("husky");
    mkdirSync(join(r, ".husky", "_"), { recursive: true });
    writeFileSync(join(r, ".husky", "_", ".gitignore"), "*\n");
    git(["config", "core.hooksPath", ".husky/_"], r);
    const before = gitControlSnapshot(r, root);
    writeFileSync(join(r, ".husky", "_", "pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
    expect(git(["status", "--porcelain"], r)).toBe("");
    expect(gitControlChanges(before, gitControlSnapshot(r, root))).toEqual([".husky/_/pre-commit"]);
    // The hooks path itself moved.
    git(["config", "core.hooksPath", "elsewhere"], r);
    expect(gitControlChanges(before, gitControlSnapshot(r, root))).toContain("core.hooksPath");
  });

  test("a linked worktree: another worktree's commondir rewritten is seen", () => {
    const r = repo("wtrepo");
    const wt = join(root, "wt");
    git(["worktree", "add", "-q", "-b", "f", wt], r);
    git(["worktree", "add", "-q", "-b", "g", join(root, "late")], r);
    const before = gitControlSnapshot(wt, root);
    writeFileSync(join(r, ".git", "worktrees", "late", "commondir"), "/elsewhere\n");
    expect(gitControlChanges(before, gitControlSnapshot(wt, root))).toEqual([join(r, ".git", "worktrees", "late", "commondir")]);
  });

  test("no repository: nothing to watch", () => {
    const d = join(root, "none");
    mkdirSync(d);
    expect(gitControlSnapshot(d, root).size).toBe(0);
  });
});
