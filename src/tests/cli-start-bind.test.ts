/**
 * `codeoid start` on a port another daemon holds: it says why and exits 1,
 * instead of logging an unhandled rejection and staying up without a socket,
 * and it leaves that daemon's state alone: no boot recovery runs against the
 * shared database, and its local-mode token stays.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localTokenFilename } from "../daemon/local-auth.js";

describe("codeoid start", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codeoid-start-bind-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** `codeoid start --local` on `port`, sharing this test's config; its exit code and stderr. */
  async function start(port: number | undefined): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "start", "--local", "--no-telegram", "--no-web", "--port", String(port)], {
      env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "cfg"), CODEOID_TRANSCRIPT_DIR: join(root, "t") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 45_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, stderr: await new Response(proc.stderr).text() };
  }

  it("exits 1, saying why, when its port is taken", async () => {
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("first daemon") });
    try {
      const { code, stderr } = await start(taken.port);
      expect(code).toBe(1);
      expect(stderr).toContain("the daemon couldn't start");
    } finally {
      taken.stop(true);
    }
  }, 60_000);

  it("whose port is taken leaves the running daemon's in-flight runs and local-mode token alone", async () => {
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("first daemon") });
    try {
      // The first failed start creates the shared database (its schema).
      expect((await start(taken.port)).code).toBe(1);
      const dbPath = join(root, "cfg", "codeoid", "codeoid.db");
      const db = new Database(dbPath);
      const now = Date.now();
      db.run(
        "INSERT INTO routine_runs (id, routine_id, account_id, project_id, trigger, status, created_at, started_at) VALUES ('run-live', 'r1', 'a', 'p', 'schedule', 'running', ?, ?)",
        [now, now],
      );
      db.close();
      // The running daemon's token for its port.
      const tokenFile = join(root, "cfg", "codeoid", localTokenFilename(String(taken.port)));
      mkdirSync(join(root, "cfg", "codeoid"), { recursive: true });
      writeFileSync(tokenFile, "the-running-daemons-token", { mode: 0o600 });

      expect((await start(taken.port)).code).toBe(1);
      const after = new Database(dbPath);
      try {
        expect(after.query("SELECT status, reason FROM routine_runs WHERE id = 'run-live'").get()).toEqual({ status: "running", reason: null });
      } finally {
        after.close();
      }
      expect(readFileSync(tokenFile, "utf8")).toBe("the-running-daemons-token");
    } finally {
      taken.stop(true);
    }
  }, 120_000);
});
