/**
 * Loops (docs/loops.md) — the owner's runs, one run's detail, and the start
 * form, in one right-hand drawer. Opened by `/loops` (the list), `/loop
 * [objective…]` (the start form, mirroring `/pipeline`), the status bar's
 * loops button, and a loop row in the "Needs you" inbox (the run's detail).
 *
 * The drawer only renders and dispatches; reads, controls and the poll loop
 * live in state/loops.ts. `LoopList`, `LoopDetail` and `LoopStartForm` are
 * presentational and tested on their own.
 */

import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { LoopDetail } from "./LoopDetail";
import { LoopStartForm } from "./LoopStartForm";
import { formatCostUsd, relativeTime } from "../lib/format";
import { LOOP_STATUS, isTerminalLoop, loopWaitKind, objectiveTitle } from "../lib/loops";
import { nowTick } from "../state/clock";
import {
  cancelLoop,
  closeLoops,
  loopsState,
  loopsViewOpen,
  openLoops,
  pauseLoop,
  resumeLoop,
  selectLoop,
  setLoopHistoryOpen,
  startLoop,
  steerLoop,
} from "../state/loops";
import { providerIds, providerLabel } from "../state/providers";
import { focusSession, sessionList } from "../state/sessions";
import type { LoopRunWire } from "../protocol/types";

/** Non-null while the start form shows; the objective it was opened with. */
const [startPrefill, setStartPrefill] = createSignal<string | null>(null);

/** `/loops` and the status bar: the list. */
export function showLoops(): void {
  setStartPrefill(null);
  openLoops();
}

/** `/loop [objective…]`: the start form, optionally prefilled. */
export function openLoopStart(objective?: string): void {
  setStartPrefill(objective ?? "");
  openLoops();
}

const LoopsPanel: Component = () => {
  const s = loopsState;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && loopsViewOpen()) {
        e.preventDefault();
        closeLoops();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // A run opened from elsewhere (the inbox) replaces the start form.
  createEffect(() => {
    if (s().selectedId) setStartPrefill(null);
  });

  const recentWorkdirs = createMemo(() => [...new Set(sessionList().map((x) => x.workdir).filter(Boolean))].slice(0, 6));
  const sessionIds = createMemo(() => new Set(sessionList().map((x) => x.id)));

  return (
    <Show when={loopsViewOpen()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-end bg-bg/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeLoops();
        }}
      >
        <aside class="flex h-full w-full max-w-2xl flex-col border-l border-border bg-bg-elev shadow-2xl">
          <header class="flex items-center gap-3 border-b border-border px-4 py-3">
            <h2 class="text-base font-semibold tracking-tight text-fg">Loops</h2>
            <span class="font-mono text-[11px] text-fg-faint">done only when the daemon's checks pass</span>
            <span class="ml-auto flex items-center gap-2">
              <Show when={startPrefill() === null && !s().selectedId}>
                <button
                  type="button"
                  onClick={() => openLoopStart()}
                  class="rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20"
                >
                  New loop
                </button>
              </Show>
              <button type="button" onClick={() => closeLoops()} class="text-fg-faint hover:text-fg" title="Close (Esc)">
                ✕
              </button>
            </span>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <Show
              when={s().selectedId}
              keyed
              fallback={
                <Show
                  when={startPrefill() !== null}
                  fallback={
                    <>
                      <Show when={s().error}>
                        <div class="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                          {s().error}
                        </div>
                      </Show>
                      <LoopList runs={s().runs} loaded={s().loaded} now={nowTick()} onSelect={selectLoop} onNew={() => openLoopStart()} />
                    </>
                  }
                >
                  <LoopStartForm
                    objective={startPrefill() ?? ""}
                    recentWorkdirs={recentWorkdirs()}
                    providers={providerIds().map((id) => ({ id, label: providerLabel(id) }))}
                    onSubmit={async (body) => {
                      await startLoop(body);
                    }}
                    onCancel={() => setStartPrefill(null)}
                  />
                </Show>
              }
            >
              {(id) => (
                <Show
                  when={s().detail?.run.id === id ? s().detail : null}
                  fallback={
                    <Show when={s().error} fallback={<p class="text-xs text-fg-faint">loading…</p>}>
                      <div class="flex flex-col gap-2">
                        <button type="button" class="self-start text-[11px] text-fg-muted hover:text-fg" onClick={() => selectLoop(null)}>
                          ← all loops
                        </button>
                        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">{s().error}</div>
                      </div>
                    </Show>
                  }
                >
                  {(d) => (
                    <LoopDetail
                      run={d().run}
                      attempts={d().attempts}
                      events={d().events}
                      historyOpen={s().historyOpen}
                      busy={s().busy}
                      error={s().error}
                      now={Date.now()}
                      workerAvailable={!!d().run.workerSessionId && sessionIds().has(d().run.workerSessionId!)}
                      onBack={() => selectLoop(null)}
                      onPause={() => void pauseLoop(id)}
                      onResume={() => void resumeLoop(id)}
                      onCancel={() => void cancelLoop(id)}
                      onSteer={(text) => steerLoop(id, text)}
                      onOpenWorker={() => {
                        const worker = d().run.workerSessionId;
                        if (!worker) return;
                        focusSession(worker);
                        closeLoops();
                      }}
                      onToggleHistory={setLoopHistoryOpen}
                    />
                  )}
                </Show>
              )}
            </Show>
          </div>
        </aside>
      </div>
    </Show>
  );
};

// ── List ─────────────────────────────────────────────────────────────────────

export interface LoopListProps {
  runs: LoopRunWire[];
  loaded: boolean;
  now: number;
  onSelect: (runId: string) => void;
  onNew: () => void;
}

export const LoopList: Component<LoopListProps> = (props) => (
  <Show
    when={props.runs.length > 0}
    fallback={
      <Show when={props.loaded} fallback={<p class="text-xs text-fg-faint">loading…</p>}>
        <div class="flex flex-col items-start gap-2 text-[12px] text-fg-muted">
          <p>
            No loop runs yet. A loop pursues one objective in its own worktree until checks the daemon runs itself
            pass, then hands you the result as a commit on its own branch.
          </p>
          <button type="button" class="text-accent underline-offset-2 hover:underline" onClick={() => props.onNew()}>
            Start a loop
          </button>
        </div>
      </Show>
    }
  >
    <ul class="flex flex-col divide-y divide-border/50 rounded border border-border">
      <For each={props.runs}>
        {(run) => {
          const style = () => LOOP_STATUS[run.status];
          return (
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-bg-hover"
                onClick={() => props.onSelect(run.id)}
                data-testid="loop-row"
              >
                <span
                  class={`w-28 shrink-0 truncate rounded border px-1.5 py-0.5 text-center text-[10px] uppercase tracking-wider ${style().cls}`}
                  title={style().meaning}
                >
                  {style().mark} {style().label}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px] text-fg">{objectiveTitle(run.objective)}</span>
                  <Show when={loopWaitKind(run) === "question" || (isTerminalLoop(run.status) && run.reason)}>
                    <span class="block truncate text-[11px] text-fg-muted">
                      {loopWaitKind(run) === "question" ? "asks you a question" : run.reason}
                    </span>
                  </Show>
                </span>
                <span class="shrink-0 font-mono text-[11px] text-fg-muted" title="attempts used / allowed">
                  {run.attempts}/{run.limits.attempts}
                </span>
                <span class="w-14 shrink-0 text-right font-mono text-[11px] text-fg-muted">{formatCostUsd(run.costUsd)}</span>
                <span class="w-16 shrink-0 text-right font-mono text-[10px] text-fg-faint">
                  {relativeTime(run.createdAt, props.now)}
                </span>
              </button>
            </li>
          );
        }}
      </For>
    </ul>
  </Show>
);

export default LoopsPanel;
