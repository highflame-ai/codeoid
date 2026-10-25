/**
 * Recognize a test run that exited 0 without testing anything.
 *
 * A green exit after selecting no tests is the commonest false pass: a filter
 * that matches nothing, a renamed directory, a runner pointed at the wrong
 * package. §7 of the loop design says an empty test selection is not a pass, so
 * a check marked `expectTests` that prints one of these is `inconclusive`.
 *
 * Patterns are each runner's own summary line for "nothing ran", matched on
 * the combined output. They are deliberately specific: a false match turns a
 * real pass into an inconclusive result, which costs an attempt but never
 * certifies anything, so the bias is toward missing an exotic runner rather
 * than misreading a common one.
 */

interface ZeroTestPattern {
  runner: string;
  pattern: RegExp;
}

const ZERO_TEST_PATTERNS: readonly ZeroTestPattern[] = [
  // bun test: "Ran 0 tests across 0 files." / "0 pass\n 0 fail" with no tests.
  { runner: "bun", pattern: /\bRan 0 tests\b/ },
  { runner: "bun", pattern: /\bNo tests found!/ },
  // jest: "No tests found, exiting with code 0" (with --passWithNoTests).
  { runner: "jest", pattern: /\bNo tests found, exiting with code 0\b/ },
  // vitest: "No test files found, exiting with code 0".
  { runner: "vitest", pattern: /\bNo test files found, exiting with code 0\b/ },
  // pytest: "no tests ran in 0.01s" (exit 5 normally, 0 with some plugins).
  { runner: "pytest", pattern: /\bno tests ran\b/i },
  // cargo: every "running N tests" line says 0 — checked separately below.
  // node --test: "# tests 0".
  { runner: "node", pattern: /^# tests 0$/m },
  // mocha: "0 passing".
  { runner: "mocha", pattern: /^\s*0 passing\b/m },
];

/** go test prints "?   pkg [no test files]" per package and "ok pkg" for each
 *  package whose tests ran. Nothing ran when there are no-test-file lines and
 *  no ok/FAIL lines. */
function goRanNothing(output: string): boolean {
  if (!/\[no test files\]/.test(output)) return false;
  return !/^(ok|FAIL|---)\s/m.test(output);
}

/** cargo test prints "running N tests" per test binary; nothing ran when there
 *  is at least one such line and every one says 0. */
function cargoRanNothing(output: string): boolean {
  const counts = [...output.matchAll(/^running (\d+) tests?$/gm)].map((m) => Number(m[1]));
  return counts.length > 0 && counts.every((n) => n === 0);
}

/**
 * The runner whose "nothing ran" summary appears in `output`, or null when the
 * output shows tests ran (or shows nothing recognizable — absence of a known
 * summary is not evidence of an empty selection).
 */
export function detectZeroTests(output: string): string | null {
  for (const { runner, pattern } of ZERO_TEST_PATTERNS) {
    if (pattern.test(output)) return runner;
  }
  if (goRanNothing(output)) return "go";
  if (cargoRanNothing(output)) return "cargo";
  return null;
}
