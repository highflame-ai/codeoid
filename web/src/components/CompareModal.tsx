/**
 * Compare backends side by side (#357). Pick 2–4 backend/model targets and a
 * prompt; each runs in its own fork from the same conversation and files
 * (optionally from an earlier message). Then watch the columns fill — status,
 * reply, files changed, cost, time — and keep the best (optionally
 * discarding the rest). The daemon does the work; this renders and asks.
 */

import { Component, For, Index, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

import { authIdentity, getClient, newRequestId, refreshSessions } from "../state/connection";
import { focusSession } from "../state/sessions";
import type { CompareListResultMsg, CompareState, CompareStateMsg, CompareTargetState, DaemonMessage } from "../protocol/types";

interface Opening {
  sessionId: string;
  afterTurnId?: string;
}

const [opening, setOpening] = createSignal<Opening | null>(null);

/** Open the compare dialog for a session (from its latest point, or after `afterTurnId`). */
export function openCompare(sessionId: string, afterTurnId?: string): void {
  setOpening({ sessionId, ...(afterTurnId ? { afterTurnId } : {}) });
}

async function req<T extends DaemonMessage>(msg: Record<string, unknown> & { type: string }, resultType: string): Promise<T> {
  const id = newRequestId();
  return getClient().request<T>(
    { ...msg, id } as never,
    {
      waitForResult: (m) => (m.type === resultType && (m as { requestId?: string }).requestId === id ? (m as T) : undefined),
      timeoutMs: 120_000,
    },
  );
}

const RUNNING = new Set(["thinking", "tool_running", "waiting_approval"]);

const statusLabel = (t: CompareTargetState): string =>
  t.status === "gone" ? "discarded" : t.status === "failed" ? "failed to start" : RUNNING.has(t.status) ? "working…" : t.status;

const Column: Component<{
  t: CompareTargetState;
  kept: boolean;
  canKeep: boolean;
  onKeep: (discard: boolean) => void;
  onOpen: () => void;
}> = (props) => (
  <div class={`flex min-w-0 flex-1 flex-col gap-2 rounded border p-2 ${props.kept ? "border-success" : "border-border"} bg-bg`}>
    <div class="flex items-center gap-2">
      <span class="font-mono text-[12px] text-fg">
        {props.t.providerId}
        <Show when={props.t.model}>
          <span class="text-fg-faint">:{props.t.model}</span>
        </Show>
      </span>
      <span class={`ml-auto text-[11px] ${props.t.status === "error" || props.t.status === "failed" ? "text-danger" : "text-fg-faint"}`}>
        {props.kept ? "kept" : statusLabel(props.t)}
      </span>
    </div>
    <Show when={props.t.error}>
      <div class="text-[11px] text-danger">{props.t.error}</div>
    </Show>
    <div class="max-h-60 min-h-16 overflow-auto whitespace-pre-wrap text-[12px] text-fg-muted">{props.t.reply ?? ""}</div>
    <Show when={props.t.files}>
      {(f) => (
        <details class="text-[11px] text-fg-muted">
          <summary class="cursor-pointer">
            {f().changed} file(s) · <span class="text-success">+{f().insertions}</span> <span class="text-danger">−{f().deletions}</span>
          </summary>
          <ul class="max-h-24 overflow-auto font-mono">
            <For each={f().paths}>{(p) => <li class="truncate">{p}</li>}</For>
          </ul>
        </details>
      )}
    </Show>
    <div class="flex gap-3 text-[11px] text-fg-faint">
      <Show when={props.t.costUsd !== undefined}>
        <span>${props.t.costUsd!.toFixed(3)}</span>
      </Show>
      <Show when={props.t.durationMs !== undefined}>
        <span>{Math.round(props.t.durationMs! / 1000)}s</span>
      </Show>
    </div>
    <div class="mt-auto flex flex-wrap gap-1.5">
      <Show when={props.t.sessionId && props.t.status !== "gone"}>
        <button type="button" onClick={() => props.onOpen()} class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover">
          open
        </button>
      </Show>
      <Show when={props.canKeep}>
        <button type="button" onClick={() => props.onKeep(false)} class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover">
          keep
        </button>
        <button type="button" onClick={() => props.onKeep(true)} class="rounded bg-accent px-2 py-0.5 text-[11px] font-semibold text-bg hover:bg-accent-hover">
          keep, discard others
        </button>
      </Show>
    </div>
  </div>
);

const CompareModal: Component = () => {
  const [targets, setTargets] = createSignal<Array<{ providerId: string; model: string }>>([]);
  const [prompt, setPrompt] = createSignal("");
  const [isolate, setIsolate] = createSignal(true);
  const [state, setState] = createSignal<CompareState | null>(null);
  const [previous, setPrevious] = createSignal<CompareState[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  const providers = () => authIdentity()?.providers ?? [];
  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const close = () => {
    stopPolling();
    setOpening(null);
    setState(null);
    setError(null);
    setBusy(false);
    setPrompt("");
    setTargets([]);
  };

  const poll = (compareId: string) => {
    stopPolling();
    const tick = () =>
      req<CompareStateMsg>({ type: "compare.get", compareId }, "compare.state")
        .then((r) => {
          setState(r.compare);
          if (!r.compare.targets.some((t) => RUNNING.has(t.status))) stopPolling();
        })
        .catch(() => {});
    timer = setInterval(tick, 2_000);
    void tick();
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && opening() && !busy()) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      stopPolling();
    });
  });

  // When opened: default to the first two backends, and load past comparisons.
  const prepare = (o: Opening) => {
    const p = providers();
    setTargets(p.slice(0, Math.min(2, p.length)).map((providerId) => ({ providerId, model: "" })));
    req<CompareListResultMsg>({ type: "compare.list", sessionId: o.sessionId }, "compare.list.result")
      .then((r) => setPrevious(r.compares))
      .catch(() => setPrevious([]));
  };

  async function start(): Promise<void> {
    const o = opening();
    if (!o) return;
    setBusy(true);
    setError(null);
    try {
      const r = await req<CompareStateMsg>(
        {
          type: "session.compare",
          sessionId: o.sessionId,
          prompt: prompt(),
          targets: targets().map((t) => ({ providerId: t.providerId, ...(t.model.trim() ? { model: t.model.trim() } : {}) })),
          ...(o.afterTurnId ? { afterTurnId: o.afterTurnId } : {}),
          ...(isolate() ? {} : { isolate: false }),
        },
        "compare.state",
      );
      setState(r.compare);
      void refreshSessions().catch(() => {});
      poll(r.compare.compareId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function keep(sessionId: string, discard: boolean): Promise<void> {
    const s = state();
    if (!s) return;
    try {
      const r = await req<CompareStateMsg>({ type: "compare.keep", compareId: s.compareId, sessionId, ...(discard ? { discardOthers: true } : {}) }, "compare.state");
      setState(r.compare);
      await refreshSessions().catch(() => {});
      focusSession(sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  createEffect(
    on(opening, (o) => {
      if (o) prepare(o);
    }),
  );

  const canStart = () => !busy() && prompt().trim().length > 0 && targets().length >= 2 && targets().length <= 4;

  return (
    <Show when={opening()}>
      {(o) => {
        return (
          <div
            class="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
            onClick={(e) => {
              if (e.target === e.currentTarget && !busy()) close();
            }}
          >
            <div class="mt-[6vh] w-full max-w-5xl rounded-lg border border-border bg-bg-elev p-5 shadow-2xl" role="dialog" aria-label="Compare backends">
              <header class="mb-3 flex items-center gap-2">
                <h2 class="text-base font-semibold tracking-tight text-fg">Compare backends</h2>
                <Show when={o().afterTurnId}>
                  <span class="text-[11px] text-fg-faint">from this message</span>
                </Show>
                <button type="button" onClick={close} disabled={busy()} class="ml-auto text-fg-faint hover:text-fg" title="Close (Esc)">
                  ✕
                </button>
              </header>

              <Show
                when={state()}
                fallback={
                  <div class="space-y-3">
                    <p class="text-[13px] text-fg-muted">
                      Send one prompt to each backend. Each runs in its own fork, starting from the same conversation and files.
                    </p>
                    <div class="space-y-1.5">
                      <Index each={targets()}>
                        {(t, i) => (
                          <div class="flex items-center gap-2">
                            <select
                              value={t().providerId}
                              onChange={(e) => setTargets((cur) => cur.map((x, j) => (j === i ? { ...x, providerId: e.currentTarget.value } : x)))}
                              class="rounded border border-border bg-bg px-2 py-1 font-mono text-[12px] text-fg"
                              aria-label={`backend ${i + 1}`}
                            >
                              <For each={providers()}>{(p) => <option value={p}>{p}</option>}</For>
                            </select>
                            <input
                              type="text"
                              placeholder="model (default)"
                              value={t().model}
                              onInput={(e) => setTargets((cur) => cur.map((x, j) => (j === i ? { ...x, model: e.currentTarget.value } : x)))}
                              class="flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[12px] text-fg placeholder:text-fg-faint"
                              aria-label={`model ${i + 1}`}
                            />
                            <button
                              type="button"
                              disabled={targets().length <= 2}
                              onClick={() => setTargets((cur) => cur.filter((_, j) => j !== i))}
                              class="text-fg-faint hover:text-fg disabled:opacity-30"
                              title="Remove"
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </Index>
                      <Show when={targets().length < 4}>
                        <button
                          type="button"
                          onClick={() => setTargets((cur) => [...cur, { providerId: providers()[0] ?? "claude", model: "" }])}
                          class="text-[12px] text-accent hover:underline"
                        >
                          + add a backend
                        </button>
                      </Show>
                    </div>
                    <textarea
                      value={prompt()}
                      onInput={(e) => setPrompt(e.currentTarget.value)}
                      rows={4}
                      placeholder="The prompt every backend gets"
                      class="w-full rounded border border-border bg-bg px-2 py-1.5 text-[13px] text-fg placeholder:text-fg-faint"
                      aria-label="prompt"
                    />
                    <label class="flex items-center gap-2 text-[12px] text-fg-muted">
                      <input type="checkbox" checked={isolate()} onChange={(e) => setIsolate(e.currentTarget.checked)} />
                      Each in its own git worktree (recommended: they won't edit the same files)
                    </label>
                    <Show when={previous().length > 0}>
                      <div class="text-[11px] text-fg-faint">
                        Earlier comparisons:{" "}
                        <For each={previous().slice(0, 5)}>
                          {(c) => (
                            <button
                              type="button"
                              class="mr-2 underline hover:text-fg"
                              onClick={() => {
                                setState(c);
                                poll(c.compareId);
                              }}
                            >
                              “{c.prompt.slice(0, 30)}”
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="flex justify-end">
                      <button
                        type="button"
                        disabled={!canStart()}
                        onClick={() => void start()}
                        class="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:opacity-50"
                      >
                        {busy() ? "starting…" : `Compare ${targets().length} backends`}
                      </button>
                    </div>
                  </div>
                }
              >
                {(s) => (
                  <div class="space-y-2">
                    <blockquote class="max-h-16 overflow-auto whitespace-pre-wrap rounded border-l-2 border-l-role-user bg-bg px-2 py-1 text-[12px] text-fg-muted">
                      {s().prompt}
                    </blockquote>
                    <div class="flex flex-col gap-2 md:flex-row">
                      <For each={s().targets}>
                        {(t) => (
                          <Column
                            t={t}
                            kept={s().keptSessionId === t.sessionId && t.sessionId !== undefined}
                            canKeep={!s().keptSessionId && !!t.sessionId && t.status !== "gone" && !RUNNING.has(t.status)}
                            onKeep={(discard) => void keep(t.sessionId!, discard)}
                            onOpen={() => {
                              focusSession(t.sessionId!);
                              close();
                            }}
                          />
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </Show>

              <Show when={error()}>
                <div class="mt-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error()}</div>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default CompareModal;
