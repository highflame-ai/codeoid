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
 *
 * A phase that declares `def.findings` runs the FINDINGS LOOP (findings.ts):
 * its review legs and fix legs are each one `step()` — one model turn — so the
 * loop persists between legs and resumes after a restart exactly where it was.
 */

import type {
  GateVerdict,
  PhaseCtx,
  PhaseDef,
  PhaseFailAction,
  PhaseRunResult,
  PipelinePhase,
  PipelineRegistries,
  PipelineState,
} from "./interface";
import { isTerminal } from "./interface";
import { errMessage } from "./errors";
import {
  FINDINGS_FIX_SKILL_ID,
  FORMAT_RETRIES,
  type FindingsLoopState,
  type FindingsSpec,
  blockingOf,
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

    // The findings loop's state (findings.ts), when this phase runs it.
    const spec = phase.def.findings;
    if (spec && !phase.findings) phase.findings = newLoopState();
    const loop = spec ? phase.findings : undefined;
    // A leg the LOOP dispatched (a fix leg, the re-review right after it, or a
    // format retry) is not "the phase acting" again — the entry gate is a
    // grounding probe for a phase run, not for every turn inside the loop.
    const loopLeg = loop !== undefined && (loop.next === "fix" || loop.rereview === true || loop.formatRetries > 0);

    // Entry (grounding) gate — read-only probe before the phase acts (§5a.3).
    if (phase.def.entryGate && !loopLeg) {
      const v = await this.#gate(phase.def.entryGate, s, phase.def, "entry");
      if (!v.pass) return applyFail(s, phase, v, attempts, "entry");
    }

    // ── Findings loop: a pending FIX LEG runs instead of the phase's own kind.
    if (spec && loop && loop.next === "fix") {
      return this.#fixLeg(s, phase, spec, loop, attempts);
    }

    // Run the phase kind. A throwing plugin must not crash the run and leave
    // the pipeline stuck "running" in the store (→ a restart crash-loop); a
    // throw is treated as a phase failure, then handled by the onFail policy.
    // For a findings phase this is a REVIEW LEG: the first one carries the
    // findings contract, every later one the ledger + re-review contract, and
    // a retry carries the engine's note on the previous attempt on top.
    const reviewAppend =
      spec && loop
        ? [
            loop.rounds.length === 0 ? findingsContract(spec) : rereviewContract(loop, spec),
            ...(loop.formatFeedback ? [`\nEngine note on your previous attempt: ${loop.formatFeedback}\nAddress it and report again.`] : []),
          ].join("\n")
        : undefined;
    const res = await this.#runKind(s, phase.def, reviewAppend ? { promptAppend: reviewAppend } : {});

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

    // ── Findings loop: record the round; dispatch a fix leg if anything blocks.
    if (spec && loop) {
      loop.rereview = false; // this leg consumed the post-fix re-review
      const parsed = parseFindings(res.summary ?? "");
      if (!parsed.ok) {
        // A report without a valid block is a FORMAT failure, not a verdict:
        // one bounded re-run with the exact gap (the engine's own feedback
        // channel, never the human's revise notes), then the onFail policy.
        if (loop.formatRetries < FORMAT_RETRIES) {
          loop.formatRetries += 1;
          loop.formatFeedback = parsed.reason;
          return touch(s);
        }
        return this.#findingsFail(
          s,
          phase,
          spec,
          loop,
          attempts,
          `phase "${phase.def.id}" produced no valid findings block: ${parsed.reason}`,
        );
      }
      loop.formatRetries = 0;
      loop.formatFeedback = undefined;
      loop.rounds.push({ findings: parsed.value });
      if (blockingOf(parsed.value, spec.blocking).length > 0 && loop.fixLegs < spec.maxRounds) {
        loop.next = "fix";
        return touch(s);
      }
      // Converged (clean) or the fix budget is spent: fall through to the exit
      // boundary. A later human revise re-enters as a review leg with the ledger.
      loop.next = "review";
    }

    // Exit boundary — two DISTINCT things happen here:
    //
    //   1. An optional automated CHECK. A `command` gate produces a real pass/
    //      fail verdict; a `review` gate's verdict is "no blocking finding is
    //      open" once the phase runs the findings loop (pack.ts). A failing
    //      check still honors onFail:retry (machine loop within budget) or
    //      onFail:abort (hard fail); with the default halt it just carries its
    //      reason to the human. `skill`/`self` gates carry no automated verdict
    //      yet — they pass, and the human is the reviewer.
    //   2. The phase then HALTS for a human decision (Approve / Revise / Reject).
    //      This boundary halt is UNIVERSAL: a run never rolls into the next phase
    //      on its own — the human always decides (docs/pipeline-run.md).
    let gateReason: string | undefined;
    let verdict: GateVerdict = { pass: true };
    if (phase.def.gate) verdict = await this.#gate(phase.def.gate, s, phase.def, "exit");
    const openBlockers = spec && loop ? openBlocking(loop, spec) : [];
    if (verdict.pass && spec && loop && openBlockers.length > 0) {
      // No gate (or a passing one) but blocking findings are still open — the
      // loop's own verdict fails the boundary, ledger attached, whether or not
      // the pack declared a `review` gate.
      verdict = {
        pass: false,
        reason: `${openBlockers.length} blocking finding${openBlockers.length === 1 ? "" : "s"} still open after ${loop.fixLegs} fix leg${loop.fixLegs === 1 ? "" : "s"}:\n${renderLedger(loop, spec)}`,
      };
    }
    if (!verdict.pass) {
      const onFail = phase.def.onFail ?? { action: "halt" };
      // A findings phase whose boundary fails on OPEN BLOCKERS: `retry` means
      // "another fix loop" (fresh fix budget, straight to a fix leg — the
      // reviewer already spoke), never "re-run the read-only reviewer with the
      // ledger pasted into its revise notes". `abort` fails as usual.
      if (spec && loop && openBlockers.length > 0 && (onFail.action === "retry" || onFail.action === "abort")) {
        return this.#findingsFail(s, phase, spec, loop, attempts, verdict.reason ?? "blocking findings open");
      }
      // A machine retry/abort short-circuits the human boundary.
      if (onFail.action === "retry" || onFail.action === "abort") {
        return applyFail(s, phase, verdict, attempts, "exit");
      }
      gateReason = verdict.reason ?? "gate check failed";
    }

    // The phase's work is done (kept in lastSummary); halt for the human. A
    // findings phase carries the loop's one-line summary in both branches.
    const ledger = spec && loop ? ` — ${summarizeLoop(loop, spec)}` : "";
    phase.state = {
      status: "halted",
      requestId: `exit:${phase.def.id}`,
      reason: gateReason
        ? `phase "${phase.def.id}" complete${ledger} — gate not satisfied: ${gateReason}`
        : `phase "${phase.def.id}" complete${ledger} — review and approve`,
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

  /**
   * One FIX LEG of the findings loop: run the built-in `findings-fix` skill on
   * the same bound session under the phase's `fixWith` role (the runner swaps
   * the role per leg exactly as it swaps it per phase), parse + validate the
   * dispositions the engine demanded, run the optional fix gate, and only THEN
   * commit the leg and hand the phase back to a review leg. A format gap or a
   * failing fix gate gets one bounded repair of the SAME leg with the exact
   * problem fed back; a problem after that goes to the phase's onFail policy
   * with the ledger — never to the reviewer with a red tree.
   */
  async #fixLeg(
    s: PipelineState,
    phase: PipelinePhase,
    spec: FindingsSpec,
    loop: FindingsLoopState,
    attempts: number,
  ): Promise<PipelineState> {
    const round = loop.rounds[loop.rounds.length - 1];
    if (!round) {
      // Unreachable by construction (next="fix" is set right after a round is
      // pushed); recover rather than wedge — treat as "review next".
      loop.next = "review";
      return touch(s);
    }
    const legDef: PhaseDef = {
      id: `${phase.def.id}#fix${loop.fixLegs + 1}`,
      kind: "skill",
      skill: FINDINGS_FIX_SKILL_ID,
      role: spec.fixWith.role,
      ...(spec.fixWith.provider !== undefined ? { provider: spec.fixWith.provider } : {}),
      ...(spec.fixWith.model !== undefined ? { model: spec.fixWith.model } : {}),
      ...(spec.fixWith.resolvedFrom !== undefined ? { resolvedFrom: spec.fixWith.resolvedFrom } : {}),
    };
    // The human's revise notes reach the fixer too — "fix F3 this way" is for
    // the writer, and a note left while a fix leg was pending must not be lost.
    const res = await this.#runKind(s, legDef, {
      promptAppend: fixContract(round, spec, loop.formatFeedback, phase.feedback),
      freshPrompt: true,
    });
    if (res.outcome === "halted") {
      phase.state = { status: "halted", requestId: res.requestId, reason: res.reason, questions: res.questions };
      s.status = "halted";
      return touch(s);
    }
    if (res.outcome === "failed") {
      return applyFail(s, phase, { pass: false, reason: `fix leg "${legDef.id}" failed: ${res.reason}` }, attempts, "kind");
    }
    // The same-leg repair path: one bounded retry with the exact problem.
    const repair = (problem: string): PipelineState | null => {
      if (loop.formatRetries < FORMAT_RETRIES) {
        loop.formatRetries += 1;
        loop.formatFeedback = problem;
        return touch(s); // still running; next stays "fix"
      }
      return null;
    };
    const parsed = parseDispositions(res.summary ?? "");
    const check = parsed.ok ? validateDispositions(round.findings, spec.blocking, parsed.value) : parsed;
    if (!check.ok) {
      return (
        repair(check.reason) ??
        this.#findingsFail(
          s,
          phase,
          spec,
          loop,
          attempts,
          `fix leg "${legDef.id}" did not resolve the findings: ${check.reason}\n${renderLedger(loop, spec)}`,
        )
      );
    }
    // The fix gate (e.g. tests_pass) — evaluated BEFORE the leg counts, so a
    // fixer that broke the build repairs its own leg instead of handing the
    // reviewer a red tree (and, on the last budgeted leg, a dead end).
    if (spec.gate) {
      const v = await this.#gate(spec.gate, s, legDef, "exit");
      if (!v.pass) {
        const problem = `fix gate "${spec.gate}" failed: ${v.reason ?? "check failed"}`;
        return (
          repair(problem) ??
          this.#findingsFail(s, phase, spec, loop, attempts, `fix leg "${legDef.id}" — ${problem}\n${renderLedger(loop, spec)}`)
        );
      }
    }
    round.dispositions = parsed.ok ? parsed.value : [];
    round.fixSummary = res.summary;
    loop.fixLegs += 1;
    loop.formatRetries = 0;
    loop.formatFeedback = undefined;
    loop.next = "review";
    loop.rereview = true;
    return touch(s);
  }

  /**
   * A findings phase failed at its loop (a leg exhausted its repair, or
   * blocking findings stayed open past the budget): apply the phase's onFail
   * policy WITHOUT the generic retry channel. `retry` on a findings phase is
   * another fix loop — fresh fix budget, straight to a fix leg when blockers
   * are open — with the reason carried as the engine's note to the next leg,
   * never appended to the human's revise notes (where it would be rendered as
   * revision history and re-pasted into every later prompt).
   */
  #findingsFail(
    s: PipelineState,
    phase: PipelinePhase,
    spec: FindingsSpec,
    loop: FindingsLoopState,
    attempts: number,
    reason: string,
  ): PipelineState {
    const onFail: PhaseFailAction = phase.def.onFail ?? { action: "halt" };
    loop.formatRetries = 0;
    loop.formatFeedback = undefined;
    loop.rereview = false;
    const blockersOpen = openBlocking(loop, spec).length > 0;
    loop.next = blockersOpen ? "fix" : "review";
    const nextAttempts = attempts + 1;
    if (onFail.action === "retry" && nextAttempts < onFail.max) {
      loop.fixLegs = 0;
      loop.formatFeedback = reason;
      phase.state = { status: "running", startedAt: now(), attempts: nextAttempts };
      s.status = "running";
      return touch(s);
    }
    if (onFail.action === "halt") {
      // A human Revise re-enters as a review leg (the reviewer speaks first);
      // the ledger in the reason is what they decide on.
      loop.next = "review";
      phase.state = { status: "halted", requestId: `exit:${phase.def.id}`, reason };
      s.status = "halted";
      return touch(s);
    }
    phase.state = { status: "failed", reason, attempts: nextAttempts };
    s.status = "failed";
    return touch(s);
  }

  /** Run a phase kind for `def` — the phase's own def or a synthetic fix-leg
   *  def — with the engine's prompt extras. A throw is a failed result. */
  async #runKind(
    s: PipelineState,
    def: PhaseDef,
    extra: Pick<PhaseCtx, "promptAppend" | "freshPrompt">,
  ): Promise<PhaseRunResult> {
    const kind = this.#registries.phases.resolve(def.kind);
    if (!kind) return { outcome: "failed", reason: `unknown phase kind "${def.kind}"` };
    try {
      // Hand plugins a clone — a buggy/hostile kind mutating our working
      // state must not corrupt the engine's transition (the "returns a NEW
      // state" guarantee).
      return await kind.run({ pipeline: clone(s), phase: def, registries: this.#registries, ...extra });
    } catch (err) {
      return { outcome: "failed", reason: `phase kind "${def.kind}" threw: ${errMessage(err)}` };
    }
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
