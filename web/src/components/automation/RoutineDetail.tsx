/**
 * One routine (docs/routines.md): where it stands, when it fires next, its
 * whole definition, its recent runs with their outcomes, and the controls.
 *
 * Presentational: the round-trips live in state/routines.ts and RoutinesTab
 * wires them in, so the render and the per-state controls are tested directly.
 */

import { Component, For, Show, createSignal } from "solid-js";

import { formatDuration, formatSessionCost, formatTokens } from "../../lib/format";
import {
  RUN_TRIGGER,
  isCancellableRun,
  routineBudgetText,
  routineLoopOf,
  routineRunLoop,
  routineRunStatusStyle,
  routineState,
  scheduleWords,
} from "../../lib/routines";
import { LOOP_STATUS } from "../../lib/loops";
import type { RoutineRunWire, RoutineWire } from "../../protocol/types";
import {
  BackLink,
  ConfirmDialog,
  ErrorBox,
  Pill,
  StatusBadge,
  When,
  btn,
  dangerBtn,
  inputClass,
  labelClass,
  linkBtn,
  primaryBtn,
  quietBtn,
} from "./common";

export interface RevealedToken {
  apiToken: string;
  endpointPath: string;
}

export interface RoutineDetailProps {
  routine: RoutineWire;
  runs: RoutineRunWire[];
  busy?: boolean;
  error?: string | null;
  now: number;
  /** Sessions this client can open (a run's session may be cleaned up or not visible). */
  sessionIds: ReadonlySet<string>;
  /** An API token the daemon just handed over: shown once. */
  token?: RevealedToken | null;
  onBack: () => void;
  onEdit: () => void;
  onSetEnabled: (enabled: boolean) => void;
  /** Resolves true when a run was queued. */
  onRunNow: (payload?: string) => Promise<boolean>;
  onCancelRun: (runId: string) => void;
  /** Resolves true when deleted. */
  onDelete: () => Promise<boolean>;
  /** Rejects with the daemon's words. */
  onRotateToken: () => Promise<void>;
  onDismissToken: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenLoopRun: (runId: string) => void;
}

export const RoutineDetail: Component<RoutineDetailProps> = (props) => {
  const r = () => props.routine;
  const s = () => r().spec;
  const st = () => routineState(r());
  const loop = () => routineLoopOf(r());
  const [payloadOpen, setPayloadOpen] = createSignal(false);
  const [payload, setPayload] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [confirmRotate, setConfirmRotate] = createSignal(false);
  const [rotating, setRotating] = createSignal(false);
  const [rotateError, setRotateError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  const runNow = async () => {
    const text = payload().trim();
    if (await props.onRunNow(text || undefined)) {
      setPayload("");
      setPayloadOpen(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    const ok = await props.onDelete();
    setDeleting(false);
    if (ok) setConfirmDelete(false);
  };

  const doRotate = async () => {
    setRotating(true);
    setRotateError(null);
    try {
      await props.onRotateToken();
      setConfirmRotate(false);
    } catch (e) {
      setRotateError(e instanceof Error ? e.message : String(e));
    } finally {
      setRotating(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div class="flex flex-col gap-4" data-testid="routine-detail">
      <div class="flex items-center gap-2">
        <BackLink label="all routines" onClick={props.onBack} />
        <span class="ml-auto font-mono text-[10px] text-fg-faint">{r().id}</span>
      </div>

      {/* Name, state, schedule. */}
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-mono text-[14px] font-semibold text-fg">{r().name}</h3>
          <Pill cls={st().cls} title={st().title} testid="routine-state">
            {st().label}
          </Pill>
          <Show when={s().check}>
            <Pill cls="border-border bg-bg/40 text-fg-muted" title="A shell check runs first; empty output means no agent and no cost">
              gated
            </Pill>
          </Show>
          <Show when={loop()}>
            <Pill cls="border-accent/50 bg-accent/10 text-accent" title="Each run starts a verified loop run instead of a session">
              starts a loop
            </Pill>
          </Show>
        </div>
        <p class="text-[12px] text-fg-muted" data-testid="routine-schedule">
          {scheduleWords(s().schedule)}
          <Show when={s().api}> · also fires by its API</Show>
        </p>
        {/* How it last went: its last outcome, which fires skipped behind a loop (or cancelled) don't hide. */}
        <Show when={r().lastOutcome}>
          {(o) => (
            <p class="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted" data-testid="routine-last-outcome">
              <span>Last outcome</span>
              <StatusBadge style={routineRunStatusStyle(o())} />
              <When at={o().endedAt ?? o().createdAt} now={props.now} class="font-mono text-[11px]" />
              <Show when={o().reason}>
                <span class="min-w-0 truncate" title={o().reason}>
                  · {o().reason}
                </span>
              </Show>
            </p>
          )}
        </Show>
      </div>

      <Show when={!r().enabled && r().pausedReason}>
        <div class="rounded border border-danger/50 bg-danger/10 px-3 py-2 text-[12px] text-danger" data-testid="routine-paused-reason">
          <div class={`${labelClass} text-danger`}>Paused itself</div>
          <p class="mt-1 text-fg">{r().pausedReason}</p>
          <p class="mt-1 text-fg-muted">Resume clears the failure streak.</p>
        </div>
      </Show>

      {/* Next fires. */}
      <Show when={s().schedule}>
        <div>
          <div class={labelClass}>Next fires</div>
          <Show
            when={r().upcoming.length > 0}
            fallback={<p class="mt-1 text-[12px] text-fg-faint">{r().enabled ? "None: it won't fire again on its own." : "None while paused."}</p>}
          >
            <ol class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[12px] text-fg-muted" data-testid="routine-upcoming">
              <For each={r().upcoming}>
                {(at) => (
                  <li>
                    <When at={at} now={props.now} />
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </div>
      </Show>

      <ErrorBox error={props.error} />

      {/* Controls. */}
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class={primaryBtn}
          disabled={props.busy}
          title={r().enabled ? "Fire it now, outside its schedule" : "Fire it once now: it stays paused, and its schedule and API stay off"}
          onClick={() => (payloadOpen() ? void runNow() : void props.onRunNow())}
        >
          {payloadOpen() ? "Run with payload" : "Run now"}
        </button>
        <Show when={!payloadOpen()}>
          <button type="button" class={linkBtn} disabled={props.busy} onClick={() => setPayloadOpen(true)}>
            with a payload…
          </button>
        </Show>
        <Show
          when={r().enabled}
          fallback={
            <button type="button" class={primaryBtn} disabled={props.busy} onClick={() => props.onSetEnabled(true)}>
              Resume
            </button>
          }
        >
          <button type="button" class={quietBtn} disabled={props.busy} onClick={() => props.onSetEnabled(false)} title="Stop firing. A run already going carries on.">
            Pause
          </button>
        </Show>
        <button type="button" class={quietBtn} disabled={props.busy} onClick={() => props.onEdit()}>
          Edit
        </button>
        <button
          type="button"
          class={`${btn} ml-auto border-border text-fg-muted hover:border-danger/40 hover:text-danger`}
          disabled={props.busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </div>

      <Show when={payloadOpen()}>
        <label class="flex flex-col gap-1">
          <span class={labelClass}>{loop() ? "Payload (reaches the loop's worker as data)" : <>Payload ({"{{payload}}"} in the prompt)</>}</span>
          <textarea
            rows={2}
            value={payload()}
            maxLength={16_000}
            onInput={(e) => setPayload(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void runNow();
              }
            }}
            class={`${inputClass} resize-y font-sans`}
            aria-label="Payload"
            placeholder={loop() ? "Text the loop's worker gets as data, e.g. the alert that fired" : "Text the agent gets as data, e.g. the alert that fired"}
            disabled={props.busy}
          />
          <div class="flex justify-end">
            <button type="button" class={linkBtn} onClick={() => setPayloadOpen(false)}>
              no payload
            </button>
          </div>
        </label>
      </Show>

      {/* A token the daemon just handed over. */}
      <Show when={props.token}>
        {(t) => (
          <div class="rounded border border-warn/50 bg-warn/10 px-3 py-2 text-[12px]" data-testid="routine-token">
            <div class={`${labelClass} text-warn`}>API token: shown once</div>
            <p class="mt-1 text-fg-muted">Copy it now; it is never shown again. POST to the endpoint with it as a bearer token.</p>
            <div class="mt-1.5 flex items-center gap-2">
              <code class="min-w-0 flex-1 truncate rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg">{t().apiToken}</code>
              <button type="button" class={quietBtn} onClick={() => copy(t().apiToken)} aria-label="Copy API token">
                {copied() ? "copied" : "copy"}
              </button>
            </div>
            <pre class="mt-1.5 overflow-x-auto whitespace-pre rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] text-fg-muted">
              {`curl -X POST <daemon>${t().endpointPath} \\\n  -H "Authorization: Bearer ${t().apiToken.slice(0, 6)}…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text": "…"}'`}
            </pre>
            <div class="mt-1 flex justify-end">
              <button type="button" class={linkBtn} onClick={() => props.onDismissToken()}>
                I've copied it
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Definition. */}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        <dt class={labelClass}>Workdir</dt>
        <dd class="truncate font-mono text-fg-muted" title={s().workdir}>
          {s().workdir}
          <Show when={s().worktree}>
            <span class="text-fg-faint"> · own worktree per run</span>
          </Show>
        </dd>
        <dt class={labelClass}>{loop() ? "Gate" : "Check"}</dt>
        <dd class="min-w-0 text-fg-muted" data-testid="routine-check">
          <Show when={s().check} fallback={<span>none: every fire starts {loop() ? "a loop run" : "the agent"}</span>}>
            {(c) => (
              <>
                <code class="block whitespace-pre-wrap break-all font-mono text-[11px] text-fg">{c().command}</code>
                <span class="text-[11px] text-fg-faint">
                  {c().timeoutSeconds ?? 60}s timeout · no output = silent run, no {loop() ? "loop" : "agent"} · non-zero exit = failed run
                </span>
              </>
            )}
          </Show>
        </dd>
        <dt class={labelClass}>Limits</dt>
        <dd class="text-fg-muted" data-testid="routine-budget">
          {routineBudgetText(s())}
        </dd>
        <dt class={labelClass}>Runs</dt>
        <dd class="text-fg-muted">
          {loop()
            ? "a loop run each, one at a time: a fire while the last is still going is skipped"
            : `${s().session === "persistent" ? "one persistent session" : "a fresh session each"} · overlap ${s().overlap}`}
          {s().catchUp ? " · catches up after downtime" : ""}
          {s().jitterSeconds > 0 ? ` · up to ${s().jitterSeconds}s jitter` : ""}
          {loop() ? "" : ` · keeps ${s().keepSessions} sessions`}
        </dd>
        <dt class={labelClass}>Notify</dt>
        <dd class="text-fg-muted">
          {s().notify === "on_change" ? "on any outcome but silent, skipped or cancelled" : s().notify}
          {" · "}
          {s().failurePauseAfter > 0 ? `pauses after ${s().failurePauseAfter} failures in a row` : "never pauses itself"}
          <Show when={r().consecutiveFailures > 0}>
            <span class="text-danger"> ({r().consecutiveFailures} so far)</span>
          </Show>
        </dd>
        <Show when={s().provider || s().model}>
          <dt class={labelClass}>Backend</dt>
          <dd class="font-mono text-fg-muted">{[s().provider, s().model].filter(Boolean).join(" · ")}</dd>
        </Show>
        <dt class={labelClass}>API</dt>
        <dd class="flex flex-wrap items-center gap-2 text-fg-muted">
          <Show when={s().api} fallback={<span>off</span>}>
            <span>
              on · <span class="font-mono">/routines/{r().id}/fire</span>
              {r().apiTokenSet ? "" : " · no token yet"}
            </span>
            <button type="button" class={linkBtn} disabled={props.busy} onClick={() => setConfirmRotate(true)}>
              new token…
            </button>
          </Show>
        </dd>
        <dt class={labelClass}>{loop() ? "Objective" : "Prompt"}</dt>
        <dd>
          <p class="whitespace-pre-wrap rounded border border-border bg-bg/30 px-2.5 py-1.5 text-[12px] text-fg">{s().prompt}</p>
        </dd>
      </dl>

      {/* A loop routine's acceptance checks: what "done" means for each run's loop. */}
      <Show when={loop()}>
        {(l) => (
          <div class="rounded border border-accent/40 bg-accent/5 px-3 py-2 text-[12px]" data-testid="routine-loop">
            <div class={labelClass}>Starts a loop, done only when these pass</div>
            <ul class="mt-1 flex flex-col gap-0.5">
              <For each={l().checks}>
                {(c) => (
                  <li class="font-mono text-[11px] text-fg-muted">
                    <span class="text-fg">{c.id}</span>: {c.command}
                    <span class="text-fg-faint">
                      {" "}
                      · {c.timeoutSec}s{c.expectTests ? " · test run" : ""}
                    </span>
                  </li>
                )}
              </For>
            </ul>
            <p class="mt-1 text-[11px] text-fg-faint">
              The gate above decides whether there is work; these decide whether the work is done. Its loop runs show in Loop runs, started by
              this routine.
            </p>
          </div>
        )}
      </Show>

      {/* Runs. */}
      <div>
        <div class={labelClass}>Recent runs</div>
        <Show when={props.runs.length > 0} fallback={<p class="mt-1 text-[12px] text-fg-faint">No run yet.</p>}>
          <ol class="mt-1 flex flex-col gap-2" data-testid="routine-runs">
            <For each={props.runs}>
              {(run) => (
                <RunRow
                  run={run}
                  now={props.now}
                  busy={props.busy}
                  sessionOpenable={!!run.sessionId && props.sessionIds.has(run.sessionId)}
                  onCancel={() => props.onCancelRun(run.id)}
                  onOpenSession={() => run.sessionId && props.onOpenSession(run.sessionId)}
                  onOpenLoopRun={props.onOpenLoopRun}
                />
              )}
            </For>
          </ol>
        </Show>
      </div>

      <ConfirmDialog
        open={confirmDelete()}
        title={`Delete ${r().name}?`}
        confirmLabel="Delete routine"
        danger
        busy={deleting()}
        error={confirmDelete() ? props.error : null}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void doDelete()}
      >
        <p>It stops firing, its API token stops working, and its definition and run history go. Sessions its runs left stay until you remove them.</p>
        <p class="text-[12px] text-fg-faint">To stop it for now and keep everything, pause it instead.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmRotate()}
        title="Mint a new API token?"
        confirmLabel="New token"
        busy={rotating()}
        error={rotateError()}
        onCancel={() => {
          setConfirmRotate(false);
          setRotateError(null);
        }}
        onConfirm={() => void doRotate()}
      >
        <p>The current token stops working at once: anything calling this routine's endpoint with it gets 401 until you give it the new one.</p>
      </ConfirmDialog>
    </div>
  );
};

const RunRow: Component<{
  run: RoutineRunWire;
  now: number;
  busy?: boolean;
  sessionOpenable: boolean;
  onCancel: () => void;
  onOpenSession: () => void;
  onOpenLoopRun: (runId: string) => void;
}> = (props) => {
  const run = () => props.run;
  const style = () => routineRunStatusStyle(run());
  const [confirmCancel, setConfirmCancel] = createSignal(false);
  const duration = () => {
    const start = run().startedAt;
    if (!start) return null;
    const end = run().endedAt ? Date.parse(run().endedAt!) : props.now;
    return end - Date.parse(start);
  };
  const loopRun = () => routineRunLoop(run());
  return (
    <li class="rounded border border-border bg-bg/30 px-3 py-2 text-[12px]" data-testid="routine-run">
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge style={style()} />
        <span class="text-fg-muted">{RUN_TRIGGER[run().trigger]}</span>
        <When at={run().startedAt ?? run().createdAt} now={props.now} class="font-mono text-[11px] text-fg-faint" />
        <span class="text-fg-faint">· {formatDuration(duration())}</span>
        <Show when={run().costUsd > 0 || run().inputTokens > 0 || run().costUnknown}>
          <span class="text-fg-faint" title={`${formatTokens(run().inputTokens)} in · ${formatTokens(run().outputTokens)} out`}>
            · {formatSessionCost({ totalCostUsd: run().costUsd, costUnknownTurns: run().costUnknown ? 1 : 0 }).text}
          </span>
        </Show>
        <span class="ml-auto flex items-center gap-2">
          <Show when={loopRun()}>
            {(l) => (
              <button
                type="button"
                class="flex items-center gap-1 text-[11px] text-accent underline-offset-2 hover:underline"
                onClick={() => props.onOpenLoopRun(l().runId)}
                title="Open the loop run this run started"
                data-testid="routine-run-loop"
              >
                <StatusBadge style={LOOP_STATUS[l().status]} />
                loop run
              </button>
            )}
          </Show>
          <Show when={run().sessionId}>
            <button
              type="button"
              class={linkBtn}
              disabled={!props.sessionOpenable}
              title={props.sessionOpenable ? "Open the run's session: everything the agent read, ran and wrote" : "That session isn't in your session list (cleaned up, or not visible here)"}
              onClick={() => props.onOpenSession()}
            >
              open session
            </button>
          </Show>
          <Show when={isCancellableRun(run().status)}>
            <Show
              when={confirmCancel()}
              fallback={
                <button type="button" class={`${linkBtn} text-danger`} onClick={() => setConfirmCancel(true)}>
                  cancel
                </button>
              }
            >
              <span class="flex items-center gap-1 text-[11px] text-danger">
                Stop it?
                <button
                  type="button"
                  class={dangerBtn}
                  disabled={props.busy}
                  onClick={() => {
                    setConfirmCancel(false);
                    props.onCancel();
                  }}
                >
                  Yes, cancel
                </button>
                <button type="button" class={quietBtn} onClick={() => setConfirmCancel(false)}>
                  Keep
                </button>
              </span>
            </Show>
          </Show>
        </span>
      </div>
      <Show when={run().summary}>
        <p class="mt-1 whitespace-pre-wrap text-fg">{run().summary}</p>
      </Show>
      <Show when={run().reason}>
        <p class="mt-1 text-fg-muted">{run().reason}</p>
      </Show>
      <Show when={run().checkOutput}>
        <details class="mt-1">
          <summary class="cursor-pointer text-[11px] text-fg-faint">check output</summary>
          <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg-muted">
            {run().checkOutput}
          </pre>
        </details>
      </Show>
      <Show when={run().payload}>
        <details class="mt-1">
          <summary class="cursor-pointer text-[11px] text-fg-faint">payload</summary>
          <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg-muted">
            {run().payload}
          </pre>
        </details>
      </Show>
    </li>
  );
};

export default RoutineDetail;
