/**
 * Real bubblewrap, skipped where it can't run (#448 round 13): every
 * directory the sandbox binds by name is pinned, an agent's own added dir
 * keeps a project root's credential hiding, every git config git may read
 * with a credential in it is hidden, and a root named through a link is
 * hidden where it really is.
 *
 * Every swap is made by the test on the host, between two commands, against
 * directories it planted in its own scratch dir under a home of its own; what
 * runs inside is a read or a write of planted files only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { SandboxPinError } from "../daemon/sandbox/pinned.js";
import { buildSandboxSpec, type SpecInputs } from "../daemon/sandbox/policy.js";
import { resolveProjectRoots } from "../daemon/sandbox/project-roots.js";
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
function git(args: string[], cwd: string, home: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(home) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: pinned directories, an agent's own dir, credential configs (#448 round 13)", () => {
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

  const bashrcIntact = (fakeHome: string) => readFileSync(join(fakeHome, ".bashrc"), "utf8") === "# planted\n";

  test("the workspace swapped for a link to a planted home between commands: refused, by the handle and by a launcher written before; nothing read or written there", async () => {
    const f = fixture("ws-swap");
    const h = await provider.open(f.spec());
    try {
      expect((await sh(h, f.a, "echo ok > note.txt && cat README.md", f.env)).stdout).toBe("alpha readme\n");
      // A launcher written once (as a process backend's, opencode's shell, the git shim are).
      const launcher = join(f.tmp, "launch");
      writeFileSync(launcher, launcherScript(h.wrap?.(["/bin/sh", "-c"], { cwd: "", env: {} }).argv ?? []), { mode: 0o700 });
      renameSync(f.a, join(f.dir, "a-moved"));
      symlinkSync(f.fakeHome, f.a);
      await expect(sh(h, f.a, `cat ${f.a}/.ssh/id_ed25519; echo 'echo PWNED' >> ${f.a}/.bashrc`, f.env)).rejects.toThrow(SandboxPinError);
      const r = Bun.spawnSync([launcher, `cat ${f.a}/.ssh/id_ed25519; echo 'echo PWNED' >> ${f.a}/.bashrc; echo RAN`], { cwd: f.dir, env: f.env, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(126);
      expect(r.stdout.toString()).not.toContain("PLANTED-KEY");
      expect(r.stdout.toString()).not.toContain("RAN");
      expect(r.stderr.toString()).toContain("not the directory it was");
      expect(bashrcIntact(f.fakeHome)).toBe(true);
      // Nor is a spec built over it.
      expect(() => f.spec()).toThrow(SandboxPinError);
    } finally {
      await h.close();
    }
  });

  test("an added dir swapped for a link, or made anew: refused; a project root swapped: refused", async () => {
    const f = fixture("added-swap");
    const sub = join(f.b, "sub");
    mkdirSync(sub);
    const roots = resolveProjectRoots(["@parent"], f.a, { home: f.home }).roots;
    let h = await provider.open(f.spec({ addedDirs: [{ dir: sub }], projectRoots: roots }));
    try {
      expect((await sh(h, f.a, `echo one > ${sub}/f && cat ${sub}/f`, f.env)).stdout).toBe("one\n");
      renameSync(sub, join(f.b, "sub-old"));
      symlinkSync(f.fakeHome, sub);
      await expect(sh(h, f.a, `cat ${sub}/.ssh/id_ed25519; echo PWNED >> ${sub}/.bashrc`, f.env)).rejects.toThrow(`added directory ${sub} is reached through a symbolic link now`);
      expect(bashrcIntact(f.fakeHome)).toBe(true);
      // Another real dir in its place (a rename from elsewhere): not it either.
      rmSync(sub);
      mkdirSync(sub);
      await expect(sh(h, f.a, "true", f.env)).rejects.toThrow("isn't the directory it was");
    } finally {
      await h.close();
    }
    // The root: swapped for a link to the planted home.
    rmSync(sub, { recursive: true });
    renameSync(join(f.b, "sub-old"), sub);
    h = await provider.open(f.spec({ projectRoots: roots }));
    try {
      expect((await sh(h, f.a, `cat ${f.b}/README.md`, f.env)).stdout).toBe("bravo readme\n");
      renameSync(f.root, join(f.home, "Workspace-moved"));
      symlinkSync(f.fakeHome, f.root);
      await expect(sh(h, "/", `cat ${f.root}/.ssh/id_ed25519`, f.env)).rejects.toThrow(SandboxPinError);
    } finally {
      await h.close();
    }
  });

  test("a workspace inside an added dir: the dir between them can't be moved aside from inside (no link put where the workspace was)", async () => {
    const f = fixture("nested");
    const lib = join(f.b, "vendor", "lib");
    mkdirSync(lib, { recursive: true });
    git(["init", "-q", "-b", "main"], lib, f.home);
    const spec = f.spec({ workspace: lib, addedDirs: [{ dir: f.b }] });
    expect(spec.pinned).toContain(join(f.b, "vendor"));
    const h = await provider.open(spec);
    try {
      const r = await sh(h, "/", `mv ${f.b}/vendor ${f.b}/vendor0 && mkdir ${f.b}/vendor && ln -s ${f.fakeHome} ${lib} && echo SWAPPED`, f.env);
      expect(r.stdout).not.toContain("SWAPPED");
      expect(r.stderr).toContain("busy");
      expect(existsSync(join(f.b, "vendor0"))).toBe(false);
      // The added dir itself stays writable.
      expect((await sh(h, "/", `echo w > ${f.b}/w.txt && cat ${f.b}/w.txt`, f.env)).stdout).toBe("w\n");
    } finally {
      await h.close();
    }
  });

  test("a project root named through a link: its credential files hidden where it really is (by the link's path too)", async () => {
    const f = fixture("link-root");
    writeFileSync(join(f.b, ".env"), "LINKROOT-B-ENV\n");
    const code = join(f.home, "code");
    symlinkSync(f.root, code);
    const roots = resolveProjectRoots(["~/code"], f.a, { home: f.home }).roots;
    expect(roots).toEqual([f.root]);
    for (const given of [roots, [code]]) {
      const h = await provider.open(f.spec({ projectRoots: given }));
      try {
        const r = await sh(h, f.a, `cat ${f.b}/README.md; cat ${code}/b/.env 2>&1; cat ${f.b}/.env 2>&1`, f.env);
        expect(r.stdout).toContain("bravo readme");
        expect(r.stdout).not.toContain("LINKROOT-B-ENV");
      } finally {
        await h.close();
      }
    }
  });
});
