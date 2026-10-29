/**
 * Modal directory picker — drives the daemon's `fs.browse_dir` verb.
 *
 * Opens at the caller's `initialPath` (or the nearest folder of it that
 * exists), else where the picker was last left, else the daemon user's home.
 * The daemon bounds browsing to its root (the whole filesystem unless
 * `CODEOID_FS_BROWSE_ROOT` is set) and never lists credential stores.
 *
 * One input does both jobs (lib/dir-picker.ts): plain text filters the folder
 * on screen; `/…` or `~/…` is a path whose directory is browsed as you type,
 * Tab completes the highlighted folder, Enter opens it. A places rail gives
 * home, the root and recent session workdirs. Keyboard:
 *   ↑/↓ move · Enter open · Tab complete · Backspace (empty) up ·
 *   ⌘/Ctrl+Enter select · Esc clear, then close.
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
} from "solid-js";

import { getClient, newRequestId } from "../../state/connection";
import { sessionList } from "../../state/sessions";
import type { FsBrowseDirResultMsg, FsEntry } from "../../protocol/types";
import {
  breadcrumbs,
  filterEntries,
  isPathQuery,
  matchRange,
  parseQuery,
  sameDir,
  selfAndAncestors,
  tildify,
} from "../../lib/dir-picker";
import { relativeTime } from "../../lib/format";

interface Listing {
  path: string;
  root: string;
  home: string | null;
  parent: string | null;
  isGitRepo: boolean;
  hiddenCount: number;
  entries: FsEntry[];
}

const HIDDEN_KEY = "codeoid.dirPicker.showHidden";

/** Where the picker was last left, so reopening it without a path resumes there. */
let lastPath: string | undefined;

export function _resetDirectoryPickerForTest(): void {
  lastPath = undefined;
}

function readShowHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeShowHidden(v: boolean): void {
  try {
    localStorage.setItem(HIDDEN_KEY, v ? "1" : "0");
  } catch {
    // Private window / blocked storage — the toggle just isn't remembered.
  }
}

function basename(p: string): string {
  if (p === "/") return "/";
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

const DirectoryPicker: Component<{
  open: boolean;
  /** Initial directory to start browsing in (absolute or `~/…`). Defaults to HOME. */
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}> = (props) => {
  const [listing, setListing] = createSignal<Listing | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(-1);
  const [showHidden, setShowHidden] = createSignal(readShowHidden());

  let input: HTMLInputElement | undefined;
  let listEl: HTMLUListElement | undefined;
  // Only the newest request may land: typing a path fires one per keystroke.
  let seq = 0;
  // The directory part of the last path query browsed, so a keystroke in the
  // last segment filters instead of refetching.
  let queriedDir: string | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(debounce));

  async function fetchDir(path: string | undefined): Promise<Listing> {
    const id = newRequestId();
    const r = await getClient().request<FsBrowseDirResultMsg>(
      {
        type: "fs.browse_dir",
        id,
        ...(path ? { path } : {}),
        ...(showHidden() ? { showHidden: true } : {}),
      },
      {
        waitForResult: (m) =>
          m.type === "fs.browse_dir.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    );
    return {
      path: r.path,
      root: r.root,
      home: r.home ?? null,
      parent: r.parent,
      isGitRepo: r.isGitRepo ?? false,
      hiddenCount: r.hiddenCount ?? 0,
      entries: r.entries,
    };
  }

  /**
   * Show `path`. A failure keeps the current listing on screen with the error
   * above it, so a mistyped path never blanks the picker. Resolves true when
   * the folder was shown.
   */
  async function browse(path: string | undefined, opts: { keepQuery?: boolean } = {}): Promise<boolean> {
    const mine = ++seq;
    setLoading(true);
    try {
      const next = await fetchDir(path);
      if (mine !== seq) return false;
      setListing(next);
      setError(null);
      lastPath = next.path;
      if (!opts.keepQuery) {
        setQuery("");
        queriedDir = null;
      }
      // Highlight only while narrowing, so ⌘↵ on `/a/b/` selects b itself.
      setActive(opts.keepQuery && parseQuery(query()).needle ? 0 : -1);
      listEl?.scrollTo?.({ top: 0 });
      return true;
    } catch (err) {
      if (mine === seq) setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (mine === seq) setLoading(false);
    }
  }

  /** Open at `start`, or the nearest ancestor of it that still exists. */
  async function openAt(start: string | undefined): Promise<void> {
    setNotice(null);
    if (!start) {
      await browse(undefined);
      return;
    }
    const candidates = selfAndAncestors(start);
    for (const [i, p] of candidates.entries()) {
      if (await browse(p)) {
        if (i > 0) setNotice(`${start} isn't available — showing the nearest folder above it.`);
        return;
      }
    }
    setNotice(`${start} isn't available.`);
    await browse(undefined);
  }

  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return;
        setQuery("");
        setError(null);
        queriedDir = null;
        const initial = props.initialPath?.trim();
        // A relative workdir ("." = the daemon's cwd) means nothing to the
        // browser, whose relative paths are against its root.
        const usable = initial && (initial.startsWith("/") || isPathQuery(initial)) ? initial : undefined;
        void openAt(usable ?? lastPath);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  const parsed = createMemo(() => parseQuery(query()));
  const visible = createMemo(() => filterEntries(listing()?.entries ?? [], parsed().needle));

  // Typing a path browses its directory part (debounced), once per change of it.
  createEffect(
    on(query, (q) => {
      clearTimeout(debounce);
      const { dir, needle } = parseQuery(q);
      setActive(needle ? 0 : -1);
      if (dir === null) {
        queriedDir = null;
        return;
      }
      if (queriedDir !== null && sameDir(dir, queriedDir)) return;
      const current = listing()?.path;
      queriedDir = dir;
      if (current && sameDir(dir, current)) return;
      debounce = setTimeout(() => void browse(dir, { keepQuery: true }), 120);
    }),
  );

  // Keep the highlighted row in view.
  createEffect(() => {
    const i = active();
    if (i < 0 || !listEl) return;
    listEl.querySelector<HTMLElement>(`[data-row="${i}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  const highlighted = (): FsEntry | undefined => {
    const i = active();
    return i >= 0 ? visible()[i] : undefined;
  };

  /** What "Select" would hand back: the highlighted folder, else the one on screen. */
  const target = (): string | undefined => highlighted()?.path ?? listing()?.path;

  function pick(path: string | undefined): void {
    if (!path) return;
    lastPath = path;
    props.onPick(path);
    props.onClose();
  }

  function goUp(): void {
    const parent = listing()?.parent;
    if (parent) void browse(parent);
  }

  function complete(entry: FsEntry): void {
    const home = listing()?.home ?? null;
    // Stay in the notation the user typed in.
    const base = query().startsWith("~") ? tildify(entry.path, home) : entry.path;
    setQuery(base.endsWith("/") ? base : `${base}/`);
    input?.focus();
  }

  function onEnter(): void {
    const entry = highlighted();
    if (entry) {
      void browse(entry.path);
      return;
    }
    const q = query().trim();
    if (isPathQuery(q)) void browse(q);
  }

  // Window + capture phase: the modal under the picker (new session, an
  // automation drawer) also listens for Esc, and must not see this one.
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement === input;
      const handled = (): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        handled();
        if (query()) setQuery("");
        else props.onClose();
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        handled();
        pick(target());
        return;
      }
      if (!typing) return;
      const n = visible().length;
      switch (e.key) {
        case "ArrowDown":
          handled();
          if (n) setActive((i) => (i + 1) % n);
          return;
        case "ArrowUp":
          handled();
          if (e.altKey) goUp();
          else if (n) setActive((i) => (i <= 0 ? n - 1 : i - 1));
          return;
        case "Enter":
          handled();
          onEnter();
          return;
        case "Tab": {
          const entry = highlighted() ?? (n === 1 ? visible()[0] : undefined);
          if (entry && !e.shiftKey) {
            handled();
            complete(entry);
          }
          return;
        }
        case "Backspace":
          if (!query()) {
            handled();
            goUp();
          }
          return;
        case "l":
          if (e.metaKey || e.ctrlKey) {
            handled();
            const p = listing()?.path;
            if (p) setQuery(p.endsWith("/") ? p : `${p}/`);
          }
          return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const recent = createMemo<string[]>(() => {
    const counts = new Map<string, number>();
    for (const s of sessionList()) {
      if (s.workdir) counts.set(s.workdir, (counts.get(s.workdir) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([wd]) => wd)
      .slice(0, 6);
  });

  const places = createMemo(() => {
    const l = listing();
    if (!l) return [] as { label: string; path: string; hint: string }[];
    const out: { label: string; path: string; hint: string }[] = [];
    if (l.home) out.push({ label: "Home", path: l.home, hint: l.home });
    out.push({ label: l.root === "/" ? "Computer" : basename(l.root), path: l.root, hint: l.root });
    return out;
  });

  function toggleHidden(): void {
    const v = !showHidden();
    setShowHidden(v);
    writeShowHidden(v);
    const p = listing()?.path;
    void browse(p, { keepQuery: true });
    input?.focus();
  }

  const targetLabel = () => {
    const t = target();
    return t ? basename(t) : "";
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-stretch justify-center bg-bg/70 backdrop-blur-sm sm:items-start"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose a folder"
          class="flex w-full flex-col overflow-hidden border-border bg-bg-elev shadow-2xl sm:mx-4 sm:mt-[8vh] sm:max-h-[80vh] sm:max-w-3xl sm:rounded-lg sm:border"
        >
          <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <FolderIcon class="h-4 w-4 text-accent" />
            <span class="font-semibold text-fg">Choose a folder</span>
            <span class="text-[11px] text-fg-faint">on the daemon host</span>
            <button
              type="button"
              onClick={() => props.onClose()}
              class="ml-auto rounded px-1.5 text-fg-faint hover:bg-bg-hover hover:text-fg"
              title="Close (Esc)"
              aria-label="Close"
            >
              ✕
            </button>
          </header>

          <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
            {/* Places: a rail on wide screens, a chip row on phones. */}
            <nav
              aria-label="Places"
              class="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-2 sm:w-48 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden sm:border-b-0 sm:border-r"
            >
              <span class="hidden px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-faint sm:block">
                Places
              </span>
              <For each={places()}>
                {(p) => (
                  <PlaceButton
                    label={p.label}
                    title={p.hint}
                    current={listing()?.path === p.path}
                    onClick={() => void browse(p.path)}
                    icon={p.label === "Home" ? "home" : "drive"}
                  />
                )}
              </For>
              <Show when={recent().length > 0}>
                <span class="hidden px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-fg-faint sm:block">
                  Recent workdirs
                </span>
                <For each={recent()}>
                  {(wd) => (
                    <PlaceButton
                      label={basename(wd)}
                      title={wd}
                      current={listing()?.path === wd}
                      onClick={() => void openAt(wd)}
                      icon="clock"
                    />
                  )}
                </For>
              </Show>
            </nav>

            <div class="flex min-h-0 min-w-0 flex-1 flex-col">
              <Breadcrumbs
                listing={listing()}
                onNavigate={(p) => void browse(p)}
                onEdit={() => {
                  const p = listing()?.path;
                  if (p) setQuery(p.endsWith("/") ? p : `${p}/`);
                  input?.focus();
                }}
              />

              <div class="border-b border-border/50 px-3 py-2">
                <div class="flex items-center gap-2 rounded border border-border bg-bg px-2 focus-within:border-accent">
                  <span class="font-mono text-[12px] text-fg-faint" aria-hidden="true">
                    {isPathQuery(query()) ? "→" : "⌕"}
                  </span>
                  <input
                    ref={input}
                    type="text"
                    autocomplete="off"
                    spellcheck={false}
                    aria-label="Filter folders, or type a path"
                    aria-controls="dir-picker-list"
                    aria-activedescendant={active() >= 0 ? `dir-picker-row-${active()}` : undefined}
                    placeholder="Filter, or type a path: / or ~/"
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    class="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-sm text-fg placeholder:text-fg-faint"
                    // The wrapper's border shows focus; the global :focus-visible
                    // ring (unlayered, so no utility beats it) would draw a second one.
                    style={{ outline: "none" }}
                  />
                  <Show when={loading()}>
                    <span class="h-3 w-3 animate-spin rounded-full border border-fg-faint border-t-transparent" aria-label="loading" />
                  </Show>
                </div>
              </div>

              <Show when={notice()}>
                <div class="border-b border-border/50 bg-warn/5 px-3 py-1.5 text-[12px] text-warn">{notice()}</div>
              </Show>
              <Show when={error()}>
                <div role="alert" class="border-b border-border/50 bg-danger/5 px-3 py-1.5 text-[12px] text-danger">
                  {error()}
                </div>
              </Show>

              <ul
                id="dir-picker-list"
                ref={listEl}
                role="listbox"
                aria-label="Folders"
                class="min-h-16 flex-1 overflow-y-auto py-1 sm:max-h-[50vh] [@media(min-height:560px)]:min-h-[12rem]"
              >
                <Show when={listing()?.parent && !parsed().needle}>
                  <li>
                    <button
                      type="button"
                      onClick={goUp}
                      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-bg-hover"
                      title="Up one level (Backspace)"
                    >
                      <span class="w-4 text-center font-mono">↑</span>
                      <span class="font-mono text-[12px]">..</span>
                    </button>
                  </li>
                </Show>
                <For each={visible()}>
                  {(entry, i) => (
                    <Row
                      entry={entry}
                      index={i()}
                      active={active() === i()}
                      needle={parsed().needle}
                      onHover={() => setActive(i())}
                      onOpen={() => void browse(entry.path)}
                      onPick={() => pick(entry.path)}
                    />
                  )}
                </For>
                <Show when={listing() && visible().length === 0 && !loading()}>
                  <li class="px-6 py-8 text-center text-sm text-fg-muted">
                    <Show
                      when={parsed().needle}
                      fallback={
                        <>
                          No subfolders here.
                          <Show when={(listing()?.hiddenCount ?? 0) > 0 && !showHidden()}>
                            {" "}
                            <button type="button" class="text-accent hover:underline" onClick={toggleHidden}>
                              Show {listing()?.hiddenCount} hidden
                            </button>
                          </Show>
                        </>
                      }
                    >
                      No folder matches “{parsed().needle}”.
                      <Show when={!isPathQuery(query())}>
                        <div class="mt-1 text-[11px] text-fg-faint">Type a path starting with / or ~ to jump elsewhere.</div>
                      </Show>
                    </Show>
                  </li>
                </Show>
              </ul>
            </div>
          </div>

          <footer class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2">
            <label class="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-fg-muted">
              <input type="checkbox" checked={showHidden()} onChange={toggleHidden} class="accent-[var(--color-accent)]" />
              Hidden folders
              <Show when={!showHidden() && (listing()?.hiddenCount ?? 0) > 0}>
                <span class="text-fg-faint">({listing()?.hiddenCount})</span>
              </Show>
            </label>
            <span class="hidden font-mono text-[10px] text-fg-faint md:inline">
              ↑↓ move · ↵ open · ⇥ complete · ⌫ up · ⌘↵ select
            </span>
            <div class="ml-auto flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => props.onClose()}
                class="rounded px-3 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => pick(target())}
                disabled={!target()}
                class="flex min-w-0 items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                title={target() ? `Use ${target()} (⌘/Ctrl+Enter)` : undefined}
              >
                <span>Select</span>
                <span class="max-w-[14rem] truncate font-mono font-normal">{targetLabel()}</span>
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Show>
  );
};

const Row: Component<{
  entry: FsEntry;
  index: number;
  active: boolean;
  needle: string;
  onHover: () => void;
  onOpen: () => void;
  onPick: () => void;
}> = (props) => {
  const parts = () => {
    const r = matchRange(props.entry.name, props.needle);
    const n = props.entry.name;
    return r ? [n.slice(0, r[0]), n.slice(r[0], r[1]), n.slice(r[1])] : [n, "", ""];
  };
  return (
    <li
      id={`dir-picker-row-${props.index}`}
      data-row={props.index}
      role="option"
      aria-selected={props.active}
      class={`group flex items-center gap-2 px-3 py-1 ${props.active ? "bg-bg-active" : "hover:bg-bg-hover"}`}
      onMouseMove={() => {
        if (!props.active) props.onHover();
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={() => props.onOpen()}
        onDblClick={() => props.onPick()}
        class="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left text-sm text-fg"
        title={`${props.entry.path}\nClick to open · double-click to select`}
      >
        <FolderIcon class={`h-4 w-4 shrink-0 ${props.entry.isGitRepo ? "text-accent" : "text-fg-faint"}`} />
        <span class="truncate font-mono">
          {parts()[0]}
          <mark class="rounded-sm bg-accent/20 text-accent">{parts()[1]}</mark>
          {parts()[2]}
        </span>
        <Show when={props.entry.isSymlink}>
          <span class="shrink-0 text-[11px] text-fg-faint" title="Symbolic link">↪</span>
        </Show>
        <Show when={props.entry.isGitRepo}>
          <span class="shrink-0 rounded border border-accent/30 px-1 font-mono text-[9px] uppercase tracking-wider text-accent">
            git
          </span>
        </Show>
      </button>
      <Show when={props.entry.mtimeMs !== undefined}>
        <span class="hidden shrink-0 text-[11px] tabular-nums text-fg-faint sm:inline">
          {relativeTime(props.entry.mtimeMs!)}
        </span>
      </Show>
      <button
        type="button"
        tabIndex={-1}
        onClick={() => props.onPick()}
        class={`shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted transition hover:border-accent/40 hover:text-accent ${
          props.active ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        }`}
        title={`Use ${props.entry.path}`}
      >
        Select
      </button>
    </li>
  );
};

const Breadcrumbs: Component<{
  listing: Listing | null;
  onNavigate: (p: string) => void;
  onEdit: () => void;
}> = (props) => {
  const crumbs = () => {
    const l = props.listing;
    return l ? breadcrumbs(l.path, l.root, l.home) : [];
  };
  return (
    <div class="flex items-center gap-1 border-b border-border/50 px-3 py-1.5">
      <nav aria-label="Path" class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-[12px]">
        <For each={crumbs()}>
          {(c, i) => (
            <>
              {/* The root crumb is "/" itself; a separator after it would read "/ /". */}
              <Show when={i() > 0 && crumbs()[i() - 1]?.label !== "/"}>
                <span class="text-fg-faint">/</span>
              </Show>
              <button
                type="button"
                onClick={() => props.onNavigate(c.path)}
                class={`rounded px-1 font-mono transition hover:bg-bg-hover ${
                  i() === crumbs().length - 1 ? "text-fg" : "text-fg-muted"
                }`}
                title={c.path}
              >
                {c.label}
              </button>
            </>
          )}
        </For>
        <Show when={props.listing?.isGitRepo}>
          <span class="ml-1 rounded border border-accent/30 px-1 font-mono text-[9px] uppercase tracking-wider text-accent">
            git
          </span>
        </Show>
      </nav>
      <button
        type="button"
        onClick={() => props.onEdit()}
        class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-faint hover:bg-bg-hover hover:text-fg"
        title="Type a path (Ctrl+L)"
      >
        Edit path
      </button>
    </div>
  );
};

const PlaceButton: Component<{
  label: string;
  title: string;
  current: boolean;
  icon: "home" | "drive" | "clock";
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={() => props.onClick()}
    title={props.title}
    class={`flex shrink-0 items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition sm:w-full ${
      props.current ? "bg-bg-active text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg"
    } max-sm:border max-sm:border-border`}
  >
    <PlaceIcon kind={props.icon} />
    <span class="truncate">{props.label}</span>
  </button>
);

const FolderIcon: Component<{ class?: string }> = (props) => (
  <svg viewBox="0 0 16 16" fill="currentColor" class={props.class} aria-hidden="true">
    <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.3 3.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z" />
  </svg>
);

const PlaceIcon: Component<{ kind: "home" | "drive" | "clock" }> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" class="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-hidden="true">
    <Show when={props.kind === "home"}>
      <path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H10V10H6v3.5H3a.5.5 0 0 1-.5-.5z" stroke-linejoin="round" />
    </Show>
    <Show when={props.kind === "drive"}>
      <rect x="2" y="4" width="12" height="8" rx="1.5" />
      <path d="M11 9.5h.01" stroke-linecap="round" stroke-width="2" />
    </Show>
    <Show when={props.kind === "clock"}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" stroke-linecap="round" />
    </Show>
  </svg>
);

export default DirectoryPicker;
