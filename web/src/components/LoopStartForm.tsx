/**
 * Start a repair loop (docs/loops.md): the objective, the repository, the
 * checks that must pass, and the run's limits. The form only checks what it
 * can know (`buildLoopStart`); ranges and backends are the daemon's to judge,
 * and its words are shown as they come.
 *
 * Presentational apart from the directory picker: `onSubmit` does the
 * round-trip and rejects with the daemon's message.
 */

import { Component, For, Index, Show, createSignal } from "solid-js";

import DirectoryPicker from "./files/DirectoryPicker";
import {
  LOOP_FORM_DEFAULTS,
  buildLoopStart,
  emptyCheckRow,
  emptyLoopForm,
  type LoopCheckRow,
  type LoopStartForm as FormState,
} from "../lib/loops";
import type { LoopStartMsg } from "../protocol/types";

/** The daemon's ceiling on checks per run (LOOP_LIMITS.CHECKS_MAX). */
const CHECKS_MAX = 10;

export interface LoopStartFormProps {
  /** Prefill for the objective (`/loop <objective…>`). */
  objective?: string;
  recentWorkdirs: string[];
  /** Backends to offer; blank = the daemon's default. */
  providers: { id: string; label: string }[];
  onSubmit: (body: Omit<LoopStartMsg, "id">) => Promise<void>;
  onCancel: () => void;
}

const inputClass =
  "w-full rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50";
const labelClass = "text-[10px] font-semibold uppercase tracking-wider text-fg-faint";

export const LoopStartForm: Component<LoopStartFormProps> = (props) => {
  const [form, setForm] = createSignal<FormState>({ ...emptyLoopForm(), objective: props.objective ?? "" });
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setCheck = (i: number, patch: Partial<LoopCheckRow>) =>
    setForm((f) => ({ ...f, checks: f.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const submit = async (e: Event) => {
    e.preventDefault();
    const built = buildLoopStart(form());
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await props.onSubmit(built.msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form class="flex flex-col gap-4" onSubmit={(e) => void submit(e)} data-testid="loop-start-form">
        <p class="text-[12px] leading-relaxed text-fg-muted">
          A repair loop works in its own worktree and branch until the checks below pass when the daemon runs them.
          Your checkout is never modified.
        </p>

        <label class="flex flex-col gap-1">
          <span class={labelClass}>Objective</span>
          <textarea
            rows={3}
            value={form().objective}
            onInput={(e) => set("objective", e.currentTarget.value)}
            class={`${inputClass} resize-y font-sans leading-5`}
            disabled={busy()}
            aria-label="Objective"
            placeholder="Fix the failing checkout test"
          />
        </label>

        <div class="flex flex-col gap-1">
          <span class={labelClass}>Repository</span>
          <div class="flex gap-1.5">
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              value={form().workdir}
              onInput={(e) => set("workdir", e.currentTarget.value)}
              class={`${inputClass} flex-1`}
              disabled={busy()}
              aria-label="Repository"
              placeholder="/path/to/repo on the daemon host"
            />
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              class="rounded border border-border bg-bg px-3 py-1.5 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50"
              disabled={busy()}
              title="Browse the daemon host's filesystem"
            >
              Browse…
            </button>
          </div>
          <Show when={props.recentWorkdirs.length > 0}>
            <div class="flex flex-wrap gap-1">
              <For each={props.recentWorkdirs}>
                {(wd) => (
                  <button
                    type="button"
                    onClick={() => set("workdir", wd)}
                    class={`max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[11px] transition ${
                      form().workdir === wd
                        ? "border-accent/60 bg-accent/10 text-accent"
                        : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                    }`}
                    title={wd}
                  >
                    {wd}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="flex flex-col gap-1.5">
          <span class={labelClass}>Checks that must pass</span>
          <Index each={form().checks}>
            {(c, i) => (
              <div class="flex flex-wrap items-center gap-1.5" data-testid="loop-check-row">
                <input
                  type="text"
                  value={c().id}
                  onInput={(e) => setCheck(i, { id: e.currentTarget.value })}
                  class={`${inputClass} w-24`}
                  disabled={busy()}
                  aria-label={`Check ${i + 1} id`}
                  placeholder={`check${i + 1}`}
                />
                <input
                  type="text"
                  value={c().command}
                  onInput={(e) => setCheck(i, { command: e.currentTarget.value })}
                  class={`${inputClass} min-w-0 flex-1`}
                  disabled={busy()}
                  aria-label={`Check ${i + 1} command`}
                  placeholder="bun test src/checkout"
                />
                <input
                  type="text"
                  inputmode="numeric"
                  value={c().timeoutSec}
                  onInput={(e) => setCheck(i, { timeoutSec: e.currentTarget.value })}
                  class={`${inputClass} w-20`}
                  disabled={busy()}
                  aria-label={`Check ${i + 1} timeout seconds`}
                  placeholder="600s"
                />
                <label class="flex items-center gap-1 text-[11px] text-fg-muted" title="A run that selects no tests does not pass">
                  <input
                    type="checkbox"
                    checked={c().expectTests}
                    onChange={(e) => setCheck(i, { expectTests: e.currentTarget.checked })}
                    disabled={busy()}
                    aria-label={`Check ${i + 1} is a test run`}
                  />
                  test run
                </label>
                <Show when={form().checks.length > 1}>
                  <button
                    type="button"
                    class="text-[11px] text-fg-faint hover:text-danger"
                    aria-label={`Remove check ${i + 1}`}
                    disabled={busy()}
                    onClick={() => setForm((f) => ({ ...f, checks: f.checks.filter((_, j) => j !== i) }))}
                  >
                    ✕
                  </button>
                </Show>
              </div>
            )}
          </Index>
          <Show when={form().checks.length < CHECKS_MAX}>
            <button
              type="button"
              class="self-start text-[11px] text-accent underline-offset-2 hover:underline"
              disabled={busy()}
              onClick={() => setForm((f) => ({ ...f, checks: [...f.checks, emptyCheckRow()] }))}
            >
              + Add check
            </button>
          </Show>
        </div>

        <div class="flex flex-col gap-1">
          <span class={labelClass}>Limits</span>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <NumberField label="Attempts" value={form().attempts} placeholder={LOOP_FORM_DEFAULTS.attempts} disabled={busy()} onInput={(v) => set("attempts", v)} />
            <NumberField label="Minutes per attempt" value={form().attemptMinutes} placeholder={LOOP_FORM_DEFAULTS.attemptMinutes} disabled={busy()} onInput={(v) => set("attemptMinutes", v)} />
            <NumberField label="Minutes per run" value={form().runMinutes} placeholder={LOOP_FORM_DEFAULTS.runMinutes} disabled={busy()} onInput={(v) => set("runMinutes", v)} />
            <NumberField label="Tool calls per attempt" value={form().toolBudget} placeholder={LOOP_FORM_DEFAULTS.toolBudget} disabled={busy()} onInput={(v) => set("toolBudget", v)} />
          </div>
          <p class="text-[10px] text-fg-faint">
            Blank uses the default shown. A question you answer doesn't count as an attempt.
          </p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1">
            <span class={labelClass}>Backend (optional)</span>
            <select
              value={form().provider}
              onChange={(e) => set("provider", e.currentTarget.value)}
              class={inputClass}
              disabled={busy()}
              aria-label="Backend"
            >
              <option value="">daemon default</option>
              <For each={props.providers}>{(p) => <option value={p.id}>{p.label}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class={labelClass}>Model (optional)</span>
            <input
              type="text"
              value={form().model}
              onInput={(e) => set("model", e.currentTarget.value)}
              class={inputClass}
              disabled={busy()}
              aria-label="Model"
              placeholder="backend default"
            />
          </label>
        </div>

        <Show when={error()}>
          <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">
            {error()}
          </div>
        </Show>

        <div class="flex items-center justify-end gap-2">
          <Show when={busy()}>
            <span class="mr-auto text-[11px] text-fg-faint">Preparing the worktree and running the checks…</span>
          </Show>
          <button
            type="button"
            class="rounded border border-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg"
            onClick={() => props.onCancel()}
          >
            Back
          </button>
          <button
            type="submit"
            class="rounded border border-accent/50 bg-accent/10 px-3 py-1.5 text-[12px] font-semibold text-accent hover:bg-accent/20 disabled:opacity-50"
            disabled={busy()}
          >
            Start loop
          </button>
        </div>
      </form>
      {/* Outside the form: the picker's own controls must never submit it. */}
      <DirectoryPicker
        open={pickerOpen()}
        {...(form().workdir ? { initialPath: form().workdir } : {})}
        onPick={(p) => set("workdir", p)}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
};

const NumberField: Component<{
  label: string;
  value: string;
  placeholder: number;
  disabled: boolean;
  onInput: (v: string) => void;
}> = (props) => (
  <label class="flex flex-col gap-0.5">
    <span class="text-[10px] text-fg-muted">{props.label}</span>
    <input
      type="text"
      inputmode="numeric"
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      class={inputClass}
      disabled={props.disabled}
      aria-label={props.label}
      placeholder={String(props.placeholder)}
    />
  </label>
);

export default LoopStartForm;
