/**
 * What the Claude CLI's own file tools keep outside a native sandbox as
 * context (#448 round 9, providers/claude/host-files.ts): each location as
 * the bundled CLI uses it, and the Read deny rules that leave hidden paths
 * out of its searches. Paths are planted in the test's own temp dir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHostFiles, claudeSearchExclusions, installedPluginDirs, memoryProjects } from "../daemon/providers/claude/host-files.js";
import { claudeProjectDirName } from "../daemon/providers/claude/native-history.js";

let root: string;
let cfg: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-claude-host-files-")));
  cfg = join(root, "home", ".claude");
  mkdirSync(cfg, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the CLI's own context files", () => {
  test("memory and plans are markdown dirs; task output, tasks and todos writable; the user tier's context and the bundled skills readable; never its settings, credentials or the rest of its temp dir", () => {
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    const f = claudeHostFiles({ configDir: cfg, cliTempDir: join(root, "cli"), workdir: work, uid: 1000 });
    expect(f.markdown).toEqual([join(cfg, "projects", claudeProjectDirName(work), "memory"), join(cfg, "agent-memory"), join(cfg, "plans")]);
    expect(f.writable).toEqual([join(cfg, "tasks"), join(cfg, "todos"), join(root, "cli", "claude-1000", claudeProjectDirName(work))]);
    for (const d of ["CLAUDE.md", "agents", "commands", "rules", "output-styles"]) expect(f.readable).toContain(join(cfg, d));
    expect(f.readable).toContain(join(root, "cli", "claude-1000", "bundled-skills"));
    const all = [...f.readable, ...f.writable, ...f.markdown];
    for (const never of [join(cfg, "settings.json"), join(cfg, ".credentials.json"), join(cfg, "hooks"), join(cfg, "plugins"), join(root, "cli"), join(root, "cli", "claude-1000")]) expect(all).not.toContain(never);
    // No CLAUDE_CODE_TMPDIR (not native): nothing of a temp dir.
    expect(claudeHostFiles({ configDir: cfg, workdir: work }).writable).toEqual([join(cfg, "tasks"), join(cfg, "todos")]);
  });

  test("the memory dir is named after the repository's top (its main checkout's for a linked worktree), as the CLI keys it, and the cwd", () => {
    const repo = join(root, "repo");
    const pkg = join(repo, "packages", "web");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(pkg, { recursive: true });
    expect(memoryProjects(pkg)).toEqual([pkg, repo]);
    // A linked worktree: `.git` names `<repo>/.git/worktrees/<name>`.
    const wt = join(root, "wt");
    mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    expect(memoryProjects(wt)).toEqual([wt, repo]);
    // A link to the workdir: both spellings.
    symlinkSync(pkg, join(root, "pkg-link"));
    expect(memoryProjects(join(root, "pkg-link"))).toEqual([join(root, "pkg-link"), pkg, repo]);
  });

  test("installed plugins' skills and commands, only for an installPath under the config's plugins dir (V1 and V2 records)", () => {
    const plugins = join(cfg, "plugins");
    mkdirSync(plugins, { recursive: true });
    const inCache = join(plugins, "cache", "mkt", "p", "1.0.0");
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "p@mkt": [{ scope: "user", installPath: inCache }], "q@local": [{ scope: "user", installPath: join(root, "home") }], "r@mkt": [{ installPath: "relative/x" }] } }),
    );
    expect(installedPluginDirs(cfg)).toEqual([join(inCache, "skills"), join(inCache, "commands")]);
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ plugins: { "p@mkt": { version: "1", installPath: inCache } } }));
    expect(installedPluginDirs(cfg)).toEqual([join(inCache, "skills"), join(inCache, "commands")]);
    writeFileSync(join(plugins, "installed_plugins.json"), "not json");
    expect(installedPluginDirs(cfg)).toEqual([]);
  });
});

describe("the Read deny rules that leave hidden paths out of the CLI's searches", () => {
  test("a hidden path inside what the commands see, as `Read(//p)` and `Read(//p/**)`; never one holding the workspace, one outside, or one a rule can't spell", () => {
    const home = join(root, "h");
    const ws = join(home, "proj");
    const spec = {
      workspace: ws,
      tempDir: join(root, "t"),
      writable: [],
      reexposed: [join(home, ".config", "git")],
      hidden: [home, join(ws, ".env"), join(ws, "secrets"), join(root, "elsewhere"), join(ws, "we*ird"), join(home, ".config", "git", "credentials")],
    };
    const { paths, rules } = claudeSearchExclusions(spec);
    expect(paths).toEqual([join(home, ".config", "git", "credentials"), join(ws, ".env"), join(ws, "secrets")]);
    expect(rules).toContain(`Read(/${join(ws, ".env")})`);
    expect(rules).toContain(`Read(/${join(ws, "secrets")}/**)`);
    expect(rules.every((r) => r.startsWith("Read(//"))).toBe(true);
  });
});
