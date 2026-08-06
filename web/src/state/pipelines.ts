/**
 * Pipeline-run state — a single active governed SDLC run (docs/pipeline-run.md).
 * Mirrors state/packs.ts (module-singleton signal, `getClient().request` with a
 * typed `waitForResult`, a `_reset*ForTest` hook), with two differences dictated
 * by the wire contract:
 *
 *   1. There is NO push/broadcast for pipelines — connection.ts's broadcast
 *      router has no pipeline case — so progress + halts are reflected by a
 *      POLL LOOP on `pipeline.get` (~2s) that stops once the run is terminal.
 *
 *   2. `advance` / `answer` / `revise` block SERVER-SIDE for minutes (each phase
 *      is a real model turn, up to ~10 min), well past the default request
 *      timeout. They're fired fire-and-forget with a large timeout and are NOT
 *      relied on for progression — the poll loop drives the view. A client-side
 *      timeout on one of them is expected and is swallowed; only a real
 *      rejection (forbidden scope, disabled, invalid) surfaces as `error`.
 *
 * Every verb replies with a `pipeline.snapshot { pipeline }`; each reply just
 * replaces the slice. Errors are caught → set `error`; nothing throws.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import { focusSession, mergeSession } from "./sessions";
import type {
  ClientMessage,
  PipelineSnapshotMsg,
  PipelineWire,
} from "../protocol/types";

interface PipelinesState {
  /** The single pipeline being viewed (create → run → terminal). */
  pipeline: PipelineWire | null;
  /** A create / get read is settling (first paint / no pipeline yet). */
  loading: boolean;
  /** A steer (advance/answer/revise/abort) is in flight — a phase is running. */
  busy: boolean;
  /** Last fetch/steer error (e.g. "Pipeline is disabled" or a scope rejection). */
  error: string | null;
  /** Create-time model-binding notes from the daemon (a binding skipped because
   *  it targets a backend other than the run session's, an unmapped tier —
   *  docs/role-model-binding.md §5). Set once at create; polls don't carry them. */
  warnings: string[];
}

const EMPTY: PipelinesState = {
  pipeline: null,
  loading: false,
  busy: false,
  error: null,
  warnings: [],
};

const [state, setState] = createSignal<PipelinesState>(EMPTY);

export const pipelinesState = state;

/** Poll cadence for `pipeline.get` while a run is live. */
const POLL_INTERVAL_MS = 2_000;
/** `get` / `create` are cheap. */
const READ_TIMEOUT_MS = 15_000;
/** advance/answer/revise run a full model turn per phase — give them room past
 *  the point where the poll loop has already reflected the outcome. */
const STEER_TIMEOUT_MS = 15 * 60_000;

const TERMINAL: readonly PipelineWire["status"][] = [
  "merged",
  "done",
  "failed",
  "abandoned",
];

function isTerminal(status: PipelineWire["status"]): boolean {
  return TERMINAL.includes(status);
}

/** A `response.error` rejection is the raw wire object `{ error, code }`; a
 *  transport/timeout failure is an `Error`. Surface whichever human string. */
function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "error" in e) {
    const m = (e as { error?: unknown }).error;
    if (typeof m === "string") return m;
  }
  return e instanceof Error ? e.message : String(e);
}

/** A steer's client-side timeout is EXPECTED (the phase is still running
 *  server-side) — the poll loop drives the view, so don't surface it. */
function isClientTimeout(e: unknown): boolean {
  return e instanceof Error && /timed out/i.test(e.message);
}

function applySnapshot(snap: PipelineSnapshotMsg | undefined): void {
  if (!snap || !snap.pipeline) return;
  setState((s) => ({ ...s, pipeline: snap.pipeline, error: null }));
}

function currentPipelineId(): string | null {
  return state().pipeline?.id ?? null;
}

// ── Poll loop ────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce(pipelineId: string): Promise<void> {
  const id = newRequestId();
  try {
    const snap = await getClient().request<PipelineSnapshotMsg>(
      { type: "pipeline.get", id, pipelineId },
      {
        waitForResult: (m) =>
          m.type === "pipeline.snapshot" && m.requestId === id ? m : undefined,
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    // A poll for the previous run can resolve after the user started a new one;
    // dropping it here keeps a stale snapshot from clobbering the active run.
    if (currentPipelineId() !== pipelineId) return;
    applySnapshot(snap);
    if (snap?.pipeline && isTerminal(snap.pipeline.status)) stopPoll();
  } catch (e) {
    // A blip (socket reconnecting) — surface but keep polling; a later success
    // clears the error via applySnapshot. Same superseded-run guard as above.
    if (currentPipelineId() !== pipelineId) return;
    setState((s) => ({ ...s, error: errMessage(e) }));
  }
}

/** (Re)start the poll loop for `pipelineId`. Cleared on terminal / reset. */
function startPoll(pipelineId: string): void {
  stopPoll();
  pollTimer = setInterval(() => void pollOnce(pipelineId), POLL_INTERVAL_MS);
}

// ── Steering (fire-and-forget, poll-driven) ───────────────────────────────────

/**
 * Fire a steer verb (advance/answer/revise/abort) with a large timeout and do
 * NOT rely on its reply for progression. The poll loop reflects progress; this
 * only best-effort-applies the eventual snapshot and surfaces a *real* (non-
 * timeout) rejection. Marks `busy` while in flight and (re)starts the poll loop.
 */
function fireSteer(build: (id: string) => ClientMessage, pipelineId: string): void {
  const id = newRequestId();
  setState((s) => ({ ...s, busy: true, error: null }));
  getClient()
    .request<PipelineSnapshotMsg>(build(id), {
      waitForResult: (m) =>
        m.type === "pipeline.snapshot" && m.requestId === id ? m : undefined,
      timeoutMs: STEER_TIMEOUT_MS,
    })
    // A steer runs server-side for minutes; if the user switches to another run
    // before it settles, its late resolution must not touch the new run's view
    // (snapshot, error, or the shared `busy` flag). Guard every mutation on the
    // run still being current.
    .then((snap) => {
      if (currentPipelineId() === pipelineId) applySnapshot(snap);
    })
    .catch((e) => {
      if (currentPipelineId() === pipelineId && !isClientTimeout(e)) {
        setState((s) => ({ ...s, error: errMessage(e) }));
      }
    })
    .finally(() => {
      if (currentPipelineId() === pipelineId) setState((s) => ({ ...s, busy: false }));
    });
  // Reflect whatever the steer kicks off (the phase running → its next halt).
  startPoll(pipelineId);
}

function advance(pipelineId: string): void {
  fireSteer((id) => ({ type: "pipeline.advance", id, pipelineId }), pipelineId);
}

/** A short label from the goal for the pipeline's display name. */
function deriveName(goal: string): string {
  const firstLine = goal.trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "pipeline run";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a run from an installed pack + goal, FOCUS its bound session (a run is
 * a conductor over a live session — the chat is the primary surface), then drive
 * it (advance). Everything past `create` is fire-and-forget + poll-driven;
 * `create` is awaited only to learn the pipeline id + its bound session id. A
 * create rejection (e.g. "Pipeline is disabled") surfaces as `error`.
 */
export async function runPipeline(opts: {
  pack: string;
  goal: string;
  workdir: string;
  /** Display name for the run + its session (defaults to a goal-derived label). */
  name?: string;
  /** Backend for the run's bound session ("" / undefined → daemon default). */
  provider?: string;
}): Promise<void> {
  stopPoll();
  setState(() => ({ ...EMPTY, loading: true }));
  const id = newRequestId();
  try {
    const snap = await getClient().request<PipelineSnapshotMsg>(
      {
        type: "pipeline.create",
        id,
        name: opts.name?.trim() || deriveName(opts.goal),
        pack: opts.pack,
        spec: opts.goal,
        workdir: opts.workdir,
        ...(opts.provider ? { providerId: opts.provider } : {}),
      },
      {
        waitForResult: (m) =>
          m.type === "pipeline.snapshot" && m.requestId === id ? m : undefined,
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    applySnapshot(snap);
    // Surface the daemon's create-time binding notes (only the create reply
    // carries them — the poll loop's snapshots don't, so they persist here).
    if (snap?.warnings && snap.warnings.length > 0) {
      const warnings = snap.warnings;
      setState((s) => ({ ...s, warnings }));
    }
    if (snap?.pipeline) {
      const p = snap.pipeline;
      // Focus the bound session so the run shows up as a normal, interruptible
      // chat (the cockpit overlays it), then drive the first phase.
      if (p.sessionId) {
        // Add the session to the list BEFORE focusing it. `pipeline.create`
        // creates the session daemon-side but — unlike plain session.create,
        // which mergeSession()s the returned SessionInfo — the snapshot only
        // carries a sessionId. Focusing an id the list doesn't contain renders
        // the empty "new session" state until the next reconnect refresh pulls
        // it in (30-50s, since there is no periodic list poll). Upsert a partial
        // now; the daemon's info_update/status_change broadcasts complete it.
        mergeSession({
          id: p.sessionId,
          name: p.name,
          workdir: p.workdir ?? opts.workdir,
          status: "thinking",
          // `?? Date.now()` guards a missing createdAt: `new Date(undefined)`
          // is an Invalid Date and .toISOString() throws, which would drop us
          // into the catch and reintroduce the empty-state bug this fixes.
          createdAt: new Date(p.createdAt ?? Date.now()).toISOString(),
          attachedClients: 1,
        });
        focusSession(p.sessionId);
      }
      advance(p.id);
    }
  } catch (e) {
    setState((s) => ({ ...s, error: errMessage(e) }));
  } finally {
    setState((s) => ({ ...s, loading: false }));
  }
}

/** Approve the halted phase (advances to the next halt / terminal). */
export function approve(requestId: string, value?: string): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  const v = value?.trim();
  fireSteer(
    (id) => ({
      type: "pipeline.answer",
      id,
      pipelineId,
      requestId,
      approved: true,
      ...(v ? { value: v } : {}),
    }),
    pipelineId,
  );
}

/** Reject the halted phase (hard-stops the run → terminal fail). */
export function reject(requestId: string, value?: string): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  const v = value?.trim();
  fireSteer(
    (id) => ({
      type: "pipeline.answer",
      id,
      pipelineId,
      requestId,
      approved: false,
      ...(v ? { value: v } : {}),
    }),
    pipelineId,
  );
}

/** Re-run the halted phase with human feedback (loops back to a halt). */
export function revise(requestId: string, feedback: string): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  fireSteer(
    (id) => ({ type: "pipeline.revise", id, pipelineId, requestId, feedback }),
    pipelineId,
  );
}

/** Abort the run (→ terminal abandoned). */
export function abort(): void {
  const pipelineId = currentPipelineId();
  if (!pipelineId) return;
  fireSteer((id) => ({ type: "pipeline.abort", id, pipelineId }), pipelineId);
}

/** Test-only: reset the module singleton (and stop the poll loop) between cases. */
export function _resetPipelinesForTest(): void {
  stopPoll();
  setState(EMPTY);
}
