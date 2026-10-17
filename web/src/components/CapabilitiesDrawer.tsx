/**
 * Capabilities drawer — lists agents / skills / MCP servers / hooks
 * loaded for the focused session. Triggered by `/agents`, `/skills`,
 * `/mcp`, `/hooks` slash commands or programmatic open.
 *
 * Daemon-canonical: state slice in state/claude-config.ts. The drawer
 * only renders.
 */

import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { claudeConfig, fetchClaudeConfig, reconnectMcpServer } from "../state/claude-config";
import { focusedSessionId } from "../state/sessions";
import { relativeTime } from "../lib/format";
import type {
  ClaudeConfigAgent,
  ClaudeConfigHook,
  ClaudeConfigMcpServer,
  ClaudeConfigScope,
  ClaudeConfigSkill,
} from "../protocol/types";

type Tab = "agents" | "skills" | "mcp" | "hooks";

const [openSignal, setOpenSignal] = createSignal(false);
const [activeTab, setActiveTab] = createSignal<Tab>("agents");

/** Open the drawer programmatically (used by slash commands + /help). */
export function openCapabilitiesDrawer(tab?: Tab): void {
  if (tab) setActiveTab(tab);
  setOpenSignal(true);
  // Fetch lazily — only when something actually triggers the drawer.
  const sid = focusedSessionId();
  if (sid && claudeConfig().sessionId !== sid) {
    void fetchClaudeConfig(sid);
  }
}

export function closeCapabilitiesDrawer(): void {
  setOpenSignal(false);
}

const CapabilitiesDrawer: Component = () => {
  // Esc closes
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

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-end bg-bg/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <aside class="flex h-full w-full max-w-2xl flex-col border-l border-border bg-bg-elev shadow-2xl">
          <header class="flex items-center gap-3 border-b border-border px-4 py-3">
            <h2 class="text-base font-semibold tracking-tight text-fg">
              Capabilities
            </h2>
            <Show when={claudeConfig().workdir}>
              <span
                class="truncate font-mono text-[11px] text-fg-faint"
                title={claudeConfig().workdir!}
              >
                {claudeConfig().workdir}
              </span>
            </Show>
            <span class="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const sid = focusedSessionId();
                  if (sid) void fetchClaudeConfig(sid);
                }}
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

          <Tabs />

          <div class="flex-1 overflow-y-auto px-4 py-3">
            <Show when={claudeConfig().error}>
              <div class="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {claudeConfig().error}
              </div>
            </Show>
            <Show when={claudeConfig().loading}>
              <div class="text-xs text-fg-faint">loading…</div>
            </Show>

            <Switch>
              <Match when={activeTab() === "agents"}>
                <AgentsList items={claudeConfig().agents} />
              </Match>
              <Match when={activeTab() === "skills"}>
                <SkillsList items={claudeConfig().skills} />
              </Match>
              <Match when={activeTab() === "mcp"}>
                <McpList items={claudeConfig().mcpServers} sessionId={focusedSessionId()} />
              </Match>
              <Match when={activeTab() === "hooks"}>
                <HooksList items={claudeConfig().hooks} />
              </Match>
            </Switch>
          </div>

          <footer class="border-t border-border px-4 py-2 text-[11px] text-fg-faint">
            <Show when={claudeConfig().fetchedAt > 0}>
              fetched {relativeTime(claudeConfig().fetchedAt)} · loaded by Claude
              Agent SDK from <code class="font-mono">~/.claude/</code> + workdir
              <code class="font-mono">.claude/</code>
            </Show>
          </footer>
        </aside>
      </div>
    </Show>
  );
};

const Tabs: Component = () => {
  const counts = () => ({
    agents: claudeConfig().agents.length,
    skills: claudeConfig().skills.length,
    mcp: claudeConfig().mcpServers.length,
    hooks: claudeConfig().hooks.length,
  });
  const tabClass = (t: Tab) =>
    `flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px] transition ${
      activeTab() === t
        ? "border-accent text-fg"
        : "border-transparent text-fg-muted hover:text-fg"
    }`;
  return (
    <nav class="flex items-center gap-1 border-b border-border bg-bg-elev/40 px-2">
      <For each={(["agents", "skills", "mcp", "hooks"] as Tab[])}>
        {(t) => (
          <button type="button" onClick={() => setActiveTab(t)} class={tabClass(t)}>
            <span class="font-medium uppercase tracking-wider">{t}</span>
            <span class="rounded bg-bg px-1 py-0.5 font-mono text-[10px] text-fg-faint">
              {counts()[t]}
            </span>
          </button>
        )}
      </For>
    </nav>
  );
};

const ScopeBadge: Component<{ scope: ClaudeConfigScope }> = (props) => (
  <span
    class={`rounded border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
      props.scope === "workdir"
        ? "border-accent/40 bg-accent/5 text-accent"
        : "border-border bg-bg text-fg-muted"
    }`}
    title={
      props.scope === "workdir"
        ? "Defined in this workspace's .claude/"
        : "Global ~/.claude/"
    }
  >
    {props.scope === "workdir" ? "ws" : "global"}
  </span>
);

const PathRow: Component<{ path: string }> = (props) => {
  const [copied, setCopied] = createSignal(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(props.path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      class="group mt-1 flex w-full items-center gap-2 rounded border border-border bg-bg px-2 py-1 text-left transition hover:border-accent/40"
      title="Click to copy"
    >
      <span class="flex-1 truncate font-mono text-[10px] text-fg-faint">
        {props.path}
      </span>
      <span class="font-mono text-[10px] text-fg-faint group-hover:text-accent">
        {copied() ? "copied" : "copy"}
      </span>
    </button>
  );
};

const Empty: Component<{ hint: string }> = (props) => (
  <div class="rounded border border-dashed border-border px-3 py-6 text-center text-[12px] text-fg-faint">
    {props.hint}
  </div>
);

const AgentsList: Component<{ items: ClaudeConfigAgent[] }> = (props) => (
  <Show
    when={props.items.length > 0}
    fallback={
      <Empty hint="No subagents found. Drop one in `~/.claude/agents/<name>.md` or `<workdir>/.claude/agents/<name>.md`." />
    }
  >
    <ul class="flex flex-col gap-2">
      <For each={props.items}>
        {(a) => (
          <li class="rounded border border-border bg-bg/40 p-3">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[13px] font-semibold text-fg">
                {a.name}
              </span>
              <ScopeBadge scope={a.scope} />
              <Show when={a.tools && a.tools.length > 0}>
                <span class="text-[10px] text-fg-faint">tools:</span>
                <span class="font-mono text-[10px] text-fg-muted">
                  {a.tools!.join(", ")}
                </span>
              </Show>
            </div>
            <Show when={a.description}>
              <p class="mt-1 text-[12px] text-fg-muted">{a.description}</p>
            </Show>
            <PathRow path={a.path} />
          </li>
        )}
      </For>
    </ul>
  </Show>
);

const SkillsList: Component<{ items: ClaudeConfigSkill[] }> = (props) => (
  <Show
    when={props.items.length > 0}
    fallback={
      <Empty hint="No skills found. Drop a `~/.claude/skills/<name>/SKILL.md` or `<workdir>/.claude/skills/<name>.md`." />
    }
  >
    <ul class="flex flex-col gap-2">
      <For each={props.items}>
        {(s) => (
          <li class="rounded border border-border bg-bg/40 p-3">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[13px] font-semibold text-fg">
                /{s.name}
              </span>
              <ScopeBadge scope={s.scope} />
            </div>
            <Show when={s.description}>
              <p class="mt-1 text-[12px] text-fg-muted">{s.description}</p>
            </Show>
            <PathRow path={s.path} />
          </li>
        )}
      </For>
    </ul>
  </Show>
);

/** Redial a server the backend reports as down (#389); the outcome shows inline. */
const McpReconnect: Component<{ sessionId: string; server: string }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await reconnectMcpServer(props.sessionId, props.server);
      if (r.status !== "connected") setNote(r.deferred ? "Connects when the next turn starts." : (r.error ?? `Still ${r.status}.`));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        class="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
        disabled={busy()}
        onClick={() => void run()}
      >
        {busy() ? "Reconnecting…" : "Reconnect"}
      </button>
      <Show when={note()}>
        <div class="mt-1 basis-full text-[11px] text-fg-muted">{note()}</div>
      </Show>
    </>
  );
};

const McpList: Component<{ items: ClaudeConfigMcpServer[]; sessionId: string | null }> = (props) => (
  <Show
    when={props.items.length > 0}
    fallback={
      <Empty hint="No MCP servers configured. Add an `mcpServers` block to `~/.claude/settings.json` or the workspace's." />
    }
  >
    <ul class="flex flex-col gap-2">
      <For each={props.items}>
        {(m) => (
          <li class="rounded border border-border bg-bg/40 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-[13px] font-semibold text-fg">
                {m.name}
              </span>
              <ScopeBadge scope={m.scope} />
              <Show when={m.type}>
                <span class="rounded border border-border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                  {m.type}
                </span>
              </Show>
              <McpStatusBadge status={m.liveStatus} toolCount={m.liveTools?.length} />
              <Show when={props.sessionId && m.liveStatus !== undefined && m.liveStatus !== "connected" && m.liveStatus !== "disabled"}>
                <McpReconnect sessionId={props.sessionId!} server={m.name} />
              </Show>
            </div>
            <Show when={m.command}>
              <div class="mt-1 break-all font-mono text-[11px] text-fg-muted">
                {m.command} {m.args.join(" ")}
              </div>
            </Show>
            <Show when={m.url}>
              <div class="mt-1 break-all font-mono text-[11px] text-fg-muted">
                url: {m.url}
              </div>
            </Show>
            <Show when={m.envKeys.length > 0}>
              <div class="mt-1 text-[10px] text-fg-faint">
                env keys (values redacted): {m.envKeys.join(", ")}
              </div>
            </Show>
            <Show when={m.headerKeys && m.headerKeys.length > 0}>
              <div class="mt-1 text-[10px] text-fg-faint">
                header keys (values redacted): {m.headerKeys!.join(", ")}
              </div>
            </Show>
            <Show when={m.liveTools && m.liveTools.length > 0}>
              <details class="mt-2">
                <summary class="cursor-pointer font-mono text-[11px] text-fg-muted hover:text-fg">
                  tools available this session ({m.liveTools!.length})
                </summary>
                <ul class="mt-1 flex flex-col gap-0.5 pl-3">
                  <For each={m.liveTools}>
                    {(tn) => (
                      <li class="font-mono text-[11px] text-fg-muted">{tn}</li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={m.liveStatus !== undefined && (!m.liveTools || m.liveTools.length === 0)}>
              <div class="mt-1 text-[11px] italic text-fg-faint">
                no tools exposed this session
              </div>
            </Show>
            <PathRow path={m.path} />
          </li>
        )}
      </For>
    </ul>
  </Show>
);

const McpStatusBadge: Component<{ status?: string; toolCount?: number }> = (props) => (
  <Show when={props.status !== undefined}>
    {(() => {
      const s = props.status!;
      const lower = s.toLowerCase();
      const cls =
        lower === "connected"
          ? "border-success/40 text-success"
          : lower === "failed" || lower === "error"
            ? "border-danger/40 text-danger"
            : lower === "pending" || lower === "connecting"
              ? "border-warn/40 text-warn animate-pulse"
              : "border-border text-fg-muted";
      return (
        <span
          class={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${cls}`}
          title="SDK-reported status from the most recent turn"
        >
          {s}
          <Show when={props.toolCount !== undefined}>
            <span class="ml-1 normal-case text-fg-faint">· {props.toolCount} tools</span>
          </Show>
        </span>
      );
    })()}
  </Show>
);

const HooksList: Component<{ items: ClaudeConfigHook[] }> = (props) => (
  <Show
    when={props.items.length > 0}
    fallback={
      <Empty hint="No hooks configured. Add a `hooks` block to `~/.claude/settings.json`." />
    }
  >
    <ul class="flex flex-col gap-2">
      <For each={props.items}>
        {(h) => (
          <li class="rounded border border-border bg-bg/40 p-3">
            <div class="flex items-center gap-2">
              <span class="font-mono text-[13px] font-semibold text-fg">
                {h.event}
              </span>
              <ScopeBadge scope={h.scope} />
              <Show when={h.matcher}>
                <span class="rounded border border-border px-1 py-0.5 font-mono text-[10px] text-fg-muted">
                  {h.matcher}
                </span>
              </Show>
            </div>
            <pre class="mt-1 overflow-x-auto rounded border border-border bg-bg-active/40 p-2 font-mono text-[11px] text-fg">
              {h.command}
            </pre>
            <PathRow path={h.path} />
          </li>
        )}
      </For>
    </ul>
  </Show>
);

export default CapabilitiesDrawer;
