// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { EvidenceView } from "./EvidenceView";
import type { EvidenceWire } from "../protocol/types";

const base: EvidenceWire = {
  id: "ev_1",
  ownerKind: "pipeline",
  ownerId: "p1",
  criterionId: "impl:test",
  candidateDigest: null,
  verifierDigest: "abc",
  isolation: "process",
  command: "bun test",
  result: "fail",
  reason: "exited with code 1",
  exitCode: 1,
  signal: null,
  timedOut: false,
  startedAt: "2026-10-25T10:00:00.000Z",
  endedAt: "2026-10-25T10:00:02.500Z",
  environment: { platform: "linux", arch: "x64", runtime: "bun 1.3", envKeys: [] },
  stdoutExcerpt: "",
  stderrExcerpt: "expect(received).toBe(expected)\nExpected: 2\nReceived: 3",
  artifacts: [],
};

afterEach(cleanup);

function mount(e: EvidenceWire): HTMLElement {
  return render(() => <EvidenceView evidence={e} />).container;
}

describe("EvidenceView", () => {
  it("shows the result, the command, the duration and the failing output", () => {
    const text = mount(base).textContent ?? "";
    expect(text).toContain("fail");
    expect(text).toContain("bun test");
    expect(text).toContain("2.5s");
    expect(text).toContain("Received: 3");
    expect(text).toContain("no pinned tree");
  });

  it("names the pinned tree when there is one", () => {
    expect(mount({ ...base, result: "pass", candidateDigest: "0123456789abcdef" }).textContent).toContain(
      "tree 0123456789ab",
    );
  });

  it("keeps only the end of long output", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const text = mount({ ...base, stderrExcerpt: long }).textContent ?? "";
    expect(text).toContain("line 99");
    expect(text).not.toContain("line 10\n");
    expect(text).not.toMatch(/line 5(?!\d)/);
  });
});
