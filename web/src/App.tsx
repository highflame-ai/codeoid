/**
 * App entrypoint. Owns the auth gate: while there's no live `auth.ok`
 * from the daemon, render `<SignIn>`; once authenticated, hand off to the
 * three-pane `<Shell>`.
 *
 * Auto-bootstrap behaviour: if a previously-remembered API key exists in
 * localStorage, attempt the connect on mount. The user only sees the
 * sign-in form when there's no key OR the saved key is rejected.
 */

import { Component, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

import { rememberedApiKey, rememberedOAuthToken } from "./lib/auth";
import { consumeHandoffCredential, readEmbedAllowedOrigins } from "./lib/handoff";
import { installEmbedSessionRefresh } from "./lib/embed-refresh";
import SignIn from "./components/SignIn";
import Shell from "./components/Shell";
import {
  authIdentity,
  bootstrap,
  connectionStatus,
  newRequestId,
  send,
  ZEROID_URL,
} from "./state/connection";
import { attachRetryEpoch, attachSession } from "./state/attach";
import { closeFile, openedFile } from "./state/files";
import { focusedSession, focusedSessionId, mergeSession } from "./state/sessions";
import { resumeFor } from "./state/resume";
import type { SessionInfo } from "./protocol/types";
import { resetClaudeConfig } from "./state/claude-config";
import { installApprovalNotifications } from "./state/desktop-notifications";

const App: Component = () => {
  const [tried, setTried] = createSignal(false);

  // Wire desktop-notification watcher once. It self-checks for
  // permission + tab visibility before firing so it stays quiet by
  // default — the `Enable notifications` button in the status bar is
  // what actually requests permission.
  installApprovalNotifications();

  onMount(async () => {
    // Embed SSO: an embedding parent (e.g. Highflame Studio) may pre-authenticate
    // this UI by handing a SHORT-LIVED credential via the URL hash. Consume it
    // FIRST — the helper persists it to storage and strips it from the URL — so
    // it wins over any stale stored credential and never lingers in history.
    // The helper enforces a fail-closed trusted-framing-origin gate against the
    // daemon-published allowlist: it consumes the hash ONLY when this page is
    // embedded by an allowlisted parent origin, closing the login-CSRF vector.
    const allowedOrigins = readEmbedAllowedOrigins();
    const handoff = consumeHandoffCredential({ allowedOrigins });

    const savedKey = rememberedApiKey();
    const savedToken = rememberedOAuthToken();

    // A freshly handed-in credential beats a stored one: a handed-in api key
    // exchanges for a fresh JWT; a handed-in token is used directly. Otherwise
    // fall back to the remembered-cred flow — prefer a stored api key exchange
    // (yields a fresh JWT), else let resolveToken use the stored OAuth token.
    let opts: { apiKey?: string; token?: string } | null = null;
    if (handoff.apiKey) opts = { apiKey: handoff.apiKey };
    else if (handoff.token) opts = { token: handoff.token };
    else if (savedKey) opts = { apiKey: savedKey };
    else if (savedToken) opts = {};

    if (opts) {
      try {
        await bootstrap(opts);
      } catch {
        // bootstrap surfaces the reason via bootstrapError; SignIn renders it.
      }
    }

    // Embed self-refresh: when the host handed off a rotating refresh token
    // (persisted by consumeHandoffCredential above), start the scheduler that
    // rotates our OWN access token shortly before it expires and reconnects
    // with the fresh one — so the embedded session survives past the token's
    // 15-minute life with no host re-mint. No-op when no refresh token was
    // handed off (native / api-key sessions). Started after bootstrap so it
    // schedules off the token actually in use.
    onCleanup(installEmbedSessionRefresh({ zeroidUrl: ZEROID_URL }));

    setTried(true);
  });

  // Attach to the focused session whenever it changes (or when we first
  // sign in). The daemon only broadcasts to attached clients — without
  // this we'd see the list but no transcript or streaming deltas.
  //
  // The set is cleared whenever the connection drops or auth flips —
  // attaches don't survive across daemon restarts (the daemon's
  // session-clients map is wiped) and across reconnect we need to
  // re-attach. Without this clear, post-bounce focus to a session
  // silently no-ops here because `attached.has(id)` is still true,
  // and the user appears subscribed but receives no deltas.
  const attached = new Set<string>();
  createEffect(
    on(connectionStatus, (s) => {
      if (s.kind !== "connected") attached.clear();
    }),
  );
  createEffect(
    on(authIdentity, (auth) => {
      if (!auth) attached.clear();
    }),
  );
  createEffect(
    // MUST track connectionStatus too: on reconnect, neither auth nor the
    // focused id changes, so without this dep the effect wouldn't re-fire and
    // the re-attach would never happen — the client would reconnect but stay
    // unsubscribed (no scrollback, no deltas, stale "thinking" forever). The
    // status effect above clears `attached` on drop; this re-attaches on the
    // following `connected`.
    //
    // attachRetryEpoch: bumped by the transcript's "Retry" affordance after a
    // failed attach (#152) — the failure removed the id from `attached`, so a
    // bump re-runs this dispatch for the focused session.
    on([authIdentity, focusedSessionId, connectionStatus, attachRetryEpoch], () => {
      const auth = authIdentity();
      const id = focusedSessionId();
      if (!auth || !id || attached.has(id)) return;
      // Don't attach until the socket is actually connected.
      if (connectionStatus().kind !== "connected") return;
      // Mark attached optimistically so concurrent effect firings don't send
      // duplicate attaches. On failure, remove so the next focus change retries.
      attached.add(id);
      // Resume incrementally when we hold a cursor for this session — the
      // daemon then replays only what changed since, not the full scrollback.
      // attachSession (state/attach.ts) tracks the pending → settled | failed
      // lifecycle the transcript renders (#152).
      attachSession(id, resumeFor(id))
        .then((data) => {
          // The attach response includes the session's current SessionInfo.
          // Update local state immediately so the status dot reflects reality
          // (e.g. idle) rather than whatever stale value was last seen.
          if (data && typeof data === "object" && "id" in (data as object)) {
            mergeSession(data as SessionInfo);
          }
        })
        .catch((err) => {
          attached.delete(id);
          console.warn("[codeoid] attach failed:", err);
        });
    }),
  );

  // Drop the cached claude-config snapshot when the focused session
  // changes — the next time the user opens the drawer, we refetch.
  createEffect(
    on(focusedSessionId, (sid, prev) => {
      if (prev !== undefined && prev !== sid) resetClaudeConfig();
    }),
  );

  // Global interrupt — Esc (Claude Code parity) and Ctrl/Cmd+X (alias).
  // Esc interrupts the focused session when it's mid-turn; when idle, or
  // when an overlay is open, Esc keeps its existing job (the modal's own
  // listener closes it). Ctrl/Cmd+X is the always-available alias and
  // guards against hijacking a genuine clipboard "cut".
  onMount(() => {
    const isBusy = (status: string): boolean =>
      status === "working" ||
      status === "thinking" ||
      status === "tool_running" ||
      status === "waiting_approval";

    function interruptFocused(): void {
      const s = focusedSession();
      if (!s || !isBusy(s.status)) return;
      send({ type: "session.interrupt", id: newRequestId(), sessionId: s.id });
    }

    function onKey(ev: KeyboardEvent): void {
      // Esc — interrupt when busy. Defer to any open modal/drawer (they own
      // their Esc-to-close handler), so the first Esc closes the overlay and a
      // later Esc interrupts. Detect the overlay by its `fixed inset-0` root —
      // NOT a `backdrop-blur` substring, which also matches the always-present
      // sticky Sessions/Files headers (that made Esc-to-interrupt permanently
      // dead on desktop).
      if (ev.key === "Escape") {
        if (document.querySelector(".fixed.inset-0")) return;
        // The file viewer owns Esc too ("Close (Esc)") — on desktop it's a
        // grid pane, not a fixed overlay, so the selector above misses it
        // and Esc used to interrupt the running turn instead of closing
        // the file the user was reading.
        if (openedFile()) {
          closeFile();
          return;
        }
        const s = focusedSession();
        if (!s || !isBusy(s.status)) return;
        ev.preventDefault();
        interruptFocused();
        return;
      }

      // Ctrl/Cmd+X alias — interrupt mid-turn.
      if (ev.key.toLowerCase() === "x" && (ev.ctrlKey || ev.metaKey)) {
        const s = focusedSession();
        if (!s || !isBusy(s.status)) return;

        // Don't hijack a real "cut": if focus is a text field with a
        // non-empty selection, defer to the browser.
        const el = document.activeElement;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
          const ta = el as HTMLInputElement | HTMLTextAreaElement;
          if (
            typeof ta.selectionStart === "number" &&
            typeof ta.selectionEnd === "number" &&
            ta.selectionEnd > ta.selectionStart
          ) {
            return;
          }
        }

        ev.preventDefault();
        interruptFocused();
      }
    }
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show
      when={authIdentity()}
      fallback={
        // Avoid a flash of SignIn before the silent auto-bootstrap completes.
        <Show when={tried()} fallback={<BootSplash />}>
          <SignIn onSignedIn={() => undefined} />
        </Show>
      }
    >
      <Shell />
    </Show>
  );
};

const BootSplash: Component = () => (
  <div class="flex h-full items-center justify-center bg-bg">
    <span class="font-mono text-sm text-fg-faint">
      <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />{" "}
      &nbsp;codeoid · connecting…
    </span>
  </div>
);

export default App;
