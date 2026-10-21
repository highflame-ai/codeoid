/**
 * Shown when a new account's name is already taken on its backend: adding
 * under it replaces the stored credential (renewing an expired sign-in, say),
 * so it takes an explicit tick rather than happening as a side effect of the
 * name. The tick is sent as `replace: true`; the daemon refuses a taken name
 * without it.
 */

import { type Component, Show } from "solid-js";

import { accountNameTaken } from "../state/accounts";

export const ReplaceAccountConfirm: Component<{ backend: string; name: string; checked: boolean; onChange: (v: boolean) => void }> = (
  props,
) => (
  <Show when={props.name && accountNameTaken(props.backend, props.name)}>
    <label class="flex items-start gap-2 text-[12px] text-warn">
      <input type="checkbox" class="mt-0.5" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>
        Replace the existing account <span class="font-mono">{props.name}</span> — sessions on it use the new credential from
        their next turn.
      </span>
    </label>
  </Show>
);
