# Which MCP server reaches which backend

codeoid runs sessions on several backends (Claude, Codex, the Gemini CLI, Qwen, and the daemon-run OpenAI, Gemini, pi and llama.cpp).
An MCP server you configure should reach all of them, not just the one whose config it was written in.
This page says where each kind of server comes from, which backends it reaches, and why.

## Where servers come from

| Source | Example | Scope |
| --- | --- | --- |
| codeoid's config | `mcpServers` in `~/.codeoid/config.json` | every session |
| An adopted server | "Sign in with codeoid" in the capabilities drawer (#390) | every session |
| Claude's global config | `claude mcp add -s user`: top-level `mcpServers` in `~/.claude.json` | every session |
| Claude's local scope | `claude mcp add` (its default): `projects[<dir>].mcpServers` in `~/.claude.json` | sessions in that directory |
| A project's servers | the repo's `.mcp.json` | sessions in that directory, once approved |

(Claude Code takes no MCP servers from its `settings.json` files, so neither does codeoid.)

## Who reaches what

- **codeoid's config, adopted servers, and Claude's global config** are in the daemon-wide registry: every backend in every session gets them.
- **Claude's local scope** is your own choice for one directory: every backend in a session there gets it.
  On a daemon shared by several accounts, it's the daemon user's file, so it counts for every account's sessions in that directory, as the global config does.
  codeoid's approvals of a project's servers, though, are each account's own.
- **A project's servers** are the repo's choice: a cloned repo can name any command or URL.
  Claude Code asks before it connects them, and codeoid asks for the other backends: they reach them once approved — in Claude Code, or in codeoid (the drawer's **Review & approve**, or `codeoid mcp approve <session> <server> --yes <fingerprint>`, which prints the entry and its fingerprint first).
  - Approving a command-based (stdio) server lets it run on this machine as the user the daemon runs as, with that user's files and network: approve only what you'd run yourself.
  - Claude Code's approval is by name, as Claude Code stores it: an edit to an entry Claude Code approved stays approved (and with "approve all project servers", so does a new entry).
    So with Claude Code's approval, being able to edit the repo's `.mcp.json` — or a script an approved entry runs — is being able to run a command as the daemon's user, outside any backend's sandbox, from the next session's first turn or the next refresh.
    Keep that in mind before approving a project's servers in Claude Code for a repo an agent works in unsandboxed edit modes, or prefer codeoid's approval, which a changed entry loses.
    Every project server applied to a session is in the audit log (`mcp.workdir_server_applied`, with its fingerprint and whose approval).
    It is read only from your own `~/.claude.json` (its `enabledMcpjsonServers`, `disabledMcpjsonServers` and `enableAllProjectMcpServers` for that directory) — never from a file inside the repo directory, such as `.claude/settings.local.json`: anything there could be the repo (or a build script, or the agent) approving its own servers.
    An approval Claude Code stored in the repo directory is made once more in codeoid.
  - codeoid's approval is of exactly the entry you were shown: if the repo changes it — before you click or afterwards — it needs approving again.
    It covers the entry's command, arguments, environment, URL and headers, shown before you approve exactly as the repo wrote them (nothing hidden or shortened; characters that wouldn't show, such as bidi overrides or zero-width spaces, are escaped as `\u{…}`).
    An environment or header value that refers to a variable (`${GITHUB_TOKEN}`) is shown as the reference, and resolves from the daemon's environment when the server starts.
    It doesn't cover the code a command runs: a server started from a script in the repo (`node ./mcp/server.js`) runs whatever that script is when it starts.
  - Approving in codeoid also covers a server you denied in Claude Code: the two approvals are separate.
- **Claude** always loads its own copies of Claude's servers (the Claude CLI reads its config itself); codeoid adds the rest of the registry.
- **Qwen** reads a project's `.mcp.json` itself, under its own rules rather than codeoid's approval (measured: codeoid's copy of the same name is overridden by Qwen's own), so on Qwen every name the `.mcp.json` declares is left to Qwen.
  Since those tools may be the repo's server, a `readonly` trust you gave a server of that name doesn't make them run without asking — on Qwen or on Claude, which reads the file too.
  Your own servers of other names still reach Qwen through codeoid.

A project's server runs in the project's directory, as each backend that reads it runs it.
It can't ask, through a `${VAR}` reference in its environment, for codeoid's own secrets (`CODEOID_*`, `ZEROID_*`, `TELEGRAM_*`); other references resolve from the daemon's environment, as Claude Code resolves them from yours.
Its name must be plain (letters, digits, `.`, `_`, `-`; no `__`, not starting with `mcp__`), so its tools can't pass for another server's.

The capabilities drawer says, for each of Claude's servers, whether it reaches the session's other backends, and if not, why.

## When two entries share a name

- codeoid's own entries (its config, adopted servers, its built-ins) win over Claude's.
- Your local-scope entry wins over one from Claude's global config, as Claude Code orders them.
- A project's server never stands in for anything of the same name, or a look-alike (`My-DB` beside `my_db`): it's left to Claude.
- Two directories' servers are different servers, and so are two accounts': a session only ever reaches its own.

## Servers that need a sign-in

A remote server that signs in with OAuth (Notion, Slack or GitHub through a gateway, most SaaS servers) works on every backend once codeoid signs in to it: adopt it ("Sign in with codeoid").
Until then it's left to Claude, which signs in itself in an interactive Claude Code session.
codeoid notices such a server when it answers a request carrying no credentials with the MCP sign-in challenge (a `401` pointing at its authorization metadata), or when Claude reports it needs authentication; for the next ten minutes (and after that, until it answers) that account's other backends don't mount it — they'd only get `401`s, or start a sign-in inside the agent — and the drawer says to adopt it.
A server that refuses a token you configured yourself isn't held back: that token needs fixing, not an adoption.

OAuth servers reach the backends that own their MCP clients (Codex, the Gemini CLI, Qwen) through a loopback relay, so the token stays in the daemon — see [mcp-oauth-design.md](mcp-oauth-design.md) §5.1.

## When a change takes effect

A session reads its servers before its first turn.
A change to Claude's config afterwards — a `claude mcp add` (any scope), an edited `.mcp.json`, an approval — doesn't restart anything on its own: the drawer shows "MCP servers changed", and you apply it with **Refresh MCP servers**, `/mcp refresh` (web UI, TUI, Telegram) or `codeoid mcp refresh <session>`.
Refreshing restarts the session's backend, which picks the conversation back up (the Gemini CLI, which can't resume its own session, is handed the conversation again).
Asked while a turn, an approval or background work is running, it's applied before the next turn instead: a refresh never cuts work short.
Opening the drawer only looks; it applies nothing.

Agents' file tools ask before they read or write `~/.claude.json`, in every mode: it holds servers' tokens, and Claude Code's approvals of project servers live there.
Shell commands aren't covered by that: in a mode where shell commands run without asking, an agent can edit it (or codeoid's database), and so approve servers — as it can do anything else the daemon's user can.

Approving, reviewing and refreshing act on a session of your account and project, as every session action does; approving needs `settings:write` on a token of your own (not a delegated one), refreshing needs `session:send`.
There's no command yet to withdraw a codeoid approval; until there is, editing the entry in `.mcp.json` (any change to it) makes it need approving again.
