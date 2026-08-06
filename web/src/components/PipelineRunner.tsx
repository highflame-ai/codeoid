/**
 * Pipeline Runner — the user-facing way to RUN an installed pack
 * (docs/pipeline-run.md). Opened by the `/pipeline` slash command (and a
 * per-pack Run action) via the exported `openPipelineRunner(goal?)` signal
 * (mirrors `openPackBrowser`).
 *
 * Two states, both driven by state/pipelines.ts:
 *   • Start panel  — pick an installed + active pack, a workdir, and a goal;
 *     Start → runPipeline (create → advance, fire-and-forget).
 *   • Run view     — the phase rail (per-phase status + role, current/halted
 *     highlighted); at a gate halt an Approve / Revise / Reject card; a
 *     terminal status when the run finishes; a subtle "running…" indicator
 *     while a phase is in flight (the poll loop reflects progress — there is
 *     no push for pipelines).
 *
 * This component only renders + dispatches; the round-trips (and the poll
 * loop) live in state/pipelines.ts. `PipelineRunnerView` is the pure
 * presentational body, exported for a render test (mirrors PackBrowserView).
 */

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { openPipelineModal } from "./NewSessionModal";
import { abort, approve, pipelinesState, reject, revise } from "../state/pipelines";
import { focusSession, focusedSessionId, sessionList } from "../state/sessions";
import type { PipelinePhaseWire, PipelineWire } from "../protocol/types";

// The cockpit can collapse to a thin tab so the run's chat gets the full pane.
const [collapsed, setCollapsed] = createSignal(false);

/** `/pipeline` (and the Pack Browser's Run action) open the START DIALOG — the
 *  extended create-session modal in pipeline mode. The cockpit itself auto-
 *  appears once a run is created and its bound session is focused. Kept as a thin
 *  alias so existing call sites (PromptBox, PackBrowser) need no change. */
export function openPipelineRunner(goal?: string): void {
  setCollapsed(false);
  openPipelineModal(goal);
}

export function closePipelineRunner(): void {
  setCollapsed(true);
}

const PipelineRunner: Component = () => {
  // The cockpit overlays the RUN's chat: the full dock appears only when the
  // focused session is the run's bound session (a run is a conductor over that
  // live session — docs/pipeline-run.md). Collapsed, or viewing another session,
  // it falls back to a thin reopen tab (so it's never unreachable). The run keeps
  // polling in the background either way.
  const pipeline = () => pipelinesState().pipeline;
  const runSessionId = () => pipeline()?.sessionId ?? null;
  // The full dock overlays the RUN's own session chat, so it shows only when
  // that session is focused and the user hasn't collapsed it.
  const onRunSession = () => !!runSessionId() && runSessionId() === focusedSessionId();
  const dockOpen = () => onRunSession() && !collapsed();
  // A reopen affordance must persist whenever a run EXISTS — not just while its
  // session is focused. Collapsing with Esc (or switching to another session)
  // must never strand the user with no way back: the old tab only rendered on
  // the run's own session, so navigating away after collapsing left nothing to
  // click, and `/pipeline` starts a NEW run rather than restoring this one.
  // BUT the run's bound session must still EXIST: if the user destroys it, the
  // pipeline lingers in state with a dangling sessionId — without this check the
  // thin tab would haunt every other session (there's nothing to reopen).
  const hasRun = () => {
    const id = runSessionId();
    return !!id && sessionList().some((s) => s.id === id);
  };

  // Bring the cockpit back: jump to the run's own session (so the dock can
  // overlay its chat) AND expand it. Works from any session and any collapsed
  // state — this is the guaranteed path back that the plain tab lacked.
  const reopen = () => {
    const id = runSessionId();
    if (id) focusSession(id);
    setCollapsed(false);
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dockOpen()) {
        e.preventDefault();
        setCollapsed(true);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={hasRun()}>
      <Show
        when={dockOpen()}
        fallback={
          <button
            type="button"
            onClick={reopen}
            class="fixed right-0 top-24 z-30 rounded-l border border-r-0 border-border bg-bg-elev px-2 py-2 text-[11px] text-fg-muted shadow-lg hover:text-fg"
            title="Show pipeline cockpit (Esc to collapse)"
          >
            ▸ pipeline
          </button>
        }
      >
        {/* Non-modal right dock: no backdrop, so the run's chat stays interactive
            on the left while the cockpit overlays the right edge. */}
        <aside class="fixed right-0 top-0 z-30 flex h-full w-full max-w-sm flex-col border-l border-border bg-bg-elev/95 shadow-2xl backdrop-blur-sm">
          <header class="flex items-center gap-2 border-b border-border px-3 py-2">
            <h2 class="text-[13px] font-semibold tracking-tight text-fg">Pipeline</h2>
            <span class="font-mono text-[10px] text-fg-faint">spec → ship</span>
            <span class="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => abort()}
                class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-danger/40 hover:text-danger disabled:opacity-50"
                disabled={pipelinesState().busy}
                title="Abort this run"
              >
                Abort
              </button>
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                class="text-fg-faint hover:text-fg"
                title="Collapse (Esc)"
              >
                ✕
              </button>
            </span>
          </header>

          <Show when={pipelinesState().error}>
            <div class="border-b border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {pipelinesState().error}
            </div>
          </Show>

          {/* Create-time binding notes (a --role/config binding skipped
              because it targets a backend other than the run session's, an
              unmapped tier) — non-fatal, but the operator should see them. */}
          <Show when={pipelinesState().warnings.length > 0}>
            <div class="border-b border-warn/40 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
              <For each={pipelinesState().warnings}>{(w) => <div>⚠ {w}</div>}</For>
            </div>
          </Show>

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <PipelineRunnerView
              pipeline={pipeline()}
              busy={pipelinesState().busy}
              onApprove={(reqId, value) => approve(reqId, value)}
              onReject={(reqId, value) => reject(reqId, value)}
              onRevise={(reqId, feedback) => revise(reqId, feedback)}
            />
          </div>

          <footer class="border-t border-border px-3 py-2 text-[10px] text-fg-faint">
            The run drives this session's chat, halting at each phase for your
            Approve / Revise / Reject. Phases run under their pack role.
          </footer>
        </aside>
      </Show>
    </Show>
  );
};

// ── Presentational body ───────────────────────────────────────────────────────

export interface PipelineRunnerViewProps {
  /** The active run, or null → a subtle "no active run" note. */
  pipeline: PipelineWire | null;
  /** A steer is in flight — disable actions. */
  busy?: boolean;
  onApprove: (requestId: string, value?: string) => void;
  onReject: (requestId: string, value?: string) => void;
  onRevise: (requestId: string, feedback: string) => void;
}

/** Pure body — no daemon calls. Exported for a render test. The run is STARTED
 *  from the create-session dialog (pipeline mode); this only renders + steers. */
export const PipelineRunnerView: Component<PipelineRunnerViewProps> = (props) => (
  <Show when={props.pipeline} fallback={<p class="text-[12px] text-fg-faint">No active run.</p>}>
    {(pipeline) => (
      <RunView
        pipeline={pipeline()}
        busy={props.busy}
        onApprove={props.onApprove}
        onReject={props.onReject}
        onRevise={props.onRevise}
      />
    )}
  </Show>
);

// ── Run view ─────────────────────────────────────────────────────────────────

const inputClass =
  "w-full rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50";

const labelClass =
  "text-[10px] font-semibold uppercase tracking-wider text-fg-faint";

const TERMINAL: readonly PipelineWire["status"][] = [
  "merged",
  "done",
  "failed",
  "abandoned",
];

function statusClass(status: PipelinePhaseWire["status"]): string {
  switch (status) {
    case "running":
      return "border-accent/50 bg-accent/10 text-accent";
    case "halted":
      return "border-warn/50 bg-warn/10 text-warn";
    case "passed":
      return "border-success/50 bg-success/10 text-success";
    case "skipped":
      return "border-border bg-bg/40 text-fg-faint";
    case "failed":
      return "border-danger/50 bg-danger/10 text-danger";
    case "pending":
    default:
      return "border-border bg-bg/40 text-fg-muted";
  }
}

function pipelineStatusClass(status: PipelineWire["status"]): string {
  switch (status) {
    case "running":
      return "border-accent/50 bg-accent/10 text-accent";
    case "halted":
      return "border-warn/50 bg-warn/10 text-warn";
    case "merged":
    case "done":
      return "border-success/50 bg-success/10 text-success";
    case "failed":
    case "abandoned":
      return "border-danger/50 bg-danger/10 text-danger";
    case "draft":
    default:
      return "border-border bg-bg/40 text-fg-muted";
  }
}

const RunView: Component<{
  pipeline: PipelineWire;
  busy?: boolean;
  onApprove: (requestId: string, value?: string) => void;
  onReject: (requestId: string, value?: string) => void;
  onRevise: (requestId: string, feedback: string) => void;
}> = (props) => {
  const p = () => props.pipeline;
  const terminal = () => TERMINAL.includes(p().status);
  // The gate halt awaiting a decision (carries the requestId to echo back).
  const halted = () =>
    p().phases.find((ph) => ph.status === "halted" && !!ph.requestId);
  const isRunning = () => p().status === "running" || (!!props.busy && !terminal());

  return (
    <div class="flex flex-col gap-4">
      {/* Header: name + overall status. */}
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono text-[13px] text-fg">{p().name}</span>
        <span
          class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${pipelineStatusClass(
            p().status,
          )}`}
        >
          {p().status}
        </span>
        <Show when={isRunning()}>
          <span
            class="ml-auto flex items-center gap-1.5 text-[11px] text-accent"
            aria-label="running"
          >
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            running…
          </span>
        </Show>
      </div>

      <Show when={p().spec}>
        <p class="rounded border border-border bg-bg/30 px-3 py-2 text-[12px] text-fg-muted">
          {p().spec}
        </p>
      </Show>

      {/* Phase rail. */}
      <div class="flex flex-wrap items-center gap-1.5">
        <For each={p().phases}>
          {(ph, i) => (
            <>
              <Show when={i() > 0}>
                <span class="text-fg-faint" aria-hidden="true">
                  →
                </span>
              </Show>
              <span
                class={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[11px] ${statusClass(
                  ph.status,
                )} ${i() === p().cursor ? "ring-1 ring-accent/40" : ""}`}
                title={ph.summary ?? ph.reason ?? ph.status}
              >
                {ph.id}
                <Show when={ph.role}>
                  <span
                    class="rounded bg-accent/20 px-1 py-0.5 text-[9px] uppercase tracking-wider text-accent"
                    title={`role: ${ph.role}`}
                  >
                    {ph.role}
                  </span>
                </Show>
                <span class="text-[9px] uppercase tracking-wider opacity-80">
                  {ph.status}
                </span>
              </span>
            </>
          )}
        </For>
      </div>

      {/* Gate halt — Approve / Revise / Reject. Hidden while a decision is in
          flight (busy) so the moment you click Approve the card disappears and
          the live phase rail + "running…" indicator show through, rather than a
          stale card lingering over the next phase's status. */}
      <Show when={!props.busy && p().status === "halted" && halted()}>
        {(phase) => (
          <HaltCard
            phase={phase()}
            busy={props.busy}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onRevise={props.onRevise}
          />
        )}
      </Show>

      {/* Terminal outcome. */}
      <Show when={terminal()}>
        <div
          class={`rounded border px-3 py-3 text-[12px] ${pipelineStatusClass(
            p().status,
          )}`}
        >
          Run {p().status}.
          <Show when={p().phases.find((ph) => ph.status === "failed")?.reason}>
            {(reason) => (
              <span class="mt-1 block font-mono text-[11px] opacity-90">
                {reason()}
              </span>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
};

const HaltCard: Component<{
  phase: PipelinePhaseWire;
  busy?: boolean;
  onApprove: (requestId: string, value?: string) => void;
  onReject: (requestId: string, value?: string) => void;
  onRevise: (requestId: string, feedback: string) => void;
}> = (props) => {
  const [value, setValue] = createSignal("");
  const [feedback, setFeedback] = createSignal("");
  const reqId = () => props.phase.requestId!;
  const btn =
    "rounded border px-3 py-1.5 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div class="rounded border border-warn/40 bg-warn/5 px-3 py-3">
      <div class="flex items-center gap-2">
        <span class="font-mono text-[13px] text-fg">
          {props.phase.name ?? props.phase.id}
        </span>
        <span class="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warn">
          halted at gate
        </span>
        <Show when={props.phase.role}>
          <span class="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
            {props.phase.role}
          </span>
        </Show>
      </div>

      <Show when={props.phase.reason}>
        <p class="mt-2 text-[12px] text-fg-muted">{props.phase.reason}</p>
      </Show>

      <Show when={props.phase.summary}>
        <p class="mt-2 whitespace-pre-wrap text-[12px] text-fg">
          {props.phase.summary}
        </p>
      </Show>

      <Show when={(props.phase.questions?.length ?? 0) > 0}>
        <ul class="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-fg-muted">
          <For each={props.phase.questions}>{(q) => <li>{q}</li>}</For>
        </ul>
      </Show>

      {/* Prior revise notes, oldest → newest. */}
      <Show when={(props.phase.feedback?.length ?? 0) > 0}>
        <div class="mt-3">
          <div class={labelClass}>Revision history</div>
          <ol class="mt-1 space-y-1">
            <For each={props.phase.feedback}>
              {(f, i) => (
                <li class="rounded border border-border bg-bg/40 px-2 py-1 text-[11px] text-fg-muted">
                  <span class="mr-1.5 font-mono text-fg-faint">#{i() + 1}</span>
                  {f}
                </li>
              )}
            </For>
          </ol>
        </div>
      </Show>

      {/* Optional decision note (summary on approve / reason on reject). */}
      <label class="mt-3 flex flex-col gap-1">
        <span class={labelClass}>Note (optional)</span>
        <input
          type="text"
          autocomplete="off"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          class={inputClass}
          disabled={props.busy}
          aria-label="Decision note"
          placeholder="Accepted / rejected because…"
        />
      </label>

      {/* Revise feedback (required to revise). */}
      <label class="mt-2 flex flex-col gap-1">
        <span class={labelClass}>Revise feedback</span>
        <textarea
          rows={3}
          value={feedback()}
          onInput={(e) => setFeedback(e.currentTarget.value)}
          class={`${inputClass} resize-y leading-6`}
          disabled={props.busy}
          aria-label="Revise feedback"
          placeholder="What should this phase do differently? It re-runs with your notes."
        />
      </label>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class={`${btn} border-success/50 bg-success/10 text-success hover:bg-success/20`}
          disabled={props.busy}
          onClick={() => props.onApprove(reqId(), value().trim() || undefined)}
        >
          Approve
        </button>
        <button
          type="button"
          class={`${btn} border-accent/50 bg-accent/10 text-accent hover:bg-accent/20`}
          disabled={props.busy || !feedback().trim()}
          onClick={() => props.onRevise(reqId(), feedback().trim())}
          title={feedback().trim() ? undefined : "Enter feedback to revise"}
        >
          Revise
        </button>
        <button
          type="button"
          class={`${btn} border-danger/50 bg-danger/10 text-danger hover:bg-danger/20`}
          disabled={props.busy}
          onClick={() => props.onReject(reqId(), value().trim() || undefined)}
        >
          Reject
        </button>
      </div>
    </div>
  );
};

export default PipelineRunner;
