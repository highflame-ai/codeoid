# Codeoid Conductor — Front-Doors (Web + Terminal UX)

> Status: **DRAFT for review** · Author: design session 2026-07-17
> Companion to [conductor-design.md](./conductor-design.md) (architecture + locked decisions), [conductor-build-plan.md](./conductor-build-plan.md) (daemon phasing), and [conductor-session-resolution.md](./conductor-session-resolution.md) (the retrieval deep-dive).
> This is the **P5 "Front doors"** spec: how the already-shipped conductor becomes visible and drivable in the web UI (Solid) and the terminal UI (Rust/ratatui).

---

## 1. Goal & non-goals

**Goal.**
Make the conductor a first-class, world-class surface in both codeoid clients.
The conductor already exists on the daemon (P0–P4 shipped): it resolves any session across every workspace, dispatches work to real sessions or spawns disposable ship/scout workers, and collects compressed digests, all durably and crash-safe.
Today none of that is visible — it only leaks out as raw `fleet_*` tool-call text inside a CLI conductor transcript.
This spec turns it into a surface you drive by talking to it in plain English, backed by a live fleet view, in both web and terminal.

**Non-goals.**
This is not a change to the conductor's orchestration model.
We are surfacing what the daemon already knows, not adding new dispatch semantics (no typed task-DAG, no data-dependency scheduling — see §11 and §13).
This is not a redesign of the existing per-session chat cockpit; we reuse it verbatim.
This does not remove or hide manual session control — see §3, which is the load-bearing constraint.

**The bet.**
A metaharness wins the conductor not with a prettier board but by rendering something no single-vendor tool can: one live fleet, many backends, one identity and audit fabric.
Claude implements, Gemini reviews, a local model triages — and you watch and steer all of it from one place.
That intersection (cross-backend + controllable + terminal-first + aggregate economics) is open; §7 is where we win it.

---

## 2. The core insight that shapes everything

Two facts about the conductor decide the entire design.

**It is a spawn tree, not a DAG.**
The conductor's only structural relationship is parent → child: conductor → dispatch → worker.
There is no pre-declared plan and no data-dependency graph; the conductor decides at runtime whether to route to an existing session or spawn a worker.
So the honest structure is a tree that unfolds live (Prefect's "Radar" model), not a static DAG you draw up front (Airflow).
A tree is also native to a terminal; a force-directed graph is not.

**It already exists — off-wire.**
P3 + P4 are shipped and live: `dispatch_tasks` / `dispatch_events` in daemon SQLite, worker lifecycle, blocked/wedged states, digests, the crash-safe queue.
By deliberate design the conductor added **zero new client↔daemon wire types** — it renders "for free" as an ordinary session (`fleet_*` tool-calls as tool cards, `<fleet_events>` digests as injected turns).
That is enough to *chat with* the conductor; it is not enough to *see the fleet*.
The task board, worker states, blocked tasks, machine map and audit trail are daemon-only SQLite.
Surfacing them needs exactly one thin, additive read+subscribe surface (§11).

---

## 3. View model — the conductor is a lens, not a wall

This is the constraint everything else must respect.
The conductor is an *added* way to see and drive the same sessions, never a replacement for direct control.
The user must always retain the manual, per-session control codeoid has today, and must never be able to get trapped in an "orchestrated" mode.

Three properties make this fall out of codeoid's architecture rather than requiring new machinery.

**A. Two co-equal homes, one toggle.**
The client has two top-level homes: **Conductor** (the fleet) and **Sessions** (today's flat session list + per-session cockpit).
A single toggle switches between them (web: a segmented control in the top bar; TUI: a top-level view switch).
Neither is modal; both are always available.
Default home is configurable; a first-time user with no conductor sees the classic Sessions home unchanged.

**B. Drill-in *is* take-over.**
Every worker and every dispatch target is a real session in the same population.
Clicking (or `Enter` on) any fleet node navigates into that session's ordinary chat cockpit — the exact view you use to drive a session manually today.
"Take over" is therefore not a new feature; it is the existing attach flow reached from a fleet node.
From there you type directly to that session's agent, interrupt it, fork it, or hand it back to the conductor.

**C. Seamless continuity — no split-brain.**
Because the daemon owns all state and clients are pure renderers, an instruction the conductor dispatches to a session lands in *that session's own transcript*.
So when you switch to manual control of that session, the conductor-issued turn is already there in history, interleaved with your manual turns.
There is no "conductor-driven history" separate from "manual history" — there is one history per session, rendered identically however you reached it.
This is the single most important payoff of the pure-renderer model, and it is why manual/orchestrated coexistence costs almost nothing to build.

**Consequence for the UI.**
The conductor view links out to sessions; it never embeds a second, divergent copy of a session's chat.
The fleet is a lens over the session list, filtered and structured (by lineage, by state), with orchestration affordances layered on top.
Anything you can do to a session from the Sessions home you can still do after drilling in from the Conductor home.

---

## 4. Primary view — state-grouped fleet list; tree/graph is the map

**Primary: a state-grouped fleet list.**
The home you live in is a fleet list grouped by lifecycle state — Needs you / Working / Ready to review / Done.
This wins over a graph as the primary for three reasons.
The operator's real job is triage: who needs me, what is ready to review, what is burning money — and a state-grouped list answers that fastest.
It scales to many agents without layout thrash.
Critically, it is the one view that renders *identically* in Solid and ratatui, which is what keeps the two clients in lockstep instead of drifting apart.

**Co-primary: the live tree/graph "map."**
One keystroke away is the live-unfolding tree (conductor → workers → any sub-workers), promoting to explicit graph edges only where a real relationship exists (e.g. a Gemini reviewer gating a Claude worker's diff — §7).
The tree is what proves codeoid is a *conductor* and not just a session launcher; it carries lineage and cross-vendor edges the flat list cannot.
In the terminal it is drawn tig-style (indented tree in a box-drawing gutter), not as a force graph (§10).

**Secondary lenses over the same nodes.**
A review queue (the *good* use of Kanban): a single "Ready to review" lane with worktree diffs, conflict pre-detection, and sequenced merge.
A dispatch timeline for retrospection: what was dispatched when, what it returned, where it blocked, with a scrubber (§8, D-replay).

**Rejected.**
Kanban as the primary: columns imply the *human* owns state transitions by dragging, but the *machine* owns them here — dragging a card would be a lie. Kanban is demoted to the review lane only.
Static DAG as the primary: there is no static plan to draw.

---

## 5. The conductor chat — an English command line for the whole fleet

The conductor is a session, so it gets the **same chat cockpit every agent gets**: reuse `CenterPane` / `PromptBox` (web) and scrollback / prompt (TUI) verbatim.
What differs is what the chat *does*.

**The flow, by example.**
Take the instruction: *"In the session where we were reviewing the Spark code, also check if test coverage is good."*

1. **Resolve.** The P1 linchpin (`session.search scope:"all"`, cross-workspace, cross-encoder reranked, sub-2s) turns the natural-language reference into the actual session, across every workspace on the machine.
2. **Dispatch.** `fleet_send` with the `send` shape posts the instruction into that session and continues *its own agent on its own backend*. (`send` = route to an existing session's agent; `spawn` = create a disposable ship/scout worker. This example is a `send`.)
3. **Digest.** The target agent does the work and returns a compressed `<fleet_events>` summary to the conductor chat — never the raw transcript, so the conductor "never goes out of context."

**Rendering.**
`fleet_*` tool-calls render as **action cards**, not raw JSON: a "resolved" card, a "dispatched" card, and a "digest" card.
The same chat fans out ("ask every session touching authz to run its linter and report back" → many `fleet_send` calls) and aggregates ("summarize what all my sessions did today" → pulls digests) from one box.

**Two non-negotiables this creates.**

*Resolution must be visible and correctable.*
A reference like "the session where we were reviewing the Spark code" can be ambiguous; the retrieval returns ranked candidates with evidence snippets.
So the conductor chat renders a "resolved → spark-review #a3f1 (92%) · claude — [Dispatch] [Not this one]" card *before* it fires, confidence-gated (Devin's traffic-light idea).
Silent misrouting is the one failure that would kill trust in this feature, so it is designed out.

*The instruction lands in the target session's own transcript.*
It is a real turn (§3.C), not a hidden side channel.
If you are watching that session in another pane or another client, you will see the conductor-issued turn arrive there.

**Caveat (honest scope).**
Fleet tools are surfaced only by the Claude provider today, and spawned workers currently default to Claude.
So `send`-to-an-existing-session (the Spark case, where the target already runs its own backend) works now.
True cross-backend *spawn* is spec-not-shipped; the UI must not over-promise it (§7, §13).

---

## 6. One status vocabulary

Derived from the daemon (dispatch state × session status) and rendered identically in both clients.
Live agents dominate; settled ones recede; attention outranks activity.

| State | Meaning | Rendering |
| --- | --- | --- |
| `working` | running a turn or a tool | animated pulse — the only motion |
| `awaiting` | needs a human | **ranks above working**; rolls up the tree |
| `blocked` | hit the anti-spin failure limit | a hard stop, distinct from failed |
| `done` | digest delivered | row dims, recedes |
| `failed` | task error, will retry with backoff | attempt N shown |
| `queued` | accepted, waiting for a worker slot | concurrency cap |
| `idle` | settled and quiet | dimmed |
| `disconnected` | runner dropped ≠ task failed | quiet grey, never red |

Two subtleties are load-bearing and most tools get them wrong.
`awaiting` outranks `working`: a row that needs you must never hide behind a row that is merely busy.
`disconnected` is not `failed`: a runner drop is a transport event, rendered quiet grey, not a red error.

Semantic colors are a signal system kept separate from the product accent (the verdigris "conductor" chrome color).

---

## 7. Metaharness differentiators (the moat)

Everything in §4–§6 is table stakes any tool can copy.
These are things only a metaharness orchestrating Claude + Codex/GPT + Gemini + local models under one identity/audit fabric can show.

**Capability matrix as data.**
Model each backend's abilities as a declarative record: integration mode, elicitation style, warm vs cold resume, interrupt / stream / subagents booleans, model family, effort family.
Render every node's affordances *from* that matrix (can it be interrupted? taken over? does resume reconnect or replay? what does its approval affordance look like?).
Add a drift-test bench that fails when a backend's declared capability diverges from observed behavior.
(This is omnigent's `harness_capabilities.py` + harness bench — the single most transferable metaharness asset.)

**Backend glyph + visible, overridable routing rationale.**
Every node carries a backend brand glyph, so you read the fleet by *who is doing what*.
Every dispatch is annotated with *why* it was routed there — "↳ Opus · high-stakes edit" vs "↳ Gemini-Flash · cheap recon" — and the route is overridable ("re-run this on GPT").
Routing you can see and veto is the single most differentiated interaction.

**Cross-vendor review as a rendered edge.**
Show "Claude worker → Gemini reviewer (diff + contract only)" as a first-class relationship in the tree.
Independent-vendor verification is more trustworthy than same-model self-review, and only a metaharness can offer it — so make it visible, not incidental.

**One normalized "conductor credit."**
Translate Anthropic tokens, OpenAI credits, Gemini quota and local GPU-seconds into a single unit so a Claude row and a Gemini row are comparable at a glance.
No single-vendor tool needs this; every metaharness must have it.

**Auto-reroute around rate limits.**
When one backend hits its rate limit, reroute pending work to another and show the reroute as an event ("Claude limited → 3 workers → GPT").
No single-vendor tool has anywhere to reroute *to*.

**One identity + audit fabric.**
Every message and action is labelled with its agent's ZeroID identity (per-message chip + WIMSE hover), and the owner → conductor → worker delegation lineage is verifiable.
The same permission/policy gates a Gemini agent and a Claude agent uniformly — each vendor's own tool can only govern itself.

---

## 8. Attention & intervention model

**One cross-session attention queue.**
Aggregate every blocking event across every agent into one ranked "Needs you" queue: permission prompts, plan-approval gates, clarifying questions, merge-ready items, errors.
Rank by (blocking-cost × staleness) so an agent stuck 8 minutes on a yes/no floats to the top.
Surface the count ambiently (title bar / TUI footer).
A child that awaits badges its row, aggregates on its parent, and appears in this queue (roll-up).

**Four-action approval grammar, author-gated.**
Every approval offers **Approve · Edit args · Respond · Reject**, and the dispatch declares which are permitted (a push can be approve-or-reject-only).
This rides codeoid's existing `ui_request` / `approvalId` flow — it is framing plus a conductor-aware card (repo · branch · content preview), not new plumbing.
Approval mirroring + escalate-to-parent-after-grace prevents headless runs from deadlocking on a child's gate.

**Per-agent inline steering (four verbs).**
Queue, steer, interrupt, take-over — four distinct verbs, each honest per backend via the capability matrix.
Never promise deterministic stop where the backend cannot deliver it.
Steering does not require the agent to be blocked; you can barge in on a working agent.
Take-over is the drill-in of §3.B.

**The gate rule.**
Cheap/reversible actions run autonomously; expensive/irreversible actions (large fan-out, merge to main, destructive shell) hit the queue.
Make the threshold a policy, tied to the identity/audit fabric (§7).

---

## 9. Economics — cost/tokens/time at three zooms

codeoid already has first-class per-session metrics (`SessionInfo.usage`).
The fleet view adds the two zooms above and below it.

**Per-node.**
Tokens in/out, normalized cost, wall-clock, model + backend glyph, and a live burn-rate indicator.

**Aggregate.**
Total normalized cost / tokens / wall-time across the fleet, a per-backend breakdown (Claude $X / GPT $Y / Gemini $Z), concurrent-agent count, and per-backend rate-limit gauges (the reroute trigger, §7).
Every surveyed tool lacks this fleet-aggregate view; it is a differentiator, not a nicety.

**Projected + retrospective.**
Projected cost on the plan-gate before a fan-out; a "large fleet" advisory past a token/agent threshold.
Cost-by-node on the map and cost-by-phase on the timeline for retrospection.

---

## 10. Terminal-specific design (ratatui)

**Layout (lazygit + k9s).**
A focusable multi-panel screen: state-grouped fleet (left), selected-node detail (right), two persistent bottom strips (Needs-you queue + cost HUD), and a lazygit-style keybinding footer.
Tab / hjkl move focus; `Enter` attaches (drill-in = take-over); `/` filters; `:` switches views (map / timeline / cost).
Introduce a real `Screen` concept — the TUI has none today (its only overlay is a single `Modal`).

**Hard rule: never stream all agents at once.**
The fleet list shows one live *one-line* status per agent; full token streaming happens only in the focused detail pane.
This is the direct lesson from Claude Code's documented terminal render-corruption when many parallel subagents each try to render.
Many concurrent streams = flicker + cognitive overload.

**Draw the map as a tree, not a graph.**
Use a tig-style indented tree with box-drawing gutter edges (`│ ├─ ╰─ ●`), one row per node.
A shallow runtime-discovered fan-out renders beautifully as a tree and terribly as a force-directed graph.
Reserve a Canvas radial "radar" as an optional flourish only.

**Scale affordances.**
Idle-collapse (fold surplus idle rows into a single "N idle agents" row) and `/` filtering are mandatory at fleet scale.

**Prerequisite.**
The Rust `SessionInfo` is missing the `role` field entirely; add it first so the TUI can even badge a conductor (§11).

---

## 11. Protocol addition (the one required daemon change)

Everything above rests on a single **additive, wire-additive, provider-agnostic** read+subscribe surface in `@highflame/codeoid-protocol`, mirrored in the Rust `codeoid-protocol` crate.
The daemon already holds every field; this only exposes it.
Gate it with a new `fleet:read` scope.

```ts
// packages/protocol/src/types.ts  — additive; gated by a new fleet:read scope

// client → daemon
interface FleetSubscribe { type: "fleet.subscribe"; id: string; scope: "tenant" }        // snapshot + live stream
interface FleetSnapshotResult { type: "fleet.snapshot.result"; id: string; fleet: FleetSnapshot }

// daemon → client (broadcast, mirrors session.status_change)
// delta = a task transition, a new dispatch, a digest, or a worker-lifecycle event
interface FleetUpdate { type: "fleet.update"; delta: FleetDelta }

// ← already exists in daemon fleet.ts / store.ts
interface FleetTaskView {
  id: string;
  kind: "send" | "spawn";
  shape: "ship" | "scout";
  status: "queued" | "claimed" | "running" | "done" | "failed" | "blocked";
  attempts: number;
  workerSessionId?: string;
  targetSession?: string;
  resultDigest?: string;
  error?: string;
  createdBy: string;      // conductor WIMSE URI
  dependsOn?: string[];   // reserved, UNPOPULATED in P5 — lets the graph draw blocking edges later, no breaking change
}

interface FleetSnapshot {
  conductor: SessionInfo;
  workers: SessionInfo[];
  tasks: FleetTaskView[];
  events: DispatchEvent[];
  agg: FleetUsage;        // normalized cost/tokens/time across the fleet
}
```

**Two prerequisites the exploration surfaced.**
The Rust `SessionInfo` is missing `role` entirely — add it first.
Join `workerSessionId` / `targetSession` back to live `SessionInfo` so tree nodes are rich (status, usage, worktree branch, identity) with no duplicated data.

**Beat omnigent's own gap.**
omnigent live-pushes only the *active* session's *direct* children and polls the rest of the tree every 15s.
codeoid should push the *whole subtree* live, so the conductor is live at any depth.

**On dependencies (decision, see §13).**
Keep P5 a pure spawn tree.
The daemon has no dependency model, and the conductor LLM already sequences "merge after review passes" in prose.
The nullable `dependsOn?` above is reserved now purely so typed fan-in/join edges are a later non-breaking add — it is not populated or enforced in P5.

---

## 12. Build plan — P5 front-doors (five slices, docked-first)

Each slice is a shippable PR that leaves both clients in a working state.
Per [conductor-build-plan.md](./conductor-build-plan.md), `main` is ruleset-protected, so each lands as its own reviewable PR.
User decision (2026-07-17): **docked-first** — skip the drawer/modal stepping-stone and go straight to the docked conductor surface.

**P5.0 — The contract.**
Add `fleet.subscribe` / `fleet.snapshot.result` / `fleet.update` + the `fleet:read` scope to `@highflame/codeoid-protocol`; mirror in the Rust crate *and* add the missing `role` field.
Daemon exposes the read surface from `dispatch_tasks` / `dispatch_events` + session population, pushing the *whole subtree* (not just active-session children).
Ship the capability matrix as data.
Files: daemon `src/daemon/{fleet.ts,server.ts,store.ts}` · `packages/protocol` · `crates/codeoid-protocol`.

**P5.1 — Chat + legible fleet (zero-graph).**
The conductor chat works the moment you can attach to it — the `role:"conductor"` session renders its transcript + prompt like any agent for free.
This slice adds the visible resolve / dispatch / digest action cards over the raw `fleet_*` tool calls, labels conductor/worker sessions (role badge, backend glyph, ship/scout shape), groups workers under their conductor, and surfaces `session.search scope:"all"` as the conductor-framed reference search.
Also adds the top-level Conductor ⇄ Sessions toggle (§3.A) so manual control is explicit from day one.
Files: web `SessionListPane.tsx` + top-bar toggle · tui session-tab badges + view switch.

**P5.2 — The docked conductor surface (the centerpiece).**
Focusing the conductor session renders its chat in the center + the state-grouped fleet in the right rail.
Web: `CenterPane` branches on `role === "conductor"` (+ `state/fleet.ts`).
TUI: introduce a real `Screen` enum with a lazygit-style panel layout.
Shared status vocabulary, per-node + aggregate metrics, reusing existing chip/spinner/format primitives so it looks native on day one.
The settings drawer (web PR #187) / settings screen (tui PR #27) remain the state+transport *template*, not the surface.
Files: web `CenterPane.tsx` conductor mode, `state/fleet.ts` · tui `Screen::Conductor` + panel layout.

**P5.3 — Attention & intervention.**
The cross-session "Needs you" inbox with four-action cards (conductor-aware framing).
Queue / steer / interrupt / take-over verbs gated by the capability matrix.
Approval mirroring + escalate-to-parent-after-grace.
Files: web inbox + `ApprovalBar` extension · tui bottom-right inbox pane + keymap.

**P5.4 — Graph, replay & cross-backend polish.**
The graph/tree map lens (tig-style in TUI), the dispatch-timeline scrubber, cross-vendor review edges, the routing-rationale annotations + override, the aggregate/normalized cost dashboard, and the capability-drift bench in CI.
Files: web map canvas · tui tree/rail renderer · `tests/harness_bench`.

---

## 13. Decisions log & open questions

**Locked.**
Docked-first: the conductor surface is a docked chat + fleet rail from P5.2; no drawer stepping-stone.
Pure spawn tree for P5: no typed dependencies; reserve a nullable `dependsOn?` on the wire type for a later non-breaking add.
Manual control is never removed: the conductor is a lens over the same sessions (§3), with a top-level toggle and drill-in take-over.
Primary view is the state-grouped list; tree/graph is the co-primary map.
Resolution is visible and correctable before dispatch; dispatched instructions land in the target session's own transcript.

**Open.**
Cross-backend `spawn`: today spawns default to Claude and fleet tools are Claude-only — sequencing the daemon work to let the conductor spawn a codex/gemini/pi worker (via the anyagent adapter) is out of P5 scope but gates the full §7 story; when does it land?
Default home: does a user with an active conductor default to the Conductor home or the Sessions home?
Review-queue merge: how much of the sequenced-merge / conflict-pre-detection lands in P5.4 vs a later slice?
Normalized "conductor credit": exact conversion model across token / credit / quota / GPU-second wallets.

---

## 14. Provenance & references

**Grounded in the codebase.**
Daemon: `src/daemon/{dispatch.ts,fleet.ts,store.ts,agent-identity.ts}`, `docs/conductor-{design,build-plan,session-resolution}.md`.
Web: the Solid event→reactive-store pipeline, the SettingsDrawer manifest pattern (PR #187).
TUI (`codeoid-ui`): the elm-style reducer, the settings screen (PR #27), the missing `SessionInfo.role` field.

**Surveyed for the field (17 tools).**
Claude Code agent-view · Conductor.build · Vibe Kanban · Cursor Agents · Devin · Factory Droids · Google Jules · OpenAI Codex cloud · LangChain Agent Inbox · AutoGen Studio · OpenAI Agents SDK · CrewAI · LangGraph Studio / LangSmith · Temporal · Prefect · Airflow · Dagster · plus TUI references lazygit / k9s / tig.

**The sibling metaharness.**
omnigent (Python) is the closest prior art: capability matrix, dual list+graph over one spawn tree, the status taxonomy (`awaiting` outranks `working`, `disconnected` ≠ `failed`), the cross-session inbox, approval mirroring.
Its gaps are codeoid's opening: its fleet UX is web-only (no terminal conductor), it polls the tree at depth (no full-subtree live push), and its "plan" is a JSON file the agent writes (no typed structure).
codeoid beats it on all three.
