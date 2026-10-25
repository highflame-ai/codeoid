/**
 * Edit a watch's trust list (docs/loops.md "Who a watch trusts"): the logins
 * besides you whose pushes and merges a head may come from.
 *
 * Widening keeps what the watch remembered; narrowing forgets every head it
 * judged trusted and every head you vouched for. The editor says which one a
 * change is before it is saved, and a narrowing takes a confirm — with the
 * option to vouch for the branches' current heads again in the same request
 * (`update --trust … --trust-head`).
 */

import { Component, For, Show, createMemo, createSignal } from "solid-js";

import { REFUSED_TRUST, TRUST_MAX, checkLogin, trustDiff } from "../../lib/watches";
import { ConfirmDialog, ErrorBox, inputClass, labelClass, linkBtn, primaryBtn, quietBtn } from "./common";

export interface TrustEditorProps {
  trust: readonly string[];
  /** The login the watch acts as: always trusted. */
  ghLogin: string | null;
  /** A branch watch can vouch for heads; a "my PRs" watch has none to vouch for. */
  canVouch: boolean;
  /** Rejects with the daemon's words. `vouch`: also send `trustHead: true`. */
  onSave: (trust: string[], vouch: boolean) => Promise<void>;
  onCancel: () => void;
}

export const TrustEditor: Component<TrustEditorProps> = (props) => {
  // Seeded once: a background refresh must not undo an edit in progress.
  // eslint-disable-next-line solid/reactivity
  const [list, setList] = createSignal<string[]>([...props.trust]);
  const [input, setInput] = createSignal("");
  const [inputError, setInputError] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirm, setConfirm] = createSignal(false);
  const [vouch, setVouch] = createSignal(false);

  const diff = createMemo(() => trustDiff(props.trust, list()));
  const changed = () => diff().added.length > 0 || diff().removed.length > 0;

  const add = () => {
    const parts = input().split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...list()];
    for (const part of parts) {
      const c = checkLogin(part, { bots: true });
      if ("error" in c) return setInputError(c.error);
      if (props.ghLogin && c.login.toLowerCase() === props.ghLogin.toLowerCase()) {
        return setInputError(`@${c.login} is you: the watch always trusts the login it acts as`);
      }
      if (!next.some((l) => l.toLowerCase() === c.login.toLowerCase())) next.push(c.login);
    }
    if (next.length > TRUST_MAX) return setInputError(`At most ${TRUST_MAX} trusted logins`);
    setList(next);
    setInput("");
    setInputError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onSave(list(), diff().forgets && vouch());
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex flex-col gap-2 rounded border border-border bg-bg/30 px-3 py-2" data-testid="trust-editor">
      <div class={labelClass}>Trusted besides you{props.ghLogin ? ` (@${props.ghLogin})` : ""}</div>
      <Show when={list().length > 0} fallback={<p class="text-[12px] text-fg-muted">No one: only your own pushes and merges are trusted.</p>}>
        <ul class="flex flex-wrap gap-1.5" aria-label="Trusted logins">
          <For each={list()}>
            {(login) => (
              <li class="flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-fg">
                {login}
                <button
                  type="button"
                  class="text-fg-faint hover:text-danger"
                  aria-label={`Stop trusting ${login}`}
                  disabled={busy()}
                  onClick={() => setList((l) => l.filter((x) => x !== login))}
                >
                  ✕
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="flex gap-1.5">
        <input
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={input()}
          onInput={(e) => {
            setInput(e.currentTarget.value);
            setInputError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          class={`${inputClass} flex-1`}
          disabled={busy()}
          aria-label="Add a trusted login"
          aria-invalid={inputError() ? "true" : undefined}
          placeholder="octocat, dependabot[bot]"
        />
        <button type="button" class={quietBtn} disabled={busy() || !input().trim()} onClick={add}>
          Add
        </button>
      </div>
      <Show when={inputError()}>
        <span class="text-[11px] text-danger" role="alert">
          {inputError()}
        </span>
      </Show>
      <p class="text-[10px] text-fg-faint">
        A bot's login (dependabot[bot]) trusts anyone who can make that bot push. {REFUSED_TRUST.join(", ")} are refused: GitHub acts as them for
        everyone with write access.
      </p>
      <Show when={list().length > 0}>
        <button type="button" class={`${linkBtn} self-start`} disabled={busy()} onClick={() => setList([])}>
          Trust no one but me
        </button>
      </Show>

      <Show when={changed()}>
        <p
          class={`rounded border px-2.5 py-1.5 text-[11px] ${diff().forgets ? "border-warn/50 bg-warn/10 text-warn" : "border-border bg-bg/40 text-fg-muted"}`}
          data-testid="trust-diff"
        >
          {diff().explanation}
        </p>
      </Show>

      <ErrorBox error={confirm() ? null : error()} />

      <div class="flex items-center justify-end gap-2">
        <button type="button" class={quietBtn} disabled={busy()} onClick={() => props.onCancel()}>
          Cancel
        </button>
        <button
          type="button"
          class={primaryBtn}
          disabled={busy() || !changed()}
          onClick={() => (diff().forgets ? setConfirm(true) : void save())}
        >
          {busy() ? "Saving…" : "Save trust list"}
        </button>
      </div>

      <ConfirmDialog
        open={confirm()}
        title="Narrow the trust list?"
        confirmLabel={vouch() ? "Narrow and vouch again" : "Narrow it"}
        danger
        busy={busy()}
        error={error()}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void save()}
      >
        <p>
          You stop trusting <span class="font-mono text-fg">{diff().removed.join(", ")}</span>.
        </p>
        <p>
          The watch <strong class="text-fg">forgets every head it judged trusted and every head you vouched for</strong>, and judges them again under
          the new list. Until a trusted login pushes or you vouch again, a branch whose history includes their work starts no runs.
        </p>
        <Show when={props.canVouch}>
          <label class="flex items-start gap-2 text-[12px]">
            <input type="checkbox" class="mt-0.5" checked={vouch()} onChange={(e) => setVouch(e.currentTarget.checked)} disabled={busy()} />
            <span class="text-fg">
              Also vouch for each watched branch's head as it is now
              <span class="block text-[11px] text-fg-muted">
                Everything on those branches at that moment is then trusted under the new list, including what the dropped logins wrote.
              </span>
            </span>
          </label>
        </Show>
      </ConfirmDialog>
    </div>
  );
};

export default TrustEditor;
