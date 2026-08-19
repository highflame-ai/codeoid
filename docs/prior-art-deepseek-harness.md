# Prior art: DeepSeek Harness (`dsh`)

> Analysis date: 2026-08-14.
> Read against the `deepseek-harness` tree at commit `47f9438` (`0.1.0-rc.5`, developer preview).
> Companion to [COMPARISON.md](./COMPARISON.md), which covers Superset and Omnigent.

## 0. Measurements

| | Codeoid | DeepSeek Harness |
|---|---|---|
| Non-test TypeScript | ~50k LOC (`src/`) + web + 2 packages | ~520k LOC across ~50 package groups (~270 packages) |
| Test files / test LOC | 195 / 52.7k | 647 / 217.5k |
| Package READMEs | — (monolithic `src/`) | 268, of which 215 carry a **Model Experience** + **KV Cache effect** section and 220 carry **Known Limitations and Deferred Work** |
| Decision records | `docs/*.md` design docs | 1,386 files under `.agents/notes/` |
| Generated + CI-verified catalogs | none | cordis surface, config, persistence, tool, module graph, scoped events — each with a `--check` gate |
| Licence | — | MIT |

The size gap is real but it is not the interesting part.
The interesting part is that dsh spent its size on *seams* and codeoid spent its size on *features*, and that difference is now visible in both codebases.

---

## 1. These are not the same category of thing

This has to come first, because most of the feature-by-feature comparisons below are meaningless without it.

**dsh is a harness.**
It implements the agent loop itself: turn/step orchestration, prompt assembly, the tool registry, the model adapter seam, compaction, the session log.
Its LLM adapters are `llm-deepseek` (the official wire format) and `llm-pi-ai` (a catalog-backed second path).
It is a single-user local product: a web UI on `127.0.0.1:3080`, a headless one-shot runner, and an ACP server.

**Codeoid is a control plane over harnesses.**
It does not implement an agent loop.
It drives the Claude Agent SDK, the Codex app-server, the Gemini CLI over ACP, and three API-level backends, behind one `SessionProvider` interface, and adds identity, memory, multi-frontend attachment, and device handoff on top.

The two do overlap at the edges, and the overlap is instructive.
dsh ships subagent providers for Claude Code, Codex, and ACP — so it *delegates* to other harnesses even though it doesn't *run as* them.
dsh also ships hook-compatibility bridges that execute a user's existing Claude Code and Codex hook configs on dsh's own interception points.
Both are convergence toward the same insight codeoid started from: the other harnesses are not going away, so interoperate with them.

The difference that remains is directional.
dsh reaches out to other harnesses from a position of owning the loop.
Codeoid reaches out from a position of owning the session.
You cannot fork a dsh session onto Claude Code; you can fork a codeoid session onto Codex.

---

## 2. Where codeoid genuinely stands out

### 2.1 Identity — not close

This is the widest gap in the comparison, and it runs in codeoid's favour.

dsh's entire identity subsystem is one package, `dsh-anonymous-user-id`: a random UUID v4 written to `~/.dsh/.anonymous-user-id`, used to correlate telemetry, tag `/feedback` acknowledgements, and set an `x-deepseek-harness-user-id` header on DeepSeek requests.
Its own README states the identity is deliberately not derived from anything stable and resets when the file is deleted.
There is no authentication, no authorization, no scopes, no multi-user model, no delegation, no revocation, and no audit attribution anywhere in the tree.

Codeoid has ZeroID JWT verification, eight enforced scopes checked per message, a cryptographic identity per agent *and* per sub-agent as SPIFFE/WIMSE URIs, delegated tokens with scope attenuation, cascading revocation, and a SQLite audit log attributing every action to a subject.

That is not a gap dsh can close by writing a package.
It is a gap that follows from being a single-user local tool, and closing it would mean rebuilding the tool as a multi-tenant service.

### 2.2 Cross-session memory — materially deeper

dsh's recall story is `session-query`: a query vocabulary over the logical session corpus with a SQLite **FTS5** provider.
It is exact-read, relationship tracing, and full-text keyword matching over session logs.
There are no embeddings, no vector index, no reranker, and no clustering anywhere in the tree.

Codeoid's `src/daemon/memory/` is FTS5 **plus** a transformers.js embedder, a transformers.js reranker, a hybrid ranker, a chunker, topic clustering with an LLM cluster-labeler, a workspace clusterer, an auto-regenerated workspace memory index injected into the system prompt, and an MCP surface exposing `recall` / `recall_file` / `timeline` / `get_episode` to the agent itself.

Keyword search over your own logs and semantically-ranked verbatim episodic recall injected into context are different products.

### 2.3 Multi-backend at the session level

Codeoid runs six backends as first-class session drivers with cross-backend fork carrying a history seed.
dsh runs one loop against DeepSeek models; other harnesses appear only as *children*, and only through the subagent seam.

This is the position codeoid should defend hardest, because it is the one that cannot be retrofitted.

### 2.4 Multi-frontend and device handoff

Codeoid: TUI (Ink, plus the native Rust client in `codeoid-ui`), web, Telegram, and mobile push, all attaching to the same daemon-owned session with scrollback replay on handoff.
dsh: a web UI, a headless runner, and an ACP server.
There is no phone story and no handoff story.

### 2.5 Semantic pre-entry compression

Codeoid's `src/daemon/compress/` has declarative, pure, unit-testable rules that *understand* the commands they compress — dedicated rules for git, test runners, search, and shell, ordered by specificity, with a tee-cache so the full output stays recoverable through recall.

dsh's nearest equivalent, `spill`, is deliberately dumber and deliberately later: after a tool returns, if the result exceeds `maxInlineBytes`, persist the whole thing to a private session-scoped file and hand the model a head/tail preview plus an opaque locator and a retrieval hint.

These are complementary rather than competing — see §4.5.

### 2.6 The conductor / fleet layer

A privileged supervising session with a strict read/send tool split, side-effecting verbs that can never be auto-approved, digest-based summaries so the supervisor never goes out of context, and a durable dispatch queue with lease reclaim and crash recovery.

dsh has rich *intra*-session orchestration (§3.6) but nothing that supervises a population of independently-owned sessions across workspaces.

### 2.7 Per-turn economics

Persistent per-turn token / cost / cache telemetry and live context occupancy.
dsh has `ctx.tokenMeter` for estimation and replay, wired into compaction pressure decisions — but it is a compaction input, not a user-facing economics surface.

---

## 3. Where dsh is clearly better

### 3.1 Capability seams — the biggest architectural gap

dsh's organizing idea is that a capability is three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it — usually a model-facing tool.
A package may combine roles, but one role alone is not a seam, and adding a capability means designing all three.

The payoff is stated plainly in their architecture doc and it holds up in the tree:

> Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks.

That is why `e2b/` is three small packages (`e2b`, `fs-e2b`, `subprocess-e2b`) rather than a fork of the execution stack.

Codeoid has exactly one real seam — `SessionProvider` — and it is a good one; the multi-backend position rests on it.
Everything else is direct.
The measurable consequence is `session-manager.ts` at **5,287 lines** and `session.ts` at **4,527 lines**: two files holding rate limiting, resume, scope enforcement, retry, scrollback, permissions, hooks, memory wiring, compression wiring, dispatch, and fleet.
Those two files are the main thing standing between codeoid and its next ten features.

### 3.2 One append-only log as the single source of truth

dsh has one durable structure — the session event log — and everything is a projection of it.
Model history comes from `deriveMessages()`.
Resume, fork, transcripts, telemetry, persistence, and the UI all derive from the same stream.
Events are classified `current` / `shadowed` / `log-only`, so replaced context and never-model-visible bookkeeping stay in the log without reaching the model.

It is enforced, not merely intended:

> **Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it.

Plan mode is the clean demonstration: `plan/mode` is a log-only event, and `foldPlanMode(events)` is a pure fold, so resume, fork, and compaction all recover plan state with **no live mirror** to keep in sync.

Codeoid has four overlapping representations — the JSONL `TranscriptStore`, the `ScrollbackBuffer` ring, the SQLite `Store`, and each provider's own native session file.
`src/daemon/resume-reconcile.ts` exists precisely because they can disagree: tool calls frozen in `streaming` / `waiting_confirmation` / `executing` are driven by in-memory state that does not survive a restart, so on resume they must be rewritten to a terminal phase or clients replay phantom running tools forever.

That file is a well-written fix for a problem that the log-plus-fold architecture does not have.

### 3.3 Compaction as a real subsystem

dsh's compaction is a seam with a basic provider, and the rigor is well beyond codeoid's rotation:

- A log-recorded lock bracketing the whole operation (`compaction/start` … `compaction/end`), ordered so that a crash mid-operation leaves a *detectable orphaned lock* rather than a false "finished" record.
- Range boundaries validated by `toolPairingBalancedBefore/After()` so an assistant tool call is never separated from its result — the exact thing that produces provider 400s.
- A separate `ctx.toolResultPruner` that does deterministic head/middle/tail pruning of oversized tool results *before* range selection, measured in Unicode code points so a retained boundary cannot split a surrogate pair, and re-measured through the token meter afterward.
- A named failure taxonomy (`busy` / `cancelled` / `changed` / `summary` / `commit` / `persistence`) where failed attempts stay visible in the log.
- Full reconstructability: the summarize call's provider, model, and cap are logged so the one-shot request can be rebuilt from log plus code.

Codeoid's auto-rotation is arguably the better *idea* — lossless via a memory recall seed beats a lossy summary — but dsh's is the better *engineering*.

### 3.4 OS-level sandboxing

dsh ships `sandbox-local` with Linux bwrap/Landlock (including their own `node-addon-landlock-run` native addon), macOS Seatbelt, and a Windows ACL restricted-token backend.

Three details worth stealing regardless of implementation:

- **Enforcement is a reported fact, not an assumption.** `SandboxEnforcement` is `full | partial`; older Landlock ABIs and the Windows ACL runner's Everyone/hard-link boundaries report `partial`, and consumers requiring an absolute boundary must reject rather than treat it as full. There is a postmortem on getting this wrong (`0004-landlock-partial-notice-misclassified-child-failures`).
- **Denial signatures are per-backend dialects**, not a cross-backend union — EROFS under bwrap, EACCES under Landlock, EPERM under Seatbelt — because a union claims denials a given backend never produces.
- **`runnerFailureRules` separate "the sandbox refused to start" from "the sandbox worked and blocked the command."** Checked first, and surfaced as infrastructure failure rather than task failure.

Silent unconfined passthrough is never legal for a confined policy.

Codeoid has approvals and an autonomous write budget, which are a policy layer, not a confinement layer.
For a product whose thesis is *identity-first*, this is a soft spot: perfect attribution of an action you did not confine tells you exactly who deleted your home directory.

### 3.5 LSP as a model-facing capability

Four operations — `goToDefinition`, `findReferences`, `goToImplementation`, `hover` — behind `ctx.lsp`, with a generic stdio provider and a model-facing tool.
The union is deliberately closed so adding an operation is a compile-enforced change across seam, providers, and tool.

Codeoid has none.
For a coding harness this is a real capability gap, and it is a bounded one.

### 3.6 Continuable background subagents

Codeoid's subagent story is lineage tracking (`parentToolUseId`) plus a dispatch queue.
dsh's is a full lifecycle:

- One-shot children *and* **continuable** children that persist, cold-resume from their own session, and accept later follow-ups.
- Follow-up authority checked against the exact live direct parent recorded in the child's durable header — checked before reconstruction and *again* in the final inbox-admission span, so a parent unregistered mid-materialization cannot authorize delivery.
- `listChildren()` / `listDescendants()` walking the whole session tree in stable pre-order *without loading or resuming* any of it.
- `drainContinuableDescendants()` closing admission below a parent and releasing the forest child-first.
- Provider capabilities (`outputSchema`, `depthLimit`, `toolFilter`, `persona`) declared so unsupported requests are rejected *before* child creation.
- `delegationDepth` persisted on the header and monotone, so a resumed child cannot be re-counted as top-level.
- `applyChildComposition(childCtx, parent, composition)` — one call that makes composing a child *without* joining the parent's preset unrepresentable at the call site. That is a beautiful way to encode an invariant.

### 3.7 Guard plugins — small, and codeoid has neither

- **`repeat-tool-reminder`**: watches each agent's tool stream, keys a chain on `(tool name, deep-key-sorted JSON of arguments)`, and at configured run lengths (`[3, 5, 8]`) injects an escalating advisory to stop repeating, re-read the last result, and change approach or conclude. It never vetoes and never appears in the tool list. The chain key always compares the full canonical string; the preview cap bounds only the reminder text.
- **`timeout-policy`**: one `tools/execute` around-listener arming a cooperative deadline from the tool's own declared `ToolDefinition.timeoutMs`. Zero config, so a mistyped tool name is not possible.

Both are a few hundred lines and both target exactly the failure modes of long unattended runs — which is codeoid's dispatch and conductor use case.

### 3.8 Engineering discipline treated as infrastructure

The thing that most distinguishes this repo is that its process is *mechanized*, not documented-and-hoped-for:

- **Every generator has a `--check` mode wired into a CI gate** — cordis surface catalog, config catalog, persistence catalog, tool catalog, module graph, scoped events, third-party notices.
- **`verify-type-equiv`** checks that the ` ```ts type-equiv ` blocks in the docs still match the source declarations they claim to mirror. Documentation drift becomes a build failure.
- Named gate groups (`ci-static`, `ci-primary`, `ci-coverage`, `ci-snapshot`, `ci-artifacts`, `ci-consumers`) plus `doc-budgets`, `doc-refs`, `verify-md-links`, `verify-md-wrap`, `agent-note-format`, `agent-note-classification`.
- **Windows as a blocking CI tier**, with wine-based gates and separate blocking / complete / observational levels.
- `knip` (dead code), `publint` (package correctness), `jscpd` (duplication), workspace constraint checks, runtime-closure verification.
- A **runtime invariant registry** where each package publishes a `./invariant` companion — and where a package with no plausible runtime relationship must ship an empty installer with a `No runtime invariant:` comment *explaining why*. Exhaustive publication, deliberately non-synthetic assertions.
- Numbered **postmortems** with a README.

### 3.9 Smaller things codeoid doesn't have

- **Persistent terminals** as a seam (`ctx.terminals` + `tool-terminal`), distinct from one-shot bash.
- **`jobs`** — a generic background-task runtime with owner-fenced access, `running/stopping/completed/killed/failed` status, and model-facing `job_*` controls; `bash` and `subagent` are just two registered kinds.
- **`schedule`** — durable session-local reminders (`after` / `at` / `every`, minimum five-minute interval) that return to the original live session as ordinary conversation turns. Codeoid's own COMPARISON.md lists "no scheduler yet" as a gap.
- **`skill`** — a provider registry plus filesystem implementation and a catalog/loader tool.
- **`credentials`** — a credential-*reference* seam, so config names an env var rather than carrying a secret.
- **`preset` / `persona`** — per-session agent composition from preset files, joined into every child.
- **Hook compatibility bridges** for Claude Code and Codex hook configs, with the honest framing that a native plugin would be strictly better and the bridge exists only as a compatibility path.
- **`tool-cordis`** — five model-facing tools letting the agent inspect the live plugin runtime and define/run/stop its own plugins in-process. Explicitly not a security boundary; "treat it like bash access."
- **`spill`** (§4.5).
- **`plan-mode`** as logged state.

---

## 4. Ideas worth adopting, ranked

Ordered by (payoff ÷ effort) for codeoid *as a control plane*, not as a harness.

### 4.1 Break `session.ts` and `session-manager.ts` into capability seams — **highest leverage**

Not Cordis. The pattern, applied by hand, exactly as codeoid already did once for `SessionProvider`.

Take the Service Definition / Provider / Consumer triad seriously for `fs`, `shell`, `sandbox`, `compaction`, and `memory`.
The concrete prize is the one dsh names: once fs and subprocess are one seam, pointing them at a remote host or a container moves bash, PTY, and any future LSP with them — which is the natural next step for a *control plane* whose sessions need not run on the daemon's own machine.

9,800 lines across two files is the binding constraint on everything else in this list.

### 4.2 Collapse persistence to one append-only log with derived projections

Adopt "model-visible means logged," classify events `current` / `shadowed` / `log-only`, and derive model history, scrollback, resume, and the UI from the one stream.

Two immediate wins: `resume-reconcile.ts` becomes unnecessary rather than merely correct, and any future state that today would need a live mirror becomes a pure fold, the way dsh's plan mode is.

This is the deepest change on the list and should follow 4.1.

### 4.3 Guard plugins — cheapest real win

`repeat-tool-reminder` and per-tool `timeoutMs` enforcement.
A few hundred lines each, no architectural prerequisites, and they target the exact failure modes of unattended dispatch and conductor runs.
Do these first while 4.1 is in flight.

### 4.4 Runtime invariant registry

A registry where each subsystem publishes checks over relationships tests can't see, with the "empty installer plus a written reason" rule so the publication list stays exhaustive.
Cheap, and it catches the class of bug that killed `resume-reconcile` state.

### 4.5 Spill, backed by codeoid's recall

Codeoid's `compress` handles commands it *recognizes*.
Spill is the catch-all for everything else: any oversized tool result → private session-scoped file, head/tail preview, opaque locator, retrieval hint.

Codeoid can build a strictly better version than dsh's, because dsh's retrieval hint is "use read or grep on this path" while codeoid's retrieval backend is *semantic recall*.
Compress narrows what it understands; spill catches the tail; recall retrieves both.
That closes the whole surface.

Steal the details: full content persisted verbatim, exclusive `open(path, 'wx', 0o600)` so a planted symlink cannot redirect the write, and best-effort degradation — a save failure keeps the inline result rather than turning a successful call into an error.

### 4.6 An OS-level sandbox seam

Codeoid's own COMPARISON.md already carries this as a gap against Omnigent.
dsh is MIT-licensed and has a working three-platform implementation, and their vocabulary is worth adopting even if the code isn't: `full | partial` enforcement reported honestly, per-backend denial dialects, `runnerFailureRules` separating runner failure from confinement working, and fail-closed with silent passthrough forbidden.

For an identity-first product this is the missing half of the story.

### 4.7 LSP seam

Four operations, one stdio provider, one tool.
Bounded scope, real capability gain, and it is the natural second consumer that proves the fs/subprocess seam from 4.1 is actually a seam.

### 4.8 Compaction rigor

Even keeping codeoid's lossless-via-recall rotation, adopt:

- **Tool-pairing-balanced boundaries.** Prevents a real class of provider errors.
- **A tool-result pruner as a cheap pre-summary step**, measured in code points.
- **The bracketed lock ordered so a crash leaves a detectable orphan**, not a false completion.

### 4.9 "Model Experience" + "KV Cache effect" in every subsystem doc

The most interesting cultural artifact in the repo, and nearly free.

215 of 268 package READMEs state what the model sees and whether the package invalidates the prompt prefix.
For a harness, prompt-prefix stability *is* cost.
Codeoid measures cost per turn beautifully after the fact, but nothing currently forces a contributor to think about cache invalidation at design time.
A required section does.

Pair it with **Known Limitations and Deferred Work** (220 READMEs) — honest, and it stops the same objection being re-litigated every quarter.

### 4.10 Generated-and-verified catalogs

`docs/architecture.yaml` exists but is not verified by CI.
Give every generator a `--check` mode and a gate.
`verify-type-equiv` — docs quoting source declarations, checked for drift — is the standout idea here and would suit codeoid's protocol package especially well.

### 4.11 Schedule

Durable per-session reminders delivered as ordinary conversation turns.
Already a known gap; dsh's shape (`after` / `at` / `every` with a five-minute floor, canonicalized to RFC 3339 UTC at creation) is a good starting spec.

---

## 5. What not to adopt

- **Cordis itself.** Vendored framework, large conceptual tax, and a plugin surface far wider than codeoid needs. Take the seam *pattern*; skip the runtime.
- **`typert`.** RPC/type-graph codegen solving a problem `packages/protocol` already solves at codeoid's scale.
- **The bilingual docs pipeline.** Byte-identical generated regions across two languages is impressive and irrelevant here.
- **Their own agent loop and LLM adapters.** Implementing the loop is the one thing codeoid deliberately doesn't do; doing it would forfeit the multi-backend position for a worse version of what Claude Code already ships.
- **The full process weight.** 1,386 agent notes and a six-tier CI gate matrix reflect a large team. Take 4.4, 4.9, and 4.10; leave the rest.

---

## 6. On "world's best agent harness"

Codeoid is not a harness and should not try to become one.
dsh *is* a harness — and so are Claude Code, Codex, and the Gemini CLI, all of which have more people on the loop itself than codeoid will.
Competing there means reimplementing the one layer codeoid gets for free from every backend it supports, and losing the multi-backend position to do it.

The defensible target is **world's best control plane over harnesses**, and the three moats are already dug: identity, memory, and provider-independence.
dsh has none of the three and structurally cannot grow the first.

What dsh has that codeoid needs is not features — it's *shape*.
A 5,287-line `session-manager.ts` is what happens when a good idea ships fast; capability seams are what makes the tenth good idea as cheap as the second.
Everything in §4 above §4.5 is really one recommendation wearing different hats: **buy the architecture, not the feature list.**

Then the feature list gets cheap.

---

*Claims verified by reading the deepseek-harness tree directly at `47f9438`, 2026-08-14. Developer preview, iterating rapidly — re-verify before relying on a dated claim.*
