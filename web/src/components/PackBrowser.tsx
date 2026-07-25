/**
 * Pack Browser — a curation surface for dynamic pack loading
 * (docs/pack-loading.md). Opened by the `/packs` slash command via the
 * exported `openPackBrowser` signal (mirrors `openSettings`).
 *
 * Three sections, all daemon-canonical (state/packs.ts):
 *   • Registries — configured git registries + cache status, and an "add
 *     registry" form (git URL, optional name/ref).
 *   • Installed  — a card per pack: name · version · description, a visual
 *     phase pipeline (chips with role badge + gate marker), trust state,
 *     source registry, selected highlight, and Set default / Trust / Remove.
 *   • Available  — registry packs not yet installed, with an Install button.
 *
 * Every verb replies with the full refreshed pack state, so a mutation just
 * re-renders from the returned slice. A forbidden/error reply surfaces inline
 * (the daemon rejects `pipeline:manage` verbs a viewer-scoped client lacks).
 *
 * This component only renders + dispatches; the round-trips live in
 * state/packs.ts. `PackBrowserView` is the pure presentational body, exported
 * for a render test (mirrors SettingsDrawer's McpServersPanel).
 */

import {
  Component,
  For,
  type JSX,
  Show,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import {
  addRegistry,
  fetchPacks,
  installPack,
  packsState,
  refreshRegistry,
  removePack,
  selectPack,
  trustPack,
} from "../state/packs";
import { openPipelineRunner } from "./PipelineRunner";
import type {
  AvailablePackWire,
  PackWire,
  RegistryWire,
} from "../protocol/types";

const [openSignal, setOpenSignal] = createSignal(false);

/** Open the pack browser (also refreshes the snapshot). Wired to `/packs`. */
export function openPackBrowser(): void {
  setOpenSignal(true);
  void fetchPacks();
}

export function closePackBrowser(): void {
  setOpenSignal(false);
}

const PackBrowser: Component = () => {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openSignal()) {
        e.preventDefault();
        setOpenSignal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const s = packsState;

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-end bg-bg/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <aside class="flex h-full w-full max-w-4xl flex-col border-l border-border bg-bg-elev shadow-2xl">
          <header class="flex items-center gap-3 border-b border-border px-4 py-3">
            <h2 class="text-base font-semibold tracking-tight text-fg">Packs</h2>
            <span class="font-mono text-[11px] text-fg-faint">
              SDLC methodology bundles
            </span>
            <span class="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => void fetchPacks()}
                class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent/40 hover:text-fg disabled:opacity-50"
                disabled={s().loading || s().busy}
                title="Refresh"
              >
                ↻
              </button>
              <button
                type="button"
                onClick={() => setOpenSignal(false)}
                class="text-fg-faint hover:text-fg"
                title="Close (Esc)"
              >
                ✕
              </button>
            </span>
          </header>

          <Show when={s().error}>
            <div class="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">
              {s().error}
            </div>
          </Show>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <Show
              when={s().loaded || !s().loading}
              fallback={<div class="text-xs text-fg-faint">loading…</div>}
            >
              <PackBrowserView
                installed={s().installed}
                available={s().available}
                registries={s().registries}
                busy={s().busy}
                onAddRegistry={(url, name, ref) => void addRegistry(url, name, ref)}
                onRefresh={(name) => void refreshRegistry(name)}
                onInstall={(packId, trusted) => void installPack(packId, trusted)}
                onRemove={(packId) => void removePack(packId)}
                onTrust={(packId, trusted) => void trustPack(packId, trusted)}
                onSelect={(packId) => void selectPack(packId)}
                onRun={() => {
                  setOpenSignal(false);
                  openPipelineRunner();
                }}
              />
            </Show>
          </div>

          <footer class="border-t border-border px-4 py-2 text-[11px] text-fg-faint">
            Fetched packs are untrusted by default — their shell{" "}
            <code class="font-mono">command</code> gates fail closed until you
            trust them.
          </footer>
        </aside>
      </div>
    </Show>
  );
};

// ── Presentational body ───────────────────────────────────────────────────────

export interface PackBrowserViewProps {
  installed: PackWire[];
  available: AvailablePackWire[];
  registries: RegistryWire[];
  /** A mutation is in flight — disable action buttons. */
  busy?: boolean;
  onAddRegistry: (url: string, name?: string, ref?: string) => void;
  onRefresh: (name: string) => void;
  onInstall: (packId: string, trusted: boolean) => void;
  onRemove: (packId: string) => void;
  onTrust: (packId: string, trusted: boolean) => void;
  /** `null` clears the selected default pack. */
  onSelect: (packId: string | null) => void;
  /** Start a pipeline run from an installed + active pack (opens the runner).
   *  Optional — omitted in isolated render tests. */
  onRun?: (packId: string) => void;
}

/** Pure body — no daemon calls. Exported for a render test. */
export const PackBrowserView: Component<PackBrowserViewProps> = (props) => {
  // Uninstalled packs only (installed ones are already shown above).
  const available = () => props.available.filter((p) => !p.installed);
  return (
    <div class="flex flex-col gap-6">
      <RegistriesSection
        registries={props.registries}
        busy={props.busy}
        onAddRegistry={props.onAddRegistry}
        onRefresh={props.onRefresh}
      />
      <InstalledSection
        installed={props.installed}
        busy={props.busy}
        onRemove={props.onRemove}
        onTrust={props.onTrust}
        onSelect={props.onSelect}
        onRun={props.onRun}
      />
      <AvailableSection
        available={available()}
        busy={props.busy}
        onInstall={props.onInstall}
      />
    </div>
  );
};

// ── Registries ─────────────────────────────────────────────────────────────

const inputClass =
  "w-full rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50";

const RegistriesSection: Component<{
  registries: RegistryWire[];
  busy?: boolean;
  onAddRegistry: (url: string, name?: string, ref?: string) => void;
  onRefresh: (name: string) => void;
}> = (props) => {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [ref, setRef] = createSignal("");

  const submit = (e: Event) => {
    e.preventDefault();
    const u = url().trim();
    if (!u) return;
    props.onAddRegistry(u, name().trim() || undefined, ref().trim() || undefined);
    setUrl("");
    setName("");
    setRef("");
  };

  return (
    <section>
      <SectionHeader
        title="Registries"
        hint="Git repos laid out like ai-factory (packs/<id>/pack.yaml)."
      />
      <form onSubmit={submit} class="mb-3 flex flex-col gap-2 rounded border border-border bg-bg/30 p-3">
        <label class="flex flex-col gap-1">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
            Git URL
          </span>
          <input
            type="text"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://github.com/highflame-ai/ai-factory"
            value={url()}
            onInput={(e) => setUrl(e.currentTarget.value)}
            class={inputClass}
            disabled={props.busy}
            aria-label="Registry git URL"
          />
        </label>
        <div class="flex gap-2">
          <label class="flex flex-1 flex-col gap-1">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              Name (optional)
            </span>
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder="ai-factory"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              class={inputClass}
              disabled={props.busy}
              aria-label="Registry name"
            />
          </label>
          <label class="flex flex-1 flex-col gap-1">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              Ref (optional)
            </span>
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder="main"
              value={ref()}
              onInput={(e) => setRef(e.currentTarget.value)}
              class={inputClass}
              disabled={props.busy}
              aria-label="Registry ref"
            />
          </label>
          <div class="flex items-end">
            <button
              type="submit"
              class="rounded bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={props.busy || !url().trim()}
            >
              Add registry
            </button>
          </div>
        </div>
      </form>

      <Show
        when={props.registries.length > 0}
        fallback={
          <div class="rounded border border-border px-3 py-4 text-center text-[12px] text-fg-muted">
            No registries configured.
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={props.registries}>
            {(r) => (
              <div class="rounded border border-border bg-bg/30 px-3 py-2.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-[13px] text-fg">{r.name}</span>
                  <span
                    class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                      r.cached
                        ? "border-success/40 bg-success/10 text-success"
                        : "border-border bg-bg/40 text-fg-muted"
                    }`}
                  >
                    {r.cached ? "cached" : "not cached"}
                  </span>
                  <Show when={r.ref}>
                    <span class="rounded bg-bg-active/40 px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
                      @{r.ref}
                    </span>
                  </Show>
                  <span class="ml-auto flex items-center gap-2">
                    <Show when={r.packCount !== undefined}>
                      <span class="text-[11px] text-fg-faint">
                        {r.packCount} pack{r.packCount === 1 ? "" : "s"}
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent/40 hover:text-fg disabled:opacity-50"
                      disabled={props.busy}
                      onClick={() => props.onRefresh(r.name)}
                      title="Pull + reload this registry"
                    >
                      ↻
                    </button>
                  </span>
                </div>
                <div class="mt-1 break-all font-mono text-[11px] text-fg-faint">
                  {r.url}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};

// ── Installed ──────────────────────────────────────────────────────────────

const InstalledSection: Component<{
  installed: PackWire[];
  busy?: boolean;
  onRemove: (packId: string) => void;
  onTrust: (packId: string, trusted: boolean) => void;
  onSelect: (packId: string | null) => void;
  onRun?: (packId: string) => void;
}> = (props) => (
  <section>
    <SectionHeader
      title="Installed"
      hint="Packs registered into the pipeline manager. The selected pack runs when a pipeline is created without an explicit pack."
    />
    <Show
      when={props.installed.length > 0}
      fallback={
        <div class="rounded border border-border px-3 py-4 text-center text-[12px] text-fg-muted">
          No packs installed.
        </div>
      }
    >
      <div class="flex flex-col gap-2">
        <For each={props.installed}>
          {(p) => (
            <InstalledCard
              pack={p}
              busy={props.busy}
              onRemove={props.onRemove}
              onTrust={props.onTrust}
              onSelect={props.onSelect}
              onRun={props.onRun}
            />
          )}
        </For>
      </div>
    </Show>
  </section>
);

const InstalledCard: Component<{
  pack: PackWire;
  busy?: boolean;
  onRemove: (packId: string) => void;
  onTrust: (packId: string, trusted: boolean) => void;
  onSelect: (packId: string | null) => void;
  onRun?: (packId: string) => void;
}> = (props) => {
  const p = () => props.pack;
  const btn =
    "rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <Show
      when={!p().error}
      fallback={
        // Broken pack — the configured dir couldn't load. Render it rather than
        // vanish so the user can remove it.
        <div class="rounded border border-danger/40 bg-danger/5 px-3 py-2.5">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-[13px] text-fg">{p().name || p().id}</span>
            <span class="rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-danger">
              broken
            </span>
            <button
              type="button"
              class={`ml-auto ${btn} hover:border-danger/40 hover:text-danger`}
              disabled={props.busy}
              onClick={() => props.onRemove(p().id)}
            >
              Remove
            </button>
          </div>
          <div class="mt-1 break-all font-mono text-[11px] text-danger">{p().error}</div>
          <div class="mt-1 break-all font-mono text-[10px] text-fg-faint">{p().dir}</div>
        </div>
      }
    >
      <div
        class={`rounded border px-3 py-2.5 ${
          p().selected
            ? "border-accent/60 bg-accent/5 ring-1 ring-accent/30"
            : "border-border bg-bg/30"
        }`}
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-[13px] text-fg">{p().name}</span>
          <span class="rounded bg-bg-active/40 px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
            v{p().version}
          </span>
          <span
            class={`rounded border px-1.5 py-0.5 text-[10px] ${
              p().trusted
                ? "border-success/40 bg-success/10 text-success"
                : "border-warn/40 bg-warn/10 text-warn"
            }`}
            title={
              p().trusted
                ? "Trusted — may run host shell command gates"
                : "Untrusted — shell command gates fail closed"
            }
          >
            {p().trusted ? "🔓 trusted" : "🔒 untrusted"}
          </span>
          <Show when={p().selected}>
            <span class="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
              default
            </span>
          </Show>
          <Show when={!p().active}>
            <span
              class="rounded border border-border bg-bg/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-faint"
              title="Not registered into the live pipeline manager"
            >
              inactive
            </span>
          </Show>
          <span class="ml-auto flex items-center gap-1.5">
            <Show when={props.onRun && p().active}>
              <button
                type="button"
                class={`${btn} border-accent/50 text-accent hover:border-accent hover:bg-accent/10`}
                disabled={props.busy}
                onClick={() => props.onRun?.(p().id)}
                title="Start a governed pipeline run from this pack"
              >
                Run
              </button>
            </Show>
            <button
              type="button"
              class={`${btn} hover:border-accent/40`}
              disabled={props.busy || p().selected}
              onClick={() => props.onSelect(p().id)}
              title="Make this the default pack"
            >
              Set default
            </button>
            <button
              type="button"
              class={`${btn} hover:border-accent/40`}
              disabled={props.busy}
              onClick={() => props.onTrust(p().id, !p().trusted)}
            >
              {p().trusted ? "Untrust" : "Trust"}
            </button>
            <button
              type="button"
              class={`${btn} hover:border-danger/40 hover:text-danger`}
              disabled={props.busy}
              onClick={() => props.onRemove(p().id)}
            >
              Remove
            </button>
          </span>
        </div>

        <Show when={p().description}>
          <p class="mt-1 text-[12px] text-fg-muted">{p().description}</p>
        </Show>

        <Show when={p().phases.length > 0}>
          <div class="mt-2 flex flex-wrap items-center gap-1">
            <For each={p().phases}>
              {(ph, i) => (
                <>
                  <Show when={i() > 0}>
                    <span class="text-fg-faint" aria-hidden="true">
                      →
                    </span>
                  </Show>
                  <span class="inline-flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                    {ph.id}
                    <Show when={ph.role}>
                      <span
                        class="rounded bg-accent/20 px-1 py-0.5 text-[9px] uppercase tracking-wider text-accent"
                        title={`role: ${ph.role}`}
                      >
                        {ph.role}
                      </span>
                    </Show>
                    <Show when={ph.gate}>
                      <span
                        class="text-warn"
                        title={`exit gate: ${ph.gate}`}
                        aria-label={`gate ${ph.gate}`}
                      >
                        ⛿
                      </span>
                    </Show>
                  </span>
                </>
              )}
            </For>
          </div>
        </Show>

        <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-faint">
          <Show when={p().registry}>
            <span>
              source: <span class="font-mono text-fg-muted">{p().registry}</span>
            </span>
          </Show>
          <Show when={p().roles.length > 0}>
            <span>roles: {p().roles.join(", ")}</span>
          </Show>
          <Show when={p().gates.length > 0}>
            <span>
              gates: {p().gates.map((g) => `${g.id} (${g.kind})`).join(", ")}
            </span>
          </Show>
        </div>
      </div>
    </Show>
  );
};

// ── Available ──────────────────────────────────────────────────────────────

const AvailableSection: Component<{
  available: AvailablePackWire[];
  busy?: boolean;
  onInstall: (packId: string, trusted: boolean) => void;
}> = (props) => {
  const [trustOnInstall, setTrustOnInstall] = createSignal(false);
  return (
    <section>
      <SectionHeader
        title="Available"
        hint="Packs discovered in cached registries that are not yet installed."
      >
        <label class="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-faint">
          <input
            type="checkbox"
            checked={trustOnInstall()}
            onChange={(e) => setTrustOnInstall(e.currentTarget.checked)}
          />
          Trust on install
        </label>
      </SectionHeader>
      <Show
        when={props.available.length > 0}
        fallback={
          <div class="rounded border border-border px-3 py-4 text-center text-[12px] text-fg-muted">
            No available packs.
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={props.available}>
            {(a) => (
              <div class="rounded border border-border bg-bg/30 px-3 py-2.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-[13px] text-fg">{a.name}</span>
                  <span class="rounded bg-bg-active/40 px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
                    v{a.version}
                  </span>
                  <span class="text-[11px] text-fg-faint">
                    from <span class="font-mono">{a.registry}</span>
                  </span>
                  <button
                    type="button"
                    class="ml-auto rounded border border-border px-2.5 py-1 text-[11px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={props.busy}
                    onClick={() => props.onInstall(a.id, trustOnInstall())}
                  >
                    Install
                  </button>
                </div>
                <Show when={a.description}>
                  <p class="mt-1 text-[12px] text-fg-muted">{a.description}</p>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};

// ── Shared ─────────────────────────────────────────────────────────────────

const SectionHeader: Component<{
  title: string;
  hint?: string;
  children?: JSX.Element;
}> = (props) => (
  <div class="mb-2 flex items-start justify-between gap-3">
    <div>
      <h3 class="text-[15px] font-semibold text-fg">{props.title}</h3>
      <Show when={props.hint}>
        <p class="mt-0.5 text-[12px] text-fg-muted">{props.hint}</p>
      </Show>
    </div>
    <Show when={props.children}>
      <div class="shrink-0 pt-0.5">{props.children}</div>
    </Show>
  </div>
);

export default PackBrowser;
