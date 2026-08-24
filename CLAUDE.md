# Codeoid

Identity-first remote control plane for AI coding agents. Powered by ZeroID.

## Architecture

```
codeoid start
  ├── Bun.serve() — HTTP + WebSocket server
  ├── ShutdownManager — cleanup registry, signal handlers, 30s grace period
  ├── SessionManager — rate limiting, session resume, scope enforcement
  │   ├── ProviderRegistry — pluggable backends (claude default; openai, gemini, codex, pi, gemini-cli, qwen)
  │   └── Session × N — each drives one provider backend (Claude Agent SDK by default)
  │       ├── ScrollbackBuffer — circular ring, replayed on device handoff
  │       ├── TranscriptStore — JSONL persistence, survives daemon restart
  │       ├── RetryManager — exponential backoff, fallback model
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
│   │   └── claude|openai|gemini|codex|pi|acp|qwen/  # one dir per backend (acp = Gemini CLI)
│   ├── store.ts                  # bun:sqlite — sessions + audit_log tables
│   ├── auth.ts                   # ZeroID JWT verification via @highflame/sdk
│   ├── agent-identity.ts         # ZeroID identities for coding agents + sub-agents
│   ├── scrollback.ts             # Circular ring buffer for device handoff replay
│   ├── transcript.ts             # JSONL persistence for session resume
│   ├── retry.ts                  # Exponential backoff, fallback model, error categories
│   ├── rate-limit.ts             # Per-user session creation + concurrency limits
│   ├── shutdown.ts               # Cleanup registry, signal handlers, grace period
│   └── index.ts
├── protocol/
│   ├── types.ts                  # Client<->Daemon message protocol
│   ├── scopes.ts                 # 8 permission scopes
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
- **Agent backends**: pluggable via `ProviderRegistry` — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, default), plus OpenAI, Gemini, Codex, pi, the Gemini CLI, and Qwen Code (`@qwen-code/sdk`)
- **Auth**: ZeroID via `@highflame/sdk` (local JWKS verification)
- **Telegram**: Grammy
- **CLI**: Commander
- **Validation**: Zod

No native addon dependencies. Single `bun build` produces a 1.1MB bundle.

## Core Concepts

### Sessions
A session = one agent backend (the Claude Agent SDK by default; also Codex,
Gemini, OpenAI, pi, the Gemini CLI, or Qwen Code) working in one directory.
Sessions are named, persistent, and daemon-owned. Multiple clients can
attach/detach simultaneously from any frontend.

### Auth Model (ZeroID)
Every connection requires a ZeroID JWT. Scopes are enforced per-message:
- `session:create` / `session:destroy` — lifecycle
- `session:list` — discovery
- `session:attach` / `session:watch` — connect to sessions
- `session:send` / `session:interrupt` / `session:approve` — interact

Delegation: users can share scoped tokens (e.g. read-only watcher) with teammates.
Revocation: kill a token -> immediately lose access.
Audit: every action attributed to a ZeroID subject in SQLite.

### Agent Identities
When configured, Claude coding agents and their sub-agents get ZeroID identities:
- Session agent registered on first `send()` (SessionStart hook)
- Sub-agents registered on spawn (SubagentStart hook), with delegated tokens
- Scope attenuation: sub-agents get a subset of parent's scopes
- Cascading revocation: deactivate parent -> all sub-agents revoked

### Device Handoff
Sessions live in the daemon. Clients are stateless.
- **Scrollback buffer**: circular ring (500 entries / 1MB) replayed on attach
- **Transcript persistence**: JSONL per session, user prompts written before API call
- **Session resume**: on daemon restart, meta files scanned, sessions rebuilt, scrollback restored

Detach from terminal -> attach from Telegram -> same session, same context, scrollback replayed.

### Production Resilience

**Retry with fallback**: exponential backoff with jitter, error categorization
(429 rate limit, 529 capacity, 5xx server, auth, connection). Capacity errors
fall back to a secondary model after 3 attempts. Unattended sessions retry
indefinitely with up to 5-minute backoff.

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
bun run lint         # biome check

codeoid start        # daemon + all frontends
codeoid ls           # list sessions
codeoid new <n> <d>  # create session
codeoid attach <n>   # interactive attach (with scrollback replay)
codeoid send <n> <m> # one-shot message
codeoid interrupt <n>
codeoid approve <n>
codeoid destroy <n>
```

## Config

```bash
CODEOID_API_KEY=zid_sk_...           # ZeroID API key (or run `codeoid login`)
ZEROID_URL=highflame                 # issuer: preset (highflame | highflame-dev | local) or URL
                                     #   default: highflame (Highflame SaaS); iss is pinned to it
ZEROID_ISSUER=                       # override the expected `iss` claim (default: resolved ZEROID_URL)
TELEGRAM_BOT_TOKEN=...              # Optional: enables Telegram frontend
TELEGRAM_ALLOWED_USER_IDS=123,456   # Required with bot token

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

Config file at `~/.codeoid/config.json` (optional). Env vars take precedence.

Data stored at:
- `~/.codeoid/codeoid.db` — SQLite (sessions, audit log)
- `~/.codeoid/transcripts/` — JSONL transcripts per session

Web UI available at `http://localhost:7400/ui/` when daemon is running.
