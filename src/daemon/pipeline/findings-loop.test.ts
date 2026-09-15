/**
 * The findings loop through the engine (engine.ts + findings.ts): review leg →
 * fix leg under the writer role → re-review, with a scripted runner so every
 * prompt, role swap, and state transition is observable. No backend.
 */

import { describe, expect, test } from "bun:test";
import { registerBuiltins } from "./builtin";
import { PipelineEngine } from "./engine";
import type { FindingsSpec } from "./findings";
import type { PhaseDef, PipelineRegistries, PipelineState } from "./interface";
import { createRegistries } from "./registry";
import type { PhaseRunner, PhaseRunRequest } from "./runner";
import { makeSkillPhaseKind } from "./skill-kind";

const fb = (v: unknown): string => `review report\n\n\`\`\`findings\n${JSON.stringify(v)}\n\`\`\``;
const db = (v: unknown): string => `fix report\n\n\`\`\`dispositions\n${JSON.stringify(v)}\n\`\`\``;

const F1 = { id: "F1", severity: "high", title: "nil deref", location: "a.go:12" };
const F2 = { id: "F2", severity: "low", title: "naming" };

function scripted(outputs: string[]): { runner: PhaseRunner; calls: PhaseRunRequest[] } {
  const calls: PhaseRunRequest[] = [];
  let i = 0;
  return {
    calls,
    runner: {
      async runPrompt(req) {
        calls.push(req);
        const out = outputs[i++];
        if (out === undefined) throw new Error(`scripted runner exhausted at call ${i}`);
        return { summary: out };
      },
    },
  };
}

function regs(runner: PhaseRunner): PipelineRegistries {
  const r = createRegistries();
  registerBuiltins(r);
  r.phases.register(makeSkillPhaseKind(runner));
  r.skills.register({ id: "review", kind: "prompt", template: "Review the change." });
  return r;
}

function pipeline(phases: PhaseDef[]): PipelineState {
  return {
    id: "p",
    name: "p",
    spec: "ship feature X",
    phases: phases.map((def) => ({ def, state: { status: "pending" } })),
    cursor: 0,
    status: "draft",
    accountId: "a",
    projectId: "p",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
  };
}

const spec = (over: Partial<FindingsSpec> = {}): FindingsSpec => ({
  fixWith: { role: "implementer", model: "claude-sonnet-5", resolvedFrom: "config-tier" },
  blocking: ["critical", "high"],
  maxRounds: 2,
  ...over,
});

const reviewPhase = (findings: FindingsSpec, extra: Partial<PhaseDef> = {}): PhaseDef => ({
  id: "review",
  kind: "skill",
  skill: "review",
  role: "reviewer",
  findings,
  ...extra,
});

describe("findings loop — review → fix → re-review", () => {
  test("a blocking finding runs a fix leg under the writer role, then the reviewer verifies; clean → boundary halt", async () => {
    const { runner, calls } = scripted([
      fb([F1, F2]), // round 1: one blocking, one not
      db([{ id: "F1", disposition: "fixed", evidence: "guard added; tests green" }]), // fix leg 1
      fb([F2]), // round 2: F1 verified fixed; F2 stays open but is non-blocking
    ]);
    const out = await new PipelineEngine(regs(runner)).run(pipeline([reviewPhase(spec())]));

    expect(calls).toHaveLength(3);
    // Review leg 1: the reviewer's own role and the findings contract.
    expect(calls[0]!.phase.role).toBe("reviewer");
    expect(calls[0]!.prompt).toContain("Review the change.");
    expect(calls[0]!.prompt).toContain("```findings");
    // Fix leg: the WRITER role, its own persisted binding, a fresh prompt with
    // the findings + disposition contract, and the run's goal as context.
    expect(calls[1]!.phase.id).toBe("review#fix1");
    expect(calls[1]!.phase.role).toBe("implementer");
    expect(calls[1]!.model).toBe("claude-sonnet-5");
    expect(calls[1]!.phase.resolvedFrom).toBe("config-tier");
    expect(calls[1]!.prompt).toContain("implementer for this pipeline run");
    expect(calls[1]!.prompt).toContain("**F1** [high, blocking] nil deref — a.go:12");
    expect(calls[1]!.prompt).toContain("```dispositions");
    expect(calls[1]!.prompt).toContain("ship feature X");
    expect(calls[1]!.prompt).not.toContain("Your previous output for this phase");
    // Re-review: back under the reviewer, carrying the ledger.
    expect(calls[2]!.phase.role).toBe("reviewer");
    expect(calls[2]!.prompt).toContain("Review round 2");
    expect(calls[2]!.prompt).toContain("FIXED (guard added; tests green)");

    expect(out.status).toBe("halted");
    const ph = out.phases[0]!;
    expect(ph.state.status).toBe("halted");
    if (ph.state.status === "halted") {
      expect(ph.state.requestId).toBe("exit:review");
      expect(ph.state.reason).toContain("1 finding open (0 blocking), 1 fixed — 2 review rounds, 1 fix leg");
      expect(ph.state.reason).toContain("review and approve");
    }
    expect(ph.findings?.rounds).toHaveLength(2);
    expect(ph.findings?.fixLegs).toBe(1);
    expect(ph.findings?.rounds[0]!.dispositions).toEqual([{ id: "F1", disposition: "fixed", evidence: "guard added; tests green" }]);
    expect(ph.lastSummary).toContain("review report"); // the LAST review leg's output
  });

  test("a clean first report needs no fix leg", async () => {
    const { runner, calls } = scripted([fb([])]);
    const out = await new PipelineEngine(regs(runner)).run(pipeline([reviewPhase(spec())]));
    expect(calls).toHaveLength(1);
    expect(out.status).toBe("halted");
    const st = out.phases[0]!.state;
    if (st.status === "halted") expect(st.reason).toContain("0 findings open (0 blocking), 0 fixed — 1 review round, 0 fix legs");
  });

  test("blocking findings still open when the fix budget is spent fail the boundary with the ledger (halt by default, abort if asked)", async () => {
    const script = [
      fb([F1]),
      db([{ id: "F1", disposition: "declined", reason: "by design" }]),
      fb([F1]), // reviewer does not accept the reason: still open
    ];
    const halted = await new PipelineEngine(regs(scripted(script).runner)).run(
      pipeline([reviewPhase(spec({ maxRounds: 1 }))]),
    );
    expect(halted.status).toBe("halted");
    const st = halted.phases[0]!.state;
    if (st.status === "halted") {
      expect(st.reason).toContain("gate not satisfied");
      expect(st.reason).toContain("1 blocking finding still open after 1 fix leg");
      expect(st.reason).toContain("DECLINED — by design");
    }
    const aborted = await new PipelineEngine(regs(scripted(script).runner)).run(
      pipeline([reviewPhase(spec({ maxRounds: 1 }), { onFail: { action: "abort" } })]),
    );
    expect(aborted.status).toBe("failed");
  });

  test("maxRounds: 0 is an audit-only phase — findings are reported, never fixed", async () => {
    const { runner, calls } = scripted([fb([F1])]);
    const out = await new PipelineEngine(regs(runner)).run(pipeline([reviewPhase(spec({ maxRounds: 0 }))]));
    expect(calls).toHaveLength(1);
    const st = out.phases[0]!.state;
    if (st.status === "halted") expect(st.reason).toContain("still open after 0 fix legs");
  });

  test("a fix leg that omits or botches its dispositions gets ONE retry with the exact gap, then the phase halts with the ledger", async () => {
    // Retry succeeds.
    const ok = scripted([fb([F1]), "I fixed it, trust me", db([{ id: "F1", disposition: "fixed" }]), fb([])]);
    const out = await new PipelineEngine(regs(ok.runner)).run(pipeline([reviewPhase(spec())]));
    expect(ok.calls).toHaveLength(4);
    expect(ok.calls[2]!.phase.id).toBe("review#fix1"); // same leg, retried
    expect(ok.calls[2]!.prompt).toContain("Engine note on your previous attempt: no ```dispositions block");
    expect(out.status).toBe("halted");
    expect(out.phases[0]!.findings?.fixLegs).toBe(1);

    // Retry also fails → halt (default onFail) carrying the gap + ledger.
    const bad = scripted([fb([F1]), db([{ id: "F1", disposition: "deferred" }]), db([{ id: "F1", disposition: "deferred" }])]);
    const halted = await new PipelineEngine(regs(bad.runner)).run(pipeline([reviewPhase(spec())]));
    expect(bad.calls).toHaveLength(3);
    expect(bad.calls[2]!.prompt).toContain('"F1" is deferred without a reason');
    expect(halted.status).toBe("halted");
    const st = halted.phases[0]!.state;
    if (st.status === "halted") {
      expect(st.requestId).toBe("exit:review");
      expect(st.reason).toContain("did not resolve the findings");
      expect(st.reason).toContain("| F1 | high |");
    }
  });

  test("a review leg without a valid findings block gets ONE retry with the gap, then onFail", async () => {
    const ok = scripted(["looks fine to me", fb([])]);
    const out = await new PipelineEngine(regs(ok.runner)).run(pipeline([reviewPhase(spec())]));
    expect(ok.calls).toHaveLength(2);
    expect(ok.calls[1]!.prompt).toContain("Engine note on your previous attempt: no ```findings block");
    expect(ok.calls[1]!.phase.role).toBe("reviewer");
    expect(out.status).toBe("halted");
    expect(out.phases[0]!.findings?.rounds).toHaveLength(1);
    expect(out.phases[0]!.feedback).toBeUndefined(); // the human's revise channel is untouched

    const bad = scripted(["looks fine", "still no block"]);
    const halted = await new PipelineEngine(regs(bad.runner)).run(pipeline([reviewPhase(spec())]));
    expect(halted.status).toBe("halted");
    const st = halted.phases[0]!.state;
    if (st.status === "halted") expect(st.reason).toContain("produced no valid findings block");
  });

  test("a failing fix gate repairs the SAME fix leg once (the leg does not count), then halts with the ledger", async () => {
    // `manual` never passes, so the repair also fails → halt. The leg never
    // committed: fixLegs stays 0 and the reviewer is never handed a red tree.
    const { runner, calls } = scripted([fb([F1]), db([{ id: "F1", disposition: "fixed" }]), db([{ id: "F1", disposition: "fixed" }])]);
    const out = await new PipelineEngine(regs(runner)).run(pipeline([reviewPhase(spec({ gate: "manual" }))]));
    expect(calls).toHaveLength(3);
    expect(calls[2]!.phase.id).toBe("review#fix1"); // the same leg, repaired
    expect(calls[2]!.prompt).toContain('Engine note on your previous attempt: fix gate "manual" failed');
    expect(out.status).toBe("halted");
    const ph = out.phases[0]!;
    expect(ph.findings?.fixLegs).toBe(0);
    expect(ph.findings?.rounds[0]!.dispositions).toBeUndefined();
    expect(ph.findings?.next).toBe("review"); // a human Revise re-enters at the reviewer
    if (ph.state.status === "halted") {
      expect(ph.state.reason).toContain('fix leg "review#fix1" — fix gate "manual" failed');
      expect(ph.state.reason).toContain("| F1 | high |");
    }
  });

  test("a failing fix gate that the repair fixes counts the leg once and continues to the re-review", async () => {
    // A gate that fails the first evaluation and passes the second.
    let evals = 0;
    const flaky = {
      id: "flaky",
      at: "exit" as const,
      async evaluate() {
        evals += 1;
        return evals === 1 ? { pass: false, reason: "2 tests failed" } : { pass: true };
      },
    };
    const { runner, calls } = scripted([fb([F1]), db([{ id: "F1", disposition: "fixed" }]), db([{ id: "F1", disposition: "fixed", evidence: "green now" }]), fb([])]);
    const r = regs(runner);
    r.gates.register(flaky);
    const out = await new PipelineEngine(r).run(pipeline([reviewPhase(spec({ gate: "flaky" }))]));
    expect(calls.map((c) => c.phase.id)).toEqual(["review", "review#fix1", "review#fix1", "review"]);
    expect(out.status).toBe("halted");
    expect(out.phases[0]!.findings?.fixLegs).toBe(1);
    expect(out.phases[0]!.findings?.rounds[0]!.dispositions?.[0]?.evidence).toBe("green now");
  });

  test("onFail: retry on a findings phase is ANOTHER FIX LOOP — fresh budget, straight to a fix leg, nothing pasted into the human's revise notes", async () => {
    const { runner, calls } = scripted([
      fb([F1]), // round 1
      db([{ id: "F1", disposition: "declined", reason: "by design" }]), // fix leg 1 (budget 1)
      fb([F1]), // round 2: still open → budget spent → boundary fails → retry
      db([{ id: "F1", disposition: "fixed" }]), // retry = fresh loop: fix leg first, not the reviewer
      fb([]), // round 3: clean
    ]);
    const out = await new PipelineEngine(regs(runner)).run(
      pipeline([reviewPhase(spec({ maxRounds: 1 }), { onFail: { action: "retry", max: 2 } })]),
    );
    expect(calls.map((c) => c.phase.id)).toEqual(["review", "review#fix1", "review", "review#fix1", "review"]);
    expect(calls[3]!.prompt).toContain("Engine note on your previous attempt: 1 blocking finding still open");
    expect(out.status).toBe("halted");
    const ph = out.phases[0]!;
    expect(ph.feedback).toBeUndefined(); // the revise channel is the human's
    if (ph.state.status === "halted") expect(ph.state.reason).toContain("review and approve");
    // Budget exhausted with blockers still open → failed, as retry semantics demand.
    const stuck = scripted([fb([F1]), db([{ id: "F1", disposition: "declined", reason: "no" }]), fb([F1]), db([{ id: "F1", disposition: "declined", reason: "no" }]), fb([F1])]);
    const failed = await new PipelineEngine(regs(stuck.runner)).run(
      pipeline([reviewPhase(spec({ maxRounds: 1 }), { onFail: { action: "retry", max: 2 } })]),
    );
    expect(failed.status).toBe("failed");
  });

  test("the human's revise notes reach the fixer, and the gate-failure halt keeps the loop summary", async () => {
    const { runner, calls } = scripted([fb([F1]), db([{ id: "F1", disposition: "fixed" }]), fb([])]);
    const p = pipeline([reviewPhase(spec(), { gate: "manual" })]);
    p.phases[0]!.feedback = ["fix F1 with a guard clause, not a try/catch"];
    const out = await new PipelineEngine(regs(runner)).run(p);
    expect(calls[1]!.prompt).toContain("## Notes from the human (revise)");
    expect(calls[1]!.prompt).toContain("guard clause");
    // Loop clean, but the phase's own `manual` gate fails → halt, and the
    // reason still carries the loop's one-line summary.
    expect(out.status).toBe("halted");
    const st = out.phases[0]!.state;
    if (st.status === "halted") {
      expect(st.reason).toContain("0 findings open (0 blocking), 1 fixed");
      expect(st.reason).toContain("gate not satisfied");
    }
  });

  test("the phase's entry gate grounds the phase run once, not every leg of the loop", async () => {
    let entries = 0;
    const counting = {
      id: "counting",
      at: "entry" as const,
      async evaluate() {
        entries += 1;
        return { pass: true };
      },
    };
    const { runner } = scripted(["no block", fb([F1]), "no dispositions", db([{ id: "F1", disposition: "fixed" }]), fb([])]);
    const r = regs(runner);
    r.gates.register(counting);
    const out = await new PipelineEngine(r).run(pipeline([reviewPhase(spec(), { entryGate: "counting" })]));
    expect(out.status).toBe("halted");
    expect(entries).toBe(1); // review retry, fix leg, fix repair, re-review: all loop legs
  });

  test("each leg is one step, and the loop survives a serialize/parse round-trip between legs (restart-safe)", async () => {
    const { runner, calls } = scripted([fb([F1]), db([{ id: "F1", disposition: "fixed" }]), fb([])]);
    const engine = new PipelineEngine(regs(runner));
    let s = await engine.step(pipeline([reviewPhase(spec())]));
    expect(s.status).toBe("running");
    expect(s.phases[0]!.findings?.next).toBe("fix");
    s = JSON.parse(JSON.stringify(s)); // what the store does between steps
    s = await engine.step(s);
    expect(s.phases[0]!.findings?.next).toBe("review");
    expect(s.phases[0]!.findings?.fixLegs).toBe(1);
    s = JSON.parse(JSON.stringify(s));
    s = await engine.step(s);
    expect(s.status).toBe("halted");
    expect(calls.map((c) => c.phase.id)).toEqual(["review", "review#fix1", "review"]);
  });

  test("a phase without `findings` is untouched by the loop", async () => {
    const { runner, calls } = scripted(["done"]);
    const out = await new PipelineEngine(regs(runner)).run(
      pipeline([{ id: "impl", kind: "skill", skill: "review", role: "implementer" }]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).not.toContain("```findings");
    expect(out.phases[0]!.findings).toBeUndefined();
    expect(out.status).toBe("halted");
  });
});
