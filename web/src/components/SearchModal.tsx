/**
 * Cross-session search — Ctrl+K. Hits `session.search` with a debounced
 * query and renders ranked sessions with snippet previews. Clicking a
 * hit focuses that session.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { getClient, newRequestId } from "../state/connection";
import { focusSession, focusedSession } from "../state/sessions";
import { setPendingSearchJump } from "../state/search-jump";
import { relativeTime } from "../lib/format";
import type {
  SessionSearchHit,
  SessionSearchResultMsg,
} from "../protocol/types";

const DEBOUNCE_MS = 220;

/**
 * Which sessions a search covers. `workspace` scopes to the focused session's
 * directory; `all` runs the cross-workspace resolution path (global fusion +
 * cross-encoder rerank) — see docs/session-resolution.md.
 *
 * A workspace is a DIRECTORY, not a session family: every session that ever
 * ran in that workdir under the same tenant shares it. Forks isolated into a
 * git worktree get their own path, so they land OUTSIDE the parent's scope —
 * which is precisely the case cross-workspace search exists to recover.
 */
type SearchScope = "workspace" | "all";

const SearchModal: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SessionSearchHit[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [highlight, setHighlight] = createSignal(0);
  // Null until the user chooses; the effective scope falls back to "scoped if
  // something is focused". Keeping the override separate from the derived
  // default means focusing a session later doesn't silently undo the choice.
  const [scopeOverride, setScopeOverride] = createSignal<SearchScope | null>(null);
  const scope = createMemo<SearchScope>(
    () => scopeOverride() ?? (focusedSession()?.workdir ? "workspace" : "all"),
  );
  /** Scoping is only meaningful when there is a workspace to scope to. */
  const canScope = createMemo(() => Boolean(focusedSession()?.workdir));

  let inputRef: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let runId = 0;

  function reset(): void {
    setQuery("");
    setHits([]);
    setError(null);
    setHighlight(0);
    setBusy(false);
    setScopeOverride(null);
  }

  // Global Ctrl+K to toggle, Esc to close.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        if (open()) requestAnimationFrame(() => inputRef?.focus());
      } else if (e.key === "Escape" && open()) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Reset on close.
  createEffect(
    on(open, (v) => {
      if (!v) reset();
      else requestAnimationFrame(() => inputRef?.focus());
    }),
  );

  // Debounce + dispatch search on every query OR scope change, so flipping
  // the scope re-runs the current query through the other regime rather than
  // leaving stale hits from the previous one on screen.
  createEffect(
    on([query, scope] as const, async ([q]) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const trimmed = q.trim();
      if (trimmed.length < 2) {
        // Invalidate any in-flight request too — its debounce may already
        // have fired, and without the bump its stale hits would repopulate
        // the list under the "type at least 2 characters" hint.
        runId += 1;
        setHits([]);
        setBusy(false);
        setError(null);
        return;
      }
      const myRun = ++runId;
      setBusy(true);
      debounceTimer = setTimeout(async () => {
        try {
          const id = newRequestId();
          const result = await getClient().request<SessionSearchResultMsg>(
            {
              type: "session.search",
              id,
              query: trimmed,
              limit: 10,
              // Omit the anchor entirely when global — passing a workdir
              // alongside scope:"all" is contradictory, and the daemon
              // decides global-vs-scoped on the workspaceId's absence.
              ...(scope() === "workspace" && focusedSession()?.workdir
                ? { workdir: focusedSession()!.workdir, scope: "workspace" as const }
                : { scope: "all" as const }),
            },
            {
              waitForResult: (m) =>
                m.type === "session.search.result" && m.requestId === id ? m : undefined,
              timeoutMs: 8_000,
            },
          );
          if (myRun !== runId) return;
          setHits(result.sessions);
          setError(null);
        } catch (err) {
          if (myRun !== runId) return;
          setError(err instanceof Error ? err.message : String(err));
          setHits([]);
        } finally {
          if (myRun === runId) setBusy(false);
        }
      }, DEBOUNCE_MS);
    }),
  );

  function pick(idx: number): void {
    const hit = hits()[idx];
    if (!hit) return;
    // Queue the jump BEFORE focusSession so the Transcript's effect sees
    // the target on the same tick its messages list switches over —
    // otherwise the auto-scroll-to-bottom on session focus runs first
    // and the jump fights it.
    const topSnippet = hit.snippets[0];
    setPendingSearchJump({
      sessionId: hit.sessionId,
      query: query().trim(),
      excerpt: topSnippet?.excerpt,
    });
    focusSession(hit.sessionId);
    setOpen(false);
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setHighlight((h) => Math.min(h + 1, hits().length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      pick(highlight());
    }
  }

  return (
    <Show when={open()}>
      <div
        class="fixed inset-0 z-40 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div class="mt-[12vh] w-full max-w-2xl rounded-lg border border-border bg-bg-elev shadow-2xl">
          <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <span class="text-fg-faint">🔍</span>
            <input
              ref={inputRef}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Search messages, tools, code…"
              class="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
              autocomplete="off"
              spellcheck={false}
            />
            <Show when={canScope()}>
              <div
                class="flex shrink-0 overflow-hidden rounded border border-border text-[10px]"
                role="group"
                aria-label="Search scope"
              >
                <button
                  type="button"
                  onClick={() => setScopeOverride("workspace")}
                  aria-pressed={scope() === "workspace"}
                  title="Search only sessions that ran in this session's directory"
                  class={`px-2 py-0.5 transition ${
                    scope() === "workspace"
                      ? "bg-bg-active text-fg"
                      : "text-fg-faint hover:bg-bg-hover"
                  }`}
                >
                  This workspace
                </button>
                <button
                  type="button"
                  onClick={() => setScopeOverride("all")}
                  aria-pressed={scope() === "all"}
                  title="Search every workspace, including forks isolated in their own git worktree"
                  class={`border-l border-border px-2 py-0.5 transition ${
                    scope() === "all"
                      ? "bg-bg-active text-fg"
                      : "text-fg-faint hover:bg-bg-hover"
                  }`}
                >
                  All workspaces
                </button>
              </div>
            </Show>
            <span class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
              Ctrl+K
            </span>
          </div>
          <ResultsBody
            busy={busy()}
            error={error()}
            query={query()}
            hits={hits()}
            highlight={highlight()}
            setHighlight={setHighlight}
            onPick={pick}
            scope={scope()}
            onWiden={() => setScopeOverride("all")}
          />
        </div>
      </div>
    </Show>
  );
};

const ResultsBody: Component<{
  busy: boolean;
  error: string | null;
  query: string;
  hits: SessionSearchHit[];
  highlight: number;
  setHighlight: (n: number) => void;
  onPick: (idx: number) => void;
  scope: SearchScope;
  onWiden: () => void;
}> = (props) => {
  const empty = createMemo(
    () =>
      !props.busy &&
      !props.error &&
      props.query.trim().length >= 2 &&
      props.hits.length === 0,
  );
  return (
    <div class="max-h-[60vh] overflow-y-auto">
      <Show when={props.error}>
        <div class="p-3 text-sm text-danger">{props.error}</div>
      </Show>
      <Show when={props.busy}>
        <div class="p-3 text-xs text-fg-faint">searching…</div>
      </Show>
      <Show when={empty()}>
        <div class="p-6 text-center text-sm text-fg-muted">
          <p>No matches in {props.scope === "all" ? "any workspace" : "this workspace"}.</p>
          <Show when={props.scope === "workspace"}>
            <button
              type="button"
              onClick={props.onWiden}
              class="mt-2 rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-bg-hover hover:text-fg"
            >
              Search all workspaces
            </button>
          </Show>
        </div>
      </Show>
      <Show when={!props.busy && !props.error && props.query.trim().length < 2}>
        <div class="p-6 text-center text-sm text-fg-muted">
          <p>Type at least 2 characters to search across sessions.</p>
          <p class="mt-1 text-xs text-fg-faint">
            {props.scope === "all"
              ? "Searching every workspace."
              : "Searching this session's directory only."}
          </p>
        </div>
      </Show>
      <ul class="divide-y divide-border">
        <For each={props.hits}>
          {(hit, idx) => (
            <li
              onClick={() => props.onPick(idx())}
              onMouseEnter={() => props.setHighlight(idx())}
              class={`cursor-pointer px-3 py-2 transition ${
                idx() === props.highlight ? "bg-bg-active" : "hover:bg-bg-hover"
              }`}
            >
              <div class="flex items-center gap-2 text-sm">
                <span class="font-medium text-fg">{hit.sessionName}</span>
                <span class="font-mono text-[11px] text-fg-faint">{hit.workdir}</span>
                <span class="ml-auto text-[10px] text-fg-faint">
                  {hit.matchCount} matches · last {relativeTime(hit.lastMatchAt)}
                </span>
              </div>
              <div class="mt-1 space-y-1">
                <For each={hit.snippets.slice(0, 2)}>
                  {(s) => (
                    <div class="truncate text-[11px] text-fg-muted">
                      <span class="text-accent">{s.kind}</span>
                      {s.toolName ? ` · ${s.toolName}` : ""} · {s.excerpt}
                    </div>
                  )}
                </For>
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};

export default SearchModal;
