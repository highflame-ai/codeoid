# Codeoid

Identity-first remote control plane for AI coding agents. Powered by ZeroID.

## Architecture

```
codeoid start
  ├── Bun.serve() — HTTP + WebSocket server
  ├── ShutdownManager — cleanup registry, signal handlers, 30s grace period
  ├── SessionManager — rate limiting, session resume, scope enforcement
  │   ├── ProviderRegistry — pluggable backends (claude default; openai, gemini, codex, pi, gemini-cli, qwen, llamacpp, opencode)
  │   └── Session × N — each drives one provider backend (Claude Agent SDK by default)
  │       ├── ScrollbackBuffer — circular ring, replayed on device handoff
  │       ├── TranscriptStore — JSONL persistence, survives daemon restart
  │       └── AgentIdentityManager — ZeroID identities for agents + sub-agents
  ├── Web UI frontend (SolidJS, served at /ui, also Telegram Mini App)
  └── Telegram frontend (embedded, direct SessionManager access)
```

### Plugin Architecture

Frontends implement the `Frontend` interface and get direct access to the
SessionManager — no network hop for embedded frontends.

```typescript
interface Frontend {
  readonly name: string;
  start(ctx: FrontendContext): Promise<void>;
  stop(): Promise<void>;
}

interface FrontendContext {
  manager: SessionManager;   // direct access
  store: Store;              // audit log
  auth: AuthConfig;          // ZeroID config
  httpServer: Server;        // mount custom routes
  host: string; port: number;
}
```

Register with `daemon.use(new MyFrontend())` — that's it.

### File Structure

```
src/
├── cli.ts                        # CLI entry: start, ls, new, attach, send, etc.
├── config.ts                     # Config: ~/.codeoid/config.json + env vars
├── daemon/
│   ├── server.ts                 # Bun.serve() — HTTP + WebSocket, frontend plugin host
│   ├── session-manager.ts        # Orchestrates N sessions, rate limiting, resume
│   ├── session.ts                # One session: drives a provider backend, retry, scrollback, permissions
│   ├── providers/                # Pluggable agent backends behind one SessionProvider interface
│   │   ├── registry.ts           #   ProviderRegistry + createDefaultProviderRegistry()
│   │   ├── interface.ts          #   SessionProvider contract
│   │   └── claude|openai|gemini|codex|pi|acp|qwen|llamacpp|opencode/  # one dir per backend (acp = Gemini CLI)
│   ├── store.ts                  # bun:sqlite — sessions + audit_log tables
│   ├── auth.ts                   # ZeroID JWT verification via @highflame/sdk
│   ├── agent-identity.ts         # ZeroID identities for coding agents + sub-agents
│   ├── scrollback.ts             # Circular ring buffer for device handoff replay
│   ├── transcript.ts             # JSONL persistence for session resume
│   ├── rate-limit.ts             # Per-user session creation + concurrency limits
│   ├── shutdown.ts               # Cleanup registry, signal handlers, grace period
│   └── index.ts
├── protocol/                     # re-export shims for @highflame/codeoid-protocol (packages/protocol)
│   ├── types.ts                  # Client<->Daemon message protocol
│   ├── scopes.ts                 # 18 permission scopes (source: packages/protocol/src/scopes.ts)
│   └── index.ts
├── frontends/
│   ├── types.ts                  # Frontend plugin interface
│   ├── index.ts
│   ├── telegram/index.ts         # Grammy bot, embedded in daemon process
│   └── web-ui/index.ts           # Serves the built SolidJS app (web/dist) at /ui, also Telegram Mini App
└── terminal/
    └── client.ts                 # WebSocket client, connects to daemon
```

## Tech Stack

- **Runtime**: Bun (native WebSocket, bun:sqlite, Bun.serve())
- **Agent backends**: pluggable via `ProviderRegistry` — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, default), plus OpenAI, Gemini, Codex, pi, the Gemini CLI, Qwen Code (`@qwen-code/sdk`), llama.cpp (`llamacpp`, opt-in), and opencode 2.2.5+ (one shared private server)
- **Auth**: ZeroID via `@highflame/sdk` (local JWKS verification)
- **Telegram**: Grammy
- **CLI**: Commander
- **Validation**: Zod

No native addon dependencies. Single `bun build` produces a 1.1MB bundle.

## Core Concepts

### Sessions
A session = one agent backend (the Claude Agent SDK by default; also Codex,
Gemini, OpenAI, pi, the Gemini CLI, Qwen Code, opencode, or a local llama.cpp server)
working in one directory.
Sessions are named, persistent, and daemon-owned. Multiple clients can
attach/detach simultaneously from any frontend.

### Auth Model (ZeroID)
Every connection requires a ZeroID JWT. Scopes are enforced per-message:
- `session:create` / `session:destroy` — lifecycle
- `session:list` — discovery
- `session:attach` / `session:watch` — connect to sessions
- `session:send` / `session:interrupt` / `session:approve` — interact
- `session:read` / `session:dispatch` — conductor fleet visibility + routing (agent identity)
- `fleet:read` — subscribe a client to the fleet board
- `fs:read` — read files under a session's workdir
- `settings:read` / `settings:write` — daemon configuration
- `pipeline:create` / `pipeline:read` / `pipeline:answer` / `pipeline:manage` — SDLC pipelines + packs

Delegation: users can share scoped tokens (e.g. read-only watcher) with teammates.
Revocation: kill a token -> immediately lose access.
Audit: every action attributed to a ZeroID subject in SQLite.

### Agent Identities
When configured, Claude coding agents and their sub-agents get ZeroID identities:
- Session agent registered on first `send()` (SessionStart hook)
- Sub-agents registered on spawn (SubagentStart hook), with delegated tokens
- Scope attenuation: sub-agents get a subset of parent's scopes
- Cascading revocation: deactivate parent -> all sub-agents revoked

### Turns and checkpoints
Every prompt, and everything the agent does in reply, belongs to one turn with a stable `turnId` (on each `SessionMessage`; listed by `session.turns`).
A message sent mid-turn joins the running turn.
At the start of each turn the working directory is snapshotted into a daemon-owned shadow git repo (`<transcriptDir>/checkpoints/<session>.git`, self-contained, never the user's repo; secrets and dependency dirs excluded; works without git).
The backend-neutral canonical history is persisted per session (`<id>.canonical.jsonl`) so forks, backend switches and stateless backends keep the conversation across a daemon restart.
It is the source of truth, and it doesn't depend on a provider's native session.
What a backend is handed on a fork, switch or rewind is chosen by `Session.#seedProviderFromHistory` (#387): `continueNatively` first — Claude and Codex fork their own conversation at the turn's recorded `native` point (stamped on each canonical assistant turn from `NormalizedTurnResult.nativeRef`), or take native history built from the canonical turns — then the transcript seed as the fallback.
A fork never takes over the background work its parent started (`src/daemon/fork-isolation.ts`).
`Session.primeFromFork` records a boundary (an ISO time taken before the seed) and the parent's task ids as foreign, both persisted in the meta's `forkIsolation` before the seed runs and validated when read back.
The Claude provider sets `CLAUDE_CODE_RESUME_SOURCE_ALIVE` to that boundary on a fork's queries, and removes any inherited value from every other session's, so the CLI's resume reconciliation ignores launches recorded before it.
The CLI keeps cloud-agent registrations in a sidecar (`<project>/<session>/remote-agents/`), not the JSONL; `continueNatively` clears a fork's native copy of the parent's before it is resumed (`clearInheritedRemoteAgents`), and refuses the copy (removing its JSONL) on a symlink, an id that isn't the fork's, or any error but a missing dir.
A foreign task the fork's backend still reports is stopped there and never woken on; one whose stop fails, or that is still listed three levels or 30s after its stop call resolved, stays listed as the parent's, being stopped, until it's gone.
A foreign settle arms a one-shot reminder (`Session#armForeignResult`, persisted as `forkIsolation.resultsPending`) that the result is the original session's, since the CLI may hand it to the fork's model; it rides the model's next input: pushed into a running turn, pushed first into a turn the backend starts on its own (`#adoptTurn`), or prefixed to the next prompt as the fork note is, and it is recorded in the canonical history.
Nothing is interrupted or refused for a foreign result, and a background shell the fork killed arms nothing (the CLI doesn't tell the model).
A kill is recognized from `#foreignStopAsked` (kept until the settle), since the CLI drops a killed task from its level before the "stopped" settle arrives.
`Session#send` reads the fork's notes again after its last await, so the note and the reminder each reach the model once, whether the prompt starts a turn or joins one the backend started meanwhile.
The Claude provider clears `#lastPushedContent` when it adopts a turn, so no recovery re-sends an earlier prompt into a turn nobody prompted.
Foreign ids not known to have finished (`deniedAgents`) have their tool calls denied first in the Claude provider's PreToolUse hook (`isForeignAgent`, fail-closed, audited at most once a minute per agent), again in its `canUseTool` and at the session's gate (`ToolApprovalFn`'s `agentId`), and their activity is never shown.
On a fork a stop-task call (TaskStop, KillShell, KillBash) is allowed only for the fork's own task or agent ids (`isOwnTask`) or a teammate of its own team; teammates of another team are denied, and every teammate is when `CLAUDE_INTERNAL_ASSISTANT_TEAM_NAME` is set (team handling is best effort, likely inert under the SDK).
A target with whitespace around it is refused, never trimmed (`stopTaskTarget`), and the session's gate runs the provider's verdict again (`SessionProvider.foreignCallRefusal`) on an input a codeoid hook rewrote.
A foreign cloud agent (`remote_agent`) is never stopped from a fork, since stopping it archives the shared cloud session; it is only listed as the parent's.
The fork's first prompt carries a one-shot note when the parent had unfinished background work; it is spent only when the prompt reaches the backend, and a rewind past it re-arms it.

### Device Handoff
Sessions live in the daemon. Clients are stateless.
- **Scrollback buffer**: circular ring (5000 entries / 20MB) replayed on attach
- **Transcript persistence**: JSONL per session, user prompts written before API call
- **Session resume**: on daemon restart, meta files scanned, sessions rebuilt, scrollback restored

Detach from terminal -> attach from Telegram -> same session, same context, scrollback replayed.

### Production Resilience

**Retry with fallback**: `session.fallbackModel` (`CODEOID_FALLBACK_MODEL`) is
handed to the Claude Agent SDK's `fallbackModel` option, so a 429 or 529
retries the turn on that model instead of failing it. There is no daemon-side
retry manager.

**Graceful shutdown**: cleanup registry runs in LIFO order on SIGTERM/SIGINT/SIGHUP.
Sessions drained (in-flight work interrupted), store flushed, WebSockets closed,
frontends stopped. 30-second grace period before forced exit.

**Session limits**: none by default — parallel sessions are the point, so
`rateLimit.maxSessionsPerUser` and `rateLimit.maxCreationsPerHour` both default
to `0` (unlimited). Set them for a shared multi-user daemon. Automated spawning
is bounded where it originates instead (`dispatch.maxConcurrentWorkers`,
`workerToolBudget`, `failureLimit`).

**Permission correlation**: each approval request has a unique `approvalId`.
Clients respond referencing the specific request. Multiple concurrent approvals
supported. First response wins.

## Commands

```bash
bun run build        # bun build src/cli.ts --outdir dist
bun run dev          # bun --watch src/cli.ts
bun run typecheck    # tsc --noEmit
bun run test:e2e     # end-to-end: real daemon + web UI + CLI, scripted backend (e2e/README.md)
bun run lint         # biome check

codeoid start        # daemon + all frontends
codeoid ls           # list sessions
codeoid new <n> [d]  # create session (workdir required unless --worktree); --model, --effort <level>
codeoid attach <n>   # interactive attach (with scrollback replay)
codeoid send <n> <m> # one-shot message
codeoid interrupt <n>
codeoid approve <n> [--deny] [--pick N | --id <approvalId>] [--yes]
codeoid account ls|login <name>|add-key <name>|add-gateway|add-token|add-bedrock|default <name>|use <session> <name>|--follow-default|rm <name> [--backend <id>]  # accounts for every backend (docs/backend-accounts-design.md)
codeoid destroy <n>
codeoid mcp config [--scopes observe|operate|full]  # MCP client entry for /mcp/control
codeoid mcp headers [--scopes …]                    # fresh bearer header (an MCP headersHelper)
codeoid mcp reconnect <session> <server>            # redial a backend MCP server that's down (#389)
codeoid mcp refresh <session>                       # apply MCP servers changed in Claude's config (#395)
codeoid mcp approve <session> <server> [--path <f>] [--yes <fingerprint>]  # review, then approve a project's MCP server for every backend (#395)
codeoid mcp adopt <server> [--session <s>] [--url <u>]  # codeoid signs in to a server from Claude's config (#390)
codeoid mcp signin <server> [--callback-url <u>]        # sign in to an OAuth registry server
codeoid evidence <id> [--full]   # one recorded check: what ran, on which tree, what it found
codeoid loop start "<objective>" --workdir <dir> --check <cmd> [--test] [--wait]  # repair until the daemon's checks pass (docs/loops.md)
codeoid loop ls | show <id> [--events] | steer <id> <text> | pause | resume | cancel <id>
codeoid loop watch add --workdir <dir> (--branch <b>... | --my-prs) --ci "<check>[@app]: <cmd>" [--review] [--trust <login>]  # CI failures / review comments start runs
codeoid loop watch ls | show | poll | pause | resume | rm <id>
codeoid routine add <name> --prompt … [--cron|--every|--at] [--check <cmd>]  # scheduled agent runs
codeoid routine add <name> --loop --prompt … --verify "id: cmd" [--test] [--attempts N] [--attempt-minutes N] [--run-minutes N] [--budget N]  # start a loop (--check = gate, --verify = its acceptance checks)
codeoid routine ls | show | runs | run [--wait] | edit | pause | resume | rm | cancel <runId> | token | preview
codeoid worktree trust [dir] [--off] [--yes]  # trust the setup command of a repo's .codeoid/setup.yaml, pinned to its blob (docs/CONFIGURATION.md)
```

`/mcp/control` (off by default, `mcpControl.*`) lets external agents drive
sessions over MCP. Every tool call is an ordinary `ClientMessage` run through
`SessionManager.handle`, so it shares the WebSocket path's verifier, scopes,
tenancy, and audit. Keep authorization in `handle`; the endpoint may only
narrow what is reachable, never grant. See docs/mcp-control.md.

Loops (`src/daemon/loops/`, docs/loops.md) pursue an objective in their own
worktree until the daemon's own checks pass. `LoopService` is the controller:
it owns lifecycle, verification, and acceptance, reaches the daemon only through
the `LoopHost` seam (`loops/host.ts`), and schedules attempts only through the
dispatcher (`kind: "attempt"`). A worker's `loop_report` is a request to verify,
never a verdict. Every transition is a compare-and-set on the run's
`state_version`. loop.* is authorized in `SessionManager.#loopHandle`
(owner-only; session:create + session:send, plus session:approve to start).

Routines (`src/daemon/routines/`, docs/routines.md) run sessions on a schedule
or an API call. `RoutineService` owns the scheduler and runs; it reaches
sessions only through the `RoutineHost` seam that `SessionManager` implements,
and every routine.* message is authorized in `SessionManager.#routineHandle`
(owner-only, no scope of its own: session:create + session:send for
everything but preview, plus session:approve for an autonomous routine, one
with a check, or one that starts a loop; changes are refused to delegated tokens). The fire claim is a compare-and-set on
`next_fire_at`, which is the only scheduler lock. A loop routine (`spec.loop`)
starts a loop run through `RoutineHost.loops` after its gate; its routine run
follows the loop (`loopRunId`) without holding a run slot and ends with the
loop's outcome.
A loop that ends blocked after trying is `needs_attention` there, and for a loop routine that counts toward the failure pause.
`#followLoops` runs at the start of every tick and on every loop end or cancel (`notifyOwner` kind `cancelled`); without a loop port it fails the following runs.
A loop routine's run is set `running` before `port.start`, and `RoutineService.start` relinks a run whose loop started before the run recorded it (`RoutineLoopPort.inProgress`, owner-scoped, and only when the loop's trigger names that run's routine); the routine's `notify` policy decides a routine-started loop's pushes (`loopMayPush`).
`delete` marks the routine in `#deleting` before its first await, and `fire`, `#fireScheduled`, `#admit`, `#drainQueue` and `#startLoopRun` refuse a routine being deleted.
`RoutineWire.lastOutcome` (`RoutineStore.lastOutcome`) is the newest run with an outcome by `ended_at`; anything meaning "how is it doing" reads it, not `lastRun`.
The API fire reply (`routines/http.ts`) gives a generic reason, never the run's own (it can name a loop run).
A loop cancel re-reads the worker's spend after the worker stopped (the host's `interruptWorker` waits, bounded, for the interrupted turn to drain: `Session.turnDrained`) and only then notifies.
A pinned vouch (`trustHead` record) takes full commit ids only, and its moved-head refusal carries `response.error` `detail` (`head_moved`), which `RequestError` in packages/core keeps.
The web never vouches unpinned (not on create either) and never pre-fills a vouch from an untrusted head.
The web's automation stores reset on an identity change (`web/src/state/automation-identity.ts`, keyed by `identityKey`), not on a new connection, so a routine token shown once survives a reconnect and is shown only to the identity that asked.

## Config

```bash
CODEOID_API_KEY=zid_sk_...           # ZeroID API key (or run `codeoid login`)
ZEROID_URL=highflame                 # issuer: preset (highflame | highflame-dev | local) or URL
                                     #   default: highflame (Highflame SaaS); iss is pinned to it
ZEROID_ISSUER=                       # override the expected `iss` claim (default: resolved ZEROID_URL)
TELEGRAM_BOT_TOKEN=...              # Optional: enables Telegram frontend
TELEGRAM_ALLOWED_USER_IDS=123,456   # Required with bot token
CODEOID_MCP_CONTROL_ENABLED=false   # mount /mcp/control (docs/mcp-control.md)
CODEOID_MCP_CONTROL_ACTIONS=false   # also allow create / send / interrupt / destroy there
CODEOID_ROUTINES_ENABLED=true       # scheduler + routine commands (docs/routines.md)
CODEOID_DEFAULT_EFFORT=             # thinking effort for new sessions: off|minimal|low|medium|high|xhigh|max (docs/thinking-effort.md)

# Claude auth: uses your existing `claude login` session (Pro/Max subscription).
# No ANTHROPIC_API_KEY needed if you're logged in via Claude Code CLI.
# Falls back to ANTHROPIC_API_KEY env var if not logged in.
```

### Qwen backend (Alibaba)

Qwen Code runs in-process via `@qwen-code/sdk`, which bundles the CLI it drives
— nothing to install. Both credential paths work; `providers.qwen.authType`
picks one, and omitting it auto-detects (a `~/.qwen` login wins over the key).

**Subscription** — run `qwen` once to log in with a qwen.ai account. Tokens
live in `~/.qwen/oauth_creds.json` and never transit codeoid.

**API key** — set `OPENAI_API_KEY` in `~/.codeoid/.env` and point
`providers.qwen.baseUrl` at the right gateway:

| Preset | Use for |
| --- | --- |
| `dashscope-intl` | Model Studio pay-as-you-go keys (international) |
| `dashscope-cn` | Model Studio pay-as-you-go keys (China) |
| `bailian-plan-intl` | **Plan-specific keys (`sk-sp-…`)** from the Bailian token-plan |

The last one matters: a `sk-sp-` plan key is rejected by the standard DashScope
hosts with `invalid_api_key`, which is a confusing failure to debug. Plan keys
also expose a broader catalog than Qwen alone (`qwen3.8-max`, `glm-5.2`,
`deepseek-v4-pro`, …) — set `providers.qwen.model` to pick one.

```json
{
  "providers": {
    "qwen": {
      "authType": "openai",
      "baseUrl": "bailian-plan-intl",
      "model": "qwen3.8-max"
    }
  }
}
```

codeoid forces `permissionMode: "default"` so every write routes through the
approval gate — qwen-code's own `auto` mode would silently auto-approve edits
and shell commands.

**Known gap — read-only shell commands bypass codeoid's gate.** qwen-code's
`resolveDefaultPermission` runs `isShellCommandReadOnlyAST(command)` and
auto-allows anything it classifies read-only, without ever raising a
permission request. Measured on this backend: `rm -f …` gates, but
`echo hello`, `cat /etc/hostname`, and `cat ~/.codeoid-decoy-secret.txt` all
executed **ungated** — including reads outside the workdir. So on the qwen
backend an agent can read any file the daemon user can (`~/.codeoid/config.json`,
`~/.ssh/…`) without `canUseTool` firing.

This is a property of the backend, not of codeoid's gate: codeoid cannot
intercept a tool call the CLI never asks about. The classifier layer is
documented in qwen-code as not overridable by permission mode, so the only
blunt mitigation available today is `excludeTools: ["run_shell_command"]`,
which removes shell capability entirely. `buildQwenEnv()` closes the adjacent
env-var vector, but NOT this one.

Audited against `gemini-cli` 0.50.0 (qwen-code is a fork of it): the gap looks
**qwen-specific**. Its bundle has no `isShellCommandReadOnlyAST` /
`resolveDefaultPermission`, and its shell `shouldConfirmExecute` has no
content-based read-only bypass — the only auto-allow paths are the policy
engine (`getMessageBusDecision`), YOLO mode, and sandbox policy, none of which
codeoid enables. That check is STATIC only; the live ACP confirmation was
blocked on expired `~/.gemini` OAuth (re-run `gemini` interactively to redo it).

Onboarding: `codeoid login [key] [--zeroid <preset|url>]` verifies the key via a
token exchange and writes `apiKey` (+ `zeroidUrl` if `--zeroid` given) to the
config file. The shipped default issuer is the Highflame SaaS, so a hosted user
just needs a key from Studio's Code Agents screen. `ZEROID_PRESETS` +
`resolveZeroidUrl()` live in `src/config.ts`.

### opencode backend

`src/daemon/providers/opencode/` drives opencode 2.2 over its HTTP API
(user guide: [docs/opencode.md](docs/opencode.md)). What's particular:

- **One private server per daemon** (`OpencodeServer`, server.ts): started by
  the first opencode session's first turn, shared, restarted on next use if it
  died, stopped by the `opencode` shutdown step (and by opencode itself when
  codeoid's stdin pipe closes). Loopback, fresh password per start, database
  `providers.opencode.dbPath` (default beside codeoid's `dbPath`). The version
  from `GET /api/info` must be 2.2.x from 2.2.5 on (`opencodeVersionProblem`;
  2.2.2 runs a redirection-only shell line unasked); outside it the
  registry takes the backend off with the reason as its hint.
- **Policy** (policy.ts): opencode asks about every action. Session rules end
  in ask-everything; the server's agents are checked at start and a subagent
  that would act unasked gets overrides (one restart) or the server is refused;
  never-asking tool plugins are disabled; saved "always" rules are deleted.
  Replies are `once` or `reject` with a message, never `always`
  (`OpencodeClient.replyPermission` can't express it). opencode follows a
  `webfetch`'s redirects itself, checking hops only against the rules, so an
  approved fetch's session carries a fence while it runs (`fetchFence`: other
  origins denied) and it is lifted when the call settles. A plugin can settle a
  request itself, so the server's global config dir is codeoid's
  (`OPENCODE_CONFIG_DIR`, `config/` beside the DB; only the provider and model
  keys of the user's `~/.config/opencode` are carried in), a server listing a
  plugin that isn't a built-in is refused at start and before every turn
  (`checkPlugins`), and a call that succeeded without asking stops the server.
- **Events**: the live feed is the only stream: it carries each session's
  durable events (blocks, tools, steps with cost, executions; deduped by
  `durable.seq`) and the ephemeral ones (deltas, `permission.asked`, forms,
  `usage.updated`, child sessions). opencode 2.2's per-session log endpoint
  replays nothing and follows nothing, so it isn't read; after a feed gap
  (`#afterGap`) children created in it are listed (`?parentID=`) and each
  running child is read back (cards, steps, end), then the turn is read back
  from the session's messages (`#reconcile`: ended blocks, steps, settled
  cards, steers delivered — a delivered input is a user message under its
  inbox id; a turn whose execution ended in the gap ends there), or with no
  turn open an execution that started unseen is adopted and read back. A
  request re-offered after one takes its call's input from the stored
  message. Settled calls and counted steps are remembered across turns, so a
  late feed repeats nothing. Spend past the steps in `usage.updated` (the
  title opencode generates, a compaction's requests) is billed as a side
  call; a compaction's end isn't counted. A turn ends with its execution
  (after any steer request still in flight, and any read-back); a
  `now`/`next` push waits for the turn's prompt to be posted, steers and owes
  Session one absorbed `turn_done` (paid at the steer's
  `session.inbox.delivered`, when its request answers if delivery came first,
  or — refused — just before the turn's last `turn_done`); `later` is
  delivered inside the running execution. A user interrupt withdraws the
  turn's undelivered inputs from opencode's inbox.
- **Code Mode** (`execute`) and opencode's `browser` tools are hidden by deny
  rules: on 2.2.2 a Code Mode script's `fetch` runs without asking.
- **MCP** mounts are per location in opencode, so each session's are named
  `coid<sha(session)>_<name>` and its rules deny other sessions' (`coid*`).
- **Commands** (`runnableCommand`, policy.ts): only opencode's built-ins
  (known by name and listed description: a config command replaces one of
  the same name) and the prompts of the session's own mounts run as
  commands. Another session's mount prompt would run with its credential;
  a config command's template runs `` !`…` `` through the shell, arguments
  included, unasked. Any other `/name …` goes to the model as text.

### Local models (llama.cpp)

The `llamacpp` backend drives a `llama-server` the user runs themselves, over
its OpenAI-compatible API — `OpenAIProvider` under a distinct id
(`src/daemon/providers/llamacpp/`). Off by default
(`providers.llamacpp.enabled`). User guide: [docs/local-models.md](docs/local-models.md).

What differs from the cloud `openai` backend, and why:

- **Context window** comes from the server's `/props` after every turn
  (per-request `n_ctx`), and the pre-first-turn floor is llama-server's own
  default of 4096 — a cloud-sized table entry would overflow a local server.
- **External MCP servers are opt-in** (`providers.llamacpp.mcpServers`):
  tool definitions ride in every prompt, and a few servers' worth exceeds a
  local context before the user types. Built-in memory tools are always on.
- **Tool schemas are made strict** (`strictJsonSchema`): llama.cpp compiles
  them into a grammar and 500s the whole request on an annotation-only
  subschema such as `{ "description": "any value" }`.

Config file at `~/.codeoid/config.json` (optional). Env vars take precedence.

Data stored at:
- `~/.codeoid/codeoid.db` — SQLite (sessions, audit log)
- `~/.codeoid/transcripts/` — JSONL transcripts per session
- `~/.codeoid/transcripts/<id>.canonical.jsonl`, `<id>.turns.jsonl` — canonical history + turn index
- `~/.codeoid/transcripts/checkpoints/` — per-session workspace snapshots

Web UI available at `http://localhost:7400/ui/` when daemon is running.
