/**
 * The pinned-path API's daemon side (#448 round 14, sandbox/pinned.ts): the
 * daemon's own work in a session's directory checks it before and after,
 * never follows a link (a placeholder, a file rewritten, an empty dir
 * removed), and a snapshot whose work tree is swapped while it is read isn't
 * recorded.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, listCheckpoints, restoreTree } from "../daemon/checkpoints.js";
import { checkPinned, inPinnedDir, makeAt, makeInPinned, PinnedPathError, pinDir, pinRecord, removeEmptyDir, replaceInPinned } from "../daemon/sandbox/pinned.js";

const made: string[] = [];
function scratch(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-pinned-")));
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("the daemon's own use of a pinned directory (#448 round 14)", () => {
  test("pinDir: a directory at its real path, by its identity; a link in its place, or another directory, refused", () => {
    const d = scratch();
    const ws = join(d, "ws");
    mkdirSync(ws);
    const pin = pinDir(ws, "the working directory");
    expect(pin.record).toBe(pinRecord(ws) as string);
    expect(() => checkPinned(pin, "x")).not.toThrow();
    renameSync(ws, join(d, "ws-old"));
    mkdirSync(ws);
    expect(() => checkPinned(pin, "a snapshot")).toThrow("isn't the directory it was (another one is there now); a snapshot refused");
    rmSync(ws, { recursive: true });
    symlinkSync(join(d, "ws-old"), ws);
    expect(() => checkPinned(pin, "a snapshot")).toThrow(PinnedPathError);
    expect(() => pinDir(ws, "the working directory")).toThrow("is reached through a symbolic link now");
    expect(() => pinDir(ws, "the working directory", pin.record)).toThrow(`${ws} changed under the session`);
  });

  test("inPinnedDir: checked before and after; a swap racing the act is said, not taken as done", async () => {
    const d = scratch();
    const ws = join(d, "ws");
    mkdirSync(ws);
    const pin = pinDir(ws, "the working directory");
    expect(await inPinnedDir(pin, "a look", async (p) => p)).toBe(ws);
    await expect(
      inPinnedDir(pin, "putting the files back", async () => {
        renameSync(ws, join(d, "elsewhere"));
        symlinkSync(join(d, "elsewhere"), ws);
      }),
    ).rejects.toThrow("putting the files back refused");
  });

  test("makeInPinned / makeAt: made only in the directory as pinned, never through a link on the way, never over one", () => {
    const d = scratch();
    const ws = join(d, "ws");
    const outside = join(d, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
    const pin = pinDir(ws, "the working directory");
    expect(makeInPinned(pin, ".claude", "dir", "making a placeholder")).toBe(true);
    expect(makeInPinned(pin, ".claude", "dir", "making a placeholder")).toBe(false);
    expect(makeInPinned(pin, ".mcp.json", { content: "{}\n" }, "making a placeholder")).toBe(true);
    expect(readFileSync(join(ws, ".mcp.json"), "utf8")).toBe("{}\n");
    // A link where the file would go: not written through (O_EXCL | O_NOFOLLOW), nothing lands outside.
    symlinkSync(join(outside, "target.json"), join(ws, "opencode.json"));
    expect(makeInPinned(pin, "opencode.json", { content: "{}\n" }, "making a placeholder")).toBe(false);
    expect(existsSync(join(outside, "target.json"))).toBe(false);
    // A link on the way: refused.
    symlinkSync(outside, join(ws, "sub"));
    expect(() => makeInPinned(pin, "sub/.claude", "dir", "making a placeholder")).toThrow("holds a symbolic link on the way");
    expect(existsSync(join(outside, ".claude"))).toBe(false);
    // Out of the directory: refused.
    expect(() => makeInPinned(pin, "../escape", "dir", "making a placeholder")).toThrow("isn't inside it");
    // makeAt: in its parent as it is now.
    expect(makeAt(join(ws, "HEAD"), "dir", "making a placeholder")).toBe(true);
    expect(lstatSync(join(ws, "HEAD")).isDirectory()).toBe(true);
  });

  test("replaceInPinned replaces a link put at the file, never writes where it leads; removeEmptyDir never through a link", () => {
    const d = scratch();
    const common = join(d, "git");
    mkdirSync(join(common, "info"), { recursive: true });
    const outside = join(d, "outside.txt");
    writeFileSync(outside, "keep\n");
    symlinkSync(outside, join(common, "info", "exclude"));
    const pin = pinDir(common, "the repository's git dir");
    replaceInPinned(pin, "info/exclude", "/HEAD\n", "listing placeholders");
    expect(lstatSync(join(common, "info", "exclude")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(common, "info", "exclude"), "utf8")).toBe("/HEAD\n");
    expect(readFileSync(outside, "utf8")).toBe("keep\n");
    // removeEmptyDir: an empty dir goes; one reached through a link stays.
    const loc = join(d, "loc");
    mkdirSync(join(loc, "folder"), { recursive: true });
    const elsewhere = join(d, "elsewhere");
    mkdirSync(join(elsewhere, "folder"), { recursive: true });
    symlinkSync(elsewhere, join(d, "link"));
    expect(removeEmptyDir(join(d, "link", "folder"))).toBe(false);
    expect(existsSync(join(elsewhere, "folder"))).toBe(true);
    expect(removeEmptyDir(join(loc, "folder"))).toBe(true);
    expect(existsSync(join(loc, "folder"))).toBe(false);
  });
});

describe("checkpoints take the work tree pinned (#448 round 14)", () => {
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });

  test("a snapshot whose work tree is swapped while it is read isn't recorded (the check after it); a path given with a link in it is refused", async () => {
    const d = scratch();
    const wd = join(d, "wd");
    mkdirSync(wd);
    writeFileSync(join(wd, "a.txt"), "a\n");
    git(wd, "init", "-q");
    const root = join(d, "checkpoints");
    const pin = pinDir(wd, "the working directory");
    const elsewhere = join(d, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "token.txt"), "PLANTED\n");
    // The swap lands while the files are read (isLate runs inside the read).
    const r = await createCheckpoint({
      root,
      workdir: pin,
      sessionId: "s",
      turnId: "t1",
      isLate: () => {
        renameSync(wd, join(d, "wd-moved"));
        symlinkSync(elsewhere, wd);
        return false;
      },
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("changed under the session");
    expect(r.ok ? false : r.pinned).toBe(true);
    expect((await listCheckpoints(root, "s")).size).toBe(0);
    // A string path is pinned at the call: one reached through a link is refused.
    const viaLink = await createCheckpoint({ root, workdir: wd, sessionId: "s", turnId: "t2" });
    expect(viaLink.ok).toBe(false);
    expect(viaLink.ok ? "" : viaLink.reason).toContain("is reached through a symbolic link now");
    await expect(restoreTree({ root, workdir: wd, sessionId: "s", from: "HEAD", to: "HEAD" })).rejects.toThrow(PinnedPathError);
    expect(readFileSync(join(elsewhere, "token.txt"), "utf8")).toBe("PLANTED\n");
  });
});
