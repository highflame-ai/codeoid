/**
 * Fleet economics — cost and tokens rolled up per backend
 * (conductor-frontends-design §9, §7).
 *
 * §9 asks for the zoom ABOVE a single session: total spend across the fleet,
 * broken down per backend, so a Claude row and a Gemini row are comparable at a
 * glance. §7 calls that out as a metaharness differentiator rather than a
 * nicety — no single-vendor tool needs a per-backend breakdown, because it only
 * ever has one backend.
 *
 * Pure functions: the rollup is the decision worth testing, and it needs no
 * reactive root.
 */

import type { SessionInfo } from "../protocol/types";

export interface BackendSpend {
  /** Provider id as the daemon reports it (`claude`, `gemini-cli`, `qwen`, …). */
  providerId: string;
  sessions: number;
  /** Sessions currently running a turn or a tool. */
  active: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface FleetEconomics {
  byBackend: BackendSpend[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Sessions counted in this rollup. */
  sessions: number;
  /** How many are working right now — §9's concurrent-agent count. */
  active: number;
}

/** Session statuses that mean a turn is actually in flight. */
const BUSY = new Set(["thinking", "tool_running"]);

/**
 * Bucket for a session whose backend the daemon did not report.
 *
 * Exported so consumers compare against this rather than re-typing the string:
 * it is a sentinel that reaches the UI, and a caller that wants to style or
 * filter it should not have to know the literal.
 */
export const UNKNOWN_PROVIDER = "unknown" as const;

/**
 * Backend label for a session.
 *
 * A session with no `providerId` is reported as `unknown` rather than silently
 * folded into the default backend. Attributing spend to a provider that may not
 * have incurred it is worse than admitting the gap — the entire point of this
 * view is comparing backends against each other.
 */
function backendOf(s: SessionInfo): string {
  return s.providerId ?? UNKNOWN_PROVIDER;
}

/**
 * Roll `sessions` up per backend.
 *
 * Sessions with no usage still COUNT (they exist and occupy a slot) but
 * contribute zero spend, so the session count and the cost stay independently
 * true. A fleet of ten idle sessions reads as ten sessions at $0, not as an
 * empty fleet.
 *
 * Ordered by cost descending — the question this view answers is "what is
 * burning money", so the answer is on the first row. Backends that tie fall
 * back to name order so the list does not reshuffle between renders.
 */
export function fleetEconomics(sessions: readonly SessionInfo[]): FleetEconomics {
  const byId = new Map<string, BackendSpend>();

  for (const s of sessions) {
    const id = backendOf(s);
    const row = byId.get(id) ?? {
      providerId: id,
      sessions: 0,
      active: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    row.sessions += 1;
    if (BUSY.has(s.status)) row.active += 1;
    const u = s.usage;
    if (u) {
      row.inputTokens += u.inputTokens;
      row.outputTokens += u.outputTokens;
      row.costUsd += u.totalCostUsd;
    }
    byId.set(id, row);
  }

  const byBackend = [...byId.values()].sort(
    (a, b) => b.costUsd - a.costUsd || (a.providerId < b.providerId ? -1 : 1),
  );

  return {
    byBackend,
    totalCostUsd: byBackend.reduce((n, b) => n + b.costUsd, 0),
    totalInputTokens: byBackend.reduce((n, b) => n + b.inputTokens, 0),
    totalOutputTokens: byBackend.reduce((n, b) => n + b.outputTokens, 0),
    sessions: byBackend.reduce((n, b) => n + b.sessions, 0),
    active: byBackend.reduce((n, b) => n + b.active, 0),
  };
}

/**
 * Each backend's share of total spend, 0–1.
 *
 * Zero when nothing has been spent yet — NOT an even split. A fresh fleet has
 * no shares to report, and dividing by a zero total to show four backends at
 * 25% would be inventing a fact from an absence.
 */
export function costShare(econ: FleetEconomics, backend: BackendSpend): number {
  return econ.totalCostUsd > 0 ? backend.costUsd / econ.totalCostUsd : 0;
}
