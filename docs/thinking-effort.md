# Thinking effort

How hard a session's model thinks before it answers, on one scale for every backend.

## The scale

**Default, Off, Minimal, Low, Medium, High, Extra high (`xhigh`), Max.**

**Default** sends nothing: the backend picks, as it always has.
Every other level is mapped to the backend's own setting (below).
A level a backend has no exact match for goes to its nearest one.

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

- **Now**, on the running backend: Claude (except to or from Off), Qwen (except back to Default), pi.
- **From the next turn**: Codex, OpenAI, llama.cpp, Gemini — they take it with every request — and the exceptions above, whose next turn starts a fresh query that resumes the conversation.
- **After a restart, before the next turn**: the Gemini CLI, which reads it only from its settings at startup. It resumes the conversation, as after a model change.

## What each level means on each backend

| codeoid | Claude | Codex | OpenAI | Qwen | pi | Gemini 2.5 | Gemini 3 / Gemini CLI 3 | llama.cpp |
|---|---|---|---|---|---|---|---|---|
| Off | thinking disabled | `none` | `none` | `low` (can't turn off) | `off` | budget 0 (Pro: 128) | `minimal` | `enable_thinking: false` |
| Minimal | `low` | `minimal` | `minimal` | `low` | `minimal` | budget 512 | `minimal` | `low` |
| Low | `low` | `low` | `low` | `low` | `low` | budget 2048 | `low` | `low` |
| Medium | `medium` | `medium` | `medium` | `medium` | `medium` | budget 8192 | `medium` | `medium` |
| High | `high` | `high` | `high` | `high` | `high` | budget 16384 | `high` | `high` |
| Extra high | `xhigh` | `xhigh` | `xhigh` | `xhigh` | `xhigh` | budget 24576 | `high` | `high` |
| Max | `max` | `max` | `xhigh` | `max` | `max` | budget 32768 (Flash: 24576) | `high` | `high` |

Notes:

- **Claude** keeps adaptive thinking, with readable summaries, at every level but Off.
- **OpenAI** sends `reasoning_effort`; a model that doesn't reason rejects it.
- **Gemini** sends `thinkingConfig` per request: a token budget for 2.5 models, a level for 3.x; other models get nothing.
- **The Gemini CLI** on 2.5 models takes the Gemini 2.5 budgets, but one that every 2.5 model accepts, since the settings can't know which runs: Off is 128 (Pro's minimum) and Max is 24576 (Flash's maximum).
  It runs with a settings overlay of its usual home (an account's, or yours) whose `chat-base-2.5` and `chat-base-3` aliases carry the budget or level; logins and chats are linked, so nothing else changes.
  The overlays live under `~/.codeoid/accounts/gemini-cli-effort/`.
- **llama.cpp** sends both through the model's chat template (`chat_template_kwargs`): `enable_thinking` for Qwen3-style templates, `reasoning_effort` (low / medium / high) for gpt-oss-style ones.
  A template that reads neither ignores them.
