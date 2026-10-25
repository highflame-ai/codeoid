/** process-tree.ts killMarked: what a finished check left running is stopped. */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killMarked } from "../daemon/process-tree.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.if(process.platform === "linux")("killMarked", () => {
  test("kills a marked process and the children it detached, and nothing unmarked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-kill-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "codeoid-keep-"));
    try {
      // A marked process that starts children in their own sessions.
      const marked = spawn("sh", ["-c", "setsid sleep 30 & setsid sleep 30 & sleep 30"], {
        cwd: elsewhere,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MARK: "m1" },
        detached: true,
        stdio: "ignore",
      });
      const bystander = spawn("sleep", ["30"], { cwd: elsewhere, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: "ignore" });
      await Bun.sleep(200);
      const killed = killMarked("MARK", "m1", dir);
      expect(killed.length).toBeGreaterThanOrEqual(3);
      await Bun.sleep(100);
      for (const pid of killed) expect(alive(pid)).toBe(false);
      expect(alive(bystander.pid!)).toBe(true);
      bystander.kill("SIGKILL");
      marked.unref();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
