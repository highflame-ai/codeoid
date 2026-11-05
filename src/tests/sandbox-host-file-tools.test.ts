/**
 * Host-side file tools held to the sandbox's own policy (#448 round 8,
 * sandbox/host-file-tools.ts): the rules a spec gives, and each tool's call
 * judged by them, through links, `..` and globs. Paths are planted in a
 * fake home in the test's own temp dir; nothing is written outside it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import { hiddenBelow, hostFileBreachReason, hostFileToolBreach, hostToolBounds, hostToolBoundsFor, sandboxReads, sandboxWrites } from "../daemon/sandbox/host-file-tools.js";
import type { SandboxSpec } from "../daemon/sandbox/types.js";

let root: string;
let home: string;
let ws: string;
let temp: string;
let configDir: string;
let elsewhere: string;
let spec: SandboxSpec;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-host-tools-")));
  home = join(root, "home");
  ws = join(home, "proj");
  temp = join(root, "session-tmp");
  configDir = join(home, ".codeoid");
  elsewhere = join(root, "elsewhere");
  for (const d of [join(ws, "src"), join(ws, "node_modules", "dep"), temp, join(home, ".ssh"), join(configDir, "packs", "p", "skills"), elsewhere, join(root, "store")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n");
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PLANTED\n");
  writeFileSync(join(ws, "a.ts"), "");
  symlinkSync(elsewhere, join(ws, "out-link"));
  symlinkSync(join(home, ".ssh"), join(ws, "keys"));
  // A pnpm-style store link: the same file in the store and in node_modules.
  writeFileSync(join(root, "store", "index.js"), "module.exports = 1;\n");
  linkSync(join(root, "store", "index.js"), join(ws, "node_modules", "dep", "index.js"));
  spec = buildSandboxSpec({
    sessionId: "host-tools",
    workspace: ws,
    tempDir: temp,
    network: { mode: "off" },
    hidden: { home, configDir, env: { HOME: home }, daemonTmp: "/tmp" },
    cache: false,
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the rules a spec gives", () => {
  test("writable: the workspace and the temp dir, never what the sandbox holds read-only there, the home or anything else", () => {
    const b = hostToolBounds(spec);
    expect(sandboxWrites(b, join(ws, "a.ts"))).toBe(true);
    expect(sandboxWrites(b, join(ws, "src", "new", "b.ts"))).toBe(true);
    expect(sandboxWrites(b, join(temp, "x"))).toBe(true);
    expect(sandboxWrites(b, join(ws, ".claude", "settings.json"))).toBe(false);
    expect(sandboxWrites(b, join(ws, ".mcp.json"))).toBe(false);
    expect(sandboxWrites(b, join(home, ".bashrc"))).toBe(false);
    expect(sandboxWrites(b, join(home, ".gitconfig"))).toBe(false);
    expect(sandboxWrites(b, join(elsewhere, "x"))).toBe(false);
  });

  test("readable: all but what is hidden; the home only where the allowlist or the workspace shows it", () => {
    const b = hostToolBounds(spec);
    expect(sandboxReads(b, join(ws, "a.ts"))).toBe(true);
    expect(sandboxReads(b, join(home, ".gitconfig"))).toBe(true);
    expect(sandboxReads(b, join(elsewhere, "x"))).toBe(true);
    expect(sandboxReads(b, join(home, ".ssh", "id_ed25519"))).toBe(false);
    expect(sandboxReads(b, join(home, "notes.txt"))).toBe(false);
    expect(sandboxReads(b, join(configDir, "config.json"))).toBe(false);
    expect(sandboxReads(b, "/run/docker.sock")).toBe(false);
  });

  test("a search may not start above a hidden path", () => {
    const b = hostToolBounds(spec);
    expect(hiddenBelow(b, root)).not.toBeNull();
    expect(hiddenBelow(b, ws)).toBeNull();
  });

  test("what the backend reads outside is readable, never writable; one holding a hidden path is dropped", () => {
    const skills = join(configDir, "packs", "p", "skills");
    const b = hostToolBounds(spec, { readable: [skills, home] });
    expect(sandboxReads(b, join(skills, "a.md"))).toBe(true);
    expect(sandboxWrites(b, join(skills, "a.md"))).toBe(false);
    expect(sandboxReads(b, join(home, "notes.txt"))).toBe(false);
  });

  test("the same path under two rules: the narrower stands", () => {
    const b = hostToolBounds({ ...spec, hidden: [...spec.hidden, join(ws, "src")] });
    expect(sandboxReads(b, join(ws, "src", "a.ts"))).toBe(false);
    expect(sandboxWrites(b, join(ws, "src", "a.ts"))).toBe(false);
  });

  test("a sandbox with a /tmp of its own (bubblewrap) hides the host's from opencode's tools; Claude's own keeps it", () => {
    const rt = (provider: string) => ({ spec, plan: { kind: "command" }, provider: { id: provider }, claudeTemp: () => ({ cli: temp, root: temp, commands: temp }) }) as never;
    expect(sandboxReads(hostToolBoundsFor(rt("bwrap"), "opencode"), "/tmp/codeoid-host-tools-x/a")).toBe(false);
    expect(sandboxReads(hostToolBoundsFor(rt("seatbelt"), "opencode"), "/tmp/codeoid-host-tools-x/a")).toBe(true);
    const native = { spec, plan: { kind: "native" }, provider: { id: "bwrap" }, claudeTemp: () => ({ cli: join(root, "cli"), root: join(root, "ct"), commands: join(root, "ct", "c") }) } as never;
    const b = hostToolBoundsFor(native, "claude");
    expect(sandboxReads(b, "/tmp/codeoid-host-tools-x/a")).toBe(true);
    // Its commands' temp dir is the CLI's, not the spec's.
    expect(sandboxWrites(b, join(root, "ct", "c", "x"))).toBe(true);
    expect(sandboxWrites(b, join(temp, "x"))).toBe(false);
  });
});

describe("each host-side file tool, judged by the rules", () => {
  const judge = (name: string, input: Record<string, unknown>, cwd?: string | null) =>
    hostFileToolBreach(name, input, { bounds: hostToolBounds(spec), workdir: ws, ...(cwd !== undefined ? { cwd } : {}) });

  test("a write in the workspace or the temp dir is within; one anywhere else is out, however it is spelled", () => {
    expect(judge("Write", { file_path: join(ws, "src", "b.ts"), content: "" })).toBeNull();
    expect(judge("Edit", { file_path: join(temp, "x"), old_string: "a", new_string: "b" })).toBeNull();
    expect(judge("Write", { file_path: join(elsewhere, "x") })).toMatchObject({ access: "write", why: "not_writable" });
    expect(judge("Write", { file_path: join(home, ".bashrc") })).toMatchObject({ access: "write", why: "hidden" });
    // Through a link out of the workspace, `..` (as written and collapsed), `.` and `//`.
    expect(judge("Write", { file_path: join(ws, "out-link", "x") })).toMatchObject({ path: join(elsewhere, "x"), why: "not_writable" });
    expect(judge("Write", { file_path: `${ws}/src/../../.bashrc` })).toMatchObject({ why: "hidden" });
    expect(judge("Write", { file_path: `${ws}/./.claude//settings.json` })).toMatchObject({ why: "not_writable" });
    // `..` past a missing directory: where it lands can't be told.
    expect(judge("Write", { file_path: `${ws}/missing/../../.bashrc` })).toMatchObject({ why: "unresolved" });
    // Every file a patch names, and one naming none.
    expect(judge("Edit", { file_path: join(ws, "a.ts"), files: [join(ws, "a.ts"), join(elsewhere, "y")] })).toMatchObject({ path: join(elsewhere, "y") });
    expect(judge("Write", { content: "x" })).toMatchObject({ why: "unresolved" });
    expect(judge("NotebookEdit", { notebook_path: join(elsewhere, "n.ipynb") })).toMatchObject({ access: "write" });
  });

  test("a hard-linked file in node_modules is within: where its name leads is what's judged (the held-write check judges the link)", () => {
    expect(judge("Edit", { file_path: join(ws, "node_modules", "dep", "index.js"), old_string: "1", new_string: "2" })).toBeNull();
  });

  test("a read reaching what the sandbox hides is out, through a link too; the allowlist and the workspace are in", () => {
    expect(judge("Read", { file_path: join(home, ".ssh", "id_ed25519") })).toMatchObject({ access: "read", why: "hidden" });
    expect(judge("Read", { file_path: join(ws, "keys", "id_ed25519") })).toMatchObject({ path: join(home, ".ssh", "id_ed25519"), why: "hidden" });
    expect(judge("Read", { file_path: join(home, ".gitconfig") })).toBeNull();
    expect(judge("Read", { file_path: join(ws, "a.ts") })).toBeNull();
    expect(judge("Read", { file_path: "/proc/self/root/etc/hostname" })).toMatchObject({ why: "unresolved" });
    // opencode's card: the path as asked judged too.
    expect(judge("Read", { file_path: join(ws, "a.ts"), requested_path: join(home, "notes.txt") })).toMatchObject({ why: "hidden" });
  });

  test("a search is out where it starts in something hidden or above it; its root is where the backend says it runs", () => {
    expect(judge("Grep", { pattern: "x", path: home })).toMatchObject({ access: "search", why: "hidden" });
    expect(judge("Grep", { pattern: "x", path: root })).toMatchObject({ access: "search", why: "reaches_hidden" });
    expect(judge("Grep", { pattern: "x" }, ws)).toBeNull();
    expect(judge("Grep", { pattern: "x" }, home)).toMatchObject({ why: "hidden" });
    expect(judge("Grep", { pattern: "x", path: "src" }, null)).toMatchObject({ why: "unresolved" });
    expect(judge("LS", { path: join(home, ".ssh") })).toMatchObject({ why: "hidden" });
  });

  test("a glob's pattern is a root too when it is absolute or climbs out; a `..` after a wildcard can't be told", () => {
    expect(judge("Glob", { pattern: "src/**/*.ts" }, ws)).toBeNull();
    expect(judge("Glob", { pattern: `${home}/.ssh/*` }, ws)).toMatchObject({ why: "hidden" });
    expect(judge("Glob", { pattern: "../../**/id_*" }, ws)).toMatchObject({ why: "reaches_hidden" });
    expect(judge("Glob", { pattern: "**/../../x" }, ws)).toMatchObject({ why: "unresolved" });
  });

  test("opencode's directory and unresolved-path cards: judged by the tool they are for; a shell's runs inside", () => {
    expect(judge("opencode_external_directory", { directories: [join(home, ".ssh")], tool: "read" })).toMatchObject({ why: "hidden" });
    expect(judge("opencode_external_directory", { directories: [elsewhere], tool: "edit" })).toMatchObject({ access: "write", why: "not_writable" });
    expect(judge("opencode_external_directory", { directories: [elsewhere], tool: "glob" })).toBeNull();
    expect(judge("opencode_external_directory", { directories: [home], tool: "bash" })).toBeNull();
    expect(judge("opencode_unresolved_path", { tool: "read", path: join(ws, "a.ts"), paths: [join(ws, "a.ts"), join(home, ".ssh", "id_ed25519")] })).toMatchObject({ why: "hidden" });
  });

  test("anything else isn't a host-side file tool", () => {
    for (const name of ["Bash", "WebFetch", "write", "edit", "codex_file_change"]) expect(judge(name, { file_path: join(home, ".bashrc"), path: join(home, ".bashrc") })).toBeNull();
  });

  test("the reason the agent reads names the path and says what to do", () => {
    const b = judge("Write", { file_path: join(home, ".bashrc") });
    expect(hostFileBreachReason(b!)).toStartWith(`Refused: outside what this session's sandbox allows: ${join(home, ".bashrc")} (`);
    expect(hostFileBreachReason(b!)).toContain("keep to the working directory");
  });
});
