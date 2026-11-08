/**
 * The end-of-session signal (#448 round 3, sandbox/git-watch.ts): what of a
 * repository git runs or obeys at the user's next command, outside any
 * sandbox, that `git status` doesn't show — its config, hooks (the hooks
 * dir's and `core.hooksPath`'s: husky's `.husky/_`), attributes, the links
 * naming its git dirs — and a session saying when they changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitControlChanges, gitControlSnapshot, gitControlWarning, isAgentSettingsPath, refTips, settingsCommits, settingsCommitWarning } from "../daemon/sandbox/git-watch.js";
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
    // An existing worktree's admin file changed: named.
    expect(gitControlChanges(before, gitControlSnapshot(wt, root))).toEqual([join(r, ".git", "worktrees", "late", "commondir")]);
  });

  test("no repository: nothing to watch", () => {
    const d = join(root, "none");
    mkdirSync(d);
    expect(gitControlSnapshot(d, root).size).toBe(0);
  });
});

/** A commit made with git plumbing, as an agent can inside the sandbox: `files` added to `parent`'s tree, never in the working tree, `ref` moved to it. */
function plumbingCommit(dir: string, parent: string, files: Record<string, string>, ref: string): string {
  const index = join(root, `index-${Math.random().toString(36).slice(2)}`);
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...ENV, HOME: root, GIT_INDEX_FILE: index } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  run(["read-tree", parent]);
  for (const [path, content] of Object.entries(files)) {
    const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: dir, env: { ...ENV, HOME: root }, stdin: new TextEncoder().encode(content) }).stdout.toString().trim();
    run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  }
  const commit = run(["commit-tree", run(["write-tree"]), "-p", parent, "-m", "plumbing"]);
  run(["update-ref", ref, commit]);
  rmSync(index, { force: true });
  return commit;
}

describe("commits that changed project settings while a session ran (#448 round 6)", () => {
  test("the project settings files a backend runs code from, at any depth; nothing else", () => {
    for (const p of [
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/hooks/pre.sh",
      "sub/.claude/settings.json",
      ".mcp.json",
      "pkg/.mcp.json",
      "opencode.json",
      "opencode.jsonc",
      ".opencode/plugin/p.ts",
      ".gemini/settings.json",
      ".qwen/settings.json",
      ".codex/config.toml",
      ".pi/settings.json",
    ]) {
      expect(isAgentSettingsPath(p)).toBe(true);
    }
    for (const p of ["README.md", ".claude/commands/x.md", ".claude/settings", "my.mcp.json", "xopencode.json", ".gemini/GEMINI.md", "src/codex/a.ts", ".claude"]) {
      expect(isAgentSettingsPath(p)).toBe(false);
    }
  });

  test("a commit made through git plumbing (never in the working tree) is named with its files; an ordinary one, and nothing new, aren't", async () => {
    const r = repo("commits");
    const before = await refTips(r, root);
    expect(before).toHaveLength(1);
    writeFileSync(join(r, "b"), "b\n");
    git(["add", "b"], r);
    git(["commit", "-qm", "ordinary"], r);
    const plain = (await refTips(r, root)) ?? [];
    expect(await settingsCommits(r, before ?? [], plain)).toEqual({ commits: [], more: false });
    const head = git(["rev-parse", "HEAD"], r).trim();
    const planted = plumbingCommit(r, head, { ".claude/settings.json": '{"hooks":{}}', ".claude/hooks/x.sh": "#!/bin/sh\n", "c": "c" }, "refs/heads/main");
    expect(existsSync(join(r, ".claude", "settings.json"))).toBe(false);
    const after = (await refTips(r, root)) ?? [];
    expect(after).toContain(planted);
    expect(await settingsCommits(r, plain, after)).toEqual({ commits: [{ commit: planted, files: [".claude/hooks/x.sh", ".claude/settings.json"] }], more: false });
    // Counted from the session's start: both commits are new, only the one changing settings is named.
    expect((await settingsCommits(r, before ?? [], after))?.commits.map((c) => c.commit)).toEqual([planted]);
    expect(await settingsCommits(r, after, after)).toEqual({ commits: [], more: false });
  });

  test("a new branch, a merge, a tag naming a tree and a baseline commit gone missing: each still read", async () => {
    const r = repo("branches");
    const base = git(["rev-parse", "HEAD"], r).trim();
    const before = [...((await refTips(r, root)) ?? []), "0".repeat(40)];
    const side = plumbingCommit(r, base, { "sub/.mcp.json": "{}", "opencode.jsonc": "{}" }, "refs/heads/side");
    git(["tag", "treetag", "HEAD^{tree}"], r);
    writeFileSync(join(r, "b"), "b\n");
    git(["add", "b"], r);
    git(["commit", "-qm", "ordinary"], r);
    git(["merge", "-q", "--no-edit", "side"], r);
    const merge = git(["rev-parse", "HEAD"], r).trim();
    const after = (await refTips(r, root)) ?? [];
    const found = await settingsCommits(r, before, after);
    // The side commit, and the merge, which brings them into main (named against its first parent).
    expect(found?.more).toBe(false);
    expect([...(found?.commits ?? [])].sort((a, b) => a.commit.localeCompare(b.commit))).toEqual(
      [
        { commit: merge, files: ["opencode.jsonc", "sub/.mcp.json"] },
        { commit: side, files: ["opencode.jsonc", "sub/.mcp.json"] },
      ].sort((a, b) => a.commit.localeCompare(b.commit)),
    );
  });

  test("no repository: no tips, nothing named", async () => {
    const d = join(root, "none-commits");
    mkdirSync(d);
    expect(await refTips(d, root)).toEqual([]);
    expect(await settingsCommits(d, [], [])).toEqual({ commits: [], more: false });
  });

  test("the warning names the files and the commits, shown safely", () => {
    const text = settingsCommitWarning([{ commit: "a".repeat(40), files: [".claude/settings.json", "x\u001b[2J/.mcp.json"] }, { commit: "b".repeat(40), files: [".claude/settings.json"] }], false);
    expect(text).toContain(".claude/settings.json");
    expect(text).toContain("x?[2J/.mcp.json");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("aaaaaaaaaaaa, bbbbbbbbbbbb");
    expect(text).toContain("review them");
    expect(settingsCommitWarning([{ commit: "c".repeat(40), files: [".mcp.json"] }], true)).toContain("only the newest were read");
  });
});
