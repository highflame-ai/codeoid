/**
 * A static check (#448 round 14, docs/sandbox.md "Pinned paths"): in the
 * sandbox, session and checkpoint modules, nothing resolves or uses a path
 * on the host directly (a `node:fs` call, a program spawned, a `cwd:`, a
 * `GIT_WORK_TREE`) but the pinned-path API (sandbox/pinned.ts), unless a
 * `// paths: <why>` comment says why that use is safe: the path is the
 * daemon's own (its private dir, the shadow repository), the user's that no
 * sandbox writes, already checked through the API, or only looked at.
 *
 * A comment covers its own line and the statement or block that follows it
 * (to the line its braces close on). A new direct use without one fails
 * here: route it through pinned.ts, or say why it is safe.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const DAEMON = join(import.meta.dir, "..", "daemon");
const API = join(DAEMON, "sandbox", "pinned.ts");
const FILES = [...readdirSync(join(DAEMON, "sandbox")).filter((f) => f.endsWith(".ts")).map((f) => join(DAEMON, "sandbox", f)), join(DAEMON, "session.ts"), join(DAEMON, "checkpoints.ts")].filter((f) => f !== API);
const MARK = /\/\/\s*paths:\s*\S/;

/** The names a file imports from node:fs and node:fs/promises (calls to them are direct uses). */
function fsNames(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs(?:\/promises)?"/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name && name !== "constants" && !part.trim().startsWith("type ")) out.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*"node:fs(?:\/promises)?"/g)) out.add(`${m[1]}\\.\\w+`);
  return [...out];
}

/**
 * Lines (0-based) a `// paths:` comment covers: its own, and the paragraph
 * after it (the code lines that follow, to a blank line, a new comment or a
 * line less indented than it), with whatever its brackets hold open.
 */
function covered(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  const indent = (l: string) => l.length - l.trimStart().length;
  const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
  lines.forEach((line, i) => {
    if (!MARK.test(line)) return;
    out.add(i);
    // A trailing comment covers its line only.
    if (!isComment(line)) return;
    const at = indent(line);
    let depth = 0;
    let j = i + 1;
    // The comment's own following lines.
    while (j < lines.length && isComment(lines[j] ?? "")) out.add(j++);
    for (; j < lines.length; j++) {
      const text = lines[j] ?? "";
      out.add(j);
      const code = text.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
      for (const ch of code) {
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") depth--;
      }
      if (depth > 0) continue;
      const next = lines[j + 1];
      if (next === undefined || next.trim() === "" || isComment(next) || indent(next) < at) break;
    }
  });
  return out;
}

/** Each direct use in `file` no comment covers: `file:line: text`. */
function uncovered(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const names = fsNames(src);
  const uses = new RegExp(
    [
      ...(names.length > 0 ? [`\\b(?:${names.join("|")})\\(`] : []),
      // A cwd given to a program (not a parameter's type).
      "\\bcwd:\\s(?!string\\b)",
      "\\bGIT_WORK_TREE\\b",
      // node:child_process's, called (a handle's own `spawn` wraps its argv in the sandbox; a declaration names its parameters' types).
      "(?<![.\\w])(?:spawn|spawnSync|execFile|execFileSync|execSync)\\((?!\\w+:\\s)",
      "\\bBun\\.(?:spawn|spawnSync|file|write)\\(",
    ].join("|"),
  );
  const lines = src.split("\n");
  const ok = covered(lines);
  const out: string[] = [];
  let inBlockComment = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("/*")) inBlockComment = !t.includes("*/");
    else if (inBlockComment) {
      if (t.includes("*/")) inBlockComment = false;
      return;
    }
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("import ")) return;
    if (uses.test(line.replace(/\/\/.*$/, "")) && !ok.has(i)) out.push(`${relative(join(DAEMON, ".."), file)}:${i + 1}: ${t.slice(0, 140)}`);
  });
  return out;
}

describe("no session path is used but through the pinned-path API (#448 round 14)", () => {
  test("every direct file-system use, spawn, cwd and GIT_WORK_TREE in the sandbox, session and checkpoint modules is pinned.ts's or says why it is safe", () => {
    const found = FILES.flatMap(uncovered);
    expect(found).toEqual([]);
  });

  test("the check itself: an unmarked use is found, a marked one isn't", () => {
    const lines = ["function f(p: string) {", "  // paths: the daemon's own dir", "  mkdirSync(p);", "", "  rmSync(p);", "}", "rmSync(q); // paths: a look", "rmSync(r);"];
    const ok = covered(lines);
    expect(ok.has(2)).toBe(true);
    expect(ok.has(4)).toBe(false);
    expect(ok.has(6)).toBe(true);
    expect(ok.has(7)).toBe(false);
    // A comment above a block covers the block.
    const block = ["// paths: the shadow repository", "async function g() {", "  await rm(a);", "", "  await rm(b);", "}", "", "await rm(c);"];
    const okBlock = covered(block);
    expect([2, 4].every((i) => okBlock.has(i))).toBe(true);
    expect(okBlock.has(7)).toBe(false);
  });
});
