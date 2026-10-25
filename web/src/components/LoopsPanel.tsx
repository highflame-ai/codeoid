/**
 * Automation — one right-hand drawer with three tabs:
 *
 *   - Runs (docs/loops.md): the owner's loop runs, one run's detail, and the
 *     start form. Opened by `/loops` (the list), `/loop [objective…]` (the
 *     start form, mirroring `/pipeline`), the status bar's automation button,
 *     and a loop row in the "Needs you" inbox (the run's detail);
 *   - Watches (docs/loops.md "Watches"): rules that start runs from GitHub;
 *   - Routines (docs/routines.md): saved agent tasks on a schedule or an API.
 *
 * Watches start loop runs, so they sit beside them; routines are the other
 * kind of unattended work, so they share the drawer rather than adding a
 * fourth one. Only the visible tab's store polls at the view's pace.
 *
 * The drawer only renders and dispatches; reads, controls and the poll loops
 * live in state/loops.ts, state/watches.ts and state/routines.ts. The lists,
 * details and forms are presentational and tested on their own.
 */

import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { LoopDetail } from "./LoopDetail";
import { LoopStartForm } from "./LoopStartForm";
import { RoutinesTab, openRoutineCreate, resetRoutineForm, routineFormOpen } from "./automation/RoutinesTab";
import { WatchesTab, openWatchCreate, resetWatchForm, watchFormOpen } from "./automation/WatchesTab";
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
import { closeRoutines, openRoutines, routinesState, routinesViewOpen } from "../state/routines";
import { focusSession, sessionList } from "../state/sessions";
import { closeWatches, openWatches, watchesState, watchesViewOpen } from "../state/watches";
import { isFailingRun } from "../lib/routines";
import type { LoopRunWire } from "../protocol/types";

/** Non-null while the start form shows; the objective it was opened with. */
const [startPrefill, setStartPrefill] = createSignal<string | null>(null);

export type AutomationTab = "runs" | "watches" | "routines";
const TABS: { id: AutomationTab; label: string }[] = [
  { id: "runs", label: "Loop runs" },
  { id: "watches", label: "Watches" },
  { id: "routines", label: "Routines" },
];

/** The tab showing, or null when the drawer is shut. One store's view is open at a time. */
export const automationTab = (): AutomationTab | null =>
  loopsViewOpen() ? "runs" : watchesViewOpen() ? "watches" : routinesViewOpen() ? "routines" : null;

/** Show `tab` (its list, or the item `id`), shutting the other tabs' views so only it polls fast. */
export function openAutomation(tab: AutomationTab, id?: string): void {
  if (tab !== "runs") closeLoops();
  if (tab !== "watches") closeWatches();
  if (tab !== "routines") closeRoutines();
  if (tab === "runs") {
    if (id) setStartPrefill(null);
    openLoops(id);
  } else if (tab === "watches") {
    resetWatchForm();
    openWatches(id);
  } else {
    resetRoutineForm();
    openRoutines(id);
  }
}

export function closeAutomation(): void {
  closeLoops();
  closeWatches();
  closeRoutines();
}

/** `/loops` and the status bar: the loop runs list. */
export function showLoops(): void {
  setStartPrefill(null);
  openAutomation("runs");
}

/** `/loop [objective…]`: the start form, optionally prefilled. */
export function openLoopStart(objective?: string): void {
  setStartPrefill(objective ?? "");
  openAutomation("runs");
}

/** A loop run's detail (from a watch, a routine run, or the inbox). */
export function openLoopRun(runId: string): void {
  openAutomation("runs", runId);
}

export function showWatches(watchId?: string): void {
  openAutomation("watches", watchId);
}

export function showRoutines(routineId?: string): void {
  openAutomation("routines", routineId);
}

const LoopsPanel: Component = () => {
  const s = loopsState;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !automationTab()) return;
      // A dialog or picker above the drawer takes its own Esc (it marks it
      // handled); only an Esc nothing else used shuts the drawer. Checked
      // after the event has reached every listener.
      setTimeout(() => {
        if (!e.defaultPrevented && automationTab()) closeAutomation();
      }, 0);
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

  const tab = () => automationTab() ?? "runs";
  const onList = () =>
    tab() === "runs"
      ? startPrefill() === null && !s().selectedId
      : tab() === "watches"
        ? !watchFormOpen() && !watchesState().selectedId
        : !routineFormOpen() && !routinesState().selectedId;
  const newLabel = () => (tab() === "runs" ? "New loop" : tab() === "watches" ? "New watch" : "New routine");
  const onNew = () => (tab() === "runs" ? openLoopStart() : tab() === "watches" ? openWatchCreate() : openRoutineCreate());
  const subtitle = () =>
    tab() === "runs"
      ? "done only when the daemon's checks pass"
      : tab() === "watches"
        ? "runs started from GitHub, on trusted code"
        : "agent tasks on a schedule or an API";
  const counts = createMemo<Record<AutomationTab, { n: number; alert: boolean }>>(() => ({
    runs: { n: s().runs.filter((r) => !isTerminalLoop(r.status)).length, alert: s().runs.some((r) => loopWaitKind(r) === "question") },
    watches: { n: watchesState().watches.length, alert: watchesState().watches.some((w) => !!w.lastError) },
    routines: {
      n: routinesState().routines.length,
      alert: routinesState().routines.some((r) => !!r.pausedReason || (!!r.lastRun && isFailingRun(r.lastRun.status))),
    },
  }));
  const tabId = (t: AutomationTab) => `automation-tab-${t}`;
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = TABS.length;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + n) % n]!;
    openAutomation(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };

  return (
    <Show when={automationTab()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-end bg-bg/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeAutomation();
        }}
      >
        <aside class="flex h-full w-full max-w-2xl flex-col border-l border-border bg-bg-elev shadow-2xl" aria-label="Automation">
          <header class="flex flex-col gap-2 border-b border-border px-4 pt-3">
            <div class="flex items-center gap-3">
              <h2 class="text-base font-semibold tracking-tight text-fg">Automation</h2>
              <span class="hidden truncate font-mono text-[11px] text-fg-faint sm:inline">{subtitle()}</span>
              <span class="ml-auto flex items-center gap-2">
                <Show when={onList()}>
                  <button
                    type="button"
                    onClick={onNew}
                    class="rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20"
                  >
                    {newLabel()}
                  </button>
                </Show>
                <button type="button" onClick={() => closeAutomation()} class="text-fg-faint hover:text-fg" title="Close (Esc)" aria-label="Close">
                  ✕
                </button>
              </span>
            </div>
            <div class="-mb-px flex gap-1" role="tablist" aria-label="Automation">
              <For each={TABS}>
                {(t, i) => (
                  <button
                    type="button"
                    role="tab"
                    id={tabId(t.id)}
                    aria-selected={tab() === t.id}
                    aria-controls="automation-panel"
                    tabindex={tab() === t.id ? 0 : -1}
                    onClick={() => openAutomation(t.id)}
                    onKeyDown={(e) => onTabKey(e, i())}
                    class={`flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[12px] transition ${
                      tab() === t.id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"
                    }`}
                  >
                    {t.label}
                    <Show when={counts()[t.id].n > 0}>
                      <span class={`font-mono text-[10px] ${counts()[t.id].alert ? "text-warn" : "text-fg-faint"}`}>{counts()[t.id].n}</span>
                    </Show>
                    <Show when={counts()[t.id].alert}>
                      <span class="h-1.5 w-1.5 rounded-full bg-warn" aria-label="needs a look" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </header>

          <div
            class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5"
            id="automation-panel"
            role="tabpanel"
            aria-labelledby={tabId(tab())}
          >
            <Show when={tab() === "watches"}>
              <WatchesTab onOpenLoopRun={openLoopRun} />
            </Show>
            <Show when={tab() === "routines"}>
              <RoutinesTab onOpenLoopRun={openLoopRun} onClose={closeAutomation} />
            </Show>
            <Show when={tab() === "runs"}>
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
                        closeAutomation();
                      }}
                      onToggleHistory={setLoopHistoryOpen}
                      onOpenRoutine={(routineId) => showRoutines(routineId)}
                    />
                  )}
                </Show>
              )}
            </Show>
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
