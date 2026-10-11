# Driving codeoid from another agent (`/mcp/control`)

codeoid can be driven by an outside agent over MCP.
Claude Code, Cursor, Codex, or a CI job mounts one URL and can then list your sessions, read what they did, and prompt them, with every call checked and recorded under the caller's identity.

It is off by default.

## Turn it on

In `~/.codeoid/config.json`:

```json
{
  "mcpControl": {
    "enabled": true,
    "allowActions": false
  }
}
```

Restart the daemon.
With `allowActions: false` the endpoint is observe-only: it can list sessions, read transcripts and usage, and wait for a session to finish.
Set `allowActions: true` to also let callers create, prompt, interrupt, and destroy sessions.

For a single run, the env switches override the file: `CODEOID_MCP_CONTROL_ENABLED=true` and `CODEOID_MCP_CONTROL_ACTIONS=true`.

| Key | Default | Meaning |
| --- | --- | --- |
| `mcpControl.enabled` | `false` | Mount `/mcp/control`. Off means the path returns 404. |
| `mcpControl.allowActions` | `false` | Expose `create_session`, `send_message`, `interrupt_session`, `destroy_session`. |
| `mcpControl.requireDelegated` | `false` | Accept only delegated agent tokens (delegation depth 1 or more), so every caller is its own principal in the ZeroID tree rather than borrowing a person's token. |
| `mcpControl.allowedOrigins` | `[]` | Browser origins allowed to call the endpoint. Empty refuses any request that carries an `Origin` header, which blocks DNS-rebinding attacks from web pages. MCP clients that are not browsers send no `Origin`. |
| `mcpControl.maxWaitSeconds` | `120` | The longest a `wait` may block (1–600). |

## Connect Claude Code

```bash
codeoid mcp config --scopes operate
```

prints an entry for `.mcp.json`:

```json
{
  "mcpServers": {
    "codeoid": {
      "type": "http",
      "url": "http://127.0.0.1:7400/mcp/control",
      "headersHelper": "codeoid mcp headers --scopes operate"
    }
  }
}
```

The helper prints a fresh `Authorization` header each time Claude Code connects, and again after a `401`.
That matters because a ZeroID token is short-lived; nothing has to be pasted, and nothing goes stale.
Any MCP client that accepts a static header works too: run `codeoid mcp headers` and copy the value.

`--scopes` narrows the token at ZeroID, in the token itself:

| Preset | Scopes | Lets the caller |
| --- | --- | --- |
| `observe` (default) | `session:list`, `session:watch` | list, read transcripts and usage, wait |
| `operate` | observe + `session:create`, `session:send`, `session:interrupt` | also create, prompt, and stop sessions |
| `full` | operate + `session:destroy` | also destroy sessions |

An explicit comma-separated list works too.
No preset includes `session:approve`, and the endpoint has no approve tool at all.

A local-mode daemon (`codeoid start --local`) has one token that carries every scope, so `--scopes` cannot narrow it; the helper says so on stderr.

## Tools

| Tool | Kind | Needs | What it does |
| --- | --- | --- | --- |
| `list_sessions` | observe | `session:list` | Sessions in your tenant, with status, backend, workdir, and token/cost usage. |
| `get_session` | observe | `session:list` | One session, plus the tool calls it is waiting on its owner to approve (with `session:watch`). |
| `read_transcript` | observe | `session:watch` | Messages, newest page first; pass the returned `before` cursor to page back. |
| `get_usage` | observe | `session:list` | Usage for one session, or daily totals across yours (daily totals come from the memory store; with memory off they read zero). |
| `wait_for_session` | observe | `session:list` | Block until the session stops working: its turn ended, or it is waiting on its owner. |
| `create_session` | act | `session:create` | A plain session: name, workdir, and optionally backend and model. |
| `send_message` | act | `session:send` | Prompt a session. With `wait: true`, returns the reply. `idempotencyKey` makes a retried send deliver once. |
| `interrupt_session` | act | `session:interrupt` | Stop the current turn. |
| `destroy_session` | act | `session:destroy` | Destroy the session and its transcript. |

Sessions are addressed by id or by exact name; an ambiguous name is refused with the matching ids.
`tools/list` shows only the tools the caller's token can use.

A typical CI step: `create_session`, then `send_message` with `wait: true`, then read `outcome`:

- `idle`: the turn finished; `reply` holds what the agent said.
- `waiting_approval` or `waiting_dialog`: the agent wants to do something its owner has to approve. The caller cannot approve it; tell a person.
- `error`: the turn failed; `notices` carries the system messages that explain why.
- `still_working`: the wait timed out; call `wait_for_session` again.
- `destroyed`: the session was destroyed while you waited.

Each caller may hold 16 waits at once; past that, poll `get_session` instead.

## Security model

This endpoint can start agents and prompt them, so it gets no shortcuts.

- **Same authentication.** The bearer token is verified on every request by the same verifier the WebSocket handshake uses: a ZeroID JWT, or the local-mode token. There is no separate key. The token is read only from the `Authorization` header, never from the URL.
- **Same authorization.** Each tool becomes an ordinary protocol message, checked by the protocol schema and handled by the same function that enforces scopes and tenancy for every WebSocket client. A token that cannot create a session over WebSocket cannot create one here.
- **Driving is not authorizing.** There is no approve tool. A session prompted through this endpoint still parks every guarded tool call (a shell command, a file write) on its owner's approval, exactly as if the prompt had been typed.
- **Dispatcher and collaborative sessions are off limits for actions.** The conductor, its workers, and a collaborative goal's orchestrator and role children are steered by codeoid itself; this endpoint can read them but not prompt, interrupt, or destroy them. Because that check needs the target's role, every act tool also requires `session:list`; all three presets include it.
- **Plain sessions only.** `create_session` accepts a name, workdir, backend, and model, and nothing else: no roles, collaborations, or packs.
- **Failed authentication is throttled.** After 20 failed attempts in a minute from one address, the endpoint answers 429 for the rest of that minute without verifying anything. A forged token cannot make the daemon fetch the issuer's keys in a loop.
- **Every call is attributed.** Each call writes an `mcp.control.call` audit row under the caller's subject, with the delegating principal for an agent token and the outcome, alongside the rows the ordinary path writes (`session.send`, `session.create`, …). A prompt sent by an agent appears in the transcript as that agent's message.

### Known limits

- Revocation takes effect when the token is next verified, which is every request, but a revoked ZeroID token that has not expired is still accepted until expiry, as it is on a WebSocket connection.
- `requireDelegated` needs tokens minted by delegation (RFC 8693). `codeoid mcp headers` exchanges the configured API key, so the caller's identity is the key's identity. A handshake in which each external agent exchanges its own credential for a codeoid-scoped delegated token is the next step.
- Responses are single JSON documents, so there is no progress stream; long work is followed with `wait_for_session`.
- `read_transcript` with a `before` cursor that is not in the session's memory scans its on-disk transcript (bounded at 64 MB and 5 seconds), as the WebSocket `scrollback.page` does. A caller can repeat that scan; throttling it is a follow-up.
