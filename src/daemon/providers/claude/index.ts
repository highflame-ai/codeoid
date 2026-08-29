/**
 * ClaudeProvider — wraps the Claude Agent SDK query loop and emits ProviderEvents.
 *
 * Owns all Claude-specific state:
 *   - claudeCodeSessionId (the backing SDK session, separate from codeoid's session.id)
 *   - hasQueried / backingRecoveryAttempted flags
 *   - SDK Query + AsyncQueue + consumer task
 *
 * Session remains the owner of scrollback, transcript, approvals, and all
 * SessionMessage state.  ProviderEvents are the interface between the two.
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PreToolUseHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
  type McpServerConfig,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AsyncQueue } from "../../async-queue.js";
import type { AgentIdentityManager } from "../../agent-identity.js";
import type { Store } from "../../store.js";
import {
  buildMemoryMcpServer,
  MEMORY_TOOL_NAMES,
  type MemoryEngine,
} from "../../memory/index.js";
import { BLACKBOARD_MCP_SERVER_NAME } from "../../blackboard/mcp-http.js";
import type { McpRegistry } from "../../mcp/registry.js";
import { resolveEnvMap } from "../../mcp/types.js";
import type { CompressionRegistry } from "../../compress/index.js";
import { FLEET_TOOL_NAMES } from "../../fleet.js";
import { rewriteBashToolInput } from "../../compress/index.js";
import type { CodeoidConfig } from "../../../config.js";
import type { AuthContext } from "../../../protocol/types.js";
import type { SessionProvider, ModelInfo, NormalizedTurnResult, ProviderEvent, SessionScopedEvent, TurnOpts, TurnRun } from "../interface.js";
import { renderHistorySeed, type CanonicalTurn, type HistorySeedResult } from "../canonical.js";
import { buildSubprocessEnv, withGatewayCredential } from "../env.js";
import type { LLMCallUsage } from "../../context-math.js";
import type { PackSubagent } from "../../pipeline/subagents.js";

/** Map ambient-pack subagents to the Claude Agent SDK's programmatic `agents`
 *  option (keyed by name). Empty → no `agents` key at all. */
/** `{ codeoid_blackboard: … }` when a mount is present, else `{}`. Split out so
 *  the spread never introduces an `undefined`-valued key. */
function blackboardServerEntry(
  mount: { url: string; token: string } | undefined,
): Record<string, McpServerConfig> {
  if (!mount) return {};
  return {
    [BLACKBOARD_MCP_SERVER_NAME]: {
      type: "http",
      url: mount.url,
      headers: { Authorization: `Bearer ${mount.token}` },
    } as unknown as McpServerConfig,
  };
}

function packAgentsOption(
  subs?: readonly PackSubagent[],
): { agents?: Record<string, { description: string; prompt: string; tools?: string[] }> } {
  if (!subs || subs.length === 0) return {};
  // Null-proto map: subagent names are pack DATA (validated at parse, but keyed
  // here regardless) — a plain `{}` would let a `__proto__` key hit the
  // prototype setter. Object.create(null) has no such trap.
  const agents: Record<string, { description: string; prompt: string; tools?: string[] }> = Object.create(null);
  for (const a of subs) {
    agents[a.name] = { description: a.description, prompt: a.prompt, ...(a.tools ? { tools: a.tools } : {}) };
  }
  return { agents };
}

// ── Initialisation options ────────────────────────────────────────────────────

export interface ClaudeProviderInit {
  /** codeoid session id — used as the initial backing id and for audit/logging. */
  sessionId: string;
  /** Persisted backing id from Store, or the session id itself on first run. */
  initialBackingId: string;
  /** Tenant-scoped memory workspace id (computed once by Session). Used to bind
   * the memory MCP server so recall/timeline read the SAME scope episodes are
   * written under. */
  workspaceId: string;
  store: Store;
  identityManager?: AgentIdentityManager;
  /** Codeoid memory engine — injected as an MCP server. */
  memory?: MemoryEngine;
  /** codeoid_fleet MCP server — conductor sessions only (read-only fleet view). */
  fleet?: McpSdkServerConfigWithInstance;
  /**
   * Role-scoped goal-blackboard mount, resolved LAZILY.
   *
   * A getter rather than a value because the orchestrator's own mount is
   * scoped to a goal id that IS its session id — so it cannot exist until
   * after the Session is constructed. Providers read it when they build their
   * server list (per turn for claude), by which time it is set.
   */
  blackboardMcp?: () => { url: string; token: string } | undefined;
  /** Cross-backend MCP registry — external servers are mounted natively on the
   *  SDK (claude owns its own MCP client); approval flows through canUseTool. */
  mcpRegistry?: McpRegistry;
  config?: CodeoidConfig;
  compressionRegistry?: CompressionRegistry;
  /** Called once per session with the live model catalog. */
  onModels?: (models: ReadonlyArray<{ value: string; displayName: string; description?: string }>) => void;
  /**
   * Called when the backing Claude Code session is missing (i.e. the SDK
   * throws "No conversation found with session ID").  Session must enqueue
   * the re-send through #sendChain so recovery is serialized with normal sends.
   */
  onRecoveryNeeded?: (content: string) => void;
}

/**
 * Events safe to replay into a LATER turn when they can't be delivered now.
 *
 * Both are addressed by an id the Session tracks (`agentId`, `sdkToolUseId`)
 * and both handlers no-op on an unknown id, so arriving late is harmless —
 * whereas losing them leaves a dangling sub-agent (with a live delegated token)
 * or a tool stuck "running". Deliberately excludes `turn_done` (a stale one
 * would end the next turn the moment it starts) and streamed text (it would
 * corrupt the next turn's transcript).
 */
export const CARRYOVER_EVENT_TYPES: ReadonlySet<ProviderEvent["type"]> = new Set([
  "subagent_stop",
  "tool_complete",
]);

/** Ceiling on buffered undeliverable events, so a pathological loop can't turn
 *  a delivery failure into unbounded memory growth. */
export const MAX_CARRYOVER_EVENTS = 100;

// ── ClaudeProvider ────────────────────────────────────────────────────────────

export class ClaudeProvider implements SessionProvider {
  readonly id = "claude";
  readonly displayName = "Claude (Anthropic)";

  // Claude-specific backing-session state
  #claudeCodeSessionId: string;
  #hasQueried = false;
  #backingRecoveryAttempted = false;
  #lastPushedContent: string | null = null;
  /** Cross-message carry-over for the translator (see TranslateState) — holds
   * the `<local-command-stderr>` that explains a zero-turn "success". */
  #translateState: TranslateState = { lastLocalCommandStderr: null };
  /** Skill commands with an approval prompt in flight — prevents a repeated
   * turn from raising a duplicate prompt for the same command (#233). */
  #pendingSkillApprovals = new Set<string>();
  /** Granted skill-command rules the LIVE query loop was built with. A changed
   * set forces a rebuild (like #builtSystemPromptAppend) so a just-approved
   * command is actually in allowedTools on the retry (#233). */
  #builtSkillAllowRules = "";
  /** Last TurnOpts — the retry after a skill approval rebuilds the loop with
   * these, then re-pushes #lastPushedContent into the SAME turn queue (#233). */
  #lastTurnOpts: TurnOpts | null = null;
  /** Rendered transcript from seedFromHistory() — prepended to the next prompt. */
  #pendingHistorySeed: string | null = null;

  // Long-running SDK loop (one per codeoid session)
  #query: Query | null = null;
  #abortController: AbortController | null = null;
  #inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  #consumerTask: Promise<void> | null = null;
  /** The systemPromptAppend the LIVE query loop was built with. The SDK fixes
   * the system prompt at query construction, so a changed append (before_turn
   * hook output, refreshed memory index) requires a loop rebuild — see
   * #ensureQueryLoop. */
  #builtSystemPromptAppend = "";
  /** Monotonic loop generation. Bumped on every (re)build so an orphaned
   * consumer from a superseded loop can neither emit stale events into the
   * new loop's turn queue nor close it from its `finally`. */
  #loopGeneration = 0;

  // Long-running event queue — closed only when the SDK loop ends.
  // turn_done events are emitted as regular items; Session decides when to stop.
  #currentTurnQueue: AsyncQueue<ProviderEvent> | null = null;
  /**
   * Exact tool names the SDK auto-approves from `allowedTools`, which means it
   * never calls canUseTool for them. Since canUseTool is this provider's only
   * tool_start emitter, the PreToolUse hook emits on their behalf — consulted
   * there to decide which calls need that, and to guarantee we never
   * double-emit for a tool that does reach the gate.
   */
  #autoApprovedTools = new Set<string>();
  /** Id-keyed lifecycle events that arrived with no live queue, replayed into
   *  the next turn. See #handleUndeliverable. */
  #carryover: ProviderEvent[] = [];
  /** Dedupe keys for the undeliverable-event log, so a persistent loss reports
   *  once per loop generation instead of once per event. */
  #undeliverableLogged = new Set<string>();

  /**
   * Mutable callback — Session updates this before each runTurn() call to
   * capture the current sender for recovery error handling.
   */
  onRecoveryNeeded: ((content: string) => void) | undefined;
  /** Session-lifetime listener — see SessionProvider.onSessionEvent. */
  onSessionEvent: ((event: SessionScopedEvent) => void) | undefined;

  // Per-turn mutable canUseTool + sender — updated on each runTurn()
  #currentCanUseTool: TurnOpts["canUseTool"] | null = null;
  /** Session's dialog gate, captured per turn — skill-command approval uses
   * this rather than canUseTool so the autonomous auto-approve path cannot
   * swallow it (#233). */
  #currentRequestUserInput: TurnOpts["requestUserInput"] | null = null;
  #currentSender: AuthContext | null = null;

  #init: ClaudeProviderInit;

  constructor(init: ClaudeProviderInit) {
    this.#claudeCodeSessionId = init.initialBackingId;
    this.#init = init;
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  get backingSessionId(): string { return this.#claudeCodeSessionId; }
  get queuedMessages(): number { return this.#inputQueue?.size ?? 0; }
  get hasQueried(): boolean { return this.#hasQueried; }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  /**
   * Called by Session.#rotate() — mints a new backing session id so the next
   * runTurn() creates a fresh Claude Code session rather than resuming.
   */
  resetToNewSession(newBackingId: string): void {
    this.#claudeCodeSessionId = newBackingId;
    this.#hasQueried = false;
    this.#backingRecoveryAttempted = false;
    this.#lastPushedContent = null;
  }

  // ── AgentProvider interface ───────────────────────────────────────────────

  /**
   * Start (or reuse) the long-running SDK loop, push the user message, and
   * return a per-turn event stream that closes on turn_done.
   */
  runTurn(opts: TurnOpts): TurnRun {
    this.#currentCanUseTool = opts.canUseTool;
    this.#currentRequestUserInput = opts.requestUserInput ?? null;
    this.#currentSender = opts.sender ?? null;
    this.#lastTurnOpts = opts;

    this.#ensureQueryLoop(opts);

    // Close any stale turn queue from a previous turn that didn't end cleanly.
    this.#currentTurnQueue?.close();
    const turnQueue = new AsyncQueue<ProviderEvent>();
    this.#currentTurnQueue = turnQueue;

    // Replay lifecycle events that arrived while no queue was live — a
    // SubagentStop hook resolving after the previous turn ended, a trailing
    // tool_result. Their handlers are id-keyed and idempotent, so a duplicate
    // costs nothing; losing them is what left sub-agents dangling and tools
    // stuck "running" for the rest of the session.
    if (this.#carryover.length > 0) {
      const replay = this.#carryover;
      this.#carryover = [];
      console.error(
        `[claude-provider ${this.#claudeCodeSessionId.slice(0, 8)}] replaying ${replay.length} carried-over event(s) into the new turn`,
      );
      for (const ev of replay) {
        try {
          turnQueue.push(ev);
        } catch {
          // A brand-new queue should never reject; if it somehow does, the
          // boundary sweep is still the backstop.
          break;
        }
      }
    }

    let userMessage = opts.userMessage;
    if (this.#pendingHistorySeed && userMessage) {
      // Post-switch seeding: this fresh Claude Code session has never seen
      // the conversation — carry it in as a transcript block ahead of the
      // first prompt (same mechanism as rotation's task anchor).
      userMessage = `${this.#pendingHistorySeed}\n\n${userMessage}`;
      this.#pendingHistorySeed = null;
    }
    if (userMessage) {
      this.#pushSDKMessage(userMessage, "later");
    }
    return {
      events: turnQueue,
      interrupt: async () => {
        const q = this.#query;
        if (q) {
          try {
            await q.interrupt();
            return;
          } catch {
            // fall through to hard abort
          }
        }
        this.#abortController?.abort();
        this.#inputQueue?.close();
      },
      pushMidTurn: (content, priority) => {
        // A "later" mid-turn injection is meant to MERGE into the running turn
        // (no new query); "now"/"next" should query. Only the primary prompt
        // (above, via the default) always queries.
        //
        // NOTE for callers: only the querying variants produce an additional
        // turn_done. Session mirrors this when deciding whether to expect an
        // intermediate turn boundary — counting a "later" push there makes it
        // swallow the turn's terminal turn_done and hang at "thinking".
        this.#pushSDKMessage(content, priority, priority !== "later");
      },
      endTurn: () => {
        // The consumer for THIS turn has stopped reading. Close its queue so a
        // late event surfaces through #handleUndeliverable (logged, and buffered
        // if it's id-keyed) instead of being pushed into a queue nobody drains.
        // Generation/identity guarded: a rebuilt loop or a newer turn may
        // already own #currentTurnQueue, and closing that would kill a live turn.
        if (this.#currentTurnQueue === turnQueue) {
          this.#currentTurnQueue.close();
          this.#currentTurnQueue = null;
        }
      },
    };
  }

  /**
   * Provider switch seeding: render the canonical history once and prepend
   * it to the first post-switch prompt (the SDK offers no native history
   * injection). Empty history is a no-op.
   */
  seedFromHistory(history: readonly CanonicalTurn[], opts?: { maxChars?: number }): HistorySeedResult {
    const seed = renderHistorySeed(history, { maxChars: opts?.maxChars });
    this.#pendingHistorySeed = seed.text.length > 0 ? seed.text : null;
    return seed;
  }

  /**
   * VWS transport: prepend a strategy-built block (the compact session map) to
   * the next prompt — the same channel seedFromHistory uses. The session picks
   * transcript vs session-map; the provider just stashes the block.
   */
  seedText(block: string): void {
    this.#pendingHistorySeed = block.length > 0 ? block : null;
  }

  /**
   * Claude has the memory recall tools (recall/recall_file/timeline/get_episode)
   * mounted via the in-process MCP server whenever the session has memory, so it
   * can page the verbatim store on demand — the precondition the Verbatim
   * Working Set strategy checks before seeding a compact map instead of a
   * transcript.
   */
  get supportsMemoryTools(): boolean {
    return this.#init.memory != null;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.#query) return [];
    try {
      const models = await this.#query.supportedModels();
      return models.map((m) => ({
        id: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    await this.teardown();
  }

  async teardown(): Promise<void> {
    this.#inputQueue?.close();
    this.#abortController?.abort();
    if (this.#consumerTask) {
      try { await this.#consumerTask; } catch { /* consumer handles its own errors */ }
    }
    this.#currentTurnQueue?.close();
    this.#currentTurnQueue = null;
    this.#inputQueue = null;
    this.#consumerTask = null;
    this.#query = null;
    this.#abortController = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #pushSDKMessage(content: string, priority: "now" | "next" | "later", shouldQuery = true): void {
    if (!this.#inputQueue) {
      console.error(`[claude-provider ${this.#init.sessionId.slice(0, 8)}] push without active queue — dropping`);
      return;
    }
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.#claudeCodeSessionId,
      priority,
      // shouldQuery MUST be true for a message that should trigger an assistant
      // turn — the SDK otherwise appends it to the transcript WITHOUT querying
      // and merges it into the next querying message (sdk.d.ts SDKUserMessage).
      shouldQuery,
    };
    this.#lastPushedContent = content;
    try {
      this.#inputQueue.push(msg);
    } catch (err) {
      console.error(`[claude-provider] push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #ensureQueryLoop(opts: TurnOpts): void {
    const desiredAppend = opts.systemPromptAppend ?? "";
    const skillAllowRules = this.#resolveSkillGrants(opts);
    const desiredGrants = skillAllowRules.join("\n");

    // Exact tool names we hand the SDK as pre-approved. Kept as its own list
    // (rather than inlined into `allowedTools`) because the PreToolUse hook has
    // to know precisely which tools will SKIP canUseTool, so it can emit the
    // tool_start that canUseTool would otherwise have emitted.
    const autoApprovedToolNames = [
      ...(this.#init.memory ? MEMORY_TOOL_NAMES.map((t) => `mcp__codeoid_memory__${t}`) : []),
      // Widened for the conductor's fleet server — without these entries the
      // mounted server's tools stay unreachable (design §3 gotcha). Note this
      // is FLEET_TOOL_NAMES (the READ set) only: the send-class verbs are
      // deliberately absent so they still ride the owner's approval flow.
      ...(this.#init.fleet ? FLEET_TOOL_NAMES.map((t) => `mcp__codeoid_fleet__${t}`) : []),
    ];
    this.#autoApprovedTools = new Set(autoApprovedToolNames);
    if (this.#consumerTask && this.#inputQueue && !this.#inputQueue.closed) {
      if (
        this.#builtSystemPromptAppend === desiredAppend &&
        this.#builtSkillAllowRules === desiredGrants
      ) {
        return;
      }
      // Per-turn contributions the SDK fixes at query construction changed, so
      // the warm loop would silently use the stale value — rebuild instead.
      // Two triggers: the system-prompt append (before_turn hooks, memory
      // workspace-index refresh — #153) and the skill-command grants (a just-
      // approved command must reach allowedTools on the retry — #233). The
      // fresh query RESUMES the same backing session, so no context is lost.
      // console.log, not error: an expected control-flow event.
      const reason =
        this.#builtSystemPromptAppend !== desiredAppend
          ? `systemPromptAppend changed (${this.#builtSystemPromptAppend.length}B → ${desiredAppend.length}B)`
          : "skill-command grants changed";
      console.log(
        `[claude-provider ${this.#init.sessionId.slice(0, 8)}] ${reason} — rebuilding query loop`,
      );
      this.#inputQueue?.close();
      this.#abortController?.abort();
      // The generation bump below orphans the old consumer; its identity-
      // guarded finally cannot clobber the new loop's slots.
    }

    const init = this.#init;
    const sessionId = init.sessionId;
    this.#abortController = new AbortController();
    this.#inputQueue = new AsyncQueue<SDKUserMessage>();
    this.#builtSystemPromptAppend = desiredAppend;
    this.#builtSkillAllowRules = desiredGrants;
    this.#loopGeneration += 1;
    const myGeneration = this.#loopGeneration;

    const sessionOpts = this.#hasQueried
      ? { resume: this.#claudeCodeSessionId }
      : { sessionId: this.#claudeCodeSessionId };

    // Merge user MCP servers with codeoid's in-process memory server.
    // Apply a per-call wall-clock timeout to the external (user) servers so a
    // hung MCP tool call surfaces as an SDK error instead of silently wedging
    // the turn. Not applied to the in-process memory server. Kept below the
    // session stall watchdog so the SDK signals first.
    const mcpToolTimeoutMs = init.config?.session.mcpToolTimeoutMs ?? 120_000;
    const merged: Record<string, McpServerConfig> = {
      ...withMcpToolTimeout(loadUserMcpServers(opts.workdir), mcpToolTimeoutMs),
      ...(init.memory
        ? {
            codeoid_memory: buildMemoryMcpServer(init.memory, {
              workspaceId: init.workspaceId,
              sessionId,
            }),
          }
        : {}),
      // Conductor sessions only — the read-only fleet view (P3). In-process,
      // so the external-server timeout doesn't apply.
      ...(init.fleet ? { codeoid_fleet: init.fleet } : {}),
      // Collaboration children only — the role-scoped goal blackboard. Mounted
      // over HTTP rather than in-process precisely so the SAME surface works on
      // gemini/codex; claude deliberately gets no privileged path here (#245).
      // Resolved per query build, not captured at construction — the
      // orchestrator's mount is attached after its Session exists.
      ...blackboardServerEntry(init.blackboardMcp?.()),
      // Registry servers — mounted natively on the SDK (claude owns its client);
      // tool calls surface as `mcp__<server>__<tool>` and gate via canUseTool.
      ...withMcpToolTimeout(registryServersForClaude(init.mcpRegistry), mcpToolTimeoutMs),
    };
    const mcpServers = Object.keys(merged).length > 0 ? merged : undefined;

    // skillAllowRules computed above (used in the rebuild guard).
    this.#query = query({
      prompt: this.#inputQueue,
      options: {
        cwd: opts.workdir,
        abortController: this.#abortController,
        // Explicit env allowlist — never inherit the daemon's full process.env
        // (which holds the root ZeroID key + control-channel secrets). See
        // buildAgentEnv (GHSA-38vh vector 3).
        //
        // The gateway credential is resolved HERE rather than at construction:
        // the session identity is registered on the first send
        // (`#ensureAgentIdentity`, gated on `!provider.hasQueried`), so it does
        // not exist when this provider is built — and reading it too early
        // would silently leave every call on the badge, which is the bug
        // (forge#111) rather than a partial fix for it.
        env: buildAgentEnv(process.env, {
          gatewayCredential: init.identityManager?.getGatewayCredential(init.sessionId),
        }),
        allowedTools: [
          // Every EXACT TOOL NAME here is auto-approved by the SDK BEFORE
          // canUseTool is consulted, so it never reaches our gate — the SDK
          // says so itself via CLAUDE_SDK_CAN_USE_TOOL_SHADOWED. Since
          // canUseTool is this provider's only tool_start emitter, each of
          // these would otherwise run completely invisibly. They are recorded
          // in #autoApprovedTools so the PreToolUse hook can emit their
          // tool_start instead.
          //
          // Bash allow-RULES (`Bash(cmd:*)`) are patterns, not tool names, and
          // are deliberately NOT recorded: Bash itself still goes through
          // canUseTool, which already emits for it.
          ...autoApprovedToolNames,
          // Verbatim grants for the shell substitutions our installed skills
          // declare — without these a headless session silently expands the
          // whole slash command to nothing. See skillCommandAllowRules.
          ...skillAllowRules,
        ],
        permissionMode: "default",
        includePartialMessages: true,
        persistSession: true,
        // `display` defaults to "omitted" on Opus 5 / 4.8 / 4.7, Sonnet 5, and
        // Fable 5 — which streams thinking blocks whose text is EMPTY. Codeoid
        // then committed them as a placeholder, so every reasoning block in the
        // UI expanded onto nothing (measured: 3,445 of 3,450 on one session).
        // "summarized" returns readable reasoning instead. It is free: display
        // controls visibility only, and thinking is billed identically either
        // way — the tokens were already spent, we just weren't being shown
        // anything for them. (The raw chain of thought is never exposed on any
        // model; this is a summary of it.)
        thinking: { type: "adaptive" as const, display: "summarized" as const },
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
        stderr: (data: string) => {
          process.stderr.write(`[claude-subprocess ${sessionId.slice(0, 8)}] ${data}`);
        },
        ...(mcpServers ? { mcpServers } : {}),
        // Any non-empty append (memory guidance, conductor contract) rides on
        // the claude_code preset — previously gated on memory alone, which
        // silently dropped non-memory appends.
        ...(init.memory || desiredAppend
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: desiredAppend,
              },
            }
          : {}),
        // Ambient-pack subagents → the SDK's programmatic `agents` option.
        // (Pack subagents live in the registry cache, not a `.claude/agents`
        // tier, so they're injected rather than discovered.)
        ...packAgentsOption(opts.subagents),
        ...sessionOpts,
        // Load BOTH the project tier (`<workdir>/.claude`) and the user tier
        // (`~/.claude`). A pack installs its runnable skills into
        // `~/.claude/skills/` (pack-service #linkSkills), so a project-only
        // source silently dropped them and `/spec`-style skill invocations came
        // back "Unknown command". `skills: "all"` then enables every discovered
        // skill for auto-selection + slash invocation. In the sandbox `~/.claude`
        // is codeoid-controlled; in local mode this also surfaces the user's own
        // skills, which is the intended behaviour.
        settingSources: ["project", "user"],
        skills: "all",
        // Permission to RUN a skill's command is not permission to READ the
        // files it touches — the two gates are independent and fail in that
        // order. See skillSandboxDirs.
        additionalDirectories: skillSandboxDirs([
          join(homedir(), ".claude", "skills"),
          join(opts.workdir, ".claude", "skills"),
        ]),

        hooks: {
          PreToolUse: [{
            hooks: [async (rawInput) => {
              const input = rawInput as PreToolUseHookInput;
              // Stand in for canUseTool on the tools the SDK pre-approved.
              // Those never reach the gate, and the gate is the only place this
              // provider emits tool_start — so without this every memory recall
              // and every conductor fleet read executed with no tool_call
              // message at all: absent from the transcript, absent from the UI,
              // and absent from the verbatim episode record that is the point
              // of capturing them. Confirmed on a live instance: 409 mcp.init
              // listings across 18 transcripts, and zero memory tool calls.
              //
              // Emitted ONLY for names in #autoApprovedTools, which is exactly
              // the set that skips canUseTool, so a tool can never be emitted
              // twice. tool_use_id is the SDK's own id, matching what
              // canUseTool would have used, so tool_complete correlates and
              // Session's own auto-approve (these are isSafeTool reads) keeps
              // them from prompting.
              if (this.#autoApprovedTools.has(input.tool_name)) {
                this.#emit({
                  type: "tool_start",
                  toolId: randomUUID(),
                  sdkToolUseId: input.tool_use_id,
                  name: input.tool_name,
                  input: (input.tool_input ?? {}) as Record<string, unknown>,
                  approvalId: randomUUID(),
                });
              }
              init.store.audit(
                this.#currentSender?.sub ?? "unknown",
                "session.tool_call",
                sessionId,
                `tool=${input.tool_name}`,
              );
              // Compression rewrite.
              if (init.config && init.compressionRegistry) {
                const rewritten = rewriteBashToolInput({
                  toolName: input.tool_name,
                  toolInput: (input.tool_input ?? {}) as Record<string, unknown>,
                  config: init.config,
                  registry: init.compressionRegistry,
                  workdir: opts.workdir,
                });
                if (rewritten) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      updatedInput: rewritten,
                    },
                  };
                }
              }
              return {};
            }],
          }],

          SubagentStart: [{
            hooks: [async (rawInput) => {
              const input = rawInput as SubagentStartHookInput;
              const agentId = input.agent_id ?? "unknown";
              const agentType = input.agent_type ?? "unknown";
              this.#emit({ type: "subagent_start", agentId, agentType });
              return {};
            }],
          }],

          SubagentStop: [{
            hooks: [async (rawInput) => {
              const input = rawInput as SubagentStopHookInput;
              this.#emit({ type: "subagent_stop", agentId: input.agent_id ?? "unknown" });
              return {};
            }],
          }],
        },

        canUseTool: async (toolName, input, options) => {
          const toolId = randomUUID();
          const approvalId = randomUUID();
          const inputObj = input as Record<string, unknown>;

          // Correlate by the SDK's own tool_use_id, passed directly to this
          // callback. Never reconstruct it from a PreToolUse-fed name-keyed
          // FIFO: the SDK skips canUseTool for auto-allowed tools
          // (allowedTools / project permissions.allow), so any allow rule
          // desyncs such a queue and mis-correlates every later tool call
          // in the session (issue #81).
          const sdkToolUseId = options?.toolUseID;
          if (!sdkToolUseId) {
            return { behavior: "deny" as const, message: "Unable to correlate tool use id" };
          }
          const sdkAgentId = options?.agentID;

          // Emit tool_start — Session creates the SessionMessage.
          this.#emit({
            type: "tool_start",
            toolId,
            sdkToolUseId,
            sdkAgentId,
            name: toolName,
            input: inputObj,
            approvalId,
          });

          // Call Session's approval gate (may block until user responds).
          const canUse = this.#currentCanUseTool;
          if (!canUse) return { behavior: "deny" as const, message: "provider not ready" };
          const result = await canUse(toolId, approvalId, toolName, inputObj);
          if (result.behavior === "allow") {
            return { behavior: "allow", updatedInput: result.updatedInput as Record<string, unknown> | undefined };
          }
          return { behavior: "deny", message: result.message ?? "Denied" };
        },
      },
    });

    this.#hasQueried = true;

    // Fetch the live model catalog best-effort.
    if (init.onModels) {
      void this.#query
        .supportedModels()
        .then((m) => init.onModels?.(m))
        .catch(() => {});
    }

    const query$ = this.#query;
    const ac = this.#abortController;
    const queue$ = this.#inputQueue;
    let recoverContent: string | null = null;
    let selfTask: Promise<void> | null = null;

    selfTask = this.#consumerTask = (async () => {
      try {
        for await (const msg of query$) {
          // Superseded by a rebuild: drop late translations instead of
          // emitting them into the NEW loop's turn queue.
          if (this.#loopGeneration !== myGeneration) break;
          this.#translateSDKMessage(msg);
        }
      } catch (err) {
        if (!ac.signal.aborted && this.#loopGeneration === myGeneration) {
          const emsg = err instanceof Error ? err.message : String(err);
          if (
            this.#hasQueried &&
            !this.#backingRecoveryAttempted &&
            this.#lastPushedContent !== null &&
            /No conversation found with session ID/i.test(emsg)
          ) {
            console.error(`[claude-provider ${sessionId.slice(0, 8)}] backing session missing — scheduling recovery`);
            recoverContent = this.#lastPushedContent;
          } else {
            console.error(`[claude-provider ${sessionId.slice(0, 8)}] SDK query failed: ${emsg}`);
            this.#emit({ type: "error", message: emsg });
          }
        }
      } finally {
        // Close the current turn queue — session's for-await loop will
        // finish. Generation-guarded: after a rebuild this queue belongs to
        // the NEW loop and closing it would instantly end the new turn.
        if (this.#loopGeneration === myGeneration) {
          this.#currentTurnQueue?.close();
          this.#currentTurnQueue = null;
        }

        if (this.#query === query$) this.#query = null;
        if (this.#abortController === ac) this.#abortController = null;
        queue$?.close();
        if (this.#inputQueue === queue$) this.#inputQueue = null;
        if (this.#consumerTask === selfTask) this.#consumerTask = null;
      }

      // Post-teardown recovery. Skipped for superseded loops — the rebuild
      // already owns the session's continuity.
      if (recoverContent !== null && this.#loopGeneration === myGeneration) {
        this.#backingRecoveryAttempted = true;
        this.onRecoveryNeeded?.(recoverContent);
      }
    })();
  }

  /** Push a ProviderEvent to the active per-turn queue. */
  #emit(event: ProviderEvent): void {
    const queue = this.#currentTurnQueue;
    if (queue) {
      try {
        queue.push(event);
        return;
      } catch (err) {
        this.#handleUndeliverable(event, err instanceof Error ? err.name : "unknown");
        return;
      }
    }
    this.#handleUndeliverable(event, "no-queue");
  }

  /**
   * A provider event had nowhere to go — the turn queue was closed (the
   * consumer finished and called endTurn), full, or already nulled after the
   * SDK loop ended.
   *
   * This used to be a bare `catch {}`, which is how the whole class of bugs
   * stayed invisible: a lost `subagent_stop` left its sub-agent dangling for the
   * life of the session (and its delegated ZeroID token live), and a lost
   * `tool_complete` stranded the status at `tool_running`, with nothing logged
   * to explain either.
   *
   * Id-keyed lifecycle events are buffered and replayed into the next turn's
   * queue, where their handlers are idempotent no-ops if the boundary sweep
   * already reconciled them. Everything else is logged only — replaying a stale
   * `turn_done` would end the next turn the instant it began, and stale text
   * would corrupt its transcript.
   */
  #handleUndeliverable(event: ProviderEvent, reason: string): void {
    const carryable = CARRYOVER_EVENT_TYPES.has(event.type);
    if (carryable && this.#carryover.length < MAX_CARRYOVER_EVENTS) {
      this.#carryover.push(event);
    }
    // One line per (loop generation, event type, reason): enough to diagnose a
    // recurring loss, not enough to flood a long session.
    const key = `${this.#loopGeneration}:${event.type}:${reason}`;
    if (this.#undeliverableLogged.has(key)) return;
    this.#undeliverableLogged.add(key);
    const disposition = carryable
      ? this.#carryover.length < MAX_CARRYOVER_EVENTS
        ? "buffered for the next turn"
        : "DROPPED (carryover full)"
      : "dropped";
    console.error(
      `[claude-provider ${this.#claudeCodeSessionId.slice(0, 8)}] "${event.type}" undeliverable (${reason}) — ${disposition}`,
    );
  }

  /**
   * Decide which skill-declared commands this query may run (#233).
   *
   * Only commands a human has already approved are granted. Anything new (or
   * changed — the key is the verbatim command) is NOT granted; an approval is
   * requested out-of-band and persisted, so it takes effect from the next turn.
   *
   * When a command is blocked, the turn PARKS (waiting_approval) rather than
   * failing: {@link #tryHandleSkillBlock} raises an approval and, once granted,
   * the loop rebuilds (grants are in the reuse guard) and the same prompt is
   * retried in place. Pure + side-effect-free so it is safe to call on every
   * warm-loop check.
   */
  #resolveSkillGrants(opts: TurnOpts): string[] {
    const declared = skillCommandAllowRules([
      join(homedir(), ".claude", "skills"),
      join(opts.workdir, ".claude", "skills"),
    ]);
    if (declared.length === 0) return [];
    const decided = this.#init.store.getSkillCommandGrants(this.#init.workspaceId);
    return declared.filter((rule) => decided.get(rule) === true);
  }

  /**
   * A zero-turn run was caused by a blocked skill command. Try to PARK the turn
   * for approval instead of failing it. Returns true if handled (caller then
   * suppresses the terminal error), false to fall through to the normal error.
   *
   * Demand-driven: we ask only for the command that actually blocked (parsed
   * from the stderr), never the whole declared set — one prompt tied to what
   * the user just ran, not 31 across their skills tree.
   *
   * Falls through (false → terminal error) when there is no dialog channel, or
   * when the blocked command is ALREADY granted — a granted command that still
   * blocks means the grant is not taking effect, and retrying would loop.
   */
  #tryHandleSkillBlock(stderr: string): boolean {
    const m = /pattern "!`([^`\n]+)`"/.exec(stderr);
    if (!m) return false;
    const command = m[1].trim();
    const rule = `Bash(${command})`;
    if (!this.#currentRequestUserInput) return false;
    const decided = this.#init.store.getSkillCommandGrants(this.#init.workspaceId);
    if (decided.get(rule) === true) return false; // granted yet blocked → don't loop

    // Park the turn (waiting_approval) — this does NOT end it. A duplicate
    // result for an already-pending command re-parks without re-asking.
    this.#emit({ type: "approval_pending", command });
    if (!this.#pendingSkillApprovals.has(rule)) {
      this.#pendingSkillApprovals.add(rule);
      void this.#approveAndRetry(command, rule);
    }
    return true;
  }

  /**
   * Await the human's decision on a parked skill command, then resolve the turn:
   * approve → persist + retry the same prompt in place; deny/cancel → fail the
   * turn cleanly with a reason.
   *
   * Raised through `requestUserInput`, NOT `canUseTool`, and deliberately not
   * keyed on session mode. Mode says how much you trust the AGENT's judgment;
   * this asks whether you trust code an installed PACK runs unconditionally,
   * fixed at install time and invisible in the tool stream. Those are
   * orthogonal — routing it through canUseTool meant `autonomous` auto-approved
   * it with no dialog, the exact silent-shell class this work closes.
   */
  async #approveAndRetry(command: string, rule: string): Promise<void> {
    const ask = this.#currentRequestUserInput;
    try {
      if (!ask) {
        this.#failSkillTurn(command, "no approval channel is attached");
        return;
      }
      const answer = await ask({
        method: "confirm",
        title: "Allow a command declared by an installed skill?",
        message: `A skill needs to run:\n\n    ${command}\n\nIt runs when the slash command expands, before the agent starts, so it never appears in the tool stream. Approve and I'll continue automatically; the choice is remembered for this workspace.`,
      });
      // `cancelled` = dismissal / timeout / interrupt / teardown — "no answer",
      // never consent. Persist nothing (so a real decision can still be made
      // later) but fail THIS turn, since a parked turn would otherwise hang.
      if (answer.cancelled) {
        this.#failSkillTurn(command, "the approval was dismissed");
        return;
      }
      const allowed = answer.confirmed === true;
      this.#init.store.setSkillCommandGrant(this.#init.workspaceId, rule, allowed);
      console.error(
        `[claude-provider ${this.#init.sessionId.slice(0, 8)}] skill command ${allowed ? "approved" : "denied"}: ${command.slice(0, 60)}`,
      );
      if (allowed) this.#retryAfterGrant();
      else this.#failSkillTurn(command, "you denied it");
    } catch (err) {
      this.#failSkillTurn(
        command,
        `approval failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.#pendingSkillApprovals.delete(rule);
    }
  }

  /**
   * Retry the parked prompt in place: rebuild the query loop (the changed grant
   * is in the reuse guard, so this re-reads it into allowedTools) and re-push
   * the same content into the SAME turn queue. From the session's view the one
   * turn simply resumes — no new run, no second consumer.
   */
  #retryAfterGrant(): void {
    if (!this.#lastTurnOpts || this.#lastPushedContent === null) {
      this.#failSkillTurn("", "internal: no prompt to retry");
      return;
    }
    this.#emit({ type: "custom_message", role: "info", content: "Approved — continuing…" });
    this.#ensureQueryLoop(this.#lastTurnOpts);
    this.#pushSDKMessage(this.#lastPushedContent, "later", true);
  }

  /** End a parked skill turn as a clean error (denied / dismissed / broken). */
  #failSkillTurn(command: string, reason: string): void {
    const detail = command ? `: ${command}` : "";
    this.#emit({
      type: "turn_done",
      result: {
        providerId: this.id,
        model: "unknown",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        durationMs: 0,
        isError: true,
        errorMessage: `Skill command not run — ${reason}${detail}`,
      },
    });
  }

  /** Translate one SDKMessage to ProviderEvents. */
  #translateSDKMessage(msg: SDKMessage): void {
    const m = msg as { type?: string; num_turns?: number };
    // A zero-turn caused by a blocked skill command is RECOVERABLE: park the
    // turn for approval instead of letting the pure translator turn it into a
    // terminal error. We intercept BEFORE translating and, when handled,
    // suppress the pure translation entirely (its only output for this result
    // would have been the turn_done error we are replacing). Clear the carried
    // stderr ourselves since the translator normally does that on a result.
    const stderr = this.#translateState.lastLocalCommandStderr;
    if (
      m.type === "result" &&
      m.num_turns === 0 &&
      stderr &&
      this.#tryHandleSkillBlock(stderr)
    ) {
      this.#translateState.lastLocalCommandStderr = null;
      return;
    }
    translateSDKMessage(msg, this.#emit.bind(this), this.id, this.#translateState, (e) => this.onSessionEvent?.(e));
  }
}

// ── Pure translation (exported for unit tests) ────────────────────────────────

/**
 * Cross-message carry-over for {@link translateSDKMessage}. The SDK reports a
 * failed slash-command expansion on one message and the resulting zero-turn
 * `result` on a later one, so the cause has to survive between calls. Owned by
 * the caller (one per session) to keep the translator itself free of module
 * state — two concurrent sessions never share a bag.
 */
export interface TranslateState {
  /** Last `<local-command-stderr>` seen since the previous result. */
  lastLocalCommandStderr: string | null;
}

/**
 * Translate one SDKMessage from the Claude Agent SDK into zero or more
 * ProviderEvents.  Pure function — no I/O, no side-effects beyond calling
 * `emit` and updating the caller-owned `state`.  Extracted so it can be
 * unit-tested without spawning the SDK.
 */
export function translateSDKMessage(
  msg: SDKMessage,
  emit: (event: ProviderEvent) => void,
  providerId: string,
  state: TranslateState = { lastLocalCommandStderr: null },
  /** Session-scoped emitter — background-task events go HERE, never through
   *  `emit`, because they can fire between turns when the turn queue has no
   *  reader and would drop them unread. */
  emitSession?: (event: SessionScopedEvent) => void,
): void {
    switch (msg.type) {
      case "assistant": {
        // Per-call LLM usage — split primary vs subagent for accurate ctx tracking.
        const assistantMsg = msg as unknown as {
          message: {
            content: unknown;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          parent_tool_use_id: string | null;
        };
        const perCall = assistantMsg.message?.usage;
        if (perCall) {
          const callUsage: LLMCallUsage = {
            inputTokens: perCall.input_tokens ?? 0,
            cacheReadTokens: perCall.cache_read_input_tokens ?? 0,
            cacheCreationTokens: perCall.cache_creation_input_tokens ?? 0,
            outputTokens: perCall.output_tokens ?? 0,
          };
          emit({ type: "llm_call", usage: callUsage, isPrimary: assistantMsg.parent_tool_use_id === null });
        }

        // Text content (tool_use blocks are handled via canUseTool → tool_start).
        // Tag with parent_tool_use_id so subagent text is never mistaken for
        // primary assistant output downstream (issue #82).
        const content = msg.message.content as unknown as Array<Record<string, unknown>>;
        const textParts: string[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text as string);
          }
        }
        if (textParts.length > 0) {
          emit({
            type: "text_done",
            content: textParts.join(""),
            parentToolUseId: assistantMsg.parent_tool_use_id ?? null,
          });
        }
        break;
      }

      case "stream_event": {
        const streamMsg = msg as {
          event?: {
            type?: string;
            index?: number;
            content_block?: { type?: string };
            delta?: { type?: string; text?: string; thinking?: string };
          };
          parent_tool_use_id?: string | null;
        };
        const event = streamMsg.event;
        if (!event) break;
        // Subagent stream events carry the spawning tool call's id — tag every
        // text/thinking emission so consumers can keep them out of the primary
        // conversation (issue #82).
        const parentToolUseId = streamMsg.parent_tool_use_id ?? null;

        if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          // Signal a new thinking block — Session creates the message.
          emit({ type: "thinking_delta", content: "", blockIndex: event.index, parentToolUseId });
          break;
        }

        if (event.type === "content_block_delta" && event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text) {
            emit({ type: "text_delta", content: event.delta.text, parentToolUseId });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({ type: "thinking_delta", content: event.delta.thinking, blockIndex: event.index, parentToolUseId });
          }
          break;
        }

        if (event.type === "content_block_stop") {
          emit({ type: "thinking_done", blockIndex: event.index, parentToolUseId });
        }
        break;
      }

      case "result": {
        const r = msg as {
          subtype?: string;
          is_error?: boolean;
          num_turns?: number;
          result?: string;
          stop_reason?: string | null;
          total_cost_usd?: number;
          duration_ms?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
        };
        // Derive the model from the first key in modelUsage (most-used model this turn).
        const model = Object.keys(r.modelUsage ?? {})[0] ?? "unknown";
        // A zero-turn run means the assistant never ran — the prompt was
        // consumed and discarded (blocked slash-command expansion, rejected
        // input). The SDK reports this as `subtype: "success", is_error: false`,
        // so without this check it surfaces as a silently empty turn and no
        // retry/error path ever fires. Never let that pass as success.
        const zeroTurn = r.num_turns === 0;
        const zeroTurnError = zeroTurn
          ? `The agent produced no turn — the prompt was consumed without running. ${
              state.lastLocalCommandStderr ??
              "No cause was reported by the backend (check for a blocked slash-command expansion or rejected input)."
            }`
          : undefined;
        state.lastLocalCommandStderr = null;
        const normalized: NormalizedTurnResult = {
          providerId,
          model,
          inputTokens: r.usage?.input_tokens ?? 0,
          outputTokens: r.usage?.output_tokens ?? 0,
          cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
          totalCostUsd: r.total_cost_usd ?? 0,
          durationMs: r.duration_ms ?? 0,
          stopReason: r.stop_reason ?? undefined,
          // Preserve `undefined` when the SDK didn't report — only force true.
          isError: zeroTurn ? true : r.is_error,
          errorMessage:
            zeroTurnError ?? (r.subtype !== "success" && r.result ? r.result : undefined),
        };
        emit({ type: "turn_done", result: normalized });
        // Stay warm — keep the queue open for the next turn.
        // The queue is closed in the consumer's finally block when the SDK loop ends.
        break;
      }

      case "system": {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === "init") {
          const init = msg as { mcp_servers?: { name: string; status: string }[]; tools?: string[] };
          const servers: Record<string, string> = {};
          const tools: Record<string, string[]> = {};
          for (const s of init.mcp_servers ?? []) {
            servers[s.name] = s.status;
            tools[s.name] = [];
          }
          for (const t of init.tools ?? []) {
            if (!t.startsWith("mcp__")) continue;
            const rest = t.slice("mcp__".length);
            const sep = rest.indexOf("__");
            if (sep <= 0) continue;
            const server = rest.slice(0, sep);
            tools[server] ??= [];
            tools[server].push(t);
          }
          emit({ type: "mcp_init", servers, tools });
        } else if (subtype === "api_retry") {
          const r = msg as { attempt?: number; retry_delay_ms?: number; error_status?: number | null };
          emit({ type: "api_retry", attempt: r.attempt, retryDelayMs: r.retry_delay_ms, errorStatus: r.error_status });
        } else if (subtype === "background_tasks_changed") {
          // Level signal: the FULL live set after any membership change,
          // REPLACE semantics (the SDK's own recommendation — a missed edge
          // cannot wedge a stale indicator). Session-scoped, so it goes to the
          // session listener, never the turn queue: it can fire between turns,
          // when the queue has no reader and would drop it unread.
          const r = msg as {
            tasks?: Array<{ task_id?: string; task_type?: string; description?: string; status?: string }>;
          };
          emitSession?.({
            type: "background_tasks",
            tasks: (r.tasks ?? [])
              .filter((t) => typeof t.task_id === "string")
              .map((t) => ({
                id: t.task_id as string,
                kind: t.task_type ?? "task",
                description: t.description ?? "",
                status: t.status ?? "running",
              })),
          });
        } else if (subtype === "task_notification") {
          // Edge signal: one task settled, with the outcome digest. This is
          // the event a session must be WOKEN with — it routinely arrives
          // after turn_done (the model deferred the work past its own turn),
          // which is exactly when the turn queue is closed. Observed live: a
          // session promised "I'll report when the three agents land" and the
          // landings were discarded unread.
          const r = msg as { task_id?: string; status?: string; summary?: string };
          if (typeof r.task_id === "string") {
            const status =
              r.status === "failed" || r.status === "stopped" ? r.status : "completed";
            emitSession?.({
              type: "background_task_settled",
              taskId: r.task_id,
              status,
              summary: r.summary ?? "(no summary reported)",
            });
          }
        }
        break;
      }

      case "user": {
        const content = (msg.message as { content?: unknown }).content;
        // Slash-command expansion failures arrive as a synthetic string-content
        // user message, NOT as an error. Stash it so a resulting zero-turn run
        // can report the real cause instead of "no assistant turn ran".
        if (typeof content === "string" && content.includes("<local-command-stderr>")) {
          state.lastLocalCommandStderr = content
            .replace(/<\/?local-command-stderr>/g, "")
            .trim();
          break;
        }
        // tool_result blocks — close the matching tool call with real output.
        if (!Array.isArray(content)) break;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== "tool_result") continue;
          const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
          if (!useId) continue;
          const output = extractToolResultText(block.content);
          const success = block.is_error !== true;
          emit({ type: "tool_complete", sdkToolUseId: useId, output, success });
        }
        break;
      }

      case "tool_progress": {
        const p = msg as { tool_name?: string; elapsed_time_seconds?: number };
        emit({ type: "tool_progress", toolName: p.tool_name, elapsedSeconds: p.elapsed_time_seconds });
        break;
      }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Absolute directories the agent must be able to READ for skills to work,
 * beyond `cwd`.
 *
 * Running a skill's command and reading the files that command touches are two
 * independent gates, and they fail in that order — which is why this looked
 * unnecessary at first. Once skillCommandAllowRules got a command past the
 * permission gate, the next failure was the sandbox:
 *
 *   cat in '~/.codeoid/packs/ai-factory/skills/templates/requirement-template.md'
 *   was blocked. For security, Claude Code may only concatenate files from the
 *   allowed working directories for this session: '/…/highflame-zeroid'
 *
 * A pack installs skills as SYMLINKS (`~/.claude/skills/spec` →
 * `~/.codeoid/packs/<pack>/skills/spec`), and a skill's substitutions commonly
 * read a sibling in its own tree (`templates/`, `partials/`). The sandbox check
 * sees the RESOLVED real path, which lives outside the workdir, and denies it.
 * `settingSources: ["user"]` makes the SDK *discover* those skills, but
 * discovery is not access.
 *
 * The failure is silent and total: one blocked read aborts the WHOLE
 * slash-command expansion — a `|| fallback` in the same substitution does not
 * rescue it — so the turn never runs (#232 is the backstop that makes it
 * visible).
 *
 * Scope is deliberately tight: each skill's PARENT (the `…/skills` root holding
 * `templates/` and `partials/`), never the whole repo or pack it is symlinked
 * out of.
 */
export function skillSandboxDirs(skillsDirs: string[]): string[] {
  const dirs = new Set<string>();
  for (const skillsDir of skillsDirs) {
    let entries: string[];
    try {
      entries = readdirSync(skillsDir);
    } catch {
      continue; // tier not installed — nothing to widen
    }
    // The dir itself: covers non-symlinked skills and `<skillsDir>/templates`.
    try {
      dirs.add(realpathSync(skillsDir));
    } catch {
      /* unreadable — skip */
    }
    for (const name of entries) {
      try {
        // realpath resolves the pack symlink to its true location; the parent
        // is the `…/skills` root the sibling templates/partials live under.
        dirs.add(dirname(realpathSync(join(skillsDir, name))));
      } catch {
        /* dangling symlink or race — skip, never fail the turn */
      }
    }
  }
  return [...dirs];
}

/**
 * Verbatim `Bash(…)` allow rules for every shell substitution the installed
 * skills declare (#233).
 *
 * A `SKILL.md` may contain `` !`…` `` substitutions that run at slash-command
 * EXPANSION time — before the agent loop starts — to inject content into the
 * prompt. That phase has no approval path in a headless session: `canUseTool`
 * is not consulted pre-loop and there is no human at a terminal, so anything
 * not pre-allowed is hard-denied. One denial aborts the WHOLE expansion, and
 * the prompt is then consumed with nothing to run — which the SDK reports as
 * `subtype: "success", num_turns: 0` (#232). Silent and total.
 *
 * `options.allowedTools` governs that expansion-time check, so granting the
 * exact commands here fixes it in code — no mutation of the user's repo, no
 * asking anyone to hand-edit `.claude/settings.json`. (Note that a rule in
 * `settings.local.json` is silently ignored for this check; only
 * `settings.json` is read. Another reason to do it in code.)
 *
 * Rules are emitted VERBATIM — no wildcards, no prefix grants. Measured
 * behaviour: the checker splits compound commands and requires every part
 * allowed, OR one exact rule covering the whole string. The exact rule is
 * strictly least-privilege, so we use it: a skill gets the one command line it
 * declared and nothing else. Recomputed per query, so editing a skill can
 * never leave a stale grant behind.
 */
export function skillCommandAllowRules(skillsDirs: string[]): string[] {
  const rules = new Set<string>();
  for (const dir of skillsDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // tier not present (no user skills, or project has no .claude/skills)
    }
    for (const name of entries) {
      let md: string;
      try {
        md = readFileSync(join(dir, name, "SKILL.md"), "utf8");
      } catch {
        continue; // not a skill dir, dangling symlink, or unreadable — never fail the turn
      }
      // `!`<command>`` — a command containing a backtick can't be expressed in
      // this syntax, so `[^`]` is exact. Excluding \n matters: prose like
      // "…fails!`code`" would otherwise swallow everything up to the next
      // backtick ANYWHERE later in the file, turning paragraphs into "commands".
      for (const [, cmd] of md.matchAll(/!`([^`\n]+)`/g)) {
        const trimmed = cmd.trim();
        if (!trimmed) continue;
        // Prose that documents the `!` character itself (e.g. "the `!` suffix,
        // `x`") parses as a substitution. Require the first token to look like
        // an executable name so we grant less, not more. Under-granting is the
        // safe direction: it fails loudly via the zero-turn backstop (#232),
        // whereas an over-grant silently pre-approves a command for in-loop use.
        // `=` is allowed so an env-prefixed command (`FOO=1 ./run.sh`) — whose
        // first token is the assignment — isn't filtered out, which would leave
        // an approved grant permanently un-derivable and fail its retry.
        const argv0 = trimmed.split(/\s+/)[0] ?? "";
        if (!/^[A-Za-z0-9_./~=-]+$/.test(argv0)) continue;
        rules.add(`Bash(${trimmed})`);
      }
    }
  }
  return [...rules];
}

/**
 * Apply a per-call wall-clock `timeout` (ms) to external MCP servers so a hung
 * tool call (e.g. an unresponsive HTTP gateway) returns an SDK error instead of
 * silently stalling the turn. Only sets it when `ms > 0` and the server hasn't
 * already declared its own `timeout`, so explicit per-server values still win.
 * `timeout` is valid on every external (stdio/http/sse) McpServerConfig variant;
 * these all come from JSON, so we re-cast at the same boundary parseMcpServerConfig uses.
 */
export function withMcpToolTimeout(
  servers: Record<string, McpServerConfig>,
  ms: number,
): Record<string, McpServerConfig> {
  if (ms <= 0) return servers;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const obj = cfg as unknown as Record<string, unknown>;
    out[name] =
      typeof obj.timeout === "number"
        ? cfg
        : ({ ...obj, timeout: ms } as unknown as McpServerConfig);
  }
  return out;
}

/** Registry servers (external, non-builtin) for the claude backend as SDK
 *  McpServerConfigs — a native mount, since claude's SDK owns its MCP client.
 *  `${VAR}` env refs and a `bearerTokenEnv` are resolved against the daemon env
 *  here so secrets never live in config; tool calls gate via canUseTool. */
export function registryServersForClaude(registry: McpRegistry | undefined): Record<string, McpServerConfig> {
  if (!registry) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const spec of registry.forBackend("claude")) {
    if (spec.builtin) continue;
    const t = spec.transport;
    if (t.kind === "stdio") {
      out[spec.name] = {
        command: t.command,
        args: t.args,
        env: resolveEnvMap(t.env ?? {}, process.env),
      } as unknown as McpServerConfig;
    } else if (t.kind === "http") {
      const headers: Record<string, string> = { ...t.headers };
      if (t.bearerTokenEnv) {
        const tok = process.env[t.bearerTokenEnv];
        if (tok) headers.Authorization = `Bearer ${tok}`;
      }
      out[spec.name] = { type: "http", url: t.url, headers } as unknown as McpServerConfig;
    }
  }
  return out;
}

function loadUserMcpServers(workdir: string): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(join(homedir(), ".claude.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const cfg = parsed as Record<string, unknown>;
    const result: Record<string, McpServerConfig> = {};
    for (const [k, v] of Object.entries(safeServerMap(cfg.mcpServers))) result[k] = v;
    for (const [k, v] of Object.entries(safeServerMap(safeProjectServers(cfg.projects, workdir)))) result[k] = v;
    return result;
  } catch {
    return {};
  }
}

function safeProjectServers(projects: unknown, workdir: string): unknown {
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return undefined;
  const project = (projects as Record<string, unknown>)[workdir];
  if (typeof project !== "object" || project === null || Array.isArray(project)) return undefined;
  return (project as Record<string, unknown>).mcpServers;
}

function safeServerMap(raw: unknown): Record<string, McpServerConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, McpServerConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const server = parseMcpServerConfig(value);
    if (server) result[key] = server;
  }
  return result;
}

export function parseMcpServerConfig(value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.command !== "string" && typeof obj.url !== "string") return null;
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) return null;
  }
  if (obj.env !== undefined) {
    if (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env)) return null;
    if (!Object.values(obj.env as Record<string, unknown>).every((v) => typeof v === "string")) return null;
  }
  return obj as unknown as McpServerConfig;
}

/**
 * Build the environment handed to the spawned Claude Code subprocess.
 *
 * SECURITY (GHSA-38vh vector 3): the SDK `query()` is otherwise spawned with no
 * `env`, so the CLI — and its Bash tool, hooks, and stdio MCP servers — inherit
 * the daemon's FULL `process.env`, including secrets `loadDotEnv` writes there
 * (`TELEGRAM_BOT_TOKEN`, `CODEOID_API_KEY` = the root ZeroID key, provider keys,
 * `GOOGLE_CLIENT_SECRET`). Any attached user or prompt-injected agent could
 * `env` its way to the control-channel token. We pass an explicit ALLOWLIST
 * instead: only the vars the CLI legitimately needs to run and authenticate.
 *
 * Allowlisted: system/runtime essentials (PATH, HOME, locale, TMPDIR, proxy +
 * TLS trust), plus every `ANTHROPIC_*` / `CLAUDE_*` var (the CLI's own auth +
 * config namespace). Deployments on a non-Anthropic model backend (Bedrock /
 * Vertex) can extend the allowlist via `CODEOID_AGENT_ENV_ALLOW` (comma-
 * separated names) without reopening the hole for unrelated secrets.
 *
 * `gatewayCredential` re-points a Highflame-gateway launch at the session's own
 * identity instead of the sandbox badge Forge wired in (forge#111) — see
 * `withGatewayCredential`, which is a no-op on every other deployment.
 *
 * Pure + exported for unit testing.
 */
export function buildAgentEnv(
  base: Record<string, string | undefined> = process.env,
  opts: { gatewayCredential?: string } = {},
): Record<string, string> {
  // The CLI's own namespaces (auth token, base url, model, feature flags)
  // plus POSIX locale categories (LC_ALL, LC_CTYPE, …). Shared basics +
  // CODEOID_AGENT_ENV_ALLOW come from buildSubprocessEnv.
  const env = buildSubprocessEnv({ prefixes: ["ANTHROPIC_", "CLAUDE_", "LC_"] }, base);
  return withGatewayCredential(env, opts.gatewayCredential);
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    } else if (typeof block.text === "string") {
      parts.push(block.text as string);
    }
  }
  return parts.join("\n");
}
