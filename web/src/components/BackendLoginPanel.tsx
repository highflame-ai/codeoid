/**
 * "Sign in with <backend>" — the settings-drawer face of the interactive login.
 *
 * Rendered above a backend tab's fields, because signing in is the thing most
 * people want and pasting a key is the fallback. The panel walks the two steps
 * the flow actually has, and never shows more than one of them at a time:
 *
 *   idle          → a button, plus whatever the last attempt failed with
 *   awaiting_code → the vendor URL to open, and a box for the code it hands back
 *   done          → confirmation, with the honest caveat about when it applies
 *
 * The URL opens in a new tab AND is shown as copyable text: this daemon is
 * often not on the machine holding the browser (a sandbox, a phone), and in
 * that case the link is something the user carries across rather than clicks.
 */

import { type Component, Show, createSignal } from "solid-js";

import {
  backendLoginState,
  cancelBackendLogin,
  dismissBackendLogin,
  startBackendLogin,
  submitBackendLoginCode,
} from "../state/backend-login";
import { settingsState } from "../state/settings";
import type { LoginBackend } from "../protocol/types";

/** Which secret a completed sign-in fills in, per backend. */
const CREDENTIAL_KEY: Record<LoginBackend, string> = {
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
};

const LABEL: Record<LoginBackend, string> = {
  claude: "Claude",
};

export const BackendLoginPanel: Component<{ backend: LoginBackend }> = (props) => {
  const [code, setCode] = createSignal("");
  const st = () => backendLoginState();
  const mine = () => st().backend === props.backend;
  const phase = () => (mine() ? st().phase : "idle");
  const signedIn = () =>
    settingsState().snapshot?.secrets[CREDENTIAL_KEY[props.backend]]?.set === true;

  const submit = async () => {
    const value = code().trim();
    if (value.length === 0) return;
    const ok = await submitBackendLoginCode(value);
    // Clear either way: on success it is spent, on failure the attempt is over
    // and a stale code in the box only invites resubmitting it.
    setCode("");
    if (!ok) return;
  };

  return (
    <section class="mb-5 rounded border border-border bg-bg-subtle/40 p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h4 class="text-[12px] font-semibold text-fg">Sign in with {LABEL[props.backend]}</h4>
          <p class="mt-0.5 text-[11px] text-fg-muted">
            Use your {LABEL[props.backend]} subscription instead of an API key. codeoid runs the
            official sign-in for you — you approve it in your own browser.
          </p>
        </div>
        <Show when={signedIn()}>
          <span class="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
            signed in
          </span>
        </Show>
      </div>

      <Show when={phase() === "idle"}>
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="rounded border border-accent/40 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10"
            onClick={() => void startBackendLogin(props.backend)}
          >
            {signedIn() ? "Sign in again" : `Sign in with ${LABEL[props.backend]}`}
          </button>
          <Show when={mine() && st().error}>
            <span class="text-[11px] text-danger">{st().error}</span>
          </Show>
        </div>
      </Show>

      <Show when={phase() === "starting"}>
        <p class="mt-2 text-[11px] text-fg-faint">
          Starting the {LABEL[props.backend]} sign-in… this can take a few seconds.
        </p>
      </Show>

      <Show when={mine() && st().login} keyed>
        {(login) => (
          <div class="mt-3 flex flex-col gap-2">
            <div>
              <div class="text-[11px] font-semibold text-fg">1 · Open this link and approve</div>
              <div class="mt-1 flex items-center gap-2">
                <a
                  href={login.verificationUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  class="truncate text-[11px] text-accent underline"
                  title={login.verificationUrl}
                >
                  {login.verificationUrl}
                </a>
                <button
                  type="button"
                  class="shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-fg-muted hover:text-fg"
                  onClick={() => void navigator.clipboard?.writeText(login.verificationUrl)}
                  title="Copy the link — useful when your browser is on another machine"
                >
                  Copy
                </button>
              </div>
            </div>

            <div>
              <div class="text-[11px] font-semibold text-fg">2 · Paste the code back here</div>
              <p class="mt-0.5 text-[11px] text-fg-muted">{login.codeHint}</p>
              <div class="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg"
                  placeholder="paste the code"
                  value={code()}
                  disabled={phase() === "submitting"}
                  onInput={(e) => setCode(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                />
                <button
                  type="button"
                  class="shrink-0 rounded border border-accent/40 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
                  disabled={phase() === "submitting" || code().trim().length === 0}
                  onClick={() => void submit()}
                >
                  {phase() === "submitting" ? "Signing in…" : "Finish sign-in"}
                </button>
                <button
                  type="button"
                  class="shrink-0 text-[11px] text-fg-faint hover:text-fg"
                  onClick={() => {
                    setCode("");
                    void cancelBackendLogin();
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={phase() === "done"}>
        <div class="mt-2 flex items-center gap-2 text-[11px]">
          <span class="text-success">Signed in.</span>
          {/* Honest about when it bites: existing sessions keep the environment
              they were started with. */}
          <span class="text-fg-muted">New sessions will use it.</span>
          <button
            type="button"
            class="text-fg-faint hover:text-fg"
            onClick={() => dismissBackendLogin()}
          >
            Dismiss
          </button>
        </div>
      </Show>
    </section>
  );
};
