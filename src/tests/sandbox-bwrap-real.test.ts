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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
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
