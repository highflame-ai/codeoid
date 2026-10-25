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
 * of them still alive. A survivor is matched by pid AND command line, so a pid
 * the OS reused in between is never touched. What this cannot reach, and does
 * not claim to: anything that detached itself before the snapshot (only a
 * cgroup or sandbox boundary bounds that), and a backend whose own process
 * ids are unknown (qwen-code: @qwen-code/sdk spawns its CLI internally).
 *
 * Uses `ps` (Linux, macOS). Unavailable `ps` or Windows: empty snapshots, so
 * terminateBackend degrades to the plain teardown.
 */

import { execFile } from "node:child_process";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  args: string;
}

const PS_TIMEOUT_MS = 3_000;

/** Every process visible to this user: pid, parent pid, command line. */
export function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,args="],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parsePs(stdout));
      },
    );
  });
}

/** Parse `ps -o pid=,ppid=,args=` output. Exported for tests. */
export function parsePs(stdout: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]!.trim() });
  }
  return out;
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

/** The process tree under `roots` right now. */
export async function snapshotTree(roots: readonly number[]): Promise<ProcessEntry[]> {
  if (roots.length === 0) return [];
  return treeOf(await listProcesses(), roots);
}

/**
 * SIGKILL every process of `snapshot` that is still running with the same
 * command line (so a reused pid is spared). Returns the pids signalled.
 */
export async function killSurvivors(snapshot: readonly ProcessEntry[]): Promise<number[]> {
  if (snapshot.length === 0) return [];
  const now = new Map((await listProcesses()).map((p) => [p.pid, p]));
  const killed: number[] = [];
  for (const p of snapshot) {
    if (p.pid === process.pid) continue;
    const live = now.get(p.pid);
    if (!live || live.args !== p.args) continue;
    try {
      process.kill(p.pid, "SIGKILL");
      killed.push(p.pid);
    } catch {
      // already gone, or not ours to signal
    }
  }
  return killed;
}
