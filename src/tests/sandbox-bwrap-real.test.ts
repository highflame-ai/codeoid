/**
 * Real bubblewrap (#448), skipped where it can't run. Everything destructive
 * here runs INSIDE the sandbox under test, against files this test planted
 * in its own temp dir — never the real home, never `/`.
 *
 *   - a planted credential in a hidden dir (and a fake home's ~/.ssh) is not readable;
 *   - `rm -rf` of a planted dir outside the workspace fails, and it survives;
 *     the fake home is read-only;
 *   - the workspace and the private /tmp are writable;
 *   - with the network off, a TCP server on the host's loopback isn't reachable (on: it is);
 *   - a container socket (a planted listening unix socket, named as one) can't be connected to;
 *   - the daemon's processes (and their environment) aren't visible in /proc;
 *   - a process started inside dies when the handle closes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCheck } from "../daemon/evidence/runner.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec, programLocations } from "../daemon/sandbox/policy.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { sandboxRoot } from "../daemon/sandbox/root.js";
import { openCheckSandbox } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxHandle, SandboxSpec } from "../daemon/sandbox/types.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();
/** A system interpreter for the network probes (the sandbox's /tmp is its own, so nothing under the host's /tmp runs inside). */
const PYTHON = Bun.which("python3");

/**
 * Where the planted files go: NOT under the host's /tmp, which the sandbox
 * replaces with the session's own (anything there is invisible inside,
 * which would make "can't read it" trivially true).
 */
function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const probeDir = mkdtempSync(join(dir, "codeoid-sbx-probe-"));
      rmSync(probeDir, { recursive: true, force: true });
      return dir;
    } catch {
      /* not writable: next */
    }
  }
  return tmpdir();
}

describe.skipIf(!probe.available)("bubblewrap, for real", () => {
  let root: string;
  let ws: string;
  let tmp: string;
  let secretDir: string;
  let outside: string;
  let home: string;
  let sockPath: string;
  let unixServer: Server;
  let tcpServer: Server;
  let tcpPort: number;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-real-")));
    ws = join(root, "ws");
    tmp = join(root, "session-tmp");
    secretDir = join(root, "secrets");
    outside = join(root, "outside-target");
    home = join(root, "home");
    for (const d of [ws, tmp, secretDir, outside, join(home, ".ssh"), join(root, "run")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(secretDir, "id_secret"), "PLANTED-SECRET\n");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PLANTED-KEY\n");
    writeFileSync(join(home, "notes.txt"), "home file\n");
    sockPath = join(root, "run", "docker.sock");
    unixServer = createServer((c) => c.end("hello from the socket\n"));
    await new Promise<void>((r) => unixServer.listen(sockPath, r));
    tcpServer = createServer((c) => c.end("hello over tcp\n"));
    await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", r));
    tcpPort = (tcpServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => unixServer.close(() => r()));
    await new Promise<void>((r) => tcpServer.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  function makeSpec(over: Partial<SandboxSpec> = {}): SandboxSpec {
    return {
      sessionId: "real",
      workspace: ws,
      tempDir: tmp,
      writable: [],
      hidden: [secretDir, join(home, ".ssh")],
      reexposed: [],
      containerSockets: [sockPath],
      network: { mode: "off" },
      unsetEnv: ["SSH_AUTH_SOCK"],
      ...over,
    };
  }

  async function sh(handle: SandboxHandle, script: string, cwd = ws) {
    return handle.exec(["/bin/sh", "-c", script], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SSH_AUTH_SOCK: "/nowhere" }, timeoutMs: 20_000 });
  }

  test("a planted file in a hidden dir, and the fake home's ~/.ssh, can't be read", async () => {
    const h = await provider.open(makeSpec());
    try {
      const r = await sh(h, `cat ${join(secretDir, "id_secret")}; ls -A ${secretDir}; cat ${join(home, ".ssh", "id_ed25519")}; ls -A ${join(home, ".ssh")}; echo done`);
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).not.toContain("id_secret");
      expect(r.stdout).not.toContain("id_ed25519");
      expect(r.stdout).toContain("done");
      // The rest of the fake home is readable: hidden is per location.
      expect((await sh(h, `cat ${join(home, "notes.txt")}`)).stdout).toBe("home file\n");
    } finally {
      await h.close();
    }
  });

  test("rm -rf outside the workspace fails and the planted dir survives; the fake home is read-only", async () => {
    const h = await provider.open(makeSpec());
    try {
      const r = await sh(h, `rm -rf ${outside}; echo "exit=$?"; rm -rf ${home}; echo "home=$?"; touch ${join(home, "new")}; echo "touch=$?"`);
      expect(r.stdout).toContain("exit=1");
      expect(r.stdout).toContain("home=1");
      expect(r.stdout).toContain("touch=1");
      expect(r.stderr).toMatch(/Read-only file system/);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
      expect(existsSync(join(home, ".ssh", "id_ed25519"))).toBe(true);
      expect(existsSync(join(home, "new"))).toBe(false);
      // A hidden dir's tmpfs is read-only too: nothing can be planted there.
      expect((await sh(h, `touch ${join(secretDir, "x")}; echo "planted=$?"`)).stdout).toContain("planted=1");
    } finally {
      await h.close();
    }
  });

  test("the workspace and the private /tmp are writable; the private /tmp is the session's", async () => {
    const h = await provider.open(makeSpec());
    try {
      const r = await sh(h, `echo hi > ${join(ws, "made.txt")} && mkdir -p sub/deeper && echo ok > /tmp/scratch && echo "TMPDIR=$TMPDIR" && cat /tmp/scratch`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("TMPDIR=/tmp");
      expect(readFileSync(join(ws, "made.txt"), "utf8")).toBe("hi\n");
      expect(existsSync(join(ws, "sub", "deeper"))).toBe(true);
      expect(readFileSync(join(tmp, "scratch"), "utf8")).toBe("ok\n");
    } finally {
      await h.close();
    }
  });

  /** A python one-liner that connects, prints what it got, exits 0 on success and 3 on failure. */
  function connectScript(target: string): string {
    return [
      "import socket, sys",
      "try:",
      `    s = socket.socket(${target.startsWith("/") ? "socket.AF_UNIX" : "socket.AF_INET"}, socket.SOCK_STREAM)`,
      "    s.settimeout(5)",
      `    s.connect(${target.startsWith("/") ? JSON.stringify(target) : `("127.0.0.1", ${target})`})`,
      '    print("GOT " + s.recv(100).decode().strip())',
      "except Exception as e:",
      '    print("FAILED " + str(e))',
      "    sys.exit(3)",
    ].join("\n");
  }

  test.skipIf(!PYTHON)("network off: the host's loopback server isn't reachable; network on: it is", async () => {
    const script = connectScript(String(tcpPort));
    const off = await provider.open(makeSpec({ network: { mode: "off" } }));
    try {
      const r = await off.exec([PYTHON as string, "-c", script], { cwd: ws, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 20_000 });
      expect(r.stdout).not.toContain("GOT");
      expect(r.stdout).toContain("FAILED");
      expect(r.exitCode).toBe(3);
    } finally {
      await off.close();
    }
    const on = await provider.open(makeSpec({ network: { mode: "on" } }));
    try {
      const r = await on.exec([PYTHON as string, "-c", script], { cwd: ws, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 20_000 });
      expect(r.stdout).toContain("GOT hello over tcp");
    } finally {
      await on.close();
    }
  });

  test.skipIf(!PYTHON)("a container socket can't be reached, even with the network on", async () => {
    const script = connectScript(sockPath);
    // Control: outside the sandbox the planted socket answers.
    const control = Bun.spawn([PYTHON as string, "-c", script], { cwd: ws, stdout: "pipe" });
    expect(await new Response(control.stdout).text()).toContain("GOT hello from the socket");
    const h = await provider.open(makeSpec({ network: { mode: "on" } }));
    try {
      const r = await h.exec([PYTHON as string, "-c", script], { cwd: ws, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 20_000 });
      expect(r.stdout).not.toContain("GOT");
      expect(r.exitCode).toBe(3);
    } finally {
      await h.close();
    }
  });

  test("the daemon's processes aren't in the sandbox's /proc, and SSH_AUTH_SOCK is unset", async () => {
    const h = await provider.open(makeSpec());
    try {
      const r = await sh(h, `test -e /proc/${process.pid} && echo DAEMON-PID-VISIBLE; cat /proc/1/cmdline | tr '\\0' ' '; echo; echo "sock=[$SSH_AUTH_SOCK]"`);
      expect(r.stdout.split("\n")).not.toContain("DAEMON-PID-VISIBLE");
      expect(r.stdout).toContain("sock=[]");
    } finally {
      await h.close();
    }
  });

  test("the policy's own spec: a fake home's credential stores are hidden, the workspace writable", async () => {
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(join(home, ".aws", "credentials"), "PLANTED-AWS\n");
    writeFileSync(join(home, ".netrc"), "PLANTED-NETRC\n");
    const configDir = join(home, ".codeoid");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "PLANTED-CONFIG\n");
    const spec = buildSandboxSpec({
      sessionId: "policy",
      workspace: ws,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir, env: { HOME: home, PATH: process.env.PATH }, daemonTmp: "/tmp" },
    });
    const h = await provider.open(spec);
    try {
      const r = await sh(h, `cat ~/.aws/credentials ~/.netrc ~/.codeoid/config.json ~/.ssh/id_ed25519 2>&1; echo written > ${join(ws, "ok.txt")} && echo WROTE`);
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).toContain("WROTE");
    } finally {
      await h.close();
    }
  });

  test("closing the handle ends what still runs inside", async () => {
    const h = await provider.open(makeSpec());
    const child = h.spawn("/bin/sh", ["-c", "sleep 30"], { cwd: ws, env: { PATH: process.env.PATH ?? "" } });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    await new Promise((r) => setTimeout(r, 200));
    await h.close();
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

describe.skipIf(!probe.available)("bubblewrap, for real: what the review found (#448)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-review-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a hidden path inside the workspace can't be carried out by renaming its parent", async () => {
    // The workspace is a fake home: ~/.config/gh/hosts.yml is hidden in it.
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    mkdirSync(join(home, ".config", "other"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "PLANTED-GH-TOKEN\n");
    const tmp = join(root, "tmp-a");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({
      sessionId: "rename",
      workspace: home,
      tempDir: tmp,
      network: { mode: "off" },
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
    });
    expect(spec.pinned).toContain(join(home, ".config"));
    const sh = (h: SandboxHandle, script: string) => h.exec(["/bin/sh", "-c", script], { cwd: home, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 });
    const first = await provider.open(spec);
    try {
      const r = await sh(
        first,
        `mv ${join(home, ".config")} ${join(home, "c")}; echo "mv=$?"; mv ${join(home, ".config", "gh")} ${join(home, "g")}; echo "mv2=$?"; echo x > ${join(home, "made")} && echo HOME-WRITABLE; echo x > ${join(home, ".config", "other", "edit.ts")} && echo PINNED-INSIDE-WRITABLE`,
      );
      expect(r.stdout).toContain("mv=1");
      expect(r.stdout).toContain("mv2=1");
      expect(r.stdout).toContain("HOME-WRITABLE");
      // Pinned, not read-only: what is in the dir stays writable (#448 round 1).
      expect(r.stdout).toContain("PINNED-INSIDE-WRITABLE");
    } finally {
      await first.close();
    }
    // Still where it was, so the next sandbox hides it again.
    expect(existsSync(join(home, ".config", "gh", "hosts.yml"))).toBe(true);
    const second = await provider.open(spec);
    try {
      const r = await sh(second, `cat ${join(home, ".config", "gh", "hosts.yml")} ${join(home, "c", "gh", "hosts.yml")} 2>&1; echo done`);
      expect(r.stdout).not.toContain("PLANTED-GH-TOKEN");
    } finally {
      await second.close();
    }
  });

  test("a workspace that holds the daemon's sandbox root (a session in /tmp) can't reach other sessions' launchers or temp dirs", async () => {
    const sandboxes = sandboxRoot();
    const other = mkdtempSync(join(sandboxes, "launch-other-"));
    writeFileSync(join(other, "launch-1"), "#!/bin/sh\necho ORIGINAL\n", { mode: 0o700 });
    const ws = realpathSync(tmpdir());
    const mine = mkdtempSync(join(sandboxes, "tmp-mine-"));
    const spec = buildSandboxSpec({ sessionId: "in-tmp", workspace: ws, tempDir: mine, network: { mode: "off" }, hidden: { home: join(root, "nohome"), configDir: join(root, "nocfg"), env: {}, daemonTmp: ws } });
    const h = await provider.open(spec);
    try {
      const r = await h.exec(["/bin/sh", "-c", `ls ${sandboxes} 2>&1; echo PWNED > ${join(other, "launch-1")} 2>&1; echo "w=$?"`], { cwd: ws, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 });
      expect(r.stdout).not.toContain("launch-other");
      expect(r.stdout).toContain("w=");
      expect(r.stdout).not.toContain("w=0");
    } finally {
      await h.close();
    }
    expect(readFileSync(join(other, "launch-1"), "utf8")).toBe("#!/bin/sh\necho ORIGINAL\n");
    rmSync(other, { recursive: true, force: true });
    rmSync(mine, { recursive: true, force: true });
  });

  test("a loop's check runs in its sandbox: agent-written code in it can't read a credential", async () => {
    const ws = join(root, "check-ws");
    const secrets = join(root, "check-secrets");
    mkdirSync(ws, { recursive: true });
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "token"), "PLANTED-CHECK\n");
    const registry = new SandboxRegistry("linux");
    registry.register(provider);
    const config = { sandbox: { provider: "bwrap", network: "off", allowedHosts: [], hiddenPaths: [secrets], docker: { image: "x" } } } as never;
    const sbx = await openCheckSandbox({ registry, config, setting: undefined, workspace: ws, label: "loop_x" });
    expect(sbx.kind).toBe("on");
    if (sbx.kind !== "on") return;
    const art = join(root, "artifacts");
    try {
      const out = await runCheck({ id: "exit:test", command: `cat ${join(secrets, "token")}; exit 0`, timeoutMs: 20_000 }, { cwd: ws, artifactDir: art, sandbox: { wrap: sbx.wrap } });
      expect(out.isolation).toBe("sandbox");
      expect(out.stdoutExcerpt).not.toContain("PLANTED-CHECK");
    } finally {
      await sbx.close();
    }
    const refused = await runCheck({ id: "exit:test", command: "exit 0", timeoutMs: 5_000 }, { cwd: ws, artifactDir: art, sandbox: { refused: "bubblewrap is not installed" } });
    expect(refused).toMatchObject({ result: "error", reason: "not run: not sandboxed: bubblewrap is not installed" });
  });
});

/** git as the tests run it: a fixed identity, no system or user config, nothing of the real home. */
function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
}

function git(args: string[], cwd: string, home: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(home) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: round 1 of the #448 audit", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-round1-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string> = { PATH: "/usr/bin:/bin" }) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  test("the home is hidden whole: a credential on no list, one created after the start, one replaced by a rename, all unreadable; the allowlist and the workspace in the home are there", async () => {
    const home = join(root, "home-deny");
    const ws = join(home, "proj");
    for (const d of [ws, join(home, ".local", "share", "opencode"), join(home, ".config", "github-copilot"), join(home, ".bun", "bin"), join(home, ".config", "git")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, ".npmrc"), "PLANTED-NPM-TOKEN\n");
    writeFileSync(join(home, ".pgpass"), "PLANTED-PGPASS\n");
    writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), "PLANTED-OPENCODE-LOGIN\n");
    writeFileSync(join(home, ".config", "github-copilot", "apps.json"), "PLANTED-COPILOT\n");
    writeFileSync(join(home, "unlisted-secret.txt"), "PLANTED-UNLISTED\n");
    writeFileSync(join(home, ".claude.json"), "PLANTED-OLD-CLAUDEJSON\n");
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = allowlisted\n");
    writeFileSync(join(home, ".config", "git", "credentials"), "PLANTED-GIT-CRED\n");
    writeFileSync(join(home, ".bun", "bin", "tool"), "#!/bin/sh\necho ALLOWLISTED-TOOL-RAN\n", { mode: 0o755 });
    const tmp = join(root, "tmp-home-deny");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: "home", workspace: ws, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    expect(spec.hidden).toContain(home);
    const h = await provider.open(spec);
    try {
      const reads = [".npmrc", ".pgpass", ".local/share/opencode/auth.json", ".config/github-copilot/apps.json", "unlisted-secret.txt", ".config/git/credentials", ".claude.json"].map((f) => `cat ${join(home, f)} 2>/dev/null`).join("; ");
      // Long-lived: the host replaces and creates credentials while it sleeps.
      const run = sh(
        h,
        ws,
        `${reads}; cat ${join(home, ".gitconfig")}; ${join(home, ".bun", "bin", "tool")}; echo w > ${join(ws, "made.txt")} && echo WS-WRITABLE; echo w > ${join(home, "pwn")} 2>/dev/null || echo HOME-READ-ONLY; sleep 2; cat ${join(home, ".claude.json")} ${join(home, ".aws", "credentials")} 2>/dev/null; echo END`,
      );
      await Bun.sleep(700);
      writeFileSync(join(home, ".claude.json.tmp"), "PLANTED-REPLACED-CLAUDEJSON\n");
      Bun.spawnSync(["mv", join(home, ".claude.json.tmp"), join(home, ".claude.json")]);
      mkdirSync(join(home, ".aws"), { recursive: true });
      writeFileSync(join(home, ".aws", "credentials"), "PLANTED-AWS-LATE\n");
      const r = await run;
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).toContain("name = allowlisted");
      expect(r.stdout).toContain("ALLOWLISTED-TOOL-RAN");
      expect(r.stdout).toContain("WS-WRITABLE");
      expect(r.stdout).toContain("HOME-READ-ONLY");
      expect(r.stdout).toContain("END");
    } finally {
      await h.close();
    }
    expect(readFileSync(join(ws, "made.txt"), "utf8")).toBe("w\n");
    expect(existsSync(join(home, "pwn"))).toBe(false);
  });

  test("a workspace that holds the home (/home): the home inside it stays hidden, even what is replaced or made in it while the sandbox runs", async () => {
    const holder = join(root, "holder");
    const home = join(holder, "u");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id"), "PLANTED-HOLDER-SSH\n");
    writeFileSync(join(home, ".netrc"), "PLANTED-HOLDER-NETRC\n");
    const tmp = join(root, "tmp-holder");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: "holder", workspace: holder, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    // Hidden, so never pinned: a pin is a bind of the real dir, which would show it again.
    expect(spec.pinned).not.toContain(home);
    const h = await provider.open(spec);
    try {
      const run = sh(h, holder, `cat ${join(home, ".ssh", "id")} ${join(home, ".netrc")} 2>/dev/null; sleep 2; cat ${join(home, ".netrc")} ${join(home, "late")} 2>/dev/null; mkdir ${join(home, "made")} 2>/dev/null || echo HOME-NOT-WRITABLE; echo x > ${join(holder, "w")} && echo HOLDER-WRITABLE`);
      await Bun.sleep(700);
      writeFileSync(join(home, ".netrc.tmp"), "PLANTED-HOLDER-REPLACED\n");
      Bun.spawnSync(["mv", join(home, ".netrc.tmp"), join(home, ".netrc")]);
      writeFileSync(join(home, "late"), "PLANTED-HOLDER-LATE\n");
      const r = await run;
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).toContain("HOME-NOT-WRITABLE");
      expect(r.stdout).toContain("HOLDER-WRITABLE");
    } finally {
      await h.close();
    }
    expect(existsSync(join(home, "made"))).toBe(false);
  });

  test("a linked worktree commits from inside (its repository under the home, or under the host's /tmp); the repository's hooks and config stay read-only", async () => {
    for (const where of ["home", "host-tmp"] as const) {
      const home = join(root, `home-git-${where}`);
      mkdirSync(home, { recursive: true });
      const base = where === "home" ? join(home, "src") : realpathSync(mkdtempSync(join(tmpdir(), "codeoid-sbx-gitrepo-")));
      const repo = join(base, "repo");
      mkdirSync(repo, { recursive: true });
      try {
        git(["init", "-q", "-b", "main"], repo, home);
        writeFileSync(join(repo, "a.txt"), "a\n");
        git(["add", "."], repo, home);
        git(["commit", "-qm", "init"], repo, home);
        // Where codeoid puts a session's worktree: beside the repository (here: in the scratch dir, not /tmp).
        const wt = join(root, `wt-${where}`);
        git(["worktree", "add", "-q", "-b", `feat-${where}`, wt], repo, home);
        const tmp = join(root, `tmp-git-${where}`);
        mkdirSync(tmp);
        const spec = buildSandboxSpec({ sessionId: "git", workspace: wt, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
        const h = await provider.open(spec);
        try {
          writeFileSync(join(wt, "new.txt"), "x\n");
          const r = await sh(
            h,
            wt,
            `git add -A && git commit -qm sandboxed && echo COMMITTED; echo bad > ${join(repo, ".git", "hooks", "post-commit")} 2>/dev/null || echo HOOKS-READ-ONLY; echo bad >> ${join(repo, ".git", "config")} 2>/dev/null || echo CONFIG-READ-ONLY`,
            gitEnv(home),
          );
          // git itself says nothing went wrong (no lock it couldn't take); the shell's refusals are the hook and config writes.
          expect(r.stderr).not.toContain("Unable to create");
          expect(r.stderr).not.toContain("fatal");
          expect(r.stdout).toContain("COMMITTED");
          expect(r.stdout).toContain("HOOKS-READ-ONLY");
          expect(r.stdout).toContain("CONFIG-READ-ONLY");
        } finally {
          await h.close();
        }
        expect(git(["log", "--oneline", `feat-${where}`], repo, home)).toContain("sandboxed");
        expect(existsSync(join(repo, ".git", "hooks", "post-commit"))).toBe(false);
        expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("bad");
      } finally {
        if (where === "host-tmp") rmSync(base, { recursive: true, force: true });
      }
    }
  });

  test("a plain repository's hooks and config are read-only from inside, while committing works", async () => {
    const home = join(root, "home-plain");
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo, home);
    const tmp = join(root, "tmp-plain");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: "plain", workspace: repo, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    const h = await provider.open(spec);
    try {
      writeFileSync(join(repo, "f.txt"), "f\n");
      const r = await sh(h, repo, "git add -A && git commit -qm in && echo COMMITTED; echo bad > .git/hooks/pre-commit 2>/dev/null || echo HOOKS-READ-ONLY; git config core.fsmonitor bad 2>/dev/null || echo CONFIG-READ-ONLY", gitEnv(home));
      expect(r.stdout).toContain("COMMITTED");
      expect(r.stdout).toContain("HOOKS-READ-ONLY");
      expect(r.stdout).toContain("CONFIG-READ-ONLY");
    } finally {
      await h.close();
    }
    expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  test("a workspace's .git file naming a credential dir as its git dir makes nothing of it writable or readable", async () => {
    const home = join(root, "home-forged");
    const ws = join(home, "proj");
    const secret = join(home, ".ssh");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(secret, "worktrees", "x"), { recursive: true });
    writeFileSync(join(secret, "id_rsa"), "PLANTED-FORGED-SSH\n");
    // Looks like a worktree's git dir, but git's back-link doesn't name this workspace.
    writeFileSync(join(secret, "worktrees", "x", "gitdir"), "/elsewhere/.git\n");
    writeFileSync(join(ws, ".git"), `gitdir: ${join(secret, "worktrees", "x")}\n`);
    const tmp = join(root, "tmp-forged");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: "forged", workspace: ws, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    expect([...spec.writable, ...spec.reexposed].some((p) => p.startsWith(secret))).toBe(false);
    const h = await provider.open(spec);
    try {
      const r = await sh(h, ws, `cat ${join(secret, "id_rsa")} 2>/dev/null; echo x > ${join(secret, "planted")} 2>/dev/null || echo NOT-WRITABLE`);
      expect(r.stdout).not.toContain("PLANTED-FORGED-SSH");
      expect(r.stdout).toContain("NOT-WRITABLE");
    } finally {
      await h.close();
    }
    expect(existsSync(join(secret, "planted"))).toBe(false);
  });
});

/**
 * Round 2 of the #448 audit: a command inside the sandbox can't change which
 * config, hooks or git dir the user's next git uses. Each variant tries one
 * way in, planting a config whose `core.fsmonitor` is a program that only
 * appends to a marker file in the test's own dir; then "the user's next
 * git" runs, outside the session's sandbox (in a bubblewrap that may write
 * only the test's dir), and must run nothing planted.
 */
describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: round 2 of the #448 audit (git)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-round2-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const sh = (h: SandboxHandle, cwd: string, script: string, env: Record<string, string>) => h.exec(["/bin/sh", "-c", script], { cwd, env, timeoutMs: 30_000 });

  /** A repository with a commit, and (optionally) a linked worktree beside it. */
  function fixture(name: string, opts: { worktree?: boolean; worktreeConfig?: boolean } = {}) {
    const dir = join(root, name);
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo, home);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "."], repo, home);
    git(["commit", "-qm", "init"], repo, home);
    if (opts.worktreeConfig) git(["config", "extensions.worktreeConfig", "true"], repo, home);
    let ws = repo;
    if (opts.worktree) {
      ws = join(dir, "wt");
      git(["worktree", "add", "-q", "-b", "feat", ws], repo, home);
      // Another worktree of the same repository, elsewhere.
      git(["worktree", "add", "-q", "-b", "other", join(dir, "other")], repo, home);
    }
    const marker = join(dir, "RAN-OUTSIDE");
    const mark = join(dir, "mark.sh");
    // The planted program: appends one line to the marker, nothing else.
    writeFileSync(mark, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const spec = buildSandboxSpec({ sessionId: name, workspace: ws, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    return { dir, home, repo, ws, marker, mark, spec, common: join(repo, ".git"), env: gitEnv(home) };
  }

  /** The user's next git in `cwd`, outside the session's sandbox: in a bubblewrap that can write only the test's dir. */
  function userGit(f: { dir: string; home: string }, cwd: string): void {
    const bwrap = provider.binary() as string;
    Bun.spawnSync([bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", f.dir, f.dir, "--chdir", cwd, "--", "git", "status", "--short"], { env: gitEnv(f.home) });
  }

  /** What config the user's git would read in `cwd` (runs nothing). */
  function fsmonitorSeen(f: { home: string }, cwd: string): string {
    return Bun.spawnSync(["git", "config", "--show-origin", "--get-all", "core.fsmonitor"], { cwd, env: gitEnv(f.home) }).stdout.toString();
  }

  test("A: the worktree's .git file can't be pointed at a git dir built inside the workspace", async () => {
    const f = fixture("a", { worktree: true });
    const h = await provider.open(f.spec);
    try {
      const r = await sh(
        h,
        f.ws,
        `cp -r '${f.common}' .evilgit && git --git-dir=.evilgit config core.fsmonitor '${f.mark}' && echo BUILT; printf 'gitdir: %s\\n' "$PWD/.evilgit" > .git && echo REWROTE || echo DOTGIT-READ-ONLY; mv .git .git-moved 2>/dev/null && echo MOVED || echo DOTGIT-PINNED`,
        f.env,
      );
      expect(r.stdout).toContain("BUILT");
      expect(r.stdout).toContain("DOTGIT-READ-ONLY");
      expect(r.stdout).toContain("DOTGIT-PINNED");
    } finally {
      await h.close();
    }
    expect(fsmonitorSeen(f, f.ws)).toBe("");
    userGit(f, f.ws);
    expect(existsSync(f.marker)).toBe(false);
  });

  test("B: the worktree's commondir (and another worktree's) can't be pointed at a repository built inside the workspace", async () => {
    const f = fixture("b", { worktree: true });
    const own = join(f.common, "worktrees", "wt");
    const other = join(f.common, "worktrees", "other");
    const h = await provider.open(f.spec);
    try {
      const r = await sh(
        h,
        f.ws,
        `cp -r '${f.common}' .evilcommon && git --git-dir=.evilcommon config core.fsmonitor '${f.mark}' && echo BUILT; echo "$PWD/.evilcommon" > '${join(own, "commondir")}' && echo REWROTE-OWN || echo OWN-READ-ONLY; echo "$PWD/.evilcommon" > '${join(other, "commondir")}' && echo REWROTE-OTHER || echo OTHER-READ-ONLY; mv '${join(f.common, "worktrees")}' '${join(f.common, "wt-moved")}' 2>/dev/null && echo MOVED || echo WORKTREES-PINNED`,
        f.env,
      );
      expect(r.stdout).toContain("BUILT");
      expect(r.stdout).toContain("OWN-READ-ONLY");
      expect(r.stdout).toContain("OTHER-READ-ONLY");
      expect(r.stdout).toContain("WORKTREES-PINNED");
    } finally {
      await h.close();
    }
    for (const at of [f.ws, join(f.dir, "other")]) {
      expect(fsmonitorSeen(f, at)).toBe("");
      userGit(f, at);
    }
    expect(existsSync(f.marker)).toBe(false);
  });

  test("C: a plain repository's .git can't be renamed and rebuilt", async () => {
    const f = fixture("c");
    const h = await provider.open(f.spec);
    try {
      const r = await sh(h, f.ws, `mv .git .git-old && echo MOVED || echo DOTGIT-PINNED; cp -r .git .git-copy && git --git-dir=.git-copy config core.fsmonitor '${f.mark}' && echo BUILT; git config core.fsmonitor '${f.mark}' 2>/dev/null && echo CONFIG-SET || echo CONFIG-READ-ONLY`, f.env);
      expect(r.stdout).toContain("DOTGIT-PINNED");
      expect(r.stdout).toContain("CONFIG-READ-ONLY");
    } finally {
      await h.close();
    }
    expect(fsmonitorSeen(f, f.ws)).toBe("");
    userGit(f, f.ws);
    expect(existsSync(f.marker)).toBe(false);
  });

  test("D: a worktree's config.worktree can't be planted where the config turns it on (it didn't exist before)", async () => {
    const f = fixture("d", { worktree: true, worktreeConfig: true });
    const own = join(f.common, "worktrees", "wt");
    const h = await provider.open(f.spec);
    try {
      const r = await sh(
        h,
        f.ws,
        `git config -f '${join(own, "config.worktree")}' core.fsmonitor '${f.mark}' 2>/dev/null && echo PLANTED-OWN || echo OWN-READ-ONLY; git config -f '${join(f.common, "worktrees", "other", "config.worktree")}' core.fsmonitor '${f.mark}' 2>/dev/null && echo PLANTED-OTHER || echo OTHER-READ-ONLY; git config --worktree core.fsmonitor '${f.mark}' 2>/dev/null && echo PLANTED-WT || echo WT-READ-ONLY`,
        f.env,
      );
      expect(r.stdout).toContain("OWN-READ-ONLY");
      expect(r.stdout).toContain("OTHER-READ-ONLY");
      expect(r.stdout).toContain("WT-READ-ONLY");
    } finally {
      await h.close();
    }
    for (const at of [f.ws, join(f.dir, "other"), f.repo]) {
      expect(fsmonitorSeen(f, at)).toBe("");
      userGit(f, at);
    }
    expect(existsSync(f.marker)).toBe(false);
  });

  test("E: a commondir can't be created in a plain repository's .git (nor in the repository of a worktree) to send git elsewhere", async () => {
    for (const worktree of [false, true]) {
      const f = fixture(worktree ? "e-wt" : "e", { worktree });
      const h = await provider.open(f.spec);
      try {
        const r = await sh(
          h,
          f.ws,
          `cp -r '${f.common}' "$PWD/.evil" && git --git-dir="$PWD/.evil" config core.fsmonitor '${f.mark}' && echo BUILT; rm -f '${join(f.common, "commondir")}' 2>/dev/null; echo "$PWD/.evil" > '${join(f.common, "commondir")}' 2>/dev/null && echo PLANTED || echo COMMONDIR-READ-ONLY`,
          f.env,
        );
        expect(r.stdout).toContain("BUILT");
        expect(r.stdout).toContain("COMMONDIR-READ-ONLY");
      } finally {
        await h.close();
      }
      expect(fsmonitorSeen(f, f.repo)).toBe("");
      userGit(f, f.repo);
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  test("commits still work from inside: a plain repository, a linked worktree (branch made and deleted too)", async () => {
    for (const worktree of [false, true]) {
      const f = fixture(worktree ? "commit-wt" : "commit", { worktree });
      const h = await provider.open(f.spec);
      try {
        writeFileSync(join(f.ws, "new.txt"), "n\n");
        const r = await sh(h, f.ws, "git add new.txt && git commit -qm inside && echo COMMITTED && git branch tmp-b && git branch -D tmp-b >/dev/null && echo BRANCHED && git stash list >/dev/null && echo OK", f.env);
        expect(r.stderr).not.toContain("Unable to create");
        expect(r.stderr).not.toContain("fatal");
        expect(r.stdout).toContain("COMMITTED");
        expect(r.stdout).toContain("BRANCHED");
      } finally {
        await h.close();
      }
      expect(git(["log", "--oneline", worktree ? "feat" : "main"], f.repo, f.home)).toContain("inside");
    }
  });

  test("F (#448 round 3): a plain repository's .git made invalid (HEAD garbled, refs/ gone) doesn't let git take a repository planted at the workspace's top", async () => {
    for (const variant of ["head", "refs"] as const) {
      const f = fixture(`f-${variant}`);
      const h = await provider.open(f.spec);
      try {
        const invalidate = variant === "head" ? "echo 'not a ref' > .git/HEAD && echo INVALIDATED" : "rm -rf .git/refs && echo INVALIDATED";
        const r = await sh(
          h,
          f.ws,
          `git init -q --bare "$TMPDIR/skel" && cp -r "$TMPDIR/skel/HEAD" "$TMPDIR/skel/objects" "$TMPDIR/skel/refs" "$TMPDIR/skel/config" . 2>/dev/null; git config -f config core.bare false; git config -f config core.worktree "$PWD"; git config -f config core.fsmonitor '${f.mark}' && echo PLANTED; ${invalidate}`,
          f.env,
        );
        expect(r.stdout).toContain("INVALIDATED");
      } finally {
        await h.close();
      }
      userGit(f, f.ws);
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  test("G (#448 round 3): a worktree added after the sandbox opened is read-only from it (its commondir, its gitdir), and so is anything made in worktrees/", async () => {
    for (const worktree of [false, true]) {
      const f = fixture(worktree ? "g-wt" : "g", { worktree });
      const h = await provider.open(f.spec);
      const late = join(f.dir, "late");
      try {
        // The user (or a fork) adds a worktree while the session's sandbox is open.
        git(["worktree", "add", "-q", "-b", "late", late], f.repo, f.home);
        const lateDir = join(f.common, "worktrees", "late");
        const r = await sh(
          h,
          f.ws,
          `cp -r '${f.common}' "$PWD/.evilcommon" && git --git-dir="$PWD/.evilcommon" config core.fsmonitor '${f.mark}' && echo BUILT; echo "$PWD/.evilcommon" > '${join(lateDir, "commondir")}' 2>/dev/null && echo REWROTE || echo LATE-READ-ONLY; echo x > '${join(lateDir, "gitdir")}' 2>/dev/null && echo REWROTE-GITDIR || echo GITDIR-READ-ONLY; mkdir '${join(f.common, "worktrees", "planted")}' 2>/dev/null && echo MADE || echo WORKTREES-READ-ONLY`,
          f.env,
        );
        expect(r.stdout).toContain("BUILT");
        expect(r.stdout).toContain("LATE-READ-ONLY");
        expect(r.stdout).toContain("GITDIR-READ-ONLY");
        expect(r.stdout).toContain("WORKTREES-READ-ONLY");
        // Still commits (the worktree's own git dir stays writable over the read-only worktrees/).
        writeFileSync(join(f.ws, "g.txt"), "g\n");
        const c = await sh(h, f.ws, "git add g.txt && git commit -qm g-inside && echo COMMITTED", f.env);
        expect(c.stdout).toContain("COMMITTED");
      } finally {
        await h.close();
      }
      userGit(f, late);
      expect(existsSync(f.marker)).toBe(false);
    }
  });

  test("H (#448 round 3): a submodule checkout's .git file can't be pointed at a planted git dir; commits from inside work", async () => {
    const dir = join(root, "h");
    const home = join(dir, "home");
    const src = join(dir, "src");
    const sup = join(dir, "super");
    for (const d of [home, src, sup, join(dir, "tmp")]) mkdirSync(d, { recursive: true });
    git(["init", "-q", "-b", "main"], src, home);
    writeFileSync(join(src, "f"), "f\n");
    git(["add", "."], src, home);
    git(["commit", "-qm", "s"], src, home);
    git(["init", "-q", "-b", "main"], sup, home);
    git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "sub"], sup, home);
    const ws = join(sup, "sub");
    const marker = join(dir, "RAN-OUTSIDE");
    const mark = join(dir, "mark.sh");
    writeFileSync(mark, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    const spec = buildSandboxSpec({ sessionId: "h", workspace: ws, tempDir: join(dir, "tmp"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    const h = await provider.open(spec);
    try {
      writeFileSync(join(ws, "new.txt"), "n\n");
      const r = await sh(
        h,
        ws,
        `git add new.txt && git commit -qm sub-inside && echo COMMITTED; git init -q evilgit && git -C evilgit config core.fsmonitor '${mark}' && echo BUILT; printf 'gitdir: ./evilgit/.git\\n' > .git 2>/dev/null && echo REWROTE || echo DOTGIT-READ-ONLY; git config core.fsmonitor '${mark}' 2>/dev/null && echo CONFIG-SET || echo CONFIG-READ-ONLY`,
        gitEnv(home),
      );
      expect(r.stdout).toContain("COMMITTED");
      expect(r.stdout).toContain("BUILT");
      expect(r.stdout).toContain("DOTGIT-READ-ONLY");
      expect(r.stdout).toContain("CONFIG-READ-ONLY");
    } finally {
      await h.close();
    }
    userGit({ dir, home }, ws);
    expect(existsSync(marker)).toBe(false);
  });

  test("I (#448 round 3): remotes/ and branches/ are held read-only, made where missing", async () => {
    const f = fixture("i");
    const h = await provider.open(f.spec);
    try {
      const r = await sh(h, f.ws, "mkdir -p .git/branches .git/remotes 2>/dev/null; echo 'https://example.invalid/x' > .git/branches/x 2>/dev/null && echo BRANCHES-WRITTEN || echo BRANCHES-READ-ONLY; echo 'URL: https://example.invalid/x' > .git/remotes/x 2>/dev/null && echo REMOTES-WRITTEN || echo REMOTES-READ-ONLY", f.env);
      expect(r.stdout).toContain("BRANCHES-READ-ONLY");
      expect(r.stdout).toContain("REMOTES-READ-ONLY");
    } finally {
      await h.close();
    }
  });

  test("checking out and switching branches still work from inside a plain repository with the HEAD placeholder", async () => {
    const f = fixture("switch");
    const h = await provider.open(f.spec);
    try {
      const r = await sh(h, f.ws, "git checkout -q -b topic && echo t > t.txt && git add t.txt && git commit -qm topic && git switch -q main && git merge -q --no-edit topic && echo SWITCHED", f.env);
      expect(r.stderr).not.toContain("fatal");
      expect(r.stdout).toContain("SWITCHED");
    } finally {
      await h.close();
    }
    expect(git(["log", "--oneline", "main"], f.repo, f.home)).toContain("topic");
    expect(git(["status", "--porcelain"], f.repo, f.home)).toBe("");
  });
});

describe.skipIf(!probe.available)("bubblewrap, for real: round 2 of the #448 audit (project settings)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-round2p-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a command can't write the settings agent CLIs run code from: .claude (made when missing), other CLIs' dirs, an existing .mcp.json; the rest of the workspace is writable", async () => {
    const home = join(root, "home");
    const ws = join(root, "ws");
    const tmp = join(root, "tmp");
    for (const d of [home, ws, tmp]) mkdirSync(d, { recursive: true });
    writeFileSync(join(ws, ".mcp.json"), '{"mcpServers":{}}\n');
    const spec = buildSandboxSpec({ sessionId: "proj", workspace: ws, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    const h = await provider.open(spec);
    try {
      const tries = [
        "echo x > .claude/settings.json",
        "echo x > .claude/settings.local.json",
        "mkdir .claude/hooks",
        "mv .claude .claude-old",
        "echo x > .gemini/settings.json",
        "echo x > .qwen/settings.json",
        "echo x > .codex/config.toml",
        "mkdir .pi/extensions",
        "echo x > .opencode/opencode.json",
        "echo x >> .mcp.json",
        "rm -f .mcp.json",
      ];
      const script = `${tries.map((t, i) => `${t} 2>/dev/null && echo WROTE-${i}`).join("; ")}; echo ok > src.txt && echo WS-WRITABLE`;
      const r = await h.exec(["/bin/sh", "-c", script], { cwd: ws, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 });
      expect(r.stdout).not.toContain("WROTE");
      expect(r.stdout).toContain("WS-WRITABLE");
    } finally {
      await h.close();
    }
    expect(existsSync(join(ws, ".claude", "settings.json"))).toBe(false);
    expect(readFileSync(join(ws, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
  });

  test("a project config file that didn't exist (.mcp.json, opencode.json, opencode.jsonc) can't be created at the workspace's top: a placeholder each, held (#448 round 3)", async () => {
    const home = join(root, "home3");
    const ws = join(root, "ws3");
    const tmp = join(root, "tmp3");
    for (const d of [home, ws, tmp]) mkdirSync(d, { recursive: true });
    const spec = buildSandboxSpec({ sessionId: "proj3", workspace: ws, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    const h = await provider.open(spec);
    try {
      const tries = ["opencode.json", "opencode.jsonc", ".mcp.json"].flatMap((f) => [`printf '{"mcp":{}}' > ${f}`, `rm -f ${f}`, `mv ${f} ${f}.old`]);
      const script = `${tries.map((t, i) => `${t} 2>/dev/null && echo WROTE-${i}`).join("; ")}; echo ok > src.txt && echo WS-WRITABLE`;
      const r = await h.exec(["/bin/sh", "-c", script], { cwd: ws, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 });
      expect(r.stdout).not.toContain("WROTE");
      expect(r.stdout).toContain("WS-WRITABLE");
    } finally {
      await h.close();
    }
    expect(readFileSync(join(ws, "opencode.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(ws, "opencode.jsonc"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(ws, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
  });
});

/**
 * Round 2: the home is read-only inside, so the toolchains' caches are
 * pointed at the sandbox's own cache dir (SandboxSpec.env). With the network
 * off: `go build` of a module that depends on one in the user's own module
 * cache (read from it as a file proxy), and `bun install` of a local
 * dependency, both work; the user's own caches aren't written.
 */
describe.skipIf(!probe.available)("bubblewrap, for real: round 2 of the #448 audit (toolchain caches)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-round2c-")));
  });
  afterAll(() => {
    // Go makes its module cache read-only.
    Bun.spawnSync(["chmod", "-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });

  const specFor = (name: string, home: string, ws: string, readable: string[] = []) => {
    const tmp = join(root, `tmp-${name}`);
    mkdirSync(tmp, { recursive: true });
    return buildSandboxSpec({ sessionId: name, workspace: ws, tempDir: tmp, network: { mode: "off" }, backendReadable: readable, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
  };

  test.skipIf(!Bun.which("go") || !Bun.which("zip"))("go build, with a dependency from the user's module cache", async () => {
    const home = join(root, "go-home");
    const ws = join(home, "app");
    const dl = join(home, "go", "pkg", "mod", "cache", "download", "example.com", "dep", "@v");
    const src = join(root, "dep-src", "example.com", "dep@v1.0.0");
    for (const d of [ws, dl, src]) mkdirSync(d, { recursive: true });
    const mod = "module example.com/dep\n\ngo 1.21\n";
    writeFileSync(join(src, "go.mod"), mod);
    writeFileSync(join(src, "dep.go"), 'package dep\n\nfunc Hello() string { return "FROM-DEP" }\n');
    writeFileSync(join(dl, "list"), "v1.0.0\n");
    writeFileSync(join(dl, "v1.0.0.info"), '{"Version":"v1.0.0","Time":"2024-01-01T00:00:00Z"}\n');
    writeFileSync(join(dl, "v1.0.0.mod"), mod);
    expect(Bun.spawnSync(["zip", "-qrD", join(dl, "v1.0.0.zip"), "example.com"], { cwd: join(root, "dep-src") }).exitCode).toBe(0);
    writeFileSync(join(ws, "go.mod"), "module example.com/app\n\ngo 1.21\n\nrequire example.com/dep v1.0.0\n");
    writeFileSync(join(ws, "main.go"), 'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/dep"\n)\n\nfunc main() { fmt.Println(dep.Hello()) }\n');
    const spec = specFor("go", home, ws, [dirname(realpathSync(Bun.which("go") as string))]);
    expect(spec.env?.GOCACHE).toBe(join(home, ".cache", "codeoid-sandbox", "go-build"));
    const h = await provider.open(spec);
    try {
      const r = await h.exec(["/bin/sh", "-c", "go build -o app . && ./app"], {
        cwd: ws,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GOFLAGS: "-mod=mod", GOSUMDB: "off", GOTOOLCHAIN: "local" },
        timeoutMs: 120_000,
      });
      expect(r.stderr).not.toContain("read-only file system");
      expect(r.stdout).toContain("FROM-DEP");
    } finally {
      await h.close();
    }
    // The user's own module cache got nothing new: the module was extracted into the sandbox's.
    expect(existsSync(join(home, "go", "pkg", "mod", "example.com"))).toBe(false);
    expect(existsSync(join(home, ".cache", "codeoid-sandbox", "go-mod", "example.com", "dep@v1.0.0", "dep.go"))).toBe(true);
  }, 180_000);

  test("bun install of a local dependency", async () => {
    const home = join(root, "bun-home");
    const ws = join(home, "app");
    mkdirSync(join(ws, "dep"), { recursive: true });
    // bun's own cache in the home, as an installed bun has it: on the allowlist, read-only inside.
    mkdirSync(join(home, ".bun", "install", "cache"), { recursive: true });
    writeFileSync(join(ws, "dep", "package.json"), '{"name":"dep","version":"1.0.0","main":"index.js"}\n');
    writeFileSync(join(ws, "dep", "index.js"), 'module.exports = "FROM-DEP";\n');
    writeFileSync(join(ws, "package.json"), '{"name":"app","version":"1.0.0","dependencies":{"dep":"file:./dep"}}\n');
    const h = await provider.open(specFor("bun", home, ws, programLocations(process.execPath)));
    try {
      const r = await h.exec(["/bin/sh", "-c", `'${process.execPath}' install --no-progress && '${process.execPath}' -e 'console.log(require("dep"))'`], {
        cwd: ws,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        timeoutMs: 120_000,
      });
      expect(r.stderr).not.toContain("ReadOnlyFileSystem");
      expect(r.stdout).toContain("FROM-DEP");
    } finally {
      await h.close();
    }
  }, 180_000);
});

describe.skipIf(!probe.available)("bubblewrap, for real: round 2 of the #448 audit (~/.local)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-round2l-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a tool in ~/.local/bin linked into ~/.local/share runs, a pip --user package is there, read-only; a link into a credential dir shows nothing of it", async () => {
    const home = join(root, "home");
    const ws = join(home, "proj");
    const venvBin = join(home, ".local", "share", "pipx", "venvs", "tool", "bin");
    const versions = join(home, ".local", "share", "claude", "versions");
    for (const d of [ws, venvBin, versions, join(home, ".local", "bin"), join(home, ".local", "lib", "python3.12", "site-packages", "userpkg"), join(home, ".ssh"), join(root, "tmp")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(venvBin, "tool"), "#!/bin/sh\necho PIPX-TOOL-RAN\n", { mode: 0o755 });
    symlinkSync(join(venvBin, "tool"), join(home, ".local", "bin", "tool"));
    // The Claude installer's layout: a binary per version, linked from ~/.local/bin (a script stands in for it).
    writeFileSync(join(versions, "9.9.9"), "#!/bin/sh\necho INSTALLER-TOOL-RAN\n", { mode: 0o755 });
    symlinkSync(join(versions, "9.9.9"), join(home, ".local", "bin", "claude-like"));
    writeFileSync(join(home, ".local", "lib", "python3.12", "site-packages", "userpkg", "__init__.py"), "X = 1\n");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PLANTED-LINKED-KEY\n");
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(home, ".local", "bin", "sneaky"));
    const spec = buildSandboxSpec({ sessionId: "local", workspace: ws, tempDir: join(root, "tmp"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    const h = await provider.open(spec);
    try {
      const bin = join(home, ".local", "bin");
      const r = await h.exec(
        ["/bin/sh", "-c", `${join(bin, "tool")}; ${join(bin, "claude-like")}; ls ${join(home, ".local", "lib", "python3.12", "site-packages")}; cat ${join(bin, "sneaky")} ${join(home, ".ssh", "id_ed25519")} 2>/dev/null; echo x > ${join(venvBin, "tool")} 2>/dev/null || echo TOOL-READ-ONLY`],
        { cwd: ws, env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 20_000 },
      );
      expect(r.stdout).toContain("PIPX-TOOL-RAN");
      expect(r.stdout).toContain("INSTALLER-TOOL-RAN");
      expect(r.stdout).toContain("userpkg");
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).toContain("TOOL-READ-ONLY");
    } finally {
      await h.close();
    }
  });

  test("a link in the allowlist shows only what is itself allowlisted: one into a project of yours shows nothing of it, .env and keys included (#448 round 3)", async () => {
    const home = join(root, "home3");
    const ws = join(home, "proj");
    const project = join(home, "code", "billing-api");
    for (const d of [ws, join(project, "bin"), join(project, "deploy"), join(home, ".local", "bin"), join(root, "tmp3")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(project, "package.json"), '{"name":"billing-api"}\n');
    writeFileSync(join(project, ".env"), "STRIPE_SECRET_KEY=PLANTED-ENV\n");
    writeFileSync(join(project, "deploy", "prod-key.pem"), "PLANTED-PEM\n");
    writeFileSync(join(project, "bin", "bctl.js"), "#!/bin/sh\necho PROJECT-TOOL-RAN\n", { mode: 0o755 });
    symlinkSync(join(project, "bin", "bctl.js"), join(home, ".local", "bin", "bctl"));
    const spec = buildSandboxSpec({ sessionId: "local3", workspace: ws, tempDir: join(root, "tmp3"), network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    expect(spec.reexposed.filter((p) => p.startsWith(join(home, "code")))).toEqual([]);
    const h = await provider.open(spec);
    try {
      const r = await h.exec(["/bin/sh", "-c", `cat ${join(project, ".env")} ${join(project, "deploy", "prod-key.pem")} ${join(project, "bin", "bctl.js")} 2>/dev/null; ${join(home, ".local", "bin", "bctl")} 2>/dev/null; echo DONE`], {
        cwd: ws,
        env: { PATH: "/usr/bin:/bin", HOME: home },
        timeoutMs: 20_000,
      });
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).not.toContain("PROJECT-TOOL-RAN");
      expect(r.stdout).toContain("DONE");
    } finally {
      await h.close();
    }
  });
});
