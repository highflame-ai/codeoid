/**
 * Pure `codeoid pipeline …` CLI formatters — no daemon needed.
 */

import { describe, expect, test } from "bun:test";
import { formatPipeline, haltedRequestId, isTerminal } from "../terminal/pipeline-format";
import type { PipelineWire } from "../protocol/types";

function wire(over: Partial<PipelineWire> = {}): PipelineWire {
  return {
    id: "pl1",
    name: "add exporter",
    status: "running",
    cursor: 1,
    spec: "add a JSON exporter",
    createdAt: 1,
    updatedAt: 2,
    phases: [
      { id: "spec", role: "implementer", status: "passed", summary: "spec written" },
      { id: "implement", role: "implementer", status: "halted", requestId: "exit:implement", reason: "tests failing", questions: ["ok to proceed?"], feedback: ["add error handling"] },
      { id: "review", role: "reviewer", status: "pending" },
    ],
    ...over,
  };
}

describe("haltedRequestId + isTerminal", () => {
  test("returns the current halted phase's requestId", () => {
    expect(haltedRequestId(wire())).toBe("exit:implement");
  });
  test("undefined when the cursor phase isn't halted", () => {
    expect(haltedRequestId(wire({ cursor: 0 }))).toBeUndefined();
  });
  test("terminal detection", () => {
    expect(isTerminal(wire({ status: "done" }))).toBe(true);
    expect(isTerminal(wire({ status: "running" }))).toBe(false);
  });
});

describe("formatPipeline", () => {
  test("renders the phase rail, halt reason/questions, and decision hints", () => {
    const text = formatPipeline(wire()).join("\n");
    expect(text).toContain("add exporter  [running]");
    expect(text).toContain("goal: add a JSON exporter");
    expect(text).toContain("✓ spec [implementer]  passed");
    expect(text).toContain("⏸ implement [implementer]  halted");
    expect(text).toContain("· review [reviewer]  pending");
    expect(text).toContain("awaiting your decision on \"implement\"");
    expect(text).toContain("reason: tests failing");
    expect(text).toContain("• ok to proceed?");
    expect(text).toContain("revisions: 1");
    expect(text).toContain("pipeline approve pl1");
    expect(text).toContain("pipeline revise  pl1");
  });

  test("terminal run shows its status, no decision hint", () => {
    const text = formatPipeline(wire({ status: "done", cursor: 3, phases: [{ id: "ship", status: "passed" }] })).join("\n");
    expect(text).toContain("run done.");
    expect(text).not.toContain("awaiting your decision");
  });
});

describe("formatPipeline — model bindings (docs/role-model-binding.md §4)", () => {
  test("renders the bound provider:model and the resolving rung per phase", () => {
    const text = formatPipeline(
      wire({
        phases: [
          { id: "attack", role: "adversary", status: "running", provider: "claude", model: "claude-fable-5", resolvedFrom: "config-tier" },
          { id: "pinned", role: "scribe", status: "pending", provider: "codex", resolvedFrom: "phase-pin" },
          { id: "plain", status: "pending" },
        ],
        cursor: 0,
      }),
    ).join("\n");
    expect(text).toContain("attack [adversary]  running  ⟨claude:claude-fable-5 ← config-tier⟩");
    // Provider-only binding: no dangling separator.
    expect(text).toContain("pinned [scribe]  pending  ⟨codex ← phase-pin⟩");
    // Unbound phase renders exactly as before — no empty ⟨⟩.
    expect(text).toContain("· plain  pending");
    expect(text).not.toContain("plain  pending  ⟨");
  });
});
