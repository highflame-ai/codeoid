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
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeoidConfig, loadConfig } from "../config.js";
import { codexSandboxPolicy } from "../daemon/providers/codex/index.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { isRequestDirectoryTool, isSafeTool } from "../daemon/providers/tool-safety.js";
import { claudeSandboxSettings, readAround } from "../daemon/sandbox/claude-native.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { buildSandboxSpec, protectedWriteTargets } from "../daemon/sandbox/policy.js";
import {
  addedDirProblem,
  autonomousGrantProblem,
  defaultProjectRoot,
  nestedControl,
  projectRootProblem,
  projectRootSecrets,
  resolveProjectRoots,
  sandboxDirProblem,
  stillRealDir,
} from "../daemon/sandbox/project-roots.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { SANDBOX_MCP_TOKEN_ENV, SandboxMcpHttp } from "../daemon/sandbox/request-directory.js";
import { canonicalAddedDirs, effectiveSetting, onlyDirsChanged, type SandboxRuntime, sandboxDirsOf, SessionSandbox, widens } from "../daemon/sandbox/session-sandbox.js";
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
/** Not the host's temp dir: no project root is in one (dir-rules.ts `projectRootProblem`). */
function scratchParent(): string {
  const dir = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}
const realHome = process.env.HOME;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-roots-")));
  // A home of the test's own, beside the projects: they are in no hidden dir of it (~/.cache is one of yours).
  process.env.HOME = join(base, "fakehome");
  mkdirSync(process.env.HOME);
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(base, { recursive: true, force: true });
});

describe("project roots", () => {
  test("the default is the repository's parent; a linked worktree's is its main checkout's; outside a repository, none (said)", () => {
    const home = join(base, "home");
    const repo = join(home, "Workspace", "app");
    mkdirSync(join(repo, "packages", "ui"), { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    expect(defaultProjectRoot(join(repo, "packages", "ui"), home)).toBe(join(home, "Workspace"));
    expect(defaultProjectRoot(repo, home)).toBe(join(home, "Workspace"));
    const plain = join(home, "notes", "today");
    mkdirSync(plain, { recursive: true });
    expect(defaultProjectRoot(plain, home)).toBeNull();
    const none = resolveProjectRoots(["@parent"], plain, { home });
    expect(none.roots).toEqual([]);
    expect(none.notes[0]).toContain("the workspace isn't in a repository, so there is no default");
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
    const dirs = sandboxDirsOf(process.env.HOME as string, ["@parent"], []);
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

  test("the secret files anywhere in a root are hidden, not their examples, and not the session's own", () => {
    const root = join(base, "Workspace");
    for (const p of ["a", "b", "c/deep"]) mkdirSync(join(root, p), { recursive: true });
    for (const f of [".env", ".env.production", ".envrc", ".npmrc", ".env.example", ".env.sample", "README.md"]) writeFileSync(join(root, "b", f), "x");
    writeFileSync(join(root, "a", ".env"), "mine");
    writeFileSync(join(root, "c", "deep", ".env"), "deep");
    const found = projectRootSecrets([root], [join(root, "a")]).hidden.sort();
    expect(found).toEqual([...[".env", ".env.production", ".envrc", ".npmrc"].map((f) => join(root, "b", f)), join(root, "c", "deep", ".env")].sort());
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

  test("request_directory unanswered: the call returns before its backend's MCP client would give up, the question stays open, a repeat joins it, a later yes adds it", async () => {
    const dir = join(base, "late");
    const work = join(dir, "projects", "work");
    const other = join(dir, "projects", "other");
    mkdirSync(work, { recursive: true });
    mkdirSync(other, { recursive: true });
    mkdirSync(join(dir, "data"));
    const st = new Store(join(dir, "data", "codeoid.db"));
    const tr = new TranscriptStore(join(dir, "data", "transcripts"));
    const id = randomUUID();
    st.createSession({ id, name: "late", workdir: work, status: "idle", createdBy: AUTH.sub, createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId });
    const session = new Session({
      name: "late",
      workdir: work,
      auth: AUTH,
      store: st,
      transcriptStore: tr,
      existingId: id,
      _testProvider: new MockSessionProvider("opencode", [[DONE]]),
      initialMode: { mode: "guarded" },
      config: { workspaceIndex: { enabled: false }, compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 }, labeling: {}, telemetry: { osc8: "auto" }, autoRotate: { enabled: false }, session: {}, dbPath: join(dir, "data", "codeoid.db"), transcriptDir: join(dir, "data", "transcripts") } as unknown as CodeoidConfig,
      sandboxRegistry: fakeRegistry([]),
      requestDirectoryWaitMs: 30,
    });
    const dialogs: SessionUiRequestMsg[] = [];
    session.attach({ id: "c", auth: AUTH, capabilities: [CAPABILITIES.UI_DIALOGS], send: (m: { type: string }) => void (m.type === "session.ui_request" && dialogs.push(m as SessionUiRequestMsg)) } as never);
    try {
      await session.ensureSandbox();
      expect(await session.requestDirectory({ path: other, reason: "shared types" })).toContain("No answer yet");
      expect(await session.requestDirectory({ path: other, reason: "again" })).toContain("No answer yet");
      expect(dialogs).toHaveLength(1);
      session.resolveUiRequestFromClient(dialogs[0]?.requestId as string, { confirmed: true }, AUTH);
      for (let i = 0; i < 200 && !session.toInfo().sandbox?.addedDirs; i++) await Bun.sleep(5);
      expect(session.toInfo().sandbox?.addedDirs).toEqual([other]);
      expect(await session.requestDirectory({ path: other, reason: "check" })).toContain("is added already");
    } finally {
      await session.destroy(AUTH).catch(() => {});
      await tr.flush().catch(() => {});
      st.close();
    }
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

/** `<home>/Workspace/{a,b}`, each a repository, and a dir of yours outside every root. */
function workspaceLayout() {
  const home = join(base, "home");
  const root = join(home, "Workspace");
  const a = join(root, "a");
  const b = join(root, "b");
  const docs = join(home, "Documents");
  for (const r of [a, b]) {
    mkdirSync(r, { recursive: true });
    git(["init", "-q", "-b", "main"], r);
  }
  mkdirSync(docs, { recursive: true });
  const tmp = join(base, "tmp");
  mkdirSync(tmp, { recursive: true });
  const spec = (over: Partial<Parameters<typeof buildSandboxSpec>[0]> = {}) =>
    buildSandboxSpec({
      sessionId: "s",
      workspace: a,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
      projectRoots: [root],
      ...over,
    });
  return { home, root, a, b, docs, tmp, spec };
}

describe("an added directory is what it was when granted (#448 round 12)", () => {
  test("kept by its real path; replaced by a link later, it is dropped at the next build (said), never followed", () => {
    const { home, root, a, docs, spec } = workspaceLayout();
    const c = join(root, "c");
    mkdirSync(c);
    const link = join(root, "a-worktrees", "s-1234abcd", "x");
    mkdirSync(join(root, "a-worktrees", "s-1234abcd"), { recursive: true });
    symlinkSync(docs, link);
    // What is kept is where it really is when granted.
    expect(canonicalAddedDirs({ addedDirs: [link, c] }).addedDirs).toEqual([docs, c]);
    expect(canonicalAddedDirs({ addedDirs: [link] }, { addedDirs: [link] }).addedDirs).toEqual([link]);
    expect(stillRealDir(c)).toBe(true);
    expect(spec({ addedDirs: [{ dir: c }] }).writable).toContain(c);
    // c swapped for a link to a dir of yours.
    renameSync(c, join(root, "c-old"));
    symlinkSync(docs, c);
    expect(stillRealDir(c)).toBe(false);
    const after = spec({ addedDirs: [{ dir: c }] });
    expect(after.addedDirs).toBeUndefined();
    expect(after.writable).not.toContain(c);
    expect(after.writable).not.toContain(docs);
    // A stored link (as an older daemon kept one) isn't followed either.
    expect(spec({ addedDirs: [{ dir: link }] }).writable).not.toContain(docs);
    process.env.HOME = home;
    const dirs = sandboxDirsOf(a, [], [c]);
    expect(dirs.added).toEqual([]);
    expect(dirs.dropped[0]?.dir).toBe(c);
    expect(dirs.notes.join("\n")).toContain(`${c} is a symbolic link now`);
  });

  test("autonomous: only by a path with no link in it, strictly under a root, in a repository", () => {
    const { home, root, b, docs } = workspaceLayout();
    const clients = join(root, "clients");
    mkdirSync(join(clients, "beta"), { recursive: true });
    git(["init", "-q"], join(clients, "beta"));
    mkdirSync(join(b, "src"));
    symlinkSync(b, join(root, "b-alias"));
    expect(autonomousGrantProblem(b, b, [root], home)).toBeNull();
    expect(autonomousGrantProblem(join(b, "src"), join(b, "src"), [root], home)).toBeNull();
    expect(autonomousGrantProblem(join(clients, "beta"), join(clients, "beta"), [root], home)).toBeNull();
    expect(autonomousGrantProblem(join(root, "b-alias"), b, [root], home)).toContain("goes through a symbolic link");
    expect(autonomousGrantProblem(clients, clients, [root], home)).toContain("isn't in a repository");
    expect(autonomousGrantProblem(root, root, [root], home)).toContain("isn't under this session's project roots");
    expect(autonomousGrantProblem(docs, docs, [root], home)).toContain("isn't under this session's project roots");
  });

  test("a git or project settings dir, or one inside it, is never added: what is in it runs outside the sandbox", () => {
    const { home, root, b } = workspaceLayout();
    const bare = join(root, "server.git");
    mkdirSync(bare);
    git(["init", "-q", "--bare"], bare);
    git(["config", "core.hooksPath", ".husky"], b);
    const refused = [
      ...[".claude", ".codex", ".gemini", ".qwen", ".pi", ".opencode"].map((d) => join(b, d)),
      join(b, ".claude", "hooks"),
      join(b, ".git"),
      join(b, ".git", "hooks"),
      join(b, ".git", "info"),
      bare,
      join(bare, "hooks"),
      join(b, ".husky"),
    ];
    for (const d of refused) {
      mkdirSync(d, { recursive: true });
      expect([d, addedDirProblem(d, { home, path: "/usr/bin" })]).toEqual([d, expect.stringMatching(/settings dir|\.git dir|git dir|hooks dir/)]);
    }
    expect(addedDirProblem(b, { home, path: "/usr/bin" })).toBeNull();
  });

  test("a folder of repositories: each repository's git structure and every settings dir in it held, as the workspace's", () => {
    const { home, root, spec } = workspaceLayout();
    const clients = join(root, "clients");
    for (const r of ["beta", "gamma"]) {
      mkdirSync(join(clients, r), { recursive: true });
      git(["init", "-q"], join(clients, r));
    }
    mkdirSync(join(clients, "beta", ".claude"));
    mkdirSync(join(clients, "notes", "deep", ".codex"), { recursive: true });
    mkdirSync(join(clients, "web", "node_modules", "x", ".git"), { recursive: true });
    const nested = nestedControl(clients);
    expect(nested.complete).toBe(true);
    expect(nested.repos.sort()).toEqual([join(clients, "beta"), join(clients, "gamma")]);
    const s = spec({ addedDirs: [{ dir: clients }] });
    expect(s.writable).toContain(clients);
    for (const held of [
      join(clients, "beta", ".git", "config"),
      join(clients, "beta", ".git", "hooks"),
      join(clients, "gamma", ".git", "hooks"),
      join(clients, "beta", ".claude"),
      join(clients, "gamma", ".mcp.json"),
      join(clients, "notes", "deep", ".codex"),
    ]) {
      expect([held, s.readOnly?.includes(held)]).toEqual([held, true]);
    }
    const targets = protectedWriteTargets(join(root, "a"), home, [clients]).map((h) => h.at);
    for (const t of [join(clients, "beta", ".git"), join(clients, "beta", ".claude"), join(clients, "notes", "deep", ".codex")]) expect(targets).toContain(t);
  });

  test("the look through an added dir is bounded, and fails closed: past it, refused, and left out of the spec", () => {
    const { home, root, spec } = workspaceLayout();
    const big = join(root, "big");
    for (let i = 0; i < 5; i++) mkdirSync(join(big, `d${i}`), { recursive: true });
    expect(nestedControl(big, 3).complete).toBe(false);
    expect(addedDirProblem(big, { home, path: "/usr/bin", scanLimit: 3 })).toContain("holds more than 3 directories");
    expect(addedDirProblem(big, { home, path: "/usr/bin" })).toBeNull();
    expect(spec({ addedDirs: [{ dir: big }], scanLimit: 3 }).writable).not.toContain(big);
    expect(spec({ addedDirs: [{ dir: big }] }).writable).toContain(big);
  });
});

describe("credentials inside project roots (#448 round 12)", () => {
  test("hidden by name anywhere in a root (codeoid's worktrees of sibling repositories too), not their examples, not the session's own", () => {
    const { root, a, b } = workspaceLayout();
    const secret = [
      ".env",
      ".env.production.local",
      ".envrc",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      ".vault-token",
      "server.pem",
      "tls.key",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa_old",
      "cert.p12",
      "cert.pfx",
      "kubeconfig",
      "dev.kubeconfig",
      "terraform.tfstate",
      "terraform.tfstate.backup",
      "prod.tfvars",
      "credentials.json",
      "service-account-prod.json",
      "secrets.yaml",
      "config/.env",
      "config/secrets.yml",
      ".claude/settings.local.json",
      ".mcp.json",
      ".docker/config.json",
    ].map((f) => join(b, f));
    const dirs = [".aws", ".ssh", ".kube", ".gnupg"].map((d) => join(b, d));
    const plain = [".env.example", ".env.sample", ".env.template", "id_rsa.pub", "id_ed25519.pub", "README.md", "credentials.ts", "secrets.py", "keys.txt", "node_modules/pkg/.env"].map((f) => join(b, f));
    const worktrees = [join(root, "b-worktrees", "fork-1234", ".env"), join(root, "b-worktrees", "other-abcd", "feat", ".env")];
    for (const f of [...secret, ...plain, ...worktrees, ...dirs.map((d) => join(d, "credentials")), join(a, ".env"), join(a, "id_rsa")]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "x");
    }
    const found = projectRootSecrets([root], [a]);
    expect(found.over).toEqual([]);
    expect(found.hidden.sort()).toEqual([...secret, ...dirs, ...worktrees].sort());
  });

  test("a repository's .git/config carrying a credential is hidden (said: git there can't read its config); a plain one isn't", () => {
    const { home, root, a, b } = workspaceLayout();
    const c = join(root, "c");
    const d = join(root, "d");
    for (const r of [c, d]) {
      mkdirSync(r);
      git(["init", "-q"], r);
    }
    git(["remote", "add", "origin", "https://x:ghp_PLANTED@example.invalid/b.git"], b);
    git(["remote", "add", "origin", "ssh://git@example.invalid/c.git"], c);
    git(["config", "http.https://example.invalid/.extraheader", "Authorization: Bearer PLANTED"], d);
    const found = projectRootSecrets([root], [a]);
    expect(found.gitConfigs.sort()).toEqual([join(b, ".git", "config"), join(d, ".git", "config")]);
    expect(found.hidden).not.toContain(join(c, ".git", "config"));
    process.env.HOME = home;
    const notes = sandboxDirsOf(a, [root], []).notes.join("\n");
    expect(notes).toContain(`${join(b, ".git", "config")} holds a credential`);
    expect(notes).toContain(`git in ${b} can't read its config`);
  });

  test("the look through a root is bounded and fails closed: a root past it isn't shown, said", () => {
    const { root, a, spec } = workspaceLayout();
    for (let i = 0; i < 5; i++) mkdirSync(join(root, `p${i}`, "src"), { recursive: true });
    expect(projectRootSecrets([root], [a], 4).over).toEqual([root]);
    const s = spec({ scanLimit: 4 });
    expect(s.projectRoots).toBeUndefined();
    expect(s.reexposed).not.toContain(root);
    expect(spec().projectRoots).toEqual([root]);
  });
});

describe("project roots: never the host's temp dir, none outside a repository (#448 round 12)", () => {
  test("/tmp, anything in it, /var/tmp's and TMPDIR's: refused as roots (the config too); a temp dir itself isn't an added dir", () => {
    for (const bad of ["/tmp", "/tmp/work", "/var/tmp/x", join(tmpdir(), "x")]) expect([bad, projectRootProblem(bad)]).toEqual([bad, expect.stringContaining("temp dir")]);
    expect(sandboxDirProblem("/tmp")).toContain("temp dir");
    expect(sandboxDirProblem("/var/tmp")).toContain("temp dir");
    expect(projectRootProblem(join(base, "projects"))).toBeNull();
    expect(() => loadConfig({ raw: { sandbox: { projectRoots: ["/tmp/projects"] } }, env: {}, quiet: true })).toThrow(/temp dir/);
  });

  test("a repository in the host's temp dir: no default root, said", () => {
    const t = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-roots-tmp-")));
    try {
      const repo = join(t, "a");
      mkdirSync(repo);
      git(["init", "-q"], repo);
      const r = resolveProjectRoots(["@parent"], repo, { home: join(base, "home") });
      expect(r.roots).toEqual([]);
      expect(r.notes[0]).toContain("no project root: the default, the repository's parent");
      expect(r.notes[0]).toContain("temp dir");
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});
