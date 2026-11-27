/** materialize.ts against real git: files written from verified objects only. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { commitTree, copyTree, fingerprint, removeTree, listTree, ObjectReader, restoreTree, type Stamps, writeTree } from "./materialize.js";

let tmp: string;
let repo: string;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const reader = (): ObjectReader => new ObjectReader({ PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_DIR: join(repo, ".git") }, repo);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-materialize-"));
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(repo, "src", "a.txt"), "one\n");
  writeFileSync(join(repo, "run.sh"), "exit 1\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  symlinkSync("src/a.txt", join(repo, "link"));
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("materialize", () => {
  test("writes a commit's tree: nested files, the executable bit, symlinks", async () => {
    const r = reader();
    try {
      const files = await listTree(r, await commitTree(r, git("rev-parse", "HEAD")));
      const out = join(tmp, "out");
      mkdirSync(out);
      await writeTree(r, out, files, null);
      expect(readFileSync(join(out, "src", "a.txt"), "utf8")).toBe("one\n");
      expect(statSync(join(out, "run.sh")).mode & 0o111).not.toBe(0);
      expect(lstatSync(join(out, "link")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(out, "link"))).toBe("src/a.txt");
    } finally {
      r.close();
    }
  });

  test("laying one tree over another removes what it dropped and leaves what setup made", async () => {
    const r = reader();
    try {
      const base = await listTree(r, await commitTree(r, git("rev-parse", "HEAD")));
      rmSync(join(repo, "src", "a.txt"));
      writeFileSync(join(repo, "run.sh"), "exit 0\n");
      git("add", "-A");
      git("commit", "-q", "-m", "next");
      const next = await listTree(r, await commitTree(r, git("rev-parse", "HEAD")));
      const out = join(tmp, "out");
      mkdirSync(out);
      await writeTree(r, out, base, null);
      mkdirSync(join(out, "node_modules"));
      writeFileSync(join(out, "node_modules", "dep.js"), "x");
      await writeTree(r, out, next, base);
      expect(existsSync(join(out, "src", "a.txt"))).toBe(false);
      expect(readFileSync(join(out, "run.sh"), "utf8")).toBe("exit 0\n");
      expect(existsSync(join(out, "node_modules", "dep.js"))).toBe(true);
    } finally {
      r.close();
    }
  });

  test("an object rewritten in the store is refused, though git itself would read it", async () => {
    const blob = git("rev-parse", "HEAD:run.sh");
    const path = join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    const forged = Buffer.from("exit 0\n");
    chmodSync(path, 0o644);
    writeFileSync(path, deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged])));
    expect(git("cat-file", "-p", blob)).toBe("exit 0"); // git doesn't notice
    const r = reader();
    try {
      const files = await listTree(r, await commitTree(r, git("rev-parse", "HEAD")));
      const out = join(tmp, "out");
      mkdirSync(out);
      await expect(writeTree(r, out, files, null)).rejects.toThrow("doesn't hash to its id");
    } finally {
      r.close();
    }
  });

  test("a file is never written through a symlinked directory", async () => {
    const r = reader();
    try {
      const files = await listTree(r, await commitTree(r, git("rev-parse", "HEAD")));
      const out = join(tmp, "out");
      const elsewhere = join(tmp, "elsewhere");
      mkdirSync(out);
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(out, "src"));
      await expect(writeTree(r, out, files, new Map())).rejects.toThrow("isn't a directory");
      expect(existsSync(join(elsewhere, "a.txt"))).toBe(false);
    } finally {
      r.close();
    }
  });

  /** A tree object written as given, bypassing git's own checks (`--literally`). */
  function rawTree(entries: Array<{ mode: string; name: Buffer | string; oid: string }>): string {
    const body = Buffer.concat(
      entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} `), Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name), Buffer.from([0]), Buffer.from(e.oid, "hex")])),
    );
    return execFileSync("git", ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"], { cwd: repo, input: body, encoding: "utf8" }).trim();
  }

  test("names that may be one file, or aren't UTF-8, are refused; legacy modes read as git reads them", async () => {
    const blob = git("rev-parse", "HEAD:src/a.txt");
    const r = reader();
    try {
      const pair = rawTree([{ mode: "100644", name: "A", oid: blob }, { mode: "100644", name: "a", oid: blob }]);
      // Two files where names are case-sensitive; one where the filesystem folds case.
      expect((await listTree(r, pair)).size).toBe(2);
      await expect(listTree(r, pair, { case: true, unicode: true })).rejects.toThrow("same file");
      await expect(listTree(r, rawTree([{ mode: "100644", name: Buffer.from([0x78, 0xfe]), oid: blob }]))).rejects.toThrow("isn't UTF-8");
      await expect(listTree(r, rawTree([{ mode: "100644", name: ".git\u200c", oid: blob }]))).rejects.toThrow("refuse");
      const legacy = await listTree(r, rawTree([{ mode: "100664", name: "old.txt", oid: blob }]));
      expect(legacy.get("old.txt")?.mode).toBe("100644");
    } finally {
      r.close();
    }
  });

  test("a file the next tree drops isn't removed through a symlinked directory", async () => {
    const r = reader();
    try {
      const base = await listTree(r, await commitTree(r, git("rev-parse", "HEAD")));
      const out = join(tmp, "out");
      const elsewhere = join(tmp, "elsewhere");
      mkdirSync(out);
      await writeTree(r, out, base, null);
      // Setup replaced the tracked directory with a link out of the checkout.
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "a.txt"), "keep me\n");
      rmSync(join(out, "src"), { recursive: true });
      symlinkSync(elsewhere, join(out, "src"));
      const next = new Map(base);
      next.delete("src/a.txt");
      await expect(writeTree(r, out, next, base)).rejects.toThrow("isn't a directory");
      expect(readFileSync(join(elsewhere, "a.txt"), "utf8")).toBe("keep me\n");
    } finally {
      r.close();
    }
  });

  test("a large file is read in time linear in its size", async () => {
    writeFileSync(join(repo, "big.bin"), Buffer.alloc(64 * 1024 * 1024, 7));
    git("add", "big.bin");
    git("commit", "-q", "-m", "big");
    const r = reader();
    try {
      const t0 = performance.now();
      const { data } = await r.read(git("rev-parse", "HEAD:big.bin"));
      expect(data.length).toBe(64 * 1024 * 1024);
      expect(performance.now() - t0).toBeLessThan(5_000);
    } finally {
      r.close();
    }
  });

  test("what anything changed among the tree's files is put back, and only that", async () => {
    const r = reader();
    try {
      const files = await listTree(r, await commitTree(r, git("rev-parse", "HEAD")));
      const out = join(tmp, "out");
      mkdirSync(out);
      const stamps: Stamps = new Map();
      await writeTree(r, out, files, null, undefined, stamps);
      writeFileSync(join(out, "src", "a.txt"), "tampered\n");
      chmodSync(join(out, "run.sh"), 0o644);
      writeFileSync(join(out, "build.out"), "kept\n");
      const restored = await restoreTree(reader, out, files, stamps);
      expect(restored.sort()).toEqual(["run.sh", "src/a.txt"]);
      expect(readFileSync(join(out, "src", "a.txt"), "utf8")).toBe("one\n");
      expect(statSync(join(out, "run.sh")).mode & 0o100).not.toBe(0);
      expect(readFileSync(join(out, "build.out"), "utf8")).toBe("kept\n");
      expect(await restoreTree(reader, out, files, stamps)).toEqual([]);
    } finally {
      r.close();
    }
  });

  test("a tree copies with modes and links, skipping what isn't a file; any change shows in its fingerprint", async () => {
    const src = join(tmp, "src-tree");
    mkdirSync(join(src, "d"), { recursive: true });
    writeFileSync(join(src, "d", "run.sh"), "x\n", { mode: 0o755 });
    symlinkSync("/abs/target", join(src, "abs"));
    execFileSync("mkfifo", [join(src, "pipe")]);
    const sealed = await fingerprint(src);
    const dst = join(tmp, "dst-tree");
    expect(await copyTree(src, dst)).toEqual(["pipe"]);
    expect(statSync(join(dst, "d", "run.sh")).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(dst, "abs"))).toBe("/abs/target");
    expect((await fingerprint(src)).digest).toBe(sealed.digest); // reading changes nothing
    writeFileSync(join(src, "d", "run.sh"), "y\n");
    expect((await fingerprint(src)).digest).not.toBe(sealed.digest);
  });

  test("a tree with read-only directories is removed whole", () => {
    const at = join(tmp, "ro");
    mkdirSync(join(at, "locked", "deep"), { recursive: true });
    writeFileSync(join(at, "locked", "deep", "f"), "x");
    chmodSync(join(at, "locked", "deep"), 0o555);
    chmodSync(join(at, "locked"), 0o555);
    removeTree(at);
    expect(existsSync(at)).toBe(false);
  });
});

