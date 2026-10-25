/**
 * Loop runs for the terminal (`codeoid loop …`). Pure: returns lines, so it
 * is tested without a daemon.
 */

import type { LoopAttemptWire, LoopEventWire, LoopRunWire } from "../protocol/types.js";

const MARK: Record<LoopRunWire["status"], string> = {
  running: "▶",
  verifying: "⋯",
  waiting: "⏸",
  paused: "⏸",
  completed: "✓",
  budget_exhausted: "✗",
  blocked: "!",
  failed: "✗",
  cancelled: "■",
};

/**
 * How a run ended, in docs/loops.md's words. Only `completed` was verified;
 * the others must not read like it.
 */
export const LOOP_OUTCOME: Partial<Record<LoopRunWire["status"], string>> = {
  completed: "Verified: every check passed on the delivered commit.",
  budget_exhausted: "Out of budget: the attempts or time ran out without every check passing. Nothing was delivered; the worktree holds the last attempt.",
  blocked: "Blocked: the run can't make progress without you.",
  failed: "Failed: something outside the work went wrong.",
  cancelled: "Cancelled by you.",
};

/** The `waitingOn` of a run whose worker session waits on an approval (src/daemon/loops/service.ts). */
export const LOOP_APPROVAL_WAIT = "an approval in the worker session";

/**
 * A run's text is partly the worker's (its reports, notes quoting paths it
 * chose) and must not drive the terminal: every control character goes,
 * escape introducers and carriage returns included, so no sequence or
 * overwrite survives. Lines stay one line.
 */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
const plain = (line: string): string => line.replace(CONTROL, "");

function minutes(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`;
}

export function formatLoopRow(r: LoopRunWire): string {
  const objective = r.objective.split("\n")[0]!.slice(0, 60);
  return plain(`${MARK[r.status]} ${r.id.slice(0, 13)}  ${r.status.padEnd(16)} ${r.attempts}/${r.limits.attempts}  ${objective}`);
}

export function formatLoop(r: LoopRunWire, attempts: LoopAttemptWire[], events?: LoopEventWire[]): string[] {
  const lines = [
    `${MARK[r.status]} ${r.id}  ${r.status}`,
    `  objective  ${r.objective.split("\n")[0]}`,
    `  why        ${r.reason ?? ""}`,
  ];
  if (r.waitingOn) lines.push(`  waiting on ${r.waitingOn}`);
  lines.push(
    `  repo       ${r.workdir}`,
    `  branch     ${r.branch ?? "(not created yet)"}${r.baseRevision ? ` from ${r.baseRevision.slice(0, 12)}` : ""}`,
    `  checks     ${r.checks.map((c) => `${c.id}: ${c.command}`).join(" · ")}`,
    `  budget     ${r.attempts}/${r.limits.attempts} attempts · ${minutes(r.activeMs)} of ${r.limits.runMinutes}m · $${r.costUsd.toFixed(2)}`,
  );
  if (r.deliveredCommit) lines.push(`  delivered  ${r.deliveredCommit.slice(0, 12)} on ${r.branch}  (git log ${r.branch})`);
  if (r.workerSessionId) lines.push(`  worker     ${r.workerSessionId.slice(0, 8)}  (codeoid attach ${r.workerSessionId.slice(0, 8)} — what you type there steers the run)`);
  for (const a of attempts) {
    const took = a.startedAt && a.endedAt ? ` ${minutes(Date.parse(a.endedAt) - Date.parse(a.startedAt))}` : "";
    lines.push(`  #${a.ordinal} ${a.result ?? a.status}${took}${a.note ? ` — ${a.note}` : ""}`);
    if (a.report) lines.push(`      worker: ${a.report.outcome} — ${a.report.summary.split("\n")[0]!.slice(0, 120)}`);
    if (a.evidenceIds.length > 0) lines.push(`      evidence: ${a.evidenceIds.join(" ")}  (codeoid evidence <id>)`);
  }
  if (events && events.length > 0) {
    lines.push("", "  history:");
    for (const e of events) lines.push(`    ${e.at.slice(11, 19)} ${e.type}${e.detail ? ` — ${e.detail.split("\n")[0]!.slice(0, 100)}` : ""}`);
  }
  // `why` and notes can run over lines; the first stays, the rest is in `show --events`.
  return lines.map((l) => plain(l.split("\n")[0]!));
}

/**
 * Parse `--check` values: `cmd`, or `id: cmd` to name the check. A colon and a
 * space, not `=`: `NODE_ENV=test bun test` is a command, not a named check.
 */
export function parseCheckFlag(raw: string): { id?: string; command: string } {
  const m = /^([A-Za-z0-9._-]{1,40}):\s+(.+)$/s.exec(raw);
  return m ? { id: m[1], command: m[2]! } : { command: raw };
}
