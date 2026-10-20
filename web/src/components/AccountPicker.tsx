/**
 * The Claude account a session runs on (claude-accounts.ts), switchable from
 * the session controls bar. Shown once named accounts exist. A switch takes
 * effect on the next turn and resumes the same conversation on the new
 * credential. Choosing an account needs `settings:write`; a token without it
 * gets the daemon's refusal in the menu.
 */

import { type Component, For, Show, createSignal } from "solid-js";

import {
  claudeAccountsState,
  DEFAULT_ACCOUNT,
  fetchClaudeAccounts,
  isMissingAccount,
  setSessionClaudeAccount,
} from "../state/claude-accounts";
import { useDismissable } from "../lib/dismissable";

export const AccountPicker: Component<{
  sessionId: string;
  /** The session's own choice; undefined = it follows the daemon default. */
  chosen?: string;
  /** What it runs on next, as the daemon resolved it (`<name> (missing)` when gone). */
  effective?: string;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));

  // Load once so the picker knows whether there is anything to switch to.
  void fetchClaudeAccounts();

  const accounts = () => claudeAccountsState().accounts;
  const missing = () => isMissingAccount(props.effective);
  const label = () => props.effective ?? props.chosen ?? DEFAULT_ACCOUNT;

  const choose = (account: string | null) => {
    if (busy()) return;
    if (account === (props.chosen ?? null)) {
      setOpen(false);
      return;
    }
    setError(null);
    setBusy(true);
    setSessionClaudeAccount(props.sessionId, account)
      .then(() => setOpen(false))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  type Row = { value: string | null; title: string; detail: string };
  const rows = (): Row[] => [
    { value: null, title: "Follow daemon default", detail: claudeAccountsState().defaultAccount },
    { value: DEFAULT_ACCOUNT, title: DEFAULT_ACCOUNT, detail: "the daemon's own login" },
    ...accounts().map((a) => ({
      value: a.name,
      title: a.name,
      detail: a.kind === "gateway" ? (a.baseUrl ?? "gateway") : a.kind === "api-key" ? "API key" : "subscription",
    })),
  ];

  return (
    // Hidden until there's something to choose — unless the session points at
    // a removed account, which the user must see to fix.
    <Show when={accounts().length > 0 || missing()}>
      <div class="relative" ref={rootEl}>
        <button
          type="button"
          onClick={() => {
            setOpen(!open());
            setError(null);
          }}
          class={`flex items-center gap-1 rounded border bg-bg px-2 py-1 font-mono uppercase tracking-wider hover:border-accent/40 hover:text-fg ${
            missing() ? "border-danger/60 text-danger" : "border-border text-fg-muted"
          }`}
          title={missing() ? "This session's Claude account was removed — pick another" : "Switch this session's Claude account"}
        >
          account <span class={missing() ? "" : "text-fg"}>{label()}</span>
          <Show when={props.chosen === undefined}>
            <span class="normal-case text-fg-faint">(default)</span>
          </Show>{" "}
          ▾
        </button>
        <Show when={open()}>
          <div class="absolute right-0 top-full z-30 mt-1 w-72 rounded border border-border bg-bg-elev shadow-xl">
            <For each={rows()}>
              {(row) => {
                const current = () => row.value === (props.chosen ?? null);
                return (
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() => choose(row.value)}
                    class={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-bg-hover disabled:opacity-50 ${
                      current() ? "bg-bg-active text-fg" : "text-fg-muted"
                    }`}
                  >
                    <span class="truncate">
                      <span class="font-mono">{row.title}</span>
                      <span class="ml-2 text-[11px] text-fg-faint">{row.detail}</span>
                    </span>
                    <Show when={current()}>
                      <span class="text-accent">●</span>
                    </Show>
                  </button>
                );
              }}
            </For>
            <Show when={error()}>
              <div role="alert" class="border-t border-danger/40 px-3 py-1.5 text-[11px] text-danger">
                {error()}
              </div>
            </Show>
            <div class="border-t border-border px-3 py-1.5 text-[10px] text-fg-faint">
              From the next turn; the conversation carries on. The first turn on a new account re-reads the context at full price.
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
};