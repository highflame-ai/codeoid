/**
 * #448 round 11: the repository's worktree entries kept as git makes them
 * (sandbox/worktree-entries.ts), without a sandbox: what a command could
 * have written is written here directly. sandbox-worktree-entries-real.test.ts
 * runs the same through real bubblewrap.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY_GRACE_MS, WorktreeEntryGuard, type WorktreeEntryContext, worktreeEntryWarning } from "../daemon/sandbox/worktree-entries.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-wt-entries-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...ENV, HOME: root } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

/** A repository, the session's folder beside it, and the context a session's look gets. */
function fixture() {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["commit", "-q", "--allow-empty", "-m", "i"], repo);
  const loc = join(root, "repo-worktrees");
  const own = join(loc, "agent-1111aaaa");
  mkdirSync(own, { recursive: true });
  const common = join(repo, ".git");
  const ctx = (now?: number): WorktreeEntryContext => ({
    common,
    main: repo,
    ownFolders: [own],
    writable: [repo, own, common, join(common, "worktrees")],
    readOnly: [],
    locations: [loc],
    ...(now !== undefined ? { now } : {}),
  });
  return { repo, loc, own, common, wts: join(common, "worktrees"), ctx };
}

/** An entry's time pushed back, so it isn't one git may still be making. */
function settle(dir: string): void {
  const t = new Date(Date.now() - 60_000);
  utimesSync(dir, t, t);
}

describe("the session's own entries", () => {
  test("one checked out in its folder when first seen, named by no other checkout, is its own; another's isn't", () => {
    const f = fixture();
    git(["worktree", "add", "-q", "-b", "o", join(f.own, "o")], f.repo);
    git(["worktree", "add", "-q", "-b", "u", join(root, "u")], f.repo);
    const g = new WorktreeEntryGuard();
    expect(g.check(f.ctx()).findings).toEqual([]);
    expect(g.ownEntries()).toEqual([join(f.wts, "o")]);
  });

  test("an entry pointed into the folder, while its real checkout still names it, is restored to that checkout and never the session's", () => {
    const f = fixture();
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    const theirs = join(f.loc, "other-2222bbbb", "bw");
    git(["worktree", "add", "-q", "-b", "bw", theirs], f.repo);
    settle(join(f.wts, "bw"));
    // A command forges it before the session's next look: its gitdir, and a checkout planted to name it back.
    mkdirSync(join(f.own, "x"));
    writeFileSync(join(f.own, "x", ".git"), `gitdir: ${join(f.wts, "bw")}\n`);
    writeFileSync(join(f.wts, "bw", "gitdir"), `${join(f.own, "x", ".git")}\n`);
    const { findings } = g.check(f.ctx());
    expect(findings).toEqual([expect.objectContaining({ name: "bw", restored: true })]);
    expect(readFileSync(join(f.wts, "bw", "gitdir"), "utf8").trim()).toBe(join(theirs, ".git"));
    expect(g.ownEntries()).toEqual([]);
  });

  test("its own entry's commondir and config.worktree are checked too (git in its checkout reads them at your next git there)", () => {
    const f = fixture();
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    git(["worktree", "add", "-q", "-b", "o", join(f.own, "o")], f.repo);
    g.check(f.ctx());
    writeFileSync(join(f.wts, "o", "commondir"), `${join(f.own, "p")}\n`);
    const { findings } = g.check(f.ctx());
    expect(findings).toEqual([expect.objectContaining({ name: "o", restored: true, what: expect.stringContaining("commondir") })]);
    expect(g.ownEntries()).toEqual([join(f.wts, "o")]);
  });
});

describe("what was there at the first look", () => {
  test("a checkout you remove by hand later leaves a prunable entry: nothing said", () => {
    const f = fixture();
    const u = join(root, "u");
    git(["worktree", "add", "-q", "-b", "u", u], f.repo);
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    rmSync(u, { recursive: true, force: true });
    expect(g.check(f.ctx()).findings).toEqual([]);
    expect(existsSync(join(f.wts, "u"))).toBe(true);
  });

  test("a prunable worktree (its checkout gone) is as git leaves it: never said, never moved", () => {
    const f = fixture();
    const gone = join(root, "gone");
    git(["worktree", "add", "-q", "-b", "gone", gone], f.repo);
    rmSync(gone, { recursive: true, force: true });
    const g = new WorktreeEntryGuard();
    expect(g.check(f.ctx()).findings).toEqual([]);
    expect(g.check(f.ctx()).findings).toEqual([]);
    expect(existsSync(join(f.wts, "gone"))).toBe(true);
  });

  test("per-worktree config the repository reads is kept as first seen; changed later, it is restored and the change kept aside", () => {
    const f = fixture();
    git(["config", "extensions.worktreeConfig", "true"], f.repo);
    const u = join(root, "u");
    git(["worktree", "add", "-q", "-b", "u", u], f.repo);
    git(["config", "--worktree", "user.name", "Mine"], u);
    const g = new WorktreeEntryGuard();
    expect(g.check(f.ctx()).findings).toEqual([]);
    const yours = readFileSync(join(f.wts, "u", "config.worktree"), "utf8");
    writeFileSync(join(f.wts, "u", "config.worktree"), `${yours}[core]\n\tfsmonitor = /planted\n`);
    const { findings } = g.check(f.ctx());
    expect(findings).toEqual([expect.objectContaining({ name: "u", restored: true, what: expect.stringContaining("config.worktree") })]);
    expect(readFileSync(join(f.wts, "u", "config.worktree"), "utf8")).toBe("");
  });

  test("a new worktree's config.worktree copying the main worktree's (as git worktree add does) is kept", () => {
    const f = fixture();
    git(["config", "extensions.worktreeConfig", "true"], f.repo);
    git(["config", "--worktree", "core.sparseCheckout", "false"], f.repo);
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    git(["worktree", "add", "-q", "-b", "n", join(root, "n")], f.repo);
    writeFileSync(join(f.wts, "n", "config.worktree"), readFileSync(join(f.common, "config.worktree"), "utf8"));
    settle(join(f.wts, "n"));
    expect(g.check(f.ctx()).findings).toEqual([]);
  });

  test("a sparse worktree's info/sparse-checkout is git's own; a planted info/ beside it isn't", () => {
    const f = fixture();
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    git(["worktree", "add", "-q", "-b", "s", join(root, "s")], f.repo);
    mkdirSync(join(f.wts, "s", "info"));
    writeFileSync(join(f.wts, "s", "info", "sparse-checkout"), "/*\n");
    settle(join(f.wts, "s"));
    expect(g.check(f.ctx()).findings).toEqual([]);
    writeFileSync(join(f.wts, "s", "info", "attributes"), "* filter=x\n");
    expect(g.check(f.ctx()).findings).toEqual([expect.objectContaining({ name: "s", restored: true, what: expect.stringContaining("info/") })]);
    expect(existsSync(join(f.wts, "s", "info"))).toBe(false);
  });
});

describe("what can't be restored with certainty is said, once, and left", () => {
  test("an entry removed while its checkout still names it", () => {
    const f = fixture();
    const u = join(root, "u");
    git(["worktree", "add", "-q", "-b", "u", u], f.repo);
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    rmSync(join(f.wts, "u"), { recursive: true, force: true });
    const { findings } = g.check(f.ctx());
    expect(findings).toEqual([expect.objectContaining({ name: "u", restored: false, what: expect.stringContaining("was removed while its checkout") })]);
    expect(g.check(f.ctx()).findings).toEqual([]);
  });

  test("an entry made since, pointed at a checkout nobody vouches for", () => {
    const f = fixture();
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    const away = join(root, "far", "away", "deep", "w");
    mkdirSync(join(root, "far", "away", "deep"), { recursive: true });
    git(["worktree", "add", "-q", "-b", "w", away], f.repo);
    writeFileSync(join(f.wts, "w", "gitdir"), `${join(f.own, "nothing", ".git")}\n`);
    // Past the grace an entry naming no checkout may be one git is still making.
    const { findings } = g.check(f.ctx(Date.now() + ENTRY_GRACE_MS + 1000));
    expect(findings).toEqual([expect.objectContaining({ name: "w", restored: false, what: expect.stringContaining("git worktree repair") })]);
    const text = worktreeEntryWarning(f.common, findings);
    expect(text).toContain("Not restored, for you to look at: .git/worktrees/w appeared naming");
  });
});

describe("an entry git may still be making", () => {
  test("waits for the grace once, and no longer, however its times are touched", () => {
    const f = fixture();
    const g = new WorktreeEntryGuard();
    g.check(f.ctx());
    const wt = join(root, "late");
    git(["worktree", "add", "-q", "-b", "late", wt], f.repo);
    writeFileSync(join(f.wts, "late", "gitdir"), `${join(f.own, "x", ".git")}\n`);
    const now = Date.now();
    const first = g.check(f.ctx(now));
    expect(first).toEqual({ findings: [], pending: true });
    // Touched meanwhile, so it still looks new: past the grace it is looked at anyway.
    const t = new Date(now + ENTRY_GRACE_MS + 50);
    utimesSync(join(f.wts, "late"), t, t);
    const second = g.check(f.ctx(now + ENTRY_GRACE_MS + 100));
    expect(second.pending).toBe(false);
    expect(second.findings).toEqual([expect.objectContaining({ name: "late", restored: true })]);
    expect(readFileSync(join(f.wts, "late", "gitdir"), "utf8").trim()).toBe(join(wt, ".git"));
  });
});
