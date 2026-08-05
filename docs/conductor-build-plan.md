# Conductor — Phased Build Plan

> Companion to [conductor-design.md](./conductor-design.md) (architecture +
> decisions) and [conductor-session-resolution.md](./conductor-session-resolution.md)
> (the retrieval deep-dive). Those two docs ARE the spec; this is the sequencing.
>
> **2026-08-05 — R6 capability reframe.** The conductor is an assistant whose fleet
> is *one capability*, not a fleet supervisor. Design §5 carries the full capability
> surface and §3 the write-scoping rule. Ordering effects on the phases below:
> a new tool-surface slice lands first, **P5 (front doors)** and the mountable fleet
> MCP (#245) move up, and **P4.5 (routines)** gains two hard prerequisites — the
> spend ceiling from P8, and a decision on **sandbox granularity** (the Forge
> wrapper is one fence per daemon; per-session isolation is a different topology,
> and until it is settled `shape: "scout"` is a scope claim rather than a fence —
> design §9). Phase *contents* below are otherwise unchanged.

## Branch strategy

- **One feature branch off `main`: `feat/conductor`.** `main` is ruleset-protected
  (PR + CI required), so every phase lands as its own reviewable PR onto
  `feat/conductor` (or PRs straight to `main` if you prefer trunk-ish); the design
  docs are the first commit.
- Phases are **vertical slices** — each ends in a working, shippable daemon. No
  phase leaves the tree broken. Prefer merging a phase before starting the next.
- **P1 (retrieval) and P2 (identity) are independent subsystems** (memory engine vs
  ZeroID) — they can be built in parallel (two people / two worktrees) and only
  meet at P3.

## Sequencing principles (codeoid-specific)

1. **Measure before you tune.** The retrieval work is only trustworthy against a
   labeled eval set — build it first (P0).
2. **Contracts before consumers.** Card/fact schemas + the fleet protocol land
   before the conductor LLM or any client consumes them.
3. **Read before write.** Fleet *read* tools (list/find/summary) ship and bake
   before any *act* tool (send/spawn) — the blast-radius rule.
4. **The daemon owns state; clients are pure renderers.** Every capability is a
   daemon/protocol feature first; web, Telegram, and mobile are thin views over it.

---

## Phase overview

| # | Phase | Ships | Depends on |
|---|---|---|---|
| **P0** | Branch + eval harness + schemas | precision@1 baseline; card/fact schema; labeled set | — |
| **P1** | Session-resolution retrieval upgrade *(linchpin)* | fuzzy ref → right session, cross-workspace, sub-2s | P0 |
| **P2** | Conductor identity foundation | durable owner-delegated conductor identity | P0 |
| **P3** | Conductor session + read-only fleet tools | conductor can list/find/summarize the fleet | P1, P2 |
| **P4** | Dispatch + routing (durable queue + roles + hardening) | confirm → act; **restart-proof** workers; child digests | P3 |
| **P4.5** | Routines (scheduled + triggered autonomy) | unattended cron/webhook fleet tasks; `[SILENT]` monitors | P4 |
| **P5** | Front doors: web + Telegram | conductor chat + separate switchable session list | P4 |
| **P6** | Act on behalf (email/web/calendar) | approval-gated egress via delegated children | P4 |
| **P7** | Mobile app contract + conductor screen | mobile renders conductor + session switcher | P5 |
| **P8** | Governance *(later)* | Shield egress, Cedar policy, budgets, loop cap | P4/P6 |

---

## P0 — Branch, eval harness, schemas

**Goal:** a fast deterministic feedback loop for the linchpin, plus the data
contracts everything else consumes.

**Slices**
- Create `feat/conductor`; commit the three design docs.
- **Labeled eval set**: ~40–60 `(NL reference → correct session_id)` pairs mined
  from your own codeoid history across repos (mix identifier-heavy + fuzzy). Store
  as a fixture.
- **Eval harness**: runs a resolver over the fixture, reports **precision@1 /
  MRR / recall@k** + p50/p95 latency. First target: current `searchSessions()`.
- **Schemas** (types + SQLite DDL, no behavior yet): `session_card`
  `{session_id, workspace, repo, branch, task, state, last_action, open_threads,
  entities, updated_at}`; `fact(subject, predicate, object, valid_at, invalid_at,
  created_at, expired_at, embedding)`.

**Exit:** `bun test` runs the eval; you have a **baseline precision@1 number** to
beat, and the card/fact tables migrate cleanly (verify against a real
`bun:sqlite`, not DDL strings).

**Baseline (MEASURED, on current-main base)** — against the real Hetzner corpus
(16 sessions / 11 workspaces / 11,938 episodes), 37 genericized fuzzy references.
The naive cross-workspace baseline scores **~22% P@1** — a *ranking/fusion* problem,
not recall (R@5 is far higher, so the right session is in the top few, just not #1;
a small workspace's batch-relative BM25 scores dominate the naive merge). Full
write-up, per-stage numbers, and repro:
[../src/daemon/eval/BASELINE.md](../src/daemon/eval/BASELINE.md). **That ~22% is the
number P1 must beat** — P1 slices 1–2 (global fusion + cross-encoder rerank) take it
to **~73%** on pure-fuzzy references at <100 ms.

---

## P1 — Session-resolution retrieval upgrade (the linchpin)

**Goal:** resolve a fuzzy reference to the right session, across all workspaces,
sub-2s — the capability the whole product hinges on. Pure memory-engine work;
benefits every client immediately, no conductor/identity risk.

**Slices (each independently testable against the P0 harness)**
- **1a — Embedder → BGE-M3.** New `Embedder` impl (ONNX/int8) behind the existing
  interface; persist **dense + learned-sparse** vectors (BGE-M3 emits both). Keep
  `bge-small-en` as the degraded fallback.
- **1b — Identifier-aware lexical.** Rebuild `episodes_fts` (+ new `cards_fts`)
  with a code/trigram analyzer + boosted id columns (ticket/branch/path). Add
  Stage-0 regex query-typing, Stage-3 exact-id override, and a deterministic
  entity boost.
- **1c — Session cards + facts.** Generate a card per session via
  **LFM2-350M-Extract** (grammar-constrained JSON) on `IndexScheduler` checkpoints;
  keep canonical with mem0-style ADD/UPDATE/invalidate reconciliation; record state
  changes as **bi-temporal facts** (invalidate-don't-delete).
- **1d — Cross-workspace mode.** `ALL` scope on `recall` / `loadVectorMatrix` /
  `ftsSearch` (today all `workspaceId`-bound).
- **1e — Cross-encoder rerank.** `bge-reranker-v2-m3` (ONNX-int8) over top-k cards.
- **1f — Fusion.** RRF (k=60) now; swap to TMM-normalized convex + α-by-query-type
  once the P0 labels justify it. Add recency/reinforcement/pinned priors.

**Exit:** precision@1 on the P0 set **beats baseline by the target margin**; p95
resolution **< 2s** on the Hetzner box; identifier queries (`studio#870`) and fuzzy
queries (`the version-scoping bug`) both land. This is the go/no-go gate for the
whole feature.

**Risk:** BGE-M3 CPU latency — mitigate with ONNX-int8 + offline batch embedding
(only the query embeds at request time). Verify tok/s on the actual box.

---

## P2 — Conductor identity foundation

**Goal:** an owner-delegated, durable, revocable conductor identity (design R1+R2).
Independent of P1 — build in parallel.

**Slices**
- Add a **conductor scope profile** granting `session:*` to an agent identity
  (extend `AGENT_TOOL_SCOPES`); register with a policy `max_delegation_depth ≥ 3`.
- **Delegate `session:*` from the human owner** to the conductor (not the owner's
  own token); verify the `human → conductor → child → sub-agent` chain mints at
  depth 3 against `zeroid` (cae_test confirms depth-3 works).
- **Durable identity**: persist the conductor's `identityId` + credential to the
  store; on `resumeSessions()`, reload rather than re-register (survives restart →
  one stable WIMSE URI). Children stay disposable.
- Verify **cascading revocation**: deactivating the conductor kills its subtree.

**Exit:** conductor identity persists across a daemon restart (same URI), holds
`session:*` via owner delegation, every fleet action audits under its URI, and one
`agents.deactivate` kills the whole subtree.

---

## P3 — Conductor session + read-only fleet tools

**Goal:** a single global `role:"conductor"` session that can *see* the fleet.
Read-only — no act/spawn risk.

**Slices**
- `role: "conductor"` on `Session`; conductor is discoverable + attachable like any
  session, and self-persists (durable identity from P2).
- **`codeoid_fleet` in-process MCP server** (mirror `buildMemoryMcpServer` at
  `session.ts:810`), injected only for the conductor: `fleet_list`, `fleet_find`
  (calls the P1 pipeline), `fleet_summary` (compressed, not raw scrollback),
  `fleet_recall`, `machine_map` (workspaces + git/running state).
- *(Optional, later)* A protocol-level `fleet.find`/`fleet.list` message would give
  clients an **instant fleet-search box** that skips an LLM turn — but per the mobile
  plan (§8) the conductor needs **zero new wire types**; clients light it up by
  attaching to the conductor session. Defer unless a client wants LLM-free search.

**Exit:** via CLI (`codeoid attach conductor`), "which session was the authz fix?"
resolves correctly across workspaces; conductor holds only an index, never raw
child transcripts.

---

## P4 — Dispatch + routing (send-class)

**Goal:** direct existing sessions and spawn disposable workers, safely.

**Slices**
- `fleet_send` (fire-and-forget to an existing session), `fleet_interrupt`,
  `fleet_spawn` (disposable child with a delegated identity from P2). Dispatch
  carries a **`shape`: ship vs scout** (deliver-a-change vs investigate-and-report).
- **Durable work-queue backbone** *(hermes Kanban)*: back dispatch with a
  SQLite task board + a dispatcher loop that atomically claims, reclaims stale
  claims, and **auto-blocks a task after N consecutive failures** (anti-spin,
  complements the stuck-loop guard below). Restart-proof — a spawned worker survives
  a daemon restart because its claim + state live in the DB, not the turn.
- **Delegate role model** *(hermes leaf/orchestrator)*: a spawned child is a
  **`leaf`** (focused worker — no `fleet_spawn`/`send`/act-on-behalf) unless granted
  **`orchestrator`** (may spawn, bounded `max_spawn_depth`/`max_concurrent`).
  Enforced via **ZeroID scopes**, not a config flag — this *is* R1 delegation-depth +
  read-only-by-construction, made cryptographic.
- **Routing safety (R3):** send-class to an existing user-owned session first
  proposes with **repo + branch + content shown**, acts only on confirm (reuse the
  `approvalId` correlation flow); reads stay silent. Per-workspace autonomy mode
  (`no-mistakes`/`direct-PR`/`local-only` + `+yolo`) sets how much confirm is needed.
- **Zero-token event-driven supervision** *(firstmate)*: the daemon absorbs benign
  events and wakes a conductor turn only on *actionable* ones; heartbeat backstop
  with exponential backoff; a durable event queue for crash recovery.
- **Session-lifecycle hardening** *(hermes)*: `resume_pending` (soft — continue the
  transcript) vs `suspended` (hard wipe); **stuck-loop escalation** (auto-suspend a
  worker active across 3+ restarts); a `.clean_shutdown` marker; a **burst-collapse
  message queue** (single next-up slot + FIFO overflow) so message bursts never
  process out of order.
- **Event-driven digests:** child completion emits an event → conductor turn
  receives a *compressed* result (never raw transcript) — the never-OOC guarantee.

**Exit:** "continue the authz `latest_only` fix in that session" → resolves →
confirms (right repo/branch) → sends; a spawned child's result returns as a digest;
a worker survives a daemon restart and resumes; conductor context stays
O(active threads).

---

## P4.5 — Routines (scheduled + triggered autonomy)

**Goal:** turn the conductor from a fleet *supervisor* into a personal *assistant* —
it runs tasks unattended, on a schedule or an external trigger.

**Slices** *(hermes cron / webhooks)*
- **Scheduled jobs:** cron expressions + human intervals ("every 2h", "0 2 * * *",
  one-shot ISO timestamps). Per-job `skills` / `model` / `workdir` / delivery-target.
- **Triggered jobs:** webhook subscriptions (GitHub events, generic API POST with
  HMAC auth) that dispatch a fleet task from the payload.
- **Script-injection + `[SILENT]` pattern:** a pre-run script does the mechanical
  work (fetch/diff/compute), its stdout becomes the prompt context, and the job
  emits nothing unless something changed — zero-spam, near-zero-token monitors.
  (`no_agent=true` makes the script the whole job.)
- **Cron hardening:** hard per-run interrupt (a runaway loop can't monopolize the
  scheduler), a tick file-lock (no duplicate ticks across processes), catchup/grace
  windows, and routine output lands in its **own** session frame — never corrupting
  the conductor's main-conversation role alternation.
- Delivery reuses the P5 front doors; a routine can also deliver to a file or an
  existing session with no front door at all.

**Exit:** "every night, triage the backlog and open a draft PR" runs unattended and
delivers a digest; a monitor stays silent until it fires; a GitHub PR event triggers
a scoped review — all under the conductor's identity, audited, and cost-metered.

**Depends on:** P4 (a routine fires dispatch). Delivery breadth grows with P5.

---

## P5 — Front doors: web UI + Telegram

**Goal:** talk to the conductor from web + Telegram; browse/switch any session
separately.

**Slices**
- **Web (SolidJS):** a **conductor pane** (attaches to the conductor session) plus a
  **session list** view. NL session search is served by the conductor itself; an
  optional LLM-free search box would use the deferred `fleet.find` message (P3).
- **Telegram:** route DMs to the conductor session; `/sessions` lists + lets you
  switch/attach to any session (reuse the embedded `SessionManager` access).
- Both are thin `Frontend` plugins over the same daemon — no new state owner.

**Exit:** from web and Telegram you can (a) converse with the conductor and (b)
list + switch into any individual session; both stay in sync (daemon-owned state).

---

## P6 — Act on behalf (email / web / calendar)

**Goal:** the "master of my machine" surface, approval-gated (design R4).

**Slices**
- Integrations as **narrowly-scoped delegated children** (e.g. a Gmail MCP child
  holding only `email.send`), never on the conductor directly.
- **Owner approval gate** showing recipient + subject + body preview (informed
  approval, not theater).
- Web lookup: the conductor uses `WebSearch`/`WebFetch` directly for ad-hoc
  questions (R6 — delegation is a context-cost decision, not a trust one), and
  delegates to a child only when the *reading* would threaten its own context.

**Exit:** "email X the summary" → conductor drafts → approval with full preview →
send; research tasks delegated and returned as digests. **No Shield yet** (P8).

---

## P7 — Mobile app: conductor screen + session switcher

**Goal:** a codeoid mobile client — because clients are pure renderers, this is
mostly a new front end over the *existing* protocol.

**Slices**
- **Conductor screen** = attach to the conductor session (same protocol as web).
- **Session list** = `session.list` + the P3 protocol `fleet_find` search box,
  rendered as a separate, switchable list; tapping one attaches to it.
- Confirm-before-act (R3) and approval prompts (R4) render as native mobile
  confirmations over the `approvalId` flow.
- Contract check: confirmed by the mobile plan (§8) — the conductor needs **no new
  wire types**; the app attaches to the conductor session like any other. The one
  *optional* addition is the deferred protocol-level `fleet.find` search box (P3).

**Exit:** mobile app shows the conductor chat + a separate switchable session list;
switching sessions and approving actions work identically to web.

---

## P8 — Governance (later)

**Goal:** the deferred safety layer (design R4/R5 "later").

**Slices:** Shield on egress (fail-open to approval if down); Cedar policy per
identity / `delegation_depth`; per-conductor token budget + alert; cheap
per-instruction bounce cap (loop guard).

**Exit:** injected child cannot exfiltrate past Shield; runaway loop is capped;
spend has a ceiling. Great Highflame dogfood story.

---

## Informed by firstmate (prior art)

See [conductor-prior-art-firstmate.md](./conductor-prior-art-firstmate.md) — a
shipped conductor built as codeoid's architectural inverse. It validates our
daemon + identity + structured-memory foundation and yields refinements folded
into the phases:

- **P3/P4 — conductor mutation flows through children behind approval.** All
  mutation of a target repo goes through a crewmate the owner approved.
  ⚠️ **Superseded in part by R6** ([conductor-design.md](./conductor-design.md#decisions-locked-from-grilling)):
  this bullet used to claim we *enforce* read-only "by construction" by denying
  write scopes to the conductor identity. We do not — the ZeroID scopes never
  gated the conductor session's local tool surface, `Bash` sits outside
  `WRITE_TOOLS` by design, and `fleet_spawn(shape:"ship")` grants transitive write
  anyway. The invariant we actually keep is **path scope**: the conductor stays out
  of repos. See the R6 table in design §3.
- **P4 — supervision is zero-token + event-driven.** Conductor LLM turns fire only
  on *actionable* daemon events; benign ones are absorbed with no turn; heartbeat
  backstop with exponential backoff; actionable events hit a durable queue for
  crash recovery. Daemon push beats firstmate's bash pane-scraping.
- **P4 — dispatch carries a `shape`: ship vs scout.** ship → PR/merge → teardown;
  scout → report, never pushes, scratch worktree.
- **P4 — per-workspace autonomy modes** (`no-mistakes`/`direct-PR`/`local-only` +
  `+yolo`) replace blanket confirm, and map directly onto the Cedar layer (P8).
- **P4 — sentinel/out-of-band marker** so daemon-injected event digests are never
  confused with real user messages.
- **P5 — `/afk` batched-digest away-mode + `/stow` knowledge sweep** as conductor UX.
- **P5/meta — harness dispatch profiles** (NL rules → per-task harness/model/effort)
  feed the meta-harness direction.
- **Topology (future) — secondmates:** domain sub-conductors via the *same*
  delegation-depth identity chain; keeps the single global conductor as v1 default.

## Informed by hermes (prior art)

See [conductor-prior-art-hermes.md](./conductor-prior-art-hermes.md) — Nous's
hermes-agent, the most complete personal-assistant prior art. It occupies the
personal-assistant niche firstmate doesn't, and drove two changes above:

- **P4 upgraded** — durable Kanban-style work-queue (atomic claim, stale reclaim,
  failure-limit auto-block → restart-proof workers) + the `leaf`/`orchestrator`
  delegate role model (enforced via ZeroID scopes, not config flags) +
  session-lifecycle hardening (resume_pending / stuck-loop escalation /
  clean-shutdown / burst-collapse message queue).
- **New P4.5 — Routines** — scheduled + webhook/event-triggered autonomy with the
  script-injection `[SILENT]` monitor pattern and cron hardening. This is the piece
  that makes the conductor a personal *assistant*, not only a fleet supervisor.
- **Mined for later:** the multi-platform gateway shape (`SessionSource` +
  deterministic session-key) for P5 beyond web+Telegram; zero-context-cost tool-RPC
  scripts; the Curator safe-autonomy invariants (archive-not-delete, pinned-exempt,
  agent-provenance-scoped) if we add agent-authored skills; ACP interop; and
  serverless-persistence (Modal/Daytona) for a cheap always-on cloud conductor.
- **Where codeoid stays ahead:** cryptographic identity (hermes is allowlist +
  DM-pairing), rerank + bi-temporal retrieval (hermes is FTS5 + LLM-summary), and a
  typed modular daemon (hermes is a Python monolith with 250–738 KB god-files).

## Reconciliation with the mobile app plan

[mobile-app-design.md](./mobile-app-design.md) (Expo/React Native, separate
`codeoid-mobile` repo) is conductor-aware and mostly *agrees* with this plan.

**Aligned:**
- **IA matches our topology.** Mobile makes "the conductor" a pinnable **home
  surface** and the session list a secondary **fleet view** — exactly our
  single-global-conductor + separately-listed/switchable-sessions decision.
- **Approvals are the shared crown jewel.** Our confirm-before-send (R3/P4) rides
  the `approvalId` mechanism; mobile turns that same mechanism into **native push +
  voice approvals** ("approve / deny / show me the diff first"). The conductor is
  the backend; the phone is its highest-value front door.
- **Voice-approval convergence.** Mobile borrows `iris`'s `hermesGate` (propose →
  read-back → user must actually *speak* → only then act) — the same invariant as
  firstmate's read-only-by-construction and our R3: **enforce confirm-before-
  side-effect in code, not by trusting the model.** Three independent sources agree.

**Correction — the conductor needs ZERO new client↔daemon wire types.** The mobile
doc's §8 is right: the conductor is just a session, and its fleet actions render as
ordinary tool calls in the transcript. So the earlier P3/P7 idea of "expose
`fleet_find` over the WS protocol so clients get a search box" is **not required**
and is downgraded to an optional later enhancement (a client-side instant
fleet-search that skips an LLM turn). v1 clients — web, Telegram, mobile — light up
the conductor purely by attaching to the conductor session. This *unblocks* mobile:
it builds its whole P0–P4 on today's attach/scrollback/session-list surface and
surfaces the conductor the moment our P3+ lands.

**Shared prerequisite — extract `@codeoid/protocol` + `@codeoid/core`** (wire types
+ WS client + reducers) from `codeoid` once, up front. Mobile P0 requires it; the
conductor and `web/` benefit too (ends today's type triplication). Do it regardless
of which track leads.

**Two workstreams, one contract:**
- *Conductor* (this plan, P0–P8) — daemon-side: session resolution, identity, fleet
  tools, dispatch, act-on-behalf. Protocol-complete for clients at **P3**.
- *Mobile* (mobile-design P0–P5, separate `codeoid-mobile` repo) — the RN client;
  only its P5 (conductor surface) depends on this plan's **P1 + P3**. Everything
  before P5 ships on today's protocol.

**Sequencing recommendation — conductor backend first.** Do the shared core
extraction, then **P1 (session resolution)** as the risk-retiring go/no-go gate:
it's the moat, it has **no prior art** (firstmate and Happy both lack it), it
improves every existing client, and it's the riskiest unknown — prove it before
building a front-end around it. The mobile app proceeds **in parallel** on today's
protocol (it is not blocked), and the two converge at mobile-P5. Shipping mobile
*first* gives you "control one session from your phone" (which Happy already does);
shipping the conductor *first* is what makes the eventual mobile app "supervise a
fleet by voice" — the position no competitor holds.

## Dependency graph

```
P0 ──┬── P1 (retrieval) ──┐
     └── P2 (identity) ───┴── P3 (conductor + read) ── P4 (dispatch)
                                                          ├── P4.5 (routines)
                                                          ├── P5 (web + telegram) ── P7 (mobile)
                                                          ├── P6 (act on behalf)
                                                          └── P8 (governance, later)
```

## Verification philosophy

Every phase states how you *know* it's done (exit criteria above). Two hard gates:
- **P1 exit is the go/no-go for the whole feature** — if fuzzy resolution isn't
  reliably sub-2s and precision@1-strong on your own history, nothing downstream
  matters.
- **Read-tools (P3) bake before act-tools (P4)** — never ship `fleet_send` before
  `fleet_find` is trustworthy.
