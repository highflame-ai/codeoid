import { describe, expect, it } from "bun:test";
import {
  describeSchedule,
  formatInterval,
  jitterMs,
  nextFireAfter,
  parseInterval,
  previewFires,
  ScheduleError,
  validateSchedule,
} from "../daemon/routines/schedule.js";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("cron schedules", () => {
  it("evaluates in the routine's timezone, not the daemon's", () => {
    const s = validateSchedule({ kind: "cron", expr: "0 9 * * *", timezone: "Asia/Singapore" }, { now: new Date("2026-10-16T00:00:00Z") });
    // 09:00 in Singapore (UTC+8) is 01:00 UTC.
    expect(iso(nextFireAfter(s, new Date("2026-10-16T00:00:00Z")))).toBe("2026-10-16T01:00:00.000Z");
    expect(iso(nextFireAfter(s, new Date("2026-10-16T01:00:00Z")))).toBe("2026-10-17T01:00:00.000Z");
  });

  it("stays on local wall-clock time across a DST change", () => {
    const s = { kind: "cron" as const, expr: "0 9 * * *", timezone: "Europe/London" };
    // London leaves BST on 2026-10-25: 09:00 is 08:00Z before, 09:00Z after.
    expect(iso(nextFireAfter(s, new Date("2026-10-24T00:00:00Z")))).toBe("2026-10-24T08:00:00.000Z");
    expect(iso(nextFireAfter(s, new Date("2026-10-25T00:00:00Z")))).toBe("2026-10-25T09:00:00.000Z");
  });

  it("weekday ranges skip the weekend", () => {
    const s = { kind: "cron" as const, expr: "30 9 * * 1-5", timezone: "UTC" };
    // 2026-10-16 is a Friday.
    const fires = previewFires(s, new Date("2026-10-16T10:00:00Z"), 2).map(iso);
    expect(fires).toEqual(["2026-10-19T09:30:00.000Z", "2026-10-20T09:30:00.000Z"]);
  });

  it("rejects seconds fields, nicknames, garbage, impossible dates, unknown zones, and sub-minimum frequency", () => {
    const bad: Array<[string, string]> = [
      ["*/5 * * * * *", "exactly 5 fields"],
      ["@hourly", "exactly 5 fields"],
      ["61 * * * *", "invalid cron"],
      ["0 0 31 2 *", "never fires"],
    ];
    for (const [expr, msg] of bad) {
      expect(() => validateSchedule({ kind: "cron", expr, timezone: "UTC" })).toThrow(msg);
    }
    expect(() => validateSchedule({ kind: "cron", expr: "0 9 * * *", timezone: "Mars/Olympus" })).toThrow("unknown timezone");
    expect(() => validateSchedule({ kind: "cron", expr: "* * * * *", timezone: "UTC" }, { minIntervalSeconds: 300 })).toThrow("minimum interval");
    // ...but every minute is fine at the default 60 s floor.
    expect(validateSchedule({ kind: "cron", expr: "* * * * *", timezone: "UTC" }).kind).toBe("cron");
  });

  it("normalises whitespace in the expression", () => {
    const s = validateSchedule({ kind: "cron", expr: "  0   9 * *  1-5 ", timezone: "UTC" });
    expect(s).toEqual({ kind: "cron", expr: "0 9 * * 1-5", timezone: "UTC" });
  });
});

describe("interval schedules", () => {
  it("keeps its phase from the anchor instead of drifting", () => {
    const s = { kind: "every" as const, seconds: 900 };
    const anchor = new Date("2026-10-16T08:07:00Z");
    // Long after the anchor, fires still land on :07, :22, :37, :52.
    expect(iso(nextFireAfter(s, new Date("2026-10-16T11:40:13Z"), { anchor }))).toBe("2026-10-16T11:52:00.000Z");
    expect(iso(nextFireAfter(s, new Date("2026-10-16T11:52:00Z"), { anchor }))).toBe("2026-10-16T12:07:00.000Z");
  });

  it("enforces the minimum interval and a sane maximum", () => {
    expect(() => validateSchedule({ kind: "every", seconds: 30 })).toThrow("≥ 60");
    expect(() => validateSchedule({ kind: "every", seconds: 90.5 })).toThrow("whole number");
    expect(() => validateSchedule({ kind: "every", seconds: 400 * 86_400 })).toThrow("at most a year");
  });

  it("parses human intervals and refuses half-understood ones", () => {
    expect(parseInterval("90s")).toBe(90);
    expect(parseInterval("15m")).toBe(900);
    expect(parseInterval("1h30m")).toBe(5400);
    expect(parseInterval("2d")).toBe(172_800);
    expect(parseInterval("3600")).toBe(3600);
    for (const bad of ["15 minutes", "2x", "", "h", "0m"]) expect(() => parseInterval(bad)).toThrow(ScheduleError);
    expect(formatInterval(5400)).toBe("1h30m");
  });
});

describe("one-off schedules", () => {
  it("fires once, then is exhausted", () => {
    const s = validateSchedule({ kind: "once", at: "2026-11-02T09:00:00+08:00" });
    expect(s).toEqual({ kind: "once", at: "2026-11-02T01:00:00.000Z" });
    expect(iso(nextFireAfter(s, new Date("2026-10-16T00:00:00Z")))).toBe("2026-11-02T01:00:00.000Z");
    expect(nextFireAfter(s, new Date("2026-11-02T01:00:00Z"))).toBeNull();
    expect(() => validateSchedule({ kind: "once", at: "next tuesday" })).toThrow("not a timestamp");
  });
});

describe("jitter", () => {
  it("is stable per routine, bounded, and spreads different routines", () => {
    expect(jitterMs("r-1", 60)).toBe(jitterMs("r-1", 60));
    for (let i = 0; i < 50; i++) {
      const j = jitterMs(`r-${i}`, 60);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(60_000);
    }
    const distinct = new Set(Array.from({ length: 20 }, (_, i) => jitterMs(`r-${i}`, 300)));
    expect(distinct.size).toBeGreaterThan(15);
    expect(jitterMs("r-1", 0)).toBe(0);
  });

  it("a jittered fire is still strictly after the reference instant", () => {
    const s = { kind: "cron" as const, expr: "0 * * * *", timezone: "UTC" };
    const j = 45_000;
    // 10:00:30 is past 10:00 but before 10:00:45 (the jittered fire).
    expect(iso(nextFireAfter(s, new Date("2026-10-16T10:00:30Z"), { jitterMs: j }))).toBe("2026-10-16T10:00:45.000Z");
    expect(iso(nextFireAfter(s, new Date("2026-10-16T10:00:45Z"), { jitterMs: j }))).toBe("2026-10-16T11:00:45.000Z");
  });
});

describe("describeSchedule", () => {
  it("reads naturally", () => {
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * 1-5", timezone: "UTC" })).toBe("cron 0 9 * * 1-5 (UTC)");
    expect(describeSchedule({ kind: "every", seconds: 900 })).toBe("every 15m");
  });
});
