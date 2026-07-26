/**
 * Per-user session limits — OFF by default.
 *
 * ## Why off
 *
 * This started as a port of Claude Code's `UserHourlyRateLimiter`, with a
 * hardcoded 10-concurrent / 30-per-hour cap and no way to change either. That
 * is a multi-tenant control, and codeoid's normal deployment is one operator on
 * their own machine driving many parallel worktrees — the README's own hero
 * shot tracks 12 sessions at once, which the old default forbade. A limit the
 * product's advertised workflow trips over is not a safety feature.
 *
 * The runaway case the caps claimed to protect against — an automated spawner
 * looping — is bounded at its actual source instead: the dispatch queue caps
 * concurrent workers (`dispatch.maxConcurrentWorkers`, default 2), per-worker
 * tool budget (`workerToolBudget`, default 50), and consecutive failures
 * (`failureLimit`, default 2).
 *
 * So both limits default to `0` = unlimited. They remain configurable
 * (`rateLimit` in config.json, or `CODEOID_MAX_SESSIONS_PER_USER` /
 * `CODEOID_MAX_SESSIONS_PER_HOUR`) for a shared multi-user deployment, where a
 * per-subject bound is a legitimate thing to want.
 *
 * ## Why the concurrent count is passed in
 *
 * It used to be a counter this class maintained: `recordCreation` incremented,
 * `recordDestruction` decremented. That was wrong in two ways, both observed:
 *
 *   - **It reset on restart.** Resumed sessions never re-registered, so a
 *     daemon restart handed the user a fresh allowance. Measured: 10 sessions
 *     created, restart, 10 resumed, 3 more created — 13 live under a cap of 10.
 *   - **It could only drift upward.** Four call sites remove a session from the
 *     manager but only one decremented, so worker/pipeline teardown leaked
 *     slots until the daemon restarted.
 *
 * Both disappear if the count is never stored: the caller passes the live
 * number of sessions for that subject, which is authoritative by construction.
 */

export interface RateLimitConfig {
  /** Max sessions alive at once per subject. 0 = unlimited (default). */
  maxSessionsPerUser: number;
  /** Max session creations per subject per hour. 0 = unlimited (default). */
  maxCreationsPerHour: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxSessionsPerUser: 0,
  maxCreationsPerHour: 0,
};

const ONE_HOUR_MS = 3_600_000;

interface CreationRecord {
  timestamps: number[];
}

export class RateLimiter {
  #config: RateLimitConfig;
  #creations = new Map<string, CreationRecord>();

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /** True when neither limit is set — lets callers skip the bookkeeping. */
  get disabled(): boolean {
    return this.#config.maxSessionsPerUser <= 0 && this.#config.maxCreationsPerHour <= 0;
  }

  /**
   * May `sub` create another session?
   *
   * @param activeSessions how many sessions this subject currently has alive.
   *   Supplied by the caller (never cached here) so the answer survives restarts
   *   and can't drift — see the module doc.
   */
  check(
    sub: string,
    activeSessions: number,
  ): { allowed: true } | { allowed: false; reason: string } {
    const { maxSessionsPerUser, maxCreationsPerHour } = this.#config;

    if (maxSessionsPerUser > 0 && activeSessions >= maxSessionsPerUser) {
      return {
        allowed: false,
        reason: `Concurrent session limit (${maxSessionsPerUser}) reached`,
      };
    }

    if (maxCreationsPerHour > 0) {
      const record = this.#creations.get(sub);
      if (record) {
        // Prune the sliding window in place; also what keeps the array bounded.
        record.timestamps = record.timestamps.filter((t) => t > Date.now() - ONE_HOUR_MS);
        if (record.timestamps.length >= maxCreationsPerHour) {
          return {
            allowed: false,
            reason: `Hourly creation limit (${maxCreationsPerHour}/hr) reached`,
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Record a session creation, for the hourly window only.
   *
   * No-op when both limits are off, so an unlimited daemon doesn't accumulate a
   * timestamp per session for the life of the process.
   */
  recordCreation(sub: string): void {
    if (this.#config.maxCreationsPerHour <= 0) return;
    let record = this.#creations.get(sub);
    if (!record) {
      record = { timestamps: [] };
      this.#creations.set(sub, record);
    }
    record.timestamps.push(Date.now());
  }

  /** Current stats for a subject (diagnostics / UI). */
  stats(sub: string, activeSessions: number): {
    activeSessions: number;
    creationsThisHour: number;
    limits: RateLimitConfig;
  } {
    const record = this.#creations.get(sub);
    const creationsThisHour = record
      ? record.timestamps.filter((t) => t > Date.now() - ONE_HOUR_MS).length
      : 0;
    return { activeSessions, creationsThisHour, limits: { ...this.#config } };
  }
}
