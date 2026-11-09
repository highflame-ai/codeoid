/**
 * Real bubblewrap, skipped where it can't run: working across repositories
 * (docs/sandbox.md, "Working across repositories"). A session in
 * `<root>/a` reads `<root>/b` (cat, grep, git log, git status) and can't write
 * it; once `<root>/b` is added it writes and commits there, with b's git
 * structure and project settings held read-only and its own worktree folder in
 * `<root>/b-worktrees/<folder>/`. What the sandbox hides stays hidden inside a
 * root, and so do the secret files at a project's top.
 *
 * Everything destructive runs INSIDE the sandbox under test, against
 * repositories this test planted in its own temp dir, under a home of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import { addedDirProblem, resolveProjectRoots } from "../daemon/sandbox/project-roots.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();

/** Not under the host's /tmp, which the sandbox replaces with its own, nor any temp dir (no project root is in one). */
function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const p = mkdtempSync(join(dir, "codeoid-roots-probe-"));
      rmSync(p, { recursive: true, force: true });
      return dir;
    } catch {
      /* next */
    }
  }
  return tmpdir();
}

function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
}

function git(args: string[], cwd: string, home: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(home) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const FOLDER = "agent-5555eeee";

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: project roots and added directories", () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-roots-")));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string>) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  /** A home with `Workspace/{a,b}` (each a repository with a commit), b's secrets, and the user's credentials. */
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
    // b's secret files at its top, and an example that isn't one.
    writeFileSync(join(b, ".env"), "B_SECRET=hunter2\n");
    writeFileSync(join(b, ".env.local"), "B_LOCAL=hunter3\n");
    writeFileSync(join(b, ".env.example"), "B_SECRET=\n");
    // a's own .env: the session's project, its to use.
    writeFileSync(join(a, ".env"), "A_SECRET=mine\n");
    // The user's credentials, beside the root.
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
    // codeoid's config dir inside the root (an odd layout): hidden still.
    const configDir = join(root, ".codeoid-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), '{"apiKey":"zid_sk_secret"}\n');
    // A dir the user hides explicitly, inside the root.
    const private_ = join(root, "private");
    mkdirSync(private_, { recursive: true });
    writeFileSync(join(private_, "notes.txt"), "private notes\n");
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const roots = resolveProjectRoots(["@parent"], a, { home }).roots;
    const spec = (added: string[] = [], scanLimit?: number) =>
      buildSandboxSpec({
        ...(scanLimit !== undefined ? { scanLimit } : {}),
        sessionId: name,
        workspace: a,
        tempDir: tmp,
        network: { mode: "off" },
        config: { sandbox: { hiddenPaths: [private_] } } as never,
        hidden: { home, configDir, env: { HOME: home }, daemonTmp: "/tmp" },
        worktreeFolder: FOLDER,
        projectRoots: roots,
        addedDirs: added.map((d) => ({ dir: d })),
      });
    return { dir, home, root, a, b, configDir, private: private_, roots, spec, env: gitEnv(home) };
  }

  test("the default root is the repository's parent: a session in a reads b (cat, grep, git log, git status) and can't write it", async () => {
    const f = fixture("read");
    expect(f.roots).toEqual([f.root]);
    const h = await provider.open(f.spec());
    try {
      const r = await sh(
        h,
        f.a,
        [
          `cat '${join(f.b, "README.md")}'`,
          `grep -rl bravo '${f.b}' --exclude-dir=.git`,
          `git -C '${f.b}' log --oneline`,
          `git -C '${f.b}' status --short && echo STATUS-OK`,
          `echo x > '${join(f.b, "new.txt")}' 2>&1 || echo WRITE-REFUSED`,
          `echo x >> '${join(f.b, "README.md")}' 2>&1 || echo APPEND-REFUSED`,
          `git -C '${f.b}' commit --allow-empty -qm nope 2>&1 || echo COMMIT-REFUSED`,
          // Its own workspace is writable, under the read-only root.
          `echo a > '${join(f.a, "own.txt")}' && echo OWN-WRITTEN`,
        ].join("; "),
        f.env,
      );
      expect(r.stdout).toContain("bravo readme");
      expect(r.stdout).toContain(join(f.b, "README.md"));
      expect(r.stdout).toContain("init");
      expect(r.stdout).toContain("STATUS-OK");
      expect(r.stdout).toContain("WRITE-REFUSED");
      expect(r.stdout).toContain("APPEND-REFUSED");
      expect(r.stdout).toContain("COMMIT-REFUSED");
      expect(r.stdout).toContain("Read-only file system");
      expect(r.stdout).toContain("OWN-WRITTEN");
    } finally {
      await h.close();
    }
    expect(existsSync(join(f.b, "new.txt"))).toBe(false);
    expect(readFileSync(join(f.b, "README.md"), "utf8")).toBe("bravo readme\n");
    expect(git(["log", "--oneline"], f.b, f.home).trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(f.a, "own.txt"))).toBe(true);
  });

  test("what the sandbox hides stays hidden inside a root: b's .env files, codeoid's config dir, a hidden path; the home's credentials; its own .env readable", async () => {
    const f = fixture("hidden");
    const h = await provider.open(f.spec());
    try {
      const r = await sh(
        h,
        f.a,
        [
          `cat '${join(f.b, ".env")}' 2>/dev/null | grep -q hunter2 && echo LEAK-ENV || echo ENV-HIDDEN`,
          `cat '${join(f.b, ".env.local")}' 2>/dev/null | grep -q hunter3 && echo LEAK-LOCAL || echo LOCAL-HIDDEN`,
          `cat '${join(f.b, ".env.example")}' >/dev/null && echo EXAMPLE-READ`,
          `grep -rq zid_sk_secret '${f.root}' 2>/dev/null && echo LEAK-CONFIG || echo CONFIG-HIDDEN`,
          `cat '${join(f.private, "notes.txt")}' 2>/dev/null | grep -q private && echo LEAK-PRIVATE || echo PRIVATE-HIDDEN`,
          `cat '${join(f.home, ".ssh", "id_ed25519")}' 2>/dev/null | grep -q PRIVATE && echo LEAK-SSH || echo SSH-HIDDEN`,
          `grep -rq hunter '${f.root}' 2>/dev/null && echo LEAK-GREP || echo GREP-CLEAN`,
          `grep -q mine '${join(f.a, ".env")}' && echo OWN-ENV`,
        ].join("; "),
        f.env,
      );
      for (const w of ["ENV-HIDDEN", "LOCAL-HIDDEN", "EXAMPLE-READ", "CONFIG-HIDDEN", "PRIVATE-HIDDEN", "SSH-HIDDEN", "GREP-CLEAN", "OWN-ENV"]) expect(r.stdout).toContain(w);
      expect(r.stdout).not.toContain("LEAK");
    } finally {
      await h.close();
    }
  });

  test("added, b is written and committed in, its git structure and project settings held, its own worktree folder in b-worktrees/", async () => {
    const f = fixture("added");
    const spec = f.spec([f.b]);
    const own = join(f.root, "b-worktrees", FOLDER);
    expect(spec.addedDirs).toEqual([f.b]);
    expect(spec.worktreeFolders).toContain(own);
    const marker = join(f.dir, "RAN-OUTSIDE");
    const h = await provider.open(spec);
    try {
      const r = await sh(
        h,
        f.a,
        [
          `cd '${f.b}' && echo change >> README.md && git add README.md && git commit -qm from-a && echo COMMITTED`,
          `printf '#!/bin/sh\\necho ran >> ${marker}\\n' > .git/hooks/pre-commit 2>&1 && echo HOOK-WRITTEN || echo HOOK-REFUSED`,
          `git config core.fsmonitor 'touch ${marker}' 2>&1 && echo CONFIG-WRITTEN || echo CONFIG-REFUSED`,
          `echo '{}' > .claude/settings.json 2>&1 && echo SETTINGS-WRITTEN || echo SETTINGS-REFUSED`,
          `git worktree add -q '${join(own, "feat")}' -b feat && echo WT-ADDED`,
          `git worktree add -q '${join(f.root, "b-worktrees", "elsewhere")}' -b nope 2>&1 && echo WT-ELSEWHERE || echo WT-ELSEWHERE-REFUSED`,
          // The workspace stays writable beside it.
          `echo a > '${join(f.a, "still.txt")}' && echo A-WRITTEN`,
        ].join("; "),
        f.env,
      );
      for (const w of ["COMMITTED", "HOOK-REFUSED", "CONFIG-REFUSED", "SETTINGS-REFUSED", "WT-ADDED", "WT-ELSEWHERE-REFUSED", "A-WRITTEN"]) expect(r.stdout).toContain(w);
    } finally {
      await h.close();
    }
    expect(git(["log", "--oneline"], f.b, f.home)).toContain("from-a");
    expect(git(["worktree", "list"], f.b, f.home)).toContain(join(own, "feat"));
    // The user's next git in b runs nothing planted.
    git(["status", "--short"], f.b, f.home);
    expect(existsSync(marker)).toBe(false);
    // Its .env stays readable to it now that b is its own to write.
    const h2 = await provider.open(spec);
    try {
      expect((await sh(h2, f.b, "cat .env", f.env)).stdout).toContain("hunter2");
    } finally {
      await h2.close();
    }
  });
  test("an added dir swapped for a link after it was granted, or a link kept as one: never written through (#448 round 12)", async () => {
    const f = fixture("swap");
    const docs = join(f.home, "Documents");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "taxes.txt"), "private\n");
    const c = join(f.root, "c");
    mkdirSync(c);
    const before = await provider.open(f.spec([c]));
    try {
      expect((await sh(before, f.a, `echo x > '${join(c, "made.txt")}' && echo C-WRITTEN`, f.env)).stdout).toContain("C-WRITTEN");
    } finally {
      await before.close();
    }
    // Swapped (by whatever can write its parent) for a link to a dir of yours; and a link in the agent's own
    // worktree folder kept as an added dir (as an older daemon kept what was asked for).
    renameSync(c, join(f.root, "c-old"));
    symlinkSync(docs, c);
    const folder = join(f.root, "a-worktrees", FOLDER);
    mkdirSync(folder, { recursive: true });
    symlinkSync(docs, join(folder, "x"));
    const spec = f.spec([c, join(folder, "x")]);
    expect(spec.addedDirs).toBeUndefined();
    const h = await provider.open(spec);
    try {
      const r = await sh(
        h,
        f.a,
        [
          `echo p > '${join(c, "planted.txt")}' 2>/dev/null && echo LEAK-SWAP || echo SWAP-REFUSED`,
          `echo p > '${join(folder, "x", "planted2.txt")}' 2>/dev/null && echo LEAK-LINK || echo LINK-REFUSED`,
          `cat '${join(docs, "taxes.txt")}' 2>/dev/null && echo LEAK-READ || echo DOCS-HIDDEN`,
        ].join("; "),
        f.env,
      );
      for (const w of ["SWAP-REFUSED", "LINK-REFUSED", "DOCS-HIDDEN"]) expect(r.stdout).toContain(w);
      expect(r.stdout).not.toContain("LEAK");
    } finally {
      await h.close();
    }
    expect(existsSync(join(docs, "planted.txt"))).toBe(false);
    expect(existsSync(join(docs, "planted2.txt"))).toBe(false);
  });

  test("a project settings or git dir is never an added dir; given one anyway, the spec leaves it out (#448 round 12)", async () => {
    const f = fixture("control");
    for (const d of [".claude", ".codex", join(".claude", "hooks")]) mkdirSync(join(f.b, d), { recursive: true });
    for (const d of [".claude", ".codex", join(".claude", "hooks"), ".git", join(".git", "hooks")]) expect(addedDirProblem(join(f.b, d), { home: f.home, path: "/usr/bin" })).not.toBeNull();
    const h = await provider.open(f.spec([join(f.b, ".claude"), join(f.b, ".codex"), join(f.b, ".git")]));
    try {
      const r = await sh(
        h,
        f.a,
        [
          `echo '{}' > '${join(f.b, ".claude", "settings.json")}' 2>/dev/null && echo LEAK-CLAUDE || echo CLAUDE-REFUSED`,
          `echo x > '${join(f.b, ".codex", "config.toml")}' 2>/dev/null && echo LEAK-CODEX || echo CODEX-REFUSED`,
          `echo x > '${join(f.b, ".git", "hooks", "pre-commit")}' 2>/dev/null && echo LEAK-HOOK || echo HOOK-REFUSED`,
        ].join("; "),
        f.env,
      );
      for (const w of ["CLAUDE-REFUSED", "CODEX-REFUSED", "HOOK-REFUSED"]) expect(r.stdout).toContain(w);
      expect(r.stdout).not.toContain("LEAK");
    } finally {
      await h.close();
    }
    expect(existsSync(join(f.b, ".claude", "settings.json"))).toBe(false);
  });

  test("a folder of repositories added: their files written, each one's git structure and every settings dir in it held (#448 round 12)", async () => {
    const f = fixture("folder");
    const clients = join(f.root, "clients");
    const beta = join(clients, "beta");
    mkdirSync(beta, { recursive: true });
    git(["init", "-q", "-b", "main"], beta, f.home);
    mkdirSync(join(clients, "notes", ".codex"), { recursive: true });
    const marker = join(f.dir, "RAN-OUTSIDE");
    const h = await provider.open(f.spec([clients]));
    try {
      const r = await sh(
        h,
        f.a,
        [
          `echo x > '${join(beta, "file.txt")}' && echo FILE-WRITTEN`,
          `printf '#!/bin/sh\necho ran >> ${marker}\n' > '${join(beta, ".git", "hooks", "post-checkout")}' 2>/dev/null && echo LEAK-HOOK || echo HOOK-REFUSED`,
          `git -C '${beta}' config core.fsmonitor 'touch ${marker}' 2>/dev/null && echo LEAK-CONFIG || echo CONFIG-REFUSED`,
          `echo '{}' > '${join(beta, ".claude", "settings.json")}' 2>/dev/null && echo LEAK-SETTINGS || echo SETTINGS-REFUSED`,
          `echo x > '${join(clients, "notes", ".codex", "config.toml")}' 2>/dev/null && echo LEAK-CODEX || echo CODEX-REFUSED`,
        ].join("; "),
        f.env,
      );
      for (const w of ["FILE-WRITTEN", "HOOK-REFUSED", "CONFIG-REFUSED", "SETTINGS-REFUSED", "CODEX-REFUSED"]) expect(r.stdout).toContain(w);
      expect(r.stdout).not.toContain("LEAK");
    } finally {
      await h.close();
    }
    // The user's next git in beta runs nothing planted.
    git(["status", "--short"], beta, f.home);
    expect(existsSync(marker)).toBe(false);
  });

  test("credential files anywhere in a root are hidden, a sibling worktree's .env and a git config with a token too; their examples readable (#448 round 12)", async () => {
    const f = fixture("creds");
    const files: Record<string, string> = {
      [join(f.b, "id_rsa")]: "LEAK-KEY",
      [join(f.b, "deploy.pem")]: "LEAK-PEM",
      [join(f.b, "config", ".env")]: "LEAK-DEEP",
      [join(f.b, "terraform.tfstate")]: "LEAK-TFSTATE",
      [join(f.b, ".aws", "credentials")]: "LEAK-AWS",
      [join(f.b, ".claude", "settings.local.json")]: "LEAK-LOCAL-SETTINGS",
      [join(f.root, "b-worktrees", "fork-1234", ".env")]: "LEAK-WT",
      [join(f.b, "id_rsa.pub")]: "PUB-READ",
    };
    for (const [p, v] of Object.entries(files)) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `${v}\n`);
    }
    git(["remote", "add", "origin", "https://x:LEAK-TOKEN@example.invalid/b.git"], f.b, f.home);
    const h = await provider.open(f.spec());
    try {
      const r = await sh(h, f.a, `${Object.keys(files).map((p) => `cat '${p}' 2>/dev/null`).join("; ")}; cat '${join(f.b, ".git", "config")}' 2>/dev/null; git -C '${f.b}' log --oneline 2>&1`, f.env);
      expect(r.stdout).not.toContain("LEAK");
      expect(r.stdout).toContain("PUB-READ");
      // git there can't read its config (the session's limits say so): its own repository is the workspace, unaffected.
      expect(r.stdout).toContain("unable to access '.git/config'");
    } finally {
      await h.close();
    }
  });

  test("the look for credentials is bounded and fails closed: a root past it isn't shown at all (#448 round 12)", async () => {
    const f = fixture("budget");
    const h = await provider.open(f.spec([], 1));
    try {
      const r = await sh(h, f.a, `cat '${join(f.b, "README.md")}' 2>/dev/null && echo LEAK-ROOT || echo ROOT-NOT-SHOWN; echo a > '${join(f.a, "own.txt")}' && echo OWN-WRITTEN`, f.env);
      expect(r.stdout).toContain("ROOT-NOT-SHOWN");
      expect(r.stdout).toContain("OWN-WRITTEN");
    } finally {
      await h.close();
    }
  });

  test("a repository in the host's temp dir gets no default root: its siblings stay unreadable (#448 round 12)", async () => {
    const t = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-roots-tmp-")));
    try {
      const a = join(t, "a");
      const b = join(t, "b");
      for (const r of [a, b]) {
        mkdirSync(r);
        git(["init", "-q"], r, t);
      }
      writeFileSync(join(b, "README.md"), "LEAK-SIBLING\n");
      const home = join(base, "tmp-home");
      mkdirSync(home, { recursive: true });
      const roots = resolveProjectRoots(["@parent"], a, { home });
      expect(roots.roots).toEqual([]);
      expect(roots.notes[0]).toContain("temp dir");
      const tmp = join(base, "tmp-root-temp");
      mkdirSync(tmp, { recursive: true });
      const spec = buildSandboxSpec({ sessionId: "t", workspace: a, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, projectRoots: roots.roots });
      const h = await provider.open(spec);
      try {
        const r = await sh(h, a, `cat '${join(b, "README.md")}' 2>/dev/null || echo SIBLING-HIDDEN`, gitEnv(home));
        expect(r.stdout).toContain("SIBLING-HIDDEN");
        expect(r.stdout).not.toContain("LEAK");
      } finally {
        await h.close();
      }
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});
