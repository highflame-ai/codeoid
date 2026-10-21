/**
 * The session header's account chip: the account a session runs on for its
 * current backend (accounts.ts), shown once that is anything but the built-in
 * one, and red when it is gone (`<name> (missing)`). Gated on the backend as
 * well as the field, so a session that moved to a backend without accounts
 * never keeps a stale chip.
 */

import { type Component, Show } from "solid-js";

import { backendHasAccounts } from "../protocol/types";
import type { SessionInfo } from "../protocol/types";
import { isMissingAccount } from "../state/accounts";
import { providerLabel } from "../state/providers";

export const AccountChip: Component<{ session: SessionInfo }> = (props) => {
  const backend = () => props.session.providerId ?? "claude";
  const effective = () => props.session.effectiveAccount;
  return (
    <Show when={backendHasAccounts(backend()) && effective() && effective() !== "default"}>
      <span
        class={`rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider ${
          isMissingAccount(effective()) ? "border-danger/50 bg-danger/10 text-danger" : "border-border bg-bg text-fg-muted"
        }`}
        title={
          props.session.account
            ? `${providerLabel(backend())} account chosen for this session`
            : `${providerLabel(backend())} account (the daemon default)`
        }
      >
        ⚿ {effective()}
      </span>
    </Show>
  );
};
