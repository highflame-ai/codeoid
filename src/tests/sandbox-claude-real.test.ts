/**
 * Claude Code's own sandbox with codeoid's policy (#448), for real: the
 * Agent SDK's bundled CLI runs one Bash call against a localhost stand-in for
 * the Messages API (fixtures/claude-sandbox-probe.ts; no model, no vendor).
 * Skipped unless the CLI can sandbox here (Linux with bubblewrap and socat).
 * What the call does is aimed only at files this test planted in its own
 * scratch dir, outside the host's /tmp; nothing runs outside a sandbox but
 * the one call the gate refuses, which therefore never runs.
 */
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";

const PROBE = join(import.meta.dir, "fixtures", "claude-sandbox-probe.ts");
const cli = (() => {
  try {
    const dir = join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
})();
const bwrap = process.platform === "linux" ? await new BwrapSandboxProvider().probe() : { available: false };
const ready = process.env.CODEOID_TEST_CLAUDE_SANDBOX !== "0" && cli !== null && bwrap.available && Bun.which("socat") !== null;

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

describe.skipIf(!ready)("Claude Code's sandbox with codeoid's policy, for real", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-claude-")));
    outside = join(root, "outside-target");
    for (const d of ["ws", "tmp", "secrets", "home", "outside-target"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "secrets", "id_secret"), "PLANTED-SECRET\n");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function probe(
    network: string,
    command: string,
    extra: string[] = [],
    env: Record<string, string> = {},
  ): Promise<{ result: string; asked: string[]; toolResult: string | null; second?: string; system?: string }> {
    const file = join(root, `cmd-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(file, command);
    const p = Bun.spawn([process.execPath, PROBE, root, network, file, ...extra], { stdout: "pipe", stderr: "pipe", timeout: 150_000, env: { ...process.env, ...env } });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const line = out.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse(line);
  }

  const read = () => `cat ${join(root, "secrets", "id_secret")} 2>&1 || echo READ-FAILED`;

  test("hidden is unreadable, outside the workspace is read-only, the workspace and temp dir are writable, the CLI's key isn't in the command's env", async () => {
    const r = await probe("off", `${read()}; rm -rf ${outside} 2>&1; echo rm-exit=$?; echo hi > ${join(root, "ws", "made.txt")} && echo WROTE-WS; echo t > ${join(root, "tmp", "t.txt")} && echo WROTE-TMP; echo "key=[$ANTHROPIC_API_KEY]"`);
    expect(r.result).toBe("success");
    expect(r.asked).toEqual(["Bash"]);
    expect(r.toolResult).not.toContain("PLANTED-SECRET");
    expect(r.toolResult).toContain("READ-FAILED");
    expect(r.toolResult).toContain("Read-only file system");
    expect(r.toolResult).toContain("rm-exit=1");
    expect(r.toolResult).toContain("WROTE-WS");
    expect(r.toolResult).toContain("WROTE-TMP");
    expect(r.toolResult).toContain("key=[]");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  }, 120_000);

  test("network off: a host is refused by the sandbox's proxy, and the command is told", async () => {
    const r = await probe("off", `curl -s -m 5 -o /dev/null -w "http=%{http_code}" http://example.invalid.codeoid.test 2>&1; echo; echo done`);
    expect(r.toolResult).not.toContain("http=200");
    expect(r.toolResult).toContain("sandbox_violations");
  }, 120_000);

  test("codeoid's own policy (#448 round 1): the home is hidden whole, even what is made or replaced while the command runs; the allowlist and the workspace in it are there; $TMPDIR is the session's, and the CLI's own temp files are out of reach", async () => {
    const home = join(root, "home");
    const ws = join(home, "proj");
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(home, ".npmrc"), "PLANTED-NPMRC\n");
    writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), "PLANTED-OPENCODE\n");
    // The CLI reads it itself (outside its sandbox): JSON.
    writeFileSync(join(home, ".claude.json"), '{"planted":"PLANTED-OLD"}\n');
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = allowlisted\n");
    writeFileSync(join(home, ".bun", "bin", "tool"), "#!/bin/sh\necho ALLOWLISTED-TOOL-RAN\n", { mode: 0o755 });
    const reads = [".npmrc", ".local/share/opencode/auth.json", ".claude.json", ".aws/credentials"].map((f) => `cat ${join(home, f)} 2>/dev/null`).join("; ");
    const command = [
      `touch ${join(ws, "started")}`,
      `i=0; while [ ! -e ${join(ws, "go")} ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`,
      reads,
      `cat ${join(home, ".gitconfig")}`,
      join(home, ".bun", "bin", "tool"),
      `echo "TMPDIR=[$TMPDIR]"`,
      `echo t > "$TMPDIR/t" && echo TMPDIR-WRITABLE`,
      `echo x > ${join(root, "sbx", "cli", "planted")} 2>/dev/null || echo CLI-TEMP-OUT-OF-REACH`,
      `ls ${join(root, "sbx", "cli")} 2>/dev/null | head -3; echo LS-DONE`,
      `echo w > ${join(ws, "made.txt")} && echo WS-WRITABLE`,
    ].join("; ");
    const file = join(root, "cmd-policy.txt");
    writeFileSync(file, command);
    const p = Bun.spawn([process.execPath, PROBE, root, "off", file, "policy"], { stdout: "pipe", stderr: "pipe", timeout: 90_000 });
    // Once the command runs: a file replaced by a rename, a credential made afresh.
    let exited = false;
    void p.exited.then(() => {
      exited = true;
    });
    for (let i = 0; i < 600 && !exited && !existsSync(join(ws, "started")); i++) await Bun.sleep(100);
    expect(existsSync(join(ws, "started"))).toBe(true);
    writeFileSync(join(home, ".claude.json.tmp"), '{"planted":"PLANTED-REPLACED"}\n');
    Bun.spawnSync(["mv", join(home, ".claude.json.tmp"), join(home, ".claude.json")]);
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(join(home, ".aws", "credentials"), "PLANTED-AWS-LATE\n");
    writeFileSync(join(ws, "go"), "");
    const out = await new Response(p.stdout).text();
    await p.exited;
    const r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { result: string; toolResult: string | null };
    expect(r.result).toBe("success");
    expect(r.toolResult).not.toContain("PLANTED");
    expect(r.toolResult).toContain("name = allowlisted");
    expect(r.toolResult).toContain("ALLOWLISTED-TOOL-RAN");
    expect(r.toolResult).toContain(`TMPDIR=[${join(root, "sbx", "cmd", `claude-${process.getuid?.() ?? 0}`)}]`);
    expect(r.toolResult).toContain("TMPDIR-WRITABLE");
    expect(r.toolResult).toContain("CLI-TEMP-OUT-OF-REACH");
    expect(r.toolResult).toMatch(/\nLS-DONE/);
    expect(r.toolResult).toContain("WS-WRITABLE");
    expect(existsSync(join(root, "sbx", "cli", "planted"))).toBe(false);
  }, 120_000);

  test("a linked worktree commits from inside Claude's sandbox with codeoid's policy (#448 round 1); the repository's hooks stay read-only", async () => {
    const repo = join(root, "home", "src", "repo");
    mkdirSync(repo, { recursive: true });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, env });
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "."], repo);
    git(["commit", "-qm", "init"], repo);
    expect(git(["worktree", "add", "-q", "-b", "feat", join(root, "wt")], repo).exitCode).toBe(0);
    const r = await probe(
      "off",
      `echo n > new.txt; git add new.txt && git -c user.name=t -c user.email=t@example.invalid commit -qm sandboxed && echo COMMITTED; echo bad > ${join(repo, ".git", "hooks", "post-commit")} 2>/dev/null || echo HOOKS-READ-ONLY`,
      ["policy"],
    );
    expect(r.result).toBe("success");
    expect(r.toolResult).toContain("COMMITTED");
    expect(r.toolResult).toContain("HOOKS-READ-ONLY");
    expect(git(["log", "--oneline", "feat"], repo).stdout.toString()).toContain("sandboxed");
    expect(existsSync(join(repo, ".git", "hooks", "post-commit"))).toBe(false);
  }, 120_000);

  test("codeoid's own temp entries are hidden from Claude's sandbox, which keeps the host's /tmp: a sign-in made while the session runs is unreadable (#448 round 2)", async () => {
    const pathFile = join(root, "signin-path");
    const file = join(root, "cmd-signin.txt");
    // The sign-in is made after the sandbox settings are built; its path is read when the command runs.
    writeFileSync(file, `s=$(cat ${pathFile}); cat "$s/.credentials.json" 2>&1 || echo SIGNIN-UNREADABLE; ls "$(dirname "$s")" 2>&1 | head -3; echo LS-DONE`);
    const p = Bun.spawn([process.execPath, PROBE, root, "off", file, "policy"], { stdout: "pipe", stderr: "pipe", timeout: 90_000, env: { ...process.env, CODEOID_PROBE_SIGNIN_PATH: pathFile } });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { result: string; toolResult: string | null };
    expect(r.result).toBe("success");
    expect(existsSync(pathFile)).toBe(true);
    expect(r.toolResult).not.toContain("PLANTED-SIGNIN-TOKEN");
    expect(r.toolResult).toContain("SIGNIN-UNREADABLE");
    // Nor is the daemon's private dir listable (cat's own error repeats the path it was given).
    const listing = (r.toolResult ?? "").split("SIGNIN-UNREADABLE")[1]?.split("LS-DONE")[0] ?? "";
    expect(listing).not.toContain("codeoid-login-");
  }, 120_000);

  test("Docker access: a planted socket in the hidden runtime dir is unreachable by default, and reachable with the owner's option (#448 follow-up)", async () => {
    if (!Bun.which("python3")) return;
    const runtime = join(root, "run-user");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const sock = join(runtime, "docker.sock");
    const server = createServer((c) => c.end("PLANTED-RUNTIME\n"));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const cmd = `python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print(s.recv(100).decode().strip())' '${sock}' 2>&1 || true`;
      const hidden = await probe("off", cmd, ["policy"], { CODEOID_PROBE_RUNTIME_DIR: runtime });
      expect(hidden.result).toBe("success");
      expect(hidden.toolResult).not.toContain("PLANTED-RUNTIME");
      const shown = await probe("off", cmd, ["policy"], { CODEOID_PROBE_RUNTIME_DIR: runtime, CODEOID_PROBE_DOCKER_SOCKET: "1" });
      expect(shown.result).toBe("success");
      expect(shown.toolResult).toContain("PLANTED-RUNTIME");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 300_000);

  test("under Claude's sandbox too, a command adds a worktree in its own folder, commits there and removes it; nothing lands elsewhere in the location, and the user's and other sessions' worktrees stay held (#448 round 10)", async () => {
    const r2 = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-claude-wt-")));
    try {
      const home = join(r2, "home");
      const repo = join(home, "proj");
      mkdirSync(repo, { recursive: true });
      const genv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, env: genv });
      git(["init", "-q", "-b", "main"], repo);
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(["add", "."], repo);
      git(["commit", "-qm", "init"], repo);
      // The user's own worktrees: one beside the repository, one in its -worktrees location; another session's folder.
      expect(git(["worktree", "add", "-q", "-b", "user", join(r2, "userwt")], repo).exitCode).toBe(0);
      expect(git(["worktree", "add", "-q", "-b", "userloc", join(home, "proj-worktrees", "userloc")], repo).exitCode).toBe(0);
      expect(git(["worktree", "add", "-q", "-b", "other", join(home, "proj-worktrees", "other-2222bbbb", "o")], repo).exitCode).toBe(0);
      const wts = join(repo, ".git", "worktrees");
      const own = join(home, "proj-worktrees", "agent-1111aaaa");
      const command = [
        `git worktree add -q ${own}/x -b feature/x && echo ADDED`,
        `cd ${own}/x && echo x > x.txt && git add x.txt && git -c user.name=t -c user.email=t@example.com commit -qm in-worktree && echo COMMITTED`,
        `cd '${repo}' && git worktree remove ${own}/x && echo REMOVED`,
        "git worktree add -q ../proj-worktrees/y -b y 2>/dev/null && echo ADDED-ELSEWHERE || echo ELSEWHERE-REFUSED",
        `echo x > ${join(home, "proj-worktrees", "other-2222bbbb", "o", "x.txt")} 2>/dev/null && echo WROTE-OTHER || echo OTHER-HELD`,
        `echo /elsewhere > ${join(wts, "userwt", "commondir")} 2>/dev/null && echo REWROTE || echo USER-HELD`,
        `echo x > ${join(home, "proj-worktrees", "userloc", "x.txt")} 2>/dev/null && echo WROTE-USERLOC || echo USERLOC-HELD`,
        `echo bad >> ${join(repo, ".git", "config")} 2>/dev/null && echo WROTE-CONFIG || echo CONFIG-HELD`,
      ].join("; ");
      const file = join(r2, "cmd-wt.txt");
      writeFileSync(file, command);
      const p = Bun.spawn([process.execPath, PROBE, r2, "off", file, "policy"], { stdout: "pipe", stderr: "pipe", timeout: 90_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", CODEOID_PROBE_WORKTREE_FOLDER: "agent-1111aaaa" } });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { result: string; toolResult: string | null };
      expect(r.result).toBe("success");
      for (const w of ["ADDED", "COMMITTED", "REMOVED", "OTHER-HELD", "USER-HELD", "USERLOC-HELD", "CONFIG-HELD"]) expect(r.toolResult).toContain(w);
      expect(git(["log", "--oneline", "feature/x"], repo).stdout.toString()).toContain("in-worktree");
      expect(readFileSync(join(wts, "userwt", "commondir"), "utf8")).not.toContain("elsewhere");
      // Elsewhere in a location inside the (denied) home it lands in the CLI's scratch home, never on the host
      // (docs/sandbox.md: on Claude's own sandbox the location isn't shown, it would cover the session's folder).
      expect(existsSync(join(home, "proj-worktrees", "y"))).toBe(false);
      expect(readFileSync(join(home, "proj-worktrees", "other-2222bbbb", "o", "a.txt"), "utf8")).toBe("a\n");
      expect(existsSync(join(home, "proj-worktrees", "other-2222bbbb", "o", "x.txt"))).toBe(false);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  }, 120_000);

  test("Docker access on Claude's Linux sandbox (every unix socket allowed): a tmux-style socket in the host's /tmp is out of reach, the runtime's isn't (#448 round 10)", async () => {
    if (!Bun.which("python3")) return;
    const runtime = join(root, "run-user-tmux");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const tmuxDir = realpathSync(mkdtempSync("/tmp/codeoid-test-tmux-"));
    const sockets = { docker: join(runtime, "docker.sock"), tmux: join(tmuxDir, "default") };
    const servers = await Promise.all(
      Object.entries(sockets).map(
        ([name, at]) =>
          new Promise<ReturnType<typeof createServer>>((r) => {
            const s = createServer((c) => c.end(`REACHED-${name.toUpperCase()}\n`));
            s.listen(at, () => r(s));
          }),
      ),
    );
    try {
      const py = (at: string) => `python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print(s.recv(100).decode().strip())' '${at}' 2>&1 | tail -1`;
      const r = await probe("off", `${py(sockets.docker)}; ${py(sockets.tmux)}`, ["policy"], { CODEOID_PROBE_RUNTIME_DIR: runtime, CODEOID_PROBE_DOCKER_SOCKET: "1" });
      expect(r.result).toBe("success");
      expect(r.toolResult).toContain("REACHED-DOCKER");
      expect(r.toolResult).not.toContain("REACHED-TMUX");
    } finally {
      for (const s of servers) s.close();
      rmSync(tmuxDir, { recursive: true, force: true });
    }
  }, 300_000);

  test("the toolchains' cache variables reach only sandboxed commands: never the CLI, its MCP servers, or a command run outside the sandbox (#448 round 3)", async () => {
    mkdirSync(join(root, "home", "proj"), { recursive: true });
    const show = `echo "cargo=[$CARGO_HOME] gomod=[$GOMODCACHE] npm=[$npm_config_cache] xdg=[$XDG_CACHE_HOME] marker=[$SANDBOX_RUNTIME]"`;
    const cache = join(root, "home", ".cache", "codeoid-sandbox");
    rmSync(join(root, "mcp-env.json"), { force: true });
    const inside = await probe("off", show, ["policy-env"]);
    expect(inside.result).toBe("success");
    expect(inside.toolResult).toContain(`cargo=[${join(cache, "cargo")}] gomod=[${join(cache, "go-mod")}] npm=[${join(cache, "npm")}] xdg=[${cache}] marker=[1]`);
    // The stdio MCP server the CLI started, with its own environment.
    const mcp = JSON.parse(readFileSync(join(root, "mcp-env.json"), "utf8")) as Record<string, string>;
    for (const k of ["CARGO_HOME", "GOCACHE", "GOMODCACHE", "npm_config_cache", "UV_CACHE_DIR", "PIP_CACHE_DIR", "BUN_INSTALL_CACHE_DIR", "XDG_CACHE_HOME", "SANDBOX_RUNTIME"]) expect(mcp[k]).toBeUndefined();
    // A command the owner let run outside the sandbox.
    const outsideCmd = await probe("off", show, ["policy-env-unsandboxed"]);
    expect(outsideCmd.asked).toEqual(["Bash"]);
    expect(outsideCmd.toolResult).toContain("cargo=[] gomod=[] npm=[] xdg=[] marker=[]");
  }, 180_000);

  // #448 round 4: the CLI runs `git status` (and log, remote) in the workspace at every start, on the host. A
  // sandboxed command makes a repository there whose filter driver names a script of its own; at the next CLI
  // start the CLI's git is codeoid's shim, which runs it inside the sandbox (read-only, offline): the script
  // can't write the marker, and the status still reaches the model.
  for (const layout of ["no repository", "a subdirectory of its repository"] as const) {
    test(`a repository a command plants in a workspace that is ${layout} runs nothing on the host at the CLI's next start (#448 round 4)`, async () => {
      const id = Math.random().toString(36).slice(2, 8);
      const top = join(root, `layout-${id}`);
      const ws = layout === "no repository" ? top : join(top, "pkg");
      mkdirSync(ws, { recursive: true });
      if (layout !== "no repository") {
        const g = (args: string[]) => Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: top, env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1" } });
        writeFileSync(join(ws, "keep.txt"), "keep\n");
        g(["init", "-q"]);
        g(["add", "-A"]);
        g(["commit", "-qm", "init"]);
      }
      const script = join(ws, "f.sh");
      const mark = join(outside, `MARK-${id}`);
      const plant = [
        `printf '#!/bin/sh\\necho ran >> ${mark} 2>/dev/null\\ncat\\n' > ${script}`,
        `chmod +x ${script}`,
        `git init -q . && git config filter.x.clean ${script} && echo 'a.txt filter=x' > .gitattributes && echo a > a.txt && git add a.txt .gitattributes && touch -d 2001-01-01 a.txt && echo PLANT-OK`,
      ].join("; ");
      const r = await probe("off", plant, ["policy-env-git"], { CODEOID_PROBE_WORKSPACE: ws });
      expect(r.result).toBe("success");
      expect(r.toolResult).toContain("PLANT-OK");
      expect(r.second).toBe("success");
      // Nothing planted ran on the host: not while planting (inside), not at the CLI's next start (the shim).
      expect(existsSync(mark)).toBe(false);
      // git's output still reached the CLI: the status names the untracked script.
      expect(r.system).toContain("f.sh");
    }, 300_000);
  }

  // #448 round 5: the CLI's own git, through the shim, runs a planted driver in the command sandbox with an environment
  // of its own: the CLI's API key (the stand-in's `sk-test-…`, in the CLI's environment) never reaches it.
  test("a driver a command plants, run by the CLI's own git at its next start, gets none of the CLI's credentials (#448 round 5)", async () => {
    const id = Math.random().toString(36).slice(2, 8);
    const ws = join(root, `envdump-${id}`);
    mkdirSync(ws, { recursive: true });
    const script = join(ws, "f.sh");
    const dump = join(ws, "ENV-DUMP");
    const plant = [
      `printf '#!/bin/sh\\n{ env; echo ----; } >> ${dump} 2>/dev/null\\ncat\\n' > ${script}`,
      `chmod +x ${script}`,
      `git init -q . && git config filter.x.clean ${script} && echo 'a.txt filter=x' > .gitattributes && echo a > a.txt && git add a.txt .gitattributes && touch -d 2001-01-01 a.txt && echo PLANT-OK`,
    ].join("; ");
    const r = await probe("off", plant, ["policy-env-git"], { CODEOID_PROBE_WORKSPACE: ws });
    expect(r.result).toBe("success");
    expect(r.toolResult).toContain("PLANT-OK");
    expect(r.second).toBe("success");
    const runs = readFileSync(dump, "utf8").split("----\n").filter((s) => s.trim());
    // The shim's run (its git's PATH starts with the shim's dir) is among them: it ran, in the workspace it may write.
    const shimRuns = runs.filter((s) => /^PATH=[^\n]*git-bin:/m.test(s));
    expect(shimRuns.length).toBeGreaterThan(0);
    // No run has the key (inside Claude's command sandbox the CLI denies it); the shim's has nothing of the CLI's own.
    for (const s of runs) expect(s).not.toContain("sk-test-not-a-real-key");
    for (const s of shimRuns) expect(s).not.toMatch(/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE=)/m);
  }, 300_000);

  test("a command asking to run outside the sandbox reaches the gate, and a denial means it never runs", async () => {
    const r = await probe("off", `rm -rf ${outside}; echo RAN`, ["unsandboxed"]);
    expect(r.asked).toEqual(["Bash"]);
    expect(r.toolResult ?? "").not.toContain("RAN");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  }, 120_000);

  test("project roots and added dirs (working across repositories): the root shown around the workspace (its read binds land after its write binds), b read-only and its .env hidden; added, b writable", async () => {
    const home = join(root, "home");
    const ws = join(home, "Workspace", "a");
    const b = join(home, "Workspace", "b");
    for (const d of [ws, b, join(home, "Workspace", "c")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(b, "README.md"), "bravo readme\n");
    writeFileSync(join(b, ".env"), "PLANTED-B-ENV\n");
    const command = [
      `cat ${join(b, "README.md")}`,
      `cat ${join(b, ".env")} 2>/dev/null || echo ENV-HIDDEN`,
      `echo a > ${join(ws, "own.txt")} && echo WS-WRITABLE`,
      `echo b > ${join(b, "new.txt")} 2>/dev/null && echo B-WRITTEN || echo B-READ-ONLY`,
      `echo c > ${join(home, "Workspace", "c", "new.txt")} 2>/dev/null && echo C-WRITTEN || echo C-READ-ONLY`,
    ].join("; ");
    const env = { CODEOID_PROBE_WORKSPACE: ws, CODEOID_PROBE_PROJECT_ROOTS: join(home, "Workspace") };
    const r = await probe("off", command, ["policy"], env);
    expect(r.result).toBe("success");
    expect(r.toolResult).toContain("bravo readme");
    expect(r.toolResult).toContain("ENV-HIDDEN");
    expect(r.toolResult).not.toContain("PLANTED-B-ENV");
    expect(r.toolResult).toContain("WS-WRITABLE");
    expect(r.toolResult).toContain("B-READ-ONLY");
    expect(r.toolResult).toContain("C-READ-ONLY");
    const added = await probe("off", command, ["policy"], { ...env, CODEOID_PROBE_ADDED_DIRS: b });
    expect(added.result).toBe("success");
    expect(added.toolResult).toContain("WS-WRITABLE");
    expect(added.toolResult).toContain("B-WRITTEN");
    expect(added.toolResult).toContain("PLANTED-B-ENV");
    expect(added.toolResult).toContain("C-READ-ONLY");
    expect(existsSync(join(b, "new.txt"))).toBe(true);
    expect(existsSync(join(home, "Workspace", "c", "new.txt"))).toBe(false);
  }, 300_000);
});

/**
 * The CLI's own worktree tool (#448 round 6), for real: EnterWorktree never
 * asks canUseTool (the CLI allows it itself), so codeoid's PreToolUse hook is
 * what stops it in a sandboxed session. Needs only the CLI; the repository is
 * the test's own, in its scratch dir.
 */
describe.skipIf(cli === null || process.env.CODEOID_TEST_CLAUDE_SANDBOX === "0")("the Claude CLI's own worktrees, for real", () => {
  const WORKTREE_PROBE = join(import.meta.dir, "fixtures", "claude-worktree-probe.ts");
  async function enter(mode: "refuse" | "none"): Promise<{ result: string; asked: string[]; toolResult: string | null; worktrees: string[] }> {
    const root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-wt-claude-")));
    try {
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      mkdirSync(join(root, "home"));
      writeFileSync(join(repo, "README"), "hello\n");
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1" };
      for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "init"]]) {
        expect(Bun.spawnSync(["git", ...args], { cwd: repo, env }).exitCode).toBe(0);
      }
      const p = Bun.spawn([process.execPath, WORKTREE_PROBE, repo, mode], { stdout: "pipe", stderr: "pipe", timeout: 150_000 });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("EnterWorktree runs without asking canUseTool, and codeoid's hook refuses it: no worktree is made, the model is told why", async () => {
    const control = await enter("none");
    expect(control.result).toBe("success");
    expect(control.asked).not.toContain("EnterWorktree");
    expect(control.worktrees).toEqual(["probe"]);
    const refused = await enter("refuse");
    expect(refused.result).toBe("success");
    expect(refused.worktrees).toEqual([]);
    expect(refused.toolResult ?? "").toContain("the CLI's own worktrees aren't sandboxed");
  }, 300_000);
});

/**
 * What the Claude CLI's own file tools reach outside its sandbox (#448 round
 * 9), for real: where it writes a background command's output and names
 * its memory dir (both within the gate's carve-outs, host-files.ts), and
 * the Read deny rules an autonomous query carries leaving hidden paths out
 * of its Grep and Glob. Needs only the CLI; the files are the test's own.
 */
describe.skipIf(cli === null || process.env.CODEOID_TEST_CLAUDE_SANDBOX === "0")("the Claude CLI's own context files and searches, for real (#448 round 9)", () => {
  const OWN_PROBE = join(import.meta.dir, "fixtures", "claude-own-files-probe.ts");
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-own-claude-")));
    const ws = join(root, "home", "proj");
    mkdirSync(join(ws, "secretdir"), { recursive: true });
    writeFileSync(join(ws, ".env"), "needle-in-secret\n");
    writeFileSync(join(ws, "secretdir", "x.txt"), "needle-in-dir\n");
    writeFileSync(join(ws, "a.txt"), "needle-in-code\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function run(call: Record<string, unknown>, mode = "none"): Promise<{ result: string; asked: string[]; toolResult: string | null; memDir: string | null }> {
    const file = join(root, `call-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(call));
    const p = Bun.spawn([process.execPath, OWN_PROBE, root, file, mode], { stdout: "pipe", stderr: "pipe", timeout: 150_000 });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
  }

  test("a Read deny rule leaves a hidden file and a hidden dir out of Grep's and Glob's results; without it they show", async () => {
    const grep = { name: "Grep", input: { pattern: "needle", output_mode: "content" } };
    const glob = { name: "Glob", input: { pattern: "**/*.txt" } };
    const open = await run(grep);
    expect(open.toolResult).toContain("needle-in-secret");
    expect(open.toolResult).toContain("needle-in-dir");
    const denied = await run(grep, "deny");
    expect(denied.toolResult).toContain("needle-in-code");
    expect(denied.toolResult).not.toContain("needle-in-secret");
    expect(denied.toolResult).not.toContain("needle-in-dir");
    expect((await run(glob)).toolResult).toContain("secretdir/x.txt");
    const globDenied = await run(glob, "deny");
    expect(globDenied.toolResult).toContain("a.txt");
    expect(globDenied.toolResult).not.toContain("secretdir");
  }, 300_000);

  test("a background command's output and the memory dir the CLI names are inside the gate's carve-outs for it", async () => {
    const { claudeHostFiles } = await import("../daemon/providers/claude/host-files.js");
    const bg = await run({ name: "Bash", input: { command: "echo background-probe-output", description: "probe", run_in_background: true } });
    const output = /Output is being written to: (\S+\.output)/.exec(bg.toolResult ?? "")?.[1];
    expect(output).toBeDefined();
    const own = claudeHostFiles({ configDir: join(root, "home", ".claude"), cliTempDir: join(root, "cli"), workdir: join(root, "home", "proj") });
    expect(own.writable.some((w) => output!.startsWith(`${w}/`))).toBe(true);
    expect(bg.memDir).not.toBeNull();
    expect(own.markdown.some((m) => bg.memDir!.replace(/\/$/, "") === m)).toBe(true);
  }, 300_000);
});
