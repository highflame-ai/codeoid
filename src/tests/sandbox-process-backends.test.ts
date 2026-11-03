/**
 * Backends whose whole process starts inside the session's OS sandbox
 * (#448): pi, the Gemini CLI (ACP) and Qwen Code (its SDK spawns the CLI,
 * so a launcher does). Against the fake pi and ACP agents; with real
 * bubblewrap where it can run:
 *
 *   - the process can't read a planted credential, and can read its own home;
 *   - Qwen's real bundled CLI starts through its launcher inside bubblewrap.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAcpProvider, geminiCliOwnState } from "../daemon/providers/acp/index.js";
import type { ProviderEvent, TurnOpts } from "../daemon/providers/interface.js";
import { PiProvider, piOwnState } from "../daemon/providers/pi/index.js";
import { qwenCliArgv, qwenExecutableOption, qwenOwnState } from "../daemon/providers/qwen/index.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { programLocations } from "../daemon/sandbox/policy.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { launcherScript, type SandboxRuntime, SessionSandbox, shellQuote } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";
import { Store } from "../daemon/store.js";

const PI = join(import.meta.dir, "fixtures", "fake-pi.ts");
const ACP = join(import.meta.dir, "fixtures", "fake-acp.ts");

async function textOf(run: { events: AsyncIterable<ProviderEvent> }): Promise<string> {
  let text = "";
  let deltas = "";
  for await (const e of run.events) {
    if (e.type === "text_done") text += (e as { content: string }).content;
    if (e.type === "text_delta") deltas += (e as { content?: string; delta?: string }).content ?? "";
    if (e.type === "error") return `ERROR:${(e as { message: string }).message}`;
  }
  return text || deltas;
}

function turn(userMessage: string, workdir: string): TurnOpts {
  return { history: [], userMessage, workdir, canUseTool: async () => ({ behavior: "allow" as const }) };
}

function recordingRuntime() {
  const opened: Array<{ state: readonly string[]; opts: unknown }> = [];
  const rt = {
    plan: { kind: "process", wrapsBackend: true },
    open: async (state: readonly string[] = [], opts?: unknown) => {
      opened.push({ state, opts });
      return { providerId: "rec", wrap: (argv: readonly string[], o: { env: Record<string, string> }) => ({ argv: [...argv], env: o.env }) } as unknown as SandboxHandle;
    },
    openSync: (state: readonly string[] = [], opts?: unknown) => {
      opened.push({ state, opts });
      return { providerId: "rec", wrap: (argv: readonly string[]) => ({ argv: ["/usr/bin/bwrap", "--x", "--", ...argv], env: {} }) } as unknown as SandboxHandle;
    },
    launcher: (h: SandboxHandle, argv: readonly string[]) => {
      const dir = mkdtempSync(join(tmpdir(), "codeoid-launch-test-"));
      const path = join(dir, "launch");
      writeFileSync(path, launcherScript(h.wrap?.(argv, { cwd: "/", env: {} }).argv ?? []), { mode: 0o700 });
      return path;
    },
  } as unknown as SandboxRuntime;
  return { rt, opened };
}

let tmp: string;
let store: Store;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-sbx-proc-"));
  store = new Store(join(tmp, "codeoid.db"));
  for (const k of ["XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"]) saved[k] = process.env[k];
  process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
  process.env.PI_CODING_AGENT_DIR = join(tmp, "pi-agent");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    store.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function makePi(rt: SandboxRuntime | null, workdir: string): PiProvider {
  store.createSession({ id: "sess-pi", name: "pi", workdir, status: "idle", createdBy: "u", createdAt: new Date().toISOString(), attachedClients: 0, accountId: "a", projectId: "p" });
  return new PiProvider({ sessionId: "sess-pi", initialBackingId: "sess-pi", command: process.execPath, argsPrefix: [PI], store, sandbox: () => rt });
}

describe("each backend's own state, and how it is started", () => {
  test("own state: pi's agent dir, the Gemini CLI's .gemini, Qwen's home (an account's and the default)", () => {
    expect(piOwnState({ HOME: "/h", PI_CODING_AGENT_DIR: "/cfg/accounts/pi-session/x" }, { HOME: "/h", PI_CODING_AGENT_DIR: "/pi" })).toEqual(["/cfg/accounts/pi-session/x", "/pi"]);
    expect(geminiCliOwnState({ HOME: "/h", GEMINI_CLI_HOME: "/cfg/accounts/gemini/w" })).toEqual(expect.arrayContaining(["/cfg/accounts/gemini/w/.gemini"]));
    expect(qwenOwnState({ HOME: "/h", QWEN_HOME: "/cfg/accounts/qwen/w" })).toContain("/cfg/accounts/qwen/w");
  });

  test("pi starts through the sandbox: its agent dir as its state, its program and codeoid's bridge readable", async () => {
    const { rt, opened } = recordingRuntime();
    const p = makePi(rt, tmp);
    try {
      expect(await textOf(p.runTurn(turn("echo-prompt hi", tmp)))).toContain("received:");
      expect(opened).toHaveLength(1);
      expect(opened[0]?.state).toContain(join(tmp, "pi-agent"));
      const readable = (opened[0]?.opts as { readable: string[] }).readable;
      expect(readable).toEqual(expect.arrayContaining(programLocations(process.execPath, [PI])));
      expect(readable.some((d) => d.includes("codeoid-pi-bridge-"))).toBe(true);
    } finally {
      await p.teardown();
    }
  });

  test("the Gemini CLI starts through the sandbox", async () => {
    const { rt, opened } = recordingRuntime();
    const p = new GeminiAcpProvider({ sessionId: "s", initialBackingId: "s", command: process.execPath, argsPrefix: [ACP], store: {} as never, sandbox: () => rt });
    try {
      expect(await textOf(p.runTurn(turn("echo-prompt hi", tmp)))).toContain("PROMPT:");
      expect(opened).toHaveLength(1);
      expect((opened[0]?.opts as { readable: string[] }).readable).toEqual(programLocations(process.execPath, [ACP]));
    } finally {
      await p.teardown();
    }
  });

  test("Qwen: the CLI the SDK would spawn, and a launcher that starts it inside the sandbox", () => {
    const bundled = qwenCliArgv(undefined);
    expect(bundled[0]).toBe(process.execPath);
    expect(bundled[1]).toEndWith(join("dist", "cli", "cli.js"));
    expect(existsSync(bundled[1] ?? "")).toBe(true);
    expect(qwenCliArgv("/opt/qwen/cli.mjs")).toEqual([process.execPath, "/opt/qwen/cli.mjs"]);
    expect(qwenCliArgv("/opt/qwen/qwen")).toEqual(["/opt/qwen/qwen"]);
    expect(qwenExecutableOption(null, undefined, {}, "/w")).toEqual({});
    expect(qwenExecutableOption(null, "/opt/q", {}, "/w")).toEqual({ pathToQwenExecutable: "/opt/q" });
    const { rt, opened } = recordingRuntime();
    const opt = qwenExecutableOption(rt, undefined, { HOME: "/h" }, "/w");
    const script = readFileSync(opt.pathToQwenExecutable ?? "", "utf8");
    expect(script).toBe(launcherScript(["/usr/bin/bwrap", "--x", "--", ...bundled]));
    expect(statSync(opt.pathToQwenExecutable ?? "").mode & 0o777).toBe(0o700);
    expect(opened[0]?.state).toContain("/h/.qwen");
    rmSync(join(opt.pathToQwenExecutable ?? "", ".."), { recursive: true, force: true });
  });

  test("a launcher quotes every word: nothing in it is read as shell", () => {
    expect(shellQuote("it's $(x) `y` ; z")).toBe(`'it'\\''s $(x) \`y\` ; z'`);
    expect(launcherScript(["/a b", "c'd"])).toContain(`exec '/a b' 'c'\\''d' "$@"`);
  });
});

const bwrap = new BwrapSandboxProvider();
const real = await bwrap.probe();

describe.skipIf(!real.available)("inside real bubblewrap", () => {
  let root: string;
  let sbx: SessionSandbox;
  beforeAll(async () => {
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
    root = realpathSync(mkdtempSync(join(parent ?? tmpdir(), "codeoid-sbx-proc-real-")));
    for (const d of ["ws", "secrets", "pi-agent", "gemini-home/.gemini"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "secrets", "token"), "PLANTED\n");
    writeFileSync(join(root, "pi-agent", "auth.json"), "PI-LOGIN\n");
    writeFileSync(join(root, "gemini-home", ".gemini", "oauth_creds.json"), "GEMINI-LOGIN\n");
    const registry = new SandboxRegistry("linux");
    registry.register(bwrap);
    const config = { sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [join(root, "secrets")], docker: { image: "x" } } } as never;
    sbx = new SessionSandbox({ sessionId: "proc-real", workdir: join(root, "ws"), registry, config });
  });
  afterAll(async () => {
    await sbx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("pi: a planted credential is unreadable, its own agent dir isn't", async () => {
    await sbx.refresh("pi");
    expect(sbx.info).toMatchObject({ state: "on", confinement: "process" });
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    const p = makePi(sbx.runtime, join(root, "ws"));
    try {
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "secrets", "token")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "pi-agent", "auth.json")}`, join(root, "ws"))))).toBe("CONTENT:PI-LOGIN");
    } finally {
      await p.teardown();
    }
  }, 60_000);

  test("the Gemini CLI: a planted credential is unreadable, its own .gemini isn't", async () => {
    await sbx.refresh("gemini-cli");
    const prev = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = join(root, "gemini-home");
    const p = new GeminiAcpProvider({ sessionId: "s", initialBackingId: "s", command: process.execPath, argsPrefix: [ACP], store: {} as never, sandbox: () => sbx.runtime });
    try {
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "secrets", "token")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "gemini-home", ".gemini", "oauth_creds.json")}`, join(root, "ws"))))).toBe("CONTENT:GEMINI-LOGIN");
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prev;
      await p.teardown();
    }
  }, 60_000);

  test("Qwen: the real bundled CLI starts through its launcher inside bubblewrap", async () => {
    await sbx.refresh("qwen");
    const opt = qwenExecutableOption(sbx.runtime, undefined, { HOME: join(root, "home") }, join(root, "ws"));
    const r = Bun.spawnSync([opt.pathToQwenExecutable ?? "", "--version"], { cwd: join(root, "ws"), env: { PATH: process.env.PATH ?? "", HOME: join(root, "home") }, timeout: 60_000 });
    expect(r.stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 90_000);

  test("a launcher's program sees what the sandbox lets it see", async () => {
    await sbx.refresh("qwen");
    const rt = sbx.runtime as SandboxRuntime;
    const handle = await rt.open([]);
    const launcher = rt.launcher(handle, ["/bin/cat"], join(root, "ws"));
    const r = Bun.spawnSync([launcher, join(root, "secrets", "token")], { cwd: join(root, "ws"), env: { PATH: "/usr/bin:/bin" } });
    expect(r.stdout.toString()).not.toContain("PLANTED");
    expect(r.exitCode).not.toBe(0);
  });
});
