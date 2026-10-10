import { describe, expect, it } from "bun:test";
import type { CompareState } from "../protocol/types.js";
import { compareSettled, formatCompare, parseCompareArgs, parseTargets } from "../terminal/compare.js";

describe("parseTargets", () => {
  it("reads backends and backend:model (a model may contain more colons)", () => {
    expect(parseTargets("claude, codex:gpt-5.5,pi:openrouter:qwen")).toEqual([
      { providerId: "claude" },
      { providerId: "codex", model: "gpt-5.5" },
      { providerId: "pi", model: "openrouter:qwen" },
    ]);
  });
  it("takes 2 to 4, and backend ids only", () => {
    expect(parseTargets("claude")).toHaveProperty("error");
    expect(parseTargets("a,b,c,d,e")).toHaveProperty("error");
    expect(parseTargets("claude,--rm")).toHaveProperty("error");
    expect(parseTargets("claude,codex")).toHaveLength(2);
  });
});

describe("parseCompareArgs", () => {
  it("no args shows; keep takes a branch and --discard-others", () => {
    expect(parseCompareArgs([])).toEqual({ kind: "show" });
    expect(parseCompareArgs(["keep", "2"])).toEqual({ kind: "keep", branch: 2, discardOthers: false });
    expect(parseCompareArgs(["keep", "1", "--discard-others"])).toEqual({ kind: "keep", branch: 1, discardOthers: true });
    expect(parseCompareArgs(["keep"])).toHaveProperty("error");
    expect(parseCompareArgs(["keep", "0"])).toHaveProperty("error");
    expect(parseCompareArgs(["keep", "1", "--nope"])).toHaveProperty("error");
  });
  it("targets, then flags, then the prompt (flags after the prompt starts are part of it)", () => {
    expect(parseCompareArgs(["claude,codex", "--at", "3", "--shared", "fix", "the", "--at", "bug"])).toEqual({
      kind: "start",
      targets: [{ providerId: "claude" }, { providerId: "codex" }],
      at: 3,
      shared: true,
      prompt: "fix the --at bug",
    });
  });
  it("needs a prompt and a valid --at", () => {
    expect(parseCompareArgs(["claude,codex"])).toHaveProperty("error");
    expect(parseCompareArgs(["claude,codex", "--at", "x", "go"])).toHaveProperty("error");
  });
});

describe("formatCompare", () => {
  const state: CompareState = {
    compareId: "abcdef12-0000-0000-0000-000000000000",
    parentSessionId: "p",
    prompt: "make\nit fast",
    createdAt: "2026-10-10T00:00:00.000Z",
    createdBy: "u",
    keptSessionId: "s2",
    targets: [
      { providerId: "claude", sessionId: "s1", status: "idle", reply: "done A", costUsd: 0.0123, durationMs: 4200, files: { changed: 2, insertions: 10, deletions: 3, paths: ["a.ts", "b.ts"] } },
      { providerId: "codex", model: "gpt-5.5", sessionId: "s2", status: "idle", reply: "done B" },
      { providerId: "pi", status: "failed", error: "no credentials" },
    ],
  };
  it("numbers branches for keep, with stats, files, reply, the kept one and failures", () => {
    const out = formatCompare(state);
    expect(out).toContain('Comparison abcdef12 — "make it fast"');
    expect(out).toContain("[1] claude — idle (4.2s, $0.0123)");
    expect(out).toContain("files: 2 changed, +10 −3 — a.ts, b.ts");
    expect(out).toContain("│ done A");
    expect(out).toContain("[2] codex:gpt-5.5 — idle  ★ kept");
    expect(out).toContain("[3] pi — failed");
    expect(out).toContain("error: no credentials");
  });
  it("settles only when no branch is still working", () => {
    expect(compareSettled(state)).toBe(true);
    expect(compareSettled({ ...state, targets: [...state.targets, { providerId: "x", sessionId: "s4", status: "thinking" }] })).toBe(false);
  });
});
