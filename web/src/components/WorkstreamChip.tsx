/**
 * A session's home workstream (docs/workstreams-design.md), as a chip: its
 * name in its color, amber when homed past another workstream's claim
 * (override), red when its workstream was removed (orphaned), and "no
 * workstream" when nothing matched. Absent on a daemon without workstreams.
 *
 * `editable` (the session header): the chip opens a panel with the
 * workstreams the session reads (§7.2), to add or take one away, and a move
 * to another home (§5.3). The daemon judges each by the share policy; an
 * `ask` one may be asked of the owner on the session.
 */

import { type Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";

import type { SessionInfo } from "../protocol/types";
import { changeSessionWorkstream, fetchWorkstreams, homeChoices, workstreamsState } from "../state/workstreams";

/** A config color as a CSS color, or none: a name or a #hex only — never arbitrary CSS. */
export function chipColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return /^#[0-9a-fA-F]{3,8}$/.test(color) || /^[a-zA-Z]{3,20}$/.test(color) ? color : undefined;
}

const button =
  "rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";
const select = "min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg focus:border-accent focus:outline-none";

export const WorkstreamChip: Component<{ session: SessionInfo; editable?: boolean }> = (props) => {
  const ws = () => props.session.workstream;
  const tone = () => {
    const w = ws();
    if (w?.orphaned) return "border-danger/50 bg-danger/10 text-danger";
    if (w?.source === "override") return "border-warn/50 bg-warn/10 text-warn";
    if (!w?.id) return "border-border bg-bg text-fg-faint";
    return "border-border bg-bg text-fg-muted";
  };
  const title = () => {
    const w = ws();
    if (!w) return "";
    if (w.orphaned) return `Workstream "${w.id}" is no longer configured: move this session to another`;
    const reads = w.references?.length ? `\nReads: ${w.references.map((r) => r.workstream).join(", ")}` : "";
    if (!w.id) return `No workstream: no rule matched this folder and no default is set${reads}`;
    const how =
      w.source === "matched" ? `matched by ${w.matchedBy ?? "a rule"}`
      : w.source === "default" ? "the default workstream"
      : w.source === "explicit" ? "chosen"
      : w.source === "override" ? "chosen past the folder's own workstream"
      : w.source === "migrated" ? "from its folder, when workstreams were set up"
      : w.source;
    return `Workstream ${w.name ?? w.id} — ${how}${reads}`;
  };
  const label = () => {
    const w = ws();
    const n = w?.references?.length ?? 0;
    return `${w?.id ? (w.name ?? w.id) : "no workstream"}${n > 0 ? ` +${n}` : ""}`;
  };
  const [open, setOpen] = createSignal(false);
  let chip: HTMLButtonElement | undefined;
  const dot = () => (
    <Show when={chipColor(ws()?.color)}>
      {(c) => <span class="inline-block h-1.5 w-1.5 rounded-full" style={{ "background-color": c() }} aria-hidden="true" />}
    </Show>
  );
  const cls = () => `inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider ${tone()}`;
  return (
    <Show when={ws()}>
      <Show
        when={props.editable && ws()?.source !== "reserved"}
        fallback={
          <span class={cls()} title={title()} data-testid="workstream-chip">
            {dot()}
            {label()}
          </span>
        }
      >
        <button
          type="button"
          ref={chip}
          class={`${cls()} hover:border-accent/40`}
          title={title()}
          data-testid="workstream-chip"
          aria-haspopup="dialog"
          aria-expanded={open()}
          onClick={() => {
            if (!open()) void fetchWorkstreams();
            setOpen(!open());
          }}
        >
          {dot()}
          {label()}
        </button>
        <Show when={open()}>
          <WorkstreamPanel session={props.session} anchor={chip} onClose={() => setOpen(false)} />
        </Show>
      </Show>
    </Show>
  );
};

/** The chip's panel: what the session reads, and where it lives. Fixed, so a header's overflow never clips it. */
const WorkstreamPanel: Component<{ session: SessionInfo; anchor: HTMLElement | undefined; onClose: () => void }> = (props) => {
  const ws = () => props.session.workstream;
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<{ text: string; error: boolean } | null>(null);
  const [addId, setAddId] = createSignal("");
  const [moveId, setMoveId] = createSignal("");
  const nameOf = (id: string) => workstreamsState().workstreams.find((w) => w.id === id)?.name ?? id;
  const shareOf = (id: string) => workstreamsState().workstreams.find((w) => w.id === id)?.share;
  const referenced = () => new Set((ws()?.references ?? []).map((r) => r.workstream));
  const addable = () => homeChoices().filter((w) => w.share !== "closed" && w.id !== ws()?.id && !referenced().has(w.id));
  const movable = () => homeChoices().filter((w) => w.id !== ws()?.id);
  const run = async (fn: () => Promise<{ pending: boolean }>, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      setNote({ text: r.pending ? "Asked on the session: it applies once you confirm there." : done, error: false });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  // Below the chip, kept inside the window; placed again when the window changes.
  const place = () => {
    const rect = props.anchor?.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - width - 8));
    return { width, left, top: (rect?.bottom ?? 40) + 4 };
  };
  const [pos, setPos] = createSignal(place());
  const onResize = () => setPos(place());
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
  });
  let dialog: HTMLDivElement | undefined;
  onMount(() => dialog?.focus());
  return (
    <>
      <div class="fixed inset-0 z-30" onClick={() => props.onClose()} aria-hidden="true" />
      <div
        ref={dialog}
        role="dialog"
        aria-label="Workstream"
        tabIndex={-1}
        class="fixed z-40 space-y-3 overflow-y-auto rounded-lg border border-border bg-bg-elev p-3 text-[12px] shadow-2xl focus:outline-none"
        style={{ left: `${pos().left}px`, top: `${pos().top}px`, width: `${pos().width}px`, "max-height": `calc(100vh - ${pos().top + 8}px)` }}
      >
        <div>
          <div class="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Home</div>
          <div class="text-fg">{ws()?.id ? nameOf(ws()!.id!) : "none"}</div>
        </div>
        <div class="space-y-1">
          <div class="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Reads</div>
          <Show when={(ws()?.references?.length ?? 0) > 0} fallback={<div class="text-fg-muted">No other workstream.</div>}>
            <For each={ws()?.references ?? []}>
              {(r) => (
                <div class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-fg" title={r.paths?.join(", ") ?? "all its folders"}>
                    {nameOf(r.workstream)}
                    <span class="text-fg-faint"> — {r.paths ? r.paths.join(", ") : "all its folders"}</span>
                  </span>
                  <button
                    type="button"
                    class={button}
                    disabled={busy()}
                    onClick={() => void run(() => changeSessionWorkstream(props.session.id, { kind: "remove_reference", workstream: r.workstream }), `No longer reads ${nameOf(r.workstream)} (from the next turn).`)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </Show>
          <Show when={addable().length > 0}>
            <div class="flex gap-2">
              <select class={select} aria-label="Add a workstream to read" value={addId()} onChange={(e) => setAddId(e.currentTarget.value)}>
                <option value="">Read another workstream…</option>
                <For each={addable()}>{(w) => <option value={w.id}>{`${w.name}${w.share === "ask" ? " (asks)" : ""}`}</option>}</For>
              </select>
              <button
                type="button"
                class={button}
                disabled={busy() || !addId()}
                onClick={() => {
                  const id = addId();
                  void run(() => changeSessionWorkstream(props.session.id, { kind: "add_reference", workstream: id }), `Reads ${nameOf(id)} from the next turn.`).then(() => setAddId(""));
                }}
              >
                Add
              </button>
            </div>
          </Show>
        </div>
        <Show when={movable().length > 0}>
          <div class="space-y-1">
            <div class="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Move to</div>
            <div class="flex gap-2">
              <select class={select} aria-label="Move to workstream" value={moveId()} onChange={(e) => setMoveId(e.currentTarget.value)}>
                <option value="">Another workstream…</option>
                <For each={movable()}>{(w) => <option value={w.id}>{w.name}</option>}</For>
              </select>
              <button
                type="button"
                class={button}
                disabled={busy() || !moveId()}
                onClick={() => {
                  const id = moveId();
                  void run(() => changeSessionWorkstream(props.session.id, { kind: "set_workstream", workstream: id }), `Moved to ${nameOf(id)}: its servers, credentials and sandbox from the next turn.`).then(() => setMoveId(""));
                }}
              >
                Move
              </button>
            </div>
            <Show when={moveId() && shareOf(ws()?.id ?? "") === "ask"}>
              <div class="text-fg-faint">The whole conversation goes with it: “{nameOf(ws()?.id ?? "")}” shares only with approval.</div>
            </Show>
          </div>
        </Show>
        <Show when={note()}>
          {(n) => (
            <div class={`rounded border px-2 py-1 ${n().error ? "border-danger/40 bg-danger/10 text-danger" : "border-border text-fg-muted"}`} role={n().error ? "alert" : "status"}>
              {n().text}
            </div>
          )}
        </Show>
      </div>
    </>
  );
};
