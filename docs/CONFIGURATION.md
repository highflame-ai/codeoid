# Configuration & permission scopes

> Configuration reference for Codeoid. For install and a quick tour, start with the [README](../README.md).

## Auth posture: ZeroID or local

Codeoid has exactly two auth postures, chosen at daemon startup.

| | **ZeroID** (default) | **Local** (`--local`) |
|---|---|---|
| Setup | `codeoid login` with a `zid_sk_…` key | none |
| Credential | short-lived RS256 JWT, verified against the issuer's JWKS | one 256-bit token, minted per boot |
| Identity | real, per-agent and per-sub-agent | self-asserted `anonymous:operator` |
| Delegation, attenuation, revocation | ✅ | ❌ |
| Audit attribution | cryptographic | records the action; principal is self-asserted |
| Tenant | from the token's `account_id` / `project_id` claims | reserved `local` / `local` |
| Bind | any host | loopback only (override with `--local-allow-remote`) |
| Telegram frontend | ✅ | refused |

Everything below applies to both unless noted. Scope enforcement is *identical* in
both — local mode changes the issuer, not the mechanism.

→ **[Local mode reference](local-mode.md)** — the full trust model, the tenant
one-way door, and how clients discover the token.

## Permission scopes

| Scope | Description |
|---|---|
| `session:create` | Create sessions |
| `session:destroy` | Destroy sessions |
| `session:list` | List all sessions |
| `session:attach` | Attach (full interaction) |
| `session:watch` | Watch session output (read-only) |
| `session:send` | Send messages |
| `session:interrupt` | Interrupt running agents |
| `session:approve` | Approve / deny tool requests; also required for `/mode`, `/pin`, `/unpin` |
| `session:read` | Read-only fleet visibility (conductor): list / find / summarize sessions |
| `session:dispatch` | Send-class fleet routing (conductor): direct / interrupt / spawn on the owner's behalf |
| `fs:read` | Read files + list directories under a session's workdir |
| `settings:read` | Read the settings manifest + current (non-secret) configuration |
| `settings:write` | Write daemon configuration (`config.json` + `.env`), including secrets |

[Routines](routines.md) have no scope of their own: holding them takes `session:create` + `session:send`, pre-approving work (autonomous, or a check command) also takes `session:approve`, and a delegated token can't change them.

Share a read-only token with a teammate via ZeroID:

```bash
curl -X POST http://localhost:8899/oauth2/token -d '{
  "grant_type": "token_exchange",
  "subject_token": "YOUR_TOKEN",
  "scope": "session:list session:watch"
}'
# → short-lived JWT, list + watch only, revocable anytime
```

## Configuration

### Environment variables

```bash
# Auth
CODEOID_API_KEY=zid_sk_...              # ZeroID API key (or use `codeoid login`)
ZEROID_URL=highflame                    # issuer: preset (highflame | highflame-dev | local) or URL
                                        #   default: highflame (the Highflame SaaS)
ZEROID_ISSUER=                          # expected `iss` claim; defaults to the resolved ZEROID_URL
ZEROID_ACCOUNT_ID=personal              # Enable agent identities
ZEROID_PROJECT_ID=dev

# Local mode (no ZeroID) — see docs/local-mode.md
CODEOID_LOCAL_TOKEN=                    # daemon: use this instead of minting one (pins it
                                        #   across restarts, e.g. in a container)
                                        # client: present this token
                                        # Clients otherwise read ~/.codeoid/local-token-<port>,
                                        #   which a `--local` daemon publishes while it runs.

# Session limits — UNLIMITED by default (0). Running many sessions in parallel
# is the point; set these only for a shared multi-user daemon.
CODEOID_MAX_SESSIONS_PER_USER=0         # concurrent sessions per subject (0 = unlimited)
CODEOID_MAX_SESSIONS_PER_HOUR=0         # session creations per subject per hour (0 = unlimited)

# Daemon
CODEOID_DAEMON_URL=ws://127.0.0.1:7400  # (for CLI + TUI client)
CODEOID_DB_PATH=~/.codeoid/codeoid.db   # SQLite path
CODEOID_TRANSCRIPT_DIR=~/.codeoid/transcripts
CODEOID_RESUME_MAX_SESSIONS=200          # sessions restored from disk at startup, newest-first.
                                        #   Resume is also time-boxed, so raising this costs
                                        #   startup time; the remainder stays on disk and loads
                                        #   on a later restart.
CODEOID_DEFAULT_PROVIDER=claude         # backend for sessions created without --provider
                                        #   (claude | codex | pi | qwen | gemini-cli | openai | gemini |
                                        #    llamacpp — see docs/local-models.md).
                                        #   An unknown, disabled or uninstalled backend stops the
                                        #   daemon at startup. Resumed sessions and the conductor
                                        #   keep their own backend.

# Outward control plane (/mcp/control) — see docs/mcp-control.md. Off by default.
CODEOID_MCP_CONTROL_ENABLED=false       # mount the endpoint
CODEOID_MCP_CONTROL_ACTIONS=false       # also allow create / send / interrupt / destroy

# Routines (scheduled and triggered agent runs) — see docs/routines.md. On by default.
CODEOID_ROUTINES_ENABLED=true           # run the scheduler and accept routine commands
CODEOID_ROUTINES_MAX_CONCURRENT=2       # routine runs executing at once, across all routines

# Forks, backend switches and rewinds (docs/FEATURES.md#how-a-fork-switch-or-rewind-carries-the-conversation)
CODEOID_NATIVE_CONTINUATION=true        # hand Claude/Codex the conversation in their own form; false = text transcript

# Memory
CODEOID_MEMORY=1                        # default: on; set to 0 to disable
CODEOID_MEMORY_DB_PATH=~/.codeoid/memory.db
CODEOID_MEMORY_MODEL=Xenova/bge-small-en-v1.5   # HF model id
CODEOID_MEMORY_CACHE_DIR=~/.codeoid/models
CODEOID_MEMORY_CLUSTERS=0               # k-means topic clusters in workspace index
CODEOID_MEMORY_EMBEDDINGS=1             # semantic recall; 0 = keyword-only, model never loaded
                                        #   (memory.embeddings.maxWindows, default 8, in config.json:
                                        #   embedding slices per long episode)

# Workspace index (always-in-context memory pointer)
CODEOID_WORKSPACE_INDEX=1               # auto-injected into system prompt
CODEOID_WORKSPACE_INDEX_EPISODE_THRESHOLD=5
CODEOID_WORKSPACE_INDEX_TIME_MS=60000
CODEOID_WORKSPACE_INDEX_DEBOUNCE_MS=15000

# CLI output compression (Layer B)
CODEOID_COMPRESS=0                      # opt-in: rewrites Bash output via rules
CODEOID_COMPRESS_EXCLUDE=                # comma-separated cmd prefixes to skip
CODEOID_COMPRESS_PIPES=0                 # allow compressing piped commands
CODEOID_COMPRESS_MIN_BYTES=1024          # skip compression below this size

# Advisory guards (see FEATURES.md → Guards)
CODEOID_GUARD_REPEAT_TOOL=1              # loop-breaker advisory; on by default
CODEOID_GUARD_REPEAT_TOOL_EXCLUDE=       # comma-separated tool patterns to ignore

# Auto-rotation (Layer D)
CODEOID_AUTO_ROTATE=0                   # auto-rotate backing session near context ceiling
CODEOID_AUTO_ROTATE_WARN_PCT=0.75        # warn at this occupancy (no action)
CODEOID_AUTO_ROTATE_PCT=0.9              # rotate at this occupancy (when enabled)
CODEOID_AUTO_ROTATE_HARD_PCT=0.97        # hard-rotate even when disabled
CODEOID_AUTO_ROTATE_MIN_TURNS=5          # skip rotation on fresh sessions

# Anthropic (optional, for Haiku cluster labeling)
ANTHROPIC_API_KEY=sk-ant-...            # if set, clusters get LLM-quality labels

# OAuth (browser sign-in for the web UI) — the authorization server turns on
# only when BOTH of these are set.
GOOGLE_CLIENT_ID=...                    # Google IdP client id
GOOGLE_CLIENT_SECRET=...                # Google IdP client secret
CODEOID_OAUTH_CLIENT_ID=codeoid          # optional: OAuth client id (default "codeoid")

# Telegram frontend
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123,456
```

### Config file

Optional `~/.codeoid/config.json` (env vars take precedence):

```json
{
  "daemonUrl": "ws://127.0.0.1:7400",
  "zeroidUrl": "highflame",
  "apiKey": "zid_sk_...",
  "agentIdentity": {
    "accountId": "personal",
    "projectId": "dev"
  },
  "memory": {
    "enabled": true,
    "dbPath": "~/.codeoid/memory.db",
    "model": "Xenova/bge-small-en-v1.5"
  },
  "session": {
    "defaultProvider": "claude"
  }
}
```

### `~/.codeoid/.env` — env-only secrets

Some daemon settings are env-only (notably the Telegram frontend). Rather than
exporting them in whatever shell happens to launch the daemon — where a restart
from a different terminal silently drops them — put them in `~/.codeoid/.env`.
`codeoid start` loads this file before anything reads `process.env`, it's
co-located with `config.json` (cwd-independent), mode `600`, and never in git.
A variable already set in the real environment still wins.

```bash
# ~/.codeoid/.env
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_ALLOWED_USER_IDS=6714605885
# CLAUDE_CODE_OAUTH_TOKEN=    # written by Settings → Claude → "Sign in with Claude"
# ANTHROPIC_API_KEY=          # only if you have neither a sign-in nor a Claude Code login
```

## Signing a backend in, instead of pasting a key

Settings → **Claude** → **Sign in with Claude** runs the backend's own login
(`claude setup-token`) inside the daemon and stores the subscription credential
it mints as `CLAUDE_CODE_OAUTH_TOKEN` in the `.env` above. Two steps: open the
link it shows, then paste back the code the page displays.

This exists for the case where codeoid IS the whole surface — a hosted sandbox,
a phone — and there is no shell in which to run the vendor's login by hand. On a
machine where you do have a shell, `claude login` still works and codeoid picks
that credential up unchanged; nothing here replaces it.

The sign-in requires the `settings:write` scope, because it writes to the same
`.env` that scope already governs. It takes effect for **new sessions** — a
running session keeps the environment it started with. Only Claude is wired
today; the mechanism is per-backend and the others follow.

## Several Claude accounts

One daemon can hold several Claude credentials: a personal Pro/Max subscription, a company one, and a company gateway token per workspace.
Each session runs on one of them, two sessions can run on two accounts at once, and a session can be switched to another account mid-conversation.

```bash
codeoid account login company-max        # sign a subscription in as "company-max" (claude setup-token)
codeoid account add-gateway gw-team-a --base-url https://gateway.example.com --header "x-workspace: team-a"
codeoid account add-token personal-max   # paste a token you already have (sk-ant-oat01-…); --api-key for an API key
codeoid account ls                       # names and kinds — never a token
codeoid account default company-max      # what every session that hasn't chosen its own runs on
codeoid new review ~/code/app --account gw-team-a
codeoid account use review personal-max  # switch a running session, keeping the conversation
codeoid account rm gw-team-a
```

**How a switch keeps the conversation.**
An account is only the credential a session's Claude subprocess starts with.
Claude keeps its session history as local files in one config directory, shared by every account, so a switched session restarts its Claude query with the new credential and resumes the same Claude session.
The switch takes effect on the session's next turn; a turn already running finishes on the old account.
The first turn after a switch re-reads the whole context at full price, because prompt caching is per organization, and it counts against the new account's limits.

**The built-in `default` account** is the daemon's own environment: your `claude login`, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in `~/.codeoid/.env`.
It is what every session uses until you name another default.
A session that follows the default moves with it on its next turn; a session that chose its own account (`--account`, `account use`) stays on it.

**A session never silently changes account.**
Applying an account removes every competing Claude credential variable before setting its own, so a stray `ANTHROPIC_API_KEY` can't take over a subscription session.
A session whose account was removed refuses to run until you switch it, rather than falling back to another credential.
One thing this cannot override is an `apiKeyHelper` in your Claude settings file, since that is configuration of the shared config directory rather than environment.

**`codeoid account login` never touches your own `claude login`.**
It runs `claude setup-token` against a throwaway config directory and keeps only the token it prints, so signing a second account in can't replace the personal sign-in your other sessions use.

**Where it is stored.**
Accounts live in `~/.codeoid/claude-accounts.json`, mode 0600.
Tokens are never sent to a client: listing accounts shows names, kinds, and a gateway's URL and header names only.
Managing accounts needs `settings:write` (listing needs `settings:read`); switching a session needs `session:send`.
