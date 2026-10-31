# opencode backend

[opencode](https://opencode.ai) 2.x as a codeoid backend (#447): one integration that opens opencode's 75+ model providers (GitHub Copilot, OpenRouter, Bedrock, Vertex, Azure, local Ollama, …) to sessions, routines and loops, with codeoid's approvals, spend caps and memory on top.

## Setup

1. Install opencode **2.2.x**. codeoid speaks the 2.x server API only (2.x replaced 1.x's API wholesale) and checks the version the server reports; anything else is refused with a message saying so, and the backend is taken off the picker.
2. Give opencode a model credential. Two ways:
   - **Environment keys.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and other `*_API_KEY` / `*_API_TOKEN` variables in the daemon's environment (`~/.codeoid/.env`) reach opencode. Anything else (`AWS_*` for Bedrock, say) goes through `CODEOID_AGENT_ENV_ALLOW`.
   - **A stored sign-in.** opencode keeps sign-ins in its database, and codeoid's opencode has its own (below), so sign in against that one: `OPENCODE_DB=~/.codeoid/opencode/opencode.db opencode auth login`. Don't run opencode's TUI on that database: approvals you save there ("always") would be rules codeoid never sees, so codeoid deletes any it finds.
3. Pick it: `codeoid new <name> <dir> --provider opencode`, the web UI's backend picker, or `session.defaultProvider: "opencode"`.

```json
{
  "providers": {
    "opencode": {
      "enabled": true,
      "command": "opencode",
      "dbPath": "~/.codeoid/opencode/opencode.db",
      "agent": "build"
    }
  }
}
```

| Setting | Default | |
| --- | --- | --- |
| `providers.opencode.enabled` | `true` | Register the backend (it shows as unavailable, with the fix, when the binary is missing). |
| `providers.opencode.command` | `opencode` | Binary to run: a name on `PATH` or a path. |
| `providers.opencode.dbPath` | `opencode/opencode.db` beside codeoid's `dbPath` | opencode's database for codeoid's sessions. Relative paths resolve from codeoid's config dir. |
| `providers.opencode.agent` | opencode's default (`build`) | The opencode agent sessions run: `build`, `plan` (read-only planning), or one of your own. |

## How it runs

- **One private server per daemon.** The first opencode session's first turn starts `opencode serve --stdio --port 0 --hostname 127.0.0.1`; every opencode session shares it. It listens on loopback only, with a fresh random password each start (HTTP Basic). If it dies, the next turn starts a new one and sessions resume. It stops with the daemon, and can't outlive one: it exits when the pipe codeoid holds closes.
- **Never your own opencode.** Its database is codeoid's (`dbPath` above), so codeoid's sessions don't mix with yours. Your `OPENCODE_*` environment doesn't reach it; your global opencode config (`~/.config/opencode`) does, for providers and models. A repository's own opencode config is not read (`OPENCODE_DISABLE_PROJECT_CONFIG`), nor are `.claude` skills (`OPENCODE_DISABLE_CLAUDE_CODE`).
- **One opencode session per codeoid session**, in the session's working directory. Its `ses_…` id is the session's backing id: a daemon restart resumes it.

## What works

| | |
| --- | --- |
| Streaming | Reply and thinking stream as opencode writes them; each block ends in the session's history, so forks, backend switches, rewinds and routine summaries see the reply. |
| Tool cards and approvals | Every action opencode takes asks codeoid first (below). |
| Stop | Stop interrupts opencode's execution. |
| Resume | A daemon restart, or a server restart, resumes the opencode session by its id. If opencode lost it, the conversation continues from codeoid's history. |
| Fork, rewind | A fork at a turn opencode ran forks opencode's own session there (nothing lost, reasoning included). Otherwise — a turn from another backend, a rewound history — opencode gets a transcript. Files are codeoid's checkpoints, as on every backend. |
| Models and effort | The picker lists opencode's models with a credential (`provider/model`), each with its context window; a model's reasoning variants named like codeoid's levels (`minimal` … `max`, `none` = Off) are its efforts. Model and effort are switched on the session before a prompt when they changed. |
| Cost | opencode reports the dollar cost and tokens (input, output, reasoning, cache read and write) of every step. Each turn carries their sum, subagents' included, and the title opencode writes for a session's first prompt (billed without a step: codeoid takes it from opencode's running total), so spend caps count real spend, and a routine's cap stops the turn as the spend lands, not only between turns. |
| MCP | codeoid's memory, the goal blackboard, the registry's servers and its OAuth servers (through the daemon's relay) are mounted for the session. Memory recall is auto-approved as on other backends. |
| Subagents | opencode's subagents show as subagents, their calls ask codeoid like the main agent's, and their spend counts. A background subagent shows as background work; when it finishes, opencode hands the result to the model and answers, and codeoid shows that turn. |
| Commands and skills | opencode's slash commands and skills are listed in the command palette and run with `/name args`. |
| Questions | opencode's questions (its forms) are asked through codeoid's dialogs; dismissing one tells the model you didn't answer. |
| Messages mid-turn | A message sent while opencode works steers the running turn (opencode takes it at the next step); one sent as "later" is answered after the current reply, in the same turn. |
| Agent | `providers.opencode.agent` picks the opencode agent sessions run. |

## Approvals

codeoid owns the policy, so opencode is set to ask about every action and never settle one itself:

- Every codeoid session (and every child session a subagent starts) gets the rule *ask for everything*, last, so nothing an opencode agent allows survives it. The injected config says the same globally.
- opencode documents that a subagent uses its own permissions, and its built-in `explore` subagent allows shell commands. When the server starts, codeoid reads every agent's rules; if a subagent would act without asking, codeoid restarts the server once with overrides that turn those allows into asks, and refuses to use a server where one remains.
- codeoid answers each request once (`once`) or rejects it with the reason, which the model reads and carries on from. It never answers "always".
- Anything that can't be shown faithfully is rejected without asking: an action codeoid doesn't know (a plugin's, an MCP server codeoid didn't mount), another session's MCP mount, a shell request without its command. A request still waiting when the server goes away counts as rejected.
- The tools that act without asking (opencode's session rename/move, worktree and schedule tools) are turned off.
- Code Mode (opencode's `execute` tool, which runs a script that calls tools and `fetch`) is turned off: on opencode 2.2.2 a script's `fetch` reaches any URL without asking anyone. opencode's browser tools stay off too, as opencode's own agents have them.

What the approver sees, in codeoid's terms (so the same rules, hooks and roles apply as on Claude):

| opencode | codeoid |
| --- | --- |
| `shell` | `Bash` with the full `command` |
| `edit` (edit / write / patch) | `Edit` / `Write` with the absolute `file_path` |
| `read`, `glob`, `grep` | `Read`, `Glob`, `Grep` |
| `webfetch`, `websearch` | `WebFetch`, `WebSearch` |
| `subagent`, `skill`, `todowrite` | `Task`, `Skill`, `TodoWrite` |
| an MCP tool of a codeoid mount | `mcp__<server>__<tool>` |
| `question` | `opencode_question` — then the questions themselves |
| `external_directory` | `opencode_external_directory` |

Because every call reaches the gate under these names, a pipeline phase's capability role is enforced on opencode, as on Claude.

## Limits

- **Your own opencode MCP servers and plugin tools are refused.** Mount servers through codeoid's registry instead (`mcpServers` in codeoid's config); they reach opencode and every other backend.
- **A question asks twice in guarded mode**: once to let opencode ask, then the question.
- **codeoid accounts don't apply** (`codeoid account …`): opencode's credentials are its environment keys and its own sign-ins.
- **Another backend's history reaches opencode as a transcript**, not as opencode messages.
- **Subscription sign-ins report $0.** opencode prices a ChatGPT-subscription turn at $0; how codeoid should cost and cap subscriptions is a codeoid-wide question, not settled here.
- **Not in opencode 2.x:** language-server diagnostics and session sharing.
- **Not yet:** a codeoid-wide plan mode (opencode's `plan` agent is reachable through `providers.opencode.agent`), an agent picker, quick questions that don't enter the conversation, manual compaction (codeoid has no compact action yet), and a view of the files a step changed.

## Troubleshooting

- *opencode is unavailable: no opencode binary found* — install it, or set `providers.opencode.command`.
- *opencode X is installed, but codeoid supports opencode 2.2.x* — install a 2.2 release.
- *opencode agents … would run tools without asking codeoid* — an agent's rules allow tools in a way codeoid's overrides can't reach (a plugin, say). Remove it from your global opencode config.
- *No models in the picker* — opencode lists only models it has a credential for; see Setup.
- *A session runs a model you didn't pick* — with no model chosen, opencode uses its own default, which with no credentials set up is one of opencode's free hosted models (on opencode.ai). Pick a model, or set one in your opencode config.
- The server's log goes nowhere by default; run `opencode serve` by hand with the same `OPENCODE_DB` to see what it says about your configuration.
