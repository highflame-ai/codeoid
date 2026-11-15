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
3. **Features have nowhere to live but per backend.** A work ledger that survives compaction, a
   model and cost badge on every turn, manual compaction, and skills on every backend each have
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
   - Example: a CLI that compacts on its own still gets the ledger, but only through its next
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
compaction), the work ledger (`codeoid ledger <s>`), `/compact`, and evals (`codeoid eval
run|ls|show|report|push`). The conformance suite checks it: each setting has a test that sets
it from the CLI.

## 3. Shape

```
Session ──▶ NativeProvider (AgentProvider, wrapped by StatelessSessionProvider)
              ├── Loop            turn → steps → tool batches; budgets; steer/queue
              ├── ModelClient     anthropic-messages | openai-chat | gemini   (§4)
              ├── Tools           Read Write Edit Bash Glob Grep + patch, Task, WebFetch,
              │                   TodoWrite, ask_user, request_directory, memory, MCP   (§5)
              ├── Prompt          base + family addendum + Session's append   (§7)
              └── Compactor       structured checkpoint + ledger   (§8)
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
| `Bash` | `command`, `timeout?` (default 120 s), `run_in_background?`. Runs in the session's sandbox (§6). Output is capped from the tail. The full output goes to a file in the session's state dir, and the result gives its path. On timeout the command moves to the background instead of being killed, and the model is told not to poll. Results include the exit code and wall time. |
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
spilled to the state dir and the model is told the path. The cap is *also* what
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

- **Trigger.** Compaction runs between steps when the estimated prompt is at least the window
  minus max(15%, 16k) (opencode). The estimate is the last measured usage plus a character
  estimate for what came after it. When a provider rejects a request for overflow before any
  output, the loop compacts once and retries.
- **The checkpoint** has fixed headings: Objective, Constraints, Decisions, Work state (done,
  active, blocked), Next, Files read, Files modified (up to 15), Exact errors.
  - Paths, commands and error text are kept verbatim.
  - A later compaction *updates* the previous checkpoint instead of starting over.
  - It never cuts between a tool call and its result.
  - The newest ~15–20k tokens are kept verbatim.
  - Anything older is one `recall`/`get_episode` away. `VerbatimWorkingSetStrategy` already
    advertises the recall tools.
- **The cache.** The summary request reuses the normal request prefix, so it hits the cache.
  Anthropic's four breakpoints go to:
  - the last tool definition;
  - the first and last system parts;
  - the conversation tail, which moves forward after each tool result.
- **Manual compaction** (`/compact [focus]`) is a Session verb on every backend:
  - native on the native loop;
  - the CLI's own compaction where a harness has one (Claude, pi, Codex);
  - declared unsupported elsewhere.
- **The work ledger is a Session-level feature** (KiroCrew). It records goal, phase, next,
  tried and artifacts. It is fed by `TodoWrite`, by the checkpoint's Work state and Next, and
  by loop and routine state.
  - It is re-sent after every compaction, rotation and loop cycle, on every backend: in the
    native loop's checkpoint, and as the next prompt's prefix for CLI harnesses.
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
| 1. Minimal native loop | `codeoid` id and model sources (Anthropic Messages, OpenAI Chat). Read, Write, Edit, MultiEdit, Bash, Glob, Grep, ask_user, request_directory, memory, MCP. `confinementFor` case and per-command sandbox. Budgets on turns, cost and wall time. Max steps ends with `toolChoice: none` and a summary prompt. Steer and queue mapped to `pushMidTurn`. Settles stale tool calls on resume. | Conformance green, including "autonomous Bash never runs unsandboxed". On `codeoid-core` it is at least as good as opencode on the same endpoint model. |
| 2. Long sessions | Compaction and checkpoint, the Session-level work ledger for all backends, prompt caching, background Bash, Task as a child session, project instructions and skills index for all backends, the per-turn badge for all backends, `/compact` everywhere, Gemini, and `apply_patch` for patch-format models. | Long-task evals don't regress against phase 1. If the native loop beats the plain chat backends, it becomes their default. |
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
