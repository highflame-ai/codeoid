/**
 * SDLC pipeline — core types + the four plugin-interface seams.
 *
 * See docs/sdlc-pipeline.md (§3a plugin architecture, §5 the primitive, §5a
 * refinements). This module is pure data + interfaces: it imports nothing from
 * the daemon runtime, so the primitive is unit-testable in isolation and the
 * feature lands dark — nothing runs until a manager is wired into the daemon in
 * a later slice.
 */

import type { ResolvedFrom, RoleModelSource } from "./binding";

// ── Phase definition (the static plan) ────────────────────────────────────

/**
 * What to do when a phase's gate (or its kind) fails.
 *   - "halt"  — park at a human decision point; `PipelineManager.answer(approved)`
 *               resumes it. Approving is a deliberate human **override**, even of
 *               a deterministic gate — use "abort" when a failure must be final.
 *               The default.
 *   - "retry" — re-run the phase up to `max` attempts, then fail.
 *   - "abort" — hard-fail the pipeline immediately (no human override).
 */
export type PhaseFailAction =
  | { action: "halt" }
  | { action: "retry"; max: number }
  | { action: "abort" };

/** One phase in a pipeline's plan. `kind` selects the PhaseKind that runs it;
 *  everything else is optional content resolved through the registries. */
export interface PhaseDef {
  id: string;
  name?: string;
  /** id of the PhaseKind that runs this phase (resolved via the phase registry). */
  kind: string; // "noop" | "skill" | "panel" | "gate-only" | custom
  /** id of the SkillPlugin this phase drives (for kind:"skill"). */
  skill?: string;
  /** per-phase backend override (any registered provider id) — enables
   *  cross-provider-per-phase routing (§2a.3). */
  provider?: string;
  /** per-phase model override. */
  model?: string;
  /** Which precedence rung produced this phase's provider/model binding
   *  (docs/role-model-binding.md §3). Written at `pipeline.create` when a
   *  binding resolved; absent = no binding (provider-default behavior, today's
   *  path). Persisted with the run so resume/retry keep the SAME binding even
   *  if config changes underneath, and status can name the layer to fix when
   *  a model id fails at spawn. */
  resolvedFrom?: ResolvedFrom;
  /** exit-gate id — the acceptance predicate evaluated on phase output (§5a.5). */
  gate?: string;
  /** entry (grounding) gate id — a read-only probe before the phase acts (§5a.3). */
  entryGate?: string;
  /** When true, and this phase's exit `gate` (a deterministic probe) already
   *  passes at entry, the phase is auto-marked `skipped` — its deliverable is
   *  already present (the partially-built / resume case,
   *  docs/pipeline-phase-detection.md). OFF by default: no phase auto-skips
   *  unless a pack opts in, so a stale/wrong artifact is never silently accepted
   *  for a phase that didn't request it. */
  skipWhenSatisfied?: boolean;
  /** Capability role this phase runs under — an id into the pack's `roles` (an
   *  ai-factory role envelope). Compiles to Cedar and is enforced at the tool
   *  fence (Shield) so e.g. a `reviewer` phase cannot write or egress (§5a.1).
   *  Carried through the loader now; runtime enforcement wires to Shield next. */
  role?: string;
  /** Reserved metadata (not yet consumed): typed artifact ids this phase reads
   *  / writes (§5a.2). Kept for pack authoring; artifact I/O lands with its
   *  enforcement. Per-phase tool scoping (§5a.1) was removed until the worker
   *  `canUseTool` fence enforces it — an unenforced field is false security. */
  reads?: string[];
  writes?: string;
  /** failure policy for this phase. Defaults to `{ action: "halt" }`. */
  onFail?: PhaseFailAction;
}

// ── Phase + pipeline runtime state ────────────────────────────────────────

export type PhaseState =
  | { status: "pending" }
  | { status: "running"; startedAt: number; attempts: number; workerSessionId?: string }
  | { status: "halted"; requestId: string; reason: string; questions?: string[] }
  | { status: "passed"; summary?: string; artifacts?: string[] }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; attempts: number };

export type PipelineStatus =
  | "draft"
  | "running"
  | "halted"
  | "merged" // terminal success (SDLC framing)
  | "done" // terminal success (generic framing)
  | "failed"
  | "abandoned";

/** Terminal statuses — a pipeline in one of these never advances again. */
export const TERMINAL_STATUSES: readonly PipelineStatus[] = ["merged", "done", "failed", "abandoned"];

export function isTerminal(status: PipelineStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Non-terminal statuses — the exact complement of TERMINAL_STATUSES; the set a
 *  fresh daemon rehydrates on boot. Kept explicit (not derived) so it can drive
 *  an indexed `status IN (…)` query; a test asserts it stays the complement. */
export const ACTIVE_STATUSES: readonly PipelineStatus[] = ["draft", "running", "halted"];

export interface PipelinePhase {
  def: PhaseDef;
  state: PhaseState;
  /** Human revise notes accumulated across re-runs of THIS phase (newest last).
   *  Threaded into the phase prompt so the agent re-iterates per the feedback
   *  (docs/pipeline-run.md — the Approve/Revise/Reject loop). */
  feedback?: string[];
  /** The phase's most recent run output — kept so a revise re-run can show the
   *  agent its prior attempt (a halt otherwise drops the summary). */
  lastSummary?: string;
}

/** The full, daemon-owned pipeline state — the source of truth persisted per
 *  transition so a halted pipeline survives a daemon restart (§5.2). */
export interface PipelineState {
  id: string;
  name: string;
  spec?: string;
  /** Repo/workdir the phases operate in (worker sessions run here). */
  workdir?: string;
  /** Id of the pack this run was created from (when created via `pack`, not an
   *  explicit `phases` plan). Lets the phase runner resolve the pack's
   *  constitution + each phase's capability role for per-phase governance. */
  packId?: string;
  phases: PipelinePhase[];
  /** index of the active phase. */
  cursor: number;
  /** The bound run-session this pipeline drives. A run is a *conductor over a
   *  live, attached session*: each phase is injected as a streamed turn on this
   *  session (visible + interruptible), not a headless worker. Set at create.
   *  Optional so an explicit-`phases` plan without a session still validates. */
  sessionId?: string;
  /** the pipeline's own durable session (set when wired to a conductor — a
   *  later slice; optional here so the primitive is session-free). */
  conductorSessionId?: string;
  status: PipelineStatus;
  accountId: string;
  projectId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ── Plugin seams (§3a.2) ──────────────────────────────────────────────────

/** A generic, idempotent, drop-in registry — the shape every extension point
 *  shares (phase kinds, gates, skills, packs). Mirrors the ProviderRegistry /
 *  Frontend registration ergonomics. */
export interface Registry<T extends { id: string }> {
  register(item: T): void;
  unregister(id: string): void;
  resolve(id: string): T | undefined;
  list(): T[];
  has(id: string): boolean;
}

export interface PipelineRegistries {
  phases: Registry<PhaseKind>;
  gates: Registry<GatePlugin>;
  skills: Registry<SkillPlugin>;
  packs: Registry<Pack>;
}

/** Context handed to a PhaseKind.run — minimal here (no worker sessions yet). */
export interface PhaseCtx {
  pipeline: PipelineState;
  phase: PhaseDef;
  registries: PipelineRegistries;
}

export type PhaseRunResult =
  | { outcome: "passed"; summary?: string; artifacts?: string[] }
  | { outcome: "halted"; requestId: string; reason: string; questions?: string[] }
  | { outcome: "failed"; reason: string };

/** A phase kind knows how to execute one phase and report its result. (Slice 1
 *  returns a Promise; a streaming `AsyncIterable<PhaseEvent>` can be added
 *  additively when phases drive real backends.) */
export interface PhaseKind {
  id: string;
  run(ctx: PhaseCtx): Promise<PhaseRunResult>;
}

export interface GateCtx {
  pipeline: PipelineState;
  phase: PhaseDef;
}

export interface GateVerdict {
  pass: boolean;
  reason?: string;
  questions?: string[];
}

/** A gate: a pass/fail predicate positioned at phase entry (grounding) or exit
 *  (acceptance) — §5a.3, §5a.5. `at` is advisory metadata used for authoring /
 *  validation; the engine resolves a gate by id wherever a phase references it. */
export interface GatePlugin {
  id: string;
  at: "entry" | "exit";
  evaluate(ctx: GateCtx): Promise<GateVerdict>;
}

export interface SkillResult {
  summary?: string;
  artifacts?: string[];
}

/** A runnable content unit a phase drives — three equal flavors (§3a.2). */
export type SkillPlugin =
  | { id: string; kind: "slash"; command: string }
  | { id: string; kind: "prompt"; template: string }
  | { id: string; kind: "fn"; run: (ctx: PhaseCtx) => Promise<SkillResult> };

/** A named bundle that registers phases/gates/skills and declares a default
 *  phase sequence — enable/disable a whole methodology at once (§3a.2, §7). */
export interface Pack {
  id: string;
  register(r: PipelineRegistries): void;
  pipeline: PhaseDef[];
  /** Capability roles keyed by name, when the pack declares them (manifest
   *  packs — `LoadedPack` narrows this to full `RoleDef`s). Read by model-
   *  binding resolution at create (tier + role-level pin —
   *  docs/role-model-binding.md); absent on code-defined packs. */
  roles?: Record<string, RoleModelSource>;
}
