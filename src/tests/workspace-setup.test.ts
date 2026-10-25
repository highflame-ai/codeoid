/**
 * workspace-setup — the repository setup recipe for worktrees codeoid
 * creates (design §12.7). Real `git` against throwaway repos: the recipe is
 * read from the primary checkout's committed HEAD (never a branch or the
 * working tree), copy/share stay inside the primary checkout, the command
 * runs only when the repository is trusted, and a bad recipe leaves nothing
 * behind.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCheckpoint, deleteCheckpoints, shadowGitLiteral } from "../daemon/checkpoints.js";
import { applyCarriedState, createForkWorktree, removeForkWorktree } from "../daemon/git-worktree.js";
import {
  brokenShares,
  commandRefusal,
  describeSetupResult,
  parseSetupRecipe,
  setupEvent,
  prepareWorktree,
  readSetupRecipe,
  SetupRecipeError,
  type WorktreeSetupPolicy,
} from "../daemon/workspace-setup.js";
import { loadConfig, validateConfigObject } from "../config.js";

const execFileP = promisify(execFile);
const g = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());

let tmp: string;
let repo: string;
let n = 0;

const NEVER: WorktreeSetupPolicy = { runCommands: "never", trustedRepos: [] };
/** Trust the recipe now committed at the primary checkout's HEAD, as `codeoid worktree trust` records it. */
const trusted = async (): Promise<WorktreeSetupPolicy> => {
  const found = await readSetupRecipe(repo).catch(() => null);
  return { runCommands: "trusted-repos", trustedRepos: found ? [{ path: repo, recipeHash: found.recipeHash }] : [] };
};

async function commitRecipe(yaml: string, extra: Record<string, string> = {}): Promise<void> {
  mkdirSync(join(repo, ".codeoid"), { recursive: true });
  writeFileSync(join(repo, ".codeoid", "setup.yaml"), yaml);
  for (const [f, body] of Object.entries(extra)) writeFileSync(join(repo, f), body);
  await g(["add", "-A"], repo);
  await g(["commit", "-m", "recipe"], repo);
}

async function newWorktree(opts: { baseBranch?: string; workdir?: string } = {}) {
  return createForkWorktree({ workdir: opts.workdir ?? repo, label: "setup", shortId: `t${++n}`, ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}) });
}

/** Everything in the worktree except .git, for "nothing was left behind" checks. */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => p !== ".git" && !p.startsWith(".git/"))
    .sort();
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-setup-")));
  repo = join(tmp, "repo");
  await execFileP("git", ["init", "-b", "main", repo]);
  await g(["config", "user.email", "t@t.dev"], repo);
  await g(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "file.txt"), "committed\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\nnode_modules\n*.local.json\n");
  await g(["add", "."], repo);
  await g(["commit", "-m", "init"], repo);
  // The primary checkout's ignored state a fresh worktree lacks.
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseSetupRecipe", () => {
  it("accepts the full shape and normalizes paths", () => {
    const r = parseSetupRecipe(
      "copy: [./.env, 'config/*.local.json']\nshare: [node_modules/]\ncommand: bun install\ntimeoutSec: 30\nresources: { ports: 2, env: [DATABASE_URL] }\n",
    );
    expect(r.copy).toEqual([".env", "config/*.local.json"]);
    expect(r.share).toEqual(["node_modules"]);
    expect(r.command).toBe("bun install");
    expect(r.timeoutSec).toBe(30);
    expect(r.resources).toEqual({ ports: 2, env: ["DATABASE_URL"] });
  });

  it("an empty file is an empty recipe", () => {
    expect(parseSetupRecipe("")).toEqual({ copy: [], share: [] });
  });

  it("rejects paths that leave the repository, and unknown keys", () => {
    for (const bad of [
      "copy: ['../outside']",
      "copy: ['a/../../b']",
      "copy: ['/etc/passwd']",
      "copy: ['~/.ssh/id_rsa']",
      "copy: ['.git/config']",
      "copy: ['C:/x']",
      "copy: ['a\\\\b']",
      "share: ['node_*']",
      "share: ['.']",
      "share: ['../deps']",
      "share: ['.claude']",
      "share: ['.codeoid']",
      "share: ['tools/.VSCode']",
      "share: ['.idea']",
      "share: ['.husky']",
      "share: ['.github']",
      "share: ['.git-hooks']",
      "copy: ['.GIT/config']",
      "commands: echo",
      "resources: { ports: 1, cpus: 2 }",
      "resources: { env: [lower_case] }",
      "timeoutSec: 0",
    ]) {
      expect(() => parseSetupRecipe(bad), bad).toThrow(SetupRecipeError);
    }
  });

  it("invalid YAML names the file", () => {
    expect(() => parseSetupRecipe("copy: [unclosed")).toThrow(/setup\.yaml is not valid YAML/);
  });
});

describe("readSetupRecipe", () => {
  it("is null without a recipe and without a commit", async () => {
    expect(await readSetupRecipe(repo)).toBeNull();
    const empty = join(tmp, "empty");
    await execFileP("git", ["init", "-b", "main", empty]);
    expect(await readSetupRecipe(empty)).toBeNull();
  });

  it("reads the committed HEAD of the primary checkout, never its working tree", async () => {
    await commitRecipe("copy: [.env]\n");
    // An uncommitted edit (an agent's, say) is not the recipe.
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "copy: [.env]\ncommand: touch pwned\n");
    const found = await readSetupRecipe(repo);
    expect(found?.recipe.command).toBeUndefined();
    expect(found?.rev).toBe(await g(["rev-parse", "HEAD"], repo));
  });

  it("refuses a recipe that is a symlink in the tree", async () => {
    mkdirSync(join(repo, ".codeoid"));
    symlinkSync("/etc/hostname", join(repo, ".codeoid", "setup.yaml"));
    await g(["add", "-A"], repo);
    await g(["commit", "-m", "link"], repo);
    await expect(readSetupRecipe(repo)).rejects.toThrow(/must be a regular file/);
  });
});

describe("prepareWorktree", () => {
  it("without a recipe, a worktree is exactly what createForkWorktree made", async () => {
    const wt = await newWorktree();
    const before = listing(wt.path);
    const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted() });
    expect(r).toEqual({ applied: false, copied: [], shared: [], skipped: [], warnings: [] });
    expect(listing(wt.path)).toEqual(before);
  });

  it("copies ignored files and shares directories from the primary checkout", async () => {
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", "db.local.json"), "{}\n");
    await commitRecipe("copy: [.env, 'config/*.local.json']\nshare: [node_modules]\nresources: { ports: 1 }\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });

    expect(r.error).toBeUndefined();
    expect(r.applied).toBe(true);
    expect(r.copied).toEqual([".env", "config/db.local.json"]);
    expect(r.shared).toEqual(["node_modules"]);
    expect(r.resources).toEqual({ ports: 1 });
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(lstatSync(join(wt.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(wt.path, "node_modules"))).toBe(join(repo, "node_modules"));
    expect(existsSync(join(wt.path, "node_modules", "dep", "index.js"))).toBe(true);
    // Nothing the recipe added shows up to git.
    expect(await g(["status", "--porcelain"], wt.path)).toBe("");
  });

  it("a recipe changed only on a branch is ignored — the primary checkout's HEAD wins", async () => {
    await commitRecipe("copy: [.env]\n");
    await g(["checkout", "-b", "feature"], repo);
    await commitRecipe("copy: [.env]\nshare: [node_modules]\ncommand: touch pwned\n");
    await g(["checkout", "main"], repo);

    // A clean worktree of the branch …
    const wt = await newWorktree({ baseBranch: "feature" });
    expect(readFileSync(join(wt.path, ".codeoid", "setup.yaml"), "utf8")).toContain("pwned");
    const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted() });
    expect(r.copied).toEqual([".env"]);
    expect(r.shared).toEqual([]);
    expect(r.command).toBeUndefined();
    expect(existsSync(join(wt.path, "pwned"))).toBe(false);

    // … and a fork whose parent is itself a worktree on that branch.
    const parent = join(tmp, "feature-wt");
    await g(["worktree", "add", parent, "feature"], repo);
    const child = await newWorktree({ workdir: parent });
    const r2 = await prepareWorktree({ worktreePath: child.path, policy: await trusted() });
    expect(r2.recipeRev).toBe(await g(["rev-parse", "main"], repo));
    expect(r2.command).toBeUndefined();
    expect(existsSync(join(child.path, "pwned"))).toBe(false);
  });

  it("refuses symlink escapes out of the primary checkout", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "not yours\n");
    symlinkSync(join(outside, "secret.txt"), join(repo, ".env.escape"));
    symlinkSync(outside, join(repo, "deps"));
    writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\nnode_modules\ndeps\n");
    await commitRecipe("copy: [.env.escape]\nshare: [deps]\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });

    expect(r.copied).toEqual([]);
    expect(r.shared).toEqual([]);
    expect(r.skipped.map((s) => s.path).sort()).toEqual([".env.escape", "deps"]);
    expect(r.skipped.every((s) => /outside the primary checkout/.test(s.reason))).toBe(true);
    expect(existsSync(join(wt.path, ".env.escape"))).toBe(false);
    expect(existsSync(join(wt.path, "deps"))).toBe(false);
  });

  it("never copies a file with other hard links", async () => {
    const outside = join(tmp, "outside-secret");
    writeFileSync(outside, "elsewhere\n");
    linkSync(outside, join(repo, ".env.linked"));
    await commitRecipe("copy: [.env.linked, .env]\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });
    expect(r.copied).toEqual([".env"]);
    expect(r.skipped).toEqual([{ path: ".env.linked", reason: "has other hard links (the same file may live outside the primary checkout)" }]);
  });

  it("with deferCarry, the command sees only committed content and the uncommitted edits arrive after", async () => {
    await commitRecipe("copy: [.env]\ncommand: cat file.txt > seen.txt\n");
    writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\nnode_modules\n*.local.json\nseen.txt\n");
    await g(["commit", "-qam", "ignore seen"], repo);
    const policy = await trusted();
    writeFileSync(join(repo, "file.txt"), "committed\nagent edit\n"); // uncommitted
    const wt = await createForkWorktree({ workdir: repo, label: "setup", shortId: `t${++n}`, deferCarry: true });
    expect(wt.carry).toBeDefined();
    expect(readFileSync(join(wt.path, "file.txt"), "utf8")).toBe("committed\n");
    const r = await prepareWorktree({ worktreePath: wt.path, policy });
    expect(r.command?.exitCode).toBe(0);
    expect(readFileSync(join(wt.path, "seen.txt"), "utf8")).toBe("committed\n");
    await applyCarriedState(wt.path, wt.carry!);
    expect(readFileSync(join(wt.path, "file.txt"), "utf8")).toBe("committed\nagent edit\n");
    // Uncommitted, on HEAD — as an immediate carry leaves it — and the recipe's files untouched.
    expect(await g(["rev-parse", "HEAD"], wt.path)).toBe(await g(["rev-parse", "HEAD"], repo));
    expect(await g(["status", "--porcelain"], wt.path)).toBe("M file.txt");
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("never copies a file git wouldn't ignore, and never overwrites one", async () => {
    await commitRecipe("copy: [notes.txt, file.txt]\n");
    writeFileSync(join(repo, "notes.txt"), "untracked, not ignored\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });
    expect(r.copied).toEqual([]);
    expect(r.skipped).toEqual([
      { path: "file.txt", reason: "already exists in the new worktree (not overwritten)" },
      { path: "notes.txt", reason: "is not ignored by git in the new worktree (copying it would let it be committed)" },
    ]);
    expect(existsSync(join(wt.path, "notes.txt"))).toBe(false);
    expect(readFileSync(join(wt.path, "file.txt"), "utf8")).toBe("committed\n");
  });

  it("refuses to write through a tracked symlink in the worktree", async () => {
    const outside = join(tmp, "outside-dir");
    mkdirSync(outside);
    // A branch where `cfg` is a tracked symlink out of the repository.
    const side = join(tmp, "side");
    await g(["worktree", "add", "-q", "-b", "linked", side], repo);
    symlinkSync(outside, join(side, "cfg"));
    await g(["add", "cfg"], side);
    await g(["commit", "-q", "-m", "link"], side);
    await g(["worktree", "remove", "--force", side], repo);
    // In the primary checkout `cfg/.env` is a real, ignored file.
    mkdirSync(join(repo, "cfg"));
    writeFileSync(join(repo, "cfg", ".env"), "X=1\n");
    await commitRecipe("copy: [cfg/.env]\n");

    const wt = await newWorktree({ baseBranch: "linked" });
    expect(lstatSync(join(wt.path, "cfg")).isSymbolicLink()).toBe(true);
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });
    expect(r.error).toBeUndefined();
    expect(r.copied).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/isn't a plain directory/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("an invalid recipe is a clear error and leaves nothing behind", async () => {
    await commitRecipe("copy: [.env]\nshare: [node_modules\n");
    const wt = await newWorktree();
    const before = listing(wt.path);
    const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted() });
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/setup\.yaml is not valid YAML/);
    expect(listing(wt.path)).toEqual(before);

    await commitRecipe("copy: [.env, ../escape]\n");
    const wt2 = await newWorktree();
    const r2 = await prepareWorktree({ worktreePath: wt2.path, policy: await trusted() });
    expect(r2.error).toMatch(/\.\. segment/);
    expect(existsSync(join(wt2.path, ".env"))).toBe(false);
  });

  it("does not apply a recipe to the primary checkout itself", async () => {
    await commitRecipe("copy: [.env]\n");
    const r = await prepareWorktree({ worktreePath: repo, policy: NEVER });
    expect(r.error).toMatch(/primary checkout itself/);
  });
});

describe("prepareWorktree — the setup command", () => {
  it("never runs when the setting is never (the default)", async () => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp; // an empty config: the defaults
    try {
      expect(loadConfig().worktree?.setup).toEqual({ runCommands: "never", trustedRepos: [] });
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
    await commitRecipe("command: touch ran\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });
    expect(r.command).toBeUndefined();
    expect(r.commandSkipped).toMatch(/recipe commands are off/);
    expect(r.error).toBeUndefined();
    expect(existsSync(join(wt.path, "ran"))).toBe(false);
  });

  it("never runs for a repository the owner didn't trust, nor one trusted by path only", async () => {
    await commitRecipe("copy: [.env]\ncommand: touch ran\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: { runCommands: "trusted-repos", trustedRepos: [join(tmp, "other")] } });
    expect(r.commandSkippedCode).toBe("untrusted");
    expect(r.commandSkipped).toMatch(/isn't trusted — run `codeoid worktree trust`/);
    expect(r.copied).toEqual([".env"]);
    const wt2 = await newWorktree();
    const r2 = await prepareWorktree({ worktreePath: wt2.path, policy: { runCommands: "trusted-repos", trustedRepos: [repo] } });
    expect(r2.commandSkippedCode).toBe("untrusted");
    expect(r2.commandSkipped).toMatch(/trusted by path only/);
    expect(setupEvent(r2)).toBe("worktree.setup.untrusted");
    expect(existsSync(join(wt.path, "ran"))).toBe(false);
    expect(existsSync(join(wt2.path, "ran"))).toBe(false);
  });

  it("a recipe changed since it was trusted runs no command — copy/share still apply — until trusted again", async () => {
    await commitRecipe("copy: [.env]\ncommand: touch ran\n");
    const policy = await trusted();
    await commitRecipe("copy: [.env]\ncommand: touch ran-changed\n");

    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy });
    expect(r.commandSkippedCode).toBe("changed");
    expect(r.commandSkipped).toMatch(/the setup command changed since you trusted it — run `codeoid worktree trust`/);
    expect(setupEvent(r)).toBe("worktree.setup.untrusted");
    expect(describeSetupResult(r)).toMatch(/without its setup command/);
    expect(r.error).toBeUndefined();
    expect(r.copied).toEqual([".env"]);
    expect(existsSync(join(wt.path, "ran-changed"))).toBe(false);

    // Re-trusting the new recipe runs it.
    const wt2 = await newWorktree();
    const r2 = await prepareWorktree({ worktreePath: wt2.path, policy: await trusted() });
    expect(r2.command?.exitCode).toBe(0);
    expect(existsSync(join(wt2.path, "ran-changed"))).toBe(true);
  });

  it("a base commit off the primary checkout's history runs no command (a branch, a PR ref) — files still apply", async () => {
    await commitRecipe("copy: [.env]\ncommand: touch ran\n");
    const policy = await trusted();
    await g(["checkout", "-q", "-b", "feature"], repo);
    writeFileSync(join(repo, "feature.txt"), "unreviewed\n");
    await g(["add", "feature.txt"], repo);
    await g(["commit", "-qm", "unmerged"], repo);
    await g(["checkout", "-q", "main"], repo);

    const wt = await newWorktree({ baseBranch: "feature" });
    const r = await prepareWorktree({ worktreePath: wt.path, policy });
    expect(r.commandSkippedCode).toBe("base-not-on-primary");
    expect(setupEvent(r)).toBe("worktree.setup.untrusted");
    expect(r.copied).toEqual([".env"]);
    expect(existsSync(join(wt.path, "ran"))).toBe(false);
  });

  it("a fork of a codeoid branch with an agent's commit runs no command", async () => {
    await commitRecipe("command: touch ran\n");
    const policy = await trusted();
    const parent = await newWorktree();
    writeFileSync(join(parent.path, "agent.txt"), "agent work\n");
    await g(["add", "agent.txt"], parent.path);
    await g(["commit", "-qm", "agent commit"], parent.path);
    const child = await createForkWorktree({ workdir: parent.path, label: "child", shortId: `t${++n}`, deferCarry: true });
    const r = await prepareWorktree({ worktreePath: child.path, policy });
    expect(r.commandSkippedCode).toBe("base-not-on-primary");
    expect(existsSync(join(child.path, "ran"))).toBe(false);
  });

  it("an earlier commit on the primary history runs it — unless that commit's recipe isn't the trusted one", async () => {
    await commitRecipe("command: touch ran\n");
    const earlier = await g(["rev-parse", "HEAD"], repo);
    writeFileSync(join(repo, "later.txt"), "x\n");
    await g(["add", "later.txt"], repo);
    await g(["commit", "-qm", "later"], repo);
    const policy = await trusted();
    const wt = await createForkWorktree({ workdir: repo, label: "earlier", shortId: `t${++n}`, baseCommit: earlier });
    const r = await prepareWorktree({ worktreePath: wt.path, policy });
    expect(r.command?.exitCode).toBe(0);
    expect(existsSync(join(wt.path, "ran"))).toBe(true);

    // The recipe changed after `earlier`, and the new one is what's trusted:
    // `earlier` carries a recipe nobody trusted, so nothing runs there.
    await commitRecipe("command: touch ran2\n");
    const wt2 = await createForkWorktree({ workdir: repo, label: "earlier", shortId: `t${++n}`, baseCommit: earlier });
    const r2 = await prepareWorktree({ worktreePath: wt2.path, policy: await trusted() });
    expect(r2.commandSkippedCode).toBe("base-not-on-primary");
  });

  it("a trust entry holds only for its owner's worktrees", async () => {
    await commitRecipe("command: touch ran\n");
    const recipeHash = (await readSetupRecipe(repo))!.recipeHash;
    const policy: WorktreeSetupPolicy = { runCommands: "trusted-repos", trustedRepos: [{ path: repo, recipeHash, trustedBy: "alice" }] };
    const wt = await newWorktree();
    expect((await prepareWorktree({ worktreePath: wt.path, policy, ownerSub: "bob" })).commandSkippedCode).toBe("untrusted");
    expect(existsSync(join(wt.path, "ran"))).toBe(false);
    const wt2 = await newWorktree();
    expect((await prepareWorktree({ worktreePath: wt2.path, policy, ownerSub: "alice" })).command?.exitCode).toBe(0);
  });

  it("a carry that fails leaves the worktree at its last commit, not half-applied", async () => {
    writeFileSync(join(repo, "file.txt"), "committed\nedit\n");
    const wt = await createForkWorktree({ workdir: repo, label: "carry", shortId: `t${++n}`, deferCarry: true });
    writeFileSync(join(wt.path, "file.txt"), "half\n"); // as if a restore had got part-way
    await expect(applyCarriedState(wt.path, { ...wt.carry!, snapshot: "f".repeat(40) })).rejects.toThrow(/put back to its last commit/);
    expect(readFileSync(join(wt.path, "file.txt"), "utf8")).toBe("committed\n");
    expect(await g(["status", "--porcelain"], wt.path)).toBe("");
  });

  it("brokenShares names shared entries that are no longer the recipe's links", async () => {
    await commitRecipe("share: [node_modules]\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });
    expect(brokenShares(wt.path, r.shared)).toEqual([]);
    rmSync(join(wt.path, "node_modules"));
    mkdirSync(join(wt.path, "node_modules"));
    expect(brokenShares(wt.path, r.shared)).toEqual(["node_modules"]);
  });

  it("kills what the command left running when it exits, and redacts secrets in its output", async () => {
    await commitRecipe("command: '(sleep 1; touch late) & echo api_key=sk-abcdef0123456789abcdef0123'\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted() });
    expect(r.command?.exitCode).toBe(0);
    expect(r.command?.outputTail).toContain("api_key=");
    expect(r.command?.outputTail).not.toContain("sk-abcdef0123456789abcdef0123");
    await new Promise((res) => setTimeout(res, 1_500));
    expect(existsSync(join(wt.path, "late"))).toBe(false);
  });

  it("runs in the new worktree for a trusted repository, after the files are in place", async () => {
    await commitRecipe("copy: [.env]\ncommand: 'cat .env > ran && echo \"hello from setup\" && test -z \"$CODEOID_API_KEY\"'\n");
    const wt = await newWorktree();
    const prev = process.env.CODEOID_API_KEY;
    process.env.CODEOID_API_KEY = "zid_sk_must_not_leak";
    try {
      const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted() });
      expect(r.error).toBeUndefined();
      expect(r.command?.exitCode).toBe(0);
      expect(r.command?.timedOut).toBe(false);
      expect(r.command?.outputTail).toContain("hello from setup");
      expect(readFileSync(join(wt.path, "ran"), "utf8")).toBe("SECRET=1\n");
    } finally {
      if (prev === undefined) delete process.env.CODEOID_API_KEY;
      else process.env.CODEOID_API_KEY = prev;
    }
  });

  it("a failing command is reported with its output and keeps the worktree", async () => {
    await commitRecipe("copy: [.env]\ncommand: 'echo boom >&2; exit 3'\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted() });
    expect(r.command?.exitCode).toBe(3);
    expect(r.command?.outputTail).toContain("boom");
    expect(r.error).toBe("the setup command exited 3");
    expect(r.copied).toEqual([".env"]);
    expect(existsSync(join(wt.path, ".env"))).toBe(true);
  });

  it("times out, killing the command's whole process group", async () => {
    await commitRecipe("command: 'sleep 30 & sleep 30'\ntimeoutSec: 1\n");
    const wt = await newWorktree();
    const t0 = Date.now();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted() });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.command?.timedOut).toBe(true);
    expect(r.error).toBe("the setup command timed out after 1s");
  });

  it("an abort stops a running command", async () => {
    await commitRecipe("command: 'sleep 30'\n");
    const wt = await newWorktree();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const r = await prepareWorktree({ worktreePath: wt.path, policy: await trusted(), signal: abort.signal });
    expect(r.command?.exitCode).toBeNull();
    expect(r.error).toBeDefined();
  });

  it("commandRefusal pins the blob and compares real, absolute paths", () => {
    const hash = "0".repeat(40);
    expect(commandRefusal(undefined, repo, hash)?.code).toBe("off");
    expect(commandRefusal({ runCommands: "trusted-repos", trustedRepos: [{ path: `${repo}/`, recipeHash: hash }] }, repo, hash)).toBeNull();
    expect(commandRefusal({ runCommands: "trusted-repos", trustedRepos: [{ path: `${repo}/`, recipeHash: hash }] }, repo, "1".repeat(40))?.code).toBe("changed");
    // A relative path is never a trust entry.
    const rel = join("..", repo.split("/").slice(1).join("/"));
    expect(commandRefusal({ runCommands: "trusted-repos", trustedRepos: [{ path: rel, recipeHash: hash }] }, repo, hash)?.code).toBe("untrusted");
  });

  it("the config schema takes trust entries with an absolute path and a blob id", () => {
    expect(validateConfigObject({ worktree: { setup: { trustedRepos: ["/abs", { path: "/abs", recipeHash: "a".repeat(40) }] } } }).ok).toBe(true);
    expect(validateConfigObject({ worktree: { setup: { trustedRepos: ["relative/path"] } } }).ok).toBe(false);
    expect(validateConfigObject({ worktree: { setup: { trustedRepos: [{ path: "/abs", recipeHash: "nope" }] } } }).ok).toBe(false);
  });
});

describe("what a recipe added stays out of commits and checkpoints", () => {
  it("removeForkWorktree takes copied files and shared links out before the WIP snapshot", async () => {
    // `node_modules/` matches a directory, not the symlink: the link is visible to git.
    writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    await commitRecipe("copy: [.env]\nshare: [node_modules]\n");
    const wt = await newWorktree();
    const r = await prepareWorktree({ worktreePath: wt.path, policy: NEVER });
    expect(r.shared).toEqual(["node_modules"]);
    expect(r.warnings.join()).toMatch(/isn't ignored by git/);
    writeFileSync(join(wt.path, "work.txt"), "the fork's own work\n");

    await removeForkWorktree({ workdir: repo, worktreePath: wt.path, branch: wt.branch, setup: { copied: r.copied, shared: r.shared } });
    const files = (await g(["ls-tree", "-r", "--name-only", wt.branch], repo)).split("\n");
    expect(files).toContain("work.txt");
    expect(files).not.toContain("node_modules");
    expect(files).not.toContain(".env");
    // The primary checkout's directory is untouched.
    expect(existsSync(join(repo, "node_modules", "dep", "index.js"))).toBe(true);
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("checkpoints exclude the recipe's paths even when git wouldn't ignore them", async () => {
    writeFileSync(join(repo, "plain-secret.txt"), "s\n");
    symlinkSync(join(repo, "node_modules"), join(repo, "linked-deps"));
    const root = join(tmp, "ckpt");
    const res = await createCheckpoint({
      root,
      workdir: repo,
      sessionId: "s1",
      turnId: "t1",
      excludePaths: [join(repo, "plain-secret.txt"), join(repo, "node_modules"), join(repo, "linked-deps")],
    });
    expect(res).toMatchObject({ ok: true });
    const sha = (res as { sha: string }).sha;
    const files = (await shadowGitLiteral(root, "s1", ["ls-tree", "-r", "--name-only", sha])).split("\n");
    expect(files).toContain("file.txt");
    expect(files).not.toContain("plain-secret.txt");
    expect(files).not.toContain("linked-deps");
    await deleteCheckpoints(root, "s1");
  });
});
