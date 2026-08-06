# Per-Role Model Binding — Design

> Status: **proposal — decisions resolved, ready to implement** · Builds on
> [`pack-loading.md`](./pack-loading.md) and
> [`collaborative-session-design.md`](./collaborative-session-design.md).
> Goal: let an operator decide **which model serves each role** — per machine,
> per run, without editing the pack — through one resolution chain shared by
> pipelines, pack-adopted collaborations, and single sessions.

---

## 1. Problem

Model choice currently lives in four disconnected places, three of them in
codeoid:

| Surface | Mechanism | Granularity | Changeable at invocation? |
|---|---|---|---|
| Pack phases | `provider:`/`model:` in `pack.yaml`, baked at `loadPack` | per phase | ❌ — edit + push + re-install |
| Collab sessions | `--role "name:provider[:model][*count]"` (`parseRoleSpec`) | per role-child | ✅ |
| Single sessions | `--provider` only | per session, provider default model | ⚠️ provider only |
| ai-factory agents | `tier:` frontmatter + `aif agents render` (class → model map in config, per-agent overrides) | per agent | via config |

Consequences:

- **`pipeline run` has no model surface at all** — flags are `--goal` and
  `--workdir`; `pipeline.create()` takes no model options; phase defs are
  frozen at load time. Choosing "fable on the adversary phase today" means
  editing the pack, pushing, refreshing the registry cache, re-installing.
- **Concrete model ids in packs rot.** A registry pack pinning
  `claude-opus-4` is stale the day opus-5 ships, and a public pack pinning
  any id is provider-locked. Yet the pack author legitimately knows *what
  kind* of model a role needs ("the refutation round wants the strongest
  reasoning available").
- **Two grammars for the same idea.** Collab role specs already express
  role→backend binding perfectly; pipelines can't use them.

## 2. Model

**A model binding is policy, not methodology.** The pack declares what each
role *is* (envelope — the governance surface) and what it *needs* (a tier —
a semantic capability class). Which concrete model satisfies that need is an
operator decision that varies by machine, budget, and run. Three layers:

### 2.1 Packs declare tiers, not models

Role YAML gains an optional `tier:` — a free-form class string, by the same
convention as ai-factory's agent tiers (REQ-516: "a stable class; a config
section maps class → model alias"):

```yaml
# packs/<id>/roles/adversary.yaml
name: adversary
summary: Adversarial review round — refute, don't summarize.
tier: reasoning-max        # semantic need, NOT a model id
write: false
network: read-only
envelope: [read, grep, glob, bash]
```

The vocabulary is open (validated as a non-empty string ≤64 chars), with a
recommended base set documented in the registry conventions:
ai-factory's five (`explorer`, `implementer`, `orchestrator`, `reviewer`,
`scanner`) plus `reasoning-max` and `mechanical`. An unmapped tier resolves
to the provider default and logs one warning at create — never an error
(packs must stay portable to machines that haven't mapped anything).

Concrete `provider:`/`model:` on a *phase* remain supported (they are part of
the shipped schema), but registry lint guidance steers pack authors to tiers.

### 2.2 Operator config maps tiers → models

One place per machine, in codeoid config (same file as registries/trust —
NOT ai-factory's `~/.claude/aif/config.yml`, which is that toolkit's layer):

```jsonc
"pipeline": {
  "modelTiers": {
    "reasoning-max": { "provider": "claude", "model": "claude-fable-5" },
    "reviewer":      { "provider": "claude", "model": "claude-opus-5" },
    "implementer":   { "provider": "claude", "model": "claude-opus-5" },
    "mechanical":    { "provider": "claude", "model": "claude-sonnet-5" }
  },
  // optional surgical overrides, keyed "<packId>/<roleName>"
  "modelRoles": {
    "yash-dev/navigator": { "provider": "claude", "model": "claude-fable-5" }
  }
}
```

When a new model generation ships, the operator updates this map once and
every installed pack upgrades. This removes the need for pack variants that
differ only in model pins.

### 2.3 Invocation overrides, one grammar everywhere

`pipeline run` gains the exact repeatable `--role` flag collab already has,
reusing `parseRoleSpec` verbatim (minus `*count`, which is meaningless for a
pipeline — rejected with a clear error):

```bash
codeoid pipeline run --pack yash-dev --goal "…" \
  --role adversary:claude:claude-fable-5 \
  --role verifier:claude:claude-sonnet-5
```

## 3. Resolution

Resolved **once, at `pipeline.create`**, per phase, and persisted. Precedence
(first match wins):

1. **CLI `--role`** for the phase's role — the operator's explicit word at
   invocation.
2. **Config `modelRoles["<packId>/<roleName>"]`** — surgical per-pack-role
   override.
3. **Phase-level concrete `provider:`/`model:` pin in `pack.yaml`** — the
   pack author's explicit pin (kept above the tier map so an explicit pin
   means what it says; see Decision D1).
4. **Config `modelTiers[<role.tier>]`** — the machine's class map.
5. **Provider default** — today's behavior, unchanged.

The resolved `{provider, model, resolvedFrom}` is written into each phase's
def in `PipelineState` at create. **Resume and retry use the persisted
binding**, not a re-resolution — a run is deterministic even if config
changes underneath it. (`resolvedFrom` names the precedence rung, for
display and debugging.)

## 4. Surfaces

- **`codeoid pack show <id> --resolve`** — the pre-flight view: each role
  with its tier and the *currently effective* model under this machine's
  config + no CLI overrides. You can see what a run would use before
  committing to it.
- **`codeoid pipeline status <id>`** — each phase row gains its bound
  `provider/model` and, once the phase ran, actual token usage from the
  session record. This is what makes role→model mapping *tunable*: without
  per-phase attribution you cannot know whether the expensive adversary
  round earns its cost.
- **Wire**: `pipeline.run` params gain optional
  `roleBindings: Record<string, {provider: string, model?: string}>`;
  same scope as today's run verb. The CLI compiles `--role` flags into it.

## 5. Validation & failure modes

- Unknown role name in `--role` → create-time error listing the pack's
  declared roles (discoverability beats silence).
- Unknown provider id → create-time error (the provider registry is known).
- Model strings pass through to the provider — codeoid cannot enumerate a
  backend's models, so a bad id fails at the phase's session spawn; the
  phase error message must name the binding and its `resolvedFrom` rung so
  the operator knows which layer to fix.
- `*count` in a pipeline `--role` spec → create-time error ("fan-out is a
  collaboration concept; pipelines run one session per phase").
- `tier:` on a role validates as non-empty string ≤64 chars at `loadPack`;
  everything else about tiers is convention.

## 6. Pack-aware collaboration (in scope)

`session-manager.ts` today rejects `--collaborate` + `--pack` ("a
collaborative session compiles its own one-goal pack"). This design lifts
that restriction: a collaboration may **adopt** an installed pack, at which
point the pack — not the collab machinery — defines what each role is.

```bash
codeoid new mytask --collaborate "add per-provider rate limits" \
  --pack yash-dev \
  --role orchestrator:claude \
  --role implementer:claude \
  --role adversary:claude:claude-fable-5 \
  --role review:claude*2          # ERROR: yash-dev declares no role "review"
```

### 6.1 Binding semantics

- **Role names bind strictly to the pack's declared roles.** An unbound name
  is a create-time error listing the pack's roles (same rule as §5's
  pipeline validation). Mixing free-form roles into a pack-adopted collab is
  not allowed — run a free-form collab (no `--pack`) if that's what you
  want. Strictness is what makes the governance claim below true.
- **Envelopes come from the role YAML.** `roleChildPosture` today
  synthesizes `{envelope: "all", network: "read-only", write: <from spec>}`;
  with a pack it passes through the role's real `write`, `network`,
  `envelope`, and `exceptions`. Read-only roles keep the existing scout
  hardening (LEAF identity carries no write tools); envelope lists are
  enforced at the same `canUseTool` fence that `--pack-role` sessions use —
  Claude-hard, advisory + logged on backends whose tools don't all route
  through the gate (unchanged from today's posture).
- **Constitution composes, not replaces.** The child brief is: pack ETHOS,
  then the collaboration goal, then the roster — the pack states how to
  work, the goal states what on, the roster states with whom. The synthetic
  `compileGoalPack` id gives way to the real pack id in `SessionInfo.
  profile`.
- **The orchestrator rule is unchanged.** A collaboration still requires a
  bound role named `orchestrator`; a pack intended for collab must declare
  one (all three existing packs do). No new flag.
- **Models resolve through §3's chain minus rung 3** (phase pins don't exist
  in a collaboration): CLI `--role` model → `modelRoles["<packId>/<role>"]`
  → `modelTiers[role.tier]` → provider default. `*count` fan-out remains
  valid here (it is rejected only on the pipeline path).
- **Skills/subagents** follow the existing pack-activation rules: the
  orchestrator session gets the pack's skills/subagents exactly as a
  `--pack` session does today; trust gating for skill linking is unchanged
  (it happened at install). No command gates are involved — collaborations
  have no phases — so an untrusted pack can still be adopted; it just
  contributes constitution + roles.

### 6.2 Single sessions

For symmetry, session create gains `--model <id>` beside `--provider`
(today model choice is provider-default-only). With `--pack --pack-role`,
an omitted `--model` resolves through the same chain (minus rung 3 and the
CLI rung). This closes the last surface where a role exists but a model
cannot be chosen.

## 7. Non-goals (this iteration)

- **Cost estimation / budgets** — we record per-phase usage (§4); we do not
  predict or cap it here.
- **Mid-run rebinding** — a halted run resumes with its persisted bindings;
  a `pipeline set-role` mutation is a later convenience.
- **Named profiles** (`--profile max`) — config sugar over §2.2; add only if
  the raw map proves unwieldy in practice.
- **Enforcing tier vocabulary** — conventions doc, not schema enum.
- **Per-role network gating in collabs beyond the pack YAML's declaration**
  — the fence honors what the role declares; finer dynamic gating stays "a
  later phase" as marked in `roleChildPosture`.

## 8. Decisions

Resolved in review (2026-08-06):

- **D1 — precedence: pack pin > machine tier map.** ✅ **Decided as
  proposed.** An explicit pin means what it says; `pack show --resolve`
  makes stale pins visible; lint pressure moves packs to tiers.
- **D2 — tier vocabulary: open strings + shared conventions.** ✅ **Decided
  as proposed.** Registries evolve faster than codeoid releases.
- **D3 — operator map lives in codeoid config.** ✅ **Decided as
  proposed.** codeoid must not depend on a toolkit's file.
- **D4 — collab unification: IN scope.** ✅ **Decided against the original
  proposal** — §6 is part of this design, not a horizon. Sub-decisions made
  there: strict role binding (no free-form mixing under `--pack`),
  orchestrator-by-name rule unchanged, ETHOS→goal→roster constitution
  composition, `*count` valid in collabs only.

## 9. Implementation sketch

Touch set, in dependency order. Slices 1–2 (pipeline path) and slice 3
(collab path) are independently shippable; 3 depends on 1's resolution
function only.

**Slice 1 — resolution + pipeline surface**

1. `src/daemon/pipeline/pack.ts` — `tier` on `roleSchema` (+ carry on
   `RoleDef`); no behavior change.
2. `src/config.ts` — `pipeline.modelTiers` / `pipeline.modelRoles` schema.
3. `src/daemon/pipeline/manager.ts` — `CreatePipelineOpts.roleBindings`;
   resolution as a pure function shared by both paths:
   `resolveBinding(role, {cliBinding?, phasePin?, config}) → {provider?,
   model?, resolvedFrom}`; persist into phase defs.
4. Wire types + verb params (`pipeline.run` gains `roleBindings`).
5. `src/cli.ts` — `--role` on `pipeline run` (reuse `parseRoleSpec`, reject
   counts); `pipeline status` rendering.

**Slice 2 — visibility**

6. `src/daemon/pipeline/pack-service.ts` + `src/cli.ts` — `pack show
   --resolve`.

**Slice 3 — pack-aware collaboration + single sessions**

7. `src/daemon/session-manager.ts` — replace the mutual-exclusivity error
   with pack adoption; strict role-name validation against the pack.
8. `src/daemon/collaboration.ts` — `roleChildPosture` passes through real
   role YAML (write/network/envelope/exceptions); `compileGoalPack` composes
   ETHOS→goal→roster under the real pack id; model resolution via
   `resolveBinding`.
9. `src/cli.ts` — allow `--collaborate --pack`; `--model` on session create;
   `--pack-role` model resolution.

**Follow-up PR (ai-factory)** — registry conventions: recommended tier set
in `packs/CLAUDE.md`; add `tier:` to the shipped packs' roles.

Tests: resolution precedence table (every rung + `resolvedFrom`), persisted
bindings survive resume with changed config, create-time validation errors
(unknown role on both paths, count rejection on pipeline path only),
pack-adopted collab child posture (envelope/write/network from YAML;
constitution composition order), free-form collab unchanged without
`--pack`, `--model` on single sessions, `pack show --resolve` snapshot.
