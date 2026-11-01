/**
 * One codeoid daemon per data directory (data-lock.ts): a second start on the
 * same data is refused, naming the holder; a lock left by a process that's
 * gone (pid gone, or reused by another process) is taken over; nothing of a
 * live holder's is touched; the lock goes when the daemon stops.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDaemonLocks,
  DAEMON_LOCK_FILE,
  DataDirLockError,
  daemonOwnedDirs,
  HEARTBEAT_STALE_MS,
  hostView,
  judgeHolder,
  type LockHolder,
  type ProcessView,
  refreshLock,
  selfHolder,
} from "../daemon/data-lock.js";
import type { CodeoidConfig } from "../config.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codeoid-data-lock-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const quiet = () => {};

/** A lock file as another daemon would have written it. */
function plant(dir: string, holder: Partial<LockHolder>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DAEMON_LOCK_FILE);
  const self = selfHolder();
  writeFileSync(path, `${JSON.stringify({ ...self, nonce: "other-daemon", since: "2026-01-01T00:00:00.000Z", ...holder }, null, 2)}\n`);
  return path;
}

/** A pid no process has: past the kernel's pid limit. */
const DEAD_PID = 2 ** 22 + 12345;

describe("daemon data-dir lock", () => {
  it("a second daemon on the same dirs is refused, naming the holder and how to clear a stale lock; the first keeps its lock", () => {
    const dirs = [join(root, "data"), join(root, "transcripts")];
    const first = acquireDaemonLocks(dirs, { port: 7400, log: quiet });
    const before = readFileSync(join(dirs[0]!, DAEMON_LOCK_FILE), "utf8");
    let err: unknown;
    try {
      acquireDaemonLocks(dirs, { port: 7401, log: quiet });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DataDirLockError);
    const msg = (err as Error).message;
    expect(msg).toContain(`pid ${process.pid} on ${hostname()}, port 7400`);
    expect(msg).toContain(join(root, "data"));
    expect(msg).toContain(`remove ${join(root, "data", DAEMON_LOCK_FILE)}`);
    // Untouched: the holder's file, as it wrote it.
    expect(readFileSync(join(dirs[0]!, DAEMON_LOCK_FILE), "utf8")).toBe(before);
    expect(existsSync(join(dirs[1]!, DAEMON_LOCK_FILE))).toBe(true);
    first.release();
    expect(existsSync(join(dirs[0]!, DAEMON_LOCK_FILE))).toBe(false);
    expect(existsSync(join(dirs[1]!, DAEMON_LOCK_FILE))).toBe(false);
  });

  it("a refusal on a later dir releases the ones it took", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    const held = acquireDaemonLocks([b], { log: quiet });
    expect(() => acquireDaemonLocks([a, b], { log: quiet })).toThrow(DataDirLockError);
    expect(existsSync(join(a, DAEMON_LOCK_FILE))).toBe(false);
    held.release();
  });

  it("distinct dirs don't conflict", () => {
    const one = acquireDaemonLocks([join(root, "one", "data"), join(root, "one", "t")], { log: quiet });
    const two = acquireDaemonLocks([join(root, "two", "data"), join(root, "two", "t")], { log: quiet });
    expect(one.paths).toHaveLength(2);
    expect(two.paths).toHaveLength(2);
    one.release();
    two.release();
  });

  it("a lock left by a process that no longer runs is taken over, saying so", () => {
    const dir = join(root, "data");
    const path = plant(dir, { pid: DEAD_PID, port: 7400 });
    const lines: string[] = [];
    const locks = acquireDaemonLocks([dir], { log: (l) => lines.push(l) });
    const now = JSON.parse(readFileSync(path, "utf8")) as LockHolder;
    expect(now.pid).toBe(process.pid);
    expect(now.nonce).toBe(locks.holder.nonce);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`pid ${DEAD_PID}`);
    expect(lines[0]).toContain("no longer runs");
    expect(existsSync(`${path}.takeover`)).toBe(false);
    locks.release();
  });

  it("a pid reused by another process is recognised as stale: its start time differs", () => {
    // The pid runs (this very process), but not the process that took the lock.
    const dir = join(root, "data");
    const path = plant(dir, { pid: process.pid, start: "1" });
    const lines: string[] = [];
    if (hostView().startTime(process.pid) === undefined) return; // no start time here (not Linux or macOS)
    const locks = acquireDaemonLocks([dir], { log: (l) => lines.push(l) });
    expect(lines[0]).toContain("now belongs to another process");
    expect((JSON.parse(readFileSync(path, "utf8")) as LockHolder).nonce).toBe(locks.holder.nonce);
    locks.release();
  });

  it("a lock from another host, or one that can't be read, refuses the start and is left as it is", () => {
    const dir = join(root, "data");
    const path = plant(dir, { pid: DEAD_PID, hostname: "elsewhere.example", machine: "f".repeat(32) });
    const before = readFileSync(path, "utf8");
    expect(() => acquireDaemonLocks([dir], { log: quiet })).toThrow(/another machine \(elsewhere\.example\)/);
    expect(readFileSync(path, "utf8")).toBe(before);
    writeFileSync(path, "not json");
    expect(() => acquireDaemonLocks([dir], { log: quiet })).toThrow(/can't be read as a codeoid daemon lock/);
    expect(readFileSync(path, "utf8")).toBe("not json");
  });

  it("judges a holder from what this host can check", () => {
    const self = selfHolder();
    const view = (over: Partial<ProcessView> = {}): ProcessView => ({ hostname: self.hostname, boot: "b1", pidNamespace: "ns1", alive: () => true, startTime: () => "100", ...over });
    const h = { ...self, boot: "b1", pidNamespace: "ns1", start: "100" };
    expect(judgeHolder(h, view()).gone).toBe(false);
    expect(judgeHolder(h, view({ alive: () => false })).gone).toBe(true);
    expect(judgeHolder(h, view({ startTime: () => "200" })).gone).toBe(true);
    expect(judgeHolder(h, view({ boot: "b2" }))).toMatchObject({ gone: true, why: "the machine has restarted since" });
    // Another pid namespace or host: can't be checked, so never taken over.
    expect(judgeHolder(h, view({ pidNamespace: "ns2", alive: () => false })).gone).toBe(false);
    expect(judgeHolder({ ...h, hostname: "other" }, view({ alive: () => false })).gone).toBe(false);
    // A live pid whose start time can't be compared: alive.
    expect(judgeHolder(h, view({ startTime: () => undefined })).gone).toBe(false);
  });

  it("release removes only its own lock: one taken over since stays", () => {
    const dir = join(root, "data");
    const locks = acquireDaemonLocks([dir], { log: quiet });
    const path = join(dir, DAEMON_LOCK_FILE);
    writeFileSync(path, JSON.stringify({ ...selfHolder(), nonce: "the-next-daemon" }));
    locks.release();
    expect(existsSync(path)).toBe(true);
  });

  it("covers the database's dir, the transcripts, opencode's dirs and memory's, each once", () => {
    const cfg = {
      dbPath: join(root, "c", "codeoid.db"),
      transcriptDir: join(root, "c", "transcripts"),
      providers: { opencode: { enabled: true, command: "opencode", dbPath: join(root, "c", "opencode", "opencode.db"), dataDir: join(root, "c", "opencode") } },
      memory: { enabled: true, dbPath: join(root, "m", "memory.db") },
    } as unknown as CodeoidConfig;
    expect(daemonOwnedDirs(cfg)).toEqual([join(root, "c"), join(root, "c", "transcripts"), join(root, "c", "opencode"), join(root, "m")]);
  });
});

describe("codeoid start on data another daemon uses", () => {
  const cli = join(import.meta.dir, "..", "cli.ts");
  /** `codeoid start --local` on `port`, on this test's data. */
  function start(port: number, cfgName = "cfg") {
    return Bun.spawn([process.execPath, cli, "start", "--local", "--no-telegram", "--no-web", "--port", String(port)], {
      env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, cfgName), CODEOID_TRANSCRIPT_DIR: join(root, cfgName, "t") },
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  async function up(port: number): Promise<void> {
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).status < 500) return;
      } catch {
        // not yet
      }
      await Bun.sleep(100);
    }
    throw new Error(`no daemon on ${port}`);
  }
  const freePort = () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const p = s.port;
    s.stop(true);
    return p as number;
  };

  it("is refused on another port, saying who holds it; the lock goes when the first stops, and a new start takes it", async () => {
    const p1 = freePort();
    const first = start(p1);
    try {
      await up(p1);
      const lock = join(root, "cfg", "codeoid", DAEMON_LOCK_FILE);
      expect((JSON.parse(readFileSync(lock, "utf8")) as LockHolder).pid).toBe(first.pid);
      const second = start(freePort());
      expect(await second.exited).toBe(1);
      const stderr = await new Response(second.stderr).text();
      expect(stderr).toContain("the daemon couldn't start: another codeoid daemon");
      expect(stderr).toContain(`pid ${first.pid}`);
      expect(stderr).toContain(`port ${p1}`);
      // A daemon on other data starts alongside.
      const p3 = freePort();
      const other = start(p3, "cfg-other");
      await up(p3);
      other.kill("SIGTERM");
      expect(await other.exited).toBe(0);

      first.kill("SIGTERM");
      expect(await first.exited).toBe(0);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(join(root, "cfg", "t", DAEMON_LOCK_FILE))).toBe(false);
      // A daemon killed outright leaves its lock: the next start takes it over.
      const p4 = freePort();
      const killed = start(p4);
      await up(p4);
      killed.kill("SIGKILL");
      await killed.exited;
      expect(existsSync(lock)).toBe(true);
      const p5 = freePort();
      const next = start(p5);
      await up(p5);
      next.kill("SIGTERM");
      expect(await next.exited).toBe(0);
      expect(await new Response(next.stdout).text()).toContain(`took over the lock ${lock}`);
    } finally {
      first.kill("SIGKILL");
    }
  }, 180_000);
});

describe("round 24: the lock's judgement and its file", () => {
  it("round 24: macOS's start time (`ps -o lstart`) reads the same whatever the caller's time zone and locale", () => {
    const lib = JSON.stringify(join(import.meta.dir, "..", "daemon", "data-lock.ts"));
    const code = `import { processStartTime } from ${lib}; console.log(processStartTime(${process.pid}, "darwin"));`;
    // Each reader runs in its own zone, as two shells would (Bun doesn't hand a changed process.env.TZ to children).
    const read = (env: Record<string, string>) => Bun.spawnSync(["bun", "-e", code], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } }).stdout.toString().trim();
    const utc = read({ TZ: "UTC" });
    expect(utc).toMatch(/\d{4}$/);
    expect(read({ TZ: "JST-9", LC_ALL: "C" })).toBe(utc);
    expect(read({ TZ: "PST8PDT" })).toBe(utc);
  });

  it("round 24: the machine is told by its machine id where both have one, the hostname otherwise", () => {
    const self = selfHolder();
    const view = (over: Partial<ProcessView> = {}): ProcessView => ({ hostname: "box", machine: "m1", boot: "b1", alive: () => false, startTime: () => undefined, ...over });
    const h = { ...self, hostname: "box", machine: "m1", boot: "b1", pidNamespace: undefined, pid: DEAD_PID };
    // Same hostname, another machine (a cloned name): a live holder there is never taken over, even with another boot.
    expect(judgeHolder({ ...h, machine: "m2", boot: "b2" }, view())).toMatchObject({ gone: false });
    // Same machine renamed after a crash: its dead holder is taken over.
    expect(judgeHolder({ ...h, hostname: "old-name" }, view()).gone).toBe(true);
    // No machine id on one side: the hostname decides.
    expect(judgeHolder({ ...h, machine: undefined, hostname: "other" }, view()).gone).toBe(false);
  });

  it("round 24: a lock from another pid namespace (a container restarted after a crash) is taken over once not refreshed for a while", () => {
    const self = selfHolder();
    const view: ProcessView = { hostname: self.hostname, boot: "b1", pidNamespace: "ns-new", alive: () => true, startTime: () => "1" };
    const h = { ...self, boot: "b1", pidNamespace: "ns-old" };
    expect(judgeHolder(h, view, 30_000).gone).toBe(false);
    expect(judgeHolder(h, view).gone).toBe(false);
    expect(judgeHolder(h, view, HEARTBEAT_STALE_MS + 1).gone).toBe(true);
    const dir = join(root, "data");
    const path = plant(dir, { pidNamespace: "pid:[1]", pid: DEAD_PID });
    const v = { ...hostView(), pidNamespace: "pid:[2]" };
    expect(() => acquireDaemonLocks([dir], { view: v, log: quiet, heartbeat: false })).toThrow(/refreshed for 10 minutes/);
    const old = new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000);
    utimesSync(path, old, old);
    const lines: string[] = [];
    const took = acquireDaemonLocks([dir], { view: v, log: (l) => lines.push(l), heartbeat: false });
    expect(lines.join("\n")).toMatch(/hasn't been refreshed/);
    took.release();
  });

  it("round 24: a holder refreshes its own lock's mtime, never another's", () => {
    const dir = join(root, "data");
    const held = acquireDaemonLocks([dir], { log: quiet, heartbeat: false });
    const path = join(dir, DAEMON_LOCK_FILE);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path, old, old);
    expect(refreshLock(path, "someone-else")).toBe(false);
    expect(Date.now() - statSync(path).mtimeMs).toBeGreaterThan(3_000_000);
    expect(refreshLock(path, held.holder.nonce)).toBe(true);
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000);
    held.release();
  });

  it("round 24: a takeover guard left by a start that died doesn't block later starts", () => {
    const dir = join(root, "data");
    const path = plant(dir, { pid: DEAD_PID });
    writeFileSync(`${path}.takeover`, JSON.stringify({ ...selfHolder(), pid: DEAD_PID + 1, nonce: "crashed-start" }));
    const lines: string[] = [];
    const took = acquireDaemonLocks([dir], { log: (l) => lines.push(l), heartbeat: false });
    expect(lines.join("\n")).toMatch(/removed the takeover guard/);
    expect(existsSync(`${path}.takeover`)).toBe(false);
    took.release();
    // A guard whose start still runs is still waited for, then refused.
    plant(dir, { pid: DEAD_PID });
    writeFileSync(`${path}.takeover`, JSON.stringify({ ...selfHolder(), nonce: "running-start" }));
    expect(() => acquireDaemonLocks([dir], { log: quiet, heartbeat: false })).toThrow(/is taking over the stale lock/);
  });

  it("round 24: directories the lock makes are 0700; an existing one isn't changed", () => {
    const made = join(root, "new", "nested");
    const held = acquireDaemonLocks([made], { log: quiet, heartbeat: false });
    expect(statSync(made).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "new")).mode & 0o777).toBe(0o700);
    held.release();
    const existing = join(root, "open");
    mkdirSync(existing);
    chmodSync(existing, 0o750);
    acquireDaemonLocks([existing], { log: quiet, heartbeat: false }).release();
    expect(statSync(existing).mode & 0o777).toBe(0o750);
  });

  it("round 24: a lock path that is a symlink, a FIFO or too big is refused without following, blocking or reading it all", () => {
    const dir = join(root, "data");
    mkdirSync(dir);
    const path = join(dir, DAEMON_LOCK_FILE);
    const target = join(root, "planted.json");
    writeFileSync(target, JSON.stringify({ ...selfHolder(), nonce: "x" }));
    symlinkSync(target, path);
    expect(() => acquireDaemonLocks([dir], { log: quiet, heartbeat: false })).toThrow(/symbolic link/);
    rmSync(path);
    const mk = Bun.spawnSync(["mkfifo", path]);
    expect(mk.exitCode).toBe(0);
    const t0 = Date.now();
    expect(() => acquireDaemonLocks([dir], { log: quiet, heartbeat: false })).toThrow(/isn't a regular file/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    rmSync(path);
    writeFileSync(path, "x".repeat(100_000));
    expect(() => acquireDaemonLocks([dir], { log: quiet, heartbeat: false })).toThrow(/too big/);
  });

  it("round 24: a temp file a dead start left is swept once old", () => {
    const dir = join(root, "data");
    mkdirSync(dir);
    const old = join(dir, `${DAEMON_LOCK_FILE}.${DEAD_PID}.0123456789ab.tmp`);
    const fresh = join(dir, `${DAEMON_LOCK_FILE}.${DEAD_PID}.ba9876543210.tmp`);
    writeFileSync(old, "{}");
    writeFileSync(fresh, "{}");
    const t = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, t, t);
    acquireDaemonLocks([dir], { log: quiet, heartbeat: false }).release();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("round 24: a signal before the daemon's handlers are in releases the lock", async () => {
    const dir = join(root, "data");
    const script = join(root, "hold.ts");
    writeFileSync(
      script,
      `import { acquireDaemonLocks } from ${JSON.stringify(join(import.meta.dir, "..", "daemon", "data-lock.ts"))};\nacquireDaemonLocks([${JSON.stringify(dir)}], { log: () => {} });\nconsole.log("held");\nsetInterval(() => {}, 1000);\n`,
    );
    const child = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");
    expect(existsSync(join(dir, DAEMON_LOCK_FILE))).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(existsSync(join(dir, DAEMON_LOCK_FILE))).toBe(false);
  });
});
