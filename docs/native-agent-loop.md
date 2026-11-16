# A native agent loop, and evals across every backend

**Status**: Design, pre-implementation
**Authors**: Yash Datta
**Prior art read for this**:
- opencode v2 at `d432a06` (MIT);
- pi-mono at `7cc21c2` (MIT);
- KiroCrew at `b86dff24` (Apache-2.0);
- Kiro's public issue tracker;
- LongCapHarness ([arXiv 2611.10463](https://arxiv.org/abs/2611.10463v1)).

Only the ideas are taken. Where code is copied, its MIT notice comes with it.

---

## 1. Why

Every codeoid session that can change code borrows a vendor's harness: the Claude Agent SDK,
Codex, opencode, pi, Qwen Code or the Gemini CLI. The backends that run inside the daemon
(`openai`, `oai:<endpoint>`, `llamacpp`, `gemini`) offer the model only the memory tools,
`ask_user` and MCP tools (`providers/tool-loop.ts`). They can't read a file, edit one, or run a
command. The sandbox records them as `no-shell` for that reason.

That costs three things.

1. **Bringing your own model is only half done.** Users' top requests on Kiro's tracker are
   their own keys, Bedrock, local models and a custom base URL (#34, #695, #206, #8939, #9568).
   codeoid can reach a gateway or a llama.cpp server, but a session there can't do coding work
   unless someone mounts an MCP server that can.
2. **Our guarantees stop at someone else's process.**
   - Qwen Code runs shell commands it judges read-only without asking codeoid's gate
     (CLAUDE.md, "Known gap").
   - opencode needed a path resolver of its own (`opencode_unresolved_path`).
   - The fork-isolation rules in CLAUDE.md are long because the Claude CLI owns background tasks
     that we have to fence off from outside.
   - Every vendor upgrade can break the translation layer.
3. **Features have nowhere to live but per backend.** A work ledger that survives context rotation, a
   model and cost badge on every turn, manual rotation, and skills on every backend each have
   to be built once per harness today.

The native loop is codeoid's own harness:
- its tools are ours;
- every call goes through the gate;
- every shell command runs in the session's sandbox;
- its history *is* the canonical history.

## 2. The rule: every feature, every backend

> Every feature codeoid ships applies to every supported backend and harness: Claude, Codex,
> opencode, pi, Qwen Code, the Gemini CLI, the in-daemon backends, and the native loop.

The native loop is not a place to put features that the others lack. It is the backend where a
feature costs the least to build. The rule is enforced three ways.

1. **Features live at the Session or daemon seam.** Examples: the work ledger, project
   instructions, the skills index, the per-turn badge, lessons, checkpoints, approvals and
   evals. A provider only *reports* what it can do. It never owns a feature.
2. **Gaps are declared, not silent.** When a vendor harness truly can't do something, the
   backend's capability record says so, the UI shows it, and a test pins it.
   - Example: Codex is sandboxed as one process, while the native loop is sandboxed per
     command.
   - Example: a CLI that compacts on its own (codeoid never does) still gets the ledger, but only through its next
     prompt.
3. **A conformance suite** (§9) runs one test per feature against every backend:
   - in CI with the scripted backend standing in for each harness's event shapes;
   - behind a flag, as real-harness smoke tests.

   A feature is done when its row is green, or declared, for every backend.

The same rule holds for frontends. **Every option and setting this design adds is reachable
from the terminal as well as the web UI:**
- a CLI command or flag, a `/slash` command in `codeoid attach` and the TUI, or
  `codeoid config`;
- by the same protocol message the web uses, so the two can't drift.

That covers the backend and model, the native loop's settings (budgets, Bash timeout,
rotation), the work ledger (`codeoid ledger <s>`), `/rotate`, and evals (`codeoid eval
run|ls|show|report|push`). The conformance suite checks it: each setting has a test that sets
it from the CLI.

## 2a. Better than opencode and pi, by design

opencode and pi are where this design starts. They are not the bar. Each is one process
driving one conversation. codeoid already has more around the loop:
- a daemon that owns many sessions;
- canonical history across backends;
- a checkpoint every turn;
- lossless memory, where every tool call is a fact with its result and exit code (#471);
- the OS sandbox;
- ZeroID identities;
- the daemon's own evidence runner;
- accounts and endpoints;
- compare.

The native loop is designed around those.

Every item below ships with a `codeoid-core` eval task that shows it working (§9). An
advantage nobody measures is only a claim. "Ours" is what codeoid adds. "Theirs" is what we
read in opencode v2 (`d432a06`) and pi (`7cc21c2`).

### Loop

- **Done means verified.**
  - Theirs: a turn ends when the model stops calling tools.
  - Ours: when a session has checks (a pack gate, a loop's checks, or the repo's test command
    the owner confirmed once), the end of a turn runs them through the evidence runner in the
    sandbox.
    - A failure goes back to the model as the next step's input, with the check's excerpt and
      evidence id. This is bounded by the turn's budget.
    - Only a pass, or the budget running out, ends the turn.
  - The agent's "I'm done" is a request to verify, as a loop's `loop_report` already is.
- **Backtracking is a tool.**
  - Ours: the checkpoint store snapshots **each step**, not just each turn, so the shadow git
    has a ref per step.
  - `Revert { to: step | "last" }` lets the model undo its own bad path in one call, instead of
    hand-editing it back.
  - The canonical history keeps the abandoned branch, and recall can still read it.
  - Theirs: opencode's revert is user-facing; pi has none on files.
- **Repeated failures are detected from facts, not guessed.** opencode v2 dropped its
  doom-loop detector.
  - Ours: the memory facts already record every call's tool, input digest and exit code. An
    identical failing call (same command, same exit code, or the same edit miss) repeated N
    times is a fact.
  - What happens next is a ladder:
    1. a recovery hint naming the repeat;
    2. a **second opinion**: one `Consult` call to a stronger model on *any* backend the owner
       has, handed the canonical history;
    3. a stop, with the reason on the session card.
  - This is the LongCapHarness split at run time: the cheap model executes, the strong one is
    consulted only when needed.
- **Budgets the daemon enforces.** Turns, tool calls, cost and wall time are checked in the
  gate, which every call passes through. They are not left to the loop's good behaviour, since
  pi has no limit and opencode counts steps. At the limit the turn ends with a summary step
  (tools kept for the cache, `toolChoice: none`) and the ledger saved.

### Edit

- **No edit against a stale read.**
  - Ours: the loop records the content hash of each file it read, and an edit to a file that
    has changed since then is refused.
  - The refusal carries a diff of what changed, taken from the checkpoint. It also names who
    changed it: the user, a formatter, or **another session sharing the folder**. Only a
    daemon that sees every session can say the last one.
- **Each edit is checked at once.**
  - Ours: after an edit, a fast check for that language runs in the sandbox, and its result
    is attached to the edit's result. Examples: `tsc --noEmit` on the project, `bun build
    --no-bundle`, `python -m py_compile`, `gofmt -e`, `cargo check` when cheap.
  - When an LSP server is configured, its diagnostics take the check's place.
  - The model hears about a syntax error in the same step it made it, not three steps later.
  - Theirs: opencode v2 has this as a TODO; pi has none.
- **Edit formats chosen from evidence.**
  - Theirs: opencode picks `apply_patch` when the model id contains `gpt-`.
  - Ours: the eval store records the edit success rate per model and format (exact-hit rate,
    fuzzy rescues, misses). The `patchFormat` flag for a model is set from that data and
    published with it.
- **A miss that can be fixed safely is fixed.**
  - When the fuzzy tiers find exactly one candidate, it is applied, and the result tells the
    model what was normalized.
  - Two or more candidates are a miss, with the closest lines shown. Never a guess.

### Retry and failure

- **Rate limits are coordinated across the daemon.**
  - Ours: backoff is held per endpoint and account, shared by every session. When one session
    gets a 429, the other sessions on that key wait the same `retry-after` instead of each
    finding out separately. A circuit breaker opens on repeated failures.
  - Theirs: each request backs off on its own.
- **Failover across sources and backends**, not only to a fallback model on the same
  provider.
  - On a `usage_limit` or an outage (`providers/usage-limit.ts` already tells the two kinds
    apart), the turn can continue on the next source in a list the owner set: another
    account, a gateway, or a local model.
  - The full history goes with it, because canonical history is ours.
  - The switch is shown on the turn's badge.
- **Resuming after a crash is decided from facts.** When the daemon dies mid-tool-call, the
  checkpoint shows whether the files changed since the call began.
  - A read-only call, or one whose files didn't change, is replayed.
  - Anything else is reported as interrupted, with the diff it left (pi's `replay: "safe"`,
    decided from evidence instead of a declaration).

### Context

- **No compaction. codeoid never summarizes a conversation away.**
  - Theirs: both summarize the history and drop what they summarized. The model keeps working
    from an LLM's paraphrase of its own past.
  - Ours: codeoid is compaction-free today (`docs/FEATURES.md`, "Context reduction stack").
    - Everything stays verbatim in memory.
    - Near the ceiling, the backing context is **rotated**: the window starts fresh, the
      public session id stays the same, and a `<rotation_context>` task anchor is added.
    - Anything older is one `recall` / `get_episode` away.
  - The native loop keeps that model, and it goes further because codeoid owns the window
    itself. Rotation is the CLI's backing session on Claude, but on the native loop it is just
    a choice of which canonical turns go in the next request. No process is restarted and
    nothing is re-seeded.
- **The rotation anchor is computed from facts, not written by a model.**
  - Computed from canonical history and the memory facts: files read and modified, commands
    run with their exit codes, failing checks, the last error, and the work ledger.
  - Code builds it, so it is exact and costs no model call (the LongCapHarness rule: code
    where the rules are explicit).
- **Rotation is measured.** A `codeoid-core` probe asks questions that were answerable before
  a rotation, and they must still be answerable after it, through recall. A change to what
  the anchor carries is accepted on that score.
- **Large outputs spill into memory, not a temp file.**
  - Bash and Read past their cap are stored as an episode. The model gets its id and the
    view, and `get_episode` pages the rest.
  - It survives a restart, a fork and a backend switch, and the same output is visible to
    every frontend. A temp path survives none of those.
  - This is what output compression (Layer B) already does for Claude's Bash.

### Sub-agents and safety

- **Sub-agents are real sessions.** Each one has:
  - its own ZeroID identity with narrowed scopes;
  - its own sandbox and audit trail;
  - a place on the fleet board;
  - any backend;
  - a person who can steer it from any device.

  Theirs: a child conversation inside the same process with the same rights.
- **The OS sandbox is the boundary, per command.**
  - Every call is attributed and audited. Every approval card says whether the sandbox will
    contain the command.
  - Theirs: pi has no gate and relies on running inside a container. opencode's rules gate
    commands but don't confine what an allowed command can reach.

### The same advantages on every backend (§2)

Most of these live at the Session seam, so the vendor harnesses get them too. What a vendor
harness can't take is declared.

| Advantage | codeoid (native) | Vendor harnesses (Claude, Codex, opencode, pi, Qwen Code, Gemini CLI) |
|---|---|---|
| Done means verified | Inside the turn | At Session level. The failed check is the next input: pushed mid-turn where the backend supports it (Claude), the next prompt elsewhere. |
| Revert tool, per-step checkpoints | Native tool | `Revert` is served over codeoid's MCP mount to every backend that mounts MCP. Steps are the tool batches Session sees in each backend's events. |
| Repeated-failure ladder, `Consult` | Native | Detected at Session level from the same facts. Hint as above. `Consult` over MCP. |
| No edit against a stale read | Refused in the tool | Refused in the gate for every backend whose file tools reach `canUseTool` (Claude, opencode, Qwen Code, Gemini CLI). Codex applies patches itself: declared, warned after the fact. |
| Each edit checked at once | In the edit's result | Run after the call. Delivered through Claude's PostToolUse context, otherwise as the next input. |
| Daemon-wide rate limiting | Every model call | Only the in-daemon backends. A CLI makes its own calls (declared). |
| Failover across sources | Mid-turn | At the turn boundary, as a backend or account switch with the full history. |
| Compaction-free rotation and spill to memory | Native: codeoid owns the window | Claude: backing-session rotation as today. Other CLIs: `/rotate` where they can start fresh. A CLI that compacts on its own is declared, and the ledger and recall tools over MCP make up the difference. |
| Sub-agents as sessions, per-command sandbox | Native | Sub-agents via the conductor's `Task` over MCP. Sandbox per process or natively (`docs/sandbox.md`). |

## 3. Shape

```
Session ──▶ NativeProvider (AgentProvider, wrapped by StatelessSessionProvider)
              ├── Loop            turn → steps → tool batches; budgets; steer/queue
              ├── ModelClient     anthropic-messages | openai-chat | gemini   (§4)
              ├── Tools           Read Write Edit Bash Glob Grep + patch, Task, WebFetch,
              │                   TodoWrite, ask_user, request_directory, memory, MCP   (§5)
              ├── Prompt          base + family addendum + Session's append   (§7)
              └── Window          verbatim turns + rotation anchor + ledger (§8)
```

- **Id and label `codeoid`, one more entry in the backend picker that already exists.** Users
  see it as "codeoid" in the dropdown, in `codeoid ls`, and in the reply label ("(codeoid)",
  `backendLabel`). This doc says "the native loop" for the design. Nothing new is added to
  choose it:
  - **Choosing it.** The web UI's backend dropdown (`ProviderPicker` in
    `SessionControls.tsx`, `session.set_provider`) lists `codeoid` next to `claude`, `codex`
    and `oai:<endpoint>`.
  - **The model dropdown names the source.** It lists every model the `codeoid` harness can reach, grouped
    by source, and the model id carries the source: `anthropic/claude-…`, `bedrock/…`,
    `openai/gpt-…`, `oai:<endpoint>/<model>`, `llamacpp/<model>`, `gemini/…`. These sources
    are the accounts and endpoints codeoid already stores
    (`docs/backend-accounts-design.md`).
  - **The terminal has the same verbs:**
    - `codeoid new <s> <dir> --provider codeoid --model oai:rakuten/glm-5.2`;
    - `/provider codeoid` and `/model <source>/<id>` in `codeoid attach` and the TUI;
    - `codeoid fork <s> --backend codeoid`;
    - `codeoid account …` and `codeoid endpoint …` for the sources.
- **The plain chat backends stay as they are.** `openai`, `oai:*`, `llamacpp` and `gemini` keep
  working, so nothing that depends on them breaks. Once the evals show the native loop is
  better (phase 2's gate), they default to it.
- **Claude Pro/Max subscription logins stay on the Claude Agent SDK.** The native loop uses API
  keys, Bedrock, Vertex or a gateway, never a subscription's OAuth token.
- **`AgentProvider` flags:**
  - `supportsMemoryTools: true`;
  - `appliesToolInputRewrite: true`;
  - `enforcesToolBudget: true`, because every call reaches `canUseTool`;
  - `free` for local models.
- **Sandbox plan.** `confinementFor("codeoid")` returns `{ kind: "command", fileTools: false }`:
  - **Shell:** each command is wrapped. This is the mechanism opencode uses today.
  - **File tools:** they run in the daemon and are judged by `hostFileToolBreach` against the
    sandbox's spec, as opencode's are.
  - **Fails closed:** without this case the id would get `ok: false`. And if the native loop
    reused a `no-shell` id, Bash would run on the host unasked in autonomous mode. That is
    exactly the regression to avoid. The test lives in the conformance suite.

## 4. Model layer

Three wire protocols cover every source we store.

| Protocol | Sources | Notes |
|---|---|---|
| Anthropic Messages | API key, Bedrock, Vertex, gateways | Cache breakpoints (§8). Thinking blocks. |
| OpenAI Chat Completions | OpenAI, every `oai:` endpoint, llama.cpp, OpenRouter, vLLM | Reuses `openai/index.ts` streaming and `toolsTransform` (llama.cpp's strict schemas). |
| Gemini | Gemini API | Reuses `gemini/index.ts` and its schema projection. |

OpenAI Responses (the freeform `apply_patch` grammar) comes later, behind a capability flag.

The model layer keeps the invariants that pi and opencode both landed on.

- **Errors are values.** Once a stream has started it never throws. A failure arrives as
  `error` with the partial message and its usage.
- **One event model.**
  - Events: text, thinking and tool-call `start|delta|end`, then `done` or `error`.
  - Every event carries a content index.
  - Stop reasons: `stop`, `length`, `tool_use`, `error`, `aborted`.
- **Switching models keeps the conversation.** The rules come from pi's `transform-messages`:
  - tool-call ids are remapped for the target;
  - an orphaned call gets a synthetic "no result" result;
  - thinking blocks are dropped unless provider, protocol and model all match.

  canonical.ts already does most of this. The rest is added there, so every backend gains it.
- **Retry is transparent only before any output.** The policy is opencode's:
  - jittered backoff, doubling from 2 s up to a 10 s cap, 10 tries;
  - `retry-after` honoured up to 15 min;
  - timeouts retried at most 3 times;
  - a separate one-hour budget for an unreachable network.

  Once output has started, a retry settles the old message and starts a new one.
  `session.fallbackModel` applies here as it does for Claude.
- **Capabilities come from flags, never from substrings of model ids.** The flags are context
  window, max output, reasoning levels, cache support, the patch format and cost.
  - Sources: the endpoint's settings, `context-windows.ts`, llama.cpp's `/props`, and the
    pricing tables.
  - opencode's `id.includes("gpt-")` is the pitfall this avoids.

**Decision: build vs depend.** pi's `ai` package (MIT, about 40 providers) does all of this
already. Depending on it would trade a large provider surface for supply-chain weight. It
would also mean a second account and pricing model next to ours. The proposal is to build
the three protocols in house, reusing what codeoid has, and to copy pi's transform rules with
attribution. Revisit if the source list grows past five.

## 5. Tools

The tool names and input shapes are **Claude Code's**: `Read`, `Write`, `Edit`, `Bash`,
`Glob`, `Grep`, `TodoWrite`, `WebFetch`, `Task`. Three reasons:

- **The gate already knows them.** That covers `isSafeTool`, `writeTargets` and held writes,
  `isHostFileTool` and `hostFileToolBreach`, `SHELL_TOOL_NAMES` and shell risk, the
  canonical `TOOL_NAME_MAP`, fork isolation, and the web UI's cards. New names would mean
  extending every one of those sets, and missing one is a bypass.
- **History reads the same whichever backend wrote it**, so fork, switch and rewind need no
  translation.
- **Many models are tuned on these shapes.**

| Tool | Contract |
|---|---|
| `Read` | `file_path`, `offset?`, `limit?`. At most 2000 lines or 50 KB, read from the head. Lines are numbered. Past the cap it says "use offset=N". Images are supported. |
| `Write` | `file_path`, `content`. |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all?`. The match order is exact, then with typographic quotes, dashes and spaces normalized, then line by line ignoring trailing whitespace (opencode's three tiers). CRLF and mixed line endings are kept region by region. `old_string` must be unique unless `replace_all` is set. A miss returns the closest lines, numbered, but only when Read would be allowed on the file. |
| `MultiEdit` | `file_path`, `edits[]`. Every edit matches the original text, and no two may overlap (pi). |
| `apply_patch` | The `*** Begin Patch` format. It is offered **instead of** Edit, Write and MultiEdit when the model's `patchFormat` flag says so (the GPT family). |
| `Bash` | `command`, `timeout?` (default 120 s), `run_in_background?`. Runs in the session's sandbox (§6). Output is capped from the tail. The full output is kept as a memory episode, and the result gives its id (§2a). On timeout the command moves to the background instead of being killed, and the model is told not to poll. Results include the exit code and wall time. |
| `Glob` / `Grep` | ripgrep, at most 100 matches or 1000 paths, inside 50 KB. |
| `WebFetch` | `url`, `format?`. 30 s timeout by default, at most 10 redirects, HTML converted to markdown, size capped. Uses the session's network policy. |
| `TodoWrite` | The whole list each time. It feeds the work ledger (§8). |
| `Task` | Runs a sub-agent as a **child codeoid session** (§6). |
| others | `ask_user`, `request_directory`, the memory tools and MCP tools, unchanged from `tool-loop.ts`. |

**Execution** (pi and opencode):
- Calls are preflighted in order: find the tool, repair its input, validate it, then
  `canUseTool`. They then run concurrently, and results go back in the order the model
  issued them.
- Writes to the same real path are serialized by a per-file queue.
- A tool marked sequential makes its whole batch sequential.

**Input repair** (opencode): an argument is coerced only when the schema leaves one reading:
- stringified JSON is parsed;
- `"20"` becomes 20 and `"false"` becomes false;
- a null optional is dropped;
- extra keys on a closed object are dropped.

Aliases (`bash`→`Bash`, `read_file`→`Read`) run and tell the model the real name.

**Errors the model can act on:**
- An unknown tool returns the list of available ones.
- Malformed JSON returns an excerpt and a hint. The hint differs when the step stopped on
  `length` (truncated arguments) and when the JSON is simply malformed.
- On a `length` stop, every tool call in that message fails ("arguments may be truncated,
  issue it again in smaller pieces"). Salvaged arguments are never run.

Output limits come from one shared bound: 2000 lines or 50 KB. Above it, the full text is
stored as a lossless memory episode, and the model gets its id and `get_episode` (§2a). When
memory is off, the fallback is a file in the session's state dir. The cap is *also* what
`limitToolOutput` uses when history is rebuilt for another backend, so a switch carries the
same view.

## 6. Sandbox, gate and sub-agents

- **Every call goes through the session's `canUseTool`.** Native tools never get a bypass:
  fork isolation, the budget, pins, hooks, risk, auto-approve and the autonomous refusals all
  run exactly as they do for Claude.
- **Shell.** The loop holds one `SandboxHandle` from `init.sandbox()`. It runs each command
  with `handle.exec(["sh", "-c", cmd], { cwd, env })`, or spawns through
  `wrap` when the command runs in the background.
  - The handle is re-opened when the spec changes (`request_directory`, added dirs), as
    opencode's launcher does. An old handle stays open until its background commands end.
  - There is no persistent shell. The loop tracks the shell's cwd itself (it parses a leading
    `cd`), passes it as the gate's `shellCwd`, and tells the model when it changes.
  - The environment comes from `buildSubprocessEnv` and adds `CODEOID_SESSION_ID` and
    `AGENT=1`.
- **No sandbox.** When none can run, the policy is `docs/sandbox.md`'s: an autonomous session
  refuses Bash, and an interactive one asks with the sandbox's state shown. It never runs on
  the host silently.
- **Background commands** are registered with Session's background-task model. Their
  completion reaches the model the way the Claude and opencode providers deliver theirs: a
  turn the backend starts on its own (their `#adoptTurn`), with the wake path unchanged.
  `SandboxHandle.close()` on destroy ends anything still running.
- **`Task` starts a child codeoid session.** It is not an in-process agent.
  - The child is a fork with `forkIsolation` and an attenuated ZeroID identity (scopes are a
    subset of the parent's).
  - It is visible on the fleet board, and it can run on any backend: a `codeoid` parent can
    hand a review to Claude.
  - It runs in the background by default. The parent gets a `<subagent>` message when the
    child goes idle, and may send it more work (opencode).
  - Default depth is 1.
  - This is the conductor's machinery, so sub-agents become a feature of every backend that
    can call a tool. They are no longer a Claude-only feature.

## 7. Prompt and instructions

- **The base prompt is short**: about 500 tokens, as pi's is. It is in sections:
  - `<tools>`: one line per tool, generated from the tools offered;
  - `<rules>`;
  - `<environment>`: cwd, OS, sandbox state, date;
  - an addendum per model family, keyed by flag (patch-format models get the patch rules).

  Session's existing `systemPromptAppend` follows it: conductor, pack constitution and role,
  memory index, worktree and sandbox notes, hooks.
- **Project instructions are a Session-level feature.** The search order is
  `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, from the repo root down to the cwd, plus the
  user's global file.
  - They are loaded for every backend that doesn't load them itself: the native loop and the
    in-daemon chat backends.
  - CLI backends keep their own loader. The capability record says which loader is in use, so
    nothing is loaded twice.
  - When a file changes, the model gets a diff instead of a rewritten prefix, which keeps the
    cache (opencode).
  - A file from an untrusted worktree is marked as such in the prompt.
- **The skills index is also Session-level.** The prompt lists only name, description and
  location, and the model reads `SKILL.md` when it needs it (agentskills.io, as pi does).
  - Pack skills are mapped today only for Claude (`pluginDirs`). With this they reach every
    backend: natively where the harness has skills, through the index where it doesn't.
- **Prompt changes are recorded in history**, as pi's system-message patches are. A rewind or
  fork then replays the exact prompt the model saw, and the cached prefix isn't broken
  mid-session.

## 8. Context, cache and the ledger

To investigate in depth when the work is taken up. What follows is the direction, and it holds
to codeoid's rule: **compaction-free**. Nothing is summarized away; the window is a view of a
history kept verbatim.

- **What goes in a request.** Each request is built from the canonical turns:
  - the system prompt and memory index (Layer C);
  - the current turn whole;
  - as many recent turns verbatim as fit the window, minus a reserve for output.
  - It never splits a tool call from its result.
- **Rotation, not compaction.** When the window would overflow, the loop starts the next
  request from a fresh window.
  - The window holds the `<rotation_context>` anchor (`renderRotationSeed`, Layer D), with
    facts computed per §2a, the work ledger, and the newest turns verbatim.
  - Older turns are still canonical and still in memory. `VerbatimWorkingSetStrategy` already
    advertises the recall tools, and `get_episode` returns their exact bytes.
  - When a provider rejects a request as too long before any output, the loop rotates once
    and retries.
  - On Claude, rotation stays what it is today: the backing CLI session rolls over. The
    trigger and anchor are the same at the Session seam, so the behaviour matches across
    backends.
- **Open questions for then:**
  - Is the old-turn cutoff a token budget or a turn count? What does the anchor carry beyond
    the facts and the ledger?
  - How do rotation and the prompt cache interact? A rotation is a cache miss, so it should
    be rare and late.
  - What does the §2a probe eval accept?
- **The cache.** Anthropic's four breakpoints go to:
  - the last tool definition;
  - the first and last system parts;
  - the conversation tail, which moves forward after each tool result.

  Between rotations the prefix only grows, so the cache holds.
- **Manual rotation** (`/rotate`) already exists for Claude. It becomes a Session verb on
  every backend, from the web UI and the terminal alike:
  - native on the native loop;
  - the backing session's rollover on Claude;
  - a fresh native session with the anchor on harnesses that can start one (Codex, pi,
    opencode);
  - declared unsupported elsewhere.

  When a vendor CLI compacts on its own, codeoid can't stop it. The capability record says
  so, and the ledger and recall tools are still there after it does.
- **The work ledger is a Session-level feature** (KiroCrew). It records goal, phase, next,
  tried and artifacts. It is fed by `TodoWrite` and by loop and routine state.
  - It is re-sent after every rotation, a vendor CLI's own compaction, and every loop cycle,
    on every backend: in the native loop's anchor, and as the next prompt's prefix for CLI
    harnesses.
  - It is shown in the web UI, so the context window becomes a cache rather than the only
    copy of where the work stands.
- **The per-turn badge.** Every turn records the model that actually answered (fallbacks
  included), the context used against the window, and cost or tokens. This is Session-level
  and every frontend shows it (Kiro #8903, #31).

## 9. Evals

### 9.1 What they are for

1. **The phase gate.** The native loop becomes a default only after it beats or matches
   opencode and pi on the same model.
2. **Conformance.** Each feature works on each backend.
3. **The ruler for later self-improvement** (§10): the measurement it must beat.

### 9.2 Store

Results live in `/data/codeoid-evals` (local for now). It is laid out as a Hugging Face
dataset repo, so `codeoid eval push` can publish it unchanged to
`highflame/codeoid-agent-evals`. Pushing is manual, and the repo stays private until we
decide otherwise. The schema (tasks, runs, trajectories, reports) is in that directory's
`README.md`. Rows are append-only.

### 9.3 Runner (`codeoid eval run <suite> --targets claude:opus,codeoid:oai:x/model,...`)

- **One isolated daemon per run.** It has a throwaway HOME, XDG and transcript dir, and a
  port of its own: the `e2e/harness.ts` pattern.
- **Targets run as a headless compare.** `session.compare` (#357) already forks one prompt to
  2–4 `{providerId, model}` targets. Each gets its own worktree from the same fixture, and
  compare reports reply, cost, duration, tokens and files changed per target. The runner
  drives it per task and repetition.
- **The protocol comes first** (pi). Before anything runs, the runner writes `protocol.json`:
  - tasks, targets, repetitions;
  - harness and backend versions;
  - the codeoid commit;
  - a sha256 digest of the whole protocol.

  It also writes the planned cohort (`expected-runs.json`). A run with a different digest
  never merges into the same report.
- **Order alternates** across repetitions, to reduce bias from running first.

### 9.4 Grading

- **Grading is the daemon's.** The loops' evidence runner (`runCheck` inside
  `openCheckSandbox`) runs each task's checks against the target's tree:
  - "zero tests ran" counts as inconclusive, not as a pass;
  - every check becomes an evidence record under a new owner kind, `eval`;
  - `codeoid evidence <id>` shows what ran.
- **The agent's own claim is never the grade.** An LLM judge is a later, optional grader. It
  is never the only one.
- **Outcomes are data.** An outcome is `passed`, `failed`, `budget_exceeded`, `error` or
  `refused`.
  - `error` is not a 0.
  - Missing telemetry is "unavailable", not 0.
  - A comparison counts only when both sides produced a score; otherwise the headline rate
    is withheld (pi).
  - Reports flag `no-lift`, `negative-delta`, `saturated` and `flaky`.

### 9.5 Suites and splits

- **Suites.**
  - `codeoid-core`: our own tasks, about 30 to start. They cover single and multi-file edits,
    a shell-driven fix, long files and logs, recall across sessions, approval and refusal,
    the sandbox boundary, and fork or switch mid-task.
  - Pinned subsets of **terminal-bench** and **SWE-bench-lite**, referenced by id and
    version and never copied.
- **Splits.** Every task is `dev` or `heldout`. Tuning, human or automatic, sees only `dev`.
  A change is accepted on `heldout`.

### 9.6 Trajectories

A trajectory is kept only after it passes:
- codeoid's secret scanner;
- a path scrub;
- a no-private-repo rule (fixtures are ours or a public benchmark).

A row that fails the scan keeps `trajectory: null`.

### 9.7 The conformance suite

The conformance suite is the same machinery with the scripted backend standing in for each
harness's event shapes, run in CI. Real-harness smoke tests run nightly or on demand.

## 10. Later: improving the harness

Following LongCapHarness, a strong model designs and a cheap model executes.

- **Who builds what.**
  - A strong backend develops **capability harnesses** offline: skills plus small scripts,
    where code does the exact work (match, count, track state) and a model does the
    judgement.
  - Native-loop sessions on local or cheap models then run them.
  - The paper took an 8B model from 15 to 79 on long-context benchmarks this way, with no
    training. Whether that holds for coding work is unproven, and our evals are what would
    show it.
- **Acceptance.**
  - The improvement runs as a **loop**.
  - Its acceptance check is the `heldout` eval score, measured by the daemon. The paper's
    stopping rule, where the agent decides "close enough", is not used.
  - Before optimizing, a calibration run proves the metric can detect a known improvement
    (KiroCrew's "prove the ruler").
- **Refusing overfit.**
  - A generated skill or harness must not embed instance details (paths, answers, repo
    names). The paper calls this "capability state agnostic to input".
  - Candidates that do are refused before they reach the owner's approval queue.
  - Every accepted harness records the backend and model it was validated on.

## 11. Phases

| Phase | Delivers | Done when |
|---|---|---|
| 0. Evals | Task schema, `codeoid eval run` (headless compare, evidence graders, `eval` owner kind), the `/data/codeoid-evals` writer, `codeoid-core` v0, and a baseline on today's backends with 2–3 models, one of them local. | A reproducible report. A rerun of the same protocol matches within noise. |
| 1. Minimal native loop | `codeoid` id and model sources (Anthropic Messages, OpenAI Chat). Read, Write, Edit, MultiEdit, Bash, Glob, Grep, ask_user, request_directory, memory, MCP. `confinementFor` case and per-command sandbox. Budgets on turns, cost and wall time. Max steps ends with `toolChoice: none` and a summary prompt. Steer and queue mapped to `pushMidTurn`. Settles stale tool calls on resume. From §2a: done means verified, budgets enforced in the gate, per-step checkpoints with `Revert`, refusing an edit against a stale read, the repeated-failure hint and stop, and output spilled into memory. | Conformance green, including "autonomous Bash never runs unsandboxed". Each §2a item has its eval task. On `codeoid-core` it **beats** opencode and pi on the same endpoint model, not just matches them. |
| 2. Long sessions | Compaction-free windowing and rotation (§8), the Session-level work ledger for all backends, prompt caching, background Bash, Task as a child session, project instructions and skills index for all backends, the per-turn badge for all backends, `/rotate` everywhere, Gemini, and `apply_patch` for patch-format models. From §2a: checking each edit at once, daemon-wide rate limiting, failover across sources, the rotation anchor computed from facts (with its probe eval), `Consult`, and edit formats chosen from eval data. Each Session-level item lands on the vendor harnesses in the same PR (§2a table). | Long-task evals don't regress against phase 1. If the native loop beats the plain chat backends, it becomes their default. |
| 3. Workers | The native loop as the default worker for non-Claude models in loops, routines and the conductor. An independent diff reviewer as a loop stage (any backend). Lessons with an approval queue. | Loop pass rate on heldout tasks doesn't drop compared with vendor-harness workers. |
| 4. Harness improvement | §10, gated on heldout evals. | An accepted improvement on heldout that also holds on a second model. |

## 12. Open decisions

1. **Model ids carry their source** (`oai:rakuten/glm-5.2`), and `codeoid` is one entry in the
   existing backend dropdown (§3). The alternative is one backend id per source
   (`codeoid:oai:rakuten`). That would make the dropdown longer, but each entry's model list
   would be shorter.
2. **Build vs depend on pi's `ai` package** (§4). Proposal: build three protocols and revisit
   past five.
3. **When the plain chat backends flip to native.** Proposal: on phase 2's eval gate, with the
   chat path kept behind a setting.
4. **Default `Bash` timeout and background-on-timeout.** Proposal: 120 s and on. pi has no
   default, which hangs an unattended daemon.
5. **Trajectory publication.** Even after redaction, should published trajectories be limited
   to `codeoid-core` tasks?

## 13. Not doing

- An apps marketplace, or running LLM-written code inside the daemon process (KiroCrew's
  workflows).
- A provider SDK covering ~50 protocols (opencode).
- An 1800-line shell parser for permissions. Shell risk plus the sandbox is the boundary
  (`docs/sandbox.md`).
- Matching model ids by substring.
- A feature that exists only on the native loop.
