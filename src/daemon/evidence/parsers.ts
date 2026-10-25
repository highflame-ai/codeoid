/**
 * Recognize a test run that exited 0 without testing anything.
 *
 * A green exit after selecting no tests is the commonest false pass: a filter
 * that matches nothing, a renamed directory, a runner pointed at the wrong
 * package. §7 of the loop design says an empty test selection is not a pass, so
 * a check marked `expectTests` that prints one of these is `inconclusive`.
 *
 * Patterns are each runner's own summary line for "nothing ran". They are
 * deliberately specific: a false match turns a real pass into an inconclusive
 * result, which costs an attempt but never certifies anything, so the bias is
 * toward missing an exotic runner rather than misreading a common one.
 *
 * The scan sees every line of the output, not an excerpt: go and cargo decide
 * from counts across the whole run, and the line that shows tests DID run can
 * sit in the middle of a long log.
 */

interface ZeroTestPattern {
  runner: string;
  pattern: RegExp;
}

const ZERO_TEST_PATTERNS: readonly ZeroTestPattern[] = [
  // bun test: "Ran 0 tests across 0 files." / "No tests found!".
  { runner: "bun", pattern: /\bRan 0 tests\b/ },
  { runner: "bun", pattern: /\bNo tests found!/ },
  // jest: "No tests found, exiting with code 0" (with --passWithNoTests).
  { runner: "jest", pattern: /\bNo tests found, exiting with code 0\b/ },
  // vitest: "No test files found, exiting with code 0".
  { runner: "vitest", pattern: /\bNo test files found, exiting with code 0\b/ },
  // pytest: "no tests ran in 0.01s" (exit 5 normally, 0 with some plugins).
  { runner: "pytest", pattern: /\bno tests ran\b/i },
  // node --test: "# tests 0".
  { runner: "node", pattern: /^# tests 0$/ },
  // mocha: "0 passing".
  { runner: "mocha", pattern: /^\s*0 passing\b/ },
];

/** Line-at-a-time scan of a check's output (both streams). */
export class ZeroTestScan {
  #matched: string | null = null;
  // go: "?   pkg [no test files]" per package; "ok"/"FAIL"/"---" when tests ran.
  #goNoTestFiles = false;
  #goRan = false;
  // cargo: "running N tests" per test binary.
  #cargoRunningLines = 0;
  #cargoNonZero = false;

  line(text: string): void {
    if (this.#matched === null) {
      for (const { runner, pattern } of ZERO_TEST_PATTERNS) {
        if (pattern.test(text)) {
          this.#matched = runner;
          break;
        }
      }
    }
    if (/\[no test files\]/.test(text)) this.#goNoTestFiles = true;
    if (/^(ok|FAIL|---)\s/.test(text)) this.#goRan = true;
    const cargo = /^running (\d+) tests?$/.exec(text);
    if (cargo) {
      this.#cargoRunningLines++;
      if (Number(cargo[1]) > 0) this.#cargoNonZero = true;
    }
  }

  /** The runner whose "nothing ran" summary was seen, or null. */
  result(): string | null {
    if (this.#matched) return this.#matched;
    if (this.#goNoTestFiles && !this.#goRan) return "go";
    if (this.#cargoRunningLines > 0 && !this.#cargoNonZero) return "cargo";
    return null;
  }
}

/** Splits a byte stream into lines for a ZeroTestScan, carrying partial lines
 *  across chunks. Lines past a length bound are scanned truncated. */
export class LineSplitter {
  static readonly MAX_LINE = 4_096;
  #partial = "";
  readonly #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(text: string): void {
    const parts = (this.#partial + text).split("\n");
    this.#partial = parts.pop() ?? "";
    if (this.#partial.length > LineSplitter.MAX_LINE) this.#partial = this.#partial.slice(0, LineSplitter.MAX_LINE);
    for (const p of parts) this.#onLine(p.replace(/\r$/, "").slice(0, LineSplitter.MAX_LINE));
  }

  end(): void {
    if (this.#partial) this.#onLine(this.#partial.replace(/\r$/, ""));
    this.#partial = "";
  }
}

/**
 * The runner whose "nothing ran" summary appears in `output`, or null when the
 * output shows tests ran (or shows nothing recognizable — absence of a known
 * summary is not evidence of an empty selection).
 */
export function detectZeroTests(output: string): string | null {
  const scan = new ZeroTestScan();
  for (const line of output.split("\n")) scan.line(line.replace(/\r$/, ""));
  return scan.result();
}
