/**
 * Real bubblewrap, skipped where it can't run (#448 round 14): every path a
 * sandbox binds by name is pinned and bound as pinned, never resolved again
 * at a launch. A dir another session's command swaps for a link (a dir held
 * in place in this session's spec, a path held read-only there) is refused at
 * this session's next command, by the handle and by a launcher written
 * before, never bound where the link leads: the daemon's private dir with
 * every session's launchers, another repository (findings-r 1).
 *
 * Every swap from inside runs inside the sandbox under test (the other
 * session's own); every swap from outside is the test's own, on the host,
 * against directories it planted in its own scratch dir. Nothing else is read
 * or written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { SandboxPinError } from "../daemon/sandbox/pinned.js";
import { buildSandboxSpec, type SpecInputs } from "../daemon/sandbox/policy.js";
import { launcherScript } from "../daemon/sandbox/session-sandbox.js";
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
function repo(dir: string, home: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "readme\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "init"]]) {
    const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env: gitEnv(home) });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
}

const PLANTED_SETTINGS = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] } });

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: what a sandbox binds by name is never followed (#448 round 14)", () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-held-")));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string>) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  function fixture(name: string) {
    const dir = join(base, name);
    const home = join(dir, "home");
    const W = join(home, "Workspace");
    const tmp = join(dir, "tmp");
    mkdirSync(tmp, { recursive: true });
    // What a link could lead to: a planted "home" (its key, its shell startup file) and a planted daemon dir.
    const fakeHome = join(dir, "fake-home");
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "id_ed25519"), "PLANTED-KEY\n");
    writeFileSync(join(fakeHome, ".bashrc"), "# planted\n");
    const daemonDir = join(dir, "daemon-private");
    mkdirSync(join(daemonDir, "launchers"), { recursive: true });
    writeFileSync(join(daemonDir, "launchers", "launch-x"), "#!/bin/sh\necho original\n");
    const planted = join(dir, "planted-settings.json");
    writeFileSync(planted, PLANTED_SETTINGS);
    const hidden = { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: daemonDir };
    const spec = (inputs: Partial<SpecInputs> & { workspace: string }) => buildSandboxSpec({ sessionId: name, tempDir: tmp, network: { mode: "off" }, hidden, cache: false, ...inputs });
    return { dir, home, W, tmp, fakeHome, daemonDir, planted, spec, env: gitEnv(home) };
  }
  const intact = (f: { fakeHome: string; daemonDir: string }) =>
    readFileSync(join(f.fakeHome, ".bashrc"), "utf8") === "# planted\n" && readFileSync(join(f.daemonDir, "launchers", "launch-x"), "utf8") === "#!/bin/sh\necho original\n";

  test("another session swaps a dir held in place in this one's spec for a link (to the daemon's private dir, to elsewhere): this one's next command is refused, by the handle and by a launcher written before; nothing bound there", async () => {
    for (const where of ["daemon", "other"] as const) {
      const f = fixture(`held-${where}`);
      const a = join(f.W, "a");
      const infra = join(f.W, "infra");
      repo(a, f.home);
      repo(infra, f.home);
      mkdirSync(join(infra, "sub"));
      writeFileSync(join(infra, "sub", ".env"), "SECRET=PLANTED-INFRA-ENV\n");
      const other = join(f.dir, "other-repo");
      mkdirSync(other);
      const target = where === "daemon" ? f.daemonDir : other;
      // A: the agent added infra itself (its .env hidden, so infra/sub held in place).
      const specA = f.spec({ workspace: a, projectRoots: [f.W], addedDirs: [{ dir: infra, agent: true }] });
      expect(specA.pinned).toContain(join(infra, "sub"));
      const hA = await provider.open(specA);
      // B: the owner's session in infra (nothing of it hidden there).
      const hB = await provider.open(f.spec({ workspace: infra, projectRoots: [] }));
      try {
        expect((await sh(hA, a, `cat ${infra}/sub/.env 2>&1; echo read-done`, f.env)).stdout).not.toContain("PLANTED-INFRA-ENV");
        const launcher = join(f.tmp, "launch-a");
        writeFileSync(launcher, launcherScript(hA.wrap?.(["/bin/sh", "-c"], { cwd: "", env: {} }).argv ?? []), { mode: 0o700 });
        // B's own command, in B's own sandbox: allowed there.
        expect((await sh(hB, infra, `mv sub sub0 && ln -s ${target} sub && echo SWAPPED`, f.env)).stdout).toContain("SWAPPED");
        const attempt = `echo PWNED > ${infra}/sub/launchers/launch-x 2>&1; echo t > ${infra}/sub/probe && echo WROTE; cat ${infra}/sub0/.env 2>&1; echo RAN`;
        await expect(sh(hA, a, attempt, f.env)).rejects.toThrow(`a directory held in place ${join(infra, "sub")} is reached through a symbolic link now`);
        const r = Bun.spawnSync([launcher, attempt], { cwd: a, env: f.env, stdout: "pipe", stderr: "pipe" });
        expect(r.exitCode).toBe(126);
        expect(r.stdout.toString()).not.toContain("RAN");
        expect(existsSync(join(target, "probe"))).toBe(false);
        expect(intact(f)).toBe(true);
      } finally {
        await hA.close();
        await hB.close();
      }
    }
  });

  test("another session swaps a path held read-only in this one's spec for a link: refused, never bound where it leads", async () => {
    const f = fixture("held-ro");
    const a = join(f.W, "a");
    const infra = join(f.W, "infra");
    repo(a, f.home);
    repo(infra, f.home);
    const specA = f.spec({ workspace: a, addedDirs: [{ dir: infra, agent: true }] });
    expect(specA.readOnly).toContain(join(infra, ".claude"));
    const hA = await provider.open(specA);
    try {
      expect((await sh(hA, a, "echo ok", f.env)).stdout).toBe("ok\n");
      // Outside A's sandbox (another session's, or the host): its held .claude swapped for a link to the daemon's dir.
      renameSync(join(infra, ".claude"), join(infra, ".claude-old"));
      symlinkSync(f.daemonDir, join(infra, ".claude"));
      await expect(sh(hA, a, `ls ${f.daemonDir} 2>&1; echo RAN`, f.env)).rejects.toThrow(SandboxPinError);
      await expect(sh(hA, a, "true", f.env)).rejects.toThrow(`a path held read-only ${join(infra, ".claude")} is reached through a symbolic link now`);
      expect(intact(f)).toBe(true);
    } finally {
      await hA.close();
    }
  });
});
