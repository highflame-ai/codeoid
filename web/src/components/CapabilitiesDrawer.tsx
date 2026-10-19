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
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { approveMcpServer, claudeConfig, fetchClaudeConfig, previewMcpApproval, reconnectMcpServer, refreshMcpServers } from "../state/claude-config";
import { adoptAndSignIn, mcpOAuthState } from "../state/mcp-oauth";
import { fetchSettings, settingsState } from "../state/settings";
import { McpOAuthControls } from "./McpOAuthControls";
import { focusedSessionId } from "../state/sessions";
import { relativeTime } from "../lib/format";
import type {
  ClaudeConfigAgent,
  ClaudeConfigHook,
  ClaudeConfigMcpServer,
  ClaudeConfigScope,
  ClaudeConfigSkill,
  McpApprovePreview,
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
                <Show when={claudeConfig().mcpStale && claudeConfig().sessionId}>
                  <McpStaleBanner sessionId={claudeConfig().sessionId!} />
                </Show>
                <McpList
                  items={claudeConfig().mcpServers}
                  sessionId={claudeConfig().mcpReconnect ? claudeConfig().sessionId : null}
                  approveIn={claudeConfig().sessionId}
                />
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

/**
 * Reconnect state per session and server, outside the rows: the refresh that
 * follows a reconnect rebuilds the list, and the outcome must survive it.
 */
const [mcpReconnecting, setMcpReconnecting] = createSignal<ReadonlySet<string>>(new Set());
const [mcpNotes, setMcpNotes] = createSignal<Readonly<Record<string, string>>>({});
const mcpKey = (sessionId: string, server: string) => `${sessionId}\u0000${server}`;

/** Redial a server the backend reports as down (#389); the outcome shows inline. */
const McpReconnect: Component<{ sessionId: string; server: string }> = (props) => {
  const key = () => mcpKey(props.sessionId, props.server);
  const busy = () => mcpReconnecting().has(key());
  const setNote = (k: string, note: string | null) =>
    setMcpNotes((prev) => {
      const next = { ...prev };
      if (note === null) delete next[k];
      else next[k] = note;
      return next;
    });
  const run = async () => {
    const k = key();
    setMcpReconnecting((prev) => new Set(prev).add(k));
    setNote(k, null);
    try {
      const r = await reconnectMcpServer(props.sessionId, props.server);
      if (r.status !== "connected") setNote(k, r.deferred ? "Connects when the next turn starts." : (r.error ?? `Still ${r.status}.`));
    } catch (err) {
      setNote(k, err instanceof Error ? err.message : String(err));
    } finally {
      setMcpReconnecting((prev) => {
        const next = new Set(prev);
        next.delete(k);
        return next;
      });
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
      <Show when={mcpNotes()[key()]}>
        <div class="mt-1 basis-full text-[11px] text-fg-muted">{mcpNotes()[key()]}</div>
      </Show>
    </>
  );
};

/**
 * Hand a server's sign-in to codeoid (#390): adopt it from Claude's config,
 * then start codeoid's sign-in. Shown on a remote server codeoid could adopt —
 * one the Claude CLI could only sign in to from an interactive terminal.
 */
const McpAdopt: Component<{ server: string; url: string | null; path: string; projectFile: boolean }> = (props) => {
  const st = () => mcpOAuthState();
  const mine = () => st().server === props.server;
  const run = async () => {
    // Daemon-wide and lasting: say so before doing it — and, for a project's
    // own file, first, that the project chose this address.
    // The address as the daemon built it from the URL parser's own reading:
    // punycode host, encoded path, credentials hidden as "…" (#394) — shown
    // as is, not re-parsed (which would turn "…" into %E2%80%A6).
    const address = props.url ?? "";
    const origin = props.projectFile ? `This project's own ${props.path} chose this server's address. Adopt it only if you trust that address.\n\n` : "";
    const ok = window.confirm(
      `${origin}codeoid will sign in to ${props.server} at ${address} itself. On this whole daemon, Claude sessions stop using the Claude CLI's own copy of it; each account's sessions get codeoid's copy once that account signs in.\n\nContinue?`,
    );
    if (!ok) return;
    const sid = claudeConfig().sessionId;
    await adoptAndSignIn(props.server, sid, props.url);
    // The row turns into codeoid's copy, with its sign-in controls.
    if (sid) await fetchClaudeConfig(sid).catch(() => {});
  };
  return (
    <>
      <button
        type="button"
        class="rounded border border-accent/40 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50"
        title="codeoid signs in to this server itself and serves it to this session's backend — no interactive Claude Code session needed"
        disabled={mine() && st().phase === "starting"}
        onClick={() => void run()}
      >
        {mine() && st().phase === "starting" ? "Adopting…" : "Sign in with codeoid"}
      </button>
      <Show when={mine() && st().error}>
        <div class="mt-1 basis-full text-[11px] text-danger">{st().error}</div>
      </Show>
    </>
  );
};

/** Sign-in controls for a server codeoid has adopted: its settings row's own. */
const AdoptedSignIn: Component<{ server: string }> = (props) => {
  const status = () => settingsState().snapshot?.mcpServers?.find((s) => s.name === props.server && s.oauth);
  // Adopted elsewhere (the CLI, another tab) since settings were read: read them again.
  onMount(() => {
    if (!status()) void fetchSettings(true);
  });
  return (
    <Show when={status()}>
      {(s) => <McpOAuthControls server={s()} />}
    </Show>
  );
};

/** Only a server the backend reports as down can be redialed. */
const canReconnect = (status: string | undefined) => status === "failed" || status === "needs-auth";

/**
 * Claude's MCP config changed since the session applied it (#395): applying
 * it rebuilds the backend (the conversation resumes), so it's the user's call.
 */
const McpStaleBanner: Component<{ sessionId: string }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  return (
    <div class="mb-3 flex items-center gap-2 rounded border border-accent/40 bg-accent/5 px-3 py-2 text-[12px] text-fg">
      <span class="flex-1">MCP servers changed in Claude's config. Refresh to use them in this session (its backend restarts and picks the conversation back up).</span>
      <Show when={error()}>
        <span class="text-[11px] text-danger">{error()}</span>
      </Show>
      <button
        type="button"
        disabled={busy()}
        onClick={() => {
          setBusy(true);
          setError(null);
          refreshMcpServers(props.sessionId)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
        class="rounded border border-accent/60 px-2 py-0.5 text-[11px] text-fg hover:bg-accent/10 disabled:opacity-50"
      >
        {busy() ? "Refreshing…" : "Refresh MCP servers"}
      </button>
    </div>
  );
};

/** Whether a server from Claude's config reaches the session's other backends (#395), and why not. */
const McpReach: Component<{ server: ClaudeConfigMcpServer; sessionId: string | null }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<McpApprovePreview | null>(null);
  const reach = () => props.server.otherBackends;
  const why = () => {
    const r = reach();
    if (!r || r.reach === "all") return "";
    switch (r.why) {
      case "needs-approval":
        return "Claude only — this project chose it; approve it to use it on every backend.";
      case "needs-refresh":
        return "Approved — refresh MCP servers to use it on every backend.";
      case "shadowed":
        return "Claude only — another server of this name is used on the other backends.";
      case "needs-sign-in":
        return "Claude only — it wants a sign-in; adopt it (Sign in with codeoid) to use it on every backend.";
      case "reserved-name":
        return "Claude only — its name is one of codeoid's own.";
      case "read-by-backend":
        return "This session's backend reads the project's .mcp.json itself — its own trust settings decide (e.g. Qwen's folder trust).";
    }
  };
  return (
    <Show when={reach()}>
      <div class="mt-1 flex items-center gap-2 text-[11px] text-fg-muted">
        <Show when={reach()?.reach === "all"} fallback={<span>{why()}</span>}>
          <span>On every backend in this session.</span>
        </Show>
        <Show when={reach()?.reach === "claude-only" && (reach() as { why: string }).why === "needs-approval" && props.sessionId && !preview()}>
          <button
            type="button"
            disabled={busy()}
            onClick={() => {
              setBusy(true);
              setError(null);
              previewMcpApproval(props.sessionId!, props.server.name, props.server.path)
                .then(setPreview)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
            class="rounded border border-border px-1.5 py-0.5 text-[10px] text-fg hover:border-accent/40 disabled:opacity-50"
            title="See exactly what this project's entry runs, then approve it for every backend in this workdir"
          >
            {busy() ? "Loading…" : "Review & approve"}
          </button>
        </Show>
        <Show when={error()}>
          <span class="text-danger">{error()}</span>
        </Show>
      </div>
      <Show when={preview()}>
        {(p) => (
          <div class="mt-1 rounded border border-accent/40 bg-bg-active/40 p-2 text-[11px] text-fg">
            <div class="mb-1 whitespace-pre-wrap break-all text-fg-muted">
              This project's entry, from {p().shownPath} — once approved, every backend in this workdir runs it, with the daemon user's files and network:
            </div>
            <pre class="whitespace-pre-wrap break-all font-mono">{p().lines.join("\n")}</pre>
            <div class="mt-1 flex items-center gap-2">
              <button
                type="button"
                disabled={busy()}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  approveMcpServer(props.sessionId!, p().server, p().path, p().fingerprint)
                    .then(() => setPreview(null))
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false));
                }}
                class="rounded border border-accent/60 px-2 py-0.5 text-[10px] text-fg hover:bg-accent/10 disabled:opacity-50"
              >
                {busy() ? "Approving…" : "Approve this entry"}
              </button>
              <button type="button" onClick={() => setPreview(null)} class="text-[10px] text-fg-muted hover:text-fg">
                Cancel
              </button>
              <span class="text-fg-faint">Shown exactly as it runs; characters that wouldn't show are escaped as \u{"{…}"}, and a run of spaces counted. An env value that is exactly ${"{VAR}"} resolves from the daemon's environment; header values are sent as written.</span>
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
};

const McpList: Component<{ items: ClaudeConfigMcpServer[]; sessionId: string | null; approveIn: string | null }> = (props) => {
  // A reconnect's note is about that outage: a fresh look at the list (the
  // drawer opening, or the MCP tab being shown) starts without old ones, and a server no longer down drops its own.
  onMount(() => setMcpNotes({}));
  createEffect(() => {
    const sid = props.sessionId;
    if (!sid) return;
    const down = new Set(props.items.filter((m) => canReconnect(m.liveStatus)).map((m) => mcpKey(sid, m.name)));
    const notes = untrack(mcpNotes);
    const stale = Object.keys(notes).filter((k) => k.startsWith(`${sid}\u0000`) && !down.has(k));
    if (stale.length === 0) return;
    setMcpNotes(Object.fromEntries(Object.entries(notes).filter(([k]) => !stale.includes(k))));
  });
  return (
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
              <Show
                when={!m.liveOnly}
                fallback={
                  <span
                    class="rounded border border-border bg-bg px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted"
                    title="Run by the backend (a claude.ai connector, a plugin, codeoid), not declared in a config file here"
                  >
                    live
                  </span>
                }
              >
                <ScopeBadge scope={m.scope} />
              </Show>
              <Show when={m.type}>
                <span class="rounded border border-border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                  {m.type}
                </span>
              </Show>
              <McpStatusBadge status={m.liveStatus} toolCount={m.liveTools?.length} />
              <Show when={props.sessionId && canReconnect(m.liveStatus)}>
                <McpReconnect sessionId={props.sessionId!} server={m.name} />
              </Show>
              <Show when={m.adoptable}>
                <McpAdopt server={m.name} url={m.url} path={m.path} projectFile={m.projectFile === true} />
              </Show>
              <Show when={m.adopted}>
                <span
                  class="rounded border border-border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted"
                  title="codeoid signs in to this server; Claude sessions use codeoid's copy, not the Claude CLI's"
                >
                  codeoid
                </span>
              </Show>
            </div>
            <Show when={m.adopted}>
              <AdoptedSignIn server={m.name} />
            </Show>
            <McpReach server={m} sessionId={props.approveIn} />
            <Show when={m.adoptByFullUrl}>
              <div class="mt-1 text-[11px] text-fg-muted">
                To sign in with codeoid, adopt it by its full URL, copied from this project's file (parts of it are hidden here):{" "}
                <code class="font-mono">codeoid mcp adopt {m.name} --session &lt;this session&gt; --url &lt;full URL&gt;</code>
              </div>
            </Show>
            <Show when={m.note}>
              <div class="mt-1 text-[11px] text-fg-muted">{m.note}</div>
            </Show>
            <Show when={m.command}>
              <div class="mt-1 break-all font-mono text-[11px] text-fg-muted">
                {m.command}
                <Show when={(m.argCount ?? 0) > 0}>
                  {" "}
                  <span class="text-fg-faint">
                    ({m.argCount} arg{m.argCount === 1 ? "" : "s"} — see the file)
                  </span>
                </Show>
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
            <Show when={m.path}>
              <PathRow path={m.path} />
            </Show>
          </li>
        )}
      </For>
    </ul>
  </Show>
  );
};

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
            <Show
              when={h.note}
              fallback={
                <pre class="mt-1 overflow-x-auto rounded border border-border bg-bg-active/40 p-2 font-mono text-[11px] text-fg">
                  {h.command}
                </pre>
              }
            >
              <div class="mt-1 text-[11px] text-fg-muted">{h.note}</div>
            </Show>
            <PathRow path={h.path} />
          </li>
        )}
      </For>
    </ul>
  </Show>
);

export default CapabilitiesDrawer;
