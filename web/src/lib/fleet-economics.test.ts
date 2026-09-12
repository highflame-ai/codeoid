import { describe, it, expect } from "vitest";

import { costShare, fleetEconomics, UNKNOWN_PROVIDER } from "./fleet-economics";
import type { SessionInfo, SessionUsage } from "../protocol/types";

const usage = (over: Partial<SessionUsage> = {}): SessionUsage =>
  ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    numTurns: 0,
    durationMs: 0,
    ...over,
  }) as SessionUsage;

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name: id, status: "idle", ...over }) as SessionInfo;

describe("fleetEconomics", () => {
  it("rolls spend up per backend and totals it", () => {
    const econ = fleetEconomics([
      session("a", { providerId: "claude", usage: usage({ totalCostUsd: 1, inputTokens: 10 }) }),
      session("b", { providerId: "claude", usage: usage({ totalCostUsd: 2, outputTokens: 5 }) }),
      session("c", { providerId: "qwen", usage: usage({ totalCostUsd: 0.5 }) }),
    ]);
    expect(econ.byBackend.map((b) => b.providerId)).toEqual(["claude", "qwen"]);
    expect(econ.byBackend[0]!.costUsd).toBe(3);
    expect(econ.byBackend[0]!.sessions).toBe(2);
    expect(econ.byBackend[0]!.inputTokens).toBe(10);
    expect(econ.byBackend[0]!.outputTokens).toBe(5);
    expect(econ.totalCostUsd).toBe(3.5);
    expect(econ.sessions).toBe(3);
  });

  it("orders by cost descending — the view answers 'what is burning money'", () => {
    const econ = fleetEconomics([
      session("cheap", { providerId: "qwen", usage: usage({ totalCostUsd: 0.1 }) }),
      session("dear", { providerId: "claude", usage: usage({ totalCostUsd: 9 }) }),
    ]);
    expect(econ.byBackend[0]!.providerId).toBe("claude");
  });

  it("breaks cost ties by name so the list does not reshuffle between renders", () => {
    const econ = fleetEconomics([
      session("z", { providerId: "zeta", usage: usage({ totalCostUsd: 1 }) }),
      session("a", { providerId: "alpha", usage: usage({ totalCostUsd: 1 }) }),
    ]);
    expect(econ.byBackend.map((b) => b.providerId)).toEqual(["alpha", "zeta"]);
  });

  it("counts a session with no usage without inventing spend for it", () => {
    // Ten idle sessions must read as ten sessions at $0, not as an empty fleet.
    const econ = fleetEconomics([
      session("a", { providerId: "claude" }),
      session("b", { providerId: "claude" }),
    ]);
    expect(econ.sessions).toBe(2);
    expect(econ.byBackend[0]!.sessions).toBe(2);
    expect(econ.totalCostUsd).toBe(0);
  });

  it("reports a missing providerId as `unknown` rather than folding it into the default", () => {
    // Attributing spend to a provider that may not have incurred it is worse
    // than admitting the gap — the whole point is comparing backends.
    const econ = fleetEconomics([session("a", { usage: usage({ totalCostUsd: 5 }) })]);
    expect(econ.byBackend[0]!.providerId).toBe(UNKNOWN_PROVIDER);
    expect(econ.byBackend[0]!.costUsd).toBe(5);
  });

  it("counts only genuinely in-flight sessions as active", () => {
    const econ = fleetEconomics([
      session("a", { providerId: "claude", status: "thinking" }),
      session("b", { providerId: "claude", status: "tool_running" }),
      session("c", { providerId: "claude", status: "waiting_approval" }),
      session("d", { providerId: "claude", status: "idle" }),
      session("e", { providerId: "claude", status: "error" }),
    ]);
    // waiting_approval is stopped, not working — it belongs in the attention
    // queue, not the concurrency count.
    expect(econ.active).toBe(2);
    expect(econ.sessions).toBe(5);
  });

  it("returns an empty rollup for an empty fleet", () => {
    const econ = fleetEconomics([]);
    expect(econ.byBackend).toEqual([]);
    expect(econ.totalCostUsd).toBe(0);
    expect(econ.active).toBe(0);
  });
});

describe("costShare", () => {
  it("reports each backend's share of total spend", () => {
    const econ = fleetEconomics([
      session("a", { providerId: "claude", usage: usage({ totalCostUsd: 3 }) }),
      session("b", { providerId: "qwen", usage: usage({ totalCostUsd: 1 }) }),
    ]);
    expect(costShare(econ, econ.byBackend[0]!)).toBeCloseTo(0.75);
    expect(costShare(econ, econ.byBackend[1]!)).toBeCloseTo(0.25);
  });

  it("is zero when nothing has been spent — never an even split", () => {
    // Dividing by a zero total to show four backends at 25% would invent a
    // fact from an absence.
    const econ = fleetEconomics([
      session("a", { providerId: "claude" }),
      session("b", { providerId: "qwen" }),
    ]);
    expect(costShare(econ, econ.byBackend[0]!)).toBe(0);
  });
});
