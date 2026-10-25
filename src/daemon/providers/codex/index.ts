/**
 * CodexProvider — OpenAI Codex CLI as a codeoid backend.
 *
 * Drives `codex app-server` (JSON-RPC over stdio, see rpc.ts) so codex's
 * own harness does the work — tools, sandbox, ChatGPT-subscription auth in
 * ~/.codex — while codeoid owns approvals, scrollback, and history.
 * First slice (see docs/provider-codex-design.md):
 *
 *   - warm process; one codex THREAD per backing session (thread id is the
 *     backingSessionId; resetToNewSession starts a fresh thread)
 *   - the codeoid session MODE drives codex's native `approvalPolicy` on every
 *     thread/turn start (see codexPolicies()), so switching modes actually
 *     reconfigures the backend rather than only changing what codeoid's gate
 *     does with codex's approval requests:
 *       · guarded / interactive → `untrusted`: codex asks before privileged
 *         actions and each request routes through codeoid's canUseTool
 *         (approve/deny natively, no injected bridge unlike pi) so codeoid
 *         prompts the user;
 *       · autonomous → `never`: codex runs unattended with NO per-action
 *         approval round-trip. codeoid records each action retrospectively at
 *         item/completed (see below) so scrollback + history stay honest.
 *   - the sandbox mode `danger-full-access` is pinned (as codex's
 *     internally-tagged `{type:"dangerFullAccess"}` wire value, via
 *     sandboxPolicyWire()) so codex EXECUTES actions with full access
 *     (including network) instead of re-sandboxing them. codeoid's mode is the
 *     trust authority; codex's own bundled-bubblewrap sandbox is redundant with
 *     it AND non-portable — it needs unprivileged user namespaces that
 *     containers and hardened hosts (`apparmor_restrict_unprivileged_userns=1`)
 *     forbid, and when bwrap can't initialize even an APPROVED command dies
 *     inside codex with "command execution rejected / cannot escalate".
 *     Operators on a bwrap-capable host who want defense-in-depth can override
 *     both the mode-derived approval policy and the sandbox via
 *     CODEX_APPROVAL_POLICY / CODEX_SANDBOX_POLICY (see codexPolicies()).
 *   - `item/tool/requestUserInput` → requestUserInput (session.ui_request)
 *   - text/reasoning deltas stream; command/fileChange/mcp items surface
 *     as tool records; usage from turn/completed
 *   - continueNatively (#387): the thread is created by `thread/fork` at a
 *     recorded turn (same backend) or `thread/start` + `thread/inject_items`
 *     (native history from another backend); thread ids are persisted
 *   - seedFromHistory prepends renderHistorySeed to the first prompt — the
 *     fallback when the native path is off or fails
 *
 * Non-gated items (codex ran something its policy considers trusted, e.g.
 * read-only commands) are recorded retrospectively at item/completed as a
 * paired tool_start/tool_complete — visible in scrollback + canonical
 * history without pretending codeoid gated them.
 */

import type { McpTenant } from "../../mcp/oauth.js";
import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../../async-queue.js";
import type { Store } from "../../store.js";
import type {
  ModelInfo,
  NativeContinuationRequest,
  NativeContinuationResult,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  ToolApprovalFn,
  TurnOpts,
  TurnRun,
  UiRequestFn,
  CatalogEntry,
} from "../interface.js";
import { renderHistorySeed, type CanonicalTurn, type HistorySeedResult } from "../canonical.js";
import { type ResponsesItem, toResponsesItems } from "./native-history.js";
import { buildCodexEnv, withExtraEnv } from "../env.js";
import { CodexRpcProcess } from "./rpc.js";
import { EFFORT_LEVELS, type EffortLevel, type SessionMode } from "../../../protocol/types.js";
import { MEMORY_MCP_SERVER_NAME, MEMORY_MCP_TOKEN_ENV, type MemoryMcpMount } from "../../memory/mcp-http.js";
import {
  BLACKBOARD_MCP_SERVER_NAME,
  BLACKBOARD_MCP_TOKEN_ENV,
} from "../../blackboard/mcp-http.js";
import type { McpServerView } from "../../mcp/registry.js";
import { MCP_PROXY_TOKEN_ENV, McpProxyLease, type McpProxyMount } from "../../mcp/proxy.js";
import { codexKeySafe, codexShellEnvExcludeArgs } from "./shell-env.js";
import { resolveEnvMap } from "../../mcp/types.js";
import type { ResolvedAccount } from "../../accounts.js";
import { applyCodexAccount } from "../../account-apply.js";

/** codex `tokenUsage.last` / `.total` shape (thread/tokenUsage/updated). */
interface CodexTokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexProviderInit {
  sessionId: string;
  /** codex thread id from a previous run, or the codeoid session id on first run. */
  initialBackingId: string;
  /** Resolved binary (see resolve.ts). */
  command: string;
  argsPrefix?: string[];
  store: Store;
  /** Tenant-scoped memory workspace id — the scope a mounted memory token binds to. */
  workspaceId?: string;
  /** The session's tenant — whose credentials an OAuth MCP server uses. */
  tenant?: McpTenant;
  /**
   * Shared in-daemon memory MCP endpoint + URL. When present (memory enabled),
   * the provider mounts it on the app-server via `-c mcp_servers.*` overrides so
   * codex can page the verbatim store on demand — the precondition for VWS.
   */
  memoryMcp?: MemoryMcpMount;
  /** The daemon's OAuth MCP relay (#396): how this backend reaches the
   *  registry's OAuth servers without holding their tokens. */
  mcpProxy?: McpProxyMount;
  /**
   * Role-scoped goal-blackboard mount, resolved LAZILY.
   *
   * A getter rather than a value because the orchestrator's own mount is
   * scoped to a goal id that IS its session id — so it cannot exist until
   * after the Session is constructed. Providers read it when they build their
   * server list (per turn for claude), by which time it is set.
   */
  blackboardMcp?: () => { url: string; token: string } | undefined;

  /** Cross-backend MCP registry — external servers mount natively via `-c
   *  mcp_servers.*` (codex owns its client); approval flows through canUseTool. */
  mcpRegistry?: McpServerView;
  /**
   * This session's account for the backend, resolved when the process is
   * spawned (accounts.ts); null = the daemon's own login. Throws when the
   * chosen account can't be used — the turn fails, never another credential.
   */
  resolveAccount?: () => ResolvedAccount | null;
  onModels?: (models: ReadonlyArray<CatalogEntry>) => void;
  /** Caller env for the child process (ProviderSessionInit.extraEnv), merged last via withExtraEnv. */
  extraEnv?: Readonly<Record<string, string>>;
}

/** Item types that surface as tool records (vs text/reasoning streams). */
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "tool",
]);

/**
 * codex `approvalPolicy` (AskForApproval) — the string variants of the
 * app-server v2 enum. `on-failure` is NOT one of them (verified against
 * @openai/codex@0.144.1 `generate-ts`: it's `"untrusted" | "on-request" |
 * {granular} | "never"`); the object `granular` form is not exposed via env.
 */
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

/**
 * Operator-facing sandbox modes (config.toml / CLI spelling). Mapped to
 * codex's internally-tagged `SandboxPolicy` wire enum by sandboxPolicyWire().
 */
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
const SANDBOX_MODES = new Set<SandboxMode>(["read-only", "workspace-write", "danger-full-access"]);

/**
 * Map the codeoid session {@link SessionMode} to codex's native approval policy.
 * This is what makes a mode switch reconfigure the backend:
 *   - `autonomous` → `never`: codex runs unattended, no per-action approval
 *     round-trip (codeoid records each action retrospectively at item/completed).
 *   - `guarded` / `interactive` → `untrusted`: codex asks before privileged
 *     actions and each request routes through codeoid's canUseTool so codeoid
 *     prompts the user. (codex has no "ask for read-only ops too" policy, so
 *     interactive degrades to untrusted at the codex layer; codeoid's gate
 *     still prompts for everything codex does ask about.)
 *   - absent → `untrusted` (treated as guarded).
 */
function approvalPolicyForMode(mode: SessionMode | undefined): string {
  return mode === "autonomous" ? "never" : "untrusted";
}

/**
 * The approval policy + sandbox MODE codeoid pins on codex thread/turn starts.
 *
 * The session mode drives the defaults (see {@link approvalPolicyForMode} and
 * the file header). The sandbox is `danger-full-access` in every mode so codex
 * EXECUTES actions with full access instead of re-sandboxing them — codeoid's
 * mode + canUseTool gate is the trust authority, not codex's bubblewrap.
 *
 * Both are overridable via env, which WINS over the mode-derived value: an
 * operator on a bubblewrap-capable host who wants codex's sandbox as
 * defense-in-depth (or a pinned approval policy) sets CODEX_SANDBOX_POLICY /
 * CODEX_APPROVAL_POLICY and it holds regardless of mode. An unknown value falls
 * back to the mode-derived default rather than letting codex reject the start.
 */
function codexPolicies(mode?: SessionMode): { approvalPolicy: string; sandboxMode: SandboxMode } {
  const approval = process.env.CODEX_APPROVAL_POLICY?.trim();
  const sandbox = process.env.CODEX_SANDBOX_POLICY?.trim() as SandboxMode | undefined;
  return {
    approvalPolicy: approval && APPROVAL_POLICIES.has(approval) ? approval : approvalPolicyForMode(mode),
    sandboxMode: sandbox && SANDBOX_MODES.has(sandbox) ? sandbox : "danger-full-access",
  };
}

/**
 * Map an operator-facing {@link SandboxMode} to codex's `SandboxPolicy` wire
 * value — an INTERNALLY-TAGGED enum (`{type: "..."}`, camelCase variants), NOT
 * the bare kebab string. Sending the string trips codex with
 * `invalid type: string "...", expected internally tagged enum
 * SandboxPolicyDeserialize` at turn/start. Shapes verified live against
 * @openai/codex@0.144.1 `generate-ts` + a real turn.
 */
/** What a new thread (started or forked) is created with: cwd, policies, the turn's instructions. */
function threadConfig(opts: TurnOpts): Record<string, unknown> {
  const { approvalPolicy, sandboxMode } = codexPolicies(opts.mode);
  return {
    cwd: opts.workdir,
    approvalPolicy,
    sandboxPolicy: sandboxPolicyWire(sandboxMode, opts.workdir),
    ...(opts.systemPromptAppend ? { developerInstructions: opts.systemPromptAppend } : {}),
  };
}

function sandboxPolicyWire(mode: SandboxMode, workdir: string): Record<string, unknown> {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [workdir],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    default: // "danger-full-access" — codeoid is the trust authority.
      return { type: "dangerFullAccess" };
  }
}

/**
 * Best-effort human-readable text for a codex `error` notification.
 *
 * Deliberately tolerant of shape rather than asserting one: the payload has
 * carried a bare `message` string in some versions and a JSON-RPC-style
 * `{code, message, data}` object in others, and a wrong assumption here costs
 * the entire diagnostic. Falls back to bounded JSON so an unrecognised shape
 * still tells the operator something.
 */
export function describeCodexError(params: Record<string, unknown>): string {
  const direct = params.message;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const err = params.error;
  if (typeof err === "string" && err.length > 0) return err;
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; code?: unknown; data?: unknown };
    const msg = typeof o.message === "string" ? o.message : undefined;
    const code = o.code !== undefined ? ` (code ${String(o.code)})` : "";
    if (msg) return `${msg}${code}`;
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return "unserializable error payload";
    }
  }
  try {
    const dump = JSON.stringify(params);
    return dump && dump !== "{}" ? dump.slice(0, 500) : "unspecified codex error";
  } catch {
    return "unspecified codex error";
  }
}

export class CodexProvider implements SessionProvider {
  /**
   * codex's approval replies carry only a decision (`approved` / `accept`) —
   * codex runs the input IT proposed, so a rewrite can't apply (#367).
   */
  readonly appliesToolInputRewrite = false;
  readonly id = "codex";
  readonly displayName = "Codex (OpenAI)";

  onRecoveryNeeded: ((content: string) => void) | undefined;
  onHistoryLost: (() => void) | undefined;

  #sessionId: string;
  #backingSessionId: string;
  #command: string;
  #argsPrefix: string[];
  #resolveAccount: (() => ResolvedAccount | null) | null;
  readonly #extraEnv: Readonly<Record<string, string>> | undefined;
  #onModels?: CodexProviderInit["onModels"];
  #workspaceId: string;
  #memoryMcp: MemoryMcpMount | null;
  /** Role-scoped blackboard mount; token minted+revoked by the SessionManager. */
  readonly #blackboardMcp: (() => { url: string; token: string } | undefined) | null;
  #mcpRegistry: McpServerView | null;
  /** Live scoped token for the mounted memory endpoint; revoked on teardown. */
  #memoryToken: string | null = null;

  #proc: CodexRpcProcess | null = null;
  #threadId: string | null = null;
  /** Each model's default effort from model/list, the model the thread runs, and the
   *  user's own configured effort (config/read) — what Default sends (#417). */
  readonly #modelDefaultEffort = new Map<string, string>();
  /** Each model's efforts on codeoid's scale, from model/list. */
  readonly #modelEfforts = new Map<string, EffortLevel[]>();
  #threadModel: string | null = null;
  #configEffort: string | null | undefined = undefined;
  /** The baseline last worked out, for the session's pickers. */
  #defaultEffort: string | null = null;
  #modelListTried = false;
  #hasQueried = false;
  #modelsReported = false;
  #pendingHistorySeed: string | null = null;
  readonly #store: Store;
  /**
   * A native continuation to apply when the thread is first created (#387):
   * fork the backend's own thread at a turn, or start one and inject history.
   * Deferred to the first turn because the thread takes that turn's
   * instructions. `fallback` is the transcript seed used if it fails.
   */
  #pendingNative: { kind: "fork"; threadId: string; turnId: string; fallback: string | null } | { kind: "inject"; items: ResponsesItem[]; fallback: string | null } | null = null;

  // Per-turn wiring.
  #turnQueue: AsyncQueue<ProviderEvent> | null = null;
  #canUseTool: ToolApprovalFn | null = null;
  #requestUserInput: UiRequestFn | undefined;
  #turnStartedAt = 0;
  #turnModel = "codex";
  #currentTurnId: string | null = null;
  /**
   * Latest per-turn token usage from `thread/tokenUsage/updated`. codex's
   * `turn/completed` carries NO usage (verified live) — it arrives on the
   * separate token-usage notification, `tokenUsage.last` being this turn's
   * counts. Captured here and folded into turn_done.
   */
  #lastTokenUsage: CodexTokenUsage | null = null;
  /** Window codex reported for the model driving this thread, if it has. */
  #modelContextWindow: number | null = null;
  /** item id → {name, input} for items already announced via tool_start. */
  #announcedItems = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Items codeoid's gate declined: their card is already cancelled, so codex's
   *  own `declined` completion for them must not overwrite it (#369). */
  #declinedItems = new Set<string>();
  /**
   * What each command / file-change item will DO, from its `item/started`
   * notification, keyed by item id. codex 0.154's approval requests don't
   * carry the diff (and may omit the command) — this is the only place the
   * approver's view of the change can come from (#369).
   */
  #startedItems = new Map<string, Record<string, unknown>>();
  /** Approved sibling callbacks (`${itemId}:${approvalId}`) still open, by parent
   *  item id. codex completes only the PARENT, so its completion closes them. */
  #openSubApprovals = new Map<string, Set<string>>();
  /** Parent items codex has completed this turn — a sibling approval answered
   *  after its parent finished must not report as run (#369). */
  #completedParents = new Set<string>();
  /** Items with an approval being decided, and those whose patch changed
   *  meanwhile: the approver saw the earlier diff, so the yes doesn't cover the
   *  new one — declined instead (#369). */
  #approvalsInFlight = new Map<string, number>();
  #patchChangedInFlight = new Set<string>();
  /**
   * serverName → the most-recent mcpToolCall item awaiting its approval
   * elicitation. codex gates an MCP tool call with `mcpServer/elicitation/request`,
   * which names the SERVER but not the tool; the `item/started` (mcpToolCall)
   * that fires just before it carries both, so we correlate here to build the
   * canonical `mcp__<server>__<tool>` name the approval gate + isSafeTool key off.
   */
  /** MCP calls codex started and may elicit approval for, oldest first, by
   *  server. A LIST: two calls to one server can be in flight at once, and the
   *  elicitation names only the server (#368). */
  #pendingMcpCalls = new Map<string, Array<{ itemId: string; tool: string; input: Record<string, unknown> }>>();
  /** This backend's proxy token for the registry's OAuth servers. */
  readonly #proxy: McpProxyLease;

  constructor(init: CodexProviderInit) {
    this.#store = init.store;
    this.#sessionId = init.sessionId;
    this.#backingSessionId = init.initialBackingId;
    this.#command = init.command;
    this.#resolveAccount = init.resolveAccount ?? null;
    this.#extraEnv = init.extraEnv;
    this.#argsPrefix = init.argsPrefix ?? [];
    this.#onModels = init.onModels;
    this.#workspaceId = init.workspaceId ?? init.sessionId;
    this.#memoryMcp = init.memoryMcp ?? null;
    this.#blackboardMcp = init.blackboardMcp ?? null;
    this.#mcpRegistry = init.mcpRegistry ?? null;
    this.#proxy = new McpProxyLease(
      init.mcpProxy,
      init.tenant ? { tenant: init.tenant, sessionId: init.sessionId, backendId: this.id } : null,
    );
  }

  /**
   * True when the shared memory endpoint is mounted for this session, so codex
   * can page the verbatim store on demand. The Verbatim Working Set strategy
   * seeds a compact session map only when this holds; otherwise the session
   * falls back to the transcript seed.
   */
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

  resetToNewSession(newBackingId: string): void {
    // A fresh backing session starts from nothing: a seed queued for the
    // previous one (a backend switch, a rewind) must not ride along (#355).
    this.#pendingHistorySeed = null;
    this.#pendingNative = null;
    this.#backingSessionId = newBackingId;
    this.#threadId = null;
    this.#hasQueried = false;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  seedFromHistory(history: readonly CanonicalTurn[], opts?: { maxChars?: number }): HistorySeedResult {
    const seed = renderHistorySeed(history, { maxChars: opts?.maxChars });
    this.#pendingHistorySeed = seed.text.length > 0 ? seed.text : null;
    return seed;
  }

  /**
   * VWS transport: prepend a strategy-built block (the compact session map) to
   * the next prompt — the same channel seedFromHistory uses. The session decides
   * transcript vs session map; the provider just stashes the block.
   */
  seedText(block: string): void {
    this.#pendingHistorySeed = block.length > 0 ? block : null;
  }

  /**
   * Continue a conversation natively (#387): fork this backend's own thread
   * at the recorded turn when there is one, else inject codeoid's history as
   * Responses items into a fresh thread. Applied when the thread is created
   * on the first turn (it takes that turn's instructions); if it fails then,
   * the turn says so and falls back to the transcript seed rendered here.
   */
  async continueNatively(req: NativeContinuationRequest): Promise<NativeContinuationResult | null> {
    const fallback = renderHistorySeed(req.history, { maxChars: req.maxChars }).text || null;
    this.#pendingHistorySeed = null;
    if (req.forkFrom) {
      this.#pendingNative = { kind: "fork", threadId: req.forkFrom.backingId, turnId: req.forkFrom.ref, fallback };
      return { via: "fork" };
    }
    if (req.allowHistory === false) return null;
    const { items, truncation } = toResponsesItems(req.history, { maxChars: req.maxChars });
    if (items.length === 0) return null;
    this.#pendingNative = { kind: "inject", items, fallback };
    return { via: "history", ...(truncation.omittedTurns > 0 || truncation.newestTurnSliced ? { truncation } : {}) };
  }

  /**
   * Create the thread a pending native continuation asks for. Returns its id,
   * or null after falling back to the transcript (and telling the turn why).
   */
  async #applyPendingNative(opts: TurnOpts): Promise<string | null> {
    const pending = this.#pendingNative;
    this.#pendingNative = null;
    if (!pending || !this.#proc) return null;
    const config = threadConfig(opts);
    try {
      if (pending.kind === "fork") {
        const forked = (await this.#proc.request("thread/fork", {
          threadId: pending.threadId,
          lastTurnId: pending.turnId,
          // Don't stream the whole thread back over stdio; only its id is used.
          excludeTurns: true,
          ...config,
        })) as { thread?: { id?: string }; model?: string };
        if (!forked.thread?.id) throw new Error("thread/fork returned no thread id");
        this.#threadModel = forked.model ?? null;
        this.#configEffort = undefined;
        return forked.thread.id;
      }
      const started = (await this.#proc.request("thread/start", config)) as { thread?: { id?: string }; model?: string };
      if (!started.thread?.id) throw new Error("thread/start returned no thread id");
      this.#threadModel = started.model ?? null;
      this.#configEffort = undefined;
      await this.#proc.request("thread/inject_items", { threadId: started.thread.id, items: pending.items });
      return started.thread.id;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[codex-provider ${this.#sessionId.slice(0, 8)}] native ${pending.kind} failed, using the transcript: ${why}`);
      this.#pendingHistorySeed = pending.fallback;
      // The cause stays in the daemon log: backend errors name rollout paths
      // and thread ids, and every attached client (watchers too) sees this.
      this.#push({
        type: "custom_message",
        content: "⚠️ Codex couldn't take this conversation as its own history, so it continues from a text transcript of it instead.",
        metadata: { event: "history.native_fallback", providerId: this.id },
      });
      return null;
    }
  }

  /**
   * `-c` config overrides + token env that mount the shared memory endpoint on
   * the codex app-server (`--url` streamable-HTTP MCP server, bearer token read
   * from an env var so it never lands in argv). Minted fresh per app-server
   * spawn — the token is this session's tenant scope; revoked on teardown.
   */
  #memoryMcpSpawn(): { args: string[]; env: Record<string, string> } {
    const mount = this.#memoryMcp;
    if (!mount) return { args: [], env: {} };
    if (this.#memoryToken) mount.endpoint.revoke(this.#memoryToken);
    this.#memoryToken = mount.endpoint.mint({
      workspaceId: this.#workspaceId,
      sessionId: this.#sessionId,
    });
    const key = `mcp_servers.${MEMORY_MCP_SERVER_NAME}`;
    return {
      // The `-c` value parses as TOML — JSON.stringify yields a valid TOML
      // string literal (quoted). Verified live against codex app-server.
      args: [
        "-c", `${key}.url=${JSON.stringify(mount.url)}`,
        "-c", `${key}.bearer_token_env_var=${JSON.stringify(MEMORY_MCP_TOKEN_ENV)}`,
      ],
      env: { [MEMORY_MCP_TOKEN_ENV]: this.#memoryToken },
    };
  }

  /**
   * `-c mcp_servers.codeoid_blackboard.*` — the role-scoped goal blackboard for
   * a collaboration child, same TOML shape as the memory mount above.
   *
   * No mint/revoke here: the SessionManager owns this token, because the scope
   * it carries belongs to the collaboration rather than to a codex backing
   * session that may be recreated mid-goal.
   */
  #blackboardMcpSpawn(): { args: string[]; env: Record<string, string> } {
    const mount = this.#blackboardMcp?.();
    if (!mount) return { args: [], env: {} };
    const key = `mcp_servers.${BLACKBOARD_MCP_SERVER_NAME}`;
    return {
      args: [
        "-c", `${key}.url=${JSON.stringify(mount.url)}`,
        "-c", `${key}.bearer_token_env_var=${JSON.stringify(BLACKBOARD_MCP_TOKEN_ENV)}`,
      ],
      env: { [BLACKBOARD_MCP_TOKEN_ENV]: mount.token },
    };
  }

  /**
   * `-c mcp_servers.*` overrides mounting the registry's external servers on the
   * codex app-server — a native mount, since codex owns its own MCP client.
   * stdio → command/args/env (env as a TOML inline table); http → url +
   * bearer_token_env_var, with the resolved token handed to codex via its env.
   * Built-in memory is mounted separately (#memoryMcpSpawn). Tool calls surface
   * as `mcp__<server>__<tool>` and gate through the elicitation handler.
   */
  #registryMcpArgs(): { args: string[]; env: Record<string, string> } {
    const reg = this.#mcpRegistry;
    if (!reg) return { args: [], env: {} };
    const args: string[] = [];
    const env: Record<string, string> = {};
    for (const spec of reg.forNativeMount(this.id)) {
      if (!codexKeySafe(spec.name)) {
        console.warn(`[codeoid] codex: MCP server "${spec.name}" isn't mounted — codex can't take that name as a config key`);
        continue;
      }
      const key = `mcp_servers.${spec.name}`;
      const t = spec.transport;
      if (t.kind === "stdio") {
        args.push("-c", `${key}.command=${JSON.stringify(t.command)}`);
        if (t.args && t.args.length > 0) args.push("-c", `${key}.args=${JSON.stringify(t.args)}`);
        const resolved = resolveEnvMap(t.env ?? {}, process.env);
        if (Object.keys(resolved).length > 0) args.push("-c", `${key}.env=${tomlInlineTable(resolved)}`);
      } else if (t.kind === "http") {
        args.push("-c", `${key}.url=${JSON.stringify(t.url)}`);
        if (t.bearerTokenEnv) {
          args.push("-c", `${key}.bearer_token_env_var=${JSON.stringify(t.bearerTokenEnv)}`);
          const tok = process.env[t.bearerTokenEnv];
          if (tok) env[t.bearerTokenEnv] = tok;
        }
      }
    }
    return { args, env };
  }

  /**
   * The registry's OAuth servers, through the daemon's relay (#396): each
   * server's relay URL, and the proxy token by env-var name — never on argv,
   * where any local process could read it. Re-minted per app-server spawn
   * (the previous token revoked), revoked on teardown. The commands codex
   * runs don't inherit it (codexShellEnvExcludeArgs).
   */
  #proxyMcpSpawn(): { args: string[]; env: Record<string, string> } {
    const lease = this.#proxy.renew();
    if (!lease) return { args: [], env: {} };
    const args: string[] = [];
    for (const server of lease.servers) {
      if (!codexKeySafe(server.name)) {
        console.warn(`[codeoid] codex: MCP server "${server.name}" isn't mounted — codex can't take that name as a config key`);
        continue;
      }
      const key = `mcp_servers.${server.name}`;
      args.push("-c", `${key}.url=${JSON.stringify(server.url)}`);
      args.push("-c", `${key}.bearer_token_env_var=${JSON.stringify(MCP_PROXY_TOKEN_ENV)}`);
    }
    return { args, env: { [MCP_PROXY_TOKEN_ENV]: lease.token } };
  }

  runTurn(opts: TurnOpts): TurnRun {
    const queue = new AsyncQueue<ProviderEvent>();
    this.#turnQueue = queue;
    this.#canUseTool = opts.canUseTool;
    this.#requestUserInput = opts.requestUserInput;
    this.#turnStartedAt = Date.now();
    this.#turnModel = opts.model ?? "codex";
    this.#announcedItems.clear();
    this.#declinedItems.clear();
    this.#startedItems.clear();
    this.#pendingMcpCalls.clear();
    this.#openSubApprovals.clear();
    this.#completedParents.clear();
    this.#approvalsInFlight.clear();
    this.#patchChangedInFlight.clear();
    this.#lastTokenUsage = null;
    // Per turn, like the usage beside it. This provider instance outlives a
    // `/model` switch or a pipeline overrideModel, so a turn interrupted before
    // its first token-usage notification would otherwise report the PREVIOUS
    // model's window under the new model's id — and that pair was persisted.
    this.#modelContextWindow = null;
    this.#hasQueried = true;

    void this.#startTurn(opts).catch((err: unknown) => {
      this.#push({ type: "error", message: `codex: ${err instanceof Error ? err.message : String(err)}` });
      queue.close();
    });

    return {
      events: queue,
      interrupt: async () => {
        if (this.#proc?.alive && this.#threadId) {
          try {
            await this.#proc.request("turn/interrupt", {
              threadId: this.#threadId,
              ...(this.#currentTurnId ? { turnId: this.#currentTurnId } : {}),
            });
            return;
          } catch {
            /* fall through to hard close */
          }
        }
        queue.close();
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.#proc?.alive) return [];
    try {
      const result = (await this.#proc.request("model/list", {})) as {
        data?: Array<{
          id?: string;
          model?: string;
          displayName?: string;
          description?: string;
          supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
          defaultReasoningEffort?: string;
          isDefault?: boolean;
        }>;
      };
      // Each model's own default effort — what Default falls back to (#417).
      for (const m of result.data ?? []) {
        const id = m.model ?? m.id;
        if (typeof id === "string" && typeof m.defaultReasoningEffort === "string") this.#modelDefaultEffort.set(id, m.defaultReasoningEffort);
        if (typeof id === "string" && Array.isArray(m.supportedReasoningEfforts)) {
          this.#modelEfforts.set(
            id,
            m.supportedReasoningEfforts.map((e) => fromCodexEffort(e?.reasoningEffort)).filter((e): e is EffortLevel => e !== null),
          );
        }
      }
      return (result.data ?? [])
        .filter((m) => typeof (m.model ?? m.id) === "string")
        .map((m) => {
          // The efforts it takes (#417), on codeoid's scale — codex's "none" is Off.
          const efforts = Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts.map((e) => fromCodexEffort(e?.reasoningEffort)).filter((e): e is EffortLevel => e !== null)
            : undefined;
          const defaultEffort = fromCodexEffort(m.defaultReasoningEffort);
          return {
            id: (m.model ?? m.id) as string,
            displayName: m.displayName ?? ((m.model ?? m.id) as string),
            description: m.description,
            ...(efforts ? { efforts } : {}),
            ...(defaultEffort ? { defaultEffort } : {}),
            ...(m.isDefault === true ? { isDefault: true } : {}),
          };
        });
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    await this.teardown();
  }

  async teardown(): Promise<void> {
    this.#pendingMcpCalls.clear();
    this.#turnQueue?.close();
    this.#turnQueue = null;
    this.#proc?.kill();
    this.#proc = null;
    this.#threadId = null;
    if (this.#memoryToken) {
      this.#memoryMcp?.endpoint.revoke(this.#memoryToken);
      this.#memoryToken = null;
    }
    this.#proxy.revoke();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /** What Default means here now (#417): the effort codex would use unasked, once worked out. */
  get defaultEffort(): EffortLevel | null {
    return fromCodexEffort(this.#defaultEffort ?? undefined);
  }

  /** The model the thread runs (codex's configured one, project config included), once known. */
  get runningModel(): string | null {
    return this.#threadModel;
  }

  /** turn/start's effort (#417): the session's, else what codex would use unasked — or nothing when that can't be known. */
  async #effortParam(opts: TurnOpts): Promise<{ effort?: string }> {
    const baseline = await this.#baselineEffort(opts);
    this.#defaultEffort = baseline;
    if (opts.effort) return { effort: toCodexEffort(opts.effort) };
    return baseline ? { effort: baseline } : {};
  }

  /**
   * The effort codex itself uses unasked: the configured one (project layers
   * included) for a model that takes it, else the running model's own — the
   * same rule the catalog shows.
   */
  async #baselineEffort(opts: TurnOpts): Promise<string | null> {
    if (this.#configEffort === undefined) {
      try {
        const read = (await this.#proc!.request("config/read", { cwd: opts.workdir })) as { config?: { model_reasoning_effort?: string | null } };
        this.#configEffort = read.config?.model_reasoning_effort ?? null;
      } catch {
        // Unknown this time; asked again next turn.
      }
    }
    const model = opts.model ?? this.#threadModel;
    if (model && !this.#modelDefaultEffort.has(model) && !this.#modelEfforts.has(model) && !this.#modelListTried) {
      this.#modelListTried = true; // once: a model the list doesn't carry stays unknown
      await this.listModels();
    }
    const takes = model ? this.#modelEfforts.get(model) : undefined;
    const configured = fromCodexEffort(this.#configEffort ?? undefined);
    if (this.#configEffort && (!takes || (configured !== null && takes.includes(configured)))) return this.#configEffort;
    return (model && this.#modelDefaultEffort.get(model)) || null;
  }

  async #startTurn(opts: TurnOpts): Promise<void> {
    await this.#ensureThread(opts);
    const seed = this.#pendingHistorySeed;
    this.#pendingHistorySeed = null;
    const text = seed ? `${seed}\n\n${opts.userMessage}` : opts.userMessage;

    const { approvalPolicy, sandboxMode } = codexPolicies(opts.mode);
    const result = (await this.#proc!.request("turn/start", {
      threadId: this.#threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: opts.workdir,
      // The session mode drives the approval policy (autonomous → codex runs
      // unattended; guarded/interactive → codex asks and codeoid's gate
      // prompts) and codex EXECUTES approved actions with full sandbox access
      // instead of re-sandboxing them (which fails wherever bubblewrap can't
      // init). See codexPolicies().
      approvalPolicy,
      sandboxPolicy: sandboxPolicyWire(sandboxMode, opts.workdir),
      ...(opts.model ? { model: opts.model } : {}),
      // Thinking effort (#417). codex keeps a turn's effort for the turns
      // after it (a resumed thread too), and null there means "no override" —
      // so Default is sent as the effort codex itself would use: the user's
      // configured one, else the running model's own default (the same
      // value codex picks unasked; sending it resets an earlier override).
      ...(await this.#effortParam(opts)),
    })) as { turn?: { id?: string } };
    // codex keeps a turn's model for the turns after it: Default's baseline follows it.
    if (opts.model) this.#threadModel = opts.model;
    this.#currentTurnId = result.turn?.id ?? null;
  }

  async #ensureThread(opts: TurnOpts): Promise<void> {
    if (this.#proc?.alive && this.#threadId) return;

    if (!this.#proc?.alive) {
      // Mount the shared memory endpoint (if enabled) via `-c mcp_servers.*`
      // overrides + a token env var, so codex pages the verbatim store on
      // demand. No CODEX_HOME/auth.json juggling — the default ~/.codex keeps
      // the user's auth + config; these just add the one server.
      const mcp = this.#memoryMcpSpawn();
      const bb = this.#blackboardMcpSpawn();
      const reg = this.#registryMcpArgs();
      const shellEnv = codexShellEnvExcludeArgs();
      // Without the exclude, the proxy token would reach the commands codex runs.
      const oauth = shellEnv ? this.#proxyMcpSpawn() : { args: [], env: {} };
      if (!shellEnv) {
        console.warn(
          "[codeoid] codex: its config.toml couldn't be read here, so codeoid can't add its token variables to shell_environment_policy.exclude — OAuth MCP servers aren't mounted, and codeoid's memory/blackboard tokens rely on Codex's default excludes",
        );
      }
      this.#proc = new CodexRpcProcess({
        command: this.#command,
        argsPrefix: this.#argsPrefix,
        args: [...mcp.args, ...bb.args, ...reg.args, ...oauth.args, ...(shellEnv ?? [])],
        cwd: opts.workdir,
        // The account's own CODEX_HOME (an overlay sharing everything but its
        // auth.json), applied last so nothing re-adds a daemon key.
        // The caller's extra env goes on last (withExtraEnv refuses anything
        // credential- or home-shaped, so the account stays the account).
        env: withExtraEnv(
          await applyCodexAccount(
            this.#resolveAccount?.() ?? null,
            { ...buildCodexEnv(), ...mcp.env, ...bb.env, ...reg.env, ...oauth.env },
            { command: this.#command, argsPrefix: this.#argsPrefix },
          ),
          this.#extraEnv,
        ),
        onNotification: (method, params) => this.#onNotification(method, params),
        onServerRequest: (method, params) => this.#onServerRequest(method, params),
        onExit: ({ code, signal, stderrTail }) => {
          const queue = this.#turnQueue;
          if (queue && !queue.closed) {
            this.#push({
              type: "error",
              message: `codex exited unexpectedly (code=${code} signal=${signal})${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`,
            });
            queue.close();
          }
        },
      });
      await this.#proc.request("initialize", {
        clientInfo: { name: "codeoid", title: "codeoid", version: "1.0" },
      });
      this.#proc.notify("initialized");
    }

    if (this.#pendingNative) {
      // A native continuation (#387) creates the thread itself; if it fails,
      // a fresh thread below takes the transcript instead.
      const native = await this.#applyPendingNative(opts);
      if (native) {
        this.#adoptThread(native);
        await this.#reportModelsOnce();
        return;
      }
    } else if (this.#backingSessionId !== this.#sessionId) {
      // Resume the prior thread when the backing id looks like one codex
      // minted; otherwise (first run: backing id is the codeoid session id)
      // start fresh. Resume failure degrades to a fresh thread — never wedge.
      try {
        const resumed = (await this.#proc.request("thread/resume", {
          threadId: this.#backingSessionId,
        })) as { thread?: { id?: string }; model?: string };
        if (resumed.thread?.id) {
          this.#threadId = resumed.thread.id;
          this.#threadModel = resumed.model ?? null;
          this.#configEffort = undefined;
          return;
        }
      } catch {
        /* fall through to thread/start */
      }
      // The thread is gone (another account's home, a pruned rollout): a
      // fresh one must not start the conversation over — take the history.
      // Unless the session already queued what this thread gets (a switch,
      // rewind or overflow retry chose a transcript or a session map, sized
      // for the model): that is never overwritten.
      if (this.#pendingHistorySeed === null) {
        console.warn(`[codex-provider ${this.#sessionId.slice(0, 8)}] couldn't resume thread ${this.#backingSessionId} — continuing from codeoid's history`);
        this.onHistoryLost?.();
      }
    }
    const started = (await this.#proc.request("thread/start", threadConfig(opts))) as { thread?: { id?: string }; model?: string };
    if (!started.thread?.id) throw new Error("codex thread/start returned no thread id");
    this.#threadModel = started.model ?? null;
    // codex reads its config afresh for each thread; so does Default's baseline.
    this.#configEffort = undefined;
    this.#adoptThread(started.thread.id);
    await this.#reportModelsOnce();
  }

  /**
   * Make `id` the session's thread, and remember it: a restart resumes the
   * thread only if its id was saved. (It wasn't, before #387 — every restart
   * quietly started an empty thread.)
   */
  #adoptThread(id: string): void {
    // Torn down while the reply was in flight (a backend switch): this thread
    // is no longer the session's, and must not overwrite its backing id.
    if (!this.#proc) return;
    this.#threadId = id;
    if (this.#backingSessionId === id) return;
    this.#backingSessionId = id;
    try {
      // The column predates multi-provider naming: "the backend's session id".
      this.#store.setClaudeCodeSessionId(this.#sessionId, id);
    } catch (err) {
      console.error(`[codex-provider ${this.#sessionId.slice(0, 8)}] failed to persist thread id: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #reportModelsOnce(): Promise<void> {
    if (this.#modelsReported || !this.#onModels) return;
    const listed = await this.listModels();
    // The model codex runs when none is chosen (#417): the user's configured
    // one, else its catalog's default — so a picker shows that model's levels.
    // A configured effort is what Default sends for every model: shown as theirs.
    let configured: string | null = null;
    let configuredEffort: EffortLevel | null = null;
    try {
      const read = (await this.#proc!.request("config/read", {})) as { config?: { model?: string | null; model_reasoning_effort?: string | null } };
      configured = read.config?.model ?? null;
      configuredEffort = fromCodexEffort(read.config?.model_reasoning_effort ?? undefined);
    } catch {
      // Unknown: the catalog's own default stands.
    }
    // A configured model the catalog doesn't list: no row is the one codex runs.
    const models = listed.map((m) => ({
      ...m,
      isDefault: configured ? m.id === configured : m.isDefault === true,
      // ...for a model that takes it (one that doesn't: codex adjusts; its own default is the best guess).
      ...(configuredEffort && (!m.efforts || m.efforts.includes(configuredEffort)) ? { defaultEffort: configuredEffort } : {}),
    }));
    if (models.length > 0) {
      this.#modelsReported = true;
      this.#onModels(
        models.map((m) => ({
          value: m.id,
          displayName: m.displayName,
          description: m.description,
          ...(m.efforts ? { efforts: m.efforts } : {}),
          ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
          ...(m.isDefault ? { isDefault: true } : {}),
        })),
      );
    }
  }

  /**
   * Which MCP call an elicitation is about (#368). codex names only the SERVER;
   * its message names the tool and `_meta.tool_params` carries the arguments.
   * When the elicitation says both, that IS what will run and is what's shown —
   * correlation only picks the started item to pair the result with. When it
   * doesn't, use the one matching call; several DIFFERENT candidates are
   * ambiguous and declined rather than guessed.
   */
  #resolveElicitedCall(
    serverName: string,
    params: Record<string, unknown>,
  ): { tool: string; input: Record<string, unknown>; itemId: string; unshowable?: string } {
    const eTool = mcpToolFromMessage(params.message, serverName);
    const eArgs = elicitedToolParams(params);
    const list = this.#pendingMcpCalls.get(serverName) ?? [];
    const matches = list.filter(
      (c) => (eTool === null || c.tool === eTool) && (eArgs === undefined || Bun.deepEquals(c.input, eArgs)),
    );
    // Unique per request — never the turn id, which every request in a turn
    // shares: two approvals on one id would let one answer settle the other.
    const synthetic = `mcp-${randomUUID()}`;
    const take = (c: (typeof list)[number]) => {
      list.splice(list.indexOf(c), 1);
      if (list.length === 0) this.#pendingMcpCalls.delete(serverName);
      return c;
    };
    if (eTool !== null && eArgs !== undefined) {
      const c = matches[0] ? take(matches[0]) : undefined;
      return { tool: eTool, input: eArgs, itemId: c?.itemId ?? synthetic };
    }
    const first = matches[0];
    if (first && matches.every((c) => c.tool === first.tool && Bun.deepEquals(c.input, first.input))) {
      // One candidate, or several identical ones — the same call either way.
      const c = take(first);
      return { tool: c.tool, input: c.input, itemId: c.itemId };
    }
    if (matches.length > 1) {
      return {
        tool: eTool ?? "tool",
        input: eArgs ?? {},
        itemId: synthetic,
        unshowable: `${matches.length} different calls to ${serverName} are waiting and codex didn't say which this is`,
      };
    }
    return {
      tool: eTool ?? "tool",
      input: eArgs ?? {},
      itemId: synthetic,
      unshowable: `codex didn't say which ${serverName} call this is, or with what arguments`,
    };
  }

  #dropPendingMcpCall(serverName: string, itemId: string): void {
    const list = this.#pendingMcpCalls.get(serverName);
    if (!list) return;
    const i = list.findIndex((c) => c.itemId === itemId);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.#pendingMcpCalls.delete(serverName);
  }

  #push(event: ProviderEvent): void {
    const queue = this.#turnQueue;
    if (!queue || queue.closed) return;
    try {
      queue.push(event);
    } catch {
      /* closed between check and push */
    }
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = (params.delta ?? params.text) as string | undefined;
        if (delta) this.#push({ type: "text_delta", content: delta });
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = (params.delta ?? params.text) as string | undefined;
        if (delta) this.#push({ type: "thinking_delta", content: delta });
        break;
      }
      case "item/started": {
        // codex names the SERVER (not the tool) in the approval elicitation
        // that follows an mcpToolCall — stash the tool + args here so the
        // elicitation handler can build the canonical `mcp__server__tool` name.
        const item = params.item as Record<string, unknown> | undefined;
        if (item && ((item.type as string) === "commandExecution" || (item.type as string) === "fileChange")) {
          this.#startedItems.set(String(item.id ?? ""), item);
        }
        if (item && (item.type as string) === "mcpToolCall") {
          const server = String(item.server ?? "");
          const list = this.#pendingMcpCalls.get(server) ?? [];
          list.push({
            itemId: String(item.id ?? ""),
            tool: String(item.tool ?? "tool"),
            input: (item.arguments as Record<string, unknown>) ?? {},
          });
          this.#pendingMcpCalls.set(server, list);
        }
        break;
      }
      case "item/fileChange/patchUpdated": {
        // codex can stream a patch (apply_patch_streaming_events): item/started
        // may carry none or part of it. The approver must see the latest — a
        // fresh object, never a mutation of what an approval may have read.
        const itemId = String(params.itemId ?? "");
        const started = this.#startedItems.get(itemId);
        if (started && started.type === "fileChange" && Array.isArray(params.changes)) {
          this.#startedItems.set(itemId, { ...started, changes: params.changes });
          if (this.#approvalsInFlight.has(itemId)) this.#patchChangedInFlight.add(itemId);
        }
        break;
      }
      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;
        const itemId = String(item.id ?? "");
        if (itemType === "mcpToolCall") this.#dropPendingMcpCall(String(item.server ?? ""), itemId);
        this.#startedItems.delete(itemId);
        this.#completedParents.add(itemId);
        const subs = this.#openSubApprovals.get(itemId);
        if (subs) {
          this.#openSubApprovals.delete(itemId);
          const ok = String(item.status ?? "completed") === "completed";
          for (const subId of subs) {
            this.#push({ type: "tool_complete", sdkToolUseId: subId, output: ok ? "Ran as part of the parent command." : `Parent command ${String(item.status)}.`, success: ok });
            this.#announcedItems.delete(subId);
          }
        }
        if (itemType === "agentMessage") {
          const text = (item.text ?? item.content ?? "") as string;
          this.#push({ type: "text_done", content: typeof text === "string" ? text : "" });
          this.#push({ type: "thinking_done" });
        } else if (TOOL_ITEM_TYPES.has(itemType)) {
          // Items codeoid gated were announced at approval time; items
          // codex ran under its own trusted policy are recorded here
          // retrospectively so scrollback + canonical history stay honest.
          if (!this.#announcedItems.has(itemId)) {
            const { name, input } = codexItemToTool(itemType, item);
            this.#push({
              type: "tool_start",
              toolId: itemId,
              sdkToolUseId: itemId,
              name,
              input,
              approvalId: `codex-auto-${itemId}`,
            });
          }
          // Only `completed` succeeded: codex also reports `declined` (the
          // approval was refused or failed) and `failed` — neither ran (#369).
          const status = String(item.status ?? "completed");
          if (this.#declinedItems.delete(itemId) && status === "declined") {
            // codeoid declined it — the card already says so (cancelled).
            this.#announcedItems.delete(itemId);
            break;
          }
          const output = extractItemOutput(item);
          this.#push({
            type: "tool_complete",
            sdkToolUseId: itemId,
            output: output || (status === "declined" ? "Declined — not run." : output),
            success: status === "completed",
          });
          this.#announcedItems.delete(itemId);
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn as Record<string, unknown> | undefined;
        const u = this.#lastTokenUsage;
        // Match the claude convention: inputTokens = NEW tokens (cache reads
        // excluded); codex's inputTokens INCLUDES its cachedInputTokens.
        const cacheRead = u?.cachedInputTokens ?? 0;
        const result: NormalizedTurnResult = {
          providerId: this.id,
          model: this.#turnModel,
          inputTokens: Math.max(0, (u?.inputTokens ?? 0) - cacheRead),
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          durationMs: Date.now() - this.#turnStartedAt,
          ...(this.#modelContextWindow !== null
            ? { contextWindow: this.#modelContextWindow }
            : {}),
          stopReason: (turn?.status as string | undefined) ?? undefined,
          // Where this turn ends in the thread, for a native fork there (#387).
          // Only a completed turn: a failed one would carry the failure over.
          ...(this.#threadId && typeof turn?.id === "string" && turn.status === "completed"
            ? { nativeRef: { backingId: this.#threadId, ref: turn.id } }
            : {}),
        };
        this.#push({ type: "turn_done", result });
        this.#turnQueue?.close();
        break;
      }
      case "thread/tokenUsage/updated": {
        // `ThreadTokenUsage` has three fields on this wire — `last`, `total`
        // and `modelContextWindow` (confirmed in the codex binary's own serde
        // descriptors: "struct ThreadTokenUsage with 3 elements"). codeoid read
        // only `last` and inferred the window from the model id instead, which
        // is the guess this change exists to stop making.
        const tu = params.tokenUsage as
          | { last?: CodexTokenUsage; modelContextWindow?: number }
          | undefined;
        if (tu?.last) this.#lastTokenUsage = tu.last;
        if (typeof tu?.modelContextWindow === "number" && tu.modelContextWindow > 0) {
          this.#modelContextWindow = tu.modelContextWindow;
        }
        break;
      }
      case "error": {
        // `params.error` is an OBJECT on this wire ({code, message, data}), so
        // the previous `as string` + String() turned every codex failure into
        // the literal "[object Object]" — the cause destroyed at the one place
        // it was supposed to be reported. Observed live: a role-child failed
        // twice with `Error: [object Object]` and nothing anywhere said why.
        this.#push({ type: "error", message: `codex: ${describeCodexError(params)}` });
        break;
      }
      default:
        break; // plan/diff/status notifications — future slices
    }
  }

  async #onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const canUseTool = this.#canUseTool;
        // Fail closed: an approval with no gate wired is denied, never run.
        if (!canUseTool) return approvalReply(method, params, false);
        const hasItem = typeof params.itemId === "string" && params.itemId !== "";
        const hasCallback = typeof params.approvalId === "string" && params.approvalId !== "";
        const parentId = String(hasItem ? params.itemId : (params.approvalId ?? randomUUID()));
        // Several callbacks can share one item (zsh-exec-bridge subcommands,
        // stdin writes): codex then sets a per-callback approvalId. Key by both
        // so two pending approvals never collide on one codeoid id (#369).
        const itemId = hasItem && hasCallback ? `${parentId}:${String(params.approvalId)}` : parentId;
        const lateSibling = itemId !== parentId && this.#completedParents.has(parentId);
        const { name, input, unshowable } = approvalToTool(method, params, this.#startedItems.get(parentId));
        this.#announcedItems.set(itemId, { name, input });
        this.#push({
          type: "tool_start",
          toolId: itemId,
          sdkToolUseId: itemId,
          name,
          input,
          approvalId: `codex-${itemId}`,
        });
        const refusal = lateSibling ? "its parent command had already finished" : unshowable;
        if (refusal) {
          // Never ask for a yes on something the approver can't see (or that
          // can no longer run) — the approval takes effect. Declined, with the
          // reason on the card.
          this.#push({ type: "tool_complete", sdkToolUseId: itemId, output: `Declined — ${refusal}`, success: false, declinedByBackend: true });
          this.#announcedItems.delete(itemId);
          this.#declinedItems.add(itemId);
          return approvalReply(method, params, false);
        }
        // Counted, not flagged: concurrent approvals on one item each see a
        // change that lands while they're being decided.
        this.#approvalsInFlight.set(parentId, (this.#approvalsInFlight.get(parentId) ?? 0) + 1);
        let verdict: Awaited<ReturnType<typeof canUseTool>>;
        let patchChanged = false;
        try {
          verdict = await canUseTool(itemId, `codex-${itemId}`, name, input);
        } finally {
          const left = (this.#approvalsInFlight.get(parentId) ?? 1) - 1;
          patchChanged = this.#patchChangedInFlight.has(parentId);
          if (left > 0) this.#approvalsInFlight.set(parentId, left);
          else {
            this.#approvalsInFlight.delete(parentId);
            this.#patchChangedInFlight.delete(parentId);
          }
        }
        const parentDone = itemId !== parentId && this.#completedParents.has(parentId);
        if (verdict.behavior === "allow" && (patchChanged || parentDone)) {
          // The yes was for what was SHOWN: a patch that changed while it was
          // being decided, or a parent that finished meanwhile, isn't covered.
          this.#push({
            type: "tool_complete",
            sdkToolUseId: itemId,
            output: patchChanged ? "Declined — the change was updated after it was shown." : "Declined — its parent command had already finished.",
            success: false,
            declinedByBackend: true,
          });
          this.#announcedItems.delete(itemId);
          this.#declinedItems.add(itemId);
          return approvalReply(method, params, false);
        }
        if (verdict.behavior !== "allow") this.#declinedItems.add(itemId);
        else if (itemId !== parentId) {
          const open = this.#openSubApprovals.get(parentId) ?? new Set<string>();
          open.add(itemId);
          this.#openSubApprovals.set(parentId, open);
        }
        return approvalReply(method, params, verdict.behavior === "allow");
      }
      case "mcpServer/elicitation/request": {
        // codex gates EVERY MCP tool call behind an MCP elicitation when the
        // approval policy is `untrusted` (guarded / interactive mode). Unlike
        // the item/* approvals it names the SERVER, not the tool, and expects
        // the MCP `{action}` reply shape — NOT the `{decision}` the item/*
        // approvals use. Without this case the request hits `default` below,
        // throws, and codex reads the error as a declined elicitation, so
        // every MCP tool call (incl. read-only memory recall) is auto-denied
        // in guarded/interactive mode. Route it through the SAME canUseTool
        // gate as every other backend, keyed by the canonical
        // `mcp__<server>__<tool>` name so isSafeTool auto-approves read-only
        // memory tools and everything else prompts.
        const canUseTool = this.#canUseTool;
        // Fail closed: an approval with no gate wired is declined, never run.
        if (!canUseTool) return { action: "decline" };
        const serverName = String(params.serverName ?? "");
        // The same method carries an MCP server's OWN questions (a form, an
        // OAuth url) — only codex's tool-call approval is a tool approval.
        // Anything else is shown for what it is and declined: answering it as
        // a tool call would accept a url nobody saw (#368).
        const meta = params._meta as Record<string, unknown> | undefined;
        const isToolApproval = (params.mode === undefined || params.mode === "form") && meta?.codex_approval_kind === "mcp_tool_call";
        if (!isToolApproval) {
          const askId = `mcp-ask-${randomUUID()}`;
          const shown: Record<string, unknown> = {
            ...(typeof params.message === "string" ? { message: params.message } : {}),
            ...(typeof params.url === "string" ? { url: params.url } : {}),
            ...(params.mode !== undefined ? { mode: params.mode } : {}),
          };
          this.#push({ type: "tool_start", toolId: askId, sdkToolUseId: askId, name: `mcp__${serverName}__elicitation`, input: shown, approvalId: `codex-${askId}` });
          this.#push({
            type: "tool_complete",
            sdkToolUseId: askId,
            output: `Declined — ${serverName} asked a question of its own; answering MCP server questions isn't supported on codex yet`,
            success: false,
            declinedByBackend: true,
          });
          return { action: "decline" };
        }
        const { tool, input, itemId, unshowable } = this.#resolveElicitedCall(serverName, params);
        const name = `mcp__${serverName}__${tool}`;
        // Announce so scrollback shows the real tool; keyed by the mcpToolCall
        // itemId so the item/completed handler pairs the tool_complete instead
        // of re-announcing (autonomous runs, which never elicit, still announce
        // retrospectively via codexItemToTool).
        this.#announcedItems.set(itemId, { name, input });
        this.#push({
          type: "tool_start",
          toolId: itemId,
          sdkToolUseId: itemId,
          name,
          input,
          approvalId: `codex-${itemId}`,
        });
        if (unshowable) {
          // Never ask for a yes on a call we can't pin down (#368).
          this.#push({ type: "tool_complete", sdkToolUseId: itemId, output: `Declined — ${unshowable}`, success: false, declinedByBackend: true });
          this.#announcedItems.delete(itemId);
          this.#declinedItems.add(itemId);
          return { action: "decline" };
        }
        const verdict = await canUseTool(itemId, `codex-${itemId}`, name, input);
        if (verdict.behavior !== "allow") this.#declinedItems.add(itemId);
        return verdict.behavior === "allow" ? { action: "accept", content: {} } : { action: "decline" };
      }
      case "item/tool/requestUserInput": {
        const ask = this.#requestUserInput;
        if (!ask) return { answers: [] };
        const questions = (params.questions ?? []) as Array<Record<string, unknown>>;
        const answers: Array<Record<string, unknown>> = [];
        for (const q of questions) {
          const options = (q.options as Array<{ label?: string }> | undefined)
            ?.map((o) => o.label ?? "")
            .filter((l) => l.length > 0);
          const response = await ask({
            method: options && options.length > 0 ? "select" : "input",
            title: String(q.header ?? q.question ?? "Codex asks"),
            message: typeof q.question === "string" ? q.question : undefined,
            options,
          });
          answers.push({
            id: q.id,
            // Cancellation is "no answer", never consent (interface contract).
            answer: response.cancelled ? null : (response.value ?? null),
          });
        }
        return { answers };
      }
      default:
        // Unknown server request — refuse rather than guess (fail closed).
        throw new Error(`codeoid does not handle codex request: ${method}`);
    }
  }
}

/** Recover the MCP tool name from the elicitation `message` when the preceding
 *  item/started wasn't observed (defensive): `…run tool "recall"?` → `recall`. */
/**
 * The tool an approval elicitation names: codex's template is
 * `Allow the <server> MCP server to run tool "<tool>"?`. Matched as a whole
 * and anchored at the end, so a tool name containing a quote is read in full
 * rather than cut at its first `"` (#368).
 */
function mcpToolFromMessage(message: unknown, serverName?: string): string | null {
  if (typeof message !== "string") return null;
  const m = message.match(/^Allow the (.+) MCP server to run tool "(.+)"\?$/s);
  if (m) return serverName === undefined || m[1] === serverName ? (m[2] ?? null) : null;
  const loose = message.match(/run tool "(.+)"\?\s*$/s);
  return loose ? (loose[1] ?? null) : null;
}

/** The tool arguments an elicitation carries (`_meta.tool_params`), or
 *  undefined when it carries none — distinct from "no arguments" (`{}`). */
function elicitedToolParams(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = params._meta as Record<string, unknown> | undefined;
  const tp = meta?.tool_params;
  return tp && typeof tp === "object" && !Array.isArray(tp) ? (tp as Record<string, unknown>) : undefined;
}

/** Render an env map as a TOML inline table (`{ KEY = "val", … }`) for a codex
 *  `-c mcp_servers.<name>.env=…` override — JSON of an object is NOT valid TOML. */
function tomlInlineTable(map: Record<string, string>): string {
  const entries = Object.entries(map).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return `{ ${entries.join(", ")} }`;
}

/**
 * codex's reply to an `item/*` approval request, in the shape its app-server
 * protocol requires (#369). Command and file-change approvals take
 * `{decision: "accept" | "decline"}` — the legacy `"approved"` / `"denied"`
 * (ReviewDecision, from the old execCommandApproval) is REJECTED by codex as
 * "approval request failed", so every approved call failed. A permissions
 * request is answered with a GRANT: the requested profile to allow it for
 * this turn, an empty one to refuse it.
 */
function approvalReply(method: string, params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return allow ? { permissions: params.permissions ?? {}, scope: "turn" } : { permissions: {} };
  }
  return { decision: allow ? "accept" : "decline" };
}

/**
 * Map an approval request to a codeoid tool name + input — what the approver
 * sees. codex 0.154's requests omit the file diff (and may omit the command),
 * so both come from the item's `item/started` (#369). `unshowable` is set when
 * the request would grant something the approver can't be shown; the caller
 * declines it without asking.
 */
function approvalToTool(
  method: string,
  params: Record<string, unknown>,
  started?: Record<string, unknown>,
): { name: string; input: Record<string, unknown>; unshowable?: string } {
  if (method === "item/commandExecution/requestApproval") {
    const kind = String(params.kind ?? "command");
    // A sibling callback (approvalId set) asks about its OWN subcommand: the
    // parent's command would show the wrong thing, so never fall back to it.
    const isSub = typeof params.approvalId === "string" && params.approvalId !== "" && typeof params.itemId === "string" && params.itemId !== "";
    const command = String(params.command ?? (isSub ? "" : (started?.command ?? "")));
    const network = params.networkApprovalContext as Record<string, unknown> | null | undefined;
    const input: Record<string, unknown> = {
      command,
      ...(params.cwd ?? started?.cwd ? { cwd: params.cwd ?? started?.cwd } : {}),
      ...(kind !== "command" ? { kind } : {}),
      ...(network ? { network } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    };
    if (kind === "writeStdin") {
      return { name: "Bash", input, unshowable: "codex asked to write to a running terminal, and the input isn't in the request" };
    }
    if (kind !== "command") {
      // A kind this version doesn't know — don't present it as a plain command.
      return { name: "Bash", input, unshowable: `codex asked for an approval of an unknown kind (${kind})` };
    }
    // A network grant must name its host. With a command it stays `Bash` — the
    // command is what runs, and Bash `tool_call` hooks must keep seeing it —
    // the host shown alongside. Alone it is its own tool, so Bash hooks and
    // Bash auto-approval don't treat open egress as a shell command.
    if (network && (typeof network.host !== "string" || network.host === "")) {
      return { name: command ? "Bash" : "codex_network_access", input, unshowable: "codex asked for network access without naming the host" };
    }
    if (!command && network) return { name: "codex_network_access", input };
    if (!command) return { name: "Bash", input, unshowable: "codex didn't say what the command is" };
    return { name: "Bash", input };
  }
  if (method === "item/fileChange/requestApproval") {
    const changes = started?.changes;
    const input: Record<string, unknown> = {
      ...(changes !== undefined ? { changes } : {}),
      ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    };
    if (!Array.isArray(changes) || changes.length === 0) {
      return { name: "codex_file_change", input, unshowable: "codex didn't show the change it wants to make" };
    }
    if (params.grantRoot) {
      // [UNSTABLE] per codex: asks to allow writes under a root for the rest of
      // the session — an accept could grant far more than the change shown.
      return { name: "codex_file_change", input, unshowable: `codex also asked for session-wide write access under ${String(params.grantRoot)}` };
    }
    return { name: "codex_file_change", input };
  }
  return { name: "codex_permissions", input: { ...params } };
}

/** Tool record for items codex ran without asking (trusted policy). */
function codexItemToTool(
  itemType: string,
  item: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (itemType === "commandExecution") {
    return { name: "Bash", input: { command: String(item.command ?? "") } };
  }
  if (itemType === "fileChange") {
    return { name: "codex_file_change", input: { changes: item.changes ?? item.patch ?? null } };
  }
  if (itemType === "mcpToolCall") {
    return {
      name: `mcp__${String(item.server ?? "codex")}__${String(item.tool ?? "tool")}`,
      input: (item.arguments as Record<string, unknown>) ?? {},
    };
  }
  return { name: `codex_${itemType}`, input: {} };
}

function extractItemOutput(item: Record<string, unknown>): string {
  const out = item.aggregatedOutput ?? item.output ?? item.result ?? item.text ?? "";
  return typeof out === "string" ? out : JSON.stringify(out);
}

/** codeoid's effort scale in codex's terms (#417): Off is its "none"; the rest share names. */
export function toCodexEffort(effort: EffortLevel): string {
  return effort === "off" ? "none" : effort;
}

/** A codex reasoning effort on codeoid's scale, or null for one codeoid has no level for. */
export function fromCodexEffort(effort: string | undefined): EffortLevel | null {
  if (effort === "none") return "off";
  return effort && (EFFORT_LEVELS as readonly string[]).includes(effort) ? (effort as EffortLevel) : null;
}
