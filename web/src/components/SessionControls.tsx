/**
 * Inline control bar for the focused session — sits in the session
 * header next to the metrics. Buttons are 1:1 with the slash commands
 * (so the prompt and chrome are interchangeable):
 *
 *   [interrupt]  [↻ rotate]  [mode ▾]  [model ▾]  …  [destroy]
 *
 * All actions go through the same protocol verbs the slash commands use
 * (single source of truth) and rely on the daemon's `session.info_update`
 * broadcast for state to reflect — no optimistic updates here. Mutating
 * verbs use `request()` so a daemon rejection surfaces inline instead of
 * silently doing nothing (or worse, desyncing the local store).
 */

import { Component, For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";

import {
  authIdentity,
  newRequestId,
  refreshSessions,
  request,
  send,
} from "../state/connection";
import {
  focusSession,
  focusedSession,
  getSession,
  mergeSession,
  removeSession,
} from "../state/sessions";
import { fetchModels, modelCatalog } from "../state/models";
import { effectiveMode } from "../lib/session-mode";
import { CAPABILITIES } from "../protocol/types";
import type { ClientMessage, SessionInfo, SessionMode } from "../protocol/types";
import { openBlackboard } from "../state/blackboard";
import { openExportModal } from "./SessionExportModal";

const MODE_OPTIONS: { value: SessionMode; label: string; hint: string }[] = [
  { value: "guarded", label: "guarded", hint: "Read/Grep/Glob auto; Write/Edit/Bash ask (default)" },
  { value: "interactive", label: "interactive", hint: "every tool asks first" },
  { value: "autonomous", label: "autonomous", hint: "every tool auto-approved — no prompts" },
];

/**
 * Shared request-action state for a control that fires a mutating protocol
 * verb: `busy` while the request is in flight (callers disable their
 * controls), `error` carrying the daemon's rejection for inline rendering
 * (the ProviderPicker's error-row pattern). Success runs `onOk`; rejection
 * surfaces instead of vanishing into a fire-and-forget `send()`.
 */
function createAction(): {
  busy: () => boolean;
  error: () => string | null;
  clearError: () => void;
  run: (msg: ClientMessage, onOk?: () => void) => void;
} {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = (msg: ClientMessage, onOk?: () => void): void => {
    if (busy()) return; // one in-flight request per control
    // A stale rejection from a previous attempt would read as if it
    // belonged to THIS dispatch — clear before sending.
    setError(null);
    setBusy(true);
    request(msg)
      .then(() => {
        setBusy(false);
        onOk?.();
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };
  return { busy, error, clearError: () => setError(null), run };
}

/** Inline rejection row for dropdown menus — same shape ProviderPicker uses. */
const MenuError: Component<{ error: string | null }> = (props) => (
  <Show when={props.error}>
    <div role="alert" class="border-t border-danger/40 px-3 py-1.5 text-[11px] text-danger">
      {props.error}
    </div>
  </Show>
);

const SessionControls: Component = () => {
  return (
    <Show when={focusedSession()}>
      {(s) => (
        <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <ForkedFromChip forkedFrom={s().forkedFrom} />
          <WorktreeChip worktree={s().worktree} />
          <BlackboardButton session={s()} />
          <InterruptButton sessionId={s().id} status={s().status} />
          <RotateButton sessionId={s().id} />
          <ModePicker sessionId={s().id} current={effectiveMode(s())} />
          <ModelPicker
            sessionId={s().id}
            current={s().model}
            provider={s().providerId}
          />
          <ProviderPicker sessionId={s().id} current={s().providerId} />
          <ForkButton sessionId={s().id} current={s().providerId} />
          <ExportButton />
          <span class="ml-auto" />
          <DestroyButton sessionId={s().id} name={s().name} />
        </div>
      )}
    </Show>
  );
};

/**
 * Opens the goal blackboard for a session that is part of a collaboration —
 * the orchestrator or any role-child, since the daemon resolves the hop.
 *
 * Capability-gated rather than always rendered: against a daemon that predates
 * `blackboard.index` the affordance simply doesn't appear, instead of
 * appearing and erroring on click.
 */
const BlackboardButton: Component<{ session: SessionInfo }> = (props) => {
  const partOfCollab = () =>
    Boolean(props.session.collaboration ?? props.session.collaborationRole);
  const supported = () =>
    authIdentity()?.capabilities?.includes(CAPABILITIES.BLACKBOARD) ?? false;
  return (
    <Show when={partOfCollab() && supported()}>
      <button
        type="button"
        onClick={() => openBlackboard(props.session.id)}
        class="flex items-center gap-1 rounded border border-accent/30 bg-accent/5 px-2 py-1 font-mono text-[11px] text-fg-muted transition hover:border-accent/50 hover:text-fg"
        title="Goal blackboard — what this collaboration's roles have handed each other"
      >
        <span class="text-accent">▤</span>
        <span>board</span>
      </button>
    </Show>
  );
};

/** Lineage chip for a forked session — "⑃ from <parent> · turn N". Clicking
 *  focuses the parent when it's still in the list; otherwise it's a static
 *  label (the parent may have been destroyed since). */
const ForkedFromChip: Component<{
  forkedFrom?: { sessionId: string; name: string; atTurn: number };
}> = (props) => {
  // Optional-chain, not force-unwrap: Solid can re-run this binding with
  // props.forkedFrom already undefined (focus switched to a non-fork) a beat
  // before <Show> disposes the child — a `!` here would crash the renderer.
  const parentAlive = () => {
    const id = props.forkedFrom?.sessionId;
    return id !== undefined && getSession(id) !== undefined;
  };
  return (
    <Show when={props.forkedFrom}>
      {(f) => (
        <button
          type="button"
          disabled={!parentAlive()}
          onClick={() => parentAlive() && focusSession(f().sessionId)}
          class="flex items-center gap-1 rounded border border-accent/30 bg-accent/5 px-2 py-1 font-mono text-[11px] text-fg-muted transition enabled:hover:border-accent/50 enabled:hover:text-fg disabled:cursor-default disabled:opacity-70"
          title={
            parentAlive()
              ? `Forked from “${f().name}” after ${f().atTurn} turn(s) — click to open it`
              : `Forked from “${f().name}” (no longer open) after ${f().atTurn} turn(s)`
          }
        >
          <span class="text-accent">⑃</span>
          <span class="text-fg-faint">from</span>
          <span class="max-w-[10rem] truncate">{f().name}</span>
          <span class="text-fg-faint">· turn {f().atTurn}</span>
        </button>
      )}
    </Show>
  );
};

/** Isolated-worktree chip — "⎇ <branch>". Present when the session runs in its
 *  own git worktree (a fork isolated from its parent, or a bound worktree), so
 *  the user can see at a glance that its file edits won't collide. */
const WorktreeChip: Component<{
  worktree?: { path: string; branch: string; createdByCodeoid: boolean };
}> = (props) => (
  <Show when={props.worktree}>
    {(wt) => (
      <span
        class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg-muted"
        title={`Isolated git worktree — edits here don't touch other sessions.\nbranch: ${wt().branch}\npath: ${wt().path}`}
      >
        <span class="text-accent">⎇</span>
        <span class="max-w-[12rem] truncate">{wt().branch}</span>
      </span>
    )}
  </Show>
);

const InterruptButton: Component<{
  sessionId: string;
  status: string;
}> = (props) => {
  const armed = () =>
    props.status === "working" ||
    props.status === "thinking" ||
    props.status === "tool_running";
  return (
    <button
      type="button"
      disabled={!armed()}
      onClick={() =>
        send({
          type: "session.interrupt",
          id: newRequestId(),
          sessionId: props.sessionId,
        })
      }
      class={`rounded border px-2 py-1 font-mono uppercase tracking-wider transition disabled:cursor-not-allowed ${
        armed()
          ? "border-danger/50 text-danger hover:bg-danger/10"
          : "border-border text-fg-faint opacity-60"
      }`}
      title="Interrupt the running turn (Ctrl+X / Cmd+X)"
    >
      ⏹ interrupt
    </button>
  );
};

const ExportButton: Component = () => (
  <button
    type="button"
    onClick={openExportModal}
    class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-muted transition hover:border-accent/40 hover:bg-accent/5 hover:text-fg"
    title="Export session as a portable bundle (/export)"
  >
    ⤓ export
  </button>
);

const RotateButton: Component<{ sessionId: string }> = (props) => {
  const act = createAction();
  return (
    <span class="flex items-center gap-1">
      <button
        type="button"
        disabled={act.busy()}
        onClick={() =>
          act.run({
            type: "session.rotate",
            id: newRequestId(),
            sessionId: props.sessionId,
          })
        }
        class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-muted transition hover:border-accent/40 hover:bg-accent/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        title="Rotate the Claude Code backing context (refresh skills/settings; memory preserved)"
      >
        ↻ rotate
      </button>
      <Show when={act.error()}>
        <span role="alert" class="text-[11px] text-danger">
          {act.error()}
        </span>
      </Show>
    </span>
  );
};

/** Dismiss a dropdown on Escape or a pointer-down outside its root — the menus
 * previously closed only on `onMouseLeave`, which a keyboard/touch user can't
 * trigger, so the menu stayed open over the content. Call inside a component. */
function useDismissable(
  rootRef: () => HTMLElement | undefined,
  isOpen: () => boolean,
  close: () => void,
): void {
  createEffect(() => {
    if (!isOpen()) return;
    const onDown = (e: PointerEvent) => {
      const el = rootRef();
      if (el && !el.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });
}

const ModePicker: Component<{
  sessionId: string;
  current: SessionMode;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const act = createAction();
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));
  return (
    <div class="relative" ref={rootEl}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open());
          act.clearError();
        }}
        class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-fg"
        title="Cycle execution mode"
      >
        mode <span class="text-fg">{props.current}</span> ▾
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 top-full z-30 mt-1 w-56 rounded border border-border bg-bg-elev shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          <For each={MODE_OPTIONS}>
            {(opt) => (
              <button
                type="button"
                disabled={act.busy()}
                onClick={() =>
                  act.run(
                    {
                      type: "session.set_mode",
                      id: newRequestId(),
                      sessionId: props.sessionId,
                      mode: opt.value,
                    },
                    () => setOpen(false),
                  )
                }
                class={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50 ${
                  opt.value === props.current ? "bg-bg-active" : ""
                }`}
              >
                <span class="font-mono text-[12px] text-fg">{opt.label}</span>
                <span class="text-[10px] text-fg-faint">{opt.hint}</span>
              </button>
            )}
          </For>
          <MenuError error={act.error()} />
        </div>
      </Show>
    </div>
  );
};

// Module-level so `/model` (bare) can open the picker programmatically.
const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
/** Open the focused session's model picker (wired to the bare `/model` slash).
 *  Fetches the FOCUSED session's backend catalog — not the daemon default. */
export function openModelPicker(): void {
  setModelPickerOpen(true);
  void fetchModels(focusedSession()?.providerId);
}

const ModelPicker: Component<{
  sessionId: string;
  current?: string;
  provider?: string;
}> = (props) => {
  const open = modelPickerOpen;
  const setOpen = setModelPickerOpen;
  const [custom, setCustom] = createSignal("");
  const act = createAction();
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));
  // Track the session's backend — the catalog is per-backend, so a
  // `/provider` switch (or tabbing to a session on another backend) must
  // swap the list (the reported bug: switching to codex kept showing
  // claude's models). NOT forced: a backend already fetched live serves
  // from cache instantly (no daemon round-trip while navigating sessions),
  // and a not-yet-live backend still refetches. This must run regardless of
  // whether the picker is open — the `/model` slash and the help modal read
  // the same catalog.
  createEffect(
    on(
      () => props.provider,
      (provider) => void fetchModels(provider),
    ),
  );
  return (
    <div class="relative" ref={rootEl}>
      <button
        type="button"
        onClick={() => {
          const next = !open();
          setOpen(next);
          act.clearError();
          if (next) void fetchModels(props.provider);
        }}
        class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-fg"
        title="Switch model (next turn applies)"
      >
        model <span class="text-fg">{props.current ?? "default"}</span> ▾
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 top-full z-30 mt-1 w-56 rounded border border-border bg-bg-elev shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          <Show
            when={modelCatalog().length > 0}
            fallback={
              <div class="px-3 py-2 text-[11px] text-fg-faint">Loading models…</div>
            }
          >
            <For each={modelCatalog()}>
              {(opt) => (
                <button
                  type="button"
                  disabled={act.busy()}
                  onClick={() =>
                    act.run(
                      {
                        type: "session.set_model",
                        id: newRequestId(),
                        sessionId: props.sessionId,
                        model: opt.value,
                      },
                      () => setOpen(false),
                    )
                  }
                  class={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50 ${
                    opt.value === props.current ? "bg-bg-active text-fg" : "text-fg-muted"
                  }`}
                  title={opt.description ?? opt.value}
                >
                  <span class="flex flex-col">
                    <span class="text-fg">{opt.displayName}{opt.isDefault ? " ·default" : ""}</span>
                    <span class="font-mono text-[10px] text-fg-faint">{opt.value}</span>
                  </span>
                  <Show when={opt.value === props.current}>
                    <span class="text-accent">●</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
          <div class="border-t border-border p-2">
            <input
              type="text"
              placeholder="custom model id"
              value={custom()}
              disabled={act.busy()}
              onInput={(e) => setCustom(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom().trim()) {
                  // On rejection (a typo'd id the daemon bounces) the text
                  // stays in the input so the user can fix it in place.
                  act.run(
                    {
                      type: "session.set_model",
                      id: newRequestId(),
                      sessionId: props.sessionId,
                      model: custom().trim(),
                    },
                    () => {
                      setOpen(false);
                      setCustom("");
                    },
                  );
                }
              }}
              class="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent disabled:opacity-50"
            />
          </div>
          <MenuError error={act.error()} />
        </div>
      </Show>
    </div>
  );
};

/**
 * Backend switcher (`session.set_provider`) — visual counterpart of the
 * `/provider <id>` slash. Hidden on single-backend daemons (and legacy
 * daemons that don't advertise providers). Uses `request()` so the
 * daemon's rejections (mid-turn switch, unknown id) surface inline
 * instead of vanishing.
 */
const ProviderPicker: Component<{
  sessionId: string;
  current?: string;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));
  const providers = () => authIdentity()?.providers ?? [];
  const current = () => props.current ?? providers()[0] ?? "claude";
  return (
    <Show when={providers().length > 1}>
      <div class="relative" ref={rootEl}>
        <button
          type="button"
          onClick={() => {
            setOpen(!open());
            setError(null);
          }}
          class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-fg"
          title="Switch this session's backend (/provider <id>)"
        >
          backend <span class="text-fg">{current()}</span> ▾
        </button>
        <Show when={open()}>
          <div class="absolute right-0 top-full z-30 mt-1 w-64 rounded border border-border bg-bg-elev shadow-xl">
            <For each={providers()}>
              {(id) => (
                <button
                  type="button"
                  onClick={() => {
                    if (id === current()) {
                      setOpen(false);
                      return;
                    }
                    // A stale rejection from a previous attempt would read as
                    // if it belonged to THIS click — clear before dispatch.
                    setError(null);
                    request({
                      type: "session.set_provider",
                      id: newRequestId(),
                      sessionId: props.sessionId,
                      providerId: id,
                    })
                      .then(() => setOpen(false))
                      .catch((e) =>
                        setError(e instanceof Error ? e.message : String(e)),
                      );
                  }}
                  class={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition hover:bg-bg-hover ${
                    id === current() ? "bg-bg-active text-fg" : "text-fg-muted"
                  }`}
                >
                  <span class="font-mono">{id}</span>
                  <Show when={id === current()}>
                    <span class="text-accent">●</span>
                  </Show>
                </button>
              )}
            </For>
            <Show when={error()}>
              <div class="border-t border-danger/40 px-3 py-1.5 text-[11px] text-danger">
                {error()}
              </div>
            </Show>
            <div class="border-t border-border px-3 py-1.5 text-[10px] text-fg-faint">
              Keeps the session + transcript. The new backend continues from a
              carried transcript; the model resets to its default.
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
};

/**
 * Fork the session (`session.fork`) — branch its conversation into a new
 * independent session and focus it. On a multi-backend daemon the dropdown
 * also offers "fork onto <backend>", continuing the same conversation on a
 * different harness in one step. Uses `request()` so a rejection surfaces
 * inline; on success the daemon returns the fork's SessionInfo, which we
 * merge into the store and focus (same as create).
 */
const ForkButton: Component<{
  sessionId: string;
  current?: string;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Fork options (apply to whichever action the user clicks).
  const [isolate, setIsolate] = createSignal(true);
  // Fork from the parent's CURRENT working state (carry uncommitted changes)
  // vs a clean base branch. Default on. When on, the base-branch input is
  // disabled — there's no base to pick, you're branching from where you are.
  const [fromCurrentState, setFromCurrentState] = createSignal(true);
  const [baseBranch, setBaseBranch] = createSignal("");
  // A base-branch fork needs a branch; block the action until one is entered.
  const forkFromBase = () => isolate() && !fromCurrentState();
  const canFork = () => !(forkFromBase() && baseBranch().trim().length === 0);
  let rootEl: HTMLDivElement | undefined;
  useDismissable(() => rootEl, open, () => setOpen(false));
  const providers = () => authIdentity()?.providers ?? [];
  // Backends OTHER than the current one — the "fork onto X" targets.
  const otherBackends = () => providers().filter((p) => p !== (props.current ?? providers()[0]));

  const doFork = (providerId?: string) => {
    setError(null);
    setBusy(true);
    const base = baseBranch().trim();
    request({
      type: "session.fork",
      id: newRequestId(),
      sessionId: props.sessionId,
      ...(providerId ? { providerId } : {}),
      // Default is isolate=true; only send when the user opts OUT.
      ...(isolate() ? {} : { isolate: false }),
      // Base branch only when forking from a base (not current state).
      ...(forkFromBase() && base ? { baseBranch: base } : {}),
    })
      .then(async (res) => {
        // request() resolves to the daemon's `response.ok` envelope
        // ({type, requestId, data}), so the fork's SessionInfo lives at
        // `.data` — reading `res` directly missed it, so the fork never
        // merged into the store or got focused and the sidebar looked
        // unchanged (incl. forking an already-forked session).
        const info = (res as { data?: unknown } | null)?.data;
        if (info && typeof info === "object" && "id" in info) {
          mergeSession(info as SessionInfo);
          focusSession((info as SessionInfo).id);
        } else {
          // Older daemon / unexpected shape: refresh the list so the fork
          // still shows up (mirrors NewSessionModal's fallback).
          await refreshSessions().catch(() => {});
        }
        setBusy(false);
        setOpen(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };

  return (
    <div class="relative" ref={rootEl}>
      <button
        type="button"
        disabled={busy()}
        onClick={() => {
          setOpen(!open());
          setError(null);
        }}
        class="flex items-center gap-1 rounded border border-border bg-bg px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:border-accent/40 hover:text-fg disabled:opacity-50"
        title="Fork this conversation into a new session (/fork)"
      >
        ⑃ fork ▾
      </button>
      <Show when={open()}>
        <div class="absolute right-0 top-full z-30 mt-1 w-72 rounded border border-border bg-bg-elev shadow-xl">
          {/* Fork options — apply to every fork action below. */}
          <label class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] text-fg-muted">
            <input
              type="checkbox"
              checked={isolate()}
              onChange={(e) => setIsolate(e.currentTarget.checked)}
              title="Give the fork its own git worktree + branch (parent untouched). Off = share the parent's working directory."
            />
            <span>Isolated git worktree</span>
          </label>
          <Show when={isolate()}>
            <label class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] text-fg-muted">
              <input
                type="checkbox"
                checked={fromCurrentState()}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setFromCurrentState(on);
                  // Switching to base mode → default the branch to "main" so the
                  // common "fork off main" is one step (still editable/clearable).
                  if (!on && baseBranch().trim() === "") setBaseBranch("main");
                }}
                title="Carry the parent's current uncommitted changes into the fork. Off = branch clean from a base."
              />
              <span>Fork from current state</span>
            </label>
            <div class="px-3 pb-1.5">
              <input
                type="text"
                value={baseBranch()}
                onInput={(e) => setBaseBranch(e.currentTarget.value)}
                disabled={fromCurrentState()}
                placeholder={fromCurrentState() ? "— using current state —" : "base branch (e.g. main)"}
                title="Branch to fork the worktree from (only when not forking from current state)."
                class="w-full rounded border border-border bg-bg px-2 py-1 text-[12px] text-fg placeholder:text-fg-faint disabled:opacity-50"
              />
            </div>
          </Show>
          <button
            type="button"
            onClick={() => doFork()}
            disabled={!canFork()}
            class="flex w-full items-center justify-between border-t border-border px-3 py-1.5 text-left text-[12px] text-fg-muted transition hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span>fork (same backend)</span>
            <span class="font-mono text-fg-faint">{props.current ?? providers()[0]}</span>
          </button>
          <Show when={otherBackends().length > 0}>
            <div class="border-t border-border px-3 py-1 text-[10px] uppercase tracking-wider text-fg-faint">
              continue on
            </div>
            <For each={otherBackends()}>
              {(id) => (
                <button
                  type="button"
                  onClick={() => doFork(id)}
                  disabled={!canFork()}
                  class="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-fg-muted transition hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <span class="font-mono">{id}</span>
                </button>
              )}
            </For>
          </Show>
          <Show when={error()}>
            <div class="border-t border-danger/40 px-3 py-1.5 text-[11px] text-danger">{error()}</div>
          </Show>
          <div class="border-t border-border px-3 py-1.5 text-[10px] text-fg-faint">
            {!isolate()
              ? "⚠️ Shares the parent's working directory — concurrent edits can collide."
              : fromCurrentState()
                ? "Its own worktree carrying your current changes — parent untouched."
                : baseBranch().trim()
                  ? `Clean branch off \`${baseBranch().trim()}\` in its own worktree — parent untouched.`
                  : "Enter a base branch to fork from."}
          </div>
        </div>
      </Show>
    </div>
  );
};

const DestroyButton: Component<{
  sessionId: string;
  name: string;
}> = (props) => {
  const [confirming, setConfirming] = createSignal(false);
  const act = createAction();
  return (
    <Show
      when={confirming()}
      fallback={
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
            act.clearError();
          }}
          class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-faint transition hover:border-danger/40 hover:text-danger"
          title="Destroy this session"
        >
          destroy
        </button>
      }
    >
      <span class="flex items-center gap-1">
        <span class="text-danger">delete "{props.name}"?</span>
        <button
          type="button"
          disabled={act.busy()}
          onClick={() => {
            // Daemon-confirmed removal only: dropping the session from the
            // local store before the daemon answered silently desynced the
            // list whenever the destroy was rejected (still-running turn,
            // permission). The store mutates on resolve; a rejection keeps
            // the session and surfaces inline instead. Capture the id at
            // click time so the resolve removes the session we asked about.
            const sessionId = props.sessionId;
            act.run(
              {
                type: "session.destroy",
                id: newRequestId(),
                sessionId,
              },
              () => {
                removeSession(sessionId);
                setConfirming(false);
              },
            );
          }}
          class="rounded bg-danger px-2 py-1 font-mono uppercase tracking-wider text-bg hover:bg-danger/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          yes
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            act.clearError();
          }}
          class="rounded border border-border px-2 py-1 font-mono uppercase tracking-wider text-fg-muted hover:bg-bg-hover"
        >
          cancel
        </button>
        <Show when={act.error()}>
          <span role="alert" class="text-[11px] text-danger">
            {act.error()}
          </span>
        </Show>
      </span>
    </Show>
  );
};

export default SessionControls;
