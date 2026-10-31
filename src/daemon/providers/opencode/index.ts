/**
 * OpencodeProvider — opencode 2.x as a codeoid backend (#447).
 *
 * opencode runs as one private server per daemon (server.ts), shared by
 * every opencode session; each codeoid session maps to one opencode session
 * in the session's workdir, whose `ses_…` id is the backing id (persisted,
 * resumed by reusing it).
 *
 *   - events: the server's live feed, which carries the session's durable
 *     events too (each with its `durable.seq`): text and reasoning blocks
 *     (`text_done` / `thinking_done`), tool calls and results, steps with cost
 *     and tokens (`llm_call`, summed into `turn_done`), retries, executions
 *     (turn ends), and the ephemeral ones: deltas, `permission.asked`, forms,
 *     the session's running total (`usage.updated`, which also bills the
 *     title opencode generates), and the child sessions subagents run in.
 *     opencode 2.2's durable log endpoint replays nothing and follows nothing
 *     (checked on 2.2.2 and 2.2.5), so it isn't read; a gap in the feed is
 *     made good from the session's messages when it reconnects (#reconcile).
 *   - approvals: every `permission.asked` goes through codeoid's gate under
 *     codeoid's tool names (translate.ts); the reply is `once` or `reject`
 *     (with the gate's message, so the model carries on), never `always`.
 *     Anything that can't be shown is rejected without asking, and a request
 *     pending when the server goes away counts as rejected.
 *   - turns: a prompt is fire-and-forget; the turn ends when the execution
 *     it started (or steered into) ends. A message sent mid-turn steers the
 *     running execution (`delivery: "steer"`; `later` queues). An execution
 *     opencode starts by itself (a background subagent finishing) is handed
 *     to the session as `turn_started`.
 *   - models: `provider/model` ids from `GET /api/model`, reasoning variants
 *     as efforts, switched on the session before a prompt when they change.
 *   - fork: opencode's own fork at the turn's last assistant message
 *     (`nativeRef`), else the transcript seed. codeoid's checkpoints stay
 *     authoritative for files.
 */

import { AsyncQueue } from "../../async-queue.js";
import type { Store } from "../../store.js";
import type { McpTenant } from "../../mcp/oauth.js";
import type { McpServerView } from "../../mcp/registry.js";
import { resolveEnvMap } from "../../mcp/types.js";
import { McpProxyLease, type McpProxyMount } from "../../mcp/proxy.js";
import { MEMORY_MCP_SERVER_NAME, type MemoryMcpMount } from "../../memory/mcp-http.js";
import { BLACKBOARD_MCP_SERVER_NAME } from "../../blackboard/mcp-http.js";
import type { EffortLevel, ProviderCommand } from "../../../protocol/types.js";
import { renderHistorySeed, type CanonicalTurn, type HistorySeedResult } from "../canonical.js";
import {
  BUDGET_STOP_MESSAGE,
  type BackgroundLifecycleEvent,
  type CatalogEntry,
  type ModelInfo,
  type NativeContinuationRequest,
  type NativeContinuationResult,
  type NormalizedTurnResult,
  type ProviderEvent,
  type SessionProvider,
  type ToolApprovalFn,
  type TurnOpts,
  type TurnRun,
  type UiRequestFn,
  isBackgroundLifecycleEvent,
} from "../interface.js";
import type { AuthContext } from "../../../protocol/types.js";
import {
  OpencodeHttpError,
  type OcError,
  type OcEvent,
  type OcForm,
  type OcFormField,
  type OcFormValue,
  type OcModelInfo,
  type OcMessage,
  type OcModelRef,
  type OcPermissionRequest,
  type OcSessionInfo,
  type OcTokenUsage,
} from "./client.js";
import { mcpNamespace, ownMountPrefix, sessionRules } from "./policy.js";
import type { OpencodeConnection, OpencodeServer } from "./server.js";
import {
  type OcToolCall,
  describeError,
  effortsOf,
  errorDetail,
  gateCallFor,
  modelValue,
  parseModelValue,
  toolOutputText,
  variantForEffort,
} from "./translate.js";

export const OPENCODE_PROVIDER_ID = "opencode";
export const OPENCODE_DISPLAY_NAME = "opencode";

/** Key of the synthetic message that carries the session's instructions. */
const INSTRUCTIONS_DESCRIPTION = "codeoid session instructions";
/** How long a permission request waits for the tool call it names to show up. */
const CALL_WAIT_MS = 2_000;
/** After an interrupt, how long to wait for opencode to report the execution ended. */
const INTERRUPT_SETTLE_MS = 5_000;
/** After a slash command, how long to wait for it to start an execution. */
const COMMAND_START_MS = 1_500;
/** A turn's messages read back after a feed gap — far more than one turn writes. */
const RECONCILE_PAGES = 20;
/** Ids remembered across turns (settled calls, counted steps): far more than a feed can lag by. */
const REMEMBERED = 4_096;
/**
 * Tools opencode runs without a permission request of their own. Code Mode
 * (`execute`) runs a script whose every external effect asks by itself (its
 * `fetch` asks `webfetch`); the call is shown, its asks are gated one by one.
 */
const UNASKED_TOOLS: Record<string, string> = { execute: "opencode_execute" };

export interface OpencodeProviderInit {
  sessionId: string;
  /** `ses_…` from a previous run, or the codeoid session id on first run. */
  initialBackingId: string;
  /** The daemon's shared opencode server. */
  server: OpencodeServer;
  store: Store;
  /** Tenant-scoped memory workspace id — the scope a mounted memory token binds to. */
  workspaceId?: string;
  tenant?: McpTenant;
  memoryMcp?: MemoryMcpMount;
  mcpProxy?: McpProxyMount;
  blackboardMcp?: () => { url: string; token: string } | undefined;
  mcpRegistry?: McpServerView;
  onModels?: (models: ReadonlyArray<CatalogEntry>) => void;
  /** opencode agent the session runs (`providers.opencode.agent`); absent = opencode's default. */
  agent?: string;
}

interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addTokens(u: Usage, t: OcTokenUsage | undefined, cost: number | undefined): void {
  if (t) {
    u.input += t.input || 0;
    u.output += t.output || 0;
    u.reasoning += t.reasoning || 0;
    u.cacheRead += t.cache?.read || 0;
    u.cacheWrite += t.cache?.write || 0;
  }
  if (typeof cost === "number" && Number.isFinite(cost)) u.cost += cost;
}

function addUsage(into: Usage, from: Usage): void {
  for (const k of Object.keys(into) as Array<keyof Usage>) into[k] += from[k];
}

interface Gate {
  canUseTool: ToolApprovalFn | null;
  requestUserInput: UiRequestFn | undefined;
  sender?: AuthContext;
}

interface Turn {
  queue: AsyncQueue<ProviderEvent>;
  gate: Gate;
  startedAt: number;
  model: string;
  /** The execution this turn waits on has started (or its input was delivered into one). */
  started: boolean;
  /** Mid-turn steers still owed their intermediate `turn_done` (Session absorbs one per now/next push). */
  owed: number;
  /** Inbox ids of those steers, to pay at their delivery. */
  steers: Set<string>;
  /** Inbox ids of messages queued behind the turn (`later`) and not delivered yet. */
  queued: Set<string>;
  /** Steers Session counted that opencode never took (the request failed): paid just before the turn's last `turn_done`. */
  unpaid: number;
  /**
   * The turn's own prompt (or command) was posted, or never will be. A
   * message pushed mid-turn waits for it: sent first, a steer would start an
   * execution of its own on the idle session, the turn would end on it, and
   * the prompt would never go out.
   */
  posted: Promise<void>;
  markPosted: () => void;
  /**
   * What the execution's end waits for: steer requests not answered yet
   * (opencode can take one before codeoid learns its id), and read-backs of
   * what a feed gap swallowed.
   */
  settling: Set<Promise<void>>;
  /** Inbox ids opencode delivered while this turn ran. */
  delivered: Set<string>;
  /** Executions started in this turn: an end decided late is moot once another began. */
  executions: number;
  usage: Usage;
  /** The user message this turn's prompt became (`prompt`'s inbox id), where its messages start. */
  promptId?: string;
  lastAssistantMessageID?: string;
  contextWindow?: number;
  stepError?: OcError;
  finish?: string;
  budgetStopped: boolean;
  interrupted: boolean;
  /** A turn opencode started by itself (`turn_started`). */
  adopted: boolean;
}

interface Child {
  agentType: string;
  title: string;
  background: boolean;
  running: boolean;
}

interface PendingAsk {
  sessionID: string;
  toolId: string;
  abort: AbortController;
  /** Made from inside a Code Mode script: no tool result of its own will settle it. */
  nested: boolean;
}

function eventSession(event: OcEvent): string | undefined {
  const data = event.data ?? {};
  if (typeof data.sessionID === "string") return data.sessionID;
  const form = data.form as { sessionID?: unknown } | undefined;
  return typeof form?.sessionID === "string" ? form.sessionID : undefined;
}

export class OpencodeProvider implements SessionProvider {
  readonly id = OPENCODE_PROVIDER_ID;
  readonly displayName = OPENCODE_DISPLAY_NAME;
  /** opencode's reply carries only a decision: it runs the input it proposed (#367). */
  readonly appliesToolInputRewrite = false;
  /** A background subagent's result is handed to the model by opencode, which then runs the main agent itself. */
  readonly continuesAfterBackgroundWork = true;
  readonly effortChange = "turn" as const;

  onRecoveryNeeded: ((content: string) => void) | undefined;
  onHistoryLost: (() => void) | undefined;
  onSessionEvent: SessionProvider["onSessionEvent"];

  readonly #sessionId: string;
  readonly #server: OpencodeServer;
  readonly #store: Store;
  readonly #workspaceId: string;
  readonly #memoryMcp: MemoryMcpMount | null;
  readonly #blackboardMcp: (() => { url: string; token: string } | undefined) | null;
  readonly #mcpRegistry: McpServerView | null;
  readonly #proxy: McpProxyLease;
  readonly #onModels: OpencodeProviderInit["onModels"];
  readonly #agent: string | undefined;

  #backingSessionId: string;
  #hasQueried = false;
  #pendingHistorySeed: string | null = null;
  /** A native fork to make when the session is first attached (#387). */
  #pendingNative: { source: string; after: string; fallback: string | null } | null = null;

  // Attachment to the running server.
  #conn: OpencodeConnection | null = null;
  #unlisten: (() => void) | null = null;
  /** The opencode session this provider drives, once attached. */
  #ses: string | null = null;
  #workdir: string | null = null;
  /** The last durable seq of this session seen on the feed (duplicates and stale replays are dropped). */
  #seq = -1;
  /**
   * The session's spend as codeoid has counted it: its total when attached,
   * plus every step since. opencode's own running total (`usage.updated`)
   * past this is spend no step reported — the title it generates — and is
   * added to the turn.
   */
  #counted = emptyUsage();
  /** True between an execution's start and end. */
  #executing = false;
  /** `generation:directory` the MCP mounts were done for. */
  #mountedFor: string | null = null;
  /** Normalized mount name → codeoid's server name, for this session's mounts. */
  #mounts = new Map<string, string>();
  #memoryToken: string | null = null;
  /** The model ref + variant last switched to on this opencode session. */
  #appliedSelection: string | null = null;
  #agentApplied = false;
  #sentInstructions: string | null = null;
  /** The model the opencode session runs, from its info or its last step. */
  #sessionModel: OcModelRef | null = null;
  #models: OcModelInfo[] = [];
  #modelsReported = false;
  #commands: ProviderCommand[] = [];
  #skills = new Map<string, string>();

  // Turn state.
  #turn: Turn | null = null;
  /** Gate of the last prompted turn — answers background subagents' requests between turns. */
  #lastGate: Gate | null = null;
  /** Spend reported outside any turn (a failed turn, a background child), added to the next turn_done. */
  #carry = emptyUsage();
  /** Spend since this provider's first turn, against `maxBudgetUsd`. */
  #spentUsd = 0;
  #maxBudgetUsd: number | undefined;

  // Per-call bookkeeping, keyed `${sessionID}:${toolCallID}`.
  #toolCalls = new Map<string, OcToolCall>();
  #callWaiters = new Map<string, Array<() => void>>();
  #announced = new Set<string>();
  #declined = new Set<string>();
  /**
   * Calls whose card was settled: a result read back after a feed gap can be
   * delivered again by a feed that's behind, and must not count as one that
   * ran unasked. Kept across turns (the late copy can land in the next one), bounded.
   */
  #settledCalls = new Set<string>();
  #handledAsks = new Set<string>();
  #pendingAsks = new Map<string, PendingAsk>();
  #handledForms = new Set<string>();
  /** Text/reasoning blocks already ended (their late deltas are ignored). */
  #endedBlocks = new Set<string>();
  /** Reasoning blocks some of whose deltas were shown. */
  #streamedBlocks = new Set<string>();
  /** Assistant messages whose step was counted (from the feed, or read back after a gap): never twice. */
  #countedSteps = new Set<string>();
  /** Assistant messages read back after a gap while still being written: read again when their step ends. */
  #streamingReadBack = new Set<string>();
  #blockIndex = new Map<string, number>();
  #children = new Map<string, Child>();

  constructor(init: OpencodeProviderInit) {
    this.#sessionId = init.sessionId;
    this.#backingSessionId = init.initialBackingId;
    this.#server = init.server;
    this.#store = init.store;
    this.#workspaceId = init.workspaceId ?? init.sessionId;
    this.#memoryMcp = init.memoryMcp ?? null;
    this.#blackboardMcp = init.blackboardMcp ?? null;
    this.#mcpRegistry = init.mcpRegistry ?? null;
    this.#onModels = init.onModels;
    this.#agent = init.agent;
    this.#proxy = new McpProxyLease(
      init.mcpProxy,
      init.tenant ? { tenant: init.tenant, sessionId: init.sessionId, backendId: this.id } : null,
    );
  }

  /** The memory endpoint is mounted on this session's opencode location (#ensureMounts). */
  get supportsMemoryTools(): boolean {
    return this.#memoryMcp != null;
  }

  get backingSessionId(): string {
    return this.#backingSessionId;
  }

  get hasQueried(): boolean {
    return this.#hasQueried;
  }

  get queuedMessages(): number {
    return 0;
  }

  /** opencode's own default is the model's base request, no variant: nothing codeoid can name. */
  get defaultEffort(): EffortLevel | null {
    return null;
  }

  get runningModel(): string | null {
    return this.#sessionModel ? modelValue(this.#sessionModel) : null;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  resetToNewSession(newBackingId: string): void {
    // A fresh backing session starts from nothing: a seed queued for the
    // previous one (a backend switch, a rewind) must not ride along (#355).
    this.#pendingHistorySeed = null;
    this.#pendingNative = null;
    this.#detachSession();
    this.#backingSessionId = newBackingId;
    this.#hasQueried = false;
  }

  seedFromHistory(history: readonly CanonicalTurn[], opts?: { maxChars?: number }): HistorySeedResult {
    const seed = renderHistorySeed(history, { maxChars: opts?.maxChars });
    this.#pendingHistorySeed = seed.text.length > 0 ? seed.text : null;
    return seed;
  }

  seedText(block: string): void {
    this.#pendingHistorySeed = block.length > 0 ? block : null;
  }

  /**
   * Continue a conversation natively (#387): fork opencode's own session at
   * the recorded turn. Applied when the session is first attached; if the
   * fork fails then, the turn says so and falls back to the transcript.
   * There is no native-history path (opencode's import is experimental and
   * per-message): another backend's history goes by transcript.
   */
  async continueNatively(req: NativeContinuationRequest): Promise<NativeContinuationResult | null> {
    if (!req.forkFrom) return null;
    const fallback = renderHistorySeed(req.history, { maxChars: req.maxChars }).text || null;
    this.#pendingHistorySeed = null;
    this.#pendingNative = { source: req.forkFrom.backingId, after: req.forkFrom.ref, fallback };
    return { via: "fork" };
  }

  // ── Turns ─────────────────────────────────────────────────────────────

  runTurn(opts: TurnOpts): TurnRun {
    // A turn opencode started by itself, still open: the prompt steers into
    // its execution, whose remaining events are this turn's. (A prompted one
    // still open had its reader leave — a stall recovery: nobody reads it.)
    const prior = this.#turn;
    if (prior) this.#closeTurn(prior, prior.adopted ? "superseded" : "replaced");
    let markPosted = () => {};
    const posted = new Promise<void>((resolve) => {
      markPosted = resolve;
    });
    const turn: Turn = {
      queue: new AsyncQueue<ProviderEvent>({ maxBuffered: 20_000 }),
      gate: { canUseTool: opts.canUseTool, requestUserInput: opts.requestUserInput, sender: opts.sender },
      startedAt: Date.now(),
      model: opts.model ?? this.runningModel ?? OPENCODE_PROVIDER_ID,
      started: false,
      owed: 0,
      steers: new Set(),
      queued: new Set(),
      unpaid: 0,
      posted,
      markPosted,
      settling: new Set(),
      delivered: new Set(),
      executions: 0,
      usage: emptyUsage(),
      budgetStopped: false,
      interrupted: false,
      adopted: false,
    };
    this.#turn = turn;
    this.#lastGate = turn.gate;
    this.#maxBudgetUsd = opts.maxBudgetUsd;
    this.#hasQueried = true;
    // Per-block state is a turn's: a late delta of an earlier turn has no reader anyway.
    this.#endedBlocks.clear();
    this.#streamedBlocks.clear();
    this.#blockIndex.clear();
    this.#countedSteps.clear();
    this.#streamingReadBack.clear();

    void this.#startTurn(turn, opts).catch((err: unknown) => {
      this.#failTurn(turn, `opencode: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.#runFor(turn);
  }

  #runFor(turn: Turn): TurnRun {
    return {
      events: turn.queue,
      interrupt: () => this.#interrupt(turn),
      pushMidTurn: (content, priority) => {
        void this.#push(turn, content, priority).catch((err: unknown) => {
          console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] mid-turn message failed: ${err instanceof Error ? err.message : String(err)}`);
          this.#emitTo(turn, {
            type: "custom_message",
            content: "⚠️ opencode didn't take the message sent mid-turn.",
            metadata: { event: "opencode.steer_failed" },
          });
        });
      },
      endTurn: () => {
        if (this.#turn === turn && turn.queue.closed) this.#turn = null;
      },
      bindGate: (gate) => {
        turn.gate = { canUseTool: gate.canUseTool, requestUserInput: gate.requestUserInput, sender: gate.sender };
        this.#lastGate = turn.gate;
      },
    };
  }

  async #startTurn(turn: Turn, opts: TurnOpts): Promise<void> {
    // Replaced, or interrupted before anything was posted: nothing more goes
    // out. (#interrupt ends a turn that started nothing; a prompt posted after
    // it would run anyway, adopted as a turn of its own.)
    const stale = () => this.#turn !== turn || turn.interrupted;
    try {
      const conn = await this.#server.ensure();
      if (stale()) return;
      try {
        await this.#post(conn, turn, opts, stale);
      } catch (err) {
        if (!sessionGone(err) || stale()) throw err;
        // Deleted on the server while attached (pruned, or through opencode's
        // own API) and the feed didn't say so: the turn goes to a new session,
        // which continues from codeoid's history (#openSession).
        console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] opencode session ${this.#ses} is gone — continuing in a new one`);
        this.#detachSession();
        await this.#post(conn, turn, opts, stale);
      }
    } finally {
      turn.markPosted();
    }
  }

  /** Attach, switch what changed, and post the turn's prompt (or command). */
  async #post(conn: OpencodeConnection, turn: Turn, opts: TurnOpts, stale: () => boolean): Promise<void> {
    const ses = await this.#attach(conn, opts.workdir);
    if (stale()) return;
    await this.#applySelection(conn, ses, opts);
    if (stale()) return;
    if (opts.systemPromptAppend && opts.systemPromptAppend !== this.#sentInstructions) {
      await conn.client.synthetic(ses, opts.systemPromptAppend, INSTRUCTIONS_DESCRIPTION);
      this.#sentInstructions = opts.systemPromptAppend;
      if (stale()) return;
    }
    const seed = this.#pendingHistorySeed;
    const message = opts.userMessage;

    const slash = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
    if (!seed && slash) {
      const [, name, args = ""] = slash;
      if (this.#commands.length === 0) await this.listCommands().catch(() => []);
      if (stale()) return;
      if (this.#commands.some((c) => c.name === name && c.source === "command")) {
        await conn.client.command(ses, { name: name!, text: args });
        turn.markPosted();
        // A command may run the agent (most do: they submit a prompt) or
        // only act. Give it a moment to start an execution; one that didn't
        // has finished.
        await Bun.sleep(COMMAND_START_MS);
        if (this.#turn === turn && !turn.started && !this.#executing) {
          const active = await conn.client.activeSessions().catch(() => ({}));
          if (!(ses in active) && this.#turn === turn && !turn.started) this.#finishTurn(turn, "succeeded");
        }
        return;
      }
      const skill = this.#skills.get(name!);
      if (skill) {
        turn.promptId = (await conn.client.prompt(ses, { text: args || `/${name}`, skills: [{ id: skill }] })).id;
        return;
      }
    }
    // The seed is spent only by the prompt that carries it.
    this.#pendingHistorySeed = null;
    turn.promptId = (await conn.client.prompt(ses, { text: seed ? `${seed}\n\n${message}` : message })).id;
  }

  /** A message sent while the turn runs: steer it now (`now`/`next`), or queue it behind (`later`). */
  async #push(turn: Turn, content: string, priority: "now" | "next" | "later"): Promise<void> {
    if (priority === "later") {
      await this.#send(turn, content, "queue");
      return;
    }
    // Owed from the moment Session counts it: its delivery can beat the
    // reply, and the execution can end while the turn's prompt is still
    // going out (the end then waits for this request).
    turn.owed++;
    const sent = this.#send(turn, content, "steer");
    this.#settling(turn, sent);
    try {
      await sent;
    } catch (err) {
      // Never taken, so never delivered: Session still absorbs a turn_done
      // for it, which the turn pays at its end — not here, mid-turn, where
      // Session's boundary would dismiss the turn's pending approvals.
      if (turn.owed > 0) {
        turn.owed--;
        turn.unpaid++;
      }
      throw err;
    }
  }

  /** Post a pushed message once the turn's own prompt went out. */
  async #send(turn: Turn, content: string, delivery: "steer" | "queue"): Promise<void> {
    await turn.posted;
    if (this.#turn !== turn || turn.queue.closed || turn.interrupted) throw new Error("the turn ended before the message could be sent");
    const ses = this.#ses;
    const conn = this.#conn;
    if (!ses || !conn) throw new Error("no opencode session to steer");
    const item = await conn.client.prompt(ses, { text: content, delivery });
    if (turn.interrupted && !turn.budgetStopped) {
      // The user stopped the turn while this was on its way: Session dropped
      // it, so opencode mustn't hand it to the model with the next prompt.
      this.#cancelInput(conn, ses, item.id);
      return;
    }
    if (delivery === "queue") {
      if (!turn.delivered.has(item.id)) turn.queued.add(item.id);
      return;
    }
    if (this.#turn !== turn) return;
    // Delivered before its id came back: its boundary is due now.
    if (turn.delivered.has(item.id)) {
      if (turn.owed > 0) this.#payBoundary(turn);
    } else {
      turn.steers.add(item.id);
    }
  }

  #cancelInput(conn: OpencodeConnection, ses: string, id: string): void {
    void conn.client.cancelInput(ses, id).catch((err: unknown) => {
      console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] couldn't withdraw a message the interrupt dropped: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Stop the turn's execution: the user's interrupt, or the provider's own budget stop (`budget`). */
  async #interrupt(turn: Turn, opts: { budget?: boolean } = {}): Promise<void> {
    turn.interrupted = true;
    // Session cancels its pending mid-turn continuations when it interrupts.
    // A budget stop is the provider's own: Session still counts the steers it
    // pushed, so they are paid before the final turn_done (#finishTurn).
    const ses = this.#ses;
    const conn = this.#conn;
    if (!opts.budget) {
      turn.owed = 0;
      turn.unpaid = 0;
      // What Session dropped stays dropped: opencode would otherwise deliver
      // an input still in its inbox with the next prompt.
      if (ses && conn) for (const id of [...turn.steers, ...turn.queued]) this.#cancelInput(conn, ses, id);
      turn.steers.clear();
      turn.queued.clear();
    }
    if (!ses || !conn) {
      this.#finishTurn(turn, "interrupted");
      return;
    }
    let res: { interrupted: boolean } = { interrupted: false };
    try {
      res = await conn.client.interrupt(ses);
    } catch {
      /* the settle timer below ends the turn */
    }
    if (!res.interrupted && !turn.started && !this.#executing) {
      // Nothing was running: the prompt may still be on its way in. Ask once
      // more after it had a chance to start, then end the turn here.
      await Bun.sleep(250);
      await conn.client.interrupt(ses).catch(() => {});
    }
    setTimeout(() => {
      if (this.#turn === turn && !turn.queue.closed) this.#finishTurn(turn, "interrupted");
    }, res.interrupted ? INTERRUPT_SETTLE_MS : 300).unref?.();
  }

  #emitTo(turn: Turn, event: ProviderEvent): void {
    if (turn.queue.closed) return;
    try {
      turn.queue.push(event);
    } catch {
      /* closed between check and push */
    }
  }

  /** To the current turn; a background agent's lifecycle with no turn goes to the session channel. */
  #emit(event: ProviderEvent): void {
    const turn = this.#turn;
    if (turn && !turn.queue.closed) {
      this.#emitTo(turn, event);
      return;
    }
    if (isBackgroundLifecycleEvent(event)) {
      this.onSessionEvent?.({ type: "background_event", event: event as BackgroundLifecycleEvent });
    }
  }

  #closeTurn(turn: Turn, reason: string): void {
    if (turn.queue.closed) return;
    if (turn.adopted && reason === "superseded") {
      this.#emitTo(turn, { type: "turn_done", result: this.#result(turn, "superseded") });
    }
    // Spend no turn_done reported (an error, a replaced or torn-down turn —
    // Session records no cost for those) counts on the next one.
    addUsage(this.#carry, turn.usage);
    turn.usage = emptyUsage();
    turn.queue.close();
    if (this.#turn === turn) this.#turn = null;
  }

  /** The turn's spend so far (and what was carried into it) as a result; reported once. */
  #result(turn: Turn, stopReason: string): NormalizedTurnResult {
    const u = turn.usage;
    const c = this.#carry;
    turn.usage = emptyUsage();
    this.#carry = emptyUsage();
    return {
      providerId: this.id,
      model: turn.model,
      inputTokens: u.input + c.input,
      // Reasoning is billed as output; codeoid has no field of its own for it.
      outputTokens: u.output + u.reasoning + c.output + c.reasoning,
      cacheReadTokens: u.cacheRead + c.cacheRead,
      cacheCreationTokens: u.cacheWrite + c.cacheWrite,
      totalCostUsd: u.cost + c.cost,
      durationMs: Date.now() - turn.startedAt,
      ...(turn.contextWindow ? { contextWindow: turn.contextWindow } : {}),
      stopReason,
    };
  }

  /** End the turn on its execution's outcome. */
  #finishTurn(turn: Turn, outcome: "succeeded" | "interrupted" | "failed", error?: OcError): void {
    if (turn.queue.closed) return;
    if (outcome === "failed" && !turn.budgetStopped) {
      // The structured error is what the usage-limit classifier reads; the
      // spend so far still counts, on the next turn (#closeTurn).
      const detail = errorDetail(error ?? turn.stepError);
      this.#emitTo(turn, { type: "error", message: `opencode: ${describeError(error ?? turn.stepError)}`, ...(detail ? { detail } : {}) });
      this.#closeTurn(turn, "failed");
      return;
    }
    // Steers the budget stop left unanswered, and ones opencode never took:
    // Session absorbs one turn_done for each, then reads the turn's end.
    if (turn.budgetStopped) while (turn.owed > 0) this.#payBoundary(turn);
    for (; turn.unpaid > 0; turn.unpaid--) this.#emitTo(turn, { type: "turn_done", result: this.#result(turn, "steered") });
    const result = this.#result(turn, turn.budgetStopped ? "budget" : outcome === "interrupted" ? "interrupted" : (turn.finish ?? "stop"));
    if (turn.budgetStopped) {
      result.isError = true;
      result.errorMessage = BUDGET_STOP_MESSAGE;
    } else if (outcome === "succeeded" && this.#ses && turn.lastAssistantMessageID) {
      // Where this turn ends in opencode's session, for a native fork there (#387).
      result.nativeRef = { backingId: this.#ses, ref: turn.lastAssistantMessageID };
    }
    this.#emitTo(turn, { type: "turn_done", result });
    this.#closeTurn(turn, outcome);
  }

  #failTurn(turn: Turn, message: string): void {
    this.#emitTo(turn, { type: "error", message });
    this.#closeTurn(turn, "failed");
  }

  // ── Session attach, resume, fork ───────────────────────────────────

  /** Attach to the server and the opencode session, creating, resuming or forking it. Returns its id. */
  async #attach(conn: OpencodeConnection, workdir: string): Promise<string> {
    if (this.#conn !== conn) {
      this.#detachServer();
      this.#conn = conn;
      this.#unlisten = this.#server.listen({
        onEvent: (e) => this.#onLive(e),
        onResync: (c) => this.#resync(c),
        onLost: (reason) => this.#onLost(reason),
      });
    }
    if (this.#ses && this.#workdir !== workdir) {
      // The session moved: opencode sessions are bound to their directory at
      // creation, so the conversation continues in a new one from the history.
      this.#detachSession();
      if (this.#pendingHistorySeed === null) this.onHistoryLost?.();
    }
    // A session opened here got its rules as it opened (#openSession).
    const fresh = !this.#ses;
    if (fresh) {
      const opened = await this.#openSession(conn, workdir);
      this.#ses = opened.id;
      this.#workdir = workdir;
      this.#seq = -1;
      this.#counted = emptyUsage();
      addTokens(this.#counted, opened.tokens, opened.cost);
      this.#adoptBacking(opened.id);
    }
    const ses = this.#ses!;
    await this.#ensureMounts(conn, workdir);
    // Before every turn, what anything holding the server's password (any
    // process of the daemon's user can read it) could have changed since:
    // the session's rules, a saved "always", a plugin dropped into a config
    // dir opencode watches (#ensureMounts' requests loaded the location).
    if (!fresh) await conn.client.updateSession(ses, { permissions: sessionRules(this.#sessionId) });
    await this.#sweepSaved(conn, workdir);
    await this.#server.checkPlugins(conn, workdir);
    if (!this.#modelsReported) await this.#reportModelsOnce();
    return ses;
  }

  /** The opencode session to drive, and its spend so far (opencode's running total starts there). */
  async #openSession(conn: OpencodeConnection, workdir: string): Promise<OcSessionInfo> {
    const rules = sessionRules(this.#sessionId);
    const pending = this.#pendingNative;
    this.#pendingNative = null;
    if (pending) {
      try {
        const before = await this.#messageAfter(conn, pending.source, pending.after);
        const forked = await conn.client.forkSession(pending.source, before);
        // A fork may not carry the source's rules; this session's are set before anything runs.
        await conn.client.updateSession(forked.id, { permissions: rules });
        this.#sessionModel = forked.model ?? null;
        this.#freshSession();
        this.#agentApplied = forked.agent !== undefined && forked.agent === this.#agent;
        return forked;
      } catch (err) {
        console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] native fork failed, using the transcript: ${err instanceof Error ? err.message : String(err)}`);
        this.#pendingHistorySeed = pending.fallback;
        this.#emit({
          type: "custom_message",
          content: "⚠️ opencode couldn't fork its own session here, so it continues from a text transcript of the conversation instead.",
          metadata: { event: "history.native_fallback", providerId: this.id },
        });
      }
    } else if (this.#backingSessionId.startsWith("ses_")) {
      try {
        const info = await conn.client.getSession(this.#backingSessionId);
        await conn.client.updateSession(info.id, { permissions: rules });
        this.#sessionModel = info.model ?? null;
        this.#agentApplied = info.agent !== undefined && info.agent === this.#agent;
        return info;
      } catch (err) {
        if (!(err instanceof OpencodeHttpError && err.status === 404)) throw err;
        // Gone (a pruned database, another data dir): a fresh session must
        // not start the conversation over — unless the session already
        // queued what the new one gets.
        if (this.#pendingHistorySeed === null) {
          console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] opencode session ${this.#backingSessionId} is gone — continuing from codeoid's history`);
          this.onHistoryLost?.();
        }
      }
    }
    const created = await conn.client.createSession({
      location: { directory: workdir },
      permissions: rules,
      ...(this.#agent ? { agent: this.#agent } : {}),
    });
    this.#sessionModel = created.model ?? null;
    this.#freshSession();
    this.#agentApplied = this.#agent !== undefined;
    return created;
  }

  /** A new opencode session has none of the old one's selection or instructions. */
  #freshSession(): void {
    this.#appliedSelection = null;
    this.#sentInstructions = null;
  }

  /**
   * The message right after `messageID` in `source` — a fork copies history
   * BEFORE a message. Undefined when `messageID` is the last one (fork all).
   */
  async #messageAfter(conn: OpencodeConnection, source: string, messageID: string): Promise<string | undefined> {
    let cursor: string | undefined;
    let found = false;
    for (let page = 0; page < 100; page++) {
      const res = await conn.client.messages(source, cursor);
      for (const m of res.data ?? []) {
        if (found) return m.id;
        if (m.id === messageID) found = true;
      }
      cursor = res.cursor?.next;
      if (!cursor) break;
    }
    if (!found) throw new Error(`message ${messageID} isn't in opencode session ${source}`);
    return undefined;
  }

  /** Remember `id` as the backing session: a restart resumes it only if it was saved. */
  #adoptBacking(id: string): void {
    if (this.#backingSessionId === id) return;
    this.#backingSessionId = id;
    try {
      // The column predates multi-provider naming: "the backend's session id".
      this.#store.setClaudeCodeSessionId(this.#sessionId, id);
    } catch (err) {
      console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] failed to persist session id: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #detachSession(): void {
    const ses = this.#ses;
    const conn = this.#conn;
    const dir = this.#workdir;
    if (ses && conn && dir) void this.#unmount(conn, dir);
    this.#ses = null;
    this.#workdir = null;
    this.#executing = false;
    this.#mountedFor = null;
    this.#appliedSelection = null;
    this.#agentApplied = false;
    this.#sentInstructions = null;
    this.#sessionModel = null;
    this.#children.clear();
  }

  #detachServer(): void {
    this.#unlisten?.();
    this.#unlisten = null;
    this.#conn = null;
    this.#mountedFor = null;
  }

  // ── Models and effort ─────────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    const conn = this.#conn;
    if (!conn) return this.#models.length > 0 ? this.#modelInfos(this.#models, undefined) : [];
    try {
      const [models, def] = await Promise.all([
        conn.client.models(this.#workdir ?? undefined),
        conn.client.defaultModel(this.#workdir ?? undefined).catch(() => undefined),
      ]);
      // Chat models that are usable: opencode lists every catalog model, enabled = has a credential.
      this.#models = models.filter((m) => m.enabled !== false && (m.type === undefined || m.type === "chat"));
      return this.#modelInfos(this.#models, def);
    } catch {
      return this.#models.length > 0 ? this.#modelInfos(this.#models, undefined) : [];
    }
  }

  #modelInfos(models: OcModelInfo[], def: OcModelInfo | undefined): ModelInfo[] {
    const defaultValue = this.#sessionModel ? modelValue(this.#sessionModel) : def ? modelValue(def) : undefined;
    return models.map((m) => {
      const efforts = effortsOf(m);
      return {
        id: modelValue(m),
        displayName: m.name || m.id,
        ...(m.limit?.context ? { contextWindow: m.limit.context } : {}),
        efforts,
        ...(defaultValue === modelValue(m) ? { isDefault: true } : {}),
      };
    });
  }

  async #reportModelsOnce(): Promise<void> {
    if (this.#modelsReported) return;
    const models = await this.listModels();
    if (models.length === 0) return;
    this.#modelsReported = true;
    this.#onModels?.(
      models.map((m) => ({
        value: m.id,
        displayName: m.displayName,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        efforts: m.efforts ?? [],
        ...(m.isDefault ? { isDefault: true } : {}),
      })),
    );
  }

  #modelInfo(ref: { providerID: string; id: string } | null): OcModelInfo | undefined {
    return ref ? this.#models.find((m) => m.providerID === ref.providerID && m.id === ref.id) : undefined;
  }

  /**
   * Switch the session's model, variant and agent before the prompt when
   * they changed. Model and agent are per session in opencode (a prompt
   * can't carry them). No model and no effort, and nothing switched before:
   * opencode's own default stands.
   */
  async #applySelection(conn: OpencodeConnection, ses: string, opts: TurnOpts): Promise<void> {
    if (this.#agent && !this.#agentApplied) {
      await conn.client.switchAgent(ses, this.#agent);
      this.#agentApplied = true;
    }
    const chosen = opts.model ? parseModelValue(opts.model) : null;
    if (!chosen && opts.effort === undefined && this.#appliedSelection === null) return;
    if (this.#models.length === 0) await this.listModels();
    let base: { providerID: string; id: string } | null = chosen ?? this.#sessionModel;
    if (!base) {
      const def = await conn.client.defaultModel(this.#workdir ?? undefined).catch(() => undefined);
      base = def ? { providerID: def.providerID, id: def.id } : null;
    }
    if (!base) return;
    const variant = variantForEffort(this.#modelInfo(base), opts.effort);
    const ref: OcModelRef = { providerID: base.providerID, id: base.id, ...(variant ? { variant } : {}) };
    const key = `${modelValue(ref)}#${variant ?? ""}`;
    if (key === this.#appliedSelection) return;
    await conn.client.switchModel(ses, ref);
    this.#appliedSelection = key;
    this.#sessionModel = { providerID: ref.providerID, id: ref.id };
    if (this.#turn) this.#turn.model = modelValue(ref);
  }

  // ── Commands ──────────────────────────────────────────────────────────

  /** opencode's slash commands and skills, for `session.commands`; run by sending `/name args`. */
  async listCommands(): Promise<ProviderCommand[]> {
    const conn = this.#conn;
    if (!conn) return this.#commands;
    const dir = this.#workdir ?? undefined;
    const [commands, skills] = await Promise.all([
      conn.client.commands(dir).catch(() => []),
      conn.client.skills(dir).catch(() => []),
    ]);
    this.#skills = new Map(skills.map((s) => [s.name, s.id]));
    this.#commands = [
      ...commands.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), source: "command" })),
      ...skills.map((s) => ({ name: s.name, ...(s.description ? { description: s.description } : {}), source: "skill" })),
    ];
    return this.#commands;
  }

  // ── MCP mounts ────────────────────────────────────────────────────────

  /**
   * Mount codeoid's MCP servers on the session's opencode location: memory,
   * the goal blackboard, the registry's servers, and its OAuth ones through
   * the daemon's relay. Runtime mounts (opencode's experimental MCP set)
   * last until the server restarts, so they're redone for each server.
   * Named for this session (policy.ts) — the location is shared.
   */
  async #ensureMounts(conn: OpencodeConnection, workdir: string): Promise<void> {
    const key = `${conn.generation}:${workdir}`;
    if (this.#mountedFor === key) return;
    this.#mountedFor = key;
    const prefix = ownMountPrefix(this.#sessionId);
    const configs: Array<{ name: string; config: Record<string, unknown> }> = [];
    if (this.#memoryMcp) {
      if (this.#memoryToken) this.#memoryMcp.endpoint.revoke(this.#memoryToken);
      this.#memoryToken = this.#memoryMcp.endpoint.mint({ workspaceId: this.#workspaceId, sessionId: this.#sessionId });
      configs.push({ name: MEMORY_MCP_SERVER_NAME, config: remote(this.#memoryMcp.url, this.#memoryToken) });
    }
    const bb = this.#blackboardMcp?.();
    if (bb) configs.push({ name: BLACKBOARD_MCP_SERVER_NAME, config: remote(bb.url, bb.token) });
    for (const spec of this.#mcpRegistry?.forNativeMount(this.id) ?? []) {
      const t = spec.transport;
      if (t.kind === "stdio") {
        configs.push({
          name: spec.name,
          config: {
            type: "local",
            command: [t.command, ...(t.args ?? [])],
            ...(t.env && Object.keys(t.env).length > 0 ? { environment: resolveEnvMap(t.env, process.env) } : {}),
            codemode: false,
          },
        });
      } else if (t.kind === "http") {
        const token = t.bearerTokenEnv ? process.env[t.bearerTokenEnv] : undefined;
        configs.push({ name: spec.name, config: { ...remote(t.url, token), headers: { ...t.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } } });
      }
    }
    const lease = this.#proxy.renew();
    for (const server of lease?.servers ?? []) configs.push({ name: server.name, config: remote(server.url, lease!.token) });

    this.#mounts = new Map();
    for (const { name, config } of configs) {
      const normalized = mcpNamespace(name);
      try {
        await conn.client.addMcp(workdir, `${prefix}${normalized}`, config);
        this.#mounts.set(normalized, name);
      } catch (err) {
        console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] MCP server "${name}" isn't mounted: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async #unmount(conn: OpencodeConnection, workdir: string): Promise<void> {
    const prefix = ownMountPrefix(this.#sessionId);
    const names = [...this.#mounts.keys()];
    this.#mounts = new Map();
    await Promise.all(names.map((n) => conn.client.removeMcp(workdir, `${prefix}${n}`).catch(() => {})));
  }

  /**
   * Saved "always" approvals are allow rules evaluated after codeoid's — one
   * in codeoid's private database (from someone running opencode on it by
   * hand) would let calls through unasked. codeoid never saves one; remove any.
   */
  async #sweepSaved(conn: OpencodeConnection, workdir: string): Promise<void> {
    try {
      const saved = await conn.client.savedPermissions(workdir);
      for (const s of saved) {
        console.warn(`[opencode-provider] removing a saved opencode approval (${s.action}: ${s.resource}) — codeoid decides every call`);
        await conn.client.removeSavedPermission(s.id).catch(() => {});
      }
    } catch {
      /* an older server without the route: nothing was saved by codeoid */
    }
  }

  // ── Events ────────────────────────────────────────────────────────────

  /** One of this session's durable events. */
  #onDurable(ev: OcEvent): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "session.execution.started": {
        this.#executing = true;
        const turn = this.#turn;
        if (turn) {
          turn.started = true;
          turn.executions++;
          return;
        }
        this.#adoptTurn();
        return;
      }
      case "session.inbox.delivered": {
        const turn = this.#turn;
        if (!turn) return;
        turn.started = true;
        const id = String(d.inboxID ?? "");
        turn.delivered.add(id);
        turn.queued.delete(id);
        if (turn.steers.delete(id) && turn.owed > 0) this.#payBoundary(turn);
        return;
      }
      case "session.deleted": {
        // Deleted on the server (pruned, or through opencode's own API): a
        // turn on it ends, and the next one continues in a new session from
        // codeoid's history (#openSession).
        const turn = this.#turn;
        console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] opencode session ${this.#ses} was deleted`);
        this.#detachSession();
        if (turn) this.#failTurn(turn, "opencode: its session was deleted on the opencode server");
        return;
      }
      case "session.step.started": {
        const turn = this.#turn;
        const model = d.model as OcModelRef | undefined;
        if (model) this.#sessionModel = { providerID: model.providerID, id: model.id };
        if (!turn) return;
        turn.started = true;
        if (typeof d.assistantMessageID === "string") turn.lastAssistantMessageID = d.assistantMessageID;
        if (model) {
          turn.model = modelValue(model);
          const info = this.#modelInfo(model);
          if (info?.limit?.context) turn.contextWindow = info.limit.context;
        }
        return;
      }
      case "session.text.ended": {
        const key = `${String(d.assistantMessageID)}:${String(d.ordinal)}`;
        if (this.#endedBlocks.has(key)) return; // already read back after a gap
        this.#endedBlocks.add(key);
        if (typeof d.text === "string") this.#emit({ type: "text_done", content: d.text });
        return;
      }
      case "session.reasoning.ended": {
        const key = `r:${String(d.assistantMessageID)}:${String(d.ordinal)}`;
        if (this.#endedBlocks.has(key)) return;
        this.#endedBlocks.add(key);
        const blockIndex = this.#thinkingIndex(key);
        // A reasoning block whose deltas never arrived (a reconnect gap) still reaches the record.
        if (typeof d.text === "string" && !this.#streamedBlocks.has(key) && d.text.length > 0) {
          this.#emit({ type: "thinking_delta", content: d.text, blockIndex });
        }
        this.#emit({ type: "thinking_done", blockIndex });
        return;
      }
      case "session.tool.input.started":
        this.#recordCall(String(d.sessionID ?? this.#ses), String(d.id ?? ""), { name: String(d.name ?? "tool") });
        return;
      case "session.tool.called": {
        const sid = String(d.sessionID ?? this.#ses);
        const id = String(d.id ?? "");
        this.#recordCall(sid, id, { input: (d.input as Record<string, unknown>) ?? {} });
        this.#announceUnasked(sid, id);
        return;
      }
      case "session.tool.success":
      case "session.tool.failed":
        this.#toolSettled(String(d.sessionID ?? this.#ses), d, ev.type === "session.tool.success");
        return;
      case "session.step.ended":
      case "session.step.failed": {
        const tokens = d.tokens as OcTokenUsage | undefined;
        const cost = typeof d.cost === "number" ? d.cost : undefined;
        if (ev.type === "session.step.failed") {
          const turn = this.#turn;
          if (turn) turn.stepError = d.error as OcError;
        } else if (this.#turn && typeof d.finish === "string") {
          this.#turn.finish = d.finish;
        }
        if (typeof d.assistantMessageID === "string") {
          // Read back while still being written: its last block may have ended in the gap.
          if (this.#streamingReadBack.delete(d.assistantMessageID)) this.#catchUp(d.assistantMessageID);
          if (this.#countedSteps.has(d.assistantMessageID)) return; // already read back after a gap
          this.#countedSteps.add(d.assistantMessageID);
        }
        addTokens(this.#counted, tokens, cost);
        this.#recordStep(tokens, cost, true);
        return;
      }
      case "session.retry.scheduled": {
        const error = d.error as OcError | undefined;
        this.#emit({
          type: "api_retry",
          ...(typeof d.attempt === "number" ? { attempt: d.attempt } : {}),
          ...(typeof d.at === "number" ? { retryDelayMs: Math.max(0, d.at - Date.now()) } : {}),
          errorStatus: typeof error?.status === "number" ? error.status : null,
        });
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        this.#executing = false;
        const turn = this.#turn;
        if (!turn || !turn.started) return;
        const outcome = ev.type === "session.execution.succeeded" ? "succeeded" : ev.type === "session.execution.failed" ? "failed" : "interrupted";
        this.#executionEnded(turn, outcome, outcome === "failed" ? (d.error as OcError) : undefined);
        return;
      }
    }
  }

  /** The execution the turn waits on ended: so does the turn, unless a steer is still to run in another. */
  #executionEnded(turn: Turn, outcome: "succeeded" | "interrupted" | "failed", error: OcError | undefined): void {
    if (turn.settling.size > 0) {
      // A steer's request hasn't answered (whether opencode took it in this
      // execution decides what comes next — its delivery can come first), or
      // a read-back is still recovering what a feed gap swallowed.
      const executions = turn.executions;
      void Promise.all([...turn.settling]).then(() => {
        if (this.#turn === turn && !turn.queue.closed && turn.executions === executions) this.#executionEnded(turn, outcome, error);
      });
      return;
    }
    if (turn.owed > 0 && !turn.budgetStopped) {
      // The steered input arrived after the last step: opencode runs it
      // next. This execution's part of the turn ends here (Session
      // absorbs it); the turn waits for the next execution.
      this.#payBoundary(turn);
      turn.started = false;
      return;
    }
    this.#finishTurn(turn, outcome, error);
  }

  /** Track `work` as something the turn's end waits for (failures are its own to report). */
  #settling(turn: Turn, work: Promise<unknown>): void {
    const settled = work.then(
      () => {},
      () => {},
    );
    turn.settling.add(settled);
    void settled.then(() => turn.settling.delete(settled));
  }

  /** Session absorbs one `turn_done` per steer: the part of the reply before the steered message was taken. */
  #payBoundary(turn: Turn): void {
    turn.owed--;
    this.#emitTo(turn, { type: "turn_done", result: this.#result(turn, "steered") });
  }

  /** A turn opencode started by itself: hand it to the session. */
  #adoptTurn(): void {
    if (!this.onSessionEvent) return;
    const turn: Turn = {
      queue: new AsyncQueue<ProviderEvent>({ maxBuffered: 20_000 }),
      gate: this.#lastGate ?? { canUseTool: null, requestUserInput: undefined },
      startedAt: Date.now(),
      model: this.runningModel ?? OPENCODE_PROVIDER_ID,
      started: true,
      owed: 0,
      steers: new Set(),
      queued: new Set(),
      unpaid: 0,
      posted: Promise.resolve(),
      markPosted: () => {},
      settling: new Set(),
      delivered: new Set(),
      executions: 1,
      usage: emptyUsage(),
      budgetStopped: false,
      interrupted: false,
      adopted: true,
    };
    this.#turn = turn;
    this.onSessionEvent({ type: "turn_started", run: this.#runFor(turn) });
  }

  #thinkingIndex(key: string): number {
    let i = this.#blockIndex.get(key);
    if (i === undefined) {
      i = this.#blockIndex.size;
      this.#blockIndex.set(key, i);
    }
    return i;
  }

  /** One step's usage: an `llm_call`, and spend for the turn (or the next one). */
  #recordStep(tokens: OcTokenUsage | undefined, cost: number | undefined, isPrimary: boolean): void {
    if (tokens) {
      this.#emit({
        type: "llm_call",
        usage: {
          inputTokens: tokens.input || 0,
          cacheReadTokens: tokens.cache?.read || 0,
          cacheCreationTokens: tokens.cache?.write || 0,
          outputTokens: (tokens.output || 0) + (tokens.reasoning || 0),
        },
        isPrimary,
      });
    }
    const turn = this.#turn;
    addTokens(turn && !turn.queue.closed ? turn.usage : this.#carry, tokens, cost);
    if (typeof cost === "number" && Number.isFinite(cost)) this.#spentUsd += cost;
    // The routine's cap, enforced as the spend lands — not only between turns.
    if (turn && !turn.budgetStopped && this.#maxBudgetUsd !== undefined && this.#spentUsd >= this.#maxBudgetUsd) {
      turn.budgetStopped = true;
      void this.#interrupt(turn, { budget: true });
    }
  }

  /**
   * opencode's running total for this session. What it holds past the steps
   * codeoid counted is spend no step reported — the title opencode generates
   * for a session's first prompt, each request of a compaction — and is
   * counted as a side call, in the turn it lands in (or the next one). A
   * compaction's end (`session.compaction.ended` / `failed`) reports the sum
   * of its requests again, so it isn't counted.
   */
  #usageUpdated(d: Record<string, unknown>): void {
    const total = emptyUsage();
    addTokens(total, d.tokens as OcTokenUsage | undefined, typeof d.cost === "number" ? d.cost : undefined);
    const c = this.#counted;
    const over = (k: keyof Usage) => Math.max(0, total[k] - c[k]);
    // Float sums of the same costs can differ in the last bits.
    const cost = over("cost") > 1e-9 ? over("cost") : 0;
    const tokens: OcTokenUsage = { input: over("input"), output: over("output"), reasoning: over("reasoning"), cache: { read: over("cacheRead"), write: over("cacheWrite") } };
    for (const k of Object.keys(c) as Array<keyof Usage>) c[k] = Math.max(c[k], total[k]);
    if (cost === 0 && tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write === 0) return;
    this.#recordStep(tokens, cost, false);
  }

  /** One event from the live feed: this session's own (durable or not), and its children's. */
  #onLive(ev: OcEvent): void {
    const ses = this.#ses;
    if (!ses) return;
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "session.created") {
      if (d.parentID === ses && typeof d.sessionID === "string") this.#childCreated(d.sessionID, d);
      return;
    }
    if (ev.durable?.aggregateID === ses) {
      // The feed is the record: a seq at or below the last one is a repeat.
      if (typeof ev.durable.seq === "number") {
        if (ev.durable.seq <= this.#seq) return;
        this.#seq = ev.durable.seq;
      }
      try {
        this.#onDurable(ev);
      } catch (err) {
        console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] ${ev.type} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (ev.type === "session.usage.updated" && d.sessionID === ses) {
      this.#usageUpdated(d);
      return;
    }
    if (ev.type === "permission.replied") {
      // Settled elsewhere — opencode rejects a session's other pending
      // requests along with a rejected one: withdraw ours.
      const pending = this.#pendingAsks.get(String(d.requestID ?? ""));
      if (pending) {
        this.#pendingAsks.delete(String(d.requestID));
        pending.abort.abort();
      }
      return;
    }
    const sid = eventSession(ev);
    if (!sid) return;
    const own = sid === ses;
    const child = this.#children.get(sid);
    if (!own && !child) return;
    switch (ev.type) {
      case "session.text.delta": {
        if (!own || !this.#turn) return;
        const key = `${String(d.assistantMessageID)}:${String(d.ordinal)}`;
        if (this.#endedBlocks.has(key) || typeof d.delta !== "string") return;
        this.#emit({ type: "text_delta", content: d.delta });
        return;
      }
      case "session.reasoning.delta": {
        if (!own || !this.#turn) return;
        const key = `r:${String(d.assistantMessageID)}:${String(d.ordinal)}`;
        if (this.#endedBlocks.has(key) || typeof d.delta !== "string") return;
        this.#streamedBlocks.add(key);
        this.#emit({ type: "thinking_delta", content: d.delta, blockIndex: this.#thinkingIndex(key) });
        return;
      }
      // A child's calls (its own session's are durable events, handled above).
      case "session.tool.input.started":
        this.#recordCall(sid, String(d.id ?? ""), { name: String(d.name ?? "tool") });
        return;
      case "session.tool.called":
        this.#recordCall(sid, String(d.id ?? ""), { input: (d.input as Record<string, unknown>) ?? {} });
        return;
      case "permission.asked":
        void this.#onAsk(d as unknown as OcPermissionRequest).catch((err: unknown) => {
          console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] permission request failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      case "form.created":
        void this.#onForm(d.form as OcForm).catch((err: unknown) => {
          console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] form failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
    }
    if (!child) return;
    // A child session's own lifecycle (its log isn't followed: the parent's turn shows it as a subagent).
    switch (ev.type) {
      case "session.execution.started":
        if (!child.running) {
          child.running = true;
          this.#emit({ type: "subagent_start", agentId: sid, agentType: child.agentType });
        }
        return;
      case "session.step.ended":
        this.#recordStep(d.tokens as OcTokenUsage | undefined, typeof d.cost === "number" ? d.cost : undefined, false);
        return;
      case "session.tool.success":
      case "session.tool.failed":
        this.#toolSettled(sid, d, ev.type === "session.tool.success");
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (!child.running) return;
        child.running = false;
        this.#emit({ type: "subagent_stop", agentId: sid });
        if (child.background) {
          const status = ev.type === "session.execution.succeeded" ? "completed" : ev.type === "session.execution.failed" ? "failed" : "stopped";
          this.#emitBackgroundLevel();
          this.onSessionEvent?.({
            type: "background_task_settled",
            taskId: sid,
            status,
            summary: `Subagent "${child.title}" ${status === "completed" ? "finished" : status}.`,
          });
        }
        return;
      }
    }
  }

  #childCreated(id: string, d: Record<string, unknown>): void {
    if (this.#children.has(id)) return;
    const child: Child = {
      agentType: typeof d.agent === "string" ? d.agent : "subagent",
      title: typeof d.title === "string" && d.title ? d.title : "subagent",
      background: false,
      running: true,
    };
    this.#children.set(id, child);
    // The child may not carry this session's rules (its agent's own come
    // first); set them before its first step. The server's agent check
    // (policy.ts) is what guarantees it, this is belt and braces.
    void this.#conn?.client.updateSession(id, { permissions: sessionRules(this.#sessionId) }).catch(() => {});
    this.#emit({ type: "subagent_start", agentId: id, agentType: child.agentType });
  }

  #backgroundLevel(): Array<{ id: string; kind: string; description: string; status: string }> {
    return [...this.#children.entries()]
      .filter(([, c]) => c.background && c.running)
      .map(([id, c]) => ({ id, kind: "subagent", description: c.title, status: "running" }));
  }

  #emitBackgroundLevel(): void {
    this.onSessionEvent?.({ type: "background_tasks", tasks: this.#backgroundLevel() });
  }

  async stopBackgroundTasks(taskIds: readonly string[]): Promise<string[]> {
    const conn = this.#conn;
    const failed: string[] = [];
    for (const id of taskIds) {
      if (!this.#children.has(id) || !conn) {
        failed.push(id);
        continue;
      }
      try {
        await conn.client.interrupt(id);
      } catch {
        failed.push(id);
      }
    }
    return failed;
  }

  #recordCall(sessionID: string, id: string, part: Partial<OcToolCall>): void {
    if (!id) return;
    const key = `${sessionID}:${id}`;
    const prev = this.#toolCalls.get(key);
    this.#toolCalls.set(key, { name: part.name ?? prev?.name ?? "tool", input: part.input ?? prev?.input ?? {} });
    if (part.input) {
      for (const wake of this.#callWaiters.get(key) ?? []) wake();
      this.#callWaiters.delete(key);
    }
  }

  /**
   * A call to a tool that never asks (Code Mode): its card is shown when it's
   * called, so the gated requests it makes have a context and its result a card.
   */
  #announceUnasked(sessionID: string, id: string): void {
    const key = `${sessionID}:${id}`;
    const call = this.#toolCalls.get(key);
    const name = call ? UNASKED_TOOLS[call.name] : undefined;
    if (!name || sessionID !== this.#ses || this.#announced.has(key)) return;
    this.#announced.add(key);
    this.#emit({ type: "tool_start", toolId: id, sdkToolUseId: id, name, input: call!.input, approvalId: `opencode-auto-${id}` });
  }

  /**
   * The call a request names: as the feed announced it, else as opencode
   * stored it (the announcement fell in a feed gap — the stored message
   * holds the call and the input it runs).
   */
  async #callFor(conn: OpencodeConnection, req: OcPermissionRequest, key: string, missed: boolean): Promise<OcToolCall | undefined> {
    const known = missed ? this.#toolCalls.get(key) : await this.#waitForCall(key);
    if (known && Object.keys(known.input).length > 0) return known;
    const source = req.source!;
    try {
      const m = await conn.client.message(req.sessionID, source.messageID);
      const block = m.content?.find((b) => b.type === "tool" && b.id === source.id);
      const input = block?.state?.input;
      // A `streaming` call's input is still partial text: not something to show.
      if (block?.name && input && typeof input === "object" && !Array.isArray(input)) this.#recordCall(req.sessionID, source.id, { name: block.name, input });
    } catch {
      /* not stored: the request is judged on what it says itself */
    }
    return this.#toolCalls.get(key);
  }

  async #waitForCall(key: string): Promise<OcToolCall | undefined> {
    const known = this.#toolCalls.get(key);
    if (known && Object.keys(known.input).length > 0) return known;
    await Promise.race([
      new Promise<void>((resolve) => {
        const list = this.#callWaiters.get(key) ?? [];
        list.push(resolve);
        this.#callWaiters.set(key, list);
      }),
      Bun.sleep(CALL_WAIT_MS),
    ]);
    return this.#toolCalls.get(key);
  }

  /** A tool call finished: its card completes (one codeoid declined already says so). */
  #toolSettled(sessionID: string, d: Record<string, unknown>, success: boolean): void {
    const id = String(d.id ?? "");
    const key = `${sessionID}:${id}`;
    if (this.#settledCalls.has(key)) return; // read back already, now from the feed
    remember(this.#settledCalls, key);
    const call = this.#toolCalls.get(key);
    this.#toolCalls.delete(key);
    if (this.#declined.delete(key)) {
      this.#announced.delete(key);
      return;
    }
    const child = sessionID !== this.#ses;
    // Every opencode tool asks before it acts (a Code Mode script is
    // announced when called): one that succeeded unasked means something
    // settled its request itself — a plugin, a rule codeoid didn't set.
    const unasked = !this.#announced.has(key);
    if (unasked) {
      // A child's calls are shown only when they asked; the main agent's
      // are always recorded (one refused unasked, e.g. a hidden tool).
      if (child || !call) {
        if (success) this.#ranUnasked(call?.name ?? "a tool");
        return;
      }
      const retro = gateCallFor({ id: "", sessionID, action: actionOfTool(call.name), resources: [] }, call, this.#mapContext());
      this.#emit({ type: "tool_start", toolId: id, sdkToolUseId: id, name: retro.name, input: retro.input, approvalId: `opencode-auto-${id}` });
    }
    this.#announced.delete(key);
    const metadata = d.metadata as Record<string, unknown> | undefined;
    if (!child && call?.name === "subagent" && metadata?.status === "running" && typeof metadata.sessionID === "string") {
      // A background subagent: it outlives this call.
      const bg = this.#children.get(metadata.sessionID);
      if (bg) {
        bg.background = true;
        this.#emitBackgroundLevel();
      }
    }
    this.#emit({
      type: "tool_complete",
      sdkToolUseId: id,
      output: toolOutputText(d.content, success ? undefined : (d.error as OcError)),
      success,
    });
    if (unasked && success) this.#ranUnasked(call!.name);
  }

  /**
   * opencode ran a tool codeoid never approved: the server can't be trusted
   * to ask. It is stopped — every turn on it ends with the reason — and the
   * next one starts a new server, checked again.
   */
  #ranUnasked(tool: string): void {
    const conn = this.#conn;
    const reason = `opencode ran ${tool} without asking codeoid — something in its configuration settles permission requests itself`;
    console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] ${reason}`);
    if (conn) void this.#server.distrust(conn, reason);
  }

  #mapContext() {
    return { workdir: this.#workdir ?? process.cwd(), ownPrefix: ownMountPrefix(this.#sessionId), mounts: this.#mounts };
  }

  // ── Approvals ─────────────────────────────────────────────────────────

  /** A permission request. `missed`: re-offered after a feed gap, so its call's announcement may be lost. */
  async #onAsk(req: OcPermissionRequest, opts: { missed?: boolean } = {}): Promise<void> {
    if (!req?.id || this.#handledAsks.has(req.id)) return;
    this.#handledAsks.add(req.id);
    const conn = this.#conn;
    const ses = this.#ses;
    if (!conn || !ses) return;
    const isChild = req.sessionID !== ses;
    const gate = this.#turn && !this.#turn.queue.closed ? this.#turn.gate : isChild ? this.#lastGate : null;
    const callKey = `${req.sessionID}:${req.source?.id ?? req.id}`;
    const source = req.source?.id ? await this.#callFor(conn, req, callKey, opts.missed === true) : undefined;
    // A request made from inside a Code Mode script (its `fetch`) names the
    // script's call: it gets a card of its own, settled by its reply. One
    // script can make many.
    const nested = source !== undefined && UNASKED_TOOLS[source.name] !== undefined;
    const call = nested ? undefined : source;
    const toolId = nested ? `${req.source!.id}:${req.id}` : (req.source?.id ?? req.id);
    const key = `${req.sessionID}:${toolId}`;
    const mapped = gateCallFor(req, call, this.#mapContext());
    const approvalId = `opencode-${req.id}`;
    const pending: PendingAsk = { sessionID: req.sessionID, toolId, abort: new AbortController(), nested };
    this.#pendingAsks.set(req.id, pending);
    if (!nested) this.#announced.add(key);
    this.#emit({
      type: "tool_start",
      toolId,
      sdkToolUseId: toolId,
      ...(isChild ? { sdkAgentId: req.sessionID } : {}),
      name: mapped.name,
      input: mapped.input,
      approvalId,
    });
    const refusal = mapped.unshowable ?? (gate?.canUseTool ? undefined : "nobody can approve it here");
    if (refusal) {
      // Never ask for a yes on something the approver can't see — rejected,
      // with the reason on the card and to the model.
      this.#pendingAsks.delete(req.id);
      if (!nested) this.#declined.add(key);
      this.#emit({ type: "tool_complete", sdkToolUseId: toolId, output: `Declined — ${refusal}`, success: false, declinedByBackend: true });
      await this.#reply(conn, req, "reject", `codeoid declined this: ${refusal}`);
      return;
    }
    let verdict: Awaited<ReturnType<ToolApprovalFn>>;
    try {
      verdict = await gate!.canUseTool!(toolId, approvalId, mapped.name, mapped.input, pending.abort.signal, isChild ? req.sessionID : undefined);
    } catch (err) {
      verdict = { behavior: "deny", message: `codeoid's approval failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (this.#pendingAsks.get(req.id) !== pending) return; // withdrawn: settled elsewhere, or the server went away
    this.#pendingAsks.delete(req.id);
    if (verdict.behavior === "allow") {
      await this.#reply(conn, req, "once");
      // No result of its own comes back: it is part of the script's.
      if (nested) this.#emit({ type: "tool_complete", sdkToolUseId: toolId, output: "Allowed — its result goes to the Code Mode script.", success: true });
      return;
    }
    if (!nested) this.#declined.add(key);
    // A message makes it feedback the model reads and carries on from; a bare reject ends the step.
    await this.#reply(conn, req, "reject", verdict.message || "The user denied this action.");
  }

  async #reply(conn: OpencodeConnection, req: OcPermissionRequest, decision: "once" | "reject", message?: string): Promise<void> {
    try {
      await conn.client.replyPermission(req.sessionID, req.id, decision, message);
    } catch (err) {
      // Gone already (settled by a sibling's reject, or the server restarted): nothing to answer.
      if (!(err instanceof OpencodeHttpError && err.status === 404)) {
        console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] permission reply failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Forms (opencode's question tool, MCP elicitations) ─────────────────

  async #onForm(form: OcForm): Promise<void> {
    if (!form?.id || this.#handledForms.has(form.id)) return;
    this.#handledForms.add(form.id);
    const conn = this.#conn;
    if (!conn) return;
    const ask = (this.#turn && !this.#turn.queue.closed ? this.#turn.gate : this.#lastGate)?.requestUserInput;
    if (!ask) {
      await conn.client.cancelForm(form.sessionID, form.id, "Nobody can answer questions in this session right now.").catch(() => {});
      return;
    }
    const answers: Record<string, OcFormValue> = {};
    for (const field of form.fields ?? []) {
      if (field.hidden || !fieldActive(field, answers)) continue;
      const answer = await askField(ask, form, field);
      if (answer === null) {
        // A cancelled dialog is no answer, never consent: the model is told and carries on.
        await conn.client.cancelForm(form.sessionID, form.id, "The user dismissed the question.").catch(() => {});
        return;
      }
      if (answer !== undefined) answers[field.key] = answer;
    }
    try {
      await conn.client.replyForm(form.sessionID, form.id, answers);
    } catch (err) {
      console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] form reply refused: ${err instanceof Error ? err.message : String(err)}`);
      await conn.client.cancelForm(form.sessionID, form.id, "The answer couldn't be accepted.").catch(() => {});
    }
  }

  // ── Server events ─────────────────────────────────────────────────────

  /** The live feed (re)connected: re-read what may have been asked in the gap, and how a running turn went. */
  #resync(conn: OpencodeConnection): void {
    if (conn !== this.#conn || !this.#ses) return;
    const turn = this.#turn;
    if (turn && !turn.queue.closed) {
      // The turn's end waits for it: what the gap swallowed comes first.
      this.#settling(
        turn,
        this.#reconcile(conn, turn).catch((err: unknown) => {
          console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] reading back a turn after a feed gap failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
    }
    for (const sid of [this.#ses, ...this.#children.keys()]) {
      void conn.client
        .pendingPermissions(sid)
        .then((reqs) => {
          for (const r of reqs) void this.#onAsk(r, { missed: true }).catch(() => {});
        })
        .catch(() => {});
      void conn.client
        .pendingForms(sid)
        .then((forms) => {
          for (const f of forms) void this.#onForm(f).catch(() => {});
        })
        .catch(() => {});
    }
  }

  /**
   * After a gap in the feed. The turn's messages are read back from the
   * session, and what the feed didn't deliver is emitted: the blocks of
   * every message whose response ended (of one still being written, all but
   * its last block, which is read again when its step ends — #catchUp), the
   * steps that ended, and the cards of calls that settled. A turn whose
   * execution ended in the gap would wait forever: if the session went idle
   * after the turn began, it ends as opencode says it did.
   */
  async #reconcile(conn: OpencodeConnection, turn: Turn): Promise<void> {
    const ses = this.#ses;
    if (!ses) return;
    let info: OcSessionInfo;
    try {
      info = await conn.client.getSession(ses);
    } catch (err) {
      if (err instanceof OpencodeHttpError && err.status === 404 && this.#turn === turn) this.#failTurn(turn, `opencode: session ${ses} no longer exists`);
      return;
    }
    if (this.#turn !== turn || turn.queue.closed || this.#ses !== ses) return;
    const { busy, idle } = info.time ?? {};
    // A turn opencode started was seen after it began; a prompted one began before.
    const since = turn.adopted ? turn.startedAt - 5_000 : turn.startedAt;
    if (busy === undefined || busy < since) return; // not started yet: the feed has it all
    const ended = idle !== undefined && idle >= busy;
    const mine: OcMessage[] = [];
    let cursor: string | undefined;
    let reachedStart = false;
    for (let page = 0; page < RECONCILE_PAGES && !reachedStart; page++) {
      const res = await conn.client.recentMessages(ses, cursor);
      for (const m of res.data ?? []) {
        if (m.id === turn.promptId || (m.time?.created ?? 0) < since) {
          reachedStart = true;
          break;
        }
        mine.push(m);
      }
      cursor = res.cursor?.next;
      if (!cursor) break;
    }
    if (this.#turn !== turn || turn.queue.closed || this.#ses !== ses) return;
    let lastError: OcError | undefined;
    for (const m of mine.reverse()) {
      if (m.type === "user") {
        // opencode stores an input as it delivers it, under its inbox id: a
        // steer delivered in the gap is paid here, where its answer begins.
        turn.delivered.add(m.id);
        turn.queued.delete(m.id);
        if (turn.steers.delete(m.id) && turn.owed > 0) this.#payBoundary(turn);
        continue;
      }
      if (m.type !== "assistant") continue;
      if (ended) turn.lastAssistantMessageID = m.id;
      if (m.error) lastError = m.error;
      // Once the execution ended every message is final.
      if (this.#emitReadBack(ses, m, ended || messageStreamed(m))) this.#streamingReadBack.add(m.id);
    }
    if (!ended) return; // still running: the feed carries the rest
    // Spend no step reported (the title), from opencode's own total.
    this.#usageUpdated({ cost: info.cost, tokens: info.tokens });
    if (this.#turn !== turn || turn.queue.closed) return;
    console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] opencode's feed dropped the end of a turn — read it back from the session`);
    this.#executing = false;
    // Session absorbs one turn_done per steer it pushed; they were delivered in the gap.
    while (turn.owed > 0) this.#payBoundary(turn);
    const outcome = info.outcome ?? (lastError ? "failed" : "succeeded");
    this.#finishTurn(turn, outcome, outcome === "failed" ? lastError : undefined);
  }

  /**
   * What the feed didn't deliver of one assistant message read back: its
   * ended blocks, its step once ended, and the results of calls whose card
   * is showing. `final`: every block has ended; otherwise the last text or
   * reasoning block may still be written, and is left to the feed. Returns
   * whether one was left.
   */
  #emitReadBack(ses: string, m: OcMessage, final: boolean): boolean {
    const blocks = m.content ?? [];
    const last = blocks.at(-1);
    const open = !final && (last?.type === "text" || last?.type === "reasoning") ? last : undefined;
    let text = 0;
    let reasoning = 0;
    for (const block of blocks) {
      if (block.type === "text") {
        const key = `${m.id}:${text++}`;
        if (block === open || this.#endedBlocks.has(key) || typeof block.text !== "string") continue;
        this.#endedBlocks.add(key);
        this.#emit({ type: "text_done", content: block.text });
      } else if (block.type === "reasoning") {
        const key = `r:${m.id}:${reasoning++}`;
        if (block === open || this.#endedBlocks.has(key)) continue;
        this.#endedBlocks.add(key);
        const blockIndex = this.#thinkingIndex(key);
        if (!this.#streamedBlocks.has(key) && block.text) this.#emit({ type: "thinking_delta", content: block.text, blockIndex });
        this.#emit({ type: "thinking_done", blockIndex });
      } else if (block.type === "tool" && block.id && this.#announced.has(`${ses}:${block.id}`)) {
        const state = block.state;
        if (state?.status === "completed") this.#toolSettled(ses, { id: block.id, content: state.content, metadata: state.metadata }, true);
        else if (state?.status === "error") this.#toolSettled(ses, { id: block.id, content: state.content, error: state.error, metadata: state.metadata }, false);
      }
    }
    if (!this.#countedSteps.has(m.id) && (m.finish !== undefined || m.time?.completed !== undefined) && (m.cost !== undefined || m.tokens)) {
      this.#countedSteps.add(m.id);
      addTokens(this.#counted, m.tokens, m.cost);
      this.#recordStep(m.tokens, m.cost, true);
    }
    return open !== undefined;
  }

  /** A message read back while it was being written: its step ended, so its last block is final — read it again. */
  #catchUp(messageID: string): void {
    const conn = this.#conn;
    const ses = this.#ses;
    const turn = this.#turn;
    if (!conn || !ses || !turn) return;
    this.#settling(
      turn,
      conn.client
        .message(ses, messageID)
        .then((m) => {
          if (this.#turn === turn && !turn.queue.closed && this.#ses === ses) this.#emitReadBack(ses, m, true);
        })
        .catch((err: unknown) => {
          console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] reading back a message after a feed gap failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
    );
  }

  /** The server went away: every pending request with it counts as rejected. */
  #onLost(reason: string): void {
    for (const [id, pending] of this.#pendingAsks) {
      pending.abort.abort();
      if (!pending.nested) this.#declined.add(`${pending.sessionID}:${pending.toolId}`);
      this.#emit({ type: "tool_complete", sdkToolUseId: pending.toolId, output: "Rejected — the opencode server stopped while this was waiting.", success: false, declinedByBackend: true });
      this.#pendingAsks.delete(id);
    }
    const hadBackground = this.#backgroundLevel().length > 0;
    const turn = this.#turn;
    this.#detachServer();
    // The next turn finds the session again on the new server (resumed by
    // its id, or started over from codeoid's history if it's gone).
    this.#ses = null;
    this.#workdir = null;
    this.#mounts = new Map();
    this.#appliedSelection = null;
    this.#executing = false;
    this.#children.clear();
    if (hadBackground) this.#emitBackgroundLevel();
    if (turn) this.#failTurn(turn, `opencode: the server stopped (${reason})`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    await this.teardown();
  }

  /** Never the shared server's pid: tearing one session down must not kill everyone's backend. */
  async backendProcessIds(): Promise<number[]> {
    return [];
  }

  async teardown(): Promise<void> {
    const turn = this.#turn;
    if (turn) this.#closeTurn(turn, "teardown");
    this.#turn = null;
    const conn = this.#conn;
    const ses = this.#ses;
    // Detached from codeoid, opencode would keep running the execution unobserved.
    if (conn && ses && this.#executing) await conn.client.interrupt(ses).catch(() => {});
    for (const pending of this.#pendingAsks.values()) pending.abort.abort();
    this.#pendingAsks.clear();
    const dir = this.#workdir;
    if (conn && dir) await Promise.race([this.#unmount(conn, dir), Bun.sleep(2_000)]);
    // The opencode session stays: the next turn resumes it by id.
    this.#ses = null;
    this.#workdir = null;
    this.#executing = false;
    this.#children.clear();
    this.#appliedSelection = null;
    this.#agentApplied = false;
    this.#sentInstructions = null;
    this.#detachServer();
    if (this.#memoryToken) {
      this.#memoryMcp?.endpoint.revoke(this.#memoryToken);
      this.#memoryToken = null;
    }
    this.#proxy.revoke();
  }
}

/** A streamable-HTTP MCP mount with a bearer token, tools listed directly (not through Code Mode). */
function remote(url: string, token: string | undefined): Record<string, unknown> {
  return {
    type: "remote",
    url,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    oauth: false,
    codemode: false,
  };
}

/** Remember `key`, forgetting the oldest past `max` (a Set keeps insertion order). */
function remember(set: Set<string>, key: string, max = REMEMBERED): void {
  set.add(key);
  if (set.size > max) set.delete(set.values().next().value!);
}

/** The permission action a tool asks under (for a call recorded without a request). */
function actionOfTool(name: string): string {
  return name === "write" || name === "patch" ? "edit" : name;
}

/** An assistant message whose response ended: all its text and reasoning blocks are final. */
function messageStreamed(m: OcMessage): boolean {
  return m.time?.streamed !== undefined || m.time?.completed !== undefined || m.finish !== undefined || m.error !== undefined;
}

/** A request about a session opencode no longer has. */
function sessionGone(err: unknown): boolean {
  return err instanceof OpencodeHttpError && err.status === 404 && err.tag === "SessionNotFoundError";
}

/** A field's `when` conditions against the answers so far (all must hold). */
function fieldActive(field: OcFormField, answers: Record<string, OcFormValue>): boolean {
  for (const c of field.when ?? []) {
    const v = answers[c.key];
    if (v === undefined) return false;
    const eq = Array.isArray(v) ? v.includes(String(c.value)) : v === c.value;
    if (c.op === "eq" ? !eq : eq) return false;
  }
  return true;
}

const OWN_ANSWER = "Type my own answer";

/**
 * Ask one form field. Undefined = skipped (optional, left blank); null = the
 * dialog was cancelled, or the field can't be shown here.
 */
async function askField(ask: UiRequestFn, form: OcForm, field: OcFormField): Promise<OcFormValue | undefined | null> {
  const title = field.title ?? form.title;
  const message = field.description;
  switch (field.type) {
    case "boolean": {
      const r = await ask({ method: "confirm", title, ...(message ? { message } : {}) });
      return r.cancelled ? null : r.confirmed === true;
    }
    case "number":
    case "integer": {
      const r = await ask({ method: "input", title, ...(message ? { message } : {}) });
      if (r.cancelled) return null;
      if (!r.value?.trim()) return field.required ? null : undefined;
      const n = Number(r.value);
      if (!Number.isFinite(n) || (field.type === "integer" && !Number.isInteger(n))) return null;
      return n;
    }
    case "string":
    case "multiselect": {
      const options = field.options ?? [];
      if (options.length === 0) {
        const r = await ask({ method: "input", title, ...(message ? { message } : {}), ...(field.placeholder ? { placeholder: field.placeholder } : {}) });
        if (r.cancelled) return null;
        if (!r.value) return field.required ? null : undefined;
        return field.type === "multiselect" ? [r.value] : r.value;
      }
      const custom = (field as { custom?: boolean }).custom === true;
      const labels = options.map((o) => o.label);
      const r = await ask({ method: "select", title, ...(message ? { message } : {}), options: custom ? [...labels, OWN_ANSWER] : labels });
      if (r.cancelled || r.value === undefined) return null;
      let value = options.find((o) => o.label === r.value)?.value;
      if (value === undefined && custom && r.value === OWN_ANSWER) {
        const own = await ask({ method: "input", title, ...(message ? { message } : {}) });
        if (own.cancelled || !own.value) return null;
        value = own.value;
      }
      if (value === undefined) return null;
      return field.type === "multiselect" ? [value] : value;
    }
    default:
      // An external link to follow (an MCP server's sign-in): codeoid can't open it for anyone.
      return null;
  }
}

