import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard: the rotation turn-counter must advance on BOTH usage paths.
 *
 * `#turnsSinceLastRotation` is the only input to `decideRotation`'s min-turns
 * guard, and it is process-local — never read back from the store. It used to
 * be incremented inside the `if (!store)` branch of
 * `Session#recordUsageFromTurn`, i.e. only when the memory engine was OFF.
 * With memory enabled (the common configuration) it stayed pinned at 0, so
 * every rotation check returned `below_min_turns` and auto-rotation was
 * silently dead — soft threshold and hard ceiling alike.
 *
 * That shipped because nothing asserted it. A behavioural test would need a
 * full daemon + memory store + provider harness for a single integer, so this
 * checks the structure instead: the increment must appear BEFORE the
 * `if (!store)` branch it used to hide in. Crude, but it fails loudly on the
 * one edit that would reintroduce the bug.
 *
 * The behavioural half of this fix — that the hard ceiling can no longer be
 * suppressed by a stuck counter — is covered in `context-math.test.ts`.
 */
describe("rotation turn counter", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "daemon", "session.ts"),
    "utf8",
  );

  test("is incremented exactly once, outside any store branch", () => {
    const increments = [...src.matchAll(/#turnsSinceLastRotation\s*\+=\s*1/g)];
    expect(increments).toHaveLength(1);
  });

  test("the increment precedes the `if (!store)` fallback branch", () => {
    const inc = src.indexOf("#turnsSinceLastRotation += 1");
    const storeBranch = src.indexOf("if (!store) {");
    expect(inc).toBeGreaterThan(-1);
    expect(storeBranch).toBeGreaterThan(-1);
    // Strictly before — inside or after the branch means memory-enabled
    // sessions stop counting turns and lose auto-rotation entirely.
    expect(inc).toBeLessThan(storeBranch);
  });

  test("is reset only by an actual rotation", () => {
    const resets = [...src.matchAll(/#turnsSinceLastRotation\s*=\s*0/g)];
    // One field initialiser + one reset inside #rotate().
    expect(resets).toHaveLength(2);
  });
});
