/**
 * The git a backend CLI runs for itself (#448 round 4, git-shim.ts). A
 * sandboxed command can make a repository in the workspace whose config
 * names a program (a filter driver, fsmonitor, a diff textconv); the
 * Claude CLI's `git status` at its next start, and opencode's server, would
 * run it on the host. The shim runs that git inside the session's sandbox
 * (read-only, offline), or with every program-running key turned off.
 *
 * The planted programs only append to a marker file in this test's scratch
 * dir: its presence is what a failure looks like. Everything else they do
 * is `cat` (a filter that changes nothing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_BIN } from "../daemon/git-env.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { claudeNativeEnv } from "../daemon/sandbox/claude-native.js";
import { EMPTY_TREE, gitShimScript, gitShimSpec, pathWithShim, writeGitShim } from "../daemon/sandbox/git-shim.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { sandboxRoot } from "../daemon/sandbox/root.js";
import { SessionSandbox } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxSpec } from "../daemon/sandbox/types.js";

const bwrap = new BwrapSandboxProvider();
const bwrapProbe = await bwrap.probe();

/** Not under the host's /tmp, which a bwrap sandbox replaces with its own. */
function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      rmSync(mkdtempSync(join(dir, "codeoid-probe-")), { recursive: true, force: true });
      return dir;
    } catch {
      /* next */
    }
  }
  return tmpdir();
}

let root: string;
let home: string;
let outside: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-git-shim-")));
  home = join(root, "home");
  outside = join(root, "outside");
  for (const d of [home, outside]) mkdirSync(d, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** git as a test (never the shim) sets a repository up: no system or user config. */
function setup(cwd: string, args: string[]): void {
  const r = Bun.spawnSync([GIT_BIN, "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/**
 * A workspace a sandboxed command made a repository in: a filter driver and
 * fsmonitor in its config, a textconv applied by `info/attributes` (which an
 * empty `attr.tree` doesn't cover), each a script that appends to `mark` and
 * passes its input through. `a.txt` is stat-dirty, so `git status` cleans it.
 */
function plant(name: string): { ws: string; mark: string; inside: string } {
  const ws = join(root, name);
  mkdirSync(ws, { recursive: true });
  const mark = join(outside, `MARK-${name}`);
  const inside = join(ws, "WROTE-INSIDE");
  const script = join(ws, "f.sh");
  writeFileSync(script, `#!/bin/sh\n{ echo ran >> '${mark}'; } 2>/dev/null\ntouch '${inside}' 2>/dev/null\ncat "$@"\n`);
  chmodSync(script, 0o755);
  setup(ws, ["init", "-q", "."]);
  setup(ws, ["config", "filter.x.clean", script]);
  setup(ws, ["config", "filter.x.smudge", script]);
  setup(ws, ["config", "diff.y.textconv", script]);
  setup(ws, ["config", "core.fsmonitor", script]);
  writeFileSync(join(ws, ".gitattributes"), "a.txt filter=x\n");
  writeFileSync(join(ws, ".git", "info", "attributes"), "b.txt diff=y\n");
  writeFileSync(join(ws, "a.txt"), "a\n");
  writeFileSync(join(ws, "b.txt"), "b\n");
  // Staged with the drivers off: setting the repository up runs nothing.
  setup(ws, ["-c", "filter.x.clean=", "-c", "filter.x.smudge=", "-c", "core.fsmonitor=", "add", "a.txt", "b.txt", ".gitattributes"]);
  setup(ws, ["-c", "filter.x.clean=", "-c", "core.fsmonitor=", "commit", "-qm", "init"]);
  writeFileSync(join(ws, "b.txt"), "b2\n");
  Bun.spawnSync(["touch", "-d", "2001-01-01", join(ws, "a.txt")]);
  return { ws, mark, inside };
}

/** Run `<dir>/git args` as a CLI would: its own PATH (the shim first), its own `-c` list in `GIT_CONFIG_COUNT`. */
function runShim(dir: string, args: string[], cwd: string, opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync([join(dir, "git"), ...args], {
    cwd,
    env: { PATH: pathWithShim(dir, process.env.PATH), HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...opts.env },
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const STATUS = ["--no-optional-locks", "status", "--short", "--ignore-submodules=dirty"];
/** What it says of a planted workspace: `a.txt` (stat-dirty, its filter a pass-through or off) unchanged. */
const STATUS_OUT = " M b.txt\n?? f.sh\n";

describe("git shim: the script", () => {
  test("the spec its git runs under: every writable location read-only, nothing pinned, no network", () => {
    const spec: SandboxSpec = {
      sessionId: "s",
      workspace: "/w",
      tempDir: "/t",
      writable: ["/g/.git"],
      hidden: ["/home/u"],
      reexposed: [],
      readOnly: ["/w/.claude"],
      pinned: ["/w/p"],
      containerSockets: [],
      network: { mode: "on" },
      unsetEnv: [],
    };
    const s = gitShimSpec(spec);
    expect(s.readOnly).toEqual(["/w/.claude", "/w", "/g/.git"]);
    expect(s.pinned).toEqual([]);
    expect(s.network).toEqual({ mode: "off" });
    expect(s.hidden).toEqual(["/home/u"]);
  });

  test("with a launcher it execs it when the launcher and its provider are there; every program-running key is turned off on the other path", () => {
    const script = gitShimScript({ git: "/usr/bin/git", launcher: "/p/launch-git", provider: "/usr/bin/bwrap", caller: "the Claude CLI" });
    expect(script).toContain(`if [ -f '/p/launch-git' ] && [ -x '/p/launch-git' ] && [ -x '/usr/bin/bwrap' ]; then exec '/p/launch-git' "$@"; fi`);
    for (const k of ["core.hooksPath", "core.fsmonitor", "core.sshCommand", "diff.external", "gpg.program"]) expect(script).toContain(`c '${k}'`);
    expect(script).toContain(`c attr.tree ${EMPTY_TREE}`);
    expect(gitShimScript({ git: "/usr/bin/git", launcher: null, caller: "opencode" })).not.toContain("exec '/p");
  });

  test("PATH: the shim first, once", () => {
    expect(pathWithShim("/s", "/usr/bin:/s:/bin")).toBe("/s:/usr/bin:/bin");
    expect(pathWithShim("/s", undefined)).toBe("/s");
  });

  test("Claude's CLI gets the shim first on PATH; every Bash command it runs gets its PATH without it", () => {
    const temp = { cli: join(root, "cc", "cli"), root: join(root, "cc", "cmd"), commands: join(root, "cc", "cmd", "claude-1") };
    mkdirSync(temp.cli, { recursive: true });
    const shim = join(root, "shim dir's", "git-bin");
    const env = claudeNativeEnv({ env: {} }, temp, { PATH: "/usr/bin:/bin", HOME: home }, shim);
    expect(env.PATH).toBe(`${shim}:/usr/bin:/bin`);
    const file = env.CLAUDE_ENV_FILE ?? "";
    const r = Bun.spawnSync(["/bin/sh", "-c", '. "$1"; printf %s "$PATH"', "sh", file], { env: { PATH: env.PATH } });
    expect(r.stdout.toString()).toBe("/usr/bin:/bin");
    // Without a shim, nothing about PATH.
    expect(claudeNativeEnv({ env: {} }, temp, { PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  });
});

describe("git shim: defused (no sandbox to run it in)", () => {
  let dir: string;
  beforeAll(() => {
    dir = writeGitShim(join(root, "defused", "git-bin"), { git: GIT_BIN, launcher: null, caller: "opencode" });
  });

  test("a repository's filter, fsmonitor and textconv run nothing; status still answers", () => {
    const { ws, mark } = plant("defused-ws");
    const st = runShim(dir, STATUS, ws);
    expect(st.code).toBe(0);
    expect(st.out).toBe(STATUS_OUT);
    // A diff through the textconv the repository names fails rather than run it (an empty one can't be run).
    const diff = runShim(dir, ["--no-pager", "diff", "--", "b.txt"], ws);
    expect(diff.code).toBe(128);
    expect(existsSync(mark)).toBe(false);
  });

  test("the caller's own config list is kept (appended to, not replaced); a credential helper the repository names is reset", () => {
    const { ws } = plant("defused-cfg");
    setup(ws, ["config", "credential.helper", "planted-helper"]);
    const r = runShim(dir, ["config", "--get-all", "user.name"], ws, { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "from-caller" } });
    expect(r.out.trim()).toBe("from-caller");
    const h = runShim(dir, ["config", "--get-all", "credential.helper"], ws);
    expect(h.out).toBe("planted-helper\n\n");
  });

  test("stdin, exit code, cwd and arguments are the caller's", () => {
    const { ws } = plant("defused-io");
    mkdirSync(join(ws, "sub"), { recursive: true });
    expect(runShim(dir, ["hash-object", "--stdin"], ws, { stdin: "hello\n" }).out.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(runShim(dir, ["rev-parse", "--verify", "-q", "no-such-ref"], ws).code).toBe(1);
    expect(runShim(dir, ["rev-parse", "--show-prefix"], join(ws, "sub")).out.trim()).toBe("sub/");
  });

  test("a config git can't read runs nothing (fails closed)", () => {
    const ws = join(root, "defused-broken");
    mkdirSync(ws, { recursive: true });
    setup(ws, ["init", "-q", "."]);
    writeFileSync(join(ws, ".git", "config"), "[core\n\tbroken");
    const r = runShim(dir, STATUS, ws);
    expect(r.code).toBe(128);
    expect(r.err).toContain("codeoid: git config could not be read here");
  });
});

describe.skipIf(!bwrapProbe.available)("git shim: inside the session's sandbox (real bubblewrap)", () => {
  let sbx: SessionSandbox;
  let shim: string;
  let ws: string;
  let mark: string;
  let inside: string;
  let server: Server;
  let connections = 0;
  let port = 0;

  beforeAll(async () => {
    ({ ws, mark, inside } = plant("sandboxed-ws"));
    writeFileSync(join(home, "secret.txt"), "PLANTED-HOME-SECRET\n");
    const registry = new SandboxRegistry("linux");
    registry.register(bwrap);
    sbx = new SessionSandbox({
      sessionId: "git-shim",
      workdir: ws,
      registry,
      config: { sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [home], homeReadable: [], docker: { image: "x" } } } as never,
    });
    await sbx.refresh("opencode");
    const rt = sbx.runtime;
    if (!rt) throw new Error("no runtime");
    shim = rt.gitShim("the Claude CLI");
    server = createServer((s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await sbx?.close();
    server?.close();
  });

  test("its dir is the daemon's (hidden from every sandbox), the same for the runtime's life", () => {
    expect(shim.startsWith(join(sandboxRoot(), "launch-"))).toBe(true);
    expect(sbx.runtime?.gitShim("again")).toBe(shim);
    expect(readFileSync(join(shim, "git"), "utf8")).toContain("exec '");
  });

  test("the planted filter, fsmonitor and textconv run inside: nothing reaches the host or writes the workspace, and git's output is right", () => {
    const st = runShim(shim, STATUS, ws);
    expect(st.err).not.toContain("failed");
    expect(st.code).toBe(0);
    expect(st.out).toBe(STATUS_OUT);
    const diff = runShim(shim, ["--no-pager", "diff", "--", "b.txt"], ws);
    expect(diff.code).toBe(0);
    expect(diff.out).toContain("b2");
    expect(existsSync(mark)).toBe(false);
    expect(existsSync(inside)).toBe(false);
  });

  test("stdin, exit code, cwd and arguments are the caller's", () => {
    mkdirSync(join(ws, "sub"), { recursive: true });
    expect(runShim(shim, ["hash-object", "--stdin"], ws, { stdin: "hello\n" }).out.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(runShim(shim, ["rev-parse", "--verify", "-q", "no-such-ref"], ws).code).toBe(1);
    expect(runShim(shim, ["rev-parse", "--show-prefix"], join(ws, "sub")).out.trim()).toBe("sub/");
  });

  test("started from a dir the sandbox hides, git fails there rather than answer for another dir", () => {
    const hiddenDir = join(home, "elsewhere");
    mkdirSync(hiddenDir, { recursive: true });
    setup(hiddenDir, ["init", "-q", "."]);
    // bwrap would otherwise start it in $HOME: one that is a repository the sandbox shows (the workspace).
    const r = runShim(shim, ["rev-parse", "--show-toplevel"], hiddenDir, { env: { HOME: ws } });
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
  });

  test("the hidden home stays hidden, and there is no network (the session's own is on)", () => {
    const r = runShim(shim, ["hash-object", join(home, "secret.txt")], ws);
    expect(r.code).not.toBe(0);
    const before = connections;
    const net = runShim(shim, ["ls-remote", `http://127.0.0.1:${port}/r.git`], ws, { env: { GIT_TERMINAL_PROMPT: "0" } });
    expect(net.code).not.toBe(0);
    expect(connections).toBe(before);
  });

  test("with the launcher's provider gone, git runs defused instead: still nothing planted runs", () => {
    const launcher = readFileSync(join(shim, "git"), "utf8").match(/exec '([^']+launch-git)'/)?.[1] ?? "";
    expect(launcher).not.toBe("");
    const gone = writeGitShim(join(root, "gone", "git-bin"), { git: GIT_BIN, launcher, provider: join(root, "no-such-bwrap"), caller: "the Claude CLI" });
    const st = runShim(gone, STATUS, ws);
    expect(st.code).toBe(0);
    expect(st.out).toBe(STATUS_OUT);
    expect(existsSync(mark)).toBe(false);
  });
});
