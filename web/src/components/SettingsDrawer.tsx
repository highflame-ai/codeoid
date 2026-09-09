/**
 * Settings drawer — a comprehensive, config-file-driven settings surface.
 *
 * Fully generic: renders whatever manifest the daemon serves over
 * `settings.schema`, so a new knob appears here with zero UI changes. A left
 * tab rail (one entry per manifest tab, incl. a tab per backend) + grouped
 * fields on the right, with a per-field control chosen by `kind`. Edits are
 * staged locally and committed as one `settings.set` batch.
 *
 * Daemon-canonical: state slice in state/settings.ts. This component only
 * renders + stages edits.
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
  untrack,
} from "solid-js";
import { createStore, produce } from "solid-js/store";

import { fetchSettings, saveSettings, settingsState } from "../state/settings";
import { relativeTime } from "../lib/format";
import { BackendLoginPanel } from "./BackendLoginPanel";
import { LOGIN_CAPABLE_BACKENDS } from "../protocol/types";
import type {
  LoginBackend,
  McpServerStatus,
  SecretStatus,
  SettingField,
  SettingPatch,
  SettingState,
  SettingValue,
} from "../protocol/types";

/**
 * A backend tab whose id names a backend codeoid can sign in interactively.
 * Returns the narrowed id (so the panel is typed) or `null` — every other tab
 * renders exactly as before.
 */
function isLoginBackend(tabId: string): LoginBackend | null {
  return LOGIN_CAPABLE_BACKENDS.includes(tabId as LoginBackend) ? (tabId as LoginBackend) : null;
}

const [openSignal, setOpenSignal] = createSignal(false);
const [activeTab, setActiveTab] = createSignal<string>("");
const [showAdvanced, setShowAdvanced] = createSignal(false);

// Staged edits, keyed by field.key. A present key is a pending change; a `null`
// value clears the field (unset / remove secret).
const [dirty, setDirty] = createStore<Record<string, SettingValue>>({});

/** Open the settings drawer (also refreshes the snapshot). */
export function openSettings(): void {
  setOpenSignal(true);
  void fetchSettings();
}

export function closeSettings(): void {
  setOpenSignal(false);
}

function resetDirty(): void {
  setDirty(produce((d) => {
    for (const k of Object.keys(d)) delete d[k];
  }));
}

const SettingsDrawer: Component = () => {
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

  const manifest = () => settingsState().manifest;

  // Default the active tab to the first one once the manifest arrives.
  const tab = createMemo(() => {
    const m = manifest();
    if (!m) return undefined;
    const id = activeTab();
    return m.tabs.find((t) => t.id === id) ?? m.tabs[0];
  });

  const dirtyCount = () => Object.keys(dirty).length;

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
            <h2 class="text-base font-semibold tracking-tight text-fg">Settings</h2>
            <span class="font-mono text-[11px] text-fg-faint">codeoid daemon configuration</span>
            <span class="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => void fetchSettings(true)}
                class="rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent/40 hover:text-fg"
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

          <Show when={settingsState().restartRequired}>
            <div class="border-b border-warn/40 bg-warn/10 px-4 py-2 text-[12px] text-warn">
              Some saved changes need a daemon restart to take effect.
            </div>
          </Show>
          <Show when={settingsState().error}>
            <div class="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">
              {settingsState().error}
            </div>
          </Show>

          <div class="flex min-h-0 flex-1">
            {/* Left tab rail */}
            <nav class="w-52 shrink-0 overflow-y-auto border-r border-border bg-bg/30 py-2">
              <For each={manifest()?.tabs ?? []}>
                {(t) => {
                  const active = () => (activeTab() || manifest()?.tabs[0]?.id) === t.id;
                  return (
                    <button
                      type="button"
                      onClick={() => setActiveTab(t.id)}
                      class={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[13px] transition ${
                        active()
                          ? "border-accent bg-bg-active/40 text-fg"
                          : "border-transparent text-fg-muted hover:bg-bg-hover hover:text-fg"
                      }`}
                    >
                      <Show when={t.icon}>
                        <span class="w-4 text-center">{t.icon}</span>
                      </Show>
                      <span>{t.title}</span>
                    </button>
                  );
                }}
              </For>
              {/* Synthetic read-only tab — registry MCP servers + live health.
                  Snapshot-backed (not a manifest tab); shown only when the daemon
                  reports it. */}
              <Show when={settingsState().snapshot?.mcpServers}>
                <button
                  type="button"
                  onClick={() => setActiveTab("mcp")}
                  class={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[13px] transition ${
                    activeTab() === "mcp"
                      ? "border-accent bg-bg-active/40 text-fg"
                      : "border-transparent text-fg-muted hover:bg-bg-hover hover:text-fg"
                  }`}
                >
                  <span class="w-4 text-center">🔌</span>
                  <span>MCP Servers</span>
                </button>
              </Show>
            </nav>

            {/* Content */}
            <div class="min-w-0 flex-1 overflow-y-auto px-5 py-4">
              <Show when={settingsState().loading && !manifest()}>
                <div class="text-xs text-fg-faint">loading…</div>
              </Show>
              <Show when={activeTab() === "mcp"}>
                <McpServersPanel servers={settingsState().snapshot?.mcpServers ?? []} />
              </Show>
              <Show when={activeTab() !== "mcp" && tab()} keyed>
                {(t) => (
                  <div>
                    <div class="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <h3 class="flex items-center gap-2 text-[15px] font-semibold text-fg">
                          <Show when={t.icon}>
                            <span>{t.icon}</span>
                          </Show>
                          {t.title}
                        </h3>
                        <Show when={t.description}>
                          <p class="mt-0.5 text-[12px] text-fg-muted">{t.description}</p>
                        </Show>
                      </div>
                      <Show when={t.groups.some((g) => g.fields.some((f) => f.advanced))}>
                        <label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-fg-faint">
                          <input
                            type="checkbox"
                            checked={showAdvanced()}
                            onChange={(e) => setShowAdvanced(e.currentTarget.checked)}
                          />
                          Show advanced
                        </label>
                      </Show>
                    </div>

                    {/* Signing in is the primary path for a backend that has
                        one, so it sits above the fields — a pasted key is the
                        fallback, not the default. */}
                    <Show when={isLoginBackend(t.id)} keyed>
                      {(backend) => <BackendLoginPanel backend={backend} />}
                    </Show>

                    <For each={t.groups}>
                      {(g) => {
                        const visible = () =>
                          g.fields.filter((f) => showAdvanced() || !f.advanced);
                        return (
                          <Show when={visible().length > 0}>
                            <section class="mb-5">
                              <h4 class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                                {g.title}
                              </h4>
                              <Show when={g.description}>
                                <p class="mb-2 text-[12px] text-fg-muted">{g.description}</p>
                              </Show>
                              <div class="flex flex-col divide-y divide-border/60 rounded border border-border">
                                <For each={visible()}>{(f) => <FieldRow field={f} />}</For>
                              </div>
                            </section>
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                )}
              </Show>
            </div>
          </div>

          <SaveBar dirtyCount={dirtyCount()} />

          <footer class="border-t border-border px-4 py-2 text-[11px] text-fg-faint">
            <Show when={settingsState().snapshot} keyed>
              {(snap) => (
                <span>
                  Edit directly: <code class="font-mono">{snap.configPath}</code> ·{" "}
                  <code class="font-mono">{snap.envPath}</code>
                  <Show when={settingsState().fetchedAt > 0}>
                    {" "}· fetched {relativeTime(settingsState().fetchedAt)}
                  </Show>
                </span>
              )}
            </Show>
          </footer>
        </aside>
      </div>
    </Show>
  );
};

// ── Field row ───────────────────────────────────────────────────────────────

const HEALTH_STYLE: Record<McpServerStatus["health"], { label: string; cls: string }> = {
  connected: { label: "connected", cls: "border-success/40 bg-success/10 text-success" },
  error: { label: "error", cls: "border-danger/40 bg-danger/10 text-danger" },
  idle: { label: "idle", cls: "border-border bg-bg/40 text-fg-muted" },
  disabled: { label: "disabled", cls: "border-border bg-bg/40 text-fg-faint" },
};

/** Read-only panel: the registry's MCP servers + live health. Config comes from
 *  config.json / ~/.claude.json; health/tools reflect what the daemon has seen.
 *  Exported for a render test. */
export const McpServersPanel: Component<{ servers: McpServerStatus[] }> = (props) => (
  <div>
    <div class="mb-3">
      <h3 class="flex items-center gap-2 text-[15px] font-semibold text-fg">
        <span>🔌</span>MCP Servers
      </h3>
      <p class="mt-0.5 text-[12px] text-fg-muted">
        Declared in <code class="font-mono">mcpServers</code> (config + imported from{" "}
        <code class="font-mono">~/.claude.json</code>) and mounted on every backend. Read-only —
        edit config.json to change. Health reflects use so far (no live probe).
      </p>
    </div>
    <Show
      when={props.servers.length > 0}
      fallback={
        <div class="rounded border border-border px-3 py-4 text-center text-[12px] text-fg-muted">
          No MCP servers configured.
        </div>
      }
    >
      <div class="flex flex-col gap-2">
        <For each={props.servers}>
          {(s) => (
            <div class="rounded border border-border bg-bg/30 px-3 py-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-[13px] text-fg">{s.name}</span>
                <Show when={s.builtin}>
                  <span class="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
                    built-in
                  </span>
                </Show>
                <span
                  class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${HEALTH_STYLE[s.health].cls}`}
                >
                  {HEALTH_STYLE[s.health].label}
                </span>
                <span class="ml-auto text-[11px] text-fg-faint">
                  {s.transport} · {s.trust}
                  {s.toolCount > 0 ? ` · ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}` : ""}
                </span>
              </div>
              <Show when={s.error}>
                <div class="mt-1 text-[11px] text-danger">{s.error}</div>
              </Show>
              <Show when={s.tools.length > 0}>
                <div class="mt-1.5 flex flex-wrap gap-1">
                  <For each={s.tools}>
                    {(t) => (
                      <span class="rounded bg-bg-active/40 px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
                        {t}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={s.backends}>
                {(b) => <div class="mt-1 text-[11px] text-fg-faint">backends: {b().join(", ")}</div>}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  </div>
);

const FieldRow: Component<{ field: SettingField }> = (props) => {
  const f = props.field;
  const saveError = () => settingsState().saveErrors.find((e) => e.key === f.key)?.message;
  const pending = () => f.key in dirty;

  return (
    <div class="flex flex-col gap-1.5 px-3 py-2.5">
      <div class="flex items-center gap-2">
        <span class="text-[13px] font-medium text-fg">{f.label}</span>
        <Show when={pending()}>
          <span class="rounded bg-accent/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
            edited
          </span>
        </Show>
        <span class="ml-auto flex items-center gap-1.5">
          <AppliesBadge applies={f.applies} />
          <Show when={!f.secret}>
            <ProvenanceChip state={settingsState().snapshot?.values[f.key]} />
          </Show>
        </span>
      </div>

      <Show when={f.secret} fallback={<ValueControl field={f} />}>
        <SecretControl field={f} />
      </Show>

      <Show when={f.help}>
        <p class="text-[11px] leading-snug text-fg-muted">{f.help}</p>
      </Show>
      <Show when={f.envVar}>
        <p class="font-mono text-[10px] text-fg-faint">
          {f.backing === "config" ? "override: " : "env: "}
          {f.envVar}
        </p>
      </Show>
      <Show when={saveError()}>
        <p class="text-[11px] text-danger">{saveError()}</p>
      </Show>
    </div>
  );
};

const AppliesBadge: Component<{ applies: SettingField["applies"] }> = (props) => (
  <Show when={props.applies !== "live"}>
    <span
      class={`rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider ${
        props.applies === "restart"
          ? "border-warn/40 text-warn"
          : "border-border text-fg-faint"
      }`}
      title={
        props.applies === "restart"
          ? "Takes effect after a daemon restart"
          : "Takes effect on the next new session"
      }
    >
      {props.applies === "restart" ? "restart" : "next session"}
    </span>
  </Show>
);

const ProvenanceChip: Component<{ state?: SettingState }> = (props) => (
  <Show when={props.state}>
    {(s) => (
      <span
        class="rounded border border-border px-1 py-0.5 text-[9px] uppercase tracking-wider text-fg-faint"
        title={`Current value comes from: ${s().source}`}
      >
        {s().source}
      </span>
    )}
  </Show>
);

// ── Controls ────────────────────────────────────────────────────────────────

function currentValue(f: SettingField): SettingValue {
  if (f.key in dirty) return dirty[f.key] ?? null;
  const snap = settingsState().snapshot?.values[f.key];
  if (snap) return snap.value;
  return (f.default as SettingValue | undefined) ?? null;
}

function setField(f: SettingField, value: SettingValue): void {
  const base = settingsState().snapshot?.values[f.key]?.value ?? (f.default as SettingValue | undefined) ?? null;
  // Drop the edit if it returns to the current value (nothing to save).
  if (JSON.stringify(value) === JSON.stringify(base)) {
    setDirty(produce((d) => { delete d[f.key]; }));
  } else {
    setDirty(f.key, value);
  }
}

const ValueControl: Component<{ field: SettingField }> = (props) => {
  const f = props.field;
  return (
    <Show
      when={f.kind !== "boolean"}
      fallback={<BooleanControl field={f} />}
    >
      <Show when={f.kind !== "enum"} fallback={<EnumControl field={f} />}>
        <TextLikeControl field={f} />
      </Show>
    </Show>
  );
};

const BooleanControl: Component<{ field: SettingField }> = (props) => {
  const f = props.field;
  const on = () => currentValue(f) === true;
  const btn = (active: boolean) =>
    `rounded px-2.5 py-1 text-[12px] transition ${
      active ? "bg-accent text-bg" : "bg-bg text-fg-muted hover:text-fg"
    }`;
  return (
    <div role="radiogroup" class="flex w-fit gap-1 rounded border border-border bg-bg p-0.5">
      <button type="button" role="radio" aria-checked={on()} class={btn(on())} onClick={() => setField(f, true)}>
        On
      </button>
      <button type="button" role="radio" aria-checked={!on()} class={btn(!on())} onClick={() => setField(f, false)}>
        Off
      </button>
    </div>
  );
};

const EnumControl: Component<{ field: SettingField }> = (props) => {
  const f = props.field;
  const val = () => currentValue(f);
  return (
    <div role="radiogroup" class="flex flex-wrap gap-1">
      <For each={f.options ?? []}>
        {(opt) => {
          const active = () => val() === opt.value;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active()}
              title={opt.description}
              class={`rounded border px-2.5 py-1 text-[12px] transition ${
                active()
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-bg text-fg-muted hover:text-fg"
              }`}
              onClick={() => setField(f, opt.value)}
            >
              {opt.label}
            </button>
          );
        }}
      </For>
    </div>
  );
};

const inputClass =
  "w-full max-w-md rounded border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent";

const TextLikeControl: Component<{ field: SettingField }> = (props) => {
  const f = props.field;
  const display = (): string => {
    const v = currentValue(f);
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  };
  const parse = (raw: string): SettingValue => {
    const t = raw.trim();
    if (f.kind === "int" || f.kind === "float") {
      if (t === "") return null;
      // Strict: reject partial/lossy input (e.g. "3.7" for an int, "3." mid-type)
      // by keeping the raw string so it's preserved — the daemon then rejects it
      // with a visible error instead of us silently truncating or clearing it.
      const ok = f.kind === "int" ? /^-?\d+$/.test(t) : Number.isFinite(Number(t));
      if (!ok) return raw;
      return f.kind === "int" ? Number.parseInt(t, 10) : Number(t);
    }
    if (f.kind === "string[]") {
      return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    }
    return raw;
  };
  // Buffer the raw text locally so parsing never clobbers in-progress
  // characters — a trailing ".", "-", or ", " while typing a decimal or a
  // comma-list. Resync from the store only when its value actually diverges
  // from what we're showing (an external change: Discard / Save / tab switch),
  // never on our own keystrokes.
  const [local, setLocal] = createSignal(display());
  createEffect(() => {
    // Only react to external store changes — untrack the local buffer so our
    // own setLocal (below) can't re-trigger this effect into a feedback loop.
    const ext = currentValue(f);
    if (JSON.stringify(parse(untrack(local))) !== JSON.stringify(ext)) {
      setLocal(display());
    }
  });
  const onInput = (raw: string) => {
    setLocal(raw);
    setField(f, parse(raw));
  };
  const numeric = f.kind === "int" || f.kind === "float";
  return (
    <input
      type="text"
      inputMode={numeric ? (f.kind === "int" ? "numeric" : "decimal") : undefined}
      class={inputClass}
      value={local()}
      placeholder={f.placeholder ?? (f.default !== undefined ? String(f.default) : "")}
      onInput={(e) => onInput(e.currentTarget.value)}
    />
  );
};

const SecretControl: Component<{ field: SettingField }> = (props) => {
  const f = props.field;
  const status = (): SecretStatus | undefined => settingsState().snapshot?.secrets[f.key];
  const staged = () => f.key in dirty;
  const stagedClear = () => staged() && dirty[f.key] === null;
  return (
    <div class="flex max-w-md flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <input
          type="password"
          class={inputClass}
          placeholder={status()?.set ? "•••••••• (set — type to replace)" : "not set — enter a value"}
          value={typeof dirty[f.key] === "string" ? (dirty[f.key] as string) : ""}
          onInput={(e) => {
            const v = e.currentTarget.value;
            if (v === "") setDirty(produce((d) => { delete d[f.key]; }));
            else setDirty(f.key, v);
          }}
        />
        <Show when={status()?.set && !stagedClear()}>
          <button
            type="button"
            class="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-fg-muted hover:border-danger/40 hover:text-danger"
            onClick={() => setDirty(f.key, null)}
            title="Clear this secret on save"
          >
            Clear
          </button>
        </Show>
        <Show when={staged()}>
          <button
            type="button"
            class="shrink-0 text-[11px] text-fg-faint hover:text-fg"
            onClick={() => setDirty(produce((d) => { delete d[f.key]; }))}
            title="Discard this edit"
          >
            ↺
          </button>
        </Show>
      </div>
      <div class="flex items-center gap-2 text-[10px]">
        <Show
          when={status()?.set}
          fallback={<span class="text-fg-faint">not set</span>}
        >
          <span class="text-success">set</span>
          <span class="text-fg-faint">· source: {status()?.source}</span>
        </Show>
        <Show when={stagedClear()}>
          <span class="text-danger">will clear on save</span>
        </Show>
        <Show when={staged() && !stagedClear()}>
          <span class="text-accent">will update on save</span>
        </Show>
      </div>
    </div>
  );
};

// ── Save bar ────────────────────────────────────────────────────────────────

const SaveBar: Component<{ dirtyCount: number }> = (props) => {
  const globalError = () => settingsState().saveErrors.find((e) => e.key === "")?.message;
  const save = async () => {
    const patches: SettingPatch[] = Object.entries(dirty).map(([key, value]) => ({ key, value }));
    const res = await saveSettings(patches);
    if (res?.ok) resetDirty();
  };
  return (
    <Show when={props.dirtyCount > 0 || settingsState().saving}>
      <div class="flex items-center gap-3 border-t border-border bg-bg-elev px-4 py-2.5">
        <span class="text-[12px] text-fg-muted">
          {props.dirtyCount} unsaved change{props.dirtyCount === 1 ? "" : "s"}
        </span>
        <Show when={globalError()}>
          <span class="text-[12px] text-danger">{globalError()}</span>
        </Show>
        <span class="ml-auto flex items-center gap-2">
          <button
            type="button"
            class="rounded border border-border px-3 py-1.5 text-[12px] text-fg-muted hover:bg-bg-hover"
            onClick={resetDirty}
            disabled={settingsState().saving}
          >
            Discard
          </button>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void save()}
            disabled={settingsState().saving}
          >
            {settingsState().saving ? "Saving…" : "Save changes"}
          </button>
        </span>
      </div>
    </Show>
  );
};

export default SettingsDrawer;
