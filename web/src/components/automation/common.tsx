/**
 * Pieces the automation views (loop runs, watches, routines) share, in the
 * loops drawer's own style: a relative time with the absolute one on hover,
 * the status badge, the error box, a confirm dialog, the workdir field, and
 * the "which one do I want" explainer.
 */

import { Component, For, JSX, Show, createEffect, createSignal, onCleanup } from "solid-js";

import DirectoryPicker from "../files/DirectoryPicker";
import { absoluteTime, relativeWhen } from "../../lib/automation";
import type { LoopStatusStyle } from "../../lib/loops";

export const labelClass = "text-[10px] font-semibold uppercase tracking-wider text-fg-faint";
export const btn = "rounded border px-2.5 py-1 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-50";
export const quietBtn = `${btn} border-border text-fg-muted hover:border-accent/40 hover:text-fg`;
export const primaryBtn = `${btn} border-accent/50 bg-accent/10 text-accent hover:bg-accent/20`;
export const dangerBtn = `${btn} border-danger/50 bg-danger/10 text-danger hover:bg-danger/20`;
export const inputClass =
  "w-full rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50 aria-[invalid=true]:border-danger/70";
export const linkBtn = "text-[11px] text-accent underline-offset-2 hover:underline disabled:opacity-50";

/** A time relative to now ("in 4m", "3h ago"); the absolute one on hover. */
export const When: Component<{ at: string | null | undefined; now: number; class?: string }> = (props) => (
  <Show when={props.at} fallback={<span class={props.class}>—</span>}>
    {(at) => (
      <time class={props.class} dateTime={at()} title={absoluteTime(at())}>
        {relativeWhen(at(), props.now)}
      </time>
    )}
  </Show>
);

/** A status badge, the same family as the loop runs' badges. */
export const StatusBadge: Component<{ style: LoopStatusStyle; class?: string; testid?: string }> = (props) => (
  <span
    class={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${props.style.cls} ${props.class ?? ""}`}
    title={props.style.meaning}
    data-testid={props.testid}
  >
    {props.style.mark} {props.style.label}
  </span>
);

/** A plain badge (no mark). */
export const Pill: Component<{ cls: string; title?: string; children: JSX.Element; testid?: string }> = (props) => (
  <span
    class={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${props.cls}`}
    title={props.title}
    data-testid={props.testid}
  >
    {props.children}
  </span>
);

/** The daemon's words, kept visible until the next attempt. */
export const ErrorBox: Component<{ error: string | null | undefined; testid?: string }> = (props) => (
  <Show when={props.error}>
    <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert" data-testid={props.testid}>
      {props.error}
    </div>
  </Show>
);

/** A back link for the detail views. */
export const BackLink: Component<{ label: string; onClick: () => void }> = (props) => (
  <button type="button" class="text-[11px] text-fg-muted hover:text-fg" onClick={() => props.onClick()}>
    ← {props.label}
  </button>
);

// ── Confirm dialog ───────────────────────────────────────────────────────────

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What happens, in plain words. */
  children: JSX.Element;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button: deleting, forgetting. */
  danger?: boolean;
  busy?: boolean;
  /** The daemon's words when the confirmed action failed; the dialog stays open. */
  error?: string | null;
  /** False keeps the confirm button disabled (an unfilled field). */
  canConfirm?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

let dialogSeq = 0;

/**
 * A modal confirm. Esc and the backdrop cancel (not while busy); focus starts
 * on the safe button, Tab stays inside, and focus goes back to where it was.
 * Esc is taken in the capture phase so the drawer under it stays open.
 */
export const ConfirmDialog: Component<ConfirmDialogProps> = (props) => {
  let panel: HTMLDivElement | undefined;
  let cancelBtn: HTMLButtonElement | undefined;
  const titleId = `confirm-title-${++dialogSeq}`;

  createEffect(() => {
    if (!props.open) return;
    const before = document.activeElement as HTMLElement | null;
    queueMicrotask(() => cancelBtn?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!props.busy) props.onCancel();
        return;
      }
      if (e.key === "Tab" && panel) {
        const items = [...panel.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")].filter(
          (el) => !(el as HTMLButtonElement).disabled,
        );
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    });
  });

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[60] flex items-end justify-center bg-bg/70 backdrop-blur-sm sm:items-start"
        onClick={(e) => {
          if (e.target === e.currentTarget && !props.busy) props.onCancel();
        }}
      >
        <div
          ref={panel}
          class="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-lg border border-border bg-bg-elev p-5 shadow-2xl sm:mt-[12vh] sm:rounded-lg"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <h2 id={titleId} class="mb-2 text-base font-semibold tracking-tight text-fg">
            {props.title}
          </h2>
          <div class="flex flex-col gap-2 text-[13px] leading-relaxed text-fg-muted">{props.children}</div>
          <div class="mt-3">
            <ErrorBox error={props.error} />
          </div>
          <div class="mt-4 flex items-center justify-end gap-2">
            <Show when={props.busy}>
              <span class="mr-auto text-[11px] text-fg-faint" aria-live="polite">
                working…
              </span>
            </Show>
            <button ref={cancelBtn} type="button" class={quietBtn} disabled={props.busy} onClick={() => props.onCancel()}>
              {props.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              class={props.danger ? dangerBtn : primaryBtn}
              disabled={props.busy || props.canConfirm === false}
              onClick={() => props.onConfirm()}
            >
              {props.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

// ── Workdir field ────────────────────────────────────────────────────────────

/** The repository/directory input with Browse… and recent workdirs, as on the loop start form. */
export const WorkdirField: Component<{
  label: string;
  value: string;
  recent: string[];
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  hint?: string;
  onInput: (v: string) => void;
}> = (props) => {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  return (
    <div class="flex flex-col gap-1">
      <span class={labelClass}>{props.label}</span>
      <div class="flex gap-1.5">
        <input
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          class={`${inputClass} flex-1`}
          disabled={props.disabled}
          aria-label={props.label}
          aria-invalid={props.invalid ? "true" : undefined}
          placeholder={props.placeholder ?? "/path/to/repo on the daemon host"}
        />
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          class="rounded border border-border bg-bg px-3 py-1.5 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50"
          disabled={props.disabled}
          title="Browse the daemon host's filesystem"
        >
          Browse…
        </button>
      </div>
      <Show when={props.recent.length > 0}>
        <div class="flex flex-wrap gap-1">
          <For each={props.recent}>
            {(wd) => (
              <button
                type="button"
                onClick={() => props.onInput(wd)}
                class={`max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[11px] transition ${
                  props.value === wd
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                }`}
                title={wd}
                disabled={props.disabled}
              >
                {wd}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.hint}>
        <p class="text-[10px] text-fg-faint">{props.hint}</p>
      </Show>
      <DirectoryPicker
        open={pickerOpen()}
        {...(props.value ? { initialPath: props.value } : {})}
        onPick={(p) => props.onInput(p)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
};

// ── Which one do I want ──────────────────────────────────────────────────────

/** Loop vs watch vs routine, in a few lines (docs/loops.md, docs/routines.md). */
export const AutomationExplainer: Component<{ highlight?: "runs" | "watches" | "routines" }> = (props) => {
  const row = (key: "runs" | "watches" | "routines", name: string, body: string) => (
    <li class={`rounded border px-3 py-2 ${props.highlight === key ? "border-accent/50 bg-accent/5" : "border-border bg-bg/30"}`}>
      <span class="font-semibold text-fg">{name}</span> <span class="text-fg-muted">{body}</span>
    </li>
  );
  return (
    <ul class="flex flex-col gap-1.5 text-[12px] leading-relaxed" data-testid="automation-explainer">
      {row(
        "runs",
        "Loop run:",
        "one objective, worked in its own worktree until checks the daemon runs itself pass. Start one when you know what has to be fixed.",
      )}
      {row(
        "watches",
        "Watch:",
        "starts loop runs for you from GitHub — a failing CI check on a branch you watch, or an @codeoid review comment on your pull request. It only runs code from heads you or people you trust pushed or merged.",
      )}
      {row(
        "routines",
        "Routine:",
        "a saved agent task on a schedule, an API call, or by hand. A shell check can gate it so most runs cost nothing. Use it for recurring work: triage, digests, health checks.",
      )}
    </ul>
  );
};
