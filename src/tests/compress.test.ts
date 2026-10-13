/**
 * Compressor core tests — registry, runner, generic rule, hint formatting.
 * Purposely avoid any real command execution in unit tests; we inject the
 * stdout text directly. End-to-end runner tests sit in compress-runner.test.ts.
 */

import { describe, it, expect } from "bun:test";
import {
  CompressionRegistry,
  BUILTIN_RULES,
  genericTruncateRule,
  formatHint,
  HINT_PREFIX,
  hasShellPipe,
  extractLeadingTokens,
  type CompressionRule,
  type CompressionContext,
} from "../daemon/compress/index.js";

function ctx(overrides: Partial<CompressionContext> = {}): CompressionContext {
  return {
    workdir: "/tmp",
    originalCommand: "cmd",
    exitCode: 0,
    isLarge: true,
    rawBytes: 10_000,
    env: {},
    ...overrides,
  };
}

// ── Registry ─────────────────────────────────────────────────────────────

describe("CompressionRegistry", () => {
  const rule1: CompressionRule = {
    name: "r1",
    description: "r1",
    match: (c) => c.startsWith("foo"),
    compress: (_stdout, c) => ({
      compressed: "foo-compressed",
      originalBytes: c.rawBytes,
      ruleName: "r1",
    }),
  };
  const rule2: CompressionRule = {
    name: "r2",
    description: "r2",
    match: () => true,
    compress: (_stdout, c) => ({
      compressed: "r2-compressed",
      originalBytes: c.rawBytes,
      ruleName: "r2",
    }),
  };

  it("first matching rule wins", () => {
    const reg = new CompressionRegistry({ rules: [rule1, rule2] });
    expect(reg.matchFirst("foo bar")?.name).toBe("r1");
    expect(reg.matchFirst("baz")?.name).toBe("r2");
  });

  it("disabledRules bypasses a matching rule", () => {
    const reg = new CompressionRegistry({
      rules: [rule1, rule2],
      disabledRules: ["r1"],
    });
    expect(reg.matchFirst("foo bar")?.name).toBe("r2");
  });

  it("excludeCommands blocks compression by leading tokens", () => {
    const reg = new CompressionRegistry({
      rules: [rule2],
      excludeCommands: ["git push"],
    });
    expect(reg.isExcluded("git push origin main")).toBe(true);
    expect(reg.isExcluded("git pull")).toBe(false);
    expect(reg.apply("git push origin", "huge output", ctx())).toBeNull();
  });

  it("excludePatterns blocks via regex", () => {
    const reg = new CompressionRegistry({
      rules: [rule2],
      excludePatterns: [/--no-compress\b/],
    });
    expect(reg.isExcluded("any cmd --no-compress here")).toBe(true);
  });

  it("rule throwing returns null instead of crashing", () => {
    const bad: CompressionRule = {
      name: "bad",
      description: "",
      match: () => true,
      compress: () => {
        throw new Error("oops");
      },
    };
    const reg = new CompressionRegistry({ rules: [bad] });
    expect(reg.apply("x", "y", ctx())).toBeNull();
  });
});

// ── extractLeadingTokens ─────────────────────────────────────────────────

describe("extractLeadingTokens", () => {
  it("handles typical commands", () => {
    expect(extractLeadingTokens("git diff HEAD~5", 2)).toEqual(["git", "diff"]);
    expect(extractLeadingTokens("  ls  -la  /tmp  ", 3)).toEqual(["ls", "-la", "/tmp"]);
  });

  it("collapses multiple whitespace", () => {
    expect(extractLeadingTokens("a\t \n b", 2)).toEqual(["a", "b"]);
  });
});

// ── hasShellPipe ─────────────────────────────────────────────────────────

describe("hasShellPipe", () => {
  it("detects true pipes + file redirects", () => {
    expect(hasShellPipe("ls | head")).toBe(true);
    expect(hasShellPipe("cat x > y")).toBe(true);
    expect(hasShellPipe("grep foo < input.txt")).toBe(true);
  });

  it("ignores command substitution, chaining, background — those don't split stdout", () => {
    // All of these have ONE final stdout we can capture + compress cleanly.
    expect(hasShellPipe("echo $(date)")).toBe(false);
    expect(hasShellPipe("foo && bar")).toBe(false);
    expect(hasShellPipe("foo || bar")).toBe(false);
    expect(hasShellPipe("make && echo done;")).toBe(false);
    expect(hasShellPipe("sleep 1 &")).toBe(false);
    expect(hasShellPipe("for i in $(seq 1 10); do echo $i; done")).toBe(false);
  });

  it("accepts plain commands", () => {
    expect(hasShellPipe("git diff")).toBe(false);
    expect(hasShellPipe("ls -la /tmp")).toBe(false);
  });

  it("ignores pipes inside quoted strings", () => {
    expect(hasShellPipe('echo "foo|bar"')).toBe(false);
    expect(hasShellPipe("echo 'a|b'")).toBe(false);
  });
});

// ── genericTruncateRule ──────────────────────────────────────────────────

describe("genericTruncateRule", () => {
  it("passes through small outputs", () => {
    const r = genericTruncateRule.compress(
      "short\n".repeat(10),
      ctx({ rawBytes: 60 }),
    );
    expect(r).toBeNull();
  });

  it("truncates large outputs with head + tail", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const r = genericTruncateRule.compress(big, ctx({ rawBytes: big.length }));
    expect(r).not.toBeNull();
    expect(r!.ruleName).toBe("generic-head-tail");
    expect(r!.compressed).toContain("line 0");
    expect(r!.compressed).toContain("line 1999");
    expect(r!.compressed).toContain("lines omitted");
    // Compressed must be strictly smaller than raw.
    expect(r!.compressed.length).toBeLessThan(big.length);
  });

  it("skips when line count is below head+tail total", () => {
    // Less than 50 lines — even if over the byte threshold, pass through.
    const text = "a very long single line ".repeat(1000);
    const r = genericTruncateRule.compress(
      text,
      ctx({ rawBytes: text.length }),
    );
    expect(r).toBeNull();
  });
});

// ── Hint formatting ──────────────────────────────────────────────────────

describe("formatHint", () => {
  it("includes compression ratio + rule + recall pointer", () => {
    const hint = formatHint(
      {
        compressed: "x".repeat(100),
        originalBytes: 1000,
        ruleName: "generic-head-tail",
      },
      "git diff HEAD~5",
      "0e9c5b8a-1111-4222-8333-444455556666",
    );
    expect(hint.startsWith(HINT_PREFIX)).toBe(true);
    expect(hint).toContain("90%");
    expect(hint).toContain("generic-head-tail");
    expect(hint).toContain('recall("git diff HEAD~5", include_current_session=true)');
  });

  it("shortens long commands", () => {
    const longCmd = `echo ${"x".repeat(200)}`;
    const hint = formatHint(
      { compressed: "", originalBytes: 100, ruleName: "r" },
      longCmd,
    );
    expect(hint.length).toBeLessThan(longCmd.length + 80);
    expect(hint).toContain("…");
  });
});

// ── BUILTIN_RULES shape ──────────────────────────────────────────────────

describe("BUILTIN_RULES", () => {
  it("ends with the generic fallback", () => {
    const last = BUILTIN_RULES[BUILTIN_RULES.length - 1]!;
    expect(last.name).toBe("generic-head-tail");
  });

  it("every rule has name + description + match + compress", () => {
    for (const r of BUILTIN_RULES) {
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
      expect(typeof r.description).toBe("string");
      expect(typeof r.match).toBe("function");
      expect(typeof r.compress).toBe("function");
    }
  });
});
