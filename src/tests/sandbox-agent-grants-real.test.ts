/**
 * Real bubblewrap, skipped where it can't run (#448 round 13): a directory
 * the agent added itself is writable, but a project root's credential
 * hiding stays in it (a `.env`, keys, a token in its git config, a deep
 * `.env` whose dirs can't be moved aside to show it); one the owner added
 * is the session's own, its credentials readable. What runs inside reads or
 * writes only files this test planted under a home of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec, type SpecInputs } from "../daemon/sandbox/policy.js";
import { resolveProjectRoots } from "../daemon/sandbox/project-roots.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";

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

function gitEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
}
function git(args: string[], cwd: string, home: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(home) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: an agent's own added dir keeps a root's credential hiding (#448 round 13)", () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-pins-")));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string>) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  /** `home/Workspace/{a,b}` (repositories), a planted fake home's secrets beside them, and a spec builder. */
  function fixture(name: string) {
    const dir = join(base, name);
    const home = join(dir, "home");
    const root = join(home, "Workspace");
    const a = join(root, "a");
    const b = join(root, "b");
    for (const r of [a, b]) {
      mkdirSync(r, { recursive: true });
      git(["init", "-q", "-b", "main"], r, home);
      writeFileSync(join(r, "README.md"), `${r === a ? "alpha" : "bravo"} readme\n`);
      git(["add", "."], r, home);
      git(["commit", "-qm", "init"], r, home);
    }
    // A planted "home" a link could lead to: its key and its shell startup file.
    const fakeHome = join(dir, "fake-home");
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "id_ed25519"), "PLANTED-KEY\n");
    writeFileSync(join(fakeHome, ".bashrc"), "# planted\n");
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const configDir = join(home, ".codeoid");
    const spec = (extra: Partial<SpecInputs> = {}) =>
      buildSandboxSpec({ sessionId: name, workspace: a, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir, env: { HOME: home }, daemonTmp: "/tmp" }, worktreeFolder: "agent-r13", cache: false, ...extra });
    return { dir, home, root, a, b, fakeHome, tmp, spec, env: gitEnv(home) };
  }

  test("an agent's own added dir: writable, its credentials (a .env, keys, a token in its git config) still hidden; the owner's: readable", async () => {
    const f = fixture("agent-dir");
    writeFileSync(join(f.b, ".env"), "B-ENV-SECRET\n");
    mkdirSync(join(f.b, ".aws"));
    writeFileSync(join(f.b, ".aws", "credentials"), "B-AWS-SECRET\n");
    writeFileSync(join(f.b, "deploy_key"), "B-DEPLOY-KEY\n");
    mkdirSync(join(f.b, "sub", "deep"), { recursive: true });
    writeFileSync(join(f.b, "sub", "deep", ".env"), "B-DEEP-SECRET\n");
    git(["remote", "add", "origin", "https://x:B-GIT-TOKEN@example.invalid/b.git"], f.b, f.home);
    const roots = resolveProjectRoots(["@parent"], f.a, { home: f.home }).roots;
    const read = `for p in .env .aws/credentials deploy_key sub/deep/.env .git/config; do cat ${f.b}/$p 2>/dev/null; done; echo done`;
    let h = await provider.open(f.spec({ projectRoots: roots, addedDirs: [{ dir: f.b, agent: true }] }));
    try {
      const r = await sh(h, f.a, read, f.env);
      expect(r.stdout).not.toMatch(/B-ENV-SECRET|B-AWS-SECRET|B-DEPLOY-KEY|B-DEEP-SECRET|B-GIT-TOKEN/);
      // Writable otherwise; the hidden file's dirs can't be moved aside to show it again.
      expect((await sh(h, f.a, `echo w > ${f.b}/new.txt && cat ${f.b}/new.txt`, f.env)).stdout).toBe("w\n");
      const moved = await sh(h, f.a, `mv ${f.b}/sub ${f.b}/sub2 && cat ${f.b}/sub2/deep/.env`, f.env);
      expect(moved.stdout).not.toContain("B-DEEP-SECRET");
    } finally {
      await h.close();
    }
    h = await provider.open(f.spec({ projectRoots: roots, addedDirs: [{ dir: f.b }] }));
    try {
      const r = await sh(h, f.a, read, f.env);
      for (const s of ["B-ENV-SECRET", "B-AWS-SECRET", "B-DEPLOY-KEY", "B-DEEP-SECRET", "B-GIT-TOKEN"]) expect(r.stdout).toContain(s);
    } finally {
      await h.close();
    }
  });

});
