# Features

> Full feature reference for Codeoid. For install and a quick tour, start with the [README](../README.md).

### Harnesses

A session's *harness* (the agent backend it drives) is chosen when the session is created and can be changed by forking. Codeoid ships six, all behind one `SessionProvider` interface — adding a backend is one factory plus one `register()` call, and nothing else in the daemon changes.

| Harness (`providerId`) | Backed by | Available when |
|---|---|---|
| `claude` (default) | Claude Agent SDK | always |
| `openai` | OpenAI API | `OPENAI_API_KEY` is set |
| `gemini` | Google Gemini API | `GOOGLE_API_KEY` is set |
| `codex` | Codex CLI (app-server) | `codex` resolves on `PATH` (or the bundled binary) |
| `pi` | pi CLI | `pi` resolves on `PATH` (or the bundled binary) |
| `gemini-cli` | Gemini CLI (ACP) | `gemini` resolves on `PATH` |

Pick a harness when you create a session — the New Session modal in the web UI or TUI shows the choice whenever more than one backend is registered — or **fork across backends**: fork a Claude session onto Codex and it resumes with the parent's full conversation, so one backend can pick up exactly where another left off. A backend that isn't authenticated or installed simply doesn't appear as an option (no cryptic first-turn 401s).

Memory, identity, attachments, the multi-frontend clients, and device handoff are all provider-agnostic. A few features lean on Claude Code internals and so apply only to the `claude` harness: backing-session [auto-rotation](#context-reduction-stack), Claude Code slash-command [pass-through](#terminal-client), and `.claude/commands` workspace commands.

### Terminal client

Codeoid has two terminal cockpits, both speaking the daemon's WebSocket protocol:

- **[codeoid-tui](https://github.com/highflame-ai/codeoid-ui) (recommended)** — a native
  Rust/[Ratatui](https://ratatui.rs) client in its own repo. A true cell-matrix
  framebuffer, so it stays jitter-free under high-frequency streaming deltas.
  Build once (`cargo run -p codeoid-tui --release`) and point it at the daemon.
- **Built-in `codeoid tui` (Ink/React)** — ships in this repo as a zero-install
  fallback. Documented below. Same protocol, same daemon; codeoid-tui supersedes it.

`bun src/cli.ts tui` launches the built-in Ink cockpit with everything in one view:

```
[▾ studio2  @  /Workspace/codeoid]

You
  use the Explore agent to survey src/daemon and summarize

Claude
  I'll use the general-purpose agent to explore the structure...

[general-purpose] ✓ Glob **/*.ts
[general-purpose] ✓ Read src/daemon/session.ts
  1  /**
  2   * Session — wraps a single Claude Agent SDK query...
  ...

Claude
  ## Summary
  The daemon module has 14 files. Key layers:
  ...

╭──────────────────────────────────────────────────────────────╮
│ ● test  ▸● studio2 ᴀ⚡ 📌1  ● core                            │
│──────────────────────────────────────────────────────────────│
│ ⠋ Reasoning…  4s  ·  Ctrl-X to interrupt                     │
│ acting as …/agent/codeoid-session-7838ee1d                   │
│   via general-purpose  …/subagent/explorer-abc               │
│──────────────────────────────────────────────────────────────│
│ ● connected · studio2 @ /Workspace/codeoid · working · mode: autonomous (42 actions left) │
│──────────────────────────────────────────────────────────────│
│  Enter to send · Ctrl-N new · Ctrl-G switch · ? help         │
│ › _                                                          │
╰──────────────────────────────────────────────────────────────╯
```

**Keybindings:**

| Key | Action |
|---|---|
| `Ctrl-N` | New session |
| `Ctrl-G` | Switch session (fuzzy) |
| `Ctrl-D` | Destroy focused session |
| `Ctrl-X` | Interrupt focused session |
| `Esc` | Clear input draft — or interrupt if input is empty and session is working |
| `Shift-Tab` / `Ctrl-M` | Cycle execution mode |
| `y` / `n` | Approve / deny pending tool (when input empty) |
| `?` | Show keybindings overlay |
| `Ctrl-C` | Quit the TUI (sessions keep running) |

**Prompt editor:**

| Key | Action |
|---|---|
| `Enter` | Send |
| `Alt-Enter` / `Ctrl-J` / `\↵` | Insert newline |
| `Up` / `Down` | Cycle prompt history |
| `Ctrl-A` / `Ctrl-E` | Line start / end |
| `Ctrl-U` / `Ctrl-K` | Clear to start / end |
| `Ctrl-W` | Delete previous word |
| `@<path>` | Autocomplete a workspace file → attaches to send |
| `/` | Slash-command hint overlay |

**Slash commands** (built-in):

| Command | Action |
|---|---|
| `/clear` | Clear the visible transcript (memory kept) |
| `/new` | New session (opens modal) |
| `/switch` | Switch session (opens picker) |
| `/destroy` | Destroy focused session |
| `/interrupt` | Interrupt focused session |
| `/mode [target] [budget]` | Set execution mode. `/mode autonomous 100` = 100 write actions budget; `/mode autonomous 0` = unbounded |
| `/pin <path>` | Pin a file — prepended to every turn |
| `/unpin <path>` | Unpin a file |
| `/context <path>…` | Attach files to the NEXT turn only |
| `/rotate` | Roll over the Claude Code backing session — fresh context, memory preserved |
| `/who` | Print the identity chain (user → agent → sub-agents) |
| `/help` | Show keybindings |

**Pass-through**: any `/command` that isn't a Codeoid built-in or a workspace command is forwarded verbatim to Claude Code — `/compact`, `/agent`, custom subcommands all work without Codeoid knowing about them.

**Workspace commands**: any `.claude/commands/*.md` in your workspace auto-loads as a slash command on session focus. The file body becomes the prompt template; `$ARGUMENTS` is substituted with whatever the user typed after the command name. Zero Codeoid changes when you add new commands.

### Cross-session memory

Codeoid records every tool call, result, and reasoning block as an **episode** — stored verbatim, never summarized, retrievable via hybrid search. Claude gains three tools:

- `recall(query)` — semantic + keyword search across all prior sessions in this workspace
- `recall_file(path)` — check if a file was read recently; skip the re-read if cached
- `timeline(limit)` — chronological list of recent activity across sessions

Memory is **workspace-scoped via `git rev-parse --git-common-dir`**, so all [git worktrees](#parallel-sessions--git-worktrees) of the same repo share one workspace — feature branches inherit the main line's knowledge.

**What's in the store:**

```
~/.codeoid/memory.db            — SQLite (episodes + FTS5 + embeddings)
~/.codeoid/models/              — BGE-small-en-v1.5 (~50MB, downloaded once)
```

**Ranking:**

| Signal | Weight | Purpose |
|---|---|---|
| Vector similarity (BGE-small cosine) | 0.55 | Semantic match |
| FTS5 BM25 | 0.25 | Exact-string / function-name match |
| Recency (48h half-life) | 0.12 | Prefer recent context |
| Path overlap | 0.08 | Files touched in common |

**No external spend** — embeddings run in-process via `@xenova/transformers` (WASM). Configurable to Ollama, OpenAI, Voyage via the `Embedder` interface.

Disable with `CODEOID_MEMORY=0` if you don't want it.

### Parallel sessions + git worktrees

```bash
# Start two parallel features on separate worktrees, both sharing memory
bun src/cli.ts new featA --worktree feat/parser --repo /Workspace/codeoid
bun src/cli.ts new featB --worktree feat/ui     --repo /Workspace/codeoid

# In the TUI: Ctrl-G between them
```

`--worktree <branch>` spawns `<repo>.wt-<branch>` via `git worktree add` and points the session at it. The branch is created if it doesn't exist. Idempotent — re-running with the same args reuses the existing worktree.

Because `workspaceId` anchors on the shared `.git/common-dir`, both sessions live in the same workspace for memory purposes. Session A's `Read auth.ts` is available to Session B's `recall("auth flow")`.

### Execution modes

Each session has a mode. Only codeoid's internal memory-recall tools are ever
pre-approved at the SDK layer — every real tool (`Read`/`Grep`/`Glob`/`Write`/
`Edit`/`Bash`/`Agent`) is gated by the mode below:

| Mode | Behavior |
|---|---|
| `guarded` (default) | `Read` / `Grep` / `Glob` / memory auto-approve; `Write` / `Edit` / `Bash` / `Agent` prompt. ≈ Claude Code's default mode. |
| `interactive` | Every tool call prompts for approval — including reads. |
| `autonomous` | Everything auto-approves (no prompts) until the write/exec budget is spent, then reverts to `guarded`. ≈ Claude Code's bypass mode. |

Cycle with `Shift-Tab` (or `Ctrl-M` on terminals that swallow shift-tab). Set explicitly with `/mode autonomous 100` for a 100-action budget. `/mode autonomous 0` for unbounded (use with caution).

The StatusBar shows the current mode + remaining budget; SessionTabs shows `ᴀ⚡` badge when autonomous.

### Attachments

Three ways to add file context to a turn:

**Inline `@file` mentions** (TUI):

```
› what does @src/daemon/session.ts do?
```

Tab-completes from your workspace, resolves the path, attaches the file's content to the turn. Multiple `@paths` per message work.

**`/context`** (one-shot attachments):

```
/context src/foo.ts src/bar.ts
```

Sends a minimal "review these" prompt with the files attached.

**`/pin`** (persistent across turns):

```
/pin SPEC.md
/pin acceptance-criteria.md
```

Pinned files are re-read and prepended on every turn until you `/unpin`. Pins survive daemon restart (stored in `session_pins` SQLite table). The SessionRail shows `📌N` for pinned count.

**Web UI** adds drag-drop and paste support: drop a file onto the chat area, it's read locally (up to 200 KB) and inlined as an attachment.

**Size limits** (enforced by the daemon):

- 100 KB per file, 500 KB total per turn
- Binary files (null-byte sniff) skipped with an inline error marker
- Missing files surface as `<file error="...">` so Claude sees why a path didn't resolve

### Identity chain

Every session gets a primary SPIFFE/WIMSE URI. Sub-agents (spawned via Claude's Agent tool) get their own attenuated identities. Every `tool_call` SessionMessage is stamped with the identity that made it — parent session OR sub-agent worker.

The TUI surfaces this:

- **WorkingIndicator** shows the acting agent URI + any active sub-agents
- **Tool rows from sub-agents** get a green `[name]` prefix: `[general-purpose] ✓ Read foo.ts`
- **`/who`** prints the full delegation chain:

  ```
  ## Identity chain for studio2

  You — user_xxx
    ↓
  Session agent — spiffe://highflame.ai/personal/dev/agent/codeoid-session-7838ee1d
    ↓
  ### Active sub-agents (1)
  - general-purpose (spiffe://highflame.ai/personal/dev/subagent/explorer-abc)
  ```

**Why this matters:** in audit/compliance terms, every tool call is cryptographically attributable to an exact delegated identity. Revoke the parent in ZeroID → the whole chain dies. Sub-agents get scope-attenuated tokens so they can't escalate.

### Device handoff

Detach on laptop, attach from phone. The scrollback buffer (5000 entries / 20MB) replays what happened while you were away. Same session state, same memory, same pending approvals.

```
laptop$ codeoid attach oracle
> refactor the auth module
[agent working...]
Ctrl+C  # detach — session keeps running

# Later, from your phone via Telegram:
/attach oracle
# → scrollback replays → continue the conversation
```

### Context reduction stack

Three orthogonal layers, each opt-in, each carrying its weight:

**Layer C — workspace memory index** (on by default with memory enabled)

A compact markdown block auto-injected into every turn's system prompt. Contains:
- Fingerprint: `294 episodes across 8 sessions · last activity 8m ago`
- Hot files: top 10 by touch count, each with a `recall_file(path)` nudge
- Topic clusters: k-means (k ≤ 8) over episode embeddings, labeled with dominant directory + content terms (optional LLM re-labeling via Haiku when `ANTHROPIC_API_KEY` is set)
- Recent sessions: one-liner per session with its first user-turn summary
- Recall shortcuts: compact tool reference

Rebuilt on a hybrid trigger: `≥ 5 new episodes` OR `≥ 60s elapsed with ≥ 1 new episode`, debounced to max one regen per 15 s so the prompt cache stays warm. Toggle: `CODEOID_WORKSPACE_INDEX=0` disables, `CODEOID_MEMORY_CLUSTERS=1` enables the cluster section.

**Layer B — CLI output compression** (opt-in: `CODEOID_COMPRESS=1`)

A homegrown RTK-style compressor that routes Bash tool invocations through a daemon-local wrapper before Claude sees them:

- `PreToolUse` hook rewrites `Bash({ command: "git diff HEAD~5" })` → `Bash({ command: "bun …/wrapper.ts --b64 …" })`
- Wrapper runs the real command, captures stdout, applies declarative rules (`git-diff` collapses long unchanged context, `git-status` elides huge untracked-files lists, `test-runner` drops passing-test noise, `ls`/`cat`/`find`/`grep` summarize by extension/dir/file), 60–90% reduction on shell-heavy turns
- Stderr **never** compressed (error fidelity matters)
- Raw output lives in our verbatim memory store — Claude can `recall(query)` to retrieve the original bytes if the compressed version dropped something it needs

Rule format is declarative TypeScript:

```ts
export const myRule: CompressionRule = {
  name: "my-rule",
  description: "…",
  match: (cmd) => /^mything\b/.test(cmd),
  compress: (stdout, ctx) => ({ compressed, originalBytes: ctx.rawBytes, ruleName: "my-rule" }),
};
```

Drop new rules in [src/daemon/compress/rules/](../src/daemon/compress/rules/) — first match wins, generic head+tail truncator is the last-resort fallback.

**Layer D — auto-rotation of the backing session** (opt-in: `CODEOID_AUTO_ROTATE=1`)

When context occupancy creeps toward Claude Code's compaction ceiling, Codeoid rolls the underlying Claude Code session to a fresh backing id while keeping codeoid's public session id stable. The user never notices — same tab, same scrollback, same memory.

Seed strategy **B: task-anchor** (current default):

- Capture the most recent user turn from memory
- Inject a `<rotation_context>` block into the first post-rotation prompt with: workspace, rotation count, last user message verbatim, reminder to call `recall` / `recall_file` / `timeline` for prior detail
- No summarization — full verbatim memory is one tool call away

Thresholds (all configurable):

| Threshold | Default | Behavior |
|---|---|---|
| `warnPct` | 60% | (Reserved for UI nudging — currently unused) |
| `rotatePct` | 80% | Auto-rotate when `enabled: true` + over `minTurnsBeforeRotate` |
| `hardRotatePct` | 90% | Rotate even when `enabled: false` (safety net) |
| `minTurnsBeforeRotate` | 3 | Prevent rotation on fresh sessions where seed would be empty |

Each rotation emits a scrollback info message, bumps the rotation counter (persisted in SQLite), and shows `🔄 N` in the StatusBar. Manual trigger via `/rotate` slash command.

### Mid-turn streaming input (VSCode parity)

Claude Code's interactive CLI is turn-based — you wait for the response before sending the next message. The SDK underneath actually supports `AsyncIterable<SDKUserMessage>` streaming, which codeoid uses for mid-turn responsiveness.

When you hit Enter on an idle session: FIFO push, business as usual. When you hit Enter on a **working** session: codeoid auto-sets `priority: "now"` — the SDK aborts Claude's in-flight response and restarts with the new context included. You pay ~1-2 s for time-to-first-token on the restart; the alternative (`priority: "next"`) gets two separate responses instead of one unified one.

Explicit control is exposed on the protocol — frontends can pass `priority: "now" | "next" | "later"` on any `session.send` message. Default is the smart auto-promotion above.

A live `⎆ N queued` badge on the StatusBar shows queue depth. Turning-point feedback: the moment you queue a mid-turn message, an info row appears immediately so you know it was received, even though Claude's reply takes a second to start flowing.

### Autonomous + stop conditions

Flip a session to autonomous mode and send it off:

```
/mode autonomous 50
› go finish the refactor; commit when tests pass
```

The session auto-approves up to 50 write/exec actions. Reads + greps + memory recall don't count against the budget (they're classified as safe). When the budget runs out, the session reverts to interactive — the next write/bash will prompt you.

Status bar shows live budget: `autonomous (37 actions left)`. You can interrupt anytime with `Ctrl-X`.

### Guards

A *guard* observes the session and may inject model-facing advice.
It never vetoes a tool call, never rewrites arguments, and never appears in the tool list — anything that needs to *stop* a call belongs to the approval flow or the autonomous budget instead.

**Repeat-tool guard** (on by default) is the loop-breaker.
It counts runs of consecutive calls to the same tool with identical arguments, and at `3`, `5`, and `8` in a row it injects an escalating advisory telling the model to re-read the result it already has and either change approach or conclude.

This matters most where nobody is watching.
An unattended `dispatch` worker wedged on `Read(same file)` or `Bash(same failing command)` will otherwise burn its whole tool budget and report failure with no diagnosis; the budget caps the damage, the guard catches the cause while the turn can still recover.

Chains are tracked **per emitting agent**, so two subagents hammering the same tool in parallel are two independent runs rather than one interleaved chain that resets forever and never fires.
Argument comparison is order-insensitive (deep key-sort), so `{a:1, b:2}` and `{b:2, a:1}` are the same call.
Any inbound message — owner, background-task digest, or dispatch task — resets every chain, because the guard only claims "N identical calls with *nothing else happening*".

```jsonc
// ~/.codeoid/config.json
"guard": {
  "repeatTool": {
    "enabled": true,
    "thresholds": [3, 5, 8],       // run lengths that fire; each must be >= 2
    "include": [],                  // patterns to track; empty = all tools
    "exclude": ["TodoWrite", "todo_write"],
    "argumentsPreviewChars": 500    // caps the reminder text, never detection
  }
}
```

Invalid thresholds fail loud at construction rather than silently reverting to defaults — a guard that never fires because of a typo is worse than no guard. If the config is bad the session logs it and starts without the guard; an advisory plugin is never a reason to refuse a session.

#### Model Experience

The advisory arrives as injected context on the model's **next** request, wrapped in a `<repeat_tool_notice>` block and explicitly labelled as daemon-authored so it is never mistaken for owner input. The tool call that triggered it is unaffected — already recorded, already on its way to approval or execution.

Injection uses `later` priority, which merges into the running turn without starting a fresh query, so a reminder costs no extra turn. Backends without mid-turn injection get no reminders rather than a message arriving out of context.

#### KV Cache effect

Append-only. The advisory lands after the reusable request prefix and invalidates no prior cache entry. Cost is the advisory itself: ~60 tokens for the brief form, and up to `argumentsPreviewChars` more for the detailed form.

> The **Model Experience** / **KV Cache effect** headings are a convention borrowed from DeepSeek Harness (see [prior-art-deepseek-harness.md](./prior-art-deepseek-harness.md) §4.9). Any feature that changes what the model sees should state both: what reaches the model, and whether it invalidates the prompt prefix. For a harness, prefix stability *is* cost.

### Web UI

Mobile-first SolidJS SPA at `http://localhost:7400/ui/`. Also works as a Telegram Mini App:

- Session switcher
- Approval buttons
- File browser + drag-drop attachments
- Markdown rendering for assistant replies
- Real-time thinking display

### Telegram

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` (put them in
[`~/.codeoid/.env`](CONFIGURATION.md#codeoidenv--env-only-secrets) so they survive restarts),
then `bun src/cli.ts start`. Commands:

| Command | Action |
|---|---|
| `/auth <api_key>` | Authenticate with ZeroID |
| `/ls` | List sessions |
| `/new <name> <workdir>` | Create session |
| `/attach <name>` | Start receiving output |
| `/detach` | Stop receiving (session keeps running) |
| `/interrupt` | Interrupt running agent |
| `/destroy <name>` | Destroy session |
| `yes` / `no` | Approve / deny tool calls |
| _(any text)_ | Send to attached session |

While a turn is running, a one-tap **⏹ Stop** button appears on the chat —
the mobile equivalent of `Esc` / `/interrupt`.

Thinking content and sub-agent tool calls surface as separate italic messages. Streamed assistant text is buffered per message and flushed when Claude finishes (Telegram's rate limits make per-token streaming infeasible).

### Production resilience

| Pattern | What it does |
|---|---|
| **Retry with fallback model** | Exponential backoff with jitter, 429/529/5xx categorization, falls back to cheaper model after 3 capacity failures. |
| **Graceful shutdown** | LIFO cleanup registry with 30s grace. SIGTERM / SIGINT / SIGHUP handlers drain sessions before closing the store. |
| **Session resume** | JSONL transcripts per session; user prompts written BEFORE API calls. On daemon restart, sessions rebuild from transcript; `#hasQueried` flag ensures Claude Code's own session store is reused via `resume` instead of re-creating. |
| **Session limits** | **None by default** — running many sessions in parallel is the point. `rateLimit.maxSessionsPerUser` / `rateLimit.maxCreationsPerHour` default to `0` (unlimited); set either for a shared multi-user daemon. Automated spawning is bounded at its source by `dispatch.maxConcurrentWorkers`. |
| **Tool approval correlation** | Each approval request has a unique `approvalId`; first response wins; multiple concurrent approvals supported. |
| **Subprocess stderr capture** | Claude Code subprocess stderr is piped into the daemon log so SDK-level failures are debuggable. |
| **Keep-warm interrupt** | Interrupt (Esc / `⏹` / `Ctrl-X`) stops the in-flight turn via the SDK's `Query.interrupt()` — it reaps the running tool but keeps the backing session alive, so your next message continues on the same context. No re-`query()`, no resume handshake. Claude Code parity. |
| **Never-lose user messages** | A sent message is persisted to the transcript the instant it's accepted — before attachment resolution, rotation, or the SDK call. A failure afterward surfaces a visible `⚠️` row (never a silent drop), and frontends render send rejections instead of swallowing them. |
