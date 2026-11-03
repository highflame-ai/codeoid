/**
 * Round 1 of the #448 audit, the pure parts: the home hidden whole and
 * shown back by an allowlist (policy.ts), a git repository's paths, the
 * Claude CLI's settings for it (physical paths, its temp dirs), a backend's
 * private home (backend-home.ts), where a backend's program lives, and the
 * config's validation. Real sandboxes run in sandbox-bwrap-real.test.ts and
 * sandbox-claude-real.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { COPY_LIMIT, PI_HOME_LAYOUT, preparePrivateHome } from "../daemon/sandbox/backend-home.js";
import { bwrapArgs, type PathKind } from "../daemon/sandbox/bwrap.js";
import { claudeSandboxSettings, claudeTempEnv, physicalOf } from "../daemon/sandbox/claude-native.js";
import { buildSandboxSpec, DEFAULT_HOME_READABLE, gitWorkspacePaths, homeCredentialFilesIn, programLocations, sandboxConfigOf } from "../daemon/sandbox/policy.js";
import type { SandboxSpec } from "../daemon/sandbox/types.js";

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-sbx-home-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

describe("the home, hidden whole", () => {
  const cfg = (sandbox: Partial<ReturnType<typeof sandboxConfigOf>> = {}) => ({ sandbox: { ...sandboxConfigOf(undefined), ...sandbox } }) as unknown as CodeoidConfig;

  test("hidden whole; the default allowlist shown back; a credential store in it needs no rule; the workspace in it is writable", () => {
    const home = join(root, "h1");
    const ws = join(home, "proj");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(ws, { recursive: true });
    const s = buildSandboxSpec({ sessionId: "s", workspace: ws, tempDir: join(root, "t1"), network: { mode: "on" }, config: cfg(), hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    expect(s.hidden).toContain(home);
    expect(s.hidden).not.toContain(join(home, ".ssh"));
    for (const rel of DEFAULT_HOME_READABLE) expect(s.reexposed).toContain(join(home, rel.slice(2)));
    expect(s.workspace).toBe(ws);
    // Nothing that holds a credential is on the default list.
    for (const secret of [".npmrc", ".config/git", ".cargo", ".pypirc", ".bunfig.toml", ".git-credentials"]) expect(DEFAULT_HOME_READABLE).not.toContain(`~/${secret}`);
  });

  test("a hidden path inside the workspace, or inside an allowlisted dir, is still hidden there", () => {
    const home = join(root, "h2");
    const ws = join(home, "proj");
    mkdirSync(join(ws, ".codeoid"), { recursive: true });
    mkdirSync(join(home, ".nvm", "versions", "node", "v22", "etc"), { recursive: true });
    writeFileSync(join(home, ".nvm", "versions", "node", "v22", "etc", "npmrc"), "//registry/:_authToken=x\n");
    const s = buildSandboxSpec({
      sessionId: "s",
      workspace: ws,
      tempDir: join(root, "t2"),
      network: { mode: "on" },
      config: cfg({ hiddenPaths: [join(ws, "secrets")] }),
      hidden: { home, configDir: join(ws, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
    });
    expect(s.hidden).toContain(join(ws, ".codeoid"));
    expect(s.hidden).toContain(join(ws, "secrets"));
    expect(s.hidden).toContain(join(home, ".nvm", "versions", "node", "v22", "etc", "npmrc"));
    expect(homeCredentialFilesIn([join(home, ".nvm"), join(home, ".bun")])).toEqual([join(home, ".nvm", "versions", "node", "v22", "etc", "npmrc")]);
  });

  test("an explicit hide beats the allowlist; a workspace that is the home itself is the home (the hidden list applies in it)", () => {
    const home = join(root, "h3");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const s = buildSandboxSpec({ sessionId: "s", workspace: join(home, "p"), tempDir: join(root, "t3"), network: { mode: "on" }, config: cfg({ hiddenPaths: ["~/.bun"] }), hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    expect(s.reexposed).not.toContain(join(home, ".bun"));
    const atHome = buildSandboxSpec({ sessionId: "s", workspace: home, tempDir: join(root, "t3"), network: { mode: "on" }, config: cfg(), hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    expect(atHome.hidden).not.toContain(home);
    expect(atHome.hidden).toContain(join(home, ".ssh"));
  });

  test("bwrap lays it as a tmpfs over the home, read-only after the allowlist, the workspace and a link's target at its own path are bound in it", () => {
    const s: SandboxSpec = {
      sessionId: "s",
      workspace: "/home/u/proj",
      tempDir: "/var/tmp/t",
      writable: [],
      hidden: ["/home/u"],
      reexposed: ["/home/u/.bun"],
      containerSockets: [],
      network: { mode: "on" },
      unsetEnv: [],
    };
    const kinds: Record<string, PathKind> = { "/home/u": "dir", "/home/u/proj": "dir", "/home/u/.bun": "dir", "/var/tmp/t": "dir" };
    const args = bwrapArgs(s, "", (p) => kinds[p] ?? null).join(" ");
    expect(args).toContain("--tmpfs /home/u");
    expect(args.indexOf("--tmpfs /home/u")).toBeLessThan(args.indexOf("--ro-bind /home/u/.bun /home/u/.bun"));
    expect(args.indexOf("--tmpfs /home/u")).toBeLessThan(args.indexOf("--bind /home/u/proj /home/u/proj"));
    expect(args).toContain("--remount-ro /home/u");
    // The home that is the workspace too: the workspace bind stands, not remounted read-only.
    const same = bwrapArgs({ ...s, workspace: "/home/u" }, "", (p) => kinds[p] ?? null).join(" ");
    expect(same).not.toContain("--remount-ro /home/u");
  });
});

describe("the workspace's git repository", () => {
  test("a linked worktree: its git dirs writable at their own paths, everything that picks config, hooks or git dir read-only (made when missing)", () => {
    const home = join(root, "gh");
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "a"), "a");
    git(["add", "."], repo);
    git(["commit", "-qm", "i"], repo);
    rmSync(join(repo, ".git", "hooks"), { recursive: true, force: true });
    rmSync(join(repo, ".git", "info"), { recursive: true, force: true });
    const wt = join(root, "gh-wt");
    git(["worktree", "add", "-q", "-b", "f", wt], repo);
    // Another worktree, checked out inside this one's workspace: its .git file is held too.
    const nested = join(wt, "nested");
    git(["worktree", "add", "-q", "-b", "g", nested], repo);
    const common = join(repo, ".git");
    const own = join(common, "worktrees", "gh-wt");
    const g = gitWorkspacePaths(wt, home);
    expect(g.writable).toEqual([common, join(common, "worktrees"), own]);
    expect(g.gitDirs).toEqual([common, own]);
    for (const p of ["hooks", "info", "config", "config.worktree", "commondir", "modules"]) expect(g.readOnly).toContain(join(common, p));
    for (const p of ["commondir", "gitdir", "config.worktree"]) expect(g.readOnly).toContain(join(own, p));
    expect(g.readOnly).toContain(join(common, "worktrees", "nested"));
    expect(g.readOnly).toContain(join(wt, ".git"));
    expect(g.readOnly).toContain(join(nested, ".git"));
    expect(g.readOnly).not.toContain(own);
    for (const d of ["hooks", "info", "modules"]) expect(statSync(join(common, d)).isDirectory()).toBe(true);
    // Placeholders: an empty config.worktree in every git dir, and a commondir naming the repository's git dir itself.
    expect(readFileSync(join(common, "config.worktree"), "utf8")).toBe("");
    expect(readFileSync(join(common, "worktrees", "nested", "config.worktree"), "utf8")).toBe("");
    expect(readFileSync(join(common, "commondir"), "utf8")).toBe(".\n");
    // git still reads it as itself.
    expect(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo).trim()).toBe(realpathSync(common));
    // A plain repository: its .git bound writable at its own path (no rename), the same held read-only.
    const plain = gitWorkspacePaths(repo, home);
    expect(plain.writable).toEqual([common, join(common, "worktrees")]);
    expect(plain.gitDirs).toEqual([common]);
    for (const p of ["hooks", "config", "commondir"]) expect(plain.readOnly).toContain(join(common, p));
    expect(plain.readOnly).toContain(join(common, "worktrees", "gh-wt"));
    // A subdir of it: as git finds it, upward.
    mkdirSync(join(repo, "sub"));
    expect(gitWorkspacePaths(join(repo, "sub"), home).readOnly).toContain(join(common, "config"));
  });

  test("an entry that must be held read-only but is a link (a bind can't hold it): the git dir read-only whole", () => {
    const home = join(root, "gl");
    const repo = join(home, "repo");
    mkdirSync(join(repo, "githooks"), { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    rmSync(join(repo, ".git", "hooks"), { recursive: true, force: true });
    symlinkSync(join(repo, "githooks"), join(repo, ".git", "hooks"));
    const g = gitWorkspacePaths(repo, home);
    expect(g.writable).toEqual([]);
    expect(g.gitDirs).toEqual([]);
    expect(g.readOnly).toEqual([join(repo, ".git")]);
  });

  test("the project settings agent CLIs run code from: read-only, their dirs made empty first (git doesn't see them), a top-level file only where it exists, never a link (#448 round 2)", () => {
    const home = join(root, "pc");
    const ws = join(home, "proj");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "opencode.json"), "{}");
    symlinkSync(join(root, "pc-elsewhere"), join(ws, ".pi"));
    const spec = buildSandboxSpec({ sessionId: "s", workspace: ws, tempDir: join(root, "pc-t"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    for (const d of [".claude", ".gemini", ".qwen", ".codex", ".opencode"]) {
      expect(spec.readOnly).toContain(join(ws, d));
      expect(statSync(join(ws, d)).isDirectory()).toBe(true);
    }
    expect(spec.readOnly).toContain(join(ws, "opencode.json"));
    expect(spec.readOnly).not.toContain(join(ws, ".mcp.json"));
    expect(existsSync(join(ws, ".mcp.json"))).toBe(false);
    expect(spec.readOnly).not.toContain(join(ws, ".pi"));
    expect(existsSync(join(root, "pc-elsewhere"))).toBe(false);
  });

  test("placeholders are never made through a link", () => {
    const home = join(root, "gp");
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    const elsewhere = join(root, "gp-elsewhere");
    symlinkSync(elsewhere, join(repo, ".git", "commondir"));
    gitWorkspacePaths(repo, home);
    expect(existsSync(elsewhere)).toBe(false);
  });

  test("a .git file naming anything but git's own worktree layout, back-linked to it, gets nothing", () => {
    const home = join(root, "gf");
    const ws = join(home, "proj");
    const target = join(home, ".ssh");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(target, "worktrees", "x"), { recursive: true });
    for (const named of [target, join(target, "worktrees", "x"), "../.ssh"]) {
      writeFileSync(join(ws, ".git"), `gitdir: ${named}\n`);
      expect(gitWorkspacePaths(ws, home)).toEqual({ writable: [], readOnly: [], gitDirs: [] });
    }
    // Even a real repository's worktree dir, when its back-link names another worktree.
    const repo = join(home, "repo");
    mkdirSync(repo);
    git(["init", "-q"], repo);
    mkdirSync(join(repo, ".git", "worktrees", "other"), { recursive: true });
    writeFileSync(join(repo, ".git", "worktrees", "other", "gitdir"), `${join(root, "elsewhere", ".git")}\n`);
    writeFileSync(join(ws, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "other")}\n`);
    expect(gitWorkspacePaths(ws, home)).toEqual({ writable: [], readOnly: [], gitDirs: [] });
    // A link where `.git` should be is no repository either.
    rmSync(join(ws, ".git"));
    symlinkSync(join(repo, ".git"), join(ws, ".git"));
    expect(gitWorkspacePaths(ws, home)).toEqual({ writable: [], readOnly: [], gitDirs: [] });
  });

  test("never the home's own repository (dotfiles) or the root's", () => {
    const home = join(root, "gd");
    mkdirSync(join(home, "proj"), { recursive: true });
    git(["init", "-q"], home);
    expect(gitWorkspacePaths(join(home, "proj"), home)).toEqual({ writable: [], readOnly: [], gitDirs: [] });
  });
});

describe("Claude's own sandbox, with the home model", () => {
  test("every path physical: a socket behind a linked dir (/var/run → /run) is named where it is; what doesn't exist yet keeps its name under its real parent", () => {
    const real = join(root, "run");
    mkdirSync(real);
    writeFileSync(join(real, "docker.sock"), "");
    symlinkSync(real, join(root, "var-run"));
    expect(physicalOf(join(root, "var-run", "docker.sock"))).toBe(join(real, "docker.sock"));
    expect(physicalOf(join(root, "var-run", "podman", "x"))).toBe(join(real, "podman", "x"));
    const spec: SandboxSpec = {
      sessionId: "s",
      workspace: join(root, "ws"),
      tempDir: join(root, "t"),
      writable: [],
      hidden: [join(root, "h")],
      reexposed: [join(root, "h", ".bun")],
      readOnly: [join(root, "ws", ".git", "hooks")],
      pinned: [join(root, "ws", "sub")],
      containerSockets: [join(root, "var-run", "docker.sock")],
      network: { mode: "off" },
      unsetEnv: [],
    };
    const temp = { cli: join(root, "c", "cli"), root: join(root, "c", "cmd"), commands: join(root, "c", "cmd", "claude-1") };
    const s = claudeSandboxSettings({ spec, config: sandboxConfigOf(undefined) }, { HOME: join(root, "h") }, temp);
    expect(s.filesystem?.denyRead).toContain(join(real, "docker.sock"));
    expect(s.filesystem?.denyRead).not.toContain(join(root, "var-run", "docker.sock"));
    expect(s.filesystem?.denyRead).toContain(join(root, "h"));
    expect(s.filesystem?.allowRead).toEqual(expect.arrayContaining([join(root, "ws"), join(root, "h", ".bun"), temp.commands]));
    expect(s.filesystem?.allowWrite).toEqual([join(root, "ws"), temp.commands]);
    expect(s.filesystem?.denyWrite).toEqual(expect.arrayContaining([join(root, "ws", ".git", "hooks"), join(root, "ws", "sub"), join(root, "ws", ".claude")]));
    // The CLI's TMPDIR is the parent of its commands' (it adds claude-<uid>), its own files elsewhere.
    expect(claudeTempEnv(temp)).toEqual({ TMPDIR: temp.root, CLAUDE_CODE_TMPDIR: temp.cli });
  });
});

describe("a backend's private home", () => {
  test("its login and code linked (shown read-only), its conversations the real ones (writable, made when missing), small files copied, dirs empty, large files left out", () => {
    const real = join(root, "pi-real");
    const overlay = join(root, "pi-overlay");
    mkdirSync(join(real, "extensions", "e"), { recursive: true });
    mkdirSync(join(real, "cache"), { recursive: true });
    writeFileSync(join(real, "auth.json"), "LOGIN");
    writeFileSync(join(real, "settings.json"), '{"a":1}');
    writeFileSync(join(real, "cache", "x"), "c");
    writeFileSync(join(real, "big.db"), Buffer.alloc(COPY_LIMIT + 1));
    // An overlay (an account's, an effort's) whose entries lead to the real one.
    mkdirSync(overlay);
    for (const n of ["auth.json", "settings.json", "extensions", "cache", "big.db"]) symlinkSync(join(real, n), join(overlay, n));
    const target = join(root, "pi-private");
    mkdirSync(target);
    const own = preparePrivateHome(overlay, target, PI_HOME_LAYOUT);
    expect(own.home).toBe(target);
    expect(readlinkSync(join(target, "auth.json"))).toBe(join(real, "auth.json"));
    expect(own.readable).toEqual(expect.arrayContaining([join(real, "auth.json"), join(real, "extensions")]));
    expect(lstatSync(join(target, "settings.json")).isFile()).toBe(true);
    expect(readFileSync(join(target, "settings.json"), "utf8")).toBe('{"a":1}');
    expect(statSync(join(target, "settings.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(target, "cache")).isDirectory()).toBe(true);
    expect(existsSync(join(target, "cache", "x"))).toBe(false);
    expect(existsSync(join(target, "big.db"))).toBe(false);
    // Conversations: made in the real home (through the overlay), linked, writable.
    expect(statSync(join(overlay, "sessions")).isDirectory()).toBe(true);
    expect(own.writable).toEqual([target, realpathSync(join(overlay, "sessions"))]);
    // The real home itself is never among what it may write.
    expect(own.writable).not.toContain(real);
  });
});

describe("where a backend's program lives", () => {
  test("a bare name found on PATH, the package it belongs to, and the interpreter its #! names; never the home or what holds it", () => {
    const home = join(root, "ph");
    const bin = join(home, ".npm-global", "bin");
    const pkg = join(home, ".npm-global", "lib", "node_modules", "pi-cli");
    const nodeBin = join(root, "node", "v22", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(nodeBin, { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{}");
    writeFileSync(join(pkg, "dist", "cli.js"), "#!/usr/bin/env fakenode\nconsole.log(1)\n", { mode: 0o755 });
    writeFileSync(join(nodeBin, "fakenode"), "", { mode: 0o755 });
    symlinkSync(join(pkg, "dist", "cli.js"), join(bin, "pi-cli"));
    // A stray package.json in the home must not show the home.
    writeFileSync(join(home, "package.json"), "{}");
    const locs = programLocations("pi-cli", [], `${bin}:${nodeBin}`, home);
    expect(locs).toEqual(expect.arrayContaining([bin, join(pkg, "dist"), pkg, nodeBin, join(root, "node", "v22")]));
    expect(locs).not.toContain(home);
    expect(locs.some((l) => home.startsWith(`${l}/`))).toBe(false);
    // A script with no package of its own below the home's stray package.json: its dir, never the home.
    mkdirSync(join(home, "tools"));
    writeFileSync(join(home, "tools", "agent"), "#!/bin/sh\n", { mode: 0o755 });
    const own = programLocations(join(home, "tools", "agent"), [], "", home);
    expect(own).toContain(join(home, "tools"));
    expect(own.some((l) => l === home || home.startsWith(`${l}/`))).toBe(false);
  });
});

describe("config", () => {
  test("the allowlist's hosts are validated, as a session's are", () => {
    for (const bad of ["*", "a b", "http://x.com"]) {
      expect(() => loadConfig({ raw: { sandbox: { network: "allowlist", allowedHosts: [bad] } }, env: {}, quiet: true })).toThrow();
      expect(() => loadConfig({ raw: {}, env: { CODEOID_SANDBOX_ALLOWED_HOSTS: bad }, quiet: true })).toThrow();
    }
    expect(loadConfig({ raw: { sandbox: { allowedHosts: ["*.npmjs.org", "github.com"] } }, env: {}, quiet: true }).sandbox?.allowedHosts).toEqual(["*.npmjs.org", "github.com"]);
  });

  test("homeReadable: the default list, the config's own, or the environment's", () => {
    expect(loadConfig({ raw: {}, env: {}, quiet: true }).sandbox?.homeReadable).toEqual([...DEFAULT_HOME_READABLE]);
    expect(loadConfig({ raw: { sandbox: { homeReadable: ["~/.bun"] } }, env: {}, quiet: true }).sandbox?.homeReadable).toEqual(["~/.bun"]);
    expect(loadConfig({ raw: {}, env: { CODEOID_SANDBOX_HOME_READABLE: "~/.cargo/bin,~/.gitconfig" }, quiet: true }).sandbox?.homeReadable).toEqual(["~/.cargo/bin", "~/.gitconfig"]);
  });
});