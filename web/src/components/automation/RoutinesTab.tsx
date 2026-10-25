/**
 * The Routines tab of the automation drawer (docs/routines.md): the list, one
 * routine's detail, and the create/edit form. Renders and dispatches only;
 * reads, controls and polling live in state/routines.ts. `RoutineList`,
 * `RoutineDetail` and `RoutineForm` are presentational and tested on their own.
 */

import { Component, For, Show, createMemo, createSignal } from "solid-js";

import { RoutineDetail, type RevealedToken } from "./RoutineDetail";
import { RoutineForm, type RoutineFormSubmit } from "./RoutineForm";
import { AutomationExplainer, ErrorBox, Pill, StatusBadge, When, primaryBtn } from "./common";
import { ROUTINE_RUN_STATUS, isFailingRun, routineLoopOf, routineState, scheduleWords } from "../../lib/routines";
import { nowTick } from "../../state/clock";
import { providerIds, providerLabel } from "../../state/providers";
import {
  cancelRoutineRun,
  createRoutine,
  deleteRoutine,
  previewSchedule,
  rotateRoutineToken,
  routinesState,
  runRoutineNow,
  selectRoutine,
  setRoutineEnabled,
  updateRoutine,
} from "../../state/routines";
import { focusSession, sessionList } from "../../state/sessions";
import type { RoutineWire } from "../../protocol/types";

/** An edit holds the routine as it was when the edit began: a background refresh must not reset what is being typed. */
type Mode = { kind: "create" } | { kind: "edit"; routine: RoutineWire } | null;

/** Non-null while a form shows. */
const [mode, setMode] = createSignal<Mode>(null);

/** The drawer's "New routine" button and `openRoutines({ create: true })`. */
export function openRoutineCreate(): void {
  setMode({ kind: "create" });
}

/** Leave any form (opening a routine from elsewhere). */
export function resetRoutineForm(): void {
  setMode(null);
}

export const routineFormOpen = () => mode() !== null;

export const RoutinesTab: Component<{ onOpenLoopRun: (runId: string) => void; onClose: () => void }> = (props) => {
  const s = routinesState;
  const [token, setToken] = createSignal<(RevealedToken & { routineId: string }) | null>(null);
  const recentWorkdirs = createMemo(() => [...new Set(sessionList().map((x) => x.workdir).filter(Boolean))].slice(0, 6));
  const sessionIds = createMemo(() => new Set(sessionList().map((x) => x.id)));
  const providers = () => providerIds().map((id) => ({ id, label: providerLabel(id) }));

  const reveal = (routine: RoutineWire, apiToken: string | undefined) => {
    if (apiToken) setToken({ routineId: routine.id, apiToken, endpointPath: `/routines/${routine.id}/fire` });
  };

  const submit = async (m: NonNullable<Mode>, body: RoutineFormSubmit) => {
    if (body.kind === "create") {
      const res = await createRoutine(body.spec);
      reveal(res.routine, res.apiToken);
    } else if (m.kind === "edit") {
      const res = await updateRoutine(m.routine.id, body.patch);
      reveal(res.routine, res.apiToken);
      selectRoutine(m.routine.id);
    }
    setMode(null);
  };

  return (
    <Show
      when={mode() === null}
      fallback={
        <Show when={mode()} keyed>
          {(m) => (
            <RoutineForm
              {...(m.kind === "edit" ? { routine: m.routine } : {})}
              recentWorkdirs={recentWorkdirs()}
              providers={providers()}
              now={nowTick()}
              preview={(schedule) => previewSchedule(schedule, 3)}
              onCancel={() => setMode(null)}
              onSubmit={(body) => submit(m, body)}
            />
          )}
        </Show>
      }
    >
      <Show
        when={s().selectedId}
        keyed
        fallback={
          <div class="flex flex-col gap-3">
            <ErrorBox error={s().error} />
            <RoutineList routines={s().routines} loaded={s().loaded} now={nowTick()} onSelect={selectRoutine} onNew={openRoutineCreate} />
          </div>
        }
      >
        {(id) => (
          <Show
            when={s().detail?.routine.id === id ? s().detail : null}
            fallback={
              <Show when={s().error} fallback={<p class="text-xs text-fg-faint">loading…</p>}>
                <div class="flex flex-col gap-2">
                  <button type="button" class="self-start text-[11px] text-fg-muted hover:text-fg" onClick={() => selectRoutine(null)}>
                    ← all routines
                  </button>
                  <ErrorBox error={s().error} />
                </div>
              </Show>
            }
          >
            {(d) => (
              <RoutineDetail
                routine={d().routine}
                runs={d().runs}
                busy={s().busy}
                error={s().error}
                now={nowTick()}
                sessionIds={sessionIds()}
                token={token()?.routineId === id ? token() : null}
                onBack={() => selectRoutine(null)}
                onEdit={() => setMode({ kind: "edit", routine: d().routine })}
                onSetEnabled={(enabled) => void setRoutineEnabled(id, enabled)}
                onRunNow={(payload) => runRoutineNow(id, payload).then((run) => !!run)}
                onCancelRun={(runId) => void cancelRoutineRun(id, runId)}
                onDelete={() => deleteRoutine(id)}
                onRotateToken={() => rotateRoutineToken(id).then((t) => void setToken({ routineId: id, ...t }))}
                onDismissToken={() => setToken(null)}
                onOpenSession={(sessionId) => {
                  focusSession(sessionId);
                  props.onClose();
                }}
                onOpenLoopRun={props.onOpenLoopRun}
              />
            )}
          </Show>
        )}
      </Show>
    </Show>
  );
};

// ── List ─────────────────────────────────────────────────────────────────────

export interface RoutineListProps {
  routines: RoutineWire[];
  loaded: boolean;
  now: number;
  onSelect: (routineId: string) => void;
  onNew: () => void;
}

export const RoutineList: Component<RoutineListProps> = (props) => (
  <Show
    when={props.routines.length > 0}
    fallback={
      <Show when={props.loaded} fallback={<p class="text-xs text-fg-faint">loading…</p>}>
        <div class="flex flex-col items-start gap-3 text-[12px] text-fg-muted" data-testid="routines-empty">
          <p>
            No routines yet. A routine is a saved agent task that runs on a schedule, when something calls its API, or when you ask:
            "every weekday at 9, triage new issues". Give it a check, and runs with nothing to do cost nothing.
          </p>
          <AutomationExplainer highlight="routines" />
          <button type="button" class={primaryBtn} onClick={() => props.onNew()}>
            Create a routine
          </button>
        </div>
      </Show>
    }
  >
    <ul class="flex flex-col divide-y divide-border/50 rounded border border-border" aria-label="Routines">
      <For each={props.routines}>
        {(r) => {
          const st = () => routineState(r);
          const last = () => r.lastRun;
          return (
            <li>
              <button
                type="button"
                class="flex w-full flex-col gap-1 px-3 py-2 text-left transition hover:bg-bg-hover focus-visible:bg-bg-hover"
                onClick={() => props.onSelect(r.id)}
                data-testid="routine-row"
              >
                <span class="flex w-full flex-wrap items-center gap-2">
                  <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{r.name}</span>
                  <Show when={!r.enabled}>
                    <Pill cls={st().cls} title={st().title}>
                      {st().label}
                    </Pill>
                  </Show>
                  <Show when={r.spec.check}>
                    <Pill cls="border-border bg-bg/40 text-fg-faint" title="Gated by a check: runs with nothing to do cost nothing">
                      gated
                    </Pill>
                  </Show>
                  <Show when={routineLoopOf(r)}>
                    <Pill cls="border-accent/50 bg-accent/10 text-accent" title="Each run starts a verified loop run">loop</Pill>
                  </Show>
                  <Show when={last()} fallback={<span class="text-[10px] text-fg-faint">never run</span>}>
                    {(run) => (
                      <StatusBadge
                        style={ROUTINE_RUN_STATUS[run().status]}
                        class={isFailingRun(run().status) ? "font-semibold" : ""}
                        testid="routine-last-run"
                      />
                    )}
                  </Show>
                </span>
                <span class="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
                  <span>{scheduleWords(r.spec.schedule)}</span>
                  <Show when={r.enabled && r.upcoming[0]}>
                    <span>
                      next <When at={r.upcoming[0]} now={props.now} class="font-mono" />
                    </span>
                  </Show>
                  <Show when={last()}>
                    {(run) => (
                      <span class="text-fg-faint">
                        last <When at={run().startedAt ?? run().createdAt} now={props.now} class="font-mono" />
                      </span>
                    )}
                  </Show>
                </span>
              </button>
            </li>
          );
        }}
      </For>
    </ul>
  </Show>
);

export default RoutinesTab;
