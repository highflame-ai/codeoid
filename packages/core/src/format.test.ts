import { describe, it, expect } from "bun:test";
import {
  formatCollaborationCost,
  formatTokens,
  formatCostUsd,
  formatDuration,
  formatPercent,
  elapsedSince,
  relativeTime,
} from "./format.js";

describe("formatTokens", () => {
  it("renders sub-thousand counts as integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(7)).toBe("7");
    expect(formatTokens(342)).toBe("342");
    expect(formatTokens(999)).toBe("999");
  });

  it("renders four-digit counts with one decimal k", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9999)).toBe("10k");
  });

  it("renders five-digit counts as rounded k", () => {
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(99_999)).toBe("100k");
  });

  it("renders million-scale with one-decimal precision", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_234_000)).toBe("1.2M");
    expect(formatTokens(9_876_543)).toBe("9.9M");
  });

  it("handles missing/invalid input gracefully", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
  });
});

describe("formatCostUsd", () => {
  it("collapses zero to a clean $0", () => {
    expect(formatCostUsd(0)).toBe("$0");
  });

  it("shows micro-amounts as <$0.01", () => {
    expect(formatCostUsd(0.0001)).toBe("<$0.01");
    expect(formatCostUsd(0.0049)).toBe("<$0.01");
  });

  it("shows three-decimal precision under $0.10", () => {
    expect(formatCostUsd(0.005)).toBe("$0.005");
    expect(formatCostUsd(0.099)).toBe("$0.099");
  });

  it("shows two-decimal precision in the $0.10–$10 range", () => {
    expect(formatCostUsd(0.12)).toBe("$0.12");
    expect(formatCostUsd(3.42)).toBe("$3.42");
    expect(formatCostUsd(9.99)).toBe("$9.99");
  });

  it("rounds to whole dollars at scale", () => {
    expect(formatCostUsd(10)).toBe("$10");
    expect(formatCostUsd(1234.56)).toBe("$1,235");
  });

  it("handles missing input", () => {
    expect(formatCostUsd(null)).toBe("—");
    expect(formatCostUsd(undefined)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("renders sub-second as ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(120)).toBe("120ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders sub-minute as seconds", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(8_500)).toBe("9s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("renders minutes-and-seconds", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(135_000)).toBe("2m 15s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("renders hours-and-minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_040_000)).toBe("1h 24m");
    expect(formatDuration(72_000_000)).toBe("20h");
  });

  it("rejects bad input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("renders with default zero digits", () => {
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(0.6309, 0)).toBe("63%");
  });

  it("respects digits param", () => {
    expect(formatPercent(0.6309, 1)).toBe("63.1%");
    expect(formatPercent(0.6309, 2)).toBe("63.09%");
  });

  it("handles boundaries", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("elapsedSince", () => {
  it("converts an ISO string + now to a duration", () => {
    const start = new Date("2026-05-04T08:00:00Z").getTime();
    const now = start + 5_040_000; // 1h 24m later
    expect(elapsedSince(new Date(start).toISOString(), now)).toBe("1h 24m");
  });

  it("accepts epoch ms directly", () => {
    const now = Date.now();
    expect(elapsedSince(now - 8_000, now)).toBe("8s");
  });
});

describe("relativeTime", () => {
  const NOW = new Date("2026-05-04T12:00:00Z").getTime();

  it("renders just-now for sub-minute spans", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeTime(NOW + 1_000, NOW)).toBe("just now");
  });

  it("renders Nm ago", () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  });

  it("renders Nh ago", () => {
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
  });

  it("renders yesterday in the 24-48h window", () => {
    expect(relativeTime(NOW - 30 * 3_600_000, NOW)).toBe("yesterday");
  });
});

describe("formatCollaborationCost", () => {
  const base = { children: 2, totalCostUsd: 1.234, inputTokens: 45_000, outputTokens: 3_200, numTurns: 7 };

  it("reads as one compact decision-side line", () => {
    expect(formatCollaborationCost(base)).toBe(
      "this goal so far: $1.23 · 45k/3.2k tok · 7 turns · across 3 sessions",
    );
  });

  it("counts the orchestrator in the session total, not just the children", () => {
    // "across N sessions" is children + 1. Reporting only the children would
    // understate the fleet the owner is paying for.
    expect(formatCollaborationCost({ ...base, children: 0 })).toContain("across 1 session");
    expect(formatCollaborationCost({ ...base, children: 1 })).toContain("across 2 sessions");
  });

  it("singularizes one turn and one session", () => {
    const s = formatCollaborationCost({ ...base, children: 0, numTurns: 1 });
    expect(s).toContain("1 turn ·");
    expect(s).toContain("across 1 session");
  });

  it("survives a zero-cost goal that has not spent anything yet", () => {
    expect(
      formatCollaborationCost({ children: 3, totalCostUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }),
    ).toBe("this goal so far: $0 · 0/0 tok · 0 turns · across 4 sessions");
  });
});
