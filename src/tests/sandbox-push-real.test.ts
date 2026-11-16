/**
 * Real bubblewrap, skipped where it can't run: the push's bundle is made
 * inside the session's sandbox (its git dir held read-only), streamed into a
 * file of the daemon's, so a ref or object the agent linked into a path the
 * sandbox hides leads nowhere and never reaches the push (round 5). What runs
 * inside reads only the repositories this test made under a home of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_BIN, gitEnv } from "../daemon/git-env.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import { bundleFromChild } from "../daemon/sandbox/push.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();

function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* next */
    }
  }
  return tmpdir();
}

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: the push's bundle (round 5)", () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-push-")));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("a branch the agent's commands can read is bundled; one linked into a hidden repository can't be, and nothing of it is staged", async () => {
    const home = join(base, "home");
    const work = join(home, "Workspace", "work");
    const configDir = join(home, ".codeoid");
    const secret = join(configDir, "secret-repo");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    for (const r of [work, secret]) {
      mkdirSync(r, { recursive: true });
      git(r, "init", "-q", "-b", "main");
      git(r, "commit", "-q", "--allow-empty", "-m", r === secret ? "TOPSECRET-HISTORY" : "work");
    }
    // What an agent's commands can do in its own repository: a ref, and the objects it names, linked into one the sandbox hides.
    const hidden = git(secret, "rev-parse", "HEAD");
    symlinkSync(join(secret, ".git", "refs", "heads", "main"), join(work, ".git", "refs", "heads", "leak"));
    for (const id of [hidden, git(secret, "rev-parse", "HEAD^{tree}")]) {
      const fan = join(work, ".git", "objects", id.slice(0, 2));
      mkdirSync(fan, { recursive: true });
      if (!existsSync(join(fan, id.slice(2)))) symlinkSync(join(secret, ".git", "objects", id.slice(0, 2), id.slice(2)), join(fan, id.slice(2)));
    }
    // On the host the link resolves: a host-side bundle would carry the hidden history.
    expect(git(work, "rev-parse", "refs/heads/leak")).toBe(hidden);

    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: "push-real", workspace: work, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir, env: { HOME: home }, daemonTmp: "/tmp" }, worktreeFolder: "agent-push", cache: false });
    const staging = join(base, "staging");
    mkdirSync(staging);
    const h = await provider.open(spec);
    try {
      const bundle = (ref: string, dest: string) =>
        bundleFromChild(h.spawn(GIT_BIN, ["-c", "core.fsmonitor=false", "-C", work, "bundle", "create", "-q", "-", ref], { cwd: work, env: gitEnv({ LANG: "C", HOME: home }) }), dest, { timeoutMs: 60_000 });
      // The agent's own branch: bundled in there, its stdout the daemon's file.
      const ok = join(staging, "ok.bundle");
      expect(await bundle("refs/heads/main", ok)).toBeNull();
      expect(git(base, "bundle", "list-heads", ok)).toContain(git(work, "rev-parse", "main"));
      // The plan reads the branch in there too: the linked ref names nothing (the host's git would name the hidden commit).
      const q = await h.exec([GIT_BIN, "-C", work, "rev-parse", "--verify", "-q", "refs/heads/leak^{commit}"], { cwd: work, env: gitEnv({ LANG: "C", HOME: home }), timeoutMs: 30_000 });
      expect(q.exitCode).not.toBe(0);
      expect(q.stdout).not.toContain(hidden);
      // The linked one: nothing to bundle in there.
      const leak = join(staging, "leak.bundle");
      expect(await bundle("refs/heads/leak", leak)).not.toBeNull();
      const staged = existsSync(leak) ? readFileSync(leak) : Buffer.alloc(0);
      expect(staged.includes(hidden)).toBe(false);
      expect(readdirSync(staging).sort()).toEqual(existsSync(leak) ? ["leak.bundle", "ok.bundle"] : ["ok.bundle"]);
    } finally {
      await h.close();
    }
  });
});
