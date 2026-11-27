/**
 * A sandboxed command with the network on is a loopback client of the daemon
 * (#448 round 4). In local mode the token is the one thing guarding an agent
 * with shell access, and its file is hidden inside every sandbox; nothing
 * reachable over the loopback without it may hand it out, or give control.
 *
 * Real bubblewrap (skipped where it can't run), a real local-mode daemon on
 * a loopback port with its web UI (a stand-in page), the MCP control
 * endpoint and routines on. From inside the session's sandbox (network on,
 * the default) every route is asked without the token: the page, a deep
 * link, the sign-in exchange with a guessed code, the link endpoint, the
 * health and config routes, the MCP endpoints, a routine's fire API, the
 * OAuth routes, and the WebSocket. None carries the token, none accepts the
 * command. Read-only probes only: nothing is created or changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalUiLinks, mintLocalToken, UI_LINK_START_TTL_MS } from "../daemon/local-auth.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";
import { DaemonServer } from "../daemon/server.js";
import { WebUiFrontend } from "../frontends/web-ui/index.js";

const bwrap = new BwrapSandboxProvider();
const probe = await bwrap.probe();
const CURL = Bun.which("curl");
const PYTHON = Bun.which("python3");
const ready = probe.available && CURL !== null && PYTHON !== null;

/** Not under the host's /tmp, which the sandbox replaces with its own. */
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

/** A WebSocket client in the standard library only: the upgrade, then one auth frame (token from argv), then what the daemon answers. */
const WS_CLIENT = `
import base64, json, os, socket, struct, sys
port, token = int(sys.argv[1]), sys.argv[2]
s = socket.create_connection(("127.0.0.1", port), timeout=5)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(("GET / HTTP/1.1\\r\\nHost: 127.0.0.1:%d\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: %s\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n" % (port, key)).encode())
head = b""
while b"\\r\\n\\r\\n" not in head:
    head += s.recv(1)
print("upgrade:", head.split(b"\\r\\n")[0].decode())
def send(obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    n = len(data)
    hdr = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
send({"type": "session.list", "requestId": "r0"})
send({"type": "auth", "token": token})
send({"type": "session.list", "requestId": "r1"})
out = b""
try:
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        out += chunk
except Exception:
    pass
print("frames:", out[:4000])
`;

describe.skipIf(!ready)("local mode: nothing on the loopback hands a sandboxed command the token (real bubblewrap)", () => {
  const TOKEN = mintLocalToken();
  let root: string;
  let cfg: string;
  let ws: string;
  let daemon: DaemonServer;
  let handle: SandboxHandle;
  let links: LocalUiLinks;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-loopback-")));
    cfg = join(root, "cfg");
    ws = join(root, "home", "proj");
    const dist = join(root, "dist");
    for (const d of [cfg, ws, dist, join(root, "tmp")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>codeoid</title></head><body></body></html>");
    writeFileSync(join(ws, "ws.py"), WS_CLIENT);
    links = new LocalUiLinks();
    daemon = new DaemonServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: join(root, "codeoid.db"),
      transcriptDir: join(root, "transcripts"),
      auth: { baseUrl: "http://127.0.0.1:1/unreachable-issuer" },
      localMode: { token: TOKEN, tokenFile: join(cfg, "local-token") },
      mcpControl: { enabled: true, allowActions: true, requireDelegated: false, allowedOrigins: [], maxWaitSeconds: 5 },
    });
    daemon.use(new WebUiFrontend([], { token: TOKEN, links }, dist));
    await daemon.start();
    // The banner's code exists (one browser may still redeem it): a sandboxed command can't guess it.
    links.mint(UI_LINK_START_TTL_MS);
    const spec = buildSandboxSpec({
      sessionId: "loopback",
      workspace: ws,
      tempDir: join(root, "tmp"),
      network: { mode: "on" },
      config: { sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [], homeReadable: [], docker: { image: "x" } } } as never,
      hidden: { home: join(root, "home"), configDir: cfg, env: { HOME: join(root, "home") }, daemonTmp: "/tmp" },
    });
    handle = await bwrap.open(spec);
  });
  afterAll(async () => {
    await handle?.close();
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function inside(argv: string[]): Promise<string> {
    const r = await handle.exec(argv, { cwd: ws, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home") }, timeoutMs: 30_000 });
    return `${r.stdout}\n${r.stderr}`;
  }

  /** `curl` from inside: the status, then the body. */
  async function curl(method: string, path: string, opts: { body?: string; headers?: string[] } = {}): Promise<{ status: number; body: string }> {
    const args = [CURL ?? "curl", "-s", "-m", "10", "-X", method, "-o", "-", "-w", "\nSTATUS=%{http_code}", ...(opts.headers ?? []).flatMap((h) => ["-H", h])];
    if (opts.body !== undefined) args.push("-H", "Content-Type: application/json", "--data-binary", opts.body);
    const out = await inside([...args, `http://127.0.0.1:${daemon.port}${path}`]);
    const m = /\nSTATUS=(\d+)/.exec(out);
    return { status: m ? Number(m[1]) : 0, body: out };
  }

  test("the token file is hidden, and the daemon is reachable (the network is on)", async () => {
    expect(await inside(["/bin/sh", "-c", `cat ${join(cfg, "local-token")} 2>&1 || echo NO-FILE`])).not.toContain(TOKEN);
    expect((await curl("GET", "/health")).status).toBe(200);
  });

  test("no route answers with the token: the page, a deep link, the assets, config, health, the sign-in routes", async () => {
    const asked: Array<[string, string, { body?: string; headers?: string[] }?]> = [
      ["GET", "/ui/"],
      ["GET", "/ui"],
      ["GET", "/ui/index.html"],
      ["GET", "/ui/sessions/x"],
      ["GET", "/ui/assets/missing.js"],
      ["GET", "/health"],
      ["GET", "/config"],
      ["GET", "/auth/provider"],
      ["POST", "/oauth2/token", { body: "{}" }],
      ["GET", "/ui/local-session"],
      ["POST", "/ui/local-session", { body: JSON.stringify({ code: "guessed" }) }],
      ["POST", "/ui/local-session", { body: "{}" }],
      ["POST", "/ui/local-link", { body: "{}" }],
      ["POST", "/ui/local-link", { body: "{}", headers: ["Authorization: Bearer codeoid_local_guess"] }],
    ];
    for (const [method, path, opts] of asked) {
      const r = await curl(method, path, opts);
      expect(r.status, `${method} ${path}`).toBeGreaterThan(0);
      expect(r.body, `${method} ${path}`).not.toContain(TOKEN);
      expect(r.body, `${method} ${path}`).not.toContain("__CODEOID_LOCAL_TOKEN__");
    }
    // The sign-in routes refuse: no token for a guessed code, no code without the token.
    expect((await curl("POST", "/ui/local-session", { body: JSON.stringify({ code: "guessed" }) })).status).toBe(403);
    const link = await curl("POST", "/ui/local-link", { body: "{}" });
    expect(link.status).toBe(401);
    expect(link.body).not.toContain('"code"');
  });

  test("no route gives control without the token: the MCP endpoints, a routine's fire API", async () => {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: {} } });
    for (const [path, headers] of [
      ["/mcp/control", ["Accept: application/json, text/event-stream"]],
      ["/mcp/control", ["Accept: application/json, text/event-stream", "Authorization: Bearer codeoid_local_guess"]],
      ["/mcp/memory", []],
      ["/mcp/blackboard", []],
      ["/mcp/proxy/x/y", ["Authorization: Bearer guess"]],
      ["/routines/00000000-0000-4000-8000-000000000000/fire", []],
      ["/routines/00000000-0000-4000-8000-000000000000/fire", ["Authorization: Bearer guess"]],
    ] as Array<[string, string[]]>) {
      const r = await curl("POST", path, { body: rpc, headers });
      expect(r.status, path).not.toBe(200);
      expect(r.status, path).not.toBe(202);
      expect(r.body, path).not.toContain(TOKEN);
      expect(r.body, path).not.toContain('"sessions"');
    }
  });

  test("the WebSocket: nothing before the auth frame, and a guessed token is refused (4003) with no session list", async () => {
    for (const token of ["", "codeoid_local_guess"]) {
      const out = await inside([PYTHON ?? "python3", join(ws, "ws.py"), String(daemon.port), token]);
      expect(out).toContain("upgrade: HTTP/1.1 101");
      expect(out).not.toContain("session.list.result");
      expect(out).not.toContain("auth.ok");
      expect(out).not.toContain(TOKEN);
    }
  });

  test("the banner's link still signs one browser in, once (from outside: its code is only in the banner)", async () => {
    const code = links.mint(UI_LINK_START_TTL_MS);
    const ask = () => fetch(`http://127.0.0.1:${daemon.port}/ui/local-session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const first = await ask();
    expect(await first.json()).toEqual({ token: TOKEN });
    expect((await ask()).status).toBe(403);
  });
});
