/**
 * Goal-blackboard drawer — what a collaboration has actually produced.
 *
 * The session list shows the fleet; this shows its OUTPUT. Without it a
 * collaboration is a set of sessions whose handoffs happen entirely off-screen
 * (docs/collaborative-session-design.md §4: the orchestrator holds an index,
 * never the bodies — so neither did the UI).
 *
 * Two panes: the index on the left (kind · slot · version · author · size),
 * one artifact body on the right. Bodies are fetched on demand, never with the
 * index — a `diff` can be 256 KB and the whole point of the index is that you
 * can see what exists without paying for it.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { relativeTime } from "../lib/format";
import {
  blackboard,
  clearSelection,
  closeBlackboard,
  isBlackboardOpen,
  refKey,
  refreshBlackboard,
  selectArtifact,
  type ArtifactRef,
} from "../state/blackboard";
import { nowTick } from "../state/clock";
import type { BlackboardIndexEntry } from "../protocol/types";

/**
 * Poll cadence while the drawer is open. A collaboration writes artifacts over
 * minutes, and there is no push channel for the board — a stale panel would
 * make a working fleet look stalled. Cheap: the index carries no bodies.
 */
const REFRESH_MS = 4_000;

/** SDLC flow order (blackboard/types.ts CORE_ARTIFACT_KINDS), so the board
 *  reads as a pipeline rather than alphabetically. Unknown kinds sort last. */
const KIND_ORDER = ["spec", "research", "adr", "task-list", "diff", "findings"];

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const BlackboardDrawer: Component = () => {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isBlackboardOpen()) {
        e.preventDefault();
        closeBlackboard();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Poll only while open, and tear the timer down on close — a background
  // interval against a drawer nobody is looking at is pure waste.
  createEffect(() => {
    if (!isBlackboardOpen()) return;
    const t = setInterval(() => void refreshBlackboard(), REFRESH_MS);
    onCleanup(() => clearInterval(t));
  });

  const sorted = createMemo<BlackboardIndexEntry[]>(() =>
    [...blackboard().entries].sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        a.kind.localeCompare(b.kind) ||
        (a.slot ?? "").localeCompare(b.slot ?? ""),
    ),
  );

  return (
    <Show when={isBlackboardOpen()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-end bg-bg/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeBlackboard();
        }}
      >
        <aside class="flex h-full w-full max-w-4xl flex-col border-l border-border bg-bg-elev shadow-2xl">
          <header class="flex items-center gap-3 border-b border-border px-4 py-3">
            <h2 class="text-base font-semibold tracking-tight text-fg">Blackboard</h2>
            <Show when={blackboard().goal}>
              <span class="min-w-0 flex-1 truncate text-[12px] italic text-fg-muted" title={blackboard().goal}>
                ◇ {blackboard().goal}
              </span>
            </Show>
            <span class="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshBlackboard()}
                class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent/40 hover:text-fg"
                title={`Refresh (auto every ${REFRESH_MS / 1000}s)`}
                aria-label="Refresh blackboard"
              >
                ↻
              </button>
              <button
                type="button"
                onClick={closeBlackboard}
                class="text-fg-faint hover:text-fg"
                title="Close (Esc)"
                aria-label="Close blackboard"
              >
                ✕
              </button>
            </span>
          </header>

          <Show when={blackboard().error}>
            {(e) => (
              <div class="mx-4 mt-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {e()}
              </div>
            )}
          </Show>

          <div class="flex min-h-0 flex-1">
            <IndexPane entries={sorted()} />
            <BodyPane />
          </div>

          <footer class="border-t border-border px-4 py-2 text-[11px] text-fg-faint">
            <Show
              when={blackboard().fetchedAt > 0}
              fallback={<span>loading…</span>}
            >
              {sorted().length} artifact{sorted().length === 1 ? "" : "s"} · updated{" "}
              {relativeTime(blackboard().fetchedAt, nowTick())} · writes append, so
              every version stays readable
            </Show>
          </footer>
        </aside>
      </div>
    </Show>
  );
};

const IndexPane: Component<{ entries: BlackboardIndexEntry[] }> = (props) => {
  const selectedKey = () => {
    const s = blackboard().selected;
    return s ? refKey(s) : null;
  };
  return (
    <nav class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border py-2">
      <Show
        when={props.entries.length > 0}
        fallback={
          <p class="px-4 py-6 text-[12px] text-fg-faint">
            Nothing written yet. Role-children publish here as they finish their
            handoffs — a searcher writes <code class="font-mono">research</code>,
            each reviewer writes its own <code class="font-mono">findings</code>.
          </p>
        }
      >
        <For each={props.entries}>
          {(e) => {
            const ref: ArtifactRef = { kind: e.kind, slot: e.slot };
            const active = () => selectedKey() === refKey(ref);
            return (
              <button
                type="button"
                onClick={() => void selectArtifact(ref)}
                aria-current={active() ? "true" : undefined}
                class={`flex flex-col gap-0.5 border-l-2 px-3 py-2 text-left transition hover:bg-bg-hover ${
                  active() ? "border-l-accent bg-bg-active" : "border-l-transparent"
                }`}
              >
                <div class="flex items-baseline gap-1.5">
                  <span class="font-mono text-[12px] font-medium text-fg">{e.kind}</span>
                  {/* The slot is what keeps a panel from collapsing into one
                      voice, so it is shown, never folded into the kind. */}
                  <Show when={e.slot}>
                    {(slot) => (
                      <span class="font-mono text-[11px] text-accent" title="Writer slot">
                        {slot()}
                      </span>
                    )}
                  </Show>
                  <span class="ml-auto font-mono text-[10px] text-fg-faint" title="Latest version">
                    v{e.version}
                  </span>
                </div>
                <div class="flex items-center gap-1.5 text-[10px] text-fg-muted">
                  <span title={`Author: ${e.authorSub}`}>{e.authorRole ?? "—"}</span>
                  <span class="text-fg-faint">·</span>
                  <span>{formatBytes(e.bytes)}</span>
                  <span class="text-fg-faint">·</span>
                  <span>{relativeTime(e.updatedAt, nowTick())}</span>
                </div>
              </button>
            );
          }}
        </For>
      </Show>
    </nav>
  );
};

const BodyPane: Component = () => {
  const [copied, setCopied] = createSignal(false);
  return (
    <section class="flex min-w-0 flex-1 flex-col">
      <Show
        when={blackboard().selected}
        fallback={
          <p class="px-6 py-8 text-[12px] text-fg-faint">
            Pick an artifact to read it. Bodies are fetched on demand — the index
            deliberately carries only sizes, so opening the board never pulls a
            256 KB diff you didn't ask for.
          </p>
        }
      >
        {(sel) => (
          <>
            <div class="flex items-center gap-2 border-b border-border px-4 py-2">
              <span class="font-mono text-[13px] font-semibold text-fg">
                {sel().kind}
                <Show when={sel().slot}>
                  {(slot) => <span class="ml-1.5 text-accent">{slot()}</span>}
                </Show>
              </span>
              <Show when={blackboard().artifact}>
                {(a) => (
                  <span class="font-mono text-[11px] text-fg-faint">
                    v{a().version} · {a().authorRole ?? "unknown role"} ·{" "}
                    {relativeTime(a().createdAt, nowTick())}
                  </span>
                )}
              </Show>
              <span class="ml-auto flex items-center gap-2">
                <Show when={blackboard().artifact}>
                  {(a) => (
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(a().content).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1200);
                        });
                      }}
                      class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent/40 hover:text-fg"
                    >
                      {copied() ? "copied" : "copy"}
                    </button>
                  )}
                </Show>
                <button
                  type="button"
                  onClick={clearSelection}
                  class="text-fg-faint hover:text-fg"
                  title="Close artifact"
                  aria-label="Close artifact"
                >
                  ✕
                </button>
              </span>
            </div>
            <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
              <Show when={blackboard().artifactError}>
                {(e) => (
                  <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                    {e()}
                  </div>
                )}
              </Show>
              <Show when={blackboard().artifactLoading}>
                <div class="text-xs text-fg-faint">loading…</div>
              </Show>
              <Show when={blackboard().artifact} fallback={<Unwritten loading={blackboard().artifactLoading} />}>
                {(a) => (
                  <pre class="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg">
                    {a().content}
                  </pre>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  );
};

/**
 * An artifact the index listed but that reads back empty. Normal mid-flight —
 * the daemon returns `null` rather than an error precisely so this renders as
 * pending instead of as a failure.
 */
const Unwritten: Component<{ loading: boolean }> = (props) => (
  <Show when={!props.loading}>
    <p class="text-[12px] italic text-fg-faint">
      Not written yet — the role responsible for it hasn't published a version.
    </p>
  </Show>
);

export default BlackboardDrawer;
