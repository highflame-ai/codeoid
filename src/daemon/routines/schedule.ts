/**
 * When a routine fires: the schedule half of a routine (docs/routines.md).
 *
 * Three shapes, all minute-granular at most:
 *   - `cron`  — a standard 5-field expression evaluated in an IANA timezone
 *               (DST-correct: "0 9 * * *" in Asia/Singapore is 09:00 there,
 *               every day, whatever the daemon's own zone);
 *   - `every` — a fixed interval, ≥ the configured minimum (60 s by default);
 *   - `once`  — a single instant, after which the routine stops firing.
 *
 * Cron evaluation is delegated to `croner` (pinned): correct cron + timezone
 * arithmetic is subtle around DST and day-of-month/day-of-week, and a
 * well-exercised implementation beats a hand-rolled one. Everything here is
 * pure — no clock reads except through the `now` arguments — so the scheduler
 * and its tests share exactly one definition of "next".
 */

import { createHash } from "node:crypto";
import { Cron } from "croner";

export type RoutineSchedule =
  | { kind: "cron"; expr: string; timezone: string }
  | { kind: "every"; seconds: number }
  | { kind: "once"; at: string };

/** Thrown for any schedule the scheduler could never honour. */
export class ScheduleError extends Error {}

/** Default lower bound for `every` (config: routines.minIntervalSeconds). */
export const DEFAULT_MIN_INTERVAL_SECONDS = 60;

/** Is `tz` an IANA zone this runtime can evaluate? */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The daemon host's zone — the default for a cron with none given. */
export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Parse a human interval: `90s`, `15m`, `2h`, `1d`, `1h30m`, or a bare number
 * of seconds. Returns seconds, or throws ScheduleError.
 */
export function parseInterval(text: string): number {
  const s = text.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  // The whole string must be number+unit groups: "15 minutes" or "2x" is
  // rejected rather than half-understood.
  if (!/^(\s*\d+\s*[dhms])+$/.test(s)) {
    throw new ScheduleError(`"${text}" is not an interval — use e.g. 90s, 15m, 2h, 1d or 1h30m`);
  }
  const size = { d: 86_400, h: 3_600, m: 60, s: 1 } as const;
  let total = 0;
  for (const m of s.matchAll(/(\d+)\s*([dhms])/g)) total += Number(m[1]) * size[m[2] as keyof typeof size];
  if (total === 0) throw new ScheduleError(`"${text}" is a zero interval`);
  return total;
}

function cronFor(expr: string, timezone: string): Cron {
  const fields = expr.trim().split(/\s+/);
  // Minute granularity, deliberately: a 6-field (seconds) pattern would let a
  // routine fire every second, and nicknames (@hourly) hide what will run.
  if (fields.length !== 5) {
    throw new ScheduleError(`cron must have exactly 5 fields (minute hour day month weekday), got ${fields.length}: "${expr}"`);
  }
  try {
    return new Cron(expr, { timezone, paused: true });
  } catch (err) {
    throw new ScheduleError(`invalid cron "${expr}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Validate and normalise a schedule; throws ScheduleError with a useful message. */
export function validateSchedule(
  s: RoutineSchedule,
  opts: { minIntervalSeconds?: number; now?: Date } = {},
): RoutineSchedule {
  const minInterval = opts.minIntervalSeconds ?? DEFAULT_MIN_INTERVAL_SECONDS;
  switch (s.kind) {
    case "cron": {
      if (!isValidTimezone(s.timezone)) throw new ScheduleError(`unknown timezone "${s.timezone}" — use an IANA name such as Europe/London`);
      const expr = s.expr.trim().replace(/\s+/g, " ");
      const cron = cronFor(expr, s.timezone);
      // A pattern that can never match (e.g. "0 0 31 2 *") is an error, not a
      // routine that silently never runs.
      const first = cron.nextRun(opts.now ?? new Date());
      if (!first) throw new ScheduleError(`cron "${expr}" never fires`);
      // Enforce the floor on cron too: "* * * * *" is every minute, which is
      // allowed only when the configured minimum permits it.
      const runs = cron.nextRuns(6, opts.now ?? new Date());
      for (let i = 1; i < runs.length; i++) {
        const gap = (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 1000;
        if (gap < minInterval) {
          throw new ScheduleError(`cron "${expr}" fires every ${gap}s — the minimum interval is ${minInterval}s`);
        }
      }
      return { kind: "cron", expr, timezone: s.timezone };
    }
    case "every": {
      if (!Number.isInteger(s.seconds) || s.seconds < minInterval) {
        throw new ScheduleError(`interval must be a whole number of seconds ≥ ${minInterval}, got ${s.seconds}`);
      }
      if (s.seconds > 366 * 86_400) throw new ScheduleError("interval must be at most a year");
      return { kind: "every", seconds: s.seconds };
    }
    case "once": {
      const at = new Date(s.at);
      if (Number.isNaN(at.getTime())) throw new ScheduleError(`"${s.at}" is not a timestamp — use ISO 8601, e.g. 2026-11-02T09:00:00+08:00`);
      return { kind: "once", at: at.toISOString() };
    }
  }
}

/**
 * A routine's stable jitter in [0, maxSeconds], derived from its id. Stable so
 * a routine keeps its slot across restarts (predictable for the operator),
 * spread so many routines on "0 9 * * *" don't all start their agents in the
 * same second.
 */
export function jitterMs(routineId: string, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0;
  const h = createHash("sha256").update(routineId).digest();
  return (h.readUInt32BE(0) % (maxSeconds * 1000 + 1));
}

/**
 * The first fire time strictly after `after`, or null when the schedule is
 * exhausted (a `once` in the past).
 *
 * `anchor` is the reference for `every`: fires land on anchor + k·interval, so
 * a 15-minute routine keeps its phase across restarts instead of drifting by
 * however long each run took.
 */
export function nextFireAfter(
  s: RoutineSchedule,
  after: Date,
  opts: { anchor?: Date; jitterMs?: number } = {},
): Date | null {
  const jitter = opts.jitterMs ?? 0;
  // Jitter shifts the fire, so search from `after - jitter`: the jittered
  // instant must still be strictly after `after`.
  const from = new Date(after.getTime() - jitter);
  let base: Date | null;
  switch (s.kind) {
    case "cron":
      base = cronFor(s.expr, s.timezone).nextRun(from);
      break;
    case "every": {
      const step = s.seconds * 1000;
      const anchor = (opts.anchor ?? new Date(0)).getTime();
      const k = Math.floor((from.getTime() - anchor) / step) + 1;
      base = new Date(anchor + k * step);
      break;
    }
    case "once": {
      const at = new Date(s.at);
      base = at.getTime() > from.getTime() ? at : null;
      break;
    }
  }
  if (!base) return null;
  const fire = new Date(base.getTime() + jitter);
  return fire.getTime() > after.getTime() ? fire : nextFireAfter(s, new Date(fire.getTime()), opts);
}

/** The next `n` fire times after `after` — for previews and "next runs" displays. */
export function previewFires(
  s: RoutineSchedule,
  after: Date,
  n: number,
  opts: { anchor?: Date; jitterMs?: number } = {},
): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < n; i++) {
    const next = nextFireAfter(s, cursor, opts);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** A one-line human description: "cron 0 9 * * 1-5 (Asia/Singapore)", "every 15m", "once at …". */
export function describeSchedule(s: RoutineSchedule): string {
  switch (s.kind) {
    case "cron":
      return `cron ${s.expr} (${s.timezone})`;
    case "every":
      return `every ${formatInterval(s.seconds)}`;
    case "once":
      return `once at ${s.at}`;
  }
}

export function formatInterval(seconds: number): string {
  const parts: string[] = [];
  let rest = seconds;
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.join("") || "0s";
}
