/**
 * Per-role model binding resolution (docs/role-model-binding.md).
 *
 * A model binding is POLICY, not methodology: the pack declares what a role
 * *is* (the capability envelope) and what it *needs* (a `tier` — a semantic
 * class like "reasoning-max"); which concrete model satisfies that need is an
 * operator decision that varies by machine, budget, and run. This module is
 * the ONE resolution chain shared by every surface — pipeline create
 * (manager.ts), the pre-flight view (`pack show --resolve`), and pack-adopted
 * collaborations (slice 3) — so no caller can drift from another. Pure
 * data-in/data-out: no config IO, no registries, unit-testable per rung.
 */

// ── Shapes ────────────────────────────────────────────────────────────────

/** One concrete backend choice: which provider, and optionally which model on
 *  it (absent = that backend's default model). */
export interface ModelBinding {
  provider: string;
  model?: string;
}

/** The operator's machine-level maps (config `pipeline.modelTiers` /
 *  `pipeline.modelRoles` — docs/role-model-binding.md §2.2). When a new model
 *  generation ships, one edit to `modelTiers` upgrades every installed pack. */
export interface ModelBindingConfig {
  /** tier ("reasoning-max") → model. The machine's class map. */
  modelTiers?: Record<string, ModelBinding>;
  /** "<packId>/<roleName>" → model. Surgical per-pack-role override. */
  modelRoles?: Record<string, ModelBinding>;
}

/** The slice of a pack role the resolver reads — `RoleDef` (pack.ts) satisfies
 *  it structurally, so this module needs no schema import. */
export interface RoleModelSource {
  /** Semantic capability class, mapped via config `modelTiers` (§2.1). */
  tier?: string;
  /** Role-level concrete pin (the role→backend binding added for the collab
   *  fleet path) — sits between the phase pin and the tier map. */
  provider?: string;
  model?: string;
}

/**
 * Which precedence rung produced a binding (§3) — persisted on the phase def
 * and surfaced in `pipeline status` / `pack show --resolve`, so when a bad
 * model id fails at session spawn the operator knows which LAYER to fix.
 */
export type ResolvedFrom =
  | "cli" // invocation `--role` / wire roleBindings
  | "config-role" // config modelRoles["<packId>/<roleName>"]
  | "phase-pin" // phase-level provider:/model: in pack.yaml
  | "role-pin" // role-level provider:/model: in the role YAML
  | "config-tier" // config modelTiers[role.tier]
  | "default"; // no binding — the provider's default (today's behavior)

export interface ResolvedBinding {
  provider?: string;
  model?: string;
  resolvedFrom: ResolvedFrom;
}

export interface ResolveBindingInput {
  /** Pack the role belongs to — keys the `modelRoles` surgical override. */
  packId?: string;
  roleName?: string;
  /** The pack's role definition for `roleName` (tier + optional role pin). */
  role?: RoleModelSource;
  /** The operator's explicit word at invocation (`--role name:provider[:model]`). */
  cliBinding?: ModelBinding;
  /** The pack author's phase-level `provider:`/`model:` pin from pack.yaml. */
  phasePin?: { provider?: string; model?: string };
  /** The operator's machine maps (config `pipeline`). */
  config?: ModelBindingConfig;
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Resolve one role/phase's model binding. First match wins, and the WHOLE
 * `{provider, model}` comes from that rung — a higher rung's provider-only
 * binding does not inherit a lower rung's model (an explicit choice means what
 * it says; a missing model is "that provider's default", not "whatever a pin
 * used to say"). Precedence (docs/role-model-binding.md §3):
 *
 *   1. CLI `--role`             → "cli"
 *   2. config modelRoles        → "config-role"
 *   3. phase-level pack pin     → "phase-pin"
 *   4. role-level role-YAML pin → "role-pin"
 *   5. config modelTiers[tier]  → "config-tier"
 *   6. provider default         → "default" (no provider/model — unchanged)
 *
 * An unmapped tier deliberately falls to "default", never errors — packs must
 * stay portable to machines that haven't mapped anything (the caller may warn).
 */
export function resolveBinding(input: ResolveBindingInput): ResolvedBinding {
  const { packId, roleName, role, cliBinding, phasePin, config } = input;

  if (cliBinding) {
    return { provider: cliBinding.provider, model: cliBinding.model, resolvedFrom: "cli" };
  }
  if (packId !== undefined && roleName !== undefined) {
    const surgical = config?.modelRoles?.[`${packId}/${roleName}`];
    if (surgical) {
      return { provider: surgical.provider, model: surgical.model, resolvedFrom: "config-role" };
    }
  }
  // A pin counts if EITHER field is set: a model-only pin ("this provider's
  // default backend, but this model") is still the author's explicit word.
  if (phasePin && (phasePin.provider !== undefined || phasePin.model !== undefined)) {
    return { provider: phasePin.provider, model: phasePin.model, resolvedFrom: "phase-pin" };
  }
  if (role && (role.provider !== undefined || role.model !== undefined)) {
    return { provider: role.provider, model: role.model, resolvedFrom: "role-pin" };
  }
  if (role?.tier !== undefined) {
    const tiered = config?.modelTiers?.[role.tier];
    if (tiered) {
      return { provider: tiered.provider, model: tiered.model, resolvedFrom: "config-tier" };
    }
  }
  return { resolvedFrom: "default" };
}

// ── CLI spec compilation ──────────────────────────────────────────────────

/** The parsed shape of one `--role` spec (structural subset of the collab
 *  `CollaborationRole`, so `parseRoleSpec` output feeds straight in). */
export interface ParsedRoleSpec {
  name: string;
  providerId: string;
  model?: string;
  count?: number;
}

/**
 * Compile parsed `--role` specs into the pipeline `roleBindings` map. The
 * grammar is the collab one (`parseRoleSpec`) minus `*count`: a pipeline runs
 * ONE session per phase, so a fan-out suffix is a category error rejected here
 * with a create-time message rather than silently ignored (§5).
 */
export function roleBindingsFromSpecs(specs: ParsedRoleSpec[]): Record<string, ModelBinding> {
  const out: Record<string, ModelBinding> = {};
  for (const s of specs) {
    if (s.count !== undefined) {
      throw new Error(
        `--role "${s.name}": fan-out is a collaboration concept; pipelines run one session per phase`,
      );
    }
    if (out[s.name]) {
      throw new Error(`--role "${s.name}" bound more than once — each role takes one binding`);
    }
    out[s.name] = { provider: s.providerId, ...(s.model !== undefined ? { model: s.model } : {}) };
  }
  return out;
}
