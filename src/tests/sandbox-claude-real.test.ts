/**
 * Claude Code's own sandbox with codeoid's policy (#448), for real: the
 * Agent SDK's bundled CLI runs one Bash call against a localhost stand-in for
 * the Messages API (fixtures/claude-sandbox-probe.ts; no model, no vendor).
 * Skipped unless the CLI can sandbox here (Linux with bubblewrap and socat).
 * What the call does is aimed only at files this test planted in its own
 * scratch dir, outside the host's /tmp; nothing runs outside a sandbox but
 * the one call the gate refuses, which therefore never runs.
 */
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

  async function probe(network: string, command: string, extra: string[] = []): Promise<{ result: string; asked: string[]; toolResult: string | null }> {
    const file = join(root, `cmd-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(file, command);
    const p = Bun.spawn([process.execPath, PROBE, root, network, file, ...extra], { stdout: "pipe", stderr: "pipe", timeout: 90_000 });
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

  test("a command asking to run outside the sandbox reaches the gate, and a denial means it never runs", async () => {
    const r = await probe("off", `rm -rf ${outside}; echo RAN`, ["unsandboxed"]);
    expect(r.asked).toEqual(["Bash"]);
    expect(r.toolResult ?? "").not.toContain("RAN");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  }, 120_000);
});
