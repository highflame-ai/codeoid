/**
 * Dispatcher — the durable work-queue backbone for send-class fleet actions
 * (P4, hermes-Kanban pattern). The queue in the Store — not the conductor's
 * turn — owns every dispatch's lifecycle, so tasks survive daemon restarts:
 *
 *   fleet_send / fleet_spawn (owner-approved)  →  dispatch_tasks (queued)
 *   tick: reclaim stale → claim (atomic) → execute
 *     send  → deliver prompt to the target session → done
 *     spawn → create a leaf worker (delegated identity, autonomous budget)
 *             → watch its turn → digest → done → destroy worker
 *   completion → dispatch_events (durable) → batched injection into the
 *   conductor session when it's idle (burst-collapse, never raw transcript)
 *
 * Crash-safety invariants:
 *   - claim_owner is the daemon BOOT id. Any claim held by another boot is a
 *     crashed run; the first tick reclaims it (attempts++). A worker that
 *     keeps dying across restarts burns through failure_limit and lands in
 *     'blocked' — the stuck-loop escalation, in queue form.
 *   - The lease only renews while the worker session is verifiably alive and
 *     not wedged; a hung or approval-wedged worker stops renewing and the
 *     lease expiry reclaims the task.
 *   - Events are written before delivery and marked delivered after — a
 *     crash between "worker finished" and "conductor saw it" re-delivers.
 */

import { randomUUID } from "node:crypto";
import type { DispatchEventRow, DispatchTaskRow, Store } from "./store.js";
import type { SessionStatus } from "../protocol/types.js";

export interface DispatchConfig {
  enabled: boolean;
  /** Dispatcher tick interval (claim/reclaim/deliver cadence). */
  tickMs: number;
  /** Claim lease — a task not renewed within this window is reclaimable. */
  leaseMs: number;
  /** Consecutive failures (incl. reclaims) before a task auto-blocks. */
  failureLimit: number;
  /** Max concurrently running spawn tasks per tenant. */
  maxConcurrentWorkers: number;
  /** Autonomous tool-call budget handed to each spawned worker. */
  workerToolBudget: number;
  /**
   * Base retry backoff for retryable failures (doubles per attempt, capped
   * at the lease). Without this, a failing task would be re-claimed within
   * the SAME tick and burn its whole failure budget in milliseconds.
   */
  retryBaseMs: number;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  enabled: true,
  tickMs: 5_000,
  leaseMs: 10 * 60_000,
  failureLimit: 2,
  maxConcurrentWorkers: 2,
  workerToolBudget: 50,
  retryBaseMs: 15_000,
};

/** Thrown by host methods when retrying can never succeed (target gone, bad input). */
export class NonRetryableDispatchError extends Error {}

/**
 * The execution surface the SessionManager implements. Deliberately narrow:
 * the dispatcher owns lifecycle/ordering; the host owns sessions.
 */
export interface DispatcherHost {
  /** Deliver a prompt to an existing session. Throws NonRetryableDispatchError when the target is gone. */
  sendToSession(task: DispatchTaskRow): Promise<void>;
  /** Create a leaf worker for a spawn task and send it its prompt. Returns the worker session id. */
  spawnWorker(task: DispatchTaskRow): Promise<{ sessionId: string }>;
  /**
   * Continue a spawn task in its existing (resumed) worker session after a
   * restart/reclaim. Returns false when the session no longer exists — the
   * dispatcher then falls back to a fresh spawn.
   */
  continueWorker(task: DispatchTaskRow): Promise<boolean>;
  /** Live status of a worker session, or null when it no longer exists. */
  workerStatus(sessionId: string): SessionStatus | null;
  /** Compressed completion digest for a finished worker — never raw transcript. */
  buildWorkerDigest(task: DispatchTaskRow): string;
  /** Tear down a finished worker session (best-effort). */
  destroyWorker(sessionId: string, reason: string): Promise<void>;
  /**
   * Inject pending events into the tenant's conductor session as ONE batched
   * turn. Returns true when delivered; false when held (conductor missing or
   * busy — the events stay pending and re-try next tick).
   */
  deliverEvents(
    accountId: string,
    projectId: string,
    events: DispatchEventRow[],
  ): Promise<boolean>;
  audit(action: string, detail: string): void;
}

/** Statuses that mean "the worker's current turn is still in flight". */
const WORKER_ACTIVE: ReadonlySet<string> = new Set([
  "thinking",
  "tool_running",
]);

export class Dispatcher {
  readonly bootId = randomUUID();
  #store: Store;
  #host: DispatcherHost;
  #config: DispatchConfig;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** worker session id → task id, for routing status transitions. */
  #watched = new Map<string, string>();
  /** Re-entrancy guard — a slow tick must not overlap the next. */
  #ticking = false;
  #deliveringEvents = false;

  constructor(store: Store, host: DispatcherHost, config?: Partial<DispatchConfig>) {
    this.#store = store;
    this.#host = host;
    this.#config = { ...DEFAULT_DISPATCH_CONFIG, ...config };
  }

  get config(): DispatchConfig {
    return this.#config;
  }

  /** Task currently watched for a worker session (undefined = not a worker). */
  taskForWorker(sessionId: string): string | undefined {
    return this.#watched.get(sessionId);
  }

  start(): void {
    if (!this.#config.enabled || this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#config.tickMs);
    // Never hold the event loop open — mirrors the OAuth sweeper lifecycle.
    (this.#timer as unknown as { unref?: () => void }).unref?.();
    void this.tick(); // first pass immediately: boot-time reclaim + resume
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Enqueue a task (called from the approved fleet_send/fleet_spawn
   * handlers). Returns the task id; execution happens on the next tick.
   */
  enqueue(input: {
    accountId: string;
    projectId: string;
    kind: "send" | "spawn";
    shape: "ship" | "scout";
    targetSession?: string;
    workdir?: string;
    prompt: string;
    /**
     * Backend the spawned worker runs on. Omit for the daemon default.
     * Validated by the caller (the fleet tool / SessionManager) against the
     * provider registry — the dispatcher persists it and hands it to the
     * host, it does not resolve it. Meaningless on `kind: "send"`, which
     * targets a session that already has its own provider.
     */
    provider?: string;
    /** Per-child model, already resolved against `provider`. */
    model?: string;
    createdBy: string;
  }): string {
    const id = randomUUID();
    this.#store.dispatchEnqueue({
      id,
      ...input,
      failureLimit: this.#config.failureLimit,
      now: Date.now(),
    });
    this.#host.audit(
      "dispatch.enqueued",
      `task=${id} kind=${input.kind} shape=${input.shape} target=${input.targetSession ?? input.workdir ?? "-"}` +
        `${input.provider ? ` provider=${input.provider}` : ""}${input.model ? ` model=${input.model}` : ""}`,
    );
    return id;
  }

  /**
   * One dispatcher pass: reclaim stale claims, renew live leases, claim +
   * execute ready tasks, deliver pending conductor events. Public so tests
   * drive it deterministically without timers.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      this.#reclaimStale();
      this.#renewLiveLeases();
      await this.#claimAndExecute();
      await this.#deliverPendingEvents();
    } catch (err) {
      console.error(
        `[codeoid/dispatch] tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Status-transition router — the SessionManager calls this for every
   * session status change; non-worker sessions are ignored. This is how a
   * worker's turn completion becomes a digest without polling.
   */
  onSessionStatus(sessionId: string, status: SessionStatus): void {
    const taskId = this.#watched.get(sessionId);
    if (!taskId) return;
    if (status === "idle" || status === "error") {
      this.#watched.delete(sessionId);
      void this.#finishWorkerTask(taskId, sessionId, status);
    } else if (status === "waiting_approval") {
      // The worker wedged: autonomous budget exhausted or a gated tool. With
      // no client attached nobody can approve — surface it to the conductor
      // and STOP renewing the lease; expiry reclaims (attempts++) and either
      // retries fresh or auto-blocks. The owner can also attach and approve
      // before the lease runs out — then the turn simply continues.
      const task = this.#store.dispatchGet(taskId);
      if (task) {
        this.#emitEvent(task, "task_failed", // type refined below if it recovers
          `worker for task ${task.id.slice(0, 8)} (${task.shape}) is WAITING FOR APPROVAL in session ${sessionId.slice(0, 8)} — its autonomous tool budget is exhausted or it hit a gated tool. Attach and approve to let it continue, or it will be reclaimed when the lease expires.`,
          { keepPending: true },
        );
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Exponential retry backoff: base × 2^attempts, capped at the lease. */
  #retryAt(attemptsSoFar: number, now: number): number {
    return now + Math.min(this.#config.retryBaseMs * 2 ** attemptsSoFar, this.#config.leaseMs);
  }

  #reclaimStale(): void {
    const reclaimed = this.#store.dispatchReclaimStale(
      this.bootId,
      this.#config.leaseMs,
      Date.now(),
    );
    for (const task of reclaimed) {
      if (task.workerSessionId) this.#watched.delete(task.workerSessionId);
      this.#host.audit(
        "dispatch.reclaimed",
        `task=${task.id} attempts=${task.attempts} status=${task.status}`,
      );
      if (task.status === "blocked") {
        this.#emitEvent(
          task,
          "task_blocked",
          `task ${task.id.slice(0, 8)} (${task.kind}/${task.shape}) auto-BLOCKED after ${task.attempts} failed attempt(s): ${task.error ?? "stale claim"}. It will not retry; inspect with fleet_tasks.`,
        );
        // Terminal at reclaim — a surviving worker session (e.g. resumed
        // after the crash that burned the last attempt) must not be
        // orphaned. Same rule as the other two terminal paths.
        if (task.kind === "spawn" && task.workerSessionId) {
          void this.#host.destroyWorker(
            task.workerSessionId,
            `task ${task.id} blocked at reclaim`,
          );
        }
      }
    }
  }

  /** Renew leases only for workers that are verifiably alive AND working. */
  #renewLiveLeases(): void {
    const alive: string[] = [];
    for (const [sessionId, taskId] of this.#watched) {
      const status = this.#host.workerStatus(sessionId);
      if (status && WORKER_ACTIVE.has(status)) alive.push(taskId);
      // idle/error are handled by onSessionStatus; waiting_approval and a
      // vanished session deliberately do NOT renew — the lease reclaims them.
    }
    this.#store.dispatchTouch(alive, Date.now());
  }

  async #claimAndExecute(): Promise<void> {
    // Claim one at a time (each claim is atomic) until nothing is ready.
    // Two invariants, both enforced via the per-tick `touched` exclusion:
    //  - a task executes AT MOST ONCE per tick (a retryable failure requeues
    //    it, and without the exclusion this loop would re-claim it instantly
    //    and burn its whole failure budget in one tick);
    //  - a cap deferral skips ONLY that task — sends behind it and OTHER
    //    tenants' spawns keep flowing (a single capped tenant must never
    //    starve the rest of the queue).
    const touched: string[] = [];
    for (;;) {
      const task = this.#store.dispatchClaimNext(this.bootId, Date.now(), touched);
      if (!task) return;
      touched.push(task.id);
      if (
        task.kind === "spawn" &&
        this.#store.dispatchActiveSpawnCount(task.accountId, task.projectId) >
          this.#config.maxConcurrentWorkers
      ) {
        // Over the cap (the fresh claim itself counts, hence >): release the
        // claim untouched — a scheduling deferral, not a failure, so no
        // attempt is burned; retried next tick.
        this.#store.dispatchRelease(task.id, Date.now());
        continue;
      }
      await this.#execute(task);
    }
  }

  async #execute(task: DispatchTaskRow): Promise<void> {
    const now = Date.now();
    try {
      if (task.kind === "send") {
        await this.#host.sendToSession(task);
        this.#store.dispatchComplete(
          task.id,
          `delivered to session ${task.targetSession?.slice(0, 8) ?? "?"}`,
          Date.now(),
        );
        this.#host.audit("dispatch.sent", `task=${task.id} target=${task.targetSession}`);
        return;
      }

      // spawn: continue a surviving worker (post-restart) or create fresh.
      if (task.workerSessionId) {
        const continued = await this.#host.continueWorker(task);
        if (continued) {
          this.#store.dispatchMarkRunning(task.id, task.workerSessionId, now);
          this.#watched.set(task.workerSessionId, task.id);
          this.#host.audit(
            "dispatch.continued",
            `task=${task.id} worker=${task.workerSessionId}`,
          );
          return;
        }
        // Worker didn't survive the restart — fall through to a fresh spawn.
      }
      const { sessionId } = await this.#host.spawnWorker(task);
      this.#store.dispatchMarkRunning(task.id, sessionId, Date.now());
      this.#watched.set(sessionId, task.id);
      this.#host.audit("dispatch.spawned", `task=${task.id} worker=${sessionId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = !(err instanceof NonRetryableDispatchError);
      const now = Date.now();
      const status = this.#store.dispatchFail(task.id, message, now, {
        retryable,
        notBefore: retryable ? this.#retryAt(task.attempts, now) : undefined,
      });
      this.#host.audit(
        "dispatch.failed",
        `task=${task.id} retryable=${retryable} status=${status} error=${message.slice(0, 200)}`,
      );
      if (status === "failed" || status === "blocked") {
        const refreshed = this.#store.dispatchGet(task.id) ?? task;
        this.#emitEvent(
          refreshed,
          status === "blocked" ? "task_blocked" : "task_failed",
          `task ${task.id.slice(0, 8)} (${task.kind}/${task.shape}) ${status.toUpperCase()}: ${message.slice(0, 300)}`,
        );
        // A terminal spawn failure must not orphan a surviving worker (e.g.
        // a continueWorker attempt that threw after the session was found) —
        // mirror #finishWorkerTask's blocked-path teardown.
        if (task.kind === "spawn" && task.workerSessionId) {
          this.#watched.delete(task.workerSessionId);
          await this.#host.destroyWorker(
            task.workerSessionId,
            `task ${task.id} ${status}`,
          );
        }
      }
    }
  }

  /** Worker turn ended — digest, complete/fail, notify, tear down. */
  async #finishWorkerTask(
    taskId: string,
    sessionId: string,
    status: "idle" | "error",
  ): Promise<void> {
    const task = this.#store.dispatchGet(taskId);
    if (!task || (task.status !== "running" && task.status !== "claimed")) return;

    try {
      // Digest BEFORE teardown — it reads the live session + memory.
      const digest = this.#host.buildWorkerDigest(task);
      if (status === "idle") {
        this.#store.dispatchComplete(task.id, digest, Date.now());
        this.#emitEvent(task, "task_done", digest);
        this.#host.audit("dispatch.done", `task=${task.id} worker=${sessionId}`);
        // Disposable children (design R2): the work products live in the
        // workdir/git and the digest in the task row — the session itself
        // has no reason to outlive the turn.
        await this.#host.destroyWorker(sessionId, `task ${task.id} done`);
      } else {
        const failNow = Date.now();
        const failStatus = this.#store.dispatchFail(
          task.id,
          "worker turn ended in error",
          failNow,
          { retryable: true, notBefore: this.#retryAt(task.attempts, failNow) },
        );
        if (failStatus === "blocked") {
          this.#emitEvent(
            task,
            "task_blocked",
            `task ${task.id.slice(0, 8)} auto-BLOCKED after repeated worker errors. Last digest:\n${digest}`,
          );
          await this.#host.destroyWorker(sessionId, `task ${task.id} blocked`);
        }
        // retryable requeue keeps the worker session for continuation.
        this.#host.audit(
          "dispatch.worker_error",
          `task=${task.id} worker=${sessionId} status=${failStatus}`,
        );
      }
    } catch (err) {
      console.error(
        `[codeoid/dispatch] finishing task ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  #emitEvent(
    task: DispatchTaskRow,
    type: "task_done" | "task_failed" | "task_blocked",
    digest: string,
    opts?: { keepPending?: boolean },
  ): void {
    this.#store.dispatchEventAdd({
      accountId: task.accountId,
      projectId: task.projectId,
      taskId: task.id,
      type,
      digest,
      now: Date.now(),
    });
    if (!opts?.keepPending) {
      // Try to deliver promptly rather than waiting a full tick.
      void this.#deliverPendingEvents();
    }
  }

  async #deliverPendingEvents(): Promise<void> {
    // Re-entrancy guard (mirrors #ticking): the periodic tick() and the eager
    // void-call from #emitEvent can both land here. Without this, both read the
    // same pending batch (events are marked delivered only AFTER an awaited
    // conductor.send, and the conductor's status hasn't flipped off "idle" yet),
    // so the conductor gets the same <fleet_events> batch twice — duplicate
    // token spend and a duplicate owner summary.
    if (this.#deliveringEvents) return;
    this.#deliveringEvents = true;
    try {
      for (const tenant of this.#store.dispatchEventTenants()) {
        const events = this.#store.dispatchEventsPending(
          tenant.accountId,
          tenant.projectId,
        );
        if (events.length === 0) continue;
        try {
          const delivered = await this.#host.deliverEvents(
            tenant.accountId,
            tenant.projectId,
            events,
          );
          if (delivered) {
            this.#store.dispatchEventsMarkDelivered(
              events.map((e) => e.id),
              Date.now(),
            );
          }
        } catch (err) {
          console.error(
            `[codeoid/dispatch] event delivery failed (kept pending): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.#deliveringEvents = false;
    }
  }
}
