/**
 * Real bubblewrap (#448 round 11), skipped where it can't run: with the
 * network off, a local service's unix socket (a database that lets a
 * connection in by who the user is) is out of a sandboxed command's reach;
 * with it on, it is reachable as before. A socket this test makes stands in
 * for /run/postgresql's; no real service is touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec, LOCAL_SERVICE_SOCKET_DIRS } from "../daemon/sandbox/policy.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();

/** Not under the host's /tmp, which the sandbox replaces with its own. */
function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      const p = mkdtempSync(join(dir, "codeoid-svc-probe-"));
      rmSync(p, { recursive: true, force: true });
      return dir;
    } catch {
      /* next */
    }
  }
  return tmpdir();
}

describe.skipIf(!probe.available || !Bun.which("python3"))("bubblewrap, for real: local services' sockets with the network off (#448 round 11)", () => {
  let root: string;
  let server: Server;
  let svc: string;
  let got = "";
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-sbx-svc-")));
    // Stands in for /run/postgresql: a socket a connection gets in by who it is.
    svc = join(root, "postgresql");
    mkdirSync(svc);
    server = createServer((c) =>
      c.on("data", (d) => {
        got += d.toString();
        c.end("PEER-AUTH-OK\n");
      }),
    );
    await new Promise<void>((r) => server.listen(join(svc, ".s.PGSQL.5432"), r));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  test("hidden with the network off, reachable with it on; the spec names the system's database socket dirs only when off", async () => {
    const ws = join(root, "ws");
    const home = join(root, "home");
    mkdirSync(ws, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    writeFileSync(join(ws, "c.py"), `import socket\ns=socket.socket(socket.AF_UNIX)\ns.connect(${JSON.stringify(join(svc, ".s.PGSQL.5432"))})\ns.send(b'startup user=me')\nprint(s.recv(100))\n`);
    const spec = (mode: "on" | "off" | "allowlist") =>
      buildSandboxSpec({ sessionId: `svc-${mode}`, workspace: ws, tempDir: join(root, "tmp"), network: mode === "allowlist" ? { mode, allow: ["example.com"] } : { mode }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" } });
    for (const mode of ["off", "allowlist"] as const) expect(spec(mode).serviceSockets).toEqual(expect.arrayContaining([...LOCAL_SERVICE_SOCKET_DIRS]));
    expect(spec("on").serviceSockets).toBeUndefined();
    const run = async (s: ReturnType<typeof spec>) => {
      const h = await provider.open(s);
      try {
        return await h.exec(["python3", join(ws, "c.py")], { cwd: ws, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 });
      } finally {
        await h.close();
      }
    };
    const off = spec("off");
    const offRun = await run({ ...off, serviceSockets: [...(off.serviceSockets ?? []), svc] });
    // python ran, and its connect found nothing there.
    expect(offRun.exitCode).not.toBe(0);
    expect(String(offRun.stderr)).toMatch(/FileNotFoundError|No such file/);
    expect(String(offRun.stderr)).not.toContain("bwrap:");
    expect(got).toBe("");
    const onRun = await run(spec("on"));
    expect(String(onRun.stdout)).toContain("PEER-AUTH-OK");
  });
});
