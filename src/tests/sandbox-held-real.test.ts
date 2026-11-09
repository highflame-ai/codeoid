/**
 * Real bubblewrap, skipped where it can't run (#448 round 14): every
 * directory a held path is in stays in place, and the working directory is
 * pinned by its identity.
 *
 *   - a monorepo package session can't move its package dir (nor the dir
 *     above it) aside to plant the package's `.claude/settings.json`, which a
 *     later Claude start there would run on the host, nor put a link where
 *     its working directory was (findings-c H1, findings-s 1);
 *   - a repository inside an added dir can't be moved aside either
 *     (findings-c H1, same class);
 *   - the working directory replaced by another real directory is refused by
 *     its identity.
 *
 * Every swap from inside runs inside the sandbox under test; every swap from
 * outside is the test's own, on the host, against directories it planted in
 * its own scratch dir. Nothing else is read or written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { pinRecord } from "../daemon/sandbox/pinned.js";
import { buildSandboxSpec, type SpecInputs } from "../daemon/sandbox/policy.js";
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

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: what a sandbox holds stays in place (#448 round 14)", () => {
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

  test("a monorepo package session: its package dir, and the dir above it, can't be moved aside; its settings can't be planted; no link goes where it was", async () => {
    const f = fixture("mono");
    const top = join(f.W, "mono");
    const pkg = join(top, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "index.js"), "1\n");
    repo(top, f.home);
    const spec = f.spec({ workspace: top, workdir: pkg, pins: { [top]: pinRecord(top) as string, [pkg]: pinRecord(pkg) as string } });
    expect(spec.heldInPlace).toEqual(expect.arrayContaining([pkg, join(top, "packages")]));
    expect(spec.readOnly).toContain(join(pkg, ".claude"));
    const h = await provider.open(spec);
    try {
      const r = await sh(
        h,
        top,
        [
          `cd ${join(top, "packages")} && mv app app-old 2>&1; echo mv-pkg=$?`,
          `cd ${top} && mv packages packages-old 2>&1; echo mv-parent=$?`,
          `cd ${top} && mv packages/app packages/app.old 2>&1 && ln -s ${f.fakeHome} packages/app && echo SWAPPED`,
          `mkdir -p ${pkg}/.claude && cp ${f.planted} ${pkg}/.claude/settings.json 2>&1 && echo PLANTED`,
          `echo w > ${pkg}/own.txt && echo PKG-WRITABLE`,
          `cd ${pkg} && git status --short >/dev/null && echo GIT-OK`,
        ].join("; "),
        f.env,
      );
      expect(r.stdout).toContain("mv-pkg=1");
      expect(r.stdout).toContain("mv-parent=1");
      expect(r.stdout).toContain("busy");
      expect(r.stdout).not.toContain("SWAPPED");
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).toContain("PKG-WRITABLE");
      expect(r.stdout).toContain("GIT-OK");
      expect(existsSync(join(top, "packages", "app-old"))).toBe(false);
      expect(existsSync(join(top, "packages-old"))).toBe(false);
      expect(existsSync(join(pkg, ".claude", "settings.json"))).toBe(false);
      expect(intact(f)).toBe(true);
    } finally {
      await h.close();
    }
    // Replaced on the host by another real directory (moved aside, made again): refused by its identity.
    renameSync(pkg, join(top, "packages", "app-moved"));
    mkdirSync(pkg);
    expect(() => f.spec({ workspace: top, workdir: pkg, pins: { [top]: pinRecord(top) as string, [pkg]: pinRecord(join(top, "packages", "app-moved")) as string } })).toThrow(
      `the working directory ${pkg} isn't the directory it was`,
    );
  });

  test("a repository inside an added dir: it can't be moved aside to plant its settings", async () => {
    const f = fixture("nested");
    const a = join(f.W, "a");
    const b = join(f.W, "b-folder");
    repo(a, f.home);
    repo(join(b, "lib"), f.home);
    const spec = f.spec({ workspace: a, addedDirs: [{ dir: b }] });
    expect(spec.readOnly).toContain(join(b, "lib", ".claude"));
    expect(spec.heldInPlace).toContain(join(b, "lib"));
    const h = await provider.open(spec);
    try {
      const r = await sh(h, a, `cd ${b} && mv lib lib-old 2>&1; echo mv=$?; mkdir -p lib/.claude; cp ${f.planted} lib/.claude/settings.json 2>&1 && echo PLANTED; echo w > ${b}/lib/own.txt && echo LIB-WRITABLE`, f.env);
      expect(r.stdout).toContain("mv=1");
      expect(r.stdout).toContain("busy");
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).toContain("LIB-WRITABLE");
      expect(existsSync(join(b, "lib-old"))).toBe(false);
      expect(existsSync(join(b, "lib", ".claude", "settings.json"))).toBe(false);
    } finally {
      await h.close();
    }
  });

});
