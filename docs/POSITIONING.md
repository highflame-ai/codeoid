# codeoid — Positioning & Competitive Strategy

> **Internal working doc — untracked, not published.** Living reference; update as features land and the market moves.
> Last updated: **2026-07-14**. The landscape here moves in weeks — re-verify dated claims before relying on them.

---

## One-sentence positioning

**The identity-first, guardrailed, self-hostable control plane for heterogeneous coding agents — never-lossy memory, any harness, any OS, behind your own gateway.**

Lead with *governed + local + neutral + never-lossy*. Demote remote/mobile/parallel-sessions to substrate — the platforms already commoditized those.

---

## What codeoid is

A local-first, MIT, Bun/TypeScript daemon that runs N parallel coding-agent sessions across repos, each on a pluggable backend (`claude` default; `openai`, `gemini`, `codex`, `pi`, `gemini-cli`), reachable from a Rust/Ratatui TUI, a cross-OS web UI, or Telegram, with device handoff. Daemon owns all state; clients are pure renderers. Verbatim cross-session workspace memory; per-agent + sub-agent cryptographic identity via ZeroID.

---

## The four moats (lead here)

1. **Never-lossy verbatim memory — an *architecture*, not a stance.**
   Every tool call / result / reasoning block stored verbatim as an episode; hybrid recall (vector 0.55 + FTS5/BM25 0.25 + recency 0.12 + path-overlap 0.08); workspace-scoped (shared across git worktrees); auto-injected memory index; `recall()/recall_file()/timeline()`. Everyone else sits on the opposite pole — Cursor/Windsurf/Copilot/mem0 *extract facts*; Anthropic *summarizes* (compaction) and *clears* tool results (context editing). They can't "add verbatim" without rebuilding their pipeline. A Dec-2025 controlled ablation ([arXiv 2601.00821](https://arxiv.org/abs/2601.00821)) found verbatim beats extracted by ~16 pts (LoCoMo) — the corner codeoid occupies is under-served, not wrong.

2. **True meta-harness.**
   Claude / Codex / Gemini / OpenAI / pi (+ planned hermes/local) behind one `SessionProvider` interface; cross-backend fork (a Claude session forks onto Codex and resumes with full context). Anthropic *structurally cannot* do this; happy/vibetunnel don't; only Omnigent does — and it lacks the other three moats.

3. **Identity + governance (the uncontested intersection).**
   ZeroID SPIFFE/WIMSE identity on every agent and attenuated sub-agent; every tool call attributable. **No** platform vendor, bridge, or cockpit does per-agent identity. Omnigent does credential *hiding* (egress proxy), not attributable *identity* — a different axis. This rides the hottest enterprise-security trend of 2025-26 (Cisco→Astrix ~$400M closed Jun 2026; Aembit & Okta-for-AI-Agents GA; SPIFFE-for-agents; IETF WIMSE WG; MCP audit guidance demanding per-tool-call attribution). **codeoid's identity runs on ZeroID — our own stack — so it's uncopyable, and codeoid is the natural reference client for Highflame agent security.**

4. **Lightweight-by-architecture + embedded + cross-OS.**
   Bun-only; `bun:sqlite` (no external DB); `@xenova/transformers` WASM embeddings (no embedding service); no tmux, no Python, no Postgres/Redis. Install Bun → `bun install` → run. Contrast Omnigent's prereq chain (below). This is the *deployment* half of the sovereignty wedge: a regulated team can drop codeoid on a locked-down / headless / any-distro box with no toolchain. Web UI works on any OS — vs Claude Desktop's 2-week-old Debian-only beta.

### Deployment footprint: codeoid vs Omnigent

| | codeoid | Omnigent |
|---|---|---|
| Runtime | Bun only | Python 3.12+ **and** uv **and** git |
| Agent execution | Claude Agent SDK **in-process** + provider APIs | shells out to **tmux-wrapped PTY** per harness |
| Sandbox tooling | none yet (roadmap; will be opt-in) | **bwrap** (Linux, mandatory) / seatbelt |
| DB / memory | embedded `bun:sqlite` + WASM embeddings | — |
| Node/npm | only for codex/pi/gemini CLIs | **Node 22+** required for npm harnesses |
| Windows | web UI + daemon run | "degraded mode" (no native wrappers/sandbox) |
| External services | none | Docker (server deploy), optional Databricks |

Honest caveat: part of Omnigent's weight *buys* the OS sandbox — the gap on our roadmap. When we add sandboxing we take on bwrap/seatbelt too, but we keep it **opt-in per session** so the zero-dep path stays trivial.

---

## What's commoditized (do NOT lead here)

- **Remote / mobile / multi-frontend + device handoff.** Anthropic shipped native **Remote Control** (laptop↔phone↔browser, 32 sessions), **Channels** (official Telegram/Discord/iMessage), **Agent View** (multi-session dashboard), **Session Memory** — Oct 2025→mid-2026. OSS: [happy](https://github.com/slopus/happy) (22k★, mobile+web+voice+E2E), vibetunnel, Omnara (YC).
  - *Nuance that keeps a wedge:* Anthropic Remote Control is **Claude-only, Max-plan ($100-200/mo), requires api.anthropic.com, disabled behind an LLM gateway / on Bedrock/Vertex/Foundry, off-by-default on Enterprise**. happy is a *client wrapper* (Claude Code + Codex), **not a meta-harness** — no provider abstraction, memory, or identity. So "remote from any device, any harness, behind your gateway, no plan lock-in" is still open.
- **Parallel worktree sessions.** Table stakes: [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) (27k★), [Claude Squad](https://github.com/smtg-ai/claude-squad) (8k★), Conductor (Mac), Crystal/Nimbalyst, Sculptor (containers), Cursor 2.0 (8-way), Warp.
- **Basic multi-model routing.** Cline, Aider, OpenHands, Kilo, OpenCode (185k★).

---

## Roadmap, tiered by moat vs pace

**Tier 1 — moat-defining (do first):**
- **Highflame guardrail hooks + ZeroID enforcement** — the single highest-leverage build: identity + inline guardrails + audit = the governed control plane nobody else has, uncopyable because we own the stack.
- **Local models + hermes** — fully-local / air-gapped / sovereign; where Anthropic & happy structurally can't go. Ties to our own hermes/anyagent work.
- **Sandboxing** — closes the biggest gap (worktrees share the host); feeds the security story. Keep it **opt-in per session** (bwrap/seatbelt) so the lightweight path survives.

**Tier 2 — control-plane completeness (necessary):**
- **Conductor over all sessions** — finish the provider-agnostic conductor; it's what makes "control plane" true vs "session list."
- **Federation across machines** ([design](federation-design.md)) — one hub view over N daemons (laptop, workstation, server, Mac). Scanned Sep 2026: happy, Omnara, Vibe Kanban, Sculptor and Coder Agent Relay all do *remote control of one machine*; **nobody aggregates several**. Omnara answers the same need by *migrating* a session to the cloud — the opposite primitive, and it can't serve work that is pinned to a machine (Apple signing, the corpus, an unpushed branch).
  Two notes that keep this honest: it is a **ZeroID-tier capability** (refused under `--local` — see [local-mode](local-mode.md#why-federation-is-refused)), so it does not widen the OSS surface; and its defensible half is not the aggregation but **per-machine attested identity** (ZeroID already ships the `tpm` proof type + `RequiredTrustLevel` gate), which no peer in that table can reach because none has an identity layer to hang it on. Sequence it *behind* the P5 front doors — an aggregated board with no client drawing it is worth nothing.
- **Cross-OS web UI** — already true; make it a *headline*, not a footnote.

**Tier 3 — table stakes (build thin, don't out-polish incumbents):**
- **Mobile app** — a thin renderer of the unique daemon (identity/memory/meta-harness); do **not** enter a polish race with happy (22k★).
- **Fully-local voice** — exploits a real gap (Claude Desktop has no voice on Linux); privacy + offline. Convenience, not moat.
- **Pre-installed feature-dev skills** — adoption/time-to-value; differentiates only if the skills are opinionated (e.g. the Highflame feature-dev workflow).

---

## Strategic through-line

One sentence no competitor can say: *"the identity-first, guardrailed, sandboxed, fully-local, never-lossy control plane that runs any harness on any OS behind your own gateway."* Everything in Tier 1 builds toward that. Convenience features are hygiene — necessary, but not where effort should concentrate.

---

## Risks (name them honestly)

- **Traction:** effectively a solo project, no visible adoption signal vs 8k–185k★ peers and $300M–$4B-funded incumbents. Engineering quality ≠ distribution.
- **Segment mortality:** Terragon (closest multi-surface analog) shut down Jan 2026; Roo Code shut May 2026; Crystal renamed. "Nice cockpit" isn't survivable alone.
- **Platform cadence:** Anthropic went from none→all of the commodity features in ~8 months. Never bet the moat on a feature they can ship.
- **Memory scaling:** verbatim-forever → store growth, retrieval precision decay (hard negatives), context-rot on injection, staleness (recalled diff wrong after later commits), stored prompt-injection / secret capture. Hardening path: verbatim-on-disk + compact index for injection, commit-aware staleness, RRF/reranker, injection+secret hygiene.
- **Surface spread:** a lot of roadmap for a solo project — concentrate on Tier 1.

---

## Key sources (as of 2026-07-14)

- Omnigent (Databricks, Apache-2.0, ~7.2k★, created 2026-06-11): [repo](https://github.com/omnigent-ai/omnigent) · [Databricks blog](https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents)
- Claude native overlap: [Remote Control](https://code.claude.com/docs/en/remote-control) · [Channels](https://code.claude.com/docs/en/channels) · [Claude Code on web](https://claude.com/blog/claude-code-on-the-web) · [Desktop on Linux (beta)](https://code.claude.com/docs/en/desktop-linux)
- Memory: [Anthropic context management](https://www.anthropic.com/news/context-management) · [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) · [Zep/Graphiti](https://arxiv.org/abs/2501.13956) · verbatim ablation [arXiv 2601.00821](https://arxiv.org/abs/2601.00821)
- Agent identity: [SPIFFE for agents (HashiCorp)](https://www.hashicorp.com/en/blog/spiffe-securing-the-identity-of-agentic-ai-and-non-human-actors) · [IETF WIMSE](https://datatracker.ietf.org/wg/wimse/about/) · [Cisco→Astrix](https://blogs.cisco.com/news/cisco-announces-intent-to-acquire-astrix-security)
- Cockpits: [happy](https://github.com/slopus/happy) · [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) · [Claude Squad](https://github.com/smtg-ai/claude-squad) · [container-use](https://github.com/dagger/container-use)
