/**
 * Per-turn workspace checkpoints (#354) against real directories.
 *
 * Snapshots live in a daemon-owned SHADOW repository per session. The
 * contracts that matter most are the negative ones:
 *   - the user's checkout is left exactly as it was — branch, index, stash,
 *     working tree, refs, `git log --all`, `git status`;
 *   - no code the user's repository (or an agent editing it) configures is
 *     ever run: fsmonitor, filter drivers, hooks;
 *   - secrets and inherited GIT_* variables don't leak in.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyCheckpoints,
  createCheckpoint,
  deleteCheckpoints,
  listCheckpoints,
  shadowGit,
  shadowRepoPath,
  sweepCheckpoints,
} from "../daemon/checkpoints.js";

let tmp: string;
let repo: string;
let root: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const show = (session: string, sha: string, file: string): string =>
  execFileSync("git", ["--git-dir", shadowRepoPath(root, session), "show", `${sha}:${file}`], { encoding: "utf8" });
const treeFiles = (session: string, sha: string): string[] =>
  execFileSync("git", ["--git-dir", shadowRepoPath(root, session), "ls-tree", "-r", "--name-only", sha], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);

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
  tmp = mkdtempSync(join(tmpdir(), "codeoid-ckpt-"));
  repo = join(tmp, "repo");
  root = join(tmp, "checkpoints");
  mkdirSync(repo);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createCheckpoint", () => {
  it("captures the working tree (not the index), untracked files, skips ignored ones, and changes nothing in the user's repo", async () => {
    initRepo();
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git("add", "a.txt"); // staged...
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n"); // ...and unstaged on top
    writeFileSync(join(repo, "new.txt"), "fresh\n");
    writeFileSync(join(repo, "debug.log"), "noise\n");

    const snap = () => ({
      status: git("status", "--porcelain"),
      head: git("rev-parse", "HEAD"),
      staged: git("diff", "--cached"),
      stash: git("stash", "list"),
      refs: git("for-each-ref"),
      logAll: git("log", "--all", "--oneline"),
      objects: git("count-objects"),
    });
    const before = snap();

    const r = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(r).toMatchObject({ ok: true, late: false });
    if (!r.ok) return;

    expect(snap()).toEqual(before); // not one new ref, object or log entry in the user's repo
    expect(show("s1", r.sha, "a.txt")).toBe("one\ntwo\nthree\n");
    expect(show("s1", r.sha, "new.txt")).toBe("fresh\n");
    expect(treeFiles("s1", r.sha)).not.toContain("debug.log");
  });

  it("dedups against the user's repo: unchanged tracked files are not copied", async () => {
    initRepo();
    writeFileSync(join(repo, "big.txt"), "x".repeat(200_000));
    git("add", "big.txt");
    git("commit", "-qm", "big");
    const r = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(r.ok).toBe(true);
    const sizeKb = Number(
      (await shadowGit(root, "s1", ["count-objects", "-v"])).match(/^size: (\d+)/m)?.[1] ?? "0",
    );
    expect(sizeKb).toBeLessThan(20); // just the tree + commit, not the 200 KB file
  });

  it("works in a directory that is not a git repository", async () => {
    writeFileSync(join(repo, "notes.md"), "plain\n");
    const r = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(show("s1", r.sha, "notes.md")).toBe("plain\n");
    expect(existsSync(join(repo, ".git"))).toBe(false); // nothing created in the workdir
  });

  it("works on a repository with no commits yet, and from a subdirectory workdir", async () => {
    initRepo(false);
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, "pkg", "x.ts"), "x\n");
    const r = await createCheckpoint({ root, workdir: join(repo, "pkg"), sessionId: "s1", turnId: "t1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(treeFiles("s1", r.sha)).toEqual(["x.ts"]); // scoped to the session's directory
  });

  it("never copies common secret files or dependency directories", async () => {
    initRepo();
    writeFileSync(join(repo, ".env"), "API_KEY=secret\n");
    writeFileSync(join(repo, ".env.local"), "X=1\n");
    writeFileSync(join(repo, ".env.example"), "API_KEY=\n");
    writeFileSync(join(repo, "server.pem"), "-----BEGIN-----\n");
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "i.js"), "x\n");
    const r = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" });
    if (!r.ok) throw new Error(r.reason);
    const files = treeFiles("s1", r.sha);
    expect(files).toContain(".env.example");
    for (const f of [".env", ".env.local", "server.pem", "node_modules/dep/i.js"]) expect(files).not.toContain(f);
  });

  it("runs none of the code the user's repository configures: fsmonitor, filters, hooks", async () => {
    initRepo();
    const marker = join(tmp, "pwned");
    const evil = join(tmp, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat\n`);
    execFileSync("chmod", ["+x", evil]);
    git("config", "core.fsmonitor", evil);
    git("config", "filter.evil.clean", evil);
    git("config", "filter.evil.smudge", evil);
    git("config", "core.hooksPath", join(tmp, "hooks"));
    mkdirSync(join(tmp, "hooks"));
    for (const h of ["reference-transaction", "post-commit", "pre-commit"]) {
      writeFileSync(join(tmp, "hooks", h), `#!/bin/sh\necho hook >> ${marker}\n`);
      execFileSync("chmod", ["+x", join(tmp, "hooks", h)]);
    }
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(repo, "a.txt"), "changed\n");

    const r = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(r.ok).toBe(true);
    await deleteCheckpoints(root, "s1");
    expect(existsSync(marker)).toBe(false);
  });

  it("ignores GIT_* variables inherited by the daemon", async () => {
    initRepo();
    const decoy = join(tmp, "decoy");
    mkdirSync(decoy);
    execFileSync("git", ["init", "-q", "--bare", decoy]);
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
    };
    process.env.GIT_DIR = decoy;
    process.env.GIT_INDEX_FILE = join(tmp, "decoy-index");
    process.env.GIT_OBJECT_DIRECTORY = join(decoy, "objects");
    try {
      const r = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(show("s1", r.sha, "a.txt")).toBe("one\n");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(execFileSync("git", ["--git-dir", decoy, "for-each-ref"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["--git-dir", decoy, "count-objects"], { encoding: "utf8" })).toStartWith("0 objects");
  });

  it("skips (with a reason) when new content exceeds the limits", async () => {
    initRepo();
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(4096));
    const bySize = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1", limits: { maxUntrackedBytes: 1024 } });
    expect(bySize.ok).toBe(false);
    if (!bySize.ok) expect(bySize.reason).toContain("untracked files exceed");
    const byCount = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t2", limits: { maxUntrackedFiles: 0 } });
    expect(byCount.ok).toBe(false);
    if (!byCount.ok) expect(byCount.reason).toContain("too many untracked files");
    expect((await listCheckpoints(root, "s1")).size).toBe(0);
  });

  it("records a snapshot taken after the turn started as late", async () => {
    initRepo();
    const r = await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1", isLate: () => true });
    expect(r).toMatchObject({ ok: true, late: true });
    expect((await listCheckpoints(root, "s1")).get("t1")?.late).toBe(true);
  });

  it("runs one snapshot per session at a time", async () => {
    initRepo();
    const [a, b] = await Promise.all([
      createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" }),
      createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t2" }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it("refuses ids that could escape the storage directory or ref namespace", async () => {
    initRepo();
    expect(() => shadowRepoPath(root, "../x")).toThrow();
    expect((await createCheckpoint({ root, workdir: repo, sessionId: "../x", turnId: "t" })).ok).toBe(false);
    expect((await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "../../heads/main" })).ok).toBe(false);
  });

  it("keeps its storage owner-only", async () => {
    initRepo();
    await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: "t1" });
    expect(statSync(root).mode & 0o077).toBe(0);
    expect(statSync(join(shadowRepoPath(root, "s1"), "turns.log")).mode & 0o077).toBe(0);
  });
});

describe("listing, pruning, copying, sweeping, deleting", () => {
  it("lists in recorded order, prunes the oldest past the cap, and distrusts a tampered ref", async () => {
    initRepo();
    for (const t of ["t1", "t2", "t3"]) {
      writeFileSync(join(repo, "a.txt"), `${t}\n`);
      expect((await createCheckpoint({ root, workdir: repo, sessionId: "s1", turnId: t, limits: { maxPerSession: 2 } })).ok).toBe(true);
    }
    const s1 = await listCheckpoints(root, "s1");
    expect([...s1.keys()]).toEqual(["t2", "t3"]); // daemon order, no clock involved
    expect(show("s1", s1.get("t3")!.sha, "a.txt")).toBe("t3\n");

    // Something repoints a ref behind the daemon's back: no longer trusted.
    await shadowGit(root, "s1", ["update-ref", "refs/turns/t3", s1.get("t2")!.sha]);
    expect([...(await listCheckpoints(root, "s1")).keys()]).toEqual(["t2"]);
  });

  it("copies checkpoints to a fork, which keeps them after the source is deleted", async () => {
    initRepo();
    writeFileSync(join(repo, "a.txt"), "at-t1\n");
    await createCheckpoint({ root, workdir: repo, sessionId: "parent", turnId: "t1" });
    writeFileSync(join(repo, "a.txt"), "at-t2\n");
    await createCheckpoint({ root, workdir: repo, sessionId: "parent", turnId: "t2" });

    expect(await copyCheckpoints({ root, fromSessionId: "parent", toSessionId: "fork", toWorkdir: repo, turnIds: ["t1"] })).toBe(1);
    await deleteCheckpoints(root, "parent");
    expect(existsSync(shadowRepoPath(root, "parent"))).toBe(false);
    const fork = await listCheckpoints(root, "fork");
    expect([...fork.keys()]).toEqual(["t1"]);
    expect(show("fork", fork.get("t1")!.sha, "a.txt")).toBe("at-t1\n");
  });

  it("sweeps the storage of sessions that no longer exist", async () => {
    initRepo();
    await createCheckpoint({ root, workdir: repo, sessionId: "alive", turnId: "t1" });
    await createCheckpoint({ root, workdir: repo, sessionId: "gone", turnId: "t1" });
    expect(await sweepCheckpoints(root, new Set(["alive"]))).toBe(1);
    expect(existsSync(shadowRepoPath(root, "alive"))).toBe(true);
    expect(existsSync(shadowRepoPath(root, "gone"))).toBe(false);
    expect(readFileSync(join(shadowRepoPath(root, "alive"), "turns.log"), "utf8")).toContain("t1");
  });
});
