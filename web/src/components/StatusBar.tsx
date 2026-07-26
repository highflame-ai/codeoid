/**
 * Top status bar. Always visible. Shows:
 *
 *   [logo] · [connection pill] · [identity] | [session metrics] | [model badge]
 *
 * Identity is shown with full provenance — name + short WIMSE sub on
 * hover. Session metrics pull straight from `SessionInfo.usage` so the
 * daemon stays canonical.
 */

import { Component, Show } from "solid-js";

import {
  ctxWindowColorClass,
  elapsedSince,
  formatCostUsd,
  formatDuration,
  formatPercent,
  formatTokens,
} from "../lib/format";
import { identityLabel, identityColorClass } from "../lib/identity";
import { authIdentity, connectionStatus, disconnect } from "../state/connection";
import { nowTick } from "../state/clock";
import { isMobile, toggleNav } from "../state/layout";
import { focusedSession } from "../state/sessions";
import { forgetApiKey } from "../lib/auth";
import { openIdentityDrawer } from "./IdentityDrawer";
import { openSettings } from "./SettingsDrawer";
import { notifyPermission, requestEnable } from "../state/desktop-notifications";

const StatusBar: Component = () => {
  return (
    <header class="col-span-full flex items-center gap-3 border-b border-border bg-bg-elev px-4 text-sm text-fg-muted">
      <Show when={isMobile()}>
        <button
          type="button"
          class="-ml-1 rounded px-1.5 py-1 text-lg leading-none text-fg-muted hover:text-fg"
          onClick={toggleNav}
          aria-label="Open sessions"
          title="Sessions"
        >
          ☰
        </button>
      </Show>
      <span class="select-none font-mono font-semibold text-fg">codeoid</span>
      <Sep />
      <ConnectionPill />
      <Sep />
      <IdentityChip />
      <LocalModeChip />
      <span class="ml-auto flex items-center gap-3">
        <SessionMetrics />
        <SearchHotkey />
        <SettingsButton />
        <NotifyToggle />
        <SignOut />
      </span>
    </header>
  );
};

const Sep: Component = () => <span class="text-fg-faint">·</span>;

const ConnectionPill: Component = () => {
  const dotClass = () => {
    const s = connectionStatus();
    switch (s.kind) {
      case "connected":
        return "bg-success";
      case "connecting":
      case "reconnecting":
        return "bg-warn animate-pulse";
      case "failed":
        return "bg-danger";
      default:
        return "bg-fg-faint";
    }
  };
  const label = () => {
    const s = connectionStatus();
    switch (s.kind) {
      case "connected":
        return "live";
      case "connecting":
        return `connecting · #${s.attempt}`;
      case "reconnecting":
        return `reconnecting · ${Math.round(s.nextInMs / 1000)}s`;
      case "failed":
        return `failed · ${s.reason}`;
      default:
        return "idle";
    }
  };
  return (
    <span class="flex items-center gap-2 font-mono text-xs">
      <span class={`inline-block h-2 w-2 rounded-full ${dotClass()}`} />
      <span>{label()}</span>
    </span>
  );
};

const IdentityChip: Component = () => {
  const id = () => authIdentity()?.identity;
  return (
    <Show when={id()}>
      {(idGetter) => (
        <button
          type="button"
          onClick={openIdentityDrawer}
          class="flex items-center gap-1.5 truncate rounded px-1 py-0.5 transition hover:bg-bg-hover"
          title={`Click for full identity · /who\n${idGetter().sub}`}
        >
          <span class="text-fg-faint">as</span>
          <span class={`font-medium ${identityColorClass(idGetter().type)}`}>
            {identityLabel(idGetter())}
          </span>
        </button>
      )}
    </Show>
  );
};

/**
 * Local-mode badge.
 *
 * The daemon reports `authMode: "local"` on `auth.ok` when it is running
 * without ZeroID. Rendering that is not decoration — it is the thing that stops
 * someone demonstrating an identity-first control plane in the one mode with no
 * identity. Deliberately styled as a warning and always visible (not a
 * tooltip-only hint) whenever the posture is degraded.
 */
const LocalModeChip: Component = () => {
  return (
    <Show when={authIdentity()?.authMode === "local"}>
      <span
        class="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-warn"
        title={
          "LOCAL MODE — this daemon runs without ZeroID.\n" +
          "The principal is self-asserted: no per-agent identity, no delegation,\n" +
          "no revocation, and audit attribution is not cryptographic.\n" +
          "Run `codeoid login` and restart without --local for real identities."
        }
      >
        local mode
      </span>
    </Show>
  );
};

const SessionMetrics: Component = () => {
  return (
    <Show when={focusedSession()}>
      {(s) => {
        const usage = () => s().usage;
        return (
          <span class="flex items-center gap-3 font-mono text-xs">
            <span title="Wall-clock since session started">
              <span class="text-fg-faint">⏱</span>{" "}
              <span>{elapsedSince(s().createdAt, nowTick())}</span>
            </span>
            <span title="Total turns">
              <span class="text-fg-faint">↻</span>{" "}
              <span>{usage()?.numTurns ?? 0}</span>
              <span class="text-fg-faint"> turn(s)</span>
            </span>
            <CtxWindowPill />
            <span title="Cumulative input / output tokens">
              <span class="text-fg-faint">⇣</span>{" "}
              <span>{formatTokens(usage()?.inputTokens)}</span>
              <span class="text-fg-faint">/</span>
              <span class="text-fg-faint">⇡</span>{" "}
              <span>{formatTokens(usage()?.outputTokens)}</span>
            </span>
            <span class="font-semibold text-accent" title="Estimated cost (SDK-reported)">
              {formatCostUsd(usage()?.totalCostUsd)}
            </span>
            <Show when={s().model}>
              <span class="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
                {s().model}
              </span>
            </Show>
            <Show when={usage()?.lastTurnCostUsd != null}>
              <span class="text-fg-faint" title="Last turn cost / latency">
                last {formatCostUsd(usage()?.lastTurnCostUsd)} ·{" "}
                {formatDuration(usage()?.recentTurns?.[0]?.durationMs)}
              </span>
            </Show>
          </span>
        );
      }}
    </Show>
  );
};

/** Conservative fallback for daemons that don't yet emit usage.contextWindow. */
const CONTEXT_WINDOW_FALLBACK = 200_000;

const CtxWindowPill: Component = () => (
  <Show when={focusedSession()?.usage?.lastTurnInputTokens}>
    {(ctx) => {
      const window = () =>
        focusedSession()?.usage?.contextWindow ?? CONTEXT_WINDOW_FALLBACK;
      const ratio = () => ctx() / window();
      return (
        <span
          class={`flex items-center gap-1 ${ctxWindowColorClass(ratio())}`}
          title={`Last turn context = ${ctx().toLocaleString()} of ${window().toLocaleString()} (${formatPercent(ratio(), 1)})`}
        >
          <span class="text-fg-faint">ctx</span>
          <span>{formatPercent(ratio(), 0)}</span>
        </span>
      );
    }}
  </Show>
);

const SearchHotkey: Component = () => (
  <button
    type="button"
    onClick={() => {
      // Same chord SearchModal listens for — synthesize it so the user
      // can mouse-click and still trigger the modal.
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    }}
    class="flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] text-fg-muted hover:border-accent/40 hover:text-fg"
    title="Search across sessions (Ctrl+K)"
  >
    <span>🔍</span>
    <span class="font-mono">Ctrl K</span>
  </button>
);

const SettingsButton: Component = () => (
  <button
    type="button"
    onClick={openSettings}
    class="flex items-center rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] text-fg-muted hover:border-accent/40 hover:text-fg"
    title="Settings"
  >
    ⚙
  </button>
);

const SignOut: Component = () => {
  // Nothing to sign out OF in local mode: there is no account, and the daemon
  // re-hands the page its token on the next load — so the button would
  // "log you out" and then silently log you back in. Hide it instead.
  return (
    <Show when={authIdentity()?.authMode !== "local"}>
      <button
        class="text-xs text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
        onClick={() => {
          forgetApiKey();
          disconnect();
          // Force the auth gate to re-render. App.tsx subscribes to
          // authIdentity() being null, so this triggers automatically.
        }}
      >
        sign out
      </button>
    </Show>
  );
};

const NotifyToggle: Component = () => {
  const state = () => notifyPermission();
  return (
    <Show when={state() !== "unsupported"}>
      <Show
        when={state() === "default"}
        fallback={
          <Show when={state() === "denied"}>
            <span
              class="text-[11px] text-fg-faint"
              title="Browser notifications were denied. Re-enable from your browser's site settings."
            >
              🔕
            </span>
          </Show>
        }
      >
        <button
          type="button"
          class="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          onClick={() => {
            void requestEnable();
          }}
          title="Get a desktop notification when an approval is pending and the tab is in the background"
        >
          🔔 enable notifications
        </button>
      </Show>
    </Show>
  );
};

export default StatusBar;
