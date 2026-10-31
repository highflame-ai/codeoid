# opencode backend

[opencode](https://opencode.ai) 2.x as a codeoid backend (#447): one integration that opens opencode's 75+ model providers (GitHub Copilot, OpenRouter, Bedrock, Vertex, Azure, local Ollama, …) to sessions, routines and loops, with codeoid's approvals, spend caps and memory on top.

## Setup

1. Install opencode **2.2.5 or a later 2.2 release**. codeoid speaks the 2.x server API only (2.x replaced 1.x's API wholesale) and checks the version the server reports; anything else is refused with a message saying so, and the backend is taken off the picker. Earlier 2.2 releases are refused too: opencode 2.2.2 runs a shell command made only of redirections (`> file`) without asking anyone, so it could create or empty any file you can write. 2.2.5 asks for these.
2. Give opencode a model credential. Two ways:
   - **Environment keys.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and other `*_API_KEY` / `*_API_TOKEN` variables in the daemon's environment (`~/.codeoid/.env`) reach opencode. Anything else (`AWS_*` for Bedrock, say) goes through `CODEOID_AGENT_ENV_ALLOW`. They reach opencode's model providers only, never the shell its commands run in (see Approvals).
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
- **Never your own opencode.** Its database is codeoid's (`dbPath` above), so codeoid's sessions don't mix with yours, and so is its global config directory (`config/` beside the database). Your `OPENCODE_*` environment doesn't reach it. From your global opencode config (`~/.config/opencode/opencode.json[c]`) it takes only which providers and models you have (`provider`, `providers`, `model`, `small_model`, `enabled_providers`, `disabled_providers`); your plugins, agents, permissions, MCP servers and instructions there are not loaded. A repository's own opencode config is not read (`OPENCODE_DISABLE_PROJECT_CONFIG`), nor are `.claude` skills (`OPENCODE_DISABLE_CLAUDE_CODE`). opencode still keeps its logs and shell-output files under your own opencode data directories (`~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`): moving them would change those directories for every command opencode runs for you.
- **One opencode session per codeoid session**, in the session's working directory. Its `ses_…` id is the session's backing id: a daemon restart resumes it. opencode runs a session's tools where the session is, so a fork into a worktree of its own (or a session resumed in another directory) is moved there before it runs; one opencode won't move goes on in a new session there, from a transcript.

## What works

| | |
| --- | --- |
| Streaming | Reply and thinking stream as opencode writes them; each block ends in the session's history, so forks, backend switches, rewinds and routine summaries see the reply. |
| Tool cards and approvals | Every action opencode takes asks codeoid first (below). |
| Stop | Stop interrupts opencode's execution. Messages you sent mid-turn that opencode hadn't taken yet are withdrawn from its inbox, so the next turn doesn't get them. |
| Resume | A daemon restart, or a server restart, resumes the opencode session by its id. If opencode lost it, or it's deleted on the opencode server while in use (a turn running on it ends with an error), the conversation continues in a new one from codeoid's history. |
| Fork, rewind | A fork at a turn opencode ran forks opencode's own session there (nothing lost, reasoning included). Otherwise — a turn from another backend, a rewound history — opencode gets a transcript. Files are codeoid's checkpoints, as on every backend. |
| Models and effort | The picker lists opencode's models with a credential (`provider/model`), each with its context window; a model's reasoning variants named like codeoid's levels (`minimal` … `max`, `none` = Off) are its efforts. Model and effort are switched on the session before a prompt when they changed. |
| Cost | opencode reports the dollar cost and tokens (input, output, reasoning, cache read and write) of every step, a failed one included. Each turn carries their sum, subagents' included, and what opencode bills without a step — the title it writes for a session's first prompt, each request of a compaction — which codeoid takes from opencode's running total, read as each turn ends (opencode books the title just after the reply ends), each once. So spend caps count real spend, and a routine's cap stops the turn as the spend lands, not only between turns. |
| MCP | codeoid's memory, the goal blackboard, the registry's servers and its OAuth servers (through the daemon's relay) are mounted for the session. Memory recall is auto-approved as on other backends. |
| Subagents | opencode's subagents show as subagents, their calls ask codeoid like the main agent's, and their spend counts — one the model sends a follow-up to later, by its id, too, after a restart. A background subagent shows as background work; when it finishes, opencode hands the result to the model and answers, and codeoid shows that turn. Switching the session's model, or anything else that restarts its backend (an MCP or sign-in change), stops its subagents and its background shell commands, as on other backends: a request one had waiting is refused, and so is the turn opencode starts to report a stopped one. If such a turn still runs when the session is next used, codeoid stops it first, so the new message isn't left queued behind it. |
| Commands and skills | opencode's own slash commands (`/init`, `/review`, `/goal`), the prompts of the session's own MCP servers (`/<server>:<prompt>`) and opencode's skills are listed in the command palette and run with `/name args`. Commands from a config directory (`commands/*.md`, in `/etc/opencode` say) are not run as commands: opencode runs every `` !`…` `` of their template through the shell, your arguments substituted in, without asking anyone. A message naming one goes to the model as text, as does one naming a built-in that such a command replaced, or a built-in whose arguments hold `` !` ``. |
| Questions | opencode's questions (its forms) are asked through codeoid's dialogs; dismissing one tells the model you didn't answer. |
| Messages mid-turn | A message sent while opencode works steers the running turn (opencode takes it at the next step); one sent as "later" is answered after the current reply, in the same turn. One sent before the turn's prompt reached opencode goes after it. |
| Dropped connection | codeoid follows opencode on one live feed. If it drops, what happened meanwhile is read back from opencode when it reconnects: the running turn's text, steps, results and end; subagents started in the gap (their requests are then asked), and how each subagent went; and a turn opencode ran by itself in the gap (a background subagent's result), which is shown as a turn of its own. |
| Agent | `providers.opencode.agent` picks the opencode agent sessions run. |

## Approvals

codeoid owns the policy, so opencode is set to ask about every action and never settle one itself:

- Every codeoid session (and every child session a subagent starts) gets the rule *ask for everything*, last, so nothing an opencode agent allows survives it. The injected config says the same globally.
- opencode documents that a subagent uses its own permissions, and its built-in `explore` subagent allows shell commands. When the server starts, codeoid reads every agent's rules; if a subagent would act without asking, codeoid restarts the server once with overrides that turn those allows into asks, and refuses to use a server where one remains.
- codeoid answers each request once (`once`) or rejects it with the reason, which the model reads and carries on from. It never answers "always".
- Paths are shown as they really resolve. opencode asks about a directory outside the session's working directory only when the path as written is outside it, and reads and writes through a symlink inside it without asking; so a read or search that a symlink takes outside the working directory is asked as `opencode_external_directory`, which is never approved on its own (`Read`, `Glob` and `Grep` are, in guarded mode), and a write names the file it really changes.
- A fetch stays on the site you approved. opencode follows a fetch's redirects itself and asks about none of them, so while an approved fetch runs its session refuses every other site: a redirect to another site fails the call (the model can fetch the new address, which asks again), and one on the same site (`http` to `https` excepted, which is another site) is followed. A fetch of another site that starts while one runs in the same session is refused too, and the model can try it again.
- A shell line with no command in it — only `cd`, variable assignments, `export` / `unset` / `readonly` of names, comments — runs without asking: opencode 2.2.5 asks about a shell line only when it finds a command in it. codeoid shows it as a card that ran without asking. Such a line can still print a variable it expands (`X=${UNSET?$VAR}`), so each session's shell, and each subagent's, runs with a bare environment: `PATH`, `HOME`, user, shell, terminal, temp dir, locale, CA trust and proxies that carry no credentials. Model keys, anything passed with `CODEOID_AGENT_ENV_ALLOW`, and opencode's own config are the server's, not the shell's. A line with `$` in it, or anything else that ran unasked, still stops the server (below).
- Anything that can't be shown faithfully is rejected without asking: an action codeoid doesn't know (a plugin's, an MCP server codeoid didn't mount), another session's MCP mount, a shell request without its command. A request still waiting when the server goes away counts as rejected.
- The tools that act without asking (opencode's session rename/move, worktree and schedule tools) are turned off.
- No plugin but opencode's own runs: a plugin can settle a request itself, so opencode would never ask codeoid. Your global plugins aren't loaded (above); a server that lists any other (from opencode's system config directory, say `/etc/opencode`) is refused when it starts and before every turn, and if opencode ever runs a call without asking codeoid (other than a shell line with no command in it), codeoid stops the server and the turn ends saying so. The other sessions on the server are told only that codeoid restarted it.
- Code Mode (opencode's `execute` tool, which runs a script that calls tools and `fetch`) is turned off: on opencode 2.2.2 a script's `fetch` reaches any URL without asking anyone. opencode's browser tools stay off too, as opencode's own agents have them.

What the approver sees, in codeoid's terms (so the same rules, hooks and roles apply as on Claude):

| opencode | codeoid |
| --- | --- |
| `shell` | `Bash` with the full `command` |
| `edit` (edit / write / patch) | `Edit` / `Write` with the absolute `file_path` of the file really changed (`requested_path` when a symlink led there) |
| `read`, `glob`, `grep` | `Read`, `Glob`, `Grep` — or `opencode_external_directory` when a symlink in the working directory leads outside it |
| `webfetch`, `websearch` | `WebFetch`, `WebSearch` |
| `subagent`, `skill`, `todowrite` | `Task`, `Skill`, `TodoWrite` |
| an MCP tool of a codeoid mount | `mcp__<server>__<tool>` |
| `question` | `opencode_question` — then the questions themselves |
| `external_directory` | `opencode_external_directory` |

Because every call reaches the gate under these names, a pipeline phase's capability role is enforced on opencode, as on Claude.

## Limits

- **Your own opencode MCP servers and plugins aren't loaded.** Mount servers through codeoid's registry instead (`mcpServers` in codeoid's config); they reach opencode and every other backend.
- **The private server is private from other users, not from your own processes.** opencode takes its password only from its environment, which any process running as the daemon's user can read (`/proc/<pid>/environ`) — including a command you approved. Such a process can drive the server directly, outside codeoid's gate and audit. codeoid re-applies each session's rules and deletes saved "always" approvals before every turn, and stops a server that ran anything without asking, but it can't keep the password from your own user. To separate them, run the daemon as a dedicated user.
- **A question asks twice in guarded mode**: once to let opencode ask, then the question.
- **Commands opencode runs don't see the daemon's credentials.** The shell's environment is bare (see Approvals), so a command that needs a token or a cloud key has to get it from its own configuration (`gh auth login`, `~/.aws/credentials`), as it would for a user without those variables.
- **codeoid accounts don't apply** (`codeoid account …`): opencode's credentials are its environment keys and its own sign-ins.
- **Another backend's history reaches opencode as a transcript**, not as opencode messages.
- **Subscription sign-ins report $0.** opencode prices a ChatGPT-subscription turn at $0; how codeoid should cost and cap subscriptions is a codeoid-wide question, not settled here.
- **Not in opencode 2.x:** language-server diagnostics and session sharing.
- **Not yet:** a codeoid-wide plan mode (opencode's `plan` agent is reachable through `providers.opencode.agent`), an agent picker, quick questions that don't enter the conversation, manual compaction (codeoid has no compact action yet), and a view of the files a step changed.

## Troubleshooting

- *opencode is unavailable: no opencode binary found* — install it, or set `providers.opencode.command`.
- *opencode X is installed, but codeoid supports opencode 2.2.5 or a later 2.2.x* — install 2.2.5 or a later 2.2 release (2.2.0 to 2.2.4 are refused, see Setup).
- *opencode agents … would run tools without asking codeoid* — an agent's rules allow tools in a way codeoid's overrides can't reach. Remove it from opencode's system config directory (`/etc/opencode`).
- *opencode runs plugins codeoid doesn't know* — a plugin in opencode's system config directory, or in codeoid's own opencode config dir (`config/` beside its database), which codeoid never writes. Remove it there.
- *opencode ran … without asking codeoid* — something settled a permission request itself; codeoid stopped the server. The next turn starts a new one, checked again. Turns of other sessions that were running on it end with *codeoid restarted the shared opencode server*; send them again.
- *No models in the picker* — opencode lists only models it has a credential for; see Setup.
- *A session runs a model you didn't pick* — with no model chosen, opencode uses its own default, which with no credentials set up is one of opencode's free hosted models (on opencode.ai). Pick a model, or set one in your opencode config.
- The server's log goes nowhere by default; run `opencode serve` by hand with the same `OPENCODE_DB` and `OPENCODE_CONFIG_DIR` to see what it says about your configuration.
