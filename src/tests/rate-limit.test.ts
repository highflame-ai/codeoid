/**
 * Rate limiter — unlimited by default, correct when configured.
 *
 * The defaults changed deliberately: this used to hardcode 10 concurrent /
 * 30-per-hour with no config surface, which blocked codeoid's own advertised
 * workflow (the README's hero shot runs 12 parallel sessions). Both limits now
 * default to 0 = unlimited and are configurable for a shared multi-user daemon.
 * See the module doc in src/daemon/rate-limit.ts.
 *
 * The concurrent count is also no longer stored here — the caller passes the
 * live session count — which is what fixes the two accounting bugs that made
 * the old cap unenforceable anyway (reset on restart, drift on teardown).
 */

import { describe, test, expect } from "bun:test";
import { RateLimiter } from "../daemon/rate-limit.js";

describe("RateLimiter — default posture", () => {
  test("is unlimited out of the box", () => {
    const rl = new RateLimiter();
    expect(rl.disabled).toBe(true);
    // The old default blocked the 11th session. Nothing blocks now, at any count.
    expect(rl.check("user-1", 0).allowed).toBe(true);
    expect(rl.check("user-1", 10).allowed).toBe(true);
    expect(rl.check("user-1", 500).allowed).toBe(true);
  });

  test("records nothing when unlimited, so nothing accumulates per session", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 1000; i++) rl.recordCreation("user-1");
    expect(rl.stats("user-1", 0).creationsThisHour).toBe(0);
    expect(rl.check("user-1", 0).allowed).toBe(true);
  });

  test("an explicit 0 is unlimited, not 'block everything'", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 0, maxCreationsPerHour: 0 });
    expect(rl.disabled).toBe(true);
    expect(rl.check("user-1", 9_999).allowed).toBe(true);
  });
});

describe("RateLimiter — concurrent limit, when configured", () => {
  test("allows up to the limit and blocks at it", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 3 });
    expect(rl.disabled).toBe(false);
    expect(rl.check("user-1", 2).allowed).toBe(true);

    const result = rl.check("user-1", 3);
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("Concurrent session limit (3)");
  });

  test("the count comes from the caller, so a freed session frees the slot", () => {
    // No recordDestruction to forget: the live count IS the answer. This is what
    // makes the limit immune to the teardown paths that used to leak slots.
    const rl = new RateLimiter({ maxSessionsPerUser: 2 });
    expect(rl.check("user-1", 2).allowed).toBe(false);
    expect(rl.check("user-1", 1).allowed).toBe(true);
  });

  test("a restart cannot reset it — there is no internal counter to reset", () => {
    // The old bug: 10 sessions, restart, 10 resumed but uncounted, 3 more
    // created → 13 live under a cap of 10. A fresh limiter told the true count
    // still refuses.
    const fresh = new RateLimiter({ maxSessionsPerUser: 10 });
    expect(fresh.check("user-1", 10).allowed).toBe(false);
  });

  test("subjects are independent", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 1 });
    expect(rl.check("user-1", 1).allowed).toBe(false);
    expect(rl.check("user-2", 0).allowed).toBe(true);
  });
});

describe("RateLimiter — hourly limit, when configured", () => {
  test("blocks once the window is full", () => {
    const rl = new RateLimiter({ maxCreationsPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      expect(rl.check("user-1", 0).allowed).toBe(true);
      rl.recordCreation("user-1");
    }
    const result = rl.check("user-1", 0);
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("Hourly creation limit (3/hr)");
  });

  test("applies independently of the concurrent limit", () => {
    // Sessions created and freed: no concurrency pressure, hourly still bites.
    const rl = new RateLimiter({ maxSessionsPerUser: 100, maxCreationsPerHour: 2 });
    rl.recordCreation("user-1");
    rl.recordCreation("user-1");
    expect(rl.check("user-1", 0).allowed).toBe(false);
  });
});

describe("RateLimiter — stats", () => {
  test("reports the caller's count, the window, and the active limits", () => {
    const rl = new RateLimiter({ maxSessionsPerUser: 5, maxCreationsPerHour: 9 });
    rl.recordCreation("user-1");
    rl.recordCreation("user-1");

    const stats = rl.stats("user-1", 2);
    expect(stats.activeSessions).toBe(2);
    expect(stats.creationsThisHour).toBe(2);
    expect(stats.limits).toEqual({ maxSessionsPerUser: 5, maxCreationsPerHour: 9 });
  });

  test("unknown subject reports zeros", () => {
    const stats = new RateLimiter({ maxCreationsPerHour: 5 }).stats("nobody", 0);
    expect(stats.activeSessions).toBe(0);
    expect(stats.creationsThisHour).toBe(0);
  });
});
