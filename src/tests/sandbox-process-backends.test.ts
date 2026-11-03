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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAcpProvider } from "../daemon/providers/acp/index.js";
import type { ProviderEvent, TurnOpts } from "../daemon/providers/interface.js";
import { PiProvider } from "../daemon/providers/pi/index.js";
import { qwenCliArgv, qwenExecutableOption } from "../daemon/providers/qwen/index.js";
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
      return { providerId: "rec", wrap: (argv: readonly string[], o: { env: Record<string, string> }) => ({ argv: [...argv], env: o.env }), close: async () => {} } as unknown as SandboxHandle;
    },
    openSync: (state: readonly string[] = [], opts?: unknown) => {
      opened.push({ state, opts });
      return { providerId: "rec", wrap: (argv: readonly string[]) => ({ argv: ["/usr/bin/bwrap", "--x", "--", ...argv], env: {} }), close: async () => {} } as unknown as SandboxHandle;
    },
    privateHome: (key: string) => mkdtempSync(join(tmpdir(), `codeoid-home-test-${key}-`)),
    stateDir: (key: string) => mkdtempSync(join(tmpdir(), `codeoid-state-test-${key}-`)),
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

/** Wait for `cond` (polled), up to `ms`. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (cond()) return;
}

function makePi(rt: SandboxRuntime | null, workdir: string): PiProvider {
  store.createSession({ id: "sess-pi", name: "pi", workdir, status: "idle", createdBy: "u", createdAt: new Date().toISOString(), attachedClients: 0, accountId: "a", projectId: "p" });
  return new PiProvider({ sessionId: "sess-pi", initialBackingId: "sess-pi", command: process.execPath, argsPrefix: [PI], store, sandbox: () => rt });
}

describe("each backend's own state, and how it is started", () => {
  test("pi starts through the sandbox in a private copy of its agent dir (#448 round 1): its login read-only, its sessions the session's own (round 2), its program and codeoid's bridge readable", async () => {
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    writeFileSync(join(tmp, "pi-agent", "auth.json"), "{}");
    writeFileSync(join(tmp, "pi-agent", "settings.json"), '{"theme":"dark"}');
    const { rt, opened } = recordingRuntime();
    const p = makePi(rt, tmp);
    try {
      expect(await textOf(p.runTurn(turn("echo-prompt hi", tmp)))).toContain("received:");
      const home = await textOf(p.runTurn(turn("echo-env:PI_CODING_AGENT_DIR", tmp)));
      expect(home).toStartWith("ENV:");
      const privateHome = home.slice("ENV:".length);
      expect(privateHome).not.toBe(join(tmp, "pi-agent"));
      expect(opened).toHaveLength(1);
      // Writable: the private home and the session's own sessions dir (its state dir); never the real agent dir or its sessions.
      const state = opened[0]?.state ?? [];
      expect(state[0]).toBe(privateHome);
      expect(state).toHaveLength(2);
      expect(state[1]).toContain("codeoid-state-test-pi-");
      expect(state[1]?.endsWith("/sessions")).toBe(true);
      for (const w of state) expect(w.startsWith(realpathSync(join(tmp, "pi-agent")))).toBe(false);
      expect(readFileSync(join(privateHome, "settings.json"), "utf8")).toBe('{"theme":"dark"}');
      const readable = (opened[0]?.opts as { readable: string[] }).readable;
      // Its login a private copy (round 2: a refresh is written back), the real file not shown at all.
      expect(readable).not.toContain(realpathSync(join(tmp, "pi-agent", "auth.json")));
      expect(lstatSync(join(privateHome, "auth.json")).isFile()).toBe(true);
      expect(readFileSync(join(privateHome, "auth.json"), "utf8")).toBe("{}");
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
      expect((opened[0]?.opts as { readable: string[] }).readable).toEqual(expect.arrayContaining(programLocations(process.execPath, [ACP])));
      // GEMINI_CLI_HOME is a private one, writable; the real one isn't among what it may write (#448 round 1).
      const home = (await textOf(p.runTurn(turn("echo-env:GEMINI_CLI_HOME", tmp)))).slice("ENV:".length);
      expect(home).toContain("codeoid-home-test-gemini-cli-");
      expect(opened[0]?.state[0]).toBe(home);
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
    expect(qwenExecutableOption(null, undefined, {})).toEqual({});
    expect(qwenExecutableOption(null, "/opt/q", {})).toEqual({ pathToQwenExecutable: "/opt/q" });
    const { rt, opened } = recordingRuntime();
    const opt = qwenExecutableOption(rt, undefined, { HOME: "/h" });
    const script = readFileSync(opt.pathToQwenExecutable ?? "", "utf8");
    expect(script).toBe(launcherScript(["/usr/bin/bwrap", "--x", "--", ...bundled]));
    expect(statSync(opt.pathToQwenExecutable ?? "").mode & 0o777).toBe(0o700);
    // A private home, pointed at by QWEN_HOME; its real one isn't writable (#448 round 1).
    expect(opt.env?.QWEN_HOME).toBeDefined();
    expect(opened[0]?.state[0]).toBe(opt.env?.QWEN_HOME ?? "missing");
    expect(opened[0]?.state).not.toContain("/h/.qwen");
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

  test("pi: a planted credential is unreadable, its own login readable through its home (a private copy), the real one not writable, its settings a private copy (#448 round 1)", async () => {
    await sbx.refresh("pi");
    expect(sbx.info).toMatchObject({ state: "on", confinement: "process" });
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    writeFileSync(join(root, "pi-agent", "settings.json"), '{"real":true}\n');
    const p = makePi(sbx.runtime, join(root, "ws"));
    try {
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "secrets", "token")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
      // The real login isn't shown (round 2): its private copy is.
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "pi-agent", "auth.json")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
      const home = (await textOf(p.runTurn(turn("echo-env:PI_CODING_AGENT_DIR", join(root, "ws"))))).slice("ENV:".length);
      expect(home).not.toBe(join(root, "pi-agent"));
      // Its login, read through its home, is a private copy (round 2: a refresh is saved there and written back,
      // below); what isn't a pi credential never reaches the real one. The real agent dir can't be written at all.
      expect(await textOf(p.runTurn(turn(`read-file:${join(home, "auth.json")}`, join(root, "ws"))))).toBe("CONTENT:PI-LOGIN");
      expect(await textOf(p.runTurn(turn(`write-file:${join(home, "auth.json")}`, join(root, "ws"))))).toBe("WROTE");
      expect(await textOf(p.runTurn(turn(`write-file:${join(root, "pi-agent", "auth.json")}`, join(root, "ws"))))).toStartWith("UNWRITABLE:");
      expect(await textOf(p.runTurn(turn(`write-file:${join(root, "pi-agent", "settings.json")}`, join(root, "ws"))))).toStartWith("UNWRITABLE:");
      expect(await textOf(p.runTurn(turn(`write-file:${join(root, "pi-agent", "extensions", "evil.ts")}`, join(root, "ws"))))).toStartWith("UNWRITABLE:");
      // Its own settings it may change: in the private copy only.
      expect(await textOf(p.runTurn(turn(`write-file:${join(home, "settings.json")}`, join(root, "ws"))))).toBe("WROTE");
    } finally {
      await p.teardown();
    }
    expect(readFileSync(join(root, "pi-agent", "settings.json"), "utf8")).toBe('{"real":true}\n');
    expect(readFileSync(join(root, "pi-agent", "auth.json"), "utf8")).toBe("PI-LOGIN\n");
    expect(existsSync(join(root, "pi-agent", "extensions", "evil.ts"))).toBe(false);
  }, 60_000);

  test("a login the backend refreshes inside (in place, or a temp file renamed over it) is written back to the real one when its process ends; only that file, only a valid one, never over a newer one (#448 round 2)", async () => {
    await sbx.refresh("pi");
    const real = join(root, "pi-agent", "auth.json");
    const before = `${JSON.stringify({ anthropic: { type: "oauth", access: "OLD", refresh: "OLD-REFRESH", expires: 0 } })}\n`;
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    for (const how of ["", "|rename"]) {
      writeFileSync(real, before, { mode: 0o600 });
      writeFileSync(join(root, "pi-agent", "settings.json"), '{"real":true}\n');
      const p = makePi(sbx.runtime, join(root, "ws"));
      try {
        const home = (await textOf(p.runTurn(turn("echo-env:PI_CODING_AGENT_DIR", join(root, "ws"))))).slice("ENV:".length);
        expect(await textOf(p.runTurn(turn(`refresh-login:${join(home, "auth.json")}${how}`, join(root, "ws"))))).toBe("REFRESHED");
        // Something else of its home changed too: never written back.
        expect(await textOf(p.runTurn(turn(`write-file:${join(home, "settings.json")}`, join(root, "ws"))))).toBe("WROTE");
        // Not yet: the process still runs.
        expect(readFileSync(real, "utf8")).toBe(before);
      } finally {
        await p.teardown();
      }
      await until(() => readFileSync(real, "utf8").includes("ROTATED-REFRESH"));
      expect(JSON.parse(readFileSync(real, "utf8")).anthropic.refresh).toBe("ROTATED-REFRESH");
      expect(statSync(real).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, "pi-agent", "settings.json"), "utf8")).toBe('{"real":true}\n');
    }
    // What isn't a pi credential, or would overwrite a refresh saved meanwhile, isn't written back.
    writeFileSync(real, before, { mode: 0o600 });
    const p = makePi(sbx.runtime, join(root, "ws"));
    try {
      const home = (await textOf(p.runTurn(turn("echo-env:PI_CODING_AGENT_DIR", join(root, "ws"))))).slice("ENV:".length);
      expect(await textOf(p.runTurn(turn(`write-file:${join(home, "auth.json")}`, join(root, "ws"))))).toBe("WROTE");
    } finally {
      await p.teardown();
    }
    await Bun.sleep(300);
    expect(readFileSync(real, "utf8")).toBe(before);
    const p2 = makePi(sbx.runtime, join(root, "ws"));
    try {
      const home = (await textOf(p2.runTurn(turn("echo-env:PI_CODING_AGENT_DIR", join(root, "ws"))))).slice("ENV:".length);
      expect(await textOf(p2.runTurn(turn(`refresh-login:${join(home, "auth.json")}`, join(root, "ws"))))).toBe("REFRESHED");
      // The user's own pi refreshed it meanwhile.
      writeFileSync(real, `${JSON.stringify({ anthropic: { type: "oauth", access: "USER", refresh: "USER-REFRESH", expires: 2 } })}\n`);
    } finally {
      await p2.teardown();
    }
    await Bun.sleep(300);
    expect(readFileSync(real, "utf8")).toContain("USER-REFRESH");
  }, 120_000);

  test("the Gemini CLI: a planted credential is unreadable, its own .gemini isn't", async () => {
    await sbx.refresh("gemini-cli");
    const prev = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = join(root, "gemini-home");
    const p = new GeminiAcpProvider({ sessionId: "s", initialBackingId: "s", command: process.execPath, argsPrefix: [ACP], store: {} as never, sandbox: () => sbx.runtime });
    try {
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "secrets", "token")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
      // Its login through its own home (a private copy, round 2); the real file isn't shown.
      const gemini = (await textOf(p.runTurn(turn("echo-env:GEMINI_CLI_HOME", join(root, "ws"))))).slice("ENV:".length);
      expect(await textOf(p.runTurn(turn(`read-file:${join(gemini, ".gemini", "oauth_creds.json")}`, join(root, "ws"))))).toBe("CONTENT:GEMINI-LOGIN");
      expect(await textOf(p.runTurn(turn(`read-file:${join(root, "gemini-home", ".gemini", "oauth_creds.json")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
      // Its real settings can't be written (a hook or an extension planted there would run in the user's own gemini).
      expect(await textOf(p.runTurn(turn(`write-file:${join(root, "gemini-home", ".gemini", "settings.json")}`, join(root, "ws"))))).toStartWith("UNWRITABLE:");
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prev;
      await p.teardown();
    }
  }, 60_000);

  test("conversations are the session's own (#448 round 2): the real dirs (another project's transcript, the Gemini CLI's checkpoint repository) are unreadable, what is written lands in the session's state, which outlives a restart and goes with the session", async () => {
    mkdirSync(join(root, "pi-agent", "sessions", "--other-project--"), { recursive: true });
    writeFileSync(join(root, "pi-agent", "sessions", "--other-project--", "s.jsonl"), "PI-OTHER-PROJECT-SECRET\n");
    const realHistory = join(root, "gemini-home", ".gemini", "history", "proj", ".git");
    mkdirSync(realHistory, { recursive: true });
    writeFileSync(join(realHistory, "config"), "[core]\n");
    const registry = new SandboxRegistry("linux");
    registry.register(bwrap);
    const config = { transcriptDir: join(root, "transcripts"), sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [], docker: { image: "x" } } } as never;
    const own = new SessionSandbox({ sessionId: "conv-own", workdir: join(root, "ws"), registry, config });
    const prevPi = process.env.PI_CODING_AGENT_DIR;
    const prevGemini = process.env.GEMINI_CLI_HOME;
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    process.env.GEMINI_CLI_HOME = join(root, "gemini-home");
    try {
      await own.refresh("pi");
      const p = makePi(own.runtime, join(root, "ws"));
      try {
        expect(await textOf(p.runTurn(turn(`read-file:${join(root, "pi-agent", "sessions", "--other-project--", "s.jsonl")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
        const home = (await textOf(p.runTurn(turn("echo-env:PI_CODING_AGENT_DIR", join(root, "ws"))))).slice("ENV:".length);
        expect(await textOf(p.runTurn(turn(`read-file:${join(home, "sessions", "--other-project--", "s.jsonl")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
        expect(await textOf(p.runTurn(turn(`write-file:${join(home, "sessions", "mine.jsonl")}`, join(root, "ws"))))).toBe("WROTE");
      } finally {
        await p.teardown();
      }
      const piState = join(root, "transcripts", "sandbox-state", "conv-own", "pi", "sessions");
      expect(existsSync(join(piState, "mine.jsonl"))).toBe(true);
      expect(existsSync(join(root, "pi-agent", "sessions", "mine.jsonl"))).toBe(false);

      await own.refresh("gemini-cli");
      const g = new GeminiAcpProvider({ sessionId: "conv-own", initialBackingId: "conv-own", command: process.execPath, argsPrefix: [ACP], store: {} as never, sandbox: () => own.runtime });
      try {
        expect(await textOf(g.runTurn(turn(`read-file:${join(realHistory, "config")}`, join(root, "ws"))))).toStartWith("UNREADABLE:");
        const gemini = (await textOf(g.runTurn(turn("echo-env:GEMINI_CLI_HOME", join(root, "ws"))))).slice("ENV:".length);
        // Its checkpoint repository is the session's own: what a command writes there runs in nothing else.
        expect(await textOf(g.runTurn(turn(`write-file:${join(gemini, ".gemini", "history", "proj", "config")}`, join(root, "ws"))))).toBe("WROTE");
        expect(await textOf(g.runTurn(turn(`write-file:${join(gemini, ".gemini", "tmp", "bin", "rg")}`, join(root, "ws"))))).toBe("WROTE");
      } finally {
        await g.teardown();
      }
      expect(readFileSync(join(realHistory, "config"), "utf8")).toBe("[core]\n");
      expect(existsSync(join(root, "gemini-home", ".gemini", "tmp", "bin", "rg"))).toBe(false);

      // A restart (a new provider): the session's own conversations are there again.
      await own.refresh("pi");
      const again = makePi(own.runtime, join(root, "ws"));
      try {
        const home = (await textOf(again.runTurn(turn("echo-env:PI_CODING_AGENT_DIR", join(root, "ws"))))).slice("ENV:".length);
        expect(await textOf(again.runTurn(turn(`read-file:${join(home, "sessions", "mine.jsonl")}`, join(root, "ws"))))).toStartWith("CONTENT:");
      } finally {
        await again.teardown();
      }
    } finally {
      process.env.PI_CODING_AGENT_DIR = prevPi;
      if (prevGemini === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prevGemini;
      await own.close();
    }
    // Destroyed: its state goes with it.
    own.removeState();
    expect(existsSync(join(root, "transcripts", "sandbox-state", "conv-own"))).toBe(false);
  }, 120_000);

  test("Qwen: the real bundled CLI starts through its launcher inside bubblewrap", async () => {
    await sbx.refresh("qwen");
    const opt = qwenExecutableOption(sbx.runtime, undefined, { HOME: join(root, "home") });
    const r = Bun.spawnSync([opt.pathToQwenExecutable ?? "", "--version"], { cwd: join(root, "ws"), env: { PATH: process.env.PATH ?? "", HOME: join(root, "home") }, timeout: 60_000 });
    expect(r.stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 90_000);

  test("a launcher's program sees what the sandbox lets it see", async () => {
    await sbx.refresh("qwen");
    const rt = sbx.runtime as SandboxRuntime;
    const handle = await rt.open([]);
    const launcher = rt.launcher(handle, ["/bin/cat"]);
    const r = Bun.spawnSync([launcher, join(root, "secrets", "token")], { cwd: join(root, "ws"), env: { PATH: "/usr/bin:/bin" } });
    expect(r.stdout.toString()).not.toContain("PLANTED");
    expect(r.exitCode).not.toBe(0);
  });
});
