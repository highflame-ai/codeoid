/**
 * #448 round 10: a sandboxed session's git worktrees go in its own folder of
 * each worktree location (sandbox/worktrees.ts), `sandbox.worktreeRoots` is
 * validated and scoped per repository, every other runtime's socket stays
 * hidden, and Docker access on Claude's Linux sandbox hides the host's /tmp.
 * No sandbox runs here (sandbox-worktrees-real.test.ts and
 * sandbox-claude-real.test.ts run the real ones).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfigObject } from "../config.js";
import type { CodeoidConfig } from "../config.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { claudeSandboxSettings, HOST_SHARED_TEMP, physicalOf } from "../daemon/sandbox/claude-native.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { buildSandboxSpec, containerSocketPaths, dockerSocketPaths, gitLayoutOf, HOST_SOCKET_DIRS, hiddenPathsFor, LOCAL_SERVICE_SOCKET_DIRS, localServiceSocketPaths, unconnectableDockerSockets } from "../daemon/sandbox/policy.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { CLAUDE_ALL_SOCKETS_NOTE, resolveSandbox, SessionSandbox } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { existingFolderName, sessionFolderName, worktreeFolderNote, worktreeLocationDirs, worktreeRootNotes, worktreeRootProblem } from "../daemon/sandbox/worktrees.js";
import { Session } from "../daemon/session.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext } from "../protocol/types.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-wt-folders-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function repo(at: string): string {
  mkdirSync(at, { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "i"]]) {
    const r = Bun.spawnSync(["git", ...args], { cwd: at, env: { ...process.env, ...ENV, HOME: root } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  }
  return at;
}

describe("a session's worktree folder name", () => {
  test("its name made safe, and a short id: stable, never a path", () => {
    expect(sessionFolderName("Fix login bug", "3f9a2c1d-0000-4000-8000-000000000000")).toBe("fix-login-bug-3f9a2c1d");
    expect(sessionFolderName("../..", "abc")).toBe("session-abc");
    expect(sessionFolderName("a/b\\c", "ID-1")).toBe("a-b-c-id1");
    expect(sessionFolderName("", "")).toBe("session-session");
    expect(sessionFolderName("x".repeat(100), "12345678zz")).toBe(`${"x".repeat(40)}-12345678`);
  });

  test("a renamed session keeps its folder (found by its short id); another session's isn't taken", () => {
    const loc = join(root, "repo-worktrees");
    mkdirSync(join(loc, "old-name-3f9a2c1d"), { recursive: true });
    mkdirSync(join(loc, "other-11112222"), { recursive: true });
    expect(existingFolderName([{ dir: loc }], "3f9a2c1d-0000")).toBe("old-name-3f9a2c1d");
    expect(existingFolderName([{ dir: loc }], "99998888-0000")).toBeNull();
    // A link with the id isn't one.
    symlinkSync(root, join(loc, "planted-99998888"));
    expect(existingFolderName([{ dir: loc }], "99998888-0000")).toBeNull();
  });
});

describe("sandbox.worktreeRoots validation (#448 round 10)", () => {
  const home = "/home/u";
  const ctx = { home, configDir: "/home/u/.codeoid" };
  test("refused: /, the home or a dir holding it, a hidden dir of the home, ~/Library, codeoid's config dir, a system dir, a relative one climbing out", () => {
    for (const r of ["/", "~", "/home", "~/.config", "~/.config/systemd/user", "~/.local", "~/.local/bin", "~/.ssh/wt", "~/.bashrc.d", "~/.claude/wt", "~/Library/LaunchAgents", "/home/u/.codeoid/wt", "/usr/local/wt", "/etc/wt", ".", "..", "../..", "../../wt"]) {
      expect([r, worktreeRootProblem(r, ctx)]).not.toEqual([r, null]);
    }
  });
  test("accepted: a dir of yours, beside the repository, a shared one (each repository gets its own dir in it)", () => {
    for (const r of ["~/wt", "~/src/worktrees", "/data/wt", "../wt", "wts"]) expect([r, worktreeRootProblem(r, ctx)]).toEqual([r, null]);
  });
  test("a shared root holds each repository apart: <root>/<repo>", () => {
    const a = repo(join(root, "a"));
    const layout = gitLayoutOf(a, join(root, "home"));
    if (!layout) throw new Error("no layout");
    const { locations, problems } = worktreeLocationDirs(layout, { roots: [join(root, "wt"), "~/.config"], home: join(root, "home") });
    expect(locations.map((l) => l.dir)).toEqual([join(root, "a-worktrees"), join(root, "wt", "a")]);
    expect(problems).toEqual([expect.stringContaining("~/.config is in a hidden dir of your home")]);
    // A root that isn't there and isn't beside the repository: said, never made.
    const notes = worktreeRootNotes(layout, { roots: [join(root, "elsewhere", "missing")], home: join(root, "home") });
    expect(notes).toEqual([]);
    const away = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-wt-away-")));
    try {
      const missing = join(away, "missing");
      expect(worktreeRootNotes(layout, { roots: [missing], home: join(root, "home") })).toEqual([expect.stringContaining("create it to use it")]);
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(away, { recursive: true, force: true });
    }
  });
  test("a relative root is judged again where it leads (#448 round 11): ../.config of a repository in the home is ~/.config; one inside the checkout is refused", () => {
    const home = join(root, "home");
    const proj = repo(join(home, "proj"));
    const layout = gitLayoutOf(proj, join(root, "elsewhere"));
    if (!layout) throw new Error("no layout");
    const { locations, problems } = worktreeLocationDirs(layout, { roots: ["../.config", "../.local", "./../.ssh", "../wt", ".claude/commands", "wts"], home });
    expect(locations.map((l) => l.dir)).toEqual([join(home, "proj-worktrees"), join(home, "wt", "proj")]);
    expect(problems).toEqual([
      expect.stringContaining(`../.config → ${join(home, ".config")} is in a hidden dir of your home (~/.config)`),
      expect.stringContaining("hidden dir of your home (~/.local)"),
      expect.stringContaining("hidden dir of your home (~/.ssh)"),
      expect.stringContaining(".claude/commands is inside the repository's checkout"),
      expect.stringContaining("wts is inside the repository's checkout"),
    ]);
    // Through a link too: a root beside the repository that leads into the home's hidden dirs.
    mkdirSync(join(home, ".config"));
    symlinkSync(join(home, ".config"), join(home, "cfg"));
    expect(worktreeLocationDirs(layout, { roots: ["../cfg"], home }).problems).toEqual([expect.stringContaining("hidden dir of your home (~/.config)")]);
  });
  test("on macOS a root differing only in case is the same dir (the filesystem ignores case)", () => {
    expect(worktreeRootProblem("/Users/Me/.Config/wt", { home: "/Users/me", platform: "darwin" })).toContain("hidden dir of your home");
    expect(worktreeRootProblem("/USERS/me/LIBRARY/wt", { home: "/Users/me", platform: "darwin" })).toContain("~/Library");
    expect(worktreeRootProblem("/Users/Me", { home: "/Users/me", platform: "darwin" })).toContain("your home");
    expect(worktreeRootProblem("/Users/Me/.Config/wt", { home: "/Users/me", platform: "linux" })).toBeNull();
  });
  test("the config refuses one at load, in a settings write, and from the environment, saying why", () => {
    const bad = validateConfigObject({ sandbox: { worktreeRoots: ["~/.local/bin"] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toMatchObject({ path: "sandbox.worktreeRoots.0", message: expect.stringContaining("hidden dir of your home") });
    expect(validateConfigObject({ sandbox: { worktreeRoots: ["~/wt"] } })).toEqual({ ok: true });
    expect(() => loadConfig({ raw: { sandbox: { worktreeRoots: ["/"] } }, env: {}, quiet: true })).toThrow(/not a worktree root: \/ is \//);
    expect(() => loadConfig({ raw: {}, env: { CODEOID_SANDBOX_WORKTREE_ROOTS: `${homedir()}/.config` }, quiet: true })).toThrow(/not a worktree root/);
  });
});

describe("local services' sockets (#448 round 11)", () => {
  test("hidden while the network is off or an allowlist, as the session's (not a backend handle's) network says; not with it on", async () => {
    const ws = join(root, "ws");
    mkdirSync(ws);
    const base = { sessionId: "s", workspace: ws, tempDir: join(root, "tmp"), hidden: { home: join(root, "home"), configDir: join(root, "home", ".codeoid"), env: { HOME: join(root, "home") }, daemonTmp: "/tmp" } };
    for (const network of [{ mode: "off" as const }, { mode: "allowlist" as const, allow: ["example.com"] }]) {
      const spec = buildSandboxSpec({ ...base, network });
      for (const d of ["/run/postgresql", "/var/run/postgresql", "/run/mysqld", "/var/run/mysqld", "/run/redis"]) expect(spec.serviceSockets).toContain(d);
    }
    expect(buildSandboxSpec({ ...base, network: { mode: "on" } }).serviceSockets).toBeUndefined();
    // A process backend's handle has the network on (for its model); a session with it off still hides them.
    expect(buildSandboxSpec({ ...base, network: { mode: "on" }, hideLocalServices: true }).serviceSockets).toEqual(expect.arrayContaining([...LOCAL_SERVICE_SOCKET_DIRS]));
    const reg = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
    reg.register(fakeBwrap());
    const sbx = new SessionSandbox({ sessionId: "x", workdir: ws, registry: reg, setting: { provider: "bwrap", network: "off" } });
    try {
      await sbx.refresh("pi");
      const rt = sbx.runtimeFor("pi");
      if (!rt) throw new Error("no runtime");
      const h = await rt.open([], { backendNetwork: true });
      expect(h.spec.network.mode).toBe("on");
      expect(h.spec.serviceSockets).toEqual(expect.arrayContaining([...LOCAL_SERVICE_SOCKET_DIRS]));
      expect(rt.spec.serviceSockets).toEqual(expect.arrayContaining([...LOCAL_SERVICE_SOCKET_DIRS]));
    } finally {
      await sbx.close();
    }
  });
  test("those in the host's shared temp dirs are found by name (Homebrew's Postgres and MySQL put theirs in /tmp)", () => {
    const t = join(root, "t");
    mkdirSync(t);
    for (const n of [".s.PGSQL.5432", ".s.PGSQL.5432.lock", "mysql.sock", "mysqlx.sock", "redis.sock", "mongodb-27017.sock", "tmux-1000", "notes.txt"]) writeFileSync(join(t, n), "");
    const found = localServiceSocketPaths([t]).filter((p) => p.startsWith(t));
    expect(found.sort()).toEqual([".s.PGSQL.5432", ".s.PGSQL.5432.lock", "mongodb-27017.sock", "mysql.sock", "mysqlx.sock", "redis.sock"].map((n) => join(t, n)).sort());
  });
  test("Claude's own sandbox denies their dirs; those in /tmp are behind its unix socket block or the denied /tmp", () => {
    const spec = { sessionId: "s", workspace: "/w", tempDir: "/t", writable: [], hidden: [], reexposed: [], containerSockets: [], serviceSockets: ["/run/postgresql", "/tmp/.s.PGSQL.5432"], network: { mode: "off" as const }, unsetEnv: [] };
    const sb = claudeSandboxSettings({ spec, config: { bwrapPath: undefined } as never }, {}, undefined, "linux");
    expect(sb.filesystem?.denyRead).toContain(physicalOf("/run/postgresql"));
    expect(sb.filesystem?.denyRead).not.toContain("/tmp/.s.PGSQL.5432");
  });
});

describe("runtime sockets (#448 round 10)", () => {
  test("libvirt, LXD, Incus and more runtimes are hidden; the system bus and screen's dir in every sandbox", () => {
    const paths = containerSocketPaths("/h", { XDG_RUNTIME_DIR: "/run/user/7" });
    for (const p of ["/run/libvirt", "/var/run/libvirt", "/run/user/7/libvirt", "/var/snap/lxd/common/lxd", "/var/lib/lxd", "/var/lib/incus", "/run/incus", "/run/docker", "/run/k0s", "/var/snap/microk8s/common/run", "/run/containerd", "/run/k3s"]) expect(paths).toContain(p);
    const hidden = hiddenPathsFor(undefined, { home: "/h", configDir: "/h/.codeoid", env: {}, daemonTmp: "/tmp" });
    for (const p of HOST_SOCKET_DIRS) expect(hidden).toContain(p);
  });

  test("a runtime socket the daemon's user can't connect to isn't shown, and is said", async () => {
    const run = join(root, "run");
    mkdirSync(run, { mode: 0o700 });
    const sock = join(run, "docker.sock");
    const server: Server = createServer(() => {});
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const env = { XDG_RUNTIME_DIR: run };
      // Only what this test planted: the machine's own runtime socket, if it has one, isn't the test's.
      const planted = (paths: string[]) => paths.filter((p) => p.startsWith(root));
      expect(planted(dockerSocketPaths(root, env, "linux"))).toEqual([sock]);
      chmodSync(sock, 0o400);
      if (process.getuid?.() === 0) return;
      expect(planted(dockerSocketPaths(root, env, "linux"))).toEqual([]);
      expect(planted(unconnectableDockerSockets(root, env, "linux"))).toEqual([sock]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("Docker access on Claude's own sandbox (#448 round 10)", () => {
  const spec = (dockerSockets?: string[]): SandboxSpec => ({
    sessionId: "s",
    workspace: "/w",
    tempDir: "/t",
    writable: ["/w-worktrees/agent-1"],
    hidden: ["/h"],
    reexposed: ["/w-worktrees", "/h/.bun"],
    containerSockets: ["/run/libvirt"],
    worktreeFolders: ["/w-worktrees/agent-1"],
    network: { mode: "off" },
    unsetEnv: [],
    ...(dockerSockets ? { dockerSockets } : {}),
  });
  const config = { provider: "auto", network: "off", allowedHosts: [], hiddenPaths: [], homeReadable: [], worktreeRoots: [], docker: { image: "x", socket: true } } as never;
  test("Linux: every unix socket allowed, so the host's /tmp and /var/tmp are denied; without Docker access, or on macOS, they aren't", () => {
    const on = claudeSandboxSettings({ spec: spec(["/run/user/1/docker.sock"]), config }, {}, undefined, "linux");
    expect(on.network?.allowAllUnixSockets).toBe(true);
    for (const t of HOST_SHARED_TEMP) expect(on.filesystem?.denyRead).toContain(t);
    const off = claudeSandboxSettings({ spec: spec(), config }, {}, undefined, "linux");
    for (const t of HOST_SHARED_TEMP) expect(off.filesystem?.denyRead).not.toContain(t);
    const mac = claudeSandboxSettings({ spec: spec(["/nonexistent/docker.sock"]), config }, {}, undefined, "darwin");
    expect(mac.network?.allowUnixSockets).toEqual(["/nonexistent/docker.sock"]);
    for (const t of HOST_SHARED_TEMP) expect(mac.filesystem?.denyRead).not.toContain(t);
  });
  test("a worktree location isn't readable there (the CLI would lay it over the session's writable folder); the folder is writable", () => {
    const s = claudeSandboxSettings({ spec: spec(), config }, {}, undefined, "linux");
    expect(s.filesystem?.allowRead).not.toContain("/w-worktrees");
    expect(s.filesystem?.allowRead).toContain("/h/.bun");
    expect(s.filesystem?.allowWrite).toContain("/w-worktrees/agent-1");
  });
});

function fakeBwrap(): SandboxProvider {
  const open = (spec: SandboxSpec) => new LocalSandboxHandle("bwrap", spec, (argv, o) => ({ argv: [...argv], env: o.env }));
  return {
    id: "bwrap",
    displayName: "bubblewrap",
    capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms: ["linux"] },
    probe: async () => ({ available: true }),
    open: async (spec) => open(spec),
    openSync: open,
  };
}

describe("the sandbox's limits and the session's note", () => {
  test("Claude on Linux with Docker access says every socket it can see is reachable; a missing root elsewhere is said", async () => {
    const run = join(root, "run");
    mkdirSync(run, { mode: 0o700 });
    const sock = join(run, "docker.sock");
    const server: Server = createServer(() => {});
    await new Promise<void>((r) => server.listen(sock, r));
    const saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = run;
    const away = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-wt-away-")));
    try {
      const reg = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
      reg.register(fakeBwrap());
      const ws = repo(join(root, "proj"));
      const config = { provider: "auto", network: "on", allowedHosts: [], hiddenPaths: [], homeReadable: [], worktreeRoots: [join(away, "missing")], docker: { image: "x", socket: false } } as never;
      const r = await resolveSandbox({ registry: reg, config, setting: { dockerSocket: true }, backendId: "claude", workspace: ws });
      expect(r.info.state).toBe("on");
      if (process.platform === "linux") expect(r.info.limits?.some((l) => l.includes(CLAUDE_ALL_SOCKETS_NOTE))).toBe(true);
      expect(r.info.limits?.some((l) => l.includes("create it to use it"))).toBe(true);
      const pi = await resolveSandbox({ registry: reg, config, setting: { dockerSocket: true }, backendId: "pi", workspace: ws });
      expect(pi.info.limits?.some((l) => l.includes(CLAUDE_ALL_SOCKETS_NOTE))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(away, { recursive: true, force: true });
    }
  });

  test("the session tells its agent where its worktrees go, in the system prompt every backend gets", async () => {
    const ws = repo(join(root, "proj"));
    const store = new Store(join(root, "codeoid.db"));
    const transcriptStore = new TranscriptStore(join(root, "transcripts"));
    const auth: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };
    const id = randomUUID();
    store.createSession({ id, name: "Fix Login", workdir: ws, status: "idle", createdBy: "u", createdAt: new Date().toISOString(), attachedClients: 0, accountId: "a", projectId: "p" });
    const done: ProviderEvent = { type: "turn_done", result: { providerId: "pi", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };
    const provider = new MockSessionProvider("pi", [[done]]);
    const reg = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
    reg.register(fakeBwrap());
    const session = new Session({
      name: "Fix Login",
      workdir: ws,
      auth,
      store,
      transcriptStore,
      existingId: id,
      _testProvider: provider,
      initialMode: { mode: "interactive" },
      config: {
        workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
        compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
        labeling: {},
        telemetry: { osc8: "auto" },
        autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
        session: {},
      } as unknown as CodeoidConfig,
      sandboxRegistry: reg,
      sandbox: { provider: "bwrap" },
    });
    try {
      await session.send("go", auth);
      const folder = join(root, "proj-worktrees", sessionFolderName("Fix Login", id));
      expect(provider.capturedOpts[0]?.systemPromptAppend).toContain(worktreeFolderNote([folder]));
      expect(worktreeFolderNote([folder])).toContain(`Create git worktrees under ${folder}/`);
      expect(existsSync(folder)).toBe(true);
    } finally {
      await session.destroy(auth).catch(() => {});
      await transcriptStore.flush().catch(() => {});
      store.close();
    }
    // Left empty, it goes with the session.
    expect(existsSync(join(root, "proj-worktrees", sessionFolderName("Fix Login", id)))).toBe(false);
  });

  test("SessionSandbox: no folder outside a repository", async () => {
    const reg = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
    reg.register(fakeBwrap());
    mkdirSync(join(root, "plain"));
    const sbx = new SessionSandbox({ sessionId: "x", workdir: join(root, "plain"), registry: reg, setting: { provider: "bwrap" } });
    try {
      await sbx.refresh("pi");
      expect(sbx.worktreeFolders()).toEqual([]);
    } finally {
      await sbx.close();
    }
  });
});
