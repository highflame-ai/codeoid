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
import { join, resolve, sep } from "node:path";
import { Session, type AttachedClient } from "./session.js";
import type { SessionProvider } from "./providers/interface.js";
import {
  createDefaultProviderRegistry,
  type ProviderRegistry,
} from "./providers/registry.js";
import type { HookBus } from "./hooks/bus.js";
import type { Store } from "./store.js";
import { createPushTransport, PushService } from "./push/index.js";
import { hasScope, SCOPES } from "../protocol/scopes.js";
import { applyPatches, getManifest, getSnapshot } from "./settings/store.js";
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
import type { PipelineManager } from "./pipeline/manager.js";
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
  PHASE_NO_INPUT_NUDGE,
  stripNeedInputMarker,
  stripPhaseCompleteMarker,
} from "./pipeline/phase-completion.js";
import { roleEnforcement } from "./providers/tool-safety.js";
import type { DispatchEventRow, DispatchTaskRow } from "./store.js";
import { type MemoryEngine, type MemoryMcpMount, workspaceIdFromPath } from "./memory/index.js";
import type { McpRegistry } from "./mcp/registry.js";
import type { McpHub } from "./mcp/hub.js";
import { type CodeoidConfig, mutateConfigFile } from "../config.js";
import type { CompressionRegistry } from "./compress/index.js";
import { ORCHESTRATOR_ROLE } from "../protocol/types.js";
import type {
  AuthContext,
  ClientMessage,
  CollaborationConfig,
  CollaborationCost,
  CollaborationPanel,
  CollaborationRole,
  DaemonMessage,
  McpServerStatus,
  ModelInfo,
  PipelinePhaseWire,
  PipelineWire,
  SessionInfo,
  SessionMode,
  SessionWorktree,
} from "../protocol/types.js";
import type { Scope } from "../protocol/scopes.js";
import type { PipelineState } from "./pipeline/interface.js";

/** Per-phase autonomous turn budget for a pipeline run. A phase runs the model
 *  to completion within its role (the human gate is the phase boundary, not each
 *  tool), so this is a generous safety cap, refreshed at the start of every
 *  phase. There is no wall-clock timeout: the run session is attended, so the
 *  user watches + can interrupt — nothing hangs headless. */
const PIPELINE_PHASE_MAX_TURNS = 200;
import { randomUUID } from "node:crypto";
import {
  createForkWorktree,
  currentBranch,
  isGitRepo,
  removeForkWorktree,
} from "./git-worktree.js";
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

const RESUME_MAX_SESSIONS = 50;
const RESUME_DEADLINE_MS = 20_000;
/** Per-session transcript read budget on resume. Scrollback keeps at most
 * 20 MiB / 5000 messages — parsing history past that would be evicted on
 * arrival, so cap the read slightly above the scrollback byte cap. */
const RESUME_TRANSCRIPT_MAX_BYTES = 24 * 1024 * 1024;

/** Provider assumed when a client doesn't say which catalog it wants.
 *  Re-exported from models.ts so the id that gates Claude-only alias
 *  expansion (`resolveModelIdForProvider`) and the id used for catalog
 *  defaults can never drift apart. */
export const DEFAULT_PROVIDER_ID = CLAUDE_PROVIDER_ID;

/** Sort key for resume ordering: most-recently-active first. Falls back to
 * createdAt, then 0, so a malformed timestamp never throws. */
function resumeSortKey(m: { lastActivityAt?: string; createdAt?: string }): number {
  const t = m.lastActivityAt ?? m.createdAt ?? "";
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

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
  /** Live model catalogs by provider id (via each backend's supportedModels
   *  equivalent), cached daemon-wide once any session of that provider
   *  initializes. Empty until then. */
  #modelsCache = new Map<string, ModelInfo[]>();
  #config?: CodeoidConfig;
  #compressionRegistry?: CompressionRegistry;
  #dispatcher: Dispatcher;
  /** Content-blind push notifications — resolves a blocked session's owner to
   *  their registered devices. Noop transport when push is disabled (default). */
  #pushService: PushService;
  /** SDLC pipeline manager — undefined when the pipeline is disabled (default). */
  #pipelines?: PipelineManager;
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
       * Test-only: provider factory injected into every Session this manager
       * constructs, so manager-level integration tests (conductor injection,
       * worker spawn, dispatch host) run without the Claude Agent SDK
       * subprocess. Mirrors SessionCreateOptions._testProvider.
       */
      _testProviderFactory?: () => SessionProvider;
    },
  ) {
    this.#store = store;
    this.#transcriptStore = transcriptStore;
    this.#identityManager = identityManager;
    this.#rateLimiter = rateLimiter ?? new RateLimiter();
    this.#memory = memory;
    this.#config = opts?.config;
    this.#compressionRegistry = opts?.compressionRegistry;
    this.#providers = opts?.providers ?? createDefaultProviderRegistry(opts?.config);
    this.#hooks = opts?.hooks;
    this.#testProviderFactory = opts?._testProviderFactory;
    this.#dispatcher = new Dispatcher(
      store,
      this.#makeDispatcherHost(),
      opts?.config?.dispatch,
    );
    this.#pushService = new PushService(
      store,
      createPushTransport(opts?.config?.push, (token) => store.pruneDeadToken(token)),
    );
    // SDLC pipeline (docs/sdlc-pipeline.md) — off by default; when enabled, the
    // manager shares the daemon DB (one connection) and rehydrates non-terminal
    // pipelines on construction (resume). The runner drives prompt/slash phases
    // on worker turns; the `() => this` thunk is only dereferenced at run time,
    // after construction. Undefined when disabled ⇒ the daemon stays dark.
    this.#pipelines = createPipelineManagerFromConfig(opts?.config, {
      runner: new SessionPhaseRunner(() => this),
      db: store.database,
    });
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

  /** Supported backends that couldn't activate at startup (diagnostics). */
  unavailableProviders(): Array<{ id: string; hint: string }> {
    return this.#providers.unavailableEntries();
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
    // Newest-first by last activity so the cap keeps the most relevant
    // sessions when there are more than RESUME_MAX_SESSIONS on disk.
    const sorted = [...allMetas].sort(
      (a, b) => resumeSortKey(b) - resumeSortKey(a),
    );
    const capped = sorted.slice(0, RESUME_MAX_SESSIONS);
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
        const child = this.#resumeRoleChild(meta, goalConfigs);
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
          hooks: this.#hooks,
          identityManager: this.#identityManager,
          existingId: meta.sessionId,
          memory: this.#memory,
          memoryMcp: this.#memoryMcp,
mcpRegistry: this.#mcpRegistry,
mcpHub: this.#mcpHub,
          config: this.#config,
          compressionRegistry: this.#compressionRegistry,
          // The conductor self-persists (design R2): its role, provider
          // selection, and fleet tools all come back across a restart.
          role: meta.role,
          providerId: meta.providerId,
          forkedFrom: meta.forkedFrom,
          worktree: meta.worktree,
          // A collaboration is durable state, not turn state: the goal and
          // its role→backend bindings must come back after a restart or the
          // orchestrator resumes with no idea what it was coordinating.
          collaboration: meta.collaboration,
          // ...and the same is true of a CHILD's restrictions. Spread after
          // `role` so the worker role from the posture wins over `meta.role`
          // (they agree — both are "worker" — but the posture is the authority).
          ...(child?.options ?? {}),
          defaultModel:
            meta.role === "conductor" ? this.#config?.conductor?.model : undefined,
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
          onModels: (providerId, m) => this._cacheModels(providerId, m),
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
        `[codeoid] resume: restored ${resumed} of ${sorted.length} session(s); ${droppedCap} left over the ${RESUME_MAX_SESSIONS}-session cap, ${skippedDeadline} skipped past the ${RESUME_DEADLINE_MS}ms deadline (still on disk; loadable on a future restart).`,
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
            providerId: meta.providerId ?? "claude",
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
            collaboration.roles.find((r) => r.name === role.roleName),
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
      case "session.set_provider":
        return this.#setProvider(msg, auth);
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
      case "models.list":
        return this.#modelsList(msg);
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
      case "usage.daily":
        return this.#usageDaily(msg, auth);
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
              onModels: (providerId, m) => this._cacheModels(providerId, m),
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
    // strictly broader than session.workdir, but the data is descriptive
    // (no secrets — env values are stripped, only key names returned).
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
      const live = session.sdkMcpSnapshot;
      const mcpServers = snapshot.mcpServers.map((s) => {
        const liveStatus = live.status.get(s.name);
        const liveTools = live.tools.get(s.name);
        return {
          ...s,
          ...(liveStatus !== undefined ? { liveStatus } : {}),
          ...(liveTools !== undefined ? { liveTools } : {}),
        };
      });
      return {
        type: "claude.config.result",
        requestId: msg.id,
        workdir: session.workdir,
        agents: snapshot.agents,
        skills: snapshot.skills,
        mcpServers,
        hooks: snapshot.hooks,
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
   * Cache the live model catalog a provider reported. The list is
   * version-static per provider within a daemon lifetime, so the first
   * report per provider wins and we stop overwriting (cheap idempotence;
   * avoids churn from every new session).
   *
   * The first report of each daemon lifetime is also persisted to SQLite
   * (keyed by provider id), so subsequent boots serve current model names
   * before any turn runs (see `#currentModels`) instead of the baked-in
   * fallback that goes stale between codeoid releases.
   *
   * TypeScript-private (not `#`) so unit tests can exercise the persistence
   * path directly without a live backend query — same convention as
   * `Session._applyInterruptedStateToTool`. Do NOT call from production code
   * outside the `onModels` wiring.
   */
  private _cacheModels(
    providerId: string,
    raw: ReadonlyArray<{ value: string; displayName: string; description?: string }>,
  ): void {
    if (this.#modelsCache.has(providerId) || raw.length === 0) return;
    const models = raw.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      ...(m.description ? { description: m.description } : {}),
      isDefault: m.value === "default",
    }));
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
      models: providerId === DEFAULT_PROVIDER_ID ? fallbackModelInfos() : [],
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

  #modelsList(
    msg: Extract<ClientMessage, { type: "models.list" }>,
  ): DaemonMessage {
    const provider = msg.provider ?? DEFAULT_PROVIDER_ID;
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
  #mcpServerStatuses(): McpServerStatus[] {
    const reg = this.#mcpRegistry;
    const hub = this.#mcpHub;
    if (!reg || !hub) return [];
    return reg.list().map((spec) => {
      const status = hub.statusFor(spec.name);
      const connected = hub.hasClient(spec.name);
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
        ...(status?.error ? { error: status.error } : {}),
      };
    });
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
        snapshot: { ...getSnapshot(), mcpServers: this.#mcpServerStatuses() },
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
        snapshot: { ...result.snapshot, mcpServers: this.#mcpServerStatuses() },
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

  #settingsForbidden(requestId: string): DaemonMessage {
    return {
      type: "response.error",
      requestId,
      error: "Missing scope: settings:read",
      code: "forbidden",
    };
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
        status: t.status,
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
  setMcp(registry: McpRegistry, hub: McpHub): void {
    this.#mcpRegistry = registry;
    this.#mcpHub = hub;
  }

  /** Remove a client from all sessions (e.g. on disconnect). */
  disconnectClient(clientId: string): void {
    for (const session of this.#sessions.values()) {
      session.detach(clientId);
    }
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
          s.status === "waiting_approval",
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
    if (msg.collaboration) {
      const checked = validateCollaboration(msg.collaboration, this.#providers);
      if (!checked.ok) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: checked.error,
          code: "invalid_request",
        };
      }
      collaboration = checked.config;
      // Two different topologies competing for one constitution: the
      // collaborative toggle compiles its OWN ephemeral one-goal pack (§9),
      // so an installed pack would either be silently overridden or silently
      // override it. Neither is acceptable — say so instead.
      if (msg.pack) {
        return {
          type: "response.error",
          requestId: msg.id,
          error: "collaboration and pack are mutually exclusive — a collaborative session compiles its own one-goal pack. Use /pipeline for a pre-authored pack.",
          code: "invalid_request",
        };
      }
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
    let pack: PackActivation | undefined;
    if (msg.pack) {
      try {
        pack = this.#packs.resolveActivation(msg.pack, msg.packRole);
      } catch (e) {
        return { type: "response.error", requestId: msg.id, error: e instanceof Error ? e.message : String(e), code: "invalid_request" };
      }
    } else if (msg.packRole) {
      return { type: "response.error", requestId: msg.id, error: "packRole requires pack", code: "invalid_request" };
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
      // pack vocabulary never surfaces on this path.
      const compiled = compileGoalPack(collaboration, planned);
      pack = {
        id: compiled.id,
        constitution: compiled.constitution,
        subagents: compiled.subagents,
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
      hooks: this.#hooks,
      // Derived above for a collaborative session; otherwise msg.providerId.
      providerId,
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
      onModels: (providerId, m) => this._cacheModels(providerId, m),
    });

    // Resolve the thunk the fleet server closes over. Set before any child
    // exists, and before the session can take a turn, so no tool handler can
    // observe the empty string.
    goalSessionId = session.id;
    this.#sessions.set(session.id, session);
    this.#rateLimiter.recordCreation(auth.sub);

    if (collaboration) this.#attachOrchestratorBlackboard(session, collaboration);

    if (collaboration && planned.length > 0) {
      const spawned = await this.#spawnCollaborationChildren(session, collaboration, planned, auth);
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

    return {
      type: "response.ok",
      requestId: msg.id,
      data: session.toInfo(),
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
    role: CollaborationRole | undefined,
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
      role ? { reads: role.reads, writes: role.writes } : undefined,
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
    const mount = this.#blackboardMountFor(
      {
        accountId: session.accountId,
        projectId: session.projectId,
        goalSessionId: session.id,
      },
      {
        roleName: ORCHESTRATOR_ROLE,
        ordinal: 1,
        providerId: session.providerId,
        shape: "scout",
        write: false,
      },
      orchestratorRole(collaboration),
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
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    for (const child of planned) {
      try {
        // Minted before construction so the child's provider can mount it from
        // the start — the token carries this role's read/write scope.
        const blackboard = this.#blackboardMountFor(
          {
            accountId: parent.accountId,
            projectId: parent.projectId,
            goalSessionId: parent.id,
          },
          child,
          collaboration.roles.find((r) => r.name === child.roleName),
        );
        const childSession = new Session({
          name: childSessionName(parent.name, child),
          workdir: parent.workdir,
          auth,
          store: this.#store,
          transcriptStore: this.#transcriptStore,
          providers: this.#providers,
          hooks: this.#hooks,
          providerId: child.providerId,
          defaultModel: child.model,
          // Worker shape, capability role, brief, and collaborationRole — the
          // whole restriction set, from the one function the resume path also
          // calls so the two can't drift.
          ...roleChildPosture(child, parent.id, childBrief(collaboration, child)),
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
          onModels: (providerId, m) => this._cacheModels(providerId, m),
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
    const history = parent.canonicalHistory.map((t) => ({ ...t }));
    const parentInfo = parent.toInfo();
    let transcriptRows: DaemonMessage[] = [];
    let sizeHints: Array<number | undefined> = [];
    try {
      const entries = await this.#transcriptStore.loadTranscript(msg.sessionId, {
        maxBytes: RESUME_TRANSCRIPT_MAX_BYTES,
      });
      transcriptRows = entries.map((e) => e.message);
      sizeHints = entries.map((e) => e.bytes);
    } catch (err) {
      // Scrollback replay is best-effort — the fork's CONVERSATION is carried
      // by the canonical history above, which is already in memory.
      console.error(
        `[codeoid/fork] transcript load failed for ${msg.sessionId} (fork keeps history, drops scrollback): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Branch point = conversation rounds (user turns) carried over — the
    // human "you forked after N prompts" the lineage chip shows.
    const atTurn = history.filter((t) => t.role === "user").length;

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
          const wt = await createForkWorktree({
            workdir: parent.workdir,
            label: msg.name ?? parentInfo.name,
            shortId: worktreeShortId,
            ...(msg.baseBranch ? { baseBranch: msg.baseBranch } : {}),
          });
          // Fork runs in the parent's equivalent subdir of the worktree; the
          // worktree ROOT (wt.path) is what we remove on destroy.
          forkWorkdir = wt.workdir;
          worktree = { path: wt.path, branch: wt.branch, createdByCodeoid: true };
          // Surface that this is a fresh isolated worktree (deps aren't
          // present) — previously the isolated path was silent.
          const origin = msg.baseBranch
            ? `forked clean from \`${msg.baseBranch}\``
            : "carrying your uncommitted changes";
          const setupHint = this.#config?.fork?.setup
            ? " Running the configured fork setup now — the first turn will wait for it."
            : " Build dependencies (e.g. node_modules) aren't present in a fresh worktree — run your project's setup before building.";
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
        identityManager: this.#identityManager,
        memory: this.#memory,
        memoryMcp: this.#memoryMcp,
mcpRegistry: this.#mcpRegistry,
mcpHub: this.#mcpHub,
        config: this.#config,
        compressionRegistry: this.#compressionRegistry,
        _testProvider: this.#testProviderFactory?.(),
        onStatusChange: this.#statusObserver,
        onModels: (pid, m) => this._cacheModels(pid, m),
      });
      await fork.primeFromFork(history, transcriptRows, sizeHints, workdirNote);
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
      `from=${msg.sessionId} provider=${providerId ?? "default"} turns=${history.length} worktree=${worktree?.branch ?? "shared"}`,
    );

    // Make the new worktree buildable in the background (fork stays cheap; the
    // fork's first turn waits for it). Only for worktrees WE created.
    if (worktree?.createdByCodeoid && this.#config?.fork?.setup) {
      fork.beginSetup(this.#config.fork.setup);
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
    const providerId = conductorConfig?.provider ?? DEFAULT_PROVIDER_ID;
    if (providerId !== "claude") {
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
      onModels: (providerId, m) => this._cacheModels(providerId, m),
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
   * timeout (the session is attended) and the session is NOT torn down between
   * phases. Satisfies the pipeline package's PhaseTurnHost.
   *
   * `provider`/`model` on the request are not applied here: a run drives ONE
   * session with one provider, so per-phase provider overrides are out of scope
   * for the single-session model (see docs/pipeline-run.md open questions).
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
    let nudges = 0;
    let spurious = 0;
    try {
      while (true) {
        const done = new Promise<PhaseTurnResult["finalStatus"]>((resolve) => {
          this.#phaseWaiters.set(req.sessionId, resolve);
        });
        // Only (re)drive the turn when we have something to say — a spurious
        // rest below loops back with nothing pending, just awaiting the real turn.
        if (pendingSend !== null) {
          await session.send(pendingSend, auth);
          pendingSend = null;
          textAtSend = session.lastAssistantText ?? "";
        }
        const finalStatus = await done;
        const text = session.lastAssistantText ?? "";
        // A non-idle rest (error / budget-exhausted) is a real phase failure.
        if (finalStatus !== "idle") return { finalStatus, text };
        // The user interrupted (Stop) — an interrupt leaves the session idle,
        // so without this we'd re-drive a nudge over the stop. Hand the partial
        // to the review boundary instead.
        if (session.turnInterrupted) return { finalStatus: "idle", text };
        // The model hasn't COMMITTED a turn in response to our prompt yet — the
        // last canonical turn is still our own USER prompt/nudge, which is where a
        // transient query-loop rebuild idle rests BEFORE the real turn runs. Don't
        // nudge or complete over it; wait for the model's turn (`assistant`).
        // Bounded by MAX_SPURIOUS_RESTS so a backend that never responds still
        // reaches the human boundary. Immune to history-length / user-turn commit
        // timing — the reason the earlier length watermark missed the rebuild idle.
        if (session.lastTurnRole !== "assistant") {
          if (++spurious > MAX_SPURIOUS_RESTS) return { finalStatus: "idle", text };
          continue;
        }
        spurious = 0;
        // Deliverable complete → done, marker stripped. Guarded on NEW text: a
        // phase can't "complete" by reading the PRIOR phase's marker still sitting
        // in lastAssistantText (behind a tools-only turn) — only its OWN output.
        if (text !== textAtSend && isPhaseComplete(text)) {
          return { finalStatus: "idle", text: stripPhaseCompleteMarker(text) };
        }
        // The model needs the user's input. Surface the question as an input
        // dialog and feed the answer back as the next turn — a REAL answer is a
        // legitimate pause (not a nudge), so it resets the give-up budget; a
        // dismissed / interrupted dialog falls through to the bounded nudge path
        // so repeated dismissals can't loop forever. Guarded on NEW text, same as
        // completion above — never a stale marker from the prior phase.
        if (text !== textAtSend && isNeedInput(text)) {
          const resp = await session.requestUserInput({
            method: "input",
            title: "The agent needs your input to continue this phase",
            message: stripNeedInputMarker(text),
            placeholder: "Type your answer…",
          });
          if (session.turnInterrupted) return { finalStatus: "idle", text };
          if (!resp.cancelled && resp.value && resp.value.trim().length > 0) {
            pendingSend = resp.value;
            nudges = 0;
            continue;
          }
          if (nudges >= MAX_PHASE_NUDGES) return { finalStatus: "idle", text };
          nudges += 1;
          pendingSend = PHASE_NO_INPUT_NUDGE;
          continue;
        }
        // Rested with new output but no marker (an intermediate pause). Nudge to
        // continue, bounded; after the cap, hand what it has to the human review
        // boundary so a never-completing model still reaches Approve/Reject.
        if (nudges >= MAX_PHASE_NUDGES) return { finalStatus: "idle", text };
        nudges += 1;
        pendingSend = PHASE_CONTINUE_NUDGE;
      }
    } finally {
      this.#phaseWaiters.delete(req.sessionId);
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
      onModels: (providerId, m) => this._cacheModels(providerId, m),
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
        if (p.feedback && p.feedback.length > 0) w.feedback = p.feedback;
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
      });
      return { type: "pipeline.snapshot", requestId: msg.id, pipeline: this.#pipelineToWire(state) };
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
          onModels: (providerId, m) => this._cacheModels(providerId, m),
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
          await session.send(
            this.#fleetEventsBody(batch),
            this.#dispatchSystemAuth(accountId, projectId),
          );
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
    };
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
        const providerId = provider ?? DEFAULT_PROVIDER_ID;
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
        return { ok: true, provider, model: resolved };
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
      sessions.push({ ...info, attachedClients: session.attachedClientCount });
    }

    return { type: "session.list.result", requestId: msg.id, sessions };
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

    // Fire and forget — output streams to attached clients. The user message
    // is persisted synchronously at the top of session.send() before any
    // fallible work, so a later throw can't lose it. Surface that throw as a
    // visible system message instead of swallowing it (the old `.catch(() => {})`
    // returned a false "ok" and dropped the error — silent data loss).
    // priority controls mid-turn insertion semantics (default "later" = FIFO).
    session
      .send(msg.text, auth, msg.attachments, msg.priority)
      .catch((err) => session.reportSendFailure(err));

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
   *   - `scope: "all"` → search across every workspace the memory store has
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
      ...(scope === "all" ? {} : { workspaceId }),
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

    session.approve(msg.approvalId, msg.approved, auth, msg.updatedInput);
    return { type: "response.ok", requestId: msg.id };
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
