/**
 * The Watches tab of the automation drawer (docs/loops.md "Watches"): the
 * list, one watch's detail, and the create form. Renders and dispatches only;
 * reads, controls and polling live in state/watches.ts. The runs a watch
 * started come from the loop runs list (state/loops.ts), which the inbox keeps
 * fresh.
 */

import { Component, For, Show, createMemo, createSignal, untrack } from "solid-js";

import { WatchDetail } from "./WatchDetail";
import { WatchForm } from "./WatchForm";
import { AutomationExplainer, ErrorBox, Pill, When, primaryBtn } from "./common";
import { runsStartedBy, watchHealth, watchTargetText } from "../../lib/watches";
import { nowTick } from "../../state/clock";
import { loopsState } from "../../state/loops";
import { providerIds, providerLabel } from "../../state/providers";
import { sessionList } from "../../state/sessions";
import {
  createWatch,
  deleteWatch,
  pollWatch,
  selectWatch,
  setWatchEnabled,
  updateWatch,
  watchesState,
} from "../../state/watches";
import type { LoopRunWire, LoopWatchWire } from "../../protocol/types";

const [creating, setCreating] = createSignal(false);
/** A branch watch just made: its detail offers the pinned vouch dialog (create itself never vouches). */
const [justCreated, setJustCreated] = createSignal<string | null>(null);

/** Whether `watchId` was just made, asked once: the offer shows when its detail first opens, not on every visit. */
function takeJustCreated(watchId: string): boolean {
  const yes = untrack(justCreated) === watchId;
  if (yes) setJustCreated(null);
  return yes;
}

export function openWatchCreate(): void {
  setCreating(true);
}

export function resetWatchForm(): void {
  setCreating(false);
}

export const watchFormOpen = creating;

export const WatchesTab: Component<{ onOpenLoopRun: (runId: string) => void }> = (props) => {
  const s = watchesState;
  const recentWorkdirs = createMemo(() => [...new Set(sessionList().map((x) => x.workdir).filter(Boolean))].slice(0, 6));
  const providers = () => providerIds().map((id) => ({ id, label: providerLabel(id) }));

  return (
    <Show
      when={!creating()}
      fallback={
        <WatchForm
          recentWorkdirs={recentWorkdirs()}
          providers={providers()}
          onCancel={() => setCreating(false)}
          onSubmit={(body) =>
            createWatch(body).then((w) => {
              setJustCreated(w.myPrs ? null : w.id);
              setCreating(false);
            })
          }
        />
      }
    >
      <Show
        when={s().selectedId}
        keyed
        fallback={
          <div class="flex flex-col gap-3">
            <ErrorBox error={s().error} />
            <WatchList watches={s().watches} loaded={s().loaded} runs={loopsState().runs} now={nowTick()} onSelect={selectWatch} onNew={openWatchCreate} />
          </div>
        }
      >
        {(id) => (
          <Show
            when={s().detail?.watch.id === id ? s().detail : null}
            fallback={
              <Show when={s().error} fallback={<p class="text-xs text-fg-faint">loading…</p>}>
                <div class="flex flex-col gap-2">
                  <button type="button" class="self-start text-[11px] text-fg-muted hover:text-fg" onClick={() => selectWatch(null)}>
                    ← all watches
                  </button>
                  <ErrorBox error={s().error} />
                </div>
              </Show>
            }
          >
            {(d) => (
              <WatchDetail
                watch={d().watch}
                triggers={d().triggers}
                lastPoll={s().lastPoll?.watchId === id ? s().lastPoll : null}
                runs={runsStartedBy(id, loopsState().runs)}
                busy={s().busy}
                error={s().error}
                now={nowTick()}
                onBack={() => selectWatch(null)}
                onSetEnabled={(enabled) => void setWatchEnabled(id, enabled)}
                onPoll={() => void pollWatch(id)}
                onDelete={() => deleteWatch(id)}
                onSaveTrust={(trust) => updateWatch(id, { spec: { trust } }).then(() => undefined)}
                onVouch={(trustHead) => updateWatch(id, { trustHead }).then(() => undefined)}
                onOpenLoopRun={props.onOpenLoopRun}
                justCreated={takeJustCreated(id)}
              />
            )}
          </Show>
        )}
      </Show>
    </Show>
  );
};

// ── List ─────────────────────────────────────────────────────────────────────

export interface WatchListProps {
  watches: LoopWatchWire[];
  loaded: boolean;
  /** Loop runs this client has listed, to count what each watch started. */
  runs: readonly LoopRunWire[];
  now: number;
  onSelect: (watchId: string) => void;
  onNew: () => void;
}

export const WatchList: Component<WatchListProps> = (props) => (
  <Show
    when={props.watches.length > 0}
    fallback={
      <Show when={props.loaded} fallback={<p class="text-xs text-fg-faint">loading…</p>}>
        <div class="flex flex-col items-start gap-3 text-[12px] text-fg-muted" data-testid="watches-empty">
          <p>
            No watches yet. A watch turns a red CI check on a branch you watch, or an @codeoid comment on your pull request, into a repair run, without
            you starting it. It only ever runs code from heads you, or people you trust, pushed or merged.
          </p>
          <AutomationExplainer highlight="watches" />
          <button type="button" class={primaryBtn} onClick={() => props.onNew()}>
            Create a watch
          </button>
        </div>
      </Show>
    }
  >
    <ul class="flex flex-col divide-y divide-border/50 rounded border border-border" aria-label="Watches">
      <For each={props.watches}>
        {(w) => {
          const health = () => watchHealth(w);
          const started = () => runsStartedBy(w.id, props.runs).length;
          return (
            <li>
              <button
                type="button"
                class="flex w-full flex-col gap-1 px-3 py-2 text-left transition hover:bg-bg-hover focus-visible:bg-bg-hover"
                onClick={() => props.onSelect(w.id)}
                data-testid="watch-row"
              >
                <span class="flex w-full flex-wrap items-center gap-2">
                  <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{w.repo}</span>
                  <Pill cls={health().cls} title={health().meaning} testid="watch-row-health">
                    {health().label}
                  </Pill>
                  <span class="shrink-0 font-mono text-[11px] text-fg-muted" title="Loop runs it started, among your recent runs">
                    {started()} run{started() === 1 ? "" : "s"}
                  </span>
                </span>
                <span class="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
                  <span class={w.myPrs ? "" : "font-mono"}>{watchTargetText(w)}</span>
                  <span>{w.ci.length} CI mapping{w.ci.length === 1 ? "" : "s"}{w.review.enabled ? " · review" : ""}</span>
                  <span class="text-fg-faint">
                    polled <When at={w.lastPolledAt} now={props.now} class="font-mono" />
                  </span>
                </span>
                <Show when={w.lastError}>
                  <span class={`block w-full truncate text-[11px] ${health().kind === "backoff" ? "text-warn" : "text-danger"}`} title={w.lastError!}>
                    {w.lastError}
                  </span>
                </Show>
              </button>
            </li>
          );
        }}
      </For>
    </ul>
  </Show>
);

export default WatchesTab;
