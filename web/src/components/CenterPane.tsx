/**
 * Center pane — header (with full UsageStrip) → transcript →
 * approval bar (when active) → prompt.
 */

import { Component, Show } from "solid-js";

import {
  ctxWindowColorClass,
  formatCostUsd,
  formatDuration,
  formatPercent,
  formatTokens,
  relativeTime,
} from "../lib/format";
import { sessionAgentLabel, shortSub, truncateWimseUri } from "../lib/identity";
import { effectiveMode } from "../lib/session-mode";
import { nowTick } from "../state/clock";
import { focusedSession } from "../state/sessions";
import { isHeaderCollapsed, toggleHeaderCollapsed } from "../state/layout";

import ApprovalBar from "./transcript/ApprovalBar";
import UiRequestBar from "./transcript/UiRequestBar";
import PromptBox from "./prompt/PromptBox";
import SessionControls from "./SessionControls";
import Transcript from "./transcript/Transcript";
import FleetRail from "./FleetRail";
import WorkerIndicator from "./transcript/WorkerIndicator";
import { openNewSessionModal } from "./NewSessionModal";
import { openImportModal } from "./SessionImportModal";

const CenterPane: Component = () => {
  const isConductor = () => focusedSession()?.role === "conductor";
  return (
    <main class="row-start-2 col-start-3 flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <Show
        when={focusedSession()}
        fallback={
          <div class="flex flex-1 items-center justify-center px-6">
            <div class="max-w-md space-y-4 text-center">
              <h1 class="text-lg font-semibold text-fg">No active session</h1>
              <p class="text-sm text-fg-muted">
                Sessions are persistent Claude conversations rooted at a
                workdir. The daemon registers a per-session ZeroID identity
                so any frontend (web, TUI, Telegram) can resume them.
              </p>
              <div class="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={openNewSessionModal}
                  class="rounded bg-accent px-4 py-2 text-sm font-semibold text-bg transition hover:bg-accent-hover"
                >
                  Create your first session
                </button>
                <button
                  type="button"
                  onClick={openImportModal}
                  class="rounded border border-border px-3 py-2 text-sm text-fg-muted transition hover:border-accent/40 hover:text-fg"
                  title="Import a session bundle exported by a teammate"
                >
                  Fork from bundle…
                </button>
              </div>
              <p class="text-[11px] text-fg-faint">
                <kbd class="rounded border border-border bg-bg-elev px-1 font-mono">⌘N</kbd>{" "}
                new ·{" "}
                <kbd class="rounded border border-border bg-bg-elev px-1 font-mono">⌘K</kbd>{" "}
                search · /import to fork an existing bundle
              </p>
            </div>
          </div>
        }
      >
        <SessionHeader />
        {/* The conductor is a lens, not a wall (§3): it gets the SAME chat
            cockpit every agent gets, with the fleet board docked beside it —
            never a second, divergent copy of a session's chat. */}
        <Show when={isConductor()} fallback={<SessionBody />}>
          <div class="flex min-h-0 flex-1">
            <div class="flex min-w-0 flex-1 flex-col">
              <SessionBody />
            </div>
            <FleetRail />
          </div>
        </Show>
      </Show>
    </main>
  );
};

/**
 * Chat cockpit — identical for every session, conductor included. Extracted so
 * the conductor branch docks a rail beside it rather than reimplementing it.
 */
const SessionBody: Component = () => (
  <>
    <Transcript />
    <WorkerIndicator />
    <ApprovalBar />
    <UiRequestBar />
    <PromptBox />
  </>
);

const SessionHeader: Component = () => (
  <Show when={focusedSession()}>
    {(s) => (
      <Show when={!isHeaderCollapsed()} fallback={<CollapsedHeader />}>
        <div class="flex flex-col gap-2 border-b border-border bg-bg-elev/60 px-4 py-3">
          <div class="flex items-center gap-3">
            <h2 class="font-semibold text-fg">{s().name}</h2>
            <span class="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
              {effectiveMode(s())}
            </span>
            <Show when={s().model}>
              <span class="rounded border border-accent/30 bg-accent/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
                {s().model}
              </span>
            </Show>
            <span class="ml-auto font-mono text-[11px] text-fg-faint">
              created {relativeTime(s().createdAt, nowTick())}
            </span>
            <button
              type="button"
              onClick={toggleHeaderCollapsed}
              class="rounded p-1 text-fg-faint transition hover:bg-bg-hover hover:text-fg"
              title="Collapse header"
            >
              ▴
            </button>
          </div>
          <SessionControls />
          <div
            class="truncate font-mono text-[11px] text-fg-muted"
            title={s().workdir}
          >
            {s().workdir}
          </div>
          <div
            class="flex items-center gap-2 truncate text-[11px] text-fg-faint"
            title={s().agentUri ?? "anonymous"}
          >
            <span>⌬</span>
            <span class="font-mono">
              {s().agentUri && !s().agentUri!.startsWith("anonymous:")
                ? truncateWimseUri(s().agentUri!)
                : sessionAgentLabel(s())}
            </span>
            <SubagentChip />
          </div>
          <UsageStrip />
        </div>
      </Show>
    )}
  </Show>
);

/** One-line summary header — name · mode · model · turns · cost · expand. */
const CollapsedHeader: Component = () => (
  <Show when={focusedSession()}>
    {(s) => (
      <div class="flex items-center gap-3 border-b border-border bg-bg-elev/60 px-4 py-1.5 text-[12px]">
        <span class="font-semibold text-fg">{s().name}</span>
        <span class="text-fg-faint">·</span>
        <span class="font-mono uppercase tracking-wider text-fg-muted">
          {effectiveMode(s())}
        </span>
        <Show when={s().model}>
          <span class="text-fg-faint">·</span>
          <span class="font-mono uppercase tracking-wider text-accent">
            {s().model}
          </span>
        </Show>
        <Show when={s().usage}>
          {(u) => (
            <>
              <span class="text-fg-faint">·</span>
              <span class="font-mono text-fg-muted">
                {u().numTurns}t · {formatTokens(u().inputTokens)}/
                {formatTokens(u().outputTokens)}
              </span>
              <span class="text-fg-faint">·</span>
              <span class="font-mono font-semibold text-accent">
                {formatCostUsd(u().totalCostUsd)}
              </span>
            </>
          )}
        </Show>
        <SubagentChip />
        <span class="ml-auto" />
        <button
          type="button"
          onClick={toggleHeaderCollapsed}
          class="rounded p-1 text-fg-faint transition hover:bg-bg-hover hover:text-fg"
          title="Expand header"
        >
          ▾
        </button>
      </div>
    )}
  </Show>
);

const SubagentChip: Component = () => {
  const active = () =>
    focusedSession()?.subagents?.filter((sa) => sa.active) ?? [];
  return (
    <Show when={active().length > 0}>
      <span
        class="ml-2 flex items-center gap-1 rounded border border-role-tool/30 bg-role-tool/5 px-1.5 py-0.5 text-role-tool"
        title={active()
          .map((sa) => `${sa.agentType} · ${shortSub(sa.wimseUri)}`)
          .join("\n")}
      >
        <span>⊕</span>
        <span class="font-mono text-[10px]">{active().length} sub</span>
      </span>
    </Show>
  );
};

/** Conservative fallback for daemons that don't yet emit usage.contextWindow. */
const CONTEXT_WINDOW_FALLBACK = 200_000;

const UsageStrip: Component = () => (
  <Show when={focusedSession()?.usage}>
    {(u) => (
      <div class="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4 lg:grid-cols-8">
        <CtxStat />
        <Stat label="Turns" value={String(u().numTurns)} />
        <Stat
          label="New input"
          value={formatTokens(u().inputTokens)}
          hint="Cumulative NEW (uncached) input tokens. Cache reads are billed separately and live in the Cache read tile."
        />
        <Stat label="Output" value={formatTokens(u().outputTokens)} />
        <Stat
          label="Cache read"
          value={formatTokens(u().cacheReadTokens)}
          hint={
            u().lastTurnCacheHitRate != null
              ? `last hit rate ${formatPercent(u().lastTurnCacheHitRate, 0)}`
              : undefined
          }
        />
        <Stat label="Cache write" value={formatTokens(u().cacheCreationTokens)} />
        <Stat
          label="Agent time"
          value={formatDuration(u().durationMs)}
          hint="sum of per-turn agent work"
        />
        <Stat
          label="Cost"
          value={formatCostUsd(u().totalCostUsd)}
          accent
          hint="SDK-reported, daemon-canonical"
        />
      </div>
    )}
  </Show>
);

const Stat: Component<{
  label: string;
  value: string;
  accent?: boolean;
  hint?: string;
}> = (props) => (
  <div
    class="flex flex-col gap-0.5 rounded border border-border bg-bg px-2 py-1.5"
    title={props.hint}
  >
    <span class="text-[10px] uppercase tracking-wider text-fg-faint">
      {props.label}
    </span>
    <span
      class={`font-mono text-sm ${props.accent ? "text-accent font-semibold" : "text-fg"}`}
    >
      {props.value}
    </span>
  </div>
);

/**
 * Dedicated context-window stat — value comes with a colored progress
 * bar so the user sees their headroom at a glance. Window comes from
 * `usage.contextWindow` (daemon-canonical, derived from session.model)
 * and falls back to 200k for daemons that don't emit it yet.
 */
const CtxStat: Component = () => (
  <Show
    when={focusedSession()?.usage?.lastTurnInputTokens}
    fallback={<Stat label="Context" value="—" hint="awaiting first turn" />}
  >
    {(ctx) => {
      const window = () =>
        focusedSession()?.usage?.contextWindow ?? CONTEXT_WINDOW_FALLBACK;
      const ratio = () => Math.min(ctx() / window(), 1);
      return (
        <div
          class="flex flex-col gap-0.5 rounded border border-border bg-bg px-2 py-1.5"
          title={`Last turn context = ${ctx().toLocaleString()} of ${window().toLocaleString()} tokens`}
        >
          <span class="flex items-center justify-between text-[10px] uppercase tracking-wider text-fg-faint">
            <span>Context</span>
            <span class={`font-mono ${ctxWindowColorClass(ratio())}`}>
              {formatPercent(ratio(), 0)}
            </span>
          </span>
          <span class={`font-mono text-sm ${ctxWindowColorClass(ratio())}`}>
            {formatTokens(ctx())}
          </span>
          <div class="mt-1 h-1 w-full overflow-hidden rounded-full bg-bg-active">
            <div
              class={`h-full transition-[width] duration-300 ${
                ratio() < 0.6
                  ? "bg-success/80"
                  : ratio() < 0.85
                    ? "bg-warn/80"
                    : "bg-danger/80"
              }`}
              style={{ width: `${ratio() * 100}%` }}
            />
          </div>
        </div>
      );
    }}
  </Show>
);

export default CenterPane;
