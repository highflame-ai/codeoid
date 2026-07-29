# Handoff — two remaining meta-harness follow-ups

> Untracked design/handoff doc (like `docs/mobile-app-design.md`). Not committed.
> Written 2026-07-10 to let a fresh session pick up two scoped-but-large pieces
> without re-deriving context. Repos: `~/Workspace/codeoid` (daemon + web) and
> `~/Workspace/codeoid-ui` (Rust TUI). Commit identity: **saucam**. User owns
> merges — drive to green + review, never merge unprompted.

---

## 0. Where we are (context)

codeoid is a **meta-harness**: the daemon owns all session state; clients (web,
Rust TUI, Telegram, mobile) are pure renderers over a wire protocol. It drives
*native* agent harnesses at full fidelity rather than reimplementing models on
raw APIs — that's the differentiating bet (pi extensions, Claude Code skills/MCP,
each harness's own caching/session semantics all survive).

**Recently shipped (all merged, `origin/main`):**

- **#131** provider extension surface — `session.ui_request`/`ui_response`/
  `ui_resolved` dialogs, `session.commands`, `custom_message` + `PartsView`,
  `session.part_action`, `tool_start.patchableKeys`, and the **ProviderRegistry**
  (factories, replacing a hardcoded `switch`). Wire-additive; capabilities
  `ui.dialogs` + `commands.dynamic`.
- **#132** **pi (pi.dev) as a second backend** — `PiProvider` over `pi --mode rpc`
  (`src/daemon/providers/pi/{rpc,translate,bridge,index}.ts`). pi has **no native
  permission system**, so codeoid injects a **bridge extension** (`bridge.ts`,
  temp-file, `pi -e`) that routes every pi `tool_call` through `canUseTool`.
  Missing bridge → turn fails **CLOSED**. pi session file is the backing id.
- **#133** **mid-session provider switching** — `session.set_provider` +
  `/provider <id>`; generic loop in `Session.switchProvider` + optional
  **`seedFromHistory?(history)`** on the provider interface. Stateless backends
  no-op it; warm backends (claude, pi) prepend `renderHistorySeed(...)` to their
  first post-switch prompt. **This is the seam both pieces below build on.**
- **#134** web backend switcher (ProviderPicker) + provider chips.
- **#135** **pi subprocess env hardening** — `src/daemon/providers/env.ts`:
  `buildSubprocessEnv` (shared) + `buildPiEnv`, with a DENY list for
  `CODEOID_`/`ZEROID_`/`TELEGRAM_` that beats pattern matches (`CODEOID_API_KEY`
  is the ZeroID root key and ends in `_API_KEY`). `buildAgentEnv` delegates.
- codeoid-ui **#14/#15** mirror the protocol + add `/provider`, `/new --provider`,
  backend tags. **#16** swapped CodeRabbit → gemini-review-bot (also codeoid #136,
  codeoid-mobile #2). Reviews now run via `.github/workflows/gemini-review.yml`
  (jgunnink/gemini-review-bot pinned to the v1.3.0 SHA, `gemini-flash-latest`
  default, `timeout-minutes: 10`).

**Key architecture facts to hold:**

- Provider interface: `src/daemon/providers/interface.ts` — `AgentProvider` /
  `SessionProvider`, `ProviderEvent` union (`interface.ts:142`), `TurnOpts`
  (carries `canUseTool`, `requestUserInput`, `history`), `seedFromHistory?`
  (`interface.ts:267`).
- Canonical history: `src/daemon/providers/canonical.ts` —
  `CanonicalHistoryAccumulator` (`:242`) turns the `ProviderEvent` stream into
  `CanonicalTurn[]`. `CanonicalTurn` (`:36`) already carries `thinking` +
  `toolCalls: CanonicalToolCall[]`. Converters `toAnthropicMessages` (`:199`),
  `toGeminiContent` (`:127`), `toOpenAIMessages` (`:163`) — **all Phase-1 textual**
  (tool calls flattened via `toolCallToText`). `renderHistorySeed` (`:353`).
- Session owns approvals/scrollback/transcript. Tool gating lives in
  `Session.#makeCanUseToolFn` (`session.ts:2293`) → `#shouldAutoApprove`
  (`:2203`), which consults mode/budget/`isSafeTool`.
- Claude provider consumes Claude Code **hooks** (`PreToolUse`, `SubagentStart`,
  `SubagentStop`) INTERNALLY (`claude/index.ts:327`) for audit + Bash-compression
  rewrite + subagent identity — but there is **no codeoid-level user-pluggable
  hook bus**. That's piece 1.

**Repo conventions:**
- Daemon/protocol/core: `bun run test` / `typecheck` / `lint` (biome). Web:
  `cd web && bun run test / typecheck / lint`. codeoid-ui: `cargo test --workspace`,
  `cargo fmt --all -- --check` (hard gate), `cargo clippy --all-targets` (advisory).
- **codecov patch gate is 80%** on both repos — write tests as you go.
- Protocol changes are **wire-additive** (no `PROTOCOL_VERSION` bump); capability
  strings gate new behavior; the schema exhaustiveness test in
  `packages/protocol/src/schemas.test.ts` forces a sample for every new
  `ClientMessage`, and `protocol.test.ts` forces a `DaemonMessage` switch arm.
  codeoid-ui has a wire rename-audit (`tests/wire_format.rs`) + roundtrip tests.
- Offline tests: pi uses a fake-pi fixture (`src/tests/fixtures/fake-pi.ts`
  spawned via a wrapper script); mock provider is
  `src/daemon/providers/mock/session-provider.ts` (extended in #133 with
  `seedFromHistory` capture + `seedFromHistoryError`).
- Start each piece: `git checkout main && git pull && git checkout -b <branch>`.

---

## 1. Daemon-native hook bus

### Problem
pi's extension hooks (tool_call block/mutate, before_agent_start, context
mutation, session lifecycle) are the single best idea we found in the pi harness.
They work today **only for pi sessions** because they run inside the pi process.
Claude/gemini/openai sessions get no equivalent user-configurable hooks. A
**daemon-native hook bus** gives every backend the same extensibility, keyed by
provider-neutral `ProviderEvent`s the daemon already sees — so a user's
"block writes to .env", "git-checkpoint per turn", "inject context", "audit to
webhook" rules apply uniformly regardless of backend.

This is distinct from pi's in-process extensions (those keep working for pi). This
is codeoid's OWN hook layer, sitting at the daemon between the provider event
stream and Session's handling.

### Design sketch
A `HookBus` the daemon constructs once (like `ProviderRegistry` /
`CompressionRegistry`) and Session consults at well-defined points. Hooks are
**config-declared** (start with `providers`-style config: shell-command hooks à la
Claude Code's `settings.json` hooks, matched by event + tool-name matcher), so v1
needs no plugin-loading machinery — just a typed dispatch over the events Session
already produces.

Hook points to expose (map to existing Session seams — do NOT invent new event
plumbing where one exists):
- **`tool_call`** (can block / mutate input) — hook into `#makeCanUseToolFn`
  (`session.ts:2293`) alongside the existing approval gate. A hook returning
  `{block, reason}` short-circuits to a deny; a hook mutating `input` feeds the
  same `updatedInput` path `patchableKeys` uses. This is the load-bearing one and
  the natural parity with pi's `tool_call` + codeoid's own bridge.
- **`tool_result`** (observe / patch) — after `tool_complete` in
  `#handleProviderEvent`.
- **`before_turn` / `after_turn`** — around `#sendInner` / `turn_done`. `before_turn`
  can inject a `systemPromptAppend` addition or a `custom_message`.
- **session lifecycle** (`session_start`, `session_end`, `provider_switched`,
  `rotated`) — cheap observability hooks; you already emit info messages at these
  points.

v1 hook *kinds* (keep small): `command` (spawn a shell command with the event
JSON on stdin, honor an allow/deny/mutate JSON response — mirror Claude Code's
hook contract so users can reuse mental models) and maybe `webhook` (POST). Do
NOT build an in-process JS plugin loader in v1 — that's a much bigger security
surface; note it as a future kind.

Security: hooks run arbitrary user code by design, but they run in the DAEMON's
trust context, so a hook command must get the **hardened subprocess env**
(`buildSubprocessEnv` from #135, `providers/env.ts`) — never raw `process.env`.
This is the #1 review risk; wire it from the start.

### Files
- New: `src/daemon/hooks/bus.ts` (the `HookBus`, event dispatch, command/webhook
  kinds), `src/daemon/hooks/types.ts` (hook event shapes — reuse `ProviderEvent`
  data where possible), config schema in `src/config.ts` (`hooks:` block, gate
  optional like `dispatch`/`providers`).
- Touch: `src/daemon/session.ts` (dispatch at the seams above — thread the bus in
  via `SessionCreateOptions`, retain it like `#providersRegistry` did in #133),
  `src/daemon/session-manager.ts` (build the bus once, pass to sessions),
  `src/daemon/server.ts` (construct at startup).
- Optional wire surface: a `hooks.config`-style read-only snapshot verb so
  clients can DISPLAY configured hooks (parallel to `claude.config`), and info
  messages when a hook blocks/mutates a tool so the user sees why. Additive.

### Tests
- Unit: bus dispatch + command-kind exec with a fake hook script (fixture pattern
  like fake-pi) — assert block short-circuits the tool, mutate reaches the
  provider, env is hardened (no `CODEOID_*` leaks — reuse the #135 deny-list
  test shape).
- Integration over the mock provider: a `tool_call` hook that blocks a tool;
  assert the tool never executes and an info message explains it. A `before_turn`
  hook that injects a `systemPromptAppend`.
- Config schema fidelity + env-override tests.

### Open questions (decide, don't block)
- Ordering vs. the approval gate: hooks-then-approval or approval-then-hooks? Lean
  **hooks first** (a hook block is a policy deny that shouldn't even prompt the
  user), matching pi's `tool_call` semantics.
- Do hooks fire for auto-approved safe tools (Read/Grep/Glob)? Probably yes for
  observe-hooks, and a block-hook on a safe tool must still win. Keep the gate
  uniform.
- Conductor/worker sessions: inherit tenant hooks or run hook-free? Default to
  inherit; note it.

---

## 2. Phase-2 native-structured canonical history

### Problem
`renderHistorySeed` (#133) and every `to<Provider>Messages` converter are
**Phase-1 textual**: `CanonicalToolCall`s are flattened to prose
(`toolCallToText`), `thinking` isn't carried into provider payloads, and
provider-native structures (Anthropic `tool_use`/`tool_result` blocks) don't
survive. So a **switched** session gets a faithful *transcript*, not a native
continuation. Phase 2 raises fidelity: emit native structured messages so the
incoming backend sees real tool-call turns, not a narrated summary.

The data is ALREADY captured natively — `CanonicalTurn` (`canonical.ts:36`)
carries `content`, `toolCalls: CanonicalToolCall[]` (id/name/input/output/success),
and `thinking`. The accumulator (`handleEvent`, `:266`) populates all of it. Only
the **rendering/conversion** side is lossy. That's the whole scope: better
converters, not new capture.

### Design sketch
- **`toAnthropicMessages`** (`canonical.ts:199`) — the highest-value target since
  claude is the default backend. Replace the flattened `[Tool calls executed…]`
  text with real content blocks: assistant messages with `tool_use` blocks
  (`{type:"tool_use", id, name, input}`) + following `user` messages with
  `tool_result` blocks (`{type:"tool_result", tool_use_id, content}`). The
  comment at `:213` literally says "Phase 2: replace with tool_use + tool_result
  content blocks" — that's the marker. Carry `thinking` as a `thinking` block
  where the target supports it.
- **`toGeminiContent` / `toOpenAIMessages`** — same idea in each provider's native
  function-call shape (Gemini `functionCall`/`functionResponse` parts; OpenAI
  `tool_calls` + `role:"tool"` messages).
- **`seedFromHistory`** for warm backends: today it prepends a rendered string
  because neither the Claude SDK nor pi RPC accepts arbitrary native-history
  injection cleanly. Investigate whether the Claude Agent SDK's session
  resume/import can accept a synthesized native transcript (higher fidelity than
  the string prepend). If not, keep the string seed but make it use the richer
  structured text. **The switch loop itself (`Session.switchProvider`) does not
  change** — only what `seedFromHistory` / the converters produce.
- The **stateless** providers (gemini, openai) benefit immediately and cleanly:
  they call the converter every turn already, so upgrading the converter upgrades
  their fidelity with zero switch-loop changes.

### Files
- Core: `src/daemon/providers/canonical.ts` — rewrite the three `to*` converters +
  `renderHistorySeed` (or add structured variants). Keep `CanonicalTurn` /
  `CanonicalToolCall` shapes (they're sufficient); only extend if you find a
  genuinely missing field (e.g. tool_use ids that must round-trip — they're
  already on `CanonicalToolCall.id`).
- Consumers: `gemini/index.ts`, `openai/index.ts` (they call the converters),
  `claude/index.ts` + `pi/index.ts` (`seedFromHistory`).
- The mock/fake-pi fixtures already emit `tool_start`/`tool_complete` with ids, so
  the accumulator produces real `toolCalls` — good for tests.

### Tests
- Converter units: feed a `CanonicalTurn[]` with tool calls + thinking, assert the
  Anthropic output has real `tool_use`/`tool_result` blocks with matching
  `tool_use_id`, Gemini has `functionCall`/`functionResponse`, OpenAI has
  `tool_calls` + tool-role messages. (`canonical.ts` already has a `handleEvent`
  test path via provider E2E — extend it.)
- Round-trip a claude→pi switch (mock or fake-pi) and assert the seed carries
  structured tool history, not the `[Tool: …]` flattened form.
- Guard the `HISTORY_SEED_MAX_CHARS` truncation still applies to the richer form.

### Open questions
- Fidelity vs. cost: native tool_use replay is more tokens than a summary. Consider
  a config knob (summary vs. native) or size-based fallback (native under N turns,
  summary above). Note it; default native for the switch case since that's the
  point.
- Does the Claude SDK accept a synthesized native transcript on resume? If yes,
  that's the real fidelity win (seed becomes a native import, not a prompt
  prefix). If no, structured-text seed is the ceiling for warm backends — document
  it honestly (the fidelity contract is already stated in `docs/providers-pi.md`
  and the `session.set_provider` protocol comment; update both if the ceiling
  changes).

---

## Suggested order
Do the **hook bus first** — it's more self-contained (new subsystem, few edits to
existing hot paths) and doesn't touch the switch/seed path. Phase-2 history is a
focused rewrite of `canonical.ts` converters that benefits from a quiet main.
Neither depends on the other. Each is one PR.

## Fast start for a fresh session
1. Read this file + `docs/multi-provider-meta-harness.md` +
   `src/daemon/providers/interface.ts` + `canonical.ts`.
2. Recall the memory: `project-pi-provider-in-codeoid` in the auto-memory has the
   compressed workstream history and the "remaining backlog" line.
3. `cd ~/Workspace/codeoid && git checkout main && git pull && git checkout -b feat/hook-bus`.
