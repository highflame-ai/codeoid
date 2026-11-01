/**
 * One codeoid daemon per data directory (data-lock.ts): a second start on the
 * same data is refused, naming the holder; a lock left by a process that's
 * gone (pid gone, or reused by another process) is taken over; nothing of a
 * live holder's is touched; the lock goes when the daemon stops.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDaemonLocks,
  DAEMON_LOCK_FILE,
  DataDirLockError,
  daemonOwnedDirs,
  hostView,
  judgeHolder,
  type LockHolder,
  type ProcessView,
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
    const path = plant(dir, { pid: DEAD_PID, hostname: "elsewhere.example" });
    const before = readFileSync(path, "utf8");
    expect(() => acquireDaemonLocks([dir], { log: quiet })).toThrow(/another host \(elsewhere\.example\)/);
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
