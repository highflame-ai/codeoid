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
| `fs:read` | Read files + list directories under a session's workdir. With `session:create` too, browse folder names anywhere under `CODEOID_FS_BROWSE_ROOT` (default: the whole host, never credential stores) to pick a workdir |
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
# The Google ID token is exchanged at ZeroID for a ZeroID token. ZeroID v1.12+
# only accepts that exchange from an authenticated client the ID token was
# issued to, so register a confidential client at ZeroID whose client_id is
# GOOGLE_CLIENT_ID (token_endpoint_auth_method client_secret_post, with the
# Google issuer configured for that audience) and set its secret here.
CODEOID_ZEROID_CLIENT_ID=...             # optional: defaults to GOOGLE_CLIENT_ID
CODEOID_ZEROID_CLIENT_SECRET=...         # env only; required by ZeroID v1.12+

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

## Worktree setup recipe

A worktree codeoid creates (a fork, a compare branch, a routine's `--worktree` run) holds tracked files only.
A repository says how to make one usable in a committed `.codeoid/setup.yaml`:

```yaml
copy: [.env, "config/*.local.json"]   # ignored files, copied from your checkout
share: [node_modules]                  # directories, linked to your checkout
command: bun install --ignore-scripts  # runs in the new worktree, only once you trust it
timeoutSec: 600
resources: { ports: 2, env: [DATABASE_URL] }   # declared only, for now
```

The recipe is read from your checkout's committed `HEAD`, never from a branch, the new worktree, or uncommitted edits, so a branch can't change how its own worktree is prepared.
`copy` takes ignored files only, never overwrites anything, and never follows a symlink out of the repository.
`share` is a deliberate isolation break: each entry is a writable link into your checkout, so a worker writing there changes it for you and for every other worktree.
Keep it to regenerable dependency directories; config and tooling directories (`.claude`, `.codeoid`, `.vscode`, `.idea`, `.husky`, `.git*`) are refused.

The `command` runs only when you opt in twice.
Set `worktree.setup.runCommands` to `trusted-repos` (Settings, or `config.json`), then run `codeoid worktree trust` in the repository.
It shows the command and records the repository with the recipe's git blob id, direnv-allow style, and with who trusted it: on a shared daemon, the entry applies only to that person's sessions.
When the recipe changes, its command stops running and the session says so until you trust it again; `codeoid worktree trust --off` withdraws trust.

A trusted command also runs only when the worktree's own base commit is reviewed content.
That commit must carry the very recipe you trusted, and be on your checkout's branch (an ancestor of its `HEAD`).
A fork from another branch, a fetched pull request, a fork of a session on a `codeoid/*` branch with commits of its own, or the work-in-progress commit codeoid saves when a session ends all fail that check.
Such a worktree still gets its copied files and shared directories; its command is skipped, and the session says why.
This doesn't cover everything: an agent working directly in your checkout can still commit to your branch, and those commits pass.
That is one more reason to prefer `--ignore-scripts`.

Trust covers the repository's committed content at setup time, not just the one line you reviewed.
The command runs as you, on a clean checkout of the worktree's base commit (a fork's uncommitted changes are applied only after it), together with every script it invokes from that tree: `package.json` lifecycle scripts, a `Makefile`, a script in the repo.
Prefer a command that runs no repository scripts, such as `bun install --ignore-scripts` or `npm ci --ignore-scripts`.
A setup failure is reported as an infrastructure problem, not the agent's; a routine run fails before its agent starts.
Recipes aren't supported on Windows.

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
codeoid account add-gateway gw-team-a --base-url https://gateway.example.com --header x-workspace   # value asked for, never on argv
codeoid account add-token personal-max   # paste a token you already have (sk-ant-oat01-…); --api-key for an API key
codeoid account ls                       # names and kinds — never a token
codeoid account default company-max      # what every session that hasn't chosen its own runs on
codeoid new review ~/code/app --account gw-team-a
codeoid account use review personal-max  # switch a running session, keeping the conversation
codeoid account use review default       # pin it to your own login
codeoid account use review --follow-default  # track the daemon default again
codeoid account rm gw-team-a
```

**Amazon Bedrock accounts.**
A `bedrock` account runs Claude on Bedrock with a bearer token (`AWS_BEARER_TOKEN_BEDROCK`), either on AWS itself or on a Bedrock-compatible endpoint.
It can carry the settings that belong with that token: the region, the Bedrock model IDs the `opus` / `sonnet` / `haiku` / `fable` aliases map to, and telemetry.

```bash
codeoid account add-bedrock aws --set AWS_REGION=us-east-1     # AWS itself; the token is asked for
codeoid account add-bedrock team --base-url https://bedrock.example.com/v1 \
  --set ANTHROPIC_DEFAULT_SONNET_MODEL=us.anthropic.claude-sonnet-5 \
  --set CLAUDE_CODE_ENABLE_TELEMETRY=1 --set OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com \
  --set OTEL_EXPORTER_OTLP_HEADERS                            # asked for without echo; never on the command line
codeoid account add-bedrock team --from-settings ~/.claude/settings.json --replace   # move an existing setup into an account
```

The settings an account takes are the region (`AWS_REGION`, `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION`, `ANTHROPIC_BEDROCK_REGION_PREFIX`), `ANTHROPIC_BEDROCK_SERVICE_TIER`, the models (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` with their `_NAME`, `_DESCRIPTION` and `_SUPPORTED_CAPABILITIES`), `CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_ENABLE_TELEMETRY`, and the `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` and `OTEL_EXPORTER_OTLP_{PROTOCOL,ENDPOINT,HEADERS}` telemetry variables; anything else is refused.
`--replace` replaces the whole account, so give every setting again (or `--from-settings` once more).
The web form shows settings as typed, except `OTEL_EXPORTER_OTLP_HEADERS`, which usually carries a key and is masked; like a token, no setting's value is ever sent back to a client.
Telemetry headers need a telemetry endpoint set beside them, which must be https (or localhost).
Without mappings the Claude CLI uses its own Bedrock model IDs (a first-party ID such as `claude-sonnet-5` becomes `us.anthropic.claude-sonnet-5`); map the aliases when your endpoint serves different ones.
A session's model is then sent by its family: with `ANTHROPIC_DEFAULT_OPUS_MODEL` set, a session on `opus` or any `claude-opus-*` ID (including `[1m]`) runs on the mapped ID, and a fallback model in the same family is dropped, since it would be the same model.
`/model` also takes a Bedrock model ID or inference-profile ARN directly (`us.anthropic.claude-…`, `arn:aws:bedrock:…`); a session switched back to another kind of account keeps that ID until you change it.
The daemon's own `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` don't apply to a Bedrock account; only its own settings do.
Nor do the daemon's AWS variables other than the region, or its `OTEL_*` variables, even when `CODEOID_AGENT_ENV_ALLOW` lets them through to agents: they could send the account's token or telemetry key elsewhere.
codeoid's memory labeler calls the Anthropic API with the daemon's own key whatever account a session uses; leave memory off if no session content may leave your Bedrock setup.

Claude Code applies the `env` block of your own `~/.claude/settings.json` over every session's environment, whatever its account.
A named account of any kind therefore refuses to run while that file sets a credential or provider variable (a Bedrock setup, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, …) or an `apiKeyHelper`: move it into an account (`--from-settings` reads a Bedrock setup) and remove it from the file.
Proxies, CA bundles, telemetry and model settings there are yours and are left alone.

**How a switch keeps the conversation.**
An account is only the credential a session's Claude subprocess starts with.
Claude keeps its session history as local files in one config directory, shared by every account, so a switched session restarts its Claude query with the new credential and resumes the same Claude session.
The switch takes effect on the session's next turn; a turn already running finishes on the old account.
The first turn after a switch re-reads the whole context at full price, because prompt caching is per organization, and it counts against the new account's limits.

**The built-in `default` account** is the daemon's own environment: your `claude login`, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in `~/.codeoid/.env`.
It is what every session uses until you name another default.
A session that follows the default moves with it on its next turn; a session that chose its own account (`--account`, `account use`) stays on it.
Choosing `default` explicitly pins a session to the built-in account, so it stays on your own login even when the daemon default is another account; `account use <session> --follow-default` makes it follow the daemon default again.

**A session never silently changes account.**
Applying an account removes every competing Claude credential or provider variable before setting its own (all of `ANTHROPIC_*` except model settings, every `CLAUDE_CODE_USE_*` provider switch, token file descriptors, and the like), so a stray `ANTHROPIC_API_KEY` can't take over a subscription session.
A named account also refuses to run in a workdir whose own Claude settings (`.claude/settings.json` or `settings.local.json`, in the workdir or a parent below your home directory) set a credential variable such as `ANTHROPIC_BASE_URL` or `ANTHROPIC_BEDROCK_BASE_URL`, or a credential helper (`apiKeyHelper`, `awsAuthRefresh`, `otelHeadersHelper`, …), since a cloned repo could otherwise send the account's token to a host of its choosing.
Those files are read as the Claude CLI reads them (a byte-order mark or UTF-16 makes no difference), and one codeoid can't parse is refused rather than skipped.
The CLI also re-reads them while a turn runs, so on a named account an agent's edit to a Claude settings file always waits for your approval, in every mode; a shell command that writes one can't be checked this way.
A Bedrock account also refuses every `AWS_*` variable there but the region (a repo's own AWS config file can name an endpoint that receives the token) and every `OTEL_*` variable (where its telemetry, and the telemetry key, go and what they carry).
Switching a session's account, or replacing or removing the account it runs on, stops the session's Claude process if it is idle, so no process keeps running on the old credential.
A session whose account was removed refuses to run until you switch it, rather than falling back to another credential.

**`codeoid account login` never touches your own `claude login`.**
It runs `claude setup-token` against a throwaway config directory and keeps only the token it prints, so signing a second account in can't replace the personal sign-in your other sessions use.

**Where it is stored.**
Accounts live in `~/.codeoid/accounts.json`, mode 0600, with every other backend's (below).
A `claude-accounts.json` from an earlier version is imported on first start and left as it was.
Tokens are never sent to a client: listing accounts shows names, kinds, a gateway's or Bedrock endpoint's URL, and header and setting names only.
Managing accounts needs `settings:write` (listing needs `settings:read`).
Choosing a session's account needs `settings:write` too, whichever way: creating a session with `--account`, `account use` (including back to `default`), and forking or comparing a session that has an account of its own.
It decides whose credential the agent runs on, which account is billed, and where the conversation is sent.
The account list is daemon-wide, not per tenant: like the rest of `settings:write`, it belongs to whoever runs the daemon.

**Agents can't read the stored tokens.**
Agent file tools are refused on codeoid's credential files (`accounts.json`, `claude-accounts.json`, `endpoints.json`, `config.json`, `.env`, `codeoid.db`, the local-mode token), on every account's home under `~/.codeoid/accounts/`, on each agent CLI's own stored login (`~/.claude/.credentials.json`, Codex's `auth.json`, `~/.qwen/oauth_creds.json`, the Gemini CLI's `oauth_creds.json` and `google_accounts.json`, pi's `auth.json`), and on any process's `/proc/<pid>/environ` or memory, in every mode.
On Claude this is enforced in a `PreToolUse` hook as well as the approval gate, so it also holds for reads the CLI would allow by itself.
A search rooted above those files, such as a `Grep` over your home directory, is never auto-approved and waits for you instead.

What this does not cover:

- Shell commands can't be checked this way. In guarded mode Claude and the Gemini CLI ask before running one, but Codex's guarded policy and qwen run commands they consider read-only (like `cat`) without asking, and autonomous mode runs every command.
- Code the workdir itself runs (a project's Claude hooks, `statusLine`, MCP servers) runs as your user and can read any of these files. Only open workdirs you trust, the same as running a repo's build scripts.

To keep a Claude session's credential out of the environment its shell commands, hooks and MCP servers inherit, set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in `~/.codeoid/.env`.
That is the Claude CLI's own switch: on Linux it needs bubblewrap and runs every shell command in a sandbox, so codeoid leaves the choice to you.

**Behind the Highflame gateway** (a Forge sandbox, where the daemon's environment carries an `x-highflame-apikey` header), named accounts are refused: they would route requests around the gateway's guardrails and audit.

## Accounts for every backend

Every backend can hold several accounts the same way: two ChatGPT sign-ins for Codex, a team and a personal key for Qwen or the Gemini CLI, a second key for a local endpoint.
Each backend has its own default, and a session holds one choice per backend, so switching a session from Codex to Qwen and back keeps the account it had on each.
The design is in [backend-accounts-design.md](backend-accounts-design.md).

```bash
codeoid account login work --backend codex          # ChatGPT sign-in: open the link, enter the code shown
codeoid account add-key personal --backend gemini-cli   # a Gemini API key, asked for without echo
codeoid account add-key team --backend qwen --base-url bailian-plan-intl   # a Coding Plan key, asked for without echo
codeoid account add-key team --backend openai
codeoid account add-key team --backend pi --key-var OPENROUTER_API_KEY     # pi: one or more provider keys
codeoid account add-key staging --backend oai:gpu-box --header x-team      # another key or headers for an endpoint
codeoid account ls                                  # every backend; --backend <id> for one
codeoid account default work --backend codex
codeoid account use review work                     # for the backend the session is on now
codeoid account use review team --backend qwen      # takes effect when it is switched to qwen
codeoid account rm work --backend codex
```

What each backend's account is:

| Backend | Kinds | How it is applied |
|---|---|---|
| `codex` | ChatGPT sign-in, API key | its own `CODEX_HOME` |
| `gemini-cli` | API key | its own `GEMINI_CLI_HOME`, selecting API-key auth |
| `openai`, `gemini`, `llamacpp` | API key | the request's key, every turn |
| `qwen` | API key with its endpoint (a preset or a URL) | the key and base URL of the query |
| `pi` | provider keys (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …) | those variables, without pi's own stored logins |
| `oai:<endpoint>` | a key and/or headers | instead of the endpoint's own |

The Qwen OAuth free tier ended on 2026-04-15, so a Qwen account is always a key.

**How a switch keeps the conversation.**
Codex, the Gemini CLI and pi keep their login in a directory.
Each of their accounts gets a home under `~/.codeoid/accounts/<backend>/<name>/` in which every file of the vendor's own home is a link to the real one — config, MCP settings, skills, session history — except the login itself.
A switched session therefore restarts the backend on the new credential and resumes the same conversation; one whose native resume fails continues from codeoid's own copy of the history.
HTTP backends pick the new key up on the next request.

**A session never silently changes account.**
Applying an account removes the daemon's own credential variables for that backend first, so a stray `OPENAI_API_KEY` can't take over a ChatGPT session.
A session whose account was removed refuses to run until you switch it.
An endpoint account is tied to the server it was entered for: if the endpoint later points elsewhere, its accounts refuse to run until re-entered.
A named Gemini CLI account refuses to run in a workdir whose `.env`, `.gemini/.env` or `.gemini/settings.json` (in the workdir or a parent below your home directory) would redirect its credential, naming the file.
A named Qwen account does the same for `.qwen/settings.json` (a `modelProviders` entry, an auth type or base URL), `.qwen/.env` and `.env`, and runs in its own Qwen home whose settings are yours without provider entries, so neither a cloned repo nor your own provider list can send its key elsewhere.
A backend's default account can't be removed until you set another default (`codeoid account default <name> --backend <id>`, or `default`), so the sessions following it never move to another credential.

**Signing in never touches your own login.**
`codeoid account login` runs the vendor's own command (`claude setup-token`, `codex login --device-auth`) against a staging directory, and only a completed sign-in becomes the account's.
A Gemini CLI account is an API key: a consumer Google (AI Pro/Ultra) subscription can't be used with codeoid, so there is no Google sign-in.
An existing account is only replaced with `--replace`.

**A key-only backend needs no key in the environment** once it has an account: OpenAI and Gemini appear as backends as soon as one is added.
A session following such a backend's built-in default still needs `OPENAI_API_KEY` / `GOOGLE_API_KEY`, and says so instead of failing with a 401.

Managing accounts and choosing a session's account need `settings:write` from a token that wasn't delegated; listing needs `settings:read`.
