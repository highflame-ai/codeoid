/**
 * Release gate tier 1 (docs/release-gate.md): the package users install works.
 *
 * Packs the three npm packages from this checkout, installs the tarballs the
 * way a user does (with npm, and with bun), and runs the INSTALLED `codeoid`:
 * its version, a daemon on a throwaway config dir, /health, the web UI, a
 * session that answers over the scripted backend (no model, no network), the
 * CLI against it, and a clean shutdown. Also checks what the CLI package
 * ships: no tests, no source maps, no env files.
 *
 *   bun scripts/check-artifact.ts [--installer npm|bun|both]   (default both)
 *
 * Needs web/dist built (bun run build:web). Exits non-zero on any failure.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PKGS = [
  { name: "@highflame/codeoid-protocol", dir: join(ROOT, "packages", "protocol") },
  { name: "@highflame/codeoid-core", dir: join(ROOT, "packages", "core") },
  { name: "@highflame/codeoid", dir: ROOT },
];
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const arg = process.argv.indexOf("--installer");
const INSTALLERS = (arg > 0 ? process.argv[arg + 1] : "both") === "both" ? ["npm", "bun"] : [process.argv[arg + 1] as string];

const failures: string[] = [];
const ok = (msg: string) => console.log(`✓ ${msg}`);
const fail = (msg: string) => {
  failures.push(msg);
  console.error(`✗ ${msg}`);
};

/** What `npm pack` would put in each tarball must not include tests, maps or env files. */
function checkContents(): void {
  for (const p of PKGS) {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: p.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]?.files.map((f) => f.path) ?? [];
    const bad = files.filter((f) => /(^|\/)tests?\/|\.test\.tsx?$|\.map$|(^|\/)\.env(\.|$)|\.pem$|(^|\/)id_[a-z0-9]+$/.test(f));
    if (bad.length > 0) fail(`${p.name} would ship ${bad.length} file(s) it shouldn't: ${bad.slice(0, 5).join(", ")}`);
    else ok(`${p.name}: ${files.length} files, none of them tests, maps or secrets`);
    if (p.dir === ROOT && !files.some((f) => f.startsWith("web/dist/") && f.endsWith("index.html"))) fail(`${p.name} would ship without the web UI (web/dist): run bun run build:web first`);
  }
}

/** Pack every package; returns the tarball paths by package name. */
function pack(into: string): Map<string, string> {
  const tarballs = new Map<string, string>();
  mkdirSync(into, { recursive: true });
  for (const p of PKGS) {
    const out = execFileSync("npm", ["pack", "--json", "--pack-destination", into], { cwd: p.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const file = (JSON.parse(out) as Array<{ filename: string }>)[0]?.filename;
    if (!file) throw new Error(`npm pack produced nothing for ${p.name}`);
    tarballs.set(p.name, join(into, file));
  }
  return tarballs;
}

/** A project that depends on the CLI tarball, with the two libraries pinned to their tarballs too (they may not be on npm yet). */
function install(installer: string, dir: string, tarballs: Map<string, string>): string {
  mkdirSync(dir, { recursive: true });
  const file = (name: string) => `file:${tarballs.get(name)}`;
  const pins = { "@highflame/codeoid-protocol": file("@highflame/codeoid-protocol"), "@highflame/codeoid-core": file("@highflame/codeoid-core") };
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "codeoid-artifact-check", private: true, dependencies: { "@highflame/codeoid": file("@highflame/codeoid") }, overrides: pins, resolutions: pins }),
  );
  const cmd = installer === "npm" ? ["npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]] : ["bun", ["install"]];
  execFileSync(cmd[0] as string, cmd[1] as string[], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  return join(dir, "node_modules", ".bin", "codeoid");
}

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

/** Boot the installed CLI's daemon and use it the way a user does. */
async function exercise(installer: string, bin: string, scratch: string): Promise<void> {
  const tag = `[${installer}]`;
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  if (version === VERSION) ok(`${tag} installed codeoid --version is ${version}`);
  else fail(`${tag} installed codeoid --version is "${version}", the package is ${VERSION}`);

  const home = join(scratch, "home");
  const config = join(scratch, "config");
  const work = join(scratch, "work");
  const script = join(scratch, "script.json");
  for (const d of [home, join(config, "codeoid"), work]) mkdirSync(d, { recursive: true });
  writeFileSync(
    join(config, "codeoid", "config.json"),
    JSON.stringify({
      session: { defaultProvider: "scripted" },
      memory: { enabled: false },
      workspaceIndex: { enabled: false },
      providers: { pi: { enabled: false }, codex: { enabled: false }, geminiCli: { enabled: false }, qwen: { enabled: false }, opencode: { enabled: false } },
    }),
  );
  writeFileSync(script, JSON.stringify({ rules: [{ match: "^ping", steps: [{ text: "pong from the installed package" }] }] }));
  execFileSync("git", ["init", "-q"], { cwd: work });
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    TMPDIR: tmpdir(),
    HOME: home,
    XDG_CONFIG_HOME: config,
    CODEOID_E2E_SCRIPT: script,
    CODEOID_LOCAL_TOKEN: `artifact-check-${port}`,
    CODEOID_DAEMON_URL: `ws://127.0.0.1:${port}`,
  };
  let log = "";
  const daemon = spawn(bin, ["start", "--local", "--port", String(port), "--host", "127.0.0.1", "--no-telegram"], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  daemon.stderr?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  const exited = new Promise<number | null>((done) => daemon.once("exit", (code) => done(code)));
  const cli = (...args: string[]) => execFileSync(bin, args, { cwd: scratch, env, encoding: "utf8", timeout: 60_000 });
  try {
    const started = Date.now();
    for (;;) {
      if (daemon.exitCode !== null) throw new Error(`daemon exited (${daemon.exitCode}) before it was ready`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch {
        /* not yet */
      }
      if (Date.now() - started > 60_000) throw new Error("daemon not ready after 60s");
      await Bun.sleep(200);
    }
    ok(`${tag} daemon ready in ${Date.now() - started} ms`);
    const ui = await fetch(`http://127.0.0.1:${port}/ui/`);
    const html = await ui.text();
    if (ui.ok && html.includes("<script")) ok(`${tag} web UI served`);
    else fail(`${tag} web UI not served (HTTP ${ui.status})`);

    cli("new", "artifact", work);
    cli("send", "artifact", "ping");
    const transcripts = join(config, "codeoid", "transcripts");
    let replied = false;
    for (let i = 0; i < 100 && !replied; i++) {
      await Bun.sleep(200);
      try {
        replied = readdirSync(transcripts).some((f) => f.endsWith(".jsonl") && readFileSync(join(transcripts, f), "utf8").includes("pong from the installed package"));
      } catch {
        /* not written yet */
      }
    }
    if (replied) ok(`${tag} a session answered`);
    else fail(`${tag} the session never answered`);
    if (cli("ls").includes("artifact")) ok(`${tag} codeoid ls lists it`);
    else fail(`${tag} codeoid ls doesn't list the session`);
    if (cli("settings", "ls", "session").includes("session.defaultProvider")) ok(`${tag} codeoid settings works`);
    else fail(`${tag} codeoid settings ls didn't list session settings`);
  } catch (err) {
    fail(`${tag} ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    daemon.kill("SIGTERM");
    const timer = setTimeout(() => daemon.kill("SIGKILL"), 35_000);
    const code = await exited;
    clearTimeout(timer);
    if (code === 0) ok(`${tag} clean shutdown`);
    else fail(`${tag} shutdown exited ${code}`);
    if (failures.some((f) => f.startsWith(tag))) console.error(`${tag} daemon log:\n${log.split("\n").slice(-40).join("\n")}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "codeoid-artifact-"));
try {
  checkContents();
  const tarballs = pack(join(scratch, "tarballs"));
  ok(`packed ${[...tarballs.values()].map((t) => t.split("/").at(-1)).join(", ")}`);
  for (const installer of INSTALLERS) {
    const dir = join(scratch, installer);
    try {
      const bin = install(installer, join(dir, "project"), tarballs);
      ok(`[${installer}] installed`);
      await exercise(installer, bin, dir);
    } catch (err) {
      fail(`[${installer}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nThe ${VERSION} package installs and works.`);
