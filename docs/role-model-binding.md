# Per-Role Model Binding — Design

> Status: **proposal** · Builds on [`pack-loading.md`](./pack-loading.md) and
> [`collaborative-session-design.md`](./collaborative-session-design.md).
> Goal: let an operator decide **which model serves each role** — per machine,
> per run, without editing the pack — through one resolution chain shared by
> pipelines, collaborations, and (eventually) single sessions.

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

## 6. Horizon: one role system (separate design)

`session-manager.ts` today rejects `--collaborate` + `--pack` ("a
collaborative session compiles its own one-goal pack"). The end state this
design points at — but does not implement — is lifting that: a collaboration
that *adopts* an installed pack binds its role-children by name to the
pack's roles, taking envelopes from the role YAML (hard tool fence),
constitution from the pack's ETHOS, and models through the resolution chain
above, with `--role` then carrying only provider/model/count. Free-form
collab roles remain valid without `--pack`. That unification — plus `--model`
on single sessions — deserves its own doc once this lands; §2–§5 are designed
so nothing here has to change for it.

## 7. Non-goals (this iteration)

- **Cost estimation / budgets** — we record per-phase usage (§4); we do not
  predict or cap it here.
- **Mid-run rebinding** — a halted run resumes with its persisted bindings;
  a `pipeline set-role` mutation is a later convenience.
- **Named profiles** (`--profile max`) — config sugar over §2.2; add only if
  the raw map proves unwieldy in practice.
- **Enforcing tier vocabulary** — conventions doc, not schema enum.

## 8. Open decisions

- **D1 — precedence of pack pin vs machine tier map.** Proposed: pack's
  concrete phase pin (rung 3) beats the tier map (rung 4), because an
  explicit pin should mean what it says, and lint pressure moves packs to
  tiers anyway. Alternative: tier map beats pin, protecting operators from
  stale public-pack pins at the cost of making pins advisory. **Recommend:
  pin > map**, with `pack show --resolve` making any stale pin visible.
- **D2 — tier vocabulary.** Proposed: open string + documented conventions
  shared with ai-factory's agent tiers. Alternative: closed enum in schema.
  **Recommend: open** — registries evolve faster than codeoid releases.
- **D3 — where the operator map lives.** Proposed: codeoid config
  (`pipeline.modelTiers` / `modelRoles`). Alternative: reuse ai-factory's
  machine config. **Recommend: codeoid config** — codeoid must not depend on
  a toolkit's file; ai-factory users can mirror values.
- **D4 — scope of the collab unification.** Proposed: horizon only (§6),
  separate design. **Recommend: keep out** — this doc's surface is already
  the full pipeline path; coupling it to session-manager changes doubles the
  blast radius.

## 9. Implementation sketch

Touch set, in dependency order:

1. `src/daemon/pipeline/pack.ts` — `tier` on `roleSchema` (+ carry on
   `RoleDef`); no behavior change.
2. `src/config.ts` — `pipeline.modelTiers` / `pipeline.modelRoles` schema.
3. `src/daemon/pipeline/manager.ts` — `CreatePipelineOpts.roleBindings`;
   resolution in `#resolvePhases` (pure function, unit-testable:
   `resolveBinding(phase, role, bindings, config) → {provider?, model?,
   resolvedFrom}`); persist into phase defs.
4. `src/daemon/pipeline/pack-service.ts` — `--resolve` data for `pack show`.
5. `src/cli.ts` — `--role` on `pipeline run` (reuse `parseRoleSpec`, reject
   counts), `--resolve` on `pack show`; `pipeline status` rendering.
6. Wire types + verb params.
7. Docs: registry conventions (recommended tier set) in ai-factory's
   `packs/CLAUDE.md` — separate PR there.

Tests: resolution precedence table (every rung + `resolvedFrom`), persisted
bindings survive resume with changed config, create-time validation errors,
`parseRoleSpec` reuse incl. count rejection, `pack show --resolve` snapshot.
