# Codeoid Collaborative Sessions — Design Proposal

> Status: **DRAFT — grilled 2026-07-25** · Author: design session 2026-07-25
> Goal: let a user open a session in which **multiple models from different
> backends work one goal in coordinated, specialized roles** — an orchestrator
> that plans and routes, a searcher, a reasoner, an architect, and a panel of
> reviewers — as a **native, identity-governed control**, not a bolted-on script.

---

## 1. Goal & non-goals

**Goal.**
At session-create time the user toggles **Collaborative** and binds a model+backend to each role (orchestrator, internet-search, reasoning, architecture, review — review may be many).
When the user states a goal, the orchestrator decomposes it, delegates to the role-agents on their assigned backends, they coordinate through shared structured state, and the work converges — with the user watching, interrupting, and approving throughout.

**Non-goals.**
- Not a rewrite.
  This is a specialization of three primitives codeoid already has — the **multi-provider meta-harness** (`docs/multi-provider-meta-harness.md`), the **conductor/fleet dispatch** subsystem (`docs/conductor-design.md`, `src/daemon/dispatch.ts`), and the **pack/pipeline SDLC engine** (`docs/sdlc-pipeline.md`, `src/daemon/pipeline/`).
- Not a second orchestration system.
  Collaborative sessions **unify into packs/pipeline** (§8), not alongside them — one engine, two topologies (sequential phases vs. parallel role fan-out).
- Not identity-optional.
  Every role-agent is a ZeroID identity delegated from the orchestrator, which is delegated from the owner — one verifiable tree, one revocation root (§6).
- Not a message-relay orchestrator.
  We deliberately reject the "orchestrator context is the only shared medium" model (the ceiling every current open-source attempt hits) in favor of a daemon-owned blackboard (§4).

---

## 2. Decisions locked (from the design discussion)

- **Substrate = multi-session fleet, not single-session role-swap.**
  Each role runs as its **own** `Session` with its own `(provider, model)`, its own store row, and its own delegated ZeroID identity.
  The rejected alternative — one bound session whose backend is swapped per role via `switchProvider` — is lossy (it resets the model and mints a fresh backing id, `session.ts` `switchProvider`), is inherently sequential, assumes one `provider` column per session (`store.ts` `sessions.provider`), and cannot run reviewers in parallel or keep them independent.
- **Unify into packs/pipeline.**
  A collaborative session **is a pack**: roles gain a `(provider, model, policy)` binding, phases gain enforced `reads`/`writes`, and a new `panel` phase kind fans a phase out across backends.
  A pure collaborative session is a degenerate one-goal pack; an SDLC pack gets a cross-backend `panel` review phase for free.
- **Coordination = orchestrator-LLM-driven dispatch over a daemon-owned typed-artifact blackboard.**
  The orchestrator plans dynamically and delegates via tool calls (choreography lives in editable skill prose, not compiled control flow), but role-agents hand off through **structured artifacts in the daemon**, not through the orchestrator's context (§4).
  **v1 is lean**: orchestrator-driven dispatch (the existing `dispatch.ts` queue) + the blackboard as a typed-handoff store + one parallel primitive (the review panel).
  The full "scheduler over a dependency graph" (auto-firing a role the moment its inputs exist) is the **end-state (P4)**, not v1 — in v1 the reserved `reads`/`writes` are enforced *access scoping*, and become scheduling *edges* in P4 (§8).
- **Review = a breadth panel.**
  "All models take a stab at review" means N different-backend reviewers, each reading the same input artifact, each writing independent findings, merged by a synthesis step — with an optional cross-critique (debate) round before synthesis (§7).

**Grill outcomes (2026-07-25) — additional decisions locked:**

- **Orchestrator = Claude for v1; tools built as a *mountable* MCP server.**
  The fleet + blackboard tool surface is built as a mountable MCP server (stdio/registry) rather than the in-process Claude-SDK object (`createSdkMcpServer`, `src/daemon/fleet.ts`), so letting gemini/openai/codex orchestrate later (they already parse `mcp__*`) is a mount-config change, not a rewrite.
  Worker roles run on any backend in v1; any-backend orchestrator is tracked in **#245**.
- **Blackboard schema = fixed-core + scoped `extra`.**
  A first-class typed set (`spec`, `research`, `adr`, `task-list`, `diff`, `findings`) — versioned, UI-rendered, per-role read/write enforced — plus an `extra/<key>` namespace for ad-hoc artifacts that is *still* per-role scoped (no "unenforced field is false security" hole).
- **Role-child lifetime = per-goal; cross-goal continuity via the blackboard.**
  A role-child lives for one goal/run (survives the implement↔review fix-loop, keeps its worktree/branch), and is torn down at goal completion.
  Continuity across goals rides durable blackboard artifacts, not live children — preserving the conductor's low-credentials-at-rest discipline.
- **Cost/concurrency guards ship in v1 (lightweight).**
  A per-session **live-worker cap** (closing omnigent's cross-turn concurrency gap), a **per-collaboration cost roll-up surfaced at the R3 approve-time**, and reuse of the existing per-child tool budget + failure-limit auto-block.
  Hard token ceilings and Cedar/Shield governance stay P6.
- **Create UX = a first-class Collaborative toggle that compiles to an ephemeral one-goal pack.**
  The create dialog leads with a Collaborative toggle + role→backend pickers and compiles to a one-goal pack + orchestrator under the hood; pack vocabulary stays hidden for this path.
  The `/pipeline` pack-selector remains the surface for pre-authored SDLC packs.
- **Synthesis + independence defaults.**
  The orchestrator merges the panel's findings by default (the human always sees disagreement; a dedicated *judge* role is a pack option).
  Reviewers read `diff`+`spec` only — never implementer reasoning — enforced at the `canUseTool` fence.

---

## 3. The role model — a role is data, not an enum

A role is a **`{ backend, model, contract, capabilityPolicy }`** binding, selected per delegation by a **`purpose`** tag.
The five named roles (orchestrator / search / reasoning / architecture / review) are a **default profile**, stored as a list so that adding a role — "security-reviewer", "test-author", "docs-writer" — is a config change, never a code change.

This is the single most important lesson from the omnigent prior art (§9): do **not** hard-code the role taxonomy.
One worker spec can serve several purposes (implement / review / explore), chosen per dispatch — so the number of distinct backend processes is `O(distinct backends configured)`, not `O(roles)`.

The precedent already exists in codeoid.
`ConductorSchema { provider, model }` (`src/config.ts`) is exactly a role→backend binding for a single privileged role; a collaborative session generalizes it to a list.
Roles as **capability envelopes** also already exist in the pack system — `roleSchema { name, write, network, envelope, exceptions }` (`src/daemon/pipeline/pack.ts`) — but they carry **no** model or provider today.
The one addition to the schema is an optional `(provider, model)` on a role, plus the enforcement that makes a role's `envelope` real (§6).

| Default role | purpose | typical backend fit | capability policy |
| --- | --- | --- | --- |
| orchestrator | plan, delegate, schedule, synthesize | strongest reasoning + tool-use (Claude today, for fleet MCP) | no file/exec write; `session:dispatch` only |
| search | web research → `research` artifact | any backend with `WebSearch`/`WebFetch` | read + web; no repo write |
| reasoning | bulk logical work, implementation → `diff` | strong coder | write (in a worktree), execute |
| architecture | decompose, decide structure → `adr` | strong long-context planner | read + write `adr`; no repo write |
| review (×N) | independent critique → `findings` | **different** backend from the implementer | read `diff`+`spec`, **no write** (enforced) |

---

## 4. The core principle — a daemon-owned blackboard, not a message relay

**Why the obvious design has a ceiling.**
The default multi-agent pattern (and every open-source attempt surveyed, including omnigent) makes the orchestrator's own conversation the only shared medium: every handoff is the orchestrator re-serializing text into a worker's prompt, and every result flows back through the orchestrator.
That makes the coordinator the bottleneck — its context bloats with each round, handoffs are lossy text, and parallelism is capped by the orchestrator's serial turn.

**Codeoid can do structurally better, because it owns three things a message-relay harness does not:**
1. **Canonical history** (`src/daemon/providers/canonical.ts`) — a provider-neutral `CanonicalTurn[]` with full structured tool inputs *and* outputs, convertible into any backend's native format.
   Handoffs can be structured, not re-narrated prose.
2. **A daemon-owned durable memory + retrieval engine** (`src/daemon/memory/engine.ts`) with hybrid (vector + FTS + recency + path-overlap) recall and saliency compression.
   Shared state can live in the daemon, addressable by query, not held in a chat.
3. **A ZeroID identity per agent** — so every contribution to shared state is attributable, scope-attenuated, and auditable.

**The model: a goal-scoped, typed-artifact blackboard; the orchestrator is a scheduler over a dependency graph, not a relay.**

- The daemon owns a **goal workspace**: a small set of **typed, versioned artifacts** — `spec`, `research`, `adr`, `task-list`, `diff`, `findings` — each stamped with the **producing ZeroID identity** and a version.
- Role-agents **read their inputs and write their outputs as artifacts directly**, via blackboard tools that close over the goal workspace (mirroring how `buildFleetMcpServer` closes over the session population, `src/daemon/fleet.ts`, and how `buildMemoryMcpServer` is bound to a session).
  The searcher writes `research`; the architect reads `research`+`spec` and writes `adr`; the reasoner reads `adr`+`spec` and writes `diff`; each reviewer reads `diff` and writes a `findings` entry.
  **No handoff is ever re-serialized through the orchestrator's context.**
- The orchestrator holds an **index of artifact states, not the artifacts themselves** — the conductor's founding principle ("holds an index, not transcripts", `docs/conductor-design.md` §2) applied inside a single goal.
  It observes which artifacts exist and at what version, decides what is ready to run (inputs present), delegates, and advances.

**Why this is strictly better than a message relay:**
1. The orchestrator never becomes the context bottleneck — it carries an index; artifacts live in the daemon.
2. Handoffs are structured and lossless (canonical artifacts), not truncated re-narrated text.
3. Parallelism falls out of the **dependency graph** — any role whose inputs are ready runs — instead of being throttled by the orchestrator's serial turn or a crude per-turn dispatch cap.
4. Every contribution is identity-stamped, auditable, and **resumable**: the graph is durable, so a daemon restart resumes a collaboration mid-flight (the same guarantee `dispatch.ts` gives workers via its SQLite work queue).
5. **Independence becomes an enforced policy, not a convention.**
   A reviewer identity may read `diff`+`spec` but not `implementer-reasoning`; the reviewer is unbiased *because it cannot see the author's reasoning*, enforced at the tool fence — not because a prompt asked it not to peek.

**v1 scope (from the 2026-07-25 grill).**
In v1 the orchestrator drives dispatch explicitly (the existing `dispatch.ts` queue) and the blackboard is the typed-handoff store; the only *parallel* primitive is the review panel (§7).
The deterministic "fire a role the moment its inputs exist" scheduler — where `reads`/`writes` are live dependency edges — is the **end-state (P4, §8)**, because most SDLC flow is sequential and the structured-handoff win does not require it.
In v1, `reads`/`writes` are enforced *access scoping*; in P4 they also become scheduling *edges*.

**This is codeoid's intended direction, not an invention.**
`PhaseDef` already reserves `reads`/`writes` fields, documented as "*Reserved metadata (not yet consumed)*" (`src/daemon/pipeline/interface.ts`).
The blackboard is the convergence point of three existing investments — canonical history, the memory engine, and the reserved `reads`/`writes` — which is why it is the right "best-in-class" bet rather than an over-engineered detour.

**The one hard constraint (a codeoid principle, not an objection).**
The same reserved-field comment warns that "*an unenforced field is false security.*"
So artifact read/write scoping **must be enforced at the `canUseTool` fence** (the gate that already backs role tool-deny, `session.ts` `roleDeniesTool`), never left advisory.
Lighting up `reads`/`writes` means enforcing them — Claude-hard today, and advisory-with-a-logged-warning on backends whose tools don't all route through the gate, exactly as the pipeline already handles cross-backend role enforcement (`docs/pipeline-run.md`, `roleEnforcement`).

---

## 5. Where it sits in codeoid

Additions, no architectural change:

| Addition | What it is | Mirrors existing |
| --- | --- | --- |
| **Collaboration profile on session-create** | An optional `collaboration` object on `SessionCreateMsg` binding each role to `{ providerId, model }` + policy; validated fail-closed against the provider registry. | `providerId`/`pack`/`packRole` on `session.create` (`packages/protocol/src/types.ts`) |
| **Orchestrator role** | A conductor-shaped `Session` (`role: "conductor"`-class) whose fleet MCP surface gains role-aware delegation; holds no repo-write tools by ZeroID scope. **v1: Claude only** (mounts the fleet MCP); any-backend orchestrator tracked in #245. | `#createConductor` + `buildFleetMcpServer` (`src/daemon/session-manager.ts`, `src/daemon/fleet.ts`) |
| **Role-bound child sessions** | One disposable `role: "worker"` `Session` per active role, each with its own `providerId`+`model`+`initialMode` and a delegated leaf identity. | `spawnWorker` (`src/daemon/session-manager.ts`), generalized to carry provider/model |
| **Goal blackboard** | A daemon-owned, goal-scoped typed-artifact store (fixed-core + scoped `extra`) + a **mountable** MCP tool surface (stdio/registry, not the in-process Claude-SDK object — so non-Claude orchestrators are a later mount, #245), read/write-scoped per role. | `buildMemoryMcpServer` binding + the `dispatch_tasks`/`dispatch_events` tables (`src/daemon/store.ts`) |
| **`panel` phase kind + dispatch barrier** | A phase that fans out to N role-children on distinct backends and **joins** on all of them, then synthesizes. | the reserved `"panel"` kind in the phase-kind union (`src/daemon/pipeline/interface.ts`) + `Dispatcher` (`src/daemon/dispatch.ts`) |

---

## 6. Identity, safety, and the enforced envelope

The collaborative session is a flagship Highflame dogfood: many models, many backends, one verifiable authority tree.

- **Delegation tree.**
  `owner → orchestrator → role-child → (sub-agent)`.
  The orchestrator is an owner-delegated agent holding `session:read` + `session:dispatch` only (`CONDUCTOR_SCOPES`, `src/daemon/agent-identity.ts`) — never `tools:write`/`tools:execute` — so nothing it delegates can mutate a repo unless the owner sanctioned that child.
  Each role-child is `tokens.delegate`-d from the orchestrator (`delegation_depth` increments; the `act` chain is verifiable), and cascading revocation kills the whole collaboration by deactivating one identity.
- **Shape → scope, cryptographically.**
  Reuse the existing worker scope profiles (`WORKER_SCOPE_PROFILES`, `agent-identity.ts`): a `review` role maps to the `scout` shape (read + execute, **no `tools:write`**), a `reasoning` role to `ship` (write in a worktree).
  A reviewer that "must not edit" is a leaf identity that **cannot** mint a write scope — read-only by construction, not by prompt.
- **Blackboard read/write scoping.**
  Extends the same fence: a role's artifact `reads`/`writes` are enforced in `canUseTool` (§4), so independence and least-privilege are structural.
- **Human approval gate (R3) is preserved.**
  Send-class dispatch and any egress ride the existing hard, mode-independent approval flow (`#shouldAutoApprove` returns false for fleet-send tools, `session.ts`; `FLEET_SEND_TOOL_NAMES` kept off `allowedTools`, `fleet.ts`).
  A collaborative session cannot silently spawn or act; the owner sees the full delegation input.
- **Per-backend capability matrix + verification bench.**
  Formalize the ad-hoc `roleEnforcement(providerId)` classification into a declared matrix — per backend: hard tool-deny? sub-agents? interrupt? warm resume? model family? approval mechanism? — verified by a bench that probes real behavior (borrowed from omnigent's harness-capability matrix, §9).
  This is what lets the role-picker UI honestly tell the user "reviewer read-only is *guaranteed* on Claude, *advisory* on gemini/codex" instead of failing silently, and lets the orchestrator query capabilities instead of branching on backend name.

---

## 7. Review — panel semantics

Two review shapes exist in the wild, with different plumbing and different value; the user's requirement ("all models take a stab") is the **breadth panel**.
We build that, and keep the **correctness gate** as a composable option.

**Breadth panel (the default for the `review` role).**
1. When `diff` lands, the orchestrator fans out to N reviewers on **distinct backends** (a `panel` phase, §8).
2. Each reviewer reads **only** `diff`+`spec`+the acceptance contract (independence enforced at the fence, §4/§6) and writes an independent `findings` artifact: `{ blocking[], non-blocking[], suggestions[] }` with file:line evidence.
3. The dispatch **barrier** joins on all reviewers (the one genuinely new dispatch primitive — today dispatch is per-task event injection, not an N-way join).
4. A **synthesis** step merges the findings, de-duplicates, and surfaces the merged verdict to the user — **the orchestrator by default; a dedicated `judge` role is a pack option**.
   Following omnigent, there is **no silent auto-vote** — a model or the human synthesizes, and disagreement is shown, not hidden.
5. Optionally, a **debate round** relays each reviewer's findings to the others for one pass of cross-critique before synthesis (borrowed from omnigent's `/debate`), for goals where surfacing disagreement is worth the extra turn.

**Correctness gate (composable).**
For coding packs, a blocking `command` gate (tests/lint/typecheck) runs **before** any reviewer is involved — cheap deterministic checks first, expensive cross-model review only on green — and each blocking finding becomes a fix-task routed back to the same implementer child (reusing its worktree), looping until clean.
The human merges; the collaboration never merges (`docs/conductor-design.md` R-decisions; `feedback_user_owns_releases`).

---

## 8. Unify with packs and pipeline — one engine, two topologies

The pipeline is a **conductor over a live session** that drives *sequential* phases with a human Approve/Revise/Reject boundary between each (`docs/pipeline-run.md`).
A collaborative session is the **parallel** sibling: one orchestrator fanning *concurrent* role-children at one goal.
They share one engine:

1. **Role→backend binding in the pack.**
   Add optional `(provider, model)` to `roleSchema` (`src/daemon/pipeline/pack.ts`), so a pack role carries its backend.
   `resolvePhaseActivation` (`src/daemon/pipeline/pack-service.ts`) returns it alongside the constitution/envelope it already resolves.
2. **Wire the dormant per-phase override.**
   `PhaseDef.provider`/`model` are plumbed from pack YAML all the way to `runPhaseOnSession` but **dropped** there (`src/daemon/session-manager.ts`, "*a run drives ONE session with one provider*").
   For the fleet substrate this stops being a contradiction: a phase's provider/model selects the **child** it runs on, not a mutation of one bound session.
3. **Enforced `reads`/`writes`.**
   Light up the reserved fields (§4) as the blackboard's artifact dependency edges, enforced at the fence.
4. **The `panel` phase kind.**
   Implement the reserved `"panel"` kind (`src/daemon/pipeline/interface.ts`, only `noop`+`skill` are registered today) as: fan out to the phase's role-set across backends → dispatch **barrier** → synthesis (§7).

Net: `/pipeline` with an SDLC pack stays a governed sequential run, but its `review` phase can be a cross-backend panel; a pure collaborative session is a pack with one goal, an orchestrator, and a fan-out phase.
No second wire API, no second create dialog, no duplicated governance.

---

## 9. Create-time UX

Reuse the pattern `pipeline-run.md` already established: the run **is** a session plus a goal and a config, so it extends the **existing create-session dialog** rather than a bespoke panel.

- A first-class **Collaborative** toggle reveals per-role pickers and **compiles to an ephemeral one-goal pack + orchestrator under the hood** — pack vocabulary stays hidden for this path.
  The `/pipeline` pack-selector remains the surface for pre-authored SDLC packs.
- Each picker lists backends from `AuthOkMsg.providers` (`packages/protocol/src/types.ts`, "first entry = default") and models from `models.list` (per-provider), gated by the capability matrix (§6) — a backend that can't hard-deny is flagged, not hidden, for the `review` role.
  The **orchestrator** picker is Claude-only in v1 (#245); the worker pickers are open.
- Submit compiles to a pack and creates the run; the collaboration config persists as a JSON column (`#addColumnIfMissing`, `src/daemon/store.ts`) and is stamped into transcript meta, so it survives a daemon restart the way `providerId`/`role` already do.

Daemon-wide **default** role→backend mappings belong in the settings manifest (`src/daemon/settings/manifest.ts`, which already exposes `conductor.provider`/`conductor.model`); the per-session config is a create-request concern, not a manifest knob.

---

## 10. What is reused vs. new

**Reused as-is** — canonical history + converters (`providers/canonical.ts`); the durable dispatch queue + crash-safe worker lifecycle + digests (`dispatch.ts`, `store.ts`); ZeroID delegated identities + scope-intersection safety + cascading revocation (`agent-identity.ts`); the R3 hard approval gate (`session.ts`); pack governance + phase/gate/halt state machine (`pipeline/`); `applyPhaseActivation` for live role reconfiguration (`session.ts`); the memory engine for artifact-adjacent recall (`memory/engine.ts`); the create path (`session-manager.ts` `#create`).

**New to build** —
1. Role→backend binding in `roleSchema` + collaboration config on `SessionCreateMsg` (+ Zod, fail-closed validation).
2. `provider`/`model` plumbed through `spawnWorker`/`DispatchTaskRow` (+ a provider-aware model-id validation path — today `resolveModelId`/`set_model` are Claude-only, `src/daemon/models.ts`).
3. The **goal blackboard**: fixed-core typed-artifact store (schema + tables) + scoped `extra` + a **mountable** MCP tool surface (stdio/registry, not the Claude-SDK in-process object, #245), read/write-scoped per role at the `canUseTool` fence.
4. The dispatch **barrier/join** over a dispatch group (today: per-task event injection).
5. The **`panel`** phase kind + the **synthesis/merge** step.
6. The per-backend **capability matrix + verification bench**.
7. Create-time collaboration UI (toggle → ephemeral one-goal pack) + persistence column.
8. v1 **guards**: a per-session live-worker cap + a per-collaboration cost roll-up surfaced at approve-time (reusing per-turn metrics + the per-child budget/failure auto-block).

---

## 11. Build phases

Vertical slices; each ends in a working, shippable daemon.

1. **P0 — Role→backend on child sessions.**
   Generalize `spawnWorker`/`DispatchTaskRow` to carry `(provider, model)`; add a provider-aware model-id validation path.
   Exit: a dispatched worker runs on a chosen non-default backend; `conductor-session`-style tests prove per-child provider.
2. **P1 — Collaboration config + create path.**
   `collaboration` on `SessionCreateMsg` + Zod + fail-closed provider validation + persistence column; the toggle **compiles to an ephemeral one-goal pack**; a collaborative session spawns its role-children (per-goal lifetime) on their bound backends.
   Exit: create a collaborative session from the CLI; children come up on the right backends with the right leaf scopes and are torn down at goal completion.
3. **P2 — Goal blackboard.**
   Fixed-core typed-artifact store (+ scoped `extra`) + tables + the **mountable** MCP tool surface (stdio/registry, #245); enforce `reads`/`writes` as *access scoping* at the `canUseTool` fence (Claude-hard, advisory-logged elsewhere).
   Exit: searcher→architect→reasoner hand off through artifacts; the orchestrator holds only an index; a restart resumes mid-goal.
4. **P3 — Panel + barrier + synthesis + v1 guards.**
   The dispatch barrier over a dispatch group; the `panel` phase kind; orchestrator synthesis (judge role optional); optional debate round.
   Plus the lightweight guards: a per-session **live-worker cap** and a **per-collaboration cost roll-up surfaced at approve-time** (reusing per-turn metrics + the existing per-child budget/failure auto-block).
   Exit: N cross-backend reviewers run in parallel on one `diff`, join, and a merged verdict surfaces; reviewers provably cannot read author reasoning or write files; a runaway fan-out is capped and its cost is visible before approval.
5. **P4 — Unify with packs/pipeline (+ dependency-graph scheduling).**
   `(provider, model)` on `roleSchema`; wire the dormant per-phase override onto child selection; `reads`/`writes` graduate from access scoping to **live scheduling edges** (auto-fire a role when its inputs exist); an SDLC pack's `review` phase becomes a panel.
   Exit: `/pipeline` runs a pack whose review phase is a cross-backend panel; a pure collaborative session is a one-goal pack; ready roles fire without explicit orchestrator dispatch.
6. **P5 — Front doors + capability matrix.**
   The extended create dialog (web + Telegram + CLI); the declared per-backend capability matrix + verification bench driving the role-picker.
   Exit: toggle Collaborative, assign models to roles, watch the graph run live, approve dispatches — from web and Telegram.
7. **P6 — Governance (later).**
   Cedar policy per identity/`delegation_depth`; Shield on egress; per-collaboration token budget + loop cap.

---

## 12. Prior art — omnigent (borrow, and where we are better)

Omnigent (Databricks) is the closest shipped meta-harness with multi-model collaboration; its `polly` (orchestrator + cross-vendor review) and `debby` (parallel panel + debate) exemplars are directly relevant.

**Borrow:**
- Role = `{backend, model, prompt, policy}` + per-dispatch `purpose`; do not hard-code role enums (§3).
- Delegation as a tool call driven by one orchestrator prompt; choreography in **editable skill prose**, not compiled pipeline code.
- Async inbox + auto-wake (codeoid already has this via event-driven digests); carry over the hard-won "**act in the same turn you announce**" rule to avoid dropped-turn deadlock.
- Runner-side enforced bounds independent of prompt discipline: per-turn fan-out caps, a purpose guard, blast-radius shell heuristics (as a safety net, not a boundary).
- The **declarative per-backend capability matrix + verification bench** — the single most reusable engineering idea for a multi-backend harness (§6).
- Two review shapes with different plumbing; pick per goal (§7).

**Where codeoid is structurally better:**
- **Blackboard, not message relay** (§4) — omnigent's orchestrator re-serializes text between isolated workers and is the context bottleneck; codeoid hands off structured canonical artifacts through the daemon.
- **Verifiable identity** — omnigent has no per-agent identity; codeoid puts the whole collaboration on one ZeroID delegation tree with one revocation root and full audit.
- **Enforced envelopes** — omnigent's read-only reviewer is a policy heuristic; codeoid's is a leaf identity that cannot mint a write scope.
- **Resumable collaboration** — omnigent's coordination lives in a turn; codeoid's lives in a durable graph + work queue that survives restart.

Watch the footguns omnigent hit: no cross-turn concurrency accounting (add a live-worker cap, not just a per-turn cap), uneven cancellation across backends (surface it, don't assume a killed worker is gone), and context re-serialization cost (the blackboard is our answer).

---

## 13. Grill outcomes (2026-07-25) & remaining open questions

The adversarial grill resolved every original open question:

1. **Blackboard schema** → fixed-core + scoped `extra` (§2, §4).
2. **Orchestrator backend** → Claude for v1, tools built as a *mountable* MCP server; any-backend orchestrator tracked in **#245**.
3. **Concurrency ceiling** → v1 live-worker cap + approve-time cost roll-up; hard ceilings + Cedar/Shield stay P6.
4. **Synthesis authority** → orchestrator by default; a `judge` role is a pack option.
5. **Independence vs. context** → reviewers read `diff`+`spec` only, never implementer reasoning, enforced at the `canUseTool` fence.
6. **Degenerate-pack ergonomics** → a first-class Collaborative toggle that compiles to an ephemeral one-goal pack (§9).
7. **Cost visibility** → per-collaboration roll-up surfaced at the R3 approve-time.

**Deferred to implementation / later phases (not design branches):**

- The exact typed schema of each core artifact (`spec`/`research`/`adr`/`task-list`/`diff`/`findings`) — settled in P2.
- The `reads`/`writes` → scheduling-edge semantics and cycle/deadlock handling — settled in P4 when they graduate from access scoping.
- The concrete contents of the per-backend capability matrix + the verification bench — settled in P5.
- Whether a debate round is on by default — a P3 pack-config knob.
