/**
 * Sign a backend in as a NAMED account (accounts.ts, backend-login.ts): the
 * daemon runs the vendor's own login command against a staging home (never
 * the machine's own login), shows its link, and stores what it produces under
 * the name.
 *
 * Two shapes, from the login's `mode`:
 *   code   (Claude, Gemini CLI) — open the link, paste back the code the page shows.
 *   device (Codex) — open the link, enter the one-time code shown here; the
 *          daemon notices the approval on its own, so this only waits.
 *
 * A pasted code goes straight to the daemon and is never kept.
 */

import { type Component, Show, createSignal, onCleanup } from "solid-js";

import { ReplaceAccountConfirm } from "./ReplaceAccountConfirm";
import {
  accountLoginState,
  cancelAccountLogin,
  dismissAccountLogin,
  newAccountNameProblem,
  startAccountLogin,
  submitAccountLoginCode,
} from "../state/accounts";
import type { AccountKindInfo, LoginBackend } from "../protocol/types";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

/** The vendor link, as a link and as copyable text — the browser is often on another machine. */
const LoginLink: Component<{ url: string }> = (props) => (
  <div class="flex items-center gap-2">
    <a
      href={props.url}
      target="_blank"
      rel="noopener noreferrer"
      class="block min-w-0 flex-1 break-all rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-accent hover:underline"
    >
      {props.url}
    </a>
    <button
      type="button"
      class={button}
      onClick={() => void navigator.clipboard?.writeText(props.url)}
      title="Copy the link — useful when your browser is on another machine"
    >
      Copy
    </button>
  </div>
);

export const AccountSignIn: Component<{
  backend: LoginBackend;
  /** The backend's display name, for the copy. */
  displayName: string;
  kind: AccountKindInfo;
  onDone: () => void;
}> = (props) => {
  const [name, setName] = createSignal("");
  const [code, setCode] = createSignal("");
  const [replace, setReplace] = createSignal(false);
  const st = accountLoginState;
  const problem = () => newAccountNameProblem(props.backend, name().trim(), replace());

  const start = async () => {
    // A device login resolves only once it has finished (or failed).
    if (await startAccountLogin(props.backend, name().trim(), replace())) props.onDone();
  };

  const close = () => {
    void cancelAccountLogin();
    dismissAccountLogin();
    props.onDone();
  };

  // Closed some other way (the drawer, another tab of Settings): end the
  // daemon's attempt too, or reopening would show its stale link. A finished
  // sign-in is already back to idle, so it sends no cancel.
  onCleanup(() => {
    if (st().phase !== "idle") void cancelAccountLogin();
    dismissAccountLogin();
  });

  return (
    <div class="space-y-3">
      <div class="text-[13px] font-medium text-fg">
        Sign in — {props.displayName} {props.kind.label}
      </div>
      <Show when={st().phase === "idle" || st().phase === "starting"}>
        <label class="block space-y-1">
          <span class={label}>Account name</span>
          <input
            class={input}
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value);
              setReplace(false);
            }}
            placeholder="company-max"
            autocomplete="off"
          />
        </label>
        <ReplaceAccountConfirm backend={props.backend} name={name().trim()} checked={replace()} onChange={setReplace} />
        <p class="text-[11px] text-fg-faint">
          You'll get a link: open it in a browser signed in to the account you want under this name. The daemon's own{" "}
          {props.displayName} login is not touched.
          <Show when={props.kind.hint}> {props.kind.hint}</Show>
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class={button}
            disabled={!!problem() || st().phase === "starting"}
            title={problem() ?? ""}
            onClick={() => void start()}
          >
            {st().phase === "starting" ? "Starting…" : "Get sign-in link"}
          </button>
          <button type="button" class={button} onClick={close}>
            Cancel
          </button>
          <Show when={problem() && name()}>
            <span class="self-center text-[11px] text-fg-faint">{problem()}</span>
          </Show>
        </div>
      </Show>

      <Show when={(st().phase === "awaiting_code" || st().phase === "submitting") && st().login}>
        {(login) => (
          <div class="space-y-2">
            <p class="text-[12px] text-fg-muted">
              Open this link signed in to the account you want as <span class="font-mono text-fg">{st().account}</span>:
            </p>
            <LoginLink url={login().verificationUrl} />
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
                aria-label="Sign-in code"
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value)}
                autocomplete="new-password"
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

      <Show when={st().phase === "waiting" && st().login}>
        {(login) => (
          <div class="space-y-2">
            <p class="text-[12px] text-fg-muted">
              Open this link signed in to the account you want as <span class="font-mono text-fg">{st().account}</span>, and enter
              this code:
            </p>
            <Show when={login().userCode}>
              {(userCode) => (
                <div class="flex items-center gap-3">
                  <span
                    data-testid="device-user-code"
                    class="select-all rounded border border-accent/50 bg-accent/10 px-3 py-1.5 font-mono text-xl tracking-[0.2em] text-accent"
                  >
                    {userCode()}
                  </span>
                  <button type="button" class={button} onClick={() => void navigator.clipboard?.writeText(userCode())}>
                    Copy code
                  </button>
                </div>
              )}
            </Show>
            <LoginLink url={login().verificationUrl} />
            <p class="text-[11px] text-fg-faint">{login().codeHint}</p>
            <div class="flex items-center gap-2">
              <span class="text-[12px] text-fg-muted" role="status">
                {st().reconnecting
                  ? "Connection lost — reconnecting… The sign-in carries on; you can still approve it."
                  : "Waiting for you to approve…"}
              </span>
              <button type="button" class={button} onClick={close}>
                Cancel
              </button>
            </div>
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
