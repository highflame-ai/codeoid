/**
 * The end-to-end harness (#429): boots a real codeoid daemon from source on a
 * throwaway home, config dir and port, in local mode, with the scripted
 * backend as the default. Tests drive it through the web UI (Playwright's
 * `page`) and the CLI (`codeoid.cli(...)`).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import type { ScriptRule } from "../src/daemon/providers/scripted/index.js";

export type { ScriptRule };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.ts");

if (!existsSync(join(ROOT, "web", "dist", "index.html"))) {
  throw new Error("web/dist is missing: run `bun run build:web` before the end-to-end suite");
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("no port"))));
    });
  });
}

export interface CliResult {
  code: number | null;
  output: string;
}

export class Codeoid {
  readonly root: string;
  readonly home: string;
  readonly configDir: string;
  /** A git repo with one commit: where sessions run unless a test says otherwise. */
  readonly workdir: string;
  readonly scriptPath: string;
  readonly port: number;
  /** Pinned, so an open page keeps working across a daemon restart. */
  readonly token = `codeoid_local_${randomBytes(32).toString("base64url")}`;
  #daemon: ChildProcess | null = null;
  #log = "";

  private constructor(root: string, port: number) {
    this.root = root;
    this.port = port;
    this.home = join(root, "home");
    this.configDir = join(root, "config");
    this.workdir = join(root, "work");
    this.scriptPath = join(root, "script.json");
  }

  static async create(rules: ScriptRule[] = []): Promise<Codeoid> {
    const c = new Codeoid(mkdtempSync(join(tmpdir(), "codeoid-e2e-")), await freePort());
    mkdirSync(c.home, { recursive: true });
    mkdirSync(join(c.configDir, "codeoid"), { recursive: true });
    // Only the scripted backend, and nothing that reaches the network or a model.
    writeFileSync(
      join(c.configDir, "codeoid", "config.json"),
      JSON.stringify({
        session: { defaultProvider: "scripted" },
        memory: { enabled: false },
        workspaceIndex: { enabled: false },
        providers: { pi: { enabled: false }, codex: { enabled: false }, geminiCli: { enabled: false }, qwen: { enabled: false } },
        // Priced like a real model, so a turn with no reported cost is estimated (#430).
        pricing: { models: { "scripted-model": { input: 1, output: 2 } } },
      }),
    );
    c.initRepo(c.workdir);
    c.setScript(rules);
    try {
      await c.start();
    } catch (err) {
      // The fixture never gets an object to dispose: clean up here.
      await c.dispose();
      throw err;
    }
    return c;
  }

  /** A git repo with one committed file. */
  initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# e2e workspace\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=e2e@codeoid.test", "-c", "user.name=e2e", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
  }

  /** Replace the scripted backend's rules; read again on every turn. */
  setScript(rules: ScriptRule[]): void {
    writeFileSync(this.scriptPath, JSON.stringify({ rules }));
  }

  get uiUrl(): string {
    return `http://127.0.0.1:${this.port}/ui/`;
  }

  get log(): string {
    return this.#log;
  }

  #env(): NodeJS.ProcessEnv {
    // A clean environment: no model keys, no real home, no real config.
    return {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TMPDIR: tmpdir(),
      HOME: this.home,
      XDG_CONFIG_HOME: this.configDir,
      CODEOID_E2E_SCRIPT: this.scriptPath,
      CODEOID_LOCAL_TOKEN: this.token,
      CODEOID_DAEMON_URL: `ws://127.0.0.1:${this.port}`,
    };
  }

  /** Start the daemon; resolves once it answers /health. */
  async start(): Promise<void> {
    if (this.#daemon) throw new Error("daemon already running");
    const child = spawn("bun", [CLI, "start", "--local", "--port", String(this.port), "--host", "127.0.0.1", "--no-telegram"], {
      cwd: ROOT,
      env: this.#env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#daemon = child;
    const from = this.#log.length;
    const onData = (chunk: Buffer) => {
      this.#log += chunk.toString();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Ready means THIS process bound the port (its own "listening" line, printed
    // after the bind — not one left by the previous boot) and it answers there.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.#daemon = null;
        throw new Error(`daemon exited (${child.exitCode ?? child.signalCode}) before it was ready:\n${this.#log}`);
      }
      if (this.#log.slice(from).includes("daemon listening on")) {
        try {
          const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1_000) });
          if (res.ok) return;
        } catch {
          // Bound, not answering yet.
        }
      }
      if (Date.now() > deadline) {
        // Hung at boot: no grace period, so the error (and log) lands inside the test's timeout.
        await this.stop({ force: true });
        throw new Error(`daemon not ready after 30s:\n${this.#log}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Stop the daemon the way an operator does (SIGTERM; SIGKILL with `force`), and wait for it to exit. */
  async stop(opts: { force?: boolean } = {}): Promise<void> {
    const child = this.#daemon;
    if (!child) return;
    this.#daemon = null;
    // Already gone, by exiting or by a signal (an OOM kill, a crash).
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill(opts.force ? "SIGKILL" : "SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 35_000);
    await exited;
    clearTimeout(timer);
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#log += "\n----- restart -----\n";
    await this.start();
  }

  /** Run a CLI command against this daemon. */
  async cli(...args: string[]): Promise<CliResult> {
    const child = spawn("bun", [CLI, ...args], { cwd: ROOT, env: this.#env(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const code = await new Promise<number | null>((done) => child.once("exit", done));
    return { code, output };
  }

  /** Like `cli`, but fails the test on a non-zero exit. */
  async cliOk(...args: string[]): Promise<string> {
    const r = await this.cli(...args);
    if (r.code !== 0) throw new Error(`codeoid ${args.join(" ")} exited ${r.code}:\n${r.output}`);
    return r.output;
  }

  /** A path for a `waitFor` step; `release(path)` lets the held turn go on. */
  gate(name: string): string {
    return join(this.root, `gate-${name}`);
  }

  release(gatePath: string): void {
    writeFileSync(gatePath, "");
  }

  readFile(rel: string): string {
    return readFileSync(join(this.workdir, rel), "utf8");
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Open the web UI on `codeoid` and wait until it's connected. */
export async function openUi(page: Page, codeoid: Codeoid): Promise<void> {
  await page.goto(codeoid.uiUrl);
  await expect(page.getByText("live", { exact: true })).toBeVisible();
}

/** Create a session through the web UI's dialog and leave it focused. */
export async function createSessionInUi(page: Page, name: string, workdir: string): Promise<void> {
  await page.getByRole("button", { name: /new session/ }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.getByRole("textbox", { name: /^Workdir/ }).fill(workdir);
  await page.getByRole("button", { name: "create", exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
}

/** Select a session in the sidebar. */
export async function focusSession(page: Page, name: string): Promise<void> {
  await page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) }).getByRole("button").first().click();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
}

/** Switch the focused session's mode through the mode menu. */
export async function setMode(page: Page, mode: "guarded" | "autonomous" | "interactive"): Promise<void> {
  await page.getByRole("button", { name: /^mode / }).click();
  await page.getByRole("button", { name: new RegExp(`^${mode}`) }).click();
  await expect(page.getByRole("button", { name: /^mode / })).toContainText(mode);
}

export function composer(page: Page) {
  return page.getByRole("textbox", { name: /^Message/ });
}

export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** The transcript's messages. */
export function messages(page: Page) {
  return page.getByRole("main").getByRole("article");
}

/** Wait until the focused session is idle (its interrupt button is disabled). */
export async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /interrupt/ })).toBeDisabled();
}

/** Attach the daemon's log to a failing test. */
async function attachLog(codeoid: Codeoid, testInfo: TestInfo): Promise<void> {
  if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach("daemon.log", { body: codeoid.log, contentType: "text/plain" });
}

export const test = base.extend<{ codeoid: Codeoid }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this destructuring; this one has none.
  codeoid: async ({}, use, testInfo) => {
    const codeoid = await Codeoid.create();
    await use(codeoid);
    await attachLog(codeoid, testInfo);
    await codeoid.dispose();
  },
});

export { expect };
