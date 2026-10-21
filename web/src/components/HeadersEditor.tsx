/**
 * Name/value rows for extra request headers — an account's (accounts.ts) or
 * an endpoint's own. Values are secret: password fields, never shown back.
 */

import { type Component, Index, Show } from "solid-js";

const label = "text-[11px] font-medium uppercase tracking-wider text-fg-faint";
const input =
  "w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-fg focus:border-accent focus:outline-none";
const button =
  "rounded border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition hover:border-accent/40 hover:text-fg disabled:opacity-50";

export const HeadersEditor: Component<{
  rows: Array<{ name: string; value: string }>;
  onChange: (rows: Array<{ name: string; value: string }>) => void;
  hint?: string;
}> = (props) => (
  <div class="space-y-1">
    <span class={label}>Extra headers</span>
    {/* <Index>: each keystroke replaces the row object; <For> would rebuild the row and drop focus. */}
    <Index each={props.rows}>
      {(row, i) => (
        <div class="flex gap-2">
          <input
            class={input}
            placeholder="x-workspace"
            value={row().name}
            onInput={(e) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, name: e.currentTarget.value } : r)))}
          />
          <input
            class={input}
            type="password"
            placeholder="value"
            value={row().value}
            onInput={(e) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, value: e.currentTarget.value } : r)))}
          />
          <button type="button" class={button} onClick={() => props.onChange(props.rows.filter((_, j) => j !== i))} aria-label="Remove header">
            ✕
          </button>
        </div>
      )}
    </Index>
    <button type="button" class={button} onClick={() => props.onChange([...props.rows, { name: "", value: "" }])}>
      + Header
    </button>
    <Show when={props.hint}>
      <p class="text-[11px] text-fg-faint">{props.hint}</p>
    </Show>
  </div>
);
