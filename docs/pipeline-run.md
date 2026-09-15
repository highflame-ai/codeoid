# Pipeline runs: from headless workers to a conductor over a live session

**Status:** proposed (redesign of the shipped `#217` run cockpit).
**Supersedes:** the "poll-driven cockpit + fire-and-forget steer over a headless worker" model in the current `docs/pipeline-run.md`.

---

## Why change what just shipped

The `#217` design ran each phase as a *headless, one-shot worker session*: `SessionManager.runPhaseTurn` spins up a `new Session(role:"worker", mode:"autonomous", maxTurns)`, sends the phase prompt, waits for the session to reach a resting status **or a 10-minute timeout**, captures the final text, then **destroys the session**.
Every symptom a user hits follows directly from that one choice.

- **The phase does its work invisibly.**
  The worker session has no client attached, so its streaming output, tool calls, and questions go only to the transcript — never to the user's chat.
  The cockpit polls phase *status* (`running`/`halted`), so a running phase shows nothing.

- **There is a timeout, and it fires.**
  A headless session that stalls on a tool or a question has no one to unblock it, so it can hang forever — hence the 10-minute `PHASE_TURN_TIMEOUT_MS` backstop.
  In `implement`, the model either ran long or stalled waiting for input nobody could give, and the run timed out with no visible output.

- **Gates "ask for approval without doing anything".**
  Only `command` gates execute today; `skill` / `review` / `self` gates are stubs that fail-closed to a human halt labelled "not yet enforced" (`pack.ts`).
  aif-sdlc's `spec_valid` and `no_blocking_findings` are exactly those, so `spec`, `architect`, and `review` halt at a no-op gate.

The root error: **a governed, human-in-the-loop pipeline must run its phases in a session the user is attached to** — one they can watch, interrupt, question, and answer — not a headless worker with a timeout.
The whole value of the pipeline is the human in the loop; a phase you cannot see or talk to defeats it.

---

## The pivot: the pipeline is a *conductor over a live session*

A pipeline run no longer owns disposable workers.
It **binds to one real, attached session** and drives it through the phase sequence, injecting each phase's kickoff prompt as an ordinary streamed turn and pausing at phase boundaries for your decision.

Concretely, for a run over pack *P* with goal *G*:

1. `/pipeline` (or `pipeline.create`) creates **one dedicated run-session**, binds the run to it (`pipeline.sessionId`), and the client **auto-attaches** it so it becomes your focused chat.
2. Entering a phase, the conductor **applies that phase's capability role** to the bound session (the `#216` `canUseTool` gate — reviewer read-only, implementer can write) and **injects the phase's skill/prompt as a normal turn**.
   You see the model work live: streaming text, tool calls, everything.
3. **You can talk to it at any time** — interrupt, answer its questions, add constraints, ask it to dig deeper.
   It is just an interactive session; the pipeline only decides *when a phase starts* and *when the run advances*.
4. When the model rests, the phase is **ready for review** (not "done" — you decide).
   The cockpit overlay shows **Approve / Revise / Reject** at the boundary:
   - **Approve** → run the phase's `command` gate if it has one (a real auto-check, e.g. `tests_pass`), then apply the next phase's role and inject its prompt.
   - **Revise** → keep working *this* phase; your feedback is threaded in and the phase re-runs in the same chat (the `#217` revise loop, now visible).
   - **Reject** → end the run.
5. There is **no per-phase timeout.**
   The session is attended, exactly like every other interactive session (auto-rotate handles context growth); the backstop only existed for the headless case and is removed.

The run accumulates the whole `spec → … → ship` conversation in one transcript, so later phases see earlier work *in context* naturally, instead of us threading prior output through a prompt.

### Decision: dedicated run-session, not "drive your current session"

**Recommended:** `/pipeline` creates a dedicated session for the run and auto-attaches it.

- Clean separation: your freestyle chats stay separate from a governed run; multiple runs are just multiple sessions, no collision.
- Per-phase roles apply naturally to a purpose-built session, and the session identity can reflect the active phase role (the web already surfaces per-message identity).
- Matches codeoid's "clients are pure renderers; any frontend attaches any session" model — auto-attach is a focus change, not a new mechanism.

**Rejected alternative:** take over the user's *current* session.
It mixes freestyle history into the run, forces us to mutate a session you own (swapping its role/capabilities mid-stream), and makes multiple concurrent runs awkward.
The only thing it saves is one auto-attach, which the client does for free.

---

## Gate / checkpoint semantics (cleanup)

- **`command` gates** stay as real automated pre-checks, run on **Approve** before advancing (e.g. `tests_pass`).
  A failure surfaces in the cockpit and blocks the advance until you Revise or override.
- **Phase boundaries are the human checkpoint.**
  With you present and Approving every boundary, the honest model is: *you* are the reviewer.
  The misleading "gate … is not yet enforced" halt goes away — a boundary reads "phase *N* ready — review the chat above."
- **`review` gates have a real verdict on a phase that declares `findings:`** — the findings loop (docs/findings-loop.md): the reviewer's structured findings drive a fix leg under a write-capable role and a re-review, and the gate fails while a blocking finding is still open, with the ledger as its reason.
  On a phase without `findings:` a `review` gate behaves as before (passes; the human is the reviewer).
- **`skill` gates remain optional automated verdicts (later slice).**
  Until implemented they are simply absent, not fake.

---

## Governance across backends

A run drives its phases on whatever backend the bound session uses, so the pivot must hold on all of them.
Two layers behave differently:

- **Phase execution** (run a phase's turn, stream it, halt at the boundary) is backend-agnostic — it is an ordinary session turn.
  Works on claude / pi / codex / gemini / gemini-cli / openai.
- **Per-phase capability role.**
  Hard tool-deny (a reviewer phase physically cannot Write/Edit) rides Session's `canUseTool` gate, which only lands on backends that route every tool through it under canonical tool names.
  That is **claude only** today.
  Everywhere else the role is *advisory*: the pack constitution + role contract are delivered in the system prompt and the model is instructed to stay in role, but nothing hard-denies.

| Backend | Phase execution | Role (hard tool-deny) | Constitution / role contract |
| --- | --- | --- | --- |
| claude | ✅ | ✅ hard | ✅ |
| pi | ✅ | ⚠️ advisory | ✅ |
| codex | ✅ | ⚠️ advisory | ✅ |
| gemini (stateless) | ✅ | ⚠️ advisory | ✅ |
| gemini-cli (ACP) | ✅ | ⚠️ advisory | ✅ (delivered as a prompt preamble — this PR fixes the prior drop) |
| openai (stateless) | ✅ | ⚠️ advisory | ✅ |

`roleEnforcement(providerId)` classifies each backend, and `runPhaseOnSession` **logs when a phase's role is only advisory** on the bound backend — so a reviewer phase on, say, codex is never silently presented as locked down.
Full hard enforcement on the other backends (mapping their native tool names, or using a read-only native sandbox for reviewer phases) is future work; note codex in autonomous mode never invokes `canUseTool` at all, so it needs a native-policy approach rather than tool-name mapping.

---

## What changes, by layer

**Protocol**
- `PipelineState.sessionId` — the bound run-session.
- `pipeline.create` creates + binds the session (and returns its id so the client can attach); optionally accepts an existing session id to bind.
- `advance` / `revise` operate by driving turns on the bound session (via the normal turn path) instead of `runPhaseTurn`; they stay fire-and-forget (a phase turn is long) but progress is now visible in the session stream, not just the poll.
- Remove `PHASE_TURN_TIMEOUT_MS`.

**Daemon**
- Replace `PhaseTurnHost.runPhaseTurn` (headless, autonomous, timeout, destroy) with a **`PhaseSessionDriver`** that: applies the phase role to the bound session, injects the phase prompt as a turn, and resolves the phase as "ready" when the session rests — **without** tearing the session down and **without** a hard timeout.
- The engine's advance/gate/onFail logic is largely unchanged; only the "run a phase" seam swaps from worker to bound-session turn.
- Per-phase role application reuses the `#216` role gate on the bound session.

**Web**
- `/pipeline` opens the **existing create-session dialog, extended** (drawer or modal) — the run *is* a session plus a goal and a pack, so it reuses that flow rather than a bespoke panel.
  Fields: **session name**, **workspace / workdir**, plus the normal create knobs (provider / model), **and two additions**: a **goal / feature** text box and an **installed-pack** selector.
  Submit → `pipeline.create { name, workdir, goal, pack, provider?, model? }` → auto-attach the run-session.
- After creation the **chat is the primary surface**; the cockpit is a thin overlay (phase rail + Approve/Revise/Reject).
- The poll loop stays only for phase-boundary/decision state; live phase output comes from the normal session stream (no polling for content).

---

## Implementation slices

**S1–S3 landed together in this PR.** S4 is future work.

1. **S1 — bind + visible turns (the core fix).** ✅
   `pipeline.sessionId`; create binds a session; phases run as streamed turns on it; per-phase role applied; **timeout removed**; worker path retired.
   Outcome: you see the model work and can talk to it; no more invisible run, no timeout.
2. **S2 — gate/checkpoint cleanup.** ✅
   Every phase halts at its boundary for the human; `command` gate verdicts are surfaced; the "not yet enforced" stub halts are gone. Plus honest cross-backend governance (advisory vs hard) + the gemini-cli constitution-delivery fix.
3. **S3 — web overlay UX.** ✅
   `/pipeline` opens the extended create-session dialog (name · workdir · provider · **goal** · **installed pack**); on submit, focus the run-session.
   Chat-primary layout, a non-modal collapsible cockpit dock over the run's chat.
   (Retires the `#217` bespoke "Start panel".)
4. **S4 — automated review gate verdicts.** ✅ for `review` gates, via the findings loop (docs/findings-loop.md): structured findings → validated dispositions from a write-capable fix leg → re-review; the gate's verdict is "no blocking finding open". `skill` gates remain future work.

## Open questions

- **One session for the whole run, with the role swapped per phase, or one session per phase?**
  Leaning one-session-per-run (continuous chat, in-context history); per-phase sessions give cleaner role isolation but fragment the conversation.
- **Interrupt vs. Revise.**
  Free-form chat mid-phase already lets you steer; is `Revise` still a distinct control, or just "you kept chatting, then Approve"? (Proposed: keep Revise as the explicit "re-run this phase's kickoff with my notes" affordance; free chat handles the rest.)
- **Unattended runs.**
  Do we still want a headless/CI mode later (no human at boundaries)? If so it returns as an explicit opt-in mode, not the default.
