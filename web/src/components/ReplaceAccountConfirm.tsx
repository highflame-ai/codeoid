/**
 * Shown when a new account's name is already taken: adding under it replaces
 * the stored credential (renewing an expired sign-in, say), so it takes an
 * explicit tick rather than happening as a side effect of the name.
 */

import { type Component, Show } from "solid-js";

import { accountNameTaken } from "../state/claude-accounts";

export const ReplaceAccountConfirm: Component<{ name: string; checked: boolean; onChange: (v: boolean) => void }> = (props) => (
  <Show when={props.name && accountNameTaken(props.name)}>
    <label class="flex items-start gap-2 text-[12px] text-warn">
      <input type="checkbox" class="mt-0.5" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>
        Replace the existing account <span class="font-mono">{props.name}</span> — sessions on it use the new credential from
        their next turn.
      </span>
    </label>
  </Show>
);
