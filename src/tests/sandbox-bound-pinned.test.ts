/**
 * Every path a spec binds is bound as pinned (#448 round 14,
 * sandbox/pinned.ts): bubblewrap, Docker and Seatbelt name it as it was
 * pinned, never where a link put there since leads; the guard a launched argv
 * carries checks held files and directories, with one `stat`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapArgs } from "../daemon/sandbox/bwrap.js";
import { dockerRunArgs } from "../daemon/sandbox/docker.js";
import { pinGuardArgv, pinOf } from "../daemon/sandbox/pinned.js";
import { seatbeltProfile } from "../daemon/sandbox/seatbelt.js";
import type { SandboxSpec } from "../daemon/sandbox/types.js";

const made: string[] = [];
function scratch(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-pinned-")));
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("every path a spec binds is bound as pinned (#448 round 14)", () => {
  test("bubblewrap, Docker and Seatbelt bind a pinned path as it was pinned, never where a link put there since leads", () => {
    const d = scratch();
    const ws = join(d, "ws");
    const held = join(ws, "sub");
    const target = join(d, "daemon-private");
    mkdirSync(ws);
    mkdirSync(target);
    // Pinned while real, swapped for a link afterwards (the handle refuses that; the argv still never resolves it).
    symlinkSync(target, held);
    const spec = {
      sessionId: "s",
      workspace: ws,
      tempDir: join(d, "tmp"),
      writable: [],
      hidden: [],
      readOnly: [],
      pinned: [held],
      reexposed: [],
      containerSockets: [],
      network: { mode: "off" },
      unsetEnv: [],
      pins: [pinOf(ws, "the workspace"), { path: held, what: "a directory held in place", id: "1:2" }],
    } as unknown as SandboxSpec;
    const args = bwrapArgs(spec, ws, (p) => (p === held || p === target || p === ws ? "dir" : null));
    expect(args.join(" ")).toContain(`--bind ${held} ${held}`);
    expect(args).not.toContain(target);
    const docker = dockerRunArgs(spec, ["true"], { image: "x", cwd: ws, envNames: [], uid: 1, gid: 1, kind: (p) => (p === held || p === ws ? "dir" : null) });
    expect(docker.join(" ")).toContain(`source=${held}`);
    expect(docker.join(" ")).not.toContain(target);
    const sb = seatbeltProfile(spec, { real: (p) => (p === held ? target : p), isDir: () => true });
    expect(Object.values(sb.params)).toContain(held);
    expect(Object.values(sb.params)).not.toContain(target);
  });

  test("the launch guard: a held file swapped for a link, a dir replaced: refused (126) with one stat; a missing optional one passes", () => {
    const d = scratch();
    const ws = join(d, "ws");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(join(ws, ".mcp.json"), "{}\n");
    const pins = [pinOf(ws, "the workspace"), pinOf(join(ws, ".claude"), "a path held read-only"), pinOf(join(ws, ".mcp.json"), "a path held read-only"), pinOf(join(ws, "folder"), "worktree folder", { mayBeMissing: true, noId: true })];
    expect(pins[2]).toMatchObject({ file: true });
    const argv = pinGuardArgv(pins, ["/bin/sh", "-c", "echo RAN"]);
    const run = () => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expect(run().stdout.toString()).toBe("RAN\n");
    // The held file swapped for a link.
    renameSync(join(ws, ".mcp.json"), join(d, "mcp-old.json"));
    symlinkSync(join(d, "mcp-old.json"), join(ws, ".mcp.json"));
    let r = run();
    expect(r.exitCode).toBe(126);
    expect(r.stderr.toString()).toContain("a symbolic link is in its path");
    rmSync(join(ws, ".mcp.json"));
    writeFileSync(join(ws, ".mcp.json"), "{}\n");
    expect(run().exitCode).toBe(0);
    // The held dir replaced by another.
    renameSync(join(ws, ".claude"), join(d, "claude-old"));
    mkdirSync(join(ws, ".claude"));
    r = run();
    expect(r.exitCode).toBe(126);
    expect(r.stderr.toString()).toContain("another one is there now");
  });
});
