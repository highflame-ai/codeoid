import { describe, test, expect } from "bun:test";
import {
  RepeatToolGuard,
  PRIMARY_CHAIN,
  canonicalizeArguments,
  matchesToolPattern,
  normalizeRepeatToolConfig,
} from "./repeat-tool";

const read = (p: string) => ({ file_path: p });

describe("canonicalizeArguments", () => {
  test("key order does not change the canonical form", () => {
    expect(canonicalizeArguments({ a: 1, b: 2 })).toBe(
      canonicalizeArguments({ b: 2, a: 1 }),
    );
  });

  test("nested key order is also normalized", () => {
    expect(canonicalizeArguments({ o: { x: 1, y: 2 }, a: 3 })).toBe(
      canonicalizeArguments({ a: 3, o: { y: 2, x: 1 } }),
    );
  });

  test("array order is preserved — it is meaningful", () => {
    expect(canonicalizeArguments({ a: [1, 2] })).not.toBe(
      canonicalizeArguments({ a: [2, 1] }),
    );
  });

  test("differing values stay distinct", () => {
    expect(canonicalizeArguments(read("a.ts"))).not.toBe(
      canonicalizeArguments(read("b.ts")),
    );
  });

  test("cycles degrade instead of throwing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(canonicalizeArguments(cyclic)).toContain("[circular]");
  });

  test("undefined is not trackable", () => {
    expect(canonicalizeArguments(undefined)).toBeNull();
  });
});

describe("matchesToolPattern", () => {
  test("exact match, case-insensitive across backend spellings", () => {
    expect(matchesToolPattern("TodoWrite", "todowrite")).toBe(true);
    expect(matchesToolPattern("todo_write", "TODO_WRITE")).toBe(true);
  });

  test("wildcard", () => {
    expect(matchesToolPattern("mcp__memory__recall", "mcp__*")).toBe(true);
    expect(matchesToolPattern("Read", "mcp__*")).toBe(false);
  });

  test("regex metacharacters in a pattern are literal", () => {
    expect(matchesToolPattern("a.b", "a.b")).toBe(true);
    expect(matchesToolPattern("axb", "a.b")).toBe(false);
  });
});

describe("normalizeRepeatToolConfig", () => {
  test("sorts thresholds ascending", () => {
    expect(normalizeRepeatToolConfig({ thresholds: [8, 3, 5] }).thresholds).toEqual([3, 5, 8]);
  });

  test("fails loud rather than silently defaulting", () => {
    expect(() => normalizeRepeatToolConfig({ thresholds: [] })).toThrow(/must not be empty/);
    expect(() => normalizeRepeatToolConfig({ thresholds: [1] })).toThrow(/>= 2/);
    expect(() => normalizeRepeatToolConfig({ thresholds: [3, 3] })).toThrow(/duplicates/);
    expect(() => normalizeRepeatToolConfig({ thresholds: [2.5] })).toThrow(/integers/);
    expect(() => normalizeRepeatToolConfig({ argumentsPreviewChars: 0 })).toThrow(/>= 1/);
  });
});

describe("RepeatToolGuard", () => {
  test("fires at each configured threshold and nowhere else", () => {
    const g = new RepeatToolGuard({ thresholds: [3, 5] });
    const fired: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
      if (r) fired.push(r.runLength);
    }
    expect(fired).toEqual([3, 5]);
  });

  test("first threshold is the brief nudge, later ones are detailed", () => {
    const g = new RepeatToolGuard({ thresholds: [3, 5] });
    let brief: boolean | undefined;
    let detailed: boolean | undefined;
    for (let i = 0; i < 5; i++) {
      const r = g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
      if (r?.runLength === 3) brief = r.brief;
      if (r?.runLength === 5) detailed = r.brief;
    }
    expect(brief).toBe(true);
    expect(detailed).toBe(false);
  });

  test("the detailed reminder quotes the arguments; the brief one does not", () => {
    const g = new RepeatToolGuard({ thresholds: [2, 3] });
    g.observe(PRIMARY_CHAIN, "Read", read("secret-path.ts"));
    const first = g.observe(PRIMARY_CHAIN, "Read", read("secret-path.ts"));
    const second = g.observe(PRIMARY_CHAIN, "Read", read("secret-path.ts"));
    expect(first?.text).not.toContain("secret-path.ts");
    expect(second?.text).toContain("secret-path.ts");
  });

  test("a different argument resets the run", () => {
    const g = new RepeatToolGuard({ thresholds: [3] });
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    g.observe(PRIMARY_CHAIN, "Read", read("b.ts")); // resets to 1
    expect(g.observe(PRIMARY_CHAIN, "Read", read("b.ts"))).toBeNull();
    expect(g.runLength(PRIMARY_CHAIN)).toBe(2);
  });

  test("a different tool resets the run", () => {
    const g = new RepeatToolGuard({ thresholds: [3] });
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    g.observe(PRIMARY_CHAIN, "Grep", { pattern: "x" });
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))).toBeNull();
  });

  test("key order in the input does not break a run", () => {
    const g = new RepeatToolGuard({ thresholds: [3] });
    g.observe(PRIMARY_CHAIN, "Edit", { a: 1, b: 2 });
    g.observe(PRIMARY_CHAIN, "Edit", { b: 2, a: 1 });
    expect(g.observe(PRIMARY_CHAIN, "Edit", { a: 1, b: 2 })?.runLength).toBe(3);
  });

  test("excluded tools are fully transparent — they neither advance nor reset", () => {
    const g = new RepeatToolGuard({ thresholds: [3], exclude: ["TodoWrite"] });
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    expect(g.observe(PRIMARY_CHAIN, "TodoWrite", { todos: [] })).toBeNull();
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))?.runLength).toBe(3);
  });

  test("include narrows tracking to the listed tools", () => {
    const g = new RepeatToolGuard({ thresholds: [2], include: ["Bash"] });
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))).toBeNull();
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))).toBeNull();
    g.observe(PRIMARY_CHAIN, "Bash", { command: "ls" });
    expect(g.observe(PRIMARY_CHAIN, "Bash", { command: "ls" })?.runLength).toBe(2);
  });

  test("a pattern matching no live tool is not an error", () => {
    const g = new RepeatToolGuard({ thresholds: [2], exclude: ["mcp__*"] });
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))).toBeNull();
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))?.runLength).toBe(2);
  });

  test("chains are independent per agent — parallel subagents do not interleave", () => {
    const g = new RepeatToolGuard({ thresholds: [3] });
    for (let i = 0; i < 2; i++) {
      g.observe("agent-a", "Read", read("a.ts"));
      g.observe("agent-b", "Read", read("b.ts"));
    }
    // Interleaved calls would have reset a single shared chain to 1 each time.
    expect(g.observe("agent-a", "Read", read("a.ts"))?.runLength).toBe(3);
    expect(g.observe("agent-b", "Read", read("b.ts"))?.runLength).toBe(3);
  });

  test("the argument preview is capped but detection uses the full string", () => {
    const g = new RepeatToolGuard({ thresholds: [2, 3], argumentsPreviewChars: 20 });
    const big = { content: "x".repeat(5000) };
    g.observe(PRIMARY_CHAIN, "Write", big);
    g.observe(PRIMARY_CHAIN, "Write", big);
    const r = g.observe(PRIMARY_CHAIN, "Write", big);
    expect(r?.runLength).toBe(3); // full-string comparison still matched
    expect(r!.text).toContain("more characters omitted");
    expect(r!.text.length).toBeLessThan(1000); // preview bounded the text
  });

  test("two large payloads differing only past the preview cap are distinct", () => {
    const g = new RepeatToolGuard({ thresholds: [2], argumentsPreviewChars: 10 });
    g.observe(PRIMARY_CHAIN, "Write", { content: `${"x".repeat(500)}A` });
    expect(g.observe(PRIMARY_CHAIN, "Write", { content: `${"x".repeat(500)}B` })).toBeNull();
  });

  test("the tool/arguments key separator cannot be forged from a tool name", () => {
    // The chain key joins tool name and canonical args. With an ordinary
    // separator (a space), a tool literally named `Read {"x":1}` calling with
    // `{}` would key the same as `Read` calling with `{"x":1}`. NUL can't
    // appear in a tool name, and JSON.stringify escapes it, so it can't
    // appear in the canonical args either.
    const g = new RepeatToolGuard({ thresholds: [2] });
    g.observe(PRIMARY_CHAIN, 'Read {"x":1}', {});
    expect(g.observe(PRIMARY_CHAIN, "Read", { x: 1 })).toBeNull();
    expect(g.runLength(PRIMARY_CHAIN)).toBe(1);
  });

  test("resetChain drops a run — an owner redirect invalidates it", () => {
    const g = new RepeatToolGuard({ thresholds: [3] });
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    g.resetChain(PRIMARY_CHAIN);
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))).toBeNull();
    expect(g.runLength(PRIMARY_CHAIN)).toBe(1);
  });

  test("disabled guard never fires", () => {
    const g = new RepeatToolGuard({ enabled: false, thresholds: [2] });
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    expect(g.observe(PRIMARY_CHAIN, "Read", read("a.ts"))).toBeNull();
  });

  test("unserialisable input drops the chain rather than guessing", () => {
    const g = new RepeatToolGuard({ thresholds: [2] });
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    expect(g.observe(PRIMARY_CHAIN, "Read", undefined)).toBeNull();
    expect(g.runLength(PRIMARY_CHAIN)).toBe(0);
  });

  test("the advisory is marked as daemon-authored, not owner input", () => {
    const g = new RepeatToolGuard({ thresholds: [2] });
    g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    const r = g.observe(PRIMARY_CHAIN, "Read", read("a.ts"));
    expect(r!.text).toContain("NOT a message from the owner");
    expect(r!.text).toContain("<repeat_tool_notice>");
    expect(r!.text).toContain("</repeat_tool_notice>");
  });
});
