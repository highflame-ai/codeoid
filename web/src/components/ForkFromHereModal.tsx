/**
 * Fork from here (#356): branch a session from an earlier turn into a new
 * session that carries the conversation through the end of that turn — its
 * whole reply included, nothing after — and, in its own worktree, the files as
 * they were right after it. Optionally on another backend. Opened from a message's
 * "fork from here" action. The daemon does the work; this only asks.
 */

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { authIdentity, newRequestId, refreshSessions, request } from "../state/connection";
import { focusSession, getSession, mergeSession } from "../state/sessions";
import type { SessionInfo } from "../protocol/types";

interface Target {
  sessionId: string;
  turnId: string;
}

const [target, setTarget] = createSignal<Target | null>(null);

/** Open the dialog for forking `sessionId` after `turnId`. */
export function openForkFromHere(sessionId: string, turnId: string): void {
  setTarget({ sessionId, turnId });
}

const ForkFromHereModal: Component = () => {
  const [isolate, setIsolate] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const close = () => {
    setTarget(null);
    setError(null);
    setBusy(false);
    setIsolate(true);
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && target() && !busy()) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const current = () => {
    const t = target();
    return t ? getSession(t.sessionId)?.providerId : undefined;
  };
  const providers = () => authIdentity()?.providers ?? [];
  const others = () => providers().filter((p) => p !== (current() ?? providers()[0]));

  function doFork(providerId?: string): void {
    const t = target();
    if (!t) return;
    setBusy(true);
    setError(null);
    request({
      type: "session.fork",
      id: newRequestId(),
      sessionId: t.sessionId,
      afterTurnId: t.turnId,
      ...(providerId ? { providerId } : {}),
      ...(isolate() ? {} : { isolate: false }),
    })
      .then(async (res) => {
        const info = (res as { data?: unknown } | null)?.data;
        if (info && typeof info === "object" && "id" in info) {
          mergeSession(info as SessionInfo);
          focusSession((info as SessionInfo).id);
        } else {
          await refreshSessions().catch(() => {});
        }
        close();
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  }

  return (
    <Show when={target()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy()) close();
        }}
      >
        <div class="mt-[10vh] w-full max-w-md rounded-lg border border-border bg-bg-elev p-5 shadow-2xl" role="dialog" aria-label="Fork from here">
          <header class="mb-3 flex items-center gap-2">
            <h2 class="text-base font-semibold tracking-tight text-fg">Fork from here</h2>
            <button type="button" onClick={close} disabled={busy()} class="ml-auto text-fg-faint hover:text-fg" title="Close (Esc)">
              ✕
            </button>
          </header>
          <p class="mb-3 text-[13px] text-fg-muted">
            A new session with the conversation through the end of this turn — this prompt and everything the agent did in reply, nothing after it. This session is left as it is.
          </p>
          <label class="mb-3 flex items-start gap-2 text-[13px] text-fg">
            <input type="checkbox" class="mt-0.5" checked={isolate()} onChange={(e) => setIsolate(e.currentTarget.checked)} />
            <span>
              Its own git worktree, with the files as they were at the end of this turn
              <span class="block text-[11px] text-fg-faint">Off: share this session's folder (files stay as they are now).</span>
            </span>
          </label>
          <Show when={error()}>
            <div class="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error()}</div>
          </Show>
          <div class="flex flex-col gap-1.5">
            <button
              type="button"
              disabled={busy()}
              onClick={() => doFork()}
              class="flex items-center justify-between rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:opacity-50"
            >
              <span>{busy() ? "forking…" : "Fork"}</span>
              <span class="font-mono text-[11px] opacity-80">{current() ?? providers()[0] ?? ""}</span>
            </button>
            <For each={others()}>
              {(id) => (
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => doFork(id)}
                  class="flex items-center justify-between rounded border border-border px-3 py-1.5 text-sm text-fg-muted transition hover:bg-bg-hover disabled:opacity-50"
                >
                  <span>Fork and continue on</span>
                  <span class="font-mono text-[11px]">{id}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ForkFromHereModal;
