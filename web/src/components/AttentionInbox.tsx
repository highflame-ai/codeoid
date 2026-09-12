/**
 * The "Needs you" inbox — one cross-session queue of everything blocking
 * (conductor-frontends-design §8).
 *
 * Ambient count in the status bar, opening a ranked list. §8 asks for the
 * count to be always visible and the queue one click away: the point is that
 * you stop polling N sessions to find the one that stopped.
 *
 * Ranking and collection are pure (`lib/attention.ts`); this is the surface.
 */

import { Component, For, Show, createSignal, onCleanup } from "solid-js";

import { relativeTime } from "../lib/format";
import type { AttentionItem, AttentionKind } from "../lib/attention";
import { attentionCount, attentionItems } from "../state/attention";
import { nowTick } from "../state/clock";
import { focusSession } from "../state/sessions";

const KIND_STYLE: Record<AttentionKind, { cls: string; label: string }> = {
  question: { cls: "border-warn/60 bg-warn/15 text-warn", label: "asks" },
  approval: { cls: "border-warn/60 bg-warn/15 text-warn", label: "approve" },
  blocked: { cls: "border-danger/60 bg-danger/15 text-danger", label: "blocked" },
  failed: { cls: "border-danger/40 bg-danger/10 text-danger", label: "failed" },
};

const AttentionInbox: Component = () => {
  const [open, setOpen] = createSignal(false);

  // Close on Escape — the panel is an overlay, and a keyboard user must be
  // able to dismiss it without hunting for the toggle.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  }

  return (
    <div class="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
        title={
          attentionCount() > 0
            ? `${attentionCount()} thing(s) waiting on you`
            : "Nothing is waiting on you"
        }
        class={`rounded border px-1.5 py-0.5 font-mono text-[11px] transition ${
          attentionCount() > 0
            ? "border-warn/60 bg-warn/15 text-warn hover:bg-warn/25"
            : "border-border bg-bg text-fg-faint hover:text-fg-muted"
        }`}
      >
        {/* Zero is shown, not hidden: a badge that vanishes cannot be trusted
            as an at-a-glance "nothing is stuck" signal — you would not know
            whether it means clear or broken. */}
        {attentionCount()} needs you
      </button>

      <Show when={open()}>
        {/* Click-away backdrop, behind the panel. */}
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
        <div class="absolute right-0 z-50 mt-1 max-h-96 w-96 overflow-y-auto rounded border border-border bg-bg-elev shadow-2xl">
          <Show
            when={attentionItems().length > 0}
            fallback={
              <p class="px-3 py-4 text-xs text-fg-muted">
                Nothing is waiting on you. Agents that wedge on an approval, ask a
                question, or hit the failure limit show up here.
              </p>
            }
          >
            <ul class="flex flex-col">
              <For each={attentionItems()}>
                {(item) => <Row item={item} onGo={() => setOpen(false)} />}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  );
};

const Row: Component<{ item: AttentionItem; onGo: () => void }> = (props) => {
  const style = () => KIND_STYLE[props.item.kind];
  const body = (
    <>
      <div class="flex items-center gap-2">
        <span
          class={`shrink-0 rounded border px-1 font-mono text-[10px] uppercase tracking-wider ${style().cls}`}
        >
          {style().label}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
          {props.item.label}
        </span>
        <span class="shrink-0 font-mono text-[10px] text-fg-faint">
          {relativeTime(new Date(props.item.since).toISOString(), nowTick())}
        </span>
      </div>
      <p class="line-clamp-2 pl-1 text-[11px] leading-snug text-fg-muted">
        {props.item.detail}
      </p>
    </>
  );

  return (
    <li class="border-b border-border/40 last:border-b-0">
      {/* A stopped task whose worker was torn down has nowhere to go, so it
          renders as a plain row rather than a button that does nothing. */}
      <Show
        when={props.item.sessionId}
        fallback={<div class="flex flex-col gap-1 px-3 py-2">{body}</div>}
      >
        {(id) => (
          <button
            type="button"
            onClick={() => {
              focusSession(id());
              props.onGo();
            }}
            class="flex w-full flex-col gap-1 px-3 py-2 text-left transition hover:bg-bg-hover"
          >
            {body}
          </button>
        )}
      </Show>
    </li>
  );
};

export default AttentionInbox;
