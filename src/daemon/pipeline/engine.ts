/**
 * The pipeline advance logic.
 *
 * Pure over (PipelineState × registries): `step()` moves one phase forward
 * (promote → optional entry gate → run kind → exit gate → transition) and
 * returns a NEW state; `run()` loops `step()` until the pipeline is terminal or
 * halted, invoking `onProgress` after each step so the caller can persist.
 *
 * Persistence, identity, worker sessions, and frontend surfacing are NOT here —
 * they compose around this in PipelineManager (and later slices). Keeping the
 * transition rules side-effect-free is exactly what makes them unit-testable.
 */

import type {
  GateVerdict,
  PhaseDef,
  PhaseFailAction,
  PhaseRunResult,
  PipelinePhase,
  PipelineRegistries,
  PipelineState,
} from "./interface";
import { isTerminal } from "./interface";
import { errMessage } from "./errors";
import { resolveScoped } from "./scoped";

/** Defensive cap against a mis-authored retry loop (each retry is one step). */
const MAX_STEPS = 10_000;

// structuredClone is faster than a JSON round-trip and doesn't silently coerce
// (PipelineState is plain data, so both are safe — this just avoids the double
// serialize/parse on every step and gate).
const clone = <T>(x: T): T => structuredClone(x);
const now = (): number => Date.now();

export class PipelineEngine {
  #registries: PipelineRegistries;

  constructor(registries: PipelineRegistries) {
    this.#registries = registries;
  }

  /** Advance the active phase by one unit of work and return a new state. */
  async step(state: PipelineState): Promise<PipelineState> {
    if (isTerminal(state.status) || state.status === "halted") return state;
    const s = clone(state);
    if (s.status === "draft") s.status = "running";

    const phase = s.phases[s.cursor];
    if (!phase) {
      // cursor ran off the end — the pipeline is complete.
      s.status = "done";
      return touch(s);
    }

    // A phase's FIRST entry is the pending→running promotion. A retry
    // (applyFail) or a human revise (#reviseInner) sets `running` directly, so
    // `wasPending` is false there — the auto-skip below must not fire on a
    // re-entry (the phase already RAN; re-checking the probe would mislabel "the
    // model just did the work" as skipped and bypass the exit gate + human
    // boundary a normal pass gets).
    const wasPending = phase.state.status === "pending";
    if (phase.state.status === "pending") {
      phase.state = { status: "running", startedAt: now(), attempts: 0 };
    }
    if (phase.state.status !== "running") {
      // a passed / failed / halted phase sits under the cursor — nothing to run.
      return touch(s);
    }
    const attempts = phase.state.attempts;

    // Auto-skip (opt-in) — if the phase requested it and its exit `gate` (a
    // deterministic probe) ALREADY passes at FIRST entry, the deliverable is
    // already present, so mark the phase `skipped` and advance without running it
    // (the partially-built / resume case, docs/pipeline-phase-detection.md). A
    // stale artifact is never silently accepted for a phase that didn't opt in,
    // the skip is recorded (status + reason) not hidden, and it only pre-empts a
    // never-run phase (see `wasPending` above).
    if (wasPending && phase.def.skipWhenSatisfied && phase.def.gate) {
      const v = await this.#gate(phase.def.gate, s, phase.def, "entry");
      if (v.pass) {
        phase.state = {
          status: "skipped",
          reason: `deliverable already present — exit probe "${phase.def.gate}" satisfied at entry`,
        };
        s.cursor += 1;
        s.status = s.cursor >= s.phases.length ? "done" : "running";
        return touch(s);
      }
    }

    // Entry (grounding) gate — read-only probe before the phase acts (§5a.3).
    if (phase.def.entryGate) {
      const v = await this.#gate(phase.def.entryGate, s, phase.def, "entry");
      if (!v.pass) return applyFail(s, phase, v, attempts, "entry");
    }

    // Run the phase kind. A throwing plugin must not crash the run and leave
    // the pipeline stuck "running" in the store (→ a restart crash-loop); a
    // throw is treated as a phase failure, then handled by the onFail policy.
    const kind = this.#registries.phases.resolve(phase.def.kind);
    let res: PhaseRunResult;
    if (!kind) {
      res = { outcome: "failed", reason: `unknown phase kind "${phase.def.kind}"` };
    } else {
      try {
        // Hand plugins a clone — a buggy/hostile kind mutating our working
        // state must not corrupt the engine's transition (the "returns a NEW
        // state" guarantee).
        res = await kind.run({ pipeline: clone(s), phase: phase.def, registries: this.#registries });
      } catch (err) {
        res = { outcome: "failed", reason: `phase kind "${phase.def.kind}" threw: ${errMessage(err)}` };
      }
    }

    if (res.outcome === "halted") {
      phase.state = {
        status: "halted",
        requestId: res.requestId,
        reason: res.reason,
        questions: res.questions,
      };
      s.status = "halted";
      return touch(s);
    }
    if (res.outcome === "failed") {
      return applyFail(s, phase, { pass: false, reason: res.reason }, attempts, "kind");
    }

    // Keep the run's output on the phase so a subsequent revise can show the
    // agent its prior attempt — even if the exit gate now fails and halts (the
    // halted state itself doesn't carry a summary).
    if (res.summary !== undefined) phase.lastSummary = res.summary;

    // Exit boundary — two DISTINCT things happen here:
    //
    //   1. An optional automated CHECK. A `command` gate produces a real pass/
    //      fail verdict. A failing check still honors onFail:retry (machine loop
    //      within budget) or onFail:abort (hard fail); with the default halt it
    //      just carries its reason to the human. `skill`/`review`/`self` gates
    //      carry no automated verdict yet — they pass, and the human is the
    //      reviewer (S4 may add subagent verdicts). See pack.ts.
    //   2. The phase then HALTS for a human decision (Approve / Revise / Reject).
    //      This boundary halt is UNIVERSAL: a run never rolls into the next phase
    //      on its own — the human always decides (docs/pipeline-run.md).
    let gateReason: string | undefined;
    if (phase.def.gate) {
      const v = await this.#gate(phase.def.gate, s, phase.def, "exit");
      if (!v.pass) {
        const onFail = phase.def.onFail ?? { action: "halt" };
        // A machine retry/abort short-circuits the human boundary.
        if (onFail.action === "retry" || onFail.action === "abort") {
          return applyFail(s, phase, v, attempts, "exit");
        }
        gateReason = v.reason ?? "gate check failed";
      }
    }

    // The phase's work is done (kept in lastSummary); halt for the human.
    phase.state = {
      status: "halted",
      requestId: `exit:${phase.def.id}`,
      reason: gateReason
        ? `phase "${phase.def.id}" complete — gate not satisfied: ${gateReason}`
        : `phase "${phase.def.id}" complete — review and approve`,
    };
    s.status = "halted";
    return touch(s);
  }

  /** Drive the pipeline forward until it is terminal or halted. */
  async run(
    state: PipelineState,
    onProgress?: (s: PipelineState) => void | Promise<void>,
  ): Promise<PipelineState> {
    let s = state;
    let guard = 0;
    while ((s.status === "draft" || s.status === "running") && guard++ < MAX_STEPS) {
      s = await this.step(s);
      if (onProgress) await onProgress(s);
    }
    // Guard tripped (a mis-authored retry loop) — fail terminally rather than
    // leave the pipeline stuck non-terminal forever (nothing re-drives it).
    if (s.status === "draft" || s.status === "running") {
      s = clone(s);
      const cur = s.phases[s.cursor];
      if (cur && cur.state.status === "running") {
        cur.state = { status: "failed", reason: `pipeline exceeded ${MAX_STEPS} steps`, attempts: cur.state.attempts };
      }
      s.status = "failed";
      touch(s);
      if (onProgress) await onProgress(s);
    }
    return s;
  }

  async #gate(
    id: string,
    pipeline: PipelineState,
    phase: PhaseDef,
    at: "entry" | "exit",
  ): Promise<GateVerdict> {
    // The run's own pack entry first (`<packId>/<id>`), then a bare built-in
    // (`always` / `manual`) or directly registered gate — see scoped.ts.
    const g = resolveScoped(this.#registries.gates, pipeline.packId, id);
    if (!g) return { pass: false, reason: `unknown ${at} gate "${id}"` };
    try {
      return await g.evaluate({ pipeline: clone(pipeline), phase });
    } catch (err) {
      // A throwing gate is a failing verdict, not a crash — same reasoning as
      // the phase kind above: never leave the pipeline stuck mid-advance.
      return { pass: false, reason: `${at} gate "${id}" threw: ${errMessage(err)}` };
    }
  }
}

function touch(s: PipelineState): PipelineState {
  s.updatedAt = now();
  return s;
}

/**
 * Apply a phase failure per its `onFail` policy:
 *   retry (within budget) → re-run; halt (the default) → wait for a human;
 *   abort or retries-exhausted → fail the pipeline.
 *
 * EXCEPTION — a phase EXECUTION error (`source: "kind"`: the phase kind or its
 * runner threw / the turn ended non-idle) is NOT a reviewable gate verdict. A
 * human can't "approve" a crashed turn into success — approval would mark it
 * `passed` (green) even though it never ran. So an execution error never halts:
 * it fails the pipeline (after exhausting any retry budget), which is the
 * intended "a phase error should fail the run" behavior. Gate rejections
 * (entry/exit review + command gates) still halt for the human decision.
 * Mutates + returns the already-cloned state.
 */
function applyFail(
  s: PipelineState,
  phase: PipelinePhase,
  verdict: GateVerdict,
  attempts: number,
  source: "entry" | "exit" | "kind",
): PipelineState {
  const onFail: PhaseFailAction = phase.def.onFail ?? { action: "halt" };
  const reason = verdict.reason ?? "phase gate failed";
  const nextAttempts = attempts + 1;

  if (onFail.action === "retry" && nextAttempts < onFail.max) {
    // Verify-fix loop: thread a failing EXIT probe's reason into the phase
    // feedback so the re-run's prompt tells the model exactly which
    // deterministic check failed. Reuses the revise-feedback channel that
    // composePhasePrompt already reads (skill-kind.ts) — no new plumbing. Only
    // for `exit` (an acceptance verdict the model can act on); an `entry`
    // grounding failure or a `kind` execution error isn't actionable feedback.
    if (source === "exit" && verdict.reason) {
      phase.feedback = [...(phase.feedback ?? []), `Automated check failed — fix and retry: ${verdict.reason}`];
    }
    phase.state = { status: "running", startedAt: now(), attempts: nextAttempts };
    s.status = "running";
    return touch(s);
  }
  if (onFail.action === "halt" && source !== "kind") {
    phase.state = {
      status: "halted",
      // Source-qualified so a phase with both an entry and an exit gate produces
      // distinct halt ids (no collision when answering).
      requestId: `${source}:${phase.def.id}`,
      reason,
      questions: verdict.questions,
    };
    s.status = "halted";
    return touch(s);
  }
  // abort; a retry budget that has now been exhausted; or a phase EXECUTION
  // error (source="kind"), which never halts (see the note above).
  phase.state = { status: "failed", reason, attempts: nextAttempts };
  s.status = "failed";
  return touch(s);
}
