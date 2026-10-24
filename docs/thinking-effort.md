# Thinking effort

How hard a session's model thinks before it answers, on one scale for every backend.

## The scale

**Default, Off, Minimal, Low, Medium, High, Extra high (`xhigh`), Max.**

**Default** is the backend's own choice, as it always was.
Most backends are simply sent nothing; two keep a level once it's set, so Default is sent to them explicitly, as the level they would pick unasked: Codex gets your configured `model_reasoning_effort` (project config included), else the running model's own default; pi gets the default in your pi settings (`defaultThinkingLevel`, else Medium; a project's `.pi/settings.json` isn't read, since pi honours it only for a project you trust).
On Codex, a model its catalog doesn't list, with no effort configured, has no known default: Default then sends nothing, so a level set earlier on that thread stays until the next thread.
Every other level is mapped to the backend's own setting (below).
A level a backend has no exact match for goes to its nearest one; pi clamps a level a model doesn't take to the nearest it does.

## Setting it

- **Web UI:** the **effort** selector next to the model picker, or `/effort` in the prompt box.
- **TUI:** `/effort` opens a picker; `/effort high` (or `off`, …, `max`, `default`) sets it directly.
- **Telegram:** `/effort` shows it; `/effort <level>` sets it.
- **CLI:** `codeoid new <name> <dir> --effort high`.
- **Config:** `session.defaultEffort` (or `CODEOID_DEFAULT_EFFORT`) for sessions created without one.

It belongs to the session, like its model: it survives a daemon restart, and it stays the same across a backend switch, since the scale is the same everywhere.
A session resumed after a restart keeps its own; the config default applies only to new sessions.
Changing it needs `session:send` on your own session.

## Which levels a model takes

Where the backend says, the pickers offer only the model's own levels:

- Claude reports each model's levels (and whether it takes effort at all).
- Codex reports each model's supported efforts and its default.
- pi reports which models reason and which levels each takes.

The others (OpenAI and OpenAI-compatible endpoints, llama.cpp, Qwen, Gemini, the Gemini CLI) don't, so every level is offered and marked "support unknown".
A level the server refuses fails the turn with a note saying so; pick another, or Default.

## When a change applies

A change never cuts a running turn short.

- **Now**, on the running backend: Claude (except to or from Off, or back to Default), Qwen (except back to Default), pi.
  A change that needs a rebuild waits while the backend has background work running, so that work isn't stopped.
- **From the next turn**: Codex, OpenAI, llama.cpp, Gemini — they take it with every request — and the exceptions above, whose next turn starts a fresh query that resumes the conversation.
- **After a restart, between turns**: the Gemini CLI, which reads it only from its settings at startup.
  It restarts before the next turn that starts with no background work running, and resumes the conversation, as after a model change.

## What each level means on each backend

| codeoid | Claude | Codex | OpenAI | Qwen | pi | Gemini 2.5 | Gemini 3 Flash / Pro | Gemini CLI (2.5 / 3) | llama.cpp |
|---|---|---|---|---|---|---|---|---|---|
| Off | thinking disabled | `none` | `none` | `low` (can't turn off) | `off` | budget 0 (Pro: 128) | `minimal` / `low` | 512 / `LOW` | `enable_thinking: false` |
| Minimal | `low` | `minimal` | `minimal` | `low` | `minimal` | budget 512 | `minimal` / `low` | 512 / `LOW` | `low` |
| Low | `low` | `low` | `low` | `low` | `low` | budget 2048 | `low` / `low` | 2048 / `LOW` | `low` |
| Medium | `medium` | `medium` | `medium` | `medium` | `medium` | budget 8192 | `medium` / `high` | 8192 / `HIGH` | `medium` |
| High | `high` | `high` | `high` | `high` | `high` | budget 16384 | `high` / `high` | 16384 / `HIGH` | `high` |
| Extra high | `xhigh` | `xhigh` | `xhigh` | `xhigh` | `xhigh` | budget 24576 | `high` / `high` | 24576 / `HIGH` | `high` |
| Max | `max` | `max` | `xhigh` | `max` | `max` | budget 32768 (Flash: 24576) | `high` / `high` | 24576 / `HIGH` | `high` |

Notes:

- **Claude** keeps adaptive thinking, with readable summaries, at every level but Off.
- **OpenAI** sends `reasoning_effort`; a model that doesn't reason rejects it.
- **Gemini** sends `thinkingConfig` per request: a token budget for 2.5 models (Flash-Lite thinks from 512, or 0 for Off), a level for 3.x (Pro takes only Low and High); other models get nothing.
- **The Gemini CLI** gets values every model of the family accepts, since its settings can't know which model runs: 2.5 budgets from 512 (Flash-Lite's floor; Pro can't turn thinking off, so Off is the lowest budget) to 24576 (Flash's ceiling), and for 3.x only Low and High (all that Pro takes).
  It runs with a settings overlay of its usual home (an account's, or yours) whose `chat-base-2.5` and `chat-base-3` aliases carry the budget or level; logins and chats are linked, so nothing else changes.
  The overlays live under `~/.codeoid/accounts/gemini-cli-effort/`.
- **llama.cpp** sends both through the model's chat template (`chat_template_kwargs`): `enable_thinking` for Qwen3-style templates, `reasoning_effort` (low / medium / high) for gpt-oss-style ones.
  A template that reads neither ignores them.
- **pi** saves a thinking-level change as your global default in its settings, so codeoid runs it from an overlay of its agent directory: your logins and sessions are linked, and `settings.json` is a fresh copy at each start, so one session's effort never changes your own pi or other sessions.
  The overlays live under `~/.codeoid/accounts/pi-session/`.
  pi's OAuth refresh locks the real `auth.json`, so codeoid's pi and one you run yourself refresh in turn; only a sign-in or sign-out made in both at the same moment isn't serialized.
- The Gemini CLI and pi overlays of an account's home are removed with the account.
- **At Default**, a backend reads its own config as it always did: Qwen applies a project's `.qwen/settings.json` reasoning effort, Claude your Claude Code effort setting (your own, or the project's `.claude/settings.json`). A level you set overrides them.
- **A project's own Gemini CLI settings** (`.gemini/settings.json` in the workdir) outrank your user settings, so a project that redefines `chat-base-2.5` or `chat-base-3` there overrides the effort on the Gemini CLI.
