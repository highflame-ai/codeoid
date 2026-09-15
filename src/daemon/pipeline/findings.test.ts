/**
 * The findings loop's pure parts (findings.ts): block extraction, schema
 * parsing, the disposition contract the engine enforces, and the ledger.
 */

import { describe, expect, test } from "bun:test";
import {
  type Finding,
  type FindingsSpec,
  extractLastBlock,
  findingsContract,
  fixContract,
  newLoopState,
  openBlocking,
  parseDispositions,
  parseFindings,
  renderLedger,
  rereviewContract,
  summarizeLoop,
  validateDispositions,
} from "./findings";

const SPEC: FindingsSpec = { fixWith: { role: "implementer" }, blocking: ["critical", "high"], maxRounds: 2 };

const block = (tag: string, v: unknown): string => `some prose\n\n\`\`\`${tag}\n${JSON.stringify(v, null, 2)}\n\`\`\``;

const F1: Finding = { id: "F1", severity: "high", title: "nil deref on empty input", location: "a.go:12" };
const F2: Finding = { id: "F2", severity: "low", title: "naming" };

describe("extractLastBlock", () => {
  test("returns the LAST block with the tag, tolerating CRLF and trailing spaces", () => {
    const text = "```findings\n[1]\n```\nlater\n```findings  \r\n[2]\r\n```\n```other\n[3]\n```";
    expect(extractLastBlock(text, "findings")?.trim()).toBe("[2]");
    expect(extractLastBlock(text, "other")?.trim()).toBe("[3]");
    expect(extractLastBlock(text, "nope")).toBeUndefined();
  });
});

describe("parseFindings", () => {
  test("parses a valid block", () => {
    const p = parseFindings(block("findings", [F1, F2]));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.map((f) => f.id)).toEqual(["F1", "F2"]);
  });

  test("an empty array is a clean report", () => {
    const p = parseFindings(block("findings", []));
    expect(p).toEqual({ ok: true, value: [] });
  });

  test("names the gap: missing block, bad JSON, schema, duplicate ids", () => {
    expect(parseFindings("no block here")).toMatchObject({ ok: false, reason: expect.stringContaining("no ```findings block") });
    expect(parseFindings("```findings\n{oops\n```")).toMatchObject({ ok: false, reason: expect.stringContaining("not valid JSON") });
    expect(parseFindings(block("findings", [{ id: "F1", severity: "urgent", title: "x" }]))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("severity"),
    });
    expect(parseFindings(block("findings", [F1, { ...F2, id: "F1" }]))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('duplicate finding id "F1"'),
    });
  });
});

describe("validateDispositions (the contract the engine enforces)", () => {
  test("every blocking finding needs a disposition; non-blocking ones may be left alone", () => {
    expect(validateDispositions([F1, F2], SPEC.blocking, [{ id: "F1", disposition: "fixed" }])).toEqual({ ok: true });
    const missing = validateDispositions([F1, F2], SPEC.blocking, []);
    expect(missing).toMatchObject({ ok: false, reason: expect.stringContaining('blocking finding "F1" (high) has no disposition') });
  });

  test("anything but `fixed` needs a reason — no bare deferrals", () => {
    for (const disposition of ["not_a_finding", "declined", "deferred"] as const) {
      const r = validateDispositions([F1], SPEC.blocking, [{ id: "F1", disposition }]);
      expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(`"F1" is ${disposition} without a reason`) });
      expect(validateDispositions([F1], SPEC.blocking, [{ id: "F1", disposition, reason: "because" }])).toEqual({ ok: true });
    }
  });

  test("unknown ids and duplicate dispositions are refused", () => {
    expect(validateDispositions([F1], SPEC.blocking, [{ id: "F1", disposition: "fixed" }, { id: "F9", disposition: "fixed" }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"F9" is not a reported finding'),
    });
    expect(
      validateDispositions([F1], SPEC.blocking, [
        { id: "F1", disposition: "fixed" },
        { id: "F1", disposition: "declined", reason: "r" },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('"F1" has more than one disposition') });
  });

  test("parseDispositions rejects an unknown disposition kind", () => {
    expect(parseDispositions(block("dispositions", [{ id: "F1", disposition: "wontfix" }]))).toMatchObject({ ok: false });
    expect(parseDispositions(block("dispositions", [{ id: "F1", disposition: "declined", reason: "r" }]))).toMatchObject({ ok: true });
  });
});

describe("loop state helpers + ledger", () => {
  test("openBlocking reads the LATEST round only", () => {
    const loop = newLoopState();
    loop.rounds.push({ findings: [F1, F2], dispositions: [{ id: "F1", disposition: "fixed" }] });
    loop.fixLegs = 1;
    expect(openBlocking(loop, SPEC).map((f) => f.id)).toEqual(["F1"]); // reviewer hasn't re-reviewed yet
    loop.rounds.push({ findings: [F2] });
    expect(openBlocking(loop, SPEC)).toEqual([]);
    expect(summarizeLoop(loop, SPEC)).toBe("1 finding open (0 blocking), 1 fixed — 2 review rounds, 1 fix leg");
  });

  test("renderLedger shows every round, dispositions with reasons, and open markers", () => {
    const loop = newLoopState();
    loop.rounds.push({
      findings: [F1, F2],
      dispositions: [
        { id: "F1", disposition: "fixed", evidence: "guard added; go test ./... green" },
        { id: "F2", disposition: "declined", reason: "matches house style" },
      ],
    });
    loop.rounds.push({ findings: [{ id: "F3", severity: "critical", title: "regression | pipe in title" }] });
    const md = renderLedger(loop, SPEC);
    expect(md).toContain("### Review round 1");
    expect(md).toContain("| F1 | high | nil deref on empty input | a.go:12 | FIXED (guard added; go test ./... green) |");
    expect(md).toContain("DECLINED — matches house style");
    expect(md).toContain("### Review round 2 (open set)");
    expect(md).toContain("regression \\| pipe in title"); // table-safe
    expect(md).toContain("| open |");
  });
});

describe("contracts", () => {
  test("the review contract names the blocking severities and the block shape", () => {
    const c = findingsContract(SPEC);
    expect(c).toContain("critical and high BLOCK");
    expect(c).toContain("```findings");
  });

  test("the re-review contract carries the ledger and asks for the OPEN set", () => {
    const loop = newLoopState();
    loop.rounds.push({ findings: [F1], dispositions: [{ id: "F1", disposition: "fixed" }] });
    const c = rereviewContract(loop, SPEC);
    expect(c).toContain("Review round 2");
    expect(c).toContain("| F1 | high |");
    expect(c).toContain("ONLY what remains open");
  });

  test("the fix contract lists findings, marks blocking, and carries format feedback on a retry", () => {
    const c = fixContract({ findings: [F1, F2] }, SPEC, 'blocking finding "F1" (high) has no disposition');
    expect(c).toContain("**F1** [high, blocking]");
    expect(c).toContain("**F2** [low]");
    expect(c).toContain("```dispositions");
    expect(c).toContain("did not satisfy the contract");
  });
});
