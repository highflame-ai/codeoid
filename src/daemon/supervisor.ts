/**
 * Wall-time deadlines for a session's attempt (loop design §8, §12.11 "Hung work").
 *
 * The stall watchdog pauses while a tool runs, and a dispatch lease keeps
 * renewing while the session lives, so a tool without its own timeout can hold
 * a task forever. A deadline is the bound that holds regardless: it counts
 * wall time from `supervise()` and looks at nothing but the clock.
 *
 * On expiry it interrupts the session (the Esc path: stops the turn, reaps the
 * running tool where the backend can). If the session has not settled within
 * `graceMs` — the interrupt itself can wedge on a backend that stopped
 * answering — it terminates the backend (Session.terminateBackend: the
 * provider is torn down and its child process killed, as stall recovery
 * does). `expired` then resolves true.
 *
 * The deadline owns exactly one timer at a time and clears it on every exit
 * path; `cancel()` before expiry resolves `expired` false and leaves nothing
 * scheduled.
 */

import type { AuthContext, SessionStatus } from "../protocol/types.js";

/** The slice of Session a deadline drives (narrow, so tests can fake it). */
export interface SupervisedSession {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly status: SessionStatus;
  /** A queued send is about to start a turn — not settled even when idle. */
  readonly preparingTurn: boolean;
  interrupt(sender: AuthContext): Promise<void>;
  terminateBackend(sender: AuthContext, reason: string): Promise<void>;
}

export interface DeadlineOptions {
  /** Wall time the attempt may run, from now. */
  wallMs: number;
  /** After the interrupt, how long the session gets to settle before its backend is killed. */
  graceMs: number;
  /** Who the interrupt and termination are audited as. Default `system:supervisor` in the session's tenant. */
  sender?: AuthContext;
  /** How often the grace period re-checks for a settled session. Default 100ms (bounded by graceMs). */
  pollMs?: number;
  /** Observes each step (logging, tests). Exceptions are swallowed. */
  onEvent?: (event: DeadlineEvent) => void;
}

export type DeadlineEvent =
  | { type: "expired"; sessionId: string }
  | { type: "settled"; sessionId: string }
  | { type: "terminated"; sessionId: string };

export interface Deadline {
  /**
   * Stop supervising. Before expiry: nothing fires and `expired` resolves
   * false. During the grace period: the kill escalation is abandoned (the
   * interrupt has already been sent) and `expired` resolves true. Idempotent.
   */
  cancel(): void;
  /** true once the wall time ran out and enforcement finished; false when cancelled first. */
  readonly expired: Promise<boolean>;
}

/** A session is settled when no turn is running or about to start. */
function settled(session: SupervisedSession): boolean {
  return (session.status === "idle" || session.status === "error") && !session.preparingTurn;
}

export function supervise(session: SupervisedSession, opts: DeadlineOptions): Deadline {
  const { wallMs, graceMs } = opts;
  if (!Number.isFinite(wallMs) || wallMs <= 0) throw new RangeError(`supervise: wallMs must be a positive number (got ${wallMs})`);
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError(`supervise: graceMs must be zero or more (got ${graceMs})`);
  const pollMs = Math.max(1, Math.min(opts.pollMs ?? 100, graceMs || 1));
  const sender: AuthContext = opts.sender ?? {
    sub: "system:supervisor",
    scopes: [],
    delegationDepth: 0,
    accountId: session.accountId,
    projectId: session.projectId,
  };
  const note = (event: DeadlineEvent) => {
    try {
      opts.onEvent?.(event);
    } catch {
      // observability must not break enforcement
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let fired = false;
  let resolveExpired!: (v: boolean) => void;
  const expired = new Promise<boolean>((r) => {
    resolveExpired = r;
  });

  const arm = (fn: () => void, ms: number) => {
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
    // A deadline must not keep a process alive on its own.
    timer.unref?.();
  };
  const finish = (result: boolean) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    timer = null;
    resolveExpired(result);
  };

  const terminate = () => {
    if (done) return;
    note({ type: "terminated", sessionId: session.id });
    session
      .terminateBackend(sender, `attempt wall time of ${Math.round(wallMs / 1000)}s ran out and it did not stop within ${Math.round(graceMs / 1000)}s`)
      .catch((e) => {
        console.error(`[codeoid/supervisor] terminating session ${session.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => finish(true));
  };

  const graceUntil = (deadline: number) => {
    if (done) return;
    if (settled(session)) {
      note({ type: "settled", sessionId: session.id });
      finish(true);
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      terminate();
      return;
    }
    arm(() => graceUntil(deadline), Math.min(pollMs, left));
  };

  arm(() => {
    if (done) return;
    fired = true;
    note({ type: "expired", sessionId: session.id });
    // Not awaited: interrupt() awaits the backend, which may be the thing
    // that's hung. The grace clock starts now, whatever it does.
    session.interrupt(sender).catch((e) => {
      console.error(`[codeoid/supervisor] interrupting session ${session.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    graceUntil(Date.now() + graceMs);
  }, wallMs);

  return {
    cancel: () => finish(fired),
    expired,
  };
}
