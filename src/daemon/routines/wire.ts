/** Routine rows → protocol shapes (packages/protocol/src/routines.ts). */

import type { RoutineRunWire, RoutineWire } from "../../protocol/types.js";
import { describeSchedule } from "./schedule.js";
import type { RoutineRow, RunRow } from "./types.js";

const iso = (ms: number | null | undefined): string | undefined => (ms === null || ms === undefined ? undefined : new Date(ms).toISOString());

export function toRunWire(r: RunRow): RoutineRunWire {
  return {
    id: r.id,
    routineId: r.routineId,
    trigger: r.trigger,
    status: r.status,
    ...(r.scheduledFor !== null ? { scheduledFor: iso(r.scheduledFor) } : {}),
    createdAt: iso(r.createdAt) as string,
    ...(r.startedAt !== null ? { startedAt: iso(r.startedAt) } : {}),
    ...(r.endedAt !== null ? { endedAt: iso(r.endedAt) } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.checkOutput ? { checkOutput: r.checkOutput } : {}),
    ...(r.payload ? { payload: r.payload } : {}),
    ...(r.loopRunId ? { loop: { runId: r.loopRunId, status: r.loopStatus ?? "running" } } : {}),
  };
}

export function toRoutineWire(
  r: RoutineRow,
  extra: { upcoming: string[]; lastRun?: RunRow; apiTokenSet: boolean },
): RoutineWire {
  return {
    id: r.id,
    name: r.spec.name,
    enabled: r.enabled,
    ...(r.pausedReason ? { pausedReason: r.pausedReason } : {}),
    ownerSub: r.ownerSub,
    spec: r.spec,
    scheduleText: r.spec.schedule ? describeSchedule(r.spec.schedule) : "on demand",
    upcoming: extra.upcoming,
    ...(r.lastRunAt !== null ? { lastRunAt: iso(r.lastRunAt) } : {}),
    consecutiveFailures: r.consecutiveFailures,
    apiTokenSet: extra.apiTokenSet,
    ...(extra.lastRun ? { lastRun: toRunWire(extra.lastRun) } : {}),
    createdAt: iso(r.createdAt) as string,
    updatedAt: iso(r.updatedAt) as string,
  };
}
