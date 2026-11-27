/**
 * Create or edit a routine (docs/routines.md): what the agent does, where,
 * when it fires (with the daemon's own preview of the next three fires), the
 * check that gates it, who approves its tool calls, and its budgets.
 *
 * The form checks what it can know (`buildRoutineSpec`, `buildRoutinePatch`);
 * the daemon judges the rest and its words are shown as they come — the
 * schedule preview included, which is the daemon validating the schedule.
 */

import { Component, For, Index, JSX, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import { absoluteTime, relativeWhen } from "../../lib/automation";
import { emptyCheckRow, type LoopCheckRow } from "../../lib/loops";
import {
  LOOP_OBJECTIVE_MAX,
  LOOP_ROUTINE_REFUSES,
  PROMPT_PLACEHOLDERS,
  ROUTINE_DEFAULTS,
  ROUTINE_LOOP_CHECKS_MAX,
  ROUTINE_LOOP_DEFAULTS,
  buildRoutinePatch,
  buildRoutineSpec,
  emptyRoutineForm,
  formFromRoutine,
  intervalWords,
  parseEvery,
  routineWarnings,
  scheduleFromForm,
  scheduleWords,
  type RoutineForm as FormState,
  type ScheduleKind,
} from "../../lib/routines";
import type { RoutineScheduleWire, RoutineSpecWire, RoutineUpdateMsg, RoutineWire } from "../../protocol/types";
import { ErrorBox, WorkdirField, inputClass, labelClass, primaryBtn, quietBtn } from "./common";

export type RoutineFormSubmit =
  | { kind: "create"; spec: RoutineSpecWire }
  | { kind: "update"; patch: NonNullable<RoutineUpdateMsg["spec"]> };

export interface RoutineFormProps {
  /** Editing this routine; absent = a new one. */
  routine?: RoutineWire;
  recentWorkdirs: string[];
  providers: { id: string; label: string }[];
  now: number;
  /** The daemon's `routine.preview`; rejects with its reason. */
  preview: (schedule: RoutineScheduleWire) => Promise<string[]>;
  /** Rejects with the daemon's words. */
  onSubmit: (body: RoutineFormSubmit) => Promise<void>;
  onCancel: () => void;
  /** Debounce for the live preview (tests pass 0). */
  previewDelayMs?: number;
}

const SCHEDULE_KINDS: { kind: ScheduleKind; label: string }[] = [
  { kind: "every", label: "Every…" },
  { kind: "cron", label: "Cron" },
  { kind: "once", label: "Once" },
  { kind: "none", label: "On demand" },
];

function timezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export const RoutineForm: Component<RoutineFormProps> = (props) => {
  const editing = () => !!props.routine;
  // The form is seeded once; a background refresh of the routine must not
  // overwrite what is being typed.
  // eslint-disable-next-line solid/reactivity
  const [form, setForm] = createSignal<FormState>(props.routine ? formFromRoutine(props.routine) : emptyRoutineForm());
  const [error, setError] = createSignal<{ error: string; field: string | null } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<{ fires: string[] } | { error: string } | { loading: true } | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setLoop = (patch: Partial<FormState["loop"]>) => setForm((f) => ({ ...f, loop: { ...f.loop, ...patch } }));
  const setLoopCheck = (i: number, patch: Partial<LoopCheckRow>) =>
    setForm((f) => ({ ...f, loop: { ...f.loop, checks: f.loop.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)) } }));
  /** The action is "Start a loop": the session-only settings step aside, saying why. */
  const isLoop = () => form().action === "loop";
  const invalid = (field: string) => (error()?.field === field ? "true" : undefined);

  // ── Live preview of the next three fires, from the daemon ──
  const scheduleInput = createMemo(() => {
    const f = form();
    return JSON.stringify([f.scheduleKind, f.cronExpr, f.cronTz, f.every, f.onceAt]);
  });
  let previewSeq = 0;
  createEffect(
    on(scheduleInput, () => {
      const seq = ++previewSeq;
      const sched = scheduleFromForm(form());
      if ("error" in sched) {
        setPreview({ error: sched.error });
        return;
      }
      if (!sched.schedule) {
        setPreview(null);
        return;
      }
      // A cron left without a zone keeps the routine's on save; preview it there too.
      const cur = props.routine?.spec.schedule;
      const schedule: RoutineScheduleWire =
        sched.schedule.kind === "cron" && !sched.schedule.timezone && cur?.kind === "cron" && cur.timezone
          ? { ...sched.schedule, timezone: cur.timezone }
          : sched.schedule;
      setPreview({ loading: true });
      const timer = setTimeout(() => {
        props
          .preview(schedule)
          .then((fires) => seq === previewSeq && setPreview({ fires }))
          .catch((e: unknown) => seq === previewSeq && setPreview({ error: e instanceof Error ? e.message : String(e) }));
      }, props.previewDelayMs ?? 400);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  const scheduleText = createMemo(() => {
    const sched = scheduleFromForm(form());
    return "schedule" in sched && sched.schedule ? scheduleWords(sched.schedule) : null;
  });

  const patchInfo = createMemo(() => (props.routine ? buildRoutinePatch(props.routine, form()) : null));
  const changedCount = () => {
    const p = patchInfo();
    return p && "changed" in p ? p.changed.length : 0;
  };
  const warnings = createMemo(() => routineWarnings(form()));
  const everyWords = createMemo(() => {
    const s = parseEvery(form().every);
    return typeof s === "number" ? `every ${intervalWords(s)}` : null;
  });

  const submit = async (e: Event) => {
    e.preventDefault();
    let body: RoutineFormSubmit;
    if (props.routine) {
      const built = buildRoutinePatch(props.routine, form());
      if ("error" in built) return setError(built);
      if (built.changed.length === 0) return setError({ error: "Nothing has changed", field: null });
      body = { kind: "update", patch: built.patch };
    } else {
      const built = buildRoutineSpec(form());
      if ("error" in built) return setError(built);
      body = { kind: "create", spec: built.spec };
    }
    setError(null);
    setBusy(true);
    try {
      await props.onSubmit(body);
    } catch (err) {
      setError({ error: err instanceof Error ? err.message : String(err), field: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="flex flex-col gap-4" onSubmit={(e) => void submit(e)} data-testid="routine-form" noValidate>
      <div class="flex items-center gap-2">
        <h3 class="text-[13px] font-semibold text-fg">{editing() ? `Edit ${props.routine!.name}` : "New routine"}</h3>
      </div>
      <Show when={!editing()}>
        <p class="text-[12px] leading-relaxed text-fg-muted">
          A routine runs an agent for you on a schedule, when something calls its API, or when you press Run now. Each run is an ordinary
          session you can open. Give it a check, and runs with nothing to do cost nothing.
        </p>
      </Show>

      <div class="grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <Field label="Name" error={error()} field="name">
          <input
            type="text"
            autocomplete="off"
            spellcheck={false}
            value={form().name}
            onInput={(e) => set("name", e.currentTarget.value)}
            class={inputClass}
            disabled={busy()}
            aria-label="Name"
            aria-invalid={invalid("name")}
            placeholder="ci-watch"
          />
        </Field>
        <WorkdirField
          label="Workdir"
          value={form().workdir}
          recent={props.recentWorkdirs}
          disabled={busy()}
          invalid={!!invalid("workdir")}
          onInput={(v) => set("workdir", v)}
        />
      </div>

      {/* What a fire does. */}
      <fieldset class="flex flex-col gap-1.5">
        <legend class={`${labelClass} mb-1`}>Each run</legend>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Action">
          <For each={[["session", "Prompts an agent"], ["loop", "Starts a loop"]] as const}>
            {([kind, label]) => (
              <button
                type="button"
                role="radio"
                aria-checked={form().action === kind}
                class={`rounded border px-2.5 py-1 text-[12px] transition ${
                  form().action === kind
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                }`}
                disabled={busy()}
                onClick={() => set("action", kind)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <p class="text-[11px] text-fg-muted">
          {isLoop()
            ? "A verified repair: the loop works in its own worktree and is done only when the acceptance checks below pass when the daemon runs them. The routine decides when to try; the loop decides whether the work is done."
            : "An ordinary session you can open from any device: everything the agent read, ran and wrote."}
        </p>
      </fieldset>

      <Field label={isLoop() ? "Objective" : "Prompt"} error={error()} field="prompt">
        <textarea
          rows={4}
          value={form().prompt}
          onInput={(e) => set("prompt", e.currentTarget.value)}
          class={`${inputClass} resize-y font-sans leading-5`}
          disabled={busy()}
          aria-label={isLoop() ? "Objective" : "Prompt"}
          aria-invalid={invalid("prompt")}
          placeholder={
            isLoop()
              ? "Fix the flaky test failures the check found. Make the tests deterministic; do not skip or delete them."
              : "CI on main is failing. Find the cause from the run logs and summarise it in three lines.\n\n{{check}}"
          }
        />
        <Show
          when={!isLoop()}
          fallback={
            <p class="text-[10px] text-fg-faint">
              The loop's fixed objective: at most {LOOP_OBJECTIVE_MAX.toLocaleString("en-US")} characters, with no {"{{…}}"} placeholders. What the
              check printed, and any payload, reach the worker as quoted data on their own.
            </p>
          }
        >
        <div class="flex flex-wrap gap-1">
          <For each={PROMPT_PLACEHOLDERS}>
            {(p) => (
              <button
                type="button"
                class="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted hover:border-accent/40 hover:text-fg"
                title={`Insert ${p.token}: ${p.meaning}`}
                disabled={busy()}
                onClick={() => set("prompt", `${form().prompt}${form().prompt && !form().prompt.endsWith("\n") ? " " : ""}${p.token}`)}
              >
                {p.token}
              </button>
            )}
          </For>
        </div>
        <p class="text-[10px] text-fg-faint">
          Check output and payloads reach the agent as data, never as instructions. Every run is told it's unattended; a [SILENT] reply ends it quietly.
        </p>
        </Show>
      </Field>

      {/* Schedule. */}
      <fieldset class="flex flex-col gap-1.5">
        <legend class={`${labelClass} mb-1`}>When it fires</legend>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Schedule kind">
          <For each={SCHEDULE_KINDS}>
            {(k) => (
              <button
                type="button"
                role="radio"
                aria-checked={form().scheduleKind === k.kind}
                class={`rounded border px-2.5 py-1 text-[12px] transition ${
                  form().scheduleKind === k.kind
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border bg-bg text-fg-muted hover:border-accent/40 hover:text-fg"
                }`}
                disabled={busy()}
                onClick={() => set("scheduleKind", k.kind)}
              >
                {k.label}
              </button>
            )}
          </For>
        </div>
        <Show when={form().scheduleKind === "every"}>
          <div class="flex flex-wrap items-center gap-2">
            <input
              type="text"
              autocomplete="off"
              value={form().every}
              onInput={(e) => set("every", e.currentTarget.value)}
              class={`${inputClass} w-28!`}
              disabled={busy()}
              aria-label="Interval"
              aria-invalid={invalid("every")}
              placeholder="15m"
            />
            <span class="text-[11px] text-fg-muted">{everyWords() ?? "90s, 15m, 2h, 1d or 1h30m"}</span>
          </div>
          <p class="text-[10px] text-fg-faint">Fires stay on their phase however long each run takes. The shortest interval is 60 seconds.</p>
        </Show>
        <Show when={form().scheduleKind === "cron"}>
          <div class="grid gap-2 sm:grid-cols-[1fr_minmax(0,14rem)]">
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              value={form().cronExpr}
              onInput={(e) => set("cronExpr", e.currentTarget.value)}
              class={inputClass}
              disabled={busy()}
              aria-label="Cron expression"
              aria-invalid={invalid("cron")}
              placeholder="0 9 * * 1-5"
            />
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              list="routine-timezones"
              value={form().cronTz}
              onInput={(e) => set("cronTz", e.currentTarget.value)}
              class={inputClass}
              disabled={busy()}
              aria-label="Timezone"
              placeholder={editing() ? "keep its zone" : "daemon's zone"}
            />
            <datalist id="routine-timezones">
              <For each={timezones()}>{(tz) => <option value={tz} />}</For>
            </datalist>
          </div>
          <p class="text-[10px] text-fg-faint">minute hour day month weekday, in an IANA zone. Daylight saving is handled the way the zone defines it.</p>
        </Show>
        <Show when={form().scheduleKind === "once"}>
          <input
            type="datetime-local"
            value={form().onceAt}
            onInput={(e) => set("onceAt", e.currentTarget.value)}
            class={`${inputClass} w-60!`}
            disabled={busy()}
            aria-label="Run at"
            aria-invalid={invalid("once")}
          />
          <p class="text-[10px] text-fg-faint">In your browser's zone, sent with it. It is unscheduled after it runs.</p>
        </Show>
        <Show when={form().scheduleKind === "none"}>
          <p class="text-[11px] text-fg-muted">It runs only when you press Run now, or when something calls its API.</p>
        </Show>
        <SchedulePreview preview={preview()} now={props.now} words={scheduleText()} />
      </fieldset>

      {/* Check gate. */}
      <Field label={isLoop() ? "Gate check (optional)" : "Check (optional)"} error={error()} field="check">
        <div class="flex flex-wrap gap-1.5">
          <input
            type="text"
            autocomplete="off"
            spellcheck={false}
            value={form().checkCommand}
            onInput={(e) => set("checkCommand", e.currentTarget.value)}
            class={`${inputClass} min-w-0 flex-1`}
            disabled={busy()}
            aria-label="Check command"
            aria-invalid={invalid("check")}
            placeholder={'gh pr list --search "review-requested:@me" --json number,title'}
          />
          <input
            type="text"
            inputmode="numeric"
            value={form().checkTimeout}
            onInput={(e) => set("checkTimeout", e.currentTarget.value)}
            class={`${inputClass} w-24!`}
            disabled={busy() || !form().checkCommand.trim()}
            aria-label="Check timeout seconds"
            placeholder={`${ROUTINE_DEFAULTS.checkTimeoutSeconds}s`}
          />
        </div>
        <Show
          when={!isLoop()}
          fallback={
            <p class="text-[10px] text-fg-faint">
              The routine's gate: is there work? It runs first; no output means nothing to do, and no loop starts. It is not the loop's
              acceptance check (below), which says whether the work is done.
            </p>
          }
        >
          <p class="text-[10px] text-fg-faint">
            A shell command run in the workdir before any agent. No output: the run is silent, no agent, $0. Output: the agent starts with it as
            {" {{check}}"}. Non-zero exit: the run fails. Saving one needs session:approve.
          </p>
        </Show>
      </Field>

      {/* Approvals. */}
      <Show when={isLoop()}>
        <div class="flex flex-col gap-1">
          <span class={labelClass}>Tool approvals</span>
          <p class="text-[11px] text-fg-muted" data-testid="routine-loop-approvals">
            {LOOP_ROUTINE_REFUSES.approvals} Saving, firing or resuming a loop routine needs session:approve.
          </p>
        </div>
      </Show>
      <fieldset class="flex flex-col gap-1.5" hidden={isLoop()}>
        <legend class={`${labelClass} mb-1`}>Tool approvals</legend>
        <label class="flex items-start gap-2 text-[12px] text-fg">
          <input
            type="radio"
            name="routine-approvals"
            class="mt-0.5"
            checked={form().approvals === "guarded"}
            onChange={() => set("approvals", "guarded")}
            disabled={busy()}
          />
          <span>
            Guarded
            <span class="block text-[11px] text-fg-muted">The agent reads freely; every edit or command waits for you, on any device.</span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-[12px] text-fg">
          <input
            type="radio"
            name="routine-approvals"
            class="mt-0.5"
            checked={form().approvals === "autonomous"}
            onChange={() => set("approvals", "autonomous")}
            disabled={busy()}
          />
          <span>
            Autonomous
            <span class="block text-[11px] text-fg-muted">
              Runs within a tool-call budget, then reverts to guarded. Needs session:approve to save or run.
            </span>
          </span>
        </label>
      </fieldset>

      {/* Budgets. */}
      <Show when={isLoop()}>
        <fieldset class="flex flex-col gap-2 rounded border border-accent/30 bg-accent/5 px-3 py-2" data-testid="routine-loop-fields">
          <legend class={labelClass}>The loop</legend>
          <span class="text-[10px] text-fg-muted">Acceptance checks: the loop is done only when every one passes on its work</span>
          <Index each={form().loop.checks}>
            {(c, i) => (
              <div class="flex flex-wrap items-center gap-1.5" data-testid="routine-loop-check">
                <input
                  type="text"
                  value={c().id}
                  onInput={(e) => setLoopCheck(i, { id: e.currentTarget.value })}
                  class={`${inputClass} w-24!`}
                  disabled={busy()}
                  aria-label={`Acceptance check ${i + 1} id`}
                  placeholder={`check${i + 1}`}
                />
                <input
                  type="text"
                  value={c().command}
                  onInput={(e) => setLoopCheck(i, { command: e.currentTarget.value })}
                  class={`${inputClass} min-w-0 flex-1`}
                  disabled={busy()}
                  aria-label={`Acceptance check ${i + 1} command`}
                  aria-invalid={invalid("loop")}
                  placeholder="bun test"
                />
                <input
                  type="text"
                  inputmode="numeric"
                  value={c().timeoutSec}
                  onInput={(e) => setLoopCheck(i, { timeoutSec: e.currentTarget.value })}
                  class={`${inputClass} w-20!`}
                  disabled={busy()}
                  aria-label={`Acceptance check ${i + 1} timeout seconds`}
                  placeholder={`${ROUTINE_LOOP_DEFAULTS.checkTimeoutSec}s`}
                />
                <label class="flex items-center gap-1 text-[11px] text-fg-muted" title="A run that selects no tests does not pass">
                  <input
                    type="checkbox"
                    checked={c().expectTests}
                    onChange={(e) => setLoopCheck(i, { expectTests: e.currentTarget.checked })}
                    disabled={busy()}
                    aria-label={`Acceptance check ${i + 1} is a test run`}
                  />
                  test run
                </label>
                <Show when={form().loop.checks.length > 1}>
                  <button
                    type="button"
                    class="text-[11px] text-fg-faint hover:text-danger"
                    aria-label={`Remove acceptance check ${i + 1}`}
                    disabled={busy()}
                    onClick={() => setLoop({ checks: form().loop.checks.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </Show>
              </div>
            )}
          </Index>
          <Show when={form().loop.checks.length < ROUTINE_LOOP_CHECKS_MAX}>
            <button
              type="button"
              class="self-start text-[11px] text-accent underline-offset-2 hover:underline"
              disabled={busy()}
              onClick={() => setLoop({ checks: [...form().loop.checks, emptyCheckRow()] })}
            >
              + Add check
            </button>
          </Show>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <NumberField label="Attempts" value={form().loop.attempts} placeholder={String(ROUTINE_LOOP_DEFAULTS.attempts)} disabled={busy()} onInput={(v) => setLoop({ attempts: v })} />
            <NumberField label="Minutes per attempt" value={form().loop.attemptMinutes} placeholder={String(ROUTINE_LOOP_DEFAULTS.attemptMinutes)} disabled={busy()} onInput={(v) => setLoop({ attemptMinutes: v })} />
            <NumberField label="Minutes per loop run" value={form().loop.runMinutes} placeholder={String(ROUTINE_LOOP_DEFAULTS.runMinutes)} disabled={busy()} onInput={(v) => setLoop({ runMinutes: v })} />
            <NumberField label="Tool calls per attempt" value={form().loop.toolBudget} placeholder={String(ROUTINE_LOOP_DEFAULTS.toolBudget)} disabled={busy()} onInput={(v) => setLoop({ toolBudget: v })} />
          </div>
          <FieldNote error={error()} field="loop" />
          <p class="text-[10px] text-fg-faint">
            Blank uses the default shown. A fire while this routine's last loop run is still going is skipped, and so is one when you already have
            three loop runs in progress. Loops run on the Claude backend for now.
          </p>
        </fieldset>
      </Show>
      <div class="flex flex-col gap-1">
        <span class={labelClass}>{isLoop() ? "Spend" : "Limits"}</span>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Show when={!isLoop()}>
            <NumberField label="Tool calls" value={form().toolBudget} placeholder={String(ROUTINE_DEFAULTS.toolBudget)} disabled={busy() || form().approvals === "guarded"} invalid={invalid("toolBudget")} onInput={(v) => set("toolBudget", v)} />
            <NumberField label="Minutes per run" value={form().maxMinutes} placeholder={String(ROUTINE_DEFAULTS.maxMinutes)} disabled={busy()} invalid={invalid("maxMinutes")} onInput={(v) => set("maxMinutes", v)} />
          </Show>
          <NumberField
            label="USD per run"
            value={form().maxCostUsd}
            placeholder={isLoop() ? "n/a" : "none"}
            disabled={busy() || (isLoop() && !form().maxCostUsd)}
            invalid={invalid("maxCostUsd")}
            onInput={(v) => set("maxCostUsd", v)}
          />
          <NumberField label="USD per day" value={form().dailyCostUsd} placeholder="none" disabled={busy()} invalid={invalid("dailyCostUsd")} onInput={(v) => set("dailyCostUsd", v)} />
        </div>
        <FieldNote error={error()} field="maxCostUsd" />
        <p class="text-[10px] text-fg-faint">
          {isLoop()
            ? `${LOOP_ROUTINE_REFUSES.maxCostUsd} ${LOOP_ROUTINE_REFUSES.sessionLimits}`
            : "Blank uses the default shown. The per-run spend limit is a hard stop on Claude; elsewhere a run past it is marked over budget."}
        </p>
      </div>

      {/* Everything else. */}
      <details class="rounded border border-border bg-bg/30 px-3 py-2">
        <summary class="cursor-pointer text-[12px] text-fg-muted">More options: session, overlap, notifications, API, backend</summary>
        <div class="mt-3 flex flex-col gap-3">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Select
              label="Session"
              value={isLoop() ? "fresh" : form().session}
              disabled={busy() || isLoop()}
              title={isLoop() ? LOOP_ROUTINE_REFUSES.session : undefined}
              onChange={(v) => set("session", v as FormState["session"])}
              options={[["fresh", "fresh each run"], ["persistent", "one persistent"]]}
            />
            <Select
              label="Overlap"
              value={isLoop() ? "skip" : form().overlap}
              disabled={busy() || isLoop()}
              title={isLoop() ? LOOP_ROUTINE_REFUSES.overlap : undefined}
              onChange={(v) => set("overlap", v as FormState["overlap"])}
              options={[["skip", "skip a fire while running"], ["queue", "queue one behind"]]}
            />
            <Select label="Notify" value={form().notify} disabled={busy()} onChange={(v) => set("notify", v as FormState["notify"])} options={[["on_change", "on outcomes worth reading"], ["always", "always"], ["never", "never"]]} />
            <NumberField label="Jitter seconds" value={form().jitterSeconds} placeholder="0" disabled={busy()} invalid={invalid("jitterSeconds")} onInput={(v) => set("jitterSeconds", v)} />
            <Show when={!isLoop()}>
              <NumberField label="Sessions kept" value={form().keepSessions} placeholder={String(ROUTINE_DEFAULTS.keepSessions)} disabled={busy()} invalid={invalid("keepSessions")} onInput={(v) => set("keepSessions", v)} />
            </Show>
            <NumberField label="Pause after failures" value={form().failurePauseAfter} placeholder={String(ROUTINE_DEFAULTS.failurePauseAfter)} disabled={busy()} invalid={invalid("failurePauseAfter")} onInput={(v) => set("failurePauseAfter", v)} />
          </div>
          <Show when={isLoop()}>
            <p class="text-[11px] text-fg-muted">
              {LOOP_ROUTINE_REFUSES.session} {LOOP_ROUTINE_REFUSES.overlap} {LOOP_ROUTINE_REFUSES.worktree}
            </p>
          </Show>
          <Show when={!isLoop()}>
            <Check label="Its own git worktree per run" hint="Runs never touch your checkout." checked={form().worktree} disabled={busy()} onChange={(v) => set("worktree", v)} />
          </Show>
          <Check label="Catch up after downtime" hint="Run once for fires missed while the daemon was down; otherwise they're recorded as skipped." checked={form().catchUp} disabled={busy()} onChange={(v) => set("catchUp", v)} />
          <Check
            label="API trigger"
            hint="Something outside codeoid can fire it with its own token, shown once when you save. 30 fires an hour."
            checked={form().api}
            disabled={busy()}
            onChange={(v) => set("api", v)}
          />
          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-[10px] text-fg-muted">Backend</span>
              <select
                value={form().provider}
                onChange={(e) => set("provider", e.currentTarget.value)}
                class={inputClass}
                disabled={busy()}
                aria-label="Backend"
                aria-invalid={invalid("provider")}
              >
                <option value="">daemon default</option>
                <For each={props.providers}>{(p) => <option value={p.id}>{p.label}</option>}</For>
              </select>
              <Show when={isLoop()}>
                <span class="text-[10px] text-fg-faint">{LOOP_ROUTINE_REFUSES.provider}</span>
              </Show>
            </label>
            <label class="flex flex-col gap-0.5">
              <span class="text-[10px] text-fg-muted">Model</span>
              <input type="text" value={form().model} onInput={(e) => set("model", e.currentTarget.value)} class={inputClass} disabled={busy()} aria-label="Model" placeholder="backend default" />
            </label>
          </div>
        </div>
      </details>

      <Show when={warnings().length > 0}>
        <ul class="flex flex-col gap-1" data-testid="routine-warnings">
          <For each={warnings()}>
            {(w) => <li class="rounded border border-warn/40 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">{w}</li>}
          </For>
        </ul>
      </Show>

      <ErrorBox error={error()?.error} testid="routine-form-error" />

      <div class="flex flex-wrap items-center justify-end gap-2">
        <Show when={busy()}>
          <span class="mr-auto text-[11px] text-fg-faint" aria-live="polite">
            Saving…
          </span>
        </Show>
        <button type="button" class={quietBtn} onClick={() => props.onCancel()}>
          Back
        </button>
        <button type="submit" class={`${primaryBtn} px-3 py-1.5 font-semibold`} disabled={busy() || (editing() && changedCount() === 0)}>
          {editing() ? (changedCount() > 0 ? `Save ${changedCount()} change${changedCount() === 1 ? "" : "s"}` : "No changes") : "Create routine"}
        </button>
      </div>
    </form>
  );
};

const SchedulePreview: Component<{
  preview: { fires: string[] } | { error: string } | { loading: true } | null;
  now: number;
  /** The schedule in words. */
  words: string | null;
}> = (props) => (
  <Show when={props.preview}>
    {(p) => (
      <div class="rounded border border-border bg-bg/30 px-3 py-1.5 text-[11px]" data-testid="routine-preview" aria-live="polite">
        <Show when={"fires" in p() ? (p() as { fires: string[] }) : null}>
          {(ok) => (
            <>
              <Show when={props.words}>
                <span class="text-fg-muted">{props.words}</span>
              </Show>
              <span class="text-fg-faint"> · next: </span>
              <For each={ok().fires}>
                {(at, i) => (
                  <>
                    {i() > 0 ? <span class="text-fg-faint">, </span> : null}
                    <time class="font-mono text-fg" dateTime={at} title={absoluteTime(at)}>
                      {absoluteTime(at)} <span class="text-fg-faint">({relativeWhen(at, props.now)})</span>
                    </time>
                  </>
                )}
              </For>
              <Show when={ok().fires.length === 0}>
                <span class="text-fg-muted">no fires</span>
              </Show>
            </>
          )}
        </Show>
        <Show when={"error" in p() ? (p() as { error: string }).error : null}>
          {(msg) => (
            <span class="text-danger" role="alert">
              {msg()}
            </span>
          )}
        </Show>
        <Show when={"loading" in p()}>
          <span class="text-fg-faint">checking the schedule…</span>
        </Show>
      </div>
    )}
  </Show>
);

const Field: Component<{ label: string; error: { error: string; field: string | null } | null; field: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-col gap-1">
    <span class={labelClass}>{props.label}</span>
    {props.children}
    <Show when={props.error?.field === props.field}>
      <span class="text-[11px] text-danger">{props.error!.error}</span>
    </Show>
  </div>
);

const NumberField: Component<{ label: string; value: string; placeholder: string; disabled: boolean; invalid?: "true"; onInput: (v: string) => void }> = (props) => (
  <label class="flex flex-col gap-0.5">
    <span class="text-[10px] text-fg-muted">{props.label}</span>
    <input
      type="text"
      inputmode="decimal"
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      class={inputClass}
      disabled={props.disabled}
      aria-label={props.label}
      aria-invalid={props.invalid}
      placeholder={props.placeholder}
    />
  </label>
);

const FieldNote: Component<{ error: { error: string; field: string | null } | null; field: string }> = (props) => (
  <Show when={props.error?.field === props.field}>
    <span class="text-[11px] text-danger">{props.error!.error}</span>
  </Show>
);

const Select: Component<{ label: string; value: string; disabled: boolean; title?: string; options: [string, string][]; onChange: (v: string) => void }> = (props) => (
  <label class="flex flex-col gap-0.5" title={props.title}>
    <span class="text-[10px] text-fg-muted">{props.label}</span>
    <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)} class={inputClass} disabled={props.disabled} aria-label={props.label}>
      <For each={props.options}>{([v, l]) => <option value={v}>{l}</option>}</For>
    </select>
  </label>
);

const Check: Component<{ label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }> = (props) => (
  <label class="flex items-start gap-2 text-[12px] text-fg">
    <input type="checkbox" class="mt-0.5" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} />
    <span>
      {props.label}
      <span class="block text-[11px] text-fg-muted">{props.hint}</span>
    </span>
  </label>
);

export default RoutineForm;
