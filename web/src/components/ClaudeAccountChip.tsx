/**
 * The session header's Claude-account chip: shown on a Claude session once it
 * runs on anything but the built-in account. Gated on the provider as well as
 * the field, so a session that moved off Claude never keeps an account chip.
 */

import { type Component, Show } from "solid-js";

import type { SessionInfo } from "../protocol/types";

export const ClaudeAccountChip: Component<{ session: SessionInfo }> = (props) => (
  <Show
    when={
      (props.session.providerId ?? "claude") === "claude" &&
      props.session.effectiveClaudeAccount &&
      props.session.effectiveClaudeAccount !== "default"
    }
  >
    <span
      class={`rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider ${
        props.session.effectiveClaudeAccount?.endsWith(" (missing)")
          ? "border-danger/50 bg-danger/10 text-danger"
          : "border-border bg-bg text-fg-muted"
      }`}
      title={props.session.claudeAccount ? "Claude account chosen for this session" : "Claude account (the daemon default)"}
    >
      ⚿ {props.session.effectiveClaudeAccount}
    </span>
  </Show>
);
