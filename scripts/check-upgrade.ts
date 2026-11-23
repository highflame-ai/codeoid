/**
 * Release gate tier 1 (docs/release-gate.md): a previous release's data opens
 * in this build.
 *
 * Installs a published release from npm (default: the npm `latest`), runs its
 * daemon on a throwaway data dir with the Claude backend pointed at aimock (a
 * local stand-in for the Anthropic API: no key, no spend), and records real
 * conversations: one that states a fact, one that reads a file through a tool
 * call. Then this checkout's daemon starts on the same data and
 * must list both sessions, answer in each, and hand the backend each session's
 * whole history (read from aimock's request journal, not from a model's
 * memory); a second restart must be clean too.
 *
 *   bun scripts/check-upgrade.ts [--from <version>]
 *
 * Needs network for `npm install` of the old release. Exits non-zero on failure.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";

const ROOT = join(import.meta.dir, "..");
const argFrom = process.argv.indexOf("--from");
const FROM = argFrom > 0 ? (process.argv[argFrom + 1] as string) : execFileSync("npm", ["view", "@highflame/codeoid", "version"], { encoding: "utf8" }).trim();
const CODEWORD = "HELIOTROPE";

const failures: string[] = [];
const ok = (msg: string) => console.log(`✓ ${msg}`);
const fail = (msg: string) => {
  failures.push(msg);
  console.error(`✗ ${msg}`);
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

/** Every .jsonl under `dir`, concatenated (where a daemon keeps its transcripts varies by version). */
function transcriptText(dir: string): string {
  let out = "";
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (n !== "node_modules" && n !== "checkpoints") walk(p);
      } else if (n.endsWith(".jsonl")) out += readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

async function until(what: string, cond: () => boolean, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(250);
  }
  fail(`timed out waiting for ${what}`);
  return false;
}

const scratch = mkdtempSync(join(tmpdir(), "codeoid-upgrade-"));
const home = join(scratch, "home");
const config = join(scratch, "config");
const work = join(scratch, "work");
for (const d of [home, join(config, "codeoid"), work]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: work });
writeFileSync(join(work, "README.md"), "UPGRADE-README-MARKER\n");

const mock = new LLMock({ port: 0 });
mock.addFixturesFromJSON([
  { match: { userMessage: "remember the codeword" }, response: { content: `Noted: the codeword is ${CODEWORD}.` } },
  { match: { userMessage: "read the readme", hasToolResult: false }, response: { toolCalls: [{ name: "Read", arguments: JSON.stringify({ file_path: join(work, "README.md") }) }] } },
  { match: { userMessage: "read the readme", hasToolResult: true }, response: { content: "Read README.md." } },
  { match: { userMessage: "after the upgrade" }, response: { content: "Still here after the upgrade." } },
  // Anything else the CLI asks on its own (a title, a summary): a short answer, never a miss.
  { match: {}, response: { content: "ok" } },
] as never);
const mockUrl = await mock.start();

const port = await freePort();
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  TMPDIR: tmpdir(),
  HOME: home,
  XDG_CONFIG_HOME: config,
  ANTHROPIC_BASE_URL: mockUrl,
  ANTHROPIC_API_KEY: "aimock-not-a-key",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  CODEOID_LOCAL_TOKEN: `upgrade-check-${port}`,
  CODEOID_DAEMON_URL: `ws://127.0.0.1:${port}`,
};
writeFileSync(
  join(config, "codeoid", "config.json"),
  JSON.stringify({ session: { defaultProvider: "claude" }, memory: { enabled: false }, providers: { pi: { enabled: false }, codex: { enabled: false }, geminiCli: { enabled: false }, qwen: { enabled: false } } }),
);

let daemon: ChildProcess | null = null;
let log = "";
async function start(label: string, argv: string[]): Promise<void> {
  const from = log.length;
  log += `\n----- ${label} -----\n`;
  const child = spawn(argv[0] as string, [...argv.slice(1), "start", "--local", "--port", String(port), "--host", "127.0.0.1", "--no-telegram"], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
  daemon = child;
  child.stdout?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  const end = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${label} exited (${child.exitCode}) before it was ready:${log.slice(from)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`${label} not ready after 120s`);
    await Bun.sleep(200);
  }
  ok(`${label} ready`);
}
async function stop(label: string): Promise<void> {
  const child = daemon;
  daemon = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<number | null>((done) => child.once("exit", (c) => done(c)));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  const code = await exited;
  clearTimeout(timer);
  if (code === 0) ok(`${label} stopped cleanly`);
  else fail(`${label} exited ${code} on SIGTERM`);
}
const cli = (argv: string[], ...args: string[]) => execFileSync(argv[0] as string, [...argv.slice(1), ...args], { cwd: scratch, env, encoding: "utf8", timeout: 60_000 });

/** The body of the newest request to aimock carrying `text`, as JSON text. */
const requestWith = (text: string): string | undefined =>
  mock
    .getRequests()
    .map((r) => JSON.stringify(r.body ?? ""))
    .filter((b) => b.includes(text))
    .at(-1);

try {
  // ── The old release records real conversations ─────────────────────────────
  const oldDir = join(scratch, "old");
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "package.json"), JSON.stringify({ name: "old", private: true }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", `@highflame/codeoid@${FROM}`], { cwd: oldDir, stdio: ["ignore", "ignore", "inherit"] });
  const OLD = [join(oldDir, "node_modules", ".bin", "codeoid")];
  ok(`installed @highflame/codeoid@${FROM} from npm`);
  await start(`${FROM} daemon`, OLD);
  cli(OLD, "new", "facts", work);
  cli(OLD, "send", "facts", "remember the codeword");
  await until(`${FROM} to answer in "facts"`, () => transcriptText(scratch).includes(`the codeword is ${CODEWORD}`));
  // A read needs no approval (0.4.4's `codeoid approve` can't answer one: it sends an empty id).
  cli(OLD, "new", "tools", work);
  cli(OLD, "send", "tools", "read the readme");
  if (!(await until(`${FROM} to finish the "tools" turn`, () => transcriptText(scratch).includes("Read README.md.")))) throw new Error(`${FROM} couldn't record its sessions`);
  ok(`${FROM} recorded two sessions (a fact; a tool round)`);
  await stop(`${FROM} daemon`);

  // ── This build opens the same data ─────────────────────────────────────────
  const NEW = ["bun", join(ROOT, "src", "cli.ts")];
  await start("this build", NEW);
  const listed = cli(NEW, "ls");
  for (const s of ["facts", "tools"]) {
    if (listed.includes(s)) ok(`this build lists "${s}"`);
    else fail(`this build doesn't list "${s}":\n${listed}`);
  }

  for (const [session, history] of [
    ["facts", `the codeword is ${CODEWORD}`],
    ["tools", "UPGRADE-README-MARKER"],
  ] as const) {
    const before = mock.getRequests().length;
    cli(NEW, "send", session, `after the upgrade (${session})`);
    if (!(await until(`"${session}" to answer after the upgrade`, () => mock.getRequests().length > before && transcriptText(scratch).split("Still here after the upgrade.").length > (session === "facts" ? 1 : 2)))) continue;
    const body = requestWith(`after the upgrade (${session})`);
    if (body?.includes(history)) ok(`"${session}" answered, and the backend was handed its history ("${history}")`);
    else fail(`"${session}" answered, but its history ("${history}") didn't reach the backend`);
  }
  await stop("this build");
  await start("this build, again", NEW);
  const again = cli(NEW, "ls");
  if (again.includes("facts") && again.includes("tools")) ok("a second restart lists both sessions");
  else fail(`a second restart lost a session:\n${again}`);
  await stop("this build, again");
  const errors = log.split("\n").filter((l) => /\b(failed to (resume|load)|migration (failed|error)|unhandled|TypeError|SyntaxError)\b/i.test(l));
  if (errors.length === 0) ok("no resume, migration or unhandled errors in the logs");
  else fail(`errors in the logs:\n${errors.slice(0, 10).join("\n")}`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  if (daemon) await stop("daemon");
  await mock.stop();
  if (failures.length > 0) console.error(`\ndaemon logs (last 60 lines):\n${log.split("\n").slice(-60).join("\n")}`);
  rmSync(scratch, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nData written by ${FROM} opens in this build.`);
