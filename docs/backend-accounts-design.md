# Accounts for every backend

Status: implemented on `feat/backend-accounts`.
Supersedes the Claude-only accounts of #392 while keeping its wire messages working.

## Problem

A session can switch backend (Claude → Codex → a local llama.cpp endpoint → Qwen) and keep its conversation.
Only Claude could also switch *credential*: a personal subscription, a company one, a gateway per workspace.
Every other backend ran on one machine-wide credential — `OPENAI_API_KEY`, `GOOGLE_API_KEY`, the single `~/.codex` or `~/.gemini` login, one key per endpoint.
Two sessions on Codex under two ChatGPT accounts, or one Qwen session on a team key and another on a personal key, needed two daemons.

## What an account is

An account is a named credential for ONE backend, and only the credential.
It changes nothing else a session runs with: the vendor's config, MCP servers, skills and — where the vendor keeps them — its native transcripts stay shared, so a session switched to another account carries on the same conversation.

- Accounts belong to a backend id: `claude`, `openai`, `codex`, `gemini`, `gemini-cli`, `qwen`, `pi`, `llamacpp`, or an endpoint `oai:<name>`.
  A credential entered for Codex is never offered to, or sent by, any other backend.
- Every backend has the built-in account `default`: the daemon's own environment or login, exactly what ran before this feature.
- Each backend has its own daemon default (initially `default`).
- A session holds one choice per backend.
  `null` follows that backend's daemon default; a name pins it; the literal `default` pins the built-in one.
  Switching a session's backend picks up its choice (or default) for the new backend; switching back restores the earlier one.
- A change takes effect on the session's next turn.
  A running turn keeps the credential it started with.
- A session whose chosen account was removed refuses to run and says so.
  A backend's default account can't be removed until another default is set, so the sessions following it never fall back to the daemon's own credential.
  It never falls back to another credential: that would run, bill and send the conversation under an account nobody picked.

## Kinds

What a backend accepts, and how it is applied.

| Backend | Kind | Stored | Applied as |
|---|---|---|---|
| `claude` | `subscription` | token (`sk-ant-oat01-…`) | `CLAUDE_CODE_OAUTH_TOKEN` (unchanged from #392) |
| | `gateway` | token, base URL, headers | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_CUSTOM_HEADERS` |
| | `api-key` | token | `ANTHROPIC_API_KEY` |
| `openai`, `llamacpp` | `api-key` | token | the HTTP client's key, rebuilt per turn |
| `oai:<name>` | `api-key` | token and/or headers, and the origin they were entered for | replaces the endpoint's own key and headers; refused if the endpoint has since moved to another origin |
| `gemini` | `api-key` | token | the client's key, per turn |
| `gemini-cli` | `api-key` | token | `GEMINI_API_KEY`, in an account home that selects API-key auth (a consumer Google subscription can't be used with codeoid, #192 — there is no Google sign-in kind) |
| `codex` | `chatgpt-login` | files in the account's home | `CODEX_HOME=<account home>` |
| | `api-key` | token, also written by `codex login --with-api-key` into the account home | `CODEX_HOME=<account home>` |
| `qwen` | `api-key` | token, base URL (preset or URL) | `OPENAI_API_KEY` / base URL on the query (Qwen OAuth's free tier ended 2026-04-15; there is no login kind) |
| `pi` | `api-keys` | a set of provider key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) | those variables, in an agent dir without pi's stored logins (`PI_CODING_AGENT_DIR`) |

Key, token and header values are write-only: stored 0600 by the daemon, never sent to a client, logged or audited.

## Account homes (process backends)

Codex, the Gemini CLI and pi keep their login in a directory, not a variable.
Each such account gets a home under `<configDir>/accounts/<backend>/<name>/` (0700) that is an *overlay* of the vendor's default home:

- every entry of the default home is a symlink to the real one — config, MCP settings, skills, session files and the vendor's state databases — refreshed before each spawn so new entries appear;
- except the vendor's credential files, which are the account's own (`auth.json` for Codex and pi) — or, for the Gemini CLI, left out so the daemon's own Google login (`oauth_creds.json`, `google_accounts.json`) never reaches an API-key account;
- and, for the Gemini CLI, `settings.json`, which is a copy of the default one selecting API-key auth (otherwise a default home that selects Google login would override an API-key account).

Sharing everything but the credential is what lets a switched session resume natively: Codex's thread, pi's session file and Qwen's session live where every account can read them.
A backend whose native resume fails after a switch falls back to codeoid's canonical history (`Session.#seedProviderFromHistory`), never to an empty conversation.

Removing an account deletes its home.

## Sign-in

`backend.login.*` brokers the vendor's own login command against the account's home (never the default one), as it already does for `claude setup-token`:

| Backend | Command | Mode |
|---|---|---|
| `claude` | `claude setup-token` | `code`: open the link, paste the code |
| `codex` | `codex login --device-auth` with `CODEX_HOME` | `device`: open the link, enter the one-time code shown in codeoid; finishes on its own |

A `device` login is finished with `backend.login.wait` instead of `submit`.
The attempt runs in a staging home; only a completed login is moved into the account's home, so a failed or cancelled attempt never replaces a working credential.

## Switching mechanics

Providers receive `resolveAccount()` and compare the resolved account's fingerprint (name, kind, generation — bumped on every change of the credential, not on the vendor's own token refresh) at the start of each turn:

- HTTP backends (`openai`, `llamacpp`, `gemini`, endpoints) rebuild their client.
- Claude rebuilds its query and resumes (unchanged).
- Process backends (Codex, Gemini CLI, Qwen, pi) restart their child with the new environment and resume natively; failing that, they reseed from canonical history.

## Protocol

New, generic messages; the `claude.accounts.*` and `session.set_claude_account` messages and the `claudeAccount` / `effectiveClaudeAccount` session fields keep working as the `claude` backend's view.

- `accounts.list {backend?}` → `accounts.result {backends: [{backend, displayName, defaultAccount, accounts, kinds}]}`.
  `kinds` describes each kind's fields and sign-in mode, so clients render forms without per-backend code.
- `accounts.set {backend, name, kind, token?, baseUrl?, headers?, env?, replace?}`.
  An existing name is refused unless `replace: true` — the daemon enforces it, not just the client.
- `accounts.remove {backend, name}`, `accounts.set_default {backend, name}`.
- `session.set_account {sessionId, account, backend?}` (`backend` defaults to the session's current one).
- `session.create {…, account?}`.
- `SessionInfo.account` / `effectiveAccount` for the session's current backend (`"<name> (missing)"` when unusable).
- `backend.login.start {backend, account, replace?}` for `claude` and `codex` (`LOGIN_ACCOUNT_ONLY_BACKENDS` lists those that sign in only as a named account); `PendingBackendLogin` gains `mode` and, for `device`, `userCode`; `backend.login.wait {loginId}`.

## Authorization

As for Claude accounts and endpoints: listing needs `settings:read`; adding, removing, signing in, setting a default and choosing a session's account need `settings:write` from an undelegated token — they decide whose credential an agent runs on, who is billed, and who is sent the conversation.

## Project overrides

A cloned repository can try to redirect a named account's credential.
Claude's `.claude/settings*.json` check is unchanged.
The Gemini CLI reads `.env` and `.gemini/.env` from the workdir upward and `.gemini/settings.json`; a named Gemini CLI account refuses to run in a workdir whose project files set a credential, base URL, proxy variable or auth type, naming the file.
qwen-code loads a workspace `.qwen/settings.json` (folder trust is off by default) whose `modelProviders` entry wins over the base URL and key codeoid gives it, and `.qwen/.env` / `.env` upward; a named Qwen account refuses to run in a workdir that sets `modelProviders`, `providerProtocol`, `security.auth`, `model.baseUrl` or an `OPENAI_*` / `DASHSCOPE_*` / `QWEN_*` / proxy variable there.
A Qwen account also runs in its own `QWEN_HOME` — an overlay whose `settings.json` is the user's without those keys — so the user's own provider entries can't route the account's key elsewhere either.
Codex project config was checked against codex-cli 0.154 and can't redirect its auth; pi's project files are not checked (pi isn't verified here), and like every backend it runs project code as the daemon user, which no per-account check contains.

## Storage and migration

`<configDir>/accounts.json` (0600, atomic, re-read when it changes on disk) holds every backend's accounts and default.
On first start, `claude-accounts.json` is imported as the `claude` backend, once (a marker records it, so deleting `accounts.json` later doesn't bring back accounts removed since); the old file is left untouched.
Any change — through codeoid or by hand — re-checks the sessions on that backend, and a session whose credential changed is released when idle.
Session meta stores `accounts: {<backend>: <choice>}`; an old `claudeAccount` is read as the `claude` entry.

## Not in scope

- Per-account model catalogs: the catalog is per backend, so accounts on different plans share one list.
- Accounts behind the Highflame gateway launch remain refused for Claude (they would route around it); other backends are unaffected.
