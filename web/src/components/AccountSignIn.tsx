/**
 * Sign a Claude Pro/Max subscription in as a NAMED account: the daemon runs
 * `claude setup-token` against a throwaway config dir (never the machine's own
 * `claude login`), shows its link, and stores the token it mints under the
 * name. The code the user pastes goes straight to the daemon.
 */

import { type Component, Show, createSignal } from "solid-js";

import {
  accountLoginState,
  accountNameProblem,
  cancelAccountLogin,
  dismissAccountLogin,
  startAccountLogin,
  submitAccountLoginCode,
} from "../state/claude-accounts";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

export const AccountSignIn: Component<{ onDone: () => void }> = (props) => {
  const [name, setName] = createSignal("");
  const [code, setCode] = createSignal("");
  const st = accountLoginState;

  const close = () => {
    void cancelAccountLogin();
    dismissAccountLogin();
    props.onDone();
  };

  return (
    <div class="space-y-3">
      <div class="text-[13px] font-medium text-fg">Sign in a Pro/Max subscription</div>
      <Show when={st().phase === "idle" || st().phase === "starting"}>
        <label class="block space-y-1">
          <span class={label}>Account name</span>
          <input
            class={input}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="company-max"
            autocomplete="off"
          />
        </label>
        <p class="text-[11px] text-fg-faint">
          You'll get a link: open it in a browser signed in to the Claude account you want under this name. Your own claude login is
          not touched.
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class={button}
            disabled={!!accountNameProblem(name().trim()) || st().phase === "starting"}
            title={accountNameProblem(name().trim()) ?? ""}
            onClick={() => void startAccountLogin(name().trim())}
          >
            {st().phase === "starting" ? "Starting…" : "Get sign-in link"}
          </button>
          <button type="button" class={button} onClick={close}>
            Cancel
          </button>
        </div>
      </Show>

      <Show when={(st().phase === "awaiting_code" || st().phase === "submitting") && st().login}>
        {(login) => (
          <div class="space-y-2">
            <p class="text-[12px] text-fg-muted">
              Open this link signed in to the account you want as <span class="font-mono text-fg">{st().account}</span>:
            </p>
            <a
              href={login().verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="block break-all rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-accent hover:underline"
            >
              {login().verificationUrl}
            </a>
            <p class="text-[11px] text-fg-faint">{login().codeHint}</p>
            <form
              class="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const c = code().trim();
                if (!c) return;
                const ok = await submitAccountLoginCode(c);
                setCode("");
                if (ok) props.onDone();
              }}
            >
              <input
                class={input}
                type="password"
                placeholder="Paste the code"
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value)}
                autocomplete="off"
              />
              <button type="submit" class={button} disabled={!code().trim() || st().phase === "submitting"}>
                {st().phase === "submitting" ? "Finishing…" : "Finish"}
              </button>
              <button type="button" class={button} onClick={close}>
                Cancel
              </button>
            </form>
          </div>
        )}
      </Show>

      <Show when={st().error}>
        <div role="alert" class="text-[12px] text-danger">
          {st().error}
        </div>
      </Show>
    </div>
  );
};
