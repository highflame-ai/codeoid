/**
 * Killing what a backend left running (Session.terminateBackend, supervisor.ts).
 *
 * Tearing a backend down kills ITS process; what that process had started —
 * the shell a tool runs in, and whatever that shell runs — does not always go
 * with it. Measured against the Claude Code CLI (SDK 0.3.281, a fake Messages
 * API driving a real `Bash: sleep` call):
 *
 *   - abort (SIGTERM via the SDK) and Query.interrupt(): the CLI kills the
 *     tool's shell. Nothing survives.
 *   - the CLI SIGKILLed (the SDK's own escalation 5s after a SIGTERM the CLI
 *     didn't act on): the tool's `sleep` SURVIVES, re-parented. Each Bash
 *     call runs in its OWN process group (pgid = the shell's pid), so killing
 *     the CLI's process group would not reach it either.
 *   - a command that detaches itself (`setsid …`, `nohup … &`): survives every
 *     path — it left the tree before anything here looks at it.
 *
 * codex and gemini-cli are stopped with a bare SIGKILL (jsonrpc-stdio.ts), so
 * their running commands are in the second case on every teardown.
 *
 * So the stop is a TREE kill, not a group kill: snapshot every descendant of
 * the backend's own process(es) before the teardown, and after it SIGKILL any
 * of them still alive — with everything under them, including children they
 * spawned after the snapshot. A survivor is matched by pid, command line AND
 * start time, so a pid the OS reused in between is never touched. What this cannot reach, and does
 * not claim to: anything that detached itself before the snapshot (only a
 * cgroup or sandbox boundary bounds that), and a backend whose own process
 * ids are unknown (qwen-code: @qwen-code/sdk spawns its CLI internally).
 *
 * Uses `ps` (Linux, macOS). Unavailable `ps` or Windows: empty snapshots, so
 * terminateBackend degrades to the plain teardown.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  args: string;
  /**
   * When the process started, as an opaque comparable token — Linux:
   * /proc/<pid>/stat field 22 (clock ticks since boot); macOS: ps `lstart`.
   * With pid and command line, the identity a survivor must still match.
   * Absent when it could not be read (the process is gone, or no /proc).
   */
  start?: string;
}

const PS_TIMEOUT_MS = 3_000;
const DARWIN = process.platform === "darwin";

/** `ps` with no COLUMNS (it would truncate `args` even with -ww on some systems). */
function psEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "COLUMNS") env[k] = v;
  return env;
}

/** Every process visible to this user: pid, parent pid, full command line (and start on macOS). */
export function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") return Promise.resolve([]);
  const columns = DARWIN ? "pid=,ppid=,lstart=,args=" : "pid=,ppid=,args=";
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-ww", "-o", columns],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: psEnv() },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parsePs(stdout, { lstart: DARWIN }));
      },
    );
  });
}

/**
 * Parse `ps -o pid=,ppid=[,lstart=],args=` output. `lstart` is five fields
 * ("Sat Oct 24 10:08:43 2026") kept verbatim as the start token. Exported for tests.
 */
export function parsePs(stdout: string, opts: { lstart?: boolean } = {}): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  const line = opts.lstart ? /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/ : /^\s*(\d+)\s+(\d+)\s+(.*)$/;
  for (const text of stdout.split("\n")) {
    const m = line.exec(text);
    if (!m) continue;
    if (opts.lstart) out.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]!.replace(/\s+/g, " "), args: m[4]!.trim() });
    else out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]!.trim() });
  }
  return out;
}

/** Linux: /proc/<pid>/stat field 22 (starttime). The comm field may hold spaces and parens, so count from the last ")". */
export function procStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // fields[0] is field 3 (state); field 22 is fields[19].
    return fields[19];
  } catch {
    return undefined;
  }
}

/** Fill `start` where ps didn't (Linux) — only for the entries that matter. */
function withStart(entries: ProcessEntry[]): ProcessEntry[] {
  if (process.platform !== "linux") return entries;
  return entries.map((p) => (p.start !== undefined ? p : { ...p, ...optional(procStartTime(p.pid)) }));
}
function optional(start: string | undefined): { start?: string } {
  return start === undefined ? {} : { start };
}

/** `roots` (those present) and all their descendants in `table`. Never this process. */
export function treeOf(table: readonly ProcessEntry[], roots: readonly number[]): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  const byPid = new Map<number, ProcessEntry>();
  for (const p of table) {
    byPid.set(p.pid, p);
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out: ProcessEntry[] = [];
  const seen = new Set<number>([process.pid]);
  const queue = roots.filter((pid) => byPid.has(pid) && !seen.has(pid));
  for (const pid of queue) seen.add(pid);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    out.push(byPid.get(pid)!);
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
    }
  }
  return out;
}

/** The process tree under `roots` right now, each entry with its start time. */
export async function snapshotTree(roots: readonly number[]): Promise<ProcessEntry[]> {
  if (roots.length === 0) return [];
  return withStart(treeOf(await listProcesses(), roots));
}

/** Same process: pid, command line, and (when both are known) start time. */
function sameProcess(then: ProcessEntry, now: ProcessEntry): boolean {
  if (then.pid !== now.pid || then.args !== now.args) return false;
  return then.start === undefined || now.start === undefined || then.start === now.start;
}

/**
 * SIGKILL what is left of `snapshot`: every entry still running as the SAME
 * process (pid + command line + start time — a reused pid is spared), and
 * every descendant those have now, including children spawned after the
 * snapshot was taken. One `ps` call. Returns the pids signalled.
 */
export async function killSurvivors(snapshot: readonly ProcessEntry[]): Promise<number[]> {
  if (snapshot.length === 0) return [];
  const table = await listProcesses();
  const now = new Map(table.map((p) => [p.pid, p]));
  const confirmed = withStart(snapshot.map((p) => now.get(p.pid)).filter((p): p is ProcessEntry => p !== undefined))
    .filter((live) => sameProcess(snapshot.find((p) => p.pid === live.pid)!, live))
    .map((p) => p.pid);
  const killed: number[] = [];
  for (const p of treeOf(table, confirmed)) {
    if (p.pid === process.pid) continue;
    try {
      process.kill(p.pid, "SIGKILL");
      killed.push(p.pid);
    } catch {
      // already gone, or not ours to signal
    }
  }
  return killed;
}

/**
 * Kill every process (Linux) that carries `key=value` in its environment or
 * works under `root`: what a finished check left behind, background servers
 * and processes that escaped its process group alike. Not a sandbox — a
 * process that both clears its environment and leaves the directory isn't
 * found. Returns the pids signalled; elsewhere, none.
 */
export function killMarked(key: string, value: string, root: string, since?: number): number[] {
  if (process.platform !== "linux") return [];
  const needle = Buffer.from(`${key}=${value}\0`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const marked = (pid: number): boolean => {
    // Only this user's processes, started since `since` (clock ticks after
    // boot): nothing older can carry the marker or sit in the new directory,
    // and nothing else's memory is read (a process stuck on a hung mount
    // would hold that read).
    try {
      if (uid !== null && statSync(`/proc/${pid}`).uid !== uid) return false;
      if (since !== undefined && Number(procStartTime(pid) ?? 0) < since) return false;
    } catch {
      return false;
    }
    try {
      if (readFileSync(`/proc/${pid}/environ`).includes(needle)) return true;
    } catch {
      // gone, not ours, or not readable
    }
    try {
      // A directory removed since reads as "<path> (deleted)".
      const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
      return cwd === root || cwd.startsWith(`${root}/`);
    } catch {
      return false;
    }
  };
  // Stop what's found and look again until nothing new turns up, so a
  // process that forks as it goes can't outrun the sweep; then kill it all.
  const stopped = new Set<number>();
  for (let pass = 0; pass < 10; pass++) {
    let found = 0;
    let pids: number[];
    try {
      pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
    } catch {
      break;
    }
    for (const pid of pids) {
      if (pid === process.pid || pid === process.ppid || stopped.has(pid) || !marked(pid)) continue;
      try {
        process.kill(pid, "SIGSTOP");
        stopped.add(pid);
        found++;
      } catch {
        // already gone
      }
    }
    if (found === 0) break;
  }
  const killed: number[] = [];
  for (const pid of stopped) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // already gone
    }
  }
  return killed;
}

/** Clock ticks since boot now (as /proc/<pid>/stat's start time counts), on Linux. */
export function ticksNow(): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    // USER_HZ is 100 on every Linux the daemon runs on; a little slack below.
    return Math.floor(Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 100) - 100;
  } catch {
    return undefined;
  }
}
