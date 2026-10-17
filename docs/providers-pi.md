# pi as a codeoid backend

codeoid can run sessions on [pi](https://pi.dev) — the extensible coding agent from earendil-works — as an alternative to Claude Code.
One codeoid session maps to one warm `pi --mode rpc` subprocess; pi keeps its own durable session tree on disk and codeoid resumes it across daemon restarts.

## Setup

None required — codeoid **bundles pi** as a pinned dependency
(`@earendil-works/pi-coding-agent`), so the `pi` backend works out of the box.
Sign a model provider in once (`pi /login` from any pi, or export an API key
pi understands, e.g. `ANTHROPIC_API_KEY`) and create a session with it:

- **Web UI**: New session → Backend → `pi`
- **Wire**: `session.create` with `providerId: "pi"`

### Which pi binary runs

Resolved once at daemon startup, first match wins:

1. an explicit `providers.pi.command` (verified at startup — a typo'd path
   shows up as "unavailable" in the logs, not as a first-turn spawn failure)
2. a system `pi` on `PATH` (`npm install -g @earendil-works/pi-coding-agent`)
3. the **bundled** copy, run via the daemon's own runtime

The bundle is pinned deliberately: the injected approval bridge is coupled to
pi's RPC + extension API, and the lockfile freezes the exact pi version the
bridge was tested against. Use a system install or `command` override when you
want a different pi — you own the compatibility of that pairing.

If no binary resolves anywhere (bundled install failed and nothing on PATH),
pi is reported as *supported but unavailable*: the daemon logs the fix at
startup and `session.set_provider` returns the same actionable hint.

Config knobs (all optional, `~/.codeoid/config.json`):

```jsonc
{
  "providers": {
    "pi": {
      "enabled": true,      // false removes pi from the catalog
      "command": "pi"       // wrapper script or absolute path
    }
  }
}
```

## What works

| pi feature | codeoid surface |
| --- | --- |
| Streaming text + thinking | Normal transcript rows |
| Tool calls | codeoid's approval flow — modes (interactive/guarded/autonomous), budgets, `session.approve`, audit log |
| **pi extensions** (`~/.pi/agent/extensions`, `.pi/extensions`) | Hooks run inside pi unchanged. Extension dialogs (`ctx.ui.select/confirm/input/editor`) surface as codeoid dialogs (`session.ui_request`); `ctx.ui.notify` becomes an info/system row |
| Extension slash commands, prompt templates, skills | `session.commands` catalogs → the `/` palette; `/name args` passes through for pi to expand |
| Model switching | `/model provider/model-id` (catalog reported after the first turn) |
| Mid-turn sends | codeoid `now`/`next` → pi steering; `later` → pi follow-up |
| Session resume | pi's session file is the backing id; daemon restarts `switch_session` back into it |
| Rotation (`/rotate`) | `new_session` — fresh pi context, same codeoid session |
| Usage/cost | Per-turn deltas from pi's session stats |

## How tool approval works (the bridge)

pi ships **no built-in permission system** — gating is delegated to extensions.
codeoid injects a small bridge extension (`pi -e …`, regenerated per session) that hooks pi's `tool_call` event and routes every tool through codeoid's `canUseTool` gate before pi executes it.
Denials block the tool inside pi; approval-form patches (`patchableKeys`) merge into pi's live tool input.
The bridge announces itself on session start; **if it fails to load, turns fail closed** rather than running tools ungated, and any tool that somehow executes without passing the gate is flagged loudly in the transcript.

## Limitations

- pi extension **custom TUI components** (`ctx.ui.custom()`, custom renderers/editors/themes) don't cross RPC — pi degrades them itself; everything logic-level keeps working.
- The model catalog and command list populate after the first turn of a pi session (no idle subprocess just to list them).
- The pi subprocess runs with an allowlisted environment (provider API keys and `PI_*` pass through; codeoid's own secrets never do). Uncommon provider vars (e.g. `AWS_*` for Bedrock) need `CODEOID_AGENT_ENV_ALLOW=NAME1,NAME2`.
- With an Anthropic **subscription** (OAuth) login, pi sends Claude-Code identity headers and pins the first system block — that's pi upstream behavior, not codeoid's.
- codeoid memory/recall and the conductor fleet tools are Claude-session features today.

## Switching backends mid-session

`/provider pi` (or `session.set_provider`) swaps a live session's backend while keeping the session id, scrollback, transcript, and identity.
The conversation so far is carried into the incoming backend as a structured-text transcript — tool calls rendered as structured blocks (name, input JSON, fenced output), oldest turns dropped first past ~24k chars.
Stateless backends (gemini, openai) go further: they replay the history in their native function-call structure on every request.
Claude and Codex continue natively — their own fork on the same backend, native history from another (see [how a fork, switch or rewind carries the conversation](FEATURES.md#how-a-fork-switch-or-rewind-carries-the-conversation)).
pi stays a faithful transcript, **not** a native continuation: its RPC has no history-import or fork entry point, so prompt-cache state and extension state don't cross.
Switching resets the model to the new backend's default, and mid-turn switches are rejected — interrupt first.
`/provider claude` brings the session back the same way.
