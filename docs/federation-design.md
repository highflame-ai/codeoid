# Codeoid Federation — Design Proposal

> Status: **DRAFT for grilling** · Author: design session 2026-09-05
> Companion to [conductor-design.md](./conductor-design.md) (the assistant) and
> [conductor-build-plan.md](./conductor-build-plan.md) (its sequencing).
>
> Goal: make the fleet span **machines**. One conductor, one board, one memory
> surface across a desktop, a laptop, a Hetzner box, and whatever comes next —
> without a second orchestrator, a new protocol, or the corpus leaving the
> machine that produced it.

---

## 1. The gap

The conductor design says "master of my machine" and means it literally. Every
fleet primitive is scoped to one daemon:

| Primitive | Where | Machine-aware? |
| --- | --- | --- |
| `FleetSessionView` | `src/daemon/fleet.ts:33` | **no** — id, name, workdir, workspaceId, status, provider |
| `machine_map()` | `src/daemon/fleet.ts:314` | **no** — derives workspaces from the *local* session list |
| `sessions` table | `src/daemon/store.ts:262` | **no** host column |
| `dispatch_tasks` | `src/daemon/store.ts:396` | `claim_owner` is a daemon boot id, but there is no machine axis |
| `episodes` | `src/daemon/memory/store.ts:246` | `workspace_id` only |
| `fleet.subscribe` | `packages/protocol/src/schemas.ts:365` | `scope: z.literal("tenant")` |

So `machine_map` is close to tautological today: it enumerates the workspaces of
sessions the daemon already returned. And no open issue covers this — #279
(front doors), #280 (always-on), #245 (mountable fleet), #251 (outward control
plane) are all single-daemon.

**This is a missing primitive, not a missing conductor feature.** No amount of
conductor work reaches a session on another box.

---

## 2. Goal & non-goals

**Goal.** The owner talks to **one** conductor and gets a true fleet view: every
session on every machine, resolvable by fuzzy reference, dispatchable, with
memory that spans hosts.

**Non-goals.**

- **Not a second orchestrator.** The conductor stays the single front door
  (design §5). Federation gives it reach, not a peer.
- **Not a conductor per machine.** N conductors is N assistants; the owner then
  routes by hand, which is the problem we started with.
- **Not corpus centralisation.** Episodes stay on the machine that produced
  them. §7 explains why this is an architecture choice and not a compromise.
- **Not a cloud service.** The hub is one of the owner's own machines. Nothing
  in this design requires a third party, and the identity model already works
  without one.
- **Not peer-to-peer.** See D1.

---

## 3. What already exists — the seams

Federation is cheaper here than it looks, because four load-bearing pieces are
already built for other reasons.

**1. Stable cross-machine workspace identity.**
`resolveWorkdirAlias()` (`src/daemon/share/git-alias.ts:37`) already canonicalises
a workdir to a portable alias via git remote — `github.com/saucam/codeoid` — with
documented fallbacks and no path leakage. It was written for session export.
It is exactly the join key federation needs: *the same repo on three machines
resolves to the same alias.*

**2. Path re-anchoring.** `share/path-rewrite.ts` already rewrites absolute paths
to alias-relative form and back, so a card or digest produced on the laptop reads
correctly on the hub.

**3. A dispatch queue that already looks distributed.** `dispatch_tasks`
(`store.ts:396`) has atomic claim, `claim_owner` (a daemon boot id), stale-claim
reclaim, `not_before` retry backoff, and `failure_limit` auto-block. That is a
distributed work-queue design that happens to run in one process. Letting a
*remote* daemon claim rows is a `WHERE` clause and a transport, not a redesign.

**4. A protocol seam the authors already anticipated.** From
`packages/protocol/src/schemas.ts:365`:

```ts
/**
 * Fleet board subscribe/unsubscribe. `scope` is a closed literal rather than a
 * free string so widening it later ("machine", "account") is an explicit,
 * reviewable protocol change instead of something a client can just ask for.
 */
export const fleetSubscribeSchema = z.object({
  ...base,
  type: z.literal("fleet.subscribe"),
  scope: z.literal("tenant"),
});
```

`fleet-board.test.ts:121` asserts `scope: "machine"` is *rejected*. The widening
was designed for; it just was not taken.

---

## 4. Topology

### D1 — Hub and spokes, not a mesh

One daemon is the **hub** (the Hetzner box: always on, static address). Every
other machine runs a **satellite** daemon that dials *outbound* to it.

Rationale, in order of force:

1. **NAT.** The laptop and the Mac mini have no reachable address. Any design
   where the hub initiates is dead on arrival for the actual fleet.
2. **The conductor must be singular** (§2). A mesh has no natural home for it.
3. **The hub is already the box with the corpus.** `BASELINE.md` measured the
   eval set against "the real Hetzner corpus (16 sessions / 11 workspaces /
   11,938 episodes)". The retrieval work already assumes that box.

This is the same split [Coder's Agent Relay](https://coder.com/blog/introducing-agent-relay-cloud-hosted-agents-self-hosted-execution)
reaches for — central control plane, self-hosted execution — arrived at from the
same constraint.

### D2 — Federation is two channels over one outbound socket

A satellite is a **client of the hub that also serves work**. Two channels,
opposite directions, one WebSocket:

```
                       ┌──────────────── HUB (hetzner) ────────────────┐
                       │  conductor (singular)                          │
  satellite (laptop)   │  fleet board · card mirror · dispatch queue     │
        │              └───────▲───────────────────────┬────────────────┘
        │  ① upstream: state    │                       │  ② downstream: claims
        │     cards, status,    │                       │     dispatch rows for
        │     usage, machine    │                       │     machineId=laptop
        └───────────────────────┘◄──────────────────────┘
             outbound WS, satellite-initiated, satellite-authenticated
```

**① Upstream — state replication (satellite → hub).** Session status, usage, and
**session cards** (`memory/cards.ts` — repo, branch, task, state, open threads,
entities). Small, already the designed retrieval unit, already embedded.

**② Downstream — dispatch claim (hub → satellite).** The hub owns the queue. A
satellite claims rows tagged with its `machineId` and executes them locally,
reporting result digests back up ①. The claim semantics are the ones
`dispatch.ts` already implements; only the claimant moved.

**No raw transcripts cross the link, in either direction.** That is design §2's
never-OOC rule applied to the network, and it is also what keeps the link cheap
enough to run over a home uplink.

---

## 5. Identity across machines

This is the part no competitor can copy, and it needs no new mechanism.

- Each satellite daemon holds **its own ZeroID agent identity**, delegated from
  the owner, carrying `fleet:read` + `session:dispatch` and nothing else.
- The delegation chain simply gets longer and stays verifiable:
  `owner → conductor → dispatch task → satellite → worker session → sub-agent`.
  Depth is already a JWT claim with a graph cap of 10 (design §4); this fits.
- **Cascading revocation becomes a machine kill-switch.** Deactivate the
  laptop's identity → every session it contributed drops off the board and every
  token it minted dies. "I lost my laptop" is one `agents.deactivate`.
- Audit rows gain a machine dimension for free: every action already records a
  WIMSE URI, and the satellite's URI *is* the machine.

### 5.1 Machine identity — and how far to take attestation

`machineId` as declared in §6 is a **label**. A label is enough for the board and
for routing, and it is worth being explicit that it is not a security control: a
compromised satellite can claim to be any machine its token permits.

Tying the machine to a hardware root of trust is the natural completion of the
identity model — and **the extension point already exists in ZeroID**, so this is
not a new spec to invent:

- `domain.ProofType` already defines `tpm` alongside `oidc_token` and
  `image_hash` (`zeroid/domain/attestation.go:24`).
- `AttestationLevel` is already `software | platform | hardware`
  (`zeroid/domain/attestation.go:12`), and successful
  verification promotes `trust_level` (`unverified → verified_third_party →
  first_party`, `zeroid/domain/identity.go:38`).
- `CredentialPolicy.RequiredTrustLevel` (`zeroid/domain/credential_policy.go:60`)
  already gates credential issuance on that level.
- `zeroid/docs/attestation.md` documents a five-step recipe for adding a verifier.

So the design is: **a satellite's credential is issued only if its machine
identity attests at the required trust level**, and the federation capability set
is tiered by that level.

**⚠️ Blocking caveat.** The `tpm` proof type is **stub-only today** — the dev stub
accepts *any* proof, and `ZEROID_ALLOW_UNSAFE_DEV_STUB` currently defaults to
`true` (`zeroid/docs/attestation.md`, Operator runbook). Shipping "attested
machines" against that stub would be precisely the kind of security theater the
conductor design's R6 grilling called out. Either a real verifier lands first, or
this stays L1 below and is *described* as L1.

**The trust ladder — adopt it as a ladder, not a gate.**

| Level | Mechanism | Trust level | Buys |
| --- | --- | --- | --- |
| **L0** | config-declared `machineId`, no proof | — | the board, routing. **A phase, not a posture** — it is the F0 state, before any link exists (§13.1). |
| **L1** | per-machine ZeroID identity, key in the OS keystore | `verified_third_party` | real per-machine revocation, audit attribution, scoped credentials |
| **L2** | TPM 2.0 DevID (Linux/Hetzner) or Secure Enclave (Mac) backed key | `first_party` | proof the key cannot leave the machine |

Because federation requires ZeroID (§13.1), **L1 is the floor the moment a
satellite connects** — there is no shipping configuration in which a federated
machine lacks an identity. The "`machineId` is only a label" caveat above
therefore describes F0 only.

**Hardware reality across this specific fleet argues for the ladder.** A uniform
L2 story does not exist: the Linux boxes plausibly have TPM 2.0, a Hetzner cloud
instance may only have a vTPM, and the Mac mini has no TPM at all — its analogue
is the Secure Enclave, a different protocol. Gating federation on L2 would mean
gating it on hardware the fleet does not uniformly have.

L1 is the honest sweet spot and is worth stating plainly: it delivers the
property that actually matters day to day — *revoke a machine, and everything it
touched dies* — with no hardware dependency at all.

**Two live specs are worth tracking, and neither should be adopted wholesale:**

- [draft-liu-wimse-wit-attestation](https://www.ietf.org/archive/id/draft-liu-wimse-wit-attestation-00.html)
  carries RATS attestation evidence inside a Workload Identity Token — directly
  adjacent, since ZeroID identities already *are* WIMSE URIs. But it is
  **TEE-only** (Intel TDX defined; SEV-SNP and SGX marked TBD) and explicitly
  states that TPM and platform attestation are out of scope. It does not cover
  this fleet's hardware. Track it; do not build on it yet.
- **SPIFFE/SPIRE node attestation** is the closer conceptual match, and its
  hierarchy is already this design's hierarchy: *a node attests, receives an
  identity, and that identity is the parent of every workload on that node.*
  Substitute machine for node and session for workload and it is §5 verbatim.
  SPIRE ships a real `tpm_devid` plugin doing proof-of-possession plus
  proof-of-residency — the reference behaviour a ZeroID `tpm` verifier should
  match.

The recommendation is therefore: **borrow SPIRE's node-attestation model, land it
as a ZeroID verifier, and keep codeoid a consumer** (§13).

**The hub never holds a credential to a satellite.** Satellites authenticate
themselves, outbound. This is worth stating precisely because it bounds the blast
radius of the obvious new risk — the hub is now the highest-value host in the
system:

| If the hub is compromised, the attacker can… | …but cannot |
| --- | --- |
| read the board, cards, and digests | read raw episodes (they never left the satellites, §7) |
| enqueue dispatch tasks for any machine | execute them un-approved — R3 approval is enforced satellite-side, in the session's own `canUseTool` gate |
| impersonate the conductor to the owner | mint `tools:write` (ZeroID intersects scopes on every hop; design §4) |

R3 staying an *invariant* rather than a mode default (`isFleetSendTool`,
`fleet.ts:157`) is what makes row 2 hold. Federation is a reason to keep it
non-negotiable, not to relax it.

---

## 6. Data model — the machine axis

The change is one new dimension, applied consistently.

```sql
-- store.ts, additive (the codebase's existing #addColumnIfMissing pattern)
ALTER TABLE sessions       ADD COLUMN machine_id TEXT;  -- NULL = this daemon (pre-upgrade)
ALTER TABLE dispatch_tasks ADD COLUMN machine_id TEXT;  -- NULL = hub-local
ALTER TABLE audit_log      ADD COLUMN machine_id TEXT;

-- memory/store.ts + memory/cards.ts
ALTER TABLE episodes       ADD COLUMN machine_id TEXT;
ALTER TABLE session_cards  ADD COLUMN machine_id TEXT;

CREATE TABLE IF NOT EXISTS machines (
  id            TEXT PRIMARY KEY,   -- stable, config-declared: "laptop", "hetzner"
  label         TEXT NOT NULL,
  identity_sub  TEXT,               -- the satellite's ZeroID WIMSE URI
  role          TEXT NOT NULL,      -- 'hub' | 'satellite'
  last_seen_at  INTEGER,            -- staleness: see §9
  boot_id       TEXT,
  created_at    INTEGER NOT NULL
);
```

`machineId` is **config-declared, not auto-generated** — a hostname changes, a
reinstall must not fork a machine's history, and the owner needs to say "the
laptop" out loud to the conductor.

### The workspace key becomes two-dimensional

This is the point of the whole exercise:

| | |
| --- | --- |
| `gitAlias` (`github.com/saucam/codeoid`) | *which codebase* — same across machines |
| `machineId` (`laptop`) | *where* — the execution site |

Which makes the queries the owner actually wants expressible for the first time:

- "everything about codeoid, everywhere" → `WHERE git_alias = ?` (spans machines)
- "what's running on the Hetzner box" → `WHERE machine_id = ?`
- "the authz fix — wherever I left it" → neither; pure retrieval (§7)

Today `workspaceId` conflates these, which is why cross-machine work is not
merely absent but *inexpressible*.

### Protocol

Widen exactly one literal, and add the fields it implies:

```ts
scope: z.enum(["tenant", "machine", "account"])   // schemas.ts:372
```

`SessionInfo` and `FleetTaskWire` gain `machineId`; `FleetSnapshot` gains a
`machines: MachineWire[]` roster carrying `lastSeenAt`. Clients that ignore the
field render exactly as they do now — additive, per the protocol's own
conventions.

---

## 7. Federated retrieval — scatter-gather, not centralisation

**Decision: mirror cards to the hub; leave episodes on their machine; fan out
for deep recall.**

The hub keeps a read-only mirror of every satellite's `session_cards` + `facts`.
That alone answers the linchpin question — *"which session was the authz
`latest_only` fix?"* — because P1 built session resolution on cards, not on raw
episodes. Cards are small, already embedded, already FTS-indexed.

For deep recall (`fleet_recall`), the hub **scatters** the query to satellites,
each runs its existing local hybrid retriever, and returns top-k hits. The hub
**fuses** with RRF — the same fusion P1 already implements (build plan P1 slice
1f), just with machine as an extra source.

Three reasons this beats shipping every episode to the hub:

1. **The corpus is the moat and it is large.** 11,938 episodes on one box, with
   verbatim tool-call content. Replicating all of it over a home uplink to keep
   N copies in sync is a sync problem nobody needs to have.
2. **Retrieval already runs locally and well.** Each satellite has the embedder,
   the FTS index, and the reranker. Scatter-gather uses compute that is already
   sitting idle on each machine.
3. **Privacy has a natural boundary.** Episodes carry file contents. "Work on the
   employer's laptop is searchable *from* the hub but does not *live* on it" is a
   property worth having by construction.

**The cost is honest and must be designed for:** p95 recall is now bounded by the
slowest reachable satellite. So the fan-out carries a **deadline with partial
results** — the hub returns what it has when the deadline expires and *labels the
gap* ("laptop did not answer"). Silently returning fewer results is the failure
mode that would make the conductor untrustworthy, which is precisely what §9 is
about.

---

## 8. Federated dispatch

Almost entirely a filter change, because `dispatch.ts` was built restart-proof.

- `fleet_spawn` / `fleet_send` gain an optional `machine`. When omitted, the
  conductor infers it from the resolved target's card — a session already knows
  its machine, so "continue the authz fix" routes without the owner naming a box.
- The **R3 approval prompt gains the machine**, beside repo and branch. Routing
  to the wrong *machine* is a new wrong-target class and the prompt is where it
  gets caught.
- Each satellite's dispatcher claims `WHERE machine_id = :self AND status =
  'queued' AND (not_before IS NULL OR not_before <= :now)`. Atomic claim, stale
  reclaim, and failure-limit auto-block are unchanged.
- **Stale reclaim needs a rule it does not have today:** `claim_owner` is a boot
  id, so a satellite that goes offline mid-task leaves a claim nobody can
  reclaim without knowing whether it is dead or merely partitioned. Reclaim must
  key on the `machines.last_seen_at` heartbeat, and a reclaimed task must be
  *idempotent or re-proposed* — a half-finished `ship` re-run on another machine
  is a lost-update hazard of exactly the kind design §3 already forbids.

---

## 9. Honest limits

The conductor design earns its keep by stating what is enforced versus prompted
(§9 there). The same discipline, applied here:

| Concern | Status / mitigation |
| --- | --- |
| **A satellite is offline** | The board must render **staleness**, never a lie. `machines.last_seen_at` drives an explicit "laptop · last seen 4h ago" on every view, and recall labels the gap (§7). |
| **Clock skew** | `facts` are bi-temporal with system time (`cards.ts`). Cross-machine ordering by system time is wrong under skew. Satellites stamp with their own clock; the hub records receipt time separately and orders by receipt. |
| **Split-brain (two hubs)** | Prevented by config, not election: `role: "hub"` is declared, and a satellite refuses a second upstream. No consensus protocol, deliberately. |
| **Conductor on a satellite** | Refused at creation — `role: "conductor"` is a hub-only capability. Otherwise §2's "not one per machine" is prose, not a rule. |
| **The hub is now the highest-value host** | Bounded by §5's table. The property that carries it is R3 being enforced satellite-side. |
| **Reclaimed in-flight tasks** | Unsolved; see §8. Blocking for federated `ship` dispatch, not for the read-only board. |

---

## 10. Where learning fits — and why it comes after

The owner's question that prompted this doc bundled two asks: *reach* (this doc)
and *adaptation* ("adapts to my style"). They are different layers and the second
depends on the first.

What exists today is **episodic and declarative**: episodes + FTS + vectors +
rerank, session cards, and bi-temporal facts *about sessions*. That is retrieval.
It answers "which session was X". It does not answer "how does Yash want this
done".

What is missing is **procedural** memory — a playbook. The reference architecture
is [ACE](https://arxiv.org/abs/2510.04618) (ICLR 2026), which is the rigorous
form of what [Agno's Learning Machines](https://www.agno.com/articles/learning-machines)
sketches. ACE is worth following specifically because it names the two failure
modes that sink the naive version ("distill my sessions into a CLAUDE.md"):

- **brevity bias** — summarising away the domain detail that made the lesson useful
- **context collapse** — iterative whole-document rewriting eroding knowledge

Its fix is the part to copy: an itemised playbook of individually addressable
entries with stable ids and `helpful`/`harmful` counters; **delta edits only,
never a rewrite**; and Generator / Reflector / Curator kept separate. It adapts
from execution feedback with no labelled data.

Sketch, in this codebase's idiom:

```sql
CREATE TABLE playbook (
  id       TEXT PRIMARY KEY,   -- stable across edits: "strategies-00042"
  section  TEXT NOT NULL,      -- 'strategies' | 'mistakes' | 'conventions'
  scope    TEXT NOT NULL,      -- 'global' | 'repo:github.com/…' | 'provider:qwen'
  text     TEXT NOT NULL,
  helpful  INTEGER NOT NULL DEFAULT 0,
  harmful  INTEGER NOT NULL DEFAULT 0,
  ...
);
```

`scope` is what makes it federation-aware: entries key on `gitAlias`, so a lesson
learned about this repo on the desktop applies when the same repo is worked on
from the laptop. **That is the payoff for §6's two-dimensional key** — and it is
why the playbook comes after federation rather than before.

Two disciplines, or this becomes superstition:

1. **The Reflector is the right seat for local open weights.** It is nightly,
   batched, latency-insensitive and high-volume — the exact opposite of the
   conductor's interactive tool-selection load. `cluster-labeler.ts:258` already
   has the fallback pattern (Haiku when available, heuristic otherwise).
2. **A playbook entry that cannot be measured is a superstition.** `src/daemon/eval/`
   + `BASELINE.md` are the model: a held-out task set, A/B with the playbook on
   and off, and a retirement rule on the counters.

Existing issues this subsumes: **#49** (distill session) is this, under-specified;
**#55** (memory dreaming) is its consolidation half.

---

## 11. Prior art — and the fork this design takes

Scanned September 2026. The field has converged on *remote control of one
machine*; nobody aggregates several.

| System | What it does | Machine model |
| --- | --- | --- |
| [Happy](https://happy.engineering/) | phone + desktop control of parallel Claude Code sessions, open source, runs on your own hardware | one machine, remote-controlled |
| [Omnara](https://remote.omnara.com/) | command centre for coding agents; **migrates a session to the cloud when the laptop goes offline**, carrying agent state and uncommitted changes | one machine at a time — by *moving* |
| [Vibe Kanban](https://vibekanban.com/) | kanban board over agents, parallel/sequential orchestration, centralised MCP config | one machine |
| [Sculptor](https://imbue.com/sculptor/) (Imbue) | one Docker container per agent, syncs work back to the local repo | one machine, isolated per agent |
| [Coder Agent Relay](https://coder.com/blog/introducing-agent-relay-cloud-hosted-agents-self-hosted-execution) | cloud control plane, self-hosted execution inside a workspace; identity resolved against the org IdP | closest topology match — but enterprise workspaces, not personal machines |

**The fork this design takes, stated honestly.** Omnara answers the same user
need with the *opposite* primitive, and it deserves to be considered rather than
dismissed:

| | **A — Federate** (this doc) | **B — Centralise** (Omnara's answer) |
| --- | --- | --- |
| Where work runs | on the machine that owns the repo | on the hub; other machines are thin clients |
| Cross-machine view | aggregate N daemons | trivially — there is only one |
| Complexity | machine axis, replication, scatter-gather, reclaim | almost none |
| Fails when | a machine is offline (degrades to stale, §9) | the work genuinely belongs to a machine |

**B is simpler and should be rejected only for reasons that actually apply here
— they do.** Work is tied to specific machines for reasons a hub cannot absorb:
a Mac mini is the only host that can build and sign Apple targets; the Hetzner
box holds the corpus and the long-running jobs; a laptop holds work-in-progress
on an unpushed branch, sometimes offline. Centralising means either replicating
all of that to the hub or not doing it. Federation keeps execution where the
constraint already is.

The honest cost of choosing A: everything in §9. **The honest recommendation is
to build A but keep B's ergonomics** — a satellite that is merely *reachable*
should feel no different from a local session, which is what F1's exit criterion
is really testing.

**Nobody in the table does the three things together** — cross-machine
aggregation, cross-machine retrieval, and per-machine attested identity. The
first two are engineering. The third (§5.1) is the one no peer can reach,
because none of them has an identity layer to hang it on.

## 12. Phases

Vertical slices, same convention as the conductor plan: each ends in a working
daemon, each states how you know it is done.

| # | Phase | Ships | Depends on |
| --- | --- | --- | --- |
| **F0** | Machine axis | `machineId` everywhere, `machines` table, config — **no behaviour change** | — |
| **F1** | Satellite link + read-only board | **the aggregated view** — one board, all machines | F0 |
| **F2** | Federated retrieval | card mirror + scatter-gather recall with deadlines | F1 |
| **F3** | Federated dispatch | send/spawn to a session on another machine | F2 |
| **F4** | Machine awareness | a `machine_map` that means something; staleness UX | F1 |

**F0 — Machine axis.** Additive columns, the `machines` table, `machineId` +
`role` in config, protocol `scope` widened, `machineId` on `SessionInfo`.
Single-machine behaviour is bit-identical.
*Exit:* full test suite green with every row carrying an explicit `machineId`;
a pre-upgrade database migrates cleanly against a real `bun:sqlite`.

**F1 — Satellite link + read-only board.** Outbound WS from satellite to hub,
satellite ZeroID identity, upstream status/usage replication, heartbeat. Board
aggregation only — no dispatch, no memory.
*Exit:* `codeoid ls` on the hub shows laptop and desktop sessions with correct
status; killing the laptop's daemon marks its rows stale within one heartbeat
rather than dropping or misreporting them; and **`--local` with an upstream
configured fails at startup with the ZeroID message** (§13.1) — tested alongside
the existing local-mode refusals in `src/tests/local-mode-server.test.ts`, with
the import-graph test extended so the federation modules stay out of
`local-auth.ts`'s reach.

**F2 — Federated retrieval.** Card mirror upstream; `fleet_find` resolves across
machines; `fleet_recall` scatter-gathers with a deadline and labelled partials.
*Exit:* the P0 eval fixture, re-run with its corpus **split across two machines**,
holds its precision@1 within the margin, and p95 stays inside the design's 2s
budget with one satellite deliberately throttled.

**F3 — Federated dispatch.** `machine` on send/spawn, machine in the R3 prompt,
remote claim, heartbeat-keyed stale reclaim (§8).
*Exit:* "continue the authz fix" resolves to a laptop session from the hub
conductor, shows repo + branch + **machine** in the approval, executes on the
laptop, and returns a digest; a satellite killed mid-task does not lose or
double-execute the work.

**F4 — Machine awareness.** `machine_map` reports real per-machine topology
(workspaces, git state, load, last seen); clients render staleness.
*Exit:* "what's running where" answers correctly with one machine offline, and
says so.

**Then the playbook (§10)** — deliberately last. It needs the corpus F1–F3
generate and the `gitAlias` scope key F0 introduces.

### Where this sits against the conductor plan

Federation does **not** displace the conductor's own critical path. The honest
ordering across both plans:

1. **P5 front doors** (#279) — still first. The build plan calls this "the single
   largest gap between the feature being implemented and being usable", and the
   only door today is `codeoid attach conductor` in a terminal. Nothing here can
   be evaluated without daily use.
2. **F0 + F1** — the aggregated view. This is the ask.
3. **R6 tool scoping** (#276) — small, closes the prompt-only rows in design §9.
4. **F2 + F3**, then **routines** (P4.5) with its spend ceiling.
5. **The playbook** (§10).

---

## 13. Where this lives

Not one answer — the layers belong in different places, and conflating them is
how this acquires a dependency it should not have.

| Layer | Home | Why |
| --- | --- | --- |
| Machine axis, hub/satellite link, federated retrieval + dispatch | **codeoid** | It is a change to codeoid's own tables, protocol, and session semantics. Extracted, it would be a package that needs all of codeoid to mean anything. |
| The hub itself | **codeoid** — `role: "hub"` in config | Not a separate service. A hub is a daemon with a config flag; making it a product is how you end up maintaining two daemons. |
| TPM / Secure Enclave verifier | **ZeroID** | Already its documented extension point (`zeroid/docs/attestation.md`, "Adding a new verifier"). Benefits every Highflame product, and codeoid has no business implementing attestation crypto. |
| Playbook / ACE learning (§10) | **codeoid**, `src/daemon/memory/` | Its input is the episode corpus, which only codeoid has. |

So: **one new doc, no new repo.** The only cross-repo work is a ZeroID verifier,
which is a contribution to an existing project rather than a new one.

### 13.1 Federation requires ZeroID — and is refused under `--local`

**Decision (2026-09-05): federation is a ZeroID-mode feature.** Local mode does
not federate, and says so.

This is not a deferral dressed as a decision — it removes a whole class of design
work. A local-mode fallback would need machine identity without an issuer, which
means self-asserted machine labels, a bespoke satellite-pairing secret, and a
second revocation story. All of that to support a posture whose own doc calls it
"deliberately degraded" and scopes to one machine.

**The precedent is exact, and it is Telegram.** [local-mode.md](./local-mode.md)
already refuses the Telegram frontend under `--local`, with reasoning that
transfers almost verbatim:

> Telegram is reached *through Telegram's servers* — a remote surface. Local
> mode's trust model is "whoever can read a `0600` file on this machine."
> Pairing them would let a locally-minted token stand in for a verified identity
> over the public internet.

Federation is the same shape: a link *between machines* is a remote surface, and
a token minted from a `0600` file on the laptop must not stand in for a verified
identity to the hub. Local mode's own bind guard already routes this case —
*"need it remote: use ZeroID auth (codeoid login) — real identities, revocable
tokens."* Federation is the archetypal remote case.

The tenant model independently forces the same answer: local-mode sessions live
in the reserved `local` / `local` tenant behind a documented one-way door. A
federated board aggregating several machines' `local/local` tenants would be
merging buckets that are, by design, not the same tenant.

**How it is refused — the mechanism matters more than the decision.** Follow the
existing invariant, which review is instructed to enforce:

> Local mode is a **second implementation of one function**, never a conditional
> inside the verified path. **Reject in review:** any `if (localMode) …` branch
> inside a scope check, the handshake, an audit write, or any other enforcement
> site.

So federation is refused **at construction, once**, exactly where Telegram is:

- `--local` + a configured upstream or `role: "hub"` → the daemon **fails at
  startup** with a message naming `codeoid login` as the fix, in the style of the
  existing bind guard. Loudly, not as a confusing connect timeout.
- The CLI declines to register the federation subsystem under `--local`, the way
  it declines Telegram.
- `authMode` is already on the wire and in `GET /config`, so clients can grey the
  fleet-board machine roster without asking.
- **No `if (localMode)` anywhere in the replication, claim, or recall paths.**
  They are only ever constructed in ZeroID mode.

### 13.2 What this buys, and what it costs

**Buys — the L0 tier disappears from the trust ladder.** §5.1's L0 stops being a
deployment posture and becomes merely *the state during F0*, before any link
exists. Once a satellite connects, **L1 is the floor**: every machine has a real
ZeroID identity, unconditionally. That is a strictly stronger starting position
than the ladder originally assumed, and it settles several open items:

- `machineId` is no longer only a label — it is bound to an identity from the
  first federated deployment (§5.1's caveat about labels applies only to F0).
- Machine revocation is just identity revocation. No separate deregistration
  flow, no orphan-machine cleanup.
- Open question 3 (`fleet:replicate`) is now plainly a ZeroID scope, added to the
  vocabulary the way `fleet:read` already was.

**Costs — name them rather than discover them.**

1. **Federation becomes a Highflame-tier capability.** An OSS user running
   `--local` gets everything in local-mode's "what you keep" table but cannot
   federate. That is a positioning claim as much as a technical one and belongs
   in [POSITIONING.md](./POSITIONING.md) and local-mode's "what you give up"
   list, not only here.
2. **A new availability dependency — bounded, but real.** Codeoid verifies ZeroID
   JWTs against **local JWKS**, so a satellite holding a valid, unexpired token
   can reconnect to the hub while ZeroID itself is unreachable. What it cannot do
   is *mint* a new token. So a ZeroID outage degrades federation on the timescale
   of credential lifetime, not instantly — which makes credential lifetime an
   operational parameter worth choosing deliberately rather than inheriting.

## 14. How the hub view renders

Nothing draws the fleet board today. `fleet.subscribe` → `fleet.snapshot.result`
→ `fleet.update` shipped in P5.0, but a search of `web/src/` and
`src/frontends/` finds **no consumer of `FleetSnapshot`** — conductor-design §7
says so plainly, and it is still true. So this section is a design, not a
description, and it is the reason P5 sequences ahead of federation.

### 14.1 Machine is a badge and a filter — not the grouping

The tempting layout is to group the session list by machine. **Reject it.** The
list is deliberately ordered *by attention, not by creation* (commit `c98755f`),
and grouping by machine would destroy that ordering — you would scan four
machine headers to find the one session that needs you.

The mental model is also wrong. You think "the authz fix", not "the laptop". The
machine is a *property* of the work, the way branch and provider already are —
so it renders the way those do:

- **A chip on every row** — `laptop · feat/authz · opus`. Present, scannable,
  not structural.
- **A filter**, not a grouping — a segmented control or a `machine:laptop`
  search term narrowing the existing attention-ordered list.
- **Attention ordering absorbs offline naturally.** Sessions on an unreachable
  machine are not actionable, so they sort down on their own. No special case.

Machine *grouping* stays available as a toggle for the one question where it is
the right shape — "what is this box doing?" — which is `machine_map`'s job (F4),
not the session list's.

### 14.2 Follow `groupFleet`'s pattern exactly

`web/src/lib/fleet.ts` already solves the structurally identical problem one
level down: turning a flat `SessionInfo[]` into orchestrator + role-children. Its
three properties are the ones the machine layer needs, and they are worth copying
rather than re-deriving:

1. **A pure function, no Solid.** *"Grouping is the part worth testing, and the
   tests shouldn't need a reactive root to run."* A `groupByMachine()` beside
   `groupFleet()` gets the same treatment.
2. **Uniform shape, so the renderer never branches.** `groupFleet` makes a
   standalone session "a group of one" precisely so the renderer has no
   `is this a fleet` check. A single-machine deployment must likewise render as
   one machine, not as a special case — which is also what keeps the
   non-federated path from bit-rotting.
3. **Never drop an orphan.** `groupFleet` promotes a child whose parent is absent
   rather than hiding it, because *"a session that silently disappears from the
   sidebar is a far worse failure than one rendered without its group."* Exactly
   the same rule applies to a session whose machine is not in the roster yet:
   render it, attributed to an unknown machine.

### 14.3 Staleness is the hard part, not the layout

§9's rule — *the board must render staleness, never a lie* — is a rendering
requirement above all, and it is where a naive implementation fails. A session
that was `running` when its machine went dark **must not keep rendering as
running**. That is the single most damaging thing the hub view could do, because
it is indistinguishable from progress.

Three machine states, and they are machine-level, not session-level:

| State | Trigger | Renders as |
| --- | --- | --- |
| **live** | heartbeat current | normal |
| **stale** | heartbeat missed, within grace | rows dimmed, statuses **frozen with an "as of" time**, no spinners |
| **offline** | past grace, or identity revoked | rows dimmed and collapsed under an explicit "laptop — offline, last seen 4h ago" |

The invariant: **a status is only ever rendered live if the machine reporting it
is live.** Freezing is honest; a spinner on a dead machine is not.

The same rule governs recall. §7's scatter-gather returns partial results when a
satellite misses the deadline, and the UI must *say* "laptop did not answer"
rather than quietly showing fewer hits — a silently short result list is
indistinguishable from a confident empty answer.

### 14.4 Where it surfaces

| Surface | Change |
| --- | --- |
| `SessionListPane.tsx` | machine chip per row; machine filter; offline rows dimmed |
| `StatusBar.tsx` | fleet health — `4 machines · 1 stale`; the degraded indicator |
| **Machine roster** (new, small) | one row per machine: label, trust level (§5.1), last seen, session count. The only genuinely new panel. |
| Conductor pane | unchanged — the conductor answers in prose; machine rides in `fleet_find` results |
| **R3 approval prompt** | **machine shown beside repo and branch** (§8). Not cosmetic: routing to the wrong machine is a new wrong-target class, and this is where it gets caught. |
| TUI | same model; the Rust protocol crate already mirrors the board types |

The mobile app inherits all of it by attaching to the conductor session — the
conductor needs zero new wire types, which the mobile plan already established.

## 15. Open questions

1. **Does the hub run sessions of its own, or only the conductor?** A dedicated
   hub is simpler to reason about; the Hetzner box is currently also the biggest
   worker. Mixed-role hubs make §9's blast-radius table weaker.
2. **What is replicated on reconnect after a long partition?** Full card resync
   is simple and probably fine at this scale, but it is unmeasured.
3. ~~**Is `fleet:read` sufficient for a satellite?**~~ **Resolved** by §13.1: a
   satellite *writes* to the hub's mirror, which `fleet:read` does not cover, and
   since federation is ZeroID-only there is no non-ZeroID case to design around.
   Add `fleet:replicate` to the scope vocabulary as `fleet:read` was — and note
   issue **#111** already tracks growing that vocabulary for sensitive verbs.
4. **Does the mobile app talk to the hub only?** ([mobile-app-design.md](./mobile-app-design.md))
   Almost certainly yes — but then the hub is a hard availability dependency for
   the phone, which the single-machine design never had.
5. **Reclaim semantics for an in-flight `ship`** (§8). Blocking for F3.
6. **Does `machineId` belong in the tenancy key?** Today tenancy is
   `(account, project)`. Adding machine would isolate machines by construction —
   and would also break the cross-machine queries §6 exists to enable. Current
   call: machine is an *attribute*, not a tenant.
7. **Should a satellite be able to run a conductor when the hub is unreachable?**
   A degraded local conductor is attractive for a laptop on a plane and is
   directly at odds with §2's singularity. Probably no; worth deciding
   deliberately rather than by omission.
8. **What is the real trust level of a Mac mini?** (§5.1) It has no TPM, so L2
   means a Secure Enclave path — a different protocol, a different verifier, and
   possibly Apple-account-bound in ways that do not fit a `tpm` proof type at
   all. Either ZeroID grows a fourth proof type or the Mac stays L1 permanently.
   The second is acceptable; it should be a decision, not a discovery.
9. **Does a machine's trust level gate capabilities, or only get recorded?**
   `RequiredTrustLevel` makes "only an L2 machine may run `ship` dispatch"
   expressible. It is also the kind of rule that turns a dead TPM into an outage
   on a Sunday. Recommend: record at L1, gate nothing, until there is a second
   user.
10. **Attestation freshness.** An attestation is point-in-time; a satellite
    stays connected for weeks. Re-attestation cadence is unspecified, and the
    WIMSE draft explicitly punts on it (short token lifetimes + DPoP, no nonce).
    Tie it to credential expiry rather than inventing a heartbeat proof.
