/**
 * A session's home workstream (docs/workstreams-design.md), as a chip: its
 * name in its color, amber when homed past another workstream's claim
 * (override), red when its workstream was removed (orphaned), and "no
 * workstream" when nothing matched. Absent on a daemon without workstreams.
 */

import { type Component, Show } from "solid-js";

import type { SessionInfo } from "../protocol/types";

/** A config color as a CSS color, or none: a name or a #hex only — never arbitrary CSS. */
export function chipColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return /^#[0-9a-fA-F]{3,8}$/.test(color) || /^[a-zA-Z]{3,20}$/.test(color) ? color : undefined;
}

export const WorkstreamChip: Component<{ session: SessionInfo }> = (props) => {
  const ws = () => props.session.workstream;
  const tone = () => {
    const w = ws();
    if (w?.orphaned) return "border-danger/50 bg-danger/10 text-danger";
    if (w?.source === "override") return "border-warn/50 bg-warn/10 text-warn";
    if (!w?.id) return "border-border bg-bg text-fg-faint";
    return "border-border bg-bg text-fg-muted";
  };
  const title = () => {
    const w = ws();
    if (!w) return "";
    if (w.orphaned) return `Workstream "${w.id}" is no longer configured: move this session to another`;
    if (!w.id) return "No workstream: no rule matched this folder and no default is set";
    const how =
      w.source === "matched" ? `matched by ${w.matchedBy ?? "a rule"}`
      : w.source === "default" ? "the default workstream"
      : w.source === "explicit" ? "chosen at create"
      : w.source === "override" ? "chosen past the folder's own workstream"
      : w.source === "migrated" ? "from its folder, when workstreams were set up"
      : w.source;
    return `Workstream ${w.name ?? w.id} — ${how}`;
  };
  return (
    <Show when={ws()}>
      <span class={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider ${tone()}`} title={title()} data-testid="workstream-chip">
        <Show when={chipColor(ws()?.color)}>
          {(c) => <span class="inline-block h-1.5 w-1.5 rounded-full" style={{ "background-color": c() }} aria-hidden="true" />}
        </Show>
        {ws()?.id ? (ws()?.name ?? ws()?.id) : "no workstream"}
      </span>
    </Show>
  );
};
