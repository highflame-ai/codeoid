# Codeoid Conductor — Design Proposal

> Status: **DRAFT for grilling** · Author: design session 2026-06-30
> Revised 2026-08-05: capability reframe (see [Decisions locked](#decisions-locked-from-grilling), R6).
> Goal: turn codeoid into a locally-running "master of my machine" personal
> assistant — one that takes natural-language instructions, controls and inspects
> every Claude/Gemini/codeoid session, remembers all threads of work, browses the
> web, and acts on the owner's behalf (email, etc.) — **without going out of
> context** and **without leaving the identity-native model.**

---

## 1. Goal & non-goals

**Goal.** A persistent, always-on *conductor* — the owner's assistant, running as a codeoid session.
It converses, answers questions about the owner's work and machine, fetches information, runs recurring tasks unattended, and **commands a fleet of coding sessions**.

**The fleet is one capability among several, not the definition of the conductor.**
Creating, resolving, and directing sessions is how the conductor gets *coding work* done — the way `WebFetch` is how it gets *information*.
An earlier draft of this document treated fleet supervision as the conductor's whole contract; that framing is superseded by R6 below, and §5 now enumerates the full capability surface.

**Non-goals.**
- Not a rewrite. The conductor is a thin layer over the existing
  `SessionManager` / `Session` / `AgentIdentityManager` primitives.
- **Not a coding agent inside repos.** Not because it lacks the capability — it has write tools today — but because of context economics (§2) and multi-writer safety (R6).
  Work in a repo goes to a session that owns that repo.
- **No OpenClaw runtime integration.** We borrow *ideas and code* from OpenClaw
  (channel adapters, skill/file conventions, scheduling) and reimplement them
  native to codeoid. We do not run OpenClaw as a sidecar. (See §10.)
- Not identity-optional. Every conductor action, and every action it delegates,
  is attributed to a ZeroID identity with a verifiable delegation chain. This is
  the whole point of building it *in codeoid* rather than in OpenClaw.

---

## Decisions locked (from grilling)

- **Authority = owner-delegated privileged agent.** The conductor is its own
  ZeroID agent identity; the owner delegates `session:*` to it; children are
  further delegations. One verifiable tree, one revocation root. Verified against
  `zeroid`: `delegation_depth` is a JWT claim, graph cap = 10, per-identity
  `max_delegation_depth` policy must be ≥3, and `handleMessage` gates on scope
  *membership* regardless of subject type — so an agent token carrying `session:*`
  passes the same gate a human does. (Grill R1)
- **Identity durability = durable conductor, disposable children.** Persist only
  the conductor's identity (survives restarts → one stable WIMSE URI for weeks).
  Conductor-spawned children are per-task workers that die with the turn. One
  credential at rest. (Grill R2)
- **Primary mode = coordinate the EXISTING session population.** The owner talks
  only to the conductor and directs it to act *in existing sessions*. Two session
  classes: (a) long-lived, user-owned sessions the conductor observes + directs;
  (b) disposable conductor-spawned workers. This makes cross-workspace **session
  tracking** (§6) the linchpin capability. (User refinement)
- **Routing safety = confirm before side-effecting acts.** `find`/`summary`/`recall`
  run silently; any send-class action to an existing user-owned session first
  proposes it with **repo + branch + content shown** and acts only on confirm.
  Near-zero wrong-repo risk. (Grill R3)
  *Generalized by R6:* the rule is no longer specific to the four fleet send verbs.
  Every mounted capability declares which of its verbs are side-effecting, and that set is never auto-approved — in any session mode, under any tool budget.
  The fleet's `send`/`spawn`/`interrupt`/`panel` remain the canonical example.
- **Egress trust (v1) = owner approval only, no Shield.** Send-class egress
  (`email.send`, external HTTP, outbound shell) is gated by owner approval via the
  existing `approvalId` flow, showing recipient + subject + body preview so
  approval is informed. Shield-like inspection is a deliberate *later* integration
  — the assistant must not depend on the local stack being up. (Grill R4 + owner
  follow-up)
- **Cost guard (v1) = metrics only.** No hard token budget or loop cap in v1; the
  event-driven idle model keeps it cheap and the existing metrics UI
  (tokens/cost/turns) gives visibility. A cheap per-instruction bounce cap is a
  low-cost later toggle; hard budgets ship with the Shield-era governance.
  (Grill R5)
  *Amended:* metrics-only holds while every turn is owner-initiated.
  **Unattended routines are the trigger for a hard ceiling**, not the Shield era — a scheduled job with dispatch authority can spend money with nobody watching, so the spend cap and bounce cap are prerequisites of routines shipping, not follow-ups.
- **Capability scoping replaces read-only-by-construction.** (R6 — 2026-08-05)
  The conductor's tool surface is **scoped, not denied**: side-effecting verbs are gated or path-limited per capability, and the conductor is kept out of repos rather than kept away from tools.
  This supersedes the earlier "read-only over targets, by construction" framing, which the implementation never actually delivered.
  See §5 for the capability surface and §9 for what is enforced versus prompted.

---

## 2. The core principle — why it never goes out of context

A "master agent" fails the moment it tries to *do everything in one growing
context*. The conductor is built on three rules, all of which codeoid already
supports:

1. **The conductor holds an index, not transcripts.** It never ingests a child
   session's full output. Children return a *summary* (the existing memory /
   saliency-compression path — `buildMemoryMcpServer`, saar/extraction work in
   codeoid#39). The conductor's own context is: current instruction + a thin
   fleet index (session names, states, last-summary-per-thread) pulled on demand
   via tools.

2. **State lives in the daemon, not the conversation.** "Remember every thread"
   is a *query against durable state* (SQLite `store.ts` + the memory engine),
   not memory held in a chat. Codeoid already owns this: "sessions are
   daemon-owned; clients are stateless" (`CLAUDE.md`). The conductor is just
   another daemon-owned, resumable session.

3. **Long-running = resumable + event-driven, not one infinite turn.** The
   conductor wakes on an event (a child finished, a Telegram message, a cron
   tick), rehydrates from durable state, acts, and goes idle. Codeoid's
   `resumeSessions()` + transcript persistence make the conductor itself
   crash-proof and restartable. When its own context approaches the window, it
   self-summarizes into the fleet index and continues — the same compaction
   codeoid already does per session.

The net: the conductor's working set is **O(active threads)**, not
O(total history). That is the structural answer to "doesn't go out of context."

---

## 3. Where it sits in codeoid

Three additions, no architectural change:

| Addition | What it is | Mirrors existing |
| --- | --- | --- |
| **Conductor session role** | A `Session` created with `role: "conductor"` — same `query()` loop, a composed system prompt (§5), and a set of mounted capability servers. | normal `Session` |
| **`codeoid_fleet` MCP server** | Fleet tools (list / find / summarize / recall / tasks / machine_map, plus the send-class verbs). Today an in-process Agent-SDK object bound to the conductor; **becoming a mountable server** (#245) so it sits in the registry beside every other capability. | `memory/mcp-http.ts`, `blackboard/mcp-http.ts` |
| **Conductor identity grant** | The conductor's ZeroID agent identity additionally holds `session:*` scopes, so it can drive the fleet *as a first-class delegated authority* (see §4). | `AgentIdentityManager.registerSessionAgent` |

Injection point is already there: the Claude provider merges `codeoid_memory` into the
`mcpServers` passed to `query()`. The conductor adds `codeoid_fleet` the same way,
gated on `role === "conductor"`. *(Implemented in P3:* the manager builds the
fleet server — its tools close over the live, tenant-scoped session population —
and passes it to the conductor's `Session`; the Claude provider's `allowedTools`
is widened with `mcp__codeoid_fleet__*` when a fleet server is present, and the
system-prompt append path no longer gates on memory so the conductor contract
rides the `claude_code` preset.*)*

**Dispatch behind approval (P4).**
The fleet read surface (`fleet_list` / `fleet_find` / `fleet_summary` / `fleet_recall` /
`fleet_tasks` / `machine_map`) runs silently. The send surface
(`fleet_send` / `fleet_spawn` / `fleet_interrupt` / `fleet_panel`) is kept OUT of the
provider's `allowedTools` AND hard-blocked from auto-approval in every session
mode — each dispatch rides the existing `approvalId` flow with the full tool
input shown to the owner (R3 as an invariant, not a mode default). Approved
dispatches execute through a durable SQLite work queue (`dispatch.ts`): atomic
claims, boot-id stale reclaim, exponential retry backoff, failure-limit
auto-block (the stuck-loop guard), and a per-tenant worker cap. Spawned workers
are disposable `role:"worker"` sessions with shape-capped LEAF identities
(scouts hold no `tools:write`; no worker ever holds `session:*`), an autonomous
tool budget, and completion digests that flow back as batched, daemon-injected
`<fleet_events>` turns — never raw transcripts.

**The conductor is NOT read-only over targets, and never was.** (R6)
An earlier revision of this section claimed read-only-by-construction, on the grounds that the conductor identity holds only `session:read`/`session:dispatch` and never `tools:write`/`tools:execute`.
The identity claim is true. The conclusion drawn from it is not, for three reasons the implementation makes plain:

1. **ZeroID scopes do not gate the conductor's local tool surface.** `#createConductor` builds a plain provider session with no capability role and no `disallowedTools`; `allowedTools` is a *pre-approval* list, not a restriction.
   The conductor therefore holds the backend's full default toolset — `Write`, `Edit`, `Bash`, `WebFetch` — behind nothing but the `canUseTool` approval prompt.
2. **`write: false` would not close it either.** `roleDeniesTool` checks `WRITE_TOOLS`, which is `Write`/`Edit`/`MultiEdit`/`NotebookEdit` — **`Bash` is deliberately excluded**, and `tool-safety.ts` says so outright: `>`, `tee`, `sed -i`, and `git apply` remain, restrained only by the role's system-prompt contract until a real sandbox exists.
3. **Transitive write is a designed feature.** `shape` maps directly onto the write bit (`shape: role.write ? "ship" : "scout"`), and `WORKER_SCOPE_PROFILES.ship` carries `tools:write`, so an approved `fleet_spawn(shape: "ship")` puts unrestricted write into any workdir the conductor names.
   The identity model is careful about *how*: because ZeroID intersects scopes on every RFC 8693 hop and the conductor holds no `tools:write`, a chain rooted at the conductor can never carry it — so a ship worker's token is issued as a **root grant sanctioned by the owner's approval**, deliberately outside the delegation chain, with `created_by` still recording the conductor for audit lineage.
   That distinction is real and worth keeping: the conductor cannot *mint* mutation authority. But it can *ask for it and receive it on demand*, which means denying the conductor `Edit` removes a hop, not authority.

So the security framing was theater. The two arguments that survive are different ones, and they are the ones this design now rests on:

- **Context economics (§2).** Every direct action spends context the conductor cannot get back, and its whole value is staying O(active threads) without compacting.
  Note that **`Read` threatens this more than `Edit` does**: `Read` is in `SAFE_TOOLS` and auto-approves, so the conductor can silently pull a 2,000-line file into the one context that must stay small.
- **Multi-writer correctness.** Sessions hold live git worktrees. A conductor editing a repo a running session owns is a lost-update hazard — and a checkable one, since `fleet_list` already knows every session's workdir and worktree.

**The rule, therefore, is scope — not capability:**

| Where | Posture |
| --- | --- |
| `~/.codeoid-conductor` (its own workdir — already created as a dedicated empty non-repo, non-`$HOME` directory) | write **auto-approved**. Notes, digests, routine output, scratch state — no prompts. |
| Anywhere else outside a git repo | write **approval-gated** (today's default, now intentional). Keeps "fix this one line" available without paying for a spawn. |
| Inside a git repo | write **never auto-approved**; **hard-denied** where a live session holds that repo's worktree. |
| `Bash` inside a repo | **denied.** If exactly one hard denial is affordable, this is it — `Bash` is what defeats every path scope above. |

And the delegation rule the system prompt should carry is **cost-based, not capability-based**: when the overhead of delegating (session + identity mint + model call + digest round-trip) exceeds the context cost of acting inline, act inline.
A three-line note is inline. A refactor is not.

**Provider-agnostic conductor.** Which backend drives the conductor is
`config.conductor.provider` — any registered provider id, so an open-weight
backend can run it once its provider exists. Caveat: the fleet server is an
in-process Claude-SDK object, so a conductor on another provider chats but
cannot see the fleet (the daemon logs this).
Making that surface **mountable** (issue #245) is the keystone of this reframe, not merely a backend-compatibility fix: a mounted fleet is what turns "the conductor's contract" into "one capability the conductor has", alongside memory, notes, and everything in §5.

---

## 4. Identity model — the crux

Today there are **two disjoint scope namespaces**:

- **Protocol scopes** (`protocol/scopes.ts`): `session:create|list|send|attach|
  watch|interrupt|approve|destroy`, `fs:read`. Held by **human/client** tokens.
  Enforced per inbound message in `SessionManager.handleMessage`.
- **Agent tool scopes** (`agent-identity.ts`): `tools:read|write|execute|agent`.
  Held by **agent** identities, delegated to sub-agents via RFC 8693
  (`tokens.delegate`, actor assertion, `act` chain, `delegation_depth`, scope
  intersection enforced by ZeroID).

The conductor blurs these: it is an **agent** that must exercise **`session:*`**
(a capability the model reserves for human clients). The proposed resolution —
which keeps everything identity-native:

**The conductor is a privileged agent whose authority is *delegated from the human
owner*, and every session it spawns is a further delegation.** The chain becomes:

```
human owner (ZeroID sub, IdP-verified)
  └─ delegate session:list,create,send,watch,interrupt  →  CONDUCTOR agent
        └─ delegate (per spawn)                          →  child session agent
              └─ delegate (attenuated)                   →  child sub-agents
```

Concretely:
- The conductor gets its own identity scope profile (`CONDUCTOR_SCOPES` in
  `agent-identity.ts`: `session:read` + `session:dispatch`, both protocol
  scopes) — deliberately **separate from** `AGENT_TOOL_SCOPES`, keeping the two
  namespaces disjoint, and deliberately excluding `tools:write`/`tools:execute`.
  The conductor's token is minted by delegation from the owner, not handed the
  owner's own token. *(Implemented in P2.)*
  **Scope note (R6) — read this limit precisely, or the audit story overclaims.**
  Withholding `tools:write` means exactly one thing: **the conductor cannot mint
  mutation authority by delegation**, because ZeroID intersects scopes on every
  RFC 8693 hop (`WORKER_SCOPE_PROFILES` documents this, and it is why a ship
  worker's token is a root grant rather than a conductor delegation). It does
  *not* bound the conductor session's own tool surface, which the provider grants
  independently of any ZeroID scope (§3), and it does not stop the conductor from
  requesting write authority for a worker and receiving it on owner approval.
  "Cannot mint" is the true claim. "Read-only subtree" is not.
- When the conductor spawns a child, the child's `created_by` is the
  **conductor's WIMSE URI**, and the child's token is `tokens.delegate`-d from the
  conductor — so `delegation_depth` increments (human=0 → conductor=1 → child=2 →
  sub-agent=3) and the `act` chain is fully verifiable.
- **Cascading revocation already does the right thing**: deactivate the conductor
  → every child + sub-agent token it minted dies by construction
  (`deactivateSessionAgent` cascades). Kill-switch for the whole fleet = revoke
  one identity.
- Each fleet tool call is audited under the conductor's WIMSE URI
  (`store.audit`), so "what did my assistant do at 3am" is a SQL query.

This is the identity-native payoff OpenClaw structurally cannot match: the master
agent and everything it touches sit on one verifiable delegation tree with one
revocation root.

---

## 5. The conductor's capability surface

The conductor is an assistant with **capabilities**, each mounted independently.
Fleet is the largest and the only one welded on today; the rest are the reason the reframe matters.

| Capability | What it buys the owner | State |
| --- | --- | --- |
| **fleet** (§5.1) | dispatch coding work to sessions and disposable workers | shipped — 6 read verbs + 4 send verbs |
| **memory** | recall across every session and workspace ("what was I doing in studio last week") | shipped — `memoryMcp` is already mounted on the conductor |
| **notes / scratch** | durable notes, digests, routine output in its own workdir | unblocked by R6; needs the auto-approve entry |
| **web** | `WebSearch` / `WebFetch` for ad-hoc questions | present, but prompts on every call — see below |
| **routines** | create, list, and cancel scheduled or triggered jobs | **missing** |
| **mounted MCP servers** | github, slack, calendar, whatever the owner registers | already possible via `mcpRegistry` / `mcpHub` |

Three consequences follow, and all three are architectural rather than cosmetic.

**The system prompt must be composed, not monolithic.**
`CONDUCTOR_SYSTEM_PROMPT_APPEND` currently lives in `fleet.ts`, with a comment saying the fleet tools "define the conductor's whole contract".
Under this reframe that is backwards: the prompt is an identity preamble plus one section contributed per *mounted* capability.
Composed also means **absent when unmounted** — this is not tidiness.
A model told about tools it does not have will hallucinate calls to them, and a small open-weight backend (the reason `config.conductor.provider` exists) does so far more readily than a frontier model.

**Read-only classification must be registry-driven.**
`isSafeTool` hardcodes `MEMORY_TOOL_PREFIXES` and `BLACKBOARD_TOOL_PREFIXES`, each with an explicit per-tool allowlist.
Every new capability means editing that file — and since an over-broad match there is a prompt bypass, it is the last place to keep a growing hand-maintained list.
Each capability should **declare** its read-only verbs; `tool-safety.ts` keeps validating exact names rather than server prefixes, so the fail-safe (unknown tool → prompt) is preserved.
With one capability this is over-engineering; with six it is the difference between adding a capability being a config change and being a security review.

**The mount contract — this is where the architecture pays off.**
Declaring verbs is not paperwork; it is the *exchange*. A capability declares its
read-only verbs and its side-effecting verbs at mount time, and in return the
daemon stamps every call it makes with identity attribution, an audit row, the
correct approval classification, and episodic capture. Mandatory in both
directions: a capability that declines to declare gets no auto-approval (fail
safe), and a capability that declares gets governance it did not have to build.

Declared-but-**validated**, never declared-and-trusted (open question #11) — the
registry supplies the list; `tool-safety.ts` still matches exact names, because an
over-broad match is a prompt bypass no matter who authored it.

That exchange is the difference between codeoid's registry and the plugin systems
every peer already ships. A plugin mounted elsewhere inherits nothing; a capability
mounted here inherits the whole substrate. The registry is not the moat — it is
how the moat reaches third-party code.

**Web reads should auto-approve.**
An always-on assistant that raises an approval prompt on every `WebFetch` is not an assistant.
`WebSearch`/`WebFetch` are read-only fetches (`NETWORK_TOOLS` already treats them as such) and belong in the conductor's auto-approved set, unlike anything in §8's send-class egress.

### 5.1 Fleet

In-process MCP tools (closure-bound to the conductor's auth + the
`SessionManager`), each gated on a `session:*` scope the conductor holds:

| Tool | Maps to | Scope |
| --- | --- | --- |
| `fleet_list` | `SessionManager` list path | `session:list` |
| `fleet_spawn(name, workdir, backend, brief)` | session create + delegated identity | `session:create` |
| `fleet_send(name, message)` | session send (async) | `session:send` |
| `fleet_summary(name)` | pull *compressed* latest state, not raw scrollback | `session:watch` |
| `fleet_interrupt(name)` | interrupt | `session:interrupt` |
| `fleet_find(query)` | resolve an NL reference → ranked session card(s) (see §6) | `session:list` |
| `fleet_recall(query)` | **cross-workspace** episode recall (see §6) | `session:list` |
| `machine_map()` | enumerate workspaces + git/running state (see §6) | `session:list` |
| `fleet_destroy(name)` | destroy | `session:destroy` (off by default) |

Key discipline: `fleet_send` is **fire-and-forget**; results come back as *events*
(§7), and `fleet_summary` returns a compressed digest. The conductor never slurps
a child transcript into its own window.

**Multi-backend.** `backend` selects Claude (native `query()`) or, via the
existing `anyagent` adapter (`.claude/` → Codex/Gemini/Hermes), a Gemini/Codex
child. The child is still a codeoid `Session` with its own ZeroID identity — so
"control a Gemini session" stays identity-native too.
`fleet_spawn` takes `provider` + `model` today, so the conductor can already pick Opus, Fable, or Codex per task.

**Gap — the conductor cannot start a collaboration.**
`fleet_spawn` creates a single worker.
Collaborative sessions (goal + role→backend bindings + panels, `collaboration.ts`) are the natural target for a complex task the conductor decides to fan out, and there is no verb for it.
Adding one is send-class by definition and rides the same R3 approval prompt, carrying the goal's cost roll-up the way `fleet_panel` already does.

---

## 6. Session tracking & recall — the core capability

This is the linchpin, not a side feature. Because the owner only ever talks to the
conductor, the conductor must resolve a *fuzzy natural-language reference* ("the
session where I was fixing the authz `latest_only` bug", "studio#870", "the durga
extraction eval") to the *right* session across every workspace on the machine —
and it must be right, because routing a command to the wrong repo's session is
harmful.

**Codeoid already has the right foundation.** The memory engine
(`memory/engine.ts`) is a hybrid retriever — its `RecallHit` carries
`components.{vector, fts, recency, pathOverlap}`, i.e. semantic (embeddings) **and**
keyword (SQLite FTS5) **and** recency **and** path-overlap, already blended. And
`IndexScheduler` + `buildWorkspaceIndex` already refresh indexes on a schedule.
Three extensions turn this into fleet-wide *session* tracking:

1. **Session-granular "cards" (new).** Per session, a durable card:
   `{ name, workspace/repo, workdir, branch, created, last_active, status, rolling
   summary of current work, salient entities (files, symbols, ticket ids, branch
   names) }`. Embed the card (semantic) and FTS-index its text (keyword). Retrieval
   returns *sessions*, not raw episodes.
2. **Cross-workspace scope.** Today `recall()` is bound to one `workspaceId` and
   excludes the current session. Add an `ALL`-workspace mode so the conductor
   searches the whole machine.
3. **Continuous cheap summarization.** Cards stay fresh via the saliency/extraction
   path (saar / codeoid#39) riding on `IndexScheduler` — the same investment that
   keeps the conductor's own context small keeps the cards current.

**Why keyword matters as much as semantic (your point).** Embeddings are weak on
exact identifiers — `studio#870`, `latest_only`, a branch name, a file path. FTS
nails those; embeddings nail "the session where I was frustrated with flaky auth".
The hybrid is what makes *both* queries land — which is exactly why we extend
codeoid's existing blended scorer rather than bolt on a pure vector store.

**What is and is not differentiated here — state this honestly.**
The *ranker* is commodity. Bi-temporal validity intervals, hybrid dense + sparse +
graph retrieval, RRF/MMR fusion, and cross-encoder reranking are shipped, published,
and benchmarked by Zep/Graphiti (P95 ~300 ms, no LLM on the retrieval path). Framing
that stack as codeoid's moat invites a comparison codeoid loses, and hand-rolling it
is months of work to reach library parity.

Two things *are* differentiated, and both are downstream of the native-protocol
provider layer rather than of the ranker:

1. **The corpus.** Verbatim, tool-call-granular coding episodes with file paths,
   worktree-anchored, tenant-scoped, captured with no external service. A memory
   layer that ingests text cannot produce it, because it never sees a tool call.
   This is why the file co-occurrence graph and the session-session topology graph
   are the highest-value retrieval work and also the work no peer can copy.
2. **The task.** "Fuzzy human reference → the right session across N workspaces" is
   not fact recall, and no incumbent publishes a number for it. The P0 labeled
   fixture measures something the field does not benchmark, which makes it a
   publishable result rather than only an internal gate.

So: invest in retrieval, and position the *corpus and the task*, never the ranker.

**Machine awareness.** A `machine_map` tool enumerates workspaces (repos under the
root), each session's workdir + git branch/status + running state — so the
conductor has "knowledge of the machine", not just of sessions.

**Cross-ownership.** Because the conductor's authority is *delegated from the owner*
(§4), it operates within the owner's tenancy and can therefore see + drive the
owner's own pre-existing sessions — not only ones it spawned. `getOwnedSession`
resolves against the owner's tenancy, so no ownership hack is needed.

---

## 7. Front door & wake model

- **Front door:** reuse the existing **Telegram frontend** (`frontends/telegram/`,
  embedded, direct `SessionManager` access). The owner DMs the bot; the message is
  routed to the conductor session. No new channel needed for v1. (Web UI cockpit
  remains the visual view.)
  **Status: the contract is built; the surfaces are not.** [conductor-frontends-design.md](./conductor-frontends-design.md) specifies both.
  **P5.0 has landed**: `fleet.subscribe` → `fleet.snapshot.result` + streamed `fleet.update`, gated on the new `fleet:read` scope, advertised as the `fleet.board` capability, and mirrored in the Rust `codeoid-protocol` crate (which also gained the `SessionInfo.role` field it was missing).
  Clients can now read and follow the board — but **no client draws it yet** (P5.1–P5.4): Telegram has no conductor routing and the web UI has no conductor pane, so the only front door today is still `codeoid attach conductor` in a terminal.
  This remains the single largest gap between "the feature is implemented" and "the feature is usable", and it is also what generates the usage the rest of the design assumes.
- **Wake model:** the conductor is event-driven. Wake sources:
  1. owner message (Telegram/Web),
  2. child-session completion (daemon emits an event → conductor turn),
  3. scheduled tick (a native cron, borrowed from OpenClaw's scheduler concept).
  Only (2) exists today, as the `<fleet_events>` injection.
- **"Always on" is not yet true.** The conductor is created lazily on the first `session.create` with `role: "conductor"` — durable and resumable once created, but there is no boot-time ensure and no heartbeat.
- **Routines need tools, not just a scheduler.** A daemon-side cron with file-defined jobs is not an assistant you talk to.
  "Every morning check my PRs and tell me what's stuck" has to be expressible in conversation, which makes routines a *capability* (§5) with create/list/cancel verbs, not only a subsystem.
- **No busy-poll.** Between events the conductor session is idle (no tokens
  burned). This is both the cost story and the never-OOC story.

---

## 8. Acting on the owner's behalf (email, web, etc.)

- **Web lookup:** the conductor holds `WebSearch`/`WebFetch` directly and should use them directly for an ad-hoc question, per the cost-based rule in §3 — spawning a child to answer "what's the current Bun LTS" costs a session, an identity mint, and a digest round-trip to save a few hundred tokens of context.
  Delegate research to a child when the *reading* is large enough to threaten the conductor's context, which is the same threshold as everything else.
- **Email / calendar / Slack:** native MCP servers (or borrowed adapters)
  registered as in-process MCP tools — **but never on the conductor directly for
  send-class actions.** Egress (`email.send`, shell, external POST) is delegated
  to a child whose token carries only that scope, and is gated (§9). The conductor
  *decides*; a narrowly-scoped child *acts*.
  This is the one place the delegation rule is about trust rather than context: an injected instruction reaching a send verb directly is a different failure from one reaching it through an approval prompt.

---

## 9. Security boundary — dogfood Highflame

"Master of my machine" = maximal blast radius. The owner runs an AI-agent
*security* platform; the conductor should be the flagship dogfood:

- **Per-identity Cedar policy**: what may the conductor do vs. a child vs. a
  sub-agent? Policy keyed on the WIMSE URI / `delegation_depth`.
- **Shield on egress** *(later phase — NOT v1)*: v1 egress is gated by owner
  approval only, per the R4 decision above. Once the assistant no longer needs
  to work with the local stack down, route `email.send` / shell / external HTTP
  through Shield so a prompt-injected child can't exfiltrate. Codeoid is already
  a `@highflame/sdk` consumer — a natural extension, not a new dependency.
- **Fail-closed defaults**: `fleet_destroy` and any send-class egress off unless
  explicitly granted; approvals surface to the owner via the existing
  permission-correlation (`approvalId`) flow.

**What is actually enforced, versus what is prompted.** (R6)
A dogfood story that overstates its own boundary is worse than none, so this table is the honest inventory:

| Control | Status |
| --- | --- |
| Send-class fleet verbs never auto-approve | **enforced in code** — `isFleetSendTool`, checked before any mode logic |
| Worker identities are shape-capped (`scout` holds no `tools:write`; no worker holds `session:*`) | **enforced** via ZeroID scope attenuation |
| Cascading revocation of the conductor's whole subtree | **enforced** by `deactivateSessionAgent` |
| Conductor does no file writes itself | **prompt only** — full default toolset, `canUseTool` prompt is the sole gate |
| Conductor stays out of repos | **prompt only** — the empty `~/.codeoid-conductor` workdir limits accidents, not intent |
| `write: false` prevents writes | **incomplete by design** — `Bash` is outside `WRITE_TOOLS` until a real sandbox exists |

The R6 scoping table in §3 is what closes rows 4–6, and it closes them by *path*, which is enforceable today, rather than by *capability*, which is not.

**Two fences, and only one of them is Forge's job.**
Sandboxing is provided as a **wrapper**: `highflame-forge` provisions the sandbox and
starts codeoid inside it. That is the right split — it keeps the daemon free of
`if (sandboxed)` branches, exactly as [local-mode.md](./local-mode.md) keeps the
verified auth path free of `if (localMode)`. But the wrapper solves one threat model,
not both:

| Fence | Protects | Provided by |
| --- | --- | --- |
| **Outer** | the host from the fleet — filesystem outside the workspace, egress, credential exposure | Forge sandbox (wrapper) |
| **Inner** | a session's *declared* posture, and fleet members from each other | R6 scoping + the worktree check (daemon) |

Everything in the inner row happens **inside** the outer fence. `sed -i` on a repo
file works as well sandboxed as not, and the sandbox cannot distinguish "the
conductor wrote this" from "the session that owns this worktree wrote this" — same
uid, same namespace. So the outer fence does not touch the multi-writer hazard or
the conductor's path scope, and R6 is not satisfied by adding a sandbox.

**The inner fence does not need to be OS-level, and it is differentiated.** The
worktree-conflict check is deterministic, because the daemon already knows which
session owns which worktree (`fleet_list` returns it). A kernel sandbox has no
concept of a session, so "do not write where another agent is working" is an
invariant only a session-owning control plane can enforce — it is not
sandbox catch-up, it is a primitive peers cannot reach.

**Open topology decision.** codeoid *inside* a sandbox yields **one** fence shared by
every session on that daemon — tenant- or workspace-granular. Per-session isolation
would require codeoid *spawning* sandboxes and dispatching into them, which is a
different topology and a different dispatch path. This matters concretely for two
things already in the design: a `scout` that "cannot write files" is currently a
scope claim rather than a fence, and untrusted packs share the fence with everything
else. Decide the granularity before P4.5 ships anything unattended.

**Prompt injection is the reason the send-class boundary stays trust-based.**
The conductor is the highest-authority session in the system, always on, and it ingests untrusted text from three directions: web content it fetches, child output arriving as `<fleet_events>`, and whatever a mounted MCP server returns.
Direct write turns an injected instruction into direct file mutation; routed through dispatch, the same instruction has to survive an owner looking at it.
That is why §8 keeps egress delegated even though §3 relaxes write.

The demo writes itself: *"I let an autonomous agent run my machine, and here is the
policy boundary + audit tree that makes that safe."*

---

## 10. What to borrow from OpenClaw (reimplemented native)

| OpenClaw concept | Borrow as | Why native |
| --- | --- | --- |
| Multi-channel adapters | optional extra `Frontend` plugins | codeoid's `Frontend` interface already exists; keep direct-`SessionManager` access |
| Skills/memory as plain files | a skills loader for the conductor | stays inside codeoid's `~/.codeoid/` data model |
| Scheduler / cron | native wake source (§7) | must mint identity-scoped tokens per run — can't outsource |
| "Orchestrate Codex workers" | the `backend` param (§5) via `anyagent` | every worker must get a ZeroID identity; OpenClaw workers don't |

The throughline: every borrowed capability must hang off a ZeroID identity. That
constraint is *why* we don't just run OpenClaw.

---

## 11. Build phases

**Sequencing lives in [conductor-build-plan.md](./conductor-build-plan.md) (P0–P8), not here.**
This section previously carried a second, four-phase numbering that had drifted out of agreement with it; a design doc with its own competing phase list is a liability.

What the reframe changes in that plan's ordering:

1. **Conductor tool surface (new, first).** Apply the R6 scoping table: path-scoped write, fleet reads and web reads into the auto-approved set, `Bash` denied in repos.
   Small, and it *narrows* today's accidental full toolset while making the assistant pleasant to use.
2. **Front doors (P5) move up.** Nothing else is reachable without them, and they produce the usage everything downstream is designed against.
3. **Mountable fleet MCP (#245) moves up**, from a backend-compatibility item to the enabler for §5's capability surface.
4. **Routines (P4.5) acquire a hard prerequisite** — the spend ceiling and bounce cap from the amended R5, which no longer wait for the Shield era.
5. **P8 governance partially promoted** for the same reason: unattended autonomy needs its cost ceiling at the same time as its autonomy, not after.

---

## 12. Open questions (grill seeds)

**Settled since the original grilling** — kept for the record, not for re-litigation:

1. ~~**Identity authority.**~~ Owner-delegated privileged agent (R1). Depth-3 `human→conductor→child→sub-agent` verified against `zeroid`.
2. ~~**One conductor or many?**~~ One per `(account, project)`, enforced as a singleton with a TOCTOU re-check in `#createConductor`.
3. ~~**Memory: widen vs. new journal.**~~ Widened — `ALL`-workspace scope plus session cards, no separate journal.
4. ~~**Egress trust.**~~ Owner approval only in v1, no Shield dependency (R4).
5. ~~**Front door scope.**~~ Both — a web pane and Telegram, together as P5.

**Still open, and the reframe adds to the list:**

6. **Spawn ownership semantics.** Conductor-spawned children are disposable and their queue survives restart, but nothing decides whether a *long-running* worker should re-parent to the human rather than die with a revoked conductor. Revocation versus durability, unresolved.
7. **Cost ceiling — the number, not the principle.** The amended R5 settles *that* routines need a ceiling. What the ceiling is, whether it is per-routine or per-conductor-per-day, and what happens on breach (pause, alert, degrade to a cheaper model) are all undecided.
8. ~~**Where does path-scoped write get enforced?**~~ **Resolved: in the session's `canUseTool` gate, not in the capability role.** The split follows the two questions being different kinds. `tool-safety.ts` stays a **pure classifier** — *is this verb read-only?* — answerable from the tool name alone, with no dependencies and no context. The gate makes the **contextual** decision — *may this session write this path right now?* — which needs the workdir, the repo boundary, and the live worktree map. Keeping the classifier pure is what keeps it reviewable, and a path field on the role would have dragged fleet state into it.
9. ~~**Does the worktree-conflict check belong in `tool-safety.ts`?**~~ **Resolved: no** — same reasoning as #8, and it answers the objection directly. The module's dependency-free purity is load-bearing for its tests and is the reason it can be trusted as a security boundary; the worktree check lives in the gate, where fleet state already is.
10. **What granularity of sandbox does Forge actually provide?** codeoid running *inside* a Forge sandbox gives one fence per daemon (tenant- or workspace-granular). Per-session isolation needs codeoid *spawning* sandboxes and dispatching into them — a different topology. Until this is settled, `shape: "scout"` is a scope claim rather than a fence, and untrusted packs share a fence with everything else. Blocking for unattended routines (§7).
11. **Who owns the read-only declaration?** A capability declaring its own safe verbs is the right shape, but an over-broad match in `tool-safety.ts` is a prompt bypass. Registry-*driven* without becoming registry-*trusted*.
12. **Does the composed prompt need per-backend trimming?** A 20–30B open-weight conductor faces more tool-selection pressure than a frontier model at the same mount count. Whether that is answered by trimming mounts, trimming prompt sections, or a fine-tune is unmeasured — and should be measured against the real mounted surface, not a toy one.
13. **Is "conductor" still the right name?** It is a fleet-supervision word for something that is now an assistant with a fleet capability, and the name will keep pulling the design back toward fleet-only. Against a rename: `config.conductor.*`, `role: "conductor"`, the store column, and the wire protocol are all load-bearing. Current call is keep the name, fix the framing.
