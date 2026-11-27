/**
 * The session header's sandbox chip (#448): whether the session's commands
 * run in an OS sandbox, in the shared words (sandboxBadge). Amber when they
 * don't (or only partly); the tooltip says why and what isn't confined.
 * Absent on a daemon without sandboxing. Change it with `/sandbox`.
 */

import { sandboxBadge } from "@highflame/codeoid-core";
import { type Component, Show } from "solid-js";

import type { SessionInfo } from "../protocol/types";

const TONE: Record<string, string> = {
  on: "border-success/40 bg-success/5 text-success",
  warn: "border-warn/50 bg-warn/10 text-warn",
  off: "border-danger/50 bg-danger/10 text-danger",
  neutral: "border-border bg-bg text-fg-muted",
};

export const SandboxChip: Component<{ session: SessionInfo }> = (props) => {
  const badge = () => sandboxBadge(props.session.sandbox);
  return (
    <Show when={badge()}>
      {(b) => (
        <span
          class={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${TONE[b().tone] ?? TONE.neutral}`}
          title={`${b().title}\nChange it with /sandbox <auto|off|bwrap|seatbelt|docker> [on|off|allow:host,…] [docker|nodocker]; write another directory with /sandbox add <dir>`}
          data-sandbox={props.session.sandbox?.state}
        >
          🛡 {b().text}
        </span>
      )}
    </Show>
  );
};
