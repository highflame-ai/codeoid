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

# Daemon
CODEOID_DAEMON_URL=ws://127.0.0.1:7400  # (for CLI + TUI client)
CODEOID_DB_PATH=~/.codeoid/codeoid.db   # SQLite path
CODEOID_TRANSCRIPT_DIR=~/.codeoid/transcripts

# Memory
CODEOID_MEMORY=1                        # default: on; set to 0 to disable
CODEOID_MEMORY_DB_PATH=~/.codeoid/memory.db
CODEOID_MEMORY_MODEL=Xenova/bge-small-en-v1.5   # HF model id
CODEOID_MEMORY_CACHE_DIR=~/.codeoid/models
CODEOID_MEMORY_CLUSTERS=0               # k-means topic clusters in workspace index

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
# ANTHROPIC_API_KEY=          # only if not logged in via `claude login`
```
