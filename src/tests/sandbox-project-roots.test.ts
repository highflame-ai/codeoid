/**
 * Working across repositories (docs/sandbox.md, "Working across
 * repositories"), piece by piece: the project roots a session reads (the
 * repository's parent by default, never the home or `/`), the secret files at
 * a project's top hidden, an added directory treated as a workspace (its git
 * structure and settings held, its own worktree folder), Claude's own sandbox
 * shown a root around what it writes, Codex's writable roots, widening, the
 * `/mcp/sandbox` endpoint's scope, and a change of directories applied only
 * between turns with no background work running.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { codexSandboxPolicy } from "../daemon/providers/codex/index.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { isRequestDirectoryTool, isSafeTool } from "../daemon/providers/tool-safety.js";
import { claudeSandboxSettings, readAround } from "../daemon/sandbox/claude-native.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { buildSandboxSpec, protectedWriteTargets } from "../daemon/sandbox/policy.js";
import { addedDirProblem, defaultProjectRoot, projectRootSecrets, resolveProjectRoots, sandboxDirProblem } from "../daemon/sandbox/project-roots.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { SANDBOX_MCP_TOKEN_ENV, SandboxMcpHttp } from "../daemon/sandbox/request-directory.js";
import { effectiveSetting, onlyDirsChanged, type SandboxRuntime, sandboxDirsOf, SessionSandbox, widens } from "../daemon/sandbox/session-sandbox.js";
import { sandboxConfigOf } from "../daemon/sandbox/policy.js";
import type { SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { Session } from "../daemon/session.js";
import { loadShellParser } from "../daemon/shell/parse.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { type AuthContext, CAPABILITIES, type SessionUiRequestMsg } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-roots-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("project roots", () => {
  test("the default is the repository's parent; a linked worktree's is its main checkout's; outside a repository, the workspace's parent", () => {
    const home = join(base, "home");
    const repo = join(home, "Workspace", "app");
    mkdirSync(join(repo, "packages", "ui"), { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    expect(defaultProjectRoot(join(repo, "packages", "ui"), home)).toBe(join(home, "Workspace"));
    expect(defaultProjectRoot(repo, home)).toBe(join(home, "Workspace"));
    const plain = join(home, "notes", "today");
    mkdirSync(plain, { recursive: true });
    expect(defaultProjectRoot(plain, home)).toBe(join(home, "notes"));
    expect(resolveProjectRoots(["@parent"], repo, { home }).roots).toEqual([join(home, "Workspace")]);
  });

  test("a repository directly in the home: no default root, said; the home itself as a workspace: none either", () => {
    const home = join(base, "home");
    const repo = join(home, "proj");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q"], repo);
    const r = resolveProjectRoots(["@parent"], repo, { home });
    expect(r.roots).toEqual([]);
    expect(r.notes[0]).toContain("no project root: the default, the repository's parent");
    expect(r.notes[0]).toContain("set sandbox.projectRoots");
    const dirs = sandboxDirsOf(homedir(), ["@parent"], []);
    expect(dirs).toMatchObject({ roots: [], homeWorkspace: true });
    expect(dirs.notes[0]).toContain("only credentials are protected");
  });

  test("refused as roots and added dirs: ~, /, a dir holding the home, a hidden dir of it, ~/Library, a system dir, a relative path", () => {
    const home = join(base, "home");
    mkdirSync(home, { recursive: true });
    for (const bad of ["~", home, "/", base, "~/.config", "~/.local/share/x", "~/Library/x", "/etc", "/usr/lib", "relative/dir"]) {
      expect(sandboxDirProblem(bad, { home })).not.toBeNull();
      expect(resolveProjectRoots([bad], join(home, "w"), { home }).roots).toEqual([]);
    }
    expect(sandboxDirProblem("~/Workspace", { home })).toBeNull();
  });

  test("an added dir: an existing dir of yours, outside what the sandbox hides, holding no PATH entry", () => {
    const home = join(base, "home");
    const ok = join(home, "Workspace", "b");
    const bin = join(home, "tools", "bin");
    mkdirSync(ok, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const hidden = [join(home, "Workspace", "secrets")];
    mkdirSync(hidden[0] as string, { recursive: true });
    expect(addedDirProblem(ok, { home, hidden, path: "/usr/bin" })).toBeNull();
    expect(addedDirProblem(join(home, "Workspace", "missing"), { home })).toContain("doesn't exist");
    expect(addedDirProblem(join(home, "Workspace", "secrets"), { home, hidden })).toContain("in what the sandbox hides");
    expect(addedDirProblem(join(home, "tools"), { home, path: `/usr/bin:${bin}` })).toContain("on your PATH");
    writeFileSync(join(home, "file"), "");
    expect(addedDirProblem(join(home, "file"), { home })).toContain("isn't a directory");
  });

  test("the secret files at a project's top are hidden, not their examples, and not the session's own", () => {
    const root = join(base, "Workspace");
    for (const p of ["a", "b", "c/deep"]) mkdirSync(join(root, p), { recursive: true });
    for (const f of [".env", ".env.production", ".envrc", ".npmrc", ".env.example", ".env.sample", "README.md"]) writeFileSync(join(root, "b", f), "x");
    writeFileSync(join(root, "a", ".env"), "mine");
    writeFileSync(join(root, "c", "deep", ".env"), "deep");
    const found = projectRootSecrets([root], [join(root, "a")]).sort();
    expect(found).toEqual([".env", ".env.production", ".envrc", ".npmrc"].map((f) => join(root, "b", f)).sort());
  });
});

describe("the spec", () => {
  function layout() {
    const home = join(base, "home");
    const root = join(home, "Workspace");
    const a = join(root, "a");
    const b = join(root, "b");
    for (const r of [a, b]) {
      mkdirSync(r, { recursive: true });
      git(["init", "-q", "-b", "main"], r);
    }
    writeFileSync(join(b, ".env"), "secret");
    const tmp = join(base, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({
      sessionId: "s",
      workspace: a,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      worktreeFolder: "s-1234abcd",
      projectRoots: [root],
      addedDirs: [{ dir: b }],
    });
    return { home, root, a, b, spec };
  }

  test("a root is shown read-only; an added dir is writable, its git structure and project settings held, its worktree folder writable", () => {
    const { root, b, spec } = layout();
    expect(spec.projectRoots).toEqual([root]);
    expect(spec.reexposed).toContain(root);
    expect(spec.addedDirs).toEqual([b]);
    expect(spec.writable).toContain(b);
    expect(spec.writable).toContain(join(b, ".git"));
    for (const held of [join(b, ".git", "config"), join(b, ".git", "hooks"), join(b, ".claude"), join(b, ".mcp.json")]) expect(spec.readOnly).toContain(held);
    expect(spec.worktreeFolders).toContain(join(root, "b-worktrees", "s-1234abcd"));
    expect(spec.gitDirs).toContain(join(b, ".git"));
    // b's .env: the session writes b, so it is its own now.
    expect(spec.hidden).not.toContain(join(b, ".env"));
  });

  test("without the added dir, b's .env is hidden inside the root", () => {
    const { b, spec, home, root, a } = layout();
    const plain = buildSandboxSpec({
      sessionId: "s",
      workspace: a,
      tempDir: spec.tempDir,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      projectRoots: [root],
    });
    expect(plain.hidden).toContain(join(b, ".env"));
    expect(plain.writable).not.toContain(b);
  });

  test("Claude's own sandbox: a root holding the workspace is shown entry by entry around it (its read binds land after its write binds)", () => {
    const { root, a, b, spec } = layout();
    mkdirSync(join(root, "c"));
    const rt = { spec, config: sandboxConfigOf(undefined) } as unknown as Pick<SandboxRuntime, "spec" | "config">;
    const fs = claudeSandboxSettings(rt, {}, undefined, "linux").filesystem;
    expect(fs?.allowRead).not.toContain(root);
    expect(fs?.allowRead).toContain(join(root, "c"));
    expect(fs?.allowWrite).toContain(a);
    expect(fs?.allowWrite).toContain(b);
    expect(readAround([root], [a])).toEqual(expect.arrayContaining([b, join(root, "c")]));
    expect(readAround([root], [a])).not.toContain(a);
    expect(readAround([root], [])).toEqual([root]);
  });

  test("Codex's writable roots carry the added dirs", () => {
    const { b, spec } = layout();
    const policy = codexSandboxPolicy({ spec, plan: { kind: "native" } } as unknown as SandboxRuntime, "workspace-write", spec.workspace) as { writableRoots: string[] };
    expect(policy.writableRoots).toContain(b);
  });

  test("a file tool outside the sandbox writing an added dir's git structure or settings is held, as the workspace's", () => {
    const { a, b } = layout();
    const held = protectedWriteTargets(a, join(base, "home"), [b]).map((h) => h.at);
    expect(held).toContain(join(b, ".git"));
    expect(held).toContain(join(b, ".claude"));
  });
});

describe("the setting", () => {
  test("adding a dir or a root widens; removing one narrows; only dirs changed is told apart", () => {
    const cfg = sandboxConfigOf(undefined);
    const before = effectiveSetting(cfg, undefined);
    expect(before.projectRoots).toEqual(["@parent"]);
    expect(widens(before, effectiveSetting(cfg, { addedDirs: ["/srv/b"] }))).toBe(true);
    expect(widens(effectiveSetting(cfg, { addedDirs: ["/srv/b"] }), before)).toBe(false);
    expect(widens(before, effectiveSetting(cfg, { projectRoots: ["@parent", "/srv"] }))).toBe(true);
    expect(widens(before, effectiveSetting(cfg, { projectRoots: [] }))).toBe(false);
    expect(effectiveSetting(cfg, { addedDirs: ["~/b"] }).addedDirs).toEqual([join(process.env.HOME ?? homedir(), "b")]);
    expect(onlyDirsChanged({ network: "off" }, { network: "off", addedDirs: ["/x"] })).toBe(true);
    expect(onlyDirsChanged({ network: "off" }, { network: "on", addedDirs: ["/x"] })).toBe(false);
    expect(onlyDirsChanged(undefined, undefined)).toBe(false);
  });
});

describe("request_directory", () => {
  test("isn't asked about by the gate: the session decides it", () => {
    for (const n of ["mcp__codeoid_sandbox__request_directory", "codeoid_sandbox__request_directory"]) {
      expect(isRequestDirectoryTool(n)).toBe(true);
      expect(isSafeTool(n)).toBe(true);
    }
    for (const n of ["mcp__codeoid_sandbox__other", "x_codeoid_sandbox__request_directory", "mcp__evil__request_directory"]) expect(isSafeTool(n)).toBe(false);
  });

  test("/mcp/sandbox: a session's token is its scope; no token, or a revoked one, is refused; the token variable stays out of Codex's commands", async () => {
    const calls: Array<{ sessionId: string; path: string }> = [];
    const ep = new SandboxMcpHttp(async (sessionId, input) => {
      calls.push({ sessionId, path: input.path });
      return "ok";
    });
    const token = ep.mint("s1");
    const post = (body: unknown, t?: string) =>
      ep.handle(new Request("http://127.0.0.1/mcp/sandbox", { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(body) }));
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const list = (await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token)).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["request_directory"]);
    const r = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_directory", arguments: { path: "/srv/b", reason: "why" } } }, token)).json()) as { result: { content: Array<{ text: string }> } };
    expect(r.result.content[0]?.text).toBe("ok");
    const noReason = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_directory", arguments: { path: "/srv/b" } } }, token)).json()) as { result: { content: Array<{ text: string }> } };
    expect(noReason.result.content[0]?.text).toContain("say why");
    expect(calls).toEqual([{ sessionId: "s1", path: "/srv/b" }]);
    ep.revokeSession("s1");
    expect((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, token)).status).toBe(401);
    expect(SANDBOX_MCP_TOKEN_ENV).toMatch(/^CODEOID_.*_TOKEN$/);
  });
});

describe("applied between turns, never mid-work", () => {
  const DONE: ProviderEvent = { type: "turn_done", result: { providerId: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };
  let store: Store;
  let transcripts: TranscriptStore;
  beforeAll(async () => {
    await loadShellParser();
  });

  function fakeRegistry(opened: SandboxSpec[]): SandboxRegistry {
    const open = (spec: SandboxSpec) => {
      opened.push(spec);
      return new LocalSandboxHandle("bwrap", spec, (argv, o) => ({ argv: [...argv], env: o.env }));
    };
    const p: SandboxProvider = {
      id: "bwrap",
      displayName: "fake-bwrap",
      capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms: ["linux"] },
      probe: async () => ({ available: true }),
      open: async (s) => open(s),
      openSync: open,
    };
    const r = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
    r.register(p);
    return r;
  }

  test("SessionSandbox: a change of directories only leaves the running sandbox as it is until the next refresh", async () => {
    const work = join(base, "projects", "work");
    const other = join(base, "projects", "other");
    mkdirSync(work, { recursive: true });
    mkdirSync(other, { recursive: true });
    const sbx = new SessionSandbox({ sessionId: "s", workdir: work, registry: fakeRegistry([]) });
    await sbx.refresh("claude");
    expect(sbx.appliedAddedDirs()).toEqual([]);
    await sbx.set({ addedDirs: [other] });
    expect(sbx.dirsPending).toBe(true);
    expect(sbx.resolvedFor("claude")).toBe(true);
    expect(sbx.runtime?.spec.addedDirs).toBeUndefined();
    await sbx.refresh("claude");
    expect(sbx.dirsPending).toBe(false);
    expect(sbx.appliedAddedDirs()).toEqual([other]);
    expect(sbx.runtime?.spec.addedDirs).toEqual([other]);
    // Anything else changed with it: a change of setting as before.
    await sbx.set({ addedDirs: [other], network: "off" });
    expect(sbx.dirsPending).toBe(false);
    expect(sbx.resolvedFor("claude")).toBe(false);
    await sbx.close();
  });

  test("a session with background work running keeps its sandbox; the dir lands at the next turn after it ended, and the backend starts again in it", async () => {
    const dir = join(base, "s");
    const work = join(dir, "projects", "work");
    const other = join(dir, "projects", "other");
    mkdirSync(work, { recursive: true });
    mkdirSync(other, { recursive: true });
    mkdirSync(join(dir, "data"));
    store = new Store(join(dir, "data", "codeoid.db"));
    transcripts = new TranscriptStore(join(dir, "data", "transcripts"));
    const id = randomUUID();
    store.createSession({ id, name: "dirs", workdir: work, status: "idle", createdBy: AUTH.sub, createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId });
    const provider = new MockSessionProvider("claude", [[DONE], [DONE], [DONE]]);
    const opened: SandboxSpec[] = [];
    const session = new Session({
      name: "dirs",
      workdir: work,
      auth: AUTH,
      store,
      transcriptStore: transcripts,
      existingId: id,
      _testProvider: provider,
      initialMode: { mode: "guarded" },
      config: { workspaceIndex: { enabled: false }, compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 }, labeling: {}, telemetry: { osc8: "auto" }, autoRotate: { enabled: false }, session: {}, dbPath: join(dir, "data", "codeoid.db"), transcriptDir: join(dir, "data", "transcripts") } as unknown as CodeoidConfig,
      sandboxRegistry: fakeRegistry(opened),
    });
    const dialogs: SessionUiRequestMsg[] = [];
    const infos: string[] = [];
    session.attach({
      id: "c",
      auth: AUTH,
      capabilities: [CAPABILITIES.UI_DIALOGS],
      send: (m: { type: string; role?: string; content?: string }) => {
        if (m.type === "session.ui_request") dialogs.push(m as SessionUiRequestMsg);
        if (m.type === "session.message" && m.role === "info") infos.push(String(m.content ?? ""));
      },
    } as never);
    try {
      await session.send("one", AUTH);
      for (let i = 0; i < 200 && session.toInfo().status !== "idle"; i++) await Bun.sleep(5);
      provider.onSessionEvent?.({ type: "background_tasks", tasks: [{ id: "bg1", kind: "local_agent", description: "still working", status: "running" }] });
      const r = await session.changeSandboxDir("add", other, AUTH);
      expect(r).toMatchObject({ ok: true, pending: true });
      for (let i = 0; i < 200 && dialogs.length === 0; i++) await Bun.sleep(5);
      expect(dialogs[0]?.message).toContain("after the background work running now has ended");
      session.resolveUiRequestFromClient(dialogs[0]?.requestId as string, { confirmed: true }, AUTH);
      for (let i = 0; i < 200 && !session.toInfo().sandbox?.pendingDirs; i++) await Bun.sleep(5);
      expect(session.toInfo().sandbox?.pendingDirs).toEqual({ add: [other], remove: [] });
      expect(session.toInfo().sandbox?.addedDirs).toBeUndefined();
      // A turn while it runs: still the old sandbox, nothing restarted.
      const torn = provider.teardownCount;
      await session.send("two", AUTH);
      for (let i = 0; i < 200 && session.toInfo().status !== "idle"; i++) await Bun.sleep(5);
      expect(session.toInfo().sandbox?.addedDirs).toBeUndefined();
      expect(provider.teardownCount).toBe(torn);
      // It ended: the next turn has the dir, its backend restarted into it.
      provider.onSessionEvent?.({ type: "background_tasks", tasks: [] });
      await session.send("three", AUTH);
      for (let i = 0; i < 200 && session.toInfo().status !== "idle"; i++) await Bun.sleep(5);
      expect(session.toInfo().sandbox?.addedDirs).toEqual([other]);
      expect(session.toInfo().sandbox?.pendingDirs).toBeUndefined();
      expect(infos.some((t) => t.includes("Sandbox directories applied"))).toBe(true);
      expect(provider.teardownCount).toBeGreaterThan(torn);
    } finally {
      await session.destroy(AUTH).catch(() => {});
      await transcripts.flush().catch(() => {});
      store.close();
    }
  });
});
