/**
 * One loop watch (docs/loops.md "Watches"): what it watches and how, who it
 * trusts, how its last poll went, the events it acted on (and why it ignored
 * the ones it did), the runs it started, and the controls.
 *
 * Presentational: the round-trips live in state/watches.ts and WatchesTab
 * wires them in.
 */

import { Component, For, Show, createMemo, createSignal } from "solid-js";

import { TrustEditor } from "./TrustEditor";
import { VouchDialog } from "./VouchDialog";
import { formatCostUsd } from "../../lib/format";
import { LOOP_STATUS, objectiveTitle } from "../../lib/loops";
import {
  TRIGGER_KIND,
  TRIGGER_OUTCOME,
  ciMappingText,
  knownHeads,
  watchHealth,
  watchTargetText,
} from "../../lib/watches";
import type { LoopRunWire, LoopWatchTriggerWire, LoopWatchTrustHead, LoopWatchWire } from "../../protocol/types";
import {
  BackLink,
  ConfirmDialog,
  ErrorBox,
  Pill,
  StatusBadge,
  When,
  btn,
  labelClass,
  linkBtn,
  primaryBtn,
  quietBtn,
} from "./common";

export interface WatchDetailProps {
  watch: LoopWatchWire;
  triggers: LoopWatchTriggerWire[];
  /** The last "Poll now" result for this watch. */
  lastPoll: { started: string[]; skipped: string[] } | null;
  /** Loop runs (among this client's listed ones) the watch started. */
  runs: LoopRunWire[];
  busy?: boolean;
  error?: string | null;
  now: number;
  onBack: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onPoll: () => void;
  /** Resolves true when deleted. */
  onDelete: () => Promise<boolean>;
  /** Reject with the daemon's words. */
  onSaveTrust: (trust: string[]) => Promise<void>;
  onVouch: (trustHead: LoopWatchTrustHead) => Promise<void>;
  onOpenLoopRun: (runId: string) => void;
}

function repoUrl(repo: string): string | null {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? `https://github.com/${repo}` : null;
}

export const WatchDetail: Component<WatchDetailProps> = (props) => {
  const w = () => props.watch;
  const health = () => watchHealth(w());
  const known = createMemo(() => knownHeads(props.triggers, w().repo));
  const [editTrust, setEditTrust] = createSignal(false);
  const [vouchOpen, setVouchOpen] = createSignal(false);
  /** A narrowing just forgot every vouched head: offer the (pinned) vouch dialog. */
  const [offerVouch, setOfferVouch] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  const doDelete = async () => {
    setDeleting(true);
    const ok = await props.onDelete();
    setDeleting(false);
    if (ok) setConfirmDelete(false);
  };
  const saveTrust = async (trust: string[], narrowed: boolean) => {
    await props.onSaveTrust(trust);
    setEditTrust(false);
    setOfferVouch(narrowed && !w().myPrs);
  };

  return (
    <div class="flex flex-col gap-4" data-testid="watch-detail">
      <div class="flex items-center gap-2">
        <BackLink label="all watches" onClick={props.onBack} />
        <span class="ml-auto font-mono text-[10px] text-fg-faint">{w().id}</span>
      </div>

      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <Show when={repoUrl(w().repo)} fallback={<h3 class="font-mono text-[14px] font-semibold text-fg">{w().repo}</h3>}>
            {(url) => (
              <a class="font-mono text-[14px] font-semibold text-fg underline-offset-2 hover:underline" href={url()} target="_blank" rel="noopener noreferrer">
                {w().repo}
              </a>
            )}
          </Show>
          <Pill cls={health().cls} title={health().meaning} testid="watch-health">
            {health().label}
          </Pill>
        </div>
        <p class="text-[12px] text-fg-muted">
          Watches <span class={w().myPrs ? "" : "font-mono"}>{watchTargetText(w())}</span>
          {" · "}polled <When at={w().lastPolledAt} now={props.now} />
        </p>
      </div>

      {/* Why the last poll couldn't finish, or what it skipped. */}
      <Show when={w().lastError}>
        <div
          class={`rounded border px-3 py-2 text-[12px] ${health().kind === "backoff" ? "border-warn/50 bg-warn/10" : "border-danger/40 bg-danger/10"}`}
          data-testid="watch-last-error"
        >
          <div class={`${labelClass} ${health().kind === "backoff" ? "text-warn" : "text-danger"}`}>
            {health().kind === "self_paused" ? "Paused itself" : health().kind === "backoff" ? "Rate-limited: backing off" : "Last poll"}
          </div>
          <p class="mt-1 whitespace-pre-wrap break-words text-fg">{w().lastError}</p>
          <Show when={health().kind === "backoff"}>
            <p class="mt-1 text-fg-muted">{health().meaning}</p>
          </Show>
        </div>
      </Show>

      <Show when={props.lastPoll}>
        {(p) => (
          <div class="rounded border border-border bg-bg/30 px-3 py-2 text-[12px]" data-testid="watch-poll-result" aria-live="polite">
            <div class={labelClass}>Poll now</div>
            <p class="mt-1 text-fg-muted">
              {p().started.length === 0 ? "Started no run." : `Started ${p().started.length} run${p().started.length === 1 ? "" : "s"}.`}
            </p>
            <Show when={p().started.length > 0}>
              <ul class="mt-0.5 flex flex-wrap gap-2">
                <For each={p().started}>
                  {(id) => (
                    <li>
                      <button type="button" class={linkBtn} onClick={() => props.onOpenLoopRun(id)}>
                        {id}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={p().skipped.length > 0}>
              <ul class="mt-1 flex flex-col gap-0.5 text-[11px] text-fg-muted">
                <For each={p().skipped}>{(s) => <li>– {s}</li>}</For>
              </ul>
            </Show>
          </div>
        )}
      </Show>

      <ErrorBox error={props.error} />

      {/* Controls. */}
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class={primaryBtn}
          disabled={props.busy || !w().enabled}
          title={w().enabled ? "Poll GitHub now instead of at the next tick" : "Resume it first"}
          onClick={() => props.onPoll()}
        >
          {props.busy ? "Working…" : "Poll now"}
        </button>
        <Show
          when={w().enabled}
          fallback={
            <button type="button" class={primaryBtn} disabled={props.busy} onClick={() => props.onSetEnabled(true)}>
              Resume
            </button>
          }
        >
          <button type="button" class={quietBtn} disabled={props.busy} onClick={() => props.onSetEnabled(false)} title="Stop polling. Runs it started carry on.">
            Pause
          </button>
        </Show>
        <Show when={!w().myPrs}>
          <button type="button" class={quietBtn} disabled={props.busy} onClick={() => setVouchOpen(true)}>
            Vouch for current head…
          </button>
        </Show>
        <button
          type="button"
          class={`${btn} ml-auto border-border text-fg-muted hover:border-danger/40 hover:text-danger`}
          disabled={props.busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </div>
      <p class="text-[10px] text-fg-faint">
        A delegated token can pause or delete this watch, but not create, change, resume, poll or vouch: those need your own credential with
        session:approve.
      </p>

      {/* Definition. */}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        <dt class={labelClass}>Repo</dt>
        <dd class="truncate font-mono text-fg-muted" title={w().workdir}>
          {w().workdir}
        </dd>
        <dt class={labelClass}>CI</dt>
        <dd>
          <ul class="flex flex-col gap-0.5" data-testid="watch-ci">
            <For each={w().ci}>
              {(c) => {
                const t = ciMappingText(c);
                return (
                  <li class="font-mono text-[11px] text-fg-muted">
                    <span class="text-fg">{t.check}</span> → {t.command}
                    <span class="text-fg-faint">
                      {" "}
                      · {c.timeoutSec}s{c.expectTests ? " · test run" : ""}
                    </span>
                  </li>
                );
              }}
            </For>
          </ul>
        </dd>
        <dt class={labelClass}>Review</dt>
        <dd class="text-fg-muted" data-testid="watch-review">
          <Show when={w().review.enabled} fallback="off">
            comments containing <span class="font-mono">{w().review.mention}</span> by{" "}
            {w().review.allow.length > 0 ? <span class="font-mono">{w().review.allow.join(", ")}</span> : `you${w().ghLogin ? ` (@${w().ghLogin})` : ""}`}
          </Show>
        </dd>
        <dt class={labelClass}>Trust</dt>
        <dd class="flex flex-col gap-1 text-fg-muted" data-testid="watch-trust">
          <span>
            you{w().ghLogin ? <span class="font-mono"> (@{w().ghLogin})</span> : ""}
            <Show when={w().trust.length > 0}>
              , <span class="font-mono">{w().trust.join(", ")}</span>
            </Show>
            <Show when={!editTrust()}>
              {" "}
              <button type="button" class={linkBtn} disabled={props.busy} onClick={() => setEditTrust(true)}>
                edit
              </button>
            </Show>
          </span>
          <span class="text-[11px] text-fg-faint">
            It runs a head's code only when a trusted login pushed it, or merged it with every change since a trusted head also a trusted merge, or
            every commit is signed by one of you; or you vouched for it.
          </span>
        </dd>
        <dt class={labelClass}>Bounds</dt>
        <dd class="text-fg-muted">
          at most {w().maxRunsPerHour} runs an hour
          {w().limits?.attempts ? ` · ${w().limits!.attempts} attempts per run` : ""}
          {w().toolBudget ? ` · ${w().toolBudget} tool calls per attempt` : ""}
        </dd>
        <Show when={w().provider || w().model}>
          <dt class={labelClass}>Worker</dt>
          <dd class="font-mono text-fg-muted">{[w().provider, w().model].filter(Boolean).join(" · ")}</dd>
        </Show>
      </dl>

      <Show when={editTrust()}>
        <TrustEditor
          trust={w().trust}
          ghLogin={w().ghLogin}
          canVouch={!w().myPrs}
          onCancel={() => setEditTrust(false)}
          onSave={saveTrust}
        />
      </Show>

      <Show when={offerVouch()}>
        <div class="flex flex-wrap items-center gap-2 rounded border border-warn/50 bg-warn/10 px-3 py-2 text-[12px]" data-testid="watch-offer-vouch">
          <span class="min-w-0 flex-1 text-fg">
            The narrower list forgot every head you vouched for. A branch whose history the dropped logins touched starts no runs until a trusted
            login pushes or you vouch for its head again.
          </span>
          <button
            type="button"
            class={quietBtn}
            disabled={props.busy}
            onClick={() => {
              setOfferVouch(false);
              setVouchOpen(true);
            }}
          >
            Vouch for current heads…
          </button>
          <button type="button" class={linkBtn} onClick={() => setOfferVouch(false)}>
            not now
          </button>
        </div>
      </Show>

      {/* Runs it started. */}
      <Show when={props.runs.length > 0}>
        <div>
          <div class={labelClass}>Runs it started</div>
          <ul class="mt-1 flex flex-col divide-y divide-border/50 rounded border border-border" data-testid="watch-runs">
            <For each={props.runs}>
              {(run) => (
                <li>
                  <button type="button" class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-hover" onClick={() => props.onOpenLoopRun(run.id)}>
                    <StatusBadge style={LOOP_STATUS[run.status]} />
                    <span class="min-w-0 flex-1 truncate text-[12px] text-fg">{objectiveTitle(run.objective, 60)}</span>
                    <span class="shrink-0 font-mono text-[11px] text-fg-muted">{formatCostUsd(run.costUsd)}</span>
                    <When at={run.createdAt} now={props.now} class="shrink-0 font-mono text-[10px] text-fg-faint" />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      {/* History. */}
      <div>
        <div class={labelClass}>What it acted on</div>
        <Show
          when={props.triggers.length > 0}
          fallback={<p class="mt-1 text-[12px] text-fg-faint">Nothing yet. A failing mapped check, an @-mention review comment, or a head it refused shows up here.</p>}
        >
          <ol class="mt-1 flex flex-col gap-1.5" data-testid="watch-history">
            <For each={props.triggers}>{(t) => <TriggerRow trigger={t} now={props.now} onOpenLoopRun={props.onOpenLoopRun} />}</For>
          </ol>
        </Show>
      </div>

      <VouchDialog
        open={vouchOpen()}
        watch={w()}
        known={known()}
        now={props.now}
        onVouch={props.onVouch}
        onClose={() => setVouchOpen(false)}
      />

      <ConfirmDialog
        open={confirmDelete()}
        title="Delete this watch?"
        confirmLabel="Delete watch"
        danger
        busy={deleting()}
        error={confirmDelete() ? props.error : null}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void doDelete()}
      >
        <p>
          It stops polling <span class="font-mono text-fg">{w().repo}</span>. Runs it already started carry on, and the events it acted on stay
          recorded, so a new watch won't start a second run for them.
        </p>
        <p class="text-[12px] text-fg-faint">To stop it for now and keep its settings and trusted heads, pause it instead.</p>
      </ConfirmDialog>
    </div>
  );
};

const TriggerRow: Component<{ trigger: LoopWatchTriggerWire; now: number; onOpenLoopRun: (id: string) => void }> = (props) => {
  const t = () => props.trigger;
  const outcome = () => TRIGGER_OUTCOME[t().outcome];
  const kind = () => TRIGGER_KIND[t().kind];
  const refused = () => t().outcome === "ignored" || t().kind === "head";
  return (
    <li class="rounded border border-border bg-bg/30 px-3 py-1.5 text-[12px]" data-testid="watch-trigger">
      <div class="flex flex-wrap items-center gap-2">
        <Pill cls={outcome().cls} title={outcome().meaning}>
          {outcome().label}
        </Pill>
        <span class="text-fg" title={kind().meaning}>
          {kind().label}
        </span>
        <span class="font-mono text-[11px] text-fg-muted">{t().branch}</span>
        <When at={t().createdAt} now={props.now} class="font-mono text-[10px] text-fg-faint" />
        <Show when={t().runId}>
          {(id) => (
            <button type="button" class={`${linkBtn} ml-auto`} onClick={() => props.onOpenLoopRun(id())}>
              open run
            </button>
          )}
        </Show>
      </div>
      <Show when={t().note}>
        <p class={`mt-1 whitespace-pre-wrap break-words ${refused() ? "text-fg" : "text-fg-muted"}`} data-testid="watch-trigger-note">
          <Show when={refused()}>
            <span class="text-fg-faint">why: </span>
          </Show>
          {t().note}
        </p>
      </Show>
    </li>
  );
};

export default WatchDetail;
