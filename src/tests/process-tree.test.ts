/**
 * Tree kill after a backend teardown (process-tree.ts, Session.terminateBackend).
 *
 * The integration case is the one measured against the Claude CLI and the one
 * codex / gemini-cli hit on every teardown: the backend process is SIGKILLed,
 * and the command its tool was running is left behind, re-parented. The
 * snapshot taken before the teardown is what still identifies it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killSurvivors, listProcesses, parsePs, procStartTime, snapshotTree, treeOf } from "../daemon/process-tree.js";
import { argvNamesSession } from "../daemon/providers/claude/index.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Session } from "../daemon/session.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:tree", scopes: [], delegationDepth: 0, accountId: "acc", projectId: "proj" };

describe("parsePs / treeOf", () => {
  const table = parsePs(["  10     1 /sbin/init", "  20    10 backend --serve", "  30    20 /bin/sh -c sleep 99", "  31    30 sleep 99", "  40    10 other", "garbage"].join("\n"));

  test("parses pid, ppid and the full command line", () => {
    expect(table).toHaveLength(5);
    expect(table[2]).toEqual({ pid: 30, ppid: 20, args: "/bin/sh -c sleep 99" });
  });

  test("the tree under a root, root included, nothing else", () => {
    expect(treeOf(table, [20]).map((p) => p.pid)).toEqual([20, 30, 31]);
    expect(treeOf(table, [99])).toEqual([]);
  });

  test("macOS lstart columns: five fields kept as the start token", () => {
    expect(parsePs("  42     1 Sat Oct 24 10:08:43 2026 /bin/sh -c x", { lstart: true })).toEqual([
      { pid: 42, ppid: 1, start: "Sat Oct 24 10:08:43 2026", args: "/bin/sh -c x" },
    ]);
  });

  test.skipIf(process.platform !== "linux")("Linux start time from /proc/<pid>/stat field 22", () => {
    const t = procStartTime(process.pid);
    expect(t).toMatch(/^\d+$/);
    expect(procStartTime(process.pid)).toBe(t);
    expect(procStartTime(2 ** 30)).toBeUndefined();
  });

  test("never includes this process", () => {
    const self = parsePs(`${process.pid} 1 bun test\n77 ${process.pid} child`);
    expect(treeOf(self, [process.pid]).map((p) => p.pid)).toEqual([]);
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A "backend": a shell running a long command in the background, like a tool call. */
function spawnBackend(mark: string): Promise<{ proc: ChildProcess; grandchild: number }> {
  const proc = spawn("sh", ["-c", `sleep ${mark} & echo $!; wait`], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    proc.stdout!.once("data", (d: Buffer) => resolve({ proc, grandchild: Number(String(d).trim()) }));
    proc.once("error", reject);
  });
}

/** A backend whose teardown SIGKILLs its process, as codex / gemini-cli do. */
class ProcessBackend extends MockSessionProvider {
  proc: ChildProcess | null = null;
  async backendProcessIds(): Promise<number[]> {
    return this.proc?.pid ? [this.proc.pid] : [];
  }
  override async teardown(): Promise<void> {
    this.teardownCount++;
    this.proc?.kill("SIGKILL");
  }
}

describe.skipIf(process.platform === "win32")("killing what a backend left running", () => {
  let tmp: string;
  let store: Store;
  let transcriptStore: TranscriptStore;
  const leftovers: number[] = [];
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-tree-"));
    store = new Store(join(tmp, "codeoid.db"));
    transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
  });
  afterEach(async () => {
    for (const pid of leftovers.splice(0)) try { process.kill(pid, "SIGKILL"); } catch {}
    await new Promise<void>((r) => setTimeout(r, 50));
    try { await transcriptStore.flush(); } catch {}
    try { store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  test("killSurvivors: the re-parented grandchild is killed; a pid whose command changed is spared", async () => {
    const mark = String(800000 + Math.floor(Math.random() * 99999));
    const { proc, grandchild } = await spawnBackend(mark);
    leftovers.push(grandchild);
    const snap = await snapshotTree([proc.pid!]);
    expect(snap.map((p) => p.pid)).toContain(grandchild);
    proc.kill("SIGKILL");
    await until(async () => !(await listProcesses()).some((p) => p.pid === proc.pid && !p.args.includes("defunct") && p.args.startsWith("sh")));
    expect(alive(grandchild)).toBe(true); // the teardown alone leaves it
    const forged = snap.map((p) => (p.pid === grandchild ? p : { ...p, args: `${p.args} (other)` }));
    expect(await killSurvivors(forged)).toEqual([grandchild]);
    await until(() => !alive(grandchild));
  });

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")("a different start time means a different process: spared", async () => {
    const mark = String(800000 + Math.floor(Math.random() * 99999));
    const { proc, grandchild } = await spawnBackend(mark);
    leftovers.push(grandchild, proc.pid!);
    const snap = await snapshotTree([proc.pid!]);
    expect(snap.every((p) => p.start !== undefined)).toBe(true);
    expect(await killSurvivors(snap.map((p) => ({ ...p, start: `${p.start}0` })))).toEqual([]);
    expect(alive(grandchild)).toBe(true);
  });

  test("descendants spawned AFTER the snapshot are killed with the survivor", async () => {
    const mark = String(800000 + Math.floor(Math.random() * 99999));
    // The "backend" only starts its long command after we have snapshotted it.
    const proc = spawn("sh", ["-c", `sleep 0.3; sleep ${mark} & echo $!; wait`], { stdio: ["ignore", "pipe", "ignore"] });
    leftovers.push(proc.pid!);
    const snap = await snapshotTree([proc.pid!]);
    expect(snap.some((p) => p.args === `sleep ${mark}`)).toBe(false);
    const late = await new Promise<number>((r) => proc.stdout!.once("data", (d: Buffer) => r(Number(String(d).trim()))));
    leftovers.push(late);
    const killed = await killSurvivors(snap);
    expect(killed).toContain(proc.pid!);
    expect(killed).toContain(late);
    await until(() => !alive(late));
  });

  test("Session.terminateBackend snapshots before the teardown and kills the leftover", async () => {
    const mark = String(800000 + Math.floor(Math.random() * 99999));
    const backend = new ProcessBackend("codex", [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "s1", name: "Bash", input: { command: "x" }, approvalId: "a1" }]], { stall: true });
    const { proc, grandchild } = await spawnBackend(mark);
    leftovers.push(grandchild);
    backend.proc = proc;
    const id = randomUUID();
    store.createSession({
      id, name: "tree", workdir: tmp, status: "idle", createdBy: AUTH.sub,
      createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
    });
    const session = new Session({ name: "tree", workdir: tmp, auth: AUTH, store, transcriptStore, existingId: id, _testProvider: backend, initialMode: { mode: "autonomous" } });
    await session.send("work", AUTH);
    await until(() => session.status === "tool_running");
    await session.terminateBackend(AUTH, "test");
    expect(backend.teardownCount).toBe(1);
    await until(() => !alive(grandchild));
    expect(session.status).toBe("idle");
  });
});

describe("argvNamesSession", () => {
  const id = "0b9a3c1e-1111-4222-8333-444455556666";
  test("the forms the SDK emits, and their two-token spelling", () => {
    expect(argvNamesSession(`/x/claude --output-format stream-json --resume=${id} --verbose`, id)).toBe(true);
    expect(argvNamesSession(`/x/claude --session-id=${id}`, id)).toBe(true);
    expect(argvNamesSession(`/x/claude --resume ${id}`, id)).toBe(true);
    expect(argvNamesSession(`/x/claude --session-id ${id} -p`, id)).toBe(true);
  });
  test("a mention of the id is not a match", () => {
    expect(argvNamesSession(`grep ${id} /tmp/log`, id)).toBe(false);
    expect(argvNamesSession(`/x/claude --resume=${id}-fork`, id)).toBe(false);
    expect(argvNamesSession(`/x/claude --append-system-prompt=--resume=${id}`, id)).toBe(false);
    expect(argvNamesSession(`/x/claude --resume=other ${id}`, id)).toBe(false);
  });
});
