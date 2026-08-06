/**
 * PipelineManager — owns pipeline lifecycle over a PipelineStore: create, look
 * up, advance, answer (halt→resume), abort, and rehydrate non-terminal pipelines
 * on construction so a pipeline halted at phase N comes back halted at phase N
 * after a daemon restart (§5.2).
 *
 * All mutating operations for a given pipeline are serialized through a per-id
 * promise chain (`advance`/`answer`/`abort`), so an op awaiting a real backend
 * turn can't interleave with another and clobber persisted state (lost update).
 * Returned states and `get()` hand out clones so a caller can't mutate the cache.
 */

import { randomUUID } from "node:crypto";
// Provider-aware model validation for resolved bindings — same house policy as
// explicit --model on session create (docs/role-model-binding.md §5). No
// Session dependency: models.ts is a pure catalog module.
import { resolveModelIdForProvider } from "../models.js";
import { type ModelBinding, type ModelBindingConfig, resolveBinding } from "./binding";
import { registerBuiltins } from "./builtin";
import { PipelineEngine } from "./engine";
import type { Pack, PhaseDef, PipelineRegistries, PipelineState } from "./interface";
import { isTerminal } from "./interface";
import { createRegistries } from "./registry";
import type { PhaseRunner } from "./runner";
import { makeSkillPhaseKind } from "./skill-kind";
import type { PipelineStore } from "./store";

/** Max pipelines re-driven concurrently on boot (each may spawn a worker turn). */
const RESUME_CONCURRENCY = 4;

export interface CreatePipelineOpts {
  name: string;
  /** Explicit phase plan, OR provide `pack` to use an installed pack's pipeline. */
  phases?: PhaseDef[];
  /** Id of an installed pack (via installPack) whose pipeline this run uses. */
  pack?: string;
  /** The bound run-session the phases are driven on (created by the daemon
   *  before create; the run injects each phase as a turn on this session). */
  sessionId?: string;
  accountId: string;
  projectId: string;
  createdBy: string;
  spec?: string;
  workdir?: string;
  /** Invocation-time role→model bindings (CLI `--role` / wire `roleBindings`),
   *  keyed by role name — the highest-precedence rung of the model-binding
   *  chain (docs/role-model-binding.md §3). Keys must name roles the plan
   *  declares; an unknown name is a create-time error listing the declared
   *  roles (discoverability beats silence — §5). */
  roleBindings?: Record<string, ModelBinding>;
  /** The operator's tier/role model maps (config `pipeline.modelTiers` /
   *  `pipeline.modelRoles`), read ONCE here at create. The resolved binding is
   *  persisted per phase, so resume/retry replay the persisted state and a run
   *  stays deterministic even if config changes underneath it. */
  modelConfig?: ModelBindingConfig;
  /** The bound run-session's backend id. A run drives ONE session on one
   *  provider, so a resolved binding naming a DIFFERENT provider cannot apply —
   *  it is skipped here at create (with a warning naming the rung) and never
   *  persisted as effective (docs/role-model-binding.md §3). Absent = no
   *  cross-provider filtering (pure unit tests without a session). */
  sessionProvider?: string;
  /** Sink for create-time binding warnings (skipped cross-provider bindings,
   *  invalid model ids, unmapped tiers). Defaults to console.warn; the daemon
   *  passes a collector so the creating client sees them too. */
  warn?: (msg: string) => void;
}

export interface PipelineManagerOptions {
  /** Override the plugin registries (tests / custom packs). */
  registries?: PipelineRegistries;
  /** Backend seam for prompt/slash skills — enables the "skill" phase kind to
   *  drive a real session turn. Omit for pure `noop`/`fn`-skill pipelines. */
  runner?: PhaseRunner;
}

export class PipelineManager {
  #store: PipelineStore;
  #registries: PipelineRegistries;
  #engine: PipelineEngine;
  #cache = new Map<string, PipelineState>();
  /** Per-pipeline mutation serialization (id → tail of its op chain). */
  #chains = new Map<string, Promise<unknown>>();

  constructor(store: PipelineStore, options: PipelineManagerOptions = {}) {
    this.#store = store;
    this.#registries = options.registries ?? defaultRegistries(options.runner);
    this.#engine = new PipelineEngine(this.#registries);
    this.resume();
  }

  get registries(): PipelineRegistries {
    return this.#registries;
  }

  /** Register a pack's skills + gates and index it by id, so `create({ pack })`
   *  can resolve its pipeline. Idempotent (registries are last-wins). */
  installPack(pack: Pack): void {
    pack.register(this.#registries);
    this.#registries.packs.register(pack);
  }

  /** Create a draft pipeline (all phases pending) and persist it. Supply either
   *  `phases` or an installed `pack` id. Throws if a phase references a
   *  kind/gate/skill that isn't registered, a `skill` phase has no skill id, or
   *  two phases share an id (fail fast). */
  create(opts: CreatePipelineOpts): PipelineState {
    const { phases: plan, pack } = this.#resolvePhases(opts);
    const phases = this.#bindModels(plan, pack, opts);
    this.#validate(phases);
    const ts = Date.now();
    const state: PipelineState = {
      id: randomUUID(),
      name: opts.name,
      spec: opts.spec,
      workdir: opts.workdir,
      packId: opts.pack,
      sessionId: opts.sessionId,
      phases: phases.map((def) => ({ def, state: { status: "pending" } })),
      cursor: 0,
      status: "draft",
      accountId: opts.accountId,
      projectId: opts.projectId,
      createdBy: opts.createdBy,
      createdAt: ts,
      updatedAt: ts,
    };
    this.#persist(state);
    return cloneState(state);
  }

  /** Look up a pipeline; returns a clone so the caller can't mutate the cache. */
  get(id: string): PipelineState | undefined {
    const s = this.#cache.get(id) ?? this.#store.get(id);
    return s ? cloneState(s) : undefined;
  }

  list(accountId: string, projectId: string): PipelineState[] {
    return this.#store.listByTenant(accountId, projectId);
  }

  /** Drive the pipeline until it is terminal or halted, persisting each step. */
  advance(id: string): Promise<PipelineState> {
    return this.#serialize(id, async () => cloneState(await this.#advanceInner(id)));
  }

  /**
   * Resolve a halted phase with a human decision, then resume the pipeline.
   * `approved` marks the phase passed (its `value` becomes the summary) and
   * advances; otherwise the phase — and the pipeline — fail. Approving is a
   * deliberate human **override** (even of a deterministic gate); use
   * `onFail:"abort"` for failures that must be final (§4.1, §5.3).
   */
  answer(id: string, requestId: string, opts: { approved: boolean; value?: string }): Promise<PipelineState> {
    return this.#serialize(id, async () => cloneState(await this.#answerInner(id, requestId, opts)));
  }

  /**
   * Revise a halted phase: record the human's `feedback`, re-run the SAME phase
   * with it (and the phase's prior output) threaded into the phase prompt, then
   * drive to the next halt/terminal. The Approve / Revise / Reject loop
   * (docs/pipeline-run.md) — call it repeatedly until you approve. Serialized
   * like answer/advance.
   */
  revise(id: string, requestId: string, feedback: string): Promise<PipelineState> {
    return this.#serialize(id, async () => cloneState(await this.#reviseInner(id, requestId, feedback)));
  }

  /** Mark a pipeline abandoned (terminal). No-op if unknown or already terminal;
   *  the active phase (if unresolved) is failed so the record isn't left mid-run.
   *  Serialized like advance/answer so it can't be clobbered by an in-flight op. */
  abort(id: string): Promise<PipelineState | undefined> {
    return this.#serialize(id, async () => {
      const r = await this.#abortInner(id);
      return r ? cloneState(r) : undefined;
    });
  }

  /** Rehydrate non-terminal pipelines from the store into the in-memory cache.
   *  Returns the number resumed. Called once on construction. */
  resume(): number {
    const active = this.#store.listActive();
    for (const s of active) this.#cache.set(s.id, s);
    return active.length;
  }

  /**
   * Re-drive pipelines that were interrupted mid-run at a restart (status
   * `draft`/`running`). Halted pipelines are intentionally left parked for a
   * human answer. Call once after construction on daemon boot. Note: a phase
   * interrupted while executing re-runs (at-least-once — same as the dispatcher).
   */
  async driveResumable(): Promise<PipelineState[]> {
    const ids = [...this.#cache.values()]
      .filter((s) => s.status === "draft" || s.status === "running")
      .map((s) => s.id);
    // Bound concurrency: each advance may spawn a real worker turn, so a restart
    // with many interrupted pipelines must not launch them all at once (a
    // boot-time resource storm). Drive in fixed-size batches, and isolate each
    // advance — one pipeline that throws must not abort the rest of the resume.
    const results: PipelineState[] = [];
    for (let i = 0; i < ids.length; i += RESUME_CONCURRENCY) {
      const batch = ids.slice(i, i + RESUME_CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (id) => {
          try {
            return await this.advance(id);
          } catch (err) {
            console.error(`[pipeline] failed to advance pipeline ${id} during resume: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        }),
      );
      results.push(...settled.filter((r): r is PipelineState => r !== null));
    }
    return results;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Persist + keep the cache coherent: active pipelines are cached; terminal
   *  ones are evicted (still readable via the store) so the cache stays bounded. */
  #persist(s: PipelineState): void {
    this.#store.save(s);
    if (isTerminal(s.status)) this.#cache.delete(s.id);
    else this.#cache.set(s.id, s);
  }

  async #advanceInner(id: string): Promise<PipelineState> {
    const start = this.get(id);
    if (!start) throw new Error(`pipeline "${id}" not found`);
    return this.#engine.run(start, (s) => this.#persist(s));
  }

  async #answerInner(
    id: string,
    requestId: string,
    opts: { approved: boolean; value?: string },
  ): Promise<PipelineState> {
    const s = this.get(id); // a clone — safe to mutate
    if (!s) throw new Error(`pipeline "${id}" not found`);
    if (s.status !== "halted") throw new Error(`pipeline "${id}" is not halted (status: ${s.status})`);
    const current = s.phases[s.cursor];
    if (!current || current.state.status !== "halted") {
      throw new Error(`pipeline "${id}" has no halted phase at the cursor`);
    }
    if (current.state.requestId !== requestId) {
      throw new Error(`stale requestId "${requestId}" for pipeline "${id}"`);
    }

    if (opts.approved) {
      // Record the phase's actual output as its summary (its lastSummary), so
      // the run preserves what the phase produced; the human's note augments it.
      current.state = { status: "passed", summary: opts.value ?? current.lastSummary ?? "approved" };
      s.cursor += 1;
      s.status = s.cursor >= s.phases.length ? "done" : "running";
    } else {
      current.state = { status: "failed", reason: opts.value ?? "rejected by human", attempts: 1 };
      s.status = "failed";
    }
    s.updatedAt = Date.now();
    this.#persist(s);

    // Approving a non-final phase resumes the run to the next halt / terminal.
    // Call the inner advance directly — we already hold this id's chain slot.
    return s.status === "running" ? this.#advanceInner(id) : s;
  }

  async #reviseInner(id: string, requestId: string, feedback: string): Promise<PipelineState> {
    const s = this.get(id); // a clone — safe to mutate
    if (!s) throw new Error(`pipeline "${id}" not found`);
    if (s.status !== "halted") throw new Error(`pipeline "${id}" is not halted (status: ${s.status})`);
    const current = s.phases[s.cursor];
    if (!current || current.state.status !== "halted") {
      throw new Error(`pipeline "${id}" has no halted phase at the cursor`);
    }
    if (current.state.requestId !== requestId) {
      throw new Error(`stale requestId "${requestId}" for pipeline "${id}"`);
    }
    const note = feedback.trim();
    if (!note) throw new Error("revise requires non-empty feedback");

    // Record the human's note and re-run THIS phase with it. attempts resets to
    // 0 — a human revise is a fresh, deliberate attempt, not counted against the
    // machine `onFail: retry` budget. The skill kind reads phase.feedback +
    // phase.lastSummary from the pipeline state to build the revised prompt.
    current.feedback = [...(current.feedback ?? []), note];
    current.state = { status: "running", startedAt: Date.now(), attempts: 0 };
    s.status = "running";
    s.updatedAt = Date.now();
    this.#persist(s);

    // Re-drive to the next halt / terminal (we already hold this id's chain slot).
    return this.#advanceInner(id);
  }

  async #abortInner(id: string): Promise<PipelineState | undefined> {
    const s = this.get(id); // a clone — safe to mutate
    if (!s) return undefined;
    if (isTerminal(s.status)) return s;
    const cur = s.phases[s.cursor];
    if (cur && cur.state.status !== "passed" && cur.state.status !== "failed") {
      cur.state = { status: "failed", reason: "pipeline aborted", attempts: 0 };
    }
    s.status = "abandoned";
    s.updatedAt = Date.now();
    this.#persist(s);
    return s;
  }

  /** Resolve the phase plan from either explicit `phases` or an installed pack.
   *  Returns the pack too (when used) so model binding can read its roles. */
  #resolvePhases(opts: CreatePipelineOpts): { phases: PhaseDef[]; pack?: Pack } {
    if (opts.pack && opts.phases) {
      throw new Error("create: provide either `phases` or `pack`, not both");
    }
    if (opts.pack) {
      const pack = this.#registries.packs.resolve(opts.pack);
      if (!pack) throw new Error(`create: unknown pack "${opts.pack}" — install it first (installPack)`);
      return { phases: pack.pipeline, pack };
    }
    if (opts.phases) return { phases: opts.phases };
    throw new Error("create: provide `phases` or `pack`");
  }

  /**
   * Resolve each phase's model binding ONCE, here at create, and persist it on
   * the phase def (docs/role-model-binding.md §3) — resume and retry then read
   * the persisted binding, never re-resolve, so a run is deterministic even if
   * config changes underneath it. A bound def is a CLONE: a pack's `pipeline`
   * array is shared by every run created from it, so annotating the originals
   * would leak one run's bindings into the next run (and into the registry).
   */
  #bindModels(phases: PhaseDef[], pack: Pack | undefined, opts: CreatePipelineOpts): PhaseDef[] {
    const warn = opts.warn ?? ((m: string) => console.warn(`[pipeline] ${m}`));
    // Role names match case-insensitively — the SAME rule adoptPackRoles applies
    // on the collab path (one grammar, one rule — docs/role-model-binding.md §5).
    const bindings = new Map<string, ModelBinding>();
    for (const [name, b] of Object.entries(opts.roleBindings ?? {})) bindings.set(name.toLowerCase(), b);
    // Fail fast on a binding for a role the plan doesn't declare — a typo'd
    // `--role adversry:…` must not silently no-op (§5). Pack path validates
    // against the pack's declared roles; an explicit plan against the role
    // names its phases reference.
    const declared = pack?.roles
      ? Object.keys(pack.roles)
      : [...new Set(phases.map((p) => p.role).filter((r): r is string => r !== undefined))];
    const declaredKeys = new Set(declared.map((n) => n.toLowerCase()));
    for (const name of Object.keys(opts.roleBindings ?? {})) {
      if (!declaredKeys.has(name.toLowerCase())) {
        const have = declared.length > 0 ? declared.join(", ") : "none";
        const where = pack ? `pack "${pack.id}" declares` : "the phase plan declares";
        throw new Error(`create: unknown role "${name}" in role bindings — ${where}: ${have}`);
      }
    }
    // An unmapped tier is NEVER an error (packs must stay portable to machines
    // that haven't mapped anything) — one warning per tier, here at create.
    const warnedTiers = new Set<string>();
    // A skipped binding must not be RENDERED as one: strip any pin fields off
    // the def so status/CLI never display a provider/model that won't apply.
    const unbound = (def: PhaseDef): PhaseDef => {
      const clean = { ...def };
      delete clean.provider;
      delete clean.model;
      delete clean.resolvedFrom;
      return clean;
    };
    return phases.map((def) => {
      const role = def.role !== undefined ? pack?.roles?.[def.role] : undefined;
      const hasPin = def.provider !== undefined || def.model !== undefined;
      const resolved = resolveBinding({
        packId: pack?.id,
        roleName: def.role,
        role,
        cliBinding: def.role !== undefined ? bindings.get(def.role.toLowerCase()) : undefined,
        phasePin: hasPin ? { provider: def.provider, model: def.model } : undefined,
        config: opts.modelConfig,
      });
      if (resolved.resolvedFrom === "default") {
        if (role?.tier !== undefined && !warnedTiers.has(role.tier)) {
          warnedTiers.add(role.tier);
          warn(
            `role "${def.role}" declares tier "${role.tier}" but no modelTiers mapping exists — using the provider default`,
          );
        }
        // No binding — leave the def untouched (absent resolvedFrom = default),
        // exactly today's behavior for role-less / unbound phases.
        return def;
      }
      // A bound run-session cannot swap backends mid-run: a run drives ONE
      // session on one provider (docs/role-model-binding.md §3). Same rule as
      // collab adoption — the session's provider is authoritative, so a binding
      // naming a different backend is SKIPPED here (never persisted as
      // effective), with a warning naming the rung to fix. It does not fall
      // through to a lower rung: the winning rung is the operator's intent.
      if (
        resolved.provider !== undefined &&
        opts.sessionProvider !== undefined &&
        resolved.provider !== opts.sessionProvider
      ) {
        warn(
          `phase "${def.id}"${def.role ? ` (role "${def.role}")` : ""}: the ${resolved.resolvedFrom} binding targets provider "${resolved.provider}" but this run's session is bound to "${opts.sessionProvider}" — a run drives one session on one backend; skipping the binding (using the session's model)`,
        );
        return unbound(def);
      }
      // Provider-matching (or provider-absent) bindings apply their MODEL —
      // but only if it validates for the session's backend. A vendor-shaped id
      // must never silently transfer (a model-only pin written for claude is
      // meaningless on another backend); skip with a warning, don't hard-fail
      // a create for a model the operator never typed (§5).
      if (resolved.model !== undefined) {
        const target = resolved.provider ?? opts.sessionProvider;
        if (resolveModelIdForProvider(resolved.model, target) === null) {
          warn(
            `phase "${def.id}"${def.role ? ` (role "${def.role}")` : ""}: the ${resolved.resolvedFrom} binding's model "${resolved.model}" is not valid for provider "${target ?? "claude"}" — skipping the binding (using the session's model)`,
          );
          return unbound(def);
        }
      }
      // The winning rung supplies the WHOLE binding: a provider-only binding
      // means "that provider's default model", so a lower rung's model must not
      // survive underneath it (delete, don't merge).
      const bound: PhaseDef = { ...def, resolvedFrom: resolved.resolvedFrom };
      if (resolved.provider !== undefined) bound.provider = resolved.provider;
      else delete bound.provider;
      if (resolved.model !== undefined) bound.model = resolved.model;
      else delete bound.model;
      return bound;
    });
  }

  #validate(phases: PhaseDef[]): void {
    if (phases.length === 0) throw new Error("pipeline must declare at least one phase");
    const seen = new Set<string>();
    for (const p of phases) {
      if (seen.has(p.id)) throw new Error(`duplicate phase id "${p.id}"`);
      seen.add(p.id);
      if (!this.#registries.phases.has(p.kind)) {
        throw new Error(`phase "${p.id}": unknown kind "${p.kind}"`);
      }
      if (p.gate && !this.#registries.gates.has(p.gate)) {
        throw new Error(`phase "${p.id}": unknown gate "${p.gate}"`);
      }
      if (p.entryGate && !this.#registries.gates.has(p.entryGate)) {
        throw new Error(`phase "${p.id}": unknown entry gate "${p.entryGate}"`);
      }
      if (p.kind === "skill") {
        if (!p.skill) throw new Error(`phase "${p.id}": kind "skill" requires a skill id`);
        if (!this.#registries.skills.has(p.skill)) {
          throw new Error(`phase "${p.id}": unknown skill "${p.skill}"`);
        }
      }
    }
  }

  /** Serialize mutating ops per pipeline id so awaited work can't interleave and
   *  clobber persisted state. The chain swallows errors so one failed op doesn't
   *  break the next; entries are dropped once the tail settles. */
  #serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.#chains.get(id) ?? Promise.resolve()).catch(() => undefined);
    const result = prev.then(() => fn());
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(id, settled);
    void settled.then(() => {
      if (this.#chains.get(id) === settled) this.#chains.delete(id);
    });
    return result;
  }
}

function defaultRegistries(runner?: PhaseRunner): PipelineRegistries {
  const r = createRegistries();
  registerBuiltins(r);
  // The "skill" phase kind drives prompt/slash skills through the runner (fn
  // skills run natively); registered here so a default manager can run them.
  r.phases.register(makeSkillPhaseKind(runner));
  return r;
}

const cloneState = (s: PipelineState): PipelineState => JSON.parse(JSON.stringify(s)) as PipelineState;
