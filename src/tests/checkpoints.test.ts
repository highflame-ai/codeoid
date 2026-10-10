/**
 * Per-turn workspace checkpoints (#354) against real git repositories.
 *
 * The contract that matters most is the negative one: taking a snapshot must
 * leave the user's checkout exactly as it was — branch, index, stash, working
 * tree, `git status` — while capturing tracked edits and untracked files and
 * honouring .gitignore.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_REF_ROOT,
  checkpointRef,
  createCheckpoint,
  deleteCheckpoints,
  listCheckpoints,
} from "../daemon/checkpoints.js";

let repo: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

function initRepo(commit = true): void {
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  if (commit) {
    git("add", ".");
    git("commit", "-qm", "init");
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "codeoid-ckpt-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("createCheckpoint", () => {
  it("captures tracked edits and untracked files, skips ignored ones, and changes nothing the user can see", async () => {
    initRepo();
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); // tracked, modified
    writeFileSync(join(repo, "new.txt"), "fresh\n"); // untracked
    writeFileSync(join(repo, "debug.log"), "noise\n"); // ignored
    git("add", "a.txt"); // something staged, to prove the real index is untouched
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n"); // and unstaged on top

    const before = {
      status: git("status", "--porcelain"),
      head: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      staged: git("diff", "--cached"),
      stash: git("stash", "list"),
      log: git("log", "--oneline"),
    };

    const r = await createCheckpoint({ workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(git("status", "--porcelain")).toBe(before.status);
    expect(git("rev-parse", "HEAD")).toBe(before.head);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe(before.branch);
    expect(git("diff", "--cached")).toBe(before.staged);
    expect(git("stash", "list")).toBe(before.stash);
    expect(git("log", "--oneline")).toBe(before.log);

    // The snapshot holds the WORKING TREE (not the index), new files, no ignored ones.
    expect(git("show", `${r.sha}:a.txt`)).toBe("one\ntwo\nthree\n");
    expect(git("show", `${r.sha}:new.txt`)).toBe("fresh\n");
    const files = git("ls-tree", "-r", "--name-only", r.sha).trim().split("\n");
    expect(files).not.toContain("debug.log");
    expect(r.ref).toBe(`${CHECKPOINT_REF_ROOT}/s1/t1`);
    expect(git("rev-parse", r.ref).trim()).toBe(r.sha);
  });

  it("works on a repository with no commits yet", async () => {
    initRepo(false);
    const r = await createCheckpoint({ workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(git("show", `${r.sha}:a.txt`)).toBe("one\n");
  });

  it("snapshots the whole repository from a subdirectory workdir", async () => {
    initRepo();
    execFileSync("mkdir", ["-p", join(repo, "pkg")]);
    writeFileSync(join(repo, "pkg", "x.ts"), "x\n");
    const r = await createCheckpoint({ workdir: join(repo, "pkg"), sessionId: "s1", turnId: "t1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(git("show", `${r.sha}:pkg/x.ts`)).toBe("x\n");
      expect(git("show", `${r.sha}:a.txt`)).toBe("one\n");
    }
  });

  it("reports a non-git directory instead of failing", async () => {
    const r = await createCheckpoint({ workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(r).toEqual({ ok: false, reason: "not a git repository" });
  });

  it("skips (with a reason) when untracked files exceed the limits, rather than bloating the repo", async () => {
    initRepo();
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(4096));
    const bySize = await createCheckpoint({
      workdir: repo,
      sessionId: "s1",
      turnId: "t1",
      limits: { maxUntrackedBytes: 1024 },
    });
    expect(bySize.ok).toBe(false);
    if (!bySize.ok) expect(bySize.reason).toContain("untracked files exceed");

    const byCount = await createCheckpoint({
      workdir: repo,
      sessionId: "s1",
      turnId: "t2",
      limits: { maxUntrackedFiles: 0 },
    });
    expect(byCount.ok).toBe(false);
    if (!byCount.ok) expect(byCount.reason).toContain("too many untracked files");
    expect((await listCheckpoints(repo, "s1")).size).toBe(0);
  });

  it("refuses ids that could escape the ref namespace", async () => {
    initRepo();
    expect(() => checkpointRef("s1", "../heads/main")).toThrow();
    const r = await createCheckpoint({ workdir: repo, sessionId: "s1", turnId: "../../heads/main" });
    expect(r.ok).toBe(false);
    expect(git("for-each-ref", "refs/heads").trim().split("\n")).toHaveLength(1);
  });
});

describe("listCheckpoints / pruning / deleteCheckpoints", () => {
  it("lists a session's checkpoints only, prunes the oldest past the cap, and deletes them all", async () => {
    initRepo();
    for (const t of ["t1", "t2", "t3"]) {
      writeFileSync(join(repo, "a.txt"), `${t}\n`);
      const r = await createCheckpoint({ workdir: repo, sessionId: "s1", turnId: t, limits: { maxPerSession: 2 } });
      expect(r.ok).toBe(true);
      await Bun.sleep(1100); // creatordate has 1s resolution; keep the order unambiguous
    }
    await createCheckpoint({ workdir: repo, sessionId: "other", turnId: "x" });

    const s1 = await listCheckpoints(repo, "s1");
    expect([...s1.keys()]).toEqual(["t2", "t3"]); // t1 pruned
    expect(git("show", `${s1.get("t3")}:a.txt`)).toBe("t3\n");

    await deleteCheckpoints(repo, "s1");
    expect((await listCheckpoints(repo, "s1")).size).toBe(0);
    expect((await listCheckpoints(repo, "other")).size).toBe(1); // another session's are untouched
  });
});
