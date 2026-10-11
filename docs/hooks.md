# Daemon-native hooks

pi's in-process extension hooks are the single best idea in the pi harness — and they only work for pi sessions, because they run inside the pi process.
codeoid's **hook bus** lifts the same idea to the daemon: user-configured hooks dispatched on the provider-neutral events the daemon already sees, so one rule set applies uniformly whether a session runs on claude, pi, gemini, or openai.

Rules like:

- "block any tool call that touches `.env`"
- "rewrite `rm -rf` commands before they reach the approval prompt"
- "redact secrets from recorded tool output"
- "git-checkpoint after every turn"
- "POST an audit event to my webhook on every provider switch"

This layer is distinct from pi's own extensions (those keep working inside pi sessions) and from Claude Code's `settings.json` hooks (those keep working inside the Claude Code subprocess).
The hook bus sits in the codeoid daemon, between the provider event stream and Session's handling — the one place every backend's traffic flows through.

## Configuration

Hooks are declared in `~/.codeoid/config.json`. No plugin loading, no JS API — v1 hooks are shell commands or webhooks:

```json
{
  "hooks": {
    "enabled": true,
    "entries": [
      {
        "event": "tool_call",
        "matcher": "^(Write|Edit|Bash)$",
        "type": "command",
        "command": "~/.codeoid/hooks/env-guard.sh",
        "name": "env-guard",
        "timeoutMs": 5000
      },
      {
        "event": "after_turn",
        "type": "webhook",
        "url": "https://audit.example.com/codeoid"
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `event` | One of the events below. |
| `matcher` | Optional regex on the tool name (`tool_call` / `tool_result` only). Absent = every tool. Invalid regexes fail config load. |
| `type` | `command` (shell via `/bin/sh -c`, cwd = the session's workdir) or `webhook` (HTTP POST). |
| `command` / `url` | Required for the respective type. |
| `timeoutMs` | Per-hook budget, default 10 000, max 60 000. A timed-out hook is killed and ignored. |
| `name` | Display name used in logs and the info messages shown to the user. |

`CODEOID_HOOKS_ENABLED=false` disables every hook for one invocation without touching the file.

## Events

| Event | When | Can do |
| --- | --- | --- |
| `tool_call` | Before a tool executes, **before** the approval gate | block; mutate input |
| `tool_result` | After a tool completes | patch the recorded output |
| `before_turn` | A fresh turn is starting (not mid-turn injections) | append to the system prompt |
| `after_turn` | Turn finished, carries the normalized result | observe |
| `session_start` | Session created (`source`: `"new"` \| `"resume"`) | observe |
| `session_end` | Session destroyed | observe |
| `provider_switched` | Backend switched mid-session (`from`, `to`, `seeded`) | observe |
| `rotated` | Backing context rotated (`reason`, `rotationCount`) | observe |

Every payload also carries `sessionId`, `sessionName`, `workdir`, and `providerId`.

### Ordering: hooks run before approval

A `tool_call` hook is a **policy** layer, not a convenience layer.
It runs before codeoid's approval gate, so:

- A hook **block** short-circuits — the user is never prompted, the autonomous turn budget is never spent, and an info message explains which hook blocked and why.
- A block wins even for auto-approved safe tools (Read/Grep/Glob) — the gate is uniform.
- A hook **mutation** replaces the tool input before the approval prompt renders, so the user approves what will actually run. An info message records the mutation.
- A mutation applies only on a backend that runs the rewritten input: claude, pi, openai, gemini, and llama.cpp.
  codex, the Gemini CLI, and qwen answer an approval with yes or no and run the input they proposed, so on those a rewritten call is **refused** (audited as `session.hook_rewrite_refused`) rather than shown and then run as originally proposed.
  To change what such a backend runs, block the call and let the agent retry.

This matches pi's `tool_call` extension semantics.

### `tool_result` honesty note

Native backends run their own agent loop — by the time the daemon sees a tool result, the backend's model has already consumed the original.
`updatedOutput` therefore governs what codeoid **records**: scrollback, transcript, and the canonical history (which is what a switched-to backend sees).
Use it to redact transcripts, not to lie to the current model.

## Hook contract (command)

The event payload arrives as JSON on **stdin**. The hook responds with:

- **exit 0** — stdout may carry a JSON outcome:
  - `{"decision": "block", "reason": "..."}` — block the tool (`tool_call` only)
  - `{"updatedInput": {...}}` — replace the tool input (`tool_call` only)
  - `{"updatedOutput": "..."}` — replace the recorded output (`tool_result` only)
  - `{"systemPromptAppend": "..."}` — append to the system prompt (`before_turn` only)
- **exit 2** — block, with stderr as the reason (mirrors Claude Code's hook contract).
- **any other exit / timeout / malformed JSON** — the hook is logged and ignored.

Fail-open is deliberate for **infra** failures: a crashed hook script must not brick every session.
Blocking is always an explicit hook decision (exit 2 or `decision: block`).

Multiple hooks on one event run in declaration order; the first block short-circuits, and input mutations chain (each hook sees the previous hook's output).

Example `env-guard.sh`:

```sh
#!/bin/sh
# Block any tool call whose input mentions a .env file.
if grep -q '\.env' -; then
  echo '{"decision":"block","reason":".env files are off-limits"}'
fi
```

## Hook contract (webhook)

The event payload is POSTed as JSON.
A 2xx response body may carry the same JSON outcome object; non-2xx responses and network errors are logged and ignored.

## Security

Hook commands run arbitrary user-configured code by design — but they run in the **daemon's** trust context, whose environment holds the ZeroID root key and other codeoid secrets.
Therefore:

- Commands get the **hardened subprocess environment** (the same allowlist machinery as provider subprocesses — shared basics only, `CODEOID_*`/`ZEROID_*`/`TELEGRAM_*` always denied). They never inherit raw `process.env`.
- Extra variables can be passed explicitly via `CODEOID_AGENT_ENV_ALLOW=NAME1,NAME2`, the same deliberate operator escape hatch providers use.
- Event data travels on stdin, never in env vars.
- Captured hook output is capped at 1 MiB.

An in-process JS plugin kind is deliberately not offered in v1 — it is a much larger security surface. A future hook kind can add it behind its own review.
