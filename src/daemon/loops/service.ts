/**
 * LoopService — the controller behind loops (docs/loop-engineering-design.md).
 *
 * A repair run, end to end:
 *
 *   1. Prepare: a worktree of the user's repo on its own branch, made ready by
 *      the repository's setup recipe. The user's checkout is never touched.
 *   2. Baseline: run the checks on the unmodified tree. A run whose checks
 *      already pass has nothing to repair and stops `blocked`, never credited
 *      as a repair.
 *   3. Attempt: queued on the dispatcher (the only scheduler — no second queue).
 *      The worker is one session for the whole run, autonomous within a tool
 *      budget and a wall-time limit, and ends an attempt by calling
 *      `loop_report`.
 *   4. Verify: the daemon snapshots the workspace, runs every check against
 *      that tree, and records the evidence. A worker's report is a request to
 *      verify, never a verdict.
 *   5. Decide: every check passed → deliver (commit the candidate to the run's
 *      branch) and complete; the worker reported a conflict → blocked; it
 *      asked a question → waiting; otherwise the next attempt, until the
 *      attempt or time budget is spent.
 *
 * Every transition is a compare-and-set on the run's state version, and the
 * service serializes its own work per run, so a late worker, a racing cancel,
 * and a restart all see one consistent history.
 *
 * The service reaches sessions, the dispatcher, git, and evidence only through
 * `LoopHost`, so it is testable without a SessionManager.
 */

import type { CheckRun } from "../evidence/service.js";
import type { CheckSpec, EvidenceRecord } from "../evidence/types.js";
import { answerPrompt, firstAttemptPrompt, nextAttemptPrompt, takeoverPreamble, withSteering } from "./prompt.js";
import type { LoopStore, LoopTenant, RunPatch } from "./store.js";
import type { LoopReportInput } from "./tools.js";
import { isRepo } from "./triggers/github.js";
import {
  APPROVAL_WAIT,
  QUESTION_WAIT_PREFIX,
  isTerminalLoopStatus,
  LOOP_DEFAULTS,
  LOOP_LIMITS,
  LoopWorkspaceUnsupportedError,
  WORKSPACE_UNSUPPORTED_EVENT,
  type AttemptResult,
  type LoopAttemptRow,
  type LoopBaseRef,
  type LoopCheck,
  type LoopContract,
  type LoopRunRow,
  type LoopStatus,
  type LoopTrigger,
} from "./types.js";

// ── Host seam ────────────────────────────────────────────────────────────────

export interface LoopOwner {
  sub: string;
  name?: string;
  accountId: string;
  projectId: string;
}

export interface PreparedWorkspace {
  worktreePath: string;
  worktreeRoot: string;
  gitDir: string;
  commonDir: string;
  branch: string;
  baseRevision: string;
  /** Paths the setup recipe copied or linked; kept out of the delivered commit. */
  setupPaths: string[];
  /** What preparing the workspace did that the run's history should say
   *  (setup's put-back files, a setup command that didn't run and why). */
  notes?: string[];
}

/** A fresh checkout of a candidate for its checks; `release` removes it. */
export type CandidateCheckout =
  | {
      ok: true;
      release(): Promise<void>;
      /** A fresh copy of the prepared directory for the next check, and where
       *  in it the check runs; what couldn't be copied (a socket) is named. */
      forCheck(signal?: AbortSignal): Promise<{ dir: string; skipped: string[] }>;
    }
  | { ok: false; reason: string };

export interface WorkerInfo {
  status: "idle" | "thinking" | "tool_running" | "waiting_approval" | "error";
  costUsd: number;
}

export interface LoopHost {
  /** Validate and normalize a repository path; null when unusable. */
  normalizeWorkdir(path: string): string | null;
  hasProvider(id: string): boolean;
  /** A worktree of `workdir` on a fresh branch, prepared by its setup recipe. */
  /** `reserve` is told the worktree's root as soon as it exists, before setup runs. */
  prepareWorkspace(run: LoopRunRow, signal: AbortSignal, reserve: (root: string) => void): Promise<PreparedWorkspace>;
  /** Queue an attempt on the dispatcher; returns the task id. */
  enqueueAttempt(run: LoopRunRow, attempt: LoopAttemptRow, prompt: string): string;
  /** Stop a queued or running attempt task. */
  cancelAttemptTask(taskId: string, reason: string): void;
  /** Park an attempt task while its worker waits on a person, so its lease
   *  can't expire under it; and release it when the worker moves again. */
  holdAttemptTask(taskId: string): void;
  unholdAttemptTask(taskId: string): void;
  /** Create the run's worker session in its worktree. */
  createWorker(run: LoopRunRow): Promise<string>;
  /** The worker still exists (a restart can lose it). */
  workerAlive(sessionId: string): boolean;
  /** The worker can carry the next attempt: it exists and has `loop_report`
   *  (a session resumed after a restart is rebuilt without it). */
  workerReusable(sessionId: string): boolean;
  /** Send an attempt's prompt; the turn runs autonomously. */
  sendToWorker(sessionId: string, text: string, run: LoopRunRow): Promise<void>;
  /** Re-arm the worker's tool budget for a new attempt. */
  armWorker(sessionId: string, toolBudget: number): void;
  workerInfo(sessionId: string): WorkerInfo | null;
  interruptWorker(sessionId: string): Promise<void>;
  /** Stop everything the worker's backend is running (its tool processes,
   *  background ones included) before a candidate is taken. */
  quiesceWorker(sessionId: string): Promise<void>;
  /** Snapshot the workspace: the git tree a candidate is identified by — the
   *  exact tree delivery would commit. `withheld` names new files kept out of
   *  it because they look like secrets. */
  snapshot(run: LoopRunRow): Promise<{ ok: true; tree: string; withheld: string[] } | { ok: false; reason: string }>;
  /** The run is over: the worker stops acting autonomously and becomes an
   *  ordinary session its owner may keep or destroy. */
  releaseWorker(sessionId: string): void;
  /** A fresh checkout of `tree`, prepared by the setup recipe, for its checks. */
  checkoutCandidate(run: LoopRunRow, tree: string, signal: AbortSignal): Promise<CandidateCheckout>;
  /** Run one check in `dir` (a candidate checkout) and record its evidence. */
  runCheck(run: LoopRunRow, spec: CheckSpec, candidateTree: string, dir: string, signal: AbortSignal): Promise<CheckRun>;
  /** Commit the verified tree on the run's base, as its branch; returns the commit. */
  commitCandidate(run: LoopRunRow, message: string, tree: string): Promise<string>;
  /** Remove the run's worktree and branch: the run ended before any worker
   *  had it (a worker's session owns its cleanup otherwise). */
  discardWorkspace(run: LoopRunRow): Promise<void>;
  /** The run is over: drop what was kept only for its checks. */
  forgetRun(run: LoopRunRow): void;
  /** At boot: drop what was kept for any run not in `runIds`. */
  keepInputs(runIds: Set<string>): void;
  /** Tell the owner something needs them (push + attention). */
  notifyOwner(run: LoopRunRow, kind: "waiting" | "finished"): void;
  audit(run: LoopRunRow, action: string, detail: string): void;
}

export class LoopError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_request" | "not_found" | "forbidden" | "conflict",
  ) {
    super(message);
  }
}

const SYSTEM = "system:loops";

/** How often the service records that the daemon is alive (for downtime). */
const ALIVE_INTERVAL_MS = 30_000;

interface ChecksOutcome {
  records: EvidenceRecord[];
  complete: boolean;
  error?: string;
}

/** Input accepted by `start` before defaults and validation. */
export interface LoopStartInput {
  objective: string;
  workdir: string;
  checks: Array<{ id?: string; command: string; timeoutSec?: number; expectTests?: boolean }>;
  provider?: string;
  model?: string;
  toolBudget?: number;
  limits?: Partial<LoopContract["limits"]>;
  /** Work from this commit instead of the user's checkout. Daemon-internal
   *  (watches): never taken from a client message. */
  baseRef?: LoopBaseRef;
  /** The repository event that started the run. Daemon-internal (watches). */
  trigger?: LoopTrigger;
}

/** A full commit id, and a branch name git would accept that can't pose as an option. */
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const SAFE_BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const FETCH_REF_RE = /^refs\/(heads\/[A-Za-z0-9._/-]{1,200}|pull\/\d{1,9}\/head)$/;

// ── Service ──────────────────────────────────────────────────────────────────

export class LoopService {
  readonly #store: LoopStore;
  readonly #host: LoopHost;
  /** Per-run serialization: every decision about a run runs in its chain. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /** Attempt wall-time timers. */
  readonly #deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  /** Attempts whose time ran out — their settle is a timeout, not a result. */
  readonly #timedOut = new Set<string>();
  /** Worktrees made for runs still being prepared (not yet on their run's record). */
  readonly #reserved = new Map<string, string>();
  /** In-flight workspace preparation (its setup command), abortable on cancel. */
  readonly #preparing = new Map<string, AbortController>();
  /** In-flight verification, abortable on cancel. */
  readonly #verifying = new Map<string, AbortController>();
  /** worker session → run, for report routing and the send guard. Holds only
   *  runs still in progress. */
  readonly #workers = new Map<string, string>();
  /** Runs whose cancel was requested: nothing starts or delivers for them. */
  readonly #cancelling = new Set<string>();
  /** Daemon-wide bound on checks running at once — they run outside the
   *  dispatcher, which bounds attempts. */
  readonly #checkSlots = new Semaphore(2);
  #stopped = false;
  #alive: ReturnType<typeof setInterval> | null = null;

  constructor(store: LoopStore, host: LoopHost) {
    this.#store = store;
    this.#host = host;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Boot reconciliation (§6 Restart guarantees). Attempts already queued or
   * running are owned by the dispatcher, which settles them — a claim lost in
   * the restart comes back as `reclaimed`. A run caught mid-verification
   * verifies again against the current tree; a missing result is never a pass.
   */
  start(): void {
    const now = Date.now();
    // Time the daemon was down is not the run's: an attempt caught mid-flight
    // is charged up to the daemon's last sign of life, never the outage.
    const aliveAt = this.#store.aliveAt();
    const down = aliveAt !== null ? Math.max(0, now - aliveAt) : 0;
    this.#store.touchAlive(now);
    if (this.#alive) clearInterval(this.#alive);
    this.#alive = setInterval(() => this.#store.touchAlive(Date.now()), ALIVE_INTERVAL_MS);
    this.#alive.unref?.();
    const active = this.#store.listActiveRuns();
    this.#host.keepInputs(new Set(active.map((r) => r.id.replace(/[^A-Za-z0-9_-]/g, ""))));
    for (const run of active) {
      if (run.workerSessionId) this.#workers.set(run.workerSessionId, run.id);
      const open = this.#currentAttempt(run.id);
      if (open && open.status === "verifying" && open.heldSince !== null) {
        // Its work ended at `endedAt`: a wait still open then ends there.
        const end = open.endedAt ?? now;
        this.#store.updateAttempt(open.id, { heldMs: open.heldMs + Math.max(0, end - open.heldSince), heldSince: null });
      } else if (open && open.status === "running" && open.startedAt) {
        // An approval wait doesn't survive a restart: it ends here, uncharged.
        const heldMs =
          open.heldSince !== null ? open.heldMs + Math.max(0, now - open.heldSince) : open.heldMs + Math.min(down, now - open.startedAt);
        this.#store.updateAttempt(open.id, { heldMs, heldSince: null });
      }
      const current = this.#currentAttempt(run.id);
      if (!current) {
        // Crashed before the first attempt: prepare (if needed) and baseline again.
        if (run.status === "running") this.#enqueue(run.id, () => this.#prepareAndBaseline(run.id));
        continue;
      }
      if (current.status === "done" && (run.status === "running" || run.status === "verifying")) {
        // Crashed after an attempt ended but before the run decided what's next.
        this.#enqueue(run.id, () => this.#afterAttempt(run.id, current.id));
      } else if (current.status === "verifying" || run.status === "verifying") {
        this.#enqueue(run.id, () => this.#verify(run.id, current.id));
      } else if (current.status === "running" && current.startedAt) {
        const used = Date.now() - current.startedAt - current.heldMs;
        this.#armDeadline(run, current, Math.max(0, this.#attemptBudgetMs(run) - used));
      } else if (current.status === "queued" && !current.dispatchTaskId) {
        // Crashed between creating the attempt and queueing it.
        this.#store.updateAttempt(current.id, { status: "done", result: "stopped", note: "never queued (daemon restart)", endedAt: Date.now() });
        if (run.status === "running" && current.prompt) this.#enqueue(run.id, () => this.#requeue(this.#store.getRun(run.id)!, current));
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const ac of this.#preparing.values()) ac.abort();
    if (this.#alive) clearInterval(this.#alive);
    this.#store.touchAlive(Date.now());
    for (const t of this.#deadlines.values()) clearTimeout(t);
    this.#deadlines.clear();
    for (const ac of this.#verifying.values()) ac.abort();
  }

  // ── Requests (authorized by SessionManager, owner-scoped here) ────────────

  startRun(input: LoopStartInput, owner: LoopOwner): LoopRunRow {
    const contract = this.#resolveContract(input);
    if (this.#store.countActiveOwnedRuns(tenantOf(owner), owner.sub) >= LOOP_LIMITS.ACTIVE_RUNS_PER_OWNER) {
      throw new LoopError(`You already have ${LOOP_LIMITS.ACTIVE_RUNS_PER_OWNER} loop runs in progress; wait for one to end or cancel one`, "conflict");
    }
    const run = this.#store.createRun({
      tenant: { accountId: owner.accountId, projectId: owner.projectId },
      ownerSub: owner.sub,
      ...(owner.name ? { ownerName: owner.name } : {}),
      contract,
      actor: owner.sub,
    });
    this.#host.audit(run, "loop.start", contract.objective.slice(0, 200));
    this.#enqueue(run.id, () => this.#prepareAndBaseline(run.id));
    return run;
  }

  get(id: string, owner: LoopOwner): LoopRunRow {
    const run = this.#store.getOwnedRun(id, tenantOf(owner), owner.sub);
    if (!run) throw new LoopError("Loop run not found", "not_found");
    return run;
  }

  list(owner: LoopOwner, limit?: number): LoopRunRow[] {
    return this.#store.listOwnedRuns(tenantOf(owner), owner.sub, limit);
  }

  attempts(runId: string): LoopAttemptRow[] {
    return this.#store.listAttempts(runId);
  }

  events(runId: string) {
    return this.#store.listEvents(runId);
  }

  /** The run's evidence is the owner's to read; anyone else gets nothing. */
  ownsRun(runId: string, owner: LoopOwner): boolean {
    return this.#store.getOwnedRun(runId, tenantOf(owner), owner.sub) !== null;
  }

  /** The active run whose worktree holds `dir` (at or below its root). */
  activeRunAt(dir: string): string | null {
    for (const [runId, root] of this.#reserved) {
      if (dir === root || dir.startsWith(`${root}/`)) return runId;
    }
    for (const run of this.#store.listActiveRuns()) {
      const root = run.worktreeRoot;
      if (root && (dir === root || dir.startsWith(`${root}/`))) return run.id;
    }
    return null;
  }

  /** The run exists and is still in progress (a watch's coalescing asks). */
  isActive(runId: string): boolean {
    const run = this.#store.getRun(runId);
    return run !== null && !isTerminalLoopStatus(run.status);
  }

  /**
   * Why the run failed before it had a workspace, and whether trying again
   * could help; null when it didn't (a watch retries the ones that could).
   */
  setupFailure(runId: string): { reason: string; retry: boolean } | null {
    const run = this.#store.getRun(runId);
    if (run?.status !== "failed" || run.worktreePath) return null;
    const retry = !this.#store.listEvents(runId).some((e) => e.type === WORKSPACE_UNSUPPORTED_EVENT);
    return { reason: run.reason ?? "the workspace couldn't be prepared", retry };
  }

  isWorker(sessionId: string): boolean {
    return this.#workers.has(sessionId);
  }

  /** The run a worker session belongs to, if any. */
  runOfWorker(sessionId: string): string | null {
    return this.#workers.get(sessionId) ?? null;
  }

  /** Stop now: running checks and the worker's turn are stopped at once,
   *  without waiting behind whatever the run is doing. */
  async cancel(id: string, owner: LoopOwner): Promise<LoopRunRow> {
    const before = this.get(id, owner);
    if (isTerminalLoopStatus(before.status)) return before;
    this.#cancelling.add(id);
    this.#verifying.get(id)?.abort();
    this.#preparing.get(id)?.abort();
    for (const sid of new Set([this.#currentAttempt(id)?.workerSessionId, before.workerSessionId])) {
      if (sid && this.#host.workerAlive(sid)) void this.#host.interruptWorker(sid).catch(() => {});
    }
    return this.#enqueue(id, async () => {
      try {
        const run = this.#store.getRun(id)!;
        if (isTerminalLoopStatus(run.status)) return run;
        const next = this.#store.transition(
          id,
          run.stateVersion,
          { status: "cancelled", reason: "cancelled by the owner", waitingOn: null, endedAt: Date.now() },
          { actor: owner.sub, type: "run.cancelled" },
        );
        await this.#stopActiveWork(run, "the run was cancelled");
        this.#release(run);
        this.#host.audit(run, "loop.cancel", "");
        return next ?? this.#store.getRun(id)!;
      } finally {
        this.#cancelling.delete(id);
      }
    });
  }

  /** Stop at the next attempt boundary; a running attempt finishes first.
   *  One compare-and-set, applied at once — not queued behind a long check. */
  async pause(id: string, owner: LoopOwner): Promise<LoopRunRow> {
    this.get(id, owner);
    for (;;) {
      const run = this.#store.getRun(id)!;
      if (isTerminalLoopStatus(run.status) || run.status === "paused") return run;
      // A run that was waiting keeps what it waits on, so resume returns to it.
      const next = this.#store.transition(id, run.stateVersion, { status: "paused", reason: "paused by the owner" }, {
        actor: owner.sub,
        type: "run.paused",
      });
      if (next) return next;
    }
  }

  /** One compare-and-set, applied at once; what the run does next is queued
   *  behind whatever it is doing, not awaited. */
  async resume(id: string, owner: LoopOwner): Promise<LoopRunRow> {
    this.get(id, owner);
    for (;;) {
      const run = this.#store.getRun(id)!;
      if (run.status !== "paused") return run;
      const current = this.#currentAttempt(id);
      // Still waiting on something only a person can give: back to waiting.
      const stillWaiting =
        run.waitingOn !== null &&
        (run.waitingOn !== APPROVAL_WAIT || (current?.status === "running" && current.heldSince != null));
      const next = this.#store.transition(
        id,
        run.stateVersion,
        stillWaiting ? { status: "waiting", reason: run.waitingOn } : { status: "running", reason: "resumed", waitingOn: null },
        { actor: owner.sub, type: "run.resumed" },
      );
      if (!next) continue;
      if (!stillWaiting) void this.#enqueue(id, () => this.#carryOn(id)).catch(() => {});
      return next;
    }
  }

  /** A resumed run picks up where it stopped. */
  async #carryOn(id: string): Promise<void> {
    const run = this.#store.getRun(id);
    if (!run || run.status !== "running") return;
    const current = this.#currentAttempt(id);
    // Paused before its first attempt: prepare (if needed) and baseline again.
    if (!current) return this.#prepareAndBaseline(id);
    // A running or verifying attempt carries on through its own hooks.
    if (current.status === "done") await this.#afterAttempt(id, current.id);
  }

  /**
   * Guidance from the owner. A run waiting on the worker's question takes it
   * as the answer and continues; otherwise it is applied at the next attempt.
   */
  async steer(id: string, text: string, owner: LoopOwner): Promise<LoopRunRow> {
    this.get(id, owner);
    const body = text.trim();
    if (!body) throw new LoopError("Steering text is empty", "invalid_request");
    if (body.length > LOOP_LIMITS.STEER_MAX) throw new LoopError(`Steering text is over ${LOOP_LIMITS.STEER_MAX} characters`, "invalid_request");
    for (;;) {
      const run = this.#store.getRun(id)!;
      if (isTerminalLoopStatus(run.status)) throw new LoopError(`The run has ended (${run.status})`, "conflict");
      const current = this.#currentAttempt(id);
      if (run.status === "waiting" && current?.result === "needs_input") {
        // The answer to the worker's question starts the next attempt: that
        // is a decision about the run, so it goes through its queue.
        return this.#enqueue(id, async () => {
          const now = this.#store.getRun(id)!;
          if (isTerminalLoopStatus(now.status)) throw new LoopError(`The run has ended (${now.status})`, "conflict");
          // The question was settled while this waited: it's guidance after all.
          if (now.status !== "waiting" || this.#currentAttempt(id)?.id !== current.id) return this.#appendSteer(id, body, owner);
          const next = this.#store.transition(
            id,
            now.stateVersion,
            { status: "running", reason: "continuing with the owner's answer", waitingOn: null },
            { actor: owner.sub, type: "run.answered", detail: body.slice(0, 500) },
          );
          const question = current.report?.detail ?? current.report?.summary ?? "";
          if (next) await this.#startAttempt(id, (r) => answerPrompt(r.contract, body, r.pendingSteer, question));
          return this.#store.getRun(id)!;
        });
      }
      // Otherwise steering only queues text for the next attempt — applied at
      // once, not behind a running check.
      return this.#appendSteer(id, body, owner);
    }
  }

  /** Queue steering for the next attempt: a compare-and-set, retried on conflict. */
  #appendSteer(id: string, body: string, owner: LoopOwner): LoopRunRow {
    for (;;) {
      const run = this.#store.getRun(id)!;
      if (isTerminalLoopStatus(run.status)) throw new LoopError(`The run has ended (${run.status})`, "conflict");
      const pending = [...run.pendingSteer, body];
      if (pending.length > LOOP_LIMITS.STEER_PENDING_MAX || pending.join("").length > LOOP_LIMITS.STEER_PENDING_CHARS_MAX) {
        throw new LoopError("Too much steering is queued for the next attempt; wait for it to start", "conflict");
      }
      const next = this.#store.transition(id, run.stateVersion, { pendingSteer: pending }, {
        actor: owner.sub,
        type: "run.steered",
        detail: body.slice(0, 500),
      });
      if (next) return next;
    }
  }

  // ── Hooks from the dispatcher and sessions ────────────────────────────────

  /** The dispatcher claimed an attempt: start or reuse the worker and send. */
  async spawnAttemptWorker(runId: string, attemptId: string, prompt: string): Promise<string> {
    return this.#enqueue(runId, async () => {
      const run = this.#store.getRun(runId);
      const attempt = this.#store.getAttempt(attemptId);
      if (!run || !attempt) throw new Error("loop attempt no longer exists");
      if (isTerminalLoopStatus(run.status) || this.#cancelling.has(runId)) throw new Error(`loop run is ${run.status}`);
      if (attempt.status !== "queued" || this.#currentAttempt(runId)?.id !== attemptId) {
        throw new Error("this loop attempt is no longer the one the run is waiting on");
      }
      if (run.status === "paused" || this.#stopped) {
        // Paused while it waited for a worker slot: give the slot back; resume
        // queues the same attempt again.
        if (attempt.dispatchTaskId) this.#host.cancelAttemptTask(attempt.dispatchTaskId, "the run is paused");
        this.#store.updateAttempt(attemptId, { status: "done", result: "stopped", note: "paused before it started", endedAt: Date.now() });
        throw new Error("the loop run is paused");
      }
      const budget = this.#attemptBudgetMs(run);
      if (budget <= 0) {
        this.#store.updateAttempt(attemptId, { status: "done", result: "stopped", note: "the run's time budget was spent", endedAt: Date.now() });
        this.#end(run, "budget_exhausted", `the run's ${run.contract.limits.runMinutes}-minute budget is spent`);
        throw new Error("the loop run's time budget is spent");
      }
      let sessionId = run.workerSessionId;
      let text = prompt;
      if (!sessionId || !this.#host.workerReusable(sessionId)) {
        if (sessionId) {
          // A new conversation: it learns the run from the start.
          text = `${takeoverPreamble(run.contract)}\n\n${prompt}`;
          // The old worker may still be mid-turn: stop it before another works
          // the same tree.
          if (this.#host.workerAlive(sessionId)) await this.#host.quiesceWorker(sessionId).catch(() => {});
          this.#workers.delete(sessionId);
          this.#host.releaseWorker(sessionId);
        }
        sessionId = await this.#host.createWorker(run);
        this.#patch(runId, { workerSessionId: sessionId }, { type: "worker.created", detail: sessionId });
      } else {
        this.#host.armWorker(sessionId, run.contract.toolBudget);
      }
      this.#workers.set(sessionId, runId);
      const fresh = this.#store.getRun(runId)!;
      this.#store.updateAttempt(attemptId, {
        status: "running",
        workerSessionId: sessionId,
        startedAt: Date.now(),
        costAtStart: this.#host.workerInfo(sessionId)?.costUsd ?? 0,
      });
      this.#armDeadline(fresh, attempt, budget);
      await this.#host.sendToWorker(sessionId, text, fresh);
      return sessionId;
    });
  }

  /** The dispatcher saw the attempt's worker settle. */
  attemptSettled(runId: string, attemptId: string, status: "done" | "failed" | "reclaimed"): void {
    void this.#enqueue(runId, async () => {
      const attempt = this.#store.getAttempt(attemptId);
      if (!attempt || attempt.status === "done") return;
      this.#clearDeadline(attemptId);
      const run = this.#store.getRun(runId);
      if (!run) return;
      if (isTerminalLoopStatus(run.status)) {
        this.#store.updateAttempt(attemptId, { status: "done", result: "stopped", endedAt: Date.now(), note: `the run is ${run.status}` });
        return;
      }
      if (attempt.status === "verifying") {
        // Its work had already ended (a deadline settled it); the claim is moot.
        await this.#verify(runId, attemptId);
        return;
      }
      if (status === "reclaimed" && attempt.status === "queued") {
        // Lost before it started: it never ran, so it isn't spent.
        this.#finishAttempt(attempt, "stopped", "its claim was lost before it started");
        await this.#afterAttempt(runId, attemptId);
        return;
      }
      if (status !== "done" && !this.#timedOut.has(attemptId)) {
        // Its claim was lost or its turn failed. Recorded first, so a restart
        // in what follows carries on from it.
        this.#store.updateAttempt(attemptId, { costUsd: this.#attemptCost(run, attempt) });
        this.#finishAttempt(attempt, "worker_failed", status === "reclaimed" ? "the attempt's claim was lost (restart or lease expiry)" : "the worker's turn failed");
        // The worker may still be working: stop it before the next attempt
        // shares the tree.
        const worker = attempt.workerSessionId ?? run.workerSessionId;
        if (worker && this.#host.workerAlive(worker)) await this.#host.quiesceWorker(worker).catch(() => {});
        await this.#afterAttempt(runId, attemptId);
        return;
      }
      await this.#verify(runId, attemptId);
    });
  }

  /** The worker is waiting on an approval its profile doesn't cover. The
   *  attempt's task is held and its clock stops until a person answers (§6). */
  attemptWaiting(runId: string, attemptId: string): void {
    void this.#enqueue(runId, async () => {
      const run = this.#store.getRun(runId);
      const attempt = this.#store.getAttempt(attemptId);
      if (!run || !attempt || isTerminalLoopStatus(run.status)) return;
      if (attempt.status !== "running" || this.#currentAttempt(runId)?.id !== attemptId || attempt.heldSince !== null) return;
      if (attempt.dispatchTaskId) this.#host.holdAttemptTask(attempt.dispatchTaskId);
      this.#pauseDeadline(attemptId);
      this.#store.updateAttempt(attemptId, { heldSince: Date.now() });
      // A paused run stays paused, but remembers what it waits on.
      const next = this.#store.transition(
        runId,
        run.stateVersion,
        run.status === "paused"
          ? { waitingOn: APPROVAL_WAIT }
          : { status: "waiting", waitingOn: APPROVAL_WAIT, reason: "waiting for you to approve a tool call" },
        { actor: SYSTEM, type: "attempt.waiting_approval", detail: attemptId },
      );
      if (next) this.#host.notifyOwner(next, "waiting");
    });
  }

  /** A worker session's status changed: an answered approval releases the
   *  attempt, whatever the run's status (a paused run stays paused). */
  workerStatusChanged(sessionId: string, status: WorkerInfo["status"]): void {
    const runId = this.#workers.get(sessionId);
    if (!runId || status === "waiting_approval") return;
    void this.#enqueue(runId, async () => {
      const run = this.#store.getRun(runId);
      const attempt = this.#currentAttempt(runId);
      if (!run || !attempt || attempt.status !== "running" || attempt.heldSince === null) return;
      if (attempt.workerSessionId !== sessionId) return;
      if (attempt.dispatchTaskId) this.#host.unholdAttemptTask(attempt.dispatchTaskId);
      this.#store.updateAttempt(attempt.id, { heldSince: null, heldMs: attempt.heldMs + (Date.now() - attempt.heldSince) });
      this.#resumeDeadline(run, attempt.id);
      if (run.waitingOn !== APPROVAL_WAIT) return;
      this.#store.transition(
        runId,
        run.stateVersion,
        run.status === "waiting"
          ? { status: "running", waitingOn: null, reason: "the approval was answered" }
          : { waitingOn: null },
        { actor: SYSTEM, type: "attempt.approval_answered" },
      );
    });
  }

  /** `loop_report` from a worker: record it on the session's current attempt. */
  recordReport(sessionId: string, input: LoopReportInput): string {
    const runId = this.#workers.get(sessionId);
    if (!runId) return "No loop run owns this session; nothing was recorded.";
    const attempt = this.#currentAttempt(runId);
    if (!attempt || attempt.status !== "running" || attempt.workerSessionId !== sessionId) {
      return "There is no running attempt to report for; nothing was recorded.";
    }
    if (attempt.report) return "You already reported for this attempt; nothing more was recorded. End your turn now.";
    const summary = input.summary.slice(0, LOOP_LIMITS.REPORT_SUMMARY_MAX);
    const detail = input.detail?.slice(0, LOOP_LIMITS.REPORT_DETAIL_MAX);
    this.#store.updateAttempt(attempt.id, {
      report: { outcome: input.outcome, summary, ...(detail ? { detail } : {}), at: Date.now() },
    });
    this.#store.appendEvent(runId, `worker:${sessionId}`, `report.${input.outcome}`, summary.slice(0, 500));
    return input.outcome === "ready_for_verification"
      ? "Recorded. End your turn now; the daemon will run the checks on your work."
      : "Recorded. End your turn now.";
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #enqueue<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    this.#chains.set(runId, settled);
    void settled.then(() => {
      if (this.#chains.get(runId) === settled) this.#chains.delete(runId);
    });
    return next;
  }

  #resolveContract(input: LoopStartInput): LoopContract {
    const objective = input.objective?.trim() ?? "";
    if (!objective) throw new LoopError("An objective is required", "invalid_request");
    if (objective.length > LOOP_LIMITS.OBJECTIVE_MAX) throw new LoopError(`The objective is over ${LOOP_LIMITS.OBJECTIVE_MAX} characters`, "invalid_request");
    const workdir = this.#host.normalizeWorkdir(input.workdir);
    if (!workdir) throw new LoopError(`workdir not usable: ${input.workdir}`, "invalid_request");
    if (!input.checks?.length) throw new LoopError("A repair run needs at least one check", "invalid_request");
    if (input.checks.length > LOOP_LIMITS.CHECKS_MAX) throw new LoopError(`At most ${LOOP_LIMITS.CHECKS_MAX} checks`, "invalid_request");
    const seen = new Set<string>();
    const checks: LoopCheck[] = input.checks.map((c, i) => {
      const command = c.command?.trim() ?? "";
      if (!command) throw new LoopError(`Check ${i + 1} has no command`, "invalid_request");
      if (command.length > LOOP_LIMITS.CHECK_COMMAND_MAX) throw new LoopError(`Check ${i + 1}'s command is too long`, "invalid_request");
      const id = (c.id?.trim() || `check${i + 1}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
      if (seen.has(id)) throw new LoopError(`Two checks are named "${id}"`, "invalid_request");
      seen.add(id);
      const timeoutSec = c.timeoutSec ?? LOOP_DEFAULTS.checkTimeoutSec;
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > LOOP_LIMITS.CHECK_TIMEOUT_MAX_S) {
        throw new LoopError(`Check "${id}" timeout must be 1–${LOOP_LIMITS.CHECK_TIMEOUT_MAX_S}s`, "invalid_request");
      }
      return { id, command, timeoutSec, ...(c.expectTests ? { expectTests: true } : {}) };
    });
    if (input.provider && !this.#host.hasProvider(input.provider)) {
      throw new LoopError(`Unknown backend "${input.provider}"`, "invalid_request");
    }
    const limits = { ...LOOP_DEFAULTS.limits, ...(input.limits ?? {}) };
    const bounded = (v: number, max: number, name: string): number => {
      if (!Number.isInteger(v) || v < 1 || v > max) throw new LoopError(`${name} must be 1–${max}`, "invalid_request");
      return v;
    };
    return {
      recipe: "repair",
      objective,
      workdir,
      checks,
      worker: { ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) },
      toolBudget: bounded(input.toolBudget ?? LOOP_DEFAULTS.toolBudget, LOOP_LIMITS.TOOL_BUDGET_MAX, "toolBudget"),
      limits: {
        attempts: bounded(limits.attempts, LOOP_LIMITS.ATTEMPTS_MAX, "attempts"),
        attemptMinutes: bounded(limits.attemptMinutes, LOOP_LIMITS.ATTEMPT_MINUTES_MAX, "attemptMinutes"),
        runMinutes: bounded(limits.runMinutes, LOOP_LIMITS.RUN_MINUTES_MAX, "runMinutes"),
      },
      ...(input.baseRef ? { baseRef: resolveBaseRef(input.baseRef) } : {}),
      ...(input.trigger
        ? { trigger: { ...input.trigger, summary: input.trigger.summary.slice(0, LOOP_LIMITS.TRIGGER_SUMMARY_MAX) } }
        : {}),
    };
  }

  #currentAttempt(runId: string): LoopAttemptRow | null {
    const all = this.#store.listAttempts(runId);
    return all[all.length - 1] ?? null;
  }

  /** Steps 1–2: the worktree, then the checks on the unmodified tree. */
  async #prepareAndBaseline(runId: string): Promise<void> {
    let run = this.#store.getRun(runId);
    if (!run || isTerminalLoopStatus(run.status)) return;
    if (!run.worktreePath) {
      let ws: PreparedWorkspace;
      const ac = new AbortController();
      this.#preparing.set(runId, ac);
      try {
        ws = await this.#host.prepareWorkspace(run, ac.signal, (root) => this.#reserved.set(runId, root));
      } catch (err) {
        // A cancel stopped it; the cancel ends the run.
        // The host removed the worktree before throwing: the claim goes now.
        this.#reserved.delete(runId);
        if (!ac.signal.aborted) {
          if (err instanceof LoopWorkspaceUnsupportedError) this.#store.appendEvent(runId, SYSTEM, WORKSPACE_UNSUPPORTED_EVENT, errText(err).slice(0, 500));
          this.#end(run, "failed", `could not prepare the run's workspace: ${errText(err)}`);
        }
        return;
      } finally {
        this.#preparing.delete(runId);
      }
      const recorded = this.#patch(
        runId,
        (r) => ({
          worktreePath: ws.worktreePath,
          worktreeRoot: ws.worktreeRoot,
          gitDir: ws.gitDir,
          commonDir: ws.commonDir,
          branch: ws.branch,
          baseRevision: ws.baseRevision,
          setupPaths: ws.setupPaths,
          ...(r.status === "running" ? { reason: "checking the unmodified code" } : {}),
        }),
        { type: "workspace.prepared", detail: `${ws.branch} @ ${ws.baseRevision}` },
      );
      for (const note of ws.notes ?? []) this.#store.appendEvent(runId, SYSTEM, "workspace.note", note.slice(0, 500));
      if (!recorded) {
        // Ended while it was being made: nothing else will remove it. Still
        // claimed until it's gone.
        const ended = this.#store.getRun(runId) ?? run;
        await this.#host.discardWorkspace({ ...ended, worktreeRoot: ws.worktreeRoot, branch: ws.branch }).catch(() => {});
        this.#reserved.delete(runId);
        return;
      }
      // From here the run's own record answers activeRunAt.
      this.#reserved.delete(runId);
      run = recorded;
    }
    // Paused: resume baselines.
    if (run.status === "paused") return;
    const tree = await this.#host.snapshot(run);
    if (!tree.ok) {
      this.#end(run, "failed", `could not snapshot the unmodified code: ${tree.reason}`);
      return;
    }
    const checked = await this.#runChecks(run, tree.tree);
    // Stopped part-way (shutdown, cancel): the baseline runs again on resume.
    if (!checked.complete) return;
    if (checked.error) {
      this.#end(run, "failed", `could not check the unmodified code: ${checked.error}`);
      return;
    }
    const baseline = checked.records;
    const checkedRun = this.#patch(runId, { baseTree: tree.tree }, { type: "baseline.checked", detail: tree.tree });
    if (!checkedRun) return;
    // A review comment asks for a change, not a repair: its checks are the
    // guard the change must keep passing, so passing already is expected.
    // Everything else with nothing failing has nothing to repair.
    if (baseline.every((e) => e.result === "pass") && checkedRun.contract.trigger?.kind !== "review_comment") {
      this.#end(checkedRun, "blocked", "every check already passes on the unmodified code — there is nothing to repair");
      return;
    }
    if (baseline.some((e) => e.result === "error")) {
      const broken = baseline.find((e) => e.result === "error")!;
      this.#end(checkedRun, "failed", `a check could not run on the unmodified code (${broken.criterionId}: ${broken.reason})`);
      return;
    }
    await this.#startAttempt(runId, (r) => firstAttemptPrompt(r.contract, baseline, r.pendingSteer));
  }

  /** Queue the run's next attempt with a prompt built from its state as it is
   *  then — retried on a racing pause or steer, never dropped by one. */
  async #startAttempt(runId: string, build: (run: LoopRunRow) => string): Promise<void> {
    for (;;) {
      if (this.#stopped || this.#cancelling.has(runId)) return;
      const run = this.#store.getRun(runId);
      if (!run || isTerminalLoopStatus(run.status) || run.status === "paused") return;
      const prompt = build(run);
      const started = this.#store.startAttempt(
        runId,
        run.stateVersion,
        prompt,
        { status: "running", reason: "an attempt is queued", pendingSteer: [], waitingOn: null },
        { actor: SYSTEM, type: "attempt.queued" },
      );
      if (!started) continue;
      const { run: next, attempt } = started;
      try {
        const taskId = this.#host.enqueueAttempt(next, attempt, prompt);
        this.#store.updateAttempt(attempt.id, {
          dispatchTaskId: taskId,
          provider: next.contract.worker.provider ?? null,
          model: next.contract.worker.model ?? null,
        });
      } catch (err) {
        this.#finishAttempt(attempt, "worker_failed", `could not queue the attempt: ${errText(err)}`);
        this.#end(next, "failed", `could not queue an attempt: ${errText(err)}`);
      }
      return;
    }
  }

  /**
   * A change only the service makes (workspace, accounting, worker, results):
   * a compare-and-set retried on a fresh version, since a pause or steer may
   * land between reading the run and writing it. Null once the run has ended.
   */
  #patch(
    runId: string,
    patch: RunPatch | ((run: LoopRunRow) => RunPatch),
    event: { type: string; detail?: string },
  ): LoopRunRow | null {
    for (;;) {
      const run = this.#store.getRun(runId);
      if (!run || isTerminalLoopStatus(run.status)) return null;
      const next = this.#store.transition(runId, run.stateVersion, typeof patch === "function" ? patch(run) : patch, { actor: SYSTEM, ...event });
      if (next) return next;
    }
  }

  /** Step 4: snapshot, run every check on that tree, record the result. */
  async #verify(runId: string, attemptId: string): Promise<void> {
    let run = this.#store.getRun(runId);
    const attempt = this.#store.getAttempt(attemptId);
    if (!run || !attempt || isTerminalLoopStatus(run.status) || this.#cancelling.has(runId)) return;
    // Judged once, and only the attempt the run is on.
    if (attempt.status === "done" || this.#currentAttempt(runId)?.id !== attemptId) return;
    // A paused run stays paused; the attempt is still checked, and resume
    // carries on from its result.
    if (run.status !== "paused") {
      run =
        this.#patch(
          runId,
          (r) => ({
            ...(r.status === "paused" ? {} : { status: "verifying" as const, reason: `checking attempt ${attempt.ordinal}` }),
            // An approval wait ends with the work.
            ...(r.waitingOn === APPROVAL_WAIT ? { waitingOn: null } : {}),
          }),
          {
          type: "attempt.verifying",
          detail: attemptId,
        }) ?? run;
    }
    // The attempt's work ends here; its checks are charged as checks.
    if (attempt.endedAt === null) {
      // An approval wait still open ends with the work, not with the checks.
      const now = Date.now();
      const heldMs = attempt.heldSince !== null ? attempt.heldMs + Math.max(0, now - attempt.heldSince) : attempt.heldMs;
      this.#store.updateAttempt(attemptId, { status: "verifying", endedAt: now, heldMs, heldSince: null });
    } else {
      this.#store.updateAttempt(attemptId, { status: "verifying" });
    }
    const workerId = attempt.workerSessionId ?? run.workerSessionId;
    if (workerId && this.#host.workerAlive(workerId)) await this.#host.quiesceWorker(workerId).catch(() => {});
    const tree = await this.#host.snapshot(run);
    const candidateTree = tree.ok ? tree.tree : null;
    if (tree.ok && tree.withheld.length > 0) {
      this.#store.appendEvent(runId, SYSTEM, "candidate.withheld", `new files that look like secrets were kept out of the candidate: ${tree.withheld.join(", ").slice(0, 400)}`);
    }
    const asked = this.#store.getAttempt(attemptId)?.report?.outcome === "needs_input";
    // A worker that stopped to ask a question hasn't offered a candidate.
    const checked: ChecksOutcome = candidateTree && !asked ? await this.#runChecks(run, candidateTree) : { records: [], complete: true };
    // Stopped part-way (shutdown, cancel): never judged on part of its checks.
    // The attempt stays `verifying` and is checked again after a restart.
    if (!checked.complete) return;
    const evidence = checked.records;
    const latest = this.#store.getAttempt(attemptId)!;
    const result = judgeAttempt({
      asked,
      snapshotted: candidateTree !== null,
      allPass: evidence.length === run.contract.checks.length && evidence.every((e) => e.result === "pass"),
      timedOut: this.#timedOut.has(attemptId),
      reportedConflict: latest.report?.outcome === "cannot_satisfy",
    });
    this.#timedOut.delete(attemptId);
    this.#store.updateAttempt(attemptId, {
      candidateTree,
      evidenceIds: evidence.map((e) => e.id),
      costUsd: this.#attemptCost(run, latest),
    });
    this.#finishAttempt(
      latest,
      result,
      !candidateTree
        ? `the workspace could not be snapshotted (${tree.ok ? "" : tree.reason}), so nothing could be verified`
        : checked.error
          ? `the candidate could not be checked: ${checked.error}`
          : describeResult(result, evidence),
    );
    await this.#afterAttempt(runId, attemptId);
  }

  /** Step 5: decide what the run does after an attempt ended. */
  async #afterAttempt(runId: string, attemptId: string): Promise<void> {
    const run = this.#store.getRun(runId);
    const attempt = this.#store.getAttempt(attemptId);
    if (!run || !attempt || isTerminalLoopStatus(run.status)) return;
    if (run.status === "paused") return;
    // Decided once: a later call for an attempt the run has moved past is late.
    if (this.#currentAttempt(runId)?.id !== attemptId) return;
    const attempts = this.#store.listAttempts(runId);
    const activeMs = this.#activeMs(run, attempts);
    const costUsd = attempts.reduce((n, a) => n + a.costUsd, 0);
    const accounted = this.#patch(runId, { activeMs, costUsd }, { type: "run.accounted" });
    if (!accounted) return;

    switch (attempt.result) {
      case "stopped":
        // Stopped before it started (pause, shutdown): queue it again as it was.
        if (attempt.prompt) {
          await this.#requeue(accounted, attempt);
          return;
        }
        break;
      case "verified":
        await this.#deliver(accounted, attempt);
        return;
      case "cannot_satisfy":
        this.#end(accounted, "blocked", `the worker reports the objective conflicts with its checks: ${attempt.report?.detail ?? attempt.report?.summary ?? "(no detail)"}`);
        return;
      case "needs_input": {
        const question = attempt.report?.detail ?? attempt.report?.summary ?? "the worker needs a decision";
        const next = this.#patch(
          runId,
          (r) => ({
            ...(r.status === "paused" ? {} : { status: "waiting" as const, reason: "the worker asked a question" }),
            waitingOn: `${QUESTION_WAIT_PREFIX}${question.slice(0, 500)}`,
          }),
          { type: "run.waiting_input", detail: question.slice(0, 500) },
        );
        if (next) this.#host.notifyOwner(next, "waiting");
        return;
      }
      default:
        break;
    }

    // Not accepted. Stop on no progress, then on budget, else try again.
    const counted = attempts.filter((a) => a.result !== "needs_input" && a.result !== "stopped");
    // Two attempts in a row that left the tree as they found it (the baseline
    // counts as the tree before the first) are not making progress.
    const trees = [accounted.baseTree, ...counted.map((a) => a.candidateTree)];
    const unchanged = (i: number) => trees[i] != null && trees[i] === trees[i - 1];
    if (trees.length >= 3 && unchanged(trees.length - 1) && unchanged(trees.length - 2)) {
      this.#end(accounted, "blocked", "two attempts in a row left the code as they found it — the worker is not making progress");
      return;
    }
    if (counted.length >= accounted.contract.limits.attempts) {
      this.#end(accounted, "budget_exhausted", `${counted.length} attempt(s) used without passing every check`);
      return;
    }
    if (activeMs >= accounted.contract.limits.runMinutes * 60_000) {
      this.#end(accounted, "budget_exhausted", `the run's ${accounted.contract.limits.runMinutes}-minute budget is spent`);
      return;
    }
    const evidence = this.#evidenceOf(accounted, attempt);
    await this.#startAttempt(runId, (r) =>
      nextAttemptPrompt({
        contract: r.contract,
        previous: attempt,
        evidence,
        steering: r.pendingSteer,
        attemptsLeft: r.contract.limits.attempts - counted.length - 1,
      }),
    );
  }

  async #deliver(run: LoopRunRow, attempt: LoopAttemptRow): Promise<void> {
    if (this.#stopped || this.#cancelling.has(run.id)) return;
    if (attempt.candidateTree === run.baseTree) {
      this.#end(
        run,
        "blocked",
        run.contract.trigger?.kind === "review_comment"
          ? "the worker changed no tracked file — the comment may need no change, or asks for one outside the tracked tree"
          : "every check passed, but the tracked files are as they started — the checks may be flaky, or the change is outside the tracked tree",
      );
      return;
    }
    let commit: string;
    try {
      commit = await this.#host.commitCandidate(
        run,
        `codeoid loop: ${run.contract.objective.split("\n")[0]!.slice(0, 72)}\n\nVerified by ${run.contract.checks.map((c) => c.id).join(", ")} (run ${run.id}, attempt ${attempt.ordinal}).`,
        attempt.candidateTree!,
      );
    } catch (err) {
      this.#end(run, "failed", `every check passed, but the result could not be committed: ${errText(err)}`);
      return;
    }
    const next = this.#patch(
      run.id,
      {
        status: "completed",
        reason: `every check passed on attempt ${attempt.ordinal}; committed to ${run.branch}`,
        acceptedAttemptId: attempt.id,
        deliveredCommit: commit,
        waitingOn: null,
        endedAt: Date.now(),
      },
      { type: "run.completed", detail: commit },
    );
    if (next) {
      if (next.pendingSteer.length > 0) {
        this.#store.appendEvent(run.id, SYSTEM, "steer.unused", "steering sent after the last attempt started was not used: the run completed");
      }
      this.#release(next);
      this.#host.audit(next, "loop.completed", commit);
      this.#host.notifyOwner(next, "finished");
    }
  }

  /** Run every check on `tree`, in a fresh checkout of it. `complete` is
   *  false when anything stopped the run part-way — such a result is never
   *  judged; `error` says why the checks couldn't run at all. */
  async #runChecks(run: LoopRunRow, tree: string): Promise<ChecksOutcome> {
    const ac = new AbortController();
    this.#verifying.set(run.id, ac);
    const out: EvidenceRecord[] = [];
    let error: string | undefined;
    let slotAt: number | null = null;
    let release: (() => void) | null = null;
    let checkout: CandidateCheckout | null = null;
    try {
      if (!this.#stopped && !this.#cancelling.has(run.id)) release = await this.#checkSlots.acquire(ac.signal);
      if (release) {
        slotAt = Date.now();
        checkout = await this.#host.checkoutCandidate(run, tree, ac.signal);
        if (!checkout.ok) {
          error = checkout.reason;
        } else {
          for (const [i, c] of run.contract.checks.entries()) {
            if (ac.signal.aborted || this.#stopped || this.#cancelling.has(run.id)) break;
            // Each check in a fresh copy of what was prepared.
            const at = await checkout.forCheck(ac.signal);
            if (i === 0 && at.skipped.length > 0) {
              this.#store.appendEvent(run.id, SYSTEM, "checks.skipped", `not copied for the checks (not a file, directory or link): ${at.skipped.slice(0, 5).join(", ")}`);
            }
            const { record } = await this.#host.runCheck(
              run,
              { id: c.id, label: c.id, command: c.command, timeoutMs: c.timeoutSec * 1000, ...(c.expectTests ? { expectTests: true } : {}) },
              tree,
              at.dir,
              ac.signal,
            );
            if (record) out.push(record);
          }
        }
      }
    } catch (err) {
      // A check that couldn't be recorded is a candidate that couldn't be checked.
      error = `a check could not run: ${errText(err)}`;
    } finally {
      if (checkout?.ok) await checkout.release().catch(() => {});
      release?.();
      if (this.#verifying.get(run.id) === ac) this.#verifying.delete(run.id);
    }
    if (slotAt !== null) {
      const spent = Date.now() - slotAt;
      this.#patch(run.id, (r) => ({ checkMs: r.checkMs + spent }), { type: "checks.ran" });
    }
    const stopped = ac.signal.aborted || this.#stopped || this.#cancelling.has(run.id) || slotAt === null;
    if (stopped) return { records: out, complete: false };
    if (error && !ac.signal.aborted) return { records: [], complete: true, error };
    return { records: out, complete: out.length === run.contract.checks.length && out.every((r) => r.result !== "cancelled") };
  }

  /** Active time so far: attempts minus their approval waits, plus checks. */
  #activeMs(run: LoopRunRow, attempts: LoopAttemptRow[]): number {
    const attemptMs = attempts.reduce(
      (n, a) => n + (a.startedAt && a.endedAt ? Math.max(0, a.endedAt - a.startedAt - a.heldMs) : 0),
      0,
    );
    return attemptMs + (this.#store.getRun(run.id)?.checkMs ?? run.checkMs);
  }

  /** Wall time the next attempt may use: its own limit, capped by what's left
   *  of the run's. */
  #attemptBudgetMs(run: LoopRunRow): number {
    const left = run.contract.limits.runMinutes * 60_000 - this.#activeMs(run, this.#store.listAttempts(run.id));
    return Math.min(run.contract.limits.attemptMinutes * 60_000, left);
  }

  /** What an attempt cost: the worker's spend since the attempt started. */
  #attemptCost(run: LoopRunRow, attempt: LoopAttemptRow): number {
    const sessionId = attempt.workerSessionId ?? run.workerSessionId;
    const total = sessionId ? (this.#host.workerInfo(sessionId)?.costUsd ?? attempt.costAtStart) : attempt.costAtStart;
    return Math.max(0, total - attempt.costAtStart);
  }

  /** The run is over: forget its worker so a message to it is an ordinary
   *  message again, and hand the session back to its owner. */
  #release(run: LoopRunRow): void {
    for (const [sessionId, runId] of this.#workers) {
      if (runId !== run.id) continue;
      this.#workers.delete(sessionId);
      this.#host.releaseWorker(sessionId);
    }
    this.#host.forgetRun(run);
    // No worker ever had the worktree, so no session will remove it.
    const latest = this.#store.getRun(run.id) ?? run;
    if (!latest.workerSessionId && latest.worktreeRoot) void this.#host.discardWorkspace(latest).catch(() => {});
  }

  #evidenceOf(run: LoopRunRow, attempt: LoopAttemptRow): EvidenceRecord[] {
    return this.#evidenceLookup?.(run, attempt.evidenceIds) ?? [];
  }

  /** Set by the host wiring: resolves a run's evidence ids to records. */
  #evidenceLookup?: (run: LoopRunRow, ids: string[]) => EvidenceRecord[];
  setEvidenceLookup(fn: (run: LoopRunRow, ids: string[]) => EvidenceRecord[]): void {
    this.#evidenceLookup = fn;
  }

  /** Queue a stopped attempt's prompt again, with steering sent since. */
  async #requeue(run: LoopRunRow, attempt: LoopAttemptRow): Promise<void> {
    await this.#startAttempt(run.id, (r) => withSteering(attempt.prompt ?? "", r.pendingSteer));
  }

  #finishAttempt(attempt: LoopAttemptRow, result: AttemptResult, note: string): void {
    const now = Date.now();
    const fresh = this.#store.getAttempt(attempt.id) ?? attempt;
    // An approval wait that never got its answer ends with the attempt.
    const heldMs = fresh.heldSince !== null ? fresh.heldMs + (now - fresh.heldSince) : fresh.heldMs;
    // A verified attempt's work ended when its checks began.
    const endedAt = fresh.endedAt ?? now;
    this.#store.updateAttempt(attempt.id, { status: "done", result, note, endedAt, heldSince: null, heldMs });
    this.#timedOut.delete(attempt.id);
    this.#remaining.delete(attempt.id);
    this.#store.appendEvent(attempt.runId, SYSTEM, `attempt.${result}`, note.slice(0, 500));
  }


  #end(run: LoopRunRow, status: LoopStatus, reason: string): void {
    const latest = this.#store.getRun(run.id) ?? run;
    if (isTerminalLoopStatus(latest.status)) return;
    const next = this.#store.transition(
      run.id,
      latest.stateVersion,
      { status, reason, waitingOn: null, endedAt: Date.now() },
      { actor: SYSTEM, type: `run.${status}`, detail: reason.slice(0, 500) },
    );
    if (next) {
      this.#release(next);
      this.#host.audit(next, `loop.${status}`, reason.slice(0, 200));
      this.#host.notifyOwner(next, "finished");
    }
  }

  async #stopActiveWork(run: LoopRunRow, reason: string): Promise<void> {
    this.#verifying.get(run.id)?.abort();
    const current = this.#currentAttempt(run.id);
    if (current && current.status !== "done") {
      this.#clearDeadline(current.id);
      if (current.dispatchTaskId) this.#host.cancelAttemptTask(current.dispatchTaskId, reason);
      this.#store.updateAttempt(current.id, { status: "done", result: "stopped", note: reason, endedAt: Date.now() });
    }
    for (const id of new Set([current?.workerSessionId, run.workerSessionId])) {
      if (id && this.#host.workerAlive(id)) await this.#host.interruptWorker(id).catch(() => {});
    }
  }

  #armDeadline(run: LoopRunRow, attempt: Pick<LoopAttemptRow, "id">, ms: number): void {
    this.#clearDeadline(attempt.id);
    const t = setTimeout(() => {
      this.#deadlines.delete(attempt.id);
      this.#timedOut.add(attempt.id);
      this.#store.appendEvent(run.id, SYSTEM, "attempt.deadline", `${run.contract.limits.attemptMinutes} minute(s)`);
      const sessionId = this.#store.getAttempt(attempt.id)?.workerSessionId ?? this.#store.getRun(run.id)?.workerSessionId;
      // Interrupting ends the turn; the dispatcher then settles the attempt
      // and verification judges what the workspace holds. A worker with no
      // turn to end (its settle was lost) is settled here.
      if (!sessionId || this.#host.workerInfo(sessionId)?.status === "idle") {
        // Its task's settle was lost: free its worker slot too.
        const taskId = this.#store.getAttempt(attempt.id)?.dispatchTaskId;
        if (taskId) this.#host.cancelAttemptTask(taskId, "the attempt's time ran out");
        this.attemptSettled(run.id, attempt.id, "done");
      }
      else void this.#host.interruptWorker(sessionId).catch(() => {});
    }, ms);
    t.unref?.();
    this.#deadlines.set(attempt.id, t);
    this.#deadlineAt.set(attempt.id, Date.now() + ms);
  }

  /** Attempt time left when its clock was stopped. */
  readonly #remaining = new Map<string, number>();
  readonly #deadlineAt = new Map<string, number>();

  #pauseDeadline(attemptId: string): void {
    const at = this.#deadlineAt.get(attemptId);
    if (at === undefined) return;
    this.#remaining.set(attemptId, Math.max(0, at - Date.now()));
    this.#clearDeadline(attemptId);
  }

  #resumeDeadline(run: LoopRunRow, attemptId: string): void {
    const left = this.#remaining.get(attemptId);
    this.#remaining.delete(attemptId);
    if (left !== undefined) this.#armDeadline(run, { id: attemptId }, left);
  }

  #clearDeadline(attemptId: string): void {
    const t = this.#deadlines.get(attemptId);
    if (t) clearTimeout(t);
    this.#deadlines.delete(attemptId);
    this.#deadlineAt.delete(attemptId);
  }
}

/**
 * How an attempt ended. Evidence decides: passing every check is `verified`
 * whatever the worker said; a worker's conflict report matters only when the
 * checks don't pass.
 */
export function judgeAttempt(f: {
  asked: boolean;
  snapshotted: boolean;
  allPass: boolean;
  timedOut: boolean;
  reportedConflict: boolean;
}): AttemptResult {
  if (f.asked) return "needs_input";
  if (!f.snapshotted) return "unverified";
  if (f.allPass) return "verified";
  if (f.timedOut) return "timed_out";
  if (f.reportedConflict) return "cannot_satisfy";
  return "unverified";
}

function describeResult(result: AttemptResult, evidence: EvidenceRecord[]): string {
  const failing = evidence.filter((e) => e.result !== "pass");
  switch (result) {
    case "verified":
      return `every check passed (${evidence.map((e) => e.criterionId).join(", ")})`;
    case "needs_input":
      return "the worker asked the owner a question";
    case "cannot_satisfy":
      return "the worker reported a conflict with its checks";
    case "timed_out":
      return `ran out of time; ${failing.length} check(s) not passing`;
    default:
      return `${failing.length} of ${evidence.length} check(s) not passing: ${failing.map((e) => `${e.criterionId} ${e.result}`).join(", ")}`;
  }
}

function resolveBaseRef(ref: LoopBaseRef): LoopBaseRef {
  if (!SHA_RE.test(ref.sha)) throw new LoopError("baseRef.sha must be a full commit id", "invalid_request");
  if (ref.branch !== undefined && !SAFE_BRANCH_RE.test(ref.branch)) throw new LoopError("baseRef.branch is not a usable branch name", "invalid_request");
  if (ref.fetchRef !== undefined && !FETCH_REF_RE.test(ref.fetchRef)) throw new LoopError("baseRef.fetchRef is not a branch or pull request ref", "invalid_request");
  if (ref.repo !== undefined && !isRepo(ref.repo)) throw new LoopError("baseRef.repo is not a GitHub repository name", "invalid_request");
  if (ref.fetchRef !== undefined && ref.repo === undefined) throw new LoopError("baseRef.fetchRef needs baseRef.repo", "invalid_request");
  return {
    sha: ref.sha,
    ...(ref.branch ? { branch: ref.branch } : {}),
    ...(ref.repo ? { repo: ref.repo } : {}),
    ...(ref.fetchRef ? { fetchRef: ref.fetchRef } : {}),
    ...(ref.trusted === true ? { trusted: true } : {}),
  };
}

function tenantOf(owner: LoopOwner): LoopTenant {
  return { accountId: owner.accountId, projectId: owner.projectId };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A counting semaphore: `acquire` resolves with a release once a slot is free. */
class Semaphore {
  #free: number;
  readonly #waiting: Array<() => void> = [];
  constructor(slots: number) {
    this.#free = slots;
  }
  /** Resolves with a release once a slot is free, or null if `signal` aborts first. */
  async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return null;
    if (this.#free > 0) {
      this.#free--;
    } else {
      const got = await new Promise<boolean>((res) => {
        const wake = (): void => res(true);
        this.#waiting.push(wake);
        signal?.addEventListener(
          "abort",
          () => {
            const i = this.#waiting.indexOf(wake);
            if (i >= 0) this.#waiting.splice(i, 1);
            res(false);
          },
          { once: true },
        );
      });
      if (!got) return null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    };
  }
}
