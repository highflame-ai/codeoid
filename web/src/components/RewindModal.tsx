/**
 * Go back a turn (#355). Opened from a user message's "go back to here",
 * the session controls' undo, or `/undo`. Shows what going back would do —
 * a dry run — before anything happens: how many turns are taken back, the
 * prompt that comes back to the composer, which files would be restored or
 * removed (and which of those were edited by hand since the agent's last
 * turn), and what the taken-back turns did that can't be undone. Restoring
 * files is opt-in. The daemon does the work; this only renders and asks.
 */

import { Component, For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { getClient, newRequestId } from "../state/connection";
import { setDraft } from "../state/prompt-drafts";
import type { SessionRewindResultMsg, SessionTurnsResultMsg } from "../protocol/types";

interface Target {
  sessionId: string;
  turnId: string;
}

const [target, setTarget] = createSignal<Target | null>(null);

/** Open the dialog for going back to before `turnId`. */
export function openRewind(sessionId: string, turnId: string): void {
  setTarget({ sessionId, turnId });
}

/**
 * Open the dialog for the session's latest turn ("undo last message").
 * Resolves false when the session has no turns to take back.
 */
export async function openUndoLast(sessionId: string): Promise<boolean> {
  const id = newRequestId();
  const res = await getClient().request<SessionTurnsResultMsg>(
    { type: "session.turns", id, sessionId },
    {
      waitForResult: (m) => (m.type === "session.turns.result" && m.requestId === id ? m : undefined),
      timeoutMs: 15_000,
    },
  );
  const last = res.turns.at(-1);
  if (!last) return false;
  openRewind(sessionId, last.turnId);
  return true;
}

/** Ask the daemon to (dry-)run a rewind. */
async function rewindRequest(t: Target, opts: { restoreFiles: boolean; dryRun: boolean; force?: boolean }): Promise<SessionRewindResultMsg> {
  const id = newRequestId();
  return getClient().request<SessionRewindResultMsg>(
    {
      type: "session.rewind",
      id,
      sessionId: t.sessionId,
      turnId: t.turnId,
      ...(opts.restoreFiles ? { restoreFiles: true } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.force ? { force: true } : {}),
    },
    {
      waitForResult: (m) => (m.type === "session.rewind.result" && m.requestId === id ? m : undefined),
      timeoutMs: 60_000,
    },
  );
}

const FileList: Component<{ label: string; files: string[]; tone?: "danger" }> = (props) => (
  <Show when={props.files.length > 0}>
    <div>
      <div class={`text-[11px] uppercase tracking-wider ${props.tone === "danger" ? "text-danger" : "text-fg-faint"}`}>
        {props.label} ({props.files.length})
      </div>
      <ul class="max-h-28 overflow-auto font-mono text-[11px] text-fg-muted">
        <For each={props.files.slice(0, 200)}>{(f) => <li class="truncate">{f}</li>}</For>
        <Show when={props.files.length > 200}>
          <li class="text-fg-faint">… {props.files.length - 200} more</li>
        </Show>
      </ul>
    </div>
  </Show>
);

const RewindModal: Component = () => {
  const [plan, setPlan] = createSignal<SessionRewindResultMsg | null>(null);
  const [restoreFiles, setRestoreFiles] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const close = () => {
    setTarget(null);
    setPlan(null);
    setError(null);
    setBusy(false);
    setRestoreFiles(false);
  };

  // Preview as soon as the dialog opens (always with files, so the
  // checkbox can show what it would do without a second round trip).
  createEffect(() => {
    const t = target();
    if (!t) return;
    setPlan(null);
    setError(null);
    rewindRequest(t, { restoreFiles: true, dryRun: true })
      .then((p) => {
        if (target() === t) setPlan(p);
      })
      .catch((e) => {
        if (target() === t) setError(e instanceof Error ? e.message : String(e));
      });
  });

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

  const conflicts = () => (restoreFiles() ? (plan()?.files?.conflicts ?? []) : []);

  async function confirm(): Promise<void> {
    const t = target();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rewindRequest(t, {
        restoreFiles: restoreFiles(),
        dryRun: false,
        force: conflicts().length > 0,
      });
      if (res.refused) {
        setPlan(res);
        setError(res.refused);
        setBusy(false);
        return;
      }
      // The taken-back prompt goes back into the composer, to edit and resend.
      setDraft(t.sessionId, res.restoredPrompt);
      window.dispatchEvent(new CustomEvent("codeoid:prompt-draft-changed", { detail: { sessionId: t.sessionId } }));
      window.dispatchEvent(new CustomEvent("codeoid:focus-prompt"));
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Show when={target()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy()) close();
        }}
      >
        <div class="mt-[10vh] w-full max-w-lg rounded-lg border border-border bg-bg-elev p-5 shadow-2xl" role="dialog" aria-label="Go back a turn">
          <header class="mb-3 flex items-center gap-2">
            <h2 class="text-base font-semibold tracking-tight text-fg">Go back</h2>
            <button type="button" onClick={close} disabled={busy()} class="ml-auto text-fg-faint hover:text-fg" title="Close (Esc)">
              ✕
            </button>
          </header>

          <Show when={!plan() && !error()}>
            <p class="text-sm text-fg-muted">Checking what going back would do…</p>
          </Show>

          <Show when={plan()}>
            {(p) => (
              <div class="space-y-3 text-[13px]">
                <p class="text-fg">
                  Take back {p().removedTurns === 1 ? "this message" : `this message and the ${p().removedTurns - 1} after it`}. The
                  agent won't remember {p().removedTurns === 1 ? "it" : "them"}, and the message comes back to the composer so you can edit
                  and resend it.
                </p>
                <blockquote class="max-h-24 overflow-auto whitespace-pre-wrap rounded border-l-2 border-l-role-user bg-bg px-2 py-1 font-mono text-[12px] text-fg-muted">
                  {p().restoredPrompt || "(no prompt text)"}
                </blockquote>

                <label class="flex items-start gap-2 text-fg">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={restoreFiles()}
                    disabled={!p().files}
                    onChange={(e) => setRestoreFiles(e.currentTarget.checked)}
                  />
                  <span>
                    Also put the files back the way they were when this message was sent
                    <Show when={p().filesUnavailable}>
                      <span class="block text-[11px] text-fg-faint">Not available: {p().filesUnavailable}</span>
                    </Show>
                  </span>
                </label>

                <Show when={restoreFiles() && p().files}>
                  {(f) => (
                    <div class="space-y-2 rounded border border-border bg-bg p-2">
                      <Show when={f().restore.length === 0 && f().remove.length === 0}>
                        <p class="text-[12px] text-fg-muted">No files changed since then.</p>
                      </Show>
                      <FileList label="restored" files={f().restore} />
                      <FileList label="removed (created since)" files={f().remove} />
                      <FileList label="edited by you since the agent's last turn — will be overwritten" files={f().conflicts} tone="danger" />
                      <Show when={f().late}>
                        <p class="text-[11px] text-fg-faint">
                          This snapshot finished after the agent had started, so it may already include the agent's first edits.
                        </p>
                      </Show>
                      <p class="text-[11px] text-fg-faint">Ignored files (build output, dependencies) and secret files are never touched.</p>
                    </div>
                  )}
                </Show>

                <Show when={p().irreversible.length > 0}>
                  <div class="rounded border border-warn/40 bg-warn/5 p-2">
                    <div class="text-[11px] uppercase tracking-wider text-warn">Not undone by going back</div>
                    <ul class="max-h-28 overflow-auto font-mono text-[11px] text-fg-muted">
                      <For each={p().irreversible}>
                        {(x) => (
                          <li class="truncate" title={x.detail}>
                            {x.tool}: {x.detail}
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <Show when={error()}>
            <div class="mt-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error()}</div>
          </Show>

          <div class="mt-4 flex items-center justify-end gap-2">
            <button type="button" onClick={close} disabled={busy()} class="rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:bg-bg-hover">
              cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={busy() || !plan()}
              class={`rounded px-3 py-1.5 text-sm font-semibold text-bg transition disabled:cursor-not-allowed disabled:opacity-50 ${
                conflicts().length > 0 ? "bg-danger hover:bg-danger/80" : "bg-accent hover:bg-accent-hover"
              }`}
            >
              {busy() ? "going back…" : conflicts().length > 0 ? "Go back and overwrite my edits" : "Go back"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default RewindModal;
