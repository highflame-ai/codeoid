/**
 * An added dir's provenance and the checkouts an autonomous grant never
 * touches (#448 round 13; through the manager:
 * sandbox-agent-grants-manager.test.ts, real bwrap:
 * sandbox-agent-grants-real.test.ts): the agent's own added dir keeps a
 * root's credential hiding, the owner's is the session's own; another
 * session's workspace (in it, holding it), a checkout in a worktree
 * location, another checkout of the session's own repository; the agent's
 * own are kept only while added.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import { checkoutOverlap } from "../daemon/sandbox/project-roots.js";
import { canonicalAddedDirs } from "../daemon/sandbox/session-sandbox.js";

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

describe("an added dir's provenance", () => {
  test("the agent's own added dir keeps a root's hiding; the owner's is the session's own", () => {
    const d = scratch();
    const home = join(d, "home");
    const root = join(home, "W");
    const a = repo(join(root, "a"));
    const b = repo(join(root, "b"));
    writeFileSync(join(b, ".env"), "B=1\n");
    git(["remote", "add", "origin", "https://x:TOKEN@example.invalid/b.git"], b);
    const tmp = join(d, "tmp");
    mkdirSync(tmp);
    const spec = (agent: boolean) =>
      buildSandboxSpec({ sessionId: "s", workspace: a, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, projectRoots: [root], addedDirs: [{ dir: b, agent }], cache: false });
    const theirs = spec(true);
    expect(theirs.writable).toContain(b);
    expect(theirs.hidden).toContain(join(b, ".env"));
    expect(theirs.hidden).toContain(join(b, ".git", "config"));
    const owners = spec(false);
    expect(owners.writable).toContain(b);
    expect(owners.hidden).not.toContain(join(b, ".env"));
    expect(owners.hidden).not.toContain(join(b, ".git", "config"));
  });

  test("the agent's own are kept only while added, and only once (an inner one goes with the outer)", () => {
    const d = scratch();
    const b = join(d, "b");
    mkdirSync(join(b, "sub"), { recursive: true });
    const s = canonicalAddedDirs({ addedDirs: [b, join(b, "sub")], agentDirs: [join(b, "sub"), join(d, "gone")] });
    expect(s.addedDirs).toEqual([b]);
    expect(s.agentDirs).toBeUndefined();
    expect(canonicalAddedDirs({ addedDirs: [b], agentDirs: [b] }).agentDirs).toEqual([b]);
    expect(canonicalAddedDirs({ agentDirs: [b] }).agentDirs).toBeUndefined();
  });
});

describe("the checkouts an autonomous grant never touches", () => {
  test("another session's workspace (in it, holding it), a checkout in a worktree location, another checkout of the session's own repository", () => {
    const d = scratch();
    const root = join(d, "W");
    const a = repo(join(root, "a"));
    const b = repo(join(root, "b"));
    mkdirSync(join(b, "src"));
    const others = [{ dir: b, what: 'session "other"\'s workspace' }];
    const opts = { workspace: a };
    expect(checkoutOverlap(b, others, opts)).toContain(`is session "other"'s workspace`);
    expect(checkoutOverlap(join(b, "src"), others, opts)).toContain(`is in session "other"'s workspace`);
    expect(checkoutOverlap(root, others, opts)).toContain(`holds session "other"'s workspace`);
    expect(checkoutOverlap(b, [], opts)).toBeNull();
    // A fork's (or loop's) checkout of b, in codeoid's location beside it.
    const wt = join(root, "b-worktrees", "fork-1");
    mkdirSync(join(root, "b-worktrees"));
    git(["worktree", "add", "-q", wt, "-b", "f"], b);
    expect(checkoutOverlap(wt, [], opts)).toContain("a worktree location");
    expect(checkoutOverlap(wt, [], { ...opts, ownFolders: [wt] })).toBeNull();
    // A session in a's worktree asks for a itself.
    const awt = join(root, "a-worktrees", "s1");
    mkdirSync(join(root, "a-worktrees"));
    git(["worktree", "add", "-q", awt, "-b", "s"], a);
    expect(checkoutOverlap(a, [], { workspace: awt })).toContain("another checkout of this session's own repository");
    // A checkout holding codeoid's in-checkout location.
    mkdirSync(join(b, ".worktrees"));
    expect(checkoutOverlap(b, [], opts)).toContain("holds");
  });
});
