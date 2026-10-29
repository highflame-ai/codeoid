/**
 * fs handler tests — entry relativisation, hidden-name filtering, sorting,
 * and symlink-escape rejection. Pins the behavior around the #89 fix: the
 * workdir is canonicalised ONCE per fs.list call (in resolveSafe) instead of
 * once per directory entry, and entry paths stay relative to the canonical
 * root even when the caller hands us a symlinked workdir alias.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FsAccessError, handleFsBrowseDir, handleFsList, handleFsRead, isProtectedPath, resolveSafe } from "../daemon/fs.js";
import { getConfigDir } from "../config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-fs-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe("resolveSafe", () => {
  it("returns the canonical workdir root alongside the resolved path", async () => {
    mkdirSync(join(tmp, "sub"));
    const r = await resolveSafe(tmp, "sub");
    expect(r.relative).toBe("sub");
    expect(r.absolute).toBe(join(r.workdirRoot, "sub"));
  });

  it("rejects symlink escapes out of the workdir", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codeoid-fs-outside-"));
    try {
      symlinkSync(outside, join(tmp, "escape"));
      await expect(resolveSafe(tmp, "escape")).rejects.toThrow(FsAccessError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── Protected directories (GHSA-38vh vector 2) ────────────────────────────────

describe("protected directories", () => {
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it("isProtectedPath flags the daemon config dir and host credential dirs", () => {
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    const configDir = getConfigDir(); // <tmp>/xdg/codeoid
    expect(isProtectedPath(join(configDir, "config.json"))).toBe(true);
    expect(isProtectedPath(configDir)).toBe(true);
    expect(isProtectedPath(join(homedir(), ".ssh", "id_rsa"))).toBe(true);
    expect(isProtectedPath(join(homedir(), ".aws", "credentials"))).toBe(true);
    expect(isProtectedPath(join(tmp, "project", "src", "index.ts"))).toBe(false);
  });

  it("resolveSafe refuses a path inside the daemon config dir even from an ancestor workdir", async () => {
    // Point the config dir under our tmp so the test is hermetic, then root a
    // session AT that config home — the exploit's `workdir: "~"` shape.
    const configHome = join(tmp, "xdg");
    process.env.XDG_CONFIG_HOME = configHome;
    const configDir = getConfigDir(); // <configHome>/codeoid
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), '{"apiKey":"zid_sk_ROOT"}');

    await expect(resolveSafe(configHome, "codeoid/config.json")).rejects.toThrow(
      FsAccessError,
    );
    // fs.read through the same chokepoint is refused too.
    await expect(
      handleFsRead({ id: "r", path: "codeoid/config.json" }, configHome),
    ).rejects.toThrow(FsAccessError);

    // A non-protected sibling under the same workdir still resolves fine.
    writeFileSync(join(configHome, "notes.txt"), "hello");
    const r = await resolveSafe(configHome, "notes.txt");
    expect(r.relative).toBe("notes.txt");
  });
});

describe("handleFsList", () => {
  it("lists entries relative to the workdir, dirs first, hidden names excluded", async () => {
    mkdirSync(join(tmp, "sub"));
    mkdirSync(join(tmp, "node_modules"));
    writeFileSync(join(tmp, "a.txt"), "a");
    writeFileSync(join(tmp, "sub", "b.txt"), "b");

    const res = await handleFsList({ id: "r1", path: "" }, tmp);
    expect(res.entries.map((e) => e.name)).toEqual(["sub", "a.txt"]);
    expect(res.entries[0]!.kind).toBe("directory");
    expect(res.entries[1]!.kind).toBe("file");

    const subRes = await handleFsList({ id: "r2", path: "sub" }, tmp);
    expect(subRes.entries.map((e) => e.path)).toEqual([join("sub", "b.txt")]);
  });

  it("relativises children against the canonical root when the workdir is a symlink", async () => {
    // Some platforms hand out symlinked workdirs (macOS /tmp → /private/tmp).
    // List THROUGH an alias — entry paths must be relative to the canonical
    // root, same as before the per-entry realpath was hoisted.
    const real = join(tmp, "real-root");
    const alias = join(tmp, "alias-root");
    mkdirSync(real);
    writeFileSync(join(real, "f.txt"), "x");
    symlinkSync(real, alias);

    const res = await handleFsList({ id: "r3", path: "" }, alias);
    expect(res.entries.map((e) => e.path)).toEqual(["f.txt"]);
  });
});

// ── fs.browse_dir (the workdir picker) ────────────────────────────────────────

describe("handleFsBrowseDir", () => {
  let savedRoot: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedRoot = process.env.CODEOID_FS_BROWSE_ROOT;
    savedXdg = process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.CODEOID_FS_BROWSE_ROOT;
    else process.env.CODEOID_FS_BROWSE_ROOT = savedRoot;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it("opens at home and reaches outside it when no root is configured", async () => {
    delete process.env.CODEOID_FS_BROWSE_ROOT;
    const home = realpathSync(homedir());
    const start = await handleFsBrowseDir({ id: "b1" });
    expect(start.root).toBe("/");
    expect(start.path).toBe(home);
    expect(start.home).toBe(home);

    // A directory outside home — the case the old HOME-only root refused.
    const outside = await handleFsBrowseDir({ id: "b2", path: realpathSync(tmp) });
    expect(outside.path).toBe(realpathSync(tmp));
    const top = await handleFsBrowseDir({ id: "b3", path: "/" });
    expect(top.parent).toBeNull();
  });

  it("expands ~ and flags git repos (a clone's .git dir or a worktree's .git file)", async () => {
    process.env.CODEOID_FS_BROWSE_ROOT = tmp;
    mkdirSync(join(tmp, "clone", ".git"), { recursive: true });
    mkdirSync(join(tmp, "worktree"));
    writeFileSync(join(tmp, "worktree", ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(tmp, "plain"));
    const r = await handleFsBrowseDir({ id: "b4", path: tmp });
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    expect(byName.clone?.isGitRepo).toBe(true);
    expect(byName.worktree?.isGitRepo).toBe(true);
    expect(byName.plain?.isGitRepo).toBeUndefined();
    expect((await handleFsBrowseDir({ id: "b5", path: join(tmp, "clone") })).isGitRepo).toBe(true);

    delete process.env.CODEOID_FS_BROWSE_ROOT;
    const tilde = await handleFsBrowseDir({ id: "b6", path: "~" });
    expect(tilde.path).toBe(realpathSync(homedir()));
  });

  it("hides dot and build dirs unless asked, never VCS internals, and counts what it hid", async () => {
    process.env.CODEOID_FS_BROWSE_ROOT = tmp;
    for (const d of ["src", ".cache", "node_modules", ".git"]) mkdirSync(join(tmp, d));
    writeFileSync(join(tmp, ".env"), "x"); // a file — not a hidden folder
    const quiet = await handleFsBrowseDir({ id: "b7", path: tmp });
    expect(quiet.entries.map((e) => e.name)).toEqual(["src"]);
    expect(quiet.hiddenCount).toBe(2);
    const loud = await handleFsBrowseDir({ id: "b8", path: tmp, showHidden: true });
    expect(loud.entries.map((e) => e.name)).toEqual([".cache", "node_modules", "src"]);
    expect(loud.hiddenCount).toBeUndefined();
  });

  it("refuses protected dirs and never lists them", async () => {
    process.env.CODEOID_FS_BROWSE_ROOT = tmp;
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    mkdirSync(join(tmp, "xdg", "codeoid"), { recursive: true });
    mkdirSync(join(tmp, "xdg", "other"));
    const parent = await handleFsBrowseDir({ id: "b9", path: join(tmp, "xdg"), showHidden: true });
    expect(parent.entries.map((e) => e.name)).toEqual(["other"]);
    await expect(handleFsBrowseDir({ id: "b10", path: join(tmp, "xdg", "codeoid") })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("answers the same for a missing path, a file and anything protected, so it can't probe existence", async () => {
    process.env.CODEOID_FS_BROWSE_ROOT = tmp;
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    mkdirSync(join(tmp, "xdg", "codeoid"), { recursive: true });
    writeFileSync(join(tmp, "xdg", "codeoid", "config.json"), "{}");
    writeFileSync(join(tmp, "notes.txt"), "x");
    const answers = await Promise.all(
      [
        join(tmp, "missing"),
        join(tmp, "notes.txt"),
        join(tmp, "xdg", "codeoid", "config.json"),
        join(tmp, "xdg", "codeoid", "nope"),
      ].map((p) => handleFsBrowseDir({ id: "p", path: p }).then(() => null, (e: FsAccessError) => [e.code, e.message.split(":")[0]])),
    );
    expect(answers).toEqual(Array(4).fill(["not_found", "no such directory"]));
  });

  it("drops a symlink that leads into a protected dir, and refuses to enter it", async () => {
    process.env.CODEOID_FS_BROWSE_ROOT = tmp;
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    mkdirSync(join(tmp, "xdg", "codeoid"), { recursive: true });
    mkdirSync(join(tmp, "pub", "real"), { recursive: true });
    symlinkSync(join(tmp, "xdg", "codeoid"), join(tmp, "pub", "sneaky"));
    symlinkSync(join(tmp, "pub", "real"), join(tmp, "pub", "alias"));
    const r = await handleFsBrowseDir({ id: "s1", path: join(tmp, "pub") });
    expect(r.entries.map((e) => [e.name, e.isSymlink ?? false])).toEqual([["alias", true], ["real", false]]);
    await expect(handleFsBrowseDir({ id: "s2", path: join(tmp, "pub", "sneaky") })).rejects.toMatchObject({ code: "not_found" });
  });

  it("follows a symlinked root and answers the same for anything outside it", async () => {
    mkdirSync(join(tmp, "real-root", "proj"), { recursive: true });
    symlinkSync(join(tmp, "real-root"), join(tmp, "link-root"));
    process.env.CODEOID_FS_BROWSE_ROOT = join(tmp, "link-root");
    // Typed through the symlink, the way the operator configured it.
    const r = await handleFsBrowseDir({ id: "l1", path: join(tmp, "link-root", "proj") });
    expect(r.path).toBe(realpathSync(join(tmp, "real-root", "proj")));
    for (const outside of [tmp, join(tmp, "does-not-exist")]) {
      await expect(handleFsBrowseDir({ id: "l2", path: outside })).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("never lists or enters kernel pseudo-filesystems", async () => {
    delete process.env.CODEOID_FS_BROWSE_ROOT;
    const top = await handleFsBrowseDir({ id: "k1", path: "/" });
    expect(top.entries.map((e) => e.name)).not.toContain("proc");
    await expect(handleFsBrowseDir({ id: "k2", path: "/proc/self/cwd" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps a configured root as the boundary", async () => {
    process.env.CODEOID_FS_BROWSE_ROOT = join(tmp, "allowed");
    mkdirSync(join(tmp, "allowed"));
    const r = await handleFsBrowseDir({ id: "b11" });
    expect(r.path).toBe(realpathSync(join(tmp, "allowed")));
    expect(r.parent).toBeNull();
    await expect(handleFsBrowseDir({ id: "b12", path: tmp })).rejects.toMatchObject({ code: "forbidden" });
  });
});
