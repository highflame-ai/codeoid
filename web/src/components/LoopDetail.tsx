/**
 * One loop run (docs/loops.md): its contract, where it stands, every attempt
 * with the daemon's evidence, its history, and the controls.
 *
 * Presentational: the round-trips live in state/loops.ts and LoopsPanel wires
 * them in, so the render and the per-status controls are tested directly.
 */

import { Component, For, Show, createSignal } from "solid-js";

import { EvidenceLink } from "./EvidenceView";
import { formatCostUsd, formatDuration, relativeTime } from "../lib/format";
import {
  ATTEMPT_RESULT,
  LOOP_STATUS,
  isTerminalLoop,
  loopActions,
  loopQuestion,
  loopWaitKind,
} from "../lib/loops";
import type { LoopAttemptWire, LoopEventWire, LoopRunWire } from "../protocol/types";

export interface LoopDetailProps {
  run: LoopRunWire;
  attempts: LoopAttemptWire[];
  /** Null until the history has been fetched. */
  events: LoopEventWire[] | null;
  historyOpen: boolean;
  /** A control is in flight. */
  busy?: boolean;
  error?: string | null;
  now: number;
  /** The worker session is in this client's session list. */
  workerAvailable: boolean;
  onBack: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  /** Resolves true when the daemon took it, so the box can clear. */
  onSteer: (text: string) => Promise<boolean>;
  onOpenWorker: () => void;
  onToggleHistory: (open: boolean) => void;
}

const labelClass = "text-[10px] font-semibold uppercase tracking-wider text-fg-faint";
const btn =
  "rounded border px-2.5 py-1 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-50";
const quietBtn = `${btn} border-border text-fg-muted hover:border-accent/40 hover:text-fg`;

function attemptDuration(a: LoopAttemptWire, now: number): number | null {
  if (!a.startedAt) return null;
  const end = a.endedAt ? Date.parse(a.endedAt) : now;
  return end - Date.parse(a.startedAt);
}

export const LoopDetail: Component<LoopDetailProps> = (props) => {
  const r = () => props.run;
  const style = () => LOOP_STATUS[r().status];
  const wait = () => loopWaitKind(r());
  const actions = () => loopActions(r().status);
  const [steer, setSteer] = createSignal("");
  const [confirmCancel, setConfirmCancel] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  const submitSteer = async () => {
    const text = steer().trim();
    if (!text) return;
    if (await props.onSteer(text)) setSteer("");
  };

  const copyCommit = (sha: string) => {
    void navigator.clipboard?.writeText(sha).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div class="flex flex-col gap-4" data-testid="loop-detail">
      <div class="flex items-center gap-2">
        <button type="button" class="text-[11px] text-fg-muted hover:text-fg" onClick={() => props.onBack()}>
          ← all loops
        </button>
        <span class="ml-auto font-mono text-[10px] text-fg-faint">{r().id}</span>
      </div>

      {/* Objective + status. */}
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <span
            class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${style().cls}`}
            data-testid="loop-status"
          >
            {style().mark} {style().label}
          </span>
          <Show when={r().reason}>
            <span class="text-[12px] text-fg-muted">{r().reason}</span>
          </Show>
        </div>
        <p class="whitespace-pre-wrap rounded border border-border bg-bg/30 px-3 py-2 text-[12px] text-fg">
          {r().objective}
        </p>
      </div>

      {/* What a waiting run waits on is the one thing to read first. */}
      <Show when={wait()}>
        <div class="rounded border border-warn/50 bg-warn/10 px-3 py-2" data-testid="loop-waiting">
          <div class={`${labelClass} text-warn`}>
            {wait() === "question" ? "The worker asks you" : "Waiting on an approval"}
          </div>
          <p class="mt-1 whitespace-pre-wrap text-[13px] text-fg">
            {wait() === "question"
              ? loopQuestion(r().waitingOn)
              : "A tool call in the worker session waits for your approval. Its attempt clock is stopped until you answer it there."}
          </p>
        </div>
      </Show>

      {/* How it ended, in the docs' words: verified is not the same as out of budget. */}
      <Show when={isTerminalLoop(r().status)}>
        <div class={`rounded border px-3 py-2 text-[12px] ${style().cls}`} data-testid="loop-outcome">
          {style().meaning}
        </div>
      </Show>

      <Show when={props.error}>
        <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">{props.error}</div>
      </Show>

      {/* Controls. */}
      <div class="flex flex-wrap items-center gap-2">
        <Show
          when={r().status === "paused"}
          fallback={
            <button type="button" class={quietBtn} disabled={props.busy || !actions().pause} onClick={() => props.onPause()}>
              Pause
            </button>
          }
        >
          <button
            type="button"
            class={`${btn} border-accent/50 bg-accent/10 text-accent hover:bg-accent/20`}
            disabled={props.busy || !actions().resume}
            onClick={() => props.onResume()}
          >
            Resume
          </button>
        </Show>
        <Show
          when={confirmCancel()}
          fallback={
            <button
              type="button"
              class={`${btn} border-border text-fg-muted hover:border-danger/40 hover:text-danger`}
              // Cancel is a safety stop: it stays available while another request runs.
              disabled={!actions().cancel}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel run
            </button>
          }
        >
          <span class="flex items-center gap-1.5 text-[11px] text-danger">
            Stop the run now?
            <button
              type="button"
              class={`${btn} border-danger/50 bg-danger/10 text-danger hover:bg-danger/20`}
              onClick={() => {
                setConfirmCancel(false);
                props.onCancel();
              }}
            >
              Yes, cancel
            </button>
            <button type="button" class={quietBtn} onClick={() => setConfirmCancel(false)}>
              Keep running
            </button>
          </span>
        </Show>
        <Show when={r().workerSessionId}>
          <button
            type="button"
            class={`${quietBtn} ml-auto`}
            disabled={!props.workerAvailable}
            title={
              props.workerAvailable
                ? "Watch the worker. What you type there steers the run."
                : "The worker session isn't in your session list"
            }
            onClick={() => props.onOpenWorker()}
          >
            Open worker session
          </button>
        </Show>
      </div>

      <Show when={actions().steer}>
        <label class="flex flex-col gap-1">
          <span class={labelClass}>{wait() === "question" ? "Your answer" : "Steer the next attempt"}</span>
          <textarea
            rows={2}
            value={steer()}
            onInput={(e) => setSteer(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submitSteer();
              }
            }}
            class="w-full resize-y rounded border border-border bg-bg px-2.5 py-1.5 text-[12px] leading-5 text-fg outline-none focus:border-accent disabled:opacity-50"
            disabled={props.busy}
            aria-label={wait() === "question" ? "Your answer" : "Steer the next attempt"}
            placeholder={
              wait() === "question"
                ? "Answer the worker's question. The run continues with it."
                : "Guidance the next attempt starts with, e.g. keep the v1 API."
            }
          />
          <div class="flex justify-end">
            <button
              type="button"
              class={`${btn} border-accent/50 bg-accent/10 text-accent hover:bg-accent/20`}
              disabled={props.busy || !steer().trim()}
              onClick={() => void submitSteer()}
            >
              {wait() === "question" ? "Answer" : "Steer"}
            </button>
          </div>
        </label>
      </Show>

      {/* Contract. */}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt class={labelClass}>Repo</dt>
        <dd class="truncate font-mono text-fg-muted" title={r().workdir}>
          {r().workdir}
        </dd>
        <dt class={labelClass}>Branch</dt>
        <dd class="font-mono text-fg-muted">
          {r().branch ?? "not created yet"}
          <Show when={r().baseRevision}>
            <span class="text-fg-faint"> from {r().baseRevision!.slice(0, 12)}</span>
          </Show>
        </dd>
        <Show when={r().deliveredCommit}>
          {(sha) => (
            <>
              <dt class={labelClass}>Delivered</dt>
              <dd class="flex items-center gap-2 font-mono text-success">
                <span data-testid="loop-commit">{sha()}</span>
                <button
                  type="button"
                  class="text-[11px] text-accent underline-offset-2 hover:underline"
                  aria-label="Copy commit"
                  onClick={() => copyCommit(sha())}
                >
                  {copied() ? "copied" : "copy"}
                </button>
              </dd>
            </>
          )}
        </Show>
        <dt class={labelClass}>Budget</dt>
        <dd class="text-fg-muted" data-testid="loop-budget">
          {r().attempts}/{r().limits.attempts} attempts · {formatDuration(r().activeMs)} of {r().limits.runMinutes}m ·{" "}
          {r().limits.attemptMinutes}m and {r().toolBudget} tool calls per attempt · {formatCostUsd(r().costUsd)}
        </dd>
        <Show when={r().model || r().provider}>
          <dt class={labelClass}>Worker</dt>
          <dd class="font-mono text-fg-muted">{[r().provider, r().model].filter(Boolean).join(" · ")}</dd>
        </Show>
        <dt class={labelClass}>Checks</dt>
        <dd>
          <ul class="flex flex-col gap-0.5">
            <For each={r().checks}>
              {(c) => (
                <li class="font-mono text-[11px] text-fg-muted">
                  <span class="text-fg">{c.id}</span>: {c.command}
                  <span class="text-fg-faint"> · {c.timeoutSec}s</span>
                </li>
              )}
            </For>
          </ul>
        </dd>
      </dl>

      {/* Attempts. */}
      <div>
        <div class={labelClass}>Attempts</div>
        <Show
          when={props.attempts.length > 0}
          fallback={<p class="mt-1 text-[12px] text-fg-faint">No attempt yet.</p>}
        >
          <ol class="mt-1 flex flex-col gap-2">
            <For each={props.attempts}>
              {(a) => <AttemptRow attempt={a} now={props.now} />}
            </For>
          </ol>
        </Show>
      </div>

      {/* History. */}
      <div>
        <button
          type="button"
          class="text-[11px] text-accent underline-offset-2 hover:underline"
          aria-expanded={props.historyOpen}
          onClick={() => props.onToggleHistory(!props.historyOpen)}
        >
          {props.historyOpen ? "▾ Hide history" : "▸ Show history"}
        </button>
        <Show when={props.historyOpen}>
          <Show
            when={props.events}
            fallback={<p class="mt-1 text-[11px] text-fg-faint">loading…</p>}
          >
            {(events) => (
              <ol class="mt-1 flex flex-col gap-0.5" data-testid="loop-history">
                <For each={events()}>
                  {(e) => (
                    <li class="text-[11px] text-fg-muted">
                      <span class="font-mono text-fg-faint">{relativeTime(e.at, props.now)}</span>{" "}
                      <span class="font-mono text-fg">{e.type}</span>
                      <Show when={e.detail}>
                        <span> — {e.detail}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
};

const AttemptRow: Component<{ attempt: LoopAttemptWire; now: number }> = (props) => {
  const a = () => props.attempt;
  const result = () => (a().result ? ATTEMPT_RESULT[a().result!] : null);
  return (
    <li class="rounded border border-border bg-bg/30 px-3 py-2 text-[12px]" data-testid="loop-attempt">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-mono text-fg">#{a().ordinal}</span>
        <span class={result()?.cls ?? "text-accent"}>{result()?.label ?? a().status}</span>
        <span class="text-fg-faint">· {formatDuration(attemptDuration(a(), props.now))}</span>
        <span class="text-fg-faint">· {formatCostUsd(a().costUsd)}</span>
      </div>
      <Show when={a().note}>
        <p class="mt-1 text-fg-muted">{a().note}</p>
      </Show>
      <Show when={a().report}>
        {(rep) => (
          <div class="mt-1">
            <span class="font-mono text-[11px] text-fg-faint">worker: {rep().outcome}</span>
            <p class="whitespace-pre-wrap text-fg">{rep().summary}</p>
            <Show when={rep().detail}>
              <p class="mt-0.5 whitespace-pre-wrap text-[11px] text-fg-muted">{rep().detail}</p>
            </Show>
          </div>
        )}
      </Show>
      <Show when={a().evidenceIds.length > 0}>
        <EvidenceLink ids={a().evidenceIds} />
      </Show>
    </li>
  );
};

export default LoopDetail;
