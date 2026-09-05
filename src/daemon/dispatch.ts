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
  /**
   * Stable identity (host:port) of the daemon that owns the tasks it enqueues,
   * scoping claim and reclaim to its own work.
   *
   * `claim_owner` is a BOOT id, which cannot tell "my own crashed run" apart
   * from "another daemon's healthy claim" — so two daemons sharing one
   * database reclaimed each other's in-flight tasks and auto-blocked work that
   * had actually succeeded, and could claim across tenants. Port-scoped for
   * the same reason `local-mode.md` port-scopes its token file: the port is
   * what distinguishes two daemons on one machine, and it survives restarts.
   *
   * Undefined leaves tasks unowned (claimable by anyone) — the pre-upgrade
   * path, and the default in tests that run a single dispatcher.
   */
  daemonId?: string;
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
   * Inject pending events into whichever session each one belongs to, batched
   * per target — the tenant's conductor for its own dispatches, and the
   * originating ORCHESTRATOR for a collaboration's.
   *
   * Returns the ids it actually delivered. Not a boolean: with several possible
   * targets, "one recipient is mid-turn" is a normal state, and an all-or-nothing
   * answer would either hold an idle recipient's events back or re-deliver them
   * later as duplicates. Anything omitted stays pending and is retried.
   */
  deliverEvents(
    accountId: string,
    projectId: string,
    events: DispatchEventRow[],
  ): Promise<readonly number[]>;
  audit(action: string, detail: string): void;
  /**
   * The task board changed — fleet subscribers need deltas
   * (docs/conductor-frontends-design.md §11).
   *
   * Signalled once per entry path (enqueue, group enqueue, end of tick) rather
   * than at each of the ~14 individual store mutations. Every mutation happens
   * inside one of those paths, so this is complete by construction and cannot
   * be missed by a future mutation added inside the tick. The host derives the
   * precise deltas from its own watermark; this only says "something moved".
   *
   * Optional: a host with no connected clients (tests, a Telegram-only daemon)
   * simply omits it.
   */
  onBoardChange?(): void;
}

/**
 * Terminal statuses — a task in one of these will never run again.
 *
 * Exported because the barrier and the client-facing panel view must agree on
 * it: the barrier joins when every member is terminal, and the UI renders
 * "settled" from the same rule. They were two separate literals in two files,
 * so adding a status would have left the sidebar quietly disagreeing with the
 * barrier about whether a fan-out had finished.
 */
export const TERMINAL_TASK_STATUS: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "blocked",
]);

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
  /**
   * session id → the task ids currently watching it, for routing status
   * transitions.
   *
   * A SET, not a single id. Every watched session used to be a freshly-created
   * spawn worker, unique by construction — but a grouped send watches a
   * PRE-EXISTING session, and the same role-child can legitimately be the target
   * of two live dispatches (a second panel, or a plain `fleet_send` alongside a
   * running one). With one id per key the second registration silently evicted
   * the first, whose task then sat in `running` until the lease expired — and
   * its barrier hung for the whole lease with it.
   */
  #watched = new Map<string, Set<string>>();

  /** Register a task as watching `sessionId`. */
  #watch(sessionId: string, taskId: string): void {
    const existing = this.#watched.get(sessionId);
    if (existing) existing.add(taskId);
    else this.#watched.set(sessionId, new Set([taskId]));
  }

  /** Stop watching one task; drops the key when it was the last watcher. */
  #unwatch(sessionId: string, taskId?: string): void {
    const set = this.#watched.get(sessionId);
    if (!set) return;
    if (taskId === undefined) {
      this.#watched.delete(sessionId);
      return;
    }
    set.delete(taskId);
    if (set.size === 0) this.#watched.delete(sessionId);
  }
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
    // First (and usually only) watcher. A spawn worker always has exactly one;
    // a shared send target can have several, and this accessor exists for the
    // spawn case — see `tasksForSession` when you need all of them.
    const set = this.#watched.get(sessionId);
    return set ? set.values().next().value : undefined;
  }

  /** Every task currently watching `sessionId`. */
  tasksForSession(sessionId: string): string[] {
    return [...(this.#watched.get(sessionId) ?? [])];
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
      ownerDaemon: this.#config.daemonId,
      now: Date.now(),
    });
    this.#host.audit(
      "dispatch.enqueued",
      `task=${id} kind=${input.kind} shape=${input.shape} target=${input.targetSession ?? input.workdir ?? "-"}` +
        `${input.provider ? ` provider=${input.provider}` : ""}${input.model ? ` model=${input.model}` : ""}`,
    );
    this.#signalBoardChange();
    return id;
  }

  /**
   * Fan one task out to N targets as a dispatch GROUP — the barrier primitive
   * (docs/collaborative-session-design.md §7 step 3).
   *
   * The members run exactly like standalone tasks; the only difference is what
   * happens when they finish. Instead of N separate completion events arriving
   * one at a time, the group's members stay silent until the LAST one reaches a
   * terminal state, and then one merged event lands. That is the whole point:
   * §7's synthesis step needs every reviewer's verdict in a single turn, and N
   * trickling events give the orchestrator N chances to synthesize early from
   * partial input — which is how a panel silently degrades into a race.
   *
   * All members are inserted before any tick can observe the group, so the
   * barrier can never see a half-built group and fire on member 1 of 3.
   */
  enqueueGroup(input: {
    accountId: string;
    projectId: string;
    createdBy: string;
    /** Same brief for every member; each gets its own target. */
    prompt: string;
    members: Array<{
      kind: "send" | "spawn";
      shape: "ship" | "scout";
      targetSession?: string;
      workdir?: string;
      provider?: string;
      model?: string;
      /** Per-member brief; falls back to the shared `prompt`. */
      prompt?: string;
    }>;
  }): { groupId: string; taskIds: string[] } {
    const groupId = randomUUID();
    const now = Date.now();
    const taskIds: string[] = [];
    const rows = input.members.map((m, i) => {
      const id = randomUUID();
      taskIds.push(id);
      return {
        id,
        accountId: input.accountId,
        projectId: input.projectId,
        kind: m.kind,
        shape: m.shape,
        targetSession: m.targetSession,
        workdir: m.workdir,
        prompt: m.prompt ?? input.prompt,
        provider: m.provider,
        model: m.model,
        failureLimit: this.#config.failureLimit,
        createdBy: input.createdBy,
        groupId,
        groupOrdinal: i + 1,
        ownerDaemon: this.#config.daemonId,
        now,
      };
    });
    this.#store.dispatchEnqueueGroup(rows);
    this.#host.audit(
      "dispatch.group_enqueued",
      `group=${groupId} members=${taskIds.length} targets=${input.members
        .map((m) => m.targetSession ?? m.workdir ?? "-")
        .join(",")
        .slice(0, 300)}`,
    );
    this.#signalBoardChange();
    return { groupId, taskIds };
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
      // In `finally`, and after `#ticking` is cleared: a tick that threw
      // part-way through has still usually moved some tasks, and a board that
      // silently stopped updating after one bad tick is worse than a delta the
      // client can reconcile. Never allowed to throw into the tick.
      this.#signalBoardChange();
    }
  }

  /** Tell the host the board moved. Failure here must never break dispatch. */
  #signalBoardChange(): void {
    try {
      this.#host.onBoardChange?.();
    } catch (err) {
      console.error(
        `[codeoid/dispatch] board-change notify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Status-transition router — the SessionManager calls this for every
   * session status change; non-worker sessions are ignored. This is how a
   * worker's turn completion becomes a digest without polling.
   */
  onSessionStatus(sessionId: string, status: SessionStatus): void {
    const taskIds = this.tasksForSession(sessionId);
    if (taskIds.length === 0) return;
    if (status === "idle" || status === "error") {
      // Every task watching this session completes on the same transition —
      // dropping all but one is what left a panel member's task orphaned.
      for (const taskId of taskIds) {
        this.#unwatch(sessionId, taskId);
        void this.#finishWorkerTask(taskId, sessionId, status);
      }
      return;
    }
    if (status === "waiting_approval") {
      // The worker wedged: autonomous budget exhausted or a gated tool. With
      // no client attached nobody can approve — surface it to the conductor
      // and STOP renewing the lease; expiry reclaims (attempts++) and either
      // retries fresh or auto-blocks. The owner can also attach and approve
      // before the lease runs out — then the turn simply continues.
      for (const taskId of taskIds) {
        const task = this.#store.dispatchGet(taskId);
        if (!task) continue;
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
      this.#config.daemonId,
    );
    for (const task of reclaimed) {
      if (task.workerSessionId) this.#unwatch(task.workerSessionId, task.id);
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
    for (const [sessionId, taskIds] of this.#watched) {
      const status = this.#host.workerStatus(sessionId);
      // Every task watching a live session renews — a shared target keeps all
      // of its dispatches leased, not just whichever registered first.
      if (status && WORKER_ACTIVE.has(status)) alive.push(...taskIds);
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
      const task = this.#store.dispatchClaimNext(
        this.bootId,
        Date.now(),
        touched,
        this.#config.daemonId,
      );
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
        // A GROUPED send completes when its target finishes the WORK, not when
        // the prompt is handed over. An ungrouped send has always meant
        // "delivered" and still does — nobody is joining on it. But a barrier
        // over delivery-completion would fire the instant all N briefs were
        // handed out, before a single reviewer had read anything, and a panel
        // that joins on nothing is worse than no panel.
        if (task.groupId && task.targetSession) {
          return await this.#startGroupedSend(task, now);
        }
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
          this.#watch(task.workerSessionId, task.id);
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
      this.#watch(sessionId, task.id);
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
          this.#unwatch(task.workerSessionId, task.id);
          await this.#host.destroyWorker(
            task.workerSessionId,
            `task ${task.id} ${status}`,
          );
        }
      }
    }
  }

  /** Worker turn ended — digest, complete/fail, notify, tear down. */
  /**
   * Deliver (or re-attach to) a grouped send and watch its target to completion.
   *
   * Three things make this different from the spawn path it borrows from:
   *
   *  1. **The target is not disposable.** It is a long-lived role-child, so
   *     `#finishWorkerTask` must not tear it down — see the `kind === "spawn"`
   *     guard there.
   *  2. **Re-delivery is not idempotent.** After a restart the task is
   *     requeued and re-executed, and blindly re-sending would hand the
   *     reviewer its brief twice. `workerSessionId` being set is the marker
   *     that delivery already happened, so this re-WATCHES instead.
   *  3. **The turn may have finished while the daemon was down.** Re-watching
   *     an already-idle target would wait for a transition that never comes,
   *     until the lease expired and burned an attempt. So the current status
   *     decides: still working → watch; already settled → finish now; gone →
   *     fail non-retryably, and the barrier joins with that member marked
   *     failed rather than hanging on it.
   */
  async #startGroupedSend(task: DispatchTaskRow, now: number): Promise<void> {
    const target = task.targetSession!;
    const alreadyDelivered = task.workerSessionId !== null;

    if (alreadyDelivered) {
      const status = this.#host.workerStatus(target);
      if (!status) {
        throw new NonRetryableDispatchError(
          `panel target ${target.slice(0, 8)} no longer exists`,
        );
      }
      this.#store.dispatchMarkRunning(task.id, target, now);
      if (!WORKER_ACTIVE.has(status)) {
        // Settled while we were away — complete from what it left behind.
        await this.#finishWorkerTask(task.id, target, status === "error" ? "error" : "idle");
        return;
      }
      this.#watch(target, task.id);
      this.#host.audit(
        "dispatch.group_rewatched",
        `task=${task.id} group=${task.groupId} target=${target} status=${status}`,
      );
      return;
    }

    // Marked running BEFORE the send, deliberately. `running` is already a
    // reclaimable state, so ordering it first costs nothing — whereas marking
    // it after leaves a window where a crash between delivery and the marker
    // makes the retry re-send, and the reviewer works its brief twice while the
    // digest describes only the second pass.
    this.#store.dispatchMarkRunning(task.id, target, now);
    this.#watch(target, task.id);
    await this.#host.sendToSession(task);
    this.#host.audit(
      "dispatch.group_sent",
      `task=${task.id} group=${task.groupId} target=${target}`,
    );
  }

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
        //
        // ONLY a spawned worker. A `send` task's target is a session that
        // existed before the task and must outlive it — for a panel member that
        // is a long-lived ROLE-CHILD, and destroying it would tear down the
        // fleet mid-goal every time a panel joined. Sends never reached this
        // path until grouped sends started being watched here.
        if (task.kind === "spawn") {
          await this.#host.destroyWorker(sessionId, `task ${task.id} done`);
        }
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
          // Same rule as the done path: only a spawned worker is ours to destroy.
          if (task.kind === "spawn") {
            await this.#host.destroyWorker(sessionId, `task ${task.id} blocked`);
          }
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

  /**
   * The BARRIER (docs/collaborative-session-design.md §7 step 3).
   *
   * Called on every terminal transition of a grouped task, in place of that
   * task's own completion event. Returns true when it handled the event —
   * either by absorbing it (the group is still running) or by emitting the
   * merged one (this member was the last).
   *
   * Fires on ALL-TERMINAL, not all-done. A panel where one reviewer errors must
   * still join: waiting for success would hang the goal on its weakest member,
   * and §7 is explicit that disagreement is shown rather than hidden — a failed
   * reviewer is a form of that, so it appears in the merged digest as a failure
   * rather than being silently dropped or blocking its peers forever.
   *
   * Idempotent by construction: the merged event is emitted by whichever member
   * observes the last terminal transition, and a member can only transition to
   * terminal once (the store's status guard), so exactly one emission happens.
   */
  #barrierAbsorb(task: DispatchTaskRow): boolean {
    if (!task.groupId) return false;
    const members = this.#store.dispatchGroupMembers(
      task.accountId,
      task.projectId,
      task.groupId,
    );
    // A group of one is a fan-out of one; still joins, and the digest shape
    // stays identical so a synthesizing orchestrator has no special case.
    if (members.length === 0) return false;

    // Absorb only this member's COMPLETION. `#emitEvent` is also how a wedged
    // worker is reported (`waiting_approval`, still `running`), and that notice
    // is the one message whose entire purpose is to reach a human — absorbing it
    // left a panel member stuck with nobody told, until the lease expired.
    // Checking THIS member's status rather than the event type keeps the rule in
    // one place: a non-terminal task has not completed, so it is not the
    // barrier's business.
    const self = members.find((m) => m.id === task.id);
    if (!self || !TERMINAL_TASK_STATUS.has(self.status)) return false;

    const pending = members.filter((m) => !TERMINAL_TASK_STATUS.has(m.status));
    if (pending.length > 0) {
      this.#host.audit(
        "dispatch.group_waiting",
        `group=${task.groupId} done=${members.length - pending.length}/${members.length} last=${task.id}`,
      );
      return true; // absorbed — no event yet
    }
    this.#emitGroupEvent(task, members);
    return true;
  }

  /**
   * One merged event for a joined group: per-member outcome plus each member's
   * digest, in fan-out order.
   *
   * Deliberately NOT a verdict. §7 forbids a silent auto-vote — the merge is
   * mechanical (collect, label, order) and the *judgement* is the orchestrator's
   * synthesis step or a human's. Counting votes here would bury exactly the
   * disagreement the panel exists to surface.
   */
  #emitGroupEvent(last: DispatchTaskRow, members: readonly DispatchTaskRow[]): void {
    const failed = members.filter((m) => m.status !== "done");
    const lines = members.map((m, i) => {
      const target = m.targetSession?.slice(0, 8) ?? m.workdir ?? "-";
      // Position from the stored ordinal, falling back to array index for a
      // group written before group_ordinal existed.
      const pos = m.groupOrdinal ?? i + 1;
      const head = `${pos}. ${m.status.toUpperCase()} — ${target} (${m.kind}/${m.shape})`;
      const body = m.status === "done" ? m.resultDigest : (m.error ?? "no error recorded");
      return `${head}
${body ?? "no digest"}`;
    });
    const header =
      failed.length === 0
        ? `Panel of ${members.length} joined — all completed.`
        : `Panel of ${members.length} joined — ${members.length - failed.length} completed, ${failed.length} did not.`;
    this.#store.dispatchEventAdd({
      accountId: last.accountId,
      projectId: last.projectId,
      // Attributed to the member that closed the barrier. The group id is in
      // the digest, so the orchestrator can still correlate the whole fan-out.
      taskId: last.id,
      type: "group_done",
      digest: [
        header,
        `group=${last.groupId}`,
        "",
        ...lines,
        "",
        "Every member is finished. Synthesize now: read each role's artifact from the blackboard, merge, and SHOW disagreement rather than resolving it silently.",
      ].join("\n"),
      now: Date.now(),
    });
    this.#host.audit(
      "dispatch.group_joined",
      `group=${last.groupId} members=${members.length} failed=${failed.length}`,
    );
    void this.#deliverPendingEvents();
  }

  #emitEvent(
    task: DispatchTaskRow,
    type: "task_done" | "task_failed" | "task_blocked",
    digest: string,
    opts?: { keepPending?: boolean },
  ): void {
    // A grouped task's completion is the barrier's business, not its own.
    if (this.#barrierAbsorb(task)) return;
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
          // Mark exactly what the host says it delivered. Marking the whole
          // batch on a partial success would silently drop the rest.
          if (delivered.length > 0) {
            this.#store.dispatchEventsMarkDelivered([...delivered], Date.now());
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
