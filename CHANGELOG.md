# Changelog

All notable changes to **codeoid** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-07-29

codeoid moves to the Highflame npm org. npm has no way to transfer a package
between scopes, so all three published packages are renamed rather than moved,
and their versions are unified onto one line so a single tag cuts the whole
release.

### Changed

- **Renamed on npm** — the packages now ship from the `@highflame` scope:

  | Before              | After                         |
  | ------------------- | ----------------------------- |
  | `codeoid`           | `@highflame/codeoid`          |
  | `@codeoid/protocol` | `@highflame/codeoid-protocol` |
  | `@codeoid/core`     | `@highflame/codeoid-core`     |

  Install with `bun install -g @highflame/codeoid`. The binary is still
  `codeoid`, and no runtime behaviour changed. The predecessor packages are
  deprecated on npm and frozen at `0.3.4` / `0.2.0` / `0.2.0`; existing installs
  keep resolving. Downstream consumers (the mobile app, any external importer)
  need to update their dependency names — the import specifiers changed with the
  package names.

- **Lockstep versioning.** All three packages now ship at the same version from
  one `vX.Y.Z` tag, replacing the per-package "publish only if the version is
  new" logic in the release workflow. `bun run check:versions` enforces it on
  every PR, in `bun run smoke`, and against the tag at release time;
  `bun run version:set <x.y.z>` is the only sanctioned way to bump. The wire
  protocol version (`PROTOCOL_VERSION`) remains a separate, independently-moving
  number.

### Fixed

- **The client core was an undeclared dependency of the CLI.** The TUI renderer
  and the Telegram frontend both statically import `formatCollaborationCost` from
  the client core (added in 8e709ec, after `0.3.4`), but it was never listed in
  the CLI's `dependencies` — only the protocol package was. A registry install
  would have had no client core in `node_modules` and failed to resolve the
  import on any code path reaching either module, `codeoid attach` among them.
  Caught before it shipped: `0.3.4` predates the import and is unaffected. Now
  declared, and verified by installing the packed tarball and resolving that
  module.

- **`web/` no longer needs the registry to install.** `web/` is a separate
  install root, so the workspace packages come in as `file:` copies — but the
  core package's peer range on the protocol package was still resolved from the
  registry, meaning a fresh `bun install` in `web/` depended on what had been
  published rather than on the working tree (and broke outright for a
  not-yet-published package name). An `overrides` entry pins that peer to the
  in-repo copy.

## [0.3.4] - 2026-07-23

The governed pipeline becomes reliable end-to-end. Phase boundaries are now
decided by deterministic workspace probes instead of a text sentinel, the
phantom-turn hang that stalled runs is eliminated at its root cause, and a
pack's skill-declared shell commands are gated behind an explicit human
approval.

### Added

- **Deterministic, backend-agnostic phase detection** (`pipeline` probes): phase
  completion moves off the fragile `⟦PHASE-COMPLETE⟧` text sentinel onto
  daemon-run probes that behave identically on every backend, scoped entirely to
  pipeline phase turns (normal sessions and a user's own messages are untouched).
  Read-only probes (`file-exists` / `glob-nonempty` / `git-diff-nonempty`,
  confined to the workdir) and execution probes (`build` / `test` / `lint` /
  `verify`, auto-derived from `go.mod` / `package.json` / `pyproject` / `Cargo`
  and fail-closed on an untrusted pack). A phase's exit probe is now a real
  workspace predicate, so `passed` means the deliverable actually exists or
  builds; a failing exit probe under `onFail: retry` threads the failure reason
  into the re-run prompt. Opt-in `skipWhenSatisfied` marks an already-satisfied
  phase `skipped` at first entry only — off by default, so a stale artifact is
  never silently accepted. Adds a `skipped` phase outcome across interface, wire,
  web rail, and TUI. (#227)

- **Human approval for pack skill-declared shell commands**: an installed pack's
  skills can run a host shell at slash-command expansion time — before the agent
  loop, where a headless session has no approval path. codeoid now derives a
  least-privilege, verbatim allow rule per declared substitution and gates first
  use behind a persisted, demand-driven approval (new `skill_command_grants`
  table keyed by workspace + the verbatim command). The prompt is raised only for
  the command a denial actually blocked on, and routed through `requestUserInput`
  rather than the mode-gated `canUseTool` path — so an autonomous session cannot
  silently self-approve. Skill linking is gated on pack trust (an untrusted pack
  contributes no runnable skills), and each skill is granted read access to its
  own tree. (#233)

### Fixed

- **The pipeline phantom-turn hang, fixed at the root**: pipeline phases would
  hang, nudge before the model had worked, or "complete" a phase by reusing the
  previous phase's summary. The cause was two-fold — the canonical history
  accumulator committed an assistant turn on every `turn_done`, including the
  content-free one the Claude provider emits when it rebuilds its query loop; and
  that rebuild was itself triggered by a live workspace memory index embedded in
  the per-turn system-prompt append, whose byte count oscillated every turn and
  SIGTERM'd the in-flight turn. Now a turn is committed only when it produced
  text, tools, or thinking; the memory index is frozen into the append once per
  context (re-snapshotted on rotation) so it changes only on a meaningful event
  like a phase role switch; phase turns are detected by last-turn role and
  genuinely-new final text instead of a racy history-length watermark; and
  history is re-baselined after `send`. (#228, #229, #230, #231)

- **`AskUserQuestion` is never auto-approved**: an elicitation is a user-input
  requirement by definition, but autonomous workers (dispatch / fleet)
  auto-approved it like any write tool and it returned "the user did not answer
  the questions" with no dialog rendered. It is now a hard block in every mode —
  an autonomous worker parks as `waiting_approval` until the owner attaches and
  answers. (#226)

- **Turns the SDK silently never ran are surfaced**: a blocked slash-command
  expansion made the SDK report `num_turns: 0` as a `success` — a turn that never
  happened, dressed as one, with nothing shown to the user and no retry or error
  path. A zero-turn result is now treated as an error and attributed to the
  `<local-command-stderr>` that caused it. In a pipeline, a zero-turn from a
  blocked skill command parks the turn as `approval_pending` / `waiting_approval`
  so the phase stays alive and resumes in place on approval, rather than failing
  the run. (#232, #233)

- **Pipeline-created session appears immediately**: starting a run left the UI on
  the empty "create new session" state for 30–50s (until the next reconnect) even
  though the daemon had created the session and the agent was already thinking,
  because `runPipeline` focused the bound session without adding it to the client
  session list. It now upserts a partial `SessionInfo` from the snapshot before
  focusing. (#237)

## [0.3.3] - 2026-07-22

The governed SDLC pipeline goes live end-to-end: fetch a methodology pack from a
registry, activate it on a session, and drive a real, attached run through its
phases with a human decision at every boundary.

### Added

- **Dynamic pack loading** (`pipeline.registries`): turn pack loading from a
  boot-only config read into a live, curatable surface. Add a git pack REGISTRY,
  discover its packs, and install / remove / trust / select them at runtime —
  each change registered into the live pipeline manager and persisted to
  `config.json`. Untrusted by default, so a fetched pack's shell command-gates
  stay fail-closed until an explicit trust. Ships over the wire
  (`pipeline.pack.*` + `pipeline.registry.add`, new owner-tier `pipeline:manage`
  scope), as a `codeoid pack …` CLI group, and as a web Pack Browser. (#214, #215)

- **Ambient pack activation** (`session.create --pack [--pack-role]`): activate
  an installed pack on a session, separate from a governed run. Its constitution
  is injected into the system prompt, its subagents are handed to the backend,
  and an optional capability role gates the session's tools — a read-only role
  (`write:false` / `network:false`) denies write/network tools at the call-time
  `canUseTool` gate, cross-backend. `SessionInfo.profile` shows the active pack
  and role, and a web new-session pack/role selector rides the same verbs. (#216)

- **Governed run cockpit** (`/pipeline`): trigger a governed run with a goal and
  auto-advance through the pack's phases, steering each at its boundary with
  Approve / Revise / Reject. Revise records the human feedback on the halted
  phase and re-runs it with the feedback + prior output threaded into the prompt.
  Each phase runs under its own capability role (a reviewer phase is read-only,
  an implementer phase can write). Adds `pipeline.revise` (`pipeline:answer`) and
  a `codeoid pipeline run/status/list/approve/reject/revise` CLI. (#217)

- **Conductor over a live session**: a governed run now drives its phases on one
  real, attached session instead of a headless per-phase worker — so the run is
  visible, you can talk to it, and there is no per-phase timeout on an attended
  session. Every phase halts at its boundary for a human decision (a passing gate
  no longer auto-advances), the bound session swaps capability role per phase,
  and the web `/pipeline` cockpit opens the extended create-session dialog
  (name / workdir / goal / pack), auto-attaches the run session, and is
  chat-primary with the cockpit as an overlay. (#219)

### Fixed

- **Agent identity & delegation in the ZeroID registry**: codeoid identities now
  render correctly in the Highflame identity registry / delegation explorer.
  Session and sub-agents register as owner-attributed code agents
  (`identity_type: "agent"`, `sub_type: "code_agent"`), a sub-agent is attributed
  to the human owner (not the parent WIMSE URI) so Studio's code-agent roster
  surfaces it, and the canonical `parent_*` linkage keys are written. Sub-agent
  tokens are delegated from the parent's already-scoped subject token via an
  RFC 8693 token-exchange, restoring the real `parent_jti` delegation edge; a
  genuine delegation failure is now a loud, audited degradation instead of a
  silent root-token fallback. (#218, #220)

- **A phase execution error fails the run** instead of halting to a green
  "passed": an errored phase kind / runner (a thrown or non-idle turn) used to be
  parked as "halted" and could be approved into `status: "passed"` — showing a
  phase that never ran as green. An execution error is not a reviewable gate
  verdict, so it now fails the pipeline (after any retry budget); gate rejections
  still halt for the Approve / Revise / Reject decision. (#221)

- **Pack skills resolve on the Claude backend**: an installed pack links its
  runnable skills into `~/.claude/skills/`, but the backend ran with
  `settingSources: ["project"]` and never discovered them, so a `/spec`-style
  invocation came back "Unknown command". The backend now loads the user tier as
  well (`settingSources: ["project", "user"]`) and enables every discovered skill
  (`skills: "all"`); pack subagents are still injected programmatically, so
  nothing double-loads. (#222)

## [0.3.2] - 2026-07-21

### Added

- **SDLC pipeline primitive** (`pipeline.*` control plane, off by default): a
  methodology-agnostic pipeline engine that advances a session through declared
  phases behind entry/exit gates. Ships as four plugin seams (`PhaseKind`,
  `GatePlugin`, `SkillPlugin`, `Pack`) over a Map-backed registry, with durable
  `bun:sqlite` state and boot-time `resume()` / `driveResumable()` so in-flight
  pipelines survive daemon restarts. A `skill` phase kind runs `fn` skills
  natively and drives prompt/slash skills on a disposable worker session
  (`SessionPhaseRunner`, honoring per-phase provider/model); a non-idle worker
  turn fails the phase closed. The wire adds `pipeline.create` / `list` / `get`
  / `answer` / `abort` / `advance` (`pipeline:create` / `read` / `answer`
  scopes, tenancy-checked) plus `SessionInfo.phase` / `profile`. Gated on
  `config.pipeline.enabled` (default `false`) — the daemon stays freestyle
  until a pack is selected.

- **Declarative pack loader + create-from-pack** (`pipeline.packs` config): a
  pack is a directory of DATA (`pack.yaml` + role files + constitution), not
  code, so a whole team can share a methodology by fetching it from a registry.
  `loadPack(dir)` validates and compiles a pack into a runtime `Pack`, and
  `create({ pack })` runs it by id (phases XOR pack; `defaultPack` fallback).
  Packs load from config at boot (fail-soft — a malformed pack is skipped, not
  fatal) and create-from-pack works over the wire. Untrusted packs (the
  registry default) fail command gates closed and run no host commands; pack
  paths are realpath-confined so a symlink or `..` can't escape the pack dir.
  `PhaseDef.role` carries a per-phase capability role onto snapshots (→ Cedar /
  Shield enforcement in a later slice).

- **MCP Servers settings surface** (`/settings`): a read-only "🔌 MCP Servers"
  view listing every registry server (from config + imported from
  `~/.claude.json`) with its transport, trust, scope, backends, and live
  health. Health is observed from normal use — opening settings runs no probe
  and has zero side effects. Backed by `McpServerStatus` and an optional
  `mcpServers` field on `SettingsSnapshot`.

- **Embedded-handoff ZeroID token from the URL hash**: when the web UI is framed
  by a host app (Highflame Studio), it consumes a short-lived
  `#codeoid_token=…` from the iframe URL, stores it, and scrubs it from the
  address bar — skipping codeoid's own sign-in inside the frame. It is a no-op
  at the top level, and the daemon still verifies the token (JWKS signature,
  tenancy, expiry) on every WebSocket, so this skips only interactive sign-in,
  never authorization.

### Fixed

- **Cross-cutting audit fixes** across pipeline, protocol, store, and session.
  `session.fork` regained `isolate` / `workdir` / `baseBranch` (dropped from the
  wire schema, which had forced isolation on and left bind-mode / clean-base
  fork dead); `usage.daily` is now scope-gated (`SESSION_LIST`) instead of
  readable by any token; `findByName` is tenant-scoped (closing a cross-tenant
  name probe and a Telegram `/attach` self-detach). Runtime: the Gemini
  provider's MCP tool-discovery rejection is guarded (previously an unhandled
  rejection that hung the turn); dispatch event delivery gained a re-entrancy
  guard (no double token spend); a corrupt or version-drifted pipeline-store row
  is skipped rather than sinking boot resume; and pack `retry:N` now means N
  retries (was N total attempts, so `retry:1` aborted immediately).

## [0.3.1] - 2026-07-19

> Backfilled: 0.3.1 was cut as a version-bump-only release and shipped without
> a CHANGELOG entry. This section documents what it carried.

### Added

- **Registry-driven cross-backend MCP mounter**: declare an external MCP server
  once in config and it mounts across every backend (claude, openai, gemini,
  codex, gemini-cli, pi) under one canonical `mcp__<server>__<tool>` name and a
  single `canUseTool` approval gate. Daemon-owns-client by default with a
  native-passthrough escape hatch, a transport-neutral config schema, per-server
  health/observability, and import of servers from `~/.claude.json`. (#197 design
  + foundation, #198 claude/openai/gemini, #199 codex/gemini-cli natives, #201 pi
  backend + import + observability)

- **Verbatim Working Set (VWS) memory across all backends**: a context-strategy
  seam plus a shared, transport-neutral recall registry (`recall`, `recall_file`,
  `timeline`, `get_episode`) so every backend can page the verbatim store on
  demand — rolled out claude → gemini-cli/codex (via a shared in-daemon MCP
  endpoint) → pi/openai/gemini. Opt-in via `CODEOID_CONTEXT_STRATEGY=vws`; the
  default stays `transcript`. (#179 seam, #180 Claude, #182 gemini-cli/codex,
  #183 pi/openai/gemini)

- **Provider dialogs + `ask_user` on non-Claude backends**: `session.ui_request`
  now renders on Telegram too (web + codeoid-ui already did), and openai/gemini
  gained an `ask_user` tool, so any backend can ask the user an open-ended
  question mid-turn rather than only Claude (`AskUserQuestion`) and codex/pi
  (native dialogs). (#184, #185)

- **Config-file-driven settings surface**: a declarative settings manifest
  (every knob, including a per-backend tab) served over `settings.schema`, a
  daemon settings store with `env > config.json > default` precedence +
  provenance, a tabbed Settings drawer in the web client (a pure manifest
  renderer), and a `/settings` command (web opens the drawer; Telegram summarizes
  non-default config, never secret values). (#186 manifest + RPC, #187 web
  drawer, #188 `/settings` command)

- **Per-sandbox ZeroID registrar-key auth**: a `ZEROID_REGISTRAR_KEY` per-sandbox
  credential lets the daemon register REAL agent identities against a secured
  ZeroID instead of degrading to `anonymous:*` — the build Forge pins for its
  agent-workspace image. (#200)

- **Embed SSO via URL-hash handoff**: an embedding parent (e.g. Highflame Studio)
  can pre-authenticate the web UI by handing a short-lived
  `#codeoid_token` / `#codeoid_key` in the URL hash; the UI persists it into the
  normal sign-in slot and scrubs it from the URL/history. (#195)

### Fixed

- **codex MCP tool calls were auto-denied in guarded/interactive mode**: codex
  gates every MCP call behind `mcpServer/elicitation/request`, which codeoid did
  not handle, so the elicitation fell through, threw, and codex read it as a
  declined call — auto-denying every MCP tool, including read-only memory recall.
  Now handled. (#196)

- **codex's native approval policy now follows the session mode**: switching a
  codex session to autonomous now maps onto codex's own `approvalPolicy` +
  sandbox (previously pinned to `untrusted` from env), so autonomous codex stops
  asking per action. (#181)

- **Forks inherit the parent's execution mode**: `session.fork` always built the
  child in `guarded`, so a fork of an autonomous session stalled behind approval
  prompts (auto-denied when unattended). Forks now inherit the parent's mode +
  remaining autonomous budget, including cross-backend (metaharness) forks. (#194)

## [0.3.0] - 2026-07-14

### Added

- **Mid-session provider switching** (`session.set_provider`, `/provider
  <id>`): swap a live session's backend (claude ⇄ pi ⇄ gemini ⇄ openai)
  while keeping the session id, scrollback, transcript, and identity. The
  generic switch loop tears down the outgoing backend, re-mints the backing
  id (an incoming backend never resumes the outgoing one's native state),
  resets the model to the new backend's default, and offers the accumulated
  canonical history to the incoming provider via the new optional
  `seedFromHistory()` — stateless backends no-op it (they consume
  `TurnOpts.history` natively), warm backends (claude, pi) prepend a
  rendered transcript (`renderHistorySeed`, newest-turns-first truncation)
  to their first post-switch prompt. Fidelity contract: the new backend
  gets a faithful TRANSCRIPT, not a native continuation. Fail-closed on
  unknown ids, rejected mid-turn (interrupt first), serialized against
  racing prompts, seed failures degrade to an unseeded switch, and every
  switch is audited + announced in the transcript with structured metadata.

- **pi is now an officially supported session backend** (`providerId: "pi"`,
  [docs/providers-pi.md](docs/providers-pi.md)). One codeoid session = one
  warm `pi --mode rpc` subprocess; pi's own session file is the backing id,
  so daemon restarts resume the same pi conversation. What flows through:
  - **pi extensions work end-to-end** — hooks run inside pi; extension
    dialogs surface as codeoid `session.ui_request` dialogs, notifications
    become transcript rows, and extension/prompt/skill slash commands feed
    `session.commands` (invoke as `/name args` from any client).
  - **codeoid's approval gate covers pi tools**: an injected bridge
    extension routes every pi `tool_call` through `canUseTool` (modes,
    budgets, `session.approve`, audit). pi has no native permission system,
    so a missing bridge fails turns CLOSED, and any tool that executes
    ungated is flagged loudly.
  - Steering (`now`/`next` → pi steer, `later` → follow-up), model
    switching (`provider/model-id`), per-turn usage deltas, rotation via
    pi `new_session`.
  - Config: `providers.pi.{enabled, command}`.
- **Provider selection is user-facing**: `session.create` accepts
  `providerId` (fail-closed on unknown ids), `auth.ok` advertises the
  daemon's registered `providers` (default first), and the web UI's
  new-session modal grew a backend picker.

- **Provider extension surface** — the wire-additive groundwork for
  non-Claude backends (pi harness next) to expose their full feature set
  through codeoid:
  - **Provider-initiated dialogs** — new `session.ui_request` /
    `session.ui_response` / `session.ui_resolved` messages let a provider (or
    its extensions) ask the user something that is not a tool approval
    (confirm gates, pick-one lists, free text, editors). Daemon-enforced
    timeouts, attach re-delivery, first-answer-wins across clients, interrupt
    cancellation, and stall-watchdog integration. Gated on the new
    `ui.dialogs` capability; the web UI renders them in a new `UiRequestBar`.
  - **Dynamic provider commands** — `session.commands` returns the backing
    provider's slash-command catalog (extension commands, prompt templates,
    skills). Clients pass unknown-but-catalogued verbs through as prompt
    text (`parseSlash` `isProviderCommand` option); the provider expands
    them. Gated on the `commands.dynamic` capability.
  - **Rich parts, actually rendered** — providers can emit standalone
    `custom_message` events with `ContentPart[]`; the web UI now renders
    parts (code, diff, table, tree, progress, image, anchor, button) via a
    new `PartsView`, and `ButtonPart` gets its missing return path: the new
    `session.part_action` verb validates the button against the real message
    and forwards it to the provider's `handlePartAction`.
  - **Provider-declared approval forms** — `tool_start.patchableKeys` lets
    any backend declare which input keys a client may patch on approval,
    generalizing the hardcoded AskUserQuestion whitelist (which remains the
    fallback).
  - **ProviderRegistry wired in** — session backends now come from a
    factory registry built once at daemon startup (previously dead code next
    to a hardcoded `switch`); adding a backend is one `register()` call.
    Unknown provider ids still fall back to the default so resume survives
    metas written by newer codeoids.

### Fixed

- Forked sessions now appear in the sidebar and are focused immediately. `request()` resolves to the daemon's `response.ok` envelope, so the fork handler must unwrap `.data`; reading the envelope directly meant the new fork never entered the store (also affected forking an already-forked session).
- `codeoid --version` is now sourced from `package.json` instead of a hardcoded string, which had drifted (reported `0.1.0` while the package was `0.2.0`).

### Changed

- Added `bun run smoke` — a pre-release gate that mirrors CI (lint / typecheck / test / build for the daemon and web) and adds a version-coherence check, a daemon boot probe against the built bundle, and an opt-in real-backend journey suite (`CODEOID_SMOKE_INTEGRATION=1`).
- Restructured the README into a slim overview with detail moved to `docs/` (`FEATURES.md`, `CONFIGURATION.md`, `COMPARISON.md`), and corrected the positioning throughout to reflect that codeoid is a multi-harness control plane (Claude, Codex, Gemini, OpenAI, pi, Gemini CLI), not Claude-only.

## [0.2.0] - 2026-07-06

### Added

- **`@codeoid/protocol`** — the client↔daemon wire protocol (message/event
  types, `PROTOCOL_VERSION`, permission scopes, published input `LIMITS`) is
  now a standalone npm package, the single source of truth consumed by the
  daemon, the web UI, and the upcoming mobile client. Runtime validation
  schemas ship as an optional subpath (`@codeoid/protocol/schemas`, zod as an
  optional peer). (#101, #102, #105)
- **`@codeoid/core`** — framework-agnostic client core: the WebSocket
  transport (auth handshake, request correlation, heartbeat, jittered-backoff
  reconnect, injectable timing), transcript-accumulation semantics
  (`MessageStore` + kernels with full broadcast routing via `ingest()`),
  `replay.resume` cursor tracking, and shared display helpers. The web UI now
  consumes it; the mobile client is next. (#115)
- **Typed auth handshake + capability negotiation** — clients declare
  `protocolVersion` and `capabilities` on the auth frame; the daemon answers
  with its own on `auth.ok`. (#102)
- **Incremental resume (`replay.resume`)** — reconnecting clients replay only
  the tail mutated since their cursor instead of the full scrollback; falls
  back to a snapshot on daemon restart. (#103)
- **Send idempotency (`send.idempotency`)** — `session.send.clientMsgId`
  dedupes ambiguous-delivery retries so one prompt can't become two billed
  turns. (#103)
- **Live model catalog persistence** — the daemon persists the model catalog
  each backend reports (designed provider-agnostic), so restarts and the
  `/model` picker serve current models instead of a hardcoded list that goes
  stale. (#78, #79)

### Security

- **Untrusted-content sinks sanitized**: terminal output and markdown
  link/image URLs from model/tool output are now sanitized before reaching
  dangerous sinks — a `javascript:` link or remote-image exfiltration channel
  in rendered output is dropped. (#91)
- **Cross-tenant memory disclosure fixed**: memory workspace ids were derived
  from the working directory alone, so co-located accounts sharing a path
  could cross-read each other's episodes via `recall`/`timeline`/search.
  Workspace ids are now tenant-scoped. (#93)

### Fixed

- **Daemon**: the 300s turn-stall watchdog force-recovered sessions running
  long tools (multi-minute Bash, Task subagents, web research emit no events
  until completion) and killed runs when a message or a >5-minute-pending
  approval arrived mid-tool. Silence now only counts as a stall while the
  model should be generating; tool execution and pending approvals pause the
  watchdog (finer-grained hung-tool protection is unchanged). (#104)
- **Daemon**: a scrollback replay larger than the WS backpressure limit
  force-closed every client that attached — a permanent reconnect loop on
  large sessions. Replays are now chunked and paced on socket drain, which
  also makes first paint incremental on big sessions. (#84, #100)
- **Daemon**: inbound frames are now schema-validated (unknown fields
  stripped per the additive-protocol contract, unknown verbs and
  out-of-bounds payloads rejected) — including a size cap on `session.send`
  text as a token-bill safety net. (#102)
- **Client core**: the initial auth handshake now has a deadline (a peer that
  accepted the socket but never answered previously hung `connect()`
  forever); concurrent `connect()` calls join the in-flight attempt instead
  of throwing; duplicate request ids are rejected instead of silently
  clobbering the earlier request; one throwing subscriber can no longer break
  message/status dispatch for other subscribers. (#115)
- **Web**: retired the hand-maintained protocol mirror (and with it, dead
  handling for a `"working"` status no released daemon ever emitted). (#105)
- **Web**: stale fallback model names in the model picker refreshed to the
  current Claude lineup. (#78)

### Performance

- **Daemon event loop unblocked**: status flips, workspace-id probes, and
  `fs.list` did synchronous/redundant work on the single-threaded event loop,
  stalling token streaming for every session in the process. (#95)
- **Transcripts bounded**: rotation + streaming tail load + output caps — a
  months-old session with a multi-hundred-MB transcript could previously
  block daemon startup past its deadline or OOM it on resume. (#96)
- **Memory recall**: the per-workspace vector cache is appended on embed
  instead of cleared (recall was re-reading and re-decoding every embedding
  BLOB per query during active work), and clustering is single-flight per
  workspace with lean hydration and a yielding k-means. (#94, #97)
- **Web streaming**: markdown is no longer re-parsed from scratch on every
  streaming delta, and the message reducers use O(1) positional lookups
  instead of per-delta scans (O(N²) over a long session). (#98, #99)

## [0.1.3] - 2026-07-03

### Fixed

- **Daemon**: streamed assistant/thinking messages were pushed into scrollback
  twice (stream start + finalize) — duplicating rows on every replay/attach,
  splitting memory episodes into promptless halves, and drifting the byte
  accounting negative so the 20MB scrollback cap never fired. Scrollback now
  upserts by messageId with real UTF-8 byte accounting, and the transcript
  `seq` counter resumes past the persisted tail instead of restarting at 0. (#74)
- **Web**: transcript virtualizer was never notified on count/session changes
  (stale layout ghosting after session switches and size-cache poisoning — the
  residual cause of the row-overlap bug #73 targeted); scrolled-past rows
  leaked their DOM subtrees forever; `session.list` was ingested twice per
  refresh and rebuilt every sidebar row; pending-approval and notification
  watchers re-scanned the full transcript on every streaming delta; usage
  analytics showed *global* totals to identities owning zero sessions and
  broke past ~1000 sessions (SQLite variable limit); analytics chart mixed
  local-time and UTC day buckets. (#75)
- **Telegram**: every streamed assistant/thinking block was delivered twice;
  one unhandled handler error (e.g. `/ls` rendering an unescaped
  `tool_running` status) permanently stopped long polling; flood-limited
  (429) messages vanished silently — grammY auto-retry now honors
  `retry_after`; interleaved broadcasts mid-stream dropped or duplicated
  streamed text; >4000-char replies could arrive with chunks out of order;
  tool completion/cancellation states never rendered; buffered content was
  silently discarded on session switch/detach and stale broadcasts from a
  detached session could write into the new session's chat. (#76)

## [0.1.2] - 2026-06-28

### Fixed

- File explorer now switches working directory when the active session changes,
  instead of staying pinned to the previous session's workdir.
- Interrupted tool calls are marked **cancelled** rather than **failed**, and
  in-flight tool calls are reconciled correctly on session resume.
- Guard `writeBatch` against in-flight streams to stop the TUI double-printing
  streamed output.
- TUI reconnects and re-mints its token on JWT expiry instead of stalling.
- Telegram `/attach` now disconnects the old session before switching, fixing a
  session leak on switch.

### Changed

- Richer README badges (npm version + downloads, coverage, provenance).

## [0.1.1] - 2026-06-24

### Added

- Install-from-npm instructions in the README.

### Changed

- CI publishes to npm via OIDC Trusted Publishing (tokenless), with provenance.

## [0.1.0] - 2026-06-23

Initial public release.

### Added

- Identity-first daemon (Bun) that owns every session; stateless clients attach
  over a versioned WebSocket protocol (`PROTOCOL_VERSION`).
- Cross-session **verbatim memory** — SQLite + FTS5 + vectors, exposed to Claude
  as an in-process MCP server (`recall`, `recall_file`, `timeline`), workspace-scoped
  on `git-common-dir` so worktrees share one memory.
- Frontends: built-in Ink TUI, SolidJS web UI (served at `/ui`), Telegram bot.
  The recommended native Rust TUI lives in
  [codeoid-ui](https://github.com/saucam/codeoid-ui).
- Execution modes (`guarded` / `interactive` / `autonomous` with a write-action
  budget), mid-turn streaming input, backing-session auto-rotation, declarative
  CLI-output compression, and device handoff with scrollback replay.
- ZeroID identity per session plus attenuated sub-agent tokens; every tool call
  is stamped with the acting agent's SPIFFE identity.

[Unreleased]: https://github.com/saucam/codeoid/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/saucam/codeoid/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/saucam/codeoid/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/saucam/codeoid/releases/tag/v0.1.0
