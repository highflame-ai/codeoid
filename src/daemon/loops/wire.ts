/** Loop runs, attempts, and events on the wire (packages/protocol/src/loops.ts). */

import type { LoopAttemptWire, LoopEventWire, LoopRunWire } from "../../protocol/types.js";
import { APPROVAL_WAIT, type LoopAttemptRow, type LoopEventRow, type LoopRunRow } from "./types.js";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function runToWire(r: LoopRunRow, attempts: number): LoopRunWire {
  return {
    id: r.id,
    recipe: r.contract.recipe,
    objective: r.contract.objective,
    workdir: r.contract.workdir,
    checks: r.contract.checks.map((c) => ({ id: c.id, command: c.command, timeoutSec: c.timeoutSec })),
    limits: r.contract.limits,
    toolBudget: r.contract.toolBudget,
    ...(r.contract.worker.provider ? { provider: r.contract.worker.provider } : {}),
    ...(r.contract.worker.model ? { model: r.contract.worker.model } : {}),
    status: r.status,
    reason: r.reason,
    waitingOn: r.waitingOn,
    waitingKind: r.waitingOn === null ? null : r.waitingOn === APPROVAL_WAIT ? "approval" : "question",
    baseRevision: r.baseRevision,
    branch: r.branch,
    worktreePath: r.worktreePath,
    workerSessionId: r.workerSessionId,
    acceptedAttemptId: r.acceptedAttemptId,
    deliveredCommit: r.deliveredCommit,
    attempts,
    activeMs: r.activeMs,
    costUsd: r.costUsd,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    endedAt: iso(r.endedAt),
  };
}

export function attemptToWire(a: LoopAttemptRow): LoopAttemptWire {
  return {
    id: a.id,
    ordinal: a.ordinal,
    status: a.status,
    result: a.result,
    note: a.note,
    report: a.report
      ? { outcome: a.report.outcome, summary: a.report.summary, ...(a.report.detail ? { detail: a.report.detail } : {}) }
      : null,
    candidateTree: a.candidateTree,
    evidenceIds: a.evidenceIds,
    workerSessionId: a.workerSessionId,
    provider: a.provider,
    model: a.model,
    startedAt: iso(a.startedAt),
    endedAt: iso(a.endedAt),
    costUsd: a.costUsd,
  };
}

export function eventToWire(e: LoopEventRow): LoopEventWire {
  return { seq: e.seq, at: new Date(e.at).toISOString(), actor: e.actor, type: e.type, detail: e.detail };
}
