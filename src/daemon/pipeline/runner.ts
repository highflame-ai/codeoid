/**
 * The seam between a phase and a backend. A `PhaseRunner` runs a phase's prompt
 * on a (worker) session and returns its result. The concrete SessionManager-
 * backed adapter lands in a later slice; abstracting it here keeps the pipeline
 * package free of Session dependencies and lets the skill phase kind be tested
 * with a fake runner.
 */

import type { PhaseDef, PipelineState } from "./interface";

export interface PhaseRunRequest {
  /** the resolved prompt / slash command to run for this phase. */
  prompt: string;
  /** per-phase backend override — enables cross-provider-per-phase routing. */
  provider?: string;
  /** per-phase model override. */
  model?: string;
  pipeline: PipelineState;
  phase: PhaseDef;
}

export interface PhaseRunOutput {
  summary?: string;
  artifacts?: string[];
}

export interface PhaseRunner {
  runPrompt(req: PhaseRunRequest): Promise<PhaseRunOutput>;
}

/** The resting outcome of a worker turn: the terminal status it reached plus the
 *  assistant's final text. Only `idle` is a success — `error` (turn failed),
 *  `waiting_approval` (autonomous budget exhausted mid-turn ⇒ incomplete), and
 *  `timeout` (never rested) are failures the runner surfaces to the engine. */
export interface PhaseTurnResult {
  finalStatus: "idle" | "error" | "waiting_approval" | "timeout";
  text: string;
}

/**
 * The minimal daemon capability a SessionPhaseRunner needs: drive one phase as a
 * streamed turn on the run's BOUND session (the one the user is attached to),
 * returning its resting status + final text. The host applies the phase's
 * capability role to the session first, injects the prompt as a normal turn
 * (visible, interruptible), and resolves when the session rests — no headless
 * worker, no per-phase timeout, and the session is NOT torn down. Defined here
 * (not imported from the daemon) so the pipeline package stays free of a
 * SessionManager dependency; SessionManager satisfies it structurally.
 */
export interface PhaseTurnHost {
  runPhaseOnSession(req: {
    /** The run's bound session — created + attached before the phase runs. */
    sessionId: string;
    prompt: string;
    provider?: string;
    model?: string;
    /** Pack this run came from + the phase's capability role — the host applies
     *  them to the bound session for this phase (constitution + role tool gate),
     *  swapping the role between phases. Absent for an explicit phase plan. */
    packId?: string;
    roleName?: string;
  }): Promise<PhaseTurnResult>;
}

/**
 * The real PhaseRunner: drives a phase's prompt on a worker session via the
 * daemon host and returns its final text as the phase summary. The host is a
 * thunk so it can be constructed before the SessionManager it points at exists
 * (the manager builds the pipeline manager in its own constructor) — the thunk
 * is only dereferenced at run time, long after construction.
 */
export class SessionPhaseRunner implements PhaseRunner {
  #host: () => PhaseTurnHost;

  constructor(host: () => PhaseTurnHost) {
    this.#host = host;
  }

  async runPrompt(req: PhaseRunRequest): Promise<PhaseRunOutput> {
    const sessionId = req.pipeline.sessionId;
    if (!sessionId) {
      // A run must be bound to a session before it advances (the daemon creates
      // + attaches it at create). No session ⇒ misconfiguration, fail loud.
      throw new Error(`pipeline "${req.pipeline.id}" has no bound session — cannot run phase "${req.phase.id}"`);
    }
    const { finalStatus, text } = await this.#host().runPhaseOnSession({
      sessionId,
      prompt: req.prompt,
      provider: req.provider,
      model: req.model,
      packId: req.pipeline.packId,
      roleName: req.phase.role,
    });
    // Only `idle` is success. A non-idle turn (error / budget-exhausted /
    // timed-out) is a phase FAILURE — throw so the engine applies onFail rather
    // than silently marking the phase passed with a partial/empty summary.
    if (finalStatus !== "idle") {
      const detail = text ? `: ${text.slice(0, 300)}` : "";
      // Name the model binding + the rung that chose it (docs/role-model-binding.md
      // §5): model ids pass through unvalidated, so when a bad one fails HERE the
      // operator must be able to see which layer (CLI / config map / pack pin)
      // supplied it — otherwise the fix is a guessing game across five surfaces.
      const target = [req.phase.provider, req.phase.model].filter(Boolean).join(":");
      const rung = req.phase.resolvedFrom ? ` ← ${req.phase.resolvedFrom}` : "";
      const binding = target ? ` [binding: ${target}${rung}]` : "";
      throw new Error(`phase turn ended in "${finalStatus}"${binding}${detail}`);
    }
    return { summary: text };
  }
}
