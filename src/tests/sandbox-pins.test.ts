/**
 * Every directory a sandbox binds by name is pinned (#448 round 13,
 * pinned.ts; the real-bwrap side is sandbox-pins-real.test.ts): a directory
 * is what was pinned only at its real path, through no link, with its
 * `dev:ino` (the inode alone across a boot); the shell guard a launched argv
 * carries refuses (126) when one isn't; a handle refuses to wrap (bwrap,
 * Seatbelt, Docker); the spec build and Claude's settings refuse a stored
 * pin that changed; a link-named root is used by its real path; the dirs
 * between nested writable roots are pinned, in the hidden home too;
 * canonicalAddedDirs pins a grant and keeps no dir inside another.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeSandboxSettings } from "../daemon/sandbox/claude-native.js";
import { DockerSandboxProvider } from "../daemon/sandbox/docker.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { pinGuardArgv, pinProblem, pinRecord, SandboxPinError, sameDir, unguardedArgv } from "../daemon/sandbox/pinned.js";
import { buildSandboxSpec, nestedRootAncestors, protectedAncestors } from "../daemon/sandbox/policy.js";
import { resolveProjectRoots } from "../daemon/sandbox/project-roots.js";
import { SeatbeltSandboxProvider } from "../daemon/sandbox/seatbelt.js";
import { canonicalAddedDirs } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxSpec } from "../daemon/sandbox/types.js";

let base: string;
beforeAll(() => {
  const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(parent, { recursive: true });
  base = realpathSync(mkdtempSync(join(parent, "codeoid-pins-")));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function scratch(): string {
  const d = join(base, `t${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const GIT_ENV = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" });
function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV(cwd) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-qm", "i"], dir);
  return dir;
}

describe("pins", () => {
  test("a directory is what was pinned at its real path, through no link, with its dev:ino; the inode alone across a boot", () => {
    const d = scratch();
    const a = join(d, "a");
    mkdirSync(a);
    const record = pinRecord(a) as string;
    expect(record).toMatch(/^\d+:\d+@/);
    expect(pinProblem(a, "added directory", { stored: record })).toBeNull();
    // Another directory put in its place (moved aside, made again): not it.
    renameSync(a, join(d, "a-old"));
    mkdirSync(a);
    expect(pinProblem(a, "added directory", { stored: record })).toContain("isn't the directory it was");
    // A link there, even to the very directory: never followed.
    rmSync(a, { recursive: true });
    symlinkSync(join(d, "a-old"), a);
    expect(pinProblem(a, "added directory", { stored: record })).toContain(`added directory ${a} is reached through a symbolic link now (${a})`);
    // A link above it.
    const link = join(d, "via");
    symlinkSync(d, link);
    expect(pinProblem(join(link, "a-old"), "the workspace")).toContain(`(${link})`);
    // Gone.
    expect(pinProblem(join(d, "missing"), "project root")).toContain("is gone");
    expect(pinProblem(join(d, "missing"), "worktree folder", { mayBeMissing: true })).toBeNull();
    // Across a boot the device may be numbered anew: the inode decides.
    const [id = ""] = record.split("@");
    const [, ino] = id.split(":");
    expect(sameDir(`99999:${ino}@another-boot`, `1:${ino}`)).toBe(true);
    expect(sameDir(`99999:${ino}@another-boot`, `1:${Number(ino) + 1}`)).toBe(false);
  });

  test("the guard a launched argv carries: runs the program while every pin holds, refuses (126) once one is a link or another dir", () => {
    const d = scratch();
    const ws = join(d, "ws");
    mkdirSync(ws);
    const st = lstatSync(ws);
    const pins = [{ path: ws, what: "the workspace", id: `${st.dev}:${st.ino}` }, { path: join(d, "folder"), what: "worktree folder", mayBeMissing: true }];
    const argv = pinGuardArgv(pins, ["/bin/sh", "-c", "echo RAN"]);
    expect(unguardedArgv(argv)).toEqual(["/bin/sh", "-c", "echo RAN"]);
    const run = () => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    let r = run();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("RAN\n");
    // Another directory in its place.
    renameSync(ws, join(d, "ws-old"));
    mkdirSync(ws);
    r = run();
    expect(r.exitCode).toBe(126);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toContain("another one is there now");
    // A link in its place, to the very directory.
    rmSync(ws, { recursive: true });
    symlinkSync(join(d, "ws-old"), ws);
    r = run();
    expect(r.exitCode).toBe(126);
    expect(r.stderr.toString()).toContain("a symbolic link is in its path");
    // No pins: the argv as it is.
    expect(pinGuardArgv([], ["x"])).toEqual(["x"]);
  });

  test("a handle refuses to wrap once a pin changed, and its argv carries the guard", () => {
    const d = scratch();
    const ws = join(d, "ws");
    mkdirSync(ws);
    const st = lstatSync(ws);
    const spec = { sessionId: "s", workspace: ws, pins: [{ path: ws, what: "the workspace", id: `${st.dev}:${st.ino}` }] } as unknown as SandboxSpec;
    const h = new LocalSandboxHandle("bwrap", spec, (argv, o) => ({ argv: ["bwrap", ...argv], env: o.env }));
    const w = h.wrap(["true"], { cwd: "", env: {} });
    expect(w.argv[0]).toBe("/bin/sh");
    expect(unguardedArgv(w.argv)).toEqual(["bwrap", "true"]);
    renameSync(ws, join(d, "ws-old"));
    symlinkSync(join(d, "ws-old"), ws);
    expect(() => h.wrap(["true"], { cwd: "", env: {} })).toThrow(SandboxPinError);
    expect(() => h.wrap(["true"], { cwd: "", env: {} })).toThrow("isn't followed");
  });

  test("the spec build refuses a stored pin that changed (workspace, added dir, root); one never pinned is pinned as it is; Claude's settings refuse too", () => {
    const d = scratch();
    const home = join(d, "home");
    const ws = join(home, "W", "a");
    const b = join(home, "W", "b");
    for (const r of [ws, b]) mkdirSync(r, { recursive: true });
    const tmp = join(d, "tmp");
    mkdirSync(tmp);
    const base = { sessionId: "s", workspace: ws, tempDir: tmp, network: { mode: "off" as const }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, git: false, cache: false };
    const pins = { [ws]: pinRecord(ws) as string, [b]: pinRecord(b) as string, [join(home, "W")]: pinRecord(join(home, "W")) as string };
    const spec = buildSandboxSpec({ ...base, addedDirs: [{ dir: b }], projectRoots: [join(home, "W")], pins });
    expect(spec.pins?.map((p) => p.what).slice(0, 3)).toEqual(["the workspace", "added directory", "project root"]);
    for (const p of (spec.pins ?? []).filter((p) => !p.file && !p.mayBeMissing)) expect(p.id).toMatch(/^\d+:\d+$/);
    // b made anew: the build is refused, never laid over whatever is there now.
    renameSync(b, join(d, "b-old"));
    mkdirSync(b);
    expect(() => buildSandboxSpec({ ...base, addedDirs: [{ dir: b }], pins })).toThrow("added directory");
    // The workspace swapped for a link to a planted home.
    renameSync(ws, join(d, "a-old"));
    const fake = join(d, "fake-home");
    mkdirSync(join(fake, ".ssh"), { recursive: true });
    symlinkSync(fake, ws);
    expect(() => buildSandboxSpec({ ...base, pins })).toThrow(`the workspace ${ws} is reached through a symbolic link now`);
    // Not pinned before: a workspace through a link is refused all the same.
    expect(() => buildSandboxSpec({ ...base })).toThrow(SandboxPinError);
    // Claude's own sandbox is told nothing over a changed pin.
    const st = lstatSync(join(d, "a-old"));
    const rt = { spec: { ...spec, workspace: ws, pins: [{ path: ws, what: "the workspace", id: `${st.dev}:${st.ino}` }] }, config: { bwrapPath: undefined } } as never;
    expect(() => claudeSandboxSettings(rt, { HOME: home })).toThrow(SandboxPinError);
  });

  test("a project root named through a link is used, hidden and pinned by where it really is", () => {
    const d = scratch();
    const home = join(d, "home");
    const real = join(home, "Workspace");
    const a = repo(join(real, "a"));
    repo(join(real, "b"));
    writeFileSync(join(real, "b", ".env"), "B=1\n");
    symlinkSync(real, join(home, "code"));
    const r = resolveProjectRoots(["~/code"], a, { home });
    expect(r.roots).toEqual([real]);
    expect(r.notes.join("\n")).toContain(`project root ~/code is ${real} (where it really is)`);
    const tmp = join(d, "tmp");
    mkdirSync(tmp);
    // Given by the link anyway: the spec reads it at its real path, its .env hidden there.
    const spec = buildSandboxSpec({ sessionId: "s", workspace: a, tempDir: tmp, network: { mode: "off" }, hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" }, projectRoots: [join(home, "code")], cache: false });
    expect(spec.projectRoots).toEqual([real]);
    expect(spec.hidden).toContain(join(real, "b", ".env"));
    expect(spec.reexposed).not.toContain(join(home, "code"));
  });

  test("nested writable roots: every dir between them pinned; in the hidden home too (where nothing was pinned before)", () => {
    const d = scratch();
    const home = join(d, "home");
    const b = join(home, "W", "b");
    const lib = join(b, "vendor", "lib");
    mkdirSync(lib, { recursive: true });
    expect(nestedRootAncestors([lib, b], [home])).toEqual([join(b, "vendor")]);
    // A hidden dir inside the outer root: never pinned (its bind would show it).
    expect(nestedRootAncestors([lib, b], [join(b, "vendor")])).toEqual([]);
    // Between a writable root in the hidden home and a hidden path in it.
    mkdirSync(join(b, "sub", "deep"), { recursive: true });
    writeFileSync(join(b, "sub", "deep", ".env"), "x\n");
    expect(protectedAncestors([home, join(b, "sub", "deep", ".env")], [b]).sort()).toEqual([join(b, "sub"), join(b, "sub", "deep")]);
  });
});

describe("canonicalAddedDirs", () => {
  test("by real path, pinned; one inside another isn't kept twice; a grant again is pinned anew", () => {
    const d = scratch();
    const b = join(d, "b");
    mkdirSync(join(b, "sub"), { recursive: true });
    symlinkSync(b, join(d, "alias"));
    const s = canonicalAddedDirs({ addedDirs: [join(d, "alias"), join(b, "sub")] });
    expect(s.addedDirs).toEqual([b]);
    expect(s.pins?.ids[b]).toMatch(/^\d+:\d+@/);
    // Removed, then made anew and granted again: pinned as it is now.
    const removed = canonicalAddedDirs({ addedDirs: [], pins: s.pins }, s);
    expect(removed.pins?.ids[b]).toBeUndefined();
    renameSync(b, join(d, "b-old"));
    mkdirSync(b);
    const again = canonicalAddedDirs({ addedDirs: [b], pins: removed.pins }, removed);
    expect(again.pins?.ids[b]).toBe(pinRecord(b) as string);
    expect(again.pins?.ids[b]).not.toBe(s.pins?.ids[b]);
  });
});

describe("every provider's launch carries the pin guard (#448 round 13)", () => {
  test("Seatbelt and Docker (not runnable here): their argv runs the guard first, and refuses to wrap over a changed pin", async () => {
    const d = scratch();
    const ws = join(d, "ws");
    mkdirSync(ws);
    const st = lstatSync(ws);
    const spec: SandboxSpec = {
      sessionId: "s",
      workspace: ws,
      tempDir: d,
      writable: [],
      hidden: [],
      reexposed: [],
      containerSockets: [],
      network: { mode: "off" },
      unsetEnv: [],
      pins: [{ path: ws, what: "the workspace", id: `${st.dev}:${st.ino}` }],
    };
    const handles = [new SeatbeltSandboxProvider().openSync(spec), await new DockerSandboxProvider({ image: "img", docker: "/usr/bin/docker" }).open(spec)];
    for (const h of handles) {
      const argv = h.wrap?.(["true"], { cwd: ws, env: {} }).argv ?? [];
      expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
      expect(unguardedArgv(argv)[0]).not.toBe("/bin/sh");
    }
    renameSync(ws, join(d, "ws-old"));
    symlinkSync(join(d, "ws-old"), ws);
    for (const h of handles) {
      expect(() => h.wrap?.(["true"], { cwd: ws, env: {} })).toThrow(SandboxPinError);
      await h.close();
    }
  });
});
