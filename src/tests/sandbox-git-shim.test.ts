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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_BIN } from "../daemon/git-env.js";
import { BwrapSandboxProvider, bwrapArgs } from "../daemon/sandbox/bwrap.js";
import { claudeNativeEnv, credentialEnvNames } from "../daemon/sandbox/claude-native.js";
import { dockerRunArgs } from "../daemon/sandbox/docker.js";
import { cliWorktrees, EMPTY_TREE, gitShimScript, gitShimSpec, pathWithShim, SHIM_ENV_NAMES, writeGitShim } from "../daemon/sandbox/git-shim.js";
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

/**
 * A caller's environment as the Claude CLI's or opencode's server's can be:
 * its credentials, a program or two of its own, and what git may have.
 * Every value that must not reach git holds `PLANTED`.
 */
const CALLER_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-PLANTED",
  ANTHROPIC_AUTH_TOKEN: "PLANTED-AUTH",
  CLAUDE_CODE_OAUTH_TOKEN: "PLANTED-OAUTH",
  ANTHROPIC_BASE_URL: "https://u:PLANTED@gateway.example",
  OPENAI_API_KEY: "PLANTED-OPENAI",
  OPENCODE_SERVER_PASSWORD: "PLANTED-PW",
  CODEOID_API_KEY: "zid_sk_PLANTED",
  SOME_SERVICE_SECRET: "PLANTED-S",
  GIT_ASKPASS: "/PLANTED/askpass",
  GIT_SSH_COMMAND: "PLANTED-ssh",
  GIT_EXEC_PATH: "/PLANTED/exec",
  GIT_TEMPLATE_DIR: "/PLANTED/templates",
  GIT_AUTHOR_NAME: "caller",
  GIT_ALLOW_PROTOCOL: "none",
  LC_ALL: "C",
  // The caller's own `-c` list: an alias showing what git runs things with, an empty reset, a header with a credential.
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "alias.e",
  GIT_CONFIG_VALUE_0: "!env",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_CONFIG_KEY_2: "http.extraHeader",
  GIT_CONFIG_VALUE_2: "Authorization: Bearer PLANTED-HEADER",
};

/** `env` output as variables (a value with a newline in it isn't one of these). */
function envOf(out: string): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) seen[line.slice(0, at)] = line.slice(at + 1);
  }
  return seen;
}

function expectNoCredential(seen: Record<string, string>): void {
  expect(Object.entries(seen).filter(([, v]) => v.includes("PLANTED"))).toEqual([]);
  for (const n of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENCODE_SERVER_PASSWORD", "CODEOID_API_KEY", "GIT_ASKPASS", "GIT_SSH_COMMAND"]) {
    expect(seen[n]).toBeUndefined();
  }
}

const STATUS = ["--no-optional-locks", "status", "--short", "--ignore-submodules=dirty"];
/** What it says of a planted workspace: `a.txt` (stat-dirty, its filter a pass-through or off) unchanged. */
const STATUS_OUT = " M b.txt\n?? f.sh\n";

describe("git shim: the script", () => {
  const spec: SandboxSpec = {
    sessionId: "s",
    workspace: "/w",
    tempDir: "/t",
    writable: ["/w/.git"],
    hidden: ["/home/u"],
    reexposed: [],
    readOnly: ["/w/.claude", "/w/.git/config", "/w/.git/worktrees", "/w/.claude/worktrees/x/.git", "/w/.git/worktrees/own/commondir"],
    pinned: ["/w/p"],
    containerSockets: [],
    network: { mode: "on" },
    unsetEnv: [],
  };

  test("the spec its git runs under (#448 round 5): the session's command sandbox, no network, a fresh temp dir per git, the CLI's worktree dirs writable", () => {
    const s = gitShimSpec(spec, { tempParent: "/g-tmp", worktrees: { open: ["/w/.git/worktrees", "/w/.claude/worktrees"], keep: ["/w/.git/worktrees/own/commondir"] } });
    // The workspace stays writable (a commit, a worktree), the git structure and project settings held as for a command.
    expect(s.workspace).toBe("/w");
    expect(s.writable).toEqual(["/w/.git", "/w/.git/worktrees", "/w/.claude/worktrees"]);
    expect(s.readOnly).toEqual(["/w/.claude", "/w/.git/config", "/w/.git/worktrees/own/commondir"]);
    expect(s.pinned).toEqual(["/w/p"]);
    expect(s.hidden).toEqual(["/home/u"]);
    expect(s.network).toEqual({ mode: "off" });
    // Never the session's temp dir.
    expect(s.tempDir).toBe("/g-tmp");
    expect(s.privateTemp).toBe(true);
    // No worktree dirs: exactly the command spec's paths.
    expect(gitShimSpec(spec, { tempParent: "/g-tmp" }).readOnly).toEqual(spec.readOnly as string[]);
  });

  test("the CLI's worktree dirs: the repository's worktrees/ and the workspace's .claude/worktrees, real dirs only, never in a git dir held whole", () => {
    const w = join(root, "cliwt");
    mkdirSync(join(w, ".claude"), { recursive: true });
    setup(w, ["init", "-q", "."]);
    mkdirSync(join(w, ".git", "worktrees"), { recursive: true });
    expect(cliWorktrees(w, home)).toEqual({ open: [join(w, ".git", "worktrees"), join(w, ".claude", "worktrees")] });
    // `.claude/worktrees` a link: not opened (a bind would follow it).
    rmSync(join(w, ".claude", "worktrees"), { recursive: true });
    symlinkSync(outside, join(w, ".claude", "worktrees"));
    expect(cliWorktrees(w, home).open).toEqual([join(w, ".git", "worktrees")]);
    // A link among the git dir's control: held read-only whole, nothing opened in it.
    rmSync(join(w, ".git", "hooks"), { recursive: true, force: true });
    symlinkSync(outside, join(w, ".git", "hooks"));
    expect(cliWorktrees(w, home).open).toEqual([]);
    // No repository: nothing.
    const plain = join(root, "cliwt-none");
    mkdirSync(plain, { recursive: true });
    expect(cliWorktrees(plain, home).open).toEqual([]);
  });

  test("a private-temp spec's /tmp is a tmpfs of the sandbox's own (bubblewrap, Docker), never the temp dir bound", () => {
    const s = gitShimSpec(spec, { tempParent: "/g-tmp" });
    const kind = (p: string) => (p === "/w" || p === "/w/.git" || p === "/t" || p === "/g-tmp" ? "dir" : null);
    const b = bwrapArgs(s, "", kind);
    expect(b.join(" ")).toContain("--tmpfs /tmp");
    expect(b).not.toContain("/g-tmp");
    expect(b).not.toContain("/t");
    expect(bwrapArgs(spec, "", kind).join(" ")).toContain("--bind /t /tmp");
    const d = dockerRunArgs(s, ["git"], { image: "i", cwd: "/w", envNames: [], uid: 1, gid: 1, kind });
    expect(d).toContain("type=tmpfs,destination=/tmp");
    expect(d.some((a) => a.includes("source=/g-tmp"))).toBe(false);
  });

  test("with a launcher it starts it, with a clean environment, when the launcher and its provider are there; every program-running key is turned off on the other path", () => {
    const script = gitShimScript({ git: "/usr/bin/git", launcher: "/p/launch-git", provider: "/usr/bin/bwrap", caller: "the Claude CLI", home: "/home/u" });
    expect(script).toContain(`if [ -f '/p/launch-git' ] && [ -x '/p/launch-git' ] && [ -x '/usr/bin/bwrap' ]; then`);
    expect(script).toContain(`set -- "$@" 'HOME=/home/u'`);
    expect(script).toContain(`set -- "$@" "GIT_CONFIG_COUNT=$j" '/p/launch-git'`);
    expect(script).toContain(`exec /usr/bin/env -i "$@"`);
    for (const k of ["core.hooksPath", "core.fsmonitor", "core.sshCommand", "diff.external", "gpg.program", "diff.ignoreSubmodules", "status.submoduleSummary"]) {
      expect(script).toContain(`"GIT_CONFIG_KEY_$j="'${k}'`);
    }
    expect(script).toContain(`"GIT_CONFIG_KEY_$j="'attr.tree' "GIT_CONFIG_VALUE_$j="'${EMPTY_TREE}'`);
    expect(gitShimScript({ git: "/usr/bin/git", launcher: null, caller: "opencode" })).not.toContain("/p/launch-git");
  });

  test("what of the caller's environment git may get is never a credential, a program to run, or git's own programs", () => {
    for (const n of SHIM_ENV_NAMES) {
      expect(credentialEnvNames({ [n]: "x" })).toEqual([]);
      expect(n).not.toMatch(/^(?:ANTHROPIC_|OPENAI_|CLAUDE_|CODEOID_|ZEROID_|TELEGRAM_|GEMINI_|GOOGLE_|AWS_|OPENCODE_)/);
      expect(["GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_EXTERNAL_DIFF", "GIT_PROXY_COMMAND", "GIT_CONFIG_PARAMETERS", "PATH", "HOME"]).not.toContain(n);
    }
  });

  test("PATH: the shim first, once, and only absolute entries (#448 round 5)", () => {
    expect(pathWithShim("/s", "/usr/bin:/s:/bin")).toBe("/s:/usr/bin:/bin");
    expect(pathWithShim("/s", undefined)).toBe("/s");
    expect(pathWithShim("/s", "node_modules/.bin:.::/usr/bin:bin:./x")).toBe("/s:/usr/bin");
  });

  test("Claude's CLI gets the shim first on PATH, and no relative entry; every Bash command it runs gets its PATH without the shim", () => {
    const temp = { cli: join(root, "cc", "cli"), root: join(root, "cc", "cmd"), commands: join(root, "cc", "cmd", "claude-1") };
    mkdirSync(temp.cli, { recursive: true });
    const shim = join(root, "shim dir's", "git-bin");
    const env = claudeNativeEnv({ env: {} }, temp, { PATH: ".:/usr/bin:node_modules/.bin:/bin", HOME: home }, shim);
    expect(env.PATH).toBe(`${shim}:/usr/bin:/bin`);
    const file = env.CLAUDE_ENV_FILE ?? "";
    const r = Bun.spawnSync(["/bin/sh", "-c", '. "$1"; printf %s "$PATH"', "sh", file], { env: { PATH: env.PATH } });
    expect(r.stdout.toString()).toBe("/usr/bin:/bin");
    // Without a shim: the absolute entries, nothing else changed.
    expect(claudeNativeEnv({ env: {} }, temp, { PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
    expect(claudeNativeEnv({ env: {} }, temp, { PATH: "./bin:/usr/bin:." }).PATH).toBe("/usr/bin");
    expect(claudeNativeEnv({ env: {} }, temp, {}).PATH).toBeUndefined();
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

  test("an option that is a command of its own (`--version`, opencode's first git) answers, as do git's global options before a command", () => {
    const { ws } = plant("defused-opts");
    const v = runShim(dir, ["--version"], ws);
    expect(v.code).toBe(0);
    expect(v.out).toStartWith("git version ");
    expect(runShim(dir, ["--exec-path"], ws).code).toBe(0);
    expect(runShim(dir, ["--no-pager", "--literal-pathspecs", "-c", "core.quotePath=false", "rev-parse", "--is-inside-work-tree"], ws).out.trim()).toBe("true");
  });

  test("git gets an environment of its own (#448 round 5): no credential, password or program the caller had; its repository, identity and narrowing knobs kept", () => {
    const { ws } = plant("defused-env");
    // `alias.e=!env`, in the caller's own `-c` list: what git hands what it runs.
    const r = runShim(dir, ["e"], ws, { env: CALLER_ENV });
    expect(r.code).toBe(0);
    const seen = envOf(r.out);
    expectNoCredential(seen);
    expect(seen.GIT_AUTHOR_NAME).toBe("caller");
    expect(seen.GIT_ALLOW_PROTOCOL).toBe("none");
    expect(seen.LC_ALL).toBe("C");
    expect(seen.HOME).toBe(home);
    expect(seen.PATH?.split(":").every((p) => p.startsWith("/"))).toBe(true);
    // The caller's `-c` list: the alias and an empty reset kept, the header with a credential not.
    expect(runShim(dir, ["config", "--get", "http.extraHeader"], ws, { env: CALLER_ENV }).out).toBe("");
  });

  test("a nested repository's own filter runs nothing (#448 round 5): git never goes into a gitlink, a .gitmodules `ignore = none` included", () => {
    const sup = join(root, "defused-nested");
    const sub = join(sup, "sub");
    const mark = join(outside, "MARK-nested");
    mkdirSync(sub, { recursive: true });
    setup(sup, ["init", "-q", "."]);
    setup(sub, ["init", "-q", "."]);
    const script = join(root, "nested-f.sh");
    writeFileSync(script, `#!/bin/sh\n{ echo ran >> '${mark}'; } 2>/dev/null\ncat\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(sub, "s.txt"), "s\n");
    setup(sub, ["add", "s.txt"]);
    setup(sub, ["commit", "-qm", "s"]);
    // Defined in the nested repository's own config, applied by its own `info/attributes`.
    setup(sub, ["config", "filter.evil.clean", script]);
    writeFileSync(join(sub, ".git", "info", "attributes"), "* filter=evil\n");
    const head = Bun.spawnSync([GIT_BIN, "rev-parse", "HEAD"], { cwd: sub }).stdout.toString().trim();
    setup(sup, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
    setup(sup, ["commit", "-qm", "gitlink"]);
    const dirty = () => Bun.spawnSync(["touch", "-d", "2001-01-01", join(sub, "s.txt")]);
    for (const args of [["status", "--porcelain"], ["status"], ["diff"], ["diff", "--submodule=diff"]]) {
      dirty();
      expect(runShim(dir, args, sup).code).toBe(0);
      expect(existsSync(mark)).toBe(false);
    }
    // A `.gitmodules` asking for the submodule's dirt, in the working tree, then only in the index.
    writeFileSync(join(sup, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\tignore = none\n');
    dirty();
    expect(runShim(dir, ["status", "--porcelain"], sup).code).toBe(0);
    expect(existsSync(mark)).toBe(false);
    setup(sup, ["add", ".gitmodules"]);
    rmSync(join(sup, ".gitmodules"));
    dirty();
    expect(runShim(dir, ["status", "--porcelain"], sup).code).toBe(0);
    expect(existsSync(mark)).toBe(false);
    // Without the shim (the test's own check): the same status does run it.
    dirty();
    Bun.spawnSync([GIT_BIN, "status", "--porcelain"], { cwd: sup, env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
    expect(existsSync(mark)).toBe(true);
  });

  test("a repository named by the caller's `-C` (or `--git-dir`) has its drivers reset, as the one it's started in does", () => {
    const { ws, mark } = plant("defused-dash-c");
    const st = runShim(dir, ["-C", ws, ...STATUS], root);
    expect(st.code).toBe(0);
    expect(st.out).toBe(STATUS_OUT);
    const gd = runShim(dir, [`--git-dir=${join(ws, ".git")}`, `--work-tree=${ws}`, ...STATUS], root);
    expect(gd.code).toBe(0);
    // The textconv `info/attributes` applies (attr.tree doesn't cover it): reset by name, read from the repository `-C` names.
    expect(runShim(dir, ["-C", ws, "--no-pager", "diff", "--no-ext-diff", "--", "b.txt"], root).code).toBe(128);
    expect(runShim(dir, ["--git-dir", join(ws, ".git"), "--work-tree", ws, "--no-pager", "diff", "--no-ext-diff", "--", "b.txt"], root).code).toBe(128);
    expect(existsSync(mark)).toBe(false);
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
    expect(readFileSync(join(shim, "git"), "utf8")).toContain("exec /usr/bin/env -i");
  });

  test("the planted filter, fsmonitor and textconv run inside: nothing reaches the host outside the workspace, and git's output is right", () => {
    const st = runShim(shim, STATUS, ws);
    expect(st.err).not.toContain("failed");
    expect(st.code).toBe(0);
    // What the filter wrote in the workspace (it may) aside.
    expect(st.out.replace("?? WROTE-INSIDE\n", "")).toBe(STATUS_OUT);
    const diff = runShim(shim, ["--no-pager", "diff", "--", "b.txt"], ws);
    expect(diff.code).toBe(0);
    expect(diff.out).toContain("b2");
    expect(existsSync(mark)).toBe(false);
    // The workspace is writable to it, as to any sandboxed command (#448 round 5: the CLI's own commits and worktrees need it).
    expect(existsSync(inside)).toBe(true);
  });

  test("a planted driver sees no credential of the CLI's, can't write outside the workspace or its git structure, and leaves nothing in a /tmp that is kept (#448 round 5)", () => {
    const id = "envws";
    const w = join(root, id);
    mkdirSync(w, { recursive: true });
    const dump = join(w, "ENV-DUMP");
    const tmpList = join(w, "TMP-LIST");
    const outMark = join(outside, `MARK-${id}`);
    const script = join(w, "f.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `env > '${dump}' 2>/dev/null`,
        // And on stderr, which git passes on: seen whatever the driver may write.
        "env >&2",
        `ls -A /tmp > '${tmpList}' 2>/dev/null`,
        "echo kept > /tmp/LEAK 2>/dev/null",
        `echo kept > "\${TMPDIR:-/tmp}/LEAK2" 2>/dev/null`,
        `{ echo ran >> '${outMark}'; } 2>/dev/null`,
        `{ echo '[planted]' >> '${join(w, ".git", "config")}'; } 2>/dev/null`,
        `{ echo planted > '${join(w, ".git", "hooks", "pre-commit")}'; } 2>/dev/null`,
        "cat",
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    setup(w, ["init", "-q", "."]);
    setup(w, ["config", "filter.x.clean", script]);
    writeFileSync(join(w, ".gitattributes"), "a.txt filter=x\n");
    writeFileSync(join(w, "a.txt"), "a\n");
    setup(w, ["-c", "filter.x.clean=", "add", "a.txt", ".gitattributes"]);
    setup(w, ["-c", "filter.x.clean=", "commit", "-qm", "init"]);
    const configBefore = readFileSync(join(w, ".git", "config"), "utf8");
    const reg = new SandboxRegistry("linux");
    reg.register(bwrap);
    const s2 = new SessionSandbox({ sessionId: "git-shim-env", workdir: w, registry: reg, config: { sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [home], homeReadable: [], docker: { image: "x" } } } as never });
    return (async () => {
      try {
        await s2.refresh("claude");
        const rt = s2.runtime;
        if (!rt) throw new Error("no runtime");
        const sh = rt.gitShim("the Claude CLI");
        const { alias: _a, ...callerEnv } = { alias: 0, ...CALLER_ENV, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "http.extraHeader", GIT_CONFIG_VALUE_1: "Authorization: Bearer PLANTED-HEADER" };
        for (const round of [1, 2]) {
          Bun.spawnSync(["touch", "-d", `200${round}-01-01`, join(w, "a.txt")]);
          const st = runShim(sh, ["--no-optional-locks", "status", "--porcelain"], w, { env: callerEnv });
          expect(st.code).toBe(0);
          expectNoCredential(envOf(st.err));
          expect(envOf(st.err).HOME).toBe(homedir());
          expect(existsSync(dump)).toBe(true);
          const seen = envOf(readFileSync(dump, "utf8"));
          expectNoCredential(seen);
          // Its home is the sandbox's view of the home (hidden); its repository selection and identity the caller's.
          expect(seen.HOME).toBe(homedir());
          expect(seen.GIT_AUTHOR_NAME).toBe("caller");
          // A fresh /tmp each time: what the first run left isn't there for the second.
          expect(readFileSync(tmpList, "utf8")).not.toContain("LEAK");
        }
        // Nothing of it in the session's temp dir (which the session's commands share), nor outside the workspace.
        expect(readdirSync(rt.spec.tempDir).filter((n) => n.includes("LEAK"))).toEqual([]);
        expect(existsSync(outMark)).toBe(false);
        expect(readFileSync(join(w, ".git", "config"), "utf8")).toBe(configBefore);
        expect(existsSync(join(w, ".git", "hooks", "pre-commit"))).toBe(false);
      } finally {
        await s2.close();
      }
    })();
  });

  test("the CLI's own writing git works through it (#448 round 5): a worktree added and removed as the CLI does, a commit", async () => {
    const w = join(root, "wt-ws");
    mkdirSync(w, { recursive: true });
    setup(w, ["init", "-q", "."]);
    writeFileSync(join(w, "a.txt"), "a\n");
    setup(w, ["add", "a.txt"]);
    setup(w, ["commit", "-qm", "init"]);
    const reg = new SandboxRegistry("linux");
    reg.register(bwrap);
    const s2 = new SessionSandbox({ sessionId: "git-shim-wt", workdir: w, registry: reg, config: { sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [home], homeReadable: [], docker: { image: "x" } } } as never });
    try {
      await s2.refresh("claude");
      const sh = s2.runtime?.gitShim("the Claude CLI") ?? "";
      const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", LC_ALL: "C" };
      // EnterWorktree's: `git -c checkout.workers=N worktree add --no-track -B <branch> <top>/.claude/worktrees/<name> <base>`.
      const at = join(w, ".claude", "worktrees", "feature");
      const add = runShim(sh, ["-c", "checkout.workers=1", "worktree", "add", "--no-track", "-B", "worktree-feature", at, "HEAD"], w, { env: id });
      expect(add.err).not.toContain("Read-only");
      expect(add.code).toBe(0);
      expect(readFileSync(join(at, "a.txt"), "utf8")).toBe("a\n");
      // An agent's worktree isolation: `git worktree add --detach <path> <base>`.
      const detached = join(w, ".claude", "worktrees", "agent-1");
      expect(runShim(sh, ["worktree", "add", "--detach", detached, "HEAD"], w, { env: id }).code).toBe(0);
      expect(runShim(sh, ["worktree", "list", "--porcelain", "-z"], w).out).toContain(detached);
      // A commit in the worktree, then the worktrees removed.
      writeFileSync(join(at, "b.txt"), "b\n");
      expect(runShim(sh, ["add", "b.txt"], at).code).toBe(0);
      expect(runShim(sh, ["commit", "-qm", "in worktree"], at, { env: id }).code).toBe(0);
      expect(runShim(sh, ["worktree", "remove", "--force", detached], w).code).toBe(0);
      expect(runShim(sh, ["worktree", "remove", "--force", at], w).code).toBe(0);
      expect(existsSync(at)).toBe(false);
      // A commit in the workspace itself.
      expect(runShim(sh, ["commit", "--allow-empty", "-qm", "empty"], w, { env: id }).code).toBe(0);
      expect(runShim(sh, ["log", "--oneline", "worktree-feature"], w).out).toContain("in worktree");
      // Still held: the repository's config and hooks, its other project settings.
      expect(runShim(sh, ["config", "core.planted", "x"], w).code).not.toBe(0);
    } finally {
      await s2.close();
    }
  });

  test("a shim removed meanwhile (a temp cleaner) is written again at the next query, rather than leave the CLI the host's git (#448 round 5)", () => {
    const rt = sbx.runtime;
    if (!rt) throw new Error("no runtime");
    const before = rt.gitShim("the Claude CLI");
    // The whole launcher dir gone: the shim and its launcher.
    rmSync(join(before, ".."), { recursive: true, force: true });
    const after = rt.gitShim("the Claude CLI");
    expect(existsSync(join(after, "git"))).toBe(true);
    const st = runShim(after, STATUS, ws);
    expect(st.code).toBe(0);
    expect(existsSync(mark)).toBe(false);
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
    const launcher = readFileSync(join(shim, "git"), "utf8").match(/\[ -f '([^']+launch-git)' \]/)?.[1] ?? "";
    expect(launcher).not.toBe("");
    const gone = writeGitShim(join(root, "gone", "git-bin"), { git: GIT_BIN, launcher, provider: join(root, "no-such-bwrap"), caller: "the Claude CLI" });
    const st = runShim(gone, STATUS, ws);
    expect(st.code).toBe(0);
    // WROTE-INSIDE: left by the sandboxed runs above, in the workspace.
    expect(st.out.replace("?? WROTE-INSIDE\n", "")).toBe(STATUS_OUT);
    expect(existsSync(mark)).toBe(false);
  });
});
