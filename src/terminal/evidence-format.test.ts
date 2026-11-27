import { describe, expect, test } from "bun:test";
import type { EvidenceWire } from "../protocol/types.js";
import { formatEvidence } from "./evidence-format";

const e: EvidenceWire = {
  id: "ev_1",
  ownerKind: "pipeline",
  ownerId: "p1",
  criterionId: "impl:test",
  candidateDigest: null,
  verifierDigest: "0123456789abcdef0123",
  isolation: "process",
  command: "bun test",
  result: "fail",
  reason: "did not finish within 1000ms and was stopped",
  exitCode: null,
  signal: "SIGTERM",
  timedOut: true,
  startedAt: "2026-10-25T10:00:00.000Z",
  endedAt: "2026-10-25T10:00:01.000Z",
  environment: { platform: "linux", arch: "x64", runtime: "bun 1.3.13", envKeys: [] },
  stdoutExcerpt: Array.from({ length: 60 }, (_, i) => `out ${i}`).join("\n"),
  stderrExcerpt: "",
  artifacts: [{ name: "stdout", sha256: "f".repeat(64), bytes: 420, truncated: true }],
};

describe("formatEvidence", () => {
  test("states the result, why, and that no tree was pinned", () => {
    const text = formatEvidence(e).join("\n");
    expect(text).toContain("ev_1  FAIL  did not finish within 1000ms");
    expect(text).toContain("signal SIGTERM, timed out, 1.0s");
    expect(text).toContain("certifies no particular revision");
    expect(text).toContain("420 bytes (truncated at cap)");
  });

  test("shows the last 40 output lines unless asked for all", () => {
    const short = formatEvidence(e).join("\n");
    expect(short).toContain("out 59");
    expect(short).not.toContain("out 0\n");
    expect(short).toContain("--full");
    expect(formatEvidence(e, { full: true }).join("\n")).toContain("out 0\n");
  });
});
