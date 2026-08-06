/**
 * Pure renderers for the `codeoid pipeline …` CLI — kept out of TerminalClient
 * so the formatting is unit-testable without a live daemon (mirrors
 * pack-format.ts).
 */

import type { PipelinePhaseWire, PipelineWire } from "../protocol/types.js";

const TERMINAL = new Set(["merged", "done", "failed", "abandoned"]);

/** The requestId of the currently-halted phase (what approve/revise/reject echo
 *  back), or undefined if the pipeline isn't awaiting a human decision. */
export function haltedRequestId(p: PipelineWire): string | undefined {
  const cur = p.phases[p.cursor];
  return cur && cur.status === "halted" ? cur.requestId : undefined;
}

export function isTerminal(p: PipelineWire): boolean {
  return TERMINAL.has(p.status);
}

const MARK: Record<PipelinePhaseWire["status"], string> = {
  pending: "·",
  running: "▶",
  halted: "⏸",
  passed: "✓",
  skipped: "⤼",
  failed: "✗",
};

/** Render a pipeline as console lines: header, the phase rail, and — at a halt —
 *  the reason/questions + the decision hint. */
export function formatPipeline(p: PipelineWire): string[] {
  const out: string[] = ["", `  ${p.name}  [${p.status}]  (${p.id})`];
  if (p.spec) out.push(`  goal: ${p.spec}`);
  out.push("");
  for (let i = 0; i < p.phases.length; i++) {
    const ph = p.phases[i]!;
    const cursor = i === p.cursor && !isTerminal(p) ? "→ " : "  ";
    const role = ph.role ? ` [${ph.role}]` : "";
    // The persisted model binding + the precedence rung that chose it
    // (docs/role-model-binding.md §3) — absent = the provider default.
    const target = [ph.provider, ph.model].filter(Boolean).join(":");
    const binding = target ? `  ⟨${target}${ph.resolvedFrom ? ` ← ${ph.resolvedFrom}` : ""}⟩` : "";
    out.push(`  ${cursor}${MARK[ph.status]} ${ph.id}${role}  ${ph.status}${binding}`);
    if (ph.status === "passed" && ph.summary) out.push(`        ↳ ${truncate(ph.summary)}`);
    if (ph.status === "skipped" && ph.reason) out.push(`        ↳ ${truncate(ph.reason)}`);
    if (ph.status === "failed" && ph.reason) out.push(`        ↳ ${truncate(ph.reason)}`);
    if (ph.feedback && ph.feedback.length > 0) {
      out.push(`        revisions: ${ph.feedback.length}`);
    }
  }
  const cur = p.phases[p.cursor];
  if (cur && cur.status === "halted") {
    out.push("", `  ⏸ awaiting your decision on "${cur.id}"`);
    if (cur.reason) out.push(`     reason: ${cur.reason}`);
    for (const q of cur.questions ?? []) out.push(`     • ${q}`);
    out.push(
      "",
      `     codeoid pipeline approve ${p.id}          # accept + continue`,
      `     codeoid pipeline revise  ${p.id} "<notes>" # re-run this phase with feedback`,
      `     codeoid pipeline reject  ${p.id}          # stop the run`,
    );
  } else if (isTerminal(p)) {
    out.push("", `  run ${p.status}.`);
  } else {
    out.push("", `  running… watch: codeoid pipeline status ${p.id}`);
  }
  out.push("");
  return out;
}

function truncate(s: string, n = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}
