/**
 * Sign-in surface — shown when no API key is remembered, or when bootstrap
 * failed because the saved key is invalid / expired. Trades the user's
 * ZeroID API key (`zid_sk_…`) for a daemon JWT via ZeroID's
 * `/oauth2/token` endpoint.
 *
 * The advanced section lets the user override the ZeroID URL (for staging
 * / dev environments). The daemon URL stays implicit — it's read from
 * VITE_CODEOID_URL on bootstrap.
 */

import { Component, Show, createSignal, onMount } from "solid-js";

import {
  fetchOAuthProvider,
  registerWebAgent,
  rememberApiKey,
  rememberedApiKey,
  startOAuthLogin,
} from "../lib/auth";
import { bootstrap, bootstrapError } from "../state/connection";

const SignIn: Component<{ onSignedIn: () => void }> = (props) => {
  const [apiKey, setApiKey] = createSignal(rememberedApiKey() ?? "");
  const [busy, setBusy] = createSignal(false);
  const [registerError, setRegisterError] = createSignal<string | null>(null);
  const [advanced, setAdvanced] = createSignal(false);
  const [zeroidUrl, setZeroidUrl] = createSignal(
    (import.meta.env.VITE_ZEROID_URL as string | undefined) ?? "http://localhost:8899",
  );
  const [oauthProvider, setOauthProvider] = createSignal<"google" | null>(null);

  onMount(() => {
    void fetchOAuthProvider().then(setOauthProvider);
  });

  async function submit(ev: Event): Promise<void> {
    ev.preventDefault();
    if (busy()) return;
    const key = apiKey().trim();
    if (!key) return;
    setBusy(true);
    try {
      rememberApiKey(key);
      await bootstrap({ apiKey: key });
      props.onSignedIn();
    } catch {
      // bootstrapError signal carries the message — the form below renders it.
    } finally {
      setBusy(false);
    }
  }

  function signInWithGoogle(): void {
    if (busy()) return;
    setBusy(true);
    startOAuthLogin(); // redirects — page unloads, no cleanup needed
  }

  async function registerAndSignIn(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setRegisterError(null);
    try {
      const { apiKey: minted } = await registerWebAgent();
      rememberApiKey(minted);
      setApiKey(minted);
      await bootstrap({ apiKey: minted });
      props.onSignedIn();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex h-full items-center justify-center bg-bg p-8">
      <form
        onSubmit={submit}
        class="w-full max-w-md space-y-5 rounded-lg border border-border bg-bg-elev p-7 shadow-2xl"
      >
        <header class="space-y-1">
          <h1 class="text-xl font-semibold tracking-tight text-fg">Codeoid</h1>
          <p class="text-sm text-fg-muted">
            Sign in with your ZeroID API key to connect to the daemon.
          </p>
        </header>

        <Show when={oauthProvider() === "google"}>
          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={busy()}
            class="flex w-full items-center justify-center gap-2.5 rounded border border-border bg-bg px-3 py-2 text-sm font-medium text-fg transition hover:border-accent/40 hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GoogleIcon />
            Sign in with Google
          </button>
          <div class="flex items-center gap-3 text-[11px] text-fg-faint">
            <span class="h-px flex-1 bg-border" />
            <span>or use API key</span>
            <span class="h-px flex-1 bg-border" />
          </div>
        </Show>

        <label class="block space-y-1.5">
          <span class="text-xs font-medium uppercase tracking-wider text-fg-faint">
            ZeroID API key
          </span>
          <input
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder="zid_sk_…"
            value={apiKey()}
            onInput={(e) => setApiKey(e.currentTarget.value)}
            class="w-full rounded border border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            disabled={busy()}
          />
          {/*
            A loopback local-mode daemon injects its token and this screen never
            renders. It IS reached when the daemon runs `--local` on a wide bind
            (where injecting into the HTML would hand control to anyone who can
            reach the port), so name the paste-it path rather than leaving the
            operator staring at a ZeroID-only prompt.
          */}
          <span class="block text-[11px] text-fg-faint">
            No account? Start the daemon with <code class="font-mono">codeoid start --local</code>{" "}
            and paste its <code class="font-mono">codeoid_local_…</code> token here.
          </span>
        </label>

        <button
          type="button"
          class="text-xs text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
          onClick={() => setAdvanced(!advanced())}
        >
          {advanced() ? "Hide advanced" : "Advanced"}
        </button>

        <Show when={advanced()}>
          <label class="block space-y-1.5">
            <span class="text-xs font-medium uppercase tracking-wider text-fg-faint">
              ZeroID URL
            </span>
            <input
              type="text"
              spellcheck={false}
              value={zeroidUrl()}
              onInput={(e) => setZeroidUrl(e.currentTarget.value)}
              class="w-full rounded border border-border bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
              disabled={busy()}
            />
            <p class="text-[11px] text-fg-faint">
              Note: change requires a page reload (set VITE_ZEROID_URL at build time).
            </p>
          </label>
        </Show>

        <Show when={bootstrapError()}>
          <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {bootstrapError()}
          </div>
        </Show>

        <button
          type="submit"
          disabled={busy() || !apiKey().trim()}
          class="w-full rounded bg-accent px-3 py-2 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy() ? "Connecting…" : "Sign in"}
        </button>

        <div class="flex items-center gap-3 text-[11px] text-fg-faint">
          <span class="h-px flex-1 bg-border" />
          <span>or</span>
          <span class="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          onClick={registerAndSignIn}
          disabled={busy()}
          class="w-full rounded border border-border bg-bg px-3 py-2 text-sm font-medium text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          title="Mint a new ZeroID agent identity named codeoid-web and sign in"
        >
          {busy() ? "…" : "Register a new web agent"}
        </button>

        <Show when={registerError()}>
          <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {registerError()}
          </div>
        </Show>

        <p class="text-[11px] text-fg-faint">
          Your key is stored locally in your browser only — never sent anywhere except
          to ZeroID for token exchange.
        </p>
      </form>
    </div>
  );
};

const GoogleIcon: Component = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.83z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.83c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />
  </svg>
);

export default SignIn;
