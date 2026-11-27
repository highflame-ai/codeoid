/**
 * Real bubblewrap, skipped where it can't run (#448 round 13): through a
 * project root, every git config git may read with a credential (a bare
 * mirror's, a submodule's, a worktree's), an included file, a store in the
 * git dir, private keys by their usual names, an `hgrc`, a `.yarnrc.yml` and
 * an `auth.json` holding one are unreadable; a source file named like a key
 * isn't hidden. What runs inside only reads files this test planted.
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

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: credentials git may read in a project root (#448 round 13)", () => {
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

  test("every git config git may read with a credential, an included file, a store in the git dir, key names, hgrc, Yarn's, Composer's: unreadable through a root", async () => {
    const f = fixture("configs");
    const mirror = join(f.root, "mirror.git");
    git(["init", "-q", "--bare", mirror], f.root, f.home);
    git(["remote", "add", "origin", "https://x:LEAK-BARE@example.invalid/m.git"], mirror, f.home);
    mkdirSync(join(f.b, ".git", "modules", "sub"), { recursive: true });
    writeFileSync(join(f.b, ".git", "modules", "sub", "config"), '[remote "origin"]\n\turl = https://x:LEAK-SUB@example.invalid/s.git\n');
    mkdirSync(join(f.b, ".git", "worktrees", "w"), { recursive: true });
    writeFileSync(join(f.b, ".git", "worktrees", "w", "config.worktree"), "[http] extraheader = AUTHORIZATION: bearer LEAK-WT\n");
    writeFileSync(join(f.b, "tokens.cfg"), "[http]\n\textraheader = AUTHORIZATION: bearer LEAK-INC\n");
    git(["config", "include.path", "../tokens.cfg"], f.b, f.home);
    writeFileSync(join(f.b, ".git", "credentials"), "https://x:LEAK-STORE@example.invalid\n");
    for (const k of ["github_ed25519", "server.ppk", "AuthKey_X.p8", "id_work"]) writeFileSync(join(f.b, k), `LEAK-KEY-${k}\n`);
    writeFileSync(join(f.b, "id_generator.ts"), "export const fine = 1;\n");
    const c = join(f.root, "c");
    mkdirSync(join(c, ".hg"), { recursive: true });
    writeFileSync(join(c, ".hg", "hgrc"), "[auth]\nx.prefix = example.invalid\nx.password = LEAK-HG\n");
    writeFileSync(join(c, ".yarnrc.yml"), 'npmAuthToken: "LEAK-YARN"\n');
    writeFileSync(join(c, "auth.json"), '{"github-oauth":{"github.com":"LEAK-COMPOSER"}}\n');
    const roots = resolveProjectRoots(["@parent"], f.a, { home: f.home }).roots;
    const h = await provider.open(f.spec({ projectRoots: roots }));
    try {
      const files = [
        join(mirror, "config"),
        join(f.b, ".git", "modules", "sub", "config"),
        join(f.b, ".git", "worktrees", "w", "config.worktree"),
        join(f.b, "tokens.cfg"),
        join(f.b, ".git", "credentials"),
        ...["github_ed25519", "server.ppk", "AuthKey_X.p8", "id_work"].map((k) => join(f.b, k)),
        join(c, ".hg", "hgrc"),
        join(c, ".yarnrc.yml"),
        join(c, "auth.json"),
      ];
      const r = await sh(h, f.a, `${files.map((p) => `cat '${p}' 2>/dev/null`).join("; ")}; cat ${f.b}/id_generator.ts`, f.env);
      expect(r.stdout.match(/LEAK-[A-Z0-9_.-]+/g) ?? []).toEqual([]);
      expect(r.stdout).toContain("export const fine");
    } finally {
      await h.close();
    }
  });

});
