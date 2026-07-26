# How Codeoid compares

Codeoid is not a general-purpose IDE assistant — it's aimed at **long-horizon multi-session agent work** where context continuity and token economics matter more than inline code actions. Here's where it differs from the tools you're probably already using.

Two shapes get conflated in this space.
An **agent IDE** (Superset, Conductor, Crystal) wraps a UI around agents running on your machine — panes, diffs, worktrees, review.
A **control plane** (Codeoid, Omnigent) owns the sessions themselves and exposes them to thin clients.
Codeoid is the latter, which is why the rows below weigh memory, attribution, and portability over editor surface.

| Capability | Claude Code CLI | VSCode Extension | Cursor | Aider | **Omnigent** | **Superset** | **Codeoid** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Cross-session verbatim memory** | ❌ `/compact` is lossy | ❌ session-scoped | ❌ | ❌ | ~ conversation full-text search + optional long-term store, not workspace-scoped episodic | ❌ host DB stores session registry metadata only — no message bodies or tool payloads | ✅ SQLite + FTS5 + vectors, workspace-scoped verbatim episodes |
| **Parallel sessions, one control plane** | ❌ one terminal | ❌ one window per repo | ~ tabs | ❌ | ✅ Polly delegates to parallel agents | ✅ 10+ worktree workspaces in one sidebar | ✅ N sessions, switch with Ctrl-G |
| **Git-worktree-aware memory sharing** | ❌ | ❌ | ❌ | ❌ | ~ worktrees for isolation, not shared memory | ~ worktree-per-task is the core primitive, but no memory layer to share | ✅ anchored on `git-common-dir` |
| **Workspace memory index** injected into system prompt | ❌ | ❌ | ❌ | ~ repo map | ❌ | ❌ | ✅ hot files + topic clusters + recent sessions, auto-regenerated |
| **Pre-entry CLI output compression** (git diff, test runners, etc.) with recall recovery | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ declarative rules, 60-90% reduction with tee-cache |
| **Auto-rotation of backing context** near compaction ceiling | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ lossless via memory recall seed |
| **Mid-turn user input (stream)** | ❌ interactive CLI is turn-based | ✅ | ~ | ❌ | ✅ mid-turn steer + live collab | ✅ it's a real terminal; the ACP path also accepts mid-turn sends | ✅ with `now`/`next`/`later` priority |
| **Per-turn token / cost / cache telemetry** | ~ `/cost` total only | ❌ | ❌ | ~ | ~ spend caps + routing | ❌ terminal output is opaque; the ACP path carries no usage/cost frame | ✅ persistent SQLite, StatusBar, Δ per turn |
| **Current context occupancy visible** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ `ctx 65k/1.0M (7%)` live in StatusBar |
| **Cryptographic identity per agent + sub-agent** (SPIFFE) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ ZeroID WIMSE URIs |
| **Autonomous mode with write-action budget** | ❌ | ~ | ~ | ❌ | ✅ stateful spend caps + risk escalation | ~ presets launch agents with approvals bypassed (`--dangerously-skip-permissions`); no budget or risk gate | ✅ budget tracked per session |
| **Multi-frontend** (terminal + web + mobile) | ❌ CLI only | ❌ IDE only | ❌ IDE only | ❌ | ✅ terminal → browser → phone | ✅ desktop app + CLI + web + iOS (in development) | ✅ TUI + Web + Telegram, same session |
| **Device handoff** (start laptop, continue phone) | ❌ | ❌ | ❌ | ❌ | ✅ sessions follow you | ✅ and cross-machine — cloud relay routes to any registered host | ✅ WS re-attach with scrollback replay |
| **Multi-harness** (multiple agent backends) | ❌ Claude only | ❌ | ❌ | ❌ | ✅ swap/combine harnesses in one session (also Cursor, OpenCode, Hermes) | ✅ 12 built-in + any CLI agent, as terminal processes | ✅ Claude, Codex, Gemini, OpenAI, pi, Gemini CLI — per session + fork across backends |
| **Cost of adding a backend** | — | — | — | ~ model config | PTY wrapper per harness (tmux) | ~8-line declarative manifest (command + prompt transport) | 300–1,300 LOC native provider, or a thin ACP adapter |
| **Structured agent event model** (tool calls, subagent lineage, task graph) | ✅ native SDK | — | — | ❌ | ❌ PTY bytes | ~ terminal path is opaque bytes; ACP path is structured but drops subagent identity, task dependencies, and workflows | ✅ canonical `ProviderEvent` — tool calls, `parentToolUseId` lineage, normalized usage |
| **Cross-backend session fork** (switch harness mid-session, keep context) | ❌ | — | — | ❌ | ✅ swap/combine within one session | ❌ a session is bound to the agent that started it | ✅ `session.set_provider` / `session.fork` with history seed |
| **Built-in diff review + PR workflow** | ❌ | ✅ | ✅ | ~ | ❌ | ✅ editable diff viewer, inline comments, commit/push, PR status | ❌ not built — roadmap |
| **Remote multi-machine reach** | ~ hosted Remote Control (Max plan) | ❌ | ❌ | ❌ | ~ server deploy | ✅ host registry + cloud relay routes by host key; wakes offline hosts | ~ one daemon, reached directly or through Telegram; no relay |
| **Scheduled / unattended automations** | ❌ | ❌ | ❌ | ❌ | ~ | ✅ cron-scheduled agent sessions, versioned | ~ durable dispatch queue with lease reclaim and crash recovery, but no scheduler yet |
| **Programmable outward API** (drive it from other agents) | ~ Agent SDK | ❌ | ❌ | ❌ | ❌ | ✅ npm SDK + MCP server (workspaces, agents, tasks, hosts) | ~ `@codeoid/core` + `@codeoid/protocol` on npm, but transport-level; no control-plane MCP server |
| **Self-hostable, no vendor cloud** | ~ Bedrock/Vertex supported; CLI itself is closed | ❌ | ❌ | ✅ | ~ Docker for server deploy | ❌ relay, orgs, and automations require Superset cloud | ✅ `bun:sqlite` + WASM embeddings, no external services |
| **OS-level sandbox** (filesystem + network isolation) | ~ permission modes | ❌ | ❌ | ❌ | ✅ secure OS sandbox | ❌ worktree isolation only; presets actively bypass agent sandboxes | ~ approval + autonomous budget, not OS-level |
| **Credential brokering** (hide secrets from the agent) | ❌ | ❌ | ❌ | ❌ | ✅ broker access, hide creds | ❌ | ~ scoped ZeroID identity tokens |
| **Inline IDE code actions** | ❌ | ✅ | ✅ | ~ | ❌ orchestrates, not inline | ~ built-in editor + editable diff; one-click handoff to Cursor/VS Code | ❌ not our niche |
| **SWE-bench / automated coding benchmark score** | — | — | ✅ | ✅ | — meta-harness | — | ❌ not yet benchmarked |
| **Multi-model routing** (Opus for plan, Haiku for cheap subtasks) | ~ recent | ~ | ✅ | ✅ | ✅ model routing across harnesses | ~ model + reasoning-effort picker at launch, per-agent overrides, BYO provider gateways; no automatic routing | ~ per-session model + provider choice; automatic cost-routing on the roadmap |

Legend: ✅ first-class · ~ partial · ❌ not supported · — not a meaningful comparison

## Why codeoid's backend list is shorter

Superset supports 12 named agents plus "any other CLI agent" because it integrates at the terminal — a backend is a command string, and a session is a byte stream.
Codeoid integrates at each agent's native protocol, so a backend costs 300–1,300 lines, and the shorter list is the direct consequence.

That trade is deliberate, and it is not recoverable after the fact.
Verbatim episodic memory needs structured tool calls and results to store.
Per-agent and sub-agent ZeroID attribution needs to know which agent made which call.
Per-turn token and cache accounting needs a usage frame.
Cross-backend fork needs canonical history.
None of that can be reconstructed from a PTY byte stream, so bolting on a terminal tier would inflate the backend count while excluding every backend it added from the features codeoid exists for.

So we would rather support fewer backends completely than more backends nominally.
A backend counts as supported here when it can switch and fork mid-session, run under the conductor, mount codeoid's MCP tools through the common interface, and report usage — not when it merely launches.

The list grows two ways instead, both of which clear that bar.
A **native provider** gives full fidelity including subagent lineage and task graphs (`claude`, `codex`, `gemini`, `openai`, `pi`).
An **ACP adapter** is far cheaper and still qualifies: codeoid's ACP provider mounts the memory MCP endpoint into `session/new` with a per-session tenant-scoped token, emits canonical tool events, and implements the history seed — so an ACP-speaking agent gets switch, fork, conductor, and memory for roughly a resolver plus a registry entry (`gemini-cli` today).
What ACP costs is subagent identity, task dependencies, and workflow fidelity, so it stays the second choice wherever a native protocol is available.

**Where each tool fits:** **[Omnigent](https://github.com/omnigent-ai/omnigent)** is Codeoid's closest peer on session architecture — both are multi-harness meta-harnesses running Claude, Codex, Gemini, OpenAI, and pi.
Omnigent optimizes for **breadth and isolation**: the widest harness set (it also wires up Cursor, OpenCode, and Hermes, and can swap or combine harnesses within one session), an OS-level sandbox (bwrap/seatbelt + an L7 egress proxy), credential brokering that keeps real secrets out of the sandbox, and cross-harness model routing.
It has cross-session recall of its own — full-text search across conversations plus an optional long-term store.

**[Superset](https://github.com/superset-sh/superset)** is the strongest peer on everything Codeoid treats as substrate.
It is an Electron IDE for agent work: worktree workspaces, an editable diff viewer, an in-app browser with per-workspace port detection, terminal presets, scheduled automations, an npm SDK and MCP server, and a cloud relay that lets a phone reach a registered Mac from anywhere.
Its 12-agent list and its "any CLI agent works without configuration" claim are both real.
What it lacks is a session model: the host database stores registry metadata only, terminal output is opaque, and when Superset needed structure for its mobile client it built an ACP adapter layer whose own internal audit records subagent identity, task dependencies, and workflows being dropped in translation.
That audit's conclusion — that a richer UI would need "a Superset-owned normalized layer above the adapters, native SDK in, one internal schema out" — describes the layer Codeoid already ships as `providers/interface.ts` + `canonical.ts`.

Codeoid optimizes for **memory and identity**: workspace-scoped *verbatim episodic* memory with a hybrid ranker injected into context, a cryptographic identity per agent and sub-agent (ZeroID SPIFFE), pre-entry output compression, and per-turn token economics — all reachable from a terminal, a browser, or a phone with live device handoff.

So: reach for **Superset** when you want an IDE around parallel agents and a polished desktop review loop; reach for **Omnigent** when you need OS-level isolation, credential brokering, or the broadest harness set; reach for **Codeoid** when the work has to be remembered verbatim, attributable per agent, and portable across backends, from any device.
And if you just want "fix this function I'm looking at right now," Cursor is still sharper.

---

*Peer claims verified by reading the Omnigent and Superset repositories directly; Superset rows reflect the tree as of 2026-07-26. This space moves in weeks — re-verify before relying on a dated claim.*
