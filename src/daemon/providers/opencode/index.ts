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
  UNPRICED_STOP_MESSAGE,
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
import { estimateCost, type ModelPrice, priceFor } from "../../pricing/index.js";
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
import {
  commandlessShellLine,
  fetchFence,
  fetchOrigin,
  hostedModelInfo,
  mcpNamespace,
  opencodeShellEnv,
  ownMountPrefix,
  runnableCommand,
  sessionRules,
} from "./policy.js";
import { gitCheckout, mercurialCheckout, type OpencodeConnection, type OpencodeServer } from "./server.js";
import {
  type OcToolCall,
  callInput,
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
/** What a turn with no usable model tells the user to set. */
const NO_MODEL_HINT =
  "Pick a model for the session, set providers.opencode.model (`provider/model`), or give codeoid a credential it hands opencode (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, the Qwen backend's key, an OpenAI-compatible endpoint) or a provider in your opencode config. opencode's own hosted models (opencode.ai) are off unless providers.opencode.hostedModels is true.";
/** How long a permission request waits for the tool call it names to show up. */
const CALL_WAIT_MS = 2_000;
/** After an interrupt, how long to wait for opencode to report the execution ended. */
const INTERRUPT_SETTLE_MS = 5_000;
/** How long a teardown waits for an attach in flight to see it. */
const ATTACH_WAIT_MS = 3_000;
/** How long an interrupted turn whose end the feed didn't show waits for its read-back. */
const INTERRUPT_READ_MS = 3_000;
/** At teardown, how long to wait for the stopped subagents to end, and then for opencode to wake their parent. */
const TEARDOWN_SETTLE_MS = 1_500;
const WAKE_GRACE_MS = 300;
/** After an execution ends with a `later` message still queued, how long to wait for the one opencode runs it in. */
const QUEUED_START_MS = 3_000;
/** How long a turn's end waits to read the session's running total (#finishCounted). */
const SPEND_READ_MS = 1_000;
/** How long a session's move waits for the feed to show the move's own execution end. */
const MOVE_SETTLE_MS = 1_000;
/** After a slash command, how long to wait for it to start an execution. */
const COMMAND_START_MS = 1_500;
/** A turn's messages read back after a feed gap — far more than one turn writes. */
const RECONCILE_PAGES = 20;
/** Events naming a session the provider doesn't know that make it look the session up: a child starting or asking. */
const LEARN_CHILD_ON = new Set(["session.execution.started", "permission.asked", "form.created"]);
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
  /** `pricing.models`: what a step opencode put no price on costs, against a run's spend ceiling (#430). */
  modelPrices?: () => Readonly<Record<string, ModelPrice>> | undefined;
}

interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Steps that used tokens opencode billed nothing for: a $0 there isn't a price (#430). */
  unpriced: number;
  /**
   * Requests whose spend nobody reported (#430): stopped while the model
   * answered (opencode bills such a step nothing), never ended, or lost in a
   * feed gap that couldn't be read back.
   */
  lost: number;
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, lost: 0 };
}

function hasTokens(t: OcTokenUsage | undefined): boolean {
  return !!t && (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0) > 0;
}

/** A step's tokens as codeoid prices a turn's: reasoning is billed as output. */
function stepTokens(t: OcTokenUsage): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  return { inputTokens: t.input || 0, outputTokens: (t.output || 0) + (t.reasoning || 0), cacheReadTokens: t.cache?.read || 0, cacheCreationTokens: t.cache?.write || 0 };
}

/** Events only a step that started emits: its blocks, its calls, its end (whose spend #stepSettled judges). */
const STEP_EVIDENCE = /^session\.(step\.(ended|failed)|text\.|reasoning\.|tool\.)/;

/** Events that bound a step's attempt: none of them says the model answered. */
const STEP_BOUNDARIES = new Set(["session.step.started", "session.step.ended", "session.step.failed", "session.retry.scheduled"]);

/**
 * A transport error that says the request never left: the connection
 * couldn't be made (refused, no such host, unreachable). A reset or a
 * timeout doesn't say so — the request may have been served — so it isn't.
 */
function neverConnected(error: OcError | undefined): boolean {
  return error?.type === "provider.transport" && /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ConnectionRefused)\b|Unable to connect/.test(error.message ?? "");
}

/** An error status the provider refused the request with (a 2xx is the status of a response that was served). */
function refusedStatus(error: OcError | undefined): boolean {
  return typeof error?.status === "number" && error.status >= 400;
}

/** A stored assistant message that holds anything of an answer. */
function answeredMessage(m: OcMessage): boolean {
  return (m.content?.length ?? 0) > 0 || m.time?.streamed !== undefined;
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
  /**
   * Its prompt (or command) is being posted: an execution starting from
   * here on is its own. One opencode started before (a background
   * subagent's wake while the turn was attaching) isn't (#foreign).
   */
  sending: boolean;
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
  /** Stopped under the ceiling because a step's spend has no price, not because it was reached. */
  unpricedStop?: boolean;
  /** The budget stop's withdrawal of a mid-turn message was said. */
  budgetDroppedSaid?: boolean;
  interrupted: boolean;
  /** A turn opencode started by itself (`turn_started`). */
  adopted: boolean;
  /** Where a read-back of the turn starts (server time), when not its start: an execution adopted after a gap. */
  since?: number;
}

interface Child {
  agentType: string;
  title: string;
  background: boolean;
  running: boolean;
  /** Its rules and shell environment were set (#setUpChild): nothing it asks is allowed before. */
  ready: Promise<boolean>;
}

interface PendingAsk {
  sessionID: string;
  toolId: string;
  abort: AbortController;
  /** Made from inside a Code Mode script: no tool result of its own will settle it. */
  nested: boolean;
}

/** A form (a question, an MCP elicitation) whose dialog is showing. */
interface OpenForm {
  sessionID: string;
  /** The tool call that asked it (`metadata.tool.id`, a question's). */
  callId?: string;
  /** Withdraws the dialog: opencode settled the form itself. */
  abort: AbortController;
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
  /** Every shell runs `bash -c` with opencodeShellEnv, which has no `CDPATH`. */
  readonly shellCdpathUnset = true;
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
  readonly #modelPrices: (() => Readonly<Record<string, ModelPrice>> | undefined) | undefined;

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
   * A session #openSession moves into the workdir before this provider
   * follows it: the move runs as a short execution of its own, no turn's,
   * waited out before the session is followed.
   */
  #moving: { id: string; ended: () => void } | null = null;
  /**
   * The session's spend as codeoid has counted it: its total when attached,
   * plus every step since. opencode's own running total (`usage.updated`)
   * past this is spend no step reported — the title it generates — and is
   * added to the turn.
   */
  #counted = emptyUsage();
  /** True between an execution's start and end. */
  #executing = false;
  /**
   * Whether the session's execution the feed showed starting has started a
   * step yet (null: none seen starting). One interrupted before its first
   * step may still have sent the step's request (#noStepInterrupted). A
   * step's start lost in a feed gap is known from its other events, or from
   * the step the gap's read-back finds (#reconcile).
   */
  #stepSeen: boolean | null = null;
  /**
   * The running execution started before the open turn posted its prompt:
   * not the turn's (its end doesn't end it), unless the turn's input is
   * delivered into it.
   */
  #foreign = false;
  /** When codeoid last saw this session's execution end (or attached to it idle): one that started later and wasn't seen ran in a feed gap. */
  #lastEndAt = 0;
  /** When the opencode session was attached: a child listed after a gap that's older and ended isn't news. */
  #attachedAt = 0;
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

  /** Tearing down: an execution opencode starts by itself now (a stopped subagent waking its parent) is stopped, not adopted. */
  #stopping = false;
  /** Bumped by every teardown: an attach it overtook mounts nothing and adopts no session. */
  #epoch = 0;
  /** The attach in flight, which a teardown waits out (bounded) before it unmounts and revokes. */
  #attaching: Promise<unknown> | null = null;
  /** Mid-turn messages whose request is still out, and their turn: the inbox sweep before a prompt waits for earlier turns' (#sweepInbox). */
  #pushing = new Set<{ turn: Turn; done: Promise<void> }>();

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
  /** Directories a call's own `external_directory` request was approved for: its read there isn't asked again. */
  #approvedDirs = new Map<string, string[]>();
  /**
   * Calls whose card was settled: a result read back after a feed gap can be
   * delivered again by a feed that's behind, and must not count as one that
   * ran unasked. Kept across turns (the late copy can land in the next one), bounded.
   */
  #settledCalls = new Set<string>();
  #handledAsks = new Set<string>();
  #pendingAsks = new Map<string, PendingAsk>();
  #handledForms = new Set<string>();
  /** Forms whose dialog is showing, by form id: withdrawn when opencode settles one itself. */
  #openForms = new Map<string, OpenForm>();
  /** Text/reasoning blocks already ended (their late deltas are ignored). */
  #endedBlocks = new Set<string>();
  /** Reasoning blocks some of whose deltas were shown. */
  #streamedBlocks = new Set<string>();
  /**
   * Assistant messages whose step was counted (from the feed, or read back
   * after a gap), this session's and its children's: never twice. Kept
   * across turns (a background child's steps land in later ones), bounded.
   */
  #countedSteps = new Set<string>();
  /** Steps started and not ended yet, this session's and its children's: message id → opencode session (#430). */
  #openSteps = new Map<string, string>();
  /** Open steps whose current attempt carried anything past its start: the model answered something (#430). */
  #answeredSteps = new Set<string>();
  /** The model each open step runs on (its `step.started`): a subagent's may be another than the turn's. */
  #stepModels = new Map<string, string>();
  /** Assistant messages read back after a gap while still being written: read again when their step ends. */
  #streamingReadBack = new Set<string>();
  #blockIndex = new Map<string, number>();
  #children = new Map<string, Child>();
  /**
   * Sessions being looked up (#whenChild): what arrives for one meanwhile
   * waits, in order, until it's known whether it is a child of this one.
   */
  #learning = new Map<string, Array<(child: Child) => void>>();
  /** Sessions on the shared server known not to be this one's children (other sessions', theirs). */
  #notChildren = new Set<string>();
  /**
   * Approved fetches still running, per opencode session: call key → the
   * origin its redirects may stay on. While any runs, the session's rules
   * carry the fence (policy.ts `fetchFence`).
   */
  #fences = new Map<string, Map<string, string | null>>();

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
    this.#modelPrices = init.modelPrices;
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
    // Its execution becomes this turn's once the prompt is delivered into it; ended first, it isn't.
    if (prior?.adopted && this.#executing) this.#foreign = true;
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
      sending: false,
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
      // A closed turn can't carry a message's reply, nor one the user
      // stopped (#send refuses it): Session starts a turn for it.
      acceptsMidTurn: () => this.#turn === turn && !turn.queue.closed && !(turn.interrupted && !turn.budgetStopped),
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
    // Stopped while its prompt was on its way in: interrupted, or closed by a
    // teardown (which stops only an execution that has started) before its
    // execution was seen. What the prompt starts would run on unobserved.
    const unwatched = () => turn.interrupted || ((turn.queue.closed || this.#turn !== turn) && !turn.started);
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
      // Judged again here, not only when listed: the list is a cache, and the mounts change.
      const command = this.#commands.find((c) => c.name === name && c.source === "command");
      if (command && runnableCommand(this.#sessionId, command, this.#mounts.keys(), args)) {
        turn.sending = true;
        await conn.client.command(ses, { name: name!, text: args });
        if (unwatched()) await this.#stopLanded(conn, ses, undefined, turn);
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
        turn.sending = true;
        turn.promptId = (await conn.client.prompt(ses, { text: args || `/${name}`, skills: [{ id: skill }] })).id;
        if (unwatched()) await this.#stopLanded(conn, ses, turn.promptId, turn);
        return;
      }
    }
    // The seed is spent only by the prompt that carries it.
    this.#pendingHistorySeed = null;
    turn.sending = true;
    turn.promptId = (await conn.client.prompt(ses, { text: seed ? `${seed}\n\n${message}` : message })).id;
    if (unwatched()) await this.#stopLanded(conn, ses, turn.promptId, turn);
  }

  /**
   * The turn was stopped while its prompt was on its way in: the stop found
   * nothing running, and opencode stored the prompt after it. What it starts
   * is stopped now, and ends this turn (#settleInterrupt waits for it), so
   * its spend is this turn's, never run on unobserved. After a teardown it
   * is stopped on `conn` though the provider has let the server go, while
   * the teardown waits for it (#teardown).
   */
  async #stopLanded(conn: OpencodeConnection, ses: string, id?: string, turn?: Turn): Promise<void> {
    if (id) void this.#cancelInput(conn, ses, id);
    await conn.client.interrupt(ses).catch(() => {});
    // Torn down: nothing settles it here, and a turn after the teardown would
    // join it: the teardown waits until it has stopped (bounded).
    if (turn && !turn.interrupted) await this.#stoppedWithin(conn, ses).catch(() => {});
  }

  /** A message sent while the turn runs: steer it now (`now`/`next`), or queue it behind (`later`). */
  async #push(turn: Turn, content: string, priority: "now" | "next" | "later"): Promise<void> {
    if (priority === "later") {
      // The execution's end waits for the request: whether opencode queued it decides whether the turn goes on.
      const queued = this.#send(turn, content, "queue");
      this.#settling(turn, queued);
      this.#inFlight(turn, queued);
      await queued;
      return;
    }
    // Owed from the moment Session counts it: its delivery can beat the
    // reply, and the execution can end while the turn's prompt is still
    // going out (the end then waits for this request).
    turn.owed++;
    const sent = this.#send(turn, content, "steer");
    this.#settling(turn, sent);
    this.#inFlight(turn, sent);
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
    if (turn.interrupted) {
      // The turn was stopped while this was on its way (Session dropped it,
      // or the budget ran out): opencode mustn't hand it to the model with
      // the next prompt. A budget stop still pays its steer's boundary.
      void this.#cancelInput(conn, ses, item.id);
      if (turn.budgetStopped) this.#budgetDropped(turn);
      return;
    }
    if (this.#turn !== turn || turn.queue.closed) {
      // The turn ended while this was on its way (a teardown: the session
      // stays, the next turn resumes it): opencode would deliver it with
      // whatever is prompted next. The teardown waits for this.
      await this.#cancelInput(conn, ses, item.id);
      return;
    }
    if (delivery === "queue") {
      if (!turn.delivered.has(item.id)) turn.queued.add(item.id);
      return;
    }
    // Delivered before its id came back: its boundary is due now.
    if (turn.delivered.has(item.id)) {
      if (turn.owed > 0) this.#payBoundary(turn);
    } else {
      turn.steers.add(item.id);
    }
  }

  /** The budget stop withdrew a message sent mid-turn: say so, once a turn. */
  #budgetDropped(turn: Turn): void {
    if (turn.budgetDroppedSaid) return;
    turn.budgetDroppedSaid = true;
    this.#emitTo(turn, {
      type: "custom_message",
      content: "⚠️ The turn hit its budget: the message sent mid-turn wasn't run.",
      metadata: { event: "opencode.budget_dropped_messages" },
    });
  }

  #cancelInput(conn: OpencodeConnection, ses: string, id: string): Promise<void> {
    return conn.client.cancelInput(ses, id).catch((err: unknown) => {
      // Still in the inbox: the sweep before the next prompt withdraws it (#sweepInbox).
      console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] couldn't withdraw a message the turn left: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Withdraw what was pushed into the turn and not delivered: opencode would
   * hand an input still in its inbox to whatever runs next in the session
   * (the next prompt, a wake), however much later. With no server to ask
   * (it died), the sweep before the next prompt does it on the next one.
   */
  #withdrawPushed(turn: Turn): Promise<void>[] {
    const ses = this.#ses;
    const conn = this.#conn;
    const ids = [...turn.steers, ...turn.queued];
    turn.steers.clear();
    turn.queued.clear();
    return ses && conn ? ids.map((id) => this.#cancelInput(conn, ses, id)) : [];
  }

  #inFlight(turn: Turn, push: Promise<void>): void {
    const entry = { turn, done: push.catch(() => {}) };
    this.#pushing.add(entry);
    void entry.done.then(() => this.#pushing.delete(entry));
  }

  /**
   * Before a prompt: withdraw every input an earlier turn left in the
   * session's inbox — one pushed into a turn that ended before opencode
   * took it (its server died or was stopped, a teardown, an interrupt, a
   * budget stop, a withdrawal that didn't arrive), or a prompt it never
   * delivered. opencode keeps its inbox in its database, across its
   * server's death and codeoid's restart, and delivers what waits there
   * with the next prompt, which would answer it (and bill it) there. No
   * turn but this one is open then, whose own pushes wait for its prompt,
   * so nothing in it is anyone's; an earlier turn's push still on its way
   * is waited for first (bounded: #send withdraws one that lands later). Only user inputs: synthetic ones are codeoid's instructions or
   * opencode's own. A failure fails the turn — unchecked, it could run.
   */
  async #sweepInbox(conn: OpencodeConnection, ses: string): Promise<void> {
    const earlier = [...this.#pushing].filter((p) => p.turn !== this.#turn).map((p) => p.done);
    if (earlier.length > 0) await Promise.race([Promise.all(earlier), Bun.sleep(ATTACH_WAIT_MS)]);
    const left = (await conn.client.inbox(ses)).filter((item) => item.type === "user");
    if (left.length === 0) return;
    await Promise.all(left.map((item) => conn.client.cancelInput(ses, item.id)));
    console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] withdrew ${left.length} message(s) an earlier turn left in opencode session ${ses}'s inbox`);
    this.#emit({
      type: "custom_message",
      content: "⚠️ A message sent mid-turn to an earlier turn that ended before opencode ran it was withdrawn, not run.",
      metadata: { event: "opencode.stale_messages_withdrawn", count: left.length },
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
    }
    // What the stop leaves unanswered stays so: opencode would otherwise
    // deliver an input still in its inbox with the next prompt, whoever
    // sends it and however much later.
    const dropped = turn.steers.size + turn.queued.size;
    this.#withdrawPushed(turn);
    if (opts.budget && dropped > 0) this.#budgetDropped(turn);
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
      if (this.#turn === turn && !turn.queue.closed) void this.#settleInterrupt(turn);
    }, res.interrupted ? INTERRUPT_SETTLE_MS : 300).unref?.();
  }

  /**
   * The interrupted execution's end didn't come on the feed (a gap longer
   * than the wait): the turn is read back from the session first — the
   * calls the interrupt settled, the step it aborted billed to this turn,
   * not the next — and ends as opencode says it did. Bounded: what can't be
   * read in time leaves the turn ending interrupted here, as before.
   */
  async #settleInterrupt(turn: Turn): Promise<void> {
    // A prompt still on its way is stopped as it lands (#stopLanded): what it
    // started ends here, its end and spend this turn's.
    await Promise.race([turn.posted, Bun.sleep(INTERRUPT_SETTLE_MS)]);
    for (const until = Date.now() + INTERRUPT_SETTLE_MS; this.#turn === turn && !turn.queue.closed && this.#executing && Date.now() < until; ) await Bun.sleep(25);
    if (this.#turn !== turn || turn.queue.closed) return;
    const conn = this.#conn;
    if (conn) await Promise.race([this.#reconcile(conn, turn).catch(() => {}), Bun.sleep(INTERRUPT_READ_MS)]);
    // Read back as ended, it ends once opencode's total is read (#finishCounted, bounded).
    if (this.#turn === turn && !turn.queue.closed && !this.#executing) await Bun.sleep(SPEND_READ_MS + 250);
    if (this.#turn === turn && !turn.queue.closed) this.#finishTurn(turn, "interrupted");
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
    // However it ends (failed, read back, replaced, timed out waiting for a
    // queued message), nothing it left undelivered runs after it.
    this.#withdrawPushed(turn);
    if (turn.adopted && reason === "superseded") {
      this.#emitTo(turn, { type: "turn_done", result: this.#result(turn, "superseded") });
    }
    // A turn closed with no result (replaced, torn down) is recorded by
    // Session from the llm_calls it read (#430): carried too, it would count
    // twice. Spend landing after this, with no turn open, is carried (#recordStep).
    turn.usage = emptyUsage();
    turn.queue.close();
    if (this.#turn === turn) this.#turn = null;
  }

  /**
   * The turn's spend so far (and what was carried into it) as a result;
   * reported once. Its cost is opencode's own figure (#430) — unless a
   * request's spend went unreported, or a step used tokens opencode put no
   * price on (a subscription sign-in, a model its catalog prices at $0, a
   * custom provider without a cost): a $0 with tokens isn't a price, as on
   * Claude. Every step that way, Session prices the tokens (under
   * `pricing.models`, else unknown); mixed with priced ones, nobody can.
   */
  #result(turn: Turn, stopReason: string): NormalizedTurnResult {
    const u = turn.usage;
    const c = this.#carry;
    turn.usage = emptyUsage();
    this.#carry = emptyUsage();
    const cost = u.cost + c.cost;
    const unpriced = u.unpriced + c.unpriced;
    const costSource = u.lost + c.lost > 0 || (unpriced > 0 && cost > 0) ? ("unknown" as const) : unpriced > 0 ? undefined : ("backend" as const);
    return {
      providerId: this.id,
      model: turn.model,
      inputTokens: u.input + c.input,
      // Reasoning is billed as output; codeoid has no field of its own for it.
      outputTokens: u.output + u.reasoning + c.output + c.reasoning,
      cacheReadTokens: u.cacheRead + c.cacheRead,
      cacheCreationTokens: u.cacheWrite + c.cacheWrite,
      totalCostUsd: cost,
      ...(costSource ? { costSource } : {}),
      durationMs: Date.now() - turn.startedAt,
      ...(turn.contextWindow ? { contextWindow: turn.contextWindow } : {}),
      stopReason,
    };
  }

  /** End the turn on its execution's outcome. */
  #finishTurn(turn: Turn, outcome: "succeeded" | "interrupted" | "failed", error?: OcError): void {
    if (turn.queue.closed) return;
    if (outcome === "failed" && !turn.budgetStopped) {
      // The structured error is what the usage-limit classifier reads.
      const detail = errorDetail(error ?? turn.stepError);
      this.#failTurn(turn, `opencode: ${describeError(error ?? turn.stepError)}`, detail);
      return;
    }
    // Steers the budget stop left unanswered, and ones opencode never took:
    // Session absorbs one turn_done for each, then reads the turn's end.
    if (turn.budgetStopped) while (turn.owed > 0) this.#payBoundary(turn);
    for (; turn.unpaid > 0; turn.unpaid--) this.#emitTo(turn, { type: "turn_done", result: this.#result(turn, "steered") });
    this.#settleOpenSteps(turn);
    const result = this.#result(turn, turn.budgetStopped ? "budget" : outcome === "interrupted" ? "interrupted" : (turn.finish ?? "stop"));
    if (turn.budgetStopped) {
      result.isError = true;
      result.errorMessage = turn.unpricedStop ? UNPRICED_STOP_MESSAGE : BUDGET_STOP_MESSAGE;
    } else if (outcome === "succeeded" && this.#ses && turn.lastAssistantMessageID) {
      // Where this turn ends in opencode's session, for a native fork there (#387).
      result.nativeRef = { backingId: this.#ses, ref: turn.lastAssistantMessageID };
    }
    this.#emitTo(turn, { type: "turn_done", result });
    this.#closeTurn(turn, outcome);
  }

  /** The turn failed: it says why, with what it spent so far (#430) — never carried into the next one, which Session would count again. */
  #failTurn(turn: Turn, message: string, detail?: Record<string, unknown>): void {
    if (turn.queue.closed) return;
    this.#settleOpenSteps(turn);
    const result = this.#result(turn, "error");
    result.isError = true;
    result.errorMessage = message;
    this.#emitTo(turn, { type: "error", message, ...(detail ? { detail } : {}), result });
    this.#closeTurn(turn, "failed");
  }

  /**
   * Steps of the turn's own agents (the session's, a foreground subagent's)
   * still open as it ends: opencode will report their spend to nobody — the
   * request was stopped, or the server went away (#430). A background
   * subagent's go on, billed to a later turn as they end.
   */
  #settleOpenSteps(turn: Turn): void {
    for (const [id, sid] of this.#openSteps) {
      if (sid !== this.#ses && this.#children.get(sid)?.background !== false) continue;
      this.#openSteps.delete(id);
      this.#answeredSteps.delete(id);
      turn.usage.lost++;
    }
  }

  /** Where spend lands now: the open turn, else the next turn_done (#carry). */
  #spendTarget(): Usage {
    const turn = this.#turn;
    return turn && !turn.queue.closed ? turn.usage : this.#carry;
  }

  /**
   * A step ended, on the feed or read back: it's no longer open, and one
   * with no usage spent what nobody reported (opencode bills a step stopped
   * while the model answered nothing) — unless nothing of an answer came
   * and the provider refused its request, which bills nothing (an error
   * status, after opencode's own retries), or it was never sent: a
   * connection that couldn't be made (`neverConnected`) (#430). A response
   * that broke off after part of an answer was served, whatever its status
   * (real 2.2.5 fails it with the response's 200, then retries). `answered`:
   * read back from the stored message; on the feed, what the step carried.
   */
  #stepSettled(id: string | undefined, tokens: OcTokenUsage | undefined, cost: number | undefined, error: OcError | undefined, answered?: boolean): void {
    const came = answered ?? (id === undefined || this.#answeredSteps.has(id));
    if (id) {
      this.#openSteps.delete(id);
      this.#answeredSteps.delete(id);
    }
    if (hasTokens(tokens) || (typeof cost === "number" && cost > 0)) return;
    if (!came && (refusedStatus(error) || neverConnected(error))) return;
    this.#spendTarget().lost++;
  }

  /**
   * opencode retries a step: an attempt that answered something and wasn't
   * failed first (real 2.2.5 fails one before retrying it, #stepSettled)
   * was served, and nothing will report what it spent; a retry starts the
   * step again.
   */
  #retryScheduled(id: unknown): void {
    if (typeof id !== "string") return;
    this.#openSteps.delete(id);
    if (this.#answeredSteps.delete(id)) this.#spendTarget().lost++;
  }

  /**
   * A compaction stopped while its request streamed (`compaction.interrupted`:
   * an interrupt, a budget stop, a restarted server's stale one): opencode
   * reports each of its requests' spend only as the request finishes, and
   * the one it was stopped in never does, though it was sent with the whole
   * conversation (#430). Not a step, and real 2.2.5 announces no compaction
   * start, so this end is the only word of it.
   */
  #compactionFailed(d: Record<string, unknown>): void {
    if ((d.error as OcError | undefined)?.type === "compaction.interrupted") this.#spendTarget().lost++;
  }

  /**
   * An execution interrupted before it announced a step: real 2.2.5 has then
   * often sent the step's request already (an interrupt within milliseconds
   * of the prompt being stored), and reports neither a step nor its spend,
   * so the spend isn't known to be $0 (#430). One stopped before its request
   * looks the same, and is counted the same.
   */
  #noStepInterrupted(): void {
    this.#spendTarget().lost++;
  }

  /** Steps still open when the session or its server goes: nothing will ever report what they spent (#430). */
  #dropOpenSteps(): void {
    if (this.#openSteps.size === 0) return;
    this.#openSteps.clear();
    this.#answeredSteps.clear();
    this.#spendTarget().lost++;
  }

  /** A read-back after a feed gap failed: what the gap held may never be counted (#430). */
  #gapUnread(turn: Turn | null): void {
    (turn && !turn.queue.closed ? turn.usage : this.#carry).lost++;
  }

  // ── Session attach, resume, fork ───────────────────────────────────

  /** Attach to the server and the opencode session, creating, resuming or forking it. Returns its id. */
  async #attach(conn: OpencodeConnection, workdir: string): Promise<string> {
    const attaching = this.#attachIn(conn, workdir, this.#epoch);
    this.#attaching = attaching;
    try {
      return await attaching;
    } finally {
      if (this.#attaching === attaching) this.#attaching = null;
    }
  }

  async #attachIn(conn: OpencodeConnection, workdir: string, epoch: number): Promise<string> {
    const overtaken = () => {
      if (this.#epoch !== epoch) throw new Error("the session's backend was stopped while it attached");
    };
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
    // opencode runs hg unasked in a location under a `.hg`, as its first
    // request naming it is served: an hg that would read the repository's
    // `.hg/hgrc` (hooks, extensions) never gets that far.
    const hg = this.#server.mercurial;
    const checkout = hg ? mercurialCheckout(workdir) : null;
    if (hg && checkout) throw new Error(`opencode would run Mercurial in ${checkout} without asking, and ${hg} — refusing this workdir on the opencode backend`);
    // So does git in a git repository, which takes none of codeoid's overrides before 2.31.
    const git = this.#server.git;
    const repo = git ? gitCheckout(workdir) : null;
    if (git && repo) throw new Error(`opencode would run git in ${repo} without asking, and ${git} — refusing this workdir on the opencode backend`);
    // A session opened here got its rules as it opened (#openSession).
    const fresh = !this.#ses;
    if (fresh) {
      const opened = await this.#openSession(conn, workdir);
      // Torn down meanwhile (a move or a leftover's stop can take seconds):
      // nothing is mounted for it, no token minted. The session stays on
      // the server, and the next turn resumes it by id.
      if (this.#epoch !== epoch) this.#adoptBacking(opened.id);
      overtaken();
      this.#ses = opened.id;
      this.#workdir = workdir;
      this.#seq = -1;
      this.#counted = emptyUsage();
      addTokens(this.#counted, opened.tokens, opened.cost);
      this.#attachedAt = Date.now();
      // What ran before codeoid attached isn't a missed execution.
      this.#lastEndAt = Math.max(this.#attachedAt, opened.time?.busy ?? 0, opened.time?.idle ?? 0);
      this.#adoptBacking(opened.id);
    }
    const ses = this.#ses!;
    overtaken();
    await this.#ensureMounts(conn, workdir, epoch);
    overtaken();
    // Before every turn, what anything holding the server's password (any
    // process of the daemon's user can read it) could have changed since:
    // the session's rules, a saved "always", a plugin dropped into a config
    // dir opencode watches (#ensureMounts' requests loaded the location).
    if (!fresh) await conn.client.updateSession(ses, { permissions: this.#rulesFor(ses) });
    // Before every prompt; a session resumed here was swept as it opened (#openSession).
    if (!fresh) await this.#sweepInbox(conn, ses);
    // Its shell runs without the server's environment (its password, the
    // injected config): a line with no command in it runs unasked. Kept in
    // the server's memory only, so set on every turn; a failure fails it.
    await conn.client.setEnvironment(ses, opencodeShellEnv());
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
        let forked = await conn.client.forkSession(pending.source, before);
        // A fork may not carry the source's rules; this session's are set before anything runs.
        await conn.client.updateSession(forked.id, { permissions: rules });
        // Nor anything an earlier turn left in an inbox, before its move runs it.
        await this.#sweepInbox(conn, forked.id);
        // A fork stays where its source is: one into a worktree of its own runs there, or not at all.
        forked = await this.#moveInto(conn, forked, workdir);
        this.#freshSession();
        this.#adoptModel(forked.model);
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
        let info = await conn.client.getSession(this.#backingSessionId);
        await conn.client.updateSession(info.id, { permissions: rules });
        // Before a leftover's stop or a move, either of which runs the
        // session: what an earlier turn left in its inbox would run with it
        // (the server died, codeoid restarted, the backend was torn down).
        await this.#sweepInbox(conn, info.id);
        if (sessionRunning(info) && (await this.#runsNow(conn, info.id))) info = await this.#stopLeftover(conn, info);
        info = await this.#moveInto(conn, info, workdir);
        this.#adoptModel(info.model);
        this.#agentApplied = info.agent !== undefined && info.agent === this.#agent;
        return info;
      } catch (err) {
        // Gone (a pruned database, another data dir), or it can't be moved
        // where the session works now: a fresh session must not start the
        // conversation over — unless the session already queued what the
        // new one gets.
        if (err instanceof UnmovedError) console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] ${err.message}`);
        else if (!(err instanceof OpencodeHttpError && err.status === 404)) throw err;
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
    this.#freshSession();
    this.#adoptModel(created.model);
    this.#agentApplied = this.#agent !== undefined;
    return created;
  }

  /**
   * The session runs an execution nobody watches: opencode started it for a
   * backend codeoid tore down (a background shell or subagent that finished
   * after it). Its requests wait for an answer that never comes, and a
   * prompt would queue behind it. It is the torn-down backend's work, gone
   * with it: stopped (a waiting request with it), then the session is read
   * again for the spend it starts from.
   */
  async #stopLeftover(conn: OpencodeConnection, info: OcSessionInfo): Promise<OcSessionInfo> {
    console.warn(`[opencode-provider ${this.#sessionId.slice(0, 8)}] opencode session ${info.id} runs an execution started after its backend was torn down — stopping it`);
    await conn.client.interrupt(info.id).catch(() => {});
    if (!(await this.#stoppedWithin(conn, info.id))) throw new Error(`opencode session ${info.id} is still running something codeoid didn't start, and didn't stop — try again`);
    return conn.client.getSession(info.id);
  }

  /** Whether the server stops running the session within `INTERRUPT_SETTLE_MS`. */
  async #stoppedWithin(conn: OpencodeConnection, id: string): Promise<boolean> {
    const until = Date.now() + INTERRUPT_SETTLE_MS;
    let running = await this.#runsNow(conn, id);
    while (running && Date.now() < until) {
      await Bun.sleep(50);
      running = await this.#runsNow(conn, id);
    }
    return !running;
  }

  /**
   * Whether the server runs the session now. Its stored `busy`/`idle` say
   * what it last recorded: a server that died mid-execution never wrote the
   * `idle`, so a session it left looks busy for good on the next one.
   */
  async #runsNow(conn: OpencodeConnection, id: string): Promise<boolean> {
    return id in (await conn.client.activeSessions());
  }

  /**
   * The session, bound to `workdir`: opencode runs a session's tools where
   * its location is, and a fork (or a session codeoid's moved since) is
   * elsewhere. An idle session takes the move at once; one that didn't is
   * refused.
   */
  async #moveInto(conn: OpencodeConnection, info: OcSessionInfo, workdir: string): Promise<OcSessionInfo> {
    if (info.location?.directory === workdir) return info;
    const ended = Promise.withResolvers<void>();
    const moving = { id: info.id, ended: ended.resolve };
    this.#moving = moving;
    try {
      await conn.client.moveSession(info.id, workdir).catch((err: unknown) => {
        throw new UnmovedError(`opencode session ${info.id} couldn't move to ${workdir}: ${err instanceof Error ? err.message : String(err)}`);
      });
      await Promise.race([ended.promise, Bun.sleep(MOVE_SETTLE_MS)]);
      const now = await conn.client.getSession(info.id);
      if (now.location?.directory !== workdir) throw new UnmovedError(`opencode session ${info.id} didn't move to ${workdir}`);
      return now;
    } finally {
      if (this.#moving === moving) this.#moving = null;
    }
  }

  /**
   * The model an opencode session opened here runs. opencode keeps the
   * variant on the session (in its database, so across a daemon or server
   * restart): one that isn't the base (`default`) was switched to, and a
   * turn back on the default effort has to switch it off (#applySelection).
   */
  #adoptModel(model: OcModelRef | undefined): void {
    this.#sessionModel = model ? { providerID: model.providerID, id: model.id } : null;
    const variant = model?.variant;
    this.#appliedSelection = model && variant && variant !== "default" ? `${modelValue(model)}#${variant}` : null;
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
    this.#dropOpenSteps();
    const ses = this.#ses;
    const conn = this.#conn;
    const dir = this.#workdir;
    if (ses && conn && dir) void this.#unmount(conn, dir);
    this.#ses = null;
    this.#workdir = null;
    this.#executing = false;
    this.#foreign = false;
    this.#mountedFor = null;
    this.#appliedSelection = null;
    this.#agentApplied = false;
    this.#sentInstructions = null;
    this.#sessionModel = null;
    this.#children.clear();
    this.#learning.clear();
  }

  #detachServer(): void {
    this.#dropOpenSteps();
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
      // opencode's hosted ones only when the owner opted in (the server denies them anyway).
      this.#models = models.filter((m) => m.enabled !== false && (m.type === undefined || m.type === "chat") && this.#offered(m));
      return this.#modelInfos(this.#models, def && this.#offered(def) ? def : undefined);
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

  /**
   * Whether codeoid offers a model: opencode's hosted ones (`opencode`,
   * `opencode-go`, or any whose settings name opencode.ai) only when opted in.
   */
  #offered(ref: { providerID: string; settings?: unknown }): boolean {
    return this.#server.hostedModels || !hostedModelInfo(ref);
  }

  /** Whether `ref` is one of the usable models opencode lists, read again once when it isn't in the cached list. */
  async #listed(ref: { providerID: string; id: string }): Promise<boolean> {
    if (this.#modelInfo(ref)) return true;
    await this.listModels();
    return this.#modelInfo(ref) !== undefined;
  }

  /**
   * The model this turn runs is one opencode can use, checked before
   * anything reaches it: the turn's own (`opts.model`) when it picks one,
   * else the opencode session's, else opencode's default. Throws, naming
   * what to set, when there is none (no credential, opencode's hosted models
   * off) or the picked one can't be used. Returns the default to switch to
   * when the session's own model can't run any more (a hosted model, a
   * credential gone), else null.
   */
  async #checkModel(conn: OpencodeConnection, chosen: { providerID: string; id: string } | null): Promise<{ providerID: string; id: string } | null> {
    if (chosen) {
      if (!this.#offered(chosen)) throw new Error(`${modelValue(chosen)} is one of opencode's hosted models (opencode.ai), which codeoid doesn't offer. ${NO_MODEL_HINT}`);
      if (!(await this.#listed(chosen))) throw new Error(`opencode can't use ${modelValue(chosen)}: it has no credential for it, or doesn't know it. ${NO_MODEL_HINT}`);
      return null;
    }
    const current = this.#sessionModel;
    if (current && this.#offered(current) && (await this.#listed(current))) return null;
    const def = await conn.client.defaultModel(this.#workdir ?? undefined);
    if (!def || !this.#offered(def)) throw new Error(`opencode has no model to run this turn. ${NO_MODEL_HINT}`);
    return current ? { providerID: def.providerID, id: def.id } : null;
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
    const picked = opts.model ? parseModelValue(opts.model) : null;
    // Before any prompt: a turn with no usable model fails here, saying what to set.
    const fallback = await this.#checkModel(conn, picked);
    const chosen = picked ?? fallback;
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

  /**
   * opencode's slash commands and skills, for `session.commands`; run by
   * sending `/name args`. Only the commands that run as one here are listed
   * (`runnableCommand`): opencode's built-ins and this session's own MCP
   * prompts. Any other `/name …` message goes to the model as text.
   */
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
      ...commands
        .filter((c) => runnableCommand(this.#sessionId, c, this.#mounts.keys()))
        .map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), source: "command" })),
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
  async #ensureMounts(conn: OpencodeConnection, workdir: string, epoch: number): Promise<void> {
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
        if (this.#epoch !== epoch) {
          // A teardown that didn't wait for this (bounded) has unmounted what it saw: this one goes too, and nothing more is added.
          await conn.client.removeMcp(workdir, `${prefix}${normalized}`).catch(() => {});
          return;
        }
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
    // Only a started step has blocks, calls or an end: its start fell in a
    // feed gap, and what it spent is reported as it ends (#stepSettled).
    if (this.#stepSeen === false && STEP_EVIDENCE.test(ev.type)) this.#stepSeen = true;
    switch (ev.type) {
      case "session.execution.started": {
        this.#executing = true;
        this.#stepSeen = false;
        this.#foreign = false;
        const turn = this.#turn;
        if (turn && !turn.sending) {
          // Started by opencode itself before the turn's prompt went out: its
          // events show in the turn, its end doesn't end it.
          this.#foreign = true;
          return;
        }
        if (turn) {
          turn.started = true;
          turn.executions++;
          return;
        }
        if (this.#stopping) {
          if (this.#ses && this.#conn) void this.#conn.client.interrupt(this.#ses).catch(() => {});
          return;
        }
        this.#adoptTurn();
        return;
      }
      case "session.inbox.delivered": {
        const turn = this.#turn;
        if (!turn) return;
        // An input opencode delivers before the turn's prompt went out (a wake's) isn't the turn's.
        if (!turn.sending) return;
        // The turn's input, delivered into an execution it didn't start: that execution is the turn's now.
        this.#foreign = false;
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
        this.#stepSeen = true;
        // A retry starts the step again: its new attempt has carried nothing yet.
        if (typeof d.assistantMessageID === "string") this.#answeredSteps.delete(d.assistantMessageID);
        if (typeof d.assistantMessageID === "string" && this.#ses && !this.#countedSteps.has(d.assistantMessageID)) this.#openSteps.set(d.assistantMessageID, this.#ses);
        this.#stepStarted(d);
        const turn = this.#turn;
        const model = d.model as OcModelRef | undefined;
        if (model) this.#sessionModel = { providerID: model.providerID, id: model.id };
        if (!turn || this.#foreign) return;
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
          remember(this.#countedSteps, d.assistantMessageID);
        }
        addTokens(this.#counted, tokens, cost);
        this.#stepSettled(typeof d.assistantMessageID === "string" ? d.assistantMessageID : undefined, tokens, cost, ev.type === "session.step.failed" ? (d.error as OcError) : undefined);
        this.#recordStep(tokens, cost, true, this.#stepModel(d.assistantMessageID));
        return;
      }
      case "session.compaction.failed":
        this.#compactionFailed(d);
        return;
      case "session.retry.scheduled": {
        this.#retryScheduled(d.assistantMessageID);
        const error = d.error as OcError | undefined;
        this.#emit({
          type: "api_retry",
          // opencode numbers the attempt it schedules (the first retry is 2); codeoid's is the retry's, as Claude's.
          ...(typeof d.attempt === "number" ? { attempt: Math.max(1, d.attempt - 1) } : {}),
          ...(typeof d.at === "number" ? { retryDelayMs: Math.max(0, d.at - Date.now()) } : {}),
          errorStatus: typeof error?.status === "number" ? error.status : null,
        });
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        this.#executing = false;
        this.#lastEndAt = Date.now();
        this.#foreign = false;
        if (ev.type === "session.execution.interrupted" && this.#stepSeen === false) this.#noStepInterrupted();
        this.#stepSeen = null;
        // Nothing of an ended execution still waits on an answer.
        if (this.#ses) this.#withdrawAsks(this.#ses);
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
    if (outcome === "interrupted" && !turn.interrupted && (turn.owed > 0 || turn.queued.size > 0)) {
      // Stopped from outside codeoid (codeoid's own interrupt owes nothing):
      // opencode runs no input after an interrupted execution, and would
      // hand one still in its inbox to the next prompt. Session still
      // absorbs a turn_done per steer, paid at the turn's end.
      this.#dropPushed(turn);
      this.#finishCounted(turn, outcome, error);
      return;
    }
    if (turn.owed > 0 && !turn.budgetStopped) {
      // The steered input arrived after the last step: opencode runs it
      // next. This execution's part of the turn ends here (Session
      // absorbs it); the turn waits for the next execution. A failure
      // still says why (an `error` would end the turn the steer continues).
      if (outcome === "failed") this.#failedBeforePush(turn, error);
      this.#payBoundary(turn);
      turn.started = false;
      return;
    }
    if (turn.queued.size > 0 && outcome !== "interrupted" && !turn.interrupted) {
      // A `later` message queued after the last step: opencode runs it next,
      // in an execution of its own, after a failed one too — still this turn
      // (Session merged it in, and absorbs no boundary for it). Bounded, in
      // case opencode drops it.
      if (outcome === "failed") this.#failedBeforePush(turn, error);
      turn.started = false;
      const executions = turn.executions;
      setTimeout(() => {
        if (this.#turn !== turn || turn.queue.closed || turn.started || turn.executions !== executions) return;
        // The turn's end withdraws it (#closeTurn): Session merged it into
        // this turn, so the user hears it went unanswered.
        if (turn.queued.size > 0) {
          this.#emitTo(turn, {
            type: "custom_message",
            content: "⚠️ opencode didn't start running the message sent mid-turn in time: it was withdrawn, not run.",
            metadata: { event: "opencode.queued_message_withdrawn", count: turn.queued.size },
          });
        }
        this.#finishCounted(turn, outcome, error);
      }, QUEUED_START_MS).unref?.();
      return;
    }
    this.#finishCounted(turn, outcome, error);
  }

  /** The execution was interrupted with mid-turn messages waiting: withdraw them, owe Session their boundaries, and say so. */
  #dropPushed(turn: Turn): void {
    this.#withdrawPushed(turn);
    turn.unpaid += turn.owed;
    turn.owed = 0;
    this.#emitTo(turn, {
      type: "custom_message",
      content: "⚠️ opencode's execution was interrupted: the message sent mid-turn wasn't run.",
      metadata: { event: "opencode.interrupted_dropped_messages" },
    });
  }

  /** The execution failed with a mid-turn message waiting, which opencode runs next: say why, without ending the turn. */
  #failedBeforePush(turn: Turn, error: OcError | undefined): void {
    const failure = error ?? turn.stepError;
    const detail = errorDetail(failure);
    this.#emitTo(turn, {
      type: "custom_message",
      content: `⚠️ opencode: ${describeError(failure)} — your message sent mid-turn runs next.`,
      metadata: { event: "opencode.execution_failed", ...(detail ? { detail } : {}) },
    });
    turn.stepError = undefined;
  }

  /**
   * End the turn once opencode's running total for the session was read:
   * it books what no step reported as the execution ends (the title of a
   * session's first prompt lands just after `execution.succeeded`), and the
   * turn reports it rather than a next turn that may never come (a
   * routine's run, a session's last). Bounded; a total that can't be read
   * leaves it to the next turn, as before.
   */
  #finishCounted(turn: Turn, outcome: "succeeded" | "interrupted" | "failed", error: OcError | undefined): void {
    const conn = this.#conn;
    const ses = this.#ses;
    if (!conn || !ses || outcome === "failed") {
      this.#finishTurn(turn, outcome, error);
      return;
    }
    const executions = turn.executions;
    const queued = new Set(turn.queued);
    void Promise.race([conn.client.getSession(ses).catch(() => null), Bun.sleep(SPEND_READ_MS).then(() => null)]).then((info) => {
      // Another execution of the turn began meanwhile (a steer taken late): its end ends the turn.
      if (this.#turn !== turn || turn.queue.closed || turn.executions !== executions) return;
      if (info && this.#ses === ses) this.#usageUpdated({ cost: info.cost, tokens: info.tokens });
      // A message pushed while the total was read: opencode runs it next, still this turn.
      const pushed = turn.settling.size > 0 || (turn.owed > 0 && !turn.budgetStopped) || [...turn.queued].some((id) => !queued.has(id));
      if (pushed) this.#executionEnded(turn, outcome, error);
      else this.#finishTurn(turn, outcome, error);
    });
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

  /** A turn opencode started by itself: hand it to the session. `since`: it began unseen, in a feed gap, then. */
  #adoptTurn(since?: number): Turn | null {
    if (!this.onSessionEvent) return null;
    const turn: Turn = {
      queue: new AsyncQueue<ProviderEvent>({ maxBuffered: 20_000 }),
      gate: this.#lastGate ?? { canUseTool: null, requestUserInput: undefined },
      startedAt: Date.now(),
      model: this.runningModel ?? OPENCODE_PROVIDER_ID,
      started: true,
      sending: true,
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
      ...(since !== undefined ? { since } : {}),
    };
    this.#turn = turn;
    this.onSessionEvent({ type: "turn_started", run: this.#runFor(turn) });
    return turn;
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
  /** A step started: the model it runs on prices it if opencode bills it $0 (#recordStep). */
  #stepStarted(d: Record<string, unknown>): void {
    const model = d.model as OcModelRef | undefined;
    if (typeof d.assistantMessageID !== "string" || !model) return;
    this.#stepModels.set(d.assistantMessageID, modelValue(model));
    if (this.#stepModels.size > REMEMBERED) this.#stepModels.delete(this.#stepModels.keys().next().value!);
  }

  /** The model step `id` ran on, as its start said, else as its stored message says (a read-back). */
  #stepModel(id: unknown, stored?: OcModelRef): string | undefined {
    if (typeof id !== "string") return stored ? modelValue(stored) : undefined;
    const started = this.#stepModels.get(id);
    this.#stepModels.delete(id);
    return started ?? (stored ? modelValue(stored) : undefined);
  }

  /** `model`: the step's own, when known; else the turn's, or the session's last. */
  #recordStep(tokens: OcTokenUsage | undefined, cost: number | undefined, isPrimary: boolean, model?: string): void {
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
    const into = this.#spendTarget();
    addTokens(into, tokens, cost);
    const unpriced = hasTokens(tokens) && !(typeof cost === "number" && cost > 0);
    if (unpriced) into.unpriced++;
    if (typeof cost === "number" && Number.isFinite(cost)) this.#spentUsd += cost;
    // Under a cap, a step opencode put no price on counts at the price
    // Session puts on it (`pricing.models`, else the snapshot); with none,
    // what the run spent can't be told, and it stops as Session would at
    // the turn's end (#430).
    let priceless = false;
    if (unpriced && this.#maxBudgetUsd !== undefined) {
      const price = priceFor(model ?? turn?.model ?? (this.#sessionModel ? modelValue(this.#sessionModel) : ""), this.#modelPrices?.());
      const usd = price ? estimateCost(price, stepTokens(tokens!), (tokens!.input || 0) + (tokens!.cache?.read || 0) + (tokens!.cache?.write || 0)) : Number.NaN;
      if (Number.isFinite(usd) && usd >= 0) this.#spentUsd += usd;
      else priceless = true;
    }
    // The routine's cap, enforced as the spend lands — not only between turns.
    if (turn && !turn.budgetStopped && this.#maxBudgetUsd !== undefined && (priceless || this.#spentUsd >= this.#maxBudgetUsd)) {
      turn.budgetStopped = true;
      if (priceless && this.#spentUsd < this.#maxBudgetUsd) turn.unpricedStop = true;
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
    const moving = this.#moving;
    if (moving && ev.durable?.aggregateID === moving.id) {
      if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed" || ev.type === "session.execution.interrupted") moving.ended();
      return;
    }
    const ses = this.#ses;
    if (!ses) return;
    const d = (ev.data ?? {}) as Record<string, unknown>;
    // Anything an open step carries past its start (a delta, a block, a tool input): the model answered.
    if (typeof d.assistantMessageID === "string" && this.#openSteps.has(d.assistantMessageID) && !STEP_BOUNDARIES.has(ev.type)) {
      this.#answeredSteps.add(d.assistantMessageID);
    }
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
    if (ev.type === "form.replied" || ev.type === "form.cancelled") {
      // Settled by opencode itself (its call ended: an interrupt, a budget
      // stop, a stopped subagent), or by codeoid's own reply: the dialog goes.
      const id = String(d.id ?? "");
      this.#withdrawForms((formId) => formId === id);
      return;
    }
    const sid = eventSession(ev);
    if (!sid) return;
    const own = sid === ses;
    const child = this.#children.get(sid);
    if (!own && !child) {
      // A child this provider never saw created: one a subagent call
      // continues by its id after the provider was rebuilt (opencode reuses
      // the session, announcing nothing). Unanswered, its requests would
      // block its parent's turn. Learned when it starts or asks.
      if (this.#learning.has(sid) || LEARN_CHILD_ON.has(ev.type)) this.#whenChild(sid, () => this.#onLive(ev));
      return;
    }
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
        // Tearing down: a child woken now (its background shell stopped) is stopped too.
        if (this.#stopping) void this.#conn?.client.interrupt(sid).catch(() => {});
        if (!child.running) {
          child.running = true;
          this.#emit({ type: "subagent_start", agentId: sid, agentType: child.agentType });
          // A background subagent continued: background work again.
          if (child.background) this.#emitBackgroundLevel();
        }
        return;
      case "session.step.started":
        if (typeof d.assistantMessageID === "string") this.#answeredSteps.delete(d.assistantMessageID);
        if (typeof d.assistantMessageID === "string" && !this.#countedSteps.has(d.assistantMessageID)) this.#openSteps.set(d.assistantMessageID, sid);
        this.#stepStarted(d);
        return;
      case "session.retry.scheduled":
        this.#retryScheduled(d.assistantMessageID);
        return;
      case "session.compaction.failed":
        this.#compactionFailed(d);
        return;
      // A failed step is billed too (interrupted after the model answered).
      case "session.step.ended":
      case "session.step.failed": {
        if (typeof d.assistantMessageID === "string") {
          if (this.#countedSteps.has(d.assistantMessageID)) return; // already read back after a gap
          remember(this.#countedSteps, d.assistantMessageID);
        }
        const tokens = d.tokens as OcTokenUsage | undefined;
        const cost = typeof d.cost === "number" ? d.cost : undefined;
        this.#stepSettled(typeof d.assistantMessageID === "string" ? d.assistantMessageID : undefined, tokens, cost, ev.type === "session.step.failed" ? (d.error as OcError) : undefined);
        this.#recordStep(tokens, cost, false, this.#stepModel(d.assistantMessageID));
        return;
      }
      case "session.tool.success":
      case "session.tool.failed":
        this.#toolSettled(sid, d, ev.type === "session.tool.success");
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.#childEnded(sid, child, ev.type === "session.execution.succeeded" ? "succeeded" : ev.type === "session.execution.failed" ? "failed" : "interrupted");
        return;
    }
  }

  /** A child session's execution ended: its subagent stops, and a background one settles. */
  #childEnded(sid: string, child: Child, outcome: "succeeded" | "failed" | "interrupted"): void {
    if (!child.running) return;
    child.running = false;
    this.#withdrawAsks(sid);
    this.#withdrawForms((_, form) => form.sessionID === sid);
    this.#emit({ type: "subagent_stop", agentId: sid });
    if (child.background) {
      const status = outcome === "succeeded" ? "completed" : outcome === "failed" ? "failed" : "stopped";
      this.#emitBackgroundLevel();
      this.onSessionEvent?.({
        type: "background_task_settled",
        taskId: sid,
        status,
        summary: `Subagent "${child.title}" ${status === "completed" ? "finished" : status}.`,
      });
    }
  }

  #childCreated(id: string, d: Record<string, unknown>): void {
    if (this.#children.has(id)) return;
    const child: Child = {
      agentType: typeof d.agent === "string" ? d.agent : "subagent",
      title: typeof d.title === "string" && d.title ? d.title : "subagent",
      background: false,
      running: true,
      ready: this.#setUpChild(this.#conn, id),
    };
    this.#children.set(id, child);
    this.#emit({ type: "subagent_start", agentId: id, agentType: child.agentType });
  }

  /**
   * A child session gets this session's rules (its agent's own come first:
   * the server's agent check, policy.ts, is what guarantees it asks, this is
   * belt and braces) and a shell environment without the server's secrets
   * (opencode doesn't pass the parent's on). Set as it's learned, before its
   * first step; what it asks is allowed only once this held (#onAsk).
   */
  #setUpChild(conn: OpencodeConnection | null, id: string): Promise<boolean> {
    if (!conn) return Promise.resolve(false);
    const env = conn.client.setEnvironment(id, opencodeShellEnv()).then(
      () => true,
      (err: unknown) => {
        console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] couldn't set subagent ${id}'s shell environment: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      },
    );
    void conn.client.updateSession(id, { permissions: this.#rulesFor(id) }).catch(() => {});
    return env;
  }

  /**
   * Run `then` on session `sid`'s child record: now if it's known, else once
   * it's been looked up and found to be a child of this session (never, if
   * it isn't one). What waits on a lookup runs in the order it came.
   */
  #whenChild(sid: string, then: (child: Child) => void): void {
    const known = this.#children.get(sid);
    if (known) {
      then(known);
      return;
    }
    const waiting = this.#learning.get(sid);
    if (waiting) {
      waiting.push(then);
      return;
    }
    const conn = this.#conn;
    const ses = this.#ses;
    if (!conn || !ses || this.#notChildren.has(sid)) return;
    this.#learning.set(sid, [then]);
    void conn.client.getSession(sid).then(
      (info) => {
        const queued = this.#learning.get(sid) ?? [];
        this.#learning.delete(sid);
        if (conn !== this.#conn || ses !== this.#ses) return;
        if (info.parentID !== ses) {
          remember(this.#notChildren, sid);
          return;
        }
        let child = this.#children.get(sid);
        if (!child) {
          child = { agentType: info.agent ?? "subagent", title: info.title || "subagent", background: false, running: false, ready: this.#setUpChild(conn, sid) };
          this.#children.set(sid, child);
        }
        for (const run of queued) run(child);
      },
      (err: unknown) => {
        // Unknown still: what it asks stays unanswered (never allowed). The next event asks again.
        this.#learning.delete(sid);
        console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] couldn't look up opencode session ${sid}: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
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
    const name = part.name ?? prev?.name ?? "tool";
    // As the tool runs it (arguments sent as a JSON string are announced wrapped).
    this.#toolCalls.set(key, { name, input: part.input ? callInput(name, part.input) : (prev?.input ?? {}) });
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
    this.#unfence(sessionID, key);
    // An interrupt drops a waiting request without a `permission.replied`: the call's end is the only word of it.
    this.#withdrawAsks(sessionID, id);
    // A question's form goes with its call (its `form.cancelled` may have fallen in a feed gap).
    this.#withdrawForms((_, form) => form.sessionID === sessionID && form.callId === id);
    if (this.#settledCalls.has(key)) return; // read back already, now from the feed
    remember(this.#settledCalls, key);
    const call = this.#toolCalls.get(key);
    this.#toolCalls.delete(key);
    this.#approvedDirs.delete(key);
    if (this.#declined.delete(key)) {
      this.#announced.delete(key);
      return;
    }
    const child = sessionID !== this.#ses;
    // Every opencode tool asks before it acts (a Code Mode script is
    // announced when called), but for a shell line with no command in it:
    // one that succeeded unasked otherwise means something settled its
    // request itself — a plugin, a rule codeoid didn't set.
    const unasked = !this.#announced.has(key);
    // A listing (`export -p`) only in the session's own shell: a child's environment may not be codeoid's yet.
    const ownRule = call?.name === "shell" && typeof call.input.command === "string" && commandlessShellLine(call.input.command, { listing: !child });
    if (unasked) {
      // A child's calls are shown only when they asked; the main agent's
      // are always recorded (one refused unasked, e.g. a hidden tool).
      if (child || !call) {
        if (success && !ownRule) this.#ranUnasked(call?.name ?? "a tool");
        return;
      }
      const retro = gateCallFor({ id: "", sessionID, action: actionOfTool(call.name), resources: [] }, call, this.#mapContext());
      this.#emit({ type: "tool_start", toolId: id, sdkToolUseId: id, name: retro.name, input: retro.input, approvalId: `opencode-auto-${id}` });
    }
    this.#announced.delete(key);
    const metadata = d.metadata as Record<string, unknown> | undefined;
    if (!child && call?.name === "subagent" && metadata?.status === "running" && typeof metadata.sessionID === "string") {
      // A background subagent: it outlives this call.
      this.#whenChild(metadata.sessionID, (bg) => {
        bg.background = true;
        this.#emitBackgroundLevel();
      });
    }
    this.#emit({
      type: "tool_complete",
      sdkToolUseId: id,
      output: toolOutputText(d.content, success ? undefined : (d.error as OcError)),
      success,
    });
    if (unasked && success && !ownRule) this.#ranUnasked(call!.name);
  }

  /**
   * opencode ran a tool codeoid never approved: the server can't be trusted
   * to ask. It is stopped — every turn on it ends — and the next one starts
   * a new server, checked again. This session's turn says why; the other
   * sessions on the shared server are told only that it was restarted.
   */
  #ranUnasked(tool: string): void {
    const conn = this.#conn;
    const reason = `opencode ran ${tool} without asking codeoid — something in its configuration settles permission requests itself`;
    console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] ${reason}`);
    const turn = this.#turn;
    if (turn) this.#failTurn(turn, `opencode: the server stopped (${reason})`);
    if (conn) void this.#server.distrust(conn, reason, "codeoid restarted the shared opencode server: a tool ran without asking codeoid in another session");
  }

  #mapContext() {
    return { workdir: this.#workdir ?? process.cwd(), ownPrefix: ownMountPrefix(this.#sessionId), mounts: this.#mounts, home: this.#server.home };
  }

  // ── Approvals ─────────────────────────────────────────────────────────

  /** A permission request. `missed`: re-offered after a feed gap, so its call's announcement may be lost. */
  async #onAsk(req: OcPermissionRequest, opts: { missed?: boolean; onShown?: () => void } = {}): Promise<void> {
    if (!req?.id || this.#handledAsks.has(req.id)) return;
    this.#handledAsks.add(req.id);
    const conn = this.#conn;
    const ses = this.#ses;
    if (!conn || !ses) return;
    const isChild = req.sessionID !== ses;
    const gate = this.#turn && !this.#turn.queue.closed ? this.#turn.gate : isChild ? this.#lastGate : null;
    const callKey = `${req.sessionID}:${req.source?.id ?? req.id}`;
    const source = req.source?.id ? await this.#callFor(conn, req, callKey, opts.missed === true) : undefined;
    // Its call ended meanwhile (an interrupt dropped the request): there's nothing left to answer.
    if (req.source?.id && this.#settledCalls.has(callKey)) return;
    // A request made from inside a Code Mode script (its `fetch`) names the
    // script's call: it gets a card of its own, settled by its reply. One
    // script can make many.
    const nested = source !== undefined && UNASKED_TOOLS[source.name] !== undefined;
    const call = nested ? undefined : source;
    const toolId = nested ? `${req.source!.id}:${req.id}` : (req.source?.id ?? req.id);
    const key = `${req.sessionID}:${toolId}`;
    const approvedDirs = nested ? undefined : this.#approvedDirs.get(key);
    const mapped = gateCallFor(req, call, { ...this.#mapContext(), ...(approvedDirs ? { approvedDirs } : {}) });
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
    opts.onShown?.();
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
    if (verdict.behavior === "allow" && isChild && !(await (this.#children.get(req.sessionID)?.ready ?? false))) {
      // Its shell would still run with the server's environment, password included.
      if (!nested) this.#declined.add(key);
      this.#emit({ type: "tool_complete", sdkToolUseId: toolId, output: "Declined — codeoid couldn't set up this subagent's shell environment.", success: false, declinedByBackend: true });
      await this.#reply(conn, req, "reject", "codeoid declined this: it couldn't set up this subagent's environment. Try again.");
      return;
    }
    if (verdict.behavior === "allow" && !nested && req.action === "webfetch" && !(await this.#fence(conn, req.sessionID, key, String(mapped.input.url ?? "")))) {
      // Unfenced, its redirects would reach any site unasked: not run.
      this.#declined.add(key);
      this.#emit({ type: "tool_complete", sdkToolUseId: toolId, output: "Declined — codeoid couldn't keep this fetch to the site you approved.", success: false, declinedByBackend: true });
      await this.#reply(conn, req, "reject", "codeoid declined this: it couldn't keep the fetch to the approved site. Try again.");
      return;
    }
    if (verdict.behavior === "allow") {
      if (!nested && req.action === "external_directory" && Array.isArray(mapped.input.directories)) {
        this.#approvedDirs.set(key, [...(this.#approvedDirs.get(key) ?? []), ...mapped.input.directories.filter((d): d is string => typeof d === "string")]);
      }
      await this.#reply(conn, req, "once");
      // No result of its own comes back: it is part of the script's.
      if (nested) this.#emit({ type: "tool_complete", sdkToolUseId: toolId, output: "Allowed — its result goes to the Code Mode script.", success: true });
      return;
    }
    if (!nested) this.#declined.add(key);
    // A message makes it feedback the model reads and carries on from; a bare reject ends the step.
    await this.#reply(conn, req, "reject", verdict.message || "The user denied this action.");
  }

  /**
   * Withdraw what still waits at the gate for opencode requests it dropped:
   * `callId`'s (a nested Code Mode fetch's too), or all of a session's. The
   * gate's signal aborts, which dismisses the approval; the call's own card
   * is settled by its result, a nested one's here.
   */
  #withdrawAsks(sessionID: string, callId?: string): void {
    for (const [id, pending] of this.#pendingAsks) {
      if (pending.sessionID !== sessionID) continue;
      if (callId !== undefined && pending.toolId !== callId && !pending.toolId.startsWith(`${callId}:`)) continue;
      this.#pendingAsks.delete(id);
      pending.abort.abort();
      if (pending.nested) this.#emit({ type: "tool_complete", sdkToolUseId: pending.toolId, output: "Withdrawn — opencode stopped waiting for an answer.", success: false, declinedByBackend: true });
    }
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

  /** The rules a session of this provider's (its own, or a child's) carries now: codeoid's, and the fence while a fetch runs. */
  #rulesFor(sessionID: string): ReturnType<typeof sessionRules> {
    const running = this.#fences.get(sessionID);
    return [...sessionRules(this.#sessionId), ...(running && running.size > 0 ? fetchFence(running.values()) : [])];
  }

  /** Fence an approved fetch before it runs (policy.ts `fetchFence`); false when the rules couldn't be set. */
  async #fence(conn: OpencodeConnection, sessionID: string, key: string, url: string): Promise<boolean> {
    const running = this.#fences.get(sessionID) ?? new Map<string, string | null>();
    this.#fences.set(sessionID, running);
    running.set(key, fetchOrigin(url));
    try {
      await conn.client.updateSession(sessionID, { permissions: this.#rulesFor(sessionID) });
      return true;
    } catch (err) {
      console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] couldn't fence a fetch: ${err instanceof Error ? err.message : String(err)}`);
      this.#unfence(sessionID, key);
      return false;
    }
  }

  /** A fenced fetch ended: its origin leaves the fence, and the fence goes with the last one. */
  #unfence(sessionID: string, key: string): void {
    const running = this.#fences.get(sessionID);
    if (!running?.delete(key)) return;
    if (running.size === 0) this.#fences.delete(sessionID);
    // Failing to lift it fails closed: the next fetch's hops stay fenced until the next turn sets the rules again.
    void this.#conn?.client.updateSession(sessionID, { permissions: this.#rulesFor(sessionID) }).catch(() => {});
  }

  // ── Forms (opencode's question tool, MCP elicitations) ─────────────────

  async #onForm(form: OcForm): Promise<void> {
    if (!form?.id || this.#handledForms.has(form.id)) return;
    this.#handledForms.add(form.id);
    const conn = this.#conn;
    if (!conn) return;
    const raise = (this.#turn && !this.#turn.queue.closed ? this.#turn.gate : this.#lastGate)?.requestUserInput;
    if (!raise) {
      await conn.client.cancelForm(form.sessionID, form.id, "Nobody can answer questions in this session right now.").catch(() => {});
      return;
    }
    const tool = form.metadata?.tool as { id?: unknown } | undefined;
    const open: OpenForm = { sessionID: form.sessionID, ...(typeof tool?.id === "string" ? { callId: tool.id } : {}), abort: new AbortController() };
    this.#openForms.set(form.id, open);
    const withdrawn = () => open.abort.signal.aborted;
    const ask: UiRequestFn = (req) => raise({ ...req, signal: open.abort.signal });
    const answers: Record<string, OcFormValue> = {};
    for (const field of form.fields ?? []) {
      if (field.hidden || !fieldActive(field, answers)) continue;
      const answer = await askField(ask, form, field);
      // Settled by opencode meanwhile: nothing to answer, nobody to tell.
      if (withdrawn()) return;
      if (answer === null) {
        // A cancelled dialog is no answer, never consent: the model is told and carries on.
        this.#openForms.delete(form.id);
        await conn.client.cancelForm(form.sessionID, form.id, "The user dismissed the question.").catch(() => {});
        return;
      }
      if (answer !== undefined) answers[field.key] = answer;
    }
    this.#openForms.delete(form.id);
    try {
      await conn.client.replyForm(form.sessionID, form.id, answers);
    } catch (err) {
      console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] form reply refused: ${err instanceof Error ? err.message : String(err)}`);
      await conn.client.cancelForm(form.sessionID, form.id, "The answer couldn't be accepted.").catch(() => {});
    }
  }

  /** Withdraw the dialogs of the open forms `which` picks: opencode settled them itself, or they can't be answered any more. */
  #withdrawForms(which: (id: string, form: OpenForm) => boolean): void {
    for (const [id, form] of this.#openForms) {
      if (!which(id, form)) continue;
      this.#openForms.delete(id);
      form.abort.abort();
    }
  }

  // ── Server events ─────────────────────────────────────────────────────

  /**
   * The live feed (re)connected: re-read what the gap swallowed — children
   * created in it, how each child went, the running turn (or an execution
   * opencode ran by itself with no turn open), then what was asked.
   */
  #resync(conn: OpencodeConnection): void {
    const ses = this.#ses;
    if (conn !== this.#conn || !ses) return;
    const open = this.#turn;
    const turn = open && !open.queue.closed ? open : null;
    const work = this.#afterGap(conn, ses, turn).catch((err: unknown) => {
      console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] reading back after a feed gap failed: ${err instanceof Error ? err.message : String(err)}`);
      this.#gapUnread(turn);
    });
    // The turn's end waits for it: what the gap swallowed comes first.
    if (turn) this.#settling(turn, work);
  }

  async #afterGap(conn: OpencodeConnection, ses: string, turn: Turn | null): Promise<void> {
    const live = () => conn === this.#conn && this.#ses === ses;
    // A child whose `session.created` fell in the gap would never be learned:
    // its requests and forms ignored, a foreground one blocking the turn.
    // Running is what the server runs now, not the stored times: a child a
    // dead server left behind stays `busy` for good.
    const [listed, active] = await Promise.all([
      conn.client.childSessions(ses).catch(() => {
        // A child the gap created would go uncounted.
        this.#gapUnread(turn);
        return [] as OcSessionInfo[];
      }),
      conn.client.activeSessions().catch(() => ({})),
    ]);
    if (!live()) return;
    for (const info of listed) {
      if (this.#children.has(info.id) || info.parentID !== ses) continue;
      if (!(info.id in active) && (info.time?.created ?? 0) < this.#attachedAt) continue; // an old one, not running since codeoid attached
      this.#childCreated(info.id, { agent: info.agent, title: info.title });
    }
    // Children first: a foreground one's spend belongs to the turn its parent's read-back may end.
    await Promise.all(
      [...this.#children.entries()]
        .filter(([, c]) => c.running)
        .map(([id, c]) =>
          this.#readBackChild(conn, id, c).catch((err: unknown) => {
            console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] reading back subagent ${id} after a feed gap failed: ${err instanceof Error ? err.message : String(err)}`);
            this.#gapUnread(turn);
          }),
        ),
    );
    if (!live()) return;
    if (turn) await this.#reconcile(conn, turn);
    else await this.#adoptMissed(conn, ses);
    if (!live()) return;
    // What was asked in the gap, after what was said before it: a card
    // comes after the reasoning and text that led to its call, and the
    // cards in the order opencode made the requests (as it lists them).
    for (const sid of [ses, ...this.#children.keys()]) {
      const [reqs, forms] = await Promise.all([conn.client.pendingPermissions(sid).catch(() => []), conn.client.pendingForms(sid).catch(() => [])]);
      if (!live()) return;
      for (const r of reqs) {
        await new Promise<void>((shown) => {
          void this.#onAsk(r, { missed: true, onShown: shown })
            .catch(() => {})
            .finally(shown);
        });
      }
      for (const f of forms) void this.#onForm(f).catch(() => {});
    }
  }

  /**
   * A child after a feed gap (its events are ephemeral to this session, so
   * nothing replays them): the cards of its calls that settled, its steps
   * that ended (each once), and its end if it's idle now.
   */
  async #readBackChild(conn: OpencodeConnection, id: string, child: Child): Promise<void> {
    // Whether it runs first: once it doesn't, the messages read after are final.
    const [info, running] = await Promise.all([conn.client.getSession(id), this.#runsNow(conn, id)]);
    const messages: OcMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < RECONCILE_PAGES; page++) {
      const res = await conn.client.recentMessages(id, cursor);
      messages.push(...(res.data ?? []));
      cursor = res.cursor?.next;
      if (!cursor) break;
    }
    if (this.#children.get(id) !== child || !child.running) return;
    for (const m of messages.reverse()) {
      if (m.type !== "assistant") continue;
      for (const block of m.content ?? []) if (block.type === "tool") this.#settleReadBack(id, m, block);
      // A step that ended before codeoid attached was billed then, or to nobody here: a child continued by its id carries its earlier turns'.
      if (!this.#countedSteps.has(m.id) && stepEnded(m) && (m.time?.completed ?? m.time?.created ?? 0) >= this.#attachedAt) {
        remember(this.#countedSteps, m.id);
        this.#stepSettled(m.id, m.tokens, m.cost, m.error, answeredMessage(m));
        this.#recordStep(m.tokens, m.cost, false, this.#stepModel(m.id, m.model));
      }
    }
    if (!running && info.time?.busy !== undefined) this.#childEnded(id, child, info.outcome ?? "succeeded");
  }

  /**
   * No turn was open, and opencode ran an execution by itself in the gap (a
   * background subagent's result): it is adopted as a turn and read back, so
   * its reply reaches the session's history and its spend its turn.
   */
  async #adoptMissed(conn: OpencodeConnection, ses: string): Promise<void> {
    if (this.#executing || !this.onSessionEvent) return;
    const info = await conn.client.getSession(ses);
    if (conn !== this.#conn || this.#ses !== ses || this.#turn || this.#executing) return;
    const busy = info.time?.busy;
    if (busy === undefined || busy <= this.#lastEndAt) return; // nothing ran that the feed didn't show
    this.#executing = true;
    const turn = this.#adoptTurn(busy);
    if (turn) await this.#reconcile(conn, turn);
  }

  /**
   * After a gap in the feed. The turn's messages are read back from the
   * session, and what the feed didn't deliver is emitted: the blocks of
   * every message whose response ended (of one still being written, all but
   * its last block, which is read again when its step ends — #catchUp), the
   * steps that ended, and the cards of calls that settled. A turn whose
   * execution ended in the gap would wait forever: if the session went idle
   * after the turn began, it ends as opencode says it did — unless a message
   * pushed behind the execution waits to run in the next one, as when the
   * feed shows the end.
   */
  async #reconcile(conn: OpencodeConnection, turn: Turn): Promise<void> {
    const ses = this.#ses;
    if (!ses) return;
    let info: OcSessionInfo;
    try {
      info = await conn.client.getSession(ses);
    } catch (err) {
      if (err instanceof OpencodeHttpError && err.status === 404 && this.#turn === turn) this.#failTurn(turn, `opencode: session ${ses} no longer exists`);
      else this.#gapUnread(turn);
      return;
    }
    if (this.#turn !== turn || turn.queue.closed || this.#ses !== ses) return;
    const { busy, idle } = info.time ?? {};
    // A turn opencode started was seen after it began; a prompted one began before.
    const since = turn.since ?? (turn.adopted ? turn.startedAt - 5_000 : turn.startedAt);
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
    const chronological = mine.reverse();
    let lastReply = -1;
    chronological.forEach((m, i) => {
      if (m.type === "assistant") lastReply = i;
    });
    for (const [i, m] of chronological.entries()) {
      // Stored after the ended execution's last reply: opencode runs it in
      // an execution of its own, which hasn't started. It stays owed or
      // queued, as if the feed had shown the end (#executionEnded).
      if (m.type === "user" && ended && i > lastReply) continue;
      if (m.type === "user") {
        // opencode stores an input as it delivers it, under its inbox id: a
        // steer delivered in the gap is paid here, where its answer begins.
        turn.delivered.add(m.id);
        turn.queued.delete(m.id);
        if (turn.steers.delete(m.id) && turn.owed > 0) this.#payBoundary(turn);
        continue;
      }
      if (m.type !== "assistant") continue;
      // A step the running execution stored: its start fell in the gap.
      if (this.#stepSeen === false && (m.time?.created ?? 0) >= busy) this.#stepSeen = true;
      if (ended) {
        turn.lastAssistantMessageID = m.id;
        // The last step's finish is the turn's (the feed may have shown only an earlier one).
        if (m.finish) turn.finish = m.finish;
      }
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
    this.#foreign = false;
    this.#lastEndAt = Math.max(this.#lastEndAt, idle ?? 0, Date.now());
    // Steers delivered and answered in the gap were paid above. As when the
    // feed shows the end: one still owed, or a `later` message still queued,
    // runs in the next execution, still this turn's.
    const outcome = info.outcome ?? (lastError ? "failed" : "succeeded");
    this.#executionEnded(turn, outcome, outcome === "failed" ? lastError : undefined);
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
      } else if (block.type === "tool") {
        this.#settleReadBack(ses, m, block);
      }
    }
    if (!this.#countedSteps.has(m.id) && stepEnded(m)) {
      remember(this.#countedSteps, m.id);
      addTokens(this.#counted, m.tokens, m.cost);
      this.#stepSettled(m.id, m.tokens, m.cost, m.error, answeredMessage(m));
      this.#recordStep(m.tokens, m.cost, true, this.#stepModel(m.id, m.model));
    }
    return open !== undefined;
  }

  /**
   * A call of session `sid` read back after a feed gap that has settled: its
   * card completes, and it's judged as the feed would have had it — one that
   * ran without asking codeoid (its announcement fell in the gap with it:
   * a subagent created in the gap runs with the server's environment until
   * codeoid learns of it) stops the server. One already settled, or made
   * before codeoid attached, isn't news.
   */
  #settleReadBack(sid: string, m: OcMessage, block: NonNullable<OcMessage["content"]>[number]): void {
    const state = block.state;
    if (!block.id || (state?.status !== "completed" && state?.status !== "error")) return;
    const key = `${sid}:${block.id}`;
    if (!this.#announced.has(key)) {
      if (this.#settledCalls.has(key) || (m.time?.created ?? 0) < this.#attachedAt) return;
      if (block.name && state.input && typeof state.input === "object" && !Array.isArray(state.input)) this.#recordCall(sid, block.id, { name: block.name, input: state.input });
    }
    if (state.status === "completed") this.#toolSettled(sid, { id: block.id, content: state.content, metadata: state.metadata }, true);
    else this.#toolSettled(sid, { id: block.id, content: state.content, error: state.error, metadata: state.metadata }, false);
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
    this.#withdrawForms(() => true);
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
    this.#foreign = false;
    this.#children.clear();
    this.#learning.clear();
    // The next attach sets each session's rules again.
    this.#fences.clear();
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

  /**
   * Stop the background shells of `sessions` (opencode's `shell` with
   * `background`): they outlive the call, and the one that finishes wakes
   * its session with nobody attached — the wake's requests then wait
   * forever, and the next turn's prompt queues behind them. Returns how
   * many were stopped (each still wakes its session, at once).
   */
  async #stopShells(conn: OpencodeConnection, directory: string, sessions: ReadonlySet<string>): Promise<number> {
    let listed: Awaited<ReturnType<typeof conn.client.shells>>;
    try {
      listed = await conn.client.shells(directory);
    } catch (err) {
      console.error(`[opencode-provider ${this.#sessionId.slice(0, 8)}] couldn't list background shells to stop: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    const mine = listed.filter((sh) => sh.status === "running" && sessions.has(String(sh.metadata?.sessionID ?? "")));
    await Promise.all(mine.map((sh) => conn.client.removeShell(sh.id, directory).catch(() => {})));
    return mine.length;
  }

  async teardown(): Promise<void> {
    this.#stopping = true;
    try {
      await this.#teardown();
    } finally {
      this.#stopping = false;
    }
  }

  async #teardown(): Promise<void> {
    this.#epoch++;
    const turn = this.#turn;
    const conn = this.#conn;
    const ses = this.#ses;
    // The session stays (the next turn resumes it), and opencode would
    // deliver an input still in its inbox with whatever is prompted next, as
    // after an interrupt (#interrupt): withdrawn before this returns.
    const withdrawn = turn ? this.#withdrawPushed(turn) : [];
    if (turn) this.#closeTurn(turn, "teardown");
    this.#turn = null;
    const pending = [...this.#pendingAsks.entries()];
    this.#pendingAsks.clear();
    for (const [, ask] of pending) ask.abort.abort();
    this.#withdrawForms(() => true);
    if (conn) {
      // Detached from codeoid, opencode would keep running them unobserved
      // on the shared server: the execution, and the subagents — Session
      // counts a torn-down backend's background work as gone with it.
      const running = [...this.#children.entries()].filter(([, c]) => c.running);
      const stops = [...(ses && this.#executing ? [ses] : []), ...running.map(([id]) => id)].map((id) => conn.client.interrupt(id).catch(() => {}));
      const shells = ses && this.#workdir ? this.#stopShells(conn, this.#workdir, new Set([ses, ...this.#children.keys()])) : Promise.resolve(0);
      const [, stoppedShells] = await Promise.race([Promise.all([Promise.all(stops), shells]), Bun.sleep(2_000).then(() => [undefined, 1] as const)]);
      if (running.some(([, c]) => c.background) || stoppedShells > 0) {
        // opencode hands a stopped background subagent's result, and a
        // stopped background shell's, to its session and runs it: that
        // execution is stopped too (#onDurable), so wait for the subagents'
        // ends and the wake that follows.
        const until = Date.now() + TEARDOWN_SETTLE_MS;
        while (Date.now() < until && running.some(([, c]) => c.running)) await Bun.sleep(25);
        await Bun.sleep(WAKE_GRACE_MS);
      }
      // A request the interrupts didn't drop would wait forever: refused (one already gone answers 404, ignored).
      const replies = pending.map(([id, ask]) => this.#reply(conn, { id, sessionID: ask.sessionID } as OcPermissionRequest, "reject", "codeoid stopped this session's backend; this wasn't run."));
      await Promise.race([Promise.all(replies), Bun.sleep(2_000)]);
    }
    // An attach in flight mounts nothing more once it sees the teardown; one
    // already mounting is waited out, so what it mounted is unmounted here
    // and its token revoked below.
    if (this.#attaching) await Promise.race([this.#attaching.catch(() => {}), Bun.sleep(ATTACH_WAIT_MS)]);
    // A prompt still being posted is waited out too (bounded): one that lands
    // after this is stopped by #post, here, before a turn that follows the
    // teardown can prompt the same opencode session.
    // So is a message pushed mid-turn whose request is still out: #send
    // withdraws one that lands now.
    if (turn) await Promise.race([Promise.all([turn.posted, ...turn.settling, ...withdrawn]), Bun.sleep(ATTACH_WAIT_MS)]);
    const dir = this.#workdir;
    if (conn && dir) await Promise.race([this.#unmount(conn, dir), Bun.sleep(2_000)]);
    // The opencode session stays: the next turn resumes it by id.
    this.#ses = null;
    this.#workdir = null;
    this.#executing = false;
    this.#stepSeen = null;
    this.#foreign = false;
    this.#children.clear();
    this.#learning.clear();
    this.#fences.clear();
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

/** A step that ended (its message holds its final cost and tokens). */
function stepEnded(m: OcMessage): boolean {
  return (m.finish !== undefined || m.time?.completed !== undefined) && (m.cost !== undefined || m.tokens !== undefined);
}

/** An opencode session that couldn't be bound to the directory the codeoid session works in. */
class UnmovedError extends Error {}

/** A session executing, by its stored times: busy since it last went idle (a dead server's session stays so). */
function sessionRunning(info: OcSessionInfo): boolean {
  const { busy, idle } = info.time ?? {};
  return busy !== undefined && (idle === undefined || idle < busy);
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

