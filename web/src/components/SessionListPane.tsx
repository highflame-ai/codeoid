/**
 * Left sidebar — session list (top) + file tree (bottom). Both are
 * scoped to the focused session. Has a "collapse to rail" mode where
 * the sidebar shrinks to 56px and renders icon-only chrome so the
 * chat area dominates the viewport.
 */

import { Component, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { formatCostUsd, formatTokens, relativeTime } from "../lib/format";
import {
  countVisible,
  filterFleet,
  groupFleet,
  roleLabel,
  type FilteredFleetGroup,
} from "../lib/fleet";
import { sessionAgentLabel, shortSub } from "../lib/identity";
import { fetchPanels, liveProgress, livePanelMember, resetPanels } from "../state/panels";
import { nowTick } from "../state/clock";
import {
  focusedSession,
  focusedSessionId,
  focusSession,
  sessionList,
} from "../state/sessions";
import {
  closeNav,
  isLeftCollapsed,
  isMobile,
  toggleLeftCollapsed,
} from "../state/layout";
import type { SessionInfo, SessionStatus } from "../protocol/types";

import FileTree from "./files/FileTree";
import { openNewSessionModal } from "./NewSessionModal";
import AnalyticsPanel from "./AnalyticsPanel";

/** Focus a session and, on mobile, close the off-canvas drawer. */
function pickSession(id: string): void {
  focusSession(id);
  if (isMobile()) closeNav();
}

/**
 * Open the new-session modal and, on mobile, dismiss the drawer first — a nav
 * drawer is transient, so an action that opens a modal should close it (else
 * the drawer covers the dialog).
 */
function newSession(): void {
  if (isMobile()) closeNav();
  openNewSessionModal();
}

/**
 * Panel-state poll cadence. Matches the blackboard drawer's: a fan-out moves on
 * the scale of a model turn, and this is a metadata read with no bodies.
 */
const PANEL_POLL_MS = 3_000;

/**
 * Fleets the user has folded shut, by orchestrator id. Collapsed is the
 * exception, so absence means expanded — a fleet that spawns while you're
 * looking at it opens rather than hiding its own arrival.
 *
 * Module-level so the choice survives the pane unmounting (mobile drawer,
 * sidebar collapse) — a fold that reopens itself every time you close the
 * drawer isn't a fold.
 */
const [collapsedFleets, setCollapsedFleets] = createSignal<ReadonlySet<string>>(
  new Set(),
);

function toggleFleet(parentId: string): void {
  setCollapsedFleets((prev) => {
    const next = new Set(prev);
    if (!next.delete(parentId)) next.add(parentId);
    return next;
  });
}

const SessionListPane: Component = () => {
  const [showAnalytics, setShowAnalytics] = createSignal(false);
  // Instant client-side filter by session name/workdir/role. Complements the
  // semantic cross-session content search (Ctrl+K) — this is the fast
  // "find the session called X" pass, and it works without the memory engine.
  const [filter, setFilter] = createSignal("");
  // Group BEFORE filtering: a filter that matches only a child still needs its
  // orchestrator around to say which goal that child belongs to.
  const groups = createMemo<FilteredFleetGroup[]>(() =>
    filterFleet(groupFleet(sessionList()), filter()),
  );

  // The goal whose panels we poll, as a plain STRING.
  //
  // A memo over a primitive, deliberately. Reading `focusedSession()?.collaboration`
  // directly inside the effect subscribed it to that store property — and
  // `mergeSession` reassigns every field on each `session.info_update` with no
  // equality guard, so `collaboration` gets a fresh object reference on every
  // status flip. The effect then tore down and rebuilt its interval, firing an
  // immediate poll each time: during a tool-heavy turn that turned a 3s cadence
  // into a burst of queries. A memo returning a string only notifies when the id
  // actually changes.
  const polledGoalId = createMemo<string | null>(() => {
    const focused = focusedSession();
    if (!focused) return null;
    if (focused.collaboration !== undefined) return focused.id;
    return focused.collaborationRole?.parentSessionId ?? null;
  });

  // There is no push channel for dispatch state, and a fan-out changes over
  // minutes — a static indicator would show a finished panel as still running.
  // Scoped to the focused goal so the cost stays one cheap metadata query per
  // tick regardless of how many collaborations exist.
  createEffect(() => {
    const goalId = polledGoalId();
    if (!goalId) {
      resetPanels();
      return;
    }
    void fetchPanels(goalId);
    const t = setInterval(() => void fetchPanels(goalId), PANEL_POLL_MS);
    onCleanup(() => clearInterval(t));
  });

  return (
    <Show
      when={!isLeftCollapsed()}
      fallback={<CollapsedRail />}
    >
      <aside class="row-start-2 col-start-1 flex h-full flex-col overflow-y-auto border-r border-border bg-bg-elev">
        <SectionHeader
          title="Sessions"
          count={filter().trim() ? countVisible(groups()) : sessionList().length}
          showAnalytics={showAnalytics()}
          onToggleAnalytics={() => setShowAnalytics((v) => !v)}
        />
        <Show when={showAnalytics()}>
          <AnalyticsPanel />
        </Show>
        <button
          type="button"
          onClick={newSession}
          class="mx-3 mt-1 flex items-center gap-2 rounded border border-dashed border-border px-2 py-1.5 text-left text-xs text-fg-muted transition hover:border-accent/40 hover:bg-accent/5 hover:text-fg"
          title="New session (Ctrl+N)"
        >
          <span class="text-base leading-none">＋</span>
          <span>new session</span>
          <span class="ml-auto rounded bg-bg px-1 py-0.5 font-mono text-[10px] text-fg-faint">
            ⌘N
          </span>
        </button>
        <Show
          when={sessionList().length > 0}
          fallback={<EmptyState />}
        >
          <SessionFilter value={filter()} onInput={setFilter} />
          <Show when={groups().length > 0} fallback={<NoMatch query={filter()} />}>
            <ul class="flex flex-col py-1">
              <For each={groups()}>
                {(g) => <FleetGroupRows group={g} />}
              </For>
            </ul>
          </Show>
        </Show>
        <Show when={focusedSessionId()}>
          <div class="mt-2 border-t border-border pt-1">
            <FileTree />
          </div>
        </Show>
      </aside>
    </Show>
  );
};

const CollapsedRail: Component = () => (
  <aside class="row-start-2 col-start-1 flex h-full flex-col items-center gap-2 overflow-y-auto border-r border-border bg-bg-elev py-2">
    <button
      type="button"
      onClick={toggleLeftCollapsed}
      class="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      title="Expand sidebar"
    >
      ▸
    </button>
    <button
      type="button"
      onClick={newSession}
      class="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
      title="New session (Ctrl+N)"
    >
      ＋
    </button>
    <div class="my-1 h-px w-6 bg-border" />
    {/* Same grouping as the expanded pane, reduced to what fits in 56px: a
        fleet's members sit in an inset, ruled column under their orchestrator
        and are keyed by role rather than by name (every child's name starts
        with the parent's, so name initials would all collide). */}
    <For each={groupFleet(sessionList())}>
      {(g) => (
        <>
          <RailButton
            session={g.lead}
            label={g.lead.name.slice(0, 2).toUpperCase()}
            title={`${g.lead.name} · ${g.lead.workdir}${g.lead.collaboration ? `\n◇ ${g.lead.collaboration.goal}` : ""}`}
          />
          <Show when={g.children.length > 0}>
            <div class="flex w-full flex-col items-end gap-1 border-l border-border/70 pl-2">
              <For each={g.children}>
                {(c) => (
                  <RailButton
                    session={c}
                    label={(roleLabel(c) ?? c.name).slice(0, 2).toLowerCase()}
                    title={`${roleLabel(c)} — ${c.name}${c.collaborationRole?.write ? "" : " (read-only)"}`}
                  />
                )}
              </For>
            </div>
          </Show>
        </>
      )}
    </For>
  </aside>
);

const RailButton: Component<{
  session: SessionInfo;
  label: string;
  title: string;
}> = (props) => (
  <button
    type="button"
    onClick={() => pickSession(props.session.id)}
    class={`flex h-7 w-7 shrink-0 items-center justify-center rounded font-mono text-[11px] transition ${
      focusedSessionId() === props.session.id
        ? "bg-accent/20 text-accent"
        : "text-fg-muted hover:bg-bg-hover hover:text-fg"
    }`}
    title={props.title}
  >
    {props.label}
  </button>
);

const SectionHeader: Component<{
  title: string;
  count: number;
  showAnalytics: boolean;
  onToggleAnalytics: () => void;
}> = (props) => (
  <div class="sticky top-0 z-10 flex items-center justify-between gap-2 bg-bg-elev/95 px-3 pb-2 pt-3 text-[11px] font-medium uppercase tracking-wider text-fg-faint backdrop-blur">
    <span>{props.title}</span>
    <Show when={props.count > 0}>
      <span class="rounded-full bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
        {props.count}
      </span>
    </Show>
    <button
      type="button"
      onClick={props.onToggleAnalytics}
      class={`rounded p-0.5 transition hover:bg-bg-hover hover:text-fg ${props.showAnalytics ? "text-accent" : "text-fg-faint"}`}
      title="Usage analytics"
    >
      ≋
    </button>
    <button
      type="button"
      onClick={toggleLeftCollapsed}
      class="rounded p-0.5 text-fg-faint transition hover:bg-bg-hover hover:text-fg"
      title="Collapse sidebar"
    >
      ◂
    </button>
  </div>
);

const EmptyState: Component = () => (
  <div class="px-3 py-6 text-sm text-fg-muted">
    <p class="mb-2">No sessions yet.</p>
    <p class="text-xs text-fg-faint">
      Create one from the prompt with <code class="font-mono">/new &lt;name&gt; [workdir]</code>.
    </p>
  </div>
);

/** Instant name/workdir filter for the session list. */
const SessionFilter: Component<{ value: string; onInput: (v: string) => void }> = (props) => (
  <div class="mx-3 mt-1 flex items-center gap-1.5 rounded border border-border bg-bg px-2 py-1 focus-within:border-accent/40">
    <span class="text-xs text-fg-faint" aria-hidden="true">
      ⌕
    </span>
    <input
      type="text"
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      placeholder="Filter sessions by name…"
      aria-label="Filter sessions by name"
      class="flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
    />
    <Show when={props.value.length > 0}>
      <button
        type="button"
        onClick={() => props.onInput("")}
        class="text-fg-faint transition hover:text-fg"
        title="Clear filter"
        aria-label="Clear filter"
      >
        ✕
      </button>
    </Show>
  </div>
);

/** Shown when the name filter matches nothing — points at semantic search. */
const NoMatch: Component<{ query: string }> = (props) => (
  <div class="px-3 py-4 text-xs text-fg-muted">
    <p class="mb-1">
      No session name matches “<span class="text-fg">{props.query}</span>”.
    </p>
    <p class="text-fg-faint">
      Press{" "}
      <kbd class="rounded border border-border bg-bg px-1 font-mono">Ctrl+K</kbd> to search message
      content across sessions.
    </p>
  </div>
);

/**
 * One top-level session and, when it orchestrates a collaboration, its
 * role-children indented beneath it.
 *
 * The children are real sessions you can focus and read — they are long-lived,
 * not transient dispatch workers — so they stay clickable rows rather than a
 * summary line. What changes is that they're visibly *of* the orchestrator.
 */
const FleetGroupRows: Component<{ group: FilteredFleetGroup }> = (props) => {
  const collapsed = () => collapsedFleets().has(props.group.lead.id);
  const hasChildren = () => props.group.children.length > 0;

  return (
    <>
      <SessionRow
        session={props.group.lead}
        dimmed={!props.group.leadMatched}
        fleet={
          props.group.isFleet
            ? {
                childCount: props.group.children.length,
                collapsed: collapsed(),
                onToggle: () => toggleFleet(props.group.lead.id),
              }
            : undefined
        }
      />
      <Show when={hasChildren() && !collapsed()}>
        <li>
          {/* The rail is the grouping: one continuous line down the left of
              the fleet, so a child is unmistakably subordinate even when the
              orchestrator has scrolled out of view. */}
          <ul class="ml-[1.4rem] flex flex-col border-l border-border/70">
            <For each={props.group.children}>
              {(c) => <SessionRow session={c} nested />}
            </For>
          </ul>
        </li>
      </Show>
    </>
  );
};

interface FleetLeadProps {
  childCount: number;
  collapsed: boolean;
  onToggle: () => void;
}

const SessionRow: Component<{
  session: SessionInfo;
  /**
   * Rendered indented under its orchestrator. Distinct from "is a role-child":
   * an orphan child (parent destroyed or not yet delivered) is a role-child
   * rendered at top level, and must keep its role badges while showing its
   * full name — there's no parent row above it to supply the context.
   */
  nested?: boolean;
  /** Present when this session orchestrates a collaboration. */
  fleet?: FleetLeadProps;
  /** Shown only to give matching children a parent — not a filter hit itself. */
  dimmed?: boolean;
}> = (props) => {
  const isActive = () => focusedSessionId() === props.session.id;
  const role = () => props.session.collaborationRole;
  // A child's daemon-generated name is `<parent>:<role>[-N]`; under the parent
  // that prefix is pure repetition, so a nested row leads with the role and
  // keeps the full name in the tooltip.
  const title = () =>
    (props.nested && roleLabel(props.session)) || props.session.name;
  return (
    <li class="flex items-stretch">
      <button
        type="button"
        onClick={() => pickSession(props.session.id)}
        title={props.nested ? props.session.name : undefined}
        class={`flex min-w-0 flex-1 flex-col gap-1 border-l-2 text-left transition hover:bg-bg-hover ${
          props.nested ? "py-1.5 pl-2 pr-3" : "px-3 py-2"
        } ${
          isActive()
            ? "border-l-accent bg-bg-active"
            : "border-l-transparent"
        } ${props.dimmed ? "opacity-60" : ""}`}
      >
        <div class="flex items-center gap-2">
          <StatusDot status={props.session.status} />
          <span
            class={`flex-1 truncate font-medium text-fg ${props.nested ? "font-mono text-[12px]" : "text-sm"}`}
          >
            {title()}
          </span>
          <Show when={role()}>
            {(r) => <WriteBadge write={r().write} />}
          </Show>
          {/* Which children are in the LIVE fan-out, and where each one is.
              Session-keyed, because a role can have several members. */}
          <Show when={livePanelMember(props.session.id)}>
            {(m) => <PanelMemberBadge ordinal={m().ordinal} status={m().status} />}
          </Show>
          <Show when={props.session.usage}>
            {(u) => (
              <span class="font-mono text-[11px] text-accent" title="Estimated cost">
                {formatCostUsd(u().totalCostUsd)}
              </span>
            )}
          </Show>
        </div>
        {/* Children share the orchestrator's workdir verbatim (spawned with
            `workdir: parent.workdir`), so repeating it on every child row is
            noise. The goal is what distinguishes a fleet; show that instead. */}
        <Show when={!props.nested}>
          <div
            class="truncate text-[11px] text-fg-faint"
            title={props.session.workdir}
          >
            {props.session.workdir}
          </div>
        </Show>
        <Show when={props.session.collaboration}>
          {(c) => (
            <div
              class="truncate text-[11px] italic text-fg-muted"
              title={c().goal}
            >
              ◇ {c().goal}
            </div>
          )}
        </Show>
        {/* The fan-out, while it runs. This is the whole point of a panel and
            was invisible until the daemon started reporting it. */}
        <Show when={props.fleet ? liveProgress() : null}>
          {(p) => (
            <PanelProgress
              settled={p().settled}
              total={p().total}
              panels={p().panels}
            />
          )}
        </Show>
        <div class="flex items-center gap-2 text-[11px] text-fg-muted">
          <Show when={!props.nested}>
            <span title={`Agent: ${props.session.agentUri ?? "anonymous"}`}>
              ⌬ <span class="font-mono">{sessionAgentLabel(props.session)}</span>
            </span>
          </Show>
          {/* Children always show their backend, including "claude": which model
              is behind which role is the entire point of a mixed fleet, so it
              must not be inferable only from the absence of a chip. */}
          <Show
            when={
              props.session.providerId &&
              (role() !== undefined || props.session.providerId !== "claude")
            }
          >
            <span
              class="rounded border border-accent/40 bg-accent/10 px-1 font-mono text-[10px] text-accent"
              title={`Backend: ${props.session.providerId}${props.session.model ? ` · model: ${props.session.model}` : ""}`}
            >
              {props.session.providerId}
            </span>
          </Show>
          <Show when={props.session.usage}>
            {(u) => (
              <>
                <span class="text-fg-faint">·</span>
                <span title="Cumulative input / output tokens">
                  {formatTokens(u().inputTokens)}/{formatTokens(u().outputTokens)}
                </span>
                <span class="text-fg-faint">·</span>
                <span title="Total turns">{u().numTurns}t</span>
              </>
            )}
          </Show>
          <Show
            when={
              props.session.subagents &&
              props.session.subagents.filter((sa) => sa.active).length > 0
            }
          >
            <span class="text-fg-faint">·</span>
            <span
              class="text-role-tool"
              title={
                props.session.subagents
                  ?.filter((sa) => sa.active)
                  .map((sa) => `${sa.agentType} (${shortSub(sa.wimseUri)})`)
                  .join("\n")
              }
            >
              {
                props.session.subagents?.filter((sa) => sa.active).length
              }{" "}
              sub
            </span>
          </Show>
        </div>
        <Show when={!props.nested}>
          <div class="text-[10px] text-fg-faint">
            created {relativeTime(props.session.createdAt, nowTick())}
          </div>
        </Show>
      </button>
      {/* Sibling of the row, not nested inside it — a button inside a button is
          invalid HTML and browsers resolve the click ambiguity differently. */}
      <Show when={props.fleet}>
        {(f) => (
          <button
            type="button"
            onClick={f().onToggle}
            aria-expanded={!f().collapsed}
            aria-label={`${f().collapsed ? "Expand" : "Collapse"} fleet (${f().childCount} role${f().childCount === 1 ? "" : "s"})`}
            title={`${f().childCount} role${f().childCount === 1 ? "" : "s"} — click to ${f().collapsed ? "expand" : "collapse"}`}
            class="flex w-7 shrink-0 flex-col items-center justify-center gap-0.5 border-l border-border/50 text-fg-faint transition hover:bg-bg-hover hover:text-fg"
          >
            <span class="text-[10px] leading-none">{f().collapsed ? "▸" : "▾"}</span>
            <span class="font-mono text-[10px] leading-none">{f().childCount}</span>
          </button>
        )}
      </Show>
    </li>
  );
};

/**
 * Live fan-out progress on the orchestrator row: "⇉ panel 2/3".
 *
 * Counts SETTLED members, not successful ones — the barrier joins on terminal,
 * so a panel with a failed member is 3/3 and finished. Showing successes would
 * leave the bar short of full on a panel that is already done, which is exactly
 * the confusion the indicator exists to remove.
 */
const PanelProgress: Component<{
  settled: number;
  total: number;
  /** How many fan-outs are live. More than one is legal — an orchestrator can
   *  run a second panel while the first is still resolving. */
  panels: number;
}> = (props) => {
  const pct = () => (props.total === 0 ? 0 : (props.settled / props.total) * 100);
  return (
    <div
      class="flex items-center gap-1.5"
      title={`${props.panels === 1 ? "Panel" : `${props.panels} panels`} in flight — ${props.settled} of ${props.total} member(s) finished. Counts members that have SETTLED (including failures), because the join fires on all-terminal.`}
    >
      <span class="font-mono text-[10px] text-warn">
        ⇉ {props.panels === 1 ? "panel" : `panels ×${props.panels}`}
      </span>
      <span
        class="h-1 flex-1 overflow-hidden rounded-full bg-bg"
        role="progressbar"
        aria-valuenow={props.settled}
        aria-valuemin={0}
        aria-valuemax={props.total}
        aria-label="Panel members finished"
      >
        <span
          class="block h-full rounded-full bg-warn transition-[width] duration-300"
          style={{ width: `${pct()}%` }}
        />
      </span>
      <span class="font-mono text-[10px] text-warn">
        {props.settled}/{props.total}
      </span>
    </div>
  );
};

/** A child's position and state within the live fan-out. */
const PanelMemberBadge: Component<{
  ordinal: number;
  status: "queued" | "claimed" | "running" | "done" | "failed" | "blocked";
}> = (props) => {
  const look = () => {
    switch (props.status) {
      case "running":
      case "claimed":
        return { cls: "border-warn/50 bg-warn/10 text-warn animate-pulse", note: "working" };
      case "done":
        return { cls: "border-success/50 bg-success/10 text-success", note: "finished" };
      case "failed":
      case "blocked":
        // Shown, never hidden — §7's "disagreement is shown" applies to a
        // member that failed just as much as to one that disagreed.
        return { cls: "border-danger/50 bg-danger/10 text-danger", note: props.status };
      default:
        return { cls: "border-border bg-bg text-fg-muted", note: "queued" };
    }
  };
  return (
    <span
      class={`rounded border px-1 font-mono text-[10px] ${look().cls}`}
      title={`Panel member ${props.ordinal} — ${look().note}`}
    >
      ⇉{props.ordinal}
    </span>
  );
};

/**
 * Whether a role-child may write. Read-only is the interesting state — it's the
 * §6 independence property made visible (a scout's leaf identity carries no
 * `tools:write` at all), so it gets the badge and write gets a quiet marker
 * rather than both shouting equally.
 */
const WriteBadge: Component<{ write: boolean }> = (props) => (
  <Show
    when={props.write}
    fallback={
      <span
        class="rounded border border-border bg-bg px-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted"
        title="Read-only role — its identity carries no write authority, and write tools are denied at the fence"
      >
        ro
      </span>
    }
  >
    <span
      class="font-mono text-[10px] text-warn"
      title="This role may write to the workspace"
    >
      ✎
    </span>
  </Show>
);

const StatusDot: Component<{ status: SessionStatus }> = (props) => {
  const cls = () => {
    switch (props.status) {
      case "thinking":
      case "tool_running":
        return "bg-warn animate-pulse";
      case "error":
        return "bg-danger";
      default:
        return "bg-success/70";
    }
  };
  return (
    <span
      class={`inline-block h-2 w-2 shrink-0 rounded-full ${cls()}`}
      title={props.status}
    />
  );
};

export default SessionListPane;
