/**
 * Repo hygiene — properties of the SOURCE FILES themselves, not of any code
 * they contain.
 *
 * Currently one: no source file may contain a raw NUL byte. This is not
 * hypothetical — a U+0000 key separator was once written as a literal
 * control character, and the result was silent on every axis that normally
 * catches a mistake. It typechecked, it linted, its tests passed, and the only
 * symptom was `git diff` reporting `Bin 0 -> 6081 bytes`: git classifies a file
 * with a NUL as binary, so the file stopped producing diffs and became
 * invisible to code review.
 *
 * The byte is legitimate INSIDE a string; what's forbidden is writing it
 * literally instead of as an escape.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html"]);
const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "bun.lock",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    // Don't follow symlinks out of the repo.
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

describe("source hygiene", () => {
  test("no source file contains a raw NUL byte", () => {
    const files = sourceFiles(ROOT);
    // Guard the guard: a walker that silently found nothing would pass forever.
    expect(files.length).toBeGreaterThan(300);

    const offenders: string[] = [];
    for (const f of files) {
      const buf = readFileSync(f);
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${relative(ROOT, f)} (byte ${at})`);
    }
    expect(offenders).toEqual([]);
  });
});
