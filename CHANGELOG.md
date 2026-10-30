# Changelog

All notable changes to **codeoid** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Approvals judge what a shell command does** (#431).
  Every shell command an agent wants to run is parsed (pipelines, chains, subshells, `bash -c`, `sudo`, `xargs`, `find -exec` and other wrappers seen through) and given a risk level: low, medium, high, or not understood.
  The levels are guidance drawn from reading the command line, not a sandbox.
  High-risk commands (`rm -rf ~`, `git push --force`, `curl … | sh`, writes to start-up files, credential reads, `sudo`) and ones that can't be read ask in every mode, autonomous included, and a command naming one of codeoid's credential files is refused like the file tools, as a best effort: a command written in a way the reader doesn't recognise is medium instead.
  Low is a strict allow-list (vetted read-only programs, no options that run or write, no `cd`, variables, assignments, loops or writing redirects, every path inside the workspace), so `approvals.autoAllowLowRisk`, which lets guarded mode run low-risk reads without asking, can't be tricked into running anything unusual.
  Everyday idioms (`IFS= read -r`, `PATH=…:$PATH`, `EDITOR=vim`, arithmetic on loop counters) are medium, not not-understood, so they don't stall unattended runs.
  The approval prompt shows the level and the reason on every surface, and rewind's "not undone by going back" list uses the same reading.
  On Claude, a high-risk or not-understood command never runs on a `permissions.allow` rule without codeoid's gate seeing it.
  Protecting credentials and files outside the workspace for real needs the agent's commands to run in a sandbox, a separate issue.
  See [docs/approvals.md](docs/approvals.md), which lists the known ways past "high".

- **End-to-end tests against a scripted backend** (#429).
  `bun run test:e2e` boots a real daemon per test on a throwaway home and drives it through the web UI (Chromium, via Playwright) and the CLI, with a scripted backend that replays a written conversation instead of a model: no credentials, the same result every time.
  The first journeys: creating a session and seeing the reply and tool call, approving from the web UI, denying from the CLI while the web UI shows the request, a second device attaching mid-turn, a daemon restart, going back a turn with the files restored, forking from an earlier turn, and a backend error mid-turn.
  CI runs it on every PR. e2e/README.md says how to add one.

- **Choose how hard the model thinks, per session, on every backend** (#417).
  One scale (Default, Off, Minimal, Low, Medium, High, Extra high, Max), mapped to each backend's own setting: Claude's effort, Codex's and OpenAI's reasoning effort, Qwen's and pi's levels, Gemini's thinking budget or level, llama.cpp's chat-template switches, and the Gemini CLI's model settings.
  Set it from the web UI's **effort** selector, `/effort` (web, TUI, Telegram), `codeoid new --effort`, or `session.defaultEffort` for new sessions.
  It stays with the session, like its model; it applies live where the backend can take it, otherwise from the next turn, and never cuts a running turn short.
  The pickers offer the levels each model takes where the backend reports them (Claude, Codex, pi); elsewhere every level, marked as unknown.
  docs/thinking-effort.md says what each level means on each backend.

- **An MCP server added through Claude reaches every backend in that directory** (#395).
  codeoid imported only Claude's global servers, once at start; a `claude mcp add` (local scope) or a project's `.mcp.json` stayed Claude-only.
  Now each session sees, on every backend, its directory's servers too: your own always, a project's once approved — in Claude Code (read only from your `~/.claude.json`), or in codeoid after reviewing the entry in full (the drawer's **Review & approve**, or `codeoid mcp approve`, which prints it and approves only with `--yes <fingerprint>`), bound to exactly the entry shown.
  Changes apply when you ask: the drawer shows "MCP servers changed", and **Refresh MCP servers** (`/mcp refresh`, `codeoid mcp refresh`) restarts the backend, which resumes the conversation; it waits for a running turn or background work, and picks up global changes (`claude mcp add -s user`) too.
  A server that answers with the MCP sign-in challenge is held back from that account's backends that would only get 401s, and the drawer says to adopt it.
  Agents' file tools now ask before reading or writing `~/.claude.json` in every mode, since that is where Claude Code's approvals live.
  docs/mcp-backends.md says which server reaches which backend, and why.

- **Codex, the Gemini CLI and Qwen use OAuth MCP servers** (#396).
  An OAuth server in codeoid's registry (`"oauth": true`, or one adopted from Claude's config) used to reach only the daemon-run backends and Claude; Settings said "Not reachable from codex, gemini-cli, qwen yet".
  These backends now mount it through a loopback relay on the daemon, with a token that belongs to the session and ends with it.
  The server's own token stays in the daemon: the backend, its config, its argv and the agent's shell never see it.
  The relay carries the whole MCP protocol (tools, resources, prompts, progress, cancellation, and the server's own requests, such as asking the user a question), and a sign-in mid-session reaches a running session without a restart.
  The daemon's own MCP client now runs on the official MCP SDK for remote servers, shared with the relay.

- **Sign in to an MCP server from codeoid instead of an interactive Claude Code session** (#390).
  A remote OAuth server in Claude's own config (`~/.claude.json`, a `.mcp.json`) could only be signed in to through `/mcp` in a Claude Code terminal, so in a codeoid session it just reported "needs authentication".
  codeoid can now adopt it: "Sign in with codeoid" in the capabilities drawer, or `codeoid mcp adopt <server>` and `codeoid mcp signin <server>`, puts the same URL in codeoid's registry and runs codeoid's own sign-in, from any frontend.
  Claude sessions then use codeoid's copy, mounted in-process in front of the daemon's MCP client so the token never reaches the agent, and the CLI is told not to connect its own.
  OAuth registry servers now reach Claude at all, not only the daemon-run backends; a server that needs sign-in points at adopting it (for someone who may), with the command that finds it.
  Adopting is daemon-wide, so it is confirmed and bounded: plain names only (never one of codeoid's own), `https` URLs without credentials or wildcards, never over another server, a project's own server only with its URL named (`--url`), `settings:write` on a token's own, every attempt audited.
  Signing in or out applies to running sessions from their next turn; a refresh the server refuses signs the server out (Settings offers Connect), one that merely fails keeps the sign-in; `codeoid mcp signin --callback-url` finishes a sign-in without a terminal.
  codeoid never reads or writes the Claude CLI's credentials.

- **Forks, backend switches and rewinds continue the conversation natively on
  Claude and Codex** (#387). Until now a fork onto Claude, Codex or pi got a
  text transcript in its first prompt, with each tool's input and output cut
  to 2,000 characters and reasoning dropped, even when the fork stayed on the
  same backend. Now:
  - On the same backend, the backend forks its own conversation at the turn,
    so nothing is converted or cut and reasoning is kept. Claude uses the
    Agent SDK's `forkSession`; Codex uses `thread/fork`.
  - From another backend, codeoid hands the target native history: a Claude
    session file with real `tool_use`/`tool_result` blocks, verified with the
    SDK's own reader before use, or Codex history items through
    `thread/inject_items`.

  The transcript remains the fallback, for pi, the Gemini CLI, qwen, and any native
  path that fails. The session says which way it went, and
  `session.nativeContinuation` / `CODEOID_NATIVE_CONTINUATION` turns this off.
  Each turn now records where it ends in the backend's own conversation
  (`NormalizedTurnResult.nativeRef`, stamped on the canonical turn).

- **Routines: agents that run on their own** (#54). `codeoid routine add`
  saves an agent task that runs on a cron or interval schedule (IANA
  timezones, phase-anchored intervals, 60-second floor), once at a set time, from
  its own API endpoint (`POST /routines/<id>/fire` with a per-routine,
  revocable, rate-limited token), or on demand. A *check* command runs first:
  no output means nothing to do, and the run ends `silent` with no agent
  started and nothing spent. An agent that finds nothing worth reporting
  replies `[SILENT]`. The prompt can use `{{check}}`, `{{payload}}` and
  `{{last_summary}}`, inserted as delimited data the agent is told not to
  follow.

  Every run is an ordinary session you can open, approve, continue or fork.
  The daemon enforces the limits: guarded approvals or an autonomous tool
  budget, a wall-clock limit, per-run and per-day spend ceilings (a hard stop
  on Claude via the Agent SDK's `maxBudgetUsd`), skip-or-queue overlap,
  catch-up after downtime, and an auto-pause after repeated failures. A run
  that parks on an approval ends `needs_attention` and keeps tracking its
  spend after you approve. Fresh runs can each get their own git worktree.

  A routine is its owner's alone: teammates in the tenant can't see or touch
  it. No new scope: routines take `session:create` + `session:send`, plus
  `session:approve` for an autonomous routine or one with a check, and
  delegated tokens (teammates' share tokens, agents) can't change them. Check commands run with a
  scrubbed environment, never the daemon's secrets. Runs are
  attributed to `routine:<name>` under their owner in transcripts and the
  audit log. Outcomes reach your devices as a content-blind push (`notify`
  policy) and every run fires the new `routine_end` hook. Config:
  `routines.*`, `CODEOID_ROUTINES_ENABLED`, `CODEOID_ROUTINES_MAX_CONCURRENT`.
  Guide: [docs/routines.md](docs/routines.md).

- **Protocol (additive):** `routine.*` client messages and results,
  `SessionInfo.managedBy: "routine"`, and push kind `"routine"`.

- **Other agents can drive codeoid over MCP** (`/mcp/control`, #251). Claude
  Code, Cursor, or a CI job mounts one URL and can list sessions, read their
  transcripts and usage, wait on them, and — when the operator sets
  `mcpControl.allowActions` — create, prompt (`send_message` with `wait` returns
  the reply), interrupt, and destroy them. Off by default (`mcpControl.enabled`,
  or `CODEOID_MCP_CONTROL_ENABLED` / `CODEOID_MCP_CONTROL_ACTIONS` per run).

  It adds no authorization path of its own: the token is verified by the same
  verifier as the WebSocket handshake, and every tool is an ordinary protocol
  message run through the same scope, tenancy, and audit checks. There is no
  approve tool, so a session prompted from outside still parks every guarded
  tool call on its owner's approval. Every call is audited as
  `mcp.control.call` under the caller, with its delegator.
  `mcpControl.requireDelegated` accepts only delegated agent tokens.
  Sessions codeoid itself is steering (the conductor and its workers,
  collaborations, a live pipeline run's session) are read-only from outside.

  `codeoid mcp config` prints a ready `.mcp.json` entry whose `headersHelper`
  (`codeoid mcp headers`) mints a fresh, scope-narrowed token on each connect —
  observe-only by default. Guide: [docs/mcp-control.md](docs/mcp-control.md).

- **Forged tokens can no longer make the daemon refetch ZeroID's keys in a
  loop.** A token naming an unseen signing key is checked against the key ids
  the issuer publishes, re-read at most once every 10 seconds, before it
  reaches the SDK (which refetched the key set for every unknown `kid`). This
  covers the WebSocket handshake as well as `/mcp/control`; tokens signed by a
  known key are never slowed.

- **Protocol (additive):** `scrollback.page` without `beforeMessageId` returns
  the newest page, so a client that never attached can read recent history.
  Daemons from before this change reject the anchor-less form. And
  `SessionInfo.turnQueued` marks a prompt that was accepted but whose turn has
  not started — the window in which a session still reads `idle`.
  `SessionInfo.managedBy: "pipeline"` marks a session a live pipeline run is
  driving.

- **Sign in with Claude, instead of pasting an API key.** Settings → Claude now
  has a two-step sign-in: codeoid runs `claude setup-token` for you, shows the
  link to approve in your own browser, and takes back the code that page
  displays. The subscription credential it mints is stored as
  `CLAUDE_CODE_OAUTH_TOKEN` in `~/.codeoid/.env` like any other secret, and
  applies to new sessions.

  This is for the case where codeoid is the whole surface — a hosted sandbox, a
  phone — and there is no shell in which to run the vendor's login by hand. On a
  machine with a shell, `claude login` still works and is still picked up.

  codeoid brokers the vendor's own command rather than implementing anyone
  else's OAuth, and it runs the `claude` binary the Agent SDK already ships, so
  there is no new dependency. Wire messages: `backend.login.start` / `.submit` /
  `.cancel`, all gated on `settings:write`. Claude is wired today; the mechanism
  is per-backend and the others follow.

- **Session-scoped pack skills** (`pipeline.skillScope: "session"`). Until now
  a trusted pack's registry skills reached a session one way only: symlinked
  into `~/.claude/skills`, where every Claude Code session on the machine — not
  just codeoid's — discovered them. On a machine whose `~/.claude` is owned by
  something else (an org bundle linked by hand, another toolkit) that is the
  wrong scope. With `skillScope: "session"` nothing is linked; codeoid
  synthesizes a Claude-Code-plugin-shaped directory per registry
  (`~/.codeoid/plugins/<registry>/`: a manifest plus one symlink per real skill
  directory in the registry cache, under the same lstat guard as global
  linking) and hands it to the SDK's `plugins` option for pack-activated
  sessions and pipeline phases, so the methodology's skills exist inside
  codeoid runs and nowhere else. Plugin skills resolve both bare (`/spec`) and
  namespaced (`/<registry>:spec`), so pack `command:` values are unchanged; on a
  bare-name collision the user- or project-tier skill wins, as it does for a
  global link. The same trust rule applies (an untrusted pack contributes no
  runnable skills either way); the read sandbox and the skill-command grants
  scan the plugin tier too. The default stays `global`;
  `CODEOID_PIPELINE_SKILL_SCOPE` sets it per invocation. Non-Claude backends
  ignore the plugin dirs, as they already ignore pack subagents.
  (docs/pack-loading.md §3a)

- **The findings loop: review → fix → re-review, in the engine, with the roles
  left exactly as they are** (docs/findings-loop.md). A read-only review phase
  had no way to get its findings acted on: the pipeline had no backward edge,
  so the only exits were "approve anyway" or "re-run the reviewer, who still
  cannot edit" — and the model would ask to be re-run under a write-capable
  role, the one thing the role model exists to prevent. A phase now declares
  `findings: { fixWith: <write-capable role>, blocking?, maxRounds?, gate? }`
  and the engine does the rest: the reviewer's report must end with a fenced
  `findings` block (JSON; a missing block is a format failure with one bounded
  retry); any blocking finding runs a fix leg on the same session under
  `fixWith`'s role, whose report must end with a `dispositions` block — every
  blocking finding answered as fixed / not_a_finding / declined / deferred, a
  reason required unless fixed, validated by the engine, never trusted from
  prose; an optional fix gate (`tests_pass`) runs on the fix leg; then the
  reviewer runs again with the ledger and names what remains open. Bounded by
  `maxRounds`; blocking findings left open fail the boundary with the ledger.
  `review`-kind gates finally have a real verdict (S4), the fix leg gets its
  own model binding through the usual rungs, every leg is one persisted engine
  step (restart-safe), and the pipeline wire / `codeoid pipeline status` show
  the counts and the ledger. `maxRounds: 0` makes a pure audit phase. On a
  findings phase `onFail: retry` means another fix loop (fresh fix budget),
  a failing fix gate repairs the same fix leg once before the phase's onFail
  applies, the loop's own legs skip the phase's entry gate, and the loader
  refuses shapes that cannot mean what they say (a read-only fixer,
  `skipWhenSatisfied`, a review-kind entry or fix gate). Findings loops
  require a pack; an explicit-`phases` plan cannot declare one.

### Fixed

- **Spend caps work on every backend, and costs are never shown as $0 when they aren't known** (#430).
  Codex, OpenAI-compatible endpoints, Gemini, Qwen and the Gemini CLI recorded every turn as costing $0, so a routine's `--max-cost` and `--daily-cost` never stopped anything there.
  Now a backend that reports tokens but no cost has them priced at the model's list price (a snapshot of LiteLLM's table, overridable per model in `pricing.models`), shown as an estimate (`~$0.42`); a model on your own machine costs nothing (llama-server on a loopback address; a proxy there to a paid API isn't free unless you say so); and a turn whose cost can't be known shows as `$?`, and stops a capped routine run instead of letting it run uncapped.
  OpenAI's cached prompt tokens and Gemini's cached and thinking tokens are now counted as such, Codex counts every request of a turn (not only its last), and Qwen a turn's own tokens (not the session's running total), so the cache figures and the estimates are right; a Qwen turn that ran a sub-agent is of unknown cost, whether it ended or was stopped, since qwen-code reports no usage for a sub-agent's requests.
  The Gemini API backend's default model is now Gemini 2.5 Flash, and its picker offers 3.5 Flash and 2.5 Pro / Flash / Flash-Lite: the 2.0 and 1.5 models it offered are retired.

- **The web UI's tool badge follows the call** (#429).
  The badge read a tool call's state once, so it stayed at "executing" or "waiting confirmation" after the call finished, until the page was reloaded.

- **The capabilities drawer no longer shows credentials from MCP servers or hooks** (#394).
  Its `claude.config` response already left out env and header values, but returned MCP servers' `args`, `url` and `command`, and hook commands, verbatim, and a Claude config keeps secrets there just as often (`--api-key sk-…`, `--token=…`, `postgres://user:pass@…`, `?api_key=…`, a token in the path, `curl -H "Authorization: Bearer …"`).
  Commands and args are no longer sent at all: a server shows its program's name and how many args it has, a hook its program's name (`curl …`), and the drawer points at the file for the full text.
  A URL is shown from the URL parser's own reading, so the host is always the one it resolves to and is never hidden; userinfo, the query, the fragment and any path segment that isn't a plain word (an id, a key, `;key=value`) are hidden.
  The adopt hint, adopt's errors and its audit rows, transport errors in Settings' MCP list, and MCP tool-call errors in the daemon log and the transcript are redacted too; hook matchers, env and header key names are bounded and redacted.
  A settings or `.mcp.json` file over 1 MB is shown as one "(file too large)" row instead of being read, since the CLI still loads it; `~/.claude.json`, which also holds Claude Code's history, is read up to 64 MB.
  Adopting from the drawer still works: it matches the URL as shown, except for a project's server whose URL has parts hidden, which is adopted only by its full URL (consent to `https://host/…/mcp` isn't consent to the tenant a repo put behind the `…`); the drawer says so and how.
  The drawer's adopt check runs only for servers that need a sign-in, against an index built once per look, so a repo file of thousands of servers no longer stalls the daemon when it opens.

- **An MCP server that failed when a session started no longer stays failed for the whole session** (#389).
  A Claude session redials its backend's MCP servers on demand (the capabilities drawer's Reconnect button, `/mcp reconnect <server>` in the web UI and TUI, `codeoid mcp reconnect`, or the new `session.mcp_reconnect` message, which needs `session:send`).
  Before each turn it also retries any that are failed or waiting on a sign-in, with backoff.
  A server that comes back is announced, and the next prompt tells the model, which otherwise trusts the start-up report that it failed.
  The drawer now also lists servers no config file declares (claude.ai connectors, plugins' servers, codeoid's own).

- **Codex sessions keep their conversation across a daemon restart.** The
  Codex provider never saved the thread id it created, so after any restart it
  tried to resume a stale id and silently started an empty thread. It now
  saves the id the moment it adopts a thread. A backend switch now also marks
  the new backend fresh until its first prompt, so a restart in between
  re-seeds it instead of resuming nothing.

- **Claude's "No conversation found" recovery keeps the conversation.** When
  a backing session can't be resumed, recovery used to start a blank session
  and re-send only the latest prompt. It now hands the new session the
  conversation before that prompt (natively where it can), and can't loop if
  the new backing is missing too.

- **The context window is no longer guessed from the model id.**
  codeoid inferred every window from a substring table over model ids, and that table was wrong the moment a model shipped: `claude-opus-5-5` inferred to the 200k fallback while every turn result stated 1,000,000.
  The percent-of-window display and the history seed sized for a fork or a provider switch were both built on that guess.

  The backends already state it, and the daemon now uses what they state.
  Audited across every backend codeoid drives, because they do not agree on how they publish it:

  | Backend | States | Where |
  | --- | --- | --- |
  | claude | per turn | `result.modelUsage[model].contextWindow` |
  | codex | per turn | `thread/tokenUsage/updated` → `tokenUsage.modelContextWindow` |
  | pi | per turn, and on its catalog | `get_session_stats` → `contextUsage.contextWindow`; model objects on `get_available_models` |
  | qwen | on its catalog | `contextWindowSize` per model |
  | gemini · openai · acp | nothing | — |

  Three of those were already arriving and being discarded: codex's on a notification the provider handled while reading two of its three fields, pi's on a stats call made every turn, and qwen's in a catalog projection that dropped it (and, in API-key mode, a catalog union that dropped it again whenever the gateway listed the same model).

  One resolver now answers for every consumer: the display, the occupancy caps, auto-rotate, the rotate message, and the seed.
  It uses the window this session's backend stated for the model it is running, then one stated in the same scope or published on the provider's catalog, then a per-provider floor.
  The stated window is dropped whenever the model or provider changes, so a switch sizes the incoming backend's seed for that backend.
  A fork on the same model as its parent inherits the parent's stated window.

  What a turn states is remembered per account, project and workdir, not daemon-wide.
  The Claude CLI derives the number from settings a workdir can override (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` is unclamped), so one workdir must not size another tenant's seeds.
  A window published on a catalog is read from the catalog, so it goes away when the backend stops publishing it.

  Auto-rotate used a fixed 1M window rather than the table, so for any model below about 970k its 0.97 hard ceiling could never fire before the backend's own limit — a 200k Haiku or a 272k codex session never rotated.
  It now rotates against the window of the model actually running.
  The TUI read neither the table nor the stated window; it now shows the same number as the web UI.
  With the memory engine off, the window was never reported to clients at all; it now always is.

  The static tables stay as the floor for what no backend has stated: before a first turn, and on backends that publish nothing.

  Also fixed at the source: the Claude provider took the turn's model from `Object.keys(modelUsage)[0]`, but that map is keyed by every model the turn touched in insertion order, and a Haiku side-call routinely sits first.
  It now uses the model the SDK names on `init`, and follows `model_fallback`, so a turn the fallback model served is labelled with that model and its window.

- **`opus` ran Opus 5, months after Opus 5.5 shipped — and a 1M model was measured against a 200k window.**
  Bumps `@anthropic-ai/claude-agent-sdk` 0.3.258 → 0.3.281.
  The SDK version tracks the bundled Claude Code CLI 1:1, and the model list comes from that CLI at runtime, so the dependency bump is what surfaces a new model at all: on 0.3.258 the backend reported the `opus` alias as "Opus 5", on 0.3.281 it reports "Opus 5.5".
  Verified against the live backend — an `opus` turn on 0.3.281 reports `init.model = claude-opus-5-5`.

  Two things were stale behind that, both of them the second occurrence of a bug #315 already fixed once:

  - `MODEL_CATALOG` still pinned the premium alias to `claude-opus-5`.
    The catalog is only the pre-first-report fallback (the live list wins), but a session created before the backend has reported its list gets pinned to whatever it says — so the alias quietly ran a superseded generation, exactly as it ran `claude-opus-4-8` after Opus 5 shipped.
  - `contextWindowForModel` had no `opus-5` family, so `claude-opus-5-5` (and `claude-opus-5` before it) fell through to the 200k default.
    Once the SDK reports the concrete id back, `SessionInfo.model` carries a value the table did not know, and a 1,000,000-token window was measured as 200,000 — a 5× under-size on the percent-of-window display, the fork seed budget, and the auto-rotate occupancy that decides when a session rolls.

  The catalog and the window table are now cross-checked in tests: every catalog entry's declared `contextWindow` must equal what `contextWindowForModel` derives from its id and its alias. That is the assertion that would have caught this, and it fails if either table moves without the other.

  The deeper fix — taking the window from the backend instead of the table — is the entry above.

- **A collaboration's orchestrator could not read the artifacts its own constitution told it to synthesize** (#338).
  The compiled goal pack instructs it to "read each role's artifact from the blackboard, merge, and show disagreement", while its default profile read `spec` and `findings` only.
  So `research` (search's output), `adr` (architecture's) and `diff` (reasoning's) all came back as `Role "orchestrator" may not read "research"`, and synthesis collapsed into restating the one artifact it could reach.

  The orchestrator now reads every core kind.
  The independence property that motivated the narrow read set is about PANEL MEMBERS — a reviewer that can read its peers is an echo, not a panel — and the orchestrator is not one: §7 makes it the synthesizer and the only agent that reports to the owner.
  `review` is unchanged and still cannot reach `research`, `adr` or a peer's `findings`.
  Read scope is not an obligation to read: the index carries byte counts, and the constitution now says to coordinate from it rather than mirror the board.

  Four related defects closed with it:

  - **The declared-scope escape hatch was unreachable.**
    `reads`/`writes` were accepted on the wire and honored by `resolveRoleIo`, but no user-facing path produced them — the `--role` grammar had no syntax and the pack role YAML had no field, so overriding a role's scope meant hand-writing a WebSocket client.
    A `--role` spec now takes `name:provider[:model][*count][+reads=a,b][+writes=c]`, and `roleSchema` takes `reads:`/`writes:` alongside `write`/`network`/`envelope`.
    A `+` starts a scope segment only when a field name or a `word=` follows it, so it stays legal inside a model id (`reasoning:qwen:some+model`).
    Under a pack the role YAML is authoritative for the role's scope as a unit — declaring either field claims both, since locking only one left the other operator-overridable — and a spec that also declares one is an error rather than a silent override.
    `+reads=` declares an empty list, which stays distinct from declaring nothing (that falls back to the default profile).
    The pipeline `--role` path rejects the scope segments rather than accepting and ignoring them, and a kind that is not a real kind is now rejected when the pack LOADS, not only when a collaboration adopts it.
  - **The orchestrator's constitution was not derived from its own scope.**
    A child's brief has always computed READ/WRITE from `resolveRoleIo`; the orchestrator's constitution computed nothing, which is how the instruction and the fence drifted apart in the first place.
    Both now render from one formatter over one resolver, and every scope claim in the blackboard section — including which kinds `blackboard_write` covers and whether `blackboard_read_all` on `findings` is available — is derived rather than hardcoded.
  - **A restarted orchestrator got its fence back but not its constitution.**
    `compileGoalPack` ran only at create and nothing persists the rendered text, while resume re-attached the blackboard mount unconditionally — so after a daemon restart the orchestrator held all four blackboard tools and reads on every core kind with no goal, no roster and no statement of its scope.
    Resume now recompiles the goal pack from the same persisted config the fence resolves against.
    (A pack-adopted collaboration's ETHOS and real pack id still do not survive a restart; the adoption itself is not persisted.)
  - **Declaring a scope could dissolve panel independence silently.**
    A role that both writes and reads `findings`, or writes `findings` and reads `research`, is a reviewer that can see its peers or the implementer's reasoning.
    §7's cross-critique round wants exactly that, so it is allowed — but it is now reported as a create-time warning on the response, rather than happening quietly.

- **Two installed packs declaring the same skill or gate id overwrote each
  other.** Registries were daemon-wide and keyed by bare id, so installing a
  second pack that also declared `review`, `ship`, or `tests_pass` replaced the
  first's entries last-wins (the boot log said so: `skill "review" already
  registered — overwriting`), and a run from the first pack then drove the
  second pack's skill. Packs now register under `<packId>/<id>`; the engine, the
  skill phase kind, and create-time validation resolve a run's own pack entry
  first and fall back to the bare id, so built-in gates (`always`, `manual`) and
  directly registered entries keep resolving exactly as before. Phase defs, CLI
  output, and the web Pack Browser still show the ids as authored.

  One deliberate consequence: an explicit-`phases` plan (wire `pipeline.create`
  with `phases`, not `pack`) can no longer borrow an installed pack's skill or
  gate by its bare id — that borrowing was the same leakage, just from the
  other side. Name the entry by its qualified id (`skill: "org-dev/spec"`), or
  create the run with `pack`; the create error now lists the qualified ids that
  exist. The web UI and CLI always send `pack`, so only direct API/SDK clients
  are affected, and `pipeline.pack.list` now reports the daemon's `skillScope`.

- **A dangling skill symlink blocked that skill from ever being linked again.**
  An older loader linked registry skills from a temp clone under `/tmp`; after
  the cache moved, those links pointed at nothing. `existsSync` is false for a
  dangling link, so `#linkSkills` tried to create it, hit `EEXIST`, warned, and
  left the skill broken on every subsequent install and trust. A dangling link
  is now repaired in place; a real directory or a live link is still never
  touched.

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
