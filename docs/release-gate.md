# Release gate: is this build ready to ship?

Status: tiers 0 and 1 implemented (`.github/workflows/release.yml`,
`scripts/check-artifact.ts`, `scripts/check-upgrade.ts`, the `release-gate` CI
job); tier 2 started (`e2e/specs/backends-aimock.spec.ts`: claude and codex,
journeys 1–3 and 6); tiers 3–5 designed. Owner of the go/no-go: the release owner.

codeoid has a strong per-PR gate (unit suite, e2e against a scripted backend,
real bubblewrap and Claude-sandbox tests) and almost nothing between "main is
green" and "it's on npm". Today the release workflow runs only the unit suite
before it publishes; nothing calls a real model, boots the package users
install, checks that a previous release's data still loads, or measures
whether the daemon got slower or bigger. The v0.5.0 tag never reached npm at
all (its build failed, unnoticed for five weeks).

This gate answers one question per release candidate, with evidence: **does
this build do what the last release did, on every backend we support, at least
as well, and does the artifact users install actually work?**

## Principles

- **Evidence, not claims.** Every check records what ran, on which commit, and
  what it found (the daemon's evidence runner, `codeoid evidence`). A check that
  ran zero cases is inconclusive, never a pass.
- **Nothing skips silently.** Each tier starts with a preflight (as
  `scripts/check-real-sandbox.ts` does) that fails the tier when its
  prerequisites are missing.
- **Compared to the last release, not to a fixed bar.** Quality and performance
  are judged as deltas against the previous release's stored results, so the
  gate catches regressions without arguing about absolute numbers.
- **Every backend, or an explicit waiver.** A backend that isn't exercised is
  listed as such in the report; it is never assumed to work.
- **Cheap where it can be.** Deterministic tiers run in CI on every release
  candidate; tiers that cost tokens run once per candidate, on demand.

## Tiers

| Tier | What it proves | Where it runs | Cost | Blocking |
|---|---|---|---|---|
| 0. Pipeline | the tag publishes exactly what main tested | release workflow | free | yes |
| 1. Artifact | the npm package installs, boots, serves the UI, and upgrades a previous release's data | CI (release candidate) | free | yes |
| 2. Conformance | every backend's real harness completes the core journeys, against a mock provider | CI | free | yes (every backend) |
| 3. Quality evals | agents still solve tasks as well as with the last release | on demand, real models (or a local model) | ~$10–30, or free on llama.cpp | yes on regression |
| 4. Performance | startup, memory, per-turn overhead, attach, shutdown haven't regressed | CI (dedicated job) | free | yes on regression |
| 5. Platforms | macOS (Seatbelt), Docker sandbox | CI (macOS runner, Docker job) | runner minutes | yes |

### Tier 0: the pipeline itself

The release workflow must publish what main tested, and fail loudly otherwise.

- **Stop rewriting versions in the workflow.** `RELEASING.md` already says the
  bump lands in a PR (`bun run version:set`, both lockfiles refreshed); the
  workflow then only *checks* `check:versions <tag>`. Rewriting in the workflow
  is what broke v0.5.0 (the bump changed the lockfile, then `--frozen-lockfile`
  refused) and makes the version checks pass by construction.
- **Require the tagged commit to be on main, and run every PR check on it
  again:** the release workflow calls `pr-check.yml` (now also a reusable
  workflow), so daemon-check, e2e, web-check, sandbox-real and release-gate all
  gate the publish. (A squash merge's commit on main never ran CI itself, so
  querying its checks wouldn't work.) The tag's version must already be the
  repository's, and `check:versions` gets the tag (it was handed an empty
  string before: `${{ env.GITHUB_REF_NAME }}` is not an expression that exists).
- **Use `scripts/publish-if-new.sh`** (it tells a 404 from a registry error and
  adds provenance), as RELEASING.md describes.
- **Create the GitHub Release** from the CHANGELOG section (the gate report
  attached, once tier 5's report exists).

### Tier 1: the artifact users install

Implemented, in the `release-gate` CI job (on every PR and in the release):

- **`scripts/check-artifact.ts`:** checks what each package would ship (no
  tests, maps, env files or keys; the CLI carries the web UI), `npm pack`s the
  three packages, installs the tarballs into an empty project with npm and with
  bun, and runs the *installed* `codeoid`: `--version`, `start` on a throwaway
  config dir, `/health`, the web UI, a session that answers over the scripted
  backend, `codeoid ls`, `codeoid settings ls`, a clean SIGTERM shutdown.
- **`scripts/check-upgrade.ts`:** installs the last published release from npm
  (`--from` to pick another), whose Claude turns run against aimock, and records
  a session that states a fact and one with a tool round. This build then
  starts on the same data: both sessions are listed and answer, and aimock's
  journal shows the backend was handed each one's history (the fact, the tool's
  output); a second restart is clean; no resume or migration errors are logged.

Still to add to the upgrade data: checkpoints and a rewind, a fork, routines,
accounts, a workstream, the memory DB.

### Tier 2: backend conformance (real harnesses, mock provider)

Every backend's real harness (the Claude Code CLI, Codex, opencode, pi, the
Gemini CLI, Qwen Code, and codeoid's in-process openai/gemini/llamacpp
providers) runs inside a real daemon, but talks to **aimock**
([`@copilotkit/aimock`](https://github.com/CopilotKit/aimock), MIT, zero
dependencies) instead of a vendor. Firehog already gates on it
(`highflame-matrix` and `highflame-matrix-replay`). aimock serves every wire
codeoid's backends use from one local port: Anthropic Messages (with
`count_tokens` and the model list), OpenAI Responses over HTTP and WebSocket
(including Codex's namespaced and `apply_patch` tools), Chat Completions, and
Gemini `generateContent`. Fixtures script multi-turn tool rounds (`hasToolResult`,
`turnIndex`, `toolCallId`), its journal shows every request a harness made, and
its chaos options serve 429s, 500s and mid-stream disconnects. No credentials,
no spend, deterministic, so it runs in CI on every PR, not just per release.

Spike (2026-11-22): the real Claude Code CLI ran a scripted `Write` round
(file created, reply after the tool result) in 75 ms; the real Codex CLI 0.166
ran a scripted `exec_command` round; the Gemini CLI reached aimock's
`generateContent` but needs a fixture for its model-router call (or the router
off). opencode, pi and Qwen are not spiked yet.

Two kinds of fixture:

- **Scripted journeys** (hand-written, per backend, since each harness names
  its tools differently: `Write` / `exec_command` / `write_file` …). They are
  the CI suite.
- **Recordings** (`--record` against the real providers, once per backend
  version bump, a few dollars; committed; replayed with `--strict`, so a
  request without a recording fails instead of passing). They catch a harness
  or SDK update that changes what it sends, which is what broke worktrees in
  Claude Code 2.1.323 (#478).

The e2e harness (`e2e/harness.ts`) gains an aimock mode: it starts aimock with
the journey's fixtures, points each backend at it (`ANTHROPIC_BASE_URL`, a
Codex `model_providers` entry, `GOOGLE_GEMINI_BASE_URL`, an opencode provider,
`OPENAI_BASE_URL`), keeps the backends enabled, and asserts both what the user
sees and what reached aimock (its journal). The journeys, for every backend:

1. create a session, one turn, a reply;
2. a tool call that needs approval: approve once, deny once (guarded mode);
3. edit a file in the workdir; the edit and its checkpoint exist;
4. the sandbox holds: a write outside the workspace is refused, a read of a
   hidden credential fails (autonomous mode);
5. interrupt mid-turn (aimock journals the request `interrupted`); the session
   is usable after;
6. restart the daemon; the session resumes with its history;
7. fork at a turn and switch backends; the forked backend receives the
   parent's history (asserted on aimock's journal, not on a model's recall);
8. thinking effort and model switch reach the wire (the request's model and
   effort fields);
9. usage and cost are reported from the fixture's usage (or marked unknown,
   never $0);
10. a 429 from the provider: the fallback model is used (Claude) or the turn
    fails with the provider's message, and the session recovers.

Output per backend × journey: pass, fail, or not run (with why). This replaces
the token-spending half of `src/tests/backends.integration.test.ts`; its
FRESH/RESUME journeys become 1, 6 and 7.

### Tier 3: quality evals

The eval runner designed in `docs/native-agent-loop.md` §9, phase 0 only:

- **Runner:** `codeoid eval run <suite> --targets …`, one isolated daemon per
  run, targets driven through `session.compare`, graded by the evidence runner
  (owner kind `eval`). The agent's own claim is never the grade.
- **Suite for releases: `codeoid-core-release`,** 12 tasks drawn from the
  designed 30, chosen to touch what releases break: a multi-file edit with
  tests, a shell-driven bug fix, a long log to diagnose, recall from an earlier
  session, a refusal at the sandbox boundary, a fork that must continue the
  work, an approval-gated change. Each task: a repo snapshot, a prompt, checks
  that decide pass/fail, a budget.
- **Targets:** claude (default model) and codex at minimum, on real models:
  a mock can prove codeoid and the harness behave, not that an agent still
  solves tasks. A local model on llama.cpp gives a free run of the same suite
  on every candidate, as a trend line; the paid run is per release.
- **Protocol:** 3 repetitions, alternating order; `protocol.json` written before
  running; results stored in the evals store (`/data/codeoid-evals` layout, one
  run file per candidate).
- **Release rule:** pass rate per target no lower than the last release's beyond
  noise (fails if the drop is larger than one task out of 12 averaged over the
  repetitions), and median cost and wall time per solved task not more than 25%
  higher. Flags (`flaky`, `saturated`, `no-lift`) are reported, not blocking.

### Tier 4: performance benchmarks

A committed `bench/` with a synthetic data generator (the #457 shape: 147
sessions, a long tail of transcripts and canonical logs) and scripts that print
JSON. Each runs 5 times; the median is compared to the last release's.

| Benchmark | Measures | Fails when |
|---|---|---|
| startup | start → `/health` ready, with 0 and 147 sessions | > 20% slower |
| memory | RSS and heap+external after start, after opening the 20 newest | > 15% more |
| turn overhead | daemon latency per scripted turn (prompt in → first event out, turn end → idle) | > 20% slower |
| attach | replay of a 5 MB session: time to last frame, max gap between frames (#458) | any run > 10 s, or median > 20% slower |
| shutdown | SIGTERM → exit with 10 idle and 2 busy sessions | > 20% slower or over the 30 s grace |
| bundle | installed package size, web bundle size | > 10% bigger without a note |

Run on a dedicated CI job (same runner class each time) and, for the record,
on the release owner's machine.

### Tier 5: platforms

- **macOS:** a `macos-15` CI job runs the unit suite, the Seatbelt sandbox's
  real tests (the items of the "To verify on a real Mac" checklist in
  `docs/sandbox.md`, turned into tests), and the tier 2 journeys against
  aimock. macOS runner minutes cost more, so it runs on release candidates and
  nightly, not on every PR.
- **Docker sandbox:** a CI job with `CODEOID_TEST_DOCKER=1` runs
  `sandbox-docker.test.ts`.
- **Codex in sandbox-real:** install the `codex` CLI there, so its real-sandbox
  tests stop skipping.
- **Bun:** the unit suite on `.bun-version` (CI) and on the latest Bun.

## The report and the decision

`bun run release:gate --candidate <sha>` runs tiers 1–4 (tiers 2–3 need
`--with-backends`), and writes `release-gate/<version>/report.md` and
`report.json`:

- per tier: pass / fail / not run, with evidence ids;
- the deltas against the previous release (evals, performance);
- known issues carried into the release, each with a reason
  (e.g. qwen's read-only shell commands bypass the gate; #442 Codex in
  autonomous mode has only the sandbox as its boundary);
- waivers, each with who waived it and why.

**Go** when tiers 0, 1, 2 (required backends) and 4 pass, tier 3 shows no
regression, and every tier 5 item is ticked or waived. The report is attached
to the GitHub Release and its results become the next release's baseline.

## Build order

1. Tier 0 (fixes a release that can't publish today) and tier 1. Done.
2. Tier 2: aimock mode of the e2e harness, journeys for claude and codex
   first (both spiked), then the other backends; recordings after.
3. Tier 4 benchmarks with a first baseline taken on the last release (0.4.4)
   and on main.
4. Tier 3 eval runner (phase 0 of the native-loop eval design) and the
   12-task release suite, with a baseline on 0.4.4 and on main.
5. The report generator and `release:gate` that ties them together.

Steps 1–3 and the macOS job are free to run and fully automated; they are
enough to cut 0.5.0. Tier 3 needs real models and joins after.

## Not in scope

- Public benchmark claims (SWE-bench, terminal-bench scores); the native-loop
  design covers those.
- Load testing a shared multi-user daemon.
- The mobile app's release.
