/**
 * The two small programs the git gateway writes into its own dir at start (docs/git-gateway-design.md §3.1, §3.3),
 * each a shell launcher running codeoid's own runtime on a plain JS file:
 *
 * - `codeoid-git-ext`: what a sandboxed git runs for a gateway remote (`ext::<it> %S <url>`). It opens the session's
 *   socket, says which service and URL, waits for the gateway's word, then relays git's protocol both ways. It runs
 *   inside the sandbox, with nothing a command there couldn't do.
 * - `pre-receive`: the cache repository's hook. It hands the updates, and where the pushed objects wait, to the daemon
 *   over the gateway's private control socket (never in a sandbox), and exits with the daemon's verdict, printing what
 *   it says (git relays it to the agent as `remote: …`).
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * git's ext:: command: `codeoid-git-ext <service> <url>`; the socket in `CODEOID_GIT_GATEWAY`. What git writes goes
 * to the gateway in frames (a 4-byte length, then the bytes; a 0 length when git is done writing), so the end of
 * git's input never depends on a socket's half-close; the gateway's answer comes back as it is, and its close ends it.
 */
export const EXT_JS = `"use strict";
const net = require("node:net");
const [service, url] = process.argv.slice(2);
const path = process.env.CODEOID_GIT_GATEWAY;
const fail = (m) => { process.stderr.write("fatal: codeoid git gateway: " + m + "\\n"); process.exit(128); };
if (!path) fail("this session has no git gateway (its sandbox isn't codeoid's, or it is off)");
if (service !== "git-upload-pack" && service !== "git-receive-pack") fail("unsupported service " + JSON.stringify(service));
const conn = net.connect({ path });
const frame = (d) => { const h = Buffer.alloc(4); h.writeUInt32BE(d.length, 0); conn.write(h); if (d.length) conn.write(d); };
let head = Buffer.alloc(0);
let relaying = false;
const pending = [];
process.stdin.on("data", (d) => { if (relaying) frame(d); else pending.push(d); });
process.stdin.on("end", () => { if (relaying) frame(Buffer.alloc(0)); else pending.push(null); });
conn.on("connect", () => {
  const protocol = /^version=[0-9]$/.test(process.env.GIT_PROTOCOL || "") ? process.env.GIT_PROTOCOL : "";
  conn.write(JSON.stringify({ v: 2, service, url, protocol }) + "\\n");
});
const onHead = (c) => {
  head = Buffer.concat([head, c]);
  const i = head.indexOf(10);
  if (i < 0) { if (head.length > 65536) fail("bad answer"); return; }
  conn.off("data", onHead);
  const status = head.subarray(0, i).toString("utf8");
  const rest = head.subarray(i + 1);
  if (status !== "ok") fail(status.replace(/^error /, ""));
  relaying = true;
  if (rest.length) process.stdout.write(rest);
  for (const d of pending) frame(d === null ? Buffer.alloc(0) : d);
  conn.on("data", (x) => process.stdout.write(x));
};
conn.on("data", onHead);
const done = () => process.stdout.end(() => process.exit(0));
conn.on("end", done);
conn.on("close", done);
// git gone (killed: a tool's time limit, an interrupt): so is this, and the gateway sees the connection close.
// Our parent is git's remote-ext helper; its parent the git the agent ran. Either gone (killed, or the helper orphaned
// when git was), this goes, and the gateway sees the connection close (nothing more is pushed).
const fs = require("node:fs");
const ppidOf = (pid) => {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    if (pid === "self") return process.ppid;
    // No /proc (macOS): ps, by its absolute path.
    try {
      const out = require("node:child_process").execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
      const n = Number(out.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  }
};
const parent = ppidOf("self");
const grandparent = ppidOf(parent);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const parentGone = () => ppidOf("self") !== parent || !alive(parent) || (grandparent !== null && grandparent > 1 && (ppidOf(parent) !== grandparent || !alive(grandparent)));
setInterval(() => { if (parentGone()) { conn.destroy(); process.exit(1); } }, 250).unref();
process.stdout.on("error", () => { conn.destroy(); process.exit(1); });
conn.on("error", (e) => fail(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "the daemon isn't reachable (is it running?)" : e.message));
`;

/** The cache's pre-receive hook: `CODEOID_GW_HOOK` (the control socket) and `CODEOID_GW_TICKET` from the gateway. */
export const HOOK_JS = `"use strict";
const net = require("node:net");
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const updates = Buffer.concat(chunks).toString("utf8").split("\\n").filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    const j = l.indexOf(" ", i + 1);
    return { old: l.slice(0, i), new: l.slice(i + 1, j), ref: l.slice(j + 1) };
  });
  const conn = net.connect({ path: process.env.CODEOID_GW_HOOK || "" });
  let buf = "";
  let verdict = null;
  conn.on("connect", () => conn.write(JSON.stringify({
    ticket: process.env.CODEOID_GW_TICKET || "",
    updates,
    objects: { dir: process.env.GIT_OBJECT_DIRECTORY || "", alternates: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES || "" },
  }) + "\\n"));
  conn.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith("msg ")) process.stderr.write(line.slice(4) + "\\n");
      else if (line === "ok" || line === "no") verdict = line;
    }
  });
  const end = () => process.exit(verdict === "ok" ? 0 : 1);
  conn.on("end", end);
  conn.on("close", end);
  conn.on("error", () => { process.stderr.write("codeoid git gateway: the daemon didn't answer\\n"); process.exit(1); });
});
`;

const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface GatewayScripts {
  /** The dir the sandbox sees (read-only): `codeoid-git-ext` and its JS. */
  binDir: string;
  /** `codeoid-git-ext`'s path. */
  ext: string;
  /** The cache repositories' hooks dir (`pre-receive`): the daemon's only, never in a sandbox. */
  hooksDir: string;
}

/** Write the launchers into `base` (the daemon's own gateway dir, 0700), each atomically. */
// paths: the daemon's own gateway dir (made 0700), its scripts written whole, replaced atomically
export function writeGatewayScripts(base: string, runtime: string): GatewayScripts {
  const binDir = join(base, "bin");
  const hooksDir = join(base, "hooks");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  // The sandbox reads bin (re-exposed read-only): 0755 so a sandbox with another uid map can too.
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  const put = (file: string, body: string, mode: number) => {
    const part = `${file}.${process.pid}.part`;
    writeFileSync(part, body, { mode });
    chmodSync(part, mode);
    renameSync(part, file);
  };
  put(join(binDir, "ext.js"), EXT_JS, 0o644);
  const ext = join(binDir, "codeoid-git-ext");
  put(ext, `#!/bin/sh\nexec ${sh(runtime)} ${sh(join(binDir, "ext.js"))} "$@"\n`, 0o755);
  put(join(base, "hook.js"), HOOK_JS, 0o600);
  put(join(hooksDir, "pre-receive"), `#!/bin/sh\nexec ${sh(runtime)} ${sh(join(base, "hook.js"))}\n`, 0o700);
  return { binDir, ext, hooksDir };
}
