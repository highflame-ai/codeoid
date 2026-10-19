# Which MCP server reaches which backend

codeoid runs sessions on several backends (Claude, Codex, the Gemini CLI, Qwen, and the daemon-run OpenAI, Gemini, pi and llama.cpp).
An MCP server you configure should reach all of them, not just the one whose config it was written in.
This page says where each kind of server comes from, which backends it reaches, and why.

## Where servers come from

| Source | Example | Scope |
| --- | --- | --- |
| codeoid's config | `mcpServers` in `~/.codeoid/config.json` | every session |
| An adopted server | "Sign in with codeoid" in the capabilities drawer (#390) | every session |
| Claude's global config | `claude mcp add -s user`, top-level `mcpServers` in `~/.claude.json`, `~/.claude/settings.json` | every session |
| Claude's local scope | `claude mcp add` (its default), `projects[<dir>].mcpServers` in `~/.claude.json` | sessions in that directory |
| A project's servers | the repo's `.mcp.json`, `.claude/settings.json` | sessions in that directory, once approved |

## Who reaches what

- **codeoid's config, adopted servers, and Claude's global config** are in the daemon-wide registry: every backend in every session gets them.
- **Claude's local scope** is the user's own choice for one directory: every backend in a session there gets it.
- **A project's servers** are the repo's choice: a cloned repo can name any command or URL.
  Claude Code itself asks before it connects them, and so does codeoid for the other backends: they reach them once approved, either in Claude Code (its own approval of the project's servers), or in codeoid (the drawer's **Approve**, or `codeoid mcp approve <session> <server>`).
  codeoid's approval is for that exact entry: if the repo edits it, it needs approving again.
  Claude Code's approvals are read from `~/.claude.json` and from the project's `.claude/settings.local.json` — that file only when git says it isn't part of the repo, since a repo that committed one could otherwise approve its own servers.
- **Claude** always loads its own copies of Claude's servers (the Claude CLI reads its config itself); codeoid adds the rest of the registry.
- **Qwen** reads a project's `.mcp.json` itself, under its own folder trust (measured: codeoid's copy of the same name is overridden by Qwen's own), so on Qwen those follow Qwen's trust settings rather than codeoid's approval; your own servers, and a project's from its settings files, still reach it through codeoid.

The capabilities drawer says, for each of Claude's servers, whether it reaches the session's other backends, and if not, why.

## When two entries share a name

- codeoid's own entries (its config, adopted servers, its built-ins) win over Claude's.
- Your local-scope entry wins over one from Claude's global config, as Claude Code orders them.
- A project's server never stands in for anything of the same name, or a look-alike (`My-DB` beside `my_db`): it's left to Claude.
- Two directories' servers of the same name are different servers: a session only ever reaches its own.

## Servers that need a sign-in

A remote server that signs in with OAuth (Notion, Slack or GitHub through a gateway, most SaaS servers) works on every backend once codeoid signs in to it: adopt it ("Sign in with codeoid").
Until then it's left to Claude, which signs in itself in an interactive Claude Code session.
codeoid notices such a server when it answers with the OAuth challenge (a `401` asking for a bearer token), or when Claude reports it needs authentication; from then on the other backends don't mount it (they'd only get `401`s, or start a sign-in inside the agent), and the drawer says to adopt it.

OAuth servers reach the backends that own their MCP clients (Codex, the Gemini CLI, Qwen) through a loopback relay, so the token stays in the daemon — see [mcp-oauth-design.md](mcp-oauth-design.md) §5.1.

## When a change takes effect

A session reads its servers when it starts.
A change to Claude's config afterwards — a `claude mcp add`, an edited `.mcp.json`, an approval — doesn't restart anything on its own: the drawer shows "MCP servers changed", and you apply it with **Refresh MCP servers**, `/mcp refresh` (web UI, TUI, Telegram) or `codeoid mcp refresh <session>`.
Refreshing restarts the session's backend, which picks the conversation back up; asked during a turn, it's applied before the next one.
A new session, or one resumed after a daemon restart, always starts with the current config.
