/**
 * Codex in the OS sandbox (#448), against the fake codex app-server:
 *
 *   - codex's own sandbox policy per session: workspace-write (workspace and
 *     the session's temp dir writable, the network per the session) when
 *     codeoid's sandbox is native; full access inside codeoid's when the
 *     whole process is inside it; the old default without one;
 *   - the app-server starts inside codeoid's sandbox, its home reachable,
 *     the network on for it;
 *   - with real bubblewrap (skipped where it can't run): the app-server
 *     can't read a planted credential, and can read its own home.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, codexSandboxPolicy } from "../daemon/providers/codex/index.js";
import type { ProviderEvent, TurnOpts } from "../daemon/providers/interface.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { programLocations } from "../daemon/sandbox/policy.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { type SandboxRuntime, SessionSandbox } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxHandle, SandboxSpec } from "../daemon/sandbox/types.js";
import type { Store } from "../daemon/store.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex.ts");

function turnOpts(userMessage: string, workdir: string, over: Partial<TurnOpts> = {}): TurnOpts {
  return { history: [], userMessage, workdir, canUseTool: async () => ({ behavior: "allow" as const }), ...over };
}

async function textOf(provider: CodexProvider, opts: TurnOpts): Promise<string> {
  const events: ProviderEvent[] = [];
  for await (const e of provider.runTurn(opts).events) events.push(e);
  const done = events.filter((e) => e.type === "text_done") as Array<{ content: string }>;
  const err = events.find((e) => e.type === "error") as { message: string } | undefined;
  return done.map((e) => e.content).join("") || `ERROR:${err?.message ?? "none"}`;
}

function fakeRuntime(kind: "native" | "process", network: "on" | "off", tempDir: string) {
  const opened: Array<{ state: readonly string[]; opts: unknown }> = [];
  const wrapped: string[][] = [];
  const rt = {
    info: { choice: "auto", state: "on", network, enforced: true },
    plan: { kind, via: "", network: ["on", "off"], fileTools: true, wrapsBackend: true, limits: [] },
    provider: { id: "bwrap" },
    config: {},
    spec: { network: { mode: network }, tempDir } as unknown as SandboxSpec,
    open: async (state: readonly string[] = [], opts?: unknown) => {
      opened.push({ state, opts });
      return {
        wrap: (argv: readonly string[], o: { env: Record<string, string> }) => {
          wrapped.push([...argv]);
          return { argv: [...argv], env: o.env };
        },
        close: async () => {},
      } as unknown as SandboxHandle;
    },
    openSync: () => {
      throw new Error("unused");
    },
    privateHome: (key: string) => mkdtempSync(join(tmpdir(), `codeoid-home-test-${key}-`)),
    stateDir: (key: string) => mkdtempSync(join(tmpdir(), `codeoid-state-test-${key}-`)),
  } as unknown as SandboxRuntime;
  return { rt, opened, wrapped };
}

describe("codex's own sandbox, per session", () => {
  test("native: workspace-write, workspace and temp dir writable, network per session", () => {
    const { rt } = fakeRuntime("native", "off", "/var/tmp/codeoid-sandbox-s");
    expect(codexSandboxPolicy(rt, "danger-full-access", "/w")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/w", "/var/tmp/codeoid-sandbox-s"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(codexSandboxPolicy(fakeRuntime("native", "on", "/t").rt, "danger-full-access", "/w")).toMatchObject({ networkAccess: true });
    // Under the host's /tmp the temp dir is codeoid's bubblewrap's /tmp (writable: excludeSlashTmp false), not at its own path:
    // as a root of its own it would fail every command in codex's sandbox (#448 round 2).
    expect(codexSandboxPolicy(fakeRuntime("native", "off", "/tmp/codeoid-sandbox-s/tmp-x").rt, "danger-full-access", "/w")).toMatchObject({ writableRoots: ["/w"], excludeSlashTmp: false });
  });

  test("native: the repository's git dirs and the sandbox's cache dir are writable roots too (#448 round 2: codex's own sandbox makes every .git read-only)", () => {
    const { rt } = fakeRuntime("native", "off", "/t");
    const spec = rt.spec as unknown as Record<string, unknown>;
    spec.gitDirs = ["/r/.git", "/r/.git/worktrees/w"];
    spec.writable = ["/r/.git", "/r/.git/worktrees", "/r/.git/worktrees/w", "/h/.cache/codeoid-sandbox"];
    spec.env = { XDG_CACHE_HOME: "/h/.cache/codeoid-sandbox" };
    expect(codexSandboxPolicy(rt, "danger-full-access", "/w")).toMatchObject({ writableRoots: ["/w", "/t", "/r/.git", "/r/.git/worktrees/w", "/h/.cache/codeoid-sandbox"] });
  });

  test("the whole process inside codeoid's: full access inside it; no sandbox: the old default", () => {
    expect(codexSandboxPolicy(fakeRuntime("process", "on", "/t").rt, "danger-full-access", "/w")).toEqual({ type: "dangerFullAccess" });
    expect(codexSandboxPolicy(null, "danger-full-access", "/w")).toEqual({ type: "dangerFullAccess" });
    expect(codexSandboxPolicy(null, "workspace-write", "/w")).toMatchObject({ type: "workspaceWrite", networkAccess: false });
  });

  test("end to end: turn/start carries the policy, and the app-server is started through the sandbox, network on for it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "codeoid-sbx-codex-"));
    const { rt, opened, wrapped } = fakeRuntime("native", "off", "/tmp/codeoid-sandbox-x");
    const p = new CodexProvider({ sessionId: "s", initialBackingId: "s", command: process.execPath, argsPrefix: [FIXTURE], store: {} as Store, sandbox: () => rt });
    try {
      const policy = JSON.parse(await textOf(p, turnOpts("echo-policy", ws, { mode: "autonomous" }))) as { turn: { sandboxPolicy: Record<string, unknown>; approvalPolicy: string } };
      expect(policy.turn.approvalPolicy).toBe("never");
      expect(policy.turn.sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: [ws], networkAccess: false, excludeSlashTmp: false });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.opts).toMatchObject({ backendNetwork: true, readable: expect.arrayContaining(programLocations(process.execPath, [FIXTURE])) });
      // Its home is a private copy (#448 round 1), what it may write.
      expect(opened[0]?.state[0]).toContain("codeoid-home-test-codex-");
      expect(wrapped[0]?.slice(0, 3)).toEqual([process.execPath, FIXTURE, "app-server"]);
    } finally {
      await p.teardown();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

const bwrap = new BwrapSandboxProvider();
const real = await bwrap.probe();

describe.skipIf(!real.available)("codex's app-server inside real bubblewrap", () => {
  let root: string;
  beforeAll(() => {
    // Outside the host's /tmp: the sandbox's /tmp is its own.
    const parent = [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")].find((d) => {
      if (!d) return false;
      try {
        mkdirSync(d, { recursive: true });
        rmSync(mkdtempSync(join(d, "codeoid-probe-")), { recursive: true });
        return true;
      } catch {
        return false;
      }
    });
    root = realpathSync(mkdtempSync(join(parent ?? tmpdir(), "codeoid-sbx-codex-real-")));
    for (const d of ["ws", "secrets", "codex-home"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "secrets", "token"), "PLANTED\n");
    writeFileSync(join(root, "codex-home", "auth.json"), "OWN-LOGIN\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a planted credential is unreadable to the app-server; its own login isn't, and its real home isn't writable", async () => {
    const registry = new SandboxRegistry("linux");
    registry.register(bwrap);
    const config = { sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [join(root, "secrets")], docker: { image: "x" } } } as never;
    const sbx = new SessionSandbox({ sessionId: "codex-real", workdir: join(root, "ws"), registry, config });
    await sbx.refresh("codex");
    expect(sbx.info).toMatchObject({ state: "on", confinement: "native" });
    const p = new CodexProvider({
      sessionId: "s",
      initialBackingId: "s",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: {} as Store,
      sandbox: () => sbx.runtime,
      extraEnv: {},
    });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "codex-home");
    try {
      expect(await textOf(p, turnOpts(`read-file:${join(root, "secrets", "token")}`, join(root, "ws")))).toStartWith("UNREADABLE:");
      // Its login through its own CODEX_HOME (a private copy, written back when it exits: #448 round 2); the real file isn't shown.
      const home = (JSON.parse(await textOf(p, turnOpts("echo-env", join(root, "ws")))) as Record<string, string>).CODEX_HOME ?? "";
      expect(home).not.toBe(join(root, "codex-home"));
      expect(await textOf(p, turnOpts(`read-file:${join(home, "auth.json")}`, join(root, "ws")))).toBe("CONTENT:OWN-LOGIN");
      expect(await textOf(p, turnOpts(`read-file:${join(root, "codex-home", "auth.json")}`, join(root, "ws")))).toStartWith("UNREADABLE:");
      // Its real home isn't writable: a config.toml planted there would run in the user's own codex (#448 round 1).
      expect(await textOf(p, turnOpts(`write-file:${join(root, "codex-home", "config.toml")}`, join(root, "ws")))).toStartWith("UNWRITABLE:");
      expect(await textOf(p, turnOpts(`write-file:${join(root, "codex-home", "auth.json")}`, join(root, "ws")))).toStartWith("UNWRITABLE:");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      await p.teardown();
      await sbx.close();
    }
    expect(existsSync(join(root, "codex-home", "config.toml"))).toBe(false);
  }, 60_000);
});

/**
 * #448 round 2: a Codex session commits, in a plain repository and in a
 * linked worktree, under the default sandbox. The real `codex sandbox` (its
 * own workspace-write, with the writable roots codexSandboxPolicy gives it)
 * runs inside codeoid's real bubblewrap, as the app-server's commands do;
 * the repository's structure stays read-only (codeoid's bubblewrap holds it).
 */
const CODEX = Bun.which("codex");
describe.skipIf(!real.available || !CODEX || !Bun.which("git"))("a Codex session commits under the default sandbox (real codex sandbox inside real bubblewrap)", () => {
  let root: string;
  beforeAll(() => {
    // Outside the host's /tmp (the sandbox's /tmp is its own; codex won't keep helpers under a temp dir).
    const parent = [process.env.CODEOID_TEST_SANDBOX_DIR, join(homedir(), ".cache"), "/var/tmp"].find((d) => {
      if (!d) return false;
      try {
        mkdirSync(d, { recursive: true });
        rmSync(mkdtempSync(join(d, "codeoid-probe-")), { recursive: true });
        return true;
      } catch {
        return false;
      }
    });
    root = realpathSync(mkdtempSync(join(parent ?? tmpdir(), "codeoid-sbx-codex-git-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const env = (home: string, codexHome: string) => ({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    CODEX_HOME: codexHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  });

  for (const worktree of [false, true]) {
    test(worktree ? "a linked worktree" : "a plain repository", async () => {
      const dir = join(root, worktree ? "wt" : "plain");
      const home = join(dir, "home");
      const repo = join(dir, "repo");
      const codexHome = join(dir, "codex-home");
      for (const d of [home, repo, codexHome]) mkdirSync(d, { recursive: true });
      const e = env(home, codexHome);
      const git = (args: string[], cwd: string) => {
        const r = Bun.spawnSync(["git", ...args], { cwd, env: e });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString();
      };
      git(["init", "-q", "-b", "main"], repo);
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(["add", "."], repo);
      git(["commit", "-qm", "init"], repo);
      let ws = repo;
      if (worktree) {
        ws = join(dir, "feat");
        git(["worktree", "add", "-q", "-b", "feat", ws], repo);
      }
      const registry = new SandboxRegistry("linux");
      registry.register(bwrap);
      const config = { sandbox: { provider: "bwrap", network: "off", allowedHosts: [], hiddenPaths: [], homeReadable: [], docker: { image: "x" } } } as never;
      const sbx = new SessionSandbox({ sessionId: "codex-git", workdir: ws, registry, config });
      await sbx.refresh("codex");
      const rt = sbx.runtime as SandboxRuntime;
      expect(rt.plan.kind).toBe("native");
      const policy = codexSandboxPolicy(rt, "danger-full-access", ws) as { writableRoots: string[] };
      const roots = policy.writableRoots.filter((r) => r !== ws);
      // codex's home is the app-server's own state (writable for it), as the provider opens it.
      const h = await rt.open([codexHome], { backendNetwork: true, readable: programLocations(CODEX as string) });
      try {
        writeFileSync(join(ws, "n.txt"), "n\n");
        const inner = "git add n.txt && git commit -qm in-codex && echo COMMITTED; echo bad >> .git/config 2>/dev/null && echo CONFIG-WRITTEN; git config core.fsmonitor bad 2>/dev/null && echo FSMONITOR-SET; mv .git .git-moved 2>/dev/null && echo DOTGIT-MOVED; true";
        const r = await h.exec(
          [CODEX as string, "sandbox", "-c", 'sandbox_mode="workspace-write"', "-c", `sandbox_workspace_write.writable_roots=[${roots.map((x) => JSON.stringify(x)).join(",")}]`, "--", "/bin/sh", "-c", inner],
          { cwd: ws, env: e, timeoutMs: 60_000 },
        );
        expect(r.stdout).toContain("COMMITTED");
        expect(r.stdout).not.toContain("CONFIG-WRITTEN");
        expect(r.stdout).not.toContain("FSMONITOR-SET");
        expect(r.stdout).not.toContain("DOTGIT-MOVED");
      } finally {
        await h.close();
        await sbx.close();
      }
      expect(git(["log", "--oneline", worktree ? "feat" : "main"], repo)).toContain("in-codex");
      // Nothing planted: `config --get-all` finds no fsmonitor (exit 1).
      expect(Bun.spawnSync(["git", "config", "--get-all", "core.fsmonitor"], { cwd: repo, env: e }).exitCode).toBe(1);
    }, 90_000);
  }
});
