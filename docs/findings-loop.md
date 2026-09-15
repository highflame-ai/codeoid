# The findings loop — review → fix → re-review, in the engine

> Status: shipped (this document describes the implemented behaviour).
> Code: `src/daemon/pipeline/findings.ts` (contracts, parsers, validators, ledger),
> `engine.ts` (the loop), `pack.ts` (`findings:` schema + the `review` gate verdict),
> `manager.ts` (fix-leg model binding), `builtin.ts` (the `findings-fix` skill).

## 1. The problem

A governed pipeline runs its review phases under read-only capability roles —
`reviewer`, `adversary`, `verifier` — on purpose: findings get *reported*, not
silently patched, which is what makes a second review round and a closeout
phase mean anything.

But the pipeline had no backward edge. `onFail` was halt, retry-the-same-phase,
or abort; Revise re-ran the same phase. So when a reviewer produced findings the
only exits were "the human approves anyway" or "the human re-runs the reviewer,
who still cannot edit". In practice the model in the review phase ended up
asking to be re-run under a write-capable role, which is the one thing the role
model exists to prevent.

The two obvious fixes both lose something real:

- **Give reviewers write access.** A reviewer that can fix its own findings stops
  writing them down; the adversary stops refuting and starts tidying; the
  closeout phase has nothing to verify. Every strong harness converged on the
  opposite (separate fix rounds, forced disposition of each finding).
- **Hand-author `fix` phases in every pack.** Pushes engine work into pack prose,
  with no validation that a finding was actually answered, and no way for the
  reviewer to verify the fix.

## 2. What the engine does

A phase declares that it produces findings and who resolves them:

```yaml
gates:
  - { id: bench_clear, kind: review }        # now a REAL verdict (§4)
  - { id: tests_pass,  kind: command, run: "make test" }

phases:
  - id: review
    skill: review                            # /review — runs under the read-only role
    role: reviewer
    gate: bench_clear
    findings:
      fixWith: implementer                   # a write-capable pack role (checked at load)
      blocking: [critical, high]             # default
      maxRounds: 2                           # fix legs before the human sees the ledger; default 2
      gate: tests_pass                       # optional: evaluated after every fix leg
```

Each leg is one engine step (one model turn on the run's bound session), so the
loop persists between legs and resumes after a daemon restart exactly where it
stopped.

```
review leg (role: reviewer)  ──findings block──►  any blocking?  ──no──► exit boundary
        ▲                                              │ yes, budget left
        │                                              ▼
        └── ledger ◄── dispositions block ◄── fix leg (role: implementer) ◄── findings
                                                  │
                                                  └── fixWith.gate (e.g. tests_pass)
```

1. **Review leg.** The phase's own skill runs under its own role, with the
   *findings contract* appended: end the report with a fenced ```findings block —
   a JSON array of `{ id, severity, title, location?, detail?, confidence? }`,
   empty when clean. A missing or malformed block is a *format* failure, not a
   verdict: one bounded re-run with the exact gap fed back (the engine's own
   channel, never the human's revise notes), then the phase's `onFail` policy.
2. **Fix leg.** If any finding is blocking and fix legs remain, the engine runs
   the built-in `findings-fix` skill on the same session under `fixWith.role`
   (the runner swaps the role per leg exactly as it swaps it per phase), with a
   fresh prompt: the findings and the *disposition contract*. The fix leg gets
   its own model binding through the same six rungs as a phase (§5).
3. **Dispositions are validated by the engine.** Every blocking finding needs
   exactly one disposition — `fixed`, `not_a_finding`, `declined`, `deferred` —
   and anything but `fixed` needs a reason. Unknown ids, duplicates, and bare
   deferrals are refused. A gap is fed back for one bounded retry; a gap after
   that halts the phase with the ledger.
4. **Fix gate.** If `fixWith.gate` is set, it is evaluated on the fix leg; a
   fixer that broke the build halts the phase with that reason rather than
   handing the reviewer a red tree.
5. **Re-review.** The reviewer runs again with the ledger: verify each `fixed`
   finding is real and did not regress anything, accept or re-raise the rejected
   ones (same id), keep `deferred` ones open, report anything new, and end with
   the block listing **only what remains open**. The latest round's block *is*
   the open set — the reviewer decides convergence, the engine enforces it.
6. **Exit.** The loop ends when no blocking finding is open or `maxRounds` fix
   legs have run. Then the normal exit boundary: a `review`-kind gate has a real
   verdict, and the universal human halt carries a one-line summary plus the
   ledger either way. `maxRounds: 0` is an audit-only phase: findings are
   reported, never fixed.

## 3. What is enforced, and where

| Rule | Enforced by |
| --- | --- |
| The reviewer cannot write | the capability role, unchanged (`write: false` → tool deny on claude; advisory elsewhere) |
| The fixer is a *different, write-capable* role | `loadPack` refuses a read-only or unknown `fixWith` role |
| Findings are structured | `parseFindings` (zod) — format retry, then `onFail` |
| Every blocking finding is answered, with a reason unless fixed | `validateDispositions` — format retry, then halt with ledger |
| The fix did not break the build | `fixWith.gate` on the fix leg |
| The fix is real | the re-review leg, under the reviewer's role |
| The loop terminates | `maxRounds`; blocking findings left open fail the boundary |
| The human sees what happened | halt reason + `PipelinePhaseWire.findings` (counts + markdown ledger); `codeoid pipeline status` prints the counts |

## 4. The `review` gate kind, finally

`kind: review` gates used to pass unconditionally and defer to the human halt.
On a phase with `findings:` they now return the loop's verdict: fail while a
blocking finding is open in the latest round (reason = the ledger), pass when
clean. On a phase without `findings:` they behave as before. A findings phase
without any declared gate gets the same verdict from the engine directly, so the
boundary never reads "complete — review and approve" over open blockers.

## 5. Model binding for fix legs

`fixWith` accepts a role name or `{ role, provider?, model? }`. At create the
fix leg's binding is resolved through the same rungs as a phase — CLI `--role`,
`modelRoles`, the pin, the role's `model`, `modelTiers` via the role's `tier`,
provider default — with the same skip rules (cross-provider bindings and models
the session's backend cannot run are skipped with a warning naming the rung).
The result is persisted on `def.findings.fixWith`, so resume and retry keep the
same binding. A pack can therefore review on one tier and fix on another, e.g.
review under a `reasoning-max` role and fix under a `mechanical` one.

## 6. Human semantics

- **Approve** at the boundary accepts the phase as-is (open non-blocking
  findings are recorded, not lost). Approving over open *blocking* findings is
  the same deliberate override it always was for a failing gate.
- **Revise** re-runs the phase as a review leg with the human's notes *and* the
  ledger; if the reviewer reports blocking findings and fix legs remain, the
  loop continues. The fix budget is per phase, not per revise.
- **Reject** fails the run.

## 7. Why this is different

| | codeoid findings loop | typical harnesses |
| --- | --- | --- |
| Who fixes | a different role, write-capable, on the same session | the reviewer, or a hand-written "fix" node |
| Disposition of each finding | required and *validated by the engine* | prose convention, if at all |
| Re-verification | the same reviewer role re-runs with the ledger and names the open set | none, or a fresh review with no memory of round 1 |
| Termination | bounded fix legs; open blockers fail the boundary | prose sentinels / loop counters |
| Governance | roles untouched; fix legs get their own model binding | roles loosened to make the loop work |
| Restart safety | every leg is one persisted step | run-local |

## 8. Authoring notes

- Keep `blocking` honest: a `medium` finding that should block the phase is a
  `high`. Non-blocking findings ride along in the ledger for the human.
- The fix leg is told to run the project's tests; set `fixWith.gate` when the
  pack has a deterministic one, so a green claim is checked, not trusted.
- A reviewer that keeps re-raising a `declined` finding is doing its job; the
  human decides at the boundary with the whole ledger in front of them.
- `maxRounds: 0` turns any findings phase into a pure audit.
