/**
 * Make a loop watch (docs/loops.md "Watches"): the repository, what to watch
 * (named branches or your open pull requests), which CI checks start a run and
 * the local command that reproduces each, review comments, who besides you
 * it trusts, and how many runs an hour it may start.
 *
 * The form checks what it can know (`buildWatchCreate`); the daemon reads the
 * repository's origin and gh's login, and its words are shown as they come.
 */

import { Component, For, Index, JSX, Show, createSignal } from "solid-js";

import { REFUSED_TRUST, WATCH_DEFAULTS, buildWatchCreate, emptyCiRow, emptyWatchForm, type CiRow, type WatchForm as FormState } from "../../lib/watches";
import type { LoopWatchCreateMsg } from "../../protocol/types";
import { ErrorBox, WorkdirField, inputClass, labelClass, linkBtn, primaryBtn, quietBtn } from "./common";

const CI_MAX = 10;

export interface WatchFormProps {
  recentWorkdirs: string[];
  providers: { id: string; label: string }[];
  /** Rejects with the daemon's words. */
  onSubmit: (body: Omit<LoopWatchCreateMsg, "id">) => Promise<void>;
  onCancel: () => void;
}

export const WatchForm: Component<WatchFormProps> = (props) => {
  const [form, setForm] = createSignal<FormState>(emptyWatchForm());
  const [error, setError] = createSignal<{ error: string; field: string | null } | null>(null);
  const [busy, setBusy] = createSignal(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setCi = (i: number, patch: Partial<CiRow>) => setForm((f) => ({ ...f, ci: f.ci.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const invalid = (field: string) => (error()?.field === field ? "true" : undefined);

  const submit = async (e: Event) => {
    e.preventDefault();
    const built = buildWatchCreate(form());
    if ("error" in built) return setError(built);
    setError(null);
    setBusy(true);
    try {
      await props.onSubmit(built.msg);
    } catch (err) {
      setError({ error: err instanceof Error ? err.message : String(err), field: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="flex flex-col gap-4" onSubmit={(e) => void submit(e)} data-testid="watch-form" noValidate>
      <h3 class="text-[13px] font-semibold text-fg">New watch</h3>
      <p class="text-[12px] leading-relaxed text-fg-muted">
        A watch starts repair runs for you from GitHub: a mapped CI check that failed on a head you watch, or a review comment asking codeoid for a
        change. It reads GitHub as the account gh is signed in to, and <strong class="text-fg">runs a head's code only when you, or someone you
        trust, pushed or merged it</strong>.
      </p>

      <WorkdirField
        label="Repository"
        value={form().workdir}
        recent={props.recentWorkdirs}
        disabled={busy()}
        invalid={!!invalid("workdir")}
        hint="Its origin remote must be on github.com; the repository is read from it now and can't change later."
        onInput={(v) => set("workdir", v)}
      />

      <fieldset class="flex flex-col gap-1.5">
        <legend class={`${labelClass} mb-1`}>Watch</legend>
        <label class="flex items-start gap-2 text-[12px] text-fg">
          <input type="radio" name="watch-target" class="mt-0.5" checked={form().target === "my_prs"} onChange={() => set("target", "my_prs")} disabled={busy()} />
          <span>
            My open pull requests
            <span class="block text-[11px] text-fg-muted">The heads of your newest 30 open pull requests, judged by who pushed them.</span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-[12px] text-fg">
          <input type="radio" name="watch-target" class="mt-0.5" checked={form().target === "branches"} onChange={() => set("target", "branches")} disabled={busy()} />
          <span>
            Named branches
            <span class="block text-[11px] text-fg-muted">Each branch's head. List everyone who merges to it under Trust, below.</span>
          </span>
        </label>
        <Show when={form().target === "branches"}>
          <input
            type="text"
            autocomplete="off"
            spellcheck={false}
            value={form().branches}
            onInput={(e) => set("branches", e.currentTarget.value)}
            class={inputClass}
            disabled={busy()}
            aria-label="Branches"
            aria-invalid={invalid("branches")}
            placeholder="main, release"
          />
          <FieldError error={error()} field="branches" />
        </Show>
      </fieldset>

      {/* CI mappings. */}
      <div class="flex flex-col gap-1.5">
        <span class={labelClass}>CI checks that start a run</span>
        <p class="text-[10px] text-fg-faint">
          The check's name on GitHub (exact, or a glob with * and ?), the GitHub App that must have reported it (default github-actions), and the
          local command that reproduces it. The mapped commands are the run's checks; a failing check with no mapping starts nothing.
        </p>
        <Index each={form().ci}>
          {(c, i) => (
            <div class="flex flex-col gap-1.5 rounded border border-border bg-bg/30 p-2" data-testid="watch-ci-row">
              <div class="flex flex-wrap gap-1.5">
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={c().ciName}
                  onInput={(e) => setCi(i, { ciName: e.currentTarget.value })}
                  class={`${inputClass} min-w-0 flex-[2]`}
                  disabled={busy()}
                  aria-label={`Mapping ${i + 1} check name`}
                  aria-invalid={invalid("ci")}
                  placeholder="test (*)"
                />
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={c().app}
                  onInput={(e) => setCi(i, { app: e.currentTarget.value })}
                  class={`${inputClass} min-w-0 flex-1`}
                  disabled={busy()}
                  aria-label={`Mapping ${i + 1} app`}
                  placeholder="github-actions"
                />
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[11px] text-fg-faint" aria-hidden="true">
                  →
                </span>
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={c().command}
                  onInput={(e) => setCi(i, { command: e.currentTarget.value })}
                  class={`${inputClass} min-w-0 flex-1`}
                  disabled={busy()}
                  aria-label={`Mapping ${i + 1} command`}
                  placeholder="bun test"
                />
                <input
                  type="text"
                  inputmode="numeric"
                  value={c().timeoutSec}
                  onInput={(e) => setCi(i, { timeoutSec: e.currentTarget.value })}
                  class={`${inputClass} w-20!`}
                  disabled={busy()}
                  aria-label={`Mapping ${i + 1} timeout seconds`}
                  placeholder="600s"
                />
                <label class="flex items-center gap-1 text-[11px] text-fg-muted" title="A run that selects no tests does not pass">
                  <input
                    type="checkbox"
                    checked={c().expectTests}
                    onChange={(e) => setCi(i, { expectTests: e.currentTarget.checked })}
                    disabled={busy()}
                    aria-label={`Mapping ${i + 1} is a test run`}
                  />
                  test run
                </label>
                <Show when={form().ci.length > 1}>
                  <button
                    type="button"
                    class="text-[11px] text-fg-faint hover:text-danger"
                    aria-label={`Remove mapping ${i + 1}`}
                    disabled={busy()}
                    onClick={() => setForm((f) => ({ ...f, ci: f.ci.filter((_, j) => j !== i) }))}
                  >
                    ✕
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Index>
        <FieldError error={error()} field="ci" />
        <Show when={form().ci.length < CI_MAX}>
          <button
            type="button"
            class={`${linkBtn} self-start`}
            disabled={busy()}
            onClick={() => setForm((f) => ({ ...f, ci: [...f.ci, emptyCiRow()] }))}
          >
            + Add mapping
          </button>
        </Show>
      </div>

      {/* Review comments. */}
      <fieldset class="flex flex-col gap-1.5">
        <legend class={`${labelClass} mb-1`}>Review comments</legend>
        <label class="flex items-start gap-2 text-[12px] text-fg">
          <input type="checkbox" class="mt-0.5" checked={form().review} onChange={(e) => set("review", e.currentTarget.checked)} disabled={busy()} />
          <span>
            Start a run from a comment that asks for a change
            <span class="block text-[11px] text-fg-muted">
              On your open pull requests, by an allowed author, made after the watch was made or last resumed. An edited comment is ignored.
            </span>
          </span>
        </label>
        <Show when={form().review}>
          <div class="grid gap-2 sm:grid-cols-[1fr_10rem]">
            <Labeled label="Allowed authors (blank = you)">
              <input
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={form().allow}
                onInput={(e) => set("allow", e.currentTarget.value)}
                class={inputClass}
                disabled={busy()}
                aria-label="Allowed authors"
                aria-invalid={invalid("allow")}
                placeholder="octocat, hubot"
              />
            </Labeled>
            <Labeled label="Mention">
              <input
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={form().mention}
                onInput={(e) => set("mention", e.currentTarget.value)}
                class={inputClass}
                disabled={busy()}
                aria-label="Mention"
                aria-invalid={invalid("mention")}
                placeholder={WATCH_DEFAULTS.mention}
              />
            </Labeled>
          </div>
          <p class="text-[10px] text-fg-faint">An allowed author's comment is an instruction to the agent: allow only people you'd let ask for a change.</p>
          <FieldError error={error()} field="allow" />
          <FieldError error={error()} field="mention" />
        </Show>
      </fieldset>

      {/* Trust. */}
      <div class="flex flex-col gap-1">
        <span class={labelClass}>Also trust (optional)</span>
        <input
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={form().trust}
          onInput={(e) => set("trust", e.currentTarget.value)}
          class={inputClass}
          disabled={busy()}
          aria-label="Trusted logins"
          aria-invalid={invalid("trust")}
          placeholder="teammate, dependabot[bot]"
        />
        <FieldError error={error()} field="trust" />
        <p class="text-[10px] text-fg-faint">
          You (gh's login) are always trusted. Name the others whose pushes and merges a head may come from, up to 20. A bot login trusts anyone who
          can make it push; {REFUSED_TRUST.join(", ")} are refused.
        </p>
      </div>

      <Show when={form().target === "branches"}>
        <label class="flex items-start gap-2 rounded border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] text-fg">
          <input type="checkbox" class="mt-0.5" checked={form().trustHead} onChange={(e) => set("trustHead", e.currentTarget.checked)} disabled={busy()} />
          <span>
            Vouch for each branch's head now
            <span class="block text-[11px] text-fg-muted">
              For a branch that changes only through reviewed merges, when its history begins with someone else's push. Everything on it when the
              daemon reads it is treated as yours, including commits you didn't review. To pin to a commit you looked at, make the watch first,
              then use "Vouch for current head" on it.
            </span>
          </span>
        </label>
      </Show>

      <details class="rounded border border-border bg-bg/30 px-3 py-2">
        <summary class="cursor-pointer text-[12px] text-fg-muted">More options: runs per hour, backend</summary>
        <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Labeled label="Runs per hour">
            <input
              type="text"
              inputmode="numeric"
              value={form().maxRunsPerHour}
              onInput={(e) => set("maxRunsPerHour", e.currentTarget.value)}
              class={inputClass}
              disabled={busy()}
              aria-label="Runs per hour"
              aria-invalid={invalid("maxRunsPerHour")}
              placeholder={String(WATCH_DEFAULTS.maxRunsPerHour)}
            />
          </Labeled>
          <Labeled label="Backend">
            <select value={form().provider} onChange={(e) => set("provider", e.currentTarget.value)} class={inputClass} disabled={busy()} aria-label="Backend">
              <option value="">daemon default</option>
              <For each={props.providers}>{(p) => <option value={p.id}>{p.label}</option>}</For>
            </select>
          </Labeled>
          <Labeled label="Model">
            <input type="text" value={form().model} onInput={(e) => set("model", e.currentTarget.value)} class={inputClass} disabled={busy()} aria-label="Model" placeholder="backend default" />
          </Labeled>
        </div>
        <FieldError error={error()} field="maxRunsPerHour" />
      </details>

      <ErrorBox error={error()?.error} testid="watch-form-error" />

      <div class="flex flex-wrap items-center justify-end gap-2">
        <Show when={busy()}>
          <span class="mr-auto text-[11px] text-fg-faint" aria-live="polite">
            Reading the repository and gh's login…
          </span>
        </Show>
        <button type="button" class={quietBtn} onClick={() => props.onCancel()}>
          Back
        </button>
        <button type="submit" class={`${primaryBtn} px-3 py-1.5 font-semibold`} disabled={busy()}>
          Create watch
        </button>
      </div>
    </form>
  );
};

const Labeled: Component<{ label: string; children: JSX.Element }> = (props) => (
  <label class="flex flex-col gap-0.5">
    <span class="text-[10px] text-fg-muted">{props.label}</span>
    {props.children}
  </label>
);

const FieldError: Component<{ error: { error: string; field: string | null } | null; field: string }> = (props) => (
  <Show when={props.error?.field === props.field}>
    <span class="text-[11px] text-danger">{props.error!.error}</span>
  </Show>
);

export default WatchForm;
