/**
 * SessionManager — orchestrates multiple concurrent agent sessions.
 *
 * Production-grade patterns:
 *   - Per-user rate limiting on session creation
 *   - Session resume from transcript on daemon restart
 *   - Scope enforcement on every operation
 *   - Graceful drain on shutdown
 */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type ForkPoint, RewindError, SendStoppedError, Session, type AttachedClient, type WindowScope } from "./session.js";
import { sweepCheckpoints } from "./checkpoints.js";
import type { CompareRunRow } from "./store.js";
import { type CompareState, type CompareTargetState, type ErrorCode, LIMITS, backendHasAccounts, DEFAULT_ACCOUNT, type AccountKind, type ClaudeAccountKind } from "../protocol/types.js";
import { type CatalogEntry, isPlaceholderModel, type SessionProvider } from "./providers/interface.js";
import {
  createDefaultProviderRegistry,
  DefaultProviderError,
  type ProviderRegistry,
  registerAccountBackends,
} from "./providers/registry.js";
import type { HookBus } from "./hooks/bus.js";
import type { Store } from "./store.js";
import { createPushTransport, PushService } from "./push/index.js";
import { hasScope, SCOPES } from "../protocol/scopes.js";
import { applyPatches, getManifest, getSnapshot, previewPatches, readMcpServerEntry, writeMcpServerEntry } from "./settings/store.js";
import { adoptability, adoptableName, adoptedEntry, adoptionRefusal, claudeMcpServers, fromRepoFile, fullUrlRequired, isSameAdoption, shellArg } from "./mcp/adopt.js";
import { readWorkdirServers } from "./mcp/workdir-servers.js";
import { cleanMcpError, commandSummary, MAX_SHOWN_KEYS, quotedVisible, redactMcpUrl, serverProgram, shownLabel, visibleCompact, visibleVerbatim } from "./mcp/redact.js";
import { canonicalFromTranscript, turnIndexFromHistory } from "./canonical-restore.js";
import { BackendLoginBroker, BackendLoginError, type LoginOutcome, redact } from "./auth/backend-login.js";
import { ClaudeAccountError, ClaudeAccountStore } from "./claude-accounts.js";
import { AccountError, type AccountStore, LOGIN_KINDS, validateAccountName } from "./accounts.js";
import { configuredContextWindow, draftConnection, EndpointError, EndpointStore } from "./openai-endpoints.js";
import {
  EndpointCatalog,
  fetchEndpointModels,
  fetchLlamaCppContext,
  syncEndpointProviders,
  watchEndpointProviders,
} from "./providers/endpoint/index.js";
import { RateLimiter } from "./rate-limit.js";
import type { TranscriptMeta, TranscriptStore } from "./transcript.js";
import {
  FsAccessError,
  handleFsBrowseDir,
  handleFsList,
  handleFsRead,
  isProtectedPath,
} from "./fs.js";
import { readClaudeConfig } from "./claude-config.js";
import {
  CLAUDE_PROVIDER_ID,
  fallbackModelInfos,
  resolveAgainstList,
  resolveModelIdForProvider,
} from "./models.js";
import { Blackboard, type OwnerBlackboard } from "./blackboard/service.js";
import { BlackboardStore, type GoalScope } from "./blackboard/store.js";
import { BlackboardMcpHttp } from "./blackboard/mcp-http.js";
import {
  adoptPackRoles,
  collaborationScopeWarnings,
  childBrief,
  childSessionName,
  compileGoalPack,
  orchestratorRole,
  goalIdFromCreatedBy,
  orchestratorCreatedBy,
  orphanedChildBrief,
  planChildren,
  plannedChildFor,
  roleChildPosture,
  validateCollaboration,
  type PlannedChild,
} from "./collaboration.js";
import {
  packSession,
  unpackBundle,
  validateBundle,
  writeBundleToFile,
  type ImportedSessionInit,
} from "./share/index.js";
import type { AgentIdentityManager } from "./agent-identity.js";
import {
  buildFleetMcpServer,
  ORCHESTRATOR_FLEET_TOOLS,
  type FleetDeps,
  type FleetDispatchDeps,
  type FleetSessionView,
  type FleetTaskView,
} from "./fleet.js";
import {
  Dispatcher,
  NonRetryableDispatchError,
  TERMINAL_TASK_STATUS,
  type DispatcherHost,
} from "./dispatch.js";
import { createPipelineManagerFromConfig } from "./pipeline/wiring.js";
import { EvidenceService, EvidenceStore, evidenceToWire } from "./evidence/index.js";
import type { PipelineManager } from "./pipeline/manager.js";
import { resolveBinding, type ModelBindingConfig } from "./pipeline/binding.js";
import type { RoleDef } from "./pipeline/pack.js";
import {
  PackService,
  resolvePhaseActivation,
  type PackActivation,
  type PackServiceConfig,
} from "./pipeline/pack-service.js";
import { SessionPhaseRunner, type PhaseTurnResult } from "./pipeline/runner.js";
import {
  isNeedInput,
  isPhaseComplete,
  MAX_PHASE_NUDGES,
  MAX_SPURIOUS_RESTS,
  PHASE_COMPLETION_CONTRACT,
  PHASE_CONTINUE_NUDGE,
  stripNeedInputMarker,
  stripPhaseCompleteMarker,
} from "./pipeline/phase-completion.js";
import { roleEnforcement } from "./providers/tool-safety.js";
import type { DispatchEventRow, DispatchTaskRow } from "./store.js";
import { type MemoryEngine, type MemoryMcpMount, workspaceIdFromPath } from "./memory/index.js";
import type { McpRegistry } from "./mcp/registry.js";
import { redactCommand } from "./skill-command.js";
import type { McpHub } from "./mcp/hub.js";
import { mcpOAuthBindingCookieName, type McpOAuth, type McpOAuthProof, type McpTenant } from "./mcp/oauth.js";
import { isOAuthServer, type McpServerSpec, OAUTH_UNSUPPORTED_BACKENDS } from "./mcp/types.js";
import { atomicWrite, type CodeoidConfig, DEFAULT_PROVIDER_ENV, loadConfig, mutateConfigFile, validateConfigObject } from "../config.js";
import type { CompressionRegistry } from "./compress/index.js";
import { endpointNameOf, endpointProviderId, ORCHESTRATOR_ROLE, type ProviderInfo } from "../protocol/types.js";
import type {
  AuthContext,
  ClaudeConfigMcpServer,
  McpApprovePreview,
  ClientMessage,
  CollaborationConfig,
  CollaborationCost,
  CollaborationPanel,
  DaemonMessage,
  FleetEventWire,
  FleetTaskWire,
  FleetUsage,
  McpServerStatus,
  ModelInfo,
  PipelinePhaseWire,
  PipelineWire,
  SessionInfo,
  SessionMode,
  SessionWorktree,
  SettingPatch,
} from "../protocol/types.js";
import type { Scope } from "../protocol/scopes.js";
import type { PipelineState } from "./pipeline/interface.js";
import { blockingOf, openFindings, renderLedger } from "./pipeline/findings.js";

/** Per-phase autonomous turn budget for a pipeline run. A phase runs the model
 *  to completion within its role (the human gate is the phase boundary, not each
 *  tool), so this is a generous safety cap, refreshed at the start of every
 *  phase. There is no wall-clock timeout: the run session is attended, so the
 *  user watches + can interrupt — nothing hangs headless. */
const PIPELINE_PHASE_MAX_TURNS = 200;
import { randomUUID } from "node:crypto";
import { RoutineError, RoutineService, type RoutineHost } from "./routines/service.js";
import { RoutineStore } from "./routines/store.js";
import type { RoutineRow } from "./routines/types.js";
import { toRoutineWire, toRunWire } from "./routines/wire.js";
import { routineFirePath } from "../protocol/types.js";
import {
  createForkWorktree,
  currentBranch,
  isGitRepo,
  removeForkWorktree,
} from "./git-worktree.js";
import { prepareWorktree, WorktreeSetupFailure, type WorktreeSetupResult } from "./workspace-setup.js";
import type { DailyUsageBucket, LifetimeUsageTotals } from "./memory/store.js";

/**
 * Optional safe-root for session workdirs. When `CODEOID_FS_BROWSE_ROOT` is set
 * (the same knob `fs.browse_dir` uses), a session's workdir must resolve inside
 * it — so a scoped token can't create a session rooted anywhere on the host.
 * Unset = no root constraint (workdirs are still barred from protected dirs).
 */
function workdirSafeRoot(): string | null {
  const override = process.env.CODEOID_FS_BROWSE_ROOT;
  if (!override || override.trim().length === 0) return null;
  try {
    return realpathSync(override.trim());
  } catch {
    return resolve(override.trim());
  }
}

/**
 * Resolve a user-supplied workdir to an absolute, existing directory.
 * Expands a leading `~`, resolves relative paths against the daemon cwd, and
 * returns null if the path doesn't exist, isn't a directory, lands inside a
 * protected directory (the daemon's own secret store / host credential dirs),
 * or escapes the configured safe-root.
 *
 * The containment check is the session-creation half of GHSA-38vh vector 2:
 * `fs.read` is already bounded to the session workdir, so refusing a workdir
 * that IS (or is an ancestor of) the daemon config dir stops a scoped token
 * from rooting a session at `~` and reading `~/.codeoid/config.json` — the root
 * ZeroID key. `fs.resolveSafe` enforces the same deny-list as defence in depth.
 */
function normalizeWorkdir(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let p: string;
  if (raw === "~") p = homedir();
  else if (raw.startsWith("~/")) p = resolve(homedir(), raw.slice(2));
  else p = resolve(raw);
  try {
    if (!existsSync(p) || !statSync(p).isDirectory()) return null;
    // Canonicalise so a symlinked workdir can't smuggle the resolved path
    // into a protected dir or outside the safe-root.
    const canonical = realpathSync(p);
    if (isProtectedPath(canonical)) return null;
    const root = workdirSafeRoot();
    if (root && canonical !== root && !canonical.startsWith(root + sep)) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

/** Eager-resume bounds. Resume runs before the daemon listens — so an
 * unbounded resume can block startup or OOM. Cap to the newest-N sessions and
 * stop past a deadline (applied WITHIN each transcript parse too, not just
 * between sessions); the rest stay on disk (loadable on a future restart). */
/**
 * Recent fan-outs a client is shown per goal. A sidebar needs the live one plus
 * a little history for context, not an orchestrator's whole dispatch career.
 */
const PANEL_HISTORY_LIMIT = 5;

/**
 * Board page sizes for `fleet.subscribe`. The snapshot is a UI payload, not an
 * archive — deeper history is the dispatch-timeline lens (P5.4), which pages.
 */
const FLEET_TASK_LIMIT = 100;
const FLEET_EVENT_LIMIT = 50;

/** Composite tenant key. Both halves are UUIDs, so ":" cannot collide. */
function tenantKey(accountId: string, projectId: string): string {
  return `${accountId}:${projectId}`;
}

/**
 * How far a tenant's board has been streamed to its subscribers.
 *
 * `taskUpdatedAt` alone is not enough to be exactly-once. `updated_at` is
 * millisecond-granular and one dispatcher tick routinely settles several tasks
 * inside the same millisecond, which leaves only bad options for a single
 * cursor: an exclusive `>` bound DROPS every task that shares the boundary
 * millisecond (a node stuck in a stale state until something unrelated moves
 * it), and an inclusive `>=` bound RE-SENDS them on every subsequent flush.
 *
 * `sentAtWatermark` closes that gap: the ids already delivered at exactly
 * `taskUpdatedAt`. The query stays inclusive so nothing is dropped, and this
 * set suppresses the repeats. It only ever holds the tasks sharing one
 * millisecond, so it stays small and is rebuilt on every advance.
 */
interface FleetWatermark {
  taskUpdatedAt: number;
  sentAtWatermark: Set<string>;
  eventId: number;
}

/** Rebuild the watermark after delivering `tasks`. */
function advanceWatermark(mark: FleetWatermark, tasks: readonly DispatchTaskRow[]): void {
  for (const t of tasks) {
    if (t.updatedAt > mark.taskUpdatedAt) {
      mark.taskUpdatedAt = t.updatedAt;
      mark.sentAtWatermark = new Set();
    }
    if (t.updatedAt === mark.taskUpdatedAt) mark.sentAtWatermark.add(t.id);
  }
}

/**
 * Project a stored dispatch row onto the wire.
 *
 * Drops `prompt`, `workdir`, `claimOwner`, `notBefore` and the lease fields:
 * the board draws lifecycle, and the prompt is the one field here that can
 * carry arbitrary user content into every subscribed client. `dependsOn` is
 * intentionally never set — see FleetTaskWire.
 */
function toFleetTaskWire(row: DispatchTaskRow): FleetTaskWire {
  return {
    id: row.id,
    kind: row.kind,
    shape: row.shape,
    status: row.status as FleetTaskWire["status"],
    attempts: row.attempts,
    createdAt: row.createdAt,
    workerSessionId: row.workerSessionId ?? undefined,
    targetSession: row.targetSession ?? undefined,
    resultDigest: row.resultDigest ?? undefined,
    error: row.error ?? undefined,
    createdBy: row.createdBy,
    groupId: row.groupId ?? undefined,
    runId: row.runId ?? undefined,
    attemptId: row.attemptId ?? undefined,
  };
}

function toFleetEventWire(row: DispatchEventRow): FleetEventWire {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    digest: row.digest,
    createdAt: row.createdAt,
  };
}

/** Fallback when no config is supplied (tests, embedded use). The
 *  configured value is `session.resumeMaxSessions`. */
const RESUME_MAX_SESSIONS_DEFAULT = 200;
const RESUME_DEADLINE_MS = 20_000;
/** Per-session transcript read budget on resume. Scrollback keeps at most
 * 20 MiB / 5000 messages — parsing history past that would be evicted on
 * arrival, so cap the read slightly above the scrollback byte cap. */
const RESUME_TRANSCRIPT_MAX_BYTES = 24 * 1024 * 1024;
/** A comparison that can't start for a reason the caller can act on (#357). */
class CompareAbort extends Error {}

/**
 * Transcript rows of a fork from an earlier turn (#356): everything up to the
 * first row, after the chosen turn's last one, that belongs to a turn the fork
 * doesn't carry — so a turn the parent started meanwhile, or any row stamped
 * with another id, is cut. Positional: notices between the chosen turn and the
 * next stay with the chosen turn, and rows inside it are never split off.
 */
export function cutRowsAfterTurn<T extends { message: DaemonMessage }>(
  rows: T[],
  keptTurnIds: readonly string[],
  turnId: string,
): T[] {
  const kept = new Set(keptTurnIds);
  const turnOf = (r: T) => (r.message as { turnId?: string }).turnId;
  let from = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (turnOf(rows[i]!) === turnId) {
      from = i + 1;
      break;
    }
  }
  for (let i = from; i < rows.length; i++) {
    const id = turnOf(rows[i]!);
    if (id !== undefined && !kept.has(id)) return rows.slice(0, i);
  }
  return rows;
}

/**
 * Newest part of a session's canonical-history log read on resume (#354).
 * The prompts a backend is re-seeded with are budgeted far below this; the
 * whole log is read on demand by the features that need old turns.
 */
const RESUME_CANONICAL_MAX_BYTES = 4 * 1024 * 1024;

/** Sort key for resume ordering: most-recently-active first. Falls back to
 * createdAt, then 0, so a malformed timestamp never throws. */
function resumeSortKey(m: { lastActivityAt?: string; createdAt?: string }): number {
  const t = m.lastActivityAt ?? m.createdAt ?? "";
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

/** How long a finished device sign-in's outcome is kept for a client that comes back for it. */
const LOGIN_OUTCOME_TTL_MS = 10 * 60_000;

export class SessionManager {
  #sessions = new Map<string, Session>();
  #store: Store;
  #transcriptStore: TranscriptStore;
  #identityManager?: AgentIdentityManager;
  #rateLimiter: RateLimiter;
  #memory?: MemoryEngine;
  #memoryMcp?: MemoryMcpMount;
  /** Goal-blackboard MCP endpoint + the loopback URL children mount it from.
   *  Always constructed: with no minted tokens every request fails closed. */
  readonly #blackboardMcp = new BlackboardMcpHttp();
  #blackboardUrl?: string;
  /** Per-goal artifact store, lazily built on the shared DB connection. */
  #blackboard?: Blackboard;
  /** child session id → its blackboard bearer token, revoked on teardown. */
  readonly #blackboardTokens = new Map<string, string>();
  #mcpRegistry?: McpRegistry;
  #mcpHub?: McpHub;
  #mcpOAuth?: McpOAuth;
  /** In-flight interactive backend sign-ins. Daemon-wide, and at most one per
   *  backend — two live logins would race to write the same credential. */
  readonly #backendLogin: BackendLoginBroker;
  /** Claude accounts (claude-accounts.ts) — shared by every session. */
  #claudeAccounts!: ClaudeAccountStore;
  /** Every backend's accounts — the store behind #claudeAccounts. */
  #accounts!: AccountStore;
  #endpoints!: EndpointStore;
  #endpointCatalog!: EndpointCatalog;
  #endpointFetch!: typeof fetch;
  /** Connections that asked for `providers.list` — they get `providers.changed`. */
  readonly #providerSubscribers = new Map<string, AttachedClient>();
  /** Logins started for a NAMED Claude account: loginId → account name. */
  readonly #accountLogins = new Map<string, { backend: string; name: string; replace: boolean }>();
  /**
   * Device sign-ins being waited on, by login id, and kept a while after they
   * finish: a client whose connection dropped mid-wait waits again and gets
   * the same outcome — the credential is stored once.
   */
  readonly #loginWaits = new Map<string, Promise<{ ok: boolean; error?: string; pending?: { backend: string; name: string } }>>();
  /** Live model catalogs by provider id (via each backend's supportedModels
   *  equivalent), cached daemon-wide once any session of that provider
   *  initializes. Empty until then. */
  #modelsCache = new Map<string, ModelInfo[]>();
  /**
   * Context windows backends reported on completed turns, keyed by
   * (account, project, workdir, provider, model).
   *
   * Scoped, not daemon-wide. The Claude CLI computes the number it reports from
   * per-process inputs that a workdir's `.claude/settings.json` can set
   * (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` is unclamped), so an unscoped cache let one
   * tenant's workdir decide every other tenant's fork seed budget — 4M-sized
   * seeds into a 1M model. Within a scope it is still shared, which is what a
   * fork needs: it runs in its parent's workdir. Persisted, so a restart does
   * not fall back to inferring a window a backend already stated.
   */
  #modelLimits = new Map<string, number>();
  #config?: CodeoidConfig;
  #compressionRegistry?: CompressionRegistry;
  #dispatcher: Dispatcher;
  /**
   * clientId → fleet board subscription. Keyed by client, not by tenant, so a
   * disconnect reaps in O(1) and one client can never hold two subscriptions.
   */
  readonly #fleetSubscribers = new Map<
    string,
    { client: AttachedClient; accountId: string; projectId: string }
  >();
  /** tenant key → how far the board has been streamed. See #flushFleetDeltas. */
  readonly #fleetWatermarks = new Map<string, FleetWatermark>();
  /** Content-blind push notifications — resolves a blocked session's owner to
   *  their registered devices. Noop transport when push is disabled (default). */
  #pushService: PushService;
  /** SDLC pipeline manager — undefined when the pipeline is disabled (default). */
  #pipelines?: PipelineManager;
  #evidence?: EvidenceService;
  #evidenceTimers: ReturnType<typeof setTimeout>[] = [];
  /** Routines (docs/routines.md); undefined when `routines.enabled` is off. */
  #routines?: RoutineService;
  /** Pack curation surface (registries + install/trust/select) — always present,
   *  so packs can be managed even before the pipeline runtime is enabled. */
  #packs: PackService;
  /** The daemon's provider catalog — one registry, shared by every session. */
  #providers: ProviderRegistry;
  /** The daemon's hook bus — one instance, shared by every session. */
  #hooks?: HookBus;
  #testProviderFactory?: () => SessionProvider;
  /** Bound run-sessions awaiting a phase turn to rest, keyed by session id. A
   *  pipeline run drives phases on a live session; the phase resolves when that
   *  session next reaches a resting status (see #statusObserver). */
  #phaseWaiters = new Map<string, (status: PhaseTurnResult["finalStatus"]) => void>();
  /** Stable observer identity — every Session reports status transitions here. */
  #statusObserver = (sessionId: string, status: SessionInfo["status"]): void => {
    this.#dispatcher.onSessionStatus(sessionId, status);
    this.#routines?.onSessionStatus(sessionId);
    // Content-blind push: a session that just blocked on approval alerts its
    // owner's registered devices off-LAN. Fire-and-forget — a push hiccup must
    // never touch the status path (the emit itself only ever sees an opaque
    // session id, never the tool's args/description).
    if (status === "waiting_approval" && this.#pushService.enabled) {
      const session = this.#sessions.get(sessionId);
      if (session) {
        void this.#pushService
          .notifyApproval(sessionId, {
            sub: session.createdBy,
            accountId: session.accountId,
            projectId: session.projectId,
          })
          .catch((err) => console.error("[codeoid/push] notify failed:", err));
      }
    }
    // A pipeline phase driving this session awaits its next rest; resolve it.
    // (Non-run sessions never have a waiter, so this is a no-op for them.)
    //
    // `waiting_approval` is deliberately NOT a rest: the SDK turn is still ALIVE
    // (session.ts) — the model called a tool that needs a decision. Ending the
    // phase there would guillotine it mid-work (the bug this used to cause).
    // A tool approval is a tool-level interaction; the phase resumes once the
    // tool is approved and the turn goes on to actually rest (idle).
    // A comparison branch whose compared turn just settled: freeze its result (#357).
    if ((status === "idle" || status === "error") && this.#compareBranchOf.has(sessionId)) {
      void this.#settleCompareBranch(sessionId);
    }
    if (status === "idle" || status === "error") {
      const waiter = this.#phaseWaiters.get(sessionId);
      if (waiter) {
        this.#phaseWaiters.delete(sessionId);
        waiter(status);
      }
    }
  };

  constructor(
    store: Store,
    transcriptStore: TranscriptStore,
    identityManager?: AgentIdentityManager,
    rateLimiter?: RateLimiter,
    memory?: MemoryEngine,
    opts?: {
      config?: CodeoidConfig;
      compressionRegistry?: CompressionRegistry;
      /**
       * Provider registry override (tests / embedders adding backends).
       * Absent = the built-in catalog (claude, gemini, openai).
       */
      providers?: ProviderRegistry;
      /**
       * The daemon's hook bus (built once at startup from config.hooks).
       * Absent = no hooks; sessions pay zero overhead.
       */
      hooks?: HookBus;
      /**
       * Stable identity of this daemon (host:port), scoping dispatch claims to
       * its own tasks. Two daemons sharing one database otherwise reclaim each
       * other's live claims and can claim across tenants — see
       * `DispatchConfig.daemonId`. Absent in tests = unowned tasks.
       */
      daemonId?: string;
      /**
       * Test-only: provider factory injected into every Session this manager
       * constructs, so manager-level integration tests (conductor injection,
       * worker spawn, dispatch host) run without the Claude Agent SDK
       * subprocess. Mirrors SessionCreateOptions._testProvider.
       */
      _testProviderFactory?: () => SessionProvider;
      /** Claude account store (claude-accounts.ts) — the `claude` backend's view of `accounts`. */
      claudeAccounts?: ClaudeAccountStore;
      /** Every backend's accounts (accounts.ts). Default: `<configDir>/accounts.json` (or the store behind `claudeAccounts`). */
      accounts?: AccountStore;
      /** Test-only: a login broker driving a fake login command. */
      _testBackendLogin?: BackendLoginBroker;
      /** OpenAI-compatible endpoint store (openai-endpoints.ts). Default: `<configDir>/endpoints.json`. */
      endpoints?: EndpointStore;
      /** Test-only: the `fetch` endpoint requests (model lists, tests) use. */
      _testEndpointFetch?: typeof fetch;
    },
  ) {
    this.#store = store;
    this.#warmModelLimits();
    this.#transcriptStore = transcriptStore;
    this.#identityManager = identityManager;
    this.#rateLimiter = rateLimiter ?? new RateLimiter();
    this.#memory = memory;
    this.#config = opts?.config;
    this.#compressionRegistry = opts?.compressionRegistry;
    this.#endpoints = opts?.endpoints ?? new EndpointStore();
    this.#endpointFetch = opts?._testEndpointFetch ?? fetch;
    this.#endpointCatalog = new EndpointCatalog(this.#endpoints, this.#endpointFetch);
    const endpoints = { store: this.#endpoints, catalog: this.#endpointCatalog };
    // Before the registry: a keyed backend with named accounts is registered without an env key.
    this.#claudeAccounts = opts?.claudeAccounts ?? new ClaudeAccountStore(opts?.accounts);
    this.#accounts = this.#claudeAccounts.store;
    this.#providers = opts?.providers ?? createDefaultProviderRegistry(opts?.config, process.env, endpoints, this.#accounts);
    // An injected registry (tests) gets the endpoints too; startup's already has them.
    // Like startup, an unreadable endpoints file costs the endpoints, not the daemon.
    if (opts?.providers) {
      try {
        syncEndpointProviders(this.#providers, this.#endpoints, this.#endpointCatalog);
      } catch (err) {
        console.error(`[codeoid] could not load endpoint backends: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    watchEndpointProviders(this.#providers, this.#endpoints, this.#endpointCatalog, () => this.#pushProviders());
    // A keyed backend that gains accounts while the daemon runs becomes pickable.
    this.#accounts.onChange((backend) => {
      if (registerAccountBackends(this.#providers, this.#accounts)) this.#pushProviders();
      // Every change — a handler, a sign-in, a hand edit — reaches the sessions on that backend.
      this.#refreshSessionsOn(backend);
      this.#pushToProviderSubscribers({ type: "accounts.changed", backend });
    });
    this.#hooks = opts?.hooks;
    this.#testProviderFactory = opts?._testProviderFactory;
    this.#backendLogin = opts?._testBackendLogin ?? new BackendLoginBroker();
    this.#dispatcher = new Dispatcher(store, this.#makeDispatcherHost(), {
      ...opts?.config?.dispatch,
      daemonId: opts?.daemonId,
    });
    this.#pushService = new PushService(
      store,
      createPushTransport(opts?.config?.push, (token) => store.pruneDeadToken(token)),
    );
    // SDLC pipeline (docs/sdlc-pipeline.md) — off by default; when enabled, the
    // manager shares the daemon DB (one connection) and rehydrates non-terminal
    // pipelines on construction (resume). The runner drives prompt/slash phases
    // on worker turns; the `() => this` thunk is only dereferenced at run time,
    // after construction. Undefined when disabled ⇒ the daemon stays dark.
    // Evidence of every executed check (docs/loop-engineering-design.md §7),
    // in the daemon DB with full output beside it.
    if (opts?.config) {
      const evidence = new EvidenceService(
        new EvidenceStore(store.database),
        join(dirname(opts.config.dbPath), "evidence"),
      );
      this.#evidence = evidence;
      // Retention: off the boot path, then daily.
      const sweep = (): void => {
        try {
          evidence.sweep();
        } catch (err) {
          console.error(`[evidence] retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      this.#evidenceTimers.push(setTimeout(sweep, 60_000).unref(), setInterval(sweep, 24 * 60 * 60 * 1000).unref());
    }
    this.#pipelines = createPipelineManagerFromConfig(opts?.config, {
      runner: new SessionPhaseRunner(() => this),
      db: store.database,
      ...(this.#evidence ? { evidence: this.#evidence } : {}),
    });
    // Routines share the daemon DB. Built only when enabled, so the kill
    // switch leaves every routine in place but nothing fires.
    if (opts?.config?.routines?.enabled ?? true) {
      this.#routines = new RoutineService(new RoutineStore(store.database), this.#makeRoutineHost(), opts?.config?.routines ?? {});
    }
    // Pack curation surface (docs/pack-loading.md) — always constructed (cheap:
    // no DB / runner). Reads the boot pack config; each mutation persists to
    // config.json AND (if the pipeline is enabled) registers into the manager.
    const p = opts?.config?.pipeline;
    this.#packs = new PackService({
      config: {
        defaultPack: p?.defaultPack ?? null,
        packs: p?.packs ?? [],
        registries: p?.registries ?? [],
      },
      manager: () => this.#pipelines,
      persist: (state) => this.#persistPackConfig(state),
      // The operator's model maps, for the pre-flight `pack show --resolve`
      // view (docs/role-model-binding.md §4) — same maps pipeline.create reads.
      modelConfig: { modelTiers: p?.modelTiers, modelRoles: p?.modelRoles },
      // Machine-wide symlinks (global) vs per-session SDK plugins (session) for
      // a trusted pack's registry skills (docs/pack-loading.md §3a).
      skillScope: p?.skillScope,
    });
  }

  /** Persist the pack state (registries + installed packs + selection) back into
   *  config.json under `pipeline`, preserving any other pipeline fields. */
  #persistPackConfig(state: PackServiceConfig): void {
    mutateConfigFile((raw) => {
      const existing = raw.pipeline;
      const pipeline: Record<string, unknown> =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      pipeline.packs = state.packs;
      pipeline.registries = state.registries;
      pipeline.defaultPack = state.defaultPack;
      raw.pipeline = pipeline;
    });
  }

  /** The dispatch queue driver (P4). Exposed for server lifecycle + tests. */
  get dispatcher(): Dispatcher {
    return this.#dispatcher;
  }

  /** The SDLC pipeline manager, or undefined when the pipeline is disabled
   *  (the default). Exposed for the pipeline control surface + tests. */
  get pipelines(): PipelineManager | undefined {
    return this.#pipelines;
  }

  /** The pack curation service (registries + install/trust/select). Exposed for
   *  the CLI + tests. */
  get packs(): PackService {
    return this.#packs;
  }

  /** The operator's model maps (docs/role-model-binding.md §2.2) — the same
   *  `pipeline.modelTiers`/`modelRoles` slice pipeline.create resolves with,
   *  read here for the collab-adoption and single-session (§6.2) chains. */
  #modelBindingConfig(): ModelBindingConfig | undefined {
    const p = this.#config?.pipeline;
    if (!p) return undefined;
    return { modelTiers: p.modelTiers, modelRoles: p.modelRoles };
  }

  /**
   * How many sessions this subject currently has alive.
   *
   * The authoritative source for the concurrent-session limit. Derived from the
   * live map on every check rather than tracked in a counter, because a counter
   * got both of its edges wrong: resumed sessions never re-registered (so a
   * restart reset the allowance) and three of the four session-removal paths
   * never decremented (so it drifted upward until restart). Reading the map
   * cannot do either. O(sessions) on a session-create — negligible next to
   * spawning an agent, and skipped entirely when limits are off (the default).
   */
  #liveSessionCountFor(sub: string): number {
    if (this.#rateLimiter.disabled) return 0;
    let n = 0;
    for (const session of this.#sessions.values()) {
      if (session.createdBy === sub) n++;
    }
    return n;
  }

  /**
   * Registered provider ids, default first — advertised on `auth.ok` so
   * clients can populate the new-session provider picker.
   */
  providerIds(): string[] {
    const ids = this.#providers.ids();
    const def = this.#providers.defaultId;
    return [def, ...ids.filter((id) => id !== def)];
  }

  /** The same backends with display names and kinds, default first — `auth.ok` and `providers.list`. */
  providerInfo(): ProviderInfo[] {
    return this.providerIds().flatMap((id) => {
      const f = this.#providers.get(id);
      if (!f) return [];
      return [{
        id,
        displayName: f.displayName,
        kind: endpointNameOf(id) !== null ? ("endpoint" as const) : ("builtin" as const),
        isDefault: id === this.#providers.defaultId,
      }];
    });
  }

  /** Supported backends that couldn't activate at startup (diagnostics). */
  unavailableProviders(): Array<{ id: string; hint: string }> {
    return this.#providers.unavailableEntries();
  }

  /** Routines service, or undefined when routines are disabled. */
  get routines(): RoutineService | undefined {
    return this.#routines;
  }

  /** Start the routine scheduler. Call AFTER resumeSessions: boot recovery
   *  closes runs left in flight, whose sessions resume as ordinary ones. */
  startRoutines(): void {
    this.#routines?.start();
  }

  stopRoutines(): void {
    this.#routines?.stop();
  }

  /** Start the dispatcher loop. Call AFTER resumeSessions so surviving
   * workers are back in #sessions before the boot-time reclaim pass runs. */
  startDispatcher(): void {
    this.#dispatcher.start();
  }

  stopDispatcher(): void {
    this.#dispatcher.stop();
  }

  /** Re-drive SDLC pipelines interrupted mid-run at a restart (no-op when the
   *  pipeline is disabled). Fire-and-forget: a failure is logged, not thrown.
   *  Call after resumeSessions on boot. */
  startPipelines(): void {
    const pm = this.#pipelines;
    if (!pm) return;
    void pm.driveResumable().catch((err) => {
      console.error("[pipeline] driveResumable failed on boot:", err);
    });
  }

  /**
   * Resume sessions from persisted transcripts (called on daemon restart).
   * Rebuilds in-memory session objects and scrollback buffers.
   */
  async resumeSessions(): Promise<number> {
    // Correct statuses stranded by a daemon that stopped mid-turn. A resumed
    // Session always starts `idle` in memory, so a row still claiming
    // `thinking` / `tool_running` / `waiting_approval` is pure staleness — it
    // made the session list show work that no longer exists (and, for
    // `waiting_approval`, an approval whose resolver died with the process).
    // Done BEFORE resume so rows and live sessions agree from the first
    // broadcast.
    const corrected = this.#store.reconcileStaleSessionStatuses();
    if (corrected > 0) {
      console.log(
        `[codeoid] reconciled ${corrected} stale session status(es) left by a previous run`,
      );
    }

    // Reload the durable conductor identity first (design R2): the persisted
    // {identityId, wimseUri, apiKey} row is reused instead of re-registering,
    // so the conductor keeps ONE stable WIMSE URI across daemon restarts.
    // Best-effort and null-safe — a missing or stale row just means the next
    // registerConductor() starts fresh.
    const conductor = await this.#identityManager?.resumeConductor();
    if (conductor) {
      console.log(
        `[codeoid] resumed conductor identity ${conductor.wimseUri}`,
      );
    }

    const allMetas = await this.#transcriptStore.loadAllMeta();
    // Checkpoint repositories of sessions that no longer exist (#354) — a
    // crash between destroy's steps, or state lost outside the daemon.
    // Background: never delays the resume.
    void sweepCheckpoints(
      join(this.#transcriptStore.dir, "checkpoints"),
      new Set(allMetas.map((m) => m.sessionId)),
    ).catch(() => {});
    // Newest-first by last activity so the cap keeps the most relevant
    // sessions when there are more than the configured cap on disk.
    const sorted = [...allMetas].sort(
      (a, b) => resumeSortKey(b) - resumeSortKey(a),
    );
    const resumeMaxSessions =
      this.#config?.session?.resumeMaxSessions ?? RESUME_MAX_SESSIONS_DEFAULT;
    const capped = sorted.slice(0, resumeMaxSessions);
    // Goal config by orchestrator session id, built from EVERY meta on disk
    // rather than from `capped`. A child inside this boot's resume window whose
    // orchestrator fell outside it still needs its restrictions and its brief,
    // and the blackboard is keyed on (tenant, goal id) in SQLite — so the
    // child's mount works whether or not the orchestrator object is resident.
    const goalConfigs = new Map<string, CollaborationConfig>();
    for (const m of allMetas) {
      if (m.collaboration) goalConfigs.set(m.sessionId, m.collaboration);
    }
    const deadline = Date.now() + RESUME_DEADLINE_MS;
    let resumed = 0;
    let skippedDeadline = 0;
    let resumedChildren = 0;
    let orphanedChildren = 0;

    for (let i = 0; i < capped.length; i++) {
      // Time-box: a few huge transcripts shouldn't wedge startup. Stop and
      // leave the remainder on disk rather than blocking the daemon listen.
      if (Date.now() > deadline) {
        skippedDeadline = capped.length - i;
        break;
      }
      const meta = capped[i]!;
      try {
        // Role-children need their restrictions rebuilt BEFORE construction —
        // worker shape and capability role are constructor inputs, not things
        // that can be attached afterwards.
        // Resolved once: the role posture and the session must agree on the
        // backend, including when the persisted one is no longer available.
        const providerId = this.#resumeProviderId(meta.providerId, meta.sessionId);
        const child = this.#resumeRoleChild(meta, goalConfigs, providerId);
        if (child) {
          if (child.orphaned) orphanedChildren++;
          else resumedChildren++;
        }
        const session = new Session({
          name: meta.sessionName,
          // Heal a workdir persisted with a literal `~` or one that has since
          // moved — expand/validate it so the SDK can launch. Falls back to
          // the raw value if it can't be resolved (surfaces a clear error on
          // first send rather than crashing resume).
          workdir: normalizeWorkdir(meta.workdir) ?? meta.workdir,
          auth: {
            sub: meta.createdBy,
            scopes: [],
            delegationDepth: 0,
            accountId: meta.accountId,
            projectId: meta.projectId,
          },
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          providers: this.#providers,
          claudeAccounts: this.#claudeAccounts,
          accounts: this.#accounts,
          claudeAccount: meta.claudeAccount ?? null,
          ...(meta.accounts ? { accountChoices: meta.accounts } : {}),
          hooks: this.#hooks,
          identityManager: this.#identityManager,
          existingId: meta.sessionId,
          // Identity timestamps are durable, not turn state. Without these the
          // constructor re-stamps both to `now`, which re-dates every session
          // on every restart and ties them all on recency — collapsing the
          // attention ordering this pass is already sorted by (resumeSortKey
          // reads the very same `meta.lastActivityAt`).
          createdAt: meta.createdAt,
          lastActivityAt: meta.lastActivityAt,
          memory: this.#memory,
          memoryMcp: this.#memoryMcp,
mcpRegistry: this.#mcpRegistry,
mcpHub: this.#mcpHub,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
          // The conductor self-persists (design R2): its role, provider
          // selection, and fleet tools all come back across a restart.
          role: meta.role,
          providerId,
          forkedFrom: meta.forkedFrom,
          worktree: meta.worktree,
          // A collaboration is durable state, not turn state: the goal and
          // its role→backend bindings must come back after a restart or the
          // orchestrator resumes with no idea what it was coordinating.
          collaboration: meta.collaboration,
          // ...and so is the constitution compiled FROM those bindings. A
          // child's came back all along (it rides on `child.options.pack`);
          // an orchestrator's did not, because `compileGoalPack` ran only at
          // create and no `pack` is persisted. That left a resumed
          // orchestrator holding the blackboard mount re-attached below with
          // no goal, no roster, and no statement of its own scope — #338's
          // instruction-vs-fence gap, reopened by every restart. Recompiled
          // from the same config the fence resolves against, so they agree
          // here exactly as they do on create.
          ...(!child && meta.collaboration
            ? { pack: this.#resumeGoalPack(meta.collaboration) }
            : {}),
          // ...and the same is true of a CHILD's restrictions. Spread after
          // `role` so the worker role from the posture wins over `meta.role`
          // (they agree — both are "worker" — but the posture is the authority).
          ...(child?.options ?? {}),
          // Conductor: the config override. Role-child: the roster's resolved
          // model from the posture options — an unconditional `undefined` here
          // would clobber the spread above and resume a bound child on the
          // provider default (the regression the resume tests pin).
          defaultModel:
            meta.role === "conductor"
              ? this.#config?.conductor?.model
              : child?.options.defaultModel,
          // Conductor gets the tenant-wide surface; a collaboration
          // orchestrator gets the role-aware one scoped to its own children.
          // Its id is already known here, so the thunk is trivial.
          fleet:
            meta.role === "conductor"
              ? this.#buildFleetServer(meta.accountId, meta.projectId)
              : meta.collaboration
                ? this.#buildOrchestratorFleetServer(
                    () => meta.sessionId,
                    meta.accountId,
                    meta.projectId,
                  )
                : undefined,
          collaborationCost: meta.collaboration
            ? () => this.#collaborationCostRollup(meta.sessionId)
            : undefined,
          _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
          ...this.#modelHooks,
        });

        // Restore scrollback from transcript, seeding the seq counter past
        // the persisted tail so new appends continue the monotonic sequence.
        // Byte-budgeted + deadline-aware: one huge transcript can neither
        // OOM the daemon nor eat the whole resume window by itself.
        const loadStats: { truncated?: boolean } = {};
        const entries = await this.#transcriptStore.loadTranscript(meta.sessionId, {
          maxBytes: RESUME_TRANSCRIPT_MAX_BYTES,
          deadlineAt: deadline,
          stats: loadStats,
        });
        const messages = entries.map((e) => e.message);
        const maxSeq = entries.reduce((max, e) => Math.max(max, e.seq), -1);
        session.restoreScrollback(messages, maxSeq + 1, entries.map((e) => e.bytes), {
          partialHistory: loadStats.truncated === true,
        });
        // The backend-neutral conversation (#354). Without it a restored
        // session forked / switched backend with no history, and stateless
        // backends answered the next prompt with no memory of the session.
        // Sessions from before the log existed are rebuilt from the
        // transcript once, then read from the log.
        try {
          const canonical = await this.#transcriptStore.loadCanonical(meta.sessionId, {
            maxBytes: RESUME_CANONICAL_MAX_BYTES,
          });
          const index = await this.#transcriptStore.loadTurnIndex(meta.sessionId);
          // No log: a session from before it existed. Rebuild once from the
          // WHOLE transcript (the scrollback window above may be a tail) and
          // persist it — a long session's history must not shrink to the
          // window, or to just the next turn on the following restart.
          let rebuildFrom = messages;
          if (!canonical && loadStats.truncated === true) {
            const all = await this.#transcriptStore.loadTranscript(meta.sessionId, { deadlineAt: deadline });
            rebuildFrom = all.map((e) => e.message);
          }
          const history =
            canonical?.turns ?? (rebuildFrom.length > 0 ? canonicalFromTranscript(rebuildFrom, providerId) : []);
          session.restoreTurns(history, index ?? turnIndexFromHistory(history), {
            persistHistory: !canonical && history.length > 0,
            persistIndex: !index && history.some((t) => t.turnId),
            partial: canonical?.partial ?? false,
          });
          if (meta.redactedBackings) session.adoptRedactedBackings(meta.redactedBackings);
          if (meta.backingFresh) await session.reseedFreshBacking();
        } catch (err) {
          console.error(
            `[codeoid/resume] canonical history restore failed for ${meta.sessionId} (session resumes without it): ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        this.#sessions.set(session.id, session);
        // Track a resumed child's mount so teardown revokes it. Without this a
        // restart leaks one still-valid blackboard credential per child on
        // every boot, and destroying the goal would not revoke them.
        if (child?.options.blackboardMcp) {
          this.#blackboardTokens.set(session.id, child.options.blackboardMcp.token);
        }
        // An orchestrator's own mount is scoped to its own id, so it can only
        // be attached now — exactly as on the create path.
        if (meta.collaboration) {
          this.#attachOrchestratorBlackboard(session, meta.collaboration);
        }
        // Resume is NOT a creation — don't burn a slot in the
        // per-user concurrency cap. Otherwise restarting with N
        // persisted sessions saturates the limit on the spot and the
        // next legitimate `session.create` fails with
        // "Concurrent session limit reached" until the user
        // /destroys some.
        resumed++;
      } catch {
        // Skip sessions that fail to resume
      }
    }

    const droppedCap = sorted.length - capped.length;
    if (droppedCap > 0 || skippedDeadline > 0) {
      console.warn(
        `[codeoid] resume: restored ${resumed} of ${sorted.length} session(s); ${droppedCap} left over the ${resumeMaxSessions}-session cap, ${skippedDeadline} skipped past the ${RESUME_DEADLINE_MS}ms deadline (still on disk; loadable on a future restart).`,
      );
    }
    if (resumedChildren > 0) {
      console.log(
        `[codeoid] resume: ${resumedChildren} collaboration role-child(ren) restored with their role scoping + goal blackboard`,
      );
    }
    // Loud, because it is the one path where a role-child comes back WITHOUT
    // its goal: its restrictions hold, but it cannot coordinate, and a silent
    // degrade would look identical to a healthy fleet in the session list.
    if (orphanedChildren > 0) {
      console.warn(
        `[codeoid] resume: ${orphanedChildren} role-child(ren) had no recoverable goal config — restored read-only-as-configured, with no blackboard mount and no autonomous budget`,
      );
    }

    return resumed;
  }

  /**
   * Rebuild a role-child's restrictions from disk, or `undefined` when this
   * meta isn't a role-child at all.
   *
   * Why this exists: `collaborationRole` was persisted from the first day of
   * P1b, and resume read `meta.collaboration` while silently ignoring it. The
   * visible symptom was cosmetic (children detached from their parent in the
   * session list). The real one was not — a resumed child came back with:
   *
   *   - no `workerShape`, so its next turn registered a FULL session agent
   *     instead of a scope-capped `scout` leaf (`#ensureAgentIdentity`);
   *   - no capability role, so `roleDeniesTool` had nothing to deny with and a
   *     read-only reviewer's write tools degraded from denied to merely asked;
   *   - no blackboard mount, so it could not publish a handoff; and
   *   - no autonomous budget, so it came back `guarded` — which, with nobody
   *     ever attached to a child, parks it at `waiting_approval` forever on its
   *     first non-safe tool call. The fleet looked alive and was dead.
   *
   * Nothing about a child needs a new persisted field: its identity
   * (`collaborationRole`) plus its goal's config reproduces the plan it spawned
   * under, via `plannedChildFor`.
   */
  #resumeRoleChild(
    meta: TranscriptMeta,
    goalConfigs: ReadonlyMap<string, CollaborationConfig>,
    /** The backend the child actually resumes on (`#resumeProviderId`). */
    providerId: string,
  ):
    | {
        orphaned: boolean;
        options: {
          role: "worker";
          workerShape: "ship" | "scout";
          pack: ReturnType<typeof roleChildPosture>["pack"];
          collaborationRole: ReturnType<typeof roleChildPosture>["collaborationRole"];
          initialMode?: { mode: SessionMode; maxTurns?: number };
          blackboardMcp?: { url: string; token: string };
          /** The roster's resolved model for this child (docs/role-model-binding.md
           *  §6.1) — without it a bound child resumes on the provider default
           *  while SessionInfo still claims the resolved model. */
          defaultModel?: string;
        };
      }
    | undefined {
    const role = meta.collaborationRole;
    if (!role) return undefined;

    const collaboration = goalConfigs.get(role.parentSessionId);
    const planned = collaboration
      ? plannedChildFor(collaboration, role.roleName, role.ordinal)
      : undefined;

    if (!collaboration || !planned) {
      // Torn state: the child's transcript survived while its orchestrator's
      // did not (teardown removes both). Restore the FENCE from what the child
      // itself carries — `write` is on `collaborationRole` — and nothing else.
      // Deliberately no autonomous budget: an agent that cannot coordinate
      // should not be able to burn turns unattended.
      return {
        orphaned: true,
        options: roleChildPosture(
          {
            roleName: role.roleName,
            ordinal: role.ordinal,
            providerId,
            shape: role.write ? "ship" : "scout",
            write: role.write,
          },
          role.parentSessionId,
          orphanedChildBrief(role.roleName, role.write),
        ),
      };
    }

    return {
      orphaned: false,
      options: {
        ...roleChildPosture(planned, role.parentSessionId, childBrief(collaboration, planned)),
        // The roster's resolved model comes back with the child — same source
        // (`plannedChildFor`) as the spawn path, so they can't drift. Only on
        // the planned backend: if that is gone and the child resumes on claude,
        // the planned model belongs to another vendor.
        ...(planned.model !== undefined && planned.providerId === providerId
          ? { defaultModel: planned.model }
          : {}),
        // Re-armed per boot, not persisted: the budget is a per-stretch-of-work
        // allowance, and carrying a spent one across a restart would resume a
        // child with zero turns left.
        initialMode: {
          mode: "autonomous",
          maxTurns: this.#dispatcher.config.workerToolBudget,
        },
        // Scoped to the child's OWN tenant plus its goal id. Same authorSub the
        // pre-restart versions carry, so its history stays one contributor.
        ...(() => {
          const mount = this.#blackboardMountFor(
            {
              accountId: meta.accountId,
              projectId: meta.projectId,
              goalSessionId: role.parentSessionId,
            },
            planned,
          );
          return mount ? { blackboardMcp: mount } : {};
        })(),
      },
    };
  }

  /**
   * Resolve a session by id, gated on tenancy. Returns null when:
   *
   *   - the id doesn't exist, OR
   *   - the requester's `(accountId, projectId)` doesn't match the
   *     session's owner.
   *
   * Both cases collapse to the same "not found" response at the
   * caller, so we don't leak session-id existence across tenants —
   * an account-A user trying to attach to an account-B sessionId
   * gets the same shape they'd get for a typo. Sessions whose
   * owner has empty tenancy (e.g. a malformed resume) only match
   * an auth context with empty tenancy, which doesn't happen in
   * normal flows; those sessions remain only visible to system /
   * resume paths.
   */
  #getOwnedSession(sessionId: string, auth: AuthContext): Session | null {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    if (
      session.accountId !== auth.accountId ||
      session.projectId !== auth.projectId
    ) {
      return null;
    }
    return session;
  }

  /**
   * Handle an inbound client message, enforce scopes, and return a response.
   */
  async handle(
    msg: ClientMessage,
    auth: AuthContext,
    client: AttachedClient,
    opts?: {
      /**
       * The caller's raw bearer token, retained by the transport for flows
       * that need the owner as an RFC 8693 delegation SUBJECT — today only
       * conductor creation (owner → conductor token exchange). Never logged,
       * never persisted.
       */
      rawToken?: string;
    },
  ): Promise<DaemonMessage> {
    switch (msg.type) {
      case "ping":
        // Liveness heartbeat — lets a client detect a half-open/zombie
        // socket (suspended webview, slept laptop) that never fired a close
        // event, by noticing the pong never arrives.
        return { type: "response.ok", requestId: msg.id, data: { pong: true } };
      case "session.create":
        if (msg.role === "conductor") {
          return this.#createConductor(msg, auth, opts?.rawToken);
        }
        if (msg.role) {
          // A role this daemon doesn't implement (newer client / future
          // worker role). Fail closed rather than silently downgrading to a
          // normal session — a caller asking for a constrained role must not
          // get an unconstrained one.
          return {
            type: "response.error",
            requestId: msg.id,
            error: `Unsupported session role: "${msg.role}"`,
            code: "invalid_request",
          };
        }
        return this.#create(msg, auth);
      case "session.list":
        return this.#list(msg, auth);
      case "session.attach":
        return this.#attach(msg, auth, client);
      case "scrollback.page":
        return this.#pageScrollback(msg, auth);
      case "session.detach":
        return this.#detach(msg, client);
      case "session.send":
        return this.#send(msg, auth);
      case "session.interrupt":
        return this.#interrupt(msg, auth);
      case "session.approve":
        return this.#approve(msg, auth);
      case "session.ui_response":
        return this.#uiResponse(msg, auth);
      case "session.part_action":
        return this.#partAction(msg, auth);
      case "session.commands":
        return this.#sessionCommands(msg, auth);
      case "session.destroy":
        return this.#destroySession(msg, auth);
      case "session.set_mode":
        return this.#setMode(msg, auth);
      case "session.pin":
        return this.#pin(msg, auth);
      case "session.unpin":
        return this.#unpin(msg, auth);
      case "session.rotate":
        return this.#rotate(msg, auth);
      case "session.search":
        return this.#search(msg, auth);
      case "session.set_model":
        return this.#setModel(msg, auth);
      case "session.set_effort":
        return this.#setEffort(msg, auth);
      case "session.set_provider":
        return this.#setProvider(msg, auth);
      case "session.mcp_reconnect":
        return this.#mcpReconnect(msg, auth);
      case "session.mcp_refresh":
        return this.#mcpRefresh(msg, auth);
      case "mcp.approve":
        return this.#mcpApprove(msg, auth);
      case "mcp.approve.preview":
        return this.#mcpApprovePreview(msg, auth);
      case "session.fork":
        return this.#fork(msg, auth);
      case "session.rename":
        return this.#rename(msg, auth);
      case "fs.list":
        return this.#fsList(msg, auth);
      case "fs.read":
        return this.#fsRead(msg, auth);
      case "fs.browse_dir":
        return this.#fsBrowseDir(msg, auth);
      case "claude.config":
        return this.#claudeConfig(msg, auth);
      case "blackboard.index":
        return this.#blackboardIndex(msg, auth);
      case "blackboard.read":
        return this.#blackboardRead(msg, auth);
      case "collaboration.panels":
        return this.#collaborationPanels(msg, auth);
      case "fleet.subscribe":
        return this.#fleetSubscribe(msg, auth, client);
      case "fleet.unsubscribe":
        return this.#fleetUnsubscribe(msg, client);
      case "models.list":
        return this.#modelsList(msg);
      case "providers.list":
        return this.#providersList(msg, client);
      case "endpoints.list":
        return this.#endpointsList(msg, auth);
      case "endpoints.set":
        return this.#endpointsSet(msg, auth);
      case "endpoints.remove":
        return this.#endpointsRemove(msg, auth);
      case "endpoints.test":
        return this.#endpointsTest(msg, auth);
      case "session.export":
        return this.#sessionExport(msg, auth);
      case "session.import":
        return this.#sessionImport(msg, auth);
      case "settings.schema":
        return this.#settingsSchema(msg, auth);
      case "settings.get":
        return this.#settingsGet(msg, auth);
      case "settings.set":
        return this.#settingsSet(msg, auth);
      case "backend.login.start":
        return this.#backendLoginStart(msg, auth);
      case "backend.login.submit":
        return this.#backendLoginSubmit(msg, auth);
      case "backend.login.cancel":
        return this.#backendLoginCancel(msg, auth);
      case "backend.login.wait":
        return this.#backendLoginWait(msg, auth);
      case "accounts.list":
        return this.#accountsList(msg, auth);
      case "accounts.set":
        return this.#accountsSet(msg, auth);
      case "accounts.remove":
        return this.#accountsRemove(msg, auth);
      case "accounts.set_default":
        return this.#accountsSetDefault(msg, auth);
      case "session.set_account":
        return this.#sessionSetAccount(msg, auth);
      case "claude.accounts.list":
        return this.#claudeAccountsList(msg, auth);
      case "claude.accounts.set":
        return this.#claudeAccountsSet(msg, auth);
      case "claude.accounts.remove":
        return this.#claudeAccountsRemove(msg, auth);
      case "claude.accounts.set_default":
        return this.#claudeAccountsSetDefault(msg, auth);
      case "session.set_claude_account":
        return this.#sessionSetClaudeAccount(msg, auth);
      case "session.approvals":
        return this.#sessionApprovals(msg, auth);
      case "session.turns":
        return this.#sessionTurns(msg, auth);
      case "session.rewind":
        return this.#sessionRewind(msg, auth);
      case "session.compare":
        return this.#sessionCompare(msg, auth);
      case "compare.get":
        return this.#compareGet(msg, auth);
      case "compare.list":
        return this.#compareList(msg, auth);
      case "compare.keep":
        return this.#compareKeep(msg, auth, client);
      case "skill.grant":
        return this.#skillGrant(msg, auth);
      case "mcp.oauth.begin":
        return this.#mcpOAuthBegin(msg, auth);
      case "mcp.oauth.complete":
        return this.#mcpOAuthComplete(msg, auth);
      case "mcp.oauth.disconnect":
        return this.#mcpOAuthDisconnect(msg, auth);
      case "mcp.adopt":
        return this.#mcpAdopt(msg, auth);
      case "usage.daily":
        return this.#usageDaily(msg, auth);
      case "routine.create":
      case "routine.update":
      case "routine.delete":
      case "routine.list":
      case "routine.get":
      case "routine.run":
      case "routine.cancel_run":
      case "routine.runs":
      case "routine.token":
      case "routine.preview":
        return this.#routineHandle(msg, auth);
      case "evidence.get":
        return this.#evidenceGet(msg, auth);
      case "pipeline.create":
        return this.#pipelineCreate(msg, auth);
      case "pipeline.list":
        return this.#pipelineList(msg, auth);
      case "pipeline.get":
        return this.#pipelineGet(msg, auth);
      case "pipeline.advance":
        return this.#pipelineAdvance(msg, auth);
      case "pipeline.answer":
        return this.#pipelineAnswer(msg, auth);
      case "pipeline.abort":
        return this.#pipelineAbort(msg, auth);
      case "pipeline.revise":
        return this.#pipelineRevise(msg, auth);
      case "pipeline.pack.list":
        return this.#packList(msg, auth);
      case "pipeline.registry.add":
        return this.#registryAdd(msg, auth);
      case "pipeline.registry.refresh":
        return this.#registryRefresh(msg, auth);
      case "pipeline.pack.install":
        return this.#packInstall(msg, auth);
      case "pipeline.pack.remove":
        return this.#packRemove(msg, auth);
      case "pipeline.pack.trust":
        return this.#packTrust(msg, auth);
      case "pipeline.pack.select":
        return this.#packSelect(msg, auth);
      case "push.register":
        return this.#pushRegister(msg, auth);
      case "push.unregister":
        return this.#pushUnregister(msg, auth);
      default: {
        // Inbound messages are cast from raw JSON at the transport, so an
        // unknown/malformed `type` reaches here. Without this the function
        // returned undefined → the daemon sent nothing → the client's request
        // never resolved until its 30s timeout. Resolve it explicitly.
        const m = msg as { id?: unknown; type?: unknown };
        return {
          type: "response.error",
          requestId: typeof m.id === "string" ? m.id : "",
          error: `Unknown message type: ${typeof m.type === "string" ? m.type : "(none)"}`,
          code: "invalid_request",
        };
      }
    }
  }

  async #sessionExport(
    msg: Extract<ClientMessage, { type: "session.export" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:list",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      const info = session.toInfo();
      const bundle = await packSession(
        {
          session: {
            id: info.id,
            name: info.name,
            workdir: info.workdir,
            createdAt: info.createdAt,
            ...(info.model ? { model: info.model } : {}),
            ...(info.fallbackModel ? { fallbackModel: info.fallbackModel } : {}),
            ...(info.mode ? { mode: info.mode } : {}),
            ...(info.rotation ? { rotation: { count: info.rotation.count } } : {}),
            ...(info.pinnedFiles ? { pinnedFiles: info.pinnedFiles } : {}),
          },
          exporter: auth,
          includeMemory: msg.includeMemory ?? true,
          includePinnedFiles: msg.includePinnedFiles ?? false,
          ...(msg.aliasOverride ? { aliasOverride: msg.aliasOverride } : {}),
        },
        {
          transcript: this.#transcriptStore,
          store: this.#store,
          memory: this.#memory ?? null,
          // Bind the exporter's tenant so the derived workspace id matches the
          // tenant-scoped ids episodes were written under.
          workspaceIdFor: (wd: string) => workspaceIdFromPath(wd, auth),
        },
      );

      // Inline below 5 MiB; otherwise spill to disk so a clipboard
      // round-trip stays sane.
      const json = JSON.stringify(bundle);
      const sizeBytes = Buffer.byteLength(json, "utf-8");
      const inlineCap = 5 * 1024 * 1024;
      const useFile = msg.toFile === true || sizeBytes > inlineCap;

      const manifest = {
        exportedAt: bundle.manifest.exportedAt,
        session: {
          id: bundle.manifest.session.id,
          name: bundle.manifest.session.name,
          createdAt: bundle.manifest.session.createdAt,
          ...(bundle.manifest.session.model ? { model: bundle.manifest.session.model } : {}),
          ...(bundle.manifest.session.mode ? { mode: bundle.manifest.session.mode } : {}),
        },
        workdir: {
          alias: bundle.manifest.workdir.alias,
          aliasSource: bundle.manifest.workdir.aliasSource,
          originalAbsolute: bundle.manifest.workdir.originalAbsolute,
        },
        counts: bundle.manifest.counts,
      };

      if (useFile) {
        const written = await writeBundleToFile(bundle);
        return {
          type: "session.export.result",
          requestId: msg.id,
          manifest,
          payload: { kind: "file", path: written.path, sizeBytes: written.sizeBytes },
        };
      }
      return {
        type: "session.export.result",
        requestId: msg.id,
        manifest,
        payload: { kind: "inline", bundle, sizeBytes },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  async #sessionImport(
    msg: Extract<ClientMessage, { type: "session.import" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:create",
        code: "forbidden",
      };
    }
    // Same per-user rate limit as session.create — import allocates a
    // fresh Session, SDK identity, and DB rows. Without this gate a
    // tight loop of inline imports OOMs the daemon.
    const rateCheck = this.#rateLimiter.check(auth.sub, this.#liveSessionCountFor(auth.sub));
    if (!rateCheck.allowed) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: rateCheck.reason,
        code: "rate_limited",
      };
    }
    try {
      // Resolve the bundle JSON from inline payload or a saved file.
      let bundleRaw: unknown;
      if (msg.source.kind === "inline") {
        bundleRaw = msg.source.bundle;
      } else {
        // SECURITY: bound the file-source path to a fixed import dir.
        // Without this any client with `session:create` can read any
        // file the daemon can — `/etc/passwd`, `~/.aws/credentials`,
        // sibling sessions' transcripts. The fixed dir is created on
        // first use and realpath-checked to defeat symlink pivots.
        const safe = await resolveImportPath(msg.source.path);
        if (!safe.ok) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: safe.reason,
            code: "invalid_request",
          };
        }
        const fs = await import("node:fs");
        // Cap the read at 100 MB to bound memory pressure under
        // pathological bundles.
        const stat = await fs.promises.stat(safe.path);
        if (stat.size > 100 * 1024 * 1024) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: `bundle too large (${stat.size} bytes; cap 100 MB)`,
            code: "invalid_request",
          };
        }
        const text = await fs.promises.readFile(safe.path, "utf-8");
        bundleRaw = JSON.parse(text);
      }
      const v = validateBundle(bundleRaw);
      if (!v.ok) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: v.reason,
          code: "invalid_request",
        };
      }
      const bundle = v.bundle;

      const result = await unpackBundle(
        {
          bundle,
          targetWorkdir: msg.targetWorkdir,
          ...(msg.nameOverride ? { nameOverride: msg.nameOverride } : {}),
          writePinnedFiles: msg.writePinnedFiles ?? false,
          importer: auth,
        },
        {
          transcript: this.#transcriptStore,
          memory: this.#memory ?? null,
          // Bind the importer's tenant so imported episodes land under the same
          // tenant-scoped workspace id this importer will read from.
          workspaceIdFor: (wd: string) => workspaceIdFromPath(wd, auth),
          registerSession: async (init: ImportedSessionInit) => {
            // Create the Session shell first so we have an id; we don't
            // start() its query loop — the importer attaches via the
            // normal session.attach flow afterwards.
            const session = new Session({
              name: init.name,
              workdir: init.workdir,
              auth,
              store: this.#store,
              transcriptStore: this.#transcriptStore,
              providers: this.#providers,
              claudeAccounts: this.#claudeAccounts,
              hooks: this.#hooks,
              ...(this.#identityManager
                ? { identityManager: this.#identityManager }
                : {}),
              ...(this.#memory ? { memory: this.#memory } : {}),
              ...(this.#memoryMcp ? { memoryMcp: this.#memoryMcp } : {}),
              mcpRegistry: this.#mcpRegistry,
              mcpHub: this.#mcpHub,
              config: this.#config,
              compressionRegistry: this.#compressionRegistry,
              _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
              ...this.#modelHooks,
            });
            this.#sessions.set(session.id, session);
            this.#rateLimiter.recordCreation(auth.sub);
            this.#store.audit(
              auth.sub,
              "session.import",
              session.id,
              `forked-from=${init.forkedFrom.alias}@session:${init.forkedFrom.sessionId} exporter=${init.forkedFrom.exporterIdentity.sub}`,
            );
            return session.id;
          },
        },
      );

      return {
        type: "session.import.result",
        requestId: msg.id,
        newSessionId: result.newSessionId,
        importedMessages: result.importedMessages,
        importedEpisodes: result.importedEpisodes,
        importedTurns: result.importedTurns,
        pinnedFilesWritten: result.pinnedFilesWritten,
        warnings: result.warnings,
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  async #claudeConfig(
    msg: Extract<ClientMessage, { type: "claude.config" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Reuse fs:read since this only reads ~/.claude/ + workdir/.claude/ —
    // strictly broader than session.workdir, but the data is descriptive:
    // env and header values are never read out, MCP and hook commands are
    // shown by their program's name, args by their count, and URLs by host
    // and path shape (#394).
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      const snapshot = await readClaudeConfig(session.workdir);
      // Read for the drawer only — what a session applies changes on its first
      // turn or a refresh. Freshly, before the rows: a row and its fingerprint
      // are of the files as they are now.
      await session.peekMcpView();
      const mcpStale = await session.mcpStale();
      const reachOf = session.mcpReachSnapshot();
      const live = session.sdkMcpSnapshot;
      // A name two entries give different URLs to: which one the backend runs
      // isn't known here, so neither is offered for adopting.
      const urlsByName = new Map<string, Set<string | null>>();
      for (const s of snapshot.mcpServers) urlsByName.set(s.name, (urlsByName.get(s.name) ?? new Set()).add(s.url));
      const mcpServers: ClaudeConfigMcpServer[] = snapshot.mcpServers.map((s): ClaudeConfigMcpServer => {
        const liveStatus = live.status.get(s.name);
        const liveTools = live.tools.get(s.name);
        const spec = this.#mcpRegistry?.get(s.name);
        const adopted = spec !== undefined && isOAuthServer(spec) && spec.transport.kind === "http" && spec.transport.url === s.url;
        return {
          ...s,
          // What leaves the daemon carries no credential (#394): a Claude
          // config keeps them in commands, args and URLs as often as in env
          // and headers (whose values are never read out). So: the program's
          // name and how many args — not their text — and the URL's shape.
          command: s.command === null ? null : serverProgram(s.command),
          args: [],
          argCount: s.args.length,
          url: s.url === null ? null : redactMcpUrl(s.url),
          // Whether it reaches this session's other backends too, and why not (#395).
          ...(() => {
            const reach = adopted ? ({ reach: "all" } as const) : reachOf.reach(s);
            // A project's server carries the fingerprint of the entry shown, so an
            // approval is of exactly what was looked at (the repo can't swap it).
            const fp = s.scope === "workdir" ? reachOf.fingerprint(s.name, s.path) : undefined;
            return { ...(reach ? { otherBackends: reach } : {}), ...(fp ? { fingerprint: fp } : {}) };
          })(),
          // Everything else read from the file is a short label, bounded. (A
          // name is an address, so it's cut, not redacted: one that long is
          // never adoptable anyway.)
          name: s.name.length > 128 ? `${s.name.slice(0, 128)}…` : s.name,
          type: s.type === null ? null : shownLabel(s.type, 40),
          envKeys: s.envKeys.slice(0, MAX_SHOWN_KEYS).map((k) => shownLabel(k)),
          ...(s.headerKeys ? { headerKeys: s.headerKeys.slice(0, MAX_SHOWN_KEYS).map((k) => shownLabel(k)) } : {}),
          ...(liveStatus !== undefined ? { liveStatus } : {}),
          ...(liveTools !== undefined ? { liveTools } : {}),
          ...(fromRepoFile(s) ? { projectFile: true as const } : {}),
          ...(adopted
            ? { adopted: true as const }
            : urlsByName.get(s.name)!.size === 1
              ? (() => {
                  const offer = this.#offerAdoption(s, snapshot.mcpServers, liveStatus, auth);
                  return offer === "drawer" ? { adoptable: true as const } : offer === "full-url" ? { adoptByFullUrl: true as const } : {};
                })()
              : {}),
        };
      });
      // Servers the backend runs that no config file here declares — the
      // claude.ai connectors, plugins' servers, codeoid's own — so they can be seen and
      // reconnected too.
      const declared = new Set(mcpServers.map((s) => s.name));
      for (const [name, liveStatus] of live.status) {
        if (declared.has(name)) continue;
        mcpServers.push({
          name,
          scope: "global",
          path: "",
          command: null,
          args: [],
          envKeys: [],
          url: null,
          type: null,
          liveStatus,
          liveTools: live.tools.get(name) ?? [],
          liveOnly: true,
        });
      }
      return {
        type: "claude.config.result",
        requestId: msg.id,
        workdir: session.workdir,
        agents: snapshot.agents,
        skills: snapshot.skills,
        mcpServers,
        hooks: snapshot.hooks.map((h) => ({
          ...h,
          event: shownLabel(h.event),
          matcher: h.matcher === null ? null : shownLabel(h.matcher, 200),
          kind: shownLabel(h.kind, 40),
          command: commandSummary(h.command),
        })),
        mcpReconnect: session.canReconnectMcp,
        ...(mcpStale ? { mcpStale: true } : {}),
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  /**
   * Cache the live model catalog a provider reported.
   *
   * Every non-empty report wins, overwriting the previous one. Providers
   * report on each query-loop build (i.e. session start), so a model added to
   * a backend's gateway appears in the picker on the next session instead of
   * waiting for a daemon restart — which matters now that the qwen backend
   * resolves its catalog from a live `/models` call rather than a static list.
   * An identical report is dropped before touching SQLite, so the common case
   * (nothing changed since the last session) costs one comparison.
   *
   * EMPTY reports are ignored rather than cached: a backend that fails to
   * answer must not clobber a good catalog with nothing.
   *
   * Each accepted report is persisted to SQLite (keyed by provider id), so
   * subsequent boots serve current model names before any turn runs (see
   * `#currentModels`) instead of the baked-in fallback that goes stale
   * between codeoid releases.
   *
   * TypeScript-private (not `#`) so unit tests can exercise the persistence
   * path directly without a live backend query — same convention as
   * `Session._applyInterruptedStateToTool`. Do NOT call from production code
   * outside the `onModels` wiring.
   */
  private _cacheModels(providerId: string, raw: ReadonlyArray<CatalogEntry>): void {
    if (raw.length === 0) return;
    // A window the provider publishes on its catalog stays ON the catalog and
    // is read from there (modelContextWindow). Copying it into the turn cache
    // made two stores with different lifecycles: the catalog is replaced
    // wholesale per report, the copy was upsert-only, so a window the backend
    // stopped publishing kept winning forever.
    const models = raw.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      ...(m.description ? { description: m.description } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.efforts ? { efforts: m.efforts } : {}),
      ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
      isDefault: m.isDefault === true || m.value === "default",
    }));
    const previous = this.#modelsCache.get(providerId);
    if (previous && JSON.stringify(previous) === JSON.stringify(models)) return;
    this.#modelsCache.set(providerId, models);
    try {
      this.#store.saveModelCatalog(providerId, models);
    } catch (err) {
      // Persistence is best-effort — the in-memory cache still serves this
      // lifetime; next boot just falls back one tier further.
      console.error(
        `[codeoid/models] failed to persist ${providerId} model catalog: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Cache key for #modelLimits. NUL-joined: no id or path can contain it,
   *  so no two scopes can collide. */
  static #limitsKey(scope: WindowScope, providerId: string, model: string): string {
    return [scope.accountId, scope.projectId, scope.workdir, providerId, model].join("\u0000");
  }

  /**
   * Remember a window a completed turn reported (the `onModelLimits` wiring).
   * TypeScript-private, same convention as `_cacheModels`: tests drive it
   * directly rather than standing up a live backend.
   */
  private _cacheModelLimits(scope: WindowScope, providerId: string, model: string, contextWindow: number): void {
    if (isPlaceholderModel(providerId, model) || !(contextWindow > 0)) return;
    const key = SessionManager.#limitsKey(scope, providerId, model);
    if (this.#modelLimits.get(key) === contextWindow) return;
    this.#modelLimits.set(key, contextWindow);
    try {
      this.#store.saveModelLimits(scope, providerId, model, contextWindow);
    } catch (err) {
      // Best-effort, like the catalog: memory still serves this lifetime.
      console.error(
        `[codeoid/models] failed to persist ${providerId}/${model} window: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * A window some backend stated for (provider, model): one a turn in this
   * scope reported, else one the provider publishes on its catalog (qwen-code
   * and pi do). Undefined when neither knows, and callers fall back to
   * inference (targetContextWindow / contextWindowForModel).
   *
   * A catalog window is the backend's own configured value, not a
   * measurement — qwen-code fills unconfigured models from its own table
   * (200k default). It is still the window that backend compacts against,
   * which makes it a better answer than codeoid's model-id guess.
   */
  modelContextWindow(scope: WindowScope, providerId: string, model: string): number | undefined {
    const endpoint = endpointNameOf(providerId);
    if (!model) {
      // An endpoint session on its default model still has a configured window.
      if (endpoint === null) return undefined;
      const e = this.#safeEndpoint(endpoint);
      return e ? configuredContextWindow(e, e.defaultModel ?? e.models[0]?.id) : undefined;
    }
    const reported = this.#modelLimits.get(SessionManager.#limitsKey(scope, providerId, model));
    if (reported !== undefined) return reported;
    if (endpoint !== null) {
      // What the user configured for this endpoint — a local server's window
      // is whatever it was started with, which no table can guess.
      const e = this.#safeEndpoint(endpoint);
      return e ? configuredContextWindow(e, model) : undefined;
    }
    const published = this.#currentModels(providerId).models.find((m) => m.value === model)?.contextWindow;
    return typeof published === "number" && published > 0 ? published : undefined;
  }

  /** A stored endpoint, or undefined when it's gone or the store can't be read. */
  #safeEndpoint(name: string) {
    try {
      return this.#endpoints.get(name);
    } catch {
      return undefined;
    }
  }

  /** Warm #modelLimits from disk. Called once at construction. */
  #warmModelLimits(): void {
    try {
      for (const r of this.#store.getAllModelLimits()) {
        this.#modelLimits.set(SessionManager.#limitsKey(r, r.providerId, r.model), r.contextWindow);
      }
    } catch {
      // A missing/old table just means nothing is warm yet.
    }
  }

  /**
   * The model hooks every Session this manager builds gets. One object, spread
   * at each construction site: pasting the lambdas into all eight meant a
   * ninth path that forgot them would compile and silently neither teach nor
   * consult the window cache.
   */
  readonly #modelHooks = {
    onModels: (providerId: string, m: ReadonlyArray<CatalogEntry>) => this._cacheModels(providerId, m),
    onModelLimits: (scope: WindowScope, providerId: string, model: string, window: number) =>
      this._cacheModelLimits(scope, providerId, model, window),
    modelWindow: (scope: WindowScope, providerId: string, model: string) =>
      this.modelContextWindow(scope, providerId, model),
  };



  /**
   * The model catalog to serve for a provider, best source first:
   *   1. live    — reported by that provider's backend this daemon lifetime
   *   2. cached  — the last live list persisted by a previous lifetime
   *   3. fallback — the baked-in catalog (claude only; other providers have
   *                 no baked-in list and serve empty until they report)
   * `live` is true only for tier 1, so clients keep refetching until the
   * backend has actually been asked this lifetime.
   */
  #currentModels(providerId: string): { models: ModelInfo[]; live: boolean } {
    const liveModels = this.#modelsCache.get(providerId);
    if (liveModels) return { models: liveModels, live: true };
    const persisted = this.#persistedModels(providerId);
    if (persisted) return { models: persisted, live: false };
    return {
      // The built-in fallback is Claude's catalog, whatever the default is.
      models: providerId === CLAUDE_PROVIDER_ID ? fallbackModelInfos() : [],
      live: false,
    };
  }

  /** Lazily-loaded persisted catalogs (null = never reported / unreadable). */
  #persistedModelsCache = new Map<string, ModelInfo[] | null>();
  #persistedModels(providerId: string): ModelInfo[] | null {
    if (!this.#persistedModelsCache.has(providerId)) {
      let value: ModelInfo[] | null = null;
      try {
        value = this.#store.getModelCatalog(providerId);
      } catch {
        value = null;
      }
      this.#persistedModelsCache.set(providerId, value);
    }
    return this.#persistedModelsCache.get(providerId) ?? null;
  }

  async #modelsList(
    msg: Extract<ClientMessage, { type: "models.list" }>,
  ): Promise<DaemonMessage> {
    // No provider = the catalog of the backend a new session would land on.
    const provider = msg.provider ?? this.#providers.defaultId;
    const endpoint = endpointNameOf(provider);
    if (endpoint !== null) {
      // Configured models, else the server's own /models (briefly cached).
      const { models, live } = await this.#endpointCatalog.models(endpoint);
      return {
        type: "models.list.result",
        requestId: msg.id,
        models: models.map((m) => ({
          value: m.id,
          displayName: m.displayName,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        })),
        live,
        provider,
      };
    }
    const { models, live } = this.#currentModels(provider);
    return { type: "models.list.result", requestId: msg.id, models, live, provider };
  }

  // ---------- settings ----------

  /** Serve the declarative settings manifest. Read-only, `settings:read`. */
  #settingsSchema(
    msg: Extract<ClientMessage, { type: "settings.schema" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_READ)) {
      return this.#settingsForbidden(msg.id);
    }
    return { type: "settings.schema.result", requestId: msg.id, manifest: getManifest() };
  }

  /** Read-only registry MCP servers + live health for the settings surface.
   *  Config comes from the registry; health/tools reflect what the daemon-owned
   *  hub has observed so far (no live probe — opening settings has no side effects). */
  #mcpServerStatuses(auth: AuthContext): McpServerStatus[] {
    const reg = this.#mcpRegistry;
    const hub = this.#mcpHub;
    if (!reg || !hub) return [];
    return reg.list().map((spec) => {
      // An OAuth server runs as the viewer's tenant, and a session's own
      // snapshot of a global one (#395) is its tenant's: show only those.
      const { status, connected } = hub.observed(spec, tenantOf(auth));
      const health: McpServerStatus["health"] = !spec.enabled
        ? "disabled"
        : status?.error
          ? "error"
          : connected
            ? "connected"
            : "idle";
      return {
        name: spec.name,
        transport: spec.transport.kind,
        trust: spec.trust,
        scope: spec.scope,
        backends: spec.backends ?? null,
        enabled: spec.enabled,
        builtin: spec.builtin,
        health,
        toolCount: status?.tools.length ?? 0,
        tools: status?.tools ?? [],
        // A transport error can quote the server's URL, token and all.
        ...(status?.error ? { error: cleanMcpError(status.error) } : {}),
        ...(isOAuthServer(spec) ? { oauth: this.#oauthStatus(spec, auth) } : {}),
      };
    });
  }

  #oauthStatus(spec: McpServerSpec, auth: AuthContext): NonNullable<McpServerStatus["oauth"]> {
    return {
      status: this.#mcpOAuth?.status(spec, tenantOf(auth)) ?? "disconnected",
      unsupportedBackends: OAUTH_UNSUPPORTED_BACKENDS.filter(
        (b) => spec.backends === undefined || spec.backends.includes(b),
      ),
    };
  }

  /** Serve the current effective settings (never secret values). `settings:read`. */
  #settingsGet(
    msg: Extract<ClientMessage, { type: "settings.get" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_READ)) {
      return this.#settingsForbidden(msg.id);
    }
    try {
      return {
        type: "settings.get.result",
        requestId: msg.id,
        snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses(auth) },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  /** Persist a batch of setting changes to config.json / .env. `settings:write`. */
  #settingsSet(
    msg: Extract<ClientMessage, { type: "settings.set" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: settings:write",
        code: "forbidden",
      };
    }
    try {
      // A config the next boot rejects — one that no longer loads, or whose
      // default backend can't be built — takes the daemon down, and with the
      // web UI down recovery needs a shell. So every write is checked against
      // the config the NEXT boot would load (not the live registry, which
      // would pass "default pi + disable pi" and refuse "enable codex +
      // default codex"). See #nextBootProblem.
      const bootProblem = this.#nextBootProblem(msg.patches);
      if (bootProblem) {
        this.#store.audit(
          auth.sub,
          "settings.set",
          "",
          `keys=${msg.patches.map((p) => p.key).join(",")} ok=false reason=next-boot`,
        );
        return {
          type: "settings.set.result",
          requestId: msg.id,
          ok: false,
          snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses(auth) },
          errors: [bootProblem],
          restartRequired: false,
        };
      }
      const result = applyPatches(msg.patches);
      this.#store.audit(
        auth.sub,
        "settings.set",
        "",
        `keys=${msg.patches.map((p) => p.key).join(",")} ok=${result.ok}`,
      );
      return {
        type: "settings.set.result",
        requestId: msg.id,
        ok: result.ok,
        snapshot: { ...result.snapshot, mcpServers: this.#mcpServerStatuses(auth) },
        errors: result.errors,
        restartRequired: result.restartRequired,
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "internal",
      };
    }
  }

  /**
   * The backend a resumed session comes back on. Never the registry default:
   * with session.defaultProvider set, that would silently move an existing
   * session onto a backend it never ran on (losing its backing conversation,
   * and possibly landing on a weaker approval gate).
   *
   * - absent → claude: the meta predates providers, so it IS a claude session.
   * - no longer registered (key removed, backend disabled, a newer codeoid's
   *   id) → claude, loudly — the same backend it fell back to before the
   *   default was configurable.
   */
  #resumeProviderId(persisted: string | undefined, sessionId: string): string {
    if (persisted === undefined) return CLAUDE_PROVIDER_ID;
    // A removed endpoint stays resolvable: the session resumes on it and
    // refuses to run, telling the user why, instead of quietly moving to Claude.
    if (this.#providers.resolvable(persisted)) return persisted;
    console.warn(
      `[codeoid/resume] session ${sessionId} ran on "${persisted}", which is not available now — resuming it on ${CLAUDE_PROVIDER_ID}`,
    );
    return CLAUDE_PROVIDER_ID;
  }

  /**
   * Why the config these patches leave behind would stop the next boot, or
   * undefined. Two ways it can: the config no longer loads (every batch is
   * checked — a value can be valid alone and fail against an env override,
   * like a timeout saved here against a stall timeout set in .env), or its
   * default backend can't be built (typo, disabled, binary or API key gone).
   *
   * Refuses only what the batch is responsible for. A default the batch SETS
   * is always checked, on its own as well as in the merged config — the
   * operator is choosing it, and an env override masking a typo today would
   * stop a later boot once the override goes. Anything else is refused only
   * if the config boots now and wouldn't after the batch: when it is already
   * broken (the default's binary vanished after an upgrade, say), an
   * unrelated save must still go through, or the one screen that could
   * repair things refuses every edit and blames the wrong key.
   *
   * A batch that can't be previewed (unknown key, unreadable config.json) or
   * whose config.json the schema rejects is left to `applyPatches`, which
   * rejects it with its own, per-field errors.
   */
  #nextBootProblem(patches: SettingPatch[]): { key: string; message: string } | undefined {
    if (patches.length === 0) return undefined;
    const after = previewPatches(patches);
    if (!after || !validateConfigObject(after.raw).ok) return undefined;

    const setsDefault = patches.find(
      (p) => p.key === "session.defaultProvider" && typeof p.value === "string" && p.value.trim() !== "",
    );
    if (setsDefault) {
      // The chosen value itself, with no env override in front of it: that
      // covers a bad value and a clash within the batch. A problem only the
      // override has (its backend gone) isn't this batch's doing, so it goes
      // through the before/after rule below like anything else.
      const { [DEFAULT_PROVIDER_ENV]: _masked, ...unmasked } = after.env;
      const problem = this.#bootProblem({ raw: after.raw, env: unmasked });
      if (problem?.kind === "provider") return { key: setsDefault.key, message: problem.message };
    }

    const problem = this.#bootProblem(after);
    if (!problem) return undefined;
    let brokenAlready: boolean;
    try {
      const before = previewPatches([]);
      brokenAlready = !before || this.#bootProblem(before) !== undefined;
    } catch {
      // Can't tell whether the current config boots: don't let that block
      // every save — treat it as already broken and let the batch through.
      brokenAlready = true;
    }
    if (brokenAlready) return undefined;
    return { key: this.#culpritKey(patches), message: problem.message };
  }

  /**
   * Which key a refused batch is shown under. The web drawer renders an error
   * only beside the field whose key matches — and sends edits from every tab
   * in one batch — so blaming the wrong field hides the error entirely. The
   * culprit is the patch whose removal makes the next boot work; with none
   * (or several needed together), `""`, which the drawer shows in its save bar.
   */
  #culpritKey(patches: SettingPatch[]): string {
    if (patches.length === 1) return patches[0]!.key;
    for (const p of patches) {
      const without = previewPatches(patches.filter((q) => q !== p));
      try {
        if (without && !this.#bootProblem(without)) return p.key;
      } catch {
        // Unknown for this patch — try the next.
      }
    }
    return "";
  }

  /** Why a previewed config.json + env would fail the boot, or undefined. */
  #bootProblem(next: {
    raw: Record<string, unknown>;
    env: Record<string, string | undefined>;
  }): { kind: "load" | "provider"; message: string } | undefined {
    let config: CodeoidConfig;
    try {
      config = loadConfig({ raw: next.raw, env: next.env, quiet: true });
    } catch (err) {
      // Redacted: it's returned to the caller, and a secret pasted into the
      // wrong numeric env var would otherwise come back in "got \"…\"".
      return { kind: "load", message: redact(err instanceof Error ? err.message : String(err)) };
    }
    const id = config.session.defaultProvider;
    if (!id || id === CLAUDE_PROVIDER_ID) return undefined;
    try {
      createDefaultProviderRegistry(config, next.env, { store: this.#endpoints, catalog: this.#endpointCatalog });
      return undefined;
    } catch (err) {
      if (err instanceof DefaultProviderError) return { kind: "provider", message: err.message };
      throw err;
    }
  }

  #settingsForbidden(requestId: string): DaemonMessage {
    return {
      type: "response.error",
      requestId,
      error: "Missing scope: settings:read",
      code: "forbidden",
    };
  }

  // ── Interactive backend sign-in ─────────────────────────────────────────────
  //
  // Gated on `settings:write`, not a scope of its own. A completed login writes
  // a credential to the same `.env` a caller with that scope can already write
  // by hand — a separate scope would imply a privilege boundary that does not
  // exist, and inventing one costs a token migration across every issuer.

  /** Start a backend's login command and return the URL the user must open. */
  async #backendLoginStart(
    msg: Extract<ClientMessage, { type: "backend.login.start" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) {
      return this.#loginForbidden(msg.id);
    }
    if (msg.account !== undefined && auth.delegationDepth > 0) {
      return { type: "response.error", requestId: msg.id, error: "A delegated token can't sign accounts in.", code: "forbidden" };
    }
    try {
      // A login for a NAMED account runs isolated (its own staging home) and
      // its credential is stored as that account — it must never replace the
      // machine's own login. An existing account is replaced only explicitly.
      if (msg.account !== undefined) {
        validateAccountName(msg.account);
        if (this.#accounts.get(msg.backend, msg.account) && !msg.replace) {
          throw new AccountError(`a ${msg.backend} account named "${msg.account}" already exists — replace it explicitly, or pick another name`);
        }
      }
      const login = await this.#backendLogin.start(msg.backend, { isolated: msg.account !== undefined });
      // A new attempt supersedes any other for this backend: forget theirs.
      for (const id of [...this.#accountLogins.keys()]) if (!this.#backendLogin.isOpen(id)) this.#accountLogins.delete(id);
      if (msg.account !== undefined) {
        this.#accountLogins.set(login.loginId, { backend: msg.backend, name: msg.account, replace: msg.replace === true });
      }
      this.#store.audit(
        auth.sub,
        "backend.login.start",
        "",
        `backend=${msg.backend}${msg.account !== undefined ? ` account=${msg.account}` : ""}`,
      );
      return { type: "backend.login.start.result", requestId: msg.id, login };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        // The message is authored by the broker for display; redact anyway
        // rather than depend on every future flow's error being clean.
        error: redact(err instanceof Error ? err.message : String(err)),
        code: err instanceof BackendLoginError || err instanceof ClaudeAccountError || err instanceof AccountError ? "invalid_request" : "internal",
      };
    }
  }

  /**
   * Hand the vendor's code to the waiting command, then store whatever
   * credential it produced through the ordinary settings path — so the secret
   * lands in the same 0600 `.env`, shows up as set in the same snapshot, and is
   * cleared by the same control as one that was typed.
   */
  async #backendLoginSubmit(
    msg: Extract<ClientMessage, { type: "backend.login.submit" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) {
      return this.#loginForbidden(msg.id);
    }
    try {
      const outcome = await this.#backendLogin.submit(msg.loginId, msg.code);
      const pending = this.#accountLogins.get(msg.loginId);
      // Forget the mapping only once the attempt is over: a code refused before
      // it reached the command (malformed) leaves the attempt open, and a
      // retry must still be stored as the named account.
      if (!this.#backendLogin.isOpen(msg.loginId)) this.#accountLogins.delete(msg.loginId);
      const error = this.#storeLoginOutcome(outcome, pending);
      const ok = outcome.ok && error === undefined;
      // Never the code, never the credential — only that an exchange happened.
      this.#store.audit(auth.sub, "backend.login.submit", "", `ok=${ok}${pending ? ` backend=${pending.backend} account=${pending.name}` : ""}`);
      return {
        type: "backend.login.submit.result",
        requestId: msg.id,
        ok,
        ...(error === undefined ? {} : { error }),
        ...(!ok && this.#backendLogin.isOpen(msg.loginId) ? { retryable: true } : {}),
        snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses(auth) },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: redact(err instanceof Error ? err.message : String(err)),
        code: "internal",
      };
    }
  }

  /** Abandon an in-flight attempt. Idempotent — an unknown id is `ok: false`. */
  #backendLoginCancel(
    msg: Extract<ClientMessage, { type: "backend.login.cancel" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) {
      return this.#loginForbidden(msg.id);
    }
    this.#accountLogins.delete(msg.loginId);
    return {
      type: "backend.login.cancel.result",
      requestId: msg.id,
      ok: this.#backendLogin.cancel(msg.loginId),
    };
  }

  /**
   * Keep what a finished sign-in produced: as the named account it was for,
   * or — for the daemon's own Claude login only — in `~/.codeoid/.env`.
   * Returns the error to report, if any.
   */
  #storeLoginOutcome(
    outcome: LoginOutcome,
    pending: { backend: string; name: string; replace: boolean } | undefined,
  ): string | undefined {
    if (outcome.isolated && pending === undefined) {
      // A named-account login whose name we no longer know. Its credential
      // must never become the daemon's own login: drop it.
      return outcome.ok ? "Signed in, but the account this sign-in was for is no longer known. Start again." : outcome.error;
    }
    if (!outcome.ok) return outcome.error;
    if (pending !== undefined) {
      try {
        if (pending.backend === "claude") {
          // A named Claude account keeps ONLY the token the command printed:
          // it ran against a throwaway config dir, so there is no on-disk fallback.
          if (outcome.secret?.key !== "CLAUDE_CODE_OAUTH_TOKEN") return "Signed in, but claude setup-token didn't print a token to store for this account.";
          // Added meanwhile by someone else: replace it only if this sign-in said so.
          if (!pending.replace && this.#accounts.get("claude", pending.name)) {
            return `Signed in, but a claude account named "${pending.name}" was added meanwhile — sign in again to replace it`;
          }
          this.#claudeAccounts.upsert({ name: pending.name, kind: "subscription", token: outcome.secret.value });
        } else {
          if (!outcome.files || Object.keys(outcome.files).length === 0) return `Signed in, but the ${pending.backend} sign-in left no credential to keep.`;
          const kind: AccountKind = "chatgpt-login";
          this.#accounts.upsert({ backend: pending.backend, name: pending.name, kind, replace: pending.replace });
          this.#writeAccountFiles(pending.backend, pending.name, outcome.files);
        }
      } catch (err) {
        return `Signed in, but the account could not be saved: ${err instanceof Error ? err.message : String(err)}`;
      }
      return undefined;
    }
    if (outcome.secret) {
      const written = applyPatches([{ key: outcome.secret.key, value: outcome.secret.value }]);
      // Signed in with the vendor but could not persist it: report the
      // failure rather than a success the next session will not honour.
      if (!written.ok) return `Signed in, but the credential could not be saved: ${written.errors[0]?.message ?? "unknown error"}`;
    }
    return undefined;
  }

  /**
   * Put a sign-in's credential files into the account's home (0700 dir, 0600
   * files), replacing what was there — the vendor's own format, never parsed.
   */
  #writeAccountFiles(backend: string, name: string, files: Record<string, string>): void {
    const home = this.#accounts.homeOf(backend, name);
    // A file layout the CLI wrote under the staging home, mirrored here; a
    // path that climbs out (it can't, the flows name fixed files) is refused.
    for (const [rel, content] of Object.entries(files)) {
      const target = join(home, rel);
      if (!target.startsWith(`${home}/`)) throw new AccountError("a sign-in named a file outside its home");
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      atomicWrite(target, content, 0o600);
    }
  }

  /** Finish a `device` sign-in (Codex): wait for the user to approve on the vendor's page. */
  async #backendLoginWait(
    msg: Extract<ClientMessage, { type: "backend.login.wait" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) return this.#loginForbidden(msg.id);
    try {
      let waiting = this.#loginWaits.get(msg.loginId);
      if (!waiting) {
        waiting = (async () => {
          const outcome = await this.#backendLogin.wait(msg.loginId);
          // Still open = this wasn't a device login (a code login answered
          // "paste it instead"): its account mapping and outcome stay for submit.
          if (this.#backendLogin.isOpen(msg.loginId)) {
            this.#loginWaits.delete(msg.loginId);
            return { ok: false, ...(outcome.error ? { error: outcome.error } : {}) };
          }
          const pending = this.#accountLogins.get(msg.loginId);
          this.#accountLogins.delete(msg.loginId);
          const error = this.#storeLoginOutcome(outcome, pending);
          this.#store.audit(auth.sub, "backend.login.wait", "", `ok=${outcome.ok && error === undefined}${pending ? ` backend=${pending.backend} account=${pending.name}` : ""}`);
          return { ok: outcome.ok && error === undefined, ...(error === undefined ? {} : { error }) };
        })();
        this.#loginWaits.set(msg.loginId, waiting);
        // Remembered for as long as a client could plausibly come back for it.
        const forget = () => setTimeout(() => this.#loginWaits.delete(msg.loginId), LOGIN_OUTCOME_TTL_MS).unref?.();
        waiting.then(forget, forget);
      }
      const result = await waiting;
      return {
        type: "backend.login.wait.result",
        requestId: msg.id,
        ok: result.ok,
        ...(result.error === undefined ? {} : { error: result.error }),
        snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses(auth) },
      };
    } catch (err) {
      return { type: "response.error", requestId: msg.id, error: redact(err instanceof Error ? err.message : String(err)), code: "internal" };
    }
  }

  // ── Accounts for every backend (accounts.ts) ─────────────────────────────

  /**
   * Account changes need `settings:write` from an undelegated token: they
   * decide whose credential an agent runs on, who is billed, and who is sent
   * the conversation.
   */
  #accountsWriteRefusal(requestId: string, auth: AuthContext): DaemonMessage | undefined {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) return this.#loginForbidden(requestId);
    if (auth.delegationDepth > 0) {
      return { type: "response.error", requestId, error: "A delegated token can't change accounts.", code: "forbidden" };
    }
    return undefined;
  }

  #accountsError(requestId: string, err: unknown): DaemonMessage {
    return {
      type: "response.error",
      requestId,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof AccountError || err instanceof ClaudeAccountError ? "invalid_request" : "internal",
    };
  }

  /** The backends to list: one, or every registered backend that takes accounts plus any holding accounts. */
  #accountBackends(only?: string): string[] {
    if (only !== undefined) return [only];
    const ids = new Set(this.#providers.ids().filter(backendHasAccounts));
    for (const b of this.#accounts.backendsWithData()) if (backendHasAccounts(b)) ids.add(b);
    return [...ids];
  }

  #accountsResult(requestId: string, only?: string): DaemonMessage {
    const names = new Map(this.providerInfo().map((p) => [p.id, p.displayName]));
    return {
      type: "accounts.result",
      requestId,
      backends: this.#accountBackends(only).map((b) => this.#accounts.summary(b, names.get(b) ?? b)),
    };
  }

  /** Names, kinds, URLs, header/key names — never a secret. `settings:read`. */
  #accountsList(msg: Extract<ClientMessage, { type: "accounts.list" }>, auth: AuthContext): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_READ)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: settings:read", code: "forbidden" };
    }
    if (msg.backend !== undefined && !backendHasAccounts(msg.backend)) {
      return { type: "response.error", requestId: msg.id, error: `the ${msg.backend} backend has no accounts`, code: "invalid_request" };
    }
    try {
      return this.#accountsResult(msg.id, msg.backend);
    } catch (err) {
      return this.#accountsError(msg.id, err);
    }
  }

  #accountsSet(msg: Extract<ClientMessage, { type: "accounts.set" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    try {
      if (LOGIN_KINDS.has(msg.kind)) throw new AccountError(`a ${msg.kind} account is created by signing in (backend.login.start with the account's name)`);
      if (msg.backend === "claude") {
        // Claude's own validation (gateway URL rules) on top of the store's.
        if (this.#accounts.get("claude", msg.name) && !msg.replace) {
          throw new AccountError(`a claude account named "${msg.name}" already exists — replace it explicitly, or pick another name`);
        }
        this.#claudeAccounts.upsert({
          name: msg.name,
          kind: msg.kind as ClaudeAccountKind,
          token: msg.token ?? "",
          ...(msg.baseUrl !== undefined ? { baseUrl: msg.baseUrl } : {}),
          ...(msg.headers !== undefined ? { headers: msg.headers } : {}),
          ...(msg.env !== undefined ? { env: msg.env } : {}),
        });
      } else {
        // An endpoint account is bound to the server the endpoint has now.
        let origin: string | undefined;
        const endpoint = endpointNameOf(msg.backend);
        if (endpoint !== null) {
          const e = this.#endpoints.get(endpoint);
          if (!e) throw new AccountError(`no endpoint named "${endpoint}"`);
          origin = new URL(e.baseUrl).origin;
        }
        this.#accounts.upsert({
          backend: msg.backend,
          name: msg.name,
          kind: msg.kind,
          ...(msg.token !== undefined ? { token: msg.token } : {}),
          ...(msg.baseUrl !== undefined ? { baseUrl: msg.baseUrl } : {}),
          ...(msg.headers !== undefined ? { headers: msg.headers } : {}),
          ...(msg.env !== undefined ? { env: msg.env } : {}),
          ...(origin ? { origin } : {}),
          ...(msg.replace ? { replace: true } : {}),
        });
      }
    } catch (err) {
      return this.#accountsError(msg.id, err);
    }
    // Never a secret — only what was set.
    this.#store.audit(auth.sub, "accounts.set", "", `backend=${msg.backend} name=${msg.name} kind=${msg.kind}${msg.replace ? " replace" : ""}`);
    return this.#accountsResult(msg.id);
  }

  #accountsRemove(msg: Extract<ClientMessage, { type: "accounts.remove" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    let removed: boolean;
    try {
      removed = this.#accounts.remove(msg.backend, msg.name);
    } catch (err) {
      return this.#accountsError(msg.id, err);
    }
    if (!removed) {
      return { type: "response.error", requestId: msg.id, error: `no ${msg.backend} account named "${msg.name}"`, code: "not_found" };
    }
    this.#store.audit(auth.sub, "accounts.remove", "", `backend=${msg.backend} name=${msg.name}`);
    return this.#accountsResult(msg.id);
  }

  #accountsSetDefault(msg: Extract<ClientMessage, { type: "accounts.set_default" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    if (!backendHasAccounts(msg.backend)) {
      return { type: "response.error", requestId: msg.id, error: `the ${msg.backend} backend has no accounts`, code: "invalid_request" };
    }
    try {
      this.#accounts.setDefault(msg.backend, msg.name);
    } catch (err) {
      return this.#accountsError(msg.id, err);
    }
    this.#store.audit(auth.sub, "accounts.set_default", "", `backend=${msg.backend} name=${msg.name}`);
    return this.#accountsResult(msg.id);
  }

  /** Choose a session's account for a backend (default: its current one). `settings:write`, undelegated. */
  #sessionSetAccount(msg: Extract<ClientMessage, { type: "session.set_account" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    try {
      session.setAccount(msg.account, auth, msg.backend);
    } catch (err) {
      return this.#accountsError(msg.id, err);
    }
    return { type: "response.ok", requestId: msg.id, data: session.toInfo() };
  }

  /**
   * Re-check every session on `backend` after its accounts changed — by any
   * handler, a sign-in, or a hand edit of accounts.json (the store's change
   * listener calls this). A session whose credential changed is released when
   * idle; every one re-announces its effective account.
   */
  #refreshSessionsOn(backend: string): void {
    for (const session of this.#sessions.values()) {
      if (session.providerId === backend) session.refreshAccount();
    }
  }

  // ── Claude accounts (claude-accounts.ts) ─────────────────────────────────

  #claudeAccountsResult(requestId: string): DaemonMessage {
    return {
      type: "claude.accounts.result",
      requestId,
      // Not Bedrock: this message predates the kind, and its clients look a
      // kind's label up without a fallback. `accounts.list` carries every kind.
      accounts: this.#claudeAccounts.list().filter((a) => a.kind !== "bedrock"),
      defaultAccount: this.#claudeAccounts.getDefault(),
    };
  }

  #claudeAccountsError(requestId: string, err: unknown): DaemonMessage {
    return this.#accountsError(requestId, err);
  }

  /** Names, kinds and gateway URLs — never a token. `settings:read`. */
  #claudeAccountsList(msg: Extract<ClientMessage, { type: "claude.accounts.list" }>, auth: AuthContext): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_READ)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: settings:read", code: "forbidden" };
    }
    return this.#claudeAccountsResult(msg.id);
  }

  /** Add or replace an account. `settings:write` — it decides what sessions bill. */
  #claudeAccountsSet(msg: Extract<ClientMessage, { type: "claude.accounts.set" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    try {
      this.#claudeAccounts.upsert({
        name: msg.name,
        kind: msg.kind,
        token: msg.token,
        ...(msg.baseUrl !== undefined ? { baseUrl: msg.baseUrl } : {}),
        ...(msg.headers !== undefined ? { headers: msg.headers } : {}),
      });
    } catch (err) {
      return this.#claudeAccountsError(msg.id, err);
    }
    // Never the token — only that an account was set and what kind.
    this.#store.audit(auth.sub, "claude.accounts.set", "", `name=${msg.name} kind=${msg.kind}`);
    return this.#claudeAccountsResult(msg.id);
  }

  #claudeAccountsRemove(msg: Extract<ClientMessage, { type: "claude.accounts.remove" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    let removed: boolean;
    try {
      removed = this.#claudeAccounts.remove(msg.name);
    } catch (err) {
      return this.#claudeAccountsError(msg.id, err);
    }
    if (!removed) {
      return { type: "response.error", requestId: msg.id, error: `no Claude account named "${msg.name}"`, code: "not_found" };
    }
    this.#store.audit(auth.sub, "claude.accounts.remove", "", `name=${msg.name}`);
    return this.#claudeAccountsResult(msg.id);
  }

  #claudeAccountsSetDefault(
    msg: Extract<ClientMessage, { type: "claude.accounts.set_default" }>,
    auth: AuthContext,
  ): DaemonMessage {
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    try {
      this.#claudeAccounts.setDefault(msg.name);
    } catch (err) {
      return this.#claudeAccountsError(msg.id, err);
    }
    this.#store.audit(auth.sub, "claude.accounts.set_default", "", `name=${msg.name}`);
    return this.#claudeAccountsResult(msg.id);
  }

  /**
   * Choose a session's Claude account: null follows the daemon default, a
   * literal `default` pins the built-in account. `settings:write`, every
   * case — it picks whose credential the agent runs on and bills, and where
   * the conversation is sent (a switch resumes it on the new account). Moving
   * a session OFF a company account onto a personal login is as much that
   * decision as moving it on.
   */
  #sessionSetClaudeAccount(
    msg: Extract<ClientMessage, { type: "session.set_claude_account" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: settings:write (needed to choose a session's Claude account)",
        code: "forbidden",
      };
    }
    const refused = this.#accountsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    try {
      session.setClaudeAccount(msg.account, auth);
    } catch (err) {
      return this.#claudeAccountsError(msg.id, err);
    }
    return { type: "response.ok", requestId: msg.id, data: session.toInfo() };
  }

  // ── Providers + OpenAI-compatible endpoints (openai-endpoints.ts) ────────

  /** The backend list, and a subscription to `providers.changed`. No scope beyond the connection. */
  #providersList(msg: Extract<ClientMessage, { type: "providers.list" }>, client: AttachedClient): DaemonMessage {
    this.#providerSubscribers.set(client.id, client);
    return { type: "providers.result", requestId: msg.id, providers: this.providerInfo() };
  }

  #pushProviders(): void {
    this.#pushToProviderSubscribers({ type: "providers.changed", providers: this.providerInfo() });
  }

  /** Send to every client subscribed to the backend list (providers.list). */
  #pushToProviderSubscribers(msg: DaemonMessage): void {
    for (const [id, client] of this.#providerSubscribers) {
      try {
        client.send(msg);
      } catch {
        this.#providerSubscribers.delete(id);
      }
    }
  }

  #endpointsResult(requestId: string): DaemonMessage {
    return { type: "endpoints.result", requestId, endpoints: this.#endpoints.list() };
  }

  #endpointsError(requestId: string, err: unknown): DaemonMessage {
    return {
      type: "response.error",
      requestId,
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof EndpointError ? "invalid_request" : "internal",
    };
  }

  /** Names, URLs, models — never a key or header value. `settings:read`. */
  #endpointsList(msg: Extract<ClientMessage, { type: "endpoints.list" }>, auth: AuthContext): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_READ)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: settings:read", code: "forbidden" };
    }
    try {
      return this.#endpointsResult(msg.id);
    } catch (err) {
      return this.#endpointsError(msg.id, err);
    }
  }

  /**
   * Endpoint changes and tests need `settings:write` from an undelegated
   * token: they decide where sessions send their code, and a test sends the
   * stored key — a shared token must not do either.
   */
  #endpointsWriteRefusal(requestId: string, auth: AuthContext): DaemonMessage | undefined {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) return this.#loginForbidden(requestId);
    if (auth.delegationDepth > 0) {
      return { type: "response.error", requestId, error: "A delegated token can't change or test endpoints.", code: "forbidden" };
    }
    return undefined;
  }

  /**
   * session.defaultProvider as the next start would read it (config file +
   * env). It only takes effect on restart, so it can name an endpoint the
   * live default doesn't. Undefined when the config can't be read.
   */
  #configuredDefaultProvider(): string | undefined {
    try {
      return loadConfig({ quiet: true }).session.defaultProvider || undefined;
    } catch {
      return undefined;
    }
  }

  /** Add or replace an endpoint. `settings:write` — it decides where sessions send their code. */
  #endpointsSet(msg: Extract<ClientMessage, { type: "endpoints.set" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#endpointsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    const existed = this.#endpoints.has(msg.name);
    try {
      const { type: _t, id: _i, ...input } = msg;
      this.#endpoints.upsert(input);
    } catch (err) {
      return this.#endpointsError(msg.id, err);
    }
    // Never the key or header values — only what changed.
    this.#store.audit(
      auth.sub,
      existed ? "endpoints.update" : "endpoints.add",
      "",
      `name=${msg.name} baseUrl=${this.#endpoints.get(msg.name)?.baseUrl ?? ""}`,
    );
    return this.#endpointsResult(msg.id);
  }

  #endpointsRemove(msg: Extract<ClientMessage, { type: "endpoints.remove" }>, auth: AuthContext): DaemonMessage {
    const refused = this.#endpointsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    // The live default, and the configured one a restart would boot with —
    // removing that would stop the daemon from starting.
    const id = endpointProviderId(msg.name);
    if (id === this.#providers.defaultId || id === this.#configuredDefaultProvider()) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `"${msg.name}" is the daemon's default backend — change session.defaultProvider first`,
        code: "invalid_request",
      };
    }
    let removed: boolean;
    try {
      removed = this.#endpoints.remove(msg.name);
    } catch (err) {
      return this.#endpointsError(msg.id, err);
    }
    if (!removed) {
      return { type: "response.error", requestId: msg.id, error: `no endpoint named "${msg.name}"`, code: "not_found" };
    }
    this.#store.audit(auth.sub, "endpoints.remove", "", `name=${msg.name}`);
    // Its accounts go with it: their keys were only ever for that server, and a
    // later endpoint of the same name must not inherit them.
    try {
      this.#accounts.removeBackend(endpointProviderId(msg.name));
    } catch (err) {
      console.error(`[codeoid] couldn't remove the accounts of endpoint ${msg.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.#endpointsResult(msg.id);
  }

  /**
   * List an endpoint's models — a stored one, or a draft (falling back to the
   * stored key / headers). `settings:write`: the daemon makes the request,
   * possibly with a stored credential, to a URL the caller chose.
   */
  async #endpointsTest(msg: Extract<ClientMessage, { type: "endpoints.test" }>, auth: AuthContext): Promise<DaemonMessage> {
    const refused = this.#endpointsWriteRefusal(msg.id, auth);
    if (refused) return refused;
    const fail = (error: string): DaemonMessage => ({ type: "endpoints.test.result", requestId: msg.id, ok: false, error });
    let existing: ReturnType<EndpointStore["get"]>;
    try {
      existing = msg.name ? this.#endpoints.get(msg.name) : undefined;
    } catch (err) {
      return this.#endpointsError(msg.id, err);
    }
    if (msg.name && !existing && msg.baseUrl === undefined) return fail(`no endpoint named "${msg.name}"`);
    let conn: ReturnType<typeof draftConnection>;
    try {
      conn = draftConnection(
        {
          ...(msg.baseUrl !== undefined ? { baseUrl: msg.baseUrl } : {}),
          ...(msg.apiKey !== undefined ? { apiKey: msg.apiKey } : {}),
          ...(msg.headers !== undefined ? { headers: msg.headers } : {}),
        },
        existing,
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const started = Date.now();
    try {
      const models = await fetchEndpointModels(conn, this.#endpointFetch);
      const flavor = msg.flavor ?? existing?.flavor ?? "openai";
      const contextWindow =
        flavor === "llamacpp" ? await fetchLlamaCppContext(conn, this.#endpointFetch).catch(() => undefined) : undefined;
      return {
        type: "endpoints.test.result",
        requestId: msg.id,
        ok: true,
        models,
        latencyMs: Date.now() - started,
        ...(contextWindow ? { contextWindow } : {}),
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Pre-approve (or deny) a command a skill declares, for a workspace — the
   * `--allowedTools` of an unattended run, which never prompts (#348). The
   * same record the approval dialog writes. `settings:write`: the command then
   * runs unasked in every later session on that workdir.
   */
  #skillGrant(msg: Extract<ClientMessage, { type: "skill.grant" }>, auth: AuthContext): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) return this.#loginForbidden(msg.id);
    const workdir = normalizeWorkdir(msg.workdir);
    if (!workdir) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `"${msg.workdir}" is not a usable workdir`,
        code: "invalid_request",
      };
    }
    const command = msg.command.trim();
    this.#store.setSkillCommandGrant(workspaceIdFromPath(workdir, auth), `Bash(${command})`, msg.allowed);
    this.#store.audit(auth.sub, msg.allowed ? "skill.grant" : "skill.deny", "", `workdir=${workdir} command=${redactCommand(command)}`);
    return { type: "skill.grant.result", requestId: msg.id, workdir, command, allowed: msg.allowed };
  }

  #loginForbidden(requestId: string): DaemonMessage {
    return {
      type: "response.error",
      requestId,
      error: "Missing scope: settings:write",
      code: "forbidden",
    };
  }

  // ── Remote MCP server sign-in (docs/mcp-oauth-design.md §4) ─────────────────
  //
  // `settings:write`, like backend sign-in: connecting an account configures
  // the tenant. The credential is the tenant's — never returned, never logged.

  /** The OAuth server a request names, or an error reply to send instead. */
  #oauthTarget(
    requestId: string,
    server: string,
    auth: AuthContext,
  ): { spec: McpServerSpec; oauth: McpOAuth } | DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) return this.#loginForbidden(requestId);
    const spec = this.#mcpRegistry?.get(server);
    if (!spec || !isOAuthServer(spec) || !this.#mcpOAuth) {
      return {
        type: "response.error",
        requestId,
        error: `"${server}" is not an OAuth MCP server`,
        code: "invalid_request",
      };
    }
    return { spec, oauth: this.#mcpOAuth };
  }

  async #mcpOAuthBegin(
    msg: Extract<ClientMessage, { type: "mcp.oauth.begin" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const target = this.#oauthTarget(msg.id, msg.server, auth);
    if ("type" in target) return target;
    try {
      const begun = await target.oauth.begin(target.spec, tenantOf(auth));
      this.#store.audit(auth.sub, "mcp.oauth.begin", "", `server=${msg.server} status=${begun.status}`);
      if (begun.status === "connected") return { type: "mcp.oauth.begin.result", requestId: msg.id, status: "connected" };
      return {
        type: "mcp.oauth.begin.result",
        requestId: msg.id,
        status: "redirect",
        url: begun.url,
        // The browser that started the sign-in is the one that may finish it
        // on the callback route (see McpOAuth.complete).
        browserBinding: { cookie: mcpOAuthBindingCookieName(begun.state), value: begun.binding },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: redact(err instanceof Error ? err.message : String(err)),
        code: "internal",
      };
    }
  }

  async #mcpOAuthComplete(
    msg: Extract<ClientMessage, { type: "mcp.oauth.complete" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) return this.#loginForbidden(msg.id);
    try {
      // A pasted URL is honoured only for the tenant that began the sign-in.
      const done = await this.completeMcpOAuth({ callbackUrl: msg.callbackUrl }, { tenant: tenantOf(auth) });
      this.#store.audit(auth.sub, "mcp.oauth.complete", "", `server=${done.server}`);
      return {
        type: "mcp.oauth.complete.result",
        requestId: msg.id,
        server: done.server,
        snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses(auth) },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: redact(err instanceof Error ? err.message : String(err)),
        code: "invalid_request",
      };
    }
  }

  #mcpOAuthDisconnect(
    msg: Extract<ClientMessage, { type: "mcp.oauth.disconnect" }>,
    auth: AuthContext,
  ): DaemonMessage {
    const target = this.#oauthTarget(msg.id, msg.server, auth);
    if ("type" in target) return target;
    const tenant = tenantOf(auth);
    target.oauth.disconnect(target.spec, tenant);
    this.#mcpHub?.dropTenant(msg.server, tenant);
    this.#mcpHub?.proxy?.credentialsChanged(msg.server, tenant);
    this.#store.audit(auth.sub, "mcp.oauth.disconnect", "", `server=${msg.server}`);
    return {
      type: "mcp.oauth.disconnect.result",
      requestId: msg.id,
      snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses(auth) },
    };
  }

  /** The origins this daemon's own HTTP endpoints are reached at. */
  #daemonOrigins(): string[] {
    return [this.#blackboardUrl, this.#config?.daemonUrl, this.#config?.mcpOAuth?.redirectBaseUrl].filter((u): u is string => Boolean(u));
  }

  /**
   * Whether the drawer offers "Sign in with codeoid" for a row: only to a
   * caller adopt would accept, only for what adopt would take, and only when
   * the backend reports `needs-auth` (a sign-in the CLI can't run). A server
   * that's merely down, or not yet reported, isn't offered.
   */
  #offerAdoption(
    s: ClaudeConfigMcpServer,
    all: readonly ClaudeConfigMcpServer[],
    liveStatus: string | undefined,
    auth: AuthContext,
  ): "drawer" | "full-url" | null {
    // Only to someone adopt would accept, and only what adopt would take.
    if (!this.#mcpOAuth || !this.#mcpRegistry || s.liveOnly) return null;
    // A sign-in that the CLI can't run — not any failure: a server that's
    // merely down would only lose its working copy everywhere.
    if (liveStatus !== "needs-auth") return null;
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE) || auth.delegationDepth > 0) return null;
    if (adoptionRefusal(s, all, this.#mcpRegistry, this.#daemonOrigins())) return null;
    // The drawer has only the URL as shown, which can't adopt a project's
    // URL with parts hidden: that one is adopted by its full URL, from the file.
    return fullUrlRequired(s) ? "full-url" : "drawer";
  }

  /**
   * Adopt a remote server from Claude's own config into codeoid's registry
   * (#390): the same URL with codeoid's OAuth sign-in, written to config.json
   * and live in the registry at once — every session, provider and the hub
   * read it from there; a Claude session rebuilds its query on its next turn
   * to mount codeoid's copy and deny the CLI's. The URL comes from Claude's
   * config, never from the client. `settings:write`, plus an owned session
   * when one is named (its workdir's servers are looked in).
   */
  async #mcpAdopt(msg: Extract<ClientMessage, { type: "mcp.adopt" }>, auth: AuthContext): Promise<DaemonMessage> {
    let workdir: string | null = null;
    let source = "";
    let url = "";
    // Every outcome is on the record, as who asked and from where.
    const audit = (outcome: string) =>
      this.#store.audit(
        auth.sub,
        "mcp.adopt",
        msg.sessionId ?? "",
        `server=${JSON.stringify(msg.server)} outcome=${outcome}${url ? ` url=${JSON.stringify(url)}` : ""}${workdir ? ` workdir=${JSON.stringify(workdir)}` : ""}${source ? ` source=${JSON.stringify(source)}` : ""}`,
      );
    const fail = (outcome: string, error: string, code: "invalid_request" | "not_found" | "forbidden" | "internal" = "invalid_request"): DaemonMessage => {
      audit(outcome);
      return { type: "response.error", requestId: msg.id, error, code };
    };
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) return fail("forbidden", "Missing scope: settings:write", "forbidden");
    // It changes the daemon-wide registry and config: the account's own, not a token handed on.
    if (auth.delegationDepth > 0) return fail("refused", "A delegated token can't adopt MCP servers.", "forbidden");
    const registry = this.#mcpRegistry;
    if (!registry || !this.#mcpOAuth) return fail("unavailable", "OAuth for MCP servers is not available on this daemon.", "internal");
    let session: Session | null = null;
    if (msg.sessionId !== undefined) {
      session = this.#getOwnedSession(msg.sessionId, auth);
      if (!session) return fail("not_found", "Session not found", "not_found");
      workdir = session.workdir;
    }
    const name = msg.server;
    const named = adoptableName(name);
    if (!named.ok) return fail("refused", named.reason);

    // Which entry: the one at the URL the caller was shown, else the only one.
    const all = await claudeMcpServers(workdir);
    const candidates = all.filter((c) => c.name === name);
    // The URL the caller was shown is the redacted one (#394); one typed from
    // their own config is the real one. Either picks the entry — but a
    // project's URL with parts hidden only by its full text, the consent.
    // ("…" alone is never a URL anyone was shown a host for.)
    const atUrl =
      msg.url !== undefined
        ? candidates.filter(
            (c) => c.url === msg.url || (c.url !== null && msg.url !== "…" && !fullUrlRequired(c) && redactMcpUrl(c.url) === msg.url),
          )
        : candidates;
    // The shown form of a project's URL with parts hidden picks nothing — and
    // says why, rather than quietly picking another entry that reads the same.
    const hiddenRepo =
      msg.url === undefined ? undefined : candidates.find((c) => fullUrlRequired(c) && c.url !== msg.url && redactMcpUrl(c.url!) === msg.url);
    if (hiddenRepo) {
      source = hiddenRepo.path;
      url = msg.url!;
      return fail(
        "unconfirmed",
        `${name} comes from this project's own files, and parts of its address are hidden here (${msg.url}); adopting it is consent to all of it, so name its full URL, from ${hiddenRepo.path}`,
      );
    }
    if (atUrl.length === 0) {
      return fail(
        "not_found",
        msg.url !== undefined
          ? `Claude's config has no MCP server ${JSON.stringify(name)} at that URL`
          : `Claude's config has no MCP server named ${JSON.stringify(name)}${workdir ? "" : " (for a project's server, name its session)"}`,
        "not_found",
      );
    }
    if (new Set(atUrl.map((c) => c.url)).size > 1) {
      const shown = atUrl.map((c) => (c.url ? redactMcpUrl(c.url) : serverProgram(c.command ?? "")));
      // Two URLs that read the same once their credentials are hidden: only
      // the full URL, from the file itself, tells them apart.
      const shownUrls = atUrl.flatMap((c) => (c.url ? [redactMcpUrl(c.url)] : []));
      const sameShown = new Set(shownUrls).size < shownUrls.length;
      return fail(
        "ambiguous",
        sameShown
          ? `${JSON.stringify(name)} names servers that differ only in parts hidden here (${[...new Set(shown)].join(", ")}); pass the full URL, from ${[...new Set(atUrl.map((c) => c.path))].join(" or ")}`
          : `${JSON.stringify(name)} names more than one server in Claude's config (${shown.join(", ")}); say which URL`,
      );
    }
    const found = atUrl[0]!;
    source = found.path;
    url = found.url ? redactMcpUrl(found.url) : "";
    const can = adoptability(found);
    if (!can.ok) return fail("refused", can.reason);
    const refusal = adoptionRefusal(found, all, registry, this.#daemonOrigins());
    if (refusal) return fail("refused", refusal);
    // A repo's file can name any address (and the CLI connects it unasked):
    // adopted only when the caller names the URL — consent to that address.
    if (fromRepoFile(found) && msg.url === undefined) {
      return fail(
        "unconfirmed",
        fullUrlRequired(found)
          ? `${name} comes from this project's own files, which chose its address; to adopt it, name its full URL, from ${found.path} (shown here as ${redactMcpUrl(can.url)})`
          : `${name} comes from this project's own files, which chose its address; to adopt it, name that URL (${redactMcpUrl(can.url)})`,
      );
    }
    const reply = (alreadyAdopted: boolean): DaemonMessage => ({
      type: "mcp.adopt.result",
      requestId: msg.id,
      server: name,
      alreadyAdopted,
      snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses(auth) },
    });
    let configured: Record<string, unknown> | undefined;
    try {
      configured = readMcpServerEntry(name);
    } catch (err) {
      return fail("error", `config.json is not valid JSON: ${redact(err instanceof Error ? err.message : String(err))}`, "internal");
    }
    if (configured) {
      if (isSameAdoption(configured, can.url)) {
        audit("already");
        return reply(true);
      }
      // A server the user configured for codeoid by hand is theirs to change.
      return fail("conflict", `codeoid's config already has a server named ${JSON.stringify(name)}; change or remove it there first`);
    }
    const { entry, raw } = adoptedEntry(can.url);
    let spec: McpServerSpec;
    try {
      const written = writeMcpServerEntry(name, entry);
      if (!written.ok) return fail("error", written.error);
      spec = registry.upsert(name, raw);
    } catch (err) {
      return fail("error", redact(err instanceof Error ? err.message : String(err)));
    }
    // Any client held for the old entry (a plain copy imported from ~/.claude.json).
    this.#mcpHub?.drop(spec.name);
    this.#mcpHub?.proxy?.serverChanged(spec.name);
    url = redactMcpUrl(new URL(can.url).href);
    audit(`adopted${fromRepoFile(found) ? " projectFile=true" : ""}`);
    return reply(false);
  }

  /**
   * Finish an MCP sign-in — from the provider's redirect to the daemon's
   * callback route (proved by the browser's binding cookie), or a pasted
   * callback URL (proved by the client's tenant). The tenant's hub client is
   * dropped so its next call connects with the new credential.
   */
  async completeMcpOAuth(
    input: { callbackUrl: string } | { state: string; code?: string; error?: string; errorDescription?: string },
    proof: McpOAuthProof,
  ): Promise<{ server: string; tenant: McpTenant }> {
    const oauth = this.#mcpOAuth;
    if (!oauth) throw new Error("OAuth for MCP servers is not available on this daemon.");
    const done = await oauth.complete(input, proof, (name) => this.#mcpRegistry?.get(name));
    this.#mcpHub?.dropTenant(done.server, done.tenant);
    this.#mcpHub?.proxy?.credentialsChanged(done.server, done.tenant);
    return done;
  }

  async #fsBrowseDir(
    msg: Extract<ClientMessage, { type: "fs.browse_dir" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    try {
      return await handleFsBrowseDir(msg);
    } catch (err) {
      return this.#fsErr(msg.id, err);
    }
  }

  // ---------- fs verbs ----------

  async #fsList(
    msg: Extract<ClientMessage, { type: "fs.list" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      return await handleFsList(msg, session.workdir);
    } catch (err) {
      return this.#fsErr(msg.id, err);
    }
  }

  async #fsRead(
    msg: Extract<ClientMessage, { type: "fs.read" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.FS_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fs:read",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    try {
      return await handleFsRead(msg, session.workdir);
    } catch (err) {
      return this.#fsErr(msg.id, err);
    }
  }

  // ---------- goal blackboard (owner-facing) ----------

  /**
   * Resolve a client-supplied session id to the collaboration goal it belongs
   * to, or an error message naming why it doesn't belong to one.
   *
   * Accepts either the orchestrator or one of its role-children. Every client
   * would otherwise have to walk `collaborationRole.parentSessionId` itself,
   * and a client that got it wrong would see an EMPTY board rather than an
   * error — the least debuggable possible outcome.
   *
   * The parent is re-fetched through `#getOwnedSession`, not trusted from the
   * child's field: the ownership check must be made against the session whose
   * artifacts are about to be read, not against the one that named it.
   */
  #resolveGoalSession(
    sessionId: string,
    auth: AuthContext,
  ): { ok: true; goal: Session } | { ok: false; error: string; code: "not_found" | "invalid_request" } {
    const session = this.#getOwnedSession(sessionId, auth);
    if (!session) return { ok: false, error: "Session not found", code: "not_found" };
    if (session.collaboration) return { ok: true, goal: session };

    const parentId = session.collaborationRole?.parentSessionId;
    if (!parentId) {
      return {
        ok: false,
        error: `Session "${session.name}" is not part of a collaboration — it has no goal blackboard`,
        code: "invalid_request",
      };
    }
    const parent = this.#getOwnedSession(parentId, auth);
    if (!parent?.collaboration) {
      // The orchestrator was destroyed but this child hasn't finished draining.
      // Teardown drops the artifacts with the goal, so there is nothing to show.
      return {
        ok: false,
        error: "The orchestrator for this role-child is gone; its blackboard was torn down with it",
        code: "not_found",
      };
    }
    return { ok: true, goal: parent };
  }

  #ownerBlackboard(goal: Session): OwnerBlackboard {
    return this.#goalBlackboard().forOwner({
      accountId: goal.accountId,
      projectId: goal.projectId,
      goalSessionId: goal.id,
    });
  }

  /**
   * The board's contents at a glance. Gated on `session:list` rather than a new
   * scope: an index is metadata about a session the holder can already
   * enumerate, it carries no bodies, and inventing a scope would 403 every
   * token minted before this shipped.
   */
  #blackboardIndex(
    msg: Extract<ClientMessage, { type: "blackboard.index" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:list",
        code: "forbidden",
      };
    }
    const resolved = this.#resolveGoalSession(msg.sessionId, auth);
    if (!resolved.ok) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: resolved.error,
        code: resolved.code,
      };
    }
    return {
      type: "blackboard.index.result",
      requestId: msg.id,
      sessionId: resolved.goal.id,
      goal: resolved.goal.collaboration?.goal ?? "",
      entries: this.#ownerBlackboard(resolved.goal).index(),
    };
  }

  /**
   * One artifact body. Gated on `session:watch` — a body is session CONTENT,
   * the same class as the streamed output a watcher already receives, and a
   * step above the `session:list` metadata the index exposes.
   */
  #blackboardRead(
    msg: Extract<ClientMessage, { type: "blackboard.read" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:watch",
        code: "forbidden",
      };
    }
    const resolved = this.#resolveGoalSession(msg.sessionId, auth);
    if (!resolved.ok) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: resolved.error,
        code: resolved.code,
      };
    }
    const found = this.#ownerBlackboard(resolved.goal).read(
      msg.kind,
      msg.slot ?? null,
      msg.version,
    );
    return {
      type: "blackboard.read.result",
      requestId: msg.id,
      sessionId: resolved.goal.id,
      // `id`/`goalSessionId` are dropped: the id is an internal row key with no
      // client use, and the goal is already on the envelope.
      artifact: found
        ? {
            kind: found.kind,
            slot: found.slot,
            version: found.version,
            content: found.content,
            authorSub: found.authorSub,
            authorRole: found.authorRole,
            createdAt: found.createdAt,
          }
        : null,
    };
  }

  /**
   * Live panel state for one goal (§7) — what a client needs to SHOW a fan-out
   * while it is running.
   *
   * Gated on `session:list`, the same tier as `blackboard.index`: this is
   * metadata about sessions the holder can already enumerate, carrying no
   * prompts and no artifact bodies. Scoped to the goal's OWN dispatches via
   * `createdBy`, so one collaboration's panels never surface in another's UI.
   */
  #collaborationPanels(
    msg: Extract<ClientMessage, { type: "collaboration.panels" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:list",
        code: "forbidden",
      };
    }
    const resolved = this.#resolveGoalSession(msg.sessionId, auth);
    if (!resolved.ok) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: resolved.error,
        code: resolved.code,
      };
    }
    const goal = resolved.goal;
    const rows = this.#store.dispatchRecentGroups(
      goal.accountId,
      goal.projectId,
      orchestratorCreatedBy(goal.id),
      PANEL_HISTORY_LIMIT,
    );

    // Group in insertion order of first appearance: the store already returns
    // newest-group-first, so a Map preserves that without a second sort.
    const byGroup = new Map<string, CollaborationPanel>();
    for (const t of rows) {
      if (!t.groupId) continue;
      let panel = byGroup.get(t.groupId);
      if (!panel) {
        panel = {
          groupId: t.groupId,
          createdAt: t.createdAt,
          members: [],
          settled: 0,
          joined: false,
        };
        byGroup.set(t.groupId, panel);
      }
      panel.members.push({
        sessionId: t.targetSession,
        ordinal: t.groupOrdinal ?? panel.members.length + 1,
        // A held member is unsettled with its worker still assigned — what a
        // panel draws as `running`. Nothing holds a panel member today (only
        // loop attempts are held, and attempts are never grouped), so the
        // panel's wire union stays as clients already render it.
        status: t.status === "held" ? "running" : t.status,
      });
      if (TERMINAL_TASK_STATUS.has(t.status)) panel.settled++;
    }
    const panels = [...byGroup.values()].map((p) => ({
      ...p,
      members: [...p.members].sort((a, b) => a.ordinal - b.ordinal),
      // `joined` is derived from the members rather than from a stored flag, so
      // it cannot disagree with what the same payload shows.
      joined: p.members.length > 0 && p.settled === p.members.length,
    }));

    return {
      type: "collaboration.panels.result",
      requestId: msg.id,
      sessionId: goal.id,
      panels,
    };
  }

  #fsErr(requestId: string, err: unknown): DaemonMessage {
    if (err instanceof FsAccessError) {
      return { type: "response.error", requestId, error: err.message, code: err.code };
    }
    return {
      type: "response.error",
      requestId,
      error: err instanceof Error ? err.message : String(err),
      code: "internal",
    };
  }

  /** Inject the MemoryEngine after construction (embedder init is async). */
  setMemory(memory: MemoryEngine): void {
    this.#memory = memory;
  }

  /** Inject the shared memory MCP endpoint + URL (daemon-wide, built after the
   *  engine + HTTP server exist). Sessions hand it to URL-mounting backends. */
  setMemoryMcp(mount: MemoryMcpMount): void {
    this.#memoryMcp = mount;
  }

  /** The goal-blackboard MCP endpoint, routed by the HTTP server. */
  get blackboardMcp(): BlackboardMcpHttp {
    return this.#blackboardMcp;
  }

  /**
   * The cost roll-up for one goal — tests only. The production path reaches it
   * through the `collaborationCost` callback handed to each orchestrator
   * Session, which is not observable from outside.
   */
  _collaborationCostForTest(goalSessionId: string): CollaborationCost | undefined {
    return this.#collaborationCostRollup(goalSessionId);
  }

  /**
   * Unscoped session lookup — tests only, and named so a production call site
   * is obvious in review. Everything user-facing must go through
   * `#getOwnedSession`, which gates on tenancy.
   */
  _sessionForTest(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /**
   * The URL a role-child mounts the blackboard from. Loopback regardless of the
   * daemon's bind address — the agent subprocess runs on this host, and the
   * endpoint must not become reachable off-box merely because the daemon binds
   * wide. Same reasoning as the memory mount.
   */
  setBlackboardUrl(url: string): void {
    this.#blackboardUrl = url;
  }

  /** Inject the cross-backend MCP registry + daemon-owned client pool. Sessions
   *  hand both to every provider so the registry's servers mount on all backends. */
  setMcp(registry: McpRegistry, hub: McpHub, oauth?: McpOAuth): void {
    this.#mcpRegistry = registry;
    this.#mcpHub = hub;
    this.#mcpOAuth = oauth;
  }

  /** Remove a client from all sessions (e.g. on disconnect). */
  disconnectClient(clientId: string): void {
    for (const session of this.#sessions.values()) {
      session.detach(clientId);
    }
    // Also drop any fleet subscription — otherwise a dead socket keeps getting
    // deltas pushed at it for the life of the daemon.
    this.#fleetSubscribers.delete(clientId);
    this.#providerSubscribers.delete(clientId);
  }

  /** Get a session by name within the caller's tenant (for Telegram convenience).
   *  Tenant-scoped like #getOwnedSession — a bare name scan would otherwise match
   *  another tenant's session (a cross-tenant name probe + a self-detach side
   *  effect in the /attach path). */
  findByName(name: string, auth: AuthContext): Session | undefined {
    for (const session of this.#sessions.values()) {
      if (
        session.name === name &&
        session.accountId === auth.accountId &&
        session.projectId === auth.projectId
      ) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Graceful drain — wait for all in-flight sessions to reach idle.
   * Used during shutdown.
   *
   * Each working session is interrupted **once**. The previous loop
   * re-interrupted on every poll iteration; if the SDK subprocess
   * was mid HTTP retry and didn't respond within 500 ms, drain
   * piled up duplicate "interrupted by system:shutdown" info rows
   * (up to 20 in a 10-s window) and 20× the audit log churn. Track
   * a per-session "already interrupted" set, then poll status until
   * idle or deadline.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    // An abandoned login is a live pty holding an open OAuth attempt. Kill
    // those first, and unconditionally — they are not work worth draining.
    this.#backendLogin.dispose();
    // Running checks are detached process groups; without this they outlive
    // the daemon and race the same gate when the pipeline resumes.
    this.#evidence?.abortAll();
    for (const t of this.#evidenceTimers) clearTimeout(t);
    this.#evidenceTimers = [];
    const deadline = Date.now() + timeoutMs;
    const systemAuth: AuthContext = {
      sub: "system:shutdown",
      scopes: [],
      delegationDepth: 0,
      accountId: "",
      projectId: "",
    };
    const interrupted = new Set<string>();
    while (Date.now() < deadline) {
      const working = [...this.#sessions.values()].filter(
        (s) =>
          s.status === "thinking" ||
          s.status === "tool_running" ||
          s.status === "waiting_approval" ||
          // Looks idle, but a queued send is about to start a turn: stop it
          // too, or it starts after shutdown began.
          s.preparingTurn,
      );
      if (working.length === 0) return;
      for (const session of working) {
        if (interrupted.has(session.id)) continue;
        void session.interrupt(systemAuth);
        interrupted.add(session.id);
      }
      await Bun.sleep(500);
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  /** The configured display name of the conductor session (default "conductor"). */
  #conductorName(): string {
    return this.#config?.conductor?.name ?? "conductor";
  }

  async #create(
    msg: Extract<ClientMessage, { type: "session.create" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:create", code: "forbidden" };
    }

    // Reserve the conductor's display name for the singleton — a normal
    // session named "conductor" would shadow it in session.list and confuse
    // any name-based lookup. Point the caller at the role instead.
    if (msg.name === this.#conductorName()) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `"${msg.name}" is reserved for the conductor session — create it with role:"conductor" instead`,
        code: "invalid_request",
      };
    }

    // Rate limit check
    const rateCheck = this.#rateLimiter.check(auth.sub, this.#liveSessionCountFor(auth.sub));
    if (!rateCheck.allowed) {
      return { type: "response.error", requestId: msg.id, error: rateCheck.reason, code: "rate_limited" };
    }

    // Explicit provider selection fails CLOSED: asking for a backend this
    // daemon doesn't have must never silently hand back a claude session.
    // (Resume keeps the warn-and-fall-back path — see ProviderRegistry.resolve.)
    if (msg.providerId && !this.#providers.has(msg.providerId)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Unknown provider "${msg.providerId}" — available: ${this.#providers.ids().join(", ")}`,
        code: "invalid_request",
      };
    }
    // Fail closed on an unknown Claude account — creating the session on some
    // other credential would bill the wrong account.
    if (msg.claudeAccount && !hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: settings:write (needed to choose a session's Claude account)",
        code: "forbidden",
      };
    }
    if (msg.claudeAccount && !this.#claudeAccounts.has(msg.claudeAccount)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Unknown Claude account "${msg.claudeAccount}" — see \`codeoid account ls\``,
        code: "invalid_request",
      };
    }

    // Normalize + validate the workdir. A leading `~` must be expanded and a
    // missing directory rejected up front — otherwise the SDK fails opaquely
    // ("native binary … exists but failed to launch") when it can't spawn the
    // agent subprocess in a non-existent cwd. Protects every frontend.
    const workdir = normalizeWorkdir(msg.workdir);
    if (!workdir) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Working directory not found: ${msg.workdir}`,
        code: "invalid_request",
      };
    }

    // Collaborative session (docs/collaborative-session-design.md §9): the
    // role→backend bindings are validated fail-closed up front, for the same
    // reason `providerId` is — a collaboration whose roles silently collapse
    // onto the default backend would be "multi-model" in name only.
    let collaboration: CollaborationConfig | undefined;
    // The session created here IS the orchestrator (§9: the toggle compiles to
    // a pack and creates the run). So the backend that must mount the fleet
    // MCP server is THIS session's — which makes `providerId` the thing the
    // claude-only orchestrator rule has to agree with. Validating the role
    // entry alone would leave that rule guarding a config row while the
    // session actually doing the orchestrating ran on anything at all.
    let providerId = msg.providerId;
    // Pack ADOPTION (docs/role-model-binding.md §6): a collaboration that
    // names a pack lets the pack — not the collab machinery — define what
    // each role is. Resolved BEFORE validation because adoption rewrites the
    // roles (envelope write from the role YAML, models through the binding
    // chain) and the rewritten config must pass the same semantic rules as a
    // free-form one.
    let adoption: PackActivation | undefined;
    // Non-fatal binding notes (skipped cross-vendor bindings, unmapped tiers).
    // Collected and returned on the create response — a warning only the
    // daemon console sees is one the creating operator never sees.
    const warnings: string[] = [];
    const warn = (m: string): void => {
      warnings.push(m);
      console.warn(`[codeoid] ${m}`);
    };
    if (msg.collaboration) {
      let collabConfig = msg.collaboration;
      if (msg.pack) {
        // packRole names ONE capability role for an ambient session; a
        // collaboration binds a role per child, so a single session-wide role
        // is a category error — reject rather than guess which child it meant.
        if (msg.packRole) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: "packRole does not apply to a collaborative session — each role's envelope comes from the pack's role YAML.",
            code: "invalid_request",
          };
        }
        try {
          adoption = this.#packs.resolveActivation(msg.pack);
        } catch (e) {
          return { type: "response.error", requestId: msg.id, error: e instanceof Error ? e.message : String(e), code: "invalid_request" };
        }
        const adopted = adoptPackRoles(collabConfig, {
          packId: adoption.id,
          roles: adoption.roles ?? {},
          modelConfig: this.#modelBindingConfig(),
          warn: (m) => warn(`pack "${adoption?.id}": ${m}`),
        });
        if (!adopted.ok) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: adopted.error,
            code: "invalid_request",
          };
        }
        collabConfig = adopted.config;
      }
      const checked = validateCollaboration(collabConfig, this.#providers);
      if (!checked.ok) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: checked.error,
          code: "invalid_request",
        };
      }
      collaboration = checked.config;
      // A declared scope may hand a reviewer its peers' verdicts or the
      // implementer's reasoning. That is allowed (§7's debate round wants it)
      // but must not be silent, now that one CLI flag can do it.
      for (const note of collaborationScopeWarnings(collaboration)) warn(note);
      const orchestrator = orchestratorRole(collaboration);
      if (orchestrator) {
        if (providerId && providerId !== orchestrator.providerId) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: `providerId "${providerId}" conflicts with the "${ORCHESTRATOR_ROLE}" role's backend "${orchestrator.providerId}" — a collaborative session IS its orchestrator, so omit providerId or set it to "${orchestrator.providerId}".`,
            code: "invalid_request",
          };
        }
        // Derive it, so the session can't land on a backend that cannot drive
        // the fleet merely because the caller left providerId unset.
        providerId = orchestrator.providerId;
      }
    }

    // Ambient pack activation (docs/pack-loading.md): resolve the requested pack
    // (+ optional capability role) up front; fail-closed on an unknown pack/role.
    // A collaborative create already resolved its pack above (adoption), where
    // the activation feeds the compiled goal pack instead of activating here.
    let pack: PackActivation | undefined;
    if (msg.pack && !collaboration) {
      try {
        pack = this.#packs.resolveActivation(msg.pack, msg.packRole);
      } catch (e) {
        return { type: "response.error", requestId: msg.id, error: e instanceof Error ? e.message : String(e), code: "invalid_request" };
      }
    } else if (msg.packRole && !msg.pack) {
      return { type: "response.error", requestId: msg.id, error: "packRole requires pack", code: "invalid_request" };
    }

    // Model for a single session (docs/role-model-binding.md §6.2). An explicit
    // `model` is the operator's word — validated provider-aware (a Claude alias
    // must not ride onto another vendor; past that, the live backend is the
    // real validator, same house policy as session.set_model). Omitted, with a
    // pack capability role active, it resolves through the role's binding
    // chain minus the phase-pin and cli rungs.
    let defaultModel: string | undefined;
    if (msg.model !== undefined && msg.model.trim() !== "") {
      if (collaboration) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: "model does not apply to a collaborative session — set it per role (--role name:provider:model).",
          code: "invalid_request",
        };
      }
      const forProvider = providerId ?? this.#providers.defaultId;
      const resolved = resolveModelIdForProvider(msg.model, forProvider);
      if (!resolved) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: `Model "${msg.model}" is not valid for provider "${forProvider}". Omit model to use the provider's default.`,
          code: "invalid_request",
        };
      }
      defaultModel = resolved;
    } else if (pack?.role) {
      const resolved = resolveBinding({
        packId: pack.id,
        roleName: pack.roleName,
        role: pack.role,
        config: this.#modelBindingConfig(),
      });
      if (resolved.resolvedFrom === "default") {
        if (pack.role.tier !== undefined) {
          warn(
            `pack "${pack.id}" role "${pack.roleName}" declares tier "${pack.role.tier}" but no modelTiers mapping exists — using the provider default`,
          );
        }
      } else if (
        resolved.provider !== undefined &&
        msg.providerId !== undefined &&
        resolved.provider !== msg.providerId
      ) {
        // The explicit --provider wins over a config/pack binding on another
        // backend — a model id doesn't transfer across vendors.
        warn(
          `pack "${pack.id}" role "${pack.roleName}": the ${resolved.resolvedFrom} binding targets provider "${resolved.provider}" but the session asked for "${msg.providerId}" — using that backend's default model`,
        );
      } else {
        // The winning rung supplies the whole binding: its provider (when it
        // names one) fails closed like an explicit providerId would.
        if (resolved.provider !== undefined && !this.#providers.has(resolved.provider)) {
          return {
            type: "response.error",
            requestId: msg.id,
            error: `Role "${pack.roleName}" resolves to unknown provider "${resolved.provider}" (via ${resolved.resolvedFrom}) — available: ${this.#providers.ids().join(", ")}`,
            code: "invalid_request",
          };
        }
        const targetProvider = resolved.provider ?? providerId ?? this.#providers.defaultId;
        // A chain-resolved model goes through the SAME provider-aware
        // validation as an explicit --model — but SKIPS with a warning rather
        // than hard-failing the create: the operator never typed this id, so a
        // model-only pin written for another vendor must not brick the create
        // (nor silently transfer). The rung's provider still applies.
        if (resolved.model !== undefined && resolveModelIdForProvider(resolved.model, targetProvider) === null) {
          warn(
            `pack "${pack.id}" role "${pack.roleName}": the ${resolved.resolvedFrom} binding's model "${resolved.model}" is not valid for provider "${targetProvider}" — using that backend's default model`,
          );
        } else {
          defaultModel = resolved.model;
        }
        providerId = resolved.provider ?? providerId;
      }
    }

    // An account for the backend the session lands on (`claudeAccount` is
    // #392's spelling of the Claude one). Fail closed on an unknown account —
    // creating the session on some other credential would bill the wrong one.
    const landingBackend = providerId ?? this.#providers.defaultId;
    if (msg.account && msg.claudeAccount && landingBackend === "claude" && msg.account !== msg.claudeAccount) {
      return { type: "response.error", requestId: msg.id, error: "account and claudeAccount name different Claude accounts — send one", code: "invalid_request" };
    }
    const createAccount = msg.account ?? (landingBackend === "claude" ? msg.claudeAccount : undefined);
    if (createAccount || msg.claudeAccount) {
      const refused = this.#accountsWriteRefusal(msg.id, auth);
      if (refused) return refused;
    }
    if (createAccount) {
      if (!backendHasAccounts(landingBackend) || !this.#accounts.has(landingBackend, createAccount)) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: `Unknown ${landingBackend} account "${createAccount}" — see \`codeoid account ls --backend ${landingBackend}\``,
          code: "invalid_request",
        };
      }
    }

    // Plan the role-children BEFORE creating anything, so a fan-out over the
    // ceiling rejects the request outright instead of leaving a half-built
    // collaboration behind.
    let planned: PlannedChild[] = [];
    if (collaboration) {
      const plan = planChildren(collaboration);
      if (!plan.ok) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: plan.error,
          code: "invalid_request",
        };
      }
      planned = plan.children;
      // Tenant-wide blast-radius backstop, checked BEFORE anything is built so
      // a refusal costs nothing to unwind (§11 P3). `planChildren` has already
      // bounded THIS goal at MAX_COLLABORATION_CHILDREN; this bounds the number
      // of goals, which nothing did — see #liveCollaborationChildren.
      const overCap = this.#liveChildrenCapExceededBy(auth, planned.length);
      if (overCap) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: overCap,
          code: "rate_limited",
        };
      }
      // The orchestrator runs under the compiled one-goal pack: the goal, its
      // fleet roster, and the delegation rules become its constitution, so
      // pack vocabulary never surfaces on this path. Under adoption (§6.1)
      // the constitution composes pack ETHOS → goal → roster, the real pack
      // id replaces the synthetic one, and the orchestrator gets the pack's
      // subagents exactly as a --pack session would.
      const compiled = compileGoalPack(
        collaboration,
        planned,
        adoption ? { id: adoption.id, constitution: adoption.constitution } : undefined,
      );
      pack = {
        id: compiled.id,
        constitution: compiled.constitution,
        subagents: adoption ? adoption.subagents : compiled.subagents,
        // ...and, under `skillScope: "session"`, the pack's skills too — a
        // global-scope adoption sees them via ~/.claude/skills; dropping the
        // plugin here would make the orchestrator the one session that can't
        // run the methodology's slash skills.
        ...(adoption?.skillsPluginDir ? { skillsPluginDir: adoption.skillsPluginDir } : {}),
      };
    }

    // The orchestrator's role-aware fleet surface, scoped to this goal's own
    // children. Built BEFORE the session because `fleet` is a constructor
    // input; the id it scopes to is read lazily through the thunk, which is
    // only ever called from a tool handler mid-turn.
    let goalSessionId = "";
    const orchestratorFleet = collaboration
      ? this.#buildOrchestratorFleetServer(
          () => goalSessionId,
          auth.accountId,
          auth.projectId,
        )
      : undefined;

    const session = new Session({
      name: msg.name,
      workdir,
      auth,
      fleet: orchestratorFleet,
      // Same thunk trick as `fleet`: the goal id is generated inside this
      // constructor, and the callback is only invoked from an approval request.
      collaborationCost: collaboration
        ? () => this.#collaborationCostRollup(goalSessionId)
        : undefined,
      store: this.#store,
      transcriptStore: this.#transcriptStore,
      providers: this.#providers,
      claudeAccounts: this.#claudeAccounts,
      // The Claude choice also when the session lands elsewhere: it applies if it is switched to Claude.
      claudeAccount: msg.claudeAccount || null,
      ...(createAccount ? { accountChoices: { [landingBackend]: createAccount } } : {}),
      hooks: this.#hooks,
      // Derived above for a collaborative session; otherwise msg.providerId.
      providerId,
      // Explicit `model`, or the pack role's resolved binding (§6.2). Outranks
      // config.session.defaultModel; still loses to a persisted choice.
      defaultModel,
      ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
      pack,
      collaboration,
      identityManager: this.#identityManager,
      memory: this.#memory,
      memoryMcp: this.#memoryMcp,
mcpRegistry: this.#mcpRegistry,
mcpHub: this.#mcpHub,
      config: this.#config,
      compressionRegistry: this.#compressionRegistry,
      _testProvider: this.#testProviderFactory?.(),
      onStatusChange: this.#statusObserver,
      ...this.#modelHooks,
    });

    // Resolve the thunk the fleet server closes over. Set before any child
    // exists, and before the session can take a turn, so no tool handler can
    // observe the empty string.
    goalSessionId = session.id;
    this.#sessions.set(session.id, session);
    this.#rateLimiter.recordCreation(auth.sub);

    if (collaboration) this.#attachOrchestratorBlackboard(session, collaboration);

    if (collaboration && planned.length > 0) {
      const spawned = await this.#spawnCollaborationChildren(session, collaboration, planned, auth, adoption);
      if (!spawned.ok) {
        // All-or-nothing: a collaboration missing a role is not a working
        // collaboration, and leaving the orchestrator up with a partial fleet
        // would have it delegate to children that don't exist. Unwind.
        await this.#teardownCollaborationChildren(session.id, "partial spawn rolled back");
        try {
          await session.destroy(auth);
        } catch {
          // Best-effort — the error we report is the spawn failure.
        }
        // Removing it from #sessions is the whole rollback: the concurrency
        // count is derived from the live session set (see rate-limit.ts on why
        // it is no longer a stored counter), so there is nothing to decrement.
        // The hourly creation timestamp stays recorded on purpose — the create
        // was attempted, and a failed spawn shouldn't refund an attempt into a
        // retry loop.
        this.#sessions.delete(session.id);
        return {
          type: "response.error",
          requestId: msg.id,
          error: spawned.error,
          code: "internal",
        };
      }
    }

    // Kick the orchestrator off on its own goal.
    //
    // Everything above only BUILDS the collaboration: the goal is compiled into
    // the orchestrator's constitution and the role-children are brought up
    // deliberately silent (see #spawnCollaborationChildren — a fleet of N costs
    // zero tokens). Nothing sent a turn, so before this the whole goal sat idle
    // at "no messages, no progress" until the owner happened to type something
    // into a session that already knew exactly what it was for.
    //
    // The goal text is sent as the opening user turn rather than a bare "begin":
    // it makes the transcript self-describing (the goal is the first thing you
    // read on attach, and on resume) instead of opening with a directive whose
    // subject lives only in the constitution.
    //
    // Fire-and-forget on purpose — create must not block on the first model
    // call, and a send failure has to leave a usable (if idle) collaboration
    // rather than failing the create that already spawned children.
    if (collaboration) {
      void session.send(collaboration.goal, auth).catch((err: unknown) => {
        console.error(
          `[codeoid] collaboration ${session.id.slice(0, 8)} failed to start on its goal (send it a message to begin): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return {
      type: "response.ok",
      requestId: msg.id,
      data: session.toInfo(),
      // Binding notes collected above (adoption skips, unmapped tiers) — the
      // create succeeded; these say what was quietly adjusted and where to fix.
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Bring up a collaborative session's role-children (P1b).
   *
   * Each child is a normal long-lived session — NOT a dispatch-spawned
   * disposable worker. That distinction is deliberate: the dispatcher destroys
   * a spawn-task worker the moment its turn ends (`#finishWorkerTask`), which
   * is wrong for a role that has to survive the implement↔review fix-loop.
   * These children instead receive `fleet_send` dispatches, which the
   * dispatcher delivers without taking ownership of their lifetime, so the
   * collaboration owns teardown.
   *
   * No brief is SENT here. The child's role, contract, and goal ride in its
   * pack constitution instead, so bringing up a fleet of N costs zero tokens
   * and no child burns a turn just to learn it should wait.
   */
  /**
   * Revoke a collaboration child's blackboard token. Idempotent, and safe to
   * call for any session id.
   *
   * Must be called from EVERY path that removes a child from `#sessions`, not
   * just goal teardown. The token lives in the endpoint's binding map, not on
   * the Session, so dropping the session without revoking leaves a credential
   * that still authorizes reads and writes against the goal — anything still
   * holding the URL (a wedged subprocess, a leaked env var) keeps working after
   * the child is gone. Destroying a child directly used to do exactly that.
   */
  #revokeBlackboardToken(sessionId: string): void {
    const token = this.#blackboardTokens.get(sessionId);
    if (!token) return;
    this.#blackboardMcp.revoke(token);
    this.#blackboardTokens.delete(sessionId);
  }

  /**
   * Live role-children this tenant is currently running, across every goal.
   *
   * Counted from the live session map rather than from a table: a role-child
   * IS a session (per-goal lifetime, not a dispatch task), so the session map
   * is the authority on how many are actually running right now. Counting rows
   * in `dispatch_tasks` — which is what `dispatch.maxConcurrentWorkers` does —
   * finds none of them, and that is precisely the gap this closes.
   */
  #liveCollaborationChildren(accountId: string, projectId: string): number {
    let n = 0;
    for (const s of this.#sessions.values()) {
      if (
        s.collaborationRole !== undefined &&
        s.accountId === accountId &&
        s.projectId === projectId
      ) {
        n++;
      }
    }
    return n;
  }

  /**
   * The refusal message when spawning `incoming` more children would cross the
   * tenant cap, or `null` when it fits.
   *
   * A blast-radius backstop, not a scheduler: it refuses the create outright
   * rather than queueing it. Queueing would leave the user with a collaboration
   * that exists but is not working, which is strictly harder to reason about
   * than being told no — and the fix (destroy a finished goal) is one command.
   *
   * Absent config means UNLIMITED. `loadConfig` always populates a default, so
   * an absent value only happens for a hand-built config in a test or an
   * embedder, and inventing a cap those never asked for would be the surprising
   * direction.
   */
  #liveChildrenCapExceededBy(auth: AuthContext, incoming: number): string | null {
    const cap = this.#config?.collaboration?.maxLiveChildren ?? 0;
    if (cap <= 0) return null;
    const live = this.#liveCollaborationChildren(auth.accountId, auth.projectId);
    if (live + incoming <= cap) return null;
    return [
      `Collaboration would bring live role-children to ${live + incoming}, over the limit of ${cap}`,
      `(${live} already running across your goals).`,
      "Destroy a finished collaboration, reduce this one's fan-out, or raise",
      "`collaboration.maxLiveChildren` in ~/.codeoid/config.json.",
    ].join(" ");
  }

  /**
   * What one collaboration has spent so far: the orchestrator plus every live
   * role-child (§11 P3's cost roll-up).
   *
   * Summed live from the session map rather than kept as a running total. The
   * child set changes over a goal's life — children are torn down, and a
   * restart rebuilds them — so a stored counter would drift from reality in
   * both directions, and this is read once per approval, not per turn.
   *
   * `undefined` when the id names no live collaborative session, which is the
   * normal answer for every non-collaboration approval.
   */
  #collaborationCostRollup(goalSessionId: string): CollaborationCost | undefined {
    const goal = this.#sessions.get(goalSessionId);
    if (!goal?.collaboration) return undefined;

    const rollup: CollaborationCost = {
      goalSessionId,
      children: 0,
      totalCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 0,
    };
    const add = (s: Session): void => {
      const u = s.toInfo().usage;
      if (!u) return;
      rollup.totalCostUsd += u.totalCostUsd;
      rollup.inputTokens += u.inputTokens;
      rollup.outputTokens += u.outputTokens;
      rollup.numTurns += u.numTurns;
    };

    add(goal);
    for (const s of this.#sessions.values()) {
      if (
        s.collaborationRole?.parentSessionId !== goalSessionId ||
        s.accountId !== goal.accountId ||
        s.projectId !== goal.projectId
      ) {
        continue;
      }
      rollup.children++;
      add(s);
    }
    return rollup;
  }

  /**
   * Recompile a resumed orchestrator's one-goal pack from its persisted
   * collaboration config.
   *
   * Deliberately calls the SAME `compileGoalPack` the create path calls rather
   * than persisting the rendered text: the constitution states the role's
   * blackboard scope, and a stored copy would be a snapshot of whatever
   * `DEFAULT_ROLE_IO` said on the day it was written — so upgrading the daemon
   * would leave the sentence and the fence disagreeing again.
   *
   * One thing does NOT come back: a pack-adopted collaboration's ETHOS and its
   * real pack id, because `TranscriptMeta` persists the roster but not the
   * adoption. The goal, the roster and the scope all return; the pack's "how to
   * work" preamble does not. Restoring it needs the adoption persisted, which
   * is a wider change than the gap this closes.
   */
  #resumeGoalPack(
    collaboration: CollaborationConfig,
  ): { id: string; constitution: string; subagents: [] } | undefined {
    // The roster is derived, not stored. A config that can no longer be planned
    // (a cap lowered under it) still deserves the goal and the rules, so fall
    // back to an empty roster rather than dropping the constitution entirely —
    // `compileGoalPack` renders "(no role-children …)" for it.
    const planned = planChildren(collaboration);
    return compileGoalPack(collaboration, planned.ok ? planned.children : []);
  }

  /** Lazily build the blackboard over the daemon's existing DB connection. */
  #goalBlackboard(): Blackboard {
    if (!this.#blackboard) {
      this.#blackboard = new Blackboard(new BlackboardStore(this.#store.database));
    }
    return this.#blackboard;
  }

  /**
   * Mount config for one role-child's blackboard access, or undefined when the
   * URL isn't known yet (the HTTP server sets it at startup; unit tests that
   * construct a bare SessionManager legitimately have none).
   *
   * The minted token carries the role's scope, so the child's mount is its
   * permission — there is no wider handle reachable from it.
   *
   * Takes the goal SCOPE rather than a live parent `Session` so the resume path
   * can mint a mount without one. The blackboard is keyed on
   * (tenant, goalSessionId) in SQLite, so a child's access to its goal does not
   * depend on the orchestrator object being resident — which matters because
   * resume is capped and time-boxed, and a parent can legitimately miss the
   * window its own children made.
   */
  #blackboardMountFor(
    scope: GoalScope,
    child: PlannedChild,
  ): { url: string; token: string } | undefined {
    if (!this.#blackboardUrl) return undefined;
    const handle = this.#goalBlackboard().forRole(
      scope,
      {
        roleName: child.roleName,
        ordinal: child.ordinal,
        // Attribution keyed to the ROLE within the goal, not the child's
        // session id: a role-child replaced after a restart is still the same
        // contributor, and its earlier artifacts should keep reading that way.
        // That property is what makes resume work at all — a resumed child
        // writes under the authorSub its pre-restart versions carry.
        authorSub: `agent:${scope.goalSessionId}:${child.roleName}#${child.ordinal}`,
      },
      // From the PLANNED CHILD, which is also what `childBrief` resolves its
      // READ/WRITE lines from — one derivation, so the fence and the sentence
      // cannot disagree. This used to take a separate
      // `collaboration.roles.find((r) => r.name === …)`, an exact-match lookup
      // in a module that compares names case-insensitively everywhere else: a
      // miss yielded `undefined`, `resolveRoleIo` fell back to the §3 profile,
      // and a `+reads=`-narrowed reviewer came back on a WIDER scope than it
      // declared, with its brief still stating the narrow one. Failing open,
      // silently, at the one seam where a declared scope becomes a real fence.
      { reads: child.reads, writes: child.writes },
    );
    return { url: this.#blackboardUrl, token: this.#blackboardMcp.mint(handle) };
  }

  /**
   * Give an orchestrator its own blackboard mount.
   *
   * The orchestrator needs the blackboard MOST: §4 has it holding the index of
   * artifact states, and §7 has it reading every reviewer's findings to
   * synthesize. Without a mount it cannot see a single thing its children
   * publish and the coordination loop never closes.
   *
   * Called post-construction in both `#create` and resume, because the goal id
   * it is scoped to IS this session's own id.
   */
  #attachOrchestratorBlackboard(
    session: Session,
    collaboration: CollaborationConfig,
  ): void {
    const orchestrator = orchestratorRole(collaboration);
    const mount = this.#blackboardMountFor(
      {
        accountId: session.accountId,
        projectId: session.projectId,
        goalSessionId: session.id,
      },
      // The orchestrator is not in `planChildren`'s output (it IS the goal
      // session), so its PlannedChild is synthesized here — including its own
      // declared scope, which is what `compileGoalPack` states in the
      // constitution.
      {
        roleName: ORCHESTRATOR_ROLE,
        ordinal: 1,
        providerId: session.providerId,
        shape: "scout",
        write: false,
        ...(orchestrator?.reads !== undefined ? { reads: orchestrator.reads } : {}),
        ...(orchestrator?.writes !== undefined ? { writes: orchestrator.writes } : {}),
      },
    );
    if (!mount) return;
    session.attachBlackboard(mount);
    this.#blackboardTokens.set(session.id, mount.token);
  }

  async #spawnCollaborationChildren(
    parent: Session,
    collaboration: CollaborationConfig,
    planned: readonly PlannedChild[],
    auth: AuthContext,
    // Pack adoption (§6.1): children get the role YAML's real envelope and a
    // brief that opens with the pack's ETHOS. Absent = free-form, unchanged.
    adoption?: PackActivation,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // Keyed case-insensitively to agree with the validator's lowercased names.
    const adoptedRoles = new Map<string, RoleDef>();
    for (const def of Object.values(adoption?.roles ?? {})) {
      adoptedRoles.set(def.name.toLowerCase(), def);
    }
    for (const child of planned) {
      try {
        const adoptedRole = adoption ? adoptedRoles.get(child.roleName.toLowerCase()) : undefined;
        // Minted before construction so the child's provider can mount it from
        // the start — the token carries this role's read/write scope.
        const blackboard = this.#blackboardMountFor(
          {
            accountId: parent.accountId,
            projectId: parent.projectId,
            goalSessionId: parent.id,
          },
          child,
        );
        const childSession = new Session({
          name: childSessionName(parent.name, child),
          workdir: parent.workdir,
          auth,
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          providers: this.#providers,
          claudeAccounts: this.#claudeAccounts,
          // The collaboration runs on the accounts its lead was created on.
          claudeAccount: parent.claudeAccount,
          accountChoices: parent.accountChoices,
          hooks: this.#hooks,
          providerId: child.providerId,
          defaultModel: child.model,
          // Worker shape, capability role, brief, and collaborationRole — the
          // whole restriction set, from the one function the resume path also
          // calls so the two can't drift.
          ...roleChildPosture(
            child,
            parent.id,
            childBrief(collaboration, child, adoption?.constitution),
            adoptedRole
              ? {
                  packId: adoption!.id,
                  role: adoptedRole,
                  ...(adoption!.skillsPluginDir ? { skillsPluginDir: adoption!.skillsPluginDir } : {}),
                }
              : undefined,
          ),
          // Autonomous with a bounded budget — the same posture dispatch gives
          // its workers, and for the same reason: NOBODY ATTACHES TO A CHILD.
          // The owner's approval happens once at dispatch time (the R3 gate on
          // fleet_send/fleet_spawn), not per tool call. Left interactive, a
          // child's first non-safe tool call parks it at waiting_approval with
          // zero clients and the collaboration deadlocks on its very first
          // handoff — observed live before this was set.
          initialMode: {
            mode: "autonomous",
            maxTurns: this.#dispatcher.config.workerToolBudget,
          },
          // Role-scoped goal blackboard, mountable by ANY backend (#245) —
          // this is how a gemini reviewer and an openai reasoner hand work to
          // each other without the orchestrator relaying it as prose.
          blackboardMcp: blackboard,
          identityManager: this.#identityManager,
          memory: this.#memory,
          memoryMcp: this.#memoryMcp,
          mcpRegistry: this.#mcpRegistry,
          mcpHub: this.#mcpHub,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
          _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
          ...this.#modelHooks,
        });
        this.#sessions.set(childSession.id, childSession);
        if (blackboard) this.#blackboardTokens.set(childSession.id, blackboard.token);
        // No rate-limiter charge: the human called session.create once, and
        // the child count is already bounded by MAX_COLLABORATION_CHILDREN.
        // Mirrors spawnWorker, which charges nothing for the same reason.
        this.#store.audit(
          auth.sub,
          "collaboration.child_spawned",
          childSession.id,
          `parent=${parent.id} role=${child.roleName}#${child.ordinal} provider=${child.providerId}${child.model ? `/${child.model}` : ""} shape=${child.shape}`,
        );
      } catch (err) {
        return {
          ok: false,
          error: `Failed to bring up collaboration role "${child.roleName}" on "${child.providerId}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * Tear down every live child of a collaboration (goal end).
   *
   * Membership is DERIVED from the live session set rather than tracked in a
   * side map, so it cannot drift out of sync with reality — the failure mode
   * of a parallel registry here is an orphaned agent subprocess.
   */
  async #teardownCollaborationChildren(parentSessionId: string, reason: string): Promise<void> {
    const children = [...this.#sessions.values()].filter(
      (s) => s.collaborationRole?.parentSessionId === parentSessionId,
    );
    for (const child of children) {
      try {
        await child.destroy(this.#dispatchSystemAuth(child.accountId, child.projectId));
      } catch (err) {
        console.error(
          `[codeoid/collaboration] child teardown failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.#revokeBlackboardToken(child.id);
      this.#sessions.delete(child.id);
      this.#store.audit(
        "system:collaboration",
        "collaboration.child_destroyed",
        child.id,
        `parent=${parentSessionId} role=${child.collaborationRole?.roleName ?? "?"} reason=${reason}`,
      );
    }
  }

  /**
   * Fork a session (`session.fork`) — branch its conversation into a new,
   * independent session seeded with a COPY of the parent's canonical history
   * and scrollback. Optionally onto a different backend (`providerId`), so
   * "branch this claude conversation and continue it on codex" is one call.
   * The parent is untouched.
   *
   * Fails closed: a foreign/unknown parent is `not_found`; an unknown
   * providerId is `invalid_request` (same rule as create/set_provider).
   */
  async #fork(
    msg: Extract<ClientMessage, { type: "session.fork" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:create", code: "forbidden" };
    }

    const parent = this.#getOwnedSession(msg.sessionId, auth);
    if (!parent) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    // Forking THE conductor would mint a second fleet supervisor — refuse.
    // The fork keeps running on the parent's Claude account, and choosing what
    // a session runs on (and bills) is `settings:write` — a fork or a compare
    // must not be a way around that.
    // Named accounts only: a pin to the built-in `default` chooses no one's credential.
    const parentChoices = Object.entries(parent.accountChoices).filter(([, name]) => name !== DEFAULT_ACCOUNT);
    if (parentChoices.length > 0 && (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE) || auth.delegationDepth > 0)) {
      const [backend, name] = parentChoices[0]!;
      return {
        type: "response.error",
        requestId: msg.id,
        error:
          backend === "claude"
            ? `This session runs on Claude account "${name}"; forking it needs settings:write from an undelegated token`
            : `This session runs on the ${backend} account "${name}"; forking it needs settings:write from an undelegated token`,
        code: "forbidden",
      };
    }
    if (parent.role) {
      return { type: "response.error", requestId: msg.id, error: `Cannot fork a ${parent.role} session`, code: "invalid_request" };
    }

    const providerId = msg.providerId ?? parent.providerId;
    if (providerId && !this.#providers.has(providerId)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Unknown provider "${providerId}" — available: ${this.#providers.ids().join(", ")}`,
        code: "invalid_request",
      };
    }

    const rateCheck = this.#rateLimiter.check(auth.sub, this.#liveSessionCountFor(auth.sub));
    if (!rateCheck.allowed) {
      return { type: "response.error", requestId: msg.id, error: rateCheck.reason, code: "rate_limited" };
    }

    // Snapshot the parent's state BEFORE building the fork. Canonical history
    // is the source of truth for the conversation; the transcript rows are
    // replayed into the fork's scrollback for UI visibility.
    // Fork from an earlier turn (#356): the conversation, turn list and files
    // as they were right after it. Otherwise the WHOLE conversation — after a
    // restart memory may hold only its tail.
    // The parent's pack, re-resolved now rather than reused: a pack the
    // operator has since untrusted or removed must not ride along into a fork
    // (its skills); and a fork that can't carry it is refused — never quietly
    // dropped, which would lose a capability role's tool deny.
    let forkPack: PackActivation | undefined;
    const parentPack = parent.packActivation;
    if (parentPack) {
      try {
        forkPack = this.#packs.resolveActivation(parentPack.id, parentPack.roleName);
      } catch (e) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: `This session runs under pack "${parentPack.id}", which can't be activated any more (${e instanceof Error ? e.message : String(e)}) — so it can't be forked.`,
          code: "invalid_request",
        };
      }
    }
    let point: ForkPoint | null = null;
    if (msg.afterTurnId && msg.baseBranch) {
      // A clean base and "the files as they were after turn N" contradict
      // each other — there is no coherent state that is both.
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Fork from an earlier turn OR from a base branch, not both",
        code: "invalid_request",
      };
    }
    if (msg.afterTurnId) {
      try {
        point = await parent.forkPoint(msg.afterTurnId);
      } catch (err) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: err instanceof Error ? err.message : String(err),
          code:
            err instanceof RewindError
              ? err.code === "not_found"
                ? "not_found"
                : err.code === "restore_failed"
                  ? "internal"
                  : "invalid_request" // before_rotation, busy: pick another point / wait
              : "internal",
        };
      }
    }
    const history = (point ? point.history : await parent.fullCanonicalHistory()).map((t) => ({ ...t }));
    const parentInfo = parent.toInfo();
    let transcriptRows: DaemonMessage[] = [];
    let sizeHints: Array<number | undefined> = [];
    try {
      const entries = await this.#transcriptStore.loadTranscript(msg.sessionId, {
        maxBytes: RESUME_TRANSCRIPT_MAX_BYTES,
      });
      // From an earlier turn: only the rows through it.
      const kept = point
        ? cutRowsAfterTurn(
            entries,
            point.entries.map((e) => e.turnId),
            msg.afterTurnId!,
          )
        : entries;
      transcriptRows = kept.map((e) => e.message);
      sizeHints = kept.map((e) => e.bytes);
    } catch (err) {
      // Scrollback replay is best-effort — the fork's CONVERSATION is carried
      // by the canonical history above, which is already in memory.
      console.error(
        `[codeoid/fork] transcript load failed for ${msg.sessionId} (fork keeps history, drops scrollback): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Branch point: the number of turns carried over (same count either way,
    // from the turn list) — the "forked after prompt N" the lineage chip shows.
    const atTurn = point ? point.atTurn : parent.turnIndex.length || history.filter((t) => t.role === "user").length;
    let filesOutcome = "latest";

    // Git isolation: a fork must not share the parent's working tree, or two
    // agents editing the same files collide. Default: give the fork its OWN
    // worktree + branch carrying the parent's CURRENT tracked state (parent
    // untouched — see git-worktree.ts). Opt out with isolate:false; bind an
    // existing dir with workdir; degrade to shared (with a surfaced note) when
    // the workdir isn't a git repo or worktree creation fails.
    // Uniqueness suffix for the worktree branch/dir. Independent of the fork's
    // session id — the Session mints its own id, and passing existingId would
    // make the constructor treat the fork as a RESUME and skip its initial
    // meta write (dropping forkedFrom/worktree).
    const worktreeShortId = randomUUID().slice(0, 8);
    let forkWorkdir = parent.workdir;
    let worktree: SessionWorktree | undefined;
    let forkSubdirMapped = true;
    let forkFromHead: string | undefined;
    let forkHeadGone = false;
    let workdirNote: string | undefined;
    if (msg.workdir) {
      // Bind mode: run in a dir/worktree the user manages; record its branch
      // but never create or (later) remove it. Normalize + validate exactly
      // like session.create — expand ~, canonicalize, and reject a missing,
      // protected, or out-of-safe-root path (this bypassed those checks).
      const bound = normalizeWorkdir(msg.workdir);
      if (!bound) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: `Working directory not found: ${msg.workdir}`,
          code: "invalid_request",
        };
      }
      forkWorkdir = bound;
      const branch = await currentBranch(bound);
      if (branch) worktree = { path: bound, branch, createdByCodeoid: false };
    } else if (msg.isolate !== false || msg.baseBranch) {
      // baseBranch implies isolation (a base needs its own worktree).
      if (await isGitRepo(parent.workdir)) {
        try {
          // From an earlier turn: start the worktree at the commit the repo
          // was on then (recorded with the snapshot), so git history matches
          // the files rolled in below; make sure the parent's subdirectory
          // exists so the snapshot lands where it belongs.
          let rollHead = point?.files && "checkpointId" in point.files ? point.files.head : undefined;
          const make = (baseCommit?: string) =>
            createForkWorktree({
              workdir: parent.workdir,
              label: msg.name ?? parentInfo.name,
              shortId: worktreeShortId,
              ...(msg.baseBranch ? { baseBranch: msg.baseBranch } : {}),
              ...(baseCommit ? { baseCommit } : {}),
              ...(point?.files && "checkpointId" in point.files ? { ensureSubdir: true } : {}),
            });
          let headGone = false;
          const wt = await make(rollHead).catch((err: unknown) => {
            // That commit is gone (amended/rebased away and collected): still
            // isolate — carry the current state; the roll below sets the files.
            if (!rollHead) throw err;
            rollHead = undefined;
            headGone = true;
            return make();
          });
          // Fork runs in the parent's equivalent subdir of the worktree; the
          // worktree ROOT (wt.path) is what we remove on destroy.
          // Same checks as any session's workdir (safe-root, protected dirs),
          // and it must resolve inside its own worktree — else the root.
          const checked = normalizeWorkdir(wt.workdir);
          const realRoot = normalizeWorkdir(wt.path);
          const inside = !!checked && !!realRoot && (checked === realRoot || checked.startsWith(realRoot + sep));
          forkWorkdir = inside ? checked : (realRoot ?? wt.path);
          worktree = { path: wt.path, branch: wt.branch, createdByCodeoid: true };
          forkSubdirMapped = wt.subdirMapped && inside;
          forkFromHead = rollHead;
          forkHeadGone = headGone;
          // Surface that this is a fresh isolated worktree (deps aren't
          // present) — previously the isolated path was silent.
          const origin = msg.baseBranch
            ? `forked clean from \`${msg.baseBranch}\``
            : rollHead
              ? `at commit \`${rollHead.slice(0, 10)}\`, the one checked out right after that turn`
              : "carrying your uncommitted changes";
          const setupHint = this.#config?.fork?.setup
            ? " Running the configured fork setup now — the first turn will wait for it."
            : " Ignored files and build dependencies (e.g. .env, node_modules) aren't in a fresh worktree unless the repository's committed .codeoid/setup.yaml brings them — otherwise run your project's setup before building.";
          workdirNote = `🌿 Isolated in a new git worktree on branch \`${wt.branch}\` (${origin}).${setupHint}`;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // An explicit baseBranch that can't be honored is a user error
          // (bad ref) — fail loudly rather than silently sharing the dir.
          if (msg.baseBranch) {
            return {
              type: "response.error",
              requestId: msg.id,
              error: `Cannot fork from base "${msg.baseBranch}": ${reason}`,
              code: "invalid_request",
            };
          }
          workdirNote = `⚠️ Could not create an isolated git worktree (${reason}). This fork SHARES the parent's working directory — concurrent file edits in both sessions will collide.`;
        }
      } else if (msg.baseBranch) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: `Cannot fork from base "${msg.baseBranch}": the working directory is not a git repository`,
          code: "invalid_request",
        };
      } else {
        workdirNote =
          "⚠️ The parent's workdir isn't a git repo, so this fork SHARES it — " +
          "concurrent file edits in both sessions will collide.";
      }
    }

    let fork: Session;
    try {
      fork = new Session({
        name: msg.name ?? `${parentInfo.name} (fork)`,
        workdir: forkWorkdir,
        auth,
        store: this.#store,
        transcriptStore: this.#transcriptStore,
        providers: this.#providers,
        claudeAccounts: this.#claudeAccounts,
        // A fork continues the same conversation — on the same accounts,
        // thinking as hard (#417).
        claudeAccount: parent.claudeAccount,
        accountChoices: parent.accountChoices,
        effort: parentInfo.effort ?? null, // the parent's Default stays Default
        hooks: this.#hooks,
        providerId,
        forkedFrom: {
          sessionId: parentInfo.id,
          name: parentInfo.name,
          atTurn,
        },
        worktree,
        // Inherit the parent's execution mode + remaining autonomous budget so a
        // fork continues under the SAME trust as the session it came from.
        // Without this a fork silently starts `guarded` (the Session default)
        // regardless of the parent, so an autonomous parent's fork blocks its
        // own writes/exec on approval prompts — which, unattended, get auto-denied
        // at turn boundaries ("Denied by user"). A fork is user-initiated from a
        // session they own, so carrying the parent's mode is the least-surprising
        // behaviour and keeps the mode→backend-policy plumbing consistent.
        initialMode: {
          mode: parent.mode,
          ...(parent.turnsRemaining !== undefined ? { maxTurns: parent.turnsRemaining } : {}),
        },
        // ...and its pack: a capability role's tool deny is part of that trust
        // (a fork of a read-only session must stay read-only).
        ...(forkPack ? { pack: forkPack } : {}),
        identityManager: this.#identityManager,
        memory: this.#memory,
        memoryMcp: this.#memoryMcp,
mcpRegistry: this.#mcpRegistry,
mcpHub: this.#mcpHub,
        config: this.#config,
        compressionRegistry: this.#compressionRegistry,
        _testProvider: this.#testProviderFactory?.(),
        onStatusChange: this.#statusObserver,
        ...this.#modelHooks,
      });
      // A fork on the same (provider, model) as its parent runs the model the
      // parent already reported a window for. Adopting it before seeding is
      // what sizes the fork's history to the real window instead of the 200k
      // floor — forks never carry a model id, so the cache alone can't key it.
      fork.inheritObservedLimits(parent);
      await fork.primeFromFork(history, transcriptRows, sizeHints, workdirNote, {
        parentContextTokens: parent.lastContextTokens,
        redactedBackings: parent.redactedBackings,
      });
      // The inherited turns keep their ids, list entries and file snapshots
      // (#354) — and the snapshots survive the parent being destroyed.
      // Only turns the fork's history actually contains: the parent may have
      // started another while this fork was being built.
      const forkTurnIds = new Set(history.map((t) => t.turnId).filter(Boolean));
      const filesPoint = point?.files && "checkpointId" in point.files ? point.files.checkpointId : undefined;
      await fork.inheritTurns(
        parent,
        (point ? point.entries : parent.turnIndex).filter((e) => forkTurnIds.has(e.turnId)),
        filesPoint ? [filesPoint] : [],
      );
      // ...and the files as they were right after that turn — only in a
      // worktree codeoid made for this fork whose folder lines up with the
      // parent's, never in a shared or bound one.
      if (point?.files) {
        // What the fork's folder holds when its files aren't rolled.
        const asCheckedOut = forkFromHead
          ? `the files of commit \`${forkFromHead.slice(0, 10)}\` as committed (without that turn's uncommitted changes)`
          : "the parent's current files";
        let note: string;
        if ("unavailable" in point.files) {
          filesOutcome = "unavailable";
          note = `⚠️ This fork has the parent's current files: ${point.files.unavailable}.`;
        } else if (!worktree?.createdByCodeoid) {
          filesOutcome = "current";
          note = `⚠️ This fork shares or binds a working directory, so its files are the current ones, not those from right after prompt ${point.atTurn}.`;
        } else if (!forkSubdirMapped) {
          filesOutcome = "current";
          note = `⚠️ This fork's folder doesn't line up with the parent's, so its files weren't put back to right after prompt ${point.atTurn}; it has ${asCheckedOut}.`;
        } else {
          note = await fork
            .rollFilesTo(filesPoint!, { asEndOf: msg.afterTurnId!, within: worktree.path })
            .then(({ restored, removed }) => {
              filesOutcome = `rolled(${restored}/${removed})`;
              const files = point!.files as { late?: boolean };
              return `📂 Files are as they were right after prompt ${point!.atTurn} (${restored} restored, ${removed} removed)${
                forkFromHead
                  ? ""
                  : forkHeadGone
                    ? "; git history wasn't rolled back (the commit checked out back then no longer exists)"
                    : "; git history wasn't rolled back (no commit was recorded with that snapshot)"
              }${files.late ? "; that snapshot finished after the next prompt's agent had started, so it may include its first edits" : ""}.`;
            })
            .catch((err: unknown) => {
              filesOutcome = "failed";
              return `⚠️ The files couldn't be put back to right after prompt ${point!.atTurn} (${err instanceof Error ? err.message : String(err)}); this fork has ${asCheckedOut}.`;
            });
        }
        await fork.noteForkFiles(note);
      }
    } catch (err) {
      // Orphan cleanup: if building the fork failed after we created its
      // worktree, remove it so no dangling worktree + branch is left behind.
      if (worktree?.createdByCodeoid) {
        await removeForkWorktree({
          workdir: parent.workdir,
          worktreePath: worktree.path,
          branch: worktree.branch,
          deleteBranch: true,
        }).catch(() => {});
      }
      throw err;
    }

    this.#sessions.set(fork.id, fork);
    this.#rateLimiter.recordCreation(auth.sub);
    this.#store.audit(
      auth.sub,
      "session.fork",
      fork.id,
      `from=${msg.sessionId} provider=${providerId ?? "default"} turns=${history.length} worktree=${worktree?.branch ?? "shared"}${
        point ? ` after=${msg.afterTurnId} at=${point.atTurn} files=${filesOutcome}` : ""
      }`,
    );

    // Make the new worktree buildable in the background (fork stays cheap; the
    // fork's first turn waits for it). Only for worktrees WE created: the
    // repository's setup recipe first (its files, then its command when
    // trusted), then the operator's fork.setup command.
    if (worktree?.createdByCodeoid) {
      fork.beginWorktreePrepare(this.#config?.worktree?.setup);
      if (this.#config?.fork?.setup) fork.beginSetup(this.#config.fork.setup);
    }

    return { type: "response.ok", requestId: msg.id, data: fork.toInfo() };
  }

  /**
   * Create — or return — THE conductor session for the caller's tenant
   * (design §3, build plan P3). Idempotent: one conductor per
   * (account, project); a second create request answers with the existing
   * one so `codeoid attach conductor` works from any client without
   * coordination. The daemon chooses name/workdir/provider itself (from
   * config.conductor) — the request's name/workdir are ignored.
   */
  async #createConductor(
    msg: Extract<ClientMessage, { type: "session.create" }>,
    auth: AuthContext,
    rawToken?: string,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_CREATE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:create", code: "forbidden" };
    }
    if (this.#config?.conductor?.enabled === false) {
      return { type: "response.error", requestId: msg.id, error: "Conductor is disabled (config.conductor.enabled)", code: "invalid_request" };
    }

    const existing = this.#conductorFor(auth.accountId, auth.projectId);
    if (existing) {
      return { type: "response.ok", requestId: msg.id, data: existing.toInfo() };
    }

    const rateCheck = this.#rateLimiter.check(auth.sub, this.#liveSessionCountFor(auth.sub));
    if (!rateCheck.allowed) {
      return { type: "response.error", requestId: msg.id, error: rateCheck.reason, code: "rate_limited" };
    }

    // Durable identity (P2): reuse-or-register the conductor's ZeroID
    // identity, then mint its working token by OWNER delegation — the
    // caller's own bearer token is the RFC 8693 subject. Best-effort like
    // the rest of the identity layer: the conductor still runs without it.
    if (this.#identityManager) {
      const identity = await this.#identityManager.registerConductor(auth.sub);
      if (identity && rawToken) {
        const token = await this.#identityManager.mintConductorToken(rawToken);
        if (!token) {
          console.error(
            "[codeoid] owner->conductor delegation failed — conductor runs with metadata-only attribution (is session:read/session:dispatch in your token's scopes?)",
          );
        }
      }
    }

    // Re-check the singleton after the awaits above: two near-simultaneous
    // conductor creates for the same tenant both pass the first #conductorFor
    // check (neither has a session registered yet), then both await identity
    // work. Re-check now — the re-check → new Session → #sessions.set below
    // runs with no `await` between, so this closes the TOCTOU window and only
    // one conductor is ever registered per (account, project).
    const raced = this.#conductorFor(auth.accountId, auth.projectId);
    if (raced) {
      return { type: "response.ok", requestId: msg.id, data: raced.toInfo() };
    }

    // The conductor is global (cross-workspace), so it gets a dedicated,
    // daemon-owned empty workdir — NOT a repo, NOT ~ (protected-ancestor),
    // and crucially not a directory with a user .mcp.json to auto-load.
    const workdir = join(homedir(), ".codeoid-conductor");
    mkdirSync(workdir, { recursive: true });

    const conductorConfig = this.#config?.conductor;
    // Deliberately NOT session.defaultProvider: the conductor needs the fleet
    // MCP tools, which only the claude provider mounts today.
    const providerId = conductorConfig?.provider ?? CLAUDE_PROVIDER_ID;
    if (providerId !== CLAUDE_PROVIDER_ID) {
      console.warn(
        `[codeoid] conductor provider is "${providerId}" — MCP fleet tools are only surfaced by the claude provider today; the conductor will chat but cannot see the fleet`,
      );
    }

    const session = new Session({
      name: this.#conductorName(),
      workdir,
      role: "conductor",
      providerId,
      defaultModel: conductorConfig?.model,
      fleet: this.#buildFleetServer(auth.accountId, auth.projectId),
      auth,
      store: this.#store,
      transcriptStore: this.#transcriptStore,
      providers: this.#providers,
      claudeAccounts: this.#claudeAccounts,
      hooks: this.#hooks,
      identityManager: this.#identityManager,
      memory: this.#memory,
      memoryMcp: this.#memoryMcp,
mcpRegistry: this.#mcpRegistry,
mcpHub: this.#mcpHub,
      config: this.#config,
      compressionRegistry: this.#compressionRegistry,
      _testProvider: this.#testProviderFactory?.(),
      onStatusChange: this.#statusObserver,
      ...this.#modelHooks,
    });

    this.#sessions.set(session.id, session);
    this.#rateLimiter.recordCreation(auth.sub);
    this.#store.audit(
      this.#identityManager?.conductorUri ?? auth.sub,
      "conductor.session.created",
      session.id,
      `provider=${providerId}`,
    );

    return { type: "response.ok", requestId: msg.id, data: session.toInfo() };
  }

  /** The tenant's conductor session, if one is live. */
  /**
   * The live orchestrator a dispatch event belongs to, or undefined when that
   * collaboration is gone (destroyed, or outside this tenant).
   *
   * Tenant-checked even though the event row is already tenant-scoped: the goal
   * id comes out of a `created_by` string, and a string is not a permission.
   */
  #dispatchEventGoalTarget(
    goalId: string,
    accountId: string,
    projectId: string,
  ): Session | undefined {
    const goal = this.#sessions.get(goalId);
    if (!goal || goal.accountId !== accountId || goal.projectId !== projectId) {
      return undefined;
    }
    return goal;
  }

  /** The `<fleet_events>` injection body for one recipient's batch. */
  #fleetEventsBody(events: readonly DispatchEventRow[]): string {
    return [
      "<fleet_events>",
      "(daemon-injected dispatch notifications — NOT a message from the owner)",
      ...events.map((e) => `- [${e.type}] ${e.digest}`),
      "</fleet_events>",
      "",
      "Summarize these outcomes for the owner. Decide any follow-up dispatch yourself — it will require approval as usual.",
    ].join("\n");
  }

  #conductorFor(accountId: string, projectId: string): Session | undefined {
    for (const session of this.#sessions.values()) {
      if (
        session.role === "conductor" &&
        session.accountId === accountId &&
        session.projectId === projectId
      ) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Drive one SDLC pipeline phase as a turn on the run's BOUND session — the one
   * the user is attached to — instead of a headless worker. Applies the phase's
   * capability role (+ constitution + subagents) to the live session, refreshes
   * the autonomous turn budget, injects the phase prompt (streamed to attached
   * clients), and resolves when the session next rests. There is NO per-phase
   * timeout and the session is NOT torn down between phases. The phase runs
   * unattended (#348): nothing in it prompts — a skill command must be
   * pre-approved, and a question halts the phase. Satisfies the pipeline
   * package's PhaseTurnHost.
   *
   * `model` on the request is the phase's persisted binding
   * (docs/role-model-binding.md §3): it is applied to the bound session for
   * this phase's turn and restored after (finally-reliable, even on phase
   * failure). `provider` cannot be applied — a run drives ONE session with one
   * backend — so cross-provider bindings are already skipped at create
   * (#pipelineCreate → #bindModels); a mismatch reaching here (a run persisted
   * before that filter existed) is skipped with a warning, never transferred.
   */
  async runPhaseOnSession(req: {
    sessionId: string;
    prompt: string;
    provider?: string;
    model?: string;
    packId?: string;
    roleName?: string;
  }): Promise<PhaseTurnResult> {
    const session = this.#sessions.get(req.sessionId);
    if (!session) throw new Error(`pipeline bound session "${req.sessionId}" not found`);
    // Per-phase model binding: set the bound model for this phase's turn.
    // The restore happens in the finally below — even when the phase fails.
    let override: { prev: string | null; applied: string | null } | null = null;
    if (req.model !== undefined) {
      if (req.provider !== undefined && req.provider !== session.providerId) {
        // Only reachable for runs persisted before the create-time filter, or
        // a session resumed onto a different backend. Models don't transfer
        // across vendors — skip, don't guess.
        console.warn(
          `[pipeline] phase binding ${req.provider}:${req.model} does not match the run session's backend "${session.providerId}" — skipping (using the session's model)`,
        );
      } else {
        override = await session.overrideModel(req.model);
        if (!override) {
          console.warn(
            `[pipeline] phase model "${req.model}" is not valid for backend "${session.providerId}" — skipping (using the session's model)`,
          );
        }
      }
    }
    // Per-phase governance: apply this phase's role (+ constitution + subagents)
    // to the live session before its turn. resolvePhaseActivation fails CLOSED
    // when a declared role can't be applied (no silent escalation), SOFT otherwise.
    session.applyPhaseActivation(resolvePhaseActivation(this.#packs, req.packId, req.roleName));
    // Honesty: a capability role is only HARD-enforced (tool-deny) on backends
    // that route every tool through canUseTool under canonical names (claude).
    // Elsewhere the role is advisory — the constitution + role-contract system
    // prompt guide the model, but nothing hard-denies. Surface that, don't pretend.
    if (req.roleName && roleEnforcement(session.providerId) === "advisory") {
      console.warn(
        `[pipeline] phase role "${req.roleName}" is ADVISORY on backend "${session.providerId}" (soft prompt-contract only, no hard tool-deny — hard enforcement is claude-only)`,
      );
    }
    const auth = this.#dispatchSystemAuth(session.accountId, session.projectId);
    // Run the phase autonomously within the role (no per-tool prompt), with a
    // fresh generous budget each phase. The human gate is the phase boundary,
    // not each tool; the user can watch + interrupt; nothing times out.
    session.setMode("autonomous", PIPELINE_PHASE_MAX_TURNS, auth);
    // A phase is complete only when the model emits the completion marker — NOT
    // on the first `idle` (a turn rests whenever the model stops calling tools:
    // done, planning, or asking). On a bare rest we NUDGE it to continue rather
    // than halting the phase for review mid-work; after MAX_PHASE_NUDGES we hand
    // whatever it produced to the human boundary so a never-completing model
    // still reaches Approve/Reject instead of looping. A non-idle rest
    // (error / budget-exhausted) is a real phase failure, surfaced as-is.
    let pendingSend: string | null = `${req.prompt}\n${PHASE_COMPLETION_CONTRACT}`;
    // The model's last final text as of our most recent send. A phase may only
    // COMPLETE (or ask for input) on GENUINELY NEW final text — never on the
    // PRIOR phase's ⟦PHASE-COMPLETE⟧ that still sits in lastAssistantText (e.g.
    // behind a tools-only turn whose own text is empty). Without this, phase N
    // "completes" instantly by reading phase N-1's marker.
    let textAtSend = session.lastAssistantText ?? "";
    // Every NEW assistant text this phase produced, in order. The phase's
    // summary is the whole of what the model said across its turns, not only
    // the last one: a model that writes its report, rests without the marker,
    // is nudged, and answers with the bare marker would otherwise hand back an
    // empty summary — and a findings phase would lose its findings block.
    const produced: string[] = [];
    let lastProduced = textAtSend;
    const summary = (finalText: string): string => {
      if (produced.length === 0) return finalText;
      return produced
        .map((t) => stripPhaseCompleteMarker(stripNeedInputMarker(t)))
        .filter((t) => t.trim().length > 0)
        .join("\n\n");
    };
    let nudges = 0;
    let spurious = 0;
    // The phase runs unattended (#348): like `claude -p`, nothing in it may
    // prompt — a skill command must be pre-approved, and a question halts the
    // phase. Cleared in the finally, so a human chatting in this session
    // afterwards gets normal dialogs.
    const endUnattended = session.beginUnattended();
    try {
      while (true) {
        const done = new Promise<PhaseTurnResult["finalStatus"]>((resolve) => {
          this.#phaseWaiters.set(req.sessionId, resolve);
        });
        // Only (re)drive the turn when we have something to say — a spurious
        // rest below loops back with nothing pending, just awaiting the real turn.
        if (pendingSend !== null) {
          try {
            await session.send(pendingSend, auth);
          } catch (err) {
            // A Stop landed before the turn started: no turn will rest, so
            // don't wait for one — hand back like any interrupt.
            if (err instanceof SendStoppedError) return { finalStatus: "idle", text: "Stopped before the agent started on this phase." };
            throw err;
          }
          pendingSend = null;
          textAtSend = session.lastAssistantText ?? "";
        }
        const finalStatus = await done;
        // A failed turn usually leaves no assistant text, and lastAssistantText
        // would then be a PREVIOUS phase's output: report why it failed — e.g.
        // the "codeoid skill allow …" a blocked skill command names (#348).
        if (finalStatus === "error") {
          return { finalStatus, text: session.lastTurnError ?? summary(session.lastAssistantText ?? "") };
        }
        const text = session.lastAssistantText ?? "";
        // A non-idle rest (error / budget-exhausted) is a real phase failure.
        if (finalStatus !== "idle") return { finalStatus, text: summary(text) };
        // The user interrupted (Stop) — an interrupt leaves the session idle,
        // so without this we'd re-drive a nudge over the stop. Hand the partial
        // to the review boundary instead.
        if (session.turnInterrupted) return { finalStatus: "idle", text: summary(text) };
        // The model hasn't COMMITTED a turn in response to our prompt yet — the
        // last canonical turn is still our own USER prompt/nudge, which is where a
        // transient query-loop rebuild idle rests BEFORE the real turn runs. Don't
        // nudge or complete over it; wait for the model's turn (`assistant`).
        // Bounded by MAX_SPURIOUS_RESTS so a backend that never responds still
        // reaches the human boundary. Immune to history-length / user-turn commit
        // timing — the reason the earlier length watermark missed the rebuild idle.
        if (session.lastTurnRole !== "assistant") {
          if (++spurious > MAX_SPURIOUS_RESTS) return { finalStatus: "idle", text: summary(text) };
          continue;
        }
        spurious = 0;
        if (text !== lastProduced) {
          produced.push(text);
          lastProduced = text;
        }
        // Deliverable complete → done, marker stripped. Guarded on NEW text: a
        // phase can't "complete" by reading the PRIOR phase's marker still sitting
        // in lastAssistantText (behind a tools-only turn) — only its OWN output.
        if (text !== textAtSend && isPhaseComplete(text)) {
          return { finalStatus: "idle", text: summary(text) };
        }
        // The model needs the user's input. Surface the question as an input
        // dialog and feed the answer back as the next turn — a REAL answer is a
        // Guarded on NEW text, same as completion above — never a stale marker
        // from the prior phase. A phase runs unattended (#348): nobody is at a
        // keyboard to answer, so the phase halts on its question — answered
        // with revise, durably — rather than nudging the agent into guessing.
        if (text !== textAtSend && isNeedInput(text)) {
          return { finalStatus: "needs_input", text: stripNeedInputMarker(text) };
        }
        // Rested with new output but no marker (an intermediate pause). Nudge to
        // continue, bounded; after the cap, hand what it has to the human review
        // boundary so a never-completing model still reaches Approve/Reject.
        if (nudges >= MAX_PHASE_NUDGES) return { finalStatus: "idle", text: summary(text) };
        nudges += 1;
        pendingSend = PHASE_CONTINUE_NUDGE;
      }
    } finally {
      endUnattended();
      this.#phaseWaiters.delete(req.sessionId);
      // Restore the pre-phase model — reliable even on phase failure. Skipped
      // when the model changed underneath us (the user ran set_model mid-phase;
      // their explicit, persisted choice must win over our restore).
      if (override && session.model === override.applied) {
        try {
          await session.overrideModel(override.prev);
        } catch (err) {
          console.warn(
            `[pipeline] failed to restore model after phase: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /**
   * Create the durable, attachable session a pipeline run drives. Unlike the old
   * phase worker it is registered in #sessions (so any client can attach it),
   * streams status via #statusObserver, carries no pack at birth (each phase's
   * role is applied via applyPhaseActivation in runPhaseOnSession), and is never
   * auto-destroyed — the run's whole spec→ship conversation lives in it.
   */
  #createBoundRunSession(opts: {
    name: string;
    workdir: string;
    provider?: string;
    model?: string;
    auth: AuthContext;
  }): Session {
    const session = new Session({
      name: opts.name,
      workdir: opts.workdir,
      providerId: opts.provider,
      defaultModel: opts.model,
      auth: opts.auth,
      store: this.#store,
      transcriptStore: this.#transcriptStore,
      providers: this.#providers,
      claudeAccounts: this.#claudeAccounts,
      hooks: this.#hooks,
      identityManager: this.#identityManager,
      memory: this.#memory,
      memoryMcp: this.#memoryMcp,
      mcpRegistry: this.#mcpRegistry,
      mcpHub: this.#mcpHub,
      config: this.#config,
      compressionRegistry: this.#compressionRegistry,
      _testProvider: this.#testProviderFactory?.(),
      onStatusChange: this.#statusObserver,
      ...this.#modelHooks,
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  // ── SDLC pipeline handlers (docs/sdlc-pipeline.md) ─────────────────────

  /** Scope check + pipeline-enabled check shared by every pipeline handler. */
  #pipelineGuard(
    reqId: string,
    auth: AuthContext,
    scope: Scope,
  ): { pm: PipelineManager } | { error: DaemonMessage } {
    if (!hasScope(auth.scopes as string[], scope)) {
      return {
        error: { type: "response.error", requestId: reqId, error: `Missing scope: ${scope}`, code: "forbidden" },
      };
    }
    const pm = this.#pipelines;
    if (!pm) {
      return {
        error: { type: "response.error", requestId: reqId, error: "Pipeline is disabled", code: "invalid_request" },
      };
    }
    return { pm };
  }

  /** Tenant-scoped lookup — the manager doesn't tenancy-check, so callers must. */
  #ownedPipeline(pm: PipelineManager, id: string, auth: AuthContext): PipelineState | undefined {
    const s = pm.get(id);
    if (!s || s.accountId !== auth.accountId || s.projectId !== auth.projectId) return undefined;
    return s;
  }

  #pipelineError(reqId: string, e: unknown): DaemonMessage {
    return {
      type: "response.error",
      requestId: reqId,
      error: e instanceof Error ? e.message : String(e),
      code: "invalid_request",
    };
  }

  /** Project the daemon-owned PipelineState onto the serializable wire shape. */
  #pipelineToWire(s: PipelineState): PipelineWire {
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      cursor: s.cursor,
      spec: s.spec,
      workdir: s.workdir,
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      phases: s.phases.map((p) => {
        const st = p.state;
        const w: PipelinePhaseWire = { id: p.def.id, name: p.def.name, role: p.def.role, status: st.status };
        // The persisted model binding (docs/role-model-binding.md §3) — clients
        // render provider/model + the precedence rung that chose them.
        if (p.def.provider !== undefined) w.provider = p.def.provider;
        if (p.def.model !== undefined) w.model = p.def.model;
        if (p.def.resolvedFrom !== undefined) w.resolvedFrom = p.def.resolvedFrom;
        if (st.status === "passed") w.summary = st.summary;
        else if (st.status === "failed") w.reason = st.reason;
        else if (st.status === "skipped") w.reason = st.reason;
        else if (st.status === "halted") {
          w.requestId = st.requestId;
          w.reason = st.reason;
          w.questions = st.questions;
          // Surface the phase's produced output at the boundary halt so the UI
          // can show "here's what this phase did" next to Approve/Revise/Reject.
          if (p.lastSummary) w.summary = p.lastSummary;
        }
        // Evidence whatever the status — a failed phase is where it matters most.
        if (p.evidence?.length) w.evidence = [...p.evidence];
        if (p.feedback && p.feedback.length > 0) w.feedback = p.feedback;
        // The findings loop (findings.ts): counts + the ledger, so a client can
        // render "2 open (1 blocking), 1 fix leg" and the per-round table.
        if (p.def.findings && p.findings) {
          const open = openFindings(p.findings);
          w.findings = {
            rounds: p.findings.rounds.length,
            fixLegs: p.findings.fixLegs,
            open: open.length,
            blocking: blockingOf(open, p.def.findings.blocking).length,
            next: p.findings.next,
            ledger: renderLedger(p.findings, p.def.findings),
          };
        }
        return w;
      }),
    };
  }

  async #pipelineCreate(
    msg: Extract<ClientMessage, { type: "pipeline.create" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_CREATE);
    if ("error" in g) return g.error;
    // Fail fast at create (like session.create): a usable workdir + known
    // per-phase provider — otherwise the failure only surfaces at run time.
    // Normalize ONCE and persist the canonical path: the command-gate cwd and
    // the phase-turn workdir must agree (a raw "~/repo" or relative path would
    // validate but then break the gate's Bun.spawn cwd).
    let workdir = msg.workdir;
    if (msg.workdir !== undefined) {
      const normalized = normalizeWorkdir(msg.workdir);
      if (!normalized) {
        return { type: "response.error", requestId: msg.id, error: `workdir not usable: ${msg.workdir}`, code: "invalid_request" };
      }
      workdir = normalized;
    }
    // Resolve the plan: explicit `pack`, else explicit `phases`, else the
    // configured default pack. `phases` XOR `pack` is enforced in create().
    const defaultPack = this.#config?.pipeline?.defaultPack ?? undefined;
    const pack = msg.pack ?? (msg.phases === undefined ? defaultPack : undefined);
    const providerIds = this.#providers.ids();
    if (msg.providerId && !providerIds.includes(msg.providerId)) {
      return { type: "response.error", requestId: msg.id, error: `unknown provider "${msg.providerId}"`, code: "invalid_request" };
    }
    for (const p of msg.phases ?? []) {
      if (p.provider && !providerIds.includes(p.provider)) {
        return { type: "response.error", requestId: msg.id, error: `phase "${p.id}": unknown provider "${p.provider}"`, code: "invalid_request" };
      }
    }
    // Role bindings name a known backend or fail here (§5): the provider
    // registry is enumerable, unlike model ids (those pass through and fail at
    // the phase's session spawn, where the error names the binding's rung).
    for (const [roleName, b] of Object.entries(msg.roleBindings ?? {})) {
      if (!providerIds.includes(b.provider)) {
        return { type: "response.error", requestId: msg.id, error: `role "${roleName}": unknown provider "${b.provider}"`, code: "invalid_request" };
      }
    }
    // A run is a conductor over a live, attached session (docs/pipeline-run.md):
    // create the bound run-session up front so its phases stream into a real
    // session the client can attach. Created before pm.create so its id is part
    // of the run; torn down if create validation fails (no orphan session).
    const runSession = this.#createBoundRunSession({
      name: msg.name,
      workdir: workdir ?? process.cwd(),
      provider: msg.providerId,
      auth,
    });
    try {
      // Binding warnings (skipped cross-provider bindings, unmapped tiers) go
      // to the daemon log AND back to the creating client on the snapshot —
      // a warning only the daemon console sees is one the operator never sees.
      const warnings: string[] = [];
      const state = g.pm.create({
        name: msg.name,
        phases: msg.phases,
        pack,
        sessionId: runSession.id,
        spec: msg.spec,
        workdir,
        accountId: auth.accountId,
        projectId: auth.projectId,
        createdBy: auth.sub,
        roleBindings: msg.roleBindings,
        // The operator's model maps, read once here — the manager persists the
        // resolved binding per phase (docs/role-model-binding.md §3).
        modelConfig: {
          modelTiers: this.#config?.pipeline?.modelTiers,
          modelRoles: this.#config?.pipeline?.modelRoles,
        },
        // The run drives ONE session on this backend — a resolved binding
        // naming any other provider is skipped at create, not persisted (§3).
        sessionProvider: runSession.providerId,
        warn: (m) => {
          warnings.push(m);
          console.warn(`[pipeline] ${m}`);
        },
      });
      return {
        type: "pipeline.snapshot",
        requestId: msg.id,
        pipeline: this.#pipelineToWire(state),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (e) {
      this.#sessions.delete(runSession.id);
      try {
        await runSession.destroy(this.#dispatchSystemAuth(auth.accountId, auth.projectId));
      } catch {
        // Best-effort teardown of the orphan session.
      }
      return this.#pipelineError(msg.id, e);
    }
  }

  #pipelineList(msg: Extract<ClientMessage, { type: "pipeline.list" }>, auth: AuthContext): DaemonMessage {
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_READ);
    if ("error" in g) return g.error;
    const pipelines = g.pm.list(auth.accountId, auth.projectId).map((s) => this.#pipelineToWire(s));
    return { type: "pipeline.list.result", requestId: msg.id, pipelines };
  }

  /**
   * One evidence record. Authorized through its owner: a pipeline's evidence
   * needs `pipeline:read` and a pipeline the caller can see. Anything the caller
   * may not read is `not_found`, so an id reveals nothing across tenants.
   */
  #evidenceGet(msg: Extract<ClientMessage, { type: "evidence.get" }>, auth: AuthContext): DaemonMessage {
    const notFound: DaemonMessage = { type: "response.error", requestId: msg.id, error: "Evidence not found", code: "not_found" };
    // Authorize before looking anything up, so whether an id exists is never
    // the difference between two answers.
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_READ);
    if ("error" in g) return g.error;
    const record = this.#evidence?.get(msg.evidenceId, { accountId: auth.accountId, projectId: auth.projectId });
    if (!record) return notFound;
    if (record.ownerKind === "pipeline") {
      if (!this.#ownedPipeline(g.pm, record.ownerId, auth)) return notFound;
    } else {
      // Loop evidence is authorized by the loop service, which doesn't exist
      // yet; until it does, nothing else may read it.
      return notFound;
    }
    return { type: "evidence.record", requestId: msg.id, evidence: evidenceToWire(record) };
  }

  #pipelineGet(msg: Extract<ClientMessage, { type: "pipeline.get" }>, auth: AuthContext): DaemonMessage {
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_READ);
    if ("error" in g) return g.error;
    const s = this.#ownedPipeline(g.pm, msg.pipelineId, auth);
    if (!s) return { type: "response.error", requestId: msg.id, error: "Pipeline not found", code: "not_found" };
    return { type: "pipeline.snapshot", requestId: msg.id, pipeline: this.#pipelineToWire(s) };
  }

  async #pipelineAnswer(
    msg: Extract<ClientMessage, { type: "pipeline.answer" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_ANSWER);
    if ("error" in g) return g.error;
    if (!this.#ownedPipeline(g.pm, msg.pipelineId, auth)) {
      return { type: "response.error", requestId: msg.id, error: "Pipeline not found", code: "not_found" };
    }
    try {
      const next = await g.pm.answer(msg.pipelineId, msg.requestId, {
        approved: msg.approved,
        value: msg.value,
      });
      return { type: "pipeline.snapshot", requestId: msg.id, pipeline: this.#pipelineToWire(next) };
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  /** Revise a halted phase: re-run it with the human's feedback (the
   *  Approve / Revise / Reject loop — docs/pipeline-run.md). */
  async #pipelineRevise(
    msg: Extract<ClientMessage, { type: "pipeline.revise" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_ANSWER);
    if ("error" in g) return g.error;
    if (!this.#ownedPipeline(g.pm, msg.pipelineId, auth)) {
      return { type: "response.error", requestId: msg.id, error: "Pipeline not found", code: "not_found" };
    }
    try {
      const next = await g.pm.revise(msg.pipelineId, msg.requestId, msg.feedback);
      return { type: "pipeline.snapshot", requestId: msg.id, pipeline: this.#pipelineToWire(next) };
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  /** Advance a pipeline until it halts or reaches a terminal status. */
  async #pipelineAdvance(
    msg: Extract<ClientMessage, { type: "pipeline.advance" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_CREATE);
    if ("error" in g) return g.error;
    if (!this.#ownedPipeline(g.pm, msg.pipelineId, auth)) {
      return { type: "response.error", requestId: msg.id, error: "Pipeline not found", code: "not_found" };
    }
    try {
      const next = await g.pm.advance(msg.pipelineId);
      return { type: "pipeline.snapshot", requestId: msg.id, pipeline: this.#pipelineToWire(next) };
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  async #pipelineAbort(
    msg: Extract<ClientMessage, { type: "pipeline.abort" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const g = this.#pipelineGuard(msg.id, auth, SCOPES.PIPELINE_CREATE);
    if ("error" in g) return g.error;
    const s = this.#ownedPipeline(g.pm, msg.pipelineId, auth);
    if (!s) return { type: "response.error", requestId: msg.id, error: "Pipeline not found", code: "not_found" };
    // Stop its running checks first: abort waits behind the in-flight step,
    // and that step may be a long test run.
    this.#evidence?.abortOwner("pipeline", msg.pipelineId);
    const next = (await g.pm.abort(msg.pipelineId)) ?? s;
    return { type: "pipeline.snapshot", requestId: msg.id, pipeline: this.#pipelineToWire(next) };
  }

  // ── Pack management (dynamic pack loading — docs/pack-loading.md) ───────

  /** The full pack state reply — returned by list AND every mutating verb so a
   *  client always receives the refreshed state. */
  #packListResult(reqId: string): DaemonMessage {
    const snap = this.#packs.snapshot();
    return { type: "pipeline.pack.list.result", requestId: reqId, ...snap };
  }

  #packList(msg: Extract<ClientMessage, { type: "pipeline.pack.list" }>, auth: AuthContext): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.PIPELINE_READ)) {
      return { type: "response.error", requestId: msg.id, error: `Missing scope: ${SCOPES.PIPELINE_READ}`, code: "forbidden" };
    }
    return this.#packListResult(msg.id);
  }

  /** Guard for the mutating pack verbs — owner-tier `pipeline:manage` (these
   *  rewrite config.json + toggle host command-gate execution). */
  #packManageGuard(reqId: string, auth: AuthContext): DaemonMessage | undefined {
    if (!hasScope(auth.scopes as string[], SCOPES.PIPELINE_MANAGE)) {
      return { type: "response.error", requestId: reqId, error: `Missing scope: ${SCOPES.PIPELINE_MANAGE}`, code: "forbidden" };
    }
    return undefined;
  }

  async #registryAdd(
    msg: Extract<ClientMessage, { type: "pipeline.registry.add" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const denied = this.#packManageGuard(msg.id, auth);
    if (denied) return denied;
    try {
      await this.#packs.addRegistry({ url: msg.url, name: msg.name, ref: msg.ref });
      return this.#packListResult(msg.id);
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  async #registryRefresh(
    msg: Extract<ClientMessage, { type: "pipeline.registry.refresh" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const denied = this.#packManageGuard(msg.id, auth);
    if (denied) return denied;
    try {
      await this.#packs.refreshRegistry(msg.name);
      return this.#packListResult(msg.id);
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  #packInstall(msg: Extract<ClientMessage, { type: "pipeline.pack.install" }>, auth: AuthContext): DaemonMessage {
    const denied = this.#packManageGuard(msg.id, auth);
    if (denied) return denied;
    try {
      this.#packs.install({ packId: msg.packId, dir: msg.dir, trusted: msg.trusted });
      return this.#packListResult(msg.id);
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  #packRemove(msg: Extract<ClientMessage, { type: "pipeline.pack.remove" }>, auth: AuthContext): DaemonMessage {
    const denied = this.#packManageGuard(msg.id, auth);
    if (denied) return denied;
    try {
      this.#packs.remove(msg.packId);
      return this.#packListResult(msg.id);
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  #packTrust(msg: Extract<ClientMessage, { type: "pipeline.pack.trust" }>, auth: AuthContext): DaemonMessage {
    const denied = this.#packManageGuard(msg.id, auth);
    if (denied) return denied;
    try {
      this.#packs.trust(msg.packId, msg.trusted);
      return this.#packListResult(msg.id);
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  #packSelect(msg: Extract<ClientMessage, { type: "pipeline.pack.select" }>, auth: AuthContext): DaemonMessage {
    const denied = this.#packManageGuard(msg.id, auth);
    if (denied) return denied;
    try {
      this.#packs.select(msg.packId);
      return this.#packListResult(msg.id);
    } catch (e) {
      return this.#pipelineError(msg.id, e);
    }
  }

  // ── Dispatcher host (P4) ──────────────────────────────────────────────

  /** System principal for dispatcher-driven session operations. */
  #dispatchSystemAuth(accountId: string, projectId: string): AuthContext {
    return {
      sub: "system:dispatch",
      scopes: [],
      delegationDepth: 0,
      accountId,
      projectId,
    };
  }

  /** Principal a dispatched prompt is SENT as — attributed to the conductor. */
  #dispatchSenderAuth(task: DispatchTaskRow): AuthContext {
    return {
      sub: task.createdBy,
      scopes: [],
      delegationDepth: 1,
      accountId: task.accountId,
      projectId: task.projectId,
    };
  }

  /** A tenant-scoped session lookup that treats cross-tenant ids as absent. */
  #sessionForTask(id: string | null, task: DispatchTaskRow): Session | undefined {
    if (!id) return undefined;
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    if (session.accountId !== task.accountId || session.projectId !== task.projectId) {
      return undefined;
    }
    return session;
  }

  /** Complete, self-contained brief for a freshly-spawned worker. */
  #workerBrief(task: DispatchTaskRow): string {
    const contract =
      task.shape === "scout"
        ? "Investigate and report. Do NOT modify files, commit, or push — your identity holds no write scope and your report is the only deliverable."
        : "Deliver the change described below. Keep the diff minimal and verify your work before finishing.";
    return [
      `<fleet_dispatch task="${task.id}" shape="${task.shape}">`,
      `You are a disposable ${task.shape} worker spawned by the codeoid conductor with the owner's approval.`,
      contract,
      `Work only inside ${task.workdir}. You run unattended on a bounded tool budget — be economical.`,
      "End your final message with a concise summary of what you found/changed: it becomes the digest reported back to the conductor.",
      "</fleet_dispatch>",
      "",
      task.prompt,
    ].join("\n");
  }

  // ── Routines (docs/routines.md) ─────────────────────────────────────────

  /**
   * One entry point for routine.*: availability, scopes, and tenancy are
   * decided here once, then each verb runs against RoutineService.
   *
   * No scope of its own. Every verb but preview needs session:create +
   * session:send — a routine creates and prompts sessions on its owner's
   * behalf, so only someone who could do that themselves may hold one, and
   * read-only watchers can't read its definition or history. Changing anything
   * is refused to delegated tokens (teammates' share tokens, agents): a
   * routine is standing authority that outlives them. Saving,
   * firing, re-tokening or resuming a routine that pre-approves (autonomous)
   * or runs host commands (a check) also needs session:approve; pausing never
   * does. A routine is its owner's alone: anyone else gets not-found.
   */
  async #routineHandle(
    msg: Extract<ClientMessage, { type: `routine.${string}` }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const err = (error: string, code: "forbidden" | "not_found" | "invalid_request" | "rate_limited" | "internal"): DaemonMessage => ({
      type: "response.error",
      requestId: msg.id,
      error,
      code,
    });
    const svc = this.#routines;
    if (!svc) return err("routines are disabled on this daemon (routines.enabled)", "invalid_request");
    const scopes = auth.scopes as string[];
    if (msg.type === "routine.preview") {
      if (!hasScope(scopes, SCOPES.SESSION_LIST)) return err("Missing scope: session:list", "forbidden");
    } else {
      // A routine creates and prompts sessions, so holding one takes what
      // doing that takes. Its prompt, check, check output and payloads are
      // therefore out of a read-only watcher's reach, reading included.
      for (const sc of [SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND] as const) {
        if (!hasScope(scopes, sc)) return err(`Missing scope: ${sc}`, "forbidden");
      }
      const reads = msg.type === "routine.list" || msg.type === "routine.get" || msg.type === "routine.runs";
      if (!reads) {
        // A routine is standing authority that outlives the token that made
        // it; a delegated token (an agent acting for someone) is meant to be
        // narrow and short-lived, so it may not create or steer one.
        if ((auth.delegationDepth ?? 0) > 0) {
          return err("a delegated token cannot change routines — use the owner's own credential", "forbidden");
        }
      }
    }
    /** Autonomy or a host command needs the approval scope as well. */
    const needsApprove = (spec: { approvals?: string | null; check?: unknown } | undefined, current?: RoutineRow): boolean => {
      const approvals = spec?.approvals !== undefined ? spec.approvals : current?.spec.approvals;
      const check = spec && "check" in spec ? spec.check : current?.spec.check;
      return (approvals ?? "autonomous") === "autonomous" || !!check;
    };
    // A routine is its owner's alone: its runs act as them, so nobody else in
    // the tenant may read, steer, fire, or delete it. Others get "not found".
    const mine = (r: RoutineRow | null | undefined): r is RoutineRow =>
      !!r && r.accountId === auth.accountId && r.projectId === auth.projectId && r.ownerSub === auth.sub;
    const resolve = (ref: string): RoutineRow | undefined => {
      const byId = svc.store.getRoutine(ref);
      if (mine(byId)) return byId;
      const byName = svc.store.getRoutineByName(auth.accountId, auth.projectId, auth.sub, ref);
      return mine(byName) ? byName : undefined;
    };
    const wire = (r: RoutineRow) =>
      toRoutineWire(r, {
        upcoming: svc.upcoming(r, 3),
        lastRun: svc.store.listRuns(r.id, { limit: 1 })[0],
        apiTokenSet: svc.store.hasApiToken(r.id),
      });
    const actor = auth.sub;
    try {
      switch (msg.type) {
        case "routine.list":
          return {
            type: "routine.list.result",
            requestId: msg.id,
            routines: svc.store.listRoutines(auth.accountId, auth.projectId, auth.sub).map(wire),
          };
        case "routine.preview":
          return { type: "routine.preview.result", requestId: msg.id, fires: svc.preview(msg.schedule, msg.count ?? 5) };
        case "routine.create": {
          if (needsApprove(msg.spec) && !hasScope(scopes, SCOPES.SESSION_APPROVE)) {
            return err("Missing scope: session:approve (an autonomous routine, or one with a check command, pre-approves work)", "forbidden");
          }
          const { routine, apiToken } = svc.create(
            { sub: auth.sub, name: auth.name, accountId: auth.accountId, projectId: auth.projectId },
            msg.spec,
          );
          return { type: "routine.snapshot", requestId: msg.id, routine: wire(routine), ...(apiToken ? { apiToken } : {}) };
        }
      }
      // Everything below names one routine (or one run).
      if (msg.type === "routine.cancel_run") {
        const run = svc.store.getRun(msg.runId);
        if (!run || !mine(svc.store.getRoutine(run.routineId))) return err("Run not found", "not_found");
        if (!svc.cancelRun(run, actor)) return err(`run is already ${run.status}`, "invalid_request");
        return { type: "response.ok", requestId: msg.id };
      }
      const r = resolve(msg.routine);
      if (!r) return err(`Routine not found: ${msg.routine}`, "not_found");
      switch (msg.type) {
        case "routine.get":
          return {
            type: "routine.snapshot",
            requestId: msg.id,
            routine: wire(r),
            runs: svc.store.listRuns(r.id, { limit: msg.runs ?? 10 }).map(toRunWire),
          };
        case "routine.runs": {
          if (msg.runId !== undefined) {
            const one = svc.store.getRun(msg.runId);
            const runs = one && one.routineId === r.id ? [toRunWire(one)] : [];
            return { type: "routine.runs.result", requestId: msg.id, routineId: r.id, runs, hasMore: false };
          }
          const before = msg.before !== undefined ? Date.parse(msg.before) : undefined;
          if (before !== undefined && Number.isNaN(before)) return err(`before is not a timestamp: ${msg.before}`, "invalid_request");
          const limit = msg.limit ?? 20;
          const runs = svc.store.listRuns(r.id, { limit: limit + 1, before });
          return {
            type: "routine.runs.result",
            requestId: msg.id,
            routineId: r.id,
            runs: runs.slice(0, limit).map(toRunWire),
            hasMore: runs.length > limit,
          };
        }
        case "routine.update": {
          // Pausing is a safety stop: any credential that can manage the
          // routine may pull it, whatever the routine pre-approves.
          const pauseOnly = msg.spec === undefined && msg.enabled === false;
          if (!pauseOnly && needsApprove(msg.spec as { approvals?: string | null; check?: unknown } | undefined, r) && !hasScope(scopes, SCOPES.SESSION_APPROVE)) {
            return err("Missing scope: session:approve (an autonomous routine, or one with a check command, pre-approves work)", "forbidden");
          }
          const { routine, apiToken } = svc.update(
            r,
            { ...(msg.spec ? { spec: msg.spec as Parameters<RoutineService["update"]>[1]["spec"] } : {}), ...(msg.enabled !== undefined ? { enabled: msg.enabled } : {}) },
            actor,
          );
          return { type: "routine.snapshot", requestId: msg.id, routine: wire(routine), ...(apiToken ? { apiToken } : {}) };
        }
        case "routine.delete":
          await svc.delete(r, actor);
          return { type: "response.ok", requestId: msg.id };
        case "routine.run": {
          // Firing an autonomous routine, or one with a check, starts
          // pre-approved work; it needs what saving it needed.
          if (needsApprove(undefined, r) && !hasScope(scopes, SCOPES.SESSION_APPROVE)) {
            return err("Missing scope: session:approve (this routine pre-approves work)", "forbidden");
          }
          const run = svc.fire(r, "manual", msg.payload ?? null, actor);
          return { type: "routine.run.result", requestId: msg.id, run: toRunWire(run) };
        }
        case "routine.token": {
          if (needsApprove(undefined, r) && !hasScope(scopes, SCOPES.SESSION_APPROVE)) {
            return err("Missing scope: session:approve (this routine pre-approves work)", "forbidden");
          }
          const apiToken = svc.rotateToken(r, actor);
          return {
            type: "routine.token.result",
            requestId: msg.id,
            routineId: r.id,
            apiToken,
            endpointPath: routineFirePath(r.id),
          };
        }
      }
      return err("Unknown routine message", "invalid_request");
    } catch (e) {
      if (e instanceof RoutineError) {
        return err(e.message, e.code === "conflict" ? "invalid_request" : e.code);
      }
      return err(e instanceof Error ? e.message : String(e), "internal");
    }
  }

  /** The routine engine's window onto sessions (RoutineHost). */
  #makeRoutineHost(): RoutineHost {
    const systemAuth = (accountId: string, projectId: string): AuthContext => ({
      sub: "system:routines",
      scopes: [],
      delegationDepth: 0,
      accountId,
      projectId,
    });
    return {
      createSession: async (o) => {
        let workdir = o.workdir;
        let worktree: SessionWorktree | undefined;
        let setup: WorktreeSetupResult | undefined;
        if (o.worktree) {
          if (!(await isGitRepo(o.workdir))) throw new Error(`worktree isolation needs a git repository: ${o.workdir}`);
          const wt = await createForkWorktree({ workdir: o.workdir, label: o.label, shortId: randomUUID().slice(0, 8) });
          workdir = normalizeWorkdir(wt.workdir) ?? wt.path;
          worktree = { path: wt.path, branch: wt.branch, createdByCodeoid: true };
          // A routine run is unattended: prepare before the agent starts, and
          // fail the run as an infrastructure error (not the agent's) when
          // the worktree can't be made ready. Nothing but this run's fresh
          // worktree is removed — the primary checkout is never touched.
          setup = await prepareWorktree({ worktreePath: wt.path, policy: this.#config?.worktree?.setup });
          if (setup.error) {
            await removeForkWorktree({ workdir: o.workdir, worktreePath: wt.path, branch: wt.branch, deleteBranch: true }).catch(() => {});
            throw new WorktreeSetupFailure(setup);
          }
          if (setup.copied.length > 0 || setup.shared.length > 0) {
            worktree = { ...worktree, setup: { copied: setup.copied, shared: setup.shared } };
          }
        }
        const session = new Session({
          // The conductor's name is reserved for the singleton.
          name: o.name === this.#conductorName() ? `${o.name}-routine` : o.name,
          workdir,
          ...(worktree ? { worktree } : {}),
          providerId: o.provider,
          defaultModel: o.model,
          initialMode: o.approvals === "autonomous" ? { mode: "autonomous", maxTurns: o.toolBudget } : { mode: "guarded" },
          ...(o.maxCostUsd !== undefined ? { maxBudgetUsd: o.maxCostUsd } : {}),
          auth: o.ownerAuth,
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          providers: this.#providers,
          claudeAccounts: this.#claudeAccounts,
          hooks: this.#hooks,
          identityManager: this.#identityManager,
          memory: this.#memory,
          memoryMcp: this.#memoryMcp,
          mcpRegistry: this.#mcpRegistry,
          mcpHub: this.#mcpHub,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
          _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
          ...this.#modelHooks,
        });
        if (setup) session.noteWorktreePrepared(setup);
        this.#sessions.set(session.id, session);
        return session.id;
      },
      sessionAlive: (id, accountId, projectId) => {
        const s = this.#sessions.get(id);
        return !!s && s.accountId === accountId && s.projectId === projectId;
      },
      disarm: (id) => {
        const s = this.#sessions.get(id);
        if (s?.mode === "autonomous") s.setMode("guarded");
      },
      defaultProviderId: () => this.#providers.defaultId,
      armSession: (id, approvals, toolBudget) => {
        this.#sessions.get(id)?.setMode(approvals === "autonomous" ? "autonomous" : "guarded", toolBudget);
      },
      send: async (id, text, sender) => {
        const s = this.#sessions.get(id);
        if (!s) throw new Error("session not found");
        await s.send(text, sender);
      },
      info: (id) => {
        const s = this.#sessions.get(id);
        if (!s) return null;
        const i = s.toInfo();
        const parked = i.status === "waiting_approval" ? s.pendingToolApprovals()[0] : undefined;
        return {
          status: i.status,
          turnQueued: i.turnQueued === true,
          waitingOn: i.pendingDialog
            ? `waiting on a question: ${i.pendingDialog.title}`
            : parked
              ? `waiting for approval to run ${parked.toolName}`
              : null,
          costUsd: i.usage?.totalCostUsd ?? 0,
          // usage.inputTokens is uncached input only (Anthropic semantics);
          // a run reports everything the model read.
          inputTokens: (i.usage?.inputTokens ?? 0) + (i.usage?.cacheReadTokens ?? 0) + (i.usage?.cacheCreationTokens ?? 0),
          outputTokens: i.usage?.outputTokens ?? 0,
          attachedClients: s.attachedClientCount,
          lastTurnId: s.lastTurnId,
        };
      },
      result: (id, sinceTurnId) => {
        const s = this.#sessions.get(id);
        if (!s) return { text: null, error: null };
        const answered = s.lastTurnRole === "assistant" && s.lastTurnId !== null && s.lastTurnId !== sinceTurnId;
        return { text: answered ? s.lastAssistantMessage : null, error: s.lastTurnError };
      },
      beginUnattended: (id) => this.#sessions.get(id)?.beginUnattended() ?? (() => {}),
      interrupt: async (id) => {
        const s = this.#sessions.get(id);
        if (s) await s.interrupt(systemAuth(s.accountId, s.projectId));
      },
      destroy: async (id) => {
        const s = this.#sessions.get(id);
        if (!s) return;
        await s.destroy(systemAuth(s.accountId, s.projectId));
        this.#forgetComparesOf(id);
        this.#forgetCompareBranch(id);
        this.#sessions.delete(id);
      },
      runFinished: (e) => {
        const r = e.routine;
        const sessionId = e.run.sessionId;
        // Content-blind push needs a session to open; a run that never
        // started an agent reaches the owner through hooks and its history.
        if (e.push && sessionId && this.#pushService.enabled) {
          void this.#pushService
            .notifyRoutine(sessionId, { sub: r.ownerSub, accountId: r.accountId, projectId: r.projectId })
            .catch((err) => console.error("[codeoid/push] routine notify failed:", err));
        }
        const s = sessionId ? this.#sessions.get(sessionId) : undefined;
        this.#hooks?.emit(
          "routine_end",
          {
            sessionId: sessionId ?? "",
            sessionName: s?.name ?? r.spec.name,
            workdir: s?.workdir ?? r.spec.workdir,
            providerId: s?.toInfo().providerId ?? r.spec.provider ?? "",
          },
          { routine: { id: r.id, name: r.spec.name, paused: !r.enabled, pausedReason: r.pausedReason }, run: toRunWire(e.run), paused: e.paused, notify: e.push },
        );
      },
      audit: (subject, action, sessionId, detail) => this.#store.audit(subject, action, sessionId, detail),
      hasProvider: (id) => this.#providers.has(id),
      providerIds: () => this.#providers.ids(),
      normalizeWorkdir: (p) => normalizeWorkdir(p),
    };
  }

  #makeDispatcherHost(): DispatcherHost {
    return {
      sendToSession: async (task: DispatchTaskRow): Promise<void> => {
        const target = this.#sessionForTask(task.targetSession, task);
        if (!target) {
          throw new NonRetryableDispatchError(
            `target session ${task.targetSession ?? "?"} no longer exists`,
          );
        }
        // Re-arm a collaboration child's autonomous budget on every dispatch.
        // A child is long-lived across the whole goal (unlike a disposable
        // spawn worker), so one initial budget is spent down across successive
        // dispatches and the child would silently wedge at waiting_approval
        // partway through — with nobody attached to approve. Same reasoning as
        // continueWorker re-arming after a restart; the approval that
        // authorizes this work already happened at the R3 dispatch gate.
        if (target.collaborationRole) {
          target.setMode("autonomous", this.#dispatcher.config.workerToolBudget);
        }
        await target.send(
          `[conductor dispatch ${task.id.slice(0, 8)} — owner-approved]\n\n${task.prompt}`,
          this.#dispatchSenderAuth(task),
        );
      },

      spawnWorker: async (task: DispatchTaskRow): Promise<{ sessionId: string }> => {
        // Re-validate at execution time — the directory can vanish between
        // approval and claim, and that's a permanent failure, not a retry.
        const workdir = task.workdir ? normalizeWorkdir(task.workdir) : null;
        if (!workdir) {
          throw new NonRetryableDispatchError(
            `workdir not usable: ${task.workdir ?? "(none)"}`,
          );
        }
        // Same reasoning for the backend: the task was validated when queued,
        // but the registry is rebuilt at startup and gates backends on their
        // env keys / binaries, so a task that outlived a restart can name a
        // provider that no longer exists. ProviderRegistry.resolve() would
        // quietly fall back to claude and we'd run the worker on the wrong
        // vendor while reporting success — fail the task instead.
        if (task.provider && !this.#providers.has(task.provider)) {
          throw new NonRetryableDispatchError(
            `provider "${task.provider}" is not registered on this daemon — available: ${this.#providers.ids().join(", ")}`,
          );
        }
        const budget = this.#dispatcher.config.workerToolBudget;
        const session = new Session({
          name: `worker-${task.shape}-${task.id.slice(0, 8)}`,
          workdir,
          role: "worker",
          workerShape: task.shape,
          // Per-role backend (P0). NULL provider = daemon default, which is
          // the pre-collaboration behaviour. `defaultModel` is resolved
          // provider-aware inside Session, so a Claude alias inherited from
          // config.session.defaultModel cannot ride onto another vendor.
          providerId: task.provider ?? undefined,
          defaultModel: task.model ?? undefined,
          // Autonomous with a bounded budget: unattended until the budget
          // exhausts, then guarded → waiting_approval, which the dispatcher
          // treats as a wedge (lease stops renewing, reclaim handles it).
          initialMode: { mode: "autonomous", maxTurns: budget },
          auth: this.#dispatchSenderAuth(task),
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          providers: this.#providers,
          claudeAccounts: this.#claudeAccounts,
          hooks: this.#hooks,
          identityManager: this.#identityManager,
          memory: this.#memory,
          memoryMcp: this.#memoryMcp,
mcpRegistry: this.#mcpRegistry,
mcpHub: this.#mcpHub,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
          _testProvider: this.#testProviderFactory?.(),
          onStatusChange: this.#statusObserver,
          ...this.#modelHooks,
        });
        this.#sessions.set(session.id, session);
        // No rate-limiter charge: the dispatcher's own worker cap governs
        // spawn concurrency, and the human never called session.create.
        try {
          await session.send(this.#workerBrief(task), this.#dispatchSenderAuth(task));
        } catch (err) {
          // Partial spawn: the session exists but never got its brief. Tear
          // it down before rethrowing — the dispatcher only learns the
          // worker's id from our return value, so an early throw would
          // otherwise orphan it.
          try {
            await session.destroy(
              this.#dispatchSystemAuth(task.accountId, task.projectId),
            );
          } catch {
            // Best-effort cleanup.
          }
          this.#sessions.delete(session.id);
          throw err;
        }
        return { sessionId: session.id };
      },

      continueWorker: async (task: DispatchTaskRow): Promise<boolean> => {
        const worker = this.#sessionForTask(task.workerSessionId, task);
        if (!worker) return false;
        // Mode isn't persisted across restarts — re-arm the autonomous
        // budget before continuing or the resumed worker wedges immediately.
        worker.setMode("autonomous", this.#dispatcher.config.workerToolBudget);
        const note = [
          `<fleet_dispatch task="${task.id}" continuation="true">`,
          `The daemon restarted while you were working (attempt ${task.attempts + 1} of ${task.failureLimit}).`,
          `Review the current state of ${worker.workdir} — your earlier progress may be partially applied — and CONTINUE the original task below to completion.`,
          "</fleet_dispatch>",
          "",
          task.prompt,
        ].join("\n");
        await worker.send(note, this.#dispatchSenderAuth(task));
        return true;
      },

      workerStatus: (sessionId: string) => this.#sessions.get(sessionId)?.status ?? null,

      buildWorkerDigest: (task: DispatchTaskRow): string => {
        const worker = this.#sessionForTask(task.workerSessionId, task);
        const header = `task ${task.id.slice(0, 8)} (${task.kind}/${task.shape}) in ${task.workdir ?? task.targetSession ?? "?"}`;
        if (!worker) return `${header} — worker session unavailable; check the workdir/git state for artifacts.`;
        const parts: string[] = [header];
        const finalText = worker.lastAssistantText;
        if (finalText) {
          const trimmed = finalText.trim();
          parts.push(
            `Worker's final message${trimmed.length > 700 ? " (truncated)" : ""}:`,
            trimmed.slice(0, 700),
          );
        } else {
          parts.push("(worker produced no final message)");
        }
        if (this.#memory) {
          const episodes = this.#memory
            .timeline(worker.workspaceId, 60)
            .filter((e) => e.sessionId === worker.id)
            .slice(0, 8);
          if (episodes.length > 0) {
            parts.push(
              "Activity:",
              ...episodes.map(
                (e) => `- ${e.kind}${e.toolName ? `/${e.toolName}` : ""}: ${e.summary}`,
              ),
            );
          }
        }
        return parts.join("\n");
      },

      destroyWorker: async (sessionId: string, reason: string): Promise<void> => {
        const worker = this.#sessions.get(sessionId);
        if (!worker || worker.role !== "worker") return;
        try {
          await worker.destroy(
            this.#dispatchSystemAuth(worker.accountId, worker.projectId),
          );
        } catch (err) {
          console.error(
            `[codeoid/dispatch] worker teardown failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // A collaboration child is role:"worker", so it can reach this path.
        // Revoke before dropping, same reason as the destroy handler.
        this.#revokeBlackboardToken(sessionId);
        this.#sessions.delete(sessionId);
      },

      deliverEvents: async (
        accountId: string,
        projectId: string,
        events: DispatchEventRow[],
      ): Promise<readonly number[]> => {
        // Route each event to the session that DISPATCHED it, not to the
        // conductor unconditionally. A collaboration orchestrator queues its own
        // tasks (fleet_send / fleet_panel) and needs their results to close its
        // coordination loop; sending them to the conductor meant the orchestrator
        // never learned its panel had joined, and with no conductor on the daemon
        // at all — the common case, since one is only created on explicit
        // request — the events were simply undeliverable and retried forever.
        const conductor = this.#conductorFor(accountId, projectId);
        const batches = new Map<Session, DispatchEventRow[]>();
        const undeliverable: number[] = [];

        for (const e of events) {
          const task = this.#store.dispatchGet(e.taskId);
          const goalId = task ? goalIdFromCreatedBy(task.createdBy) : undefined;
          const target = goalId
            ? this.#dispatchEventGoalTarget(goalId, accountId, projectId)
            : conductor;
          if (!target) {
            // An orchestrator whose goal is gone has nothing to come back to,
            // so its events are retired rather than retried forever. A missing
            // CONDUCTOR is different — it may yet be created, so those stay
            // pending (target is undefined only for a resolved-but-dead goal).
            if (goalId) undeliverable.push(e.id);
            continue;
          }
          const batch = batches.get(target);
          if (batch) batch.push(e);
          else batches.set(target, [e]);
        }

        const delivered: number[] = [...undeliverable];
        for (const [session, batch] of batches) {
          // Hold until the recipient is idle — events are durable, and
          // interrupting a mid-turn session would corrupt its work. One batched
          // injection per recipient: N completions = one wake.
          if (session.status !== "idle") continue;
          try {
            await session.send(
              this.#fleetEventsBody(batch),
              this.#dispatchSystemAuth(accountId, projectId),
            );
          } catch (err) {
            // Stopped before its turn started: not delivered — retried on the
            // next tick. Other recipients' deliveries still count.
            if (err instanceof SendStoppedError) continue;
            throw err;
          }
          delivered.push(...batch.map((e) => e.id));
        }
        if (undeliverable.length > 0) {
          this.#store.audit(
            "system:dispatch",
            "dispatch.events_retired",
            undefined,
            `${undeliverable.length} event(s) dropped — their originating collaboration no longer exists`,
          );
        }
        return delivered;
      },

      audit: (action: string, detail: string): void => {
        this.#store.audit("system:dispatch", action, undefined, detail);
      },

      onBoardChange: (): void => {
        this.#flushFleetDeltas();
      },
    };
  }

  // ── Fleet board (docs/conductor-frontends-design.md §11) ──────────────────

  /**
   * Emit deltas to every fleet subscriber whose tenant board moved.
   *
   * Per-tenant watermarks rather than one global cursor: two tenants share a
   * daemon and a dispatcher tick, so a global cursor would let one tenant's
   * activity advance past another's unread rows and silently starve its board.
   *
   * Cheap when idle — with no subscribers it does not touch the database at
   * all, which matters because the dispatcher calls this on every tick.
   */
  #flushFleetDeltas(): void {
    if (this.#fleetSubscribers.size === 0) return;

    // Distinct tenants currently being watched.
    const tenants = new Map<string, { accountId: string; projectId: string }>();
    for (const sub of this.#fleetSubscribers.values()) {
      tenants.set(tenantKey(sub.accountId, sub.projectId), {
        accountId: sub.accountId,
        projectId: sub.projectId,
      });
    }

    for (const [key, { accountId, projectId }] of tenants) {
      const mark = this.#fleetWatermarks.get(key);
      // No watermark means nobody has taken a snapshot for this tenant yet, so
      // there is no baseline to diff against. Skip rather than replay the whole
      // board as "changes".
      if (!mark) continue;

      // Inclusive query (nothing dropped) minus what was already delivered at
      // exactly the boundary millisecond (nothing repeated). See FleetWatermark.
      const tasks = this.#store
        .dispatchTasksUpdatedSince(accountId, projectId, mark.taskUpdatedAt)
        .filter((t) => !(t.updatedAt === mark.taskUpdatedAt && mark.sentAtWatermark.has(t.id)));
      const events = this.#store.dispatchEventsSince(accountId, projectId, mark.eventId);
      if (tasks.length === 0 && events.length === 0) continue;

      // Recompute the rollup ONCE per tenant and attach it to each delta, so a
      // client's counters stay consistent with the rows it just received
      // without issuing a follow-up read.
      const agg = this.#fleetUsage(accountId, projectId);

      for (const task of tasks) {
        this.#sendToFleetSubscribers(accountId, projectId, {
          type: "fleet.update",
          delta: { kind: "task", task: toFleetTaskWire(task), agg },
        });
      }
      advanceWatermark(mark, tasks);
      for (const event of events) {
        this.#sendToFleetSubscribers(accountId, projectId, {
          type: "fleet.update",
          delta: { kind: "event", event: toFleetEventWire(event), agg },
        });
        if (event.id > mark.eventId) mark.eventId = event.id;
      }
    }
  }

  #sendToFleetSubscribers(accountId: string, projectId: string, msg: DaemonMessage): void {
    for (const sub of this.#fleetSubscribers.values()) {
      if (sub.accountId !== accountId || sub.projectId !== projectId) continue;
      try {
        sub.client.send(msg);
      } catch {
        /* client may have disconnected mid-broadcast; disconnectClient reaps it */
      }
    }
  }

  /** Task-status + cost rollup for the tenant's board. */
  #fleetUsage(accountId: string, projectId: string): FleetUsage {
    const counts = this.#store.dispatchStatusCounts(accountId, projectId);
    let inputTokens = 0;
    let outputTokens = 0;
    let totalCostUsd = 0;
    for (const session of this.#sessions.values()) {
      if (session.accountId !== accountId || session.projectId !== projectId) continue;
      const usage = session.toInfo().usage;
      if (!usage) continue;
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
      totalCostUsd += usage.totalCostUsd ?? 0;
    }
    return {
      activeTasks: counts.active,
      blockedTasks: counts.blocked,
      inputTokens,
      outputTokens,
      totalCostUsd,
    };
  }

  /**
   * Snapshot + subscribe. Replies with the whole board and starts streaming
   * deltas; the watermark is taken from the snapshot so no change can slip
   * through the gap between the two.
   */
  #fleetSubscribe(
    msg: Extract<ClientMessage, { type: "fleet.subscribe" }>,
    auth: AuthContext,
    client: AttachedClient,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.FLEET_READ)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: fleet:read",
        code: "forbidden",
      };
    }

    const { accountId, projectId } = auth;
    const taskRows = this.#store.dispatchListForTenant(accountId, projectId, FLEET_TASK_LIMIT);
    const eventRows = this.#store.dispatchEventsRecent(accountId, projectId, FLEET_EVENT_LIMIT);

    // Sessions the board references — spawned workers AND existing sessions a
    // send was routed to — plus the conductor. Full SessionInfo so a node
    // renders with status/usage/backend without duplicating them onto the task.
    const referenced = new Set<string>();
    for (const t of taskRows) {
      if (t.workerSessionId) referenced.add(t.workerSessionId);
      if (t.targetSession) referenced.add(t.targetSession);
    }
    let conductor: SessionInfo | undefined;
    const workers: SessionInfo[] = [];
    for (const session of this.#sessions.values()) {
      if (session.accountId !== accountId || session.projectId !== projectId) continue;
      const info = { ...session.toInfo(), attachedClients: session.attachedClientCount };
      if (info.role === "conductor") conductor = info;
      if (referenced.has(session.id)) workers.push(info);
    }

    // Watermark BEFORE registering: taken from the rows just read, so a task
    // that moves between this read and the subscriber landing in the map is
    // still picked up by the next flush rather than being skipped.
    const mark: FleetWatermark = {
      taskUpdatedAt: 0,
      sentAtWatermark: new Set(),
      eventId: eventRows.reduce((max, e) => (e.id > max ? e.id : max), 0),
    };
    // Seeded from the very rows this snapshot ships, so the first delta flush
    // neither replays them nor skips a task that shares their millisecond.
    advanceWatermark(mark, taskRows);
    this.#fleetWatermarks.set(tenantKey(accountId, projectId), mark);
    this.#fleetSubscribers.set(client.id, { client, accountId, projectId });

    return {
      type: "fleet.snapshot.result",
      requestId: msg.id,
      fleet: {
        conductor,
        workers,
        tasks: taskRows.map(toFleetTaskWire),
        events: eventRows.map(toFleetEventWire),
        agg: this.#fleetUsage(accountId, projectId),
      },
    };
  }

  #fleetUnsubscribe(
    msg: Extract<ClientMessage, { type: "fleet.unsubscribe" }>,
    client: AttachedClient,
  ): DaemonMessage {
    // Deliberately not scope-gated: dropping your own subscription is never a
    // privileged act, and a token that lost fleet:read mid-connection must
    // still be able to stop the stream.
    this.#fleetSubscribers.delete(client.id);
    return { type: "response.ok", requestId: msg.id };
  }

  /**
   * Build the codeoid_fleet MCP server for a tenant's conductor. Tools close
   * over the manager, so the conductor always sees the LIVE session
   * population — tenant-scoped exactly like session.list.
   */
  #buildFleetServer(accountId: string, projectId: string) {
    return buildFleetMcpServer(this.#conductorFleetDeps(accountId, projectId));
  }

  /** The conductor's tenant-wide deps. Extracted from `#buildFleetServer` so a
   *  test can compare them against the orchestrator's scoped ones. */
  #conductorFleetDeps(accountId: string, projectId: string): FleetDeps {
    return {
      tenant: { accountId, projectId },
      listSessions: (): FleetSessionView[] => {
        const views: FleetSessionView[] = [];
        for (const s of this.#sessions.values()) {
          if (s.accountId !== accountId || s.projectId !== projectId) continue;
          views.push({
            id: s.id,
            name: s.name,
            workdir: s.workdir,
            workspaceId: s.workspaceId,
            status: s.status,
            role: s.role,
            providerId: s.providerId,
            model: s.toInfo().model,
            attachedClients: s.attachedClientCount,
            createdAt: s.createdAt,
          });
        }
        return views;
      },
      memory: this.#memory,
      audit: (action, detail) =>
        this.#store.audit(
          this.#identityManager?.conductorUri ?? `conductor:${accountId}/${projectId}`,
          action,
          undefined,
          detail,
        ),
      conductorSessionId: () =>
        this.#conductorFor(accountId, projectId)?.id ?? "",
      // Send-class dispatch (P4). Every one of these tools is approval-gated
      // upstream (kept out of allowedTools + the hard #shouldAutoApprove
      // gate) — by the time a handler runs, the owner has confirmed.
      dispatch:
        this.#config?.dispatch?.enabled === false
          ? undefined
          : this._fleetDispatchDeps(accountId, projectId),
    };
  }

  /**
   * The send-class capability surface handed to the conductor's fleet tools.
   * Underscore-public so tests can exercise the real closures without an MCP
   * transport (the tool wiring itself is covered in fleet.test.ts).
   */
  _fleetDispatchDeps(accountId: string, projectId: string): FleetDispatchDeps {
    return {
      enqueue: (input) =>
        this.#dispatcher.enqueue({
          ...input,
          accountId,
          projectId,
          createdBy:
            this.#identityManager?.conductorUri ??
            `conductor:${accountId}/${projectId}`,
        }),
      interrupt: async (sessionId: string) => {
        const session = this.#sessions.get(sessionId);
        if (
          !session ||
          session.accountId !== accountId ||
          session.projectId !== projectId
        ) {
          throw new Error("target session no longer exists");
        }
        await session.interrupt(this.#dispatchSystemAuth(accountId, projectId));
      },
      checkWorkdir: (path: string) => normalizeWorkdir(path),
      resolveBackend: (provider?: string, model?: string) => {
        // Fail closed on an unknown provider — same rule and same wording as
        // session.create / fork / set_provider. Rejecting here (pre-queue)
        // means the conductor can correct itself in the same turn; letting it
        // through would only fail at claim time and burn a task attempt.
        if (provider !== undefined && !this.#providers.has(provider)) {
          return {
            ok: false,
            error: `Unknown provider "${provider}" — available: ${this.#providers.ids().join(", ")}`,
          };
        }
        if (model === undefined) return { ok: true, provider };
        // Canonicalize the model against THIS provider's catalog when we have
        // one — that turns a display name ("Opus") into the value the backend
        // expects, and stops a Claude alias riding onto another vendor.
        //
        // It does NOT reject unknown models, and deliberately so: models.ts
        // sets the house policy ("the live backend is the real validator —
        // refusing an unknown-but-valid value here is worse than letting the
        // SDK reject a genuine typo"), because our cached catalog goes stale
        // the moment a vendor ships a point release. So a typo reaches the
        // backend and fails there with the vendor's own message.
        //
        // An earlier version chained `resolveAgainstList(...) ?? resolveModel-
        // IdForProvider(...)`, which read as strict validation but could never
        // reject anything — the fallback's last branch returns the input
        // unchanged. The dead branch is gone; only the real rule remains.
        const providerId = provider ?? this.#providers.defaultId;
        const { models } = this.#currentModels(providerId);
        const canonical =
          models.length > 0 ? resolveAgainstList(model, models) : null;
        const resolved = canonical ?? resolveModelIdForProvider(model, providerId);
        if (!resolved) {
          // Reachable only for a Claude-shaped model on a non-Claude backend.
          return {
            ok: false,
            error: `Model "${model}" is not valid for provider "${providerId}". Omit \`model\` to use the provider's default.`,
          };
        }
        // Pin the backend the model was validated against. Left unset, the
        // task would spawn on whatever the default is at CLAIM time — after a
        // default change and restart, a codex model on a claude worker.
        return { ok: true, provider: providerId, model: resolved };
      },
      enqueuePanel: (input) =>
        this.#dispatcher.enqueueGroup({
          accountId,
          projectId,
          createdBy:
            this.#identityManager?.conductorUri ??
            `conductor:${accountId}/${projectId}`,
          prompt: input.prompt,
          members: input.targets.map((targetSession) => ({
            kind: "send" as const,
            shape: input.shape,
            targetSession,
          })),
        }),
      listTasks: (limit: number): FleetTaskView[] =>
        this.#store
          .dispatchListForTenant(accountId, projectId, limit)
          .map((t) => ({
            id: t.id,
            kind: t.kind,
            shape: t.shape,
            status: t.status,
            attempts: t.attempts,
            target: t.targetSession ?? t.workdir,
            createdAt: t.createdAt,
            error: t.error,
            resultDigest: t.resultDigest,
          })),
    };
  }

  /**
   * The COLLABORATION ORCHESTRATOR's fleet surface — role-aware delegation
   * (docs/collaborative-session-design.md line 142).
   *
   * The design has always called for this and it was never wired: `#create`
   * passed `fleet` only for `role: "conductor"`, while `compileGoalPack` told
   * the orchestrator "Direct them with the fleet tools." It was instructed to
   * use tools it did not have.
   *
   * The conductor's own server could not simply be reused. It is ONE
   * deliberate, per-tenant privileged session; collaborations are user-created
   * and many, so handing an orchestrator `#buildFleetServer` would let any of
   * them direct every session in the tenant. Everything here is therefore
   * scoped to the goal's own children, and the scoping lives in the DEPS — not
   * in the tool descriptions — so a future caller of these closures cannot get
   * an unscoped view by asking differently. Same doctrine as the blackboard
   * service.
   *
   * `goalId` is a thunk because the orchestrator's session id is generated
   * inside its own constructor, and the server has to be passed IN to that
   * constructor. Tool handlers only run during a turn, long after the id
   * exists.
   */
  #buildOrchestratorFleetServer(
    goalId: () => string,
    accountId: string,
    projectId: string,
  ) {
    return buildFleetMcpServer(this.#orchestratorFleetDeps(goalId, accountId, projectId), {
      tools: ORCHESTRATOR_FLEET_TOOLS,
    });
  }

  /**
   * Underscore-public so tests can exercise the REAL closures — the scoping
   * here is a security boundary, and asserting it through the MCP transport
   * would test the transport instead. Mirrors `_fleetDispatchDeps`.
   */
  _orchestratorFleetDepsForTest(
    goalId: string,
    accountId: string,
    projectId: string,
  ): FleetDeps {
    return this.#orchestratorFleetDeps(() => goalId, accountId, projectId);
  }

  /**
   * The CONDUCTOR's deps — tests only, and paired with the orchestrator
   * accessor above so the two surfaces can be asserted differentially. An
   * "the orchestrator doesn't get X" test proves nothing unless something in
   * the same run shows X was actually available to give.
   */
  _fleetDepsForTest(accountId: string, projectId: string): FleetDeps {
    return this.#conductorFleetDeps(accountId, projectId);
  }

  #orchestratorFleetDeps(
    goalId: () => string,
    accountId: string,
    projectId: string,
  ): FleetDeps {
    /** This goal's live children — the orchestrator's entire visible world. */
    const children = (): Session[] => {
      const parentId = goalId();
      const out: Session[] = [];
      for (const s of this.#sessions.values()) {
        if (
          s.collaborationRole?.parentSessionId === parentId &&
          s.accountId === accountId &&
          s.projectId === projectId
        ) {
          out.push(s);
        }
      }
      return out;
    };
    /** Attribution for this goal's dispatches — stable across restarts, since
     *  it keys off the goal id rather than any per-boot identity. */
    const createdBy = () => orchestratorCreatedBy(goalId());

    return {
        tenant: { accountId, projectId },
        listSessions: (): FleetSessionView[] =>
          children().map((s) => ({
            id: s.id,
            name: s.name,
            workdir: s.workdir,
            workspaceId: s.workspaceId,
            status: s.status,
            role: s.role,
            providerId: s.providerId,
            model: s.toInfo().model,
            attachedClients: s.attachedClientCount,
            createdAt: s.createdAt,
          })),
        // No memory engine on purpose — see ORCHESTRATOR_FLEET_TOOLS. The
        // memory-backed tools are excluded from the set AND would fail closed
        // if one were ever added back.
        audit: (action, detail) =>
          this.#store.audit(createdBy(), action, goalId(), detail),
        // Excluded from fleet_find results; harmless here since that tool isn't
        // exposed, but the deps must still be complete.
        conductorSessionId: () => goalId(),
        dispatch:
          this.#config?.dispatch?.enabled === false
            ? undefined
            : this.#orchestratorDispatchDeps(children, createdBy, accountId, projectId),
    };
  }

  /**
   * Send-class dispatch for an orchestrator, restricted to its own children.
   *
   * Every method re-resolves the child set at call time rather than closing
   * over a snapshot: a goal's children can be torn down mid-turn, and a stale
   * snapshot would let a dispatch land on a session that no longer belongs to
   * this goal.
   */
  #orchestratorDispatchDeps(
    children: () => Session[],
    createdBy: () => string,
    accountId: string,
    projectId: string,
  ): FleetDispatchDeps {
    const tenant = this._fleetDispatchDeps(accountId, projectId);
    /** A child of THIS goal, by id — the only legal dispatch target. */
    const ownChild = (sessionId: string): Session | undefined =>
      children().find((c) => c.id === sessionId);

    return {
      ...tenant,
      enqueue: (input) => {
        // §2 fixes a goal's role bindings for its whole life, and the roster is
        // what the tenant-wide live-children cap counts. An orchestrator that
        // could spawn would grow its fleet past a bound the owner set.
        if (input.kind === "spawn") {
          throw new Error(
            "An orchestrator cannot spawn workers — its roster is fixed for the life of the goal. Direct one of its existing role-children instead.",
          );
        }
        if (!input.targetSession || !ownChild(input.targetSession)) {
          throw new Error(
            "Target is not a role-child of this collaboration. You can only direct your own fleet; use fleet_list to see it.",
          );
        }
        // Straight to the dispatcher, NOT through `tenant.enqueue` — that
        // closure stamps the CONDUCTOR's `createdBy`, which would both
        // misattribute the task and defeat the `listTasks` filter below (the
        // orchestrator would see the whole tenant board again). `createdBy` is
        // not part of the FleetDispatchDeps contract, so there is no way to
        // override it from the outside; going direct is the honest path.
        return this.#dispatcher.enqueue({
          ...input,
          accountId,
          projectId,
          createdBy: createdBy(),
        });
      },
      interrupt: async (sessionId: string) => {
        if (!ownChild(sessionId)) {
          throw new Error("Target is not a role-child of this collaboration.");
        }
        await tenant.interrupt(sessionId);
      },
      // A panel is N sends, so it carries the same scoping as one — every
      // target must be this goal's own child. Checked here in the DEPS, not in
      // the tool's target resolution, so the fence holds even though
      // `listSessions()` already only shows its own fleet.
      enqueuePanel: (input) => {
        const stranger = input.targets.find((id) => !ownChild(id));
        if (stranger) {
          throw new Error(
            "Panel targets must all be role-children of this collaboration. Use fleet_list to see your fleet.",
          );
        }
        return this.#dispatcher.enqueueGroup({
          accountId,
          projectId,
          createdBy: createdBy(),
          prompt: input.prompt,
          members: input.targets.map((targetSession) => ({
            kind: "send" as const,
            shape: input.shape,
            targetSession,
          })),
        });
      },
      // Only this goal's own dispatches. The tenant board would show every
      // other session's targets and result digests — the one place the scoping
      // above would otherwise leak.
      listTasks: (limit: number): FleetTaskView[] =>
        this.#store
          .dispatchListForTenant(accountId, projectId, limit, createdBy())
          .map((t) => ({
            id: t.id,
            kind: t.kind,
            shape: t.shape,
            status: t.status,
            attempts: t.attempts,
            target: t.targetSession ?? t.workdir,
            createdAt: t.createdAt,
            error: t.error,
            resultDigest: t.resultDigest,
          })),
    };
  }

  #list(
    msg: Extract<ClientMessage, { type: "session.list" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:list", code: "forbidden" };
    }

    const sessions: SessionInfo[] = [];
    const piloted = this.#pipelineDrivenSessionIds(auth.accountId, auth.projectId);
    const routineRuns = new Set(this.#routines?.activeRunSessionIds(auth.accountId, auth.projectId) ?? []);
    for (const session of this.#sessions.values()) {
      // Tenancy filter — never enumerate sessions belonging to a
      // different account/project. Same shape as #getOwnedSession.
      if (
        session.accountId !== auth.accountId ||
        session.projectId !== auth.projectId
      ) {
        continue;
      }
      const info = session.toInfo();
      sessions.push({
        ...info,
        attachedClients: session.attachedClientCount,
        ...(piloted.has(session.id)
          ? { managedBy: "pipeline" as const }
          : routineRuns.has(session.id)
            ? { managedBy: "routine" as const }
            : {}),
      });
    }

    return { type: "session.list.result", requestId: msg.id, sessions };
  }

  /**
   * Sessions a live (non-terminal) pipeline run is driving in this tenant —
   * `SessionInfo.managedBy`. Read from the pipeline store rather than flagged on
   * the Session, so it survives a daemon restart (pipelines rehydrate; sessions
   * resume as plain ones) and clears itself when the run ends.
   */
  #pipelineDrivenSessionIds(accountId: string, projectId: string): Set<string> {
    return new Set(this.#pipelines?.activeSessionIds(accountId, projectId) ?? []);
  }

  #attach(
    msg: Extract<ClientMessage, { type: "session.attach" }>,
    auth: AuthContext,
    client: AttachedClient,
  ): DaemonMessage {
    const scope = hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH)
      || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
    if (!scope) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    session.attach(client, msg.resume);
    return { type: "response.ok", requestId: msg.id, data: session.toInfo() };
  }

  /**
   * What a session's tool calls are parked on (#349), with the exact input
   * each would run — the one-shot `codeoid approve` reads this instead of
   * attaching. Same read authority as attach: a parked call's input is
   * session content (a Bash command, a Write body).
   */
  #sessionApprovals(
    msg: Extract<ClientMessage, { type: "session.approvals" }>,
    auth: AuthContext,
  ): DaemonMessage {
    const scope = hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH)
      || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
    if (!scope) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    return { type: "session.approvals.result", requestId: msg.id, sessionId: session.id, approvals: session.pendingToolApprovals() };
  }

  /** A session's turns (#354) — same read authority as attach. */
  async #sessionTurns(
    msg: Extract<ClientMessage, { type: "session.turns" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const scope = hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH)
      || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
    if (!scope) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const { turns, checkpointsSupported } = await session.turns();
    return { type: "session.turns.result", requestId: msg.id, sessionId: session.id, turns, checkpointsSupported };
  }

  // ── Side-by-side comparisons (#357) ────────────────────────────────────
  //
  // Pure orchestration over existing primitives — N × session.fork (each its
  // own worktree and backend/model, optionally from an earlier turn), then the
  // same prompt to each — so it works with every backend. The record lives in
  // the store. While a branch's compared turn runs, its live status comes from
  // its session; when that turn settles, what it did (reply, files, cost,
  // time — of that turn alone) is frozen into the record, so carrying on in a
  // branch later never changes the comparison.

  /** Comparisons with a branch not yet settled, by id: the one copy every update goes through. */
  #liveCompares = new Map<string, CompareRunRow>();
  /** Branch session → its live comparison, to freeze its result when it settles. */
  #compareBranchOf = new Map<string, string>();
  /** Branches whose result is being frozen right now (between leaving #compareBranchOf and saving). */
  #compareSettling = new Set<string>();

  async #sessionCompare(
    msg: Extract<ClientMessage, { type: "session.compare" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const refuse = (error: string, code: ErrorCode = "invalid_request"): DaemonMessage => ({ type: "response.error", requestId: msg.id, error, code });
    for (const scope of [SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND]) {
      if (!hasScope(auth.scopes as string[], scope)) return refuse(`Missing scope: ${scope}`, "forbidden");
    }
    const parent = this.#getOwnedSession(msg.sessionId, auth);
    if (!parent) return refuse("Session not found", "not_found");
    if (parent.role) return refuse(`Cannot compare from a ${parent.role} session`);
    // Every branch must start from the same conversation and files.
    if (parent.status === "thinking" || parent.status === "tool_running" || parent.status === "waiting_approval") {
      return refuse("The session is working — compare once it's done, so every branch starts from the same point.");
    }
    const unknown = msg.targets.find((t) => !this.#providers.has(t.providerId));
    if (unknown) return refuse(`Unknown provider "${unknown.providerId}" — available: ${this.#providers.ids().join(", ")}`);
    // A model id, never a flag or control text (it can reach a backend CLI's argv).
    const badModel = msg.targets.find(
      (t) =>
        t.model !== undefined &&
        (!/^[\w.:/@+][\w.:/@+-]*$/.test(t.model) || t.model.includes("..") || resolveModelIdForProvider(t.model, t.providerId) === null),
    );
    if (badModel) return refuse(`Model "${badModel.model}" isn't available on ${badModel.providerId}`);
    // Agents sharing one folder would edit each other's files.
    if (!(await isGitRepo(parent.workdir))) {
      return refuse("Compare needs a git repository: each branch runs in its own worktree, so they can't edit each other's files.");
    }
    const label = (t: { providerId: string; model?: string }) => `${t.providerId}${t.model ? `:${t.model}` : ""}`;

    // Fork every branch first (one at a time: forks share the parent's
    // worktree setup and rate limiter); any failure rolls back the ones made.
    const targets: CompareRunRow["targets"] = [];
    const created: Session[] = [];
    try {
      for (const spec of msg.targets) {
        const forked = await this.#fork(
          {
            type: "session.fork",
            id: msg.id,
            sessionId: parent.id,
            providerId: spec.providerId,
            name: `${parent.name} ⚖ ${label(spec)}`.slice(0, LIMITS.NAME_MAX),
            ...(msg.afterTurnId ? { afterTurnId: msg.afterTurnId } : {}),
          },
          auth,
        );
        if (forked.type !== "response.ok") {
          throw new CompareAbort(`${label(spec)}: ${forked.type === "response.error" ? forked.error : "could not create the branch"}`);
        }
        const session = this.#sessions.get((forked.data as { id: string }).id)!;
        created.push(session);
        if (!session.toInfo().worktree?.createdByCodeoid) {
          throw new CompareAbort(`${label(spec)}: it couldn't get its own git worktree, so the branches would edit each other's files`);
        }
        if (spec.model) {
          const applied = await session.overrideModel(spec.model);
          if (!applied) throw new CompareAbort(`model "${spec.model}" isn't available on ${spec.providerId}`);
          try {
            this.#store.setSessionModel(session.id, applied.applied, null);
          } catch {
            // in-memory model governs this lifetime
          }
        }
        targets.push({ providerId: spec.providerId, ...(spec.model ? { model: spec.model } : {}), sessionId: session.id });
      }
    } catch (err) {
      // Roll back what this request made — no half-made comparison left behind.
      for (const s of created) {
        await s.destroy(auth, { deleteBranch: true }).catch(() => {});
        this.#sessions.delete(s.id);
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.#store.audit(auth.sub, "session.compare.failed", parent.id, `targets=${msg.targets.map(label).join(",")} reason=${reason.slice(0, 200)}`);
      return refuse(`Couldn't start the comparison — ${reason}`, err instanceof CompareAbort ? "invalid_request" : "internal");
    }

    const row: CompareRunRow = {
      id: randomUUID(),
      accountId: parent.accountId,
      projectId: parent.projectId,
      parentSessionId: parent.id,
      ...(msg.afterTurnId ? { afterTurnId: msg.afterTurnId } : {}),
      prompt: msg.prompt,
      targets,
      createdBy: auth.sub,
      createdAt: new Date().toISOString(),
    };
    this.#liveCompares.set(row.id, row);
    for (const t of targets) this.#compareBranchOf.set(t.sessionId!, row.id);
    this.#store.saveCompareRun(row);
    this.#store.audit(auth.sub, "session.compare", parent.id, `compare=${row.id} targets=${targets.map(label).join(",")}`);

    // Start every branch at once, and answer now: a send can wait on a fork's
    // setup and its snapshot, longer than a client waits for a reply.
    for (const t of targets) {
      const session = this.#sessions.get(t.sessionId!)!;
      session.send(msg.prompt, auth).then(
        () => {
          t.baseTurnId = session.turnIndex.at(-1)?.turnId;
          this.#store.updateCompareRun(row);
          if (session.status === "idle" || session.status === "error") void this.#settleCompareBranch(session.id);
        },
        (err: unknown) => {
          if (!(err instanceof SendStoppedError)) session.reportSendFailure(err);
          t.error = err instanceof Error ? err.message : String(err);
          this.#compareBranchOf.delete(session.id);
          this.#store.updateCompareRun(row);
          this.#retireCompareIfSettled(row);
        },
      );
    }
    return { type: "compare.state", requestId: msg.id, compare: this.#compareStateOf(row) };
  }

  /**
   * Freeze what a branch's compared turn did, once it has settled (idle or
   * error). Once per branch; waits for that turn's end snapshot so the file
   * counts are final.
   */
  async #settleCompareBranch(sessionId: string): Promise<void> {
    const compareId = this.#compareBranchOf.get(sessionId);
    const row = compareId ? this.#liveCompares.get(compareId) : undefined;
    const t = row?.targets.find((x) => x.sessionId === sessionId);
    const s = this.#sessions.get(sessionId);
    if (!row || !t || !s || !t.baseTurnId || t.result) return;
    if (s.status !== "idle" && s.status !== "error") return;
    this.#compareBranchOf.delete(sessionId);
    this.#compareSettling.add(sessionId);
    try {
      await this.#freezeBranch(t, s);
    } finally {
      this.#compareSettling.delete(sessionId);
    }
    this.#store.updateCompareRun(row);
    this.#retireCompareIfSettled(row);
  }

  async #freezeBranch(t: CompareRunRow["targets"][number], s: Session): Promise<void> {
    const turnId = t.baseTurnId!;
    const status: "idle" | "error" = s.status === "error" ? "error" : "idle";
    // Nothing after the compared turn yet: the branch's totals are that turn's
    // (a fork starts with none). Read before awaiting — the user may go on.
    const usage = s.currentTurnId === turnId ? s.toInfo().usage : undefined;
    const error = status === "error" ? (s.lastTurnError ?? undefined) : undefined;
    const reply = s.turnReply(turnId);
    const files = await s.turnFiles(turnId).catch(() => undefined);
    t.result = {
      status,
      ...(error ? { error } : {}),
      ...(reply ? { reply: reply.length > 4_000 ? `${reply.slice(0, 3_999)}…` : reply } : {}),
      ...(usage
        ? { costUsd: usage.totalCostUsd, durationMs: usage.durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : {}),
      ...(files ? { files: { ...files, paths: files.paths.slice(0, 200) } } : {}),
    };
  }

  /** Drop a comparison from the live set once no branch can still settle. */
  #retireCompareIfSettled(row: CompareRunRow): void {
    if (this.#liveCompares.get(row.id) !== row) return;
    const pending = (t: CompareRunRow["targets"][number]) =>
      !!t.sessionId && !t.result && (this.#compareBranchOf.has(t.sessionId) || this.#compareSettling.has(t.sessionId));
    if (!row.targets.some(pending)) this.#liveCompares.delete(row.id);
  }

  /** A destroyed branch can't settle any more: stop waiting for it (it reads as "gone"). */
  #forgetCompareBranch(sessionId: string): void {
    const compareId = this.#compareBranchOf.get(sessionId);
    if (!compareId) return;
    this.#compareBranchOf.delete(sessionId);
    const row = this.#liveCompares.get(compareId);
    if (row) this.#retireCompareIfSettled(row);
  }

  /** A destroyed session's comparisons leave memory too (the store drops their rows). */
  #forgetComparesOf(parentSessionId: string): void {
    for (const [id, row] of this.#liveCompares) {
      if (row.parentSessionId !== parentSessionId) continue;
      this.#liveCompares.delete(id);
      for (const t of row.targets) if (t.sessionId && this.#compareBranchOf.get(t.sessionId) === id) this.#compareBranchOf.delete(t.sessionId);
    }
  }

  /**
   * The comparison to read or change: the live copy when it has one, else the
   * stored record — re-adopted as live when a branch settled without anyone
   * watching (e.g. across a restart), so its result still gets frozen.
   */
  #compareRow(compareId: string, auth: AuthContext): CompareRunRow | null {
    const live = this.#liveCompares.get(compareId);
    if (live) return live.accountId === (auth.accountId ?? "") && live.projectId === (auth.projectId ?? "") ? live : null;
    const row = this.#store.getCompareRun(compareId, auth.accountId ?? "", auth.projectId ?? "");
    if (!row) return null;
    const pending = row.targets.filter(
      (t) => t.sessionId && t.baseTurnId && !t.result && this.#sessions.has(t.sessionId) && !this.#compareSettling.has(t.sessionId),
    );
    if (pending.length > 0) {
      this.#liveCompares.set(row.id, row);
      for (const t of pending) this.#compareBranchOf.set(t.sessionId!, row.id);
    }
    return row;
  }

  /** A comparison's view: frozen results for settled branches, live status for the rest. */
  #compareStateOf(row: CompareRunRow): CompareState {
    const targets: CompareTargetState[] = row.targets.map((t) => {
      const base = { providerId: t.providerId, ...(t.model ? { model: t.model } : {}) };
      if (!t.sessionId) return { ...base, status: "failed", done: true, ...(t.error ? { error: t.error } : {}) };
      const s = this.#sessions.get(t.sessionId);
      if (t.result) {
        const { status, ...rest } = t.result;
        return { ...base, sessionId: t.sessionId, status: s ? status : "gone", done: true, ...rest };
      }
      if (!s) return { ...base, sessionId: t.sessionId, status: "gone", done: true, ...(t.error ? { error: t.error } : {}) };
      if (t.error && !t.baseTurnId) return { ...base, sessionId: t.sessionId, status: "failed", done: true, error: t.error };
      // Never started, and nothing will start it now (only a live comparison
      // has sends in flight — a daemon restart dropped them).
      if (!t.baseTurnId && !this.#liveCompares.has(row.id)) {
        return { ...base, sessionId: t.sessionId, status: "failed", done: true, error: "it didn't start (the daemon restarted before its prompt ran)" };
      }
      return { ...base, sessionId: t.sessionId, status: s.status, done: false };
    });
    return {
      compareId: row.id,
      parentSessionId: row.parentSessionId,
      prompt: row.prompt,
      ...(row.afterTurnId ? { afterTurnId: row.afterTurnId } : {}),
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      ...(row.keptSessionId ? { keptSessionId: row.keptSessionId } : {}),
      targets,
    };
  }

  #canRead(auth: AuthContext): boolean {
    return hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH) || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
  }

  async #compareGet(msg: Extract<ClientMessage, { type: "compare.get" }>, auth: AuthContext): Promise<DaemonMessage> {
    if (!this.#canRead(auth)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }
    const row = this.#compareRow(msg.compareId, auth);
    if (!row) return { type: "response.error", requestId: msg.id, error: "Comparison not found", code: "not_found" };
    // A branch that has settled but isn't frozen yet: freeze it now, so the
    // answer is final rather than "done, results to follow".
    await Promise.all(row.targets.filter((t) => t.sessionId && !t.result).map((t) => this.#settleCompareBranch(t.sessionId!)));
    return { type: "compare.state", requestId: msg.id, compare: this.#compareStateOf(row) };
  }

  #compareList(msg: Extract<ClientMessage, { type: "compare.list" }>, auth: AuthContext): DaemonMessage {
    if (!this.#canRead(auth)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }
    const parent = this.#getOwnedSession(msg.sessionId, auth);
    if (!parent) return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    // Cheap by design (no git, no waiting): stored results and live statuses.
    const rows = this.#store.listCompareRuns(parent.id, parent.accountId, parent.projectId);
    const compares = rows.map((r) => this.#compareStateOf(this.#liveCompares.get(r.id) ?? r));
    return { type: "compare.list.result", requestId: msg.id, sessionId: parent.id, compares };
  }

  async #compareKeep(
    msg: Extract<ClientMessage, { type: "compare.keep" }>,
    auth: AuthContext,
    client: AttachedClient,
  ): Promise<DaemonMessage> {
    const refuse = (error: string, code: ErrorCode = "invalid_request"): DaemonMessage => ({ type: "response.error", requestId: msg.id, error, code });
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) return refuse("Missing scope: session:send", "forbidden");
    if (msg.discardOthers && !hasScope(auth.scopes as string[], SCOPES.SESSION_DESTROY)) {
      return refuse("Missing scope: session:destroy (needed to discard the others)", "forbidden");
    }
    const row = this.#compareRow(msg.compareId, auth);
    if (!row) return refuse("Comparison not found", "not_found");
    // One keep per comparison: a second "keep, discard others" would destroy
    // the branch kept first — and whatever was done in it since.
    if (row.keptSessionId && row.keptSessionId !== msg.sessionId) return refuse("This comparison already kept another branch");
    const target = row.targets.find((t) => t.sessionId === msg.sessionId);
    const session = target ? this.#getOwnedSession(msg.sessionId, auth) : null;
    if (!target || !target.baseTurnId || !session) {
      return refuse("That isn't a branch you can keep — it never ran the prompt, or is gone");
    }
    if (session.status === "thinking" || session.status === "tool_running" || session.status === "waiting_approval") {
      return refuse("That branch is still working — keep it once it's done");
    }
    row.keptSessionId = msg.sessionId;
    this.#store.updateCompareRun(row);
    const notDiscarded: string[] = [];
    if (msg.discardOthers) {
      for (const t of row.targets) {
        if (!t.sessionId || t.sessionId === msg.sessionId || !this.#sessions.has(t.sessionId)) continue;
        const r = await this.handle({ type: "session.destroy", id: msg.id, sessionId: t.sessionId }, auth, client);
        if (r.type !== "response.ok") notDiscarded.push(t.sessionId);
      }
    }
    this.#store.audit(
      auth.sub,
      "compare.keep",
      msg.sessionId,
      `compare=${row.id} discardOthers=${msg.discardOthers === true}${notDiscarded.length ? ` notDiscarded=${notDiscarded.join(",")}` : ""}`,
    );
    return { type: "compare.state", requestId: msg.id, compare: this.#compareStateOf(row) };
  }

  /**
   * Go back a turn (#355). Same authority as sending a message: taking a
   * turn back is a way of steering the session, and restoring files only
   * puts back what the session's own snapshots hold.
   */
  async #sessionRewind(
    msg: Extract<ClientMessage, { type: "session.rewind" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:send", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    if (session.role) {
      return { type: "response.error", requestId: msg.id, error: `Cannot go back a turn in a ${session.role} session`, code: "invalid_request" };
    }
    const canStop = hasScope(auth.scopes as string[], SCOPES.SESSION_INTERRUPT);
    if (msg.dryRun === true) {
      // A preview shows prompts, file paths and commands from the session's
      // history: same read authority as listing its turns.
      const canRead = hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH) || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
      if (!canRead) {
        return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch (needed to preview)", code: "forbidden" };
      }
    } else {
      // Writing files back (and deleting files created since) bypasses the
      // approval gate every agent write goes through: same trust as
      // approving a write.
      if (msg.restoreFiles === true && !hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
        return { type: "response.error", requestId: msg.id, error: "Missing scope: session:approve (needed to restore files)", code: "forbidden" };
      }
      // Stopping a running turn or background agents is an interrupt. Checked
      // here to fail fast, and again inside the serialized rewind (the state
      // can change while it queues).
      if ((session.rewindNeedsStop || session.preparingTurn) && !canStop) {
        return { type: "response.error", requestId: msg.id, error: "Missing scope: session:interrupt (the session is busy)", code: "forbidden" };
      }
    }
    try {
      const r = await session.rewind(
        msg.turnId,
        {
          restoreFiles: msg.restoreFiles === true,
          dryRun: msg.dryRun === true,
          force: msg.force === true,
          canStop,
          ...(msg.planId ? { planId: msg.planId } : {}),
        },
        auth,
      );
      return {
        type: "session.rewind.result",
        requestId: msg.id,
        sessionId: session.id,
        turnId: msg.turnId,
        dryRun: msg.dryRun === true || r.refused !== undefined,
        planId: r.planId,
        removedTurns: r.removedTurnIds.length,
        restoredPrompt: r.restoredPrompt,
        irreversible: r.irreversible,
        ...(r.files ? { files: r.files } : {}),
        ...(r.filesUnavailable ? { filesUnavailable: r.filesUnavailable } : {}),
        ...(r.refused ? { refused: r.refused } : {}),
      };
    } catch (err) {
      if (err instanceof RewindError) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: err.message,
          code: err.code === "not_found" ? "not_found" : "invalid_request",
        };
      }
      throw err;
    }
  }

  /** History paging (`scrollback.paging`) — same read authority as attach. */
  async #pageScrollback(
    msg: Extract<ClientMessage, { type: "scrollback.page" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const scope = hasScope(auth.scopes as string[], SCOPES.SESSION_ATTACH)
      || hasScope(auth.scopes as string[], SCOPES.SESSION_WATCH);
    if (!scope) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:attach or session:watch", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const page = await session.pageScrollback(msg.beforeMessageId, msg.maxBytes);
    return {
      type: "scrollback.page.result",
      requestId: msg.id,
      sessionId: msg.sessionId,
      ...page,
    };
  }

  #detach(
    msg: Extract<ClientMessage, { type: "session.detach" }>,
    client: AttachedClient,
  ): DaemonMessage {
    const session = this.#getOwnedSession(msg.sessionId, client.auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    session.detach(client.id);
    return { type: "response.ok", requestId: msg.id };
  }

  #send(
    msg: Extract<ClientMessage, { type: "session.send" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:send", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    // Duplicate-send suppression (`send.idempotency`): a client that
    // couldn't observe whether its send survived a dropped socket resends
    // with the SAME clientMsgId — acknowledging instead of dispatching
    // prevents one prompt from becoming two billed turns. Checked after
    // scope + ownership so a rejected send never poisons the id.
    if (msg.clientMsgId !== undefined && session.markClientMsgSeen(msg.clientMsgId)) {
      return { type: "response.ok", requestId: msg.id, data: { duplicate: true } };
    }
    // Tell the sender directly when the session's Claude account can't be
    // used (gone, or redirectable by the workdir's settings) — session.send
    // would refuse too, but only as a message in the stream.
    if (session.toInfo().providerId === "claude") {
      try {
        session.assertClaudeAccountUsable();
      } catch (err) {
        return this.#claudeAccountsError(msg.id, err);
      }
    }

    // Fire and forget — output streams to attached clients. The user message
    // is persisted synchronously at the top of session.send() before any
    // fallible work, so a later throw can't lose it. Surface that throw as a
    // visible system message instead of swallowing it (the old `.catch(() => {})`
    // returned a false "ok" and dropped the error — silent data loss).
    // priority controls mid-turn insertion semantics (default "later" = FIFO).
    session
      .send(msg.text, auth, msg.attachments, msg.priority)
      .catch((err) => {
        // Stopped before its turn started: the user already got a notice.
        if (err instanceof SendStoppedError) return;
        session.reportSendFailure(err);
      });

    return { type: "response.ok", requestId: msg.id };
  }

  #pin(
    msg: Extract<ClientMessage, { type: "session.pin" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Reuse SESSION_SEND scope — pins only make sense to holders of send.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    session.pinFile(msg.path, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  #unpin(
    msg: Extract<ClientMessage, { type: "session.unpin" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    session.unpinFile(msg.path, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  #pushRegister(
    msg: Extract<ClientMessage, { type: "push.register" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // No scope gate: registration is inherently self-scoped — the token is
    // bound to the caller's own identity (auth.sub) + tenant, so a client can
    // only ever register its own device. Gated by authentication + the PUSH
    // capability, mirroring how session.ui_response avoids a bespoke scope.
    this.#store.registerPush(msg.token, msg.platform, auth.sub, auth.accountId, auth.projectId);
    return { type: "response.ok", requestId: msg.id };
  }

  #pushUnregister(
    msg: Extract<ClientMessage, { type: "push.unregister" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Owner-scoped delete — a client can only remove its own device token.
    this.#store.unregisterPush(msg.token, auth.sub);
    return { type: "response.ok", requestId: msg.id };
  }

  /**
   * Cross-session search — fans out to the memory engine, groups by
   * session, and returns a ranked list with evidence snippets. Requires
   * SESSION_LIST scope (same level as listing sessions — you need to be
   * able to see sessions to search their content).
   *
   * Resolution of workspace scope:
   *   - `scope: "all"` → search across every workspace the caller's tenant
   *     owns (never other tenants' memory, #415)
   *   - `scope: "workspace"` (default) + `workdir` explicit → anchor there
   *   - `scope: "workspace"` + no workdir → use the caller's most recent
   *     session if any, else empty-string (engine handles gracefully)
   */
  async #search(
    msg: Extract<ClientMessage, { type: "session.search" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:list",
        code: "forbidden",
      };
    }
    if (!this.#memory) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Memory is disabled — session search requires CODEOID_MEMORY=1",
        code: "invalid_request",
      };
    }
    if (!msg.query || msg.query.trim().length === 0) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Query must be a non-empty string",
        code: "invalid_request",
      };
    }

    const scope = msg.scope ?? "workspace";
    let workspaceId = "";
    if (scope === "workspace") {
      const anchorPath = msg.workdir ?? this.#guessCallerWorkdir(auth);
      // auth carries the tenant (account_id/project_id) — scope by it so a
      // caller can't recall episodes from another tenant sharing the path.
      if (anchorPath) workspaceId = workspaceIdFromPath(anchorPath, auth);
    }

    // Provide a session-name map so the ranker can boost exact-name hits.
    // Only include sessions visible to this caller — name leakage across
    // tenants is the same disclosure as `session.list` would be.
    const sessionNames = new Map<string, string>();
    for (const s of this.#sessions.values()) {
      if (s.accountId !== auth.accountId || s.projectId !== auth.projectId) continue;
      sessionNames.set(s.id, s.name);
    }

    const limit = Math.max(1, Math.min(msg.limit ?? 10, 50));
    const hits = await this.#memory.searchSessions({
      query: msg.query,
      // Global scope = OMIT workspaceId (the engine treats undefined as
      // "every workspace"); passing "" selected a nonexistent empty
      // workspace and scope:"all" always returned zero hits.
      //
      // The same trap applies when scope="workspace" but no anchor could be
      // resolved (no msg.workdir and no caller focus). The protocol says that
      // case "falls back to cross-workspace", so omit the key instead of
      // passing "" — which matched nothing and silently returned zero hits.
      //
      // Cross-workspace means every workspace the CALLER's tenant owns — never
      // the whole store, which can hold other tenants' memory (#415).
      ...(scope === "all" || !workspaceId
        ? { tenant: { accountId: auth.accountId, projectId: auth.projectId } }
        : { workspaceId }),
      limit,
      sessionNames,
    });

    // Enrich each hit with sessionName + workdir from the in-memory map
    // (store has the rest; we just want ergonomic display). Hits that
    // resolve to a session belonging to a different tenant render as
    // "(unknown)" — same shape we already use for sessions that aren't
    // live in memory.
    const enriched = hits
      .map((h) => {
        const live = this.#sessions.get(h.sessionId);
        // Drop hits whose session is live under a DIFFERENT tenant — masking
        // only the name (as before) still leaked the snippet body/excerpt
        // when two tenants share a path-hash workspace on one host. Hits with
        // no live session (the caller's own destroyed/not-resumed history)
        // are kept and masked as before. (A fully tenant-scoped episode store
        // would also catch cross-tenant *non-live* hits — tracked in #13.)
        if (
          live &&
          (live.accountId !== auth.accountId || live.projectId !== auth.projectId)
        ) {
          return null;
        }
        const owned =
          live && live.accountId === auth.accountId && live.projectId === auth.projectId
            ? live
            : null;
        return {
          ...h,
          sessionName: owned?.name ?? "(unknown)",
          workdir: owned?.workdir ?? "",
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      type: "session.search.result",
      requestId: msg.id,
      query: msg.query,
      sessions: enriched,
      workspaceId,
      limit,
    };
  }

  /**
   * Infer a workdir for the caller to anchor workspace search. We look for
   * the caller's most-recent session (by createdBy match); the daemon
   * doesn't track per-client focus explicitly so "most recent session
   * they created" is the best stand-in.
   */
  #guessCallerWorkdir(auth: AuthContext): string | null {
    let best: Session | null = null;
    for (const s of this.#sessions.values()) {
      if (s.createdBy !== auth.sub) continue;
      if (!best || s.createdAt > best.createdAt) best = s;
    }
    return best?.workdir ?? null;
  }

  /** Set the session's thinking effort (#417). `session:send` on the caller's own session, as for its model. */
  async #setEffort(msg: Extract<ClientMessage, { type: "session.set_effort" }>, auth: AuthContext): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:send", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    const data = await session.setEffort(msg.effort, auth);
    return { type: "response.ok", requestId: msg.id, data };
  }

  /**
   * Switch the model for a session. Reuses SESSION_SEND scope (same as
   * setMode / rotate — anyone who can drive the session can change its
   * model). Returns `response.ok` with the resolved model in `data` on
   * success; rejects with a 400 when the model id is unknown.
   */
  async #setModel(
    msg: Extract<ClientMessage, { type: "session.set_model" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    // Validate against the session's provider catalog (live, persisted, or
    // fallback). Accepts a canonical value, a case-insensitive display name
    // (`opus` → "Opus"), or a full claude-* id. An unknown value is rejected
    // here with the set of valid choices, so `/model o` gets actionable
    // feedback.
    const { models } = this.#currentModels(session.providerId);
    const resolvedModel = resolveAgainstList(msg.model, models);
    if (!resolvedModel) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `Unknown model "${msg.model}". Available: ${models
          .map((m) => m.value)
          .join(", ")}`,
        code: "invalid_request",
      };
    }
    let resolvedFallback = msg.fallbackModel;
    if (typeof msg.fallbackModel === "string") {
      const rf = resolveAgainstList(msg.fallbackModel, models);
      if (!rf) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: `Unknown fallback model "${msg.fallbackModel}".`,
          code: "invalid_request",
        };
      }
      resolvedFallback = rf;
    }
    try {
      const result = await session.setModel(resolvedModel, resolvedFallback, auth);
      return {
        type: "response.ok",
        requestId: msg.id,
        data: { model: result.model, fallbackModel: result.fallbackModel },
      };
    } catch (err) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: err instanceof Error ? err.message : String(err),
        code: "invalid_request",
      };
    }
  }

  /**
   * Manual rotation via `/rotate` slash. Reuses SESSION_SEND scope: anyone
   * who can drive the session can rotate it. Rejects silently (with
   * `response.ok` + boolean in `data`) when the min-turns guard fires —
   * the user sees the reason in the scrollback info message the session
   * itself emits.
   */
  async #rotate(
    msg: Extract<ClientMessage, { type: "session.rotate" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    const rotated = await session.manualRotate(auth);
    return {
      type: "response.ok",
      requestId: msg.id,
      data: { rotated },
    };
  }

  #interrupt(
    msg: Extract<ClientMessage, { type: "session.interrupt" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_INTERRUPT)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:interrupt", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    // interrupt() does its UI-visible work (flush, deny approvals, info row)
    // synchronously before its first await, so the ack is accurate; the
    // SDK turn-stop resolves shortly after. Fire-and-forget — errors are
    // handled inside interrupt() (hard-abort fallback).
    void session.interrupt(auth);
    return { type: "response.ok", requestId: msg.id };
  }

  #approve(
    msg: Extract<ClientMessage, { type: "session.approve" }>,
    auth: AuthContext,
  ): DaemonMessage {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:approve", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    // Still `response.ok` for a stale id — the web ApprovalBar sends one to
    // dismiss a leftover prompt — but say so, for callers that report it.
    const outcome = session.approve(msg.approvalId, msg.approved, auth, msg.updatedInput);
    return { type: "response.ok", requestId: msg.id, data: { outcome } };
  }

  #uiResponse(
    msg: Extract<ClientMessage, { type: "session.ui_response" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Answering a provider dialog is the same trust class as answering a
    // tool approval — reuse session:approve.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:approve",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const applied = session.resolveUiRequestFromClient(
      msg.requestId,
      { value: msg.value, confirmed: msg.confirmed, cancelled: msg.cancelled },
      auth,
    );
    if (!applied) {
      // Already answered elsewhere, timed out, or never existed. Clients
      // treat this as "dismiss my copy" (the ui_resolved broadcast already
      // did or will do that).
      return {
        type: "response.error",
        requestId: msg.id,
        error: "UI request is not pending",
        code: "not_found",
      };
    }
    return { type: "response.ok", requestId: msg.id };
  }

  async #partAction(
    msg: Extract<ClientMessage, { type: "session.part_action" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Activating a provider button is an act-on-session operation — same
    // trust class as sending a prompt.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:send",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const result = await session.dispatchPartAction(msg.messageId, msg.action, msg.data, auth);
    if (!result.ok) {
      return { type: "response.error", requestId: msg.id, error: result.error, code: result.code };
    }
    return { type: "response.ok", requestId: msg.id };
  }

  async #sessionCommands(
    msg: Extract<ClientMessage, { type: "session.commands" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Read-class visibility — same gate as listing sessions.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:list",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const commands = await session.listProviderCommands();
    return {
      type: "session.commands.result",
      requestId: msg.id,
      sessionId: session.id,
      providerId: session.providerId,
      commands,
    };
  }

  #setMode(
    msg: Extract<ClientMessage, { type: "session.set_mode" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Set-mode reuses the same scope gates as approve/send — the caller must
    // already be authorized to act on the session.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:approve",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    session.setMode(msg.mode, msg.maxTurns, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  async #setProvider(
    msg: Extract<ClientMessage, { type: "session.set_provider" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    // Same trust class as set_mode (set_model uses the lower SESSION_SEND
    // scope): switching backends is a heavier session-config write.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:approve",
        code: "forbidden",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const result = await session.switchProvider(msg.providerId, auth);
    if (!result.ok) {
      return { type: "response.error", requestId: msg.id, error: result.error, code: result.code };
    }
    return {
      type: "response.ok",
      requestId: msg.id,
      data: { providerId: result.providerId },
    };
  }

  /**
   * Redial one of the session backend's MCP servers (#389). It changes no
   * configuration — the server, its config and its credentials are the
   * backend's — so it needs what acting in the session needs: session:send.
   */
  async #mcpReconnect(
    msg: Extract<ClientMessage, { type: "session.mcp_reconnect" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:send", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const result = await session.reconnectMcpServer(msg.server, auth);
    if ("unsupported" in result) {
      return { type: "response.error", requestId: msg.id, error: result.unsupported, code: "invalid_request" };
    }
    if ("refused" in result) {
      return { type: "response.error", requestId: msg.id, error: result.refused, code: "invalid_request" };
    }
    return { type: "response.ok", requestId: msg.id, data: result };
  }

  /** Re-read the session's MCP servers and apply any change (#395). `session:send`. */
  async #mcpRefresh(
    msg: Extract<ClientMessage, { type: "session.mcp_refresh" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_SEND)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:send", code: "forbidden" };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }
    const result = await session.refreshMcp();
    this.#store.audit(auth.sub, "session.mcp_refresh", session.id, `changed=${result.changed} deferred=${result.deferred}`);
    return { type: "response.ok", requestId: msg.id, data: result };
  }

  /**
   * What approving a project's MCP server would approve, in full (#395): the
   * one deciding sees the command, every argument, the URL, and each env var
   * and header, exactly as they'll run — nothing masked or cut. Same rights as approving.
   */
  async #mcpApprovePreview(
    msg: Extract<ClientMessage, { type: "mcp.approve.preview" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const fail = (error: string, code: "invalid_request" | "not_found" | "forbidden" = "invalid_request"): DaemonMessage => ({
      type: "response.error",
      requestId: msg.id,
      error,
      code,
    });
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE) || auth.delegationDepth > 0) {
      return fail("Reviewing a project's MCP server for approval needs settings:write, on a token of your own", "forbidden");
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) return fail("Session not found", "not_found");
    const read = await readWorkdirServers(session.workdir);
    if (!read) return fail("Claude's config can't be read just now (it may be mid-write) — try again");
    if (read.repoUnreadable) return fail("The project's .mcp.json can't be read just now (mid-edit, not JSON, or too big) — try again once it can");
    const repo = read.servers.filter((w) => w.origin === "claude-repo" && w.name === msg.server && (msg.path === undefined || w.path === msg.path));
    if (repo.length === 0) return fail(`This project declares no MCP server ${JSON.stringify(msg.server)}`, "not_found");
    if (repo.length > 1) return fail(`${JSON.stringify(msg.server)} is declared in ${repo.map((w) => w.path).join(" and ")}; say which file`);
    const w = repo[0]!;
    // Everything here is the repo's choice and is what gets approved, so it's
    // shown exactly — a secret committed to the repo isn't the approver's to
    // be kept from. Only what wouldn't show (bidi, zero-width, controls) is escaped.
    const shown = (o: Record<string, string> | undefined) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [visibleVerbatim(k), visibleVerbatim(v)]));
    const commandLine = w.raw.command === undefined ? null : [w.raw.command, ...(w.raw.args ?? [])].map((a) => shellArg(visibleCompact(a))).join(" ");
    const lines: string[] = [];
    if (commandLine !== null) lines.push(`command: ${commandLine}`);
    if (w.raw.url !== undefined) {
      // The host it dials, as the URL parser reads it — a look-alike
      // (Cyrillic "Ь"), userinfo (`api.github.com@evil.example`) or an
      // encoded dot can't pass for another.
      let host = "(not a valid URL)";
      try {
        host = new URL(w.raw.url).host;
      } catch {}
      lines.push(`url: ${quotedVisible(w.raw.url)} (host: ${quotedVisible(host)})`);
    }
    const block = (label: string, o: Record<string, string> | undefined, sep: string) => {
      const entries = Object.entries(o ?? {});
      if (entries.length === 0) return;
      lines.push(`${label} (${entries.length}):`);
      for (const [k, v] of entries) lines.push(`  ${quotedVisible(k)}${sep}${quotedVisible(v)}`);
    };
    block("env", w.raw.env, " = ");
    block("headers", w.raw.headers, ": ");
    const preview: McpApprovePreview = {
      lines,
      server: w.name,
      path: w.path, // sent back to name the entry: as is (clients escape it to show)
      fingerprint: w.fingerprint,
      shownPath: visibleVerbatim(w.path),
      commandLine,
      command: w.raw.command === undefined ? null : visibleVerbatim(w.raw.command),
      args: (w.raw.args ?? []).map(visibleVerbatim),
      url: w.raw.url === undefined ? null : visibleVerbatim(w.raw.url),
      env: shown(w.raw.env),
      headers: shown(w.raw.headers),
    };
    return { type: "response.ok", requestId: msg.id, data: preview };
  }

  /**
   * Approve a repo's MCP server — this exact entry — for every backend in the
   * session's workdir (#395). Consent to what a repo chose, so: the caller's
   * own session, `settings:write`, never a delegated token, audited with the
   * file it came from. Applies on a refresh.
   */
  async #mcpApprove(
    msg: Extract<ClientMessage, { type: "mcp.approve" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    const fail = (error: string, code: "invalid_request" | "not_found" | "forbidden" = "invalid_request"): DaemonMessage => ({
      type: "response.error",
      requestId: msg.id,
      error,
      code,
    });
    if (!hasScope(auth.scopes as string[], SCOPES.SETTINGS_WRITE) || auth.delegationDepth > 0) {
      return fail("Approving a project's MCP server needs settings:write, on a token of your own", "forbidden");
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) return fail("Session not found", "not_found");
    const read = await readWorkdirServers(session.workdir);
    if (!read) return fail("Claude's config can't be read just now (it may be mid-write) — try again");
    if (read.repoUnreadable) return fail("The project's .mcp.json can't be read just now (mid-edit, not JSON, or too big) — try again once it can");
    const repo = read.servers.filter(
      (w) => w.origin === "claude-repo" && w.name === msg.server && (msg.path === undefined || w.path === msg.path),
    );
    if (repo.length === 0) return fail(`This project declares no MCP server ${JSON.stringify(msg.server)}`, "not_found");
    // The entry approved is the one the caller looked at: a repo that changed
    // it since (or a race to) gets nothing.
    const entry = repo.find((w) => w.fingerprint === msg.fingerprint);
    if (!entry) return fail(`${JSON.stringify(msg.server)} changed since it was shown — look at it again before approving`);
    this.#store.approveWorkdirMcpServer(
      { accountId: auth.accountId, projectId: auth.projectId, workdir: session.workdir },
      entry.name,
      entry.fingerprint,
      auth.sub,
    );
    this.#store.audit(
      auth.sub,
      "mcp.approve",
      session.id,
      `server=${JSON.stringify(entry.name)} source=${JSON.stringify(entry.path)} fingerprint=${entry.fingerprint} program=${JSON.stringify(entry.raw.command ? serverProgram(entry.raw.command) : redactMcpUrl(entry.raw.url ?? ""))}`,
    );
    return { type: "response.ok", requestId: msg.id, data: { server: entry.name, path: entry.path } };
  }

  #rename(
    msg: Extract<ClientMessage, { type: "session.rename" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Rename reuses the session:approve scope — anyone with write access
    // to session config qualifies. Stricter scopes can be introduced
    // later if we split config vs. execution permissions.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_APPROVE)) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Missing scope: session:approve",
        code: "forbidden",
      };
    }
    const trimmed = msg.name.trim();
    if (!trimmed) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session name cannot be empty",
        code: "invalid_request",
      };
    }
    // Same reservation #create enforces: a normal session named "conductor"
    // shadows the singleton in session.list and makes findByName (a first-match
    // scan) insertion-order dependent. Enforcing it only on create left the
    // hazard reachable by renaming into the name instead (#257).
    if (trimmed === this.#conductorName()) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: `"${trimmed}" is reserved for the conductor session`,
        code: "invalid_request",
      };
    }
    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return {
        type: "response.error",
        requestId: msg.id,
        error: "Session not found",
        code: "not_found",
      };
    }
    // The inverse: the conductor's name is config-derived (#conductorName), so
    // renaming it away from that value orphans it — it would no longer match
    // its own reservation, and the next conductor lookup/creation would see the
    // name as free.
    if (session.role === "conductor") {
      return {
        type: "response.error",
        requestId: msg.id,
        error:
          "The conductor session cannot be renamed — its name comes from config.conductor.name",
        code: "invalid_request",
      };
    }
    session.rename(trimmed, auth);
    return { type: "response.ok", requestId: msg.id };
  }

  async #destroySession(
    msg: Extract<ClientMessage, { type: "session.destroy" }>,
    auth: AuthContext,
  ): Promise<DaemonMessage> {
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_DESTROY)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:destroy", code: "forbidden" };
    }

    const session = this.#getOwnedSession(msg.sessionId, auth);
    if (!session) {
      return { type: "response.error", requestId: msg.id, error: "Session not found", code: "not_found" };
    }

    // Await teardown so the OK response only goes out AFTER:
    //   1. SDK subprocess fully aborts
    //   2. ZeroID identity is deactivated
    //   3. Transcript/meta files are unlinked
    //
    // Otherwise a client recreating a session by name immediately
    // races the still-running consumer task and the appendFile that
    // landed in P1 #10 — ENOENT or partially-written final lines on
    // the new session.
    // Goal end for a collaborative session: its role-children have per-goal
    // lifetime, so they go with it. Children FIRST — the orchestrator is what
    // the owner asked to destroy, and returning OK while N child agent
    // subprocesses are still live would orphan them with no handle left to
    // reach them by.
    if (session.collaboration) {
      await this.#teardownCollaborationChildren(msg.sessionId, "collaboration goal ended");
      // ...and the orchestrator's own mount.
      this.#revokeBlackboardToken(msg.sessionId);
      // Artifacts are goal-scoped, so they die with the goal. Dropped AFTER the
      // children so a child mid-write can't recreate rows behind the delete.
      try {
        this.#goalBlackboard().deleteGoal({
          accountId: session.accountId,
          projectId: session.projectId,
          goalSessionId: session.id,
        });
      } catch (err) {
        console.error(
          `[codeoid/collaboration] artifact cleanup failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await session.destroy(auth);
    this.#forgetComparesOf(msg.sessionId);
    this.#forgetCompareBranch(msg.sessionId);
    // Covers destroying a CHILD directly (not via goal teardown) — without
    // this its token stays live in the endpoint's binding map and keeps
    // authorizing reads/writes on the goal after the session is gone.
    this.#revokeBlackboardToken(msg.sessionId);
    this.#sessions.delete(msg.sessionId);
    return { type: "response.ok", requestId: msg.id };
  }

  #emptyUsageResponse(requestId: string): DaemonMessage {
    return {
      type: "response.ok",
      requestId,
      data: {
        daily: [] as DailyUsageBucket[],
        lifetime: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          numTurns: 0,
          numSessions: 0,
        } as LifetimeUsageTotals,
      },
    };
  }

  #usageDaily(
    msg: Extract<ClientMessage, { type: "usage.daily" }>,
    auth: AuthContext,
  ): DaemonMessage {
    // Cost/token/turn aggregates are tenant data — gate on the read scope, like
    // the other read handlers (session.search/commands). Without this, a token
    // holding no session scope could still read its tenant's billing totals.
    if (!hasScope(auth.scopes as string[], SCOPES.SESSION_LIST)) {
      return { type: "response.error", requestId: msg.id, error: "Missing scope: session:list", code: "forbidden" };
    }
    if (!this.#memory) {
      return this.#emptyUsageResponse(msg.id);
    }
    const days = typeof msg.days === "number" && msg.days > 0 ? Math.min(msg.days, 365) : 30;
    const ownedSessionIds = this.#store
      .listSessions(auth.accountId, auth.projectId)
      .map((s) => s.id);
    // An identity that owns no sessions gets zeros — never the unfiltered
    // aggregate. (The store also enforces this: an empty array is a strict
    // filter, not "no filter". Belt and suspenders around a tenancy leak.)
    if (ownedSessionIds.length === 0) {
      return this.#emptyUsageResponse(msg.id);
    }
    const daily = this.#memory.store.dailyUsage(days, ownedSessionIds);
    const lifetime = this.#memory.store.lifetimeTotals(ownedSessionIds);
    return {
      type: "response.ok",
      requestId: msg.id,
      data: { daily, lifetime },
    };
  }
}

/**
 * Bound `session.import {kind:"file", path}` to a fixed import dir
 * under `~/.codeoid/imports/`. Without this any client with
 * `session:create` can read any file the daemon can — `/etc/passwd`,
 * `~/.aws/credentials`, sibling sessions' transcripts, our own
 * SQLite files. Same realpath + prefix pattern attachments.ts
 * already uses for workdir bounding.
 *
 * The dir is created on first call (`mkdir -p`) so users don't have
 * to set it up manually; the user moves bundles in via `mv`.
 */
async function resolveImportPath(
  requested: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const importsDir = path.join(os.homedir(), ".codeoid", "imports");
  try {
    await fs.promises.mkdir(importsDir, { recursive: true });
  } catch {
    return { ok: false, reason: "import dir not writable" };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.promises.realpath(importsDir);
  } catch {
    return { ok: false, reason: "import dir not resolvable" };
  }
  const lexicallyResolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(canonicalRoot, requested);
  let resolved: string;
  try {
    resolved = await fs.promises.realpath(lexicallyResolved);
  } catch {
    return { ok: false, reason: `bundle not found: ${requested}` };
  }
  const rootPrefix = canonicalRoot.replace(/\/+$/, "") + path.sep;
  if (resolved !== canonicalRoot && !resolved.startsWith(rootPrefix)) {
    return {
      ok: false,
      reason: `import path must live under ${importsDir}`,
    };
  }
  return { ok: true, path: resolved };
}

function tenantOf(auth: AuthContext): McpTenant {
  return { accountId: auth.accountId, projectId: auth.projectId };
}
